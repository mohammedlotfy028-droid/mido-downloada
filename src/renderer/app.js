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
  // Playlist videos show which playlist they belong to instead of their link.
  el.querySelector('.url').textContent = d.playlist ? `${d.playlist.title} · ${d.playlist.index}/${d.playlist.total}` : d.url;
  el.querySelector('.url').title = d.url;
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
  } else if (d.status === 'error' && String(d.errorCode) === '32') {
    sub = tr.checksumMismatch;
  } else if (d.status === 'error') {
    sub = d.errorMessage || '';
  } else if (d.status === 'waiting' && d.queuePos) {
    sub = tr.queuePos(d.queuePos);
  } else if (d.kind === 'media' && live) {
    // yt-dlp: video and audio come separately, then get joined by ffmpeg.
    const n = d.expectedStreams || 1;
    const i = d.stageIndex || 1;
    if (d.stage === 'merge' || d.stage === 'convert') sub = tr.mediaStage[d.stage];
    else if (d.stage === 'starting' || !d.stageIndex) sub = tr.mediaStage.starting;
    else if (n > 1) sub = i === 1 ? tr.mediaStage.video(i, n) : tr.mediaStage.audio(i, n);
    else sub = tr.mediaStage.single;
  } else if (d.metadata) {
    sub = tr.metadata;
  } else if (live && (d.kind === 'torrent' || d.kind === 'magnet')) {
    sub = tr.torrentPeers(d.seeders || 0, Format.speed(d.uploadSpeed || 0, tr));
  } else if (d.status === 'complete' && d.checksum) {
    sub = tr.verified; // aria2 checked it against the checksum the user gave
  }
  el.dataset.verified = d.status === 'complete' && d.checksum ? '1' : '';
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
  if (d.status === 'waiting' && d.kind !== 'media') {
    items.push({ type: 'separator' }, { id: 'top', label: a.top }, { id: 'up', label: a.up }, { id: 'down', label: a.down });
  }
  items.push({ type: 'separator' });
  if (d.status === 'complete') items.push({ id: 'openFile', label: a.openFile });
  if (d.status === 'complete' && !d.multiFile) items.push({ id: 'verify', label: a.verify });
  if (d.playlist && d.status !== 'complete') items.push({ id: 'cancelPlaylist', label: a.cancelPlaylist });
  items.push({ id: 'openFolder', label: a.openFolder }, { id: 'copy', label: a.copy });
  items.push({ type: 'separator' }, { id: 'remove', label: a.remove });
  const chosen = await window.api.popupMenu(items);
  if (chosen) onAction(chosen, gid);
}

/**
 * Calls cb(value) once when a dialog is answered: on its form's submit (value = the button
 * that was clicked) or on close (Esc, or closed from code).
 * Not just 'close': Chromium delays that event while the window is hidden, so an answer
 * could be lost or arrive late; 'submit' always comes right away.
 */
function onDialogDone(dlg, cb) {
  const form = dlg.querySelector('form');
  let done = false;
  const finish = (value) => {
    if (done) return;
    done = true;
    if (form) form.removeEventListener('submit', onSubmit);
    dlg.removeEventListener('close', onClose);
    cb(value);
  };
  const onSubmit = (e) => finish(e.submitter ? e.submitter.value : '');
  const onClose = () => finish(dlg.returnValue);
  if (form) form.addEventListener('submit', onSubmit);
  dlg.addEventListener('close', onClose);
}

function confirmDialog(dlg, onOk) {
  dlg.returnValue = '';
  dlg.showModal();
  onDialogDone(dlg, (value) => value === 'ok' && onOk());
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
    case 'cancelPlaylist':
      return window.api.cancelPlaylist(gid);
    case 'verify':
      return openVerify(d);
  }
}

// ---------- verify a finished file ----------
let verifyGid = null;
async function openVerify(d) {
  verifyGid = d.gid;
  $('#verify-name').textContent = d.name;
  $('#verify-expected').value = '';
  $('#verify-outcome').textContent = '';
  $('#dlg-verify').showModal();
  await computeVerifyHash();
}

async function computeVerifyHash() {
  const gid = verifyGid;
  $('#verify-hash').value = t().verifyWorking;
  const hex = await window.api.hash(gid, $('#verify-algo').value);
  if (gid !== verifyGid) return;
  $('#verify-hash').value = hex || '—';
  compareVerify();
}

