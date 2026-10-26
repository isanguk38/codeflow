// OpenAI Codex 연결: 설치(공식 npm 패키지의 Windows 실행 파일), 로그인(ChatGPT 계정), 대화(codex app-server)
// - 대화는 VS Code 의 Codex 확장과 같은 'app-server' 프로토콜(JSON-RPC, 한 줄에 한 메시지)을 쓴다
// - Codex 의 이벤트를 CodeFlow 화면이 쓰는 공통 이벤트({ type: 'cf', kind, ... })로 바꿔서 보낸다
// - 명령 실행 / 파일 수정 승인 요청은 Claude 와 같은 CodeFlow '허용 / 거부' 카드로 묻는다
const { app, net } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');
const tools = require('./ai-tools');

const PKG = 'https://registry.npmjs.org/@openai/codex';
const TARGET = 'x86_64-pc-windows-msvc';
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const installDir = () => path.join(app.getPath('userData'), 'ai-tools', 'codex');
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

// ---------- 찾기 ----------
// 버전별 폴더에 설치: ai-tools/codex/<버전>/package/vendor/...  + current.json { version, previous }
// (예전 0.7.0~0.7.2 는 ai-tools/codex/package 에 바로 풀었음 → 'legacy' 로 취급)

const stateFile = () => path.join(installDir(), 'current.json');
function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
}
const versionDir = (v) => (v === 'legacy' ? installDir() : path.join(installDir(), v));
const vendorOf = (v) => path.join(versionDir(v), 'package', 'vendor', TARGET);

function versionOfDir(v) {
  try {
    return JSON.parse(fs.readFileSync(path.join(vendorOf(v), 'codex-package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

// 지금 쓰는 버전 (current.json 이 없으면 예전 위치)
function currentVersion() {
  const st = readState();
  if (st.version && fs.existsSync(vendorOf(st.version))) return st.version;
  if (fs.existsSync(vendorOf('legacy'))) return 'legacy';
  return null;
}

function vendorDirs() {
  const dirs = [];
  const v = currentVersion();
  if (v) dirs.push(vendorOf(v));
  // npm 으로 직접 설치한 경우
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', TARGET));
  return dirs;
}

function findExe() {
  for (const d of vendorDirs()) {
    for (const rel of [path.join('bin', 'codex.exe'), path.join('codex', 'codex.exe')]) if (fs.existsSync(path.join(d, rel))) return { exe: path.join(d, rel), vendor: d };
  }
  for (const d of (process.env.PATH || '').split(';').filter(Boolean)) if (fs.existsSync(path.join(d, 'codex.exe'))) return { exe: path.join(d, 'codex.exe'), vendor: null };
  return null;
}

// codex 가 쓰는 보조 프로그램(rg 등) 경로를 PATH 에 추가
function envFor(found) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (found?.vendor) {
    const extra = [path.join(found.vendor, 'codex-path')].filter((d) => fs.existsSync(d));
    if (extra.length) env.PATH = `${extra.join(';')};${env.PATH || ''}`;
  }
  return env;
}

function run(found, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(found.exe, args, { timeout, windowsHide: true, env: envFor(found), maxBuffer: 1 << 22 }, (err, stdout, stderr) =>
      resolve({ ok: !err, code: err?.code ?? 0, out: stripAnsi(`${stdout || ''}${stderr || ''}`) })
    );
  });
}

async function status() {
  const found = findExe();
  if (!found) return { id: 'codex', installed: false };
  const v = await run(found, ['--version']);
  const s = await run(found, ['login', 'status']);
  const loggedIn = s.ok && /logged in/i.test(s.out) && !/not logged in/i.test(s.out);
  return { id: 'codex', installed: true, exe: found.exe, version: (v.out.match(/[\d.]+/) || [])[0] || null, loggedIn, authMethod: loggedIn ? (/chatgpt/i.test(s.out) ? 'chatgpt' : 'api-key') : null };
}

// ---------- 설치: npm 레지스트리에서 Windows 용 패키지를 받아 사용자 폴더에 풀기 (Node.js 불필요) ----------

let installing = null;
let latestCache = null; // { version, at }

async function latestVersion(force = false) {
  if (!force && latestCache && Date.now() - latestCache.at < 6 * 3600e3) return latestCache.version;
  const meta = await (await net.fetch(`${PKG}/latest`)).json();
  latestCache = { version: meta.version, at: Date.now() };
  return meta.version;
}

// 업데이트 정보: 지금 버전, 최신 버전, 되돌릴 수 있는 이전 버전
async function updateInfo(force = false) {
  const cur = currentVersion();
  const current = cur ? (cur === 'legacy' ? versionOfDir('legacy') : cur) : null;
  let latest = null;
  try {
    latest = await latestVersion(force);
  } catch {}
  const prev = readState().previous;
  const previous = prev && fs.existsSync(vendorOf(prev)) ? (prev === 'legacy' ? versionOfDir('legacy') : prev) : null;
  const newer = (a, b) => {
    const x = String(a).split('.').map(Number);
    const y = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
    return false;
  };
  return { managed: !!cur, current, latest, hasUpdate: !!(cur && current && latest && newer(latest, current)), previous };
}

// 지금·이전 버전 말고는 지운다 (실행 중이라 못 지우면 다음에)
function cleanupVersions() {
  const st = readState();
  const keep = new Set([st.version, st.previous].filter(Boolean));
  let entries = [];
  try {
    entries = fs.readdirSync(installDir(), { withFileTypes: true });
  } catch {}
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === 'package') {
      if (!keep.has('legacy')) fs.rm(path.join(installDir(), 'package'), { recursive: true, force: true, maxRetries: 3 }, () => {});
    } else if (/^\d+\.\d+\.\d+/.test(e.name) && !keep.has(e.name)) fs.rm(path.join(installDir(), e.name), { recursive: true, force: true, maxRetries: 3 }, () => {});
  }
}

