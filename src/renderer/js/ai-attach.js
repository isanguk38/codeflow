// AI 대화의 첨부: 파일·붙여넣은 이미지를 AI 가 받을 수 있는 모양으로 바꾸고, 첨부 칩을 그린다 (팀 화면도 같이 쓴다)
import { h, toast } from './ui.js';
import { ico, fileKindIcon } from './icons.js';

const MAX_SIDE = 1568; // 이보다 큰 이미지는 줄여서 보낸다 (AI 가 어차피 줄여서 보고, 전송·토큰도 아낌)
const OK_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이미지를 읽지 못했습니다.'));
    img.src = src;
  });
}

// 크기를 줄이거나 지원하지 않는 형식(bmp 등)을 png/jpeg 로 바꾼다
async function normalizeImage(mime, data) {
  const img = await loadImage(`data:${mime};base64,${data}`);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  if (scale === 1 && OK_MIME.includes(mime) && data.length < 4.5e6) return { mime, data, w: img.width, h: img.height };
  const cv = document.createElement('canvas');
  cv.width = Math.round(img.width * scale);
  cv.height = Math.round(img.height * scale);
  cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  let url = cv.toDataURL('image/png');
  if (url.length > 4.5e6) url = cv.toDataURL('image/jpeg', 0.85);
  return { mime: url.slice(5, url.indexOf(';')), data: url.slice(url.indexOf(',') + 1), w: cv.width, h: cv.height };
}

// 파일 경로 → 첨부 (이미지는 AI 가 받을 수 있는 크기로 줄임). 팀 화면도 같이 쓴다
export async function attachmentFromPath(file) {
  const r = await window.api.ai.readAttachment(file);
  if (!r.ok) {
    toast(r.error, 'error', 5000);
    return null;
  }
  const a = r.data;
  if (a.kind === 'image') Object.assign(a, await normalizeImage(a.mime, a.data).catch(() => ({})));
  return a;
}
// 붙여넣기한 이미지(파일 경로가 없는 것) → 첨부
export function attachmentFromBlob(f, n = 1) {
  if (!f.type.startsWith('image/')) {
    toast('붙여넣은 내용을 첨부할 수 없습니다. 첨부 버튼으로 파일을 고르세요.', 'warn');
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const rd = new FileReader();
    rd.onload = async () => {
      const url = String(rd.result);
      const img = await normalizeImage(url.slice(5, url.indexOf(';')), url.slice(url.indexOf(',') + 1)).catch(() => null);
      if (!img) {
        toast('이미지를 읽지 못했습니다.', 'error');
        return resolve(null);
      }
      resolve({ kind: 'image', name: f.name && f.name !== 'image.png' ? f.name : `붙여넣은 이미지 ${n}.png`, ...img, size: Math.round((img.data.length * 3) / 4) });
    };
    rd.readAsDataURL(f);
  });
}

const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

export function attachChip(a, onRemove) {
  const chip = h('div', { class: `ai-chip ${a.kind}`, title: `${a.path || a.name} · ${fmtSize(a.size || 0)}${a.kind === 'file' ? '\nAI 가 경로로 직접 읽습니다' : ''}` });
  if (a.kind === 'image') chip.append(h('img', { src: `data:${a.mime};base64,${a.data}` }));
  else chip.append(ico(fileKindIcon(a.kind), 'ai-chip-ico'));
  chip.append(h('span', { class: 'ai-chip-name', text: a.name }));
  if (onRemove) {
    const x = h('button', { class: 'ai-chip-x ci', text: '\uea76', title: '빼기' });
    x.onclick = onRemove;
    chip.append(x);
  }
  return chip;
}
