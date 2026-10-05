/**
 * Очередь: одна задача за раз, ticket и position, ожидание до wait, простой
 * закрывает задачу сам. Часы и таймеры подставляются, поэтому тесты мгновенны.
 *
 *   node --test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createQueue } = require('../queue.js');

const MIN = 60000;

/** Виртуальные часы: таймеры срабатывают по порядку, пока время идёт вперёд. */
function fakeClock(start = 1000000) {
  let t = start;
  let seq = 0;
  const timers = new Set();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms, id: ++seq }; timers.add(h); return h; },
    clearTimer: (h) => { timers.delete(h); },
    async tick(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...timers].filter((h) => h.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!next) break;
        timers.delete(next);
        t = next.at;
        next.fn();
        await new Promise((r) => setImmediate(r)); // дать отработать цепочкам промисов
      }
      t = end;
      await new Promise((r) => setImmediate(r));
    },
    pending: () => timers.size,
  };
}

function setup(opts = {}) {
  const clock = fakeClock();
  const expired = [];
  const q = createQueue({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    idleMs: 5 * MIN, ticketTtlMs: MIN,
    onExpire: (task) => { expired.push(task.id); },
    ...opts,
  });
  return { q, clock, expired };
}

test('свободная очередь: задача стартует сразу, ticket не нужен', async () => {
  const { q } = setup();
  const r = await q.acquire({ owner: 'cvs', waitMs: 0 });
  assert.equal(r.granted, true);
  assert.match(r.task.id, /^t\d+$/);
  assert.equal(r.task.owner, 'cvs');
  assert.equal(r.ticket, undefined);
  assert.equal(q.get(r.task.id, 'cvs'), r.task);
});

test('одна задача за раз: второй получает ticket и position, а не слот', async () => {
  const { q } = setup();
  await q.acquire({ owner: 'cvs', waitMs: 0 });
  const b = await q.acquire({ owner: 'tinder', waitMs: 0 });
  assert.equal(b.granted, false);
  assert.match(b.ticket, /^k\d+$/);
  assert.equal(b.position, 1);
  const c = await q.acquire({ owner: 'cvs', waitMs: 0 });
  assert.equal(c.position, 2);
  assert.notEqual(c.ticket, b.ticket);
});

test('ждёт слот до wait: освободился — ждущий получает задачу без повторного запроса', async () => {
  const { q } = setup();
  const a = await q.acquire({ owner: 'cvs', waitMs: 0 });
  const pending = q.acquire({ owner: 'tinder', waitMs: 60000 });
  let done = false;
  pending.then(() => { done = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false);
  assert.equal(q.release(a.task.id), true);
  const b = await pending;
  assert.equal(b.granted, true);
  assert.equal(b.task.owner, 'tinder');
  assert.notEqual(b.task.id, a.task.id);
});

test('не дождался за wait: отвечает ticket и position, место остаётся', async () => {
  const { q, clock } = setup();
  await q.acquire({ owner: 'cvs', waitMs: 0 });
  const pending = q.acquire({ owner: 'tinder', waitMs: 60000 });
  await clock.tick(59000);
  let early = false;
  pending.then(() => { early = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(early, false);
  await clock.tick(1000);
  const r = await pending;
  assert.deepEqual([r.granted, r.position], [false, 1]);
  assert.match(r.ticket, /^k\d+$/);
});

test('повторный запрос с ticket сохраняет место: пришедший позже не обгоняет', async () => {
  const { q } = setup();
  const a = await q.acquire({ owner: 'cvs', waitMs: 0 });
  const first = await q.acquire({ owner: 'tinder', waitMs: 0 });
  const later = await q.acquire({ owner: 'cvs', waitMs: 0 });
  assert.equal(later.position, 2);
  const again = await q.acquire({ owner: 'tinder', ticket: first.ticket, waitMs: 0 });
  assert.deepEqual([again.granted, again.ticket, again.position], [false, first.ticket, 1]);
  q.release(a.task.id);
  // слот придержан за головой очереди: пришедший позже его не получает
  const late = await q.acquire({ owner: 'cvs', ticket: later.ticket, waitMs: 0 });
  assert.equal(late.granted, false);
  const head = await q.acquire({ owner: 'tinder', ticket: first.ticket, waitMs: 0 });
  assert.equal(head.granted, true);
});

test('ticket чужого клиента не работает: выдаётся новый и в конец', async () => {
  const { q } = setup();
  await q.acquire({ owner: 'cvs', waitMs: 0 });
  const mine = await q.acquire({ owner: 'tinder', waitMs: 0 });
  const stolen = await q.acquire({ owner: 'cvs', ticket: mine.ticket, waitMs: 0 });
  assert.notEqual(stolen.ticket, mine.ticket);
  assert.equal(stolen.position, 2);
});

test('голова очереди без повтора держит слот до конца ttl, потом очередь идёт дальше', async () => {
  const { q, clock } = setup();
  const a = await q.acquire({ owner: 'cvs', waitMs: 0 });
  const gone = await q.acquire({ owner: 'tinder', waitMs: 0 }); // получил ticket и ушёл
  const waiting = q.acquire({ owner: 'cvs', waitMs: 10 * MIN });
  let granted = false;
  waiting.then((r) => { granted = r.granted; });
  q.release(a.task.id);
  await clock.tick(MIN - 1);
  assert.equal(granted, false, 'слот ещё держится за ушедшего');
  await clock.tick(1);
  await waiting;
  assert.equal(granted, true);
  const back = await q.acquire({ owner: 'tinder', ticket: gone.ticket, waitMs: 0 });
  assert.equal(back.granted, false);
  assert.notEqual(back.ticket, gone.ticket, 'старый ticket пропал');
});

test('ждущий оборвал соединение (signal): слот ему без повтора не отдаётся', async () => {
  const { q } = setup();
  const a = await q.acquire({ owner: 'cvs', waitMs: 0 });
  const ac = new AbortController();
  const pending = q.acquire({ owner: 'tinder', waitMs: 60000, signal: ac.signal });
  ac.abort();
  const r = await pending;
  assert.deepEqual([r.granted, r.position], [false, 1]);
  q.release(a.task.id);
  assert.equal(q.active(), null, 'слот придержан, но не занят');
  const again = await q.acquire({ owner: 'tinder', ticket: r.ticket, waitMs: 0 });
  assert.equal(again.granted, true);
});

test('простой дольше idle закрывает задачу сам: onExpire, слот свободен', async () => {
  const { q, clock, expired } = setup();
  const a = await q.acquire({ owner: 'cvs', waitMs: 0 });
  const next = q.acquire({ owner: 'tinder', waitMs: 10 * MIN });
  await clock.tick(5 * MIN - 1);
  assert.deepEqual(expired, []);
  assert.ok(q.get(a.task.id, 'cvs'));
  await clock.tick(1);
  assert.deepEqual(expired, [a.task.id]);
  assert.equal(q.get(a.task.id, 'cvs'), null);
  assert.equal(q.why(a.task.id, 'cvs'), 'idle');
  const b = await next;
  assert.equal(b.granted, true, 'очередь не повисла');
});

test('onExpire отрабатывает до того, как слот достанется следующему', async () => {
  let finishClose;
  const closing = new Promise((r) => { finishClose = r; });
  const { q, clock } = setup({ onExpire: () => closing });
  await q.acquire({ owner: 'cvs', waitMs: 0 });
  const next = q.acquire({ owner: 'tinder', waitMs: 10 * MIN });
  let granted = false;
  next.then((r) => { granted = r.granted; });
  await clock.tick(5 * MIN);
  assert.equal(granted, false, 'окно ещё закрывается');
  finishClose();
  await next;
  assert.equal(granted, true);
});

test('touch отодвигает срок простоя', async () => {
  const { q, clock, expired } = setup();
  const a = await q.acquire({ owner: 'cvs', waitMs: 0 });
  await clock.tick(4 * MIN);
  assert.equal(q.touch(a.task.id), true);
  await clock.tick(4 * MIN);
  assert.deepEqual(expired, []);
  await clock.tick(MIN);
  assert.deepEqual(expired, [a.task.id]);
  assert.equal(q.touch(a.task.id), false, 'закрытую не оживить');
});

test('пока действие идёт (hold), задача не простаивает; срок считается от его конца', async () => {
  const { q, clock, expired } = setup();
  const a = await q.acquire({ owner: 'cvs', waitMs: 0 });
  const done = q.hold(a.task.id);
  await clock.tick(30 * MIN); // печатает длинное письмо дольше idle
  assert.deepEqual(expired, []);
  done();
  done(); // повторный вызов безвреден
  await clock.tick(5 * MIN - 1);
  assert.deepEqual(expired, []);
  await clock.tick(1);
  assert.deepEqual(expired, [a.task.id]);
});

test('touch с idleMs даёт этой задаче свой срок (человек решает капчу), null возвращает обычный', async () => {
  const { q, clock, expired } = setup();
  const a = await q.acquire({ owner: 'cvs', waitMs: 0 });
  q.touch(a.task.id, { idleMs: 30 * MIN });
  await clock.tick(29 * MIN);
  assert.deepEqual(expired, []);
  q.touch(a.task.id, { idleMs: null });
  await clock.tick(5 * MIN);
  assert.deepEqual(expired, [a.task.id]);
});

test('release: закрывает один раз, чужую и неизвестную не трогает, причина запоминается', async () => {
  const { q } = setup();
  const a = await q.acquire({ owner: 'cvs', waitMs: 0 });
  assert.equal(q.release('t999'), false);
  assert.equal(q.get(a.task.id, 'tinder'), null, 'чужая задача невидима');
  assert.equal(q.release(a.task.id, 'egress'), true);
  assert.equal(q.release(a.task.id), false);
  assert.equal(q.why(a.task.id, 'cvs'), 'egress');
  assert.equal(q.why(a.task.id, 'tinder'), null);
  assert.equal(q.why('t999', 'cvs'), null);
});

test('после release таймер простоя снят: ничего не истекает задним числом', async () => {
  const { q, clock, expired } = setup();
  const a = await q.acquire({ owner: 'cvs', waitMs: 0 });
  q.release(a.task.id);
  await clock.tick(10 * MIN);
  assert.deepEqual(expired, []);
  assert.equal(clock.pending(), 0);
});

test('snapshot: кто работает и кто стоит, без ticket', async () => {
  const { q, clock } = setup();
  const a = await q.acquire({ owner: 'cvs', waitMs: 0, info: { task: 'cvs:hh', site: 'hh.kz' } });
  await q.acquire({ owner: 'tinder', waitMs: 0, info: { task: 'tinder:like', site: 'tinder.com' } });
  await clock.tick(30000);
  const s = q.snapshot();
  assert.deepEqual([s.active.id, s.active.owner, s.active.info], [a.task.id, 'cvs', { task: 'cvs:hh', site: 'hh.kz' }]);
  assert.equal(s.active.idleMs, 30000);
  assert.deepEqual(s.waiting.map((w) => [w.owner, w.position, w.info.site]), [['tinder', 1, 'tinder.com']]);
  assert.ok(!JSON.stringify(s).includes('"k1"'), 'ticket наружу не отдаётся');
});

test('очередь живёт по порядку прихода (FIFO)', async () => {
  const { q } = setup();
  const a = await q.acquire({ owner: 'cvs', waitMs: 0 });
  const order = [];
  const p1 = q.acquire({ owner: 'x', waitMs: 60000 }).then((r) => { order.push('x'); return r; });
  const p2 = q.acquire({ owner: 'y', waitMs: 60000 }).then((r) => { order.push('y'); return r; });
  q.release(a.task.id);
  const r1 = await p1;
  assert.deepEqual(order, ['x']);
  q.release(r1.task.id);
  await p2;
  assert.deepEqual(order, ['x', 'y']);
});
