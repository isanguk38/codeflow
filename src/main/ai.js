// AI 패널: 외부 AI 도구(Claude Code 등)를 내 PC 에서 실행해 연결한다.
// - 설치: 공식 설치 방식으로 사용자 폴더에 설치 (관리자 권한 불필요)
// - 로그인: 각 도구의 공식 로그인 명령 (브라우저가 열림). 로그인 정보는 도구가 직접 보관
// - 대화: 도구를 프로젝트 폴더에서 실행하고 실시간 출력(JSON)을 화면에 중계
//   CodeFlow 도구 서버(ai-tools.js)를 연결해 터미널 실행·파일 열기·화면 이동 등을 할 수 있게 한다
const { app } = require('electron');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tools = require('./ai-tools');
const codex = require('./codex');

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

// ---------- 지원하는 AI ----------

const PROVIDERS = {
  codex: { name: 'Codex', vendor: 'OpenAI', candidates: () => [] },
  claude: {
    name: 'Claude Code',
    vendor: 'Anthropic',
    // 공식 설치 방식 (Windows PowerShell): https://docs.claude.com/claude-code
    installCommand: 'irm https://claude.ai/install.ps1 | iex',
    candidates: () => [
      path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
      ...(process.env.APPDATA ? [path.join(process.env.APPDATA, 'npm', 'claude.cmd')] : []),
      ...(process.env.PATH || '').split(';').filter(Boolean).flatMap((d) => [path.join(d, 'claude.exe'), path.join(d, 'claude.cmd')]),
    ],
  },
};

function findExe(id) {
  const p = PROVIDERS[id];
  return p ? p.candidates().find((f) => fs.existsSync(f)) || null : null;
}

function run(exe, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(exe, args, { timeout, windowsHide: true, shell: exe.endsWith('.cmd'), maxBuffer: 1 << 22 }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err?.message }));
  });
}

// 설치 여부 + 버전 + 로그인 상태
async function status(id) {
  if (id === 'codex') return codex.status();
  const exe = findExe(id);
  if (!exe) return { id, installed: false };
  const v = await run(exe, ['--version']);
  const a = await run(exe, ['auth', 'status', '--json']);
  let auth = null;
  try {
    auth = JSON.parse(a.stdout);
  } catch {}
  return {
    id,
    installed: true,
    exe,
    version: (v.stdout.match(/[\d.]+/) || [])[0] || null,
    loggedIn: !!auth?.loggedIn,
    authMethod: auth?.authMethod || null,
    account: auth?.email || auth?.account?.email || null,
  };
}

// ---------- 설치 ----------

let installing = null;
function install(id, onLog) {
  if (id === 'codex') return codex.install(onLog);
  if (installing) return installing;
  const p = PROVIDERS[id];
  if (!p) return Promise.reject(new Error('지원하지 않는 AI'));
  installing = new Promise((resolve, reject) => {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', p.installCommand], { windowsHide: true });
    const out = (d) =>
      stripAnsi(String(d))
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .forEach((l) => onLog(l));
    child.stdout.on('data', out);
    child.stderr.on('data', out);
    child.on('error', reject);
    child.on('exit', async (code) => {
      const s = await status(id);
      if (s.installed) resolve(s);
      else reject(new Error(`설치하지 못했습니다 (종료 코드 ${code}). 위 기록을 확인하세요.`));
    });
  }).finally(() => (installing = null));
  return installing;
}

// ---------- 로그인 (브라우저가 열리는 공식 로그인 명령, 터미널이 필요해서 의사 터미널로 실행) ----------

let loginProc = null;
function login(id, onLog) {
  if (id === 'codex') return codex.login(onLog);
  const exe = findExe(id);
  if (!exe) return Promise.reject(new Error('먼저 설치하세요.'));
  cancelLogin();
  return new Promise((resolve) => {
    const pty = require('@lydell/node-pty');
    const p = pty.spawn(exe, ['auth', 'login'], { name: 'xterm-256color', cols: 200, rows: 30, cwd: os.homedir(), env: process.env, useConpty: true });
    loginProc = p;
    let buf = '';
    p.onData((d) => {
      buf += stripAnsi(d);
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      lines.filter((l) => l.trim()).forEach((l) => onLog(l));
    });
    p.onExit(async ({ exitCode }) => {
      if (buf.trim()) onLog(buf);
      if (loginProc === p) loginProc = null;
      resolve({ exitCode, status: await status(id) });
    });
  });
}
// 로그인 화면에서 코드를 붙여 넣어야 하는 경우 등
function loginInput(text) {
  loginProc?.write(text);
  codex.loginInput(text);
}
function cancelLogin() {
  codex.cancelLogin();
  try {
    loginProc?.kill();
  } catch {}
  loginProc = null;
}

