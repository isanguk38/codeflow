// 저장소 열기/만들기/복제, 시작 화면, 설정
import { $, h, esc, menuAt, modal, promptDialog, confirmDialog, toast, errorDialog, contextMenu } from './ui.js';
import { state, git, op, refresh } from './state.js';

let onOpened = () => {};
export const setOnOpened = (fn) => (onOpened = fn);

// ---------- 탭 (여러 프로젝트 동시에 열기) ----------
export const tabs = []; // { path, view, status }
const norm = (p) => p.replace(/[\\/]+$/, '').toLowerCase();

function saveTabs() {
  window.api.setSettings({ tabs: tabs.map((t) => t.path), last: state.repo });
}

// ---------- 탭 그룹 (크롬처럼: 색깔 이름표로 묶고, 이름표를 누르면 접기/펼치기) ----------
// settings.tabGroups = [{ id, name, color, collapsed, closed, paths: [프로젝트 경로...] }]
// closed: '그룹 닫기' 로 탭은 모두 닫았지만 그룹은 기억 (오른쪽 끝 이름표를 누르면 다시 열림)
const GROUP_COLORS = [
  ['grey', '#8a8f98'],
  ['blue', '#3b82f6'],
  ['red', '#e5484d'],
  ['yellow', '#d39e00'],
  ['green', '#2f9e44'],
  ['pink', '#d6409f'],
  ['purple', '#8e4ec6'],
  ['cyan', '#0c9fb5'],
];
const colorOf = (g) => (GROUP_COLORS.find(([k]) => k === g.color) || GROUP_COLORS[1])[1];
let groups = null;
function loadGroups() {
  if (groups) return groups;
  groups = (state.settings?.tabGroups || []).map((g) => ({ ...g, paths: [...(g.paths || [])] }));
  return groups;
}
function saveGroups() {
  // 빈 그룹은 지운다
  groups = loadGroups().filter((g) => g.paths.length);
  window.api.setSettings({ tabGroups: groups });
}
const inGroup = (g, path) => g.paths.some((p) => norm(p) === norm(path));
// 열려 있는 그룹 중에서 (닫힌 그룹의 프로젝트를 따로 열면 그룹 밖 탭으로 취급)
const groupOf = (path) => loadGroups().find((g) => !g.closed && inGroup(g, path)) || null;
function setGroup(path, g) {
  for (const x of loadGroups()) if (!x.closed) x.paths = x.paths.filter((p) => norm(p) !== norm(path));
  if (g) g.paths.push(path);
}
function newGroup(paths, name = '') {
  const used = new Set(loadGroups().map((g) => g.color));
  const color = (GROUP_COLORS.find(([k]) => !used.has(k)) || GROUP_COLORS[groups.length % GROUP_COLORS.length])[0];
  const g = { id: `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, color, collapsed: false, closed: false, paths: [] };
  groups.push(g);
  for (const p of paths) setGroup(p, g);
  return g;
}
const isActive = (t) => state.repo && norm(t.path) === norm(state.repo);
const groupLabel = (g) => g.name || '이름 없는 그룹';

// 그룹 닫기: 그룹은 기억하고, 속한 프로젝트 탭만 모두 닫는다
let closingGroup = false;
async function closeGroup(g) {
  const members = tabs.filter((t) => groupOf(t.path) === g);
  // 지금 보고 있는 프로젝트가 이 그룹이면 그것도 닫고, 다른 탭으로 옮기지 않는다 (아무 프로젝트도 선택 안 된 상태)
  g.closed = true;
  g.collapsed = false;
  closingGroup = true;
  try {
    for (const t of members) await closeTab(t.path);
  } finally {
    closingGroup = false;
  }
  saveGroups();
  renderTabs();
  toast(`'${groupLabel(g)}' 그룹을 닫았습니다. 탭 바 오른쪽 끝 이름표를 누르면 ${g.paths.length}개 프로젝트가 다시 열립니다.`, 'ok', 5000);
}

// 닫힌 그룹 다시 열기: 프로젝트를 모두 탭으로 열고 첫 번째로 이동
async function reopenGroup(g) {
  g.closed = false;
  const missing = [];
  let first = null;
  for (const p of [...g.paths]) {
    if (!(await window.api.exists(p))) {
      missing.push(p);
      continue;
    }
    const r = await window.api.openRepo(p);
    if (!r.ok) {
      missing.push(p);
      continue;
    }
    // 다른 그룹에 열려 있던 프로젝트면 이 그룹으로 옮긴다
    setGroup(r.data, null);
    if (!inGroup(g, r.data)) g.paths.push(r.data);
    if (!tabs.some((x) => norm(x.path) === norm(r.data))) tabs.push({ path: r.data, view: 'code' });
    first = first || r.data;
  }
  if (missing.length) {
    g.paths = g.paths.filter((p) => !missing.includes(p));
    toast(`찾을 수 없는 폴더 ${missing.length}개는 그룹에서 뺐습니다.`, 'warn', 5000);
  }
  saveGroups();
  if (first) await switchTab(first);
  else renderTabs();
}

// 그룹 삭제: 탭도 닫고 그룹도 지운다
async function deleteGroup(g) {
  const ok = await confirmDialog(`'${groupLabel(g)}' 그룹을 삭제할까요?${g.closed ? '' : '\n그룹에 속한 탭도 모두 닫힙니다.'}\n(프로젝트 폴더는 그대로입니다)`, { title: '그룹 삭제', okLabel: '삭제', danger: true });
  if (!ok) return;
  if (!g.closed) for (const t of tabs.filter((x) => groupOf(x.path) === g)) await closeTab(t.path);
  g.paths = [];
  saveGroups();
  renderTabs();
}

// 화면에 그리는 순서: 그룹은 첫 탭 자리에 모아서 [이름표, 탭들], 나머지는 원래 순서대로
function layout() {
  const out = [];
  const seen = new Set();
  for (const t of tabs) {
    const g = groupOf(t.path);
    if (!g) out.push({ tab: t });
    else if (!seen.has(g.id)) {
      seen.add(g.id);
      out.push({ group: g, tabs: tabs.filter((x) => groupOf(x.path) === g) });
    }
  }
  return out;
}
// Ctrl+Tab 순서: 화면 순서, 접힌 그룹은 건너뜀
function visibleOrder() {
  return layout().flatMap((x) => (x.tab ? [x.tab] : x.group.collapsed ? [] : x.tabs));
}

// 이름·색 바꾸기 + 그룹 닫기/해제/삭제 (크롬의 그룹 편집 말풍선처럼)
function editGroup(g, anchor) {
  document.querySelector('.tg-editor')?.remove();
  const box = h('div', { class: 'tg-editor' });
  const name = h('input', { class: 'input', value: g.name, placeholder: '그룹 이름 (예: 현대건설 스토어)', spellcheck: 'false' });
  name.oninput = () => {
    g.name = name.value.trim();
    saveGroups();
    renderTabs();
  };
  const colors = h('div', { class: 'tg-colors' });
  for (const [k, c] of GROUP_COLORS) {
    const dot = h('button', { class: `tg-dot ${g.color === k ? 'on' : ''}`, title: k, style: { background: c } });
    dot.onclick = () => {
      g.color = k;
      colors.querySelectorAll('.tg-dot').forEach((d) => d.classList.toggle('on', d === dot));
      saveGroups();
      renderTabs();
    };
    colors.append(dot);
  }
  const close = () => {
    box.remove();
    document.removeEventListener('mousedown', outside, true);
  };
  const outside = (e) => !box.contains(e.target) && close();
  const act = (text, title, fn, cls = '') => {
    const b = h('button', { class: `tg-act ${cls}`, text, title });
    b.onclick = () => (close(), fn());
    return b;
  };
  // on... 처리기가 false 를 돌려주면 키 입력이 취소되므로(영문·띄어쓰기가 안 써짐) 값을 돌려주지 않는다
  name.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') close();
  };
  box.append(
    name,
    colors,
    g.closed
      ? act(`다시 열기 (${g.paths.length}개 프로젝트)`, '그룹의 프로젝트를 모두 탭으로 엽니다', () => reopenGroup(g))
      : act('그룹 닫기', '그룹은 기억하고 탭만 모두 닫습니다. 오른쪽 끝 이름표로 다시 열 수 있습니다', () => closeGroup(g)),
    g.closed ? null : act('그룹 해제 (탭은 그대로)', '묶음만 풀고 탭은 그대로 둡니다', () => ((g.paths = []), saveGroups(), renderTabs())),
    act(g.closed ? '그룹 삭제' : '그룹 삭제 (탭도 닫기)', '그룹을 지웁니다. 프로젝트 폴더는 그대로입니다', () => deleteGroup(g), 'danger')
  );
  document.body.append(box);
  const r = anchor.getBoundingClientRect();
  box.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - box.offsetWidth - 8))}px`;
  box.style.top = `${r.bottom + 4}px`;
  setTimeout(() => {
    name.focus();
    name.select();
    document.addEventListener('mousedown', outside, true);
  });
}

// 같은 상위 폴더에 있는 프로젝트끼리 자동으로 묶기 (2개 이상인 폴더만)
function groupByFolder() {
  const parentOf = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).slice(0, -1).join('\\');
  const by = new Map();
  for (const t of tabs) {
    if (groupOf(t.path)) continue;
    const k = parentOf(t.path).toLowerCase();
    if (!by.has(k)) by.set(k, { name: parentOf(t.path).split('\\').pop(), list: [] });
    by.get(k).list.push(t.path);
  }
  let n = 0;
  for (const { name, list } of by.values()) {
    if (list.length < 2) continue;
    newGroup(list, name);
    n++;
  }
  saveGroups();
  renderTabs();
  toast(n ? `폴더별로 ${n}개 그룹을 만들었습니다. 이름표를 누르면 접고, 우클릭하면 이름·색 바꾸기와 그룹 닫기가 있습니다.` : '같은 폴더에 있는 프로젝트(2개 이상)가 없습니다.', n ? 'ok' : 'info', 5000);
}

