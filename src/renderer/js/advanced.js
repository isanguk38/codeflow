// 고급 화면: Reflog, Bisect, Submodule, Worktree, Git LFS, 정리(Clean), 커밋 서명
import { $, h, esc, fmtDate, modal, promptDialog, confirmDialog, choiceDialog, toast, errorDialog } from './ui.js';
import { state, git, op, onRefresh, refresh, busy } from './state.js';

const SECTIONS = [
  { key: 'reflog', label: 'Reflog', ico: '↺', desc: 'HEAD 이동 기록 — 잃어버린 커밋 되살리기' },
  { key: 'bisect', label: 'Bisect', ico: '⌖', desc: '문제가 처음 생긴 커밋 찾기' },
  { key: 'submodule', label: 'Submodule', ico: '⊞', desc: '저장소 안의 하위 저장소' },
  { key: 'worktree', label: 'Worktree', ico: '⧉', desc: '여러 브랜치를 다른 폴더에 동시에 체크아웃' },
  { key: 'lfs', label: 'Git LFS', ico: '⬢', desc: '대용량 파일 관리' },
  { key: 'clean', label: '정리 (Clean)', ico: '✧', desc: '추적되지 않는 파일 한 번에 정리' },
  { key: 'sign', label: '커밋 서명', ico: '✎', desc: 'GPG / SSH 서명' },
];

let current = 'reflog';
let root;

export function initAdvanced() {
  root = $('#view-advanced');
  root.innerHTML = `<div class="adv-nav" id="advNav"></div><div class="adv-body" id="advBody"></div>`;
  const nav = $('#advNav');
  for (const s of SECTIONS) {
    const el = h('div', { class: 'adv-item', 'data-key': s.key, title: s.desc }, h('span', { class: 'ti-ico', text: s.ico }), h('div', {}, h('div', { text: s.label }), h('small', { text: s.desc })));
    el.onclick = () => {
      current = s.key;
      load();
    };
    nav.append(el);
  }
  onRefresh(() => state.view === 'advanced' && load());
}

export const activateAdvanced = () => load();

export function showSection(key) {
  current = key;
  document.querySelector('.rail-btn[data-view="advanced"]')?.click();
}

async function load() {
  if (!state.repo) return;
  document.querySelectorAll('.adv-item').forEach((e) => e.classList.toggle('active', e.dataset.key === current));
  const body = $('#advBody');
  const sec = SECTIONS.find((s) => s.key === current);
  const content = h('div', { class: 'adv-content' });
  body.innerHTML = '';
  body.append(h('div', { class: 'adv-title' }, h('h3', { text: sec.label }), h('span', { class: 'fdir', text: sec.desc })), content);
  const loading = h('div', { class: 'empty small', text: '불러오는 중...' });
  content.append(loading);
  try {
    await RENDER[current](content);
    loading.remove();
  } catch (e) {
    loading.remove();
    content.append(h('div', { class: 'empty', text: e.message }));
  }
}

const card = (...children) => h('div', { class: 'adv-card' }, ...children);
const help = (html) => h('p', { class: 'adv-help', html });

// ---------- Reflog ----------

function reflogRows(list, onAfter) {
  const box = h('div', { class: 'adv-list' });
  if (!list.length) box.append(h('div', { class: 'empty small', text: '기록이 없습니다.' }));
  for (const r of list) {
    const row = h(
      'div',
      { class: 'adv-row' },
      h('span', { class: 'hash', text: r.hash.slice(0, 8) }),
      h('span', { class: 'rl-sel', text: r.selector.replace(/\{\d+\}/, '') }),
      h('span', { class: 'rl-action', text: r.action }),
      h('span', { class: 'fdir', text: fmtDate(r.time) }),
      h('span', { class: 'tb-spacer' }),
      h('button', { class: 'tb-btn small', text: '보기', onclick: async () => (onAfter?.(), (await import('./log.js')).showCommit(r.hash)) }),
      h('button', { class: 'tb-btn small', text: '브랜치 만들기', onclick: async () => (onAfter?.(), (await import('./branches.js')).newBranch(r.hash)) }),
      h('button', {
        class: 'tb-btn small danger',
        text: '여기로 리셋',
        onclick: async () => {
          const mode = await choiceDialog(`현재 브랜치를 '${r.hash.slice(0, 8)}' (${r.action}) 상태로 되돌립니다.`, [
            { label: 'Soft', value: 'soft' },
            { label: 'Mixed', value: 'mixed', primary: true },
            { label: 'Hard', value: 'hard', danger: true },
          ], { title: 'Reflog 위치로 리셋' });
          if (mode) {
            onAfter?.();
            op('리셋', () => git('reset', r.hash, mode), { success: '되돌렸습니다.' });
          }
        },
      })
    );
    row.title = r.subject;
    box.append(row);
  }
  return box;
}

