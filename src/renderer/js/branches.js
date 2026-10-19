// 브랜치 팝업(IntelliJ 오른쪽 아래 브랜치 메뉴와 비슷) 및 브랜치 관련 작업
import { $, h, esc, contextMenu, promptDialog, confirmDialog, choiceDialog, toast, closeMenu, registerMenu } from './ui.js';
import { state, git, op } from './state.js';

// 브랜치 목록이 바뀌는 작업 뒤에 히스토리 왼쪽 목록을 즉시 갱신
const treeNow = async () => (await import('./log.js')).reloadBranchTree();

export async function newBranch(start, { checkout = true } = {}) {
  const r = await promptDialog(start ? `'${start}' 에서 새 브랜치 만들기` : '현재 위치에서 새 브랜치 만들기', {
    title: '새 브랜치',
    placeholder: '예: feature/login',
    okLabel: '만들기',
    checkbox: { label: '만든 후 체크아웃', checked: checkout },
  });
  if (!r) return;
  const name = r.value.replace(/\s+/g, '-');
  await op('브랜치 생성', () => git('createBranch', { name, start, checkout: r.checked }), { success: `브랜치 '${name}' 생성됨` });
  treeNow();
}

export const checkout = (name) => op(`체크아웃 ${name}`, () => git('checkout', name), { success: `'${name}' 로 전환했습니다.` });

export const checkoutRemote = (name) =>
  op(`체크아웃 ${name}`, () => git('checkoutRemote', name), { success: (local) => `원격 '${name}' 을(를) 추적하는 '${local}' 로 전환했습니다.` });

const MERGE_MODES = [
  { value: 'default', label: '기본', desc: '가능하면 브랜치 포인터만 앞으로 옮기고(fast-forward), 아니면 병합 커밋을 만듭니다.' },
  { value: 'no-ff', label: '항상 병합 커밋 (--no-ff)', desc: '항상 병합 커밋을 남겨서 "이 기능이 언제 들어왔는지" 히스토리에 분명히 보입니다. 기능 단위로 되돌리기 쉽습니다.' },
  { value: 'squash', label: '하나로 합쳐서 커밋 (--squash)', desc: '들어오는 커밋들을 커밋 하나로 뭉칩니다. 자잘한 작업 커밋을 남기지 않을 때 사용합니다. (병합 기록은 남지 않음)' },
  { value: 'ff-only', label: 'Fast-forward 만 (--ff-only)', desc: '병합 커밋 없이 앞으로 옮길 수 있을 때만 병합하고, 아니면 취소합니다.' },
];

export async function mergeInto(name) {
  const cur = state.status?.branch;
  if (!cur) return toast('분리된 HEAD 상태에서는 병합할 수 없습니다. 브랜치를 체크아웃하세요.', 'warn');
  let pv;
  try {
    pv = await git('mergePreview', name);
  } catch (e) {
    return toast(e.message, 'error');
  }
  if (pv.upToDate) return toast(`'${name}' 의 변경은 이미 '${cur}' 에 모두 들어 있습니다.`, 'info');

  const saved = localStorage.getItem('mergeMode') || 'default';
  let mode = saved;
  const msg = h('textarea', { class: 'rb-msg', spellcheck: 'false' });
  const msgWrap = h('div', { class: 'form' }, h('label', { class: 'form-label', text: '커밋 메시지' }), msg);
  const defaultMsg = (m) => (m === 'squash' ? `Squashed '${name}' into '${cur}'` : `Merge branch '${name}' into '${cur}'`);
  let edited = false;
  msg.oninput = () => (edited = true);
  const options = h('div', { class: 'merge-modes' });
  const sync = () => {
    options.querySelectorAll('.merge-mode').forEach((el) => el.classList.toggle('on', el.dataset.mode === mode));
    // fast-forward 되는 경우(기본/ff-only)는 커밋이 생기지 않으므로 메시지 입력 불필요
    const makesCommit = mode === 'no-ff' || mode === 'squash' || (mode === 'default' && !pv.canFF);
    msgWrap.hidden = !makesCommit;
    if (!edited) msg.value = defaultMsg(mode);
  };
  for (const m of MERGE_MODES) {
    const disabled = m.value === 'ff-only' && !pv.canFF;
    const radio = h('input', { type: 'radio', name: 'mergeMode', checked: m.value === mode, disabled });
    const el = h(
      'label',
      { class: `merge-mode ${disabled ? 'disabled' : ''}`, 'data-mode': m.value },
      radio,
      h('div', {}, h('b', { text: m.label }), h('div', { class: 'fdir', text: disabled ? '지금은 불가능: 현재 브랜치에만 있는 커밋이 있습니다.' : m.desc }))
    );
    radio.onchange = () => {
      mode = m.value;
      sync();
    };
    options.append(el);
  }
  if (mode === 'ff-only' && !pv.canFF) mode = 'default';
  sync();

  const body = h(
    'div',
    { class: 'form' },
    h('p', {
      class: 'msg',
      html: `<b>${esc(name)}</b> → <b>${esc(cur)}</b> · 들어올 커밋 ${pv.incoming}개${pv.canFF ? ' · <span class="plus">fast-forward 가능</span>' : ` · 현재 브랜치에만 있는 커밋 ${pv.outgoing}개`}`,
    }),
    options,
    msgWrap
  );
  const { modal } = await import('./ui.js');
  modal({
    title: '병합 (Merge)',
    body,
    wide: true,
    buttons: [
      { label: '취소' },
      {
        label: '병합',
        primary: true,
        onClick: () => {
          localStorage.setItem('mergeMode', mode);
          const message = msgWrap.hidden ? null : msg.value.trim() || null;
          op('병합', () => git('merge', name, { mode, message }), {
            success: (r) => (/Already up to date/i.test(r?.output || '') ? '이미 최신 상태입니다.' : `'${name}' 병합 완료 (${MERGE_MODES.find((x) => x.value === mode).label})`),
          });
        },
      },
    ],
  });
}

