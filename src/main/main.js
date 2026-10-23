// Electron main process: starts aria2, owns the download list, talks to the UI over IPC.
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const { Aria2 } = require('./aria2');
const { DownloadManager } = require('./downloads');
const { beforeAppClose } = require('./quit-behavior');

// Dev/test: run with a separate data folder so tests don't touch real data.
if (process.env.MIDO_DATA_DIR) app.setPath('userData', path.resolve(process.env.MIDO_DATA_DIR));

// Only one copy of the app may run (two aria2 instances would fight over the session file).
if (!app.requestSingleInstanceLock()) app.quit();

const dataDir = app.getPath('userData');
const settingsFile = path.join(dataDir, 'settings.json');
const DEFAULT_SETTINGS = { lang: 'ar', theme: 'system', downloadDir: app.getPath('downloads'), split: 8 };

let settings = { ...DEFAULT_SETTINGS };
let win = null;
let aria2 = null;
let dm = null;
let pollTimer = null;
let quitting = false;

function loadSettings() {
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) };
  } catch {
    /* first run */
  }
}
function saveSettings() {
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

function aria2Binary() {
  // Packaged app: resources/aria2/aria2c.exe next to app.asar. Dev: <repo>/resources/aria2.
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'aria2')
    : path.join(__dirname, '..', '..', 'resources', 'aria2');
  return path.join(base, process.platform === 'win32' ? 'aria2c.exe' : 'aria2c');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 680,
    minWidth: 820,
    minHeight: 480,
    title: 'Mido Downloada',
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

async function poll() {
  if (!dm || !win || win.isDestroyed()) return;
  try {
    win.webContents.send('downloads', await dm.refresh());
  } catch (e) {
    console.error('poll failed:', e.message);
  }
}

function registerIpc() {
  const handle = (name, fn) =>
    ipcMain.handle(name, async (_e, ...args) => {
      const result = await fn(...args);
      poll(); // push fresh state right away instead of waiting for the next tick
      return result;
    });

  handle('settings:get', () => settings);
  handle('settings:set', (patch) => {
    settings = { ...settings, ...patch };
    saveSettings();
    return settings;
  });
  handle('dialog:chooseDir', async (current) => {
    const r = await dialog.showOpenDialog(win, {
      defaultPath: current || settings.downloadDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('dl:add', (opts) => dm.add(opts));
  handle('dl:pause', (gid) => dm.pause(gid));
  handle('dl:resume', (gid) => dm.resume(gid));
  handle('dl:cancel', (gid) => dm.cancel(gid));
  handle('dl:remove', async (gid, deleteFiles) => {
    const files = await dm.remove(gid);
    // Files go to the Recycle Bin, not permanently deleted.
    if (deleteFiles) for (const f of files) await shell.trashItem(f).catch(() => {});
  });
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
}

app.whenReady().then(async () => {
  loadSettings();
  registerIpc();
  createWindow();
  try {
    aria2 = new Aria2({ binPath: aria2Binary(), dataDir });
    await aria2.start();
    dm = new DownloadManager({ aria2, dataDir });
    pollTimer = setInterval(poll, 1000);
    poll();
  } catch (e) {
    dialog.showErrorBox('Mido Downloada', `Could not start the download engine (aria2):\n${e.message}`);
    app.quit();
  }
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => app.quit());

// Shut aria2 down cleanly (saves the session) before the app exits.
app.on('before-quit', async (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  clearInterval(pollTimer);
  try {
    if (dm) {
      await beforeAppClose(dm, dm.list().filter((d) => d.status === 'active' || d.status === 'waiting'));
      await dm.refresh();
    }
    if (aria2) await aria2.stop();
  } catch (err) {
    console.error('shutdown error:', err.message);
  }
  app.exit(0);
});
