/**
 * Архив экранов: подпись, санитизация HTML, лимиты, запись через hands на настоящем Chromium.
 *
 *   node test/capture.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { signature, sanitizeHtml, createCapture, urlPattern } = require('../capture.js');
const { hands } = require('../hands.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-cap-'));
const link = (i, name, key) => ({ id: i, role: 'link', name, href: `/app/messages/${key}` });
const list = (people) => ({
  url: 'https://tinder.com/app/matches', title: 'Tinder', text: '', dialogs: [], frames: [],
  elements: [{ id: 1, role: 'link', name: 'Matches', href: '/app/matches' },
    ...people.map(([n, k], i) => link(i + 2, n, k))],
});
const chat = (msgs, who = 'Анна', key = '5f8a1c2d3e4f5a6b7c8d9e0f') => ({
  url: `https://tinder.com/app/messages/${key}?x=1`, title: `Чат с ${who}`, text: msgs.join('\n'), dialogs: [], frames: [],
  elements: [{ id: 1, role: 'textbox', name: 'Напишите сообщение' }, { id: 2, role: 'button', name: 'Отправить' }],
});
const P = (n, seed = '') => Array.from({ length: n }, (_, i) => [`Имя${seed}${i} ${20 + i}`, `a1b2c3d4e5f6a7b8c9d0e${seed.length}${i}`]);
const sig = (s) => signature(s).hash;

(async () => {
  // ---- signature: та же структура, другие люди/тексты/id/цифры → та же подпись ----
  assert.equal(sig(list(P(3))), sig(list(P(3, 'Z').map(([n, k], i) => [`Совсем Другая ${i + 40}`, 'ffff' + k]))));
  assert.equal(sig(list(P(3))), sig(list(P(4))), '3 и 4 матча: одна подпись (2-5)');
  assert.equal(sig(chat(['привет', 'как дела'])), sig(chat(Array.from({ length: 20 }, (_, i) => `сообщение ${i}`), 'Вика', '0a1b2c3d4e5f6a7b8c9d0e1f')));
  assert.equal(sig({ ...chat([]), url: 'https://tinder.com/app/messages/12345678' }), sig(chat([])));
  assert.equal(urlPattern('https://tinder.com/app/messages/5f8a1c2d3e4f?x=1#h'), '/app/messages/:id');
  assert.equal(urlPattern('https://tinder.com/app/matches'), '/app/matches');

  const withBadge = (n) => { const x = chat([]); x.elements.push({ id: 5, role: 'button', name: `Лайки: ${n}` }); return x; };
  assert.equal(sig(withBadge(5)), sig(withBadge(123)), 'цифры в именах не влияют');
  assert.equal(sig(withBadge(1)), sig({ ...withBadge(2), elements: withBadge(2).elements.map((e) => (e.id === 5 ? { ...e, name: 'лайки: 77' } : e)) }));

  // ---- другая структура → другая подпись ----
  assert.notEqual(sig(list(P(3))), sig(list(P(7))), '3 и 7: разные подписи (2-5 против 6+)');
  assert.notEqual(sig(list(P(1))), sig(list(P(3))), '1 и 3: разные подписи');
  assert.notEqual(sig(list(P(3))), sig(list([])), 'пустой список — другой экран');
  assert.notEqual(sig(chat([])), sig(list(P(3))));
  const withDialog = { ...chat([]), dialogs: [{ name: 'Match!', elements: [2] }] };
  assert.notEqual(sig(chat([])), sig(withDialog), 'диалог меняет подпись');
  assert.notEqual(sig(withDialog), sig({ ...chat([]), dialogs: [{ name: 'x', elements: [1] }] }), 'другой состав диалога');
  assert.notEqual(sig(chat([])), sig({ ...chat([]), frames: ['https://client-api.arkoselabs.com/x'] }), 'frames меняют подпись');
  const extra = chat([]); extra.elements.push({ id: 9, role: 'button', name: 'Unmatch' });
  assert.notEqual(sig(chat([])), sig(extra), 'лишняя кнопка');
  const filled = chat([]); filled.elements[0].value = 'черновик';
  assert.notEqual(sig(chat([])), sig(filled), 'поле с текстом отличается от пустого');
  assert.notEqual(sig(chat([])), sig({ ...chat([]), url: 'https://tinder.com/app/settings' }), 'другой адрес');
  const { shape } = signature(list(P(3)));
  assert.ok(!/Имя|Совсем/.test(shape) && shape.includes('<имя>'), shape);

  // ---- sanitizeHtml ----
  const dirty = `<html><head><style>.secret{content:"CSS-СЕКРЕТ"}</style><script>window.TOKEN="СЕКРЕТ-ТОКЕН"</script>
    <SCRIPT type="x">more СЕКРЕТ2</SCRIPT></head><body class="keep">
    <input type="password" value="пароль123" name="p"><input type='password' class=a value='п2'>
    <input type="text" value="видно"><input type="hidden" value="csrf-СЕКРЕТ">
    <img src="data:image/png;base64,${'A'.repeat(500)}"><img src="data:image/gif;base64,R0lG"><script>незакрытый СЕКРЕТ3`;
  const clean = sanitizeHtml(dirty);
  assert.ok(!/СЕКРЕТ|пароль123|п2|csrf|AAAA/.test(clean), clean);
  assert.ok(clean.includes('class="keep"') && clean.includes('data:image/gif;base64,R0lG'), 'лишнее вырезано');
  // value обычных полей (автозаполнение: почта, телефон) тоже убирается; у кнопок и переключателей остаётся.
  const forms = sanitizeHtml('<input type="text" value="видно"><input name=e type="email" value="me@example.com"><input type="tel" value="+77070000000"><input value="без типа"><input type="checkbox" value="rock" checked><input type="submit" value="Отправить"><input type="radio" value="да">');
  assert.ok(!/видно|me@example|7070000000|без типа/.test(forms), forms);
  assert.ok(forms.includes('value="rock"') && forms.includes('value="Отправить"') && forms.includes('value="да"'), 'у кнопок и переключателей value нужен: ' + forms);
  // токены в <meta>
  const meta = sanitizeHtml('<meta name="csrf-token" content="СЕКРЕТ-CSRF"><meta name="viewport" content="width=device-width"><meta content="СЕКРЕТ-N" name="nonce">');
  assert.ok(!/СЕКРЕТ/.test(meta) && meta.includes('width=device-width'), meta);
  assert.ok(clean.includes('data:[вырезано]'));

  // ---- лимиты ----
  const day = (d) => () => new Date(`2026-01-${String(d).padStart(2, '0')}T10:00:00Z`);
  const dir = tmp();
  let fetched = 0;
  const html = async () => { fetched++; return '<p>x</p>'; };
  const cap = createCapture({ dir, htmlPerSignature: 2, now: day(1) });
  for (let i = 0; i < 5; i++) await cap.write(list(P(3, String(i))), null, html);
  await cap.write(chat([]), null, html);
  const files = fs.readdirSync(path.join(dir, '2026-01-01'));
  assert.equal(files.filter((f) => f.endsWith('.html')).length, 3, 'не больше 2 HTML на подпись (+1 на вторую подпись)');
  assert.equal(files.filter((f) => f.endsWith('.json')).length, 6, 'снимок пишется всегда');
  assert.equal(fetched, 3, 'лишний page.content() не зовётся');
  // счётчики переживают перезапуск
  await createCapture({ dir, htmlPerSignature: 2, now: day(1) }).write(list(P(3)), null, html);
  assert.equal(fs.readdirSync(path.join(dir, '2026-01-01')).filter((f) => f.endsWith('.html')).length, 3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '2026-01-01/00007.json'), 'utf8')).signature, sig(list(P(3))), 'seq продолжается');

  const dir2 = tmp();
  const big = async () => '<p>' + 'x'.repeat(40_000) + '</p>';
  for (let d = 1; d <= 4; d++) {
    const c = createCapture({ dir: dir2, htmlPerSignature: 100, maxMB: 0.1, now: day(d) });
    for (let i = 0; i < 2; i++) await c.write(list(P(3)), null, big);
  }
  const days = fs.readdirSync(dir2).filter((n) => /^2026/.test(n));
  assert.ok(days.includes('2026-01-04') && !days.includes('2026-01-01'), `старые даты удалены, свежая цела: ${days}`);

  // ---- через hands на настоящем Chromium ----
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(`<title>Вход</title><script>window.t="СЕКРЕТ-В-СКРИПТЕ"</script><style>b{color:red}</style>
    <input type="password" aria-label="Пароль" value="hunter2"><button>Like</button>`);
  const adir = tmp();
  const h = hands(page, { capture: { dir: adir, htmlPerSignature: 1 } });
  await h.see();
  await h.see(); // вторая страница той же подписи: HTML уже не пишется
  const dd = path.join(adir, fs.readdirSync(adir).find((n) => /^\d{4}-/.test(n)));
  const out = fs.readdirSync(dd);
  assert.equal(out.filter((f) => f.endsWith('.html')).length, 1, out.join());
  const saved = fs.readFileSync(path.join(dd, out.find((f) => f.endsWith('.html'))), 'utf8');
  assert.ok(!/СЕКРЕТ-В-СКРИПТЕ|hunter2|color:red/.test(saved) && /<button>Like/.test(saved), saved);
  const rec = JSON.parse(fs.readFileSync(path.join(dd, out.find((f) => f.endsWith('.json'))), 'utf8'));
  assert.equal(rec.signature.length, 10);
  assert.equal(rec.snapshot.elements.find((e) => e.role === 'button').name, 'Like');
  assert.equal(await page.evaluate(() => window.t), 'СЕКРЕТ-В-СКРИПТЕ', 'страница не изменилась');
  // сбой архива не роняет see()
  const bad = hands(page, { capture: { dir: path.join(adir, 'html-counts.json', 'x') } });
  assert.ok((await bad.see()).elements.length);
  await browser.close();
  console.log('capture: ok');
})().catch((e) => { console.error(e); process.exit(1); });
