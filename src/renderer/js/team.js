// 팀 화면: 멀티 에이전트 팀 채팅방
// 왼쪽: 팀원 카드(이름·역할·상태) / 가운데: 모두의 대화 / 아래: 받는 사람(기본 PM, @이름 또는 카드 클릭) + 입력
// 실제 에이전트 실행과 메시지 전달은 메인 프로세스(src/main/team.js)가 한다
import { $, h, esc, toast, modal, promptDialog, confirmDialog, contextMenu, menuAt, fmtDate } from './ui.js';
import { state } from './state.js';
import { md, attachmentFromPath, attachmentFromBlob, attachChip, openAiSetup } from './ai.js';
import { teamScopeFor, teamScopeOfGroup } from './repo.js';
import { fileCard } from './preview.js';

const teamOf = new Map(); // 범위 키(개인: repo:경로 / 그룹: group:그룹id) → teamId
const data = new Map(); // teamId → { id, repo, members, log, paused }
const streams = new Map(); // `${teamId}:${memberId}` → 진행 중인 답
let target = null; // 받는 사람 memberId (null = PM)
let root = null;
let provider = localStorage.getItem('team.provider') || 'claude';

const key = (p) => String(p || '').toLowerCase();
// 지금 탭의 범위: 그룹에 있으면 그룹 팀, 아니면 그 프로젝트의 개인 팀
const curScope = () => teamScopeFor(state.repo);
const scopeKey = (sc) => (!sc ? '' : sc.kind === 'group' ? `group:${sc.key}` : `repo:${key(sc.key)}`);
const curTeam = () => data.get(teamOf.get(scopeKey(curScope())));
const member = (t, id) => t?.members.find((m) => m.id === id);
// 나간 팀원도 지난 메시지에 이름이 보이도록 (names: 팀원 전체의 이름·역할·색)
const anyMember = (t, id) => member(t, id) || (t?.names?.[id] ? { id, ...t.names[id] } : null);
const pmOf = (t) => t?.members.find((m) => m.pm);
const STATUS = { starting: '준비 중', idle: '대기', busy: '작업 중', stopped: '멈춤', offline: '쉬는 중 · 말을 걸면 이어서' };
const MODELS = [['', '기본 모델'], ['sonnet', 'Sonnet'], ['opus', 'Opus'], ['haiku', 'Haiku']];
const aiLabel = (m) => (m.provider === 'codex' ? 'Codex' : `Claude${m.model ? ` · ${MODELS.find(([v]) => v === m.model)?.[1] || m.model}` : ''}`);
let attach = []; // 보낼 첨부 (이미지·PDF·파일)

// 쓰려는 AI 가 설치·로그인되어 있는지 확인. 안 되어 있으면 'AI 연결·설정' 창에서 설치/로그인
async function aiReady(prov) {
  const r = await window.api.ai.status(prov);
  if (r.ok && r.data.installed && r.data.loggedIn !== false) return true;
  const name = prov === 'codex' ? 'Codex' : 'Claude Code';
  toast(r.ok && !r.data.installed ? `${name} 가 설치되어 있지 않습니다. 설치한 뒤 다시 시도해 주세요.` : `${name} 에 로그인한 뒤 다시 시도해 주세요.`, 'warn', 7000);
  openAiSetup(prov);
  return false;
}

