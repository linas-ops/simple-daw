// WAV encoding (PCM 16/24-bit) and audio peak helpers.

export function encodeWav(channels, sampleRate, bitDepth = 24) {
  const numCh = channels.length;
  const frames = channels[0].length;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  let off = 44;
  const max = bitDepth === 24 ? 8388607 : 32767;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = channels[c][i];
      s = s > 1 ? 1 : s < -1 ? -1 : s;
      const v = Math.round(s * max);
      if (bitDepth === 24) {
        view.setUint8(off, v & 255);
        view.setUint8(off + 1, (v >> 8) & 255);
        view.setUint8(off + 2, (v >> 16) & 255);
        off += 3;
      } else {
        view.setInt16(off, v, true);
        off += 2;
      }
    }
  }
  return buffer;
}

export function peakOf(channels) {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

// Min/max pairs for drawing a waveform overview.
export function computePeaks(audioBuffer, samplesPerPeak = 256) {
  const frames = audioBuffer.length;
  const count = Math.ceil(frames / samplesPerPeak);
  const peaks = new Float32Array(count * 2);
  const chans = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) chans.push(audioBuffer.getChannelData(c));
  for (let i = 0; i < count; i++) {
    let lo = 0, hi = 0;
    const start = i * samplesPerPeak;
    const end = Math.min(frames, start + samplesPerPeak);
    for (const ch of chans) {
      for (let j = start; j < end; j++) {
        const s = ch[j];
        if (s < lo) lo = s;
        if (s > hi) hi = s;
      }
    }
    peaks[i * 2] = lo;
    peaks[i * 2 + 1] = hi;
  }
  return { peaks, samplesPerPeak, sampleRate: audioBuffer.sampleRate, duration: audioBuffer.duration };
}
