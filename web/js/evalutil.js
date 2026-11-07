// Общие помощники экранов оценки: последняя оценка диалога, финальный итог с учётом апелляций,
// кеш версий чек-листов, текущий group_id, смещения реплик для плеера.
import { api } from './api.js';
import { computeScore, replaceAnswer } from '/shared/scoring.js';

const GROUP_KEY = 'cqa.group_id';
export const currentGroup = () => localStorage.getItem(GROUP_KEY) || 'DEV';
export const setGroup = (g) => localStorage.setItem(GROUP_KEY, String(g || 'DEV').trim() || 'DEV');

/** Записи датасета из ответа бэкенда (терпимо к форме: как есть из API, {records} или массив). */
export function datasetRecords(d) {
  if (Array.isArray(d)) return d;
  return d?.data?.records || d?.records || [];
}

/** Последняя оценка по каждому диалогу: Map conversation_id → evaluation. */
export function latestByConversation(evaluations) {
  const m = new Map();
  for (const ev of evaluations) {
    const prev = m.get(ev.conversation_id);
    if (!prev || ev.created_at > prev.created_at) m.set(ev.conversation_id, ev);
  }
  return m;
}

const checklistCache = new Map();
/** Версия чек-листа, по которой сделана оценка (кешируется на время сессии страницы). */
export function checklistFor(id, version) {
  const key = `${id}@${version}`;
  if (!checklistCache.has(key)) checklistCache.set(key, api.checklist(id, version).catch(() => null));
  return checklistCache.get(key);
}

/** Ответы после всех решённых апелляций с action=change (исходная оценка не меняется). */
export function finalResults(ev, appeals) {
  let results = ev.results || [];
  const resolved = appeals
    .filter((a) => a.evaluation_id === ev.id && a.status === 'resolved' && a.decision?.action === 'change')
    .sort((a, b) => (a.decision.decided_at < b.decision.decided_at ? -1 : 1));
  for (const a of resolved) results = replaceAnswer(results, a.criterion_id, a.decision.new_answer);
  return results;
}

/** { original, final, changed } — исходный и финальный score оценки. */
export function scores(ev, checklist, appeals) {
  const original = ev.score || (checklist ? computeScore(checklist, ev.results) : null);
  const evAppeals = appeals.filter((a) => a.evaluation_id === ev.id);
  const changed = evAppeals.some((a) => a.status === 'resolved' && a.decision?.action === 'change');
  const final = changed && checklist ? computeScore(checklist, finalResults(ev, appeals)) : original;
  return { original, final, changed, appeals: evAppeals };
}

/** Секунды от начала: "MM:SS" / "HH:MM:SS" или ISO 8601 (как server/llm/events.js). */
export function parseTimestamp(ts) {
  if (!ts) return null;
  const s = String(ts).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) return m[3] !== undefined ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t / 1000;
}

/** Смещение реплик от первой реплики, сек: t − t(первой). */
export function offsets(transcript) {
  const base = transcript.map((r) => parseTimestamp(r.timestamp)).find((x) => x !== null);
  return transcript.map((r) => {
    const t = parseTimestamp(r.timestamp);
    return t === null || base === undefined ? null : Math.max(0, Math.round((t - base) * 10) / 10);
  });
}

export const fmtOffset = (sec) => {
  if (sec === null || sec === undefined) return '';
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Человекочитаемый ответ по критерию. */
export function answerLabel(criterion, answer) {
  if (answer === 'manual') return 'Ручная проверка';
  if (answer === 'na') return 'N/A';
  if (answer === undefined || answer === null) return '—';
  if (criterion?.type === 'scale') {
    const max = Math.max(...(criterion.levels || []).map((l) => Number(l.value)));
    return `${answer} из ${Number.isFinite(max) ? max : '?'}`;
  }
  return answer === 'yes' ? 'Да' : answer === 'no' ? 'Нет' : String(answer);
}

/** Класс бейджа ответа: хорошо / плохо / нейтрально (учитывает штрафные и грубые критерии). */
export function answerClass(criterion, answer) {
  if (answer === 'manual') return 'cqa-ans-manual';
  if (answer === 'na' || answer === undefined || answer === null) return 'cqa-ans-na';
  if (criterion?.type === 'scale') {
    const max = Math.max(...(criterion.levels || []).map((l) => Number(l.value)));
    const f = max > 0 ? Number(answer) / max : 0;
    return f >= 0.85 ? 'cqa-ans-good' : f >= 0.5 ? 'cqa-ans-mid' : 'cqa-ans-bad';
  }
  const bad = criterion?.kind === 'gross' || criterion?.polarity === 'negative' ? answer === 'yes' : answer === 'no';
  return bad ? 'cqa-ans-bad' : 'cqa-ans-good';
}