export async function openReflog() {
  const list = await git('reflog', 300).catch((e) => (toast(e.message, 'error'), null));
  if (!list) return;
  const m = modal({
    title: 'Reflog — HEAD 이동 기록',
    body: h('div', {}, help('커밋, 체크아웃, 리셋, 리베이스 등 HEAD 가 움직인 모든 기록입니다. 리셋이나 리베이스로 사라진 커밋도 여기서 찾아 <b>브랜치 만들기</b> 또는 <b>여기로 리셋</b> 으로 되살릴 수 있습니다.'), reflogRows(list, () => m.close())),
    wide: true,
    buttons: [{ label: '닫기', primary: true }],
  });
}

const RENDER = {};

RENDER.reflog = async (el) => {
  el.append(help('커밋, 체크아웃, 리셋, 리베이스 등 HEAD 가 움직인 모든 기록입니다. 실수로 Hard Reset 하거나 리베이스로 커밋이 사라졌다면 여기서 찾아서 <b>브랜치 만들기</b> 또는 <b>여기로 리셋</b> 으로 되살리세요.'));
  el.append(reflogRows(await git('reflog', 300)));
};

// ---------- Bisect ----------

export async function startBisect(bad, good) {
  const ok = await confirmDialog(
    `Bisect 를 시작합니다.\n문제 있음(bad): ${bad.slice(0, 12)}\n정상(good): ${good.slice(0, 12)}\n\nCodeFlow 가 중간 커밋을 차례로 체크아웃합니다. 각 단계에서 프로그램을 확인하고 '정상' 또는 '문제 있음' 을 누르면 문제가 처음 생긴 커밋을 찾아줍니다.`,
    { title: 'Bisect 시작', okLabel: '시작' }
  );
  if (ok) op('Bisect 시작', () => git('bisectStart', bad, good), { success: (out) => firstLine(out), smart: false });
}

export function markBisect(term, rev) {
  op(`Bisect ${term}`, () => git('bisectMark', term, rev), {
    smart: false,
    success: (out) => {
      const found = out.match(/([0-9a-f]{7,40}) is the first bad commit/);
      if (found) setTimeout(() => showSection('bisect'), 300);
      return found ? `찾았습니다! 문제가 처음 생긴 커밋: ${found[1].slice(0, 8)}` : firstLine(out);
    },
  });
}

const firstLine = (s) => (s || '').split('\n')[0].replace(/^Bisecting: (\d+) revisions? left to test after this.*$/, '남은 확인 횟수: 약 $1번 — 프로그램을 확인한 뒤 정상/문제 있음을 표시하세요.');

