/**
 * Самопроверка (selfcheck.js): оценка фактов — чистая, на образцах; сбор фактов — на настоящем Chromium
 * (без patchright или браузера пропускается).
 *
 *   NODE_PATH=…/node_modules node --test test/selfcheck.test.js
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const chromium = require('../testkit/browser-chromium.js');
const { collect, judge, format, parseArgs, servePage } = require('../selfcheck.js');

const HUMAN = {
  webdriver: false, cdpLeak: false, chrome: true, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  uaData: { brands: ['Chromium', 'Brave', 'Not_A Brand'], mobile: false, platform: 'Linux' }, platform: 'Linux x86_64', languages: ['en-US', 'ru'],
  timeZone: 'Asia/Almaty', tzOffsetMin: -300, screen: { width: 1280, height: 720, availWidth: 1280, availHeight: 720, colorDepth: 24, dpr: 1 },
  window: { innerWidth: 1280, innerHeight: 635, outerWidth: 1280, outerHeight: 720 }, hardwareConcurrency: 4, deviceMemory: 8, plugins: 5, pdfViewer: true,
  notification: 'default', notificationQuery: 'prompt', webgl: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics)' }, maxTouchPoints: 0,
  hasFocus: true, visibility: 'visible', fonts: ['Arial', 'DejaVu Sans', 'Liberation Sans', 'Noto Sans', 'Roboto'], cookies: true, doNotTrack: null,
};
const levels = (f, o) => judge(f, o).filter((v) => v.level !== 'info').map((v) => `${v.level}:${v.key}`);

test('человеческий браузер: ни красного, ни жёлтого, только справка', () => {
  assert.deepEqual(levels(HUMAN, { tz: 'Asia/Almaty' }), []);
  const keys = judge(HUMAN).map((v) => v.key);
  for (const k of ['ua', 'platform', 'languages', 'tz', 'size', 'hw', 'fonts', 'webgl']) assert.ok(keys.includes(k), `нет справки ${k}`);
});

test('признаки автоматизации — красные: webdriver, Headless, след CDP, нет window.chrome, нет плагинов, нет языков, несостыковка уведомлений', () => {
  assert.deepEqual(levels({ ...HUMAN, webdriver: true }), ['red:webdriver']);
  assert.deepEqual(levels({ ...HUMAN, userAgent: 'Mozilla/5.0 HeadlessChrome/130' }), ['red:headless']);
  assert.deepEqual(levels({ ...HUMAN, uaData: { ...HUMAN.uaData, brands: ['HeadlessChrome'] } }), ['red:headless']);
  assert.deepEqual(levels({ ...HUMAN, cdpLeak: true }), ['red:cdp']);
  assert.deepEqual(levels({ ...HUMAN, chrome: false }), ['red:chrome']);
  assert.deepEqual(levels({ ...HUMAN, plugins: 0 }), ['red:plugins']);
  assert.deepEqual(levels({ ...HUMAN, languages: [] }), ['red:languages']);
  assert.deepEqual(levels({ ...HUMAN, notification: 'denied', notificationQuery: 'prompt' }), ['red:notification']);
});

test('признаки контейнера и политики — жёлтые: нет WebGL или он программный, уведомления запрещены, мало ядер, памяти, шрифтов, маленький экран, нет рамки, пояс не тот', () => {
  assert.deepEqual(levels({ ...HUMAN, webgl: null }), ['yellow:webgl']);
  assert.deepEqual(levels({ ...HUMAN, webgl: { vendor: 'Google Inc. (Google)', renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))' } }), ['yellow:webgl']);
  assert.deepEqual(levels({ ...HUMAN, webgl: { vendor: 'Mesa', renderer: 'llvmpipe (LLVM 17.0.6, 256 bits)' } }), ['yellow:webgl']);
  assert.deepEqual(levels({ ...HUMAN, webgl: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)' } }), [], '«Mesa» у настоящей видеокарты на Linux — норма');
  assert.deepEqual(levels({ ...HUMAN, notification: 'denied', notificationQuery: 'denied' }), ['yellow:notification']);
  assert.deepEqual(levels({ ...HUMAN, hardwareConcurrency: 1 }), ['yellow:cpu']);
  assert.deepEqual(levels({ ...HUMAN, deviceMemory: 1 }), ['yellow:memory']);
  assert.deepEqual(levels({ ...HUMAN, deviceMemory: undefined }), [], 'deviceMemory не отдаётся (Brave режет): не повод');
  assert.deepEqual(levels({ ...HUMAN, screen: { ...HUMAN.screen, width: 800, height: 600 }, window: { innerWidth: 800, innerHeight: 515, outerWidth: 800, outerHeight: 600 } }), ['yellow:screen']);
  assert.deepEqual(levels({ ...HUMAN, window: { ...HUMAN.window, innerHeight: 720 } }), ['yellow:frame']);
  assert.deepEqual(levels({ ...HUMAN, window: { ...HUMAN.window, outerWidth: 1920 } }), ['yellow:window']);
  assert.deepEqual(levels({ ...HUMAN, fonts: ['DejaVu Sans'] }), ['yellow:fonts']);
  assert.deepEqual(levels(HUMAN, { tz: 'Europe/Berlin' }), ['yellow:tz']);
  assert.deepEqual(levels(HUMAN, {}), [], 'без --tz пояс не сверяется');
});

test('вывод: отметка, ключ, текст; разбор аргументов', () => {
  const text = format(judge({ ...HUMAN, webdriver: true, webgl: null }, { tz: 'Asia/Almaty' }));
  assert.match(text, /^КРАСНЫЙ {2}webdriver {4}navigator\.webdriver = true/m);
  assert.match(text, /^ЖЁЛТЫЙ {2}webgl/m);
  assert.deepEqual(parseArgs(['--cdp', 'http://x:1', '--tz', 'Europe/Berlin', '--json'], {}), { cdp: 'http://x:1', tz: 'Europe/Berlin', json: true });
  assert.deepEqual(parseArgs([], { MEATSUIT_CDP: 'http://y:2', MEATSUIT_TZ: 'Asia/Almaty' }), { cdp: 'http://y:2', tz: 'Asia/Almaty', json: false });
  assert.throws(() => parseArgs(['--nope'], {}), /неизвестный аргумент/);
});

// ------------------------------------------------------------ настоящий Chromium

const skip = chromium.unavailable();
let browser, cdp, context, site;

before(async () => {
  if (skip) return;
  browser = await chromium.launch();
  ({ browser: cdp, context } = await chromium.connect(browser.cdpUrl));
  site = await servePage();
});
after(async () => {
  if (skip) return;
  await cdp.close().catch(() => {});
  await browser.stop();
  await site.close();
});

test('сбор фактов на настоящем браузере: все поля на месте и правдоподобны; след CDP измеряется, а не предполагается', { skip }, async () => {
  const page = await context.newPage();
  try {
    const f = await collect(page, site.origin);
    assert.equal(typeof f.webdriver, 'boolean');
    assert.equal(typeof f.cdpLeak, 'boolean');
    assert.equal(typeof f.chrome, 'boolean');
    assert.match(f.userAgent, /Chrome\//);
    assert.ok(Array.isArray(f.languages) && f.languages.length > 0);
    assert.equal(typeof f.timeZone, 'string');
    assert.ok(f.screen.width > 0 && f.window.innerWidth > 0);
    assert.ok(Number.isInteger(f.plugins) && f.plugins >= 0);
    assert.ok(['default', 'denied', 'granted', null].includes(f.notification));
    assert.ok(['prompt', 'denied', 'granted', null].includes(f.notificationQuery));
    assert.ok(f.webgl === null || (typeof f.webgl.renderer === 'string' && f.webgl.renderer.length > 0));
    assert.ok(Array.isArray(f.fonts));
    assert.ok(Number.isInteger(f.hardwareConcurrency) && f.hardwareConcurrency >= 1);
    const verdicts = judge(f);
    assert.ok(verdicts.length > 5);
    assert.ok(verdicts.every((v) => ['red', 'yellow', 'info'].includes(v.level) && typeof v.key === 'string' && typeof v.text === 'string'));
    console.log(`  (headless Chromium для справки: ${verdicts.filter((v) => v.level !== 'info').map((v) => `${v.level}:${v.key}`).join(', ') || 'ни красного, ни жёлтого'}; cdpLeak=${f.cdpLeak})`);
  } finally { await page.close(); }
});
