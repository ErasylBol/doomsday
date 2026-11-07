# CQA: Conversation Quality Analytics

Прототип оценки качества диалогов поддержки по настраиваемому чек-листу с помощью LLM, с апелляциями и аналитикой для руководителя.

## Запуск
```bash
npm install
cp .env.example .env   # заполнить CQA_API_URL, LLM_API_KEY, LLM_MODEL
npm start              # http://localhost:3000
npm test
```

## Модель и стоимость
Провайдер: OpenAI Chat Completions со structured outputs. Модель: `gpt-6-luna` (задаётся в `.env`, `LLM_MODEL`).
TODO: указать модель, средние токены на диалог и стоимость одной оценки после прогона на DEV
(`npm run eval` печатает токены и стоимость; цены модели задаются в `.env`).

## Оценка из консоли
```bash
npm run eval -- --group DEV --limit 5
npm run accuracy
```

Подробности архитектуры и контракта — в `CLAUDE.md`.
