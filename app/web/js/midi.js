// Drum module connection through Web MIDI.

import { Emitter } from './util.js';

const IGNORE_PORT = /midi through|microsoft gs wavetable|loopmidi/i;

export class MidiIO extends Emitter {
  constructor() {
    super();
    this.access = null;
    this.status = 'starting'; // starting | ok | none | denied | unsupported
    this.error = null;
    this.inputId = 'all';
    this.outputId = 'auto';
    this.inputs = [];
    this.outputs = [];
    this.lastDevice = null;
  }

  async init() {
    if (!navigator.requestMIDIAccess) {
      this.status = 'unsupported';
      this.emit('status');
      return;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (err) {
      this.error = err;
      this.status = 'denied';
      this.emit('status');
      return;
    }
    this.access.onstatechange = () => this.refresh();
    this.refresh();
  }

  refresh() {
    if (!this.access) return;
    const inputs = [...this.access.inputs.values()].filter((p) => p.state === 'connected');
    const outputs = [...this.access.outputs.values()].filter((p) => p.state === 'connected');
    this.inputs = inputs.map((p) => ({ id: p.id, name: p.name, manufacturer: p.manufacturer }));
    this.outputs = outputs.map((p) => ({ id: p.id, name: p.name }));
    for (const port of this.access.inputs.values()) {
      const wanted = port.state === 'connected' && this.listensTo(port);
      port.onmidimessage = wanted ? (e) => this.onMessage(e, port) : null;
    }
    const usable = this.activeInputs();
    this.status = usable.length ? 'ok' : 'none';
    this.emit('status');
  }

  listensTo(port) {
    if (this.inputId === 'all') return !IGNORE_PORT.test(port.name || '');
    return port.id === this.inputId;
  }

  activeInputs() {
    if (!this.access) return [];
    return [...this.access.inputs.values()].filter((p) => p.state === 'connected' && this.listensTo(p));
  }

  get deviceName() {
    const list = this.activeInputs();
    if (!list.length) return null;
    if (this.lastDevice && list.some((p) => p.name === this.lastDevice)) return this.lastDevice;
    return list.map((p) => p.name).join(', ');
  }

  get output() {
    if (!this.access) return null;
    const outs = [...this.access.outputs.values()].filter((p) => p.state === 'connected');
    if (this.outputId && this.outputId !== 'auto') return outs.find((p) => p.id === this.outputId) || null;
    // Auto: the output whose name matches the input we hear from.
    const inNames = this.activeInputs().map((p) => (p.name || '').toLowerCase());
    return outs.find((p) => inNames.some((n) => n && (p.name || '').toLowerCase().includes(n.slice(0, 6))))
      || outs.find((p) => !IGNORE_PORT.test(p.name || '')) || null;
  }

  setInput(id) {
    this.inputId = id || 'all';
    this.refresh();
  }

  setOutput(id) {
    this.outputId = id || 'auto';
    this.emit('status');
  }

  onMessage(e, port) {
    const d = e.data;
    if (!d || d.length < 2) return;
    const status = d[0];
    if (status >= 0xf0) return; // clock, active sensing, sysex
    const type = status & 0xf0;
    const channel = status & 0x0f;
    this.lastDevice = port.name;
    if (type === 0x90 && d[2] > 0) {
      this.emit('hit', { note: d[1], vel: d[2], channel, time: e.timeStamp, port: port.name });
    } else if (type === 0xb0) {
      this.emit('cc', { cc: d[1], value: d[2], channel, time: e.timeStamp });
    }
  }
}