function barMenu(x, y) {
  const open = loadGroups().filter((g) => !g.closed);
  contextMenu(x, y, [
    { label: '모든 프로젝트 목록... (Ctrl+Shift+E)', onClick: () => openProjectList() },
    '-',
    { label: '상위 폴더별로 자동 묶기', disabled: tabs.filter((t) => !groupOf(t.path)).length < 2, onClick: groupByFolder },
    { label: '모든 그룹 접기', disabled: !open.length, onClick: () => collapseGroups(open) },
    { label: '모든 그룹 펼치기', disabled: !open.length, onClick: () => (open.forEach((g) => (g.collapsed = false)), saveGroups(), renderTabs()) },
  ]);
}

// 그룹 접기 (크롬처럼 완전히 숨김). 지금 탭이 접는 그룹 안에 있으면
// 그룹 오른쪽(없으면 왼쪽)의 그룹 밖 탭으로 옮기고, 그런 탭이 없으면 선택을 뺀다(시작 화면)
async function collapseGroups(list) {
  const cur = state.repo && groupOf(state.repo);
  const order = layout().flatMap((x) => (x.tab ? [x.tab] : x.tabs));
  for (const g of list) g.collapsed = true;
  saveGroups();
  if (cur && list.includes(cur)) {
    const i = order.findIndex(isActive);
    const outside = (t) => {
      const x = groupOf(t.path);
      return !x || !x.collapsed;
    };
    const next = order.slice(i + 1).find(outside) || order.slice(0, i).reverse().find(outside);
    if (next) return switchTab(next.path);
    state.repo = null;
    state.status = null;
    saveTabs();
    renderTabs();
    return onOpened();
  }
  renderTabs();
}
function expandGroup(g) {
  g.collapsed = false;
  saveGroups();
  renderTabs();
}

