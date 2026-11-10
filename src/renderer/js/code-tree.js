// 코드 화면의 파일 탐색기: 폴더 트리, 여러 개 선택, 새 파일·이름 변경·삭제, Git 상태 표시
import { $, h, contextMenu, confirmDialog, promptDialog, toast } from './ui.js';
import { state, refresh } from './state.js';
import { docs, keyOf, relOf, view } from './code-shared.js';
import { openFile, closeDoc, isDirty, editorHasFocus } from './code.js';

export async function renderTree() {
  const el = $('#codeTree');
  const repo = state.repo;
  const box = h('div', { class: 'tree-root' });
  await renderDir(repo, box, 0, repo);
  if (state.repo !== repo) return;
  el.replaceChildren(box);
  paintSel();
  decorateTree();
}

// ---------- 탐색기 선택: Ctrl+클릭 하나씩, Shift+클릭 범위, Ctrl+A 전체. Delete 삭제, F2 이름 변경 ----------
const treeSel = new Set();
let treeAnchor = null; // Shift 범위 선택의 시작점
let treeCursor = null; // 방향키로 움직이는 위치
let clip = null; // 복사·잘라내기 한 항목 { entries, cut }

const dirOf = (p) => p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')));
const rowOf = (k) => [...document.querySelectorAll('#codeTree .ft-row')].find((r) => keyOf(r.dataset.path) === k);
const entryOf = (r) => ({ path: r.dataset.path, name: r.dataset.name, dir: r.dataset.dir === '1' });
// 함께 고른 폴더 안의 항목은 폴더를 따라가므로 뺀다
const topLevel = (list) => {
  const keys = list.map((x) => keyOf(x.path));
  return list.filter((x) => !keys.some((k) => keyOf(x.path).startsWith(k + '\\')));
};

// 접힌 폴더 안의 항목은 빼고, 화면에 보이는 줄만 (위에서 아래 순서)
const visibleRows = () => [...document.querySelectorAll('#codeTree .ft-row')].filter((r) => r.offsetParent);

function paintSel() {
  const cut = clip?.cut ? new Set(clip.entries.map((x) => keyOf(x.path))) : null;
  document.querySelectorAll('#codeTree .ft-row').forEach((r) => {
    const k = keyOf(r.dataset.path);
    r.classList.toggle('sel', treeSel.has(k));
    r.classList.toggle('cut', !!cut?.has(k));
  });
}

function setSel(rows, anchor) {
  treeSel.clear();
  for (const r of rows) treeSel.add(keyOf(r.dataset.path));
  if (anchor) treeAnchor = treeCursor = keyOf(anchor.dataset.path);
  paintSel();
}

// true 를 돌려주면 선택만 바꾼 것 (파일을 열거나 폴더를 펼치지 않는다)
function selectClick(row, ev) {
  // 편집기에 포커스가 있었으면 먼저 놓게 한다 (안 그러면 파일을 연 뒤 편집기가 포커스를 다시 가져간다)
  if (editorHasFocus()) document.activeElement?.blur();
  $('#codeTree').focus({ preventScroll: true });
  const k = keyOf(row.dataset.path);
  if (ev.shiftKey) {
    const rows = visibleRows();
    const b = rows.indexOf(row);
    let a = rows.findIndex((r) => keyOf(r.dataset.path) === treeAnchor);
    if (a < 0) a = b;
    if (!ev.ctrlKey && !ev.metaKey) treeSel.clear();
    for (const r of rows.slice(Math.min(a, b), Math.max(a, b) + 1)) treeSel.add(keyOf(r.dataset.path));
    treeCursor = k;
    paintSel();
    return true;
  }
  if (ev.ctrlKey || ev.metaKey) {
    if (treeSel.has(k)) treeSel.delete(k);
    else treeSel.add(k);
    treeAnchor = treeCursor = k;
    paintSel();
    return true;
  }
  setSel([row], row);
  return false;
}