async function logout(id) {
  if (id === 'codex') return codex.logout();
  const exe = findExe(id);
  if (exe) await run(exe, ['auth', 'logout']);
  return status(id);
}

// ---------- 대화 ----------

// CodeFlow(Electron) 전용 환경 변수는 빼고 넘긴다
function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return env;
}

const chats = new Map(); // chatId → { proc, repo, sessionKey }
let chatSeq = 0;

// 사용자가 저장 위치를 말하지 않은 문서(엑셀·PPT·워드 등)를 AI 가 먼저 만들어 두는 곳 (프로젝트 밖)
// → 다 만들면 CodeFlow 가 대화창에서 '어디에 저장할까요?' 를 묻고 고른 곳으로 옮긴다
function outputDir(repo) {
  const d = path.join(app.getPath('userData'), 'ai', 'drafts', path.basename(repo).replace(/[^\w.-]+/g, '_') || 'project');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function guideFile(repo) {
  // 앱 패키지(asar) 안의 파일은 외부 프로그램이 못 읽으므로 사용자 폴더에 복사해서 넘긴다
  const src = path.join(__dirname, 'ai-guide.md');
  const dst = path.join(app.getPath('userData'), 'ai', `codeflow-guide-${crypto.createHash('sha1').update(String(repo).toLowerCase()).digest('hex').slice(0, 10)}.md`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const text = fs.readFileSync(src, 'utf8').replace('{{VERSION}}', app.getVersion()).replace(/\{\{OUTPUT_DIR\}\}/g, outputDir(repo));
  if (!fs.existsSync(dst) || fs.readFileSync(dst, 'utf8') !== text) fs.writeFileSync(dst, text);
  return dst;
}

// 승인 없이 써도 되는 CodeFlow 도구 (읽기·화면 이동만). 터미널 실행·파일 수정·명령 실행은 사용자 승인 필요
const SAFE_TOOLS = ['mcp__codeflow__team_send', 'mcp__codeflow__team_members', 'mcp__codeflow__team_add_member', 'mcp__codeflow__team_remove_member', 'mcp__codeflow__read_terminal', 'mcp__codeflow__list_terminals', 'mcp__codeflow__open_file', 'mcp__codeflow__show_view', 'mcp__codeflow__git_status', 'mcp__codeflow__list_projects', 'mcp__codeflow__switch_project', 'mcp__codeflow__save_document'];

// team: 멀티 에이전트 팀의 팀원이면 { teamId, memberId, pm }, extraPrompt: 그 팀원의 역할 지시 (기본 안내 뒤에 붙임)
async function startChat({ provider = 'claude', repo, resume, model, addDirs = [], team = null, extraPrompt = '' }, send) {
  if (provider === 'codex') {
    const id = ++chatSeq;
    const c = new codex.CodexChat(id, repo, (ev) => send('ai:event', id, ev));
    chats.set(id, { codex: c, repo });
    c.proc = null;
    const guide = fs.readFileSync(guideFile(repo), 'utf8') + (extraPrompt ? `\n\n${extraPrompt}` : '');
    try {
      await c.start({ resume, model, addDirs: [...addDirs.filter((d) => d && d.toLowerCase() !== repo.toLowerCase() && fs.existsSync(d)), outputDir(repo)], guide, team });
    } catch (e) {
      c.stop();
      chats.delete(id);
      throw e;
    }
    c.proc.on('exit', () => chats.delete(id));
    return { id };
  }
  const exe = findExe(provider);
  if (!exe) throw new Error('AI 도구가 설치되어 있지 않습니다.');
  const sessionKey = tools.registerSession(repo, team ? { team } : {});
  const cfgFile = path.join(app.getPath('userData'), 'ai', `mcp-${sessionKey}.json`);
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify(await tools.mcpConfig(sessionKey)));
  // 팀원: 기본 안내 + 역할 지시를 한 파일로
  let promptFile = guideFile(repo);
  if (extraPrompt) {
    promptFile = path.join(app.getPath('userData'), 'ai', `team-${sessionKey}.md`);
    fs.writeFileSync(promptFile, `${fs.readFileSync(guideFile(repo), 'utf8')}\n\n${extraPrompt}`);
  }
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--mcp-config',
    cfgFile,
    '--append-system-prompt-file',
    promptFile,
    // 위험할 수 있는 작업(파일 수정, 명령 실행)은 CodeFlow 화면에서 허용/거부를 묻는다
    '--permission-prompt-tool',
    'mcp__codeflow__approve',
    '--allowedTools',
    SAFE_TOOLS.join(','),
    // CodeFlow 에 열린 다른 프로젝트 탭들도 읽고 수정할 수 있게 (Cursor 의 여러 폴더 작업 공간처럼)
    ...addDirs.filter((d) => d && d.toLowerCase() !== repo.toLowerCase() && fs.existsSync(d)).flatMap((d) => ['--add-dir', d]),
    '--add-dir',
    outputDir(repo),
    ...(model ? ['--model', model] : []),
    ...(resume ? ['--resume', resume] : []),
  ];
  const id = ++chatSeq;
  const proc = spawn(exe, args, { cwd: repo, windowsHide: true, shell: exe.endsWith('.cmd'), env: cleanEnv() });
  // Claude Code 에 보내는 제어 요청 (질문이 아니라 토큰을 쓰지 않음): 사용량·컨텍스트 조회
  let ctrlSeq = 0;
  const ctrl = (subtype) => {
    try {
      proc.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: `cf-${subtype}-${++ctrlSeq}`, request: { subtype } })}\n`);
    } catch {}
  };
  const refreshUsage = () => {
    ctrl('get_usage');
    ctrl('get_context_usage');
  };
  chats.set(id, { proc, repo, sessionKey, cfgFile, refreshUsage });
  let buf = '';
  let errText = '';
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        send('ai:event', id, { type: 'raw', text: line });
        continue;
      }
      // 미리 깨우기: initialize 응답이 오면 준비 완료 (질문하면 바로 답할 수 있는 상태)
      if (j.type === 'control_response' && j.response?.request_id === 'cf-ready') {
        send('ai:event', id, { type: 'cf', kind: 'ready', models: j.response?.response?.models || null });
        chats.get(id)?.refreshUsage(); // 준비되면 바로 사용량·컨텍스트를 알려 준다
        continue;
      }
      if (j.type === 'control_response' && /^cf-get_usage-/.test(j.response?.request_id || '')) {
        const rl = j.response?.response?.rate_limits;
        if (rl) send('ai:event', id, { type: 'cf', kind: 'usage_claude', windows: { five_hour: rl.five_hour, seven_day: rl.seven_day } });
        continue;
      }
      if (j.type === 'control_response' && /^cf-get_context_usage-/.test(j.response?.request_id || '')) {
        const r = j.response?.response;
        if (r?.maxTokens) send('ai:event', id, { type: 'cf', kind: 'ctx', used: r.totalTokens || 0, window: r.maxTokens });
        continue;
      }
      if (j.type === 'control_response') continue;
      // 답이 끝날 때마다 사용량·컨텍스트를 새로 (정확한 값)
      if (j.type === 'result') setTimeout(() => chats.get(id)?.refreshUsage(), 300);
      send('ai:event', id, j);
    }
  });
  proc.stderr.on('data', (d) => (errText = (errText + d).slice(-4000)));
  proc.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'cf-ready', request: { subtype: 'initialize' } })}\n`);
  proc.on('error', (e) => send('ai:event', id, { type: 'exit', code: -1, stderr: e.message }));
  proc.on('exit', (code) => {
    const c = chats.get(id);
    if (c) {
      tools.unregisterSession(c.sessionKey);
      fs.rm(c.cfgFile, { force: true }, () => {});
      if (extraPrompt) fs.rm(promptFile, { force: true }, () => {});
    }
    chats.delete(id);
    send('ai:event', id, { type: 'exit', code, stderr: stripAnsi(errText) });
  });
  return { id };
}

