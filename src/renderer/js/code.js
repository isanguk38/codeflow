// 코드 화면: 파일 탐색기 + 파일 탭 + Monaco 편집기(VS Code 편집기) + 언어 서버 오류 표시 + Git 변경 표시
import { $, h, contextMenu, confirmDialog, promptDialog, choiceDialog, toast, splitter } from './ui.js';
import { state, git, onRefresh, refresh } from './state.js';
import * as lsp from './lsp-client.js';

const MONACO_BASE = '../../node_modules/monaco-editor/min/vs';

let monaco = null;
let editor = null;
let loading = null;
let root;
let boundRepo = null;
let emptyHtml = '';

const docs = new Map(); // 파일 경로(소문자) → { path, repo, model, savedVersion, mtime, bom, headText, deco, viewState, deleted }
const repoViews = new Map(); // 저장소 → { tabs: [경로], active: 경로, expanded: Set<폴더 경로> }

const keyOf = (p) => p.replace(/\//g, '\\').toLowerCase();
const relOf = (repo, p) => p.slice(repo.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
const baseName = (p) => p.split(/[\\/]/).pop();
const view = () => {
  let v = repoViews.get(state.repo);
  if (!v) {
    v = { tabs: [], active: null, expanded: new Set() };
    repoViews.set(state.repo, v);
  }
  return v;
};

// ---------- 화면 뼈대 ----------

export function initCode() {
  root = $('#view-code');
  root.innerHTML = `
    <div class="code-explorer" id="codeExplorer">
      <div class="panel-bar">
        <span class="panel-title">탐색기</span>
        <span class="tb-spacer"></span>
        <button class="tb-btn small" id="codeNewFile" title="새 파일">＋파일</button>
        <button class="tb-btn small" id="codeNewFolder" title="새 폴더">＋폴더</button>
        <button class="tb-btn small" id="codeCollapse" title="모두 접기">⊟</button>
        <button class="tb-btn small" id="codeReload" title="새로고침">⟳</button>
      </div>
      <div class="code-tree" id="codeTree"></div>
    </div>
    <div class="splitter-x" id="codeSplit"></div>
    <div class="code-main">
      <div class="code-tabs" id="codeTabs"></div>
      <div class="code-editor-wrap">
        <div class="code-editor" id="codeEditor"></div>
        <div class="code-empty" id="codeEmpty"><div><b>파일을 선택하세요</b><br><small>왼쪽 탐색기에서 파일을 열면 VS Code 와 같은 편집기로 수정할 수 있습니다.<br>Ctrl+S 저장 · Ctrl+F 찾기 · Ctrl+H 바꾸기 · F12 정의로 이동 · Shift+Alt+F 서식 정리</small></div></div>
      </div>
      <div class="code-status" id="codeStatus"></div>
    </div>`;
  emptyHtml = $('#codeEmpty').innerHTML;
  splitter($('#codeSplit'), $('#codeExplorer'), { min: 160, max: 600, key: 'codeExplorer' });
  $('#codeReload').onclick = () => renderTree();
  $('#codeCollapse').onclick = () => {
    view().expanded.clear();
    renderTree();
  };
  $('#codeNewFile').onclick = () => createIn(state.repo, 'file');
  $('#codeNewFolder').onclick = () => createIn(state.repo, 'folder');

  // 다른 곳(커밋/체크아웃/Pull 등)에서 파일이 바뀌면 열린 파일을 다시 읽고, 탐색기 Git 표시를 갱신
  onRefresh(() => {
    if (!monaco) return;
    checkDiskChanges();
    if (state.view === 'code') {
      if (boundRepo !== state.repo) showRepo();
      else decorateTree();
    }
  });

  // 저장하지 않은 파일이 있으면 앱을 닫기 전에 묻는다
  let allowClose = false;
  window.addEventListener('beforeunload', (e) => {
    if (allowClose) return;
    const dirty = [...docs.values()].filter(isDirty);
    if (!dirty.length) return;
    e.returnValue = false;
    choiceDialog(`저장하지 않은 파일이 ${dirty.length}개 있습니다.\n${dirty.map((d) => `  • ${relOf(d.repo, d.path)}`).join('\n')}`, [
      { label: '저장 안 하고 닫기', value: 'discard', danger: true },
      { label: '모두 저장 후 닫기', value: 'save', primary: true },
    ], { title: '앱 닫기' }).then(async (v) => {
      if (!v) return;
      if (v === 'save') for (const d of dirty) if (!(await saveDoc(d))) return;
      allowClose = true;
      window.close();
    });
  });
}

export async function activateCode() {
  if (!state.repo) return;
  if (!monaco) {
    $('#codeEmpty').innerHTML = '<div class="loading-note"><span class="spinner"></span> 편집기를 준비하는 중...</div>';
    try {
      await loadMonaco();
    } catch (e) {
      $('#codeEmpty').innerHTML = `<div class="empty">편집기를 불러오지 못했습니다: ${e.message}</div>`;
      return;
    }
  }
  showRepo();
}

// ---------- Monaco 불러오기 (처음 코드 화면을 열 때 한 번) ----------

function loadMonaco() {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    window.MonacoEnvironment = { getWorkerUrl: () => new URL(`${MONACO_BASE}/base/worker/workerMain.js`, location.href).href };
    const s = document.createElement('script');
    s.src = `${MONACO_BASE}/loader.js`;
    s.onerror = () => reject(new Error('loader.js 를 찾을 수 없습니다'));
    s.onload = () => {
      window.require.config({ paths: { vs: MONACO_BASE } });
      const loadMain = () =>
        window.require(['vs/editor/editor.main'], () => {
          monaco = window.monaco;
          setupEditor();
          resolve();
        }, reject);
      // 한국어 메뉴/메시지를 먼저 불러온 뒤(실패해도 영어로 계속) 편집기 본체를 불러온다
      window.require(['vs/nls.messages.ko'], loadMain, loadMain);
    };
    document.head.append(s);
  });
  return loading;
}