function selectedEntries() {
  return visibleRows()
    .filter((r) => treeSel.has(keyOf(r.dataset.path)))
    .map(entryOf);
}

// 방향키: ↑↓ 이동 (Shift 로 범위), → 폴더 펼치기·안으로, ← 접기·상위 폴더로, Enter 열기, Space 미리 열기, Home·End
async function moveCursor(ev) {
  const rows = visibleRows();
  if (!rows.length) return;
  let i = rows.findIndex((r) => keyOf(r.dataset.path) === treeCursor);
  if (i < 0) i = rows.findIndex((r) => treeSel.has(keyOf(r.dataset.path)));
  if (i < 0) i = rows.findIndex((r) => r.classList.contains('active'));
  const cur = rows[i];
  const go = (row, extend) => {
    if (!row) return;
    if (extend) {
      let a = rows.findIndex((r) => keyOf(r.dataset.path) === treeAnchor);
      const b = rows.indexOf(row);
      if (a < 0) a = b;
      treeSel.clear();
      for (const r of rows.slice(Math.min(a, b), Math.max(a, b) + 1)) treeSel.add(keyOf(r.dataset.path));
      treeCursor = keyOf(row.dataset.path);
      paintSel();
    } else setSel([row], row);
    row.scrollIntoView({ block: 'nearest' });
  };
  switch (ev.key) {
    case 'ArrowDown':
      return go(rows[Math.min(rows.length - 1, i + 1)], ev.shiftKey);
    case 'ArrowUp':
      return go(rows[i < 0 ? 0 : Math.max(0, i - 1)], ev.shiftKey);
    case 'Home':
      return go(rows[0], ev.shiftKey);
    case 'End':
      return go(rows[rows.length - 1], ev.shiftKey);
    case 'ArrowRight':
      if (!cur || cur.dataset.dir !== '1') return;
      if (cur.nextElementSibling?.hidden) return cur._toggle(true);
      return go(visibleRows()[i + 1]?.parentElement === cur.nextElementSibling ? visibleRows()[i + 1] : null);
    case 'ArrowLeft':
      if (!cur) return;
      if (cur.dataset.dir === '1' && !cur.nextElementSibling?.hidden) return cur._toggle(false);
      return go(cur.parentElement.classList.contains('ft-kids') ? cur.parentElement.previousElementSibling : null);
    case 'Enter':
    case ' ':
      if (!cur) return;
      if (cur.dataset.dir === '1') return cur._toggle();
      return openFile(cur.dataset.path, null, { keepFocus: ev.key === ' ' });
  }
}

export function onTreeKey(ev) {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)) return;
  const list = selectedEntries();
  const mod = ev.ctrlKey || ev.metaKey;
  if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(ev.key) && !mod && !ev.altKey) {
    ev.preventDefault();
    moveCursor(ev);
  } else if (mod && !ev.shiftKey && ev.key.toLowerCase() === 'c' && list.length) {
    ev.preventDefault();
    setClip(list, false);
  } else if (mod && !ev.shiftKey && ev.key.toLowerCase() === 'x' && list.length) {
    ev.preventDefault();
    setClip(list, true);
  } else if (mod && !ev.shiftKey && ev.key.toLowerCase() === 'v' && clip) {
    ev.preventDefault();
    paste(pasteDir());
  } else if (ev.key === 'Delete' && list.length) {
    ev.preventDefault();
    deleteEntries(list);
  } else if (ev.key === 'F2' && list.length) {
    ev.preventDefault();
    renameEntry(list.find((x) => keyOf(x.path) === treeAnchor) || list[0]);
  } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a') {
    ev.preventDefault();
    setSel(visibleRows(), null);
  } else if (ev.key === 'Escape' && clip?.cut) {
    clip = null;
    paintSel();
  } else if (ev.key === 'Escape' && treeSel.size) {
    setSel([], null);
  }
}

