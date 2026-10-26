// 왼쪽 레일 'AI' 화면: 팀 채팅방 (1:1 대화는 없앴다 — 팀장 PM 과 대화하면 된다)
import { $ } from './ui.js';
import { initTeam, activateTeam } from './team.js';

let shown = false;

export function initHub() {
  initTeam();
}

// 'AI' 화면이 보일 때
export function activateHub() {
  shown = true;
  $('#aiBtn')?.classList.add('on');
  $('.rail-btn[data-view="ai"]')?.classList.remove('has-news');
  activateTeam();
}
// 다른 화면으로 갈 때
export function deactivateHub() {
  if (!shown) return;
  shown = false;
  $('#aiBtn')?.classList.remove('on');
}

// 예전 호환: 모드는 팀 하나뿐
export function setHubMode() {}
