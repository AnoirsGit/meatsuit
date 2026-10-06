/**
 * Руки: закрытый набор команд по номерам из снимка глаз (eyes.js).
 *
 *   const h = hands(page, { dryRun, logFile, recordDir, allowedHosts });
 *   const snap = await h.see();
 *   const res  = await h.act({ cmd: 'click', id: 7, gen: snap.gen }); // diff снимка после действия
 *
 * Всё идёт через human.js: ни одна команда не умеет «быстро». Произвольный JS
 * не выполняется, goto — только на разрешённые хосты.
 */
const fs = require('node:fs');
const path = require('node:path');
const human = require('./human.js');
const eyes = require('./eyes.js');
const dom = require('./dom.js');

class BadCommand extends Error {}
class StaleElement extends Error {}

const MAX_TEXT = 1000;
const MAX_WAIT = 15000;
const KEYS = new Set(['Enter', 'Escape', 'Tab', 'Backspace', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp']);

const isId = (v) => Number.isInteger(v) && v > 0;
const isGen = (v) => Number.isInteger(v) && v > 0;
// Перевод строки в поле нажал бы Enter и отправил полсообщения, поэтому текст однострочный.
const isText = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_TEXT && !/[\r\n]/.test(v);

/** Проверка команды до выполнения. Бросает BadCommand. Чистая функция. */
function validate(c, allowedHosts = []) {
  const bad = (m) => { throw new BadCommand(`${c && c.cmd}: ${m}`); };
  if (!c || typeof c !== 'object') throw new BadCommand('команда не объект');
  switch (c.cmd) {
    case 'click': if (!isId(c.id) || !isGen(c.gen)) bad('нужны id и gen из снимка'); break;
    case 'fill': if (!isId(c.id) || !isGen(c.gen)) bad('нужны id и gen из снимка'); if (!isText(c.text)) bad('нужен text до ' + MAX_TEXT); break;
    case 'type': if (!isText(c.text)) bad('нужен text до ' + MAX_TEXT); break;
    case 'press': if (!KEYS.has(c.key)) bad('клавиша не из списка'); break;
    case 'scroll': if (!(c.px === undefined || (Number.isFinite(c.px) && c.px >= 0 && c.px <= 5000))) bad('px от 0 до 5000, только вниз'); break;
    case 'wait':
      if (!(Number.isFinite(c.ms) && c.ms >= 0 && c.ms <= MAX_WAIT) && !isText(c.text)) bad(`нужен ms до ${MAX_WAIT} или text`);
      break;
    case 'back': break;
    case 'goto': {
      let u;
      try { u = new URL(c.url); } catch { bad('некорректный url'); }
      if (u.protocol !== 'https:') bad('только https');
      const host = u.hostname;
      if (!allowedHosts.some((h) => host === h || host.endsWith('.' + h))) bad(`хост ${host} не разрешён`);
      break;
    }
    default: throw new BadCommand(`неизвестная команда: ${c.cmd}`);
  }
  return c;
}

function hands(page, opts = {}) {
  const { dryRun = false, logFile, recordDir, allowedHosts = [] } = opts;
  let last = null;
  let world = null; // изолированный мир, где лежат элементы последнего снимка
  let seq = 0;
  let gens = 0; // поколения снимков: монотонно за всё время жизни hands
  let chain = Promise.resolve(); // команды и снимки идут строго по очереди

  const log = (entry) => {
    if (logFile) fs.appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), dryRun, ...entry }) + '\n');
  };

  const record = (cmd, snapshot) => {
    if (!recordDir) return;
    fs.mkdirSync(recordDir, { recursive: true });
    const name = String(seq++).padStart(4, '0') + '.json';
    fs.writeFileSync(path.join(recordDir, name), JSON.stringify({ cmd, snapshot }));
  };

  // Клик с переходом рвёт контекст страницы посреди снимка: ждём загрузку и повторяем.
  const look = async (o) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const seen = await eyes.observe(page, { ...o, gen: ++gens });
        last = seen.snap;
        world = seen.world;
        return seen.snap;
      } catch (err) {
        if (attempt >= 3 || !/context was destroyed|navigat/i.test(err.message)) throw err;
        await page.waitForLoadState('domcontentloaded').catch(() => {});
      }
    }
  };

  const serial = (fn) => (...args) => {
    const p = chain.then(() => fn(...args));
    chain = p.catch(() => {});
    return p;
  };

  const target = async (id, gen) => {
    if (!last) throw new StaleElement('сначала see()');
    if (gen !== last.gen) throw new StaleElement(`снимок ${gen} устарел, текущий ${last.gen}`);
    const el = dom.handle(world, id);
    try {
      // Узел тот же, но мог получить другое содержимое (список с ключом-индексом): сверяем с моментом снимка.
      if (!(await el.same())) throw new StaleElement(`элемент ${id} изменился или исчез после снимка`);
    } catch (err) {
      if (err instanceof dom.StaleWorld) throw new StaleElement(`снимок ${gen} уже не актуален`);
      throw err;
    }
    return el;
  };

  const run = async (c) => {
    switch (c.cmd) {
      case 'click': return human.click(page, await target(c.id, c.gen));
      case 'fill': {
        const loc = await target(c.id, c.gen);
        await human.click(page, loc);
        await human.pause(150, 500);
        await page.keyboard.press('ControlOrMeta+A');
        await page.keyboard.press('Backspace');
        return human.type(page, c.text);
      }
      case 'type': return human.type(page, c.text);
      case 'press': await human.pause(150, 600); return page.keyboard.press(c.key);
      case 'scroll': return human.scroll(page, c.px);
      case 'wait':
        if (c.text) return page.getByText(c.text).first().waitFor({ state: 'visible', timeout: MAX_WAIT });
        return human.sleep(c.ms);
      case 'back': await human.pause(); return page.goBack({ waitUntil: 'domcontentloaded' });
      case 'goto': await human.pause(); return page.goto(new URL(c.url).href, { waitUntil: 'domcontentloaded' });
    }
  };

  /** Глаза. Запоминает снимок: по его номерам работают руки. */
  const see = serial(async (o) => {
    const { since, ...rest } = o || {};
    const snap = await look(rest);
    if (seq === 0) record(null, snap); // запись начинается с первого снимка
    return since ? eyes.diff(since, snap) : snap;
  });

  /** Выполнить команду и вернуть, что изменилось на странице. */
  const act = serial(async (c) => {
    validate(c, allowedHosts);
    const url = page.url();
    if (dryRun && c.cmd !== 'goto') { // навигация только читает страницу: без неё dryRun остаётся на about:blank и видеть нечего
      log({ cmd: c, url, result: 'dry-run' });
      return { dryRun: true, changed: false };
    }
    if (!last) { // act без see(): сравнивать не с чем
      await look();
      if (seq === 0) record(null, last);
    }
    const before = last;
    try {
      await run(c);
      await human.pause(250, 500); // дать клику начать переход
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      const snap = await look();
      record(c, snap);
      log({ cmd: c, url, result: 'ok', urlAfter: snap.url });
      return eyes.diff(before, snap);
    } catch (e) {
      const err = e instanceof dom.StaleWorld ? new StaleElement('страница сменилась посреди команды') : e;
      log({ cmd: c, url, error: err.message });
      throw err;
    }
  });

  return { see, act };
}

/**
 * Воспроизведение записи (recordDir): тот же интерфейс see/act без браузера.
 * Команды проверяются как настоящие (включая gen); каждая act двигает запись на один снимок.
 */
function replay(dir, opts = {}) {
  const snaps = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).snapshot);
  if (!snaps.length) throw new Error(`в ${dir} нет записи`);
  let i = 0;
  return {
    async see(o) { return o && o.since ? eyes.diff(o.since, snaps[i]) : snaps[i]; },
    async act(c) {
      validate(c, opts.allowedHosts);
      if (c.id !== undefined && (c.gen !== snaps[i].gen || !snaps[i].elements.some((e) => e.id === c.id))) {
        throw new StaleElement(`элемента ${c.id} нет в снимке ${i}`);
      }
      if (i + 1 >= snaps.length) throw new Error('запись закончилась');
      const prev = snaps[i];
      i += 1;
      return eyes.diff(prev, snaps[i]);
    },
  };
}

module.exports = { hands, replay, validate, BadCommand, StaleElement };
