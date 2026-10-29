// AI 패널용 CodeFlow 도구 서버 (MCP, 내 PC 안에서만 접속 가능한 HTTP)
// Claude Code / Codex 같은 AI 가 이 서버의 도구로 CodeFlow 를 직접 다룬다:
//   터미널에서 명령 실행, 터미널 출력 읽기, 파일 열기, 화면 이동, Git 상태 보기, 그리고 위험한 작업 전 사용자 승인 받기.
// 화면을 다루는 도구는 렌더러(앱 화면)에 요청을 보내고 결과를 기다린다.
const http = require('http');
const crypto = require('crypto');

const TOOLS = [
  {
    name: 'run_in_terminal',
    description:
      'CodeFlow 아래쪽 터미널 패널에 새 터미널을 열고 명령을 실행한다 (현재 프로젝트 폴더 기준). 사용자가 직접 볼 수 있으므로 프로젝트 실행, 서버 띄우기, 빌드, 테스트처럼 사용자가 결과를 봐야 하거나 오래 걸리는 명령은 이 도구를 쓴다. wait_seconds 동안 기다린 뒤 지금까지의 출력을 돌려준다.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '실행할 명령 (예: mvn package, npm start)' },
        shell: { type: 'string', enum: ['powershell', 'cmd', 'gitbash'], description: '셸 (기본 powershell)' },
        wait_seconds: { type: 'number', description: '출력을 기다릴 시간(초), 기본 5, 최대 120' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_terminal',
    description: 'CodeFlow 터미널의 최근 출력을 읽는다. terminal_id 를 생략하면 현재 보이는 터미널.',
    inputSchema: { type: 'object', properties: { terminal_id: { type: 'number' }, lines: { type: 'number', description: '마지막 몇 줄 (기본 80)' } } },
  },
  {
    name: 'list_terminals',
    description: '현재 프로젝트에서 열려 있는 CodeFlow 터미널 목록 (id, 셸, 종료 여부)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'open_file',
    description: 'CodeFlow 코드 화면에서 파일을 연다 (사용자에게 보여 주기). line 을 주면 그 줄로 이동.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: '프로젝트 기준 상대 경로 또는 절대 경로' }, line: { type: 'number' } }, required: ['path'] },
  },
  {
    name: 'show_view',
    description: 'CodeFlow 화면을 바꾼다: changes(커밋 화면), log(히스토리), stash(스태시), code(코드 편집기).',
    inputSchema: { type: 'object', properties: { view: { type: 'string', enum: ['changes', 'log', 'stash', 'code'] } }, required: ['view'] },
  },
  {
    name: 'save_document',
    description:
      '사용자가 저장 위치를 정하지 않은 문서(엑셀·파워포인트·워드·PDF·한글·CSV 보고서 등)를 다 만든 뒤 반드시 호출한다. CodeFlow 대화창에 미리보기와 함께 "어디에 저장할까요?" 를 띄우고, 사용자가 고른 곳으로 파일을 옮긴 뒤 최종 경로를 돌려준다. path 는 방금 만든 파일의 절대 경로. 여러 파일이면 한 번에 하나씩 호출.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: '만든 파일의 절대 경로 (보통 안내받은 임시 결과물 폴더 안)' }, title: { type: 'string', description: '문서 설명 한 줄 (선택)' } }, required: ['path'] },
  },
  {
    name: 'list_projects',
    description:
      'CodeFlow 에 탭으로 열려 있는 프로젝트 목록 (이름, 폴더 경로, 현재 보고 있는 탭인지, 브랜치, 변경 파일 수). 다른 프로젝트의 파일도 이 경로(절대 경로)로 읽고 수정할 수 있다.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'switch_project',
    description: 'CodeFlow 에서 다른 프로젝트 탭으로 전환해 사용자에게 보여 준다 (path 는 list_projects 의 경로).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'git_status',
    description: '프로젝트의 Git 상태 (브랜치, 원격과 차이, 변경된 파일 목록). path 를 주면 그 프로젝트 (list_projects 의 경로), 없으면 대화를 시작한 프로젝트.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
  {
    name: 'approve',
    description: '작업 전에 CodeFlow 화면에서 사용자에게 허용/거부를 묻는다 (권한 확인용, 직접 호출하지 않음)',
    inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name'] },
  },
];

// 멀티 에이전트 팀 전용 도구 (팀 채팅방에서 실행되는 에이전트에게만 보임)
const TEAM_TOOLS = [
  {
    name: 'team_send',
    description:
      '팀 채팅방에서 다른 팀원(또는 사용자)에게 메시지를 보낸다. to 는 팀원 이름, 여러 명이면 쉼표로, 모두에게는 "all", 사용자에게는 "user". 받은 팀원이 일을 마치면 그 답이 자동으로 나에게 돌아온다. 사용자도 이 대화방을 모두 본다.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string', description: '받는 사람: 팀원 이름 / "all" / "user"' }, message: { type: 'string', description: '보낼 내용 (구체적으로, 짧게)' } },
      required: ['to', 'message'],
    },
  },
  {
    name: 'team_members',
    description: '지금 팀원 목록 (이름, 역할, 상태)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'team_history',
    description: '팀 대화방의 지난 기록을 읽는다 (다른 팀원끼리 나눈 대화, 지난 흐름 확인용). member 를 주면 그 팀원이 보내거나 받은 것만, query 를 주면 그 글자가 들어간 것만.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '최근 몇 개 (기본 30, 최대 100)' }, member: { type: 'string', description: '팀원 이름 (선택)' }, query: { type: 'string', description: '찾을 글자 (선택)' } },
    },
  },
];
// 팀장(PM, 오케스트레이터)만 팀원을 만들 수 있다
const PM_TOOLS = [
  {
    name: 'team_add_member',
    description:
      '팀에 새 에이전트(팀원)를 만든다. 사람 이름(한국어, 예: 지수)과 역할(예: 기획자, 백엔드 개발자, 프론트엔드 개발자, 테스터, 디자이너)을 정하고, 이 팀원이 무엇을 책임지는지 instructions 에 적는다. 만든 뒤 team_send 로 일을 맡긴다.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '팀원 이름 (짧게, 한국어 이름)' },
        role: { type: 'string', description: '역할 (예: 백엔드 개발자)' },
        instructions: { type: 'string', description: '맡을 일과 기준 (이 팀원의 시스템 지시)' },
        ai: { type: 'string', enum: ['claude', 'codex'], description: '이 팀원이 쓸 AI (생략하면 팀 기본). 사용자가 특정 AI 를 원할 때만 지정' },
        model: { type: 'string', description: 'Claude 모델 (sonnet / opus / haiku, 생략하면 팀 기본)' },
      },
      required: ['name', 'role'],
    },
  },
  {
    name: 'team_remove_member',
    description: '더 필요 없는 팀원을 팀에서 내보낸다 (이름).',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
];
const TEAM_HIDDEN = new Set(['open_file', 'show_view', 'switch_project']);
let teamHandler = async () => ({ error: '팀 기능이 준비되지 않았습니다.' });
function setTeamHandler(fn) {
  teamHandler = fn;
}

