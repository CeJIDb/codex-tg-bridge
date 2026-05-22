# codex-tg-bridge

Telegram-бот **Лоцман** — мост между Telegram и Codex CLI поверх произвольного графа знаний /
репозитория.

Пайплайн:

1. Пользователь пишет сообщение боту.
2. Бот проверяет whitelist `ALLOWED_USER_IDS`.
3. Очередь (concurrency=1) запускает
   `codex exec -C <GRAPH_REPO_PATH> --sandbox read-only --ephemeral …`.
4. Финальный ответ Codex (`-o <tmpfile>`) отправляется в чат, режется на куски ≤ 4000 символов.

Sandbox `read-only` гарантирует, что бот не может ничего записать в граф-репозиторий.

## Запуск

```bash
cp env.example .env
# отредактировать .env: BOT_TOKEN, ALLOWED_USER_IDS, GRAPH_REPO_PATH
npm install
npm start
```

## Переменные `.env`

| Переменная         | Назначение                                          |
| ------------------ | --------------------------------------------------- |
| `BOT_TOKEN`        | Токен бота от [@BotFather](https://t.me/BotFather). |
| `ALLOWED_USER_IDS` | Список разрешённых user_id через запятую.           |
| `GRAPH_REPO_PATH`  | Абсолютный путь к графовому репозиторию.            |
| `CODEX_MODEL`      | (опц.) Переопределение модели Codex.                |
| `CODEX_TIMEOUT_MS` | (опц.) Таймаут одного запроса, по умолчанию 180000. |

## Зависимости

- Node ≥ 20
- `codex` CLI в PATH, авторизованный (`codex login`).

## Технические планы

Любое нетривиальное изменение начинается с плана в [plans/](plans/) — формат и правила в
[plans/README.md](plans/README.md). Проверка: `npm run check:plans`.