// 사용량 막대 (1:1 대화 때와 같은 모양): 계정의 5시간·주간·월간, 팀원별 컨텍스트
function meter(label, pct, title) {
  return h('span', { class: `ai-meter ${pct >= 80 ? 'warn' : ''}`, title }, h('span', { text: `${label} ${pct}%` }), h('span', { class: 'ai-bar' }, h('i', { style: { width: `${pct}%` } })));
}
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));
function rateMeters(t) {
  const out = [];
  const used = [...new Set(t.members.map((m) => m.provider))];
  for (const prov of used) {
    for (const w0 of t.rate?.[prov] || []) {
      const w = w0.resetsAt && w0.resetsAt * 1000 < Date.now() ? { ...w0, utilization: 0 } : w0;
      const pct = Math.round((w.utilization || 0) * 100);
      const left = w.resetsAt ? Math.max(0, w.resetsAt * 1000 - Date.now()) : 0;
      const when = !w.resetsAt ? '' : left < 3600e3 ? `${Math.round(left / 60000)}분 후` : left < 86400e3 ? `${Math.floor(left / 3600e3)}시간 ${Math.round((left % 3600e3) / 60000)}분 후` : new Date(w.resetsAt * 1000).toLocaleString('ko-KR', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      out.push(meter(`${used.length > 1 ? (prov === 'codex' ? 'Codex ' : 'Claude ') : ''}${w.label}`, pct, `${prov === 'codex' ? 'Codex' : 'Claude'} ${w.label} 사용량 ${pct}%${when ? ` · ${when} 초기화` : ''} (계정 전체)`));
    }
  }
  return out;
}

// 이 프로젝트의 팀 불러오기: 열려 있는 팀 → 없으면 가장 최근에 저장된 팀
let loading = null;
async function ensureTeam() {
  const sc = curScope();
  if (!sc || curTeam()) return;
  const k = scopeKey(sc);
  if (loading === k) return;
  loading = k;
  try {
    const live = await window.api.team.openFor(sc);
    let id = live.ok && live.data[0];
    if (!id) {
      const saved = await window.api.team.listSaved(sc);
      id = saved.ok && saved.data[0]?.id;
    }
    if (id) await openTeam(sc, id);
  } finally {
    loading = null;
  }
}
async function openTeam(sc, id) {
  const r = await window.api.team.open(sc, id);
  if (!r.ok) return toast(`팀을 열지 못했습니다: ${r.error}`, 'error', 6000);
  data.set(r.data.id, r.data);
  teamOf.set(scopeKey(sc), r.data.id);
  target = null;
  window.api.team.refreshUsage(r.data.id);
  if (scopeKey(curScope()) === scopeKey(sc)) draw();
}

// 지난 팀 대화 (이 프로젝트 / 이 그룹)
async function openHistory(anchor) {
  const sc = curScope();
  const r = await window.api.team.listSaved(sc);
  const cur = curTeam();
  const items = (r.ok ? r.data : []).map((x) => ({
    label: `${x.id === cur?.id ? '● ' : ''}${x.title}`,
    hint: `${fmtDate(x.updated)} · ${x.members.join(', ')}`,
    onClick: () => x.id !== cur?.id && openTeam(sc, x.id),
  }));
  menuAt(anchor, items.length ? [{ header: `지난 팀 대화 (${sc.kind === 'group' ? `'${sc.name}' 그룹` : '이 프로젝트'})` }, ...items] : [{ header: '저장된 팀 대화가 없습니다' }]);
}

// 탭 그룹이 바뀌면: 그룹 팀의 프로젝트 목록을 맞추고, 지금 탭의 팀(그룹 ↔ 개인)이 바뀌었으면 다시 그린다
window.addEventListener('cf-groups-changed', async () => {
  for (const t of [...data.values()]) {
    if (t.scope?.kind !== 'group') continue;
    const sc = teamScopeOfGroup(t.scope.key);
    if (!sc) continue; // 그룹이 닫히거나 없어짐: 팀은 저장된 채로 둔다
    const same = sc.name === t.scope.name && sc.projects.map(key).sort().join('|') === t.scope.projects.map(key).sort().join('|');
    if (same) continue;
    const r = await window.api.team.setProjects(t.id, sc);
    if (r.ok && r.data) Object.assign(t, { scope: r.data.scope, label: r.data.label });
  }
  if (teamShown()) draw();
});

// 새 팀: 지금 팀은 저장해 두고 닫는다 (지난 팀 대화에서 다시 열 수 있음)
async function newTeam() {
  const cur = curTeam();
  if (cur) {
    await window.api.team.dispose(cur.id);
    data.delete(cur.id);
  }
  teamOf.delete(scopeKey(curScope()));
  target = null;
  draw(true);
}

export function initTeam() {
  root = $('#view-team');
  window.api.team.onEvent(onEvent);
}

export function activateTeam() {
  draw();
  const t = curTeam();
  if (t) window.api.team.refreshUsage(t.id);
}

// 'AI 연결·설정' 창을 닫으면 (설치·로그인 후) 화면을 다시
window.addEventListener('cf-ai-setup-closed', () => teamShown() && draw());

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
    (t.names ||= {})[ev.member.id] = { name: ev.member.name, role: ev.member.role, color: ev.member.color, pm: ev.member.pm };
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
    Object.assign(t, { paused: ev.team.paused, title: ev.team.title, names: ev.team.names || t.names });
    if (curTeam() === t) drawHead();
  } else if (ev.type === 'usage') {
    t.rate = ev.rate;
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
function draw(fresh = false) {
  if (!root) return;
  markRail(false);
  root.innerHTML = '';
  const t = curTeam();
  if (!t) {
    root.append(emptyState());
    // 저장된 팀이 있으면 가장 최근 팀을 연다 (새 팀을 누른 경우는 제외)
    if (!fresh) ensureTeam();
    return;
  }
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
  // 긴 대화: 최근 50개만 그리고, 위로 올리면 50개씩 더 (그래도 모자라면 저장된 더 오래된 기록을 불러옴)
  t.shownFrom = Math.max(0, t.log.length - PAGE);
  for (const m of t.log.slice(t.shownFrom)) appendMessage(t, m, false);
  log.scrollTop = log.scrollHeight;
  log.onscroll = () => log.scrollTop < 80 && showOlder(t);
  drawLive();
}

const PAGE = 50;
let olderBusy = false;
async function showOlder(t) {
  const log = root?.querySelector('.team-log');
  if (!log || olderBusy || curTeam() !== t) return;
  if (t.shownFrom === 0) {
    if (!t.more) return;
    olderBusy = true;
    const r = await window.api.team.older(t.id, t.log[0]?.id, 200);
    olderBusy = false;
    if (!r.ok || !r.data.items.length) return (t.more = false);
    t.log.unshift(...r.data.items);
    t.shownFrom += r.data.items.length;
    t.more = r.data.more;
  }
  const from = Math.max(0, t.shownFrom - PAGE);
  const items = t.log.slice(from, t.shownFrom);
  t.shownFrom = from;
  // 위에 끼워 넣어도 보던 자리가 그대로 보이게
  const h0 = log.scrollHeight;
  const first = log.firstChild;
  const tmp = document.createElement('div');
  for (const m of items) appendMessage(t, m, false, tmp);
  while (tmp.firstChild) log.insertBefore(tmp.firstChild, first);
  log.scrollTop += log.scrollHeight - h0;
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
  const emptyHist = h('button', { class: 'tb-btn small', text: '🕘 지난 팀 대화' });
  emptyHist.onclick = () => openHistory(emptyHist);
  const emptySetup = h('button', { class: 'tb-btn small', text: '⚙ AI 연결 · 설정', title: 'Claude Code / Codex 설치·로그인, 업데이트, MCP 확인' });
  emptySetup.onclick = () => openAiSetup(provider);
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
    const sc = curScope();
    const r = await window.api.team.create(sc, { provider, model: provider === 'claude' ? modelSel.value || null : null });
    if (!r.ok) {
      start.disabled = false;
      start.textContent = '팀 시작';
      return toast(`팀을 만들지 못했습니다: ${r.error}`, 'error', 8000);
    }
    data.set(r.data.id, r.data);
    teamOf.set(scopeKey(sc), r.data.id);
    target = null;
    draw();
  };
  return h(
    'div',
    { class: 'team-empty' },
    h('div', { class: 'team-empty-box' },
      h('div', { class: 'team-empty-title', text: curScope()?.kind === 'group' ? `✦ ${curScope().name} AI 팀` : '✦ AI 팀' }),
      curScope()?.kind === 'group' ? h('p', { class: 'team-empty-scope', text: `'${curScope().name}' 그룹의 프로젝트 ${curScope().projects.length}개(${curScope().projects.map((x) => x.split(/[\\/]/).pop()).join(', ')})를 함께 다루는 그룹 팀입니다. 팀원은 이 프로젝트들만 읽고 고칠 수 있습니다.` }) : null,
      h('p', { text: '팀장 PM(오케스트레이터)에게 하고 싶은 일과 필요한 팀원을 말하면, PM 이 기획자·개발자·테스터 같은 팀원 에이전트를 만들고 이름과 역할을 붙여 일을 나눕니다. 팀원끼리 대화하며 일하고, 모든 대화가 이 방에 보입니다.' }),
      h('ul', {},
        h('li', { text: '혼자 AI 와 대화하고 싶으면 팀원 없이 PM 과만 대화하면 됩니다.' }),
        h('li', { text: '기본은 PM 에게 말합니다. 특정 팀원에게만 말하려면 왼쪽 카드를 누르거나 @이름 으로 시작하세요.' }),
        h('li', { text: '팀 대화는 저장되어, 다시 열면 팀원이 이전 맥락을 기억한 채 이어서 일합니다.' }),
        h('li', { text: '파일 수정·명령 실행은 이 화면에서 허용/거부를 묻습니다.' }),
        h('li', { text: '에이전트끼리 대화가 너무 길어지면 자동으로 멈추고 묻습니다. 언제든 ‘모두 멈춤’ 으로 멈출 수 있습니다.' })
      ),
      h('div', { class: 'team-empty-row' }, h('label', { text: 'AI' }), sel, modelSel, start),
      h('div', { class: 'team-empty-row' }, emptyHist, emptySetup),
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
  const endBtn = h('button', { class: 'tb-btn small danger', text: '팀 삭제', title: '모든 에이전트를 끄고 이 팀과 대화 기록을 지웁니다' });
  endBtn.onclick = async () => {
    if (!(await confirmDialog('모든 에이전트를 끄고 이 팀과 대화 기록을 지울까요? (되돌릴 수 없음)\n지금 팀을 남겨 두고 새로 시작하려면 위쪽 ‘＋ 새 팀’ 을 쓰세요.', { title: '팀 삭제', okLabel: '삭제', danger: true }))) return;
    await window.api.team.deleteSaved(t.scope || curScope(), t.id);
    data.delete(t.id);
    teamOf.delete(scopeKey(curScope()));
    draw(true);
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
        h('div', { class: 'team-card-ai' }, h('span', { text: aiLabel(m) }), m.ctx?.window ? ctxBar(m) : null)
      ),
      m.pm ? null : kickBtn(t, m)
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
        m.pm ? null : { label: '강퇴 (팀에서 내보내기)', danger: true, onClick: () => kickBtn(t, m).click() },
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
  const hist = h('button', { class: 'tb-btn small', text: '🕘', title: '지난 팀 대화 (이 프로젝트)' });
  hist.onclick = () => openHistory(hist);
  const nw = h('button', { class: 'tb-btn small', text: '＋ 새 팀', title: '새 팀으로 시작 (지금 팀은 저장되어 지난 팀 대화에서 다시 열 수 있음)' });
  nw.onclick = () => newTeam();
  const setup = h('button', { class: 'tb-btn small', text: '⚙', title: 'AI 연결 · 설정 (설치·로그인, 업데이트, MCP·커넥터, 로그아웃)' });
  setup.onclick = () => openAiSetup(t.provider);
  // (DOM 의 append 는 null 을 "null" 글자로 넣으므로 빈 칸은 걸러 낸다)
  head.append(
    ...[
      h('b', { class: 'team-title', text: t.label || 'AI 팀', title: t.scope?.kind === 'group' ? `그룹 팀 — 이 팀이 다루는 프로젝트:\n${t.scope.projects.join('\n')}` : t.repo }),
      t.scope?.kind === 'group' ? h('span', { class: 'team-scope', text: `프로젝트 ${t.scope.projects.length}개`, title: t.scope.projects.join('\n') }) : null,
      h('span', { class: 'team-head-sub', text: `${t.title ? `${t.title} · ` : ''}팀원 ${t.members.length}명`, title: t.title || '' }),
      h('span', { class: 'ai-meters team-meters' }, ...rateMeters(t)),
      hist,
      nw,
      setup,
    ].filter(Boolean)
  );
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

function appendMessage(t, msg, scroll, into) {
  const log = into || root?.querySelector('.team-log');
  if (!log) return;
  const near = log.scrollHeight - log.scrollTop - log.clientHeight < 160;
  const toNames = (msg.to || []).map((id) => (id === 'user' ? '나' : anyMember(t, id)?.name || '?'));
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
    const m = anyMember(t, msg.from) || { name: msg.from, role: '', color: '#888' };
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
  // 우클릭: 이 메시지 복사 / 고른 글만 복사
  if (msg.text && msg.from !== 'system') {
    el.oncontextmenu = (e) => {
      e.preventDefault();
      const picked = String(window.getSelection?.() || '').trim();
      contextMenu(e.clientX, e.clientY, [
        picked ? { label: '선택한 글 복사', onClick: () => (window.api.copy(picked), toast('복사했습니다.', 'ok', 1500)) } : null,
        { label: '이 메시지 복사', onClick: () => (window.api.copy(msg.text), toast('복사했습니다.', 'ok', 1500)) },
      ]);
    };
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

function ctxBar(m) {
  const pct = Math.min(100, Math.round((m.ctx.used / m.ctx.window) * 100));
  return h('span', { class: `team-ctx ${pct >= 80 ? 'warn' : ''}`, title: `${m.name} 의 컨텍스트 ${fmtTok(m.ctx.used)} / ${fmtTok(m.ctx.window)} 토큰 (${pct}%)\n가득 차면 AI 가 자동으로 정리(요약)합니다.` }, h('span', { class: 'ai-bar' }, h('i', { style: { width: `${pct}%` } })), h('span', { text: `${pct}%` }));
}
// 강퇴: 카드에 마우스를 올리면 보인다
function kickBtn(t, m) {
  const b = h('button', { class: 'team-kick', text: '강퇴', title: `${m.name} 을(를) 팀에서 내보냅니다 (AI 도 종료)` });
  b.onclick = async (e) => {
    e.stopPropagation();
    if (!(await confirmDialog(`${m.name} (${m.role}) 을(를) 팀에서 내보낼까요?\n하던 일은 멈추고, 지난 메시지는 대화방에 남습니다.`, { title: '팀원 강퇴', okLabel: '강퇴', danger: true }))) return;
    const r = await window.api.team.removeMember(t.id, m.id);
    if (!r.ok) toast(r.error, 'error', 6000);
  };
  return b;
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
    // 팀 프로젝트(그룹 팀이면 그룹의 프로젝트들) 밖의 파일이면 눈에 띄게 알린다
    const fp = String(input.file_path || input.path || '');
    const abs = /^([a-z]:[\\/]|[\\/]{2}|\/)/i.test(fp);
    const outside = abs && t?.scope?.projects?.length && !t.scope.projects.some((p) => fp.toLowerCase().startsWith(p.toLowerCase()));
    const card = h(
      'div',
      { class: `team-approve ${outside ? 'outside' : ''}` },
      avatar(m, 'sm'),
      h(
        'div',
        { class: 'team-msg-body' },
        h('div', { class: 'team-msg-head' }, h('b', { text: m.name }), h('span', { class: 'team-msg-role', text: '허용을 요청합니다' })),
        outside ? h('div', { class: 'team-out', text: `⚠ 이 팀의 프로젝트 밖 파일입니다 (${t.scope.kind === 'group' ? `'${t.scope.name}' 그룹 프로젝트가 아님` : '이 프로젝트 폴더가 아님'}). 꼭 필요한 경우에만 허용하세요.` }) : null,
        h('div', { class: 'team-approve-what', text: what }),
        detail ? h('pre', { class: 'ai-code-block', text: detail }) : null
      )
    );
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
