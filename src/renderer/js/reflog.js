// Reflog: HEAD 가 움직인 기록. 리셋/리베이스로 사라진 커밋을 되살릴 때 사용 (히스토리 상단 ↺ Reflog 버튼)
import { h, fmtDate, modal, choiceDialog, toast } from './ui.js';
import { git, op } from './state.js';

function reflogRows(list, close) {
  const box = h('div', { class: 'adv-list' });
  if (!list.length) box.append(h('div', { class: 'empty small', text: '기록이 없습니다.' }));
  for (const r of list) {
    const row = h(
      'div',
      { class: 'adv-row', title: r.subject },
      h('span', { class: 'hash', text: r.hash.slice(0, 8) }),
      h('span', { class: 'rl-sel', text: r.selector.replace(/\{\d+\}/, '') }),
      h('span', { class: 'rl-action', text: r.action }),
      h('span', { class: 'fdir', text: fmtDate(r.time) }),
      h('span', { class: 'tb-spacer' }),
      h('button', { class: 'tb-btn small', text: '보기', onclick: async () => (close(), (await import('./log.js')).showCommit(r.hash)) }),
      h('button', { class: 'tb-btn small', text: '브랜치 만들기', onclick: async () => (close(), (await import('./branches.js')).newBranch(r.hash)) }),
      h('button', {
        class: 'tb-btn small danger',
        text: '여기로 리셋',
        onclick: async () => {
          const mode = await choiceDialog(
            `현재 브랜치를 '${r.hash.slice(0, 8)}' (${r.action}) 상태로 되돌립니다.`,
            [
              { label: 'Soft', value: 'soft' },
              { label: 'Mixed', value: 'mixed', primary: true },
              { label: 'Hard', value: 'hard', danger: true },
            ],
            { title: 'Reflog 위치로 리셋' }
          );
          if (!mode) return;
          close();
          op('리셋', () => git('reset', r.hash, mode), { success: '되돌렸습니다.' });
        },
      })
    );
    box.append(row);
  }
  return box;
}

export async function openReflog() {
  const list = await git('reflog', 300).catch((e) => (toast(e.message, 'error'), null));
  if (!list) return;
  const m = modal({
    title: 'Reflog — HEAD 이동 기록',
    body: h(
      'div',
      {},
      h('p', { class: 'adv-help', html: '커밋, 체크아웃, 리셋, 리베이스 등 HEAD 가 움직인 모든 기록입니다. 리셋이나 리베이스로 사라진 커밋도 여기서 찾아 <b>브랜치 만들기</b> 또는 <b>여기로 리셋</b> 으로 되살릴 수 있습니다.' }),
      reflogRows(list, () => m.close())
    ),
    wide: true,
    buttons: [{ label: '닫기', primary: true }],
  });
}
