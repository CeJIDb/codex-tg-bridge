#!/usr/bin/env node
/**
 * Claude Code PostToolUse hook.
 *
 * После Write / Edit по файлам plans/YYYY-MM-DD-*.md запускает
 * validate-plans.mjs и показывает ошибки форматирования прямо в ответе агента.
 * Exit code 2 вынуждает агента обратить внимание и исправить план до следующего шага.
 *
 * Пропускает:
 *   - plans/README.md
 *   - plans/user-actions/** (другой формат, своя схема)
 *   - всё, что не подходит под YYYY-MM-DD-slug.md
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

const filePath = (payload.tool_input && payload.tool_input.file_path) || null;
if (!filePath) process.exit(0);

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const rel = path.relative(projectDir, path.resolve(filePath));

// Только plans/*.md, не user-actions/, не README.md
if (
  !rel.startsWith("plans/") ||
  rel.startsWith("plans/user-actions/") ||
  path.basename(rel) === "README.md" ||
  !/^plans\/\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*\.md$/.test(rel)
) {
  process.exit(0);
}

const scriptPath = path.join(projectDir, "scripts", "plans", "validate-plans.mjs");

try {
  execFileSync("node", [scriptPath, path.resolve(filePath)], { stdio: "inherit" });
} catch {
  console.error(
    "\nvalidate-plan-on-write: план содержит ошибки — исправь их перед продолжением.\n",
  );
  process.exit(2);
}

process.exit(0);
