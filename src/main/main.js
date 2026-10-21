const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const git = { ...require('./git'), ...require('./git-extra') };

let win;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return { recent: [], theme: 'dark' };
  }
}

function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2), 'utf8');
}

function createWindow() {
  const s = loadSettings();
  win = new BrowserWindow({
    width: s.bounds?.width || 1400,
    height: s.bounds?.height || 900,
    x: s.bounds?.x,
    y: s.bounds?.y,
    minWidth: 960,
    minHeight: 600,
    title: 'CodeFlow',
    backgroundColor: s.theme === 'light' ? '#f7f8fa' : '#1e1f22',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('close', () => {
    const cur = loadSettings();
    cur.bounds = win.getBounds();
    saveSettings(cur);
  });
  win.on('focus', () => win.webContents.send('window-focus'));
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
}

const gitMethods = require('./channels').filter((n) => n !== 'rollback');

for (const name of gitMethods) {
  ipcMain.handle(`git:${name}`, async (_e, repo, ...args) => {
    try {
      return { ok: true, data: await git[name](repo, ...args) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

ipcMain.handle('git:rollback', async (_e, repo, files) => {
  try {
    const toTrash = await git.rollback(repo, files);
    for (const p of toTrash) {
      if (fs.existsSync(p)) await shell.trashItem(p);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('repo:open', async (_e, dir) => {
  const top = await git.topLevel(dir);
  if (!top) return { ok: false, error: '선택한 폴더는 Git 저장소가 아닙니다.', notRepo: true };
  addRecent(top);
  return { ok: true, data: top };
});

ipcMain.handle('repo:init', async (_e, dir) => {
  try {
    await git.init(dir);
    addRecent(dir);
    return { ok: true, data: dir };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('repo:clone', async (_e, url, dir) => {
  try {
    await git.clone(url, dir);
    addRecent(dir);
    return { ok: true, data: dir };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function addRecent(dir) {
  const s = loadSettings();
  s.recent = [dir, ...(s.recent || []).filter((d) => d !== dir)].slice(0, 15);
  s.last = dir;
  saveSettings(s);
}

// 코드 화면: 파일 작업
const files = require('./files');
for (const name of ['list', 'read', 'write', 'stat', 'createFile', 'createFolder', 'rename', 'trash']) {
  ipcMain.handle(`fs:${name}`, async (_e, ...args) => {
    try {
      return { ok: true, data: await files[name](...args) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

// 코드 화면: 언어 서버 (오류 표시, 자동 완성 등)
const lsp = require('./lsp');
ipcMain.handle('lsp:start', async (e, lang, root, opts) => {
  try {
    return { ok: true, data: await lsp.start(lang, root, (ch, ...a) => !e.sender.isDestroyed() && e.sender.send(ch, ...a), opts) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.on('lsp:send', (_e, id, msg) => lsp.sendTo(id, msg));
ipcMain.handle('lsp:stop', (_e, id) => lsp.stop(id));
app.on('before-quit', () => lsp.stopAll());

// 코드 화면: Java 언어 팩 (설치/제거/상태, 설치된 JDK, 프로젝트 Java 버전)
const javapack = require('./javapack');
ipcMain.handle('java:status', () => javapack.status());
ipcMain.handle('java:install', async (e) => {
  try {
    return { ok: true, data: await javapack.install((p) => !e.sender.isDestroyed() && e.sender.send('java:progress', p)) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});
ipcMain.handle('java:remove', () => {
  try {
    return { ok: true, data: javapack.remove() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('java:project', (_e, root) => javapack.projectInfo(root));
// 프로젝트 구조/JDK 를 바꾼 뒤: 실행 중인 언어 서버에 보낼 새 설정
ipcMain.handle('java:startInfo', (_e, root) => lsp.javaStartInfo(root));
ipcMain.handle('java:isProject', (_e, root) => javapack.isJavaProject(root));
ipcMain.handle('java:jarsIn', (_e, dir) => javapack.jarsIn(dir));
ipcMain.handle('java:saveConfig', (_e, root, patch) => {
  try {
    return { ok: true, data: javapack.saveConfig(root, patch) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('java:addJdk', (_e, home) => {
  try {
    return { ok: true, data: javapack.addCustomJdk(home) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 코드 화면: Python 인터프리터 목록
ipcMain.handle('python:interpreters', (_e, root) => require('./python').interpreters(root));

// 코드 화면: 터미널
const terminal = require('./terminal');
ipcMain.handle('term:shells', () => terminal.shells().map(({ id, name }) => ({ id, name })));
ipcMain.handle('term:create', (e, opts) => {
  try {
    return { ok: true, data: terminal.create(opts, (ch, ...a) => !e.sender.isDestroyed() && e.sender.send(ch, ...a)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.on('term:write', (_e, id, data) => terminal.write(id, data));
ipcMain.on('term:resize', (_e, id, cols, rows) => terminal.resize(id, cols, rows));
ipcMain.handle('term:kill', (_e, id) => terminal.kill(id));
app.on('before-quit', () => terminal.killAll());

// 앱 업데이트
const updater = require('./updater');
ipcMain.handle('update:check', async () => {
  try {
    return { ok: true, data: await updater.check() };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});
ipcMain.handle('update:install', async (_e, url) => {
  try {
    return { ok: true, data: await updater.install(url) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});
ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_e, patch) => {
  const s = { ...loadSettings(), ...patch };
  saveSettings(s);
  return s;
});
ipcMain.handle('recent:remove', (_e, dir) => {
  const s = loadSettings();
  s.recent = (s.recent || []).filter((d) => d !== dir);
  if (s.last === dir) delete s.last;
  saveSettings(s);
  return s;
});

ipcMain.handle('dialog:folder', async (_e, title) => {
  const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:files', async (_e, title, filters, defaultPath) => {
  const r = await dialog.showOpenDialog(win, { title, defaultPath, filters, properties: ['openFile', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
ipcMain.handle('shell:showItem', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('shell:openExternal', (_e, url) => {
  if (/^https?:\/\//.test(url)) return shell.openExternal(url);
});
ipcMain.handle('path:join', (_e, ...parts) => path.join(...parts));
ipcMain.handle('path:exists', (_e, p) => fs.existsSync(p));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
