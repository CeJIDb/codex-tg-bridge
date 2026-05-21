#!/usr/bin/env node
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

const SUPPORTED = new Set([
  ".md",
  ".json",
  ".jsonc",
  ".yml",
  ".yaml",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".css",
  ".scss",
  ".html",
]);

const input = JSON.parse(readFileSync("/dev/stdin", "utf8"));
const filePath = input?.tool_input?.file_path;

if (!filePath || !SUPPORTED.has(extname(filePath))) process.exit(0);

try {
  execSync(`npx prettier --write "${filePath}"`, {
    cwd: process.env.CLAUDE_PROJECT_DIR,
    stdio: "inherit",
  });
} catch {
  // prettier failure should not block the agent
}