// ---------- 끌어 놓기 ----------
// - 탭을 다른 탭 위에 놓으면 순서만 바뀐다 (놓은 위치의 왼쪽/오른쪽). 다른 그룹의 탭 위면 그 그룹의 앞/뒤로 (그룹에 들어가지 않음)
// - 그룹 안 탭을 같은 그룹 안에서 끌면 그룹 안 순서만 바뀜. 그룹 밖 탭 위에 놓으면 그룹에서 빠짐
// - 탭을 그룹 이름표의 가운데에 놓을 때만 그 그룹에 들어감 (이름표 왼쪽 끝: 그룹 앞, 접힌 그룹의 오른쪽 끝: 그룹 뒤)
// - 이름표를 끌면 그룹 통째로 옮김
let dragging = null; // { tab } | { group }
const sideOf = (e, el) => {
  const r = el.getBoundingClientRect();
  return e.clientX < r.left + r.width / 2 ? 'before' : 'after';
};
// 탭 배열을 화면 순서로 맞춘다 (그룹은 모아서)
function normalizeOrder() {
  const order = layout().flatMap((x) => (x.tab ? [x.tab] : x.tabs));
  tabs.splice(0, tabs.length, ...order);
}
const blockOf = (g) => tabs.filter((x) => groupOf(x.path) === g);
// 탭 묶음(list)을 anchor 묶음의 앞/뒤로 옮긴다
function moveBlock(list, anchorList, side) {
  if (!list.length || !anchorList.length) return;
  for (const t of list) tabs.splice(tabs.indexOf(t), 1);
  const at = side === 'before' ? tabs.indexOf(anchorList[0]) : tabs.indexOf(anchorList[anchorList.length - 1]) + 1;
  tabs.splice(at, 0, ...list);
}
function finishDrop() {
  saveGroups();
  saveTabs();
  renderTabs();
}
function clearDropMarks() {
  document.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach((x) => x.classList.remove('drop-before', 'drop-after', 'drop-into'));
}

// 탭 위에 놓기
function dropOnTab(e, target, tg) {
  e.preventDefault();
  e.stopPropagation();
  clearDropMarks();
  const d = dragging;
  dragging = null;
  if (!d) return;
  normalizeOrder();
  const side = sideOf(e, e.currentTarget);
  if (d.group) {
    // 그룹을 탭 쪽으로: 대상이 다른 그룹 탭이면 그 그룹 묶음 기준, 아니면 그 탭 기준
    if (tg === d.group) return;
    moveBlock(blockOf(d.group), tg ? blockOf(tg) : [target], side);
    return finishDrop();
  }
  const moving = d.tab;
  if (moving === target) return;
  const mg = groupOf(moving.path);
  if (tg && tg === mg) {
    moveBlock([moving], [target], side); // 같은 그룹 안 순서
  } else if (tg) {
    setGroup(moving.path, null); // 다른 그룹 쪽: 들어가지 않고 그 그룹의 앞/뒤로
    moveBlock([moving], blockOf(tg), side);
  } else {
    setGroup(moving.path, null); // 그룹 밖 탭 위: 그룹에서 빠져서 그 자리로
    moveBlock([moving], [target], side);
  }
  finishDrop();
}

// 탭을 이름표 위에 놓을 때 어디로 갈지: 왼쪽 1/4 = 그룹 앞, (접힌 그룹만) 오른쪽 1/4 = 그룹 뒤, 나머지 = 그룹에 넣기
function chipZone(e, el, g) {
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  if (x < 0.25) return 'before';
  if (g.collapsed && x > 0.75) return 'after';
  return 'into';
}

// 이름표 위에 놓기: 탭이면 그룹에 넣기(또는 그룹 앞/뒤로), 그룹이면 그룹 순서 바꾸기
function dropOnChip(e, g) {
  e.preventDefault();
  e.stopPropagation();
  clearDropMarks();
  const d = dragging;
  dragging = null;
  if (!d) return;
  normalizeOrder();
  if (d.group) {
    if (d.group === g) return;
    moveBlock(blockOf(d.group), blockOf(g), sideOf(e, e.currentTarget));
    return finishDrop();
  }
  const moving = d.tab;
  const zone = chipZone(e, e.currentTarget, g);
  if (zone !== 'into') {
    // 그룹에 넣지 않고 그룹 앞/뒤로만
    setGroup(moving.path, null);
    moveBlock([moving], blockOf(g), zone);
    return finishDrop();
  }
  if (groupOf(moving.path) === g) return;
  setGroup(moving.path, g);
  // 그룹의 맨 뒤로
  const rest = blockOf(g).filter((x) => x !== moving);
  if (rest.length) moveBlock([moving], rest, 'after');
  if (g.collapsed) g.collapsed = false;
  finishDrop();
}

// 끄는 동안 놓일 자리 표시: 세로 막대(앞/뒤) 또는 이름표 강조(그룹에 넣기)
function markDrop(e, el, kind) {
  if (!dragging) return;
  e.preventDefault();
  clearDropMarks();
  if (kind === 'chip' && dragging.tab) {
    const g = loadGroups().find((x) => x.id === el.dataset.id);
    const zone = g ? chipZone(e, el, g) : 'into';
    return el.classList.add(zone === 'into' ? 'drop-into' : zone === 'before' ? 'drop-before' : 'drop-after');
  }
  el.classList.add(sideOf(e, el) === 'before' ? 'drop-before' : 'drop-after');
}

