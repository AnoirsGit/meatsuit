#!/usr/bin/env node
/**
 * npm run config: временная страница для правки файла деплоя зеркала (config.js). Это процесс на хосте,
 * не в контейнере и не в сети neko: браузер зеркала, который открывает чужие страницы, до неё не достаёт.
 *
 *   npm run config                               127.0.0.1, свободный порт
 *   npm run config -- --port 8790                свой порт
 *   npm run config -- --tailnet                  адрес tailnet этой машины (100.64.0.0/10): открыть с телефона
 *   npm run config -- --host 100.x.y.z           явный адрес: только 127.0.0.1, ::1 или из 100.64.0.0/10
 *   npm run config -- --file <путь>              или MEATSUIT_CONFIG=<путь>; по умолчанию docker/.env
 *   npm run config -- --idle-min 15              выход после простоя (минуты)
 *
 * Защита:
 * - ссылка со случайным токеном печатается один раз и живёт, пока жив процесс; токен в части после #,
 *   страница шлёт его заголовком Authorization. Cookies нет, поэтому чужая страница не может действовать
 *   «от имени» открытой вкладки;
 * - Host сверяется (подмена DNS на 127.0.0.1 не проходит), Origin чужого сайта — 403, запись без Origin — 403;
 * - пароли наружу не отдаются: GET отвечает только «задан/не задан», PUT без поля оставляет пароль, маска — 400;
 * - запись атомарная с правами 0600, чужая правка между чтением и записью — 409 (config.update);
 * - простой --idle-min минут (15) — процесс выходит сам.
 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const cfg = require('../config.js');

const PAGE = path.join(__dirname, 'config-ui.html');
const MAX_BODY = 64 * 1024;

/** 100.64.0.0/10: адреса tailnet (CGNAT). */
const isTailnet = (ip) => net.isIPv4(ip) && Number(ip.split('.')[0]) === 100 && (Number(ip.split('.')[1]) & 0xc0) === 64;
const isLoopback = (ip) => ip === '127.0.0.1' || ip === '::1';

/** Адрес tailnet этой машины: первый IPv4 из 100.64.0.0/10 на любом интерфейсе. */
function tailnetAddress(ifaces = os.networkInterfaces()) {
  for (const list of Object.values(ifaces)) for (const a of list || []) if (a.family === 'IPv4' && isTailnet(a.address)) return a.address;
  return null;
}

