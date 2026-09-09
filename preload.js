const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('budgetStore', {
  load: () => ipcRenderer.invoke('data:load'),
  save: (data) => ipcRenderer.invoke('data:save', data),
  syncPull: (url) => ipcRenderer.invoke('sync:pull', url),
  syncPush: (url, data, expectedUpdatedAt) => ipcRenderer.invoke('sync:push', url, data, expectedUpdatedAt),
  backupExport: (data) => ipcRenderer.invoke('backup:export', data),
  backupImport: () => ipcRenderer.invoke('backup:import')
});
