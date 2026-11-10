// 브랜치·병합·원격 저장소 작업. git.js 가 맨 끝에서 불러 자기 exports 에 합치므로, 다른 곳에서는 git.js 만 쓰면 된다
const { run, GitError, FS, status, repoState, hasHead, mergeLike } = require('./git');

// ---------- 브랜치 ----------

async function branches(repo) {
  const r = await run(repo, [
    'for-each-ref',
    `--format=%(refname)${FS}%(refname:short)${FS}%(objectname:short)${FS}%(upstream:short)${FS}%(upstream:track)${FS}%(HEAD)${FS}%(committerdate:unix)`,
    'refs/heads',
    'refs/remotes',
    'refs/tags',
  ]);
  const local = [];
  const remote = [];
  const tags = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [ref, , sha, upstream, track, headMark, date] = line.split(FS);
    // %(refname:short) 는 이름이 겹치면 heads/x, tags/x 로 바뀌어 git branch -d 등에서 찾지 못한다. 진짜 이름을 쓴다
    const name = ref.replace(/^refs\/(heads|remotes|tags)\//, '');
    const item = { ref, name, sha, upstream: upstream || null, track: track || '', current: headMark === '*', date: +date * 1000 };
    if (ref.startsWith('refs/heads/')) local.push(item);
    else if (ref.startsWith('refs/remotes/')) {
      if (ref.endsWith('/HEAD')) continue;
      remote.push(item);
    } else tags.push(item);
  }
  return { local, remote, tags };
}

// 체크아웃하지 않은 로컬 브랜치도 원격 내용으로 업데이트 (Fast-forward 만, 작업 폴더는 건드리지 않음)
// 현재 브랜치는 여기서 다루지 않는다 (화면에서 일반 Pull 로 처리)
async function updateBranches(repo, names) {
  const { local } = await branches(repo);
  const results = [];
  for (const name of names) {
    const b = local.find((x) => x.name === name);
    if (!b) {
      results.push({ name, ok: false, message: '브랜치를 찾을 수 없습니다' });
      continue;
    }
    if (b.current) {
      results.push({ name, ok: false, current: true, message: '현재 브랜치' });
      continue;
    }
    if (!b.upstream) {
      results.push({ name, ok: false, message: '연결된 원격 브랜치가 없습니다' });
      continue;
    }
    const remotes = (await run(repo, ['remote'])).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    const remote = remotes.filter((r) => b.upstream.startsWith(`${r}/`)).sort((a, c) => c.length - a.length)[0];
    if (!remote) {
      results.push({ name, ok: false, message: `원격 '${b.upstream}' 을 찾을 수 없습니다` });
      continue;
    }
    const rb = b.upstream.slice(remote.length + 1);
    const before = b.sha;
    const r = await run(repo, ['fetch', remote, `refs/heads/${rb}:refs/heads/${name}`], { allowFail: true });
    if (r.code === 0) {
      const after = (await run(repo, ['rev-parse', '--short', `refs/heads/${name}`])).stdout.trim();
      results.push({ name, ok: true, changed: after !== before, message: after !== before ? `${before} → ${after}` : '이미 최신' });
    } else if (/non-fast-forward|rejected/i.test(r.stderr)) {
      results.push({ name, ok: false, message: '로컬에만 있는 커밋이 있어 자동으로 합칠 수 없습니다 (체크아웃한 뒤 Pull 하세요)' });
    } else if (/couldn't find remote ref/i.test(r.stderr)) {
      results.push({ name, ok: false, message: '원격 브랜치가 삭제되었습니다' });
    } else results.push({ name, ok: false, message: r.stderr.trim().split('\n').pop() || `실패 (code ${r.code})` });
  }
  return results;
}

async function checkout(repo, name) {
  await run(repo, ['checkout', name]);
}