function tabEl(t, g) {
  const active = isActive(t);
  const st = t.status;
  const n = st?.files?.length || 0;
  const el = h(
    'div',
    { class: `tab ${active ? 'active' : ''} ${g ? 'in-group' : ''}`, title: `${t.path}${g ? `\n그룹: ${groupLabel(g)}` : ''}`, draggable: 'true' },
    h('span', { class: 'tab-name', text: repoName(t.path) }),
    st ? h('span', { class: `tab-branch ${st.detached ? 'detached' : ''}`, text: st.detached ? `HEAD` : st.branch || '' }) : null,
    n ? h('span', { class: 'tab-count', text: n, title: `변경 ${n}개` }) : null,
    st?.state || st?.files?.some((f) => f.status === 'conflict') ? h('span', { class: 'tab-warn', text: '⚠', title: '병합/리베이스 진행 중' }) : null,
    h('button', { class: 'tab-x', text: '✕', title: '탭 닫기 (Ctrl+W)', onclick: (e) => (e.stopPropagation(), closeTab(t.path)) })
  );
  el.onclick = () => !active && switchTab(t.path);
  el.onauxclick = (e) => e.button === 1 && closeTab(t.path);
  el.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const others = loadGroups().filter((x) => x !== g && !x.closed);
    contextMenu(e.clientX, e.clientY, [
      {
        label: '새 그룹에 추가...',
        onClick: () => {
          const ng = newGroup([t.path]);
          saveGroups();
          renderTabs();
          const chip = document.querySelector(`.tg-chip[data-id="${ng.id}"]`);
          if (chip) editGroup(ng, chip);
        },
      },
      ...others.map((x) => ({ label: `'${groupLabel(x)}' 그룹으로 이동`, onClick: () => (setGroup(t.path, x), saveGroups(), renderTabs()) })),
      g ? { label: '그룹에서 빼기', onClick: () => (setGroup(t.path, null), saveGroups(), renderTabs()) } : null,
      g ? { label: `'${groupLabel(g)}' 그룹 닫기 (나중에 다시 열기)`, onClick: () => closeGroup(g) } : null,
      '-',
      { label: '탭 닫기', onClick: () => closeTab(t.path) },
      { label: '다른 탭 모두 닫기', disabled: tabs.length < 2, onClick: () => tabs.filter((x) => x !== t).forEach((x) => closeTab(x.path)) },
      '-',
      { label: '상위 폴더별로 자동 묶기', disabled: tabs.filter((x) => !groupOf(x.path)).length < 2, onClick: groupByFolder },
      { label: '모든 프로젝트 목록... (Ctrl+Shift+E)', onClick: () => openProjectList() },
      '-',
      { label: '탐색기에서 열기', onClick: () => window.api.openPath(t.path) },
      { label: '경로 복사', onClick: () => window.api.copy(t.path) },
    ]);
  };
  el.ondragstart = (e) => {
    dragging = { tab: t };
    e.dataTransfer.setData('text/tab', t.path);
    e.dataTransfer.effectAllowed = 'move';
  };
  el.ondragend = () => ((dragging = null), clearDropMarks());
  el.ondragover = (e) => markDrop(e, el, 'tab');
  el.ondragleave = () => el.classList.remove('drop-before', 'drop-after');
  el.ondrop = (e) => dropOnTab(e, t, g);
  return el;
}

function chipEl(g, count, onClick) {
  const chip = h(
    'button',
    {
      class: `tg-chip ${g.collapsed ? 'collapsed' : ''} ${g.closed ? 'closed' : ''}`,
      'data-id': g.id,
      title: g.closed
        ? `${groupLabel(g)} — 닫힌 그룹 (${g.paths.length}개 프로젝트)\n클릭: 다시 열기 · 우클릭: 이름·색 / 삭제`
        : `${groupLabel(g)} — 프로젝트 ${count}개\n클릭: ${g.collapsed ? '펼치기' : '접기'} · 우클릭: 이름·색 / 그룹 닫기\n탭을 끌어 가운데에 놓으면 그룹에 넣기 · 왼쪽 끝에 놓으면 그룹 앞으로`,
    },
    h('span', { class: 'tg-name', text: g.name || '' })
  );
  if (!g.name) chip.classList.add('unnamed'); // 이름 없는 그룹: 작은 색 점
  chip.style.setProperty('--gc', colorOf(g));
  chip.onclick = onClick;
  chip.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    editGroup(g, chip);
  };
  return chip;
}

