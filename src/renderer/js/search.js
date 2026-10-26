// 프로젝트 전체 검색 (Ctrl+Shift+F) — IntelliJ 'Find in Files' 처럼
// 위: 검색어 + 옵션(대소문자 Alt+C / 단어 Alt+W / 정규식 Alt+X) + 파일 마스크 + 폴더 범위
// 가운데: 결과(이름이 맞는 파일·폴더, 내용이 맞는 줄) / 아래: 미리 보기
// ↑↓ 이동, Enter 열기, Esc 닫기
import { h, esc } from './ui.js';
import { state } from './state.js';
import { openFile, activateCode, selectedText } from './code.js';

const OPT_KEY = 'search.opts';
const load = () => {
  try {
    return JSON.parse(localStorage.getItem(OPT_KEY)) || {};
  } catch {
    return {};
  }
};
const opts = { query: '', matchCase: false, words: false, regex: false, mask: '', dir: '', ...load() };
const saveOpts = () => localStorage.setItem(OPT_KEY, JSON.stringify({ ...opts, dir: '' }));

let root = null;
let seq = 0;
let curId = null;
let rows = []; // { kind: 'name'|'hit', rel, dir?, line?, text?, ranges? }
let sel = -1;
let nameCount = 0;
let summary = null;
let timer = null;

const absOf = (rel) => `${state.repo}\\${rel.replace(/\//g, '\\')}`;
const baseOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1);
const dirOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

window.api.search.onFound((d) => {
  if (d.id !== curId || !root) return;
  if (d.names) for (const n of d.names) rows.push({ kind: 'name', rel: n.rel, dir: n.dir }), nameCount++;
  if (d.hits) for (const f of d.hits) for (const m of f.matches) rows.push({ kind: 'hit', rel: f.rel, ...m });
  drawList();
  // 첫 내용 결과가 오면 바로 골라서 미리 보기 (다 찾을 때까지 기다리지 않음)
  if (sel < 0 && d.hits?.length) requestAnimationFrame(() => sel < 0 && select(rows.findIndex((r) => r.kind === 'hit')));
});
window.api.search.onDone((d) => {
  if (d.id !== curId || !root) return;
  summary = d;
  curId = null;
  drawStatus();
  // 내용이 맞는 첫 줄을 먼저 고른다 (없으면 이름 결과 첫 번째)
  if (sel < 0 && rows.length) requestAnimationFrame(() => sel < 0 && select(Math.max(0, rows.findIndex((r) => r.kind === 'hit'))));
});

// o.dir: 이 폴더 안에서만 찾기 (탐색기 오른쪽 클릭)
export function openSearch(o = {}) {
  if (!state.repo) return;
  if (o.dir !== undefined) opts.dir = o.dir;
  if (root) {
    if (o.dir !== undefined) (drawScope(), run());
    root.querySelector('.fs-query').select();
    return;
  }
  const picked = selectedText();
  if (picked) opts.query = picked;
  build();
  run();
}
window.addEventListener('cf-open-search', (e) => openSearch(e.detail || {}));

function close() {
  if (curId) window.api.search.cancel(curId);
  curId = null;
  root?.remove();
  root = null;
  document.removeEventListener('keydown', onKey, true);
}

