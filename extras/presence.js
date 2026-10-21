/**
 * Хозяин у руля? Neko знает, кто сейчас держит управление браузером в зеркале (`GET /api/room/control`
 * → { has_host, host_id }). Пока хозяин управляет, боту работать нельзя: сайт увидел бы две руки у
 * одного человека, а хозяин — чужой курсор. Смотреть в зеркало можно: кто только смотрит, управления
 * не держит (хостинг в Neko неявный: берётся первым движением мыши над видео).
 *
 *   const presence = createPresence({ url: 'http://127.0.0.1:8080', username: 'meatsuit', password })
 *   await presence.check()  → { present: true|false, hostId?, error? }
 *
 * Хост, который закрыл вкладку зеркала, не отпустив управление, у Neko остаётся хостом ещё какое-то
 * время (измерено 20.10.2026: сразу после отключения has_host всё ещё true). Поэтому при has_host
 * сверяемся с `GET /api/sessions`: если сессия хоста не подключена (state.is_connected false), хозяина
 * нет. Вход по паролю администратора (`POST /api/login` отдаёт token; sessions доступен только
 * администратору), токен держится, пока Neko его принимает; на 401 вход повторяется. Ответ кэшируется
 * ttlMs. Сбой Neko или сети — present: false с полем error: присутствие — вежливость, а не
 * предохранитель, и падать из-за него сервис не должен. Без url присутствие выключено: check() всегда
 * { present: false, disabled: true }. Сеть и время подставляются. Проверено на Neko 3.1.6 (20.10.2026):
 * формы ответов login, sessions, room/control такие, как здесь.
 */
const MIN = 60000;

function createPresence({ url, username = 'meatsuit', password, fetch = globalThis.fetch, now = Date.now, ttlMs = 5000, timeoutMs = 4000 } = {}) {
  const base = url ? String(url).replace(/\/+$/, '') : null;
  let token = null;
  let cached = null; // { result, at }
  let inflight = null;

  const call = (path, init = {}) => fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json', ...(init.headers || {}) } });

  async function login() {
    if (!password) throw new Error('нет пароля администратора Neko (NEKO_ADMIN_PASSWORD)');
    const res = await call('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    if (!res.ok) throw new Error(`вход в Neko: HTTP ${res.status}`);
    const body = await res.json();
    if (!body || typeof body.token !== 'string' || !body.token) throw new Error('вход в Neko: в ответе нет token');
    token = body.token;
  }

  async function get(path, retry = true) {
    if (!token) await login();
    const res = await call(path, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 401 && retry) { token = null; return get(path, false); } // сессия в Neko истекла или Neko перезапущен
    if (!res.ok) throw new Error(`Neko ${path}: HTTP ${res.status}`);
    return res.json();
  }

  async function control() {
    const body = await get('/api/room/control');
    if (!body || !body.has_host) return { present: false };
    const hostId = body.host_id ? String(body.host_id) : null;
    if (hostId) { // хост есть, но подключён ли он: ушедший с управлением в руках хозяином не считается
      const sessions = await get('/api/sessions');
      const host = Array.isArray(sessions) ? sessions.find((x) => x && x.id === hostId) : null;
      if (host && host.state && host.state.is_connected === false) return { present: false, hostId, stale: true };
    }
    return { present: true, ...(hostId ? { hostId } : {}) };
  }

  function check({ force = false } = {}) {
    if (!base) return Promise.resolve({ present: false, disabled: true });
    if (!force && cached && now() - cached.at < ttlMs) return Promise.resolve(cached.result);
    if (!inflight) {
      inflight = control().catch((err) => ({ present: false, error: err.message }))
        .then((result) => { cached = { result, at: now() }; return result; })
        .finally(() => { inflight = null; });
    }
    return inflight;
  }

  /** Снять свою сессию в Neko при остановке; сбой не важен. */
  async function logout() {
    if (!base || !token) return;
    const t = token;
    token = null;
    await call('/api/logout', { method: 'POST', headers: { authorization: `Bearer ${t}` } }).catch(() => {});
  }

  return { check, logout, enabled: !!base, last: () => (cached ? cached.result : null) };
}

/** Из окружения: MEATSUIT_NEKO_URL (нет — выключено) и NEKO_ADMIN_PASSWORD. */
const fromEnv = (env = process.env, opts = {}) => createPresence({ url: env.MEATSUIT_NEKO_URL, password: env.NEKO_ADMIN_PASSWORD, ...opts });

module.exports = { createPresence, fromEnv, MIN };
