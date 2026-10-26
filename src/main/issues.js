// 이슈 보드 (GitHub Issues / GitLab Issues) 읽기
// - 저장소의 origin 주소로 어느 서비스인지 판단 (github.com → GitHub, 그 밖 → GitLab 인지 확인)
// - 인증: 1) 사용자가 CodeFlow 에 넣은 개인 액세스 토큰(암호화 저장)  2) Git 이 저장해 둔 로그인 정보(Git Credential Manager)
//         3) 없으면 공개 저장소만
const { app, net, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const git = require('./git');

// ---------- 저장소 → 이슈 서비스 ----------

function parseRemote(url) {
  // https://host/a/b.git, git@host:a/b.git, ssh://git@host:2222/a/b.git
  let m = url.match(/^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i);
  if (m) return { host: m[1].toLowerCase(), path: m[2], scheme: url.startsWith('http://') ? 'http' : 'https' };
  m = url.match(/^(?:ssh:\/\/)?[^@]+@([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i);
  if (m) return { host: m[1].toLowerCase(), path: m[2].replace(/^\//, ''), scheme: 'https' };
  return null;
}

const detected = new Map(); // host → 'github' | 'gitlab' | null

async function originOf(repo) {
  const r = await git.run(repo, ['remote', 'get-url', 'origin'], { allowFail: true });
  if (r.code !== 0) {
    const first = (await git.run(repo, ['remote'], { allowFail: true })).stdout.split(/\r?\n/).find(Boolean);
    if (!first) return null;
    return (await git.run(repo, ['remote', 'get-url', first], { allowFail: true })).stdout.trim() || null;
  }
  return r.stdout.trim();
}

async function serviceFor(repo) {
  const url = await originOf(repo);
  if (!url) return { error: 'no-remote' };
  const rem = parseRemote(url);
  if (!rem) return { error: 'unknown-remote', url };
  let kind = detected.get(rem.host);
  if (kind === undefined) {
    if (rem.host === 'github.com') kind = 'github';
    else {
      // 자체 설치 GitLab (예: gitlab.회사.kr) 인지 확인
      const res = await fetchJson(`${rem.scheme}://${rem.host}/api/v4/version`, {}).catch(() => null);
      kind = res && (res.status === 200 || res.status === 401) ? 'gitlab' : /gitlab/i.test(rem.host) ? 'gitlab' : null;
    }
    detected.set(rem.host, kind);
  }
  if (!kind) return { error: 'unsupported', host: rem.host };
  const web = `${rem.scheme}://${rem.host}`;
  return {
    kind,
    host: rem.host,
    project: rem.path,
    web,
    api: kind === 'github' ? 'https://api.github.com' : `${web}/api/v4`,
    issuesUrl: kind === 'github' ? `https://github.com/${rem.path}/issues` : `${web}/${rem.path}/-/issues`,
    newTokenUrl:
      kind === 'github'
        ? 'https://github.com/settings/tokens/new?scopes=repo&description=CodeFlow'
        : `${web}/-/user_settings/personal_access_tokens?name=CodeFlow&scopes=read_api`,
  };
}

// ---------- 토큰 ----------

const tokenFile = () => path.join(app.getPath('userData'), 'issue-tokens.json');
function readTokens() {
  try {
    return JSON.parse(fs.readFileSync(tokenFile(), 'utf8'));
  } catch {
    return {};
  }
}
function savedToken(host) {
  const enc = readTokens()[host];
  if (!enc) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return null;
  }
}
function saveToken(host, token) {
  const all = readTokens();
  if (token) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('이 PC 에서는 토큰을 안전하게 저장할 수 없습니다.');
    all[host] = safeStorage.encryptString(token).toString('base64'); // Windows 사용자 계정으로 암호화
  } else delete all[host];
  fs.writeFileSync(tokenFile(), JSON.stringify(all, null, 2));
}

// Git Credential Manager 에 저장된 로그인 정보 (창을 띄우지 않고 저장된 것만)
function gitCredential(host) {
  return new Promise((resolve) => {
    const p = spawn('git', ['credential', 'fill'], {
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GCM_GUI_PROMPT: 'false' },
    });
    let out = '';
    const timer = setTimeout(() => p.kill(), 8000);
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(null));
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      const pw = (out.match(/^password=(.*)$/m) || [])[1];
      resolve(pw ? pw.trim() : null);
    });
    p.stdin.end(`protocol=https\nhost=${host}\n\n`);
  });
}

function headersFor(svc, token, mode) {
  const h = { Accept: svc.kind === 'github' ? 'application/vnd.github+json' : 'application/json', 'User-Agent': 'CodeFlow' };
  if (!token) return h;
  if (svc.kind === 'github') h.Authorization = `Bearer ${token}`;
  else if (mode === 'bearer') h.Authorization = `Bearer ${token}`;
  else h['PRIVATE-TOKEN'] = token;
  return h;
}

