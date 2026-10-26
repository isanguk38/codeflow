// 팀 화면: 멀티 에이전트 팀 채팅방
// 왼쪽: 팀원 카드(이름·역할·상태) / 가운데: 모두의 대화 / 아래: 받는 사람(기본 PM, @이름 또는 카드 클릭) + 입력
// 실제 에이전트 실행과 메시지 전달은 메인 프로세스(src/main/team.js)가 한다
import { $, h, esc, toast, modal, promptDialog, confirmDialog, contextMenu } from './ui.js';
import { state } from './state.js';
import { md, attachmentFromPath, attachmentFromBlob, attachChip } from './ai.js';
import { fileCard } from './preview.js';

const teamOf = new Map(); // 프로젝트(소문자 경로) → teamId
const data = new Map(); // teamId → { id, repo, members, log, paused }
const streams = new Map(); // `${teamId}:${memberId}` → 진행 중인 답
let target = null; // 받는 사람 memberId (null = PM)
let root = null;
let provider = localStorage.getItem('team.provider') || 'claude';

const key = (p) => String(p || '').toLowerCase();
const curTeam = () => data.get(teamOf.get(key(state.repo)));
const member = (t, id) => t?.members.find((m) => m.id === id);
const pmOf = (t) => t?.members.find((m) => m.pm);
const STATUS = { starting: '준비 중', idle: '대기', busy: '작업 중', stopped: '멈춤' };
const MODELS = [['', '기본 모델'], ['sonnet', 'Sonnet'], ['opus', 'Opus'], ['haiku', 'Haiku']];
const aiLabel = (m) => (m.provider === 'codex' ? 'Codex' : `Claude${m.model ? ` · ${MODELS.find(([v]) => v === m.model)?.[1] || m.model}` : ''}`);
let attach = []; // 보낼 첨부 (이미지·PDF·파일)

// 쓰려는 AI 가 설치·로그인되어 있는지 확인. 안 되어 있으면 '1:1 대화' 탭에서 설치/로그인하도록 안내
async function aiReady(prov) {
  const r = await window.api.ai.status(prov);
  const name = prov === 'codex' ? 'Codex' : 'Claude Code';
  if (r.ok && r.data.installed && r.data.loggedIn !== false) return true;
  toast(r.ok && !r.data.installed ? `${name} 가 설치되어 있지 않습니다. '1:1 대화' 탭에서 설치해 주세요.` : `${name} 에 로그인해야 합니다. '1:1 대화' 탭에서 로그인해 주세요.`, 'warn', 7000);
  localStorage.setItem('ai.provider', prov);
  document.querySelector('.ai-hub-tab[data-mode="chat"]')?.click();
  return false;
}

export function initTeam() {
  root = $('#view-team');
  window.api.team.onEvent(onEvent);
}

export function activateTeam() {
  draw();
}

// ---------- 이벤트 (메인 → 화면) ----------
function onEvent(teamId, ev) {
  const t = data.get(teamId);
  if (!t) return;
  if (ev.type === 'member') {
    const i = t.members.findIndex((m) => m.id === ev.member.id);
    if (ev.member.status === 'removed') {
      if (i >= 0) t.members.splice(i, 1);
      if (target === ev.member.id) target = null;
    } else if (i >= 0) t.members[i] = ev.member;
    else t.members.push(ev.member);
    if (ev.member.status !== 'busy') streams.delete(`${teamId}:${ev.member.id}`);
    if (curTeam() === t) (drawSide(), drawHead(), drawLive());
  } else if (ev.type === 'message') {
    t.log.push(ev.message);
    if (ev.message.from && ev.message.from !== 'user' && ev.message.from !== 'system') streams.delete(`${teamId}:${ev.message.from}`);
    if (curTeam() === t) appendMessage(t, ev.message, true);
    if (!teamShown() && ev.message.from !== 'system') markRail(true);
  } else if (ev.type === 'stream') {
    streams.set(`${teamId}:${ev.memberId}`, ev.text);
    if (curTeam() === t) drawLive();
  } else if (ev.type === 'team') {
    Object.assign(t, { paused: ev.team.paused });
    if (curTeam() === t) drawHead();
  }
}

