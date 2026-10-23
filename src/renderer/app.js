// UI logic: renders the download list and wires buttons to window.api (see preload.js).
const $ = (sel) => document.querySelector(sel);

const ICONS = {
  pause: '<path d="M8 5v14M16 5v14"/>',
  resume: '<path d="M7 4.5v15l12-7.5z"/>',
  cancel: '<path d="M6 6l12 12M18 6 6 18"/>',
  remove: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  openFile: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5"/>',
  openFolder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
};
const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

const state = { settings: null, list: [], filter: 'all', rows: new Map() };
const t = () => window.I18N[state.settings.lang] || window.I18N.ar;
const lookup = (obj, key) => key.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
const isRunning = (d) => d.status === 'active' || d.status === 'waiting';
const isStopped = (d) => ['paused', 'error', 'removed'].includes(d.status);

// ---------- language & theme ----------
function applyLanguage() {
  const tr = t();
  document.documentElement.lang = state.settings.lang;
  document.documentElement.dir = tr.dir;
  document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = lookup(tr, el.dataset.i18n)));
  document.querySelectorAll('[data-i18n-title]').forEach((el) => (el.title = lookup(tr, el.dataset.i18nTitle)));
  document
    .querySelectorAll('[data-i18n-placeholder]')
    .forEach((el) => (el.placeholder = lookup(tr, el.dataset.i18nPlaceholder)));
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
    case 'all':
      return true;
    case 'active':
      return isRunning(d);
    case 'complete':
      return d.status === 'complete';
    case 'stopped':
      return isStopped(d);
    default:
      return d.category === state.filter; // category chips
  }
}

/** The always-visible buttons on a row; everything else is in the "more" menu. */
function quickActions(d) {
  const a = [];
  if (isRunning(d)) a.push('pause');
  if (isStopped(d)) a.push('resume');
  if (d.status === 'complete') a.push('openFile');
  a.push('openFolder', 'more');
  return a;
}

function createRow() {
  const el = document.createElement('tr');
  el.innerHTML = `
    <td class="c-name"><div class="name" dir="auto"></div><div class="url" dir="ltr"></div></td>
    <td class="c-size num"></td>
    <td class="c-progress"><div class="bar"><span></span></div><div class="pct num"></div></td>
    <td class="c-speed num"><div class="spd"></div><div class="lim"></div></td>
    <td class="c-eta num"></td>
    <td class="c-status"><span class="badge"></span><div class="sub"></div></td>
    <td class="c-actions"></td>`;
  el.querySelector('.c-actions').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'more') showRowMenu(el.dataset.gid);
    else onAction(btn.dataset.act, el.dataset.gid);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showRowMenu(el.dataset.gid);
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
  el.querySelector('.spd').textContent = live ? Format.speed(d.downloadSpeed, tr) : '—';
  el.querySelector('.lim').textContent =
    d.speedLimit > 0 && d.status !== 'complete' ? tr.limited(Format.speed(d.speedLimit * 1024, tr)) : '';
  el.querySelector('.c-eta').textContent = live
    ? Format.eta(d.totalLength - d.completedLength, d.downloadSpeed, tr)
    : '—';

  const badge = el.querySelector('.badge');
  badge.textContent = tr.st[d.status] || d.status;
  badge.title = d.status === 'error' ? d.errorMessage || '' : live ? `${d.connections || 0} ⇅` : '';
  let sub = '';
  if (d.status === 'error' && d.retryAt > Date.now()) {
    sub = tr.retryIn(Math.ceil((d.retryAt - Date.now()) / 1000), (d.retries || 0) + 1, state.settings.retryMax);
  } else if (d.status === 'error') {
    sub = d.errorMessage || '';
  } else if (d.status === 'waiting' && d.queuePos) {
    sub = tr.queuePos(d.queuePos);
  }
  const subEl = el.querySelector('.sub');
  subEl.textContent = sub;
  subEl.title = sub;

  const acts = quickActions(d);
  const key = acts.join(',');
  if (row.actionsKey !== key) {
    row.actionsKey = key;
    el.querySelector('.c-actions').innerHTML = acts
      .map((a) => `<button class="btn icon sm" data-act="${a}" title="${tr.act[a]}" aria-label="${tr.act[a]}">${svg(a)}</button>`)
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
      row = createRow();
      state.rows.set(d.gid, row);
    }
    updateRow(row, d);
    if (tbody.children[i] !== row.el) tbody.insertBefore(row.el, tbody.children[i] || null);
  });
  $('#empty').hidden = state.list.length > 0;
  const total = state.list.reduce((s, d) => s + (d.status === 'active' ? d.downloadSpeed : 0), 0);
  let summary = state.list.length ? t().summary(state.list.length, Format.speed(total, t())) : '';
  if (state.settings.speedLimit > 0) summary += ` · ${t().limited(Format.speed(state.settings.speedLimit * 1024, t()))}`;
  $('#summary').textContent = summary;
}

