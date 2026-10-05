/**
 * Аварийный выключатель выхода (docker/egress/killswitch.sh) на заглушках iptables и ip6tables:
 * настоящих правил тут не ставим (это можно проверить только в контейнере на сервере), но порядок правил,
 * то, что REJECT последнее, и отказ стартовать без закрытого IPv6 проверяются здесь.
 *
 *   node --test test/killswitch.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'docker', 'egress', 'killswitch.sh');

/** Каталог с заглушками; has — какие из iptables и ip6tables есть, v6off — закрыт ли IPv6 через sysctl. */
function run({ has = ['iptables', 'ip6tables'], v6off = false, failing = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-ks-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const log = path.join(dir, 'log');
    for (const name of has) {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${failing === name ? 'exit 1' : 'exit 0'}\n`, { mode: 0o755 });
    }
    const proc = path.join(dir, 'disable_ipv6');
    fs.writeFileSync(proc, v6off ? '1\n' : '0\n');
    const marker = path.join(dir, 'ran');
    // PATH — только каталог заглушек: настоящий ip6tables системы не должен подвернуться под руку
    const r = spawnSync('/bin/sh', [SCRIPT, '/bin/sh', '-c', `: > "${marker}"`], {
      env: { PATH: bin, KILLSWITCH_IPV6_SYSCTL: proc }, encoding: 'utf8',
    });
    return { code: r.status, stderr: r.stderr, rules: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [], started: fs.existsSync(marker) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const chain = (tool) => [
  `${tool} -A OUTPUT -o lo -j ACCEPT`,
  `${tool} -A OUTPUT -o tailscale0 -j ACCEPT`,
  `${tool} -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`,
  `${tool} -A OUTPUT -m owner --uid-owner 0 -j ACCEPT`,
  `${tool} -A OUTPUT -j REJECT`,
];

test('есть оба iptables: правила для IPv4 и IPv6 в нужном порядке, REJECT последним, потом запускается команда', () => {
  const r = run();
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.rules, [...chain('iptables'), ...chain('ip6tables')]);
  assert.equal(r.started, true);
});

test('нет ip6tables и IPv6 не закрыт: отказ стартовать, команда не запущена (иначе браузер вышел бы по IPv6 мимо туннеля)', () => {
  const r = run({ has: ['iptables'] });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /IPv6/);
  assert.equal(r.started, false);
});

test('нет ip6tables, но IPv6 закрыт sysctl: стартует, правила только для IPv4', () => {
  const r = run({ has: ['iptables'], v6off: true });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.rules, chain('iptables'));
  assert.equal(r.started, true);
});

test('любая команда iptables не удалась: выключатель не стартует и команда не запущена', () => {
  for (const failing of ['iptables', 'ip6tables']) {
    const r = run({ failing });
    assert.notEqual(r.code, 0, failing);
    assert.equal(r.started, false, failing);
  }
});
