// Python 인터프리터 찾기: 프로젝트 가상환경(.venv, venv, env) → py 런처에 등록된 Python → PATH 의 python
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const run = (cmd, args) =>
  new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 5000 }, (err, stdout, stderr) => resolve(err ? '' : `${stdout}${stderr}`)));

async function version(exe) {
  const out = await run(exe, ['--version']);
  const m = out.match(/Python (\d+\.\d+(\.\d+)?)/);
  return m ? m[1] : null;
}

async function interpreters(root) {
  const found = [];
  const seen = new Set();
  const add = async (exe, source) => {
    if (!exe || !fs.existsSync(exe)) return;
    const key = path.normalize(exe).toLowerCase();
    // Microsoft Store 설치 유도용 가짜 python.exe 는 제외
    if (seen.has(key) || key.includes('\\windowsapps\\')) return;
    seen.add(key);
    const v = await version(exe);
    if (v) found.push({ path: exe, version: v, source });
  };
  for (const dir of ['.venv', 'venv', 'env', '.env']) await add(path.join(root, dir, 'Scripts', 'python.exe'), `가상환경 (${dir})`);
  const py = await run('py', ['-0p']);
  for (const line of py.split(/\r?\n/)) {
    const m = line.match(/\s(\S:\\.*python\.exe)\s*$/i);
    if (m) await add(m[1].trim(), '시스템');
  }
  const where = await run('where', ['python']);
  for (const line of where.split(/\r?\n/)) await add(line.trim(), '시스템 (PATH)');
  return found;
}

module.exports = { interpreters };
