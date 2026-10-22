// AI 대화 저장소: 프로젝트마다 CodeFlow 가 대화를 직접 저장한다 (AI 를 바꿔도 같은 대화를 이어 가기 위해)
// 대화 = { id, title, created, updated, entries: [{ role, provider, text, tools[], files[], attachments[] }],
//          native: { claude: { id, seen }, codex: { id, seen } } }
//   native.<AI>.id   : 그 AI 쪽 세션(스레드) id — 같은 AI 로 이어갈 때 사용
//   native.<AI>.seen : 그 AI 가 이미 알고 있는 entries 개수 — 그 뒤에 다른 AI 와 나눈 내용만 넘겨 준다
const { app } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dirOf = (repo) => path.join(app.getPath('userData'), 'ai', 'conversations', crypto.createHash('sha1').update(repo.toLowerCase()).digest('hex').slice(0, 16));
const safeId = (id) => String(id).replace(/[^\w-]/g, '');

function list(repo) {
  const dir = dirOf(repo);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out.push({ id: c.id, title: c.title, updated: c.updated, count: c.entries.filter((e) => e.role === 'user').length, providers: [...new Set(c.entries.filter((e) => e.role === 'assistant').map((e) => e.provider))], native: c.native });
    } catch {}
  }
  return out.sort((a, b) => b.updated - a.updated).slice(0, 60);
}

function load(repo, id) {
  return JSON.parse(fs.readFileSync(path.join(dirOf(repo), `${safeId(id)}.json`), 'utf8'));
}

function save(repo, conv) {
  const dir = dirOf(repo);
  fs.mkdirSync(dir, { recursive: true });
  conv.updated = Date.now();
  fs.writeFileSync(path.join(dir, `${safeId(conv.id)}.json`), JSON.stringify(conv));
  return { id: conv.id, updated: conv.updated };
}

function remove(repo, id) {
  fs.rmSync(path.join(dirOf(repo), `${safeId(id)}.json`), { force: true });
}

module.exports = { list, load, save, remove };
