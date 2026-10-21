// 언어 서버(LSP) 클라이언트: Monaco 편집기 ↔ 내 PC 의 언어 서버
// 오류 표시(빨간 밑줄), 마우스 올림 정보, 자동 완성, 정의로 이동, 함수 인자 도움말, 서식 정리를 제공한다.
let monaco;
const servers = new Map(); // `${repo}|${lang}` → server
const byId = new Map(); // 서버 id → server
const pendingDiags = new Map(); // 아직 열리지 않은 파일의 진단 결과 (uri key → diagnostics)
let onDiagnosticsChanged = () => {};
let openFileHook = async () => null; // 다른 파일로 이동할 때 (정의로 이동)
let ensureModelHook = async () => null; // 다른 파일 모델 준비

// Monaco 언어 id → 언어 서버 종류
const LANG_OF = { typescript: 'typescript', javascript: 'typescript', python: 'python' };

// Java 는 언어 팩을 설치했을 때만 사용 (Java 파일을 열 때만 서버 시작)
let javaEnabled = false;
export function setJavaEnabled(v) {
  javaEnabled = !!v;
}
const JAVA_IDLE_STOP_MS = 5 * 60 * 1000; // 마지막 Java 파일을 닫고 5분 지나면 서버 종료 (메모리 반환)
let onStatusChanged = () => {};
export const onServerStatus = (fn) => (onStatusChanged = fn);
let onJdkFixed = () => {};
export const onJavaJdkFixed = (fn) => (onJdkFixed = fn);

// 저장소별로 사용자가 고른 기준 JDK
const preferredJdks = new Map();
export function setPreferredJdk(repo, home) {
  if (home) preferredJdks.set(repo.toLowerCase(), home);
  else preferredJdks.delete(repo.toLowerCase());
}

// 앱을 다시 켰을 때: 언어 서버는 저장된 색인의 예전 jar/소스 폴더 목록을 그대로 쓰고, 같은 설정을 다시 보내도 '안 바뀜' 으로 무시한다.
// → 시작할 때는 아무것도 가리키지 않는 표시용 항목을 하나 붙여 두고, 준비가 끝나면 진짜 설정을 보내서 다시 읽게 한다 (1~2초)
const REFRESH_MARK = '.codeflow/__refresh__';
function javaSettings(runtimes, project = {}, { refresh = false, root = '' } = {}) {
  const managed = ['Maven', 'Gradle'].includes(project.build);
  const libs = project.libraries || [];
  const src = project.sourcePaths || [];
  const mark = refresh && !managed;
  return {
    configuration: { runtimes, updateBuildConfiguration: 'automatic' },
    // Maven/Gradle 이 없는 프로젝트: 분석한 프로젝트 구조(.codeflow/java.json)의 jar 와 소스 폴더
    project: {
      referencedLibraries: mark ? [...libs, `${REFRESH_MARK}/*.jar`] : libs,
      ...(src.length ? { sourcePaths: mark ? [...src, REFRESH_MARK] : src } : {}),
    },
    import: {
      // 프로젝트 폴더에 .project / .classpath / .settings 를 만들지 않는다 (Git 변경 사항에 섞이지 않게)
      generatesMetadataFilesAtProjectRoot: false,
      maven: { enabled: true },
      gradle: { enabled: true, wrapper: { enabled: true } },
      exclusions: [
        '**/node_modules/**',
        '**/.metadata/**',
        '**/archetype-resources/**',
        '**/META-INF/maven/**',
        // 빌드 파일이 없는 프로젝트: 프로젝트 폴더의 Eclipse 설정(.project/.classpath)을 가져오지 않는다.
        // 가져오면 다른 PC 이름의 JDK(예: jre7)를 못 찾아 JDK 클래스가 통째로 빠지고, Eclipse 빌드처럼 출력 폴더(build/classes)를 비우거나 .project 를 고친다.
        // → CodeFlow 가 분석한 구조(.codeflow/java.json)로만 검사 (프로젝트 파일은 건드리지 않음)
        ...(!managed && root ? [root.replace(/\\/g, '/')] : []),
      ],
    },
    autobuild: { enabled: true },
    maxConcurrentBuilds: 1,
    // 후보 최대 개수: 기본 50개면 javax.* 등에 밀려 java.util 이 안 보일 수 있어 200개로 늘림
    completion: { enabled: true, guessMethodArguments: 'insertBestGuessedArguments', maxResults: 200 },
    signatureHelp: { enabled: true },
    format: { enabled: true },
    references: { includeDecompiledSources: true },
  };
}

