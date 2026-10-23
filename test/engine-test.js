// End-to-end engine test without the UI:
//  1. segmented download starts with several connections
//  2. pause -> shut aria2 down -> start it again -> still paused at the same point
//  3. resume, then kill the server for a while (network drop) -> it continues by itself
//  4. final file matches the original (sha256)
// Usage: node test/engine-test.js
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Aria2 } = require('../src/main/aria2');
const { DownloadManager } = require('../src/main/downloads');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 8765;
const SIZE = 40 * 1024 * 1024;
const BIN = path.join(__dirname, '..', 'resources', 'aria2', 'aria2c.exe');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mido-test-'));
const srcFile = path.join(root, 'big.bin');
const dataDir = path.join(root, 'data');
const outDir = path.join(root, 'out');
fs.mkdirSync(outDir);
fs.writeFileSync(srcFile, crypto.randomBytes(SIZE));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

let server;
function startServer() {
  server = spawn(process.execPath, [path.join(__dirname, 'server.js'), srcFile, PORT, 128 * 1024], {
    stdio: 'ignore',
  });
}
function check(cond, msg) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) process.exitCode = 1;
}
async function boot() {
  const aria2 = new Aria2({ binPath: BIN, dataDir });
  await aria2.start();
  return { aria2, dm: new DownloadManager({ aria2, dataDir }) };
}

(async () => {
  startServer();
  await sleep(500);
  let { aria2, dm } = await boot();

  const gid = await dm.add({ url: `http://127.0.0.1:${PORT}/big.bin`, dir: outDir, split: 8 });
  await sleep(3000);
  let item = (await dm.refresh()).find((d) => d.gid === gid);
  check(item.status === 'active', `downloading (status=${item.status})`);
  check(item.connections > 1, `segmented: ${item.connections} connections`);
  check(item.downloadSpeed > 0, `speed ${(item.downloadSpeed / 1024).toFixed(0)} KB/s`);

  await dm.pause(gid);
  await sleep(1000);
  item = (await dm.refresh()).find((d) => d.gid === gid);
  const doneAtPause = item.completedLength;
  check(item.status === 'paused', `paused at ${(doneAtPause / SIZE * 100).toFixed(1)}%`);

  console.log('-- closing aria2 and starting it again (simulates closing the app)');
  await aria2.stop();
  ({ aria2, dm } = await boot());
  item = (await dm.refresh()).find((d) => d.gid === gid);
  check(!!item && item.status === 'paused', `still paused after restart (status=${item && item.status})`);
  check(item.completedLength >= doneAtPause * 0.95, `kept progress: ${item.completedLength} bytes`);

  await dm.resume(gid);
  await sleep(2000);
  console.log('-- killing the server for 12s (simulates the internet going down)');
  server.kill();
  await sleep(12000);
  item = (await dm.refresh()).find((d) => d.gid === gid);
  check(item.status === 'active', `still waiting/retrying while offline (status=${item.status})`);
  startServer();
  console.log('-- server back');

  for (let i = 0; i < 120; i++) {
    item = (await dm.refresh()).find((d) => d.gid === gid);
    if (item.status !== 'active') break;
    await sleep(1000);
  }
  check(item.status === 'complete', `finished by itself (status=${item.status} ${item.errorMessage || ''})`);
  if (item.status === 'complete') check(sha(item.path) === sha(srcFile), 'file is identical to the original');

  await aria2.stop();
  server.kill();
  fs.rmSync(root, { recursive: true, force: true });
})().catch((e) => {
  console.error(e);
  server && server.kill();
  process.exit(1);
});
