# CLAUDE.md

Guidance for Claude Code in this repository.

## Response style

- **Reply in Russian.** The project and the user are Russian-speaking. This file is in English only
  to save tokens — your output is not.
- **Be terse. No filler, no recaps, no closing summaries.** One sentence per update is usually
  enough.
- Don't paraphrase your own actions — the diff is readable without commentary.
- Bullet lists only when they actually help.

## What this repository is

Telegram bot **Лоцман** (`grammy` + `p-queue`) — a thin bridge between Telegram and `codex exec` on
top of an external graph repository (`GRAPH_REPO_PATH`). Very little code, no business logic: the
single job is to accept a message, run `codex` in `--sandbox read-only`, return the answer to the
chat, cleaning up formatting for Telegram HTML along the way.

Docs for humans:

- [README.md](README.md) — run, env, dependencies.
- [NOTICE.md](NOTICE.md) — borrowed patterns (DeepPavlov Dream, Apache-2.0).
- [env.example](env.example) — `.env` template with all variables.

## Repository map

```text
codex-tg-bridge/
├── CLAUDE.md                ← this file
├── README.md                ← entry point for humans
├── NOTICE.md                ← third parties and their licenses
├── env.example              ← .env template
├── src/
│   ├── index.mjs            ← bootstrap, SIGINT/SIGTERM, banner
│   ├── bot.mjs              ← grammy handlers, queue, reply pipeline
│   ├── codex.mjs            ← codex CLI invocation, JSONL parsing, tokens
│   ├── config.mjs           ← env validation, config export
│   ├── prompt.mjs           ← system preamble (citation format)
│   ├── triage.mjs           ← local small-talk filter before Codex
│   └── format.mjs           ← Markdown → Telegram HTML + chunking
├── test/
│   ├── format.test.mjs      ← run: `npm run test:format`
│   └── triage.test.mjs      ← run: `npm run test:triage`
├── scripts/
│   ├── lint/                ← format-changed, markdownlint-changed, custom checks
│   ├── git/                 ← atomic-commit, check-branch-name, agent-reminder
│   └── claude-hooks/        ← PreToolUse hooks (see below)
├── .husky/                  ← pre-commit (agent-reminder), commit-msg (commitlint)
└── .github/workflows/       ← ci, commitlint, semantic-pr-title
```

## Where to touch what

| Task                                | File                                                            |
| ----------------------------------- | --------------------------------------------------------------- |
| Telegram handlers, queue, replies   | [src/bot.mjs](src/bot.mjs)                                      |
| `codex exec` invocation, CLI args   | [src/codex.mjs](src/codex.mjs)                                  |
| Token parsing from JSONL            | [src/codex.mjs](src/codex.mjs) — `parseTokens`                  |
| System prompt / citation format     | [src/prompt.mjs](src/prompt.mjs)                                |
| User whitelist                      | [src/config.mjs](src/config.mjs) + `ALLOWED_USER_IDS` in `.env` |
| Markdown → Telegram HTML conversion | [src/format.mjs](src/format.mjs) — `mdToTgHtml`, `chunkByLines` |
| Small-talk replies (skip Codex)     | [src/triage.mjs](src/triage.mjs) — `MANUAL` and `DEEPPAVLOV`    |
| Atomic commits                      | [scripts/git/atomic-commit.mjs](scripts/git/atomic-commit.mjs)  |
| Linters over changed files          | [scripts/lint/](scripts/lint/)                                  |
| Safety hooks for the agent          | [scripts/claude-hooks/](scripts/claude-hooks/)                  |

## Hard rules

1. **Never commit or push.** The agent does not run `git commit`, `git add`, `git push`,
   `npm run commit*`, `git merge`, `git rebase`, or any other history-mutating command. Stage
   nothing, author nothing. The user commits manually. This holds even if the user says "save",
   "finish", or "wrap up" — those mean "stop editing", not "commit". Ask explicitly before touching
   git state.
2. **`read-only` sandbox is untouchable.** In [src/codex.mjs](src/codex.mjs) the
   `--sandbox read-only` flag guarantees the bot cannot write anything into the graph repo. Don't
   remove, don't make conditional, don't swap for `workspace-write`. This is the project's security
   contract.
3. **Whitelist is mandatory.** The middleware in `bot.mjs` rejects foreign `user_id`s. Don't weaken
   the check, don't add a "default" user, don't read ids from the message body.
4. **Secrets are not committed.** `.env` is in `.gitignore`; edit only [env.example](env.example).
   The `block-secret-write.mjs` hook blocks writes to dotfiles with credentials.
