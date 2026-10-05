/**
 * Всплывающее на странице: диалоги, баннеры cookies, подписки, лишние вкладки.
 * Человек такое закрывает и идёт дальше; бот, который застрял под баннером, выдаёт себя.
 *
 * Правила, ради которых код осторожен:
 *   - нажимаются только кнопки закрытия и отказа, по подписи. Подписка, установка, вход,
 *     «разрешить» и всё рекламное под запретом по названию кнопки;
 *   - внутрь iframe не кликаем никогда: там живёт реклама, а клик по рекламе из скрипта —
 *     накрутка для рекламодателя (probe.overlays рекламные фреймы вообще не отдаёт);
 *   - нечем закрыть — один Esc, не помогло — «не закрылось», сессия уходит с сайта.
 */
const human = require('../human.js');
const { clamp, lognormal } = require('../human/random');

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

const CLOSE = /^(×|✕|✖|x|close|dismiss|закрыть|не сейчас|позже|потом|no,? thanks|no thanks|not now|maybe later|skip|нет,? спасибо|пропустить|отмена|cancel|block|deny|не разрешать|нет|no)$/;
const REJECT = /^(reject( all)?|decline( all)?|only (strictly )?necessary( cookies)?|necessary only|use necessary cookies only|отклонить( все)?|только необходимые|отказаться( от всех)?|не принимать)$/;
const ACCEPT = /^(accept( all)?( cookies)?|allow( all)?( cookies)?|agree|i agree|ok|okay|got it|принять( все)?( cookies)?|согласен|согласна|понятно|хорошо|разрешить все)$/;
const FORBIDDEN = /subscribe|sign.?up|install|download|get (the )?app|open (in )?app|log.?in|sign.?in|register|buy|продолж[а-яё]* с|подпис|установ|скача|в приложени|войти|регистр|купить|реклам|\bads?\b|sponsor/;

/**
 * Какую кнопку нажать на всплывающем. overlay: { kind: 'consent'|'dialog', buttons: [{ref, name, corner}] }.
 * Баннер cookies: по политике consent ('reject' — отказ, 'accept' — согласие); нет ни того ни другого
 * кроме «Принять» — принимает, иначе баннер перекрывает сайт. Обычный диалог: только закрытие и отказ.
 * Безымянный значок в верхнем правом углу (крестик без подписи) годится, но последним.
 */
function chooseCloser(overlay, { consent = 'reject' } = {}) {
  const ok = overlay.buttons.filter((b) => !FORBIDDEN.test(norm(b.name)));
  const by = (re) => ok.find((b) => re.test(norm(b.name)));
  const corner = ok.find((b) => b.corner && !norm(b.name)) || null;
  if (overlay.kind === 'consent') {
    for (const re of consent === 'accept' ? [ACCEPT, REJECT, CLOSE] : [REJECT, CLOSE, ACCEPT]) {
      const b = by(re);
      if (b) return b;
    }
    return corner;
  }
  return by(CLOSE) || corner;
}

// Кнопка для human.click: прямоугольник каждый раз берётся у страницы заново.
const locatorFor = (page, probe, ref) => ({
  boundingBox: () => probe.boxOf(page, ref),
  scrollIntoViewIfNeeded: async () => {},
});

/**
 * Закрыть всплывающее. Возвращает { closed, stuck }: сколько закрыто и осталось ли что-то,
 * чего закрыть нечем или не удалось. probe — { overlays(page), boxOf(page, ref) }.
 */
async function dismissOverlays(page, env, probe, { consent = 'reject', log = () => {}, maxTries = 2 } = {}) {
  let closed = 0;
  for (let attempt = 0; attempt < maxTries; attempt++) {
    const list = await probe.overlays(page);
    if (!list.length) return { closed, stuck: false };
    const pick = list.map((overlay) => ({ overlay, button: chooseCloser(overlay, { consent }) })).find((x) => x.button);

    if (!pick) { // нечем закрыть: один Esc
      await human.press(page, 'Escape', env);
      await env.sleep(clamp(lognormal(env.rnd, 700, 0.4), 300, 2000));
      if (!(await probe.overlays(page)).length) { log({ event: 'overlay', result: 'closed', reason: 'Esc' }); return { closed: closed + 1, stuck: false }; }
      log({ event: 'overlay', result: 'stuck', reason: `нечем закрыть: ${list[0].kind}` });
      return { closed, stuck: true };
    }

    await env.sleep(clamp(lognormal(env.rnd, 1200, 0.4), 500, 4000)); // сначала «прочитать» всплывшее
    await human.click(page, locatorFor(page, probe, pick.button.ref), env);
    log({ event: 'overlay', result: 'closed', reason: `${pick.overlay.kind}: ${pick.button.name || 'крестик в углу'}` });
    closed++;
    await env.sleep(clamp(lognormal(env.rnd, 600, 0.4), 250, 2000));
  }
  const left = await probe.overlays(page);
  if (left.length) { log({ event: 'overlay', result: 'stuck', reason: 'появляется снова' }); return { closed, stuck: true }; }
  return { closed, stuck: false };
}

/**
 * Слежение за страницей: системные диалоги (alert, confirm, prompt) отклоняются, а из
 * beforeunload разрешается уйти; вкладки, всплывшие сами (реклама, window.open), закрываются.
 * Через человеческую паузу, а не мгновенно.
 */
function watchPage(page, env, log = () => {}) {
  if (!page || typeof page.on !== 'function') return;
  page.on('dialog', async (d) => {
    await env.sleep(clamp(lognormal(env.rnd, 1500, 0.4), 600, 5000));
    try { await (d.type() === 'beforeunload' ? d.accept() : d.dismiss()); } catch { /* уже закрыт */ }
    log({ event: 'dialog', reason: d.type() });
  });
  page.on('popup', async (popup) => {
    await env.sleep(clamp(lognormal(env.rnd, 1800, 0.4), 800, 6000));
    await popup.close().catch(() => {});
    log({ event: 'popup-closed' });
  });
}

module.exports = { chooseCloser, dismissOverlays, watchPage };
