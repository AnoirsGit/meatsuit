/**
 * Повадки «человека в браузере» на диске: <dir>/persona.json (темп руки, дрожь, подёргивания,
 * скорость печати, доля опечаток). dir — каталог состояния из connect({ dir }), общий у всех
 * вызывающих одного браузера: после перезапуска и из любого проекта в браузере тот же человек.
 * Файл живёт рядом с замком очереди и счётчиками, вне репозитория.
 */
const fs = require('node:fs');
const path = require('node:path');
const human = require('../human.js');

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** Прочитать повадки из dir/persona.json, подставить в руки и сохранить. Нет файла или он испорчен — годные повадки взамен. */
function loadPersona(dir) {
  const file = path.join(dir, 'persona.json');
  const saved = readJson(file);
  const persona = human.restorePersona(saved);
  fs.mkdirSync(dir, { recursive: true });
  if (JSON.stringify(saved) !== JSON.stringify(persona)) fs.writeFileSync(file, JSON.stringify(persona, null, 2) + '\n');
  human.usePersona(persona);
  return persona;
}

module.exports = { loadPersona };
