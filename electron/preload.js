const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  start: () => ipcRenderer.invoke('start'),
  stop: () => ipcRenderer.invoke('stop'),
  checkNow: () => ipcRenderer.invoke('check-now'),
  simulateSlot: () => ipcRenderer.invoke('simulate-slot'),
  openLogin: () => ipcRenderer.invoke('open-login'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  openLastScreenshot: () => ipcRenderer.invoke('open-last-screenshot'),
  onLog: (cb) => ipcRenderer.on('log', (_e, line) => cb(line)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
  onSlotFound: (cb) => ipcRenderer.on('slot-found', (_e, r) => cb(r)),
});
