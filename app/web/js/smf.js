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
 * hits: [{t, n, v}], ccs: [{t, c, v}], sig: [num, den]
 */
export function writeMidi({ hits, ccs = [], tempo = 120, sig = [4, 4], channel = 9, ppq = 960, name = 'Drums' }) {
  const secPerTick = 60 / tempo / ppq;
  const events = [];
  for (const h of hits) {
    const tick = Math.max(0, Math.round(h.t / secPerTick));
    events.push({ tick, order: 1, data: [0x90 | channel, h.n & 127, Math.max(1, Math.min(127, Math.round(h.v)))] });
    events.push({ tick: tick + Math.round(ppq / 8), order: 0, data: [0x80 | channel, h.n & 127, 0] });
  }
  for (const c of ccs) {
    const tick = Math.max(0, Math.round(c.t / secPerTick));
    events.push({ tick, order: 0.5, data: [0xb0 | channel, c.c & 127, c.v & 127] });
  }
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const track = [];
  const nameBytes = [...new TextEncoder().encode(name)].slice(0, 120);
  track.push(0, 0xff, 0x03, ...vlq(nameBytes.length), ...nameBytes);
  const usPerQuarter = Math.round(60000000 / tempo);
  track.push(0, 0xff, 0x51, 0x03, (usPerQuarter >> 16) & 255, (usPerQuarter >> 8) & 255, usPerQuarter & 255);
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
 * Read any type-0/1 file. Returns hits with times in seconds, the first tempo
 * (quarter notes per minute) and the first time signature found.
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
    const ccs = raw
      .filter((e) => e.kind === 'cc' && e.c === 4 && (!drumChannel || e.ch === 9))
      .map((e) => ({ t: toSeconds(e.tick), c: e.c, v: e.v }));
    const firstTempo = tempos.length ? 60000000 / tempos[0].us : 120;
    return { hits, ccs, tempo: Math.round(firstTempo * 100) / 100, sig: sig || [4, 4], format };
  }
}
