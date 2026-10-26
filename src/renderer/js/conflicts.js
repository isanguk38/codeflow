// 충돌 해결: 충돌 파일 목록 대화상자 + 3단 병합 도구 (내 변경 | 결과 | 상대 변경)
import { h, esc, modal, confirmDialog, toast, splitPath } from './ui.js';
import { state, git, op, refresh } from './state.js';

const STATE_LABEL = { merge: '병합', rebase: '리베이스', 'cherry-pick': '체리픽', revert: '되돌리기' };

let listModal = null;

// 양쪽이 각각 무엇인지 (git.conflictSides). 병합/체리픽은 왼쪽(ours)이, 리베이스는 오른쪽(theirs)이 내 작업이다.
async function getSides() {
  try {
    return await git('conflictSides');
  } catch {
    return null;
  }
}
const isMine = (sd, w) => (sd ? sd.mine === w : w === 'ours');
// 버튼 글자: '● main 적용' 처럼 이름으로, 현재 버전 쪽에 ●
function sideName(sd, w) {
  const x = sd?.[w];
  if (!x?.name) return w === 'ours' ? '내 것' : '상대 것';
  return x.name;
}
function sideTitle(sd, w) {
  const x = sd?.[w];
  if (!x) return w === 'ours' ? '현재 브랜치(내 쪽) 버전' : '병합해 오는 쪽 버전';
  const parts = [`${x.role}: ${x.name}`];
  if (x.commit) parts.push(`커밋 ${x.commit}${x.subject ? ` ${x.subject}` : ''}`);
  if (isMine(sd, w)) parts.push(sd.state === 'rebase' ? '← 내 작업 (리베이스 중에는 오른쪽이 내 커밋입니다)' : '← 현재 버전 (지금 내 브랜치)');
  return parts.join('\n');
}
// 목록/병합 도구 위쪽: '● 현재 버전 main  ↔  병합해 오는 쪽 feature'
function sidesBanner(sd) {
  const pill = (w) => {
    const x = sd[w];
    const mine = isMine(sd, w);
    return h(
      'span',
      { class: `cs-pill ${w} ${mine ? 'mine' : ''}`, title: sideTitle(sd, w) },
      h('span', { class: 'cs-role', text: mine ? (sd.state === 'rebase' ? '● 내 작업' : '● 현재 버전') : x.role }),
      h('b', { text: x.name }),
      x.commit && sd.state !== 'merge' ? h('span', { class: 'cs-sub', text: `${x.commit}${x.subject ? ` ${x.subject}` : ''}` }) : null
    );
  };
  const box = h('div', { class: 'conflict-sides' }, h('span', { class: 'cs-side', text: '왼쪽' }), pill('ours'), h('span', { class: 'cs-arrow', text: '↔' }), h('span', { class: 'cs-side', text: '오른쪽' }), pill('theirs'));
  if (sd.state === 'rebase') box.append(h('div', { class: 'cs-note', text: '리베이스 중에는 왼쪽이 옮겨 갈 기준 브랜치, 오른쪽이 다시 적용 중인 내 커밋입니다.' }));
  return box;
}

export async function openConflicts() {
  await refresh();
  listModal?.close();
  const s = state.status;
  const conflicts = (s?.files || []).filter((f) => f.status === 'conflict');
  const opName = STATE_LABEL[s?.state] || '작업';
  const sd = conflicts.length ? await getSides() : null;
  const body = h('div', { class: 'conflict-list' });

  if (!conflicts.length) {
    body.append(
      h('div', { class: 'empty', html: s?.state ? `모든 충돌이 해결되었습니다.<br><small>'계속' 을 눌러 ${opName}을(를) 마무리하세요.</small>` : '충돌이 없습니다.' })
    );
  } else {
    body.append(h('p', { class: 'msg', text: `${opName} 중 ${conflicts.length}개 파일에서 충돌이 발생했습니다. 파일별로 어느 쪽 변경을 사용할지 선택하거나 '병합...' 으로 직접 합치세요.` }));
    if (sd) body.append(sidesBanner(sd));
    for (const f of conflicts) {
      const { dir, name } = splitPath(f.path);
      body.append(
        h(
          'div',
          { class: 'conflict-row' },
          h('div', { class: 'cr-name' }, h('b', { text: name }), h('span', { class: 'fdir', text: ` ${dir}` }), h('div', { class: 'cr-kind', text: conflictKind(f) })),
          h('button', { class: `btn side-btn ${isMine(sd, 'ours') ? 'mine' : ''}`, text: `${isMine(sd, 'ours') ? '● ' : ''}${sideName(sd, 'ours')} 적용`, title: `${sideTitle(sd, 'ours')}\n\n이 파일을 이 쪽 버전으로 정합니다.`, onclick: () => side(f.path, 'ours', sideName(sd, 'ours')) }),
          h('button', { class: `btn side-btn ${isMine(sd, 'theirs') ? 'mine' : ''}`, text: `${isMine(sd, 'theirs') ? '● ' : ''}${sideName(sd, 'theirs')} 적용`, title: `${sideTitle(sd, 'theirs')}\n\n이 파일을 이 쪽 버전으로 정합니다.`, onclick: () => side(f.path, 'theirs', sideName(sd, 'theirs')) }),
          h('button', { class: 'btn primary', text: '병합...', onclick: () => openMergeTool(f.path) })
        )
      );
    }
  }
  const buttons = [];
  if (s?.state) buttons.push({ label: `${opName} 중단`, danger: true, onClick: abort });
  buttons.push({ label: '닫기' });
  if (s?.state && !conflicts.length) buttons.push({ label: `계속 (${opName} 완료)`, primary: true, onClick: cont });
  listModal = modal({ title: '충돌 해결', body, wide: true, buttons, onClose: () => (listModal = null) });
}

