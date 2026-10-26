// 히스토리 화면: 브랜치 트리 + 커밋 그래프 + 커밋 상세/Diff
import { $, h, esc, fmtDate, splitPath, STATUS_LABEL, contextMenu, menuAt, confirmDialog, choiceDialog, promptDialog, splitter, toast, modal } from './ui.js';
import { state, git, op, onRefresh } from './state.js';
import { renderDiff, emptyDiff } from './diff.js';
import { branchMenuItems, newBranch, checkout, checkoutRemote, updateBranches } from './branches.js';
import { initIssues, refreshIssues } from './issues.js';

const PAGE = 400;
const ROW_H = 26;
const LANE_W = 14;
const COLORS = ['#4e9bf5', '#e5a42b', '#5fb865', '#d9636b', '#a77ee8', '#3fbdb0', '#e07fc0', '#9aa64a'];

// refs: 히스토리에 표시할 브랜치들 (VS Code 처럼 '모든 브랜치' 또는 각각 선택)
// '@ALL' 은 모든 브랜치, '@HEAD' 는 현재 체크아웃한 브랜치
const ALL = '@ALL';
const CUR = '@HEAD';
const filter = { refs: [ALL], file: null, search: '', issue: null }; // issue: { number, title } — 이슈 목록에서 고른 이슈
const isAll = () => filter.refs.includes(ALL);
const gitRefs = () => (isAll() ? [] : filter.refs.map((r) => (r === CUR ? 'HEAD' : r)));
// 배지 비교용 이름: '@HEAD' → 현재 브랜치 이름
const refNames = () => filter.refs.map((r) => (r === CUR ? state.status?.branch || 'HEAD' : r));
let allCommits = []; // 불러온 전체 커밋
let commits = []; // 화면에 보이는 커밋 (공통 이력 숨기기 적용 후)
let graph = [];

let selectedHash = null;
let selectedFile = null;
const multi = new Set(); // Ctrl/Shift 로 여러 개 선택한 커밋
let anchor = null;
let root;
let dirty = true;
let boundRepo = null;
let inHead = null; // 현재 브랜치(HEAD)에 포함된 커밋 해시 집합

// 보기 옵션 (IntelliJ 기본값과 동일: 날짜순 + 병합 커밋은 회색)
const viewOpt = {
  order: localStorage.getItem('log.order') || 'date',
  dimMerges: localStorage.getItem('log.dimMerges') !== '0',
  dimOthers: localStorage.getItem('log.dimOthers2') === '1',
};

export function initLog() {
  root = $('#view-log');
  root.innerHTML = `
    <div class="log-side" id="logSide">
      <div class="log-branches" id="logBranches"></div>
      <div class="splitter-y" id="logSplitIssues"></div>
      <div class="log-issues" id="logIssues"></div>
    </div>
    <div class="splitter-x" id="logSplitBranches"></div>
    <div class="log-main">
      <div class="panel-bar">
        <input class="input small" id="logSearch" placeholder="커밋 메시지 검색" spellcheck="false">
        <span id="logFilterInfo" class="filter-chip" hidden></span>
        <span class="tb-spacer"></span>
        <span class="hint-sel" id="logMultiInfo"></span>
        <button class="tb-btn small" id="logView" title="정렬 / 강조 방식">👁 보기 ▾</button>
        <button class="tb-btn small" id="logReflog" title="HEAD 이동 기록 (실수로 잃어버린 커밋 찾기)">↺ Reflog</button>
        <button class="tb-btn small" id="logReload" title="새로고침">⟳</button>
      </div>
      <div class="log-table-wrap" id="logTableWrap">
        <div class="log-table" id="logTable"></div>
      </div>
      <div class="splitter-y" id="logSplitDetail"></div>
      <div class="log-detail" id="logDetail">
        <div class="log-detail-files" id="logDetailFiles"></div>
        <div class="splitter-x" id="logSplitFiles"></div>
        <div class="log-detail-diff" id="logDetailDiff"></div>
      </div>
    </div>`;
  splitter($('#logSplitBranches'), $('#logSide'), { min: 160, max: 600, key: 'logBranches' });
  // 브랜치 아래 이슈 패널 (위아래 크기 조절, 접기)
  initIssues($('#logIssues'), $('#logSplitIssues'));
  splitter($('#logSplitDetail'), $('#logDetail'), { axis: 'y', min: 120, max: 900, invert: true, key: 'logDetail' });
  splitter($('#logSplitFiles'), $('#logDetailFiles'), { min: 220, max: 800, key: 'logFiles' });

  let t;
  $('#logSearch').oninput = (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      filter.search = e.target.value.trim();
      load();
    }, 300);
  };
  $('#logReload').onclick = () => load();

  $('#logView').onclick = (e) => {
    const set = (k, v) => {
      viewOpt[k] = v;
      const key = { order: 'log.order', dimMerges: 'log.dimMerges', dimOthers: 'log.dimOthers2' }[k];
      localStorage.setItem(key, typeof v === 'boolean' ? (v ? '1' : '0') : v);
      k === 'order' ? load() : renderTable();
    };
    menuAt(e.currentTarget, [
      { header: '정렬' },
      { label: `${viewOpt.order === 'date' ? '✓ ' : '　'}커밋 날짜순 (IntelliJ 기본)`, onClick: () => set('order', 'date') },
      { label: `${viewOpt.order === 'topo' ? '✓ ' : '　'}브랜치별로 묶어서 (토폴로지)`, onClick: () => set('order', 'topo') },
      '-',
      { header: '강조' },
      { label: `${viewOpt.dimMerges ? '✓ ' : '　'}병합(Merge) 커밋은 회색으로 (IntelliJ 기본)`, onClick: () => set('dimMerges', !viewOpt.dimMerges) },
      { label: `${viewOpt.dimOthers ? '✓ ' : '　'}현재 브랜치에 없는 커밋도 회색으로`, onClick: () => set('dimOthers', !viewOpt.dimOthers) },
    ]);
  };
  $('#logReflog').onclick = async () => (await import('./reflog.js')).openReflog();
  $('#logTableWrap').addEventListener('keydown', onKey);
  emptyDiff($('#logDetailDiff'), '커밋을 선택하고 파일을 클릭하면 변경 내용이 표시됩니다.');

  onRefresh(() => {
    dirty = true;
    if (state.view === 'log') load();
  });
}

export function activateLog() {
  refreshIssues();
  if (dirty || boundRepo !== state.repo) load();
}

// 이슈 목록에서 이슈를 누르면: 그 이슈를 언급한 커밋만 보기 (다시 누르거나 ✕ 로 해제)
export function filterByIssue(issue) {
  filter.issue = issue ? { number: issue.number, title: issue.title } : null;
  filter.file = null;
  load();
}
export const currentIssueFilter = () => filter.issue;

export function showFileHistory(path) {
  filter.file = path;
  document.querySelector('.rail-btn[data-view="log"]')?.click();
  load();
}

