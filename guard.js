/**
 * guard: по снимку страницы решает, можно ли продолжать. Только распознавание,
 * обхода нет: капча и блок останавливают бота, вход означает «сессия потеряна».
 *
 * Снимок: { url, title, text, captchaFrame }. Фразы ищутся только на коротких
 * страницах (страница-заглушка мала, а длинная статья про капчу не повод
 * останавливаться); структурный признак (фрейм капчи) работает всегда.
 */
const CAPTCHA_TEXT = /verify (that )?you('| a)?re (a )?human|are you a robot|i'?m not a robot|checking your browser|подтвердите,? что (вы не робот|запросы отправляли вы)|я не робот|вы не робот|введите символы с картинки|press\s*(&|and)\s*hold|confirm you are a human/i;
const BLOCKED_TEXT = /unusual traffic|access denied|too many requests|temporarily blocked|подозрительн\w+ (активност|трафик)|доступ (запрещ|ограничен)|превышен лимит запросов/i;
const CHALLENGE_TITLE = /just a moment|attention required/i;
// Заголовок страницы-ошибки: «403», «Error 403», «403 Forbidden». «403 — Википедия» и «429 год» — это статьи.
const ERROR_TITLE = /^\s*(?:(?:error|http)\s*)?(?:403|429)\s*(?:[-–—:.]?\s*(?:forbidden|too many requests|access denied|error|доступ запрещ|запрещ|слишком много)[^]*)?$/i;
const CHALLENGE_URL = /\/(show)?(captcha|challenge)\b/i;
const BLOCKED_URL = /\/(sorry|checkpoint|blocked)\b/i;
const LOGIN_PATH = /\/(log-?in|sign-?in)(?=[/.]|$)/i; // /signin ловит и вход Google (/v3/signin); «/login-security-tips» — статья, не вход

const SHORT = 2000;

/** Путь адреса без строки запроса и якоря: «?next=/login» входом не считается. */
function pathOf(url) {
  try { return new URL(url).pathname; } catch { return String(url).split(/[?#]/)[0]; }
}

/** 'captcha' | 'blocked' | 'login' | null */
function classify({ url = '', title = '', text = '', captchaFrame = false } = {}) {
  if (captchaFrame) return 'captcha';
  const short = text.length < SHORT;
  if (short && CHALLENGE_TITLE.test(title)) return 'captcha';
  if (short && CHALLENGE_URL.test(url)) return 'captcha';
  if (short && BLOCKED_URL.test(url)) return 'blocked';
  if (short && CAPTCHA_TEXT.test(`${title} ${text}`)) return 'captcha';
  if (short && ERROR_TITLE.test(title)) return 'blocked';
  if (short && BLOCKED_TEXT.test(`${title} ${text}`)) return 'blocked';
  if (LOGIN_PATH.test(pathOf(url))) return 'login';
  return null;
}

module.exports = { classify };
