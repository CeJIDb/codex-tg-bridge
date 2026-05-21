# Third-party notices

## DeepPavlov Dream

Файл [src/triage.mjs](src/triage.mjs) включает regex-паттерны, заимствованные из проекта DeepPavlov
Dream:

- Источник: <https://github.com/deeppavlov/dream>
- Конкретный файл: `annotators/IntentCatcherTransformers/intent_phrases_RU.json`
- Лицензия: Apache License, Version 2.0
- Текст лицензии: <http://www.apache.org/licenses/LICENSE-2.0>
- Copyright © 2017–present, Neural Networks and Deep Learning lab, MIPT (DeepPavlov.ai)

Заимствованные интенты: `exit`, `repeat`, `what_is_your_name`, `what_can_you_do`, `who_made_you`.
Паттерны оборачиваются якорями `^(?:...)[\s!.?,]*$` для полнотекстового совпадения и компилируются с
флагами `iu` (case-insensitive, Unicode).
