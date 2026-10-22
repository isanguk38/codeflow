// 파일 미리보기 · 저장 (AI 대화의 파일 카드, 코드 화면에서 이미지 열기에서 함께 사용)
import { h, toast, modal } from './ui.js';

export const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i;
const baseName = (p) => String(p).split(/[\\/]/).pop();
const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

// '다른 이름으로 저장' (다운로드 폴더가 기본)
export async function saveCopy(p) {
  const r = await window.api.file.saveCopy(p);
  if (!r.ok) return toast(r.error, 'error', 5000);
  if (r.data) toast(`저장했습니다: ${r.data}`, 'ok', 4000);
}

// 이미지 크게 보기
export async function showImage(p, { openCode } = {}) {
  const r = await window.api.file.preview(p);
  if (!r.ok) return toast(r.error, 'error', 5000);
  const img = h('img', { src: r.data.url, alt: baseName(p) });
  const info = h('div', { class: 'img-info', text: `${p} · ${fmtSize(r.data.size)}` });
  img.onload = () => (info.textContent = `${p} · ${img.naturalWidth}×${img.naturalHeight} · ${fmtSize(r.data.size)}`);
  modal({
    title: baseName(p),
    wide: true,
    body: h('div', { class: 'img-view' }, h('div', { class: 'img-box' }, img), info),
    buttons: [
      { label: '탐색기에서 보기', onClick: () => (window.api.showItem(p), false) },
      openCode ? { label: '코드로 열기', onClick: () => setTimeout(openCode) } : null,
      { label: '다른 이름으로 저장...', onClick: () => (saveCopy(p), false) },
      { label: '닫기', primary: true },
    ].filter(Boolean),
  });
}

// AI 가 만들거나 고친 파일 카드: 이미지는 미리보기, 그 밖은 아이콘 + 열기 / 폴더 / 저장
export function fileCard(p, { verb = '파일', openFile } = {}) {
  const isImg = IMG_RE.test(p);
  const card = h('div', { class: 'file-card' });
  const head = h(
    'div',
    { class: 'fc-head' },
    h('span', { class: 'fc-ico', text: isImg ? '🖼' : '📄' }),
    h('span', { class: 'fc-name', text: baseName(p), title: p }),
    h('span', { class: 'fc-verb', text: verb })
  );
  const act = (label, title, fn) => {
    const b = h('button', { class: 'fc-btn', text: label, title });
    b.onclick = (e) => {
      e.stopPropagation();
      fn();
    };
    return b;
  };
  const actions = h(
    'div',
    { class: 'fc-actions' },
    act(isImg ? '보기' : '열기', isImg ? '크게 보기' : 'CodeFlow 코드 화면에서 열기', () => (isImg ? showImage(p, { openCode: /\.svg$/i.test(p) && openFile ? () => openFile(p, undefined, { code: true }) : null }) : openFile?.(p))),
    act('폴더', '탐색기에서 보기', () => window.api.showItem(p)),
    act('저장', '다른 이름으로 저장 (다운로드)', () => saveCopy(p))
  );
  card.append(head);
  if (isImg) {
    const thumb = h('div', { class: 'fc-thumb' });
    card.append(thumb);
    window.api.file.preview(p).then((r) => {
      if (!r.ok) return thumb.remove();
      const img = h('img', { src: r.data.url, alt: baseName(p), title: '눌러서 크게 보기' });
      img.onclick = () => showImage(p, { openCode: /\.svg$/i.test(p) && openFile ? () => openFile(p, undefined, { code: true }) : null });
      thumb.append(img);
    });
  }
  card.append(actions);
  return card;
}
