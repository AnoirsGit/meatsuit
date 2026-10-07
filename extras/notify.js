/**
 * Сообщение мне в Telegram через Bot API, без зависимостей. Токен и chat_id из
 * окружения, транспорт подставляется. Нет токена — сообщение остаётся только в
 * журнале, а сбой отправки никогда не бросает: уведомление не должно ронять
 * сервис и не должно показывать токен (он в адресе запроса).
 */
const https = require('node:https');

const LIMIT = 4096; // длиннее Telegram не принимает

/** Транспорт на node:https (lib подставляется в тесте). → { status, body } */
function httpsTransport(lib = https) {
  return ({ hostname, port, path, method, headers, body, timeoutMs }) => new Promise((resolve, reject) => {
    const req = lib.request(
      { hostname, port, path, method, headers: { ...headers, 'content-length': Buffer.byteLength(body) }, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('таймаут')));
    req.on('error', reject);
    req.end(body);
  });
}

function createNotifier({
  token, chatId, host = 'api.telegram.org', port, timeoutMs = 10000,
  transport = httpsTransport(), log = () => {},
} = {}) {
  const scrub = (s) => String(s).split(token).join('***').split(encodeURIComponent(token)).join('***');

  return async function notify(text) {
    text = String(text).slice(0, LIMIT);
    if (!token || !chatId) {
      log({ event: 'notify', result: 'no_token', text });
      return { sent: false, reason: 'no_token' };
    }
    try {
      const res = await transport({
        hostname: host, port, method: 'POST', path: `/bot${token}/sendMessage`, timeoutMs,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      });
      let reply = null;
      try { reply = JSON.parse(res.body); } catch { /* не JSON: разберём по статусу */ }
      if (res.status >= 200 && res.status < 300 && reply && reply.ok === true) {
        log({ event: 'notify', result: 'sent', text });
        return { sent: true };
      }
      log({ event: 'notify', result: 'failed', text, detail: `HTTP ${res.status}${reply && reply.description ? ` ${scrub(reply.description)}` : ''}` });
    } catch (err) {
      log({ event: 'notify', result: 'failed', text, detail: scrub(err && err.message) });
    }
    return { sent: false, reason: 'failed' };
  };
}

/** Токен и чат из окружения: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID. */
const fromEnv = (env = process.env, opts = {}) => createNotifier({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID, ...opts });

module.exports = { createNotifier, fromEnv, httpsTransport };
