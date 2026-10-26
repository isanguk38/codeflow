const { contextBridge, ipcRenderer, clipboard, webUtils } = require('electron');

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
  pickFiles: (title, filters, defaultPath) => ipcRenderer.invoke('dialog:files', title, filters, defaultPath),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  joinPath: (...parts) => ipcRenderer.invoke('path:join', ...parts),
  exists: (p) => ipcRenderer.invoke('path:exists', p),
  copy: (text) => clipboard.writeText(text),
  onFocus: (cb) => ipcRenderer.on('window-focus', cb),
  fs: Object.fromEntries(['list', 'read', 'write', 'stat', 'createFile', 'createFolder', 'rename', 'trash'].map((n) => [n, (...a) => ipcRenderer.invoke(`fs:${n}`, ...a)])),
  file: {
    preview: (p) => ipcRenderer.invoke('file:preview', p),
    saveCopy: (p) => ipcRenderer.invoke('file:saveCopy', p),
    saveAs: (p, opts) => ipcRenderer.invoke('file:saveAs', p, opts),
    stat: (p) => ipcRenderer.invoke('file:stat', p),
    appPath: (name) => ipcRenderer.invoke('app:path', name),
    saveXlsx: (name, sheets) => ipcRenderer.invoke('xlsx:save', name, sheets),
  },
  issues: {
    list: (repo, opts) => ipcRenderer.invoke('issues:list', repo, opts),
    setToken: (repo, token) => ipcRenderer.invoke('issues:setToken', repo, token),
  },
  ai: {
    status: (id) => ipcRenderer.invoke('ai:status', id),
    install: (id) => ipcRenderer.invoke('ai:install', id),
    login: (id) => ipcRenderer.invoke('ai:login', id),
    loginInput: (text) => ipcRenderer.send('ai:loginInput', text),
    cancelLogin: () => ipcRenderer.invoke('ai:cancelLogin'),
    logout: (id) => ipcRenderer.invoke('ai:logout', id),
    start: (opts) => ipcRenderer.invoke('ai:start', opts),
    send: (id, content) => ipcRenderer.invoke('ai:send', id, content),
    stop: (id) => ipcRenderer.invoke('ai:stop', id),
    refreshUsage: (id) => ipcRenderer.invoke('ai:refreshUsage', id),
    sessions: (repo) => ipcRenderer.invoke('ai:sessions', repo),
    mcpList: (id) => ipcRenderer.invoke('ai:mcpList', id),
    outputDir: (repo) => ipcRenderer.invoke('ai:outputDir', repo),
    codexUpdateInfo: (force) => ipcRenderer.invoke('ai:codexUpdateInfo', force),
    codexUpdate: () => ipcRenderer.invoke('ai:codexUpdate'),
    codexRollback: () => ipcRenderer.invoke('ai:codexRollback'),
    convList: (repo) => ipcRenderer.invoke('ai:convList', repo),
    convLoad: (repo, id) => ipcRenderer.invoke('ai:convLoad', repo, id),
    convSave: (repo, conv) => ipcRenderer.invoke('ai:convSave', repo, conv),
    convRemove: (repo, id) => ipcRenderer.invoke('ai:convRemove', repo, id),
    readAttachment: (file) => ipcRenderer.invoke('ai:readAttachment', file),
    // 끌어다 놓은 파일의 실제 경로
    filePath: (file) => {
      try {
        return webUtils.getPathForFile(file) || null;
      } catch {
        return null;
      }
    },
    transcript: (repo, id) => ipcRenderer.invoke('ai:transcript', repo, id),
    onLog: (cb) => ipcRenderer.on('ai:log', (_e, line) => cb(line)),
    onEvent: (cb) => ipcRenderer.on('ai:event', (_e, id, ev) => cb(id, ev)),
    onTool: (cb) => ipcRenderer.on('ai:tool', (_e, reqId, repo, action, args) => cb(reqId, repo, action, args)),
    toolResult: (reqId, result) => ipcRenderer.send('ai:toolResult', reqId, result),
  },
  lsp: {
    start: (lang, root, opts) => ipcRenderer.invoke('lsp:start', lang, root, opts),
    send: (id, msg) => ipcRenderer.send('lsp:send', id, msg),
    stop: (id) => ipcRenderer.invoke('lsp:stop', id),
    onMessage: (cb) => ipcRenderer.on('lsp:message', (_e, id, msg) => cb(id, msg)),
    onExit: (cb) => ipcRenderer.on('lsp:exit', (_e, id, code) => cb(id, code)),
  },
  term: {
    shells: () => ipcRenderer.invoke('term:shells'),
    create: (opts) => ipcRenderer.invoke('term:create', opts),
    write: (id, data) => ipcRenderer.send('term:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
    kill: (id) => ipcRenderer.invoke('term:kill', id),
    onData: (cb) => ipcRenderer.on('term:data', (_e, id, d) => cb(id, d)),
    onExit: (cb) => ipcRenderer.on('term:exit', (_e, id, code) => cb(id, code)),
  },
  paste: () => clipboard.readText(),
  pythonInterpreters: (root) => ipcRenderer.invoke('python:interpreters', root),
  java: {
    status: () => ipcRenderer.invoke('java:status'),
    install: () => ipcRenderer.invoke('java:install'),
    remove: () => ipcRenderer.invoke('java:remove'),
    project: (root) => ipcRenderer.invoke('java:project', root),
    startInfo: (root) => ipcRenderer.invoke('java:startInfo', root),
    saveConfig: (root, patch) => ipcRenderer.invoke('java:saveConfig', root, patch),
    jarsIn: (dir) => ipcRenderer.invoke('java:jarsIn', dir),
    isProject: (root) => ipcRenderer.invoke('java:isProject', root),
    addJdk: (home) => ipcRenderer.invoke('java:addJdk', home),
    onProgress: (cb) => ipcRenderer.on('java:progress', (_e, p) => cb(p)),
  },
  appVersion: () => ipcRenderer.invoke('app:version'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: (url) => ipcRenderer.invoke('update:install', url),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, p) => cb(p)),
});
