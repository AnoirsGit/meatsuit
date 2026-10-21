/**
 * Замок на браузер (lease.js): свой, чужой, просроченный, мусор в файле; файловая система в памяти.
 *
 *   node --test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLease } = require('../lease.js');

function memFs() {
  const files = new Map();
  return {
    files,
    readFileSync(f) { if (!files.has(f)) throw Object.assign(new Error('нет файла'), { code: 'ENOENT' }); return files.get(f); },
    writeFileSync(f, data) { files.set(f, String(data)); },
    renameSync(a, b) { files.set(b, files.get(a)); files.delete(a); },
    unlinkSync(f) { if (!files.has(f)) throw Object.assign(new Error('нет файла'), { code: 'ENOENT' }); files.delete(f); },
    mkdirSync() {},
  };
}
const setup = () => {
  const clock = { t: 1000 }, fs = memFs();
  const make = (holder) => createLease({ file: 'data/browser.lock', holder, fs, now: () => clock.t });
  return { clock, fs, server: make('server'), life: make('life') };
};

test('свободный замок берётся; чужой действующий — нет, с именем держателя и сроком; свой берётся снова', () => {
  const { server, life, clock } = setup();
  assert.deepEqual(server.acquire(60000), { ok: true });
  assert.deepEqual(life.acquire(60000), { ok: false, holder: 'server', until: 61000 });
  assert.deepEqual(server.acquire(30000), { ok: true }, 'свой замок можно взять повторно');
  assert.equal(server.peek().since, 1000, 'повторный захват не сдвигает начало');
  clock.t = 2000;
  assert.deepEqual(life.peek(), { holder: 'server', since: 1000, until: 31000 });
});

test('просроченный замок берётся свободно, в том числе чужой', () => {
  const { server, life, clock } = setup();
  server.acquire(10000);
  clock.t = 11001;
  assert.equal(life.peek(), null);
  assert.deepEqual(life.acquire(5000), { ok: true });
  assert.deepEqual(server.acquire(5000), { ok: false, holder: 'life', until: 16001 });
});

test('renew продлевает только свой действующий замок; release снимает только свой', () => {
  const { server, life, clock } = setup();
  server.acquire(10000);
  clock.t = 5000;
  assert.equal(server.renew(10000), true);
  assert.equal(server.peek().until, 15000);
  assert.equal(life.renew(10000), false, 'чужой замок не продлить');
  assert.equal(life.release(), false, 'чужой замок не снять');
  assert.ok(server.peek(), 'замок на месте после чужого release');
  clock.t = 16000;
  assert.equal(server.renew(10000), false, 'просроченный не продлевается: его мог взять другой');
  assert.equal(server.release(), true, 'просроченный свой всё же снимается, чтобы не мусорить');
  assert.equal(server.release(), false, 'второй раз снимать нечего');
});

test('мусор или полузапись в файле — как отсутствие замка; запись идёт через временный файл', () => {
  const { server, fs } = setup();
  fs.files.set('data/browser.lock', '{"holder":"life","since":');
  assert.equal(server.peek(), null);
  assert.deepEqual(server.acquire(1000), { ok: true });
  assert.ok(!fs.files.has('data/browser.lock.tmp'), 'временный файл остался');
  fs.files.set('data/browser.lock', JSON.stringify({ holder: 5, since: 1, until: 1e13 }));
  assert.equal(server.peek(), null, 'держатель не строка — не замок');
});

test('без file или holder — ошибка', () => {
  assert.throws(() => createLease({ file: 'x' }), /lease/);
  assert.throws(() => createLease({ holder: 'x' }), /lease/);
});
