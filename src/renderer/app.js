// UI logic: renders the download list and wires buttons to window.api (see preload.js).
const $ = (sel) => document.querySelector(sel);

const ICONS = {
  pause: '<path d="M8 5v14M16 5v14"/>',
  resume: '<path d="M7 4.5v15l12-7.5z"/>',
  cancel: '<path d="M6 6l12 12M18 6 6 18"/>',
  remove: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  openFile: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5"/>',
  openFolder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
};
const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

const state = { settings: null, list: [], filter: 'all', rows: new Map() };
const t = () => window.I18N[state.settings.lang] || window.I18N.ar;

// ---------- language & theme ----------
function applyLanguage() {
  const tr = t();
  document.documentElement.lang = state.settings.lang;
  document.documentElement.dir = tr.dir;
  document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = tr[el.dataset.i18n]));
  document.querySelectorAll('[data-i18n-title]').forEach((el) => (el.title = tr[el.dataset.i18nTitle]));
  document
    .querySelectorAll('[data-i18n-placeholder]')
    .forEach((el) => (el.placeholder = tr[el.dataset.i18nPlaceholder]));
  // Rebuild rows so per-row labels/tooltips switch language too.
  state.rows.forEach((r) => r.el.remove());
  state.rows.clear();
  render();
}

function effectiveTheme() {
  const s = state.settings.theme;
  if (s === 'light' || s === 'dark') return s;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme() {
  const theme = effectiveTheme();
  document.documentElement.dataset.theme = theme;
  $('#btn-theme').innerHTML = svg(theme === 'dark' ? 'sun' : 'moon');
}

// ---------- list rendering ----------
function matchesFilter(d) {
  switch (state.filter) {
    case 'active':
      return d.status === 'active' || d.status === 'waiting';
    case 'complete':
      return d.status === 'complete';
    case 'stopped':
      return ['paused', 'error', 'removed'].includes(d.status);
    default:
      return true;
  }
}

function actionsFor(d) {
  const a = [];
  if (d.status === 'active' || d.status === 'waiting') a.push('pause', 'cancel');
  if (['paused', 'error', 'removed'].includes(d.status)) a.push('resume');
  if (d.status === 'paused') a.push('cancel');
  if (d.status === 'complete') a.push('openFile');
  a.push('openFolder', 'remove');
  return a;
}

function createRow(d) {
  const el = document.createElement('tr');
  el.innerHTML = `
    <td class="c-name"><div class="name" dir="auto"></div><div class="url" dir="ltr"></div></td>
    <td class="c-size num"></td>
    <td class="c-progress"><div class="bar"><span></span></div><div class="pct num"></div></td>
    <td class="c-speed num"></td>
    <td class="c-eta num"></td>
    <td class="c-status"><span class="badge"></span></td>
    <td class="c-actions"></td>`;
  el.querySelector('.c-actions').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (btn) onAction(btn.dataset.act, el.dataset.gid);
  });
  el.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    const item = state.list.find((x) => x.gid === el.dataset.gid);
    if (item && item.status === 'complete') window.api.openFile(item.gid);
  });
  return { el, actionsKey: '' };
}

function updateRow(row, d) {
  const tr = t();
  const { el } = row;
  el.dataset.gid = d.gid;
  el.dataset.status = d.status;
  const pct = d.totalLength > 0 ? (d.completedLength / d.totalLength) * 100 : d.status === 'complete' ? 100 : 0;
  const live = d.status === 'active';

  el.querySelector('.name').textContent = d.name;
  el.querySelector('.name').title = d.path || d.name;
  el.querySelector('.url').textContent = d.url;
  el.querySelector('.c-size').textContent = Format.bytes(d.totalLength, tr);
  el.querySelector('.bar span').style.width = `${pct.toFixed(1)}%`;
  el.querySelector('.pct').textContent = `${pct.toFixed(1)}%`;
  el.querySelector('.c-speed').textContent = live ? Format.speed(d.downloadSpeed, tr) : '—';
  el.querySelector('.c-eta').textContent = live
    ? Format.eta(d.totalLength - d.completedLength, d.downloadSpeed, tr)
    : '—';
  const badge = el.querySelector('.badge');
  badge.textContent = tr.st[d.status] || d.status;
  badge.title = d.status === 'error' ? d.errorMessage || '' : live ? `${d.connections || 0} ⇅` : '';

  const acts = actionsFor(d);
  const key = acts.join(',');
  if (row.actionsKey !== key) {
    row.actionsKey = key;
    el.querySelector('.c-actions').innerHTML = acts
      .map((a) => `<button class="btn icon sm ${a === 'remove' ? 'danger-ghost' : ''}" data-act="${a}" title="${tr.act[a]}" aria-label="${tr.act[a]}">${svg(a)}</button>`)
      .join('');
  }
}

