/**
 * Порт отладки Chromium для тестов ядра (не набор тестов, помощник).
 *
 * Тесты запускают браузер с --remote-debugging-port=0: порт выбирает сам Chromium и пишет его номер первой строкой
 * в <профиль>/DevToolsActivePort. С фиксированным портом (9333, 9334…) параллельный прогон на той же машине
 * (другой клон, другой агент) занимал порт раньше: наш Chromium оставался без сервера отладки, а connect() уходил
 * в чужой браузер — тест открывал окна там и падал, а чужой прогон ломался от этих окон.
 *
 *   const ctx = await chromium.launchPersistentContext(dir, { headless: true, args: ['--remote-debugging-port=0'] });
 *   const PORT = await cdpPort(dir);
 */
const fs = require('node:fs');
const path = require('node:path');

async function cdpPort(profileDir, timeoutMs = 10000) {
  const file = path.join(profileDir, 'DevToolsActivePort');
  for (const until = Date.now() + timeoutMs; Date.now() < until; await new Promise((r) => setTimeout(r, 50))) {
    let port = 0;
    try { port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]); } catch { /* ещё не записан */ }
    if (Number.isInteger(port) && port > 0) return port;
  }
  throw new Error(`нет ${file}: браузер не открыл порт отладки`);
}

module.exports = { cdpPort };