async function fetchJson(url, headers) {
  const res = await net.fetch(url, { headers });
  let body = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body, headers: res.headers };
}

// 인증 방법을 찾아서 기억 (host 별)
const authCache = new Map(); // host → { token, mode, source }

async function request(svc, urlPath) {
  const url = `${svc.api}${urlPath}`;
  const cached = authCache.get(svc.host);
  if (cached) {
    const r = await fetchJson(url, headersFor(svc, cached.token, cached.mode));
    // 404/403 은 '이 로그인으로는 안 보임' 일 수 있으니 다른 로그인 방법(저장한 토큰 / Git 로그인 정보)도 시도
    if (r.status !== 401 && r.status !== 403 && r.status !== 404) return { ...r, source: cached.source };
    if (r.status === 401) authCache.delete(svc.host);
  }
  const tries = [];
  const saved = savedToken(svc.host);
  if (saved) tries.push({ token: saved, mode: 'private', source: 'token' }, { token: saved, mode: 'bearer', source: 'token' });
  const cred = await gitCredential(svc.host);
  if (cred) tries.push({ token: cred, mode: 'bearer', source: 'git' }, { token: cred, mode: 'private', source: 'git' });
  tries.push({ token: null, mode: null, source: 'none' });
  let last = null;
  let best = null;
  for (const t of tries) {
    if (svc.kind === 'github' && t.mode === 'private') continue;
    const r = await fetchJson(url, headersFor(svc, t.token, t.mode));
    last = { ...r, source: t.source };
    if (!best && t.token && r.status !== 401) best = last;
    if (r.status === 200) {
      authCache.set(svc.host, t); // 다음부터는 이 방법으로 바로 (토큰 없이 되는 공개 저장소도 기억)
      return last;
    }
  }
  // 모두 실패했으면 로그인한 상태로 받은 결과(예: 토큰으로 받은 404 = 로그인은 됐지만 안 보임)가 더 쓸모 있다
  return best || last;
}

// ---------- 이슈 목록 / 상세 ----------

const norm = {
  github: (i) => ({
    number: i.number,
    title: i.title,
    state: i.state === 'open' ? 'open' : 'closed',
    author: i.user?.login || '',
    assignees: (i.assignees || []).map((a) => a.login),
    labels: (i.labels || []).map((l) => ({ name: l.name, color: l.color ? `#${l.color}` : null })),
    milestone: i.milestone?.title || null,
    comments: i.comments || 0,
    created: i.created_at,
    updated: i.updated_at,
    url: i.html_url,
    body: i.body || '',
  }),
  gitlab: (i) => ({
    number: i.iid,
    title: i.title,
    state: i.state === 'opened' ? 'open' : 'closed',
    author: i.author?.username || '',
    assignees: (i.assignees || []).map((a) => a.username),
    labels: (i.labels || []).map((l) => (typeof l === 'string' ? { name: l, color: null } : { name: l.name, color: l.color || null })),
    milestone: i.milestone?.title || null,
    comments: i.user_notes_count || 0,
    created: i.created_at,
    updated: i.updated_at,
    url: i.web_url,
    body: i.description || '',
    // 그룹 이슈를 볼 때는 어느 프로젝트의 이슈인지 (예: store-front#12)
    ref: i.references?.relative && !/^#/.test(i.references.relative) ? i.references.relative : null,
  }),
};

function errorFor(svc, r) {
  if (!r) return { error: 'network', message: '이슈 서버에 연결하지 못했습니다.' };
  if (r.status === 401 || r.status === 403 || (r.status === 404 && r.source === 'none'))
    return { error: 'auth', message: '이슈를 보려면 로그인 토큰이 필요합니다.', service: svc };
  if (r.status === 404) return { error: 'not-found', message: '이슈 보드를 찾을 수 없습니다 (이슈 기능이 꺼져 있을 수 있음).', service: svc };
  return { error: 'http', message: `이슈를 불러오지 못했습니다 (HTTP ${r.status}).`, service: svc };
}

const publicSvc = (svc) => ({ kind: svc.kind, host: svc.host, project: svc.project, issuesUrl: svc.issuesUrl, newTokenUrl: svc.newTokenUrl });

