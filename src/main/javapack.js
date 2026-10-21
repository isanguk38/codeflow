// Java 언어 팩: Eclipse JDT Language Server(VS Code Java 확장과 같은 엔진)를 필요할 때 내려받아 내 PC 에서 실행한다.
// - Red Hat 의 VS Code Java 확장(EPL-2.0, Open VSX 배포)에서 언어 서버 + Java 21 실행 환경 + Lombok 을 한 번에 받는다.
//   (Eclipse 다운로드 서버보다 훨씬 빠르고, 언어 서버가 요구하는 Java 21 을 따로 받을 필요가 없다)
// - 프로젝트 검사 기준 JDK(1.8, 11, 17 …)는 PC 에 설치된 JDK 들을 등록해 두면 pom.xml / build.gradle 설정에 맞춰 자동으로 고른다.
const { app, net } = require('electron');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');

const PACK = {
  version: '1.56.0',
  url: 'https://open-vsx.org/api/redhat/java/win32-x64/1.56.0/file/redhat.java-1.56.0@win32-x64.vsix',
};
const MIN_RUNTIME = 21;

const packDir = () => path.join(app.getPath('userData'), 'language-packs', 'java');
const serverDir = () => path.join(packDir(), 'jdtls');
const jreDir = () => path.join(packDir(), 'jre');
const lombokJar = () => path.join(packDir(), 'lombok.jar');
// 사용자가 폴더에서 직접 고른 JDK 목록 (언어 팩을 지워도 남도록 language-packs 바깥에 저장)
const customFile = () => path.join(app.getPath('userData'), 'custom-jdks.json');
function customJdks() {
  try {
    return JSON.parse(fs.readFileSync(customFile(), 'utf8'));
  } catch {
    return [];
  }
}
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'); // Windows 10 이상 기본 포함 (tar.gz, zip 모두 풂)

// ---------- 설치된 JDK/JRE 찾기 ----------

function readRelease(home) {
  try {
    const txt = fs.readFileSync(path.join(home, 'release'), 'utf8');
    const m = txt.match(/JAVA_VERSION="([^"]+)"/);
    if (m) return m[1];
  } catch {}
  // 아주 오래된 JDK(1.6 등)는 release 파일이 없다 → 폴더 이름(jdk1.6.0_45)에서 버전을 읽는다
  const m = path.basename(home).match(/(?:jdk|jre)-?(1\.\d+(?:\.\d+)?(?:_\d+)?|\d+(?:\.\d+)*)/i);
  return m ? m[1] : null;
}

const majorOf = (v) => {
  const m = String(v).match(/^(\d+)(?:\.(\d+))?/);
  if (!m) return 0;
  return m[1] === '1' ? +m[2] : +m[1];
};

// JDT LS 가 이해하는 실행 환경 이름
const runtimeName = (major) => (major <= 5 ? 'J2SE-1.5' : major <= 8 ? `JavaSE-1.${major}` : `JavaSE-${major}`);

