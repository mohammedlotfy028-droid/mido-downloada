// Phase 4 test on the real app: torrents (local tracker + seeder, nothing goes to the
// internet), magnet links, checksums, the schedule, and "shut down when done" (fake:
// MIDO_FAKE_POWER=1 only logs it, the PC is NOT shut down).
// Usage: node test/phase4-test.js <screenshotDir>
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, sleep, check, waitFor, launchApp, items, rows } = require('./cdp');
const { makeTorrent } = require('./torrent-tools');

const SHOTS = path.resolve(process.argv[2] || '.');
const PORT = 8769;
const SEED_PORT = 6990;
const BASE = `http://127.0.0.1:${PORT}`;
const ARIA2 = path.join(ROOT, 'resources', 'aria2', 'aria2c.exe');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mido-p4-'));
const dataDir = path.join(tmp, 'data');
const outDir = path.join(tmp, 'Downloads');
const seedDir = path.join(tmp, 'seed');
fs.mkdirSync(outDir);
fs.mkdirSync(path.join(seedDir, 'Test Torrent'), { recursive: true });
const sha = (f, a = 'sha256') => crypto.createHash(a).update(fs.readFileSync(f)).digest('hex');

// Content to share: a folder with two files, and a single file for the magnet test.
fs.writeFileSync(path.join(seedDir, 'Test Torrent', 'movie part.bin'), crypto.randomBytes(6 * 1024 * 1024));
fs.writeFileSync(path.join(seedDir, 'Test Torrent', 'readme.txt'), 'torrent test\n');
fs.writeFileSync(path.join(seedDir, 'magnet-file.bin'), crypto.randomBytes(3 * 1024 * 1024));
const t1 = makeTorrent(path.join(seedDir, 'Test Torrent'), `${BASE}/announce`);
const t2 = makeTorrent(path.join(seedDir, 'magnet-file.bin'), `${BASE}/announce`);
const torrentPath = path.join(tmp, 'Test Torrent.torrent');
fs.writeFileSync(torrentPath, t1.torrent);
fs.writeFileSync(path.join(tmp, 'magnet.torrent'), t2.torrent);
const magnet = `magnet:?xt=urn:btih:${t2.infoHash}&dn=magnet-file.bin&tr=${encodeURIComponent(`${BASE}/announce`)}`;

// HTTP file for the checksum tests
const httpFile = path.join(tmp, 'http.bin');
fs.writeFileSync(httpFile, crypto.randomBytes(5 * 1024 * 1024));

const server = spawn(process.execPath, [path.join(__dirname, 'server.js'), httpFile, PORT, 4 * 1024 * 1024], {
  stdio: 'ignore',
  env: { ...process.env, SEED_PORT: String(SEED_PORT) },
});
// A separate aria2 that only seeds our two torrents (no DHT, no internet).
const seeder = spawn(ARIA2, [
  `--dir=${seedDir}`, '--check-integrity=true', '--seed-ratio=0.0', `--listen-port=${SEED_PORT}`,
  '--enable-dht=false', '--enable-dht6=false', '--bt-enable-lpd=false', '--enable-peer-exchange=false',
  '--disable-ipv6=true', '--summary-interval=0', '--console-log-level=warn', `--dht-file-path=${path.join(tmp, 'seed-dht.dat')}`,
  torrentPath, path.join(tmp, 'magnet.torrent'),
], { stdio: 'ignore' });

let app;
const finished = (name, ms = 90000) =>
  waitFor(async () => {
    const d = (await items(app)).find((x) => x.name === name);
    return d && !['active', 'waiting'].includes(d.status) && !d.metadata && d;
  }, ms, 1000);
const dialogReady = () =>
  waitFor(() => app.evaluate(`document.querySelector('#dlg-add').open && !document.querySelector('#probe-info').hidden && !document.querySelector('#probe-info').classList.contains('loading')`), 15000);