// ---------- row actions ----------
async function showRowMenu(gid) {
  const d = state.list.find((x) => x.gid === gid);
  if (!d) return;
  const a = t().act;
  const items = [];
  if (isRunning(d)) items.push({ id: 'pause', label: a.pause });
  if (isStopped(d)) items.push({ id: 'resume', label: a.resume });
  if (isRunning(d) || d.status === 'paused' || d.status === 'error') items.push({ id: 'cancel', label: a.cancel });
  if (d.status !== 'complete') items.push({ id: 'limit', label: a.limit });
  if (d.status === 'waiting') {
    items.push({ type: 'separator' }, { id: 'top', label: a.top }, { id: 'up', label: a.up }, { id: 'down', label: a.down });
  }
  items.push({ type: 'separator' });
  if (d.status === 'complete') items.push({ id: 'openFile', label: a.openFile });
  items.push({ id: 'openFolder', label: a.openFolder }, { id: 'copy', label: a.copy });
  items.push({ type: 'separator' }, { id: 'remove', label: a.remove });
  const chosen = await window.api.popupMenu(items);
  if (chosen) onAction(chosen, gid);
}

function confirmDialog(dlg, onOk) {
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener('close', () => dlg.returnValue === 'ok' && onOk(), { once: true });
}

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
    case 'copy':
      return window.api.copyText(d.url);
    case 'top':
      return window.api.move(gid, 'top');
    case 'up':
      return window.api.move(gid, -1);
    case 'down':
      return window.api.move(gid, 1);
    case 'limit':
      $('#limit-name').textContent = d.name;
      $('#in-item-limit').value = d.speedLimit || 0;
      return confirmDialog($('#dlg-limit'), () => window.api.setLimit(gid, Number($('#in-item-limit').value) || 0));
    case 'remove':
      $('#remove-name').textContent = d.name;
      $('#in-delete-file').checked = false;
      return confirmDialog($('#dlg-remove'), () => window.api.remove(gid, $('#in-delete-file').checked));
  }
}

// ---------- add dialog ----------
const add = { probeSeq: 0, probeTimer: null, nameTouched: false, dirTouched: false, category: null };

function isValidUrl(s) {
  try {
    return ['http:', 'https:', 'ftp:', 'sftp:'].includes(new URL(s).protocol);
  } catch {
    return false;
  }
}

function openAddDialog(prefillUrl = '') {
  const dlg = $('#dlg-add');
  if (dlg.open) {
    // Already open: just put the new link in.
    if (prefillUrl) {
      $('#in-url').value = prefillUrl;
      scheduleProbe(0);
    }
    return;
  }
  Object.assign(add, { nameTouched: false, dirTouched: false, category: null });
  $('#in-url').value = prefillUrl;
  $('#in-name').value = '';
  $('#in-dir').value = state.settings.downloadDir;
  $('#in-split').value = state.settings.split;
  $('#out-split').textContent = state.settings.split;
  $('#in-limit').value = 0;
  $('#add-error').textContent = '';
  $('#probe-info').hidden = true;
  dlg.showModal();
  $('#in-url').focus();
  if (prefillUrl) scheduleProbe(0);
}

