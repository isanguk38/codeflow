// 코드 화면의 언어 지원: Python 인터프리터, Java 언어 팩·JDK·프로젝트 구조, 언어 안내
import { $, h, modal, contextMenu, toast } from './ui.js';
import { state, busy } from './state.js';
import * as lsp from './lsp-client.js';
import { docs } from './code-shared.js';
import { updateStatus, activeDoc } from './code.js';

// ---------- Python 인터프리터 (Java 의 JDK 에 해당: 쓸 수 있는 문법과 설치된 패키지가 달라진다) ----------

const pyCache = new Map(); // 저장소 → 찾은 인터프리터 목록
const pyKey = (repo) => `py.interp:${repo.toLowerCase()}`;

async function pythonList(repo, force) {
  if (!force && pyCache.has(repo)) return pyCache.get(repo);
  const list = await window.api.pythonInterpreters(repo);
  pyCache.set(repo, list);
  return list;
}

function currentPython(repo) {
  try {
    return JSON.parse(localStorage.getItem(pyKey(repo)) || 'null');
  } catch {
    return null;
  }
}

// 처음이면 프로젝트 가상환경(.venv 등) → 시스템 Python 순서로 자동 선택
export async function ensurePython(repo) {
  let cur = currentPython(repo);
  const list = await pythonList(repo);
  if (cur && !list.some((x) => x.path.toLowerCase() === cur.path.toLowerCase())) cur = null;
  if (!cur && list.length) {
    cur = list[0];
    localStorage.setItem(pyKey(repo), JSON.stringify(cur));
  }
  lsp.setPythonPath(repo, cur?.path || null);
  return cur;
}

export function pythonStatusItem(repo) {
  const cur = currentPython(repo);
  const el = h('span', {
    class: `cs-item cs-btn ${cur ? '' : 'warn'}`,
    title: cur ? `${cur.path}\n클릭해서 다른 Python 선택` : 'Python 을 찾지 못했습니다. 설치된 패키지(import)를 인식하지 못할 수 있습니다.',
    text: cur ? `🐍 Python ${cur.version}${cur.source.startsWith('가상환경') ? ` (${cur.source.replace(/^가상환경 \((.*)\)$/, '$1')})` : ''}` : '🐍 Python 없음',
  });
  el.onclick = async () => {
    const list = await pythonList(repo, true);
    const items = list.map((x) => ({
      label: `${cur && cur.path.toLowerCase() === x.path.toLowerCase() ? '✓ ' : '　'}Python ${x.version} · ${x.source}`,
      hint: x.path,
      onClick: () => {
        localStorage.setItem(pyKey(repo), JSON.stringify(x));
        lsp.setPythonPath(repo, x.path);
        updateStatus();
        toast(`Python ${x.version} (${x.source}) 을(를) 사용합니다.`, 'ok');
      },
    }));
    const r = el.getBoundingClientRect();
    contextMenu(r.left, r.top - 8 - (items.length + 2) * 28, [{ header: 'Python 인터프리터 선택' }, ...(items.length ? items : [{ label: '설치된 Python 을 찾지 못했습니다', disabled: true }]), '-', { label: '다시 찾기', onClick: () => pythonList(repo, true).then(updateStatus) }]);
  };
  return el;
}

// ---------- Java 언어 팩 ----------

let javaPack = null; // 설치 상태 (window.api.java.status)
const effectiveCache = new Map(); // 파일+기준JDK → 언어 서버가 실제 적용한 { level, jdk }
const effectivePending = new Set();
let javaInstalling = null;

export async function refreshJavaPack() {
  javaPack = await window.api.java.status();
  lsp.setJavaEnabled(javaPack.installed);
  return javaPack;
}

// jdt://contents/rt.jar/java.util/List.java?... → List.java (소스가 없으면 List.class)
export const virtualName = (uri) => {
  const m = decodeURIComponent(uri.split('?')[0]).match(/([^/]+?\.(?:java|class))$/);
  return m ? m[1] : 'class';
};