// ---------- 첨부 파일 ----------
// 이미지(png/jpg/gif/webp/bmp)·PDF 는 내용을 그대로 AI 에게 보내고, 그 밖의 파일은 경로를 알려 주어 AI 가 직접 읽게 한다
const IMAGE_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
function readAttachment(file) {
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error('파일이 아닙니다.');
  const ext = path.extname(file).toLowerCase();
  const name = path.basename(file);
  if (IMAGE_EXT[ext]) {
    if (st.size > 30 * 1024 * 1024) throw new Error(`'${name}' 이미지가 너무 큽니다 (30MB 초과).`);
    return { kind: 'image', name, path: file, size: st.size, mime: IMAGE_EXT[ext], data: fs.readFileSync(file).toString('base64') };
  }
  if (ext === '.pdf') {
    if (st.size > 30 * 1024 * 1024) throw new Error(`'${name}' PDF 가 너무 큽니다 (30MB 초과). 경로로 첨부합니다.`);
    return { kind: 'pdf', name, path: file, size: st.size, mime: 'application/pdf', data: fs.readFileSync(file).toString('base64') };
  }
  return { kind: 'file', name, path: file, size: st.size };
}

// ---------- 지난 대화 (Claude Code 가 ~/.claude/projects/<폴더>/<세션>.jsonl 에 저장) ----------

const projectLogDir = (repo) => path.join(os.homedir(), '.claude', 'projects', repo.replace(/[^A-Za-z0-9]/g, '-'));