// ---------- 복사 · 잘라내기 · 붙여넣기 ----------
function setClip(list, cut) {
  clip = { entries: topLevel(list), cut };
  paintSel();
  toast(`${clip.entries.length}개 항목을 ${cut ? '잘라냈습니다' : '복사했습니다'}. 붙여넣을 폴더를 고르고 Ctrl+V 를 누르세요.`, 'info', 2500);
}

// 붙여넣을 폴더: 고른 것이 폴더면 그 안, 파일이면 그 파일이 있는 폴더, 아무것도 안 골랐으면 최상위
function pasteDir() {
  const row = rowOf(treeCursor) || visibleRows().find((r) => treeSel.has(keyOf(r.dataset.path)));
  if (!row) return state.repo;
  return row.dataset.dir === '1' ? row.dataset.path : dirOf(row.dataset.path);
}

async function paste(dir) {
  if (!clip) return;
  if (clip.cut) {
    const list = clip.entries;
    clip = null;
    return moveEntries(list, dir);
  }
  const made = [];
  const failed = [];
  for (const x of clip.entries) {
    const r = await window.api.fs.copy(x.path, dir);
    if (r.ok) made.push(r.data);
    else failed.push(`${x.name}: ${r.error}`);
  }
  await showMoved(dir, made, failed, '붙여넣지');
}

// 옮기기 (잘라내기 후 붙여넣기, 끌어서 놓기). 열려 있는 파일은 닫았다가 새 위치에서 다시 연다
async function moveEntries(list, dir) {
  list = topLevel(list).filter((x) => keyOf(dirOf(x.path)) !== keyOf(dir));
  if (!list.length) return paintSel();
  const under = (d, x) => keyOf(d.path) === keyOf(x.path) || keyOf(d.path).startsWith(keyOf(x.path) + '\\');
  const open = [...docs.values()].filter((d) => list.some((x) => under(d, x)));
  if (open.some(isDirty)) return toast('저장하지 않은 파일이 있습니다. 먼저 저장하세요.', 'warn');
  const active = view().active;
  const made = [];
  const failed = [];
  let reopen = null;
  for (const x of list) {
    const r = await window.api.fs.move(x.path, dir);
    if (!r.ok) {
      failed.push(`${x.name}: ${r.error}`);
      continue;
    }
    made.push(r.data);
    for (const d of open.filter((d) => under(d, x))) {
      if (active && keyOf(d.path) === keyOf(active)) reopen = r.data + d.path.slice(x.path.length);
      closeDoc(d, { force: true });
    }
  }
  await showMoved(dir, made, failed, '옮기지');
  if (reopen) await openFile(reopen, null, { keepFocus: true });
}

// 붙여넣거나 옮긴 뒤: 그 폴더를 펼치고 새 항목을 선택해 보여 준다
async function showMoved(dir, made, failed, verb) {
  if (keyOf(dir) !== keyOf(state.repo)) {
    for (let d = dir; d.length > state.repo.length; d = dirOf(d)) view().expanded.add(keyOf(d));
  }
  treeSel.clear();
  for (const p of made) treeSel.add(keyOf(p));
  if (made.length) treeAnchor = treeCursor = keyOf(made[0]);
  await renderTree();
  rowOf(treeCursor)?.scrollIntoView({ block: 'nearest' });
  $('#codeTree').focus({ preventScroll: true });
  refresh();
  if (failed.length) toast(`${verb} 못한 항목 ${failed.length}개\n${failed.join('\n')}`, 'error', 8000);
}

// ---------- 끌어서 옮기기 (Ctrl 을 누른 채 놓으면 복사) ----------
let dragging = null; // 끌고 있는 항목들
let dropRow = null; // 지금 놓을 곳으로 표시된 폴더 줄 (null 이면 최상위)
let hoverTimer = null;

