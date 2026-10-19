// Blame (Annotate): 파일의 각 줄을 마지막으로 바꾼 커밋/작성자/날짜 표시
import { h, esc, modal, fmtDate, toast } from './ui.js';
import { git } from './state.js';

const PALETTE = 12;

export async function openBlame(file, rev) {
  let data;
  try {
    data = await git('blame', file, rev);
  } catch (e) {
    return toast(`Blame 실패: ${e.message}`, 'error', 6000);
  }
  const { commits, lines } = data;
  // 오래된 커밋일수록 옅게: 시간 순위로 색 단계 결정
  const times = [...new Set(Object.values(commits).map((c) => c.time || 0))].sort((a, b) => a - b);
  const age = (t) => Math.round((times.indexOf(t) / Math.max(1, times.length - 1)) * (PALETTE - 1));

  const table = h('table', { class: 'blame-table' });
  let html = '';
  let prev = null;
  lines.forEach((ln, i) => {
    const c = commits[ln.hash] || {};
    const uncommitted = /^0+$/.test(ln.hash);
    const first = ln.hash !== prev;
    prev = ln.hash;
    const info = first
      ? uncommitted
        ? '<span class="bl-new">커밋 안 됨</span>'
        : `<span class="bl-hash" data-hash="${ln.hash}">${ln.hash.slice(0, 7)}</span> <span class="bl-author">${esc(c.author || '')}</span> <span class="bl-date">${esc(fmtDate(c.time || 0, false))}</span>`
      : '';
    html += `<tr class="${first ? 'bl-first' : ''}" title="${uncommitted ? '아직 커밋되지 않은 변경' : esc(`${ln.hash.slice(0, 8)} ${c.author}\n${fmtDate(c.time)}\n${c.summary}`)}"><td class="bl-info age-${uncommitted ? 'new' : age(c.time || 0)}">${info}</td><td class="ln">${i + 1}</td><td class="code">${esc(ln.text) || ' '}</td></tr>`;
  });
  table.innerHTML = `<colgroup><col style="width:300px"><col style="width:50px"><col></colgroup><tbody>${html}</tbody>`;
  table.addEventListener('click', async (e) => {
    const hash = e.target.closest('.bl-hash')?.dataset.hash;
    if (!hash) return;
    m.close();
    const { showCommit } = await import('./log.js');
    showCommit(hash);
  });
  const authors = new Set(Object.values(commits).map((c) => c.author).filter(Boolean));
  const body = h(
    'div',
    { class: 'blame-wrap' },
    h('div', { class: 'blame-head', html: `<b>${esc(file)}</b>${rev ? ` @ ${esc(rev.slice(0, 8))}` : ' (작업 중인 파일)'} · ${lines.length}줄 · 커밋 ${Object.keys(commits).length}개 · 작성자 ${authors.size}명 <span class="fdir">— 해시를 클릭하면 히스토리에서 커밋을 엽니다</span>` }),
    h('div', { class: 'blame-scroll' }, table)
  );
  const m = modal({ title: `Blame - ${file}`, body, full: true, buttons: [{ label: '닫기', primary: true }] });
}
