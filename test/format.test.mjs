// Регрессионный тест конвертера Markdown → Telegram HTML.
// Запуск: node test/format.test.mjs

import { mdToTgHtml, chunkByLines } from "../src/format.mjs";

const cases = [
  {
    name: "жирный",
    in: "не **ниже IP44**.",
    out: "не <b>ниже IP44</b>.",
  },
  {
    name: "курсив одиночным звёздочкой",
    in: "это *важно* запомнить",
    out: "это <i>важно</i> запомнить",
  },
  {
    name: "курсив подчёркиванием",
    in: "это _важно_ запомнить",
    out: "это <i>важно</i> запомнить",
  },
  {
    name: "подчёркивание внутри слова не курсив",
    in: "файл pkps-11.md и snake_case_var тут",
    out: "файл pkps-11.md и snake_case_var тут",
  },
  {
    name: "inline-код",
    in: "исполнение `Ex` по правилам",
    out: "исполнение <code>Ex</code> по правилам",
  },
  {
    name: "inline-код с угловой скобкой экранируется",
    in: "тег `<div>` HTML",
    out: "тег <code>&lt;div&gt;</code> HTML",
  },
  {
    name: "блок кода",
    in: "до\n```\nfoo <bar>\n```\nпосле",
    out: "до\n<pre>foo &lt;bar&gt;</pre>\nпосле",
  },
  {
    name: "ссылка",
    in: "см. [правила](https://example.com/x)",
    out: 'см. <a href="https://example.com/x">правила</a>',
  },
  {
    name: "квадратные скобки без url остаются текстом",
    in: "по [1, п. 2.4.4.2, табл. 2.4.4.2]",
    out: "по [1, п. 2.4.4.2, табл. 2.4.4.2]",
  },
  {
    name: "заголовок → жирный",
    in: "# Раздел\nтекст",
    out: "<b>Раздел</b>\nтекст",
  },
  {
    name: "маркер списка → буллет",
    in: "- первый\n* второй\n+ третий",
    out: "• первый\n• второй\n• третий",
  },
  {
    name: "html-символы в обычном тексте экранируются",
    in: "если a < b и b > c",
    out: "если a &lt; b и b &gt; c",
  },
  {
    name: "жирный внутри списка",
    in: "- **раз** два",
    out: "• <b>раз</b> два",
  },
  {
    name: "пустой ввод",
    in: "",
    out: "",
  },
];

const realExample = `Для приборов автоматики, связи и сигнализации в машинных и котельных помещениях: **не ниже IP44**. Это относится и к установке **выше настила**, и **ниже настила** [1, п. 2.4.4.2, табл. 2.4.4.2; 2, п. 2.4.4.2, табл. 2.4.4.2].

Если зона взрывоопасная, одного IP недостаточно: требуется взрывозащищённое исполнение \`Ex\` по соответствующим разделам правил [1, п. 2.4.4.2, табл. 2.4.4.2].

Источники:
[1] sources/rmrs/pkps-11-elektrooborudovanie.md (без манифеста — каноническое имя документа не подтверждено), п. 2.4.4.2, табл. 2.4.4.2.
[2] sources/rko/pkpms-11-elektricheskoe-oborudovanie.md (без манифеста — каноническое имя документа не подтверждено), п. 2.4.4.2, табл. 2.4.4.2.`;

cases.push({
  name: "реальный ответ Лоцмана",
  in: realExample,
  outIncludes: [
    "<b>не ниже IP44</b>",
    "<b>выше настила</b>",
    "<b>ниже настила</b>",
    "<code>Ex</code>",
    "[1, п. 2.4.4.2, табл. 2.4.4.2; 2, п. 2.4.4.2, табл. 2.4.4.2]",
    "Источники:",
    "[1] sources/rmrs/pkps-11-elektrooborudovanie.md",
  ],
});

let pass = 0;
const failures = [];
for (const c of cases) {
  const got = mdToTgHtml(c.in);
  if (c.outIncludes) {
    const missing = c.outIncludes.filter((s) => !got.includes(s));
    if (missing.length === 0) pass++;
    else failures.push({ name: c.name, got, missing });
  } else if (got === c.out) {
    pass++;
  } else {
    failures.push({ name: c.name, got, expected: c.out });
  }
}

// chunkByLines
const longLine = "x".repeat(50);
const longText = Array.from({ length: 10 }, () => longLine).join("\n");
const chunks = chunkByLines(longText, 120);
if (chunks.length >= 2 && chunks.every((c) => c.length <= 120)) {
  pass++;
} else {
  failures.push({
    name: "chunkByLines: режет по строкам в пределах лимита",
    got: chunks.map((c) => c.length).join(","),
  });
}

const total = cases.length + 1;
console.log(`\nПройдено: ${pass}/${total}`);
if (failures.length > 0) {
  console.log(`\nПровалов: ${failures.length}\n`);
  for (const f of failures) {
    console.log(`— ${f.name}`);
    if (f.expected !== undefined) {
      console.log(`  ожидал:  ${JSON.stringify(f.expected)}`);
      console.log(`  получил: ${JSON.stringify(f.got)}`);
    } else if (f.missing) {
      console.log(`  не нашёл: ${JSON.stringify(f.missing)}`);
      console.log(`  получил:  ${JSON.stringify(f.got)}`);
    } else {
      console.log(`  получил: ${JSON.stringify(f.got)}`);
    }
  }
  process.exit(1);
}
process.exit(0);
