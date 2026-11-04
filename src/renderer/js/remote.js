// Fetch / Pull / Push
import { h, esc, modal, fmtDate, toast, contextMenu, choiceDialog, confirmDialog } from './ui.js';
import { state, git, op, FAILED } from './state.js';

// 툴바의 ☁ 원격: 원격이 여러 개여도 프로젝트 전체를 바꾸지 않는다. 로컬 브랜치마다 추적할 원격 브랜치를 정한다
export async function openRemoteMenu(anchor) {
  const remotes = await git('remotes').catch(() => []);
  const s = state.status;
  const r = anchor.getBoundingClientRect();
  const { openSettings } = await import('./repo.js');
  const onBranch = s?.branch && !s.detached;
  contextMenu(r.left, r.bottom + 2, [
    { header: onBranch ? `${s.branch} → ${s.upstream || `추적 없음 (Push 하면 ${s.remote}/${s.branch})`}` : '분리된 HEAD' },
    { label: '이 브랜치의 추적 브랜치 변경...', disabled: !onBranch, onClick: () => openTrackDialog(remotes) },
    { label: '원격 브랜치를 새 로컬 브랜치로 가져오기...', disabled: !remotes.length, onClick: () => openLocalFromRemote(remotes) },
    '-',
    { header: '등록된 원격 저장소' },
    ...remotes.map((x) => ({ label: x.name, hint: x.url.replace(/^https?:\/\//, '').replace(/\.git$/, ''), disabled: true })),
    '-',
    { label: '원격 저장소 추가·관리...', onClick: () => openSettings() },
  ]);
}

// 원격과 그 원격의 브랜치를 고르는 칸. 원격을 고르면 그 원격의 최신 브랜치 목록을 가져온다
function remoteBranchPicker(remotes, { remote, branch, onChange } = {}) {
  const rs = h('select', { class: 'input' }, ...remotes.map((x) => h('option', { value: x.name, text: x.name })));
  const bs = h('select', { class: 'input' });
  const note = h('div', { class: 'form-hint' });
  rs.value = remotes.some((x) => x.name === remote) ? remote : remotes[0].name;
  const load = async (prefer) => {
    const name = rs.value;
    note.textContent = '원격 브랜치 목록을 가져오는 중...';
    let failed = '';
    try {
      await git('fetchRemote', name);
    } catch (e) {
      failed = `최신 목록을 가져오지 못했습니다: ${(e.message || '').split('\n').pop()}`;
    }
    const list = (await git('branches')).remote.filter((b) => b.name.startsWith(`${name}/`)).map((b) => b.name.slice(name.length + 1));
    if (rs.value !== name) return;
    bs.replaceChildren(...list.map((n) => h('option', { value: n, text: n })));
    if (list.includes(prefer)) bs.value = prefer;
    note.textContent = failed || (list.length ? '' : `'${name}' 에 브랜치가 없습니다.`);
    onChange?.();
  };
  rs.onchange = () => load(bs.value);
  bs.onchange = () => onChange?.();
  load(branch);
  return {
    el: h('div', { class: 'form' }, h('label', { class: 'form-label', text: '원격 저장소' }), rs, h('label', { class: 'form-label', text: '원격 브랜치' }), bs, note),
    remote: () => rs.value,
    branch: () => bs.value,
  };
}

function openTrackDialog(remotes) {
  const s = state.status;
  const up = s.upstream && s.upstream.startsWith(`${s.remote}/`) ? s.upstream.slice(s.remote.length + 1) : s.branch;
  const p = remoteBranchPicker(remotes, { remote: s.remote, branch: up });
  modal({
    title: `'${s.branch}' 의 추적 브랜치`,
    body: h('div', {}, h('p', { class: 'msg', text: '이 로컬 브랜치의 Pull / Push 대상을 정합니다. 다른 로컬 브랜치에는 영향을 주지 않습니다.' }), p.el),
    buttons: [
      { label: '취소' },
      s.upstream ? { label: '추적 끊기', onClick: () => op('추적 브랜치 변경', () => git('setUpstream', null), { success: `'${s.branch}' 의 추적을 끊었습니다.` }) } : null,
      {
        label: '적용',
        primary: true,
        onClick: () => {
          if (!p.branch()) return toast('원격 브랜치를 고르세요.', 'warn'), false;
          const target = `${p.remote()}/${p.branch()}`;
          return op('추적 브랜치 변경', () => git('setUpstream', target), { success: `'${s.branch}' → ${target}` });
        },
      },
    ].filter(Boolean),
  });
}

async function openLocalFromRemote(remotes) {
  const locals = (await git('branches')).local.map((b) => b.name);
  const name = h('input', { class: 'input', spellcheck: 'false' });
  let edited = false;
  name.oninput = () => (edited = true);
  const p = remoteBranchPicker(remotes, {
    remote: remotes.find((x) => x.name !== state.status?.remote)?.name,
    onChange: () => {
      if (edited || !p?.branch()) return;
      name.value = locals.includes(p.branch()) ? `${p.branch()}-${p.remote()}` : p.branch();
    },
  });
  modal({
    title: '원격 브랜치를 새 로컬 브랜치로',
    body: h('div', { class: 'form' }, p.el, h('label', { class: 'form-label', text: '새 로컬 브랜치 이름' }), name),
    buttons: [
      { label: '취소' },
      {
        label: '만들고 체크아웃',
        primary: true,
        onClick: () => {
          const local = name.value.trim().replace(/\s+/g, '-');
          if (!p.branch() || !local) return toast('원격 브랜치와 이름을 정하세요.', 'warn'), false;
          const target = `${p.remote()}/${p.branch()}`;
          return op('브랜치 생성', () => git('checkoutRemote', target, local), { success: `'${local}' → ${target}` });
        },
      },
    ],
  });
}

export function doFetch() {
  return op('Fetch', () => git('fetchAll'), { success: '원격 저장소 정보를 가져왔습니다.' });
}

export function doPull() {
  const s = state.status;
  if (!s?.upstream) {
    toast(`'${s?.branch}' 이(가) 추적하는 원격 브랜치가 없습니다. 먼저 Push 하거나 툴바의 ☁ 에서 추적 브랜치를 정하세요.`, 'warn', 5000);
    return;
  }
  return pullFrom();
}

// remote, branch 를 주면 추적 브랜치 대신 그 원격 브랜치에서 가져온다. 끝까지 합쳐졌으면 true
async function pullFrom(remote, branch) {
  let merged = false;
  const r = await op('Pull', () => git('pull', { rebase: !!state.settings.pullRebase, remote, branch }), {
    success: (x) => (/Already up to date/i.test(x?.output || '') ? '이미 최신 상태입니다.' : '업데이트 완료'),
    onError: async (e) => {
      if (!/refusing to merge unrelated histories/i.test(e.message || '')) return false;
      merged = await mergeUnrelated(remote, branch);
      return true;
    },
  });
  return merged || (r !== FAILED && !r?.conflict);
}

// 같은 프로젝트라도 원격마다 첫 커밋부터 따로 만들어졌으면 git 은 합치기를 거부한다
async function mergeUnrelated(remote, branch) {
  const target = remote ? `${remote}/${branch}` : state.status?.upstream;
  const v = await choiceDialog(
    `'${target}' 은(는) 지금 브랜치와 이력이 전혀 이어져 있지 않습니다. GitLab 에서 프로젝트를 만들 때 README 같은 첫 커밋이 생겼거나, 코드를 따로 올렸을 때 이렇게 됩니다.\n\n두 이력을 합치면 양쪽 파일이 모두 들어오고, 같은 파일의 내용이 다르면 충돌 화면이 뜹니다. 합친 뒤 다른 원격에 Push 하면 이 원격의 이력도 함께 올라갑니다.\n\n각 저장소의 이력을 따로 유지하려면 취소하고, 이 원격 브랜치용 로컬 브랜치를 만들어 커밋을 체리픽하세요.`,
    [{ label: '두 이력 합치기', value: 'merge', primary: true }],
    { title: 'Pull - 이력이 서로 다릅니다' }
  );
  if (v !== 'merge') return false;
  const r = await op('Pull', () => git('pull', { allowUnrelated: true, remote, branch }), { success: '두 이력을 합쳤습니다.' });
  return r !== FAILED && !r?.conflict;
}

function runPush(remote, branch, opts) {
  return op('Push', () => git('push', { ...opts, remote, branch }), {
    success: `${remote}/${branch} 에 Push 완료`,
    onError: async (e) => {
      const m = e.message || '';
      if (!/\[rejected\]|non-fast-forward|fetch first|stale info/i.test(m) || /protected branch|hook declined/i.test(m)) return false;
      await pushRejected(remote, branch, opts);
      return true;
    },
  });
}

// 원격에 이 PC 에 없는 커밋이 있어서 거부된 경우: 합치고 올리거나, 덮어쓴다
async function pushRejected(remote, branch, opts) {
  const target = `${remote}/${branch}`;
  const v = await choiceDialog(
    `'${target}' 에 이 PC 의 '${state.status?.branch}' 에 없는 커밋이 있어서 서버가 Push 를 거부했습니다.\n\n가져와 합친 뒤 Push 하거나, 서버의 내용을 내 커밋으로 덮어쓸 수 있습니다.`,
    [
      { label: '강제 Push...', value: 'force', danger: true },
      { label: '가져와 합친 뒤 Push', value: 'pull', primary: true },
    ],
    { title: 'Push 거부됨' }
  );
  if (v === 'pull') {
    if (await pullFrom(remote, branch)) return runPush(remote, branch, { ...opts, force: false });
    return;
  }
  if (v !== 'force') return;
  let lost;
  const r = await op('원격 확인', async () => (lost = await git('remoteOnly', remote, branch)), { refresh: false });
  if (r === FAILED) return;
  const ok = await confirmDialog(`'${target}' 을(를) 지금 브랜치 내용으로 덮어씁니다. 아래 커밋 ${lost.length}개는 서버에서 사라지고, 다른 사람에게도 영향을 줍니다.`, {
    title: '강제 Push',
    okLabel: '덮어쓰기',
    danger: true,
    detail: lost.join('\n') || '(사라지는 커밋 없음)',
  });
  if (ok) return runPush(remote, branch, { ...opts, force: true });
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
  const force = h('input', { type: 'checkbox' });
  const tags = h('input', { type: 'checkbox' });
  const list = h('div', { class: 'push-list' });
  const head = h('div', { class: 'push-target' });
  // Push 대상은 브랜치의 추적 설정을 따른다. 여기서 바꾼 대상은 이번 Push 에만 쓰고, 추적은 그대로 둔다
  const pick = info.remotes.length > 1 ? h('select', { class: 'input push-remote' }, ...info.remotes.map((n) => h('option', { value: n, text: n }))) : null;
  if (pick) pick.value = info.remote;
  const target = h('input', { class: 'input push-branch', spellcheck: 'false', value: info.targetBranch || '' });
  const draw = () => {
    const note = info.newBranch ? ' (새 브랜치)' : '';
    const moved = info.upstream && info.upstream !== info.target ? ` <span class="push-note">이번만 · 추적은 ${esc(info.upstream)} 그대로</span>` : '';
    head.innerHTML = `<b>${esc(info.branch)}</b> → <b>${esc(info.target)}</b>${note} · 커밋 ${info.commits.length}개${moved}`;
    list.innerHTML = '';
    if (!info.commits.length) list.append(h('div', { class: 'empty', text: info.newBranch ? '원격에 새 브랜치를 만듭니다.' : 'Push 할 커밋이 없습니다.' }));
    for (const c of info.commits) {
      list.append(
        h('div', { class: 'push-item' }, h('span', { class: 'hash', text: c.hash.slice(0, 8) }), h('span', { class: 'subj', text: c.subject }), h('span', { class: 'meta', text: `${c.author} · ${fmtDate(c.time)}` }))
      );
    }
  };
  let asked = 0;
  const reload = async (branch) => {
    const mine = ++asked;
    try {
      const x = await git('outgoing', pick?.value || info.remote, branch);
      if (mine !== asked) return;
      info = x;
      if (!branch) target.value = x.targetBranch || '';
      draw();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  if (pick) pick.onchange = () => reload(target.value.trim());
  let timer;
  target.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => target.value.trim() && reload(target.value.trim()), 300);
  };
  draw();
  const body = h(
    'div',
    {},
    h('div', { class: 'push-remote-row' }, pick ? h('span', { text: '원격' }) : null, pick, h('span', { text: '원격 브랜치' }), target),
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
          clearTimeout(timer);
          runPush(pick?.value || info.remote, target.value.trim() || info.targetBranch, { force: force.checked, tags: tags.checked });
        },
      },
    ],
  });
}