export async function rebaseOnto(name) {
  const cur = state.status?.branch;
  const ok = await confirmDialog(`현재 브랜치 '${cur}' 의 커밋들을 '${name}' 위로 다시 쌓습니다 (Rebase).\n이미 Push 한 커밋이라면 Push 시 강제 Push 가 필요합니다.`, { title: '리베이스 (Rebase)', okLabel: '리베이스' });
  if (ok) await op('리베이스', () => git('rebase', name), { success: '리베이스 완료' });
}

async function rename(name) {
  const n = await promptDialog(`'${name}' 의 새 이름`, { title: '브랜치 이름 변경', value: name, okLabel: '변경' });
  if (n && n !== name) await op('이름 변경', () => git('renameBranch', name, n), { success: `'${n}' 로 이름 변경됨` });
  treeNow();
}

async function remove(b) {
  const ok = await confirmDialog(`로컬 브랜치 '${b.name}' 을(를) 삭제합니다.`, { title: '브랜치 삭제', okLabel: '삭제', danger: true });
  if (!ok) return;
  const r = await window.api.git.deleteBranch(state.repo, b.name, false);
  if (r.ok) {
    toast(`'${b.name}' 삭제됨`, 'ok');
  } else if (/not fully merged/i.test(r.error)) {
    const force = await confirmDialog(`'${b.name}' 은(는) 아직 병합되지 않은 커밋이 있습니다. 그래도 삭제할까요? (커밋이 사라질 수 있습니다)`, { title: '강제 삭제', okLabel: '강제 삭제', danger: true });
    if (force) await op('브랜치 삭제', () => git('deleteBranch', b.name, true), { success: `'${b.name}' 삭제됨` });
  } else (await import('./ui.js')).errorDialog(r.error, '브랜치 삭제 실패');
  treeNow();
  const { refresh } = await import('./state.js');
  refresh();
}

async function removeRemote(b) {
  const ok = await confirmDialog(`원격 저장소에서 '${b.name}' 브랜치를 삭제합니다. 다른 사람에게도 영향을 줍니다.`, { title: '원격 브랜치 삭제', okLabel: '삭제', danger: true });
  if (ok) await op('원격 브랜치 삭제', () => git('deleteRemoteBranch', b.name), { success: `'${b.name}' 삭제됨` });
  treeNow();
}

export async function checkoutRevision() {
  const rev = await promptDialog('체크아웃할 태그, 브랜치 또는 커밋 해시', { title: '리비전 체크아웃', placeholder: '예: v1.0 또는 a1b2c3d' });
  if (rev) await checkout(rev);
}

