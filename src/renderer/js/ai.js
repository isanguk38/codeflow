// 오른쪽 AI 패널: 외부 AI(Claude Code 등)를 골라 설치·로그인한 뒤 프로젝트에 대해 대화하고 CodeFlow 를 직접 다루게 한다.
// - 위쪽에서 AI 선택 → 설치 안 됐으면 '설치', 로그인 안 됐으면 '로그인' 화면 → 대화
// - 대화는 프로젝트 탭마다 따로 (AI 는 그 프로젝트 폴더에서 실행)
// - 파일 수정·명령 실행 등은 대화 안에 '허용 / 거부' 카드로 묻는다
import { $, h, esc, toast, menuAt, splitter, modal } from './ui.js';
import { state, refresh } from './state.js';
import { activateCode, openFile } from './code.js';
import { runInTerminal, readTerminal, listTerminals } from './terminal.js';
import { tabs, switchTab } from './repo.js';
import { fileCard } from './preview.js';

const openDirs = () => tabs.map((t) => t.path);
const dirsKey = () => openDirs().map((d) => d.toLowerCase()).sort().join('|');

const AIS = [
  { id: 'claude', name: 'Claude Code', vendor: 'Anthropic', ready: true, login: 'Claude 계정(Pro/Max 구독) 또는 Anthropic Console 계정' },
  { id: 'codex', name: 'Codex', vendor: 'OpenAI', ready: true, login: 'ChatGPT 계정' },
];

// 모델 (빈 값 = 그 AI 의 기본값). Codex 는 계정 플랜마다 쓸 수 있는 모델이 달라서 Codex 가 알려 준 목록을 쓴다
const CLAUDE_MODELS = [
  ['', '기본값'],
  ['claude-opus-5-5', 'Opus 5.5'],
  ['claude-sonnet-5-5', 'Sonnet 5.5'],
  ['claude-haiku-5-5', 'Haiku 5.5'],
  ['claude-fable-5-1', 'Fable 5.1 (사용 크레딧 필요)'],
];
let codexModels = (() => {
  try {
    return JSON.parse(localStorage.getItem('ai.codexModels') || '[]');
  } catch {
    return [];
  }
})();
const modelsFor = (p) => (p === 'codex' ? [['', '기본값'], ...codexModels.map((m) => [m.id, `${m.name}${m.isDefault ? ' (기본)' : ''}`])] : CLAUDE_MODELS);
const getModel = (p) => localStorage.getItem(`ai.model.${p}`) ?? (p === 'claude' ? localStorage.getItem('ai.model') || '' : '');
const setModel = (p, m) => localStorage.setItem(`ai.model.${p}`, m);
const nameOf = (p) => AIS.find((a) => a.id === p)?.name || p;
// 플랜 사용량 (AI 마다): [{ label, utilization, resetsAt }]
const rateInfo = (() => {
  try {
    return JSON.parse(localStorage.getItem('ai.rateInfo') || '{}');
  } catch {
    return {};
  }
})();
const saveRate = () => localStorage.setItem('ai.rateInfo', JSON.stringify(rateInfo));
// MCP 서버·커넥터 상태 (AI 별): 대화 중 실제 연결 상태가 오면 그걸, 아니면 CLI 로 조회한 목록
const mcpBy = {}; // provider → { list, at, live }
// Codex 업데이트 (CodeFlow 가 설치한 Codex 는 스스로 업데이트하지 않으므로 앱을 켤 때 확인)
let codexUpd = null; // { managed, current, latest, hasUpdate, previous }
let codexUpdating = false;
async function checkCodexUpdate(force = false) {
  const r = await window.api.ai.codexUpdateInfo(force);
  if (!r.ok) return;
  codexUpd = r.data;
  const key = `ai.codexUpdateNotified.${codexUpd.latest}`;
  if (codexUpd.hasUpdate && !localStorage.getItem(key)) {
    localStorage.setItem(key, '1');
    toast(`Codex 새 버전 ${codexUpd.latest} 이 나왔습니다. AI 패널 ⋯ 메뉴에서 업데이트할 수 있습니다.`, 'info', 7000);
  }
  if (visible) render();
}

// 업데이트 / 되돌리기 뒤: 켜 둔 Codex 를 모두 끄고 새 버전으로 다시 깨운다 (대화는 그대로 이어짐)
function restartCodexEverywhere() {
  for (const c of chats.values()) if (c.procs.codex && !c.busy) stopProc(c, 'codex');
  if (provider === 'codex') refreshStatus().then(() => maybeWarm());
}

async function doCodexUpdate() {
  if (codexUpdating) return;
  if ([...chats.values()].some((c) => c.busy && c.procProvider === 'codex')) return toast('Codex 가 답하는 중입니다. 끝난 뒤에 업데이트하세요.', 'warn');
  codexUpdating = true;
  if (visible) render();
  const done = (await import('./state.js')).busy(`Codex ${codexUpd?.latest || ''} 업데이트`);
  try {
    const r = await window.api.ai.codexUpdate();
    if (!r.ok) throw new Error(r.error);
    toast(`Codex 를 ${r.data.version} 으로 업데이트했습니다. 문제가 있으면 ⋯ 메뉴에서 이전 버전으로 되돌릴 수 있습니다.`, 'ok', 6000);
    restartCodexEverywhere();
  } catch (e) {
    toast(`Codex 업데이트 실패: ${e.message}`, 'error', 7000);
  } finally {
    done();
    codexUpdating = false;
    await checkCodexUpdate();
  }
}

async function doCodexRollback() {
  if ([...chats.values()].some((c) => c.busy && c.procProvider === 'codex')) return toast('Codex 가 답하는 중입니다. 끝난 뒤에 되돌리세요.', 'warn');
  const r = await window.api.ai.codexRollback();
  if (!r.ok) return toast(r.error, 'error', 6000);
  toast(`Codex 를 ${r.data.version} 으로 되돌렸습니다.`, 'ok', 5000);
  restartCodexEverywhere();
  await checkCodexUpdate();
}
const mcpLoading = {};
async function loadMcp(p, force = false) {
  if (mcpLoading[p] || (!force && mcpBy[p] && Date.now() - mcpBy[p].at < 120000)) return;
  mcpLoading[p] = true;
  const r = await window.api.ai.mcpList(p);
  mcpLoading[p] = false;
  if (r.ok && !mcpBy[p]?.live) mcpBy[p] = { list: r.data, at: Date.now(), live: false };
}

let panel;
let visible = false; // 왼쪽 'AI' 화면의 '1:1 대화' 가 지금 보이는지 (ai-hub 가 알려 줌)
let provider = localStorage.getItem('ai.provider') || 'claude';
let info = null; // 설치/로그인 상태
let phase = 'checking'; // checking | install | installing | login | logging-in | ready | error
let logLines = [];
const chats = new Map(); // repo(소문자) → chat
const byChatId = new Map(); // 실행 중인 AI 프로세스 id → chat

const repoKey = (r) => (r || '').toLowerCase();

// ---------- 패널 열기/닫기 ----------

export function initAi() {
  panel = $('#aiPanel');
  window.api.ai.onLog((line) => {
    logLines.push(line);
    if (logLines.length > 200) logLines = logLines.slice(-200);
    const box = $('#aiLog');
    if (box) {
      box.textContent = logLines.join('\n');
      box.scrollTop = box.scrollHeight;
    }
    // 로그인 화면에 나온 주소는 바로 누를 수 있게
    const url = line.match(/https:\/\/\S+/);
    if (url && phase === 'logging-in') showLoginUrl(url[0]);
  });
  window.api.ai.onEvent(onAiEvent);
  window.api.ai.onTool(onToolRequest);
  // 앱을 켜면 (AI 화면을 열지 않아도) 고른 AI 를 미리 깨운다
  setTimeout(() => refreshStatus().then(() => maybeWarm()), 1500);
  // Codex 업데이트 확인 (조금 뒤에, 그리고 6시간마다)
  setTimeout(() => checkCodexUpdate(), 8000);
  setInterval(() => checkCodexUpdate(), 6 * 3600e3);
}

// 왼쪽 'AI' 화면의 '1:1 대화' 가 보이게/안 보이게 될 때 (ai-hub 가 부름)
export function onAiShown(v) {
  visible = v;
  $('#aiBtn')?.classList.toggle('on', v);
  if (v) {
    render();
    if (phase === 'checking' || !info) refreshStatus().then(() => maybeWarm());
    else maybeWarm();
    setTimeout(() => $('#aiInput')?.focus(), 50);
  }
}
// 1:1 대화 열기/닫기 (예전 오른쪽 패널 대신 왼쪽 'AI' 화면, app.js 가 처리)
export function setVisible(v) {
  window.dispatchEvent(new CustomEvent('cf-ai-open', { detail: v }));
}
export const toggleAi = () => window.dispatchEvent(new CustomEvent('cf-ai-toggle'));

// AI 화면을 보고 있지 않을 때 알리기 (화면을 갑자기 옮기지 않는다)
function notifyAi(text) {
  document.querySelector('.rail-btn[data-view="ai"]')?.classList.add('has-news');
  toast(text, 'info', 6000);
}

// 프로젝트 탭이 바뀌면 그 프로젝트의 대화를 보여 준다
export function onAiRepoChanged() {
  if (visible) render();
  maybeWarm();
}

// ---------- 설치 / 로그인 상태 ----------

async function refreshStatus() {
  const ai = AIS.find((a) => a.id === provider);
  if (!ai.ready) {
    phase = 'soon';
    return render();
  }
  phase = 'checking';
  render();
  const r = await window.api.ai.status(provider);
  if (!r.ok) {
    phase = 'error';
    info = { error: r.error };
  } else {
    info = r.data;
    phase = !info.installed ? 'install' : !info.loggedIn ? 'login' : 'ready';
  }
  render();
}

async function doInstall() {
  phase = 'installing';
  logLines = [];
  render();
  const r = await window.api.ai.install(provider);
  if (!r.ok) {
    toast(r.error, 'error', 8000);
    phase = 'install';
    return render();
  }
  toast(`${aiName()} 를 설치했습니다.`, 'ok');
  info = r.data;
  phase = info.loggedIn ? 'ready' : 'login';
  render();
  maybeWarm();
}

async function doLogin() {
  phase = 'logging-in';
  logLines = [];
  render();
  const r = await window.api.ai.login(provider);
  if (phase !== 'logging-in') return; // 취소함
  info = r.ok ? r.data.status : info;
  if (info?.loggedIn) {
    toast(`${aiName()} 에 로그인했습니다.`, 'ok');
    phase = 'ready';
  } else {
    phase = 'login';
    if (!r.ok) toast(r.error, 'error', 6000);
  }
  render();
  maybeWarm();
}

async function doLogout() {
  for (const c of chats.values()) stopAllProcs(c);
  const r = await window.api.ai.logout(provider);
  if (r.ok) info = r.data;
  phase = info?.installed ? 'login' : 'install';
  render();
}

const aiName = () => AIS.find((a) => a.id === provider)?.name || provider;

// ---------- 그리기 ----------

