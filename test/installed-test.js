// End-to-end check of an INSTALLED copy of the app (default: C:\Program Files\Mido Download).
// It runs a second instance with a temporary data folder and bridge port, so the user's own
// running copy and data are never touched. Local test server + one real YouTube clip.
// Usage: node test/installed-test.js [path\to\Mido Download.exe]
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sleep, check, waitFor, connectTarget } = require('./cdp');

const EXE = process.argv[2] || 'C:\\Program Files\\Mido Download\\Mido Download.exe';
const PORT = 8777;
const DEBUG = 9337;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mido-inst-'));
const outDir = path.join(tmp, 'Downloads');
fs.mkdirSync(outDir);
const src = path.join(tmp, 'src.bin');
fs.writeFileSync(src, crypto.randomBytes(20 * 1024 * 1024));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const server = spawn(process.execPath, [path.join(__dirname, 'server.js'), src, PORT, 2 * 1024 * 1024], { stdio: 'ignore' });

const aria2Children = (pid) => {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `(Get-CimInstance Win32_Process -Filter "Name='aria2c.exe'" | Where-Object { $_.ParentProcessId -eq ${pid} } | Measure-Object).Count`]).toString().trim();
  return Number(out);
};

let proc;
(async () => {
  check(fs.existsSync(EXE), `installed app found: ${EXE}`);
  proc = spawn(EXE, [`--remote-debugging-port=${DEBUG}`], {
    env: { ...process.env, MIDO_DATA_DIR: path.join(tmp, 'data'), MIDO_BRIDGE_PORT: '47890' }, stdio: 'ignore',
  });
  const target = await waitFor(async () => {
    try {
      return (await (await fetch(`http://127.0.0.1:${DEBUG}/json`)).json()).find((t) => t.type === 'page');
    } catch {
      return null;
    }
  }, 30000);
  const page = await connectTarget(target.webSocketDebuggerUrl);
  await waitFor(() => page.evaluate('!!window.api').catch(() => false), 15000);
  const title = await page.evaluate('document.title');
  check(title === 'Mido Download', `window title: "${title}"`);
  check(aria2Children(proc.pid) === 1, 'download engine (aria2) is running under the app');
  await page.evaluate(`window.api.setSettings(${JSON.stringify({ downloadDir: outDir, categorize: false, clipboardWatch: false, notifications: false })}).then((s) => (state.settings = s, true))`);

  // normal segmented download
  await page.evaluate(`window.api.add({ url: 'http://127.0.0.1:${PORT}/file.bin', dir: ${JSON.stringify(outDir)}, split: 8 })`);
  const d = await waitFor(async () => {
    const x = (await page.evaluate('state.list')).find((i) => i.name === 'file.bin' || /file\.bin/.test(i.url));
    return x && !['active', 'waiting'].includes(x.status) && x;
  }, 90000, 1000);
  check(d && d.status === 'complete' && sha(path.join(outDir, 'file.bin')) === sha(src), `HTTP download completes, file identical (${d && d.status})`);

  // video tools + real YouTube
  const tools = await waitFor(async () => { const s = await page.evaluate('window.api.mediaToolsStatus()'); return s.available && s; }, 60000, 1000);
  check(!!tools, `video tools ready (yt-dlp ${tools && tools.version})`);
  const info = await page.evaluate(`window.api.mediaInfo('https://www.youtube.com/watch?v=jNQXAC9IVRw')`);
  check(info.ok && info.title === 'Me at the zoo', `YouTube info: ${info.title || info.error}`);
  await page.evaluate(`window.api.add({ url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', dir: ${JSON.stringify(outDir)}, mediaQuality: { type: 'video', height: 240 } })`);
  const v = await waitFor(async () => {
    const x = (await page.evaluate('state.list')).find((i) => i.kind === 'media');
    return x && !['active', 'waiting'].includes(x.status) && x;
  }, 120000, 1000);
  check(v && v.status === 'complete' && fs.existsSync(v.path), `YouTube video downloaded: ${v && v.name} (${v && v.status} ${v && (v.errorMessage || '')})`);

  // bridge for the browser extension
  const st = await (await fetch('http://127.0.0.1:47890/v1/status', { method: 'POST', headers: { Origin: 'chrome-extension://deaodfooaihmngfdanpadajieidlcngd' } })).json();
  check(st.app === 'mido-downloada' && st.enabled, `extension bridge answers (version ${st.version})`);

  // auto-update must be available in an installed copy
  const upd = await page.evaluate('window.api.updateStatus()');
  check(upd.state !== 'unavailable', `automatic updates are enabled in the installed app (state: ${upd.state})`);

  // the engine must come back if it gets killed (antivirus, crash…)
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='aria2c.exe'" | Where-Object { $_.ParentProcessId -eq ${proc.pid} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`]);
  const back = await waitFor(() => aria2Children(proc.pid) === 1, 30000, 1000);
  check(back, 'if aria2 is killed, the app starts it again');
  if (back) {
    await page.evaluate(`window.api.add({ url: 'http://127.0.0.1:${PORT}/again.bin', dir: ${JSON.stringify(outDir)}, split: 4 })`);
    const a = await waitFor(async () => {
      const x = (await page.evaluate('state.list')).find((i) => /again\.bin/.test(i.url));
      return x && !['active', 'waiting'].includes(x.status) && x;
    }, 60000, 1000);
    check(a && a.status === 'complete', `downloads work after the engine restarted (${a && a.status})`);
  }
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (proc && proc.exitCode === null) {
      try {
        execFileSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' });
      } catch {}
    }
    server.kill();
    await sleep(1500);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });
