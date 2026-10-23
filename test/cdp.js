// Helpers to launch the real Electron app and control its window through the
// Chrome DevTools Protocol (used by ui-test.js and phase2-test.js).
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(cond, msg) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) process.exitCode = 1;
  return cond;
}

function aria2Running() {
  return execSync('tasklist /FI "IMAGENAME eq aria2c.exe" /NH').toString().includes('aria2c.exe');
}

/** Polls fn() until it returns something truthy (or times out). */
async function waitFor(fn, timeoutMs = 20000, every = 250) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  return null;
}

async function launchApp({ dataDir, debugPort = 9333, onLog } = {}) {
  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const proc = spawn(electron, [ROOT, `--remote-debugging-port=${debugPort}`], {
    env: { ...process.env, MIDO_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  const collect = (d) => {
    const s = String(d);
    logs.push(s);
    if (onLog) onLog(s);
  };
  proc.stdout.on('data', collect);
  proc.stderr.on('data', collect);
  const exited = new Promise((r) => proc.once('exit', r));

  const app = { proc, exited, logs };
  await attach(app, debugPort);
  return app;
}

/** Starts the app again like a user would; the running copy should show its window. */
function launchSecondInstance(dataDir) {
  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const p = spawn(electron, [ROOT], { env: { ...process.env, MIDO_DATA_DIR: dataDir }, stdio: 'ignore' });
  return new Promise((r) => p.once('exit', r));
}

/** Connects (or reconnects, after the window was re-created) to the app's page. */
async function attach(app, debugPort, previousId = null) {
  const target = await waitFor(async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      return list.find((x) => x.type === 'page' && x.id !== previousId);
    } catch {
      return null;
    }
  }, 20000);
  if (!target) throw new Error('no app window found');
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
    if (r.result.exceptionDetails) throw new Error(`${r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text}\n  in: ${expr}`);
    return r.result.result.value;
  };
  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  };
  /** Quits the app for real (closing the window only hides it to the tray). */
  const quit = async () => {
    await evaluate('setTimeout(() => window.api.quit(), 50), true').catch(() => {});
    await app.exited;
  };
  await waitFor(() => evaluate('!!(window.api && document.querySelector("#btn-add").textContent)').catch(() => false));
  Object.assign(app, {
    evaluate, shot, quit, targetId: target.id,
    reattach: () => attach(app, debugPort, target.id),
  });
  return app;
}

/** State of every visible row in the list, top to bottom. */
const rows = (app) =>
  app.evaluate(`[...document.querySelectorAll('#rows tr')].map((r) => ({
    gid: r.dataset.gid, status: r.dataset.status,
    name: r.querySelector('.name').textContent, pct: r.querySelector('.pct').textContent,
    speed: r.querySelector('.spd').textContent, sub: r.querySelector('.sub') ? r.querySelector('.sub').textContent : '',
    size: r.querySelector('.c-size').textContent }))`);

/** Full item objects from the main process (path, speed in bytes, etc). */
const items = (app) => app.evaluate('state.list');

module.exports = { ROOT, sleep, check, aria2Running, waitFor, launchApp, launchSecondInstance, rows, items };