// 저장소별 Python 인터프리터 경로 (Pyright 가 설정을 물어보면 알려 준다)
const pythonPaths = new Map();
export function setPythonPath(repo, p) {
  pythonPaths.set(repo.toLowerCase(), p);
  const s = servers.get(`${repo.toLowerCase()}|python`);
  if (s?.status === 'ready') s.notify('workspace/didChangeConfiguration', { settings: {} }); // 다시 설정을 물어보게 함
}

function configFor(server, section) {
  if (server.lang === 'java') return section === 'java' ? server.javaSettings : section?.startsWith('java.') ? null : {};
  if (server.lang !== 'python') return {};
  const pythonPath = pythonPaths.get(server.repo.toLowerCase());
  if (section === 'python') return pythonPath ? { pythonPath } : {};
  // 열린 파일만 검사 (큰 프로젝트에서도 가볍게)
  if (section === 'python.analysis') return { autoSearchPaths: true, useLibraryCodeForTypes: true, diagnosticMode: 'openFilesOnly', typeCheckingMode: 'standard' };
  return {};
}
const LSP_LANGUAGE_ID = (model) => {
  const path = model.uri.path.toLowerCase();
  if (path.endsWith('.tsx')) return 'typescriptreact';
  if (path.endsWith('.jsx')) return 'javascriptreact';
  return model.getLanguageId();
};

