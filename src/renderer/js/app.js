// 앱 진입점: 레이아웃/툴바/단축키/뷰 전환
import { $, $$, h, toast } from './ui.js';
import { state, refresh, onRefresh, op, git } from './state.js';
import { initChanges, focusCommitMessage } from './changes.js';
import { initLog, activateLog } from './log.js';
import { initStash, activateStash } from './stash.js';
import { openBranchPopup, newBranch } from './branches.js';
import { doFetch, doPull, doPush } from './remote.js';
import { repoMenu, renderWelcome, openRepo, pickAndOpen, openSettings, setOnOpened, renderTabs, cacheTabStatus, cycleTab, closeTab, tabs } from './repo.js';
import { initAdvanced, activateAdvanced } from './advanced.js';
import { openConflicts, continueOperation, abortOperation } from './conflicts.js';

const OP_LABEL = { merge: '병합', rebase: '리베이스', 'cherry-pick': '체리픽', revert: '되돌리기' };

function setView(view) {
  if (!state.repo) view = 'welcome';
  state.view = view;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === (view === 'welcome' ? 'welcome' : `view-${view}`)));
  $$('.rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'log') activateLog();
  if (view === 'stash') activateStash();
  if (view === 'advanced') activateAdvanced();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

function updateChrome(s) {
  cacheTabStatus(s);
  const name = state.repo.split(/[\\/]/).filter(Boolean).pop();
  $('#repoName').textContent = name;
  document.title = `${name} - CodeFlow`;
  $('#branchName').textContent = s.detached ? `HEAD (${s.headShort})` : s.branch || '-';
  $('#branchBtn').classList.toggle('detached', !!s.detached);
  const behind = $('#behindBadge');
  const ahead = $('#aheadBadge');
  behind.hidden = !s.behind;
  behind.textContent = s.behind;
  ahead.hidden = !s.ahead;
  ahead.textContent = s.ahead;
  const count = $('#changeCount');
  count.hidden = !s.files.length;
  count.textContent = s.files.length;
  $('#statusPath').textContent = `${state.repo}  ·  ${s.branch || s.headShort || ''}${s.upstream ? ` → ${s.upstream}` : ' (원격 연결 없음)'}${s.ahead ? `  ↑${s.ahead}` : ''}${s.behind ? `  ↓${s.behind}` : ''}`;

  const banner = $('#opBanner');
  const conflicts = s.files.filter((f) => f.status === 'conflict').length;
  if (s.state) {
    const label = OP_LABEL[s.state];
    banner.hidden = false;
    banner.innerHTML = '';
    banner.append(
      h('span', { class: 'ob-ico', text: '⚠' }),
      h('span', { text: conflicts ? `${label} 진행 중 — 해결되지 않은 충돌 ${conflicts}개` : `${label} 진행 중 — 모든 충돌 해결됨. 계속을 눌러 마무리하세요.` }),
      h('span', { class: 'tb-spacer' }),
      conflicts ? h('button', { class: 'btn small primary', text: '충돌 해결...', onclick: openConflicts }) : h('button', { class: 'btn small primary', text: `계속 (${label} 완료)`, onclick: continueOperation }),
      h('button', { class: 'btn small danger', text: `${label} 중단`, onclick: abortOperation })
    );
  } else if (s.bisect && s.bisectFound) {
    banner.hidden = false;
    banner.innerHTML = '';
    banner.append(
      h('span', { class: 'ob-ico', text: '🎯' }),
      h('span', { text: `Bisect 완료 — 문제가 처음 생긴 커밋: ${s.bisectFound.hash.slice(0, 8)} ${s.bisectFound.subject}` }),
      h('span', { class: 'tb-spacer' }),
      h('button', { class: 'btn small', text: '커밋 보기', onclick: async () => (await import('./log.js')).showCommit(s.bisectFound.hash) }),
      h('button', { class: 'btn small primary', text: 'Bisect 종료', onclick: () => op('Bisect 종료', () => git('bisectReset'), { success: '원래 브랜치로 돌아왔습니다.' }) })
    );
  } else if (s.bisect) {
    banner.hidden = false;
    banner.innerHTML = '';
    const mark = async (term) => (await import('./advanced.js')).markBisect(term);
    banner.append(
      h('span', { class: 'ob-ico', text: '⌖' }),
      h('span', { text: `Bisect 진행 중 — 현재 커밋(${s.headShort || ''})을 확인하고 결과를 표시하세요.` }),
      h('span', { class: 'tb-spacer' }),
      h('button', { class: 'btn small primary', text: '✔ 정상', onclick: () => mark('good') }),
      h('button', { class: 'btn small danger', text: '✘ 문제 있음', onclick: () => mark('bad') }),
      h('button', { class: 'btn small', text: '건너뛰기', onclick: () => mark('skip') }),
      h('button', { class: 'btn small', text: '상세...', onclick: async () => (await import('./advanced.js')).showSection('bisect') })
    );
  } else banner.hidden = true;
}

async function onOpened() {
  if (!state.repo) {
    $('#app').classList.add('no-repo');
    $('#repoName').textContent = '저장소 열기';
    document.title = 'CodeFlow';
    $('#opBanner').hidden = true;
    $('#statusPath').textContent = '';
    await renderWelcome();
    setView('welcome');
    return;
  }
  $('#app').classList.remove('no-repo');
  setView(state.view === 'welcome' ? 'changes' : state.view);
  await refresh();
}

async function main() {
  state.settings = await window.api.getSettings();
  applyTheme(state.settings.theme || 'dark');
  initChanges();
  initLog();
  initStash();
  initAdvanced();
  setOnOpened(onOpened);
  onRefresh(updateChrome);

  $('#repoBtn').onclick = (e) => repoMenu(e.currentTarget);
  $('#branchBtn').onclick = (e) => state.repo && openBranchPopup(e.currentTarget);
  $('#fetchBtn').onclick = () => state.repo && doFetch();
  $('#pullBtn').onclick = () => state.repo && doPull();
  $('#pushBtn').onclick = () => state.repo && doPush();
  $('#refreshBtn').onclick = () => refresh();
  $('#settingsBtn').onclick = openSettings;
  $('#themeBtn').onclick = async () => {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(t);
    state.settings = await window.api.setSettings({ theme: t });
  };
  $$('.rail-btn').forEach((b) => (b.onclick = () => setView(b.dataset.view)));

  document.addEventListener('keydown', (e) => {
    if (document.querySelector('.modal-backdrop')) return;
    const k = e.key.toLowerCase();
    if (e.key === 'F5') {
      e.preventDefault();
      refresh();
    } else if (e.ctrlKey && !e.shiftKey && k === 'k') {
      e.preventDefault();
      setView('changes');
      focusCommitMessage();
    } else if (e.ctrlKey && e.shiftKey && k === 'k') {
      e.preventDefault();
      state.repo && doPush();
    } else if (e.ctrlKey && !e.shiftKey && k === 't') {
      e.preventDefault();
      state.repo && doPull();
    } else if (e.ctrlKey && k === 'o') {
      e.preventDefault();
      pickAndOpen();
    } else if (e.ctrlKey && e.altKey && k === 'n') {
      e.preventDefault();
      state.repo && newBranch();
    } else if (e.ctrlKey && e.shiftKey && e.code === 'Backquote') {
      e.preventDefault();
      state.repo && openBranchPopup($('#branchBtn'));
    } else if (e.altKey && e.key === '9') {
      e.preventDefault();
      setView('log');
    } else if (e.altKey && e.key === '0') {
      e.preventDefault();
      setView('changes');
    } else if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      cycleTab(e.shiftKey ? -1 : 1);
    } else if (e.ctrlKey && k === 'w') {
      e.preventDefault();
      state.repo && closeTab(state.repo);
    }
  });

  // 창이 다시 활성화되면(에디터에서 파일 수정 후 돌아오면) 자동 새로고침
  window.api.onFocus(() => refresh());

  await renderWelcome();
  // 지난번에 열어 둔 탭 복원
  const saved = (state.settings.tabs || (state.settings.last ? [state.settings.last] : [])).filter(Boolean);
  for (const p of saved) if (await window.api.exists(p)) await openRepo(p, { activate: false });
  const last = tabs.find((t) => t.path === state.settings.last) || tabs[0];
  if (last) await openRepo(last.path);
  else {
    renderTabs();
    $('#app').classList.add('no-repo');
    setView('welcome');
  }
}

main().catch((e) => {
  console.error(e);
  toast(`초기화 실패: ${e.message}`, 'error', 10000);
});
