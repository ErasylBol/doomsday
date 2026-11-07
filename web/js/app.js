// Hash-роутер. Каждый экран — модуль с render(container, params).
import { api } from './api.js';

const routes = [
  { re: /^#\/dashboard$/, view: 'dashboard' },
  { re: /^#\/operators$/, view: 'operators' },
  { re: /^#\/operators\/(.+)$/, view: 'operator', params: (m) => ({ name: decodeURIComponent(m[1]) }) },
  { re: /^#\/alerts$/, view: 'alerts' },
  // экраны тиммейтов (задачи D и E); пока нет модуля — показываем заглушку
  { re: /^#\/list$/, view: 'list' },
  { re: /^#\/conv\/(.+)$/, view: 'conversation', params: (m) => ({ id: decodeURIComponent(m[1]) }) },
  { re: /^#\/checklists$/, view: 'checklists' },
  { re: /^#\/appeals$/, view: 'appeals' },
];

const root = document.getElementById('cqa-app');

async function route() {
  // #/conv/p1-ru-001?msg=5 → путь + query-параметры (msg — индекс реплики для подсветки)
  const [hash, query = ''] = (location.hash || '#/dashboard').split('?');
  const r = routes.find((x) => x.re.test(hash)) || routes[0];
  const m = hash.match(r.re) || [];
  const params = { ...Object.fromEntries(new URLSearchParams(query)), ...(r.params ? r.params(m) : {}) };
  document.querySelectorAll('#cqa-nav a').forEach((a) => {
    a.classList.toggle('cqa-active', hash === a.getAttribute('href') || hash.startsWith(a.getAttribute('href') + '/'));
  });
  root.innerHTML = '<p class="cqa-muted">Загрузка…</p>';
  try {
    const mod = await import(`./views/${r.view}.js`);
    await mod.render(root, params);
  } catch (e) {
    if (String(e.message).includes('Failed to fetch dynamically imported module') || String(e.message).includes('Importing a module script failed')) {
      root.innerHTML = '<p class="cqa-muted">Экран в разработке.</p>';
    } else {
      root.innerHTML = `<p class="cqa-error">Ошибка: ${e.message}</p>`;
    }
  }
  refreshAlertBadge();
}

export async function refreshAlertBadge() {
  try {
    const n = (await api.alerts()).filter((a) => !a.acked).length;
    const b = document.getElementById('cqa-alert-count');
    b.textContent = n;
    b.hidden = n === 0;
  } catch {
    /* бейдж не критичен */
  }
}

window.addEventListener('hashchange', route);
route();
