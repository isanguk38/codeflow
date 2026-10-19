// Diff 뷰어: 나란히 보기(side-by-side) / 통합 보기(unified), 단어 단위 강조, 변경 위치 이동
import { h, esc } from './ui.js';

const CONTEXT = 4;

function splitLines(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// jsdiff 결과를 화면용 행으로 변환
function buildRows(leftText, rightText) {
  const chunks = window.Diff.diffLines(leftText, rightText);
  const rows = [];
  let ln = 1;
  let rn = 1;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const lines = splitLines(c.value);
    if (!c.added && !c.removed) {
      for (const t of lines) rows.push({ type: 'eq', l: { n: ln++, t }, r: { n: rn++, t } });
    } else if (c.removed && chunks[i + 1]?.added) {
      const added = splitLines(chunks[i + 1].value);
      const n = Math.max(lines.length, added.length);
      for (let k = 0; k < n; k++) {
        const l = k < lines.length ? { n: ln++, t: lines[k] } : null;
        const r = k < added.length ? { n: rn++, t: added[k] } : null;
        rows.push({ type: l && r ? 'mod' : l ? 'del' : 'add', l, r, blockStart: k === 0 });
      }
      i++;
    } else if (c.removed) {
      lines.forEach((t, k) => rows.push({ type: 'del', l: { n: ln++, t }, r: null, blockStart: k === 0 }));
    } else {
      lines.forEach((t, k) => rows.push({ type: 'add', l: null, r: { n: rn++, t }, blockStart: k === 0 }));
    }
  }
  return rows;
}

// 변경 없는 긴 구간은 접기
function foldRows(rows) {
  const out = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].type !== 'eq') {
      out.push(rows[i++]);
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].type === 'eq') j++;
    const run = rows.slice(i, j);
    const head = i === 0 ? 0 : CONTEXT;
    const tail = j === rows.length ? 0 : CONTEXT;
    if (run.length > head + tail + 2) {
      out.push(...run.slice(0, head));
      out.push({ type: 'fold', rows: run.slice(head, run.length - tail) });
      out.push(...run.slice(run.length - tail));
    } else out.push(...run);
    i = j;
  }
  return out;
}

function inline(a, b) {
  if (a.length + b.length > 4000) return [esc(a), esc(b)];
  const parts = window.Diff.diffWordsWithSpace(a, b);
  let left = '';
  let right = '';
  for (const p of parts) {
    const v = esc(p.value);
    if (p.added) right += `<span class="w-add">${v}</span>`;
    else if (p.removed) left += `<span class="w-del">${v}</span>`;
    else {
      left += v;
      right += v;
    }
  }
  return [left, right];
}

function sideRowHtml(row) {
  let lt = row.l ? esc(row.l.t) : '';
  let rt = row.r ? esc(row.r.t) : '';
  if (row.type === 'mod') [lt, rt] = inline(row.l.t, row.r.t);
  const lc = row.type === 'eq' ? '' : row.l ? 'del' : 'empty';
  const rc = row.type === 'eq' ? '' : row.r ? 'add' : 'empty';
  const mark = row.blockStart ? ' data-change="1"' : '';
  return `<tr class="r-${row.type}"${mark}><td class="ln ${lc}">${row.l ? row.l.n : ''}</td><td class="code ${lc}">${lt || ' '}</td><td class="ln ${rc} sep">${row.r ? row.r.n : ''}</td><td class="code ${rc}">${rt || ' '}</td></tr>`;
}

function unifiedRowHtml(row) {
  const mark = row.blockStart ? ' data-change="1"' : '';
  if (row.type === 'eq') return `<tr class="r-eq"><td class="ln">${row.l.n}</td><td class="ln">${row.r.n}</td><td class="code"> ${esc(row.l.t) || ' '}</td></tr>`;
  let out = '';
  if (row.type === 'mod') {
    const [lt, rt] = inline(row.l.t, row.r.t);
    out += `<tr class="r-del"${mark}><td class="ln del">${row.l.n}</td><td class="ln del"></td><td class="code del">-${lt}</td></tr>`;
    out += `<tr class="r-add"><td class="ln add"></td><td class="ln add">${row.r.n}</td><td class="code add">+${rt}</td></tr>`;
    return out;
  }
  if (row.l) out += `<tr class="r-del"${mark}><td class="ln del">${row.l.n}</td><td class="ln del"></td><td class="code del">-${esc(row.l.t)}</td></tr>`;
  if (row.r) out += `<tr class="r-add"${row.l ? '' : mark}><td class="ln add"></td><td class="ln add">${row.r.n}</td><td class="code add">+${esc(row.r.t)}</td></tr>`;
  return out;
}

export function diffMode() {
  return localStorage.getItem('diffMode') || 'side';
}

