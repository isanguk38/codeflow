// 앱 아이콘 생성: build/icon.svg, build/icon.png, build/icon.ico, src/renderer/icon.png
// 실행: electron scripts/make-icon.js (ELECTRON_RUN_AS_NODE 없이)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// small: 16~32px 에서도 알아볼 수 있게 선과 점을 키운 모양
function svg(small) {
  const line = small ? 62 : 44;
  const r = small ? 62 : 46;
  const [x, top, mid, bottom, rx, ry] = small ? [160, 112, 318, 400, 352, 136] : [172, 118, 322, 394, 340, 150];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4f46e5"/>
      <stop offset="1" stop-color="#0ea5e9"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <g fill="none" stroke="#fff" stroke-width="${line}" stroke-linecap="round">
    <path d="M${x} ${top}V${bottom}"/>
    <path d="M${x} ${mid}C${x} ${mid - 96} ${rx} ${ry + 110} ${rx} ${ry}"/>
  </g>
  <circle cx="${x}" cy="${top}" r="${r}" fill="#fff"/>
  <circle cx="${x}" cy="${bottom}" r="${r}" fill="#fff"/>
  <circle cx="${rx}" cy="${ry}" r="${r}" fill="#fde047"/>
</svg>
`;
}

// PNG 를 그대로 담는 ICO (Windows Vista 이상)
function ico(pngs) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const dir = pngs.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([head, ...dir, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await w.loadURL('about:blank');
  const render = async (size) => {
    const source = svg(size <= 32);
    const b64 = await w.webContents.executeJavaScript(`new Promise((ok, no) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = ${size};
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, ${size}, ${size});
        ok(c.toDataURL('image/png').split(',')[1]);
      };
      img.onerror = () => no(new Error('아이콘을 그리지 못했습니다'));
      img.src = 'data:image/svg+xml;base64,${Buffer.from(source).toString('base64')}';
    })`);
    return { size, data: Buffer.from(b64, 'base64') };
  };
  const pngs = [];
  for (const size of [16, 20, 24, 32, 40, 48, 64, 128, 256]) pngs.push(await render(size));
  const big = await render(1024);
  const build = path.join(ROOT, 'build');
  fs.mkdirSync(build, { recursive: true });
  fs.writeFileSync(path.join(build, 'icon.svg'), svg(false));
  fs.writeFileSync(path.join(build, 'icon.png'), big.data);
  fs.writeFileSync(path.join(build, 'icon.ico'), ico(pngs));
  fs.writeFileSync(path.join(ROOT, 'src', 'renderer', 'icon.png'), pngs.find((p) => p.size === 256).data);
  console.log('아이콘 생성 완료');
  app.exit(0);
});
