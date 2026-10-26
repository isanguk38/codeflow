// 왼쪽 레일 'AI' 화면: [1:1 대화] (예전 오른쪽 AI 패널의 모든 기능) / [팀] (멀티 에이전트 채팅방) 전환
import { $, $$ } from './ui.js';
import { onAiShown } from './ai.js';
import { initTeam, activateTeam } from './team.js';

let mode = localStorage.getItem('ai.mode') === 'team' ? 'team' : 'chat';
let shown = false;

export const hubMode = () => mode;

export function initHub() {
  initTeam();
  $$('.ai-hub-tab').forEach((b) => (b.onclick = () => setHubMode(b.dataset.mode)));
}

// 'AI' 화면이 보일 때
export function activateHub() {
  shown = true;
  apply();
}
// 다른 화면으로 갈 때
export function deactivateHub() {
  if (!shown) return;
  shown = false;
  onAiShown(false);
}

export function setHubMode(m) {
  mode = m === 'team' ? 'team' : 'chat';
  localStorage.setItem('ai.mode', mode);
  if (shown) apply();
}

function apply() {
  $('#aiPanel').hidden = mode !== 'chat';
  $('#view-team').hidden = mode !== 'team';
  $$('.ai-hub-tab').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  // 봤으니 알림 점을 지운다 (팀 소식은 '팀' 탭을 볼 때)
  if (mode === 'team') $('.ai-hub-tab[data-mode="team"]')?.classList.remove('has-news');
  if (mode === 'chat' || !$('.ai-hub-tab[data-mode="team"]')?.classList.contains('has-news')) $('.rail-btn[data-view="ai"]')?.classList.remove('has-news');
  onAiShown(mode === 'chat');
  $('#aiBtn')?.classList.add('on'); // AI 화면에 있는 동안은 (팀 탭이어도) ✦ AI 버튼을 켜진 표시로
  if (mode === 'team') activateTeam();
}
