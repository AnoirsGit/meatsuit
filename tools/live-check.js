#!/usr/bin/env node
/**
 * Живая проверка зеркала из библиотеки (docs/acceptance.md): две dryRun-задачи через connect()/task().
 *
 *   node tools/live-check.js --cdp http://127.0.0.1:9222 --dir /state/meatsuit [--site example.com] [--login-path /login]
 *
 * 1. dryRun-задача на https://<site>/: снимок see() (адрес, заголовок, число элементов); после неё окно
 *    задачи закрыто — окон в браузере столько же, сколько было до неё.
 * 2. dryRun-задача на https://<site><login-path>: адрес входа → guard → NeedsHuman; окно остаётся
 *    человеку — окон на одно больше. Закройте его в зеркале руками.
 *
 * dryRun слотов не тратит и ничего на странице не нажимает (goto выполняется). Лимиты — объект в памяти,
 * свой sites.json не нужен. --dir: тот же каталог, что у вызывающих этого браузера (замок очереди общий),
 * иначе проверка может войти в браузер одновременно с ботом. Окна считаются по /json/list порта CDP.
 * Выход: 0 — оба шага OK, 1 — что-то не так, 2 — неверные аргументы.
 */
const { connect, NeedsHuman } = require('../index.js');

function parseArgs(argv) {
  const opts = { cdp: null, dir: null, site: 'example.com', loginPath: '/login' };
  const names = { '--cdp': 'cdp', '--dir': 'dir', '--site': 'site', '--login-path': 'loginPath' };
  for (let i = 0; i < argv.length; i++) {
    const key = names[argv[i]];
    if (!key || argv[i + 1] === undefined) throw new Error(`неизвестный или пустой аргумент «${argv[i]}» (см. начало tools/live-check.js)`);
    opts[key] = argv[++i];
  }
  if (!opts.cdp) throw new Error('нужен --cdp, например http://127.0.0.1:9222');
  if (!opts.dir) throw new Error('нужен --dir: каталог состояния, общий с вызывающими этого браузера');
  if (!/^[a-z0-9.-]+$/i.test(opts.site)) throw new Error(`--site — имя хоста, а не «${opts.site}»`);
  if (!opts.loginPath.startsWith('/')) throw new Error('--login-path начинается с /');
  return opts;
}

/** Страницы браузера по CDP (без подключения Playwright): [{ id, url }]. */
async function pages(cdp) {
  const list = await (await fetch(`${cdp.replace(/\/$/, '')}/json/list`)).json();
  return list.filter((t) => t.type === 'page').map((t) => ({ id: t.id, url: t.url }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(opts, out = console.log) {
  const results = [];
  const report = (ok, what, detail = '') => { results.push(ok); out(`${ok ? 'OK  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`); };
  const sites = { [opts.site]: { perDay: 5, perHour: 5 } };
  const ms = await connect({ cdpUrl: opts.cdp, dir: opts.dir, sites });
  try {
    const before = await pages(opts.cdp);
    const snap = await ms.task('live-check', async ({ see, act }) => {
      await act({ cmd: 'goto', url: `https://${opts.site}/` });
      return see();
    }, { site: opts.site, dryRun: true });
    report(new URL(snap.url).hostname === opts.site, 'dryRun-задача открыла площадку и вернула снимок',
      `${snap.url} «${snap.title}», элементов: ${snap.elements.length}`);
    await sleep(300);
    const after = await pages(opts.cdp);
    report(after.length === before.length, 'окно задачи закрыто', `окон до: ${before.length}, после: ${after.length}`);

    const loginUrl = `https://${opts.site}${opts.loginPath}`;
    let stopped = null;
    try {
      await ms.task('live-check-login', async ({ see, act }) => {
        await act({ cmd: 'goto', url: loginUrl });
        await see();
      }, { site: opts.site, dryRun: true });
    } catch (e) {
      if (!(e instanceof NeedsHuman)) throw e;
      stopped = e;
    }
    report(!!stopped, 'страница входа остановила задачу (NeedsHuman)', stopped ? `${stopped.reason}, ${stopped.url}` : 'задача прошла как обычная');
    await sleep(300);
    const left = await pages(opts.cdp);
    const kept = left.filter((p) => !before.some((b) => b.id === p.id));
    report(kept.length === 1 && kept[0].url.startsWith(loginUrl), 'окно после NeedsHuman осталось человеку',
      kept.length ? `${kept.map((p) => p.url).join(', ')}: закройте его в зеркале` : 'нового окна нет');
  } finally {
    await ms.close().catch(() => {});
  }
  return results.every(Boolean) ? 0 : 1;
}

module.exports = { parseArgs, run, pages };

if (require.main === module) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`live-check: ${e.message}`); process.exit(2); }
  run(opts).then((code) => process.exit(code), (e) => { console.error(`live-check: сбой — ${e.message}`); process.exit(1); });
}
