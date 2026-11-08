// CLI: выгрузить оценки набора в формат организаторов (JSON 1.0) и проверить файл.
//   npm run export -- --group FBroker --out results/prod/results.json [--expect 10] [--team "Название"] [--mode external_api]
//   npm run export -- --group DEV --out results/dev/results.json --expect 65
// Берёт последнюю оценку каждого диалога из хранилища (с учётом решённых апелляций).
// Неоценённый диалог попадает в файл со status "error" — не скрываем и не подменяем нулём.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import * as store from '../server/store.js';
import { buildResultsFile, validateResultsFile } from '../server/export.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]] : acc), []),
);
const group = args.group;
if (!group || !args.out) {
  console.error('Использование: npm run export -- --group FBroker --out results/prod/results.json [--expect 10] [--team "Название"]');
  process.exit(1);
}
const dataFile = args.file || `data/${group}.json`;
if (!fs.existsSync(dataFile)) {
  console.error(`Нет файла ${dataFile}: сначала загрузите набор (кнопка «Обновить из API» или GET /api/datasets/${group}?refresh=1).`);
  process.exit(1);
}
const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const records = raw?.data?.records || raw?.records || raw;
const map = JSON.parse(fs.readFileSync(new URL('./results-map.json', import.meta.url), 'utf8'));

const file = buildResultsFile({
  records,
  evaluations: store.listEvaluations(),
  appeals: store.listAppeals(),
  getChecklist: store.getChecklist,
  map,
  teamName: args.team || process.env.TEAM_NAME || 'doomsday',
  modelMode: args.mode || 'external_api',
  groupId: group,
});

fs.mkdirSync(path.dirname(args.out), { recursive: true });
fs.writeFileSync(args.out, JSON.stringify(file, null, 2) + '\n', 'utf8');

const problems = validateResultsFile(file, {
  expectedIds: records.map((r) => r.conversation_id),
  codes: Object.values(map),
  expectedCount: args.expect !== undefined ? Number(args.expect) : undefined,
});
const ok = file.results.filter((r) => r.status === 'ok').length;
const errors = file.results.filter((r) => r.status === 'error');
console.log(`${args.out}: ${file.results.length} записей · ok ${ok} · error ${errors.length} · модель ${file.model.name}`);
for (const r of errors) console.log(`  error ${r.conversation_id}: ${r.error}`);
if (problems.length) {
  console.error('Проблемы формата:\n  ' + problems.join('\n  '));
  process.exit(2);
}
console.log(errors.length ? 'Формат верный, но есть диалоги со status "error" — оцените их и выгрузите снова.' : 'Формат верный, все диалоги оценены.');
