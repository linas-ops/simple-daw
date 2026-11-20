// Standard MIDI File reading and writing.

function vlq(value) {
  const bytes = [value & 0x7f];
  value >>= 7;
  while (value > 0) {
    bytes.unshift((value & 0x7f) | 0x80);
    value >>= 7;
  }
  return bytes;
}

function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function u16(n) { return [(n >>> 8) & 255, n & 255]; }

/**
 * Write a type-0 file. Times are in seconds; tempo is quarter notes per minute.
 * hits: [{t, n, v, ch?}] (ch: seconds until the cymbal is choked), ccs: [{t, c, v}],
 * sig: [num, den], tempos: [{t, bpm}] tempo changes (quarter notes per minute) after the start.
 * A choke is written as polyphonic aftertouch, the way drum modules send a cymbal grab.
 */
export function writeMidi({ hits, ccs = [], tempo = 120, tempos = [], sig = [4, 4], channel = 9, ppq = 960, name = 'Drums' }) {
  // Seconds -> ticks through the tempo changes.
  const segs = [{ t: 0, tick: 0, bpm: tempo }];
  for (const c of [...tempos].sort((a, b) => a.t - b.t)) {
    const last = segs[segs.length - 1];
    if (!(c.t > last.t) || !(c.bpm > 0)) continue;
    segs.push({ t: c.t, tick: last.tick + ((c.t - last.t) * last.bpm * ppq) / 60, bpm: c.bpm });
  }
  const toTick = (t) => {
    let s = segs[0];
    for (const seg of segs) { if (seg.t <= t + 1e-9) s = seg; else break; }
    return Math.max(0, Math.round(s.tick + ((t - s.t) * s.bpm * ppq) / 60));
  };
  const events = [];
  for (const h of hits) {
    const tick = toTick(h.t);
    events.push({ tick, order: 1, data: [0x90 | channel, h.n & 127, Math.max(1, Math.min(127, Math.round(h.v)))] });
    events.push({ tick: tick + Math.round(ppq / 8), order: 0, data: [0x80 | channel, h.n & 127, 0] });
    if (h.ch > 0) {
      const at = Math.max(tick + 1, toTick(h.t + h.ch));
      events.push({ tick: at, order: 2, data: [0xa0 | channel, h.n & 127, 127] });
      events.push({ tick: at + Math.round(ppq / 16), order: 2, data: [0xa0 | channel, h.n & 127, 0] });
    }
  }
  for (const c of ccs) {
    events.push({ tick: toTick(c.t), order: 0.5, data: [0xb0 | channel, c.c & 127, c.v & 127] });
  }
  const tempoBytes = (bpm) => {
    const us = Math.round(60000000 / bpm);
    return [0xff, 0x51, 0x03, (us >> 16) & 255, (us >> 8) & 255, us & 255];
  };
  for (const seg of segs.slice(1)) events.push({ tick: Math.round(seg.tick), order: -1, data: tempoBytes(seg.bpm) });
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const track = [];
  const nameBytes = [...new TextEncoder().encode(name)].slice(0, 120);
  track.push(0, 0xff, 0x03, ...vlq(nameBytes.length), ...nameBytes);
  track.push(0, ...tempoBytes(tempo));
  const denPow = Math.round(Math.log2(sig[1] || 4));
  track.push(0, 0xff, 0x58, 0x04, sig[0] & 255, denPow, 24, 8);
  let last = 0;
  for (const e of events) {
    track.push(...vlq(e.tick - last), ...e.data);
    last = e.tick;
  }
  track.push(0, 0xff, 0x2f, 0x00);

  const bytes = [
    ...[0x4d, 0x54, 0x68, 0x64], ...u32(6), ...u16(0), ...u16(1), ...u16(ppq),
    ...[0x4d, 0x54, 0x72, 0x6b], ...u32(track.length), ...track,
  ];
  return new Uint8Array(bytes);
}

/**
 * Read any type-0/1 file. Returns hits with times in seconds (a choked cymbal has ch,
 * the seconds until polyphonic aftertouch grabbed it), the first tempo (quarter notes
 * per minute), later tempo changes as [{t, bpm, quarter}] (quarter: quarter notes from
 * the start) and the first time signature found.
 */
