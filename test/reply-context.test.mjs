// Тесты для reply-context.mjs и связанных функций prompt.mjs.
// Запуск: node --test test/reply-context.test.mjs

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { remember, recallChain, _reset, _size } from "../src/reply-context.mjs";
import { truncatePreservingSources, withReplyContext, withSystemPreamble } from "../src/prompt.mjs";

// Локальная копия для изоляции от bot.mjs:
function formatBranchIndicator({ depth, max, truncated }) {
  if (!max || !depth) return "";
  return `— Ветка ${depth}/${max}${truncated ? " · ранние шаги выпали" : ""}`;
}

describe("reply-context", () => {
  beforeEach(() => _reset());

  it("одиночный шаг: chain длиной 1, truncated=false", () => {
    const e1 = remember(
      { chatId: 1, threadId: null, msgIds: [101], parentEntryId: null },
      { question: "Q1", answer: "A1" },
    );
    const { chain, truncated } = recallChain({ chatId: 1, threadId: null, msgId: 101 }, 3);
    assert.equal(chain.length, 1);
    assert.equal(chain[0].question, "Q1");
    assert.equal(chain[0].answer, "A1");
    assert.equal(truncated, false);
  });

  it("цепочка из 5 шагов, maxDepth=3 → 3 шага, truncated=true", () => {
    let parent = null;
    for (let i = 1; i <= 5; i++) {
      const msgId = 200 + i;
      parent = remember(
        { chatId: 2, threadId: null, msgIds: [msgId], parentEntryId: parent },
        { question: `Q${i}`, answer: `A${i}` },
      );
    }
    const { chain, truncated } = recallChain({ chatId: 2, threadId: null, msgId: 205 }, 3);
    assert.equal(chain.length, 3);
    assert.equal(chain[0].question, "Q3");
    assert.equal(chain[2].question, "Q5");
    assert.equal(truncated, true);
  });

  it("цепочка из 2 шагов, maxDepth=3 → 2 шага, truncated=false", () => {
    const e1 = remember(
      { chatId: 3, threadId: null, msgIds: [301], parentEntryId: null },
      { question: "Q1", answer: "A1" },
    );
    const e2 = remember(
      { chatId: 3, threadId: null, msgIds: [302], parentEntryId: e1 },
      { question: "Q2", answer: "A2" },
    );
    const { chain, truncated } = recallChain({ chatId: 3, threadId: null, msgId: 302 }, 3);
    assert.equal(chain.length, 2);
    assert.equal(truncated, false);
  });

  it("reply на любой из msgIds одного ответа — один entry", () => {
    const e1 = remember(
      { chatId: 4, threadId: null, msgIds: [401, 402, 403], parentEntryId: null },
      { question: "Q", answer: "A" },
    );
    const r1 = recallChain({ chatId: 4, threadId: null, msgId: 401 }, 3);
    const r2 = recallChain({ chatId: 4, threadId: null, msgId: 402 }, 3);
    const r3 = recallChain({ chatId: 4, threadId: null, msgId: 403 }, 3);
    assert.equal(r1.chain[0].entryId, e1);
    assert.equal(r2.chain[0].entryId, e1);
    assert.equal(r3.chain[0].entryId, e1);
  });

  it("LRU eviction: 501 записей → size=500, старый msgKey не найден", () => {
    const firstMsgId = 10001;
    remember(
      { chatId: 5, threadId: null, msgIds: [firstMsgId], parentEntryId: null },
      { question: "first", answer: "A" },
    );
    for (let i = 1; i <= 500; i++) {
      remember(
        { chatId: 5, threadId: null, msgIds: [20000 + i], parentEntryId: null },
        { question: `Q${i}`, answer: `A${i}` },
      );
    }
    assert.equal(_size(), 500);
    const { chain } = recallChain({ chatId: 5, threadId: null, msgId: firstMsgId }, 3);
    assert.equal(chain.length, 0);
  });

  it("вытеснение родителя — цепочка обрывается без ошибок", () => {
    const e1 = remember(
      { chatId: 6, threadId: null, msgIds: [601], parentEntryId: null },
      { question: "Q1", answer: "A1" },
    );
    const e2 = remember(
      { chatId: 6, threadId: null, msgIds: [602], parentEntryId: e1 },
      { question: "Q2", answer: "A2" },
    );
    // Вытесняем всё, в том числе e1 и e2
    for (let i = 0; i < 500; i++) {
      remember(
        { chatId: 6, threadId: null, msgIds: [7000 + i], parentEntryId: null },
        { question: `Qx`, answer: `Ax` },
      );
    }
    assert.doesNotThrow(() => recallChain({ chatId: 6, threadId: null, msgId: 602 }, 3));
  });

  it("разные threadId не путают msgId", () => {
    remember(
      { chatId: 7, threadId: 1, msgIds: [701], parentEntryId: null },
      { question: "thread1", answer: "A1" },
    );
    remember(
      { chatId: 7, threadId: 2, msgIds: [701], parentEntryId: null },
      { question: "thread2", answer: "A2" },
    );
    const r1 = recallChain({ chatId: 7, threadId: 1, msgId: 701 }, 3);
    const r2 = recallChain({ chatId: 7, threadId: 2, msgId: 701 }, 3);
    assert.equal(r1.chain[0].question, "thread1");
    assert.equal(r2.chain[0].question, "thread2");
  });
});

