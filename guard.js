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

// Страницы-заглушки малы. Длинный текст — это профили и переписка, а в
// био у человека может быть слово «captcha»: по нему не останавливаемся.
const BLOCK_PAGE_MAX_TEXT = 600;

const urlPath = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return ''; } };

/** null, если всё нормально, иначе причина остановки. */
function check(s) {
  const dialogs = (s.dialogs || []).map((d) => `${d.name} ${d.text}`).join(' ');
  const names = (s.elements || []).map((e) => e.name).join(' ');
  const short = typeof s.text === 'string' && s.text.length <= BLOCK_PAGE_MAX_TEXT ? s.text : '';
  const haystack = [s.title, dialogs, short, names].filter(Boolean).join(' ');

  if (CAPTCHA.test(haystack) || (s.frames || []).some((u) => CAPTCHA_FRAME.test(u))) return 'капча';
  if (SUSPICIOUS.test(haystack)) return 'подозрительная активность или ограничение аккаунта';
  const passwordField = (s.elements || []).some((e) => e.inputType === 'password' || (e.role === 'textbox' && PASSWORD.test(e.name)));
  if (passwordField || (s.url && LOGIN_URL.test(urlPath(s.url)))) return 'страница входа';
  return null;
}

const { telegramNotifier } = require('./telegram.js'); // остаётся здесь для совместимости импорта

module.exports = { check, NeedsHuman, telegramNotifier };
