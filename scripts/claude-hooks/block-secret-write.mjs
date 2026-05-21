#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook.
 *
 * Блокирует Write / Edit / MultiEdit по файлам, которые могут содержать секреты.
 * Зеркалит список из permissions.deny в settings.json, но для операций записи.
 */
import { readFileSync } from "node:fs";

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf-8") || "{}");
} catch {
  process.exit(0);
}

const input = payload.tool_input || {};
const paths = [];
if (typeof input.file_path === "string") paths.push(input.file_path);
if (Array.isArray(input.edits)) {
  for (const e of input.edits) {
    if (e && typeof e.file_path === "string") paths.push(e.file_path);
  }
}

if (paths.length === 0) process.exit(0);

const SECRET_PATTERNS = [
  // Расширения ключей и сертификатов
  /\.(pem|key|p12|pfx)$/i,
  // Базы данных SQLite
  /\.(sqlite3?)$/i,
  // .env файлы
  /(?:^|[/\\])\.env(?:\.|$)/,
  // Имена файлов, содержащие «секретные» слова (только базовое имя)
  /(?:^|[/\\])[^/\\]*(secret|password|passwd|credentials)[^/\\]*$/i,
];

function isSecret(p) {
  const normalized = p.replace(/\\/g, "/");
  return SECRET_PATTERNS.some((re) => re.test(normalized));
}

const hit = paths.find(isSecret);
if (hit) {
  console.error(
    `BLOCKED: ${hit}\n` +
      "Файлы с секретами не коммитятся никогда (см. permissions.deny в .claude/settings.json).\n" +
      "Если нужен шаблон — создай *.example.* или используй <PLACEHOLDER>.\n",
  );
  process.exit(2);
}

process.exit(0);
