// Карточка диалога: транскрипт + оценка по критериям, доказательства с подсветкой реплик,
// плеер для звонков, итоги по секциям, исходная оценка / решение по апелляции / финал.
import { api } from '../api.js';
import { esc, scorePill, fmtScore, fmtDate, channelLabel, bar } from '../ui.js';
import { currentGroup, datasetRecords, checklistFor, scores, finalResults, offsets, fmtOffset, answerLabel, answerClass } from '../evalutil.js';

const SPEAKER = { client: 'Клиент', operator: 'Оператор', bot: 'Бот', system: 'Система' };

export async function render(container, params) {
  const id = params.id;
  const group = params.group || currentGroup();
  const versions = await api.checklists(true);

  const [evaluations, record] = await Promise.all([
    api.evaluations(id).catch(() => []),
    loadRecord(id, group),
  ]);
  evaluations.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)); // новые сверху
  const ev = evaluations.find((e) => e.id === (params.ev || params.evaluation)) || evaluations[0] || null;
  const [checklist, appeals] = ev
    ? await Promise.all([checklistFor(ev.checklist_id, ev.checklist_version), api.appeals({ evaluation_id: ev.id }).catch(() => [])])
    : [null, []];

  const transcript = record?.transcript || [];
  const isCall = (record?.channel || ev?.channel) === 'voice call';
  const off = offsets(transcript);
  const s = ev ? scores(ev, checklist, appeals) : null;
  const final = ev ? finalResults(ev, appeals) : [];
  const events = new Map();
  for (const e of ev?.events || []) if (e.index !== null && e.index !== undefined) (events.get(e.index) || events.set(e.index, []).get(e.index)).push(e);

  container.innerHTML = `
    <div class="cqa-page-head">
      <div>
        <a class="cqa-back" href="#/list">← Диалоги</a>
        <h1>${esc(id)}</h1>
        <div class="cqa-muted">${esc(record?.language || ev?.language || '')} · ${channelLabel(record?.channel || ev?.channel)} · ${transcript.length} реплик
          ${ev ? ` · оператор <strong id="cqa-op-name">${esc(operatorName(ev))}</strong> <button class="cqa-btn cqa-btn-small" id="cqa-fix-op" title="Исправить имя оператора">исправить</button>` : ''}</div>
      </div>
      <div class="cqa-filters">
        ${evaluations.length > 1 ? `<label>Оценка <select id="cqa-ev-pick">${evaluations
          .map((e) => `<option value="${esc(e.id)}" ${e.id === ev.id ? 'selected' : ''}>${fmtDate(e.created_at)} · v${e.checklist_version} · ${fmtScore(e.score?.total)}</option>`)
          .join('')}</select></label>` : ''}
        <label>Чек-лист <select id="cqa-checklist-version">${[...versions].reverse().map((c,i)=>`<option value="${versions.length-1-i}">${esc(c.name)} v${c.version}</option>`).join('')}</select></label>
        <button class="cqa-btn" id="cqa-reeval">${ev ? 'Оценить заново' : 'Оценить'}</button>
      </div>
    </div>
    <div id="cqa-reeval-status"></div>
    ${ev ? summary(ev, checklist, s) : '<div class="cqa-card"><p class="cqa-muted">Диалог ещё не оценён. Нажмите «Оценить».</p></div>'}
    <div class="cqa-conv">
      <section class="cqa-card cqa-conv-transcript">
        <h2>Транскрипт</h2>
        ${isCall ? '<div id="cqa-player" class="cqa-player"><span class="cqa-muted">Загрузка аудио…</span></div>' : ''}
        ${record ? '' : '<p class="cqa-error">Транскрипт не загрузился (набор не доступен на бэкенде).</p>'}
        <div class="cqa-transcript" id="cqa-transcript">${transcript.map((m, i) => message(m, i, off[i], isCall, events.get(i))).join('')}</div>
      </section>
      <section class="cqa-conv-eval">
        ${ev && checklist ? criteriaBlock(ev, checklist, s, final) : ev ? '<div class="cqa-card"><p class="cqa-error">Версия чек-листа оценки не найдена.</p></div>' : ''}
      </section>
    </div>`;

  wire(container, { id, group, ev, record, transcript, off, isCall, checklist, appeals, params, versions });
  if (params.msg !== undefined) highlight(container, parseIdx(params.msg), { updateUrl: false });

  // Слот для апелляций (человек 4): если appeals.js экспортирует mountCardAppeals — подключаем в карточку.
  if (ev && checklist) {
    import('./appeals.js')
      .then((m) => m.mountCardAppeals?.({ root: container, evaluation: ev, checklist, appeals, rerender: () => render(container, params) }))
      .catch(() => {});
  }
}