5. **`codex` is never invoked outside the queue.** `concurrency=1` in `p-queue` — don't remove or
   raise it. Parallel `codex` runs against the same `GRAPH_REPO_PATH` break `--ephemeral` sessions
   and burn tokens in bulk.
6. **DeepPavlov Dream borrowings** in [src/triage.mjs](src/triage.mjs) must remain separable (the
   `DEEPPAVLOV` block, links in comments) — otherwise [NOTICE.md](NOTICE.md) stops matching reality.
   If you change the intents, sync NOTICE.
7. **`GRAPH_REPO_PATH` is an external path.** Don't hardcode it, don't assume specific contents (the
   bot works on top of any graph, not only marine-requirements-graph).
8. **Tests without a framework.** These are `node --test`-compatible scripts on `node:test` /
   `node:assert`. Don't pull jest/vitest for a single file.

## Lint, format, CI

Before committing:

```bash
npm run format        # prettier on changed files (git diff + untracked)
npm run ci:check      # format:check + markdownlint + custom checks on changed files
npm run format:all    # prettier on the whole repo
npm run ci:check:all  # full check
```

Tests:

```bash
npm run test:triage
npm run test:format
```

GitHub Actions in [.github/workflows/](.github/workflows/) enforce the same gates plus `commitlint`
and semantic-PR-title.

## Git workflow

Reminder: the agent never runs commit/add/push (see Hard rule #1). The conventions below describe
how the **user** commits, so you can advise on commit messages or branch names when asked — not so
you can execute them.

- **Conventional Commits.** Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`,
  `build`, `perf`, `revert`. Header ≤ 100 chars. Type and scope in latin, **subject in Russian**
  (see [commitlint.config.cjs](commitlint.config.cjs)).
- **Branch names:** `feature/*`, `fix/*`, `docs/*`, `chore/*`, `hotfix/*` — lowercase latin,
  kebab-case. Enforced by [scripts/git/check-branch-name.mjs](scripts/git/check-branch-name.mjs).
- **Atomic commits.** The user runs `npm run commit` (format + ci:check on changed → atomic commit).
  Preview without committing: `npm run commit:atomic:dry-run`.
- **Pushes to `main` are blocked** by
  [scripts/claude-hooks/block-push-to-main.mjs](scripts/claude-hooks/block-push-to-main.mjs) — by
  design.
- **`git add -A` / `git add .` are blocked** by
  [scripts/claude-hooks/block-unsafe-git-add.mjs](scripts/claude-hooks/block-unsafe-git-add.mjs).
- Husky `pre-commit` runs the agent reminder; `commit-msg` runs commitlint. Don't skip with
  `--no-verify`.

Read-only git is fine: `git status`, `git diff`, `git log`, `git show`, `git blame` — use them
freely to understand state before editing.

## Hooks worth knowing about

In [scripts/claude-hooks/](scripts/claude-hooks/):

- `format-on-write.mjs` — auto-prettier on md/json/yaml/js/mjs after Write/Edit. Your file may get
  reformatted — don't fight it.
- `block-push-to-main.mjs` — cuts off `git push … main|master`.
- `block-unsafe-git-add.mjs` — cuts off `git add -A` / `git add .`.
- `block-secret-write.mjs` — cuts off writes to `.env`, `.env.*`, other dotfiles with secrets.

## When editing `prompt.mjs`

The system preamble in [src/prompt.mjs](src/prompt.mjs) defines the citation format and the
navigation protocol over the graph's `MANIFEST.md`. When you change it, keep in mind:

- The bot does not know the structure of any specific graph at startup; the prompt describes a
  protocol for locating canonical document names, not concrete paths.
- Don't tie the prompt to file names from a specific graph (`sources/rmrs/...` etc. — those are
  invariants of marine-requirements-graph, but the bot must work with other graphs too).

## What not to do

- Don't turn this into a framework. There are ~5 files in `src/` — keep it that way.
- Don't pull in a separate logger, metrics, OTel, etc. for "correctness" — `console.log` with the
  structure from `logTurn` / `logError` is enough and readable.
- Don't add persistence (DB, response cache) without an explicit request — it's orthogonal to the
  goal.
- Don't extend `triage.mjs` into a "smart" NLU. It's intentionally a dumb regex filter for
  small-talk; anything substantive must reach Codex.
- Don't write English content into user-facing markdown files (README, NOTICE, env.example) — the
  domain language is Russian. This file is the exception, kept in English for token economy.
- Don't propose migrations to TypeScript, esbuild, a monorepo, Docker, or other infrastructure
  without an explicit request.