function build() {
  const toggle = (key, label, title) => {
    const b = h('button', { class: `fs-opt ${opts[key] ? 'on' : ''}`, text: label, title });
    b.onclick = () => {
      opts[key] = !opts[key];
      b.classList.toggle('on', opts[key]);
      run();
    };
    b.dataset.key = key;
    return b;
  };
  const query = h('input', { class: 'fs-query', value: opts.query, placeholder: '프로젝트 전체에서 찾을 글자 (파일·폴더 이름과 파일 내용)', spellcheck: 'false' });
  query.oninput = () => {
    opts.query = query.value;
    clearTimeout(timer);
    timer = setTimeout(run, 250);
  };
  const mask = h('input', { class: 'fs-mask', value: opts.mask, placeholder: '파일 마스크 예) *.java, *.ts, !*.min.js', spellcheck: 'false', title: '쉼표로 여러 개. ! 로 시작하면 제외' });
  mask.oninput = () => {
    opts.mask = mask.value;
    clearTimeout(timer);
    timer = setTimeout(run, 300);
  };
  const closeBtn = h('button', { class: 'fs-close', text: '✕', title: '닫기 (Esc)' });
  closeBtn.onclick = close;
  root = h(
    'div',
    { class: 'fs-overlay' },
    h(
      'div',
      { class: 'find-search' },
      h('div', { class: 'fs-head' }, h('b', { text: '프로젝트에서 찾기' }), h('span', { class: 'fs-status' }), h('span', { class: 'tb-spacer' }), h('span', { class: 'fs-keys', text: '↑↓ 이동 · Enter 열기 · Esc 닫기' }), closeBtn),
      h('div', { class: 'fs-row' }, query, toggle('matchCase', 'Aa', '대소문자 구분 (Alt+C)'), toggle('words', 'W', '단어 단위 (Alt+W)'), toggle('regex', '.*', '정규식 (Alt+X)')),
      h('div', { class: 'fs-row' }, h('span', { class: 'fs-scope' }), mask),
      h('div', { class: 'fs-list' }),
      h('div', { class: 'fs-preview' }, h('div', { class: 'fs-pv-head' }), h('div', { class: 'fs-pv-body' }))
    )
  );
  // 바깥(어두운 곳)을 누르면 닫기
  root.onmousedown = (e) => e.target === root && close();
  document.body.append(root);
  document.addEventListener('keydown', onKey, true);
  drawScope();
  setTimeout(() => {
    query.focus();
    query.select();
  });
}

function drawScope() {
  const box = root.querySelector('.fs-scope');
  box.innerHTML = '';
  if (!opts.dir) return box.append(h('span', { class: 'fs-chip all', text: `범위: 프로젝트 전체 (${state.repo.split(/[\\/]/).pop()})` }));
  const x = h('button', { class: 'chip-x', text: '✕', title: '범위 해제 (프로젝트 전체)' });
  x.onclick = () => {
    opts.dir = '';
    drawScope();
    run();
  };
  box.append(h('span', { class: 'fs-chip', text: `범위: ${opts.dir}/`, title: opts.dir }, x));
}

function run() {
  if (!root) return;
  saveOpts();
  if (curId) window.api.search.cancel(curId);
  rows = [];
  nameCount = 0;
  sel = -1;
  summary = null;
  root.querySelector('.fs-list').scrollTop = 0;
  drawList();
  drawPreview();
  if (!opts.query) {
    curId = null;
    return drawStatus();
  }
  curId = `s${++seq}`;
  drawStatus();
  // 한 글자는 거의 모든 줄이 맞아서 느려진다: 내용은 2글자부터 (이름은 1글자도)
  window.api.search.start(state.repo, curId, { query: opts.query, matchCase: opts.matchCase, words: opts.words, regex: opts.regex, mask: opts.mask, dir: opts.dir, namesOnly: [...opts.query].length < 2 });
}

function drawStatus() {
  const st = root.querySelector('.fs-status');
  const names = nameCount;
  const hits = rows.length - names;
  if (!opts.query) st.textContent = '';
  else if (summary?.error) st.innerHTML = `<span class="fs-err">${esc(summary.error)}</span>`;
  else if (!summary) st.innerHTML = `<span class="spinner"></span> 찾는 중... ${hits ? `${hits}줄` : ''}`;
  else if (summary.namesOnly) st.textContent = `이름 ${names}개 · 파일 내용은 2글자부터 찾습니다`;
  else st.textContent = `${summary.files}개 파일에서 ${hits}줄${summary.truncated ? '+ (너무 많아 앞부분만, 검색어를 더 길게)' : ''}${names ? ` · 이름 ${names}개` : ''} · ${summary.searched}개 파일 검색`;
}

