// Лист проверки эталонной разметки для человека.
//   npm run gt:review -- [--gt data/gt-holdout] [--group DEV] [--only-disputed 1] > review.md
// По каждому диалогу: транскрипт с номерами и таблица «эталон / модель / объяснение модели».
// Модель — последняя оценка из хранилища (сначала `npm run eval -- --ids ...`). ⚠️ — эталон и модель расходятся,
// ❓ — критерий помечен в эталоне как спорный. Исправления вносите прямо в data/gt*/<id>.json (поле answers),
// после проверки поставьте "labeled_by": "<ваше имя>".
import fs from 'node:fs';
import path from 'node:path';
import * as store from '../server/store.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
const dirs = args.gt ? [args.gt] : ['data/gt', 'data/gt-holdout', 'data/gt-fresh'].filter((d) => fs.existsSync(d));
const group = args.group || 'DEV';
const raw = JSON.parse(fs.readFileSync(`data/${group}.json`, 'utf8'));
const records = new Map((raw?.data?.records || raw?.records || raw).map((r) => [r.conversation_id, r]));
const checklist = store.getChecklist(args.checklist || 'default', 1) || store.getChecklist(args.checklist || 'default');
const evals = store.listEvaluations();
const latest = (id) => evals.filter((e) => e.conversation_id === id && e.checklist_id === checklist.id).at(-1);
const RU = { yes: 'Да', no: 'Нет', na: 'N/A', manual: 'ручная' };
const fmt = (a) => (a === undefined || a === null ? '—' : RU[a] ?? String(a));
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');

const out = [`# Проверка эталона (${new Date().toISOString().slice(0, 10)})`, '',
  'Как проверять: прочитайте диалог, затем таблицу. Сначала строки с ⚠️ (эталон и модель расходятся) и ❓ (спорные).',
  'Если эталон неверен — исправьте `answers` в файле, указанном в заголовке. Правила критериев — `docs/CQA_Chat_Quality_Checklist.pdf`,',
  'соглашения разметки — `data/gt/README.md`.', ''];
let total = 0;
let disputed = 0;
for (const dir of dirs) {
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && x.startsWith('p')).sort()) {
    const gt = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const rec = records.get(gt.conversation_id);
    if (!rec) continue;
    const ev = latest(gt.conversation_id);
    const res = new Map((ev?.results || []).map((r) => [r.criterion_id, r]));
    const rows = checklist.criteria.map((c) => {
      const want = gt.answers[c.id];
      const r = res.get(c.id);
      const diff = r && String(r.answer) !== String(want);
      const amb = (gt.ambiguous || []).includes(c.id);
      return { c, want, r, diff, amb };
    });
    const nDiff = rows.filter((x) => x.diff || x.amb).length;
    if (args['only-disputed'] && !nDiff) continue;
    total++;
    disputed += rows.filter((x) => x.diff).length;
    out.push(`## ${gt.conversation_id} · ${rec.language} · ${rec.channel === 'voice call' ? 'звонок' : 'чат'} — \`${path.join(dir, f)}\``, '');
    if (gt.note) out.push(`> Заметка разметчика: ${gt.note}`, '');
    out.push('<details><summary>Транскрипт</summary>', '', '```');
    rec.transcript.forEach((t, i) => out.push(`[${i}] ${t.timestamp} ${t.speaker}: ${String(t.text).replace(/\s+/g, ' ')}`));
    out.push('```', '', '</details>', '');
    out.push('| | Критерий | Эталон | Модель | Объяснение модели | Реплики |', '|---|---|---|---|---|---|');
    for (const x of rows) {
      const mark = x.diff ? '⚠️' : x.amb ? '❓' : '';
      out.push(`| ${mark} | ${cell(x.c.name)} | **${fmt(x.want)}** | ${fmt(x.r?.answer)}${x.r?.confidence < 1 ? ` (${x.r.confidence})` : ''} | ${cell(x.r?.explanation)} | ${(x.r?.evidence || []).join(', ')} |`);
    }
    out.push('');
  }
}
out.splice(5, 0, `Диалогов: ${total}. Расхождений эталона с моделью: ${disputed}.`, '');
process.stdout.write(out.join('\n') + '\n');