function conflictKind(f) {
  const xy = f.x + f.y;
  return (
    {
      UU: '양쪽에서 수정됨',
      AA: '양쪽에서 추가됨',
      DU: '내 쪽에서 삭제, 상대 쪽에서 수정',
      UD: '내 쪽에서 수정, 상대 쪽에서 삭제',
      AU: '내 쪽에서 추가됨',
      UA: '상대 쪽에서 추가됨',
      DD: '양쪽에서 삭제됨',
    }[xy] || xy
  );
}

async function side(file, which, name) {
  await op('충돌 해결', () => git('resolveSide', file, which), { success: `${file}: ${name || (which === 'ours' ? '내 것' : '상대 것')} 적용` });
  openConflicts();
}

async function abort() {
  const ok = await confirmDialog('진행 중인 작업을 중단하고 시작 전 상태로 되돌립니다.', { title: '중단', okLabel: '중단', danger: true });
  if (!ok) return false;
  await op('중단', () => git('operation', 'abort'), { success: '작업을 중단했습니다.' });
}

async function cont() {
  const r = await op('계속', () => git('operation', 'continue'), { success: '완료되었습니다.' });
  if (r?.conflict) return;
}

export async function continueOperation() {
  await cont();
}
export async function abortOperation() {
  await abort();
}

// ---------- 병합 도구 ----------

// 충돌 마커가 있는 파일 내용을 공통 구간 / 충돌 구간으로 나눈다.
export function parseConflicts(text) {
  const lines = text.split(/(?<=\n)/);
  const segs = [];
  let common = '';
  let cur = null;
  let part = null;
  for (const line of lines) {
    if (!cur && line.startsWith('<<<<<<<')) {
      if (common) segs.push({ type: 'common', text: common });
      common = '';
      cur = { type: 'conflict', ours: '', base: '', theirs: '', oursLabel: line.slice(7).trim(), theirsLabel: '' };
      part = 'ours';
    } else if (cur && line.startsWith('|||||||') && part === 'ours') {
      part = 'base';
    } else if (cur && line.startsWith('=======') && part !== 'theirs') {
      part = 'theirs';
    } else if (cur && line.startsWith('>>>>>>>') && part === 'theirs') {
      cur.theirsLabel = line.slice(7).trim();
      segs.push(cur);
      cur = null;
      part = null;
    } else if (cur) {
      cur[part] += line;
    } else common += line;
  }
  if (cur) common += ''; // 닫히지 않은 마커는 무시
  if (common) segs.push({ type: 'common', text: common });
  return segs;
}