function scheduleProbe(delay = 500) {
  clearTimeout(add.probeTimer);
  add.probeTimer = setTimeout(runProbe, delay);
}

async function runProbe() {
  const url = $('#in-url').value.trim();
  const info = $('#probe-info');
  if (!isValidUrl(url)) {
    info.hidden = true;
    return;
  }
  const seq = ++add.probeSeq;
  const tr = t();
  info.hidden = false;
  info.className = 'probe loading';
  info.textContent = tr.probing;
  const r = await window.api.probe(url);
  if (seq !== add.probeSeq) return; // a newer link was typed meanwhile
  add.category = r.category;
  if (!add.nameTouched && r.ok) $('#in-name').value = r.name;
  if (!add.dirTouched) $('#in-dir').value = r.dir;
  if (!r.ok) {
    info.className = 'probe warn';
    info.textContent = `${tr.probeFail} (${r.error})`;
    return;
  }
  info.className = 'probe';
  const parts = [r.size > 0 ? Format.bytes(r.size, tr) : tr.unknownSize];
  if (r.category) parts.push(tr.cat[r.category]);
  parts.push(r.resumable ? tr.resumable : tr.notResumable);
  info.textContent = parts.join(' · ');
  info.classList.toggle('warn', !r.resumable);
}

async function submitAdd(e) {
  e.preventDefault();
  const url = $('#in-url').value.trim();
  if (!isValidUrl(url)) {
    $('#add-error').textContent = t().badUrl;
    return;
  }
  try {
    await window.api.add({
      url,
      dir: $('#in-dir').value.trim(),
      out: $('#in-name').value.trim(),
      split: Number($('#in-split').value),
      speedLimit: Number($('#in-limit').value) || 0,
      category: add.category,
    });
    $('#dlg-add').close();
  } catch (err) {
    $('#add-error').textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
}

// ---------- settings dialog ----------
function loginRow(l = { host: '', user: '', hasPassword: false }) {
  const tr = t();
  const row = document.createElement('div');
  row.className = 'login-row';
  row.innerHTML = `
    <input class="l-host" type="text" dir="ltr" />
    <input class="l-user" type="text" dir="ltr" autocomplete="off" />
    <input class="l-pass" type="password" dir="ltr" autocomplete="new-password" />
    <button type="button" class="btn icon sm" title="${tr.remove}">${svg('cancel')}</button>`;
  row.querySelector('.l-host').value = l.host;
  row.querySelector('.l-host').placeholder = tr.site;
  row.querySelector('.l-user').value = l.user;
  row.querySelector('.l-user').placeholder = tr.username;
  row.querySelector('.l-pass').placeholder = l.hasPassword ? tr.passwordSaved : tr.password;
  row.querySelector('button').onclick = () => row.remove();
  return row;
}

function openSettings() {
  const s = state.settings;
  $('#s-dir').value = s.downloadDir;
  $('#s-categorize').checked = s.categorize;
  $('#s-clipboard').checked = s.clipboardWatch;
  $('#s-notifications').checked = s.notifications;
  $('#s-tray').checked = s.closeToTray;
  $('#s-concurrent').value = s.maxConcurrent;
  $('#s-split').value = s.split;
  $('#s-limit').value = s.speedLimit;
  $('#s-retry').checked = s.autoRetry;
  $('#s-retry-max').value = s.retryMax;
  $('#s-proxy').value = s.proxy;
  $('#s-ua').value = s.userAgent;
  const logins = $('#s-logins');
  logins.replaceChildren(...s.logins.map(loginRow));
  showTab('general');
  confirmDialog($('#dlg-settings'), saveSettingsFromDialog);
}

function showTab(name) {
  document.querySelectorAll('#dlg-settings .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('#dlg-settings .pane').forEach((p) => (p.hidden = p.dataset.pane !== name));
}

async function saveSettingsFromDialog() {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
  state.settings = await window.api.setSettings({
    downloadDir: $('#s-dir').value.trim() || state.settings.downloadDir,
    categorize: $('#s-categorize').checked,
    clipboardWatch: $('#s-clipboard').checked,
    notifications: $('#s-notifications').checked,
    closeToTray: $('#s-tray').checked,
    maxConcurrent: clamp($('#s-concurrent').value, 1, 20),
    split: clamp($('#s-split').value, 1, 16),
    speedLimit: clamp($('#s-limit').value, 0, 10_000_000),
    autoRetry: $('#s-retry').checked,
    retryMax: clamp($('#s-retry-max').value, 0, 100),
    proxy: $('#s-proxy').value.trim(),
    userAgent: $('#s-ua').value.trim(),
    logins: [...document.querySelectorAll('#s-logins .login-row')].map((r) => ({
      host: r.querySelector('.l-host').value.trim(),
      user: r.querySelector('.l-user').value.trim(),
      pass: r.querySelector('.l-pass').value,
    })),
  });
  render();
}

// ---------- drag & drop ----------
function linkFromDrop(dt) {
  const uriList = dt.getData('text/uri-list');
  const text = (uriList.split(/\r?\n/).find((l) => l && !l.startsWith('#')) || dt.getData('text/plain') || '').trim();
  return isValidUrl(text) ? text : '';
}

function setupDragDrop() {
  const overlay = $('#drop-overlay');
  let depth = 0;
  const hasLink = (e) => [...e.dataTransfer.types].some((ty) => ty === 'text/uri-list' || ty === 'text/plain');
  document.addEventListener('dragenter', (e) => {
    if (!hasLink(e)) return;
    depth++;
    overlay.classList.add('show');
  });
  document.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.classList.remove('show');
  });
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    overlay.classList.remove('show');
    const url = linkFromDrop(e.dataTransfer);
    if (url) openAddDialog(url);
  });
}