function setFilterChip() {
  const chip = $('#logFilterInfo');
  chip.hidden = false;
  chip.innerHTML = '';
  if (filter.file) {
    chip.append(h('span', { text: `파일: ${filter.file}` }), h('button', { class: 'chip-x', text: '✕', title: '파일 필터 해제', onclick: () => ((filter.file = null), load()) }));
    return;
  }
  if (filter.issue) {
    chip.append(
      h('span', { text: `이슈 #${filter.issue.number} 관련 커밋`, title: filter.issue.title }),
      h('button', { class: 'chip-x', text: '✕', title: '이슈 필터 해제', onclick: () => (filterByIssue(null), window.dispatchEvent(new Event('issue-filter-changed'))) })
    );
    return;
  }
  if (isAll()) {
    chip.hidden = true;
    return;
  }
  chip.append(h('span', { text: `보는 브랜치: ${refNames().join(' + ')}` }));
  chip.append(h('button', { class: 'chip-x', text: '✕', title: '모든 브랜치 보기', onclick: () => ((filter.refs = [ALL]), load()) }));
}

// 저장소(탭)별로 마지막 히스토리 화면을 기억해 두었다가 탭을 옮기면 바로 보여준다
const perRepo = new Map();
let loadSeq = 0;

function saveRepoView() {
  if (!boundRepo) return;
  perRepo.set(boundRepo, {
    refs: filter.refs,
    file: filter.file,
    search: filter.search,
    issue: filter.issue,
    // 이 저장소 이력을 끝까지 받은 적이 있을 때만 기억 (도중에 탭을 옮긴 빈 목록은 기억하지 않음)
    allCommits: loadedRepo === boundRepo ? allCommits : perRepo.get(boundRepo)?.allCommits || null,
    br: loadedRepo === boundRepo ? lastBr : perRepo.get(boundRepo)?.br || null,
    selectedHash,
    selectedFile,
  });
}
let lastBr = null;
let loadedRepo = null; // 현재 화면의 이력이 어느 저장소 것인지

function showCommits(list, br) {
  allCommits = list;
  lastBr = br;
  applyCompare();
  renderBranches(br);
  renderTable();
  if (selectedHash && commits.some((c) => c.hash === selectedHash)) selectCommit(selectedHash, false);
  else if (commits.length) selectCommit(commits[0].hash, false);
  else {
    $('#logDetailFiles').innerHTML = '';
    emptyDiff($('#logDetailDiff'), '커밋이 없습니다.');
  }
}

async function load() {
  if (!state.repo) return;
  const repo = state.repo;
  const seq = ++loadSeq;
  if (boundRepo !== repo) {
    // 다른 저장소(탭)로 바뀜: 이전 저장소 화면을 기억하고, 이 저장소의 기억해 둔 화면을 즉시 표시
    saveRepoView();
    boundRepo = repo;
    multi.clear();
    const saved = perRepo.get(repo);
    filter.refs = saved?.refs || [ALL];
    filter.file = saved?.file || null;
    filter.search = saved?.search || '';
    filter.issue = saved?.issue || null;
    $('#logSearch').value = filter.search;
    selectedHash = saved?.selectedHash || null;
    selectedFile = saved?.selectedFile || null;
    loadedRepo = null;
    if (saved?.allCommits) {
      setFilterChip();
      showCommits(saved.allCommits, saved.br);
      loadedRepo = repo;
    } else {
      // 처음 보는 저장소: 이전 저장소 이력이 남지 않게 바로 비우고 '불러오는 중' 표시
      allCommits = [];
      commits = [];
      $('#logBranches').innerHTML = '';
      $('#logTable').innerHTML = '<div class="loading-note"><span class="spinner"></span> 히스토리를 불러오는 중...</div>';
      $('#logDetailFiles').innerHTML = '';
      emptyDiff($('#logDetailDiff'), '');
    }
  }
  dirty = false;
  setFilterChip();
  const slow = setTimeout(() => {
    if (seq === loadSeq && !allCommits.length) $('#logTable').innerHTML = '<div class="loading-note"><span class="spinner"></span> 히스토리를 불러오는 중...</div>';
  }, 250);
  try {
    const logP = git('log', { limit: PAGE, refs: gitRefs(), file: filter.file, search: filter.search, issue: filter.issue?.number, order: viewOpt.order });
    logP.catch(() => {}); // 아래에서 await 하며 처리 (먼저 실패해도 경고가 뜨지 않게)
    // 브랜치 목록은 빠르므로 이력을 기다리지 않고 바로 다시 그린다 (삭제/생성/이름 변경이 즉시 보이도록)
    const br = await git('branches');
    if (seq !== loadSeq || state.repo !== repo) return;
    lastBr = br;
    renderBranches(br);
    const list = await logP;
    // 그 사이 탭이 바뀌었거나 더 새로운 요청이 있으면 이 결과는 버린다 (이전 프로젝트 이력이 덮어쓰는 문제 방지)
    if (seq !== loadSeq || state.repo !== repo) return;
    showCommits(list, br);
    loadedRepo = repo;
    saveRepoView();
  } catch (e) {
    if (seq !== loadSeq || state.repo !== repo) return;
    $('#logTable').innerHTML = `<div class="empty">히스토리를 불러오지 못했습니다: ${esc(e.message)}</div>`;
  } finally {
    clearTimeout(slow);
  }
}

async function loadMore() {
  const repo = state.repo;
  const seq = loadSeq;
  const more = await git('log', { limit: PAGE, skip: allCommits.length, refs: gitRefs(), file: filter.file, search: filter.search, issue: filter.issue?.number, order: viewOpt.order });
  if (seq !== loadSeq || state.repo !== repo) return;
  allCommits = allCommits.concat(more);
  applyCompare();
  renderTable();
}

// ---------- 브랜치 트리 ----------

let selectMode = false; // '골라 보기' 모드 (체크박스 표시)
let anchorKey = null; // Shift+클릭 범위 선택의 시작점

// 원격 추적 상태 표시: ↑보낼 커밋, ↓받을 커밋, gone → 원격에 없음
// (gone 은 '한 번도 Push 안 함' 과 '원격에서 지워짐' 을 구분할 수 없다)
function trackHint(b) {
  if (b.track.includes('gone'))
    return {
      hint: b.current ? '원격에 없음 · Push 필요' : '원격에 없음',
      hintClass: 'gone',
      hintTitle: `연결된 원격 브랜치(${b.upstream || ''})가 원격 저장소에 없습니다.
- 아직 한 번도 Push 하지 않았다면: Push 하면 원격에 새로 만들어집니다.
- MR 병합 때 '소스 브랜치 삭제'로 지워졌다면: 로컬 브랜치와 커밋은 그대로 있으며, 이미 병합된 작업이면 삭제해도 됩니다.`,
    };
  const hint = b.track.replace('ahead ', '↑').replace('behind ', '↓').replace(/[[\],]/g, '');
  return { hint, hintTitle: hint ? '↑ Push 할 커밋 수 / ↓ Pull 로 받을 커밋 수' : '' };
}

