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
TODO (задача C): модель, средние токены на диалог, стоимость одной оценки.

Подробности архитектуры и контракта — в `CLAUDE.md`.
