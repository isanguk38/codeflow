// 프로젝트 전체 검색 (IntelliJ 'Find in Files' 처럼): 파일·폴더 이름 + 파일 내용
// - 대상: git 이 아는 파일 + 아직 추가 안 한 새 파일 (.gitignore 로 무시한 것과 .git 은 제외)
// - 결과는 찾는 대로 조금씩 화면에 보낸다 (search:found), 끝나면 search:done
const fs = require('fs');
const path = require('path');
const git = require('./git');

const MAX_FILE = 3 * 1024 * 1024; // 이보다 큰 파일은 내용 검색 생략
const MAX_LINES = 2000; // 내용 결과 줄 수 한도 (넘으면 멈추고 '앞부분만' 표시)
const PER_FILE = 100;
const MAX_NAMES = 100;

const running = new Map(); // id → { cancelled }

async function projectFiles(repo) {
  const r = await git.run(repo, ['-c', 'core.quotepath=off', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { allowFail: true });
  if (r.code === 0) return [...new Set(r.stdout.split('\0').filter(Boolean))];
  // git 저장소가 아니면 직접 훑는다 (node_modules 등 큰 폴더는 제외)
  const out = [];
  const skip = new Set(['.git', 'node_modules', '.idea', '.vscode', 'build', 'dist', 'target', 'out']);
  const walk = (dir, rel) => {
    let list = [];
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      if (out.length > 200000) return;
      const r2 = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) !skip.has(e.name) && walk(path.join(dir, e.name), r2);
      else if (e.isFile()) out.push(r2);
    }
  };
  walk(repo, '');
  return out;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildRegex({ query, matchCase, words, regex }) {
  let src = regex ? query : escRe(query);
  // \b 는 한글을 단어로 보지 않으므로 유니코드 글자 기준으로 단어 경계를 잡는다
  if (words) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
  return new RegExp(src, `gm${matchCase ? '' : 'i'}u`);
}

// '*.java, *.ts, !*.min.js' → (경로) => boolean
function maskFilter(mask) {
  const parts = String(mask || '')
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return () => true;
  const toRe = (g) => new RegExp(`^${g.split('*').map(escRe).join('.*').replace(/\\\?/g, '.')}$`, 'i');
  const inc = parts.filter((p) => !p.startsWith('!')).map((p) => ({ re: toRe(p), full: p.includes('/') }));
  const exc = parts.filter((p) => p.startsWith('!')).map((p) => ({ re: toRe(p.slice(1)), full: p.includes('/') }));
  const hit = (list, rel) => list.some(({ re, full }) => re.test(full ? rel : rel.slice(rel.lastIndexOf('/') + 1)));
  return (rel) => (!inc.length || hit(inc, rel)) && !hit(exc, rel);
}

// 읽어 보지 않아도 글자 파일이 아닌 것 (처음 검색할 때 디스크를 덜 읽도록)
const BIN_EXT = /\.(class|jar|war|ear|zip|7z|gz|tgz|rar|exe|dll|so|dylib|pdb|obj|o|a|lib|bin|dat|db|sqlite|png|jpe?g|gif|bmp|ico|webp|tiff?|psd|pdf|docx?|xlsx?|pptx?|hwp|mp[34]|avi|mov|wav|ogg|woff2?|ttf|otf|eot|keystore|jks|p12)$/i;

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// opts: { query, matchCase, words, regex, mask, dir(상대 경로 범위) }
async function start(repo, id, opts, send) {
  const job = { cancelled: false };
  running.set(id, job);
  const t0 = Date.now();
  try {
    if (!opts.query) return send('done', { id, total: 0, files: 0, ms: 0 });
    let re;
    try {
      re = buildRegex(opts);
    } catch (e) {
      return send('done', { id, error: `정규식 오류: ${e.message}` });
    }
    const scope = (opts.dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const inScope = (rel) => !scope || rel === scope || rel.startsWith(`${scope}/`);
    const okMask = maskFilter(opts.mask);
    const all = (await projectFiles(repo)).filter(inScope);

    // 1) 이름이 맞는 파일·폴더
    const names = [];
    const dirs = new Set();
    for (const rel of all) {
      const segs = rel.split('/');
      for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
    }
    const nameHit = (rel) => {
      const base = rel.slice(rel.lastIndexOf('/') + 1);
      re.lastIndex = 0;
      return re.test(base);
    };
    for (const d of dirs) if (names.length < MAX_NAMES && inScope(d) && d !== scope && nameHit(d)) names.push({ rel: d, dir: true });
    for (const rel of all) if (names.length < MAX_NAMES && okMask(rel) && nameHit(rel)) names.push({ rel, dir: false });
    send('found', { id, names });
    if (opts.namesOnly) return send('done', { id, total: 0, files: 0, searched: 0, namesOnly: true, ms: Date.now() - t0 });

    // 2) 파일 내용
    const targets = all.filter((rel) => okMask(rel) && !BIN_EXT.test(rel));
    let total = 0;
    let fileCount = 0;
    let truncated = false;
    let batch = [];
    let lastSend = Date.now();
    const flush = (force) => {
      if (batch.length && (force || Date.now() - lastSend > 120)) {
        send('found', { id, hits: batch });
        batch = [];
        lastSend = Date.now();
      }
    };
    let next = 0;
    const worker = async () => {
      while (!job.cancelled && !truncated && next < targets.length) {
        const rel = targets[next++];
        const abs = path.join(repo, rel);
        let buf;
        try {
          const st = await fs.promises.stat(abs);
          if (!st.isFile() || st.size > MAX_FILE || st.size === 0) continue;
          buf = await fs.promises.readFile(abs);
        } catch {
          continue;
        }
        if (isBinary(buf)) continue;
        const text = buf.toString('utf8');
        re.lastIndex = 0;
        if (!re.test(text)) continue;
        const lines = text.split(/\r?\n/);
        const found = [];
        for (let i = 0; i < lines.length && found.length < PER_FILE; i++) {
          const line = lines[i];
          re.lastIndex = 0;
          const ranges = [];
          let m;
          while ((m = re.exec(line)) && ranges.length < 50) {
            if (!m[0].length) {
              re.lastIndex++;
              continue;
            }
            ranges.push([m.index, m[0].length]);
          }
          if (ranges.length) found.push({ line: i + 1, text: line.length > 400 ? line.slice(0, 400) : line, ranges });
        }
        if (!found.length) continue;
        if (job.cancelled || truncated) return;
        fileCount++;
        total += found.length;
        batch.push({ rel, matches: found });
        if (total >= MAX_LINES) truncated = true;
        flush(false);
      }
    };
    await Promise.all(Array.from({ length: 12 }, worker));
    if (job.cancelled) return;
    flush(true);
    send('done', { id, total, files: fileCount, searched: targets.length, truncated, ms: Date.now() - t0 });
  } catch (e) {
    send('done', { id, error: e.message || String(e) });
  } finally {
    running.delete(id);
  }
}

function cancel(id) {
  const job = running.get(id);
  if (job) job.cancelled = true;
}

module.exports = { start, cancel, maskFilter, buildRegex };

// 별도 스레드(worker)로 실행될 때: 메인 프로세스가 검색 때문에 멈추지 않도록 (멈추면 창 전체가 버벅임)
const { parentPort, isMainThread } = require('worker_threads');
if (!isMainThread && parentPort) {
  parentPort.on('message', (m) => {
    if (m.type === 'start') start(m.repo, m.id, m.opts, (kind, data) => parentPort.postMessage({ kind, data }));
    else if (m.type === 'cancel') cancel(m.id);
  });
}
