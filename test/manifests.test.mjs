// Тесты для linkifyCitations:
//  - линковка блока «Источники:» (существующее поведение);
//  - линковка inline-цитат `[N, п. 6.3.5]` и мульти-цитат `[1, …; 2, …]`
//    так, чтобы кликабельным был только N (опция B).
// Запуск: node --test test/manifests.test.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { linkifyCitations } from "../src/manifests.mjs";

const byCode = new Map([
  ["294-ФЗ", "http://publication.pravo.gov.ru/document/0001202307100007"],
  ["ГОСТ Р 51841-2001", "https://example.com/gost-51841.pdf"],
  ["IMO MSC", "https://example.com/MSC.98(73).pdf"],
]);

describe("linkifyCitations — блок «Источники:»", () => {
  it("оборачивает code в markdown-ссылку", () => {
    const md = [
      "Текст без inline-цитат.",
      "",
      "Источники:",
      "[1] 294-ФЗ «Федеральный закон…», ст. 2, п. 1.",
    ].join("\n");
    const out = linkifyCitations(md, byCode);
    assert.match(
      out,
      /\[1\] \[294-ФЗ\]\(http:\/\/publication\.pravo\.gov\.ru\/document\/0001202307100007\) «/,
    );
  });

  it("URL-энкодит скобки в URL", () => {
    const md = ["Источники:", "[1] IMO MSC «Резолюция»"].join("\n");
    const out = linkifyCitations(md, byCode);
    assert.match(out, /\[IMO MSC\]\(https:\/\/example\.com\/MSC\.98%2873%29\.pdf\)/);
  });

  it("без заголовка «Источники:» возвращает исходник без изменений", () => {
    const md = "Просто текст без цитат.";
    assert.equal(linkifyCitations(md, byCode), md);
  });
});

describe("linkifyCitations — inline-цитаты (опция B)", () => {
  const WJ = "⁠"; // word joiner

  it("превращает только N в ссылку, остальное оставляет плоским (с word joiner в номерах)", () => {
    const md = [
      "Согласно [1, п. 6.3.5] правило такое-то.",
      "",
      "Источники:",
      "[1] 294-ФЗ «Федеральный закон…»",
    ].join("\n");
    const out = linkifyCitations(md, byCode);
    assert.ok(
      out.includes(
        `[[1](http://publication.pravo.gov.ru/document/0001202307100007), п. 6${WJ}.3${WJ}.5]`,
      ),
      `Не нашёл ожидаемый фрагмент в:\n${out}`,
    );
  });

  it("мульти-цитата `[1, …; 2, …]` — линкует каждое N", () => {
    const md = [
      "Сводно [1, п. 7.1; 2, cl. 4.6.2] — оба источника.",
      "",
      "Источники:",
      "[1] 294-ФЗ «Федеральный закон…»",
      "[2] ГОСТ Р 51841-2001 «Программируемые контроллеры…»",
    ].join("\n");
    const out = linkifyCitations(md, byCode);
    assert.ok(
      out.includes(
        `[[1](http://publication.pravo.gov.ru/document/0001202307100007), п. 7${WJ}.1; ` +
          `[2](https://example.com/gost-51841.pdf), cl. 4${WJ}.6${WJ}.2]`,
      ),
      `Не нашёл ожидаемый фрагмент в:\n${out}`,
    );
  });

  it("цитата на весь документ `[1]` — превращает N в ссылку", () => {
    const md = [
      "См. целиком [1] для контекста.",
      "",
      "Источники:",
      "[1] 294-ФЗ «Федеральный закон…»",
    ].join("\n");
    const out = linkifyCitations(md, byCode);
    assert.match(
      out,
      /См\. целиком \[\[1\]\(http:\/\/publication\.pravo\.gov\.ru\/document\/0001202307100007\)\] для/,
    );
  });

  it("N, которого нет в блоке «Источники:», оставляет цифру, но защищает номер", () => {
    const md = [
      "Где-то [99, п. 1.1] упомянуто.",
      "",
      "Источники:",
      "[1] 294-ФЗ «Федеральный закон…»",
    ].join("\n");
    const out = linkifyCitations(md, byCode);
    assert.ok(out.includes(`[99, п. 1${WJ}.1]`), `Не нашёл word joiner в 1.1:\n${out}`);
  });

  it("уже оформленную inline-ссылку `[label](url)` повторно не оборачивает", () => {
    const md = [
      "См. [294-ФЗ](http://example.com) — закон.",
      "",
      "Источники:",
      "[1] 294-ФЗ «Федеральный закон…»",
    ].join("\n");
    const out = linkifyCitations(md, byCode);
    assert.match(out, /См\. \[294-ФЗ\]\(http:\/\/example\.com\) — закон/);
  });

  it("берёт N→url из уже оформленных source-строк (повторный прогон)", () => {
    const md = [
      "Согласно [1, п. 6.3.5] правило такое-то.",
      "",
      "Источники:",
      "[1] [294-ФЗ](http://publication.pravo.gov.ru/document/0001202307100007) «Закон»",
    ].join("\n");
    const out = linkifyCitations(md, byCode);
    assert.ok(
      out.includes(
        `[[1](http://publication.pravo.gov.ru/document/0001202307100007), п. 6${WJ}.3${WJ}.5]`,
      ),
      `Не нашёл ожидаемый фрагмент в:\n${out}`,
    );
  });
});