// pair: { left:{text,binary,tooLarge,exists}, right:{...}, leftLabel, rightLabel }
export function renderDiff(container, pair, { title, actions = [] } = {}) {
  container.innerHTML = '';
  const mode = diffMode();
  const bar = h('div', { class: 'diff-bar' });
  const titleEl = h('span', { class: 'diff-title', text: title || '' });
  const stats = h('span', { class: 'diff-stats' });
  const prev = h('button', { class: 'tb-btn small', title: '이전 변경 (Shift+F7)', text: '↑' });
  const next = h('button', { class: 'tb-btn small', title: '다음 변경 (F7)', text: '↓' });
  const toggle = h('button', { class: 'tb-btn small', text: mode === 'side' ? '통합 보기' : '나란히 보기' });
  bar.append(titleEl, stats, h('span', { class: 'tb-spacer' }), ...actions, prev, next, toggle);
  container.append(bar);

  const scroller = h('div', { class: 'diff-scroll', tabindex: '0' });
  container.append(scroller);

  const L = pair.left;
  const R = pair.right;
  if (L.binary || R.binary) {
    scroller.append(h('div', { class: 'empty', text: '바이너리 파일입니다. 내용 비교를 지원하지 않습니다.' }));
    return;
  }
  if (L.tooLarge || R.tooLarge) {
    scroller.append(h('div', { class: 'empty', text: '파일이 너무 커서 비교할 수 없습니다 (2MB 초과).' }));
    return;
  }

  const rows = buildRows(L.text || '', R.text || '');
  const add = rows.filter((r) => r.r && r.type !== 'eq').length;
  const del = rows.filter((r) => r.l && r.type !== 'eq').length;
  stats.innerHTML = `<span class="plus">+${add}</span> <span class="minus">-${del}</span>`;

  if (!add && !del) {
    scroller.append(h('div', { class: 'empty', text: L.text === R.text ? '내용 변경 없음 (권한/줄바꿈 등 속성만 변경되었을 수 있습니다)' : '차이 없음' }));
  }

  const table = h('table', { class: `diff-table ${mode}` });
  if (mode === 'side') {
    table.innerHTML = `<colgroup><col class="c-ln"><col class="c-code"><col class="c-ln"><col class="c-code"></colgroup><thead><tr><th colspan="2">${esc(pair.leftLabel || '이전')}</th><th colspan="2">${esc(pair.rightLabel || '이후')}</th></tr></thead>`;
  } else {
    table.innerHTML = `<colgroup><col class="c-ln"><col class="c-ln"><col class="c-code"></colgroup><thead><tr><th colspan="3">${esc(pair.leftLabel || '')} → ${esc(pair.rightLabel || '')}</th></tr></thead>`;
  }
  const tbody = h('tbody');
  const rowHtml = mode === 'side' ? sideRowHtml : unifiedRowHtml;
  const cols = mode === 'side' ? 4 : 3;
  let html = '';
  const folds = [];
  for (const row of foldRows(rows)) {
    if (row.type === 'fold') {
      folds.push(row.rows);
      html += `<tr class="r-fold" data-fold="${folds.length - 1}"><td colspan="${cols}">⋯ 변경 없는 ${row.rows.length}줄 (클릭하여 펼치기)</td></tr>`;
    } else html += rowHtml(row);
  }
  tbody.innerHTML = html;
  table.append(tbody);
  if (add || del) scroller.append(table);

  tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr.r-fold');
    if (!tr) return;
    const tmp = document.createElement('tbody');
    tmp.innerHTML = folds[+tr.dataset.fold].map(rowHtml).join('');
    tr.replaceWith(...tmp.children);
  });

  let cur = -1;
  const jump = (dir) => {
    const marks = [...tbody.querySelectorAll('tr[data-change]')];
    if (!marks.length) return;
    cur = Math.max(0, Math.min(marks.length - 1, cur + dir));
    marks.forEach((m) => m.classList.remove('cur'));
    marks[cur].classList.add('cur');
    marks[cur].scrollIntoView({ block: 'center' });
  };
  prev.onclick = () => jump(-1);
  next.onclick = () => jump(1);
  scroller.addEventListener('keydown', (e) => {
    if (e.key === 'F7') {
      e.preventDefault();
      jump(e.shiftKey ? -1 : 1);
    }
  });
  toggle.onclick = () => {
    localStorage.setItem('diffMode', mode === 'side' ? 'unified' : 'side');
    renderDiff(container, pair, { title, actions });
  };
  // 첫 변경 위치로 이동
  requestAnimationFrame(() => {
    const first = tbody.querySelector('tr[data-change]');
    if (first && first.offsetTop > scroller.clientHeight * 0.6) jump(1);
  });
}

export function emptyDiff(container, text = '파일을 선택하면 변경 내용이 표시됩니다.') {
  container.innerHTML = '';
  container.append(h('div', { class: 'empty big', text }));
}
