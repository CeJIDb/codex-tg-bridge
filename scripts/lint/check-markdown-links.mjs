#!/usr/bin/env node
/**
 * Резолвит обычные markdown-ссылки [text](path[#anchor]) в указанных каталогах
 * и сообщает о битых путях и якорях.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
const ROOT = process.cwd();
const TARGETS = ["README.md", "NOTICE.md"];
const IGNORE_PREFIXES = ["http://", "https://", "mailto:", "tel:"];
const SKIP_FILES = new Set();
const SKIP_DIRS = new Set();
const MARKDOWN_LINK_REGEX = /\[[^\]]+\]\(([^)]+)\)/g;

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
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const childPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(childPath.replace(/\\/g, "/"))) continue;
      await collectMarkdownFiles(childPath, acc);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      acc.push(path.join(ROOT, childPath));
    }
  }
}

function shouldSkip(link) {
  return IGNORE_PREFIXES.some((prefix) => link.startsWith(prefix));
}

function decodeMaybe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseMarkdownHref(rawLink) {
  return rawLink.trim().split(/\s+/)[0];
}

function slugifyHeading(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

const headerSlugCache = new Map();

function extractHeaderSlugs(content) {
  const slugs = new Set();
  const slugCounts = new Map();
  let inCodeFence = false;

  function addSlug(baseSlug) {
    if (!baseSlug) return;
    const count = slugCounts.get(baseSlug) ?? 0;
    const final = count === 0 ? baseSlug : `${baseSlug}-${count}`;
    slugCounts.set(baseSlug, count + 1);
    slugs.add(final);
  }

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (/^```/.test(line) || /^~~~/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    const idMatches = [...line.matchAll(/(?:id|name)=["']([^"']+)["']/g)];
    for (const m of idMatches) {
      const id = (m[1] ?? "").toLowerCase();
      if (id) slugs.add(id);
    }

    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!m) continue;

    let headerText = m[2].trim();
    headerText = headerText.replace(/\{#.+\}\s*$/, "");
    headerText = headerText.replace(/`([^`]*)`/g, "$1");
    addSlug(slugifyHeading(headerText));
  }

  return slugs;
}

async function getHeaderSlugsForFile(absPath) {
  if (headerSlugCache.has(absPath)) return headerSlugCache.get(absPath);
  const content = await fs.readFile(absPath, "utf-8");
  const slugs = extractHeaderSlugs(content);
  headerSlugCache.set(absPath, slugs);
  return slugs;
}

function stripCodeForLinkCheck(content) {
  const lines = content.split(/\r?\n/);
  const result = [];
  let inFence = false;
  for (const line of lines) {
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      result.push("");
      continue;
    }
    if (inFence) {
      result.push("");
      continue;
    }
    result.push(line.replace(/`[^`]*`/g, ""));
  }
  return result.join("\n");
}

async function checkFileLinks(filePath) {
  const errors = [];
  const rawContent = await fs.readFile(filePath, "utf-8");
  const content = stripCodeForLinkCheck(rawContent);
  const dir = path.dirname(filePath);

  for (const match of content.matchAll(MARKDOWN_LINK_REGEX)) {
    const rawLink = match[1].trim();
    if (!rawLink) continue;

    const href = parseMarkdownHref(rawLink);
    if (!href || shouldSkip(href)) continue;

    const [pathPart, anchorPartRaw = ""] = href.split("#", 2);
    const anchorPart = anchorPartRaw ? decodeMaybe(anchorPartRaw) : "";

    let resolved;
    if (!pathPart) {
      resolved = filePath;
    } else {
      const linkPath = decodeMaybe(pathPart);
      if (!linkPath) continue;
      resolved = path.resolve(dir, linkPath);
    }

    try {
      await fs.access(resolved);
    } catch {
      errors.push(`broken relative link '${href}'`);
      continue;
    }

    if (!anchorPart) continue;
    // Якоря проверяем только в .md — на бинарниках они бессмысленны.
    if (!resolved.endsWith(".md")) continue;

    const slugs = await getHeaderSlugsForFile(resolved);
    const anchorLower = anchorPart.toLowerCase();
    if (!slugs.has(anchorLower)) {
      const anchorSlugified = slugifyHeading(anchorPart);
      if (!slugs.has(anchorSlugified)) {
        const relResolved = path.relative(ROOT, resolved);
        errors.push(`broken anchor '#${anchorPart}' in '${relResolved}'`);
      }
    }
  }

  return errors;
}

async function main() {
  const files = [];
  for (const target of TARGETS) {
    try {
      await collectMarkdownFiles(target, files);
    } catch {
      // каталог может отсутствовать, пропускаем
    }
  }

  let hasErrors = false;
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    if (SKIP_FILES.has(rel)) continue;
    const errors = await checkFileLinks(file);
    if (errors.length > 0) {
      hasErrors = true;
      for (const err of errors) console.error(`${rel}: ${err}`);
    }
  }

  if (hasErrors) process.exit(1);
  console.log(`Markdown link checks passed: ${files.length} file(s).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