// 팀 채팅방이 지금 보이는지 (왼쪽 'AI' 화면의 '팀')
const teamShown = () => state.view === 'ai' && root && !root.hidden;
// 안 보는 동안 새 글이 오면 레일의 AI 버튼과 '팀' 탭에 점 표시
function markRail(on) {
  if (on && teamShown()) return;
  document.querySelector('.rail-btn[data-view="ai"]')?.classList.toggle('has-news', on);
  document.querySelector('.ai-hub-tab[data-mode="team"]')?.classList.toggle('has-news', on);
}

// ---------- 그리기 ----------
function draw() {
  if (!root) return;
  markRail(false);
  root.innerHTML = '';
  const t = curTeam();
  if (!t) return root.append(emptyState());
  root.append(
    h(
      'div',
      { class: 'team' },
      h('aside', { class: 'team-side' }),
      h(
        'section',
        { class: 'team-main' },
        h('div', { class: 'team-head' }),
        h('div', { class: 'team-log' }),
        h('div', { class: 'team-live' }),
        inputBox(t)
      )
    )
  );
  drawSide();
  drawHead();
  const log = root.querySelector('.team-log');
  for (const m of t.log) appendMessage(t, m, false);
  log.scrollTop = log.scrollHeight;
  drawLive();
}

function emptyState() {
  const sel = h('select', { class: 'team-provider' }, h('option', { value: 'claude', text: 'Claude Code (Anthropic)' }), h('option', { value: 'codex', text: 'Codex (OpenAI)' }));
  sel.value = provider;
  sel.onchange = () => {
    provider = sel.value;
    localStorage.setItem('team.provider', provider);
  };
  // 모델: 팀원이 여러 명이라 비용·속도 차이가 크다 (Claude 만, Codex 는 계정 기본 모델)
  const modelSel = h('select', { class: 'team-provider', title: '모든 팀원이 쓸 모델' }, ...[['', '기본 모델'], ['sonnet', 'Sonnet (균형)'], ['opus', 'Opus (가장 똑똑함)'], ['haiku', 'Haiku (빠르고 저렴)']].map(([v, t]) => h('option', { value: v, text: t })));
  modelSel.value = localStorage.getItem('team.model') || '';
  modelSel.onchange = () => localStorage.setItem('team.model', modelSel.value);
  const syncModel = () => (modelSel.hidden = sel.value !== 'claude');
  sel.addEventListener('change', syncModel);
  syncModel();
  const start = h('button', { class: 'btn primary', text: '팀 시작' });
  start.onclick = async () => {
    if (!state.repo) return toast('프로젝트를 먼저 여세요.', 'warn');
    start.disabled = true;
    start.textContent = 'AI 확인 중...';
    if (!(await aiReady(provider))) {
      start.disabled = false;
      start.textContent = '팀 시작';
      return;
    }
    start.textContent = '팀장 PM 을 깨우는 중...';
    const r = await window.api.team.create(state.repo, { provider, model: provider === 'claude' ? modelSel.value || null : null });
    if (!r.ok) {
      start.disabled = false;
      start.textContent = '팀 시작';
      return toast(`팀을 만들지 못했습니다: ${r.error}`, 'error', 8000);
    }
    data.set(r.data.id, r.data);
    teamOf.set(key(state.repo), r.data.id);
    target = null;
    draw();
  };
  return h(
    'div',
    { class: 'team-empty' },
    h('div', { class: 'team-empty-box' },
      h('div', { class: 'team-empty-title', text: 'AI 팀' }),
      h('p', { text: '팀장 PM(오케스트레이터)에게 하고 싶은 일과 필요한 팀원을 말하면, PM 이 기획자·개발자·테스터 같은 팀원 에이전트를 만들고 이름과 역할을 붙여 일을 나눕니다. 팀원끼리 대화하며 일하고, 모든 대화가 이 방에 보입니다.' }),
      h('ul', {},
        h('li', { text: '기본은 PM 에게 말합니다. 특정 팀원에게만 말하려면 왼쪽 카드를 누르거나 @이름 으로 시작하세요.' }),
        h('li', { text: '파일 수정·명령 실행은 이 화면에서 허용/거부를 묻습니다.' }),
        h('li', { text: '에이전트끼리 대화가 너무 길어지면 자동으로 멈추고 묻습니다. 언제든 ‘모두 멈춤’ 으로 멈출 수 있습니다.' })
      ),
      h('div', { class: 'team-empty-row' }, h('label', { text: 'AI' }), sel, modelSel, start),
      h('div', { class: 'team-empty-ex', text: '예) "회원 탈퇴 기능을 만들고 싶어. 기획자, 백엔드 개발자, 테스터가 필요해"' })
    )
  );
}