const monacoTheme = () => (document.documentElement.dataset.theme === 'light' ? 'vs' : 'vs-dark');

function setupEditor() {
  $('#codeEmpty').innerHTML = emptyHtml;
  editor = monaco.editor.create($('#codeEditor'), {
    model: null,
    theme: monacoTheme(),
    automaticLayout: true,
    fontFamily: "'JetBrains Mono', 'D2Coding', Consolas, monospace",
    fontSize: 13,
    minimap: { enabled: true },
    renderWhitespace: 'selection',
    smoothScrolling: true,
    mouseWheelZoom: true,
    'bracketPairColorization.enabled': true,
    guides: { bracketPairs: true, indentation: true },
    fixedOverflowWidgets: true,
  });
  // 앱 테마를 바꾸면 편집기 테마도 따라간다
  new MutationObserver(() => monaco.editor.setTheme(monacoTheme())).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    const d = activeDoc();
    if (d) saveDoc(d);
  });
  editor.onDidChangeCursorPosition(updateStatus);
  monaco.editor.onDidChangeMarkers(() => {
    updateStatus();
    renderTabs();
  });

  lsp.initLsp(monaco, {
    onDiagnostics: () => {},
    openFile: (p, sel) => openFile(p, sel),
    ensureModel: async (p) => (await ensureDoc(p))?.model,
  });
  monaco.editor.registerEditorOpener(lsp.openerFor());
  document.addEventListener('keydown', (e) => {
    if (state.view !== 'code') return;
    if (e.ctrlKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      const d = activeDoc();
      if (d) saveDoc(d);
    }
  });
}

// ---------- 저장소(탭) 전환 ----------

function showRepo() {
  if (!monaco || !state.repo) return;
  if (boundRepo && boundRepo !== state.repo) {
    const prev = repoViews.get(boundRepo);
    const d = prev && docs.get(keyOf(prev.active || ''));
    if (d) d.viewState = editor.saveViewState();
  }
  boundRepo = state.repo;
  renderTree();
  const v = view();
  v.tabs = v.tabs.filter((p) => docs.has(keyOf(p)));
  renderTabs();
  if (v.active && docs.has(keyOf(v.active))) activate(v.active);
  else showEmpty();
}