// Java 파일을 열기 전: 예전 버전에서 고른 기준 JDK 가 있으면 넘긴다 (서버 쪽에서 .codeflow/java.json 으로 옮김)
export async function prepareJava(repo) {
  if (!javaPack) await refreshJavaPack();
  lsp.setPreferredJdk(repo, localStorage.getItem(`java.jdk:${repo.toLowerCase()}`) || null);
}

// 프로젝트 탭을 열거나 골랐을 때: Java 프로젝트면 Java 언어 서버를 미리 켠다 (언어 팩이 설치된 경우만)
const javaProjects = new Map(); // 저장소 → Java 프로젝트 여부
export async function onRepoActivated(repo) {
  lsp.setActiveRepo(repo);
  updateJavaFooter(); // 탭을 바꾸면 그 프로젝트의 상태로
  if (state.view === 'code') updateStatus();
  if (!repo) return;
  if (!javaPack) await refreshJavaPack().catch(() => null);
  if (!javaPack?.installed) return;
  const key = repo.toLowerCase();
  if (!javaProjects.has(key)) javaProjects.set(key, await window.api.java.isProject(repo).catch(() => false));
  if (!javaProjects.get(key) || state.repo?.toLowerCase() !== key) return;
  await prepareJava(repo);
  lsp.warmJava(repo);
}

// 설치 진행 상황 (어느 Java 파일을 보든, 설정 화면이든 같은 값을 보여 준다)
let javaProgress = null;
let progressHooked = false;
const progressText = (p) => (p ? `${p.message}${p.percent >= 0 && p.step === 'download' ? ` (${p.percent}%)` : ''}` : 'Java 언어 팩 설치 준비 중...');

// 설정 화면에서도 쓰는 설치 함수 (이미 설치 중이면 같은 설치를 기다린다)
export async function installJavaPack(onProgress) {
  if (!progressHooked) {
    progressHooked = true;
    window.api.java.onProgress((p) => {
      javaProgress = p;
      window.dispatchEvent(new CustomEvent('java-progress', { detail: p }));
    });
  }
  if (!javaInstalling) {
    javaProgress = null;
    const done = busy('Java 언어 팩 설치'); // 툴바에 'Java 언어 팩 설치 중... N초'
    javaInstalling = (async () => {
      try {
        const r = await window.api.java.install();
        if (!r.ok) throw new Error(r.error);
        await refreshJavaPack();
        // 이미 열어 둔 Java 파일들을 언어 서버에 연결
        for (const d of docs.values()) if (!d.virtual && d.model.getLanguageId() === 'java') prepareJava(d.repo).then(() => lsp.attachModel(d.repo, d.model).catch(() => {}));
        toast('Java 언어 팩을 설치했습니다. 열린 Java 파일을 검사합니다.', 'ok', 5000);
        if (state.repo) onRepoActivated(state.repo);
        return r.data;
      } finally {
        done();
        javaInstalling = null;
        javaProgress = null;
        // 보고 있는 파일의 안내 띠를 상태에 맞게 다시 그린다
        const d = activeDoc();
        if (d) showLanguageNotice(d);
        updateStatus();
      }
    })();
  }
  onProgress?.(javaProgress);
  const handler = (e) => onProgress?.(e.detail);
  window.addEventListener('java-progress', handler);
  try {
    return await javaInstalling;
  } finally {
    window.removeEventListener('java-progress', handler);
  }
}

export async function removeJavaPack() {
  for (const repo of new Set([...docs.values()].map((d) => d.repo))) await lsp.restartServer(repo, 'java', []);
  const r = await window.api.java.remove();
  await refreshJavaPack();
  return r;
}

// 이 프로젝트에 직접 고른 JDK (.codeflow/java.json 에 저장, 언어 서버가 알려 준 값)
const pickedJdk = (info) => info?.java?.project?.config?.jdk || null;

