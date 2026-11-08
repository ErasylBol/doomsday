// Выгрузка результатов в формат организаторов «Результаты оценки · JSON 1.0»
// (приложение к студенческому гайду: results/dev/results.json и results/prod/results.json).
// Коды критериев (contact, discovery, …) берутся из карты criterion_id → код (scripts/results-map.json),
// поэтому в ядре нет привязки к c01..c08.
import { computeScore, replaceAnswer } from './scoring.js';

export const SCHEMA_VERSION = '1.0';

const round2 = (x) => Math.round(x * 100) / 100;

/** Ответ системы → value формата: true/false, null = N/A, число шкалы как есть. undefined = не выразимо. */
export function toValue(criterion, answer) {
  if (answer === 'na') return null;
  if (answer === 'yes') return true;
  if (answer === 'no') return false;
  if (criterion?.type === 'scale' && answer !== null && answer !== '' && Number.isFinite(Number(answer))) return Number(answer);
  return undefined; // manual, пусто, мусор
}

/** Ответы с учётом решённых апелляций (исходная оценка в хранилище не меняется). */
function finalResults(ev, appeals) {
  let results = ev.results || [];
  const resolved = (appeals || [])
    .filter((a) => a.evaluation_id === ev.id && a.status === 'resolved' && a.decision?.action === 'change')
    .sort((a, b) => String(a.decision.decided_at).localeCompare(String(b.decision.decided_at)));
  for (const a of resolved) results = replaceAnswer(results, a.criterion_id, a.decision.new_answer);
  return results;
}

/**
 * Одна запись results[] для диалога.
 * @param {object|null} ev        последняя оценка диалога (или null)
 * @param {object|null} checklist версия чек-листа, по которой сделана оценка
 * @param {object} map            { criterion_id: "contact", … } — ровно те критерии, что идут в файл
 */
export function toResult(conversationId, ev, checklist, map, appeals = []) {
  const error = (msg) => ({ conversation_id: conversationId, status: 'error', criteria: [], score: null, error: msg });
  if (!ev) return error('Диалог не оценён.');
  if (!checklist) return error(`Не найдена версия чек-листа ${ev.checklist_id} v${ev.checklist_version}.`);
  const results = finalResults(ev, appeals);
  const byId = new Map(results.map((r) => [r.criterion_id, r]));
  const criteria = [];
  const problems = [];
  let critical = null;
  for (const [cid, code] of Object.entries(map)) {
    const c = checklist.criteria.find((x) => x.id === cid);
    const r = byId.get(cid);
    if (!c || !r) { problems.push(`${code}: нет критерия в оценке`); continue; }
    const value = toValue(c, r.answer);
    if (value === undefined) { problems.push(`${code}: модель не дала валидного ответа (${r.answer ?? 'пусто'})`); continue; }
    if (value === null && !c.na_allowed) { problems.push(`${code}: N/A не разрешён`); continue; }
    const turns = [...new Set((r.evidence || []).map(Number).filter(Number.isInteger).map((i) => i + 1))].sort((a, b) => a - b);
    criteria.push({ criterion_id: code, value, rationale: String(r.explanation || '').trim(), evidence_turns: turns });
    if (c.kind === 'gross') critical = critical || value === true;
  }
  if (problems.length) return error(`Не все критерии оценены: ${problems.join('; ')}.`);
  const score = computeScore(checklist, results);
  return {
    conversation_id: conversationId,
    status: 'ok',
    criteria,
    score: {
      final_score: score.total === null ? null : round2(score.total),
      critical_flag: critical === null ? !!score.gross_error : critical,
    },
  };
}

/** Последняя оценка каждого диалога набора. */
export function latestEvaluations(evaluations, groupId) {
  const latest = new Map();
  for (const ev of evaluations) {
    if (groupId && ev.group_id && ev.group_id !== groupId) continue;
    const prev = latest.get(ev.conversation_id);
    if (!prev || String(ev.created_at) > String(prev.created_at)) latest.set(ev.conversation_id, ev);
  }
  return latest;
}

