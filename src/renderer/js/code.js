// 코드 화면: 파일 탐색기 + 파일 탭 + Monaco 편집기(VS Code 편집기) + 언어 서버 오류 표시 + Git 변경 표시
import { $, h, contextMenu, confirmDialog, choiceDialog, toast, splitter } from './ui.js';
import { state, git, onRefresh, refresh } from './state.js';
import * as lsp from './lsp-client.js';
import { IMG_RE, showImage } from './preview.js';
import { initTerminal, showTerminalsFor, toggleTerminal, isTerminalVisible } from './terminal.js';
import { docs, repoViews, keyOf, relOf, baseName, view } from './code-shared.js';
import { renderTree, decorateTree, initTree, autoReveal, revealInTree, createIn, fileIcon } from './code-tree.js';
import { pythonStatusItem, javaStatusItem, showLanguageNotice, refreshJavaPack, prepareJava, ensurePython, virtualName } from './code-lang.js';

// 다른 파일에서 code.js 로 불러 쓰던 이름은 그대로 쓸 수 있게 한다
export { onRepoActivated, installJavaPack, removeJavaPack, openProjectStructure } from './code-lang.js';

const MONACO_BASE = '../../node_modules/monaco-editor/min/vs';

let monaco = null;
let editor = null;
let loading = null;
let root;
let boundRepo = null;
let emptyHtml = '';

// ---------- 화면 뼈대 ----------

