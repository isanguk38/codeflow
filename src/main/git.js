// Git CLI 래퍼. 모든 Git 작업은 사용자 PC에 설치된 git 실행 파일을 호출해서 처리한다.
// 인증(GitHub 로그인 등)은 git 의 credential helper(Git Credential Manager)가 담당한다.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureGitFound, setGitCacheFile, scanForGit } = require('./git-find');

const MAX_DIFF_BYTES = 2 * 1024 * 1024;

class GitError extends Error {
  constructor(message, { stdout = '', stderr = '', code = 1, args = [] } = {}) {
    super(message);
    this.stdout = stdout;
    this.stderr = stderr;
    this.code = code;
    this.args = args;
  }
}

// Windows 는 명령줄이 약 32,000자를 넘으면 git 을 실행조차 못 한다 (파일 수천 개를 한 번에 커밋할 때 등).
// 그럴 때는 '--' 뒤의 파일 목록을 표준 입력(--pathspec-from-file)으로 넘긴다.
const PATHSPEC_CMDS = new Set(['add', 'commit', 'reset', 'restore', 'rm', 'stash', 'checkout']);
const MAX_CMDLINE = 24000;

function run(cwd, args, opts = {}) {
  const sep = args.indexOf('--');
  if (sep < 0 || !PATHSPEC_CMDS.has(args[0]) || args.reduce((n, a) => n + a.length + 3, 0) < MAX_CMDLINE) return runGit(cwd, args, opts);
  const head = args.slice(0, sep);
  let tmp = null;
  if (opts.input !== undefined) {
    // 표준 입력을 이미 쓰는 경우(커밋 메시지 -F -)에는 메시지를 임시 파일로 넘긴다
    const fi = head.indexOf('-F');
    if (fi < 0 || head[fi + 1] !== '-') return runGit(cwd, args, opts);
    tmp = path.join(os.tmpdir(), `codeflow-msg-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(tmp, opts.input, 'utf8');
    head[fi + 1] = tmp;
  }
  head.push('--pathspec-from-file=-', '--pathspec-file-nul');
  const done = () => tmp && fs.rm(tmp, { force: true }, () => {});
  return runGit(cwd, head, { ...opts, input: args.slice(sep + 1).join('\0') }).finally(done);
}

function runGit(cwd, args, { allowFail = false, input, raw = false, env: extraEnv } = {}) {
  return new Promise((resolve, reject) => {
    const fullArgs = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args];
    let child;
    try {
      child = spawn('git', fullArgs, {
        cwd,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_EDITOR: 'true',
          GIT_SEQUENCE_EDITOR: 'true',
          GIT_MERGE_AUTOEDIT: 'no',
          LC_ALL: 'C.UTF-8',
          LANG: 'C.UTF-8',
          ...(extraEnv || {}),
        },
      });
    } catch (e) {
      reject(new GitError(e.code === 'ENAMETOOLONG' ? 'git 명령이 너무 깁니다 (파일이 너무 많음).' : `git 실행에 실패했습니다 (${e.code || e.message}). Git이 설치되어 있는지 확인하세요.`));
      return;
    }
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      // 작업 폴더가 없어도 ENOENT 가 난다
      if (e.code === 'ENOENT' && cwd && !fs.existsSync(cwd)) reject(new GitError(`폴더를 찾을 수 없습니다: ${cwd}`));
      else if (e.code === 'ENOENT') reject(new GitError('이 PC 에서 Git(git.exe)을 찾지 못했습니다. Git for Windows 를 설치한 뒤 다시 시도해 주세요. (https://git-scm.com/download/win)'));
      else reject(new GitError(e.message));
    });
    child.on('close', (code) => {
      const outBuf = Buffer.concat(out);
      const stdout = raw ? outBuf : outBuf.toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code !== 0 && !allowFail) {
        const msg = (stderr || (raw ? '' : stdout) || `git ${args.join(' ')} 실패 (code ${code})`).trim();
        reject(new GitError(msg, { stdout: raw ? '' : stdout, stderr, code, args }));
      } else {
        resolve({ stdout, stderr, code });
      }
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

// MSYS2·Cygwin 의 git 은 경로를 /c/foo, /cygdrive/c/foo 로 돌려준다
function toWinPath(p) {
  if (process.platform !== 'win32') return p;
  return p.replace(/^(?:\/cygdrive)?\/([a-zA-Z])(?=\/|$)/, (_, d) => `${d.toUpperCase()}:`).replace(/^([A-Z]:)$/, '$1/');
}

// 저장소의 최상위 폴더. 저장소가 아니면 null, 그 밖의 이유로 못 열면 까닭을 알려 준다
async function topLevel(dir) {
  await ensureGitFound();
  const r = await run(dir, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (r.code === 0) return path.normalize(toWinPath(r.stdout.trim()));
  if (/not a git repository/i.test(r.stderr)) return null;
  if (/dubious ownership/i.test(r.stderr)) throw new GitError('이 폴더의 소유자가 현재 Windows 사용자와 달라 Git 이 열기를 막았습니다.', { stderr: r.stderr, code: r.code });
  if (/must be run in a work tree/i.test(r.stderr)) throw new GitError('작업 폴더가 없는 저장소입니다 (bare 저장소이거나 .git 폴더 안을 고른 경우). 프로젝트 폴더를 골라 주세요.', { stderr: r.stderr, code: r.code });
  throw new GitError(r.stderr.trim() || `git rev-parse 실패 (code ${r.code})`, { stderr: r.stderr, code: r.code });
}

// 소유자가 다른 폴더를 신뢰 목록에 넣는다 (Git 이 알려 주는 경로 그대로)
async function trustDir(dir) {
  const r = await run(dir, ['rev-parse', '--show-toplevel'], { allowFail: true });
  const m = r.stderr.match(/safe\.directory\s+'?([^'\r\n]+?)'?\s*$/m);
  if (!m) throw new GitError(r.stderr.trim() || '이 폴더는 신뢰 목록에 넣을 수 없습니다.');
  await run(os.homedir(), ['config', '--global', '--add', 'safe.directory', m[1]]);
}

async function gitDir(repo) {
  const r = await run(repo, ['rev-parse', '--absolute-git-dir']);
  return toWinPath(r.stdout.trim());
}

async function hasHead(repo) {
  const r = await run(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true });
  return r.code === 0;
}

// ---------- 상태 ----------

function classify(x, y) {
  const xy = x + y;
  if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(xy)) return 'conflict';
  if (xy === '??') return 'untracked';
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'C') return 'added';
  if (x === 'A') return y === 'D' ? 'deleted' : 'added';
  if (x === 'D' || y === 'D') return 'deleted';
  return 'modified';
}

async function status(repo) {
  const r = await run(repo, ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=all']);
  const parts = r.stdout.split('\0');
  const result = { branch: null, detached: false, upstream: null, ahead: 0, behind: 0, files: [] };
  let i = 0;
  if (parts[0] && parts[0].startsWith('## ')) {
    const head = parts[0].slice(3);
    i = 1;
    let m;
    if ((m = head.match(/^No commits yet on (.+)$/)) || (m = head.match(/^Initial commit on (.+)$/))) {
      result.branch = m[1];
    } else if (head.startsWith('HEAD (no branch)')) {
      result.detached = true;
    } else {
      const [refPart, trackPart] = head.split(' [');
      const [local, upstream] = refPart.split('...');
      result.branch = local;
      result.upstream = upstream || null;
      if (trackPart) {
        const a = trackPart.match(/ahead (\d+)/);
        const b = trackPart.match(/behind (\d+)/);
        if (a) result.ahead = +a[1];
        if (b) result.behind = +b[1];
        if (trackPart.includes('gone')) result.upstreamGone = true;
      }
    }
  }
  for (; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const x = entry[0];
    const y = entry[1];
    const p = entry.slice(3);
    const file = { path: p, x, y, status: classify(x, y) };
    if (x === 'R' || x === 'C') {
      file.orig = parts[++i];
    }
    result.files.push(file);
  }
  // 현재 브랜치의 Push 원격: 추적 중인 원격 → 브랜치에 정해 둔 원격(pushRemote) → 예전 버전의 선택(codeflow.remote) → origin → 첫 원격
  const rc = await run(repo, ['config', '--get-regexp', '^(codeflow\\.remote|remote\\..+\\.url|branch\\..+\\.pushremote)$'], { allowFail: true });
  const names = [];
  let pref = '';
  let branchPref = '';
  const branchKey = `branch.${result.branch}.pushremote `;
  for (const l of rc.stdout.split('\n')) {
    const m = l.match(/^remote\.(.+)\.url /);
    if (m) names.push(m[1]);
    else if (l.startsWith('codeflow.remote ')) pref = l.slice(16).trim();
    else if (l.startsWith(branchKey)) branchPref = l.slice(branchKey.length).trim();
  }
  result.remotes = names;
  result.remote =
    (result.upstream && names.filter((n) => result.upstream.startsWith(`${n}/`)).sort((a, c) => c.length - a.length)[0]) ||
    (names.includes(branchPref) ? branchPref : names.includes(pref) ? pref : names.includes('origin') ? 'origin' : names[0] || '');
  // 원격에 아직 없는 브랜치(처음 Push 전, 또는 원격 브랜치가 지워짐): 어느 원격에도 없는 커밋 수를 'Push 할 커밋' 으로
  if (result.branch && !result.detached && (!result.upstream || result.upstreamGone)) {
    // 쓰는 원격 기준 (다른 원격에만 있는 커밋도 이 원격에는 Push 해야 한다)
    const n = await run(repo, ['rev-list', '--count', 'HEAD', '--not', result.remote ? `--remotes=${result.remote}` : '--remotes'], { allowFail: true });
    if (n.code === 0 && +n.stdout.trim() > 0) {
      result.ahead = +n.stdout.trim();
      result.unpublished = true;
    }
  }
  result.state = await repoState(repo);
  const bisectLog = path.join(await gitDir(repo), 'BISECT_LOG');
  result.bisect = fs.existsSync(bisectLog);
  if (result.bisect) {
    const m = fs.readFileSync(bisectLog, 'utf8').match(/# first bad commit: \[([0-9a-f]+)\] (.*)/);
    if (m) result.bisectFound = { hash: m[1], subject: m[2] };
    else {
      // 로그에 결과 줄이 없어도, bad 와 good 사이에 남은 후보가 bad 하나뿐이면 찾은 것이다
      const refs = (await run(repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/bisect'], { allowFail: true })).stdout.split('\n').filter(Boolean);
      const bad = refs.find((l) => l.startsWith('refs/bisect/bad '))?.split(' ')[1];
      const goods = refs.filter((l) => l.startsWith('refs/bisect/good')).map((l) => l.split(' ')[1]);
      if (bad && goods.length) {
        const left = (await run(repo, ['rev-list', bad, '--not', ...goods], { allowFail: true })).stdout.split('\n').filter(Boolean);
        if (left.length === 1) {
          const subj = (await run(repo, ['log', '-1', '--format=%s', bad], { allowFail: true })).stdout.trim();
          result.bisectFound = { hash: bad, subject: subj };
        }
      }
    }
  }
  result.hasHead = await hasHead(repo);
  if (result.detached) {
    const h = await run(repo, ['rev-parse', '--short', 'HEAD'], { allowFail: true });
    result.headShort = h.stdout.trim();
  }
  return result;
}

async function repoState(repo) {
  const gd = await gitDir(repo);
  const ex = (f) => fs.existsSync(path.join(gd, f));
  if (ex('rebase-merge') || ex('rebase-apply')) return 'rebase';
  if (ex('MERGE_HEAD')) return 'merge';
  if (ex('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (ex('REVERT_HEAD')) return 'revert';
  return null;
}

// ---------- 파일 내용 / Diff ----------

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

async function showBlob(repo, spec) {
  const r = await run(repo, ['show', spec], { allowFail: true, raw: true });
  if (r.code !== 0) return null;
  return r.stdout;
}

function pack(buf) {
  if (buf === null || buf === undefined) return { exists: false, text: '' };
  if (buf.length > MAX_DIFF_BYTES) return { exists: true, tooLarge: true, text: '' };
  if (isBinary(buf)) return { exists: true, binary: true, text: '' };
  return { exists: true, text: buf.toString('utf8') };
}

// 작업 디렉터리 파일과 HEAD 를 비교하기 위한 양쪽 내용
async function workingFilePair(repo, file) {
  const oldPath = file.orig || file.path;
  const head = await hasHead(repo);
  const oldBuf = head && file.status !== 'untracked' && file.status !== 'added' ? await showBlob(repo, `HEAD:${oldPath}`) : null;
  const abs = path.join(repo, file.path);
  let newBuf = null;
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) newBuf = fs.readFileSync(abs);
  return {
    left: pack(oldBuf),
    right: pack(newBuf),
    leftLabel: oldBuf ? `마지막 커밋(HEAD): ${oldPath}` : '(없음)',
    rightLabel: newBuf ? `작업 중인 파일: ${file.path}` : '(삭제됨)',
    // 화면에 '현재 버전' 표시: 지금 디스크에 있는 파일이 현재 버전
    leftTag: oldBuf ? { kind: 'head', text: '마지막 커밋' } : null,
    rightTag: newBuf ? { kind: 'current', text: '현재 버전 (작업 중)' } : null,
  };
}

// 편집기 왼쪽 변경 표시용: HEAD 시점의 파일 내용 (없으면 null = 새 파일)
async function headContent(repo, relPath) {
  if (!(await hasHead(repo))) return null;
  const p = pack(await showBlob(repo, `HEAD:${relPath.replace(/\\/g, '/')}`));
  return p.exists && !p.binary && !p.tooLarge ? p.text : null;
}

// 어떤 커밋이 지금 내 버전(HEAD)과 어떤 관계인지: 화면에서 '현재 버전' 표시용
// current: HEAD 그 자체 / inHead: 현재 브랜치에 이미 들어 있음 / 그 외: 현재 브랜치에 없음
async function headRelation(repo, rev) {
  if (!rev) return null;
  const head = await run(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true });
  if (head.code !== 0) return null;
  const r = await run(repo, ['rev-parse', '--verify', '-q', `${rev}^{commit}`], { allowFail: true });
  if (r.code !== 0) return null;
  const hash = r.stdout.trim();
  if (hash === head.stdout.trim()) return { kind: 'current', text: '현재 버전 (HEAD)' };
  const anc = await run(repo, ['merge-base', '--is-ancestor', hash, 'HEAD'], { allowFail: true });
  return anc.code === 0 ? { kind: 'in', text: '현재 버전 아님 · 이미 반영된 과거 커밋' } : { kind: 'out', text: '현재 버전 아님 · 내 브랜치에 없는 커밋' };
}

// 커밋 하나에서 변경된 파일의 이전/이후 내용
async function commitFilePair(repo, hash, file) {
  const parents = (await run(repo, ['rev-list', '--parents', '-n', '1', hash])).stdout.trim().split(' ').slice(1);
  const parent = parents[0];
  const oldPath = file.orig || file.path;
  const oldBuf = parent && file.status !== 'added' ? await showBlob(repo, `${parent}:${oldPath}`) : null;
  const newBuf = file.status !== 'deleted' ? await showBlob(repo, `${hash}:${file.path}`) : null;
  return {
    left: pack(oldBuf),
    right: pack(newBuf),
    leftLabel: parent ? `이전 커밋 ${parent.slice(0, 8)}: ${oldPath}` : '(없음 — 이 커밋에서 새로 생김)',
    rightLabel: `선택한 커밋 ${hash.slice(0, 8)}: ${file.path}`,
    // 히스토리: 선택한 커밋이 무엇을 바꿨는지 (이전 커밋 → 선택한 커밋). 내 로컬 파일과의 비교가 아님
    leftTag: { kind: 'before', text: '수정 전' },
    rightTag: { kind: 'after', text: '수정 후' },
  };
}

// ---------- 커밋 ----------

async function commit(repo, { message, paths, amend, partial, sign }) {
  const partialPaths = Object.keys(partial || {});
  if (partialPaths.length && (await hasHead(repo)) && !(await repoState(repo))) {
    // 줄 단위 부분 커밋: 인덱스를 HEAD 로 맞춘 뒤 선택한 줄만 인덱스에 적용하고 인덱스 전체를 커밋한다.
    await run(repo, ['reset', '-q']);
    const full = (paths || []).filter((p) => !partialPaths.includes(p));
    if (full.length) await run(repo, ['add', '-A', '--', ...full]);
    for (const p of partialPaths) {
      const fresh = await fileHunks(repo, p);
      if (fresh.raw !== partial[p].raw) throw new GitError(`'${p}' 파일이 선택 이후에 변경되었습니다. 줄을 다시 선택하세요.`);
      const patch = buildPatch(fresh, new Set(partial[p].selected));
      if (patch) await run(repo, ['apply', '--cached', '--recount', '--whitespace=nowarn', '-'], { input: patch });
    }
    const staged = await run(repo, ['diff', '--cached', '--quiet'], { allowFail: true });
    if (staged.code === 0 && !amend) throw new GitError('커밋할 변경이 선택되지 않았습니다.');
    const args = message ? ['commit', '-F', '-'] : ['commit', '--no-edit'];
    if (amend) args.push('--amend');
    if (sign) args.push('-S');
    await run(repo, args, message ? { input: message } : {});
    return;
  }
  if (paths && paths.length) {
    await run(repo, ['add', '-A', '--', ...paths]);
  }
  const args = message ? ['commit', '-F', '-'] : ['commit', '--no-edit'];
  if (amend) args.push('--amend');
  if (sign) args.push('-S');
  // 병합 중에는 일부 파일만 커밋(partial commit)할 수 없으므로 pathspec 을 붙이지 않는다.
  const partialAllowed = (await hasHead(repo)) && !(await repoState(repo));
  if (paths && paths.length && partialAllowed) args.push('--', ...paths);
  await run(repo, args, message ? { input: message } : {});
}

// 작업 파일과 HEAD 의 차이를 덩어리(hunk)/줄 단위로 나눈다 (부분 커밋용)
async function fileHunks(repo, file) {
  const r = await run(repo, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '-U3', '--', file]);
  const raw = r.stdout;
  const lines = raw.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const header = [];
  const hunks = [];
  let cur = null;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
      cur = { header: line, oldStart: +m[1], newStart: +m[3], context: m[5] || '', lines: [] };
      hunks.push(cur);
    } else if (cur) {
      cur.lines.push({ t: line[0] || ' ', s: line.slice(1) });
    } else header.push(line);
  }
  const binary = header.some((l) => l.startsWith('Binary files'));
  return { raw, header, hunks, binary };
}

// 선택한 줄(id: "덩어리번호:줄번호")만 담은 패치를 만든다.
// 선택하지 않은 '-' 줄은 그대로 두고(문맥), 선택하지 않은 '+' 줄은 버린다.
function buildPatch(diff, selected) {
  let body = '';
  let any = false;
  diff.hunks.forEach((hk, hi) => {
    const out = [];
    let changed = false;
    let lastKept = true;
    hk.lines.forEach((ln, li) => {
      const id = `${hi}:${li}`;
      if (ln.t === '\\') {
        if (lastKept) out.push('\\' + ln.s);
        return;
      }
      if (ln.t === ' ') {
        out.push(' ' + ln.s);
        lastKept = true;
      } else if (ln.t === '-') {
        if (selected.has(id)) {
          out.push('-' + ln.s);
          changed = true;
        } else out.push(' ' + ln.s);
        lastKept = true;
      } else if (ln.t === '+') {
        if (selected.has(id)) {
          out.push('+' + ln.s);
          changed = true;
          lastKept = true;
        } else lastKept = false;
      }
    });
    if (changed) {
      any = true;
      body += `@@ -${hk.oldStart},1 +${hk.newStart},1 @@\n` + out.join('\n') + '\n';
    }
  });
  if (!any) return null;
  const header = diff.header.filter((l) => /^(diff --git|index |--- |\+\+\+ |old mode|new mode)/.test(l));
  return header.join('\n') + '\n' + body;
}

async function lastCommitMessage(repo) {
  const r = await run(repo, ['log', '-1', '--format=%B'], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : '';
}

// 변경 내용 되돌리기(IntelliJ 의 Rollback). 새로 추가된 파일은 휴지통으로 보낼 목록으로 돌려준다.
async function rollback(repo, files) {
  const head = await hasHead(repo);
  const restore = [];
  const unstage = [];
  const toTrash = [];
  for (const f of files) {
    if (f.status === 'untracked') {
      toTrash.push(f.path);
    } else if (f.status === 'added' || !head) {
      unstage.push(f.path);
      toTrash.push(f.path);
    } else if (f.status === 'renamed') {
      unstage.push(f.path);
      toTrash.push(f.path);
      restore.push(f.orig);
    } else {
      restore.push(f.path);
    }
  }
  if (unstage.length) await run(repo, ['rm', '--cached', '-r', '-f', '-q', '--', ...unstage], { allowFail: true });
  if (restore.length) await run(repo, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...restore]);
  return toTrash.map((p) => path.join(repo, p));
}

// ---------- 로그 ----------

const FS = '\x1f';
const RS = '\x1e';

async function log(repo, { limit = 500, skip = 0, all = true, ref, refs, file, search, issue, order = 'date' } = {}) {
  if (!(await hasHead(repo))) return [];
  const args = ['log', `--format=%H${FS}%P${FS}%an${FS}%ae${FS}%at${FS}%D${FS}%s${RS}`, `-n`, String(limit), `--skip=${skip}`];
  if (file) {
    args.push('--follow');
  } else {
    // date: IntelliJ 처럼 커밋 날짜순(부모는 항상 자식 뒤), topo: 브랜치별로 묶어서
    args.push(order === 'topo' ? '--topo-order' : '--date-order');
    if (refs && refs.length) args.push(...refs);
    else if (ref) args.push(ref);
    else if (all) args.push('--branches', '--remotes', '--tags', 'HEAD');
  }
  if (search) args.push('-i', `--grep=${search}`);
  // 이슈 번호를 언급한 커밋: '#56 ...', 'Closes #56', 이슈 브랜치 병합 'Merge branch '56-로그인'' / 'issue-56-...'
  if (issue && /^\d+$/.test(String(issue))) {
    const n = String(issue);
    args.push('-E', '-i', `--grep=(#${n}([^0-9]|$))|(['/ ]${n}-[^0-9])|(issue-${n}([^0-9]|$))`);
    if (search) args.push('--all-match');
  }
  if (file) args.push('--', file);
  const r = await run(repo, args);
  return r.stdout
    .split(RS)
    .map((s) => s.replace(/^\n/, ''))
    .filter(Boolean)
    .map((line) => {
      const [hash, parents, author, email, time, refs, subject] = line.split(FS);
      return {
        hash,
        parents: parents ? parents.split(' ') : [],
        author,
        email,
        time: +time * 1000,
        refs: refs ? refs.split(', ').filter(Boolean) : [],
        subject,
      };
    });
}

function parseNameStatus(out) {
  const parts = out.split('\0').filter((s, i, a) => !(s === '' && i === a.length - 1));
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    const c = code[0];
    if (c === 'R' || c === 'C') {
      const orig = parts[++i];
      const p = parts[++i];
      files.push({ path: p, orig, status: c === 'R' ? 'renamed' : 'added' });
    } else {
      const p = parts[++i];
      const map = { A: 'added', D: 'deleted', M: 'modified', T: 'modified' };
      files.push({ path: p, status: map[c] || 'modified' });
    }
  }
  return files;
}

// 여러 커밋의 정보 + 변경 파일 (첫 번째 부모 기준) — 히스토리에서 여러 커밋을 골랐을 때
async function commitsFiles(repo, hashes) {
  const out = [];
  for (const hash of hashes.slice(0, 500)) {
    const r = await run(repo, ['show', '-s', `--format=%H${FS}%P${FS}%an${FS}%at${FS}%s`, hash]);
    const [h, parents, author, at, subject] = r.stdout.trim().split(FS);
    const ps = parents ? parents.split(' ') : [];
    const diff = ps.length
      ? await run(repo, ['diff', '--name-status', '-z', '-M', ps[0], h])
      : await run(repo, ['show', '--name-status', '-z', '-M', '--format=', h]);
    out.push({ hash: h, parents: ps, author, time: +at * 1000, subject, files: parseNameStatus(diff.stdout) });
  }
  return out;
}

async function commitDetails(repo, hash) {
  const r = await run(repo, ['show', '-s', `--format=%H${FS}%P${FS}%an${FS}%ae${FS}%at${FS}%cn${FS}%ct${FS}%D${FS}%G?${FS}%GS${FS}%B`, hash]);
  const [h, parents, author, email, at, committer, ct, refs, sig, signer, body] = r.stdout.split(FS);
  const parentList = parents ? parents.split(' ') : [];
  let files;
  if (parentList.length) {
    files = parseNameStatus((await run(repo, ['diff', '--name-status', '-z', '-M', parentList[0], h])).stdout);
  } else {
    files = parseNameStatus((await run(repo, ['diff-tree', '--root', '-r', '--no-commit-id', '--name-status', '-z', '-M', h])).stdout);
  }
  return {
    hash: h,
    parents: parentList,
    author,
    email,
    time: +at * 1000,
    committer,
    commitTime: +ct * 1000,
    refs: refs ? refs.split(', ').filter(Boolean) : [],
    body: (body || '').trim(),
    signature: sig && sig !== 'N' ? { status: sig, signer } : null,
    files,
  };
}

// ---------- 공통 ----------

// 병합/리베이스 등은 충돌이 나도 예외 대신 결과를 돌려준다(충돌 해결 화면으로 넘어가기 위함).
async function mergeLike(repo, args, opts = {}) {
  const r = await run(repo, args, { allowFail: true, ...opts });
  if (r.code === 0) return { ok: true, output: (r.stdout + r.stderr).trim() };
  const st = await repoState(repo);
  const s = await status(repo);
  const conflicts = s.files.filter((f) => f.status === 'conflict');
  if (st || conflicts.length) return { ok: false, conflict: true, conflicts: conflicts.length, output: (r.stdout + r.stderr).trim() };
  throw new GitError((r.stderr || r.stdout).trim(), r);
}

// ---------- 스태시 (IntelliJ 의 Shelve 와 비슷) ----------

async function stashList(repo) {
  const r = await run(repo, ['stash', 'list', `--format=%gd${FS}%s${FS}%at`], { allowFail: true });
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [ref, subject, at] = l.split(FS);
      return { ref, subject, time: +at * 1000 };
    });
}

