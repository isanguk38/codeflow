// 스태시 화면 (IntelliJ 의 Shelve 와 비슷: 작업 중인 변경을 잠시 보관)
import { $, h, esc, fmtDate, splitPath, STATUS_LABEL, promptDialog, confirmDialog, toast, splitter } from './ui.js';
import { state, git, op, onRefresh } from './state.js';
import { renderDiff, emptyDiff } from './diff.js';

let root;
let selected = null;

export function initStash() {
  root = $('#view-stash');
  root.innerHTML = `
    <div class="stash-left" id="stashLeft">
      <div class="panel-bar"><span class="panel-title">보관된 변경 사항</span><span class="tb-spacer"></span>
        <button class="tb-btn small" id="stashNew">＋ 현재 변경 보관</button></div>
      <div id="stashList" class="stash-list"></div>
      <div id="stashFiles" class="detail-files"></div>
    </div>
    <div class="splitter-x" id="stashSplit"></div>
    <div class="changes-right" id="stashDiff"></div>`;
  splitter($('#stashSplit'), $('#stashLeft'), { min: 260, max: 800, key: 'stash' });
  $('#stashNew').onclick = stashChanges;
  emptyDiff($('#stashDiff'), '보관 항목의 파일을 선택하면 내용이 표시됩니다.');
  onRefresh(() => state.view === 'stash' && load());
}

export const activateStash = () => load();

export async function stashChanges() {
  if (!state.status?.files.length) return toast('보관할 변경 사항이 없습니다.', 'warn');
  const msg = await promptDialog('보관 이름 (나중에 알아보기 쉽게)', { title: '변경 사항 보관 (Stash)', value: `작업 중 - ${state.status.branch || ''}`, okLabel: '보관' });
  if (msg) op('보관', () => git('stashSave', msg), { success: '변경 사항을 보관했습니다. 작업 트리는 깨끗한 상태가 됩니다.' });
}

async function load() {
  const list = $('#stashList');
  const repo = state.repo;
  let items;
  try {
    items = await git('stashList');
  } catch {
    items = [];
  }
  if (state.repo !== repo) return; // 그 사이 탭이 바뀜
  list.innerHTML = '';
  if (!items.length) {
    list.append(h('div', { class: 'empty', html: '보관된 항목이 없습니다.<br><small>작업하던 내용을 잠시 치워두고 다른 브랜치로 전환할 때 사용하세요.</small>' }));
    $('#stashFiles').innerHTML = '';
    emptyDiff($('#stashDiff'), '보관 항목이 없습니다.');
    return;
  }
  for (const it of items) {
    const row = h(
      'div',
      { class: `stash-row ${selected === it.ref ? 'active' : ''}` },
      h('div', { class: 'sr-main' }, h('div', { class: 'sr-subj', text: it.subject }), h('div', { class: 'sr-meta', text: `${it.ref} · ${fmtDate(it.time)}` })),
      h('button', { class: 'btn small primary', text: '꺼내기', title: '적용 후 목록에서 제거 (Pop)', onclick: (e) => (e.stopPropagation(), op('꺼내기', () => git('stashPop', it.ref), { success: '보관 항목을 적용하고 제거했습니다.' })) }),
      h('button', { class: 'btn small', text: '적용', title: '적용하고 목록에는 유지 (Apply)', onclick: (e) => (e.stopPropagation(), op('적용', () => git('stashApply', it.ref), { success: '보관 항목을 적용했습니다.' })) }),
      h('button', {
        class: 'btn small danger',
        text: '삭제',
        onclick: async (e) => {
          e.stopPropagation();
          if (await confirmDialog(`'${it.subject}' 보관 항목을 삭제합니다.`, { danger: true, okLabel: '삭제' })) op('삭제', () => git('stashDrop', it.ref));
        },
      })
    );
    row.onclick = () => {
      selected = it.ref;
      list.querySelectorAll('.stash-row').forEach((r) => r.classList.remove('active'));
      row.classList.add('active');
      showFiles(it.ref);
    };
    list.append(row);
  }
  if (!selected || !items.some((i) => i.ref === selected)) selected = items[0].ref;
  list.children[items.findIndex((i) => i.ref === selected)]?.classList.add('active');
  showFiles(selected);
}

async function showFiles(ref) {
  const box = $('#stashFiles');
  box.innerHTML = '';
  const files = await git('stashFiles', ref).catch(() => []);
  box.append(h('div', { class: 'group-header', html: `파일 <span class="count">${files.length}개</span>` }));
  for (const f of files) {
    const { dir, name } = splitPath(f.path);
    const row = h('div', { class: `file-row s-${f.status}` }, h('span', { class: `st-badge s-${f.status}`, text: STATUS_LABEL[f.status] }), h('span', { class: 'fname', text: name }), h('span', { class: 'fdir', text: dir }));
    row.onclick = async () => {
      box.querySelectorAll('.file-row').forEach((r) => r.classList.remove('active'));
      row.classList.add('active');
      try {
        const pair = await git('commitFilePair', ref, f);
        renderDiff($('#stashDiff'), pair, { title: f.path });
      } catch (e) {
        emptyDiff($('#stashDiff'), e.message);
      }
    };
    box.append(row);
  }
  box.querySelector('.file-row')?.click();
}
