#!/usr/bin/env node
/**
 * Базовый markdown-чек на ключевых файлах:
 *   - не пустой
 *   - заканчивается переводом строки
 *   - первая непустая строка после YAML-фронтматтера — заголовок
 *   - нет trailing whitespace
 *   - нет merge-маркеров
 *   - нет аномально длинных строк (>500)
 *
 * Проверяем корневые .md (README, NOTICE и т.п.). Тонкая стилистика — на markdownlint-cli2.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { CHANGED_ONLY, getChangedMarkdown, ROOT as LIB_ROOT } from "./_lib-changed-files.mjs";

const ROOT = LIB_ROOT;
const TARGETS = ["README.md", "NOTICE.md"];
const EXCLUDE_DIRS = new Set(["node_modules", ".git"]);

async function collectMarkdownFiles(targetPath, acc) {
  const absPath = path.join(ROOT, targetPath);
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch {
    return;
  }

  if (stat.isFile()) {
    if (absPath.endsWith(".md")) acc.push(absPath);
    return;
  }

  const entries = await fs.readdir(absPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && EXCLUDE_DIRS.has(entry.name)) continue;
    const entryPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      await collectMarkdownFiles(entryPath, acc);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      acc.push(path.join(ROOT, entryPath));
    }
  }
}

function lintContent(filePath, content) {
  const errors = [];

  if (content.trim().length === 0) {
    errors.push("file is empty");
  }
  if (!content.endsWith("\n")) {
    errors.push("file must end with newline");
  }

  const lines = content.split("\n");

  // Пропускаем YAML-фронтматтер (--- ... ---) при поиске первого заголовка.
  let bodyStart = 0;
  if (lines[0] && lines[0].trim() === "---") {
    const fmEnd = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (fmEnd !== -1) bodyStart = fmEnd + 1;
  }
  const firstNonEmpty = lines.slice(bodyStart).find((line) => line.trim().length > 0) || "";
  if (!(firstNonEmpty.startsWith("# ") || firstNonEmpty.startsWith("## "))) {
    errors.push("first non-empty line must start with markdown heading");
  }

  lines.forEach((line, index) => {
    if (/[ \t]+$/.test(line)) {
      errors.push(`line ${index + 1}: trailing whitespace`);
    }
    // Строки таблиц (| ... |) exempt: данные, не проза.
    if (line.length > 500 && !line.trimStart().startsWith("|")) {
      errors.push(`line ${index + 1}: line too long (>500 chars)`);
    }
  });

  if (/^(<<<<<<<|=======|>>>>>>>)$/m.test(content)) {
    errors.push("contains merge conflict markers");
  }

  return errors;
}

async function main() {
  let files;
  if (CHANGED_ONLY) {
    files = getChangedMarkdown().filter((f) => {
      const rel = path.relative(ROOT, f);
      return TARGETS.some((t) => rel === t || rel.startsWith(t + path.sep));
    });
    if (files.length === 0) {
      console.log("Markdown checks: нет изменённых файлов в целевых каталогах.");
      return;
    }
  } else {
    files = [];
    for (const target of TARGETS) {
      await collectMarkdownFiles(target, files);
    }
  }

  let hasErrors = false;
  for (const filePath of files) {
    const content = await fs.readFile(filePath, "utf-8");
    const errors = lintContent(filePath, content);
    if (errors.length > 0) {
      hasErrors = true;
      const rel = path.relative(ROOT, filePath);
      for (const error of errors) {
        console.error(`${rel}: ${error}`);
      }
    }
  }

  if (hasErrors) process.exit(1);
  console.log(`Markdown checks passed: ${files.length} file(s).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
