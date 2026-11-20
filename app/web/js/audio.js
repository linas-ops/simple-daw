// Audio: the built-in kits, the metronome, plugin playback and the transport.

import { Emitter, clamp, lowerBound, hashString } from './util.js';
import { laneInfo, outputNote } from './drummap.js';
import { beatAt, timeAtBeat, tempoSegments } from './state.js';
import { api } from './api.js';

const LOOKAHEAD = 0.16;     // how far ahead events are scheduled (s)
const TICK_MS = 25;
export const SEG = 6;       // plugin audio is rendered in 6 s pieces...
export const PRE = 5;       // ...each with 5 s of earlier hits so cymbals keep ringing
export const XF = 0.03;     // and a short crossfade between pieces
const MAX_SEGMENTS = 70;

// ---------------------------------------------------------------------------
// Built-in kits (AVL Drumkits, 5 velocity layers per drum)
// ---------------------------------------------------------------------------
export class KitSampler {
  constructor(ctx) {
    this.ctx = ctx;
    this.defs = null;
    this.buffers = new Map();
    this.kit = null;
    this.kitId = null;
  }

  async defsLoaded() {
    if (!this.defs) {
      const res = await fetch('/kits/avl/kits.json');
      if (!res.ok) throw new Error('the kit list is missing');
      const defs = await res.json();
      if (!defs.kits) throw new Error('the kit list is damaged');
      this.defs = defs;
    }
    return this.defs;
  }