async function compareVerify() {
  const out = $('#verify-outcome');
  const expected = $('#verify-expected').value.trim();
  const actual = $('#verify-hash').value;
  out.className = 'verify-outcome';
  if (!expected || !/^[0-9a-f]+$/.test(actual)) {
    out.textContent = '';
    return;
  }
  const parsed = await window.api.checkChecksum(expected);
  if (!parsed || parsed.error) {
    out.textContent = t().badChecksum;
    out.classList.add('bad');
    return;
  }
  // The pasted code may be another algorithm: switch to it and recalculate.
  if (parsed.algo !== $('#verify-algo').value) {
    $('#verify-algo').value = parsed.algo;
    return computeVerifyHash();
  }
  const ok = parsed.hex === actual;
  out.textContent = ok ? t().verifyMatch : t().verifyNoMatch;
  out.classList.add(ok ? 'good' : 'bad');
}

// ---------- add dialog ----------
// requestId: set when the link came from the browser extension. The cookies for it stay
// in the main process; we only pass the id back when probing/adding.
// torrent: set when a .torrent file was picked (then the URL box shows its name).
const add = { probeSeq: 0, probeTimer: null, nameTouched: false, dirTouched: false, category: null, requestId: null, submitted: false, torrent: null };

const isMagnet = (s) => /^magnet:\?xt=urn:btih:[a-z0-9]{32,40}/i.test(String(s).trim());

function isValidUrl(s) {
  if (isMagnet(s)) return true;
  try {
    return ['http:', 'https:', 'ftp:', 'sftp:'].includes(new URL(s).protocol);
  } catch {
    return false;
  }
}

/** Shows/hides the video-site part of the add dialog (preview + quality instead of name/connections). */
function setMediaMode(on) {
  const video = on && !!add.media; // a single video
  const list = on && !!add.playlistData; // a playlist
  $('#media-box').hidden = !video;
  $('#playlist-box').hidden = !list;
  $('#playlist-offer').hidden = !video || !add.playlistUrl;
  $('#lbl-pl-subfolder').hidden = !list;
  $('#lbl-pl-number').hidden = !list;
  $('#lbl-quality').hidden = !video && !list;
  $('#lbl-name').hidden = on;
  $('#lbl-split').hidden = on;
  $('#lbl-checksum').hidden = on || !!add.torrent;
  if (!on) {
    add.media = null;
    add.playlistData = null;
    add.playlistUrl = '';
  }
}

function durationText(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** Fills the quality list from yt-dlp's info and preselects the default from Settings. */
function fillQualities(info) {
  const tr = t();
  const sel = $('#in-quality');
  sel.replaceChildren();
  const opt = (value, label) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    sel.append(o);
  };
  for (const q of info.qualities) {
    opt(`v:${q.height}`, q.height ? `${q.label}${q.size ? ` · ~${Format.bytes(q.size, tr)}` : ''}` : tr.qBest);
  }
  if (info.hasAudio) {
    const a = info.audioSize ? ` · ~${Format.bytes(info.audioSize, tr)}` : '';
    opt('a:mp3', tr.qMp3 + a);
    opt('a:m4a', tr.qM4a + a);
  }
  // Default: the setting, or the highest quality not above it.
  const want = state.settings.mediaQuality;
  const values = [...sel.options].map((o) => o.value);
  if (want === 'mp3' || want === 'm4a') sel.value = values.includes(`a:${want}`) ? `a:${want}` : values[0];
  else if (want === 'best') sel.value = values[0];
  else {
    const h = Number(want);
    const fit = info.qualities.find((q) => q.height && q.height <= h);
    sel.value = fit ? `v:${fit.height}` : values[0];
  }
}

