// 코드 화면: 파일 탐색기 + 파일 탭 + Monaco 편집기(VS Code 편집기) + 언어 서버 오류 표시 + Git 변경 표시
import { $, h, modal, contextMenu, confirmDialog, promptDialog, choiceDialog, toast, splitter } from './ui.js';
import { state, git, onRefresh, refresh, busy } from './state.js';
import * as lsp from './lsp-client.js';
import { initTerminal, showTerminalsFor, toggleTerminal, isTerminalVisible } from './terminal.js';

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
      <div class="code-notice" id="codeNotice" hidden></div>
      <div class="code-editor-wrap">
        <div class="code-editor" id="codeEditor"></div>
        <div class="code-empty" id="codeEmpty"><div><b>파일을 선택하세요</b><br><small>왼쪽 탐색기에서 파일을 열면 VS Code 와 같은 편집기로 수정할 수 있습니다.<br>Ctrl+S 저장 · Ctrl+F 찾기 · Ctrl+H 바꾸기 · F12 정의로 이동 · Shift+Alt+F 서식 정리</small></div></div>
      </div>
      <div class="splitter-y" id="termSplit" hidden></div>
      <div class="term-panel" id="termPanel" hidden></div>
      <div class="code-status" id="codeStatus"></div>
    </div>`;
  emptyHtml = $('#codeEmpty').innerHTML;
  initTerminal($('#termPanel'), $('#termSplit'));
  window.addEventListener('terminal-visibility', () => updateStatus());
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

  refreshJavaPack();
  lsp.onServerStatus(() => updateStatus());
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
  showTerminalsFor();
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
  if (path.startsWith('jdt:')) {
    const model = monaco.editor.getModel(monaco.Uri.parse(path));
    if (!model) return null;
    const doc = { path, repo: state.repo, model, virtual: true, savedVersion: model.getAlternativeVersionId(), eol: 'LF', deco: [], headText: undefined };
    docs.set(k, doc);
    return doc;
  }
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
  if (model.getLanguageId() === 'python') await ensurePython(repo);
  if (model.getLanguageId() === 'java') await prepareJava(repo);
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
  showLanguageNotice(doc);
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
  editor.updateOptions({ readOnly: !!doc.virtual });
  if (doc.viewState) editor.restoreViewState(doc.viewState);
  updateGutter(doc);
  showLanguageNotice(doc);
  renderTabs();
  updateStatus();
  document.querySelectorAll('#codeTree .ft-row').forEach((r) => r.classList.toggle('active', keyOf(r.dataset.path) === keyOf(doc.path)));
}

function showEmpty() {
  view().active = null;
  if ($('#codeNotice')) $('#codeNotice').hidden = true;
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
      h('span', { class: 'ctab-name', text: d.virtual ? virtualName(p) : baseName(p) }),
      d.virtual ? h('span', { class: 'ctab-ro', text: '읽기 전용', title: '라이브러리/JDK 클래스 (수정할 수 없음)' }) : null,
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

export function toggleTerminalPanel() {
  toggleTerminal();
  updateStatus();
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
  if (d.virtual) return true;
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
    if (d.virtual) continue;
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
  if (d.virtual) return;
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
  const termBtn = h('span', { class: `cs-item cs-btn ${isTerminalVisible() ? 'on' : ''}`, title: '터미널 열기/닫기 (Ctrl+`)', text: '⌨ 터미널' });
  termBtn.onclick = () => {
    toggleTerminal();
    updateStatus();
  };
  if (!d || !editor) {
    el.innerHTML = '';
    el.append(h('span', { class: 'tb-spacer' }), termBtn);
    return;
  }
  const p = editor.getPosition();
  const markers = monaco.editor.getModelMarkers({ resource: d.model.uri, owner: 'lsp' });
  const errs = markers.filter((m) => m.severity === monaco.MarkerSeverity.Error).length;
  const warns = markers.filter((m) => m.severity === monaco.MarkerSeverity.Warning).length;
  const lang = d.model.getLanguageId();
  const info = lsp.serverLangFor(d.model) ? lsp.serverInfo(d.repo, lsp.serverLangFor(d.model)) : null;
  const lsLang = lsp.serverLangFor(d.model);
  const ls = !lsLang
    ? lang === 'java'
      ? '<span class="cs-item warn" title="Java 언어 팩을 설치하면 오류 표시·자동 완성·어노테이션 확인이 됩니다">Java · 언어 팩 필요</span>'
      : ''
    : lsLang === 'java'
      ? ''
    : lsLang === 'python'
      ? !info || info.status === 'starting'
        ? '<span class="cs-item"><span class="spinner"></span> Python 언어 서버 시작 중</span>'
        : ''
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
    ...[
    problems,
    h('span', { class: 'cs-item', text: relOf(d.repo, d.path) }),
    h('span', { class: 'tb-spacer' }),
    h('span', { html: ls }),
    lang === 'python' ? pythonStatusItem(d.repo) : null,
    lsLang === 'java' ? javaStatusItem(d.repo, info) : null,
    h('span', { class: 'cs-item', text: p ? `줄 ${p.lineNumber}, 열 ${p.column}` : '' }),
    h('span', { class: 'cs-item', text: lang }),
    h('span', { class: 'cs-item', text: `UTF-8${d.bom ? ' BOM' : ''}` }),
    h('span', { class: 'cs-item', text: d.eol }),
    termBtn,
    ].filter(Boolean)
  );
  // 언어 서버 준비 상태가 바뀌면 다시 그린다
  if (info?.status === 'starting' || (lsp.serverLangFor(d.model) && !info)) setTimeout(updateStatus, 800);
}

