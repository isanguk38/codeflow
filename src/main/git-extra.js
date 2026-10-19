// 고급 Git 기능: 대화형 리베이스, 여러 커밋 처리, Blame, Reflog, 비교, Submodule, Worktree, LFS, Bisect, Clean
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, GitError, FS, RS, hasHead, gitDir, showBlob, pack, parseNameStatus, mergeLike } = require('./git');

const posix = (p) => p.replace(/\\/g, '/');

// ---------- 대화형 리베이스 ----------

// base(제외)부터 HEAD 까지의 커밋을 오래된 순서로 돌려준다. base 가 null 이면 첫 커밋부터.
async function rebaseCommits(repo, base) {
  const range = base ? [`${base}..HEAD`] : ['HEAD'];
  const r = await run(repo, ['log', '--reverse', `--format=%H${FS}%P${FS}%an${FS}%at${FS}%s${FS}%B${RS}`, ...range]);
  return r.stdout
    .split(RS)
    .map((s) => s.replace(/^\n/, ''))
    .filter(Boolean)
    .map((line) => {
      const [hash, parents, author, at, subject, body] = line.split(FS);
      return { hash, parents: parents ? parents.split(' ') : [], author, time: +at * 1000, subject, message: (body || '').trim() };
    });
}

// items: [{ hash, action: 'pick'|'reword'|'squash'|'fixup'|'drop', message? }] (오래된 것부터, 원하는 순서대로)
// 그룹(pick/reword + 뒤따르는 squash/fixup)의 첫 항목에 message 가 있으면 그 메시지로 커밋을 고친다.
async function interactiveRebase(repo, { base, items }) {
  const kept = items.filter((i) => i.action !== 'drop');
  if (!kept.length) throw new GitError('모든 커밋을 삭제할 수는 없습니다. 대신 Reset 을 사용하세요.');
  if (['squash', 'fixup'].includes(kept[0].action)) throw new GitError('첫 번째 커밋은 합치기(squash/fixup) 할 수 없습니다. 위에 합칠 대상 커밋이 있어야 합니다.');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeflow-rebase-'));
  const lines = [];
  let leader = null;
  let n = 0;
  const flush = () => {
    if (leader && leader.message) {
      const f = path.join(dir, `msg${n++}.txt`);
      fs.writeFileSync(f, leader.message, 'utf8');
      lines.push(`exec git commit --amend --allow-empty -q -F "${posix(f)}"`);
    }
  };
  for (const it of items) {
    if (it.action === 'drop') {
      lines.push(`drop ${it.hash}`);
      continue;
    }
    if (it.action === 'squash' || it.action === 'fixup') {
      lines.push(`fixup ${it.hash}`);
      continue;
    }
    flush();
    leader = it;
    lines.push(`pick ${it.hash}`);
  }
  flush();
  const todo = path.join(dir, 'todo.txt');
  fs.writeFileSync(todo, lines.join('\n') + '\n', 'utf8');
  const env = { GIT_SEQUENCE_EDITOR: `cp "${posix(todo)}"` };
  try {
    return await mergeLike(repo, ['rebase', '-i', base || '--root'], { env });
  } finally {
    // 충돌로 멈춘 경우 exec 단계가 메시지 파일을 아직 사용하므로 지우지 않는다.
    setTimeout(() => {
      if (!fs.existsSync(path.join(repo, '.git', 'rebase-merge'))) fs.rmSync(dir, { recursive: true, force: true });
    }, 60_000).unref();
  }
}

// ---------- 여러 커밋 한 번에 ----------

const cherryPickMany = (repo, hashes) => mergeLike(repo, ['cherry-pick', ...hashes]); // 오래된 것부터
const revertMany = (repo, hashes) => mergeLike(repo, ['revert', '--no-edit', ...hashes]); // 최신 것부터

// ---------- Blame ----------

async function blame(repo, file, rev) {
  const args = ['blame', '--porcelain'];
  if (rev) args.push(rev);
  args.push('--', file);
  const r = await run(repo, args);
  const commits = {};
  const lines = [];
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('\t')) {
      lines.push({ hash: cur, text: line.slice(1) });
      continue;
    }
    const m = line.match(/^([0-9a-f]{40}) (\d+) (\d+)/);
    if (m) {
      cur = m[1];
      commits[cur] = commits[cur] || { hash: cur };
      continue;
    }
    const sp = line.indexOf(' ');
    const key = line.slice(0, sp);
    const val = line.slice(sp + 1);
    if (!cur) continue;
    if (key === 'author') commits[cur].author = val;
    else if (key === 'author-time') commits[cur].time = +val * 1000;
    else if (key === 'summary') commits[cur].summary = val;
  }
  return { commits, lines };
}

