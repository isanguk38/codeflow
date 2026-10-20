// 코드 화면 아래 터미널 패널 (VS Code 처럼): 여러 터미널 탭, 셸 선택, 복사/붙여넣기, 크기 자동 맞춤
import { $, h, menuAt, toast, splitter } from './ui.js';
import { state } from './state.js';

const terms = []; // { id, repo, shell, xterm, fit, el, exited }
const activeByRepo = new Map();
let shellList = null;
let panel;
let visible = localStorage.getItem('term.visible') === '1';
let inited = false;

const THEMES = {
  dark: { background: '#1e1f22', foreground: '#dfe1e5', cursor: '#dfe1e5', selectionBackground: '#2e436e', black: '#1e1f22', brightBlack: '#6f737a' },
  light: { background: '#ffffff', foreground: '#1e1f22', cursor: '#1e1f22', selectionBackground: '#d5e1ff', black: '#1e1f22', brightBlack: '#8c8f96', white: '#e8e8e8', brightWhite: '#f5f5f5', yellow: '#9a6700', brightYellow: '#9a6700' },
};
const theme = () => THEMES[document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'];

export function initTerminal(container, handle) {
  panel = container;
  panel.innerHTML = `
    <div class="term-bar">
      <span class="term-title">터미널</span>
      <div class="term-tabs" id="termTabs"></div>
      <span class="tb-spacer"></span>
      <button class="tb-btn small" id="termNew" title="새 터미널 (셸 선택)">＋ ▾</button>
      <button class="tb-btn small" id="termKill" title="현재 터미널 종료">🗑</button>
      <button class="tb-btn small" id="termHide" title="패널 닫기 (Ctrl+\`)">✕</button>
    </div>
    <div class="term-body" id="termBody"></div>`;
  splitter(handle, panel, { axis: 'y', min: 90, max: 900, invert: true, key: 'termPanel' });
  $('#termNew').onclick = async (e) => {
    const btn = e.currentTarget;
    const list = await getShells();
    menuAt(btn, [{ header: '새 터미널' }, ...list.map((s) => ({ label: s.name, onClick: () => newTerminal(s.id) }))]);
  };
  $('#termKill').onclick = () => {
    const t = activeTerm();
    if (t) killTerm(t);
  };
  $('#termHide').onclick = () => setVisible(false);

  window.api.term.onData((id, data) => terms.find((t) => t.id === id)?.xterm.write(data));
  window.api.term.onExit((id, code) => {
    const t = terms.find((x) => x.id === id);
    if (!t) return;
    t.exited = true;
    t.xterm.write(`\r\n\x1b[90m[프로세스가 종료되었습니다 (코드 ${code})] 아무 키나 누르면 터미널을 닫습니다.\x1b[0m\r\n`);
    renderTabs();
  });
  // 패널 크기가 바뀌면 터미널 글자 수/줄 수를 다시 맞춘다
  new ResizeObserver(() => fitActive()).observe($('#termBody'));
  new MutationObserver(() => terms.forEach((t) => (t.xterm.options.theme = theme()))).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  inited = true;
}

async function getShells() {
  if (!shellList) shellList = await window.api.term.shells();
  return shellList;
}

export const isTerminalVisible = () => visible;

// 코드 화면이 보일 때 / 저장소(탭)가 바뀔 때 호출
export function showTerminalsFor() {
  if (!inited) return;
  panel.hidden = !visible;
  panel.previousElementSibling.hidden = !visible; // 크기 조절 막대
  window.dispatchEvent(new Event('terminal-visibility'));
  if (!visible) return;
  const mine = terms.filter((t) => t.repo === state.repo);
  if (!mine.length) newTerminal(localStorage.getItem('term.shell') || 'powershell');
  else activate(activeByRepo.get(state.repo) || mine[0].id);
}

export function setVisible(v) {
  visible = v;
  localStorage.setItem('term.visible', v ? '1' : '0');
  showTerminalsFor();
  if (v) setTimeout(() => activeTerm()?.xterm.focus(), 50);
}

export const toggleTerminal = () => setVisible(!visible);

const activeTerm = () => terms.find((t) => t.id === activeByRepo.get(state.repo) && t.repo === state.repo);

export async function newTerminal(shellId) {
  if (!state.repo) return;
  if (!visible) {
    visible = true;
    localStorage.setItem('term.visible', '1');
    panel.hidden = false;
    panel.previousElementSibling.hidden = false;
    window.dispatchEvent(new Event('terminal-visibility'));
  }
  localStorage.setItem('term.shell', shellId);
  const el = h('div', { class: 'term-pane' });
  $('#termBody').append(el);
  const xterm = new window.Terminal({
    fontFamily: "'JetBrains Mono', 'D2Coding', Consolas, monospace",
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10000,
    theme: theme(),
    allowProposedApi: true,
  });
  const fit = new window.FitAddon.FitAddon();
  xterm.loadAddon(fit);
  xterm.open(el);
  try {
    fit.fit();
  } catch {}
  const r = await window.api.term.create({ shellId, cwd: state.repo, cols: xterm.cols, rows: xterm.rows });
  if (!r.ok) {
    el.remove();
    xterm.dispose();
    return toast(`터미널을 시작하지 못했습니다: ${r.error}`, 'error', 6000);
  }
  const t = { id: r.data.id, repo: state.repo, shell: r.data.shell, xterm, fit, el, exited: false };
  terms.push(t);
  xterm.onData((d) => {
    if (t.exited) return killTerm(t);
    window.api.term.write(t.id, d);
  });
  xterm.onResize(({ cols, rows }) => window.api.term.resize(t.id, cols, rows));
  // Windows 터미널처럼: 선택 영역이 있으면 Ctrl+C 는 복사, Ctrl+V 는 붙여넣기, 우클릭은 복사/붙여넣기
  xterm.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && !e.shiftKey && k === 'c' && xterm.hasSelection()) {
      window.api.copy(xterm.getSelection());
      xterm.clearSelection();
      return false;
    }
    if (e.ctrlKey && (k === 'v' || (e.shiftKey && k === 'v'))) {
      e.preventDefault();
      xterm.paste(window.api.paste());
      return false;
    }
    if (e.ctrlKey && e.code === 'Backquote') return false; // 패널 토글은 앱이 처리
    return true;
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (xterm.hasSelection()) {
      window.api.copy(xterm.getSelection());
      xterm.clearSelection();
      toast('복사했습니다.', 'ok', 1200);
    } else xterm.paste(window.api.paste());
  });
  activate(t.id);
  xterm.focus();
}

