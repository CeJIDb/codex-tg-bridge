# План: контекст диалога через Telegram reply

**Дата**: 2026-05-22 **Задача**: если пользователь отвечает (Telegram reply) на сообщение бота,
подкладывать цепочку предыдущих обменов (до 3 шагов) в промпт Codex как контекст. В хвосте каждого
ответа показывать индикатор положения в ветке.

## Зачем именно так

**Hard-rule контекст.** Текущий `codex.mjs` запускает `codex exec --ephemeral` — каждая сессия
изолирована, бот не помнит свои ответы между запусками. План **сознательно** склеивает мультитёрн
поверх ephemeral, держа состояние в bot-процессе. Это компромисс: `--ephemeral` остаётся для самого
codex (sandbox-контракт цел), но bot-слой добавляет историю до 3 шагов. Включается через env
`REPLY_CONTEXT_DEPTH` (default **3**; `0` — фича выключена, бот работает stateless как сейчас).

Сейчас каждый вопрос изолирован: `askCodex(prompt)` получает только текущий текст. Пользователь не
может уточнить предыдущий ответ («а как это соотносится с СОЛАС?», «дай подробнее по пункту 3»), не
повторив весь контекст вручную. UX страдает на сложных навигационных сессиях по графу.

Telegram даёт встроенный механизм: `reply_to_message`. Если бот видит, что юзер отвечает на одно из
**его** прошлых сообщений, можно подтянуть исходный Q+A и пройтись вверх по цепочке через
`parentEntryId`, собирая до 3 последних шагов.

**Почему именно 3 шага.** Один шаг — мало для типичного «вопрос → уточнение → встречное уточнение».
5+ шагов — каждый ответ это полстраницы цитат, накапливается шум, модель «застревает» в старых
источниках вместо навигации по графу. 3 шага — золотая середина: тема + два уточнения; дальше
естественно начинать новую ветку без reply. Бюджет токенов на блок «Контекст» намеренно **не**
вводится: обрезка `prevA` через `truncatePreservingSources` уже ограничивает каждый шаг до 2000
символов, итого ≤ ~6 KB на цепочку — для codex-моделей это мизер. Поведение на 4+ reply: берутся
последние 3 шага, первый отбрасывается, в индикаторе помечается факт обрезки.

**UI-индикатор.** В конце последнего чанка каждого ответа Codex показываем минималистичную строку
`— Ветка N/3`, где `N` — текущая глубина (1 для первого ответа в ветке, 2 для ответа на первый
reply, 3 для последнего). При overflow (юзер сделал reply на цепочку длиннее 3) — строка вида
`— Ветка 3/3 · ранние шаги выпали`. Индикатор показывается только при `REPLY_CONTEXT_DEPTH > 0` и
**не** показывается на triage-ответах ([src/triage.mjs](../src/triage.mjs)) — те идут мимо Codex и
вне reply-контекста.

Альтернативы:

- Полная история чата как контекст — слишком много токенов, мусор от triage и команд.
- Команда `/continue` — лишний шаг, неинтуитивно.
- Inline-кнопки «продолжить ветку / начать заново» — лишний код вокруг `callback_query`,
  непропорционально задаче.
- **Подхват reply на бота как «продолжай эту ветку» с лимитом 3.** Минимум UI, максимум смысла.

Хранение: in-memory `entries: Map<entryId, {question, answer, parentEntryId}>` +
`lookup: Map<msgKey, entryId>`. **Один entry на ответ** (не на каждый чанк): для плейсхолдера и всех
чанков того же ответа регистрируется один `entryId`. Eviction LRU по числу entries (capacity ~500),
а не по числу msgId. Это критично — длинный ответ из 5 чанков иначе занял бы 5 слотов вместо одного.
Capacity поднят с 200 до 500, потому что один диалог теперь занимает до 3 entries в живой цепочке.

Переживание рестарта не требуется (после рестарта пользователь просто не получит контекст для старых
сообщений — приемлемо, граф мог тоже измениться).

