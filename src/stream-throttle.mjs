// Изолированная state-машина тротлера для стримингового ответа бота.
//
// Принимает события onDelta / onActivity из askCodexStream и выпускает
// кадры через editText не чаще раза в 1500 мс (или при накоплении ≥ 400 символов).
// Обрабатывает 429 Too Many Requests от Telegram с экспоненциальным бэк-оффом.

const MIN_INTERVAL_MS = 1500;
const BURST_THRESHOLD = 400;
const MAX_COOLDOWN_MS = 16_000;
const MAX_BACKOFF = 16;

/**
 * Форматирует строку активности агента для промежуточного кадра.
 * @param {{ kind: string, label: string } | null} activity
 * @returns {string}
 */
function formatActivity(activity) {
  if (!activity) return "⏳ …";
  return `🔧 ${activity.label}`;
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isGrammyError429(err) {
  return err?.error_code === 429 || err?.response?.error_code === 429;
}

/**
 * Создаёт экземпляр тротлера.
 *
 * @param {{ editText: (text: string) => Promise<void>, now?: () => number }} options
 * @returns {{
 *   onActivity: (event: { kind: string, label: string }) => void,
 *   onDelta: (text: string) => void,
 *   onAborted: () => void,
 *   finalize: () => Promise<void>,
 *   isFinalized: () => boolean,
 * }}
 */
export function createPlaceholderStream({ editText, now = Date.now }) {
  // --- внутреннее состояние ---
  let lastEditAt = 0;
  let pendingText = "";
  let lastActivity = null;
  let inFlight = false;
  let hasTextStarted = false;
  let cooldownUntil = 0;
  let backoffMultiplier = 1;
  let aborted = false;
  let finalized = false;

  /** Выпускает один кадр (без проверки условий). */
  async function flush() {
    inFlight = true;
    lastEditAt = now();
    const text = hasTextStarted ? pendingText : formatActivity(lastActivity);
    // Снимаем snapshot pendingText; очистим только при успехе
    const snapshotPending = hasTextStarted ? pendingText : null;
    try {
      await editText(text);
      // Успех: сбрасываем только тот текст, что уже ушёл
      if (snapshotPending !== null) {
        // Удаляем из pendingText ровно то, что было отправлено
        if (pendingText.startsWith(snapshotPending)) {
          pendingText = pendingText.slice(snapshotPending.length);
        } else {
          pendingText = "";
        }
      }
      backoffMultiplier = 1;
    } catch (err) {
      if (isGrammyError429(err)) {
        const retryAfter = err.parameters?.retry_after ?? 1;
        const cooldownMs = Math.min(retryAfter * 1000 * backoffMultiplier, MAX_COOLDOWN_MS);
        cooldownUntil = now() + cooldownMs;
        backoffMultiplier = Math.min(backoffMultiplier * 2, MAX_BACKOFF);
        // pendingText не трогаем — отправится в следующем кадре
      }
    } finally {
      inFlight = false;
      // После освобождения inFlight проверяем, не накопилось ли что-то новое
      // (например, onDelta пришёл пока flush был in-flight)
      scheduleFlushIfNeeded();
    }
  }

  /**
   * Планирует flush через microtask, если есть что отправить и прошло достаточно времени.
   * Используется после освобождения inFlight.
   */
  function scheduleFlushIfNeeded() {
    if (
      !inFlight &&
      !aborted &&
      !finalized &&
      now() >= cooldownUntil &&
      (pendingText.length > 0 || lastActivity !== null)
    ) {
      const timeSinceLast = now() - lastEditAt;
      if (timeSinceLast >= MIN_INTERVAL_MS || pendingText.length >= BURST_THRESHOLD) {
        flush().catch(() => {});
      }
    }
  }

  /** Проверяет условия и при их выполнении запускает flush(). */
  function maybeFlush() {
    if (inFlight) return;
    if (aborted) return;
    if (now() < cooldownUntil) return;

    const timeSinceLast = now() - lastEditAt;
    if (timeSinceLast < MIN_INTERVAL_MS && pendingText.length < BURST_THRESHOLD) return;

    // fire-and-forget: ошибки обрабатываются внутри flush
    flush().catch(() => {});
  }

  return {
    /** Событие фрагмента текста из модели. */
    onDelta(text) {
      if (aborted || finalized) return;
      pendingText += text;
      hasTextStarted = true;
      maybeFlush();
    },

    /** Событие активности агента (tool call и т.п.). */
    onActivity(event) {
      if (aborted || finalized) return;
      lastActivity = { kind: event.kind, label: event.label };
      maybeFlush();
    },

    /** Сигнал отмены — дальнейшие колбэки превращаются в no-op. */
    onAborted() {
      aborted = true;
    },

    /**
     * Финализация: ждёт окончания cooldown, затем обязательно отправляет
     * последний кадр с итоговым содержимым.
     */
    async finalize() {
      finalized = true;

      // Ждём окончания cooldown (если активен).
      const remaining = cooldownUntil - now();
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }

      // Ждём завершения любого текущего in-flight запроса.
      if (inFlight) {
        await new Promise((resolve) => {
          const check = () => {
            if (!inFlight) return resolve();
            setTimeout(check, 50);
          };
          check();
        });
      }

      await flush();
    },

    /** Возвращает true после вызова finalize(). */
    isFinalized() {
      return finalized;
    },
  };
}
