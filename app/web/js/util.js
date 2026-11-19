// Small helpers shared by every module.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style' && typeof value === 'object') {
      for (const [prop, v] of Object.entries(value)) {
        if (prop.startsWith('--')) node.style.setProperty(prop, v);
        else node.style[prop] = v;
      }
    }
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'html') node.innerHTML = value;
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
  wrapped.flush = (...args) => { clearTimeout(timer); timer = null; fn(...args); };
  wrapped.cancel = () => { clearTimeout(timer); timer = null; };
  return wrapped;
}

let uidCounter = 0;
export function uid() {
  uidCounter = (uidCounter + 1) % 1e6;
  return Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 7) + uidCounter.toString(36);
}

export function fmtTime(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
}

export function fmtDuration(sec) {
  const s = Math.round(Math.max(0, sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtDate(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Today ${time}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })} ${time}`;
}

// FNV-1a over a string, returned as unsigned 32-bit hex.
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// First index whose item.t >= t (items sorted by .t).
export function lowerBound(items, t) {
  let lo = 0, hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].t < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export class Emitter {
  constructor() { this._handlers = new Map(); }
  on(type, fn) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }
  off(type, fn) { this._handlers.get(type)?.delete(fn); }
  emit(type, payload) {
    for (const fn of [...(this._handlers.get(type) || [])]) {
      try { fn(payload); } catch (err) { console.error(err); }
    }
  }
}

export function isTyping(event) {
  const t = event.target;
  if (!t) return false;
  if (t.isContentEditable) return true;
  if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  if (t.tagName === 'INPUT') return !['range', 'checkbox', 'radio', 'button'].includes(t.type);
  return false;
}

// Inline icon set, drawn on a 24px grid.
export const ICONS = {
  chevron: '<path d="M7 10l5 5 5-5"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
  sliders: '<path d="M6 4v16M12 4v16M18 4v16"/><rect x="3.5" y="13" width="5" height="3.2" rx="1" fill="currentColor"/><rect x="9.5" y="7" width="5" height="3.2" rx="1" fill="currentColor"/><rect x="15.5" y="15" width="5" height="3.2" rx="1" fill="currentColor"/>',
  export: '<path d="M12 4v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19h14"/>',
  gear: '<path d="M19.23 10.43 L21.52 10.80 L21.52 13.20 L19.23 13.57 L18.22 16.00 L19.59 17.88 L17.88 19.59 L16.00 18.22 L13.57 19.23 L13.20 21.52 L10.80 21.52 L10.43 19.23 L8.00 18.22 L6.12 19.59 L4.41 17.88 L5.78 16.00 L4.77 13.57 L2.48 13.20 L2.48 10.80 L4.77 10.43 L5.78 8.00 L4.41 6.12 L6.12 4.41 L8.00 5.78 L10.43 4.77 L10.80 2.48 L13.20 2.48 L13.57 4.77 L16.00 5.78 L17.88 4.41 L19.59 6.12 L18.22 8.00 Z"/><circle cx="12" cy="12" r="3"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.6 2.3c-.8.4-1.2 1-1.2 1.8v.5"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>',
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/>',
  home: '<path d="M6 5v14"/><path d="M18 5.5v13L9 12z" fill="currentColor"/>',
  click: '<path d="M8 20h8l-2.6-15h-2.8z"/><path d="M12 15l5-8"/>',
  countin: '<path d="M5 18h3v-3H5zM10.5 18h3v-6h-3zM16 18h3V9h-3z"/>',
  loop: '<path d="M17 7H8a4 4 0 0 0 0 8"/><path d="M14.5 4.5L17 7l-2.5 2.5"/><path d="M7 17h9a4 4 0 0 0 0-8"/><path d="M9.5 19.5L7 17l2.5-2.5"/>',
  lanes: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  speaker: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/>',
  muted: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M16 10l4 4M20 10l-4 4"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  file: '<path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20z"/><path d="M14 3.5V8h4"/>',
  music: '<path d="M9 17V6l10-2v11"/><circle cx="6.5" cy="17" r="2.5"/><circle cx="16.5" cy="15" r="2.5"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  cursor: '<path d="M6 4l12 7-5.2 1.3L10 18z"/>',
  pencil: '<path d="M5 19l1-4L16 5l3 3L9 18z"/><path d="M14 7l3 3"/>',
  magnet: '<path d="M6 4v7a6 6 0 0 0 12 0V4"/><path d="M6 8h3M15 8h3"/>',
  quantize: '<path d="M4 20V4M10 20V4M16 20V4"/><circle cx="10" cy="9" r="2" fill="currentColor"/><circle cx="16" cy="15" r="2" fill="currentColor"/>',
  humanize: '<path d="M3 14c2.5 0 2.5-4 5-4s2.5 6 5 6 2.5-8 5-8 2 3 3 3"/>',
  velocity: '<path d="M5 20v-4M10 20V9M15 20v-7M20 20V5"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/>',
  takes: '<rect x="4" y="8" width="13" height="11" rx="1.5"/><path d="M8 5h11.5a.5.5 0 0 1 .5.5V16"/>',
  plug: '<path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0z"/><path d="M12 16v5"/>',
  folder: '<path d="M3.5 6.5h6l2 2h9v10.5h-17z"/>',
  window: '<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><path d="M3.5 9h17"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  more: '<circle cx="6" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="18" cy="12" r="1.5" fill="currentColor"/>',
  move: '<path d="M4 12h14"/><path d="M13.5 7.5L18 12l-4.5 4.5"/>',
  copy: '<rect x="8" y="8" width="11" height="11" rx="1.5"/><path d="M5 15.5V6a1 1 0 0 1 1-1h9.5"/>',
  swap: '<path d="M5 9h13"/><path d="M14.5 5.5L18 9l-3.5 3.5"/><path d="M19 15H6"/><path d="M9.5 11.5L6 15l3.5 3.5"/>',
  star: '<path d="M12 4.5l2.3 4.8 5.2.7-3.8 3.6.9 5.2L12 16.4l-4.6 2.4.9-5.2-3.8-3.6 5.2-.7z"/>',
  drum: '<ellipse cx="12" cy="8" rx="8" ry="3"/><path d="M4 8v8c0 1.7 3.6 3 8 3s8-1.3 8-3V8"/>',
  module: '<rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M7 10h4M7 14h2"/><circle cx="16" cy="12" r="2.2"/>',
  refresh: '<path d="M19 12a7 7 0 1 1-2.1-5"/><path d="M19 4v4h-4"/>',
  power: '<path d="M12 4v8"/><path d="M7.5 7a7 7 0 1 0 9 0"/>',
  midi: '<circle cx="12" cy="12" r="8.5"/><circle cx="8" cy="12" r=".8" fill="currentColor"/><circle cx="16" cy="12" r=".8" fill="currentColor"/><circle cx="9.2" cy="8.8" r=".8" fill="currentColor"/><circle cx="14.8" cy="8.8" r=".8" fill="currentColor"/><circle cx="12" cy="7.6" r=".8" fill="currentColor"/>',
};

export function icon(name) {
  const span = document.createElement('span');
  span.dataset.icon = name;
  span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return span;
}

export function hydrateIcons(root = document) {
  for (const node of root.querySelectorAll('[data-icon]')) {
    if (node.firstElementChild) continue;
    node.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[node.dataset.icon] || ''}</svg>`;
  }
}

export function setIcon(node, name) {
  if (!node) return;
  node.dataset.icon = name;
  node.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
