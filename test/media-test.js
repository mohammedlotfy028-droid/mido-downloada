// Video sites (yt-dlp + ffmpeg) on the real app:
//  - a real YouTube clip ("Me at the zoo", 19 s) through the add dialog: 240p video and MP3
//  - a local HLS stream, pause / resume / app restart on a slow local video
//  - a video that doesn't exist (no retry), yt-dlp self-update from a fake GitHub release
//    (and one with a wrong SHA-256, which must be refused)
//  - the browser extension's "Download this video" button on a real YouTube page (Edge)
// Usage: node test/media-test.js <screenshotDir>
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { ROOT, sleep, check, waitFor, launchApp, connectTarget, items, rows } = require('./cdp');

const SHOTS = path.resolve(process.argv[2] || '.');
const PORT = 8775;
const BASE = `http://127.0.0.1:${PORT}`;
const YT = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'; // "Me at the zoo", 19 seconds
const FF = path.join(ROOT, 'resources', 'ffmpeg');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT_ID = 'deaodfooaihmngfdanpadajieidlcngd';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mido-media-'));
const dataDir = path.join(tmp, 'data');
const outDir = path.join(tmp, 'Downloads');
const staticDir = path.join(tmp, 'static');
fs.mkdirSync(path.join(staticDir, 'hls'), { recursive: true });
fs.mkdirSync(outDir);