function renderBranches(br) {
  const el = $('#logBranches');
  // 접어 둔 그룹은 다시 그려도 접힌 채로 유지
  const collapsed = new Set([...el.querySelectorAll('.tree-group.collapsed')].map((g) => g.dataset.title));
  el.innerHTML = '';
  // 현재 브랜치는 '@HEAD' 로 다룬다 (체크아웃을 바꾸면 자동으로 따라감)
  const key = (ref, opts) => (opts.current ? CUR : ref);
  const isSel = (ref, opts) => !isAll() && (filter.refs.includes(key(ref, opts)) || (opts.current && filter.refs.includes(ref)));
  const item = (label, ref, opts = {}) => {
    const selected = isSel(ref, opts);
    // 체크박스는 '골라 보기' 모드에서만 보인다
    const chk = selectMode ? h('input', { type: 'checkbox', checked: selected, title: '이 브랜치를 함께 보기' }) : null;
    const row = h(
      'div',
      { class: `tree-item ${selected && !filter.file ? 'active' : ''} ${opts.current ? 'current' : ''}`, title: opts.title || label },
      chk,
      h('span', { class: 'ti-ico', text: opts.ico || '⑂' }),
      h('span', { class: 'ti-name', text: label }),
      opts.hint ? h('span', { class: `ti-hint ${opts.hintClass || ''}`, text: opts.hint, title: opts.hintTitle || '' }) : null
    );
    const toggle = () => {
      const k = key(ref, opts);
      const cur = filter.refs.filter((r) => r !== ALL);
      if (selected) filter.refs = cur.filter((r) => r !== k && !(opts.current && r === ref));
      else filter.refs = [...cur, k];
      if (!filter.refs.length) filter.refs = [ALL];
      filter.file = null;
      load();
    };
    if (chk)
      chk.onclick = (e) => {
        e.stopPropagation();
        toggle();
      };
    row.onclick = (e) => {
      // Shift+클릭: 같은 그룹에서 시작점부터 여기까지 여러 개 선택 (함께 보기 + 우클릭으로 한꺼번에 작업)
      if (e.shiftKey && opts.groupKeys && anchorKey && opts.groupKeys.includes(anchorKey)) {
        const a = opts.groupKeys.indexOf(anchorKey);
        const b = opts.groupKeys.indexOf(key(ref, opts));
        filter.refs = opts.groupKeys.slice(Math.min(a, b), Math.max(a, b) + 1);
        filter.file = null;
        return load();
      }
      anchorKey = key(ref, opts);
      // 골라 보기 모드 또는 Ctrl+클릭: 하나씩 더하거나 빼기
      if (selectMode || e.ctrlKey || e.metaKey) return toggle();
      // 그냥 클릭: 이 브랜치만 보기
      filter.refs = [key(ref, opts)];
      filter.file = null;
      load();
    };
    // 체크아웃은 우클릭 메뉴에서만 (더블클릭으로 실수로 바뀌지 않게)
    if (opts.kind) {
      row.oncontextmenu = (e) => {
        e.preventDefault();
        // 여러 로컬 브랜치를 선택한 상태에서 그중 하나를 우클릭: 선택한 브랜치들에 한꺼번에
        const selLocal = selectedLocal(br);
        if (opts.kind === 'local' && selLocal.length > 1 && selLocal.includes(opts.branch.name)) return contextMenu(e.clientX, e.clientY, multiBranchMenu(selLocal, br));
        contextMenu(e.clientX, e.clientY, branchMenuItems(opts.branch, opts.kind));
      };
    }
    return row;
  };
  const group = (title, children) => {
    if (!children.length) return;
    const isCollapsed = collapsed.has(title);
    const g = h('div', { class: `tree-group ${isCollapsed ? 'collapsed' : ''}`, 'data-title': title });
    const head = h('div', { class: 'tree-head', text: `${isCollapsed ? '▸' : '▾'} ${title}` });
    const body = h('div', { hidden: isCollapsed }, ...children);
    head.onclick = () => {
      body.hidden = !body.hidden;
      g.classList.toggle('collapsed', body.hidden);
      head.textContent = `${body.hidden ? '▸' : '▾'} ${title}`;
    };
    g.append(head, body);
    el.append(g);
  };
  // 모든 브랜치 (VS Code 의 All) + 오른쪽 '골라 보기' 버튼
  const pickBtn = h('button', {
    class: `tb-btn small pick-btn ${selectMode ? 'on' : ''}`,
    text: selectMode ? '✓ 골라 보기' : '☐ 골라 보기',
    title: selectMode ? '골라 보기 끝내기 (체크박스 숨기기)' : '체크박스로 원하는 브랜치들만 묶어서 보기',
    onclick: (e) => {
      e.stopPropagation();
      selectMode = !selectMode;
      renderBranches(br);
    },
  });
  const allRow = h(
    'div',
    { class: `tree-item all-row ${isAll() && !filter.file ? 'active' : ''}`, title: '모든 브랜치의 이력을 함께 봅니다' },
    selectMode ? h('input', { type: 'checkbox', checked: isAll() }) : null,
    h('span', { class: 'ti-ico', text: '◎' }),
    h('span', { class: 'ti-name', text: '모든 브랜치' }),
    pickBtn
  );
  if (selectMode) el.append(h('div', { class: 'tree-tip', text: '보고 싶은 브랜치를 체크하세요. 체크한 브랜치들의 이력만 함께 보입니다.' }));
  allRow.onclick = () => {
    filter.refs = [ALL];
    filter.file = null;
    load();
  };
  el.prepend(allRow);
  if (state.status?.detached) el.append(item(`HEAD (${state.status.headShort})`, CUR, { ico: '●', current: true, title: '분리된 HEAD (특정 커밋을 체크아웃한 상태)' }));
  const localKeys = br.local.map((b) => (b.current ? CUR : b.name));
  group(
    '로컬',
    br.local.map((b) =>
      item(b.name, b.name, {
        kind: 'local',
        branch: b,
        current: b.current,
        groupKeys: localKeys,
        ico: b.current ? '★' : '⑂',
        ...trackHint(b),
        title: `${b.name}${b.upstream ? ` → ${b.upstream}` : ''}\n우클릭: 체크아웃·업데이트(Pull) 등\nCtrl+클릭 / Shift+클릭: 여러 개 선택`,
      })
    )
  );
  const byRemote = {};
  for (const b of br.remote) (byRemote[b.name.split('/')[0]] ||= []).push(b);
  for (const [remote, list] of Object.entries(byRemote)) {
    const keys = list.map((b) => b.name);
    group(
      `원격: ${remote}`,
      list.map((b) => item(b.name.slice(remote.length + 1), b.name, { kind: 'remote', branch: b, groupKeys: keys, title: `${b.name}\n우클릭: 체크아웃 등` }))
    );
  }
  group(
    '태그',
    br.tags.map((b) => item(b.name, b.name, { kind: 'tag', branch: b, ico: '⌂' }))
  );
}

// 지금 선택(함께 보기)된 로컬 브랜치 이름들
function selectedLocal(br) {
  if (isAll()) return [];
  return br.local.filter((b) => filter.refs.includes(b.name) || (b.current && filter.refs.includes(CUR))).map((b) => b.name);
}

