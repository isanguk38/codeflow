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
let root;
let dirty = true;

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
    if (row) selectCommit(commits[+row.dataset.i].hash);
  };
  table.oncontextmenu = (e) => {
    const row = e.target.closest('.log-row');
    if (!row) return;
    e.preventDefault();
    const c = commits[+row.dataset.i];
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
  ];
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

async function selectCommit(hash, scroll = true) {
  selectedHash = hash;
  document.querySelectorAll('#logTable .log-row').forEach((r) => r.classList.toggle('sel', commits[+r.dataset.i]?.hash === hash));
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
    d.refs.length ? h('div', { class: 'ci-refs', html: refBadges(d.refs) }) : null
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
