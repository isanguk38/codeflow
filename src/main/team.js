// 멀티 에이전트 팀 (팀 채팅방)
// - 팀장 PM(오케스트레이터)이 사용자의 요구를 듣고 팀원(에이전트)을 만들고 일을 나눈다 (team_add_member, team_send)
// - 팀원마다 AI 프로세스(Claude Code / Codex)가 하나씩 뜬다. 모두 같은 프로젝트 폴더에서 일한다
// - 대화는 하나의 채팅방에 모두 보인다. 사용자는 PM 또는 특정 팀원에게만 말할 수 있다
// - 팀원이 '요청' 받은 일을 마치면 마지막 답이 요청한 팀원에게 자동으로 돌아간다 (그 답장에는 다시 자동 답장하지 않음 → 끝없는 핑퐁 방지)
// - 에이전트끼리 정해진 횟수 이상 오가면 멈추고 사용자에게 묻는다
// - 팀(구성·대화방 기록·팀원별 AI 대화 id)은 프로젝트마다 저장되어, 앱을 다시 켜도 이어서 대화할 수 있다.
//   팀원은 메시지를 받을 때 띄우고(이전 AI 대화에 이어 붙임), 열기만 해서는 AI 를 쓰지 않는다
const { app } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ai = require('./ai');
const tools = require('./ai-tools');

const MAX_HOPS = 24; // 사용자 메시지 없이 에이전트끼리 주고받을 수 있는 최대 횟수
const COLORS = ['#3b82f6', '#2f9e44', '#d6409f', '#d39e00', '#8e4ec6', '#0c9fb5', '#e5484d', '#f76b15', '#64748b'];

const teams = new Map(); // teamId → team (열려 있는 팀)

// ---------- 범위: 개인 팀(프로젝트 1개) / 그룹 팀(탭 그룹의 프로젝트들) ----------
// scope = { kind: 'repo', key: 프로젝트 경로, projects: [경로] } 또는 { kind: 'group', key: 그룹 id, name: 그룹 이름, projects: [경로들] }
// 팀원은 scope.projects 폴더들만 쓴다 (첫 프로젝트가 작업 폴더, 나머지는 허용 폴더)
const safeId = (id) => String(id).replace(/[^\w-]/g, '');
const scopeKey = (sc) => (sc.kind === 'group' ? `group:${sc.key}` : `repo:${String(sc.key).toLowerCase()}`);
// 저장 위치: userData/ai/teams/<프로젝트 해시 | g-그룹id>/<팀 id>.json
const teamsDir = (sc) =>
  path.join(app.getPath('userData'), 'ai', 'teams', sc.kind === 'group' ? `g-${safeId(sc.key)}` : crypto.createHash('sha1').update(String(sc.key).toLowerCase()).digest('hex').slice(0, 16));