function multiBranchMenu(names, br) {
  const withUp = names.filter((n) => br.local.find((b) => b.name === n)?.upstream);
  return [
    { header: `선택한 로컬 브랜치 ${names.length}개` },
    { label: `모두 업데이트 (Pull)${withUp.length < names.length ? ` — 원격 연결된 ${withUp.length}개` : ''}`, disabled: !withUp.length, onClick: () => updateBranches(withUp) },
    '-',
    {
      label: '선택 해제',
      onClick: () => {
        filter.refs = [ALL];
        load();
      },
    },
  ];
}

// ---------- 그래프 ----------

function computeGraph(list) {
  let lanes = [];
  const out = [];
  for (const c of list) {
    let idx = lanes.indexOf(c.hash);
    const fresh = idx < 0; // 브랜치 끝(위에서 내려오는 선 없음)
    if (fresh) {
      idx = lanes.indexOf(null);
      if (idx < 0) idx = lanes.length;
    }
    const before = lanes.slice();
    if (fresh) lanes[idx] = c.hash;
    const converge = [];
    before.forEach((hsh, j) => {
      if (hsh === c.hash && j !== idx) {
        converge.push(j);
        lanes[j] = null;
      }
    });
    lanes[idx] = c.parents[0] || null;
    const parentLanes = [];
    if (c.parents[0]) parentLanes.push(idx);
    for (const p of c.parents.slice(1)) {
      let k = lanes.indexOf(p);
      if (k < 0) {
        k = lanes.indexOf(null);
        if (k < 0) k = lanes.length;
        lanes[k] = p;
      }
      parentLanes.push(k);
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    out.push({ idx, before, after: lanes.slice(), converge, parentLanes });
  }
  return out;
}

function graphSvg(g, width) {
  const x = (i) => i * LANE_W + LANE_W / 2 + 2;
  const mid = ROW_H / 2;
  const col = (i) => COLORS[i % COLORS.length];
  let s = '';
  // 위에서 내려오는 선
  g.before.forEach((hsh, j) => {
    if (!hsh) return;
    if (j === g.idx || g.converge.includes(j)) {
      s += curve(x(j), 0, x(g.idx), mid, col(j));
    } else if (g.after[j] === hsh) {
      s += `<line x1="${x(j)}" y1="0" x2="${x(j)}" y2="${ROW_H}" stroke="${col(j)}" stroke-width="2"/>`;
    } else {
      // 레인이 비워지는 경우(드묾): 중간까지만
      s += `<line x1="${x(j)}" y1="0" x2="${x(j)}" y2="${mid}" stroke="${col(j)}" stroke-width="2"/>`;
    }
  });
  // 노드에서 부모로 내려가는 선
  for (const k of g.parentLanes) s += curve(x(g.idx), mid, x(k), ROW_H, col(k));
  // 새로 생긴 레인(이 커밋 이전에는 없던 것) 중 이 노드와 무관한 것은 없음
  const merge = g.parentLanes.length > 1;
  s += `<circle cx="${x(g.idx)}" cy="${mid}" r="${merge ? 4 : 4.5}" fill="${merge ? 'var(--bg)' : col(g.idx)}" stroke="${col(g.idx)}" stroke-width="2"/>`;
  return `<svg width="${width}" height="${ROW_H}" class="graph">${s}</svg>`;
}

function curve(x1, y1, x2, y2, color) {
  if (x1 === x2) return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="2"/>`;
  const my = (y1 + y2) / 2;
  return `<path d="M${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="2"/>`;
}

// ---------- 커밋 목록 ----------

// IntelliJ 처럼 같은 커밋을 가리키는 로컬/원격 브랜치는 "origin & master" 하나로 합쳐 표시
function refBadges(refs) {
  let head = null;
  const locals = [];
  const remotes = [];
  const tags = [];
  for (const r of refs) {
    if (r.startsWith('HEAD -> ')) {
      head = r.slice(8);
      locals.push(head);
    } else if (r === 'HEAD') head = 'HEAD';
    else if (r.startsWith('tag: ')) tags.push(r.slice(5));
    else if (r.endsWith('/HEAD')) continue;
    else if (r.includes('/') && !locals.includes(r)) remotes.push(r);
    else locals.push(r);
  }
  // 이름에 '/' 가 들어간 로컬 브랜치(feature/x)와 원격 브랜치를 구분: 원격 목록은 원격 이름으로 시작
  const used = new Set();
  let html = '';
  for (const l of locals) {
    const pair = remotes.filter((r) => r.slice(r.indexOf('/') + 1) === l);
    pair.forEach((r) => used.add(r));
    const label = pair.length ? `${pair.map((r) => r.slice(0, r.indexOf('/'))).join(', ')} & ${l}` : l;
    html += `<span class="ref ${l === head ? 'head' : 'local'}" title="${esc([l, ...pair].join(', '))}">${l === head ? '● ' : ''}${esc(label)}</span>`;
  }
  if (head === 'HEAD') html = `<span class="ref head">HEAD</span>` + html;
  for (const r of remotes) if (!used.has(r)) html += `<span class="ref remote">${esc(r)}</span>`;
  for (const t of tags) html += `<span class="ref tag">⌂ ${esc(t)}</span>`;
  return html;
}

// 브랜치 하나만 골라서 볼 때는 그 브랜치(와 짝이 되는 원격/로컬 브랜치) 배지만 남긴다.
// 다른 브랜치 배지는 "그 브랜치가 여기서 끝남" 표시라 단일 브랜치 화면에서는 헷갈리기만 한다.
function visibleRefs(refs) {
  if (isAll()) return refs;
  const short = (n) => n.replace(/^[^/]+\//, ''); // origin/x → x
  const names = new Set(refNames().flatMap((n) => [n, short(n)]));
  return refs.filter((r) => {
    if (r === 'HEAD') return filter.refs.includes(CUR);
    const name = r.startsWith('HEAD -> ') ? r.slice(8) : r.startsWith('tag: ') ? r.slice(5) : r;
    return names.has(name) || (name.includes('/') && names.has(short(name)));
  });
}

// HEAD 에서 부모를 따라가며 현재 브랜치에 포함된 커밋을 표시 (불러온 범위 안에서)
function computeInHead() {
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const head = commits.find((c) => c.refs.some((r) => r === 'HEAD' || r.startsWith('HEAD -> ')));
  if (!head) return null;
  const set = new Set();
  const stack = [head.hash];
  while (stack.length) {
    const h = stack.pop();
    if (set.has(h)) continue;
    set.add(h);
    const c = byHash.get(h);
    if (c) stack.push(...c.parents);
  }
  return set;
}

function applyCompare() {
  commits = allCommits;
  graph = filter.file ? null : computeGraph(commits);
}

function renderTable() {
  const table = $('#logTable');
  if (!commits.length) {
    table.innerHTML = `<div class="empty">${
      filter.issue
        ? `이슈 #${filter.issue.number} 을(를) 언급한 커밋이 없습니다.<br><span class="hint">커밋 메시지에 #${filter.issue.number} 를 적거나, 이슈 번호로 시작하는 브랜치(${filter.issue.number}-…)를 병합하면 여기에 보입니다.</span>`
        : filter.search
          ? '검색 결과가 없습니다.'
          : '커밋이 없습니다. 첫 커밋을 만들어 보세요.'
    }</div>`;
    return;
  }
  const maxLanes = graph ? Math.max(1, ...graph.map((g) => Math.max(g.before.length, g.after.length, g.idx + 1))) : 0;
  const gw = Math.min(maxLanes, 20) * LANE_W + 6;
  inHead = viewOpt.dimOthers && !filter.file ? computeInHead() : null;
  let html = '';
  commits.forEach((c, i) => {
    // IntelliJ 처럼 병합 커밋(부모 2개 이상)은 회색, 일반 커밋은 흰색
    const isMerge = viewOpt.dimMerges && c.parents.length > 1;
    const notInHead = inHead && !inHead.has(c.hash);
    const other = isMerge || notInHead;
    const tip = isMerge ? '병합(Merge) 커밋' : notInHead ? '현재 브랜치에 포함되지 않은 커밋' : '';
    html += `<div class="log-row ${c.hash === selectedHash ? 'sel' : ''} ${other ? 'other' : ''}" data-i="${i}" ${tip ? `title="${tip}"` : ''}>
      ${graph ? `<div class="c-graph" style="width:${gw}px">${graphSvg(graph[i], gw)}</div>` : ''}
      <div class="c-subj">${refBadges(visibleRefs(c.refs))}<span class="subj">${esc(c.subject)}</span></div>
      <div class="c-author">${esc(c.author)}</div>
      <div class="c-date">${esc(fmtDate(c.time))}</div>
      <div class="c-hash">${c.hash.slice(0, 8)}</div>
    </div>`;
  });
  if (allCommits.length && allCommits.length % PAGE === 0) html += `<div class="log-more"><button class="btn" id="logMore">더 불러오기</button></div>`;
  table.innerHTML = html;
  $('#logMore')?.addEventListener('click', loadMore);
  table.onclick = (e) => {
    const row = e.target.closest('.log-row');
    if (!row) return;
    const i = +row.dataset.i;
    const c = commits[i];
    if (e.ctrlKey) {
      if (!multi.size && selectedHash) multi.add(selectedHash);
      multi.has(c.hash) ? multi.delete(c.hash) : multi.add(c.hash);
      anchor = i;
    } else if (e.shiftKey && anchor !== null) {
      multi.clear();
      const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
      for (let k = a; k <= b; k++) multi.add(commits[k].hash);
    } else {
      multi.clear();
      anchor = i;
    }
    if (multi.size === 1) multi.clear();
    // 여러 개를 골랐으면 아래에 선택한 커밋 목록 + 합친 변경 파일(중복 없이)
    if (multi.size > 1) {
      selectedHash = c.hash;
      markRows(); // 고른 줄들 표시
      showMultiDetail();
    } else selectCommit(c.hash);
  };
  table.oncontextmenu = (e) => {
    const row = e.target.closest('.log-row');
    if (!row) return;
    e.preventDefault();
    const c = commits[+row.dataset.i];
    if (multi.size > 1 && multi.has(c.hash)) {
      contextMenu(e.clientX, e.clientY, multiMenu());
      return;
    }
    multi.clear();
    selectCommit(c.hash);
    contextMenu(e.clientX, e.clientY, commitMenu(c));
  };
}

function onKey(e) {
  if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
  e.preventDefault();
  const i = commits.findIndex((c) => c.hash === selectedHash);
  const n = Math.max(0, Math.min(commits.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
  selectCommit(commits[n].hash);
  $(`#logTable .log-row[data-i="${n}"]`)?.scrollIntoView({ block: 'nearest' });
}

function commitMenu(c) {
  const cur = state.status?.branch || 'HEAD';
  const short = c.hash.slice(0, 8);
  return [
    { header: `${short} ${c.subject.slice(0, 40)}` },
    { label: '해시 복사', onClick: () => window.api.copy(c.hash) },
    { label: '메시지 복사', onClick: () => window.api.copy(c.subject) },
    '-',
    { label: '이 커밋 체크아웃 (분리된 HEAD)', onClick: () => checkout(c.hash) },
    { label: '여기서 새 브랜치...', onClick: () => newBranch(c.hash) },
    { label: '태그 생성...', onClick: () => createTag(c) },
    '-',
    { label: '커밋 되돌리기 (Revert) — 반대 커밋 생성', onClick: () => revert(c) },
    { label: `현재 브랜치(${cur})에 체리픽`, onClick: () => cherryPick(c) },
    { label: `'${cur}' 을(를) 여기로 리셋...`, danger: true, onClick: () => resetTo(c) },
    '-',
    { label: '여기부터 커밋 편집 (대화형 리베이스)...', onClick: async () => (await import('./rebase.js')).openInteractiveRebase(c.hash) },
    { label: '현재 작업 위치(HEAD)와 비교', onClick: async () => (await import('./compare.js')).openCompare(c.hash, 'HEAD') },
  ];
}

// 여러 커밋 선택 시 메뉴
function multiMenu() {
  const sel = commits.filter((c) => multi.has(c.hash)); // 최신 → 오래된 순서
  const hasMerge = sel.some((c) => c.parents.length > 1);
  const idx = sel.map((c) => commits.indexOf(c));
  const contiguous = idx.every((v, k) => k === 0 || v === idx[k - 1] + 1);
  const cur = state.status?.branch || 'HEAD';
  return [
    { header: `${sel.length}개 커밋 선택됨` },
    { label: `현재 브랜치(${cur})에 체리픽 (${sel.length}개, 오래된 순서로)`, disabled: hasMerge, onClick: () => cherryPickMany(sel) },
    { label: `모두 되돌리기 (Revert ${sel.length}개, 최신 순서로)`, disabled: hasMerge, onClick: () => revertMany(sel) },
    { label: `하나로 합치기 (${sel.length}개)...`, disabled: hasMerge || !contiguous, onClick: () => squashSelected(sel) },
    sel.length === 2 ? { label: '두 커밋 비교', onClick: async () => (await import('./compare.js')).openCompare(sel[1].hash, sel[0].hash) } : null,
    '-',
    { label: '해시 모두 복사', onClick: () => window.api.copy(sel.map((c) => c.hash).join('\n')) },
    hasMerge ? { header: '병합 커밋이 포함되어 일부 작업을 할 수 없습니다' } : null,
  ];
}

async function cherryPickMany(sel) {
  const list = [...sel].reverse();
  const ok = await confirmDialog(`${list.length}개 커밋을 현재 브랜치에 차례로 복사합니다.`, { title: '여러 커밋 체리픽', okLabel: '체리픽', detail: list.map((c) => `${c.hash.slice(0, 8)} ${c.subject}`).join('\n') });
  if (ok) op('체리픽', () => git('cherryPickMany', list.map((c) => c.hash)), { success: `${list.length}개 커밋 체리픽 완료` });
}

async function revertMany(sel) {
  const ok = await confirmDialog(`${sel.length}개 커밋의 변경을 취소하는 되돌리기 커밋을 각각 만듭니다.`, { title: '여러 커밋 되돌리기', okLabel: '되돌리기', detail: sel.map((c) => `${c.hash.slice(0, 8)} ${c.subject}`).join('\n') });
  if (ok) op('Revert', () => git('revertMany', sel.map((c) => c.hash)), { success: `${sel.length}개 커밋을 되돌렸습니다.` });
}

// 여러 커밋을 하나로 합치기: 합칠 커밋 목록 + 메시지 입력만 있는 간단한 창
// (git 에는 단독 squash 명령이 없어 내부적으로는 리베이스로 처리하지만 화면에는 드러내지 않는다)
async function squashSelected(sel) {
  if (state.status?.state) return toast('진행 중인 병합/리베이스를 먼저 끝내세요.', 'warn');
  const oldest = sel[sel.length - 1];
  let base;
  let range;
  try {
    base = (await git('commitDetails', oldest.hash)).parents[0] || null;
    range = await git('rebaseCommits', base); // 오래된 순서
  } catch (e) {
    return toast(e.message, 'error');
  }
  const picked = new Set(sel.map((c) => c.hash));
  const chosen = range.filter((c) => picked.has(c.hash));
  if (chosen.length !== sel.length) return toast('현재 브랜치(HEAD)에 있는 커밋만 합칠 수 있습니다. 해당 브랜치를 체크아웃한 뒤 다시 시도하세요.', 'warn', 6000);
  if (range.some((c) => c.parents.length > 1)) return toast('중간에 병합(Merge) 커밋이 있어 합칠 수 없습니다.', 'warn', 6000);

  const msg = h('textarea', { class: 'rb-msg squash-msg', spellcheck: 'false' });
  msg.value = chosen.map((c) => c.message).join('\n\n');
  const list = h(
    'div',
    { class: 'push-list' },
    ...chosen.map((c) => h('div', { class: 'push-item' }, h('span', { class: 'hash', text: c.hash.slice(0, 8) }), h('span', { class: 'subj', text: c.subject }), h('span', { class: 'meta', text: `${c.author} · ${fmtDate(c.time)}` })))
  );
  const body = h(
    'div',
    { class: 'form' },
    h('p', { class: 'msg', html: `선택한 <b>${chosen.length}개 커밋</b>을 하나로 합칩니다. 파일 변경 내용은 그대로 유지됩니다.` }),
    list,
    h('label', { class: 'form-label', text: '합친 커밋 메시지' }),
    msg,
    state.status?.upstream ? h('p', { class: 'fdir', text: '이미 Push 한 커밋이면 다음 Push 때 강제 Push 가 필요합니다.' }) : null
  );
  modal({
    title: `커밋 합치기 (${chosen.length}개 → 1개)`,
    body,
    wide: true,
    buttons: [
      { label: '취소' },
      {
        label: '합치기',
        primary: true,
        onClick: () => {
          const message = msg.value.trim();
          if (!message) {
            toast('커밋 메시지를 입력하세요.', 'warn');
            msg.focus();
            return false;
          }
          // 첫 커밋은 유지(+메시지 변경), 나머지 선택 커밋은 그 커밋에 합치고, 선택 안 한 이후 커밋은 그대로
          const first = chosen[0].hash;
          const items = range.map((c) => (c.hash === first ? { hash: c.hash, action: 'pick', message } : picked.has(c.hash) ? { hash: c.hash, action: 'fixup' } : { hash: c.hash, action: 'pick' }));
          op('커밋 합치기', () => git('interactiveRebase', { base, items }), { success: `${chosen.length}개 커밋을 하나로 합쳤습니다.` });
        },
      },
    ],
  });
  setTimeout(() => msg.focus(), 0);
}

async function revert(c) {
  const ok = await confirmDialog(`'${c.subject}' 커밋의 변경 내용을 취소하는 새 커밋을 만듭니다.\n히스토리는 지워지지 않으므로 이미 Push 한 커밋에도 안전합니다.`, { title: '커밋 되돌리기 (Revert)', okLabel: '되돌리기' });
  if (ok) op('Revert', () => git('revertCommit', c.hash), { success: '되돌리기 커밋을 만들었습니다.' });
}

async function cherryPick(c) {
  const ok = await confirmDialog(`'${c.subject}' 커밋을 현재 브랜치에 복사(체리픽)합니다.`, { title: '체리픽', okLabel: '체리픽' });
  if (ok) op('체리픽', () => git('cherryPick', c.hash), { success: '체리픽 완료' });
}

async function resetTo(c) {
  const mode = await choiceDialog(
    `현재 브랜치를 '${c.hash.slice(0, 8)} ${c.subject}' 로 되돌립니다. 이후 커밋들은 브랜치에서 사라집니다.\n\n• Soft: 커밋만 취소, 변경 내용은 커밋 대기 상태로 유지\n• Mixed: 커밋 취소, 변경 내용은 작업 파일에 유지\n• Hard: 커밋과 변경 내용 모두 삭제 (복구 어려움)`,
    [
      { label: 'Soft', value: 'soft' },
      { label: 'Mixed', value: 'mixed', primary: true },
      { label: 'Hard', value: 'hard', danger: true },
    ],
    { title: '브랜치 리셋 (Reset)' }
  );
  if (!mode) return;
  if (mode === 'hard' && !(await confirmDialog('커밋하지 않은 변경 내용이 모두 사라집니다. 계속할까요?', { danger: true, okLabel: 'Hard Reset' }))) return;
  op('리셋', () => git('reset', c.hash, mode), { success: `${mode} 리셋 완료` });
}

async function createTag(c) {
  const name = await promptDialog(`${c.hash.slice(0, 8)} 에 태그 만들기`, { title: '태그 생성', placeholder: '예: v1.0.0' });
  if (name) op('태그 생성', () => git('createTag', name, c.hash), { success: `태그 '${name}' 생성됨 (Push 시 '태그도 Push' 를 선택하세요)` });
}

// ---------- 커밋 상세 ----------

function markRows() {
  document.querySelectorAll('#logTable .log-row').forEach((r) => {
    const hsh = commits[+r.dataset.i]?.hash;
    r.classList.toggle('sel', hsh === selectedHash);
    r.classList.toggle('multi', multi.has(hsh));
  });
  const info = $('#logMultiInfo');
  if (info) info.textContent = multi.size > 1 ? `${multi.size}개 커밋 선택됨 (우클릭: 일괄 작업)` : '';
}

async function selectCommit(hash, scroll = true) {
  selectedHash = hash;
  markRows();
  const box = $('#logDetailFiles');
  let d;
  const repo = state.repo;
  try {
    d = await git('commitDetails', hash);
    if (state.repo !== repo) return;
  } catch (e) {
    box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  if (selectedHash !== hash) return;
  box.innerHTML = '';
  const info = h(
    'div',
    { class: 'commit-info' },
    h('div', { class: 'ci-subj', text: d.body.split('\n')[0] }),
    d.body.includes('\n') ? h('pre', { class: 'ci-body', text: d.body.split('\n').slice(1).join('\n').trim() }) : null,
    h('div', { class: 'ci-meta', html: `<b>${esc(d.author)}</b> &lt;${esc(d.email)}&gt;<br>${esc(fmtDate(d.time))}` }),
    h('div', { class: 'ci-meta mono', html: `${d.hash}${d.parents.length ? `<br>부모: ${d.parents.map((p) => p.slice(0, 8)).join(', ')}` : ''}` }),
    d.refs.length ? h('div', { class: 'ci-refs', html: refBadges(d.refs) }) : null,
    d.signature ? h('div', { class: `ci-sig ${d.signature.status === 'G' ? 'good' : 'warn'}`, text: `${d.signature.status === 'G' ? '✔ 서명 확인됨' : `⚠ 서명 상태: ${d.signature.status}`}${d.signature.signer ? ` (${d.signature.signer})` : ''}` }) : null
  );
  box.append(info, h('div', { class: 'group-header', html: `변경된 파일 <span class="count">${d.files.length}개</span>${d.parents.length > 1 ? ' <span class="count">(첫 번째 부모 기준)</span>' : ''}` }));
  const list = h('div', { class: 'detail-files' });
  const makeRow = (f) => {
    const { dir, name } = splitPath(f.path);
    const row = h(
      'div',
      { class: `file-row s-${f.status} ${selectedFile === f.path ? 'active' : ''}`, title: f.path },
      h('span', { class: `st-badge s-${f.status}`, text: STATUS_LABEL[f.status] }),
      h('span', { class: 'fname', text: name }),
      h('span', { class: 'fdir', text: dir })
    );
    row.onclick = () => {
      list.querySelectorAll('.file-row').forEach((r) => r.classList.remove('active'));
      row.classList.add('active');
      showCommitDiff(d, f);
    };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: '변경 내용 보기', onClick: () => row.click() },
        { label: '파일 히스토리 보기', onClick: () => showFileHistory(f.path) },
        { label: '이 리비전에서 Blame', disabled: f.status === 'deleted', onClick: async () => (await import('./blame.js')).openBlame(f.path, d.hash) },
        { label: '경로 복사', onClick: () => window.api.copy(f.path) },
      ]);
    };
    return row;
  };
  // 파일이 수천 개여도 멈추지 않도록 300개씩 그리고, 아래로 내리면 더 그린다
  let shown = 0;
  const more = (upTo = shown + 300) => {
    const end = Math.min(d.files.length, upTo);
    const frag = document.createDocumentFragment();
    for (; shown < end; shown++) frag.append(makeRow(d.files[shown]));
    list.append(frag);
  };
  more();
  box.onscroll = () => shown < d.files.length && box.scrollTop + box.clientHeight > box.scrollHeight - 300 && more();
  box.append(list);
  const pick = d.files.find((f) => f.path === selectedFile) || (filter.file && d.files.find((f) => f.path === filter.file)) || d.files[0];
  if (pick) {
    if (d.files.indexOf(pick) >= shown) more(d.files.indexOf(pick) + 1);
    [...list.children][d.files.indexOf(pick)]?.classList.add('active');
    showCommitDiff(d, pick);
  } else emptyDiff($('#logDetailDiff'), '변경된 파일이 없습니다.');
}