// ---------- 탐색기 ----------

async function renderTree() {
  const el = $('#codeTree');
  const repo = state.repo;
  const box = h('div', { class: 'tree-root' });
  await renderDir(repo, box, 0, repo);
  if (state.repo !== repo) return;
  el.replaceChildren(box);
  decorateTree();
}

async function renderDir(dir, parent, depth, repo) {
  const r = await window.api.fs.list(dir);
  if (!r.ok) {
    parent.append(h('div', { class: 'tree-err', text: r.error }));
    return;
  }
  const v = view();
  for (const e of r.data) {
    const open = e.dir && v.expanded.has(keyOf(e.path));
    const row = h(
      'div',
      { class: `ft-row ${e.dir ? 'dir' : 'file'} ${v.active && keyOf(v.active) === keyOf(e.path) ? 'active' : ''}`, 'data-path': e.path, style: { paddingLeft: `${8 + depth * 14}px` }, title: e.path },
      h('span', { class: 'ft-caret', text: e.dir ? (open ? '▾' : '▸') : '' }),
      h('span', { class: `ft-ico ${e.dir ? 'folder' : fileIcon(e.name)}`, text: e.dir ? (open ? '📂' : '📁') : '' }),
      h('span', { class: 'ft-name', text: e.name }),
      h('span', { class: 'ft-badge' })
    );
    parent.append(row);
    if (e.dir) {
      const kids = h('div', { class: 'ft-kids', hidden: !open });
      parent.append(kids);
      if (open) await renderDir(e.path, kids, depth + 1, repo);
      row.onclick = async () => {
        const k = keyOf(e.path);
        if (v.expanded.has(k)) {
          v.expanded.delete(k);
          kids.hidden = true;
          row.querySelector('.ft-caret').textContent = '▸';
          row.querySelector('.ft-ico').textContent = '📁';
        } else {
          v.expanded.add(k);
          kids.hidden = false;
          row.querySelector('.ft-caret').textContent = '▾';
          row.querySelector('.ft-ico').textContent = '📂';
          if (!kids.childElementCount) {
            await renderDir(e.path, kids, depth + 1, repo);
            decorateTree();
          }
        }
      };
    } else {
      row.onclick = () => openFile(e.path);
    }
    row.oncontextmenu = (ev) => {
      ev.preventDefault();
      contextMenu(ev.clientX, ev.clientY, treeMenu(e));
    };
  }
}

function fileIcon(name) {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return `ext-${ext || 'none'}`;
}

