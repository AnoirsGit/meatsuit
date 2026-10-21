/**
 * Локальный сайт для браузерных тестов: набор страниц по путям на свободном порту.
 *
 *   const site = await serve({ '/': '<h1>привет</h1>', '/slow': { body: '…', delay: 700 } });
 *   site.origin → 'http://127.0.0.1:PORT'; site.hits — пути запросов; await site.close()
 *
 * Маршрут: строка (HTML), {status, type, body, delay, headers} или функция (req, res).
 * Неизвестный путь отвечает 404.
 */
const http = require('node:http');

const wrap = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>Тест</title></head><body>${body}</body></html>`;

async function serve(routes) {
  const hits = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const pathOnly = req.url.split('?')[0];
    hits.push(req.url);
    const route = routes[req.url] ?? routes[pathOnly];
    if (typeof route === 'function') return route(req, res);
    const r = typeof route === 'string' ? { body: route } : route;
    const send = () => {
      res.writeHead(r ? r.status || 200 : 404, { 'content-type': (r && r.type) || 'text/html; charset=utf-8', ...(r && r.headers) });
      res.end(r ? (r.raw ? r.body : /<html/i.test(r.body) ? r.body : wrap(r.body)) : wrap('нет такой страницы'));
    };
    if (r && r.delay) setTimeout(send, r.delay); else send();
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    hits,
    close: () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(resolve); }),
  };
}

module.exports = { serve, wrap };