export const serverLangFor = (model) => (model.getLanguageId() === 'java' ? (javaEnabled ? 'java' : null) : LANG_OF[model.getLanguageId()] || null);
// 편집기(Monaco)를 아직 불러오지 않았어도(코드 화면을 안 연 상태) 언어 서버를 미리 켤 수 있도록 URI 처리를 직접 한다
const keyOf = (uri) => decodeURIComponent(uri.replace(/^file:\/\/\/?/, '').split('?')[0]).replace(/\//g, '\\').toLowerCase();
// C:\a b\c → file:///c%3A/a%20b/c (Monaco 의 Uri.file 과 같은 모양)
function fileUri(p) {
  const s = p.replace(/\\/g, '/');
  const m = s.match(/^([A-Za-z]):(.*)$/);
  const path = m ? `/${m[1].toLowerCase()}:${m[2]}` : s.startsWith('/') ? s : `/${s}`;
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`;
}

// 언어 서버 메시지 수신은 처음부터 연결해 둔다 (코드 화면을 열기 전에 미리 켠 Java 서버도 동작하게)
window.api.lsp.onMessage((id, msg) => byId.get(id)?.receive(msg));
window.api.lsp.onExit((id) => {
  const s = byId.get(id);
  if (!s) return;
  byId.delete(id);
  servers.delete(s.key);
  clearMarkers(s);
  onDiagnosticsChanged();
  onStatusChanged();
});

function clearMarkers(s) {
  if (!monaco) return;
  for (const uri of s.docs.keys()) {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (model) monaco.editor.setModelMarkers(model, 'lsp', []);
  }
}

export function initLsp(m, { onDiagnostics, openFile, ensureModel }) {
  monaco = m;
  onDiagnosticsChanged = onDiagnostics || onDiagnosticsChanged;
  openFileHook = openFile || openFileHook;
  ensureModelHook = ensureModel || ensureModelHook;

  // Monaco 자체 TS 기능은 끈다 (프로젝트를 모르는 상태라 틀린 오류를 내기 때문). 언어 서버가 대신한다.
  for (const d of [monaco.languages.typescript.typescriptDefaults, monaco.languages.typescript.javascriptDefaults]) {
    d.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true });
    d.setModeConfiguration({
      completionItems: false,
      hovers: false,
      documentSymbols: true,
      definitions: false,
      references: false,
      documentHighlights: true,
      rename: false,
      diagnostics: false,
      documentRangeFormattingEdits: false,
      signatureHelp: false,
      onTypeFormattingEdits: false,
      codeActions: false,
      inlayHints: false,
    });
  }


  for (const lang of ['typescript', 'javascript', 'python', 'java']) registerProviders(lang);
}

class Server {
  constructor(key, repo, lang) {
    this.key = key;
    this.repo = repo;
    this.lang = lang;
    this.seq = 0;
    this.pending = new Map();
    this.docs = new Map(); // uri → version
    this.status = 'starting';
    this.ready = this.start();
  }

  async start() {
    const r = await window.api.lsp.start(this.lang, this.repo, { preferredJdk: preferredJdks.get(this.repo.toLowerCase()) });
    if (!r.ok) {
      this.status = 'error';
      this.error = r.error;
      onStatusChanged();
      throw new Error(r.error);
    }
    this.id = r.data.id;
    this.tsdk = r.data.tsdk;
    if (r.data.java) {
      this.java = r.data.java; // { runtimes, project }
      this.javaSettings = javaSettings(r.data.java.runtimes, r.data.java.project, { refresh: true, root: this.repo });
      this.javaState = { ready: false, message: 'Java 언어 서버 시작 중' };
      // 프로젝트 준비(ServiceReady)가 끝나야 자동 완성 등이 정확하므로, 요청은 이 약속을 기다린다
      this.javaReady = new Promise((res) => (this.resolveJavaReady = res));
    }
    byId.set(this.id, this);
    const rootUri = fileUri(this.repo);
    const init = await this.request('initialize', {
      processId: null,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: this.repo.split(/[\\/]/).pop() }],
      locale: 'ko',
      capabilities: {
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: true },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'] }, contextSupport: true },
          signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'] } },
          definition: { linkSupport: true },
          formatting: {},
        },
        workspace: { configuration: true, workspaceFolders: true },
      },
      initializationOptions:
        this.lang === 'java'
          ? {
              settings: { java: this.javaSettings },
              // 라이브러리/JDK 클래스로 '정의로 이동' 할 수 있도록 (jdt:// 내용 요청)
              extendedClientCapabilities: { classFileContentsSupport: true, progressReportProvider: false },
            }
          : {
              locale: 'ko',
              ...(this.tsdk?.source === 'project' ? { tsserver: { path: this.tsdk.path } } : {}),
              preferences: { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true },
            },
    });
    this.caps = init.capabilities || {};
    this.notify('initialized', {});
    this.status = 'ready';
    return this;
  }

  // 빌드 파일이 없는 프로젝트: 언어 서버가 고른 JDK 대신 자기 실행용 Java 21 로 프로젝트를 만드는 경우가 가끔 있다
  // (시작 순서 문제) → 실제 적용된 JDK 를 확인하고 다르면 설정을 다시 보내 바로잡는다
  // 진짜 프로젝트 설정(jar, 소스 폴더, JDK)을 실행 중인 서버에 보낸다 → 바뀐 부분만 1~2초 안에 다시 검사
  applyJavaSettings() {
    this.javaSettings = javaSettings(this.java.runtimes, this.java.project, { root: this.repo });
    this.notify('workspace/didChangeConfiguration', { settings: { java: this.javaSettings } });
    this.appliedAt = Date.now();
    this.jdkChecked = false;
    clearTimeout(this.verifyTimer);
    this.verifyTimer = setTimeout(() => this.verifyJdk(), 5000);
  }

  async verifyJdk() {
    const def = this.java?.runtimes?.find((r) => r.default);
    const uri = [...this.docs.keys()].find((u) => u.startsWith('file:'));
    if (!def || !uri || this.jdkChecked || !this.javaState?.ready || !this.appliedAt || Date.now() - this.appliedAt < 4000 || ['Maven', 'Gradle'].includes(this.java.project?.build)) return;
    this.jdkChecked = true;
    const key = 'org.eclipse.jdt.ls.core.vm.location';
    const r = await this.request('workspace/executeCommand', { command: 'java.project.getSettings', arguments: [uri, [key]] }).catch(() => null);
    const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (!r?.[key] || norm(r[key]) === norm(def.path)) return;
    console.warn('[java] JDK 다시 적용', r[key], '→', def.path);
    this.notify('workspace/didChangeConfiguration', { settings: { java: this.javaSettings } });
    onJdkFixed(this);
  }

  request(method, params) {
    const id = ++this.seq;
    window.api.lsp.send(this.id, { jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method, params) {
    window.api.lsp.send(this.id, { jsonrpc: '2.0', method, params });
  }

  receive(msg) {
    if (msg.id !== undefined && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      return;
    }
    if (msg.method === 'textDocument/publishDiagnostics') return applyDiagnostics(msg.params);
    if (msg.method === '$/typescriptVersion') this.tsVersion = msg.params;
    // Java 준비 상황 (Maven/Gradle 가져오기, 색인 등) → 상태 표시줄
    if (msg.method === 'language/status' && this.javaState) {
      const { type, message } = msg.params || {};
      if (type === 'ServiceReady' || type === 'Started') {
        this.javaState = { ready: true, message: '' };
        this.resolveJavaReady?.();
        if (!this.appliedAt) this.applyJavaSettings();
      }
      else if (type === 'Error') this.javaState = { ready: false, error: true, message: message || '오류' };
      else if (type === 'Starting' && !this.javaState.ready) this.javaState = { ready: false, message: javaStatusText(message) };
      onStatusChanged();
    }
    // 서버가 클라이언트에게 묻는 요청에는 기본값으로 답한다
    if (msg.id !== undefined && msg.method) {
      let result = null;
      if (msg.method === 'workspace/configuration') result = (msg.params?.items || []).map((it) => configFor(this, it.section));
      if (msg.method === 'workspace/applyEdit') result = { applied: false };
      window.api.lsp.send(this.id, { jsonrpc: '2.0', id: msg.id, result });
    }
  }
}

function serverFor(repo, lang) {
  const key = `${repo.toLowerCase()}|${lang}`;
  let s = servers.get(key);
  if (!s) {
    s = new Server(key, repo, lang);
    servers.set(key, s);
    s.ready.catch((e) => {
      console.error(e);
      servers.delete(key);
    });
  }
  return s;
}

// 언어 서버 진행 메시지를 짧은 한국어로
function javaStatusText(message = '') {
  const pct = (message.match(/(\d+)%/) || [])[1];
  const p = pct && +pct <= 100 ? ` ${pct}%` : '';
  if (/repo\.maven|https?:\/\//i.test(message)) return `Maven 라이브러리 받는 중${p}`;
  if (/Importing/i.test(message)) return `프로젝트 가져오는 중${p}`;
  if (/Refreshing|Building|Opening/i.test(message)) return `색인 만드는 중${p}`;
  return `Java 준비 중${p}`;
}

// 편집기에서 연 파일을 언어 서버에 알린다
export async function attachModel(repo, model) {
  const lang = serverLangFor(model);
  if (!lang) return;
  const s = serverFor(repo, lang);
  clearTimeout(s.idleTimer);
  onStatusChanged();
  await s.ready;
  const uri = model.uri.toString();
  if (s.docs.has(uri)) return;
  s.docs.set(uri, model.getVersionId());
  model.__lsp = s;
  s.notify('textDocument/didOpen', { textDocument: { uri, languageId: LSP_LANGUAGE_ID(model), version: model.getVersionId(), text: model.getValue() } });
  if (s.lang === 'java') s.verifyJdk();
  let t;
  // 입력이 잠깐 멈추면 변경 내용을 보낸다. 자동 완성 등 요청 직전에는 즉시 보낸다(__flush).
  const flush = () => {
    clearTimeout(t);
    if (!s.docs.has(uri) || model.isDisposed() || s.docs.get(uri) === model.getVersionId()) return;
    s.docs.set(uri, model.getVersionId());
    s.notify('textDocument/didChange', { textDocument: { uri, version: model.getVersionId() }, contentChanges: [{ text: model.getValue() }] });
  };
  model.__flush = flush;
  model.onDidChangeContent(() => {
    clearTimeout(t);
    t = setTimeout(flush, 150);
  });
  const p = pendingDiags.get(keyOf(uri));
  if (p) applyDiagnostics({ uri, diagnostics: p });
}

export function notifySaved(model) {
  const s = model.__lsp;
  if (s?.docs.has(model.uri.toString())) s.notify('textDocument/didSave', { textDocument: { uri: model.uri.toString() } });
}

export function detachModel(model) {
  const s = model.__lsp;
  const uri = model.uri.toString();
  if (s?.docs.has(uri)) {
    s.docs.delete(uri);
    s.notify('textDocument/didClose', { textDocument: { uri } });
    // Java 는 무거우므로 열린 Java 파일이 없고 다른 프로젝트 탭을 보고 있으면 잠시 뒤 서버를 끈다 (다시 열면 저장된 색인으로 빠르게 시작)
    if (s.lang === 'java' && !s.docs.size && !sameRepo(s.repo, activeRepo)) s.idleTimer = setTimeout(() => stopServer(s), JAVA_IDLE_STOP_MS);
  }
  monaco.editor.setModelMarkers(model, 'lsp', []);
}

async function stopServer(s) {
  clearTimeout(s.idleTimer);
  servers.delete(s.key);
  clearMarkers(s);
  s.docs.clear();
  if (s.id) {
    byId.delete(s.id);
    await window.api.lsp.stop(s.id);
  }
  onStatusChanged();
}

// 언어 서버 다시 시작 (기준 JDK 변경 등) → 열린 파일을 다시 연결
export async function restartServer(repo, lang, models) {
  const s = servers.get(`${repo.toLowerCase()}|${lang}`);
  if (s) await stopServer(s);
  for (const m of models) if (!m.isDisposed()) attachModel(repo, m).catch(() => {});
}

// 프로젝트 구조/JDK 를 바꾼 뒤: 서버를 다시 시작하지 않고 새 설정만 보낸다. 실행 중인 서버가 없으면 false
export async function updateJavaProject(repo) {
  const s = servers.get(`${repo.toLowerCase()}|java`);
  if (!s || s.status !== 'ready') return false;
  s.java = await window.api.java.startInfo(repo);
  s.applyJavaSettings();
  onStatusChanged();
  return true;
}

// ---------- 프로젝트 탭을 열거나 고를 때 Java 언어 서버 미리 켜기 ----------
let activeRepo = null;
const sameRepo = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

// 지금 보고 있는 프로젝트 탭. 다른 탭의 Java 서버는 열린 Java 파일이 없으면 5분 뒤 끈다
export function setActiveRepo(repo) {
  activeRepo = repo || null;
  for (const s of servers.values()) {
    if (s.lang !== 'java') continue;
    clearTimeout(s.idleTimer);
    if (!sameRepo(s.repo, activeRepo) && !s.docs.size) s.idleTimer = setTimeout(() => stopServer(s), JAVA_IDLE_STOP_MS);
  }
}

// Java 파일을 열기 전에 서버를 켜서 프로젝트 분석·색인을 끝내 둔다 → 파일을 열면 바로 검사·자동 완성
export function warmJava(repo) {
  if (!javaEnabled) return;
  const s = serverFor(repo, 'java');
  clearTimeout(s.idleTimer);
  onStatusChanged();
}

export function serverInfo(repo, lang = 'typescript') {
  const s = servers.get(`${repo.toLowerCase()}|${lang}`);
  if (!s) return null;
  return { status: s.status, ts: s.tsVersion, tsdk: s.tsdk, java: s.java, javaState: s.javaState, error: s.error };
}

// Java: 언어 서버가 이 파일(프로젝트)에 실제로 적용한 Java 버전과 JDK 경로
export async function javaEffectiveSettings(model) {
  const s = await ready(model);
  if (!s || s.lang !== 'java') return null;
  const keys = ['org.eclipse.jdt.core.compiler.compliance', 'org.eclipse.jdt.ls.core.vm.location'];
  const r = await s.request('workspace/executeCommand', { command: 'java.project.getSettings', arguments: [model.uri.toString(), keys] }).catch(() => null);
  if (!r) return null;
  return { level: r[keys[0]] || null, jdk: r[keys[1]] || null };
}

// 프로젝트 탭을 닫으면 그 프로젝트의 언어 서버를 모두 끈다
export async function stopRepoServers(repo) {
  for (const s of [...servers.values()]) if (s.repo.toLowerCase() === repo.toLowerCase()) await stopServer(s);
}

// ---------- 진단(오류/경고) ----------

const SEVERITY = () => ({ 1: monaco.MarkerSeverity.Error, 2: monaco.MarkerSeverity.Warning, 3: monaco.MarkerSeverity.Info, 4: monaco.MarkerSeverity.Hint });

function applyDiagnostics({ uri, diagnostics }) {
  if (!monaco) return pendingDiags.set(keyOf(uri), diagnostics); // 편집기를 열기 전: 파일을 열면 표시
  const model = monaco.editor.getModels().find((m) => keyOf(m.uri.toString()) === keyOf(uri));
  if (!model) {
    pendingDiags.set(keyOf(uri), diagnostics);
    return;
  }
  pendingDiags.delete(keyOf(uri));
  const sev = SEVERITY();
  const markers = diagnostics.map((d) => ({
    severity: sev[d.severity || 1],
    message: d.message,
    source: d.source,
    code: d.code !== undefined ? String(d.code) : undefined,
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
    tags: (d.tags || []).map((t) => (t === 1 ? monaco.MarkerTag.Unnecessary : monaco.MarkerTag.Deprecated)),
  }));
  monaco.editor.setModelMarkers(model, 'lsp', markers);
  onDiagnosticsChanged();
}

// ---------- 변환 ----------

const pos = (p) => ({ line: p.lineNumber - 1, character: p.column - 1 });
const toRange = (r) => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
const docParams = (model, position) => ({ textDocument: { uri: model.uri.toString() }, position: pos(position) });

function markdown(contents) {
  if (!contents) return [];
  const arr = Array.isArray(contents) ? contents : [contents];
  return arr
    .map((c) => {
      if (typeof c === 'string') return { value: c };
      if (c.kind) return { value: c.kind === 'markdown' ? c.value : `\`\`\`\n${c.value}\n\`\`\`` };
      if (c.language) return { value: `\`\`\`${c.language}\n${c.value}\n\`\`\`` };
      return null;
    })
    .filter((c) => c && c.value);
}