function render() {
  if (!panel || panel.hidden) return;
  panel.innerHTML = '';
  const sel = h('select', { class: 'ai-select', title: '사용할 AI' });
  for (const a of AIS) sel.append(h('option', { value: a.id, text: `${a.name} (${a.vendor})${a.ready ? '' : ' — 준비 중'}` }));
  sel.value = provider;
  sel.onchange = () => {
    provider = sel.value;
    localStorage.setItem('ai.provider', provider);
    // 대화는 그대로 두고, 다음 질문부터 새 AI 가 이어서 답한다
    const c = state.repo ? chats.get(repoKey(state.repo)) : null;
    if (c?.conv.entries.length) toast(`다음 질문부터 ${aiName()} 가 지금 대화를 이어서 답합니다.`, 'info', 4000);
    refreshStatus().then(() => phase === 'ready' && (maybeWarm(), loadMcp(provider)));
  };
  const newBtn = h('button', { class: 'tb-btn small', text: '＋', title: '새 대화 (지금 대화는 기록에 남음)' });
  newBtn.onclick = () => newChat();
  const histBtn = h('button', { class: 'tb-btn small', text: '🕘', title: '지난 대화 (이 프로젝트)' });
  histBtn.onclick = () => openHistory(histBtn);
  const more = h('button', { class: 'tb-btn small', text: '⋯', title: '더 보기' });
  more.onclick = async () => {
    const p = provider;
    // 지금 고른 AI 의 목록이 없으면 먼저 조회 (Claude 는 연결 확인 때문에 몇 초 걸림)
    if (!mcpBy[p]) {
      menuAt(more, [{ header: `${aiName()} 의 MCP · 커넥터 확인 중…` }]);
      await loadMcp(p);
      if (provider !== p) return;
    }
    const cur = mcpBy[p] || { list: [] };
    const mcp = cur.list.filter((m) => m.name !== 'codeflow');
    const ico = { connected: '●', 'needs-auth': '○', failed: '✕', pending: '…', configured: '◇', disabled: '–' };
    const word = { connected: '연결됨', 'needs-auth': '인증 필요', failed: '실패', pending: '연결 중', configured: '설정됨', disabled: '꺼짐' };
    const src = (m) => (m.source === 'claudeai' ? ' (claude.ai 커넥터)' : m.source === 'codex' ? ' (~/.codex 설정)' : '');
    menuAt(more, [
      { header: info?.installed ? `${aiName()} ${info.version || ''}${info.loggedIn ? ' · 로그인됨' : ''}` : aiName() },
      { label: '상태 다시 확인', onClick: refreshStatus },
      info?.loggedIn ? { label: '로그아웃', onClick: doLogout } : null,
      ...(p === 'codex' && codexUpd?.managed
        ? [
            '-',
            codexUpdating
              ? { label: 'Codex 업데이트 중…', disabled: true }
              : codexUpd.hasUpdate
                ? { label: `⬆ Codex ${codexUpd.latest} 으로 업데이트 (지금 ${codexUpd.current})`, onClick: doCodexUpdate }
                : { label: `✓ Codex 최신 버전 (${codexUpd.current})`, disabled: true },
            codexUpd.previous ? { label: `↩ 이전 버전 ${codexUpd.previous} 으로 되돌리기`, onClick: doCodexRollback } : null,
            { label: '업데이트 다시 확인', onClick: () => checkCodexUpdate(true).then(() => toast(codexUpd?.hasUpdate ? `새 버전 ${codexUpd.latest} 이 있습니다.` : '최신 버전입니다.', 'info')) },
          ]
        : []),
      '-',
      { header: `${aiName()} 의 MCP · 커넥터${cur.live ? ' (이번 대화 연결 상태)' : p === 'codex' ? ' (설정 목록 · 대화를 시작하면 연결 상태 표시)' : ''}` },
      { label: '● codeflow — CodeFlow 도구 (항상 연결)', disabled: true },
      ...mcp.map((m) => ({
        label: `${ico[m.status] || '·'} ${m.name.replace(/^claude\.ai /, '')} — ${word[m.status] || m.status}${src(m)}`,
        disabled: !(m.status === 'needs-auth' && m.source === 'claudeai'),
        onClick: () => window.api.openExternal('https://claude.ai/settings/connectors'),
      })),
      mcp.some((m) => m.status === 'needs-auth' && m.source === 'claudeai') ? { header: '인증 필요 커넥터를 누르면 claude.ai 커넥터 설정이 열립니다' } : null,
      { label: '↻ 다시 확인', onClick: async () => (delete mcpBy[p], await loadMcp(p, true), toast('MCP 상태를 다시 확인했습니다. ⋯ 를 다시 눌러 보세요.', 'info')) },
    ].filter(Boolean));
  };
  const close = h('button', { class: 'tb-btn small', text: '✕', title: 'AI 화면 닫기 — 보던 화면으로 (Ctrl+Shift+A)' });
  close.onclick = () => setVisible(false);
  panel.append(h('div', { class: 'ai-head' }, h('span', { class: 'ai-title', text: '✦ AI' }), sel, h('span', { class: 'tb-spacer' }), phase === 'ready' ? newBtn : null, phase === 'ready' ? histBtn : null, more, close));

  const body = h('div', { class: 'ai-body' });
  panel.append(body);
  if (!state.repo && phase === 'ready') {
    body.append(h('div', { class: 'ai-card', html: '<b>프로젝트를 먼저 여세요.</b><br>AI 는 열린 프로젝트 폴더 기준으로 동작합니다.' }));
    return;
  }
  if (phase === 'checking') return body.append(h('div', { class: 'ai-card', html: '<span class="spinner"></span> 확인하는 중...' }));
  if (phase === 'soon')
    return body.append(
      h('div', {
        class: 'ai-card',
        html: `<b>${esc(aiName())} 연결은 다음 업데이트에서 지원합니다.</b><br>지금은 Claude Code 를 사용할 수 있습니다.`,
      })
    );
  if (phase === 'error') return body.append(h('div', { class: 'ai-card err', text: info?.error || '오류' }));
  if (phase === 'install' || phase === 'installing') return body.append(installCard());
  if (phase === 'login' || phase === 'logging-in') return body.append(loginCard());
  body.append(chatView());
}

function stepper(active) {
  const steps = ['설치', '로그인', '사용'];
  return h('div', { class: 'ai-steps' }, ...steps.map((s, i) => h('span', { class: `ai-step ${i < active ? 'done' : i === active ? 'now' : ''}`, text: `${i < active ? '✓' : i + 1} ${s}` })));
}

function installCard() {
  const busy = phase === 'installing';
  const btn = h('button', { class: 'btn primary', text: busy ? '설치 중...' : `${aiName()} 설치` });
  btn.disabled = busy;
  btn.onclick = doInstall;
  return h(
    'div',
    { class: 'ai-card' },
    stepper(0),
    h('div', {
      class: 'ai-p',
      html: `<b>${esc(aiName())}</b> 가 이 PC 에 설치되어 있지 않습니다.<br>VS Code 확장처럼 CodeFlow 가 공식 설치 프로그램으로 설치합니다 (사용자 폴더에 설치, 관리자 권한 불필요, 약 1분).`,
    }),
    btn,
    h('pre', { class: 'ai-log', id: 'aiLog', text: logLines.join('\n') })
  );
}

function loginCard() {
  const busy = phase === 'logging-in';
  const ai = AIS.find((a) => a.id === provider);
  const btn = h('button', { class: 'btn primary', text: busy ? '브라우저에서 로그인 중...' : `${ai.vendor} 계정으로 로그인` });
  btn.disabled = busy;
  btn.onclick = doLogin;
  const parts = [
    stepper(1),
    h('div', {
      class: 'ai-p',
      html: `${esc(aiName())} ${esc(info?.version || '')} 설치됨.<br><b>${esc(ai.login)}</b> 으로 로그인하세요. 버튼을 누르면 브라우저가 열립니다.<br><span class="ai-dim">로그인 정보는 ${esc(aiName())} 가 직접 보관합니다 (CodeFlow 는 비밀번호를 보거나 저장하지 않음).</span>`,
    }),
    btn,
  ];
  if (busy) {
    const code = h('input', { class: 'ai-code', placeholder: '브라우저에 표시된 코드를 붙여 넣으라고 하면 여기에 입력 후 Enter' });
    code.onkeydown = (e) => {
      if (e.key === 'Enter' && code.value.trim()) {
        window.api.ai.loginInput(`${code.value.trim()}\r`);
        code.value = '';
      }
    };
    const cancel = h('button', { class: 'tb-btn small', text: '취소' });
    cancel.onclick = async () => {
      phase = 'login';
      await window.api.ai.cancelLogin();
      render();
    };
    const recheck = h('button', { class: 'tb-btn small', text: '로그인 확인' });
    recheck.onclick = refreshStatus;
    parts.push(h('div', { class: 'ai-p ai-dim', id: 'aiLoginUrl' }), code, h('div', { class: 'ai-row' }, recheck, cancel));
  }
  parts.push(h('pre', { class: 'ai-log', id: 'aiLog', text: logLines.join('\n') }));
  return h('div', { class: 'ai-card' }, ...parts);
}

function showLoginUrl(url) {
  const el = $('#aiLoginUrl');
  if (!el) return;
  el.innerHTML = '';
  const a = h('a', { href: '#', text: '브라우저가 안 열리면 여기를 눌러 로그인 페이지 열기' });
  a.onclick = (e) => {
    e.preventDefault();
    window.api.openExternal(url);
  };
  el.append(a);
}

// ---------- 대화 ----------

function chatFor(repo) {
  const k = repoKey(repo);
  if (!chats.has(k)) chats.set(k, { repo, loaded: false, conv: newConv(), procs: {}, procProvider: null, attach: [], procId: null, sessionId: null, busy: false, list: h('div', { class: 'ai-msgs' }), msgs: new Map(), tools: new Map(), toolNames: new Map(), alwaysAllow: new Set(), ctx: null, mcp: null });
  return chats.get(k);
}

// ---------- 공유 대화 (AI 를 바꿔도 같은 대화) ----------

function newConv() {
  return { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, title: '', created: Date.now(), updated: Date.now(), entries: [], native: {} };
}

function saveConv(c) {
  if (!c.conv.entries.length) return;
  window.api.ai.convSave(c.repo, c.conv).catch?.(() => {});
}

