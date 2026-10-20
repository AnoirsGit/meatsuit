/**
 * Своё окно (window.js) для прогрева: life.connect() открывает страницу в новом окне, а не
 * вкладкой в окне хозяина, и повторяет его размеры. Настоящий Chromium; без него тесты пропускаются.
 *
 *   NODE_PATH=…/node_modules node --test test/window.test.js
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const chromium = require('../testkit/browser-chromium.js');
const { connect } = require('../life.js');

const skip = chromium.unavailable();
let browser;

before(async () => { if (!skip) browser = await chromium.launch(); });
after(async () => { if (!skip) await browser.stop(); });

test('life.connect: страница прогрева в своём окне размером с окно хозяина; close отключает нас, а браузер и окно хозяина живы', { skip }, async () => {
  const before = await chromium.windows(browser.cdpUrl);
  assert.equal(before.length, 1, 'в свежем браузере одно окно хозяина');
  const owner = await chromium.connect(browser.cdpUrl);
  const bcdp = await owner.browser.newBrowserCDPSession();
  const { windowId } = await bcdp.send('Browser.getWindowForTarget', { targetId: before[0].targetId });
  await bcdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: 960, height: 640, windowState: 'normal' } });

  const link = await connect(browser.cdpUrl);
  const page = await link.openPage();
  const now = await chromium.windows(browser.cdpUrl);
  const fresh = now.filter((t) => !before.some((b) => b.targetId === t.targetId));
  assert.equal(fresh.length, 1);
  assert.notEqual(fresh[0].windowId, before[0].windowId, 'страница прогрева открылась вкладкой в окне хозяина');
  assert.deepEqual(await page.evaluate(() => [innerWidth, outerHeight]), [960, 640], 'окно прогрева не повторило размеры окна хозяина');

  await page.close();
  await link.close();
  const end = await chromium.windows(browser.cdpUrl);
  assert.deepEqual(end.map((t) => t.targetId), [before[0].targetId], 'после закрытия должно остаться только окно хозяина');
  await owner.browser.close().catch(() => {});
});
