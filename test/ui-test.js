// Phase 1 acceptance test on the real app window:
// add a download from the dialog -> pause -> quit -> reopen -> resume ->
// "internet" drop (test server killed) -> completes. Saves screenshots along the way.
// Usage: node test/ui-test.js <screenshotDir> [realUrl]
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sleep, check, aria2Running, waitFor, launchApp, rows } = require('./cdp');

const SHOTS = path.resolve(process.argv[2] || '.');
const REAL_URL = process.argv[3];
const PORT = 8766;
const SIZE = 60 * 1024 * 1024;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mido-ui-'));
const dataDir = path.join(tmp, 'data');
const outDir = path.join(tmp, 'out');
fs.mkdirSync(outDir);
const srcFile = path.join(tmp, 'video-sample.mp4');
fs.writeFileSync(srcFile, crypto.randomBytes(SIZE));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

let server;
const startServer = () =>
  (server = spawn(process.execPath, [path.join(__dirname, 'server.js'), srcFile, PORT, 160 * 1024], { stdio: 'ignore' }));

async function boot() {
  const app = await launchApp({ dataDir });
  // Keep everything inside the temp folder and don't pop up anything on the desktop.
  await app.evaluate(`window.api.setSettings(${JSON.stringify({
    downloadDir: outDir, categorize: false, clipboardWatch: false, notifications: false,
  })}).then((s) => (state.settings = s))`);
  return app;
}

async function addViaDialog(app, url, split) {
  await app.evaluate(`document.querySelector('#btn-add').click()`);
  await app.evaluate(`(() => {
    const u = document.querySelector('#in-url'); u.value = ${JSON.stringify(url)}; u.dispatchEvent(new Event('input'));
    const s = document.querySelector('#in-split'); s.value = ${split}; s.dispatchEvent(new Event('input'));
  })()`);
  // Wait for the link check to finish so it doesn't change fields after we submit.
  await waitFor(() => app.evaluate(`!document.querySelector('#probe-info').classList.contains('loading') && !document.querySelector('#probe-info').hidden`), 15000);
}
const first = async (app) => (await rows(app))[0];

(async () => {
  startServer();
  await sleep(500);

  // ---- run 1: add, download, pause, quit ----
  let app = await boot();
  check(aria2Running(), 'aria2 started in the background');
  await addViaDialog(app, `http://127.0.0.1:${PORT}/video-sample.mp4`, 12);
  await app.shot(path.join(SHOTS, '1-add-dialog.png'));
  await app.evaluate(`document.querySelector('#form-add').requestSubmit()`);
  await sleep(4000);
  let row = await first(app);
  check(row && row.status === 'active', `downloading: ${row && row.pct} at ${row && row.speed}`);
  await app.shot(path.join(SHOTS, '2-downloading.png'));

  await app.evaluate(`document.querySelector('#rows tr [data-act=pause]').click()`);
  await sleep(1500);
  row = await first(app);
  const pausedPct = row.pct;
  check(row.status === 'paused', `paused at ${pausedPct}`);

  await app.evaluate(`document.querySelector('#btn-lang').click()`);
  await app.evaluate(`document.querySelector('#btn-theme').click()`);
  await sleep(800);
  await app.shot(path.join(SHOTS, '3-paused-en-dark.png'));

  await app.quit();
  await sleep(500);
  check(!aria2Running(), 'aria2 stopped when the app quit');

  // ---- run 2: reopen, resume, network drop, complete ----
  app = await boot();
  await sleep(1500);
  row = await first(app);
  check(row && row.status === 'paused' && row.pct === pausedPct, `after reopen still paused at ${row && row.pct}`);
  await app.evaluate(`document.querySelector('#rows tr [data-act=resume]').click()`);
  await sleep(3000);
  row = await first(app);
  check(row.status === 'active', `resumed from ${pausedPct} -> ${row.pct}`);

  server.kill();
  console.log('-- test server killed (internet down) for 10s');
  await sleep(10000);
  row = await first(app);
  check(row.status === 'active', `still retrying while offline (${row.pct})`);
  startServer();
  row = await waitFor(async () => {
    const r = await first(app);
    return r.status !== 'active' && r;
  }, 120000, 1000);
  check(row && row.status === 'complete', `completed by itself after the network came back`);
  const outFile = path.join(outDir, 'video-sample.mp4');
  check(fs.existsSync(outFile) && sha(outFile) === sha(srcFile), 'downloaded file matches the original');

  // ---- optional: a real file from the internet ----
  if (REAL_URL) {
    await addViaDialog(app, REAL_URL, 8);
    await app.evaluate(`document.querySelector('#form-add').requestSubmit()`);
    await sleep(3000);
    await app.shot(path.join(SHOTS, '4-real-download.png'));
    row = await waitFor(async () => {
      const r = await first(app);
      return !['active', 'waiting'].includes(r.status) && r;
    }, 180000, 1000);
    check(row && row.status === 'complete', `real internet download: ${row && row.name} ${row && row.size}`);
  }

  await app.quit();
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => {
  console.error(e);
  server && server.kill();
  process.exit(1);
});
