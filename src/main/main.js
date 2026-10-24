// Electron main process: starts aria2, owns the download list, tray, notifications,
// clipboard watching, and talks to the UI over IPC.
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Notification, Menu, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { Aria2 } = require('./aria2');
const { DownloadManager } = require('./downloads');
const { Settings, encrypt, decrypt } = require('./settings');
const { probe } = require('./probe');
const { BrowserBridge, PORT: BRIDGE_PORT } = require('./browser-bridge');
const { readTorrent } = require('./torrent-file');
const { Scheduler, powerAction } = require('./scheduler');
const { Updater } = require('./updater');
const { parseChecksum, hashFile } = require('../shared/checksum');
const crypto = require('crypto');
const { AppTray } = require('./tray');
const { ClipboardWatcher } = require('./clipboard-watch');
const { beforeAppClose } = require('./quit-behavior');
const { CATEGORIES, categoryOf } = require('../shared/categories');
const { MediaManager } = require('./media');
const { MediaTools } = require('./media-tools');
const { mediaSiteOf, isPlaylistPage, playlistUrlOf } = require('../shared/media-sites');
const { safeFileName } = require('./probe');

// Dev/test: run with a separate data folder so tests don't touch real data.
if (process.env.MIDO_DATA_DIR) app.setPath('userData', path.resolve(process.env.MIDO_DATA_DIR));
// Test only: pretend this folder is %APPDATA% (to test moving the old data folder).
if (process.env.MIDO_TEST_APPDATA) {
  app.setPath('appData', path.resolve(process.env.MIDO_TEST_APPDATA));
  app.setPath('userData', path.join(app.getPath('appData'), app.getName()));
}

/**
 * The app was called "Mido Downloada" before 0.5.0, and Windows keeps its data in a folder
 * named after the app. Move that folder once, as a whole: it also holds the key that
 * decrypts saved passwords and cookies ("Local State").
 */
function moveDataFromOldName() {
  if (process.env.MIDO_DATA_DIR) return;
  const newDir = app.getPath('userData');
  const oldDir = path.join(app.getPath('appData'), 'Mido Downloada');
  if (fs.existsSync(newDir) || !fs.existsSync(oldDir)) return;
  try {
    fs.renameSync(oldDir, newDir);
  } catch {
    // Old version still running (files locked)? Copy instead, all-or-nothing.
    const tmp = `${newDir}.moving`;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.cpSync(oldDir, tmp, { recursive: true });
      fs.renameSync(tmp, newDir);
    } catch (e) {
      console.error('could not move old data folder:', e.message);
      fs.rmSync(tmp, { recursive: true, force: true });
      return;
    }
  }
  // downloads.json remembers where our private .torrent copies are (inside the data folder).
  const list = path.join(newDir, 'downloads.json');
  if (fs.existsSync(list)) {
    const esc = (p) => JSON.stringify(p).slice(1, -1);
    fs.writeFileSync(list, fs.readFileSync(list, 'utf8').split(esc(oldDir)).join(esc(newDir)));
  }
  console.log(`moved data folder: ${oldDir} -> ${newDir}`);
}
moveDataFromOldName();

// Only one copy of the app may run (two aria2 instances would fight over the session file).
if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('com.mido.downloada'); // needed for Windows notifications

const ICON = path.join(__dirname, '..', '..', 'resources', 'icon.png');
const dataDir = app.getPath('userData');

let settings;
let win = null;
let aria2 = null;
let dm = null;
let tray = null;
let watcher = null;
let pollTimer = null;
let quitting = false;
let lastList = [];
let bridge = null;
let scheduler = null;
let updater = null;
let media = null; // MediaManager (yt-dlp)
let mediaTools = null;
// The first start copies yt-dlp to the data folder (a few seconds): requests wait for it.
let markMediaReady;
const mediaReady = new Promise((r) => (markMediaReady = r));
const waitForMedia = () => Promise.race([mediaReady, new Promise((r) => setTimeout(r, 60000))]);

/** Folder with aria2/, yt-dlp/, ffmpeg/: next to app.asar when installed, <repo>/resources from source. */
function resourcesDir() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..', 'resources');
}

