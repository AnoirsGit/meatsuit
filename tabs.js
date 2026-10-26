/**
 * Вкладки площадки с singleTab: отметки активности, выбор рабочей вкладки, закрытие заброшенных.
 *
 * Отметки — в <dir>/tabs.json: { [CDP target id]: { mark, at } }, mark — хеш адреса и заголовка (сам адрес
 * с query не храним), at — время последней активности, мс. На странице ничего не меняется.
 * Активность: бот работал во вкладке, адрес или заголовок изменились с прошлой проверки, вкладка на экране.
 * Вкладка, которую ядро видит впервые, получает «сейчас».
 *
 * update, pick, stale — чистые функции (test/stale-tabs.test.js).
 */
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { cdpOf, openWorld, run } = require('./dom.js');

const HOUR = 3600e3;
const DEFAULT_HOURS = 48;

/** Порог из правила площадки: staleTabHours, по умолчанию 48; 0 — не закрывать. Кривое значение — Error. */
function staleHours(rule) {
  const h = rule && rule.staleTabHours;
  if (h === undefined) return DEFAULT_HOURS;
  if (typeof h !== 'number' || !Number.isFinite(h) || h < 0) throw new Error(`sites.json: staleTabHours — число часов ≥ 0, пришло ${JSON.stringify(h)}`);
  return h;
}

const markOf = (url, title) => createHash('sha256').update(`${url}\n${title}`).digest('hex').slice(0, 16);

/** Новые отметки после проверки. tabs — [{ id, url, title, visible }]. Прочие записи state не трогает. */
function update(state, tabs, now) {
  const out = { ...state };
  for (const t of tabs) {
    const mark = markOf(t.url, t.title);
    const prev = state[t.id];
    out[t.id] = { mark, at: !prev || prev.mark !== mark || t.visible || !Number.isFinite(prev.at) ? now : prev.at };
  }
  return out;
}

/** Рабочая вкладка: на экране; иначе с самой свежей активностью; при равенстве — первая по порядку. */
function pick(tabs, state) {
  let best;
  for (const t of tabs) {
    const k = [t.visible ? 1 : 0, state[t.id] ? state[t.id].at : 0];
    if (!best || k[0] > best.k[0] || (k[0] === best.k[0] && k[1] > best.k[1])) best = { t, k };
  }
  return best && best.t;
}

/** Набран ли текст в поле: недописанное сообщение не теряем. */
const typed = (snap) => (snap.elements || []).some((e) => e.role === 'textbox' && typeof e.value === 'string' && e.value.trim() !== '');

/**
 * Какие вкладки закрыть. tabs — [{ id, visible, loading, reason, typed }], chosen — рабочая.
 * Не закрываются: рабочая, на экране, с капчей/входом/блоком (reason), с набранным текстом, ещё загружающаяся.
 */
function stale(tabs, state, chosen, hours, now) {
  if (!(hours > 0)) return [];
  return tabs.filter((t) => t !== chosen && !t.visible && !t.reason && !t.typed && !t.loading
    && state[t.id] && now - state[t.id].at > hours * HOUR);
}

/** Оставить записи только живых вкладок. */
function prune(state, liveIds) {
  const live = new Set(liveIds);
  return Object.fromEntries(Object.entries(state).filter(([id]) => live.has(id)));
}

function load(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; } // нет файла или мусор: все вкладки «новые», ничего не закроется
}

function save(file, state) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}

/**
 * id вкладки (CDP target id), на экране ли она и грузится ли ещё. Через сессию и изолированный мир снимка
 * (dom.js): скрипты сайта чтение не видят и подменить не могут.
 */
async function probe(page) {
  const id = await targetId(page);
  const s = await run(await openWorld(page), () => ({ visible: document.visibilityState === 'visible', loading: document.readyState !== 'complete' }));
  return { id, ...s };
}

async function targetId(page) {
  const { targetInfo } = await (await cdpOf(page)).send('Target.getTargetInfo');
  return targetInfo.targetId;
}

module.exports = { staleHours, update, pick, stale, prune, typed, load, save, probe, targetId, HOUR };