// 설치 / 업데이트: 최신(또는 지정한) 버전을 새 폴더에 받아서 바꾸고, 쓰던 버전은 '이전 버전' 으로 남긴다
function install(onLog, wantVersion) {
  if (installing) return installing;
  installing = (async () => {
    onLog('최신 버전 확인 중...');
    const version = wantVersion || (await latestVersion(true));
    const info = await (await net.fetch(`${PKG}/${version}-win32-x64`)).json();
    const url = info?.dist?.tarball;
    if (!url) throw new Error('Windows 용 Codex 패키지를 찾지 못했습니다.');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codeflow-codex-'));
    const dest = versionDir(version);
    try {
      if (!fs.existsSync(path.join(vendorOf(version), 'bin', 'codex.exe'))) {
        const file = path.join(tmp, 'codex.tgz');
        const res = await net.fetch(url);
        if (!res.ok || !res.body) throw new Error(`내려받지 못했습니다 (HTTP ${res.status})`);
        const total = Number(res.headers.get('content-length')) || 0;
        const out = fs.createWriteStream(file);
        const reader = res.body.getReader();
        let got = 0;
        let lastPct = -1;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          got += value.length;
          if (!out.write(value)) await once(out, 'drain');
          const pct = total ? Math.floor((got / total) * 100) : -1;
          if (pct !== lastPct && pct % 5 === 0) {
            lastPct = pct;
            onLog(`Codex ${version} 내려받는 중 ${(got / 1e6).toFixed(0)}MB${total ? ` / ${(total / 1e6).toFixed(0)}MB (${pct}%)` : ''}`);
          }
        }
        out.end();
        await once(out, 'close');
        onLog('압축 푸는 중...');
        fs.rmSync(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        fs.mkdirSync(dest, { recursive: true });
        await new Promise((resolve, reject) => execFile(TAR, ['-xzf', file, '-C', dest], { windowsHide: true, maxBuffer: 1 << 24 }, (err, _o, se) => (err ? reject(new Error(`압축을 풀지 못했습니다: ${se || err.message}`)) : resolve())));
      }
      const prev = currentVersion();
      fs.mkdirSync(installDir(), { recursive: true });
      fs.writeFileSync(stateFile(), JSON.stringify({ version, previous: prev && prev !== version ? prev : readState().previous || null }));
      cleanupVersions();
      onLog('설치 완료');
    } finally {
      fs.rm(tmp, { recursive: true, force: true }, () => {});
    }
    const s = await status();
    if (!s.installed) throw new Error('설치했지만 실행 파일을 찾지 못했습니다.');
    return s;
  })().finally(() => (installing = null));
  return installing;
}

// 이전 버전으로 되돌리기 (지금 버전과 자리를 바꿈 → 다시 '되돌리기' 하면 원래대로)
async function rollback() {
  const st = readState();
  const cur = currentVersion();
  if (!st.previous || !fs.existsSync(vendorOf(st.previous))) throw new Error('되돌릴 이전 버전이 없습니다.');
  fs.writeFileSync(stateFile(), JSON.stringify({ version: st.previous, previous: cur }));
  return status();
}