describe("truncatePreservingSources", () => {
  it("сохраняет блок Источники: при обрезке", () => {
    const sources = "\nИсточники:\n[1] ГОСТ Р 123";
    const body = "x".repeat(300);
    const text = body + sources;
    const result = truncatePreservingSources(text, 200);
    assert.ok(result.includes("Источники:"), "должен содержать Источники:");
    assert.ok(result.includes("…[обрезано]"), "должен содержать маркер");
    assert.ok(result.length <= 200 + sources.length, "не должен сильно превышать budget");
  });

  it("без блока Источники: — slice + маркер", () => {
    const text = "a".repeat(300);
    const result = truncatePreservingSources(text, 200);
    assert.ok(result.endsWith("…[обрезано]"), "должен заканчиваться маркером");
    assert.ok(!result.includes("Источники:"));
  });
});

describe("withReplyContext", () => {
  it("пустой chain → newQ as is", () => {
    assert.equal(withReplyContext([], "мой вопрос"), "мой вопрос");
    assert.equal(withReplyContext(null, "мой вопрос"), "мой вопрос");
  });

  it("chain из 2 шагов формирует ожидаемый формат", () => {
    const chain = [
      { question: "вопрос1", answer: "ответ1" },
      { question: "вопрос2", answer: "ответ2" },
    ];
    const result = withReplyContext(chain, "новый вопрос");
    assert.ok(result.startsWith("Контекст:"), "должен начинаться с Контекст:");
    assert.ok(result.includes("Q1: вопрос1"));
    assert.ok(result.includes("A1: ответ1"));
    assert.ok(result.includes("Q2: вопрос2"));
    assert.ok(result.includes("A2: ответ2"));
    assert.ok(result.includes("Новый вопрос: новый вопрос"));
  });

  it("withSystemPreamble(withReplyContext(...)) содержит и преамбул, и Контекст:", () => {
    const chain = [{ question: "q", answer: "a" }];
    const result = withSystemPreamble(withReplyContext(chain, "новый"));
    assert.ok(result.includes("Лоцман"), "должен содержать системный преамбул");
    assert.ok(result.includes("Контекст:"), "должен содержать блок Контекст:");
    assert.ok(result.includes("Новый вопрос: новый"), "должен содержать новый вопрос");
  });
});

describe("formatBranchIndicator", () => {
  it("depth=1/max=3 → '— Ветка 1/3'", () => {
    assert.equal(formatBranchIndicator({ depth: 1, max: 3, truncated: false }), "— Ветка 1/3");
  });

  it("depth=2/max=3 → '— Ветка 2/3'", () => {
    assert.equal(formatBranchIndicator({ depth: 2, max: 3, truncated: false }), "— Ветка 2/3");
  });

  it("depth=3/max=3 → '— Ветка 3/3'", () => {
    assert.equal(formatBranchIndicator({ depth: 3, max: 3, truncated: false }), "— Ветка 3/3");
  });

  it("depth=3/max=3, truncated=true → '— Ветка 3/3 · ранние шаги выпали'", () => {
    assert.equal(
      formatBranchIndicator({ depth: 3, max: 3, truncated: true }),
      "— Ветка 3/3 · ранние шаги выпали",
    );
  });

  it("max=0 → пустая строка", () => {
    assert.equal(formatBranchIndicator({ depth: 1, max: 0, truncated: false }), "");
  });

  it("depth=0 → пустая строка", () => {
    assert.equal(formatBranchIndicator({ depth: 0, max: 3, truncated: false }), "");
  });
});
