# План: кэш ответов Codex по {вопрос, SHA графа, версия промпта}

**Дата**: 2026-05-22 **Задача**: при повторе того же вопроса отдавать сохранённый ответ из
локального кэша, минуя вызов `codex exec`.

## Зачем именно так

**Hard-rule контекст.** В [CLAUDE.md](../CLAUDE.md), секция «What not to do», прямо сказано: _«Don't
add persistence (DB, response cache) without an explicit request»_. План существует именно как явный
запрос на response-cache и является основанием обойти это правило. Если запрос будет отозван — план
откатывается, файлы удаляются, env-переменные убираются.

Один и тот же вопрос приходит в бот по нескольку раз: тесты, расшаривание ссылок между коллегами,
повторные сессии. Каждый раз `codex exec` тратит 10–60 секунд и реальные токены. Ответ зависит от
**нормализованного** текста вопроса, состояния графа в `GRAPH_REPO_PATH`, содержимого системного
промпта, модели и `model_reasoning_effort` — все компоненты ключа детерминированы локально.

Альтернативы:

- Кэш в памяти процесса — теряется при рестарте, бесполезен для типового сценария.
- Внешний Redis/sqlite — лишняя зависимость, против минимализма.
- **Файловый JSON-кэш под `.cache/answers/<hash>.json`.** Без зависимостей, атомарная запись через
  tmp+rename, инвалидация бесплатно: при смене любого компонента ключа старые записи становятся
  недостижимы. Опциональная prune-команда — потом, если разрастётся.

Состав ключа:

- `question` — нормализованный (trim, NFC, collapse whitespace, lowercase). Опечатки и эмодзи
  _остаются_ частью ключа — это сознательный компромисс, иначе кэш отдаёт ответы на чужие вопросы.
- `graphSha` — `git rev-parse HEAD` в `GRAPH_REPO_PATH`. **Working tree должен быть чистым**: если
  `git status --porcelain` непустой → кэш off для этого запроса (warning в лог, обычный путь через
  Codex). Иначе закэшируем ответ по «старому» SHA при гряхой правке графа.
- `promptHash` — `sha256` содержимого `prompt.mjs` (не строковая константа). Любая правка преамбулы
  автоматически инвалидирует весь кэш — забыть бампнуть нельзя.
- `model`, `effort` — из `config.mjs` (`CODEX_MODEL`, `CODEX_EFFORT`). Смена effort с `medium` на
  `high` → новый ключ → свежий ответ.

Инвалидация через ключ, а не через explicit purge: меняется любой компонент → новый hash → miss.
Старые файлы остаются мусором, чистятся отдельно.

Приватность: кэш содержит **whitelist-only данные** (цитаты из приватного графа). `CACHE_DIR` по
умолчанию `.cache/answers` — обязательно в `.gitignore` (проверить, добавить если нет). В докер/CI
этот путь не маунтить. Документировать в env.example.

## Цель

Повторный вопрос (тот же текст, тот же SHA графа, та же версия промпта) обслуживается из файла за
миллисекунды. На первое попадание ответ пишется в кэш после успешного завершения Codex. Поведение
выключаемо через env.

## Scope

Входит:

- Новый модуль `src/cache.mjs`: `keyFor({question, graphSha, promptHash, model, effort})`,
  `get(key)`, `set(key, value)`. Нормализация вопроса внутри `keyFor`.
- `getGraphState()`: SHA через `git -C $GRAPH_REPO_PATH rev-parse HEAD` + `git status --porcelain`
  для проверки dirty. Если не git-репо или dirty — `{sha: null, dirty: true}`, кэш off.
- Производный `PROMPT_HASH` в [src/prompt.mjs](../src/prompt.mjs): `sha256` от текста преамбулы (или
  от содержимого файла через `import.meta`).
- Подключение в [src/bot.mjs](../src/bot.mjs): lookup перед `queue.add`, `set` после успешного
  ответа. Пустые/ошибочные ответы (`(Codex вернул пустой ответ)`, exceptions) **не кэшируем**.
- Конфиг: `CACHE_DIR` (default `.cache/answers`, валидируется через `resolve` + проверка, что путь
  под `process.cwd()` или явный абсолютный путь не равен `/`), `CACHE_ENABLED` (default `false` —
  opt-in, чтобы privacy-контракт не нарушался по умолчанию) в [src/config.mjs](../src/config.mjs) и
  [env.example](../env.example).
- Запись в `.gitignore` для `.cache/`.
- Запись через `O_EXCL` (`fs.open(tmpPath, 'wx')`) для защиты от race на одинаковом ключе.
- Юнит-тест на стабильность ключа, атомарность записи, нормализацию вопроса, поведение при dirty
  working tree, отказе writeFile, битом JSON в файле кэша.

Не входит:

- TTL, prune-команда, метрики hit-rate (отдельные задачи, если попросят).
- Инвалидация по таймеру/файлам.
- Шаринг кэша между инстансами бота.
- Inline-режим (фича 9) — отдельный план.

## Определение «готово»

- [ ] Повторный вопрос (нормализованный = тот же) отвечает мгновенно, без вызова `codex`
      (проверяется логом и отсутствием процесса).