// LSP CompletionItemKind(1~25) → Monaco
function kindMap() {
  const K = monaco.languages.CompletionItemKind;
  return [null, K.Text, K.Method, K.Function, K.Constructor, K.Field, K.Variable, K.Class, K.Interface, K.Module, K.Property, K.Unit, K.Value, K.Enum, K.Keyword, K.Snippet, K.Color, K.File, K.Reference, K.Folder, K.EnumMember, K.Constant, K.Struct, K.Event, K.Operator, K.TypeParameter];
}

async function ready(model) {
  if (!model.__lsp && model.uri.scheme === 'jdt') {
    // 라이브러리 클래스 안에서도 마우스 올림/정의로 이동이 되도록 현재 Java 서버에 연결
    const s = [...servers.values()].find((x) => x.lang === 'java' && x.status === 'ready');
    if (s && !s.docs.has(model.uri.toString())) {
      s.docs.set(model.uri.toString(), model.getVersionId());
      s.notify('textDocument/didOpen', { textDocument: { uri: model.uri.toString(), languageId: 'java', version: model.getVersionId(), text: model.getValue() } });
    }
    model.__lsp = s;
  }
  const s = model.__lsp;
  if (!s) return null;
  try {
    await s.ready;
  } catch {
    return null;
  }
  if (!s.docs.has(model.uri.toString())) return null;
  // Java: 프로젝트를 가져오는 중이면 끝날 때까지 기다린다(최대 20초) — 빈 결과가 오지 않게
  if (s.javaReady && !s.javaState?.ready) await Promise.race([s.javaReady, new Promise((r) => setTimeout(r, 20000))]);
  model.__flush?.();
  return s;
}

