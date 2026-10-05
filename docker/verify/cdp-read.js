// Что на самом деле делает Brave (по CDP): адрес и положение прокрутки каждой вкладки; cookie проверяемого сайта.
const { chromium } = require('patchright');
(async () => {
  const browser = await chromium.connectOverCDP(process.env.MEATSUIT_CDP || 'http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  if (process.argv[2] === 'set-cookie') await ctx.addCookies([{ name: 'meatsuit_verify', value: String(Date.now()), domain: 'example.com', path: '/', expires: Math.floor(Date.now() / 1000) + 86400, secure: true, sameSite: 'Lax' }]);
  const out = { tabs: [], cookie: null };
  for (const p of ctx.pages()) out.tabs.push({ url: p.url(), scrollY: await p.evaluate(() => Math.round(scrollY)).catch(() => null) });
  const c = (await ctx.cookies('https://example.com')).find((x) => x.name === 'meatsuit_verify');
  out.cookie = c ? c.value : null;
  console.log(JSON.stringify(out));
  await browser.close();
})().catch((e) => { console.error('СБОЙ', e.message); process.exit(1); });