// ---------- "when all downloads finish" ----------
let wasBusy = false;
let powerTimer = null;
let pendingPower = null; // action to run after the app has closed cleanly

function sendToUi(channel, payload) {
  if (!win || win.isDestroyed()) return;
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => win.webContents.send(channel, payload));
  else win.webContents.send(channel, payload);
}

function checkAfterDone(list) {
  // Busy = something is downloading, queued, or about to be retried automatically.
  const busy = list.some(
    (d) => d.status === 'active' || d.status === 'waiting' || (d.status === 'error' && d.retryAt > Date.now())
  );
  const action = settings.values.afterDone;
  if (wasBusy && !busy && action !== 'nothing' && !powerTimer) startPowerCountdown(action);
  wasBusy = busy;
}

/** Shows a countdown (the user can cancel), then quits / sleeps / shuts down. */
function startPowerCountdown(action) {
  const seconds = Number(process.env.MIDO_POWER_DELAY) || 60;
  showWindow();
  sendToUi('ui:power', { action, seconds });
  powerTimer = setTimeout(() => {
    powerTimer = null;
    settings.update({ afterDone: 'nothing' }); // one time only
    sendToUi('ui:powerDone', action);
    if (action === 'sleep') {
      powerAction('sleep');
    } else {
      pendingPower = action === 'shutdown' ? 'shutdown' : null;
      app.quit(); // the session is saved in before-quit, then the PC shuts down
    }
  }, seconds * 1000);
}

function cancelPowerCountdown() {
  clearTimeout(powerTimer);
  powerTimer = null;
  settings.update({ afterDone: 'nothing' });
}

// Links sent by the browser extension wait here (with their cookies) until the user
// confirms them in the dialog. The UI only ever sees the request id, never the cookies.
const browserRequests = new Map(); // id -> { url, headers, userAgent, filename, fileSize, mime, at }
const pairWaiters = new Map(); // id -> resolve(boolean)

// A header value must stay on one line, or it could smuggle in extra headers.
const oneLine = (s) => String(s || '').replace(/[\r\n\0]+/g, ' ').trim();

function takeBrowserRequest(id, { keep = false } = {}) {
  const r = id ? browserRequests.get(id) : null;
  if (r && !keep) browserRequests.delete(id);
  return r || null;
}

function aria2Binary() {
  // Packaged app: resources/aria2/aria2c.exe next to app.asar. Dev: <repo>/resources/aria2.
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'aria2')
    : path.join(__dirname, '..', '..', 'resources', 'aria2');
  return path.join(base, process.platform === 'win32' ? 'aria2c.exe' : 'aria2c');
}

function showWindow() {
  // The window may have been destroyed while the app kept running in the tray.
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Opens the "new download" dialog in the UI, optionally with a link filled in. */
function openAddDialog(url = '', ctx = null) {
  showWindow();
  const send = () => win.webContents.send('ui:add', url, ctx);
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 700,
    minWidth: 860,
    minHeight: 500,
    title: 'Mido Download',
    icon: ICON,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181d' : '#f6f7f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Dropping a link/file on the window must not navigate away from the app.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Closing the window keeps the app running in the tray (if enabled).
  win.on('close', (e) => {
    if (!quitting && settings.values.closeToTray) {
      e.preventDefault();
      win.hide();
    }
  });

  // Dev/test: save a screenshot of the window after a delay, e.g. MIDO_SCREENSHOT=shot.png
  if (process.env.MIDO_SCREENSHOT) {
    const delay = Number(process.env.MIDO_SCREENSHOT_DELAY || 3000);
    win.webContents.once('did-finish-load', () =>
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.MIDO_SCREENSHOT, img.toPNG());
        console.log('screenshot saved', process.env.MIDO_SCREENSHOT);
      }, delay)
    );
  }
}

function notify(title, body, onClick) {
  if (!settings.values.notifications || !Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON, silent: false });
  if (onClick) n.on('click', onClick);
  n.on('show', () => console.log(`[notify] shown: ${title}`));
  n.on('failed', (_e, err) => console.error(`[notify] failed: ${err}`));
  n.show();
}

