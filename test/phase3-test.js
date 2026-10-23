// Phase 3 test: the real app + Microsoft Edge (temporary profile) with the extension loaded.
// Covers: bridge security, pairing with approval, catching a click on a login-protected
// file (cookies + Referer), small files left to the browser, right-click menu, video
// detection, cookies never stored in plain text, restart with cookies, unpairing.
// Usage: node test/phase3-test.js <screenshotDir>
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { ROOT, sleep, check, waitFor, launchApp, connectTarget, items } = require('./cdp');

const SHOTS = path.resolve(process.argv[2] || '.');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT_ID = 'deaodfooaihmngfdanpadajieidlcngd';
const PORT = 8768; // test website
const BRIDGE = 47899; // app <-> extension (not the real 47811, in case the real app runs)
const EDGE_DEBUG = 9444;
const BASE = `http://127.0.0.1:${PORT}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mido-p3-'));
const dataDir = path.join(tmp, 'data');
const outDir = path.join(tmp, 'Downloads');
const edgeProfile = path.join(tmp, 'edge-profile');
const edgeDownloads = path.join(tmp, 'edge-downloads');
for (const d of [outDir, edgeDownloads, path.join(edgeProfile, 'Default')]) fs.mkdirSync(d, { recursive: true });
const srcFile = path.join(tmp, 'src.bin');
fs.writeFileSync(srcFile, crypto.randomBytes(40 * 1024 * 1024));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// Edge saves its own downloads in the temp folder, never in the real Downloads folder.
fs.writeFileSync(
  path.join(edgeProfile, 'Default', 'Preferences'),
  JSON.stringify({ download: { default_directory: edgeDownloads, prompt_for_download: false, directory_upgrade: true } })
);

const server = spawn(process.execPath, [path.join(__dirname, 'server.js'), srcFile, PORT, 512 * 1024], { stdio: 'ignore' });
let edge;
let app;

/** Raw request to the app's bridge with any headers (to test the security checks). */
function bridgeRequest(method, urlPath, headers = {}, body = null) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: BRIDGE, method, path: urlPath, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', () => resolve({ status: 0 }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const edgeJson = (p, method = 'GET') => fetch(`http://127.0.0.1:${EDGE_DEBUG}${p}`, { method }).then((r) => r.json());
async function openEdgeTab(url) {
  const t = await edgeJson(`/json/new?${encodeURI(url)}`, 'PUT');
  const tab = await connectTarget(t.webSocketDebuggerUrl);
  tab.id = t.id;
  return tab;
}
/** The extension's service worker (it sleeps when idle; opening the popup wakes it). */
async function extensionWorker() {
  const t = await waitFor(async () => (await edgeJson('/json')).find((x) => x.type === 'service_worker' && x.url.includes(EXT_ID)), 15000);
  return t && connectTarget(t.webSocketDebuggerUrl);
}

