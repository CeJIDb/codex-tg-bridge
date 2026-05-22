import { createBot } from "./bot.mjs";
import { config } from "./config.mjs";

const bot = await createBot();

const stop = async (signal) => {
  console.log(`\n${signal} → останавливаю бота…`);
  await bot.stop();
  process.exit(0);
};

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

console.log("Лоцман запускается…");
console.log(`Граф:           ${config.graphRepoPath}`);
console.log(`Разрешённые id: ${[...config.allowedUserIds].join(", ")}`);
console.log(`Модель:         ${config.codexModel ?? "(из ~/.codex/config.toml)"}`);
console.log(`Таймаут:        ${config.codexTimeoutMs} мс`);

await bot.start({
  onStart: (me) => console.log(`@${me.username} в эфире (long polling).`),
});