// 이 AI 가 아직 모르는 내용(다른 AI 와 나눈 대화)을 글로 정리해서 질문 앞에 붙인다
const HANDOFF_LIMIT = 16000;
function handoffText(c, p) {
  const seen = c.conv.native[p]?.seen || 0;
  const unseen = c.conv.entries.slice(seen);
  if (!unseen.length) return '';
  const lines = [];
  for (const e of unseen) {
    if (e.role === 'user') lines.push(`[사용자]${e.attachments?.length ? ` (첨부: ${e.attachments.join(', ')})` : ''}\n${e.text}`);
    else lines.push(`[${nameOf(e.provider)}]\n${e.text || '(글 없이 작업만 함)'}${e.tools?.length ? `\n(한 작업: ${e.tools.map((t) => t.desc).join(' / ')})` : ''}`);
  }
  let body = lines.join('\n\n');
  if (body.length > HANDOFF_LIMIT) body = `(앞부분 생략)\n…${body.slice(-HANDOFF_LIMIT)}`;
  const first = !c.conv.native[p];
  return (
    `[CodeFlow 안내] 이 대화는 CodeFlow 에서 사용자가 여러 AI(Claude Code, Codex)를 바꿔 가며 이어 온 하나의 대화입니다. ` +
    `${first ? '당신은 이 대화에 처음 참여합니다. 지금까지' : '당신이 마지막으로 답한 뒤'} 오간 내용은 아래와 같습니다. 이 내용을 알고 있는 것처럼 자연스럽게 이어서 답하세요 (이미 한 작업을 반복하지 말 것).\n` +
    `--- 이전 대화 ---\n${body}\n--- 끝 ---\n\n[사용자의 새 메시지]\n`
  );
}

// 한 번의 질문-답변이 끝나면 대화에 기록하고 저장
function finishTurn(c) {
  const t = c.turn;
  if (!t) return;
  c.turn = null;
  const text = [...t.texts.values()].filter((x) => x && x.trim()).join('\n\n');
  if (text || t.tools.length) c.conv.entries.push({ role: 'assistant', provider: t.provider, text, tools: t.tools, at: Date.now() });
  c.conv.native[t.provider] = { ...(c.conv.native[t.provider] || {}), seen: c.conv.entries.length };
  saveConv(c);
  showMadeFiles(c, t, text).catch(() => {});
}

// 명령(파이썬 스크립트 등)으로 만든 파일은 파일 도구를 거치지 않아 카드가 안 생긴다
// → 답변에 나온 파일 경로 중 이번 답변 동안 새로 만들어진(또는 바뀐) 파일을 찾아 카드로 보여 준다
const PATH_RE = /([A-Za-z]:[\\/][^\s`'"<>|*?\n]+?\.[A-Za-z0-9]{1,6})(?=[\s`'")\],.;:]|$)|`([^`\s]+\.[A-Za-z0-9]{1,6})`/g;
async function showMadeFiles(c, t, text) {
  if (!t.start) return;
  // 답변 글 + 실행한 명령(예: Set-Content 'C:\…\a.csv') 에서 경로를 찾는다
  text = [text || '', ...t.tools.map((x) => x.input?.command || x.input?.file_path || '')].join('\n');
  const out = await window.api.ai
    .outputDir(c.repo)
    .then((r) => (r.ok ? r.data : null))
    .catch(() => null);
  const found = new Set();
  for (const m of text.matchAll(PATH_RE)) {
    const p = (m[1] || m[2] || '').replace(/[.,;:)\]'"]+$/, '');
    if (!p) continue;
    if (/^[A-Za-z]:[\\/]/.test(p)) {
      found.add(p.replace(/[\\/]+/g, '\\')); // 명령 안의 'C:\\\\a\\\\b' 같은 이중 역슬래시도 정리
      continue;
    }
    // 이름만 나오면 프로젝트와 임시 결과물 폴더 두 곳을 본다
    const rel = p.replace(/\//g, '\\');
    found.add(`${c.repo.replace(/[\\/]$/, '')}\\${rel}`);
    if (out) found.add(`${out}\\${rel}`);
  }
  const last = [...c.list.querySelectorAll('.ai-msg.assistant')].pop();
  const uniq = [...new Map([...found].map((p) => [p.toLowerCase(), p])).values()];
  for (const p of uniq.slice(0, 8)) {
    if (c.fileCards?.has(p.toLowerCase())) continue;
    const st = await window.api.file.stat(p).catch(() => null);
    if (!st?.ok || !st.data.isFile || st.data.mtime < t.start - 10000) continue; // 이번에 만든·바꾼 파일만
    if (/[\\/]ai[\\/]drafts[\\/]/i.test(p)) {
      (c.fileCards ||= new Map()).set(p.toLowerCase(), { remove() {} });
      askSaveLocation(c.repo, { path: p }, { auto: true });
      continue;
    }
    const card = fileCard(p, { verb: '만듦', openFile: (f, sel, o) => (window.dispatchEvent(new CustomEvent('cf-set-view', { detail: 'code' })), activateCode().then(() => openFile(f, sel, o))) });
    (c.fileCards ||= new Map()).set(p.toLowerCase(), card);
    (last || c.list).append(card);
  }
}

// 도구 기록용: 다시 그릴 때 필요한 값만
const toolRec = (id, name, input = {}) => ({ id, name, desc: describeTool(name, input), input: Object.fromEntries(['file_path', 'command', 'pattern', 'path', 'query', 'url', 'view', 'line'].filter((k) => input[k] !== undefined).map((k) => [k, typeof input[k] === 'string' ? input[k].slice(0, 1500) : input[k]])) });

function chatView() {
  const c = chatFor(state.repo);
  if (!c.loaded) ensureLoaded(c);
  const wrap = h('div', { class: 'ai-chat' });
  if (!c.list.childElementCount) c.list.append(welcomeNote());
  const strip = h('div', { class: 'ai-attach', id: 'aiAttach' });
  const input = h('textarea', { class: 'ai-input', id: 'aiInput', rows: 3, placeholder: '무엇을 도와드릴까요? (Enter 보내기, Shift+Enter 줄바꿈)\n예) 이 프로젝트 실행시켜줘 / CodeFlow 에서 브랜치 합치려면?' });
  const send = h('button', { class: 'btn primary small', id: 'aiSend', text: c.busy ? '■ 중지' : '보내기' });
  send.onclick = () => (c.busy ? stopChat(c) : submit(c, input));
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!c.busy) submit(c, input);
    }
  };
  // 이미지 붙여넣기 (캡처 도구로 복사한 이미지 등)
  input.onpaste = (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) addFileObject(c, f);
  };
  const clip = h('button', { class: 'tb-btn small', text: '📎', title: '파일·이미지 첨부 (붙여넣기 Ctrl+V, 끌어다 놓기도 가능)' });
  clip.onclick = async () => {
    const files = await window.api.pickFiles('AI 에게 보낼 파일 선택', [{ name: '모든 파일', extensions: ['*'] }], state.repo);
    for (const f of files) await addPath(c, f);
  };
  // 패널 어디에든 끌어다 놓기
  wrap.ondragover = (e) => {
    e.preventDefault();
    wrap.classList.add('drop');
  };
  wrap.ondragleave = (e) => {
    if (!wrap.contains(e.relatedTarget)) wrap.classList.remove('drop');
  };
  wrap.ondrop = async (e) => {
    e.preventDefault();
    wrap.classList.remove('drop');
    for (const f of [...(e.dataTransfer?.files || [])]) {
      const p = window.api.ai.filePath(f);
      if (p) await addPath(c, p);
      else await addFileObject(c, f);
    }
  };
  // 모델 선택 (바꾸면 다음 질문부터 같은 대화를 그 모델로 이어 감)
  const msel = h('select', { class: 'ai-model', id: 'aiModel', title: '모델 (다음 질문부터 적용)' });
  fillModels(msel);
  msel.onchange = () => {
    setModel(provider, msel.value);
    maybeWarm(true);
    toast(`다음 질문부터 ${msel.selectedOptions[0]?.textContent || '기본값'} 모델로 답합니다.`, 'info');
  };
  wrap.append(
    c.list,
    h(
      'div',
      { class: 'ai-compose' },
      h('div', { class: 'ai-wake', id: 'aiWake', hidden: true }),
      strip,
      input,
      h('div', { class: 'ai-row' }, clip, msel, h('span', { class: 'tb-spacer' }), send),
      // 컨텍스트 · 세션 · 주간 사용량은 따로 한 줄 (패널이 좁으면 다음 줄로 넘어감)
      h('div', { class: 'ai-meters', id: 'aiMeters' })
    )
  );
  // 화면에 붙은 다음에 채운다 (#aiMeters 등을 id 로 찾으므로)
  setTimeout(() => {
    drawMeters(c);
    drawAttach(c);
    drawWake(c);
  });
  requestAnimationFrame(() => (c.list.scrollTop = c.list.scrollHeight));
  return wrap;
}

function fillModels(msel = $('#aiModel')) {
  if (!msel) return;
  msel.innerHTML = '';
  for (const [id, label] of modelsFor(provider)) msel.append(h('option', { value: id, text: label }));
  const cur = getModel(provider);
  msel.value = modelsFor(provider).some((m) => m[0] === cur) ? cur : '';
  if (provider === 'codex' && !codexModels.length) msel.title = '모델 목록은 Codex 와 처음 대화하면 표시됩니다';
}

function welcomeNote() {
  return h('div', {
    class: 'ai-note',
    html:
      '이 프로젝트 폴더에서 AI 가 실행됩니다. 코드 질문, 수정, 실행은 물론 <b>CodeFlow 사용법</b>도 물어보세요.<br>' +
      'AI 가 CodeFlow 터미널에서 명령을 실행하거나 파일을 열 수 있고, 파일 수정·명령 실행 전에는 허용 여부를 묻습니다.<br>' +
      '위쪽에서 <b>AI 를 바꿔도 대화는 그대로</b> 이어집니다 — 새 AI 에게 지금까지의 대화를 넘겨 줍니다.',
  });
}

// 새 대화: 지금 대화를 끝내고 빈 대화로 (지난 대화는 Claude Code 가 저장해 두므로 🕘 에서 다시 열 수 있음)
function newChat() {
  const c = chatFor(state.repo);
  stopAllProcs(c);
  clearActivity(c);
  chats.delete(repoKey(state.repo));
  chatFor(state.repo).loaded = true; // 새 대화: 지난 대화를 불러오지 않음
  render();
  maybeWarm();
}