// ---------- 여러 커밋 선택: 커밋 목록 + 변경 파일 합치기(중복 제외) + 엑셀(자원 리스트) ----------

let multiSeq = 0;
const STATUS_KO = { added: '추가', modified: '수정', deleted: '삭제', renamed: '이름 변경' };

// 같은 파일을 여러 커밋이 바꿨으면 하나로: 처음 상태와 마지막 상태로 최종 구분을 정한다
function mergeFiles(details) {
  const map = new Map();
  // 오래된 커밋부터
  for (const d of [...details].sort((a, b) => a.time - b.time)) {
    for (const f of d.files) {
      let m = map.get(f.path);
      if (!m && f.orig && map.has(f.orig)) {
        // 이름이 바뀐 파일은 예전 경로 기록을 이어 받는다
        m = map.get(f.orig);
        map.delete(f.orig);
        m.orig = m.orig || f.orig;
        m.path = f.path;
        map.set(f.path, m);
      }
      if (!m) {
        m = { path: f.path, orig: f.orig || null, first: f.status, last: f.status, commits: [], authors: new Set(), time: 0 };
        map.set(f.path, m);
      }
      m.last = f.status;
      m.commits.push(d);
      m.authors.add(d.author);
      m.time = Math.max(m.time, d.time);
    }
  }
  for (const m of map.values()) {
    m.status = m.last === 'deleted' ? (m.first === 'added' ? 'deleted' : 'deleted') : m.first === 'added' ? 'added' : m.orig ? 'renamed' : m.last === 'renamed' ? 'renamed' : 'modified';
    if (m.first === 'added' && m.last === 'deleted') m.status = 'deleted'; // 만들었다가 지움
  }
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function showMultiDetail() {
  const my = ++multiSeq;
  const repo = state.repo;
  const hashes = commits.filter((c) => multi.has(c.hash)).map((c) => c.hash); // 목록 순서(최신 먼저)
  const box = $('#logDetailFiles');
  box.innerHTML = `<div class="loading-note"><span class="spinner"></span> ${hashes.length}개 커밋의 변경 파일을 모으는 중...</div>`;
  emptyDiff($('#logDetailDiff'), '왼쪽 목록에서 파일을 고르면 선택한 커밋들에서 바뀐 전체 내용을 보여 줍니다.');
  let details;
  try {
    details = await git('commitsFiles', hashes);
  } catch (e) {
    box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  if (my !== multiSeq || state.repo !== repo) return;
  const files = mergeFiles(details);
  box.innerHTML = '';

  // 선택한 커밋 목록 (간단한 표)
  const clist = h('div', { class: 'multi-commits' });
  for (const d of details) {
    const row = h(
      'div',
      { class: 'mc-row', title: `${d.hash}\n${d.subject}\n클릭: 이 커밋만 보기` },
      h('span', { class: 'mc-hash', text: d.hash.slice(0, 8) }),
      h('span', { class: 'mc-subj', text: d.subject }),
      h('span', { class: 'mc-meta', text: `${d.author} · ${fmtDate(d.time)}` }),
      h('span', { class: 'mc-n', text: `${d.files.length}` })
    );
    row.onclick = () => {
      multi.clear();
      selectCommit(d.hash);
    };
    clist.append(row);
  }
  const authors = [...new Set(details.map((d) => d.author))];
  const span = details.length ? `${fmtDate(Math.min(...details.map((d) => d.time)), false)} ~ ${fmtDate(Math.max(...details.map((d) => d.time)), false)}` : '';
  box.append(
    h('div', { class: 'commit-info multi-info' }, h('div', { class: 'ci-subj', text: `선택한 커밋 ${details.length}개` }), h('div', { class: 'ci-meta', text: `${span} · 작성자 ${authors.join(', ')}` })),
    clist
  );

  // 합친 변경 파일
  const counts = Object.entries(files.reduce((a, f) => ((a[f.status] = (a[f.status] || 0) + 1), a), {}))
    .map(([k, v]) => `${STATUS_KO[k]} ${v}`)
    .join(' · ');
  const xbtn = h('button', { class: 'tb-btn small', text: '⬇ 엑셀', title: '변경된 파일 목록(자원 리스트)을 엑셀로 저장' });
  xbtn.onclick = () => exportResources(details, files);
  box.append(h('div', { class: 'group-header multi-files-head' }, h('span', { html: `변경된 파일 <span class="count">${files.length}개 (중복 제외)</span> <span class="count">${counts}</span>` }), h('span', { class: 'tb-spacer' }), xbtn));
  const list = h('div', { class: 'detail-files' });
  for (const f of files) {
    const { dir, name } = splitPath(f.path);
    const row = h(
      'div',
      { class: `file-row s-${f.status}`, title: `${f.path}${f.orig ? `\n(이전 이름: ${f.orig})` : ''}\n이 파일을 바꾼 커밋 ${f.commits.length}개` },
      h('span', { class: `st-badge s-${f.status}`, text: STATUS_LABEL[f.status] }),
      h('span', { class: 'fname', text: name }),
      h('span', { class: 'fdir', text: dir }),
      f.commits.length > 1 ? h('span', { class: 'mf-n', text: `×${f.commits.length}`, title: `${f.commits.length}개 커밋에서 바뀜` }) : null
    );
    row.onclick = () => {
      list.querySelectorAll('.file-row').forEach((r) => r.classList.remove('active'));
      row.classList.add('active');
      showMergedDiff(f);
    };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: '변경 내용 보기 (선택한 커밋 전체)', onClick: () => row.click() },
        { label: '파일 히스토리 보기', onClick: () => showFileHistory(f.path) },
        '-',
        { label: `엑셀로 내보내기 — 자원 리스트 (${files.length}개 파일)`, onClick: () => exportResources(details, files) },
        { label: '파일 경로 목록 복사 (전체)', onClick: () => (window.api.copy(files.map((x) => x.path).join('\n')), toast(`${files.length}개 경로를 복사했습니다.`, 'ok')) },
        { label: '이 파일 경로 복사', onClick: () => window.api.copy(f.path) },
      ]);
    };
    list.append(row);
  }
  box.append(list);
  if (!files.length) list.append(h('div', { class: 'empty', text: '변경된 파일이 없습니다.' }));
}

