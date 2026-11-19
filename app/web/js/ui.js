// Tooltips, popovers, modals and toasts.

import { $, el, hydrateIcons, icon } from './util.js';

// ---- toasts ------------------------------------------------------------------
export function toast(message, { actionLabel, onAction, error = false, timeout = 4200 } = {}) {
  const layer = $('#toast-layer');
  const node = el('div', { class: `toast${error ? ' is-error' : ''}`, role: error ? 'alert' : 'status' }, el('span', {}, message));
  if (actionLabel) {
    const btn = el('button', { class: 'btn btn-small' }, actionLabel);
    btn.addEventListener('click', () => { onAction?.(); node.remove(); });
    node.append(btn);
  }
  layer.append(node);
  while (layer.children.length > 4) layer.firstElementChild.remove();
  const t = setTimeout(() => node.remove(), error ? Math.max(timeout, 7000) : timeout);
  node.addEventListener('mouseenter', () => clearTimeout(t));
  node.addEventListener('mouseleave', () => setTimeout(() => node.remove(), 1800));
  return node;
}

// ---- tooltips ----------------------------------------------------------------
let tipTimer = null;
let tipTarget = null;

export function initTooltips() {
  const tip = $('#tooltip');
  const show = (target) => {
    const text = target.dataset.tip;
    if (!text) return;
    tip.replaceChildren(el('span', {}, text));
    if (target.dataset.key) tip.append(el('kbd', {}, target.dataset.key));
    tip.hidden = false;
    const r = target.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    let x = r.left + r.width / 2 - tr.width / 2;
    x = Math.max(8, Math.min(window.innerWidth - tr.width - 8, x));
    let y = r.bottom + 8;
    if (y + tr.height > window.innerHeight - 8) y = r.top - tr.height - 8;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  };
  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest?.('[data-tip]');
    if (target === tipTarget) return;
    tipTarget = target;
    clearTimeout(tipTimer);
    tip.hidden = true;
    if (target) tipTimer = setTimeout(() => show(target), 550);
  });
  document.addEventListener('mousedown', () => { clearTimeout(tipTimer); tip.hidden = true; });
  document.addEventListener('keydown', () => { clearTimeout(tipTimer); tip.hidden = true; });
}

// ---- popovers ----------------------------------------------------------------
let openPop = null;

export function closePopover() {
  if (!openPop) return;
  const p = openPop;
  openPop = null;
  p.node.remove();
  document.removeEventListener('mousedown', p.outside, true);
  document.removeEventListener('keydown', p.keys, true);
  p.anchor?.setAttribute?.('aria-expanded', 'false');
  p.onClose?.();
}

export function popoverIsOpen(anchor) {
  return !!openPop && openPop.anchor === anchor;
}

/**
 * Open a popover next to an anchor element or at {x, y}.
 * content: a Node or a function(close) => Node.
 */
export function popover(anchor, content, { align = 'start', width, onClose, className = '' } = {}) {
  if (openPop && openPop.anchor === anchor && anchor instanceof Element) { closePopover(); return null; }
  closePopover();
  const node = el('div', { class: `popover ${className}`, role: 'dialog' });
  if (width) node.style.width = `${width}px`;
  const close = () => closePopover();
  node.append(typeof content === 'function' ? content(close) : content);
  hydrateIcons(node);
  $('#popover-layer').append(node);
  position(node, anchor, align);
  const outside = (e) => {
    if (node.contains(e.target)) return;
    if (anchor instanceof Element && anchor.contains(e.target)) { e.stopPropagation(); e.preventDefault(); closePopover(); return; }
    closePopover();
  };
  const keys = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePopover(); } };
  setTimeout(() => {
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', keys, true);
  }, 0);
  anchor?.setAttribute?.('aria-expanded', 'true');
  openPop = { node, anchor, outside, keys, onClose };
  const focusable = node.querySelector('button, input, select');
  focusable?.focus({ preventScroll: true });
  return { node, close, reposition: () => position(node, anchor, align) };
}

function position(node, anchor, align) {
  const nr = node.getBoundingClientRect();
  let x, y;
  if (anchor instanceof Element) {
    const r = anchor.getBoundingClientRect();
    x = align === 'end' ? r.right - nr.width : r.left;
    y = r.bottom + 6;
    if (y + nr.height > window.innerHeight - 8) y = Math.max(8, r.top - nr.height - 6);
  } else {
    x = anchor.x;
    y = anchor.y;
    if (y + nr.height > window.innerHeight - 8) y = Math.max(8, window.innerHeight - nr.height - 8);
  }
  x = Math.max(8, Math.min(window.innerWidth - nr.width - 8, x));
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
}

export function menuItem({ label, sub, key, iconName, active = false, disabled = false, danger = false, onClick }) {
  const btn = el('button', { class: `menu-item${active ? ' is-active' : ''}${danger ? ' btn-danger' : ''}`, disabled },
    iconName ? icon(iconName) : el('span', { class: 'mi-check' }, active ? '✓' : ''),
    el('span', { class: 'mi-main' }, label, sub ? el('span', { class: 'mi-sub' }, sub) : null),
    key ? el('span', { class: 'mi-key' }, key) : null);
  btn.addEventListener('click', () => onClick?.());
  return btn;
}

// ---- modals ------------------------------------------------------------------
let modalStack = [];

export function modal({ title, body, actions = [], wide = false, dismissable = true, onClose }) {
  const layer = $('#modal-layer');
  const box = el('div', { class: `modal${wide ? ' is-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const head = el('div', { class: 'modal-head' }, el('h2', {}, title));
  if (dismissable) {
    const x = el('button', { class: 'btn btn-ghost btn-icon', 'aria-label': 'Close' }, icon('close'));
    x.addEventListener('click', () => close());
    head.append(x);
  }
  const bodyNode = el('div', { class: 'modal-body' });
  const content = typeof body === 'function' ? body(() => close()) : body;
  if (content) bodyNode.append(content);
  const foot = el('div', { class: 'modal-foot' });
  const buttons = {};
  for (const a of actions) {
    const b = el('button', { class: `btn${a.primary ? ' btn-primary' : ''}${a.ghost ? ' btn-ghost' : ''}` }, a.label);
    b.addEventListener('click', async () => {
      if (a.onClick) {
        const keep = await a.onClick({ close, button: b });
        if (keep === true) return;
      }
      close();
    });
    buttons[a.id || a.label] = b;
    foot.append(b);
  }
  box.append(head, bodyNode);
  if (actions.length) box.append(foot);
  hydrateIcons(box);
  layer.replaceChildren(box);
  layer.hidden = false;
  const keys = (e) => {
    if (e.key === 'Escape' && dismissable) { e.stopPropagation(); close(); }
  };
  const backdrop = (e) => { if (e.target === layer && dismissable) close(); };
  document.addEventListener('keydown', keys, true);
  layer.addEventListener('mousedown', backdrop);
  const entry = { box, keys, backdrop };
  modalStack.push(entry);
  setTimeout(() => (box.querySelector('[autofocus]') || box.querySelector('.btn-primary') || box.querySelector('button'))?.focus(), 30);
  function close() {
    if (!modalStack.includes(entry)) return;
    modalStack = modalStack.filter((m) => m !== entry);
    document.removeEventListener('keydown', keys, true);
    layer.removeEventListener('mousedown', backdrop);
    box.remove();
    if (!modalStack.length) layer.hidden = true;
    onClose?.();
  }
  return { close, box, body: bodyNode, buttons };
}

export function modalIsOpen() { return modalStack.length > 0; }

export function confirmBox({ title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    modal({
      title,
      body: el('p', {}, message),
      actions: [
        { label: cancelLabel, ghost: true, onClick: () => { answered = true; resolve(false); } },
        { label: confirmLabel, primary: !danger, onClick: () => { answered = true; resolve(true); } },
      ],
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}

export function choiceBox({ title, message, choices }) {
  return new Promise((resolve) => {
    let answered = false;
    modal({
      title,
      body: el('p', {}, message),
      actions: choices.map((c) => ({ label: c.label, primary: c.primary, ghost: c.ghost, onClick: () => { answered = true; resolve(c.value); } })),
      onClose: () => { if (!answered) resolve(null); },
    });
  });
}