// Test video: 90 s, H.264 + AAC, and an HLS copy of it (2 s pieces).
const clip = path.join(staticDir, 'clip.mp4');
execFileSync(path.join(FF, 'ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '90', '-c:v', 'libopenh264', '-b:v', '2000k', '-g', '60', '-c:a', 'aac', '-y', clip]);
execFileSync(path.join(FF, 'ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-i', clip, '-c', 'copy', '-f', 'hls', '-hls_time', '2',
  '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(staticDir, 'hls', 'seg%03d.ts'), '-y', path.join(staticDir, 'hls', 'index.m3u8')]);
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const probe = (f) => execFileSync(path.join(FF, 'ffprobe.exe'), ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', f]).toString().trim().split(/\r?\n/).sort().join('+');

// /static = fast files; any other path = the clip, slowly (100 KB/s per connection).
const server = spawn(process.execPath, [path.join(__dirname, 'server.js'), clip, PORT, 100 * 1024], {
  stdio: 'ignore', env: { ...process.env, STATIC_DIR: staticDir },
});

// Fake "GitHub release API" for the yt-dlp update test.
const fakeRelease = { tag_name: '2099.01.01', assets: [] };
const relDir = path.join(tmp, 'release');
fs.mkdirSync(relDir);
const relServer = http.createServer((req, res) => {
  if (req.url === '/latest') return res.end(JSON.stringify(fakeRelease));
  const f = path.join(relDir, req.url.slice(1));
  if (!fs.existsSync(f)) return res.writeHead(404).end();
  res.end(fs.readFileSync(f));
}).listen(8776, '127.0.0.1');

let app;
let edge;
const env = { MIDO_TEST: '1', MIDO_BRIDGE_PORT: '47894', MIDO_YTDLP_RELEASE_API: 'http://127.0.0.1:8776/latest' };
const ytdlpRunning = () => execFileSync('tasklist', ['/FI', 'IMAGENAME eq yt-dlp.exe', '/NH']).toString().includes('yt-dlp.exe');
const item = async (pred) => (await items(app)).find(pred);
const finished = (pred, ms = 180000) => waitFor(async () => {
  const d = await item(pred);
  return d && !['active', 'waiting'].includes(d.status) && d;
}, ms, 1000);
const addMedia = (url, quality, title = '') =>
  app.evaluate(`window.api.add({ url: ${JSON.stringify(url)}, dir: ${JSON.stringify(outDir)}, title: ${JSON.stringify(title)}, mediaQuality: ${JSON.stringify(quality)} })`);
const dialogMedia = () => waitFor(() => app.evaluate(`!document.querySelector('#media-box').hidden && document.querySelector('#media-title').textContent`), 90000);

(async () => {
  app = await launchApp({ dataDir, env });
  await app.evaluate(`window.api.setSettings(${JSON.stringify({ downloadDir: outDir, categorize: false, clipboardWatch: false, notifications: false, maxConcurrent: 3 })}).then((s) => (state.settings = s, true))`);
  const tools = await app.evaluate('window.api.mediaToolsStatus()');
  check(tools.available && /^\d{4}\./.test(tools.version), `yt-dlp ready in the data folder (${tools.version})`);

  // ---------- 1. real YouTube through the dialog ----------
  await app.evaluate(`openAddDialog('${YT}')`);
  const title = await dialogMedia();
  check(title === 'Me at the zoo', `dialog shows the YouTube video: "${title}"`);
  const opts = await app.evaluate(`[...document.querySelectorAll('#in-quality option')].map((o) => o.value)`);
  check(opts.includes('v:240') && opts.includes('a:mp3'), `qualities offered: ${opts.join(', ')}`);
  await app.shot(path.join(SHOTS, 'media-1-dialog.png'));
  await app.evaluate(`document.querySelector('#in-quality').value = 'v:240'; document.querySelector('#form-add').requestSubmit()`);
  const v = await finished((d) => d.kind === 'media' && /zoo/.test(d.name) && d.quality.type === 'video');
  check(v && v.status === 'complete' && v.name.endsWith('.mp4'), `YouTube video downloaded: ${v && v.name} (${v && v.status} ${v && (v.errorMessage || '')})`);
  check(v && probe(v.path) === 'audio+video', `...with picture and sound joined in one MP4 (${v && probe(v.path)})`);

  await app.evaluate(`openAddDialog('${YT}')`);
  await dialogMedia();
  await app.evaluate(`document.querySelector('#in-quality').value = 'a:mp3'; document.querySelector('#form-add').requestSubmit()`);
  const a = await finished((d) => d.kind === 'media' && d.quality.type === 'audio');
  check(a && a.status === 'complete' && a.name.endsWith('.mp3') && probe(a.path) === 'audio', `audio only as MP3: ${a && a.name}`);

  // A video that doesn't exist: refused right in the dialog.
  await app.evaluate(`openAddDialog('https://www.youtube.com/watch?v=aaaaaaaaaaa')`);
  const bad = await waitFor(() => app.evaluate(`(() => { const p = document.querySelector('#probe-info'); return p.classList.contains('warn') && p.textContent; })()`), 90000);
  check(!!bad, `a missing video shows an error instead of starting: "${(bad || '').split('\n')[0].slice(0, 90)}"`);
  await app.evaluate(`document.querySelector('#dlg-add').close()`);

  // ---------- 2. local HLS stream ----------
  await addMedia(`${BASE}/static/hls/index.m3u8`, { type: 'video', height: 0 }, 'hls stream');
  const h = await finished((d) => d.url.endsWith('index.m3u8'));
  check(h && h.status === 'complete' && probe(h.path) === 'audio+video', `HLS stream downloaded and joined (${h && h.status} ${h && (h.errorMessage || '')})`);

  // ---------- 3. pause / resume / restart on a slow video ----------
  await addMedia(`${BASE}/slow/clip.mp4`, { type: 'video', height: 0 }, 'slow clip');
  const slow = (d) => d.url.endsWith('/slow/clip.mp4');
  let s = await waitFor(async () => {
    const d = await item(slow);
    return d && d.status === 'active' && d.completedLength > 300 * 1024 && d;
  }, 60000);
  check(!!s, `slow video is downloading (${s && Math.round(s.completedLength / 1024)} KB, ${s && Math.round(s.downloadSpeed / 1024)} KB/s)`);
  await app.shot(path.join(SHOTS, 'media-2-list.png'));
  await app.evaluate(`window.api.pause('${s.gid}')`);
  await sleep(2500);
  s = await item(slow);
  const pausedAt = s.completedLength;
  check(s.status === 'paused' && !ytdlpRunning(), `pause stops yt-dlp (at ${Math.round(pausedAt / 1024)} KB)`);
  await app.evaluate(`window.api.resume('${s.gid}')`);
  s = await waitFor(async () => {
    const d = await item(slow);
    return d && d.status === 'active' && d.completedLength > pausedAt + 100 * 1024 && d;
  }, 30000);
  check(!!s, `resume continues from there (${s && Math.round(s.completedLength / 1024)} KB)`);

  await app.quit();
  check(!ytdlpRunning(), 'quitting the app stops yt-dlp too');
  app = await launchApp({ dataDir, env });
  s = await waitFor(async () => {
    const d = await item(slow);
    return d && d.status === 'active' && d && d;
  }, 20000);
  check(!!s, 'after restart the video continues by itself');
  await app.evaluate(`window.api.setLimit('${s.gid}', 0)`); // (restarts yt-dlp; must still finish)
  const done = await finished(slow, 240000);
  check(done && done.status === 'complete' && sha(done.path) === sha(clip), `slow video finished and is identical to the original (${done && done.status})`);

  // ---------- 4. yt-dlp self-update ----------
  const before = (await app.evaluate('window.api.mediaToolsStatus()')).version;
  // A "new release": our own yt-dlp folder zipped, with its SHA-256 published next to it.
  const tar = path.join(process.env.SystemRoot, 'System32', 'tar.exe');
  execFileSync(tar, ['-a', '-cf', path.join(relDir, 'yt-dlp_win.zip'), '-C', path.join(ROOT, 'resources', 'yt-dlp'), 'yt-dlp.exe', '_internal']);
  const zipSha = sha(path.join(relDir, 'yt-dlp_win.zip'));
  fakeRelease.assets = [
    { name: 'yt-dlp_win.zip', browser_download_url: 'http://127.0.0.1:8776/yt-dlp_win.zip' },
    { name: 'SHA2-256SUMS', browser_download_url: 'http://127.0.0.1:8776/sums' },
  ];
  fs.writeFileSync(path.join(relDir, 'sums'), `${'0'.repeat(64)}  yt-dlp_win.zip\n`);
  let up = await app.evaluate('window.api.updateMediaTools()');
  check(/SHA-256/.test(up.result) && up.version === before, `a download with the wrong SHA-256 is refused (${up.result})`);
  fs.writeFileSync(path.join(relDir, 'sums'), `${zipSha}  yt-dlp_win.zip\n`);
  up = await app.evaluate('window.api.updateMediaTools()');
  check(up.result === 'updated', `update from the (fake) release works: ${up.result}`);
  await addMedia(`${BASE}/static/clip.mp4`, { type: 'video', height: 0 }, 'after update');
  const au = await finished((d) => d.url.endsWith('/static/clip.mp4'));
  check(au && au.status === 'complete', 'yt-dlp still works after the update');

  // ---------- 5. extension: "Download this video" on a YouTube page ----------
  const profile = path.join(tmp, 'edge');
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  edge = spawn(EDGE, [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=9445',
    `--load-extension=${path.join(ROOT, 'extension')}`, `--disable-extensions-except=${path.join(ROOT, 'extension')}`, 'about:blank'], { stdio: 'ignore' });
  const ej = (p, m = 'GET') => fetch(`http://127.0.0.1:9445${p}`, { method: m }).then((r) => r.json());
  await waitFor(() => ej('/json/version').catch(() => null), 20000);
  const sw = await waitFor(async () => {
    const t = (await ej('/json')).find((x) => x.type === 'service_worker' && x.url.includes(EXT_ID));
    if (!t) return null;
    const c = await connectTarget(t.webSocketDebuggerUrl).catch(() => null);
    return c && (await c.evaluate(`typeof getStatus === 'function'`).catch(() => false)) ? c : null;
  }, 20000, 500);
  await sw.evaluate(`chrome.storage.local.set({ port: 47894 })`);
  const popupT = await ej(`/json/new?chrome-extension://${EXT_ID}/popup.html`, 'PUT');
  const popup = await connectTarget(popupT.webSocketDebuggerUrl);
  await waitFor(() => popup.evaluate(`document.querySelector('#status')?.dataset.state === 'notPaired'`).catch(() => false), 15000);
  await popup.evaluate(`document.querySelector('#btn-connect').click(), true`);
  await waitFor(() => app.evaluate(`document.querySelector('#dlg-pair').open`), 15000);
  await app.evaluate(`document.querySelector('#btn-pair-allow').click()`);
  await waitFor(() => popup.evaluate(`document.querySelector('#status').dataset.state === 'connected'`).catch(() => false), 15000);
  const ytTab = await ej(`/json/new?${encodeURI(YT)}`, 'PUT');
  await sleep(6000);
  const tabId = await popup.evaluate(`chrome.tabs.query({}).then((t) => t.find((x) => /youtube\\.com\\/watch/.test(x.url)).id)`);
  await popup.send('Page.navigate', { url: `chrome-extension://${EXT_ID}/popup.html?tab=${tabId}` });
  const pv = await waitFor(() => popup.evaluate(`!document.querySelector('#page-video').hidden && document.querySelector('#pv-site').textContent + ' | ' + document.querySelector('#pv-title').textContent`).catch(() => null), 15000);
  check(/YouTube/.test(pv || ''), `popup on a YouTube page offers "Download this video": "${pv}"`);
  check(await popup.evaluate(`document.querySelector('#media-heading').classList.contains('gone')`), '...and hides the (useless there) list of page pieces');
  await popup.shot(path.join(SHOTS, 'media-3-popup.png'));
  await popup.evaluate(`document.querySelector('#btn-page').click(), true`);
  const fromExt = await dialogMedia();
  check(fromExt === 'Me at the zoo' && (await app.evaluate(`!document.querySelector('#add-from-browser').hidden`)), `...and the app opens it as a video, marked "from browser" ("${fromExt}")`);
  const cookieCount = await sw.evaluate(`cookieList('${YT}').then((l) => l.length)`);
  check(cookieCount > 0, `extension sends the site's cookies with their domains (${cookieCount} cookies)`);
  await app.evaluate(`document.querySelector('#dlg-add').close()`);
  void ytTab;

  await app.quit();
  app = null;
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (app && app.proc.exitCode === null) await Promise.race([app.quit(), sleep(8000)]);
    if (edge && edge.exitCode === null) {
      try {
        const v = await (await fetch('http://127.0.0.1:9445/json/version')).json();
        (await connectTarget(v.webSocketDebuggerUrl)).send('Browser.close');
      } catch {}
      await Promise.race([new Promise((r) => edge.once('exit', r)), sleep(8000)]);
    }
    server.kill();
    relServer.close();
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
        break;
      } catch {
        await sleep(1000);
      }
    }
  });
