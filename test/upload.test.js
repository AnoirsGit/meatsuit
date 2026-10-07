/**
 * upload: файл из uploadDirs в форму. Поле <input type=file> (видимое, спрятанное за меткой, прозрачное
 * поверх метки) и кнопка, которая открывает выбор файла. Отказы до действия, dryRun, журнал без имени файла,
 * имя прикреплённого файла в снимке. Настоящий Chromium с портом отладки, как у Neko.
 *
 *   node test/upload.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { connect, hands, BadCommand } = require('../index.js');
const { validate } = require('../hands.js');

const PORT = 9351;
const SHOW = (n) => `document.getElementById('n${n}').textContent = [...this.files].map((f) => f.name + ':' + f.size + ':' + f.type).join('|')`;
const FORM = `<body style="margin:0;font:16px sans-serif">
  <div><input type="file" id="f1" aria-label="Резюме" accept=".pdf,.doc,.docx" onchange="${SHOW(1)}"> <span id="n1"></span></div>
  <div><label for="f2" style="display:inline-block;padding:10px;border:1px solid #888">Прикрепить письмо</label>
    <input type="file" id="f2" style="display:none" onchange="${SHOW(2)}"> <span id="n2"></span></div>
  <div><button type="button" id="b3" onclick="document.getElementById('f3').click()">Attach</button>
    <input type="file" id="f3" hidden onchange="${SHOW(3)}"> <span id="n3"></span></div>
  <div><label style="position:relative;display:inline-block;padding:10px;border:1px solid #888">ATTACH RESUME/CV
    <input type="file" id="f4" aria-label="Lever resume" style="position:absolute;inset:0;opacity:0;width:100%" onchange="${SHOW(4)}"></label> <span id="n4"></span></div>
  <div><button type="button" id="b5">Ничего не открывает</button></div>
  <div><input type="file" id="f6" aria-label="Недоступное" disabled></div>
</body>`;

const readLog = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse);
const byName = (s, name, inputType) => s.elements.find((e) => e.name === name && (inputType === undefined || e.inputType === inputType));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-upload-'));
  const docs = path.join(tmp, 'docs');
  const other = path.join(tmp, 'other');
  fs.mkdirSync(docs);
  fs.mkdirSync(other);
  const pdf = Buffer.from('%PDF-1.4\n% meatsuit test\n1 0 obj << >> endobj\n%%EOF\n');
  const cv = path.join(docs, 'cv.pdf');
  const letter = path.join(docs, 'letter.docx');
  fs.writeFileSync(cv, pdf);
  fs.writeFileSync(letter, Buffer.from('PK\u0003\u0004 docx stub'));
  fs.writeFileSync(path.join(docs, 'big.pdf'), Buffer.alloc(10 * 1024 * 1024 + 1, 0x25));
  fs.writeFileSync(path.join(docs, 'empty.pdf'), '');
  fs.writeFileSync(path.join(docs, 'note.txt'), 'x');
  fs.writeFileSync(path.join(other, 'secret.pdf'), pdf);
  fs.symlinkSync(path.join(other, 'secret.pdf'), path.join(docs, 'link.pdf')); // ссылка изнутри наружу
  fs.symlinkSync(path.join(docs, 'note.txt'), path.join(docs, 'note-link.pdf')); // ссылка на чужой тип
  const uploadDirs = [docs];

  // --- validate: без uploadDirs загрузки нет; путь абсолютный, внутри uploadDirs, pdf/doc/docx.
  const rejects = (c, opts, re) => assert.throws(() => validate(c, [], opts), (e) => e instanceof BadCommand && (!re || re.test(e.message)), JSON.stringify(c));
  const up = (file, extra = {}) => ({ cmd: 'upload', id: 1, gen: 1, file, ...extra });
  rejects(up(cv), undefined, /uploadDirs/);
  rejects(up(cv), { uploadDirs: [] }, /uploadDirs/);
  rejects(up('docs/cv.pdf'), { uploadDirs }, /абсолютный/);
  rejects(up(path.join(docs, 'note.txt')), { uploadDirs }, /pdf, doc, docx/);
  rejects(up(path.join(other, 'secret.pdf')), { uploadDirs }, /вне uploadDirs/);
  rejects(up(path.join(docs, '..', 'other', 'secret.pdf')), { uploadDirs }, /вне uploadDirs/);
  rejects(up(docs + '.pdf'), { uploadDirs }, /вне uploadDirs/); // соседний каталог с тем же началом имени
  rejects({ cmd: 'upload', gen: 1, file: cv }, { uploadDirs });
  rejects(up(42), { uploadDirs });
  validate(up(cv), [], { uploadDirs });
  validate(up(path.join(docs, 'CV.PDF')), [], { uploadDirs }); // расширение без учёта регистра

  const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), { headless: true, args: [`--remote-debugging-port=${PORT}`] });
  await ctx.route('https://form.test/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: FORM }));
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto('https://form.test/apply');
  const logFile = path.join(tmp, 'journal.jsonl');
  const h = hands(page, { logFile, uploadDirs });

  // --- Глаза: поле файла в снимке, даже спрятанное, если видна его метка или кнопка рядом.
  const s0 = await h.see();
  const f1 = byName(s0, 'Резюме', 'file');
  assert.ok(f1, 'видимое поле файла не в снимке: ' + JSON.stringify(s0.elements));
  assert.equal(f1.role, 'button');
  assert.equal(f1.value, '', 'до загрузки value пустое');
  assert.ok(byName(s0, 'Прикрепить письмо', 'file'), 'поле за меткой (display:none) не в снимке');
  assert.ok(byName(s0, 'Attach', 'file'), 'поле рядом с кнопкой (hidden) не в снимке');
  assert.ok(byName(s0, 'Attach').inputType === undefined, 'сама кнопка Attach должна быть в снимке первой');
  assert.ok(byName(s0, 'Lever resume', 'file'), 'прозрачное поле поверх метки не в снимке');
  assert.ok(byName(s0, 'ATTACH RESUME/CV') === undefined || byName(s0, 'ATTACH RESUME/CV').inputType === 'file');

  // --- Отказы при выполнении, до любого действия: ссылка наружу, ссылка на чужой тип, больше 10 МБ, пустой, нет файла,
  // недоступное поле, не поле файла и не кнопка выбора. В сообщениях нет пути.
  const refuse = async (c, re) => {
    await assert.rejects(h.act(c), (e) => e instanceof BadCommand && re.test(e.message) && !e.message.includes(tmp), JSON.stringify(c));
  };
  const at = (s, name, type) => ({ id: byName(s, name, type).id, gen: s.gen });
  await refuse({ cmd: 'upload', ...at(s0, 'Резюме', 'file'), file: path.join(docs, 'link.pdf') }, /вне uploadDirs/);
  await refuse({ cmd: 'upload', ...at(s0, 'Резюме', 'file'), file: path.join(docs, 'note-link.pdf') }, /pdf, doc, docx/);
  await refuse({ cmd: 'upload', ...at(s0, 'Резюме', 'file'), file: path.join(docs, 'big.pdf') }, /10 МБ/);
  await refuse({ cmd: 'upload', ...at(s0, 'Резюме', 'file'), file: path.join(docs, 'empty.pdf') }, /пустой/);
  await refuse({ cmd: 'upload', ...at(s0, 'Резюме', 'file'), file: path.join(docs, 'nope.pdf') }, /нет файла/);
  await refuse({ cmd: 'upload', ...at(s0, 'Недоступное', 'file'), file: cv }, /недоступно/);
  // click и fill по полю файла открыли бы системное окно выбора: только upload.
  await refuse({ cmd: 'click', ...at(s0, 'Резюме', 'file') }, /upload/);
  await refuse({ cmd: 'fill', ...at(s0, 'Резюме', 'file'), text: cv }, /upload/);
  assert.deepEqual(await page.evaluate(() => [1, 2, 3, 4].map((n) => document.getElementById('f' + n).files.length)), [0, 0, 0, 0], 'отказ что-то прикрепил');

  // --- Видимое поле: файл встаёт буфером, со своим именем, размером и типом; имя видно в снимке.
  const r1 = await h.act({ cmd: 'upload', ...at(s0, 'Резюме', 'file'), file: cv });
  assert.equal(await page.textContent('#n1'), `cv.pdf:${pdf.length}:application/pdf`);
  assert.equal(await page.evaluate(() => document.getElementById('f1').files[0].text()), pdf.toString(), 'содержимое файла не то');
  assert.equal(byName(r1, 'Резюме', 'file').value, 'cv.pdf', 'имя прикреплённого файла не видно в снимке');
  assert.ok(r1.text.includes('cv.pdf'), 'имя файла должно быть в тексте страницы');

  // --- Спрятанное за меткой поле и прозрачное поле поверх метки.
  const r2 = await h.act({ cmd: 'upload', ...at(r1, 'Прикрепить письмо', 'file'), file: letter });
  assert.equal(await page.textContent('#n2'), `letter.docx:${fs.statSync(letter).size}:application/vnd.openxmlformats-officedocument.wordprocessingml.document`);
  assert.equal(byName(r2, 'Прикрепить письмо', 'file').value, 'letter.docx');
  const r4 = await h.act({ cmd: 'upload', ...at(r2, 'Lever resume', 'file'), file: cv });
  assert.equal(await page.textContent('#n4'), `cv.pdf:${pdf.length}:application/pdf`);
  assert.equal(byName(r4, 'Lever resume', 'file').value, 'cv.pdf');

  // --- Кнопка, которая открывает выбор файла: человеческий клик, окно выбора перехвачено, файл встал.
  const attach = r4.elements.find((e) => e.name === 'Attach' && e.inputType === undefined);
  const r3 = await h.act({ cmd: 'upload', id: attach.id, gen: r4.gen, file: cv });
  assert.equal(await page.textContent('#n3'), `cv.pdf:${pdf.length}:application/pdf`);
  assert.equal(byName(r3, 'Attach', 'file').value, 'cv.pdf');
  // Кнопка, которая окна выбора не открывает: BadCommand, ничего не прикреплено.
  await refuse({ cmd: 'upload', ...at(r3, 'Ничего не открывает'), file: cv }, /не открыл выбор файла/);

  // --- Журнал: тип файла, без пути и имени.
  const lines = readLog(logFile).filter((l) => l.cmd.cmd === 'upload');
  assert.ok(lines.some((l) => l.result === 'ok' && l.cmd.fileType === 'pdf' && !('file' in l.cmd)), JSON.stringify(lines));
  const raw = fs.readFileSync(logFile, 'utf8');
  assert.ok(!raw.includes(tmp) && !raw.includes('cv.pdf') && !raw.includes('letter'), 'путь или имя файла в журнале');

  // --- dryRun: проверка файла есть, загрузки нет; в журнале dry-run.
  await page.goto('https://form.test/apply');
  const dry = hands(page, { dryRun: true, logFile, uploadDirs });
  const d0 = await dry.see();
  assert.deepEqual(await dry.act({ cmd: 'upload', ...at(d0, 'Резюме', 'file'), file: cv }), { dryRun: true, changed: false });
  await assert.rejects(dry.act({ cmd: 'upload', ...at(d0, 'Резюме', 'file'), file: path.join(docs, 'nope.pdf') }), /нет файла/);
  assert.equal(await page.evaluate(() => document.getElementById('f1').files.length), 0, 'dryRun прикрепил файл');
  assert.ok(readLog(logFile).some((l) => l.cmd.cmd === 'upload' && l.result === 'dry-run'));

  // --- task: uploadDirs из опций задачи; без них upload — BadCommand; неверный вид uploadDirs — ошибка до браузера.
  const sitesFile = path.join(tmp, 'sites.json');
  fs.writeFileSync(sitesFile, JSON.stringify({ 'form.test': { perDay: 100 } }));
  const ms = await connect({ cdpUrl: `http://127.0.0.1:${PORT}`, dir: path.join(tmp, 'state'), sitesFile });
  const viaTask = (opts) => ms.task('apply', async ({ see, act }) => {
    await act({ cmd: 'goto', url: 'https://form.test/apply' });
    const s = await see();
    const r = await act({ cmd: 'upload', ...at(s, 'Резюме', 'file'), file: cv });
    return byName(r, 'Резюме', 'file').value;
  }, { site: 'form.test', ...opts });
  assert.equal(await viaTask({ uploadDirs }), 'cv.pdf');
  await assert.rejects(viaTask({}), (e) => e instanceof BadCommand && /uploadDirs/.test(e.message));
  for (const bad of ['docs', ['relative/dir'], [42], {}]) {
    await assert.rejects(viaTask({ uploadDirs: bad }), /uploadDirs/, JSON.stringify(bad));
  }

  await ms.close();
  await ctx.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('upload.test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
