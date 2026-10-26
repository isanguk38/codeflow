// 앱 진입점: 레이아웃/툴바/단축키/뷰 전환
import { $, $$, h, toast } from './ui.js';
import { state, refresh, onRefresh, op, git, emitStatus } from './state.js';
import { initChanges, focusCommitMessage, showRepoLoading } from './changes.js';
import { initLog, activateLog } from './log.js';
import { initStash, activateStash } from './stash.js';
import { openBranchPopup, newBranch } from './branches.js';
import { doFetch, doPull, doPush } from './remote.js';
import { repoMenu, renderWelcome, openRepo, pickAndOpen, openSettings, setOnOpened, renderTabs, cacheTabStatus, cycleTab, closeTab, tabs, openProjectList } from './repo.js';
import { startUpdateCheck } from './update.js';
import { initCode, activateCode, closeActiveTab, toggleTerminalPanel, onRepoActivated } from './code.js';
import { initAi, toggleAi, onAiRepoChanged } from './ai.js';
import { initHub, activateHub, deactivateHub, setHubMode } from './ai-hub.js';
import { openSearch } from './search.js';
import { openConflicts, continueOperation, abortOperation } from './conflicts.js';

const OP_LABEL = { merge: '병합', rebase: '리베이스', 'cherry-pick': '체리픽', revert: '되돌리기' };

let prevView = 'code'; // AI 화면을 닫으면 돌아갈 화면
function setView(view) {
  if (!state.repo) view = 'welcome';
  if (view === 'ai' && state.view !== 'ai' && state.view !== 'welcome') prevView = state.view;
  state.view = view;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === (view === 'welcome' ? 'welcome' : `view-${view}`)));
  $$('.rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'log') activateLog();
  if (view === 'stash') activateStash();
  if (view === 'code') activateCode();
  if (view === 'ai') activateHub();
  else deactivateHub();
}
// ✦ AI 버튼 / Ctrl+Shift+A: AI 화면을 열고, 다시 누르면 보던 화면으로
function toggleAiView() {
  if (state.view === 'ai') setView(prevView || 'code');
  else setView('ai');
}
// AI 쪽에서 '1:1 대화를 열어/닫아' 요청 (예전 오른쪽 패널 열기/닫기 대신)
window.addEventListener('cf-ai-open', (e) => {
  if (e.detail) {
    setHubMode('chat');
    setView('ai');
  } else if (state.view === 'ai') setView(prevView || 'code');
});
window.addEventListener('cf-ai-toggle', () => toggleAiView());

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
  // 원격에 아직 없는 브랜치: Push 버튼에 'Push 할 커밋' 이 있다고 알려 준다
  $('#pushBtn')?.setAttribute('title', s.unpublished ? `Push 할 커밋 ${s.ahead}개 — 원격에 아직 이 브랜치가 없어서 Push 하면 새로 만듭니다 (Ctrl+Shift+K)` : 'Push (Ctrl+Shift+K)');
  const count = $('#changeCount');
  count.hidden = !s.files.length;
  count.textContent = s.files.length;
  const remoteNote = s.unpublished ? `${s.upstream ? ` → ${s.upstream}` : ''} (원격에 아직 없음 · Push 필요)` : s.upstream ? ` → ${s.upstream}` : ' (원격 연결 없음)';
  $('#statusPath').textContent = `${state.repo}  ·  ${s.branch || s.headShort || ''}${remoteNote}${s.ahead ? `  ↑${s.ahead}` : ''}${s.behind ? `  ↓${s.behind}` : ''}`;

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
  } else if (s.bisect) {
    // 다른 도구에서 시작한 Bisect 상태에 갇히지 않도록 종료 버튼만 제공
    banner.hidden = false;
    banner.innerHTML = '';
    banner.append(
      h('span', { class: 'ob-ico', text: '⚠' }),
      h('span', { text: 'Bisect(문제 커밋 찾기) 상태입니다. 원래 브랜치로 돌아가려면 종료하세요.' }),
      h('span', { class: 'tb-spacer' }),
      h('button', { class: 'btn small primary', text: 'Bisect 종료', onclick: () => op('Bisect 종료', () => git('bisectReset'), { success: '원래 브랜치로 돌아왔습니다.' }) })
    );
  } else banner.hidden = true;
}

