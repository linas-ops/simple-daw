// The timeline: ruler, backing track, drum lanes, velocity and overview.
// Everything is drawn on canvases; lane names are regular HTML on the left.

import { Emitter, $, el, clamp, lowerBound, icon, setIcon, uid } from './util.js';
import { laneInfo, sortLanes, getMap, FAMILIES, isKitLane } from './drummap.js';
import { barDur, stepDur, stepBeats, snapTime, beatAt, timeAtBeat, tempoSegments, bpmAt, hasTempoChanges } from './state.js';

const MIN_PPS = 3;
const MAX_PPS = 1600;
const COLORS = {
  bg: '#23262f',
  bgAlt: '#272b35',
  bgBefore: '#1e2128',
  line: 'rgba(120,128,150,0.13)',
  beat: 'rgba(150,158,180,0.20)',
  bar: 'rgba(190,196,214,0.34)',
  laneLine: 'rgba(54,59,74,0.65)',
  familyLine: 'rgba(90,98,120,0.9)',
  head: '#ece7dc',
  dim: '#aeb1bd',
  faint: '#7a7f8f',
  brass: '#d9a65a',
  brassFill: 'rgba(217,166,90,0.12)',
  tally: '#f04a3e',
  select: 'rgba(236,231,220,0.95)',
};

// Highlight colours for marked hits (n.mk) and choked ones (n.ch).
export const MARK_STYLE = {
  cresc: { label: 'Crescendo', color: '#38d9f5' },
  dim: { label: 'Diminuendo', color: '#f472d0' },
  acc: { label: 'Accent', color: '#c5f04a' },
  ghost: { label: 'Ghost note', color: '#9ec5ff' },
  choke: { label: 'Choke', color: '#ff6b5c' },
};

export const markOf = (n) => (n.mk ? MARK_STYLE[n.mk] : n.ch > 0 ? MARK_STYLE.choke : null);

function cssFont(weight, size, family = '"Barlow Condensed", "Barlow", sans-serif') {
  return `${weight} ${size}px ${family}`;
}

export class Timeline extends Emitter {
  constructor(app) {
    super();
    this.app = app;
    this.store = app.store;
    this.audio = app.audio;
    this.cv = {
      ruler: $('#cv-ruler'),
      backing: $('#cv-backing'),
      grid: $('#cv-grid'),
      vel: $('#cv-vel'),
      overview: $('#cv-overview'),
    };
    this.g = {};
    for (const [k, c] of Object.entries(this.cv)) this.g[k] = c.getContext('2d');
    this.size = {};
    this.pps = 90;
    this.scrollX = -0.2;
    this.laneH = 30;
    this.lanes = [];
    this.laneIndex = new Map();
    this.selection = new Set();
    this.tool = 'select';
    this.snap = true;
    this.grid = '16';
    this.showAllLanes = false;
    this.showPercLanes = false;
    this.seenNotes = new Set();
    this.liveNotes = [];
    this.drag = null;
    this.hoverLane = -1;
    this.hoverNote = null;
    this.dirty = true;
    this.peaks = null;
    this.follow = true;
    this.clipboard = null;
    this.headsEl = $('#lane-heads');
    this.viewport = $('#lanes-viewport');
    this.lastLaneKey = '';
    this.lastPlayheadX = null;

    this.bind();
    const ro = new ResizeObserver(() => this.resize());
    for (const c of Object.values(this.cv)) ro.observe(c.parentElement);
    ro.observe(this.viewport);
    this.resize();
    this.rebuildLanes();
    requestAnimationFrame(() => this.frame());
  }

  // ---- geometry --------------------------------------------------------------
  get p() { return this.store.project; }
  t2x(t) { return (t - this.scrollX) * this.pps; }
  x2t(x) { return x / this.pps + this.scrollX; }
  get viewWidth() { return this.size.grid ? this.size.grid.w : 800; }
  get viewDuration() { return this.viewWidth / this.pps; }

  snapT(t, force = false) {
    if (!this.snap && !force) return t;
    return snapTime(this.p, t, this.grid);
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    for (const [k, c] of Object.entries(this.cv)) {
      const parent = c.parentElement;
      const w = parent.clientWidth;
      const h = k === 'grid' ? Math.max(this.lanes.length * this.laneH, this.viewport.clientHeight - 1) : parent.clientHeight;
      if (!w || !h) { this.size[k] = { w: w || 1, h: h || 1 }; continue; }
      if (k === 'grid') {
        parent.style.height = `${h}px`;
      }
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      this.g[k].setTransform(dpr, 0, 0, dpr, 0, 0);
      this.size[k] = { w, h };
    }
    this.dirty = true;
  }

  // ---- lanes -------------------------------------------------------------------
  computeLanes() {
    const p = this.p;
    const map = getMap(p.drumMap);
    const set = new Set(map.core);
    for (const n of this.store.notes) set.add(n.n);
    for (const n of this.liveNotes) set.add(n.n);
    for (const n of this.seenNotes) set.add(n);
    for (const n of map.notes.keys()) {
      const kitLane = isKitLane(p.drumMap, n);
      if ((kitLane && this.showAllLanes) || (!kitLane && this.showPercLanes)) set.add(n);
    }
    return sortLanes(p.drumMap, [...set]);
  }

  // What a lane is called and where its sound comes from (the app knows the kits).
  laneDisplay(note) {
    const info = laneInfo(this.p.drumMap, note);
    const d = this.app.laneDisplay ? this.app.laneDisplay(note) : null;
    return { label: info.label, source: null, silent: false, tip: null, ...(d || {}) };
  }

