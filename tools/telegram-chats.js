/**
 * Для человека, который настраивает уведомления: какие группы и темы видел бот (чтобы узнать chatId),
 * и пробная отправка. Токен берётся из окружения того, кто запускает; сам telegram.js окружение не читает.
 *
 *   TELEGRAM_BOT_TOKEN=… node tools/telegram-chats.js [chats]
 *   TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… [TELEGRAM_THREAD_ID=…] node tools/telegram-chats.js send "текст"
 *
 * TELEGRAM_API_BASE — другой адрес Bot API (локальный прокси или фальшивый сервер в тестах).
 */
const { createTelegram, findChats } = require('../telegram.js');

const USAGE = 'Использование:\n  TELEGRAM_BOT_TOKEN=… node tools/telegram-chats.js [chats]\n'
  + '  TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… [TELEGRAM_THREAD_ID=…] node tools/telegram-chats.js send "текст"';

async function main(argv, env, log = console.log) {
  const [cmd = 'chats', ...rest] = argv;
  const token = env.TELEGRAM_BOT_TOKEN;
  const apiBase = env.TELEGRAM_API_BASE ? { apiBase: env.TELEGRAM_API_BASE } : {};
  if (cmd === 'chats') {
    const chats = await findChats({ token, ...apiBase });
    if (!chats.length) return log('Бот пока ничего не видел. Добавьте его в группу и напишите там сообщение, потом повторите.');
    for (const c of chats) log(`${c.id}\t${c.type}\t${c.title}${c.threads.length ? `\tтемы: ${c.threads.join(', ')}` : ''}`);
  } else if (cmd === 'send') {
    const tg = createTelegram({ token, chatId: env.TELEGRAM_CHAT_ID, threadId: env.TELEGRAM_THREAD_ID, ...apiBase });
    await tg.send(rest.join(' ') || 'meatsuit: проверка связи');
    log('отправлено');
  } else {
    log(USAGE);
  }
}

module.exports = { main };

if (require.main === module) {
  main(process.argv.slice(2), process.env).catch((e) => { console.error(e.message); process.exit(1); });
}
