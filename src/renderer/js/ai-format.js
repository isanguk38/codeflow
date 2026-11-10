// AI 답변을 화면에 보여 주기 위한 글 변환: 마크다운 → HTML, 도구 호출 한 줄 설명
import { esc } from './ui.js';
import { state } from './state.js';

// 아주 작은 마크다운: 코드 블록, 인라인 코드, 굵게, 제목, 목록, 링크
// 마크다운 → HTML (AI 답변, 이슈 본문): 코드 블록, 표, 제목, 목록(들여쓰기), 인용, 구분선, 굵게·기울임·취소선·인라인 코드·링크
function mdInline(s) {
  const codes = [];
  s = esc(s).replace(/`([^`\n]+)`/g, (_, c) => (codes.push(`<code>${c}</code>`), `\u0001${codes.length - 1}\u0001`));
  s = s
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="#" data-url="$2">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="#" data-url="$2">$2</a>');
  return s.replace(/\u0001(\d+)\u0001/g, (_, i) => codes[+i]);
}

const splitRow = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));

export function md(text) {
  const out = [];
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(mdInline).join('<br>')}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 코드 블록
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      flush();
      const code = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) code.push(lines[i]);
      out.push(`<pre class="ai-code-block"><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    // 표: | a | b |  다음 줄이 |---|---|
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1] || '')) {
      flush();
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : ''));
      const rows = [];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(splitRow(lines[i]));
      i--;
      const td = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${mdInline(c)}</${tag}>`;
      out.push(
        `<div class="ai-table-wrap"><table class="ai-table"><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${head.map((_, k) => td('td', r[k] ?? '', k)).join('')}</tr>`)
          .join('')}</tbody></table></div>`
      );
      continue;
    }
    // 제목
    const hd = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (hd) {
      flush();
      out.push(`<div class="ai-h ai-h${Math.min(hd[1].length, 4)}">${mdInline(hd[2])}</div>`);
      continue;
    }
    // 구분선
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push('<hr class="ai-hr">');
      continue;
    }
    // 인용
    if (/^\s*>/.test(line)) {
      flush();
      const q = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) q.push(lines[i].replace(/^\s*>\s?/, ''));
      i--;
      out.push(`<blockquote class="ai-quote">${md(q.join('\n'))}</blockquote>`);
      continue;
    }
    // 목록 (들여쓰기 수준 유지)
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flush();
      const depth = Math.min(4, Math.floor(li[1].replace(/\t/g, '  ').length / 2));
      const mark = /\d/.test(li[2]) ? li[2].replace(')', '.') : '•';
      const task = li[3].match(/^\[( |x|X)\]\s+(.*)$/);
      const body = task ? `${task[1] === ' ' ? '☐' : '☑'} ${mdInline(task[2])}` : mdInline(li[3]);
      out.push(`<div class="ai-li" style="padding-left:${10 + depth * 16}px"><span class="ai-li-mark">${mark}</span><span>${body}</span></div>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    para.push(line);
  }
  flush();
  return out.join('');
}

export function bindLinks(el) {
  el.querySelectorAll('a[data-url]').forEach((a) => (a.onclick = (e) => (e.preventDefault(), window.api.openExternal(a.dataset.url))));
}

// 도구 호출을 사람이 읽기 쉬운 한 줄로
export function describeTool(name, input = {}) {
  const short = (s, n = 90) => (String(s || '').length > n ? `${String(s).slice(0, n)}…` : String(s || ''));
  const rel = (p) => short(String(p || '').replace(state.repo || '', '').replace(/^[\\/]/, ''));
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return `명령 실행: ${short(input.command)}`;
    case 'Read':
      return `파일 읽기: ${rel(input.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
      return `파일 수정: ${rel(input.file_path)}`;
    case 'Write':
      return `파일 쓰기: ${rel(input.file_path)}`;
    case 'Grep':
      return `검색: ${short(input.pattern)}`;
    case 'Glob':
      return `파일 찾기: ${short(input.pattern)}`;
    case 'WebFetch':
      return `웹 페이지 읽기: ${short(input.url)}`;
    case 'WebSearch':
      return `웹 검색: ${short(input.query)}`;
    case 'TodoWrite':
      return '할 일 목록 정리';
    case 'mcp__codeflow__run_in_terminal':
      return `CodeFlow 터미널에서 실행: ${short(input.command)}`;
    case 'mcp__codeflow__read_terminal':
      return 'CodeFlow 터미널 출력 확인';
    case 'mcp__codeflow__list_terminals':
      return 'CodeFlow 터미널 목록 확인';
    case 'mcp__codeflow__open_file':
      return `파일 열기: ${rel(input.path)}${input.line ? `:${input.line}` : ''}`;
    case 'mcp__codeflow__show_view':
      return `화면 이동: ${{ changes: '커밋', log: '히스토리', stash: '스태시', code: '코드' }[input.view] || input.view}`;
    case 'mcp__codeflow__git_status':
      return `Git 상태 확인${input.path ? `: ${input.path.split(/[\\/]/).pop()}` : ''}`;
    case 'mcp__codeflow__save_document':
      return `문서 저장 위치 묻기: ${String(input.path || '').split(/[\\/]/).pop()}`;
    case 'mcp__codeflow__list_projects':
      return '열린 프로젝트 탭 확인';
    case 'mcp__codeflow__switch_project':
      return `프로젝트 탭 전환: ${String(input.path || '').split(/[\\/]/).pop()}`;
    default:
      return `${name.replace(/^mcp__/, '').replace(/__/g, ' · ')}`;
  }
}

// AI 가 파일을 만들거나 고치면 그 도구 표시 아래에 파일 카드 (이미지는 미리보기) — 같은 파일은 마지막 것만
export const FILE_TOOLS = { Write: '만듦/덮어씀', Edit: '수정함', MultiEdit: '수정함', NotebookEdit: '수정함' };
