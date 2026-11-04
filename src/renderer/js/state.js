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
// git status 가 실패했을 때 (실패를 '변경 없음' 으로 보이지 않게)
const statusErrorListeners = new Set();
export const onStatusError = (fn) => statusErrorListeners.add(fn);

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
export async function op(label, fn, { success, refresh: doRefresh = true, smart = true, onError } = {}) {
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
    // onError 가 true 를 돌려주면 그쪽에서 처리한 것
    const handled = (await onError?.(e)) || (await handleKnownError(label, e, fn, smart));
    if (!handled) errorDialog(e.message, `${label} 실패`);
    return FAILED;
  } finally {
    done();
    if (doRefresh) refresh();
  }
}

// 원격 저장소 오류를 무엇을 하면 되는지로 풀어 준다
function remoteErrorHint(msg) {
  if (/Authentication failed|HTTP Basic: Access denied|could not read (Username|Password)|terminal prompts disabled|Permission denied \(publickey\)/i.test(msg))
    return { title: '인증 필요', text: "이 원격 저장소에 로그인되어 있지 않습니다. 원격마다 도메인이 다르면 로그인도 따로 필요합니다.\n- HTTPS: Git for Windows 의 Git Credential Manager 가 로그인 창을 띄웁니다. 창이 안 뜨면 Git for Windows 를 설치하거나, 터미널에서 'git push' 를 실행해 로그인하세요. (MSYS2 등 다른 Git 에는 로그인 창이 없을 수 있습니다)\n- SSH: SSH 키가 이 서버에 등록되어 있는지 확인하세요." };
  if (/Host key verification failed/i.test(msg))
    return { title: 'SSH 서버 확인 필요', text: "이 PC 에서 처음 접속하는 SSH 서버입니다. 터미널에서 'ssh -T git@서버주소' 를 실행해 yes 로 한 번 승인한 뒤 다시 시도하세요." };
  if (/SSL certificate problem|server certificate verification failed|unable to get local issuer/i.test(msg))
    return { title: '서버 인증서 문제', text: "서버의 인증서를 이 Git 이 신뢰하지 못합니다. 사내 인증서를 쓰는 서버에서 자주 생깁니다. 터미널에서 'git config --global http.sslBackend schannel' 을 실행하면 Windows 에 등록된 인증서를 사용합니다." };
  if (/Could not resolve host|Failed to connect|Connection (timed out|refused)|Could not connect to server/i.test(msg))
    return { title: '서버 접속 불가', text: '서버에 접속하지 못했습니다. 원격 저장소 주소가 맞는지, 사내망·VPN 에 연결되어 있는지 확인하세요.' };
  if (/repository .*not found|does not appear to be a git repository|The project you were looking for could not be found/i.test(msg))
    return { title: '저장소를 찾을 수 없음', text: '원격 저장소 주소가 틀렸거나 이 계정에 접근 권한이 없습니다. 설정의 원격 저장소 주소를 확인하세요.' };
  if (/deletion of the current branch prohibited|default branch|delete protected branch/i.test(msg))
    return { title: '서버가 삭제를 막음', text: '이 브랜치는 서버의 기본 브랜치이거나 보호된 브랜치라서 지울 수 없습니다. GitLab 의 설정 > 저장소에서 기본 브랜치를 다른 것으로 바꾸거나 보호를 해제한 뒤 다시 삭제하세요.' };
  if (/protected branch|not allowed to (force )?push|pre-receive hook declined/i.test(msg))
    return { title: '서버가 Push 를 막음', text: '서버가 이 브랜치에 대한 Push 를 막았습니다 (보호된 브랜치 등). GitLab 의 설정 > 저장소 > 보호된 브랜치에서 권한을 바꾸거나, 새 브랜치로 Push 한 뒤 Merge Request 로 합치세요.' };
  return null;
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
  const hint = remoteErrorHint(msg);
  if (hint) {
    errorDialog(`${msg}\n\n${hint.text}`, `${label} 실패 - ${hint.title}`);
    return true;
  }
  return false;
}

// 상태 새로고침. 저장소(탭)별로 따로 돌고, 도중에 다른 저장소로 바뀌면 결과를 버린다.
let refreshing = null;
let refreshingRepo = null;
let refreshAgain = null;
const STATUS_TIMEOUT = 60000; // git 이 응답하지 않아도 새로고침이 영영 막히지 않게
const LISTENER_TIMEOUT = 5000; // 화면 하나가 끝나지 않아도 다음 새로고침을 막지 않게

function within(promise, ms, message) {
  let timer;
  const limit = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)));
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

export function refresh() {
  if (!state.repo) return Promise.resolve();
  // 읽는 도중에 또 요청이 오면, 그 사이의 변경을 놓치지 않게 끝난 뒤 한 번 더 읽는다
  if (refreshing && refreshingRepo === state.repo) {
    if (!refreshAgain) {
      refreshAgain = refreshing.then(() => {
        refreshAgain = null;
        return refresh();
      });
    }
    return refreshAgain;
  }
  const repo = state.repo;
  const prev = refreshing;
  const p = (async () => {
    if (prev) await prev.catch(() => {});
    if (state.repo !== repo) return;
    try {
      const st = await within(git('status'), STATUS_TIMEOUT, `Git 이 ${STATUS_TIMEOUT / 1000}초 동안 응답하지 않습니다 (git status).`);
      if (state.repo !== repo) return; // 그 사이 탭이 바뀜
      state.status = st;
      if (state.statusError) setStatusMsg('');
      state.statusError = null;
      await emitStatus();
    } catch (e) {
      console.error(e);
      if (state.repo === repo) {
        setStatusMsg(`상태 조회 실패: ${e.message}`);
        state.statusError = e.message;
        statusErrorListeners.forEach((fn) => fn());
      }
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
  const all = [...listeners].map(async (fn) => {
    try {
      await fn(state.status);
    } catch (e) {
      console.error(e);
    }
  });
  await within(Promise.all(all), LISTENER_TIMEOUT, 'listeners').catch(() => console.warn('새로고침: 끝나지 않는 화면이 있어 기다리지 않습니다'));
}