function render() {
  const tbody = $('#rows');
  const visible = state.list.filter(matchesFilter);
  const keep = new Set(visible.map((d) => d.gid));
  for (const [gid, row] of state.rows) {
    if (!keep.has(gid)) {
      row.el.remove();
      state.rows.delete(gid);
    }
  }
  visible.forEach((d, i) => {
    let row = state.rows.get(d.gid);
    if (!row) {
      row = createRow(d);
      state.rows.set(d.gid, row);
    }
    updateRow(row, d);
    if (tbody.children[i] !== row.el) tbody.insertBefore(row.el, tbody.children[i] || null);
  });
  $('#empty').hidden = state.list.length > 0;
  const total = state.list.reduce((s, d) => s + (d.status === 'active' ? d.downloadSpeed : 0), 0);
  $('#summary').textContent = state.list.length ? t().summary(state.list.length, Format.speed(total, t())) : '';
}

// ---------- actions ----------
async function onAction(act, gid) {
  const d = state.list.find((x) => x.gid === gid);
  if (!d) return;
  switch (act) {
    case 'pause':
      return window.api.pause(gid);
    case 'resume':
      return window.api.resume(gid);
    case 'cancel':
      return window.api.cancel(gid);
    case 'openFile':
      return window.api.openFile(gid);
    case 'openFolder':
      return window.api.openFolder(gid);
    case 'remove': {
      const dlg = $('#dlg-remove');
      $('#remove-name').textContent = d.name;
      $('#in-delete-file').checked = false;
      dlg.returnValue = '';
      dlg.showModal();
      dlg.addEventListener(
        'close',
        () => {
          if (dlg.returnValue === 'ok') window.api.remove(gid, $('#in-delete-file').checked);
        },
        { once: true }
      );
    }
  }
}

function openAddDialog(prefillUrl = '') {
  $('#in-url').value = prefillUrl;
  $('#in-name').value = '';
  $('#in-dir').value = state.settings.downloadDir;
  $('#in-split').value = state.settings.split;
  $('#out-split').textContent = state.settings.split;
  $('#add-error').textContent = '';
  $('#dlg-add').showModal();
  $('#in-url').focus();
}

function isValidUrl(s) {
  try {
    return ['http:', 'https:', 'ftp:', 'sftp:'].includes(new URL(s).protocol);
  } catch {
    return false;
  }
}

async function submitAdd(e) {
  e.preventDefault();
  const url = $('#in-url').value.trim();
  if (!isValidUrl(url)) {
    $('#add-error').textContent = t().badUrl;
    return;
  }
  const dir = $('#in-dir').value.trim();
  const split = Number($('#in-split').value);
  try {
    await window.api.add({ url, dir, out: $('#in-name').value.trim(), split });
    // Remember the last folder and connection count as the new defaults.
    state.settings = await window.api.setSettings({ downloadDir: dir, split });
    $('#dlg-add').close();
  } catch (err) {
    $('#add-error').textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
}

// ---------- startup ----------
async function init() {
  state.settings = await window.api.getSettings();
  applyTheme();
  applyLanguage();

  $('#btn-add').onclick = () => openAddDialog();
  $('#btn-add-empty').onclick = () => openAddDialog();
  $('#btn-pause-all').onclick = () => window.api.pauseAll();
  $('#btn-resume-all').onclick = () => window.api.resumeAll();
  $('#btn-lang').onclick = async () => {
    state.settings = await window.api.setSettings({ lang: state.settings.lang === 'ar' ? 'en' : 'ar' });
    applyLanguage();
  };
  $('#btn-theme').onclick = async () => {
    state.settings = await window.api.setSettings({ theme: effectiveTheme() === 'dark' ? 'light' : 'dark' });
    applyTheme();
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  $('#filters').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-filter]');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
    render();
  });

  $('#form-add').addEventListener('submit', submitAdd);
  $('#btn-add-cancel').onclick = () => $('#dlg-add').close();
  $('#in-split').oninput = (e) => ($('#out-split').textContent = e.target.value);
  $('#btn-browse').onclick = async () => {
    const dir = await window.api.chooseDir($('#in-dir').value);
    if (dir) $('#in-dir').value = dir;
  };

  // Ctrl+V anywhere (outside inputs) opens the add dialog with the pasted link.
  document.addEventListener('paste', (e) => {
    if (e.target.closest('input, textarea') || $('#dlg-add').open) return;
    const text = (e.clipboardData.getData('text') || '').trim();
    if (isValidUrl(text)) openAddDialog(text);
  });

  window.api.onDownloads((list) => {
    state.list = list;
    render();
  });
}

init();
