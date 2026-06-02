# CLAUDE.md

Guidance for Claude Code in repo.

## Response style

- **Reply in Russian.** Project + user Russian-speaking. File English only to save tokens — output
  not.
- **Terse. No filler, no recaps, no closing summaries.** One sentence per update usually enough.
- Don't paraphrase own actions — diff readable without commentary.
- Bullets only when help.

## What this repository is

Telegram bot **Лоцман** (`grammy` + `p-queue`) — thin bridge between Telegram and `codex exec` on
external graph repo (`GRAPH_REPO_PATH`). Little code, no business logic: accept message, run `codex`
in `--sandbox read-only`, return answer to chat, clean formatting for Telegram HTML.

Docs for humans:

- [README.md](README.md) — run, env, deps.
- [NOTICE.md](NOTICE.md) — borrowed patterns (DeepPavlov Dream, Apache-2.0).
- [env.example](env.example) — `.env` template, all vars.

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
├── plans/                   ← технические планы (один план = одна задача)
├── scripts/
│   ├── lint/                ← format-changed, markdownlint-changed, custom checks
│   ├── git/                 ← atomic-commit, check-branch-name, agent-reminder
│   ├── plans/               ← validate-plans.mjs
│   └── claude-hooks/        ← PreToolUse / PostToolUse hooks (see below)
├── .husky/                  ← pre-commit (agent-reminder + check:plans:staged), commit-msg
└── .github/workflows/       ← ci, commitlint, semantic-pr-title
```

## Where to touch what

| Task                                | File                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| Telegram handlers, queue, replies   | [src/bot.mjs](src/bot.mjs)                                                              |
| `codex exec` invocation, CLI args   | [src/codex.mjs](src/codex.mjs)                                                          |
| Token parsing from JSONL            | [src/codex.mjs](src/codex.mjs) — `parseTokens`                                          |
| System prompt / citation format     | [src/prompt.mjs](src/prompt.mjs)                                                        |
| User whitelist                      | [src/config.mjs](src/config.mjs) + `ALLOWED_USER_IDS` in `.env`                         |
| Markdown → Telegram HTML conversion | [src/format.mjs](src/format.mjs) — `mdToTgHtml`, `chunkByLines`                         |
| Small-talk replies (skip Codex)     | [src/triage.mjs](src/triage.mjs) — `MANUAL` and `DEEPPAVLOV`                            |
| Atomic commits                      | [scripts/git/atomic-commit.mjs](scripts/git/atomic-commit.mjs)                          |
| Linters over changed files          | [scripts/lint/](scripts/lint/)                                                          |
| Safety hooks for the agent          | [scripts/claude-hooks/](scripts/claude-hooks/)                                          |
| Plans + validator                   | [plans/](plans/) + [scripts/plans/validate-plans.mjs](scripts/plans/validate-plans.mjs) |

## Hard rules

1. **Never commit or push.** Agent never runs `git commit`, `git add`, `git push`,
   `npm run commit*`, `git merge`, `git rebase`, any history-mutating command. Stage nothing, author
   nothing. User commits manually. Holds even if user says "save", "finish", "wrap up" — those mean
   "stop editing", not "commit". Ask explicitly before touching git state.
2. **`read-only` sandbox untouchable.** In [src/codex.mjs](src/codex.mjs) `--sandbox read-only` flag
   guarantees bot cannot write to graph repo. Don't remove, don't make conditional, don't swap for
   `workspace-write`. Project's security contract.
3. **Whitelist mandatory.** Middleware in `bot.mjs` rejects foreign `user_id`s. Don't weaken check,
   don't add "default" user, don't read ids from message body.
4. **Secrets not committed.** `.env` in `.gitignore`; edit only [env.example](env.example).
   `block-secret-write.mjs` hook blocks writes to dotfiles with credentials.
5. **`codex` never invoked outside queue.** `concurrency=1` in `p-queue` — don't remove or raise.
   Parallel `codex` runs against same `GRAPH_REPO_PATH` break `--ephemeral` sessions, burn tokens in
   bulk.
6. **DeepPavlov Dream borrowings** in [src/triage.mjs](src/triage.mjs) must stay separable
   (`DEEPPAVLOV` block, links in comments) — else [NOTICE.md](NOTICE.md) stops matching reality. If
   change intents, sync NOTICE.
7. **`GRAPH_REPO_PATH` external path.** Don't hardcode, don't assume specific contents (bot works on
   any graph, not only marine-requirements-graph).
8. **Tests without framework.** `node --test`-compatible scripts on `node:test` / `node:assert`.
   Don't pull jest/vitest for one file.

## Технические планы

Любая нетривиальная задача стартует с плана в [plans/](plans/). Правила — в
[plans/README.md](plans/README.md). Кратко:

- Один план = одно изменение. Файл: `plans/YYYY-MM-DD-kebab-name.md`.
- Обязательны: H1-заголовок, фазы со статусом `[ ]`/`[x]`, секция `## Итог` в конце.
- Без таймингов. Цель и DoD — да, расписание — нет.
- Актуализируй план по ходу: отмечай фазы, обновляй итог.

Скиллы агента:

