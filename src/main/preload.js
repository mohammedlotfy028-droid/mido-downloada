// Safe bridge between the UI and the main process (the UI has no direct Node access).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseDir: (current) => ipcRenderer.invoke('dialog:chooseDir', current),

  add: (opts) => ipcRenderer.invoke('dl:add', opts),
  pause: (gid) => ipcRenderer.invoke('dl:pause', gid),
  resume: (gid) => ipcRenderer.invoke('dl:resume', gid),
  cancel: (gid) => ipcRenderer.invoke('dl:cancel', gid),
  remove: (gid, deleteFiles) => ipcRenderer.invoke('dl:remove', gid, deleteFiles),
  pauseAll: () => ipcRenderer.invoke('dl:pauseAll'),
  resumeAll: () => ipcRenderer.invoke('dl:resumeAll'),
  openFile: (gid) => ipcRenderer.invoke('dl:openFile', gid),
  openFolder: (gid) => ipcRenderer.invoke('dl:openFolder', gid),

  onDownloads: (cb) => ipcRenderer.on('downloads', (_e, list) => cb(list)),
});
