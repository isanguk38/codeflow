// 코드 화면 터미널: 내 PC 의 셸(PowerShell / 명령 프롬프트 / Git Bash)을 의사 터미널(ConPTY)로 실행하고 화면과 입출력을 중계한다.
const fs = require('fs');
const path = require('path');

let pty = null;
function loadPty() {
  if (!pty) pty = require('@lydell/node-pty');
  return pty;
}

// 사용할 수 있는 셸 목록
function shells() {
  const list = [];
  const sys = process.env.SystemRoot || 'C:\\Windows';
  const pwsh = (process.env.PATH || '')
    .split(';')
    .map((d) => path.join(d, 'pwsh.exe'))
    .find((p) => fs.existsSync(p));
  if (pwsh) list.push({ id: 'pwsh', name: 'PowerShell 7', path: pwsh, args: ['-NoLogo'] });
  list.push({ id: 'powershell', name: 'PowerShell', path: path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'] });
  list.push({ id: 'cmd', name: '명령 프롬프트 (cmd)', path: path.join(sys, 'System32', 'cmd.exe'), args: [] });
  const gitBash = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]
    .filter(Boolean)
    .map((d) => path.join(d, 'Git', 'bin', 'bash.exe'))
    .find((p) => fs.existsSync(p));
  if (gitBash) list.push({ id: 'gitbash', name: 'Git Bash', path: gitBash, args: ['--login', '-i'] });
  return list;
}

const terms = new Map(); // id → pty
let seq = 0;

function create({ shellId, cwd, cols, rows }, send) {
  const sh = shells().find((s) => s.id === shellId) || shells().find((s) => s.id === 'powershell');
  const id = ++seq;
  const p = loadPty().spawn(sh.path, sh.args, {
    name: 'xterm-256color',
    cols: Math.max(2, cols || 80),
    rows: Math.max(2, rows || 24),
    cwd: cwd && fs.existsSync(cwd) ? cwd : process.env.USERPROFILE,
    env: { ...process.env, TERM_PROGRAM: 'CodeFlow' },
    useConpty: true,
  });
  // 출력을 잠깐 모아서 보낸다 (빌드 로그처럼 출력이 많을 때 화면이 버벅이지 않게)
  let buf = '';
  let timer = null;
  p.onData((d) => {
    buf += d;
    if (!timer)
      timer = setTimeout(() => {
        send('term:data', id, buf);
        buf = '';
        timer = null;
      }, 8);
  });
  p.onExit(({ exitCode }) => {
    if (buf) send('term:data', id, buf);
    terms.delete(id);
    send('term:exit', id, exitCode);
  });
  terms.set(id, p);
  return { id, shell: { id: sh.id, name: sh.name } };
}

const write = (id, data) => terms.get(id)?.write(data);

function resize(id, cols, rows) {
  try {
    terms.get(id)?.resize(Math.max(2, cols), Math.max(2, rows));
  } catch {}
}

function kill(id) {
  try {
    terms.get(id)?.kill();
  } catch {}
  terms.delete(id);
}

function killAll() {
  for (const id of [...terms.keys()]) kill(id);
}

module.exports = { shells, create, write, resize, kill, killAll };