// ---------- Reflog ----------

async function reflog(repo, limit = 300) {
  if (!(await hasHead(repo))) return [];
  const r = await run(repo, ['reflog', '--date=unix', `--format=%H${FS}%gd${FS}%gs${FS}%s`, '-n', String(limit)], { allowFail: true });
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash, sel, action, subject] = l.split(FS);
      const t = sel.match(/\{(\d+)\}/);
      return { hash, selector: sel, time: t ? +t[1] * 1000 : 0, action, subject };
    });
}

// ---------- 브랜치/커밋 비교 ----------

async function compareRefs(repo, a, b) {
  const fmt = `--format=%H${FS}%an${FS}%at${FS}%s`;
  const parse = (out) =>
    out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [hash, author, at, subject] = l.split(FS);
        return { hash, author, time: +at * 1000, subject };
      });
  const onlyB = parse((await run(repo, ['log', fmt, '-n', '500', `${a}..${b}`])).stdout);
  const onlyA = parse((await run(repo, ['log', fmt, '-n', '500', `${b}..${a}`])).stdout);
  const files = parseNameStatus((await run(repo, ['diff', '--name-status', '-z', '-M', a, b])).stdout);
  return { onlyA, onlyB, files };
}

async function refFilePair(repo, a, b, file) {
  const oldPath = file.orig || file.path;
  const left = file.status === 'added' ? null : await showBlob(repo, `${a}:${oldPath}`);
  const right = file.status === 'deleted' ? null : await showBlob(repo, `${b}:${file.path}`);
  return { left: pack(left), right: pack(right), leftLabel: `${a}: ${oldPath}`, rightLabel: `${b}: ${file.path}` };
}

// ---------- Submodule ----------

async function submodules(repo) {
  if (!fs.existsSync(path.join(repo, '.gitmodules'))) return [];
  const st = await run(repo, ['submodule', 'status', '--recursive'], { allowFail: true });
  const urls = {};
  const cfg = await run(repo, ['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.(url|path)$'], { allowFail: true });
  const byName = {};
  for (const l of cfg.stdout.split('\n').filter(Boolean)) {
    const m = l.match(/^submodule\.(.+)\.(url|path) (.+)$/);
    if (m) (byName[m[1]] ||= {})[m[2]] = m[3];
  }
  for (const v of Object.values(byName)) if (v.path) urls[v.path] = v.url;
  return st.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const flag = l[0];
      const [sha, p, ...rest] = l.slice(1).trim().split(' ');
      return {
        path: p,
        sha,
        describe: rest.join(' ').replace(/[()]/g, ''),
        url: urls[p] || '',
        state: { ' ': 'ok', '-': 'uninitialized', '+': 'modified', U: 'conflict' }[flag] || 'ok',
      };
    });
}

const submoduleUpdate = (repo) => run(repo, ['submodule', 'update', '--init', '--recursive']).then((r) => (r.stdout + r.stderr).trim());
const submoduleSync = (repo) => run(repo, ['submodule', 'sync', '--recursive']).then((r) => (r.stdout + r.stderr).trim());
const submoduleAdd = (repo, url, p) => run(repo, ['submodule', 'add', url, p]).then((r) => (r.stdout + r.stderr).trim());

// ---------- Worktree ----------

async function worktrees(repo) {
  const r = await run(repo, ['worktree', 'list', '--porcelain']);
  const list = [];
  let cur = null;
  for (const l of r.stdout.split('\n')) {
    if (l.startsWith('worktree ')) {
      cur = { path: path.normalize(l.slice(9)), branch: null, detached: false };
      list.push(cur);
    } else if (!cur) continue;
    else if (l.startsWith('HEAD ')) cur.head = l.slice(5);
    else if (l.startsWith('branch ')) cur.branch = l.slice(7).replace('refs/heads/', '');
    else if (l === 'detached') cur.detached = true;
    else if (l === 'bare') cur.bare = true;
    else if (l.startsWith('locked')) cur.locked = true;
    else if (l.startsWith('prunable')) cur.prunable = true;
  }
  const main = path.normalize(repo).toLowerCase();
  list.forEach((w) => (w.current = w.path.toLowerCase() === main));
  return list;
}

