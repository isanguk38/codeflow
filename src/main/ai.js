// AI 패널: 외부 AI 도구(Claude Code 등)를 내 PC 에서 실행해 연결한다.
// - 설치: 공식 설치 방식으로 사용자 폴더에 설치 (관리자 권한 불필요)
// - 로그인: 각 도구의 공식 로그인 명령 (브라우저가 열림). 로그인 정보는 도구가 직접 보관
// - 대화: 도구를 프로젝트 폴더에서 실행하고 실시간 출력(JSON)을 화면에 중계
//   CodeFlow 도구 서버(ai-tools.js)를 연결해 터미널 실행·파일 열기·화면 이동 등을 할 수 있게 한다
const { app } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tools = require('./ai-tools');

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

// ---------- 지원하는 AI ----------

const PROVIDERS = {
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
}
function cancelLogin() {
  try {
    loginProc?.kill();
  } catch {}
  loginProc = null;
}

async function logout(id) {
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

function guideFile() {
  // 앱 패키지(asar) 안의 파일은 외부 프로그램이 못 읽으므로 사용자 폴더에 복사해서 넘긴다
  const src = path.join(__dirname, 'ai-guide.md');
  const dst = path.join(app.getPath('userData'), 'ai', 'codeflow-guide.md');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const text = fs.readFileSync(src, 'utf8').replace('{{VERSION}}', app.getVersion());
  if (!fs.existsSync(dst) || fs.readFileSync(dst, 'utf8') !== text) fs.writeFileSync(dst, text);
  return dst;
}

// 승인 없이 써도 되는 CodeFlow 도구 (읽기·화면 이동만). 터미널 실행·파일 수정·명령 실행은 사용자 승인 필요
const SAFE_TOOLS = ['mcp__codeflow__read_terminal', 'mcp__codeflow__list_terminals', 'mcp__codeflow__open_file', 'mcp__codeflow__show_view', 'mcp__codeflow__git_status'];

async function startChat({ provider = 'claude', repo, resume, model }, send) {
  const exe = findExe(provider);
  if (!exe) throw new Error('AI 도구가 설치되어 있지 않습니다.');
  const sessionKey = tools.registerSession(repo);
  const cfgFile = path.join(app.getPath('userData'), 'ai', `mcp-${sessionKey}.json`);
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify(await tools.mcpConfig(sessionKey)));
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
    guideFile(),
    // 위험할 수 있는 작업(파일 수정, 명령 실행)은 CodeFlow 화면에서 허용/거부를 묻는다
    '--permission-prompt-tool',
    'mcp__codeflow__approve',
    '--allowedTools',
    SAFE_TOOLS.join(','),
    ...(model ? ['--model', model] : []),
    ...(resume ? ['--resume', resume] : []),
  ];
  const id = ++chatSeq;
  const proc = spawn(exe, args, { cwd: repo, windowsHide: true, shell: exe.endsWith('.cmd'), env: cleanEnv() });
  chats.set(id, { proc, repo, sessionKey, cfgFile });
  let buf = '';
  let errText = '';
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        send('ai:event', id, JSON.parse(line));
      } catch {
        send('ai:event', id, { type: 'raw', text: line });
      }
    }
  });
  proc.stderr.on('data', (d) => (errText = (errText + d).slice(-4000)));
  proc.on('error', (e) => send('ai:event', id, { type: 'exit', code: -1, stderr: e.message }));
  proc.on('exit', (code) => {
    const c = chats.get(id);
    if (c) {
      tools.unregisterSession(c.sessionKey);
      fs.rm(c.cfgFile, { force: true }, () => {});
    }
    chats.delete(id);
    send('ai:event', id, { type: 'exit', code, stderr: stripAnsi(errText) });
  });
  return { id };
}

function sendChat(id, textOrContent) {
  const c = chats.get(id);
  if (!c) throw new Error('대화가 끝났습니다. 다시 보내 주세요.');
  c.proc.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: textOrContent } })}\n`);
}

function stopChat(id) {
  const c = chats.get(id);
  if (!c) return;
  try {
    c.proc.kill();
  } catch {}
}

function stopAll() {
  for (const id of chats.keys()) stopChat(id);
  cancelLogin();
  tools.stopServer();
}

module.exports = { PROVIDERS, status, install, login, loginInput, cancelLogin, logout, startChat, sendChat, stopChat, stopAll };