// 마우스 아래 줄이 가리키는 폴더: 폴더 줄이면 그 폴더, 파일 줄이면 그 파일이 든 폴더의 줄
function dropTarget(ev) {
  const row = ev.target.closest?.('.ft-row');
  if (!row) return { dir: state.repo, row: null };
  if (row.dataset.dir === '1') return { dir: row.dataset.path, row };
  const parent = row.parentElement.classList.contains('ft-kids') ? row.parentElement.previousElementSibling : null;
  return { dir: parent ? parent.dataset.path : state.repo, row: parent };
}

function markDrop(row, on) {
  const tree = $('#codeTree');
  tree.querySelectorAll('.ft-row.drop').forEach((r) => r.classList.remove('drop'));
  tree.classList.toggle('drop-root', on && !row);
  if (on && row) row.classList.add('drop');
  if (dropRow !== row) {
    clearTimeout(hoverTimer);
    // 접힌 폴더 위에 잠시 머물면 펼친다
    if (on && row && row.nextElementSibling?.hidden) hoverTimer = setTimeout(() => row.isConnected && row._toggle(true), 700);
  }
  dropRow = on ? row : null;
}

export function initTree() {
  const tree = $('#codeTree');
  tree.addEventListener('keydown', onTreeKey);
  tree.addEventListener('dragstart', (ev) => {
    const row = ev.target.closest?.('.ft-row');
    if (!row) return;
    if (!treeSel.has(keyOf(row.dataset.path))) setSel([row], row);
    dragging = topLevel(selectedEntries());
    ev.dataTransfer.effectAllowed = 'copyMove';
    ev.dataTransfer.setData('text/plain', dragging.map((x) => x.path).join('\n'));
  });
  tree.addEventListener('dragover', (ev) => {
    if (!dragging) return;
    const t = dropTarget(ev);
    // 자기 자신이나 자기 안으로는 놓을 수 없다
    const bad = dragging.some((x) => x.dir && (keyOf(t.dir) + '\\').startsWith(keyOf(x.path) + '\\'));
    if (bad) return markDrop(null, false);
    ev.preventDefault();
    ev.dataTransfer.dropEffect = ev.ctrlKey ? 'copy' : 'move';
    markDrop(t.row, true);
  });
  tree.addEventListener('dragleave', (ev) => {
    if (!tree.contains(ev.relatedTarget)) markDrop(null, false);
  });
  tree.addEventListener('dragend', () => {
    dragging = null;
    markDrop(null, false);
  });
  tree.addEventListener('drop', async (ev) => {
    if (!dragging) return;
    ev.preventDefault();
    const { dir } = dropTarget(ev);
    const list = dragging;
    dragging = null;
    markDrop(null, false);
    if (ev.ctrlKey) {
      clip = { entries: list, cut: false };
      return paste(dir);
    }
    const moving = list.filter((x) => keyOf(dirOf(x.path)) !== keyOf(dir));
    if (!moving.length) return;
    const where = relOf(state.repo, dir) || '(최상위)';
    const msg = moving.length === 1 ? `'${moving[0].name}' 을(를) '${where}' (으)로 옮깁니다.` : `${moving.length}개 항목을 '${where}' (으)로 옮깁니다.`;
    const ok = await confirmDialog(msg, { title: '옮기기', okLabel: '옮기기', detail: moving.length > 1 ? moving.map((x) => relOf(state.repo, x.path)).join('\n') : undefined });
    if (ok) await moveEntries(moving, dir);
    else $('#codeTree').focus({ preventScroll: true });
  });
}

function multiMenu(list) {
  return [
    { header: `${list.length}개 선택됨` },
    { label: '복사', hint: 'Ctrl+C', onClick: () => setClip(list, false) },
    { label: '잘라내기', hint: 'Ctrl+X', onClick: () => setClip(list, true) },
    '-',
    { label: '삭제 (휴지통으로)', hint: 'Delete', danger: true, onClick: () => deleteEntries(list) },
    '-',
    { label: '경로 복사', onClick: () => window.api.copy(list.map((x) => x.path).join('\n')) },
    { label: '상대 경로 복사', onClick: () => window.api.copy(list.map((x) => relOf(state.repo, x.path)).join('\n')) },
  ];
}

