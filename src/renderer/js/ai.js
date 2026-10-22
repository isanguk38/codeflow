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
  { id: 'codex', name: 'Codex', vendor: 'OpenAI', ready: false, login: 'ChatGPT 계정' },
];

// 모델 (빈 값 = Claude Code 기본값)
const MODELS = [
  ['', '기본값'],
  ['claude-opus-5-5', 'Opus 5.5'],
  ['claude-sonnet-5-5', 'Sonnet 5.5'],
  ['claude-haiku-5-5', 'Haiku 5.5'],
  ['claude-fable-5-1', 'Fable 5.1 (사용 크레딧 필요)'],
];
let model = localStorage.getItem('ai.model') || '';
let rateInfo = null; // 플랜 사용량 { five_hour: {utilization, resetsAt}, seven_day: ... }
let lastMcp = null; // 연결된 MCP 서버·커넥터 [{ name, status, source }]

let panel;
let visible = localStorage.getItem('ai.visible') === '1';
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
  splitter($('#aiSplit'), panel, { axis: 'x', min: 300, max: 900, invert: true, key: 'aiPanel' });
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
  setVisible(visible);
}

export function setVisible(v) {
  visible = v;
  localStorage.setItem('ai.visible', v ? '1' : '0');
  panel.hidden = !v;
  $('#aiSplit').hidden = !v;
  $('#aiBtn')?.classList.toggle('on', v);
  if (v) {
    render();
    if (phase === 'checking' || !info) refreshStatus();
    setTimeout(() => $('#aiInput')?.focus(), 50);
  }
}
export const toggleAi = () => setVisible(!visible);

// 프로젝트 탭이 바뀌면 그 프로젝트의 대화를 보여 준다
export function onAiRepoChanged() {
  if (visible) render();
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
}

async function doLogout() {
  for (const c of chats.values()) if (c.procId) window.api.ai.stop(c.procId);
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
    refreshStatus();
  };
  const newBtn = h('button', { class: 'tb-btn small', text: '＋', title: '새 대화 (지금 대화는 기록에 남음)' });
  newBtn.onclick = () => newChat();
  const histBtn = h('button', { class: 'tb-btn small', text: '🕘', title: '지난 대화 (이 프로젝트)' });
  histBtn.onclick = () => openHistory(histBtn);
  const more = h('button', { class: 'tb-btn small', text: '⋯', title: '더 보기' });
  more.onclick = () => {
    const mcp = (chatFor(state.repo || '').mcp || lastMcp || []).filter((m) => m.name !== 'codeflow');
    const ico = { connected: '●', 'needs-auth': '○', failed: '✕', pending: '…' };
    const word = { connected: '연결됨', 'needs-auth': '인증 필요', failed: '실패', pending: '연결 중' };
    menuAt(more, [
      { header: info?.installed ? `${aiName()} ${info.version || ''}${info.loggedIn ? ' · 로그인됨' : ''}` : aiName() },
      { label: '상태 다시 확인', onClick: refreshStatus },
      info?.loggedIn ? { label: '로그아웃', onClick: doLogout } : null,
      '-',
      { header: mcp.length ? '연결된 MCP · 커넥터' : 'MCP · 커넥터 (대화를 시작하면 표시)' },
      { label: '● codeflow — CodeFlow 도구 (항상 연결)', disabled: true },
      ...mcp.map((m) => ({
        label: `${ico[m.status] || '·'} ${m.name.replace(/^claude\.ai /, '')} — ${word[m.status] || m.status}${m.source === 'claudeai' ? ' (claude.ai 커넥터)' : ''}`,
        disabled: m.status !== 'needs-auth',
        onClick: () => window.api.openExternal('https://claude.ai/settings/connectors'),
      })),
      mcp.some((m) => m.status === 'needs-auth') ? { header: '인증 필요 커넥터를 누르면 claude.ai 커넥터 설정이 열립니다' } : null,
    ].filter(Boolean));
  };
  const close = h('button', { class: 'tb-btn small', text: '✕', title: 'AI 패널 닫기 (Ctrl+Shift+A)' });
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
  if (!chats.has(k)) chats.set(k, { repo, attach: [], procId: null, sessionId: null, busy: false, list: h('div', { class: 'ai-msgs' }), msgs: new Map(), tools: new Map(), toolNames: new Map(), alwaysAllow: new Set(), ctx: null, mcp: null });
  return chats.get(k);
}