  async load(kitId, onProgress) {
    const defs = await this.defsLoaded();
    const id = defs.kits[kitId] ? kitId : 'black-pearl';
    const kit = defs.kits[id];
    const files = [...new Set(Object.values(kit.voices).flatMap((v) => v.files))].filter((f) => !this.buffers.has(f));
    let done = 0;
    const queue = [...files];
    const worker = async () => {
      while (queue.length) {
        const file = queue.shift();
        const res = await fetch(`/kits/avl/samples/${encodeURIComponent(file)}`);
        if (!res.ok) throw new Error(`Missing kit sample ${file}`);
        const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
        this.buffers.set(file, buf);
        done++;
        onProgress?.(done / files.length);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    this.kit = kit;
    this.kitId = id;
    return kit;
  }
}

// Cymbals that are one piece of metal: grabbing one stops the others too.
const SAME_CYMBAL = { ride: ['ride', 'bell'], bell: ['ride', 'bell'], rideEdge: ['rideEdge'] };

// A hit on an open hi-hat or a crash that's still ringing blends into it: the ring fades
// out under the new hit and the new hit starts softer (same numbers as the sample-kit engine).
const BLEND_KINDS = {
  hat: { maxGap: 0.75, release: [0.4, 3.0, 0.5, 1.5], floor: 0.1, span: 0.11, near: 0.18 },
  cym: { maxGap: 1.6, release: [0.8, 2.5, 1.0, 3.5], floor: 0.25, span: 0.13, near: 0.25 },
};
const CRASH_VOICES = new Set(['crash1', 'crash2', 'china', 'splash']);

export class KitPlayer {
  constructor(sampler, ctx, destination) {
    this.s = sampler;
    this.ctx = ctx;
    this.dest = destination;
    this.active = [];
    this.blend = { hat: 0.8, cym: 0.8 }; // how much repeated open hi-hats and crashes ring together
  }

  // Blend a new hit into what `keys` still ring. Returns the gain the new hit starts at
  // (1 = full), or null when it doesn't blend.
  blendInto(kind, keys, when) {
    const amount = this.blend?.[kind] || 0;
    if (amount <= 0) return null;
    const spec = BLEND_KINDS[kind];
    const ringing = this.active.filter((v) => keys.includes(v.key) && v.start < when && v.end > when);
    if (!ringing.length) return null;
    const gap = when - Math.max(...ringing.map((v) => v.start));
    if (!(gap > 0 && gap < spec.maxGap)) return null;
    const [base, perGap, lo, hi] = spec.release;
    const release = clamp(base + perGap * gap, lo, hi) * (0.4 + 0.75 * amount);
    for (const v of ringing) this.fade(v, when, release);
    const softest = 1 - (1 - spec.floor) * amount;
    return softest + (1 - softest) * clamp((gap - spec.near) / (spec.maxGap - spec.near), 0, 1);
  }

  // `choke`: seconds after the hit when a hand grabs the cymbal. mix.ring[note] shortens
  // how long a cymbal rings (seconds).
  play(when, note, vel, mapId, mix, choke = 0) {
    const kit = this.s.kit;
    if (!kit) return;
    const info = laneInfo(mapId, note);
    let key = info.voice;
    if (!key) return;
    let rate = 1;
    if (!kit.voices[key]) {
      if (key === 'tom4') { key = 'tom3'; rate = 0.86; } else return;
    }
    const voice = kit.voices[key];
    const edges = this.s.defs.layers; // lowest velocity of each layer
    let layer = 0;
    for (let i = edges.length - 1; i >= 0; i--) if (vel >= edges[i]) { layer = i; break; }
    const lo = edges[layer];
    const hi = (edges[layer + 1] ?? 128) - 1;
    const frac = clamp((vel - lo) / Math.max(1, hi - lo), 0, 1);
    // Anti machine-gun: sometimes borrow the neighbouring layer, plus tiny
    // pitch and level changes, so repeated hits never sound identical.
    let pick = layer;
    let comp = 1;
    if (Math.random() < 0.3) {
      if (frac > 0.5 && layer < voice.files.length - 1) { pick = layer + 1; comp = 0.8; }
      else if (frac <= 0.5 && layer > 0) { pick = layer - 1; comp = 1.22; }
    }
    const buf = this.s.buffers.get(voice.files[pick]);
    if (!buf) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate * Math.pow(2, ((Math.random() * 2 - 1) * 7) / 1200);
    const gain = ctx.createGain();
    const family = (mix?.kit?.[info.family] ?? 1) * (mix?.lanes?.[note] ?? 1);
    const level = (0.58 + 0.42 * frac) * comp * family * (0.93 + Math.random() * 0.07);
    gain.gain.value = level;
    const pan = ctx.createStereoPanner();
    pan.pan.value = clamp(((voice.pan || 0) / 100) * 0.75, -1, 1);
    src.connect(gain).connect(pan).connect(this.dest);

    let start = null;
    let span = 0;
    if (key === 'hhClosed' || key === 'hhPedal') this.choke('hhOpen', when, 0.07);
    else if (key === 'hhOpen') {
      // Played open in a row, the hat keeps ringing under the next hit, which starts softer.
      start = this.blendInto('hat', ['hhOpen'], when);
      span = BLEND_KINDS.hat.span;
      if (start === null) this.choke('hhOpen', when, 0.15);
    } else if (CRASH_VOICES.has(key)) {
      start = this.blendInto('cym', [key], when);
      span = BLEND_KINDS.cym.span;
    }
    if (start !== null && start < 0.99) {
      gain.gain.setValueAtTime(level * start, when);
      gain.gain.linearRampToValueAtTime(level, when + span);
    }
    const same = this.active.filter((v) => v.key === key && v.end > when && !v.fading);
    if (same.length >= 6) this.fade(same[0], when, 0.05);
    const ring = Number(mix?.ring?.[note]) || 0;
    if (ring > 0) {
      // A shorter ring: as recorded at first, then dying away to silence at `ring` s.
      const hold = Math.max(ring * 0.3, start !== null ? span + 0.01 : 0);
      gain.gain.setTargetAtTime(0.0001, when + hold, Math.max(0.01, (ring - hold) / 6.9));
    }

    src.start(when);
    const entry = { key, src, gain, level, start: when, end: when + buf.duration / src.playbackRate.value };
    if (ring > 0 && when + ring + 0.05 < entry.end) {
      entry.end = when + ring + 0.05;
      src.stop(entry.end);
    }
    this.active.push(entry);
    src.onended = () => {
      const i = this.active.indexOf(entry);
      if (i >= 0) this.active.splice(i, 1);
      try { pan.disconnect(); } catch { /* already gone */ }
    };
    if (choke > 0) this.grab(key, when + choke);
  }

  // A hand grabs a cymbal: it and anything else ringing on the same cymbal goes quiet.
  grab(key, when, time = 0.15) {
    for (const k of SAME_CYMBAL[key] || [key]) this.choke(k, when, time);
  }

  grabNote(note, mapId, when) {
    const key = laneInfo(mapId, note).voice;
    if (key) this.grab(key, when);
  }

  choke(key, when, time) {
    for (const v of this.active) if (v.key === key && v.start < when && v.end > when) this.fade(v, when, time);
  }

  fade(v, when, time) {
    const end = when + time;
    if (v.end <= end) return; // already going quiet sooner
    try {
      const g = v.gain.gain;
      if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(when); // keep a softened start or shorter ring
      else { g.cancelScheduledValues(when); g.setValueAtTime(v.level, when); }
      g.linearRampToValueAtTime(0.0001, end);
      v.src.stop(end + 0.01);
    } catch { /* source may already be stopped */ }
    v.end = end;
    v.fading = true;
  }

  stopAll(when) {
    for (const v of this.active) this.fade(v, when, 0.03);
  }
}

export function scheduleClick(ctx, dest, when, accent) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(accent ? 0.9 : 0.5, when + 0.0015);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.055);
  g.connect(dest);
  const freqs = accent ? [1760, 2640] : [1180, 1770];
  freqs.forEach((f, i) => {
    const o = ctx.createOscillator();
    o.type = i ? 'triangle' : 'sine';
    o.frequency.value = f;
    const og = ctx.createGain();
    og.gain.value = i ? 0.25 : 1;
    o.connect(og).connect(g);
    o.start(when);
    o.stop(when + 0.07);
  });
}