Обрезка предыдущих ответов в контексте: `prevA` режется по длине, **с сохранением хвоста
«Источники:»** — потому что [src/prompt.mjs](../src/prompt.mjs) явно требует от модели держать
источники в конце ответа, и обрезка сверху-вниз ломает цитирование на уточняющем вопросе. Обрезка
применяется к **каждому** шагу цепочки независимо.

## Цель

Юзер пишет вопрос → получает ответ с индикатором `— Ветка 1/3`. Делает reply с уточнением → бот
поднимает цепочку (1 шаг), формирует промпт `Контекст: Q1+A1 / Новый вопрос: …`, шлёт в Codex,
отдаёт ответ с `— Ветка 2/3`. Ещё один reply — `— Ветка 3/3`. Reply на четвёртое сообщение цепочки —
берутся последние 3 шага (1-й выпадает), индикатор `— Ветка 3/3 · ранние шаги выпали`.

## Scope

Входит:

- Новый модуль `src/reply-context.mjs`:
  - `remember({chatId, threadId, msgIds, parentEntryId}, {question, answer})` создаёт один entry с
    опциональной ссылкой на родителя и регистрирует список msgId как алиасы.
  - `recallChain({chatId, threadId, msgId}, maxDepth)`:
    `{chain: [{question, answer}, ...], truncated: boolean}`. Идёт от msgId через `lookup` →
    `entryId`, потом вверх по `parentEntryId`, пока не наберёт `maxDepth` шагов или не упрётся в
    `null`/вытесненного родителя. `chain` упорядочен от старого к новому. `truncated=true`, если
    остановились на `maxDepth` и родитель ещё существовал.
  - LRU по entries, capacity 500.
- Env `REPLY_CONTEXT_DEPTH` (default `3`, `0` = выкл) в `config.mjs` и `env.example`.
- В [src/bot.mjs](../src/bot.mjs):
  - На входящем `message:text`: если `replyContextDepth > 0` и `reply.from?.id === ctx.me.id` —
    `recallChain(...)`. При непустой `chain` обернуть промпт через
    `withReplyContext(chain, userText)`. Запомнить
    `incomingParentEntryId = chain[chain.length-1].entryId` (либо `null`, если recall пустой).
  - После успешного `sendAnswer` собрать `msgIds = [placeholder?.message_id, ...chunkMsgIds]`
    (плейсхолдер — только если он стал финальным ответом, флаг `placeholderBecameAnswer`). Один
    `remember(..., parentEntryId: incomingParentEntryId, ...)` для всего списка.
  - Индикатор: `formatBranchIndicator({depth, max, truncated})` →
    `— Ветка ${depth}/${max}${truncated ? " · ранние шаги выпали" : ""}`. Приклеивается к
    `result.answer` **до** `mdToTgHtml` (как markdown, отдельной строкой через `\n\n`), чтобы
    попасть естественно в чанкование. `depth = chain.length + 1`. Не показывается, если
    `replyContextDepth === 0` или ответ ушёл через triage.
  - В групповых форум-чатах учитывать `message_thread_id` — entry per-thread.
- `src/prompt.mjs`:
  - `truncatePreservingSources(prevA, budget=2000)` — режет середину, оставляет начало и блок
    «Источники:» в хвосте, ставит маркер `…[обрезано]` в шов.
  - `withReplyContext(chain, newQ)` — собирает блок
    `Контекст:\nQ1: …\nA1: …\nQ2: …\nA2: …\n\nНовый вопрос: …` с обрезкой каждого `A_i` через
    `truncatePreservingSources`. Порядок с `withSystemPreamble`:
    `withSystemPreamble(withReplyContext(chain, newQ))`. Закрепить тестом.
- Юнит-тесты: LRU eviction по entries; `recallChain` с разной глубиной; overflow и `truncated=true`;
  `truncatePreservingSources` сохраняет «Источники:»; порядок обёрток; per-thread изоляция;
  `formatBranchIndicator` на normal / overflow / disabled / depth=max.

