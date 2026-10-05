/**
 * Настоящий Chromium для тестов: запуск без окна на свободном порту отладки,
 * подключение через patchright, список окон по CDP. Если patchright или браузер
 * не найдены, unavailable() возвращает причину, и тесты сами себя пропускают:
 * обычный `node --test` остаётся зелёным без браузера.
 *
 *   NODE_PATH=…/node_modules node --test test/view.test.js
 *   MEATSUIT_CHROMIUM=/путь/к/chromium — если браузер лежит не в обычном месте
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const CANDIDATES = [process.env.MEATSUIT_CHROMIUM, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].filter(Boolean);

const patchright = () => { try { return require('patchright'); } catch { return null; } };
const chromiumPath = () => CANDIDATES.find((p) => fs.existsSync(p)) || null;

/** Причина, по которой браузерные тесты пропускаются, или false, если всё есть. */
function unavailable() {
  if (!patchright()) return 'нет patchright (npm install или NODE_PATH)';
  if (!chromiumPath()) return 'не найден Chromium (MEATSUIT_CHROMIUM)';
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().on('error', reject).listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/** Запустить браузер. stop() убирает процесс по PID и каталог профиля. */
async function launch() {
  const port = await freePort();
  // Сокет профиля — unix-сокет, путь к нему не длиннее ~100 знаков: из длинного TMPDIR Chromium падает.
  const base = os.tmpdir().length > 40 ? '/tmp' : os.tmpdir();
  const profile = fs.mkdtempSync(path.join(base, 'meatsuit-chromium-'));
  const proc = spawn(chromiumPath(), [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--mute-audio',
    '--window-size=1280,800', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  let exited = false;
  proc.on('exit', () => { exited = true; });
  const kill = () => { if (!exited) proc.kill('SIGKILL'); };
  process.on('exit', kill); // упавший тест не оставляет браузер

  const cdpUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (exited || i > 150) { kill(); throw new Error('Chromium не поднял порт отладки'); }
    try { await (await fetch(`${cdpUrl}/json/version`)).json(); break; } catch { await sleep(100); }
  }
  return {
    cdpUrl,
    pid: proc.pid,
    async stop() {
      process.off('exit', kill);
      if (!exited) {
        proc.kill('SIGTERM');
        for (let i = 0; i < 30 && !exited; i++) await sleep(100);
        kill();
      }
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}

/** Подключение patchright к запущенному браузеру: { browser, context }. */
async function connect(cdpUrl) {
  const browser = await patchright().chromium.connectOverCDP(cdpUrl);
  return { browser, context: browser.contexts()[0] };
}

/**
 * Страницы браузера с окном, в котором лежит каждая: [{targetId, url, windowId}].
 * Окно и вкладка различаются по windowId: вкладки одного окна делят его.
 */
async function windows(cdpUrl) {
  const { webSocketDebuggerUrl } = await (await fetch(`${cdpUrl}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP не открылся')); });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); const w = waiting.get(d.id); if (w) { waiting.delete(d.id); d.error ? w.reject(new Error(d.error.message)) : w.resolve(d.result); } };
  const send = (method, params) => new Promise((resolve, reject) => { waiting.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  try {
    const { targetInfos } = await send('Target.getTargets');
    const out = [];
    for (const t of targetInfos.filter((x) => x.type === 'page')) {
      const { windowId } = await send('Browser.getWindowForTarget', { targetId: t.targetId });
      out.push({ targetId: t.targetId, url: t.url, windowId });
    }
    return out;
  } finally { ws.close(); }
}

module.exports = { unavailable, launch, connect, windows, patchright, chromiumPath };