- [.claude/skills/plan-creator/](.claude/skills/plan-creator/) — создать план по шаблону.
- [.claude/skills/plan-validator/](.claude/skills/plan-validator/) — проверить план на соответствие
  правилам.

Валидатор: [scripts/plans/validate-plans.mjs](scripts/plans/validate-plans.mjs).

```bash
npm run check:plans          # проверить все планы
npm run check:plans:staged   # проверить только застейдженные (то же делает pre-commit)
node ./scripts/plans/validate-plans.mjs plans/2026-05-22-some-task.md  # один файл
```

PostToolUse-хук
[scripts/claude-hooks/validate-plan-on-write.mjs](scripts/claude-hooks/validate-plan-on-write.mjs)
авто-валидирует план после правки агентом. PreToolUse-хук
[scripts/claude-hooks/validate-staged-plans.mjs](scripts/claude-hooks/validate-staged-plans.mjs)
блокирует `git commit`, если в индексе невалидные планы.

## Lint, format, CI

Before commit:

```bash
npm run format        # prettier on changed files (git diff + untracked)
npm run ci:check      # format:check + markdownlint + custom checks + check:plans
npm run format:all    # prettier on the whole repo
npm run ci:check:all  # full check
```

Tests:

```bash
npm run test:triage
npm run test:format
```

GitHub Actions in [.github/workflows/](.github/workflows/) enforce same gates plus `commitlint` +
semantic-PR-title.

## Git workflow

Reminder: agent never runs commit/add/push (see Hard rule #1). Conventions below describe how
**user** commits — advise on commit messages/branch names when asked, don't execute.

- **Conventional Commits.** Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`,
  `build`, `perf`, `revert`. Header ≤ 100 chars. Type + scope latin, **subject Russian** (see
  [commitlint.config.cjs](commitlint.config.cjs)).
- **Branch names:** `feature/*`, `fix/*`, `docs/*`, `chore/*`, `hotfix/*` — lowercase latin,
  kebab-case. Enforced by [scripts/git/check-branch-name.mjs](scripts/git/check-branch-name.mjs).
- **Atomic commits.** User runs `npm run commit` (format + ci:check on changed → atomic commit).
  Preview without commit: `npm run commit:atomic:dry-run`.
- **Pushes to `main` blocked** by
  [scripts/claude-hooks/block-push-to-main.mjs](scripts/claude-hooks/block-push-to-main.mjs) — by
  design.
- **`git add -A` / `git add .` blocked** by
  [scripts/claude-hooks/block-unsafe-git-add.mjs](scripts/claude-hooks/block-unsafe-git-add.mjs).
- Husky `pre-commit` runs agent reminder; `commit-msg` runs commitlint. Don't skip with
  `--no-verify`.

Read-only git fine: `git status`, `git diff`, `git log`, `git show`, `git blame` — use freely to
understand state before editing.

## Hooks worth knowing about

In [scripts/claude-hooks/](scripts/claude-hooks/):

- `format-on-write.mjs` — auto-prettier on md/json/yaml/js/mjs after Write/Edit. File may get
  reformatted — don't fight it.
- `block-push-to-main.mjs` — cuts off `git push … main|master`.
- `block-unsafe-git-add.mjs` — cuts off `git add -A` / `git add .`.
- `block-secret-write.mjs` — cuts off writes to `.env`, `.env.*`, other dotfiles with secrets.
- `validate-plan-on-write.mjs` — PostToolUse: после правки `plans/YYYY-MM-DD-*.md` запускает
  валидатор, блокирует следующий шаг если план невалиден.
- `validate-staged-plans.mjs` — PreToolUse на Bash: перед `git commit` проверяет застейдженные
  планы, блокирует коммит на ошибках.
- `play-sound.sh` — звуковые оповещения на события `Stop` (короткий звук завершения), `Notification`
  и `PermissionRequest` (три звука / привлекающий внимание). Fallback: paplay → PowerShell (WSLg) →
  терминальный bell. Громкость через `CLAUDE_SOUND_VOLUME` (0..65536, по умолчанию 49152).

## When editing `prompt.mjs`

System preamble in [src/prompt.mjs](src/prompt.mjs) defines citation format + navigation protocol
over graph's `MANIFEST.md`. When changing, keep in mind:

- Bot doesn't know structure of specific graph at startup; prompt describes protocol for locating
  canonical document names, not concrete paths.
- Don't tie prompt to file names from specific graph (`sources/rmrs/...` etc. — invariants of
  marine-requirements-graph, but bot must work with other graphs too).

## What not to do

- Don't turn into framework. ~5 files in `src/` — keep that way.
- Don't pull separate logger, metrics, OTel, etc. for "correctness" — `console.log` with structure
  from `logTurn` / `logError` enough + readable.
- Don't add persistence (DB, response cache) without explicit request — orthogonal to goal.
- Don't extend `triage.mjs` into "smart" NLU. Intentionally dumb regex filter for small-talk;
  substantive must reach Codex.
- Don't write English into user-facing markdown (README, NOTICE, env.example) — domain language
  Russian. This file exception, English for token economy.
- Don't propose migrations to TypeScript, esbuild, monorepo, Docker, other infra without explicit
  request.
