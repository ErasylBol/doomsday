import { api } from '../api.js';
import { esc, scorePill } from '../ui.js';
import { currentRole } from '../app.js';

export async function render(container) {
  const role = currentRole();
  const appeals = await api.appeals(role === 'reviewer' ? { status: 'open' } : {});
  const evaluations = new Map();
  await Promise.all(appeals.map(async a => { try { evaluations.set(a.evaluation_id, await api.evaluation(a.evaluation_id)); } catch {} }));
  container.innerHTML = `<div class="cqa-page-head"><h1>Апелляции</h1><span class="cqa-muted">Режим: ${role === 'reviewer' ? 'очередь проверяющего' : 'мои апелляции'}</span></div>${appeals.length ? appeals.map(a => card(a, evaluations.get(a.evaluation_id), role)).join('') : '<section class="cqa-card"><p class="cqa-muted">Апелляций пока нет.</p></section>'}`;
  container.querySelectorAll('[data-decide]').forEach(form => form.addEventListener('submit', async e => { e.preventDefault(); const fd = new FormData(form); await api.decideAppeal(form.dataset.decide, { action: fd.get('action'), new_answer: fd.get('new_answer') || undefined, reason: fd.get('reason') }); await render(container); }));
}
function card(a, ev, role) { const result = ev?.results?.find(r => r.criterion_id === a.criterion_id); return `<section class="cqa-card cqa-appeal"><div class="cqa-page-head"><h2>${esc(a.conversation_id)} · критерий ${esc(a.criterion_id)}</h2><span class="cqa-tag ${a.status==='open'?'cqa-tag-open':'cqa-tag-resolved'}">${a.status==='open'?'Открыта':'Решена'}</span></div><p>${esc(a.comment)}</p><p class="cqa-muted">Исходный ответ: <strong>${esc(String(result?.answer ?? '—'))}</strong> · итог: ${scorePill(ev?.score?.total)}</p>${a.decision ? `<p><strong>Решение:</strong> ${a.decision.action === 'change' ? `изменить на ${esc(String(a.decision.new_answer))}` : 'подтвердить'} — ${esc(a.decision.reason)}</p>` : role === 'reviewer' ? `<form class="cqa-decision" data-decide="${esc(a.id)}"><label>Решение <select name="action"><option value="confirm">Подтвердить</option><option value="change">Изменить</option></select></label><label>Новый ответ <input class="cqa-input" name="new_answer" placeholder="yes / no / na / число"></label><textarea class="cqa-input" name="reason" required placeholder="Причина решения"></textarea><button class="cqa-btn" type="submit">Сохранить решение</button></form>` : ''}</section>`; }
