#!/usr/bin/env node
/**
 * HTTP-сервис: два входа, GET /view (видимый HTML) и POST /act (одно действие),
 * плюс GET / (страница статуса для человека, без токена). Интерфейс и коды ответов
 * в docs/http-api.md. Здесь только HTTP, токены клиентов, очередь, лимиты,
 * проверка выхода и журнал; браузер за интерфейсом Driver, который подставляется.
 *
 *   node server.js [--host 127.0.0.1] [--port 8787] [--data data]
 *                  [--sites profiles/sites.json] [--clients profiles/clients.json]
 *                  [--egress profiles/egress.json] [--cdp http://127.0.0.1:9222]
 *                  [--tz Asia/Almaty]
 *
 * Окружение: MEATSUIT_HOST, MEATSUIT_PORT, MEATSUIT_CDP, MEATSUIT_TZ, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
 * Нужен driver.js (open / view / act / resume / close).
 */
const http = require('node:http');
const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MIN = 60000;
const ACTIONS = new Set(['goto', 'click', 'fill', 'type', 'key', 'scroll', 'back', 'pause']);
const DRIVER_STATUSES = new Set([400, 403, 404, 409, 410, 422, 502, 503]); // что Driver вправе бросать (502 сайт не открылся, 503 браузер пропал), остальное — 500
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const GUARD_RU = { captcha: 'капча', blocked: 'сайт заподозрил бота и блокирует', login: 'слетел вход' };

class HttpError extends Error {
  constructor(status, code, extra = {}, headers = {}) { super(code); Object.assign(this, { status, code, extra, headers }); }
}
const bad = (message) => new HttpError(400, 'bad_request', { message });
const isDriverError = (e) => !!e && DRIVER_STATUSES.has(e.status) && typeof e.code === 'string' && /^[a-z_]+$/.test(e.code);
const codeOf = (e) => (e instanceof HttpError || isDriverError(e) ? e.code : 'internal');
const iso = (ms) => new Date(ms).toISOString();

/** Название площадки → имя хоста (принимает и адрес); непонятное — null. */
function hostOf(value) {
  let s = String(value).trim().toLowerCase();
  if (s.includes('/') || s.includes(':')) { try { s = new URL(s.includes('://') ? s : `https://${s}`).hostname; } catch { return null; } }
  return HOST.test(s) ? s : null;
}

/** Хост входит в список площадок (сам или поддомен); '*' — любой. */
const covers = (list, host) => list.some((s) => s === '*' || host === s || host.endsWith(`.${s}`));

/** Из текста убирается всё, что клиент вводил: в журнал уходят детали ошибок, но не введённое. */
const scrub = (text, secrets) => secrets.reduce((s, x) => (x ? s.split(x).join('***') : s), String(text));

/** Значение заголовка: непечатное и не-ASCII кодируется, чтобы заголовок нельзя было сломать. */
const safeHeader = (v) => String(v).replace(/[^\x21-\x7e]/g, (c) => encodeURIComponent(c));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------------------------------------------------------------- клиенты

const failClients = (what) => { throw new Error(`clients: ${what}`); };

/** clients.json → [{ name, token, sites }]; заглушки из примера и повторы отвергаются. */
function normalizeClients(raw) {
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.clients) ? raw.clients : null;
  if (!list) failClients('нужен список [{ name, token, sites }]');
  if (!list.length) failClients('нужен хотя бы один клиент');
  const names = new Set(), tokens = new Set();
  return list.map((c) => {
    if (!c || typeof c.name !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(c.name)) failClients('у клиента нужен name (латиница, цифры, . _ -)');
    if (typeof c.token !== 'string' || c.token.length < 16 || /\s/.test(c.token)) failClients(`«${c.name}»: token — строка от 16 знаков без пробелов`);
    if (/^CHANGE-?ME/i.test(c.token)) failClients(`«${c.name}»: token — заглушка из примера, задайте настоящий (openssl rand -hex 24)`);
    if (!Array.isArray(c.sites) || !c.sites.length) failClients(`«${c.name}»: sites — непустой список площадок или ["*"]`);
    const sites = c.sites.map((s) => {
      const h = typeof s === 'string' ? s.trim().toLowerCase() : '';
      if (h !== '*' && !HOST.test(h)) failClients(`«${c.name}»: в sites «${s}» — не имя площадки (нужно «hh.kz» или «*», без адреса)`);
      return h;
    });
    if (names.has(c.name)) failClients(`name «${c.name}» повторяется`);
    if (tokens.has(c.token)) failClients(`у клиентов одинаковый token («${c.name}»)`);
    names.add(c.name);
    tokens.add(c.token);
    return { name: c.name, token: c.token, sites };
  });
}