function userText(j) {
  if (j.type !== 'user' || j.isMeta || j.isSidechain) return null;
  const c = j.message?.content;
  const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
  if (!t || /^<(command|local-command|system-reminder)/.test(t.trim())) return null;
  const att = Array.isArray(c) ? c.filter((b) => b.type === 'image' || b.type === 'document').length : 0;
  return att ? `📎 첨부 ${att}개\n${t}` : t;
}

async function sessions(repo) {
  const dir = projectLogDir(repo);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }));
  } catch {
    return [];
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out = [];
  for (const { f, mtime } of files.slice(0, 40)) {
    let title = null;
    let count = 0;
    try {
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
      for (const l of lines) {
        if (!l.trim()) continue;
        let j;
        try {
          j = JSON.parse(l);
        } catch {
          continue;
        }
        const t = userText(j);
        if (t) {
          count++;
          if (!title) title = t.replace(/\s+/g, ' ').slice(0, 80);
        }
      }
    } catch {}
    if (title) out.push({ id: f.replace(/\.jsonl$/, ''), title, updated: mtime, count });
  }
  return out;
}

// 지난 대화 내용을 화면에 다시 그릴 수 있는 모양으로 (최근 300개)
function transcript(repo, id) {
  const file = path.join(projectLogDir(repo), `${id.replace(/[^\w-]/g, '')}.jsonl`);
  const items = [];
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let j;
    try {
      j = JSON.parse(l);
    } catch {
      continue;
    }
    if (j.isSidechain) continue;
    const t = userText(j);
    if (t) items.push({ role: 'user', text: t });
    else if (j.type === 'assistant' && Array.isArray(j.message?.content)) {
      const blocks = j.message.content.filter((b) => b.type === 'text' || b.type === 'tool_use').map((b) => (b.type === 'text' ? { type: 'text', text: b.text } : { type: 'tool_use', id: b.id, name: b.name, input: b.input }));
      if (blocks.length) items.push({ role: 'assistant', id: j.message.id, blocks });
    } else if (j.type === 'user' && Array.isArray(j.message?.content)) {
      for (const b of j.message.content) if (b.type === 'tool_result') items.push({ role: 'tool_result', id: b.tool_use_id, error: !!b.is_error });
    }
  }
  return items.slice(-300);
}

function sendChat(id, textOrContent) {
  const c = chats.get(id);
  if (!c) throw new Error('대화가 끝났습니다. 다시 보내 주세요.');
  if (c.codex) return c.codex.sendTurn(textOrContent);
  c.proc.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: textOrContent } })}\n`);
}

// 사용량·컨텍스트 다시 조회 (탭을 바꿨을 때 등)
function refreshUsage(id) {
  const c = chats.get(id);
  if (c?.codex) return c.codex.refreshUsage();
  c?.refreshUsage?.();
}

// 하던 답만 중단 (대화는 유지): Claude Code 는 interrupt 제어 요청, Codex 는 turn/interrupt
function interruptChat(id) {
  const c = chats.get(id);
  if (!c) return;
  if (c.codex) return c.codex.interrupt();
  try {
    c.proc.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: `cf-interrupt-${Date.now()}`, request: { subtype: 'interrupt' } })}\n`);
  } catch {}
}

function stopChat(id) {
  const c = chats.get(id);
  if (!c) return;
  if (c.codex) return c.codex.stop();
  try {
    c.proc.kill();
  } catch {}
}

function stopAll() {
  for (const id of chats.keys()) stopChat(id);
  cancelLogin();
  tools.stopServer();
}

// AI 별 MCP 서버 · 커넥터 목록 (대화를 시작하지 않아도)
// Claude: 'claude mcp list' 로 연결 상태까지 확인 (몇 초 걸림), Codex: 설정 목록
async function mcpList(id) {
  if (id === 'codex') return codex.mcpList();
  const exe = findExe(id);
  if (!exe) return [];
  const r = await run(exe, ['mcp', 'list'], 90000);
  const out = [];
  for (const line of stripAnsi(r.stdout + r.stderr).split(/\r?\n/)) {
    const m = line.match(/^(.+?): .* - (.+)$/);
    if (!m) continue;
    const st = /connected/i.test(m[2]) ? 'connected' : /auth/i.test(m[2]) ? 'needs-auth' : /fail|error/i.test(m[2]) ? 'failed' : 'pending';
    out.push({ name: m[1].trim(), status: st, source: m[1].startsWith('claude.ai ') ? 'claudeai' : 'user' });
  }
  return out;
}

module.exports = { refreshUsage, outputDir, mcpList, readAttachment, sessions, transcript, PROVIDERS, status, install, login, loginInput, cancelLogin, logout, startChat, sendChat, interruptChat, stopChat, stopAll };
