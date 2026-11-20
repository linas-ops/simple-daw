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
export const beatDur = (p) => 60 / p.tempo;
export const barDur = (p) => beatDur(p) * p.sig[0];
export const quarterDur = (p) => beatDur(p) * (p.sig[1] / 4);
export const quarterBpm = (p) => p.tempo * (4 / p.sig[1]);

export function stepDur(p, gridKey) {
  const g = GRIDS[gridKey] || GRIDS['16'];
  const base = (quarterDur(p) * 4) / g.div;
  return g.triplet ? (base * 2) / 3 : base;
}

export function snapTime(p, t, gridKey) {
  const s = stepDur(p, gridKey);
  const o = p.gridOrigin || 0;
  return o + Math.round((t - o) / s) * s;
}

export function barBeatAt(p, t) {
  const rel = t - (p.gridOrigin || 0);
  const bd = barDur(p);
  const bar = Math.floor(rel / bd + 1e-9);
  const within = rel - bar * bd;
  const beat = Math.floor(within / beatDur(p) + 1e-9);
  return { bar: bar + 1, beat: beat + 1 };
}

export const timeOfBar = (p, bar) => (p.gridOrigin || 0) + (bar - 1) * barDur(p);

// ---- store ----------------------------------------------------------------
const UNDO_LIMIT = 120;

function encodeTake(t) {
  return {
    id: t.id,
    name: t.name,
    created: t.created,
    notes: t.notes.map((n) => [Math.round(n.t * 100000) / 100000, n.n, n.v]),
    ccs: (t.ccs || []).map((c) => [Math.round(c.t * 100000) / 100000, c.c, c.v]),
  };
}

function decodeTake(t) {
  return {
    id: t.id || uid(),
    name: t.name || 'Take',
    created: t.created || Date.now(),
    notes: (t.notes || []).map((n) => (Array.isArray(n) ? { id: uid(), t: n[0], n: n[1], v: n[2] } : { id: uid(), t: n.t, n: n.n, v: n.v })),
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
    };
    p.loop = { ...base.loop, ...(data.loop || {}) };
    p.sig = Array.isArray(data.sig) ? data.sig : base.sig;
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
