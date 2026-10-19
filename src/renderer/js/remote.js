// Fetch / Pull / Push
import { h, esc, modal, fmtDate, toast } from './ui.js';
import { state, git, op } from './state.js';

export function doFetch() {
  return op('Fetch', () => git('fetchAll'), { success: '원격 저장소 정보를 가져왔습니다.' });
}

export function doPull() {
  const s = state.status;
  if (!s?.upstream) {
    toast('현재 브랜치에 연결된 원격 브랜치(upstream)가 없습니다. 먼저 Push 하세요.', 'warn', 5000);
    return;
  }
  return op('Pull', () => git('pull', { rebase: !!state.settings.pullRebase }), {
    success: (r) => (/Already up to date/i.test(r?.output || '') ? '이미 최신 상태입니다.' : '업데이트 완료'),
  });
}

// IntelliJ 처럼 Push 할 커밋 목록을 먼저 보여준다.
export async function doPush() {
  let info;
  try {
    info = await git('outgoing');
  } catch (e) {
    return (await import('./ui.js')).errorDialog(e.message, 'Push');
  }
  const s = state.status;
  if (s?.detached) return toast('분리된 HEAD 상태에서는 Push 할 수 없습니다.', 'warn');
  const remotes = await git('remotes');
  if (!remotes.length) {
    const { openSettings } = await import('./repo.js');
    toast('원격 저장소가 없습니다. 설정에서 원격 저장소(origin)를 추가하세요.', 'warn', 5000);
    return openSettings();
  }
  const target = info.newBranch ? `${(remotes.find((r) => r.name === 'origin') || remotes[0]).name}/${info.branch} (새 브랜치)` : info.upstream;
  const force = h('input', { type: 'checkbox' });
  const tags = h('input', { type: 'checkbox' });
  const list = h('div', { class: 'push-list' });
  if (!info.commits.length) list.append(h('div', { class: 'empty', text: info.newBranch ? '원격에 새 브랜치를 만듭니다.' : 'Push 할 커밋이 없습니다.' }));
  for (const c of info.commits) {
    list.append(
      h('div', { class: 'push-item' }, h('span', { class: 'hash', text: c.hash.slice(0, 8) }), h('span', { class: 'subj', text: c.subject }), h('span', { class: 'meta', text: `${c.author} · ${fmtDate(c.time)}` }))
    );
  }
  const body = h(
    'div',
    {},
    h('div', { class: 'push-target', html: `<b>${esc(info.branch)}</b> → <b>${esc(target)}</b> · 커밋 ${info.commits.length}개` }),
    list,
    h('div', { class: 'push-opts' }, h('label', { class: 'check' }, force, ' 강제 Push (--force-with-lease)'), h('label', { class: 'check' }, tags, ' 태그도 Push'))
  );
  modal({
    title: 'Push',
    body,
    wide: true,
    buttons: [
      { label: '취소' },
      {
        label: 'Push',
        primary: true,
        onClick: () => {
          op('Push', () => git('push', { force: force.checked, tags: tags.checked }), { success: 'Push 완료' });
        },
      },
    ],
  });
}
