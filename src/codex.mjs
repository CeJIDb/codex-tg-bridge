import { execa } from "execa";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.mjs";
import { withSystemPreamble } from "./prompt.mjs";
import { makeJsonlParser, parseTokens } from "./codex-parser.mjs";

export { makeJsonlParser, parseTokens } from "./codex-parser.mjs";

export async function askCodexStream(prompt, { onDelta, onActivity, signal } = {}) {
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

  const parser = makeJsonlParser({ onDelta, onActivity });

  try {
    const execaOpts = {
      timeout: config.codexTimeoutMs,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      reject: true,
    };
    if (signal) {
      execaOpts.cancelSignal = signal;
    }

    const child = execa("codex", args, execaOpts);

    child.stdout?.on("data", (chunk) => {
      const str = chunk.toString();
      stdoutBuf += str;
      parser.push(str);
    });
    child.stderr?.on("data", (b) => (stderrBuf += b.toString()));

    await child;
    parser.flush();

    let answer = parser.getAnswer();

    // Фолбэк: если onDelta не был вызван — читаем outFile как раньше
    if (!answer) {
      answer = (await readFile(outFile, "utf8")).trim() || "(Codex вернул пустой ответ)";
    }

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
    if (stderrBuf.trim()) err.codexStderr = stderrBuf.trim();
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function askCodex(prompt) {
  return askCodexStream(prompt, {});
}
