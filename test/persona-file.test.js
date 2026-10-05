/**
 * Повадки на диске: один и тот же файл у прогрева и у HTTP-сервиса, чтобы в браузере
 * после любого перезапуска печатал и водил мышью тот же «человек».
 *
 *   node --test test/persona-file.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadPersona } = require('../human/persona-file.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-persona-'));

test('loadPersona: нет файла — создаётся; потом читается тот же; мусор заменяется годными повадками', () => {
  const dir = path.join(tmp(), 'data');
  try {
    const a = loadPersona(dir);
    assert.ok(a.wpm > 0 && a.speed > 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'persona.json'), 'utf8')), a);
    assert.deepEqual(loadPersona(dir), a, 'второй запуск: тот же человек');
    fs.writeFileSync(path.join(dir, 'persona.json'), '{"wpm":0}');
    const c = loadPersona(dir);
    assert.ok(c.wpm > 0, 'нулевой темп заменён');
  } finally { fs.rmSync(path.dirname(dir), { recursive: true, force: true }); }
});

test('server.js при старте загружает повадки из data/persona.json (тот же человек, что у прогрева)', async () => {
  const dir = tmp();
  try {
    const files = { clients: 'clients.json', sites: 'sites.json', egress: 'egress.json' };
    fs.writeFileSync(path.join(dir, files.clients), JSON.stringify([{ name: 'c', token: 'tok-c-0123456789abcdef', sites: ['hh.kz'] }]));
    fs.writeFileSync(path.join(dir, files.sites), JSON.stringify({ 'hh.kz': { perDay: 3 } }));
    fs.writeFileSync(path.join(dir, files.egress), JSON.stringify({ country: 'KZ', asn: [64500] }));
    const data = path.join(dir, 'data');
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--port', '0', '--data', data,
      '--clients', path.join(dir, files.clients), '--sites', path.join(dir, files.sites), '--egress', path.join(dir, files.egress), '--cdp', 'http://127.0.0.1:1'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    let gone = false;
    const exited = new Promise((resolve) => child.on('exit', (...r) => { gone = true; resolve(r); }));
    const killer = setTimeout(() => child.kill('SIGKILL'), 20000);
    const file = path.join(data, 'persona.json');
    for (let i = 0; i < 150 && !fs.existsSync(file) && !gone; i++) await new Promise((r) => setTimeout(r, 100));
    const seen = fs.existsSync(file);
    child.kill('SIGTERM');
    await exited;
    clearTimeout(killer);
    assert.equal(seen, true, `persona.json не появился; вывод сервера: ${out}`);
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).wpm > 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
