// 언어 서버(LSP) 관리: 내 PC 에서 언어 서버 프로세스를 띄우고, 화면(렌더러)과 JSON-RPC 메시지를 중계한다.
// TypeScript/JavaScript 는 앱에 포함된 typescript-language-server 를 Electron 내장 Node 로 실행한다.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// asar 로 묶인 앱에서는 실행 파일을 asar.unpacked 에서 찾아야 한다
const unpacked = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

function tsServerCommand() {
  const cli = unpacked(path.join(path.dirname(require.resolve('typescript-language-server/package.json')), 'lib', 'cli.mjs'));
  return { cmd: process.execPath, args: [cli, '--stdio'], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

// 프로젝트에 typescript 가 있으면 그 버전을, 없으면 앱에 포함된 typescript 를 쓴다 (VS Code 와 같은 방식)
function tsdkFor(root) {
  const local = path.join(root, 'node_modules', 'typescript', 'lib', 'tsserver.js');
  if (fs.existsSync(local)) return { path: path.dirname(local), source: 'project' };
  return { path: unpacked(path.join(path.dirname(require.resolve('typescript/package.json')), 'lib')), source: 'bundled' };
}

// Python: 앱에 포함된 Pyright (VS Code Pylance 의 무료 엔진)를 Electron 내장 Node 로 실행
function pyrightCommand() {
  const cli = unpacked(path.join(path.dirname(require.resolve('pyright/package.json')), 'langserver.index.js'));
  return { cmd: process.execPath, args: [cli, '--stdio'], env: { ELECTRON_RUN_AS_NODE: '1', VSCODE_NLS_CONFIG: JSON.stringify({ locale: 'ko' }) } };
}

// Java: 언어 팩으로 설치한 Eclipse JDT LS (Java 파일을 열 때만 시작)
const javapack = require('./javapack');

const LANGS = {
  typescript: tsServerCommand,
  python: pyrightCommand,
  java: (root) => javapack.command(root),
};

class Server {
  constructor(id, lang, root, send) {
    this.id = id;
    this.lang = lang;
    this.root = root;
    const { cmd, args, env } = LANGS[lang](root);
    this.proc = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, windowsHide: true });
    this.buf = Buffer.alloc(0);
    this.proc.stdout.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.parse(send);
    });
    this.proc.stderr.on('data', (d) => console.error(`[lsp ${lang}]`, d.toString().trim()));
    this.proc.on('exit', (code) => send('lsp:exit', id, code));
  }

  // "Content-Length: N\r\n\r\n{json}" 형식의 메시지를 잘라서 전달
  parse(send) {
    for (;;) {
      const sep = this.buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const header = this.buf.slice(0, sep).toString('ascii');
      const m = header.match(/Content-Length: *(\d+)/i);
      if (!m) {
        this.buf = this.buf.slice(sep + 4);
        continue;
      }
      const len = +m[1];
      if (this.buf.length < sep + 4 + len) return;
      const body = this.buf.slice(sep + 4, sep + 4 + len).toString('utf8');
      this.buf = this.buf.slice(sep + 4 + len);
      try {
        send('lsp:message', this.id, JSON.parse(body));
      } catch (e) {
        console.error('[lsp] bad message', e);
      }
    }
  }

  write(msg) {
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin.write(body);
  }

  stop() {
    try {
      this.proc.kill();
    } catch {}
  }
}

const servers = new Map(); // id → Server
let seq = 0;

function start(lang, root, send, opts = {}) {
  if (!LANGS[lang]) throw new Error(`지원하지 않는 언어: ${lang}`);
  for (const s of servers.values()) if (s.lang === lang && s.root.toLowerCase() === root.toLowerCase() && s.proc.exitCode === null) return { id: s.id, reused: true };
  const id = ++seq;
  const s = new Server(id, lang, root, (ch, ...a) => {
    if (ch === 'lsp:exit') servers.delete(id);
    send(ch, ...a);
  });
  servers.set(id, s);
  return {
    id,
    tsdk: lang === 'typescript' ? tsdkFor(root) : null,
    // Java: 프로젝트 검사 기준으로 쓸 JDK 목록과 pom.xml/build.gradle 정보
    java: lang === 'java' ? { runtimes: javapack.projectRuntimes(opts.preferredJdk), project: javapack.projectInfo(root) } : null,
  };
}

function sendTo(id, msg) {
  servers.get(id)?.write(msg);
}

function stop(id) {
  servers.get(id)?.stop();
  servers.delete(id);
}

function stopAll() {
  for (const s of servers.values()) s.stop();
  servers.clear();
}

module.exports = { start, sendTo, stop, stopAll };
