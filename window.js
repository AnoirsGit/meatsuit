/**
 * Отдельное окно браузера для задачи: мои вкладки бот не трогает.
 * Своё окно находим по targetId, а не «первая появившаяся страница»: если я в этот момент
 * открою вкладку, бот не должен начать водить по ней.
 *
 * Чужая вкладка может закрыться, пока мы спрашиваем её targetId (всплывающее окно входа, вкладка человека
 * в зеркале): такую пропускаем. Раньше отказ промиса в обработчике события никто не ловил — Node ронял процесс
 * вызывающего, а страницы, пришедшие следом, оставались непроверенными. Окно, которое так и не нашлось за
 * timeoutMs, закрывается, слушатель снимается.
 */
async function openWindow(browser, { timeoutMs = 10000 } = {}) {
  const ctx = browser.contexts()[0];
  const session = await browser.newBrowserCDPSession();
  let onPage;
  let targetId = null;
  try {
    return await new Promise((resolve, reject) => {
      let done = false;
      const early = []; // страницы, появившиеся раньше, чем пришёл targetId
      const finish = (err, page) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        ctx.off('page', onPage);
        if (err) reject(err); else resolve(page);
      };
      const timer = setTimeout(() => finish(new Error('окно задачи не открылось')), timeoutMs);
      // Не бросает никогда: страница, которую не удалось спросить, — не наша.
      const tryMatch = async (p) => {
        if (done) return;
        if (!targetId) { early.push(p); return; }
        let id = null;
        try {
          const s = await ctx.newCDPSession(p);
          try { ({ targetInfo: { targetId: id } } = await s.send('Target.getTargetInfo')); }
          finally { await s.detach().catch(() => {}); }
        } catch { return; }
        if (id === targetId) finish(null, p);
      };
      onPage = (p) => { tryMatch(p); };
      ctx.on('page', onPage);
      session.send('Target.createTarget', { url: 'about:blank', newWindow: true }).then((r) => {
        targetId = r.targetId;
        for (const p of early.splice(0)) tryMatch(p);
      }, (e) => finish(e));
    });
  } catch (err) {
    // Окно создано, но Playwright его так и не показал: не оставлять пустое окно в браузере человека.
    if (targetId) await session.send('Target.closeTarget', { targetId }).catch(() => {});
    throw err;
  } finally {
    await session.detach().catch(() => {});
  }
}

module.exports = { openWindow };