// 글자 안 찾은 부분 강조
function marked(text, ranges) {
  let html = '';
  let at = 0;
  for (const [s, n] of ranges) {
    if (s < at) continue;
    html += esc(text.slice(at, s)) + `<mark>${esc(text.slice(s, s + n))}</mark>`;
    at = s + n;
  }
  return html + esc(text.slice(at));
}

// 결과가 수천 줄이어도 빠르도록 화면에 보이는 줄만 그린다 (한 줄 높이 고정)
const RH = 22;
// 화면 줄 번호 → 결과(또는 묶음 제목). 이름 결과가 있으면 0번은 '이름' 제목, 내용 제목은 이름 결과 뒤
const headAt = () => (nameCount ? [0, rows.length > nameCount ? nameCount + 1 : -1] : [-1, rows.length ? 0 : -1]);
const viewLen = () => rows.length + (nameCount ? 1 : 0) + (rows.length > nameCount ? 1 : 0);
function viewItem(v) {
  const [nh, ch] = headAt();
  if (v === nh) return { group: '이름이 맞는 파일·폴더' };
  if (v === ch) return { group: '파일 내용' };
  return { i: v - (nh >= 0 ? 1 : 0) - (ch >= 0 && v > ch ? 1 : 0) };
}
const viewOf = (i) => i + (nameCount ? 1 : 0) + (i >= nameCount && rows.length > nameCount ? 1 : 0);

function rowEl(i) {
  const r = rows[i];
  let el;
  if (r.kind === 'name') {
    el = h('div', { class: `fs-item name ${i === sel ? 'sel' : ''}`, title: r.dir ? `${r.rel}/\n클릭: 이 폴더 안에서만 찾기` : r.rel }, h('span', { class: 'fs-ico', text: r.dir ? '📁' : '📄' }), h('span', { class: 'fs-text', text: baseOf(r.rel) + (r.dir ? '/' : '') }), h('span', { class: 'fs-file', text: dirOf(r.rel) }));
  } else {
    const lead = r.text.match(/^\s*/)[0].length;
    const text = r.text.slice(lead);
    const ranges = r.ranges.map(([s, n]) => [s - lead, n]);
    el = h('div', { class: `fs-item ${i === sel ? 'sel' : ''}`, title: `${r.rel}:${r.line}` }, h('span', { class: 'fs-text code', html: marked(text, ranges) }), h('span', { class: 'fs-file', text: `${baseOf(r.rel)} ${r.line}` }));
  }
  el.dataset.i = i;
  el.onclick = () => select(i);
  el.ondblclick = () => openRow(i);
  return el;
}

function renderWindow() {
  if (!root) return;
  const list = root.querySelector('.fs-list');
  let box = list.querySelector('.fs-vbox');
  if (!box) {
    list.innerHTML = '';
    box = h('div', { class: 'fs-vbox' });
    list.append(box);
    list.onscroll = () => renderWindow();
  }
  const n = viewLen();
  box.style.height = `${n * RH}px`;
  const from = Math.max(0, Math.floor(list.scrollTop / RH) - 10);
  const to = Math.min(n, Math.ceil((list.scrollTop + list.clientHeight) / RH) + 10);
  const frag = document.createDocumentFragment();
  for (let v = from; v < to; v++) {
    const it = viewItem(v);
    const el = it.group ? h('div', { class: 'fs-group', text: it.group }) : rowEl(it.i);
    el.style.top = `${v * RH}px`;
    frag.append(el);
  }
  box.replaceChildren(frag);
}

let drawPending = false;
function drawList() {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(() => {
    drawPending = false;
    if (!root) return;
    if (!rows.length) {
      const list = root.querySelector('.fs-list');
      list.innerHTML = '';
      if (opts.query && summary && !summary.error && !summary.namesOnly) list.append(h('div', { class: 'fs-empty', text: '찾은 결과가 없습니다.' }));
      drawStatus();
      return;
    }
    renderWindow();
    drawStatus();
  });
}

