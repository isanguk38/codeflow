// 코드 화면의 여러 파일이 함께 쓰는 상태와 경로 도우미
import { state } from './state.js';

export const docs = new Map(); // 파일 경로(소문자) → { path, repo, model, savedVersion, mtime, bom, headText, deco, viewState, deleted }
export const repoViews = new Map(); // 저장소 → { tabs: [경로], active: 경로, expanded: Set<폴더 경로> }

export const keyOf = (p) => p.replace(/\//g, '\\').toLowerCase();
export const relOf = (repo, p) => p.slice(repo.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
export const baseName = (p) => p.split(/[\\/]/).pop();
export const view = () => {
  let v = repoViews.get(state.repo);
  if (!v) {
    v = { tabs: [], active: null, expanded: new Set(), back: [], fwd: [] };
    repoViews.set(state.repo, v);
  }
  return v;
};