// 탐색기에 Git 상태(수정/새 파일 등) 색칠
function decorateTree() {
  const files = state.status?.files || [];
  const repo = state.repo;
  const byRel = new Map(files.map((f) => [f.path.toLowerCase(), f.status]));
  const dirs = new Set();
  for (const f of files) {
    const parts = f.path.toLowerCase().split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const LETTER = { modified: 'M', added: 'A', untracked: 'U', deleted: 'D', renamed: 'R', conflict: '!' };
  document.querySelectorAll('#codeTree .ft-row').forEach((row) => {
    const rel = relOf(repo, row.dataset.path).toLowerCase();
    const st = byRel.get(rel);
    row.classList.remove('g-modified', 'g-added', 'g-untracked', 'g-conflict', 'g-renamed', 'g-dirchange');
    const badge = row.querySelector('.ft-badge');
    badge.textContent = '';
    if (st) {
      row.classList.add(`g-${st}`);
      badge.textContent = LETTER[st] || '';
    } else if (row.classList.contains('dir') && dirs.has(rel)) {
      row.classList.add('g-dirchange');
      badge.textContent = '•';
    }
  });
}

function treeMenu(e) {
  const parentDir = e.dir ? e.path : e.path.slice(0, e.path.length - e.name.length - 1);
  return [
    { header: e.name },
    e.dir ? null : { label: '열기', onClick: () => openFile(e.path) },
    { label: '새 파일...', onClick: () => createIn(parentDir, 'file') },
    { label: '새 폴더...', onClick: () => createIn(parentDir, 'folder') },
    '-',
    { label: '이름 변경...', onClick: () => renameEntry(e) },
    { label: '삭제 (휴지통으로)', danger: true, onClick: () => deleteEntry(e) },
    '-',
    { label: '경로 복사', onClick: () => window.api.copy(e.path) },
    { label: '상대 경로 복사', onClick: () => window.api.copy(relOf(state.repo, e.path)) },
    { label: '탐색기에서 보기', onClick: () => window.api.showItem(e.path) },
    e.dir ? null : { label: '기본 프로그램으로 열기', onClick: () => window.api.openPath(e.path) },
  ];
}

async function createIn(dir, kind) {
  const name = await promptDialog(`${relOf(state.repo, dir) || '(최상위)'} 에 만들 ${kind === 'file' ? '파일' : '폴더'} 이름`, { title: kind === 'file' ? '새 파일' : '새 폴더', placeholder: kind === 'file' ? '예: src/utils/date.ts' : '예: components' });
  if (!name) return;
  const target = await window.api.joinPath(dir, name);
  const r = await window.api.fs[kind === 'file' ? 'createFile' : 'createFolder'](target);
  if (!r.ok) return toast(r.error, 'error');
  // 새로 만든 위치가 보이도록 상위 폴더 펼치기
  let p = target;
  while (p.length > state.repo.length) {
    p = p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')));
    if (p.length > state.repo.length) view().expanded.add(keyOf(p));
  }
  if (kind === 'folder') view().expanded.add(keyOf(target));
  await renderTree();
  if (kind === 'file') openFile(target);
  refresh();
}

async function renameEntry(e) {
  const name = await promptDialog('새 이름', { title: '이름 변경', value: e.name });
  if (!name || name === e.name) return;
  const target = e.path.slice(0, e.path.length - e.name.length) + name;
  const open = [...docs.values()].filter((d) => keyOf(d.path) === keyOf(e.path) || keyOf(d.path).startsWith(keyOf(e.path) + '\\'));
  if (open.some(isDirty)) return toast('저장하지 않은 파일이 있습니다. 먼저 저장하세요.', 'warn');
  const r = await window.api.fs.rename(e.path, target);
  if (!r.ok) return toast(r.error, 'error');
  for (const d of open) closeDoc(d, { force: true });
  await renderTree();
  if (!e.dir) openFile(target);
  refresh();
}

async function deleteEntry(e) {
  if (!(await confirmDialog(`'${relOf(state.repo, e.path)}' 을(를) 휴지통으로 옮깁니다.`, { title: '삭제', okLabel: '삭제', danger: true }))) return;
  const r = await window.api.fs.trash(e.path);
  if (!r.ok) return toast(r.error, 'error');
  for (const d of [...docs.values()]) if (keyOf(d.path) === keyOf(e.path) || keyOf(d.path).startsWith(keyOf(e.path) + '\\')) closeDoc(d, { force: true });
  await renderTree();
  refresh();
}

// ---------- 파일 열기 / 탭 ----------

async function ensureDoc(path) {
  const k = keyOf(path);
  if (docs.has(k)) return docs.get(k);
  const r = await window.api.fs.read(path);
  if (!r.ok) {
    toast(`파일을 열 수 없습니다: ${r.error}`, 'error');
    return null;
  }
  if (r.data.binary || r.data.tooLarge) {
    toast(r.data.binary ? '바이너리 파일은 편집기로 열 수 없습니다.' : '5MB 가 넘는 파일은 편집기로 열 수 없습니다.', 'warn');
    return null;
  }
  if (docs.has(k)) return docs.get(k); // 읽는 사이 다른 곳에서 열림
  const repo = state.repo;
  const model = monaco.editor.createModel(r.data.text, undefined, monaco.Uri.file(path));
  model.setEOL(r.data.eol === 'CRLF' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
  const doc = { path, repo, model, savedVersion: model.getAlternativeVersionId(), mtime: r.data.mtime, bom: r.data.bom, eol: r.data.eol, headText: undefined, deco: [] };
  docs.set(k, doc);
  let t;
  model.onDidChangeContent(() => {
    renderTabs();
    clearTimeout(t);
    t = setTimeout(() => updateGutter(doc), 250);
  });
  lsp.attachModel(repo, model).catch((e) => console.warn('언어 서버 연결 실패', e));
  loadHead(doc);
  return doc;
}

export async function openFile(path, selection) {
  if (!monaco) await activateCode();
  const doc = await ensureDoc(path);
  if (!doc) return;
  const v = view();
  if (!v.tabs.some((p) => keyOf(p) === keyOf(path))) v.tabs.push(doc.path);
  activate(doc.path);
  if (selection) {
    const range = selection.startLineNumber ? selection : { startLineNumber: selection.lineNumber, startColumn: selection.column, endLineNumber: selection.lineNumber, endColumn: selection.column };
    editor.setSelection(range);
    editor.revealRangeInCenterIfOutsideViewport(range);
  }
  editor.focus();
}

function activate(path) {
  const v = view();
  const prev = docs.get(keyOf(v.active || ''));
  if (prev && prev.model === editor.getModel()) prev.viewState = editor.saveViewState();
  const doc = docs.get(keyOf(path));
  if (!doc) return showEmpty();
  v.active = doc.path;
  $('#codeEmpty').hidden = true;
  $('#codeEditor').style.visibility = 'visible';
  editor.setModel(doc.model);
  if (doc.viewState) editor.restoreViewState(doc.viewState);
  updateGutter(doc);
  renderTabs();
  updateStatus();
  document.querySelectorAll('#codeTree .ft-row').forEach((r) => r.classList.toggle('active', keyOf(r.dataset.path) === keyOf(doc.path)));
}

function showEmpty() {
  view().active = null;
  editor?.setModel(null);
  $('#codeEditor').style.visibility = 'hidden';
  $('#codeEmpty').hidden = false;
  renderTabs();
  updateStatus();
}

const isDirty = (d) => d.model.getAlternativeVersionId() !== d.savedVersion;
const activeDoc = () => docs.get(keyOf(view().active || ''));

function renderTabs() {
  const bar = $('#codeTabs');
  if (!bar) return;
  const v = view();
  bar.innerHTML = '';
  for (const p of v.tabs) {
    const d = docs.get(keyOf(p));
    if (!d) continue;
    const markers = monaco ? monaco.editor.getModelMarkers({ resource: d.model.uri, owner: 'lsp' }) : [];
    const errors = markers.filter((m) => m.severity === monaco.MarkerSeverity.Error).length;
    const tab = h(
      'div',
      { class: `ctab ${keyOf(p) === keyOf(v.active || '') ? 'active' : ''} ${errors ? 'has-error' : ''} ${d.deleted ? 'deleted' : ''}`, title: `${p}${d.deleted ? '\n(디스크에서 삭제됨)' : ''}` },
      h('span', { class: `ft-ico ${fileIcon(baseName(p))}` }),
      h('span', { class: 'ctab-name', text: baseName(p) }),
      errors ? h('span', { class: 'ctab-err', text: errors }) : null,
      h('button', { class: `ctab-x ${isDirty(d) ? 'dirty' : ''}`, title: isDirty(d) ? '저장 안 됨 (닫기)' : '닫기 (Ctrl+W)', text: isDirty(d) ? '●' : '✕', onclick: (e) => (e.stopPropagation(), closeTab(p)) })
    );
    tab.onclick = () => activate(p);
    tab.onauxclick = (e) => e.button === 1 && closeTab(p);
    tab.oncontextmenu = (e) => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: '닫기', onClick: () => closeTab(p) },
        { label: '다른 탭 모두 닫기', onClick: () => v.tabs.filter((x) => x !== p).forEach((x) => closeTab(x)) },
        { label: '모두 닫기', onClick: () => [...v.tabs].forEach((x) => closeTab(x)) },
        '-',
        { label: '탐색기에서 위치 보기', onClick: () => revealInTree(p) },
        { label: '경로 복사', onClick: () => window.api.copy(p) },
      ]);
    };
    bar.append(tab);
  }
}

