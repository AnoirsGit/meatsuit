/**
 * Окно задачи (window.js) на подделках браузера: своё окно находится по targetId, чужая вкладка, закрывшаяся
 * в этот момент (человек в зеркале, всплывающее окно входа), не роняет процесс и не мешает найти своё;
 * окно, которое так и не нашлось, закрывается, слушатель снимается.
 *
 *   node test/window.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { openWindow } = require('../window.js');

/** Подделка: createTarget отдаёт targetId; страницы приходят событием 'page' до и после ответа. */
function fakeBrowser({ before = [], after = [], botAfter = true } = {}) {
  const ctx = new EventEmitter();
  const closed = new Set();
  const calls = [];
  ctx.newCDPSession = async (p) => {
    if (closed.has(p)) throw new Error('browserContext.newCDPSession: Target page, context or browser has been closed');
    return { send: async () => ({ targetInfo: { targetId: p.targetId } }), detach: async () => {} };
  };
  const bot = { targetId: 'BOT' };
  const page = (id, isClosed) => { const p = { targetId: id }; if (isClosed) closed.add(p); return p; };
  const browser = {
    contexts: () => [ctx],
    newBrowserCDPSession: async () => ({
      async send(method, params) {
        calls.push([method, params]);
        if (method !== 'Target.createTarget') return {};
        for (const p of before) ctx.emit('page', page(p.id, p.closed));
        setTimeout(() => {
          for (const p of after) ctx.emit('page', page(p.id, p.closed));
          if (botAfter) ctx.emit('page', bot);
        }, 5);
        return { targetId: 'BOT' };
      },
      async detach() {},
    }),
  };
  return { browser, ctx, bot, calls };
}

const unhandled = [];
process.on('unhandledRejection', (e) => { unhandled.push(e); });
const tick = () => new Promise((r) => setTimeout(r, 30));

test('чужая вкладка закрылась до ответа createTarget: своё окно находится, отказов без обработчика нет', async () => {
  const f = fakeBrowser({ before: [{ id: 'OWNER-POPUP', closed: true }] });
  const p = await openWindow(f.browser);
  await tick();
  assert.equal(p, f.bot);
  assert.deepEqual(unhandled, []);
  assert.equal(f.ctx.listenerCount('page'), 0, 'слушатель page остался');
});

test('чужая вкладка закрылась после ответа: своё окно находится, отказов без обработчика нет', async () => {
  const f = fakeBrowser({ after: [{ id: 'OWNER-TAB', closed: true }] });
  const p = await openWindow(f.browser);
  await tick();
  assert.equal(p, f.bot);
  assert.deepEqual(unhandled, []);
});

test('своя страница пришла раньше ответа вслед за закрытой чужой: не теряется', async () => {
  const f = fakeBrowser({ before: [{ id: 'OWNER-POPUP', closed: true }, { id: 'BOT' }], botAfter: false });
  const p = await openWindow(f.browser);
  assert.equal(p.targetId, 'BOT');
  assert.deepEqual(unhandled, []);
});

test('окно так и не нашлось: ошибка, созданное окно закрыто, слушатель снят', async () => {
  const f = fakeBrowser({ botAfter: false });
  await assert.rejects(openWindow(f.browser, { timeoutMs: 100 }), /окно задачи не открылось/);
  assert.equal(f.ctx.listenerCount('page'), 0, 'слушатель page остался');
  assert.ok(f.calls.some(([m, a]) => m === 'Target.closeTarget' && a.targetId === 'BOT'), 'брошенное окно не закрыто');
});