// ---------- startup ----------
async function init() {
  // Listen right away: a link can arrive (clipboard/tray) while settings are still loading.
  let ready = false;
  let pendingLink = null;
  window.api.onOpenAdd((url) => (ready ? openAddDialog(url) : (pendingLink = url)));

  state.settings = await window.api.getSettings();
  $('#btn-settings').innerHTML = svg('settings');
  applyTheme();
  applyLanguage();

  $('#btn-add').onclick = () => openAddDialog();
  $('#btn-add-empty').onclick = () => openAddDialog();
  $('#btn-pause-all').onclick = () => window.api.pauseAll();
  $('#btn-resume-all').onclick = () => window.api.resumeAll();
  $('#btn-settings').onclick = openSettings;
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

  // Add dialog
  $('#form-add').addEventListener('submit', submitAdd);
  $('#btn-add-cancel').onclick = () => $('#dlg-add').close();
  $('#in-url').addEventListener('input', () => scheduleProbe());
  $('#in-name').addEventListener('input', () => (add.nameTouched = true));
  $('#in-dir').addEventListener('input', () => (add.dirTouched = true));
  $('#in-split').oninput = (e) => ($('#out-split').textContent = e.target.value);
  $('#btn-browse').onclick = async () => {
    const dir = await window.api.chooseDir($('#in-dir').value);
    if (dir) {
      $('#in-dir').value = dir;
      add.dirTouched = true;
    }
  };

  // Settings dialog
  document.querySelectorAll('#dlg-settings .tab').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  $('#s-add-login').onclick = () => $('#s-logins').append(loginRow());
  $('#s-browse').onclick = async () => {
    const dir = await window.api.chooseDir($('#s-dir').value);
    if (dir) $('#s-dir').value = dir;
  };

  // Ctrl+V anywhere (outside inputs) opens the add dialog with the pasted link.
  document.addEventListener('paste', (e) => {
    if (e.target.closest('input, textarea') || $('#dlg-add').open) return;
    const text = (e.clipboardData.getData('text') || '').trim();
    if (isValidUrl(text)) openAddDialog(text);
  });
  setupDragDrop();

  ready = true;
  if (pendingLink !== null) openAddDialog(pendingLink);
  window.api.onDownloads((list) => {
    state.list = list;
    render();
  });
}

init();
