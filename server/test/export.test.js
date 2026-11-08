import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildResultsFile, validateResultsFile, toValue } from '../export.js';

const checklist = JSON.parse(fs.readFileSync(new URL('../seed/checklist.default.json', import.meta.url)));
const map = JSON.parse(fs.readFileSync(new URL('../../scripts/results-map.json', import.meta.url)));
const codes = Object.values(map);
const getChecklist = () => checklist;
const answers = { c01: 'yes', c02: 'na', c03: 'na', c04: 15, c05: 'yes', c06: 7, c07: 'yes', c08: 'no' };
const ev = (id, a = answers, extra = {}) => ({
  id: `ev-${id}`, conversation_id: id, group_id: 'FBroker', checklist_id: 'default', checklist_version: checklist.version,
  model: 'gpt-test', created_at: '2026-11-08T10:00:00Z',
  results: Object.entries(a).map(([criterion_id, answer]) => ({ criterion_id, answer, explanation: `Пояснение ${criterion_id}`, evidence: [0, 3, 3] })),
  ...extra,
});
const records = [{ conversation_id: 'p2-ru-001' }, { conversation_id: 'p2-ru-002' }];

test('значения: да/нет/N/A/шкала, manual не выражается', () => {
  const yn = checklist.criteria.find((c) => c.type === 'yesno');
  const sc = checklist.criteria.find((c) => c.type === 'scale');
  assert.equal(toValue(yn, 'yes'), true);
  assert.equal(toValue(yn, 'no'), false);
  assert.equal(toValue(yn, 'na'), null);
  assert.equal(toValue(sc, 15), 15);
  assert.equal(toValue(yn, 'manual'), undefined);
});

test('файл по формату: коды, нумерация реплик с 1, итог и флаг, неоценённый → error', () => {
  const file = buildResultsFile({ records, evaluations: [ev('p2-ru-001')], getChecklist, map, teamName: 'T', groupId: 'FBroker' });
  assert.equal(file.schema_version, '1.0');
  assert.deepEqual(file.model, { mode: 'external_api', name: 'gpt-test' });
  const [a, b] = file.results;
  assert.equal(a.status, 'ok');
  assert.deepEqual(a.criteria.map((c) => c.criterion_id), codes);
  assert.deepEqual(a.criteria[0].evidence_turns, [1, 4]);
  assert.equal(a.criteria.find((c) => c.criterion_id === 'discovery').value, null);
  assert.equal(a.criteria.find((c) => c.criterion_id === 'dialogue').value, 7);
  // N/A исключает вес: (10·1 + 20·0.75 + 15·1 + 15·0.7 + 5·1) / 65 · 100
  assert.equal(a.score.final_score, Math.round(((10 + 15 + 15 + 10.5 + 5) / 65) * 10000) / 100);
  assert.equal(a.score.critical_flag, false);
  assert.deepEqual(b, { conversation_id: 'p2-ru-002', status: 'error', criteria: [], score: null, error: 'Диалог не оценён.' });
  assert.deepEqual(validateResultsFile(file, { expectedIds: records.map((r) => r.conversation_id), codes, expectedCount: 2 }), []);
});

test('грубая ошибка → critical true и critical_flag true; manual → error; берётся последняя оценка', () => {
  const evals = [
    ev('p2-ru-001', { ...answers, c08: 'no' }, { created_at: '2026-11-08T09:00:00Z' }),
    ev('p2-ru-001', { ...answers, c08: 'yes' }, { id: 'ev-new', created_at: '2026-11-08T11:00:00Z' }),
    ev('p2-ru-002', { ...answers, c05: 'manual' }),
  ];
  const file = buildResultsFile({ records, evaluations: evals, getChecklist, map, teamName: 'T', groupId: 'FBroker' });
  const [a, b] = file.results;
  assert.equal(a.criteria.find((c) => c.criterion_id === 'critical').value, true);
  assert.equal(a.score.critical_flag, true);
  assert.equal(b.status, 'error');
  assert.match(b.error, /empathy/);
  assert.deepEqual(validateResultsFile(file, { codes }), []);
});

test('валидатор ловит повторы, пропуски и неверное число записей', () => {
  const file = buildResultsFile({ records: [...records, records[0]], evaluations: [], getChecklist, map, teamName: 'T', groupId: 'FBroker' });
  const errs = validateResultsFile(file, { expectedIds: ['p2-ru-001', 'p2-ru-003'], codes, expectedCount: 10 });
  assert.ok(errs.some((e) => e.includes('повторяются')));
  assert.ok(errs.some((e) => e.includes('нет записей: p2-ru-003')));
  assert.ok(errs.some((e) => e.includes('нужно 10')));
});