async function worktreeAdd(repo, { dir, branch, newBranch }) {
  const args = ['worktree', 'add'];
  if (newBranch) args.push('-b', newBranch, dir, ...(branch ? [branch] : []));
  else args.push(dir, branch);
  await run(repo, args);
}
const worktreeRemove = (repo, dir, force) => run(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), dir]);
const worktreePrune = (repo) => run(repo, ['worktree', 'prune']);

// ---------- Git LFS ----------

async function lfsInfo(repo) {
  const v = await run(repo, ['lfs', 'version'], { allowFail: true });
  if (v.code !== 0) return { installed: false };
  const t = await run(repo, ['lfs', 'track'], { allowFail: true });
  const patterns = t.stdout
    .split('\n')
    .map((l) => l.match(/^\s+(\S.*?)\s+\((.+)\)$/))
    .filter(Boolean)
    .map((m) => ({ pattern: m[1], source: m[2] }));
  const f = await run(repo, ['lfs', 'ls-files', '--size'], { allowFail: true });
  const files = f.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^([0-9a-f]+) ([*-]) (.+?)(?: \((.+)\))?$/);
      return m ? { oid: m[1], downloaded: m[2] === '*', path: m[3], size: m[4] || '' } : { path: l };
    });
  const hooks = fs.existsSync(path.join(await gitDir(repo), 'hooks', 'pre-push')) && fs.readFileSync(path.join(await gitDir(repo), 'hooks', 'pre-push'), 'utf8').includes('lfs');
  return { installed: true, version: v.stdout.trim(), patterns, files, hooks };
}
const lfsInstall = (repo) => run(repo, ['lfs', 'install', '--local']).then((r) => r.stdout.trim());
const lfsTrack = (repo, pattern) => run(repo, ['lfs', 'track', pattern]).then((r) => r.stdout.trim());
const lfsUntrack = (repo, pattern) => run(repo, ['lfs', 'untrack', pattern]).then((r) => r.stdout.trim());
const lfsPull = (repo) => run(repo, ['lfs', 'pull']).then((r) => (r.stdout + r.stderr).trim());

// ---------- Bisect ----------

async function bisectInfo(repo) {
  const gd = await gitDir(repo);
  if (!fs.existsSync(path.join(gd, 'BISECT_LOG'))) return { active: false };
  const refs = await run(repo, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/bisect'], { allowFail: true });
  const good = [];
  let bad = null;
  for (const l of refs.stdout.split('\n').filter(Boolean)) {
    const [name, sha] = l.split(' ');
    if (name.endsWith('/bad')) bad = sha;
    else if (name.includes('good')) good.push(sha);
  }
  const head = (await run(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  const log = (await run(repo, ['bisect', 'log'], { allowFail: true })).stdout;
  const found = log.match(/# first bad commit: \[([0-9a-f]+)\] (.*)/);
  const left = bad && good.length ? (await run(repo, ['rev-list', '--count', bad, '--not', ...good], { allowFail: true })).stdout.trim() : '';
  return { active: true, good, bad, head, found: found ? { hash: found[1], subject: found[2] } : null, remaining: left };
}

async function bisectStart(repo, bad, good) {
  const r = await run(repo, ['bisect', 'start', bad, good]);
  return (r.stdout + r.stderr).trim();
}
async function bisectMark(repo, term, rev) {
  if (!['good', 'bad', 'skip'].includes(term)) throw new GitError('잘못된 bisect 명령');
  const r = await run(repo, ['bisect', term, ...(rev ? [rev] : [])]);
  return (r.stdout + r.stderr).trim();
}
async function bisectReset(repo) {
  await run(repo, ['bisect', 'reset']);
}

// ---------- Clean (추적되지 않는 파일 정리) ----------

async function cleanPreview(repo, { ignored = false, dirs = true } = {}) {
  const args = ['clean', '-n'];
  if (dirs) args.push('-d');
  if (ignored) args.push('-x');
  const r = await run(repo, args);
  return r.stdout
    .split('\n')
    .map((l) => l.match(/^Would remove (.+)$/))
    .filter(Boolean)
    .map((m) => m[1].replace(/\/$/, ''));
}

module.exports = {
  rebaseCommits,
  interactiveRebase,
  cherryPickMany,
  revertMany,
  blame,
  reflog,
  compareRefs,
  refFilePair,
  submodules,
  submoduleUpdate,
  submoduleSync,
  submoduleAdd,
  worktrees,
  worktreeAdd,
  worktreeRemove,
  worktreePrune,
  lfsInfo,
  lfsInstall,
  lfsTrack,
  lfsUntrack,
  lfsPull,
  bisectInfo,
  bisectStart,
  bisectMark,
  bisectReset,
  cleanPreview,
};
