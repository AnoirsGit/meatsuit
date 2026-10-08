// Управление зеркалом по протоколу Neko (так же шлёт события веб-клиент): войти, взять управление,
// набрать адрес клавишами, нажать Enter, прокрутить колесом. Запускается внутри контейнера life,
// у которого сеть общая с Neko, поэтому адреса 127.0.0.1.
//   NEKO_PASSWORD=… URL=en.wikipedia.org/wiki/web_browser SCROLL=8 node mirror.mjs
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = process.env.NEKO || 'http://127.0.0.1:8080';
const url = process.env.URL || 'example.com';
const scrolls = Number(process.env.SCROLL || 0);

const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'verify', password: process.env.NEKO_PASSWORD }) });
if (!res.ok) { console.error(`вход не удался: HTTP ${res.status} (пароль участника верный?)`); process.exit(1); }
const login = await res.json();
const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/ws?token=${encodeURIComponent(login.token)}`);
await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error('WebSocket не открылся')); });
await sleep(1200);
const send = (event, payload) => ws.send(JSON.stringify({ event, payload }));
send('control/request');
await sleep(600);

const KS = { Control: 65507, Return: 65293, Shift: 65505 };
const tap = async (keysym, hold = 40) => { send('control/keydown', { keysym }); await sleep(hold); send('control/keyup', { keysym }); await sleep(60); };
const chord = async (letter) => { send('control/keydown', { keysym: KS.Control }); await sleep(40); await tap(letter.charCodeAt(0)); send('control/keyup', { keysym: KS.Control }); await sleep(150); };

await chord('l');            // адресная строка в фокус
await chord('a');            // выделить всё, чтобы набираемое заменило содержимое
// Как живая клавиатура в веб-клиенте Neko: заглавные и символы верхнего ряда — с зажатым Shift (без него X сервер
// зеркала печатал «web_browser#» как «webbrowser»: символы терялись).
const needsShift = (ch) => /[A-Z~!@#$%^&*()_+{}|:"<>?]/.test(ch);
for (const ch of url) {
  if (needsShift(ch)) { send('control/keydown', { keysym: KS.Shift }); await sleep(30); }
  await tap(ch.charCodeAt(0), 35);
  if (needsShift(ch)) { send('control/keyup', { keysym: KS.Shift }); await sleep(30); }
}
await sleep(700);
await tap(KS.Return, 80);
await sleep(Number(process.env.LOAD_MS || 9000));
if (scrolls) {
  send('control/move', { x: 500, y: 400 });
  await sleep(500);
  for (let i = 0; i < scrolls; i++) { send('control/scroll', { delta_x: 0, delta_y: -360, control_key: false }); await sleep(250); } // минус — вниз
  await sleep(1500);
}
ws.close();
console.log('отправлено');
