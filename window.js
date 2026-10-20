/**
 * Своё окно браузера для задачи или прогрева, а не вкладка в окне хозяина.
 *
 * context.newPage() через CDP зовёт Target.createTarget без newWindow: проверено на настоящем
 * Chromium, страница получает тот же windowId, то есть открывается вкладкой в чужом окне
 * (хозяина). Поэтому окно создаётся браузерным сеансом CDP, Target.createTarget {newWindow: true},
 * и страница находится по targetId.
 *
 * Новое окно Chromium открывает со своим размером по умолчанию, не таким, как у окна хозяина.
 * Сайт видит два разных размера окна у «одного человека» в одном браузере, поэтому новому окну
 * ставятся размеры окна хозяина: первого окна браузера (в зеркале Neko оно одно, на весь экран).
 * Другого окна нет — остаётся как есть. Не получилось подогнать — не беда, окно остаётся как есть.
 *
 *   const open = windowOpener(browser, context);   // browser и context из patchright connectOverCDP
 *   const page = await open();                     // страница в новом окне
 */

/** Страница → targetId: так среди страниц контекста находится именно та, что создана нами. */
async function targetIdOf(context, page) {
  const s = await context.newCDPSession(page);
  try { return (await s.send('Target.getTargetInfo')).targetInfo.targetId; } finally { await s.detach().catch(() => {}); }
}

/**
 * Новому окну — размеры окна хозяина: первой страницы контекста, которая лежит в другом окне.
 * Развёрнутое окно копируется состоянием (с ним CDP размеры не принимает). Любой сбой — false, работе не мешает.
 */
async function fitToOwner(bcdp, context, page, targetId) {
  try {
    const { windowId } = await bcdp.send('Browser.getWindowForTarget', { targetId });
    for (const other of context.pages()) {
      if (other === page || other.isClosed()) continue;
      const otherTarget = await targetIdOf(context, other).catch(() => null);
      if (!otherTarget) continue;
      const { windowId: ownerId } = await bcdp.send('Browser.getWindowForTarget', { targetId: otherTarget });
      if (ownerId === windowId) continue; // вкладка нашего же окна
      const { bounds } = await bcdp.send('Browser.getWindowBounds', { windowId: ownerId });
      const want = bounds.windowState === 'normal' || !bounds.windowState
        ? { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height, windowState: 'normal' }
        : { windowState: bounds.windowState };
      await bcdp.send('Browser.setWindowBounds', { windowId, bounds: want });
      return true;
    }
    return false;
  } catch { return false; }
}

function windowOpener(browser, context, { timeoutMs = 15000 } = {}) {
  let bcdp = null;
  return async function open() {
    bcdp = bcdp || await browser.newBrowserCDPSession();
    let made;
    const known = new Promise((resolve) => { made = resolve; });
    const waiting = context.waitForEvent('page', { timeout: timeoutMs, predicate: async (p) => (await targetIdOf(context, p).catch(() => null)) === await known });
    waiting.catch(() => {}); // если Target.createTarget упадёт, висящее ожидание не должно давать необработанную ошибку
    let targetId;
    try {
      ({ targetId } = await bcdp.send('Target.createTarget', { url: 'about:blank', newWindow: true }));
    } catch (err) {
      made(null);
      throw err;
    }
    made(targetId);
    const page = await waiting;
    await fitToOwner(bcdp, context, page, targetId);
    return page;
  };
}

module.exports = { windowOpener, fitToOwner, targetIdOf };
