// Проверка и нормализация ответа модели против конфига чек-листа.

/** Нормализует ответ одного критерия. Возвращает { ok, result, error }. */
export function normalizeCriterion(c, raw, transcriptLength) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'нет ответа' };
  let answer = raw.answer;
  if (answer === 'na') {
    if (!c.na_allowed) return { ok: false, error: 'N/A не разрешён' };
  } else if (c.type === 'scale') {
    const allowed = (c.levels || []).map((l) => Number(l.value));
    answer = Number(answer);
    if (!allowed.includes(answer)) return { ok: false, error: `значение ${raw.answer} не из шкалы` };
  } else if (answer !== 'yes' && answer !== 'no') {
    return { ok: false, error: `недопустимый ответ ${raw.answer}` };
  }
  const inRange = (i) => Number.isInteger(i) && i >= 0 && i < transcriptLength;
  const evidence = [...new Set((raw.evidence || []).filter(inRange))].sort((a, b) => a - b);
  const badEvidence = (raw.evidence || []).filter((i) => !inRange(i));
  let checked = (raw.checked_range || []).filter(inRange);
  checked = checked.length >= 2 ? [Math.min(...checked), Math.max(...checked)] : null;
  return {
    ok: true,
    dropped_evidence: badEvidence,
    result: {
      criterion_id: c.id,
      answer,
      explanation: String(raw.explanation || '').trim(),
      reasoning: String(raw.reasoning || '').trim(),
      evidence,
      checked_range: checked,
    },
  };
}

/** Проверяет весь ответ модели. errors — по id критерия. */
export function validateOutput(checklist, output, transcriptLength) {
  const results = {};
  const errors = {};
  for (const c of checklist.criteria) {
    const n = normalizeCriterion(c, output?.criteria?.[c.id], transcriptLength);
    if (n.ok) results[c.id] = n.result;
    else errors[c.id] = n.error;
  }
  const name = output?.operator_name;
  return { results, errors, operator_name: typeof name === 'string' && name.trim() ? name.trim() : null };
}
