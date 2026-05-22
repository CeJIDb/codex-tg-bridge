import { Bot } from "grammy";
import PQueue from "p-queue";
import { performance } from "node:perf_hooks";
import { config } from "./config.mjs";
import { askCodexStream } from "./codex.mjs";
import { createPlaceholderStream } from "./stream-throttle.mjs";
import { triage } from "./triage.mjs";
import { mdToTgHtml, chunkByLines } from "./format.mjs";
import { loadManifests, linkifyCitations, urlForMarkdown } from "./manifests.mjs";
import { createWaiters, register, unregister, computePositions } from "./queue-state.mjs";

const TELEGRAM_LIMIT = 4000;
const EDIT_THROTTLE_MS = 3000;

const queue = new PQueue({ concurrency: 1 });

// Хранилище ожидающих задач.
const waiters = createWaiters();

// Активная задача: { controller: AbortController, taskId: string, stream: object | null } | null
let activeRun = null;

// Ссылка на bot.api, устанавливается в createBot() и используется в recompute.
let _botApi = null;

// --- recompute: пересчёт позиций после каждого сдвига очереди ---
// Подписываемся только на 'next': Фаза 0 подтвердила, что 'error' всегда идёт до 'next',
// так что к моменту 'next' pending уже декрементирован и пересчёт позиций актуален.
queue.on("next", () => {
  if (!_botApi) return;

  const entries = [...waiters._map.entries()].map(([taskId, e]) => ({
    taskId,
    registeredAt: e.registeredAt,
  }));
  if (entries.length === 0) return;

  const positions = computePositions(entries);
  const now = performance.now();

  for (const [taskId, entry] of waiters._map) {
    const newPos = positions.get(taskId);
    if (newPos === undefined) continue;

    if (newPos === 0) {
      // Активная задача — показываем «Выполняется…» ровно один раз (флаг markedActive).
      if (!entry.markedActive) {
        entry.markedActive = true;
        safeEditById(_botApi, entry.chatId, entry.msgId, "Выполняется…").catch((err) =>
          console.warn("recompute active edit failed:", err.message),
        );
      }
      continue;
    }

    // Ожидающая задача: тротлинг ≥ 3000 мс и только при реальной смене позиции.
    const posChanged = newPos !== entry.lastShownPos;
    const throttled = entry.lastEditAt !== null && now - entry.lastEditAt < EDIT_THROTTLE_MS;

    if (posChanged && !throttled) {
      const text = positionText(newPos);
      safeEditById(_botApi, entry.chatId, entry.msgId, text)
        .then(() => {
          entry.lastShownPos = newPos;
          entry.lastEditAt = performance.now();
        })
        .catch((err) => console.warn("recompute waiter edit failed:", err.message));
    }
  }
});

const BOT_COMMANDS = [
  { command: "help", description: "Что умеет бот" },
  { command: "sources", description: "Список источников в графе" },
  { command: "status", description: "Состояние бота и очереди" },
  { command: "cancel", description: "Отменить задачи в очереди" },
  { command: "menu", description: "Все команды" },
];

const HELP_TEXT = [
  "<b>Лоцман</b> — навигатор по графу нормативки.",
  "",
  "Задай вопрос текстом — найду цитаты и связи в РМРС, ИМО, ГОСТ, IEC/ISO.",
  "",
  "Примеры:",
  "• Какие требования к системам пожаротушения на танкерах?",
  "• СОЛАС II-2 правило 4 — основные пункты",
  "• Чем ГОСТ Р 51841 отличается от IEC 61131-2?",
].join("\n");

