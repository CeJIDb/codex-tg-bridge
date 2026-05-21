#!/usr/bin/env node
/**
 * Запускает markdownlint-cli2 только на изменённых (git diff + untracked) .md-файлах.
 *
 * Используется в: npm run lint:md:changed, npm run ci:check:changed
 */
import { spawnSync } from "node:child_process";
import { getChangedMarkdown, ROOT } from "./_lib-changed-files.mjs";

const files = getChangedMarkdown();

if (files.length === 0) {
  console.log("markdownlint: нет изменённых md-файлов.");
  process.exit(0);
}

const result = spawnSync("npx", ["markdownlint-cli2", ...files], {
  stdio: "inherit",
  cwd: ROOT,
});

process.exit(result.status ?? 0);
