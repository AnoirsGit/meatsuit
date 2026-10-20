#!/usr/bin/env node
/**
 * Самопроверка: что сайт видит в этом браузере. Открывает своё окно в запущенном браузере
 * (как задача сервиса), заходит на локальную страницу и собирает то, по чему сайты отличают
 * автоматизацию от человека: navigator.webdriver, след протокола DevTools (Runtime.enable),
 * WebGL, плагины, разрешение уведомлений, шрифты, часовой пояс, размеры окна и экрана.
 * Ничего не подделывает и не чинит: только показывает, где браузер выглядит не как у человека.
 *
 *   node selfcheck.js [--cdp http://127.0.0.1:9222] [--tz Asia/Almaty] [--json]
 *
 * --tz: пояс страны выхода (тот же, что у сервиса); не совпал с поясом браузера — жёлтый.
 * Код выхода 1, если есть красные отметки. Правила оценки (judge) — догадки автора по известным
 * признакам детекторов, не измерены на конкретных сайтах; красное значит «так у людей не бывает»,
 * жёлтое — «бывает, но редко, и в сумме с другим выдаёт».
 */
const http = require('node:http');
const { windowOpener } = require('./window.js');

// Страница проверки. Скрипт в её мире (не в изолированном мире patchright) проверяет след Runtime.enable:
// при включённом Runtime DevTools сериализует ошибку из console и читает её stack; getter это замечает.
// Приём известен детекторам (DataDome, Cloudflare); Patchright обещает не включать Runtime.
const CHECK_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>meatsuit selfcheck</title></head><body>
<pre id="out"></pre>
<script>
(() => {
  const out = document.getElementById('out');
  let leaked = false;
  const e = new Error('meatsuit');
  Object.defineProperty(e, 'stack', { configurable: true, get() { leaked = true; return 'meatsuit'; } });
  console.debug(e);
  setTimeout(() => {
    out.dataset.cdp = String(leaked);
    out.dataset.chrome = String(typeof window.chrome === 'object' && window.chrome !== null);
    out.dataset.webdriver = String(navigator.webdriver);
    out.dataset.ready = '1';
  }, 50);
})();
</script></body></html>`;

// Шрифты, которые есть почти у любого человека на его системе. Контейнер с одним DejaVu выглядит как сервер.
const FONTS = ['Arial', 'Times New Roman', 'Verdana', 'Georgia', 'Courier New', 'Segoe UI', 'Roboto', 'Noto Sans', 'DejaVu Sans', 'Liberation Sans', 'Ubuntu', 'Helvetica', 'Tahoma', 'Trebuchet MS'];

/** Собрать факты со страницы проверки (page уже на ней). Идёт в page.evaluate, ничего снаружи не использует. */
function inPage(fonts) {
  const out = document.getElementById('out');
  const gl = (() => {
    try {
      const c = document.createElement('canvas');
      const g = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!g) return null;
      const d = g.getExtension('WEBGL_debug_renderer_info');
      return { vendor: String(d ? g.getParameter(d.UNMASKED_VENDOR_WEBGL) : g.getParameter(g.VENDOR)), renderer: String(d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER)) };
    } catch { return null; }
  })();
  // Шрифт есть, если ширина текста им отличается от ширины запасным (monospace и sans-serif).
  const probe = document.createElement('span');
  probe.textContent = 'mmmmmmmmmmlli0123456789';
  probe.style.cssText = 'position:absolute;left:-9999px;font-size:48px;white-space:nowrap';
  document.body.append(probe);
  const width = (family) => { probe.style.fontFamily = family; return probe.getBoundingClientRect().width; };
  const base = { mono: width('monospace'), sans: width('sans-serif') };
  const have = fonts.filter((f) => width(`"${f}", monospace`) !== base.mono || width(`"${f}", sans-serif`) !== base.sans);
  probe.remove();
  const uad = navigator.userAgentData;
  const n = navigator;
  return {
    webdriver: out.dataset.webdriver === 'true' || n.webdriver === true,
    cdpLeak: out.dataset.cdp === 'true',
    chrome: out.dataset.chrome === 'true',
    userAgent: n.userAgent,
    uaData: uad ? { brands: uad.brands.map((b) => b.brand), mobile: uad.mobile, platform: uad.platform } : null,
    platform: n.platform,
    languages: [...n.languages],
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    tzOffsetMin: new Date().getTimezoneOffset(),
    screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth, dpr: devicePixelRatio },
    window: { innerWidth, innerHeight, outerWidth, outerHeight },
    hardwareConcurrency: n.hardwareConcurrency,
    deviceMemory: n.deviceMemory,
    plugins: n.plugins.length,
    pdfViewer: n.pdfViewerEnabled,
    notification: typeof Notification === 'undefined' ? null : Notification.permission,
    webgl: gl,
    maxTouchPoints: n.maxTouchPoints,
    hasFocus: document.hasFocus(),
    visibility: document.visibilityState,
    fonts: have,
    cookies: n.cookieEnabled,
    doNotTrack: n.doNotTrack,
  };
}

/** Факты страницы: page открывает origin (локальная страница проверки) и собирает всё. */
async function collect(page, origin) {
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForSelector('#out[data-ready="1"]', { state: 'attached', timeout: 5000 }); // пустой <pre> невидим, но нам нужны лишь его атрибуты
  const facts = await page.evaluate(inPage, FONTS);
  facts.notificationQuery = await page.evaluate(() => (navigator.permissions ? navigator.permissions.query({ name: 'notifications' }).then((p) => p.state).catch(() => null) : null));
  return facts;
}

/** Оценка фактов: [{ level: 'red'|'yellow'|'info', key, text }]. Чистая функция. */
function judge(f, { tz } = {}) {
  const out = [];
  const red = (key, text) => out.push({ level: 'red', key, text });
  const yellow = (key, text) => out.push({ level: 'yellow', key, text });
  const info = (key, text) => out.push({ level: 'info', key, text });

  if (f.webdriver) red('webdriver', 'navigator.webdriver = true: браузер запущен с --enable-automation, так выглядит Selenium');
  if (/headless/i.test(f.userAgent || '') || (f.uaData && f.uaData.brands.some((b) => /headless/i.test(b)))) red('headless', 'в User-Agent или brands есть «Headless»');
  if (f.cdpLeak) red('cdp', 'след Runtime.enable: страница видит, что к ней подключён DevTools (getter у Error.stack сработал при console.debug)');
  if (!f.chrome) red('chrome', 'нет window.chrome: у Chromium с интерфейсом он есть всегда');
  if (f.plugins === 0) red('plugins', 'navigator.plugins пуст: у настольного Chromium пять плагинов PDF, пусто бывает в headless');
  if (!f.languages || !f.languages.length) red('languages', 'navigator.languages пуст');
  if (f.notification === 'denied' && f.notificationQuery === 'prompt') red('notification', 'Notification.permission «denied», а permissions.query говорит «prompt»: известная несостыковка headless');

  if (!f.webgl) yellow('webgl', 'WebGL недоступен: у людей на настольных системах он есть почти всегда (в контейнере так делают --disable-gpu и --disable-software-rasterizer)');
  else if (/swiftshader|llvmpipe|softpipe|software/i.test(`${f.webgl.vendor} ${f.webgl.renderer}`)) yellow('webgl', `WebGL программный (${f.webgl.renderer}): так выглядят виртуальные машины и контейнеры, у людей обычно видеокарта («Mesa» в строке настоящей видеокарты на Linux — норма)`);
  else info('webgl', `WebGL: ${f.webgl.vendor} / ${f.webgl.renderer}`);
  if (f.notification === 'denied' && f.notificationQuery !== 'prompt') yellow('notification', 'уведомления запрещены для всех сайтов (политика DefaultNotificationsSetting): у людей обычно «default»');
  if (Number.isFinite(f.hardwareConcurrency) && f.hardwareConcurrency < 2) yellow('cpu', `hardwareConcurrency = ${f.hardwareConcurrency}: одно ядро — редкость`);
  if (Number.isFinite(f.deviceMemory) && f.deviceMemory < 2) yellow('memory', `deviceMemory = ${f.deviceMemory} ГБ: слишком мало для настольного компьютера`);
  if (f.screen && (f.screen.width < 1024 || f.screen.height < 700)) yellow('screen', `экран ${f.screen.width}×${f.screen.height}: меньше любого современного настольного`);
  if (f.window && f.window.outerHeight > 0 && f.window.outerHeight - f.window.innerHeight === 0 && !(f.uaData && f.uaData.mobile)) yellow('frame', 'outerHeight равен innerHeight: у окна нет рамки браузера (киоск или headless)');
  if (f.window && f.screen && f.window.outerWidth > f.screen.width + 1) yellow('window', `окно шире экрана (${f.window.outerWidth} > ${f.screen.width}): так бывает только в headless`);
  if (f.fonts && f.fonts.length < 4) yellow('fonts', `из ${FONTS.length} обычных шрифтов найдено ${f.fonts.length} (${f.fonts.join(', ') || 'ни одного'}): набор шрифтов как у сервера, а не у человека`);
  if (tz && f.timeZone && f.timeZone !== tz) yellow('tz', `часовой пояс браузера ${f.timeZone}, а ожидается ${tz} (пояс страны выхода)`);
  if (f.hasFocus === false) info('focus', 'document.hasFocus() = false: окно без фокуса (в зеркале хозяин может смотреть в другое окно; детекторы на это смотрят редко)');

  info('ua', f.userAgent || '');
  info('platform', `${f.platform}${f.uaData ? ` (${f.uaData.brands.join(', ')}, ${f.uaData.platform})` : ''}`);
  info('languages', (f.languages || []).join(', '));
  info('tz', `${f.timeZone} (UTC${f.tzOffsetMin <= 0 ? '+' : '-'}${Math.abs(f.tzOffsetMin) / 60})`);
  if (f.screen && f.window) info('size', `экран ${f.screen.width}×${f.screen.height}, окно ${f.window.outerWidth}×${f.window.outerHeight}, страница ${f.window.innerWidth}×${f.window.innerHeight}, dpr ${f.screen.dpr}`);
  info('hw', `ядер ${f.hardwareConcurrency}, память ${f.deviceMemory ?? '?'} ГБ, касаний ${f.maxTouchPoints}, плагинов ${f.plugins}`);
  if (f.fonts) info('fonts', `шрифты: ${f.fonts.join(', ') || 'ни одного из списка'}`);
  return out;
}

const LABEL = { red: 'КРАСНЫЙ', yellow: 'ЖЁЛТЫЙ', info: '      ' };
const format = (verdicts) => verdicts.map((v) => `${LABEL[v.level]}  ${v.key.padEnd(12)} ${v.text}`).join('\n');

function parseArgs(argv, env = process.env) {
  const opts = { cdp: env.MEATSUIT_CDP || 'http://127.0.0.1:9222', tz: env.MEATSUIT_TZ || null, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') opts.json = true;
    else if (argv[i] === '--cdp' || argv[i] === '--tz') opts[argv[i].slice(2)] = argv[++i];
    else throw new Error(`неизвестный аргумент «${argv[i]}» (см. начало selfcheck.js)`);
  }
  return opts;
}

/** Локальная страница проверки на свободном порту; браузер должен видеть 127.0.0.1 этого процесса (в Docker — общая сеть с neko). */
function servePage() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(CHECK_PAGE); });
    server.listen(0, '127.0.0.1', () => resolve({ origin: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(r)) }));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let chromium;
  try { ({ chromium } = require('patchright')); } catch { throw new Error('не установлен patchright: выполните npm install'); }
  const site = await servePage();
  const browser = await chromium.connectOverCDP(opts.cdp);
  let page = null;
  try {
    const context = browser.contexts()[0] || await browser.newContext();
    page = await windowOpener(browser, context)();
    const facts = await collect(page, site.origin);
    const verdicts = judge(facts, { tz: opts.tz });
    if (opts.json) console.log(JSON.stringify({ facts, verdicts }, null, 2));
    else {
      console.log(format(verdicts));
      const reds = verdicts.filter((v) => v.level === 'red').length, yellows = verdicts.filter((v) => v.level === 'yellow').length;
      console.log(`\nИтог: красных ${reds}, жёлтых ${yellows}. Красное — так у людей не бывает; жёлтое — редко, и в сумме выдаёт. Что с этим делать: docs/stealth.md`);
    }
    process.exitCode = verdicts.some((v) => v.level === 'red') ? 1 : 0;
  } finally {
    if (page) await page.close().catch(() => {});
    await browser.close().catch(() => {}); // только отключает нас, браузер живёт
    await site.close();
  }
}

if (require.main === module) main().catch((err) => { console.error(`Ошибка: ${err.message}`); process.exit(1); });

module.exports = { collect, judge, format, parseArgs, CHECK_PAGE, FONTS, servePage };
