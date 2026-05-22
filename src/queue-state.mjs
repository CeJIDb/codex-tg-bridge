// Управление состоянием очереди ожидания: регистрация задач и вычисление позиций.
// Чистый модуль — никакого I/O, никаких зависимостей от grammy/p-queue/telegram.

import { performance } from "node:perf_hooks";

/**
 * Создаёт новый экземпляр хранилища ожидающих задач.
 * @returns {{ _map: Map<string, WaiterEntry> }}
 */
export function createWaiters() {
  return { _map: new Map() };
}

/**
 * @typedef {Object} WaiterEntry
 * @property {number|string} chatId
 * @property {number|string} msgId
 * @property {number} registeredAt  — монотонное время (performance.now())
 * @property {number|null} lastShownPos  — последняя отображённая позиция (null = ещё не показана)
 * @property {number|null} lastEditAt    — performance.now() последнего edit-а (null = не было)
 */

/**
 * Регистрирует новую задачу в ожидании.
 * @param {{ _map: Map }} waiters
 * @param {{ chatId: number|string, msgId: number|string }} params
 * @returns {{ taskId: string, registeredAt: number }}
 */
export function register(waiters, { chatId, msgId }) {
  const taskId = `${chatId}:${msgId}:${Date.now()}`;
  const registeredAt = performance.now();
  /** @type {WaiterEntry} */
  const entry = {
    chatId,
    msgId,
    registeredAt,
    lastShownPos: null,
    lastEditAt: null,
  };
  waiters._map.set(taskId, entry);
  return { taskId, registeredAt };
}

/**
 * Удаляет задачу из хранилища.
 * @param {{ _map: Map }} waiters
 * @param {string} taskId
 */
export function unregister(waiters, taskId) {
  waiters._map.delete(taskId);
}

/**
 * Чистая функция: вычисляет позицию каждой задачи в очереди.
 * Позиция — число записей со строго меньшим registeredAt (т.е. 0 = первый).
 *
 * @param {Array<{ taskId: string, registeredAt: number }>} entries
 * @returns {Map<string, number>}
 */
export function computePositions(entries) {
  const result = new Map();
  for (const current of entries) {
    let pos = 0;
    for (const other of entries) {
      if (other.registeredAt < current.registeredAt) pos++;
    }
    result.set(current.taskId, pos);
  }
  return result;
}
