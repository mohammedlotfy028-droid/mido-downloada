// Mido Download browser extension (Manifest V3 service worker).
// - Catches browser downloads and sends them to the app (with cookies + Referer)
// - Right-click menu "Download with Mido Download"
// - Notices videos/audio a page plays, so the popup can send them to the app
importScripts('capture-rules.js');

const DEFAULT_PORT = 47811;

// ---------- talking to the app ----------
async function getConfig() {
  return chrome.storage.local.get({ token: '', port: DEFAULT_PORT, capture: true });
}

// Always POST: browsers only add the Origin header (which the app checks) to POST requests.
async function callApp(path, { method = 'POST', body, token, timeout = 2000 } = {}) {
  const { port } = await getConfig();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ...json };
  } catch {
    return { status: 0 }; // app not running
  } finally {
    clearTimeout(timer);
  }
}

/** 'connected' | 'notPaired' | 'notRunning' | 'disabled' | 'pairing' */
async function getStatus() {
  const { pairing } = await chrome.storage.session.get({ pairing: false });
  if (pairing) return 'pairing';
  const { token } = await getConfig();
  const r = await callApp('/v1/status', { token });
  if (r.status !== 200 || r.app !== 'mido-downloada') return 'notRunning';
  if (!r.enabled) return 'disabled';
  return r.paired ? 'connected' : 'notPaired';
}

function browserName() {
  const ua = navigator.userAgent;
  const name = /Edg\//.test(ua) ? 'Microsoft Edge' : /OPR\//.test(ua) ? 'Opera' : 'Google Chrome';
  const version = (/(?:Edg|OPR|Chrome)\/(\d+)/.exec(ua) || [])[1] || '';
  return `${name} ${version}`.trim();
}

/** Asks the app to pair; the user has to click "Allow" in the app. */
async function pair() {
  await chrome.storage.session.set({ pairing: true });
  try {
    const r = await callApp('/v1/pair', { method: 'POST', body: { name: browserName() }, timeout: 130000 });
    if (r.status === 200 && r.token) {
      await chrome.storage.local.set({ token: r.token });
      return 'connected';
    }
    if (r.status === 0) return 'notRunning';
    if (r.status === 503) return 'disabled';
    return 'denied';
  } finally {
    await chrome.storage.session.set({ pairing: false });
  }
}

/** "name=value; name2=value2" for the site, including HttpOnly cookies. */
async function cookieHeader(url) {
  try {
    const list = await chrome.cookies.getAll({ url });
    return list.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return '';
  }
}

/** Sends one link to the app. Returns true if the app took it. */
async function sendToApp({ url, referrer = '', filename = '', fileSize = 0, mime = '', source }) {
  const { token } = await getConfig();
  if (!token) return false;
  const r = await callApp('/v1/download', {
    method: 'POST',
    token,
    timeout: 5000,
    body: {
      url, referrer, filename, fileSize, mime, source,
      cookies: await cookieHeader(url),
      userAgent: navigator.userAgent,
    },
  });
  if (r.status === 401) await chrome.storage.local.remove('token'); // un-paired in the app
  return r.status === 200;
}

const baseName = (p) => String(p || '').split(/[\\/]/).pop();

// ---------- 1. catching browser downloads ----------
chrome.downloads.onCreated.addListener(async (item) => {
  const { capture, token } = await getConfig();
  if (!capture || !token || item.state !== 'in_progress') return;
  const url = item.finalUrl || item.url;
  const size = item.totalBytes > 0 ? item.totalBytes : item.fileSize || 0;
  const filename = baseName(item.filename);
  if (!shouldCapture({ url, filename, mime: item.mime, size })) return;

  // Send first: if the app isn't running, the browser just keeps downloading.
  const ok = await sendToApp({ url, referrer: item.referrer || '', filename, fileSize: size, mime: item.mime, source: 'click' });
  if (!ok) return;
  try {
    await chrome.downloads.cancel(item.id);
  } catch {}
  try {
    await chrome.downloads.erase({ id: item.id });
  } catch {}
});

// ---------- 2. right-click menu ----------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'mido-download',
      title: chrome.i18n.getMessage('menuDownload'),
      contexts: ['link', 'video', 'audio', 'image'],
    });
  });
});

async function handleMenuClick(info, tab) {
  const url = info.linkUrl || info.srcUrl;
  if (!url || !/^(https?|ftp):/i.test(url)) return false;
  const ok = await sendToApp({ url, referrer: info.pageUrl || (tab && tab.url) || '', source: 'menu' });
  if (!ok) chrome.downloads.download({ url }); // app not available: use the browser instead
  return ok;
}
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'mido-download') handleMenuClick(info, tab);
});

// ---------- 3. noticing videos/audio played by pages ----------
const mediaKey = (tabId) => `media:${tabId}`;

async function getMedia(tabId) {
  const k = mediaKey(tabId);
  return (await chrome.storage.session.get({ [k]: [] }))[k];
}

async function recordMedia(tabId, entry) {
  const list = await getMedia(tabId);
  // The same file is requested many times in pieces (Range requests): keep one.
  const same = list.find((m) => m.url === entry.url);
  if (same) {
    if (entry.size > same.size) same.size = entry.size;
  } else {
    list.push(entry);
    if (list.length > 30) list.shift();
  }
  await chrome.storage.session.set({ [mediaKey(tabId)]: list });
  chrome.action.setBadgeText({ tabId, text: String(list.length) }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#0f9d8a' }).catch(() => {});
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0 || d.statusCode >= 300 || !/^https?:/.test(d.url)) return;
    const h = {};
    for (const x of d.responseHeaders || []) h[x.name.toLowerCase()] = x.value || '';
    const type = (h['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!/^(video|audio)\//.test(type) || type === 'video/mp2t') return; // skip HLS pieces
    const range = /\/(\d+)\s*$/.exec(h['content-range'] || '');
    const size = range ? Number(range[1]) : Number(h['content-length'] || 0);
    if (size && size < 300 * 1024) return; // tiny sounds, previews…
    chrome.tabs.get(d.tabId).then(
      (tab) => recordMedia(d.tabId, { url: d.url, type, size, pageUrl: tab.url || '', title: tab.title || '' }),
      () => {}
    );
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] },
  ['responseHeaders']
);

// Forget a tab's media when it navigates away or closes.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading' && change.url) {
    chrome.storage.session.remove(mediaKey(tabId));
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  }
});
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(mediaKey(tabId)));

// ---------- messages from the popup ----------
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    switch (msg.cmd) {
      case 'status':
        return { status: await getStatus(), capture: (await getConfig()).capture };
      case 'pair':
        return { status: await pair() };
      case 'setCapture':
        await chrome.storage.local.set({ capture: !!msg.value });
        return { ok: true };
      case 'media':
        return { media: await getMedia(msg.tabId) };
      case 'sendMedia': {
        const m = (await getMedia(msg.tabId)).find((x) => x.url === msg.url);
        if (!m) return { ok: false };
        const name = baseName(new URL(m.url).pathname);
        return { ok: await sendToApp({ url: m.url, referrer: m.pageUrl, filename: name, fileSize: m.size, mime: m.type, source: 'media' }) };
      }
      default:
        return { error: 'unknown' };
    }
  })().then(reply);
  return true; // reply is async
});