const T = {
  ar: {
    done: 'اكتمل التحميل', failed: 'فشل التحميل', playlistDone: 'انتهت قائمة التشغيل',
    playlistBody: (s) => `${s.title}\n${s.complete} من ${s.total}${s.failed ? ` · فشل ${s.failed}` : ''}`,
  },
  en: {
    done: 'Download complete', failed: 'Download failed', playlistDone: 'Playlist finished',
    playlistBody: (s) => `${s.title}\n${s.complete} of ${s.total}${s.failed ? ` · ${s.failed} failed` : ''}`,
  },
};
const tr = () => T[settings.values.lang] || T.en;

let pollCount = 0;
let engineRestarting = false; // aria2 is being started again after it died
async function poll() {
  if (!dm || engineRestarting) return;
  try {
    // Save unfinished downloads every 5s so a crash loses almost nothing
    // (aria2's own periodic save is off because it writes passwords in plain text).
    if (++pollCount % 5 === 0) await aria2.saveSession();
    // aria2 downloads + video-site downloads (yt-dlp) in one list, newest first.
    lastList = [...(await dm.refresh()), ...(media ? media.list() : [])].sort((a, b) => b.addedAt - a.addedAt);
    checkAfterDone(lastList);
    if (tray) tray.update(lastList);
    if (win && !win.isDestroyed()) win.webContents.send('downloads', lastList);
  } catch (e) {
    console.error('poll failed:', e.message);
  }
}

/** Pushes changed settings to aria2 and the other parts of the app. */
async function applySettings(changedKeys) {
  const keys = new Set(changedKeys);
  if (aria2 && ['maxConcurrent', 'speedLimit', 'proxy', 'userAgent'].some((k) => keys.has(k))) {
    await aria2.call('changeGlobalOption', settings.aria2Options());
  }
  if (keys.has('clipboardWatch') && watcher) {
    settings.values.clipboardWatch ? watcher.start() : watcher.stop();
  }
  if (keys.has('lang') && tray) tray.buildMenu();
  if (keys.has('schedule') && scheduler && process.env.MIDO_TEST !== '1') {
    scheduler.lastInside = null; // re-evaluate the new schedule right away
    await scheduler.tick();
  }
  if (keys.has('autoUpdate') && updater) {
    settings.values.autoUpdate ? updater.startAutomatic() : updater.stopAutomatic();
  }
}

const loadedTorrents = new Map(); // id -> path of our private copy

function loadTorrent(file) {
  const info = readTorrent(file); // throws if it isn't a torrent
  const dir = path.join(dataDir, 'torrents');
  fs.mkdirSync(dir, { recursive: true });
  const copy = path.join(dir, `${Date.now()}-${path.basename(file).replace(/[^\w.\- ()[\]]+/g, '_')}`);
  fs.copyFileSync(file, copy);
  const id = crypto.randomBytes(8).toString('hex');
  loadedTorrents.set(id, copy);
  return { torrentId: id, name: info.name, size: info.size, fileCount: info.files.length, dir: settings.values.downloadDir };
}

async function probeLink(url, browserReq = null) {
  const site = mediaSiteOf(url);
  if (site) {
    // A video site: yt-dlp looks at it (dl:mediaInfo), which is slower; tell the UI first.
    return {
      ok: true, media: true, site, name: '', size: 0, type: '', resumable: true, category: 'video', dir: suggestDir('video'),
      playlist: isPlaylistPage(url), // the link IS a playlist
      playlistUrl: isPlaylistPage(url) ? '' : playlistUrlOf(url), // a video that also belongs to one
    };
  }
  if (/^magnet:/i.test(url)) {
    // Nothing to check over HTTP; the name/size arrive from other peers later.
    return { ok: true, magnet: true, name: '', size: 0, type: '', resumable: true, category: null, dir: settings.values.downloadDir };
  }
  const info = await probe(url, {
    userAgent: (browserReq && browserReq.userAgent) || settings.aria2Options()['user-agent'],
    login: settings.loginFor(url),
    extraHeaders: browserReq ? browserReq.headers : [],
  });
  // The browser often knows the real file name (Content-Disposition) better.
  if (browserReq && browserReq.filename && (!info.ok || !/\.[a-z0-9]{1,9}$/i.test(info.name))) {
    info.name = browserReq.filename;
  }
  const category = categoryOf(info.name, info.type || (browserReq && browserReq.mime));
  return { ...info, category, dir: suggestDir(category) };
}