// ---------------------------------------------------------------------------
// Plugin playback: rendered in pieces by the engine, cached, crossfaded.
// ---------------------------------------------------------------------------
class PluginSegments {
  constructor(audio) {
    this.a = audio;
    this.cache = new Map(); // index -> {hash, buffer, used}
    this.pending = null;
    this.version = 0;
    this.enabled = false;
    this.failedHash = new Map();
    this.sources = new Map(); // index -> {src, gain}
    this.nextIdx = 0;
    this.late = new Map();
    this.waiters = [];
  }

  get store() { return this.a.store; }

  reset() {
    this.cache.clear();
    this.failedHash.clear();
    this.version++;
  }

  window(idx) {
    const start = idx * SEG;
    return { start, t0: Math.max(0, start - PRE), t1: start + SEG + XF };
  }

  hash(idx) {
    const p = this.store.project;
    const { t0, t1 } = this.window(idx);
    let s = `${this.version}|${this.a.variations}|${this.a.blend.hat},${this.a.blend.cym},${this.a.pedalStop ? 1 : 0}|${this.a.ctx.sampleRate}|${p.sound.type}|${p.sound.type === 'sfz' ? p.sound.sfz?.path : ''}|${JSON.stringify(this.a.engineCC() || {})}|${p.sound.convertGM ? 1 : 0}|${p.drumMap}|${p.mutes.join(',')}|${this.a.routeSignature()}|`;
    const notes = this.store.notes;
    let count = 0;
    for (let i = lowerBound(notes, t0); i < notes.length && notes[i].t < t1; i++) {
      const n = notes[i];
      s += n.ch ? `${n.t.toFixed(5)},${n.n},${n.v},${n.ch.toFixed(4)};` : `${n.t.toFixed(5)},${n.n},${n.v};`;
      count++;
    }
    const ccs = this.store.ccs;
    for (let i = Math.max(0, lowerBound(ccs, t0) - 1); i < ccs.length && ccs[i].t < t1; i++) {
      s += `c${ccs[i].t.toFixed(4)},${ccs[i].v};`;
    }
    return `${hashString(s)}:${count}`;
  }

  payload(idx) {
    const { start, t0, t1 } = this.window(idx);
    const list = this.store.notes;
    const slice = [];
    for (let i = lowerBound(list, t0); i < list.length && list[i].t < t1; i++) slice.push(list[i]);
    const { notes, routes } = this.a.engineHits(slice);
    const ccs = [];
    const cl = this.store.ccs;
    for (let i = Math.max(0, lowerBound(cl, t0) - 1); i < cl.length && cl[i].t < t1; i++) ccs.push([cl[i].t, cl[i].c, cl[i].v]);
    return { notes, routes, ccs, start, preroll: start - t0, length: SEG + XF, sampleRate: this.a.ctx.sampleRate, cc: this.a.engineCC(), variations: this.a.variations, blend: this.a.blend, pedalStop: this.a.pedalStop };
  }

  isReady(idx) {
    const c = this.cache.get(idx);
    return !!c && c.hash === this.hash(idx);
  }

  get(idx) {
    const c = this.cache.get(idx);
    if (c && c.hash === this.hash(idx)) { c.used = performance.now(); return c.buffer; }
    return null;
  }

  async render(idx) {
    const hash = this.hash(idx);
    const payload = this.payload(idx);
    this.pending = { idx, hash };
    this.a.emit('plugin-busy', true);
    try {
      const res = await api.render(payload);
      const ctx = this.a.ctx;
      const buffer = ctx.createBuffer(2, res.frames, res.sampleRate || ctx.sampleRate);
      const xf = Math.round(XF * buffer.sampleRate);
      for (let c = 0; c < 2; c++) {
        const data = new Float32Array(res.data[Math.min(c, res.data.length - 1)]);
        if (idx > 0) for (let i = 0; i < xf && i < data.length; i++) data[i] *= i / xf;
        const fadeStart = data.length - xf;
        for (let i = Math.max(0, fadeStart); i < data.length; i++) data[i] *= (data.length - i) / xf;
        buffer.copyToChannel(data, c);
      }
      // Hits inside this piece (not just the earlier ones it includes so cymbals
      // keep ringing) but no sound at all: the plugin or kit isn't working.
      const ownHits = payload.notes.some((n) => n[0] >= payload.start - 1e-6 && n[0] < payload.start + SEG);
      if (ownHits && res.data.every((ch) => { for (let i = 0; i < ch.length; i += 7) if (ch[i] !== 0) return false; return true; })) {
        this.a.emit('plugin-silent');
      }
      if (this.hash(idx) === hash) {
        this.cache.set(idx, { hash, buffer, used: performance.now() });
        this.evict();
      }
      this.failedHash.delete(idx);
    } catch (err) {
      this.failedHash.set(idx, hash);
      this.a.emit('plugin-error', err);
    } finally {
      this.pending = null;
      this.a.emit('plugin-busy', false);
      this.onRendered(idx);
    }
  }