function select(i) {
  if (!rows.length) return;
  sel = Math.max(0, Math.min(rows.length - 1, i));
  const list = root.querySelector('.fs-list');
  // 고른 줄이 보이도록 스크롤
  const y = viewOf(sel) * RH;
  if (y < list.scrollTop + RH) list.scrollTop = Math.max(0, y - RH);
  else if (y + RH > list.scrollTop + list.clientHeight) list.scrollTop = y + RH - list.clientHeight;
  renderWindow();
  drawPreview();
}

const textCache = new Map(); // 미리 보기용 파일 내용 (창을 닫으면 버림)
let pvSeq = 0;
async function drawPreview() {
  if (!root) return;
  const head = root.querySelector('.fs-pv-head');
  const body = root.querySelector('.fs-pv-body');
  const r = rows[sel];
  if (!r) {
    head.textContent = '';
    body.innerHTML = '';
    return;
  }
  head.innerHTML = `<b>${esc(baseOf(r.rel))}</b> <span class="fs-file">${esc(dirOf(r.rel))}</span>`;
  if (r.kind === 'name' && r.dir) {
    body.innerHTML = '<div class="fs-empty">폴더입니다. Enter 또는 두 번 클릭하면 이 폴더 안에서만 찾습니다.</div>';
    return;
  }
  const my = ++pvSeq;
  let text = textCache.get(r.rel);
  if (text === undefined) {
    const res = await window.api.fs.read(absOf(r.rel));
    text = res.ok && res.data.text != null ? res.data.text : null;
    textCache.set(r.rel, text);
  }
  if (my !== pvSeq || !root) return;
  if (text == null) {
    body.innerHTML = '<div class="fs-empty">미리 볼 수 없는 파일입니다.</div>';
    return;
  }
  const lines = text.split(/\r?\n/);
  const at = r.line || 1;
  const from = Math.max(1, at - 60);
  const to = Math.min(lines.length, at + 60);
  let html = '';
  for (let n = from; n <= to; n++) {
    const line = lines[n - 1];
    const content = n === at && r.ranges ? marked(line, r.ranges) : esc(line);
    html += `<div class="fs-pv-line ${n === at && r.kind === 'hit' ? 'cur' : ''}"><span class="ln">${n}</span><span class="tx">${content || ' '}</span></div>`;
  }
  body.innerHTML = html;
  const cur = body.querySelector('.cur');
  body.scrollTop = cur ? cur.offsetTop - body.clientHeight / 2 + 10 : 0;
}

async function openRow(i) {
  const r = rows[i];
  if (!r) return;
  if (r.kind === 'name' && r.dir) {
    // 폴더: 이 폴더 안에서만 찾기 (IntelliJ 의 Directory 범위)
    opts.dir = r.rel;
    drawScope();
    run();
    return;
  }
  close();
  window.dispatchEvent(new CustomEvent('cf-set-view', { detail: 'code' }));
  await activateCode();
  const range = r.kind === 'hit' ? { startLineNumber: r.line, startColumn: r.ranges[0][0] + 1, endLineNumber: r.line, endColumn: r.ranges[0][0] + 1 + r.ranges[0][1] } : undefined;
  openFile(absOf(r.rel), range);
}

function onKey(e) {
  if (!root) return;
  const k = e.key.toLowerCase();
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    close();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    select(sel + (e.key === 'ArrowDown' ? 1 : -1));
  } else if (e.key === 'PageDown' || e.key === 'PageUp') {
    e.preventDefault();
    select(sel + (e.key === 'PageDown' ? 15 : -15));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (sel >= 0) openRow(sel);
  } else if (e.altKey && (k === 'c' || k === 'w' || k === 'x')) {
    e.preventDefault();
    root.querySelector(`.fs-opt[data-key="${{ c: 'matchCase', w: 'words', x: 'regex' }[k]}"]`).click();
  }
}