export function readMidi(buffer) {
  const data = new Uint8Array(buffer);
  let pos = 0;
  const str = (n) => { const s = String.fromCharCode(...data.slice(pos, pos + n)); pos += n; return s; };
  const r32 = () => { const v = (data[pos] << 24 | data[pos + 1] << 16 | data[pos + 2] << 8 | data[pos + 3]) >>> 0; pos += 4; return v; };
  const r16 = () => { const v = data[pos] << 8 | data[pos + 1]; pos += 2; return v; };
  const rvlq = () => {
    let v = 0, b;
    do { b = data[pos++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80 && pos < data.length);
    return v;
  };

  if (str(4) !== 'MThd') throw new Error('This is not a MIDI file.');
  const headerLen = r32();
  const format = r16();
  const nTracks = r16();
  const division = r16();
  pos = 8 + headerLen;
  if (division & 0x8000) {
    // SMPTE timing: ticks per second = fps * ticks per frame
    const fps = 256 - (division >> 8);
    const tpf = division & 0xff;
    return readTracks(nTracks, () => ({ secPerTick: 1 / (fps * tpf) }));
  }
  const ppq = division;
  return readTracks(nTracks, () => ({ ppq }));

  function readTracks(count, timing) {
    const raw = []; // {tick, kind, ...}
    const tempos = []; // {tick, us}
    let sig = null;
    for (let tr = 0; tr < count && pos < data.length; tr++) {
      if (str(4) !== 'MTrk') break;
      const len = r32();
      const end = pos + len;
      let tick = 0;
      let running = 0;
      while (pos < end) {
        tick += rvlq();
        let status = data[pos];
        if (status < 0x80) status = running; else pos++;
        if (status === 0xff) {
          const type = data[pos++];
          const mlen = rvlq();
          if (type === 0x51 && mlen === 3) tempos.push({ tick, us: (data[pos] << 16) | (data[pos + 1] << 8) | data[pos + 2] });
          if (type === 0x58 && mlen >= 2 && !sig) sig = [data[pos], 2 ** data[pos + 1]];
          pos += mlen;
        } else if (status === 0xf0 || status === 0xf7) {
          pos += rvlq();
        } else {
          running = status;
          const type = status & 0xf0;
          const ch = status & 0x0f;
          const d1 = data[pos++];
          const d2 = (type === 0xc0 || type === 0xd0) ? 0 : data[pos++];
          if (type === 0x90 && d2 > 0) raw.push({ tick, kind: 'note', n: d1, v: d2, ch });
          else if (type === 0xb0) raw.push({ tick, kind: 'cc', c: d1, v: d2, ch });
          else if (type === 0xa0 && d2 > 0) raw.push({ tick, kind: 'choke', n: d1, ch });
        }
      }
      pos = end;
    }
    const t = timing();
    let toSeconds;
    if (t.secPerTick) {
      toSeconds = (tick) => tick * t.secPerTick;
    } else {
      tempos.sort((a, b) => a.tick - b.tick);
      if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, us: 500000 });
      const segs = [];
      let secs = 0;
      for (let i = 0; i < tempos.length; i++) {
        const cur = tempos[i];
        segs.push({ tick: cur.tick, secs, spt: cur.us / 1e6 / t.ppq });
        const next = tempos[i + 1];
        if (next) secs += (next.tick - cur.tick) * (cur.us / 1e6 / t.ppq);
      }
      toSeconds = (tick) => {
        let s = segs[0];
        for (const seg of segs) { if (seg.tick <= tick) s = seg; else break; }
        return s.secs + (tick - s.tick) * s.spt;
      };
    }
    const notes = raw.filter((e) => e.kind === 'note');
    const drumChannel = notes.some((e) => e.ch === 9);
    const hits = notes
      .filter((e) => !drumChannel || e.ch === 9)
      .map((e) => ({ t: toSeconds(e.tick), n: e.n, v: e.v }))
      .sort((a, b) => a.t - b.t);
    // A grab (polyphonic aftertouch) chokes the last hit of that cymbal before it.
    const lastHit = new Map();
    let hi = 0;
    for (const e of raw.filter((x) => x.kind === 'choke' && (!drumChannel || x.ch === 9)).sort((a, b) => a.tick - b.tick)) {
      const at = toSeconds(e.tick);
      while (hi < hits.length && hits[hi].t <= at) { lastHit.set(hits[hi].n, hits[hi]); hi++; }
      const h = lastHit.get(e.n);
      if (h && !h.ch && at - h.t > 0.005 && at - h.t < 15) h.ch = at - h.t;
    }
    const ccs = raw
      .filter((e) => e.kind === 'cc' && e.c === 4 && (!drumChannel || e.ch === 9))
      .map((e) => ({ t: toSeconds(e.tick), c: e.c, v: e.v }));
    const firstTempo = tempos.length ? 60000000 / tempos[0].us : 120;
    const quarterOf = (tick) => (t.ppq ? tick / t.ppq : 0);
    const changes = t.secPerTick ? [] : tempos
      .filter((x) => x.tick > 0)
      .map((x) => ({ t: toSeconds(x.tick), bpm: Math.round((60000000 / x.us) * 100) / 100, quarter: quarterOf(x.tick) }));
    return { hits, ccs, tempo: Math.round(firstTempo * 100) / 100, tempos: changes, sig: sig || [4, 4], format };
  }
}