  evict() {
    if (this.cache.size <= MAX_SEGMENTS) return;
    const pos = this.a.position;
    const entries = [...this.cache.entries()].sort((x, y) => Math.abs(y[0] * SEG - pos) - Math.abs(x[0] * SEG - pos));
    while (this.cache.size > MAX_SEGMENTS && entries.length) this.cache.delete(entries.shift()[0]);
  }

  onRendered(idx) {
    // Wake anyone waiting for this piece, then keep going.
    this.waiters = this.waiters.filter((w) => {
      if (this.isReady(w.idx) || this.failedHash.get(w.idx) === this.hash(w.idx)) { w.resolve(); return false; }
      return true;
    });
    const late = this.late.get(idx);
    if (late && this.a.state !== 'stopped') this.startLate(idx);
    queueMicrotask(() => this.pump());
  }

  waitFor(idx) {
    if (this.isReady(idx)) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.push({ idx, resolve });
      this.pump(idx);
    });
  }

  songEndIdx() { return Math.ceil(this.a.songEnd() / SEG); }

  nextNeeded(priority) {
    const order = [];
    if (priority !== undefined) order.push(priority);
    const a = this.a;
    const pos = Math.max(0, a.state === 'stopped' ? a.stoppedPos : a.position);
    const base = Math.floor(pos / SEG);
    const endIdx = this.songEndIdx();
    for (let i = base; i <= Math.min(endIdx, base + 3); i++) order.push(i);
    const loop = this.store.project.loop;
    if (loop.on && loop.end > loop.start) {
      for (let i = Math.floor(loop.start / SEG); i <= Math.floor(loop.end / SEG); i++) order.push(i);
    }
    if (a.state === 'stopped') {
      // Fill in the rest quietly so playback starts instantly.
      for (let d = 4; d <= 12; d++) { order.push(base + d); if (base - d + 3 >= 0) order.push(base - d + 3); }
    }
    for (const i of order) {
      if (i < 0 || i > endIdx) continue;
      if (this.isReady(i)) continue;
      if (this.failedHash.get(i) === this.hash(i)) continue;
      return i;
    }
    return null;
  }

  pump(priority) {
    if (!this.enabled || this.pending || this.a.pluginLoading) return;
    const idx = this.nextNeeded(priority);
    if (idx !== null) this.render(idx);
  }

  // -- playback --------------------------------------------------------------
  startPass(pos, when) {
    const idx = Math.floor(Math.max(0, pos) / SEG);
    this.nextIdx = idx + 1;
    this.late.clear();
    const offset = Math.max(0, pos) - idx * SEG;
    const lead = pos < 0 ? -pos : 0;
    this.startSegment(idx, when + lead, offset, pos);
  }

  startSegment(idx, when, offset, pos) {
    const buffer = this.get(idx);
    if (!buffer) {
      this.late.set(idx, { pos });
      this.pump(idx);
      return;
    }
    if (offset >= buffer.duration) return;
    const ctx = this.a.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    src.connect(gain).connect(this.a.pluginBus);
    src.start(when, offset);
    const entry = { src, gain };
    this.sources.set(`${idx}:${when}`, entry);
    src.onended = () => { this.sources.delete(`${idx}:${when}`); try { gain.disconnect(); } catch { /* gone */ } };
  }

  startLate(idx) {
    this.late.delete(idx);
    const a = this.a;
    const when = a.ctx.currentTime + 0.03;
    const pos = a.posAtCtx(when);
    const offset = pos - idx * SEG;
    if (offset >= 0 && offset < SEG) this.startSegment(idx, when, offset, pos);
  }

  scheduleBoundaries(p0, p1, c0) {
    while (this.nextIdx * SEG < p1 - 1e-9) {
      const b = this.nextIdx * SEG;
      if (b >= p0 - 1e-6) this.startSegment(this.nextIdx, c0 + (b - p0), 0, b);
      this.nextIdx++;
    }
  }

  stopAll(when) {
    for (const { src, gain } of this.sources.values()) {
      try {
        gain.gain.setValueAtTime(1, when);
        gain.gain.linearRampToValueAtTime(0, when + 0.012);
        src.stop(when + 0.015);
      } catch { /* already stopped */ }
    }
    this.sources.clear();
    this.late.clear();
  }
}

// ---------------------------------------------------------------------------
// The audio engine and transport
// ---------------------------------------------------------------------------
export class AudioEngine extends Emitter {
  constructor(store) {
    super();
    this.store = store;
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.master = ctx.createGain();
    this.master.connect(this.limiter).connect(ctx.destination);
    this.drumsBus = ctx.createGain();
    this.drumsBus.connect(this.master);
    this.kitBus = ctx.createGain();
    this.kitBus.connect(this.drumsBus);
    this.pluginBus = ctx.createGain();
    this.pluginBus.connect(this.drumsBus);
    this.backingBus = ctx.createGain();
    this.backingBus.connect(this.master);
    this.clickBus = ctx.createGain();
    this.clickBus.connect(this.master);

    this.sampler = new KitSampler(ctx);
    this.kit = new KitPlayer(this.sampler, ctx, this.kitBus);
    this._blend = { hat: 0.8, cym: 0.8 };
    this.pedalStop = true; // the hi-hat pedal stops the open hi-hat's ring (sample kits)
    this.segments = new PluginSegments(this);
    this.moduleOut = null;
    this.backingBuffer = null;
    this.pluginLoading = false;

    this.state = 'stopped';
    this.stoppedPos = 0;
    this.playStartPos = 0;
    this.recordFrom = null;
    this.recordMode = 'replace';
    this.clickOn = true;
    this.timeline = [];
    this.schedCtx = 0;
    this.schedPos = 0;
    this.backingSources = new Set();
    this.timer = null;
    this.applyMix();
  }

