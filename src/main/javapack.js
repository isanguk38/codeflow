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
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const majorOf = (v) => {
  const m = String(v).match(/^(\d+)(?:\.(\d+))?/);
  if (!m) return 0;
  return m[1] === '1' ? +m[2] : +m[1];
};

// JDT LS 가 이해하는 실행 환경 이름
const runtimeName = (major) => (major <= 5 ? 'J2SE-1.5' : major <= 8 ? `JavaSE-1.${major}` : `JavaSE-${major}`);

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
function projectRuntimes(preferredHome) {
  const byName = new Map();
  for (const j of detectJdks()) {
    if (j.bundled) continue;
    const cur = byName.get(j.name);
    if (!cur || (!cur.jdk && j.jdk)) byName.set(j.name, j);
  }
  if (preferredHome) {
    const p = detectJdks().find((j) => j.home.toLowerCase() === preferredHome.toLowerCase());
    if (p) byName.set(p.name, p);
  }
  return [...byName.values()].map((j) => ({ name: j.name, path: j.home, default: !!preferredHome && j.home.toLowerCase() === preferredHome.toLowerCase() }));
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

// ---------- 프로젝트 정보 (pom.xml / build.gradle 의 Java 버전) ----------

function projectInfo(root) {
  const read = (f) => {
    try {
      return fs.readFileSync(path.join(root, f), 'utf8');
    } catch {
      return null;
    }
  };
  const pom = read('pom.xml');
  if (pom) {
    const m =
      pom.match(/<maven\.compiler\.release>\s*([\d.]+)\s*</) ||
      pom.match(/<maven\.compiler\.source>\s*([\d.]+)\s*</) ||
      pom.match(/<java\.version>\s*([\d.]+)\s*</) ||
      pom.match(/<release>\s*([\d.]+)\s*<\/release>/) ||
      pom.match(/<source>\s*([\d.]+)\s*<\/source>/);
    return { build: 'Maven', file: 'pom.xml', level: m ? m[1] : null };
  }
  const gradle = read('build.gradle') || read('build.gradle.kts');
  if (gradle) {
    const m =
      gradle.match(/languageVersion(?:\.set\()?\s*(?:=\s*)?JavaLanguageVersion\.of\(\s*(\d+)\s*\)/) ||
      gradle.match(/sourceCompatibility\s*=\s*['"]?(?:JavaVersion\.VERSION_)?([\d._]+)['"]?/);
    return { build: 'Gradle', file: fs.existsSync(path.join(root, 'build.gradle')) ? 'build.gradle' : 'build.gradle.kts', level: m ? m[1].replace('_', '.') : null };
  }
  return { build: null, file: null, level: null };
}

// ---------- 언어 서버 실행 명령 ----------

// 프로젝트마다 색인 저장 폴더를 따로 둔다 → 두 번째부터는 빨리 열린다
const dataDir = (root) => path.join(packDir(), 'workspaces', crypto.createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 16));

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
      dataDir(root),
    ],
    env: {},
  };
}

module.exports = { status, install, remove, command, detectJdks, projectRuntimes, projectInfo, addCustomJdk };