async function loadMediaInfo(url, site, seq) {
  const tr = t();
  const info = $('#probe-info');
  info.hidden = false;
  info.className = 'probe loading';
  info.textContent = tr.mediaLoading(site);
  add.playlistData = null;
  setMediaMode(true);
  let r;
  try {
    r = await window.api.mediaInfo(url, add.requestId);
  } catch (e) {
    r = { ok: false, error: String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
  }
  if (seq !== add.probeSeq) return;
  if (!r.ok) {
    add.media = null;
    setMediaMode(true);
    info.className = 'probe warn';
    const why = r.error === 'PLAYLIST' ? tr.mediaPlaylist : r.error === 'NO_TOOLS' ? tr.mediaNoTools : `${tr.mediaFail}: ${r.error}`;
    info.textContent = add.requestId ? why : `${why}\n${tr.mediaLoginHint}`;
    return;
  }
  add.media = r;
  info.hidden = true;
  $('#media-thumb').src = r.thumbnail || '';
  $('#media-thumb').hidden = !r.thumbnail;
  $('#media-title').textContent = r.title;
  $('#media-sub').textContent = [site || r.site, r.uploader, durationText(r.duration)].filter(Boolean).join(' · ');
  fillQualities(r);
  setMediaMode(true);
  await onQualityChange();
}

// ---------- playlists ----------
const PL_QUALITIES = [['v:0', 'qBest'], ['v:2160', '2160p (4K)'], ['v:1440', '1440p'], ['v:1080', '1080p'], ['v:720', '720p'], ['v:480', '480p'], ['v:360', '360p'], ['v:240', '240p'], ['v:144', '144p'], ['a:mp3', 'qMp3'], ['a:m4a', 'qM4a']];

/** Quality list for a playlist: we don't know each video's formats yet, so offer the usual ones. */
function fillPlaylistQualities() {
  const tr = t();
  const sel = $('#in-quality');
  sel.replaceChildren(
    ...PL_QUALITIES.map(([value, label]) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = tr[label] || label;
      return o;
    })
  );
  const want = state.settings.mediaQuality;
  sel.value = want === 'best' ? 'v:0' : want === 'mp3' || want === 'm4a' ? `a:${want}` : `v:${want}`;
  if (!sel.value) sel.value = 'v:1080';
}

function selectedPlaylistEntries() {
  const d = add.playlistData;
  return d ? d.entries.map((e, i) => ({ ...e, index: i + 1 })).filter((e) => d.selected.has(e.id)) : [];
}

function updatePlaylistCount() {
  const d = add.playlistData;
  if (!d) return;
  const chosen = selectedPlaylistEntries();
  const total = chosen.reduce((s, e) => s + (e.duration || 0), 0);
  $('#pl-count').textContent = t().plCount(chosen.length, d.entries.length, durationText(total));
  document.querySelectorAll('#pl-list .pl-row input').forEach((cb) => (cb.checked = d.selected.has(cb.dataset.id)));
}

function renderPlaylist() {
  const tr = t();
  const d = add.playlistData;
  $('#pl-title').textContent = d.title;
  const all = d.entries.reduce((s, e) => s + (e.duration || 0), 0);
  $('#pl-sub').textContent = tr.plSub(d.site, d.uploader, d.total, durationText(all)) + (d.truncated ? `\n${tr.plTruncated(d.entries.length)}` : '');
  $('#pl-list').replaceChildren(
    ...d.entries.map((e, i) => {
      const row = document.createElement('label');
      row.className = `pl-row${e.unavailable ? ' off' : ''}`;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.id = e.id;
      cb.disabled = e.unavailable;
      cb.onchange = () => {
        cb.checked ? d.selected.add(e.id) : d.selected.delete(e.id);
        updatePlaylistCount();
      };
      const n = document.createElement('span');
      n.className = 'pl-n';
      n.textContent = String(i + 1);
      const title = document.createElement('span');
      title.className = 'pl-t';
      title.dir = 'auto';
      title.textContent = e.unavailable ? tr.plUnavailable : e.title;
      title.title = e.title;
      const dur = document.createElement('span');
      dur.className = 'pl-d';
      dur.textContent = durationText(e.duration);
      row.append(cb, n, title, dur);
      return row;
    })
  );
  updatePlaylistCount();
}

