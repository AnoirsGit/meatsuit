#!/usr/bin/env node
/**
 * Ручное сохранение экранов в архив (тот же формат и та же санитизация, что у бота).
 *
 * Режим 1 (подключение к браузеру по CDP): листаете площадку руками, инструмент сам
 * сохраняет каждый НОВЫЙ тип экрана (по signature), без дублей:
 *   node tools/save-tab.js --cdp http://127.0.0.1:9222 --filter tinder.com --dir ./archive-manual --watch
 *   без --watch сохраняет текущие вкладки один раз.
 *   ВНИМАНИЕ: подключение по CDP включает у страниц режим отладки, сайт теоретически может это заметить.
 *   Для живого аккаунта берите на короткое время или используйте режим 2.
 *
 * Режим 2 (без подключения, нулевой риск для аккаунта): вы сохранили страницу сами
 *   (браузер → «Сохранить как» → «Только HTML», либо DevTools → Copy outerHTML), затем:
 *   node tools/save-tab.js --sanitize страница.html [ещё.html …] --dir ./archive-manual
 *   Очищенная копия кладётся в <dir>/sanitized/. Подпись и снимок для неё не строятся.
 *
 * В архиве настоящие страницы с чужими данными. Хранить только локально, в git не коммитить.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { createCapture, sanitizeHtml } = require('../capture.js');
const { observe } = require('../eyes.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Очистить HTML-файлы без браузера. Возвращает пути результатов. */
function sanitizeFiles(files, dir) {
  const out = path.join(dir, 'sanitized');
  fs.mkdirSync(out, { recursive: true });
  return files.map((f) => {
    const target = path.join(out, `${Date.now()}-${path.basename(f)}`);
    fs.writeFileSync(target, sanitizeHtml(fs.readFileSync(f, 'utf8')));
    return target;
  });
}

/**
 * Снять вкладки, подходящие под filter (подстрока адреса). once=true: один проход.
 * Иначе опрашивает каждые intervalMs, пока не сработает signal. Сохраняет только экраны,
 * чью подпись на этой вкладке ещё не видели. Возвращает число записанных экранов.
 */
async function saveTabs({ cdpUrl, dir, filter = '', once = true, intervalMs = 2000, htmlPerSignature = 5, maxMB = 500, signal, log = () => {} }) {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const ctx = browser.contexts()[0];
  // Свой слушатель диалогов: иначе Playwright сам закрывает confirm()/beforeunload в ваших вкладках.
  ctx.on('dialog', () => {});
  const cap = createCapture({ dir, htmlPerSignature, maxMB });
  const seen = new Set();
  let written = 0;
  try {
    do {
      for (const page of ctx.pages()) {
        const url = page.url();
        if (!url.startsWith('http') || !url.includes(filter)) continue;
        const { snap } = await observe(page, {});
        const key = `${snap.url.split(/[?#]/)[0]}|${JSON.stringify(snap.elements.map((e) => [e.role, e.name]))}`;
        if (seen.has(key)) continue;
        seen.add(key);
        await cap.write(snap, null, () => page.content());
        written++;
        log(`сохранён экран: ${snap.url.split(/[?#]/)[0]} (${snap.elements.length} элементов)`);
      }
      if (!once && !signal?.aborted) await sleep(intervalMs);
    } while (!once && !signal?.aborted);
  } finally {
    await browser.close(); // для CDP-подключения только отключается, браузер остаётся
  }
  return written;
}

module.exports = { saveTabs, sanitizeFiles };

if (require.main === module) {
  const args = process.argv.slice(2);
  const val = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
  const dir = path.resolve(val('--dir', './archive-manual'));
  (async () => {
    if (args.includes('--sanitize')) {
      const files = args.slice(args.indexOf('--sanitize') + 1).filter((a) => !a.startsWith('--') && a !== dir && fs.existsSync(a));
      if (!files.length) throw new Error('укажите HTML-файлы после --sanitize');
      for (const f of sanitizeFiles(files, dir)) console.log('готово:', f);
      return;
    }
    const cdpUrl = val('--cdp');
    if (!cdpUrl) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return; }
    const ac = new AbortController();
    process.on('SIGINT', () => ac.abort());
    const n = await saveTabs({ cdpUrl, dir, filter: val('--filter', ''), once: !args.includes('--watch'), signal: ac.signal, log: console.log });
    console.log(`записано экранов: ${n}, папка ${dir}`);
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
