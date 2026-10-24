// YouTube playlists on the real app.
//  A) REAL: the official "Blender Open Movies" playlist (17 videos): list in the dialog, pick 2
//     short ones, 144p, numbered files in a playlist folder, one notification at the end,
//     and "this video is part of a playlist" -> the whole playlist.
//  B) LOCAL (no internet): queue order, max 2 at a time, one failing video, the single
//     "playlist finished" notification with counts, "cancel the rest of the playlist".
// Usage: node test/playlist-test.js <screenshotDir>
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, sleep, check, waitFor, launchApp, items } = require('./cdp');

const SHOTS = path.resolve(process.argv[2] || '.');
const PORT = 8778;
const BASE = `http://127.0.0.1:${PORT}`;
const PLAYLIST = 'https://www.youtube.com/playlist?list=PL6B3937A5D230E335';
const FF = path.join(ROOT, 'resources', 'ffmpeg');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mido-pl-'));
const dataDir = path.join(tmp, 'data');
const outDir = path.join(tmp, 'Downloads');
const staticDir = path.join(tmp, 'static');
fs.mkdirSync(staticDir, { recursive: true });
fs.mkdirSync(outDir);
const clip = path.join(staticDir, 'clip.mp4');
execFileSync(path.join(FF, 'ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '20', '-c:v', 'libopenh264', '-b:v', '500k', '-c:a', 'aac', '-y', clip]);
const server = spawn(process.execPath, [path.join(__dirname, 'server.js'), clip, PORT, 60 * 1024], {
  stdio: 'ignore', env: { ...process.env, STATIC_DIR: staticDir },
});

let app;
const env = { MIDO_TEST: '1', MIDO_BRIDGE_PORT: '47889' };
const ytdlpCount = () => (execFileSync('tasklist', ['/FI', 'IMAGENAME eq yt-dlp.exe', '/NH']).toString().match(/yt-dlp\.exe/g) || []).length;
const notifications = () => app.logs.join('').split('\n').filter((l) => l.startsWith('[notify] shown'));
const mediaItems = async () => (await items(app)).filter((d) => d.kind === 'media');
const allDone = (list) => list.every((d) => !['active', 'waiting'].includes(d.status) && !(d.status === 'error' && d.retryAt > Date.now()));
const dialogReady = () => waitFor(() => app.evaluate(`document.querySelector('#dlg-add').open && !document.querySelector('#playlist-box').hidden && document.querySelectorAll('#pl-list .pl-row').length`), 120000, 500);

(async () => {
  app = await launchApp({ dataDir, env });
  await app.evaluate(`window.api.setSettings(${JSON.stringify({ lang: 'en', downloadDir: outDir, categorize: true, clipboardWatch: false, notifications: true, maxConcurrent: 3, autoRetry: false })}).then((s) => (state.settings = s, true))`);

  // ======================= A. real YouTube playlist =======================
  await app.evaluate(`openAddDialog('${PLAYLIST}')`);
  const rowsN = await dialogReady();
  const head = await app.evaluate(`({ title: document.querySelector('#pl-title').textContent, sub: document.querySelector('#pl-sub').textContent,
    count: document.querySelector('#pl-count').textContent, quality: document.querySelector('#in-quality').value,
    nameHidden: document.querySelector('#lbl-name').hidden, sub1: !document.querySelector('#lbl-pl-subfolder').hidden })`);
  check(rowsN === 17 && head.title === 'Official Blender Open Movies', `playlist loaded: "${head.title}", ${rowsN} videos`);
  check(/17 videos/.test(head.sub) && /17 of 17 selected/.test(head.count), `shows totals: "${head.sub}" | "${head.count}"`);
  check(head.nameHidden && head.sub1, 'dialog switched to playlist mode (no file-name box, folder option shown)');
  await app.shot(path.join(SHOTS, 'pl-1-dialog.png'));

  // pick the two shortest videos
  const picked = await app.evaluate(`(() => {
    const d = add.playlistData;
    document.querySelector('#pl-none').click();
    const short = d.entries.map((e, i) => ({ ...e, index: i + 1 })).filter((e) => e.duration > 0).sort((a, b) => a.duration - b.duration).slice(0, 2);
    for (const e of short) document.querySelector('#pl-list input[data-id="' + e.id + '"]').click();
    return { count: document.querySelector('#pl-count').textContent, short: short.map((e) => ({ id: e.id, index: e.index, title: e.title })) };
  })()`);
  check(/2 of 17 selected/.test(picked.count), `selected the 2 shortest: "${picked.count}"`);
  await app.evaluate(`document.querySelector('#in-quality').value = 'v:144'; document.querySelector('#in-quality').dispatchEvent(new Event('change'))`);
  await sleep(500);
  await app.shot(path.join(SHOTS, 'pl-2-selected.png'));
  await app.evaluate(`document.querySelector('#form-add').requestSubmit()`);

  const list1 = await waitFor(async () => {
    const l = (await mediaItems()).filter((d) => d.playlist && d.playlist.id === 'PL6B3937A5D230E335');
    return l.length === 2 && l;
  }, 15000);
  check(!!list1, 'two downloads were created for the two ticked videos');
  const order = (await items(app)).filter((d) => d.playlist).map((d) => d.playlist.index);
  check(order.join() === [...order].sort((a, b) => a - b).join(), `they show in the list in playlist order (${order.join(', ')})`);
  const done1 = await waitFor(async () => {
    const l = (await mediaItems()).filter((d) => d.playlist);
    return allDone(l) && l;
  }, 240000, 1000);
  check(done1 && done1.every((d) => d.status === 'complete'), `both videos downloaded (${done1 && done1.map((d) => d.status).join(', ')} ${done1 && done1.map((d) => d.errorMessage || '').join('')})`);
  const folder = path.join(outDir, 'Video', 'Official Blender Open Movies');
  const files = fs.existsSync(folder) ? fs.readdirSync(folder).filter((f) => f.endsWith('.mp4')) : [];
  const expectedOk = picked.short.every((e) => files.some((f) => f.startsWith(`${String(e.index).padStart(2, '0')} - `) && f.includes(`[${e.id}]`)));
  check(expectedOk, `files are in the playlist folder, numbered by playlist position: ${files.map((f) => f.slice(0, 40)).join(' | ')}`);
  await sleep(2500);
  const n1 = notifications();
  check(n1.length === 1 && /Playlist finished/.test(n1[0]), `ONE notification for the whole playlist (${n1.length}): ${n1[0] || ''}`);
  await app.shot(path.join(SHOTS, 'pl-3-list.png'));

  // a video that belongs to a playlist: offer the whole list
  await app.evaluate(`openAddDialog('https://www.youtube.com/watch?v=${picked.short[0].id}&list=PL6B3937A5D230E335&index=${picked.short[0].index}')`);
  const offer = await waitFor(() => app.evaluate(`!document.querySelector('#media-box').hidden && !document.querySelector('#playlist-offer').hidden && document.querySelector('#media-title').textContent`), 90000, 500);
  check(!!offer, `a video inside a playlist offers "download the whole playlist": "${offer}"`);
  await app.shot(path.join(SHOTS, 'pl-4-offer.png'));
  await app.evaluate(`document.querySelector('#btn-whole-playlist').click()`);
  const rows2 = await dialogReady();
  check(rows2 === 17, `clicking it switches to the playlist (${rows2} videos)`);
  await app.evaluate(`document.querySelector('#dlg-add').close()`);

  // ======================= B. local playlist logic =======================
  const before = notifications().length;
  const entry = (n, url, title) => ({ id: `local${String(n).padStart(6, '0')}`.slice(0, 11), title, url, index: n });
  const addLocal = (entries, id, title, extra = {}) =>
    app.evaluate(`window.api.add({ url: 'x', dir: ${JSON.stringify(outDir)}, mediaQuality: { type: 'video', height: 0 },
      mediaPlaylist: ${JSON.stringify({ id, title, total: entries.length, subfolder: true, numbered: true, entries, ...extra })} })`);

  // B1: 3 fast videos + 1 that doesn't exist (404): finishes with ONE summary notification
  await addLocal([
    entry(1, `${BASE}/static/clip.mp4`, 'local one'),
    entry(2, `${BASE}/fail-404-0/x.mp4`, 'local broken'),
    entry(3, `${BASE}/static/clip.mp4?b=1`, 'local three'),
    entry(4, `${BASE}/static/clip.mp4?c=1`, 'local four'),
  ], 'PLLOCAL1', 'Local List');
  await sleep(1500);
  const peak = await waitFor(async () => (await mediaItems()).filter((d) => d.playlist && d.playlist.id === 'PLLOCAL1' && d.status === 'active').length === 2 && ytdlpCount() >= 1, 20000, 300);
  check(!!peak, 'at most 2 videos of a playlist download at the same time (the others wait)');
  const queued = (await mediaItems()).filter((d) => d.playlist && d.playlist.id === 'PLLOCAL1' && d.status === 'waiting');
  check(queued.length >= 1 && queued[0].queuePos >= 1, `the rest wait in the queue (${queued.length} waiting)`);
  const done2 = await waitFor(async () => {
    const l = (await mediaItems()).filter((d) => d.playlist && d.playlist.id === 'PLLOCAL1');
    return allDone(l) && l;
  }, 120000, 1000);
  const st = done2 && done2.sort((a, b) => a.playlist.index - b.playlist.index).map((d) => d.status).join(',');
  check(st === 'complete,error,complete,complete', `3 finished, the missing one failed without blocking the rest (${st})`);
  await sleep(2500);
  const n2 = notifications().slice(before);
  check(n2.length === 1 && /Playlist finished/.test(n2[0]), `ONE summary notification (${n2.length}): ${n2[0] || ''}`);
  const sum = await app.evaluate(`(() => { const r = [...document.querySelectorAll('#rows tr')].find((x) => /Local List/.test(x.querySelector('.url').textContent)); return r && r.querySelector('.url').textContent; })()`);
  check(/Local List · \d\/4/.test(sum || ''), `rows say which playlist they belong to: "${sum}"`);
  const lf = path.join(outDir, 'Local List'); // the local test passes outDir itself as the base folder
  check(fs.existsSync(lf) && fs.readdirSync(lf).some((f) => f.startsWith('01 - ')) && fs.readdirSync(lf).some((f) => f.startsWith('04 - ')), `numbered files in "Local List": ${fs.existsSync(lf) ? fs.readdirSync(lf).filter((f) => f.endsWith('.mp4')).map((f) => f.slice(0, 12)).join(' | ') : 'none'}`);

  // B2: cancel the rest of a playlist (slow videos so some are running, some waiting)
  const before2 = notifications().length;
  await addLocal([1, 2, 3, 4].map((n) => entry(n + 10, `${BASE}/slow/clip.mp4?n=${n}`, `slow ${n}`)), 'PLLOCAL2', 'Slow List');
  await waitFor(async () => (await mediaItems()).filter((d) => d.playlist && d.playlist.id === 'PLLOCAL2' && d.status === 'active').length === 2, 20000, 300);
  const first = (await mediaItems()).find((d) => d.playlist && d.playlist.id === 'PLLOCAL2');
  await app.evaluate(`window.api.cancelPlaylist('${first.gid}')`);
  const cancelled = await waitFor(async () => {
    const l = (await mediaItems()).filter((d) => d.playlist && d.playlist.id === 'PLLOCAL2');
    return l.every((d) => d.status === 'removed') && l;
  }, 20000, 500);
  check(!!cancelled, '"cancel the rest of the playlist" stops all 4 (running and waiting)');
  await sleep(1500);
  check(ytdlpCount() === 0, 'and no yt-dlp is left running');
  const n3 = notifications().slice(before2);
  check(n3.length <= 1, `cancelling doesn't spam notifications (${n3.length})`);

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
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
        break;
      } catch {
        await sleep(1000);
      }
    }
  });