async function loadPlaylistInfo(url, site, seq) {
  const tr = t();
  const info = $('#probe-info');
  info.hidden = false;
  info.className = 'probe loading';
  info.textContent = tr.plLoading;
  add.media = null;
  add.playlistData = null;
  setMediaMode(true);
  let r;
  try {
    r = await window.api.playlistInfo(url, add.requestId);
  } catch (e) {
    r = { ok: false, error: String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
  }
  if (seq !== add.probeSeq) return;
  if (!r.ok) {
    setMediaMode(true);
    info.className = 'probe warn';
    const why = r.error === 'NO_TOOLS' ? tr.mediaNoTools : r.error === 'NOT_PLAYLIST' ? tr.notPlaylist : `${tr.mediaFail}: ${r.error}`;
    info.textContent = add.requestId ? why : `${why}\n${tr.mediaLoginHint}`;
    return;
  }
  add.playlistData = { ...r, site, selected: new Set(r.entries.filter((e) => !e.unavailable).map((e) => e.id)) };
  info.hidden = true;
  fillPlaylistQualities();
  renderPlaylist();
  setMediaMode(true);
  await onQualityChange();
}

/** Audio goes to the Music folder, video to Video (unless the user picked a folder). */
async function onQualityChange() {
  if (add.dirTouched || !(add.media || add.playlistData)) return;
  const audio = $('#in-quality').value.startsWith('a:');
  add.category = audio ? 'music' : 'video';
  $('#in-dir').value = await window.api.suggestDir(add.category);
}

/** Switches the add dialog to "torrent file" mode. */
function useTorrent(info) {
  const tr = t();
  add.torrent = info;
  add.category = null;
  add.mediaLink = false;
  add.probeSeq++; // ignore any link check still running
  setMediaMode(false);
  $('#in-url').value = info.name;
  $('#in-url').readOnly = true;
  $('#in-name').value = '';
  $('#in-name').disabled = true;
  $('#lbl-checksum').hidden = true;
  if (!add.dirTouched) $('#in-dir').value = info.dir;
  const p = $('#probe-info');
  p.hidden = false;
  p.className = 'probe';
  p.textContent = tr.torrentInfo(Format.bytes(info.size, tr), info.fileCount);
}

async function openTorrentFile(file) {
  try {
    const info = file ? await window.api.loadTorrent(file) : await window.api.chooseTorrent();
    if (!info) return;
    if (!$('#dlg-add').open) openAddDialog();
    useTorrent(info);
  } catch {
    if (!$('#dlg-add').open) openAddDialog();
    $('#add-error').textContent = t().badTorrent;
  }
}

function openAddDialog(prefillUrl = '', ctx = null) {
  const dlg = $('#dlg-add');
  if (dlg.open) {
    // Already open: just put the new link in (and drop the old browser request).
    if (prefillUrl) {
      if (add.torrent) {
        add.torrent = null;
        $('#in-url').readOnly = false;
        $('#in-name').disabled = false;
        $('#lbl-checksum').hidden = false;
      }
      if (add.requestId && (!ctx || ctx.requestId !== add.requestId)) window.api.discardRequest(add.requestId);
      add.requestId = ctx ? ctx.requestId : null;
      $('#add-from-browser').hidden = !add.requestId;
      $('#in-url').value = prefillUrl;
      if (ctx && ctx.name && !add.nameTouched) $('#in-name').value = ctx.name;
      scheduleProbe(0);
    }
    return;
  }
  Object.assign(add, { nameTouched: false, dirTouched: false, category: null, requestId: ctx ? ctx.requestId : null, submitted: false, torrent: null, media: null, mediaLink: false, playlistData: null, playlistUrl: '' });
  setMediaMode(false);
  $('#add-from-browser').hidden = !add.requestId;
  $('#in-url').value = prefillUrl;
  $('#in-url').readOnly = false;
  $('#in-name').disabled = false;
  $('#lbl-checksum').hidden = false;
  $('#in-checksum').value = '';
  $('#in-name').value = (ctx && ctx.name) || '';
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
  if (add.torrent) return;
  const url = $('#in-url').value.trim();
  const info = $('#probe-info');
  if (!isValidUrl(url)) {
    info.hidden = true;
    return;
  }
  if (isMagnet(url)) {
    add.category = null;
    if (!add.dirTouched) $('#in-dir').value = state.settings.downloadDir;
    info.hidden = false;
    info.className = 'probe';
    info.textContent = t().magnetInfo;
    return;
  }
  const seq = ++add.probeSeq;
  const tr = t();
  info.hidden = false;
  info.className = 'probe loading';
  info.textContent = tr.probing;
  const r = await window.api.probe(url, add.requestId);
  if (seq !== add.probeSeq) return; // a newer link was typed meanwhile
  add.mediaLink = !!r.media;
  add.playlistUrl = r.playlistUrl || '';
  if (r.media) {
    if (!add.dirTouched) $('#in-dir').value = r.dir;
    return r.playlist ? loadPlaylistInfo(url, r.site, seq) : loadMediaInfo(url, r.site, seq);
  }
  setMediaMode(false);
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
  const url = add.torrent ? '' : $('#in-url').value.trim();
  if (!add.torrent && !isValidUrl(url)) {
    $('#add-error').textContent = t().badUrl;
    return;
  }
  try {
    if (add.playlistData) {
      // A playlist: the ticked videos, one download each, in playlist order.
      const d = add.playlistData;
      const chosen = selectedPlaylistEntries();
      if (!chosen.length) {
        $('#add-error').textContent = t().noVideosSelected;
        return;
      }
      const [kind, val] = $('#in-quality').value.split(':');
      await window.api.add({
        url,
        dir: $('#in-dir').value.trim(),
        mediaQuality: kind === 'a' ? { type: 'audio', format: val } : { type: 'video', height: Number(val) },
        mediaPlaylist: {
          id: d.id, title: d.title, total: d.total,
          subfolder: $('#in-pl-subfolder').checked, numbered: $('#in-pl-number').checked,
          entries: chosen.map((e) => ({ id: e.id, title: e.title, url: e.url, index: e.index })),
        },
        speedLimit: Number($('#in-limit').value) || 0,
        requestId: add.requestId,
      });
      add.submitted = true;
      $('#dlg-add').close();
      return;
    }
    if (add.media) {
      // Video site: yt-dlp with the chosen quality.
      const [kind, val] = $('#in-quality').value.split(':');
      const q = add.media.qualities.find((x) => `v:${x.height}` === $('#in-quality').value);
      await window.api.add({
        url,
        dir: $('#in-dir').value.trim(),
        title: add.media.title,
        size: kind === 'a' ? add.media.audioSize : q ? q.size : 0,
        mediaQuality: kind === 'a' ? { type: 'audio', format: val } : { type: 'video', height: Number(val) },
        speedLimit: Number($('#in-limit').value) || 0,
        requestId: add.requestId,
      });
      add.submitted = true;
      $('#dlg-add').close();
      return;
    }
    if (add.mediaLink) return; // a video-site link whose info is still loading (or failed)
    await window.api.add({
      url,
      dir: $('#in-dir').value.trim(),
      out: isMagnet(url) ? '' : $('#in-name').value.trim(),
      split: Number($('#in-split').value),
      speedLimit: Number($('#in-limit').value) || 0,
      category: add.category,
      requestId: add.requestId,
      checksum: add.torrent || isMagnet(url) ? '' : $('#in-checksum').value.trim(),
      torrentId: add.torrent ? add.torrent.torrentId : null,
    });
    add.submitted = true;
    $('#dlg-add').close();
  } catch (err) {
    const msg = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    $('#add-error').textContent = msg === 'BAD_CHECKSUM' ? t().badChecksum : msg;
  }
}

// ---------- browser extension ----------
const pairQueue = [];
function showPairRequest(req) {
  const dlg = $('#dlg-pair');
  if (dlg.open) {
    pairQueue.push(req);
    return;
  }
  $('#pair-name').textContent = req.name;
  dlg.returnValue = '';
  dlg.showModal();
  onDialogDone(dlg, async (value) => {
    await window.api.answerPair(req.id, value === 'allow');
    state.settings = await window.api.getSettings();
    if (pairQueue.length) setTimeout(() => showPairRequest(pairQueue.shift()), 0);
  });
}

async function renderBrowserPane() {
  const tr = t();
  const st = await window.api.bridgeStatus();
  $('#s-bridge-status').textContent = st.error ? tr.bridgeErr(st.error) : tr.bridgeOk(st.port);
  $('#s-bridge-status').classList.toggle('bad', !!st.error);
  const box = $('#s-clients');
  if (!settingsDraft.browserClients.length) {
    box.innerHTML = `<p class="hint"></p>`;
    box.firstChild.textContent = tr.noClients;
    return;
  }
  box.replaceChildren(
    ...settingsDraft.browserClients.map((c) => {
      const row = document.createElement('div');
      row.className = 'client-row';
      row.innerHTML = `<div><div class="c-title" dir="auto"></div><div class="hint"></div></div><button type="button" class="btn sm-text"></button>`;
      row.querySelector('.c-title').textContent = c.name;
      row.querySelector('.hint').textContent = tr.pairedOn(new Date(c.pairedAt).toLocaleString(state.settings.lang === 'ar' ? 'ar-EG' : 'en-GB'));
      const btn = row.querySelector('button');
      btn.textContent = tr.unpair;
      btn.onclick = () => {
        settingsDraft.browserClients = settingsDraft.browserClients.filter((x) => x.id !== c.id);
        renderBrowserPane();
      };
      return row;
    })
  );
}

// ---------- settings dialog ----------
let settingsDraft = { browserClients: [] };
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
  $('#s-browser').checked = s.browserEnabled;
  $('#s-browser-ask').checked = s.browserAsk;
  settingsDraft = { browserClients: [...s.browserClients] };
  renderBrowserPane();
  // Schedule + updates
  $('#s-sched').checked = s.schedule.enabled;
  $('#s-sched-start').value = s.schedule.start;
  $('#s-sched-stop').value = s.schedule.stop;
  const days = $('#s-sched-days');
  days.replaceChildren(
    ...t().days.map((name, i) => {
      const l = document.createElement('label');
      l.className = 'day';
      l.innerHTML = `<input type="checkbox" value="${i}" /><span></span>`;
      l.querySelector('input').checked = s.schedule.days.includes(i);
      l.querySelector('span').textContent = name;
      return l;
    })
  );
  $('#s-afterdone').value = s.afterDone;
  $('#s-media-quality').value = s.mediaQuality;
  window.api.mediaToolsStatus().then((st) => ($('#s-ytdlp-status').textContent = t().ytdlpStatus(st && st.version)));
  $('#s-autoupdate').checked = s.autoUpdate;
  window.api.updateStatus().then(showUpdateStatus);
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
    browserEnabled: $('#s-browser').checked,
    browserAsk: $('#s-browser-ask').checked,
    browserClients: settingsDraft.browserClients.map((c) => ({ id: c.id })),
    schedule: {
      enabled: $('#s-sched').checked,
      start: $('#s-sched-start').value,
      stop: $('#s-sched-stop').value,
      days: [...document.querySelectorAll('#s-sched-days input:checked')].map((i) => Number(i.value)),
    },
    afterDone: $('#s-afterdone').value,
    mediaQuality: $('#s-media-quality').value,
    autoUpdate: $('#s-autoupdate').checked,
    logins: [...document.querySelectorAll('#s-logins .login-row')].map((r) => ({
      host: r.querySelector('.l-host').value.trim(),
      user: r.querySelector('.l-user').value.trim(),
      pass: r.querySelector('.l-pass').value,
    })),
  });
  render();
  renderAfterDoneBanner();
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
  const hasLink = (e) => [...e.dataTransfer.types].some((ty) => ty === 'text/uri-list' || ty === 'text/plain' || ty === 'Files');
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
    // A .torrent file dropped from Explorer
    const torrent = [...(e.dataTransfer.files || [])].find((f) => /\.torrent$/i.test(f.name));
    if (torrent) {
      const file = window.api.pathForFile(torrent);
      if (file) openTorrentFile(file);
      return;
    }
    const url = linkFromDrop(e.dataTransfer);
    if (url) openAddDialog(url);
  });
}

