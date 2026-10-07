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
const { createCapture } = require('./capture.js');

class BadCommand extends Error {}
class StaleElement extends Error {}

const MAX_TEXT = 1000;
const MAX_WAIT = 15000;
const KEYS = new Set(['Enter', 'Escape', 'Tab', 'Backspace', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp']);

// Копия SELECTOR из collect() в eyes.js: он локален в функции, которая выполняется в странице, и наружу не отдаётся.
// Меняется там — поменять и здесь.
const INTERACTIVE = [
  'a[href]', 'button', 'input:not([type=hidden])', 'textarea', 'select', 'summary',
  '[role=button]', '[role=link]', '[role=tab]', '[role=checkbox]', '[role=radio]',
  '[role=switch]', '[role=menuitem]', '[role=option]', '[role=textbox]', '[contenteditable=""]',
  '[contenteditable=true]',
].join(',');

// Журнал хранит, что сделано и где, но не что набрано: текст и значения — длиной, адреса — без query и hash
// (там бывают токены входа, коды подтверждения и набранный поиск), файл — только типом. Лишние поля команды не пишутся.
const JOURNAL_KEEP = ['cmd', 'id', 'gen', 'key', 'px', 'ms'];
const JOURNAL_LENGTH = ['text', 'value', 'label'];
const journalUrl = (u) => {
  try {
    const x = new URL(u);
    if (x.protocol === 'http:' || x.protocol === 'https:') return x.origin + x.pathname;
    return x.protocol === 'about:' ? x.href.replace(/[?#].*$/, '') : x.protocol; // data: и прочие несут содержимое в адресе
  } catch { return ''; }
};
function journalCmd(c) {
  const out = {};
  for (const k of JOURNAL_KEEP) if (c[k] !== undefined) out[k] = c[k];
  for (const k of JOURNAL_LENGTH) if (typeof c[k] === 'string') out[k + 'Length'] = c[k].length;
  if (typeof c.url === 'string') out.url = journalUrl(c.url);
  if (typeof c.file === 'string') out.fileType = path.extname(c.file).slice(1).toLowerCase();
  return out;
}
// Ошибки Playwright цитируют селектор (а в нём искомый текст) в «Call log» со второй строки: берём первую
// строку и вычищаем из неё текст и адрес команды во всех видах, в каких их печатает Playwright.
function journalError(message, c) {
  let m = String(message).split('\n')[0];
  for (const k of JOURNAL_LENGTH) {
    const v = c[k];
    if (typeof v !== 'string' || !v) continue;
    for (const form of new Set([v, JSON.stringify(v).slice(1, -1), v.replace(/'/g, "\\'"), v.replace(/\r\n?/g, '\n')])) m = m.split(form).join('…');
  }
  if (typeof c.url === 'string' && c.url) m = m.split(c.url).join(journalUrl(c.url));
  return m;
}

const isId = (v) => Number.isInteger(v) && v > 0;
const isGen = (v) => Number.isInteger(v) && v > 0;
// Перевод строки в поле нажал бы Enter и отправил полсообщения, поэтому текст однострочный.
const isText = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_TEXT && !/[\r\n]/.test(v);
// У press и type цель необязательна: поле, которое должно быть в фокусе. Тогда id и gen вместе.
const hasTarget = (c) => c.id !== undefined || c.gen !== undefined;

/** Проверка команды до выполнения. Бросает BadCommand. Чистая функция. */
function validate(c, allowedHosts = []) {
  const bad = (m) => { throw new BadCommand(`${c && c.cmd}: ${m}`); };
  if (!c || typeof c !== 'object') throw new BadCommand('команда не объект');
  const optTarget = () => { if (hasTarget(c) && (!isId(c.id) || !isGen(c.gen))) bad('id и gen из снимка — вместе или ни одного'); };
  switch (c.cmd) {
    case 'click': if (!isId(c.id) || !isGen(c.gen)) bad('нужны id и gen из снимка'); break;
    case 'fill': if (!isId(c.id) || !isGen(c.gen)) bad('нужны id и gen из снимка'); if (!isText(c.text)) bad('нужен text до ' + MAX_TEXT); break;
    case 'type': if (!isText(c.text)) bad('нужен text до ' + MAX_TEXT); optTarget(); break;
    case 'press': if (!KEYS.has(c.key)) bad('клавиша не из списка'); optTarget(); break;
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
  const { dryRun = false, logFile, recordDir, allowedHosts = [], capture, dryRunNavigation = false } = opts;
  const archive = capture && createCapture(capture); // { dir, htmlPerSignature, maxMB }
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

  // Архив не должен ронять задачу: сбой записи только в stderr.
  const archived = async (snap, cmd) => {
    if (!archive) return;
    try { await archive.write(snap, cmd, () => page.content()); }
    catch (e) { console.error('meatsuit: архив не записан:', e.message); }
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

  // SPA рисует после domcontentloaded: снимаем, пока набор элементов и текст не замрут на quietMs
  // и элементов не станет не меньше minElements. По таймауту отдаём последний снимок, не бросаем.
  const settled = async ({ minElements = 1, quietMs = 500, timeoutMs = 10000 }, rest) => {
    timeoutMs = Math.min(Number.isFinite(timeoutMs) ? timeoutMs : 10000, MAX_WAIT); // supervise проверяет срок только перед вызовом
    const key = (s) => JSON.stringify([s.url, s.text, s.elements.map((e) => [e.role, e.name])]);
    const start = Date.now();
    let snap = await look();
    let prev = key(snap);
    let since = Date.now();
    while (Date.now() - start < timeoutMs && !(snap.elements.length >= minElements && Date.now() - since >= quietMs)) {
      await new Promise((r) => setTimeout(r, 100));
      snap = await look();
      const k = key(snap);
      if (k !== prev) { prev = k; since = Date.now(); }
    }
    return rest.screenshot ? look(rest) : snap; // снимок с картинкой — один, в конце
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

  // Под точкой (x, y) целевой элемент или его потомок, и между ними нет другого интерактивного элемента?
  // Нет — оверлей/тост/сдвиг вёрстки или вложенная кнопка («× закрыть чат»): клика не будет.
  // nested: ещё и над целью не должно быть ссылки, кнопки, поля или <label>. Клик всплывёт к ним и выполнит
  // переход, отправку формы или переключение поля, хотя под курсором сама цель (так в dryRun у вкладки).
  const hitsTarget = async (id, { x, y }, { nested = false } = {}) => {
    let res;
    try {
      res = await dom.run(world, ([i, px, py, sel, up]) => {
        const el = globalThis.__ms.els[i];
        if (!el) return 'covered';
        let hit = document.elementFromPoint(px, py);
        // elementFromPoint отдаёт хост: спускаемся внутрь открытых shadow-корней (как covered в eyes.js).
        for (let s = hit && hit.shadowRoot; s; s = hit.shadowRoot) {
          const inner = s.elementFromPoint(px, py);
          if (!inner || inner === hit) break;
          hit = inner;
        }
        // Вверх по составному дереву (слот, родитель, хост) до el.
        let n = hit;
        for (; n && n !== el; n = n.assignedSlot || n.parentNode || n.host) {
          if (n.nodeType === 1 && n.matches(sel)) return 'covered';
        }
        if (n !== el) return 'covered';
        // От el дальше вверх по тому же составному дереву: интерактивный предок получит клик всплытием.
        if (up) {
          for (let a = el.assignedSlot || el.parentNode || el.host; a; a = a.assignedSlot || a.parentNode || a.host) {
            if (a.nodeType === 1 && a.matches(up)) return 'nested';
          }
        }
        return 'ok';
      }, [id, x, y, INTERACTIVE, nested ? INTERACTIVE + ',label' : null]);
    } catch (err) {
      if (err instanceof dom.StaleWorld) throw new StaleElement('страница сменилась перед кликом');
      throw err;
    }
    if (res === 'nested') throw new StaleElement(`элемент ${id} лежит внутри ссылки, кнопки, поля или метки: клик отменён`);
    if (res !== 'ok') throw new StaleElement(`под курсором уже не элемент ${id}: клик отменён`);
  };

  // press и type бьют по тому, что в фокусе в момент нажатия, а не когда модель решала: фокус мог уйти
  // (автофокус, тост, перерисовка). С id проверяем прямо перед клавишами, что в фокусе этот элемент.
  const focused = async (id) => {
    let ok;
    try {
      ok = await dom.run(world, (i) => {
        const el = globalThis.__ms.els[i];
        let a = document.activeElement;
        while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; // фокус внутри open shadow
        return !!el && a === el;
      }, id);
    } catch (err) {
      if (err instanceof dom.StaleWorld) throw new StaleElement('страница сменилась перед вводом');
      throw err;
    }
    if (!ok) throw new StaleElement(`в фокусе уже не элемент ${id}: ввод отменён`);
  };

  const run = async (c) => {
    switch (c.cmd) {
      case 'click': {
        const el = await target(c.id, c.gen);
        // Мышь идёт до нескольких секунд: перед нажатием сверяем, что под курсором всё ещё цель (оверлей, сдвиг).
        // В dryRun клик по tab — единственная настоящая запись, там ещё и над вкладкой не должно быть ссылки или кнопки.
        return human.click(page, el, { verifyAt: (pt) => hitsTarget(c.id, pt, { nested: dryRun }) });
      }
      case 'fill': {
        const loc = await target(c.id, c.gen);
        await human.click(page, loc, { verifyAt: (pt) => hitsTarget(c.id, pt) });
        await human.pause(150, 500);
        await page.keyboard.press('ControlOrMeta+A');
        await page.keyboard.press('Backspace');
        return human.type(page, c.text);
      }
      case 'type':
        if (hasTarget(c)) { await target(c.id, c.gen); await focused(c.id); }
        return human.type(page, c.text);
      case 'press':
        if (hasTarget(c)) await target(c.id, c.gen);
        await human.pause(150, 600);
        if (hasTarget(c)) await focused(c.id); // после паузы, прямо перед клавишей
        return human.press(page, c.key);
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
    const { since, settle, ...rest } = o || {};
    const snap = settle ? await settled(settle, rest) : await look(rest);
    if (seq === 0) record(null, snap); // запись начинается с первого снимка
    await archived(snap, null);
    return since ? eyes.diff(since, snap) : snap;
  });

  /** Выполнить команду и вернуть, что изменилось на странице. */
  const act = serial(async (c) => {
    validate(c, allowedHosts);
    const url = page.url();
    // dryRunNavigation: клик по role=tab только переключает вид внутри страницы.
    const tabClick = dryRunNavigation && c.cmd === 'click' && last && c.gen === last.gen
      && last.elements.some((e) => e.id === c.id && e.role === 'tab');
    if (dryRun && c.cmd !== 'goto' && !tabClick) { // навигация только читает страницу: без неё dryRun остаётся на about:blank и видеть нечего
      log({ cmd: journalCmd(c), url: journalUrl(url), result: 'dry-run' });
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
      await archived(snap, c);
      log({ cmd: journalCmd(c), url: journalUrl(url), result: 'ok', urlAfter: journalUrl(snap.url) });
      return eyes.diff(before, snap);
    } catch (e) {
      const err = e instanceof dom.StaleWorld ? new StaleElement('страница сменилась посреди команды') : e;
      log({ cmd: journalCmd(c), url: journalUrl(url), error: journalError(err.message, c) });
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
