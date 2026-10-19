// 저장소 열기/만들기/복제, 시작 화면, 설정
import { $, h, esc, menuAt, modal, promptDialog, confirmDialog, toast, errorDialog } from './ui.js';
import { state, git, op, refresh } from './state.js';

let onOpened = () => {};
export const setOnOpened = (fn) => (onOpened = fn);

export async function openRepo(dir) {
  const r = await window.api.openRepo(dir);
  if (!r.ok) {
    if (r.notRepo) {
      const ok = await confirmDialog(`'${dir}' 은(는) Git 저장소가 아닙니다.\n이 폴더에 새 Git 저장소를 만들까요?`, { title: '저장소 아님', okLabel: '새 저장소 만들기' });
      if (ok) return initRepo(dir);
      return;
    }
    return errorDialog(r.error);
  }
  state.repo = r.data;
  state.settings = await window.api.getSettings();
  onOpened();
}

export async function pickAndOpen() {
  const dir = await window.api.pickFolder('Git 저장소 폴더 선택');
  if (dir) openRepo(dir);
}

async function initRepo(dir) {
  dir = dir || (await window.api.pickFolder('새 저장소를 만들 폴더 선택'));
  if (!dir) return;
  const r = await window.api.initRepo(dir);
  if (!r.ok) return errorDialog(r.error);
  toast('새 Git 저장소를 만들었습니다.', 'ok');
  openRepo(dir);
}

export async function cloneDialog() {
  const url = h('input', { class: 'input', placeholder: 'https://github.com/사용자/저장소.git', spellcheck: 'false' });
  const dir = h('input', { class: 'input', placeholder: '저장할 폴더', spellcheck: 'false' });
  const browse = h('button', { class: 'btn', text: '찾아보기...' });
  let parent = state.settings.cloneDir || '';
  const sync = async () => {
    const name = (url.value.trim().split('/').pop() || '').replace(/\.git$/, '');
    if (parent && name) dir.value = await window.api.joinPath(parent, name);
  };
  url.oninput = sync;
  browse.onclick = async () => {
    const p = await window.api.pickFolder('복제할 상위 폴더 선택');
    if (p) {
      parent = p;
      window.api.setSettings({ cloneDir: p });
      sync();
    }
  };
  const body = h('div', { class: 'form' }, h('label', { class: 'form-label', text: '저장소 URL' }), url, h('label', { class: 'form-label', text: '로컬 폴더' }), h('div', { class: 'row' }, dir, browse));
  modal({
    title: '저장소 복제 (Clone)',
    body,
    wide: true,
    buttons: [
      { label: '취소' },
      {
        label: '복제',
        primary: true,
        onClick: async (btn) => {
          if (!url.value.trim() || !dir.value.trim()) {
            toast('URL 과 폴더를 입력하세요.', 'warn');
            return false;
          }
          btn.disabled = true;
          btn.textContent = '복제 중...';
          const r = await window.api.cloneRepo(url.value.trim(), dir.value.trim());
          if (!r.ok) {
            btn.disabled = false;
            btn.textContent = '복제';
            errorDialog(r.error, '복제 실패');
            return false;
          }
          toast('복제 완료', 'ok');
          openRepo(dir.value.trim());
        },
      },
    ],
  });
  setTimeout(() => url.focus(), 0);
}

function repoName(p) {
  return p.split(/[\\/]/).filter(Boolean).pop();
}

export async function repoMenu(anchor) {
  const s = await window.api.getSettings();
  const recent = (s.recent || []).filter((r) => r !== state.repo);
  const remotes = state.repo ? await git('remotes').catch(() => []) : [];
  const web = remotes.map((r) => ({ ...r, web: toWebUrl(r.url) })).filter((r) => r.web);
  menuAt(anchor, [
    state.repo ? { header: state.repo } : null,
    { label: '폴더 열기...', hint: 'Ctrl+O', onClick: pickAndOpen },
    { label: '저장소 복제 (Clone)...', onClick: cloneDialog },
    { label: '새 저장소 만들기 (Init)...', onClick: () => initRepo() },
    state.repo ? '-' : null,
    state.repo ? { label: '탐색기에서 열기', onClick: () => window.api.openPath(state.repo) } : null,
    ...web.map((r) => ({ label: `웹에서 보기 (${r.name})`, onClick: () => window.api.openExternal(r.web) })),
    recent.length ? '-' : null,
    recent.length ? { header: '최근 저장소' } : null,
    ...recent.map((r) => ({ label: repoName(r), hint: r, onClick: () => openRepo(r) })),
  ]);
}

export function toWebUrl(url) {
  let m = url.match(/^git@([^:]+):(.+?)(\.git)?$/);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = url.match(/^https?:\/\/(?:[^@/]+@)?(.+?)(\.git)?$/);
  if (m) return `https://${m[1]}`;
  return null;
}