export function javaStatusItem(repo, info) {
  if (!info || info.status === 'starting') return h('span', { class: 'cs-item', html: '<span class="spinner"></span> Java 프로젝트 분석 · 언어 서버 시작 중' });
  if (info.status === 'error') return h('span', { class: 'cs-item err', text: 'Java 언어 서버 오류', title: info.error || '' });
  if (info.javaState && !info.javaState.ready)
    return h('span', { class: `cs-item ${info.javaState.error ? 'err' : ''}`, html: `${info.javaState.error ? '' : '<span class="spinner"></span> '}${info.javaState.message}`, title: '처음 여는 프로젝트는 라이브러리 색인 때문에 시간이 걸립니다. 두 번째부터는 빨라집니다.' });
  const proj = info.java?.project || {};
  const managed = ['Maven', 'Gradle'].includes(proj.build);
  const level = proj.level ? (proj.level.startsWith('1.') ? proj.level : proj.level.replace(/^(\d+).*/, '$1')) : null;
  const picked = pickedJdk(info);
  const runtimes = info.java?.runtimes || [];
  const def = runtimes.find((r) => r.default);
  const rt = managed ? runtimes.find((r) => r.name === (level ? `JavaSE-${level}` : '')) : def;
  const missing = managed && level && !rt;
  const auto = !managed && !picked && !level; // 버전 정보가 없어 가장 최신 JDK 로 자동 선택
  const tail = `${managed && proj.file ? ` (${proj.file})` : ''}${picked ? ' · 직접 선택' : auto ? ' · 자동' : ''}`;
  const libs = managed ? '' : `\n라이브러리 jar ${proj.libraries?.length || 0}개 · 소스 폴더 ${(proj.sourcePaths || []).join(', ') || '-'}`;
  const el = h('span', {
    class: `cs-item cs-btn ${missing ? 'warn' : ''}`,
    // 빌드 파일이 없는 프로젝트는 고른(또는 자동으로 정한) JDK 의 버전을 보여 준다
    text: `☕ Java ${(managed ? level : null) || (def ? def.name.replace(/^JavaSE-/, '') : level || '?')}${tail}`,
    title: missing
      ? `프로젝트는 Java ${level} 기준인데 해당 JDK 가 PC 에 없습니다. 설치된 다른 JDK 로 검사합니다.`
      : `검사 기준 JDK: ${rt ? rt.path : '언어 서버 기본 JDK'}${libs}\n클릭해서 JDK 선택 / 프로젝트 구조`,
  });
  el.onclick = () => openJdkPicker(el, repo, info, level, proj);
  // 언어 서버가 실제로 적용한 Java 버전/JDK 로 표시를 바로잡는다 (추측이 아닌 실제 값)
  const d = activeDoc();
  if (d && info.javaState?.ready) {
    const key = `${d.path}|${def?.path || ''}`;
    const show = (eff) => {
      if (!eff?.level) return;
      if (managed) el.textContent = `☕ Java ${eff.level}${tail}`;
      // Java 1.7 이하 JDK: 함수·클래스는 그 JDK 기준이지만, 문법 검사는 엔진(Eclipse)이 1.7 이하를 지원하지 않아 더 높은 버전 기준
      const old = /^JavaSE-1\.[0-7]$|^J2SE/.test(def?.name || '');
      el.title = `${old ? `사용 가능한 클래스·함수: ${def.name.replace(/^JavaSE-/, 'Java ')} JDK 기준\n문법 검사: Java ${eff.level} 기준 (검사 엔진이 1.7 이하 문법 검사를 지원하지 않음)` : `실제 검사 기준: Java ${eff.level}`}\nJDK: ${eff.jdk || '-'}${libs}\n클릭해서 JDK 선택 / 프로젝트 구조`;
      el.classList.toggle('warn', managed && !!level && eff.level !== level);
    };
    if (effectiveCache.has(key)) show(effectiveCache.get(key));
    else if (!effectivePending.has(key)) {
      effectivePending.add(key);
      lsp.javaEffectiveSettings(d.model).then((eff) => {
        effectivePending.delete(key);
        if (!eff) return;
        effectiveCache.set(key, eff);
        updateStatus(); // 실제 값으로 다시 그림
      });
    }
  }
  return el;
}