/** Файл целиком: одна запись на каждый диалог набора, в порядке набора. */
export function buildResultsFile({ records, evaluations, appeals = [], getChecklist, map, teamName, modelMode = 'external_api', groupId }) {
  const latest = latestEvaluations(evaluations, groupId);
  const results = records.map((rec) => {
    const ev = latest.get(rec.conversation_id) || null;
    return toResult(rec.conversation_id, ev, ev ? getChecklist(ev.checklist_id, ev.checklist_version) : null, map, appeals);
  });
  const models = [...new Set(records.flatMap((rec) => {
    const ev = latest.get(rec.conversation_id);
    return ev ? [ev.model, ev.escalation?.model].filter(Boolean) : [];
  }))];
  return { schema_version: SCHEMA_VERSION, team_name: teamName, model: { mode: modelMode, name: models.join(', ') || 'нет оценок' }, results };
}

/** Проверки из раздела «Перед push» и «Правила заполнения». Возвращает список проблем (пусто = ок). */
export function validateResultsFile(file, { expectedIds, codes, expectedCount } = {}) {
  const errs = [];
  if (file.schema_version !== SCHEMA_VERSION) errs.push('schema_version должен быть "1.0"');
  if (!file.team_name) errs.push('пустой team_name');
  if (!['local', 'external_api', 'hybrid'].includes(file.model?.mode)) errs.push('model.mode: local | external_api | hybrid');
  if (!file.model?.name) errs.push('пустой model.name');
  if (!Array.isArray(file.results)) return [...errs, 'results не массив'];
  const ids = file.results.map((r) => r.conversation_id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) errs.push(`повторяются ID: ${[...new Set(dup)].join(', ')}`);
  if (expectedIds) {
    const want = new Set(expectedIds);
    const missing = expectedIds.filter((id) => !ids.includes(id));
    const extra = ids.filter((id) => !want.has(id));
    if (missing.length) errs.push(`нет записей: ${missing.join(', ')}`);
    if (extra.length) errs.push(`лишние ID: ${extra.join(', ')}`);
  }
  if (expectedCount !== undefined && ids.length !== expectedCount) errs.push(`записей ${ids.length}, нужно ${expectedCount}`);
  for (const r of file.results) {
    const p = `${r.conversation_id}:`;
    if (r.status === 'error') {
      if (!Array.isArray(r.criteria) || r.criteria.length) errs.push(`${p} при error criteria должен быть []`);
      if (r.score !== null) errs.push(`${p} при error score должен быть null`);
      if (!r.error) errs.push(`${p} при error нужна причина в error`);
      continue;
    }
    if (r.status !== 'ok') { errs.push(`${p} status ok | error`); continue; }
    const got = r.criteria.map((c) => c.criterion_id);
    if (codes) {
      const miss = codes.filter((c) => !got.includes(c));
      if (miss.length) errs.push(`${p} нет критериев ${miss.join(', ')}`);
    }
    if (new Set(got).size !== got.length) errs.push(`${p} критерий повторяется`);
    for (const c of r.criteria) {
      const ok = c.value === null || typeof c.value === 'boolean' || (typeof c.value === 'number' && Number.isFinite(c.value));
      if (!ok) errs.push(`${p} ${c.criterion_id}: недопустимый value`);
      if (typeof c.rationale !== 'string') errs.push(`${p} ${c.criterion_id}: rationale не строка`);
      if (!Array.isArray(c.evidence_turns) || c.evidence_turns.some((t) => !Number.isInteger(t) || t < 1)) errs.push(`${p} ${c.criterion_id}: evidence_turns — целые с 1`);
    }
    const fs = r.score?.final_score;
    if (fs !== null && (typeof fs !== 'number' || fs < 0 || fs > 100 || round2(fs) !== fs)) errs.push(`${p} final_score 0..100, два знака`);
    if (typeof r.score?.critical_flag !== 'boolean') errs.push(`${p} critical_flag не boolean`);
    const crit = r.criteria.find((c) => c.criterion_id === 'critical');
    if (crit && crit.value !== r.score?.critical_flag) errs.push(`${p} critical_flag не совпадает с critical`);
  }
  return errs;
}