// 브랜치 하나에 대한 작업 메뉴
export function branchMenuItems(b, kind) {
  const cur = state.status?.branch;
  if (kind === 'local' && b.current) {
    return [
      { header: `${b.name} (현재 브랜치)` },
      { label: '여기서 새 브랜치...', onClick: () => newBranch(b.name) },
      { label: '이름 변경...', onClick: () => rename(b.name) },
      '-',
      { label: 'Pull (업데이트)', disabled: !b.upstream, onClick: async () => (await import('./remote.js')).doPull() },
      { label: 'Push...', onClick: async () => (await import('./remote.js')).doPush() },
    ];
  }
  if (kind === 'local') {
    return [
      { header: b.name },
      { label: '체크아웃', onClick: () => checkout(b.name) },
      { label: '여기서 새 브랜치...', onClick: () => newBranch(b.name) },
      '-',
      { label: `'${b.name}' 을(를) '${cur}' 에 병합`, disabled: !cur, onClick: () => mergeInto(b.name) },
      { label: `'${cur}' 을(를) '${b.name}' 위로 리베이스`, disabled: !cur, onClick: () => rebaseOnto(b.name) },
      { label: `현재 브랜치(${cur})와 비교`, disabled: !cur, onClick: async () => (await import('./compare.js')).openCompare(cur, b.name) },
      '-',
      { label: '이름 변경...', onClick: () => rename(b.name) },
      { label: '삭제', danger: true, onClick: () => remove(b) },
    ];
  }
  if (kind === 'remote') {
    return [
      { header: b.name },
      { label: '체크아웃', onClick: () => checkoutRemote(b.name) },
      { label: '여기서 새 브랜치...', onClick: () => newBranch(b.name) },
      '-',
      { label: `'${b.name}' 을(를) '${cur}' 에 병합`, disabled: !cur, onClick: () => mergeInto(b.name) },
      { label: `'${cur}' 을(를) '${b.name}' 위로 리베이스`, disabled: !cur, onClick: () => rebaseOnto(b.name) },
      { label: `현재 브랜치(${cur})와 비교`, disabled: !cur, onClick: async () => (await import('./compare.js')).openCompare(cur, b.name) },
      '-',
      { label: '원격 브랜치 삭제', danger: true, onClick: () => removeRemote(b) },
    ];
  }
  // tag
  return [
    { header: `태그 ${b.name}` },
    { label: '체크아웃', onClick: () => checkout(b.name) },
    { label: '여기서 새 브랜치...', onClick: () => newBranch(b.name) },
    { label: `'${cur}' 에 병합`, disabled: !cur, onClick: () => mergeInto(b.name) },
        { label: `현재 브랜치(${cur})와 비교`, disabled: !cur, onClick: async () => (await import('./compare.js')).openCompare(cur, b.name) },
    '-',
    {
      label: '태그 삭제',
      danger: true,
      onClick: async () => (await confirmDialog(`태그 '${b.name}' 삭제`, { danger: true, okLabel: '삭제' })) && op('태그 삭제', () => git('deleteTag', b.name)),
    },
  ];
}

// 툴바 브랜치 버튼 팝업
export async function openBranchPopup(anchor) {
  if (!state.repo) return;
  closeMenu();
  let data;
  try {
    data = await git('branches');
  } catch (e) {
    return toast(e.message, 'error');
  }
  const popup = h('div', { class: 'ctx-menu branch-popup' });
  const search = h('input', { class: 'input', placeholder: '브랜치 검색...', spellcheck: 'false' });
  const list = h('div', { class: 'branch-list' });
  popup.append(
    h('div', { class: 'bp-search' }, search),
    h('div', { class: 'ctx-item', onclick: () => (closeMenu(), newBranch()) }, h('span', { text: '＋ 새 브랜치...' }), h('span', { class: 'ctx-hint', text: 'Ctrl+Alt+N' })),
    h('div', { class: 'ctx-item', onclick: () => (closeMenu(), checkoutRevision()) }, h('span', { text: '태그 또는 리비전 체크아웃...' })),
    h('div', { class: 'ctx-sep' }),
    list
  );

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const match = (b) => !q || b.name.toLowerCase().includes(q);
    list.innerHTML = '';
    const section = (title, items, kind) => {
      const f = items.filter(match);
      if (!f.length) return;
      list.append(h('div', { class: 'ctx-header', text: title }));
      for (const b of f) {
        const track = b.track.includes('gone') ? '원격 삭제됨' : b.track ? b.track.replace('ahead', '↑').replace('behind', '↓').replace(/[[\],]/g, '') : '';
        const el = h(
          'div',
          { class: `ctx-item branch-item ${b.current ? 'current' : ''}` },
          h('span', { class: 'bi-name', html: `${b.current ? '<span class="star">★</span> ' : ''}${esc(b.name)}` }),
          h('span', { class: 'ctx-hint', text: `${track} ${b.upstream && kind === 'local' ? b.upstream : ''}`.trim() }),
          h('span', { class: 'chev', text: '›' })
        );
        el.onclick = (e) => {
          e.stopPropagation();
          const r = el.getBoundingClientRect();
          const items = branchMenuItems(b, kind);
          // 서브메뉴는 팝업을 닫고 띄운다
          contextMenu(r.right, r.top, items);
        };
        el.ondblclick = () => {
          closeMenu();
          if (kind === 'local' && !b.current) checkout(b.name);
          if (kind === 'remote') checkoutRemote(b.name);
        };
        list.append(el);
      }
    };
    section('로컬 브랜치', data.local.sort((a, b) => (b.current - a.current) || b.date - a.date), 'local');
    section('원격 브랜치', data.remote, 'remote');
    if (q) section('태그', data.tags, 'tag');
    if (!list.children.length) list.append(h('div', { class: 'empty', text: q ? '일치하는 브랜치 없음' : '브랜치가 없습니다 (첫 커밋 후 생성됩니다)' }));
  };
  search.oninput = draw;
  search.onkeydown = (e) => {
    if (e.key === 'Enter') {
      const first = list.querySelector('.branch-item');
      first?.click();
    }
  };
  draw();

  document.body.append(popup);
  const r = anchor.getBoundingClientRect();
  popup.style.left = `${r.left}px`;
  popup.style.top = `${r.bottom + 2}px`;
  registerMenu(popup);
  search.focus();
}