// 앱 아래쪽 상태 표시줄(모든 화면 공통): 지금 프로젝트의 Java 언어 서버 준비 상태
function updateJavaFooter() {
  const el = $('#statusJava');
  if (!el) return;
  const repo = state.repo;
  const info = repo ? lsp.serverInfo(repo, 'java') : null;
  el.className = '';
  el.onclick = null;
  if (!info) {
    el.innerHTML = '';
    el.title = '';
    return;
  }
  const spin = '<span class="spinner"></span> ';
  if (info.status === 'starting') {
    el.innerHTML = `${spin}☕ Java 언어 서버 시작 중`;
    el.title = 'Java 프로젝트라서 미리 켜 두는 중입니다. 준비되면 Java 파일을 열자마자 오류 표시·자동 완성이 됩니다.';
    setTimeout(updateJavaFooter, 800);
    return;
  }
  if (info.status === 'error') {
    el.textContent = '☕ Java 언어 서버 오류';
    el.title = info.error || '';
    el.className = 'err';
    return;
  }
  if (info.javaState && !info.javaState.ready) {
    el.innerHTML = info.javaState.error ? `☕ ${info.javaState.message}` : `${spin}☕ ${info.javaState.message}`;
    el.title = '처음 여는 프로젝트는 라이브러리 색인 때문에 시간이 걸립니다. 두 번째부터는 빨라집니다.';
    if (info.javaState.error) el.className = 'err';
    return;
  }
  const proj = info.java?.project || {};
  const managed = ['Maven', 'Gradle'].includes(proj.build);
  const def = (info.java?.runtimes || []).find((r) => r.default);
  const ver = (managed && proj.level) || (def ? def.name.replace(/^JavaSE-/, '') : proj.level || '');
  el.textContent = `☕ Java ${ver} 준비됨`;
  el.title = `검사 기준 JDK: ${def?.path || '-'}${managed ? '' : `
라이브러리 jar ${proj.libraries?.length || 0}개 · 소스 폴더 ${(proj.sourcePaths || []).join(', ') || '-'}`}
클릭해서 프로젝트 구조 열기`;
  el.className = 'clickable';
  el.onclick = () => openProjectStructure(repo);
}

// 언어 서버 상태가 바뀌면 (코드 화면을 열기 전에도) 상태 표시를 새로 그린다
lsp.onServerStatus(() => {
  updateStatus();
  updateJavaFooter();
});

// 언어 서버가 JDK 를 다시 적용했으면 표시도 새로 확인
lsp.onJavaJdkFixed(() => {
  effectiveCache.clear();
  setTimeout(updateStatus, 3000);
});

// 프로젝트 설정(JDK, jar, 소스 폴더)이 바뀌면 실행 중인 Java 언어 서버에 새 설정만 보낸다 (다시 시작하지 않음, 1~2초)
async function restartJava(repo, message) {
  localStorage.removeItem(`java.jdk:${repo.toLowerCase()}`); // 예전 버전의 저장 위치 (이제 .codeflow/java.json)
  lsp.setPreferredJdk(repo, null);
  effectiveCache.clear();
  if (await lsp.updateJavaProject(repo)) {
    toast(message, 'ok', 4000);
    updateStatus();
    setTimeout(updateStatus, 6000); // 실제 적용된 JDK 다시 확인
    return;
  }
  // 서버가 아직 시작 중이거나 꺼져 있으면 다시 시작해서 새 설정으로 연다
  const models = [...docs.values()].filter((d) => d.repo === repo && !d.virtual && d.model.getLanguageId() === 'java').map((d) => d.model);
  await lsp.restartServer(repo, 'java', models);
  updateStatus();
}

