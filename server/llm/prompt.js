// Сборка промпта и JSON-схемы ответа ТОЛЬКО из конфига чек-листа.
// Никаких упоминаний конкретных критериев: замена критерия в UI сразу меняет промпт и схему.

export const SYSTEM_PROMPT = `Ты эксперт по контролю качества службы поддержки брокерской компании.
Ты оцениваешь работу ОПЕРАТОРА в одном диалоге (чат или транскрипт звонка) по чек-листу.

Общие правила:
1. Оцениваешь только реплики с ролью operator. Реплики bot и system — контекст: приветствие и действия бота оператору не засчитываются, системные события (передача оператору, подтверждение личности, обрыв, удержание, закрытие) — факты, на которые можно ссылаться как на доказательство.
2. Ответ «нет» (no) — оператор должен был выполнить требование, но не выполнил. «N/A» (na) — требование неприменимо, потому что выполнено условие N/A из описания критерия. N/A можно ставить ТОЛЬКО критериям, где оно разрешено, и только если условие N/A действительно выполнено. Если сомневаешься между «нет» и N/A — перечитай условие N/A.
3. Для критериев-нарушений (помечены «Да = нарушение») «да» означает, что нарушение БЫЛО.
4. Для шкалы выбирай только одно из перечисленных значений, сверяясь с описанием ступеней.
5. evidence — номера реплик [N], которые подтверждают ответ. Для «нет» укажи реплики, где действие ожидалось, а checked_range — проверенный участок [от, до]. Для N/A укажи реплику, из которой следует условие (например, событие обрыва). Не выдумывай номера: только из транскрипта.
6. Звонки — это автоматическая расшифровка речи: опечатки и искажения слов — ошибки распознавания, а не ошибки оператора. Пометки вида [Имя скрыто], [Персональные данные скрыты] — маскирование, это НЕ раскрытие данных. Если такая пометка стоит в ответ на запрос оператора, значит клиент назвал запрошенные данные.
7. Оценивай по тому, что есть в диалоге. Не снижай оценку за факты, которые невозможно проверить по диалогу, если в самом диалоге нет признаков ошибки.
8. Сначала рассуждай (reasoning), потом давай ответ. explanation — 1–3 предложения на русском языке, независимо от языка диалога.
9. operator_name — имя, которым оператор представился в диалоге (как написано), иначе null.
10. Каждый критерий оценивай независимо. Нарушение, которое относится к другому критерию (например, грубая ошибка или пропущенная идентификация), не снижает оценку по этому критерию.
11. Оценивай то, о чём клиент действительно спросил. Не требуй от оператора уточнений и сведений сверх того, что нужно для ответа на его вопрос.
12. Время ожидания до ПЕРВОЙ реплики оператора после передачи ему чата не учитывай ни в одном критерии (порог первой реакции в оценку не входит). Теги и вложения в оценку тоже не входят.`;

const answerEnum = (c) => {
  const base = c.type === 'scale' ? (c.levels || []).map((l) => String(l.value)) : ['yes', 'no'];
  return c.na_allowed ? [...base, 'na'] : base;
};

/** JSON Schema для strict structured output. Ключи — id критериев из конфига. */
export function buildSchema(checklist) {
  const props = {};
  for (const c of checklist.criteria) {
    props[c.id] = {
      type: 'object',
      additionalProperties: false,
      required: ['reasoning', 'answer', 'evidence', 'checked_range', 'explanation'],
      properties: {
        reasoning: { type: 'string', description: 'Краткий разбор по репликам до ответа' },
        answer: { type: 'string', enum: answerEnum(c) },
        evidence: { type: 'array', items: { type: 'integer' } },
        checked_range: { type: 'array', items: { type: 'integer' }, description: '[от, до] — проверенный участок; [] если не нужно' },
        explanation: { type: 'string' },
      },
    };
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['operator_name', 'criteria'],
    properties: {
      operator_name: { type: ['string', 'null'] },
      criteria: { type: 'object', additionalProperties: false, required: checklist.criteria.map((c) => c.id), properties: props },
    },
  };
}

const ANSWER_RU = { yes: 'да', no: 'нет', na: 'N/A' };
const answerRu = (a) => ANSWER_RU[a] ?? String(a);

/** Решения проверяющих по апелляциям — прецеденты для критерия (server/llm/examples.js). */
function renderExamples(list) {
  if (!list?.length) return [];
  const lines = ['Прецеденты — решения проверяющих по апелляциям на этот критерий (следуй той же логике):'];
  for (const e of list) {
    const verdict = e.action === 'change' ? `оценка ${answerRu(e.model_answer)} исправлена на ${answerRu(e.final_answer)}` : `оценка ${answerRu(e.final_answer)} подтверждена`;
    lines.push(`  - Язык ${e.language || '—'}. Фрагмент: ${e.fragment || '—'}`);
    lines.push(`    Проверяющий: ${verdict}. Причина: ${e.reason}`);
  }
  return lines;
}

function renderCriterion(c, sectionName, examples) {
  const lines = [`### ${c.id}. ${c.name}${sectionName ? ` (секция: ${sectionName})` : ''}`];
  if (c.description) lines.push(`Правило: ${c.description}`);
  if (c.kind === 'gross' || c.polarity === 'negative') lines.push('Тип: «Да = нарушение» (да — нарушение было, нет — не было).');
  if (c.type === 'scale') {
    lines.push('Шкала (выбери одно значение):');
    for (const l of c.levels || []) lines.push(`  - ${l.value}: ${l.description || ''}`);
  } else {
    lines.push('Ответ: yes / no.');
  }
  lines.push(c.na_allowed ? `N/A разрешён, условие: ${c.na_condition || 'не указано'}` : 'N/A НЕ разрешён.');
  lines.push(...renderExamples(examples));
  return lines.join('\n');
}

export function renderTranscript(transcript) {
  return transcript.map((r, i) => `[${i}] ${r.timestamp ?? ''} ${r.speaker}: ${String(r.text ?? '').replace(/\s+/g, ' ').trim()}`).join('\n');
}

/** Сообщения для chat.completions. Чек-лист идёт первым (стабильный префикс — кешируется провайдером). */
/**
 * @param opts.examples { [criterion_id]: [{fragment, model_answer, final_answer, action, reason, language}] }
 * @param opts.only     список id критериев: перепроверка только их (чек-лист в system остаётся полным — кеш префикса)
 */
export function buildMessages(checklist, record, events, { examples = {}, only = null } = {}) {
  const sections = new Map((checklist.sections || []).map((s) => [s.id, s.name]));
  const checklistText = `# Чек-лист «${checklist.name}» (версия ${checklist.version})\n\n` + checklist.criteria.map((c) => renderCriterion(c, sections.get(c.section), examples[c.id])).join('\n\n');
  const eventsText = events.length ? events.map((e) => `- ${e.index === null ? '—' : `[${e.index}]`} ${e.label}`).join('\n') : '- нет';
  const user = `# Диалог ${record.conversation_id}
Канал: ${record.channel === 'voice call' ? 'звонок (расшифровка речи)' : 'чат'}. Язык: ${record.language}.

## События диалога (размечены автоматически, проверь по тексту)
${eventsText}

## Транскрипт (номер реплики в квадратных скобках)
${renderTranscript(record.transcript)}

${only?.length ? `Оцени оператора ТОЛЬКО по критериям: ${only.join(', ')}. Это перепроверка спорных ответов: разбери реплики особенно внимательно.` : 'Оцени оператора по каждому критерию чек-листа.'}`;
  return [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\n${checklistText}` },
    { role: 'user', content: user },
  ];
}