function avatar(m, size = '') {
  return h('span', { class: `team-av ${size}`, text: m.pm ? 'PM' : (m.name || '?').slice(0, 1), style: { background: m.color } });
}

function drawSide() {
  const side = root?.querySelector('.team-side');
  const t = curTeam();
  if (!side || !t) return;
  side.innerHTML = '';
  const addBtn = h('button', { class: 'tb-btn small', text: '＋ 팀원', title: '팀원을 직접 추가 (보통은 PM 에게 부탁하면 됩니다)' });
  addBtn.onclick = () => addMemberDialog(t);
  const stopBtn = h('button', { class: 'tb-btn small', text: '⏸ 모두 멈춤', title: '모든 팀원의 작업을 멈춤 (팀원은 남음)' });
  stopBtn.onclick = () => window.api.team.stopWork(t.id);
  const endBtn = h('button', { class: 'tb-btn small danger', text: '팀 해산', title: '모든 에이전트를 끄고 새 팀을 만들 수 있게 합니다' });
  endBtn.onclick = async () => {
    if (!(await confirmDialog('모든 에이전트를 끄고 팀을 해산할까요? (대화 기록도 사라집니다)', { title: '팀 해산', okLabel: '해산', danger: true }))) return;
    await window.api.team.dispose(t.id);
    data.delete(t.id);
    teamOf.delete(key(state.repo));
    draw();
  };
  side.append(h('div', { class: 'team-side-head' }, h('b', { text: `팀원 ${t.members.length}` }), h('span', { class: 'tb-spacer' }), addBtn), h('div', { class: 'team-side-acts' }, stopBtn, endBtn));
  const list = h('div', { class: 'team-cards' });
  for (const m of t.members) {
    const on = (target || pmOf(t)?.id) === m.id;
    const card = h(
      'div',
      { class: `team-card ${on ? 'target' : ''} st-${m.status}`, title: `${m.name} · ${m.role} · ${aiLabel(m)}\n클릭: 이 팀원에게만 말하기\n우클릭: AI·모델 바꾸기${m.pm ? '' : ', 내보내기'}` },
      avatar(m),
      h('div', { class: 'team-card-body' },
        h('div', { class: 'team-card-name' }, h('b', { text: m.name }), h('span', { class: 'team-card-role', text: m.role })),
        h('div', { class: 'team-card-st' }, h('span', { class: 'team-dot' }), h('span', { text: m.status === 'busy' ? m.activity || '작업 중' : STATUS[m.status] || m.status })),
        h('div', { class: 'team-card-ai', text: aiLabel(m) })
      )
    );
    card.onclick = () => {
      target = m.pm ? null : m.id;
      drawSide();
      drawTarget();
      root.querySelector('.team-input textarea')?.focus();
    };
    card.oncontextmenu = (e) => {
      e.preventDefault();
      // 팀원마다 AI·모델을 따로 정할 수 있다 (바꾸면 그 팀원은 새로 시작)
      const pick = async (prov, model) => {
        if (prov === m.provider && (model || null) === (m.model || null)) return;
        if (!(await aiReady(prov))) return;
        const r = await window.api.team.setMemberAI(t.id, m.id, { provider: prov, model: model || null });
        if (!r.ok) toast(r.error, 'error', 6000);
      };
      const mark = (prov, model) => (m.provider === prov && (prov === 'codex' || (m.model || '') === model) ? '✓ ' : '　');
      contextMenu(e.clientX, e.clientY, [
        m.pm ? null : { label: `${m.name} 에게만 말하기`, onClick: () => card.click() },
        { header: `${m.name} 의 AI (바꾸면 이 팀원은 새로 시작)` },
        ...MODELS.map(([v, label]) => ({ label: `${mark('claude', v)}Claude Code · ${label}`, onClick: () => pick('claude', v) })),
        { label: `${mark('codex', '')}Codex (OpenAI)`, onClick: () => pick('codex', null) },
        m.pm ? null : '-',
        m.pm ? null : { label: '팀에서 내보내기', danger: true, onClick: () => window.api.team.removeMember(t.id, m.id) },
      ]);
    };
    list.append(card);
  }
  side.append(list);
  drawTarget();
}