export function renderTabs() {
  const bar = $('#tabbar');
  const oldScroll = bar.querySelector('.tab-scroll');
  const keepLeft = oldScroll ? oldScroll.scrollLeft : 0;
  bar.innerHTML = '';
  const closedGroups = loadGroups().filter((g) => g.closed);
  bar.hidden = !tabs.length && !closedGroups.length;
  // 왼쪽: 탭들(넘치면 가로 스크롤) / 오른쪽 고정: 닫힌 그룹 이름표, 모든 프로젝트 목록, ＋
  const scroll = h('div', { class: 'tab-scroll' });
  for (const item of layout()) {
    if (item.tab) {
      scroll.append(tabEl(item.tab, null));
      continue;
    }
    const g = item.group;
    const shown = g.collapsed ? [] : item.tabs; // 접으면 이름표만 (지금 탭도 숨김)
    const chip = chipEl(g, item.tabs.length, () => (g.collapsed ? expandGroup(g) : collapseGroups([g])));
    chip.draggable = true;
    chip.ondragstart = (e) => {
      dragging = { group: g };
      e.dataTransfer.setData('text/group', g.id);
      e.dataTransfer.effectAllowed = 'move';
    };
    chip.ondragend = () => ((dragging = null), clearDropMarks());
    chip.ondragover = (e) => markDrop(e, chip, 'chip');
    chip.ondragleave = () => chip.classList.remove('drop-before', 'drop-after', 'drop-into');
    chip.ondrop = (e) => dropOnChip(e, g);
    const box = h('div', { class: `tab-group ${g.collapsed ? 'collapsed' : ''}` }, chip, ...shown.map((t) => tabEl(t, g)));
    box.style.setProperty('--gc', colorOf(g)); // 이름표·색 줄·현재 탭 표시에 쓰는 그룹 색
    scroll.append(box);
  }
  const add = h('button', { class: 'tab-add', text: '＋', title: '프로젝트 열기 (새 탭) · 우클릭: 탭 그룹 메뉴' });
  add.onclick = () => repoMenu(add);
  add.oncontextmenu = (e) => (e.preventDefault(), barMenu(e.clientX, e.clientY));
  scroll.append(add);

  const fixed = h('div', { class: 'tab-fixed' });
  for (const g of closedGroups) fixed.append(chipEl(g, g.paths.length, () => reopenGroup(g)));
  const all = h('button', { class: 'tab-list-btn', title: '모든 프로젝트 목록 (Ctrl+Shift+E)' }, h('span', { text: '▾' }), h('span', { class: 'tab-list-n', text: tabs.length }));
  all.onclick = () => openProjectList(all);
  fixed.append(all);
  bar.append(scroll, fixed);

  // 휠: 탭 바에서는 가로로 스크롤
  scroll.onwheel = (e) => {
    if (scroll.scrollWidth <= scroll.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    scroll.scrollLeft += e.deltaY;
  };
  const fades = () => {
    scroll.classList.toggle('fade-l', scroll.scrollLeft > 2);
    scroll.classList.toggle('fade-r', scroll.scrollLeft + scroll.clientWidth < scroll.scrollWidth - 2);
  };
  scroll.onscroll = fades;
  // 탭 바 빈 곳 우클릭: 그룹 메뉴
  scroll.oncontextmenu = (e) => {
    if (e.target !== scroll) return;
    e.preventDefault();
    barMenu(e.clientX, e.clientY);
  };
  // 빈 곳에 놓으면 그룹에서 빼서 맨 뒤로
  scroll.ondragover = (e) => {
    if (!dragging) return;
    e.preventDefault();
    if (e.target === scroll) clearDropMarks();
  };
  scroll.ondrop = (e) => {
    if (e.target !== scroll || !dragging) return;
    e.preventDefault();
    clearDropMarks();
    const d = dragging;
    dragging = null;
    normalizeOrder();
    const list = d.group ? blockOf(d.group) : [d.tab];
    if (d.tab) setGroup(d.tab.path, null);
    for (const t of list) tabs.splice(tabs.indexOf(t), 1);
    tabs.push(...list);
    finishDrop();
  };
  // 자리가 모자라면: 먼저 탭을 줄이고(브랜치 이름 숨김) → 그래도 넘치면 스크롤. 지금 탭이 보이도록 이동
  requestAnimationFrame(() => {
    scroll.classList.remove('tight', 'tighter');
    if (scroll.scrollWidth > scroll.clientWidth) scroll.classList.add('tight');
    if (scroll.scrollWidth > scroll.clientWidth) scroll.classList.add('tighter');
    scroll.scrollLeft = keepLeft;
    const act = scroll.querySelector('.tab.active');
    if (act) {
      const a = act.getBoundingClientRect();
      const r = scroll.getBoundingClientRect();
      if (a.left < r.left + 24) scroll.scrollLeft -= r.left + 24 - a.left;
      else if (a.right > r.right - 24) scroll.scrollLeft += a.right - (r.right - 24);
    }
    fades();
  });
}

// ---------- 모든 프로젝트 목록 (탭이 많을 때: 그룹별로 보고, 검색해서 바로 이동) ----------
export async function openProjectList(anchor) {
  document.querySelector('.pl-pop')?.remove();
  // 닫은 탭: 최근에 연 프로젝트 중 지금 열려 있지 않고 닫힌 그룹에도 없는 것 (누르면 다시 열기)
  let recent = ((await window.api.getSettings()).recent || []).filter(
    (p) => !tabs.some((t) => norm(t.path) === norm(p)) && !loadGroups().some((g) => g.closed && inGroup(g, p))
  );
  anchor = anchor || document.querySelector('.tab-list-btn');
  const pop = h('div', { class: 'pl-pop' });
  const q = h('input', { class: 'input pl-q', placeholder: '프로젝트 이름으로 찾기 (Enter: 이동 · ↑↓ · Esc)', spellcheck: 'false' });
  const list = h('div', { class: 'pl-list' });
  pop.append(q, list);
  let items = [];
  let sel = 0;
  const close = () => {
    pop.remove();
    document.removeEventListener('mousedown', outside, true);
  };
  // 우클릭 메뉴(목록에서 지우기)를 누를 때는 닫지 않는다
  const outside = (e) => !pop.contains(e.target) && !e.target.closest?.('.ctx-menu') && e.target !== anchor && close();
  const go = (it) => {
    close();
    if (it.group) reopenGroup(it.group);
    else if (it.closedPath) openRepo(it.closedPath);
    else switchTab(it.tab.path);
  };
  const draw = () => {
    const f = q.value.trim().toLowerCase();
    const hit = (s) => !f || s.toLowerCase().includes(f);
    list.innerHTML = '';
    items = [];
    const section = (title, color) => list.append(h('div', { class: 'pl-sec' }, color ? h('span', { class: 'pl-dot', style: { background: color } }) : null, h('span', { text: title })));
    const row = (it, label, sub) => {
      const i = items.push(it) - 1;
      const el = h(
        'div',
        { class: `pl-row ${it.tab && isActive(it.tab) ? 'current' : ''} ${it.closedPath ? 'closed-tab' : ''}`, title: it.tab ? it.tab.path : it.closedPath ? `${it.closedPath}\n닫은 탭 — 누르면 다시 열기` : '' },
        h('span', { class: 'pl-name', text: label }),
        sub ? h('span', { class: 'pl-sub', text: sub }) : null
      );
      el.onmousemove = () => sel !== i && ((sel = i), mark());
      el.onclick = () => go(it);
      // 닫은 탭: 우클릭 → 목록에서 지우기 (기록만 지움. 프로젝트를 다시 열면 다시 생김)
      if (it.closedPath)
        el.oncontextmenu = (e) => {
          e.preventDefault();
          contextMenu(e.clientX, e.clientY, [
            { label: '다시 열기', onClick: () => go(it) },
            {
              label: '목록에서 지우기',
              danger: true,
              onClick: async () => {
                await window.api.removeRecent(it.closedPath);
                recent = recent.filter((p) => p !== it.closedPath);
                draw();
                q.focus();
              },
            },
          ]);
        };
      list.append(el);
    };
    for (const item of layout()) {
      if (item.tab) continue;
      const ts = item.tabs.filter((t) => hit(repoName(t.path)) || hit(groupLabel(item.group)));
      if (!ts.length) continue;
      section(`${groupLabel(item.group)}${item.group.collapsed ? ' (접힘)' : ''}`, colorOf(item.group));
      for (const t of ts) row({ tab: t }, repoName(t.path), t.status?.branch || '');
    }
    const loose = tabs.filter((t) => !groupOf(t.path) && hit(repoName(t.path)));
    // 닫은 탭은 검색하지 않을 때 최근 10개까지만
    const gone = recent.filter((p) => hit(repoName(p)) || (f && hit(p))).slice(0, f ? 50 : 10);
    if (loose.length || gone.length) {
      section('그룹 없는 탭');
      for (const t of loose) row({ tab: t }, repoName(t.path), t.status?.branch || '');
      for (const p of gone) row({ closedPath: p }, repoName(p), `닫힘 · ${p.split(/[\\/]/).slice(-2, -1)[0] || ''}`);
    }
    const closed = loadGroups().filter((g) => g.closed && (hit(groupLabel(g)) || g.paths.some((p) => hit(repoName(p)))));
    if (closed.length) {
      section('닫힌 그룹 (누르면 다시 열기)');
      for (const g of closed) row({ group: g }, `● ${groupLabel(g)}`, `${g.paths.length}개 · ${g.paths.map(repoName).join(', ')}`);
      list.querySelectorAll('.pl-row').forEach((el, i) => items[i].group && el.firstChild.style.setProperty('color', colorOf(items[i].group)));
    }
    if (!items.length) list.append(h('div', { class: 'pl-empty', text: '찾는 프로젝트가 없습니다.' }));
    sel = Math.max(0, items.findIndex((it) => it.tab && isActive(it.tab) && !f));
    mark();
  };
  const mark = () => {
    list.querySelectorAll('.pl-row').forEach((el, i) => el.classList.toggle('sel', i === sel));
    list.querySelectorAll('.pl-row')[sel]?.scrollIntoView({ block: 'nearest' });
  };
  q.oninput = () => {
    draw();
    sel = 0;
    mark();
  };
  q.onkeydown = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = Math.max(0, Math.min(items.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1)));
      mark();
    } else if (e.key === 'Enter' && items[sel]) go(items[sel]);
  };
  draw();
  document.body.append(pop);
  const r = anchor ? anchor.getBoundingClientRect() : { right: window.innerWidth - 8, bottom: 80 };
  pop.style.left = `${Math.max(8, r.right - pop.offsetWidth)}px`;
  pop.style.top = `${r.bottom + 4}px`;
  setTimeout(() => {
    q.focus();
    document.addEventListener('mousedown', outside, true);
  });
}