// IntelliJ 에 등록해 둔 JDK (Project SDK 이름 → 경로). 가장 최근에 쓴 IntelliJ 설정을 읽는다
function intellijJdkTable() {
  const base = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'JetBrains');
  let files = [];
  try {
    files = fs
      .readdirSync(base)
      .filter((d) => /^(IntelliJIdea|IdeaIC|IntelliJ)/i.test(d))
      .map((d) => path.join(base, d, 'options', 'jdk.table.xml'))
      .filter((f) => fs.existsSync(f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch {}
  if (!files.length) return [];
  const xml = fs.readFileSync(files[0], 'utf8');
  const out = [];
  for (const block of xml.split(/<jdk\b/).slice(1)) {
    const val = (tag) => (block.match(new RegExp(`<${tag} value="([^"]*)"`)) || [])[1];
    if (val('type') !== 'JavaSDK') continue;
    const home = (val('homePath') || '').replace(/\$USER_HOME\$/g, os.homedir()).replace(/\//g, path.sep);
    if (home) out.push({ name: val('name'), home });
  }
  return out;
}

function detectJdks() {
  const roots = new Set();
  const addParent = (dir) => {
    try {
      for (const d of fs.readdirSync(dir)) roots.add(path.join(dir, d));
    } catch {}
  };
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  for (const base of pf) for (const vendor of ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'Amazon Corretto', 'Zulu', 'Microsoft', 'BellSoft', 'OpenJDK', 'Semeru']) addParent(path.join(base, vendor));
  addParent(path.join(os.homedir(), '.jdks')); // IntelliJ 가 받아 둔 JDK
  for (const j of intellijJdkTable()) roots.add(j.home); // IntelliJ 에 등록된 JDK (예: C:/dev/.../jdk1.7)
  if (process.env.JAVA_HOME) roots.add(process.env.JAVA_HOME);
  for (const c of customJdks()) roots.add(c);
  roots.add(jreDir());
  const list = [];
  const seen = new Set();
  for (const home of roots) {
    const exe = path.join(home, 'bin', 'java.exe');
    if (!fs.existsSync(exe)) continue;
    const real = fs.realpathSync(home).toLowerCase();
    if (seen.has(real)) continue;
    seen.add(real);
    const version = readRelease(home);
    if (!version) continue;
    const major = majorOf(version);
    list.push({ home, version, major, name: runtimeName(major), jdk: fs.existsSync(path.join(home, 'bin', 'javac.exe')), bundled: home === jreDir() });
  }
  return list.sort((a, b) => b.major - a.major);
}

// 언어 서버를 실행할 Java (21 이상). 언어 팩에 들어 있는 실행 환경을 우선 사용
function findRuntime() {
  const all = detectJdks();
  return all.find((j) => j.bundled && j.major >= MIN_RUNTIME) || all.find((j) => j.major >= MIN_RUNTIME) || null;
}

// 프로젝트 검사 기준으로 등록할 JDK 목록 (같은 버전이 여럿이면 JDK 우선, 최신 우선)
// default: 빌드 도구(Maven/Gradle)가 없는 프로젝트가 쓸 JDK
//   사용자가 고른 JDK → 설정의 Java 버전에 맞는 JDK → 설치된 가장 최신 JDK 순서
function projectRuntimes(preferredHome, project = {}) {
  const all = detectJdks().filter((j) => !j.bundled);
  const byName = new Map();
  for (const j of all) {
    const cur = byName.get(j.name);
    if (!cur || (!cur.jdk && j.jdk)) byName.set(j.name, j);
  }
  const want = preferredHome || project.jdkHome;
  let def = want ? all.find((j) => j.home.toLowerCase() === want.toLowerCase()) : null;
  const managed = ['Maven', 'Gradle'].includes(project.build);
  if (!def && project.level && !managed) def = byName.get(runtimeName(majorOf(project.level))) || null;
  // 버전을 알 수 없는 프로젝트: 설치된 JDK 중 가장 최신 것으로 (기준이 없으면 언어 서버가 자기 실행용 Java 21 로 검사해 버린다)
  if (!def && !managed) def = all.find((j) => j.jdk) || all[0] || null;
  if (def) byName.set(def.name, def);
  // 주의: default:false 를 명시하면 언어 서버가 기본 JDK 를 다시 바꿔 버린다 → 기본인 것에만 default:true 를 붙인다
  return [...byName.values()].map((j) => (def && j.home === def.home ? { name: j.name, path: j.home, default: true } : { name: j.name, path: j.home }));
}

// 폴더에서 직접 고른 JDK 추가 (IntelliJ 의 'Add SDK → JDK' 와 같음). bin/java.exe 와 release 파일로 확인
function addCustomJdk(home) {
  let dir = home;
  // bin 폴더나 그 안의 파일을 골랐어도 JDK 최상위 폴더를 찾아 준다
  for (let i = 0; i < 2 && !fs.existsSync(path.join(dir, 'bin', 'java.exe')); i++) dir = path.dirname(dir);
  if (!fs.existsSync(path.join(dir, 'bin', 'java.exe'))) throw new Error('선택한 폴더에서 bin\\java.exe 를 찾을 수 없습니다. JDK 설치 폴더(예: C:\\Program Files\\Java\\jdk-1.8)를 선택하세요.');
  const version = readRelease(dir);
  if (!version) throw new Error('JDK 버전을 확인할 수 없습니다 (release 파일 없음).');
  const list = customJdks().filter((p) => p.toLowerCase() !== dir.toLowerCase());
  list.push(dir);
  fs.writeFileSync(customFile(), JSON.stringify(list, null, 2));
  return { home: dir, version, major: majorOf(version), jdk: fs.existsSync(path.join(dir, 'bin', 'javac.exe')) };
}

// ---------- 설치 상태 / 설치 / 제거 ----------

function launcherJar() {
  try {
    const f = fs.readdirSync(path.join(serverDir(), 'plugins')).find((n) => /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(n));
    return f ? path.join(serverDir(), 'plugins', f) : null;
  } catch {
    return null;
  }
}

function status() {
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(packDir(), 'pack.json'), 'utf8'));
  } catch {}
  const rt = findRuntime();
  return {
    installed: !!launcherJar(),
    version: meta.version || null,
    latest: PACK.version,
    runtime: rt ? { home: rt.home, version: rt.version, bundled: rt.bundled } : null,
    needsRuntime: !rt,
    jdks: detectJdks().filter((j) => !j.bundled).map((j) => ({ home: j.home, version: j.version, major: j.major, jdk: j.jdk })),
  };
}

