import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import * as analytics from './analytics.js';
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
  if (!c?.criteria?.length) return res.status(400).json({ error: 'criteria required' });
  res.json(store.saveChecklistVersion(c));
});

// ---------- evaluations (POST /api/evaluate делает задача C) ----------
app.get('/api/evaluations', (req, res) => {
  let all = store.listEvaluations();
  if (req.query.conversation_id) all = all.filter((e) => e.conversation_id === req.query.conversation_id);
  res.json(all);
});
app.get('/api/evaluations/:id', (req, res) => {
  const e = store.getEvaluation(req.params.id);
  e ? res.json(e) : res.status(404).json({ error: 'not found' });
});

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
  if (!criterion_id || !comment) return res.status(400).json({ error: 'criterion_id and comment required' });
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
  const { action, new_answer, reason } = req.body || {};
  if (!['confirm', 'change'].includes(action) || !reason) return res.status(400).json({ error: 'action and reason required' });
  const ev = store.getEvaluation(ap.evaluation_id);
  const checklist = store.getChecklist(ev.checklist_id, ev.checklist_version);
  const results = action === 'change' ? replaceAnswer(ev.results, ap.criterion_id, new_answer) : ev.results;
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
