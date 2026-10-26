// 히스토리 화면 왼쪽 아래 '이슈' 패널: GitHub / GitLab 이슈 보드의 이슈를 보여 준다.
// - 브랜치 목록과 위아래로 나눈 별도 영역(크기 조절, 접기 가능)이라 이슈가 많아도 브랜치 목록을 밀어내지 않는다
// - 위쪽: 열림 / 닫힘 / 내 담당 + 검색(서버에서 찾음), 아래로 스크롤하면 30개씩 더 불러옴
// - 이슈를 누르면 상세(번호, 제목, 상태, 작성자·담당자, 라벨, 본문) + 웹에서 열기 / 이 이슈로 브랜치 만들기 / 커밋 메시지에 번호 넣기
import { $, h, esc, toast, modal, fmtDate, splitter } from './ui.js';
import { state } from './state.js';
import { md, bindLinks } from './ai.js';
import { newBranch } from './branches.js';
import { filterByIssue, currentIssueFilter } from './log.js';

let root;
let keepTok = null; // 다시 그릴 때 토큰 입력 칸 값·커서 유지
let collapsed = localStorage.getItem('issues.collapsed') === '1';
const view = { state: 'open', search: '', mine: false };
const cache = new Map(); // repo|state|search|mine → { items, page, hasMore, total, service, auth, at }
let loading = false;
let seq = 0;

const key = () => `${(state.repo || '').toLowerCase()}|${view.state}|${view.search}|${view.mine}`;

// 히스토리 위쪽의 이슈 필터 ✕ 로 해제하면 목록 선택 표시도 지운다
window.addEventListener('issue-filter-changed', () => draw());

export function initIssues(container, handle, branchesEl) {
  root = container;
  splitter(handle, root, { axis: 'y', min: 60, max: 900, invert: true, key: 'logIssues' });
  root.classList.toggle('collapsed', collapsed);
  handle.hidden = collapsed;
  draw();
}

// 히스토리 화면을 열거나 탭이 바뀌면 (2분 안에 불러온 것은 그대로 보여 줌)
export function refreshIssues(force = false) {
  if (!root) return;
  const c = cache.get(key());
  if (!force && c && Date.now() - c.at < 120000) return draw();
  if (collapsed) return draw();
  load(1);
}

async function load(page) {
  const repo = state.repo;
  if (!repo) return draw();
  const k = key();
  const my = ++seq;
  loading = true;
  draw();
  const r = await window.api.issues.list(repo, { state: view.state, search: view.search || undefined, mine: view.mine, page });
  if (my !== seq) return;
  loading = false;
  if (!r.ok) {
    cache.set(k, { error: 'http', message: r.error, at: Date.now() });
    return draw();
  }
  const d = r.data;
  if (d.error) cache.set(k, { ...d, at: Date.now() });
  else {
    const prev = page > 1 ? cache.get(k) : null;
    cache.set(k, { ...d, items: [...(prev?.items || []), ...d.items], at: Date.now() });
  }
  if (repo === state.repo) draw();
}

function setCollapsed(v) {
  collapsed = v;
  localStorage.setItem('issues.collapsed', v ? '1' : '0');
  root.classList.toggle('collapsed', v);
  root.previousElementSibling.hidden = v; // 크기 조절 막대
  if (!v) refreshIssues();
  else draw();
}