async function download(url, file, onProgress) {
  const res = await net.fetch(url);
  if (!res.ok || !res.body) throw new Error(`내려받지 못했습니다 (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(file);
  const reader = res.body.getReader();
  let got = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(value)) await once(out, 'drain');
      onProgress(got, total);
    }
  } finally {
    out.end();
    await once(out, 'close');
  }
  if (total && got !== total) throw new Error('끝까지 받지 못했습니다. 다시 시도하세요.');
}

function extract(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  return new Promise((resolve, reject) =>
    execFile(TAR, ['-xf', archive, '-C', dest], { windowsHide: true, maxBuffer: 1 << 24 }, (err, _o, stderr) => (err ? reject(new Error(`압축을 풀지 못했습니다: ${stderr || err.message}`)) : resolve()))
  );
}

let installing = null;

function rmQuiet(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}
}

// progress({ step, percent, message })
function install(progress) {
  if (installing) return installing;
  installing = (async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codeflow-java-'));
    try {
      fs.mkdirSync(packDir(), { recursive: true });
      const vsix = path.join(tmp, 'java.vsix');
      await download(PACK.url, vsix, (g, t) =>
        progress({ step: 'download', percent: t ? Math.floor((g / t) * 100) : -1, message: `Java 언어 팩 내려받는 중 ${(g / 1e6).toFixed(0)}MB${t ? ` / ${(t / 1e6).toFixed(0)}MB` : ''}` })
      );
      progress({ step: 'extract', percent: 100, message: '압축 푸는 중...' });
      const stage = path.join(tmp, 'x');
      await extract(vsix, stage); // .vsix 는 zip 형식
      const ext = path.join(stage, 'extension');
      const jreParent = path.join(ext, 'jre');
      const jreInner = fs.existsSync(jreParent) ? fs.readdirSync(jreParent).map((d) => path.join(jreParent, d)).find((d) => fs.existsSync(path.join(d, 'bin', 'java.exe'))) : null;
      if (!fs.existsSync(path.join(ext, 'server', 'plugins')) || !jreInner) throw new Error('언어 팩 파일 구성이 예상과 다릅니다.');
      progress({ step: 'extract', percent: 100, message: '설치하는 중...' });
      fs.rmSync(serverDir(), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      fs.rmSync(jreDir(), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      fs.cpSync(path.join(ext, 'server'), serverDir(), { recursive: true });
      fs.cpSync(jreInner, jreDir(), { recursive: true });
      const lombok = fs.existsSync(path.join(ext, 'lombok')) ? fs.readdirSync(path.join(ext, 'lombok')).find((f) => f.endsWith('.jar')) : null;
      if (lombok) fs.copyFileSync(path.join(ext, 'lombok', lombok), lombokJar());
      fs.writeFileSync(path.join(packDir(), 'pack.json'), JSON.stringify({ version: PACK.version, installedAt: new Date().toISOString() }));
      progress({ step: 'done', percent: 100, message: '설치 완료' });
      return status();
    } finally {
      // 임시 파일 정리는 실패해도 설치에는 영향이 없게 (Windows 파일 잠금으로 가끔 실패)
      rmQuiet(tmp);
      installing = null;
    }
  })();
  return installing;
}

function remove() {
  fs.rmSync(packDir(), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  return status();
}

// ---------- 프로젝트 정보 ----------
// 1) pom.xml (Maven)  2) build.gradle (Gradle) → 빌드 파일이 라이브러리를 관리
// 3) 그 밖: 폴더 분석(소스 폴더, 모든 jar) + Eclipse .classpath 가 있으면 그 설정도 합친다 (.idea 는 읽지 않음)

const readText = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};

function eclipseProject(root) {
  const cp = readText(path.join(root, '.classpath'));
  if (!cp || !fs.existsSync(path.join(root, '.project'))) return null;
  const prefs = readText(path.join(root, '.settings', 'org.eclipse.jdt.core.prefs')) || '';
  const level = (prefs.match(/org\.eclipse\.jdt\.core\.compiler\.compliance=([\d.]+)/) || cp.match(/JavaSE-([\d.]+)/) || [])[1] || null;
  const libraries = [];
  const sourcePaths = [];
  for (const m of cp.matchAll(/<classpathentry\b([^>]*)>/g)) {
    const kind = (m[1].match(/\bkind="([^"]+)"/) || [])[1];
    const p = (m[1].match(/\bpath="([^"]+)"/) || [])[1];
    if (!p) continue;
    if (kind === 'lib') libraries.push(path.resolve(root, p));
    else if (kind === 'src' && !p.startsWith('/')) sourcePaths.push(p);
  }
  return { build: 'Eclipse', file: 'Eclipse 설정', level, jdkHome: null, libraries: libraries.filter((f) => fs.existsSync(f)), sourcePaths };
}

// ---------- 프로젝트 분석 (IntelliJ 의 'Create project from existing sources' 와 같은 일) ----------
// 프로젝트 폴더 전체를 훑어서
//  - 소스 폴더: .java 파일의 package 선언과 폴더 위치를 맞춰 찾는다. 예) JavaSource/com/acme/A.java + package com.acme; → JavaSource
//  - 라이브러리: 프로젝트 안의 모든 .jar (WEB-INF/lib, lib, jars … 어디에 있든)
// 빌드 결과물 폴더(target, build, out, bin, classes)와 node_modules 등은 건너뛴다.
const SKIP_DIRS = new Set(['node_modules', 'target', 'build', 'out', 'bin', 'classes', 'dist']);
const SCAN_MAX_ENTRIES = 80000;

async function sourceRootOf(file) {
  let head = '';
  try {
    const fh = await fs.promises.open(file, 'r');
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(8192), 0, 8192, 0);
    await fh.close();
    head = buffer.slice(0, bytesRead).toString('utf8');
  } catch {
    return null;
  }
  const pkg = (head.replace(/\/\*[\s\S]*?\*\//g, '').match(/^\s*package\s+([\w.]+)\s*;/m) || [])[1];
  const dir = path.dirname(file);
  if (!pkg) return dir;
  const pkgPath = path.sep + pkg.split('.').join(path.sep);
  if (!dir.toLowerCase().endsWith(pkgPath.toLowerCase())) return null; // 위치가 안 맞는 파일은 판단에서 제외
  return dir.slice(0, dir.length - pkgPath.length);
}

async function scanProject(root) {
  const jars = [];
  const roots = new Set();
  let entries = 0;
  const walk = async (dir, depth) => {
    if (depth > 14 || entries > SCAN_MAX_ENTRIES) return;
    let list;
    try {
      list = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries += list.length;
    let tries = 0; // 한 폴더에서 .java 파일 몇 개만 보면 충분
    let found = false;
    for (const e of list) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(p, depth + 1);
      } else if (/\.jar$/i.test(e.name)) {
        if (!/-(sources|javadoc)\.jar$/i.test(e.name)) jars.push(p);
      } else if (!found && tries < 3 && e.name.endsWith('.java')) {
        tries++;
        const r = await sourceRootOf(p);
        if (r) {
          roots.add(r);
          found = true;
        }
      }
    }
  };
  await walk(root, 0);
  // 다른 소스 폴더 안에 들어 있는 경로는 뺀다
  const list = [...roots].map((r) => relRef(root, r)).sort((a, b) => a.length - b.length);
  const sourcePaths = list.filter((r, i) => !list.slice(0, i).some((o) => o === '.' || r.startsWith(o + '/')));
  return { jars, sourcePaths, truncated: entries > SCAN_MAX_ENTRIES };
}

// 경로 표기: 프로젝트 안이면 상대 경로, 밖이면 절대 경로. 구분자는 항상 '/'
// (언어 서버는 '\' 를 패턴 기호로 읽어서 C:\...\a.jar 같은 경로를 찾지 못한다)
function relRef(root, p) {
  const rel = path.relative(root, p);
  if (rel === '') return '.';
  const inside = !rel.startsWith('..') && !path.isAbsolute(rel);
  return (inside ? rel : path.resolve(p)).replace(/\\/g, '/');
}
const absOf = (root, ref) => path.resolve(root, ref);
const sameRef = (a, b) => a.toLowerCase() === b.toLowerCase();

// ---------- 프로젝트 설정 파일 (.codeflow/java.json) ----------
// 분석 결과와 사용자가 바꾼 설정(JDK, 소스 폴더, 추가/제외한 jar)을 프로젝트 폴더에 저장한다 (IntelliJ 의 .idea 와 같은 역할).
// Git 에는 올라가지 않도록 .git/info/exclude 에 자동으로 등록한다.
const configFile = (root) => path.join(root, '.codeflow', 'java.json');
const EMPTY_CONFIG = { jdk: null, sourcePaths: null, addedLibraries: [], excludedLibraries: [] };

function readConfig(root) {
  try {
    const c = JSON.parse(fs.readFileSync(configFile(root), 'utf8'));
    return { ...EMPTY_CONFIG, ...c, addedLibraries: c.addedLibraries || [], excludedLibraries: c.excludedLibraries || [] };
  } catch {
    return { ...EMPTY_CONFIG };
  }
}

function gitExclude(root) {
  const f = path.join(root, '.git', 'info', 'exclude');
  try {
    if (!fs.statSync(path.join(root, '.git')).isDirectory()) return;
    const txt = readText(f) || '';
    if (/^\/?\.codeflow\/?\s*$/m.test(txt)) return;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `${txt && !txt.endsWith('\n') ? '\n' : ''}# CodeFlow 프로젝트 설정 (Java 프로젝트 구조)\n/.codeflow/\n`);
  } catch {}
}

