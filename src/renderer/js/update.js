// 새 버전 안내: 시작 시와 6시간마다 GitHub 최신 릴리즈를 확인하고, 있으면 안내 창 + 상단 "업데이트" 버튼
import { $, h, esc, modal, toast } from './ui.js';

const INTERVAL = 6 * 60 * 60 * 1000;
let info = null; // 마지막 확인 결과

const today = () => new Date().toISOString().slice(0, 10);
const snoozeKey = (v) => `update.later.${v}`;

export function startUpdateCheck() {
  $('#updateBtn').onclick = () => info?.available && openUpdateDialog();
  setTimeout(() => check(false), 4000);
  setInterval(() => check(false), INTERVAL);
}

async function check(manual) {
  const r = await window.api.checkUpdate();
  if (!r.ok) {
    if (manual) toast(`업데이트 확인 실패: ${r.error}`, 'error', 6000);
    return null;
  }
  info = r.data;
  const btn = $('#updateBtn');
  btn.hidden = !(info.available && info.packaged);
  btn.title = info.available ? `새 버전 ${info.latest.version} 이 있습니다` : '';
  if (info.available) {
    // '나중에' 를 누른 날에는 다시 묻지 않는다 (상단 버튼으로는 언제든 가능)
    if (manual || (info.packaged && localStorage.getItem(snoozeKey(info.latest.version)) !== today())) openUpdateDialog();
  } else if (manual) toast(`최신 버전입니다 (${info.current})`, 'ok');
  return info;
}

export const checkForUpdatesNow = () => check(true);

// 릴리즈 설명(마크다운 일부)을 간단히 표시
function notesHtml(text) {
  if (!text.trim()) return '<p class="fdir">변경 내용이 적혀 있지 않습니다.</p>';
  let html = '';
  let inList = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const li = line.match(/^[-*] (.*)$/);
    if (li) {
      if (!inList) html += '<ul>';
      inList = true;
      html += `<li>${esc(li[1])}</li>`;
      continue;
    }
    if (inList) {
      html += '</ul>';
      inList = false;
    }
    const hd = line.match(/^#{1,6} (.*)$/);
    if (hd) html += `<h4>${esc(hd[1])}</h4>`;
    else if (line) html += `<p>${esc(line)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

function openUpdateDialog() {
  const { current, latest, packaged, portable } = info;
  const canInstall = packaged && !portable && latest.url;
  const note = !packaged
    ? '개발 모드(npm start)에서는 자동 설치를 할 수 없습니다. 릴리즈 페이지에서 받으세요.'
    : portable
      ? '포터블 버전은 자동 설치를 할 수 없습니다. 릴리즈 페이지에서 새 포터블 파일을 받으세요.'
      : '지금 업데이트를 누르면 설치 파일을 받아 실행하고 앱이 잠시 닫힙니다. 설치가 끝나면 새 버전으로 열 수 있습니다. 열어 둔 탭과 설정은 그대로 남습니다.';
  const errEl = h('p', { class: 'error-text', hidden: true });
  const body = h(
    'div',
    { class: 'update-dialog' },
    h('p', { class: 'msg', html: `CodeFlow <b>${esc(current)}</b> → <b>${esc(latest.version)}</b> 업데이트가 있습니다. 업데이트하시겠습니까?` }),
    h('h4', { text: '바뀐 점' }),
    h('div', { class: 'update-notes', html: notesHtml(latest.notes || '') }),
    h('p', { class: 'fdir', text: note }),
    h('p', {}, h('a', { href: '#', text: '릴리즈 페이지에서 보기', onclick: (e) => (e.preventDefault(), window.api.openExternal(latest.page)) })),
    errEl
  );
  let busy = false;
  const m = modal({
    title: '새 버전이 나왔습니다',
    body,
    wide: true,
    dismissable: true,
    buttons: [
      {
        label: '나중에',
        onClick: () => {
          if (busy) return false;
          localStorage.setItem(snoozeKey(latest.version), today());
        },
      },
      {
        label: canInstall ? '지금 업데이트' : '다운로드 페이지 열기',
        primary: true,
        onClick: async (btn) => {
          if (!canInstall) {
            window.api.openExternal(latest.page);
            return;
          }
          if (busy) return false;
          busy = true;
          errEl.hidden = true;
          btn.disabled = true;
          m.buttons[0].disabled = true;
          btn.textContent = '내려받는 중...';
          window.api.onUpdateProgress((p) => (btn.textContent = p >= 0 ? `내려받는 중 ${p}%` : '내려받는 중...'));
          const r = await window.api.installUpdate(latest.url);
          if (!r.ok) {
            busy = false;
            btn.disabled = false;
            m.buttons[0].disabled = false;
            btn.textContent = '다시 시도';
            errEl.textContent = r.error;
            errEl.hidden = false;
            return false;
          }
          btn.textContent = '설치 프로그램을 실행합니다...';
          return false; // 앱이 곧 종료된다
        },
      },
    ],
  });
}
