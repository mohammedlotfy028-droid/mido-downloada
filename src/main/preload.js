// Safe bridge between the UI and the main process (the UI has no direct Node access).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseDir: (current) => ipcRenderer.invoke('dialog:chooseDir', current),

  probe: (url, requestId) => ipcRenderer.invoke('dl:probe', url, requestId),
  mediaInfo: (url, requestId) => ipcRenderer.invoke('dl:mediaInfo', url, requestId),
  mediaToolsStatus: () => ipcRenderer.invoke('media:toolsStatus'),
  updateMediaTools: () => ipcRenderer.invoke('media:updateTools'),
  discardRequest: (requestId) => ipcRenderer.invoke('dl:discardRequest', requestId),
  answerPair: (id, approved) => ipcRenderer.invoke('ui:pairAnswer', id, approved),
  bridgeStatus: () => ipcRenderer.invoke('bridge:status'),
  openExtensionFolder: () => ipcRenderer.invoke('bridge:openExtensionFolder'),
  suggestDir: (category) => ipcRenderer.invoke('dl:suggestDir', category),
  add: (opts) => ipcRenderer.invoke('dl:add', opts),
  chooseTorrent: () => ipcRenderer.invoke('dl:chooseTorrent'),
  loadTorrent: (file) => ipcRenderer.invoke('dl:loadTorrent', file),
  // Real path of a file dropped on the window (needed for .torrent files).
  pathForFile: (file) => webUtils.getPathForFile(file),
  hash: (gid, algo) => ipcRenderer.invoke('dl:hash', gid, algo),
  checkChecksum: (text) => ipcRenderer.invoke('dl:checkChecksum', text),
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
  onOpenAdd: (cb) => ipcRenderer.on('ui:add', (_e, url, ctx) => cb(url, ctx)),
  onPairRequest: (cb) => ipcRenderer.on('ui:pair', (_e, req) => cb(req)),

  cancelPower: () => ipcRenderer.invoke('power:cancel'),
  onPower: (cb) => ipcRenderer.on('ui:power', (_e, p) => cb(p)),
  onPowerDone: (cb) => ipcRenderer.on('ui:powerDone', (_e, a) => cb(a)),
  updateStatus: () => ipcRenderer.invoke('update:status'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate: (cb) => ipcRenderer.on('ui:update', (_e, s) => cb(s)),
  // Only works when the app runs with MIDO_TEST=1.
  testScheduleTick: (iso, reset) => ipcRenderer.invoke('test:scheduleTick', iso, reset),
});