// ---------------------------------------------------------------- журнал

/**
 * Журнал: строки JSON в файл (дописывается) и последние keep в памяти для страницы
 * статуса. После перезапуска хвост читается из файла. Сбой записи сервис не роняет.
 */
function createJournal({ file, fs = nodeFs, now = Date.now, keep = 200, echo } = {}) {
  let ring = [];
  if (file) {
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const { size } = fs.fstatSync(fd);
        const len = Math.min(size, 65536);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        const lines = buf.toString('utf8').split('\n');
        if (size > len) lines.shift(); // первая строка могла обрезаться
        for (const l of lines) { try { ring.push(JSON.parse(l)); } catch { /* пустая или обрезанная строка */ } }
        ring = ring.slice(-keep);
      } finally { fs.closeSync(fd); }
    } catch { /* журнала ещё нет */ }
  }
  return {
    write(entry) {
      const line = { ts: iso(now()), ...entry };
      ring.push(line);
      if (ring.length > keep) ring.shift();
      if (file) {
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
        } catch { /* журнал не должен ронять сервис */ }
      }
      if (echo) { try { echo(line); } catch { /* вывод не должен ронять сервис */ } }
    },
    tail: (n = 30) => ring.slice(-n),
  };
}

// ---------------------------------------------------------------- сервер