// ---------- Python 인터프리터 (Java 의 JDK 에 해당: 쓸 수 있는 문법과 설치된 패키지가 달라진다) ----------

const pyCache = new Map(); // 저장소 → 찾은 인터프리터 목록
const pyKey = (repo) => `py.interp:${repo.toLowerCase()}`;

async function pythonList(repo, force) {
  if (!force && pyCache.has(repo)) return pyCache.get(repo);
  const list = await window.api.pythonInterpreters(repo);
  pyCache.set(repo, list);
  return list;
}

function currentPython(repo) {
  try {
    return JSON.parse(localStorage.getItem(pyKey(repo)) || 'null');
  } catch {
    return null;
  }
}

// 처음이면 프로젝트 가상환경(.venv 등) → 시스템 Python 순서로 자동 선택
async function ensurePython(repo) {
  let cur = currentPython(repo);
  const list = await pythonList(repo);
  if (cur && !list.some((x) => x.path.toLowerCase() === cur.path.toLowerCase())) cur = null;
  if (!cur && list.length) {
    cur = list[0];
    localStorage.setItem(pyKey(repo), JSON.stringify(cur));
  }
  lsp.setPythonPath(repo, cur?.path || null);
  return cur;
}

function pythonStatusItem(repo) {
  const cur = currentPython(repo);
  const el = h('span', {
    class: `cs-item cs-btn ${cur ? '' : 'warn'}`,
    title: cur ? `${cur.path}\n클릭해서 다른 Python 선택` : 'Python 을 찾지 못했습니다. 설치된 패키지(import)를 인식하지 못할 수 있습니다.',
    text: cur ? `🐍 Python ${cur.version}${cur.source.startsWith('가상환경') ? ` (${cur.source.replace(/^가상환경 \((.*)\)$/, '$1')})` : ''}` : '🐍 Python 없음',
  });
  el.onclick = async () => {
    const list = await pythonList(repo, true);
    const items = list.map((x) => ({
      label: `${cur && cur.path.toLowerCase() === x.path.toLowerCase() ? '✓ ' : '　'}Python ${x.version} · ${x.source}`,
      hint: x.path,
      onClick: () => {
        localStorage.setItem(pyKey(repo), JSON.stringify(x));
        lsp.setPythonPath(repo, x.path);
        updateStatus();
        toast(`Python ${x.version} (${x.source}) 을(를) 사용합니다.`, 'ok');
      },
    }));
    const r = el.getBoundingClientRect();
    contextMenu(r.left, r.top - 8 - (items.length + 2) * 28, [{ header: 'Python 인터프리터 선택' }, ...(items.length ? items : [{ label: '설치된 Python 을 찾지 못했습니다', disabled: true }]), '-', { label: '다시 찾기', onClick: () => pythonList(repo, true).then(updateStatus) }]);
  };
  return el;
}

// ---------- Java 언어 팩 ----------

let javaPack = null; // 설치 상태 (window.api.java.status)
const effectiveCache = new Map(); // 파일+기준JDK → 언어 서버가 실제 적용한 { level, jdk }
const effectivePending = new Set();
let javaInstalling = null;