/** A link arrived from the browser extension. */
async function onBrowserDownload(req) {
  const headers = [];
  const cookies = oneLine(req.cookies);
  if (cookies) headers.push(`Cookie: ${cookies}`);
  if (req.referrer) headers.push(`Referer: ${oneLine(req.referrer)}`);
  const entry = {
    url: req.url, headers, userAgent: oneLine(req.userAgent), referrer: req.referrer || '',
    cookieList: req.cookieList || [], // for video sites (yt-dlp needs each cookie's domain)
    filename: require('./probe').safeFileName(req.filename || ''), fileSize: req.fileSize, mime: req.mime, at: Date.now(),
  };
  // Forget requests the user never answered after 30 minutes.
  for (const [id, r] of browserRequests) if (Date.now() - r.at > 30 * 60000) browserRequests.delete(id);

  // A playlist always needs the dialog (which videos? which quality?), even if "ask" is off.
  if (settings.values.browserAsk || isPlaylistPage(req.url)) {
    const id = crypto.randomBytes(8).toString('hex');
    browserRequests.set(id, entry);
    openAddDialog(req.url, { requestId: id, name: entry.filename, size: entry.fileSize, source: req.source });
    return;
  }
  if (mediaSiteOf(req.url)) await waitForMedia();
  if (mediaSiteOf(req.url) && media) {
    // Start right away in the default quality.
    const info = await media.info(req.url, mediaSecret(entry));
    if (!info.ok) return notify(tr().failed, `${req.url}\n${info.error}`, showWindow);
    const quality = qualityFromSetting(settings.values.mediaQuality);
    media.add({
      url: req.url, quality, title: info.title, dir: suggestDir(quality.type === 'audio' ? 'music' : 'video'),
      category: quality.type === 'audio' ? 'music' : 'video', secret: mediaSecret(entry),
    });
    poll();
    return;
  }
  // Start right away, no dialog.
  const info = await probeLink(req.url, entry);
  await dm.add({
    url: req.url, dir: info.dir, out: info.ok ? info.name : entry.filename, split: settings.values.split,
    category: info.category, headers, userAgent: entry.userAgent,
  });
  poll();
}

const isMediaGid = (gid) => /^m/.test(String(gid));
const engineOf = (gid) => (isMediaGid(gid) ? media : dm);
const itemOf = (gid) => (isMediaGid(gid) ? media && media.items[gid] : dm.items[gid]);

/** What yt-dlp gets from a browser request (stored encrypted with the item). */
function mediaSecret(req) {
  if (!req) return null;
  return { cookieList: req.cookieList || [], userAgent: req.userAgent || '', referrer: req.referrer || '' };
}

/** "1080" / "best" / "mp3" / "m4a" -> quality object for MediaManager */
function qualityFromSetting(v) {
  if (v === 'mp3' || v === 'm4a') return { type: 'audio', format: v };
  return { type: 'video', height: v === 'best' ? 0 : Number(v) || 1080 };
}

/** The extension asks to be paired: ask the user in the app window. */
function onPairRequest(name) {
  return new Promise((resolve) => {
    const id = crypto.randomBytes(8).toString('hex');
    pairWaiters.set(id, resolve);
    showWindow();
    const send = () => win.webContents.send('ui:pair', { id, name });
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
    else send();
  });
}

function suggestDir(category) {
  const base = settings.values.downloadDir;
  if (!settings.values.categorize || !category) return base;
  return path.join(base, CATEGORIES[category].folder);
}