const normScope = (sc) => {
  if (typeof sc === 'string') sc = { kind: 'repo', key: sc };
  const projects = [...new Set((sc.projects && sc.projects.length ? sc.projects : [sc.key]).filter(Boolean))];
  return { kind: sc.kind === 'group' ? 'group' : 'repo', key: sc.key, name: sc.name || '', projects };
};
const scopeLabel = (t) => (t.scope.kind === 'group' ? `${t.scope.name || '그룹'} AI 팀` : `${path.basename(t.scope.key)} AI 팀`);
function serialize(t) {
  return {
    id: t.id,
    repo: t.repo,
    scope: t.scope,
    provider: t.provider,
    model: t.model,
    created: t.created,
    updated: Date.now(),
    title: t.title || '',
    memberSeq: t.memberSeq,
    members: t.members.map((m) => ({ id: m.id, name: m.name, role: m.role, instructions: m.instructions, pm: m.pm, color: m.color, provider: m.provider, model: m.model, sessionId: m.sessionId || null, sessionProvider: m.sessionProvider || null, removed: m.status === 'removed' })),
    log: t.log.slice(-2000),
  };
}
function saveNow(t) {
  clearTimeout(t.saveTimer);
  t.saveTimer = null;
  try {
    const dir = teamsDir(t.scope);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${safeId(t.id)}.json`), JSON.stringify(serialize(t)));
  } catch (e) {
    console.error('[team] save', e);
  }
}
const scheduleSave = (t) => t.saveTimer || (t.saveTimer = setTimeout(() => saveNow(t), 800));

// 이 범위(프로젝트 / 그룹)의 저장된 팀 목록 (최근 것부터)
function listSaved(scope) {
  const sc = normScope(scope);
  let files = [];
  try {
    files = fs.readdirSync(teamsDir(sc)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(teamsDir(sc), f), 'utf8'));
      const live = t.members.filter((m) => !m.removed);
      out.push({ id: t.id, title: t.title || '(대화 없음)', updated: t.updated, members: live.map((m) => m.name), open: teams.has(t.id) });
    } catch {}
  }
  return out.sort((a, b) => b.updated - a.updated).slice(0, 50);
}

// 저장된 팀 열기: 대화방 기록과 팀원을 되살린다 (팀원 AI 는 말을 걸 때 띄움)
function open(scope, id) {
  const sc = normScope(scope);
  if (teams.has(id)) {
    setProjects(id, sc); // 그룹 구성이 바뀌었을 수 있다
    return publicTeam(teams.get(id));
  }
  const d = JSON.parse(fs.readFileSync(path.join(teamsDir(sc), `${safeId(id)}.json`), 'utf8'));
  // 저장해 둔 범위와 지금 범위(그룹의 프로젝트)가 다르면 지금 것을 쓴다
  const team = { id: d.id, scope: sc, repo: sc.projects[0], provider: d.provider, model: d.model, created: d.created, title: d.title, members: [], log: d.log || [], hops: 0, paused: false, memberSeq: d.memberSeq || d.members.length, rate: {} };
  for (const x of d.members) {
    team.members.push({ ...x, status: x.removed ? 'removed' : 'offline', activity: '', queue: [], turnFrom: [], turnText: '', lastText: '', chatId: null, ctx: null });
  }
  teams.set(team.id, team);
  return publicTeam(team);
}

function deleteSaved(scope, id) {
  dispose(id);
  fs.rmSync(path.join(teamsDir(normScope(scope)), `${safeId(id)}.json`), { force: true });
}
let sendToRenderer = () => {};

function setSender(fn) {
  sendToRenderer = fn;
}
const emit = (team, ev) => sendToRenderer('team:event', team.id, ev);

// ---------- 역할 지시 (각 에이전트의 시스템 프롬프트에 붙는다) ----------
function projectsText(team) {
  return team.scope.projects.map((p, i) => `- ${path.basename(p)}: ${p}${i === 0 ? ' (작업 폴더)' : ''}`).join('\n');
}
function scopeText(team) {
  return team.scope.kind === 'group'
    ? `이 팀은 탭 그룹 "${team.scope.name}" 의 팀입니다. 아래 프로젝트들만 읽고 고칠 수 있습니다 (그 밖의 폴더는 건드리지 마세요):\n${projectsText(team)}`
    : `이 팀의 프로젝트 (이 폴더만 읽고 고칠 수 있습니다):\n${projectsText(team)}`;
}

function rosterText(team) {
  return team.members
    .filter((m) => m.status !== 'removed')
    .map((m) => `- ${m.name} (${m.role})${m.pm ? ' — 팀장' : ''}`)
    .join('\n');
}

function pmPrompt(team, m) {
  return `# 멀티 에이전트 팀: 당신은 팀장(PM, 오케스트레이터) "${m.name}" 입니다
이 대화는 CodeFlow 의 '팀 채팅방' 입니다. 사용자와 여러 AI 에이전트(팀원)가 한 방에서 대화하고, 사용자는 모든 대화를 봅니다.

당신의 일:
1. 사용자의 요구를 듣고, 필요한 팀원 구성을 정한다 (예: 기획자, 백엔드 개발자, 프론트엔드 개발자, 테스터, 디자이너…). 사용자가 원하는 팀원을 말하면 그대로 따른다.
2. team_add_member 로 팀원을 만든다. 각 팀원에게 한국어 사람 이름(짧게, 예: 지수·민준·서연)과 역할을 붙이고, instructions 에 그 팀원이 책임질 일과 기준을 구체적으로 적는다.
3. team_send 로 각 팀원에게 할 일을 맡기고, 결과를 받아 다음 단계를 조율한다. 팀원의 결과는 자동으로 당신에게 돌아온다.
4. 진행 상황과 최종 결과를 사용자에게 짧게 보고한다 (당신의 답은 대화방에 그대로 보인다).

규칙:
- 직접 코드를 크게 고치기보다 팀원에게 맡기고 조율한다. 작은 확인·정리는 직접 해도 된다.
- 팀원 메시지는 짧고 구체적으로. 같은 일을 여러 팀원에게 중복으로 맡기지 않는다.
- 사용자가 팀원 추가/제외를 요청하면 team_add_member / team_remove_member 로 처리한다.
- 결정이 필요한 것(요구가 모호함, 위험한 변경)은 추측하지 말고 사용자에게 묻는다 (team_send to "user" 또는 답으로).
- 팀원끼리 나눈 대화나 지난 흐름이 필요하면 team_history 로 대화방 기록을 읽는다.
- 답은 한국어로.

${scopeText(team)}

지금 팀원:
${rosterText(team)}`;
}

function memberPrompt(team, m) {
  const pm = team.members.find((x) => x.pm);
  return `# 멀티 에이전트 팀: 당신은 "${m.name}" (${m.role}) 입니다
이 대화는 CodeFlow 의 '팀 채팅방' 입니다. 팀장 ${pm ? pm.name : 'PM'} 이 팀을 이끌고, 사용자와 팀원 모두가 한 방에서 대화하며 사용자는 모든 대화를 봅니다.

당신이 맡은 일:
${m.instructions || `${m.role} 로서 팀장이 맡기는 일을 처리한다.`}

규칙:
- 받은 메시지는 "[팀 메시지] 보낸 사람 → 나" 처럼 옵니다. 요청받은 일을 마치면 마지막 답에 결과를 짧게 정리하세요. 그 답은 요청한 사람에게 자동으로 전달됩니다.
- 다른 팀원에게 물어보거나 넘길 일이 있으면 team_send 를 쓰세요 (to: 팀원 이름). 팀원 목록은 team_members.
- 사용자가 직접 말을 걸면 사용자에게 답하세요.
- 같은 프로젝트 폴더에서 다른 팀원도 일하므로, 고치는 파일과 범위를 분명히 하고 남의 작업을 덮어쓰지 마세요.
- 다른 팀원끼리 나눈 대화나 지난 흐름이 필요하면 team_history 로 대화방 기록을 읽으세요.
- 답은 한국어로, 짧고 구체적으로.

${scopeText(team)}

지금 팀원:
${rosterText(team)}`;
}

// ---------- 팀 / 팀원 ----------
function publicMember(m) {
  return { id: m.id, name: m.name, role: m.role, color: m.color, pm: !!m.pm, status: m.status, activity: m.activity || '', provider: m.provider, model: m.model || null, ctx: m.ctx || null, resumable: !!m.sessionId, mcp: m.mcp || null };
}
function publicTeam(t) {
  return {
    id: t.id,
    repo: t.repo,
    scope: t.scope,
    label: scopeLabel(t),
    provider: t.provider,
    model: t.model,
    title: t.title || '',
    paused: t.paused,
    hops: t.hops,
    members: t.members.filter((m) => m.status !== 'removed').map(publicMember),
    // 나간 팀원도 지난 메시지에 이름이 보이도록
    names: Object.fromEntries(t.members.map((m) => [m.id, { name: m.name, role: m.role, color: m.color, pm: !!m.pm }])),
    rate: t.rate || {},
    log: t.log.slice(-500),
    more: t.log.length > 500, // 더 오래된 기록이 있음 (위로 올리면 불러옴)
  };
}

async function create(scope, { provider = 'claude', model = null, pmName = 'PM' } = {}) {
  const sc = normScope(scope);
  const team = { id: `t${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`, scope: sc, repo: sc.projects[0], provider, model, created: Date.now(), title: '', members: [], log: [], hops: 0, paused: false, memberSeq: 0, rate: {} };
  teams.set(team.id, team);
  await addMember(team, { name: pmName, role: '팀장 (PM)', pm: true });
  post(team, {
    from: 'system',
    text:
      sc.kind === 'group'
        ? `'${sc.name}' 그룹 팀을 만들었습니다. 이 팀은 그룹의 프로젝트 ${sc.projects.length}개(${sc.projects.map((p) => path.basename(p)).join(', ')})만 다룹니다. 팀장 ${pmName} 에게 하고 싶은 일과 필요한 팀원을 말해 주세요.`
        : `팀을 만들었습니다. 팀장 ${pmName} 에게 하고 싶은 일과 필요한 팀원을 말해 주세요.`,
  });
  return publicTeam(team);
}

async function addMember(team, { name, role, instructions = '', pm = false, provider, model }) {
  name = String(name || '').trim();
  if (!name) throw new Error('팀원 이름이 필요합니다.');
  if (team.members.some((m) => m.status !== 'removed' && m.name === name)) throw new Error(`'${name}' 이름의 팀원이 이미 있습니다.`);
  const m = {
    id: `m${++team.memberSeq}`,
    name,
    role: String(role || '팀원').trim(),
    instructions: String(instructions || '').trim(),
    pm,
    color: pm ? '#475569' : COLORS[(team.memberSeq - 2 + COLORS.length) % COLORS.length],
    provider: provider || team.provider,
    model: model !== undefined ? model || null : (provider || team.provider) === team.provider ? team.model : null, // 팀원마다 다른 AI·모델을 쓸 수 있다
    status: 'starting', // starting → idle ⇄ busy, stopped / removed
    activity: '',
    queue: [], // 아직 전달 못 한 메시지 [{ from, text, kind }]
    turnFrom: [], // 지금 처리 중인 메시지를 보낸 사람들 (요청이면 답을 돌려준다)
    turnText: '', // 이번 답의 전체 글 (진행 중 말풍선)
    lastText: '', // 이번 답의 마지막 글 덩어리 (대화방에 올라가는 결과)
    chatId: null,
  };
  team.members.push(m);
  emit(team, { type: 'member', member: publicMember(m) });
  if (!pm) post(team, { from: 'system', text: `${m.name} (${m.role}) 이(가) 팀에 들어왔습니다.` });
  scheduleSave(team);
  await launch(team, m);
  return m;
}

// 팀원의 AI 프로세스를 띄운다 (처음, AI·모델을 바꿀 때, 저장된 팀을 다시 열어 말을 걸 때)
// resume: 저장해 둔 그 팀원의 AI 대화 id 에 이어 붙인다 (이전 맥락 기억)
async function launch(team, m, { resume = false } = {}) {
  const extraPrompt = m.pm ? pmPrompt(team, m) : memberPrompt(team, m);
  const resumeId = resume && m.sessionId && m.sessionProvider === m.provider ? m.sessionId : null;
  m.resuming = !!resumeId;
  // 띄울 때마다 세대 번호: AI 를 바꾼 뒤 예전 프로세스가 늦게 보내는 이벤트(종료 등)는 무시
  const gen = (m.gen = (m.gen || 0) + 1);
  try {
    m.launchedProjects = team.scope.projects.join('|');
    const r = await ai.startChat({ provider: m.provider, repo: team.repo, addDirs: team.scope.projects.slice(1), model: m.model, resume: resumeId, team: { teamId: team.id, memberId: m.id, pm: m.pm }, extraPrompt }, (ch, id, ev) => {
      if (ch === 'ai:event' && gen === m.gen) onAgentEvent(team, m, ev);
    });
    m.chatId = r.id;
  } catch (e) {
    setStatus(team, m, 'stopped', '');
    post(team, { from: 'system', text: `${m.name} 을(를) 시작하지 못했습니다: ${e.message}` });
    throw e;
  }
}

// 그룹 팀: 탭을 그룹에 넣거나 빼서 프로젝트가 바뀌었을 때. 떠 있는 팀원은 이전 대화에 이어 붙여 다시 띄운다
// (일하는 중이면 그 일이 끝난 뒤)
function setProjects(teamId, scope) {
  const team = teams.get(teamId);
  if (!team) return null;
  const sc = normScope(scope);
  const before = team.scope.projects;
  const nameChanged = sc.name && sc.name !== team.scope.name;
  team.scope = { ...team.scope, name: sc.name || team.scope.name, projects: sc.projects };
  // 작업 폴더(첫 프로젝트)는 가능하면 그대로 둔다 (Claude 의 대화 기록이 작업 폴더별이라)
  if (sc.projects.includes(team.repo)) team.scope.projects = [team.repo, ...sc.projects.filter((p) => p !== team.repo)];
  else team.repo = sc.projects[0];
  const low = (a) => a.map((x) => x.toLowerCase());
  const added = sc.projects.filter((p) => !low(before).includes(p.toLowerCase()));
  const removed = before.filter((p) => !low(sc.projects).includes(p.toLowerCase()));
  if (!added.length && !removed.length) {
    if (nameChanged) (emit(team, { type: 'team', team: publicTeam(team) }), scheduleSave(team));
    return publicTeam(team);
  }
  const names = (a) => a.map((p) => path.basename(p)).join(', ');
  post(team, { from: 'system', text: [added.length ? `${names(added)} 프로젝트가 팀에 추가되었습니다.` : '', removed.length ? `${names(removed)} 프로젝트가 팀에서 빠졌습니다.` : ''].filter(Boolean).join(' ') + ' 팀원들이 바뀐 프로젝트 목록으로 이어서 일합니다.' });
  for (const m of team.members) relaunchIfNeeded(team, m);
  emit(team, { type: 'team', team: publicTeam(team) });
  scheduleSave(team);
  return publicTeam(team);
}
function relaunchIfNeeded(team, m) {
  if (!m.chatId || m.status === 'removed' || m.status === 'offline' || m.status === 'starting') return;
  if (m.launchedProjects === team.scope.projects.join('|')) return;
  if (m.status === 'busy') return (m.needsRelaunch = true); // 일이 끝나면
  const old = m.chatId;
  m.chatId = null;
  m.gen = (m.gen || 0) + 1;
  try {
    ai.stopChat(old);
  } catch {}
  setStatus(team, m, 'starting', '프로젝트 목록 바꾸는 중');
  launch(team, m, { resume: true }).catch(() => {});
}

// 이어 붙일 대화가 없을 때(이전 대화를 찾지 못함, AI 를 바꿈): 대화방의 최근 기록을 넘겨 준다
function handoffText(team, m) {
  const recent = team.log.filter((x) => x.from !== 'system' || x.kind === 'pause').slice(-40);
  if (!recent.length) return '';
  const who = (id) => (id === 'user' ? '사용자' : nameOf(team, id));
  const lines = recent.map((x) => `- ${who(x.from)}${x.to?.length ? ` → ${x.to.map(who).join(', ')}` : ''}: ${String(x.text || '').replace(/\s+/g, ' ').slice(0, 400)}`);
  let text = lines.join('\n');
  if (text.length > 8000) text = text.slice(-8000);
  return `[CodeFlow 안내] ${m.name} 님의 이전 AI 대화를 이어 붙일 수 없어 새로 시작했습니다. 아래는 팀 대화방의 최근 기록입니다 (더 필요하면 team_history). 이어서 일해 주세요.\n${text}`;
}

// 팀원의 AI·모델 바꾸기: 새로 띄운다 (이 팀원의 지난 대화 맥락은 이어지지 않음)
async function setMemberAI(teamId, memberId, { provider, model }) {
  const team = teams.get(teamId);
  const m = team?.members.find((x) => x.id === memberId);
  if (!m) throw new Error('팀원이 없습니다.');
  const old = m.chatId;
  m.chatId = null;
  try {
    ai.stopChat(old);
  } catch {}
  m.provider = provider;
  m.model = model || null;
  m.queue = [];
  m.sessionId = null; // 다른 AI 의 대화에는 이어 붙일 수 없다
  m.ctx = null;
  m.pendingHandoff = handoffText(team, m); // 대신 대화방의 최근 기록을 넘겨 준다
  setStatus(team, m, 'starting', '');
  scheduleSave(team);
  post(team, { from: 'system', text: `${m.name} 의 AI 를 ${provider === 'codex' ? 'Codex' : `Claude${m.model ? ` (${m.model})` : ''}`} 로 바꿨습니다. (이 팀원의 지난 대화 맥락은 새로 시작합니다)` });
  await launch(team, m);
  return publicMember(m);
}

function setStatus(team, m, status, activity = m.activity) {
  m.status = status;
  m.activity = activity;
  emit(team, { type: 'member', member: publicMember(m) });
}

function findMember(team, name) {
  const n = String(name || '').trim().replace(/^@/, '');
  return team.members.find((m) => m.status !== 'removed' && (m.name === n || m.id === n)) || null;
}

// 대화방에 글 남기기 (화면에 보이는 기록)
function post(team, msg) {
  const entry = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, time: Date.now(), ...msg };
  team.log.push(entry);
  if (team.log.length > 2000) team.log.splice(0, team.log.length - 2000);
  // 팀 제목: 사용자의 첫 메시지
  if (!team.title && msg.from === 'user' && msg.text) {
    team.title = msg.text.replace(/\s+/g, ' ').slice(0, 60);
    emit(team, { type: 'team', team: publicTeam(team) });
  }
  emit(team, { type: 'message', message: entry });
  scheduleSave(team);
  return entry;
}
const nameOf = (team, id) => (id === 'user' ? '사용자' : id === 'system' ? '시스템' : team.members.find((m) => m.id === id)?.name || id);

// ---------- 메시지 전달 ----------
// kind: 'request' (일을 맡김 → 끝나면 결과를 자동으로 돌려줌) / 'reply' (자동으로 돌아온 결과 → 다시 돌려주지 않음)
function deliver(team, m, { from, text, kind, attachments = [] }) {
  if (m.status === 'removed') return;
  if (from !== 'user') {
    team.hops++;
    if (team.hops > MAX_HOPS && !team.paused) {
      team.paused = true;
      emit(team, { type: 'team', team: publicTeam(team) });
      post(team, { from: 'system', kind: 'pause', text: `에이전트끼리 ${MAX_HOPS}번 넘게 대화가 이어져 잠시 멈췄습니다. 계속하려면 '계속' 을 누르거나 메시지를 보내 주세요.` });
    }
  }
  m.queue.push({ from, text, kind, attachments });
  pump(team, m);
}

function pump(team, m) {
  if (!m.queue.length || team.paused) return;
  // 아직 안 띄운 팀원(저장된 팀을 다시 열었을 때, 멈췄던 팀원): 이제 띄운다 (이전 대화에 이어 붙임)
  if (m.status === 'offline' || m.status === 'stopped') {
    setStatus(team, m, 'starting', m.sessionId ? '이전 대화 불러오는 중' : '');
    launch(team, m, { resume: true }).catch(() => {});
    return;
  }
  if (m.status !== 'idle') return;
  const batch = m.queue.splice(0);
  m.turnFrom = batch.map((b) => ({ from: b.from, kind: b.kind }));
  m.turnText = '';
  m.lastText = '';
  const body = batch
    .map((b) =>
      b.from === 'user'
        ? `[사용자 → 나] ${b.text}`
        : `[팀 메시지${b.kind === 'reply' ? ' · 결과 보고' : ''}] ${nameOf(team, b.from)}(${team.members.find((x) => x.id === b.from)?.role || ''}) → 나: ${b.text}`
    )
    .join('\n\n');
  const fullBody = m.pendingHandoff ? `${m.pendingHandoff}\n\n---\n\n${body}` : body;
  m.pendingHandoff = '';
  setStatus(team, m, 'busy', '생각 중');
  const att = batch.flatMap((b) => b.attachments || []);
  const others = att.filter((a) => a.kind === 'file');
  const content = att.length
    ? [
        ...att.filter((a) => a.kind === 'image').map((a) => ({ type: 'image', source: { type: 'base64', media_type: a.mime, data: a.data } })),
        ...att.filter((a) => a.kind === 'pdf').map((a) => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data }, title: a.name })),
        { type: 'text', text: others.length ? `${fullBody}\n\n[첨부 파일 — Read 도구로 읽어 주세요]\n${others.map((a) => a.path).join('\n')}` : fullBody },
      ]
    : fullBody;
  try {
    ai.sendChat(m.chatId, content);
  } catch (e) {
    setStatus(team, m, 'stopped', '');
    post(team, { from: 'system', text: `${m.name} 에게 전달하지 못했습니다: ${e.message}` });
  }
}

// 한 번의 답이 끝났을 때: 대화방에 보이고, 요청한 팀원에게 결과를 돌려준다
function finishTurn(team, m, { error } = {}) {
  const text = (m.lastText.trim() || m.turnText.trim()).trim();
  m.turnText = '';
  m.lastText = '';
  const requesters = [...new Set(m.turnFrom.filter((f) => f.kind === 'request' && f.from !== 'user' && f.from !== m.id).map((f) => f.from))];
  m.turnFrom = [];
  if (text) {
    const to = requesters.length ? requesters : m.pm ? ['user'] : [];
    post(team, { from: m.id, to, text });
    for (const rid of requesters) {
      const r = team.members.find((x) => x.id === rid);
      if (r) deliver(team, r, { from: m.id, text, kind: 'reply' });
    }
  }
  if (error) post(team, { from: 'system', text: `${m.name}: ${error}` });
  if (m.status !== 'stopped' && m.status !== 'removed') setStatus(team, m, 'idle', '');
  if (m.needsRelaunch) {
    m.needsRelaunch = false;
    return relaunchIfNeeded(team, m);
  }
  pump(team, m);
}

// ---------- 에이전트 이벤트 (Claude stream-json / Codex cf) ----------
const TOOL_KO = { Read: '파일 읽는 중', Write: '파일 만드는 중', Edit: '파일 고치는 중', MultiEdit: '파일 고치는 중', Bash: '명령 실행 중', PowerShell: '명령 실행 중', Grep: '코드 찾는 중', Glob: '파일 찾는 중', WebFetch: '웹 보는 중', WebSearch: '웹 검색 중', TodoWrite: '할 일 정리 중', Task: '하위 작업 중' };
function toolLabel(name, input = {}) {
  if (/team_send$/.test(name)) return `${input.to || ''} 에게 메시지 보내는 중`;
  if (/team_add_member$/.test(name)) return `팀원 ${input.name || ''} 만드는 중`;
  if (/team_members$/.test(name)) return '팀원 확인 중';
  if (/run_in_terminal$/.test(name)) return '터미널에서 실행 중';
  const base = TOOL_KO[name] || `${name.replace(/^mcp__\w+__/, '')} 사용 중`;
  const f = input.file_path || input.path || '';
  return f ? `${base}: ${String(f).split(/[\\/]/).pop()}` : base;
}

function onAgentEvent(team, m, ev) {
  if (!ev) return;
  // Codex (CodeFlow 형식)
  if (ev.type === 'cf') {
    if (ev.kind === 'ready') {
      m.resuming = false;
      if (m.status === 'starting') setStatus(team, m, 'idle', '');
      return pump(team, m);
    }
    // 그 팀원 AI 대화 id (Codex 스레드) — 다시 열 때 이어 붙이기용
    if (ev.kind === 'init' && ev.sessionId) {
      m.sessionId = ev.sessionId;
      m.sessionProvider = 'codex';
      return scheduleSave(team);
    }
    // 사용량 (계정의 5시간·주간·월간) / 컨텍스트 (팀원마다)
    if (ev.kind === 'usage_claude') return setRate(team, 'claude', [win(ev.windows?.five_hour, '세션', true), win(ev.windows?.seven_day, '주간', true)]);
    if (ev.kind === 'rate') {
      const lab = (w) => (!w.mins ? '사용량' : w.mins <= 300 ? `${Math.round(w.mins / 60)}시간` : w.mins <= 10080 ? '주간' : w.mins <= 44640 ? '월간' : '사용량');
      return setRate(team, 'codex', [ev.windows?.primary, ev.windows?.secondary].filter(Boolean).map((w) => ({ label: lab(w), ...w })));
    }
    // 이 팀원 AI 의 MCP·커넥터 실제 연결 상태 (Codex)
    if (ev.kind === 'mcp') {
      m.mcp = (ev.servers || []).map((x) => ({ name: x.name, status: x.status, error: x.error || null }));
      return emit(team, { type: 'member', member: publicMember(m) });
    }
    if (ev.kind === 'ctx' || (ev.kind === 'usage' && ev.used)) {
      m.ctx = { used: ev.used, window: ev.window || m.ctx?.window || 200000 };
      return emit(team, { type: 'member', member: publicMember(m) });
    }
    if (ev.kind === 'thinking') return m.status === 'busy' && m.activity !== '생각 중' && setStatus(team, m, 'busy', '생각 중');
    if (ev.kind === 'text_start') {
      if (m.turnText && !/\n\n$/.test(m.turnText)) m.turnText += '\n\n';
      m.lastText = '';
      return;
    }
    if (ev.kind === 'text_delta') {
      m.turnText += ev.delta || '';
      m.lastText += ev.delta || '';
      return emit(team, { type: 'stream', memberId: m.id, text: m.turnText });
    }
    if (ev.kind === 'text_done') {
      if (ev.text) m.lastText = ev.text;
      return;
    }
    if (ev.kind === 'tool_start') return setStatus(team, m, 'busy', ev.label || ev.title || '작업 중');
    if (ev.kind === 'result') return finishTurn(team, m, { error: ev.ok || ev.interrupted ? null : ev.error });
    if (ev.kind === 'error') return post(team, { from: 'system', text: `${m.name}: ${ev.message}` });
    return;
  }
  // Claude Code (stream-json)
  if (ev.type === 'cf' || ev.type === 'raw') return;
  if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
    m.sessionId = ev.session_id;
    m.sessionProvider = 'claude';
    // 이 팀원 AI 의 MCP·커넥터 실제 연결 상태 (Claude Code)
    if (Array.isArray(ev.mcp_servers)) {
      m.mcp = ev.mcp_servers.map((x) => ({ name: x.name, status: x.status }));
      emit(team, { type: 'member', member: publicMember(m) });
    }
    return scheduleSave(team);
  }
  if (ev.type === 'rate_limit_event') {
    const w = ev.rate_limit_info?.unifiedWindows;
    if (w) setRate(team, 'claude', [w.five_hour && { label: '세션', ...w.five_hour }, w.seven_day && { label: '주간', ...w.seven_day }]);
    return;
  }
  if (ev.type === 'stream_event') {
    const e = ev.event;
    if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
      m.turnText += e.delta.text;
      m.lastText += e.delta.text;
      emit(team, { type: 'stream', memberId: m.id, text: m.turnText });
    } else if (e?.type === 'content_block_start' && e.content_block?.type === 'text') {
      // 새 글 덩어리: 진행 중 말풍선에서는 문단을 나누고, '마지막 글' 은 새로 시작
      if (m.turnText && !/\n\n$/.test(m.turnText)) m.turnText += '\n\n';
      m.lastText = '';
    }
    return;
  }
  if (ev.type === 'assistant') {
    for (const b of ev.message?.content || []) {
      if (b.type === 'tool_use') setStatus(team, m, 'busy', toolLabel(b.name, b.input));
      // 글이 도구 뒤에 끝나지 않으면(마지막이 도구) 다음 글을 기다린다. 글 블록 경계는 stream_event 로 이미 처리
    }
    return;
  }
  if (ev.type === 'result') return finishTurn(team, m, { error: ev.is_error ? ev.result || '오류가 났습니다.' : null });
  if (ev.type === 'exit') {
    if (m.resuming && m.status === 'starting') {
      // 저장된 이전 대화를 찾지 못함(지워졌거나 다른 PC) → 이 팀원만 새로 시작
      m.resuming = false;
      m.sessionId = null;
      m.pendingHandoff = handoffText(team, m);
      post(team, { from: 'system', text: `${m.name} 의 이전 대화를 찾지 못해 새로 시작합니다. 대화방의 최근 기록을 넘겨 줍니다.` });
      launch(team, m).catch(() => {});
      return;
    }
    if (m.status !== 'removed') setStatus(team, m, 'stopped', '');
    if (m.status !== 'removed' && ev.code) post(team, { from: 'system', text: `${m.name} 의 AI 가 종료되었습니다${ev.stderr ? `: ${String(ev.stderr).slice(0, 300)}` : ''}` });
    return;
  }
  // Claude 의 준비 완료(initialize 응답)는 ai.js 가 { type: 'cf', kind: 'ready' } 로 보내므로 위 cf 분기에서 처리된다
}

// 사용량 창: { label, utilization(0~1), resetsAt(초) }
function win(x, label, percent) {
  if (!x) return null;
  return { label, utilization: percent ? (x.utilization || 0) / 100 : x.utilization || 0, resetsAt: x.resets_at ? Date.parse(x.resets_at) / 1000 : x.resetsAt || null };
}
function setRate(team, provider, windows) {
  team.rate = { ...(team.rate || {}), [provider]: windows.filter(Boolean) };
  emit(team, { type: 'usage', rate: team.rate });
}

// ---------- 팀 도구 (에이전트가 부름) ----------
tools.setTeamHandler(async ({ teamId, memberId }, name, args) => {
  const team = teams.get(teamId);
  const me = team?.members.find((m) => m.id === memberId);
  if (!team || !me) return { error: '팀이 끝났습니다.' };
  if (name === 'team_members') {
    return { result: team.members.filter((m) => m.status !== 'removed').map((m) => ({ name: m.name, role: m.role, status: m.status === 'busy' ? `일하는 중 (${m.activity})` : m.status === 'idle' ? '대기' : m.status, leader: !!m.pm })) };
  }
  if (name === 'team_history') {
    const limit = Math.max(1, Math.min(100, Number(args.limit) || 30));
    const who = (id) => (id === 'user' ? '사용자' : id === 'system' ? '시스템' : nameOf(team, id));
    let rows = team.log;
    if (args.member) {
      const f = findMember(team, args.member) || team.members.find((x) => x.name === args.member);
      if (f) rows = rows.filter((x) => x.from === f.id || (x.to || []).includes(f.id));
    }
    if (args.query) rows = rows.filter((x) => String(x.text || '').includes(args.query));
    return {
      result: rows
        .slice(-limit)
        .map((x) => `[${new Date(x.time).toLocaleString('ko-KR')}] ${who(x.from)}${x.to?.length ? ` → ${x.to.map(who).join(', ')}` : ''}: ${String(x.text || '').slice(0, 1200)}`)
        .join('\n'),
    };
  }
  if (name === 'team_add_member') {
    if (!me.pm) return { error: '팀원은 팀장만 만들 수 있습니다.' };
    try {
      const prov = args.ai === 'codex' || args.ai === 'claude' ? args.ai : undefined;
      const m = await addMember(team, { name: args.name, role: args.role, instructions: args.instructions, provider: prov, model: args.model || undefined });
      return { result: `${m.name} (${m.role}) 을(를) 팀에 추가했습니다. team_send 로 일을 맡기세요.` };
    } catch (e) {
      return { error: e.message };
    }
  }
  if (name === 'team_remove_member') {
    if (!me.pm) return { error: '팀원은 팀장만 내보낼 수 있습니다.' };
    const m = findMember(team, args.name);
    if (!m || m.pm) return { error: `'${args.name}' 팀원이 없습니다.` };
    removeMember(team, m.id);
    return { result: `${m.name} 을(를) 팀에서 내보냈습니다.` };
  }
  if (name === 'team_send') {
    const text = String(args.message || '').trim();
    if (!text) return { error: '보낼 내용이 없습니다.' };
    const raw = String(args.to || '').trim();
    const names = /^(all|모두|전체)$/i.test(raw) ? team.members.filter((m) => m.status !== 'removed' && m.id !== me.id).map((m) => m.id) : raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    const toUser = names.some((n) => /^(user|사용자)$/i.test(n));
    const targets = /^(all|모두|전체)$/i.test(raw) ? names.map((id) => team.members.find((m) => m.id === id)) : names.filter((n) => !/^(user|사용자)$/i.test(n)).map((n) => findMember(team, n));
    const missing = names.filter((n, i) => !/^(user|사용자)$/i.test(n) && !/^(all|모두|전체)$/i.test(raw) && !targets[i]);
    if (missing.length) return { error: `없는 팀원: ${missing.join(', ')} (team_members 로 확인)` };
    const ok = targets.filter(Boolean).filter((m) => m.id !== me.id);
    post(team, { from: me.id, to: [...(toUser ? ['user'] : []), ...ok.map((m) => m.id)], text, kind: 'dm' });
    for (const m of ok) deliver(team, m, { from: me.id, text, kind: 'request' });
    return { result: `${[...(toUser ? ['사용자'] : []), ...ok.map((m) => m.name)].join(', ')} 에게 보냈습니다.${ok.length ? ' 일이 끝나면 결과가 자동으로 돌아옵니다.' : ''}` };
  }
  return { error: `알 수 없는 도구: ${name}` };
});

// ---------- 사용자 동작 ----------
function userSend(teamId, { to = [], text, attachments = [] }) {
  const team = teams.get(teamId);
  if (!team) throw new Error('팀이 없습니다.');
  text = String(text || '').trim();
  if (!text && !attachments.length) return;
  if (!text) text = '첨부한 파일을 확인해 주세요.';
  team.hops = 0; // 사용자가 말하면 반복 횟수 초기화
  if (team.paused) {
    team.paused = false;
    emit(team, { type: 'team', team: publicTeam(team) });
  }
  const targets = (to.length ? to.map((id) => team.members.find((m) => m.id === id)) : [team.members.find((m) => m.pm)]).filter((m) => m && m.status !== 'removed');
  post(team, { from: 'user', to: targets.map((m) => m.id), text, attachments: attachments.map((a) => ({ name: a.name, kind: a.kind, path: a.path })) });
  for (const m of targets) deliver(team, m, { from: 'user', text, kind: 'request', attachments });
  // 멈춰 있던 대기열도 다시 흘려보낸다
  for (const m of team.members) pump(team, m);
}

function resume(teamId) {
  const team = teams.get(teamId);
  if (!team) return;
  team.paused = false;
  team.hops = 0;
  emit(team, { type: 'team', team: publicTeam(team) });
  post(team, { from: 'system', text: '다시 진행합니다.' });
  for (const m of team.members) pump(team, m);
}

// 모두 멈춤: 하던 답을 중단하고 대기열을 비운다 (팀원은 남음)
function stopAllWork(teamId) {
  const team = teams.get(teamId);
  if (!team) return;
  for (const m of team.members) {
    m.queue = [];
    if (m.status === 'busy') {
      try {
        ai.interruptChat(m.chatId);
      } catch {}
    }
  }
  team.paused = true;
  emit(team, { type: 'team', team: publicTeam(team) });
  post(team, { from: 'system', kind: 'pause', text: '모든 팀원의 작업을 멈췄습니다. 메시지를 보내면 다시 시작합니다.' });
}

function removeMember(team, memberId) {
  const m = team.members.find((x) => x.id === memberId);
  if (!m || m.pm) return;
  m.status = 'removed';
  m.queue = [];
  m.gen = (m.gen || 0) + 1; // 이후 오는 이벤트 무시
  try {
    ai.stopChat(m.chatId);
  } catch {}
  emit(team, { type: 'member', member: publicMember(m) });
  post(team, { from: 'system', text: `${m.name} (${m.role}) 이(가) 팀에서 나갔습니다.` });
}

function dispose(teamId) {
  const team = teams.get(teamId);
  if (!team) return;
  if (team.saveTimer) saveNow(team);
  for (const m of team.members) {
    m.gen = (m.gen || 0) + 1;
    try {
      ai.stopChat(m.chatId);
    } catch {}
  }
  teams.delete(teamId);
}
function disposeAll() {
  for (const id of [...teams.keys()]) dispose(id);
}

const get = (teamId) => (teams.has(teamId) ? publicTeam(teams.get(teamId)) : null);
const list = () => [...teams.values()].map((t) => ({ id: t.id, repo: t.repo }));
// 지금 열려 있는 이 범위(프로젝트 / 그룹)의 팀 (화면을 다시 그릴 때)
const openFor = (scope) => {
  const k = scopeKey(normScope(scope));
  return [...teams.values()].filter((t) => scopeKey(t.scope) === k).map((t) => t.id);
};
// 대화방의 더 오래된 기록 (화면은 최근 것부터 조금씩 그린다)
function older(teamId, beforeId, count = 200) {
  const team = teams.get(teamId);
  if (!team) return { items: [], more: false };
  const i = team.log.findIndex((x) => x.id === beforeId);
  const end = i < 0 ? team.log.length : i;
  const start = Math.max(0, end - count);
  return { items: team.log.slice(start, end), more: start > 0 };
}
// 사용량을 다시 조회 (팀 화면을 열 때)
function refreshUsage(teamId) {
  const team = teams.get(teamId);
  for (const m of team?.members || []) if (m.chatId && m.status !== 'removed' && m.status !== 'offline') ai.refreshUsage(m.chatId);
}

module.exports = {
  setSender,
  create,
  get,
  list,
  userSend,
  resume,
  stopAllWork,
  removeMember: (teamId, memberId) => teams.has(teamId) && removeMember(teams.get(teamId), memberId),
  addMemberByUser: async (teamId, opts) => publicMember(await addMember(teams.get(teamId), opts)),
  setMemberAI,
  dispose,
  disposeAll,
  listSaved,
  open,
  deleteSaved,
  openFor,
  older,
  setProjects,
  refreshUsage,
};
