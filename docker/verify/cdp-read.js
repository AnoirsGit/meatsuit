// Что на самом деле делает браузер (по CDP): адрес и положение прокрутки каждой вкладки; cookie и localStorage
// проверяемого сайта. Режимы: без аргумента — только вкладки и cookie; set — поставить свежие cookie и
// localStorage (одно значение); storage — то же чтение плюс localStorage (открывает и закрывает вкладку example.com).
// Вход на сайты держится и в cookie, и в localStorage (Тиндер хранит токен в localStorage): проверяем оба.
const { chromium } = require('patchright');
(async () => {
  const mode = process.argv[2];
  const stamp = String(Date.now());
  const browser = await chromium.connectOverCDP(process.env.MEATSUIT_CDP || 'http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  if (mode === 'set-cookie' || mode === 'set') await ctx.addCookies([{ name: 'meatsuit_verify', value: stamp, domain: 'example.com', path: '/', expires: Math.floor(Date.now() / 1000) + 86400, secure: true, sameSite: 'Lax' }]);
  const out = { tabs: [], cookie: null, storage: null };
  if (mode === 'set' || mode === 'storage') {
    const page = await ctx.newPage();
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (mode === 'set') await page.evaluate((v) => localStorage.setItem('meatsuit_verify', v), stamp);
    out.storage = await page.evaluate(() => localStorage.getItem('meatsuit_verify'));
    await page.close();
  }
  for (const p of ctx.pages()) out.tabs.push({ url: p.url(), scrollY: await p.evaluate(() => Math.round(scrollY)).catch(() => null) });
  const c = (await ctx.cookies('https://example.com')).find((x) => x.name === 'meatsuit_verify');
  out.cookie = c ? c.value : null;
  console.log(JSON.stringify(out));
  await browser.close();
})().catch((e) => { console.error('СБОЙ', e.message); process.exit(1); });
