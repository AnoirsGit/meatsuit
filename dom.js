/**
 * Доступ к странице через CDP, ничего в неё не записывая.
 *
 * Элементы из снимка лежат в изолированном мире (Page.createIsolatedWorld): это отдельный
 * JS-контекст со своим global, он видит тот же DOM, а скрипты сайта его не видят. Ни
 * атрибутов в DOM, ни свойств в window страницы не остаётся. Мир создаётся заново при
 * каждом снимке: после загрузки нового документа старый мир умирает, и устаревший id
 * не может попасть в чужой элемент.
 */
class StaleWorld extends Error {}

const sessions = new WeakMap();

async function cdpOf(page) {
  let s = sessions.get(page);
  if (!s) {
    s = await page.context().newCDPSession(page);
    sessions.set(page, s);
  }
  return s;
}

async function openWorld(page) {
  const cdp = await cdpOf(page);
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
    frameId: frameTree.frame.id,
    worldName: 'meatsuit',
  });
  return { cdp, contextId: executionContextId };
}

const GONE = /Cannot find context|Execution context was destroyed|Target closed|Session closed|detached/i;

/** Выполнить fn(arg) в мире. fn — самодостаточная функция. */
async function run(world, fn, arg) {
  let res;
  try {
    res = await world.cdp.send('Runtime.evaluate', {
      contextId: world.contextId,
      expression: `(${fn})(${JSON.stringify(arg ?? null)})`,
      returnByValue: true,
    });
  } catch (err) {
    if (GONE.test(err.message)) throw new StaleWorld(err.message);
    throw err;
  }
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  return res.result.value;
}

/**
 * Элемент по номеру из снимка, в виде, который понимает human.click:
 * scrollIntoViewIfNeeded() и boundingBox().
 */
function handle(world, id) {
  return {
    async same() { return run(world, (i) => globalThis.__ms.same(i), id); },
    async boundingBox() { return run(world, (i) => globalThis.__ms.box(i), id); },
    async scrollIntoViewIfNeeded() {
      let res;
      try {
        res = await world.cdp.send('Runtime.evaluate', { contextId: world.contextId, expression: `__ms.els[${Number(id)}]` });
      } catch (err) {
        if (GONE.test(err.message)) throw new StaleWorld(err.message);
        throw err;
      }
      if (!res.result.objectId) throw new StaleWorld(`элемента ${id} нет`);
      await world.cdp.send('DOM.scrollIntoViewIfNeeded', { objectId: res.result.objectId });
    },
  };
}

module.exports = { openWorld, run, handle, StaleWorld };