// 렌더러에 요청을 보내고 응답을 기다린다
let askRenderer = async () => {
  throw new Error('CodeFlow 화면이 준비되지 않았습니다.');
};
function setRendererBridge(fn) {
  askRenderer = fn;
}
// 사용자에게 허용/거부 묻기 (Codex 의 승인 요청도 같은 카드로) → { allow, message }
const approve = (repo, args) => askRenderer(repo, 'approve', args, 0);

let server = null;
let port = 0;
const token = crypto.randomBytes(24).toString('hex');
// 접속 주소마다 어느 프로젝트(저장소)의 대화인지 구분 (/mcp/<세션키>)
const sessions = new Map(); // key → { repo }

// extra.team = { teamId, memberId, pm } — 팀 채팅방의 에이전트면 팀 도구를 보여 주고, 승인 요청을 팀 화면으로 보낸다
function registerSession(repo, extra = {}) {
  const key = crypto.randomBytes(8).toString('hex');
  sessions.set(key, { repo, ...extra });
  return key;
}
function unregisterSession(key) {
  sessions.delete(key);
}

const text = (t, isError = false) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }], ...(isError ? { isError: true } : {}) });

async function callTool(name, args, ctx) {
  if (name === 'git_status') {
    const git = require('./git');
    const s = await git.status(args.path || ctx.repo);
    return text({
      branch: s.branch,
      upstream: s.upstream,
      ahead: s.ahead,
      behind: s.behind,
      files: (s.files || []).slice(0, 300).map((f) => `${f.x}${f.y} ${f.path}`),
      state: s.state || null, // merge / rebase / cherry-pick 진행 중이면 표시
    });
  }
  if (name === 'save_document') {
    // 사용자가 고를 때까지 기다린다 (시간 제한 없음)
    const r = await askRenderer(ctx.repo, name, ctx.team ? { ...args, team: ctx.team } : args, 0);
    return r.error ? text(r.error, true) : text(r.result ?? 'ok');
  }
  if (name.startsWith('team_')) {
    if (!ctx.team) return text('팀 채팅방에서만 쓸 수 있는 도구입니다.', true);
    const r = await teamHandler(ctx.team, name, args);
    return r.error ? text(r.error, true) : text(r.result ?? 'ok');
  }
  if (name === 'approve') {
    // Claude Code 권한 확인: { behavior: 'allow', updatedInput } 또는 { behavior: 'deny', message }
    const r = await askRenderer(ctx.repo, 'approve', ctx.team ? { ...args, team: ctx.team } : args, 0);
    return text(r.allow ? { behavior: 'allow', updatedInput: args.input || {} } : { behavior: 'deny', message: r.message || '사용자가 거부했습니다.' });
  }
  if (!TOOLS.some((t) => t.name === name) || (ctx.team && TEAM_HIDDEN.has(name))) return text(`알 수 없는 도구: ${name}`, true);
  const wait = name === 'run_in_terminal' ? Math.min(120, Math.max(1, Number(args.wait_seconds) || 5)) : 0;
  const r = await askRenderer(ctx.repo, name, args, (wait + 30) * 1000);
  return r.error ? text(r.error, true) : text(r.result ?? 'ok');
}