// 지난 대화 목록 (CodeFlow 대화 — AI 를 바꿔 가며 한 대화 포함) + 예전 Claude Code 기록
const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? '방금' : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`;
};
async function openHistory(anchor) {
  const [a, b] = await Promise.all([window.api.ai.convList(state.repo), window.api.ai.sessions(state.repo)]);
  const convs = a.ok ? a.data : [];
  const linked = new Set(convs.map((x) => x.native?.claude?.id).filter(Boolean));
  const legacy = (b.ok ? b.data : []).filter((s) => !linked.has(s.id));
  const cur = chatFor(state.repo).conv.id;
  const short = { claude: 'Claude', codex: 'Codex' };
  menuAt(anchor, [
    { header: `지난 대화 · ${state.repo.split(/[\\/]/).pop()}` },
    ...(convs.length
      ? convs.slice(0, 25).map((s) => ({ label: `${s.id === cur ? '✓ ' : ''}${s.title || '(제목 없음)'}`, hint: `${s.providers.map((p) => short[p] || p).join('+') || '-'} · ${ago(s.updated)} · ${s.count}개`, onClick: () => loadConv(s.id) }))
      : [{ label: 'CodeFlow 에서 나눈 대화가 없습니다', disabled: true }]),
    ...(legacy.length ? ['-', { header: '예전 Claude Code 기록' }, ...legacy.slice(0, 15).map((s) => ({ label: s.title, hint: `${ago(s.updated)} · ${s.count}개`, onClick: () => loadSession(s.id) }))] : []),
  ]);
}

// 저장된 대화를 화면에 다시 그리기
function drawConv(c) {
  let prev = null;
  c.conv.entries.forEach((e, i) => {
    if (e.role === 'user') {
      const bubble = h('div', { class: 'ai-msg user' });
      if (e.attachments?.length) bubble.append(h('div', { class: 'ai-attach in-msg' }, ...e.attachments.map((n) => h('div', { class: 'ai-chip', text: `📎 ${n}` }))));
      bubble.append(h('div', { text: e.text }));
      c.list.append(bubble);
      return;
    }
    if (prev && prev !== e.provider) c.list.append(h('div', { class: 'ai-switch', text: `${nameOf(prev)} → ${nameOf(e.provider)} 로 이어서 대화` }));
    prev = e.provider;
    const m = msgEntry(c, `h${i}`, e.provider);
    for (const t of e.tools || []) {
      m.blocks.push({ type: 'tool_use', id: t.id || `t${i}${Math.random()}`, name: t.name, input: t.input || {} });
      if (t.id) c.toolNames.set(t.id, t.name), (c.toolInputs ||= new Map()).set(t.id, t.input || {});
    }
    if (e.text) m.blocks.push({ type: 'text', text: e.text });
    renderBlocks(c, m);
    for (const t of e.tools || []) {
      const chip = c.tools.get(t.id);
      chip?.classList.remove('running');
      chip?.classList.add(t.ok === false ? 'failed' : 'done');
      if (t.ok !== false && t.id) addFileCard(c, t.id);
    }
  });
  for (const chip of c.tools.values()) chip.classList.remove('running');
}

// 프로젝트를 처음 열면(이번 실행에서) 그 프로젝트의 가장 최근 대화를 불러와 이어 간다 — 새 대화는 ＋ 로
function ensureLoaded(c) {
  if (c.loaded) return Promise.resolve();
  if (c.loadP) return c.loadP;
  c.loadP = (async () => {
    const r = await window.api.ai.convList(c.repo).catch(() => null);
    const last = r?.ok ? r.data[0] : null;
    if (last && !c.conv.entries.length && !c.busy) {
      const lr = await window.api.ai.convLoad(c.repo, last.id).catch(() => null);
      if (lr?.ok && !c.conv.entries.length && !c.busy) {
        c.conv = lr.data;
        c.list.innerHTML = '';
        c.list.append(welcomeNote());
        drawConv(c);
        c.list.append(h('div', { class: 'ai-foot', text: `가장 최근 대화를 이어서 보여 줍니다 (${ago(last.updated)}). 새로 시작하려면 ＋ 를 누르세요.` }));
      }
    }
    c.loaded = true;
    if (repoKey(c.repo) === repoKey(state.repo) && visible) {
      render();
      requestAnimationFrame(() => (c.list.scrollTop = c.list.scrollHeight));
    }
  })();
  return c.loadP;
}

function resetChat() {
  const old = chatFor(state.repo);
  stopAllProcs(old);
  clearActivity(old);
  chats.delete(repoKey(state.repo));
  const c = chatFor(state.repo);
  c.loaded = true;
  return c;
}

async function loadConv(id) {
  const r = await window.api.ai.convLoad(state.repo, id);
  if (!r.ok) return toast(r.error, 'error');
  const c = resetChat();
  c.conv = r.data;
  c.list.append(welcomeNote());
  drawConv(c);
  const used = [...new Set(c.conv.entries.filter((e) => e.role === 'assistant').map((e) => nameOf(e.provider)))];
  c.list.append(h('div', { class: 'ai-foot', text: `지난 대화를 불러왔습니다${used.length ? ` (${used.join(', ')})` : ''}. 이어서 질문하면 지금 고른 AI(${aiName()})가 이 대화를 이어 갑니다.` }));
  render();
  maybeWarm();
}

// 예전(0.6.x) Claude Code 기록 → CodeFlow 대화로 옮겨서 열기
async function loadSession(id) {
  const r = await window.api.ai.transcript(state.repo, id);
  if (!r.ok) return toast(r.error, 'error');
  const conv = newConv();
  let cur = null;
  const ok = new Map();
  for (const it of r.data) if (it.role === 'tool_result') ok.set(it.id, !it.error);
  for (const it of r.data) {
    if (it.role === 'user') {
      cur = null;
      conv.entries.push({ role: 'user', text: it.text, at: Date.now() });
      if (!conv.title) conv.title = it.text.replace(/\s+/g, ' ').slice(0, 60);
    } else if (it.role === 'assistant') {
      if (!cur) conv.entries.push((cur = { role: 'assistant', provider: 'claude', text: '', tools: [] }));
      for (const b of it.blocks) {
        if (b.type === 'text') cur.text = cur.text ? `${cur.text}\n\n${b.text}` : b.text;
        else if (b.type === 'tool_use') cur.tools.push({ ...toolRec(b.id, b.name, b.input), ok: ok.get(b.id) });
      }
    }
  }
  conv.native.claude = { id, seen: conv.entries.length };
  await window.api.ai.convSave(state.repo, conv);
  loadConv(conv.id);
}

// ---------- 진행 상태 (생각 중 / 답변 작성 중 / 도구 실행 중 / 허용 대기) ----------

const fmtTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function setActivity(c, kind, extra = {}) {
  if (!c.activity) c.activity = { start: Date.now(), tokens: 0 };
  Object.assign(c.activity, { kind }, extra);
  if (!c.activityEl) c.activityEl = h('div', { class: 'ai-activity' });
  if (c.activityEl.parentNode !== c.list || c.list.lastElementChild !== c.activityEl) c.list.append(c.activityEl);
  drawActivity(c);
  if (!c.activityTimer) c.activityTimer = setInterval(() => drawActivity(c), 1000);
  scrollDown(c);
}

function drawActivity(c) {
  const a = c.activity;
  if (!a || !c.activityEl) return;
  const secs = Math.floor((Date.now() - a.start) / 1000);
  const label = {
    starting: `${aiName()} 깨우는 중`,
    requesting: '요청 보내는 중',
    thinking: '생각 중',
    writing: '답변 작성 중',
    tool: a.text || '도구 실행 중',
    waiting: '허용을 기다리는 중',
    compacting: '컨텍스트 정리 중',
  }[a.kind];
  const tok = a.tokens ? ` · ${fmtTok(a.tokens)} 토큰` : '';
  c.activityEl.innerHTML = `<span class="ai-dots"><i></i><i></i><i></i></span> ${esc(label)}${tok} · ${secs}초`;
}

function clearActivity(c) {
  clearInterval(c.activityTimer);
  c.activityTimer = null;
  c.activity = null;
  c.activityEl?.remove();
}

// 입력창 아래: 컨텍스트 사용량 + 플랜 사용량
function drawMeters(c) {
  const el = $('#aiMeters');
  if (!el || repoKey(c.repo) !== repoKey(state.repo)) return;
  el.innerHTML = '';
  if (c.ctx?.window) {
    const pct = Math.min(100, Math.round((c.ctx.used / c.ctx.window) * 100));
    const m = h(
      'span',
      { class: `ai-meter ${pct >= 80 ? 'warn' : ''}`, title: `컨텍스트 ${fmtTok(c.ctx.used)} / ${fmtTok(c.ctx.window)} 토큰\n가득 차면 자동으로 정리(요약)됩니다. 눌러서 지금 정리할 수 있습니다.` },
      h('span', { text: `컨텍스트 ${pct}%` }),
      h('span', { class: 'ai-bar' }, h('i', { style: { width: `${pct}%` } }))
    );
    m.onclick = () =>
      menuAt(m, [
        { header: `컨텍스트 ${fmtTok(c.ctx.used)} / ${fmtTok(c.ctx.window)} 토큰 (${pct}%)` },
        { label: '지금 정리하기 (/compact) — 지난 내용을 요약해서 공간 확보', disabled: c.busy || !c.procId || c.procProvider !== 'claude', onClick: () => compact(c) },
        { header: `가득 차면 ${nameOf(c.procProvider || provider)} 가 자동으로 정리합니다` },
      ]);
    el.append(m);
  }
  if (rateInfo[provider]) {
    const win = (w0) => {
      if (!w0) return null;
      const w = w0.resetsAt && w0.resetsAt * 1000 < Date.now() ? { ...w0, utilization: 0 } : w0;
      const name = w.label;
      const pct = Math.round((w.utilization || 0) * 100);
      const left = w.resetsAt ? Math.max(0, w.resetsAt * 1000 - Date.now()) : 0;
      const when = left < 3600e3 ? `${Math.round(left / 60000)}분 후` : left < 86400e3 ? `${Math.floor(left / 3600e3)}시간 ${Math.round((left % 3600e3) / 60000)}분 후` : new Date(w.resetsAt * 1000).toLocaleString('ko-KR', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      return h('span', { class: `ai-meter ${pct >= 80 ? 'warn' : ''}`, title: `${name} 사용량 ${pct}% · ${when} 초기화` }, h('span', { text: `${name} ${pct}%` }), h('span', { class: 'ai-bar' }, h('i', { style: { width: `${pct}%` } })));
    };
    for (const w of rateInfo[provider]) {
      const x = win(w);
      if (x) el.append(x);
    }
  }
}

function compact(c) {
  c.busy = true;
  updateSendButton(c);
  c.list.append(h('div', { class: 'ai-foot', text: '지난 대화를 요약해서 컨텍스트를 정리합니다…' }));
  setActivity(c, 'compacting');
  window.api.ai.send(c.procId, '/compact');
}

function updateSendButton(c) {
  if (repoKey(c.repo) !== repoKey(state.repo)) return;
  const b = $('#aiSend');
  if (b) b.textContent = c.busy ? '■ 중지' : '보내기';
}

function scrollDown(c) {
  const l = c.list;
  if (l.scrollHeight - l.scrollTop - l.clientHeight < 200) l.scrollTop = l.scrollHeight;
}

async function submit(c, input) {
  let text = input.value.trim();
  const att = c.attach.splice(0);
  if (!text && !att.length) return;
  if (!text) text = '첨부한 파일을 확인해 주세요.';
  input.value = '';
  drawAttach(c);
  const bubble = h('div', { class: 'ai-msg user' });
  if (att.length) bubble.append(h('div', { class: 'ai-attach in-msg' }, ...att.map((a) => attachChip(a))));
  bubble.append(h('div', { text }));
  c.list.append(bubble);
  // 이미지·PDF 는 내용 그대로, 그 밖의 파일은 경로를 알려 주고 AI 가 직접 읽게
  const others = att.filter((a) => a.kind === 'file');
  const content = [
    ...att.filter((a) => a.kind === 'image').map((a) => ({ type: 'image', source: { type: 'base64', media_type: a.mime, data: a.data } })),
    ...att.filter((a) => a.kind === 'pdf').map((a) => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data }, title: a.name })),
    { type: 'text', text: others.length ? `${text}\n\n[첨부 파일 — Read 도구로 읽어 주세요]\n${others.map((a) => a.path).join('\n')}` : text },
  ];
  // AI 를 바꿨으면: 새 AI 에게 그동안의 대화를 넘겨 준다
  const lastAi = [...c.conv.entries].reverse().find((e) => e.role === 'assistant')?.provider;
  const handoff = handoffText(c, provider);
  if (lastAi && lastAi !== provider) c.list.insertBefore(h('div', { class: 'ai-switch', text: `${nameOf(lastAi)} → ${aiName()} 로 이어서 대화 (지난 대화를 넘겨 줌)` }), bubble);
  if (handoff) {
    const tb = content.find((b) => b.type === 'text');
    tb.text = handoff + tb.text;
    text = handoff + text;
  }
  c.conv.entries.push({ role: 'user', text: input.dataset.sent || bubble.lastChild.textContent, attachments: att.map((a) => a.name), at: Date.now() });
  if (!c.conv.title) c.conv.title = bubble.lastChild.textContent.replace(/\s+/g, ' ').slice(0, 60);
  c.turn = { provider, texts: new Map(), tools: [], start: Date.now() };
  saveConv(c);
  c.list.scrollTop = c.list.scrollHeight;
  c.busy = true;
  updateSendButton(c);
  setActivity(c, 'requesting', { start: Date.now(), tokens: 0 });
  try {
    // 미리 깨워 둔 이 AI 의 프로그램을 쓴다 (없거나 설정이 바뀌었으면 지금 깨우고 준비될 때까지 기다림)
    const pr = await warm(c, provider);
    if (!pr.ready) {
      setActivity(c, 'starting');
      await pr.readyP;
    }
    if (!c.procs[provider]) throw new Error(`${aiName()} 를 시작하지 못했습니다.`);
    c.procId = pr.id;
    c.procProvider = provider;
    setActivity(c, 'requesting');
    const r = await window.api.ai.send(c.procId, att.length ? content : text);
    if (!r.ok) throw new Error(r.error);
  } catch (e) {
    c.busy = false;
    updateSendButton(c);
    clearActivity(c);
    finishTurn(c);
    c.list.append(h('div', { class: 'ai-msg err', text: `보내지 못했습니다: ${e.message}` }));
  }
}

// ---------- 첨부 ----------

const MAX_SIDE = 1568; // 이보다 큰 이미지는 줄여서 보낸다 (AI 가 어차피 줄여서 보고, 전송·토큰도 아낌)
const OK_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이미지를 읽지 못했습니다.'));
    img.src = src;
  });
}

// 크기를 줄이거나 지원하지 않는 형식(bmp 등)을 png/jpeg 로 바꾼다
async function normalizeImage(mime, data) {
  const img = await loadImage(`data:${mime};base64,${data}`);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  if (scale === 1 && OK_MIME.includes(mime) && data.length < 4.5e6) return { mime, data, w: img.width, h: img.height };
  const cv = document.createElement('canvas');
  cv.width = Math.round(img.width * scale);
  cv.height = Math.round(img.height * scale);
  cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  let url = cv.toDataURL('image/png');
  if (url.length > 4.5e6) url = cv.toDataURL('image/jpeg', 0.85);
  return { mime: url.slice(5, url.indexOf(';')), data: url.slice(url.indexOf(',') + 1), w: cv.width, h: cv.height };
}

// 파일 경로 → 첨부 (이미지는 AI 가 받을 수 있는 크기로 줄임). 팀 화면도 같이 쓴다
export async function attachmentFromPath(file) {
  const r = await window.api.ai.readAttachment(file);
  if (!r.ok) {
    toast(r.error, 'error', 5000);
    return null;
  }
  const a = r.data;
  if (a.kind === 'image') Object.assign(a, await normalizeImage(a.mime, a.data).catch(() => ({})));
  return a;
}
// 붙여넣기한 이미지(파일 경로가 없는 것) → 첨부
export function attachmentFromBlob(f, n = 1) {
  if (!f.type.startsWith('image/')) {
    toast('붙여넣은 내용을 첨부할 수 없습니다. 📎 로 파일을 고르세요.', 'warn');
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const rd = new FileReader();
    rd.onload = async () => {
      const url = String(rd.result);
      const img = await normalizeImage(url.slice(5, url.indexOf(';')), url.slice(url.indexOf(',') + 1)).catch(() => null);
      if (!img) {
        toast('이미지를 읽지 못했습니다.', 'error');
        return resolve(null);
      }
      resolve({ kind: 'image', name: f.name && f.name !== 'image.png' ? f.name : `붙여넣은 이미지 ${n}.png`, ...img, size: Math.round((img.data.length * 3) / 4) });
    };
    rd.readAsDataURL(f);
  });
}

async function addPath(c, file) {
  const a = await attachmentFromPath(file);
  if (a) pushAttach(c, a);
}

// 붙여넣기한 이미지(파일 경로가 없는 것)
async function addFileObject(c, f) {
  const a = await attachmentFromBlob(f, c.attach.length + 1);
  if (a) pushAttach(c, a);
}

function pushAttach(c, a) {
  if (c.attach.length >= 10) return toast('한 번에 10개까지 첨부할 수 있습니다.', 'warn');
  if (c.attach.some((x) => x.path && x.path === a.path)) return;
  c.attach.push(a);
  drawAttach(c);
  $('#aiInput')?.focus();
}

const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

export function attachChip(a, onRemove) {
  const chip = h('div', { class: `ai-chip ${a.kind}`, title: `${a.path || a.name} · ${fmtSize(a.size || 0)}${a.kind === 'file' ? '\nAI 가 경로로 직접 읽습니다' : ''}` });
  if (a.kind === 'image') chip.append(h('img', { src: `data:${a.mime};base64,${a.data}` }));
  else chip.append(h('span', { class: 'ai-chip-ico', text: a.kind === 'pdf' ? '📕' : '📄' }));
  chip.append(h('span', { class: 'ai-chip-name', text: a.name }));
  if (onRemove) {
    const x = h('button', { class: 'ai-chip-x', text: '✕', title: '빼기' });
    x.onclick = onRemove;
    chip.append(x);
  }
  return chip;
}

function drawAttach(c) {
  const el = $('#aiAttach');
  if (!el || repoKey(c.repo) !== repoKey(state.repo)) return;
  el.innerHTML = '';
  el.hidden = !c.attach.length;
  c.attach.forEach((a, i) =>
    el.append(
      attachChip(a, () => {
        c.attach.splice(i, 1);
        drawAttach(c);
      })
    )
  );
}

// ---------- 미리 깨우기 ----------
// 앱을 켤 때 / 프로젝트 탭을 바꿀 때 / AI 를 바꿀 때, 고른 AI 를 그 프로젝트 폴더에서 미리 실행해 둔다
// → 첫 질문 때 프로그램 시작(MCP 연결 등)을 기다리지 않는다. AI 별로 하나씩 켜 두므로 AI 를 바꿔도 다시 켤 필요가 없다

function stopProc(c, p) {
  const pr = c.procs[p];
  if (!pr) return;
  delete c.procs[p];
  byChatId.delete(pr.id);
  if (c.procId === pr.id) c.procId = null;
  window.api.ai.stop(pr.id);
  pr.resolve?.();
}

function stopAllProcs(c) {
  for (const p of Object.keys(c.procs)) stopProc(c, p);
}

function warm(c, p) {
  const want = { dirs: dirsKey(), model: getModel(p) || '' };
  let pr = c.procs[p];
  // 열린 탭이 바뀌었거나(접근할 폴더) 모델을 바꿨으면 같은 대화를 이어서 다시 시작
  if (pr && !c.busy && (pr.dirs !== want.dirs || pr.model !== want.model)) {
    stopProc(c, p);
    pr = null;
  }
  if (pr) return Promise.resolve(pr);
  pr = { id: null, ready: false, ...want };
  pr.readyP = new Promise((res) => (pr.resolve = res));
  c.procs[p] = pr;
  drawWake(c);
  return window.api.ai.start({ provider: p, repo: c.repo, resume: c.conv.native[p]?.id || undefined, addDirs: openDirs(), model: want.model || undefined }).then((r) => {
    if (c.procs[p] !== pr) {
      if (r.ok) window.api.ai.stop(r.data.id); // 그사이 취소됨
      return pr;
    }
    if (!r.ok) {
      delete c.procs[p];
      pr.error = r.error;
      pr.resolve();
      drawWake(c);
      if (/로그인|auth|login/i.test(r.error)) refreshStatus();
      return pr;
    }
    pr.id = r.data.id;
    byChatId.set(pr.id, c);
    if (p === 'codex') markReady(c, pr); // Codex 는 시작이 끝나면 바로 준비됨
    // 혹시 준비 신호가 안 오면 30초 뒤 그냥 준비된 것으로
    setTimeout(() => markReady(c, pr), 30000);
    return pr;
  });
}

function markReady(c, pr) {
  if (pr.ready) return;
  pr.ready = true;
  pr.resolve();
  drawWake(c);
}

// 지금 보이는 프로젝트의 지금 고른 AI 를 깨운다 (설치·로그인된 경우만)
async function maybeWarm(force) {
  if (phase !== 'ready' || !state.repo) return;
  const c = chatFor(state.repo);
  if (!c.loaded) {
    await ensureLoaded(c);
    if (repoKey(c.repo) !== repoKey(state.repo)) return;
  }
  if (force || !c.procs[provider]) warm(c, provider);
  drawWake(c);
  // 이 AI 의 컨텍스트로 바꿔 보여 주고, 이미 깨어 있으면 사용량·컨텍스트를 새로 조회
  c.ctx = c.ctxBy?.[provider] || null;
  drawMeters(c);
  const pr = c.procs[provider];
  if (pr?.ready && pr.id) window.api.ai.refreshUsage(pr.id);
}

// 입력창 위 '깨우는 중' 표시
function drawWake(c) {
  const el = $('#aiWake');
  if (!el || repoKey(c.repo) !== repoKey(state.repo)) return;
  const pr = c.procs[provider];
  if (pr && !pr.ready) {
    el.hidden = false;
    el.innerHTML = `<span class="ai-dots"><i></i><i></i><i></i></span> ${esc(aiName())} 깨우는 중…`;
    el.title = '미리 실행해 두면 질문하자마자 답할 수 있습니다';
  } else if (pr?.ready && el.dataset.state === 'waking') {
    el.innerHTML = `<span class="ai-ok">●</span> ${esc(aiName())} 준비됨`;
    setTimeout(() => {
      if (el.dataset.state === 'ready') el.hidden = true;
    }, 2500);
  } else if (!pr) el.hidden = true;
  el.dataset.state = pr && !pr.ready ? 'waking' : pr ? 'ready' : 'none';
}

function stopChat(c) {
  if (c.procId) stopProc(c, c.procProvider); // 프로그램을 끝내고, 다음 질문 때 같은 대화를 이어서 시작
  c.stopped = true;
}

// 아주 작은 마크다운: 코드 블록, 인라인 코드, 굵게, 제목, 목록, 링크
// 마크다운 → HTML (AI 답변, 이슈 본문): 코드 블록, 표, 제목, 목록(들여쓰기), 인용, 구분선, 굵게·기울임·취소선·인라인 코드·링크
function mdInline(s) {
  const codes = [];
  s = esc(s).replace(/`([^`\n]+)`/g, (_, c) => (codes.push(`<code>${c}</code>`), `\u0001${codes.length - 1}\u0001`));
  s = s
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="#" data-url="$2">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="#" data-url="$2">$2</a>');
  return s.replace(/\u0001(\d+)\u0001/g, (_, i) => codes[+i]);
}