export function cacheTabStatus(s) {
  const t = tabs.find((x) => state.repo && norm(x.path) === norm(state.repo));
  if (t) {
    t.status = s;
    renderTabs();
  }
}

export async function switchTab(dir) {
  const { isBusy } = await import('./state.js');
  if (isBusy()) return toast('진행 중인 작업이 끝난 뒤에 탭을 바꿀 수 있습니다.', 'warn');
  const cur = tabs.find((x) => state.repo && norm(x.path) === norm(state.repo));
  if (cur) cur.view = state.view;
  const t = tabs.find((x) => norm(x.path) === norm(dir));
  if (!t) return;
  if (!(await window.api.exists(t.path))) {
    toast(`폴더를 찾을 수 없습니다: ${t.path}`, 'error');
    return closeTab(t.path);
  }
  state.repo = t.path;
  // 접힌 그룹 안의 탭으로 가면 그 그룹을 펼친다 (크롬처럼)
  const tg = groupOf(t.path);
  if (tg?.collapsed) (tg.collapsed = false), saveGroups();
  // 마지막으로 본 상태를 바로 보여주고(빠른 전환), 최신 상태는 onOpened 에서 새로 불러온다
  state.status = t.status || null;
  state.view = t.view || 'code';
  saveTabs();
  renderTabs();
  onOpened();
}

export async function closeTab(dir) {
  const { isBusy } = await import('./state.js');
  const i = tabs.findIndex((x) => norm(x.path) === norm(dir));
  if (i < 0) return;
  const closingActive = state.repo && norm(state.repo) === norm(dir);
  if (closingActive && isBusy()) return toast('진행 중인 작업이 끝난 뒤에 닫을 수 있습니다.', 'warn');
  tabs.splice(i, 1);
  if (closingActive && closingGroup) {
    // 그룹 닫기: 다른 탭으로 옮기지 않고 '선택 없음' (시작 화면)
    import('./lsp-client.js').then((m) => m.stopRepoServers(dir)).catch(() => {});
    state.repo = null;
    state.status = null;
    saveTabs();
    renderTabs();
    onOpened();
    return;
  }
  // 닫은 탭은 그룹에서도 뺀다 (빈 그룹은 사라짐). '그룹 닫기' 중에는 그룹이 기억해야 하므로 그대로 둔다
  if (!closingGroup && groupOf(dir)) (setGroup(dir, null), saveGroups());
  // 닫은 프로젝트의 언어 서버(특히 무거운 Java)를 끈다
  import('./lsp-client.js').then((m) => m.stopRepoServers(dir)).catch(() => {});
  if (closingActive) {
    const next = tabs[i] || tabs[i - 1];
    if (next) {
      state.repo = null;
      return switchTab(next.path).then(saveTabs);
    }
    state.repo = null;
    state.status = null;
    saveTabs();
    renderTabs();
    onOpened();
    return;
  }
  saveTabs();
  renderTabs();
}

export function cycleTab(dir) {
  const order = visibleOrder();
  if (order.length < 2) return;
  const i = order.findIndex((x) => norm(x.path) === norm(state.repo));
  switchTab(order[(i + dir + order.length) % order.length].path);
}

// 저장소를 탭으로 연다. 이미 열려 있으면 그 탭으로 이동.
export async function openRepo(dir, { activate = true } = {}) {
  const r = await window.api.openRepo(dir);
  if (!r.ok) {
    if (r.notRepo) {
      const ok = await confirmDialog(`'${dir}' 은(는) Git 저장소가 아닙니다.\n이 폴더에 새 Git 저장소를 만들까요?`, { title: '저장소 아님', okLabel: '새 저장소 만들기' });
      if (ok) return initRepo(dir);
      return;
    }
    return errorDialog(r.error);
  }
  state.settings = await window.api.getSettings();
  if (!tabs.some((x) => norm(x.path) === norm(r.data))) tabs.push({ path: r.data, view: 'code' });
  if (activate) return switchTab(r.data);
  saveTabs();
  renderTabs();
}


export async function pickAndOpen() {
  const dir = await window.api.pickFolder('Git 저장소 폴더 선택');
  if (dir) openRepo(dir);
}

async function initRepo(dir) {
  dir = dir || (await window.api.pickFolder('새 저장소를 만들 폴더 선택'));
  if (!dir) return;
  const r = await window.api.initRepo(dir);
  if (!r.ok) return errorDialog(r.error);
  toast('새 Git 저장소를 만들었습니다.', 'ok');
  openRepo(dir);
}