function drawHead() {
  const head = root?.querySelector('.team-head');
  const t = curTeam();
  if (!head || !t) return;
  head.innerHTML = '';
  head.append(h('b', { text: `${state.repo.split(/[\\/]/).pop()} · AI 팀` }), h('span', { class: 'team-head-sub', text: `${t.provider === 'codex' ? 'Codex' : 'Claude Code'} · 팀원 ${t.members.length}명` }), h('span', { class: 'tb-spacer' }));
  if (t.paused) {
    const go = h('button', { class: 'btn primary small', text: '계속' });
    go.onclick = () => window.api.team.resume(t.id);
    head.append(h('span', { class: 'team-paused', text: '⏸ 멈춤' }), go);
  }
}

// 진행 중인 답(작업 중인 팀원들의 실시간 글)
function drawLive() {
  const live = root?.querySelector('.team-live');
  const t = curTeam();
  if (!live || !t) return;
  live.innerHTML = '';
  for (const m of t.members.filter((x) => x.status === 'busy')) {
    const text = streams.get(`${t.id}:${m.id}`) || '';
    const bubble = h(
      'div',
      { class: 'team-msg agent live' },
      avatar(m, 'sm'),
      h('div', { class: 'team-msg-body' },
        h('div', { class: 'team-msg-head' }, h('b', { text: m.name }), h('span', { class: 'team-msg-role', text: m.role }), h('span', { class: 'team-typing', text: m.activity || '작업 중' }, h('i'), h('i'), h('i'))),
        text ? h('div', { class: 'team-msg-text ai-text', html: md(text.slice(-2500)) }) : null
      )
    );
    live.append(bubble);
  }
  const log = root.querySelector('.team-log');
  if (log && log.scrollHeight - log.scrollTop - log.clientHeight < 120) log.scrollTop = log.scrollHeight;
}

function appendMessage(t, msg, scroll) {
  const log = root?.querySelector('.team-log');
  if (!log) return;
  const near = log.scrollHeight - log.scrollTop - log.clientHeight < 160;
  const toNames = (msg.to || []).map((id) => (id === 'user' ? '나' : member(t, id)?.name || '?'));
  let el;
  if (msg.from === 'system') {
    el = h('div', { class: `team-sys ${msg.kind === 'pause' ? 'pause' : ''}`, text: msg.text });
  } else if (msg.from === 'user') {
    el = h(
      'div',
      { class: 'team-msg user' },
      h('div', { class: 'team-msg-body' },
        h('div', { class: 'team-msg-head' }, h('b', { text: '나' }), toNames.length ? h('span', { class: 'team-to', text: `→ ${toNames.join(', ')}` }) : null),
        msg.attachments?.length ? h('div', { class: 'team-att-sent' }, ...msg.attachments.map((a) => h('span', { class: 'team-att-name', text: `${a.kind === 'image' ? '🖼' : a.kind === 'pdf' ? '📕' : '📄'} ${a.name}`, title: a.path || a.name }))) : null,
        h('div', { class: 'team-msg-text', text: msg.text })
      )
    );
  } else {
    const m = member(t, msg.from) || { name: msg.from, role: '', color: '#888' };
    el = h(
      'div',
      { class: `team-msg agent ${msg.kind === 'dm' ? 'dm' : ''}` },
      avatar(m, 'sm'),
      h('div', { class: 'team-msg-body', style: { '--mc': m.color } },
        h('div', { class: 'team-msg-head' }, h('b', { text: m.name }), h('span', { class: 'team-msg-role', text: m.role }), toNames.length ? h('span', { class: 'team-to', text: `→ ${toNames.join(', ')}` }) : null),
        h('div', { class: 'team-msg-text ai-text', html: md(msg.text) })
      )
    );
    el.querySelector('.team-msg-body').style.setProperty('--mc', m.color);
  }
  log.append(el);
  if (scroll && near) log.scrollTop = log.scrollHeight;
}