// ---------- 로그인 / 로그아웃 ----------

let loginProc = null;
function login(onLog) {
  const found = findExe();
  if (!found) return Promise.reject(new Error('먼저 설치하세요.'));
  cancelLogin();
  return new Promise((resolve) => {
    const pty = require('@lydell/node-pty');
    const p = pty.spawn(found.exe, ['login'], { name: 'xterm-256color', cols: 200, rows: 30, cwd: os.homedir(), env: envFor(found), useConpty: true });
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
      resolve({ exitCode, status: await status() });
    });
  });
}
const loginInput = (t) => loginProc?.write(t);
function cancelLogin() {
  try {
    loginProc?.kill();
  } catch {}
  loginProc = null;
}
async function logout() {
  const found = findExe();
  if (found) await run(found, ['logout']);
  return status();
}

// ---------- 대화 (app-server) ----------

class CodexChat {
  constructor(id, repo, send) {
    this.id = id;
    this.repo = repo;
    this.send = send; // (ev) → 화면
    this.seq = 0;
    this.pending = new Map();
    this.items = new Map(); // itemId → item (파일 변경 승인 때 경로를 알려고)
    this.mcp = new Map();
    this.tmpFiles = [];
  }

  emit(ev) {
    this.send({ type: 'cf', ...ev });
  }