// 탐색기 아이콘 (codicon)
const CHEV_RIGHT = '\ueab6';
const CHEV_DOWN = '\ueab4';
const FOLDER = '\uea83';
const FOLDER_OPEN = '\ueaf7';

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
      { class: `ft-row ${e.dir ? 'dir' : 'file'} ${v.active && keyOf(v.active) === keyOf(e.path) ? 'active' : ''}`, 'data-path': e.path, 'data-name': e.name, 'data-dir': e.dir ? '1' : '', draggable: 'true', style: { paddingLeft: `${8 + depth * 14}px` }, title: e.path },
      h('span', { class: 'ft-caret ci', text: e.dir ? (open ? CHEV_DOWN : CHEV_RIGHT) : '' }),
      h('span', { class: `ft-ico ${e.dir ? 'folder ci' : fileIcon(e.name)}`, text: e.dir ? (open ? FOLDER_OPEN : FOLDER) : '' }),
      h('span', { class: 'ft-name', text: e.name }),
      h('span', { class: 'ft-badge' })
    );
    parent.append(row);
    if (e.dir) {
      const kids = h('div', { class: 'ft-kids', hidden: !open });
      parent.append(kids);
      if (open) await renderDir(e.path, kids, depth + 1, repo);
      // want: true 펼치기, false 접기, 생략하면 반대로
      row._toggle = async (want) => {
        const k = keyOf(e.path);
        if (want === v.expanded.has(k)) return;
        if (v.expanded.has(k)) {
          v.expanded.delete(k);
          kids.hidden = true;
          row.querySelector('.ft-caret').textContent = CHEV_RIGHT;
          row.querySelector('.ft-ico').textContent = FOLDER;
        } else {
          v.expanded.add(k);
          kids.hidden = false;
          row.querySelector('.ft-caret').textContent = CHEV_DOWN;
          row.querySelector('.ft-ico').textContent = FOLDER_OPEN;
          if (!kids.childElementCount) {
            await renderDir(e.path, kids, depth + 1, repo);
            paintSel();
            decorateTree();
          }
        }
      };
      row.onclick = (ev) => !selectClick(row, ev) && row._toggle();
    } else {
      // 한 번 클릭: 파일을 열되 탐색기에 남아 있어 Delete·F2 를 바로 쓸 수 있다. 두 번 클릭: 편집기로 이동
      row.onclick = (ev) => !selectClick(row, ev) && openFile(e.path, null, { keepFocus: true });
      row.ondblclick = (ev) => !ev.ctrlKey && !ev.shiftKey && !ev.metaKey && openFile(e.path);
    }
    row.oncontextmenu = (ev) => {
      ev.preventDefault();
      if (!treeSel.has(keyOf(e.path))) setSel([row], row);
      $('#codeTree').focus({ preventScroll: true });
      const many = selectedEntries();
      contextMenu(ev.clientX, ev.clientY, many.length > 1 ? multiMenu(many) : treeMenu(e));
    };
  }
}

export function fileIcon(name) {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return `ext-${ext || 'none'}`;
}

// 탐색기에 Git 상태(수정/새 파일 등) 색칠
export function decorateTree() {
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
    { label: '복사', hint: 'Ctrl+C', onClick: () => setClip([e], false) },
    { label: '잘라내기', hint: 'Ctrl+X', onClick: () => setClip([e], true) },
    { label: '붙여넣기', hint: 'Ctrl+V', disabled: !clip, onClick: () => paste(parentDir) },
    '-',
    { label: '이름 변경...', hint: 'F2', onClick: () => renameEntry(e) },
    { label: '삭제 (휴지통으로)', hint: 'Delete', danger: true, onClick: () => deleteEntries([e]) },
    '-',
    e.dir ? { label: '이 폴더에서 찾기... (Ctrl+Shift+F)', onClick: () => window.dispatchEvent(new CustomEvent('cf-open-search', { detail: { dir: relOf(state.repo, e.path) } })) } : null,
    e.dir ? '-' : null,
    { label: '경로 복사', onClick: () => window.api.copy(e.path) },
    { label: '상대 경로 복사', onClick: () => window.api.copy(relOf(state.repo, e.path)) },
    { label: '탐색기에서 보기', onClick: () => window.api.showItem(e.path) },
    e.dir ? null : { label: '기본 프로그램으로 열기', onClick: () => window.api.openPath(e.path) },
  ];
}