// ---------- 입력 ----------
function inputBox(t) {
  const ta = h('textarea', { rows: '2', placeholder: 'PM 에게 할 일을 말하세요 · 특정 팀원에게만: 왼쪽 카드 클릭 또는 @이름 (Enter 보내기, Shift+Enter 줄바꿈)', spellcheck: 'false' });
  const send = h('button', { class: 'btn primary', text: '보내기' });
  const chips = h('div', { class: 'ai-attach team-attach' });
  const drawChips = () => {
    chips.innerHTML = '';
    chips.hidden = !attach.length;
    attach.forEach((a, i) => chips.append(attachChip(a, () => (attach.splice(i, 1), drawChips()))));
  };
  const add = (a) => {
    if (!a) return;
    if (attach.length >= 10) return toast('한 번에 10개까지 첨부할 수 있습니다.', 'warn');
    if (a.path && attach.some((x) => x.path === a.path)) return;
    attach.push(a);
    drawChips();
    ta.focus();
  };
  const clip = h('button', { class: 'tb-btn', text: '📎', title: '파일·이미지 첨부 (붙여넣기 Ctrl+V, 끌어다 놓기도 가능)' });
  clip.onclick = async () => {
    const files = await window.api.pickFiles('팀에게 보낼 파일 선택', [{ name: '모든 파일', extensions: ['*'] }], state.repo);
    for (const f of files || []) add(await attachmentFromPath(f));
  };
  ta.addEventListener('paste', async (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) {
      const p = window.api.ai.filePath(f);
      add(p ? await attachmentFromPath(p) : await attachmentFromBlob(f, attach.length + 1));
    }
  });
  const go = async () => {
    let text = ta.value.trim();
    if (!text && !attach.length) return;
    const cur = curTeam();
    let to = target ? [target] : [];
    // @이름 으로 시작하면 그 팀원(들)에게
    const mentions = [];
    text = text.replace(/^(?:@(\S+)\s*)+/, (all) => {
      for (const n of all.match(/@(\S+)/g) || []) mentions.push(n.slice(1));
      return '';
    }).trim() || text;
    if (mentions.length) {
      const ids = mentions.map((n) => cur.members.find((m) => m.name === n || (n.toUpperCase() === 'PM' && m.pm))?.id).filter(Boolean);
      if (ids.length !== mentions.length) return toast(`없는 팀원: ${mentions.filter((n) => !cur.members.some((m) => m.name === n || (n.toUpperCase() === 'PM' && m.pm))).join(', ')}`, 'warn');
      to = ids;
    }
    ta.value = '';
    const files = attach.splice(0);
    drawChips();
    const r = await window.api.team.send(cur.id, { to, text, attachments: files });
    if (!r.ok) toast(r.error, 'error', 6000);
  };
  send.onclick = go;
  ta.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      go();
    } else if (e.key === 'Escape' && target) {
      target = null;
      drawSide();
    }
  };
  drawChips();
  const box = h('div', { class: 'team-input' }, h('div', { class: 'team-target' }), chips, h('div', { class: 'team-input-row' }, clip, ta, send));
  // 입력 칸 어디에든 끌어다 놓기
  box.ondragover = (e) => {
    e.preventDefault();
    box.classList.add('drop');
  };
  box.ondragleave = (e) => {
    if (!box.contains(e.relatedTarget)) box.classList.remove('drop');
  };
  box.ondrop = async (e) => {
    e.preventDefault();
    box.classList.remove('drop');
    for (const f of [...(e.dataTransfer?.files || [])]) {
      const p = window.api.ai.filePath(f);
      add(p ? await attachmentFromPath(p) : await attachmentFromBlob(f, attach.length + 1));
    }
  };
  return box;
}

