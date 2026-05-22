#!/usr/bin/env node
/**
 * Валидирует файл(ы) плана в plans/ против правил из CLAUDE.md и plans/README.md.
 *
 * Проверки:
 *   1. Имя файла: YYYY-MM-DD-slug.md, валидная дата, slug в kebab-case на латинице
 *      (a-z, 0-9, один дефис между сегментами, без двойных и хвостовых дефисов).
 *   2. H1-заголовок (# ...) присутствует.
 *   3. Есть хотя бы одна строка с маркером [ ] или [x] (фаза со статусом).
 *   4. Секция "## Итог" (или "## Итоги") есть, после заголовка пустая строка,
 *      затем непустой контент.
 *   5. Предупреждение: файл > 500 строк (возможно нарушение «один план = одна задача»).
 *
 * Usage:
 *   node ./scripts/validate-plans.mjs plans/2026-04-24-foo.md
 *   node ./scripts/validate-plans.mjs --all
 *   node ./scripts/validate-plans.mjs --staged
 *
 * Exit code: 0 — все файлы ok, 1 — есть ошибки, 2 — ошибка запуска.
 */
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const FILENAME_REGEX = /^(\d{4})-(\d{2})-(\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const H1_REGEX = /^# .+/m;
const CHECKBOX_REGEX = /\[[ xX]\]/;
const ITOG_HEADER_REGEX = /^##\s+Итог(?:и)?[ \t]*$/m;

function isValidDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function validate(filePath) {
  const name = path.basename(filePath);

  if (name === "README.md") {
    return { skipped: true, reason: "README.md — это не план" };
  }

  const issues = [];
  const warnings = [];

  const match = name.match(FILENAME_REGEX);
  if (!match) {
    return {
      skipped: true,
      reason: `«${name}» не соответствует шаблону YYYY-MM-DD-slug.md — пропускаем`,
    };
  } else {
    const [, y, m, d] = match;
    if (!isValidDate(y, m, d)) {
      issues.push(`Имя файла «${name}» содержит невалидную дату ${y}-${m}-${d}`);
    }
  }

  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (err) {
    issues.push(`Не удалось прочитать файл: ${err.message}`);
    return { issues, warnings };
  }

  if (!H1_REGEX.test(content)) {
    issues.push("Нет заголовка H1 (строки вида `# Заголовок`)");
  }

  if (!CHECKBOX_REGEX.test(content)) {
    issues.push("Не найдено ни одной строки с `[ ]` или `[x]` — фазы без статуса");
  }

  const itogMatch = content.match(ITOG_HEADER_REGEX);
  if (!itogMatch) {
    issues.push("Нет секции `## Итог` в конце плана");
  } else {
    const after = content.slice(itogMatch.index + itogMatch[0].length);
    if (after.trim() === "") {
      issues.push("Секция `## Итог` есть, но она пустая");
    } else if (!/^\r?\n\r?\n/.test(after)) {
      issues.push("После заголовка `## Итог` должна идти пустая строка перед текстом");
    }
  }

  const lineCount = content.split("\n").length;
  if (lineCount > 500) {
    warnings.push(
      `Файл содержит ${lineCount} строк — возможно, в нём несколько задач (правило «один план = одна задача»)`,
    );
  }

  return { issues, warnings };
}

function report(filePath, result) {
  const displayPath = path.relative(process.cwd(), filePath) || filePath;

  if (result.skipped) {
    console.log(`-  ${displayPath}: пропущен (${result.reason})`);
    return { failed: 0, warned: 0 };
  }

  const { issues, warnings } = result;

  if (issues.length === 0 && warnings.length === 0) {
    console.log(`ok ${displayPath}`);
    return { failed: 0, warned: 0 };
  }

  const marker = issues.length > 0 ? "FAIL" : "WARN";
  console.log(`${marker} ${displayPath}:`);
  for (const msg of issues) console.log(`   - ${msg}`);
  for (const msg of warnings) console.log(`   ! ${msg}`);
  return { failed: issues.length > 0 ? 1 : 0, warned: warnings.length > 0 ? 1 : 0 };
}

function collectAllPlans() {
  const plansDir = path.resolve(process.cwd(), "plans");
  try {
    return readdirSync(plansDir)
      .filter((name) => name.endsWith(".md") && name !== "README.md")
      .map((name) => path.join(plansDir, name))
      .filter((fullPath) => {
        try {
          return statSync(fullPath).isFile();
        } catch {
          return false;
        }
      });
  } catch (err) {
    console.error(`Не удалось прочитать plans/: ${err.message}`);
    process.exit(2);
  }
}

function collectStagedPlans() {
  let output;
  try {
    output = execSync("git diff --cached --name-only --diff-filter=ACMR", {
      encoding: "utf8",
    });
  } catch (err) {
    console.error(`Не удалось получить список застейдженных файлов: ${err.message}`);
    process.exit(2);
  }
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        /^plans\/.+\.md$/.test(line) &&
        line !== "plans/README.md" &&
        !line.startsWith("plans/.tmp/"),
    )
    .map((rel) => path.resolve(process.cwd(), rel));
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error(
      "Usage:\n" +
        "  validate-plans.mjs <plan.md> [<plan.md> ...]\n" +
        "  validate-plans.mjs --all\n" +
        "  validate-plans.mjs --staged",
    );
    process.exit(2);
  }

  let files;
  if (args[0] === "--all") {
    files = collectAllPlans();
  } else if (args[0] === "--staged") {
    files = collectStagedPlans();
  } else {
    files = args;
  }

  if (files.length === 0) {
    if (args[0] === "--staged") {
      console.log("В индексе нет изменённых планов — проверка пропущена.");
    } else {
      console.log("Нет планов для валидации.");
    }
    return;
  }

  let failedTotal = 0;
  let warnedTotal = 0;
  for (const file of files) {
    const result = validate(file);
    const { failed, warned } = report(file, result);
    failedTotal += failed;
    warnedTotal += warned;
  }

  console.log("");
  if (failedTotal === 0 && warnedTotal === 0) {
    console.log("Все проверки пройдены.");
  } else {
    console.log(`Итог: файлов с ошибками — ${failedTotal}, с предупреждениями — ${warnedTotal}.`);
  }
  process.exit(failedTotal === 0 ? 0 : 1);
}

main();