export async function renderWelcome() {
  const s = await window.api.getSettings();
  const el = $('#welcome');
  el.innerHTML = '';
  const recent = (s.recent || []).map((r) =>
    h(
      'div',
      { class: 'recent-item', onclick: () => openRepo(r), title: r },
      h('div', {}, h('b', { text: repoName(r) }), h('div', { class: 'fdir', text: r })),
      h('button', {
        class: 'tb-btn small',
        text: '✕',
        title: '목록에서 제거',
        onclick: async (e) => {
          e.stopPropagation();
          await window.api.removeRecent(r);
          renderWelcome();
        },
      })
    )
  );
  el.append(
    h(
      'div',
      { class: 'welcome-box' },
      h('div', { class: 'logo', html: '<span>Code</span>Flow' }),
      h('p', { class: 'sub', text: '보기 쉽고 간편한 Git 형상관리 도구' }),
      h(
        'div',
        { class: 'welcome-actions' },
        h('button', { class: 'big-btn', onclick: pickAndOpen }, h('span', { class: 'ico', text: '▣' }), h('b', { text: '저장소 열기' }), h('small', { text: '내 PC의 Git 폴더 열기' })),
        h('button', { class: 'big-btn', onclick: cloneDialog }, h('span', { class: 'ico', text: '⇣' }), h('b', { text: '복제 (Clone)' }), h('small', { text: 'GitHub 등에서 내려받기' })),
        h('button', { class: 'big-btn', onclick: () => initRepo() }, h('span', { class: 'ico', text: '＋' }), h('b', { text: '새 저장소' }), h('small', { text: '폴더를 Git 저장소로 만들기' }))
      ),
      recent.length ? h('div', { class: 'recent' }, h('div', { class: 'recent-title', text: '최근 저장소' }), ...recent) : null
    )
  );
}

export async function openSettings() {
  const s = await window.api.getSettings();
  const cfg = state.repo ? await git('config').catch(() => ({})) : {};
  const remotes = state.repo ? await git('remotes').catch(() => []) : [];
  const name = h('input', { class: 'input', value: cfg.userName || '', placeholder: '홍길동' });
  const email = h('input', { class: 'input', value: cfg.userEmail || '', placeholder: 'me@example.com' });
  const global = h('input', { type: 'checkbox', checked: true });
  const rebase = h('input', { type: 'checkbox', checked: !!s.pullRebase });

  const remoteBox = h('div', { class: 'remote-box' });
  const drawRemotes = (list) => {
    remoteBox.innerHTML = '';
    if (!list.length) remoteBox.append(h('div', { class: 'empty small', text: '원격 저장소가 없습니다. GitHub 저장소 URL 을 추가하세요.' }));
    for (const r of list) {
      remoteBox.append(
        h(
          'div',
          { class: 'remote-row' },
          h('b', { text: r.name }),
          h('span', { class: 'fdir', text: r.url }),
          h('button', {
            class: 'tb-btn small',
            text: '수정',
            onclick: async () => {
              const url = await promptDialog(`'${r.name}' 의 URL`, { value: r.url, title: '원격 저장소 수정' });
              if (url) {
                await op('원격 수정', () => git('setRemoteUrl', r.name, url));
                drawRemotes(await git('remotes'));
              }
            },
          }),
          h('button', {
            class: 'tb-btn small danger',
            text: '삭제',
            onclick: async () => {
              if (await confirmDialog(`원격 저장소 '${r.name}' 연결을 제거합니다. (원격의 실제 데이터는 삭제되지 않습니다)`, { danger: true, okLabel: '제거' })) {
                await op('원격 삭제', () => git('removeRemote', r.name));
                drawRemotes(await git('remotes'));
              }
            },
          })
        )
      );
    }
  };
  drawRemotes(remotes);
  const addRemote = h('button', {
    class: 'btn small',
    text: '＋ 원격 저장소 추가',
    onclick: async () => {
      const url = await promptDialog('원격 저장소 URL', { title: '원격 저장소 추가', placeholder: 'https://github.com/사용자/저장소.git' });
      if (!url) return;
      const nm = remotes.length ? await promptDialog('원격 이름', { value: 'upstream' }) : 'origin';
      if (!nm) return;
      await op('원격 추가', () => git('addRemote', nm, url), { success: `'${nm}' 추가됨` });
      drawRemotes(await git('remotes'));
    },
  });

  const body = h(
    'div',
    { class: 'form settings' },
    state.repo ? h('h4', { text: '사용자 정보 (커밋 작성자)' }) : null,
    state.repo ? h('label', { class: 'form-label', text: '이름' }) : null,
    state.repo ? name : null,
    state.repo ? h('label', { class: 'form-label', text: '이메일' }) : null,
    state.repo ? email : null,
    state.repo ? h('label', { class: 'check' }, global, ' 모든 저장소에 적용 (global)') : null,
    state.repo ? h('h4', { text: '원격 저장소' }) : null,
    state.repo ? remoteBox : null,
    state.repo ? addRemote : null,
    h('h4', { text: '동작' }),
    h('label', { class: 'check' }, rebase, ' Pull 할 때 병합(merge) 대신 리베이스(rebase) 사용')
  );
  modal({
    title: '설정',
    body,
    wide: true,
    buttons: [
      { label: '닫기' },
      {
        label: '저장',
        primary: true,
        onClick: async () => {
          state.settings = await window.api.setSettings({ pullRebase: rebase.checked });
          if (state.repo && (name.value !== (cfg.userName || '') || email.value !== (cfg.userEmail || '') || !global.checked)) {
            const r = await op('설정 저장', () => git('setConfig', { userName: name.value.trim(), userEmail: email.value.trim(), global: global.checked }));
            if (r && typeof r === 'symbol') return false;
          }
          toast('설정을 저장했습니다.', 'ok');
          refresh();
        },
      },
    ],
  });
}