// ---------- updates, "after done" banner, power countdown ----------
let updateState = { state: 'idle' };
function showUpdateStatus(s) {
  if (!s) return;
  updateState = s;
  const tr = t();
  const text = (tr.upd[s.state] || tr.upd.idle)(s.version, s);
  $('#s-update-status').textContent = text;
  $('#s-update-status').classList.toggle('bad', s.state === 'error');
  $('#update-banner').hidden = s.state !== 'ready';
  if (s.state === 'ready') $('#update-text').textContent = text;
}

function renderAfterDoneBanner() {
  const a = state.settings.afterDone;
  $('#afterdone-banner').hidden = a === 'nothing';
  if (a !== 'nothing') $('#afterdone-text').textContent = t().afterDoneBanner[a];
}

let powerTick = null;
function showPowerCountdown({ action, seconds }) {
  const tr = t();
  const dlg = $('#dlg-power');
  let left = seconds;
  $('#power-title').textContent = tr.powerTitle[action];
  $('#power-count').textContent = tr.powerCount(left);
  clearInterval(powerTick);
  powerTick = setInterval(() => {
    left = Math.max(0, left - 1);
    $('#power-count').textContent = tr.powerCount(left);
  }, 1000);
  dlg.returnValue = '';
  if (!dlg.open) dlg.showModal();
  onDialogDone(dlg, async (value) => {
    clearInterval(powerTick);
    if (value !== 'done') await window.api.cancelPower(); // Cancel button or Esc
    state.settings = await window.api.getSettings();
    renderAfterDoneBanner();
  });
}