export async function createIn(dir, kind) {
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
  treeSel.clear();
  treeSel.add(keyOf(target));
  treeAnchor = keyOf(target);
  await renderTree();
  if (!e.dir) await openFile(target, null, { keepFocus: true });
  $('#codeTree').focus({ preventScroll: true });
  refresh();
}

async function deleteEntries(list) {
  list = topLevel(list);
  const names = list.map((x) => relOf(state.repo, x.path) + (x.dir ? '/' : ''));
  const msg = list.length === 1 ? `'${names[0]}' 을(를) 휴지통으로 옮깁니다.` : `${list.length}개 항목을 휴지통으로 옮깁니다.`;
  const ok = await confirmDialog(msg, { title: '삭제', okLabel: '삭제', danger: true, detail: list.length > 1 ? names.join('\n') : undefined });
  if (!ok) return $('#codeTree').focus({ preventScroll: true });
  const failed = [];
  for (const x of list) {
    const r = await window.api.fs.trash(x.path);
    if (!r.ok) {
      failed.push(`${relOf(state.repo, x.path)}: ${r.error}`);
      continue;
    }
    for (const d of [...docs.values()]) if (keyOf(d.path) === keyOf(x.path) || keyOf(d.path).startsWith(keyOf(x.path) + '\\')) closeDoc(d, { force: true });
  }
  treeSel.clear();
  await renderTree();
  $('#codeTree').focus({ preventScroll: true });
  refresh();
  if (failed.length) toast(`삭제하지 못한 항목 ${failed.length}개\n${failed.join('\n')}`, 'error', 8000);
}

// 열린 파일이 탐색기에 보이도록 그 파일이 있는 폴더까지 펼치고 선택한다 (VS Code 처럼)
let revealSeq = 0;
export async function autoReveal(p) {
  const repo = state.repo;
  if (!repo || !p || p.startsWith('jdt:') || !keyOf(p).startsWith(keyOf(repo) + '\\')) return;
  const v = view();
  let dir = p;
  for (;;) {
    const i = Math.max(dir.lastIndexOf('\\'), dir.lastIndexOf('/'));
    if (i <= repo.length) break;
    dir = dir.slice(0, i);
    v.expanded.add(keyOf(dir));
  }
  const find = () => [...document.querySelectorAll('#codeTree .ft-row')].find((r) => keyOf(r.dataset.path) === keyOf(p));
  let row = find();
  if (!row || row.closest('.ft-kids[hidden]')) {
    // 탐색기를 아직 그리지 않았으면 그릴 때 펼쳐진 채로 나온다
    if (!document.querySelector('#codeTree .tree-root')) return;
    const seq = ++revealSeq;
    await renderTree();
    if (seq !== revealSeq || keyOf(view().active || '') !== keyOf(p)) return;
    row = find();
  }
  if (!row) return;
  if (!treeSel.has(keyOf(p))) setSel([row], row);
  row.scrollIntoView({ block: 'nearest' });
}

export function revealInTree(p) {
  let dir = p;
  while (dir.length > state.repo.length) {
    dir = dir.slice(0, Math.max(dir.lastIndexOf('\\'), dir.lastIndexOf('/')));
    if (dir.length > state.repo.length) view().expanded.add(keyOf(dir));
  }
  renderTree().then(() => document.querySelector(`#codeTree .ft-row.active`)?.scrollIntoView({ block: 'center' }));
}
