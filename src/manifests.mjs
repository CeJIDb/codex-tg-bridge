// Чтение MANIFEST.md файлов из графа и построение карты code→url.
// Используется командой /sources и пост-обработкой ответов Codex (linkifyCitations).

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.mjs";

let cache = null;

export async function loadManifests() {
  if (cache) return cache;
  cache = await readFromDisk();
  return cache;
}

// Для тестов и при необходимости перечитать граф без рестарта бота.
export function resetManifestCache() {
  cache = null;
}

async function readFromDisk() {
  const sourcesDir = join(config.graphRepoPath, "sources");
  const sections = [];

  let entries;
  try {
    entries = await readdir(sourcesDir, { withFileTypes: true });
  } catch {
    // Нет sources/ — пробуем корневой MANIFEST.md
    try {
      const rootManifest = join(config.graphRepoPath, "MANIFEST.md");
      const content = await readFile(rootManifest, "utf8");
      const docs = parseManifestTable(content);
      if (docs.length > 0) sections.push({ issuer: null, docs });
    } catch {
      // ничего нет
    }
    return finalize(sections);
  }

  const dirs = entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));

  for (const ent of dirs) {
    const manifestPath = join(sourcesDir, ent.name, "MANIFEST.md");
    let content;
    try {
      content = await readFile(manifestPath, "utf8");
    } catch {
      continue;
    }
    sections.push({ issuer: ent.name, docs: parseManifestTable(content) });
  }

  return finalize(sections);
}

function finalize(sections) {
  const byCode = new Map();
  for (const sec of sections) {
    for (const doc of sec.docs) {
      if (doc.code && doc.url && !byCode.has(doc.code)) {
        byCode.set(doc.code, doc.url);
      }
    }
  }
  return { sections, byCode };
}

// Разбирает markdown-таблицу с колонками code, title и (опционально) url.
// В манифесте может быть несколько таблиц подряд — перепарсиваем заголовок
// каждый раз, когда видим строку с ячейками code/title.
export function parseManifestTable(md) {
  const lines = md.split("\n");
  let codeIdx = -1;
  let titleIdx = -1;
  let urlIdx = -1;
  let headerFound = false;
  const docs = [];

  for (const line of lines) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line
      .split("|")
      .map((c) => c.trim())
      .filter((_, i, arr) => i > 0 && i < arr.length - 1);
    if (cells.length === 0) continue;

    // Разделитель заголовка
    if (cells.every((c) => /^[-:]+$/.test(c))) continue;

    const lower = cells.map((c) => c.toLowerCase());
    if (lower.includes("code") && lower.includes("title")) {
      codeIdx = lower.findIndex((c) => c === "code");
      titleIdx = lower.findIndex((c) => c === "title");
      urlIdx = lower.findIndex((c) => c === "url");
      headerFound = true;
      continue;
    }

    if (!headerFound) continue;

    const code = stripMd(cells[codeIdx] ?? "");
    const title = stripMd(cells[titleIdx] ?? "");
    const url = urlIdx >= 0 ? extractUrl(cells[urlIdx] ?? "") : null;
    if (code && title) docs.push({ code, title, url });
  }
  return docs;
}

function extractUrl(cell) {
  const mdLink = cell.match(/\[[^\]]+\]\(([^)]+)\)/);
  if (mdLink) return mdLink[1];
  const plain = cell.match(/https?:\/\/\S+/);
  return plain ? plain[0] : null;
}

