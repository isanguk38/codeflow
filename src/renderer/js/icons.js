// 아이콘 한 벌: VS Code 의 codicon 글꼴 (styles.css 의 .ci). 이모지·특수문자 대신 여기 이름으로 쓴다
import { h } from './ui.js';

export const IC = {
  add: '\uea60',
  close: '\uea76',
  check: '\ueab2',
  chevDown: '\ueab4',
  chevRight: '\ueab6',
  history: '\uea82',
  gear: '\ueb51',
  pause: '\uead1',
  stop: '\uead7',
  zap: '\uea86',
  attach: '\uec34',
  file: '\uea7b',
  image: '\ueaea',
  pdf: '\ueaeb',
  table: '\uebb7',
  slides: '\ueb2f',
  trash: '\uea81',
  warning: '\uea6c',
  info: '\uea74',
  comment: '\uea6b',
  external: '\ueb14',
  refresh: '\ueb37',
};

// 아이콘 한 개 (span). cls 로 크기·색 클래스를 더한다
export const ico = (name, cls = '') => h('span', { class: `ci ${cls}`.trim(), text: IC[name] });
// 파일 종류에 맞는 아이콘 이름
export const fileKindIcon = (kind) => (kind === 'image' ? 'image' : kind === 'pdf' ? 'pdf' : 'file');
