// CLI: оценить диалоги из локального снапшота и сохранить оценки в хранилище.
//   npm run eval -- --group DEV [--ids p1-ru-001,p1-kz-003] [--limit 5] [--runs 3] [--concurrency 5] [--checklist default]
import 'dotenv/config';
import fs from 'node:fs';
import { evaluateConversation } from '../server/llm/evaluate.js';
import { createOpenAIProvider } from '../server/llm/provider.js';
import * as store from '../server/store.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]] : acc), []),
);
const group = args.group || 'DEV';
const file = args.file || `data/${group}.json`;
if (!fs.existsSync(file)) {
  console.error(`Нет файла ${file}. Положите снапшот датасета (ответ API как есть или массив records).`);
  process.exit(1);
}
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
let records = raw?.data?.records || raw?.records || raw;
if (args.ids) {
  const ids = new Set(String(args.ids).split(','));
  records = records.filter((r) => ids.has(r.conversation_id));
}
if (args.limit) records = records.slice(0, Number(args.limit));

const checklist = store.getChecklist(args.checklist || 'default');
const provider = createOpenAIProvider();
const runs = Number(args.runs || process.env.LLM_RUNS || 3);
const concurrency = Number(args.concurrency || 5);

console.log(`Оцениваю ${records.length} диалогов · модель ${provider.model} · прогонов ${runs} · чек-лист ${checklist.id} v${checklist.version}`);
let done = 0;
let cost = 0;
let tokens = { in: 0, out: 0 };
const queue = [...records];
async function worker() {
  while (queue.length) {
    const rec = queue.shift();
    try {
      const ev = store.saveEvaluation(await evaluateConversation({ record: rec, checklist, provider, runs, group_id: group }));
      cost += ev.cost_usd || 0;
      tokens.in += ev.usage.input_tokens;
      tokens.out += ev.usage.output_tokens;
      const low = ev.results.filter((r) => r.confidence < 1).map((r) => r.criterion_id);
      console.log(`[${++done}/${records.length}] ${rec.conversation_id}: итог ${ev.score.total ?? '—'}${ev.score.gross_error ? ' ГРУБАЯ' : ''}${low.length ? ` · спорные: ${low.join(',')}` : ''}`);
    } catch (e) {
      console.error(`[${++done}/${records.length}] ${rec.conversation_id}: ОШИБКА ${e.message}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, records.length) }, worker));
const n = Math.max(1, done);
console.log(`Токены: вход ${tokens.in} (≈${Math.round(tokens.in / n)}/диалог), выход ${tokens.out} (≈${Math.round(tokens.out / n)}/диалог)`);
console.log(cost ? `Стоимость: $${cost.toFixed(4)} всего, ≈$${(cost / n).toFixed(5)} за диалог (${runs} прогона)` : 'Стоимость: задайте LLM_PRICE_INPUT_PER_1M / LLM_PRICE_OUTPUT_PER_1M в .env');
