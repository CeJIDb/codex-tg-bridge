/**
 * Утилита: список файлов, изменённых относительно HEAD (включая untracked).
 *
 * Охватывает три категории:
 *   - git diff --name-only HEAD        — изменённые tracked-файлы
 *   - git diff --cached --name-only   — staged-изменения
 *   - git ls-files --others ...        — новые untracked-файлы
 *
 * Используется линтерами через флаг --changed-only для ускорения проверок.
 */
import { execSync } from "node:child_process";
import path from "node:path";

export const ROOT = process.cwd();

/**
 * Пути, которые линтеры/форматтеры игнорируют: настройки и скиллы агента —
 * внешние, не управляются этим репо. Префиксы относительно корня.
 */
const IGNORED_PREFIXES = [".claude/", ".agents/"];

function isIgnored(rel) {
  return IGNORED_PREFIXES.some((p) => rel === p.replace(/\/$/, "") || rel.startsWith(p));
}

/** Возвращает дедуплицированный список относительных путей (от корня репо). */
export function getChangedRelPaths(root = ROOT) {
  const run = (cmd) => {
    try {
      return execSync(cmd, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] })
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  };

  const files = new Set([
    ...run("git diff --name-only HEAD"),
    ...run("git diff --cached --name-only"),
    ...run("git ls-files --others --exclude-standard"),
  ]);

  return [...files].filter((f) => !isIgnored(f));
}

/** Возвращает абсолютные пути всех изменённых файлов. */
export function getChangedAbsPaths(root = ROOT) {
  return getChangedRelPaths(root).map((f) => path.join(root, f));
}

/** Возвращает абсолютные пути изменённых .md-файлов (исключая папки raw). */
export function getChangedMarkdown(root = ROOT) {
  return getChangedAbsPaths(root).filter(
    (f) => f.endsWith(".md") && !f.split(path.sep).includes("raw"),
  );
}

/** true если скрипт запущен с флагом --changed-only */
export const CHANGED_ONLY = process.argv.includes("--changed-only");
