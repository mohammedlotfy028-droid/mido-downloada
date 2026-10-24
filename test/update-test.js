// Auto-update test with the real packaged app (dist/win-unpacked, built by `npm run dist`):
// a local "update server" says version 0.0.1 newer is out; the app must find it, download it
// and verify it (sha512), then offer "Restart & update".
// The app is killed at the end, so the new installer is NEVER run.
// Usage: node test/update-test.js <screenshotDir>
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { ROOT, sleep, check, waitFor, connectTarget, launchApp } = require('./cdp');

const SHOTS = path.resolve(process.argv[2] || '.');
const PORT = 8771;
const DEBUG = 9335;
const pkg = require('../package.json');
const [maj, min, patch] = pkg.version.split('.').map(Number);
const NEXT = `${maj}.${min}.${patch + 1}`;
const exe = path.join(ROOT, 'dist', 'win-unpacked', 'Mido Download.exe');
const installer = path.join(ROOT, 'dist', `Mido-Download-Setup-${pkg.version}.exe`);
const updaterCache = path.join(process.env.LOCALAPPDATA, 'mido-downloada-updater');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mido-upd-'));
const feed = path.join(tmp, 'feed');
fs.mkdirSync(feed);

// Fake release NEXT: the same installer file under the new name + a latest.yml for it.
const name = `Mido-Download-Setup-${NEXT}.exe`;
fs.copyFileSync(installer, path.join(feed, name));
const buf = fs.readFileSync(installer);
const sha512 = crypto.createHash('sha512').update(buf).digest('base64');
fs.writeFileSync(path.join(feed, 'latest.yml'), [
  `version: ${NEXT}`,
  'files:',
  `  - url: ${name}`,
  `    sha512: ${sha512}`,
  `    size: ${buf.length}`,
  `path: ${name}`,
  `sha512: ${sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  '',
].join('\n'));

const requests = [];
const server = http
  .createServer((req, res) => {
    requests.push(req.url);
    const file = path.join(feed, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, ''));
    if (!file.startsWith(feed) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Length': fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, '127.0.0.1');

let proc;
(async () => {
  // 1. Running from source: updates are off (only an installed app can update itself).
  const dev = await launchApp({ dataDir: path.join(tmp, 'dev-data'), env: { MIDO_BRIDGE_PORT: '47897' } });
  const devState = await dev.evaluate('window.api.updateStatus().then((s) => s.state)');
  check(devState === 'unavailable', `running from source: updater is off (${devState})`);
  await dev.quit();

  // 2. Packaged app with a local update server.
  fs.rmSync(updaterCache, { recursive: true, force: true });
  proc = spawn(exe, [`--remote-debugging-port=${DEBUG}`], {
    env: { ...process.env, MIDO_DATA_DIR: path.join(tmp, 'data'), MIDO_UPDATE_URL: `http://127.0.0.1:${PORT}/`, MIDO_BRIDGE_PORT: '47897' },
    stdio: 'ignore',
  });
  const target = await waitFor(async () => {
    try {
      return (await (await fetch(`http://127.0.0.1:${DEBUG}/json`)).json()).find((t) => t.type === 'page');
    } catch {
      return null;
    }
  }, 30000);
  const page = await connectTarget(target.webSocketDebuggerUrl);
  check(true, `packaged app ${pkg.version} started`);

  // The app checks 10s after starting, then downloads in the background.
  const ready = await waitFor(
    () => page.evaluate(`!document.querySelector('#update-banner').hidden && document.querySelector('#update-text').textContent`).catch(() => null),
    90000,
    1000
  );
  check(!!ready && ready.includes(NEXT), `app found and downloaded version ${NEXT}: "${ready}"`);
  check(requests.some((u) => u.includes('latest.yml')) && requests.some((u) => u.includes(name)), 'it asked the update server for latest.yml and the installer');
  const pending = path.join(updaterCache, 'pending');
  const downloaded = fs.existsSync(pending) && fs.readdirSync(pending).find((f) => f.endsWith('.exe'));
  check(!!downloaded && fs.statSync(path.join(pending, downloaded)).size === buf.length, `installer saved and its sha512 checked (${downloaded})`);
  await page.shot(path.join(SHOTS, 'p4-5-update-ready.png'));
  const status = await page.evaluate('window.api.updateStatus()');
  check(status.state === 'ready' && status.newVersion === NEXT, `updater state: ${status.state} ${status.newVersion}`);
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Kill (not quit): quitting would install the downloaded update on this PC.
    if (proc && proc.exitCode === null) {
      try {
        execFileSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' });
      } catch {}
    }
    server.close();
    await sleep(1500);
    fs.rmSync(updaterCache, { recursive: true, force: true });
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });
