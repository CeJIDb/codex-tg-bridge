#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook для Bash.
 *
 * Блокирует `git add -A`, `git add --all`, `git add .` — они могут
 * случайно захватить чужие незастейженные правки из параллельных
 * сессий (правило 1 в CLAUDE.md: "коммить только свои изменения").
 *
 * Разрешено: `git add <конкретные пути>` и `npm run commit:atomic*`
 * (последний сам перечисляет пути явно внутри себя).
 */
import { readFileSync } from "node:fs";

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf-8") || "{}");
} catch {
  process.exit(0);
}

const cmd = (payload.tool_input && payload.tool_input.command) || "";

// `git add -A` | `--all` | `.`  + граница команды (пробел/;/&/|/конец).
const UNSAFE_RE = /\bgit\s+add\b(\s+-A\b|\s+--all\b|\s+\.(?=\s|$|;|&|\|))/;

if (UNSAFE_RE.test(cmd)) {
  console.error(
    "BLOCKED: обнаружен `git add -A` / `git add --all` / `git add .`.\n" +
      "Правило 1 в CLAUDE.md — коммить только свои изменения.\n" +
      "В параллельных сессиях другие агенты могут держать незастейженные правки;\n" +
      "массовый add захватит их вместе с твоими.\n" +
      "\n" +
      "Альтернативы:\n" +
      "  - `git add <path1> <path2> …` — поштучно по имени файла.\n" +
      "  - `npm run commit:atomic` — атомарные коммиты по бакетам репозитория.\n",
  );
  process.exit(2);
}

process.exit(0);