function createServer({
  driver, queue, limits, egress, clients, journal, notify = async () => ({ sent: false }), now = Date.now,
  tz = 'Asia/Almaty', needsHumanIdleMs = 30 * MIN, maxBodyBytes = 1 << 20, defaultWaitSec = 60, maxWaitSec = 300,
}) {
  const roster = normalizeClients(clients).map((client) => ({ client, hash: crypto.createHash('sha256').update(client.token).digest() }));

  /** Клиент по Bearer-токену; сравнение по хэшам за постоянное время, без раннего выхода. */
  function authenticate(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    if (!m) return null;
    const hash = crypto.createHash('sha256').update(m[1]).digest();
    let found = null;
    for (const r of roster) if (crypto.timingSafeEqual(hash, r.hash)) found = r.client;
    return found;
  }

  function log(event, result, { client, task, label, site, ...extra } = {}) {
    journal.write({
      ts: iso(now()), client: client ?? (task && task.owner), task: label ?? (task && task.info.task), taskId: task && task.id,
      site: site ?? (task && task.info.site), event, result, ...extra,
    });
  }

  const tell = (text) => { try { Promise.resolve(notify(text)).catch(() => {}); } catch { /* уведомление не должно ломать запрос */ } };

  // ---- ввод и вывод

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0, over = false;
      req.on('data', (c) => {
        if (over) return;
        size += c.length;
        if (size > maxBodyBytes) { over = true; reject(new HttpError(400, 'bad_request', { message: `тело больше ${maxBodyBytes} байт` }, { connection: 'close' })); } else chunks.push(c);
      });
      req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
      req.on('error', reject);
    });
  }

  function parseJson(text) {
    let value;
    try { value = JSON.parse(text); } catch { throw bad('тело должно быть JSON'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('тело должно быть JSON-объектом');
    return value;
  }

  function reply(res, status, type, text, headers = {}) {
    const buf = Buffer.from(text);
    res.writeHead(status, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
    res.end(buf);
  }
  const sendJson = (res, status, body, headers) => reply(res, status, 'application/json; charset=utf-8', JSON.stringify(body), headers);

  /** Любая ошибка запроса → ответ. Неизвестное — 500 без деталей, детали (без введённого) в журнал. */
  function fail(res, err, ctx) {
    let status, body, headers = {};
    if (err instanceof HttpError) {
      ({ status, headers } = err);
      body = { error: err.code, ...err.extra };
    } else if (isDriverError(err)) {
      status = err.status;
      body = { error: err.code };
      if (typeof err.message === 'string' && err.message) body.message = err.message.slice(0, 200);
      if (err.candidates) body.candidates = err.candidates;
      if (err.guard) body.guard = err.guard;
    } else {
      status = 500;
      body = { error: 'internal' };
      log('error', 'internal', { client: ctx.client && ctx.client.name, task: ctx.task, detail: scrub((err && (err.stack || err.message)) || err, ctx.secrets).slice(0, 800) });
    }
    if (ctx.event && status !== 500) log(ctx.event, body.error, { client: ctx.client && ctx.client.name, task: ctx.task });
    if (res.headersSent) { res.end(); return; }
    sendJson(res, status, body, headers);
  }

  // ---- окна и задачи

  const noTask = (id, owner) => new HttpError(404, 'no_task', { message: 'такой задачи нет, она закончилась или истекла; начните новую через begin', ...(queue.why(id, owner) ? { reason: queue.why(id, owner) } : {}) });

  /** Закрыть окно задачи один раз и записать в журнал; слот очереди освобождает вызывающий. */
  async function closeWindow(task, why) {
    if (task.data.closed) return;
    task.data.closed = why;
    try { await driver.close(task.data.driverId); } catch (err) { log('error', 'close_failed', { task, detail: scrub(err && err.message, []).slice(0, 300) }); }
    log('end', why === 'end' ? 'ok' : why, { task });
  }

  /** Одно действие задачи за раз, по порядку прихода. */
  function exclusive(task, fn) {
    const run = (task.data.chain || Promise.resolve()).then(fn);
    task.data.chain = run.catch(() => {});
    return run;
  }

  /** Запрос к своей задаче: X-Task, владелец, очередь действий; пока он идёт, простоя нет. */
  async function withTask(ctx, req, fn) {
    const id = req.headers['x-task'];
    if (!id) throw bad('нужен заголовок X-Task (номер задачи из begin)');
    const owner = ctx.client.name;
    const task = queue.get(id, owner);
    if (!task) throw noTask(id, owner);
    ctx.task = task;
    const done = queue.hold(id);
    try {
      return await exclusive(task, async () => {
        if (queue.get(id, owner) !== task) throw noTask(id, owner); // пока ждали своей очереди, задача закрылась
        return fn(task);
      });
    } finally { done(); }
  }

  /** Окно закрыто из-за потери выхода, пока шёл запрос: это 503, а не «внутренняя ошибка». */
  function afterDriverError(task, err) {
    if (task.data.killed) return new HttpError(503, task.data.killed);
    if (err && err.status === 409 && err.code === 'needs_human') return guardHit(task, String(err.guard || 'unknown'));
    return err;
  }

  /** Проверка на площадке: она замирает (limits.challenge), пока человек не разберётся и не пройдёт пауза; в журнал. */
  function freezeSite(task) {
    try {
      const r = limits.challenge(task.info.site, now());
      if (r.ok) log('challenge', 'pause', { task, until: iso(r.until) });
    } catch (err) { log('error', 'challenge_failed', { task, detail: scrub(err && err.message, []).slice(0, 300) }); } // пауза не должна ломать ответ needs_human
  }

  /** Капча, вход или блок: окно остаётся, до resume ничего не нажимается, площадка замирает, мне сообщение (один раз на причину). */
  function guardHit(task, reason) {
    const changed = task.data.guard !== reason;
    task.data.guard = reason;
    queue.touch(task.id, { idleMs: needsHumanIdleMs }); // человеку нужно время дойти до зеркала
    if (changed) {
      log('guard', reason, { task });
      freezeSite(task);
      tell(`meatsuit: задача «${task.info.task}» на ${task.info.site}: ${GUARD_RU[reason] || reason}. Окно открыто, реши в зеркале и вызови resume.`);
    }
    return new HttpError(409, 'needs_human', { guard: reason });
  }

  // ---- begin

  async function begin(req, res, ctx, body) {
    const { client } = ctx;
    if (typeof body.site !== 'string' || !body.site.trim() || body.site.length > 253) throw bad('begin: нужен site, например «hh.kz»');
    if (body.task !== undefined && (typeof body.task !== 'string' || body.task.length > 100)) throw bad('begin: task — строка до 100 знаков');
    const label = body.task || '-';
    const cost = body.cost === undefined ? 1 : body.cost;
    if (!Number.isInteger(cost) || cost < 1 || cost > 1e6) throw bad('begin: cost — целое число от 1');
    const waitSec = body.wait === undefined ? defaultWaitSec : body.wait;
    if (typeof waitSec !== 'number' || !Number.isFinite(waitSec) || waitSec < 0) throw bad('begin: wait — секунды, число от 0');
    if (body.ticket !== undefined && (typeof body.ticket !== 'string' || body.ticket.length > 64)) throw bad('begin: ticket — строка из ответа 202');
    if (body.allow !== undefined && (!Array.isArray(body.allow) || body.allow.length > 20 || body.allow.some((a) => typeof a !== 'string'))) throw bad('begin: allow — список площадок');
    const host = hostOf(body.site);
    if (!host) throw bad('begin: site не похож на имя площадки');
    const allow = [...new Set((body.allow || []).map((a) => hostOf(a) || (() => { throw bad(`begin: allow «${String(a).slice(0, 40)}» не похож на имя площадки`); })()))];

    // Отказы, которые не зависят от очереди, приходят сразу, а не после ожидания слота.
    const key = limits.find(host);
    const refuse = (reason) => { log('begin', 'forbidden', { client: client.name, label, site: key || host, reason }); return new HttpError(403, 'forbidden', { reason }); };
    if (!covers(client.sites, host)) throw refuse('site_not_allowed');
    if (!key) throw refuse('site_unknown');
    if (!allow.every((a) => covers(client.sites, a))) throw refuse('allow_not_allowed');

    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); }); // ждущий оборвал соединение: слот ему не отдаётся
    const got = await queue.acquire({ ticket: body.ticket, owner: client.name, waitMs: Math.min(waitSec, maxWaitSec) * 1000, info: { task: label, site: key }, signal: ac.signal });
    if (!got.granted) {
      if (!body.ticket) log('begin', 'queued', { client: client.name, label, site: key, position: got.position });
      return sendJson(res, 202, { ticket: got.ticket, position: got.position });
    }

    const task = got.task;
    ctx.task = task;
    const done = queue.hold(task.id); // открытие окна не должно считаться простоем
    let taken = null, opened = false;
    try {
      let seen;
      try { seen = await egress.check(); } catch (err) { seen = { ok: false, error: 'egress_unknown', detail: err && err.message }; }
      if (!seen.ok) throw new HttpError(503, seen.error, seen.country ? { country: seen.country } : {});
      taken = limits.take(key, cost);
      if (!taken.ok) {
        const retry = taken.retry_at;
        throw new HttpError(429, 'limit', { reason: taken.reason, retry_at: retry === null ? null : iso(retry) }, retry === null ? {} : { 'retry-after': String(Math.max(0, Math.ceil((retry - now()) / 1000))) });
      }
      const win = await driver.open({ site: key, allow });
      if (!win || win.id === undefined || win.id === null) throw new Error('driver.open не вернул id окна');
      Object.assign(task.data, { driverId: win.id, allow });
      opened = true;
      log('begin', 'ok', { task, cost });
      sendJson(res, 200, { task: task.id });
    } catch (err) {
      if (taken && taken.ok && !opened) limits.refund(taken); // окно не открылось — единицы лимита не потрачены
      queue.release(task.id, 'begin_failed');
      if (err instanceof HttpError && err.code === 'limit') log('limit', err.extra.reason, { client: client.name, label, site: key, cost });
      else log('begin', codeOf(err), { client: client.name, label, site: key });
      throw err;
    } finally { done(); }
  }

  // ---- действия

  function validateAction(a) {
    const needText = () => { if (typeof a.text !== 'string') throw bad(`${a.do}: нужен text (строка)`); };
    const needTarget = () => {
      const t = a.target;
      const ok = (Number.isInteger(t) && t >= 0) || (typeof t === 'string' && t.length > 0 && t.length <= 500)
        || (t && typeof t === 'object' && !Array.isArray(t) && typeof t.css === 'string' && t.css.length > 0);
      if (!ok) throw bad(`${a.do}: нужен target (номер из /view, текст или {"css":"…"})`);
    };
    const num = (v) => typeof v === 'number' && Number.isFinite(v);
    switch (a.do) {
      case 'goto':
        if (typeof a.url !== 'string') throw bad('goto: нужен url');
        try { new URL(a.url); } catch { throw bad('goto: нужен полный адрес http(s)://…'); }
        break;
      case 'click': needTarget(); break;
      case 'fill': needTarget(); needText(); break;
      case 'type': needText(); break;
      case 'key': if (typeof a.key !== 'string' || !a.key) throw bad('key: нужен key, например «Enter»'); break;
      case 'scroll':
        if (a.px === undefined && a.to === undefined) throw bad('scroll: нужен px или to');
        if ((a.px !== undefined && !num(a.px)) || (a.to !== undefined && typeof a.to !== 'string')) throw bad('scroll: px — число, to — строка');
        break;
      case 'pause':
        for (const k of ['from', 'to']) if (a[k] !== undefined && (!num(a[k]) || a[k] < 0)) throw bad(`pause: ${k} — миллисекунды, число от 0`);
        break;
      default: break;
    }
  }

  /** Что про действие пишется в журнал: что и куда, но не введённый текст и не запрос адреса. */
  function describe(a) {
    const d = { do: a.do };
    if (a.do === 'goto') { try { const u = new URL(a.url); d.host = u.hostname; d.path = u.pathname; } catch { /* уже отвергнут */ } }
    if (a.do === 'click' || a.do === 'fill') d.target = a.target && typeof a.target === 'object' ? 'css' : typeof a.target === 'string' ? a.target.slice(0, 60) : a.target;
    if (a.do === 'key' && typeof a.key === 'string' && a.key.length > 1) d.key = a.key; // «Enter», но не напечатанный знак
    return d;
  }

  function checkGoto(task, raw) {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) throw new HttpError(403, 'forbidden', { reason: 'scheme', message: 'goto: только http и https' });
    if (!covers([task.info.site, ...task.data.allow], u.hostname)) throw new HttpError(403, 'forbidden', { reason: 'outside_task', message: 'goto: адрес вне сайтов задачи' });
  }

  async function perform(ctx, task, action) {
    const t0 = now();
    let code = 'ok';
    try {
      if (task.data.guard) throw new HttpError(409, 'needs_human', { guard: task.data.guard });
      if (action.do === 'goto') checkGoto(task, action.url);
      let r;
      try { r = await driver.act(task.data.driverId, action); } catch (err) { throw afterDriverError(task, err); }
      if (r && r.guard) throw guardHit(task, String(r.guard));
      return { ok: true, url: r && r.url, settled: r && r.settled, guard: null };
    } catch (err) {
      code = codeOf(err);
      throw err;
    } finally {
      log('act', code, { task, ms: now() - t0, ...describe(action) });
    }
  }

  async function resume(ctx, task) {
    let code = 'ok';
    try {
      let r;
      try { r = await driver.resume(task.data.driverId); } catch (err) { throw afterDriverError(task, err); }
      if (r && r.guard) throw guardHit(task, String(r.guard));
      task.data.guard = null;
      queue.touch(task.id, { idleMs: null }); // человек справился, срок простоя снова обычный
      return { ok: true, guard: null };
    } catch (err) {
      code = codeOf(err);
      throw err;
    } finally {
      log('act', code, { task, do: 'resume' });
    }
  }

  async function actRoute(req, res, ctx) {
    const body = parseJson(await readBody(req));
    if (typeof body.text === 'string') ctx.secrets.push(body.text);
    if (typeof body.do !== 'string') throw bad('нужно поле do');
    if (body.do === 'begin') return begin(req, res, ctx, body);
    if (body.do !== 'end' && body.do !== 'resume' && !ACTIONS.has(body.do)) throw bad(`неизвестное do «${body.do.slice(0, 40)}»`);
    validateAction(body);
    const result = await withTask(ctx, req, async (task) => {
      if (body.do === 'end') {
        await closeWindow(task, 'end');
        queue.release(task.id, 'end');
        return { ok: true };
      }
      return body.do === 'resume' ? resume(ctx, task) : perform(ctx, task, body);
    });
    sendJson(res, 200, result);
  }

  // ---- view

  async function viewRoute(req, res, ctx, params) {
    ctx.event = 'view';
    const scope = params.get('scope') ?? 'document';
    if (scope !== 'viewport' && scope !== 'document') throw bad('scope: viewport или document');
    const v = await withTask(ctx, req, async (task) => {
      try { return await driver.view(task.data.driverId, { scope }); } catch (err) { throw afterDriverError(task, err); }
    });
    const eg = egress.last();
    let html = String(v.html ?? '');
    if (eg && eg.ok) html = html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}<meta name="egress" content="${esc(eg.country)}${eg.asn ? ` AS${eg.asn}` : ''}">`);
    const headers = { 'content-security-policy': 'sandbox; default-src \'none\'' }; // чужая страница: даже открытая в браузере ничего не выполнит
    if (v.url) headers['x-url'] = safeHeader(v.url);
    if (v.guard) headers['x-guard'] = safeHeader(v.guard);
    if (eg && eg.ok) headers['x-egress'] = safeHeader(`${eg.country}${eg.asn ? ` AS${eg.asn}` : ''}`);
    reply(res, 200, 'text/html; charset=utf-8', html, headers);
  }

  // ---- выход в сеть

  async function killActive(code) {
    const task = queue.active();
    if (!task || task.data.driverId === undefined || task.data.closed) return; // задача ещё открывается: begin сам получит отказ
    task.data.killed = code;
    await closeWindow(task, code);
    queue.release(task.id, 'egress');
  }

  if (egress.subscribe) {
    egress.subscribe((r, prev) => {
      const was = prev ? (prev.ok ? 'ok' : prev.error) : null, is = r.ok ? 'ok' : r.error;
      if (was !== is && (!r.ok || was !== null)) {
        log('egress', is, { country: r.country, asn: r.asn, ...(r.detail ? { detail: String(r.detail).slice(0, 300) } : {}) });
        const who = [r.country, r.asn && `AS${r.asn}`].filter(Boolean).join(' ');
        tell(r.ok ? `meatsuit: выход в сеть восстановился (${who}), задачи принимаются.`
          : r.error === 'egress_wrong' ? `meatsuit: выход в сеть не из Алматы (${who}). Задачи не берутся, идущая закрыта.`
            : 'meatsuit: не удалось определить выход в сеть. Задачи не берутся, идущая закрыта.');
      }
      if (!r.ok) killActive(r.error).catch((err) => log('error', 'egress_close_failed', { detail: String(err && err.message).slice(0, 300) }));
    });
  }

  if (queue.onExpire) queue.onExpire(async (task) => { if (task.data.driverId !== undefined) await closeWindow(task, 'idle'); });

  // ---- страница статуса

  const fmtTime = (ms) => new Date(ms).toLocaleString('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fmtDur = (ms) => (ms < MIN ? `${Math.round(ms / 1000)} с` : `${Math.round(ms / MIN)} мин`);

  function egressLine(eg) {
    if (!eg) return 'ещё не проверялся';
    const who = [eg.country, eg.asn && `AS${eg.asn}`, eg.org].filter(Boolean).join(', ');
    if (eg.ok) return `${who}: выход как ожидалось (проверено ${fmtTime(eg.at)})`;
    if (eg.error === 'egress_wrong') return `НЕ ТО (egress_wrong): ${who}. Браузер остановлен (проверено ${fmtTime(eg.at)})`;
    return `не определён (egress_unknown). Браузер остановлен (проверено ${fmtTime(eg.at)})`;
  }

  /** Только то, что можно показать без токена: кто, где, когда и чем кончилось; ни страниц, ни введённого, ни адресов. */
  function statusPage() {
    const q = queue.snapshot(), lim = limits.snapshot();
    const queueRows = [
      ...(q.active ? [`<tr><td>идёт</td><td>${esc(q.active.owner)}</td><td>${esc(q.active.info.task)}</td><td>${esc(q.active.info.site)}</td><td>${q.active.busy ? 'действие выполняется' : `без действий ${esc(fmtDur(q.active.idleMs))}`}</td></tr>`] : []),
      ...q.waiting.map((w) => `<tr><td>место ${w.position}</td><td>${esc(w.owner)}</td><td>${esc(w.info.task)}</td><td>${esc(w.info.site)}</td><td>ждёт ${esc(fmtDur(now() - w.since))}</td></tr>`),
    ];
    const limRows = Object.entries(lim).map(([site, l]) => {
      const st = limits.status(site, now()); // лимит сегодня с ростом и разбросом, выходной, пауза
      const day = st.effective === l.perDay ? `${l.usedDay} / ${l.perDay}` : `${l.usedDay} / ${st.effective} <span class="dim">(из ${l.perDay})</span>`;
      const state = st.frozenUntil ? `пауза до ${esc(fmtTime(st.frozenUntil))}` : st.rest ? 'выходной день' : l.open ? 'открыта' : 'закрыта';
      return `<tr><td>${esc(site)}</td><td>${day}</td><td>${l.perHour === null ? '—' : `${l.usedHour} / ${l.perHour}`}</td><td>${esc(l.hours || 'круглые сутки')}</td><td>${state}</td></tr>`;
    });
    const logRows = journal.tail(30).reverse().map((e) => `<tr><td>${esc(fmtTime(Date.parse(e.ts)))}</td><td>${esc(e.client || '')}</td><td>${esc(e.task || '')}</td><td>${esc(e.site || '')}</td><td>${esc(e.event)}${e.do ? `:${esc(e.do)}` : ''}</td><td>${esc(e.result ?? '')}</td></tr>`);
    const table = (head, rows, empty) => (rows.length ? `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>` : `<p class="dim">${empty}</p>`);
    return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="15">
<title>meatsuit</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#1a1a1a;--dim:#6b6b6b;--line:#d8d8d8}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#e8e8e8;--dim:#9a9a9a;--line:#333}}
body{margin:0 auto;max-width:60rem;padding:1rem 16px;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}
h1{font-size:1.25rem}h2{font-size:1rem;margin:1.6rem 0 .4rem}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.25rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}
.dim{color:var(--dim)}.wrap{overflow-x:auto}
</style></head><body>
<h1>meatsuit</h1>
<h2>Выход в сеть</h2><p>${esc(egressLine(egress.last()))}</p>
<h2>Очередь</h2><div class="wrap">${table(['', 'клиент', 'задача', 'площадка', ''], queueRows, 'пусто')}</div>
<h2>Лимиты (часы по Алматы)</h2><div class="wrap">${table(['площадка', 'за сутки', 'за час', 'часы', ''], limRows, 'нет площадок')}</div>
<h2>Журнал</h2><div class="wrap">${table(['время', 'клиент', 'задача', 'площадка', 'событие', 'результат'], logRows, 'пока пусто')}</div>
</body></html>`;
  }

  // ---- маршруты

  async function handle(req, res) {
    const ctx = { client: null, task: null, event: null, secrets: [] };
    try {
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch { throw bad('адрес запроса не разобрать'); }
      const route = url.pathname;
      if (route !== '/' && route !== '/view' && route !== '/act') throw new HttpError(404, 'not_found', { message: 'есть только /, /view и /act' });
      const method = route === '/act' ? 'POST' : 'GET';
      if (req.method !== method) throw bad(`на ${route} только ${method}`);
      if (route === '/') {
        return reply(res, 200, 'text/html; charset=utf-8', statusPage(), { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
      }
      const client = authenticate(req);
      if (!client) {
        log('auth', 'unauthorized');
        throw new HttpError(401, 'unauthorized', {}, { 'www-authenticate': 'Bearer' });
      }
      ctx.secrets.push(client.token);
      ctx.client = client;
      if (route === '/view') await viewRoute(req, res, ctx, url.searchParams);
      else await actRoute(req, res, ctx);
    } catch (err) {
      fail(res, err, ctx);
    }
  }

  return http.createServer((req, res) => { handle(req, res).catch(() => { res.destroy(); }); });
}

// ---------------------------------------------------------------- запуск программой

function parseArgs(argv, env) {
  const opts = {
    host: env.MEATSUIT_HOST || '127.0.0.1', port: env.MEATSUIT_PORT || '8787', data: 'data', cdp: env.MEATSUIT_CDP || 'http://127.0.0.1:9222',
    sites: 'profiles/sites.json', clients: 'profiles/clients.json', egress: 'profiles/egress.json',
    tz: env.MEATSUIT_TZ || 'Asia/Almaty', // границы суток для лимитов: часовой пояс владельца, не сервера
  };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !(name in opts)) throw new Error(`неизвестный аргумент «${argv[i]}» (см. начало server.js)`);
    opts[name] = argv[++i];
  }
  opts.port = Number(opts.port);
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new Error(`порт «${opts.port}» не годится`);
  try { new Intl.DateTimeFormat('en', { timeZone: opts.tz }); } catch { throw new Error(`часовой пояс «${opts.tz}» не годится (нужно имя IANA, например Europe/Berlin)`); }
  return opts;
}