export async function closeTab(path) {
  const d = docs.get(keyOf(path));
  if (d && isDirty(d)) {
    const v = await choiceDialog(`'${baseName(path)}' 의 변경 내용을 저장할까요?`, [
      { label: '저장 안 함', value: 'discard', danger: true },
      { label: '저장', value: 'save', primary: true },
    ], { title: '저장하지 않은 변경' });
    if (!v) return false;
    if (v === 'save' && !(await saveDoc(d))) return false;
  }
  if (d) closeDoc(d, { force: true });
  return true;
}

function closeDoc(d, { force } = {}) {
  if (!force && isDirty(d)) return;
  for (const v of repoViews.values()) {
    const i = v.tabs.findIndex((p) => keyOf(p) === keyOf(d.path));
    if (i < 0) continue;
    v.tabs.splice(i, 1);
    if (v.active && keyOf(v.active) === keyOf(d.path)) v.active = v.tabs[Math.min(i, v.tabs.length - 1)] || null;
  }
  lsp.detachModel(d.model);
  docs.delete(keyOf(d.path));
  if (editor.getModel() === d.model) editor.setModel(null);
  d.model.dispose();
  const v = view();
  if (v.active) activate(v.active);
  else showEmpty();
}

export function closeActiveTab() {
  const v = view();
  if (v.active) closeTab(v.active);
}