function registerIpc() {
  const handle = (name, fn) =>
    ipcMain.handle(name, async (_e, ...args) => {
      const result = await fn(...args);
      poll(); // push fresh state right away instead of waiting for the next tick
      return result;
    });

  handle('settings:get', () => settings.forUi());
  handle('settings:set', async (patch) => {
    const ui = settings.update(patch);
    await applySettings(Object.keys(patch));
    return ui;
  });
  handle('dialog:chooseDir', async (current) => {
    const r = await dialog.showOpenDialog(win, {
      defaultPath: current || settings.values.downloadDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  // Looks at a link before downloading (name, size, type) and suggests a folder.
  handle('dl:probe', async (url, requestId) => probeLink(url, takeBrowserRequest(requestId, { keep: true })));
  handle('dl:suggestDir', (category) => suggestDir(category));

  // A video site link: ask yt-dlp for the title and the available qualities.
  handle('dl:mediaInfo', async (url, requestId) => {
    await waitForMedia();
    if (!media || !mediaTools.available()) return { ok: false, error: 'NO_TOOLS' };
    return media.info(url, mediaSecret(takeBrowserRequest(requestId, { keep: true })));
  });
  // A playlist link: the list of its videos (titles and lengths).
  handle('dl:playlistInfo', async (url, requestId) => {
    await waitForMedia();
    if (!media || !mediaTools.available()) return { ok: false, error: 'NO_TOOLS' };
    return media.playlist(url, mediaSecret(takeBrowserRequest(requestId, { keep: true })));
  });
  handle('dl:cancelPlaylist', (gid) => (isMediaGid(gid) && media ? media.cancelPlaylist(gid) : null));

  handle('dl:add', async (opts) => {
    // Links from the browser carry cookies/Referer that stay in the main process.
    const req = takeBrowserRequest(opts.requestId);
    if (opts.mediaQuality && opts.mediaPlaylist) {
      await waitForMedia();
      if (!media) throw new Error('NO_TOOLS');
      const pl = opts.mediaPlaylist;
      const q = opts.mediaQuality;
      const entries = (Array.isArray(pl.entries) ? pl.entries : []).slice(0, 300).map((e) => {
        // Only video-site links (or, in tests, any http link). Otherwise build it from the video id.
        const own = String(e.url || '');
        const ok = mediaSiteOf(own) || (process.env.MIDO_TEST === '1' && /^https?:\/\//.test(own));
        const url = ok ? own : /^[\w-]{11}$/.test(String(e.id)) ? `https://www.youtube.com/watch?v=${e.id}` : '';
        return { url, title: String(e.title || '').slice(0, 300), index: Math.max(1, Number(e.index) || 1) };
      }).filter((e) => e.url);
      if (!entries.length) throw new Error('NO_VIDEOS');
      const audio = q.type === 'audio';
      const dir = pl.subfolder ? path.join(opts.dir, safeFileName(pl.title) || 'playlist') : opts.dir;
      media.addPlaylist({
        playlist: { id: String(pl.id || crypto.randomBytes(4).toString('hex')), title: String(pl.title || 'playlist').slice(0, 200), total: Number(pl.total) || entries.length },
        entries, dir, numbered: pl.numbered !== false,
        quality: audio ? { type: 'audio', format: q.format === 'm4a' ? 'm4a' : 'mp3' } : { type: 'video', height: Number(q.height) || 0 },
        category: audio ? 'music' : 'video', speedLimit: opts.speedLimit || 0, secret: mediaSecret(req),
      });
      return entries.length;
    }
    if (opts.mediaQuality) {
      await waitForMedia();
      if (!media) throw new Error('NO_TOOLS');
      const q = opts.mediaQuality;
      return media.add({
        url: opts.url, dir: opts.dir, title: opts.title || '', size: opts.size || 0,
        quality: q.type === 'audio' ? { type: 'audio', format: q.format === 'm4a' ? 'm4a' : 'mp3' } : { type: 'video', height: Number(q.height) || 0 },
        category: q.type === 'audio' ? 'music' : 'video', speedLimit: opts.speedLimit || 0,
        secret: mediaSecret(req),
      });
    }
    const { requestId, checksum, torrentId, ...rest } = opts;
    const parsed = parseChecksum(checksum); // throws BAD_CHECKSUM
    const torrentFile = torrentId ? loadedTorrents.get(torrentId) : '';
    if (torrentId && !torrentFile) throw new Error('torrent file is gone');
    return dm.add({
      ...rest,
      checksum: parsed ? parsed.aria2 : '',
      torrentFile: torrentFile || '',
      headers: req ? req.headers : [],
      userAgent: req ? req.userAgent : '',
    });
  });

  // .torrent files: picked in a dialog or dropped on the window. We keep a private copy
  // in the app folder so the download can resume even if the original is deleted.
  handle('dl:chooseTorrent', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Torrent', extensions: ['torrent'] }],
    });
    return r.canceled ? null : loadTorrent(r.filePaths[0]);
  });
  handle('dl:loadTorrent', (file) => loadTorrent(file));

  // Hash of a finished file, to compare with the one the website shows.
  handle('dl:hash', async (gid, algo) => {
    const item = itemOf(gid);
    if (!item || !item.path || !fs.existsSync(item.path) || fs.statSync(item.path).isDirectory()) return null;
    return hashFile(item.path, algo);
  });
  handle('dl:checkChecksum', (text) => {
    try {
      return parseChecksum(text);
    } catch {
      return { error: 'BAD_CHECKSUM' };
    }
  });
  handle('dl:discardRequest', (requestId) => takeBrowserRequest(requestId));
  // yt-dlp version + "update now" in Settings
  ipcMain.handle('media:toolsStatus', () => (mediaTools ? { ...mediaTools.status, available: mediaTools.available() } : { available: false }));
  ipcMain.handle('media:updateTools', async () => {
    if (!mediaTools) return null;
    const result = await mediaTools.update(() => media && media.procs.size > 0);
    return { ...mediaTools.status, result, available: mediaTools.available() };
  });
  handle('ui:pairAnswer', (id, approved) => {
    const resolve = pairWaiters.get(id);
    pairWaiters.delete(id);
    if (resolve) resolve(!!approved);
  });
  handle('bridge:status', () => ({ port: bridge ? bridge.port : BRIDGE_PORT, error: bridge ? bridge.error : '' }));
  handle('bridge:openExtensionFolder', () => {
    // Installed app: resources/extension. From source: <repo>/extension.
    const dir = app.isPackaged
      ? path.join(process.resourcesPath, 'extension')
      : path.join(__dirname, '..', '..', 'extension');
    return shell.openPath(dir);
  });
  // Video-site downloads have gids starting with "m" (yt-dlp); the rest belong to aria2.
  handle('dl:pause', (gid) => engineOf(gid).pause(gid));
  handle('dl:resume', (gid) => engineOf(gid).resume(gid));
  handle('dl:cancel', (gid) => engineOf(gid).cancel(gid));
  handle('dl:remove', async (gid, deleteFiles) => {
    const files = await engineOf(gid).remove(gid);
    // Files go to the Recycle Bin, not permanently deleted.
    if (deleteFiles) for (const f of files) await shell.trashItem(f).catch(() => {});
  });
  handle('dl:setLimit', (gid, kb) => engineOf(gid).setSpeedLimit(gid, kb));
  handle('dl:move', (gid, how) => (isMediaGid(gid) ? null : dm.move(gid, how)));
  handle('dl:pauseAll', () => Promise.all([dm.pauseAll(), media && media.pauseAll()]));
  handle('dl:resumeAll', () => Promise.all([dm.resumeAll(), media && media.resumeAll()]));
  handle('dl:openFile', async (gid) => {
    const item = itemOf(gid);
    if (item && item.path) return shell.openPath(item.path);
  });
  handle('dl:openFolder', (gid) => {
    const item = itemOf(gid);
    if (!item) return;
    if (item.path && fs.existsSync(item.path)) shell.showItemInFolder(item.path);
    else shell.openPath(item.dir);
  });
  handle('clipboard:write', async (text) => {
    if (watcher) watcher.ignore(text);
    await clipboard.writeText(text); // returns a Promise since Electron 45
  });

  // Native right-click menu. The UI sends [{id, label, enabled} | {type:'separator'}]
  // and gets back the id that was clicked (or null).
  ipcMain.handle('ui:popupMenu', (_e, items) =>
    new Promise((resolve) => {
      let chosen = null;
      const menu = Menu.buildFromTemplate(
        items.map((it) =>
          it.type === 'separator'
            ? { type: 'separator' }
            : { label: it.label, enabled: it.enabled !== false, click: () => (chosen = it.id) }
        )
      );
      menu.popup({ window: win, callback: () => setImmediate(() => resolve(chosen)) });
    })
  );
  ipcMain.handle('app:quit', () => app.quit());

  ipcMain.handle('power:cancel', () => cancelPowerCountdown());
  ipcMain.handle('update:status', () => (updater ? updater.status : { state: 'unavailable', version: app.getVersion() }));
  ipcMain.handle('update:check', () => (updater ? updater.check() : null));
  ipcMain.handle('update:install', () => updater && updater.installNow());

  // Test only: run the scheduler as if it were a given time.
  if (process.env.MIDO_TEST === '1') {
    ipcMain.handle('test:scheduleTick', async (_e, iso, reset) => {
      if (reset) scheduler.lastInside = null;
      const inside = await scheduler.tick(new Date(iso));
      await poll();
      return inside;
    });
  }
}

app.whenReady().then(async () => {
  settings = new Settings(dataDir, app.getPath('downloads'));
  registerIpc();
  createWindow();

  tray = new AppTray({
    iconPath: ICON,
    lang: () => settings.values.lang,
    actions: {
      show: showWindow,
      add: () => openAddDialog(),
      pauseAll: () => dm && Promise.all([dm.pauseAll(), media && media.pauseAll()]).then(poll),
      resumeAll: () => dm && Promise.all([dm.resumeAll(), media && media.resumeAll()]).then(poll),
      quit: () => app.quit(),
    },
  });

  watcher = new ClipboardWatcher((url) => openAddDialog(url));
  if (settings.values.clipboardWatch) watcher.start();

  try {
    aria2 = new Aria2({ binPath: aria2Binary(), dataDir });
    await aria2.start(settings.aria2Options());
    dm = new DownloadManager({
      aria2,
      dataDir,
      // Saved site logins are passed to aria2 per download.
      extraOptions: (url) => {
        const login = settings.loginFor(url);
        if (!login) return {};
        return { 'http-user': login.user, 'http-passwd': login.pass, 'ftp-user': login.user, 'ftp-passwd': login.pass };
      },
      retrySettings: () => settings.values,
      secrets: { encrypt, decrypt }, // cookies from the browser are stored encrypted
    });
    dm.on('complete', (item) =>
      notify(tr().done, item.name, () => {
        if (item.path && fs.existsSync(item.path)) shell.showItemInFolder(item.path);
      })
    );
    dm.on('failed', (item) => notify(tr().failed, `${item.name}\n${item.errorMessage || ''}`, showWindow));
    await dm.restoreAfterStart();

    // If aria2 is killed (antivirus, crash, Task Manager) start it again and put the
    // unfinished downloads back, instead of leaving the app without an engine.
    aria2.on('died', async (code) => {
      console.error(`[aria2] stopped unexpectedly (code ${code}), restarting`);
      engineRestarting = true;
      for (let attempt = 1; attempt <= 5 && !quitting; attempt++) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        if (quitting) break;
        try {
          await aria2.start(settings.aria2Options());
          await dm.restoreAfterStart();
          console.log('[aria2] restarted');
          break;
        } catch (e) {
          console.error(`[aria2] restart attempt ${attempt} failed: ${e.message}`);
        }
      }
      engineRestarting = false;
      if (!quitting && !aria2.ready) {
        notify(tr().failed, 'aria2', showWindow);
      }
    });

    // Video sites (YouTube, Facebook, Instagram…) through yt-dlp + ffmpeg.
    mediaTools = new MediaTools({ resourcesDir: resourcesDir(), dataDir });
    await mediaTools.prepare().catch((e) => console.error('[yt-dlp] prepare failed:', e.message));
    media = new MediaManager({
      dataDir,
      tools: () => mediaTools.paths(),
      settings: () => settings.values,
      secrets: { encrypt, decrypt },
    });
    // A playlist gets ONE notification when its last video is done, not one per video.
    const playlistFinished = (item) => {
      if (!item.playlist || media.playlistBusy(item.playlist.id)) return false;
      const s = media.playlistSummary(item.playlist.id);
      notify(tr().playlistDone, tr().playlistBody(s), () => {
        if (item.path && fs.existsSync(item.path)) shell.showItemInFolder(item.path);
        else showWindow();
      });
      return true;
    };
    media.on('complete', (item) => {
      if (item.playlist) return playlistFinished(item);
      notify(tr().done, item.name, () => {
        if (item.path && fs.existsSync(item.path)) shell.showItemInFolder(item.path);
      });
    });
    media.on('failed', (item) => {
      if (item.playlist) return playlistFinished(item);
      notify(tr().failed, `${item.name}\n${item.errorMessage || ''}`, showWindow);
    });
    media.schedule(); // continue videos that were downloading when the app closed
    markMediaReady();
    // Keep yt-dlp fresh (sites change often): check a minute after start, then twice a day.
    if (process.env.MIDO_TEST !== '1') {
      const updateTools = () => mediaTools.updateIfDue(() => media.procs.size > 0).catch(() => {});
      setTimeout(updateTools, 60000);
      setInterval(updateTools, 12 * 60 * 60 * 1000);
    }

    pollTimer = setInterval(poll, 1000);
    poll();

    bridge = new BrowserBridge({
      settings,
      version: app.getVersion(),
      port: Number(process.env.MIDO_BRIDGE_PORT) || BRIDGE_PORT,
      onPairRequest,
      onDownload: onBrowserDownload,
    });
    bridge.start();

    scheduler = new Scheduler({
      settings: () => settings.values,
      startAll: async () => {
        console.log('[schedule] start time: resuming downloads');
        await Promise.all([dm.resumeAll(), media.resumeAll()]);
        poll();
      },
      stopAll: async () => {
        console.log('[schedule] stop time: pausing downloads');
        await Promise.all([dm.pauseAll(), media.pauseAll()]);
        poll();
      },
    });
    // In tests the clock is driven by hand (test:scheduleTick), not by the real time.
    if (process.env.MIDO_TEST !== '1') scheduler.start();

    updater = new Updater((status) => sendToUi('ui:update', status));
    if (settings.values.autoUpdate) updater.startAutomatic();
  } catch (e) {
    dialog.showErrorBox('Mido Download', `Could not start the download engine (aria2):\n${e.message}`);
    quitting = true;
    app.quit();
  }
}).catch((e) => {
  console.error('startup failed:', e);
  dialog.showErrorBox('Mido Download', `Startup failed:\n${e.stack || e.message}`);
  quitting = true;
  app.quit();
});

app.on('second-instance', showWindow);

// Some ways of closing (e.g. window.close() from the page) skip the 'close' event and
// destroy the window directly. With close-to-tray on, keep running anyway.
app.on('window-all-closed', () => {
  if (!quitting && settings && settings.values.closeToTray) return;
  app.quit();
});

// Shut aria2 down cleanly (saves the session) before the app exits.
app.on('before-quit', async (e) => {
  if (quitting && !dm) return;
  if (quitting === 'done') return;
  e.preventDefault();
  if (quitting === 'stopping') return;
  quitting = 'stopping';
  clearInterval(pollTimer);
  if (watcher) watcher.stop();
  if (bridge) bridge.stop();
  try {
    if (dm) {
      await beforeAppClose(dm, dm.list().filter((d) => d.status === 'active' || d.status === 'waiting'));
      await dm.refresh();
    }
    if (media) await media.stopAll(); // stops yt-dlp; those videos continue next time
    if (aria2) await aria2.stop();
  } catch (err) {
    console.error('shutdown error:', err.message);
  }
  if (scheduler) scheduler.stop();
  if (pendingPower) powerAction(pendingPower); // e.g. shut down after everything finished
  if (tray) tray.destroy();
  quitting = 'done';
  app.exit(0);
});