// 사용자가 refs/heads/x 처럼 입력해도 refs/heads/refs/heads/x 라는 이상한 브랜치가 생기지 않게 한다
const plainBranch = (n) => (n || '').replace(/^(refs\/)?heads\//, '');

// 'second/main' 을 원격 이름과 브랜치 이름으로 나눈다 (원격 이름에 / 가 있어도). 원격 브랜치가 아니면 null
async function splitRemoteRef(repo, ref) {
  const names = (await run(repo, ['remote'])).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const remote = names.filter((n) => ref.startsWith(`${n}/`)).sort((a, c) => c.length - a.length)[0];
  if (!remote) return null;
  const known = await run(repo, ['rev-parse', '--verify', '-q', `refs/remotes/${ref}`], { allowFail: true });
  return known.code === 0 ? { remote, branch: ref.slice(remote.length + 1) } : null;
}

// 원격 브랜치 체크아웃. 로컬 브랜치는 원격별로 따로 둔다 (develop-A → origin/develop, develop-B → backup/develop).
// 이미 이 원격 브랜치를 추적하는 로컬이 있으면 그리로 옮기고, 같은 이름이 다른 원격을 추적 중이면 새 이름을 물어본다.
async function checkoutRemote(repo, remoteBranch, localName) {
  const parts = await splitRemoteRef(repo, remoteBranch);
  if (!parts) throw new GitError(`'${remoteBranch}' 원격 브랜치를 찾을 수 없습니다.`);
  if (!localName) {
    const { local } = await branches(repo);
    const same = local.find((b) => b.name === parts.branch);
    const tracking = same?.upstream === remoteBranch ? same : local.find((b) => b.upstream === remoteBranch);
    if (tracking) {
      await run(repo, ['checkout', tracking.name]);
      return { local: tracking.name };
    }
    if (same?.upstream) {
      let suggest = `${parts.branch}-${parts.remote}`;
      for (let i = 2; local.some((b) => b.name === suggest); i++) suggest = `${parts.branch}-${parts.remote}-${i}`;
      return { needName: true, local: same.name, upstream: same.upstream, suggest };
    }
    if (same) {
      await run(repo, ['checkout', same.name]);
      await run(repo, ['branch', `--set-upstream-to=${remoteBranch}`, same.name]);
      return { local: same.name };
    }
    localName = parts.branch;
  }
  localName = plainBranch(localName);
  await run(repo, ['checkout', '-b', localName, '--track', remoteBranch]);
  return { local: localName };
}

// 현재 브랜치가 추적할 원격 브랜치를 정한다. null 이면 추적을 끊는다
async function setUpstream(repo, remoteBranch) {
  if (remoteBranch) await run(repo, ['branch', `--set-upstream-to=${remoteBranch}`]);
  else await run(repo, ['branch', '--unset-upstream'], { allowFail: true });
}

async function fetchRemote(repo, name) {
  await run(repo, ['fetch', name, '--prune']);
}

async function createBranch(repo, { name, start, checkout: co }) {
  name = plainBranch(name);
  const parts = start ? await splitRemoteRef(repo, start) : null;
  // 이름이 다른 새 브랜치는 원본 원격 브랜치를 추적하지 않는다 (feature 를 Push 했는데 main 이 바뀌면 안 된다).
  // 첫 Push 때 그 원격에 같은 이름으로 만든다
  const noTrack = parts && parts.branch !== name ? ['--no-track'] : [];
  const pushRemote = parts ? (noTrack.length ? parts.remote : '') : (await run(repo, ['config', '--get', `branch.${start || (await status(repo)).branch}.remote`], { allowFail: true })).stdout.trim();
  if (co) await run(repo, ['checkout', '-b', name, ...noTrack, ...(start ? [start] : [])]);
  else await run(repo, ['branch', ...noTrack, name, ...(start ? [start] : [])]);
  // 어느 원격에서 시작했는지 브랜치에 기억해 둔다 (원격이 '.' 이면 로컬 브랜치 추적이라 건너뛴다)
  if (pushRemote && pushRemote !== '.') await run(repo, ['config', `branch.${name}.pushRemote`, pushRemote]);
}

async function deleteBranch(repo, name, force) {
  await run(repo, ['branch', force ? '-D' : '-d', name]);
}

async function deleteRemoteBranch(repo, remoteBranch) {
  const parts = await splitRemoteRef(repo, remoteBranch);
  if (!parts) throw new GitError(`'${remoteBranch}' 원격 브랜치를 찾을 수 없습니다.`);
  const r = await run(repo, ['push', parts.remote, '--delete', parts.branch], { allowFail: true });
  if (r.code === 0) return { stale: false };
  if (!/remote ref does not exist/i.test(r.stderr)) throw new GitError((r.stderr || r.stdout).trim(), r);
  // 서버에서는 이미 지워졌는데 이 PC 의 목록에만 남아 있던 경우: 목록에서 정리한다
  await run(repo, ['update-ref', '-d', `refs/remotes/${remoteBranch}`]);
  return { stale: true };
}

async function renameBranch(repo, oldName, newName) {
  await run(repo, ['branch', '-m', oldName, newName]);
}

// mode: 'default'(가능하면 fast-forward) | 'no-ff'(항상 병합 커밋) | 'ff-only'(fast-forward 만) | 'squash'(하나로 뭉쳐서 커밋)
async function merge(repo, branch, { mode = 'default', message } = {}) {
  if (mode === 'squash') {
    const r = await mergeLike(repo, ['merge', '--squash', branch]);
    if (!r.ok) return r;
    // --squash 는 변경을 스테이징만 하므로 바로 커밋한다
    const staged = await run(repo, ['diff', '--cached', '--quiet'], { allowFail: true });
    if (staged.code === 0) return { ok: true, output: 'Already up to date.' };
    await run(repo, ['commit', '-F', '-'], { input: message || `Squashed '${branch}'` });
    return r;
  }
  const args = ['merge'];
  if (mode === 'no-ff') args.push('--no-ff');
  if (mode === 'ff-only') args.push('--ff-only');
  if (message && mode !== 'ff-only') args.push('-m', message);
  else args.push('--no-edit');
  args.push(branch);
  if (mode === 'ff-only') {
    const r = await run(repo, args, { allowFail: true });
    if (r.code !== 0) throw new GitError(/Not possible to fast-forward|not possible to fast-forward/i.test(r.stderr) ? '현재 브랜치에 병합할 브랜치에 없는 커밋이 있어서 fast-forward 할 수 없습니다. 다른 병합 방식을 선택하세요.' : (r.stderr || r.stdout).trim());
    return { ok: true, output: (r.stdout + r.stderr).trim() };
  }
  return mergeLike(repo, args);
}

// 병합 전에 보여줄 정보: 들어올 커밋 수, fast-forward 가능 여부
async function mergePreview(repo, branch) {
  const incoming = (await run(repo, ['rev-list', '--count', `HEAD..${branch}`])).stdout.trim();
  const outgoing = (await run(repo, ['rev-list', '--count', `${branch}..HEAD`])).stdout.trim();
  return { incoming: +incoming, outgoing: +outgoing, canFF: +outgoing === 0 && +incoming > 0, upToDate: +incoming === 0 };
}
const rebase = (repo, onto) => mergeLike(repo, ['rebase', onto]);
const cherryPick = (repo, hash) => mergeLike(repo, ['cherry-pick', hash]);

async function revertCommit(repo, hash) {
  const parents = (await run(repo, ['rev-list', '--parents', '-n', '1', hash])).stdout.trim().split(' ').slice(1);
  const args = ['revert', '--no-edit'];
  if (parents.length > 1) args.push('-m', '1');
  args.push(hash);
  return mergeLike(repo, args);
}

async function reset(repo, hash, mode) {
  if (!['soft', 'mixed', 'hard'].includes(mode)) throw new GitError('잘못된 reset 모드');
  await run(repo, ['reset', `--${mode}`, hash]);
}

async function operation(repo, action) {
  const st = await repoState(repo);
  if (!st) return;
  const cmd = st === 'rebase' ? 'rebase' : st;
  if (action === 'abort') {
    await run(repo, [cmd, '--abort']);
  } else if (action === 'continue') {
    if (st === 'merge') return mergeLike(repo, ['commit', '--no-edit']);
    return mergeLike(repo, [cmd, '--continue']);
  }
}

// ---------- 원격 ----------

async function remotes(repo) {
  const r = await run(repo, ['remote', '-v']);
  const map = {};
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)/);
    if (m) map[m[1]] = map[m[1]] || { name: m[1], url: m[2] };
  }
  return Object.values(map);
}

