// 공통 UI 유틸: DOM 헬퍼, 모달, 확인/입력 대화상자, 토스트, 컨텍스트 메뉴

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function fmtDate(ms, withTime = true) {
  const d = new Date(ms);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (sameDay) return `오늘 ${time}`;
  if (d.toDateString() === yest.toDateString()) return `어제 ${time}`;
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return withTime ? `${date} ${time}` : date;
}

export function splitPath(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i), name: p.slice(i + 1) };
}

export const STATUS_LABEL = {
  modified: '수정',
  added: '추가',
  deleted: '삭제',
  renamed: '이름 변경',
  untracked: '새 파일',
  conflict: '충돌',
};

// ---------- 모달 ----------

export function modal({ title, body, buttons = [], wide = false, full = false, onClose, dismissable = true }) {
  const overlay = $('#overlay');
  const backdrop = h('div', { class: 'modal-backdrop' });
  const box = h('div', { class: `modal ${wide ? 'wide' : ''} ${full ? 'full' : ''}` });
  const header = h('div', { class: 'modal-header' }, h('span', { class: 'modal-title' }, title || ''));
  const closeBtn = h('button', { class: 'modal-x', title: '닫기', text: '✕' });
  header.append(closeBtn);
  const content = h('div', { class: 'modal-body' });
  if (typeof body === 'string') content.innerHTML = body;
  else if (body) content.append(body);
  const footer = h('div', { class: 'modal-footer' });
  box.append(header, content);
  if (buttons.length) box.append(footer);
  backdrop.append(box);
  overlay.append(backdrop);

  let closed = false;
  const close = (val) => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.(val);
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissable) {
      e.stopPropagation();
      close(null);
    }
  };
  document.addEventListener('keydown', onKey, true);
  closeBtn.onclick = () => close(null);
  if (dismissable) backdrop.addEventListener('mousedown', (e) => e.target === backdrop && close(null));

  const btnEls = buttons.map((b) => {
    const el = h('button', { class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`, text: b.label });
    el.onclick = async () => {
      if (b.onClick) {
        const r = await b.onClick(el);
        if (r === false) return;
        close(r === undefined ? b.value : r);
      } else close(b.value);
    };
    footer.append(el);
    return el;
  });
  return { box, content, footer, close, buttons: btnEls };
}

export function confirmDialog(message, { title = '확인', okLabel = '확인', danger = false, detail } = {}) {
  return new Promise((resolve) => {
    const body = h('div', {}, h('p', { class: 'msg', text: message }), detail ? h('pre', { class: 'detail', text: detail }) : null);
    const m = modal({
      title,
      body,
      buttons: [
        { label: '취소', value: false },
        { label: okLabel, value: true, primary: !danger, danger },
      ],
      onClose: (v) => resolve(!!v),
    });
    m.buttons[1].focus();
  });
}

export function promptDialog(message, { title = '입력', value = '', placeholder = '', okLabel = '확인', checkbox } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'input', value, placeholder, spellcheck: 'false' });
    const cb = checkbox ? h('input', { type: 'checkbox', checked: checkbox.checked }) : null;
    const body = h(
      'div',
      { class: 'form' },
      h('label', { class: 'form-label', text: message }),
      input,
      cb ? h('label', { class: 'check' }, cb, ' ', checkbox.label) : null
    );
    const submit = () => {
      const v = input.value.trim();
      if (!v) {
        input.focus();
        return false;
      }
      return checkbox ? { value: v, checked: cb.checked } : v;
    };
    const m = modal({
      title,
      body,
      buttons: [
        { label: '취소', value: null },
        { label: okLabel, primary: true, onClick: submit },
      ],
      onClose: (v) => resolve(v ?? null),
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const v = submit();
        if (v !== false) m.close(v);
      }
    });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  });
}

export function choiceDialog(message, choices, { title = '선택' } = {}) {
  return new Promise((resolve) => {
    modal({
      title,
      body: h('p', { class: 'msg', text: message }),
      buttons: [{ label: '취소', value: null }, ...choices.map((c) => ({ label: c.label, value: c.value, primary: c.primary, danger: c.danger }))],
      onClose: (v) => resolve(v ?? null),
    });
  });
}

export function errorDialog(message, title = '오류') {
  modal({
    title,
    body: h('pre', { class: 'detail error-text', text: message }),
    buttons: [{ label: '닫기', primary: true }],
  });
}

// ---------- 토스트 ----------

export function toast(message, type = 'info', ms = 3500) {
  let wrap = $('#toasts');
  if (!wrap) {
    wrap = h('div', { id: 'toasts' });
    document.body.append(wrap);
  }
  const t = h('div', { class: `toast ${type}`, text: message });
  wrap.append(t);
  setTimeout(() => t.classList.add('hide'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

// ---------- 컨텍스트 메뉴 / 팝업 메뉴 ----------

let activeMenu = null;

export function closeMenu() {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
  }
}

// 직접 만든 팝업을 컨텍스트 메뉴처럼 바깥 클릭 시 닫히도록 등록
export function registerMenu(el) {
  if (activeMenu && activeMenu !== el) activeMenu.remove();
  activeMenu = el;
}

document.addEventListener('mousedown', (e) => {
  if (activeMenu && !activeMenu.contains(e.target)) closeMenu();
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());
window.addEventListener('blur', closeMenu);

// items: [{label, onClick, danger, disabled, hint, header}] 또는 '-'
export function contextMenu(x, y, items) {
  closeMenu();
  const menu = h('div', { class: 'ctx-menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') {
      menu.append(h('div', { class: 'ctx-sep' }));
      continue;
    }
    if (it.header) {
      menu.append(h('div', { class: 'ctx-header', text: it.header }));
      continue;
    }
    const el = h(
      'div',
      { class: `ctx-item ${it.danger ? 'danger' : ''} ${it.disabled ? 'disabled' : ''}` },
      h('span', { text: it.label }),
      it.hint ? h('span', { class: 'ctx-hint', text: it.hint }) : null
    );
    if (!it.disabled)
      el.onclick = () => {
        closeMenu();
        it.onClick?.();
      };
    menu.append(el);
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - r.width - 4);
  const top = y + r.height > window.innerHeight ? Math.max(4, y - r.height) : y;
  menu.style.left = `${Math.max(4, left)}px`;
  menu.style.top = `${top}px`;
  activeMenu = menu;
  return menu;
}

export function menuAt(el, items) {
  const r = el.getBoundingClientRect();
  return contextMenu(r.left, r.bottom + 2, items);
}

// 드래그로 패널 크기 조절
export function splitter(handle, target, { axis = 'x', min = 150, max = 1200, invert = false, key } = {}) {
  const saved = key && localStorage.getItem(`split:${key}`);
  if (saved) target.style[axis === 'x' ? 'width' : 'height'] = saved;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const start = axis === 'x' ? e.clientX : e.clientY;
    const startSize = axis === 'x' ? target.offsetWidth : target.offsetHeight;
    document.body.classList.add(axis === 'x' ? 'resizing-x' : 'resizing-y');
    const move = (ev) => {
      let d = (axis === 'x' ? ev.clientX : ev.clientY) - start;
      if (invert) d = -d;
      const size = Math.max(min, Math.min(max, startSize + d));
      target.style[axis === 'x' ? 'width' : 'height'] = `${size}px`;
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing-x', 'resizing-y');
      if (key) localStorage.setItem(`split:${key}`, target.style[axis === 'x' ? 'width' : 'height']);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}
