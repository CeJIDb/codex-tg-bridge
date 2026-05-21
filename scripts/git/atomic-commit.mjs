#!/usr/bin/env node
/**
 * Группирует текущие изменения относительно HEAD в несколько атомарных коммитов.
 * Заголовки: Conventional Commits + commitlint; тип и scope — латиницей, описание — на русском.
 *
 * Использование:
 *   node scripts/git/atomic-commit.mjs                  # план + подтверждение (y/N)
 *   node scripts/git/atomic-commit.mjs --yes            # без подтверждения
 *   node scripts/git/atomic-commit.mjs --dry-run        # только план, без коммитов
 *   node scripts/git/atomic-commit.mjs --staged-only    # коммитить только уже проиндексированные файлы
 *   node scripts/git/atomic-commit.mjs --verbose        # показывать вывод git commit
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

function isSandboxSpawnError(error) {
  return error && (error.code === "EPERM" || error.code === "EACCES");
}

function printSandboxHint(error) {
  if (!isSandboxSpawnError(error)) return false;
  console.error(
    "atomic-commit: sandbox заблокировал запуск git из Node. " +
      "Запусти с повышенными правами или используй shell-версию.",
  );
  return true;
}

function printSandboxHintForTool(tool, error) {
  if (!isSandboxSpawnError(error)) return false;
  console.error(`atomic-commit: sandbox заблокировал запуск ${tool} из Node.`);
  return true;
}

function gitStdoutRaw(args) {
  try {
    return execFileSync("git", args, { encoding: "utf-8" });
  } catch (error) {
    if (printSandboxHint(error)) process.exit(1);
    return "";
  }
}

const VERBOSE = process.argv.includes("--verbose");

function dumpCapturedOnError(error) {
  if (error && error.stdout) process.stderr.write(error.stdout);
  if (error && error.stderr) process.stderr.write(error.stderr);
}

function gitRun(args, inherit = true) {
  try {
    if (inherit && !VERBOSE) {
      execFileSync("git", args, {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      });
    } else {
      execFileSync("git", args, inherit ? { stdio: "inherit" } : { encoding: "utf-8" });
    }
  } catch (error) {
    if (printSandboxHint(error)) process.exit(1);
    dumpCapturedOnError(error);
    throw error;
  }
}

const PRETTIER_FILE_RE = /\.(md|json|jsonc|yml|yaml|js|mjs|cjs|jsx|ts|tsx|css|html)$/i;

function runPrettierWrite(paths) {
  if (!paths || paths.length === 0) return;
  try {
    execFileSync("npx", ["prettier", "--write", ...paths], {
      stdio: VERBOSE ? "inherit" : ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
  } catch (error) {
    if (printSandboxHintForTool("prettier", error)) process.exit(1);
    dumpCapturedOnError(error);
    throw error;
  }
}

function getChangedFiles({ stagedOnly = false } = {}) {
  const set = new Set();

  if (stagedOnly) {
    const raw = gitStdoutRaw(["diff", "--cached", "--name-only", "-z"]);
    for (const name of raw.split("\0")) {
      if (name) set.add(name);
    }
    return [...set].sort();
  }

  const raw = gitStdoutRaw(["status", "--porcelain=v1", "-z"]);
  if (!raw) return [];

  const tokens = raw.split("\0");
  let i = 0;
  while (i < tokens.length) {
    const entry = tokens[i];
    if (!entry) {
      i += 1;
      continue;
    }
    const xy = entry.slice(0, 2);
    const pathPart = entry.slice(3);
    const isRename = xy.includes("R") || xy.includes("C");
    set.add(pathPart);
    i += isRename ? 2 : 1;
  }

  return [...set].sort();
}

function getFileStatus(files, { stagedOnly = false } = {}) {
  const statusByPath = new Map();
  const raw = gitStdoutRaw(["status", "--porcelain=v1", "-z"]);
  if (!raw) return statusByPath;

  const want = new Set(files);
  const tokens = raw.split("\0");
  let i = 0;
  while (i < tokens.length) {
    const entry = tokens[i];
    if (!entry) {
      i += 1;
      continue;
    }

    const x = entry[0];
    const y = entry[1];
    const pathPart = entry.slice(3);
    const isRename = x === "R" || y === "R" || x === "C" || y === "C";
    const pick = stagedOnly ? x : x !== " " ? x : y;

    if (want.has(pathPart) && pick !== " " && !(stagedOnly && pick === "?")) {
      const normalized =
        pick === "A" || pick === "?"
          ? "A"
          : pick === "D"
            ? "D"
            : pick === "R" || pick === "C"
              ? "R"
              : "M";
      statusByPath.set(pathPart, normalized);
    }

    i += isRename ? 2 : 1;
  }

  return statusByPath;
}

function parseHeader(defMessage) {
  const idx = defMessage.indexOf(":");
  if (idx === -1) return { header: defMessage.trim(), sep: "" };
  return { header: defMessage.slice(0, idx).trim(), sep: ": " };
}

function bucketPrefixForDef(def) {
  switch (def.id) {
    case "ci":
      return ".github/";
    case "husky":
      return ".husky/";
    case "claude":
      return ".claude/";
    case "scripts":
      return "scripts/";
    case "src":
      return "src/";
    case "test":
      return "test/";
    default:
      return "";
  }
}

function displayName(def, filePath) {
  if (
    !def ||
    def.id === "deps" ||
    def.id === "tooling" ||
    def.id === "root-docs" ||
    def.id === "env"
  )
    return filePath;
  const prefix = bucketPrefixForDef(def);
  if (prefix && filePath.startsWith(prefix)) {
    const stripped = filePath.slice(prefix.length);
    if (stripped) return stripped;
    const clean = filePath.endsWith("/") ? filePath.slice(0, -1) : filePath;
    return clean.split("/").pop() + (filePath.endsWith("/") ? "/" : "");
  }
  return filePath;
}

function verbForStatus(status) {
  switch (status) {
    case "A":
      return "добавить";
    case "D":
      return "удалить";
    case "R":
      return "переименовать в";
    default:
      return "обновить";
  }
}

function pluralRu(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return few;
  return many;
}

function truncateMessage(msg, limit = 100) {
  if (msg.length <= limit) return msg;
  const nameListSep = "): ";
  const namedParenIdx = msg.indexOf(nameListSep);
  const listIdx =
    namedParenIdx !== -1 ? namedParenIdx + nameListSep.length : msg.lastIndexOf(": ") + 2;
  if (listIdx < 2 || listIdx >= msg.length) return msg.slice(0, Math.max(0, limit - 1)) + "…";

  const base = msg.slice(0, listIdx);
  const list = msg.slice(listIdx);
  const parts = list.split(", ").filter(Boolean);
  if (parts.length <= 1) return msg.slice(0, Math.max(0, limit - 1)) + "…";

  let keep = parts.length;
  let out = msg;
  while (keep > 1 && out.length > limit) {
    keep -= 1;
    out = base + parts.slice(0, keep).join(", ") + ", …";
  }
  if (out.length <= limit) return out;
  return (base + "…").slice(0, Math.max(0, limit - 1)) + "…";
}

function buildMessage(def, files, statusMap) {
  const { header, sep } = parseHeader(def.message || MISC.message);
  const names = files.map((f) => displayName(def, f));
  const statuses = files.map((f) => statusMap.get(f) || "M");
  const unique = new Set(statuses);

  if (files.length === 1) {
    return `${header}${sep}${verbForStatus(statuses[0])} ${names[0]}`;
  }

  if (unique.size === 1) {
    const v = verbForStatus(statuses[0]);
    const n = files.length;
    const shown = names.slice(0, 3);
    const list = shown.join(", ") + (n > shown.length ? ", …" : "");
    const filesWord = pluralRu(n, "файл", "файла", "файлов");
    return truncateMessage(`${header}${sep}${v} ${n} ${filesWord}: ${list}`);
  }

  const counts = { A: 0, D: 0, M: 0, R: 0 };
  for (const s of statuses) counts[s] += 1;
  const n = files.length;
  const counters = [
    counts.A ? `+${counts.A}` : null,
    counts.D ? `-${counts.D}` : null,
    counts.M ? `~${counts.M}` : null,
    counts.R ? `R${counts.R}` : null,
  ].filter(Boolean);

  const filesWord = pluralRu(n, "файл", "файла", "файлов");
  const base = `${header}${sep}обновить ${n} ${filesWord} (${counters.join(" ")})`;
  if (n <= 3) return truncateMessage(`${base}: ${names.join(", ")}`);
  return truncateMessage(base);
}

// Бакеты упорядочены: инфраструктура -> исходники -> тесты -> документация.
const BUCKET_DEFS = [
  {
    id: "deps",
    test: (f) => f === "package.json" || f === "package-lock.json" || f === "npm-shrinkwrap.json",
    message: "chore(deps): обновить метаданные пакета",
  },
  {
    id: "ci",
    test: (f) => f.startsWith(".github/"),
    message: "ci(github): обновить CI и шаблоны GitHub",
  },
  {
    id: "husky",
    test: (f) => f.startsWith(".husky/"),
    message: "chore(husky): обновить git-хуки",
  },
  {
    id: "claude",
    test: (f) => f === "CLAUDE.md" || f === "AGENTS.md" || f.startsWith(".claude/"),
    message: "docs(claude): обновить навигацию и правила для агентов",
  },
  {
    id: "scripts",
    test: (f) => f.startsWith("scripts/"),
    message: "chore(scripts): обновить системные скрипты репозитория",
  },
  {
    id: "tooling",
    test: (f) =>
      f === ".editorconfig" ||
      f === ".gitignore" ||
      f === ".gitattributes" ||
      f === ".prettierrc" ||
      f === ".prettierrc.json" ||
      f === ".prettierignore" ||
      f === ".markdownlint.json" ||
      f === ".markdownlint.jsonc" ||
      f === ".markdownlint-cli2.jsonc" ||
      f === ".mcp.json" ||
      f === "commitlint.config.cjs" ||
      f.startsWith(".vscode/"),
    message: "chore(tooling): обновить конфиги инструментов разработки",
  },
  {
    id: "src",
    test: (f) => f.startsWith("src/"),
    message: "feat(bot): обновить исходники бота",
  },
  {
    id: "test",
    test: (f) => f.startsWith("test/") || /\.test\.(m?js|cjs|ts)$/.test(f),
    message: "test(bot): обновить тесты",
  },
  {
    id: "env",
    test: (f) => f === "env.example" || f === ".env.example" || f === ".env.sample",
    message: "chore(env): обновить шаблон окружения",
  },
  {
    id: "root-docs",
    test: (f) =>
      f === "README.md" ||
      f === "NOTICE.md" ||
      f === "CONTRIBUTING.md" ||
      f === "LICENSE" ||
      f === "CHANGELOG.md",
    message: "docs(repo): обновить README и сопутствующие документы в корне",
  },
];

const MISC = {
  id: "misc",
  message: "chore(repo): обновить прочие файлы репозитория",
};

const BUCKET_ORDER = [
  "deps",
  "ci",
  "husky",
  "claude",
  "scripts",
  "tooling",
  "src",
  "test",
  "env",
  "root-docs",
  "misc",
];

function classifyFile(p) {
  for (const def of BUCKET_DEFS) {
    if (def.test(p)) return def;
  }
  return MISC;
}

function groupFiles(files) {
  const map = new Map();
  for (const f of files) {
    const def = classifyFile(f);
    if (!map.has(def.id)) map.set(def.id, { def, files: [] });
    map.get(def.id).files.push(f);
  }
  return map;
}

function sortBuckets(map) {
  const entries = [...map.entries()].filter(([, v]) => v.files.length > 0);
  entries.sort((a, b) => BUCKET_ORDER.indexOf(a[0]) - BUCKET_ORDER.indexOf(b[0]));
  return entries;
}

function assertCleanGitState() {
  try {
    execSync("git rev-parse -q --verify MERGE_HEAD", { stdio: "ignore" });
    console.error("atomic-commit: идет merge. Заверши или отмени его перед запуском.");
    process.exit(1);
  } catch {
    /* нет merge */
  }
  try {
    execSync("git rev-parse -q --verify REBASE_HEAD", { stdio: "ignore" });
    console.error("atomic-commit: идет rebase. Заверши или отмени его перед запуском.");
    process.exit(1);
  } catch {
    /* нет rebase */
  }
}

