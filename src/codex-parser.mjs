/**
 * Изолированные утилиты для парсинга JSONL-вывода codex CLI.
 * Не импортирует config — пригоден для юнит-тестов без .env.
 */

/**
 * Фабрика накопительного JSONL-парсера для stdout потока codex.
 *
 * @param {object} opts
 * @param {function} [opts.onDelta]    — колбэк для текста agent_message
 * @param {function} [opts.onActivity] — колбэк для tool-событий
 * @returns {{ push(chunk: string): void, flush(): void, getAnswer(): string }}
 */
export function makeJsonlParser({ onDelta, onActivity } = {}) {
  let lineBuf = "";
  let answer = "";

  function dispatchEvent(evt) {
    if (!evt || typeof evt.type !== "string") return;

    if (evt.type === "item.started") {
      const item = evt.item;
      if (item && item.type === "command_execution") {
        onActivity?.({ kind: "tool", label: item.command });
      }
    } else if (evt.type === "item.completed") {
      const item = evt.item;
      if (!item) return;
      if (item.type === "command_execution") {
        onActivity?.({ kind: "tool_done", label: item.command });
      } else if (item.type === "agent_message") {
        // codex-cli 0.130 шлёт несколько agent_message за turn: промежуточные
        // «мысли вслух» между tool-вызовами и финальный ответ. Финальный — это
        // последний agent_message перед turn.completed, поэтому ПЕРЕЗАПИСЫВАЕМ,
        // а не накапливаем. Иначе result.answer = весь reasoning trace + ответ.
        if (typeof item.text === "string" && item.text) {
          answer = item.text;
          onDelta?.(item.text);
        }
      }
    }
  }

  function processLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      dispatchEvent(JSON.parse(trimmed));
    } catch {
      // не JSON — игнорируем
    }
  }

  return {
    /** Принять очередной chunk строк (может быть без завершающего \n) */
    push(chunk) {
      lineBuf += chunk;
      let nl;
      while ((nl = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        processLine(line);
      }
    },
    /** Вызвать после завершения стрима — обработать остаток без \n */
    flush() {
      if (lineBuf.trim()) {
        processLine(lineBuf);
        lineBuf = "";
      }
    },
    getAnswer() {
      return answer;
    },
  };
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
