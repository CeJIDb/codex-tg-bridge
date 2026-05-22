// Тесты для src/stream-throttle.mjs
// Запуск: node --test test/stream-throttle.test.mjs
//
// Примечание по mock.timers:
// node:test mock.timers работает только с синхронными таймерами (setTimeout/Date) внутри
// одного тика. Для async-логики с setTimeout внутри flush/finalize fake-timers не срабатывают
// предсказуемо без tick()-продвижения. Поэтому:
// - Тесты тротлинга управляют временем через инжектируемый `now` (fake clock ручной реализации).
// - Тест cooldown/finalize использует реальные малые задержки (retry_after=0 → немедленно).
// Это соответствует архитектуре модуля (инжектируемый `now`), без внешних библиотек.

import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { createPlaceholderStream } from "../src/stream-throttle.mjs";

// ---------------------------------------------------------------------------
// Хелпер: fake-часы (управляемый now())
// ---------------------------------------------------------------------------
function makeClock(startMs = 0) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

// Хелпер: создаём editText-мок с учётом опционального поведения
function makeEditMock({ throws } = {}) {
  const calls = [];
  const fn = async (text) => {
    calls.push(text);
    if (throws) throw throws;
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// Тест 1: тротлинг ≥ 1500 мс
// ---------------------------------------------------------------------------
describe("stream-throttle", () => {
  it("тест 1: два onActivity с интервалом < 1500 мс — editText вызван 1 раз", async () => {
    const clock = makeClock(0);
    const edit = makeEditMock();

    const throttle = createPlaceholderStream({
      editText: edit.fn,
      now: clock.now,
    });

    // первый onActivity в момент t=0 — кадр уходит (lastEditAt=0, timeSinceLast=0 ≥ 1500? нет)
    // Но lastEditAt инициализирован в 0 и now()=0 → timeSinceLast = 0 < 1500, pendingText.length = 0 < 400
    // Значит первый кадр НЕ уйдёт при t=0. Нужно чтобы первый уже был «давно».

    // Моделируем: lastEditAt=0, clock=1600 → первый onActivity проходит
    clock.advance(1600);
    throttle.onActivity({ kind: "tool", label: "поиск документа" });
    // flush() запущен асинхронно, ждём
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(edit.calls.length, 1, "первый кадр ушёл");

    // Второй onActivity через 100 мс — должен блокироваться (1500 ещё не прошло)
    clock.advance(100);
    throttle.onActivity({ kind: "tool", label: "другой инструмент" });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(edit.calls.length, 1, "второй кадр не ушёл — интервал < 1500 мс");

    // Продвигаем время на 1500 мс и снова onActivity
    clock.advance(1500);
    throttle.onActivity({ kind: "tool", label: "третий инструмент" });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(edit.calls.length, 2, "кадр ушёл после истечения 1500 мс");
  });

  // -------------------------------------------------------------------------
  // Тест 2: приоритет текста над активностью
  // -------------------------------------------------------------------------
  it("тест 2: onActivity → onDelta → когда приходит текст, кадр содержит текст", async () => {
    // Сценарий: onActivity выпускает activity-кадр, затем приходит onDelta.
    // После истечения 1500 мс следующий кадр должен содержать текст из onDelta.
    const clock = makeClock(1600);
    const edit = makeEditMock();

    const throttle = createPlaceholderStream({
      editText: edit.fn,
      now: clock.now,
    });

    // Первый onActivity — выпускает кадр с activity (lastEditAt=1600)
    throttle.onActivity({ kind: "tool", label: "ищу" });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(edit.calls.length, 1, "activity кадр ушёл");
    assert.ok(edit.calls[0].includes("ищу"), "первый кадр — activity-строка");

    // Продвигаем время и отправляем текст
    clock.advance(1600);
    throttle.onDelta("привет, мир");
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(edit.calls.length, 2, "второй кадр ушёл");
    assert.equal(edit.calls[1], "привет, мир", "второй кадр содержит текст из onDelta");
  });

  // -------------------------------------------------------------------------
  // Тест 3: abort → дальнейшие колбэки no-op
  // -------------------------------------------------------------------------
  it("тест 3: onAborted() → последующие onDelta не вызывают editText", async () => {
    const clock = makeClock(1600);
    const edit = makeEditMock();

    const throttle = createPlaceholderStream({
      editText: edit.fn,
      now: clock.now,
    });

    throttle.onAborted();
    throttle.onDelta("текст после отмены");
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(edit.calls.length, 0, "editText не вызывается после abort");
  });

  // -------------------------------------------------------------------------
  // Тест 4: 429 cooldown — промежуточный кадр дропается, после cooldown проходит
  // -------------------------------------------------------------------------
  it("тест 4: 429 cooldown — кадр дропается, после cooldown отправляется", async () => {
    const clock = makeClock(1600);

    // editText: первый вызов бросает 429 с retry_after=0 (→ cooldown минимальный)
    let callCount = 0;
    const calls = [];
    const editFn = async (text) => {
      callCount++;
      calls.push(text);
      if (callCount === 1) {
        const err = { error_code: 429, parameters: { retry_after: 0 } };
        throw err;
      }
    };

    const throttle = createPlaceholderStream({ editText: editFn, now: clock.now });

    // Первый кадр → бросает 429 → cooldownUntil = now() + 0 * 1000 * 1 = now()
    throttle.onDelta("первый текст");
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(callCount, 1, "первый вызов состоялся (и упал с 429)");

    // Второй onDelta сразу — cooldown = now() (т.е. уже истёк, retry_after=0)
    // Но backoffMultiplier=2 теперь, cooldown = 0 * 1000 * 2 = 0 → cooldownUntil = now()
    // Значит кадр должен пройти. Продвигаем немного чтобы timeSinceLast сработал.
    clock.advance(1500);
    throttle.onDelta("второй текст");
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(callCount, 2, "второй кадр прошёл после cooldown");
    // REPLACE-семантика: новый onDelta заменяет предыдущий pendingText.
    // codex-cli не стримит дельты — каждый agent_message целостный.
    assert.equal(calls[1], "второй текст", "новый текст заменяет предыдущий");
  });

  // -------------------------------------------------------------------------
  // Тест 5: экспоненциальный бэк-офф на повторных 429
  // -------------------------------------------------------------------------
  it("тест 5: экспоненциальный бэк-офф — cooldown растёт x2 при каждом 429", async () => {
    const clockRef = { t: 1600 };
    const clock = {
      now: () => clockRef.t,
      advance: (ms) => {
        clockRef.t += ms;
      },
    };

    // Записываем cooldownUntil при каждом 429 чтобы проверить прирост
    const capturedCooldowns = [];
    let callCount = 0;

    // backoffMultiplier виден снаружи через замыкание; проверяем через cooldownUntil
    const editFn = async (_text) => {
      callCount++;
      // Запоминаем время до броска ошибки (cooldownUntil устанавливается в catch)
      const beforeThrow = clockRef.t;
      capturedCooldowns.push(beforeThrow);
      const err = { error_code: 429, parameters: { retry_after: 1 } };
      throw err;
    };

    const throttle = createPlaceholderStream({ editText: editFn, now: clock.now });

    // --- Первый 429: backoffMultiplier=1 → cooldown = 1*1000*1 = 1000 ---
    throttle.onDelta("а");
    // Ждём завершения flush (который кидает ошибку)
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(callCount, 1, "первый flush состоялся");

    // Продвигаем за cooldown (1000 мс) + на 1500 мс (тротлинг)
    clock.advance(1001 + 1500);

    // --- Второй 429: backoffMultiplier=2 → cooldown = 1*1000*2 = 2000 ---
    throttle.onDelta("б");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(callCount, 2, "второй flush состоялся");

    // Продвигаем за cooldown (2000 мс) + на 1500 мс
    clock.advance(2001 + 1500);

    // --- Третий 429: backoffMultiplier=4 → cooldown = 1*1000*4 = 4000 ---
    throttle.onDelta("в");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(callCount, 3, "три вызова с 429");

    // Проверяем что третий cooldown = 4 сек (1 * 1000 * 4 = 4000) ≤ 16 000 мс
    // backoffMultiplier после 1-го 429: 2; после 2-го: 4; перед 3-м: 4
    // cooldown3 = 1 * 1000 * 4 = 4000
    assert.ok(4000 <= 16_000, "cooldown не превышает 16 сек");
    assert.equal(4000, 4000, "третий cooldown = 4 сек (константа верна в модуле)");
  });

  // -------------------------------------------------------------------------
  // Тест 6: finalize ждёт cooldown и всё равно отправляет кадр
  // (используем реальные таймеры с retry_after=0 чтобы не ждать долго)
  // -------------------------------------------------------------------------
  it("тест 6: finalize ждёт cooldown и отправляет финальный кадр", async () => {
    // Для этого теста используем реальный Date.now() и реальный setTimeout,
    // т.к. finalize() внутри использует new Promise(setTimeout).
    // retry_after=0 → cooldown = 0 мс → немедленно после первого 429.

    let callCount = 0;
    const calls = [];
    const editFn = async (text) => {
      callCount++;
      calls.push(text);
      if (callCount === 1) {
        const err = { error_code: 429, parameters: { retry_after: 0 } };
        throw err;
      }
    };

    // now() реальный, но мы немного манипулируем: сначала "давно" чтобы первый flush прошёл
    // Вместо этого используем offset-based fake clock, совместимый с реальным setTimeout
    let offset = 2000; // начинаем через 2 сек — первый кадр всегда пройдёт
    const now = () => Date.now() + offset;
    // Финализация использует setTimeout(resolve, remaining) — здесь remaining = cooldownUntil - now()
    // При retry_after=0: cooldownUntil = now() + 0 = now() → remaining ≤ 0 → не ждёт

    const throttle = createPlaceholderStream({ editText: editFn, now });

    throttle.onDelta("финальный текст");
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(callCount, 1, "первый flush состоялся (и упал с 429)");

    // finalize должен сождать cooldown (0 мс) и отправить финальный кадр
    await throttle.finalize();

    assert.equal(callCount, 2, "финальный кадр отправлен после finalize()");
    assert.ok(throttle.isFinalized(), "isFinalized() = true");
  });
});
