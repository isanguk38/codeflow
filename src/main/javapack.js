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
//   사용자가 고른 JDK → IntelliJ Project SDK → 설정의 Java 버전(language level)에 맞는 JDK 순서
function projectRuntimes(preferredHome, project = {}) {
  const all = detectJdks().filter((j) => !j.bundled);
  const byName = new Map();
  for (const j of all) {
    const cur = byName.get(j.name);
    if (!cur || (!cur.jdk && j.jdk)) byName.set(j.name, j);
  }
  const want = preferredHome || project.jdkHome;
  let def = want ? all.find((j) => j.home.toLowerCase() === want.toLowerCase()) : null;
  if (!def && project.level && !['Maven', 'Gradle'].includes(project.build)) def = byName.get(runtimeName(majorOf(project.level))) || null;
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

// ---------- 프로젝트 정보 (IntelliJ 와 같은 순서로 찾기) ----------
// 1) pom.xml (Maven)  2) build.gradle (Gradle)  3) .idea (IntelliJ 설정)  4) .classpath (Eclipse 설정)  5) 없음
// 반환: { build, file, level, jdkHome, jdkName, libraries[], sourcePaths[] }

const readText = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};

// IntelliJ 경로 매크로 풀기
function expandIdea(url, root, moduleDir) {
  return url
    .replace(/^(jar|file):\/\//, '')
    .replace(/!\/.*$/, '')
    .replace(/\$PROJECT_DIR\$/g, root)
    .replace(/\$MODULE_DIR\$/g, moduleDir)
    .replace(/\$USER_HOME\$/g, os.homedir())
    .replace(/\//g, path.sep);
}

function intellijProject(root) {
  const misc = readText(path.join(root, '.idea', 'misc.xml'));
  if (!misc) return null;
  const rm = (misc.match(/<component name="ProjectRootManager"[^>]*>/) || [''])[0];
  const lang = (rm.match(/languageLevel="JDK_([\dX_]+)"/) || [])[1]; // JDK_1_8, JDK_11, JDK_17
  const jdkName = (rm.match(/project-jdk-name="([^"]+)"/) || [])[1];
  const level = lang ? lang.replace(/_X$/, '').replace('_', '.').replace(/^(\d+)\..*$/, (m, a) => (a === '1' ? m : a)) : null;
  const table = intellijJdkTable();
  const jdkHome = jdkName ? table.find((j) => j.name === jdkName)?.home || null : null;
  // 라이브러리 jar: .idea/libraries/*.xml + 모듈 .iml 의 module-library
  const libraries = new Set();
  const sourcePaths = new Set();
  const libDir = path.join(root, '.idea', 'libraries');
  try {
    for (const f of fs.readdirSync(libDir).filter((n) => n.endsWith('.xml'))) {
      const xml = readText(path.join(libDir, f)) || '';
      const classes = (xml.match(/<CLASSES>([\s\S]*?)<\/CLASSES>/) || [])[1] || '';
      for (const m of classes.matchAll(/url="(jar:\/\/[^"]+)"/g)) libraries.add(expandIdea(m[1], root, root));
    }
  } catch {}
  const imls = [];
  const modules = readText(path.join(root, '.idea', 'modules.xml')) || '';
  for (const m of modules.matchAll(/filepath="([^"]+\.iml)"/g)) imls.push(expandIdea(m[1], root, root));
  try {
    for (const f of fs.readdirSync(root).filter((n) => n.endsWith('.iml'))) imls.push(path.join(root, f));
  } catch {}
  for (const iml of new Set(imls)) {
    const xml = readText(iml) || '';
    const dir = path.dirname(iml);
    for (const m of xml.matchAll(/<CLASSES>([\s\S]*?)<\/CLASSES>/g)) for (const u of m[1].matchAll(/url="(jar:\/\/[^"]+)"/g)) libraries.add(expandIdea(u[1], root, dir));
    for (const m of xml.matchAll(/<sourceFolder url="(file:\/\/[^"]+)"(?![^>]*isTestSource="true")/g)) sourcePaths.add(path.relative(root, expandIdea(m[1], root, dir)) || '.');
  }
  return {
    build: 'IntelliJ',
    file: 'IntelliJ 설정',
    level,
    jdkName: jdkName || null,
    jdkHome,
    libraries: [...libraries].filter((f) => fs.existsSync(f)),
    sourcePaths: [...sourcePaths],
  };
}

function eclipseProject(root) {
  const cp = readText(path.join(root, '.classpath'));
  if (!cp || !fs.existsSync(path.join(root, '.project'))) return null;
  const prefs = readText(path.join(root, '.settings', 'org.eclipse.jdt.core.prefs')) || '';
  const level = (prefs.match(/org\.eclipse\.jdt\.core\.compiler\.compliance=([\d.]+)/) || cp.match(/JavaSE-([\d.]+)/) || [])[1] || null;
  return { build: 'Eclipse', file: 'Eclipse 설정', level, jdkHome: null, libraries: [], sourcePaths: [] };
}

// 소스 폴더 자동 찾기 (IntelliJ 가 프로젝트를 열 때 하는 것처럼):
// .java 파일의 package 선언과 폴더 위치를 맞춰서 소스 루트를 알아낸다. 예) src/app/Main.java + package app; → src
const SKIP_DIRS = new Set(['.git', 'node_modules', 'target', 'build', 'out', 'bin', '.idea', '.gradle', '.settings', 'classes']);
function inferSourceRoots(root) {
  const roots = new Set();
  let seen = 0;
  const walk = (dir, depth) => {
    if (depth > 8 || seen > 400 || roots.size >= 10) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(p, depth + 1);
      } else if (e.name.endsWith('.java')) {
        seen++;
        let head = '';
        try {
          const fd = fs.openSync(p, 'r');
          const buf = Buffer.alloc(4096);
          const n = fs.readSync(fd, buf, 0, 4096, 0);
          fs.closeSync(fd);
          head = buf.slice(0, n).toString('utf8');
        } catch {}
        const pkg = (head.match(/^\s*package\s+([\w.]+)\s*;/m) || [])[1];
        const fileDir = path.dirname(p);
        let srcRoot = fileDir;
        if (pkg) {
          const pkgPath = pkg.split('.').join(path.sep);
          if (!fileDir.toLowerCase().endsWith(path.sep + pkgPath.toLowerCase())) continue; // 위치가 안 맞는 파일은 판단에서 제외
          srcRoot = fileDir.slice(0, fileDir.length - pkgPath.length - 1);
        }
        roots.add(path.relative(root, srcRoot) || '.');
        break; // 한 폴더에서 한 파일만 보면 충분
      }
    }
  };
  walk(root, 0);
  // 다른 소스 루트 안에 포함된 경로는 뺀다
  const list = [...roots].sort((a, b) => a.length - b.length);
  return list.filter((r, i) => !list.slice(0, i).some((o) => o !== '.' && (r + path.sep).startsWith(o + path.sep)));
}

