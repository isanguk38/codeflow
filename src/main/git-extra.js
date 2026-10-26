// 고급 Git 기능: 대화형 리베이스, 여러 커밋 처리, Blame, Reflog, 비교
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, GitError, FS, RS, hasHead, gitDir, showBlob, pack, parseNameStatus, mergeLike, headRelation } = require('./git');

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
  const short = (r) => (/^[0-9a-f]{40}$/.test(r) ? r.slice(0, 8) : r);
  // 어느 쪽이 지금 내 버전(HEAD)인지, 아니면 현재 브랜치에 들어 있는지 표시
  const [lt, rt] = await Promise.all([headRelation(repo, a), headRelation(repo, b)]);
  return {
    left: pack(left),
    right: pack(right),
    leftLabel: `${short(a)}: ${oldPath}`,
    rightLabel: `${short(b)}: ${file.path}`,
    leftTag: lt?.kind === 'current' ? lt : null,
    rightTag: rt,
  };
}

// ---------- Bisect ----------

// 다른 도구에서 시작한 bisect 상태를 끝내기 위한 종료만 남겨 둔다
async function bisectReset(repo) {
  await run(repo, ['bisect', 'reset']);
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
  bisectReset,
};