function drawTarget() {
  const box = root?.querySelector('.team-target');
  const t = curTeam();
  if (!box || !t) return;
  const m = target ? member(t, target) : pmOf(t);
  box.innerHTML = '';
  if (!m) return;
  box.append(h('span', { class: 'team-target-label', text: '받는 사람' }), h('span', { class: 'team-chip', style: { background: m.color } }, `${m.name}${m.pm ? ' (PM)' : ` · ${m.role}`}`));
  if (target) {
    const x = h('button', { class: 'chip-x', text: '✕', title: 'PM 에게로 되돌리기 (Esc)' });
    x.onclick = () => {
      target = null;
      drawSide();
    };
    box.append(x);
  }
  const ta = root.querySelector('.team-input textarea');
  if (ta) ta.placeholder = target ? `${m.name} (${m.role}) 에게만 말합니다 · Esc: PM 에게로` : 'PM 에게 할 일을 말하세요 · 특정 팀원에게만: 왼쪽 카드 클릭 또는 @이름 (Enter 보내기, Shift+Enter 줄바꿈)';
}

async function addMemberDialog(t) {
  const name = await promptDialog('새 팀원 이름', { title: '팀원 추가', placeholder: '예: 지수' });
  if (!name) return;
  const role = await promptDialog(`${name} 의 역할`, { title: '팀원 추가', placeholder: '예: 테스터' });
  if (!role) return;
  const r = await window.api.team.addMember(t.id, { name, role, instructions: `${role} 로서 팀장과 팀원이 맡기는 일을 처리한다.` });
  if (!r.ok) toast(r.error, 'error', 6000);
}

// ---------- 승인 요청 (팀원의 파일 수정·명령 실행) ----------
const always = new Map(); // `${teamId}:${memberId}` → Set(tool)
export function askTeamApproval(args) {
  const { team: tm, tool_name: tool, input = {} } = args;
  const t = data.get(tm.teamId);
  const m = member(t, tm.memberId) || { name: '에이전트', role: '', color: '#888' };
  const k = `${tm.teamId}:${tm.memberId}`;
  if (always.get(k)?.has(tool)) return Promise.resolve({ allow: true });
  if (/^(Write|Edit|MultiEdit)$/.test(tool) && /[\\/]ai[\\/]drafts[\\/]/i.test(input.file_path || '')) return Promise.resolve({ allow: true });
  const what =
    tool === 'Bash' || tool === 'PowerShell' || /run_in_terminal$/.test(tool)
      ? `명령 실행: ${input.command || ''}`
      : /^(Write|Edit|MultiEdit)$/.test(tool)
        ? `파일 ${tool === 'Write' ? '만들기' : '고치기'}: ${String(input.file_path || '').split(/[\\/]/).slice(-2).join('/')}`
        : tool.replace(/^mcp__\w+__/, '');
  const detail = (input.new_string ?? input.content ?? (input.edits || []).map((e) => e.new_string).join('\n---\n') ?? (input.command ? '' : JSON.stringify(input, null, 2)) ?? '').slice(0, 1500);
  return new Promise((resolve) => {
    let dlg = null;
    const card = h('div', { class: 'team-approve' }, avatar(m, 'sm'), h('div', { class: 'team-msg-body' }, h('div', { class: 'team-msg-head' }, h('b', { text: m.name }), h('span', { class: 'team-msg-role', text: '허용을 요청합니다' })), h('div', { class: 'team-approve-what', text: what }), detail ? h('pre', { class: 'ai-code-block', text: detail }) : null));
    const done = (allow, keep) => {
      if (card.dataset.done) return;
      card.dataset.done = '1';
      dlg?.close?.();
      if (keep) (always.get(k) || always.set(k, new Set()).get(k)).add(tool);
      card.querySelector('.ai-row')?.remove();
      card.querySelector('.team-msg-body').append(h('div', { class: 'ai-dim', text: allow ? (keep ? `허용함 (${m.name} 에게 계속 허용)` : '허용함') : '거부함' }));
      resolve(allow ? { allow: true } : { allow: false, message: '사용자가 거부했습니다. 다른 방법을 제안하거나 팀장/사용자에게 물어보세요.' });
    };
    const yes = h('button', { class: 'btn primary small', text: '허용' });
    const keep = h('button', { class: 'tb-btn small', text: `${m.name} 에게 항상 허용` });
    const no = h('button', { class: 'btn danger small', text: '거부' });
    yes.onclick = () => done(true, false);
    keep.onclick = () => done(true, true);
    no.onclick = () => done(false, false);
    card.querySelector('.team-msg-body').append(h('div', { class: 'ai-row' }, yes, keep, h('span', { class: 'tb-spacer' }), no));
    const log = root?.querySelector('.team-log');
    if (log && curTeam() === t) {
      log.append(card);
      log.scrollTop = log.scrollHeight;
    }
    // 팀 화면이 안 보이면 창으로 묻는다
    if (!teamShown() || curTeam() !== t) {
      markRail(true);
      dlg = modal({
        title: `AI 팀 · ${m.name} (${m.role}) 이 허용을 요청합니다`,
        body: h('div', { class: 'ai-approve-dlg' }, h('div', { class: 'ai-approve-title', text: what }), detail ? h('pre', { class: 'ai-code-block', text: detail }) : null),
        dismissable: false,
        buttons: [
          { label: '거부', danger: true, onClick: () => done(false, false) },
          { label: `${m.name} 에게 항상 허용`, onClick: () => done(true, true) },
          { label: '허용', primary: true, onClick: () => done(true, false) },
        ],
      });
    }
  });
}

