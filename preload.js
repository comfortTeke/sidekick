const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sidekick', {
  getState: () => ipcRenderer.invoke('state'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  setKey: (key) => ipcRenderer.invoke('key:set', key),

  createProfile: () => ipcRenderer.invoke('profile:create'),
  updateProfile: (p) => ipcRenderer.invoke('profile:update', p),
  deleteProfile: (id) => ipcRenderer.invoke('profile:delete', id),
  addFile: (id) => ipcRenderer.invoke('profile:addFile', id),
  removeFile: (id, filePath) => ipcRenderer.invoke('profile:removeFile', id, filePath),

  sendChunk: (who, data, mimeType) => ipcRenderer.invoke('audio:chunk', { who, data, mimeType }),
  ask: (opts) => ipcRenderer.invoke('ask', opts),
  summarize: () => ipcRenderer.invoke('summarize'),
  clear: () => ipcRenderer.invoke('clear'),
  setListening: (on) => ipcRenderer.send('listening', on),
  openNotes: () => ipcRenderer.invoke('open-notes'),
  openLog: () => ipcRenderer.invoke('open-log'),
  hide: () => ipcRenderer.send('hide'),
  focus: () => ipcRenderer.send('focus'),
  quit: () => ipcRenderer.send('quit'),

  on: (channel, fn) => {
    const allowed = ['transcript:line', 'answer:start', 'answer:delta', 'answer:done',
      'answer:error', 'status', 'state', 'open-panel'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