async function stashSave(repo, message, paths) {
  const args = ['stash', 'push', '-u'];
  if (message) args.push('-m', message);
  if (paths && paths.length && paths.join(' ').length > MAX_CMDLINE) {
    // git stash 는 파일 목록을 안에서 다시 명령줄로 넘겨서, 파일이 아주 많으면 Windows 에서 실패한다.
    // 바뀐 파일을 모두 골랐으면 목록 없이 전체를 보관한다.
    const changed = (await run(repo, ['status', '--porcelain', '-z', '-uall'])).stdout.split('\0').filter((l) => /^.. /.test(l)).map((l) => l.slice(3));
    const picked = new Set(paths);
    if (changed.some((p) => !picked.has(p))) throw new GitError(`파일이 너무 많아(${paths.length}개) 일부만 보관할 수 없습니다. 모두 선택해서 보관하거나, 폴더를 나눠 여러 번 보관하세요.`);
    paths = null;
  }
  if (paths && paths.length) args.push('--', ...paths);
  await run(repo, args);
}

const stashApply = (repo, ref) => mergeLike(repo, ['stash', 'apply', ref]);
const stashPop = (repo, ref) => mergeLike(repo, ['stash', 'pop', ref]);
async function stashDrop(repo, ref) {
  await run(repo, ['stash', 'drop', ref]);
}