function stripMd(s) {
  return s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`]/g, "")
    .trim();
}

// URL-энкодим скобки — иначе markdown-парсер в format.mjs обрежет URL
// на первой `)` (это касается IMO-ссылок вида .../MSC.98(73).pdf).
export function urlForMarkdown(url) {
  if (!url) return null;
  return url.replace(/\(/g, "%28").replace(/\)/g, "%29");
}

// Превращает «Источники:» в конце ответа в гиперссылки + линкует inline-цитаты
// `[N, п. 6.3.5]` (и мульти-цитаты `[1, п. 7.1; 2, cl. 4.6.2]`) так, чтобы
// кликабельным был только номер N, а метаданные оставались плоским текстом.
// Ищем последнюю строку-заголовок «Источники», для каждой следующей строки
// вида «[N] CODE ...» подставляем markdown-ссылку, если CODE есть в byCode.
export function linkifyCitations(md, byCode) {
  if (!md || !byCode || byCode.size === 0) return md;

  const lines = md.split("\n");
  const headerRe = /^\s*(?:\*\*|#{1,6}\s+)?\s*Источники\s*[:?]?\s*(?:\*\*)?\s*$/u;

  let headerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (headerRe.test(lines[i])) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return md;

  const codes = [...byCode.keys()].sort((a, b) => b.length - a.length);
  const citationRe = /^(\s*)(\[(\d+)\])(\s+)(.*)$/;

  // N → url для второго прохода (линковка inline-цитат до заголовка «Источники:»).
  const nToUrl = new Map();

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(citationRe);
    if (!m) continue;
    const [, indent, num, n, sp, rest] = m;

    // Уже оформленная ссылка — URL берём из неё для inline-прохода.
    const already = rest.match(/^\[[^\]]+\]\(([^)]+)\)/);
    if (already) {
      nToUrl.set(n, already[1]);
      continue;
    }

    // Допускаем ведущий **жирный** и снимаем его для матчинга, потом возвращаем
    const boldMatch = rest.match(/^\*\*([^*\n]+?)\*\*(.*)$/);
    const target = boldMatch ? boldMatch[1] : rest;
    const tail = boldMatch ? boldMatch[2] : "";

    let matched = null;
    for (const code of codes) {
      if (target.startsWith(code)) {
        matched = code;
        break;
      }
    }
    if (!matched) continue;

    const url = urlForMarkdown(byCode.get(matched));
    if (!url) continue;
    nToUrl.set(n, url);
    const after = target.slice(matched.length);
    const linkLabel = boldMatch ? `**${matched}**` : matched;
    lines[i] = `${indent}${num}${sp}[${linkLabel}](${url})${after}${tail}`;
  }

  // Второй проход: inline `[N, …]` до заголовка «Источники:» —
  //  (а) ведущий N → markdown-ссылка (если URL известен);
  //  (б) защищаем имена файлов `name.ext` от Telegram auto-link, вставляя
  //      U+2060 WORD JOINER перед точкой расширения. `.md`, `.pdf`, `.io` —
  //      валидные TLD, Telegram подсвечивает их как ссылку, даже если это
  //      просто имя файла. Word joiner ломает детектор, текст визуально
  //      не меняется. Порядок важен: fileExt → потом N-link, иначе пробьём
  //      URL внутри `[N](url)`.
  // Поддерживаем мульти-цитаты `[1, …; 2, …]`.
  const inlineCiteRe = /\[(\d[^\[\]\n]*)\](?!\()/g;
  // tgAutoLinkRe ловит точку, по обе стороны которой ASCII-символ (буква/цифра).
  // Покрывает имена файлов и номерные ссылки (`6.3.5`, `1.2.3.4` → IPv4-детектор).
  // Кириллические сокращения `п.`, `гл.`, `разд.`, `ст.` Telegram и так не цепляет.
  const tgAutoLinkRe = /(?<=[a-zA-Z0-9_-])\.(?=[a-zA-Z\d])/g;
  const WORD_JOINER = "\u2060";
  for (let i = 0; i < headerIdx; i++) {
    lines[i] = lines[i].replace(inlineCiteRe, (whole, inner) => {
      let newInner = inner.replace(tgAutoLinkRe, `${WORD_JOINER}.`);
      if (nToUrl.size > 0) {
        newInner = newInner.replace(/(^|;\s*)(\d+)/g, (_, sep, n) => {
          const url = nToUrl.get(n);
          return url ? `${sep}[${n}](${url})` : `${sep}${n}`;
        });
      }
      return newInner === inner ? whole : `[${newInner}]`;
    });
  }

  return lines.join("\n");
}
