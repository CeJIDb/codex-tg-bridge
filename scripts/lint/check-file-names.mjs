#!/usr/bin/env node
/**
 * Проверяет имена файлов на латиницу + kebab-case.
 *
 * Разрешено в имени файла:
 *   - латинские буквы a-z A-Z
 *   - цифры 0-9
 *   - дефис `-`, точка `.`, подчеркивание `_`, собака `@`
 *
 * Запрещено: кириллица, пробелы, спецсимволы.
 *
 * Сканируем каталоги с исходным кодом и инфраструктурой: src, test, scripts.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { CHANGED_ONLY, getChangedRelPaths, ROOT as LIB_ROOT } from "./_lib-changed-files.mjs";

const ROOT = LIB_ROOT;
const SCAN_ROOTS = ["src", "test", "scripts"];
const EXCLUDE_DIRS = new Set([".git", "node_modules", ".venv", "__pycache__", ".cache"]);

function hasSafeFilename(name) {
  if (!name || name.includes(" ")) return false;
  return /^[A-Za-z0-9._@-]+$/.test(name);
}

async function walkFiles(dirRel, acc) {
  const abs = path.join(ROOT, dirRel);
  let entries;
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".gitkeep") continue;
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      await walkFiles(path.join(dirRel, entry.name), acc);
    } else if (entry.isFile()) {
      acc.push(path.join(dirRel, entry.name));
    }
  }
}

async function main() {
  const errors = [];
  let files;

  if (CHANGED_ONLY) {
    files = getChangedRelPaths().filter((f) =>
      SCAN_ROOTS.some((r) => f === r || f.startsWith(r + "/")),
    );
    if (files.length === 0) {
      console.log("Проверка имён файлов: нет изменённых файлов в целевых каталогах.");
      return;
    }
  } else {
    files = [];
    for (const root of SCAN_ROOTS) {
      await walkFiles(root, files);
    }
  }

  files.sort();

  for (const rel of files) {
    const base = path.basename(rel);
    if (!hasSafeFilename(base)) {
      errors.push(`${rel}: имя файла содержит недопустимые символы`);
    }
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exit(1);
  }

  console.log(
    `Проверка имен файлов прошла (${files.length} файл(ов) под ${SCAN_ROOTS.join(", ")}).`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