RENDER.bisect = async (el) => {
  const info = await git('bisectInfo');
  if (!info.active) {
    el.append(help('어느 커밋부터 버그가 생겼는지 모를 때, 정상이던 커밋과 문제가 있는 커밋 사이를 반씩 나눠 가며 빠르게 찾아줍니다. 커밋 1000개도 약 10번 확인이면 찾을 수 있습니다.<br>히스토리 화면에서 정상이던 커밋을 우클릭 → <b>Bisect 시작</b> 으로도 시작할 수 있습니다.'));
    const bad = h('input', { class: 'input', value: 'HEAD' });
    const good = h('input', { class: 'input', placeholder: '정상이던 커밋 해시 또는 태그 (예: v1.0)' });
    el.append(
      card(
        h('label', { class: 'form-label', text: '문제 있는 커밋 (bad)' }),
        bad,
        h('label', { class: 'form-label', text: '정상이던 커밋 (good)' }),
        good,
        h('button', { class: 'btn primary', text: 'Bisect 시작', onclick: () => (good.value.trim() ? startBisect(bad.value.trim() || 'HEAD', good.value.trim()) : toast('정상이던 커밋을 입력하세요.', 'warn')) })
      )
    );
    return;
  }
  if (info.found) {
    el.append(
      card(
        h('div', { class: 'bisect-found', html: `🎯 문제가 처음 생긴 커밋: <b>${esc(info.found.hash.slice(0, 8))}</b> ${esc(info.found.subject)}` }),
        h('div', { class: 'row-btns' }, h('button', { class: 'btn', text: '커밋 보기', onclick: async () => (await import('./log.js')).showCommit(info.found.hash) }), h('button', { class: 'btn primary', text: 'Bisect 종료 (원래 브랜치로)', onclick: () => op('Bisect 종료', () => git('bisectReset'), { success: 'Bisect 를 종료했습니다.' }) }))
      )
    );
    return;
  }
  el.append(
    card(
      h('div', { html: `현재 확인할 커밋: <b class="hash">${esc(info.head.slice(0, 8))}</b>${info.remaining ? ` · 남은 후보 약 ${esc(info.remaining)}개` : ''}` }),
      help('지금 작업 폴더가 이 커밋 상태로 바뀌어 있습니다. 프로그램을 실행/테스트해 보고 결과를 눌러 주세요.'),
      h(
        'div',
        { class: 'row-btns' },
        h('button', { class: 'btn primary', text: '✔ 정상 (good)', onclick: () => markBisect('good') }),
        h('button', { class: 'btn danger', text: '✘ 문제 있음 (bad)', onclick: () => markBisect('bad') }),
        h('button', { class: 'btn', text: '건너뛰기 (skip)', onclick: () => markBisect('skip') }),
        h('span', { class: 'tb-spacer' }),
        h('button', { class: 'btn', text: 'Bisect 중단', onclick: () => op('Bisect 종료', () => git('bisectReset'), { success: '원래 브랜치로 돌아왔습니다.' }) })
      )
    )
  );
};

// ---------- Submodule ----------

RENDER.submodule = async (el) => {
  el.append(help('Submodule 은 이 저장소 안에 다른 Git 저장소를 특정 커밋으로 고정해서 포함하는 기능입니다. Clone 직후 하위 저장소 폴더가 비어 있다면 <b>초기화/업데이트</b> 를 누르세요.'));
  const list = await git('submodules');
  const STATE = { ok: '정상', uninitialized: '초기화 안 됨', modified: '다른 커밋을 가리킴', conflict: '충돌' };
  const box = h('div', { class: 'adv-list' });
  if (!list.length) box.append(h('div', { class: 'empty small', text: '이 저장소에는 Submodule 이 없습니다.' }));
  for (const s of list) {
    box.append(
      h(
        'div',
        { class: 'adv-row' },
        h('b', { text: s.path }),
        h('span', { class: `sm-state s-${s.state}`, text: STATE[s.state] }),
        h('span', { class: 'hash', text: s.sha.slice(0, 8) }),
        h('span', { class: 'fdir', text: s.url }),
        h('span', { class: 'tb-spacer' }),
        h('button', { class: 'tb-btn small', text: '탭으로 열기', disabled: s.state === 'uninitialized', onclick: async () => openInTab(await window.api.joinPath(state.repo, s.path)) })
      )
    );
  }
  el.append(
    box,
    h(
      'div',
      { class: 'row-btns' },
      h('button', { class: 'btn primary', text: '초기화/업데이트 (update --init --recursive)', onclick: () => op('Submodule 업데이트', () => git('submoduleUpdate'), { success: 'Submodule 을 업데이트했습니다.' }) }),
      h('button', { class: 'btn', text: 'URL 동기화 (sync)', onclick: () => op('Submodule 동기화', () => git('submoduleSync'), { success: '동기화 완료' }) }),
      h('button', {
        class: 'btn',
        text: '＋ Submodule 추가',
        onclick: async () => {
          const url = await promptDialog('하위 저장소 URL', { title: 'Submodule 추가', placeholder: 'https://github.com/사용자/라이브러리.git' });
          if (!url) return;
          const p = await promptDialog('넣을 폴더 경로 (저장소 기준)', { value: `libs/${url.split('/').pop().replace(/\.git$/, '')}` });
          if (p) op('Submodule 추가', () => git('submoduleAdd', url, p), { success: '추가했습니다. 커밋 화면에서 .gitmodules 와 함께 커밋하세요.' });
        },
      })
    )
  );
};

