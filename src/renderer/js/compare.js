// 브랜치/커밋 비교: 양쪽에만 있는 커밋 목록 + 파일 차이
import { h, esc, modal, fmtDate, splitPath, STATUS_LABEL, toast } from './ui.js';
import { git } from './state.js';
import { renderDiff, emptyDiff } from './diff.js';

export async function openCompare(a, b) {
  let data;
  try {
    data = await git('compareRefs', a, b);
  } catch (e) {
    return toast(`비교 실패: ${e.message}`, 'error', 6000);
  }
  const short = (r) => (/^[0-9a-f]{40}$/.test(r) ? r.slice(0, 8) : r);
  const A = short(a);
  const B = short(b);

  const commitList = (list, empty) => {
    const box = h('div', { class: 'cmp-commits' });
    if (!list.length) box.append(h('div', { class: 'empty small', text: empty }));
    for (const c of list) {
      const row = h('div', { class: 'push-item', title: c.hash }, h('span', { class: 'hash', text: c.hash.slice(0, 8) }), h('span', { class: 'subj', text: c.subject }), h('span', { class: 'meta', text: `${c.author} · ${fmtDate(c.time)}` }));
      row.ondblclick = async () => {
        m.close();
        (await import('./log.js')).showCommit(c.hash);
      };
      box.append(row);
    }
    return box;
  };

  const diffBox = h('div', { class: 'cmp-diff' });
  emptyDiff(diffBox, '파일을 선택하면 두 시점의 차이가 표시됩니다.');
  const files = h('div', { class: 'detail-files cmp-files' });
  files.append(h('div', { class: 'group-header', html: `변경된 파일 <span class="count">${data.files.length}개</span>` }));
  if (!data.files.length) files.append(h('div', { class: 'empty small', text: '파일 내용이 같습니다.' }));
  for (const f of data.files) {
    const { dir, name } = splitPath(f.path);
    const row = h('div', { class: `file-row s-${f.status}` }, h('span', { class: `st-badge s-${f.status}`, text: STATUS_LABEL[f.status] }), h('span', { class: 'fname', text: name }), h('span', { class: 'fdir', text: dir }));
    row.onclick = async () => {
      files.querySelectorAll('.file-row').forEach((r) => r.classList.remove('active'));
      row.classList.add('active');
      try {
        renderDiff(diffBox, await git('refFilePair', a, b, f), { title: f.path });
      } catch (e) {
        emptyDiff(diffBox, e.message);
      }
    };
    files.append(row);
  }

  const body = h(
    'div',
    { class: 'compare' },
    h(
      'div',
      { class: 'cmp-top' },
      h('div', {}, h('div', { class: 'group-header', html: `<b>${esc(B)}</b> 에만 있는 커밋 <span class="count">${data.onlyB.length}개</span>` }), commitList(data.onlyB, '없음')),
      h('div', {}, h('div', { class: 'group-header', html: `<b>${esc(A)}</b> 에만 있는 커밋 <span class="count">${data.onlyA.length}개</span>` }), commitList(data.onlyA, '없음'))
    ),
    h('div', { class: 'cmp-bottom' }, files, diffBox)
  );
  const m = modal({ title: `비교: ${A} ↔ ${B}`, body, full: true, buttons: [{ label: '닫기', primary: true }] });
  files.querySelector('.file-row')?.click();
}
