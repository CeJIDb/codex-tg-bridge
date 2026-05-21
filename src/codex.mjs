import { execa } from "execa";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.mjs";
import { withSystemPreamble } from "./prompt.mjs";

export async function askCodex(prompt) {
  const dir = await mkdtemp(join(tmpdir(), "codex-tg-"));
  const outFile = join(dir, "answer.txt");

  const args = [
    "exec",
    "-C",
    config.graphRepoPath,
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--json",
    "--color",
    "never",
    "-o",
    outFile,
  ];
  if (config.codexModel) {
    args.push("-m", config.codexModel);
  }
  if (config.codexEffort) {
    args.push("-c", `model_reasoning_effort="${config.codexEffort}"`);
  }
  args.push(withSystemPreamble(prompt));

  const startedAt = Date.now();
  let stdoutBuf = "";
  let stderrBuf = "";

  try {
    const child = execa("codex", args, {
      timeout: config.codexTimeoutMs,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      reject: true,
    });
    child.stdout?.on("data", (b) => (stdoutBuf += b.toString()));
    child.stderr?.on("data", (b) => (stderrBuf += b.toString()));
    await child;

    const answer = (await readFile(outFile, "utf8")).trim() || "(Codex вернул пустой ответ)";
    if (config.codexDebugDir) {
      try {
        await mkdir(config.codexDebugDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await writeFile(join(config.codexDebugDir, `${stamp}.jsonl`), stdoutBuf);
      } catch (e) {
        console.warn("Не смог записать дамп JSONL:", e.message);
      }
    }
    return {
      answer,
      tokens: parseTokens(stdoutBuf),
      elapsedMs: Date.now() - startedAt,
      model: config.codexModel,
      effort: config.codexEffort,
    };
  } catch (err) {
    // Прокидываем stderr наверх — пусть бот решит, показывать ли его.
    if (stderrBuf.trim()) err.codexStderr = stderrBuf.trim();
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Codex CLI 0.130 шлёт `turn.completed` с per-turn `usage` на верхнем уровне:
//   {"type":"turn.completed","usage":{"input_tokens":...,"cached_input_tokens":...,
//    "output_tokens":...,"reasoning_output_tokens":...}}
// Складываем все turn.completed — как делает TUI для cumulative-итога сессии.
// Поддерживаем и старые/чужие сборки, где usage может лежать глубже.
export function parseTokens(jsonl) {
  let input = 0;
  let output = 0;
  let any = false;
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const usage = findUsageNode(evt);
    if (!usage) continue;
    const i = numOrNull(usage.input_tokens ?? usage.prompt_tokens ?? usage.input);
    const o = numOrNull(usage.output_tokens ?? usage.completion_tokens ?? usage.output);
    if (i != null) {
      input += i;
      any = true;
    }
    if (o != null) {
      output += o;
      any = true;
    }
  }
  if (!any) return null;
  return { total: input + output };
}

function findUsageNode(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return null;
  if (looksLikeUsage(node)) return node;
  for (const v of Object.values(node)) {
    const deep = findUsageNode(v, depth + 1);
    if (deep) return deep;
  }
  return null;
}

function looksLikeUsage(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  return (
    typeof obj.input_tokens === "number" ||
    typeof obj.prompt_tokens === "number" ||
    typeof obj.output_tokens === "number" ||
    typeof obj.completion_tokens === "number"
  );
}

function numOrNull(v) {
  return typeof v === "number" ? v : null;
}