async function addRemote(repo, name, url) {
  await run(repo, ['remote', 'add', name, url]);
}

async function setRemoteUrl(repo, name, url) {
  await run(repo, ['remote', 'set-url', name, url]);
}

async function removeRemote(repo, name) {
  await run(repo, ['remote', 'remove', name]);
}

async function fetchAll(repo) {
  const r = await run(repo, ['fetch', '--all', '--prune']);
  return (r.stdout + r.stderr).trim();
}

// remote, branch: 추적 중인 브랜치 대신 그 원격 브랜치에서 가져올 때
// allowUnrelated: 서로 이력이 다른 두 저장소를 합칠 때 (항상 병합 커밋)
async function pull(repo, { rebase: useRebase, remote, branch, allowUnrelated } = {}) {
  const args = ['pull', useRebase && !allowUnrelated ? '--rebase' : '--no-rebase', '--no-edit'];
  if (allowUnrelated) args.push('--allow-unrelated-histories');
  if (remote) args.push(remote, branch);
  return mergeLike(repo, args);
}

// 그 원격 브랜치에만 있는 커밋 (강제 Push 하면 사라지는 것). 최신 상태로 가져온 뒤 센다
async function remoteOnly(repo, remote, branch) {
  await run(repo, ['fetch', remote]);
  const r = await run(repo, ['log', '--format=%h %s', '-n', '50', `HEAD..refs/remotes/${remote}/${branch}`], { allowFail: true });
  return r.stdout.split('\n').filter(Boolean);
}

