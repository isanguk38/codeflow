// 커밋 화면: 변경 파일 목록(체크박스 선택) + 커밋 메시지 + Diff
import { $, h, esc, splitPath, STATUS_LABEL, contextMenu, confirmDialog, toast, splitter } from './ui.js';
import { state, git, op, refresh, onRefresh, FAILED } from './state.js';
import { renderDiff, emptyDiff } from './diff.js';
import { openConflicts, openMergeTool } from './conflicts.js';
import { doPush } from './remote.js';

const selected = new Set(); // 커밋 대상으로 체크된 경로
const known = new Set(); // 한 번이라도 목록에 나타났던 경로 (새 파일 기본 체크 여부 판단용)
let current = null; // diff 로 보고 있는 파일 경로
let root;

export function initChanges() {
  root = $('#view-changes');
  root.innerHTML = `
    <div class="changes-left" id="changesLeft">
      <div class="panel-bar">
        <label class="check" title="전체 선택"><input type="checkbox" id="chkAll"></label>
        <span class="panel-title">변경 사항</span>
        <span class="tb-spacer"></span>
        <button class="tb-btn small" id="btnRollback" title="선택한 파일의 변경 내용 되돌리기 (Ctrl+Alt+Z)">↶ 되돌리기</button>
        <button class="tb-btn small" id="btnStash" title="변경 사항 임시 보관">⧉ 보관</button>
      </div>
      <div class="file-list" id="fileList"></div>
      <div class="commit-box">
        <textarea id="commitMsg" placeholder="커밋 메시지 (Ctrl+Enter 로 커밋)" spellcheck="false"></textarea>
        <div class="commit-actions">
          <label class="check"><input type="checkbox" id="amend"> 마지막 커밋 수정 (Amend)</label>
          <span class="tb-spacer"></span>
          <button class="btn primary" id="btnCommit">커밋</button>
          <button class="btn" id="btnCommitPush">커밋 후 Push</button>
        </div>
      </div>
    </div>
    <div class="splitter-x" id="changesSplit"></div>
    <div class="changes-right" id="changesDiff"></div>`;

  splitter($('#changesSplit'), $('#changesLeft'), { min: 260, max: 900, key: 'changes' });
  emptyDiff($('#changesDiff'));

  $('#chkAll').onchange = (e) => {
    const files = commitCandidates();
    if (e.target.checked) files.forEach((f) => selected.add(f.path));
    else selected.clear();
    render();
  };
  $('#btnRollback').onclick = () => rollbackFiles(filesFor([...selected]));
  $('#btnStash').onclick = async () => {
    const { stashChanges } = await import('./stash.js');
    stashChanges();
  };
  $('#btnCommit').onclick = () => doCommit(false);
  $('#btnCommitPush').onclick = () => doCommit(true);
  $('#commitMsg').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      doCommit(e.altKey || e.shiftKey);
    }
  });
  $('#amend').onchange = async (e) => {
    const msg = $('#commitMsg');
    if (e.target.checked && !msg.value.trim()) msg.value = await git('lastCommitMessage');
  };
  root.addEventListener('keydown', (e) => {
    if (e.key === 'z' && e.ctrlKey && e.altKey) rollbackFiles(filesFor([...selected]));
  });

  onRefresh(render);
}

const files = () => state.status?.files || [];
const filesFor = (paths) => files().filter((f) => paths.includes(f.path));
const commitCandidates = () => files().filter((f) => f.status !== 'conflict');