function writeConfig(root, cfg) {
  const out = {
    설명: 'CodeFlow 가 분석한 Java 프로젝트 구조입니다. 코드 화면 아래 상태 표시줄의 ☕ Java → 프로젝트 구조에서 바꿀 수 있습니다. (Git 에는 올라가지 않습니다)',
    jdk: cfg.jdk || null,
    sourcePaths: cfg.sourcePaths?.length ? cfg.sourcePaths : null,
    addedLibraries: cfg.addedLibraries || [],
    excludedLibraries: cfg.excludedLibraries || [],
    detected: cfg.detected || null,
  };
  const text = JSON.stringify(out, null, 2);
  if (readText(configFile(root)) === text) return;
  fs.mkdirSync(path.dirname(configFile(root)), { recursive: true });
  fs.writeFileSync(configFile(root), text);
  gitExclude(root);
}

// 사용자가 바꾼 설정 저장 (patch: { jdk?, sourcePaths?, addedLibraries?, excludedLibraries? })
function saveConfig(root, patch) {
  const cfg = { ...readConfig(root), ...patch };
  const norm = (list) => (list || []).map((p) => relRef(root, absOf(root, p)));
  cfg.addedLibraries = norm(cfg.addedLibraries);
  cfg.excludedLibraries = norm(cfg.excludedLibraries);
  cfg.sourcePaths = cfg.sourcePaths?.length ? norm(cfg.sourcePaths) : null;
  writeConfig(root, cfg);
  return readConfig(root);
}