const splitRow = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));

export function md(text) {
  const out = [];
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(mdInline).join('<br>')}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 코드 블록
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      flush();
      const code = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) code.push(lines[i]);
      out.push(`<pre class="ai-code-block"><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    // 표: | a | b |  다음 줄이 |---|---|
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1] || '')) {
      flush();
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : ''));
      const rows = [];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(splitRow(lines[i]));
      i--;
      const td = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${mdInline(c)}</${tag}>`;
      out.push(
        `<div class="ai-table-wrap"><table class="ai-table"><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${head.map((_, k) => td('td', r[k] ?? '', k)).join('')}</tr>`)
          .join('')}</tbody></table></div>`
      );
      continue;
    }
    // 제목
    const hd = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (hd) {
      flush();
      out.push(`<div class="ai-h ai-h${Math.min(hd[1].length, 4)}">${mdInline(hd[2])}</div>`);
      continue;
    }
    // 구분선
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push('<hr class="ai-hr">');
      continue;
    }
    // 인용
    if (/^\s*>/.test(line)) {
      flush();
      const q = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) q.push(lines[i].replace(/^\s*>\s?/, ''));
      i--;
      out.push(`<blockquote class="ai-quote">${md(q.join('\n'))}</blockquote>`);
      continue;
    }
    // 목록 (들여쓰기 수준 유지)
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flush();
      const depth = Math.min(4, Math.floor(li[1].replace(/\t/g, '  ').length / 2));
      const mark = /\d/.test(li[2]) ? li[2].replace(')', '.') : '•';
      const task = li[3].match(/^\[( |x|X)\]\s+(.*)$/);
      const body = task ? `${task[1] === ' ' ? '☐' : '☑'} ${mdInline(task[2])}` : mdInline(li[3]);
      out.push(`<div class="ai-li" style="padding-left:${10 + depth * 16}px"><span class="ai-li-mark">${mark}</span><span>${body}</span></div>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    para.push(line);
  }
  flush();
  return out.join('');
}