- [ ] При изменении SHA графа (`git commit` в `GRAPH_REPO_PATH`) тот же вопрос идёт через Codex
      заново.
- [ ] При любой правке `src/prompt.mjs` (PROMPT_HASH меняется) все старые ключи становятся miss.
- [ ] При смене `CODEX_MODEL` или `CODEX_EFFORT` — miss.
- [ ] При грязном working tree в `GRAPH_REPO_PATH` (`git status --porcelain` непустой) — cache off,
      warning в лог, обычный путь через Codex.
- [ ] `CACHE_ENABLED=false` полностью отключает чтение и запись (default — `false`, opt-in).
- [ ] Пустые ответы и exceptions из `askCodex` **не пишутся** в кэш.
- [ ] Логи отмечают источник ответа: `source=cache` vs `source=codex`.
- [ ] Атомарность: при kill -9 во время записи на диске нет половинчатого JSON; конкурентные попытки
      записи одного ключа не перетирают друг друга (`O_EXCL`).
- [ ] Битый JSON в файле кэша → `get` возвращает `null`, ошибка логируется, файл _не_ удаляется
      автоматически (для ручного разбора).
- [ ] `CACHE_DIR` записан в `.gitignore`, документирован в `env.example` как whitelist-only данные.
- [ ] `npm run test:format`, новый `npm run test:cache`, `npm run ci:check` зелёные.

## Фазы и статус

- [ ] Фаза 0. В `src/prompt.mjs` экспортировать `PROMPT_HASH = sha256(SYSTEM_PREAMBLE)` (либо
      `sha256` файла через `readFileSync(import.meta.filename)`). Хэш считается один раз при
      загрузке модуля. Любая правка преамбулы → новый хэш автоматически.
- [ ] Фаза 1. `src/config.mjs`: `cacheDir` через
      `resolve(process.env.CACHE_DIR ?? ".cache/ answers")` + валидация (не равен `/`, не
      `~`-expanded в `/`). `cacheEnabled = process.env.CACHE_ENABLED === "true"` (opt-in, default
      false). Добавить `.cache/` в `.gitignore` (если ещё нет). Обновить
      [env.example](../env.example) с явным комментарием про privacy.
- [ ] Фаза 2. `src/cache.mjs`: - `normalizeQuestion(q)`:
      `q.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()`. -
      `keyFor({question, graphSha, promptHash, model, effort})`:
      `sha256(JSON.stringify([normalizeQuestion(question), graphSha, promptHash, model,       effort]))`,
      hex, первые 32 симв. - `get(key)`: `readFile`, парс JSON, `null` на ENOENT/parse-error (с
      warning в лог при parse-error, файл не удалять). - `set(key, value)`: `fs.open(tmpPath, 'wx')`
      (`O_EXCL`) → write → close → `rename`. На EEXIST — другой процесс/задача пишет тот же ключ,
      пропустить запись. Только Node stdlib.
- [ ] Фаза 3. `getGraphState()`: `execa('git', ['rev-parse', 'HEAD'], { cwd: graphRepoPath })` +
      `execa('git', ['status', '--porcelain'], { cwd: graphRepoPath })`. Возвращает `{sha, dirty}`.
      На ошибку git — `{sha: null, dirty: true}` (кэш off, warning). Кэшировать результат в памяти
      на ~30 секунд, инвалидировать в начале каждой задачи.
- [ ] Фаза 4. `src/bot.mjs`: перед `queue.add` собрать ключ из
      `{question,     graphState.sha, PROMPT_HASH, config.codexModel, config.codexEffort}`. Если
      `graphState.dirty` или `cacheEnabled === false` или `graphState.sha === null` — пропустить
      lookup, сразу через Codex. Если `cache.get` дал hit — `logTurn` с `source: "cache"`, отдать
      ответ через тот же `sendAnswer`. Если miss — обычный путь через `askCodex`, после успеха **и
      непустого ответа** (исключая sentinel `(Codex вернул пустой ответ)`) — `cache.set` с
      `{answer, tokens, model, effort, createdAt}`. Hit-путь по-прежнему идёт через очередь (нулевая
      работа, но порядок ответов сохраняется — Hard rule #5).
- [ ] Фаза 5. Тесты `test/cache.test.mjs`: стабильность ключа при одинаковых нормализованных входах
      («Что такое СОЛАС?» == « что такое солас »); разные ключи при разных
      SHA/промптах/вопросах/моделях/effort; round-trip get/set в tmpdir; race-тест (два
      одновременных `set` на одинаковом ключе → один EEXIST, файл цел); битый JSON → null; ENOSPC →
      `set` не падает фатально.
- [ ] Фаза 6. Smoke: задать вопрос, увидеть `source=codex`; повторить — `source=cache`. Сделать
      `git commit --allow-empty` в `GRAPH_REPO_PATH` — повтор снова `source=codex`. Сделать `touch`
      в графе (грязный tree) — повтор снова `source=codex` + warning. Поменять `CODEX_EFFORT` —
      повтор снова `source=codex`.

## Итог

Не начато.