export async function openMergeTool(file) {
  let info;
  try {
    info = await git('conflictInfo', file);
  } catch (e) {
    return toast(e.message, 'error');
  }
  if (info.working.binary || info.ours.binary || info.theirs.binary || !info.working.exists) {
    toast('이 파일은 직접 병합할 수 없습니다. 내 것/상대 것 중 하나를 선택하세요.', 'warn', 5000);
    return openConflicts();
  }
  const segs = parseConflicts(info.working.text);
  const conflicts = segs.filter((s) => s.type === 'conflict');
  if (!conflicts.length) {
    const ok = await confirmDialog('파일에 충돌 표시(<<<<<<<)가 없습니다. 현재 내용으로 해결 완료 처리할까요?', { okLabel: '해결 완료' });
    if (ok) await op('충돌 해결', () => git('resolveWithContent', file, info.working.text));
    return openConflicts();
  }
  conflicts.forEach((c) => {
    c.result = null;
  });
  const sd = await getSides();
  const colTitle = (w) => {
    const mine = isMine(sd, w);
    const fallback = w === 'ours' ? conflicts[0].oursLabel || 'HEAD' : conflicts[0].theirsLabel || '병합 대상';
    const x = sd?.[w];
    return h(
      'div',
      { class: `mt-col-title ${w} ${mine ? 'mine' : ''}`, title: sideTitle(sd, w) },
      mine ? h('span', { class: 'ver-tag current', text: sd?.state === 'rebase' ? '● 내 작업' : '● 현재 버전' }) : null,
      h('span', { text: x ? `${x.role}: ${x.name}` : `${w === 'ours' ? '내 변경' : '상대 변경'} (${fallback})` })
    );
  };
  const oursN = sideName(sd, 'ours');
  const theirsN = sideName(sd, 'theirs');

  const progress = h('span', { class: 'mt-progress' });
  const grid = h('div', { class: 'mt-grid' });
  const head = h(
    'div',
    { class: 'mt-head' },
    colTitle('ours'),
    h('div', { class: 'mt-col-title', text: '결과 (저장될 내용)' }),
    colTitle('theirs')
  );
  const toolbar = h(
    'div',
    { class: 'mt-toolbar' },
    progress,
    h('span', { class: 'tb-spacer' }),
    h('button', { class: 'btn', text: `모두 ${oursN} 쪽으로`, title: sideTitle(sd, 'ours'), onclick: () => (conflicts.forEach((c) => (c.result = c.ours)), draw()) }),
    h('button', { class: 'btn', text: `모두 ${theirsN} 쪽으로`, title: sideTitle(sd, 'theirs'), onclick: () => (conflicts.forEach((c) => (c.result = c.theirs)), draw()) }),
    h('button', { class: 'btn', text: '모두 초기화', onclick: () => (conflicts.forEach((c) => (c.result = null)), draw()) })
  );
  const body = h('div', { class: 'merge-tool' }, toolbar, ...(sd ? [sidesBanner(sd)] : []), head, grid);

  const draw = () => {
    grid.innerHTML = '';
    let n = 0;
    for (const s of segs) {
      if (s.type === 'common') {
        const lines = s.text.split('\n');
        const long = lines.length > 12;
        const preview = long ? [...lines.slice(0, 4), `⋯ (${lines.length - 8}줄 동일)`, ...lines.slice(-5)].join('\n') : s.text.replace(/\n$/, '');
        grid.append(h('div', { class: 'mt-common' }, h('pre', { text: preview }), h('pre', { text: preview }), h('pre', { text: preview })));
        continue;
      }
      n++;
      const c = s;
      const ta = h('textarea', { class: 'mt-result', spellcheck: 'false', placeholder: '← 또는 → 버튼으로 선택하거나 직접 입력' });
      ta.value = c.result ?? '';
      const fit = () => {
        ta.style.height = 'auto';
        ta.style.height = `${Math.max(48, ta.scrollHeight + 2)}px`;
      };
      ta.oninput = () => {
        c.result = ta.value;
        updateProgress();
        fit();
      };
      requestAnimationFrame(fit);
      const resolved = c.result !== null;
      grid.append(
        h(
          'div',
          { class: `mt-conflict ${resolved ? 'resolved' : ''}` },
          h('div', { class: 'mt-side ours' }, h('pre', { text: c.ours.replace(/\n$/, '') || '(내용 없음)' }), h('button', { class: 'btn small', text: '적용 ≫', onclick: () => ((c.result = c.ours), draw()) })),
          h(
            'div',
            { class: 'mt-mid' },
            h('div', { class: 'mt-mid-bar' }, h('span', { text: `충돌 ${n}` }), h('span', { class: 'tb-spacer' }), h('button', { class: 'tb-btn small', text: '둘 다(왼쪽 먼저)', title: `${oursN} 다음에 ${theirsN}`, onclick: () => ((c.result = c.ours + c.theirs), draw()) }), h('button', { class: 'tb-btn small', text: '둘 다(오른쪽 먼저)', title: `${theirsN} 다음에 ${oursN}`, onclick: () => ((c.result = c.theirs + c.ours), draw()) }), h('button', { class: 'tb-btn small', text: '초기화', onclick: () => ((c.result = null), draw()) })),
            ta
          ),
          h('div', { class: 'mt-side theirs' }, h('pre', { text: c.theirs.replace(/\n$/, '') || '(내용 없음)' }), h('button', { class: 'btn small', text: '≪ 적용', onclick: () => ((c.result = c.theirs), draw()) }))
        )
      );
    }
    updateProgress();
  };
  const updateProgress = () => {
    const done = conflicts.filter((c) => c.result !== null).length;
    progress.innerHTML = `<b>${esc(file)}</b> · 충돌 ${conflicts.length}개 중 <b>${done}</b>개 해결`;
  };
  draw();

  listModal?.close();
  modal({
    title: `병합 도구 - ${file}`,
    body,
    full: true,
    dismissable: false,
    buttons: [
      { label: '취소', onClick: () => (openConflicts(), undefined) },
      {
        label: '적용 (해결 완료)',
        primary: true,
        onClick: async () => {
          const left = conflicts.filter((c) => c.result === null).length;
          if (left) {
            toast(`아직 해결하지 않은 충돌이 ${left}개 있습니다.`, 'warn');
            return false;
          }
          const text = segs.map((s) => (s.type === 'common' ? s.text : s.result)).join('');
          await op('충돌 해결', () => git('resolveWithContent', file, text), { success: `${file} 충돌 해결됨` });
          openConflicts();
        },
      },
    ],
  });
}