// 선택한 커밋들 동안의 전체 변경: (이 파일을 처음 바꾼 커밋의 부모) → (마지막으로 바꾼 커밋)
async function showMergedDiff(f) {
  const oldest = f.commits[0];
  const newest = f.commits[f.commits.length - 1];
  const from = oldest.parents[0];
  try {
    const file = { path: f.path, orig: f.orig || undefined, status: !from ? 'added' : f.status };
    const pair = await git('refFilePair', from || newest.hash, newest.hash, file);
    // 선택한 커밋들이 이 파일을 어떻게 바꿨는지 (첫 커밋 직전 → 마지막 커밋). 내 로컬 파일과의 비교가 아님
    pair.leftLabel = from ? `첫 커밋 이전 ${from.slice(0, 8)}: ${f.orig || f.path}` : '(없음 — 선택한 커밋에서 새로 생김)';
    pair.rightLabel = `마지막 커밋 ${newest.hash.slice(0, 8)}: ${f.path}`;
    pair.leftTag = { kind: 'before', text: '수정 전' };
    pair.rightTag = { kind: 'after', text: `수정 후 (${f.commits.length}개 커밋)` };
    renderDiff($('#logDetailDiff'), pair, { title: `${f.path}  (${f.commits.length}개 커밋 합친 변경)` });
  } catch (e) {
    emptyDiff($('#logDetailDiff'), e.message);
  }
}

