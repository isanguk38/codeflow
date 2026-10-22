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

function registerSession(repo) {
  const key = crypto.randomBytes(8).toString('hex');
  sessions.set(key, { repo });
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
  if (name === 'approve') {
    // Claude Code 권한 확인: { behavior: 'allow', updatedInput } 또는 { behavior: 'deny', message }
    const r = await askRenderer(ctx.repo, 'approve', args, 0);
    return text(r.allow ? { behavior: 'allow', updatedInput: args.input || {} } : { behavior: 'deny', message: r.message || '사용자가 거부했습니다.' });
  }
  if (!TOOLS.some((t) => t.name === name)) return text(`알 수 없는 도구: ${name}`, true);
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
        return reply({ tools: TOOLS });
      case 'tools/call':
        return reply(await callTool(msg.params?.name, msg.params?.arguments || {}, ctx));
      default:
        return fail(-32601, `지원하지 않는 요청: ${msg.method}`);
    }
  } catch (e) {
    return reply(text(e.message || String(e), true));
  }
}

async function ensureServer() {
  if (server) return port;
  server = http.createServer((req, res) => handle(req, res).catch(() => res.writeHead(500).end()));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve); // 내 PC 에서만 접속 가능
  });
  port = server.address().port;
  return port;
}

// Claude Code 의 --mcp-config 에 넘길 설정
async function mcpConfig(sessionKey) {
  const p = await ensureServer();
  return { mcpServers: { codeflow: { type: 'http', url: `http://127.0.0.1:${p}/mcp/${sessionKey}`, headers: { Authorization: `Bearer ${token}` } } } };
}

function stopServer() {
  server?.close();
  server = null;
}

module.exports = { approve, mcpConfig, registerSession, unregisterSession, setRendererBridge, stopServer, TOOLS };
