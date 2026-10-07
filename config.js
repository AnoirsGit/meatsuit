/**
 * Файл деплоя meatsuit-сервера: зеркало Neko и его запуск в Docker. В нём только то, что принадлежит серверу:
 * порты, браузер и его образ, пароли зеркала, путь профиля браузера. Настройки вызывающего (лимиты площадок,
 * папки для загрузки, каталог состояния) сюда не входят: их передают аргументами connect()/task().
 *
 * Формат — файл окружения docker compose (KEY=value). Его же читает sh (docker/verify.sh делает `.`), поэтому
 * значения схемы без пробелов, кавычек и знака $. Где лежит: --file, переменная MEATSUIT_CONFIG или docker/.env;
 * сам модуль окружение процесса не читает: путь передают tools/init.js и tools/config-ui.js через defaultFile(env).
 *
 *   const cur = read(file);                          // { exists, text, values, other, version, mode }
 *   validate(values);                                // [{ key, message }] — пусто, если всё в порядке
 *   update(file, { NEKO_PORT: '8081' }, { version }); // атомарно, 0600, ConfigError 409 при чужой правке
 *   createNew(file, fromTemplate());                 // npm run init: только если файла ещё нет
 *
 * Значения секретов модуль не печатает и в тексты ошибок не кладёт.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const TEMPLATE = path.join(ROOT, 'docker', '.env.example');

/** Набор знаков, который одинаково понимают docker compose и sh: без пробелов, кавычек, $, `, \, #, ;, &, |, <, >, (, ), *, ?, ~, !. */
const SAFE = /^[A-Za-z0-9._@%+,:=/-]*$/;
const SAFE_HINT = 'латиница, цифры и . _ @ % + , : = / -';
const WEBRTC_PORTS = [59000, 59019];

const FIELDS = [
  { key: 'NEKO_PASSWORD', group: 'Пароли зеркала', label: 'Пароль участника', type: 'secret', required: true,
    hint: `Вход в зеркало без прав админа (имя при входе любое). Не короче 12 знаков: ${SAFE_HINT}. Пробелы, кавычки и $ нельзя: файл читает и docker compose, и sh.` },
  { key: 'NEKO_ADMIN_PASSWORD', group: 'Пароли зеркала', label: 'Пароль админа', type: 'secret', required: true,
    hint: 'Вход с правами админа: отдать или забрать управление, выгнать. Должен отличаться от пароля участника.' },
  { key: 'NEKO_BIND_IP', group: 'Сеть', label: 'Адрес на хосте', type: 'ipv4', default: '127.0.0.1', noAny: true,
    hint: '127.0.0.1 — зеркало видно только с этой машины. На сервере — адрес tailnet хоста (100.x.y.z). 0.0.0.0 нельзя: порт зеркала не должен смотреть в интернет.' },
  { key: 'NEKO_PORT', group: 'Сеть', label: 'Порт зеркала', type: 'port', default: '8080',
    hint: 'Порт страницы Neko на этом адресе: http://<адрес>:<порт>.' },
  { key: 'NEKO_WEBRTC_IP', group: 'Сеть', label: 'Адрес для видео (WebRTC)', type: 'ipv4', default: '127.0.0.1', noAny: true,
    hint: 'Тот же адрес, под которым вы открываете зеркало: по нему ваш браузер забирает видео (порты 59000–59019/udp).' },
  { key: 'MEATSUIT_API_PORT', group: 'Сеть', label: 'Порт HTTP-сервиса', type: 'port', default: '8787',
    hint: 'Только для замороженного HTTP-сервиса (профиль api). Библиотеке connect() не нужен.' },
  { key: 'MEATSUIT_BROWSER', group: 'Браузер', label: 'Браузер в зеркале', type: 'enum', options: ['chrome', 'brave'], default: 'chrome',
    hint: 'chrome (по умолчанию) или brave. Профиль у каждого свой: после смены входить на сайты придётся заново. Сейчас docker-compose.yml поднимает Brave, выбор по этой строке включится вместе с конфигами Chrome.' },
  { key: 'NEKO_TAG', group: 'Браузер', label: 'Версия образа Neko', type: 'tag', default: '3.1.6',
    hint: 'Тег образа ghcr.io/m1k1o/neko/<браузер>. Новую версию сначала проверьте на своей машине.' },
  { key: 'MEATSUIT_PROFILE_DIR', group: 'Браузер', label: 'Папка профиля браузера', type: 'path', default: '',
    hint: 'Пусто — том Docker (по умолчанию). Иначе абсолютный путь на хосте: там куки и входы. Папка должна существовать и принадлежать пользователю 1000 (neko), иначе браузер не сохранит вход.' },
  { key: 'MEATSUIT_TZ', group: 'Браузер', label: 'Часовой пояс', type: 'tz', default: 'UTC',
    hint: 'Имя IANA, например Europe/Berlin. Должен совпадать с поясом страны, из которой выходит трафик: сайт может сверить пояс браузера с адресом.' },
  { key: 'NEKO_SCREEN', group: 'Ресурсы', label: 'Экран', type: 'screen', default: '1280x720@30',
    hint: 'Ширина x высота @ кадров в секунду. Видео кодируется на процессоре: на слабом сервере берите меньше.' },
  { key: 'NEKO_MEM', group: 'Ресурсы', label: 'Память контейнера', type: 'mem', default: '3g',
    hint: 'Потолок памяти Neko, например 3g или 2048m; в него входит /dev/shm (2 ГБ). Подкачки нет: сорвавшийся браузер убьёт ядро, а не повесит хост.' },
  { key: 'NEKO_CPUS', group: 'Ресурсы', label: 'Процессоры', type: 'cpus', default: '2',
    hint: 'Потолок процессора, например 2 или 1.5. 0 — без потолка: на части хостингов квота не принимается и контейнер не стартует.' },
];
const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));
const SECRET_KEYS = FIELDS.filter((f) => f.type === 'secret').map((f) => f.key);