async function onOpened() {
  onRepoActivated(state.repo).catch(() => {}); // Java 프로젝트면 Java 언어 서버를 미리 켜 둔다
  onAiRepoChanged(); // AI 패널: 이 프로젝트의 대화로
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
  setView(state.view === 'welcome' ? 'code' : state.view);
  if (state.status) emitStatus(); // 기억해 둔 상태로 먼저 그리기
  else clearRepoChrome();
  await refresh();
}

// 처음 여는 저장소: 이전 저장소 정보가 남아 보이지 않게 툴바/상태바를 비운다
function clearRepoChrome() {
  const name = state.repo.split(/[\\/]/).filter(Boolean).pop();
  $('#repoName').textContent = name;
  document.title = `${name} - CodeFlow`;
  $('#branchName').textContent = '...';
  $('#behindBadge').hidden = true;
  $('#aheadBadge').hidden = true;
  $('#changeCount').hidden = true;
  $('#opBanner').hidden = true;
  $('#statusPath').textContent = `${state.repo}  ·  불러오는 중...`;
  showRepoLoading();
}

async function main() {
  state.settings = await window.api.getSettings();
  applyTheme(state.settings.theme || 'dark');
  initChanges();
  initLog();
  initStash();
  initCode();
  initAi();
  initHub();
  // AI 가 화면 이동을 요청할 때 (CodeFlow 도구)
  window.addEventListener('cf-set-view', (e) => state.repo && setView(e.detail));
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
  $('#aiBtn').onclick = toggleAi;

  // 프로젝트 전체 찾기: 편집기·터미널 안에서도 (편집기가 먼저 가져가지 않도록 capture 단계에서)
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyF' && !document.querySelector('.modal-backdrop')) {
        e.preventDefault();
        e.stopPropagation();
        openSearch();
      }
      // 모든 프로젝트 목록 (탭이 많을 때 검색해서 바로 이동)
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyE' && !document.querySelector('.modal-backdrop')) {
        e.preventDefault();
        e.stopPropagation();
        openProjectList();
      }
    },
    true
  );
  document.addEventListener('keydown', (e) => {
    if (document.querySelector('.modal-backdrop')) return;
    const k = e.key.toLowerCase();
    // 코드 편집기 안에서는 편집기 단축키(Ctrl+K 조합 등)를 우선한다. 탭 닫기/전환만 앱이 처리.
    // 터미널 안에서도 마찬가지(입력은 셸로 간다).
    if (e.ctrlKey && e.shiftKey && k === 'a') {
      e.preventDefault();
      toggleAi();
      return;
    }
    if (e.target.closest?.('.monaco-editor, .xterm, .ai-panel') && !(e.ctrlKey && (k === 'w' || e.key === 'Tab' || e.code === 'Backquote'))) return;
    if (e.ctrlKey && !e.shiftKey && e.code === 'Backquote') {
      e.preventDefault();
      if (state.view !== 'code') setView('code');
      toggleTerminalPanel();
      return;
    }
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
      // 코드 화면에서는 VS Code 처럼 파일 탭을 닫는다
      if (state.view === 'code') closeActiveTab();
      else state.repo && closeTab(state.repo);
    } else if (e.altKey && e.key === '1') {
      e.preventDefault();
      setView('code');
    }
  });

  // 창이 다시 활성화되면(에디터에서 파일 수정 후 돌아오면) 자동 새로고침
  window.api.onFocus(() => refresh());
  startUpdateCheck();

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