async function loadRecord(id, group) {
  try {
    const r = await api.conversation(id, group);
    if (r?.transcript) return r;
  } catch { /* нет роута — пробуем датасет */ }
  try {
    return datasetRecords(await api.dataset(group)).find((r) => r.conversation_id === id) || null;
  } catch {
    return null;
  }
}

const operatorName = (ev) => ev.operator_name || 'Не определён';
const parseIdx = (v) => String(v).split(/[,-]/).map(Number).filter(Number.isInteger);

// ---------- блоки ----------
function summary(ev, checklist, s) {
  const o = s.original || {};
  const f = s.final || {};
  const manual = f.pending_manual || [];
  const nameOf = (cid) => checklist?.criteria.find((c) => c.id === cid)?.name || cid;
  const resolved = s.appeals.filter((a) => a.status === 'resolved').length;
  const sections = checklist?.sections || [];
  return `
    <div class="cqa-tiles">
      <div class="cqa-tile"><div class="cqa-tile-label">${s.changed ? 'Финальный итог' : 'Итог'}</div>
        <div class="cqa-tile-value">${scorePill(f.total)}</div>
        <div class="cqa-tile-sub">${s.changed ? `исходный ${fmtScore(o.total)} → после апелляций ${fmtScore(f.total)}` : 'из 100'}</div></div>
      <div class="cqa-tile ${f.gross_error ? 'cqa-tile-alert' : ''}"><div class="cqa-tile-label">Грубая ошибка</div>
        <div class="cqa-tile-value">${f.gross_error ? 'Да' : 'Нет'}</div>
        <div class="cqa-tile-sub">${f.gross_error ? (f.gross_criteria || []).map((c) => esc(nameOf(c))).join(', ') : 'на балл не влияет'}</div></div>
      <div class="cqa-tile"><div class="cqa-tile-label">Апелляции</div>
        <div class="cqa-tile-value">${s.appeals.length}</div>
        <div class="cqa-tile-sub">${s.appeals.length ? `решено ${resolved}, открыто ${s.appeals.length - resolved}` : 'не подавались'}</div></div>
      <div class="cqa-tile"><div class="cqa-tile-label">Ручная проверка</div>
        <div class="cqa-tile-value">${manual.length}</div>
        <div class="cqa-tile-sub">${manual.length ? manual.map((c) => esc(nameOf(c))).join(', ') : 'не требуется'}</div></div>
      <div class="cqa-tile"><div class="cqa-tile-label">Модель</div>
        <div class="cqa-tile-value cqa-tile-value-small">${esc(ev.model || '—')}</div>
        <div class="cqa-tile-sub">${ev.cost_usd !== undefined && ev.cost_usd !== null ? `$${Number(ev.cost_usd).toFixed(4)}` : ''}${ev.runs ? ` · прогонов ${ev.runs}` : ''} · ${esc(checklist?.name || ev.checklist_id)} v${ev.checklist_version}</div></div>
    </div>
    ${sections.length ? `<div class="cqa-card"><h2>Итоги по секциям</h2>${sections
      .map((sec) => {
        const so = o.sections?.[sec.id] || {};
        const sf = f.sections?.[sec.id] || {};
        const crit = (checklist.criteria || []).filter((c) => c.section === sec.id);
        if (crit.length && crit.every((c) => c.kind === 'gross')) {
          const hit = crit.filter((c) => (f.gross_criteria || []).includes(c.id));
          return `<div class="cqa-row"><span>${esc(sec.name)}</span><span>${hit.length
            ? `<span class="cqa-tag cqa-tag-gross">нарушение: ${hit.map((c) => esc(c.name)).join(', ')}</span>`
            : '<span class="cqa-muted">нарушений нет</span>'}</span><span></span></div>`;
        }
        const diff = s.changed && so.total !== sf.total ? ` <span class="cqa-muted">(было ${fmtScore(so.total)})</span>` : '';
        return `<div class="cqa-row"><span>${esc(sec.name)}</span>${bar(sf.total)}<span class="cqa-num">${fmtScore(sf.total)}</span>
          <span class="cqa-muted cqa-row-note">вклад в итог ${fmtScore(sf.contribution)} из ${fmtScore(sf.weight_share)}${diff}</span></div>`;
      })
      .join('')}</div>` : ''}`;
}

