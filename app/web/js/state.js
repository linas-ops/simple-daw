// The song (project) model, musical-time helpers, and undo/redo.

import { Emitter, uid, lowerBound } from './util.js';

export const GRIDS = {
  '4': { div: 4, label: '1/4' },
  '8': { div: 8, label: '1/8' },
  '8t': { div: 8, triplet: true, label: '1/8 triplet' },
  '16': { div: 16, label: '1/16' },
  '16t': { div: 16, triplet: true, label: '1/16 triplet' },
  '32': { div: 32, label: '1/32' },
};

export const DEFAULT_MIX = {
  master: 0.9, drums: 0.9, backing: 0.75, click: 0.55,
  kit: { kick: 1, snare: 1, tom: 1, hat: 1, cym: 1, ride: 1, perc: 1 },
  lanes: {}, // per-drum volume: { [note]: 0..1.5 }
  ring: {}, // how long a cymbal rings: { [note]: seconds }, none = as recorded
};

export function newTake(name) {
  return { id: uid(), name, created: Date.now(), notes: [], ccs: [] };
}

export function newProject() {
  const take = newTake('Take 1');
  return {
    format: 'simple-daw',
    version: 1,
    name: 'Untitled song',
    tempo: 120,
    // Tempo changes: from a beat (counted from bar 1, 0-based) the song plays at bpm.
    tempoChanges: [],
    sig: [4, 4],
    gridOrigin: 0,
    drumMap: 'gm',
    takes: [take],
    activeTake: take.id,
    backing: null, // {media, name, offset, muted}
    mutes: [],
    loop: { on: false, start: 0, end: 0 },
    // lanes: sounds a single drum borrows from another kit, { [note]: { path, kit, name, note, raw, ... } }
    // takes: a single variation a drum always plays, { [note]: { n, path, note, raw } }
    sound: { type: 'kit', kit: 'black-pearl', plugin: null, convertGM: true, lanes: {}, takes: {} },
    mix: structuredClone(DEFAULT_MIX),
    created: Date.now(),
  };
}

// ---- musical time ---------------------------------------------------------
// Hits are stored in seconds. The tempo map turns seconds into beats and back:
// p.tempo plays from bar 1, and each tempo change takes over from its beat.
// Beats are counted from the start of bar 1 (0) in the time signature's unit.

const mapCache = new WeakMap();

export function normTempoChanges(list) {
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    const beat = Number(c?.beat);
    const bpm = Number(c?.bpm);
    if (!(beat > 0) || !(bpm >= 20 && bpm <= 400)) continue;
    out.push({ beat: Math.round(beat * 1000) / 1000, bpm: Math.round(bpm * 100) / 100 });
  }
  out.sort((a, b) => a.beat - b.beat);
  return out.filter((c, i) => i === 0 || c.beat !== out[i - 1].beat);
}

// [{beat, t, bpm}] sections, the first one starting at bar 1.
export function tempoSegments(p) {
  const changes = p.tempoChanges || [];
  const origin = p.gridOrigin || 0;
  const key = `${p.tempo}|${origin}|${changes.map((c) => `${c.beat}:${c.bpm}`).join(',')}`;
  const hit = mapCache.get(p);
  if (hit && hit.key === key) return hit.segs;
  const segs = [{ beat: 0, t: origin, bpm: p.tempo }];
  for (const c of changes) {
    const last = segs[segs.length - 1];
    if (!(c.beat > last.beat)) continue;
    segs.push({ beat: c.beat, t: last.t + ((c.beat - last.beat) * 60) / last.bpm, bpm: c.bpm });
  }
  mapCache.set(p, { key, segs });
  return segs;
}

function segAtTime(segs, t) {
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].t <= t + 1e-9) lo = mid; else hi = mid - 1;
  }
  return segs[lo];
}

function segAtBeat(segs, b) {
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].beat <= b + 1e-9) lo = mid; else hi = mid - 1;
  }
  return segs[lo];
}

// Before bar 1 the starting tempo continues backwards.
export function beatAt(p, t, segs = tempoSegments(p)) {
  const s = segAtTime(segs, t);
  return s.beat + ((t - s.t) * s.bpm) / 60;
}

export function timeAtBeat(p, b, segs = tempoSegments(p)) {
  const s = segAtBeat(segs, b);
  return s.t + ((b - s.beat) * 60) / s.bpm;
}