function activate(id) {
  activeByRepo.set(state.repo, id);
  for (const t of terms) t.el.hidden = !(t.id === id && t.repo === state.repo);
  renderTabs();
  fitActive();
}

function fitActive() {
  const t = activeTerm();
  if (!t || !visible || panel.hidden) return;
  requestAnimationFrame(() => {
    try {
      t.fit.fit();
    } catch {}
  });
}

function killTerm(t) {
  window.api.term.kill(t.id);
  t.xterm.dispose();
  t.el.remove();
  terms.splice(terms.indexOf(t), 1);
  const mine = terms.filter((x) => x.repo === state.repo);
  if (mine.length) activate(mine[mine.length - 1].id);
  else {
    activeByRepo.delete(state.repo);
    renderTabs();
    setVisible(false);
  }
}

function renderTabs() {
  const box = $('#termTabs');
  if (!box) return;
  box.innerHTML = '';
  const mine = terms.filter((t) => t.repo === state.repo);
  mine.forEach((t, i) => {
    const tab = h(
      'div',
      { class: `term-tab ${t.id === activeByRepo.get(state.repo) ? 'active' : ''} ${t.exited ? 'exited' : ''}`, title: `${t.shell.name}${t.exited ? ' (종료됨)' : ''}` },
      h('span', { text: `${i + 1}: ${t.shell.name}` }),
      h('button', { class: 'term-tab-x', text: '✕', title: '이 터미널 종료', onclick: (e) => (e.stopPropagation(), killTerm(t)) })
    );
    tab.onclick = () => {
      activate(t.id);
      t.xterm.focus();
    };
    box.append(tab);
  });
}
