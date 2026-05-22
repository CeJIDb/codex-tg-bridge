// Юнит-тест модуля queue-state.mjs
// Запуск: node test/queue-state.test.mjs

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createWaiters, register, unregister, computePositions } from "../src/queue-state.mjs";

describe("computePositions", () => {
  it("пустой массив → пустой Map", () => {
    const positions = computePositions([]);
    assert.equal(positions.size, 0);
  });

  it("одна задача → позиция 0", () => {
    const entries = [{ taskId: "a", registeredAt: 100 }];
    const positions = computePositions(entries);
    assert.equal(positions.size, 1);
    assert.equal(positions.get("a"), 0);
  });

  it("цепочка из трёх → позиции 0, 1, 2 по порядку registeredAt", () => {
    const entries = [
      { taskId: "first", registeredAt: 10 },
      { taskId: "second", registeredAt: 20 },
      { taskId: "third", registeredAt: 30 },
    ];
    const positions = computePositions(entries);
    assert.equal(positions.get("first"), 0);
    assert.equal(positions.get("second"), 1);
    assert.equal(positions.get("third"), 2);
  });

  it("удаление из середины → позиции остальных пересчитаны", () => {
    // Исходно: first=0, second=1, third=2
    // Удаляем second — передаём entries без него
    const entries = [
      { taskId: "first", registeredAt: 10 },
      { taskId: "third", registeredAt: 30 },
    ];
    const positions = computePositions(entries);
    assert.equal(positions.get("first"), 0);
    assert.equal(positions.get("third"), 1);
    assert.equal(positions.has("second"), false);
  });
});

describe("register / unregister", () => {
  it("register возвращает taskId и registeredAt; запись появляется в _map", () => {
    const waiters = createWaiters();
    const { taskId, registeredAt } = register(waiters, {
      chatId: 42,
      msgId: 7,
    });
    assert.equal(typeof taskId, "string");
    assert.equal(typeof registeredAt, "number");
    assert.ok(registeredAt > 0);
    assert.ok(waiters._map.has(taskId));

    const entry = waiters._map.get(taskId);
    assert.equal(entry.chatId, 42);
    assert.equal(entry.msgId, 7);
    assert.equal(entry.lastShownPos, null);
    assert.equal(entry.lastEditAt, null);
  });

  it("unregister удаляет запись из _map", () => {
    const waiters = createWaiters();
    const { taskId } = register(waiters, { chatId: 1, msgId: 1 });
    assert.ok(waiters._map.has(taskId));
    unregister(waiters, taskId);
    assert.ok(!waiters._map.has(taskId));
  });

  it("unregister несуществующего taskId не бросает", () => {
    const waiters = createWaiters();
    assert.doesNotThrow(() => unregister(waiters, "nope"));
  });

  it("три регистрации дают уникальные taskId", () => {
    const waiters = createWaiters();
    const ids = [
      register(waiters, { chatId: 1, msgId: 1 }).taskId,
      register(waiters, { chatId: 1, msgId: 2 }).taskId,
      register(waiters, { chatId: 2, msgId: 1 }).taskId,
    ];
    assert.equal(new Set(ids).size, 3);
  });
});

describe("интеграция: computePositions по записям из waiters", () => {
  it("три задачи: позиции по registeredAt", () => {
    const waiters = createWaiters();
    const t1 = register(waiters, { chatId: 1, msgId: 10 });
    const t2 = register(waiters, { chatId: 1, msgId: 11 });
    const t3 = register(waiters, { chatId: 1, msgId: 12 });

    const entries = [...waiters._map.entries()].map(([taskId, e]) => ({
      taskId,
      registeredAt: e.registeredAt,
    }));
    const positions = computePositions(entries);

    assert.equal(positions.get(t1.taskId), 0);
    assert.equal(positions.get(t2.taskId), 1);
    assert.equal(positions.get(t3.taskId), 2);
  });

  it("удаление задачи из середины → позиции пересчитываются", () => {
    const waiters = createWaiters();
    const t1 = register(waiters, { chatId: 1, msgId: 10 });
    const t2 = register(waiters, { chatId: 1, msgId: 11 });
    const t3 = register(waiters, { chatId: 1, msgId: 12 });

    unregister(waiters, t2.taskId);

    const entries = [...waiters._map.entries()].map(([taskId, e]) => ({
      taskId,
      registeredAt: e.registeredAt,
    }));
    const positions = computePositions(entries);

    assert.equal(positions.get(t1.taskId), 0);
    assert.equal(positions.has(t2.taskId), false);
    assert.equal(positions.get(t3.taskId), 1);
  });
});