function render() {
  const list = $('#fileList');
  if (!list) return;
  const all = files();
  const paths = new Set(all.map((f) => f.path));
  for (const p of [...selected]) if (!paths.has(p)) selected.delete(p);
  for (const f of all) {
    if (!known.has(f.path)) {
      known.add(f.path);
      // IntelliJ 처럼 추적 중인 파일은 기본 선택, 새(미추적) 파일은 기본 해제
      if (f.status !== 'untracked' && f.status !== 'conflict') selected.add(f.path);
    }
  }

  const groups = [
    { key: 'conflict', title: '병합 충돌', files: all.filter((f) => f.status === 'conflict') },
    { key: 'changes', title: '변경됨', files: all.filter((f) => f.status !== 'conflict' && f.status !== 'untracked') },
    { key: 'untracked', title: '버전 관리되지 않는 파일', files: all.filter((f) => f.status === 'untracked') },
  ].filter((g) => g.files.length);

  list.innerHTML = '';
  if (!all.length) {
    list.append(h('div', { class: 'empty', html: '변경 사항이 없습니다.<br><small>작업 트리가 마지막 커밋과 같습니다.</small>' }));
  }
  for (const g of groups) {
    const allChecked = g.files.every((f) => selected.has(f.path));
    const groupChk = h('input', { type: 'checkbox', checked: allChecked });
    if (g.key === 'conflict') groupChk.disabled = true;
    groupChk.onchange = () => {
      g.files.forEach((f) => (groupChk.checked ? selected.add(f.path) : selected.delete(f.path)));
      render();
    };
    const header = h(
      'div',
      { class: `group-header g-${g.key}` },
      groupChk,
      h('span', { text: g.title }),
      h('span', { class: 'count', text: `${g.files.length}개 파일` }),
      g.key === 'conflict' ? h('button', { class: 'tb-btn small warn', text: '충돌 해결...', onclick: openConflicts }) : null
    );
    list.append(header);
    for (const f of g.files) list.append(fileRow(f));
  }

  const cand = commitCandidates();
  const chkAll = $('#chkAll');
  chkAll.checked = cand.length > 0 && cand.every((f) => selected.has(f.path));
  chkAll.indeterminate = !chkAll.checked && cand.some((f) => selected.has(f.path));

  const n = [...selected].length;
  $('#btnCommit').textContent = n ? `커밋 (${n})` : '커밋';
  const st = state.status;
  if (st?.state === 'merge') $('#commitMsg').placeholder = '병합 커밋 메시지 (비워두면 기본 메시지 사용)';
  else $('#commitMsg').placeholder = '커밋 메시지 (Ctrl+Enter 로 커밋)';

  if (current && !paths.has(current)) {
    current = null;
    emptyDiff($('#changesDiff'));
  } else if (current) showDiff(all.find((f) => f.path === current), true);
}

function fileRow(f) {
  const { dir, name } = splitPath(f.path);
  const chk = h('input', { type: 'checkbox', checked: selected.has(f.path) });
  if (f.status === 'conflict') chk.disabled = true;
  chk.onclick = (e) => e.stopPropagation();
  chk.onchange = () => {
    chk.checked ? selected.add(f.path) : selected.delete(f.path);
    render();
  };
  const row = h(
    'div',
    { class: `file-row s-${f.status} ${current === f.path ? 'active' : ''}`, title: `${STATUS_LABEL[f.status]}: ${f.path}${f.orig ? `\n원래 경로: ${f.orig}` : ''}` },
    chk,
    h('span', { class: `st-badge s-${f.status}`, text: STATUS_LABEL[f.status] }),
    h('span', { class: 'fname', text: name }),
    h('span', { class: 'fdir', text: f.orig ? `${dir} ← ${f.orig}` : dir })
  );
  row.onclick = () => (f.status === 'conflict' ? openMergeTool(f.path) : showDiff(f));
  row.ondblclick = () => window.api.openPath(`${state.repo}/${f.path}`);
  row.oncontextmenu = (e) => {
    e.preventDefault();
    const targets = selected.has(f.path) && selected.size > 1 ? filesFor([...selected]) : [f];
    contextMenu(e.clientX, e.clientY, fileMenu(f, targets));
  };
  return row;
}

