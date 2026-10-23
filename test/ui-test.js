// Drives the real Electron app through the Chrome DevTools Protocol:
// add a download from the dialog -> pause -> close the window -> reopen -> resume ->
// "internet" drop (test server killed) -> completes. Saves screenshots along the way.
// Usage: node test/ui-test.js <screenshotDir> [realUrl]
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..');
const SHOTS = path.resolve(process.argv[2] || '.');
const REAL_URL = process.argv[3];
const PORT = 8766;
const DEBUG_PORT = 9333;
const SIZE = 60 * 1024 * 1024;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mido-ui-'));
const dataDir = path.join(tmp, 'data');
const outDir = path.join(tmp, 'out');
fs.mkdirSync(outDir);
const srcFile = path.join(tmp, 'video-sample.mp4');
fs.writeFileSync(srcFile, crypto.randomBytes(SIZE));

let server;
const startServer = () =>
  (server = spawn(process.execPath, [path.join(__dirname, 'server.js'), srcFile, PORT, 160 * 1024], { stdio: 'ignore' }));

function check(cond, msg) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) process.exitCode = 1;
}

function aria2Running() {
  return execSync('tasklist /FI "IMAGENAME eq aria2c.exe" /NH').toString().includes('aria2c.exe');
}

async function launchApp() {
  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const proc = spawn(electron, [ROOT, `--remote-debugging-port=${DEBUG_PORT}`], {
    env: { ...process.env, MIDO_DATA_DIR: dataDir },
    stdio: 'ignore',
  });
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
      target = list.find((x) => x.type === 'page');
    } catch {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + expr);
    return r.result.result.value;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.result.data, 'base64'));
  };
  const exited = new Promise((r) => proc.once('exit', r));
  // Wait until the UI is ready.
  for (let i = 0; i < 40; i++) {
    if (await evaluate('!!(window.api && document.querySelector("#btn-add").textContent)').catch(() => false)) break;
    await sleep(250);
  }
  return { proc, evaluate, shot, exited, ws };
}

const rowState = (app) =>
  app.evaluate(`(() => { const r = document.querySelector('#rows tr'); if (!r) return null;
    return { status: r.dataset.status, gid: r.dataset.gid, name: r.querySelector('.name').textContent,
      pct: r.querySelector('.pct').textContent, speed: r.querySelector('.c-speed').textContent,
      eta: r.querySelector('.c-eta').textContent, size: r.querySelector('.c-size').textContent }; })()`);

async function addViaDialog(app, url, dir, split) {
  await app.evaluate(`document.querySelector('#btn-add').click()`);
  await app.evaluate(`(() => {
    document.querySelector('#in-url').value = ${JSON.stringify(url)};
    document.querySelector('#in-dir').value = ${JSON.stringify(dir)};
    const s = document.querySelector('#in-split'); s.value = ${split}; s.dispatchEvent(new Event('input'));
  })()`);
}

(async () => {
  startServer();
  await sleep(500);

  // ---- run 1: add, download, pause, close ----
  let app = await launchApp();
  check(aria2Running(), 'aria2 started in the background');
  await addViaDialog(app, `http://127.0.0.1:${PORT}/video-sample.mp4`, outDir, 12);
  await app.shot('1-add-dialog.png');
  await app.evaluate(`document.querySelector('#form-add').requestSubmit()`);
  await sleep(4000);
  let row = await rowState(app);
  check(row && row.status === 'active', `downloading: ${JSON.stringify(row)}`);
  await app.shot('2-downloading.png');

  await app.evaluate(`document.querySelector('#rows tr [data-act=pause]').click()`);
  await sleep(1500);
  row = await rowState(app);
  const pausedPct = row.pct;
  check(row.status === 'paused', `paused at ${pausedPct}`);

  // Switch to English + dark for a screenshot of the other look.
  await app.evaluate(`document.querySelector('#btn-lang').click()`);
  await app.evaluate(`document.querySelector('#btn-theme').click()`);
  await sleep(800);
  await app.shot('3-paused-en-dark.png');

  await app.evaluate('window.close()');
  await app.exited;
  await sleep(500);
  check(!aria2Running(), 'aria2 stopped when the app was closed');

  // ---- run 2: reopen, resume, network drop, complete ----
  app = await launchApp();
  await sleep(1500);
  row = await rowState(app);
  check(row && row.status === 'paused' && row.pct === pausedPct, `after reopen still paused at ${row && row.pct}`);
  await app.evaluate(`document.querySelector('#rows tr [data-act=resume]').click()`);
  await sleep(3000);
  row = await rowState(app);
  check(row.status === 'active', `resumed from ${pausedPct} -> ${row.pct}`);

  server.kill();
  console.log('-- test server killed (internet down) for 10s');
  await sleep(10000);
  row = await rowState(app);
  check(row.status === 'active', `still retrying while offline (${row.pct}, speed ${row.speed})`);
  startServer();
  for (let i = 0; i < 120; i++) {
    row = await rowState(app);
    if (row.status !== 'active') break;
    await sleep(1000);
  }
  check(row.status === 'complete', `completed by itself after the network came back (${row.status})`);
  const outFile = path.join(outDir, 'video-sample.mp4');
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  check(fs.existsSync(outFile) && sha(outFile) === sha(srcFile), 'downloaded file matches the original');

  // ---- optional: a real file from the internet ----
  if (REAL_URL) {
    await addViaDialog(app, REAL_URL, outDir, 8);
    await app.evaluate(`document.querySelector('#form-add').requestSubmit()`);
    await sleep(3000);
    await app.shot('4-real-download.png');
    for (let i = 0; i < 180; i++) {
      row = await rowState(app);
      if (row.status !== 'active' && row.status !== 'waiting') break;
      await sleep(1000);
    }
    check(row.status === 'complete', `real internet download: ${row.name} ${row.size} (${row.status})`);
  }
  await app.evaluate(`document.querySelector('#btn-lang').click()`);
  await sleep(600);
  await app.shot('5-final.png');

  await app.evaluate('window.close()');
  await app.exited;
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => {
  console.error(e);
  server && server.kill();
  process.exit(1);
});