export async function createBot() {
  const bot = new Bot(config.botToken);
  _botApi = bot.api;

  await bot.api.setMyCommands(BOT_COMMANDS);

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !config.allowedUserIds.has(userId)) {
      console.warn(`Отклонён посторонний user_id=${userId}`);
      return;
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Лоцман на связи. Задавай вопрос по нормативке (РМРС, ИМО, ГОСТ, IEC/ISO) — проведу через граф.",
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT, { parse_mode: "HTML" });
  });

  bot.command("menu", async (ctx) => {
    const lines = BOT_COMMANDS.map((c) => `/${c.command} — ${c.description}`);
    await ctx.reply(lines.join("\n"));
  });

  bot.command("status", async (ctx) => {
    const pending = queue.size;
    const running = queue.pending;
    const queueState =
      running > 0
        ? `выполняется${pending > 0 ? `, ${pending} в ожидании` : ""}`
        : pending > 0
          ? `${pending} в ожидании`
          : "свободна";
    const lines = [
      "<b>Состояние Лоцмана</b>",
      `Модель: <code>${config.codexModel ?? "(из ~/.codex/config.toml)"}</code>`,
      `Усилие: <code>${config.codexEffort ?? "medium"}</code>`,
      `Таймаут: <code>${config.codexTimeoutMs / 1000} с</code>`,
      `Очередь: ${queueState}`,
    ];
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("cancel", async (ctx) => {
    const hadActive = activeRun !== null;

    // (1) Прерываем активную задачу через AbortController.
    if (activeRun) {
      activeRun.controller.abort();
      // Останавливаем тротлер — дальнейшие onDelta/onActivity превращаются в no-op.
      if (activeRun.stream) {
        activeRun.stream.onAborted();
      }
      // Edit плейсхолдера активной задачи.
      const activeEntry = waiters._map.get(activeRun.taskId);
      if (activeEntry) {
        await safeEditById(bot.api, activeEntry.chatId, activeEntry.msgId, "Отменено по /cancel.");
      }
    }

    // Собираем ожидающих до очистки (исключаем активную задачу — она уже обработана).
    const activeTaskId = activeRun?.taskId ?? null;
    const waitingEntries = [...waiters._map.entries()].filter(
      ([taskId]) => taskId !== activeTaskId,
    );

    // (3) Сериализованный фан-аут на ожидающих: rate 10 edit/сек.
    for (const [, entry] of waitingEntries) {
      await safeEditById(bot.api, entry.chatId, entry.msgId, "Отменено по /cancel.");
      await sleep(100);
    }

    // (4) Очищаем очередь и waiters.
    queue.clear();
    waiters._map.clear();
    activeRun = null;

    const pending = waitingEntries.length;
    if (!hadActive && pending === 0) {
      await ctx.reply("Очередь пуста.");
    } else if (hadActive && pending === 0) {
      await ctx.reply("Активный запрос прерван.");
    } else {
      const suffix = hadActive ? " Активный запрос прерван." : "";
      await ctx.reply(`Отменено: ${pending} ожидающих.${suffix}`);
    }
  });

  bot.command("sources", async (ctx) => {
    const placeholder = await ctx.reply("Читаю граф…");
    try {
      const html = await buildSourcesList();
      const chunks = chunkByLines(html, TELEGRAM_LIMIT);
      await safeEdit(ctx, placeholder, chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        await safeReply(ctx, chunks[i]);
      }
    } catch (err) {
      await safeEdit(ctx, placeholder, `Ошибка чтения: ${err.message}`);
    }
  });

  bot.on("message:text", async (ctx) => {
    const prompt = ctx.message.text.trim();
    if (!prompt || prompt.startsWith("/")) return;

    const who = ctx.from?.username ? `@${ctx.from.username}` : `id=${ctx.from?.id}`;

    const canned = triage(prompt);
    if (canned) {
      logTurn({ who, prompt, answer: canned, source: "triage" });
      await ctx.reply(canned);
      return;
    }

    // Отправляем плейсхолдер.
    let placeholder;
    try {
      placeholder = await ctx.reply("Принял, думаю…");
    } catch (err) {
      console.warn("Не смог отправить плейсхолдер:", err.message);
      return;
    }

    const chatId = placeholder.chat.id;
    const msgId = placeholder.message_id;

    // Регистрируем в waiters до queue.add.
    const { taskId } = register(waiters, { chatId, msgId });

    // Показываем начальную позицию в очереди (queue.size до add = число ожидающих впереди).
    const ahead = queue.size;
    if (ahead > 0) {
      try {
        await bot.api.editMessageText(chatId, msgId, positionText(ahead));
        const entry = waiters._map.get(taskId);
        if (entry) {
          entry.lastShownPos = ahead;
          entry.lastEditAt = performance.now();
        }
      } catch (err) {
        console.warn("Не смог показать позицию в очереди:", err.message);
      }
    }

    const controller = new AbortController();

    // Тротлер для промежуточных кадров.
    const stream = createPlaceholderStream({
      editText: (text) => safeEditById(bot.api, chatId, msgId, text),
    });

    let result;
    try {
      result = await queue.add(async () => {
        // Фиксируем активный run (с тротлером).
        activeRun = { controller, taskId, stream };

        // Если recompute ещё не проставил markedActive — показываем «Выполняется…» сами.
        const entry = waiters._map.get(taskId);
        if (entry && !entry.markedActive) {
          entry.markedActive = true;
          await safeEditById(bot.api, chatId, msgId, "Выполняется…").catch(() => {});
        }

        return askCodexStream(prompt, {
          onDelta: (text) => stream.onDelta(text),
          onActivity: (event) => {
            const label = `🔍 ${String(event.label ?? "").slice(0, 60)}`;
            stream.onActivity({ kind: event.kind, label });
          },
          signal: controller.signal,
        });
      });
    } catch (err) {
      if (err.name === "AbortError" || err.isCanceled || controller.signal.aborted) {
        // Задача прервана через /cancel — плейсхолдер уже обновлён в cancel-хендлере.
        console.warn(`[${who}] задача прервана /cancel`);
      } else {
        logError({ who, prompt, err });
        const msg = err.timedOut
          ? `Таймаут (${config.codexTimeoutMs} мс). Попробуй переформулировать короче.`
          : `Ошибка: ${err.shortMessage || err.message || "unknown"}`;
        await safeEdit(ctx, placeholder, msg);
      }
      unregister(waiters, taskId);
      if (activeRun && activeRun.taskId === taskId) {
        activeRun = null;
      }
      return;
    }

    try {
      // Финализируем тротлер — ждёт cooldown и отправляет последний промежуточный кадр.
      await stream.finalize();

      logTurn({ who, prompt, ...result, source: "codex" });
      await sendAnswer(ctx, placeholder, result.answer);
    } catch (err) {
      logError({ who, prompt, err });
      await safeEdit(ctx, placeholder, `Ошибка: ${err.shortMessage || err.message || "unknown"}`);
    } finally {
      unregister(waiters, taskId);
      if (activeRun && activeRun.taskId === taskId) {
        activeRun = null;
      }
    }
  });

  bot.catch((err) => console.error("Bot error:", err));
  return bot;
}

// --- helpers: текст позиции ---

function positionText(pos) {
  if (pos === 0) return "Выполняется…";
  return `В очереди: #${pos + 1} (${pos} впереди)…`;
}

// --- /sources helpers ---

// Строим markdown-список и пропускаем через mdToTgHtml — экранирование
// HTML-спецсимволов и преобразование [text](url) в <a> делает за нас format.mjs.
async function buildSourcesList() {
  const { sections } = await loadManifests();
  if (sections.length === 0) return "Манифесты не найдены.";

  const blocks = sections.map(({ issuer, docs }) => {
    const heading = issuer ? issuer.toUpperCase() : "Источники";
    if (docs.length === 0) return `**${heading}** — манифест не распознан`;
    return `**${heading}**\n${docs.map(formatDocMd).join("\n")}`;
  });

  return mdToTgHtml(blocks.join("\n\n"));
}

function formatDocMd(d) {
  const url = urlForMarkdown(d.url);
  const code = url ? `[${d.code}](${url})` : `\`${d.code}\``;
  return `• ${code} — ${d.title}`;
}

// --- общие вспомогательные функции ---

async function sendAnswer(ctx, placeholder, text) {
  const linked = await tryLinkify(text);
  const html = mdToTgHtml(linked);
  const chunks = chunkByLines(html, TELEGRAM_LIMIT);
  await safeEdit(ctx, placeholder, chunks[0], text);
  for (let i = 1; i < chunks.length; i++) {
    await safeReply(ctx, chunks[i]);
  }
}

async function tryLinkify(md) {
  try {
    const { byCode } = await loadManifests();
    return linkifyCitations(md, byCode);
  } catch (err) {
    console.warn("Не удалось подгрузить манифесты для линкификации:", err.message);
    return md;
  }
}

// Сначала пытаемся отредактировать с HTML. Если Telegram отверг разметку
// (некорректные теги в выводе Codex) — fallback в plain text с исходным markdown.
async function safeEdit(ctx, placeholder, html, fallbackText) {
  const chatId = placeholder.chat.id;
  const msgId = placeholder.message_id;
  try {
    await ctx.api.editMessageText(chatId, msgId, html, { parse_mode: "HTML" });
    return;
  } catch (err) {
    if (isParseError(err)) {
      console.warn("HTML parse rejected, шлю plain:", err.description || err.message);
      try {
        await ctx.api.editMessageText(chatId, msgId, fallbackText ?? stripTags(html));
        return;
      } catch (err2) {
        await ctx.reply(fallbackText ?? stripTags(html));
        return;
      }
    }
    console.warn(
      "editMessageText не удалось, шлю отдельным сообщением:",
      err.description || err.message,
    );
    await safeReply(ctx, html, fallbackText);
  }
}

// Редактирование сообщения напрямую по chatId/msgId с обработкой 429.
// Intermediate-кадры могут дропаться (тротлинг), финальный кадр гарантирован через retry.
async function safeEditById(api, chatId, msgId, text) {
  try {
    await api.editMessageText(chatId, msgId, text);
  } catch (err) {
    const retryAfter = err?.parameters?.retry_after;
    if (retryAfter != null) {
      // 429 Too Many Requests: cooldown по retry_after, затем одна повторная попытка.
      await sleep(retryAfter * 1000 + 200);
      try {
        await api.editMessageText(chatId, msgId, text);
      } catch (err2) {
        console.warn(
          `safeEditById повтор не удался [${chatId}/${msgId}]:`,
          err2.description || err2.message,
        );
      }
      return;
    }
    // Не 429 — логируем (fire-and-forget контекст).
    console.warn(`safeEditById не удалось [${chatId}/${msgId}]:`, err.description || err.message);
  }
}

async function safeReply(ctx, html, fallbackText) {
  try {
    await ctx.reply(html, { parse_mode: "HTML" });
  } catch (err) {
    if (isParseError(err)) {
      console.warn("HTML parse rejected, шлю plain:", err.description || err.message);
      await ctx.reply(fallbackText ?? stripTags(html));
      return;
    }
    throw err;
  }
}

function isParseError(err) {
  const desc = err?.description || err?.message || "";
  return /can't parse|parse entities|unsupported start tag/i.test(desc);
}

function stripTags(html) {
  return html
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logTurn({ who, prompt, answer, model, effort, elapsedMs, tokens, source }) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const head =
    source === "triage"
      ? "triage"
      : `${model ?? "default"} · effort=${effort ?? "—"}` +
        (elapsedMs != null ? ` · ${formatMs(elapsedMs)}` : "") +
        ` · ${formatTokens(tokens)}`;
  console.log(`\n[${ts}] ${who} — ${head}`);
  console.log(`  Q: ${oneLine(prompt)}`);
  console.log(`  A: ${oneLine(answer)}`);
}

function logError({ who, prompt, err }) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.error(`\n[${ts}] ${who} — codex ERROR`);
  console.error(`  Q: ${oneLine(prompt)}`);
  console.error(`  ! ${err.shortMessage || err.message || "unknown"}`);
  if (err.codexStderr) console.error(err.codexStderr);
}

function oneLine(s, max = 200) {
  const flat = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

function formatMs(ms) {
  if (ms < 1000) return `${ms}мс`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}с`;
  const m = Math.floor(s / 60);
  return `${m}м ${Math.round(s - m * 60)}с`;
}

function formatTokens(t) {
  if (!t) return "tokens=n/a";
  return `tokens=${t.total}`;
}