  get soundType() { return this.store.project.sound.type; }
  get usesEngine() { return this.soundType === 'plugin' || this.soundType === 'sfz'; }

  // The note number the plugin or sample kit receives for a recorded note.
  engineNote(note) {
    const p = this.store.project;
    return outputNote(p.drumMap, note, p.sound.type === 'sfz' ? true : p.sound.convertGM !== false);
  }

  // Mixer settings for sample kits (mic and drum levels).
  engineCC() {
    const s = this.store.project.sound;
    return s.type === 'sfz' ? (s.sfz?.cc || {}) : null;
  }

  // Which kit plays each drum when a sample kit is the sound. The app sets
  // routeFor(laneNote) => {path, note, raw, gain, ...} or null (main kit, as is).
  routeSignature() {
    const p = this.store.project;
    if (p.sound.type !== 'sfz') return '';
    return `${this.routeVersion || 0}|${JSON.stringify(p.sound.lanes || {})}|${JSON.stringify(p.sound.takes || {})}|${JSON.stringify(p.mix.lanes || {})}|${JSON.stringify(p.mix.ring || {})}`;
  }

  // Hits -> what the engine renders: [[t, note, vel, route?, choke?]] plus the route list.
  // A drum limited to some of its recordings (route.takes) gets one route per recording,
  // and each hit is given one of them, the same way every time it's rendered.
  engineHits(list) {
    const p = this.store.project;
    const useRoutes = p.sound.type === 'sfz' && typeof this.routeFor === 'function';
    const routes = [];
    const byLane = new Map();
    const notes = [];
    for (const n of list) {
      if (p.mutes.includes(n.n)) continue;
      let lane = byLane.get(n.n);
      if (lane === undefined) {
        const r = useRoutes ? this.routeFor(n.n) : null;
        if (!r) lane = { ri: -1 };
        else if (r.silent) lane = { ri: -2 };
        else if (Array.isArray(r.takes) && r.takes.length > 1) {
          const base = { ...r };
          delete base.takes;
          lane = { ri: -3, base, takes: r.takes, pick: this.takePicks(n.n, r.takes), variants: new Map() };
        } else lane = { ri: routes.push(r) - 1 };
        byLane.set(n.n, lane);
      }
      let ri = lane.ri;
      if (ri === -2) continue; // nothing in the current kits plays this drum
      if (ri === -3) {
        const take = lane.pick.get(n.id) ?? lane.takes[0];
        ri = lane.variants.get(take);
        if (ri === undefined) {
          ri = routes.push({ ...lane.base, take }) - 1;
          lane.variants.set(take, ri);
        }
      }
      const e = this.engineNote(n.n);
      if (n.ch > 0) notes.push([n.t, e, n.v, ri >= 0 ? ri : null, n.ch]);
      else notes.push(ri >= 0 ? [n.t, e, n.v, ri] : [n.t, e, n.v]);
    }
    return { notes, routes };
  }
  // Which of `takes` each hit on a lane plays: in turn, or at random but never the same
  // one three times in a row. Worked out over the whole take so it never changes
  // between the parts that are rendered separately.
  takePicks(lane, takes) {
    const out = new Map();
    const hits = this.store.notes.filter((x) => x.n === lane);
    if (this.variations === 'cycle') {
      hits.forEach((h, i) => out.set(h.id, takes[i % takes.length]));
      return out;
    }
    let seed = (lane * 7919 + takes.reduce((a, k) => a * 31 + k + 1, 17)) >>> 0;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    let a = -1;
    let b = -1;
    for (const h of hits) {
      let k = takes[Math.floor(rnd() * takes.length)];
      for (let guard = 0; k === a && k === b && guard < 8; guard++) k = takes[Math.floor(rnd() * takes.length)];
      out.set(h.id, k);
      b = a;
      a = k;
    }
    return out;
  }

  get isPlaying() { return this.state !== 'stopped'; }
  get isRecording() { return this.state === 'recording'; }

  async resume() {
    if (this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch { /* needs a user gesture */ }
    }
  }

  applyMix() {
    const p = this.store.project;
    const m = p.mix;
    const now = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(m.master, now, 0.02);
    this.drumsBus.gain.setTargetAtTime(m.drums, now, 0.02);
    this.backingBus.gain.setTargetAtTime(p.backing && p.backing.muted ? 0 : m.backing, now, 0.02);
    this.clickBus.gain.setTargetAtTime(m.click, now, 0.02);
  }