class ConfigError extends Error {
  /** status — HTTP-код для страницы конфига, code — короткое имя, errors — [{key, message}] при проверке. */
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

/** Путь файла: MEATSUIT_CONFIG (можно с ~/) или docker/.env рядом с compose. */
function defaultFile(env = {}) {
  const v = env.MEATSUIT_CONFIG;
  if (!v) return path.join(ROOT, 'docker', '.env');
  return path.resolve(v.startsWith('~/') ? path.join(os.homedir(), v.slice(2)) : v);
}

// ---- Разбор и запись текста ----

const LINE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=)(.*)$/;

/** Значение после «=» так, как его видит docker compose: кавычки снимаются, комментарий « #…» отрезается. */
function splitValue(rest) {
  const lead = /^\s*/.exec(rest)[0];
  const s = rest.slice(lead.length);
  if (s.startsWith('"') || s.startsWith("'")) {
    const q = s[0];
    let i = 1, value = '';
    while (i < s.length && s[i] !== q) {
      if (q === '"' && s[i] === '\\' && i + 1 < s.length) { value += s[i + 1] === 'n' ? '\n' : s[i + 1]; i += 2; } else value += s[i++];
    }
    return { lead, value, tail: s.slice(i + 1) };
  }
  const c = s.search(/\s#/);
  const body = c < 0 ? s : s.slice(0, c);
  const value = body.trimEnd();
  return { lead, value, tail: s.slice(value.length) };
}

/** Текст → { values: {KEY: value} (последнее определение главное, как в sh и compose), other: [ключи не из схемы] }. */
function parse(text) {
  const values = {};
  const other = [];
  for (const raw of String(text).split('\n')) {
    const m = LINE.exec(raw);
    if (!m) continue;
    values[m[2]] = splitValue(m[4]).value;
    if (!BY_KEY.has(m[2]) && !other.includes(m[2])) other.push(m[2]);
  }
  return { values, other };
}

/**
 * Подставить значения схемы в текст: строки KEY=… меняются на месте (отступ, export и комментарий в конце
 * строки остаются), остальное — комментарии, пустые строки, чужие ключи — как было. Ключа нет — дописывается в конец.
 */
function render(text, values) {
  const lines = String(text).replace(/\n$/, '').split('\n');
  const seen = new Set();
  const out = lines.map((raw) => {
    const m = LINE.exec(raw);
    if (!m || !BY_KEY.has(m[2]) || !(m[2] in values)) return raw;
    seen.add(m[2]);
    const { lead, tail } = splitValue(m[4]);
    return `${m[1]}${m[2]}${m[3]}${lead}${values[m[2]]}${tail}`;
  });
  for (const f of FIELDS) {
    if (seen.has(f.key) || !(f.key in values)) continue;
    out.push('', `# ${f.label}`, `${f.key}=${values[f.key]}`);
  }
  return `${out.join('\n')}\n`;
}

const versionOf = (text) => crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
const randomSecret = () => crypto.randomBytes(16).toString('hex');

/** Маска вместо пароля (то, что страница показывает вместо значения): точки, звёздочки. */
const isMask = (v) => typeof v === 'string' && v.length > 0 && /^[\s•●∙·*]+$/.test(v);

// ---- Проверка ----

const ipv4 = (v) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(v) && v.split('.').every((p) => Number(p) <= 255 && String(Number(p)) === p);
const tzOk = (v) => { try { new Intl.DateTimeFormat('en-US', { timeZone: v }); return true; } catch { return false; } };

/** Одно поле: текст ошибки или null. Само значение в текст не попадает. */
function checkField(f, v) {
  if (typeof v !== 'string') return 'нужна строка';
  if (!SAFE.test(v)) return `недопустимые знаки: можно только ${SAFE_HINT} (без пробелов, кавычек и $)`;
  if (v === '') return f.required ? 'обязательно' : (f.type === 'path' ? null : 'пусто: укажите значение');
  switch (f.type) {
    case 'secret': return v.length < 12 ? 'не короче 12 знаков' : v.length > 128 ? 'не длиннее 128 знаков' : null;
    case 'ipv4':
      if (!ipv4(v)) return 'нужен адрес IPv4, например 127.0.0.1';
      return f.noAny && v === '0.0.0.0' ? '0.0.0.0 нельзя: порт откроется на всех адресах, в том числе в интернет' : null;
    case 'port': {
      if (!/^\d{1,5}$/.test(v) || Number(v) < 1 || Number(v) > 65535) return 'нужен порт 1–65535';
      const n = Number(v);
      return n >= WEBRTC_PORTS[0] && n <= WEBRTC_PORTS[1] ? 'порты 59000–59019 заняты видео WebRTC' : null;
    }
    case 'enum': return f.options.includes(v) ? null : `одно из: ${f.options.join(', ')}`;
    case 'tag': return /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(v) ? null : 'тег образа: латиница, цифры, . _ -, например 3.1.6';
    case 'path':
      if (!v.startsWith('/')) return 'нужен абсолютный путь (с /) или пусто';
      return v === '/' || v.split('/').includes('..') ? 'не корень и без ..' : null;
    case 'tz': return tzOk(v) ? null : 'неизвестный часовой пояс: нужно имя IANA, например Europe/Berlin или UTC';
    case 'screen': return /^[1-9]\d{2,3}x[1-9]\d{2,3}@[1-9]\d?$/.test(v) ? null : 'формат ширинаxвысота@кадры, например 1280x720@30';
    case 'mem': return /^\d+(\.\d+)?[kmgKMG]$/.test(v) && parseFloat(v) > 0 ? null : 'число с единицей k, m или g, например 3g или 2048m';
    case 'cpus': return /^\d+(\.\d+)?$/.test(v) ? null : 'число процессоров, например 2 или 1.5; 0 — без потолка';
    default: return null;
  }
}

/** Все значения схемы: [{ key, message }]. Нет ключа — как пустой. */
function validate(values) {
  const errors = [];
  for (const f of FIELDS) {
    const msg = checkField(f, values[f.key] ?? '');
    if (msg) errors.push({ key: f.key, message: msg });
  }
  const bad = new Set(errors.map((e) => e.key));
  if (!bad.has('NEKO_PASSWORD') && !bad.has('NEKO_ADMIN_PASSWORD') && values.NEKO_PASSWORD === values.NEKO_ADMIN_PASSWORD) {
    errors.push({ key: 'NEKO_ADMIN_PASSWORD', message: 'совпадает с паролем участника: нужны разные' });
  }
  if (!bad.has('NEKO_PORT') && !bad.has('MEATSUIT_API_PORT') && values.NEKO_PORT === values.MEATSUIT_API_PORT) {
    errors.push({ key: 'MEATSUIT_API_PORT', message: 'совпадает с портом зеркала' });
  }
  return errors;
}

/**
 * Правка от страницы → новые значения. Секрет: поля нет (или null) — оставить как было; маска — ошибка;
 * строка — новое значение. Остальные поля: нет — как было. Поле не из схемы — ошибка.
 */
function applyChanges(current, changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new ConfigError(400, 'invalid', 'values: нужен объект');
  const next = {};
  for (const f of FIELDS) next[f.key] = current[f.key] ?? '';
  const errors = [];
  for (const [key, v] of Object.entries(changes)) {
    const f = BY_KEY.get(key);
    if (!f) { errors.push({ key, message: 'такого поля в схеме нет' }); continue; }
    if (v === null || v === undefined) {
      if (f.type !== 'secret') errors.push({ key, message: 'пустое значение: передайте строку или не передавайте поле' });
      continue;
    }
    if (f.type === 'secret' && isMask(v)) { errors.push({ key, message: 'это маска, а не пароль: чтобы оставить пароль, не передавайте поле' }); continue; }
    if (typeof v === 'number' && f.type !== 'secret') { next[key] = String(v); continue; }
    if (typeof v !== 'string') { errors.push({ key, message: 'нужна строка' }); continue; }
    next[key] = v;
  }
  if (errors.length) throw new ConfigError(400, 'invalid', errorText(errors), { errors });
  return next;
}

const errorText = (errors) => errors.map((e) => `${e.key}: ${e.message}`).join('; ');

// ---- Файл ----

/** Настоящий путь: если файл — ссылка (docker/.env → ~/…/meatsuit.env), пишем в цель, а не заменяем ссылку. */
function target(file) {
  try { return fs.realpathSync(file); } catch { return path.resolve(file); }
}

function read(file) {
  let text, st;
  try {
    text = fs.readFileSync(file, 'utf8');
    st = fs.statSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, file };
    throw e;
  }
  const { values, other } = parse(text);
  return { exists: true, file, text, values, other, version: versionOf(text), mode: st.mode & 0o777 };
}