function fileMenu(f, targets) {
  const multi = targets.length > 1;
  return [
    f.status === 'conflict' ? { label: '충돌 병합 도구 열기...', onClick: () => openMergeTool(f.path) } : { label: '변경 내용 보기', onClick: () => showDiff(f) },
    f.status === 'conflict' ? { label: '내 것 적용 (Accept Yours)', onClick: () => resolveSide(f.path, 'ours') } : null,
    f.status === 'conflict' ? { label: '상대 것 적용 (Accept Theirs)', onClick: () => resolveSide(f.path, 'theirs') } : null,
    '-',
    { label: multi ? `변경 내용 되돌리기 (${targets.length}개 파일)` : '변경 내용 되돌리기 (Rollback)', danger: true, onClick: () => rollbackFiles(targets) },
    { label: '파일 히스토리 보기', disabled: f.status === 'untracked' || f.status === 'added', onClick: async () => (await import('./log.js')).showFileHistory(f.path) },
    '-',
    { label: '파일 열기', onClick: () => window.api.openPath(`${state.repo}/${f.path}`) },
    { label: '탐색기에서 보기', onClick: () => window.api.showItem(`${state.repo}/${f.path}`.replace(/\//g, '\\')) },
    { label: '경로 복사', onClick: () => window.api.copy(f.path) },
    '-',
    f.status === 'untracked' ? { label: '.gitignore 에 추가', onClick: () => addIgnore(f.path) } : null,
    f.status === 'untracked' ? { label: '이 확장자 모두 .gitignore 에 추가', disabled: !f.path.includes('.'), onClick: () => addIgnore(`*${f.path.slice(f.path.lastIndexOf('.'))}`) } : null,
  ];
}

async function resolveSide(file, side) {
  await op('충돌 해결', () => git('resolveSide', file, side), { success: '충돌을 해결했습니다.' });
}

async function addIgnore(pattern) {
  await op('.gitignore 추가', () => git('addToGitignore', pattern), { success: `.gitignore 에 '${pattern}' 추가됨` });
}

async function showDiff(f, keepScroll = false) {
  if (!f) return;
  const container = $('#changesDiff');
  const prevScroll = keepScroll && current === f.path ? container.querySelector('.diff-scroll')?.scrollTop : null;
  current = f.path;
  document.querySelectorAll('#fileList .file-row').forEach((r) => r.classList.toggle('active', r.title.endsWith(`: ${f.path}`) || r.title.includes(`: ${f.path}\n`)));
  try {
    const pair = await git('workingFilePair', f);
    if (current !== f.path) return;
    renderDiff(container, pair, {
      title: f.path,
      actions: [
        h('button', { class: 'tb-btn small', text: '↶ 되돌리기', title: '이 파일의 변경 내용 되돌리기', onclick: () => rollbackFiles([f]) }),
        h('button', { class: 'tb-btn small', text: '열기', title: '파일 열기', onclick: () => window.api.openPath(`${state.repo}/${f.path}`) }),
      ],
    });
    if (prevScroll != null) {
      const sc = container.querySelector('.diff-scroll');
      if (sc) sc.scrollTop = prevScroll;
    }
  } catch (e) {
    emptyDiff(container, `Diff 를 불러오지 못했습니다: ${e.message}`);
  }
}

export async function rollbackFiles(targets) {
  targets = targets.filter((f) => f.status !== 'conflict');
  if (!targets.length) return toast('되돌릴 파일을 선택하세요.', 'warn');
  const newFiles = targets.filter((f) => f.status === 'untracked' || f.status === 'added');
  const list = targets.map((f) => `  [${STATUS_LABEL[f.status]}] ${f.path}`).join('\n');
  const ok = await confirmDialog(
    `선택한 ${targets.length}개 파일의 변경 내용을 마지막 커밋 상태로 되돌립니다.${newFiles.length ? `\n새로 추가된 파일 ${newFiles.length}개는 휴지통으로 이동됩니다.` : ''}`,
    { title: '변경 내용 되돌리기 (Rollback)', okLabel: '되돌리기', danger: true, detail: list }
  );
  if (!ok) return;
  const r = await window.api.git.rollback(state.repo, targets);
  if (!r.ok) {
    (await import('./ui.js')).errorDialog(r.error, '되돌리기 실패');
  } else toast(`${targets.length}개 파일을 되돌렸습니다.`, 'ok');
  targets.forEach((f) => selected.delete(f.path));
  refresh();
}

async function doCommit(andPush) {
  const msgEl = $('#commitMsg');
  const message = msgEl.value.trim();
  const amend = $('#amend').checked;
  const merging = state.status?.state === 'merge';
  const conflicts = files().filter((f) => f.status === 'conflict');
  if (conflicts.length) {
    toast('해결되지 않은 충돌이 있습니다. 먼저 충돌을 해결하세요.', 'warn');
    openConflicts();
    return;
  }
  const paths = [];
  for (const f of filesFor([...selected])) {
    paths.push(f.path);
    if (f.orig) paths.push(f.orig);
  }
  if (!paths.length && !amend && !merging) return toast('커밋할 파일을 선택하세요.', 'warn');
  if (!message && !merging) {
    msgEl.focus();
    return toast('커밋 메시지를 입력하세요.', 'warn');
  }
  const r = await op(amend ? '커밋 수정' : '커밋', () => git('commit', { message: message || null, paths, amend }), {
    success: `${paths.length ? `${new Set(paths).size}개 파일 ` : ''}커밋 완료`,
  });
  if (r === FAILED) return;
  msgEl.value = '';
  $('#amend').checked = false;
  if (andPush) doPush();
}

export function focusCommitMessage() {
  $('#commitMsg')?.focus();
}