  // -- time mapping --------------------------------------------------------
  // Context time of the sound you are hearing right now (or at perf time ms).
  audibleCtxTime(perfMs = performance.now()) {
    const ctx = this.ctx;
    if (ctx.getOutputTimestamp) {
      const ts = ctx.getOutputTimestamp();
      if (ts.contextTime > 0 && ts.performanceTime > 0) return ts.contextTime + (perfMs - ts.performanceTime) / 1000;
    }
    return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0) + (perfMs - performance.now()) / 1000;
  }

  perfTimeForCtx(c) {
    const ctx = this.ctx;
    if (ctx.getOutputTimestamp) {
      const ts = ctx.getOutputTimestamp();
      if (ts.contextTime > 0 && ts.performanceTime > 0) return ts.performanceTime + (c - ts.contextTime) * 1000;
    }
    return performance.now() + (c - ctx.currentTime + (ctx.outputLatency || ctx.baseLatency || 0)) * 1000;
  }

  posAtCtx(c) {
    const tl = this.timeline;
    if (!tl.length) return this.stoppedPos;
    if (c <= tl[0].ctx) return tl[0].pos;
    let e = tl[0];
    for (const entry of tl) { if (entry.ctx <= c + 1e-9) e = entry; else break; }
    return e.pos + (c - e.ctx);
  }

  get position() {
    if (this.state === 'stopped') return this.stoppedPos;
    return this.posAtCtx(this.audibleCtxTime());
  }

  // Song position of a MIDI hit, given its event timestamp.
  posForPerfTime(perfMs) {
    return this.posAtCtx(this.audibleCtxTime(perfMs));
  }

  songEnd() {
    const p = this.store.project;
    let end = this.store.lastNoteTime() + 2;
    if (p.backing && this.backingBuffer) end = Math.max(end, (p.backing.offset || 0) + this.backingBuffer.duration);
    if (p.loop.on) end = Math.max(end, p.loop.end);
    return end;
  }

  hasContent() {
    return this.store.notes.length > 0 || !!(this.store.project.backing && this.backingBuffer);
  }

  seek(pos) {
    const p = Math.max(-0.0001, pos);
    if (this.state === 'stopped') {
      this.stoppedPos = Math.max(0, p);
      this.emit('seek', this.stoppedPos);
      this.segments.pump();
      return;
    }
    if (this.state === 'playing') {
      this.restartAt(Math.max(0, p));
    }
  }

  // -- transport ------------------------------------------------------------
  async play(fromPos = this.stoppedPos, { record = false, countIn = 0, mode = 'replace' } = {}) {
    await this.resume();
    if (this.state !== 'stopped') this.stop({ keepPosition: true });
    const p = this.store.project;
    if (this.usesEngine && this.segments.enabled && !record) {
      const idx = Math.floor(Math.max(0, fromPos) / SEG);
      if (!this.segments.isReady(idx)) {
        this.emit('preparing', true);
        await this.segments.waitFor(idx);
        this.emit('preparing', false);
      }
    }
    const startPos = record ? fromPos - countIn : fromPos;
    this.recordFrom = record ? fromPos : null;
    this.recordMode = mode;
    this.playStartPos = fromPos;
    const startCtx = this.ctx.currentTime + 0.08;
    this.timeline = [{ ctx: startCtx, pos: startPos }];
    this.schedCtx = startCtx;
    this.schedPos = startPos;
    this.state = record ? 'recording' : 'playing';
    this.rampIn(startCtx);
    this.startBacking(startPos, startCtx);
    if (this.playsPlugin()) this.segments.startPass(startPos, startCtx);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
    this.emit('state', this.state);
  }

  // How much open hi-hats and crashes played in a row ring into each other, 0..1
  // (sample kits and built-in kits).
  get blend() { return this._blend; }
  set blend(b) {
    this._blend = { hat: clamp(Number(b?.hat) || 0, 0, 1), cym: clamp(Number(b?.cym) || 0, 0, 1) };
    this.kit.blend = this._blend;
  }

  playsPlugin() {
    return this.usesEngine && this.segments.enabled && !(this.state === 'recording' && this.recordMode === 'replace');
  }

  rampIn(when) {
    const g = this.pluginBus.gain;
    g.cancelScheduledValues(when);
    g.setValueAtTime(0, when);
    g.linearRampToValueAtTime(1, when + 0.01);
  }

  restartAt(pos) {
    const wasRecording = this.state === 'recording';
    if (wasRecording) return;
    this.halt();
    const startCtx = this.ctx.currentTime + 0.05;
    this.timeline = [{ ctx: startCtx, pos }];
    this.schedCtx = startCtx;
    this.schedPos = pos;
    this.playStartPos = pos;
    this.startBacking(pos, startCtx);
    if (this.playsPlugin()) this.segments.startPass(pos, startCtx);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
    this.emit('seek', pos);
  }

  halt() {
    clearInterval(this.timer);
    this.timer = null;
    const now = this.ctx.currentTime;
    for (const s of this.backingSources) { try { s.stop(now + 0.01); } catch { /* stopped */ } }
    this.backingSources.clear();
    this.segments.stopAll(now);
    this.kit.stopAll(now);
  }

  stop({ keepPosition = false } = {}) {
    if (this.state === 'stopped') return null;
    const endedAt = this.position;
    this.halt();
    const wasRecording = this.state === 'recording';
    this.state = 'stopped';
    this.stoppedPos = keepPosition ? Math.max(0, endedAt) : Math.max(0, this.playStartPos);
    this.timeline = [];
    this.recordFrom = null;
    this.emit('state', this.state);
    this.emit('seek', this.stoppedPos);
    return { endedAt, wasRecording };
  }

  tick() {
    const p = this.store.project;
    const horizon = this.ctx.currentTime + LOOKAHEAD;
    let guard = 0;
    while (this.schedCtx < horizon && guard++ < 40) {
      const loop = p.loop;
      const looping = loop.on && this.state === 'playing' && loop.end - loop.start > 0.05 && this.schedPos < loop.end;
      let pos1 = this.schedPos + (horizon - this.schedCtx);
      let wrap = false;
      if (looping && pos1 >= loop.end) { pos1 = loop.end; wrap = true; }
      this.scheduleRange(this.schedPos, pos1, this.schedCtx);
      this.schedCtx += pos1 - this.schedPos;
      this.schedPos = pos1;
      if (wrap) {
        this.timeline.push({ ctx: this.schedCtx, pos: loop.start });
        this.schedPos = loop.start;
        this.onWrap(this.schedCtx);
      }
    }
    const audible = this.audibleCtxTime();
    while (this.timeline.length > 1 && this.timeline[1].ctx <= audible) this.timeline.shift();
    if (this.state === 'playing' && !p.loop.on && this.hasContent() && this.position > this.songEnd() + 0.3) {
      this.stop();
      return;
    }
    if (this.usesEngine) {
      for (const idx of [...this.segments.late.keys()]) if (this.segments.isReady(idx)) this.segments.startLate(idx);
      this.segments.pump();
    }
  }

  scheduleRange(p0, p1, c0) {
    if (p1 <= p0) return;
    const p = this.store.project;
    const at = (pos) => c0 + (pos - p0);
    // Metronome (always during the count-in), following tempo changes
    const segs = tempoSegments(p);
    let k = Math.ceil(beatAt(p, p0, segs) - 1e-9);
    for (let guard = 0; guard < 64; guard++, k++) {
      const t = timeAtBeat(p, k, segs);
      if (t >= p1 - 1e-9) break;
      if (t < p0 - 1e-9) continue;
      const inCountIn = this.recordFrom !== null && t < this.recordFrom - 1e-6;
      if (this.clickOn || inCountIn) {
        const beat = ((k % p.sig[0]) + p.sig[0]) % p.sig[0];
        scheduleClick(this.ctx, this.clickBus, at(t), beat === 0);
      }
    }
    // Drums
    const type = this.soundType;
    if (type === 'kit' || type === 'module') {
      const notes = this.store.notes;
      const replacing = this.state === 'recording' && this.recordMode === 'replace';
      for (let i = lowerBound(notes, Math.max(0, p0)); i < notes.length && notes[i].t < p1; i++) {
        const n = notes[i];
        if (p.mutes.includes(n.n)) continue;
        if (replacing && n.t >= this.recordFrom - 0.01) continue;
        if (type === 'kit') this.kit.play(at(n.t), n.n, n.v, p.drumMap, p.mix, n.ch || 0);
        else this.sendModule(at(n.t), n.n, n.v, n.ch || 0);
      }
    } else if ((type === 'plugin' || type === 'sfz') && this.playsPlugin()) {
      this.segments.scheduleBoundaries(p0, p1, c0);
    }
  }

  onWrap(when) {
    const p = this.store.project;
    for (const s of this.backingSources) { try { s.stop(when); } catch { /* stopped */ } }
    this.startBacking(p.loop.start, when);
    if (this.playsPlugin()) {
      this.segments.stopAll(when);
      this.segments.startPass(p.loop.start, when);
    }
  }

  startBacking(pos, when) {
    const b = this.store.project.backing;
    const buffer = this.backingBuffer;
    if (!b || !buffer) return;
    let offset = pos - (b.offset || 0);
    let startAt = when;
    if (offset < 0) { startAt = when - offset; offset = 0; }
    if (offset >= buffer.duration) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.backingBus);
    src.start(startAt, offset);
    this.backingSources.add(src);
    src.onended = () => this.backingSources.delete(src);
  }

  sendModule(when, note, vel, choke = 0) {
    const out = this.moduleOut;
    if (!out) return;
    const t = this.perfTimeForCtx(when);
    try {
      out.send([0x99, note & 127, vel & 127], t);
      out.send([0x89, note & 127, 0], t + 40);
      if (choke > 0) {
        // A grab, the way the module itself reports one: polyphonic aftertouch.
        out.send([0xa9, note & 127, 127], t + choke * 1000);
        out.send([0xa9, note & 127, 0], t + choke * 1000 + 60);
      }
    } catch { /* device went away */ }
  }

  // Play one hit right now (for clicking on lanes and live monitoring).
  audition(note, vel = 100) {
    this.resume();
    const p = this.store.project;
    if (this.soundType === 'sfz' && this.segments.enabled && !this.isPlaying) {
      this.auditionEngine(note, vel);
      return;
    }
    const when = this.ctx.currentTime + 0.005;
    if (this.soundType === 'module' && this.moduleOut) this.sendModule(this.ctx.currentTime + 0.01, note, vel);
    else if (this.sampler.kit) this.kit.play(when, note, vel, p.drumMap, p.mix);
  }

  // Hear one hit from the sample kit (rendered by the engine). `route` plays a
  // sound that isn't assigned yet (for trying sounds in the sound picker).
  async auditionEngine(note, vel, route = null) {
    const token = (this._auditionToken = (this._auditionToken || 0) + 1);
    if (this._auditionBusy) { this._auditionNext = [note, vel, route]; return; }
    this._auditionBusy = true;
    try {
      const hit = route
        ? { notes: [[0.0, this.engineNote(note), vel, 0]], routes: [route] }
        : this.engineHits([{ t: 0.0, n: note, v: vel }]);
      const res = await api.render({
        notes: hit.notes, routes: hit.routes, ccs: [], start: 0, preroll: 0, length: 2.2,
        sampleRate: this.ctx.sampleRate, cc: this.engineCC(), variations: this.variations, blend: this.blend, pedalStop: this.pedalStop,
      });
      if (token === this._auditionToken || !this._auditionNext) {
        const buf = this.ctx.createBuffer(2, res.frames, res.sampleRate || this.ctx.sampleRate);
        buf.copyToChannel(res.data[0], 0);
        buf.copyToChannel(res.data[1] || res.data[0], 1);
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.drumsBus);
        src.start();
      }
    } catch {
      const p = this.store.project;
      if (this.sampler.kit) this.kit.play(this.ctx.currentTime + 0.005, note, vel, p.drumMap, p.mix);
    } finally {
      this._auditionBusy = false;
      if (this._auditionNext) {
        const [n, v, r] = this._auditionNext;
        this._auditionNext = null;
        this.auditionEngine(n, v, r);
      }
    }
  }

  // Live monitoring while recording always uses the built-in kit.
  monitor(note, vel) {
    if (!this.sampler.kit) return;
    const p = this.store.project;
    this.kit.play(this.ctx.currentTime + 0.003, note, vel, p.drumMap, p.mix);
  }

  // A cymbal grabbed on the module while you hear it through Simple DAW.
  monitorChoke(note) {
    if (!this.sampler.kit) return;
    this.kit.grabNote(note, this.store.project.drumMap, this.ctx.currentTime + 0.003);
  }

  async setBackingFromUrl(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('The backing track file is missing.');
    const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
    this.backingBuffer = buf;
    return buf;
  }

  // -- offline render for export ---------------------------------------------
  async renderOffline({ start, end, includeBacking, pluginAudio, onProgress }) {
    const p = this.store.project;
    const sr = this.ctx.sampleRate;
    const length = Math.max(1, Math.ceil((end - start) * sr));
    const off = new OfflineAudioContext(2, length, sr);
    const master = off.createGain();
    master.gain.value = 1;
    master.connect(off.destination);
    const drums = off.createGain();
    drums.gain.value = p.mix.drums;
    drums.connect(master);
    if (pluginAudio) {
      const buf = off.createBuffer(2, pluginAudio.frames, sr);
      buf.copyToChannel(pluginAudio.data[0], 0);
      buf.copyToChannel(pluginAudio.data[1] || pluginAudio.data[0], 1);
      const src = off.createBufferSource();
      src.buffer = buf;
      src.connect(drums);
      src.start(0);
    } else {
      const player = new KitPlayer(this.sampler, off, drums);
      for (const n of this.store.notes) {
        if (n.t < start || n.t >= end || p.mutes.includes(n.n)) continue;
        player.play(n.t - start, n.n, n.v, p.drumMap, p.mix);
      }
    }
    if (includeBacking && p.backing && this.backingBuffer) {
      const g = off.createGain();
      g.gain.value = p.mix.backing;
      g.connect(master);
      let offset = start - (p.backing.offset || 0);
      let when = 0;
      if (offset < 0) { when = -offset; offset = 0; }
      if (offset < this.backingBuffer.duration) {
        const src = off.createBufferSource();
        src.buffer = this.backingBuffer;
        src.connect(g);
        src.start(when, offset);
      }
    }
    onProgress?.(0.5);
    const rendered = await off.startRendering();
    onProgress?.(0.9);
    return [rendered.getChannelData(0), rendered.getChannelData(1)];
  }
}