async function refreshJavaPack() {
  javaPack = await window.api.java.status();
  lsp.setJavaEnabled(javaPack.installed);
  return javaPack;
}

// jdt://contents/rt.jar/java.util/List.java?... → List.java (소스가 없으면 List.class)
const virtualName = (uri) => {
  const m = decodeURIComponent(uri.split('?')[0]).match(/([^/]+?\.(?:java|class))$/);
  return m ? m[1] : 'class';
};

// Java 파일을 열기 전: 예전 버전에서 고른 기준 JDK 가 있으면 넘긴다 (서버 쪽에서 .codeflow/java.json 으로 옮김)
async function prepareJava(repo) {
  if (!javaPack) await refreshJavaPack();
  lsp.setPreferredJdk(repo, localStorage.getItem(`java.jdk:${repo.toLowerCase()}`) || null);
}

// 프로젝트 탭을 열거나 골랐을 때: Java 프로젝트면 Java 언어 서버를 미리 켠다 (언어 팩이 설치된 경우만)
const javaProjects = new Map(); // 저장소 → Java 프로젝트 여부
export async function onRepoActivated(repo) {
  lsp.setActiveRepo(repo);
  if (!repo) return;
  if (!javaPack) await refreshJavaPack().catch(() => null);
  if (!javaPack?.installed) return;
  const key = repo.toLowerCase();
  if (!javaProjects.has(key)) javaProjects.set(key, await window.api.java.isProject(repo).catch(() => false));
  if (!javaProjects.get(key) || state.repo?.toLowerCase() !== key) return;
  await prepareJava(repo);
  lsp.warmJava(repo);
}

// 설치 진행 상황 (어느 Java 파일을 보든, 설정 화면이든 같은 값을 보여 준다)
let javaProgress = null;
let progressHooked = false;
const progressText = (p) => (p ? `${p.message}${p.percent >= 0 && p.step === 'download' ? ` (${p.percent}%)` : ''}` : 'Java 언어 팩 설치 준비 중...');

// 설정 화면에서도 쓰는 설치 함수 (이미 설치 중이면 같은 설치를 기다린다)
export async function installJavaPack(onProgress) {
  if (!progressHooked) {
    progressHooked = true;
    window.api.java.onProgress((p) => {
      javaProgress = p;
      window.dispatchEvent(new CustomEvent('java-progress', { detail: p }));
    });
  }
  if (!javaInstalling) {
    javaProgress = null;
    const done = busy('Java 언어 팩 설치'); // 툴바에 'Java 언어 팩 설치 중... N초'
    javaInstalling = (async () => {
      try {
        const r = await window.api.java.install();
        if (!r.ok) throw new Error(r.error);
        await refreshJavaPack();
        // 이미 열어 둔 Java 파일들을 언어 서버에 연결
        for (const d of docs.values()) if (!d.virtual && d.model.getLanguageId() === 'java') prepareJava(d.repo).then(() => lsp.attachModel(d.repo, d.model).catch(() => {}));
        toast('Java 언어 팩을 설치했습니다. 열린 Java 파일을 검사합니다.', 'ok', 5000);
        if (state.repo) onRepoActivated(state.repo);
        return r.data;
      } finally {
        done();
        javaInstalling = null;
        javaProgress = null;
        // 보고 있는 파일의 안내 띠를 상태에 맞게 다시 그린다
        const d = activeDoc();
        if (d) showLanguageNotice(d);
        updateStatus();
      }
    })();
  }
  onProgress?.(javaProgress);
  const handler = (e) => onProgress?.(e.detail);
  window.addEventListener('java-progress', handler);
  try {
    return await javaInstalling;
  } finally {
    window.removeEventListener('java-progress', handler);
  }
}

export async function removeJavaPack() {
  for (const repo of new Set([...docs.values()].map((d) => d.repo))) await lsp.restartServer(repo, 'java', []);
  const r = await window.api.java.remove();
  await refreshJavaPack();
  return r;
}

// 이 프로젝트에 직접 고른 JDK (.codeflow/java.json 에 저장, 언어 서버가 알려 준 값)
const pickedJdk = (info) => info?.java?.project?.config?.jdk || null;