async function saveJavaConfig(repo, patch) {
  const r = await window.api.java.saveConfig(repo, patch);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

async function pickJdkFolder() {
  const dir = await window.api.pickFolder('JDK 설치 폴더 선택 (예: C:\\Program Files\\Java\\jdk-1.8)');
  if (!dir) return null;
  const r = await window.api.java.addJdk(dir);
  if (!r.ok) {
    toast(r.error, 'error', 6000);
    return null;
  }
  toast(`JDK ${r.data.version} 을(를) 추가했습니다.`, 'ok');
  return r.data.home;
}

async function openJdkPicker(anchor, repo, info, level, proj) {
  await refreshJavaPack();
  const picked = pickedJdk(info);
  const managed = ['Maven', 'Gradle'].includes(proj.build);
  const choose = async (home) => {
    try {
      await saveJavaConfig(repo, { jdk: home });
    } catch (e) {
      return toast(e.message, 'error', 6000);
    }
    await restartJava(repo, '기준 JDK 를 바꿨습니다. 잠시 뒤 새 JDK 기준으로 다시 검사합니다.');
  };
  const items = [
    { label: '🧱 프로젝트 구조 (JDK · 소스 폴더 · 라이브러리 jar)...', onClick: () => openProjectStructure(repo) },
    '-',
    { header: managed ? `${proj.build} 프로젝트: ${proj.file} 의 Java ${level || '?'} 버전을 따릅니다` : '프로젝트 기준 JDK' },
    { label: `${!picked ? '✓ ' : '　'}자동${level ? ` (Java ${level} 에 맞는 JDK)` : managed ? '' : ' (설치된 가장 최신 JDK)'}`, onClick: () => choose(null) },
    '-',
    ...javaPack.jdks.map((j) => ({
      label: `${picked && picked.toLowerCase() === j.home.toLowerCase() ? '✓ ' : '　'}${j.jdk ? 'JDK' : 'JRE'} ${j.version}`,
      hint: j.home,
      onClick: () => choose(j.home),
    })),
    javaPack.jdks.length ? null : { label: 'PC 에 설치된 JDK 를 찾지 못했습니다', disabled: true },
    '-',
    {
      label: '폴더에서 JDK 선택...',
      onClick: async () => {
        const home = await pickJdkFolder();
        if (home) choose(home);
      },
    },
  ].filter(Boolean);
  const r = anchor.getBoundingClientRect();
  contextMenu(r.left, r.top - 8 - items.length * 28, items);
}

// ---------- Java 프로젝트 구조 (IntelliJ 의 Project Structure 와 같은 역할) ----------
// 프로젝트를 분석한 결과(소스 폴더, jar)를 보여 주고, JDK·소스 폴더·라이브러리를 바꿀 수 있다.
// 설정은 프로젝트 폴더의 .codeflow/java.json 에 저장된다 (Git 에는 올라가지 않음).

export async function openProjectStructure(repo) {
  const done = busy('Java 프로젝트 분석');
  let proj;
  try {
    await refreshJavaPack();
    proj = await window.api.java.project(repo);
  } finally {
    done();
  }
  const managed = ['Maven', 'Gradle'].includes(proj.build);
  const rel = (p) => {
    const a = p.replace(/\\/g, '/');
    const r = repo.replace(/\\/g, '/').replace(/\/$/, '') + '/';
    return a.toLowerCase().startsWith(r.toLowerCase()) ? a.slice(r.length) || '.' : a;
  };
  const cfg = proj.config || {};
  const st = {
    jdk: cfg.jdk || null,
    srcManual: !!cfg.sourcePaths?.length,
    src: [...(cfg.sourcePaths?.length ? cfg.sourcePaths : proj.detected?.sourcePaths || [])],
    libs: [],
    filter: '',
  };
  const excluded = (cfg.excludedLibraries || []).map((x) => x.toLowerCase());
  for (const l of proj.detected?.libraries || []) st.libs.push({ ref: l, on: !excluded.includes(l.toLowerCase()), added: false });
  for (const a of cfg.addedLibraries || []) if (!st.libs.some((x) => x.ref.toLowerCase() === a.toLowerCase())) st.libs.push({ ref: a, on: true, added: true });

  const body = h('div', { class: 'ps' });
  const section = (title, hint) => h('div', { class: 'ps-sec' }, h('div', { class: 'ps-title' }, title, hint ? h('span', { class: 'ps-hint', text: hint }) : ''));

  // JDK
  const jdkSel = h('select', { class: 'ps-select' });
  const fillJdks = () => {
    jdkSel.innerHTML = '';
    const autoLabel = proj.level ? `자동 (Java ${proj.level} 에 맞는 JDK)` : managed ? `자동 (${proj.file} 기준)` : '자동 (설치된 가장 최신 JDK)';
    jdkSel.append(h('option', { value: '', text: autoLabel }));
    for (const j of javaPack.jdks) jdkSel.append(h('option', { value: j.home, text: `${j.jdk ? 'JDK' : 'JRE'} ${j.version}  —  ${j.home}` }));
    if (st.jdk && !javaPack.jdks.some((j) => j.home.toLowerCase() === st.jdk.toLowerCase())) jdkSel.append(h('option', { value: st.jdk, text: `${st.jdk} (찾을 수 없음)` }));
    jdkSel.value = st.jdk ? javaPack.jdks.find((j) => j.home.toLowerCase() === st.jdk.toLowerCase())?.home || st.jdk : '';
  };
  fillJdks();
  jdkSel.onchange = () => (st.jdk = jdkSel.value || null);
  const jdkAdd = h('button', { class: 'tb-btn small', text: '폴더에서 추가...' });
  jdkAdd.onclick = async () => {
    const home = await pickJdkFolder();
    if (!home) return;
    await refreshJavaPack();
    st.jdk = home;
    fillJdks();
  };
  const secJdk = section('JDK', managed ? `${proj.file} 의 Java 버전(${proj.level || '?'})을 따르고, 여기서 고르면 그 JDK 로 검사합니다` : '선택한 JDK 의 클래스·함수로 자동 완성과 오류 검사를 합니다');
  secJdk.append(h('div', { class: 'ps-row' }, jdkSel, jdkAdd));
  body.append(
    h('div', {
      class: 'ps-info',
      html: managed
        ? `<b>${proj.build} 프로젝트</b> · 라이브러리와 소스 폴더는 <code>${proj.file}</code> 이 관리합니다 (VS Code Java 와 같은 방식).`
        : `<b>빌드 파일(pom.xml · build.gradle)이 없는 프로젝트</b>를 분석했습니다${proj.detected?.build ? ` (${proj.detected.build} 설정도 반영)` : ''}. 설정은 <code>.codeflow/java.json</code> 에 저장되며 Git 에는 올라가지 않습니다.${proj.truncated ? '<br>⚠ 파일이 매우 많아 일부 폴더는 분석하지 못했습니다. 빠진 jar 는 직접 추가하세요.' : ''}`,
    }),
    secJdk
  );

  // 소스 폴더
  const srcList = h('div', { class: 'ps-list ps-list-short' });
  const srcHint = h('span', { class: 'ps-hint' });
  const drawSrc = () => {
    srcList.innerHTML = '';
    srcHint.textContent = st.srcManual ? '직접 지정함' : '자동으로 찾음 (.java 파일의 package 선언 기준)';
    if (!st.src.length) srcList.append(h('div', { class: 'ps-empty', text: '찾은 소스 폴더가 없습니다. 폴더 추가로 지정하세요.' }));
    st.src.forEach((s, i) => {
      const x = h('button', { class: 'ps-x', title: '빼기', text: '✕' });
      x.onclick = () => {
        st.src.splice(i, 1);
        st.srcManual = true;
        drawSrc();
      };
      srcList.append(h('div', { class: 'ps-item' }, h('span', { class: 'ps-ico ci', text: '\ueaf7' }), h('span', { class: 'ps-path', text: s }), x));
    });
  };
  const srcAdd = h('button', { class: 'tb-btn small', text: '+ 소스 폴더 추가...' });
  srcAdd.onclick = async () => {
    const dir = await window.api.pickFolder('소스 폴더 선택 (package 가 시작되는 폴더, 예: src 또는 JavaSource)');
    if (!dir) return;
    const r = rel(dir);
    if (!st.src.some((x) => x.toLowerCase() === r.toLowerCase())) st.src.push(r);
    st.srcManual = true;
    drawSrc();
  };
  const srcAuto = h('button', { class: 'tb-btn small', text: '자동으로 되돌리기' });
  srcAuto.onclick = () => {
    st.src = [...(proj.detected?.sourcePaths || [])];
    st.srcManual = false;
    drawSrc();
  };

  // 라이브러리
  const libList = h('div', { class: 'ps-list' });
  const libCount = h('span', { class: 'ps-hint' });
  const libFilter = h('input', { class: 'ps-filter', placeholder: 'jar 이름으로 찾기' });
  libFilter.oninput = () => {
    st.filter = libFilter.value.trim().toLowerCase();
    drawLibs();
  };
  const drawLibs = () => {
    libList.innerHTML = '';
    const on = st.libs.filter((l) => l.on).length;
    libCount.textContent = `사용 ${on}개 / 찾은 jar ${st.libs.filter((l) => !l.added).length}개 · 체크를 끄면 검사에서 뺍니다`;
    const shown = st.libs.filter((l) => !st.filter || l.ref.toLowerCase().includes(st.filter));
    if (!st.libs.length) libList.append(h('div', { class: 'ps-empty', text: '프로젝트 안에서 jar 를 찾지 못했습니다. Tomcat 의 servlet-api.jar 처럼 프로젝트 밖에 있는 jar 는 직접 추가하세요.' }));
    for (const l of shown.slice(0, 500)) {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = l.on;
      cb.onchange = () => {
        l.on = cb.checked;
        drawLibs();
      };
      const name = l.ref.split('/').pop();
      const dir = l.ref.slice(0, l.ref.length - name.length).replace(/\/$/, '') || '.';
      const row = h('label', { class: `ps-item ${l.on ? '' : 'off'}`, title: l.ref }, cb, h('span', { class: 'ps-ico', text: '☕' }), h('span', { class: 'ps-name', text: name }), h('span', { class: 'ps-dir', text: dir }));
      if (l.added) {
        const x = h('button', { class: 'ps-x', title: '목록에서 빼기', text: '✕' });
        x.onclick = (e) => {
          e.preventDefault();
          st.libs.splice(st.libs.indexOf(l), 1);
          drawLibs();
        };
        row.append(h('span', { class: 'ps-tag', text: '직접 추가' }), x);
      }
      libList.append(row);
    }
    if (shown.length > 500) libList.append(h('div', { class: 'ps-empty', text: `… ${shown.length - 500}개 더 있음 (이름으로 찾기)` }));
  };
  const addLibs = (files) => {
    let n = 0;
    for (const f of files) {
      const r = rel(f);
      const cur = st.libs.find((x) => x.ref.toLowerCase() === r.toLowerCase());
      if (cur) cur.on = true;
      else {
        st.libs.push({ ref: r, on: true, added: true });
        n++;
      }
    }
    drawLibs();
    if (files.length) toast(`jar ${n}개를 추가했습니다.`, 'ok');
  };
  const libAdd = h('button', { class: 'tb-btn small', text: '+ jar 추가...' });
  libAdd.onclick = async () => addLibs(await window.api.pickFiles('라이브러리 jar 선택', [{ name: 'Java 라이브러리', extensions: ['jar'] }], repo));
  const libAddDir = h('button', { class: 'tb-btn small', text: '+ 폴더의 jar 모두 추가...' });
  libAddDir.onclick = async () => {
    const dir = await window.api.pickFolder('jar 가 들어 있는 폴더 선택 (예: C:\\tomcat\\lib)');
    if (dir) addLibs(await window.api.java.jarsIn(dir));
  };

  if (!managed) {
    const secSrc = section('소스 폴더', '');
    secSrc.querySelector('.ps-title').append(srcHint);
    secSrc.append(srcList, h('div', { class: 'ps-row' }, srcAdd, srcAuto));
    const secLib = section('라이브러리 (jar)', '');
    secLib.querySelector('.ps-title').append(libCount);
    secLib.append(libFilter, libList, h('div', { class: 'ps-row' }, libAdd, libAddDir));
    body.append(secSrc, secLib);
    drawSrc();
    drawLibs();
  }

  modal({
    title: '🧱 Java 프로젝트 구조',
    body,
    wide: true,
    buttons: [
      ...(managed
        ? []
        : [
            {
              label: '다시 분석',
              onClick: () => {
                setTimeout(() => openProjectStructure(repo), 0);
                return null;
              },
            },
          ]),
      { label: '취소' },
      {
        label: '적용',
        primary: true,
        onClick: async () => {
          const patch = { jdk: st.jdk };
          if (!managed) {
            patch.sourcePaths = st.srcManual ? st.src : null;
            patch.addedLibraries = st.libs.filter((l) => l.added && l.on).map((l) => l.ref);
            patch.excludedLibraries = st.libs.filter((l) => !l.added && !l.on).map((l) => l.ref);
          }
          try {
            await saveJavaConfig(repo, patch);
          } catch (e) {
            toast(e.message, 'error', 6000);
            return false;
          }
          await restartJava(repo, '프로젝트 구조를 적용했습니다. 잠시 뒤 바뀐 구조로 다시 검사합니다.');
        },
      },
    ],
  });
}

// ---------- Java 파일을 열 때 안내 (언어 팩 미설치 시 설치 제안) ----------

const dismissedNotice = new Set();
let noticeProgressHandler = null;

export function showLanguageNotice(doc) {
  const el = $('#codeNotice');
  if (!el) return;
  if (noticeProgressHandler) {
    window.removeEventListener('java-progress', noticeProgressHandler);
    noticeProgressHandler = null;
  }
  const lang = doc.model.getLanguageId();
  const key = `${doc.repo.toLowerCase()}|${lang}`;
  if (lang !== 'java' || doc.virtual || (javaPack?.installed && !javaInstalling) || (!javaInstalling && dismissedNotice.has(key))) {
    el.hidden = true;
    return;
  }
  el.innerHTML = '';
  const msg = h('span');
  if (javaInstalling) {
    // 설치 중: 다른 파일을 열어도 같은 진행 상황을 이어서 보여 준다
    const draw = () => (msg.innerHTML = `<span class="spinner"></span> <b>Java 언어 팩 설치 중</b> · ${progressText(javaProgress)}`);
    draw();
    noticeProgressHandler = draw;
    window.addEventListener('java-progress', noticeProgressHandler);
    el.append(h('span', { class: 'cn-ico', text: '☕' }), msg);
    el.hidden = false;
    return;
  }
  msg.innerHTML =
    '<b>Java 코드 검사를 쓰려면 Java 언어 팩이 필요합니다.</b> 처음 한 번 약 130MB 를 받으면, 프로젝트의 JDK 버전(pom.xml / build.gradle) 기준으로 오류 표시·자동 완성·어노테이션 확인·정의로 이동이 됩니다. (VS Code Java 와 같은 엔진)';
  const installBtn = h('button', { class: 'btn small primary', text: '설치' });
  const closeBtn = h('button', {
    class: 'tb-btn small',
    text: '닫기',
    onclick: () => {
      dismissedNotice.add(key);
      el.hidden = true;
    },
  });
  installBtn.onclick = async () => {
    const p = installJavaPack().catch((e) => {
      // 실패하면 안내 띠에 이유와 '다시 시도' 를 보여 준다
      const cur = activeDoc();
      if (cur) showLanguageNotice(cur);
      const m = $('#codeNotice span:nth-child(2)');
      if (m) m.innerHTML = `<b>설치하지 못했습니다:</b> ${e.message}`;
      const b = $('#codeNotice .btn.primary');
      if (b) b.textContent = '다시 시도';
    });
    showLanguageNotice(doc); // 진행 상황 모드로 다시 그림
    await p;
  };
  el.append(h('span', { class: 'cn-ico', text: '☕' }), msg, h('span', { class: 'tb-spacer' }), installBtn, closeBtn);
  el.hidden = false;
}
