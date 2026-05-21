import { Bot } from "grammy";
import PQueue from "p-queue";
import { config } from "./config.mjs";
import { askCodex } from "./codex.mjs";
import { triage } from "./triage.mjs";

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

    const canned = triage(prompt);
    if (canned) {
      await ctx.reply(canned);
      return;
    }

    const placeholder = await ctx.reply("Принял, думаю…");
    const ahead = queue.size;
    if (ahead > 0) {
      await safeEdit(ctx, placeholder, `В очереди (${ahead} впереди)…`);
    }

    try {
      const answer = await queue.add(() => askCodex(prompt));
      await sendAnswer(ctx, placeholder, answer);
    } catch (err) {
      console.error("Codex error:", err);
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
  const chunks = chunk(text, TELEGRAM_LIMIT);
  await safeEdit(ctx, placeholder, chunks[0]);
  for (let i = 1; i < chunks.length; i++) {
    await ctx.reply(chunks[i]);
  }
}

async function safeEdit(ctx, placeholder, text) {
  try {
    await ctx.api.editMessageText(placeholder.chat.id, placeholder.message_id, text);
  } catch (err) {
    console.warn(
      "editMessageText не удалось, шлю отдельным сообщением:",
      err.description || err.message,
    );
    await ctx.reply(text);
  }
}

function chunk(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size));
  }
  return out;
}