// Tempo (in the time signature's beats) at a time, or at the start without one.
export const bpmAt = (p, t = null) => (t === null ? p.tempo : segAtTime(tempoSegments(p), t).bpm);
export const bpmAtBeat = (p, b) => segAtBeat(tempoSegments(p), b).bpm;
export const beatDur = (p, t = null) => 60 / bpmAt(p, t);
export const barDur = (p, t = null) => beatDur(p, t) * p.sig[0];
export const quarterDur = (p, t = null) => beatDur(p, t) * (p.sig[1] / 4);
export const quarterBpm = (p, t = null) => bpmAt(p, t) * (4 / p.sig[1]);
export const hasTempoChanges = (p) => (p.tempoChanges || []).length > 0;

// One grid step, in beats.
export function stepBeats(p, gridKey) {
  const g = GRIDS[gridKey] || GRIDS['16'];
  const base = p.sig[1] / g.div;
  return g.triplet ? (base * 2) / 3 : base;
}

// One grid step in seconds, at a time (the tempo can differ from bar to bar).
export function stepDur(p, gridKey, t = null) {
  return stepBeats(p, gridKey) * beatDur(p, t);
}

export function snapTime(p, t, gridKey) {
  const s = stepBeats(p, gridKey);
  return timeAtBeat(p, Math.round(beatAt(p, t) / s) * s);
}

// Move a time by a number of beats, following tempo changes.
export const shiftBeats = (p, t, beats) => timeAtBeat(p, beatAt(p, t) + beats);

export function barBeatAt(p, t) {
  const b = beatAt(p, t);
  const bar = Math.floor(b / p.sig[0] + 1e-9);
  const beat = Math.floor(b - bar * p.sig[0] + 1e-9);
  return { bar: bar + 1, beat: beat + 1 };
}

export const timeOfBar = (p, bar) => timeAtBeat(p, (bar - 1) * p.sig[0]);
export const beatOfBar = (p, bar) => (bar - 1) * p.sig[0];

// Where a beat falls, as "bar 33" or "bar 33, beat 3".
export function beatLabel(p, b) {
  const bar = Math.floor(b / p.sig[0] + 1e-9);
  const within = b - bar * p.sig[0];
  if (Math.abs(within) < 1e-6) return `bar ${bar + 1}`;
  return `bar ${bar + 1}, beat ${Math.round((within + 1) * 100) / 100}`;
}

// Keep hits on the same beats after the tempo map changed (`before` is the old
// tempoSegments). Hits, pedal moves, chokes and the loop all move along.
export function retime(p, before) {
  const map = (t) => timeAtBeat(p, beatAt(p, t, before));
  for (const take of p.takes) {
    for (const n of take.notes) {
      const end = n.ch ? map(n.t + n.ch) : null;
      n.t = Math.max(0, map(n.t));
      if (end !== null) n.ch = Math.max(0.02, end - n.t);
    }
    for (const c of take.ccs) c.t = Math.max(0, map(c.t));
  }
  if (p.loop.end > p.loop.start) p.loop = { ...p.loop, start: Math.max(0, map(p.loop.start)), end: map(p.loop.end) };
}

// ---- store ----------------------------------------------------------------
const UNDO_LIMIT = 120;

// Marks a hit can carry (n.mk). Humanize leaves marked and choked hits alone.
export const MARKS = ['cresc', 'dim', 'acc', 'ghost'];

// A hit is [time, note, velocity], then for a choked cymbal the seconds until the
// choke (0 if none), then its mark if it has one.
function encodeTake(t) {
  const r5 = (x) => Math.round(x * 100000) / 100000;
  return {
    id: t.id,
    name: t.name,
    created: t.created,
    notes: t.notes.map((n) => {
      if (n.mk) return [r5(n.t), n.n, n.v, n.ch > 0 ? r5(n.ch) : 0, n.mk];
      return n.ch > 0 ? [r5(n.t), n.n, n.v, r5(n.ch)] : [r5(n.t), n.n, n.v];
    }),
    ccs: (t.ccs || []).map((c) => [Math.round(c.t * 100000) / 100000, c.c, c.v]),
  };
}

function decodeTake(t) {
  return {
    id: t.id || uid(),
    name: t.name || 'Take',
    created: t.created || Date.now(),
    notes: (t.notes || []).map((n) => {
      const hit = Array.isArray(n) ? { id: uid(), t: n[0], n: n[1], v: n[2] } : { id: uid(), t: n.t, n: n.n, v: n.v };
      const ch = Array.isArray(n) ? n[3] : n.ch;
      if (ch > 0) hit.ch = ch;
      const mk = Array.isArray(n) ? n[4] : n.mk;
      if (MARKS.includes(mk)) hit.mk = mk;
      return hit;
    }),
    ccs: (t.ccs || []).map((c) => (Array.isArray(c) ? { t: c[0], c: c[1], v: c[2] } : { t: c.t, c: c.c, v: c.v })),
  };
}

export class Store extends Emitter {
  constructor() {
    super();
    this.project = newProject();
    this.file = null;
    this.undoStack = [];
    this.redoStack = [];
    this.version = 0;
    this._gesture = null;
  }

