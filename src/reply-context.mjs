/**
 * src/reply-context.mjs
 * In-memory reply-context store: LRU by entries (capacity 500).
 *
 * Public API:
 *   remember({ chatId, threadId, msgIds, parentEntryId }, { question, answer }) -> entryId
 *   recallChain({ chatId, threadId, msgId }, maxDepth) -> { chain, truncated }
 *
 * Test-only:
 *   _reset()  – clear all state
 *   _size()   – return entries.size
 */

const CAPACITY = 500;

/** @type {Map<string, { question: string, answer: string, parentEntryId: string|null }>} */
const entries = new Map();

/** @type {Map<string, string>} msgKey -> entryId */
const lookup = new Map();

function msgKey(chatId, threadId, msgId) {
  return `${chatId}:${threadId ?? ""}:${msgId}`;
}

/**
 * Store a new Q+A entry and register all msgIds as lookup aliases.
 *
 * @param {{ chatId: number|string, threadId?: number|string|null, msgIds: (number|string)[], parentEntryId?: string|null }} ref
 * @param {{ question: string, answer: string }} qa
 * @returns {string} entryId
 */
export function remember({ chatId, threadId, msgIds, parentEntryId }, { question, answer }) {
  const entryId = crypto.randomUUID();

  entries.set(entryId, { question, answer, parentEntryId: parentEntryId ?? null });

  for (const msgId of msgIds) {
    lookup.set(msgKey(chatId, threadId, msgId), entryId);
  }

  if (entries.size > CAPACITY) {
    const oldestId = entries.keys().next().value;
    // Remove all lookup entries pointing to the evicted entry.
    for (const [key, val] of lookup) {
      if (val === oldestId) lookup.delete(key);
    }
    entries.delete(oldestId);
  }

  return entryId;
}

/**
 * Walk the chain up from the message that was replied to.
 *
 * @param {{ chatId: number|string, threadId?: number|string|null, msgId: number|string }} ref
 * @param {number} maxDepth
 * @returns {{ chain: Array<{ entryId: string, question: string, answer: string }>, truncated: boolean }}
 */
export function recallChain({ chatId, threadId, msgId }, maxDepth) {
  const startId = lookup.get(msgKey(chatId, threadId, msgId));
  if (!startId) return { chain: [], truncated: false };

  const chain = [];
  let current = startId;

  while (current && entries.has(current) && chain.length < maxDepth) {
    const entry = entries.get(current);
    chain.push({ entryId: current, question: entry.question, answer: entry.answer });
    current = entry.parentEntryId;
  }

  const truncated = chain.length === maxDepth && current != null && entries.has(current);

  chain.reverse();

  return { chain, truncated };
}

/** Clear all state. For tests only. */
export function _reset() {
  entries.clear();
  lookup.clear();
}

/** Return entries count. For tests only. */
export function _size() {
  return entries.size;
}