async function stashFiles(repo, ref) {
  const r = await run(repo, ['stash', 'show', '--name-status', '-z', '-M', '--include-untracked', ref], { allowFail: true });
  if (r.code === 0) return parseNameStatus(r.stdout);
  // 오래된 git 은 --include-untracked 미지원
  return parseNameStatus((await run(repo, ['stash', 'show', '--name-status', '-z', '-M', ref])).stdout);
}

// ---------- 충돌 해결 ----------

async function conflictInfo(repo, file) {
  const abs = path.join(repo, file);
  const working = fs.existsSync(abs) ? fs.readFileSync(abs) : null;
  const ours = await showBlob(repo, `:2:${file}`);
  const theirs = await showBlob(repo, `:3:${file}`);
  const base = await showBlob(repo, `:1:${file}`);
  return { working: pack(working), ours: pack(ours), theirs: pack(theirs), base: pack(base) };
}

// 충돌 화면에서 양쪽(ours/theirs)이 각각 무엇인지: 어느 쪽이 '현재 버전(내 작업)' 인지 알려 주기 위해
async function conflictSides(repo) {
  const state = await repoState(repo);
  const gd = await gitDir(repo);
  const read = (f) => {
    try {
      return fs.readFileSync(path.join(gd, f), 'utf8').trim();
    } catch {
      return '';
    }
  };
  const nameOf = async (rev) => {
    if (!rev) return '';
    const n = await run(repo, ['name-rev', '--name-only', '--no-undefined', '--exclude=refs/tags/*', rev], { allowFail: true });
    const name = n.code === 0 ? n.stdout.trim().replace(/^remotes\//, '') : '';
    return name && !/[~^]/.test(name) ? name : rev.slice(0, 8);
  };
  const subject = async (rev) => (rev ? (await run(repo, ['log', '-1', '--format=%s', rev], { allowFail: true })).stdout.trim() : '');
  const cur = await run(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true });
  const branch = cur.stdout.trim();
  if (state === 'rebase') {
    // 리베이스: ours = 옮겨 갈 기준(onto), theirs = 내 브랜치의 커밋을 하나씩 다시 적용하는 중
    const dir = fs.existsSync(path.join(gd, 'rebase-merge')) ? 'rebase-merge' : 'rebase-apply';
    const onto = read(`${dir}/onto`);
    const mine = read(`${dir}/head-name`).replace(/^refs\/heads\//, '');
    const stopped = read('REBASE_HEAD') || read(`${dir}/stopped-sha`);
    return {
      state,
      mine: 'theirs',
      ours: { name: await nameOf(onto), role: '리베이스 기준 (옮겨 갈 곳)' },
      theirs: { name: mine || '내 브랜치', role: '내 커밋 (다시 적용 중)', commit: stopped.slice(0, 8), subject: await subject(stopped) },
    };
  }
  const other = read('MERGE_HEAD').split('\n')[0] || read('CHERRY_PICK_HEAD') || read('REVERT_HEAD');
  const role = { merge: '병합해 오는 쪽', 'cherry-pick': '가져오는 커밋', revert: '되돌리는 커밋' }[state] || '상대 쪽';
  let otherName = state === 'merge' ? (read('MERGE_MSG').match(/^Merge (?:remote-tracking )?branch '([^']+)'/) || [])[1] : '';
  if (!otherName) otherName = state === 'merge' ? await nameOf(other) : other.slice(0, 8);
  return {
    state,
    mine: 'ours',
    ours: { name: branch || '(분리된 HEAD)', role: '현재 브랜치' },
    theirs: { name: otherName, role, commit: other.slice(0, 8), subject: state === 'merge' ? '' : await subject(other) },
  };
}

async function resolveWithContent(repo, file, content) {
  fs.writeFileSync(path.join(repo, file), content, 'utf8');
  await run(repo, ['add', '--', file]);
}

async function resolveSide(repo, file, side) {
  const stage = side === 'ours' ? 2 : 3;
  const exists = await run(repo, ['cat-file', '-e', `:${stage}:${file}`], { allowFail: true });
  if (exists.code !== 0) {
    // 선택한 쪽에서 파일이 삭제된 경우
    await run(repo, ['rm', '-q', '-f', '--', file]);
    return;
  }
  await run(repo, ['checkout', `--${side}`, '--', file]);
  await run(repo, ['add', '--', file]);
}

// ---------- 기타 ----------

async function init(dir) {
  await run(dir, ['init']);
}

async function clone(url, dir) {
  const parent = path.dirname(dir);
  fs.mkdirSync(parent, { recursive: true });
  await run(parent, ['clone', url, dir]);
}

async function createTag(repo, name, hash, message) {
  if (message) await run(repo, ['tag', '-a', name, hash, '-m', message]);
  else await run(repo, ['tag', name, hash]);
}

async function deleteTag(repo, name) {
  await run(repo, ['tag', '-d', name]);
}

async function config(repo) {
  const get = async (k) => (await run(repo, ['config', '--get', k], { allowFail: true })).stdout.trim();
  return {
    userName: await get('user.name'),
    userEmail: await get('user.email'),
    signingKey: await get('user.signingkey'),
    gpgFormat: (await get('gpg.format')) || 'openpgp',
  };
}

async function setConfig(repo, { userName, userEmail, global, signingKey, gpgFormat }) {
  const scope = global ? ['--global'] : [];
  if (signingKey !== undefined) {
    if (signingKey) await run(repo, ['config', ...scope, 'user.signingkey', signingKey]);
    else await run(repo, ['config', ...scope, '--unset', 'user.signingkey'], { allowFail: true });
  }
  if (gpgFormat !== undefined) await run(repo, ['config', ...scope, 'gpg.format', gpgFormat]);
  if (userName !== undefined) await run(repo, ['config', ...scope, 'user.name', userName]);
  if (userEmail !== undefined) await run(repo, ['config', ...scope, 'user.email', userEmail]);
}

async function addToGitignore(repo, pattern) {
  const p = path.join(repo, '.gitignore');
  let content = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  if (content && !content.endsWith('\n')) content += '\n';
  fs.writeFileSync(p, content + pattern + '\n', 'utf8');
}

module.exports = {
  GitError,
  run,
  FS,
  RS,
  hasHead,
  headRelation,
  repoState,
  gitDir,
  showBlob,
  pack,
  parseNameStatus,
  mergeLike,
  fileHunks,
  buildPatch,
  topLevel,
  trustDir,
  setGitCacheFile,
  scanForGit,
  toWinPath,
  status,
  workingFilePair,
  headContent,
  commitFilePair,
  commit,
  lastCommitMessage,
  rollback,
  log,
  commitDetails,
  stashList,
  stashSave,
  stashApply,
  stashPop,
  stashDrop,
  stashFiles,
  conflictInfo,
  conflictSides,
  resolveWithContent,
  resolveSide,
  init,
  clone,
  createTag,
  deleteTag,
  config,
  setConfig,
  addToGitignore,
  commitsFiles,
};

// 브랜치·병합·원격은 git-branch.js 에 있다 (그 파일이 여기 exports 를 쓰므로 반드시 exports 를 만든 뒤에 불러야 한다)
Object.assign(module.exports, require('./git-branch'));