(async () => {
  await sleep(500);
  const appEnv = { MIDO_BRIDGE_PORT: String(BRIDGE) };
  app = await launchApp({ dataDir, env: appEnv });
  const settingsPatch = { downloadDir: outDir, categorize: true, clipboardWatch: false, notifications: false, browserAsk: true };
  await app.evaluate(`window.api.setSettings(${JSON.stringify(settingsPatch)}).then((s) => (state.settings = s, true))`);

  // ---------- 1. bridge security ----------
  const extOrigin = { Origin: `chrome-extension://${EXT_ID}`, Host: `127.0.0.1:${BRIDGE}` };
  check((await bridgeRequest('POST', '/v1/status', { Host: `127.0.0.1:${BRIDGE}` })).status === 403, 'bridge: request without extension Origin is refused');
  check((await bridgeRequest('POST', '/v1/status', { Origin: 'https://evil.example', Host: `127.0.0.1:${BRIDGE}` })).status === 403, 'bridge: a web page Origin is refused');
  check((await bridgeRequest('POST', '/v1/status', { ...extOrigin, Host: `evil.example:${BRIDGE}` })).status === 403, 'bridge: wrong Host (DNS rebinding) is refused');
  check((await bridgeRequest('POST', '/v1/download', { ...extOrigin, 'Content-Type': 'application/json' }, { url: `${BASE}/x.zip` })).status === 401, 'bridge: sending a download without pairing is refused');
  check((await bridgeRequest('POST', '/v1/download', { ...extOrigin, Authorization: 'Bearer 1234' }, { url: `${BASE}/x.zip` })).status === 401, 'bridge: a made-up token is refused');

  // ---------- 2. Edge with the extension ----------
  edge = spawn(EDGE, [
    `--user-data-dir=${edgeProfile}`, '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${EDGE_DEBUG}`,
    `--load-extension=${path.join(ROOT, 'extension')}`, `--disable-extensions-except=${path.join(ROOT, 'extension')}`,
    'about:blank',
  ], { stdio: 'ignore' });
  await waitFor(() => edgeJson('/json/version').catch(() => null), 20000);
  let sw = await extensionWorker();
  check(!!sw, `extension loaded in Edge (id ${EXT_ID})`);
  await sw.evaluate(`chrome.storage.local.set({ port: ${BRIDGE} })`);

  // ---------- 3. pairing ----------
  const popup = await openEdgeTab(`chrome-extension://${EXT_ID}/popup.html`);
  const popupStatus = () => popup.evaluate(`document.querySelector('#status')?.dataset.state || ''`).catch(() => '');
  await waitFor(async () => (await popupStatus()) === 'notPaired', 10000);
  const firstStatus = await popupStatus();
  check(firstStatus === 'notPaired', `popup says "not connected yet" (state: ${firstStatus})`);
  await popup.shot(path.join(SHOTS, 'p3-1-popup-not-paired.png'));
  await popup.evaluate(`document.querySelector('#btn-connect').click(), true`);
  const pairName = await waitFor(() => app.evaluate(`document.querySelector('#dlg-pair').open && document.querySelector('#pair-name').textContent`), 10000);
  check(/Edge/.test(pairName || ''), `app asks to allow the pairing: "${pairName}"`);
  await app.shot(path.join(SHOTS, 'p3-2-app-pair-request.png'));
  await app.evaluate(`document.querySelector('#btn-pair-allow').click()`);
  await waitFor(async () => (await popupStatus()) === 'connected', 10000);
  check((await popupStatus()) === 'connected', 'popup shows "connected" after allowing');
  const swStatus = await sw.evaluate('getStatus()');
  check(swStatus === 'connected', `extension checks the app and sees "connected" (${swStatus})`);
  const token = (await sw.evaluate(`chrome.storage.local.get('token')`)).token;
  const settingsText = fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8');
  check(token && token.length === 64 && !settingsText.includes(token) && JSON.parse(settingsText).browserClients.length === 1,
    'app stores only a hash of the token');

  // ---------- 4. click a login-protected file on a website ----------
  const page = await openEdgeTab(`${BASE}/site/login`); // sets the cookie, redirects to page.html
  await waitFor(() => page.evaluate(`location.pathname === '/site/page.html' && document.readyState === 'complete'`).catch(() => false), 15000);
  await sleep(1500); // let the video start loading
  await page.click('#dl');
  const dialog = await waitFor(() => app.evaluate(`(() => { const d = document.querySelector('#dlg-add'); const i = document.querySelector('#probe-info');
    return d.open && !i.hidden && !i.classList.contains('loading') && { url: document.querySelector('#in-url').value,
      name: document.querySelector('#in-name').value, info: i.textContent, dir: document.querySelector('#in-dir').value,
      fromBrowser: !document.querySelector('#add-from-browser').hidden }; })()`), 20000);
  check(dialog && dialog.url === `${BASE}/site/protected/archive.zip` && dialog.fromBrowser, `clicking the link opened the app's dialog (${dialog && dialog.url})`);
  check(dialog && /40\.0/.test(dialog.info), `link check used the browser's cookie + Referer: "${dialog && dialog.info}"`);
  check(dialog && dialog.dir === path.join(outDir, 'Compressed'), 'zip goes to Compressed folder');
  await app.shot(path.join(SHOTS, 'p3-3-app-dialog-from-browser.png'));
  // Slow it down so we can restart the app in the middle.
  await app.evaluate(`document.querySelector('#in-limit').value = 400; document.querySelector('#form-add').requestSubmit()`);

  const browserItems = await waitFor(async () => {
    const list = await sw.evaluate(`chrome.downloads.search({})`);
    return list.length && list;
  }, 5000, 500);
  const edgeKept = (browserItems || []).filter((d) => /archive\.zip/.test(d.filename || d.url) && d.state !== 'interrupted');
  check(edgeKept.length === 0, 'Edge cancelled its own copy of the download');

  const running = await waitFor(async () => (await items(app)).find((d) => d.name === 'archive.zip' && d.status === 'active'), 10000);
  check(!!running, 'app is downloading archive.zip');
  check(running && running.fromBrowser && !JSON.stringify(await items(app)).includes('abc123'), 'the UI never receives the cookie');
  await sleep(6000); // session is saved every 5s
  const session = () => fs.readFileSync(path.join(dataDir, 'aria2.session'), 'utf8');
  check(session().includes('archive.zip') && !session().includes('abc123') && !/header=/.test(session()), 'aria2 session file has no cookie');
  check(!fs.readFileSync(path.join(dataDir, 'downloads.json'), 'utf8').includes('abc123'), 'downloads.json keeps the cookie encrypted');

  // Restart the app in the middle of the download: the cookie must come back.
  await app.quit();
  check(!session().includes('abc123'), 'session file after quitting has no cookie');
  app = await launchApp({ dataDir, env: appEnv });
  const resumed = await waitFor(async () => {
    const d = (await items(app)).find((x) => x.name === 'archive.zip');
    return d && d.status === 'active' && d.completedLength > 0 && d;
  }, 15000);
  check(!!resumed, 'after restart the protected download continues by itself');
  await app.evaluate(`window.api.setLimit('${resumed ? resumed.gid : ''}', 0)`);
  const done = await waitFor(async () => {
    const d = (await items(app)).find((x) => x.name === 'archive.zip');
    return d && d.status !== 'active' && d;
  }, 90000, 1000);
  check(done && done.status === 'complete' && sha(done.path) === sha(srcFile), `archive.zip finished and is identical (${done && done.status} ${done && (done.errorMessage || '')})`);

  // ---------- 5. small files stay in the browser ----------
  await page.click('#small');
  const small = await waitFor(() => fs.existsSync(path.join(edgeDownloads, 'readme.txt')), 10000);
  check(small, 'small readme.txt was downloaded by Edge itself');
  check(!(await app.evaluate(`document.querySelector('#dlg-add').open`)), '...and did not open the app dialog');

  // ---------- 6. right-click "Download with Mido Downloada" ----------
  sw = await extensionWorker();
  const menuOk = await sw.evaluate(`handleMenuClick({ menuItemId: 'mido-download', linkUrl: '${BASE}/site/protected/from-menu.zip', pageUrl: '${BASE}/site/page.html' }, null)`);
  check(menuOk === true, 'right-click menu sent the link to the app');
  await waitFor(() => app.evaluate(`document.querySelector('#dlg-add').open && !document.querySelector('#probe-info').classList.contains('loading') && !document.querySelector('#probe-info').hidden`), 15000);
  await app.evaluate(`document.querySelector('#form-add').requestSubmit()`);
  const menuDone = await waitFor(async () => {
    const d = (await items(app)).find((x) => x.name === 'from-menu.zip');
    return d && d.status !== 'active' && d.status !== 'waiting' && d;
  }, 60000, 1000);
  check(menuDone && menuDone.status === 'complete', `from-menu.zip (login-protected) completed (${menuDone && menuDone.status})`);
  const contextMenuTitle = await sw.evaluate(`chrome.i18n.getMessage('menuDownload')`);
  check(!!contextMenuTitle, `menu item title: "${contextMenuTitle}"`);

  // ---------- 7. videos found on the page ----------
  const media = await sw.evaluate(`chrome.storage.session.get('media:' + ${JSON.stringify(page.id)}).catch(() => ({}))`).catch(() => ({}));
  void media; // tab ids differ from target ids; use the popup instead
  const tabId = await popup.evaluate(`chrome.tabs.query({ url: '${BASE}/site/page.html' }).then((t) => t[0].id)`);
  const badge = await popup.evaluate(`chrome.action.getBadgeText({ tabId: ${tabId} })`);
  check(badge === '1', `extension badge shows 1 video on the page (badge "${badge}")`);
  await popup.send('Page.navigate', { url: `chrome-extension://${EXT_ID}/popup.html?tab=${tabId}` });
  const mediaRow = await waitFor(() => popup.evaluate(`(() => { const li = document.querySelector('#media li'); return li && li.textContent; })()`).catch(() => null), 10000);
  check(/clip\.mp4/.test(mediaRow || '') && /40\.0 MB/.test(mediaRow || ''), `popup lists the video: "${mediaRow}"`);
  await popup.shot(path.join(SHOTS, 'p3-4-popup-media.png'));
  await popup.evaluate(`document.querySelector('#media li button').click(), true`);
  await sleep(2500);
  console.log('   media button after click:', await popup.evaluate(`document.querySelector('#media li button').textContent`));
  await waitFor(() => app.evaluate(`document.querySelector('#dlg-add').open && !document.querySelector('#probe-info').classList.contains('loading') && !document.querySelector('#probe-info').hidden`), 15000);
  check((await app.evaluate(`document.querySelector('#in-dir').value`)) === path.join(outDir, 'Video'), 'video goes to the Video folder');
  await app.evaluate(`document.querySelector('#form-add').requestSubmit()`);
  const clipDone = await waitFor(async () => {
    const d = (await items(app)).find((x) => x.name === 'clip.mp4');
    return d && d.status !== 'active' && d.status !== 'waiting' && d;
  }, 60000, 1000);
  check(clipDone && clipDone.status === 'complete', 'video from the page downloaded');
  await app.shot(path.join(SHOTS, 'p3-5-app-list.png'));

  // ---------- 8. unpairing from the app ----------
  await app.evaluate(`window.api.setSettings({ browserClients: [] })`);
  sw = await extensionWorker();
  const afterUnpair = await sw.evaluate('getStatus()');
  check(afterUnpair === 'notPaired', `after "Disconnect" in the app, the extension is no longer paired (${afterUnpair})`);
  const fallback = await sw.evaluate(`sendToApp({ url: '${BASE}/site/protected/archive.zip', source: 'click' })`);
  check(fallback === false, '...and can no longer send downloads (browser keeps them)');

  const stats = await (await fetch(`${BASE}/__stats`)).json();
  check(stats.allowed > 0, `protected file server: ${stats.allowed} allowed, ${stats.denied} refused requests`);

  await app.quit();
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Close only the test copies of the app and Edge (never the user's own windows).
    if (app && app.proc.exitCode === null) await Promise.race([app.quit(), sleep(8000)]);
    if (edge && edge.exitCode === null) {
      try {
        const v = await edgeJson('/json/version');
        const b = await connectTarget(v.webSocketDebuggerUrl);
        b.send('Browser.close');
      } catch {}
      await Promise.race([new Promise((r) => edge.once('exit', r)), sleep(8000)]);
    }
    server.kill();
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
        break;
      } catch {
        await sleep(1000); // Edge helper processes can hold files for a moment
      }
    }
  });