Не входит:

- Глубина > 3.
- Бюджет токенов на блок «Контекст» (намеренно — обрезка только пер-шаговая через
  `truncatePreservingSources`).
- Сохранение между рестартами.
- Передача контекста через `/start`-параметры или deep-links.
- Контекст и индикатор для triage-ответов (`MANUAL`/`DEEPPAVLOV` мимо Codex).
- Inline-кнопки и callback-обработчики.
- Суммаризация старых шагов отдельным LLM-вызовом.

## Определение «готово»

- [ ] `REPLY_CONTEXT_DEPTH=3` (default) включает фичу до 3 шагов; `=0` — бот работает stateless,
      индикатор не показывается, цепочка не собирается.
- [ ] Первый ответ в ветке: индикатор `— Ветка 1/3`. Reply-уточнение: `— Ветка 2/3`. Ещё reply:
      `— Ветка 3/3`. Reply на цепочку глубже 3: `— Ветка 3/3 · ранние шаги выпали`, в промпт
      попадают последние 3 шага.
- [ ] Reply на **любой** чанк длинного ответа подтягивает один и тот же entry (через `lookup`-map),
      и `recallChain` от любого чанка одной и той же ветки даёт одинаковую цепочку.
- [ ] Reply на сообщение, которого нет в LRU (после рестарта или вытеснения) — работает без
      контекста, без ошибок, индикатор `— Ветка 1/3`.
- [ ] Reply на не-бота (forwarded, цитата другого юзера, channel-репост) — контекст не
      подтягивается, индикатор `— Ветка 1/3` (это новый шаг ветки, не уточнение).
- [ ] Каждый `prevA` в цепочке обрезается до 2000 символов с маркером `…[обрезано]` **в середине**,
      начало и блок «Источники:» сохраняются.
- [ ] LRU считается по entries (не по msgId): при capacity=500 и пяти-чанковых ответах в памяти
      остаётся ровно 500 диалогов.
- [ ] Плейсхолдер «Принял, думаю…» не попадает в `recall` (регистрируем только если он стал
      финальным ответом).
- [ ] В форумных чатах `message_thread_id` — часть ключа entry, треды не путаются и не делят
      `parentEntryId` между собой.
- [ ] `withReplyContext` обрамляется через `withSystemPreamble` снаружи; порядок закреплён тестом.
- [ ] Triage-ответы (`MANUAL`/`DEEPPAVLOV`) идут без индикатора и не регистрируются в reply-context
      (на reply к ним recall вернёт пусто).
- [ ] `npm run test:format`, новый `npm run test:reply-context`, `npm run ci:check` зелёные.

## Фазы и статус

- [x] Фаза 0. Прочитать формат `ctx.message.reply_to_message` у grammy. Подтвердить: `from.id` — id
      отправителя того сообщения; `ctx.me.id` доступен после `bot.init()`, не лениво;
      `message_thread_id` (форумы) присутствует там, где есть. Если `ctx.me` не populated к моменту
      первого update — пробросить `await bot.init()` в bootstrap (`index.mjs`) до старта.
- [x] Фаза 1. `src/config.mjs`: `replyContextDepth = Number(process.env.REPLY_CONTEXT_DEPTH ?? 3)` с
      валидацией (целое ≥ 0; иначе бросаем при старте). Документировать в
      [env.example](../env.example) с пометкой про компромисс с `--ephemeral` и `0 = выкл`.
- [x] Фаза 2. `src/reply-context.mjs`:
  - `entries: Map<entryId, {question, answer, parentEntryId}>` (insertion order = LRU).
  - `lookup: Map<msgKey, entryId>`, `msgKey = chatId:threadId:msgId` (threadId опционален).
  - `remember({chatId, threadId, msgIds, parentEntryId}, {question, answer})`: создаёт `entryId`,
    кладёт entry, регистрирует каждый msgId. При переполнении (entries.size > 500) — удалить самый
    старый entry **и все его записи в lookup** (а также почистить `parentEntryId`-ссылки на него у
    более молодых entries — там просто остаётся «битая» ссылка, `recallChain` остановится).
  - `recallChain({chatId, threadId, msgId}, maxDepth)`: lookup → entryId → подъём по `parentEntryId`
    пока есть и в LRU и не достигли maxDepth. Возвращает `{chain: [{question, answer}], truncated}`.