function message(m, i, offset, isCall, evs = []) {
  const sp = m.speaker || 'system';
  return `<div class="cqa-msg cqa-msg-${esc(sp)}" id="msg-${i}" data-idx="${i}">
    <div class="cqa-msg-meta">
      <span class="cqa-msg-idx">[${i}]</span>
      <span class="cqa-msg-who">${esc(SPEAKER[sp] || sp)}</span>
      <span class="cqa-muted" title="${esc(m.timestamp)}">${esc(shortTs(m.timestamp))}</span>
      ${isCall && offset !== null ? `<button class="cqa-btn cqa-btn-small cqa-seek" data-seek="${offset}" title="Перемотать запись">▶ ${fmtOffset(offset)}</button>` : ''}
      ${evs.map((e) => `<span class="cqa-tag cqa-tag-event" title="${esc(e.type)}">${esc(e.label)}</span>`).join('')}
    </div>
    <div class="cqa-msg-text">${esc(m.text)}</div>
  </div>`;
}

// ISO-метки звонков показываем как время суток, исходная метка в title
const shortTs = (ts) => {
  const m = String(ts || '').match(/T(\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : ts || '';
};

function criteriaBlock(ev, checklist, s, final) {
  const byId = new Map((ev.results || []).map((r) => [r.criterion_id, r]));
  const finalById = new Map(final.map((r) => [r.criterion_id, r.answer]));
  const secs = [...(checklist.sections || [])];
  const orphan = checklist.criteria.filter((c) => !secs.some((x) => x.id === c.section));
  if (orphan.length) secs.push({ id: '__none', name: 'Без секции' });
  return secs
    .map((sec) => {
      const crit = checklist.criteria.filter((c) => (sec.id === '__none' ? orphan.includes(c) : c.section === sec.id));
      if (!crit.length) return '';
      return `<div class="cqa-card cqa-crit-section"><h2>${esc(sec.name)}</h2>${crit
        .map((c) => criterion(c, byId.get(c.id), finalById.get(c.id), s, ev))
        .join('')}</div>`;
    })
    .join('');
}

function criterion(c, r = {}, finalAnswer, s, ev) {
  const orig = r.answer;
  const pcO = s.original?.per_criterion?.[c.id] || {};
  const pcF = s.final?.per_criterion?.[c.id] || {};
  const aps = s.appeals.filter((a) => a.criterion_id === c.id);
  const changed = finalAnswer !== undefined && finalAnswer !== orig;
  const ev_ = r.evidence || [];
  const range = r.checked_range;
  const isNo = c.type === 'yesno' && (c.polarity === 'negative' || c.kind === 'gross' ? orig === 'yes' : orig === 'no');
  const level = c.type === 'scale' ? (c.levels || []).find((l) => Number(l.value) === Number(changed ? finalAnswer : orig)) : null;

  const points = c.kind === 'gross'
    ? '<span class="cqa-muted">грубая ошибка: на балл не влияет</span>'
    : pcF.applicable
      ? `<span title="Баллы в итоге из 100 / эффективный вес">${fmtScore(pcF.points)} из ${fmtScore(pcF.weight_eff)}</span>`
      : '<span class="cqa-muted">не учитывается</span>';

  return `<article class="cqa-crit ${c.kind === 'gross' && (changed ? finalAnswer : orig) === 'yes' ? 'cqa-crit-gross' : ''}" id="crit-${esc(c.id)}" data-criterion="${esc(c.id)}">
    <div class="cqa-crit-head">
      <span class="cqa-ans ${answerClass(c, changed ? finalAnswer : orig)}">${esc(answerLabel(c, changed ? finalAnswer : orig))}</span>
      <strong class="cqa-crit-name" title="${esc(c.description)}">${esc(c.name)}</strong>
      ${c.kind === 'gross' ? '<span class="cqa-tag cqa-tag-gross">грубая</span>' : ''}
      ${c.polarity === 'negative' ? '<span class="cqa-tag cqa-tag-manual" title="«Да» = нарушение">штрафной</span>' : ''}
      <span class="cqa-spacer"></span>
      <span class="cqa-muted">вес ${esc(c.weight)}</span>
      ${points}
    </div>
    ${changed ? `<div class="cqa-crit-change">Исходно: <span class="cqa-ans ${answerClass(c, orig)}">${esc(answerLabel(c, orig))}</span>
       ${pcO.applicable ? `(${fmtScore(pcO.points)} б.)` : ''} → после апелляции: <span class="cqa-ans ${answerClass(c, finalAnswer)}">${esc(answerLabel(c, finalAnswer))}</span></div>` : ''}
    ${level?.description ? `<div class="cqa-muted">Ступень: ${esc(level.description)}</div>` : ''}
    <div class="cqa-crit-expl">${orig === 'na' ? '<b>Причина N/A:</b> ' : ''}${esc(r.explanation || '—')}</div>
    ${orig === 'na' && c.na_condition ? `<div class="cqa-muted">Условие N/A в чек-листе: ${esc(c.na_condition)}</div>` : ''}
    <div class="cqa-crit-foot">
      ${ev_.length ? `<span>Доказательство: ${ev_.map((i) => `<button class="cqa-link" data-goto="${i}">реплика ${i}</button>`).join(', ')}</span>` : '<span class="cqa-muted">Без ссылок на реплики</span>'}
      ${(isNo || orig === 'manual') && Array.isArray(range) && range.length === 2
        ? `<span>Проверен участок: <button class="cqa-link" data-goto-range="${range[0]}-${range[1]}">реплики ${range[0]}–${range[1]}</button></span>` : ''}
      ${r.confidence !== undefined && r.confidence !== null ? `<span class="cqa-muted" title="${r.votes ? esc(Object.entries(r.votes).map(([k, v]) => `${k}: ${v}`).join(', ')) : 'Доля прогонов с этим ответом'}">уверенность ${Math.round(r.confidence * 100)}%</span>` : ''}
    </div>
    ${aps.map((a) => appealView(c, a)).join('')}
    <div class="cqa-appeal-slot" data-criterion="${esc(c.id)}" data-evaluation="${esc(ev.id)}"></div>
  </article>`;
}

function appealView(c, a) {
  const d = a.decision;
  return `<div class="cqa-appeal ${a.status === 'open' ? 'cqa-appeal-open' : ''}">
    <div><b>Апелляция</b> <span class="cqa-muted">${fmtDate(a.created_at)}</span>: ${esc(a.comment)}</div>
    ${d
      ? `<div><b>Решение:</b> ${d.action === 'change'
          ? `оценка изменена на <span class="cqa-ans ${answerClass(c, d.new_answer)}">${esc(answerLabel(c, d.new_answer))}</span>`
          : 'оценка подтверждена'} — ${esc(d.reason)} <span class="cqa-muted">${fmtDate(d.decided_at)}</span></div>`
      : '<div class="cqa-muted">Ожидает решения проверяющего</div>'}
  </div>`;
}

// ---------- поведение ----------
function highlight(container, indices, { updateUrl = true } = {}) {
  container.querySelectorAll('.cqa-msg.cqa-highlight').forEach((el) => el.classList.remove('cqa-highlight'));
  const els = indices.map((i) => container.querySelector(`#msg-${i}`)).filter(Boolean);
  els.forEach((el) => el.classList.add('cqa-highlight'));
  if (els[0]) scrollToMsg(container, els[0]);
  if (updateUrl && indices.length) {
    // меняем ?msg без перерисовки экрана (replaceState не вызывает hashchange)
    const [path, q = ''] = location.hash.split('?');
    const p = new URLSearchParams(q);
    p.set('msg', indices.length > 1 ? `${indices[0]}-${indices[indices.length - 1]}` : String(indices[0]));
    history.replaceState(null, '', `${path}?${p}`);
  }
  return els[0];
}

// Прокручиваем только ленту транскрипта (она sticky), чтобы колонка оценки не прыгала.
function scrollToMsg(container, el) {
  const box = container.querySelector('#cqa-transcript');
  if (box && box.scrollHeight > box.clientHeight + 1) {
    const b = box.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    box.scrollTo({ top: box.scrollTop + (r.top - b.top) - box.clientHeight / 2 + r.height / 2, behavior: 'smooth' });
    if (b.top < 0 || b.bottom > innerHeight) box.scrollIntoView({ block: 'nearest' });
  } else el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function wire(container, ctx) {
  const { id, group, ev, record, off, isCall, params } = ctx;
  let audio = null;

  container.querySelector('#cqa-ev-pick')?.addEventListener('change', (e) => {
    location.hash = `#/conv/${encodeURIComponent(id)}?ev=${encodeURIComponent(e.target.value)}`;
  });

  container.querySelector('#cqa-fix-op')?.addEventListener('click', async () => {
    const name = prompt('Имя оператора (пусто — вернуть имя из оценки):', ev.operator_name || '');
    if (name === null) return;
    await api.setOperator(id, name);
    container.querySelector('#cqa-op-name').textContent = name.trim() || operatorName(ev);
  });

  container.querySelector('#cqa-reeval').addEventListener('click', async (e) => {
    const btn = e.target;
    const st = container.querySelector('#cqa-reeval-status');
    btn.disabled = true;
    try {
      const cl = ctx.versions[container.querySelector('#cqa-checklist-version').value];
      st.innerHTML = `<div class="cqa-card cqa-job">Оцениваю по «${esc(cl?.name)}» v${cl?.version}…</div>`;
      const res = await api.evaluate({ conversation_ids: [id], group_id: ev?.group_id || group, checklist_id: cl?.id, checklist_version: cl?.version });
      if (res.errors?.length) throw new Error(res.errors.map(e=>e.error).join('; '));
      let next = res.evaluations?.[0]?.id;
      const jobId = res.job_id || res.id || res.job?.id;
      if (jobId) {
        for (;;) {
          await new Promise((r) => setTimeout(r, 1500));
          const j = await api.job(jobId);
          if (['done', 'finished', 'completed', 'error', 'failed'].includes(j.status)) {
            if (['error', 'failed'].includes(j.status) || (j.errors || []).length) throw new Error(j.error || JSON.stringify(j.errors?.[0] || j.status));
            next = j.evaluation_ids?.[0] || next;
            break;
          }
        }
      }
      location.hash = `#/conv/${encodeURIComponent(id)}?group=${encodeURIComponent(group)}${next ? '&ev='+encodeURIComponent(next) : ''}`;
    } catch (err) {
      st.innerHTML = `<div class="cqa-card cqa-job"><span class="cqa-error">Оценка не удалась: ${esc(err.message)}</span></div>`;
      btn.disabled = false;
    }
  });

  // клик по доказательству → прокрутка к реплике и подсветка; у звонка — ещё и перемотка плеера
  container.addEventListener('click', (e) => {
    const g = e.target.closest('[data-goto], [data-goto-range]');
    if (g) {
      let idx;
      if (g.dataset.gotoRange) {
        const [a, b] = g.dataset.gotoRange.split('-').map(Number);
        idx = Array.from({ length: Math.max(0, b - a + 1) }, (_, k) => a + k);
      } else idx = [Number(g.dataset.goto)];
      highlight(container, idx);
      if (isCall && audio && off[idx[0]] !== null && off[idx[0]] !== undefined) audio.currentTime = off[idx[0]];
      return;
    }
    const seek = e.target.closest('[data-seek]');
    if (seek && audio) {
      audio.currentTime = Number(seek.dataset.seek);
      audio.play().catch(() => {});
      highlight(container, [Number(seek.closest('.cqa-msg').dataset.idx)]);
    }
  });

  if (isCall) {
    const box = container.querySelector('#cqa-player');
    let retried = false;
    const load = async () => {
      try {
        const { src } = await api.audio(id, ev?.group_id || group);
        if (!src) throw new Error('нет src');
        const t = audio?.currentTime || 0;
        box.innerHTML = '<audio controls preload="metadata"></audio>';
        audio = box.querySelector('audio');
        audio.src = src;
        if (t) audio.currentTime = t;
        // SAS-ссылка живёт ~1 час: при ошибке один раз берём свежую
        audio.addEventListener('error', () => { if (!retried) { retried = true; load(); } else fallback(); });
        if (params.msg !== undefined) {
          const i = parseIdx(params.msg)[0];
          audio.addEventListener('loadedmetadata', () => { if (off[i] !== null && off[i] !== undefined) audio.currentTime = off[i]; }, { once: true });
        }
        syncWithAudio(container, audio, off);
      } catch {
        fallback();
      }
    };
    const fallback = () => {
      box.innerHTML = record?.audio_url
        ? `<a class="cqa-btn cqa-btn-small" href="${esc(record.audio_url)}" target="_blank" rel="noopener">Открыть плеер</a>
           <span class="cqa-muted">Аудио не встроилось; перемотка по репликам недоступна.</span>`
        : '<span class="cqa-muted">Аудиозаписи нет.</span>';
      audio = null;
    };
    if (record?.audio_url || ev) load();
    else fallback();
  }
}

// во время воспроизведения отмечаем текущую реплику (без прокрутки, чтобы не мешать чтению)
function syncWithAudio(container, audio, off) {
  let cur = -1;
  audio.addEventListener('timeupdate', () => {
    const t = audio.currentTime;
    let i = -1;
    for (let k = 0; k < off.length; k++) if (off[k] !== null && off[k] <= t) i = k;
    if (i === cur) return;
    container.querySelector('.cqa-msg-playing')?.classList.remove('cqa-msg-playing');
    container.querySelector(`#msg-${i}`)?.classList.add('cqa-msg-playing');
    cur = i;
  });
}
