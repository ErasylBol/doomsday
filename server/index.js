import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import * as analytics from './analytics.js';
import { checklistError, validAnswer } from './validation.js';
import { recordsFor } from './datasets.js';
import { evaluateConversation } from './llm/evaluate.js';
import { createOpenAIProvider } from './llm/provider.js';
import { computeScore, replaceAnswer } from './scoring.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = express();
app.use(express.json({ limit: '5mb' }));

const filters = (q) => ({
  group_id: q.group_id || undefined,
  checklist_id: q.checklist_id || undefined,
  language: q.language || undefined,
  channel: q.channel || undefined,
});
const data = () => ({
  evaluations: store.listEvaluations(),
  appeals: store.listAppeals(),
  getChecklist: store.getChecklist,
  operatorOverrides: store.getOperatorOverrides(),
});

// ---------- checklists ----------
app.get('/api/checklists', (req, res) => {
  const all = store.listChecklists();
  const latest = new Map();
  for (const c of all) if (!latest.has(c.id) || c.version > latest.get(c.id).version) latest.set(c.id, c);
  res.json(req.query.all ? all : [...latest.values()]);
});
app.get('/api/checklists/:id', (req, res) => {
  const c = store.getChecklist(req.params.id, req.query.version);
  c ? res.json(c) : res.status(404).json({ error: 'not found' });
});
app.post('/api/checklists', (req, res) => {
  const c = req.body;
  const error = checklistError(c);
  if (error) return res.status(400).json({ error });
  res.json(store.saveChecklistVersion(c));
});

