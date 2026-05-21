import "dotenv/config";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

function required(name) {
  const v = process.env[name];
  if (!v || v.startsWith("<")) {
    throw new Error(`Не задана переменная ${name} в .env`);
  }
  return v;
}

const allowed = (process.env.ALLOWED_USER_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const n = Number(s);
    if (!Number.isInteger(n)) {
      throw new Error(`ALLOWED_USER_IDS: "${s}" не является целым числом`);
    }
    return n;
  });

if (allowed.length === 0) {
  throw new Error("ALLOWED_USER_IDS пуст — бот никого не пустит. Заполни .env.");
}

const graphRepoPath = resolve(required("GRAPH_REPO_PATH"));
if (!existsSync(graphRepoPath)) {
  throw new Error(`GRAPH_REPO_PATH не существует: ${graphRepoPath}`);
}

export const config = {
  botToken: required("BOT_TOKEN"),
  allowedUserIds: new Set(allowed),
  graphRepoPath,
  codexModel: process.env.CODEX_MODEL || null,
  codexEffort: process.env.CODEX_EFFORT || "medium",
  codexTimeoutMs: Number(process.env.CODEX_TIMEOUT_MS ?? 300000),
  codexDebugDir: process.env.CODEX_DEBUG_DIR || null,
};