function draw() {
  if (!root) return;
  const c = cache.get(key());
  // 다시 그려도 토큰 입력 칸에 넣던 값·커서는 그대로 (브라우저에서 토큰을 복사해 돌아오면 앱이 새로 고침되므로)
  const oldTok = root.querySelector('.iss-token');
  keepTok = oldTok ? { value: oldTok.value, focus: document.activeElement === oldTok } : null;
  root.innerHTML = '';
  const count = c?.total ?? (c?.items ? `${c.items.length}${c.hasMore ? '+' : ''}` : '');
  const head = h(
    'div',
    { class: 'iss-head', title: collapsed ? '이슈 펼치기' : '이슈 접기' },
    h('span', { text: `${collapsed ? '▸' : '▾'} 이슈` }),
    count !== '' && !c?.error ? h('span', { class: 'iss-count', text: String(count) }) : null,
    h('span', { class: 'tb-spacer' })
  );
  head.onclick = () => setCollapsed(!collapsed);
  if (!collapsed) {
    const reload = h('button', { class: 'iss-icon', text: '⟳', title: '새로고침' });
    reload.onclick = (e) => {
      e.stopPropagation();
      load(1);
    };
    head.append(reload);
    if (c?.service?.issuesUrl) {
      const web = h('button', { class: 'iss-icon', text: '↗', title: `웹에서 이슈 보드 열기 (${c.service.host})` });
      web.onclick = (e) => {
        e.stopPropagation();
        window.api.openExternal(c.service.issuesUrl);
      };
      head.append(web);
    }
  }
  root.append(head);
  if (collapsed) return;
  if (!state.repo) return;

  // 필터 + 검색
  const tabs = h('div', { class: 'iss-tabs' });
  for (const [id, label] of [
    ['open', '열림'],
    ['closed', '닫힘'],
    ['mine', '내 담당'],
  ]) {
    const on = id === 'mine' ? view.mine : !view.mine && view.state === id;
    const b = h('button', { class: `iss-tab ${on ? 'on' : ''}`, text: label });
    b.onclick = () => {
      if (id === 'mine') {
        view.mine = !view.mine;
        view.state = 'open';
      } else {
        view.mine = false;
        view.state = id;
      }
      refreshIssues();
    };
    tabs.append(b);
  }
  const search = h('input', { class: 'iss-search', placeholder: '제목·내용 검색 또는 #번호', value: view.search, spellcheck: 'false' });
  let t;
  search.oninput = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      view.search = search.value.trim().replace(/^#(\d+)$/, '$1');
      refreshIssues();
      setTimeout(() => {
        const s = root.querySelector('.iss-search');
        if (s) {
          s.focus();
          s.setSelectionRange(s.value.length, s.value.length);
        }
      });
    }, 400);
  };
  root.append(tabs, search);

  const list = h('div', { class: 'iss-list' });
  root.append(list);
  if (c?.error) return list.append(problem(c));
  if (!c && loading) return list.append(h('div', { class: 'iss-note', html: '<span class="spinner"></span> 이슈를 불러오는 중...' }));
  if (!c) return;
  if (!c.items.length) list.append(h('div', { class: 'iss-note', text: view.search ? '검색 결과가 없습니다.' : view.mine ? '나에게 배정된 열린 이슈가 없습니다.' : view.state === 'open' ? '열린 이슈가 없습니다.' : '닫힌 이슈가 없습니다.' }));
  for (const it of c.items) list.append(row(it, c));
  if (c.hasMore) {
    const more = h('div', { class: 'iss-note iss-more', html: loading ? '<span class="spinner"></span> 더 불러오는 중...' : '아래로 내리면 더 불러옵니다' });
    list.append(more);
    // 끝까지 스크롤하면 다음 30개
    list.onscroll = () => {
      if (!loading && list.scrollTop + list.clientHeight > list.scrollHeight - 40) load(c.page + 1);
    };
  }
  if (c.auth === 'none' && c.service?.kind === 'github') list.append(h('div', { class: 'iss-note', text: '로그인 없이 공개 이슈만 보는 중입니다.' }));
}

function row(it, c) {
  // 좁은 사이드바: 1줄 = 번호 + 제목(가능한 한 길게), 2줄 = 라벨·담당자·댓글 (작게)
  const labels = it.labels.slice(0, 2).map((l) => h('span', { class: 'iss-label', text: l.name, style: l.color ? { borderColor: l.color, color: l.color } : null }));
  const meta = [...labels, it.assignees.length ? h('span', { class: 'iss-cmt', text: `@${it.assignees[0]}` }) : null, it.comments ? h('span', { class: 'iss-cmt', text: `💬${it.comments}` }) : null].filter(Boolean);
  const r = h(
    'div',
    { class: `iss-row ${it.state}`, title: `#${it.number} ${it.title}
${it.body.replace(/\s+/g, ' ').slice(0, 200)}` },
    h('div', { class: 'iss-l1' }, h('span', { class: 'iss-no', text: it.ref || `#${it.number}`, title: it.ref || '' }), h('span', { class: 'iss-title', text: it.title })),
    meta.length ? h('div', { class: 'iss-l2' }, ...meta) : null
  );
  // 누르면: 히스토리를 이 이슈의 커밋만 보이게 (다시 누르면 해제). 상세는 두 번 클릭 또는 ⓘ
  const sel = currentIssueFilter()?.number === it.number;
  r.classList.toggle('selected', sel);
  r.title = `${r.title}\n\n클릭: 이 이슈의 커밋만 히스토리에 보기 · 두 번 클릭(또는 ⓘ): 이슈 내용`;
  r.onclick = () => {
    filterByIssue(currentIssueFilter()?.number === it.number ? null : it);
    draw();
  };
  r.ondblclick = (e) => {
    e.preventDefault();
    openIssue(it, c.service);
  };
  const info = h('button', { class: 'iss-info', text: 'ⓘ', title: '이슈 내용 보기' });
  info.onclick = (e) => {
    e.stopPropagation();
    openIssue(it, c.service);
  };
  r.querySelector('.iss-l1').append(info);
  return r;
}

