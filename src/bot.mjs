import { Bot } from "grammy";
import PQueue from "p-queue";
import { config } from "./config.mjs";
import { askCodex } from "./codex.mjs";
import { triage } from "./triage.mjs";
import { mdToTgHtml, chunkByLines } from "./format.mjs";

const TELEGRAM_LIMIT = 4000;
const queue = new PQueue({ concurrency: 1 });

export function createBot() {
  const bot = new Bot(config.botToken);

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

    const placeholder = await ctx.reply("Принял, думаю…");
    const ahead = queue.size;
    if (ahead > 0) {
      await safeEdit(ctx, placeholder, `В очереди (${ahead} впереди)…`);
    }

    try {
      const result = await queue.add(() => askCodex(prompt));
      logTurn({ who, prompt, ...result, source: "codex" });
      await sendAnswer(ctx, placeholder, result.answer);
    } catch (err) {
      logError({ who, prompt, err });
      const msg = err.timedOut
        ? `Таймаут (${config.codexTimeoutMs} мс). Попробуй переформулировать короче.`
        : `Ошибка: ${err.shortMessage || err.message || "unknown"}`;
      await safeEdit(ctx, placeholder, msg);
    }
  });

  bot.catch((err) => console.error("Bot error:", err));
  return bot;
}

async function sendAnswer(ctx, placeholder, text) {
  const html = mdToTgHtml(text);
  const chunks = chunkByLines(html, TELEGRAM_LIMIT);
  await safeEdit(ctx, placeholder, chunks[0], text);
  for (let i = 1; i < chunks.length; i++) {
    await safeReply(ctx, chunks[i]);
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
