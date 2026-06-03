# codex-tg-bridge — Telegram bot for a graph knowledge base

**Languages:** [Русский](README.md) · **English**

[![CI](https://github.com/CeJIDb/codex-tg-bridge/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/CeJIDb/codex-tg-bridge/actions/workflows/ci.yml)![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)![Last commit](https://img.shields.io/github/last-commit/CeJIDb/codex-tg-bridge)

A thin bridge between Telegram and [Codex CLI](https://github.com/openai/codex) that turns aЫny
Markdown knowledge repository into a chat assistant with verifiable source citations.

**Repository:** [CeJIDb/codex-tg-bridge](https://github.com/CeJIDb/codex-tg-bridge)

> Russian is the primary language of this project. In-repo docs (`CLAUDE.md`, `plans/`,
> `docs/graphify-setup.md`) are kept in Russian.

## Pain → Solution

**Pain.** The knowledge is already in Markdown, but answering from it is still inconvenient: you
have to remember where to look, open several files, and check links by hand. A regular AI chat is
faster, but without a connection to your repository and sources, its answers are hard to verify.

**Solution.** The bot turns a Markdown repository into a Telegram assistant. You ask a question in
chat, the bot runs Codex over the knowledge base in read-only mode, finds the relevant fragments,
and returns an answer with citations. The repository cannot be changed from chat, and access is
limited to allowed Telegram users.

## Architecture and pipeline

```text
Telegram → grammy handler → whitelist (user_id) → p-queue (concurrency=1)
        → triage (small-talk?) → codex exec --sandbox read-only --ephemeral
        → mdToTgHtml → chunkByLines(≤4000) → reply
```

- **Sandbox `read-only`** ([src/codex.mjs](src/codex.mjs)) — the bot cannot write a single byte into
  the graph.
- **Whitelist** ([src/config.mjs](src/config.mjs), `ALLOWED_USER_IDS`) — anything outside the list
  is silently ignored.
- **`concurrency=1`** — two parallel Codex calls break `--ephemeral` sessions and double the token
  spend, so the queue is single-threaded.
- **Reply context** — up to `REPLY_CONTEXT_DEPTH` conversation turns are restored via Telegram
  replies, with no server-side state.

## Universality

The bot has no knowledge of the graph's domain — the path is supplied via `GRAPH_REPO_PATH`. The
same binary serves a graph on marine automation, on medical protocols, on corporate security
policies, on product requirements, on university course materials — anything that atomizes into
Markdown. Switching domains = changing one variable in `.env` and restarting the bot. Graph content
and structure — see [docs/graphify-setup.md](docs/graphify-setup.md) (Russian).

## Stack

| Layer        | What is used                                                                             |
| ------------ | ---------------------------------------------------------------------------------------- |
| Runtime      | Node.js ≥ 20, ES modules                                                                 |
| Telegram     | [grammy](https://grammy.dev/)                                                            |
| Queue        | [p-queue](https://github.com/sindresorhus/p-queue) — `concurrency=1`                     |
| Subprocesses | [execa](https://github.com/sindresorhus/execa)                                           |
| Config       | [dotenv](https://github.com/motdotla/dotenv)                                             |
| LLM backend  | [Codex CLI](https://github.com/openai/codex) — external binary (`codex login`)           |
| Knowledge    | Markdown repo built with the [`/graphify`](https://github.com/safishamsi/graphify) skill |
| Tests        | `node:test` / `node:assert`, no frameworks                                               |
| Lint, format | Prettier, markdownlint, custom scripts in [scripts/lint/](scripts/lint/)                 |
| CI           | GitHub Actions: format-check, markdownlint, commitlint, semantic-pr-title                |

## Installation

**Prerequisites:** Node.js ≥ 20, `npm`, [Codex CLI](https://github.com/openai/codex) on `PATH`
(`codex login`), a bot from [@BotFather](https://t.me/BotFather), and your Telegram `user_id` from
[@userinfobot](https://t.me/userinfobot).

**Graph repository.** The knowledge source is a separate git repository with Markdown documents and
a `MANIFEST.md` entry point. Built with the [`/graphify`](https://github.com/safishamsi/graphify)
skill; full guide (minimum skeleton, `ONTOLOGY.md`, crosswalks, anti-patterns) — in
[docs/graphify-setup.md](docs/graphify-setup.md) (Russian).

**Bot:**

```bash
git clone https://github.com/CeJIDb/codex-tg-bridge.git
cd codex-tg-bridge
npm install
cp env.example .env   # fill in BOT_TOKEN, ALLOWED_USER_IDS, GRAPH_REPO_PATH
npm start
```

### `.env` variables

| Variable              | Purpose                                                                            |
| --------------------- | ---------------------------------------------------------------------------------- |
| `BOT_TOKEN`           | Bot token from [@BotFather](https://t.me/BotFather).                               |
| `ALLOWED_USER_IDS`    | Comma-separated list of allowed Telegram user ids.                                 |
| `GRAPH_REPO_PATH`     | Absolute path to the graphify repository.                                          |
| `CODEX_MODEL`         | (opt.) Override the Codex model. Defaults to `~/.codex/config.toml`.               |
| `CODEX_EFFORT`        | (opt.) Reasoning level: `minimal`/`low`/`medium`/`high`/`xhigh`. Default `medium`. |
| `CODEX_TIMEOUT_MS`    | (opt.) Per-request Codex timeout in ms. Default `300000`.                          |
| `CODEX_DEBUG_DIR`     | (opt.) Folder for raw Codex JSONL (token-parser debugging).                        |
| `REPLY_CONTEXT_DEPTH` | (opt.) Reply context depth. `0` disables. Default `3`.                             |

Full template — [env.example](env.example).

## License

[MIT](LICENSE). Borrowings from third-party projects (Apache-2.0) — [NOTICE.md](NOTICE.md).