// ---------- Worktree ----------

RENDER.worktree = async (el) => {
  el.append(help('Worktree 를 쓰면 지금 작업을 보관(stash)하지 않고도 다른 브랜치를 <b>다른 폴더</b> 에 동시에 체크아웃해서 작업할 수 있습니다. 예: 기능 개발 중에 급한 버그 수정을 별도 폴더에서 진행.'));
  const list = await git('worktrees');
  const box = h('div', { class: 'adv-list' });
  for (const w of list) {
    box.append(
      h(
        'div',
        { class: 'adv-row' },
        h('span', { class: 'ti-ico', text: w.current ? '★' : '⧉' }),
        h('b', { text: w.branch || (w.detached ? `HEAD (${(w.head || '').slice(0, 8)})` : '-') }),
        h('span', { class: 'fdir', text: w.path }),
        w.locked ? h('span', { class: 'sm-state', text: '잠김' }) : null,
        w.prunable ? h('span', { class: 'sm-state s-conflict', text: '폴더 없음' }) : null,
        h('span', { class: 'tb-spacer' }),
        w.current ? h('span', { class: 'fdir', text: '현재 저장소' }) : h('button', { class: 'tb-btn small', text: '탭으로 열기', disabled: w.prunable, onclick: () => openInTab(w.path) }),
        w.current
          ? null
          : h('button', {
              class: 'tb-btn small danger',
              text: '제거',
              onclick: async () => {
                if (!(await confirmDialog(`Worktree '${w.path}' 를 제거합니다. 그 폴더의 커밋하지 않은 변경은 사라집니다.`, { danger: true, okLabel: '제거' }))) return;
                const r = await window.api.git.worktreeRemove(state.repo, w.path, false);
                if (!r.ok && /contains modified or untracked files/i.test(r.error)) {
                  if (await confirmDialog('그 폴더에 변경된 파일이 있습니다. 강제로 제거할까요?', { danger: true, okLabel: '강제 제거' })) await op('Worktree 제거', () => git('worktreeRemove', w.path, true));
                } else if (!r.ok) errorDialog(r.error);
                load();
              },
            })
      )
    );
  }
  el.append(
    box,
    h(
      'div',
      { class: 'row-btns' },
      h('button', { class: 'btn primary', text: '＋ Worktree 추가', onclick: addWorktree }),
      h('button', { class: 'btn', text: '정리 (prune)', title: '삭제된 폴더의 Worktree 기록 정리', onclick: () => op('Worktree 정리', () => git('worktreePrune'), { success: '정리했습니다.' }) })
    )
  );
};

