import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { detectEvents, offsets } from '../llm/events.js';
import { buildSchema, buildMessages } from '../llm/prompt.js';
import { validateOutput } from '../llm/validate.js';
import { evaluateConversation, vote } from '../llm/evaluate.js';
import { compare } from '../llm/accuracy.js';
import { computeScore } from '../scoring.js';

const checklist = JSON.parse(fs.readFileSync(new URL('../seed/checklist.default.json', import.meta.url)));
const record = {
  conversation_id: 't-1', channel: 'agent chat', language: 'RU',
  transcript: [
    { timestamp: '00:01', speaker: 'client', text: 'Здравствуйте, оператора' },
    { timestamp: '00:02', speaker: 'bot', text: 'Здравствуйте! Я бот AIM.' },
    { timestamp: '00:03', speaker: 'system', text: 'Эскалация на оператора' },
    { timestamp: '00:30', speaker: 'operator', text: 'Добрый день, меня зовут Айгерим.' },
    { timestamp: '00:40', speaker: 'system', text: 'Личность клиента подтверждена.' },
    { timestamp: '05:00', speaker: 'operator', text: 'Ваш вопрос решён.' },
    { timestamp: '05:10', speaker: 'system', text: 'Клиент покинул чат.' },
  ],
};

test('события: первая реплика оператора, эскалация, идентификация, обрыв, долгий ответ', () => {
  const ev = detectEvents(record.transcript);
  const types = ev.map((e) => `${e.type}@${e.index}`);
  for (const t of ['escalation@2', 'first_operator@3', 'identity_verified@4', 'disconnect@6', 'last_operator@5', 'long_wait@5']) assert.ok(types.includes(t), t);
});

test('смещения для плеера: ISO и MM:SS', () => {
  assert.deepEqual(offsets([{ timestamp: '2026-11-03T13:10:00+00:00' }, { timestamp: '2026-11-03T13:10:05.5+00:00' }]), [0, 5.5]);
  assert.deepEqual(offsets([{ timestamp: '01:00' }, { timestamp: '01:30' }]), [0, 30]);
});

test('схема строится из конфига: N/A только где разрешён, шкала — ступени', () => {
  const s = buildSchema(checklist).properties.criteria.properties;
  assert.deepEqual(s.c01.properties.answer.enum, ['yes', 'no']);
  assert.deepEqual(s.c02.properties.answer.enum, ['yes', 'no', 'na']);
  assert.deepEqual(s.c04.properties.answer.enum, ['0', '5', '10', '15', '20', 'na']);
});

test('замена критерия: промпт и схема меняются, старого критерия нет', () => {
  const cl = { ...checklist, criteria: checklist.criteria.map((c) => (c.id === 'c05' ? { ...c, id: 'c05b', name: 'Не чихал в трубку', polarity: 'negative', description: 'Оператор чихал' } : c)) };
  const msgs = buildMessages(cl, record, detectEvents(record.transcript));
  assert.ok(msgs[0].content.includes('Не чихал в трубку'));
  assert.ok(msgs[0].content.includes('Да = нарушение'));
  assert.ok(!msgs[0].content.includes('Эмпатия'));
  assert.ok('c05b' in buildSchema(cl).properties.criteria.properties);
  assert.ok(msgs[1].content.includes('[3] 00:30 operator: Добрый день'));
});

test('валидация: недопустимый N/A, значение вне шкалы, индексы за пределами', () => {
  const v = validateOutput(checklist, {
    operator_name: ' Айгерим ',
    criteria: {
      c01: { answer: 'na', evidence: [], checked_range: [] },
      c04: { answer: '12', evidence: [], checked_range: [] },
      c03: { answer: 'yes', evidence: [4, 99, -1], checked_range: [0, 50], explanation: 'ok' },
    },
  }, record.transcript.length);
  assert.ok(v.errors.c01);
  assert.ok(v.errors.c04);
  assert.deepEqual(v.results.c03.evidence, [4]);
  assert.equal(v.results.c03.checked_range, null);
  assert.equal(v.operator_name, 'Айгерим');
});

test('голосование: большинство, медиана шкалы при ничьей, manual если нет валидных', () => {
  const c = checklist.criteria.find((x) => x.id === 'c03');
  assert.equal(vote(c, [{ answer: 'yes' }, { answer: 'no' }, { answer: 'yes' }]).result.answer, 'yes');
  assert.equal(vote(c, [{ answer: 'yes' }, { answer: 'no' }, { answer: 'yes' }]).confidence, 0.67);
  const sc = checklist.criteria.find((x) => x.id === 'c04');
  assert.equal(vote(sc, [{ answer: 20 }, { answer: 10 }, { answer: 15 }]).result.answer, 15);
  assert.equal(vote(c, [null, null, null]).result.answer, 'manual');
});

function fakeProvider(answersByRun) {
  let call = 0;
  return {
    model: 'fake',
    async complete() {
      const a = answersByRun[call++ % answersByRun.length];
      const criteria = {};
      for (const c of checklist.criteria) criteria[c.id] = { reasoning: 'r', answer: String(a[c.id]), evidence: [3], checked_range: [], explanation: 'e' };
      return { json: { operator_name: 'Айгерим', criteria }, model: 'fake', usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 200 } };
    },
  };
}

test('оценка диалога целиком: 3 прогона, голосование, итог, токены', async () => {
  const good = { c01: 'yes', c02: 'yes', c03: 'yes', c04: '20', c05: 'yes', c06: '10', c07: 'na', c08: 'no' };
  const ev = await evaluateConversation({ record, checklist, provider: fakeProvider([good, { ...good, c01: 'no' }, good]), runs: 3, group_id: 'DEV' });
  assert.equal(ev.results.find((r) => r.criterion_id === 'c01').answer, 'yes');
  assert.equal(ev.results.find((r) => r.criterion_id === 'c01').confidence, 0.67);
  assert.equal(ev.results.find((r) => r.criterion_id === 'c04').answer, 20);
  assert.equal(ev.score.total, 100);
  assert.equal(ev.operator_name, 'Айгерим');
  assert.equal(ev.usage.input_tokens, 3000);
  assert.equal(ev.language, 'RU');
});

test('невалидный ответ → повтор → manual', async () => {
  const bad = { c01: 'maybe', c02: 'yes', c03: 'yes', c04: '20', c05: 'yes', c06: '10', c07: 'yes', c08: 'no' };
  const ev = await evaluateConversation({ record, checklist, provider: fakeProvider([bad]), runs: 1 });
  assert.equal(ev.results.find((r) => r.criterion_id === 'c01').answer, 'manual');
  assert.deepEqual(ev.score.pending_manual, ['c01']);
  assert.equal(ev.usage.input_tokens, 2000); // был повтор
});

test('сравнение с эталоном', () => {
  const gt = { conversation_id: 't-1', answers: { c01: 'yes', c02: 'na', c04: 15, c08: 'no' } };
  const ev = { results: [{ criterion_id: 'c01', answer: 'yes' }, { criterion_id: 'c02', answer: 'yes' }, { criterion_id: 'c04', answer: 20 }, { criterion_id: 'c08', answer: 'no' }] };
  const r = compare([{ gt, ev, checklist }], computeScore);
  assert.equal(r.overall, 50);
  assert.equal(r.na.recall, 0);
  assert.equal(r.criteria.find((c) => c.id === 'c04').mae, 5);
  assert.equal(r.mismatches.length, 2);
});