- [x] Фаза 3. `src/prompt.mjs`:
  - `truncatePreservingSources(prevA, budget=2000)`: ищем последний блок
    `/(^|\n)Источники:[\s\S]+$/`, если есть — отрезаем сначала body до
    `budget - sources.length - "…[обрезано]\n".length`, потом подклеиваем sources обратно. Без блока
    «Источники:» — обычный slice + `…[обрезано]`.
  - `withReplyContext(chain, newQ)`: собирает
    `Контекст:\nQ1: …\nA1: …\nQ2: …\nA2: …\n\nНовый вопрос: …` с обрезкой каждого `A_i`. Пустая
    `chain` → возвращает `newQ` как есть.
  - Порядок: `withSystemPreamble(withReplyContext(chain, newQ))` — закрепить тестом.
- [x] Фаза 4. `src/bot.mjs`:
  - `formatBranchIndicator({depth, max, truncated})` — функция в bot.mjs или отдельный модуль; на
    `depth=0` или `max=0` возвращает пустую строку.
  - В обработчике `message:text`:
    - Если `replyContextDepth > 0` и `ctx.message.reply_to_message?.from?.id === ctx.me.id` —
      `recallChain` от `reply_to_message.message_id`.
      `incomingParentEntryId = последний entryId цепочки` или `null`.
    - Промпт: `withSystemPreamble(withReplyContext(chain, userText))`.
    - После `sendAnswer`: `depth = chain.length + 1`,
      `indicator = formatBranchIndicator({depth, max: replyContextDepth, truncated})`. Приклеить
      `\n\n` + indicator к `result.answer` **до** `mdToTgHtml`. Затем `remember(...)` для всех msgId
      с `parentEntryId = incomingParentEntryId`.
    - Triage-ветка (`MANUAL`/`DEEPPAVLOV`): индикатор не приклеиваем, `remember` не вызываем.
- [x] Фаза 5. Тесты `test/reply-context.test.mjs`:
  - LRU eviction по entries (601 запись при capacity=500 → 500 остаётся, lookup очищен).
  - `recallChain` на цепочке из 5 шагов с `maxDepth=3` возвращает последние 3 и `truncated=true`.
  - `recallChain` на цепочке из 2 шагов с `maxDepth=3` возвращает 2 и `truncated=false`.
  - `recallChain` после вытеснения родителя возвращает обрубленную цепочку.
  - `truncatePreservingSources` сохраняет хвост «Источники:» при обрезке длинного prevA.
  - `withReplyContext` обёрнут в `withSystemPreamble` в правильном порядке (фикстурой).
  - `recall` с разными `threadId` не путает треды.
  - `formatBranchIndicator`: `1/3`, `2/3`, `3/3`, `3/3 · ранние шаги выпали`, пустая строка при
    `max=0`.
- [ ] Фаза 6. Smoke: `REPLY_CONTEXT_DEPTH=3`. Задать вопрос → ответ с `Ветка 1/3`. Reply «коротко
      перескажи» → `Ветка 2/3`, в логах промпта виден блок «Контекст». Ещё reply → `Ветка 3/3`. Ещё
      reply на цепочку → `Ветка 3/3 · ранние шаги выпали`, первый шаг в промпте отсутствует. Reply
      на чужое сообщение — без контекста, `Ветка 1/3`. `REPLY_CONTEXT_DEPTH=0` — индикатора нет,
      контекст не подтягивается.

## Итог

Фазы 0–5 реализованы. Smoke-тест за юзером (фаза 6).