export function initCode() {
  root = $('#view-code');
  root.innerHTML = `
    <div class="code-explorer" id="codeExplorer">
      <div class="panel-bar">
        <span class="panel-title">탐색기</span>
        <span class="tb-spacer"></span>
        <button class="tb-btn small" id="codeSearch" title="프로젝트에서 찾기 (Ctrl+Shift+F)"><span class="ci">&#xea6d;</span></button>
        <button class="tb-btn small" id="codeNewFile" title="새 파일"><span class="ci">&#xea7f;</span></button>
        <button class="tb-btn small" id="codeNewFolder" title="새 폴더"><span class="ci">&#xea80;</span></button>
        <button class="tb-btn small" id="codeCollapse" title="모두 접기"><span class="ci">&#xeac5;</span></button>
        <button class="tb-btn small" id="codeReload" title="새로고침"><span class="ci">&#xeb37;</span></button>
      </div>
      <div class="code-tree" id="codeTree" tabindex="0"></div>
    </div>
    <div class="splitter-x" id="codeSplit"></div>
    <div class="code-main">
      <div class="code-tabs" id="codeTabs"></div>
      <div class="code-notice" id="codeNotice" hidden></div>
      <div class="code-editor-wrap">
        <div class="code-editor" id="codeEditor"></div>
        <div class="code-empty" id="codeEmpty"><div><b>파일을 선택하세요</b><br><small>왼쪽 탐색기에서 파일을 열면 VS Code 와 같은 편집기로 수정할 수 있습니다.<br>Ctrl+S 저장 · Ctrl+F 찾기 · Ctrl+Shift+F 프로젝트 전체 찾기 · Ctrl+H 바꾸기 · F12 정의로 이동 · Ctrl+Alt+←/→ 이전/다음 위치 · Shift+Alt+F 서식 정리</small></div></div>
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
  initTree();
  $('#codeCollapse').onclick = () => {
    view().expanded.clear();
    renderTree();
  };
  $('#codeSearch').onclick = () => window.dispatchEvent(new CustomEvent('cf-open-search'));
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
  editor.onDidChangeCursorPosition((e) => {
    updateStatus();
    navOnCursor(e);
  });
  // 탐색 기록: 이전 위치로 / 다음 위치로 (IntelliJ 와 같은 키)
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.LeftArrow, () => navGo(-1));
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.RightArrow, () => navGo(1));
  monaco.editor.onDidChangeMarkers(() => {
    updateStatus();
    renderTabs();
  });

  refreshJavaPack();
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
    // 편집기 밖(탐색기 등)에 포커스가 있을 때도 뒤로/앞으로
    if (e.ctrlKey && e.altKey && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !editor.hasTextFocus() && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) {
      e.preventDefault();
      navGo(e.key === 'ArrowLeft' ? -1 : 1);
    }
  });
  // 마우스 뒤로/앞으로 버튼
  root.addEventListener('mouseup', (e) => {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    navGo(e.button === 3 ? -1 : 1);
  });
}

// ---------- 탐색 기록 (Ctrl+Alt+← 이전 위치 / Ctrl+Alt+→ 다음 위치) ----------
// 다른 파일로 가거나(탭, 탐색기, 정의로 이동, 검색 결과) 한 파일 안에서 멀리 뛸 때 떠나는 위치를 남긴다
const NAV_JUMP = 10; // 이 줄 수 이상 떨어지면 다른 위치로 본다
const NAV_MAX = 100;
let navQuiet = 0; // 뒤로/앞으로 이동 중에는 기록하지 않는다
let navLast = null; // 마지막으로 본 커서 위치

function curPos() {
  const d = activeDoc();
  const p = editor?.getPosition();
  if (!d || !p || editor.getModel() !== d.model) return null;
  return { path: d.path, line: p.lineNumber, col: p.column };
}
const samePlace = (a, b) => a && b && keyOf(a.path) === keyOf(b.path) && Math.abs(a.line - b.line) < NAV_JUMP;

function navRecord(pos) {
  if (!pos) return;
  const v = view();
  // 바로 앞 기록과 거의 같은 곳이면 새로 쌓지 않고 위치만 바꾼다
  if (samePlace(v.back.at(-1), pos)) v.back[v.back.length - 1] = pos;
  else v.back.push(pos);
  if (v.back.length > NAV_MAX) v.back.shift();
  v.fwd = [];
}

function navOnCursor(e) {
  const pos = curPos();
  // 같은 파일 안에서 멀리 뜀(같은 파일 안 정의로 이동, 찾기, 줄 이동, 멀리 클릭) → 떠난 위치를 남김. 방향키·PageDown 등 키보드 이동은 제외
  if (!navQuiet && pos && navLast && keyOf(navLast.path) === keyOf(pos.path) && !samePlace(navLast, pos) && e.source !== 'keyboard') navRecord(navLast);
  navLast = pos;
}

async function navGo(dir) {
  const v = view();
  const from = dir < 0 ? v.back : v.fwd;
  const to = dir < 0 ? v.fwd : v.back;
  const cur = curPos();
  let target = from.pop();
  while (target && cur && keyOf(target.path) === keyOf(cur.path) && target.line === cur.line) target = from.pop();
  if (!target) return;
  if (cur) to.push(cur);
  navQuiet++;
  try {
    await openFile(target.path, { lineNumber: target.line, column: target.col });
  } finally {
    navQuiet--;
  }
  navLast = curPos();
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

// 편집기에서 선택한 한 줄 글자 (프로젝트 검색어로 미리 채우기)
export function selectedText() {
  if (!editor || state.view !== 'code') return '';
  const sel = editor.getSelection();
  if (!sel || sel.isEmpty() || sel.startLineNumber !== sel.endLineNumber) return '';
  return editor.getModel()?.getValueInRange(sel) || '';
}

export async function openFile(path, selection, opts = {}) {
  if (IMG_RE.test(path) && !opts.code) return showImage(path, { openCode: /\.svg$/i.test(path) ? () => openFile(path, selection, { code: true }) : null });
  if (!monaco) await activateCode();
  const doc = await ensureDoc(path);
  if (!doc) return;
  const v = view();
  if (!v.tabs.some((p) => keyOf(p) === keyOf(path))) v.tabs.push(doc.path);
  const before = navQuiet ? null : curPos();
  navQuiet++;
  try {
    activate(doc.path);
    showLanguageNotice(doc);
    if (selection) {
      const range = selection.startLineNumber ? selection : { startLineNumber: selection.lineNumber, startColumn: selection.column, endLineNumber: selection.lineNumber, endColumn: selection.column };
      editor.setSelection(range);
      editor.revealRangeInCenterIfOutsideViewport(range);
    }
  } finally {
    navQuiet--;
  }
  if (before && !samePlace(before, curPos())) navRecord(before);
  navLast = curPos();
  if (!opts.keepFocus) editor.focus();
}

function activate(path) {
  const v = view();
  const prev = docs.get(keyOf(v.active || ''));
  // 탭을 눌러 다른 파일로 갈 때: 떠나는 위치를 기록 (openFile·뒤로/앞으로에서 부를 때는 그쪽에서 처리)
  if (!navQuiet && prev && prev.model === editor.getModel() && keyOf(prev.path) !== keyOf(path)) navRecord(curPos());
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
  autoReveal(doc.path);
}

export const editorHasFocus = () => !!editor?.hasTextFocus();

function showEmpty() {
  view().active = null;
  if ($('#codeNotice')) $('#codeNotice').hidden = true;
  editor?.setModel(null);
  $('#codeEditor').style.visibility = 'hidden';
  $('#codeEmpty').hidden = false;
  renderTabs();
  updateStatus();
}

export const isDirty = (d) => d.model.getAlternativeVersionId() !== d.savedVersion;
export const activeDoc = () => docs.get(keyOf(view().active || ''));

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

export function closeDoc(d, { force } = {}) {
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

// ---------- 저장 / 디스크 변경 감지 ----------

async function saveDoc(d) {
  if (d.virtual) return true;
  // 열어 둔 뒤 디스크의 파일이 다른 곳(AI, 다른 프로그램)에서 바뀌었으면 예전 내용으로 덮어쓰지 않는다
  const st = await window.api.fs.stat(d.path);
  if (st.ok && st.data.exists && d.mtime && Math.abs(st.data.mtime - d.mtime) >= 1) {
    if (!isDirty(d)) {
      await checkDiskChanges(); // 고친 게 없으면 새 내용을 다시 읽기만
      toast(`'${baseName(d.path)}' 이(가) 다른 곳에서 바뀌어 새 내용을 불러왔습니다.`, 'info', 4000);
      return true;
    }
    if (!(await confirmDialog(`'${baseName(d.path)}' 이(가) 열어 둔 뒤 다른 곳(AI 등)에서 바뀌었습니다.\n내가 고친 내용으로 덮어쓸까요?`, { title: '파일이 바뀌었습니다', okLabel: '덮어쓰기', danger: true })))
      return false;
  }
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

export function updateStatus() {
  const el = $('#codeStatus');
  if (!el) return;
  const d = activeDoc();
  const termBtn = h('span', { class: `cs-item cs-btn ${isTerminalVisible() ? 'on' : ''}`, title: '터미널 열기/닫기 (Ctrl+`)', text: '⌨ 터미널' });
  termBtn.onclick = () => {
    toggleTerminal();
    updateStatus();
  };
  if (!d || !editor) {
    // 파일을 열지 않았어도 이 프로젝트의 Java 언어 서버 상태(미리 켜 둔 것)는 보여 준다
    const jinfo = state.repo ? lsp.serverInfo(state.repo, 'java') : null;
    el.innerHTML = '';
    el.append(...[h('span', { class: 'tb-spacer' }), jinfo ? javaStatusItem(state.repo, jinfo) : null, termBtn].filter(Boolean));
    if (jinfo && jinfo.status === 'starting') setTimeout(updateStatus, 800);
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