// ---------- startup ----------
async function init() {
  // Listen right away: a link (clipboard/tray/browser) or a pairing request can arrive
  // while settings are still loading.
  let ready = false;
  let pendingLink = null;
  let pendingPair = [];
  window.api.onOpenAdd((url, ctx) => (ready ? openAddDialog(url, ctx) : (pendingLink = { url, ctx })));
  window.api.onPairRequest((req) => (ready ? showPairRequest(req) : pendingPair.push(req)));
  let pendingPower = null;
  window.api.onPower((p) => (ready ? showPowerCountdown(p) : (pendingPower = p)));
  window.api.onPowerDone(() => $('#dlg-power').open && $('#dlg-power').close('done'));
  window.api.onUpdate((s) => (ready ? showUpdateStatus(s) : (updateState = s)));

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
  $('#s-ext-folder').onclick = () => window.api.openExtensionFolder();
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

  // Closing the add dialog without starting: forget the browser request (and its cookies).
  $('#dlg-add').addEventListener('close', () => {
    // 'close' can arrive late (window hidden): if the dialog is open again by then, it
    // belongs to a newer link, so leave it alone.
    if ($('#dlg-add').open) return;
    if (add.requestId && !add.submitted) window.api.discardRequest(add.requestId);
    add.requestId = null;
  });

  // Video sites: quality choice, yt-dlp update
  $('#in-quality').onchange = onQualityChange;
  // Playlists: choose which videos; switch from "this video" to "the whole playlist"
  $('#pl-all').onclick = () => {
    const d = add.playlistData;
    if (d) d.entries.forEach((e) => !e.unavailable && d.selected.add(e.id));
    updatePlaylistCount();
  };
  $('#pl-none').onclick = () => {
    if (add.playlistData) add.playlistData.selected.clear();
    updatePlaylistCount();
  };
  $('#btn-whole-playlist').onclick = () => {
    if (!add.playlistUrl) return;
    $('#in-url').value = add.playlistUrl;
    scheduleProbe(0);
  };
  $('#s-ytdlp-update').onclick = async () => {
    const tr = t();
    $('#s-ytdlp-status').textContent = tr.ytdlpResult.checking;
    const r = await window.api.updateMediaTools();
    const res = r && r.result;
    $('#s-ytdlp-status').textContent = `${tr.ytdlpStatus(r && r.version)} · ${tr.ytdlpResult[res] || res || ''}`;
  };

  // Torrent files, checksum check, updates, "after done"
  $('#btn-torrent').onclick = () => openTorrentFile();
  $('#verify-algo').onchange = computeVerifyHash;
  $('#verify-expected').addEventListener('input', () => compareVerify());
  $('#btn-verify-copy').onclick = () => window.api.copyText($('#verify-hash').value);
  $('#btn-update-install').onclick = () => window.api.installUpdate();
  $('#s-check-update').onclick = async () => showUpdateStatus(await window.api.checkUpdate());
  $('#btn-afterdone-off').onclick = async () => {
    state.settings = await window.api.setSettings({ afterDone: 'nothing' });
    renderAfterDoneBanner();
  };
  $('#dlg-settings').addEventListener('close', () => setTimeout(renderAfterDoneBanner, 300));
  renderAfterDoneBanner();
  showUpdateStatus(await window.api.updateStatus());

  ready = true;
  if (pendingLink !== null) openAddDialog(pendingLink.url, pendingLink.ctx);
  pendingPair.forEach(showPairRequest);
  if (pendingPower) showPowerCountdown(pendingPower);
  window.api.onDownloads((list) => {
    state.list = list;
    render();
  });
}

init();
