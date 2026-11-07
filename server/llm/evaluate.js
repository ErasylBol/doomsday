// Оценка одного диалога: N прогонов модели → валидация → голосование → Evaluation (без id).
import { detectEvents } from './events.js';
import { buildMessages, buildSchema } from './prompt.js';
import { validateOutput } from './validate.js';
import { costUSD } from './provider.js';
import { computeScore } from '../scoring.js';

/** Один прогон с одним повтором при ошибке вызова или невалидных критериях. */
async function runOnce(provider, messages, schema, checklist, transcriptLength) {
  const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  const add = (u) => { for (const k in usage) usage[k] += u?.[k] || 0; };
  let best = null;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await provider.complete({ messages, schema });
      add(r.usage);
      const v = validateOutput(checklist, r.json, transcriptLength);
      if (!best || Object.keys(v.errors).length < Object.keys(best.errors).length) best = { ...v, model: r.model };
      if (!Object.keys(v.errors).length) break;
    } catch (e) {
      lastError = e;
    }
  }
  return { out: best, usage, error: best ? null : lastError };
}

/** Выбор ответа по большинству; при равенстве для шкалы — медиана, иначе ответ первого прогона. */
export function vote(criterion, runResults) {
  const valid = runResults.filter(Boolean);
  if (!valid.length) return { result: { criterion_id: criterion.id, answer: 'manual', explanation: 'Модель не дала валидного ответа — требуется ручная проверка.', evidence: [], checked_range: null }, confidence: 0 };
  const counts = new Map();
  for (const r of valid) counts.set(String(r.answer), (counts.get(String(r.answer)) || 0) + 1);
  const max = Math.max(...counts.values());
  let leaders = [...counts.entries()].filter(([, n]) => n === max).map(([a]) => a);
  let chosen = leaders[0];
  if (leaders.length > 1) {
    const nums = valid.map((r) => r.answer).filter((a) => typeof a === 'number').sort((a, b) => a - b);
    if (criterion.type === 'scale' && nums.length) chosen = String(nums[Math.floor((nums.length - 1) / 2)]);
    else chosen = String(valid[0].answer);
  }
  const pick = valid.find((r) => String(r.answer) === chosen);
  return { result: { ...pick }, confidence: Math.round((counts.get(chosen) / runResults.length) * 100) / 100, votes: Object.fromEntries(counts) };
}

/** Критерии для перепроверки: прогоны разошлись (confidence < 1) или валидного ответа нет (manual). */
export function needsEscalation(results, runs) {
  return results.filter((r) => r.answer === 'manual' || (runs > 1 && r.confidence < 1)).map((r) => r.criterion_id);
}

/**
 * Перепроверка спорных критериев более сильной моделью (escalation.provider, обычно gpt-6.1-sol).
 * Возвращает новые results и отчёт; при ошибке сильной модели остаются ответы голосования.
 */
async function escalate({ ids, results, record, checklist, events, examples, escalation }) {
  const sub = { ...checklist, criteria: checklist.criteria.filter((c) => ids.includes(c.id)) };
  const messages = buildMessages(checklist, record, events, { examples, only: ids });
  const { out, usage, error } = await runOnce(escalation.provider, messages, buildSchema(sub), sub, record.transcript.length);
  const report = { model: escalation.provider.model, criteria: ids, changed: [], usage, cost_usd: escalation.cost ? escalation.cost(usage) : null };
  if (!out) return { results, report: { ...report, error: error?.message || 'нет валидного ответа' } };
  const next = results.map((r) => {
    const e = out.results[r.criterion_id];
    if (!ids.includes(r.criterion_id) || !e) return r;
    if (String(e.answer) !== String(r.answer)) report.changed.push(r.criterion_id);
    return { ...e, confidence: r.confidence, ...(r.votes ? { votes: r.votes } : {}), escalated: { model: report.model, from: r.answer } };
  });
  return { results: next, report };
}

/**
 * @param {object} p { record, checklist, provider, runs=3, group_id, examples, escalation }
 *   examples   — прецеденты из апелляций по критериям (collectExamples), попадают в промпт у критерия
 *   escalation — { provider, cost(usage) }: спорные критерии перепроверяются этой моделью
 */
export async function evaluateConversation({ record, checklist, provider, runs = 3, group_id = null, examples = {}, escalation = null }) {
  const events = detectEvents(record.transcript);
  const messages = buildMessages(checklist, record, events, { examples });
  const schema = buildSchema(checklist);
  const started = Date.now();

  const outs = await Promise.all(Array.from({ length: runs }, () => runOnce(provider, messages, schema, checklist, record.transcript.length)));
  const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  for (const o of outs) for (const k in usage) usage[k] += o.usage[k];
  const ok = outs.filter((o) => o.out);
  if (!ok.length) throw outs[0].error || new Error('Все прогоны завершились ошибкой');

  let results = checklist.criteria.map((c) => {
    const v = vote(c, outs.map((o) => o.out?.results?.[c.id] || null));
    return { ...v.result, confidence: v.confidence, ...(v.votes && Object.keys(v.votes).length > 1 ? { votes: v.votes } : {}) };
  });

  let escalationReport = null;
  const disputed = escalation?.provider ? needsEscalation(results, runs) : [];
  if (disputed.length) ({ results, report: escalationReport } = await escalate({ ids: disputed, results, record, checklist, events, examples, escalation }));
  const baseCost = costUSD(usage);

  // Имя оператора: самое частое непустое значение среди прогонов
  const names = ok.map((o) => o.out.operator_name).filter(Boolean);
  const operator_name = names.sort((a, b) => names.filter((x) => x === b).length - names.filter((x) => x === a).length)[0] || null;

  return {
    conversation_id: record.conversation_id,
    group_id,
    language: record.language,
    channel: record.channel,
    operator_name,
    checklist_id: checklist.id,
    checklist_version: checklist.version,
    model: ok[0].out.model || provider.model,
    runs,
    usage,
    cost_usd: baseCost === null && !escalationReport?.cost_usd ? null : Math.round(((baseCost || 0) + (escalationReport?.cost_usd || 0)) * 1e6) / 1e6,
    ...(escalationReport ? { escalation: escalationReport } : {}),
    ...(Object.keys(examples).length ? { appeal_examples: Object.fromEntries(Object.entries(examples).map(([k, v]) => [k, v.length])) } : {}),
    duration_ms: Date.now() - started,
    events,
    results,
    score: computeScore(checklist, results),
  };
}
