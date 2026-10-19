// 대화형 리베이스: 커밋 순서 변경, 메시지 수정(reword), 합치기(squash/fixup), 삭제(drop)
import { h, esc, modal, toast, confirmDialog, fmtDate } from './ui.js';
import { state, git, op } from './state.js';

const ACTIONS = [
  { value: 'pick', label: '유지' },
  { value: 'reword', label: '메시지 수정' },
  { value: 'squash', label: '위 커밋과 합치기 (메시지 합침)' },
  { value: 'fixup', label: '위 커밋과 합치기 (메시지 버림)' },
  { value: 'drop', label: '삭제' },
];

// fromHash 커밋부터 HEAD 까지 편집한다. preset: { 해시: 동작 }
export async function openInteractiveRebase(fromHash, preset = {}) {
  if (state.status?.state) return toast('진행 중인 병합/리베이스를 먼저 끝내세요.', 'warn');
  let base;
  let commits;
  try {
    const d = await git('commitDetails', fromHash);
    base = d.parents[0] || null;
    commits = await git('rebaseCommits', base);
  } catch (e) {
    return toast(e.message, 'error');
  }
  if (!commits.some((c) => c.hash.startsWith(fromHash) || fromHash.startsWith(c.hash))) {
    return toast('선택한 커밋이 현재 브랜치(HEAD)의 조상이 아닙니다. 해당 브랜치를 체크아웃한 뒤 다시 시도하세요.', 'warn', 6000);
  }
  if (commits.some((c) => c.parents.length > 1)) {
    return toast('범위 안에 병합(merge) 커밋이 있어 대화형 리베이스를 할 수 없습니다. 병합 커밋 이후부터 선택하세요.', 'warn', 6000);
  }
  if (!commits.length) return toast('편집할 커밋이 없습니다.', 'warn');

  const items = commits.map((c) => ({ ...c, action: preset[c.hash] || 'pick', newMessage: null, edited: false }));
  const list = h('div', { class: 'rb-list' });
  const summary = h('div', { class: 'rb-summary' });

  // 그룹(유지/수정 + 뒤따르는 합치기)의 최종 메시지
  const groupOf = (i) => {
    const members = [];
    for (let j = i + 1; j < items.length; j++) {
      if (items[j].action === 'drop') continue;
      if (items[j].action === 'squash' || items[j].action === 'fixup') members.push(items[j]);
      else break;
    }
    return members;
  };
  const defaultMessage = (it, members) => [it.message, ...members.filter((m) => m.action === 'squash').map((m) => m.message)].join('\n\n');

  const draw = () => {
    list.innerHTML = '';
    let leaderSeen = false;
    items.forEach((it, i) => {
      const isLeader = it.action === 'pick' || it.action === 'reword';
      const members = isLeader ? groupOf(i) : [];
      const needsMsg = isLeader && (it.action === 'reword' || members.some((m) => m.action === 'squash'));
      const bad = (it.action === 'squash' || it.action === 'fixup') && !leaderSeen;
      if (isLeader) leaderSeen = true;

      const sel = h('select', { class: 'input rb-action' }, ...ACTIONS.map((a) => h('option', { value: a.value, selected: a.value === it.action, text: a.label })));
      sel.onchange = () => {
        it.action = sel.value;
        draw();
      };
      const up = h('button', { class: 'tb-btn small', text: '▲', title: '위로', disabled: i === 0 });
      const down = h('button', { class: 'tb-btn small', text: '▼', title: '아래로', disabled: i === items.length - 1 });
      up.onclick = () => {
        [items[i - 1], items[i]] = [items[i], items[i - 1]];
        draw();
      };
      down.onclick = () => {
        [items[i + 1], items[i]] = [items[i], items[i + 1]];
        draw();
      };
      const row = h(
        'div',
        { class: `rb-row a-${it.action} ${bad ? 'bad' : ''} ${isLeader ? '' : 'member'}` },
        h('div', { class: 'rb-move' }, up, down),
        sel,
        h('span', { class: 'hash', text: it.hash.slice(0, 8) }),
        h('span', { class: 'rb-subj', text: it.subject }),
        h('span', { class: 'rb-meta', text: `${it.author} · ${fmtDate(it.time)}` })
      );
      list.append(row);
      if (bad) list.append(h('div', { class: 'rb-warn', text: '⚠ 합치려면 위에 유지/메시지 수정 커밋이 있어야 합니다.' }));
      if (needsMsg) {
        if (!it.edited) it.newMessage = it.action === 'reword' && !members.length ? it.newMessage ?? it.message : defaultMessage(it, members);
        const ta = h('textarea', { class: 'rb-msg', spellcheck: 'false' });
        ta.value = it.newMessage;
        ta.oninput = () => {
          it.newMessage = ta.value;
          it.edited = true;
        };
        list.append(h('div', { class: 'rb-msg-wrap' }, h('div', { class: 'rb-msg-label', text: members.length ? `합쳐진 커밋 메시지 (${members.length + 1}개 커밋 → 1개)` : '새 커밋 메시지' }), ta));
      } else if (isLeader) {
        it.newMessage = null;
        it.edited = false;
      }
    });
    const kept = items.filter((i) => i.action !== 'drop');
    const squashed = items.filter((i) => i.action === 'squash' || i.action === 'fixup').length;
    const dropped = items.length - kept.length;
    const moved = items.some((it, i) => it.hash !== commits[i].hash);
    summary.innerHTML = `커밋 ${items.length}개 → <b>${kept.length - squashed}개</b>${squashed ? ` · 합치기 ${squashed}` : ''}${dropped ? ` · <span class="minus">삭제 ${dropped}</span>` : ''}${moved ? ' · 순서 변경' : ''}`;
  };
  draw();

  const body = h(
    'div',
    { class: 'rebase-dialog' },
    h('p', { class: 'msg', html: `<b>${esc(state.status?.branch || 'HEAD')}</b> 브랜치의 커밋을 편집합니다. 위에서부터 순서대로 다시 적용됩니다.` }),
    list,
    summary
  );
  modal({
    title: '대화형 리베이스 (커밋 편집)',
    body,
    wide: true,
    buttons: [
      { label: '취소' },
      {
        label: '리베이스 시작',
        primary: true,
        onClick: async () => {
          const first = items.find((i) => i.action !== 'drop');
          if (!first) {
            toast('모든 커밋을 삭제할 수는 없습니다.', 'warn');
            return false;
          }
          if (first.action === 'squash' || first.action === 'fixup') {
            toast('첫 번째 커밋은 합치기를 할 수 없습니다.', 'warn');
            return false;
          }
          const changed = items.some((it, i) => it.action !== 'pick' || it.hash !== commits[i].hash);
          if (!changed) {
            toast('변경한 내용이 없습니다.', 'warn');
            return false;
          }
          if (state.status?.upstream && !(await confirmDialog('커밋 히스토리가 바뀝니다. 이미 Push 한 커밋이라면 다음 Push 때 강제 Push 가 필요합니다. 계속할까요?', { title: '대화형 리베이스', okLabel: '계속' })))
            return false;
          // 메시지 입력란이 있던 그룹의 첫 커밋만 message 를 보낸다 (합치기 결과/수정 메시지)
          const payload = items.map((it) => ({ hash: it.hash, action: it.action, message: it.newMessage ? it.newMessage.trim() : null }));
          op('대화형 리베이스', () => git('interactiveRebase', { base, items: payload }), { success: '커밋 편집을 완료했습니다.' });
        },
      },
    ],
  });
}
