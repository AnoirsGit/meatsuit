/**
 * Предохранитель: по снимку страницы решает, что дальше без человека нельзя.
 * Капча, страница входа, «подозрительная активность» — стоп и сообщение мне.
 * Обхода нет. Одно узкое исключение — вход по одноразовому коду (codeLogin, ниже).
 *
 * check() — чистая функция, её проверяет test/guard.test.js.
 */
class NeedsHuman extends Error {
  constructor(reason, url) { super(reason); this.reason = reason; this.url = url; }
}

const CAPTCHA = /captcha|hcaptcha|arkose|verify (that )?you('| a)re (a )?human|i'?m not a robot|не робот/i;
const SUSPICIOUS = new RegExp([
  'unusual activity', 'suspicious activity', 'подозрительн[а-яё]* активност',
  'account (has been )?(suspended|banned|restricted|locked)', 'аккаунт (заблокирован|ограничен|приостановлен)',
  'too many requests', 'слишком много запросов', 'access denied', 'доступ ограничен',
].join('|'), 'i');
const CAPTCHA_FRAME = /recaptcha|hcaptcha|arkoselabs|funcaptcha|challenges\.cloudflare\.com|geetest/i;
const LOGIN_URL = /\/(log[-_]?in|sign[-_]?in)(\/|$|\?)/i; // /users/sign_in — Rails (GitLab)
const PASSWORD = /password|пароль/i;

// reCAPTCHA на формах — это два iframe: якорь (anchor) и задание (bframe). Невидимый якорь
// (size=invisible, v3 и Enterprise) у человека ничего не просит, а bframe висит в DOM скрытым
// рядом с любым якорем и показывается только вместе с заданием. Поэтому стоп — это галочка
// «I'm not a robot» (якорь без size=invisible) или показанный bframe. Адрес разбираем через URL:
// size=invisible в чужом параметре, во фрагменте или не на хосте reCAPTCHA ничего не меняет.
const RECAPTCHA_HOST = /(^|\.)(google\.com|recaptcha\.net)$/i;
const RECAPTCHA_PATH = /^\/recaptcha\/(api2|enterprise)\/(anchor|bframe)$/;
const recaptcha = (u) => {
  let x; try { x = new URL(u); } catch { return null; }
  const m = RECAPTCHA_HOST.test(x.hostname) && RECAPTCHA_PATH.exec(x.pathname);
  return m ? { frame: m[2], invisible: x.searchParams.get('size') === 'invisible' } : null;
};

/** Есть ли среди frames капча, которую человек видит. Без hiddenFrames кадр считается показанным. */
function captchaFrame(frames, hiddenFrames) {
  const count = (arr, u) => arr.filter((x) => x === u).length;
  return frames.some((u) => {
    const rc = recaptcha(u);
    if (!rc) return CAPTCHA_FRAME.test(u);
    if (rc.frame === 'anchor') return !rc.invisible;
    return count(frames, u) > count(hiddenFrames, u); // bframe: хотя бы один такой кадр показан
  });
}

// Страницы-заглушки малы. Длинный текст — это профили и переписка, а в
// био у человека может быть слово «captcha»: по нему не останавливаемся.
const BLOCK_PAGE_MAX_TEXT = 600;

// Порог — к каждому куску text отдельно: light DOM и каждый shadow-корень (длины в textParts от eyes).
// Иначе баннер cookie в shadow на несколько сотен символов прятал бы заглушку из light DOM.
const shortText = (s) => {
  if (typeof s.text !== 'string') return '';
  const ok = Array.isArray(s.textParts) && s.textParts.every((n) => Number.isInteger(n) && n >= 0);
  const out = [];
  let at = 0;
  for (const n of ok ? s.textParts : [s.text.length]) {
    if (n <= BLOCK_PAGE_MAX_TEXT) out.push(s.text.slice(at, at + n));
    at += n + 1; // куски склеены через пробел
  }
  return out.join(' ');
};

const urlPath = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return ''; } };

// Вход по одноразовому коду (codeLogin). Страницу входа можно не считать стопом, только если сошлось всё:
// задача попросила (task(..., { codeLogin: true })), у площадки в sites.json вызывающего объявлен один путь
// (`"codeLogin": { "path": "^/account/login" }`), адрес — https на хосте площадки (или её поддомене) и путь
// совпал, на странице нет поля пароля. Капча и «подозрительная активность» проверяются раньше и не снимаются.
const CODE_LOGIN_MAX_COMMANDS = 20;

/**
 * Правило codeLogin из записи площадки → { path: RegExp, maxMinutes? }. Бросает на неверном виде:
 * путь — строка с якорем «^/…» (один путь, не «весь сайт»), maxMinutes — положительное число, если есть.
 */
function codeLoginRule(c) {
  const bad = (why) => new Error(`codeLogin: ${why} (образец: "codeLogin": { "path": "^/account/login" })`);
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw bad('нужен объект');
  if (typeof c.path !== 'string' || !/^\^\/./.test(c.path)) throw bad('path — регулярное выражение пути с якорем «^/» и хотя бы одним символом после «/»');
  let path;
  try { path = new RegExp(c.path); } catch (e) { throw bad(`path не разбирается: ${e.message}`); }
  if (c.maxMinutes !== undefined && !(typeof c.maxMinutes === 'number' && c.maxMinutes > 0)) throw bad('maxMinutes — положительное число');
  const extra = Object.keys(c).filter((k) => k !== 'path' && k !== 'maxMinutes');
  if (extra.length) throw bad(`лишние поля: ${extra.join(', ')}`);
  return { path, ...(c.maxMinutes !== undefined && { maxMinutes: c.maxMinutes }) };
}

/** Адрес — объявленный путь входа по коду на площадке site. codeLogin: { site, path: RegExp }. */
function codeLoginPage(url, { site, path }) {
  let x; try { x = new URL(url); } catch { return false; }
  if (x.protocol !== 'https:') return false;
  const host = x.hostname.toLowerCase();
  const own = String(site).toLowerCase();
  return (host === own || host.endsWith('.' + own)) && path.test(x.pathname);
}

/**
 * null, если всё нормально, иначе причина остановки.
 * opts.codeLogin — { site, path: RegExp } для задачи с codeLogin (собирает supervise); без него как всегда.
 */
function check(s, { codeLogin } = {}) {
  const dialogs = (s.dialogs || []).map((d) => `${d.name} ${d.text}`).join(' ');
  const names = (s.elements || []).map((e) => e.name).join(' ');
  const short = shortText(s);
  const haystack = [s.title, dialogs, short, names].filter(Boolean).join(' ');

  if (CAPTCHA.test(haystack) || captchaFrame(s.frames || [], s.hiddenFrames || [])) return 'капча';
  if (SUSPICIOUS.test(haystack)) return 'подозрительная активность или ограничение аккаунта';
  const passwordField = (s.elements || []).some((e) => e.inputType === 'password' || (e.role === 'textbox' && PASSWORD.test(e.name)));
  if (passwordField) return 'страница входа'; // пароль бот не вводит никогда, codeLogin тоже
  if (s.url && LOGIN_URL.test(urlPath(s.url))) return codeLogin && codeLoginPage(s.url, codeLogin) ? null : 'страница входа';
  return null;
}

module.exports = { check, NeedsHuman, codeLoginRule, CODE_LOGIN_MAX_COMMANDS };