// 자원 리스트(변경 파일 목록)를 엑셀로
async function exportResources(details, files) {
  const repoName = state.repo.split(/[\\/]/).pop();
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const d8 = (t) => fmtDate(t, true);
  const sheets = [
    {
      name: '자원 리스트',
      columns: [
        { header: '번호', width: 6 },
        { header: '구분', width: 9 },
        { header: '파일 경로', width: 60 },
        { header: '파일명', width: 28 },
        { header: '폴더', width: 40 },
        { header: '확장자', width: 8 },
        { header: '이전 경로', width: 30 },
        { header: '변경 커밋 수', width: 10 },
        { header: '커밋', width: 22 },
        { header: '커밋 메시지', width: 50 },
        { header: '작성자', width: 16 },
        { header: '최종 변경일', width: 17 },
      ],
      rows: files.map((f, i) => {
        const { dir, name } = splitPath(f.path);
        const ext = (name.match(/\.([^.]+)$/) || [])[1] || '';
        return [
          i + 1,
          STATUS_KO[f.status],
          f.path,
          name,
          dir,
          ext,
          f.orig || '',
          f.commits.length,
          f.commits.map((c) => c.hash.slice(0, 8)).join(', '),
          [...new Set(f.commits.map((c) => c.subject))].join('\n'),
          [...f.authors].join(', '),
          d8(f.time),
        ];
      }),
    },
    {
      name: '커밋 목록',
      columns: [
        { header: '번호', width: 6 },
        { header: '커밋', width: 12 },
        { header: '메시지', width: 70 },
        { header: '작성자', width: 16 },
        { header: '날짜', width: 17 },
        { header: '변경 파일 수', width: 12 },
      ],
      rows: details.map((d, i) => [i + 1, d.hash.slice(0, 8), d.subject, d.author, d8(d.time), d.files.length]),
    },
  ];
  const r = await window.api.file.saveXlsx(`자원리스트_${repoName}_${ymd}.xlsx`, sheets);
  if (!r.ok) return toast(`엑셀로 저장하지 못했습니다: ${r.error}`, 'error', 6000);
  if (!r.data) return;
  toast(`엑셀로 저장했습니다: ${r.data}`, 'ok', 5000);
  window.api.showItem(r.data);
}