// GitLab: 프로젝트 이슈가 안 보일 때 원인을 찾고, 가능하면 상위 그룹의 이슈를 보여 준다
async function groupFallback(svc, q) {
  const proj = await request(svc, `/projects/${encodeURIComponent(svc.project)}`);
  const visible = proj?.status === 200;
  const reason = visible ? (proj.body?.issues_enabled === false || proj.body?.issues_access_level === 'disabled' ? 'disabled' : 'hidden') : 'no-access';
  // 상위 그룹부터: laos-corp/hstore/store-front → laos-corp/hstore → laos-corp
  const parts = svc.project.split('/').slice(0, -1);
  for (let n = parts.length; n >= 1; n--) {
    const name = parts.slice(0, n).join('/');
    const r = await request(svc, `/groups/${encodeURIComponent(name)}/issues?${q}`);
    if (r?.status === 200 && (r.body.length || n === 1 || reason !== 'no-access')) return { ok: true, r, scope: { kind: 'group', name, reason } };
  }
  if (visible) return { why: { error: 'not-found', message: `이 프로젝트(${svc.project})는 이슈 기능이 꺼져 있고, 상위 그룹의 이슈도 볼 수 없습니다.` } };
  // 프로젝트 자체가 안 보임: 저장된 토큰/로그인 계정에 이 프로젝트 권한이 없음
  const who = await request(svc, '/user');
  const user = who?.status === 200 ? who.body?.username : null;
  return {
    why: {
      error: 'no-access',
      user,
      message: `${user ? `'${user}' 계정으로는` : '지금 로그인 정보로는'} ${svc.project} 프로젝트가 보이지 않습니다. 이 프로젝트 멤버인 계정의 토큰(read_api)을 넣어 주세요.`,
    },
  };
}

// opts: { state: 'open'|'closed'|'all', search, mine, page }
async function list(repo, opts = {}) {
  const svc = await serviceFor(repo);
  if (svc.error) return svc;
  const per = 30;
  const page = opts.page || 1;
  let r;
  let items = [];
  let raw = 0; // 서버가 준 개수 (GitHub 는 PR 을 걸러 내므로 '더 있음' 판단은 이걸로)
  let scope = null; // 그룹 이슈를 보여 줄 때 { kind: 'group', name, reason }
  if (svc.kind === 'github') {
    const st = opts.state || 'open';
    if (opts.search || opts.mine) {
      const q = [`repo:${svc.project}`, 'is:issue', st === 'all' ? '' : `is:${st}`, opts.mine ? 'assignee:@me' : '', opts.search || ''].filter(Boolean).join(' ');
      r = await request(svc, `/search/issues?q=${encodeURIComponent(q)}&sort=updated&per_page=${per}&page=${page}`);
      if (r?.status === 200) (items = r.body.items), (raw = items.length);
    } else {
      r = await request(svc, `/repos/${svc.project}/issues?state=${st}&sort=updated&per_page=${per}&page=${page}`);
      if (r?.status === 200) (raw = r.body.length), (items = r.body.filter((i) => !i.pull_request)); // GitHub 는 PR 도 이슈로 옴
    }
  } else {
    const st = { open: 'opened', closed: 'closed', all: 'all' }[opts.state || 'open'];
    const q = new URLSearchParams({ state: st, order_by: 'updated_at', sort: 'desc', per_page: String(per), page: String(page) });
    if (opts.search) q.set('search', opts.search);
    if (opts.mine) q.set('scope', 'assigned_to_me');
    r = await request(svc, `/projects/${encodeURIComponent(svc.project)}/issues?${q}`);
    if (r?.status === 200) (items = r.body), (raw = items.length);
    // 프로젝트에서 이슈가 안 보이면: 이슈 기능이 꺼져 있고 그룹(상위 폴더)에서 이슈를 관리하는 경우가 많다 → 그룹 이슈로
    if (r && (r.status === 404 || r.status === 403) && r.source !== 'none') {
      const g = await groupFallback(svc, q);
      if (g.ok) {
        r = g.r;
        items = r.body;
        raw = items.length;
        scope = g.scope;
      } else {
        return { ...g.why, service: publicSvc(svc) };
      }
    }
  }
  if (r?.status !== 200) return errorFor(svc, r);
  const total = Number(r.headers.get('x-total')) || null; // GitLab 은 전체 개수를 알려 줌
  return {
    service: { ...publicSvc(svc), ...(scope ? { issuesUrl: `${svc.web}/groups/${scope.name}/-/issues` } : {}) },
    scope,
    auth: r.source,
    items: items.map(norm[svc.kind]),
    page,
    hasMore: raw >= per,
    total,
  };
}

// 토큰 저장 (확인 후 저장)
async function setToken(repo, token) {
  const svc = await serviceFor(repo);
  if (svc.error) throw new Error('이 저장소의 이슈 서비스를 찾을 수 없습니다.');
  token = String(token || '').trim();
  if (!token) {
    saveToken(svc.host, null);
    authCache.delete(svc.host);
    return { removed: true };
  }
  const testPath = svc.kind === 'github' ? '/user' : '/user';
  let ok = false;
  for (const mode of svc.kind === 'github' ? ['bearer'] : ['private', 'bearer']) {
    const r = await fetchJson(`${svc.api}${testPath}`, headersFor(svc, token, mode)).catch(() => null);
    if (r?.status === 200) {
      ok = true;
      authCache.set(svc.host, { token, mode, source: 'token' });
      break;
    }
  }
  if (!ok) throw new Error('토큰이 올바르지 않거나 권한(read_api / repo)이 없습니다.');
  saveToken(svc.host, token);
  return { saved: true };
}

module.exports = { list, setToken, serviceFor, parseRemote };