// ---------- 팀원이 만든 문서: 어디에 저장할까요? ----------
export async function askTeamSave(args) {
  const { team: tm, path: file, title } = args;
  const st = await window.api.file.stat(file);
  if (!st.ok || !st.data.isFile) return { error: `파일을 찾을 수 없습니다: ${file}` };
  const t = data.get(tm.teamId);
  const m = member(t, tm.memberId) || { name: '에이전트', role: '', color: '#888' };
  const name = file.split(/[\\/]/).pop();
  const downloads = await window.api.file.appPath('downloads');
  return new Promise((resolve) => {
    const body = h('div', { class: 'team-msg-body' }, h('div', { class: 'team-msg-head' }, h('b', { text: m.name }), h('span', { class: 'team-msg-role', text: '문서를 만들었습니다 — 어디에 저장할까요?' })), h('div', { class: 'team-approve-what', text: `📄 ${title || name}` }));
    const card = h('div', { class: 'team-approve save' }, avatar(m, 'sm'), body);
    body.append(fileCard(file, { verb: '새 문서', openFile: (f) => window.api.openPath(f) }));
    const row = h('div', { class: 'ai-row' });
    let busy = false;
    const finish = (saved, msg) => {
      row.remove();
      body.append(h('div', { class: 'ai-dim', text: msg }));
      if (saved) body.append(fileCard(saved, { verb: '저장됨', openFile: (f) => window.api.openPath(f) }));
      resolve({ result: saved ? { saved_path: saved, message: `사용자가 저장 위치를 골랐습니다: ${saved}` } : { saved_path: file, message: '사용자가 저장 위치를 고르지 않아 임시 결과물 폴더에 그대로 두었습니다.' } });
    };
    const save = async (opts) => {
      if (busy) return;
      busy = true;
      const r = await window.api.file.saveAs(file, { move: true, ...opts });
      busy = false;
      if (!r.ok) return toast(r.error, 'error', 6000);
      if (!r.data) return;
      finish(r.data, `저장했습니다: ${r.data}`);
    };
    const pick = h('button', { class: 'btn primary small', text: '저장 위치 선택…' });
    pick.onclick = () => save({});
    const dl = h('button', { class: 'tb-btn small', text: '다운로드 폴더에 저장' });
    dl.onclick = () => save({ dir: downloads });
    const later = h('button', { class: 'tb-btn small', text: '나중에' });
    later.onclick = () => finish(null, `임시 결과물 폴더에 두었습니다: ${file}`);
    row.append(pick, dl, h('span', { class: 'tb-spacer' }), later);
    body.append(row);
    const log = root?.querySelector('.team-log');
    if (log && curTeam() === t) {
      log.append(card);
      log.scrollTop = log.scrollHeight;
    }
    if (!teamShown() || curTeam() !== t) {
      markRail(true);
      toast(`AI 팀의 ${m.name} 이(가) 만든 문서를 어디에 저장할지 묻고 있습니다. ✦ AI → 팀 에서 골라 주세요.`, 'info', 7000);
    }
  });
}