function revealInTree(p) {
  let dir = p;
  while (dir.length > state.repo.length) {
    dir = dir.slice(0, Math.max(dir.lastIndexOf('\\'), dir.lastIndexOf('/')));
    if (dir.length > state.repo.length) view().expanded.add(keyOf(dir));
  }
  renderTree().then(() => document.querySelector(`#codeTree .ft-row.active`)?.scrollIntoView({ block: 'center' }));
}

// ---------- 저장 / 디스크 변경 감지 ----------

async function saveDoc(d) {
  const text = d.model.getValue();
  const version = d.model.getAlternativeVersionId();
  const r = await window.api.fs.write(d.path, text, { bom: d.bom });
  if (!r.ok) {
    toast(`저장 실패: ${r.error}`, 'error');
    return false;
  }
  d.savedVersion = version;
  d.mtime = r.data;
  d.deleted = false;
  lsp.notifySaved(d.model);
  renderTabs();
  updateStatus();
  scheduleRefresh();
  return true;
}

let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh(), 400);
}

async function checkDiskChanges() {
  for (const d of [...docs.values()]) {
    const r = await window.api.fs.stat(d.path);
    if (!r.ok) continue;
    if (!r.data.exists) {
      if (!d.deleted) {
        d.deleted = true;
        renderTabs();
      }
      continue;
    }
    d.deleted = false;
    if (Math.abs(r.data.mtime - d.mtime) < 1) {
      loadHead(d); // 커밋 등으로 HEAD 가 바뀌었을 수 있다
      continue;
    }
    if (isDirty(d)) {
      if (d.warnedMtime !== r.data.mtime) toast(`'${baseName(d.path)}' 이(가) 다른 곳에서 바뀌었습니다. 저장하면 덮어씁니다.`, 'warn', 6000);
      d.warnedMtime = r.data.mtime;
      continue;
    }
    const f = await window.api.fs.read(d.path);
    if (!f.ok || f.data.binary || f.data.tooLarge) continue;
    if (f.data.text !== d.model.getValue()) {
      // 실행 취소 기록을 남기며 내용 교체
      d.model.pushEditOperations([], [{ range: d.model.getFullModelRange(), text: f.data.text }], () => null);
    }
    d.savedVersion = d.model.getAlternativeVersionId();
    d.mtime = f.data.mtime;
    loadHead(d);
    renderTabs();
  }
}

// ---------- Git 변경 표시 (줄 번호 옆 색 막대) ----------

async function loadHead(d) {
  const rel = relOf(d.repo, d.path);
  const text = await git('headContent', rel).catch(() => null);
  d.headText = text;
  updateGutter(d);
}