  get take() {
    const p = this.project;
    return p.takes.find((t) => t.id === p.activeTake) || p.takes[0];
  }

  get notes() { return this.take.notes; }
  get ccs() { return this.take.ccs; }

  // -- undo snapshots --------------------------------------------------------
  snapshot() {
    const p = this.project;
    return JSON.stringify({
      tempo: p.tempo,
      tempoChanges: p.tempoChanges || [],
      sig: p.sig,
      gridOrigin: p.gridOrigin,
      takes: p.takes.map(encodeTake),
      activeTake: p.activeTake,
      backing: p.backing,
      mutes: p.mutes,
      loop: p.loop,
    });
  }

  restore(snap) {
    const s = JSON.parse(snap);
    Object.assign(this.project, s, { takes: s.takes.map(decodeTake) });
  }

  edit(label, fn) {
    const before = this.snapshot();
    fn(this.project, this.take);
    this.sortNotes();
    if (this.snapshot() !== before) {
      this._pushUndo(label, before);
      this.changed(label);
      return true;
    }
    return false;
  }

  beginGesture() {
    if (!this._gesture) this._gesture = this.snapshot();
  }

  endGesture(label) {
    if (!this._gesture) return false;
    const before = this._gesture;
    this._gesture = null;
    this.sortNotes();
    if (this.snapshot() !== before) {
      this._pushUndo(label, before);
      this.changed(label);
      return true;
    }
    return false;
  }

  cancelGesture() {
    if (!this._gesture) return;
    this.restore(this._gesture);
    this._gesture = null;
    this.changed('cancel');
  }

  _pushUndo(label, snap) {
    this.undoStack.push({ label, snap });
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo() {
    const item = this.undoStack.pop();
    if (!item) return null;
    this.redoStack.push({ label: item.label, snap: this.snapshot() });
    this.restore(item.snap);
    this.changed('undo');
    return item.label;
  }

  redo() {
    const item = this.redoStack.pop();
    if (!item) return null;
    this.undoStack.push({ label: item.label, snap: this.snapshot() });
    this.restore(item.snap);
    this.changed('redo');
    return item.label;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  changed(reason) {
    this.version++;
    this.emit('change', reason);
  }

  // Settings-like changes (sound, mix, name) are not undoable but are saved.
  touch(reason = 'settings') {
    this.version++;
    this.emit('settings', reason);
  }

  sortNotes() {
    for (const take of this.project.takes) {
      take.notes.sort((a, b) => a.t - b.t || a.n - b.n);
      take.ccs.sort((a, b) => a.t - b.t);
    }
  }

  // -- loading & saving -------------------------------------------------------
  load(data, file) {
    const base = newProject();
    const p = { ...base, ...data };
    p.takes = (data.takes && data.takes.length ? data.takes : base.takes).map(decodeTake);
    if (!p.takes.some((t) => t.id === p.activeTake)) p.activeTake = p.takes[0].id;
    p.sound = { ...base.sound, ...(data.sound || {}) };
    if (!p.sound.lanes || typeof p.sound.lanes !== 'object') p.sound.lanes = {};
    if (!p.sound.takes || typeof p.sound.takes !== 'object') p.sound.takes = {};
    p.mix = {
      ...base.mix,
      ...(data.mix || {}),
      kit: { ...base.mix.kit, ...((data.mix || {}).kit || {}) },
      lanes: { ...((data.mix || {}).lanes || {}) },
      ring: { ...((data.mix || {}).ring || {}) },
    };
    p.loop = { ...base.loop, ...(data.loop || {}) };
    p.sig = Array.isArray(data.sig) ? data.sig : base.sig;
    p.tempoChanges = normTempoChanges(data.tempoChanges);
    p.mutes = Array.isArray(data.mutes) ? data.mutes : [];
    this.project = p;
    this.file = file || null;
    this.undoStack = [];
    this.redoStack = [];
    this.sortNotes();
    this.version++;
    this.emit('load');
  }

  serialize() {
    const p = this.project;
    return {
      ...p,
      format: 'simple-daw',
      version: 1,
      takes: p.takes.map(encodeTake),
      saved: Date.now(),
    };
  }

  // -- queries ----------------------------------------------------------------
  notesInRange(t0, t1, notes = this.notes) {
    const out = [];
    for (let i = lowerBound(notes, t0); i < notes.length && notes[i].t < t1; i++) out.push(notes[i]);
    return out;
  }

  lastNoteTime() {
    const notes = this.notes;
    return notes.length ? notes[notes.length - 1].t : 0;
  }

  isMuted(note) { return this.project.mutes.includes(note); }
}
