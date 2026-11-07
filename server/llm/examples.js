// Обучение на апелляциях: решения проверяющих становятся прецедентами у критерия в промпте.
// Берём рассмотренные апелляции (и «изменить», и «подтвердить»), фрагмент диалога по доказательствам исходной оценки,
// ответ модели и решение с причиной. Привязка — по id критерия и id чек-листа, поэтому работает для любого критерия
// из редактора; прецедент отбрасывается, если его ответ недопустим в текущей версии критерия (сменили шкалу/N/A).

const allowed = (c) => [...(c.type === 'scale' ? (c.levels || []).map((l) => String(l.value)) : ['yes', 'no']), ...(c.na_allowed ? ['na'] : [])];
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Фрагмент: реплики-доказательства (до 4), каждая до 220 символов. */
export function fragmentOf(record, result) {
  if (!record?.transcript?.length) return '';
  let idx = (result?.evidence || []).filter((i) => i >= 0 && i < record.transcript.length);
  if (!idx.length && Array.isArray(result?.checked_range) && result.checked_range.length === 2) {
    const [a, b] = result.checked_range;
    idx = [a, b].filter((i) => i >= 0 && i < record.transcript.length);
  }
  return idx
    .slice(0, 4)
    .map((i) => {
      const t = record.transcript[i];
      return `[${t.speaker}] «${clip(String(t.text || '').replace(/\s+/g, ' ').trim(), 220)}»`;
    })
    .join(' … ');
}

/**
 * @param p.checklist     текущая версия чек-листа (для какой оцениваем)
 * @param p.appeals       все апелляции
 * @param p.evaluations   все оценки (для исходного ответа и доказательств)
 * @param p.getRecord     (conversation_id, group_id) → запись диалога или null
 * @param p.perCriterion  сколько прецедентов на критерий (по умолчанию LLM_APPEAL_EXAMPLES или 3; 0 — выключено)
 * @param p.excludeConversation  не брать прецеденты из этого диалога (чтобы не «подсказывать» ему самому себе)
 * @returns { [criterion_id]: Example[] }
 */
export function collectExamples({ checklist, appeals, evaluations, getRecord, perCriterion, excludeConversation = null }) {
  const limit = perCriterion ?? Number(process.env.LLM_APPEAL_EXAMPLES ?? 3);
  if (!limit) return {};
  const byCriterion = new Map(checklist.criteria.map((c) => [c.id, c]));
  const evById = new Map(evaluations.map((e) => [e.id, e]));
  const out = {};
  const resolved = appeals
    .filter((a) => a.status === 'resolved' && a.decision?.reason && byCriterion.has(a.criterion_id))
    .sort((a, b) => String(b.decision.decided_at).localeCompare(String(a.decision.decided_at)));
  for (const a of resolved) {
    const ev = evById.get(a.evaluation_id);
    if (!ev || ev.checklist_id !== checklist.id || a.conversation_id === excludeConversation) continue;
    const c = byCriterion.get(a.criterion_id);
    const original = ev.results?.find((r) => r.criterion_id === a.criterion_id);
    const finalAnswer = a.decision.action === 'change' ? a.decision.new_answer : original?.answer;
    if (finalAnswer === undefined || !allowed(c).includes(String(finalAnswer))) continue;
    const list = (out[c.id] ||= []);
    if (list.length >= limit) continue;
    let record = null;
    try {
      record = getRecord(a.conversation_id, ev.group_id);
    } catch {}
    list.push({
      conversation_id: a.conversation_id,
      language: ev.language,
      fragment: fragmentOf(record, original),
      model_answer: original?.answer,
      final_answer: finalAnswer,
      action: a.decision.action,
      reason: clip(String(a.decision.reason).replace(/\s+/g, ' ').trim(), 300),
    });
  }
  return out;
}
