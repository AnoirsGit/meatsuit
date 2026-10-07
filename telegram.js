/**
 * Адаптер Telegram Bot API: отправка сообщений ботом в группу (или в тему форума).
 *
 *   const tg = createTelegram({ token, chatId, threadId? });
 *   await tg.send('Нужен человек: капча на tinder.com');
 *   await tg.send('<b>отчёт</b>', { parseMode: 'HTML', silent: true });
 *
 * Как узнать chatId группы: добавить бота в группу, написать там любое сообщение, затем
 *   TELEGRAM_BOT_TOKEN=… node telegram.js chats
 * Группы идут с отрицательным id (супергруппы -100…).
 *
 * Токен в тексты ошибок и логов не попадает. Сетевых зависимостей нет: только fetch.
 */
const API = 'https://api.telegram.org';
const LIMIT = 4096; // максимум символов в одном сообщении

class TelegramError extends Error {
  constructor(message, code, params = {}) { super(message); this.code = code; this.params = params; }
}

const HINTS = {
  401: 'неверный токен бота',
  403: 'бот удалён из группы, заблокирован или не имеет права писать',
  404: 'неверный токен бота',
};

/** Режет текст на куски не длиннее limit, по возможности по концу строки. */
function chunk(text, limit = LIMIT) {
  const out = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = limit; // нет разумного разрыва: режем жёстко
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length) out.push(rest);
  return out;
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function createTelegram({
  token, chatId, threadId,
  fetchImpl = fetch,
  apiBase = API, // для тестов и локального прокси
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  warn = console.warn,
} = {}) {
  if (!token) throw new Error('telegram: нужен token');
  if (!chatId) throw new Error('telegram: нужен chatId группы (см. «node telegram.js chats»)');
  let chat = chatId;
  const scrub = (s) => String(s).split(token).join('***');

  async function call(method, body) {
    let res;
    try {
      res = await fetchImpl(`${apiBase}/bot${token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch (e) {
      throw new TelegramError(scrub(`нет связи с Telegram: ${e.message}`));
    }
    let data = null;
    try { data = await res.json(); } catch { /* не JSON */ }
    if (res.ok && data && data.ok) return data.result;
    const code = (data && data.error_code) || res.status;
    const hint = HINTS[code] || (/chat not found/i.test((data && data.description) || '') ? 'неверный chatId или бота нет в группе' : '');
    throw new TelegramError(scrub(`${(data && data.description) || `HTTP ${res.status}`}${hint ? ` (${hint})` : ''}`), code, (data && data.parameters) || {});
  }

  async function sendOne(text, o) {
    let migrated = false;
    for (let attempt = 0; ; attempt++) {
      try {
        const body = { chat_id: chat, text, disable_web_page_preview: true };
        if (o.parseMode) body.parse_mode = o.parseMode;
        if (o.silent) body.disable_notification = true;
        const thread = o.threadId ?? threadId;
        if (thread) body.message_thread_id = Number(thread);
        return await call('sendMessage', body);
      } catch (e) {
        if (!(e instanceof TelegramError)) throw e;
        if (e.params.migrate_to_chat_id && !migrated) { // группа стала супергруппой: у неё новый id
          migrated = true;
          chat = e.params.migrate_to_chat_id;
          warn(`telegram: группа переехала, новый chatId ${chat}. Обновите настройку.`);
          continue;
        }
        if (e.code === 429 && attempt < 3) { await sleep(Math.min(e.params.retry_after ?? 1, 30) * 1000); continue; }
        if (e.code >= 500 && attempt < 1) { await sleep(1000); continue; }
        throw e;
      }
    }
  }

  /**
   * Отправить текст. Длинный режется на несколько сообщений. Возвращает message_id отправленных.
   * o: { parseMode: 'HTML'|'MarkdownV2', silent: без звука, threadId: тема форума }.
   * По умолчанию текст простой (без разметки): спецсимволы в нём ничего не ломают.
   */
  async function send(text, o = {}) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('telegram: пустое сообщение');
    const ids = [];
    for (const part of chunk(text)) ids.push((await sendOne(part, o)).message_id);
    return ids;
  }

  return { send, get chatId() { return chat; } };
}

/** Совместимо с notify(text) из meatsuit.connect(). */
const telegramNotifier = (opts) => { const tg = createTelegram(opts); return (text) => tg.send(text); };

/** Группы, которые бот «видел»: помогает найти chatId. Не работает, если у бота настроен webhook. */
async function findChats({ token, fetchImpl = fetch, apiBase = API } = {}) {
  if (!token) throw new Error('telegram: нужен token');
  let data;
  try {
    const res = await fetchImpl(`${apiBase}/bot${token}/getUpdates`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ timeout: 0 }),
    });
    data = await res.json();
  } catch (e) {
    throw new TelegramError(String(e.message).split(token).join('***'));
  }
  if (!data || !data.ok) throw new TelegramError(String((data && data.description) || 'getUpdates не удался').split(token).join('***'), data && data.error_code);
  const seen = new Map();
  for (const u of data.result) {
    const msg = u.message || u.edited_message || u.channel_post;
    const chat = (msg && msg.chat) || (u.my_chat_member && u.my_chat_member.chat);
    if (!chat) continue;
    const entry = seen.get(chat.id) || { id: chat.id, type: chat.type, title: chat.title || [chat.first_name, chat.username].filter(Boolean).join(' '), threads: new Set() };
    if (msg && msg.is_topic_message && msg.message_thread_id) entry.threads.add(msg.message_thread_id);
    seen.set(chat.id, entry);
  }
  return [...seen.values()].map((c) => ({ ...c, threads: [...c.threads] }));
}

module.exports = { createTelegram, telegramNotifier, findChats, chunk, escapeHtml, TelegramError };

if (require.main === module) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const [cmd, ...rest] = process.argv.slice(2);
  (async () => {
    if (cmd === 'chats') {
      const chats = await findChats({ token });
      if (!chats.length) return console.log('Бот пока ничего не видел. Добавьте его в группу и напишите там сообщение, потом повторите.');
      for (const c of chats) console.log(`${c.id}\t${c.type}\t${c.title}${c.threads.length ? `\tтемы: ${c.threads.join(', ')}` : ''}`);
    } else if (cmd === 'send') {
      const tg = createTelegram({ token, chatId: process.env.TELEGRAM_CHAT_ID, threadId: process.env.TELEGRAM_THREAD_ID, ...(process.env.TELEGRAM_API_BASE && { apiBase: process.env.TELEGRAM_API_BASE }) });
      await tg.send(rest.join(' ') || 'meatsuit: проверка связи');
      console.log('отправлено');
    } else {
      console.log('Использование:\n  TELEGRAM_BOT_TOKEN=… node telegram.js chats\n  TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… [TELEGRAM_THREAD_ID=…] node telegram.js send "текст"');
    }
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
