// Fetch / Pull / Push
import { h, esc, modal, fmtDate, toast, contextMenu } from './ui.js';
import { state, git, op } from './state.js';

// 툴바의 ☁ 원격: 이 프로젝트에서 쓸 원격을 고른다 (Pull/Push 대상이 바뀐다)
export async function openRemoteMenu(anchor) {
  const remotes = await git('remotes').catch(() => []);
  const cur = state.status?.remote;
  const r = anchor.getBoundingClientRect();
  const { openSettings } = await import('./repo.js');
  contextMenu(r.left, r.bottom + 2, [
    { header: 'Pull / Push 할 원격 저장소' },
    ...remotes.map((x) => ({
      label: `${x.name === cur ? '✓ ' : '　 '}${x.name}`,
      hint: x.url.replace(/^https?:\/\//, '').replace(/\.git$/, ''),
      onClick: () => x.name !== cur && switchRemote(x.name),
    })),
    '-',
    { label: '원격 저장소 추가·관리...', onClick: () => openSettings() },
  ]);
}

async function switchRemote(name) {
  const branch = state.status?.branch;
  const r = await op('원격 바꾸기', () => git('useRemote', name), {
    success: (x) => (x?.tracked ? `이제 '${name}' 을(를) 씁니다 — ${x.tracked} 에 연결했습니다.` : branch ? `이제 '${name}' 을(를) 씁니다. '${name}' 에는 아직 ${branch} 브랜치가 없어서 Push 하면 새로 만듭니다.` : `이제 '${name}' 을(를) 씁니다.`),
  });
  return r;
}

export function doFetch() {
  return op('Fetch', () => git('fetchAll'), { success: '원격 저장소 정보를 가져왔습니다.' });
}

export function doPull() {
  const s = state.status;
  if (!s?.upstream) {
    toast(s?.remote ? `'${s.remote}' 에 현재 브랜치가 없습니다. 먼저 Push 하거나 툴바의 ☁ 에서 다른 원격을 고르세요.` : '현재 브랜치에 연결된 원격 브랜치(upstream)가 없습니다. 먼저 Push 하세요.', 'warn', 5000);
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
  if (!info.remotes?.length) {
    const { openSettings } = await import('./repo.js');
    toast('원격 저장소가 없습니다. 설정에서 원격 저장소(origin)를 추가하세요.', 'warn', 5000);
    return openSettings();
  }
  const cur = info.remote;
  const force = h('input', { type: 'checkbox' });
  const tags = h('input', { type: 'checkbox' });
  const list = h('div', { class: 'push-list' });
  const head = h('div', { class: 'push-target' });
  // 원격이 2개 이상이면 이번에 올릴 원격을 고를 수 있다 (고른 원격은 이번 Push 에만 쓰고, 연결은 그대로)
  const pick = info.remotes.length > 1 ? h('select', { class: 'input push-remote' }, ...info.remotes.map((n) => h('option', { value: n, text: n === cur ? `${n} (지금 쓰는 원격)` : n }))) : null;
  if (pick) pick.value = cur;
  const draw = () => {
    const target = info.newBranch ? `${info.remote}/${info.branch} (새 브랜치)` : info.upstream;
    head.innerHTML = `<b>${esc(info.branch)}</b> → <b>${esc(target)}</b> · 커밋 ${info.commits.length}개`;
    list.innerHTML = '';
    if (!info.commits.length) list.append(h('div', { class: 'empty', text: info.newBranch ? '원격에 새 브랜치를 만듭니다.' : 'Push 할 커밋이 없습니다.' }));
    for (const c of info.commits) {
      list.append(
        h('div', { class: 'push-item' }, h('span', { class: 'hash', text: c.hash.slice(0, 8) }), h('span', { class: 'subj', text: c.subject }), h('span', { class: 'meta', text: `${c.author} · ${fmtDate(c.time)}` }))
      );
    }
  };
  if (pick)
    pick.onchange = async () => {
      try {
        info = await git('outgoing', pick.value);
        draw();
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  draw();
  const body = h(
    'div',
    {},
    pick ? h('div', { class: 'push-remote-row' }, h('span', { text: '올릴 원격' }), pick) : null,
    head,
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
          const remote = pick?.value || cur;
          op('Push', () => git('push', { force: force.checked, tags: tags.checked, remote }), { success: remote === cur ? 'Push 완료' : `'${remote}' 에 Push 완료` });
        },
      },
    ],
  });
}