export async function cloneDialog() {
  const url = h('input', { class: 'input', placeholder: 'https://github.com/사용자/저장소.git', spellcheck: 'false' });
  const dir = h('input', { class: 'input', placeholder: '저장할 폴더', spellcheck: 'false' });
  const browse = h('button', { class: 'btn', text: '찾아보기...' });
  let parent = state.settings.cloneDir || '';
  const sync = async () => {
    const name = (url.value.trim().split('/').pop() || '').replace(/\.git$/, '');
    if (parent && name) dir.value = await window.api.joinPath(parent, name);
  };
  url.oninput = sync;
  browse.onclick = async () => {
    const p = await window.api.pickFolder('복제할 상위 폴더 선택');
    if (p) {
      parent = p;
      window.api.setSettings({ cloneDir: p });
      sync();
    }
  };
  const body = h('div', { class: 'form' }, h('label', { class: 'form-label', text: '저장소 URL' }), url, h('label', { class: 'form-label', text: '로컬 폴더' }), h('div', { class: 'row' }, dir, browse));
  modal({
    title: '저장소 복제 (Clone)',
    body,
    wide: true,
    buttons: [
      { label: '취소' },
      {
        label: '복제',
        primary: true,
        onClick: async (btn) => {
          if (!url.value.trim() || !dir.value.trim()) {
            toast('URL 과 폴더를 입력하세요.', 'warn');
            return false;
          }
          btn.disabled = true;
          btn.textContent = '복제 중...';
          const { busy } = await import('./state.js');
          const done = busy('복제 (Clone)');
          const r = await window.api.cloneRepo(url.value.trim(), dir.value.trim());
          done();
          if (!r.ok) {
            btn.disabled = false;
            btn.textContent = '복제';
            errorDialog(r.error, '복제 실패');
            return false;
          }
          toast('복제 완료', 'ok');
          openRepo(dir.value.trim());
        },
      },
    ],
  });
  setTimeout(() => url.focus(), 0);
}

function repoName(p) {
  return p.split(/[\\/]/).filter(Boolean).pop();
}

export async function repoMenu(anchor) {
  const s = await window.api.getSettings();
  const recent = (s.recent || []).filter((r) => !tabs.some((t) => norm(t.path) === norm(r)));
  const remotes = state.repo ? await git('remotes').catch(() => []) : [];
  const web = remotes.map((r) => ({ ...r, web: toWebUrl(r.url) })).filter((r) => r.web);
  menuAt(anchor, [
    state.repo ? { header: state.repo } : null,
    { label: '폴더 열기 (새 탭)...', hint: 'Ctrl+O', onClick: pickAndOpen },
    { label: '저장소 복제 (Clone)...', onClick: cloneDialog },
    { label: '새 저장소 만들기 (Init)...', onClick: () => initRepo() },
    state.repo ? '-' : null,
    state.repo ? { label: '탐색기에서 열기', onClick: () => window.api.openPath(state.repo) } : null,
    ...web.map((r) => ({ label: `웹에서 보기 (${r.name})`, onClick: () => window.api.openExternal(r.web) })),
    recent.length ? '-' : null,
    recent.length ? { header: '최근 저장소 (새 탭으로 열기)' } : null,
    ...recent.map((r) => ({ label: repoName(r), hint: r, onClick: () => openRepo(r) })),
  ]);
}

export function toWebUrl(url) {
  let m = url.match(/^git@([^:]+):(.+?)(\.git)?$/);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = url.match(/^https?:\/\/(?:[^@/]+@)?(.+?)(\.git)?$/);
  if (m) return `https://${m[1]}`;
  return null;
}

let recentShown = 5; // 시작 화면 최근 저장소: 처음 5개, '더 보기' 를 누를 때마다 5개씩
export async function renderWelcome() {
  const s = await window.api.getSettings();
  const el = $('#welcome');
  el.innerHTML = '';
  const all = s.recent || [];
  const recent = all.slice(0, recentShown).map((r) =>
    h(
      'div',
      { class: 'recent-item', onclick: () => openRepo(r), title: r },
      h('div', {}, h('b', { text: repoName(r) }), h('div', { class: 'fdir', text: r })),
      h('button', {
        class: 'tb-btn small',
        text: '✕',
        title: '목록에서 제거',
        onclick: async (e) => {
          e.stopPropagation();
          await window.api.removeRecent(r);
          renderWelcome();
        },
      })
    )
  );
  el.append(
    h(
      'div',
      { class: 'welcome-box' },
      h('div', { class: 'logo', html: '<span>Code</span>Flow' }),
      h('p', { class: 'sub', text: '보기 쉽고 간편한 Git 형상관리 도구' }),
      h(
        'div',
        { class: 'welcome-actions' },
        h('button', { class: 'big-btn', onclick: pickAndOpen }, h('span', { class: 'ico', text: '▣' }), h('b', { text: '저장소 열기' }), h('small', { text: '내 PC의 Git 폴더 열기' })),
        h('button', { class: 'big-btn', onclick: cloneDialog }, h('span', { class: 'ico', text: '⇣' }), h('b', { text: '복제 (Clone)' }), h('small', { text: 'GitHub 등에서 내려받기' })),
        h('button', { class: 'big-btn', onclick: () => initRepo() }, h('span', { class: 'ico', text: '＋' }), h('b', { text: '새 저장소' }), h('small', { text: '폴더를 Git 저장소로 만들기' }))
      ),
      recent.length
        ? h(
            'div',
            { class: 'recent' },
            h('div', { class: 'recent-title', text: `최근 저장소${all.length > 5 ? ` (${all.length}개)` : ''}` }),
            ...recent,
            all.length > recentShown
              ? h('button', {
                  class: 'recent-more',
                  text: `더 보기 (${Math.min(5, all.length - recentShown)}개 · 남은 ${all.length - recentShown}개)`,
                  onclick: () => {
                    recentShown += 5;
                    renderWelcome();
                  },
                })
              : null
          )
        : null
    )
  );
}

