// 앱 업데이트: GitHub 최신 릴리즈 확인 → 설치 파일 내려받기 → 실행 후 앱 종료 (ERD 앱과 같은 방식)
const { app, net, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { once } = require('events');

const REPO = 'isanguk38/codeflow';
// 이 저장소의 릴리즈 설치 파일만 받는다
const SETUP_URL = /^https:\/\/github\.com\/isanguk38\/codeflow\/releases\/download\/v[\d.]+\/CodeFlow-Setup-[\d.]+\.exe$/;

// 포터블 exe 로 실행 중이면 electron-builder 가 이 환경변수를 넣어 준다
const isPortable = () => !!process.env.PORTABLE_EXECUTABLE_FILE;

function newer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// 주소가 어디로 이동하는지(Location)만 알아낸다. 실제로 따라가지는 않는다
function redirectTarget(url) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, redirect: 'manual' });
    const timer = setTimeout(() => (req.abort(), reject(new Error('시간 초과'))), 15000);
    req.on('redirect', (_status, _method, to) => {
      clearTimeout(timer);
      resolve(to);
      req.abort();
    });
    req.on('response', (res) => {
      clearTimeout(timer);
      resolve(String(res.headers.location || ''));
      res.on('data', () => {});
    });
    req.on('error', (e) => (clearTimeout(timer), reject(e)));
    req.end();
  });
}

async function fetchLatest() {
  // 1) GitHub API (시간당 60회 제한이 있어 실패하면 2번으로)
  try {
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'codeflow' } });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const r = await res.json();
    const version = String(r.tag_name).replace(/^v/i, '');
    const setup = (r.assets || []).find((a) => /^CodeFlow-Setup-[\d.]+\.exe$/.test(a.name));
    return { version, notes: r.body || '', page: r.html_url, url: setup?.browser_download_url || null, date: r.published_at };
  } catch (apiError) {
    // 2) 일반 웹 주소: /releases/latest 는 최신 태그 주소로 이동한다 → 이동할 주소만 읽는다
    //    (net.fetch 의 redirect: 'manual' 은 Electron 에서 'Redirect was cancelled' 오류가 나므로 net.request 의 redirect 이벤트를 쓴다)
    const location = await redirectTarget(`https://github.com/${REPO}/releases/latest`).catch(() => '');
    const tag = /\/releases\/tag\/([^/?#]+)$/.exec(location)?.[1];
    if (!tag) throw new Error(`최신 버전을 확인하지 못했습니다 (${apiError.message})`);
    const version = decodeURIComponent(tag).replace(/^v/i, '');
    return {
      version,
      notes: '',
      page: `https://github.com/${REPO}/releases/tag/${tag}`,
      url: `https://github.com/${REPO}/releases/download/${tag}/CodeFlow-Setup-${version}.exe`,
    };
  }
}

async function check() {
  const current = app.getVersion();
  const latest = await fetchLatest();
  return { current, latest, available: newer(latest.version, current), packaged: app.isPackaged, portable: isPortable() };
}

// 설치 파일을 내려받아 실행하고 앱을 끈다 (설치 프로그램이 이 앱을 새 버전으로 바꾼다)
async function install(url) {
  if (typeof url !== 'string' || !SETUP_URL.test(url)) throw new Error('허용되지 않은 설치 파일 주소입니다');
  const res = await net.fetch(url);
  if (!res.ok || !res.body) throw new Error(`설치 파일을 내려받지 못했습니다 (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const file = path.join(app.getPath('temp'), path.basename(new URL(url).pathname));
  const out = fs.createWriteStream(file);
  const progress = (p) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('update:progress', p));
  let received = 0;
  let last = -2;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!out.write(value)) await once(out, 'drain');
      const p = total ? Math.floor((received / total) * 100) : -1;
      if (p !== last) progress((last = p));
    }
  } finally {
    out.end();
    await once(out, 'close');
  }
  if (total && received !== total) throw new Error('설치 파일을 끝까지 받지 못했습니다. 다시 시도하세요.');
  spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => app.quit(), 1000);
  return true;
}

module.exports = { check, install };
