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

// 저장소별 Python 인터프리터 경로 (Pyright 가 설정을 물어보면 알려 준다)
const pythonPaths = new Map();
export function setPythonPath(repo, p) {
  pythonPaths.set(repo.toLowerCase(), p);
  const s = servers.get(`${repo.toLowerCase()}|python`);
  if (s?.status === 'ready') s.notify('workspace/didChangeConfiguration', { settings: {} }); // 다시 설정을 물어보게 함
}

function configFor(server, section) {
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

export const serverLangFor = (model) => LANG_OF[model.getLanguageId()] || null;
const keyOf = (uri) => monaco.Uri.parse(uri).fsPath.toLowerCase();

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

  window.api.lsp.onMessage((id, msg) => byId.get(id)?.receive(msg));
  window.api.lsp.onExit((id) => {
    const s = byId.get(id);
    if (!s) return;
    byId.delete(id);
    servers.delete(s.key);
    for (const uri of s.docs.keys()) {
      const model = monaco.editor.getModel(monaco.Uri.parse(uri));
      if (model) monaco.editor.setModelMarkers(model, 'lsp', []);
    }
    onDiagnosticsChanged();
  });

  for (const lang of ['typescript', 'javascript', 'python']) registerProviders(lang);
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
    const r = await window.api.lsp.start(this.lang, this.repo);
    if (!r.ok) {
      this.status = 'error';
      throw new Error(r.error);
    }
    this.id = r.data.id;
    this.tsdk = r.data.tsdk;
    byId.set(this.id, this);
    const rootUri = monaco.Uri.file(this.repo).toString();
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
      initializationOptions: {
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

// 편집기에서 연 파일을 언어 서버에 알린다
export async function attachModel(repo, model) {
  const lang = serverLangFor(model);
  if (!lang) return;
  const s = serverFor(repo, lang);
  await s.ready;
  const uri = model.uri.toString();
  if (s.docs.has(uri)) return;
  s.docs.set(uri, model.getVersionId());
  model.__lsp = s;
  s.notify('textDocument/didOpen', { textDocument: { uri, languageId: LSP_LANGUAGE_ID(model), version: model.getVersionId(), text: model.getValue() } });
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
  }
  monaco.editor.setModelMarkers(model, 'lsp', []);
}

export function serverInfo(repo, lang = 'typescript') {
  const s = servers.get(`${repo.toLowerCase()}|${lang}`);
  if (!s) return null;
  return { status: s.status, ts: s.tsVersion, tsdk: s.tsdk };
}

export async function stopRepoServers(repo) {
  for (const s of [...servers.values()]) {
    if (s.repo.toLowerCase() !== repo.toLowerCase()) continue;
    servers.delete(s.key);
    if (s.id) await window.api.lsp.stop(s.id);
  }
}

// ---------- 진단(오류/경고) ----------

const SEVERITY = () => ({ 1: monaco.MarkerSeverity.Error, 2: monaco.MarkerSeverity.Warning, 3: monaco.MarkerSeverity.Info, 4: monaco.MarkerSeverity.Hint });

function applyDiagnostics({ uri, diagnostics }) {
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
  const s = model.__lsp;
  if (!s) return null;
  try {
    await s.ready;
  } catch {
    return null;
  }
  if (!s.docs.has(model.uri.toString())) return null;
  model.__flush?.();
  return s;
}

// 다른 파일 위치로 이동할 수 있도록 대상 파일 모델을 미리 만든다
async function toLocations(result) {
  if (!result) return [];
  const arr = Array.isArray(result) ? result : [result];
  const out = [];
  for (const l of arr) {
    const uri = l.targetUri || l.uri;
    const range = l.targetSelectionRange || l.range;
    if (!uri || !range) continue;
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
          const edit = it.textEdit;
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
      return toLocations(await s.request('textDocument/definition', docParams(model, position)).catch(() => null));
    },
  });

  monaco.languages.registerReferenceProvider(language, {
    async provideReferences(model, position) {
      const s = await ready(model);
      if (!s) return [];
      return toLocations(await s.request('textDocument/references', { ...docParams(model, position), context: { includeDeclaration: true } }).catch(() => null));
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
      await openFileHook(resource.fsPath, selectionOrPosition);
      return true;
    },
  };
}
