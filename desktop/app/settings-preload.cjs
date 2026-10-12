const { contextBridge, ipcRenderer } = require('electron')

// The page can read whether a key exists and save settings, but it never receives the key itself.
contextBridge.exposeInMainWorld('clipforgeSettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  save: (payload) => ipcRenderer.invoke('settings:save', payload),
})
