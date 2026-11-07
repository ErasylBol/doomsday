import { api } from '../api.js';
import { esc, fmtDate } from '../ui.js';

export async function render(root) {
  const versions = await api.checklists(true);
  let draft = structuredClone(versions.at(-1));
  let notice = '';
  const input = (name, value, type = 'text', extra = '') => `<input class="cqa-input" name="${name}" type="${type}" value="${esc(value)}" ${extra}>`;
  function draw() {
    root.innerHTML = `<h1>Редактор чек-листа</h1><label>Сохранённые версии <select id="versions" class="cqa-input">${versions.map((v,i) => `<option value="${i}" ${v.id === draft.id && v.version === draft.version ? 'selected' : ''}>${esc(v.name)} · v${v.version} · ${esc(fmtDate(v.created_at))}</option>`).join('')}</select></label>
    <p role="status">${esc(notice)}</p><form id="editor"><label>Название ${input('name', draft.name, 'text', 'required')}</label><div id="criteria">${draft.criteria.map((c,i) => `<fieldset class="cqa-card" data-index="${i}"><legend>${esc(c.id)}</legend><div class="cqa-form-grid">
    <label>ID ${input('id',c.id,'text','required')}</label><label>Название ${input('name',c.name,'text','required')}</label>
    <label>Формулировка <textarea class="cqa-input" name="description" required>${esc(c.description)}</textarea></label>
    <label>Тип <select name="type" class="cqa-input"><option value="yesno" ${c.type==='yesno'?'selected':''}>Да / Нет</option><option value="scale" ${c.type==='scale'?'selected':''}>Шкала</option></select></label>
    <label>Секция <select class="cqa-input" name="section">${draft.sections.map(s=>`<option value="${esc(s.id)}" ${s.id===c.section?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label>
    <label>Вес ${input('weight',c.weight,'number','min="0" step="any" required')}</label>
    <label>Polarity <select name="polarity" class="cqa-input"><option value="positive">Да = выполнено</option><option value="negative" ${c.polarity==='negative'?'selected':''}>Да = нарушение</option></select></label>
    <label>Вид <select name="kind" class="cqa-input"><option value="normal">Обычный</option><option value="gross" ${c.kind==='gross'?'selected':''}>Грубая ошибка</option></select></label>
    <label><input name="na_allowed" type="checkbox" ${c.na_allowed?'checked':''}> N/A разрешён</label>
    <label>Условие N/A ${input('na_condition',c.na_condition)}</label>
    <label>Ступени: одна строка «балл | описание»<textarea class="cqa-input" name="levels" rows="5">${esc((c.levels||[]).map(l=>`${l.value} | ${l.description}`).join('\n'))}</textarea></label>
    </div><button type="button" class="cqa-btn cqa-btn-small" data-remove="${i}">Удалить критерий</button></fieldset>`).join('')}</div>
    <button type="button" class="cqa-btn" id="add">Добавить критерий</button> <button class="cqa-btn" type="submit">Сохранить как новую версию</button><p class="cqa-error" role="alert" id="error"></p></form>`;
    const form = root.querySelector('form');
    function capture() {
      draft.name = form.querySelector(':scope > label input').value.trim();
      draft.criteria = [...form.querySelectorAll('fieldset')].map(el => {
        const d = new FormData();
        for (const e of el.querySelectorAll('[name]')) d.set(e.name, e.type==='checkbox' ? e.checked : e.value);
        const c = {...draft.criteria[Number(el.dataset.index)], ...Object.fromEntries(d)};
        c.weight = Number(c.weight); c.na_allowed = c.na_allowed === 'true';
        c.levels = c.type === 'scale' ? c.levels.split('\n').filter(x=>x.trim()).map(line=> { const at=line.indexOf('|'); return {value:at<0?NaN:Number(line.slice(0,at).trim()),description:line.slice(at+1).trim()}; }) : [];
        return c;
      });
    }
    root.querySelector('#versions').onchange = e => { draft=structuredClone(versions[e.target.value]); notice=''; draw(); };
    root.querySelector('#add').onclick = () => { capture(); draft.criteria.push({id:'c_'+Date.now().toString(36),name:'Новый критерий',description:'',section:draft.sections[0]?.id,type:'yesno',weight:10,kind:'normal',na_allowed:false,na_condition:''}); draw(); };
    root.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{capture();draft.criteria.splice(Number(b.dataset.remove),1);draw();});
    form.onsubmit = async e => {
      e.preventDefault(); capture(); const button=form.querySelector('[type=submit]'); button.disabled=true;
      try {
        const saved=await api.saveChecklist(draft); versions.push(saved); draft=structuredClone(saved); notice=`Сохранена версия ${saved.version}. Предыдущие версии доступны в списке.`; draw();
      } catch(e) { root.querySelector('#error').textContent=e.message; button.disabled=false; }
    };
  }
  draw();
}