export async function openSettings() {
  const s = await window.api.getSettings();
  const cfg = state.repo ? await git('config').catch(() => ({})) : {};
  const remotes = state.repo ? await git('remotes').catch(() => []) : [];
  const name = h('input', { class: 'input', value: cfg.userName || '', placeholder: '홍길동' });
  const email = h('input', { class: 'input', value: cfg.userEmail || '', placeholder: 'me@example.com' });
  const global = h('input', { type: 'checkbox', checked: true });
  const rebase = h('input', { type: 'checkbox', checked: !!s.pullRebase });

  const remoteBox = h('div', { class: 'remote-box' });
  const drawRemotes = (list) => {
    remoteBox.innerHTML = '';
    if (!list.length) remoteBox.append(h('div', { class: 'empty small', text: '원격 저장소가 없습니다. GitHub 저장소 URL 을 추가하세요.' }));
    for (const r of list) {
      remoteBox.append(
        h(
          'div',
          { class: 'remote-row' },
          h('b', { text: r.name }),
          h('span', { class: 'fdir', text: r.url }),
          h('button', {
            class: 'tb-btn small',
            text: '수정',
            onclick: async () => {
              const url = await promptDialog(`'${r.name}' 의 URL`, { value: r.url, title: '원격 저장소 수정' });
              if (url) {
                await op('원격 수정', () => git('setRemoteUrl', r.name, url));
                drawRemotes(await git('remotes'));
              }
            },
          }),
          h('button', {
            class: 'tb-btn small danger',
            text: '삭제',
            onclick: async () => {
              if (await confirmDialog(`원격 저장소 '${r.name}' 연결을 제거합니다. (원격의 실제 데이터는 삭제되지 않습니다)`, { danger: true, okLabel: '제거' })) {
                await op('원격 삭제', () => git('removeRemote', r.name));
                drawRemotes(await git('remotes'));
              }
            },
          })
        )
      );
    }
  };
  drawRemotes(remotes);
  const addRemote = h('button', {
    class: 'btn small',
    text: '＋ 원격 저장소 추가',
    onclick: async () => {
      const url = await promptDialog('원격 저장소 URL', { title: '원격 저장소 추가', placeholder: 'https://github.com/사용자/저장소.git' });
      if (!url) return;
      const nm = remotes.length ? await promptDialog('원격 이름', { value: 'upstream' }) : 'origin';
      if (!nm) return;
      await op('원격 추가', () => git('addRemote', nm, url), { success: `'${nm}' 추가됨` });
      drawRemotes(await git('remotes'));
    },
  });

  const body = h(
    'div',
    { class: 'form settings' },
    state.repo ? h('h4', { text: '사용자 정보 (커밋 작성자)' }) : null,
    state.repo ? h('label', { class: 'form-label', text: '이름' }) : null,
    state.repo ? name : null,
    state.repo ? h('label', { class: 'form-label', text: '이메일' }) : null,
    state.repo ? email : null,
    state.repo ? h('label', { class: 'check' }, global, ' 모든 저장소에 적용 (global)') : null,
    state.repo ? h('h4', { text: '원격 저장소' }) : null,
    state.repo ? remoteBox : null,
    state.repo ? addRemote : null,
    h('h4', { text: '동작' }),
    h('label', { class: 'check' }, rebase, ' Pull 할 때 병합(merge) 대신 리베이스(rebase) 사용'),
    h('h4', { text: '언어 팩' }),
    await javaPackRow(),
    h('h4', { text: '앱 정보' }),
    h(
      'div',
      { class: 'row' },
      h('span', { text: `CodeFlow 버전 ${await window.api.appVersion()}` }),
      h('button', { class: 'btn small', text: '업데이트 확인', onclick: async () => (await import('./update.js')).checkForUpdatesNow() })
    )
  );
  modal({
    title: '설정',
    body,
    wide: true,
    buttons: [
      { label: '닫기' },
      {
        label: '저장',
        primary: true,
        onClick: async () => {
          state.settings = await window.api.setSettings({ pullRebase: rebase.checked });
          if (state.repo && (name.value !== (cfg.userName || '') || email.value !== (cfg.userEmail || '') || !global.checked)) {
            const r = await op('설정 저장', () => git('setConfig', { userName: name.value.trim(), userEmail: email.value.trim(), global: global.checked }));
            if (r && typeof r === 'symbol') return false;
          }
          toast('설정을 저장했습니다.', 'ok');
          refresh();
        },
      },
    ],
  });
}

// 설정 → 언어 팩: Java (TypeScript/JavaScript, Python 은 앱에 기본 포함)
async function javaPackRow() {
  const box = h('div', { class: 'lang-pack' });
  const draw = async () => {
    const st = await window.api.java.status();
    box.innerHTML = '';
    const info = h('div', { class: 'lp-info' });
    info.append(
      h('b', { text: 'Java' }),
      h('span', {
        class: 'fdir',
        text: st.installed
          ? ` 설치됨 (언어 서버 ${st.version}) · 실행 Java ${st.runtime?.version || '-'}${st.runtime?.bundled ? ' (언어 팩 포함)' : ''}`
          : ' 설치 안 됨 · 약 130MB · Java 파일을 열 때만 실행되며, 프로젝트 JDK 버전 기준으로 검사합니다',
      }),
      h('div', { class: 'fdir lp-jdks', text: st.jdks.length ? `찾은 JDK: ${st.jdks.map((j) => `${j.version}`).join(', ')}` : 'PC 에서 JDK 를 찾지 못했습니다 (프로젝트 기준 검사에 JDK 가 필요합니다)' })
    );
    const btn = st.installed
      ? h('button', {
          class: 'btn small danger',
          text: '제거',
          onclick: async () => {
            if (!(await confirmDialog('Java 언어 팩을 제거합니다. 저장된 프로젝트 색인도 함께 지워집니다.', { danger: true, okLabel: '제거' }))) return;
            const { removeJavaPack } = await import('./code.js');
            await removeJavaPack();
            draw();
          },
        })
      : h('button', {
          class: 'btn small primary',
          text: '설치',
          onclick: async (e) => {
            const b = e.currentTarget;
            b.disabled = true;
            const { installJavaPack } = await import('./code.js');
            try {
              // 다른 곳(코드 화면)에서 이미 설치 중이면 그 진행 상황을 이어서 보여 준다
              await installJavaPack((p) => (b.textContent = !p ? '설치 준비 중...' : p.step === 'download' && p.percent >= 0 ? `받는 중 ${p.percent}%` : p.message));
            } catch (err) {
              errorDialog(err.message, 'Java 언어 팩 설치 실패');
            }
            draw();
          },
        });
    box.append(info, btn);
  };
  await draw();
  return h('div', { class: 'form' }, h('div', { class: 'fdir', text: 'TypeScript/JavaScript, Python 코드 검사는 앱에 기본 포함되어 있습니다.' }), box);
}
