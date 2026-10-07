#!/usr/bin/env node
/**
 * npm run init: создать файл деплоя зеркала из docker/.env.example.
 *
 *   npm run init                         docker/.env
 *   npm run init -- --file <путь>        или MEATSUIT_CONFIG=<путь> npm run init
 *
 * Пароли зеркала — случайный hex (32 знака), права 0600. Файл уже есть — ничего не меняется (даже права),
 * только подсказка, если в нём что-то не так. Пароли не печатаются никогда.
 */
const path = require('node:path');
const { defaultFile, createNew, fromTemplate, read, validate } = require('../config.js');

function parseArgs(argv, env) {
  const i = argv.indexOf('--file');
  if (i >= 0 && !argv[i + 1]) throw new Error('--file: нужен путь');
  return { file: i >= 0 ? path.resolve(argv[i + 1]) : defaultFile(env) };
}

function main(argv = process.argv.slice(2), env = process.env, out = console.log) {
  const { file } = parseArgs(argv, env);
  const r = path.relative(process.cwd(), file);
  const rel = r && !r.startsWith('..') ? r : file;
  const envFlag = file === defaultFile({}) ? '' : ` --env-file ${file}`;
  if (createNew(file, fromTemplate())) {
    out(`init: создан ${rel} (права 0600), пароли зеркала случайные.`);
    out(`init: посмотреть пароль для входа в зеркало: grep NEKO_ ${rel}; поменять настройки: npm run config`);
    out(`init: применить: cd docker && docker compose${envFlag} up -d`);
    return 0;
  }
  const cur = read(file);
  out(`init: ${rel} уже есть, ничего не меняю.`);
  if (cur.exists) {
    const errors = validate(cur.values);
    for (const e of errors) out(`init:   ${e.key}: ${e.message}`);
    if (errors.length) out('init: исправьте это руками или через npm run config.');
    if (cur.mode !== 0o600) out(`init: права файла ${cur.mode.toString(8)}, лучше 600: chmod 600 ${rel}`);
  }
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (e) { console.error(`init: ${e.message}`); process.exitCode = 1; }
}

module.exports = { main, parseArgs };
