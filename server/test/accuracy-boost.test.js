// Перепроверка спорных критериев сильной моделью и прецеденты из апелляций.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateConversation, needsEscalation } from '../llm/evaluate.js';
import { buildMessages } from '../llm/prompt.js';
import { collectExamples, fragmentOf } from '../llm/examples.js';

const checklist = JSON.parse(fs.readFileSync(new URL('../seed/checklist.default.json', import.meta.url)));
const record = {
  conversation_id: 't-1', channel: 'agent chat', language: 'RU',
  transcript: [
    { timestamp: '00:01', speaker: 'client', text: 'Где тариф?' },
    { timestamp: '00:30', speaker: 'operator', text: 'Здравствуйте, я Айгерим. Во вкладке «Кабинет».' },
    { timestamp: '01:00', speaker: 'operator', text: 'Хорошего дня!' },
  ],
};
const base = { c01: 'yes', c02: 'na', c03: 'na', c04: '20', c05: 'yes', c06: '10', c07: 'no', c08: 'no' };

function provider(model, answersByRun, seen = []) {
  let call = 0;
  return {
    model,
    async complete({ messages, schema }) {
      seen.push({ messages, ids: Object.keys(schema.properties.criteria.properties) });
      const a = answersByRun[call++ % answersByRun.length];
      const criteria = {};
      for (const id of Object.keys(schema.properties.criteria.properties)) criteria[id] = { reasoning: 'r', answer: String(a[id]), evidence: [1], checked_range: [], explanation: `${model}:${a[id]}` };
      return { json: { operator_name: 'Айгерим', criteria }, model, usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 } };
    },
  };
}

test('спорные критерии (прогоны разошлись) и manual уходят на перепроверку', () => {
  const results = [
    { criterion_id: 'c01', answer: 'yes', confidence: 1 },
    { criterion_id: 'c07', answer: 'no', confidence: 0.67 },
    { criterion_id: 'c03', answer: 'manual', confidence: 0 },
  ];
  assert.deepEqual(needsEscalation(results, 3), ['c07', 'c03']);
  assert.deepEqual(needsEscalation(results, 1), ['c03']);
});

test('перепроверка: сильная модель видит только спорные критерии, её ответ заменяет голосование', async () => {
  const seen = [];
  const strong = provider('strong', [{ ...base, c07: 'yes' }], seen);
  const ev = await evaluateConversation({
    record, checklist, runs: 3,
    provider: provider('cheap', [base, { ...base, c07: 'yes' }, base]),
    escalation: { provider: strong, cost: (u) => u.input_tokens / 1e6 },
  });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].ids, ['c07']);
  assert.match(seen[0].messages[1].content, /ТОЛЬКО по критериям: c07/);
  const c07 = ev.results.find((r) => r.criterion_id === 'c07');
  assert.equal(c07.answer, 'yes');
  assert.deepEqual(c07.escalated, { model: 'strong', from: 'no' });
  assert.equal(c07.confidence, 0.67);
  assert.deepEqual(ev.escalation.changed, ['c07']);
  assert.equal(ev.results.find((r) => r.criterion_id === 'c01').escalated, undefined);
  assert.equal(ev.score.per_criterion.c07.answer, 'yes', 'итог считается по ответу после перепроверки');
});

test('без расхождений сильная модель не вызывается', async () => {
  const seen = [];
  const ev = await evaluateConversation({ record, checklist, runs: 3, provider: provider('cheap', [base]), escalation: { provider: provider('strong', [base], seen) } });
  assert.equal(seen.length, 0);
  assert.equal(ev.escalation, undefined);
});

test('сбой сильной модели не ломает оценку: остаётся ответ голосования', async () => {
  const broken = { model: 'strong', async complete() { throw new Error('503'); } };
  const ev = await evaluateConversation({ record, checklist, runs: 3, provider: provider('cheap', [base, { ...base, c07: 'yes' }, base]), escalation: { provider: broken } });
  assert.equal(ev.results.find((r) => r.criterion_id === 'c07').answer, 'no');
  assert.match(ev.escalation.error, /503/);
});

test('прецеденты из апелляций: решение проверяющего попадает в промпт у своего критерия', () => {
  const ev = { id: 'ev1', conversation_id: 'old', group_id: 'DEV', language: 'KZ', checklist_id: 'default', results: [{ criterion_id: 'c07', answer: 'yes', evidence: [2] }] };
  const oldRecord = { conversation_id: 'old', transcript: [{ speaker: 'client', text: 'а' }, { speaker: 'client', text: 'б' }, { speaker: 'operator', text: 'Сау болыңыз!' }] };
  const appeals = [
    { id: 'a1', evaluation_id: 'ev1', conversation_id: 'old', criterion_id: 'c07', status: 'resolved', decision: { action: 'change', new_answer: 'no', reason: 'Только прощание, без итога', decided_at: '2026-11-07T10:00:00Z' } },
    { id: 'a2', evaluation_id: 'ev1', conversation_id: 'old', criterion_id: 'c07', status: 'open', comment: 'x' },
    { id: 'a3', evaluation_id: 'ev1', conversation_id: 'old', criterion_id: 'gone', status: 'resolved', decision: { action: 'confirm', reason: 'r', decided_at: '2026-11-07T10:00:00Z' } },
  ];
  const ex = collectExamples({ checklist, appeals, evaluations: [ev], getRecord: () => oldRecord, perCriterion: 3 });
  assert.deepEqual(Object.keys(ex), ['c07']);
  assert.equal(ex.c07[0].final_answer, 'no');
  assert.equal(ex.c07[0].fragment, '[operator] «Сау болыңыз!»');
  const sys = buildMessages(checklist, record, [], { examples: ex })[0].content;
  const c07block = sys.slice(sys.indexOf('### c07'), sys.indexOf('### c08'));
  assert.match(c07block, /Прецеденты/);
  assert.match(c07block, /оценка да исправлена на нет\. Причина: Только прощание, без итога/);
  assert.ok(!sys.slice(0, sys.indexOf('### c07')).includes('Прецеденты'), 'у других критериев прецедентов нет');
  assert.deepEqual(collectExamples({ checklist, appeals, evaluations: [ev], getRecord: () => oldRecord, excludeConversation: 'old' }), {});
  assert.deepEqual(collectExamples({ checklist, appeals, evaluations: [ev], getRecord: () => oldRecord, perCriterion: 0 }), {});
});

test('прецедент с ответом, недопустимым в новой версии критерия, отбрасывается', () => {
  const changed = { ...checklist, criteria: checklist.criteria.map((c) => (c.id === 'c07' ? { ...c, na_allowed: false } : c)) };
  const ev = { id: 'ev1', conversation_id: 'old', checklist_id: 'default', results: [{ criterion_id: 'c07', answer: 'no' }] };
  const appeals = [{ id: 'a1', evaluation_id: 'ev1', conversation_id: 'old', criterion_id: 'c07', status: 'resolved', decision: { action: 'change', new_answer: 'na', reason: 'обрыв', decided_at: 'x' } }];
  assert.deepEqual(collectExamples({ checklist: changed, appeals, evaluations: [ev], getRecord: () => null, perCriterion: 3 }), {});
  assert.equal(fragmentOf(null, {}), '');
});