// Push 대상: 고른 원격(없으면 브랜치의 원격)과 원격 브랜치(없으면 추적 중인 브랜치 이름 → 로컬 브랜치 이름)
function pushTarget(s, remote, branch) {
  const up = s.upstream && s.remote && s.upstream.startsWith(`${s.remote}/`) ? s.upstream.slice(s.remote.length + 1) : null;
  return { remote: remote || s.remote, branch: plainBranch(branch) || up || s.branch };
}

// 로컬 브랜치를 Push 한다. 대상은 브랜치의 추적 설정을 따르고, remote·branch 로 이번만 다른 곳에 올릴 수 있다 (추적은 그대로)
async function push(repo, { force, tags, remote, branch } = {}) {
  const s = await status(repo);
  if (s.detached) throw new GitError('분리된 HEAD 상태에서는 Push 할 수 없습니다. 브랜치를 체크아웃하세요.');
  if (!s.remotes.length) throw new GitError('원격 저장소(remote)가 없습니다. 설정에서 원격 저장소를 추가하세요.');
  const t = pushTarget(s, remote, branch);
  const args = ['push'];
  if (force) args.push('--force-with-lease');
  if (tags) args.push('--tags');
  if (!s.upstream) args.push('-u');
  args.push(t.remote, t.branch === s.branch ? s.branch : `${s.branch}:refs/heads/${t.branch}`);
  const r = await run(repo, args);
  return (r.stdout + r.stderr).trim();
}

// Push 될 커밋 목록 (remote, branch: 그 원격 브랜치 기준으로)
async function outgoing(repo, remote, branch) {
  if (!(await hasHead(repo))) return { commits: [], newBranch: true };
  const s = await status(repo);
  const t = pushTarget(s, remote, branch);
  const ref = `${t.remote}/${t.branch}`;
  const has = !!t.remote && (await run(repo, ['rev-parse', '--verify', '-q', `refs/remotes/${ref}`], { allowFail: true })).code === 0;
  const range = has ? [`refs/remotes/${ref}..HEAD`] : ['HEAD', '--not', t.remote ? `--remotes=${t.remote}` : '--remotes'];
  const r = await run(repo, ['log', `--format=%H${FS}%an${FS}%at${FS}%s`, '-n', '200', ...range]);
  const commits = r.stdout.split('\n').filter(Boolean).map((l) => {
    const [hash, author, at, subject] = l.split(FS);
    return { hash, author, time: +at * 1000, subject };
  });
  return { commits, newBranch: !has, target: ref, targetBranch: t.branch, upstream: s.upstream, branch: s.branch, remote: t.remote, remotes: s.remotes };
}

module.exports = {
  branches,
  updateBranches,
  checkout,
  checkoutRemote,
  setUpstream,
  fetchRemote,
  createBranch,
  deleteBranch,
  deleteRemoteBranch,
  renameBranch,
  merge,
  mergePreview,
  rebase,
  cherryPick,
  revertCommit,
  reset,
  operation,
  remotes,
  addRemote,
  setRemoteUrl,
  removeRemote,
  fetchAll,
  pull,
  remoteOnly,
  push,
  outgoing,
};