async function showCommitDiff(d, f) {
  selectedFile = f.path;
  try {
    const pair = await git('commitFilePair', d.hash, f);
    renderDiff($('#logDetailDiff'), pair, { title: f.path });
  } catch (e) {
    emptyDiff($('#logDetailDiff'), e.message);
  }
}

// 브랜치 생성/삭제/이름 변경 직후 왼쪽 브랜치 목록만 바로 다시 그린다 (이력은 새로고침에서 따로 갱신)
export async function reloadBranchTree() {
  if (!state.repo || boundRepo !== state.repo) return;
  const repo = state.repo;
  try {
    const br = await git('branches');
    if (state.repo !== repo) return;
    lastBr = br;
    renderBranches(br);
  } catch {}
}

// 다른 화면(Blame, 비교, Reflog)에서 특정 커밋으로 이동
export async function showCommit(hash) {
  filter.file = null;
  document.querySelector('.rail-btn[data-view="log"]')?.click();
  await load();
  const full = commits.find((c) => c.hash.startsWith(hash));
  multi.clear();
  await selectCommit(full ? full.hash : hash);
  if (full) $(`#logTable .log-row[data-i="${commits.indexOf(full)}"]`)?.scrollIntoView({ block: 'center' });
  else toast('목록에 보이지 않는 커밋입니다 (다른 브랜치에 없거나 더 오래된 커밋). 상세 내용만 표시합니다.', 'info', 5000);
}
