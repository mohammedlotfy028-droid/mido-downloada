// Electron main process: starts aria2, owns the download list, tray, notifications,
// clipboard watching, and talks to the UI over IPC.
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Notification, Menu, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { Aria2 } = require('./aria2');
const { DownloadManager } = require('./downloads');
const { Settings } = require('./settings');
const { probe } = require('./probe');
const { AppTray } = require('./tray');
const { ClipboardWatcher } = require('./clipboard-watch');
const { beforeAppClose } = require('./quit-behavior');
const { CATEGORIES, categoryOf } = require('../shared/categories');

// Dev/test: run with a separate data folder so tests don't touch real data.
if (process.env.MIDO_DATA_DIR) app.setPath('userData', path.resolve(process.env.MIDO_DATA_DIR));

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
function openAddDialog(url = '') {
  showWindow();
  const send = () => win.webContents.send('ui:add', url);
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 700,
    minWidth: 860,
    minHeight: 500,
    title: 'Mido Downloada',
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
  ar: { done: 'اكتمل التحميل', failed: 'فشل التحميل' },
  en: { done: 'Download complete', failed: 'Download failed' },
};
const tr = () => T[settings.values.lang] || T.en;

let pollCount = 0;
async function poll() {
  if (!dm) return;
  try {
    // Save unfinished downloads every 5s so a crash loses almost nothing
    // (aria2's own periodic save is off because it writes passwords in plain text).
    if (++pollCount % 5 === 0) await aria2.saveSession();
    lastList = await dm.refresh();
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
  handle('dl:probe', async (url) => {
    const info = await probe(url, {
      userAgent: settings.aria2Options()['user-agent'],
      login: settings.loginFor(url),
    });
    const category = categoryOf(info.name, info.type);
    return { ...info, category, dir: suggestDir(category) };
  });
  handle('dl:suggestDir', (category) => suggestDir(category));

  handle('dl:add', (opts) => dm.add(opts));
  handle('dl:pause', (gid) => dm.pause(gid));
  handle('dl:resume', (gid) => dm.resume(gid));
  handle('dl:cancel', (gid) => dm.cancel(gid));
  handle('dl:remove', async (gid, deleteFiles) => {
    const files = await dm.remove(gid);
    // Files go to the Recycle Bin, not permanently deleted.
    if (deleteFiles) for (const f of files) await shell.trashItem(f).catch(() => {});
  });
  handle('dl:setLimit', (gid, kb) => dm.setSpeedLimit(gid, kb));
  handle('dl:move', (gid, how) => dm.move(gid, how));
  handle('dl:pauseAll', () => dm.pauseAll());
  handle('dl:resumeAll', () => dm.resumeAll());
  handle('dl:openFile', async (gid) => {
    const item = dm.items[gid];
    if (item && item.path) return shell.openPath(item.path);
  });
  handle('dl:openFolder', (gid) => {
    const item = dm.items[gid];
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
      pauseAll: () => dm && dm.pauseAll().then(poll),
      resumeAll: () => dm && dm.resumeAll().then(poll),
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
    });
    dm.on('complete', (item) =>
      notify(tr().done, item.name, () => {
        if (item.path && fs.existsSync(item.path)) shell.showItemInFolder(item.path);
      })
    );
    dm.on('failed', (item) => notify(tr().failed, `${item.name}\n${item.errorMessage || ''}`, showWindow));
    await dm.restoreAfterStart();
    pollTimer = setInterval(poll, 1000);
    poll();
  } catch (e) {
    dialog.showErrorBox('Mido Downloada', `Could not start the download engine (aria2):\n${e.message}`);
    quitting = true;
    app.quit();
  }
}).catch((e) => {
  console.error('startup failed:', e);
  dialog.showErrorBox('Mido Downloada', `Startup failed:\n${e.stack || e.message}`);
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
  try {
    if (dm) {
      await beforeAppClose(dm, dm.list().filter((d) => d.status === 'active' || d.status === 'waiting'));
      await dm.refresh();
    }
    if (aria2) await aria2.stop();
  } catch (err) {
    console.error('shutdown error:', err.message);
  }
  if (tray) tray.destroy();
  quitting = 'done';
  app.exit(0);
});
