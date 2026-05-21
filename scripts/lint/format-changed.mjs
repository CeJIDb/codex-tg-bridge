#!/usr/bin/env node
/**
 * Запускает prettier только на изменённых (git diff + untracked) файлах.
 *
 * Флаги:
 *   --check   режим проверки (без записи, как в ci:check)
 *
 * Используется в: npm run format:changed, npm run ci:check:changed
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { getChangedRelPaths, ROOT } from "./_lib-changed-files.mjs";

const PRETTIER_EXTS = new Set([".md", ".json", ".jsonc", ".yml", ".yaml", ".js", ".mjs", ".cjs"]);

const changedFiles = getChangedRelPaths().filter((f) => {
  const ext = path.extname(f);
  return PRETTIER_EXTS.has(ext) && !f.split("/").includes("raw");
});

if (changedFiles.length === 0) {
  console.log("format: нет изменённых файлов для форматирования.");
  process.exit(0);
}

const isCheck = process.argv.includes("--check");
const prettierArgs = [
  isCheck ? "--check" : "--write",
  "--no-error-on-unmatched-pattern",
  ...changedFiles,
];

const result = spawnSync("npx", ["prettier", ...prettierArgs], {
  stdio: "inherit",
  cwd: ROOT,
});

process.exit(result.status ?? 0);