export function bindLinks(el) {
  el.querySelectorAll('a[data-url]').forEach((a) => (a.onclick = (e) => (e.preventDefault(), window.api.openExternal(a.dataset.url))));
}

// 도구 호출을 사람이 읽기 쉬운 한 줄로
function describeTool(name, input = {}) {
  const short = (s, n = 90) => (String(s || '').length > n ? `${String(s).slice(0, n)}…` : String(s || ''));
  const rel = (p) => short(String(p || '').replace(state.repo || '', '').replace(/^[\\/]/, ''));
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return `명령 실행: ${short(input.command)}`;
    case 'Read':
      return `파일 읽기: ${rel(input.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
      return `파일 수정: ${rel(input.file_path)}`;
    case 'Write':
      return `파일 쓰기: ${rel(input.file_path)}`;
    case 'Grep':
      return `검색: ${short(input.pattern)}`;
    case 'Glob':
      return `파일 찾기: ${short(input.pattern)}`;
    case 'WebFetch':
      return `웹 페이지 읽기: ${short(input.url)}`;
    case 'WebSearch':
      return `웹 검색: ${short(input.query)}`;
    case 'TodoWrite':
      return '할 일 목록 정리';
    case 'mcp__codeflow__run_in_terminal':
      return `CodeFlow 터미널에서 실행: ${short(input.command)}`;
    case 'mcp__codeflow__read_terminal':
      return 'CodeFlow 터미널 출력 확인';
    case 'mcp__codeflow__list_terminals':
      return 'CodeFlow 터미널 목록 확인';
    case 'mcp__codeflow__open_file':
      return `파일 열기: ${rel(input.path)}${input.line ? `:${input.line}` : ''}`;
    case 'mcp__codeflow__show_view':
      return `화면 이동: ${{ changes: '커밋', log: '히스토리', stash: '스태시', code: '코드' }[input.view] || input.view}`;
    case 'mcp__codeflow__git_status':
      return `Git 상태 확인${input.path ? `: ${input.path.split(/[\\/]/).pop()}` : ''}`;
    case 'mcp__codeflow__save_document':
      return `문서 저장 위치 묻기: ${String(input.path || '').split(/[\\/]/).pop()}`;
    case 'mcp__codeflow__list_projects':
      return '열린 프로젝트 탭 확인';
    case 'mcp__codeflow__switch_project':
      return `프로젝트 탭 전환: ${String(input.path || '').split(/[\\/]/).pop()}`;
    default:
      return `${name.replace(/^mcp__/, '').replace(/__/g, ' · ')}`;
  }
}

// AI 가 파일을 만들거나 고치면 그 도구 표시 아래에 파일 카드 (이미지는 미리보기) — 같은 파일은 마지막 것만
const FILE_TOOLS = { Write: '만듦/덮어씀', Edit: '수정함', MultiEdit: '수정함', NotebookEdit: '수정함' };
function addFileCard(c, toolId) {
  const name = c.toolNames.get(toolId);
  const p = c.toolInputs?.get(toolId)?.file_path || c.toolInputs?.get(toolId)?.notebook_path;
  const chip = c.tools.get(toolId);
  if (!FILE_TOOLS[name] || !p || !chip) return;
  c.fileCards ||= new Map();
  c.fileCards.get(p.toLowerCase())?.remove();
  const card = fileCard(p, { verb: FILE_TOOLS[name], openFile: (f, sel, o) => (window.dispatchEvent(new CustomEvent('cf-set-view', { detail: 'code' })), activateCode().then(() => openFile(f, sel, o))) });
  c.fileCards.set(p.toLowerCase(), card);
  chip.after(card);
}

function msgEntry(c, id, who = c.procProvider || provider) {
  let m = c.msgs.get(id);
  if (!m) {
    m = { el: h('div', { class: 'ai-msg assistant' }), blocks: [], who };
    c.msgs.set(id, m);
    c.list.append(m.el);
  }
  return m;
}

function renderBlocks(c, m) {
  m.el.innerHTML = '';
  if (m.who) m.el.append(h('div', { class: `ai-who ${m.who}`, text: nameOf(m.who) }));
  for (const b of m.blocks) {
    if (b.type === 'text') {
      if (!b.text.trim()) continue;
      const t = h('div', { class: 'ai-text', html: md(b.text) });
      bindLinks(t);
      m.el.append(t);
    } else if (b.type === 'tool_use') {
      let chip = c.tools.get(b.id);
      if (!chip) {
        chip = h('div', { class: 'ai-tool running' }, h('span', { class: 'ai-tool-ico' }), h('span', { class: 'ai-tool-txt', text: describeTool(b.name, b.input) }));
        c.tools.set(b.id, chip);
      } else chip.querySelector('.ai-tool-txt').textContent = describeTool(b.name, b.input);
      m.el.append(chip);
    } else if (b.type === 'thinking' && b.thinking?.trim()) {
      m.el.append(h('div', { class: 'ai-thinking', text: '생각하는 중…' }));
    }
  }
}

function onAiEvent(procId, ev) {
  const c = byChatId.get(procId);
  if (!c) return;
  if (ev.type === 'cf' && ev.kind === 'ready') {
    const pr = Object.values(c.procs).find((x) => x.id === procId);
    if (pr) markReady(c, pr);
    return;
  }
  if (ev.type === 'cf' && ev.kind === 'usage_claude') {
    const w = (x, label) => x && { label, utilization: (x.utilization || 0) / 100, resetsAt: x.resets_at ? Date.parse(x.resets_at) / 1000 : null };
    rateInfo.claude = [w(ev.windows.five_hour, '세션'), w(ev.windows.seven_day, '주간')].filter(Boolean);
    saveRate();
    return drawMeters(c);
  }
  if (ev.type === 'cf' && ev.kind === 'ctx') {
    // 이 대화(세션)의 컨텍스트 — 지금 고른 AI 의 프로그램에서 온 것만 표시
    const pr = Object.entries(c.procs).find(([, x]) => x.id === procId);
    if (pr) (c.ctxBy ||= {})[pr[0]] = { used: ev.used, window: ev.window };
    if (!pr || pr[0] === provider) c.ctx = { used: ev.used, window: ev.window };
    return drawMeters(c);
  }
  if (ev.type === 'cf') return onCfEvent(c, ev);
  if (ev.type === 'system' && ev.subtype === 'init') {
    c.sessionId = ev.session_id;
    c.conv.native.claude = { ...(c.conv.native.claude || {}), id: ev.session_id };
    c.mcp = ev.mcp_servers || [];
    mcpBy.claude = { list: c.mcp, at: Date.now(), live: true };
    return;
  }
  if (ev.type === 'system' && ev.subtype === 'status' && ev.status === 'requesting' && c.busy) return setActivity(c, c.activity?.kind === 'compacting' ? 'compacting' : 'requesting');
  if (ev.type === 'system' && ev.subtype === 'thinking_tokens' && c.busy) return setActivity(c, 'thinking', { tokens: (c.activity?.base || 0) + (ev.estimated_tokens || 0) });
  if (ev.type === 'rate_limit_event') {
    const w = ev.rate_limit_info?.unifiedWindows;
    if (w) rateInfo.claude = [w.five_hour && { label: '세션', ...w.five_hour }, w.seven_day && { label: '주간', ...w.seven_day }].filter(Boolean);
    saveRate();
    return drawMeters(c);
  }
  if (ev.type === 'stream_event') {
    const e = ev.event || {};
    if (e.type === 'message_start') {
      c.cur = e.message?.id;
      msgEntry(c, c.cur).blocks = [];
      // 컨텍스트 사용량 = 이번 요청에 들어간 토큰 전체
      const u = e.message?.usage || {};
      const used = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      if (used) {
        c.ctx = { used, window: c.ctx?.window || 200000 };
        drawMeters(c);
      }
      if (c.activity) c.activity.base = c.activity.tokens || 0;
    } else if (e.type === 'content_block_start' && c.cur) {
      const m = msgEntry(c, c.cur);
      m.blocks[e.index] = { ...e.content_block, text: e.content_block.text || '' };
      renderBlocks(c, m);
      if (e.content_block?.type === 'text') setActivity(c, 'writing');
      else if (e.content_block?.type === 'tool_use') setActivity(c, 'tool', { text: `준비 중: ${describeTool(e.content_block.name, {}).replace(/[:·]\s*$/, '')}` });
    } else if (e.type === 'content_block_delta' && c.cur) {
      const m = msgEntry(c, c.cur);
      const b = m.blocks[e.index];
      if (b && e.delta?.type === 'text_delta') {
        b.text += e.delta.text;
        renderBlocks(c, m);
        if (c.activity) setActivity(c, 'writing', { tokens: c.activity.tokens + Math.max(1, Math.round(e.delta.text.length / 2)) });
      }
    } else if (e.type === 'message_delta' && e.usage?.output_tokens && c.activity) {
      c.activity.tokens = (c.activity.base || 0) + e.usage.output_tokens;
      drawActivity(c);
    }
    scrollDown(c);
    return;
  }
  if (ev.type === 'assistant') {
    const msg = ev.message || {};
    if (ev.error === 'authentication_failed' || /Failed to authenticate|Invalid API key|Please run \/login/i.test(JSON.stringify(msg.content || ''))) {
      c.busy = false;
      updateSendButton(c);
      toast(`${aiName()} 로그인이 필요합니다.`, 'warn', 6000);
      phase = 'login';
      info = { ...(info || {}), loggedIn: false };
      if (c.procId) window.api.ai.stop(c.procId);
      return render();
    }
    const m = msgEntry(c, msg.id || `m${Date.now()}`);
    // 한 메시지가 블록별로 나뉘어 올 수 있으므로 같은 id 는 합친다
    for (const b of msg.content || []) {
      const i = m.blocks.findIndex((x) => x && ((b.id && x.id === b.id) || (b.type === 'text' && x.type === 'text' && x.text === b.text)));
      if (i >= 0) m.blocks[i] = b;
      else if (b.type === 'text' && m.blocks.some((x) => x?.type === 'text' && b.text.startsWith(x.text))) m.blocks[m.blocks.findIndex((x) => x?.type === 'text' && b.text.startsWith(x.text))] = b;
      else m.blocks.push(b);
    }
    m.blocks = m.blocks.filter(Boolean);
    renderBlocks(c, m);
    for (const b of msg.content || []) if (b.type === 'tool_use') c.toolNames.set(b.id, b.name), (c.toolInputs ||= new Map()).set(b.id, b.input);
    // 대화 기록용
    if (c.turn) {
      const txt = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      if (txt) c.turn.texts.set(msg.id || `m${c.turn.texts.size}`, txt);
      for (const b of msg.content || []) if (b.type === 'tool_use' && !c.turn.tools.some((t) => t.id === b.id)) c.turn.tools.push(toolRec(b.id, b.name, b.input));
    }
    const tool = [...(msg.content || [])].reverse().find((b) => b.type === 'tool_use');
    if (tool && c.busy) setActivity(c, 'tool', { text: `실행 중: ${describeTool(tool.name, tool.input)}` });
    scrollDown(c);
    return;
  }
  if (ev.type === 'user') {
    // 도구 실행 결과 → 해당 도구 표시를 완료/실패로
    for (const b of ev.message?.content || []) {
      if (b.type !== 'tool_result') continue;
      const chip = c.tools.get(b.tool_use_id);
      if (!chip) continue;
      chip.classList.remove('running');
      chip.classList.add(b.is_error ? 'failed' : 'done');
      const out = Array.isArray(b.content) ? b.content.map((x) => x.text || '').join('\n') : String(b.content || '');
      if (out.trim()) chip.title = out.slice(0, 2000);
      if (!b.is_error) addFileCard(c, b.tool_use_id);
      const rec = c.turn?.tools.find((t) => t.id === b.tool_use_id);
      if (rec) rec.ok = !b.is_error;
      // 파일을 바꾸는 도구가 끝나면 CodeFlow 화면(열린 파일, 변경 목록)을 바로 새로 읽는다 (예전 내용으로 덮어쓰지 않게)
      if (!b.is_error && /^(Edit|MultiEdit|Write|NotebookEdit|Bash|PowerShell)$/.test(c.toolNames.get(b.tool_use_id) || '')) {
        clearTimeout(c.refreshTimer);
        c.refreshTimer = setTimeout(() => refresh(), 300);
      }
    }
    if (c.busy) setActivity(c, 'requesting');
    return;
  }
  if (ev.type === 'result') {
    c.busy = false;
    updateSendButton(c);
    clearActivity(c);
    // 모델의 컨텍스트 크기
    const mu = Object.values(ev.modelUsage || {})[0];
    if (mu?.contextWindow && c.ctx) c.ctx.window = mu.contextWindow;
    drawMeters(c);
    for (const chip of c.tools.values()) chip.classList.remove('running');
    if (ev.is_error && ev.result && !/authenticate/i.test(ev.result)) c.list.append(h('div', { class: 'ai-msg err', text: ev.result }));
    const secs = ev.duration_ms ? `${(ev.duration_ms / 1000).toFixed(0)}초` : '';
    if (secs) c.list.append(h('div', { class: 'ai-foot', text: `완료 · ${secs}` }));
    finishTurn(c);
    scrollDown(c);
    return;
  }
  if (ev.type === 'exit') {
    byChatId.delete(procId);
    for (const [p, pr] of Object.entries(c.procs))
      if (pr.id === procId) {
        delete c.procs[p];
        pr.resolve?.();
      }
    drawWake(c);
    const quiet = c.procId !== procId && !c.busy; // 미리 깨워 둔(쓰지 않던) 프로그램이 끝난 것
    if (c.procId === procId) c.procId = null;
    if (quiet) return;
    const wasBusy = c.busy;
    c.busy = false;
    updateSendButton(c);
    clearActivity(c);
    finishTurn(c);
    for (const chip of c.tools.values()) chip.classList.remove('running');
    if (c.stopped) {
      c.stopped = false;
      c.list.append(h('div', { class: 'ai-foot', text: '중지했습니다. 이어서 질문하면 같은 대화로 계속합니다.' }));
    } else if (wasBusy || ev.code) {
      c.list.append(h('div', { class: 'ai-msg err', text: `${aiName()} 가 종료되었습니다 (코드 ${ev.code}). ${ev.stderr ? ev.stderr.split('\n').slice(-3).join(' ') : ''}` }));
    }
  }
}

// ---------- Codex 이벤트 (main/codex.js 가 공통 모양으로 바꿔 보냄) ----------

function onCfEvent(c, ev) {
  switch (ev.kind) {
    case 'init':
      c.sessionId = ev.sessionId;
      c.conv.native.codex = { ...(c.conv.native.codex || {}), id: ev.sessionId };
      return;
    case 'models':
      codexModels = ev.models;
      localStorage.setItem('ai.codexModels', JSON.stringify(ev.models));
      if (provider === 'codex') fillModels();
      return;
    case 'mcp':
      c.mcp = ev.servers;
      mcpBy.codex = { list: ev.servers, at: Date.now(), live: true };
      return;
    case 'turn_start':
      c.cur = `turn-${ev.turnId}`;
      msgEntry(c, c.cur, 'codex');
      return;
    case 'thinking':
      if (c.busy) setActivity(c, 'thinking', { tokens: (c.activity?.tokens || 0) + Math.round((ev.delta || 0) / 3) });
      return;
    case 'text_start':
    case 'text_delta':
    case 'text_done': {
      const m = msgEntry(c, c.cur || `turn-${Date.now()}`, 'codex');
      let b = m.blocks.find((x) => x.id === ev.itemId);
      if (!b) m.blocks.push((b = { type: 'text', id: ev.itemId, text: '' }));
      if (ev.kind === 'text_delta') b.text += ev.delta;
      if (ev.kind === 'text_done') {
        b.text = ev.text;
        c.turn?.texts.set(ev.itemId, ev.text);
      }
      renderBlocks(c, m);
      if (c.busy && ev.kind !== 'text_done') setActivity(c, 'writing', { tokens: (c.activity?.tokens || 0) + Math.max(1, Math.round((ev.delta || '').length / 2)) });
      scrollDown(c);
      return;
    }
    case 'tool_start': {
      const m = msgEntry(c, c.cur || `turn-${Date.now()}`, 'codex');
      if (!m.blocks.some((x) => x.id === ev.itemId)) m.blocks.push({ type: 'tool_use', id: ev.itemId, name: ev.name, input: ev.input });
      c.toolNames.set(ev.itemId, ev.name);
      (c.toolInputs ||= new Map()).set(ev.itemId, ev.input);
      renderBlocks(c, m);
      if (c.busy) setActivity(c, 'tool', { text: `실행 중: ${describeTool(ev.name, ev.input)}` });
      scrollDown(c);
      return;
    }
    case 'tool_done': {
      if (!c.tools.has(ev.itemId)) onCfEvent(c, { ...ev, kind: 'tool_start' });
      const chip = c.tools.get(ev.itemId);
      chip?.classList.remove('running');
      chip?.classList.add(ev.ok ? 'done' : 'failed');
      if (chip && ev.output) chip.title = ev.output.slice(0, 2000);
      if (ev.ok) addFileCard(c, ev.itemId);
      if (c.turn && !c.turn.tools.some((t) => t.id === ev.itemId)) c.turn.tools.push({ ...toolRec(ev.itemId, ev.name, ev.input), ok: ev.ok });
      if (ev.ok && /^(Edit|Write|Bash)$/.test(ev.name)) {
        clearTimeout(c.refreshTimer);
        c.refreshTimer = setTimeout(() => refresh(), 300);
      }
      if (c.busy) setActivity(c, 'requesting');
      return;
    }
    case 'usage':
      if (ev.used) c.ctx = (c.ctxBy ||= {}).codex = { used: ev.used, window: ev.window || c.ctx?.window || 200000 };
      return drawMeters(c);
    case 'rate': {
      const lab = (w) => (!w.mins ? '사용량' : w.mins <= 300 ? `${Math.round(w.mins / 60)}시간` : w.mins <= 10080 ? '주간' : w.mins <= 44640 ? '월간' : '사용량');
      rateInfo.codex = [ev.windows.primary, ev.windows.secondary].filter(Boolean).map((w) => ({ label: lab(w), ...w }));
      saveRate();
      return drawMeters(c);
    }
    case 'compacted':
      c.list.append(h('div', { class: 'ai-foot', text: '지난 대화를 요약해서 컨텍스트를 정리했습니다.' }));
      return;
    case 'error':
      if (ev.auth) {
        toast('Codex 로그인이 필요합니다.', 'warn', 6000);
        phase = 'login';
        info = { ...(info || {}), loggedIn: false };
        if (c.procId) window.api.ai.stop(c.procId);
        return render();
      }
      c.list.append(h('div', { class: 'ai-msg err', text: ev.message }));
      return scrollDown(c);
    case 'result':
      c.busy = false;
      updateSendButton(c);
      clearActivity(c);
      for (const chip of c.tools.values()) chip.classList.remove('running');
      if (ev.error && !c.list.lastElementChild?.classList.contains('err')) c.list.append(h('div', { class: 'ai-msg err', text: ev.error }));
      if (ev.interrupted) c.list.append(h('div', { class: 'ai-foot', text: '중지했습니다.' }));
      else if (ev.durationMs) c.list.append(h('div', { class: 'ai-foot', text: `완료 · ${(ev.durationMs / 1000).toFixed(0)}초` }));
      finishTurn(c);
      drawMeters(c);
      return scrollDown(c);
    default:
  }
}

// ---------- AI 가 부르는 CodeFlow 도구 ----------

async function onToolRequest(reqId, repo, action, args) {
  const reply = (result) => window.api.ai.toolResult(reqId, result);
  try {
    // 팀 채팅방 에이전트의 승인 요청은 팀 화면에서 묻는다
    if (action === 'approve' && args?.team) return reply(await (await import('./team.js')).askTeamApproval(args));
    if (action === 'approve') return reply(await askApproval(repo, args));
    // 팀 채팅방 에이전트가 만든 문서는 팀 화면에서 저장 위치를 묻는다
    if (action === 'save_document' && args?.team) return reply(await (await import('./team.js')).askTeamSave(args));
    if (action === 'save_document') return reply(await askSaveLocation(repo, args));
    if (action === 'list_projects') {
      const cur = (state.repo || '').toLowerCase();
      // 아직 한 번도 안 연 탭은 상태가 없으므로 바로 조회
      await Promise.all(tabs.filter((t) => !t.status).map(async (t) => (t.status = await window.api.git.status(t.path).catch(() => null))));
      return reply({
        result: tabs.map((t) => ({
          name: t.path.split(/[\\/]/).pop(),
          path: t.path,
          active: t.path.toLowerCase() === cur,
          conversation_started_here: t.path.toLowerCase() === repoKey(repo),
          branch: t.status?.branch || null,
          changed_files: t.status?.files?.length ?? null,
        })),
      });
    }
    if (action === 'switch_project') {
      const t = tabs.find((x) => x.path.toLowerCase() === String(args.path || '').toLowerCase());
      if (!t) return reply({ error: `열린 탭에 없는 프로젝트입니다: ${args.path}` });
      await switchTab(t.path);
      return reply({ result: `'${t.path.split(/[\\/]/).pop()}' 탭으로 전환했습니다.` });
    }
    if (repoKey(repo) !== repoKey(state.repo) && action !== 'list_terminals')
      return reply({ error: `사용자가 지금 다른 프로젝트 탭(${(state.repo || '').split(/[\\/]/).pop()})을 보고 있습니다. 원래 프로젝트 탭으로 돌아오면 다시 시도하세요.` });
    if (action === 'show_view') {
      window.dispatchEvent(new CustomEvent('cf-set-view', { detail: args.view }));
      return reply({ result: `화면을 ${args.view} 로 바꿨습니다.` });
    }
    if (action === 'open_file') {
      const p = /^[a-zA-Z]:[\\/]|^\\\\/.test(args.path) ? args.path : `${repo.replace(/[\\/]$/, '')}\\${String(args.path).replace(/\//g, '\\')}`;
      if (!(await window.api.exists(p))) return reply({ error: `파일이 없습니다: ${p}` });
      window.dispatchEvent(new CustomEvent('cf-set-view', { detail: 'code' }));
      await activateCode();
      await openFile(p, args.line ? { lineNumber: args.line, column: 1 } : undefined);
      return reply({ result: `열었습니다: ${p}` });
    }
    if (action === 'run_in_terminal' || action === 'read_terminal' || action === 'list_terminals') {
      if (action === 'list_terminals') return reply({ result: listTerminals() });
      window.dispatchEvent(new CustomEvent('cf-set-view', { detail: 'code' }));
      await activateCode();
      if (action === 'read_terminal') return reply({ result: readTerminal(args.terminal_id, args.lines || 80) });
      const shell = { cmd: 'cmd', gitbash: 'gitbash' }[args.shell] || 'powershell';
      return reply({ result: await runInTerminal(args.command, shell, Math.min(120, Math.max(1, Number(args.wait_seconds) || 5))) });
    }
    reply({ error: `알 수 없는 요청: ${action}` });
  } catch (e) {
    reply({ error: e.message || String(e) });
  }
}