function chatView() {
  const c = chatFor(state.repo);
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
  const msel = h('select', { class: 'ai-model', title: '모델 (다음 질문부터 적용)' });
  for (const [id, label] of MODELS) msel.append(h('option', { value: id, text: label }));
  msel.value = model;
  msel.onchange = () => {
    model = msel.value;
    localStorage.setItem('ai.model', model);
    for (const ch of chats.values()) ch.restartForModel = true;
    toast(`다음 질문부터 ${MODELS.find((m) => m[0] === model)[1]} 모델로 답합니다.`, 'info');
  };
  wrap.append(
    c.list,
    h(
      'div',
      { class: 'ai-compose' },
      strip,
      input,
      h('div', { class: 'ai-row' }, clip, msel, h('span', { class: 'tb-spacer' }), send),
      // 컨텍스트 · 세션 · 주간 사용량은 따로 한 줄 (패널이 좁으면 다음 줄로 넘어감)
      h('div', { class: 'ai-meters', id: 'aiMeters' })
    )
  );
  drawMeters(c);
  drawAttach(c);
  requestAnimationFrame(() => (c.list.scrollTop = c.list.scrollHeight));
  return wrap;
}

function welcomeNote() {
  return h('div', {
    class: 'ai-note',
    html:
      '이 프로젝트 폴더에서 AI 가 실행됩니다. 코드 질문, 수정, 실행은 물론 <b>CodeFlow 사용법</b>도 물어보세요.<br>' +
      'AI 가 CodeFlow 터미널에서 명령을 실행하거나 파일을 열 수 있고, 파일 수정·명령 실행 전에는 허용 여부를 묻습니다.',
  });
}

// 새 대화: 지금 대화를 끝내고 빈 대화로 (지난 대화는 Claude Code 가 저장해 두므로 🕘 에서 다시 열 수 있음)
function newChat() {
  const c = chatFor(state.repo);
  if (c.procId) window.api.ai.stop(c.procId);
  clearActivity(c);
  chats.delete(repoKey(state.repo));
  render();
}

