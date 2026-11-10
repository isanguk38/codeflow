// Git 실행 파일 찾기: PC 마다 설치 방식이 달라도 알아서 찾아 PATH 에 넣는다 (git.js 가 사용)
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// spawn 은 .exe 만 실행한다 (git.cmd 는 있어도 못 씀)
const hasGit = (d) => !!d && fs.existsSync(path.join(d, 'git.exe'));
let gitCacheFile = null; // 디스크를 뒤져 찾은 위치를 기억해 두는 파일

function regValue(key, name) {
  const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  try {
    const out = execFileSync(reg, ['query', key, ...(name ? ['/v', name] : ['/ve'])], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.match(/REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m)?.[1].replace(/%([^%]+)%/g, (m, k) => process.env[k] || m) || null;
  } catch {
    return null;
  }
}

// 설치 폴더(git-bash.exe 가 있는 곳) → git.exe 가 있는 폴더
const gitDirsIn = (root) => (root ? [path.join(root, 'cmd'), path.join(root, 'bin'), path.join(root, 'mingw64', 'bin')] : []);
const subdirs = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => path.join(dir, x.name));
  } catch {
    return [];
  }
};

// 빠른 곳부터: 저장해 둔 위치 → 흔한 설치 위치 → 다른 Git 도구에 들어 있는 Git → 레지스트리
function quickGitDir() {
  const e = process.env;
  const la = e.LOCALAPPDATA;
  const cached = () => {
    try {
      return gitCacheFile ? fs.readFileSync(gitCacheFile, 'utf8').trim() : '';
    } catch {
      return '';
    }
  };
  const fixed = [
    cached(),
    ...[e.ProgramW6432, e.ProgramFiles, e['ProgramFiles(x86)']].flatMap((p) => (p ? gitDirsIn(path.join(p, 'Git')) : [])),
    ...(la ? gitDirsIn(path.join(la, 'Programs', 'Git')) : []),
    e.USERPROFILE && path.join(e.USERPROFILE, 'scoop', 'apps', 'git', 'current', 'cmd'),
    e.ProgramData && path.join(e.ProgramData, 'scoop', 'apps', 'git', 'current', 'cmd'),
    e.ProgramData && path.join(e.ProgramData, 'chocolatey', 'bin'),
    la && path.join(la, 'Atlassian', 'SourceTree', 'git_local', 'bin'),
    // MSYS2: Windows 용 git 을 먼저, 그다음 MSYS 용 git
    ...['C:\\msys64', 'D:\\msys64', 'E:\\msys64', 'C:\\msys2', 'C:\\tools\\msys64'].flatMap((r) => ['ucrt64', 'mingw64', 'clang64', 'usr'].map((x) => path.join(r, x, 'bin'))),
  ].find(hasGit);
  if (fixed) return fixed;
  // GitHub Desktop, Fork (버전마다 폴더 이름이 다르다)
  const bundled = la
    ? [
        ...subdirs(path.join(la, 'GitHubDesktop')).map((d) => path.join(d, 'resources', 'app', 'git', 'cmd')),
        ...subdirs(path.join(la, 'Fork', 'gitInstance')).map((d) => path.join(d, 'bin')),
      ].find(hasGit)
    : null;
  if (bundled) return bundled;
  // 설치 프로그램이 남긴 위치 (다른 드라이브, 다른 폴더에 설치한 경우)
  const roots = [
    ...['HKLM\\SOFTWARE\\GitForWindows', 'HKCU\\SOFTWARE\\GitForWindows', 'HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows'].map((k) => regValue(k, 'InstallPath')),
    ...['HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Git_is1', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Git_is1', 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Git_is1'].map((k) => regValue(k, 'InstallLocation')),
    // 탐색기 오른쪽 클릭의 'Git Bash Here'
    regValue('HKCR\\Directory\\Background\\shell\\git_bash\\command')?.match(/"?([^"]*?)[\\/]git-bash\.exe/i)?.[1],
  ];
  // 앱을 켠 뒤에 바뀐 PATH (Windows 에 저장된 값을 새로 읽는다)
  const saved = [regValue('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'Path'), regValue('HKCU\\Environment', 'Path')]
    .filter(Boolean)
    .flatMap((p) => p.split(path.delimiter))
    .map((d) => d.replace(/"/g, ''));
  return [...roots.flatMap(gitDirsIn), ...saved].find(hasGit) || null;
}

// PATH 맨 뒤에 붙인다: usr/bin 같은 폴더가 앞에 오면 터미널의 find·sort 등 Windows 명령을 가린다
function addGitDir(dir) {
  process.env.PATH = [...(process.env.PATH || '').split(path.delimiter).filter(Boolean), dir].join(path.delimiter);
}

function ensureGitPath() {
  if (process.platform !== 'win32') return true;
  if ((process.env.PATH || '').split(path.delimiter).some((d) => hasGit(d.replace(/"/g, '')))) return true;
  const dir = quickGitDir();
  if (dir) addGitDir(dir);
  return !!dir;
}

// 어디에도 없으면 드라이브를 얕게 뒤진다 (압축만 풀어 둔 포터블 Git 등). 앱을 멈추지 않게 비동기로, 시간을 정해 둔다
const SCAN_SKIP = new Set(['windows', '$recycle.bin', 'system volume information', 'node_modules', 'programdata', 'appdata', '.git', 'recovery', 'perflogs']);
async function scanForGit({ roots, maxDepth = 4, ms = 8000 } = {}) {
  const until = Date.now() + ms;
  const exists = (p) => fs.promises.access(p).then(() => true, () => false);
  if (!roots) {
    roots = [];
    for (const c of 'CDEFGH') if (await Promise.race([exists(`${c}:\\`), new Promise((r) => setTimeout(() => r(false), 500))])) roots.push(`${c}:\\`);
    if (process.env.USERPROFILE) roots.unshift(process.env.USERPROFILE);
  }
  let level = roots;
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const next = [];
    for (const dir of level) {
      if (Date.now() > until) return null;
      for (const d of gitDirsIn(dir)) if (await exists(path.join(d, 'git.exe'))) return d;
      const list = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const x of list) if (x.isDirectory() && !SCAN_SKIP.has(x.name.toLowerCase())) next.push(path.join(dir, x.name));
    }
    level = next;
  }
  return null;
}

let lastScan = 0;
async function ensureGitFound() {
  if (ensureGitPath() || Date.now() - lastScan < 60000) return;
  lastScan = Date.now();
  const dir = await scanForGit();
  if (!dir) return;
  addGitDir(dir);
  try {
    if (gitCacheFile) fs.writeFileSync(gitCacheFile, dir, 'utf8');
  } catch {}
}

function setGitCacheFile(file) {
  gitCacheFile = file;
  ensureGitPath();
}
ensureGitPath();

module.exports = { ensureGitFound, setGitCacheFile, scanForGit };