async function handle(req, res) {
  const m = req.url.match(/^\/mcp\/([0-9a-f]+)$/);
  const ctx = m && sessions.get(m[1]);
  if (!ctx || req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401).end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' }).end();
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  let msg;
  try {
    msg = JSON.parse(body);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const reply = (result) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  };
  const fail = (code, message) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message } }));
  };
  if (msg.id === undefined) {
    res.writeHead(202).end(); // 알림 (notifications/initialized 등)
    return;
  }
  try {
    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: msg.params?.protocolVersion || '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'codeflow', version: require('electron').app.getVersion() },
          instructions: 'CodeFlow(Git GUI + 코드 편집기) 를 다루는 도구들입니다. 사용자가 결과를 봐야 하는 명령은 run_in_terminal 로 CodeFlow 터미널에서 실행하세요.',
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        // 팀 에이전트에게는 화면을 바꾸는 도구를 주지 않는다 (여러 명이 일하면서 사용자를 팀 채팅방 밖으로 끌고 가지 않게)
        return reply({ tools: ctx.team ? [...TOOLS.filter((t) => !TEAM_HIDDEN.has(t.name)), ...TEAM_TOOLS, ...(ctx.team.pm ? PM_TOOLS : [])] : TOOLS });
      case 'tools/call':
        return reply(await callTool(msg.params?.name, msg.params?.arguments || {}, ctx));
      default:
        return fail(-32601, `지원하지 않는 요청: ${msg.method}`);
    }
  } catch (e) {
    return reply(text(e.message || String(e), true));
  }
}

// 여러 대화가 동시에 시작해도(팀원 여러 명을 한꺼번에 깨울 때) 모두 서버가 다 켜진 뒤의 포트를 받도록 켜는 중인 약속을 같이 기다린다
// (예전에는 켜는 도중에 부른 쪽이 포트 0 을 받아 CodeFlow 도구 없이 시작됐다)
let starting = null;
function ensureServer() {
  if (starting) return starting;
  starting = new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => handle(req, res).catch(() => res.writeHead(500).end()));
    s.once('error', (e) => {
      starting = null;
      reject(e);
    });
    s.listen(0, '127.0.0.1', () => {
      // 내 PC 에서만 접속 가능
      server = s;
      port = s.address().port;
      resolve(port);
    });
  });
  return starting;
}

// Claude Code 의 --mcp-config 에 넘길 설정
async function mcpConfig(sessionKey) {
  const p = await ensureServer();
  return { mcpServers: { codeflow: { type: 'http', url: `http://127.0.0.1:${p}/mcp/${sessionKey}`, headers: { Authorization: `Bearer ${token}` } } } };
}

function stopServer() {
  server?.close();
  server = null;
  starting = null;
}

module.exports = { approve, mcpConfig, registerSession, unregisterSession, setRendererBridge, setTeamHandler, stopServer, TOOLS };