// 지난 대화 목록 → 고르면 내용을 보여 주고, 이어서 질문하면 그 대화로 계속
async function openHistory(anchor) {
  const r = await window.api.ai.sessions(state.repo);
  const list = r.ok ? r.data : [];
  const cur = chatFor(state.repo).sessionId;
  const ago = (t) => {
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? '방금' : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`;
  };
  menuAt(anchor, [
    { header: `지난 대화 · ${state.repo.split(/[\\/]/).pop()}` },
    ...(list.length
      ? list.slice(0, 25).map((s) => ({ label: `${s.id === cur ? '✓ ' : ''}${s.title}`, hint: `${ago(s.updated)} · ${s.count}개`, onClick: () => loadSession(s.id) }))
      : [{ label: '지난 대화가 없습니다', disabled: true }]),
  ]);
}

async function loadSession(id) {
  const old = chatFor(state.repo);
  if (old.procId) window.api.ai.stop(old.procId);
  clearActivity(old);
  chats.delete(repoKey(state.repo));
  const c = chatFor(state.repo);
  c.sessionId = id;
  const r = await window.api.ai.transcript(state.repo, id);
  if (!r.ok) return toast(r.error, 'error');
  for (const it of r.data) {
    if (it.role === 'user') c.list.append(h('div', { class: 'ai-msg user', text: it.text }));
    else if (it.role === 'assistant') {
      const m = msgEntry(c, it.id || `h${Math.random()}`);
      m.blocks.push(...it.blocks);
      for (const b of it.blocks) if (b.type === 'tool_use') c.toolNames.set(b.id, b.name), (c.toolInputs ||= new Map()).set(b.id, b.input);
      renderBlocks(c, m);
    } else if (it.role === 'tool_result') {
      const chip = c.tools.get(it.id);
      chip?.classList.remove('running');
      chip?.classList.add(it.error ? 'failed' : 'done');
      if (!it.error) addFileCard(c, it.id);
    }
  }
  for (const chip of c.tools.values()) chip.classList.remove('running');
  c.list.append(h('div', { class: 'ai-foot', text: '지난 대화를 불러왔습니다. 이어서 질문하면 이 대화로 계속합니다.' }));
  render();
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
    starting: `${aiName()} 시작 중`,
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
        { label: '지금 정리하기 (/compact) — 지난 내용을 요약해서 공간 확보', disabled: c.busy || !c.procId, onClick: () => compact(c) },
        { header: '가득 차면 Claude Code 가 자동으로 정리합니다' },
      ]);
    el.append(m);
  }
  if (rateInfo) {
    const win = (k, name) => {
      const w = rateInfo[k];
      if (!w) return null;
      const pct = Math.round((w.utilization || 0) * 100);
      const left = w.resetsAt ? Math.max(0, w.resetsAt * 1000 - Date.now()) : 0;
      const when = left < 3600e3 ? `${Math.round(left / 60000)}분 후` : left < 86400e3 ? `${Math.floor(left / 3600e3)}시간 ${Math.round((left % 3600e3) / 60000)}분 후` : new Date(w.resetsAt * 1000).toLocaleString('ko-KR', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      return h('span', { class: `ai-meter ${pct >= 80 ? 'warn' : ''}`, title: `${name} 사용량 ${pct}% · ${when} 초기화` }, h('span', { text: `${name} ${pct}%` }), h('span', { class: 'ai-bar' }, h('i', { style: { width: `${pct}%` } })));
    };
    const a = win('five_hour', '세션');
    const b = win('seven_day', '주간');
    if (a) el.append(a);
    if (b) el.append(b);
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
  c.list.scrollTop = c.list.scrollHeight;
  c.busy = true;
  updateSendButton(c);
  setActivity(c, 'requesting', { start: Date.now(), tokens: 0 });
  try {
    // 대화 시작 뒤 프로젝트 탭이 늘거나 줄었으면, 같은 대화를 이어서 새 폴더 목록으로 다시 시작
    if (c.procId && (c.dirsKey !== dirsKey() || c.restartForModel)) {
      await window.api.ai.stop(c.procId);
      byChatId.delete(c.procId);
      c.procId = null;
    }
    if (!c.procId) {
      setActivity(c, 'starting');
      c.dirsKey = dirsKey();
      c.restartForModel = false;
      const r = await window.api.ai.start({ provider, repo: c.repo, resume: c.sessionId || undefined, addDirs: openDirs(), model: model || undefined });
      if (!r.ok) throw new Error(r.error);
      c.procId = r.data.id;
      byChatId.set(c.procId, c);
    }
    const r = await window.api.ai.send(c.procId, att.length ? content : text);
    if (!r.ok) throw new Error(r.error);
  } catch (e) {
    c.busy = false;
    updateSendButton(c);
    clearActivity(c);
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

async function addPath(c, file) {
  const r = await window.api.ai.readAttachment(file);
  if (!r.ok) return toast(r.error, 'error', 5000);
  const a = r.data;
  if (a.kind === 'image') Object.assign(a, await normalizeImage(a.mime, a.data).catch(() => ({})));
  pushAttach(c, a);
}

// 붙여넣기한 이미지(파일 경로가 없는 것)
function addFileObject(c, f) {
  if (!f.type.startsWith('image/')) return toast('붙여넣은 내용을 첨부할 수 없습니다. 📎 로 파일을 고르세요.', 'warn');
  const rd = new FileReader();
  rd.onload = async () => {
    const url = String(rd.result);
    const n = await normalizeImage(url.slice(5, url.indexOf(';')), url.slice(url.indexOf(',') + 1)).catch(() => null);
    if (!n) return toast('이미지를 읽지 못했습니다.', 'error');
    pushAttach(c, { kind: 'image', name: f.name && f.name !== 'image.png' ? f.name : `붙여넣은 이미지 ${c.attach.length + 1}.png`, ...n, size: Math.round((n.data.length * 3) / 4) });
  };
  rd.readAsDataURL(f);
}

function pushAttach(c, a) {
  if (c.attach.length >= 10) return toast('한 번에 10개까지 첨부할 수 있습니다.', 'warn');
  if (c.attach.some((x) => x.path && x.path === a.path)) return;
  c.attach.push(a);
  drawAttach(c);
  $('#aiInput')?.focus();
}

const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

function attachChip(a, onRemove) {
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

function stopChat(c) {
  if (c.procId) window.api.ai.stop(c.procId); // 프로세스를 끝내고, 다음 질문 때 같은 대화를 이어서 시작
  c.stopped = true;
}

// 아주 작은 마크다운: 코드 블록, 인라인 코드, 굵게, 제목, 목록, 링크
export function md(text) {
  const blocks = [];
  let src = text.replace(/```(\w*)\r?\n([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre class="ai-code-block"><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  src = esc(src)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="#" data-url="$2">$1</a>')
    .replace(/^#{1,4} (.+)$/gm, '<div class="ai-h">$1</div>')
    .replace(/^\s*[-*] (.+)$/gm, '<div class="ai-li">• $1</div>')
    .replace(/^\s*(\d+)\. (.+)$/gm, '<div class="ai-li">$1. $2</div>')
    .replace(/\n/g, '<br>')
    .replace(/(<\/div>)<br>/g, '$1');
  return src.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
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

function msgEntry(c, id) {
  let m = c.msgs.get(id);
  if (!m) {
    m = { el: h('div', { class: 'ai-msg assistant' }), blocks: [] };
    c.msgs.set(id, m);
    c.list.append(m.el);
  }
  return m;
}

function renderBlocks(c, m) {
  m.el.innerHTML = '';
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
  if (ev.type === 'system' && ev.subtype === 'init') {
    c.sessionId = ev.session_id;
    c.mcp = lastMcp = ev.mcp_servers || [];
    return;
  }
  if (ev.type === 'system' && ev.subtype === 'status' && ev.status === 'requesting' && c.busy) return setActivity(c, c.activity?.kind === 'compacting' ? 'compacting' : 'requesting');
  if (ev.type === 'system' && ev.subtype === 'thinking_tokens' && c.busy) return setActivity(c, 'thinking', { tokens: (c.activity?.base || 0) + (ev.estimated_tokens || 0) });
  if (ev.type === 'rate_limit_event') {
    rateInfo = ev.rate_limit_info?.unifiedWindows || rateInfo;
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
    scrollDown(c);
    return;
  }
  if (ev.type === 'exit') {
    byChatId.delete(procId);
    if (c.procId === procId) c.procId = null;
    const wasBusy = c.busy;
    c.busy = false;
    updateSendButton(c);
    clearActivity(c);
    for (const chip of c.tools.values()) chip.classList.remove('running');
    if (c.stopped) {
      c.stopped = false;
      c.list.append(h('div', { class: 'ai-foot', text: '중지했습니다. 이어서 질문하면 같은 대화로 계속합니다.' }));
    } else if (wasBusy || ev.code) {
      c.list.append(h('div', { class: 'ai-msg err', text: `${aiName()} 가 종료되었습니다 (코드 ${ev.code}). ${ev.stderr ? ev.stderr.split('\n').slice(-3).join(' ') : ''}` }));
    }
  }
}

// ---------- AI 가 부르는 CodeFlow 도구 ----------

async function onToolRequest(reqId, repo, action, args) {
  const reply = (result) => window.api.ai.toolResult(reqId, result);
  try {
    if (action === 'approve') return reply(await askApproval(repo, args));
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

// 파일 수정·명령 실행 등 권한이 필요한 작업: 대화 안에 허용/거부 카드
function askApproval(repo, { tool_name: tool, input = {} }) {
  const c = chatFor(repo);
  if (c.alwaysAllow.has(tool)) return Promise.resolve({ allow: true });
  if (!visible) setVisible(true);
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
    // 대화가 화면에 안 보이면(다른 프로젝트 탭 등) 창으로 묻는다
    if (!c.list.isConnected) {
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