function projectInfo(root) {
  const pom = readText(path.join(root, 'pom.xml'));
  if (pom) {
    const m =
      pom.match(/<maven\.compiler\.release>\s*([\d.]+)\s*</) ||
      pom.match(/<maven\.compiler\.source>\s*([\d.]+)\s*</) ||
      pom.match(/<java\.version>\s*([\d.]+)\s*</) ||
      pom.match(/<release>\s*([\d.]+)\s*<\/release>/) ||
      pom.match(/<source>\s*([\d.]+)\s*<\/source>/);
    return { build: 'Maven', file: 'pom.xml', level: m ? m[1] : null, libraries: [], sourcePaths: [] };
  }
  const gradle = readText(path.join(root, 'build.gradle')) || readText(path.join(root, 'build.gradle.kts'));
  if (gradle) {
    const m =
      gradle.match(/languageVersion(?:\.set\()?\s*(?:=\s*)?JavaLanguageVersion\.of\(\s*(\d+)\s*\)/) ||
      gradle.match(/sourceCompatibility\s*=\s*['"]?(?:JavaVersion\.VERSION_)?([\d._]+)['"]?/);
    return { build: 'Gradle', file: fs.existsSync(path.join(root, 'build.gradle')) ? 'build.gradle' : 'build.gradle.kts', level: m ? m[1].replace('_', '.') : null, libraries: [], sourcePaths: [] };
  }
  const idea = intellijProject(root);
  if (idea) {
    if (!idea.sourcePaths.length) idea.sourcePaths = inferSourceRoots(root);
    return idea;
  }
  return eclipseProject(root) || { build: null, file: null, level: null, libraries: [], sourcePaths: inferSourceRoots(root) };
}

// ---------- 언어 서버 실행 명령 ----------

// 프로젝트(+기준 JDK)마다 색인 저장 폴더를 따로 둔다 → 두 번째부터는 빨리 열린다.
// 빌드 파일이 없는 프로젝트는 처음 만들 때의 JDK 로 고정되므로, JDK 를 바꾸면 새 색인을 쓰도록 키에 포함한다.
const dataDir = (root, jdkKey = '') => path.join(packDir(), 'workspaces', crypto.createHash('sha1').update(`${root.toLowerCase()}|${jdkKey.toLowerCase()}`).digest('hex').slice(0, 16));

function command(root, jdkKey) {
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
      dataDir(root, jdkKey),
    ],
    env: {},
  };
}

module.exports = { status, install, remove, command, detectJdks, projectRuntimes, projectInfo, addCustomJdk, intellijJdkTable };
