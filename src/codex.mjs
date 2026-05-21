import { execa } from "execa";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

  try {
    await execa("codex", args, {
      timeout: config.codexTimeoutMs,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      reject: true,
    });
    const answer = await readFile(outFile, "utf8");
    return answer.trim() || "(Codex вернул пустой ответ)";
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