// AI 가 만든 문서: 대화창에 미리보기 + '어디에 저장할까요?' → 고른 곳으로 옮기고 최종 경로를 AI 에게 돌려준다
async function askSaveLocation(repo, { path: file, title }, { auto = false } = {}) {
  const st = await window.api.file.stat(file);
  if (!st.ok || !st.data.isFile) return { error: `파일을 찾을 수 없습니다: ${file}` };
  const c = chatFor(repo);
  if (!visible) notifyAi('AI 가 만든 문서를 어디에 저장할지 묻고 있습니다. 왼쪽 ✦ AI 화면에서 골라 주세요.');
  if (!auto) setActivity(c, 'waiting');
  (c.fileCards ||= new Map()).set(file.toLowerCase(), { remove() {} }); // 답변 끝의 경로 찾기에서 또 만들지 않게
  const name = file.split(/[\\/]/).pop();
  const downloads = await window.api.file.appPath('downloads');
  return new Promise((resolve) => {
    const box = h('div', { class: 'ai-save' }, h('div', { class: 'ai-approve-title', text: `📄 ${title || name} — 어디에 저장할까요?` }));
    const card = fileCard(file, { verb: '새 문서', openFile: (f) => window.api.openPath(f) });
    const row = h('div', { class: 'ai-row' });
    const note = h('div', { class: 'ai-dim' });
    let busy = false;
    const finish = (saved, msg) => {
      row.remove();
      note.textContent = msg;
      (c.fileCards ||= new Map()).set(file.toLowerCase(), card); // 답변에 경로가 나와도 카드를 또 만들지 않게
      if (saved) {
        const sc = fileCard(saved, { verb: '저장됨', openFile: (f) => window.api.openPath(f) });
        c.fileCards.set(saved.toLowerCase(), sc);
        card.replaceWith(sc);
        box.classList.add('allowed');
      }
      if (c.busy && !auto) setActivity(c, 'requesting');
      resolve({ result: saved ? { saved_path: saved, message: `사용자가 저장 위치를 골랐습니다: ${saved}` } : { saved_path: file, message: '사용자가 저장 위치를 고르지 않아 임시 결과물 폴더에 그대로 두었습니다.' } });
    };
    const save = async (opts) => {
      if (busy) return;
      busy = true;
      const r = await window.api.file.saveAs(file, { move: true, ...opts });
      busy = false;
      if (!r.ok) return toast(r.error, 'error', 6000);
      if (!r.data) return; // 저장 창에서 취소 → 다시 고르게
      finish(r.data, `저장했습니다: ${r.data}`);
    };
    const pick = h('button', { class: 'btn primary small', text: '저장 위치 선택…' });
    pick.onclick = () => save({});
    const dl = h('button', { class: 'tb-btn small', text: '다운로드 폴더에 저장' });
    dl.onclick = () => save({ dir: downloads });
    const later = h('button', { class: 'tb-btn small', text: '나중에', title: '임시 결과물 폴더에 그대로 둡니다 (카드의 저장 버튼으로 나중에 저장 가능)' });
    later.onclick = () => finish(null, `임시 결과물 폴더에 두었습니다: ${file}`);
    row.append(pick, dl, h('span', { class: 'tb-spacer' }), later);
    box.append(card, row, note);
    c.list.append(box);
    c.list.scrollTop = c.list.scrollHeight;
    if (repoKey(repo) !== repoKey(state.repo)) toast(`${repo.split(/[\\/]/).pop()} 프로젝트의 AI 가 문서 저장 위치를 묻고 있습니다.`, 'warn', 6000);
  });
}