(async () => {
  await sleep(2500); // let the seeder check its files
  const env = { MIDO_TEST: '1', MIDO_FAKE_POWER: '1', MIDO_POWER_DELAY: '4', MIDO_BRIDGE_PORT: '47898' };
  app = await launchApp({ dataDir, env });
  await app.evaluate(`window.api.setSettings(${JSON.stringify({
    downloadDir: outDir, categorize: true, clipboardWatch: false, notifications: false, browserEnabled: false,
  })}).then((s) => (state.settings = s, true))`);

  // ---------- 1. .torrent file dropped on the window ----------
  await app.send('Input.dispatchDragEvent', { type: 'dragEnter', x: 400, y: 300, data: { items: [], files: [torrentPath], dragOperationsMask: 1 } });
  await app.send('Input.dispatchDragEvent', { type: 'dragOver', x: 400, y: 300, data: { items: [], files: [torrentPath], dragOperationsMask: 1 } });
  await app.send('Input.dispatchDragEvent', { type: 'drop', x: 400, y: 300, data: { items: [], files: [torrentPath], dragOperationsMask: 1 } });
  await dialogReady();
  const tInfo = await app.evaluate(`({ url: document.querySelector('#in-url').value, info: document.querySelector('#probe-info').textContent })`);
  check(tInfo.url === 'Test Torrent' && /2/.test(tInfo.info), `dropping a .torrent opens it: "${tInfo.url}" · "${tInfo.info}"`);
  await app.shot(path.join(SHOTS, 'p4-1-torrent-dialog.png'));
  await app.evaluate(`document.querySelector('#form-add').requestSubmit()`);
  const tor = await finished('Test Torrent');
  check(tor && tor.status === 'complete' && tor.kind === 'torrent', `torrent downloaded (${tor && tor.status} ${tor && (tor.errorMessage || '')})`);
  const got = path.join(outDir, 'Test Torrent');
  check(
    fs.existsSync(path.join(got, 'movie part.bin')) && sha(path.join(got, 'movie part.bin')) === sha(path.join(seedDir, 'Test Torrent', 'movie part.bin')) &&
      fs.readFileSync(path.join(got, 'readme.txt'), 'utf8') === 'torrent test\n',
    'both torrent files arrived intact in a "Test Torrent" folder'
  );

  // ---------- 2. magnet link ----------
  await app.evaluate(`openAddDialog(${JSON.stringify(magnet)})`);
  await dialogReady();
  await app.evaluate(`document.querySelector('#form-add').requestSubmit()`);
  const mag = await finished('magnet-file.bin');
  check(mag && mag.status === 'complete', `magnet: got the info from the peer, then the file (${mag && mag.status})`);
  check(mag && sha(path.join(outDir, 'magnet-file.bin')) === sha(path.join(seedDir, 'magnet-file.bin')), 'magnet file is identical');
  const magItems = (await items(app)).filter((d) => d.kind === 'magnet');
  check(magItems.length === 1 && !magItems[0].metadata, `magnet shows as ONE row, not a "metadata" row + the file (${magItems.length})`);

  // ---------- 3. checksums ----------
  const good = sha(httpFile);
  const addWithChecksum = async (name, checksum) => {
    await app.evaluate(`openAddDialog('${BASE}/files/${name}')`);
    await dialogReady();
    await app.evaluate(`document.querySelector('#in-checksum').value = ${JSON.stringify(checksum)}; document.querySelector('#form-add').requestSubmit()`);
  };
  await addWithChecksum('good.bin', `sha256:${good}`);
  const goodItem = await finished('good.bin');
  check(goodItem && goodItem.status === 'complete', 'download with the right SHA-256 completes');
  const goodRow = (await rows(app)).find((r) => r.name === 'good.bin');
  check(goodRow && /✓/.test(goodRow.sub), `...and is marked verified: "${goodRow && goodRow.sub}"`);

  await addWithChecksum('bad.bin', `sha256:${'0'.repeat(64)}`);
  const badItem = await finished('bad.bin');
  await sleep(1500);
  const badRow = (await rows(app)).find((r) => r.name === 'bad.bin');
  check(badItem && badItem.status === 'error' && String(badItem.errorCode) === '32', `wrong checksum is caught (error ${badItem && badItem.errorCode})`);
  check(badRow && !/retry|إعادة/i.test(badRow.sub) && badRow.sub.length > 0, `...shown as a mismatch, not retried: "${badRow && badRow.sub}"`);

  await app.evaluate(`openAddDialog('${BASE}/files/x.bin')`);
  await dialogReady();
  await app.evaluate(`document.querySelector('#in-checksum').value = 'hello'; document.querySelector('#form-add').requestSubmit()`);
  await sleep(800);
  const err = await app.evaluate(`document.querySelector('#dlg-add').open && document.querySelector('#add-error').textContent`);
  check(!!err, `a badly written checksum is refused before starting: "${err}"`);
  await app.evaluate(`document.querySelector('#dlg-add').close()`);

  // Verify dialog on a finished file
  await app.evaluate(`openVerify(state.list.find((d) => d.name === 'good.bin'))`);
  const hash = await waitFor(() => app.evaluate(`/^[0-9a-f]{64}$/.test(document.querySelector('#verify-hash').value) && document.querySelector('#verify-hash').value`), 10000);
  check(hash === good, 'verify dialog computes the right SHA-256');
  const md5 = sha(httpFile, 'md5');
  await app.evaluate(`(() => { const e = document.querySelector('#verify-expected'); e.value = 'md5:${md5}'; e.dispatchEvent(new Event('input')); })()`);
  const outcome = await waitFor(() => app.evaluate(`(() => { const o = document.querySelector('#verify-outcome'); return o.classList.contains('good') && document.querySelector('#verify-algo').value + ' ' + o.textContent; })()`), 10000);
  check(!!outcome && outcome.startsWith('md5'), `pasting an MD5 switches to MD5 and matches: "${outcome}"`);
  await app.shot(path.join(SHOTS, 'p4-2-verify.png'));
  await app.evaluate(`(() => { const e = document.querySelector('#verify-expected'); e.value = '${'a'.repeat(32)}'; e.dispatchEvent(new Event('input')); })()`);
  const bad = await waitFor(() => app.evaluate(`document.querySelector('#verify-outcome').classList.contains('bad')`), 5000);
  check(bad, 'a different hash shows "no match"');
  await app.evaluate(`document.querySelector('#dlg-verify').close()`);

  // ---------- 4. schedule ----------
  // Two slow downloads, paused; then the clock is moved by hand.
  for (const n of ['night1.bin', 'night2.bin']) {
    await app.evaluate(`window.api.probe('${BASE}/files/${n}').then((p) => window.api.add({ url: '${BASE}/files/${n}', dir: p.dir, split: 2, speedLimit: 50 }))`);
  }
  await sleep(1500);
  await app.evaluate('window.api.pauseAll()');
  await sleep(1000);
  const night = async () => (await items(app)).filter((d) => /^night/.test(d.name)).map((d) => d.status).join(',');
  check((await night()) === 'paused,paused', 'two downloads paused before the schedule');
  await app.evaluate(`window.api.setSettings({ schedule: { enabled: true, start: '10:00', stop: '11:00', days: [0,1,2,3,4,5,6] } })`);
  let inside = await app.evaluate(`window.api.testScheduleTick('2026-10-26T10:30:00', true)`);
  await sleep(1500);
  check(inside === true && (await night()) === 'active,active', `10:30 inside 10:00-11:00 -> downloads start (${await night()})`);
  inside = await app.evaluate(`window.api.testScheduleTick('2026-10-26T11:05:00')`);
  await sleep(1500);
  check(inside === false && (await night()) === 'paused,paused', `11:05 -> downloads pause (${await night()})`);
  // A window across midnight, Mondays only: Mon 23:00 -> Tue 02:00
  await app.evaluate(`window.api.setSettings({ schedule: { enabled: true, start: '23:00', stop: '02:00', days: [1] } })`);
  inside = await app.evaluate(`window.api.testScheduleTick('2026-10-27T01:00:00', true)`); // Tuesday 01:00
  await sleep(1500);
  check(inside === true && (await night()) === 'active,active', 'Monday 23:00-02:00 window still runs Tuesday 01:00');
  inside = await app.evaluate(`window.api.testScheduleTick('2026-10-27T02:30:00')`);
  await sleep(1500);
  check(inside === false && (await night()) === 'paused,paused', '...and stops at 02:00');
  await app.shot(path.join(SHOTS, 'p4-3-scheduled.png'));
  // Clean up: no schedule, remove the slow ones.
  await app.evaluate(`window.api.setSettings({ schedule: { enabled: false, start: '02:00', stop: '08:00', days: [] } })`);
  for (const d of (await items(app)).filter((x) => /^night/.test(x.name))) await app.evaluate(`window.api.remove('${d.gid}', true)`);

  // ---------- 5. "shut down when done" (fake) ----------
  await app.evaluate(`window.api.setSettings({ afterDone: 'shutdown' }).then((s) => { state.settings = s; renderAfterDoneBanner(); })`);
  const banner = await app.evaluate(`!document.querySelector('#afterdone-banner').hidden && document.querySelector('#afterdone-text').textContent`);
  check(!!banner, `banner warns: "${banner}"`);
  await app.evaluate(`window.api.probe('${BASE}/files/last1.bin').then((p) => window.api.add({ url: '${BASE}/files/last1.bin', dir: p.dir, split: 4 }))`);
  const countdown = await waitFor(() => app.evaluate(`document.querySelector('#dlg-power').open && document.querySelector('#power-title').textContent`), 20000);
  check(!!countdown, `when downloads finish a countdown appears: "${countdown}"`);
  await app.shot(path.join(SHOTS, 'p4-4-countdown.png'));
  await app.evaluate(`document.querySelector('#btn-power-cancel').click()`);
  await sleep(5000);
  const after = await app.evaluate(`window.api.getSettings().then((s) => s.afterDone)`);
  check(!app.logs.join('').includes('[power]') && app.proc.exitCode === null && after === 'nothing', 'Cancel stops it (nothing happens, setting goes back to "do nothing")');

  await app.evaluate(`window.api.setSettings({ afterDone: 'shutdown' })`);
  await app.evaluate(`window.api.probe('${BASE}/files/last2.bin').then((p) => window.api.add({ url: '${BASE}/files/last2.bin', dir: p.dir, split: 4 }))`);
  await waitFor(() => app.evaluate(`document.querySelector('#dlg-power').open`).catch(() => false), 20000);
  await Promise.race([app.exited, sleep(20000)]);
  const log = app.logs.join('');
  check(app.proc.exitCode !== null, 'without cancel, the app closes itself cleanly after the countdown');
  check(/\[power\] shutdown \(test mode, not really\)/.test(log), 'then it would shut down the PC (test mode: only logged)');
  app = null;
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (app && app.proc.exitCode === null) await Promise.race([app.quit(), sleep(8000)]);
    seeder.kill();
    server.kill();
    await sleep(1000);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });
