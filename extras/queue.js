/**
 * Очередь задач: браузер один, поэтому идёт одна задача, остальные стоят по
 * порядку прихода. Чистая логика: часы и таймеры приходят аргументами.
 *
 * Ожидающий получает ticket и место. Повторный acquire с ticket место сохраняет.
 * Голова очереди, ушедшая без повтора, держит слот до конца ttl, потом очередь
 * идёт дальше. Задача, которой не касались дольше idle, закрывается сама
 * (onExpire), чтобы упавший бот не вешал очередь.
 */
const MIN = 60000;

function createQueue({
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  idleMs = 5 * MIN, ticketTtlMs = MIN, onExpire,
} = {}) {
  let active = null;
  let waiting = [];
  let wake = null;
  let tickets = 0, tasks = 0;
  const ended = new Map(); // id → { owner, reason }: чтобы отличить «истекла» от «такой не было»
  const listeners = onExpire ? [onExpire] : [];

  /** Ждущий ответ запроса: выдан слот (granted) или время вышло / запрос оборвался. */
  function settle(entry, granted, task) {
    const w = entry.waiter;
    if (!w) return;
    entry.waiter = null;
    clearTimer(w.timer);
    if (w.off) w.off();
    entry.lastSeen = now();
    w.resolve(granted
      ? { granted: true, task }
      : { granted: false, ticket: entry.ticket, position: waiting.indexOf(entry) + 1 });
  }

  /** Ticket без живого запроса дольше ttl пропадает. */
  function prune() {
    waiting = waiting.filter((e) => e.waiter || now() - e.lastSeen < ticketTtlMs);
  }

  function pump() {
    clearTimer(wake);
    wake = null;
    if (active) return;
    prune();
    const head = waiting[0];
    if (!head) return;
    if (head.waiter) {
      waiting.shift();
      grant(head);
    } else { // голова ушла между запросами: слот придержан за ней до конца ttl
      wake = setTimer(pump, Math.max(0, head.lastSeen + ticketTtlMs - now()));
    }
  }

  function grant(entry) {
    const t = now();
    const task = { id: `t${++tasks}`, owner: entry.owner, info: entry.info, data: {}, startedAt: t, lastTouch: t, busy: 0, idleMs: null, timer: null, expired: false };
    active = task;
    armIdle(task);
    settle(entry, true, task);
  }

  function armIdle(task) {
    clearTimer(task.timer);
    task.timer = null;
    if (task.busy > 0) return; // пока идёт действие, простоя нет
    task.timer = setTimer(() => onIdle(task), Math.max(0, task.lastTouch + (task.idleMs ?? idleMs) - now()));
  }

  function onIdle(task) {
    task.timer = null;
    if (active !== task || task.expired || task.busy > 0) return;
    if (task.lastTouch + (task.idleMs ?? idleMs) - now() > 0) return armIdle(task);
    expire(task);
  }

  async function expire(task) {
    task.expired = true;
    for (const fn of listeners) { try { await fn(task); } catch { /* закрытие окна не должно держать очередь */ } }
    finish(task, 'idle');
  }

  function finish(task, reason) {
    if (active !== task) return false;
    clearTimer(task.timer);
    active = null;
    ended.set(task.id, { owner: task.owner, reason });
    if (ended.size > 200) ended.delete(ended.keys().next().value);
    pump();
    return true;
  }

  /**
   * Встать в очередь. Свободно — слот выдаётся сразу. Иначе ждёт до waitMs и отвечает
   * { granted:false, ticket, position }; с этим ticket можно прийти снова.
   * signal: оборвавшийся запрос перестаёт считаться ждущим, место остаётся до ttl.
   */
  function acquire({ ticket, owner, waitMs = 60000, info = {}, signal } = {}) {
    prune();
    let entry = ticket ? waiting.find((e) => e.ticket === ticket && e.owner === owner) : null;
    if (entry) {
      entry.info = info;
      entry.lastSeen = now();
      settle(entry, false); // старый запрос с тем же ticket уступает новому
    } else {
      entry = { ticket: `k${++tickets}`, owner, info, since: now(), lastSeen: now(), waiter: null };
      waiting.push(entry);
    }
    return new Promise((resolve) => {
      entry.waiter = { resolve, timer: null, off: null };
      pump();
      if (!entry.waiter) return; // слот выдан
      const giveUp = () => { settle(entry, false); pump(); };
      if (waitMs <= 0 || (signal && signal.aborted)) return giveUp();
      entry.waiter.timer = setTimer(giveUp, waitMs);
      if (signal) {
        signal.addEventListener('abort', giveUp, { once: true });
        entry.waiter.off = () => signal.removeEventListener('abort', giveUp);
      }
    });
  }

  const get = (id, owner) => (active && active.id === id && !active.expired && (owner === undefined || active.owner === owner) ? active : null);

  /** Обращение к задаче: срок простоя считается заново. idleMs — свой срок для этой задачи (null — обычный). */
  function touch(id, { idleMs: own } = {}) {
    const task = get(id);
    if (!task) return false;
    task.lastTouch = now();
    if (own !== undefined) task.idleMs = own;
    armIdle(task);
    return true;
  }

  /** Действие началось: простоя нет, пока не вызовут вернувшуюся функцию. */
  function hold(id) {
    const task = get(id);
    if (!task) return () => {};
    task.busy++;
    armIdle(task);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      task.busy--;
      if (active === task && !task.expired) { task.lastTouch = now(); armIdle(task); }
    };
  }

  function release(id, reason = 'end') {
    return active && active.id === id ? finish(active, reason) : false;
  }

  function snapshot() {
    prune();
    return {
      active: active && { id: active.id, owner: active.owner, info: active.info, startedAt: active.startedAt, idleMs: now() - active.lastTouch, busy: active.busy > 0 },
      waiting: waiting.map((e, i) => ({ owner: e.owner, info: e.info, position: i + 1, since: e.since })),
    };
  }

  return {
    acquire, get, touch, hold, release, snapshot,
    active: () => (active && !active.expired ? active : null),
    why: (id, owner) => { const r = ended.get(id); return r && (owner === undefined || r.owner === owner) ? r.reason : null; },
    onExpire: (fn) => { listeners.push(fn); },
  };
}

module.exports = { createQueue };
