'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (name) => (...args) => ipcRenderer.invoke(name, ...args);

contextBridge.exposeInMainWorld('studio', {
  pickFile: call('pickFile'),
  readSubs: call('readSubs'),
  saveSubs: call('saveSubs'),
  pickSubsMany: call('pickSubsMany'),
  saveSubsBatch: call('saveSubsBatch'),
  previewVideo: call('previewVideo'),
  probe: call('probe'),
  dubAnalyze: call('dubAnalyze'),
  dubExport: call('dubExport'),
  cancel: call('cancel'),
  showInFolder: call('showInFolder'),
  version: call('version'),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  onDubProgress: (fn) => ipcRenderer.on('dubProgress', (_e, v) => fn(v)),
});
