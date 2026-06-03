# codex-tg-bridge — Telegram-бот для графовой базы знаний

**Languages:** **Русский** · [English](README.en.md)

[![CI](https://github.com/CeJIDb/codex-tg-bridge/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/CeJIDb/codex-tg-bridge/actions/workflows/ci.yml)![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)![Last commit](https://img.shields.io/github/last-commit/CeJIDb/codex-tg-bridge)

Тонкий мост между Telegram и [Codex CLI](https://github.com/openai/codex), который превращает любой
репозиторий с Markdown-знаниями в чат-помощника с цитированием источников.

**Репозиторий:** [CeJIDb/codex-tg-bridge](https://github.com/CeJIDb/codex-tg-bridge)

## Боль → Решение

**Боль.** Знания уже лежат в Markdown, но отвечать по ним всё равно неудобно: нужно помнить, где
искать, открывать несколько файлов и вручную проверять ссылки. Обычный AI-чат быстрее, но без
привязки к вашему репозиторию и источникам его ответы сложно проверять.

**Решение.** Бот превращает Markdown-репозиторий в Telegram-помощника. Вы задаёте вопрос в чате, бот
запускает Codex по базе знаний в режиме только для чтения, находит нужные фрагменты и возвращает
ответ с цитатами. Репозиторий при этом нельзя изменить из чата, а доступ есть только у разрешённых
Telegram-пользователей.

## Архитектура и пайплайн

```text
Telegram → grammy handler → whitelist (user_id) → p-queue (concurrency=1)
        → triage (small-talk?) → codex exec --sandbox read-only --ephemeral
        → mdToTgHtml → chunkByLines(≤4000) → reply
```

- **Sandbox `read-only`** ([src/codex.mjs](src/codex.mjs)) — бот не может записать в граф ни байта.
- **Whitelist** ([src/config.mjs](src/config.mjs), `ALLOWED_USER_IDS`) — всё, что не из списка,
  молча игнорируется.
- **`concurrency=1`** — два параллельных запроса к Codex ломают `--ephemeral` сессии и удваивают
  токены, поэтому очередь однопоточная.
- **Reply-контекст** — до `REPLY_CONTEXT_DEPTH` шагов диалога восстанавливается через
  Telegram-reply, без серверного state.

## Универсальность

Бот не знает о домене графа: путь задаётся переменной `GRAPH_REPO_PATH`. Один и тот же бинарь
обслуживает граф по морской автоматизации, по медицинским протоколам, по корпоративным политикам ИБ,
по требованиям к продукту, по университетским методичкам — что угодно, что атомизируется в Markdown.
Сменить домен = поменять переменную в `.env` и перезапустить. Содержимое и структура графа — в
[docs/graphify-setup.md](docs/graphify-setup.md).

## Стек

| Слой         | Что используется                                                                       |
| ------------ | -------------------------------------------------------------------------------------- |
| Runtime      | Node.js ≥ 20, ES modules                                                               |
| Telegram     | [grammy](https://grammy.dev/)                                                          |
| Очередь      | [p-queue](https://github.com/sindresorhus/p-queue) — `concurrency=1`                   |
| Подпроцессы  | [execa](https://github.com/sindresorhus/execa)                                         |
| Конфиг       | [dotenv](https://github.com/motdotla/dotenv)                                           |
| LLM-бэкенд   | [Codex CLI](https://github.com/openai/codex) — внешний бинарь (`codex login`)          |
| Граф знаний  | Markdown-репо, собранный скиллом [`/graphify`](https://github.com/safishamsi/graphify) |
| Тесты        | `node:test` / `node:assert`, без фреймворков                                           |
| Линт, формат | Prettier, markdownlint, кастомные скрипты в [scripts/lint/](scripts/lint/)             |
| CI           | GitHub Actions: format-check, markdownlint, commitlint, semantic-pr-title              |

## Установка

**Зависимости:** Node.js ≥ 20, `npm`, [Codex CLI](https://github.com/openai/codex) на `PATH`
(`codex login`), бот от [@BotFather](https://t.me/BotFather) и ваш Telegram `user_id` от
[@userinfobot](https://t.me/userinfobot).

**Граф-репозиторий.** Источник знаний — отдельный git-репозиторий с Markdown-документами и точкой
входа `MANIFEST.md`. Собирается скиллом [`/graphify`](https://github.com/safishamsi/graphify);
полная инструкция (минимальный скелет, `ONTOLOGY.md`, кросс-вокки, антипаттерны) — в
[docs/graphify-setup.md](docs/graphify-setup.md).

**Бот:**

```bash
git clone https://github.com/CeJIDb/codex-tg-bridge.git
cd codex-tg-bridge
npm install
cp env.example .env   # заполнить BOT_TOKEN, ALLOWED_USER_IDS, GRAPH_REPO_PATH
npm start
```

### Переменные `.env`

| Переменная            | Назначение                                                                            |
| --------------------- | ------------------------------------------------------------------------------------- |
| `BOT_TOKEN`           | Токен бота от [@BotFather](https://t.me/BotFather).                                   |
| `ALLOWED_USER_IDS`    | Разрешённые Telegram user id через запятую.                                           |
| `GRAPH_REPO_PATH`     | Абсолютный путь к graphify-репозиторию.                                               |
| `CODEX_MODEL`         | (опц.) Переопределение модели. По умолчанию — из `~/.codex/config.toml`.              |
| `CODEX_EFFORT`        | (опц.) Уровень рассуждений: `minimal`/`low`/`medium`/`high`/`xhigh`. Дефолт `medium`. |
| `CODEX_TIMEOUT_MS`    | (опц.) Таймаут одного запроса в мс. Дефолт `300000`.                                  |
| `CODEX_DEBUG_DIR`     | (опц.) Папка для сырого JSONL Codex'а (отладка парсера токенов).                      |
| `REPLY_CONTEXT_DEPTH` | (опц.) Глубина reply-контекста. `0` — выкл. Дефолт `3`.                               |

Полный шаблон — [env.example](env.example).

## Лицензия

[MIT](LICENSE). Заимствования из сторонних проектов (Apache-2.0) — [NOTICE.md](NOTICE.md).
