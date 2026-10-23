// Safe bridge between the UI and the main process (the UI has no direct Node access).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseDir: (current) => ipcRenderer.invoke('dialog:chooseDir', current),

  probe: (url) => ipcRenderer.invoke('dl:probe', url),
  suggestDir: (category) => ipcRenderer.invoke('dl:suggestDir', category),
  add: (opts) => ipcRenderer.invoke('dl:add', opts),
  pause: (gid) => ipcRenderer.invoke('dl:pause', gid),
  resume: (gid) => ipcRenderer.invoke('dl:resume', gid),
  cancel: (gid) => ipcRenderer.invoke('dl:cancel', gid),
  remove: (gid, deleteFiles) => ipcRenderer.invoke('dl:remove', gid, deleteFiles),
  setLimit: (gid, kb) => ipcRenderer.invoke('dl:setLimit', gid, kb),
  move: (gid, how) => ipcRenderer.invoke('dl:move', gid, how),
  pauseAll: () => ipcRenderer.invoke('dl:pauseAll'),
  resumeAll: () => ipcRenderer.invoke('dl:resumeAll'),
  openFile: (gid) => ipcRenderer.invoke('dl:openFile', gid),
  openFolder: (gid) => ipcRenderer.invoke('dl:openFolder', gid),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  popupMenu: (items) => ipcRenderer.invoke('ui:popupMenu', items),
  quit: () => ipcRenderer.invoke('app:quit'),

  onDownloads: (cb) => ipcRenderer.on('downloads', (_e, list) => cb(list)),
  onOpenAdd: (cb) => ipcRenderer.on('ui:add', (_e, url) => cb(url)),
});
