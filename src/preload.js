const { contextBridge, ipcRenderer, clipboard } = require('electron');

// 렌더러에서는 window.api.git.<함수>(repo, ...인자) 형태로 사용한다.
const git = {};
for (const name of require('./main/channels')) {
  git[name] = (...args) => ipcRenderer.invoke(`git:${name}`, ...args);
}

contextBridge.exposeInMainWorld('api', {
  git,
  openRepo: (dir) => ipcRenderer.invoke('repo:open', dir),
  initRepo: (dir) => ipcRenderer.invoke('repo:init', dir),
  cloneRepo: (url, dir) => ipcRenderer.invoke('repo:clone', url, dir),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  removeRecent: (dir) => ipcRenderer.invoke('recent:remove', dir),
  pickFolder: (title) => ipcRenderer.invoke('dialog:folder', title),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  joinPath: (...parts) => ipcRenderer.invoke('path:join', ...parts),
  exists: (p) => ipcRenderer.invoke('path:exists', p),
  copy: (text) => clipboard.writeText(text),
  onFocus: (cb) => ipcRenderer.on('window-focus', cb),
  fs: Object.fromEntries(['list', 'read', 'write', 'stat', 'createFile', 'createFolder', 'rename', 'trash'].map((n) => [n, (...a) => ipcRenderer.invoke(`fs:${n}`, ...a)])),
  lsp: {
    start: (lang, root) => ipcRenderer.invoke('lsp:start', lang, root),
    send: (id, msg) => ipcRenderer.send('lsp:send', id, msg),
    stop: (id) => ipcRenderer.invoke('lsp:stop', id),
    onMessage: (cb) => ipcRenderer.on('lsp:message', (_e, id, msg) => cb(id, msg)),
    onExit: (cb) => ipcRenderer.on('lsp:exit', (_e, id, code) => cb(id, code)),
  },
  appVersion: () => ipcRenderer.invoke('app:version'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: (url) => ipcRenderer.invoke('update:install', url),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, p) => cb(p)),
});
