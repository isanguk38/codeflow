// 히스토리 화면: 브랜치 트리 + 커밋 그래프 + 커밋 상세/Diff
import { $, h, esc, fmtDate, splitPath, STATUS_LABEL, contextMenu, confirmDialog, choiceDialog, promptDialog, splitter, toast } from './ui.js';
import { state, git, op, onRefresh } from './state.js';
import { renderDiff, emptyDiff } from './diff.js';
import { branchMenuItems, newBranch, checkout, checkoutRemote } from './branches.js';

const PAGE = 400;
const ROW_H = 26;
const LANE_W = 14;
const COLORS = ['#4e9bf5', '#e5a42b', '#5fb865', '#d9636b', '#a77ee8', '#3fbdb0', '#e07fc0', '#9aa64a'];

const filter = { ref: null, file: null, search: '' };
let commits = [];
let graph = [];
let selectedHash = null;
let selectedFile = null;
const multi = new Set(); // Ctrl/Shift 로 여러 개 선택한 커밋
let anchor = null;
let root;
let dirty = true;
let boundRepo = null;

export function initLog() {
  root = $('#view-log');
  root.innerHTML = `
    <div class="log-branches" id="logBranches"></div>
    <div class="splitter-x" id="logSplitBranches"></div>
    <div class="log-main">
      <div class="panel-bar">
        <input class="input small" id="logSearch" placeholder="커밋 메시지 검색" spellcheck="false">
        <span id="logFilterInfo" class="filter-chip" hidden></span>
        <span class="tb-spacer"></span>
        <span class="hint-sel" id="logMultiInfo"></span>
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
  splitter($('#logSplitBranches'), $('#logBranches'), { min: 160, max: 500, key: 'logBranches' });
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
  $('#logReflog').onclick = async () => (await import('./advanced.js')).openReflog();
  $('#logTableWrap').addEventListener('keydown', onKey);
  emptyDiff($('#logDetailDiff'), '커밋을 선택하고 파일을 클릭하면 변경 내용이 표시됩니다.');

  onRefresh(() => {
    dirty = true;
    if (state.view === 'log') load();
  });
}

export function activateLog() {
  if (dirty) load();
}

export function showFileHistory(path) {
  filter.file = path;
  filter.ref = null;
  document.querySelector('.rail-btn[data-view="log"]')?.click();
  load();
}

function setFilterChip() {
  const chip = $('#logFilterInfo');
  const label = filter.file ? `파일: ${filter.file}` : filter.ref ? `브랜치: ${filter.ref}` : '';
  chip.hidden = !label;
  chip.innerHTML = '';
  if (label) {
    chip.append(h('span', { text: label }), h('button', { class: 'chip-x', text: '✕', title: '필터 해제', onclick: () => ((filter.file = null), (filter.ref = null), load()) }));
  }
}

async function load() {
  if (!state.repo) return;
  if (boundRepo !== state.repo) {
    // 다른 저장소(탭)로 바뀌면 필터/선택 초기화
    boundRepo = state.repo;
    filter.ref = null;
    filter.file = null;
    filter.search = '';
    $('#logSearch').value = '';
    selectedHash = null;
    selectedFile = null;
    multi.clear();
  }
  dirty = false;
  setFilterChip();
  try {
    const [list, br] = await Promise.all([git('log', { limit: PAGE, ref: filter.ref, file: filter.file, search: filter.search }), git('branches')]);
    commits = list;
    graph = filter.file ? null : computeGraph(commits);
    renderBranches(br);
    renderTable();
    if (selectedHash && commits.some((c) => c.hash === selectedHash)) selectCommit(selectedHash, false);
    else if (commits.length) selectCommit(commits[0].hash, false);
    else {
      $('#logDetailFiles').innerHTML = '';
      emptyDiff($('#logDetailDiff'), '커밋이 없습니다.');
    }
  } catch (e) {
    $('#logTable').innerHTML = `<div class="empty">히스토리를 불러오지 못했습니다: ${esc(e.message)}</div>`;
  }
}

async function loadMore() {
  const more = await git('log', { limit: PAGE, skip: commits.length, ref: filter.ref, file: filter.file, search: filter.search });
  commits = commits.concat(more);
  graph = filter.file ? null : computeGraph(commits);
  renderTable();
}

// ---------- 브랜치 트리 ----------

function renderBranches(br) {
  const el = $('#logBranches');
  el.innerHTML = '';
  const head = state.status?.detached ? `HEAD (${state.status.headShort})` : state.status?.branch;
  const item = (label, ref, opts = {}) => {
    const row = h(
      'div',
      { class: `tree-item ${filter.ref === ref && !filter.file ? 'active' : ''} ${opts.current ? 'current' : ''}`, title: opts.title || label },
      h('span', { class: 'ti-ico', text: opts.ico || '⑂' }),
      h('span', { class: 'ti-name', text: label }),
      opts.hint ? h('span', { class: 'ti-hint', text: opts.hint }) : null
    );
    row.onclick = () => {
      filter.ref = ref;
      filter.file = null;
      load();
    };
    if (opts.kind) {
      row.ondblclick = () => (opts.kind === 'remote' ? checkoutRemote(ref) : !opts.current && checkout(ref));
      row.oncontextmenu = (e) => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, branchMenuItems(opts.branch, opts.kind));
      };
    }
    return row;
  };
  const group = (title, children) => {
    if (!children.length) return;
    const g = h('div', { class: 'tree-group' });
    const head = h('div', { class: 'tree-head', text: `▾ ${title}` });
    const body = h('div', {}, ...children);
    head.onclick = () => {
      body.hidden = !body.hidden;
      head.textContent = `${body.hidden ? '▸' : '▾'} ${title}`;
    };
    g.append(head, body);
    el.append(g);
  };
  el.append(item('모든 브랜치', null, { ico: '◎' }));
  if (head) el.append(item(`HEAD: ${head}`, 'HEAD', { ico: '●' }));
  group(
    '로컬',
    br.local.map((b) =>
      item(b.name, b.name, {
        kind: 'local',
        branch: b,
        current: b.current,
        ico: b.current ? '★' : '⑂',
        hint: b.track.replace('ahead ', '↑').replace('behind ', '↓').replace(/[[\],]/g, ''),
        title: `${b.name}${b.upstream ? ` → ${b.upstream}` : ''}\n더블클릭: 체크아웃 / 우클릭: 메뉴`,
      })
    )
  );
  const byRemote = {};
  for (const b of br.remote) (byRemote[b.name.split('/')[0]] ||= []).push(b);
  for (const [remote, list] of Object.entries(byRemote)) {
    group(
      `원격: ${remote}`,
      list.map((b) => item(b.name.slice(remote.length + 1), b.name, { kind: 'remote', branch: b, title: `${b.name}\n더블클릭: 체크아웃` }))
    );
  }
  group(
    '태그',
    br.tags.map((b) => item(b.name, b.name, { kind: 'tag', branch: b, ico: '⌂' }))
  );
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

function refBadges(refs) {
  return refs
    .map((r) => {
      if (r.startsWith('HEAD -> ')) return `<span class="ref head">● ${esc(r.slice(8))}</span>`;
      if (r === 'HEAD') return `<span class="ref head">HEAD</span>`;
      if (r.startsWith('tag: ')) return `<span class="ref tag">⌂ ${esc(r.slice(5))}</span>`;
      if (r.endsWith('/HEAD')) return '';
      if (r.includes('/')) return `<span class="ref remote">${esc(r)}</span>`;
      return `<span class="ref local">${esc(r)}</span>`;
    })
    .join('');
}

function renderTable() {
  const table = $('#logTable');
  if (!commits.length) {
    table.innerHTML = `<div class="empty">${filter.search ? '검색 결과가 없습니다.' : '커밋이 없습니다. 첫 커밋을 만들어 보세요.'}</div>`;
    return;
  }
  const maxLanes = graph ? Math.max(1, ...graph.map((g) => Math.max(g.before.length, g.after.length, g.idx + 1))) : 0;
  const gw = Math.min(maxLanes, 20) * LANE_W + 6;
  let html = '';
  commits.forEach((c, i) => {
    html += `<div class="log-row ${c.hash === selectedHash ? 'sel' : ''}" data-i="${i}">
      ${graph ? `<div class="c-graph" style="width:${gw}px">${graphSvg(graph[i], gw)}</div>` : ''}
      <div class="c-subj">${refBadges(c.refs)}<span class="subj">${esc(c.subject)}</span></div>
      <div class="c-author">${esc(c.author)}</div>
      <div class="c-date">${esc(fmtDate(c.time))}</div>
      <div class="c-hash">${c.hash.slice(0, 8)}</div>
    </div>`;
  });
  if (commits.length % PAGE === 0) html += `<div class="log-more"><button class="btn" id="logMore">더 불러오기</button></div>`;
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
    selectCommit(c.hash);
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
    '-',
    ...bisectItems(c),
  ];
}

function bisectItems(c) {
  if (state.status?.bisect) {
    return [
      { header: 'Bisect (문제 커밋 찾기) 진행 중' },
      { label: '이 커밋은 정상 (good)', onClick: () => bisectMark('good', c) },
      { label: '이 커밋은 문제 있음 (bad)', onClick: () => bisectMark('bad', c) },
    ];
  }
  return [{ label: 'Bisect 시작: 이 커밋은 정상, HEAD 는 문제', onClick: async () => (await import('./advanced.js')).startBisect('HEAD', c.hash) }];
}

async function bisectMark(term, c) {
  // 표시하려는 커밋으로 먼저 이동한 상태여야 정확하므로, 현재 HEAD 가 아니면 체크아웃 후 표시한다
  const { markBisect } = await import('./advanced.js');
  markBisect(term, c.hash);
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
    { label: `하나로 합치기 (Squash ${sel.length}개)...`, disabled: hasMerge || !contiguous, onClick: () => squashSelected(sel) },
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

async function squashSelected(sel) {
  const oldest = sel[sel.length - 1];
  const preset = {};
  sel.slice(0, -1).forEach((c) => (preset[c.hash] = 'squash'));
  (await import('./rebase.js')).openInteractiveRebase(oldest.hash, preset);
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
  try {
    d = await git('commitDetails', hash);
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
  for (const f of d.files) {
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
    list.append(row);
  }
  box.append(list);
  const pick = d.files.find((f) => f.path === selectedFile) || (filter.file && d.files.find((f) => f.path === filter.file)) || d.files[0];
  if (pick) {
    [...list.children][d.files.indexOf(pick)]?.classList.add('active');
    showCommitDiff(d, pick);
  } else emptyDiff($('#logDetailDiff'), '변경된 파일이 없습니다.');
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

// 다른 화면(Blame, 비교, Reflog)에서 특정 커밋으로 이동
export async function showCommit(hash) {
  filter.ref = null;
  filter.file = null;
  document.querySelector('.rail-btn[data-view="log"]')?.click();
  await load();
  const full = commits.find((c) => c.hash.startsWith(hash));
  multi.clear();
  await selectCommit(full ? full.hash : hash);
  if (full) $(`#logTable .log-row[data-i="${commits.indexOf(full)}"]`)?.scrollIntoView({ block: 'center' });
  else toast('목록에 보이지 않는 커밋입니다 (다른 브랜치에 없거나 더 오래된 커밋). 상세 내용만 표시합니다.', 'info', 5000);
}