  rebuildLanes(force = false) {
    const lanes = this.computeLanes();
    const names = lanes.map((n) => { const d = this.laneDisplay(n); return `${d.label}/${d.source || ''}/${d.silent ? 1 : 0}/${d.take || 0}/${d.ring || 0}`; }).join(',');
    const key = `${this.p.drumMap}|${lanes.join(',')}|${this.p.mutes.join(',')}|${names}`;
    if (!force && key === this.lastLaneKey) return;
    this.lastLaneKey = key;
    this.lanes = lanes;
    this.laneIndex = new Map(lanes.map((n, i) => [n, i]));
    this.headsEl.replaceChildren();
    let prevFamily = null;
    lanes.forEach((note) => {
      const info = laneInfo(this.p.drumMap, note);
      const disp = this.laneDisplay(note);
      const label = disp.label;
      const muted = this.p.mutes.includes(note);
      const mute = el('button', {
        class: 'lane-btn',
        'aria-pressed': muted ? 'true' : 'false',
        'aria-label': muted ? `Unmute ${label}` : `Mute ${label}`,
        'data-tip': muted ? 'Unmute this drum' : 'Mute this drum',
      }, icon(muted ? 'muted' : 'speaker'));
      mute.addEventListener('click', (e) => {
        e.stopPropagation();
        this.app.toggleMute(note);
      });
      const more = el('button', {
        class: 'lane-btn lane-more',
        'aria-label': `More for ${label}`,
        'aria-haspopup': 'dialog',
        'data-tip': 'Sound, volume, and moving or copying its hits',
      }, icon('more'));
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        this.app.openLaneMenu?.(note, more);
      });
      const tip = disp.tip
        || (disp.silent ? `${label} (note ${note}). Nothing in your kits plays this drum yet. Right-click to give it a sound.`
          : `${label} (note ${note}). Click to hear it and select its hits. Right-click for more.`);
      const head = el('div', {
        class: `lane-head${info.family !== prevFamily ? ' family-start' : ''}${muted ? ' is-muted' : ''}${disp.silent ? ' is-silent' : ''}`,
        style: { '--c': info.color },
        'data-note': note,
        'data-tip': tip,
      },
      el('span', { class: 'flash' }),
      el('span', { class: 'lane-led' }),
      el('span', { class: 'lane-name' }, label),
      // Small tags for what you changed: borrowed sound, chosen variations, shorter ring.
      (disp.source || disp.take || disp.ring)
        ? el('span', { class: 'lane-src' }, [disp.source, disp.take ? `v${disp.take}` : null, disp.ring ? `${disp.ring}s` : null].filter(Boolean).join(' '))
        : el('span', { class: 'lane-note' }, String(note)),
      more,
      mute);
      head.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.app.openLaneMenu?.(note, { x: e.clientX, y: e.clientY });
      });
      head.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || e.target.closest('.lane-btn')) return;
        this.audio.audition(note, 100);
        this.flash(note, 100);
        const ids = this.store.notes.filter((n) => n.n === note).map((n) => n.id);
        if (!e.shiftKey && !e.ctrlKey) this.selection.clear();
        for (const id of ids) this.selection.add(id);
        this.emitSelection();
        this.dirty = true;
      });
      this.headsEl.append(head);
      prevFamily = info.family;
    });
    if (this.app.hydrateTips) this.app.hydrateTips(this.headsEl);
    this.resize();
  }

  flash(note, vel) {
    if (!this.laneIndex.has(note)) {
      this.seenNotes.add(note);
      this.rebuildLanes();
    }
    const head = this.headsEl.querySelector(`.lane-head[data-note="${note}"]`);
    if (!head) return;
    const led = head.querySelector('.lane-led');
    const fl = head.querySelector('.flash');
    led.classList.add('is-hit');
    const strength = 0.12 + 0.3 * (vel / 127);
    fl.animate([{ opacity: strength }, { opacity: 0 }], { duration: 380, easing: 'ease-out' });
    clearTimeout(head._t);
    head._t = setTimeout(() => led.classList.remove('is-hit'), 140);
  }

  // ---- view control --------------------------------------------------------------
  setZoom(pps, anchorX = this.viewWidth * 0.3) {
    const t = this.x2t(anchorX);
    this.pps = clamp(pps, MIN_PPS, MAX_PPS);
    this.scrollX = t - anchorX / this.pps;
    this.clampScroll();
    this.dirty = true;
    this.emit('zoom', this.pps);
  }

  zoomBy(factor, anchorX) { this.setZoom(this.pps * factor, anchorX); }

  zoomSliderValue() {
    return Math.round((Math.log(this.pps / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS)) * 100);
  }

  setZoomFromSlider(v) {
    const pps = MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, v / 100);
    const anchor = clamp(this.t2x(this.audio.position), 0, this.viewWidth);
    this.setZoom(pps, anchor);
  }

  clampScroll() {
    const max = Math.max(this.contentEnd() - this.viewDuration * 0.5, 0);
    this.scrollX = clamp(this.scrollX, -0.6 * this.viewDuration * 0.1 - 0.5, max + 0.5);
  }

  contentEnd() {
    return Math.max(this.audio.songEnd(), barDur(this.p) * 8, this.audio.position + 4);
  }

  fit() {
    const end = Math.max(this.store.lastNoteTime() + 1, this.audio.backingBuffer ? (this.p.backing?.offset || 0) + this.audio.backingBuffer.duration : 0, barDur(this.p) * 4);
    this.pps = clamp((this.viewWidth - 40) / (end + 0.5), MIN_PPS, MAX_PPS);
    this.scrollX = -0.25;
    this.dirty = true;
    this.emit('zoom', this.pps);
  }

  reveal(t) {
    const x = this.t2x(t);
    if (x < 20 || x > this.viewWidth - 40) {
      this.scrollX = t - (this.viewWidth * 0.15) / this.pps;
      this.dirty = true;
    }
  }

  // ---- selection & editing helpers ------------------------------------------------
  emitSelection() { this.emit('selection', this.selection.size); }

  selectedNotes() {
    if (!this.selection.size) return [];
    return this.store.notes.filter((n) => this.selection.has(n.id));
  }

  targetNotes() {
    const sel = this.selectedNotes();
    return sel.length ? sel : this.store.notes;
  }

  pruneSelection() {
    const ids = new Set(this.store.notes.map((n) => n.id));
    for (const id of [...this.selection]) if (!ids.has(id)) this.selection.delete(id);
    this.emitSelection();
  }

  selectAll() {
    for (const n of this.store.notes) this.selection.add(n.id);
    this.emitSelection();
    this.dirty = true;
  }

  clearSelection() {
    if (!this.selection.size) return;
    this.selection.clear();
    this.emitSelection();
    this.dirty = true;
  }

  addNote(t, note, vel = 100) {
    const n = { id: uid(), t: Math.max(0, t), n: note, v: vel };
    this.store.take.notes.push(n);
    return n;
  }

  findNote(t, note, tolerance) {
    const notes = this.store.notes;
    for (let i = lowerBound(notes, t - tolerance); i < notes.length && notes[i].t <= t + tolerance; i++) {
      if (notes[i].n === note) return notes[i];
    }
    return null;
  }

  deleteSelection() {
    if (!this.selection.size) return 0;
    const count = this.selection.size;
    this.store.edit(count === 1 ? 'Delete hit' : `Delete ${count} hits`, (p, take) => {
      take.notes = take.notes.filter((n) => !this.selection.has(n.id));
    });
    this.selection.clear();
    this.emitSelection();
    return count;
  }

  nudge(dir) {
    const sel = this.selectedNotes();
    if (!sel.length) return;
    const p = this.p;
    const step = stepBeats(p, this.grid);
    this.store.edit('Nudge hits', () => {
      for (const n of sel) n.t = Math.max(0, this.snap ? timeAtBeat(p, beatAt(p, n.t) + dir * step) : n.t + dir * 0.005);
    });
  }

  moveLanes(dir) {
    const sel = this.selectedNotes();
    if (!sel.length) return;
    this.store.edit('Move hits to another drum', () => {
      for (const n of sel) {
        const idx = this.laneIndex.get(n.n);
        if (idx === undefined) continue;
        n.n = this.lanes[clamp(idx + dir, 0, this.lanes.length - 1)];
      }
    });
  }

  /**
   * Move, copy or swap hits between drums.
   * from: a lane note, or null to use the selected hits (any lanes).
   * mode: 'move' | 'copy' | 'swap'. onlySelected: limit to selected hits of `from`.
   * Hits that end up on top of one another in the target drum become one.
   */
  transferHits(from, to, mode, { onlySelected = false } = {}) {
    if (from === to) return 0;
    const sel = this.selection;
    const pick = (n) => (from === null ? sel.has(n.id) : n.n === from && (!onlySelected || sel.has(n.id)));
    let count = 0;
    const copies = [];
    const label = { move: 'Move hits to another drum', copy: 'Copy hits to another drum', swap: 'Swap two drums' }[mode] || 'Move hits';
    this.store.edit(label, (p, take) => {
      if (mode === 'swap') {
        for (const n of take.notes) {
          if (n.n === from) { n.n = to; count++; } else if (n.n === to) { n.n = from; count++; }
        }
        return;
      }
      const chosen = take.notes.filter(pick);
      count = chosen.length;
      if (mode === 'copy') {
        for (const n of chosen) {
          const c = { id: uid(), t: n.t, n: to, v: n.v };
          if (n.ch) c.ch = n.ch;
          if (n.mk) c.mk = n.mk;
          take.notes.push(c);
          copies.push(c.id);
        }
      } else {
        for (const n of chosen) n.n = to;
      }
      take.notes.sort((a, b) => a.t - b.t || a.n - b.n);
      const keep = [];
      let prev = null;
      for (const n of take.notes) {
        if (n.n === to) {
          if (prev && n.t - prev.t < 0.003) { prev.v = Math.max(prev.v, n.v); continue; }
          prev = n;
        }
        keep.push(n);
      }
      take.notes = keep;
    });
    if (mode === 'copy' && copies.length) {
      const alive = new Set(this.store.notes.map((n) => n.id));
      this.selection = new Set(copies.filter((id) => alive.has(id)));
    }
    this.pruneSelection();
    this.rebuildLanes();
    this.dirty = true;
    return count;
  }

  // The clipboard keeps beats, so a part pasted where the tempo differs stays in time.
  copy() {
    const sel = this.selectedNotes();
    if (!sel.length) return 0;
    const p = this.p;
    const b0 = beatAt(p, Math.min(...sel.map((n) => n.t)));
    this.clipboard = sel.map((n) => ({ b: beatAt(p, n.t) - b0, n: n.n, v: n.v, ch: n.ch || 0, mk: n.mk || null }));
    return sel.length;
  }

  paste(at) {
    if (!this.clipboard?.length) return 0;
    const p = this.p;
    const start = beatAt(p, this.snapT(at));
    const added = [];
    this.store.edit('Paste hits', () => {
      for (const c of this.clipboard) {
        const n = this.addNote(timeAtBeat(p, start + c.b), c.n, c.v);
        if (c.ch) n.ch = c.ch;
        if (c.mk) n.mk = c.mk;
        added.push(n);
      }
    });
    this.selection = new Set(added.map((n) => n.id));
    this.emitSelection();
    return added.length;
  }

  duplicate() {
    const sel = this.selectedNotes();
    if (!sel.length) return 0;
    const p = this.p;
    const b0 = beatAt(p, Math.min(...sel.map((n) => n.t)));
    const b1 = beatAt(p, Math.max(...sel.map((n) => n.t)));
    const shift = Math.max(1, Math.ceil((b1 - b0 + 1e-3) / p.sig[0])) * p.sig[0];
    const added = [];
    this.store.edit('Duplicate hits', () => {
      for (const n of sel) {
        const c = this.addNote(timeAtBeat(p, beatAt(p, n.t) + shift), n.n, n.v);
        if (n.ch) c.ch = n.ch;
        if (n.mk) c.mk = n.mk;
        added.push(c);
      }
    });
    this.selection = new Set(added.map((n) => n.id));
    this.emitSelection();
    this.reveal(timeAtBeat(p, b0 + shift));
    return added.length;
  }

  quantize({ strength = 1, grid = this.grid } = {}) {
    const targets = this.targetNotes();
    if (!targets.length) return 0;
    const ids = new Set(targets.map((n) => n.id));
    this.store.edit('Quantize', (p, take) => {
      for (const n of targets) {
        const s = snapTime(p, n.t, grid);
        n.t = Math.max(0, n.t + (s - n.t) * strength);
      }
      // Two hits of the same drum landing on the same spot become one.
      take.notes.sort((a, b) => a.t - b.t || a.n - b.n);
      const keep = [];
      for (const n of take.notes) {
        const prev = keep.length ? keep[keep.length - 1] : null;
        const dupe = prev && prev.n === n.n && Math.abs(prev.t - n.t) < 0.002 && (ids.has(n.id) || ids.has(prev.id));
        if (dupe) { prev.v = Math.max(prev.v, n.v); if (n.ch && !prev.ch) prev.ch = n.ch; if (n.mk && !prev.mk) prev.mk = n.mk; continue; }
        keep.push(n);
      }
      take.notes = keep;
    });
    this.pruneSelection();
    return targets.length;
  }

  // Small random changes in timing and velocity. Accents, ghost notes, crescendos,
  // diminuendos and choked hits are left as they are. Returns {changed, kept}.
  humanize({ timingMs = 8, velocity = 8 } = {}) {
    const all = this.targetNotes();
    const targets = all.filter((n) => !markOf(n));
    const kept = all.length - targets.length;
    if (!targets.length) return { changed: 0, kept };
    const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
    this.store.edit('Humanize', () => {
      for (const n of targets) {
        n.t = Math.max(0, n.t + (gauss() * timingMs) / 1000);
        n.v = clamp(Math.round(n.v + gauss() * velocity), 1, 127);
      }
    });
    return { changed: targets.length, kept };
  }

  changeVelocity(fn, label = 'Change velocity') {
    const targets = this.targetNotes();
    if (!targets.length) return 0;
    this.store.edit(label, () => {
      for (const n of targets) n.v = clamp(Math.round(fn(n.v)), 1, 127);
    });
    return targets.length;
  }

  // ---- hit testing -----------------------------------------------------------------
  hitWidth() { return clamp(this.pps * 0.035, 3, 9); }

  noteAt(x, y) {
    const lane = Math.floor(y / this.laneH);
    const note = this.lanes[lane];
    if (note === undefined) return null;
    const tol = (this.hitWidth() / 2 + 4) / this.pps;
    const t = this.x2t(x);
    const notes = this.store.notes;
    let best = null;
    let bestD = Infinity;
    for (let i = lowerBound(notes, t - tol); i < notes.length && notes[i].t <= t + tol; i++) {
      const n = notes[i];
      if (n.n !== note) continue;
      const d = Math.abs(n.t - t);
      if (d < bestD) { best = n; bestD = d; }
    }
    return best;
  }

  // The end of a choke line (where the cymbal is grabbed) near this point, or null.
  chokeAt(x, y) {
    const note = this.lanes[Math.floor(y / this.laneH)];
    if (note === undefined) return null;
    const t = this.x2t(x);
    const notes = this.store.notes;
    for (let i = lowerBound(notes, t - 16); i < notes.length && notes[i].t <= t; i++) {
      const n = notes[i];
      if (n.n === note && n.ch > 0 && Math.abs(this.t2x(n.t + n.ch) - x) <= 5) return n;
    }
    return null;
  }

  local(e, canvas) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ---- events ------------------------------------------------------------------------
  bind() {
    const grid = this.cv.grid;
    grid.addEventListener('mousedown', (e) => this.onGridDown(e));
    grid.addEventListener('mousemove', (e) => this.onGridHover(e));
    grid.addEventListener('mouseleave', () => { this.hoverLane = -1; this.hoverNote = null; this.dirty = true; this.emit('hint', null); });
    grid.addEventListener('contextmenu', (e) => { e.preventDefault(); this.app.openGridMenu(e, this.noteAt(...Object.values(this.local(e, grid)))); });
    this.cv.ruler.addEventListener('mousedown', (e) => this.onRulerDown(e));
    this.cv.ruler.addEventListener('dblclick', (e) => {
      if (this.tempoMarkAt(this.local(e, this.cv.ruler).x)) return;
      if (this.p.loop.on || this.p.loop.end > this.p.loop.start) this.app.setLoop(false);
    });
    this.cv.ruler.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.app.openRulerMenu?.(e, this.x2t(this.local(e, this.cv.ruler).x));
    });
    this.cv.ruler.addEventListener('mousemove', (e) => {
      const { x } = this.local(e, this.cv.ruler);
      const mark = this.tempoMarkAt(x);
      this.emit('hint', mark
        ? 'Tempo change. Click to change or remove it.'
        : 'Click to move the playhead. Drag to mark a part to loop. Right-click to change the tempo from a bar.');
      const L = this.p.loop;
      const nearEdge = L.end > L.start && (Math.abs(x - this.t2x(L.start)) < 6 || Math.abs(x - this.t2x(L.end)) < 6);
      this.cv.ruler.style.cursor = nearEdge ? 'ew-resize' : 'pointer';
    });
    this.cv.backing.addEventListener('mousedown', (e) => this.onBackingDown(e));
    this.cv.backing.addEventListener('mousemove', () => this.emit('hint', 'Drag the backing track left or right to line it up with your drums.'));
    this.cv.vel.addEventListener('mousedown', (e) => this.onVelDown(e));
    this.cv.vel.addEventListener('mousemove', () => this.emit('hint', 'Drag up or down over hits to make them louder or softer. Select hits first to change only those.'));
    this.cv.overview.addEventListener('mousedown', (e) => this.onOverviewDown(e));
    this.cv.overview.addEventListener('mousemove', () => this.emit('hint', 'The whole song. Drag the frame to move around.'));
    for (const c of Object.values(this.cv)) c.addEventListener('wheel', (e) => this.onWheel(e, c), { passive: false });
    window.addEventListener('mousemove', (e) => this.onDragMove(e));
    window.addEventListener('mouseup', (e) => this.onDragEnd(e));
  }

  onWheel(e, canvas) {
    const { x } = this.local(e, canvas);
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      this.zoomBy(Math.exp(-e.deltaY * 0.0022), canvas === this.cv.overview ? this.viewWidth / 2 : x);
      return;
    }
    if (e.shiftKey && canvas === this.cv.grid) {
      e.preventDefault();
      this.viewport.scrollTop += e.deltaY;
      return;
    }
    e.preventDefault();
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    this.scrollX += (delta * (e.deltaMode === 1 ? 16 : 1)) / this.pps;
    this.clampScroll();
    this.follow = false;
    clearTimeout(this._followTimer);
    this._followTimer = setTimeout(() => { this.follow = true; }, 2500);
    this.dirty = true;
  }

  onGridHover(e) {
    if (this.drag) return;
    const { x, y } = this.local(e, this.cv.grid);
    const lane = Math.floor(y / this.laneH);
    if (this.tool === 'select' && this.chokeAt(x, y)) {
      this.emit('hint', 'Choke: here a hand grabs the cymbal. Drag to change when. Drag it onto the hit to remove it.');
      this.cv.grid.style.cursor = 'ew-resize';
      return;
    }
    const note = this.noteAt(x, y);
    if (lane !== this.hoverLane || note !== this.hoverNote) {
      this.hoverLane = lane;
      this.hoverNote = note;
      this.dirty = true;
    }
    const mark = note ? markOf(note) : null;
    if (this.tool === 'draw') this.emit('hint', note ? 'Click to remove this hit.' : 'Click to add a hit. Drag along a lane to add several.');
    else if (mark) this.emit('hint', `${mark.label}: Humanize leaves this hit alone. Right-click to remove the mark. Drag to move.`);
    else this.emit('hint', note ? 'Drag to move. Double-click to delete. Ctrl-click to add to the selection.' : 'Double-click to add a hit. Drag to select several hits. Right-click for more.');
    this.cv.grid.style.cursor = this.tool === 'draw' ? 'crosshair' : note ? 'grab' : 'default';
  }

  onGridDown(e) {
    if (e.button !== 0) return;
    this.cv.grid.focus({ preventScroll: true });
    const { x, y } = this.local(e, this.cv.grid);
    const laneIdx = clamp(Math.floor(y / this.laneH), 0, this.lanes.length - 1);
    const lane = this.lanes[laneIdx];
    const hit = this.noteAt(x, y);
    const t = this.x2t(x);
    if (this.tool === 'draw') {
      this.store.beginGesture();
      if (hit) {
        const take = this.store.take;
        take.notes = take.notes.filter((n) => n.id !== hit.id);
        this.selection.delete(hit.id);
        this.drag = { type: 'erase', lane };
      } else {
        const st = this.snapT(t);
        this.addNote(st, lane, this.app.drawVelocity());
        this.store.sortNotes();
        this.audio.audition(lane, this.app.drawVelocity());
        this.drag = { type: 'paint', lane, last: st };
      }
      this.dirty = true;
      return;
    }
    const choked = this.chokeAt(x, y);
    if (choked && e.detail !== 2) {
      this.store.beginGesture();
      this.drag = { type: 'choke', note: choked };
      return;
    }
    if (e.detail === 2) {
      if (hit) {
        this.store.edit('Delete hit', (p, take) => { take.notes = take.notes.filter((n) => n.id !== hit.id); });
        this.selection.delete(hit.id);
      } else {
        let added;
        this.store.edit('Add hit', () => { added = this.addNote(this.snapT(t), lane, this.app.drawVelocity()); });
        this.audio.audition(lane, this.app.drawVelocity());
        this.selection = new Set([added.id]);
      }
      this.emitSelection();
      this.drag = null;
      return;
    }
    if (hit) {
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        if (this.selection.has(hit.id)) this.selection.delete(hit.id); else this.selection.add(hit.id);
      } else if (!this.selection.has(hit.id)) {
        this.selection = new Set([hit.id]);
      }
      this.emitSelection();
      this.audio.audition(hit.n, hit.v);
      this.flash(hit.n, hit.v);
      const orig = new Map(this.selectedNotes().map((n) => [n.id, { t: n.t, lane: this.laneIndex.get(n.n) ?? 0, n: n.n }]));
      this.drag = { type: 'move', x0: x, y0: y, lane0: laneIdx, anchor: hit, anchorT: hit.t, orig, moved: false };
    } else {
      if (!(e.shiftKey || e.ctrlKey || e.metaKey)) this.selection.clear();
      this.drag = { type: 'band', x0: x, y0: y, x1: x, y1: y, base: new Set(this.selection) };
      this.emitSelection();
    }
    this.dirty = true;
  }

  tempoMarkAt(x) {
    return (this.tempoMarks || []).find((m) => x >= m.x0 - 2 && x <= m.x1 + 2) || null;
  }

  onRulerDown(e) {
    if (e.button !== 0) return;
    const { x } = this.local(e, this.cv.ruler);
    const mark = this.tempoMarkAt(x);
    if (mark) {
      this.app.openTempoChanges?.({ x: e.clientX, y: e.clientY + 8 }, mark.beat);
      return;
    }
    const L = this.p.loop;
    if (L.end > L.start) {
      if (Math.abs(x - this.t2x(L.start)) < 6) { this.store.beginGesture(); this.drag = { type: 'loop-edge', edge: 'start' }; return; }
      if (Math.abs(x - this.t2x(L.end)) < 6) { this.store.beginGesture(); this.drag = { type: 'loop-edge', edge: 'end' }; return; }
    }
    this.drag = { type: 'ruler', x0: x, t0: this.x2t(x), moved: false };
  }

  onBackingDown(e) {
    if (e.button !== 0 || !this.p.backing) return;
    const { x } = this.local(e, this.cv.backing);
    this.store.beginGesture();
    this.drag = { type: 'backing', x0: x, orig: this.p.backing.offset || 0 };
    this.cv.backing.style.cursor = 'grabbing';
  }

  onVelDown(e) {
    if (e.button !== 0) return;
    this.store.beginGesture();
    this.drag = { type: 'vel' };
    this.onDragMove(e);
  }

  onOverviewDown(e) {
    if (e.button !== 0) return;
    const { x } = this.local(e, this.cv.overview);
    const w = this.size.overview.w;
    const total = this.overviewSpan();
    const winX = (this.scrollX / total) * w;
    const winW = (this.viewDuration / total) * w;
    if (x < winX || x > winX + winW) {
      this.scrollX = (x / w) * total - this.viewDuration / 2;
      this.clampScroll();
    }
    this.drag = { type: 'overview', x0: x, orig: this.scrollX };
    this.follow = false;
    this.dirty = true;
  }

  onDragMove(e) {
    const d = this.drag;
    if (!d) return;
    const p = this.p;
    if (d.type === 'choke') {
      const { x } = this.local(e, this.cv.grid);
      const n = d.note;
      let t = this.x2t(x);
      if (this.snap && !e.altKey) t = this.snapT(t, true);
      n.ch = Math.max(0, t - n.t);
      this.emit('hint', n.ch < 0.03 ? 'Let go here to remove the choke.' : 'Choke: when a hand grabs the cymbal. Hold Alt to move it freely.');
      this.dirty = true;
    } else if (d.type === 'move') {
      const { x, y } = this.local(e, this.cv.grid);
      if (!d.moved && Math.hypot(x - d.x0, y - d.y0) < 4) return;
      if (!d.moved) { this.store.beginGesture(); d.moved = true; this.cv.grid.classList.add('is-dragging'); }
      let dt = (x - d.x0) / this.pps;
      if (this.snap && !e.altKey) dt = this.snapT(d.anchorT + dt, true) - d.anchorT;
      // Move by beats, so hits keep their place in the bar where the tempo changes.
      const db = beatAt(p, d.anchorT + dt) - beatAt(p, d.anchorT);
      const laneNow = clamp(Math.floor(y / this.laneH), 0, this.lanes.length - 1);
      const dl = laneNow - d.lane0;
      for (const n of this.store.notes) {
        const o = d.orig.get(n.id);
        if (!o) continue;
        n.t = Math.max(0, hasTempoChanges(p) ? timeAtBeat(p, beatAt(p, o.t) + db) : o.t + dt);
        n.n = dl ? this.lanes[clamp(o.lane + dl, 0, this.lanes.length - 1)] : o.n;
      }
      this.store.sortNotes();
      this.emit('hint', `Moving ${d.orig.size} hit${d.orig.size === 1 ? '' : 's'}. Hold Alt to move freely without the grid.`);
      this.dirty = true;
    } else if (d.type === 'band') {
      const { x, y } = this.local(e, this.cv.grid);
      d.x1 = x; d.y1 = y;
      const ta = this.x2t(Math.min(d.x0, x));
      const tb = this.x2t(Math.max(d.x0, x));
      const la = Math.floor(Math.min(d.y0, y) / this.laneH);
      const lb = Math.floor(Math.max(d.y0, y) / this.laneH);
      const sel = new Set(d.base);
      for (const n of this.store.notesInRange(ta, tb)) {
        const li = this.laneIndex.get(n.n);
        if (li >= la && li <= lb) sel.add(n.id);
      }
      this.selection = sel;
      this.emitSelection();
      this.dirty = true;
    } else if (d.type === 'paint') {
      const { x, y } = this.local(e, this.cv.grid);
      const laneNow = this.lanes[clamp(Math.floor(y / this.laneH), 0, this.lanes.length - 1)];
      if (laneNow !== d.lane) return;
      const st = this.snapT(this.x2t(x), true);
      if (Math.abs(st - d.last) < 1e-6) return;
      d.last = st;
      if (!this.findNote(st, d.lane, stepDur(p, this.grid, st) * 0.45)) {
        this.addNote(st, d.lane, this.app.drawVelocity());
        this.store.sortNotes();
        this.dirty = true;
      }
    } else if (d.type === 'erase') {
      const { x, y } = this.local(e, this.cv.grid);
      const hit = this.noteAt(x, y);
      if (hit) {
        const take = this.store.take;
        take.notes = take.notes.filter((n) => n.id !== hit.id);
        this.dirty = true;
      }
    } else if (d.type === 'ruler') {
      const { x } = this.local(e, this.cv.ruler);
      if (!d.moved && Math.abs(x - d.x0) < 4) return;
      if (!d.moved) { d.moved = true; this.store.beginGesture(); }
      const a = this.snapT(d.t0, true);
      const b = this.snapT(this.x2t(x), true);
      p.loop = { on: true, start: Math.max(0, Math.min(a, b)), end: Math.max(a, b) };
      this.app.syncLoopButton();
      this.dirty = true;
    } else if (d.type === 'loop-edge') {
      const { x } = this.local(e, this.cv.ruler);
      const t = Math.max(0, this.snapT(this.x2t(x), true));
      if (d.edge === 'start') p.loop.start = Math.min(t, p.loop.end - 0.05);
      else p.loop.end = Math.max(t, p.loop.start + 0.05);
      this.dirty = true;
    } else if (d.type === 'backing') {
      const { x } = this.local(e, this.cv.backing);
      p.backing.offset = d.orig + (x - d.x0) / this.pps;
      this.dirty = true;
    } else if (d.type === 'vel') {
      const { x, y } = this.local(e, this.cv.vel);
      const h = this.size.vel.h;
      const v = clamp(Math.round(((h - 4 - y) / (h - 10)) * 127), 1, 127);
      const tol = (this.hitWidth() / 2 + 3) / this.pps;
      const t = this.x2t(x);
      const restrict = this.selection.size > 0;
      for (const n of this.store.notesInRange(t - tol, t + tol)) {
        if (restrict && !this.selection.has(n.id)) continue;
        n.v = v;
      }
      this.emit('hint', `Velocity ${v}`);
      this.dirty = true;
    } else if (d.type === 'overview') {
      const { x } = this.local(e, this.cv.overview);
      this.scrollX = d.orig + ((x - d.x0) / this.size.overview.w) * this.overviewSpan();
      this.clampScroll();
      this.dirty = true;
    }
  }

  onDragEnd() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.emit('hint', null);
    this.cv.grid.classList.remove('is-dragging');
    this.cv.backing.style.cursor = '';
    if (d.type === 'choke') {
      const removed = !(d.note.ch >= 0.03);
      if (removed) delete d.note.ch;
      this.store.endGesture(removed ? 'Remove choke' : 'Move choke');
    } else if (d.type === 'move' && d.moved) {
      const n = d.orig.size;
      this.store.endGesture(n === 1 ? 'Move hit' : `Move ${n} hits`);
    } else if (d.type === 'paint') {
      this.store.endGesture('Draw hits');
    } else if (d.type === 'erase') {
      this.store.endGesture('Remove hits');
      this.pruneSelection();
    } else if (d.type === 'ruler') {
      if (d.moved) {
        const L = this.p.loop;
        if (L.end - L.start < 0.05) L.on = false;
        this.store.endGesture('Set loop');
        this.app.syncLoopButton();
        this.audio.seek(L.start);
      } else {
        this.audio.seek(Math.max(0, this.snapT(d.t0)));
      }
    } else if (d.type === 'loop-edge') {
      this.store.endGesture('Change loop');
    } else if (d.type === 'backing') {
      this.store.endGesture('Move backing track');
    } else if (d.type === 'vel') {
      this.store.endGesture('Change velocity');
    } else if (d.type === 'overview') {
      setTimeout(() => { this.follow = true; }, 1500);
    }
    this.dirty = true;
  }

  overviewSpan() {
    return Math.max(this.contentEnd() + 2, this.scrollX + this.viewDuration);
  }

  setBackingPeaks(peaks) {
    this.peaks = peaks;
    this.dirty = true;
  }

  // ---- drawing ----------------------------------------------------------------------
  frame() {
    const playing = this.audio.isPlaying;
    const pos = this.audio.position;
    if (playing) {
      const x = this.t2x(pos);
      if (this.follow && !this.drag) {
        if (x > this.viewWidth * 0.86 || x < 0) {
          this.scrollX = pos - (this.viewWidth * 0.12) / this.pps;
          this.dirty = true;
        }
      }
      if (x !== this.lastPlayheadX) this.dirty = true;
    }
    if (this.dirty) {
      this.dirty = false;
      this.lastPlayheadX = this.t2x(pos);
      this.drawRuler(pos);
      if (this.p.backing) this.drawBacking(pos);
      this.drawGrid(pos);
      this.drawVel(pos);
      this.drawOverview(pos);
    }
    requestAnimationFrame(() => this.frame());
  }

  // Bars, beats and grid steps in view: cb(kind, time, bar index from 0, labeled, bar end).
  gridLines(w, cb) {
    const p = this.p;
    const segs = tempoSegments(p);
    const t0 = this.x2t(0);
    const t1 = this.x2t(w);
    const per = p.sig[0];
    const stepB = stepBeats(p, this.grid);
    // How dense the lines can be, judged by the fastest tempo in view.
    let bpm = bpmAt(p, t0);
    for (const s of segs) if (s.t > t0 && s.t < t1) bpm = Math.max(bpm, s.bpm);
    const beatPx = (60 / bpm) * this.pps;
    let barEvery = 1;
    while (beatPx * per * barEvery < 34) barEvery *= 2;
    const showBeats = beatPx >= 6;
    const showSteps = stepB * beatPx >= 8 && stepB < 1 - 1e-9;
    const firstBar = Math.floor(beatAt(p, t0, segs) / per) - 1;
    const lastBar = Math.ceil(beatAt(p, t1, segs) / per) + 1;
    for (let b = firstBar; b <= lastBar; b++) {
      const bt = timeAtBeat(p, b * per, segs);
      cb('barStart', bt, b, b % barEvery === 0, timeAtBeat(p, (b + 1) * per, segs));
      if (showSteps) {
        const n = Math.round(per / stepB);
        for (let k = 1; k < n; k++) {
          const pos = k * stepB;
          const isBeat = Math.abs(pos - Math.round(pos)) < 1e-6;
          cb(isBeat && showBeats ? 'beat' : 'step', timeAtBeat(p, b * per + pos, segs), b);
        }
      } else if (showBeats) {
        for (let k = 1; k < per; k++) cb('beat', timeAtBeat(p, b * per + k, segs), b);
      }
    }
    return barEvery;
  }

  drawRuler(pos) {
    const g = this.g.ruler;
    const { w, h } = this.size.ruler;
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#2a2e39';
    g.fillRect(0, 0, w, h);
    const p = this.p;
    const L = p.loop;
    if (L.end > L.start) {
      const x0 = this.t2x(L.start);
      const x1 = this.t2x(L.end);
      g.fillStyle = L.on ? 'rgba(217,166,90,0.32)' : 'rgba(217,166,90,0.12)';
      g.fillRect(x0, 3, x1 - x0, h - 6);
      g.fillStyle = L.on ? COLORS.brass : 'rgba(217,166,90,0.5)';
      g.fillRect(x0 - 1, 3, 3, h - 6);
      g.fillRect(x1 - 2, 3, 3, h - 6);
    }
    g.font = cssFont(600, 13);
    g.textBaseline = 'middle';
    const labelEnd = new Map(); // bar index -> x where its number ends
    this.gridLines(w, (kind, t, bar, labeled) => {
      const x = Math.round(this.t2x(t)) + 0.5;
      if (x < -40 || x > w + 40) return;
      if (kind === 'barStart') {
        if (bar < 0) return;
        g.strokeStyle = labeled ? 'rgba(190,196,214,0.55)' : 'rgba(190,196,214,0.25)';
        g.beginPath(); g.moveTo(x, labeled ? 6 : 16); g.lineTo(x, h); g.stroke();
        if (labeled) {
          const label = String(bar + 1);
          g.fillStyle = COLORS.dim;
          g.fillText(label, x + 4, h / 2 - 1);
          labelEnd.set(bar, x + 4 + g.measureText(label).width);
        }
      } else if (kind === 'beat' && bar >= 0) {
        g.strokeStyle = 'rgba(150,158,180,0.35)';
        g.beginPath(); g.moveTo(x, h - 8); g.lineTo(x, h); g.stroke();
      }
    });
    // Tempo changes: a brass tag after the bar number, starting tempo included.
    this.tempoMarks = [];
    if (hasTempoChanges(p)) {
      g.font = cssFont(700, 11);
      for (const seg of tempoSegments(p)) {
        const x = Math.round(this.t2x(seg.t)) + 0.5;
        if (x < -60 || x > w + 10) continue;
        const bar = Math.round(seg.beat / p.sig[0]);
        const onBar = Math.abs(seg.beat - bar * p.sig[0]) < 1e-6;
        const left = onBar && labelEnd.has(bar) ? labelEnd.get(bar) + 5 : x + 4;
        const text = `${Math.round(seg.bpm * 10) / 10}`;
        const tw = g.measureText(text).width + 12;
        g.fillStyle = 'rgba(217,166,90,0.18)';
        roundRect(g, left, 4, tw, h - 9, 3);
        g.fill();
        g.fillStyle = COLORS.brass;
        g.fillRect(x - 0.5, 2, 2, h - 4);
        g.beginPath(); g.moveTo(left + 4, h / 2 - 5); g.lineTo(left + 4, h / 2 + 4); g.lineTo(left + 8, h / 2 - 0.5); g.closePath();
        g.fill();
        g.fillText(text, left + 10, h / 2 - 1);
        this.tempoMarks.push({ x0: Math.min(x, left), x1: left + tw, beat: seg.beat });
      }
    }
    // playhead marker
    const px = this.t2x(pos);
    if (px >= -8 && px <= w + 8) {
      g.fillStyle = this.audio.isRecording ? COLORS.tally : COLORS.head;
      g.beginPath();
      g.moveTo(px - 6, 0); g.lineTo(px + 6, 0); g.lineTo(px, 9); g.closePath();
      g.fill();
      g.fillRect(px - 0.75, 0, 1.5, h);
    }
    g.fillStyle = 'rgba(54,59,74,1)';
    g.fillRect(0, h - 1, w, 1);
  }

  drawBacking(pos) {
    const g = this.g.backing;
    const { w, h } = this.size.backing;
    g.clearRect(0, 0, w, h);
    this.paintBackdrop(g, w, h, false);
    const b = this.p.backing;
    const pk = this.peaks;
    if (b && pk) {
      const offset = b.offset || 0;
      const x0 = this.t2x(offset);
      const x1 = this.t2x(offset + pk.duration);
      g.fillStyle = b.muted ? 'rgba(143,151,173,0.08)' : 'rgba(143,151,173,0.16)';
      g.fillRect(Math.max(0, x0), 4, Math.min(w, x1) - Math.max(0, x0), h - 8);
      g.fillStyle = b.muted ? 'rgba(143,151,173,0.35)' : 'rgba(176,184,204,0.85)';
      const mid = h / 2;
      const amp = (h - 12) / 2;
      const secPerPeak = pk.samplesPerPeak / pk.sampleRate;
      const count = pk.peaks.length / 2;
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, x1); x++) {
        const ta = this.x2t(x) - offset;
        const tb = this.x2t(x + 1) - offset;
        let i0 = Math.floor(ta / secPerPeak);
        let i1 = Math.max(i0 + 1, Math.floor(tb / secPerPeak));
        i0 = clamp(i0, 0, count - 1); i1 = clamp(i1, 0, count);
        let lo = 0, hi = 0;
        for (let i = i0; i < i1; i++) { lo = Math.min(lo, pk.peaks[i * 2]); hi = Math.max(hi, pk.peaks[i * 2 + 1]); }
        g.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
      }
    }
    this.paintPlayhead(g, h, pos);
  }

  paintBackdrop(g, w, h, lanesMode) {
    const p = this.p;
    g.fillStyle = COLORS.bg;
    g.fillRect(0, 0, w, h);
    const origin = p.gridOrigin || 0;
    this.gridLines(w, (kind, t, b, labeled, end) => {
      if (kind !== 'barStart') return;
      if (b % 2 === 1) {
        const x0 = this.t2x(t);
        g.fillStyle = COLORS.bgAlt;
        g.fillRect(x0, 0, (end - t) * this.pps, h);
      }
    });
    const xo = this.t2x(Math.min(0, origin));
    if (xo > 0) { g.fillStyle = COLORS.bgBefore; g.fillRect(0, 0, xo, h); }
    const L = p.loop;
    if (L.end > L.start && L.on) {
      g.fillStyle = 'rgba(217,166,90,0.06)';
      g.fillRect(this.t2x(L.start), 0, (L.end - L.start) * this.pps, h);
    }
    if (this.audio.isRecording && this.audio.recordFrom !== null) {
      const xr = this.t2x(this.audio.recordFrom);
      const xp = this.t2x(this.audio.position);
      if (xp > xr) {
        g.fillStyle = 'rgba(240,74,62,0.08)';
        g.fillRect(xr, 0, xp - xr, h);
      }
    }
    this.gridLines(w, (kind, t, b, labeled) => {
      const x = Math.round(this.t2x(t)) + 0.5;
      if (x < 0 || x > w) return;
      g.strokeStyle = kind === 'barStart' ? (labeled ? COLORS.bar : COLORS.beat) : kind === 'beat' ? COLORS.beat : COLORS.line;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    });
  }

  paintPlayhead(g, h, pos) {
    const x = this.t2x(pos);
    if (x < -2 || x > this.viewWidth + 2) return;
    g.fillStyle = this.audio.isRecording ? COLORS.tally : 'rgba(236,231,220,0.9)';
    g.fillRect(Math.round(x) - 0.75, 0, 1.5, h);
  }

  drawGrid(pos) {
    const g = this.g.grid;
    const { w, h } = this.size.grid;
    g.clearRect(0, 0, w, h);
    this.paintBackdrop(g, w, h, true);
    const laneH = this.laneH;
    const p = this.p;
    // lane rows
    let prevFam = null;
    this.lanes.forEach((note, i) => {
      const info = laneInfo(p.drumMap, note);
      const y = i * laneH;
      if (i === this.hoverLane) { g.fillStyle = 'rgba(255,255,255,0.025)'; g.fillRect(0, y, w, laneH); }
      if (p.mutes.includes(note)) { g.fillStyle = 'rgba(15,16,20,0.35)'; g.fillRect(0, y, w, laneH); }
      g.fillStyle = info.family !== prevFam && i > 0 ? COLORS.familyLine : COLORS.laneLine;
      if (info.family !== prevFam && i > 0) g.fillRect(0, y, w, 1);
      g.fillStyle = COLORS.laneLine;
      g.fillRect(0, y + laneH - 1, w, 1);
      prevFam = info.family;
    });
    // hits
    const t0 = this.x2t(-12);
    const t1 = this.x2t(w + 12);
    const hw = this.hitWidth();
    const drawHit = (n, live) => {
      const li = this.laneIndex.get(n.n);
      if (li === undefined) return;
      const info = laneInfo(p.drumMap, n.n);
      const x = this.t2x(n.t);
      const v = n.v / 127;
      const maxH = laneH - 8;
      const hh = 5 + (maxH - 5) * v;
      const y = li * laneH + (laneH - hh) / 2;
      const muted = p.mutes.includes(n.n);
      const sel = !live && this.selection.has(n.id);
      if (n.ch > 0) {
        const xe = this.t2x(n.t + n.ch);
        const yc = li * laneH + laneH / 2;
        const grabbing = this.drag?.type === 'choke' && this.drag.note === n;
        g.globalAlpha = muted ? 0.3 : grabbing ? 1 : 0.85;
        g.strokeStyle = MARK_STYLE.choke.color;
        g.lineWidth = 1.5;
        g.setLineDash([3, 3]);
        g.beginPath(); g.moveTo(x + hw / 2, yc); g.lineTo(xe, yc); g.stroke();
        g.setLineDash([]);
        g.lineWidth = 2.5;
        g.beginPath(); g.moveTo(xe, yc - 7); g.lineTo(xe, yc + 7); g.stroke();
      }
      g.globalAlpha = muted ? 0.28 : 0.4 + 0.6 * v;
      g.fillStyle = info.color;
      roundRect(g, x - hw / 2, y, hw, hh, Math.min(3, hw / 2));
      g.fill();
      g.globalAlpha = 1;
      const mark = live ? null : markOf(n);
      if (mark) {
        g.globalAlpha = muted ? 0.4 : 1;
        g.strokeStyle = mark.color;
        g.lineWidth = 2;
        if (n.mk === 'ghost') g.setLineDash([2, 2]);
        roundRect(g, x - hw / 2 - 2.5, y - 2.5, hw + 5, hh + 5, 3);
        g.stroke();
        g.setLineDash([]);
        g.globalAlpha = 1;
      }
      const out = mark ? 5 : 2;
      if (sel) {
        g.strokeStyle = COLORS.select;
        g.lineWidth = 1.6;
        roundRect(g, x - hw / 2 - out, y - out, hw + out * 2, hh + out * 2, 3);
        g.stroke();
      } else if (live) {
        g.strokeStyle = 'rgba(240,74,62,0.9)';
        g.lineWidth = 1.2;
        roundRect(g, x - hw / 2 - 1.5, y - 1.5, hw + 3, hh + 3, 3);
        g.stroke();
      } else if (n === this.hoverNote) {
        g.strokeStyle = 'rgba(236,231,220,0.5)';
        g.lineWidth = 1;
        roundRect(g, x - hw / 2 - 1.5, y - 1.5, hw + 3, hh + 3, 3);
        g.stroke();
      }
    };
    const notes = this.store.notes;
    // Start a little earlier so a choke line reaching into view is drawn too.
    for (let i = lowerBound(notes, t0 - 8); i < notes.length && notes[i].t <= t1; i++) {
      if (notes[i].t >= t0 || notes[i].ch > 0) drawHit(notes[i], false);
    }
    for (const n of this.liveNotes) if (n.t >= t0 && n.t <= t1) drawHit(n, true);
    // selection band
    const d = this.drag;
    if (d && d.type === 'band') {
      const x = Math.min(d.x0, d.x1);
      const y = Math.min(d.y0, d.y1);
      g.fillStyle = 'rgba(217,166,90,0.10)';
      g.strokeStyle = 'rgba(217,166,90,0.8)';
      g.lineWidth = 1;
      g.fillRect(x, y, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      g.strokeRect(x + 0.5, y + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    }
    this.paintPlayhead(g, h, pos);
  }

  drawVel(pos) {
    const g = this.g.vel;
    const { w, h } = this.size.vel;
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#21242c';
    g.fillRect(0, 0, w, h);
    this.gridLines(w, (kind, t) => {
      if (kind !== 'barStart') return;
      const x = Math.round(this.t2x(t)) + 0.5;
      g.strokeStyle = 'rgba(150,158,180,0.14)';
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    });
    g.strokeStyle = 'rgba(150,158,180,0.10)';
    for (const f of [0.25, 0.5, 0.75]) {
      const y = Math.round(h - 4 - f * (h - 10)) + 0.5;
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    }
    const p = this.p;
    const restrict = this.selection.size > 0;
    const notes = this.store.notes;
    const t0 = this.x2t(-4);
    const t1 = this.x2t(w + 4);
    const bw = clamp(this.hitWidth() - 2, 2, 6);
    for (let i = lowerBound(notes, t0); i < notes.length && notes[i].t <= t1; i++) {
      const n = notes[i];
      const x = this.t2x(n.t);
      const vh = (n.v / 127) * (h - 10);
      const sel = this.selection.has(n.id);
      g.globalAlpha = restrict && !sel ? 0.22 : 0.9;
      g.fillStyle = markOf(n)?.color || laneInfo(p.drumMap, n.n).color;
      g.fillRect(x - bw / 2, h - 4 - vh, bw, vh);
      g.fillRect(x - bw / 2 - 1.5, h - 4 - vh - 1, bw + 3, 2.5);
    }
    g.globalAlpha = 1;
    this.paintPlayhead(g, h, pos);
  }

  drawOverview(pos) {
    const g = this.g.overview;
    const { w, h } = this.size.overview;
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#1f222a';
    g.fillRect(0, 0, w, h);
    const total = this.overviewSpan();
    const sx = w / total;
    const p = this.p;
    if (this.peaks && p.backing) {
      const pk = this.peaks;
      const offset = p.backing.offset || 0;
      g.fillStyle = 'rgba(143,151,173,0.22)';
      const secPerPeak = pk.samplesPerPeak / pk.sampleRate;
      const count = pk.peaks.length / 2;
      for (let x = Math.max(0, Math.floor(offset * sx)); x < Math.min(w, (offset + pk.duration) * sx); x++) {
        const i0 = clamp(Math.floor((x / sx - offset) / secPerPeak), 0, count - 1);
        const i1 = clamp(Math.floor(((x + 1) / sx - offset) / secPerPeak), i0 + 1, count);
        let hi = 0;
        for (let i = i0; i < i1; i += Math.max(1, Math.floor((i1 - i0) / 16))) hi = Math.max(hi, -pk.peaks[i * 2], pk.peaks[i * 2 + 1]);
        g.fillRect(x, h / 2 - hi * (h / 2 - 3), 1, hi * (h - 6));
      }
    }
    const rows = Math.max(1, this.lanes.length);
    const rowH = (h - 6) / rows;
    for (const n of this.store.notes) {
      const li = this.laneIndex.get(n.n);
      if (li === undefined) continue;
      g.fillStyle = laneInfo(p.drumMap, n.n).color;
      g.globalAlpha = 0.75;
      g.fillRect(Math.floor(n.t * sx), 3 + li * rowH, 1, Math.max(1, rowH));
    }
    g.globalAlpha = 1;
    const wx = this.scrollX * sx;
    const ww = this.viewDuration * sx;
    g.fillStyle = 'rgba(236,231,220,0.06)';
    g.fillRect(wx, 1, ww, h - 2);
    g.strokeStyle = 'rgba(217,166,90,0.85)';
    g.lineWidth = 1.5;
    g.strokeRect(wx + 0.75, 1.75, Math.max(4, ww - 1.5), h - 3.5);
    g.fillStyle = this.audio.isRecording ? COLORS.tally : COLORS.head;
    g.fillRect(Math.round(pos * sx), 0, 1.5, h);
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
}
