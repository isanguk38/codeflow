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

// 머리글: 라벨 + '현재 버전' 같은 표시(tag: { kind: current|head|in|out, text })
function sideHead(label, tag) {
  const badge = tag ? `<span class="ver-tag ${tag.kind}" title="${esc(TAG_TIP[tag.kind] || '')}">${tag.kind === 'current' ? '● ' : ''}${esc(tag.text)}</span>` : '';
  return `${badge}<span class="ver-label" title="${esc(label)}">${esc(label)}</span>`;
}
const TAG_TIP = {
  current: '지금 내가 체크아웃해서 쓰고 있는 버전입니다.',
  head: '현재 브랜치의 마지막 커밋입니다.',
  in: '이 커밋은 현재 브랜치에 이미 들어 있습니다. (지금 버전보다 예전 커밋)',
  out: '이 커밋은 현재 브랜치에 없습니다. (다른 브랜치의 커밋)',
};

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
    table.innerHTML = `<colgroup><col class="c-ln"><col class="c-code"><col class="c-ln"><col class="c-code"></colgroup><thead><tr><th colspan="2">${sideHead(pair.leftLabel || '이전', pair.leftTag)}</th><th colspan="2">${sideHead(pair.rightLabel || '이후', pair.rightTag)}</th></tr></thead>`;
  } else {
    table.innerHTML = `<colgroup><col class="c-ln"><col class="c-ln"><col class="c-code"></colgroup><thead><tr><th colspan="3">${sideHead(pair.leftLabel || '', pair.leftTag)} → ${sideHead(pair.rightLabel || '', pair.rightTag)}</th></tr></thead>`;
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

// 부분 커밋용: 덩어리(hunk)/줄 단위 체크박스 보기
// data: fileHunks 결과, sel: 선택된 줄 id Set ("덩어리:줄"), onChange(sel) 호출
export function renderHunks(container, data, sel, onChange, { title, actions = [] } = {}) {
  container.innerHTML = '';
  const bar = h('div', { class: 'diff-bar' });
  const stats = h('span', { class: 'diff-stats' });
  bar.append(h('span', { class: 'diff-title', text: title || '' }), stats, h('span', { class: 'tb-spacer' }), ...actions);
  container.append(bar);
  const scroller = h('div', { class: 'diff-scroll', tabindex: '0' });
  container.append(scroller);
  if (data.binary || !data.hunks.length) {
    scroller.append(h('div', { class: 'empty', text: data.binary ? '바이너리 파일은 줄 단위로 선택할 수 없습니다.' : '변경된 줄이 없습니다.' }));
    return;
  }
  const changeIds = (hi) => data.hunks[hi].lines.map((l, li) => (l.t === '+' || l.t === '-' ? `${hi}:${li}` : null)).filter(Boolean);
  const all = data.hunks.flatMap((_, hi) => changeIds(hi));
  const updateStats = () => {
    stats.innerHTML = `<span class="hint-sel">${all.filter((id) => sel.has(id)).length} / ${all.length} 줄 선택됨</span>`;
  };

  const table = h('table', { class: 'diff-table unified hunks' });
  table.innerHTML = '<colgroup><col class="c-chk"><col class="c-ln"><col class="c-ln"><col class="c-code"></colgroup>';
  const tbody = h('tbody');
  table.append(tbody);
  const draw = () => {
    let html = '';
    data.hunks.forEach((hk, hi) => {
      const ids = changeIds(hi);
      const n = ids.filter((id) => sel.has(id)).length;
      html += `<tr class="r-hunk" data-hunk="${hi}"><td class="chk"><input type="checkbox" ${n === ids.length ? 'checked' : ''} data-ind="${n > 0 && n < ids.length ? 1 : 0}"></td><td colspan="3">${esc(hk.header.replace(/^(@@.*?@@).*$/, '$1'))} <span class="hunk-ctx">${esc(hk.context)}</span></td></tr>`;
      let o = hk.oldStart;
      let nn = hk.newStart;
      hk.lines.forEach((ln, li) => {
        const id = `${hi}:${li}`;
        if (ln.t === '\\') return;
        if (ln.t === ' ') {
          html += `<tr class="r-eq"><td class="chk"></td><td class="ln">${o++}</td><td class="ln">${nn++}</td><td class="code"> ${esc(ln.s) || ' '}</td></tr>`;
          return;
        }
        const cls = ln.t === '+' ? 'add' : 'del';
        const on = sel.has(id);
        html += `<tr class="r-${cls} line-sel ${on ? '' : 'off'}" data-id="${id}"><td class="chk ${cls}"><input type="checkbox" ${on ? 'checked' : ''}></td><td class="ln ${cls}">${ln.t === '-' ? o++ : ''}</td><td class="ln ${cls}">${ln.t === '+' ? nn++ : ''}</td><td class="code ${cls}">${ln.t}${esc(ln.s) || ' '}</td></tr>`;
      });
    });
    tbody.innerHTML = html;
    tbody.querySelectorAll('input[data-ind="1"]').forEach((i) => (i.indeterminate = true));
    updateStats();
  };
  tbody.addEventListener('click', (e) => {
    const hunkRow = e.target.closest('tr.r-hunk');
    if (hunkRow) {
      const ids = changeIds(+hunkRow.dataset.hunk);
      const allOn = ids.every((id) => sel.has(id));
      ids.forEach((id) => (allOn ? sel.delete(id) : sel.add(id)));
    } else {
      const row = e.target.closest('tr.line-sel');
      if (!row) return;
      const id = row.dataset.id;
      sel.has(id) ? sel.delete(id) : sel.add(id);
    }
    const top = scroller.scrollTop;
    draw();
    scroller.scrollTop = top;
    onChange(sel, all);
  });
  draw();
  scroller.append(table);
}
