// Rename test (0.5.0: "Mido Downloada" -> "Mido Download"): data saved by the old name
// must move to the new folder, including the encrypted site password and torrent copies.
// Usage: node test/rename-test.js <screenshotDir>
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sleep, check, waitFor, launchApp, items } = require('./cdp');
const { makeTorrent } = require('./torrent-tools');

const SHOTS = path.resolve(process.argv[2] || '.');
const PORT = 8772;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mido-rename-'));
const appData = path.join(tmp, 'AppData');
const oldDir = path.join(appData, 'Mido Downloada');
const newDir = path.join(appData, 'Mido Download');
const outDir = path.join(tmp, 'Downloads');
fs.mkdirSync(outDir, { recursive: true });
const src = path.join(tmp, 'src.bin');
fs.writeFileSync(src, crypto.randomBytes(2 * 1024 * 1024));
const torrentPath = path.join(tmp, 'Some Torrent.torrent');
fs.writeFileSync(torrentPath, makeTorrent(src, `${BASE}/announce`).torrent);

const server = spawn(process.execPath, [path.join(__dirname, 'server.js'), src, PORT, 4 * 1024 * 1024], { stdio: 'ignore' });
const env = { MIDO_BRIDGE_PORT: '47896' };
let app;

const done = (name) =>
  waitFor(async () => {
    const d = (await items(app)).find((x) => x.name === name);
    return d && !['active', 'waiting'].includes(d.status) && d;
  }, 30000, 500);
const addDirect = (url) =>
  app.evaluate(`window.api.probe('${url}').then((p) => window.api.add({ url: '${url}', dir: ${JSON.stringify(outDir)}, split: 4 }))`);

(async () => {
  await sleep(500);
  // ---- 1. "old version": data in AppData\Mido Downloada ----
  app = await launchApp({ dataDir: oldDir, env });
  await app.evaluate(`window.api.setSettings(${JSON.stringify({
    lang: 'en', downloadDir: outDir, categorize: false, clipboardWatch: false, notifications: false, browserEnabled: false,
    logins: [{ host: '127.0.0.1', user: 'test', pass: 'secret' }],
  })})`);
  await addDirect(`${BASE}/auth/before-rename.bin`);
  const before = await done('before-rename.bin');
  check(before && before.status === 'complete', 'old version: login-protected download works');
  await app.evaluate(`window.api.loadTorrent(${JSON.stringify(torrentPath)}).then((t) => window.api.add({ url: '', dir: ${JSON.stringify(outDir)}, torrentId: t.torrentId }))`);
  await sleep(1500);
  await app.quit();
  check(fs.existsSync(path.join(oldDir, 'Local State')), 'old folder has the encryption key file (Local State)');
  const oldTorrentCopy = JSON.parse(fs.readFileSync(path.join(oldDir, 'downloads.json'), 'utf8'));
  check(Object.values(oldTorrentCopy).some((d) => d.torrentFile && d.torrentFile.startsWith(oldDir)), 'old downloads.json points to a .torrent copy in the old folder');

  // ---- 2. new version, normal data location (no MIDO_DATA_DIR) ----
  app = await launchApp({ dataDir: '', env: { ...env, MIDO_DATA_DIR: '', MIDO_TEST_APPDATA: appData } });
  check(app.logs.join('').includes('moved data folder'), 'new version moved the old data folder on first start');
  check(!fs.existsSync(oldDir) && fs.existsSync(path.join(newDir, 'settings.json')), `data now lives in "${path.basename(newDir)}"`);
  const s = await app.evaluate('window.api.getSettings()');
  check(s.lang === 'en' && s.logins.length === 1 && s.logins[0].hasPassword, 'settings and saved login came along');
  const list = await items(app);
  check(list.some((d) => d.name === 'before-rename.bin' && d.status === 'complete'), 'download list came along');
  const moved = JSON.parse(fs.readFileSync(path.join(newDir, 'downloads.json'), 'utf8'));
  const t = Object.values(moved).find((d) => d.torrentFile);
  check(t && t.torrentFile.startsWith(newDir) && fs.existsSync(t.torrentFile), 'torrent copy path updated to the new folder');
  await addDirect(`${BASE}/auth/after-rename.bin`);
  const after = await done('after-rename.bin');
  check(after && after.status === 'complete', 'saved password still decrypts after the move (protected download works)');
  const brand = await app.evaluate(`document.querySelector('.brand-name').textContent + ' | ' + document.title`);
  check(brand === 'Mido Download | Mido Download', `window shows the new name: "${brand}"`);
  await app.shot(path.join(SHOTS, 'rename-1-new-name.png'));
  await app.quit();

  // ---- 3. second start: nothing to move ----
  app = await launchApp({ dataDir: '', env: { ...env, MIDO_DATA_DIR: '', MIDO_TEST_APPDATA: appData } });
  check(!app.logs.join('').includes('moved data folder') && (await items(app)).length >= 2, 'next start: nothing moved again, data still there');
  await app.quit();
  app = null;
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (app && app.proc.exitCode === null) await Promise.race([app.quit(), sleep(8000)]);
    server.kill();
    await sleep(1000);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });
