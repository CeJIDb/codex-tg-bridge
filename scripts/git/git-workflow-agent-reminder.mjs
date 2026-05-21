#!/usr/bin/env node
/**
 * Напоминание об atomic-commit при «крупном» диффе.
 *
 * Режимы:
 *   --staged   только индекс (для pre-commit)
 *   --worktree всё относительно HEAD + неотслеживаемое (для pre-push / вручную)
 *
 * Пороги (переопределение через env):
 *   GIT_WORKFLOW_REMINDER_MIN_FILES (по умолчанию 4)
 *   GIT_WORKFLOW_REMINDER_MIN_LINES  сумма добавленных+удалённых строк (по умолчанию 200)
 *
 * Exit code всегда 0 — хук не блокирует коммит/push.
 */

import { execFileSync } from "node:child_process";

const MIN_FILES = Number(process.env.GIT_WORKFLOW_REMINDER_MIN_FILES ?? 4);
const MIN_LINES = Number(process.env.GIT_WORKFLOW_REMINDER_MIN_LINES ?? 200);

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

function countStaged() {
  const stat = git(["diff", "--cached", "--numstat"]);
  if (!stat) return { files: 0, lines: 0 };
  let files = 0;
  let lines = 0;
  for (const line of stat.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    files += 1;
    const add = parts[0] === "-" ? 0 : Number(parts[0]) || 0;
    const del = parts[1] === "-" ? 0 : Number(parts[1]) || 0;
    lines += add + del;
  }
  return { files, lines };
}

function countWorktree() {
  const short = git(["diff", "--shortstat", "HEAD"]);
  let files = 0;
  let lines = 0;
  const m = short.match(/(\d+)\s+files? changed/);
  if (m) files += Number(m[1]);
  const ins = short.match(/(\d+)\s+insertions?\(\+\)/);
  const del = short.match(/(\d+)\s+deletions?\(-\)/);
  if (ins) lines += Number(ins[1]);
  if (del) lines += Number(del[1]);

  const untracked = git(["ls-files", "--others", "--exclude-standard"]);
  const untrackedCount = untracked ? untracked.split("\n").filter(Boolean).length : 0;
  files += untrackedCount;
  lines += untrackedCount * 50;

  return { files, lines };
}

function shouldRemind(files, lines) {
  return files >= MIN_FILES || lines >= MIN_LINES;
}

function printReminder(context) {
  const msg = `
husky(git-workflow-reminder): накопилось заметное изменение (${context}).
  Рекомендуется перед коммитом/push:
  • атомарные коммиты: npm run commit:atomic --dry-run  →  npm run commit:atomic
`;
  console.warn(msg);
}

const mode = process.argv.includes("--worktree")
  ? "worktree"
  : process.argv.includes("--staged")
    ? "staged"
    : "staged";

const { files, lines } = mode === "worktree" ? countWorktree() : countStaged();
const ctx =
  mode === "worktree"
    ? `рабочее дерево: ~${files} файл(ов), ~${lines} строк в диффе`
    : `индекс: ${files} файл(ов), ~${lines} строк в диффе`;

if (shouldRemind(files, lines)) {
  printReminder(ctx);
}

process.exit(0);
