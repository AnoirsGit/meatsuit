/**
 * Отдельное окно браузера для задачи: мои вкладки бот не трогает.
 * Своё окно находим по targetId, а не «первая появившаяся страница»: если я в этот момент
 * открою вкладку, бот не должен начать водить по ней.
 */
async function openWindow(browser) {
  const ctx = browser.contexts()[0];
  const session = await browser.newBrowserCDPSession();
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('окно задачи не открылось')), 10000);
      let targetId = null;
      const early = []; // страницы, появившиеся раньше, чем пришёл targetId
      const tryMatch = async (p) => {
        if (!targetId) return early.push(p);
        const s = await ctx.newCDPSession(p);
        const { targetInfo } = await s.send('Target.getTargetInfo');
        await s.detach().catch(() => {});
        if (targetInfo.targetId === targetId) { clearTimeout(timer); ctx.off('page', tryMatch); resolve(p); }
      };
      ctx.on('page', tryMatch);
      session.send('Target.createTarget', { url: 'about:blank', newWindow: true }).then(async (r) => {
        targetId = r.targetId;
        for (const p of early.splice(0)) await tryMatch(p);
      }, reject);
    });
  } finally {
    await session.detach().catch(() => {});
  }
}

module.exports = { openWindow };