describe("linkifyCitations — защита имён файлов от Telegram auto-link", () => {
  const WJ = "⁠"; // word joiner — невидимый разделитель против Telegram auto-link

  it("вставляет word joiner перед .pdf в плоской метадате цитаты", () => {
    const md = [
      "Согласно [1, разд. 6.3, see iec-61131-2.pdf] правило такое-то.",
      "",
      "Источники:",
      "[1] 294-ФЗ «Федеральный закон…»",
    ].join("\n");
    const out = linkifyCitations(md, byCode);
    assert.ok(out.includes(`iec-61131-2${WJ}.pdf]`), `Нет word joiner перед .pdf в:\n${out}`);
  });

  it("не трогает имя файла внутри URL `[N](https://…/file.pdf)`", () => {
    const md = [
      "См. [1, разд. 6.3] правило.",
      "",
      "Источники:",
      "[1] ГОСТ Р 51841-2001 «Программируемые контроллеры…»",
    ].join("\n");
    const out = linkifyCitations(md, byCode);
    // URL `https://example.com/gost-51841.pdf` должен остаться без word joiner.
    assert.ok(out.includes("(https://example.com/gost-51841.pdf)"));
    assert.ok(!out.includes(`gost-51841${WJ}.pdf`));
  });

  it("работает даже если для N нет URL — главное защитить имя файла", () => {
    const md = [
      "Где-то [99, разд. 6.3, unknown-doc.md] упомянуто.",
      "",
      "Источники:",
      "[1] 294-ФЗ «Федеральный закон…»",
    ].join("\n");
    const out = linkifyCitations(md, byCode);
    assert.ok(out.includes(`unknown-doc${WJ}.md]`));
  });

  it("защищает мульти-часть `6.3.5` (3-частный номер пункта) — ломает каждую точку", () => {
    const md = [
      "См. [1, п. 6.3.5] правило.",
      "",
      "Источники:",
      "[1] 294-ФЗ «Федеральный закон…»",
    ].join("\n");
    const out = linkifyCitations(md, byCode);
    assert.ok(out.includes(`п. 6${WJ}.3${WJ}.5]`), `Не разорвал обе точки:\n${out}`);
  });

  it("защищает IPv4-подобный `1.2.3.4` (иначе Telegram линкует как адрес)", () => {
    const md = [
      "См. [1, см. адрес 1.2.3.4] для контекста.",
      "",
      "Источники:",
      "[1] 294-ФЗ «Федеральный закон…»",
    ].join("\n");
    const out = linkifyCitations(md, byCode);
    assert.ok(out.includes(`1${WJ}.2${WJ}.3${WJ}.4]`), `Не разорвал IPv4-паттерн:\n${out}`);
  });

  it("не трогает кириллические сокращения `п.`, `ст.`, `разд.`", () => {
    const md = [
      "См. [1, разд. 6.3, ст. 2, п. 4.3] далее.",
      "",
      "Источники:",
      "[1] 294-ФЗ «Федеральный закон…»",
    ].join("\n");
    const out = linkifyCitations(md, byCode);
    // Кириллические `разд.`, `ст.`, `п.` остаются без word joiner.
    assert.ok(out.includes("разд. 6"));
    assert.ok(out.includes("ст. 2"));
    // Но `6.3` и `4.3` (digit.digit) защищены.
    assert.ok(out.includes(`6${WJ}.3,`));
    assert.ok(out.includes(`4${WJ}.3]`));
  });
});
