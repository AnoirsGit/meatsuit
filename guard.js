/**
 * Предохранитель: по снимку страницы решает, что дальше без человека нельзя.
 * Капча, страница входа, «подозрительная активность» — стоп и сообщение мне.
 * Обхода нет.
 *
 * check() — чистая функция, её проверяет test/guard.test.js.
 */
class NeedsHuman extends Error {
  constructor(reason, url) { super(reason); this.reason = reason; this.url = url; }
}

const CAPTCHA = /captcha|hcaptcha|arkose|verify (that )?you('| a)re (a )?human|i'?m not a robot|не робот/i;
const SUSPICIOUS = new RegExp([
  'unusual activity', 'suspicious activity', 'подозрительн\\w* активност',
  'account (has been )?(suspended|banned|restricted|locked)', 'аккаунт (заблокирован|ограничен|приостановлен)',
  'too many requests', 'слишком много запросов', 'access denied', 'доступ ограничен',
].join('|'), 'i');
const CAPTCHA_FRAME = /recaptcha|hcaptcha|arkoselabs|funcaptcha|challenges\.cloudflare\.com|geetest/i;
const LOGIN_URL = /\/(log-?in|sign-?in)(\/|$|\?)/i;
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

/** null, если всё нормально, иначе причина остановки. */
function check(s) {
  const dialogs = (s.dialogs || []).map((d) => `${d.name} ${d.text}`).join(' ');
  const names = (s.elements || []).map((e) => e.name).join(' ');
  const short = shortText(s);
  const haystack = [s.title, dialogs, short, names].filter(Boolean).join(' ');

  if (CAPTCHA.test(haystack) || captchaFrame(s.frames || [], s.hiddenFrames || [])) return 'капча';
  if (SUSPICIOUS.test(haystack)) return 'подозрительная активность или ограничение аккаунта';
  const passwordField = (s.elements || []).some((e) => e.inputType === 'password' || (e.role === 'textbox' && PASSWORD.test(e.name)));
  if (passwordField || (s.url && LOGIN_URL.test(urlPath(s.url)))) return 'страница входа';
  return null;
}

const { telegramNotifier } = require('./telegram.js'); // остаётся здесь для совместимости импорта

module.exports = { check, NeedsHuman, telegramNotifier };