function parseArgs(argv, env = {}, ifaces) {
  const val = (name) => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`${name}: нужно значение`);
    return argv[i + 1];
  };
  let host = val('--host') ?? '127.0.0.1';
  if (host === 'localhost') host = '127.0.0.1';
  if (argv.includes('--tailnet')) {
    host = tailnetAddress(ifaces);
    if (!host) throw new Error('--tailnet: на этой машине нет адреса tailnet (100.64.0.0/10); включите Tailscale или задайте --host');
  }
  if (!isLoopback(host) && !isTailnet(host)) {
    throw new Error(`--host ${host}: можно только 127.0.0.1, ::1 или адрес tailnet (100.64.0.0/10); в интернет и на все адреса (0.0.0.0) страница не слушает`);
  }
  const port = Number(val('--port') ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port: число 0–65535');
  const idleMin = Number(val('--idle-min') ?? 15);
  if (!(idleMin > 0)) throw new Error('--idle-min: больше нуля');
  const file = val('--file') ? path.resolve(val('--file')) : cfg.defaultFile(env);
  return { host, port, idleMs: idleMin * 60000, file };
}

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 16 * MAX_BODY) { req.destroy(); return; } // совсем большое не дочитываем
      if (size <= MAX_BODY) chunks.push(c); // лишнее дочитывается впустую, чтобы клиент получил 413
    });
    req.on('end', () => (size > MAX_BODY ? reject(Object.assign(new Error('слишком большое тело'), { status: 413 })) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

/** Ответ GET: поля схемы для формы, значения без паролей, имена чужих ключей, замечания к текущему файлу. */
function view(file) {
  const cur = cfg.read(file);
  if (!cur.exists) return null;
  const values = {}, missing = [];
  for (const f of cfg.FIELDS) {
    const has = Object.prototype.hasOwnProperty.call(cur.values, f.key);
    if (!has) missing.push(f.key);
    values[f.key] = f.type === 'secret' ? { set: has && cur.values[f.key] !== '' } : (has ? cur.values[f.key] : '');
  }
  const fields = cfg.FIELDS.map(({ key, group, label, hint, type, options, required, default: def }) => ({ key, group, label, hint, type, options, required: !!required, default: def }));
  return {
    file, version: cur.version, mode: cur.mode.toString(8), fields, values, missing, other: cur.other,
    problems: cfg.validate(cur.values).filter((p) => !missing.includes(p.key)),
    apply: applyCommand(file),
  };
}

/** Как применить: docker/up.sh (docker compose --env-file <файл> up -d, при MEATSUIT_EGRESS=tailscale — с Tailscale). */
function applyCommand(file) {
  const upSh = path.join(__dirname, '..', 'docker', 'up.sh');
  return file === cfg.defaultFile({}) ? upSh : `MEATSUIT_CONFIG=${file} ${upSh}`;
}

/**
 * Сервер страницы. Возвращает { server, ready (Promise с адресом), url, token, close }.
 * onExit(причина) зовётся один раз, когда сервер закрылся: простой, «Закончить» на странице или close().
 */
function createConfigServer({ file, host = '127.0.0.1', port = 0, idleMs = 15 * 60000, token = crypto.randomBytes(24).toString('hex'), log = () => {}, onExit = () => {} } = {}) {
  const page = fs.readFileSync(PAGE, 'utf8');
  const tokenBuf = Buffer.from(token);
  let hosts = new Set();
  let origin = '';
  let timer = null;
  let closed = false;

  const authOk = (h) => {
    const m = /^Bearer ([0-9a-f]+)$/.exec(h || '');
    if (!m) return false;
    const got = Buffer.from(m[1]);
    return got.length === tokenBuf.length && crypto.timingSafeEqual(got, tokenBuf);
  };

  function close(reason = 'close') {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    server.close(() => onExit(reason));
    server.closeAllConnections?.();
  }
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { log(`простой ${idleMs >= 60000 ? `${idleMs / 60000} мин` : `${idleMs} мс`} — выхожу`); close('idle'); }, idleMs);
  };

  function servePage(res) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const html = page.replace(/<script>/g, `<script nonce="${nonce}">`).replace(/<style>/g, `<style nonce="${nonce}">`);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    });
    res.end(html);
  }

  async function handle(req, res) {
    if (!hosts.has(req.headers.host)) return sendJson(res, 403, { error: 'host', message: 'чужой Host: откройте ссылку, которую напечатал npm run config' });
    const url = new URL(req.url, origin);
    if (url.pathname === '/' && req.method === 'GET') return servePage(res);
    if (!url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not_found', message: 'нет такой страницы' });

    // Чужой сайт в браузере: Origin не наш. Запись без Origin тоже нельзя (браузер его всегда шлёт).
    const from = req.headers.origin;
    if (from !== undefined && from !== origin) return sendJson(res, 403, { error: 'origin', message: 'запрос с чужой страницы' });
    if (req.method !== 'GET' && from !== origin) return sendJson(res, 403, { error: 'origin', message: 'запись только со страницы конфига (нужен Origin)' });
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return sendJson(res, 403, { error: 'origin', message: 'запрос с чужой страницы' });
    if (!authOk(req.headers.authorization)) return sendJson(res, 401, { error: 'token', message: 'нет токена или он не тот: запустите npm run config заново и откройте новую ссылку' });
    touch();

    if (url.pathname === '/api/config' && req.method === 'GET') {
      const v = view(file);
      return v ? sendJson(res, 200, v) : sendJson(res, 404, { error: 'missing', message: `файла ${file} нет: сначала npm run init` });
    }
    if (url.pathname === '/api/config' && req.method === 'PUT') {
      if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'content_type', message: 'нужен application/json' });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (e) {
        return sendJson(res, e.status || 400, { error: 'bad_json', message: e.status === 413 ? 'слишком большое тело' : 'тело не JSON' });
      }
      if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'bad_json', message: 'нужен объект { version, values }' });
      try {
        const r = cfg.update(file, body.values, { version: body.version });
        log('файл сохранён');
        return sendJson(res, 200, { ok: true, version: r.version, apply: applyCommand(file) });
      } catch (e) {
        if (e instanceof cfg.ConfigError) return sendJson(res, e.status, { error: e.code, message: e.message, ...(e.errors ? { errors: e.errors } : {}) });
        log(`ошибка записи: ${e.code || e.message}`);
        return sendJson(res, 500, { error: 'write', message: `не удалось записать файл: ${e.code || 'ошибка'}` });
      }
    }
    if (url.pathname === '/api/quit' && req.method === 'POST') {
      sendJson(res, 200, { ok: true });
      log('страница попросила закончить — выхожу');
      setImmediate(() => close('quit'));
      return undefined;
    }
    return sendJson(res, url.pathname === '/api/config' || url.pathname === '/api/quit' ? 405 : 404, { error: 'method', message: 'нет такого действия' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => { log(`сбой: ${e.message}`); if (!res.headersSent) sendJson(res, 500, { error: 'internal', message: 'сбой страницы' }); });
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const a = server.address();
      const h = a.family === 'IPv6' ? `[${a.address}]` : a.address;
      origin = `http://${h}:${a.port}`;
      hosts = new Set([`${h}:${a.port}`, ...(isLoopback(a.address) ? [`localhost:${a.port}`] : [])]);
      touch();
      resolve({ address: a.address, port: a.port, url: `${origin}/#t=${token}` });
    });
  });
  return { server, ready, token, close };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  let opts;
  try { opts = parseArgs(argv, env); } catch (e) { console.error(`config: ${e.message}`); return 1; }
  if (!cfg.read(opts.file).exists) {
    console.error(`config: файла ${opts.file} нет. Сначала npm run init${opts.file === cfg.defaultFile({}) ? '' : ` -- --file ${opts.file}`}.`);
    return 1;
  }
  const s = createConfigServer({ ...opts, log: (m) => console.log(`config: ${m}`), onExit: () => { process.exitCode = 0; } });
  const { url } = await s.ready;
  console.log(`config: файл ${opts.file}`);
  console.log(`config: откройте ${url}`);
  console.log(`config: ссылка работает, пока процесс жив; простой ${opts.idleMs / 60000} мин или Ctrl+C — выход. После сохранения: docker/up.sh.`);
  const stop = () => s.close('signal');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return 0;
}

if (require.main === module) main().then((code) => { if (code) process.exitCode = code; });

module.exports = { createConfigServer, parseArgs, tailnetAddress, isTailnet, view };