async function confirm(message) {
  const rl = createInterface({ input, output });
  const answer = await rl.question(message);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const yes = process.argv.includes("--yes");
  const stagedOnly = process.argv.includes("--staged-only");

  assertCleanGitState();

  const files = getChangedFiles({ stagedOnly });
  const statusMap = getFileStatus(files, { stagedOnly });
  if (files.length === 0) {
    const what = stagedOnly ? "в индексе" : "относительно HEAD";
    console.log(`atomic-commit: нечего коммитить (${what} пусто).`);
    process.exit(0);
  }

  const map = groupFiles(files);
  const buckets = sortBuckets(map);

  console.log(
    `atomic-commit: план коммитов (режим: ${stagedOnly ? "staged-only" : "worktree"}):\n`,
  );
  for (const [, { def, files: fs }] of buckets) {
    const msg = buildMessage(def, fs, statusMap);
    console.log(`  — ${msg}`);
    const preview = fs.slice(0, 8).join(", ");
    console.log(`    файлов (${fs.length}): ${preview}${fs.length > 8 ? ", …" : ""}\n`);
  }

  if (dryRun) {
    console.log("Dry run: коммиты не создавались.");
    process.exit(0);
  }

  if (!yes) {
    const ok = await confirm("Создать эти коммиты? [y/N] ");
    if (!ok) {
      console.log("Отменено.");
      process.exit(1);
    }
  }

  for (const [, { def, files: fs }] of buckets) {
    if (fs.length === 0) continue;
    const msg = buildMessage(def, fs, statusMap);
    const prettierTargets = fs.filter((p) => statusMap.get(p) !== "D" && PRETTIER_FILE_RE.test(p));
    runPrettierWrite(prettierTargets);
    const cachedStaged = new Set(
      gitStdoutRaw(["diff", "--cached", "--name-only", "-z"]).split("\0").filter(Boolean),
    );
    const toAdd = fs.filter((f) => !(cachedStaged.has(f) && !existsSync(f)));
    if (toAdd.length > 0) gitRun(["add", "-A", "--", ...toAdd]);
    gitRun(["commit", "-m", msg]);
    console.log(`Создан: ${msg}`);
  }

  console.log("\natomic-commit: готово. Проверь историю: git log -n 20 --oneline");
}

main().catch((e) => {
  if (printSandboxHint(e)) process.exit(1);
  console.error(e);
  process.exit(1);
});