function updateGutter(d) {
  if (!monaco || d.headText === undefined || d.model.isDisposed()) return;
  const base = (d.headText ?? '').replace(/\r\n/g, '\n');
  const cur = d.model.getValue().replace(/\r\n/g, '\n');
  const decos = [];
  if (d.headText === null) {
    // 새 파일(아직 커밋 안 됨): 전체 추가
    decos.push({ range: new monaco.Range(1, 1, d.model.getLineCount(), 1), options: { isWholeLine: true, linesDecorationsClassName: 'gut-add' } });
  } else if (base !== cur) {
    const chunks = window.Diff.diffLines(base, cur);
    let line = 1;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const n = c.count || 0;
      if (c.removed) {
        const next = chunks[i + 1];
        if (next?.added) {
          const m = next.count || 0;
          decos.push({ range: new monaco.Range(line, 1, line + m - 1, 1), options: { isWholeLine: true, linesDecorationsClassName: 'gut-mod' } });
          line += m;
          i++;
        } else {
          const at = Math.max(1, Math.min(line, d.model.getLineCount()));
          decos.push({ range: new monaco.Range(at, 1, at, 1), options: { linesDecorationsClassName: line > d.model.getLineCount() ? 'gut-del-bottom' : 'gut-del' } });
        }
      } else if (c.added) {
        decos.push({ range: new monaco.Range(line, 1, line + n - 1, 1), options: { isWholeLine: true, linesDecorationsClassName: 'gut-add' } });
        line += n;
      } else line += n;
    }
  }
  d.deco = d.model.deltaDecorations(d.deco, decos);
}

// ---------- 아래 상태 표시줄 ----------

function updateStatus() {
  const el = $('#codeStatus');
  if (!el) return;
  const d = activeDoc();
  if (!d || !editor) {
    el.innerHTML = '';
    return;
  }
  const p = editor.getPosition();
  const markers = monaco.editor.getModelMarkers({ resource: d.model.uri, owner: 'lsp' });
  const errs = markers.filter((m) => m.severity === monaco.MarkerSeverity.Error).length;
  const warns = markers.filter((m) => m.severity === monaco.MarkerSeverity.Warning).length;
  const lang = d.model.getLanguageId();
  const info = lsp.serverLangFor(d.model) ? lsp.serverInfo(d.repo) : null;
  const ls = !lsp.serverLangFor(d.model)
    ? ''
    : !info || info.status === 'starting'
      ? '<span class="cs-item"><span class="spinner"></span> 언어 서버 시작 중</span>'
      : info.status === 'error'
        ? '<span class="cs-item err">언어 서버 오류</span>'
        : `<span class="cs-item" title="${info.tsdk?.source === 'project' ? '프로젝트의 TypeScript 사용' : '앱에 포함된 TypeScript 사용'}">TS ${info.ts?.version || ''} (${info.tsdk?.source === 'project' ? '프로젝트' : '내장'})</span>`;
  el.innerHTML = '';
  const problems = h('span', { class: `cs-item cs-problems ${errs ? 'err' : ''}`, title: '다음 문제로 이동 (F8)', html: `⊗ ${errs}  ⚠ ${warns}` });
  problems.onclick = () => {
    editor.focus();
    editor.trigger('status', 'editor.action.marker.next', null);
  };
  el.append(
    problems,
    h('span', { class: 'cs-item', text: relOf(d.repo, d.path) }),
    h('span', { class: 'tb-spacer' }),
    h('span', { html: ls }),
    h('span', { class: 'cs-item', text: p ? `줄 ${p.lineNumber}, 열 ${p.column}` : '' }),
    h('span', { class: 'cs-item', text: lang }),
    h('span', { class: 'cs-item', text: `UTF-8${d.bom ? ' BOM' : ''}` }),
    h('span', { class: 'cs-item', text: d.eol })
  );
  // 언어 서버 준비 상태가 바뀌면 다시 그린다
  if (info?.status === 'starting' || (lsp.serverLangFor(d.model) && !info)) setTimeout(updateStatus, 800);
}
