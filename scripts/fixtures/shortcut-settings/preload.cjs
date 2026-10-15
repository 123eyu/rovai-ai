const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('shortcutsApi', {
  get: () => ipcRenderer.invoke('shortcuts:get'),
  save: input => ipcRenderer.invoke('shortcuts:save', input),
  setRecording: value => ipcRenderer.invoke('shortcuts:record', value),
  onChanged: listener => { const handler = (_event, value) => listener(value); ipcRenderer.on('shortcuts:changed', handler); return () => ipcRenderer.removeListener('shortcuts:changed', handler) },
  onMouseSide: listener => { const handler = (_event, value) => listener(value); ipcRenderer.on('rovai:shortcut-mouse', handler); return () => ipcRenderer.removeListener('rovai:shortcut-mouse', handler) }
})
