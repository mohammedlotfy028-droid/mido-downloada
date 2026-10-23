// Phase 2 test on the real app window: link check + auto categories, settings dialog,
// queue + max concurrent, speed limits, site login + User-Agent, auto-retry, failure
// notification, drag & drop, clipboard watching, close-to-tray.
// Usage: node test/phase2-test.js <screenshotDir>
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sleep, check, aria2Running, waitFor, launchApp, launchSecondInstance, rows, items } = require('./cdp');

const SHOTS = path.resolve(process.argv[2] || '.');
const PORT = 8767;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mido-p2-'));
const dataDir = path.join(tmp, 'data');
const outDir = path.join(tmp, 'Downloads');
fs.mkdirSync(outDir);
const srcFile = path.join(tmp, 'src.bin');
fs.writeFileSync(srcFile, crypto.randomBytes(40 * 1024 * 1024));

// 512 KB/s per connection -> about 4 MB/s per download with 8 connections.
const server = spawn(process.execPath, [path.join(__dirname, 'server.js'), srcFile, PORT, 512 * 1024], { stdio: 'ignore' });

const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd]).toString();
const kb = (bps) => `${Math.round(bps / 1024)} KB/s`;

(async () => {
  await sleep(500);
  let app = await launchApp({ dataDir });
  const ev = app.evaluate;
  const setSettings = (patch) => ev(`window.api.setSettings(${JSON.stringify(patch)}).then((s) => (state.settings = s, true))`);
  const find = async (name) => (await items(app)).find((d) => d.name === name);
  const addDirect = async (url) =>
    ev(`window.api.probe(${JSON.stringify(url)}).then((p) => window.api.add({ url: ${JSON.stringify(url)}, dir: p.dir, split: 8, category: p.category }))`);

  await setSettings({ downloadDir: outDir, categorize: true, clipboardWatch: false, notifications: false, maxConcurrent: 3 });

  // ---------- A. link check + automatic category folder ----------
  await ev(`document.querySelector('#btn-add').click()`);
  await ev(`(() => { const u = document.querySelector('#in-url'); u.value = '${BASE}/media/movie.mp4'; u.dispatchEvent(new Event('input')); })()`);
  const probed = await waitFor(() => ev(`(() => { const i = document.querySelector('#probe-info');
    return !i.hidden && !i.classList.contains('loading') && { info: i.textContent, name: document.querySelector('#in-name').value, dir: document.querySelector('#in-dir').value }; })()`), 15000);
  check(probed && probed.name === 'movie.mp4', `link check found the name: ${probed && probed.name}`);
  check(probed && /40\.0/.test(probed.info), `link check found size/type: "${probed && probed.info}"`);
  check(probed && probed.dir === path.join(outDir, 'Video'), `video goes to Video folder: ${probed && probed.dir}`);
  await app.shot(path.join(SHOTS, 'p2-1-add-probe.png'));
  await ev(`document.querySelector('#form-add').requestSubmit()`);

  // ---------- B. settings dialog: queue size, global limit, User-Agent, site login ----------
  await ev(`document.querySelector('#btn-settings').click()`);
  await ev(`document.querySelector('[data-tab=connection]').click()`);
  await ev(`(() => {
    document.querySelector('#s-concurrent').value = 1;
    document.querySelector('#s-limit').value = 600;
    document.querySelector('#s-ua').value = 'MidoTest/1.0';
  })()`);
  await app.shot(path.join(SHOTS, 'p2-2-settings-connection.png'));
  await ev(`document.querySelector('[data-tab=logins]').click()`);
  await ev(`(() => {
    document.querySelector('#s-add-login').click();
    const r = document.querySelector('#s-logins .login-row:last-child');
    r.querySelector('.l-host').value = '127.0.0.1';
    r.querySelector('.l-user').value = 'test';
    r.querySelector('.l-pass').value = 'secret';
  })()`);
  await app.shot(path.join(SHOTS, 'p2-3-settings-logins.png'));
  await ev(`document.querySelector('#dlg-settings button[value=ok]').click()`);
  await sleep(500);
  const saved = fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8');
  check(JSON.parse(saved).maxConcurrent === 1 && JSON.parse(saved).userAgent === 'MidoTest/1.0', 'settings dialog saved');
  check(!saved.includes('"secret"') && JSON.parse(saved).logins[0].pass.length > 20, 'site password is stored encrypted, not as plain text');

  // ---------- C. queue ----------
  await addDirect(`${BASE}/media/song.mp3`);
  await addDirect(`${BASE}/media/setup.exe`);
  await sleep(2000);
  let list = await items(app);
  const active = list.filter((d) => d.status === 'active');
  const waiting = list.filter((d) => d.status === 'waiting').sort((a, b) => a.queuePos - b.queuePos);
  check(active.length === 1 && waiting.length === 2, `max 1 at a time: ${active.length} active, ${waiting.length} queued`);
  const lastInQueue = waiting[waiting.length - 1];
  await ev(`window.api.move('${lastInQueue.gid}', 'top')`);
  await sleep(1200);
  check((await find(lastInQueue.name)).queuePos === 1, `"${lastInQueue.name}" moved to the top of the queue`);
  await app.shot(path.join(SHOTS, 'p2-4-queue.png'));

  // ---------- D. speed limits ----------
  await sleep(4000);
  let a = (await items(app)).find((d) => d.status === 'active');
  check(a.downloadSpeed > 0 && a.downloadSpeed <= 680 * 1024, `global limit 600 KB/s: ${kb(a.downloadSpeed)}`);
  await ev(`window.api.setLimit('${a.gid}', 150)`);
  // aria2's speed is a moving average, so give it time to settle after the change.
  const limited = await waitFor(async () => {
    const d = await find(a.name);
    return d.downloadSpeed > 0 && d.downloadSpeed <= 175 * 1024 && d;
  }, 25000, 1000);
  a = limited || (await find(a.name));
  check(!!limited, `per-file limit 150 KB/s: ${kb(a.downloadSpeed)}`);
  await ev(`window.api.setLimit('${a.gid}', 0)`);
  await setSettings({ speedLimit: 0, maxConcurrent: 5 });
  await sleep(4000);
  list = await items(app);
  check(list.filter((d) => d.status === 'active').length === 3, 'after raising the limit all 3 run together');
  const fast = list.reduce((s, d) => s + d.downloadSpeed, 0);
  check(fast > 2 * 1024 * 1024, `limits removed, total ${kb(fast)}`);

  // ---------- E. site login + User-Agent are sent ----------
  await addDirect(`${BASE}/auth/private.pdf`);
  await addDirect(`${BASE}/ua/tool.zip`);

  // ---------- F. automatic retry (server answers 400 twice, then works) ----------
  await addDirect(`${BASE}/fail-400-2/report.docx`);
  const retryText = await waitFor(async () => {
    const r = (await rows(app)).find((x) => x.name === 'report.docx');
    return r && /retry|إعادة/i.test(r.sub) && r.sub;
  }, 20000);
  check(!!retryText, `failed download shows a retry countdown: "${retryText}"`);
  await app.shot(path.join(SHOTS, 'p2-5-retry.png'));

  // ---------- G. permanent failure (404): no retry, notification ----------
  await setSettings({ notifications: true });
  await addDirect(`${BASE}/fail-404-0/missing.zip`);
  const missing = await waitFor(async () => {
    const d = await find('missing.zip');
    return d && d.status === 'error' && d;
  }, 20000);
  await sleep(1500);
  check(missing && !missing.retryAt, '404 is not retried');
  check(app.logs.join('').includes('[notify] shown'), `failure notification shown (${(app.logs.join('').match(/\[notify\][^\n]*/) || ['none'])[0]})`);
  await setSettings({ notifications: false });

  // Everything else should finish now.
  const done = await waitFor(async () => {
    const l = await items(app);
    const pending = l.filter((d) => d.name !== 'missing.zip' && d.status !== 'complete');
    return pending.length === 0 && l;
  }, 180000, 1000);
  check(!!done, 'all other downloads completed');
  const report = done && done.find((d) => d.name === 'report.docx');
  // The link check uses up one of the server's two failures, so aria2 itself sees 1 or 2.
  check(report && report.status === 'complete' && report.retries >= 1,`report.docx completed after ${report && report.retries} automatic retries`);
  check(done && done.find((d) => d.name === 'private.pdf')?.status === 'complete', 'download with site login completed');
  check(done && done.find((d) => d.name === 'tool.zip')?.status === 'complete', 'download that needs the custom User-Agent completed');
  for (const [file, folder] of [['movie.mp4', 'Video'], ['song.mp3', 'Music'], ['setup.exe', 'Programs'], ['tool.zip', 'Compressed'], ['private.pdf', 'Documents']]) {
    check(fs.existsSync(path.join(outDir, folder, file)), `${file} saved in ${folder}\\`);
  }
  await app.shot(path.join(SHOTS, 'p2-6-done.png'));

  // ---------- H. drag & drop a link ----------
  await ev(`(() => { const dt = new DataTransfer(); dt.setData('text/uri-list', '${BASE}/drop/dropped.iso');
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); })()`);
  await sleep(500);
  check(await ev(`document.querySelector('#dlg-add').open && document.querySelector('#in-url').value === '${BASE}/drop/dropped.iso'`), 'dropping a link opens the add dialog with it');
  await ev(`document.querySelector('#dlg-add').close()`);

  // ---------- I. clipboard watching ----------
  await setSettings({ clipboardWatch: true });
  // Save/restore the user's clipboard as UTF-8 base64 so Arabic text survives.
  const oldClip = ps('$t = Get-Clipboard -Raw; if ($t) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)) }').trim();
  ps(`Set-Clipboard -Value '${BASE}/clip/copied-video.mkv'`);
  const clipOk = await waitFor(() => ev(`document.querySelector('#dlg-add').open && document.querySelector('#in-url').value`), 5000);
  check(clipOk === `${BASE}/clip/copied-video.mkv`, `copying a file link opens the add dialog (${clipOk})`);
  await app.shot(path.join(SHOTS, 'p2-7-clipboard.png'));
  ps('Set-Clipboard -Value "https://example.com/page"'); // a page link must NOT trigger
  await ev(`document.querySelector('#dlg-add').close()`);
  await sleep(2000);
  check(!(await ev(`document.querySelector('#dlg-add').open`)), 'copying a normal page link does nothing');
  if (oldClip) ps(`Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${oldClip}')))`);

  // ---------- J. close to tray, then open again ----------
  await ev('setTimeout(() => window.close(), 50), true');
  await sleep(6000); // a real shutdown takes ~4s, so this would catch it
  check(app.proc.exitCode === null && aria2Running(), 'closing the window keeps the app running in the tray');
  await launchSecondInstance(dataDir); // like clicking the app icon again
  await app.reattach();
  const restored = await app.evaluate('document.querySelectorAll("#rows tr").length');
  check(restored >= 7, `starting it again brings the window back with the list (${restored} rows)`);
  await app.shot(path.join(SHOTS, 'p2-8-reopened.png'));

  // ---------- K. passwords never reach aria2's session file; logins come back after restart ----------
  const sessionFile = path.join(dataDir, 'aria2.session');
  const noSecrets = () => {
    const s = fs.readFileSync(sessionFile, 'utf8');
    return s.includes('auth/big-private.pdf') && !s.includes('secret') && !s.includes('passwd');
  };
  await app.evaluate(`window.api.probe('${BASE}/auth/big-private.pdf').then((p) => window.api.add({ url: '${BASE}/auth/big-private.pdf', dir: p.dir, split: 4, speedLimit: 200 }))`);
  const running = await waitFor(async () => (await items(app)).find((d) => d.name === 'big-private.pdf' && d.status === 'active'), 10000);
  check(!!running, 'login-protected download is running');
  await sleep(6000); // the app saves the session every 5s
  check(noSecrets(), 'session file saved while running has no username/password');

  await app.quit();
  await sleep(500);
  check(!aria2Running(), 'quit from tray menu stops aria2');
  check(noSecrets(), 'session file after quitting has no username/password');

  app = await launchApp({ dataDir });
  const back = await waitFor(async () => {
    const d = (await items(app)).find((x) => x.name === 'big-private.pdf');
    return d && d.status === 'active' && d.completedLength > 0 && d;
  }, 15000);
  check(!!back, `download that was running continues by itself after restart (${back && Math.round((back.completedLength / back.totalLength) * 100)}%)`);
  await app.evaluate(`window.api.setLimit('${back ? back.gid : ''}', 0)`);
  const finished = await waitFor(async () => {
    const d = (await items(app)).find((x) => x.name === 'big-private.pdf');
    return d && d.status !== 'active' && d;
  }, 60000, 1000);
  check(finished && finished.status === 'complete', `...and finishes with the login restored (${finished && finished.status} ${finished && (finished.errorMessage || '')})`);
  await app.quit();
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => {
  console.error(e);
  server.kill();
  process.exit(1);
});