// Локальные снапшоты организаторов: тот же формат, что использует CLI.
app.get('/api/datasets/:groupId', (req, res) => {
  try { res.json({ records: recordsFor(req.params.groupId) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/conversations/:id', (req, res) => {
  try {
    const record = recordsFor(req.query.group_id || 'DEV').find(r=>r.conversation_id === req.params.id);
    record ? res.json(record) : res.status(404).json({error:'Диалог не найден'});
  } catch(e) { res.status(400).json({error:e.message}); }
});
app.post('/api/evaluate', async (req, res) => {
  try {
    const { group_id, conversation_ids, checklist_id, checklist_version } = req.body;
    const checklist = store.getChecklist(checklist_id, checklist_version);
    if (!checklist) return res.status(400).json({ error: 'Чек-лист не найден' });
    const all = recordsFor(group_id);
    if (conversation_ids !== 'all' && (!Array.isArray(conversation_ids) || !conversation_ids.length)) return res.status(400).json({ error: 'Выберите диалоги' });
    const records = conversation_ids === 'all' ? all : all.filter(r=>conversation_ids.includes(r.conversation_id));
    if (!records.length) return res.status(400).json({ error: 'Диалоги не найдены' });
    const provider = app.locals.evaluationProvider || createOpenAIProvider();
    const queue = [...records], evaluations = [], errors = [];
    async function worker() {
      while (queue.length) {
        const record = queue.shift();
        try { evaluations.push(store.saveEvaluation(await evaluateConversation({ record, checklist, provider, group_id, runs: Number(process.env.LLM_RUNS) || 3 }))); }
        catch(e) { errors.push({ conversation_id: record.conversation_id, error: e.message }); }
      }
    }
    await Promise.all(Array.from({length: Math.min(5, records.length)}, worker));
    res.json({ evaluations, errors });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// ---------- evaluations ----------
app.get('/api/evaluations', (req, res) => {
  let all = store.listEvaluations();
  if (req.query.conversation_id) all = all.filter((e) => e.conversation_id === req.query.conversation_id);
  res.json(all);
});
app.get('/api/evaluations/:id', (req, res) => {
  const e = store.getEvaluation(req.params.id);
  e ? res.json({ ...e, final_score: finalScore(e) }) : res.status(404).json({ error: 'not found' });
});

function finalScore(ev) {
  let results = ev.results;
  for (const a of store.listAppeals().filter(a=>a.evaluation_id === ev.id && a.status === 'resolved' && a.decision?.action === 'change')) results = replaceAnswer(results, a.criterion_id, a.decision.new_answer);
  return computeScore(store.getChecklist(ev.checklist_id, ev.checklist_version), results);
}

// ---------- appeals ----------
app.get('/api/appeals', (req, res) => {
  let all = store.listAppeals();
  if (req.query.status) all = all.filter((a) => a.status === req.query.status);
  if (req.query.evaluation_id) all = all.filter((a) => a.evaluation_id === req.query.evaluation_id);
  res.json(all);
});
app.post('/api/appeals', (req, res) => {
  const { evaluation_id, criterion_id, comment } = req.body || {};
  const ev = store.getEvaluation(evaluation_id);
  if (!ev) return res.status(404).json({ error: 'evaluation not found' });
  const checklist = store.getChecklist(ev.checklist_id, ev.checklist_version);
  if (!checklist?.criteria.some(c=>c.id === criterion_id) || typeof comment !== 'string' || !comment.trim()) return res.status(400).json({ error: 'Укажите критерий и комментарий' });
  if (store.listAppeals().some(a=>a.evaluation_id === evaluation_id && a.criterion_id === criterion_id && a.status === 'open')) return res.status(409).json({ error: 'По критерию уже есть открытая апелляция' });
  res.json(
    store.saveAppeal({
      id: store.newId('ap'),
      evaluation_id,
      conversation_id: ev.conversation_id,
      criterion_id,
      comment,
      status: 'open',
      created_at: new Date().toISOString(),
    }),
  );
});
app.post('/api/appeals/:id/decision', (req, res) => {
  const ap = store.listAppeals().find((a) => a.id === req.params.id);
  if (!ap) return res.status(404).json({ error: 'not found' });
  if (ap.status !== 'open') return res.status(409).json({ error: 'Решение уже принято' });
  const { action, new_answer, reason } = req.body || {};
  if (!['confirm', 'change'].includes(action) || typeof reason !== 'string' || !reason.trim()) return res.status(400).json({ error: 'action and reason required' });
  const ev = store.getEvaluation(ap.evaluation_id);
  const checklist = store.getChecklist(ev.checklist_id, ev.checklist_version);
  const criterion = checklist.criteria.find(c=>c.id === ap.criterion_id);
  if (action === 'change' && !validAnswer(criterion, new_answer)) return res.status(400).json({ error: 'Ответ не соответствует шкале или правилу N/A' });
  let results = ev.results;
  for (const a of store.listAppeals().filter(a=>a.evaluation_id === ev.id && a.status === 'resolved' && a.decision?.action === 'change')) results = replaceAnswer(results, a.criterion_id, a.decision.new_answer);
  if (action === 'change') results = replaceAnswer(results, ap.criterion_id, new_answer);
  res.json(
    store.saveAppeal({
      ...ap,
      status: 'resolved',
      decision: { action, new_answer: action === 'change' ? new_answer : undefined, reason, decided_at: new Date().toISOString() },
      final_score: computeScore(checklist, results),
    }),
  );
});

// ---------- бизнес-аналитика ----------
app.get('/api/analytics/summary', (req, res) => res.json(analytics.summary(data(), filters(req.query))));
app.get('/api/analytics/operators', (req, res) => res.json(analytics.operators(data(), filters(req.query))));
app.get('/api/analytics/operators/:name', (req, res) => {
  const p = analytics.operatorProfile(data(), req.params.name, filters(req.query));
  p ? res.json(p) : res.status(404).json({ error: 'not found' });
});
app.put('/api/conversations/:id/operator', (req, res) => {
  store.setOperatorOverride(req.params.id, (req.body?.name || '').trim());
  res.json({ ok: true });
});
app.get('/api/alerts', (req, res) => res.json(analytics.alerts(data(), store.getAlertAcks(), filters(req.query))));
app.post('/api/alerts/:evaluationId/ack', (req, res) => res.json(store.ackAlert(req.params.evaluationId, req.body?.note || '')));

// ---------- статика ----------
// Формула общая для бэка и фронта: карточка пересчитывает финальный итог по всем решениям апелляций.
app.get('/shared/scoring.js', (req, res) => res.type('application/javascript').sendFile(path.join(ROOT, 'server', 'scoring.js')));
app.use(express.static(path.join(ROOT, 'web')));

const port = Number(process.env.PORT) || 3000;
if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => console.log(`CQA: http://localhost:${port}`));
}
export default app;
