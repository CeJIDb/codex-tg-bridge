#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook для Bash.
 *
 * Перед git commit проверяет застейдженные планы через validate-plans.mjs --staged.
 * Если хотя бы один план не проходит валидацию — блокирует коммит (exit 2).
 * Если в индексе нет планов — пропускает проверку молча.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf-8") || "{}");
} catch {
  process.exit(0);
}

const cmd = (payload.tool_input && payload.tool_input.command) || "";

if (!/\bgit\s+commit\b/.test(cmd)) process.exit(0);

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const scriptPath = path.join(projectDir, "scripts", "plans", "validate-plans.mjs");

try {
  execFileSync("node", [scriptPath, "--staged"], { stdio: "inherit" });
} catch {
  console.error(
    "\nBLOCKED: в индексе есть планы с ошибками валидации.\n" + "Исправь их и повтори коммит.\n",
  );
  process.exit(2);
}

process.exit(0);