function loadJson(file, what) {
  let text;
  try { text = nodeFs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`нет файла ${file}: ${what}`);
    throw err;
  }
  try { return JSON.parse(text); } catch (err) { throw new Error(`${file}: не JSON (${err.message})`); }
}

/** Настоящий Driver из driver.js: готовый объект или фабрика (createDriver / экспорт-функция). */
async function loadDriver(opts) {
  let mod;
  try { mod = require('./driver.js'); } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND' && /['"]\.\/driver\.js['"]/.test(err.message)) throw new Error('нет driver.js: настоящий Driver (Patchright через CDP) ещё не написан, без него сервис не поднимается');
    throw err;
  }
  const make = typeof mod === 'function' ? mod : mod.createDriver;
  const driver = make ? await make({ cdp: opts.cdp, data: opts.data }) : mod;
  for (const m of ['open', 'view', 'act', 'resume', 'close']) if (typeof driver[m] !== 'function') throw new Error(`driver.js: нет метода ${m}()`);
  return driver;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2), process.env);
  const { createQueue } = require('./queue.js');
  const { createLimits } = require('./limits.js');
  const { createEgress } = require('./egress.js');
  const { fromEnv } = require('./notify.js');

  const clients = normalizeClients(loadJson(opts.clients, 'токены клиентов; образец profiles/clients.example.json, настоящий файл держать вне git'));
  const sites = loadJson(opts.sites, 'лимиты площадок, образец profiles/sites.json');
  const expected = loadJson(opts.egress, 'ожидаемый выход, например {"country":"KZ","asn":[64500]}');

  const journal = createJournal({
    file: path.join(opts.data, 'journal.jsonl'),
    echo: (e) => console.log(`${e.ts.slice(11, 19)} ${e.client || '-'} ${e.event}${e.do ? `:${e.do}` : ''} ${e.result ?? ''}${e.site ? ` ${e.site}` : ''}`),
  });
  const notify = fromEnv(process.env, { log: (e) => journal.write(e) });
  const limits = createLimits({ sites, file: path.join(opts.data, 'limits.json'), tz: opts.tz });
  const egress = createEgress({ expected });
  const queue = createQueue();
  const driver = await loadDriver(opts);
  const server = createServer({ driver, queue, limits, egress, clients, journal, notify, tz: opts.tz });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(opts.port, opts.host, resolve); });
  console.log(`meatsuit слушает http://${opts.host}:${server.address().port} (клиентов: ${clients.length}, площадок: ${limits.sites().length})`);
  egress.start().then((r) => console.log(`выход в сеть: ${r.ok ? `${r.country} AS${r.asn}` : r.error}`));

  const stop = async () => {
    egress.stop();
    server.close();
    const task = queue.active();
    if (task && task.data.driverId !== undefined) await driver.close(task.data.driverId).catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) main().catch((err) => { console.error(`Ошибка: ${err.message}`); process.exit(1); });

module.exports = { createServer, createJournal, normalizeClients, parseArgs };