function fsyncDir(dir) {
  try { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch { /* не все системы дают fsync каталога */ }
}

/** Временный файл рядом с целью, 0600, на диске целиком. */
function writeTmp(dest, text) {
  const tmp = `${dest}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  return tmp;
}

/** Атомарная запись: временный файл + rename. Читатель видит старый файл или новый целиком, права 0600. */
function writeAtomic(file, text) {
  const dest = target(file);
  const tmp = writeTmp(dest, text);
  try { fs.renameSync(tmp, dest); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  fsyncDir(path.dirname(dest));
}

/** Создать файл, только если его нет (жёсткая ссылка не перезаписывает). true — создан, false — уже был. */
function createNew(file, text) {
  const dest = path.resolve(file);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  if (fs.existsSync(dest)) return false;
  const tmp = writeTmp(dest, text);
  try {
    fs.linkSync(tmp, dest);
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  } finally { fs.rmSync(tmp, { force: true }); }
  fsyncDir(path.dirname(dest));
  return true;
}

/** Замок между процессами (страница, второй npm run config, init): файл <цель>.lock, занятый — 409. */
function withLock(file, fn, { staleMs = 30000 } = {}) {
  const lock = `${target(file)}.lock`;
  let fd;
  for (let attempt = 0; attempt < 2 && fd === undefined; attempt++) {
    try { fd = fs.openSync(lock, 'wx', 0o600); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
      if (age > staleMs) { fs.rmSync(lock, { force: true }); continue; }
      throw new ConfigError(409, 'locked', 'файл сейчас записывает другой процесс: повторите через секунду');
    }
  }
  if (fd === undefined) throw new ConfigError(409, 'locked', 'не удалось занять замок файла');
  try {
    fs.closeSync(fd);
    return fn();
  } finally { fs.rmSync(lock, { force: true }); }
}

/**
 * Правка файла: version — то, что видела страница (из read). Чужая правка между чтением и записью — 409;
 * ошибки проверки — 400 со списком. Возвращает { version } нового файла.
 */
function update(file, changes, { version } = {}) {
  return withLock(file, () => {
    const cur = read(file);
    if (!cur.exists) throw new ConfigError(409, 'missing', 'файла больше нет: создайте его заново (npm run init)');
    if (!version || version !== cur.version) {
      throw new ConfigError(409, 'conflict', 'файл изменился после того, как страница его прочитала: перечитайте, ваши правки не сохранены');
    }
    const next = applyChanges(cur.values, changes);
    const errors = validate(next);
    if (errors.length) throw new ConfigError(400, 'invalid', errorText(errors), { errors });
    const text = render(cur.text, next);
    writeAtomic(file, text);
    return { version: versionOf(text) };
  });
}

/** Текст нового файла из docker/.env.example: пароли зеркала — случайный hex, остальное — умолчания образца. */
function fromTemplate(templateText = fs.readFileSync(TEMPLATE, 'utf8')) {
  const { values } = parse(templateText);
  const next = {};
  for (const f of FIELDS) next[f.key] = f.type === 'secret' ? randomSecret() : (values[f.key] ?? f.default ?? '');
  const errors = validate(next);
  if (errors.length) throw new ConfigError(500, 'template', `образец ${path.relative(ROOT, TEMPLATE)} не проходит проверку: ${errorText(errors)}`);
  return render(templateText, next);
}

module.exports = {
  FIELDS, SECRET_KEYS, TEMPLATE, ConfigError,
  defaultFile, parse, render, validate, applyChanges, isMask, versionOf, randomSecret,
  read, writeAtomic, createNew, withLock, update, fromTemplate,
};