function javaStatusItem(repo, info) {
  if (!info || info.status === 'starting') return h('span', { class: 'cs-item', html: '<span class="spinner"></span> Java 프로젝트 분석 · 언어 서버 시작 중' });
  if (info.status === 'error') return h('span', { class: 'cs-item err', text: 'Java 언어 서버 오류', title: info.error || '' });
  if (info.javaState && !info.javaState.ready)
    return h('span', { class: `cs-item ${info.javaState.error ? 'err' : ''}`, html: `${info.javaState.error ? '' : '<span class="spinner"></span> '}${info.javaState.message}`, title: '처음 여는 프로젝트는 라이브러리 색인 때문에 시간이 걸립니다. 두 번째부터는 빨라집니다.' });
  const proj = info.java?.project || {};
  const managed = ['Maven', 'Gradle'].includes(proj.build);
  const level = proj.level ? (proj.level.startsWith('1.') ? proj.level : proj.level.replace(/^(\d+).*/, '$1')) : null;
  const picked = pickedJdk(info);
  const runtimes = info.java?.runtimes || [];
  const def = runtimes.find((r) => r.default);
  const rt = managed ? runtimes.find((r) => r.name === (level ? `JavaSE-${level}` : '')) : def;
  const missing = managed && level && !rt;
  const auto = !managed && !picked && !level; // 버전 정보가 없어 가장 최신 JDK 로 자동 선택
  const tail = `${managed && proj.file ? ` (${proj.file})` : ''}${picked ? ' · 직접 선택' : auto ? ' · 자동' : ''}`;
  const libs = managed ? '' : `\n라이브러리 jar ${proj.libraries?.length || 0}개 · 소스 폴더 ${(proj.sourcePaths || []).join(', ') || '-'}`;
  const el = h('span', {
    class: `cs-item cs-btn ${missing ? 'warn' : ''}`,
    // 빌드 파일이 없는 프로젝트는 고른(또는 자동으로 정한) JDK 의 버전을 보여 준다
    text: `☕ Java ${(managed ? level : null) || (def ? def.name.replace(/^JavaSE-/, '') : level || '?')}${tail}`,
    title: missing
      ? `프로젝트는 Java ${level} 기준인데 해당 JDK 가 PC 에 없습니다. 설치된 다른 JDK 로 검사합니다.`
      : `검사 기준 JDK: ${rt ? rt.path : '언어 서버 기본 JDK'}${libs}\n클릭해서 JDK 선택 / 프로젝트 구조`,
  });
  el.onclick = () => openJdkPicker(el, repo, info, level, proj);
  // 언어 서버가 실제로 적용한 Java 버전/JDK 로 표시를 바로잡는다 (추측이 아닌 실제 값)
  const d = activeDoc();
  if (d && info.javaState?.ready) {
    const key = `${d.path}|${def?.path || ''}`;
    const show = (eff) => {
      if (!eff?.level) return;
      if (managed) el.textContent = `☕ Java ${eff.level}${tail}`;
      // Java 1.7 이하 JDK: 함수·클래스는 그 JDK 기준이지만, 문법 검사는 엔진(Eclipse)이 1.7 이하를 지원하지 않아 더 높은 버전 기준
      const old = /^JavaSE-1\.[0-7]$|^J2SE/.test(def?.name || '');
      el.title = `${old ? `사용 가능한 클래스·함수: ${def.name.replace(/^JavaSE-/, 'Java ')} JDK 기준\n문법 검사: Java ${eff.level} 기준 (검사 엔진이 1.7 이하 문법 검사를 지원하지 않음)` : `실제 검사 기준: Java ${eff.level}`}\nJDK: ${eff.jdk || '-'}${libs}\n클릭해서 JDK 선택 / 프로젝트 구조`;
      el.classList.toggle('warn', managed && !!level && eff.level !== level);
    };
    if (effectiveCache.has(key)) show(effectiveCache.get(key));
    else if (!effectivePending.has(key)) {
      effectivePending.add(key);
      lsp.javaEffectiveSettings(d.model).then((eff) => {
        effectivePending.delete(key);
        if (!eff) return;
        effectiveCache.set(key, eff);
        updateStatus(); // 실제 값으로 다시 그림
      });
    }
  }
  return el;
}

// 언어 서버가 JDK 를 다시 적용했으면 표시도 새로 확인
lsp.onJavaJdkFixed(() => {
  effectiveCache.clear();
  setTimeout(updateStatus, 3000);
});