// 파일 수정·명령 실행 등 권한이 필요한 작업: 대화 안에 허용/거부 카드
function askApproval(repo, { tool_name: tool, input = {} }) {
  const c = chatFor(repo);
  if (c.alwaysAllow.has(tool)) return Promise.resolve({ allow: true });
  // CodeFlow 임시 결과물 폴더(프로젝트 밖)에 문서를 만드는 것은 묻지 않는다 — 다 만든 뒤 저장 위치를 묻는다
  if (/^(Write|Edit|MultiEdit)$/.test(tool) && /[\\/]ai[\\/]drafts[\\/]/i.test(input.file_path || '')) return Promise.resolve({ allow: true });
  setActivity(c, 'waiting');
  return new Promise((resolve) => {
    const detail =
      tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write'
        ? (input.new_string ?? input.content ?? (input.edits || []).map((e) => e.new_string).join('\n---\n') ?? '').slice(0, 1500)
        : tool === 'Bash' || tool === 'PowerShell' || tool === 'mcp__codeflow__run_in_terminal'
          ? input.command
          : JSON.stringify(input, null, 2).slice(0, 1500);
    const card = h('div', { class: 'ai-approve' }, h('div', { class: 'ai-approve-title', text: `허용할까요? ${describeTool(tool, input)}` }), detail ? h('pre', { class: 'ai-code-block', text: detail }) : null);
    let dlg = null;
    const done = (allow, always) => {
      if (card.classList.contains('allowed') || card.classList.contains('denied')) return;
      dlg?.close?.();
      if (always) c.alwaysAllow.add(tool);
      card.classList.add(allow ? 'allowed' : 'denied');
      card.querySelector('.ai-row')?.remove();
      card.append(h('div', { class: 'ai-dim', text: allow ? (always ? '허용함 (이 대화에서 계속 허용)' : '허용함') : '거부함' }));
      if (c.busy) setActivity(c, allow ? 'tool' : 'requesting', allow ? { text: `실행 중: ${describeTool(tool, input)}` } : {});
      resolve(allow ? { allow: true } : { allow: false, message: '사용자가 거부했습니다. 다른 방법을 제안하거나 무엇을 원하는지 물어보세요.' });
    };
    const yes = h('button', { class: 'btn primary small', text: '허용' });
    const always = h('button', { class: 'tb-btn small', text: '이 대화에서 항상 허용' });
    const no = h('button', { class: 'btn danger small', text: '거부' });
    yes.onclick = () => done(true, false);
    always.onclick = () => done(true, true);
    no.onclick = () => done(false, false);
    card.append(h('div', { class: 'ai-row' }, yes, always, h('span', { class: 'tb-spacer' }), no));
    c.list.append(card);
    c.list.scrollTop = c.list.scrollHeight;
    // 대화가 화면에 안 보이면(AI 화면을 닫았거나 다른 프로젝트 탭) 창으로 묻는다
    if (!visible || !c.list.isConnected) {
      const body = h('div', { class: 'ai-approve-dlg' }, h('div', { class: 'ai-dim', text: `${(repo || '').split(/[\\/]/).pop()} 프로젝트의 ${aiName()}` }), h('div', { class: 'ai-approve-title', text: describeTool(tool, input) }), detail ? h('pre', { class: 'ai-code-block', text: detail }) : null);
      dlg = modal({
        title: '✦ AI 가 허용을 요청합니다',
        body,
        dismissable: false,
        buttons: [
          { label: '거부', danger: true, onClick: () => done(false, false) },
          { label: '이 대화에서 항상 허용', onClick: () => done(true, true) },
          { label: '허용', primary: true, onClick: () => done(true, false) },
        ],
      });
    }
  });
}