// 다른 파일 위치로 이동할 수 있도록 대상 파일 모델을 미리 만든다
async function toLocations(result, server) {
  if (!result) return [];
  const arr = Array.isArray(result) ? result : [result];
  const out = [];
  for (const l of arr) {
    const uri = l.targetUri || l.uri;
    const range = l.targetSelectionRange || l.range;
    if (!uri || !range) continue;
    if (uri.startsWith('jdt:')) {
      // JDK/라이브러리 클래스: 언어 서버에서 소스(또는 디컴파일 결과)를 받아 읽기 전용으로 연다
      const vuri = monaco.Uri.parse(uri);
      if (!monaco.editor.getModel(vuri)) {
        const text = await server?.request('java/classFileContents', { uri }).catch(() => null);
        if (text == null) continue;
        monaco.editor.createModel(text, 'java', vuri);
      }
      out.push({ uri: vuri, range: toRange(range) });
      continue;
    }
    await ensureModelHook(monaco.Uri.parse(uri).fsPath);
    out.push({ uri: monaco.Uri.parse(uri), range: toRange(range) });
  }
  return out;
}

function registerProviders(language) {
  monaco.languages.registerHoverProvider(language, {
    async provideHover(model, position) {
      const s = await ready(model);
      if (!s) return null;
      const r = await s.request('textDocument/hover', docParams(model, position)).catch(() => null);
      if (!r) return null;
      return { contents: markdown(r.contents), range: r.range ? toRange(r.range) : undefined };
    },
  });

  monaco.languages.registerCompletionItemProvider(language, {
    triggerCharacters: ['.', '"', "'", '`', '/', '@', '<', '#'],
    async provideCompletionItems(model, position, context) {
      const s = await ready(model);
      if (!s) return { suggestions: [] };
      const r = await s
        .request('textDocument/completion', { ...docParams(model, position), context: { triggerKind: context.triggerKind + 1, triggerCharacter: context.triggerCharacter } })
        .catch(() => null);
      const items = Array.isArray(r) ? r : r?.items || [];
      const word = model.getWordUntilPosition(position);
      const defRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const kinds = kindMap();
      return {
        incomplete: !!r?.isIncomplete,
        suggestions: items.map((it) => {
          // LSP 3.17: 공통 값(itemDefaults)과 textEditText 로 보내는 서버(Java 등) 대응
          const defs = r?.itemDefaults || {};
          const er = defs.editRange;
          const edit = it.textEdit || (er && (it.textEditText !== undefined || it.insertText !== undefined) ? { ...(er.start ? { range: er } : er), newText: it.textEditText ?? it.insertText ?? it.label } : null);
          if (it.insertTextFormat === undefined && defs.insertTextFormat !== undefined) it.insertTextFormat = defs.insertTextFormat;
          const range = edit ? (edit.range ? toRange(edit.range) : { insert: toRange(edit.insert), replace: toRange(edit.replace) }) : defRange;
          return {
            label: it.label,
            kind: kinds[it.kind] ?? monaco.languages.CompletionItemKind.Text,
            detail: it.detail,
            documentation: it.documentation ? markdown(it.documentation)[0] : undefined,
            insertText: edit?.newText ?? it.insertText ?? it.label,
            insertTextRules: it.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
            range,
            sortText: it.sortText,
            filterText: it.filterText,
            preselect: it.preselect,
            additionalTextEdits: (it.additionalTextEdits || []).map((e) => ({ range: toRange(e.range), text: e.newText })),
            __lsp: it,
            __server: s,
          };
        }),
      };
    },
    // 항목을 고르면 상세 설명/자동 import 정보를 더 받아온다
    async resolveCompletionItem(item) {
      const s = item.__server;
      if (!s?.caps?.completionProvider?.resolveProvider) return item;
      const r = await s.request('completionItem/resolve', item.__lsp).catch(() => null);
      if (!r) return item;
      return {
        ...item,
        detail: r.detail || item.detail,
        documentation: r.documentation ? markdown(r.documentation)[0] : item.documentation,
        additionalTextEdits: (r.additionalTextEdits || []).map((e) => ({ range: toRange(e.range), text: e.newText })),
      };
    },
  });

  monaco.languages.registerDefinitionProvider(language, {
    async provideDefinition(model, position) {
      const s = await ready(model);
      if (!s) return [];
      return toLocations(await s.request('textDocument/definition', docParams(model, position)).catch(() => null), s);
    },
  });

  monaco.languages.registerReferenceProvider(language, {
    async provideReferences(model, position) {
      const s = await ready(model);
      if (!s) return [];
      return toLocations(await s.request('textDocument/references', { ...docParams(model, position), context: { includeDeclaration: true } }).catch(() => null), s);
    },
  });

  monaco.languages.registerSignatureHelpProvider(language, {
    signatureHelpTriggerCharacters: ['(', ','],
    async provideSignatureHelp(model, position) {
      const s = await ready(model);
      if (!s) return null;
      const r = await s.request('textDocument/signatureHelp', docParams(model, position)).catch(() => null);
      if (!r || !r.signatures?.length) return null;
      return {
        value: {
          activeSignature: r.activeSignature || 0,
          activeParameter: r.activeParameter || 0,
          signatures: r.signatures.map((sg) => ({
            label: sg.label,
            documentation: sg.documentation ? markdown(sg.documentation)[0] : undefined,
            parameters: (sg.parameters || []).map((p) => ({ label: p.label, documentation: p.documentation ? markdown(p.documentation)[0] : undefined })),
          })),
        },
        dispose() {},
      };
    },
  });

  monaco.languages.registerDocumentFormattingEditProvider(language, {
    async provideDocumentFormattingEdits(model, options) {
      const s = await ready(model);
      if (!s) return [];
      const r = await s
        .request('textDocument/formatting', { textDocument: { uri: model.uri.toString() }, options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } })
        .catch(() => null);
      return (r || []).map((e) => ({ range: toRange(e.range), text: e.newText }));
    },
  });
}

export function openerFor() {
  return {
    async openCodeEditor(_source, resource, selectionOrPosition) {
      await openFileHook(resource.scheme === 'file' ? resource.fsPath : resource.toString(), selectionOrPosition);
      return true;
    },
  };
}
