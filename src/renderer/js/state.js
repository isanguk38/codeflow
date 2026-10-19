// 앱 전역 상태와 Git 호출 헬퍼
import { $, toast, errorDialog, confirmDialog } from './ui.js';

export const state = {
  repo: null,
  status: null,
  settings: {},
  view: 'changes',
};

const listeners = new Set();
export const onRefresh = (fn) => listeners.add(fn);

// Git 함수 호출. 실패 시 예외를 던진다.
export async function git(name, ...args) {
  const r = await window.api.git[name](state.repo, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

let busyCount = 0;
export function busy(text) {
  busyCount++;
  $('#busy').hidden = false;
  $('#busyText').textContent = text || '작업 중...';
  return () => {
    busyCount = Math.max(0, busyCount - 1);
    if (!busyCount) $('#busy').hidden = true;
  };
}

export function setStatusMsg(msg) {
  $('#statusMsg').textContent = msg || '';
}

export const FAILED = Symbol('failed');

// 사용자 작업 실행 래퍼: 진행 표시 → 실행 → 오류 표시 → 새로고침
export async function op(label, fn, { success, refresh: doRefresh = true } = {}) {
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
    setStatusMsg(`${label} 실패`);
    const handled = await handleKnownError(label, e, fn);
    if (!handled) errorDialog(e.message, `${label} 실패`);
    return FAILED;
  } finally {
    done();
    if (doRefresh) refresh();
  }
}

// 로컬 변경사항 때문에 실패하면 IntelliJ 의 "Smart checkout" 처럼 stash → 실행 → 복원을 제안한다.
async function handleKnownError(label, e, fn) {
  const msg = e.message || '';
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

let refreshing = null;
export function refresh() {
  if (!state.repo) return Promise.resolve();
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      state.status = await git('status');
      for (const fn of listeners) {
        try {
          await fn(state.status);
        } catch (e) {
          console.error(e);
        }
      }
    } catch (e) {
      console.error(e);
      setStatusMsg(`상태 조회 실패: ${e.message}`);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}
