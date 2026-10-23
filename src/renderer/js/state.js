// 앱 전역 상태와 Git 호출 헬퍼
import { $, toast, errorDialog, confirmDialog } from './ui.js';

export const state = {
  repo: null,
  status: null,
  settings: {},
  view: 'code',
};

const listeners = new Set();
export const onRefresh = (fn) => listeners.add(fn);

// Git 함수 호출. 실패 시 예외를 던진다.
export async function git(name, ...args) {
  const r = await window.api.git[name](state.repo, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

// ---------- 진행 표시 ----------
// 작업 중에는 상단 진행 막대 + 툴바의 "OO 중... N초" + 누른 버튼의 회전 표시를 보여준다.
const tasks = []; // { label, start }
let busyTimer = null;
export const isBusy = () => tasks.length > 0;

// 작업 이름 → 그 작업을 시작한 버튼 (버튼에 회전 표시 + 중복 클릭 막기)
const TASK_BUTTONS = {
  Fetch: ['#fetchBtn'],
  Pull: ['#pullBtn'],
  Push: ['#pushBtn', '#btnCommitPush'],
  커밋: ['#btnCommit', '#btnCommitPush'],
  '커밋 수정': ['#btnCommit', '#btnCommitPush'],
};

function renderBusy() {
  const on = tasks.length > 0;
  document.body.classList.toggle('is-busy', on);
  $('#busy').hidden = !on;
  if (!on) {
    clearInterval(busyTimer);
    busyTimer = null;
    return;
  }
  const t = tasks[tasks.length - 1];
  const sec = Math.floor((Date.now() - tasks[0].start) / 1000);
  $('#busyText').textContent = `${t.label} 중...${sec >= 1 ? ` ${sec}초` : ''}${tasks.length > 1 ? ` (+${tasks.length - 1})` : ''}`;
  if (!busyTimer) busyTimer = setInterval(renderBusy, 1000);
}

function setButtons(label, loading) {
  for (const sel of TASK_BUTTONS[label] || []) {
    const b = document.querySelector(sel);
    if (!b) continue;
    b.classList.toggle('loading', loading);
    b.disabled = loading;
  }
}

export function busy(text) {
  const task = { label: (text || '작업').replace(/(\.\.\.|…)$/, ''), start: Date.now() };
  tasks.push(task);
  setButtons(task.label, true);
  renderBusy();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    tasks.splice(tasks.indexOf(task), 1);
    if (!tasks.some((t) => t.label === task.label)) setButtons(task.label, false);
    renderBusy();
  };
}

export function setStatusMsg(msg) {
  $('#statusMsg').textContent = msg || '';
}

export const FAILED = Symbol('failed');

// 사용자 작업 실행 래퍼: 진행 표시 → 실행 → 오류 표시 → 새로고침
export async function op(label, fn, { success, refresh: doRefresh = true, smart = true } = {}) {
  if (tasks.some((t) => t.label === label)) {
    toast(`${label} 이(가) 이미 진행 중입니다. 잠시만 기다려 주세요.`, 'warn');
    return FAILED;
  }
  const done = busy(label);
  try {
    const result = await fn();
    if (result && result.conflict) {
      toast('충돌이 발생했습니다. 충돌을 해결하세요.', 'warn', 5000);
      setStatusMsg(`${label}: 충돌 발생`);
      const { openConflicts } = await import('./conflicts.js');
      if (doRefresh) await refresh();
      openConflicts();
      return result;
    }
    if (success) toast(typeof success === 'function' ? success(result) : success, 'ok');
    setStatusMsg(`${label} 완료 (${new Date().toLocaleTimeString()})`);
    return result;
  } catch (e) {
    done();
    setStatusMsg(`${label} 실패`);
    const handled = await handleKnownError(label, e, fn, smart);
    if (!handled) errorDialog(e.message, `${label} 실패`);
    return FAILED;
  } finally {
    done();
    if (doRefresh) refresh();
  }
}

// 로컬 변경사항 때문에 실패하면 IntelliJ 의 "Smart checkout" 처럼 stash → 실행 → 복원을 제안한다.
async function handleKnownError(label, e, fn, smart = true) {
  const msg = e.message || '';
  if (!smart && /would be overwritten|Please commit your changes or stash them|uncommitted changes|unstaged changes/i.test(msg)) {
    errorDialog(`${msg}

커밋하지 않은 변경 사항이 있어서 진행할 수 없습니다. 먼저 커밋하거나 보관(Stash)하세요.`, `${label} 실패`);
    return true;
  }
  if (/would be overwritten by (checkout|merge)|Please commit your changes or stash them|cannot (pull|rebase) with (rebase|uncommitted)|You have unstaged changes|contains uncommitted changes/i.test(msg)) {
    const ok = await confirmDialog(
      '로컬 변경 사항과 겹쳐서 작업을 진행할 수 없습니다.\n변경 사항을 임시 보관(stash)한 뒤 작업을 실행하고, 끝나면 자동으로 다시 적용할까요? (스마트 모드)',
      { title: label, okLabel: '스마트 실행', detail: msg }
    );
    if (!ok) return true;
    const done = busy('스마트 실행 중...');
    try {
      await git('stashSave', `CodeFlow 자동 보관 (${label})`);
      let r;
      try {
        r = await fn();
      } finally {
        const pop = await git('stashPop', 'stash@{0}');
        if (pop && pop.conflict) {
          toast('보관했던 변경 사항을 다시 적용하는 중 충돌이 발생했습니다.', 'warn', 6000);
          const { openConflicts } = await import('./conflicts.js');
          await refresh();
          openConflicts();
          return true;
        }
      }
      if (r && r.conflict) {
        const { openConflicts } = await import('./conflicts.js');
        await refresh();
        openConflicts();
      } else {
        toast(`${label} 완료 (변경 사항 복원됨)`, 'ok');
        setStatusMsg(`${label} 완료 (${new Date().toLocaleTimeString()})`);
      }
    } catch (e2) {
      errorDialog(e2.message, `${label} 실패`);
    } finally {
      done();
      refresh();
    }
    return true;
  }
  if (/Authentication failed|could not read Username|terminal prompts disabled|Permission denied \(publickey\)/i.test(msg)) {
    errorDialog(
      `${msg}\n\n원격 저장소 인증에 실패했습니다.\n- HTTPS: Git for Windows 에 포함된 Git Credential Manager 가 로그인 창을 띄웁니다. 창이 안 뜨면 터미널에서 'git push' 를 한 번 실행해 로그인하세요.\n- SSH: SSH 키가 GitHub 에 등록되어 있는지 확인하세요.`,
      `${label} 실패 - 인증 필요`
    );
    return true;
  }
  return false;
}

// 상태 새로고침. 저장소(탭)별로 따로 돌고, 도중에 다른 저장소로 바뀌면 결과를 버린다.
let refreshing = null;
let refreshingRepo = null;
export function refresh() {
  if (!state.repo) return Promise.resolve();
  if (refreshing && refreshingRepo === state.repo) return refreshing;
  const repo = state.repo;
  const prev = refreshing;
  const p = (async () => {
    if (prev) await prev.catch(() => {});
    if (state.repo !== repo) return;
    try {
      const st = await git('status');
      if (state.repo !== repo) return; // 그 사이 탭이 바뀜
      state.status = st;
      await emitStatus();
    } catch (e) {
      console.error(e);
      if (state.repo === repo) setStatusMsg(`상태 조회 실패: ${e.message}`);
    } finally {
      if (refreshing === p) {
        refreshing = null;
        refreshingRepo = null;
      }
    }
  })();
  refreshing = p;
  refreshingRepo = repo;
  return p;
}

// 현재 state.status 로 모든 화면을 다시 그린다 (탭 전환 시 기억해 둔 상태로 즉시 표시할 때도 사용)
export async function emitStatus() {
  if (!state.status) return;
  for (const fn of listeners) {
    try {
      await fn(state.status);
    } catch (e) {
      console.error(e);
    }
  }
}
