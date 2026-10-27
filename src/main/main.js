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
  // 입력 칸 오른쪽 클릭: 잘라내기 / 복사 / 붙여넣기 / 모두 선택 (메뉴 막대가 없어서 기본 메뉴가 안 뜸)
  win.webContents.on('context-menu', (_e, p) => {
    if (!p.isEditable && !p.selectionText) return;
    const f = p.editFlags || {};
    const items = p.isEditable
      ? [
          { label: '잘라내기', role: 'cut', enabled: !!f.canCut },
          { label: '복사', role: 'copy', enabled: !!f.canCopy },
          { label: '붙여넣기', role: 'paste', enabled: !!f.canPaste },
          { type: 'separator' },
          { label: '모두 선택', role: 'selectAll' },
        ]
      : [{ label: '복사', role: 'copy' }];
    Menu.buildFromTemplate(items).popup({ window: win });
  });
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

// 프로젝트 전체 검색 (Ctrl+Shift+F): 결과는 찾는 대로 search:found / search:done 으로 보낸다
// 검색은 별도 스레드에서 (메인 프로세스가 바쁘면 창이 다시 그려지지 않아 입력이 버벅인다)
const { Worker } = require('worker_threads');
let searchWorker = null;
const searchSenders = new Map(); // 검색 id → 결과를 받을 창
function getSearchWorker() {
  if (searchWorker) return searchWorker;
  // 설치본에서는 asar 밖(app.asar.unpacked)에 풀어 둔 파일로 실행
  const file = path.join(__dirname, 'search.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  searchWorker = new Worker(file);
  searchWorker.on('message', ({ kind, data }) => {
    const wc = searchSenders.get(data.id);
    if (wc && !wc.isDestroyed()) wc.send(`search:${kind}`, data);
    if (kind === 'done') searchSenders.delete(data.id);
  });
  const reset = (err) => {
    if (err) console.error('search worker', err);
    for (const [id, wc] of searchSenders) if (!wc.isDestroyed()) wc.send('search:done', { id, error: '검색 중 오류가 났습니다. 다시 시도해 주세요.' });
    searchSenders.clear();
    searchWorker = null;
  };
  searchWorker.on('error', reset);
  searchWorker.on('exit', () => searchWorker && reset());
  return searchWorker;
}
ipcMain.on('search:start', (e, repo, id, opts) => {
  searchSenders.set(id, e.sender);
  getSearchWorker().postMessage({ type: 'start', repo, id, opts });
});
ipcMain.on('search:cancel', (_e, id) => {
  searchSenders.delete(id);
  searchWorker?.postMessage({ type: 'cancel', id });
});

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

// AI 패널: 외부 AI 도구(Claude Code 등) 설치·로그인·대화, CodeFlow 도구 서버
const ai = require('./ai');
const aiTools = require('./ai-tools');
{
  // AI 가 CodeFlow 도구를 부르면 화면(렌더러)에 요청하고 결과를 기다린다
  const pending = new Map();
  let reqSeq = 0;
  ipcMain.on('ai:toolResult', (_e, reqId, result) => {
    const p = pending.get(reqId);
    if (!p) return;
    pending.delete(reqId);
    clearTimeout(p.timer);
    p.resolve(result || {});
  });
  aiTools.setRendererBridge((repo, action, args, timeoutMs) => {
    if (!win || win.isDestroyed()) return Promise.reject(new Error('CodeFlow 창이 닫혀 있습니다.'));
    const reqId = ++reqSeq;
    return new Promise((resolve) => {
      const timer = timeoutMs ? setTimeout(() => (pending.delete(reqId), resolve({ error: '시간 안에 응답이 없습니다.' })), timeoutMs) : null;
      pending.set(reqId, { resolve, timer });
      win.webContents.send('ai:tool', reqId, repo, action, args);
    });
  });
}
const aiSafe = (fn) => async (...a) => {
  try {
    return { ok: true, data: await fn(...a) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
};
ipcMain.handle('ai:status', aiSafe((_e, id) => ai.status(id)));
ipcMain.handle('ai:install', aiSafe((e, id) => ai.install(id, (l) => !e.sender.isDestroyed() && e.sender.send('ai:log', l))));
ipcMain.handle('ai:login', aiSafe((e, id) => ai.login(id, (l) => !e.sender.isDestroyed() && e.sender.send('ai:log', l))));
ipcMain.on('ai:loginInput', (_e, text) => ai.loginInput(text));
ipcMain.handle('ai:cancelLogin', () => ai.cancelLogin());
ipcMain.handle('ai:logout', aiSafe((_e, id) => ai.logout(id)));
ipcMain.handle('ai:start', aiSafe((e, opts) => ai.startChat(opts, (ch, ...a) => !e.sender.isDestroyed() && e.sender.send(ch, ...a))));
ipcMain.handle('ai:send', aiSafe((_e, id, content) => ai.sendChat(id, content)));
ipcMain.handle('ai:stop', (_e, id) => ai.stopChat(id));
ipcMain.handle('ai:refreshUsage', (_e, id) => ai.refreshUsage(id));
ipcMain.handle('ai:readAttachment', aiSafe((_e, file) => ai.readAttachment(file)));
const aiStore = require('./ai-store');
ipcMain.handle('ai:convList', aiSafe((_e, repo) => aiStore.list(repo)));
ipcMain.handle('ai:convLoad', aiSafe((_e, repo, id) => aiStore.load(repo, id)));
ipcMain.handle('ai:convSave', aiSafe((_e, repo, conv) => aiStore.save(repo, conv)));
ipcMain.handle('ai:convRemove', aiSafe((_e, repo, id) => aiStore.remove(repo, id)));
// Codex 업데이트 확인 / 업데이트 / 이전 버전으로 되돌리기
ipcMain.handle('ai:codexUpdateInfo', aiSafe((_e, force) => require('./codex').updateInfo(force)));
ipcMain.handle('ai:codexUpdate', aiSafe((e) => require('./codex').install((l) => !e.sender.isDestroyed() && e.sender.send('ai:log', l))));
ipcMain.handle('ai:codexRollback', aiSafe(() => require('./codex').rollback()));
ipcMain.handle('ai:outputDir', aiSafe((_e, repo) => ai.outputDir(repo)));
ipcMain.handle('ai:mcpList', aiSafe((_e, id) => ai.mcpList(id)));
ipcMain.handle('ai:sessions', aiSafe((_e, repo) => ai.sessions(repo)));
ipcMain.handle('ai:transcript', aiSafe((_e, repo, id) => ai.transcript(repo, id)));
app.on('before-quit', () => ai.stopAll());

// 멀티 에이전트 팀 (팀 채팅방): 팀장 PM + 팀원 에이전트들, 화면에는 team:event 로 알린다
const team = require('./team');
team.setSender((ch, ...a) => win && !win.isDestroyed() && win.webContents.send(ch, ...a));
ipcMain.handle('team:create', aiSafe((_e, repo, opts) => team.create(repo, opts)));
ipcMain.handle('team:get', aiSafe((_e, id) => team.get(id)));
ipcMain.handle('team:send', aiSafe((_e, id, msg) => team.userSend(id, msg)));
ipcMain.handle('team:resume', aiSafe((_e, id) => team.resume(id)));
ipcMain.handle('team:stopWork', aiSafe((_e, id) => team.stopAllWork(id)));
ipcMain.handle('team:addMember', aiSafe((_e, id, opts) => team.addMemberByUser(id, opts)));
ipcMain.handle('team:removeMember', aiSafe((_e, id, memberId) => team.removeMember(id, memberId)));
ipcMain.handle('team:setMemberAI', aiSafe((_e, id, memberId, opts) => team.setMemberAI(id, memberId, opts)));
ipcMain.handle('team:dispose', aiSafe((_e, id) => team.dispose(id)));
ipcMain.handle('team:listSaved', aiSafe((_e, repo) => team.listSaved(repo)));
ipcMain.handle('team:open', aiSafe((_e, repo, id) => team.open(repo, id)));
ipcMain.handle('team:deleteSaved', aiSafe((_e, repo, id) => team.deleteSaved(repo, id)));
ipcMain.handle('team:openFor', aiSafe((_e, repo) => team.openFor(repo)));
ipcMain.handle('team:refreshUsage', aiSafe((_e, id) => team.refreshUsage(id)));
ipcMain.handle('team:wake', aiSafe((_e, id) => team.wake(id)));
ipcMain.handle('team:older', aiSafe((_e, id, beforeId, count) => team.older(id, beforeId, count)));
ipcMain.handle('team:setProjects', aiSafe((_e, id, scope) => team.setProjects(id, scope)));
app.on('before-quit', () => team.disposeAll());

// 파일 미리보기(이미지) · 다른 이름으로 저장 — AI 대화의 파일 카드, 코드 화면 이미지 보기
const PREVIEW_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
ipcMain.handle('file:preview', aiSafe((_e, p) => {
  const mime = PREVIEW_MIME[path.extname(p).toLowerCase()];
  if (!mime) throw new Error('미리 볼 수 없는 파일입니다.');
  const st = fs.statSync(p);
  if (st.size > 30 * 1024 * 1024) throw new Error('파일이 너무 큽니다 (30MB 초과).');
  return { url: `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`, size: st.size };
}));
// AI 가 만든 문서를 사용자가 고른 곳으로 옮기기 (move=true 면 원본은 지움). 같은 이름이 있으면 덮어쓸지 저장 창이 묻는다
ipcMain.handle('file:saveAs', aiSafe(async (_e, p, { move = false, dir } = {}) => {
  let target;
  if (dir) {
    target = path.join(dir, path.basename(p));
    if (fs.existsSync(target)) {
      const ext = path.extname(p);
      const base = path.basename(p, ext);
      for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, `${base} (${i})${ext}`);
    }
  } else {
    const r = await dialog.showSaveDialog(win, { title: '문서 저장 위치', defaultPath: path.join(app.getPath('documents'), path.basename(p)) });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }
  if (path.resolve(target).toLowerCase() === path.resolve(p).toLowerCase()) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(p, target);
  if (move) fs.rmSync(p, { force: true });
  return target;
}));
ipcMain.handle('file:stat', aiSafe((_e, p) => {
  const st = fs.statSync(p);
  return { size: st.size, mtime: st.mtimeMs, isFile: st.isFile() };
}));
ipcMain.handle('app:path', (_e, name) => app.getPath(name));
// 엑셀(.xlsx)로 저장 (자원 리스트 등): 저장 위치를 묻고 파일을 만든다
ipcMain.handle('xlsx:save', aiSafe(async (_e, defaultName, sheets) => {
  const r = await dialog.showSaveDialog(win, { title: '엑셀로 저장', defaultPath: path.join(app.getPath('documents'), defaultName), filters: [{ name: 'Excel', extensions: ['xlsx'] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, require('./xlsx').build(sheets));
  return r.filePath;
}));
ipcMain.handle('file:saveCopy', aiSafe(async (_e, p) => {
  const r = await dialog.showSaveDialog(win, { title: '다른 이름으로 저장', defaultPath: path.join(app.getPath('downloads'), path.basename(p)) });
  if (r.canceled || !r.filePath) return null;
  fs.copyFileSync(p, r.filePath);
  return r.filePath;
}));

// 이슈 보드 (GitHub / GitLab)
const issues = require('./issues');
ipcMain.handle('issues:list', aiSafe((_e, repo, opts) => issues.list(repo, opts)));
ipcMain.handle('issues:setToken', aiSafe((_e, repo, token) => issues.setToken(repo, token)));

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
