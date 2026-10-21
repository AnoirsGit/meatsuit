/**
 * Стенд для сквозных (E2E) тестов: локальный «сайт» и настоящий Chromium.
 * Страницы нужны ровно под то, что фальшивая страница не ловит: ссылки с
 * относительным href, ссылки только вверху длинной страницы, медленный
 * переход, поле для печати с журналом событий клавиатуры, блок и капча.
 *
 * Порты выбирает система (listen(0) у сайта, --remote-debugging-port=0 у
 * браузера: он сам пишет свой порт в DevToolsActivePort), каталог профиля
 * временный и уникальный, всё убирается в stop().
 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROMIUMS = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];

/** Путь к браузеру: CHROMIUM из окружения (если задан, то только он) или обычные места. */
function findChromium(env = process.env) {
  if (env.CHROMIUM) return fs.existsSync(env.CHROMIUM) ? env.CHROMIUM : null;
  return CHROMIUMS.find((p) => fs.existsSync(p)) || null;
}

/** Почему E2E не запускается; null — всё есть. patchright лежит не в репозитории, его ищет require.resolve (NODE_PATH). */
function skipReason(env = process.env) {
  if (env.E2E !== '1') return 'E2E не включён: запуск `npm run test:e2e` (E2E=1, нужен Chromium и patchright)';
  try { require.resolve('patchright'); } catch { return 'E2E пропущен: не найден patchright (npm install или NODE_PATH)'; }
  if (!findChromium(env)) return 'E2E пропущен: не найден Chromium (/usr/bin/chromium или переменная CHROMIUM)';
  return null;
}

const para = (n, tag = 'Абзац') => Array.from({ length: n }, (_, i) => `<p>${tag} ${i + 1}. ${'Это длинный осмысленный текст статьи про разработку и браузеры, который читают не спеша. '.repeat(6)}</p>`).join('');
const page = (title, body) => `<!doctype html><meta charset=utf-8><title>${title}</title><body style="font:16px sans-serif;margin:20px">${body}</body>`;

// Поле для печати и журнал событий в DOM (<pre id=log>, по строке JSON на событие): patchright читает
// страницу в изолированном мире, где переменных страницы не видно, а DOM общий.
const LOGGER = `<pre id="log" style="display:none"></pre><script>
const out = document.getElementById('log');
const push = (o) => { out.textContent += JSON.stringify(o) + '\\n'; };
for (const t of ['keydown', 'keyup']) addEventListener(t, (e) => push({ t, key: e.key, code: e.code, shift: e.shiftKey, trusted: e.isTrusted }), true);
addEventListener('input', (e) => push({ t: 'input', trusted: e.isTrusted }), true);
for (const t of ['mousedown', 'mouseup', 'click']) addEventListener(t, (e) => push({ t, id: e.target.id, trusted: e.isTrusted }), true);
</script>`;

const PAGES = {
  // Заголовки только вверху длинной страницы, ссылки относительные: как на большинстве сайтов новостей.
  '/news': page('Новости', `<h1>Новости</h1><a href="/news/2">Вторая интересная новость дня</a><br><a href="/news/3">Третья интересная новость дня</a><br><a href="/login">Войти в личный кабинет</a><br><a href="http://other.invalid/x">Чужая ссылка на другой сайт</a>${para(14)}`),
  '/news/2': page('Новость 2', `<h1>Вторая новость</h1><a href="/news">Вернуться на главную страницу</a>${para(10)}`),
  '/news/3': page('Новость 3', `<h1>Третья новость</h1>${para(10)}`),
  // Видео: короткая страница, ссылка на ролик видна сразу.
  '/video': page('Видео', `<h1>Видео</h1><a href="/watch?v=abc">Как устроен браузер изнутри и почему</a>${para(3)}`),
  '/watch?v=abc': page('Ролик', `<h1>Ролик</h1><p>Играет видео...</p>${para(4)}`),
  '/blocked': page('Ошибка', '<p>Our systems have detected unusual traffic from your computer network.</p>'),
  // Фрейм проверки такого вида guard считает капчей независимо от текста.
  '/captcha': page('Проверка', '<h1>Проверка</h1><iframe src="/recaptcha/api2/bframe" width="400" height="300"></iframe>'),
  '/recaptcha/api2/bframe': page('frame', '<p>здесь была бы проверка</p>'),
  '/form': page('Форма', `<input id="name" style="width:700px;height:30px;margin:20px">${LOGGER}`),
};
const SLOW_MS = 300;

/** Локальный сайт на свободном порту. requests — журнал обращений: { path, referer }. */
async function startSite() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, referer: req.headers.referer || '' });
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
    if (req.url === '/slow') return void setTimeout(() => send(200, page('Медленная', `<h1>Медленная</h1>${para(5)}`)), SLOW_MS); // ответ с задержкой: переход идёт заметное время
    const body = PAGES[req.url];
    send(body ? 200 : 404, body || page('404', 'нет такой страницы'));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    url: (p) => origin + p,
    requests,
    hits: (p) => requests.filter((r) => r.path === p),
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

/** Дождаться, пока браузер напишет порт отладки и ответит на /json/version. */
async function waitReady(dir, child, ms = 30000) {
  const file = path.join(dir, 'DevToolsActivePort');
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(100)) {
    if (child.exitCode !== null || child.signalCode) throw new Error(`Chromium завершился при запуске (код ${child.exitCode ?? child.signalCode})`);
    let port = 0;
    try { port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]); } catch { /* файла ещё нет */ }
    if (!port) continue;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return port;
    } catch { /* порт ещё не слушает */ }
  }
  throw new Error(`Chromium не поднялся за ${ms} мс`);
}

/** Запустить Chromium с отладкой на свободном порту; stop() останавливает всю его группу процессов и удаляет профиль. */
async function startChromium(bin = findChromium()) {
  if (!bin) throw new Error('не найден Chromium');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-e2e-'));
  const args = [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-component-update',
    '--window-size=1280,900', 'about:blank',
  ];
  if (process.getuid && process.getuid() === 0) args.push('--no-sandbox'); // под root без этого Chromium не стартует
  const child = spawn(bin, args, { detached: true, stdio: 'ignore' }); // detached: своя группа процессов, убиваем её по номеру
  const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { /* уже нет */ } };
  const onExit = () => killGroup('SIGKILL'); // страховка, если тест оборвался
  process.on('exit', onExit);
  const exited = new Promise((resolve) => child.once('exit', resolve));

  const stop = async () => {
    process.off('exit', onExit);
    if (child.exitCode === null && !child.signalCode) {
      killGroup('SIGTERM');
      if (await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]) === false) { killGroup('SIGKILL'); await exited; }
    }
    killGroup('SIGKILL'); // потомки, пережившие главный процесс
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };

  try {
    const port = await waitReady(dir, child);
    return { cdp: `http://127.0.0.1:${port}`, pid: child.pid, dir, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

module.exports = { skipReason, findChromium, startSite, startChromium, SLOW_MS };