  request(method, params) {
    const id = ++this.seq;
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  reply(id, result) {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  async start({ resume, model, addDirs = [], guide, team }) {
    this.team = team || null; // 팀 채팅방의 에이전트면 { teamId, memberId, pm }
    const found = findExe();
    if (!found) throw new Error('Codex 가 설치되어 있지 않습니다.');
    this.proc = spawn(found.exe, ['app-server'], { cwd: this.repo, windowsHide: true, env: envFor(found) });
    let buf = '';
    let errText = '';
    this.proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        this.onMessage(m).catch((e) => console.error('[codex]', e));
      }
    });
    this.proc.stderr.on('data', (d) => (errText = (errText + stripAnsi(d)).slice(-4000)));
    this.proc.on('exit', (code) => {
      for (const p of this.pending.values()) p.reject(new Error('Codex 가 종료되었습니다.'));
      this.pending.clear();
      tools.unregisterSession(this.sessionKey);
      for (const f of this.tmpFiles) fs.rm(f, { force: true }, () => {});
      this.send({ type: 'exit', code, stderr: /error/i.test(errText) ? errText.split('\n').filter((l) => /error/i.test(l)).slice(-3).join('\n') : '' });
    });
    await this.request('initialize', { clientInfo: { name: 'codeflow', title: 'CodeFlow', version: app.getVersion() }, capabilities: null });
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);

    // 쓸 수 있는 모델 (계정 플랜마다 다름)
    const ml = await this.request('model/list', {}).catch(() => null);
    const models = (ml?.data || []).map((m) => ({ id: m.id || m.model, name: m.displayName || m.id, isDefault: !!m.isDefault }));
    if (models.length) this.emit({ kind: 'models', models });
    const useModel = model && models.some((m) => m.id === model) ? model : models.find((m) => m.isDefault)?.id || null;

    // CodeFlow 도구 서버(MCP) 연결
    this.sessionKey = tools.registerSession(this.repo, this.team ? { team: this.team } : {});
    const mcp = (await tools.mcpConfig(this.sessionKey)).mcpServers.codeflow;
    const common = {
      cwd: this.repo,
      model: useModel,
      // 신뢰된 읽기 명령 외에는 실행 전에 묻고, 파일 쓰기는 프로젝트 폴더(+열린 탭 폴더) 안으로 제한
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      config: {
        mcp_servers: { codeflow: { url: mcp.url, http_headers: mcp.headers } },
        ...(addDirs.length ? { sandbox_workspace_write: { writable_roots: addDirs } } : {}),
      },
      developerInstructions: guide,
    };
    let r;
    if (resume) r = await this.request('thread/resume', { threadId: resume, ...common }).catch(() => null);
    if (!r) r = await this.request('thread/start', common);
    this.threadId = r.thread.id;
    this.emit({ kind: 'init', sessionId: this.threadId, model: r.model || useModel, resumed: !!resume && r.thread.id === resume });
    this.emit({ kind: 'ready' });
    this.refreshUsage();
  }

  // CodeFlow 대화 내용(텍스트 + 첨부)을 Codex 입력으로
  toInput(content) {
    if (typeof content === 'string') return [{ type: 'text', text: content, text_elements: [] }];
    const input = [];
    const extra = [];
    for (const b of content) {
      if (b.type === 'text') input.push({ type: 'text', text: b.text, text_elements: [] });
      else if (b.type === 'image' || b.type === 'document') {
        // 첨부를 임시 파일로 저장해서 경로로 넘긴다
        const ext = b.type === 'document' ? '.pdf' : `.${(b.source.media_type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
        const f = path.join(app.getPath('temp'), `codeflow-attach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
        fs.writeFileSync(f, Buffer.from(b.source.data, 'base64'));
        this.tmpFiles.push(f);
        if (b.type === 'image') input.push({ type: 'localImage', path: f });
        else extra.push(f);
      }
    }
    if (extra.length) input.push({ type: 'text', text: `[첨부 PDF — 파일을 읽어 확인하세요]\n${extra.join('\n')}`, text_elements: [] });
    return input;
  }

  async sendTurn(content) {
    const r = await this.request('turn/start', { threadId: this.threadId, input: this.toInput(content) });
    this.turnId = r?.turn?.id;
  }

  // 플랜 사용량 조회 (질문 없이)
  async refreshUsage() {
    const r = await this.request('account/rateLimits/read', {}).catch(() => null);
    const rl = r?.rateLimits;
    if (!rl) return;
    const w = (x) => (x ? { utilization: (x.usedPercent || 0) / 100, resetsAt: x.resetsAt, mins: x.windowDurationMins } : null);
    this.emit({ kind: 'rate', windows: { primary: w(rl.primary), secondary: w(rl.secondary) }, plan: rl.planType });
  }

  async interrupt() {
    if (this.threadId && this.turnId) await this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
  }

  // Codex 의 항목(item)을 화면의 도구 표시로
  toolOf(item) {
    switch (item.type) {
      case 'commandExecution':
        return { name: 'Bash', input: { command: cleanCommand(item.command) } };
      case 'fileChange': {
        const ch = item.changes || [];
        const first = ch[0] || {};
        return { name: first.kind?.type === 'add' ? 'Write' : 'Edit', input: { file_path: first.path, files: ch.map((c) => c.path) } };
      }
      case 'mcpToolCall':
        return { name: `mcp__${item.server}__${item.tool}`, input: item.arguments || {} };
      case 'webSearch':
        return { name: 'WebSearch', input: { query: item.query } };
      case 'imageView':
        return { name: 'Read', input: { file_path: item.path } };
      default:
        return null;
    }
  }

  async onMessage(m) {
    // 응답
    if (m.id !== undefined && !m.method) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      return m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
    // Codex 가 묻는 것 (승인 등)
    if (m.id !== undefined && m.method) return this.onServerRequest(m);
    const pr = m.params || {};
    switch (m.method) {
      case 'turn/started':
        this.turnId = pr.turn?.id;
        return this.emit({ kind: 'turn_start', turnId: this.turnId });
      case 'item/started': {
        const it = pr.item;
        this.items.set(it.id, it);
        if (it.type === 'agentMessage') return this.emit({ kind: 'text_start', itemId: it.id });
        if (it.type === 'reasoning') return this.emit({ kind: 'thinking' });
        const t = this.toolOf(it);
        if (t) return this.emit({ kind: 'tool_start', itemId: it.id, ...t });
        return;
      }
      case 'item/agentMessage/delta':
        return this.emit({ kind: 'text_delta', itemId: pr.itemId, delta: pr.delta });
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        return this.emit({ kind: 'thinking', delta: pr.delta?.length || 0 });
      case 'item/completed': {
        const it = pr.item;
        this.items.set(it.id, it);
        if (it.type === 'agentMessage') return this.emit({ kind: 'text_done', itemId: it.id, text: it.text });
        const t = this.toolOf(it);
        if (!t) return;
        const ok = it.status ? /^(completed|success)/i.test(it.status) && (it.exitCode == null || it.exitCode === 0) : true;
        return this.emit({ kind: 'tool_done', itemId: it.id, ...t, ok, output: (it.aggregatedOutput || it.result?.content?.map?.((c) => c.text).join('\n') || it.error?.message || '').slice(0, 4000) });
      }
      case 'thread/tokenUsage/updated': {
        const u = pr.tokenUsage || {};
        return this.emit({ kind: 'usage', used: (u.last?.inputTokens || 0) + (u.last?.outputTokens || 0), window: u.modelContextWindow || null, output: u.total?.outputTokens || 0 });
      }
      case 'account/rateLimits/updated': {
        const rl = pr.rateLimits || {};
        const w = (x) => (x ? { utilization: (x.usedPercent || 0) / 100, resetsAt: x.resetsAt, mins: x.windowDurationMins } : null);
        return this.emit({ kind: 'rate', windows: { primary: w(rl.primary), secondary: w(rl.secondary) }, plan: rl.planType });
      }
      case 'mcpServer/startupStatus/updated': {
        const st = { ready: 'connected', failed: 'failed', starting: 'pending' }[pr.status] || pr.status;
        this.mcp.set(pr.name, { name: pr.name, status: st, error: pr.error });
        return this.emit({ kind: 'mcp', servers: [...this.mcp.values()] });
      }
      case 'error':
        if (pr.willRetry) return;
        return this.emit({ kind: 'error', message: friendlyError(pr.error?.message), auth: /401|unauthori[sz]ed|expired|log ?in/i.test(pr.error?.message || '') });
      case 'turn/completed': {
        const t = pr.turn || {};
        return this.emit({ kind: 'result', ok: t.status === 'completed', interrupted: t.status === 'interrupted', error: t.error ? friendlyError(t.error.message) : null, durationMs: t.durationMs });
      }
      case 'thread/compacted':
        return this.emit({ kind: 'compacted' });
      default:
    }
  }

  async onServerRequest(m) {
    const pr = m.params || {};
    if (m.method === 'item/commandExecution/requestApproval' || m.method === 'execCommandApproval') {
      const cmd = Array.isArray(pr.command) ? pr.command.join(' ') : pr.command || '';
      const r = await tools.approve(this.repo, { tool_name: 'Bash', input: { command: cleanCommand(cmd), reason: pr.reason || undefined }, ...(this.team ? { team: this.team } : {}) });
      return this.reply(m.id, { decision: r.allow ? 'accept' : 'decline' });
    }
    if (m.method === 'item/fileChange/requestApproval' || m.method === 'applyPatchApproval') {
      const it = this.items.get(pr.itemId);
      const ch = it?.changes || Object.entries(pr.fileChanges || {}).map(([p, c]) => ({ path: p, diff: c.unified_diff || c.content || '' }));
      const first = ch[0] || {};
      const r = await tools.approve(this.repo, {
        tool_name: first.kind?.type === 'add' ? 'Write' : 'Edit',
        input: { file_path: first.path || pr.grantRoot || '', content: ch.map((c) => `${c.path}\n${c.diff || ''}`).join('\n\n').slice(0, 4000) },
        ...(this.team ? { team: this.team } : {}),
      });
      return this.reply(m.id, { decision: r.allow ? 'accept' : 'decline' });
    }
    // 그 밖의 요청(추가 권한, 질문 등)은 거절
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'CodeFlow 에서 지원하지 않는 요청입니다.' } })}\n`);
  }

  stop() {
    try {
      this.proc?.kill();
    } catch {}
  }
}

// PowerShell 로 감싼 명령을 사람이 읽기 쉽게: "powershell.exe" -Command "Get-Content a.txt" → Get-Content a.txt
function cleanCommand(cmd) {
  const m = String(cmd).match(/powershell(?:\.exe)?"?\s+(?:-NoProfile\s+)?-Command\s+"?([\s\S]*?)"?$/i);
  return (m ? m[1] : String(cmd)).trim();
}

function friendlyError(msg = '') {
  try {
    const j = JSON.parse(msg);
    msg = j?.error?.message || msg;
  } catch {}
  if (/not supported when using Codex with a ChatGPT account/i.test(msg)) return `${msg}\n→ 이 계정(플랜)에서 쓸 수 없는 모델입니다. 아래에서 다른 모델을 고르세요.`;
  return msg;
}

// 설정된 MCP 서버 (~/.codex/config.toml). 실제 연결 여부는 대화를 시작해야 알 수 있다
async function mcpList() {
  const found = findExe();
  if (!found) return [];
  const r = await run(found, ['mcp', 'list', '--json']);
  let list = [];
  try {
    list = JSON.parse(r.out.slice(r.out.indexOf('[')));
  } catch {
    return [];
  }
  return list.map((m) => ({ name: m.name, status: !m.enabled ? 'disabled' : /not.?logged/i.test(m.auth_status || '') ? 'needs-auth' : 'configured', source: 'codex' }));
}

module.exports = { updateInfo, rollback, mcpList, status, install, login, loginInput, cancelLogin, logout, CodexChat, findExe };
