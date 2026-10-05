/**
 * guard: по снимку страницы решает, можно ли продолжать. Обхода нет, только
 * распознавание: капча и блок останавливают бота, вход означает «сессия
 * потеряна».
 *
 *   node --test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('../guard.js');

const article = 'Обычный длинный текст статьи про разработку. '.repeat(120);

test('распознаёт капчу, блок и вход по снимку страницы', () => {
  const cases = [
    ['обычная статья', { url: 'https://habr.com/ru/articles/1/', title: 'Статья', text: article }, null],
    ['пустой снимок', {}, null],
    ['фрейм reCAPTCHA', { url: 'https://site.test/', text: 'короткая', captchaFrame: true }, 'captcha'],
    ['Google /sorry/', { url: 'https://www.google.com/sorry/index?continue=https://www.google.com/', text: '' }, 'blocked'],
    ['необычный трафик', { url: 'https://site.test/', text: 'Our systems have detected unusual traffic from your computer network.' }, 'blocked'],
    ['подтвердите, что вы не робот', { url: 'https://site.test/', text: 'Подтвердите, что вы не робот' }, 'captcha'],
    ['проверка Cloudflare', { url: 'https://site.test/', title: 'Just a moment...', text: 'Checking your browser before accessing site.test' }, 'captcha'],
    ['403', { url: 'https://site.test/', title: '403 Forbidden', text: 'Access denied' }, 'blocked'],
    ['429', { url: 'https://site.test/', title: '429 Too Many Requests', text: '' }, 'blocked'],
    ['редирект на вход Google', { url: 'https://accounts.google.com/v3/signin/identifier?x=1', text: '' }, 'login'],
    ['страница /login', { url: 'https://site.test/login?next=/', text: 'Войти' }, 'login'],
  ];
  for (const [name, snapshot, want] of cases) assert.equal(classify(snapshot), want, name);
});

test('длинная статья про капчу — не капча', () => {
  const text = 'CAPTCHA asks users to verify you are human. Are you a robot? '.repeat(200);
  assert.equal(classify({ url: 'https://en.wikipedia.org/wiki/CAPTCHA', title: 'CAPTCHA — Wikipedia', text }), null);
});

test('структурный признак капчи сильнее длины страницы', () => {
  assert.equal(classify({ url: 'https://site.test/', text: article, captchaFrame: true }), 'captcha');
});

test('длинная страница с «403» или «429» в заголовке — не блок', () => {
  const titles = ['403 — Википедия', '429 год — Википедия', '403 Forbidden is not a bug | Hacker News', '403 ошибки, которые я совершил'];
  for (const title of titles) assert.equal(classify({ url: 'https://site.test/a', title, text: article }), null, title);
});

test('короткая страница с заголовком ошибки — блок, а короткая статья про год — нет', () => {
  const short = 'Страница ошибки';
  for (const title of ['403', '429', 'Error 403', 'HTTP 429', '403 Forbidden', '403 - Forbidden: Access is denied.', '429 Too Many Requests', '403 Доступ запрещён']) {
    assert.equal(classify({ url: 'https://site.test/a', title, text: short }), 'blocked', title);
  }
  for (const title of ['403 — Википедия', '429 год — Википедия', '403 ошибки, которые я совершил']) {
    assert.equal(classify({ url: 'https://site.test/a', title, text: 'Короткая заметка про год.' }), null, title);
  }
});

test('«/login» в строке запроса или в якоре — не вход, только в пути', () => {
  for (const url of ['https://site.test/news?utm=/login', 'https://site.test/news?next=/signin&x=1', 'https://site.test/#/login', 'https://site.test/blog/how-login-works']) {
    assert.equal(classify({ url, title: 'Новости', text: article }), null, url);
  }
  for (const url of ['https://site.test/login', 'https://site.test/user/sign-in?next=/', 'https://accounts.google.com/v3/signin/identifier']) {
    assert.equal(classify({ url, title: 'Вход', text: 'Войти' }), 'login', url);
  }
});

test('Яндекс SmartCaptcha распознаётся по адресу и по тексту', () => {
  assert.equal(classify({ url: 'https://ya.ru/showcaptcha?cc=1&mt=ABC&retpath=https%3A//ya.ru', title: 'Ой!', text: '' }), 'captcha');
  assert.equal(classify({ url: 'https://yandex.ru/showcaptcha', title: '', text: 'Нажмите, чтобы продолжить' }), 'captcha');
  assert.equal(classify({ url: 'https://site.test/', title: 'Вы не робот?', text: 'Подтвердите, что запросы отправляли вы, а не робот' }), 'captcha');
  assert.equal(classify({ url: 'https://site.test/', title: '', text: 'Вы не робот?' }), 'captcha');
});

test('PerimeterX «Press & Hold» распознаётся', () => {
  assert.equal(classify({ url: 'https://site.test/', title: 'Access to this page has been denied', text: 'Press & Hold to confirm you are a human (and not a bot).' }), 'captcha');
  assert.equal(classify({ url: 'https://site.test/', title: '', text: 'Please press and hold the button' }), 'captcha');
});

test('длинная статья про Яндекс-капчу и PerimeterX — не капча', () => {
  const text = 'Вы не робот? Press & Hold to confirm you are a human. '.repeat(100);
  assert.equal(classify({ url: 'https://habr.com/ru/articles/2/', title: 'Как обойти защиту', text }), null);
  assert.equal(classify({ url: 'https://habr.com/ru/articles/showcaptcha-history', title: 'История', text }), null);
});