// 로그인/연결 문제 안내
function problem(c) {
  const box = h('div', { class: 'iss-problem' });
  if (c.error === 'no-remote') box.append(h('div', { text: '원격 저장소(origin)가 없어 이슈를 표시할 수 없습니다.' }));
  else if (c.error === 'unsupported' || c.error === 'unknown-remote') box.append(h('div', { text: `원격 저장소${c.host ? `(${c.host})` : ''}가 GitHub / GitLab 이 아니어서 이슈를 표시할 수 없습니다.` }));
  else if (c.error === 'auth' || c.error === 'no-access') {
    const svc = c.service;
    const name = svc.kind === 'github' ? 'GitHub' : 'GitLab';
    const how = `${esc(svc.host)} 에서 '${svc.kind === 'github' ? 'repo' : 'read_api'}' 권한의 개인 액세스 토큰을 만들어 붙여 넣으세요. 토큰은 이 PC 의 Windows 계정으로 암호화해 저장합니다.`;
    box.append(
      h('div', {
        html: c.error === 'no-access' ? `<b>${esc(c.message)}</b><br><span class="iss-dim">${how}</span>` : `<b>${name} 이슈를 보려면 토큰이 필요합니다.</b><br><span class="iss-dim">${how}</span>`,
      })
    );
    const make = h('button', { class: 'tb-btn small', text: '① 토큰 만들기 (브라우저)' });
    make.onclick = () => window.api.openExternal(svc.newTokenUrl);
    const input = h('input', { class: 'iss-search iss-token', type: 'password', placeholder: '② 만든 토큰 붙여 넣기 (Ctrl+V 또는 오른쪽 클릭)', spellcheck: 'false' });
    if (keepTok) {
      input.value = keepTok.value;
      if (keepTok.focus) setTimeout(() => input.focus());
    }
    const save = h('button', { class: 'btn primary small', text: '연결' });
    save.onclick = async () => {
      if (!input.value.trim()) return input.focus();
      save.disabled = true;
      const r = await window.api.issues.setToken(state.repo, input.value);
      save.disabled = false;
      if (!r.ok) return toast(r.error, 'error', 6000);
      input.value = '';
      toast('연결했습니다.', 'ok');
      cache.clear();
      load(1);
    };
    input.onkeydown = (e) => e.key === 'Enter' && save.click();
    box.append(make, input, save);
  } else box.append(h('div', { text: c.message || '이슈를 불러오지 못했습니다.' }));
  return box;
}

// ---------- 이슈 상세 ----------

function slug(s) {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function openIssue(it, svc) {
  const meta = h(
    'div',
    { class: 'iss-meta' },
    h('span', { class: `iss-state ${it.state}`, text: it.state === 'open' ? '열림' : '닫힘' }),
    h('span', { text: `${it.author} 님이 ${fmtDate(new Date(it.created).getTime(), false)} 에 작성` }),
    it.assignees.length ? h('span', { text: `담당: ${it.assignees.join(', ')}` }) : null,
    it.milestone ? h('span', { text: `마일스톤: ${it.milestone}` }) : null,
    it.comments ? h('span', { text: `댓글 ${it.comments}개` }) : null
  );
  const labels = it.labels.length ? h('div', { class: 'iss-meta' }, ...it.labels.map((l) => h('span', { class: 'iss-label', text: l.name, style: l.color ? { borderColor: l.color, color: l.color } : null }))) : null;
  const body = h('div', { class: 'iss-body ai-text', html: it.body.trim() ? md(it.body) : '<span class="iss-dim">(내용 없음)</span>' });
  bindLinks(body);
  const box = h('div', { class: 'iss-detail' }, meta, labels, body);
  modal({
    title: `#${it.number}  ${it.title}`,
    body: box,
    wide: true,
    buttons: [
      { label: '웹에서 열기', onClick: () => (window.api.openExternal(it.url), false) },
      {
        label: '커밋 메시지에 번호 넣기',
        onClick: () => {
          document.querySelector('.rail-btn[data-view="changes"]')?.click();
          const m = document.querySelector('#commitMsg');
          if (m) {
            const ref = `#${it.number}`;
            if (!m.value.includes(ref)) m.value = m.value.trim() ? `${m.value.trimEnd()} ${ref}` : `${ref} `;
            m.focus();
            m.setSelectionRange(m.value.length, m.value.length);
          }
        },
      },
      { label: '이 이슈로 브랜치 만들기', primary: true, onClick: () => setTimeout(() => newBranch(undefined, { name: `${svc?.kind === 'gitlab' ? '' : 'issue-'}${it.number}-${slug(it.title)}`.replace(/-$/, '') })) },
    ],
  });
}
