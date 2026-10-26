/**
 * Правило заброшенных вкладок (tabs.js): отметки активности, выбор рабочей вкладки, что закрыть. Без браузера.
 * В браузере то же проверяет test/single-tab.test.js.
 *
 *   node test/stale-tabs.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tabs = require('../tabs.js');

const H = 3600e3;
const NOW = Date.UTC(2026, 0, 10, 12);
const tab = (id, o = {}) => ({ id, url: `https://example.com/${id}`, title: id, visible: false, loading: false, reason: null, typed: false, ...o });

// staleTabHours: по умолчанию 48, 0 можно, остальное — ошибка.
assert.equal(tabs.staleHours({}), 48);
assert.equal(tabs.staleHours(undefined), 48);
assert.equal(tabs.staleHours({ staleTabHours: 0 }), 0);
assert.equal(tabs.staleHours({ staleTabHours: 2.5 }), 2.5);
for (const bad of [-1, '48', null, NaN, Infinity]) assert.throws(() => tabs.staleHours({ staleTabHours: bad }), /staleTabHours/);

// update: новая вкладка — «сейчас»; та же — прежнее время; смена адреса или заголовка, вкладка на экране — «сейчас».
const s0 = tabs.update({}, [tab('a'), tab('b')], NOW - 100 * H);
assert.deepEqual([s0.a.at, s0.b.at], [NOW - 100 * H, NOW - 100 * H]);
assert.equal(JSON.stringify(s0).includes('example.com'), false, 'адрес в отметках не хранится');
const s1 = tabs.update(s0, [tab('a'), tab('b', { url: 'https://example.com/b2' }), tab('c'), tab('d', { visible: true })], NOW);
assert.equal(s1.a.at, NOW - 100 * H, 'без изменений время прежнее');
assert.equal(s1.b.at, NOW, 'смена адреса — активность');
assert.equal(s1.c.at, NOW, 'новая вкладка — сейчас');
assert.equal(s1.d.at, NOW, 'вкладка на экране — активность');
assert.equal(tabs.update(s0, [tab('a', { title: 'другой' })], NOW).a.at, NOW, 'смена заголовка — активность');
assert.equal(tabs.update({ x: { mark: 'm', at: 1 } }, [], NOW).x.at, 1, 'чужие записи не трогаются');

// pick: на экране; иначе самая свежая; при равенстве первая.
const st = { a: { at: NOW - 5 * H }, b: { at: NOW - H }, c: { at: NOW - 9 * H } };
assert.equal(tabs.pick([tab('a'), tab('b'), tab('c')], st).id, 'b');
assert.equal(tabs.pick([tab('a'), tab('b'), tab('c', { visible: true })], st).id, 'c');
assert.equal(tabs.pick([tab('x'), tab('y')], { x: { at: NOW }, y: { at: NOW } }).id, 'x');
assert.equal(tabs.pick([], st), undefined);

// stale: дольше порога и ни одного исключения.
const ages = { old: 49, young: 47, chosen: 100, seen: 100, cap: 100, typed: 100, loading: 100 };
const state = Object.fromEntries(Object.entries(ages).map(([k, h]) => [k, { at: NOW - h * H }]));
const list = [tab('old'), tab('young'), tab('chosen'), tab('seen', { visible: true }), tab('cap', { reason: 'капча' }), tab('typed', { typed: true }), tab('loading', { loading: true })];
const chosen = list[2];
assert.deepEqual(tabs.stale(list, state, chosen, 48, NOW).map((t) => t.id), ['old']);
assert.deepEqual(tabs.stale(list, state, chosen, 0, NOW), [], 'staleTabHours: 0 ничего не закрывает');
assert.deepEqual(tabs.stale(list, state, chosen, 200, NOW), []);
assert.deepEqual(tabs.stale([tab('nostate')], {}, null, 48, NOW), [], 'без отметки не закрывается');

// typed: непустое значение текстового поля; пробелы, пароль без value и select не в счёт.
assert.equal(tabs.typed({ elements: [{ role: 'textbox', value: 'привет' }] }), true);
assert.equal(tabs.typed({ elements: [{ role: 'textbox', value: '  ' }, { role: 'textbox', inputType: 'password' }, { role: 'select', value: 'RU' }] }), false);
assert.equal(tabs.typed({}), false);

// prune оставляет живые; load на мусоре и без файла — {}; save пишет целиком.
assert.deepEqual(tabs.prune({ a: { at: 1 }, b: { at: 2 } }, ['b', 'z']), { b: { at: 2 } });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-tabs-'));
const file = path.join(tmp, 'tabs.json');
assert.deepEqual(tabs.load(file), {});
fs.writeFileSync(file, '{битый');
assert.deepEqual(tabs.load(file), {});
tabs.save(file, { a: { mark: 'm', at: 1 } });
assert.deepEqual(tabs.load(file), { a: { mark: 'm', at: 1 } });
assert.deepEqual(fs.readdirSync(tmp), ['tabs.json'], 'временный файл не остаётся');

console.log('stale-tabs.test: ok');