async function addWorktree() {
  const br = await git('branches');
  const sel = h('select', { class: 'input' }, h('option', { value: '', text: '＋ 새 브랜치 만들기' }), ...br.local.filter((b) => !b.current).map((b) => h('option', { value: b.name, text: b.name })), ...br.remote.map((b) => h('option', { value: b.name, text: b.name })));
  const newName = h('input', { class: 'input', placeholder: '새 브랜치 이름 (예: hotfix/login)' });
  const dir = h('input', { class: 'input', placeholder: '폴더 경로' });
  const browse = h('button', { class: 'btn', text: '찾아보기...' });
  const repoName = state.repo.split(/[\\/]/).pop();
  const parent = state.repo.replace(/[\\/][^\\/]+$/, '');
  const sync = async () => {
    const name = (sel.value || newName.value || 'worktree').replace(/^[^/]+\//, (m) => (br.remote.some((b) => b.name === sel.value) ? '' : m)).replace(/[\\/]/g, '-');
    dir.value = await window.api.joinPath(parent, `${repoName}-${name}`);
    newName.disabled = !!sel.value;
  };
  sel.onchange = sync;
  newName.oninput = sync;
  browse.onclick = async () => {
    const p = await window.api.pickFolder('Worktree 를 만들 상위 폴더');
    if (p) dir.value = await window.api.joinPath(p, `${repoName}-${(sel.value || newName.value || 'worktree').replace(/[\\/]/g, '-')}`);
  };
  sync();
  modal({
    title: 'Worktree 추가',
    body: h('div', { class: 'form' }, h('label', { class: 'form-label', text: '브랜치' }), sel, newName, h('label', { class: 'form-label', text: '폴더 (비어 있거나 없는 폴더)' }), h('div', { class: 'row' }, dir, browse)),
    wide: true,
    buttons: [
      { label: '취소' },
      {
        label: '추가',
        primary: true,
        onClick: async () => {
          const isRemote = br.remote.some((b) => b.name === sel.value);
          const opts = sel.value ? (isRemote ? { dir: dir.value, branch: sel.value, newBranch: sel.value.split('/').slice(1).join('/') } : { dir: dir.value, branch: sel.value }) : { dir: dir.value, newBranch: newName.value.trim() };
          if (!sel.value && !opts.newBranch) {
            toast('새 브랜치 이름을 입력하세요.', 'warn');
            return false;
          }
          const r = await op('Worktree 추가', () => git('worktreeAdd', opts), { success: 'Worktree 를 만들었습니다.' });
          if (typeof r !== 'symbol' && (await confirmDialog('새 Worktree 를 탭으로 열까요?', { okLabel: '열기' }))) openInTab(dir.value);
        },
      },
    ],
  });
}

// ---------- LFS ----------

RENDER.lfs = async (el) => {
  const info = await git('lfsInfo');
  if (!info.installed) {
    el.append(help('Git LFS 가 설치되어 있지 않습니다. Git for Windows 설치 시 기본 포함되며, 별도 설치는 <a href="#" id="lfsLink">git-lfs.com</a> 에서 할 수 있습니다.'));
    el.querySelector('#lfsLink').onclick = (e) => (e.preventDefault(), window.api.openExternal('https://git-lfs.com'));
    return;
  }
  el.append(help(`이미지, 영상, 디자인 파일 같은 큰 파일을 저장소에는 작은 포인터로만 기록하고 실제 내용은 LFS 서버(GitHub 등)에 따로 저장합니다. <span class="fdir">${esc(info.version)}</span>`));
  if (!info.hooks)
    el.append(card(h('div', { text: '이 저장소에는 LFS 훅이 설정되어 있지 않습니다. 추적 패턴을 추가하기 전에 한 번 설정하세요.' }), h('button', { class: 'btn primary', text: '이 저장소에 LFS 설정 (lfs install --local)', onclick: () => op('LFS 설정', () => git('lfsInstall'), { success: 'LFS 를 설정했습니다.' }) })));
  const patterns = h('div', { class: 'adv-list' });
  if (!info.patterns.length) patterns.append(h('div', { class: 'empty small', text: 'LFS 로 관리하는 파일 패턴이 없습니다.' }));
  for (const p of info.patterns)
    patterns.append(h('div', { class: 'adv-row' }, h('b', { text: p.pattern }), h('span', { class: 'fdir', text: p.source }), h('span', { class: 'tb-spacer' }), h('button', { class: 'tb-btn small danger', text: '추적 해제', onclick: () => op('LFS 추적 해제', () => git('lfsUntrack', p.pattern), { success: `${p.pattern} 추적 해제 (.gitattributes 를 커밋하세요)` }) })));
  const input = h('input', { class: 'input', placeholder: '예: *.psd  또는  assets/videos/**' });
  el.append(
    h('h4', { text: '추적 패턴' }),
    patterns,
    h('div', { class: 'row-btns' }, input, h('button', { class: 'btn primary', text: '추적 추가', onclick: () => input.value.trim() && op('LFS 추적', () => git('lfsTrack', input.value.trim()), { success: '추가했습니다. .gitattributes 를 커밋하세요.' }) }))
  );
  const files = h('div', { class: 'adv-list' });
  if (!info.files.length) files.append(h('div', { class: 'empty small', text: 'LFS 로 저장된 파일이 없습니다.' }));
  for (const f of info.files.slice(0, 300))
    files.append(h('div', { class: 'adv-row' }, h('span', { class: 'ti-ico', text: f.downloaded ? '●' : '○', title: f.downloaded ? '내려받음' : '포인터만 있음' }), h('span', { text: f.path }), h('span', { class: 'tb-spacer' }), h('span', { class: 'fdir', text: f.size })));
  el.append(h('h4', { text: `LFS 파일 (${info.files.length})` }), files, h('div', { class: 'row-btns' }, h('button', { class: 'btn', text: 'LFS 파일 내려받기 (lfs pull)', onclick: () => op('LFS Pull', () => git('lfsPull'), { success: 'LFS 파일을 내려받았습니다.' }) })));
};

// ---------- Clean ----------

RENDER.clean = async (el) => {
  el.append(help('Git 이 추적하지 않는 파일(빌드 결과물, 임시 파일 등)을 한 번에 정리합니다. 정리한 파일은 <b>휴지통</b> 으로 이동하므로 필요하면 복원할 수 있습니다.'));
  const ignored = h('input', { type: 'checkbox' });
  const listBox = h('div', { class: 'adv-list' });
  const btn = h('button', { class: 'btn danger', text: '선택한 항목 휴지통으로 이동' });
  let items = [];
  const checks = new Map();
  const draw = async () => {
    items = await git('cleanPreview', { ignored: ignored.checked });
    listBox.innerHTML = '';
    checks.clear();
    if (!items.length) listBox.append(h('div', { class: 'empty small', text: '정리할 파일이 없습니다.' }));
    for (const p of items) {
      const c = h('input', { type: 'checkbox', checked: true });
      checks.set(p, c);
      listBox.append(h('label', { class: 'adv-row check' }, c, h('span', { text: p })));
    }
    btn.disabled = !items.length;
  };
  ignored.onchange = draw;
  btn.onclick = async () => {
    const paths = items.filter((p) => checks.get(p).checked);
    if (!paths.length) return;
    if (!(await confirmDialog(`${paths.length}개 항목을 휴지통으로 이동합니다.`, { danger: true, okLabel: '정리', detail: paths.join('\n') }))) return;
    const done = busy('정리');
    const r = await window.api.git.cleanApply(state.repo, paths);
    done();
    if (!r.ok) errorDialog(r.error);
    else toast(`${paths.length}개 항목을 정리했습니다.`, 'ok');
    refresh();
  };
  el.append(h('label', { class: 'check' }, ignored, ' .gitignore 로 무시된 파일도 포함 (node_modules, 빌드 폴더 등 — 주의)'), listBox, h('div', { class: 'row-btns' }, btn));
  await draw();
};

// ---------- 커밋 서명 ----------

RENDER.sign = async (el) => {
  const cfg = await git('config');
  el.append(help('커밋에 서명하면 GitHub 에서 <b>Verified</b> 표시가 붙어 본인이 만든 커밋임을 증명할 수 있습니다. GPG 키 또는 SSH 키가 미리 만들어져 있어야 하고, 같은 키를 GitHub 설정(SSH and GPG keys)에 등록해야 합니다.'));
  const on = h('input', { type: 'checkbox', checked: !!state.settings.signCommits });
  const fmt = h('select', { class: 'input' }, ...[['openpgp', 'GPG (openpgp)'], ['ssh', 'SSH 키'], ['x509', 'X.509 (S/MIME)']].map(([v, t]) => h('option', { value: v, text: t, selected: cfg.gpgFormat === v })));
  const key = h('input', { class: 'input', value: cfg.signingKey || '', placeholder: 'GPG: 키 ID (예: 3AA5C34371567BD2) / SSH: 공개키 파일 경로 (예: C:/Users/나/.ssh/id_ed25519.pub)' });
  const global = h('input', { type: 'checkbox', checked: true });
  el.append(
    card(
      h('label', { class: 'check' }, on, ' CodeFlow 에서 커밋할 때 항상 서명 (-S)'),
      h('label', { class: 'form-label', text: '서명 방식' }),
      fmt,
      h('label', { class: 'form-label', text: '서명 키' }),
      key,
      h('label', { class: 'check' }, global, ' 모든 저장소에 적용 (global)'),
      h(
        'div',
        { class: 'row-btns' },
        h('button', {
          class: 'btn primary',
          text: '저장',
          onclick: async () => {
            state.settings = await window.api.setSettings({ signCommits: on.checked });
            await op('서명 설정', () => git('setConfig', { signingKey: key.value.trim(), gpgFormat: fmt.value, global: global.checked }), { success: '서명 설정을 저장했습니다.' });
          },
        })
      )
    ),
    help('서명된 커밋은 히스토리 화면의 커밋 상세에 <b>✔ 서명 확인됨</b> 으로 표시됩니다.')
  );
};

// 탭으로 열기 (탭 기능이 있으면 새 탭, 아니면 현재 창에서 열기)
async function openInTab(dir) {
  const { openRepoInNewTab } = await import('./repo.js');
  openRepoInNewTab(dir);
}
