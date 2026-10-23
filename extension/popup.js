// Extension popup: connection status, pairing, capture switch, media found on the page.
const msg = (k) => chrome.i18n.getMessage(k);
const $ = (s) => document.querySelector(s);
const send = (m) => chrome.runtime.sendMessage(m);

const STATUS_TEXT = {
  connected: 'statusConnected',
  notRunning: 'statusNotRunning',
  disabled: 'statusDisabled',
  notPaired: 'statusNotPaired',
  pairing: 'statusPairing',
  denied: 'statusDenied',
  checking: 'statusChecking',
};

function setStatus(state) {
  $('#status').dataset.state = state;
  $('#status-text').textContent = msg(STATUS_TEXT[state] || 'statusNotRunning');
  const btn = $('#btn-connect');
  btn.hidden = !['notPaired', 'denied', 'pairing'].includes(state);
  btn.disabled = state === 'pairing';
}

function sizeText(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

async function currentTabId() {
  // ?tab=<id> lets the popup be opened as a normal page (used by the tests).
  const fromQuery = Number(new URLSearchParams(location.search).get('tab'));
  if (fromQuery) return fromQuery;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ? tab.id : -1;
}

async function renderMedia(connected) {
  const tabId = await currentTabId();
  const { media = [] } = await send({ cmd: 'media', tabId });
  const ul = $('#media');
  ul.replaceChildren();
  $('#media-empty').hidden = media.length > 0;
  for (const m of media) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('div');
    name.className = 'name';
    let file = m.url;
    try {
      file = decodeURIComponent(new URL(m.url).pathname.split('/').pop()) || m.url;
    } catch {}
    name.textContent = file;
    name.title = m.url;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = [m.type, sizeText(m.size)].filter(Boolean).join(' · ');
    info.append(name, meta);
    const btn = document.createElement('button');
    btn.className = 'btn primary small';
    btn.textContent = msg('download');
    btn.disabled = !connected;
    btn.onclick = async () => {
      btn.disabled = true;
      const r = await send({ cmd: 'sendMedia', tabId, url: m.url });
      btn.textContent = msg(r && r.ok ? 'sent' : 'sendFailed');
    };
    li.append(info, btn);
    ul.append(li);
  }
}

async function refresh() {
  const { status, capture } = await send({ cmd: 'status' });
  setStatus(status);
  $('#capture').checked = capture;
  await renderMedia(status === 'connected');
  return status;
}

document.addEventListener('DOMContentLoaded', async () => {
  const lang = chrome.i18n.getUILanguage();
  document.documentElement.lang = lang;
  document.documentElement.dir = lang.startsWith('ar') ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-msg]').forEach((el) => (el.textContent = msg(el.dataset.msg)));
  setStatus('checking');

  $('#capture').onchange = (e) => send({ cmd: 'setCapture', value: e.target.checked });
  $('#btn-connect').onclick = async () => {
    setStatus('pairing');
    const r = await send({ cmd: 'pair' });
    setStatus(r.status);
    renderMedia(r.status === 'connected');
  };
  await refresh();
});
