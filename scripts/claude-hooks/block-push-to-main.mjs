#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook для Bash.
 *
 * Блокирует прямой push в main/master (Git-политика CLAUDE.md: «прямой push в main запрещен»).
 * Разрешенный путь — через feature-ветку и PR.
 *
 * Ловит:
 *   git push origin main
 *   git push -u origin main
 *   git push origin HEAD:main
 *   git push origin refs/heads/main
 *
 * Пропускает:
 *   git push origin feature/my-main-rework  (main не является последним сегментом)
 */
import { readFileSync } from "node:fs";

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf-8") || "{}");
} catch {
  process.exit(0);
}

const cmd = (payload.tool_input && payload.tool_input.command) || "";

if (!/\bgit\s+push\b/.test(cmd)) process.exit(0);

// [:\s/] перед (main|master) — ловит «origin main», «HEAD:main», «refs/heads/main».
// (?=\s*(?:$|[;|&\n])) — убеждаемся, что это конец аргумента, а не часть ветки.
const PUSH_MAIN_RE = /\bgit\s+push\b[^;|&\n]*[:\s/](main|master)(?=\s*(?:$|[;|&\n]))/;

if (PUSH_MAIN_RE.test(cmd)) {
  console.error(
    "BLOCKED: прямой push в main/master запрещен (Git-политика в CLAUDE.md).\n" +
      "Правильный путь:\n" +
      "  1. Убедись, что ты на feature-ветке: git branch\n" +
      "  2. Создай PR через gh pr create\n" +
      "  3. Пусть PR пройдет CI, затем merge через GitHub.\n",
  );
  process.exit(2);
}

process.exit(0);