// 프로젝트 설정(JDK, jar, 소스 폴더)이 바뀌면 실행 중인 Java 언어 서버에 새 설정만 보낸다 (다시 시작하지 않음, 1~2초)
async function restartJava(repo, message) {
  localStorage.removeItem(`java.jdk:${repo.toLowerCase()}`); // 예전 버전의 저장 위치 (이제 .codeflow/java.json)
  lsp.setPreferredJdk(repo, null);
  effectiveCache.clear();
  if (await lsp.updateJavaProject(repo)) {
    toast(message, 'ok', 4000);
    updateStatus();
    setTimeout(updateStatus, 6000); // 실제 적용된 JDK 다시 확인
    return;
  }
  // 서버가 아직 시작 중이거나 꺼져 있으면 다시 시작해서 새 설정으로 연다
  const models = [...docs.values()].filter((d) => d.repo === repo && !d.virtual && d.model.getLanguageId() === 'java').map((d) => d.model);
  await lsp.restartServer(repo, 'java', models);
  updateStatus();
}

async function saveJavaConfig(repo, patch) {
  const r = await window.api.java.saveConfig(repo, patch);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

async function pickJdkFolder() {
  const dir = await window.api.pickFolder('JDK 설치 폴더 선택 (예: C:\\Program Files\\Java\\jdk-1.8)');
  if (!dir) return null;
  const r = await window.api.java.addJdk(dir);
  if (!r.ok) {
    toast(r.error, 'error', 6000);
    return null;
  }
  toast(`JDK ${r.data.version} 을(를) 추가했습니다.`, 'ok');
  return r.data.home;
}

async function openJdkPicker(anchor, repo, info, level, proj) {
  await refreshJavaPack();
  const picked = pickedJdk(info);
  const managed = ['Maven', 'Gradle'].includes(proj.build);
  const choose = async (home) => {
    try {
      await saveJavaConfig(repo, { jdk: home });
    } catch (e) {
      return toast(e.message, 'error', 6000);
    }
    await restartJava(repo, '기준 JDK 를 바꿨습니다. 잠시 뒤 새 JDK 기준으로 다시 검사합니다.');
  };
  const items = [
    { label: '🧱 프로젝트 구조 (JDK · 소스 폴더 · 라이브러리 jar)...', onClick: () => openProjectStructure(repo) },
    '-',
    { header: managed ? `${proj.build} 프로젝트: ${proj.file} 의 Java ${level || '?'} 버전을 따릅니다` : '프로젝트 기준 JDK' },
    { label: `${!picked ? '✓ ' : '　'}자동${level ? ` (Java ${level} 에 맞는 JDK)` : managed ? '' : ' (설치된 가장 최신 JDK)'}`, onClick: () => choose(null) },
    '-',
    ...javaPack.jdks.map((j) => ({
      label: `${picked && picked.toLowerCase() === j.home.toLowerCase() ? '✓ ' : '　'}${j.jdk ? 'JDK' : 'JRE'} ${j.version}`,
      hint: j.home,
      onClick: () => choose(j.home),
    })),
    javaPack.jdks.length ? null : { label: 'PC 에 설치된 JDK 를 찾지 못했습니다', disabled: true },
    '-',
    {
      label: '📁 폴더에서 JDK 선택...',
      onClick: async () => {
        const home = await pickJdkFolder();
        if (home) choose(home);
      },
    },
  ].filter(Boolean);
  const r = anchor.getBoundingClientRect();
  contextMenu(r.left, r.top - 8 - items.length * 28, items);
}

// ---------- Java 프로젝트 구조 (IntelliJ 의 Project Structure 와 같은 역할) ----------
// 프로젝트를 분석한 결과(소스 폴더, jar)를 보여 주고, JDK·소스 폴더·라이브러리를 바꿀 수 있다.
// 설정은 프로젝트 폴더의 .codeflow/java.json 에 저장된다 (Git 에는 올라가지 않음).

export async function openProjectStructure(repo) {
  const done = busy('Java 프로젝트 분석');
  let proj;
  try {
    await refreshJavaPack();
    proj = await window.api.java.project(repo);
  } finally {
    done();
  }
  const managed = ['Maven', 'Gradle'].includes(proj.build);
  const rel = (p) => {
    const a = p.replace(/\\/g, '/');
    const r = repo.replace(/\\/g, '/').replace(/\/$/, '') + '/';
    return a.toLowerCase().startsWith(r.toLowerCase()) ? a.slice(r.length) || '.' : a;
  };
  const cfg = proj.config || {};
  const st = {
    jdk: cfg.jdk || null,
    srcManual: !!cfg.sourcePaths?.length,
    src: [...(cfg.sourcePaths?.length ? cfg.sourcePaths : proj.detected?.sourcePaths || [])],
    libs: [],
    filter: '',
  };
  const excluded = (cfg.excludedLibraries || []).map((x) => x.toLowerCase());
  for (const l of proj.detected?.libraries || []) st.libs.push({ ref: l, on: !excluded.includes(l.toLowerCase()), added: false });
  for (const a of cfg.addedLibraries || []) if (!st.libs.some((x) => x.ref.toLowerCase() === a.toLowerCase())) st.libs.push({ ref: a, on: true, added: true });

  const body = h('div', { class: 'ps' });
  const section = (title, hint) => h('div', { class: 'ps-sec' }, h('div', { class: 'ps-title' }, title, hint ? h('span', { class: 'ps-hint', text: hint }) : ''));

  // JDK
  const jdkSel = h('select', { class: 'ps-select' });
  const fillJdks = () => {
    jdkSel.innerHTML = '';
    const autoLabel = proj.level ? `자동 (Java ${proj.level} 에 맞는 JDK)` : managed ? `자동 (${proj.file} 기준)` : '자동 (설치된 가장 최신 JDK)';
    jdkSel.append(h('option', { value: '', text: autoLabel }));
    for (const j of javaPack.jdks) jdkSel.append(h('option', { value: j.home, text: `${j.jdk ? 'JDK' : 'JRE'} ${j.version}  —  ${j.home}` }));
    if (st.jdk && !javaPack.jdks.some((j) => j.home.toLowerCase() === st.jdk.toLowerCase())) jdkSel.append(h('option', { value: st.jdk, text: `${st.jdk} (찾을 수 없음)` }));
    jdkSel.value = st.jdk ? javaPack.jdks.find((j) => j.home.toLowerCase() === st.jdk.toLowerCase())?.home || st.jdk : '';
  };
  fillJdks();
  jdkSel.onchange = () => (st.jdk = jdkSel.value || null);
  const jdkAdd = h('button', { class: 'tb-btn small', text: '📁 폴더에서 추가...' });
  jdkAdd.onclick = async () => {
    const home = await pickJdkFolder();
    if (!home) return;
    await refreshJavaPack();
    st.jdk = home;
    fillJdks();
  };
  const secJdk = section('JDK', managed ? `${proj.file} 의 Java 버전(${proj.level || '?'})을 따르고, 여기서 고르면 그 JDK 로 검사합니다` : '선택한 JDK 의 클래스·함수로 자동 완성과 오류 검사를 합니다');
  secJdk.append(h('div', { class: 'ps-row' }, jdkSel, jdkAdd));
  body.append(
    h('div', {
      class: 'ps-info',
      html: managed
        ? `<b>${proj.build} 프로젝트</b> · 라이브러리와 소스 폴더는 <code>${proj.file}</code> 이 관리합니다 (VS Code Java 와 같은 방식).`
        : `<b>빌드 파일(pom.xml · build.gradle)이 없는 프로젝트</b>를 분석했습니다${proj.detected?.build ? ` (${proj.detected.build} 설정도 반영)` : ''}. 설정은 <code>.codeflow/java.json</code> 에 저장되며 Git 에는 올라가지 않습니다.${proj.truncated ? '<br>⚠ 파일이 매우 많아 일부 폴더는 분석하지 못했습니다. 빠진 jar 는 직접 추가하세요.' : ''}`,
    }),
    secJdk
  );

  // 소스 폴더
  const srcList = h('div', { class: 'ps-list ps-list-short' });
  const srcHint = h('span', { class: 'ps-hint' });
  const drawSrc = () => {
    srcList.innerHTML = '';
    srcHint.textContent = st.srcManual ? '직접 지정함' : '자동으로 찾음 (.java 파일의 package 선언 기준)';
    if (!st.src.length) srcList.append(h('div', { class: 'ps-empty', text: '찾은 소스 폴더가 없습니다. 폴더 추가로 지정하세요.' }));
    st.src.forEach((s, i) => {
      const x = h('button', { class: 'ps-x', title: '빼기', text: '✕' });
      x.onclick = () => {
        st.src.splice(i, 1);
        st.srcManual = true;
        drawSrc();
      };
      srcList.append(h('div', { class: 'ps-item' }, h('span', { class: 'ps-ico', text: '📂' }), h('span', { class: 'ps-path', text: s }), x));
    });
  };
  const srcAdd = h('button', { class: 'tb-btn small', text: '+ 소스 폴더 추가...' });
  srcAdd.onclick = async () => {
    const dir = await window.api.pickFolder('소스 폴더 선택 (package 가 시작되는 폴더, 예: src 또는 JavaSource)');
    if (!dir) return;
    const r = rel(dir);
    if (!st.src.some((x) => x.toLowerCase() === r.toLowerCase())) st.src.push(r);
    st.srcManual = true;
    drawSrc();
  };
  const srcAuto = h('button', { class: 'tb-btn small', text: '자동으로 되돌리기' });
  srcAuto.onclick = () => {
    st.src = [...(proj.detected?.sourcePaths || [])];
    st.srcManual = false;
    drawSrc();
  };

  // 라이브러리
  const libList = h('div', { class: 'ps-list' });
  const libCount = h('span', { class: 'ps-hint' });
  const libFilter = h('input', { class: 'ps-filter', placeholder: 'jar 이름으로 찾기' });
  libFilter.oninput = () => {
    st.filter = libFilter.value.trim().toLowerCase();
    drawLibs();
  };
  const drawLibs = () => {
    libList.innerHTML = '';
    const on = st.libs.filter((l) => l.on).length;
    libCount.textContent = `사용 ${on}개 / 찾은 jar ${st.libs.filter((l) => !l.added).length}개 · 체크를 끄면 검사에서 뺍니다`;
    const shown = st.libs.filter((l) => !st.filter || l.ref.toLowerCase().includes(st.filter));
    if (!st.libs.length) libList.append(h('div', { class: 'ps-empty', text: '프로젝트 안에서 jar 를 찾지 못했습니다. Tomcat 의 servlet-api.jar 처럼 프로젝트 밖에 있는 jar 는 직접 추가하세요.' }));
    for (const l of shown.slice(0, 500)) {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = l.on;
      cb.onchange = () => {
        l.on = cb.checked;
        drawLibs();
      };
      const name = l.ref.split('/').pop();
      const dir = l.ref.slice(0, l.ref.length - name.length).replace(/\/$/, '') || '.';
      const row = h('label', { class: `ps-item ${l.on ? '' : 'off'}`, title: l.ref }, cb, h('span', { class: 'ps-ico', text: '☕' }), h('span', { class: 'ps-name', text: name }), h('span', { class: 'ps-dir', text: dir }));
      if (l.added) {
        const x = h('button', { class: 'ps-x', title: '목록에서 빼기', text: '✕' });
        x.onclick = (e) => {
          e.preventDefault();
          st.libs.splice(st.libs.indexOf(l), 1);
          drawLibs();
        };
        row.append(h('span', { class: 'ps-tag', text: '직접 추가' }), x);
      }
      libList.append(row);
    }
    if (shown.length > 500) libList.append(h('div', { class: 'ps-empty', text: `… ${shown.length - 500}개 더 있음 (이름으로 찾기)` }));
  };
  const addLibs = (files) => {
    let n = 0;
    for (const f of files) {
      const r = rel(f);
      const cur = st.libs.find((x) => x.ref.toLowerCase() === r.toLowerCase());
      if (cur) cur.on = true;
      else {
        st.libs.push({ ref: r, on: true, added: true });
        n++;
      }
    }
    drawLibs();
    if (files.length) toast(`jar ${n}개를 추가했습니다.`, 'ok');
  };
  const libAdd = h('button', { class: 'tb-btn small', text: '+ jar 추가...' });
  libAdd.onclick = async () => addLibs(await window.api.pickFiles('라이브러리 jar 선택', [{ name: 'Java 라이브러리', extensions: ['jar'] }], repo));
  const libAddDir = h('button', { class: 'tb-btn small', text: '+ 폴더의 jar 모두 추가...' });
  libAddDir.onclick = async () => {
    const dir = await window.api.pickFolder('jar 가 들어 있는 폴더 선택 (예: C:\\tomcat\\lib)');
    if (dir) addLibs(await window.api.java.jarsIn(dir));
  };

  if (!managed) {
    const secSrc = section('소스 폴더', '');
    secSrc.querySelector('.ps-title').append(srcHint);
    secSrc.append(srcList, h('div', { class: 'ps-row' }, srcAdd, srcAuto));
    const secLib = section('라이브러리 (jar)', '');
    secLib.querySelector('.ps-title').append(libCount);
    secLib.append(libFilter, libList, h('div', { class: 'ps-row' }, libAdd, libAddDir));
    body.append(secSrc, secLib);
    drawSrc();
    drawLibs();
  }

  modal({
    title: '🧱 Java 프로젝트 구조',
    body,
    wide: true,
    buttons: [
      ...(managed
        ? []
        : [
            {
              label: '다시 분석',
              onClick: () => {
                setTimeout(() => openProjectStructure(repo), 0);
                return null;
              },
            },
          ]),
      { label: '취소' },
      {
        label: '적용',
        primary: true,
        onClick: async () => {
          const patch = { jdk: st.jdk };
          if (!managed) {
            patch.sourcePaths = st.srcManual ? st.src : null;
            patch.addedLibraries = st.libs.filter((l) => l.added && l.on).map((l) => l.ref);
            patch.excludedLibraries = st.libs.filter((l) => !l.added && !l.on).map((l) => l.ref);
          }
          try {
            await saveJavaConfig(repo, patch);
          } catch (e) {
            toast(e.message, 'error', 6000);
            return false;
          }
          await restartJava(repo, '프로젝트 구조를 적용했습니다. 잠시 뒤 바뀐 구조로 다시 검사합니다.');
        },
      },
    ],
  });
}

// ---------- Java 파일을 열 때 안내 (언어 팩 미설치 시 설치 제안) ----------

const dismissedNotice = new Set();
let noticeProgressHandler = null;

function showLanguageNotice(doc) {
  const el = $('#codeNotice');
  if (!el) return;
  if (noticeProgressHandler) {
    window.removeEventListener('java-progress', noticeProgressHandler);
    noticeProgressHandler = null;
  }
  const lang = doc.model.getLanguageId();
  const key = `${doc.repo.toLowerCase()}|${lang}`;
  if (lang !== 'java' || doc.virtual || (javaPack?.installed && !javaInstalling) || (!javaInstalling && dismissedNotice.has(key))) {
    el.hidden = true;
    return;
  }
  el.innerHTML = '';
  const msg = h('span');
  if (javaInstalling) {
    // 설치 중: 다른 파일을 열어도 같은 진행 상황을 이어서 보여 준다
    const draw = () => (msg.innerHTML = `<span class="spinner"></span> <b>Java 언어 팩 설치 중</b> · ${progressText(javaProgress)}`);
    draw();
    noticeProgressHandler = draw;
    window.addEventListener('java-progress', noticeProgressHandler);
    el.append(h('span', { class: 'cn-ico', text: '☕' }), msg);
    el.hidden = false;
    return;
  }
  msg.innerHTML =
    '<b>Java 코드 검사를 쓰려면 Java 언어 팩이 필요합니다.</b> 처음 한 번 약 130MB 를 받으면, 프로젝트의 JDK 버전(pom.xml / build.gradle) 기준으로 오류 표시·자동 완성·어노테이션 확인·정의로 이동이 됩니다. (VS Code Java 와 같은 엔진)';
  const installBtn = h('button', { class: 'btn small primary', text: '설치' });
  const closeBtn = h('button', {
    class: 'tb-btn small',
    text: '닫기',
    onclick: () => {
      dismissedNotice.add(key);
      el.hidden = true;
    },
  });
  installBtn.onclick = async () => {
    const p = installJavaPack().catch((e) => {
      // 실패하면 안내 띠에 이유와 '다시 시도' 를 보여 준다
      const cur = activeDoc();
      if (cur) showLanguageNotice(cur);
      const m = $('#codeNotice span:nth-child(2)');
      if (m) m.innerHTML = `<b>설치하지 못했습니다:</b> ${e.message}`;
      const b = $('#codeNotice .btn.primary');
      if (b) b.textContent = '다시 시도';
    });
    showLanguageNotice(doc); // 진행 상황 모드로 다시 그림
    await p;
  };
  el.append(h('span', { class: 'cn-ico', text: '☕' }), msg, h('span', { class: 'tb-spacer' }), installBtn, closeBtn);
  el.hidden = false;
}
