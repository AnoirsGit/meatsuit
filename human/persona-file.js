/**
 * Повадки «человека в браузере» на диске (data/persona.json): темп, дрожь, подёргивания, скорость печати.
 * Человек в браузере один, поэтому прогрев (life.js) и HTTP-сервис (server.js) берут один и тот же файл
 * и после перезапуска остаются тем же человеком. Для этого им нужен общий каталог data.
 */
const fs = require('node:fs');
const path = require('node:path');
const human = require('../human.js');

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** Прочитать повадки из dir/persona.json, подставить в руки и сохранить. Нет файла или он испорчен — годные повадки взамен. */
function loadPersona(dir) {
  const file = path.join(dir, 'persona.json');
  const persona = human.restorePersona(readJson(file));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(persona, null, 2));
  human.usePersona(persona);
  return persona;
}

module.exports = { loadPersona };