function buildToolInfo(root) {
  const pom = readText(path.join(root, 'pom.xml'));
  if (pom) {
    const m =
      pom.match(/<maven\.compiler\.release>\s*([\d.]+)\s*</) ||
      pom.match(/<maven\.compiler\.source>\s*([\d.]+)\s*</) ||
      pom.match(/<java\.version>\s*([\d.]+)\s*</) ||
      pom.match(/<release>\s*([\d.]+)\s*<\/release>/) ||
      pom.match(/<source>\s*([\d.]+)\s*<\/source>/);
    return { build: 'Maven', file: 'pom.xml', level: m ? m[1] : null };
  }
  const gradle = readText(path.join(root, 'build.gradle')) || readText(path.join(root, 'build.gradle.kts'));
  if (gradle) {
    const m =
      gradle.match(/languageVersion(?:\.set\()?\s*(?:=\s*)?JavaLanguageVersion\.of\(\s*(\d+)\s*\)/) ||
      gradle.match(/sourceCompatibility\s*=\s*['"]?(?:JavaVersion\.VERSION_)?([\d._]+)['"]?/);
    return { build: 'Gradle', file: fs.existsSync(path.join(root, 'build.gradle')) ? 'build.gradle' : 'build.gradle.kts', level: m ? m[1].replace('_', '.') : null };
  }
  return null;
}

// 프로젝트 정보: Maven/Gradle 이면 빌드 파일이 라이브러리를 관리하고(언어 서버가 직접 읽음),
// 그 밖의 프로젝트는 폴더 분석 결과 + Eclipse 설정(있으면) + 사용자 설정을 합친다.
// 반환: { build, file, level, jdkHome, libraries[], sourcePaths[], detected, config }
async function projectInfo(root, opts = {}) {
  const cfg = readConfig(root);
  if (!cfg.jdk && opts.legacyJdk) cfg.jdk = opts.legacyJdk; // 예전 버전에서 고른 JDK(앱에 저장돼 있던 값) 옮겨 오기
  const tool = buildToolInfo(root);
  if (tool) {
    if (opts.write !== false && cfg.jdk) writeConfig(root, { ...cfg, detected: { build: tool.build, level: tool.level } });
    return { ...tool, jdkHome: cfg.jdk || null, libraries: [], sourcePaths: [], detected: null, config: cfg };
  }
  const ecl = eclipseProject(root);
  const scan = await scanProject(root);
  const libs = [];
  for (const f of [...(ecl?.libraries || []), ...scan.jars]) {
    const r = relRef(root, f);
    if (!libs.some((x) => sameRef(x, r))) libs.push(r);
  }
  const src = [];
  for (const s of [...(ecl?.sourcePaths || []), ...scan.sourcePaths]) {
    const r = relRef(root, absOf(root, s));
    if (!src.some((x) => sameRef(x, r) || x === '.' || r.toLowerCase().startsWith(x.toLowerCase() + '/'))) src.push(r);
  }
  const level = ecl?.level || null;
  const detected = { build: ecl ? 'Eclipse' : null, level, sourcePaths: src, libraries: libs, analyzedAt: new Date().toISOString() };
  // 분석 결과가 그대로면 분석 시각도 그대로 둔다 (파일이 매번 바뀌지 않게)
  const prev = cfg.detected || {};
  if (JSON.stringify({ ...prev, analyzedAt: 0 }) === JSON.stringify({ ...detected, analyzedAt: 0 })) detected.analyzedAt = prev.analyzedAt;
  if (opts.write !== false) writeConfig(root, { ...cfg, detected });
  const excluded = cfg.excludedLibraries;
  const libraries = [...libs.filter((l) => !excluded.some((x) => sameRef(x, l))), ...cfg.addedLibraries.filter((a) => !libs.some((l) => sameRef(l, a)))].filter((l) => fs.existsSync(absOf(root, l)));
  return {
    build: detected.build,
    file: null,
    level,
    jdkHome: cfg.jdk || null,
    libraries,
    sourcePaths: cfg.sourcePaths?.length ? cfg.sourcePaths : src,
    detected,
    config: cfg,
    truncated: scan.truncated,
  };
}

// ---------- 언어 서버 실행 명령 ----------

// 프로젝트마다 색인 저장 폴더를 둔다 → 두 번째부터는 빨리 열린다.
// JDK·라이브러리가 바뀌어도 같은 폴더를 쓰고, 언어 서버에 바뀐 설정을 보내 필요한 부분만 다시 색인한다.
// v2: 0.5.5 부터 Eclipse 설정(.project/.classpath)을 가져오지 않으므로, 예전에 Eclipse 프로젝트로 가져온 색인은 버리고 새로 만든다
const dataDir = (root) => path.join(packDir(), 'workspaces', crypto.createHash('sha1').update(`${root.toLowerCase()}|v2`).digest('hex').slice(0, 16));

// 같은 프로젝트의 예전 색인 폴더(예전 버전이 JDK/구조마다 따로 만든 것)는 지운다 — 디스크가 계속 늘지 않게
function workspaceFor(root) {
  const dir = dataDir(root);
  const mark = (d) => path.join(d, '.codeflow-root');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(mark(dir), root.toLowerCase());
    const base = path.dirname(dir);
    for (const d of fs.readdirSync(base).map((n) => path.join(base, n))) if (d !== dir && readText(mark(d)) === root.toLowerCase()) rmQuiet(d);
  } catch {}
  return dir;
}

function command(root) {
  const jar = launcherJar();
  if (!jar) throw new Error('Java 언어 팩이 설치되어 있지 않습니다.');
  const rt = findRuntime();
  if (!rt) throw new Error('Java 21 이상을 찾을 수 없습니다. 설정 → 언어 팩에서 Java 언어 팩을 다시 설치하세요.');
  return {
    cmd: path.join(rt.home, 'bin', 'java.exe'),
    args: [
      '-Declipse.application=org.eclipse.jdt.ls.core.id1',
      '-Dosgi.bundles.defaultStartLevel=4',
      '-Declipse.product=org.eclipse.jdt.ls.core.product',
      '-Dlog.level=WARNING',
      '-Dfile.encoding=UTF-8',
      // 프로젝트 폴더에 .project / .classpath / .settings 를 만들지 않는다 (VS Code Java 확장과 같은 방식)
      '-Djava.import.generatesMetadataFilesAtProjectRoot=false',
      // 메모리 상한 1GB (PC 전체가 느려지지 않게) + VS Code Java 확장과 같은 GC 설정
      '-Xms100m',
      '-Xmx1G',
      '-XX:+UseParallelGC',
      '-XX:GCTimeRatio=4',
      '-XX:AdaptiveSizePolicyWeight=90',
      '-Dsun.zip.disableMemoryMapping=true',
      // Lombok(@Getter, @Data 등) 인식 — VS Code Java 확장과 같은 방식
      ...(fs.existsSync(lombokJar()) ? [`-javaagent:${lombokJar()}`] : []),
      '--add-modules=ALL-SYSTEM',
      '--add-opens',
      'java.base/java.util=ALL-UNNAMED',
      '--add-opens',
      'java.base/java.lang=ALL-UNNAMED',
      '-jar',
      jar,
      '-configuration',
      path.join(serverDir(), 'config_win'),
      '-data',
      workspaceFor(root),
    ],
    env: {},
  };
}

// 이 폴더가 Java 프로젝트인지 빠르게 확인 (탭을 열 때 Java 언어 서버를 미리 켤지 정하는 용도)
// pom.xml / build.gradle 이 있거나, .java 파일이 하나라도 있으면 Java 프로젝트
async function isJavaProject(root) {
  if (['pom.xml', 'build.gradle', 'build.gradle.kts'].some((f) => fs.existsSync(path.join(root, f)))) return true;
  let entries = 0;
  const walk = async (dir, depth) => {
    if (depth > 10 || entries > 20000) return false;
    let list;
    try {
      list = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    entries += list.length;
    if (list.some((e) => e.isFile() && e.name.endsWith('.java'))) return true;
    for (const e of list) if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.') && (await walk(path.join(dir, e.name), depth + 1))) return true;
    return false;
  };
  return walk(root, 0);
}

async function jarsIn(dir) {
  const out = [];
  const walk = async (d, depth) => {
    if (depth > 6 || out.length > 2000) return;
    let list = [];
    try {
      list = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {}
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (/\.jar$/i.test(e.name) && !/-(sources|javadoc)\.jar$/i.test(e.name)) out.push(p);
    }
  };
  await walk(dir, 0);
  return out;
}

module.exports = { isJavaProject, jarsIn, status, install, remove, command, detectJdks, projectRuntimes, projectInfo, saveConfig, addCustomJdk, intellijJdkTable };
