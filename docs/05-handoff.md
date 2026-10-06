# Состояние и контекст для продолжения (2026-10-06)

Полный контекст обоих проектов: `../../tinder-matcher/HANDOFF.md` (читать первым).

Здесь: ветка `feat/eyes-hands-guard`, `npm test` = 9 наборов (human, eyes, hands, guard, telegram, telegram-e2e, task, review), все зелёные. Контракт для проектов: `docs/04-contract.md`. Дизайн рук и темпов мыши: `docs/03-design.md`.

Не проверено: реальный Neko и Brave на сервере, Patchright (подключён обычный playwright-core), живой Telegram, живые площадки. Открытые слабости meatsuit: shadow DOM не виден `guard`; замок очереди уязвим при гонке нескольких ждущих процессов; в dryRun `goto` выполняется (решение записано в контракте; строгий вариант откатывается одной строкой в `hands.js`).
