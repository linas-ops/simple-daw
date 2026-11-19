// Simple DAW: wires the interface, the song, audio, MIDI and the server together.

import { $, el, icon, setIcon, hydrateIcons, clamp, debounce, fmtTime, fmtDuration, fmtDate, isTyping, uid } from './util.js';
import { api } from './api.js';
import { Store, newProject, newTake, GRIDS, barDur, beatDur, barBeatAt, quarterBpm, timeOfBar } from './state.js';
import { AudioEngine, PRE } from './audio.js';
import { MidiIO } from './midi.js';
import { Timeline } from './timeline.js';
import { MAPS, FAMILIES, laneInfo, outputNote, getMap, sortLanes } from './drummap.js';
import { readMidi, writeMidi } from './smf.js';
import { encodeWav, computePeaks, peakOf } from './wav.js';
import { toast, initTooltips, popover, closePopover, menuItem, modal, modalIsOpen, confirmBox, choiceBox } from './ui.js';

const DEFAULT_SETTINGS = {
  drumMap: 'gm',
  midiInput: 'all',
  midiOutput: 'auto',
  latencyMs: 0,
  monitor: false,
  countIn: 1,
  recordMode: 'replace',
  click: true,
  snap: true,
  grid: '16',
  drawVelocity: 100,
  quantizeStrength: 100,
  humanizeMs: 8,
  humanizeVel: 8,
  welcomed: false,
  lastProject: null,
  myKits: [], // kits you put together: a main sample kit plus drums borrowed from others
};

class App {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS };
    this.store = new Store();
    this.audio = new AudioEngine(this.store);
    this.midi = new MidiIO();
    this.timeline = new Timeline(this);
    this.recBuffer = null;
    this.savedVersion = 0;
    this.saveError = false;
    this.serverOk = true;
    this.engineAvailable = false;
    this.kitsEngine = false;
    this.kitData = null;
    this.kitControls = [];
    this.mainKeys = null;     // keys the main sample kit has sounds on
    this.kitKeys = new Map(); // program path -> Set of keys (kits single drums borrow from)
    this.audio.routeFor = (note) => this.routeFor(note);
    this.pluginStatus = 'none';
    this.pluginError = null;
    this.kitProgress = null;
    this.plugins = null;
    this.taps = [];
    this.lastHint = null;
  }

  // =====================================================================
  // Start-up
  // =====================================================================
  async boot() {
    hydrateIcons();
    initTooltips();
    this.bindTopbar();
    this.bindTransport();
    this.bindToolbar();
    this.bindKeys();
    this.bindStore();
    this.bindAudio();
    this.bindMidi();
    this.startReadoutLoop();

    let hello = null;
    try {
      hello = await api.hello();
    } catch {
      this.serverOk = false;
    }
    if (hello) {
      this.engineAvailable = !!hello.engine;
      this.kitsEngine = !!hello.kitsEngine;
      this.folders = hello.folders;
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (hello.settings && hello.settings[key] !== undefined) this.settings[key] = hello.settings[key];
      }
    }
    this.applySettings();

    let loaded = false;
    if (this.serverOk && this.settings.lastProject) {
      try {
        const r = await api.loadProject(this.settings.lastProject);
        this.store.load(r.project, r.file);
        loaded = true;
      } catch { /* start fresh */ }
    }
    if (!loaded) this.store.load(newProject(), null);
    await this.afterLoad();

    this.midi.inputId = this.settings.midiInput || 'all';
    this.midi.outputId = this.settings.midiOutput || 'auto';
    this.midi.init();

    setInterval(() => { if (this.serverOk) api.heartbeat(); }, 20000);
    window.addEventListener('pagehide', () => { this.saveNow(true); api.bye(); });
    const unlock = () => this.audio.resume();
    window.addEventListener('pointerdown', unlock, { once: true, capture: true });
    window.addEventListener('keydown', unlock, { once: true, capture: true });

    if (!this.serverOk) this.showOffline();
    else if (!this.settings.welcomed) this.showWelcome();
  }

  applySettings() {
    const s = this.settings;
    this.audio.clickOn = !!s.click;
    this.timeline.snap = !!s.snap;
    this.timeline.grid = GRIDS[s.grid] ? s.grid : '16';
    $('#grid').value = this.timeline.grid;
    this.setPressed('#btn-click', s.click);
    this.setPressed('#btn-snap', s.snap);
    this.setPressed('#btn-countin', s.countIn > 0);
    $('#countin-label').textContent = s.countIn > 0 ? `Count-in ${s.countIn} bar${s.countIn > 1 ? 's' : ''}` : 'No count-in';
    this.setPressed('#rec-mode-replace', s.recordMode !== 'add');
    this.setPressed('#rec-mode-add', s.recordMode === 'add');
  }

  saveSetting(values) {
    Object.assign(this.settings, values);
    this.applySettings();
    if (this.serverOk) api.saveSettings(values);
  }

  async afterLoad() {
    const p = this.store.project;
    p.drumMap = this.settings.drumMap;
    this.audio.stop();
    this.audio.stoppedPos = 0;
    this.timeline.selection.clear();
    this.timeline.seenNotes.clear();
    this.timeline.rebuildLanes(true);
    $('#song-name').value = p.name;
    this.syncSongUI();
    this.audio.backingBuffer = null;
    this.timeline.setBackingPeaks(null);
    $('#backing-row').hidden = !p.backing;
    if (p.backing) this.loadBacking(p.backing).catch(() => {});
    this.audio.applyMix();
    if (this.store.notes.length) this.timeline.fit();
    else { this.timeline.pps = 90; this.timeline.scrollX = -0.2; this.timeline.emit('zoom', 90); }
    this.savedVersion = this.store.version;
    this.updateSaveState();
    this.updateEmptyState();
    await this.activateSound();
  }

  async loadBacking(b) {
    const buf = await this.audio.setBackingFromUrl(api.mediaUrl(b.media));
    this.timeline.setBackingPeaks(computePeaks(buf));
    $('#backing-name').textContent = b.name || 'Backing track';
    $('#backing-row').hidden = false;
    this.syncBackingButtons();
    this.timeline.resize();
  }

  // =====================================================================
  // Sound sources
  // =====================================================================
  async activateSound() {
    const s = this.store.project.sound;
    this.audio.segments.enabled = false;
    const kitId = s.kit || 'black-pearl';
    const kitPromise = this.loadKit(kitId);
    if (s.type === 'plugin' && s.plugin) {
      await this.loadPlugin(s.plugin);
    } else if (s.type === 'sfz' && s.sfz) {
      await this.refreshKitData();
      await this.loadSfz(s.sfz);
    } else if (s.type === 'module') {
      this.audio.moduleOut = this.midi.output;
    }
    await kitPromise;
    this.updateSoundButton();
  }

  async loadKit(kitId) {
    if (this.audio.sampler.kitId === kitId) return;
    this.kitProgress = 0;
    this.updateSoundButton();
    try {
      await this.audio.sampler.load(kitId, (f) => { this.kitProgress = f; this.updateEngineStatus(); });
    } catch (err) {
      toast(`The built-in kit couldn't load: ${err.message}`, { error: true });
    }
    this.kitProgress = null;
    this.updateSoundButton();
  }

  async chooseKit(kitId) {
    const p = this.store.project;
    p.sound = { ...p.sound, type: 'kit', kit: kitId };
    this.audio.segments.enabled = false;
    this.store.touch('sound');
    await this.loadKit(kitId);
    this.updateSoundButton();
    this.audio.audition(38, 100);
  }

  chooseModule() {
    const out = this.midi.output;
    if (!out) {
      toast('Connect your drum module with USB to play through its own sounds.', { error: true });
      return;
    }
    const p = this.store.project;
    p.sound = { ...p.sound, type: 'module' };
    this.audio.segments.enabled = false;
    this.audio.moduleOut = out;
    this.store.touch('sound');
    this.updateSoundButton();
  }

  async choosePlugin(pl) {
    this.audio.stop();
    const p = this.store.project;
    const keepState = p.sound.plugin && p.sound.plugin.path === pl.path ? p.sound.plugin.state : null;
    p.sound = { ...p.sound, type: 'plugin', plugin: { path: pl.path, name: pl.name, format: pl.format, state: keepState } };
    this.store.touch('sound');
    const ok = await this.loadPlugin(p.sound.plugin);
    if (ok) {
      toast(`${pl.name} is ready. Open the plugin window to pick its kit.`, {
        actionLabel: 'Open plugin window',
        onAction: () => this.openPluginWindow(),
        timeout: 7000,
      });
    }
  }

  async chooseSfz(kit, program) {
    this.audio.stop();
    const p = this.store.project;
    const prev = p.sound.sfz;
    p.sound = {
      ...p.sound,
      type: 'sfz',
      sfz: {
        path: program.path,
        name: program.name,
        kit: kit.name,
        noteMap: kit.noteMap || {},
        hihat: kit.hihat || null,
        calibrate: kit.calibrate || null,
        role: kit.role || 'drums',
        cc: prev && prev.path === program.path ? prev.cc || {} : {},
      },
      lanes: p.sound.lanes || {},
    };
    this.mainKeys = null;
    this.store.touch('sound');
    const ok = await this.loadSfz(p.sound.sfz);
    if (ok) {
      const borrowed = Object.keys(p.sound.lanes || {}).length;
      toast(`${program.name} is ready.${borrowed ? ` ${borrowed} drum${borrowed === 1 ? ' keeps its' : 's keep their'} borrowed sound.` : ''} Click a drum name on the left to hear it.`, { timeout: 6000 });
      this.audio.audition(38, 110);
    }
  }

  async loadSfz(sfz) {
    if (!this.kitsEngine) {
      this.pluginStatus = 'error';
      this.pluginError = 'The kit player isn’t installed yet. Close Simple DAW and run “Start Simple DAW” again to finish setup.';
      this.updateSoundButton();
      toast(this.pluginError, { error: true });
      return false;
    }
    this.pluginStatus = 'loading';
    this.pluginError = null;
    this.audio.pluginLoading = true;
    this.updateSoundButton();
    try {
      const r = await api.loadKit(sfz.path, this.audio.ctx.sampleRate, { noteMap: sfz.noteMap || {}, hihat: sfz.hihat || null, calibrate: sfz.calibrate || null });
      this.kitControls = r.controls || [];
      this.mainKeys = new Set(r.keys || []);
      this.kitKeys.set(sfz.path, this.mainKeys);
      this.audio.routeVersion = (this.audio.routeVersion || 0) + 1;
      this.audio.segments.reset();
      this.audio.segments.enabled = true;
      this.pluginStatus = 'ready';
      this.silentWarned = false;
      this.timeline.rebuildLanes(true);
      this.preloadBorrowed();
      return true;
    } catch (err) {
      this.pluginStatus = 'error';
      this.pluginError = err.message;
      toast(`Couldn't open ${sfz.name}. ${err.message}`, { error: true });
      return false;
    } finally {
      this.audio.pluginLoading = false;
      this.updateSoundButton();
      this.audio.segments.pump();
    }
  }

  async showKitStore() {
    closePopover();
    let data;
    try { data = await api.kits(); } catch (err) { toast(err.message, { error: true }); return; }
    const list = el('div', { class: 'kit-store' });
    const render = (catalog) => {
      list.replaceChildren();
      for (const c of catalog) {
        const job = c.job || {};
        const row = el('div', { class: 'kit-row' });
        const info = el('div', { class: 'kit-info' },
          el('div', { class: 'kit-title' }, c.name, el('span', { class: 'kit-meta' }, `${c.size}, ${c.license}`)),
          el('div', { class: 'kit-desc' }, c.desc),
          el('div', { class: 'kit-meta' }, `By ${c.author}`));
        row.append(info);
        const side = el('div', { class: 'kit-side' });
        if (c.installed && job.state !== 'downloading' && job.state !== 'extracting') {
          const use = el('button', { class: 'btn btn-small btn-primary' }, 'Use it');
          use.addEventListener('click', async () => {
            m.close();
            this.kitData = null;
            const kits = (await api.kits()).kits;
            const kit = kits.find((k) => k.name === c.name) || kits[0];
            if (kit) this.chooseSfz(kit, kit.programs[0]);
          });
          side.append(el('span', { class: 'kit-installed' }, icon('check'), 'Installed'), use);
        } else if (job.state === 'downloading' || job.state === 'extracting') {
          const pct = job.state === 'downloading'
            ? Math.min(99, Math.round(((job.bytes || 0) / (job.total || 1)) * 100))
            : Math.round(((job.extracted || 0) / (job.files || 1)) * 100);
          side.append(
            el('span', { class: 'kit-meta' }, job.state === 'downloading' ? `Downloading ${pct}%` : `Unpacking ${pct}%`),
            el('div', { class: 'progress kit-progress' }, el('span', { style: { width: `${pct}%` } })));
        } else {
          const dl = el('button', { class: 'btn btn-small' }, icon('export'), job.state === 'error' ? 'Try again' : 'Download');
          dl.addEventListener('click', async () => {
            try { render((await api.installKit(c.id)).catalog); poll(); } catch (err) { toast(err.message, { error: true }); }
          });
          side.append(dl);
          if (job.state === 'error') side.append(el('span', { class: 'kit-error' }, job.error || 'The download failed.'));
        }
        row.append(side);
        list.append(row);
      }
      hydrateIcons(list);
    };
    let timer = null;
    const poll = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const st = await api.kitsStatus();
          render(st.catalog);
          if (st.catalog.some((c) => c.job && (c.job.state === 'downloading' || c.job.state === 'extracting'))) poll();
          else if (st.catalog.some((c) => c.job && c.job.state === 'done')) {
            this.refreshKitData(true).then(() => {
              this.audio.routeVersion = (this.audio.routeVersion || 0) + 1;
              this.timeline.rebuildLanes(true);
              this.preloadBorrowed();
            });
          }
        } catch { /* keep the last state */ }
      }, 800);
    };
    const m = modal({
      title: 'Get more kits',
      wide: true,
      body: el('div', {},
        el('p', {}, 'Free sampled kits that play inside Simple DAW. Each one is recorded with many hits per drum, so no two hits sound the same. They download from GitHub into your Kits folder.'),
        list,
        el('p', { class: 'note' }, 'Any drum can borrow a sound from any kit here: right-click a drum name and choose another sound. Have another SFZ kit, like Big Rusty Drums or SM Drums? Unzip it into the Kits folder, or add the folder where it is.')),
      actions: [
        { label: 'Open the Kits folder', ghost: true, onClick: () => { api.openFolder('kits'); return true; } },
        { label: 'Add a kit folder…', ghost: true, onClick: async () => {
          try { const r = await api.addKitFolder(); if (r.folder) { this.kitData = null; toast(`Added ${r.folder}.`); } } catch (err) { toast(err.message, { error: true }); }
          return true;
        } },
        { label: 'Done', primary: true },
      ],
      onClose: () => clearTimeout(timer),
    });
    render(data.catalog);
    if (data.catalog.some((c) => c.job && (c.job.state === 'downloading' || c.job.state === 'extracting'))) poll();
  }

  async loadPlugin(plugin) {
    if (!this.engineAvailable) {
      this.pluginStatus = 'error';
      this.pluginError = 'The plugin engine is not installed. Close Simple DAW and run “Start Simple DAW” again to finish setup.';
      this.updateSoundButton();
      toast(this.pluginError, { error: true });
      return false;
    }
    this.pluginStatus = 'loading';
    this.pluginError = null;
    this.audio.pluginLoading = true;
    this.updateSoundButton();
    try {
      const r = await api.loadPlugin(plugin.path, this.audio.ctx.sampleRate, plugin.state || null);
      if (r.state && !plugin.state) plugin.state = r.state;
      plugin.name = plugin.name || r.name;
      this.audio.segments.reset();
      this.audio.segments.enabled = true;
      this.pluginStatus = 'ready';
      this.silentWarned = false;
      return true;
    } catch (err) {
      this.pluginStatus = 'error';
      this.pluginError = err.message;
      toast(`Couldn't open ${plugin.name}. ${err.message}`, { error: true });
      return false;
    } finally {
      this.audio.pluginLoading = false;
      this.updateSoundButton();
      this.audio.segments.pump();
    }
  }

  async openPluginWindow() {
    const s = this.store.project.sound;
    if (s.type !== 'plugin' || this.pluginStatus !== 'ready') return;
    this.audio.stop();
    closePopover();
    const m = modal({
      title: `${s.plugin.name} is open`,
      dismissable: false,
      body: el('div', {},
        el('p', {}, 'Pick a kit, change the mix or the note map in the plugin’s own window. When you close that window, Simple DAW keeps your changes with this song.'),
        el('p', { class: 'help' }, 'Can’t see it? Look for it on the taskbar.')),
    });
    try {
      const r = await api.openEditor();
      if (r.state) s.plugin.state = r.state;
      this.audio.segments.reset();
      this.audio.segments.enabled = true;
      this.store.touch('plugin');
      toast('Plugin settings saved with this song.');
    } catch (err) {
      toast(err.message, { error: true });
      if (/crash|closed/i.test(err.message)) {
        this.pluginStatus = 'error';
        this.pluginError = err.message;
        this.audio.segments.enabled = false;
      }
    } finally {
      m.close();
      this.updateSoundButton();
      this.audio.segments.pump();
    }
  }

  updateSoundButton() {
    const s = this.store.project.sound;
    const led = $('#sound-led');
    led.className = 'sound-led';
    let kind = 'Sound';
    let name = '';
    if (s.type === 'plugin' && s.plugin) {
      kind = 'Plugin';
      name = s.plugin.name;
      if (this.pluginStatus === 'loading') led.classList.add('is-busy');
      else if (this.pluginStatus !== 'ready') led.classList.add('is-off');
    } else if (s.type === 'sfz' && s.sfz) {
      const borrowed = Object.keys(s.lanes || {}).length;
      kind = borrowed ? 'Sample kit, mixed' : 'Sample kit';
      name = borrowed ? `${s.sfz.name} + ${borrowed}` : s.sfz.name;
      if (this.pluginStatus === 'loading') led.classList.add('is-busy');
      else if (this.pluginStatus !== 'ready') led.classList.add('is-off');
    } else if (s.type === 'module') {
      kind = 'Sound';
      name = 'Your drum module';
      if (!this.midi.output) led.classList.add('is-off');
    } else {
      kind = 'Built-in kit';
      const defs = this.audio.sampler.defs;
      name = defs?.kits?.[s.kit]?.name || (s.kit === 'red-zeppelin' ? 'Red Zeppelin' : 'Black Pearl');
      if (this.kitProgress !== null) led.classList.add('is-busy');
    }
    $('#sound-kind').textContent = kind;
    $('#sound-name').textContent = name;
    this.updateEngineStatus();
  }

  updateEngineStatus(busy) {
    const node = $('#engine-status');
    const s = this.store.project.sound;
    let text = '';
    let isBusy = false;
    if (this.kitProgress !== null) {
      text = `Loading built-in kit ${Math.round(this.kitProgress * 100)}%`;
      isBusy = true;
    } else if (s.type === 'plugin' || s.type === 'sfz') {
      const nm = s.type === 'sfz' ? s.sfz?.name : s.plugin?.name;
      if (this.pluginStatus === 'loading') { text = `Opening ${nm}…`; isBusy = true; }
      else if (this.pluginStatus === 'error') text = `${nm} isn't working`;
      else if (busy ?? this.audio.segments.pending) { text = `Preparing ${nm} sound…`; isBusy = true; }
      else text = `${nm} ready`;
    }
    node.textContent = text;
    node.classList.toggle('is-busy', isBusy);
  }

  openSoundMenu() {
    const anchor = $('#btn-sound');
    popover(anchor, (close) => {
      const s = this.store.project.sound;
      const wrap = el('div', {});
      wrap.append(el('h3', {}, 'What your drums sound like'));
      wrap.append(el('div', { class: 'section-title' }, 'Built-in kits'));
      const defs = this.audio.sampler.defs;
      const kits = defs ? Object.entries(defs.kits) : [['black-pearl', { name: 'Black Pearl', desc: 'Pearl 5-piece, Sabian cymbals' }], ['red-zeppelin', { name: 'Red Zeppelin', desc: 'Ludwig 5-piece, Zildjian cymbals' }]];
      for (const [id, kit] of kits) {
        wrap.append(menuItem({ label: `${kit.name} kit`, sub: kit.desc, active: s.type === 'kit' && s.kit === id, onClick: () => { close(); this.chooseKit(id); } }));
      }
      wrap.append(el('div', { class: 'section-title' }, 'Sample kits'));
      const kitList = el('div', { class: 'plugin-list' }, el('p', { class: 'note' }, 'Looking for kits…'));
      wrap.append(kitList);
      if (s.type === 'sfz' && this.pluginStatus === 'error') {
        const retry = el('button', { class: 'btn btn-small' }, icon('refresh'), 'Try again');
        retry.addEventListener('click', () => { close(); this.loadSfz(s.sfz); });
        wrap.append(el('div', { class: 'callout is-error' }, this.pluginError || 'The kit could not be opened.'), el('div', { class: 'pop-actions', style: { justifyContent: 'flex-start' } }, retry));
      }
      const getKits = el('button', { class: 'btn btn-small' }, icon('drum'), 'Get more kits…');
      getKits.addEventListener('click', () => { close(); this.showKitStore(); });
      const kitActions = el('div', { class: 'pop-actions', style: { justifyContent: 'flex-start', marginTop: '2px', flexWrap: 'wrap' } }, getKits);
      if (s.type === 'sfz' && s.sfz && Object.keys(s.lanes || {}).length) {
        const save = el('button', { class: 'btn btn-small' }, icon('star'), 'Save as my kit…');
        save.addEventListener('click', () => { close(); this.saveMyKit(); });
        kitActions.append(save);
      }
      wrap.append(kitActions);
      const mine = this.settings.myKits || [];
      if (mine.length) {
        wrap.append(el('div', { class: 'section-title' }, 'My kits'));
        for (const mk of mine) {
          const row = el('div', { class: 'form-inline', style: { gap: '4px' } });
          const borrowed = Object.keys(mk.lanes || {}).length;
          const pick = menuItem({
            label: mk.name,
            sub: `${mk.sfz?.name || 'Sample kit'}${borrowed ? ` with ${borrowed} borrowed sound${borrowed === 1 ? '' : 's'}` : ''}`,
            onClick: () => { close(); this.applyMyKit(mk); },
          });
          const del = el('button', { class: 'lane-btn', style: { opacity: 1 }, 'aria-label': `Remove ${mk.name}`, 'data-tip': 'Remove from My kits' }, icon('trash'));
          del.addEventListener('click', () => { close(); this.deleteMyKit(mk.id); });
          row.append(pick, del);
          wrap.append(row);
        }
      }
      this.fillKitList(kitList, close);
      wrap.append(el('div', { class: 'section-title' }, 'Your drum module'));
      const out = this.midi.output;
      wrap.append(menuItem({
        label: 'Your drum module',
        sub: out ? `Plays back through ${out.name}` : 'Connect your module with USB to use its own sounds',
        active: s.type === 'module',
        disabled: !out,
        onClick: () => { close(); this.chooseModule(); },
      }));
      wrap.append(el('div', { class: 'section-title' }, 'Plugins (VST2 and VST3)'));
      wrap.append(el('p', { class: 'note' }, 'Some drum plugins, like MT Power Drum Kit and Steven Slate Drums, stay silent in Simple DAW. Synth plugins work.'));
      if (s.type === 'plugin' && s.plugin) {
        const openBtn = el('button', { class: 'btn btn-primary', disabled: this.pluginStatus !== 'ready' }, icon('window'), 'Open plugin window');
        openBtn.addEventListener('click', () => { close(); this.openPluginWindow(); });
        const row = el('div', { class: 'pop-actions', style: { justifyContent: 'flex-start', marginTop: '2px' } }, openBtn);
        if (this.pluginStatus === 'error') {
          const retry = el('button', { class: 'btn' }, icon('refresh'), 'Try again');
          retry.addEventListener('click', () => { close(); this.loadPlugin(s.plugin); });
          row.append(retry);
          wrap.append(el('div', { class: 'callout is-error' }, this.pluginError || 'The plugin stopped working.'));
        }
        wrap.append(row);
      }
      const list = el('div', { class: 'plugin-list' }, el('p', { class: 'note' }, this.engineAvailable ? 'Looking for plugins…' : 'The plugin engine isn’t installed yet. Close Simple DAW and run “Start Simple DAW” again.'));
      wrap.append(list);
      const actions = el('div', { class: 'pop-actions', style: { justifyContent: 'flex-start', flexWrap: 'wrap' } });
      const find = el('button', { class: 'btn btn-small' }, icon('plug'), 'Find a plugin file…');
      const folder = el('button', { class: 'btn btn-small' }, icon('folder'), 'Add a plugin folder…');
      const rescan = el('button', { class: 'btn btn-small btn-ghost' }, icon('refresh'), 'Rescan');
      find.addEventListener('click', async () => {
        close();
        try {
          const r = await api.browsePlugin();
          if (r.path) this.choosePlugin(r.plugin);
        } catch (err) { toast(err.message, { error: true }); }
      });
      folder.addEventListener('click', async () => {
        close();
        try {
          const r = await api.addPluginFolder();
          this.plugins = r.plugins;
          if (r.folder) { toast(`Added ${r.folder}.`); this.openSoundMenu(); }
        } catch (err) { toast(err.message, { error: true }); }
      });
      rescan.addEventListener('click', () => { this.plugins = null; close(); this.openSoundMenu(); });
      if (this.engineAvailable) actions.append(find, folder, rescan);
      wrap.append(actions);
      if (s.type === 'plugin') {
        const chk = el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: s.convertGM !== false }),
          el('span', {}, 'Send standard (General MIDI) note numbers', el('span', { class: 'mi-sub' }, 'Turn off if you set the plugin’s note map to match your module.')));
        chk.querySelector('input').addEventListener('change', (e) => {
          this.store.project.sound.convertGM = e.target.checked;
          this.store.touch('sound');
        });
        wrap.append(chk);
      }
      if (this.engineAvailable) this.fillPluginList(list, close);
      return wrap;
    }, { align: 'end', width: 400 });
  }

  async fillKitList(list, close) {
    try {
      if (!this.kitData) this.kitData = await api.kits();
    } catch (err) {
      list.replaceChildren(el('p', { class: 'note' }, err.message));
      return;
    }
    const s = this.store.project.sound;
    list.replaceChildren();
    const kits = this.kitData.kits || [];
    if (!kits.length) {
      list.append(el('p', { class: 'note' }, 'No sample kits yet. Get a free one: each hit uses a different recording, so it sounds like a real drummer.'));
      return;
    }
    for (const kit of kits) {
      for (const prog of kit.programs) {
        const item = menuItem({
          label: prog.name,
          sub: prog.desc || kit.name,
          active: s.type === 'sfz' && s.sfz?.path === prog.path,
          onClick: () => { close(); this.chooseSfz(kit, prog); },
        });
        item.title = prog.path;
        list.append(item);
      }
    }
  }

  // =====================================================================
  // Single drums: where each sound comes from
  // =====================================================================
  async refreshKitData(force = false) {
    if (!this.kitsEngine) return this.kitData;
    if (!this.kitData || force) {
      try { this.kitData = await api.kits(); } catch { /* keep what we had */ }
    }
    return this.kitData;
  }

  // Every installed program (a playable .sfz) with the kit it belongs to.
  allPrograms() {
    const out = [];
    for (const kit of this.kitData?.kits || []) for (const program of kit.programs) out.push({ kit, program });
    return out;
  }

  programInfo(path) {
    return this.allPrograms().find((x) => x.program.path === path) || null;
  }

  // The installed percussion kit plays percussion lanes the main kit has no sound for.
  percussionSource() {
    const kit = (this.kitData?.kits || []).find((k) => k.role === 'percussion');
    return kit && kit.programs[0] ? { kit, program: kit.programs[0] } : null;
  }

  // Does a kit have a sound for this (General MIDI) drum note?
  static kitHas(keys, kit, note) {
    const noteMap = kit?.noteMap || {};
    // Drum kits that remap notes use spare keys (like 54 and 56) for hi-hat
    // articulations, so they don't count as playing the percussion notes.
    if ((kit?.role || 'drums') !== 'percussion' && (Object.keys(noteMap).length || kit?.hihat) && laneInfo('gm', note).family === 'perc') return false;
    if (!keys) return true;
    const mapped = Number(noteMap[note] ?? note);
    if (keys.has(mapped)) return true;
    const rules = kit?.hihat?.rules?.[note];
    return !!rules && rules.some((r) => keys.has(Number(r[2])));
  }

  mainPlays(engineNote) {
    const s = this.store.project.sound;
    if (s.type !== 'sfz' || !s.sfz) return false;
    return App.kitHas(this.mainKeys, s.sfz, engineNote);
  }

  percussionFor(engineNote) {
    const src = this.percussionSource();
    if (!src) return null;
    const keys = new Set((src.kit.sounds || []).map((x) => x.key));
    if (!keys.has(engineNote)) return null;
    return src;
  }

  laneVolume(note) {
    const v = this.store.project.mix.lanes?.[note];
    return typeof v === 'number' ? v : 1;
  }

  // What the engine should do with hits on this lane (see AudioEngine.engineHits).
  routeFor(laneNote) {
    const p = this.store.project;
    const s = p.sound;
    if (s.type !== 'sfz' || !s.sfz) return null;
    const gain = this.laneVolume(laneNote);
    const e = this.audio.engineNote(laneNote);
    const ov = s.lanes?.[laneNote];
    if (ov && ov.path) {
      return { path: ov.path, note: ov.note ?? e, raw: !!ov.raw, gain, noteMap: ov.noteMap || {}, hihat: ov.hihat || null, calibrate: ov.calibrate || null };
    }
    if (this.mainPlays(e)) return gain !== 1 ? { path: s.sfz.path, note: e, raw: false, gain } : null;
    const perc = this.percussionFor(e);
    if (perc) return { path: perc.program.path, note: e, raw: true, gain, calibrate: perc.kit.calibrate || null };
    return { silent: true };
  }

  // Name, source and status of a lane, for the lane heads and menus.
  laneDisplay(laneNote) {
    const p = this.store.project;
    const s = p.sound;
    const info = laneInfo(p.drumMap, laneNote);
    const out = { label: info.label, source: null, silent: false, tip: null, sound: null, from: null };
    if (s.type !== 'sfz' || !s.sfz) return out;
    const e = this.audio.engineNote(laneNote);
    const ov = s.lanes?.[laneNote];
    if (ov && ov.path) {
      // A percussion sound names itself ("Bongo high"); a drum borrowed from
      // another kit keeps the lane's name and shows the kit it comes from.
      if (ov.raw) out.label = ov.name;
      else out.source = (ov.kitShort || ov.kit || '').replace(/\s+(kit|drums)$/i, '');
      out.sound = ov.name;
      out.from = ov.kit;
      out.tip = `${info.label} plays ${ov.name} from ${ov.kit}. Right-click to change it.`;
      return out;
    }
    const mainInfo = this.programInfo(s.sfz.path);
    if (this.mainPlays(e)) {
      const label = mainInfo?.kit?.labels?.[e];
      if (label) out.label = label;
      out.sound = out.label;
      out.from = s.sfz.name;
      return out;
    }
    const perc = this.percussionFor(e);
    if (perc) {
      out.label = perc.kit.labels?.[e] || info.label;
      out.sound = out.label;
      out.from = perc.kit.name;
      out.tip = `${out.label} (note ${laneNote}) plays from ${perc.kit.name}. Right-click for more.`;
      return out;
    }
    if (this.mainKeys) out.silent = true;
    return out;
  }

  // Open the kits single drums borrow from, so their sounds are ready to play.
  preloadBorrowed() {
    const p = this.store.project;
    const s = p.sound;
    if (s.type !== 'sfz' || !this.kitsEngine) return;
    const want = new Map();
    const used = new Set(this.store.notes.map((n) => n.n));
    for (const [note, ov] of Object.entries(s.lanes || {})) {
      if (!ov?.path) continue;
      if (!want.has(ov.path)) want.set(ov.path, { opts: { noteMap: ov.noteMap || {}, hihat: ov.hihat || null, calibrate: ov.calibrate || null }, notes: [] });
      want.get(ov.path).notes.push(ov.note ?? this.audio.engineNote(Number(note)));
    }
    for (const n of used) {
      const r = this.routeFor(n);
      if (r && r.path && r.raw && !s.lanes?.[n]) {
        if (!want.has(r.path)) want.set(r.path, { opts: { calibrate: r.calibrate || null }, notes: [] });
        want.get(r.path).notes.push(r.note);
      }
    }
    for (const [path, w] of want) {
      api.describeKit(path, this.audio.ctx.sampleRate, w.opts, w.notes)
        .then((r) => this.kitKeys.set(path, new Set(r.keys || [])))
        .catch(() => {});
    }
  }

  // ---- the lane menu -------------------------------------------------------
  openLaneMenu(note, anchor) {
    if (this.audio.isRecording) return;
    const p = this.store.project;
    const tl = this.timeline;
    const s = p.sound;
    const disp = this.laneDisplay(note);
    const all = this.store.notes.filter((n) => n.n === note);
    const picked = all.filter((n) => tl.selection.has(n.id));
    popover(anchor, (close) => {
      const wrap = el('div', { class: 'lane-menu' });
      const item = (o) => wrap.append(menuItem({ ...o, onClick: () => { close(); o.onClick(); } }));
      wrap.append(el('h3', {}, disp.label));
      wrap.append(el('p', { class: 'note' }, `${all.length ? `${all.length} hit${all.length === 1 ? '' : 's'}` : 'No hits yet'} on note ${note}${picked.length ? `, ${picked.length} selected` : ''}.`));

      wrap.append(el('div', { class: 'section-title' }, 'Sound'));
      if (s.type === 'sfz' && s.sfz) {
        const now = disp.silent ? 'No sound yet' : `${disp.sound || disp.label}`;
        const from = disp.silent ? 'Nothing in your kits plays this drum.' : `From ${disp.from}`;
        wrap.append(menuItem({ label: now, sub: from, iconName: 'speaker', disabled: disp.silent, onClick: () => this.audio.audition(note, 105) }));
        item({ label: 'Choose another sound…', sub: 'Any drum or percussion sound from your kits', iconName: 'drum', onClick: () => this.openSoundPicker(note, anchor) });
        if (s.lanes?.[note]) {
          item({ label: 'Use the kit’s own sound', iconName: 'refresh', onClick: () => this.setLaneSound(note, null) });
        }
      } else {
        wrap.append(el('p', { class: 'note' }, 'To give this drum a sound from another kit, pick a sample kit in Sound first.'));
      }
      if (s.type === 'kit' || s.type === 'sfz') {
        const vol = el('input', { type: 'range', min: 0, max: 150, step: 1, value: Math.round(this.laneVolume(note) * 100), 'aria-label': `${disp.label} volume` });
        const val = el('span', { class: 'value' }, `${vol.value}%`);
        vol.addEventListener('input', () => { val.textContent = `${vol.value}%`; });
        vol.addEventListener('change', () => { this.setLaneVolume(note, Number(vol.value) / 100); this.audio.audition(note, 105); });
        wrap.append(el('div', { class: 'slider-row' }, el('label', {}, 'Volume'), vol, val));
      }

      wrap.append(el('div', { class: 'section-title' }, 'Hits'));
      const scope = picked.length ? `${picked.length} selected hit${picked.length === 1 ? '' : 's'}` : 'all its hits';
      item({ label: 'Move hits to another drum…', sub: `Moves ${scope}`, iconName: 'move', disabled: !all.length, onClick: () => this.openLanePicker(note, 'move', anchor, { onlySelected: picked.length > 0 }) });
      item({ label: 'Copy hits to another drum…', sub: `Copies ${scope}, so both drums play them`, iconName: 'copy', disabled: !all.length, onClick: () => this.openLanePicker(note, 'copy', anchor, { onlySelected: picked.length > 0 }) });
      item({ label: 'Swap with another drum…', sub: 'Each drum gets the other’s hits', iconName: 'swap', disabled: !all.length, onClick: () => this.openLanePicker(note, 'swap', anchor) });
      item({
        label: `Select every ${disp.label} hit`, iconName: 'lanes', disabled: !all.length,
        onClick: () => { tl.selection = new Set(all.map((n) => n.id)); tl.emitSelection(); tl.dirty = true; },
      });
      item({
        label: `Delete every ${disp.label} hit`, iconName: 'trash', danger: true, disabled: !all.length,
        onClick: () => {
          this.store.edit(`Delete every ${disp.label} hit`, (proj, take) => { take.notes = take.notes.filter((n) => n.n !== note); });
          tl.pruneSelection();
          toast(`Deleted ${all.length} ${disp.label} hit${all.length === 1 ? '' : 's'}. Ctrl+Z brings them back.`);
        },
      });
      return wrap;
    }, { width: 320 });
  }

  // Every lane hits could go to, grouped like the lanes on screen.
  laneTargets(exclude) {
    const p = this.store.project;
    const set = new Set([...getMap(p.drumMap).notes.keys(), ...this.timeline.lanes]);
    set.delete(exclude);
    const groups = new Map();
    for (const n of sortLanes(p.drumMap, [...set])) {
      const fam = laneInfo(p.drumMap, n).family;
      if (!groups.has(fam)) groups.set(fam, []);
      groups.get(fam).push(n);
    }
    return groups;
  }

  openLanePicker(from, mode, anchor, { onlySelected = false } = {}) {
    const p = this.store.project;
    const fromLabel = from === null ? 'selected' : this.laneDisplay(from).label;
    const counts = new Map();
    for (const n of this.store.notes) counts.set(n.n, (counts.get(n.n) || 0) + 1);
    const title = {
      move: from === null ? 'Move the selected hits to…' : `Move ${fromLabel} hits to…`,
      copy: from === null ? 'Copy the selected hits to…' : `Copy ${fromLabel} hits to…`,
      swap: `Swap ${fromLabel} with…`,
    }[mode];
    popover(anchor, (close) => {
      const wrap = el('div', { class: 'lane-picker' }, el('h3', {}, title));
      for (const [fam, notes] of this.laneTargets(from)) {
        wrap.append(el('div', { class: 'section-title' }, FAMILIES[fam].label));
        const grid = el('div', { class: 'pick-grid' });
        for (const n of notes) {
          const d = this.laneDisplay(n);
          const hits = counts.get(n) || 0;
          const sub = d.silent ? 'No sound in your kits' : hits ? `${hits} hit${hits === 1 ? '' : 's'}` : d.source ? `From ${d.source}` : `Note ${n}`;
          const b = el('button', { class: `pick${d.silent ? ' is-silent' : ''}`, style: { '--c': laneInfo(p.drumMap, n).color } },
            el('span', { class: 'pick-dot' }), el('span', { class: 'pick-main' }, d.label, el('span', { class: 'mi-sub' }, sub)));
          b.addEventListener('click', () => { close(); this.doTransfer(from, n, mode, { onlySelected }); });
          grid.append(b);
        }
        wrap.append(grid);
      }
      return wrap;
    }, { width: 440 });
  }

  doTransfer(from, to, mode, opts) {
    const tl = this.timeline;
    const count = tl.transferHits(from, to, mode, opts);
    if (!count) return;
    const a = from === null ? 'the selected hits' : this.laneDisplay(from).label;
    const b = this.laneDisplay(to).label;
    const msg = {
      move: `Moved ${count} hit${count === 1 ? '' : 's'} from ${a} to ${b}.`,
      copy: `Copied ${count} hit${count === 1 ? '' : 's'} from ${a} to ${b}.`,
      swap: `Swapped ${a} and ${b}.`,
    }[mode];
    toast(`${msg} Ctrl+Z undoes it.`);
    tl.flash(to, 100);
    if (this.laneDisplay(to).silent) {
      toast(`Nothing in your kits plays ${b} yet. Right-click it to choose a sound${this.percussionSource() ? '' : ', or get the free Percussion kit in Sound › Get more kits'}.`, { timeout: 7000 });
    }
    this.preloadBorrowed();
  }

  setLaneVolume(note, v) {
    const p = this.store.project;
    p.mix.lanes = p.mix.lanes || {};
    if (Math.abs(v - 1) < 0.005) delete p.mix.lanes[note];
    else p.mix.lanes[note] = Math.round(v * 100) / 100;
    this.store.touch('mix');
  }

  // choice: null (back to the kit's own sound) or {path, kit, kitShort, name, note, raw, noteMap, hihat, calibrate}
  setLaneSound(note, choice) {
    const p = this.store.project;
    const s = p.sound;
    s.lanes = s.lanes || {};
    const e = this.audio.engineNote(note);
    const isOwn = choice && s.sfz && choice.path === s.sfz.path && !choice.raw && Number(choice.note) === e;
    if (!choice || isOwn) delete s.lanes[note];
    else s.lanes[note] = choice;
    this.audio.routeVersion = (this.audio.routeVersion || 0) + 1;
    this.store.touch('sound');
    this.timeline.rebuildLanes(true);
    this.updateSoundButton();
    this.preloadBorrowed();
  }

  // ---- the sound picker ------------------------------------------------------
  async soundsOf(kit, program) {
    if (kit.sounds?.length) {
      return kit.sounds.map((x) => ({ key: x.key, name: x.name, family: x.family, raw: true }));
    }
    let keys = this.kitKeys.get(program.path);
    let labels = {};
    if (!keys) {
      const r = await api.describeKit(program.path, this.audio.ctx.sampleRate, { noteMap: kit.noteMap || {}, hihat: kit.hihat || null, calibrate: kit.calibrate || null });
      keys = new Set(r.keys || []);
      labels = r.labels || {};
      this.kitKeys.set(program.path, keys);
    }
    const out = [];
    const gm = getMap('gm');
    for (const [n, info] of gm.notes) {
      if (!App.kitHas(keys, kit, n)) continue;
      const fam = FAMILIES[info.family].label;
      out.push({ key: n, name: info.label, family: fam, raw: false, order: info.order });
    }
    // Labelled sounds of a kit without a note map (most SFZ kits from elsewhere).
    if (!Object.keys(kit.noteMap || {}).length) {
      for (const [k, name] of Object.entries(labels)) {
        const key = Number(k);
        if (gm.notes.has(key)) continue;
        out.push({ key, name, family: 'More sounds', raw: true, order: 200 + key });
      }
    }
    return out.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  async openSoundPicker(note, anchor) {
    const p = this.store.project;
    const s = p.sound;
    if (s.type !== 'sfz' || !s.sfz) return;
    await this.refreshKitData();
    const programs = this.allPrograms();
    if (!programs.length) return;
    const laneLabel = laneInfo(p.drumMap, note).label;
    const ov = s.lanes?.[note];
    const e = this.audio.engineNote(note);
    const isPercLane = laneInfo(p.drumMap, note).family === 'perc';
    const perc = this.percussionSource();
    let current = ov?.path || (isPercLane && !this.mainPlays(e) && perc ? perc.program.path : s.sfz.path);
    if (!programs.some((x) => x.program.path === current)) current = programs[0].program.path;
    let pop = null;
    pop = popover(anchor, (close) => {
      const wrap = el('div', { class: 'sound-picker' });
      wrap.append(el('h3', {}, `Sound for ${laneLabel}`));
      wrap.append(el('p', { class: 'note' }, `Click a sound to hear it. ${laneLabel} then plays it in this song.`));
      const sel = el('select', { class: 'select-compact', 'aria-label': 'Kit' });
      const ordered = [...programs].sort((a, b) => (a.program.path === s.sfz.path ? -1 : b.program.path === s.sfz.path ? 1 : 0));
      for (const { program } of ordered) {
        sel.append(el('option', { value: program.path, selected: program.path === current }, program.path === s.sfz.path ? `${program.name} (this song’s kit)` : program.name));
      }
      wrap.append(el('div', { class: 'form-row' }, el('label', {}, 'Kit'), sel));
      const body = el('div', { class: 'sound-groups' });
      wrap.append(body);
      const foot = el('div', { class: 'pop-actions' });
      if (s.lanes?.[note]) {
        const own = el('button', { class: 'btn btn-ghost' }, 'Use the kit’s own sound');
        own.addEventListener('click', () => { this.setLaneSound(note, null); close(); this.audio.audition(note, 105); });
        foot.append(own);
      }
      const done = el('button', { class: 'btn btn-primary' }, 'Done');
      done.addEventListener('click', () => close());
      foot.append(done);
      wrap.append(foot);

      const activeKey = () => {
        const o = s.lanes?.[note];
        if (o) return `${o.path}|${o.note}|${o.raw ? 1 : 0}`;
        if (this.mainPlays(e)) return `${s.sfz.path}|${e}|0`;
        const pf = this.percussionFor(e);
        return pf ? `${pf.program.path}|${e}|1` : '';
      };
      const render = async () => {
        const entry = programs.find((x) => x.program.path === sel.value);
        if (!entry) return;
        body.replaceChildren(el('p', { class: 'note' }, `Opening ${entry.program.name}…`));
        let sounds;
        try { sounds = await this.soundsOf(entry.kit, entry.program); } catch (err) {
          body.replaceChildren(el('p', { class: 'note' }, `${entry.program.name} couldn’t be opened. ${err.message}`));
          return;
        }
        if (sel.value !== entry.program.path) return;
        body.replaceChildren();
        const families = new Map();
        for (const x of sounds) {
          if (!families.has(x.family)) families.set(x.family, []);
          families.get(x.family).push(x);
        }
        requestAnimationFrame(() => pop?.reposition());
        const act = activeKey();
        for (const [fam, list] of families) {
          body.append(el('div', { class: 'section-title' }, fam));
          const grid = el('div', { class: 'pick-grid is-compact' });
          for (const x of list) {
            const key = `${entry.program.path}|${x.key}|${x.raw ? 1 : 0}`;
            const b = el('button', { class: `pick${key === act ? ' is-active' : ''}` }, el('span', { class: 'pick-main' }, x.name));
            b.addEventListener('click', () => {
              const choice = {
                path: entry.program.path,
                kit: entry.program.name,
                kitShort: entry.kit.name,
                name: x.name,
                note: x.key,
                raw: !!x.raw,
                noteMap: entry.kit.noteMap || {},
                hihat: entry.kit.hihat || null,
                calibrate: entry.kit.calibrate || null,
              };
              this.setLaneSound(note, choice);
              this.audio.audition(note, 105);
              for (const other of grid.parentElement.querySelectorAll('.pick.is-active')) other.classList.remove('is-active');
              b.classList.add('is-active');
            });
            grid.append(b);
          }
          body.append(grid);
        }
      };
      sel.addEventListener('change', render);
      render();
      return wrap;
    }, { width: 440 });
  }

  // ---- my kits ------------------------------------------------------------------
  async saveMyKit() {
    const s = this.store.project.sound;
    if (s.type !== 'sfz' || !s.sfz) return;
    const input = el('input', { class: 'text-input', value: `${s.sfz.kit || s.sfz.name} (mine)`, maxlength: 40, autofocus: true });
    modal({
      title: 'Save as my kit',
      body: el('div', {},
        el('p', {}, `Keeps ${s.sfz.name} with the sounds you picked for single drums${Object.keys(this.store.project.mix.lanes || {}).length ? ' and your drum volumes' : ''}, so you can use it in other songs.`),
        el('div', { class: 'form-row' }, el('label', {}, 'Name'), input)),
      actions: [
        { label: 'Cancel', ghost: true },
        {
          label: 'Save kit', primary: true, onClick: () => {
            const name = input.value.trim() || 'My kit';
            const mk = { id: uid(), name, sfz: structuredClone(s.sfz), lanes: structuredClone(s.lanes || {}), levels: structuredClone(this.store.project.mix.lanes || {}) };
            const list = [...(this.settings.myKits || []).filter((k) => k.name !== name), mk];
            this.saveSetting({ myKits: list });
            toast(`Saved ${name}. It’s in Sound under My kits.`);
          },
        },
      ],
    });
  }

  async applyMyKit(mk) {
    await this.refreshKitData();
    if (!this.programInfo(mk.sfz.path)) {
      toast(`${mk.name} uses ${mk.sfz.name}, which isn’t installed anymore.`, { error: true });
      return;
    }
    const p = this.store.project;
    this.audio.stop();
    p.sound = { ...p.sound, type: 'sfz', sfz: structuredClone(mk.sfz), lanes: structuredClone(mk.lanes || {}) };
    p.mix.lanes = structuredClone(mk.levels || {});
    this.mainKeys = null;
    this.store.touch('sound');
    const ok = await this.loadSfz(p.sound.sfz);
    if (ok) { toast(`${mk.name} is ready.`); this.audio.audition(38, 110); }
  }

  deleteMyKit(id) {
    const mk = (this.settings.myKits || []).find((k) => k.id === id);
    this.saveSetting({ myKits: (this.settings.myKits || []).filter((k) => k.id !== id) });
    if (mk) toast(`Removed ${mk.name} from My kits. Songs that use it keep their sound.`);
  }

  async fillPluginList(list, close) {
    try {
      if (!this.plugins) this.plugins = (await api.plugins()).plugins;
    } catch (err) {
      list.replaceChildren(el('p', { class: 'note' }, err.message));
      return;
    }
    const s = this.store.project.sound;
    const plugins = this.plugins;
    list.replaceChildren();
    const drums = plugins.filter((p) => p.drums && p.usable);
    const others = plugins.filter((p) => !p.drums && p.usable);
    const blocked = plugins.filter((p) => !p.usable);
    const row = (pl) => {
      const item = menuItem({
        label: pl.name,
        sub: `${pl.format}${pl.usable ? '' : ', 32-bit (can’t be used)'}`,
        active: s.type === 'plugin' && s.plugin?.path === pl.path,
        disabled: !pl.usable,
        onClick: () => { close(); this.choosePlugin(pl); },
      });
      item.title = pl.path;
      return item;
    };
    if (!drums.length) {
      list.append(el('p', { class: 'note' }, 'No drum plugins found. For realistic drums, a sample kit (above) is the reliable choice.'));
    }
    drums.forEach((pl) => list.append(row(pl)));
    if (others.length) {
      const more = el('button', { class: 'menu-item' }, el('span', { class: 'mi-check' }, '+'), el('span', { class: 'mi-main' }, `Other plugins (${others.length})`, el('span', { class: 'mi-sub' }, 'Instruments that may not be drums')));
      const box = el('div', { hidden: true });
      others.forEach((pl) => box.append(row(pl)));
      more.addEventListener('click', () => { box.hidden = !box.hidden; more.firstChild.textContent = box.hidden ? '+' : '−'; });
      list.append(more, box);
    }
    if (blocked.length) list.append(el('p', { class: 'note' }, `${blocked.length} 32-bit plugin${blocked.length > 1 ? 's were' : ' was'} skipped. Simple DAW can only load 64-bit plugins.`));
    hydrateIcons(list);
  }

  // =====================================================================
  // Transport
  // =====================================================================
  bindTransport() {
    $('#btn-record').addEventListener('click', () => this.toggleRecord());
    $('#btn-play').addEventListener('click', () => this.togglePlay());
    $('#btn-home').addEventListener('click', () => this.goHome());
    $('#btn-click').addEventListener('click', () => this.saveSetting({ click: !this.settings.click }));
    $('#btn-countin').addEventListener('click', () => {
      const next = { 0: 1, 1: 2, 2: 0 }[this.settings.countIn] ?? 1;
      this.saveSetting({ countIn: next });
    });
    $('#rec-mode-replace').addEventListener('click', () => this.saveSetting({ recordMode: 'replace' }));
    $('#rec-mode-add').addEventListener('click', () => this.saveSetting({ recordMode: 'add' }));
    $('#btn-loop').addEventListener('click', () => this.toggleLoop());
    $('#btn-tap').addEventListener('click', () => this.tapTempo());
    const tempo = $('#tempo');
    tempo.addEventListener('change', () => this.changeTempo(Number(tempo.value)));
    tempo.addEventListener('keydown', (e) => { if (e.key === 'Enter') tempo.blur(); });
    $('#timesig').addEventListener('change', (e) => {
      const [num, den] = e.target.value.split('/').map(Number);
      this.store.edit('Change time signature', (p) => { p.sig = [num, den]; });
    });
    $('#midi-chip').addEventListener('click', () => this.openSettings());
  }

  async togglePlay() {
    if (this.audio.isRecording) { this.stopRecording(); return; }
    if (this.audio.isPlaying) { this.audio.stop(); return; }
    const p = this.store.project;
    let from = this.audio.stoppedPos;
    if (p.loop.on && p.loop.end > p.loop.start && (from < p.loop.start || from >= p.loop.end)) from = p.loop.start;
    if (this.audio.usesEngine && this.pluginStatus !== 'ready') {
      if (this.pluginStatus === 'loading') { toast('The sound is still loading. Try again in a moment.'); return; }
      toast(p.sound.type === 'sfz' ? 'The sample kit isn’t working right now.' : 'The plugin isn’t working right now.', {
        error: true,
        actionLabel: 'Use built-in kit',
        onAction: () => this.chooseKit(p.sound.kit || 'black-pearl'),
      });
      return;
    }
    await this.audio.play(from);
  }

  goHome() {
    if (this.audio.isRecording) return;
    this.audio.seek(0);
    this.timeline.scrollX = -0.2;
    this.timeline.dirty = true;
  }

  async toggleRecord() {
    if (this.audio.isRecording) { this.stopRecording(); return; }
    if (this.midi.status !== 'ok') {
      const msg = this.midi.status === 'denied'
        ? 'Simple DAW isn’t allowed to use MIDI. Allow MIDI devices in the window’s site settings, then reload.'
        : 'No drum module found. Connect it with a USB cable, then hit a pad to check that its name lights up.';
      toast(msg, { error: true, actionLabel: 'Settings', onAction: () => this.openSettings() });
      return;
    }
    if (this.audio.isPlaying) this.audio.stop({ keepPosition: true });
    closePopover();
    const p = this.store.project;
    const from = Math.max(0, this.audio.stoppedPos);
    const mode = this.settings.recordMode === 'add' ? 'add' : 'replace';
    this.recBuffer = { notes: [], ccs: [], from, mode };
    this.timeline.liveNotes = this.recBuffer.notes;
    this.timeline.clearSelection();
    const countIn = (this.settings.countIn || 0) * barDur(p);
    this.timeline.reveal(from);
    await this.audio.play(from, { record: true, countIn, mode });
    this.updateEmptyState();
  }

  stopRecording() {
    const res = this.audio.stop();
    const buf = this.recBuffer;
    this.recBuffer = null;
    this.timeline.liveNotes = [];
    if (!buf) return;
    if (!buf.notes.length) {
      this.updateEmptyState();
      toast('Nothing was recorded. Hit a pad to check that your module is connected: its name lights up on the left.');
      return;
    }
    const endAt = Math.max(res?.endedAt ?? 0, buf.notes[buf.notes.length - 1].t + 0.01);
    let takeName = '';
    this.store.edit('Record', (p) => {
      const cur = this.store.take;
      const keep = buf.mode === 'add'
        ? cur.notes
        : cur.notes.filter((n) => n.t < buf.from - 0.005 || n.t > endAt);
      const keepCc = buf.mode === 'add'
        ? cur.ccs
        : cur.ccs.filter((c) => c.t < buf.from - 0.005 || c.t > endAt);
      const take = newTake(this.nextTakeName());
      take.notes = keep.map((n) => ({ id: uid(), t: n.t, n: n.n, v: n.v })).concat(buf.notes.map((n) => ({ ...n, id: uid() })));
      take.ccs = keepCc.map((c) => ({ ...c })).concat(buf.ccs);
      p.takes.push(take);
      p.activeTake = take.id;
      takeName = take.name;
    });
    this.timeline.rebuildLanes();
    this.updateEmptyState();
    this.audio.seek(buf.from);
    const count = buf.notes.length;
    toast(`${takeName} saved with ${count} hit${count === 1 ? '' : 's'}.`, {
      actionLabel: 'Listen',
      onAction: () => { this.audio.seek(buf.from); this.togglePlay(); },
      timeout: 6000,
    });
  }

  nextTakeName() {
    let max = 0;
    for (const t of this.store.project.takes) {
      const m = /^Take (\d+)$/.exec(t.name);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `Take ${max + 1}`;
  }

  toggleLoop() {
    const p = this.store.project;
    if (p.loop.on) { this.setLoop(false); return; }
    if (!(p.loop.end > p.loop.start)) {
      const sel = this.timeline.selectedNotes();
      const bar = barDur(p);
      let start;
      let end;
      if (sel.length) {
        start = timeOfBar(p, barBeatAt(p, Math.min(...sel.map((n) => n.t))).bar);
        end = timeOfBar(p, barBeatAt(p, Math.max(...sel.map((n) => n.t))).bar + 1);
      } else {
        start = timeOfBar(p, barBeatAt(p, this.audio.position).bar);
        end = start + 4 * bar;
      }
      this.store.edit('Set loop', () => { p.loop = { on: true, start: Math.max(0, start), end }; });
      toast('Looping 4 bars. Drag on the ruler to change the part that loops.');
    } else {
      this.setLoop(true);
    }
  }

  setLoop(on) {
    const p = this.store.project;
    this.store.edit(on ? 'Loop on' : 'Loop off', () => { p.loop = { ...p.loop, on }; });
    this.syncLoopButton();
  }

  syncLoopButton() {
    this.setPressed('#btn-loop', this.store.project.loop.on);
    this.timeline.dirty = true;
  }

  tapTempo() {
    const now = performance.now();
    this.taps = this.taps.filter((t) => now - t < 2500);
    this.taps.push(now);
    const btn = $('#btn-tap');
    btn.classList.add('is-tapping');
    clearTimeout(this.tapTimer);
    this.tapTimer = setTimeout(() => btn.classList.remove('is-tapping'), 2500);
    if (this.taps.length >= 4) {
      const gaps = this.taps.slice(1).map((t, i) => t - this.taps[i]);
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const bpm = Math.round(60000 / avg);
      $('#tempo').value = bpm;
      clearTimeout(this.tapApply);
      this.tapApply = setTimeout(() => this.changeTempo(bpm), 900);
    } else {
      this.hint(`Tap ${4 - this.taps.length} more time${4 - this.taps.length === 1 ? '' : 's'}…`);
    }
  }

  async changeTempo(bpm) {
    const p = this.store.project;
    if (!Number.isFinite(bpm)) { $('#tempo').value = p.tempo; return; }
    bpm = clamp(Math.round(bpm), 30, 300);
    $('#tempo').value = bpm;
    if (bpm === p.tempo) return;
    let stretch = false;
    if (this.store.notes.length) {
      const choice = await choiceBox({
        title: `Change tempo to ${bpm} BPM`,
        message: 'Should your recorded hits stay where they are, or play faster or slower to follow the new tempo?',
        choices: [
          { label: 'Cancel', value: null, ghost: true },
          { label: 'Keep my playing as it is', value: 'keep' },
          { label: bpm > p.tempo ? 'Speed up my playing' : 'Slow down my playing', value: 'stretch', primary: true },
        ],
      });
      if (!choice) { $('#tempo').value = p.tempo; return; }
      stretch = choice === 'stretch';
    }
    const old = p.tempo;
    this.store.edit('Change tempo', (proj) => {
      if (stretch) {
        const r = old / bpm;
        const o = proj.gridOrigin || 0;
        for (const take of proj.takes) {
          for (const n of take.notes) n.t = Math.max(0, o + (n.t - o) * r);
          for (const c of take.ccs) c.t = Math.max(0, o + (c.t - o) * r);
        }
        if (proj.loop.end > proj.loop.start) proj.loop = { ...proj.loop, start: o + (proj.loop.start - o) * r, end: o + (proj.loop.end - o) * r };
      }
      proj.tempo = bpm;
    });
  }

  // =====================================================================
  // Recording input
  // =====================================================================
  bindMidi() {
    this.midi.on('status', () => {
      this.updateMidiChip();
      if (this.store.project.sound.type === 'module') this.audio.moduleOut = this.midi.output;
      this.updateSoundButton();
    });
    this.midi.on('hit', (h) => this.onHit(h));
    this.midi.on('cc', (c) => {
      if (c.cc !== 4 || !this.recBuffer || !this.audio.isRecording) return;
      const t = this.audio.posForPerfTime(c.time) - this.settings.latencyMs / 1000;
      if (t >= this.recBuffer.from - 0.05) this.recBuffer.ccs.push({ t: Math.max(this.recBuffer.from, t), c: 4, v: c.value });
    });
  }

  onHit(h) {
    this.timeline.flash(h.note, h.vel);
    const led = $('#midi-led');
    led.classList.add('is-hit');
    clearTimeout(this.ledTimer);
    this.ledTimer = setTimeout(() => led.classList.remove('is-hit'), 90);
    if (this.audio.isRecording && this.recBuffer) {
      let t = this.audio.posForPerfTime(h.time) - this.settings.latencyMs / 1000;
      if (t < this.recBuffer.from - 0.12) return;
      t = Math.max(this.recBuffer.from, t);
      this.recBuffer.notes.push({ id: uid(), t, n: h.note, v: h.vel });
      if (!this.timeline.laneIndex.has(h.note)) this.timeline.rebuildLanes();
      this.timeline.dirty = true;
      if (this.recBuffer.notes.length === 1) this.updateEmptyState();
    }
    if (this.settings.monitor && this.store.project.sound.type !== 'module') this.audio.monitor(h.note, h.vel);
  }

  updateMidiChip() {
    const chip = $('#midi-chip');
    const title = $('#midi-title');
    const sub = $('#midi-sub');
    chip.classList.remove('is-ok', 'is-bad');
    const m = this.midi;
    if (m.status === 'ok') {
      chip.classList.add('is-ok');
      title.textContent = m.deviceName || 'Drum module connected';
      sub.textContent = 'Connected. Hit a pad to test it.';
    } else if (m.status === 'denied') {
      chip.classList.add('is-bad');
      title.textContent = 'MIDI is blocked';
      sub.textContent = 'Allow MIDI devices for this window';
    } else if (m.status === 'unsupported') {
      chip.classList.add('is-bad');
      title.textContent = 'This browser has no MIDI';
      sub.textContent = 'Open Simple DAW in Edge or Chrome';
    } else if (m.status === 'starting') {
      title.textContent = 'Looking for your drum module';
      sub.textContent = 'Allow MIDI if the window asks';
    } else {
      title.textContent = 'No drum module found';
      sub.textContent = 'Connect it with a USB cable';
    }
  }

  // =====================================================================
  // Song (project) handling
  // =====================================================================
  bindStore() {
    const autosave = debounce(() => this.saveNow(), 1200);
    this.autosave = autosave;
    const pump = debounce(() => this.audio.segments.pump(), 350);
    this.store.on('change', (reason) => {
      this.timeline.pruneSelection();
      this.timeline.rebuildLanes();
      this.timeline.dirty = true;
      this.syncSongUI();
      this.updateEmptyState();
      this.updateSaveState();
      autosave();
      pump();
      if (reason === 'undo' || reason === 'redo') {
        $('#backing-row').hidden = !this.store.project.backing;
        this.timeline.resize();
      }
    });
    this.store.on('settings', (reason) => {
      if (reason === 'mix') this.audio.applyMix();
      this.updateSaveState();
      autosave();
      pump();
    });
    this.store.on('load', () => this.syncSongUI());
  }

  syncSongUI() {
    const p = this.store.project;
    if (document.activeElement !== $('#tempo')) $('#tempo').value = p.tempo;
    const sig = `${p.sig[0]}/${p.sig[1]}`;
    const sel = $('#timesig');
    if (![...sel.options].some((o) => o.value === sig)) sel.append(el('option', { value: sig }, sig));
    sel.value = sig;
    this.syncLoopButton();
    const takeIdx = p.takes.findIndex((t) => t.id === p.activeTake);
    $('#takes-label').textContent = p.takes.length > 1 ? `${this.store.take.name} (${takeIdx + 1} of ${p.takes.length})` : this.store.take.name;
    $('#btn-undo').disabled = !this.store.canUndo;
    $('#btn-redo').disabled = !this.store.canRedo;
    $('#btn-undo').dataset.tip = this.store.canUndo ? `Undo ${this.store.undoStack[this.store.undoStack.length - 1].label.toLowerCase()}` : 'Nothing to undo';
    $('#btn-redo').dataset.tip = this.store.canRedo ? `Redo ${this.store.redoStack[this.store.redoStack.length - 1].label.toLowerCase()}` : 'Nothing to redo';
    this.syncBackingButtons();
    document.title = `${p.name} - Simple DAW`;
  }

  syncBackingButtons() {
    const b = this.store.project.backing;
    const btn = $('#btn-backing-mute');
    if (!b) return;
    btn.setAttribute('aria-pressed', b.muted ? 'true' : 'false');
    btn.dataset.tip = b.muted ? 'Unmute backing track' : 'Mute backing track';
    setIcon(btn.querySelector('[data-icon]'), b.muted ? 'muted' : 'speaker');
  }

  updateEmptyState() {
    const empty = !this.store.notes.length && !(this.recBuffer && this.recBuffer.notes.length) && !this.audio.isRecording;
    $('#empty-state').hidden = !empty;
  }

  updateSaveState() {
    const node = $('#save-state');
    node.classList.toggle('is-error', this.saveError);
    if (!this.serverOk) node.textContent = 'Not saved: engine offline';
    else if (this.saveError) node.textContent = 'Couldn’t save';
    else if (this.store.version !== this.savedVersion) node.textContent = 'Saving…';
    else node.textContent = this.store.file ? 'Saved' : '';
  }

  async saveNow(sync = false) {
    if (!this.serverOk) return;
    const version = this.store.version;
    if (version === this.savedVersion && this.store.file) return;
    if (!this.store.file && !this.store.notes.length && !this.store.project.backing && this.store.project.takes.length === 1) return;
    const data = this.store.serialize();
    if (sync) {
      try {
        const body = JSON.stringify({ file: this.store.file, project: data });
        navigator.sendBeacon('/api/projects/save', new Blob([body], { type: 'application/json' }));
      } catch { /* best effort */ }
      return;
    }
    try {
      const r = await api.saveProject(this.store.file, data);
      this.store.file = r.file;
      this.savedVersion = version;
      this.saveError = false;
    } catch {
      this.saveError = true;
    }
    this.updateSaveState();
  }

  async newSong(skipConfirm = false) {
    if (this.audio.isRecording) return;
    if (!skipConfirm) await this.saveNow();
    this.store.load(newProject(), null);
    this.settings.lastProject = null;
    if (this.serverOk) api.saveSettings({ lastProject: null });
    await this.afterLoad();
    const nameInput = $('#song-name');
    nameInput.focus();
    nameInput.select();
  }

  async openSong(file) {
    await this.saveNow();
    try {
      const r = await api.loadProject(file);
      this.store.load(r.project, r.file);
      this.settings.lastProject = r.file;
      await this.afterLoad();
      toast(`Opened ${this.store.project.name}.`);
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  async showOpenDialog() {
    let projects = [];
    try { projects = (await api.projects()).projects; } catch (err) { toast(err.message, { error: true }); return; }
    const list = el('div', { class: 'song-list' });
    const m = modal({
      title: 'Your songs',
      wide: true,
      body: el('div', {},
        el('p', {}, `Songs are saved automatically in ${this.folders?.projects || 'the Projects folder'}.`),
        list),
      actions: [
        { label: 'Open folder', ghost: true, onClick: () => { api.openFolder('projects'); return true; } },
        { label: 'New song', primary: true, onClick: () => { this.newSong(); } },
      ],
    });
    if (!projects.length) list.append(el('p', { class: 'note' }, 'No saved songs yet. Record something and it will show up here.'));
    for (const pr of projects) {
      const open = el('button', { class: 'btn btn-small' }, 'Open');
      const del = el('button', { class: 'btn btn-small btn-ghost btn-danger', 'aria-label': `Delete ${pr.name}` }, icon('trash'));
      const current = pr.file === this.store.file;
      const row = el('div', { class: 'song-row' },
        el('div', {},
          el('div', { class: 'song-title' }, pr.name, current ? ' (open now)' : ''),
          el('div', { class: 'song-meta' }, `${fmtDate(pr.modified)}. ${pr.hits} hits, ${fmtDuration(pr.length)} long${pr.takes > 1 ? `, ${pr.takes} takes` : ''}.`)),
        open, del);
      open.addEventListener('click', () => { m.close(); this.openSong(pr.file); });
      del.addEventListener('click', async () => {
        const ok = await confirmBox({ title: `Delete “${pr.name}”?`, message: 'It moves to Projects › Deleted songs, so you can still get it back from there.', confirmLabel: 'Delete', danger: true });
        if (!ok) return;
        await api.deleteProject(pr.file);
        if (current) await this.newSong(true);
        row.remove();
        toast(`Deleted ${pr.name}.`);
      });
      list.append(row);
    }
    hydrateIcons(list);
  }

  openSongMenu() {
    const anchor = $('#btn-song-menu');
    const hasBacking = !!this.store.project.backing;
    popover(anchor, (close) => {
      const wrap = el('div', {});
      const item = (o) => wrap.append(menuItem({ ...o, onClick: () => { close(); o.onClick(); } }));
      item({ label: 'New song', key: 'Ctrl+N', iconName: 'file', onClick: () => this.newSong() });
      item({ label: 'Open a song…', key: 'Ctrl+O', iconName: 'folder', onClick: () => this.showOpenDialog() });
      wrap.append(el('div', { class: 'menu-sep' }));
      item({ label: 'Import a MIDI file…', sub: 'Adds it as a new take', iconName: 'midi', onClick: () => $('#file-midi').click() });
      item({ label: hasBacking ? 'Replace backing track…' : 'Add a backing track…', sub: 'An MP3 or WAV to play along to', iconName: 'music', onClick: () => $('#file-audio').click() });
      if (hasBacking) item({ label: 'Remove backing track', iconName: 'close', onClick: () => this.removeBacking() });
      wrap.append(el('div', { class: 'menu-sep' }));
      item({ label: 'Export…', key: 'Ctrl+E', iconName: 'export', onClick: () => this.showExport() });
      item({ label: 'Open the Exports folder', iconName: 'folder', onClick: () => api.openFolder('exports') });
      wrap.append(el('div', { class: 'menu-sep' }));
      item({ label: 'Quit Simple DAW', iconName: 'power', onClick: () => this.quit() });
      return wrap;
    }, { width: 300 });
  }

  async quit() {
    this.audio.stop();
    await this.saveNow();
    try { await api.quit(); } catch { /* closing anyway */ }
    document.body.replaceChildren(el('div', { class: 'empty-state', style: { left: 0 } }, el('div', { class: 'empty-card' }, el('h2', {}, 'Simple DAW has stopped'), el('p', {}, 'Your song is saved. You can close this window.'))));
    setTimeout(() => window.close(), 300);
  }

  async importMidi(file) {
    let data;
    try {
      data = readMidi(await file.arrayBuffer());
    } catch (err) {
      toast(`That file couldn’t be read: ${err.message}`, { error: true });
      return;
    }
    if (!data.hits.length) { toast('That MIDI file has no drum hits in it.', { error: true }); return; }
    const p = this.store.project;
    const wasEmpty = !this.store.notes.length && p.takes.length === 1;
    const takeName = file.name.replace(/\.(mid|midi)$/i, '');
    this.store.edit('Import MIDI file', (proj) => {
      const take = newTake(takeName);
      take.notes = data.hits.map((h) => ({ id: uid(), t: h.t, n: h.n, v: h.v }));
      take.ccs = data.ccs;
      proj.takes.push(take);
      proj.activeTake = take.id;
      if (wasEmpty) {
        proj.sig = data.sig;
        proj.tempo = Math.round(data.tempo * (data.sig[1] / 4));
        proj.takes = proj.takes.filter((t) => t.notes.length);
      }
    });
    if (wasEmpty && p.name === 'Untitled song') {
      p.name = takeName;
      $('#song-name').value = takeName;
      this.store.touch('name');
    }
    this.timeline.rebuildLanes();
    this.timeline.fit();
    toast(`Imported ${data.hits.length} hits from ${file.name}.`);
  }

  async addBacking(file) {
    const note = toast(`Adding ${file.name}…`, { timeout: 30000 });
    try {
      const r = await api.uploadMedia(file.name, file);
      const buf = await this.audio.setBackingFromUrl(api.mediaUrl(r.id));
      this.store.edit('Add backing track', (p) => { p.backing = { media: r.id, name: file.name, offset: 0, muted: false }; });
      this.timeline.setBackingPeaks(computePeaks(buf));
      $('#backing-name').textContent = file.name;
      $('#backing-row').hidden = false;
      this.timeline.resize();
      this.audio.applyMix();
      if (!this.store.notes.length) this.timeline.fit();
      note.remove();
      toast('Backing track added. Drag it sideways to line it up with your drums.');
    } catch (err) {
      note.remove();
      toast(`That audio file couldn’t be used: ${err.message}`, { error: true });
    }
  }

  removeBacking() {
    this.store.edit('Remove backing track', (p) => { p.backing = null; });
    this.audio.backingBuffer = null;
    this.timeline.setBackingPeaks(null);
    $('#backing-row').hidden = true;
    this.timeline.resize();
  }

  // =====================================================================
  // Top bar & toolbar
  // =====================================================================
  bindTopbar() {
    const name = $('#song-name');
    name.addEventListener('change', () => {
      this.store.project.name = name.value.trim() || 'Untitled song';
      name.value = this.store.project.name;
      this.store.touch('name');
      this.syncSongUI();
    });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') name.blur(); });
    $('#btn-song-menu').addEventListener('click', () => this.openSongMenu());
    $('#btn-undo').addEventListener('click', () => this.undo());
    $('#btn-redo').addEventListener('click', () => this.redo());
    $('#btn-sound').addEventListener('click', () => this.openSoundMenu());
    $('#btn-mix').addEventListener('click', () => this.openMix());
    $('#btn-export').addEventListener('click', () => this.showExport());
    $('#btn-settings').addEventListener('click', () => this.openSettings());
    $('#btn-help').addEventListener('click', () => this.showHelp());
    $('#file-midi').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this.importMidi(f); });
    $('#file-audio').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this.addBacking(f); });
    $('#empty-import-midi').addEventListener('click', () => $('#file-midi').click());
    $('#empty-backing').addEventListener('click', () => $('#file-audio').click());
    $('#btn-backing-mute').addEventListener('click', () => {
      const b = this.store.project.backing;
      if (!b) return;
      b.muted = !b.muted;
      this.store.touch('mix');
      this.syncBackingButtons();
      this.timeline.dirty = true;
    });
    $('#btn-backing-remove').addEventListener('click', () => this.removeBacking());
    $('#btn-lanes').addEventListener('click', () => this.openLanesMenu());
  }

  bindToolbar() {
    const setTool = (tool) => {
      this.timeline.tool = tool;
      this.setPressed('#tool-select', tool === 'select');
      this.setPressed('#tool-draw', tool === 'draw');
      this.timeline.cv.grid.classList.toggle('tool-draw', tool === 'draw');
    };
    this.setTool = setTool;
    $('#tool-select').addEventListener('click', () => setTool('select'));
    $('#tool-draw').addEventListener('click', () => setTool('draw'));
    $('#btn-snap').addEventListener('click', () => this.saveSetting({ snap: !this.settings.snap }));
    $('#grid').addEventListener('change', (e) => { this.saveSetting({ grid: e.target.value }); this.timeline.dirty = true; });
    $('#btn-quantize').addEventListener('click', () => this.openQuantize());
    $('#btn-humanize').addEventListener('click', () => this.openHumanize());
    $('#btn-velocity').addEventListener('click', () => this.openVelocity());
    $('#btn-delete').addEventListener('click', () => this.deleteSelected());
    $('#btn-takes').addEventListener('click', () => this.openTakes());
    const zoom = $('#zoom');
    zoom.addEventListener('input', () => this.timeline.setZoomFromSlider(Number(zoom.value)));
    this.timeline.on('zoom', () => { zoom.value = this.timeline.zoomSliderValue(); });
    $('#btn-zoom-in').addEventListener('click', () => this.timeline.zoomBy(1.5));
    $('#btn-zoom-out').addEventListener('click', () => this.timeline.zoomBy(1 / 1.5));
    $('#btn-fit').addEventListener('click', () => this.timeline.fit());
    this.timeline.on('hint', (text) => this.hint(text));
    this.timeline.on('selection', (count) => {
      $('#btn-delete').disabled = count === 0;
      for (const id of ['#btn-quantize', '#btn-humanize', '#btn-velocity']) {
        const base = { '#btn-quantize': 'Line hits up with the grid', '#btn-humanize': 'Add small natural variations', '#btn-velocity': 'Make hits louder or softer' }[id];
        $(id).dataset.tip = count ? `${base} (${count} selected hit${count === 1 ? '' : 's'})` : `${base} (all hits)`;
      }
    });
    $('#btn-delete').disabled = true;
  }

  hint(text) {
    const node = $('#hint');
    const value = text || (this.audio.isRecording ? 'Recording. Press Space or R to stop.' : 'Tip: press R to record, Space to play, Ctrl+Z to undo.');
    if (value !== this.lastHint) { node.textContent = value; this.lastHint = value; }
  }

  setPressed(sel, on) { $(sel).setAttribute('aria-pressed', on ? 'true' : 'false'); }

  drawVelocity() { return this.settings.drawVelocity || 100; }
  hydrateTips(root) { hydrateIcons(root); }

  toggleMute(note) {
    const label = laneInfo(this.store.project.drumMap, note).label;
    const muted = this.store.project.mutes.includes(note);
    this.store.edit(muted ? `Unmute ${label}` : `Mute ${label}`, (p) => {
      p.mutes = muted ? p.mutes.filter((n) => n !== note) : [...p.mutes, note];
    });
    this.timeline.rebuildLanes(true);
  }

  undo() {
    if (this.audio.isRecording) return;
    const label = this.store.undo();
    if (label) this.hint(`Undid: ${label}`);
    this.afterHistory();
  }

  redo() {
    if (this.audio.isRecording) return;
    const label = this.store.redo();
    if (label) this.hint(`Redid: ${label}`);
    this.afterHistory();
  }

  afterHistory() {
    const p = this.store.project;
    if (!p.backing) { this.audio.backingBuffer = null; this.timeline.setBackingPeaks(null); }
    else if (!this.audio.backingBuffer) this.loadBacking(p.backing).catch(() => {});
    $('#backing-row').hidden = !p.backing;
    this.timeline.rebuildLanes(true);
  }

  deleteSelected() {
    const n = this.timeline.deleteSelection();
    if (n) this.hint(`Deleted ${n} hit${n === 1 ? '' : 's'}. Ctrl+Z brings ${n === 1 ? 'it' : 'them'} back.`);
  }

  // ---- edit popovers -----------------------------------------------------
  scopeText() {
    const n = this.timeline.selection.size;
    return n ? `${n} selected hit${n === 1 ? '' : 's'}` : `all ${this.store.notes.length} hits`;
  }

  openQuantize(anchor = $('#btn-quantize')) {
    popover(anchor, (close) => {
      const grid = el('select', { class: 'select-compact' }, ...Object.entries(GRIDS).map(([k, g]) => el('option', { value: k, selected: k === this.timeline.grid }, g.label)));
      const strength = el('input', { type: 'range', min: 10, max: 100, step: 5, value: this.settings.quantizeStrength });
      const val = el('span', { class: 'value' }, `${strength.value}%`);
      strength.addEventListener('input', () => { val.textContent = `${strength.value}%`; });
      const apply = el('button', { class: 'btn btn-primary' }, 'Quantize');
      apply.addEventListener('click', () => {
        this.saveSetting({ quantizeStrength: Number(strength.value) });
        const n = this.timeline.quantize({ strength: Number(strength.value) / 100, grid: grid.value });
        close();
        if (n) toast(`Quantized ${n} hit${n === 1 ? '' : 's'}. Ctrl+Z undoes it.`);
      });
      return el('div', {},
        el('h3', {}, 'Quantize'),
        el('p', { class: 'note' }, `Moves ${this.scopeText()} toward the nearest grid line. Less than 100% keeps some of your natural feel.`),
        el('div', { class: 'form-row' }, el('label', {}, 'Grid'), grid),
        el('div', { class: 'form-row' }, el('label', {}, 'Strength'), el('div', { class: 'form-inline' }, strength, val)),
        el('div', { class: 'pop-actions' }, apply));
    }, { width: 320 });
  }

  openHumanize() {
    popover($('#btn-humanize'), (close) => {
      const ms = el('input', { type: 'range', min: 0, max: 30, step: 1, value: this.settings.humanizeMs });
      const msVal = el('span', { class: 'value' }, `±${ms.value} ms`);
      ms.addEventListener('input', () => { msVal.textContent = `±${ms.value} ms`; });
      const vel = el('input', { type: 'range', min: 0, max: 30, step: 1, value: this.settings.humanizeVel });
      const velVal = el('span', { class: 'value' }, `±${vel.value}`);
      vel.addEventListener('input', () => { velVal.textContent = `±${vel.value}`; });
      const apply = el('button', { class: 'btn btn-primary' }, 'Humanize');
      apply.addEventListener('click', () => {
        this.saveSetting({ humanizeMs: Number(ms.value), humanizeVel: Number(vel.value) });
        const n = this.timeline.humanize({ timingMs: Number(ms.value), velocity: Number(vel.value) });
        close();
        if (n) toast(`Humanized ${n} hit${n === 1 ? '' : 's'}.`);
      });
      return el('div', {},
        el('h3', {}, 'Humanize'),
        el('p', { class: 'note' }, `Adds small random changes to ${this.scopeText()}, like a real drummer. Useful after quantizing or drawing hits.`),
        el('div', { class: 'form-row' }, el('label', {}, 'Timing'), el('div', { class: 'form-inline' }, ms, msVal)),
        el('div', { class: 'form-row' }, el('label', {}, 'Velocity'), el('div', { class: 'form-inline' }, vel, velVal)),
        el('div', { class: 'pop-actions' }, apply));
    }, { width: 320 });
  }

  openVelocity(anchor = $('#btn-velocity')) {
    popover(anchor, (close) => {
      const set = el('input', { type: 'range', min: 1, max: 127, step: 1, value: 100 });
      const setVal = el('span', { class: 'value' }, '100');
      set.addEventListener('input', () => { setVal.textContent = set.value; });
      const softer = el('button', { class: 'btn' }, 'Softer');
      const louder = el('button', { class: 'btn' }, 'Louder');
      const even = el('button', { class: 'btn' }, 'Even out');
      const apply = el('button', { class: 'btn btn-primary' }, 'Set');
      softer.addEventListener('click', () => this.timeline.changeVelocity((v) => v * 0.88, 'Make hits softer'));
      louder.addEventListener('click', () => this.timeline.changeVelocity((v) => v * 1.12 + 1, 'Make hits louder'));
      even.addEventListener('click', () => {
        const t = this.timeline.targetNotes();
        if (!t.length) return;
        const avg = t.reduce((a, n) => a + n.v, 0) / t.length;
        this.timeline.changeVelocity((v) => v + (avg - v) * 0.5, 'Even out velocity');
      });
      apply.addEventListener('click', () => {
        this.timeline.changeVelocity(() => Number(set.value), 'Set velocity');
        close();
      });
      return el('div', {},
        el('h3', {}, 'Velocity'),
        el('p', { class: 'note' }, `Changes how hard ${this.scopeText()} are. You can also drag in the Velocity strip under the drums.`),
        el('div', { class: 'pop-actions', style: { justifyContent: 'flex-start' } }, softer, louder, even),
        el('div', { class: 'form-row' }, el('label', {}, 'Set them all to'), el('div', { class: 'form-inline' }, set, setVal, apply)));
    }, { width: 340 });
  }

  openTakes() {
    popover($('#btn-takes'), (close) => {
      const p = this.store.project;
      const wrap = el('div', {}, el('h3', {}, 'Takes'), el('p', { class: 'note' }, 'Every recording is kept as its own take. Pick one to hear and edit it.'));
      p.takes.forEach((t) => {
        const row = el('div', { class: 'form-inline', style: { gap: '4px' } });
        const pick = menuItem({
          label: t.name,
          sub: `${t.notes.length} hits, recorded ${fmtDate(t.created / 1000)}`,
          active: t.id === p.activeTake,
          onClick: () => {
            this.store.edit(`Switch to ${t.name}`, (proj) => { proj.activeTake = t.id; });
            this.timeline.clearSelection();
            close();
          },
        });
        const rename = el('button', { class: 'lane-btn', style: { opacity: 1 }, 'aria-label': `Rename ${t.name}`, 'data-tip': 'Rename' }, icon('pencil'));
        rename.addEventListener('click', () => {
          const input = el('input', { class: 'text-input', value: t.name, maxlength: 40 });
          row.replaceChildren(input);
          input.focus();
          input.select();
          const done = () => {
            const v = input.value.trim();
            if (v && v !== t.name) this.store.edit('Rename take', () => { t.name = v; });
            close();
          };
          input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); if (e.key === 'Escape') close(); });
          input.addEventListener('blur', done);
        });
        row.append(pick, rename);
        if (p.takes.length > 1) {
          const del = el('button', { class: 'lane-btn', style: { opacity: 1 }, 'aria-label': `Delete ${t.name}`, 'data-tip': 'Delete this take' }, icon('trash'));
          del.addEventListener('click', () => {
            this.store.edit(`Delete ${t.name}`, (proj) => {
              proj.takes = proj.takes.filter((x) => x.id !== t.id);
              if (proj.activeTake === t.id) proj.activeTake = proj.takes[proj.takes.length - 1].id;
            });
            close();
            toast(`Deleted ${t.name}. Ctrl+Z brings it back.`);
          });
          row.append(del);
        }
        wrap.append(row);
      });
      const empty = el('button', { class: 'btn btn-small', style: { margin: '8px' } }, icon('plus'), 'New empty take');
      empty.addEventListener('click', () => {
        this.store.edit('New take', (proj) => {
          const take = newTake(this.nextTakeName());
          proj.takes.push(take);
          proj.activeTake = take.id;
        });
        close();
      });
      wrap.append(empty);
      return wrap;
    }, { align: 'end', width: 360 });
  }

  openLanesMenu() {
    popover($('#btn-lanes'), (close) => {
      const p = this.store.project;
      const wrap = el('div', {}, el('h3', {}, 'Drum lanes'));
      wrap.append(menuItem({
        label: 'Show every drum',
        sub: 'Also show lanes you haven’t played yet',
        active: this.timeline.showAllLanes,
        onClick: () => { this.timeline.showAllLanes = !this.timeline.showAllLanes; this.timeline.rebuildLanes(true); close(); },
      }));
      wrap.append(menuItem({
        label: 'Show percussion lanes',
        sub: 'Congas, bongos, shaker, tambourine and the rest of General MIDI percussion',
        active: this.timeline.showPercLanes,
        onClick: () => { this.timeline.showPercLanes = !this.timeline.showPercLanes; this.timeline.rebuildLanes(true); close(); },
      }));
      if (p.mutes.length) {
        wrap.append(menuItem({ label: 'Unmute all drums', iconName: 'speaker', onClick: () => { this.store.edit('Unmute all', (proj) => { proj.mutes = []; }); this.timeline.rebuildLanes(true); close(); } }));
      }
      wrap.append(el('div', { class: 'section-title' }, 'My module is a…'));
      for (const map of Object.values(MAPS)) {
        wrap.append(menuItem({ label: map.name, sub: map.hint, active: p.drumMap === map.id, onClick: () => { close(); this.setDrumMap(map.id); } }));
      }
      return wrap;
    }, { width: 330 });
  }

  setDrumMap(id) {
    this.saveSetting({ drumMap: id });
    this.store.project.drumMap = id;
    this.store.touch('drum-map');
    this.timeline.seenNotes.clear();
    this.timeline.rebuildLanes(true);
    toast(`Lane names now follow the ${MAPS[id].name} note map.`);
  }

  openGridMenu(e, note) {
    const at = { x: e.clientX, y: e.clientY };
    const hitSelected = note && this.timeline.selection.has(note.id);
    if (note && !hitSelected) { this.timeline.selection = new Set([note.id]); this.timeline.emitSelection(); this.timeline.dirty = true; }
    const t = this.timeline.x2t(this.timeline.local(e, this.timeline.cv.grid).x);
    popover(at, (close) => {
      const wrap = el('div', {});
      const item = (o) => wrap.append(menuItem({ ...o, onClick: () => { close(); o.onClick(); } }));
      const n = this.timeline.selection.size;
      if (n) {
        item({ label: `Delete ${n > 1 ? `${n} hits` : 'hit'}`, key: 'Del', iconName: 'trash', onClick: () => this.deleteSelected() });
        item({ label: 'Copy', key: 'Ctrl+C', iconName: 'takes', onClick: () => this.timeline.copy() });
        item({ label: 'Duplicate after itself', key: 'Ctrl+D', iconName: 'plus', onClick: () => this.timeline.duplicate() });
        item({ label: 'Move to another drum…', iconName: 'move', onClick: () => this.openLanePicker(null, 'move', at) });
        item({ label: 'Copy to another drum…', iconName: 'copy', onClick: () => this.openLanePicker(null, 'copy', at) });
        item({ label: 'Quantize…', key: 'Q', iconName: 'quantize', onClick: () => this.openQuantize($('#btn-quantize')) });
        item({ label: 'Velocity…', iconName: 'velocity', onClick: () => this.openVelocity($('#btn-velocity')) });
      }
      if (note) {
        const info = { label: this.laneDisplay(note.n).label };
        item({
          label: `Select every ${info.label} hit`, iconName: 'lanes',
          onClick: () => {
            this.timeline.selection = new Set(this.store.notes.filter((x) => x.n === note.n).map((x) => x.id));
            this.timeline.emitSelection();
            this.timeline.dirty = true;
          },
        });
        item({ label: `${info.label}: sound, volume and more…`, iconName: 'more', onClick: () => this.openLaneMenu(note.n, at) });
      }
      if (this.timeline.clipboard?.length) item({ label: 'Paste here', key: 'Ctrl+V', iconName: 'file', onClick: () => this.timeline.paste(t) });
      item({ label: 'Select all hits', key: 'Ctrl+A', iconName: 'cursor', onClick: () => this.timeline.selectAll() });
      return wrap;
    }, { width: 260 });
  }

  // ---- mix ---------------------------------------------------------------
  openMix() {
    popover($('#btn-mix'), () => {
      const p = this.store.project;
      const wrap = el('div', {}, el('h3', {}, 'Mix'));
      const slider = (label, get, set, max = 100) => {
        const input = el('input', { type: 'range', min: 0, max, step: 1, value: Math.round(get() * 100) });
        const val = el('span', { class: 'value' }, `${input.value}`);
        input.addEventListener('input', () => {
          val.textContent = input.value;
          set(Number(input.value) / 100);
          this.audio.applyMix();
        });
        input.addEventListener('change', () => this.store.touch('mix'));
        return el('div', { class: 'slider-row' }, el('label', {}, label), input, val);
      };
      wrap.append(slider('Drums', () => p.mix.drums, (v) => { p.mix.drums = v; }));
      if (p.backing) wrap.append(slider('Backing track', () => p.mix.backing, (v) => { p.mix.backing = v; }));
      wrap.append(slider('Click', () => p.mix.click, (v) => { p.mix.click = v; }));
      wrap.append(slider('Everything', () => p.mix.master, (v) => { p.mix.master = v; }));
      if (p.sound.type === 'kit') {
        wrap.append(el('div', { class: 'section-title' }, 'Built-in kit balance'));
        const parts = [['kick', 'Kick'], ['snare', 'Snare'], ['tom', 'Toms'], ['hat', 'Hi-hat'], ['cym', 'Cymbals'], ['ride', 'Ride'], ['perc', 'Percussion']];
        for (const [key, label] of parts) {
          wrap.append(slider(label, () => p.mix.kit[key] ?? 1, (v) => { p.mix.kit[key] = v; }, 150));
        }
      } else if (p.sound.type === 'sfz' && this.kitControls.length) {
        const sfzSound = p.sound.sfz;
        sfzSound.cc = sfzSound.cc || {};
        const pretty = (label) => label.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/\s+/g, ' ').trim();
        const skip = /^(vol|pan|pedal|contact|split|bleed|width)/i;
        const vols = this.kitControls.filter((c) => !skip.test(c.label) && c.cc !== 4);
        const pans = this.kitControls.filter((c) => /^pan /i.test(c.label));
        const kitSlider = (c, label) => slider(label, () => sfzSound.cc[c.cc] ?? c.default, (v) => { sfzSound.cc[c.cc] = v; }, 100);
        if (vols.length) {
          wrap.append(el('div', { class: 'section-title' }, 'Kit mixer (mics and drums)'));
          for (const c of vols) wrap.append(kitSlider(c, pretty(c.label)));
        }
        if (pans.length) {
          wrap.append(el('div', { class: 'section-title' }, 'Kit panning (50 is centre)'));
          for (const c of pans) wrap.append(kitSlider(c, pretty(c.label.replace(/^pan /i, ''))));
        }
        const reset = el('button', { class: 'btn btn-small btn-ghost' }, icon('refresh'), 'Reset kit mixer');
        reset.addEventListener('click', () => { sfzSound.cc = {}; this.store.touch('mix'); closePopover(); this.openMix(); });
        wrap.append(el('div', { class: 'pop-actions', style: { justifyContent: 'flex-start' } }, reset));
      } else if (p.sound.type === 'plugin') {
        wrap.append(el('p', { class: 'note' }, 'To balance kick, snare and cymbals, use the mixer in the plugin window.'));
      }
      if (p.sound.type === 'kit' || p.sound.type === 'sfz') {
        const used = new Set(this.store.notes.map((n) => n.n));
        const lanes = this.timeline.lanes.filter((n) => used.has(n));
        if (lanes.length) {
          wrap.append(el('div', { class: 'section-title' }, 'Drum volumes'));
          p.mix.lanes = p.mix.lanes || {};
          for (const n of lanes) {
            wrap.append(slider(this.laneDisplay(n).label, () => this.laneVolume(n), (v) => {
              if (Math.abs(v - 1) < 0.005) delete p.mix.lanes[n]; else p.mix.lanes[n] = v;
            }, 150));
          }
          if (Object.keys(p.mix.lanes).length) {
            const resetLanes = el('button', { class: 'btn btn-small btn-ghost' }, icon('refresh'), 'Reset drum volumes');
            resetLanes.addEventListener('click', () => { p.mix.lanes = {}; this.store.touch('mix'); closePopover(); this.openMix(); });
            wrap.append(el('div', { class: 'pop-actions', style: { justifyContent: 'flex-start' } }, resetLanes));
          }
        }
      }
      return wrap;
    }, { align: 'end', width: 340 });
  }

  // ---- export --------------------------------------------------------------
  showExport() {
    if (this.audio.isRecording) return;
    this.audio.stop();
    const p = this.store.project;
    const hasLoop = p.loop.end > p.loop.start;
    const kind = el('div', { class: 'radio-list' });
    const radio = (name, value, label, sub, checked, disabled) => {
      const input = el('input', { type: 'radio', name, value, checked, disabled });
      return el('label', { class: 'check' }, input, el('span', {}, label, sub ? el('span', { class: 'mi-sub' }, sub) : null));
    };
    const moduleSound = p.sound.type === 'module';
    kind.append(
      radio('kind', 'wav', 'Audio file (WAV)', moduleSound ? 'Pick a built-in kit or a plugin first: your module’s own sound can’t be captured.' : 'Your drums with the sound you picked. Plays anywhere.', !moduleSound, moduleSound),
      radio('kind', 'mid', 'MIDI file', 'The hits only, to use in another program or plugin.', moduleSound, false),
    );
    const name = el('input', { class: 'text-input', value: p.name, maxlength: 80 });
    const backing = el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: true }), el('span', {}, 'Include the backing track'));
    const range = el('div', { class: 'radio-list' },
      radio('range', 'all', 'Whole song', null, true, false),
      radio('range', 'loop', 'Only the loop', hasLoop ? null : 'Set a loop on the ruler first', false, !hasLoop));
    const status = el('div', {});
    const body = el('div', {},
      el('div', { class: 'form-row' }, el('span', { class: 'form-label' }, 'What to export'), kind),
      el('div', { class: 'form-row' }, el('label', {}, 'File name'), name),
      el('div', { class: 'form-row' }, el('span', { class: 'form-label' }, 'Which part'), range),
      p.backing ? backing : null,
      status);
    const syncKind = () => {
      const k = body.querySelector('input[name="kind"]:checked')?.value;
      backing.hidden = k !== 'wav' || !p.backing;
    };
    body.addEventListener('change', syncKind);
    syncKind();
    let busy = false;
    modal({
      title: 'Export',
      body,
      actions: [
        { label: 'Cancel', ghost: true },
        {
          label: 'Export',
          primary: true,
          onClick: async ({ button }) => {
            if (busy) return true;
            const k = body.querySelector('input[name="kind"]:checked')?.value;
            const r = body.querySelector('input[name="range"]:checked')?.value;
            if (!this.store.notes.length) { status.replaceChildren(el('div', { class: 'callout is-error' }, 'There are no hits to export yet.')); return true; }
            busy = true;
            button.disabled = true;
            const bar = el('div', { class: 'progress' }, el('span', {}));
            status.replaceChildren(el('p', { class: 'note' }, 'Exporting…'), bar);
            try {
              const file = await this.doExport({
                kind: k,
                range: r,
                name: name.value.trim() || p.name,
                includeBacking: !!backing.querySelector('input')?.checked,
                onProgress: (f) => { bar.firstChild.style.width = `${Math.round(f * 100)}%`; },
              });
              toast(`Exported ${file.file} to the Exports folder.`, { actionLabel: 'Show in folder', onAction: () => api.reveal(file.path), timeout: 9000 });
              return false;
            } catch (err) {
              status.replaceChildren(el('div', { class: 'callout is-error' }, err.message));
              busy = false;
              button.disabled = false;
              return true;
            }
          },
        },
      ],
    });
  }

  async doExport({ kind, range, name, includeBacking, onProgress }) {
    const p = this.store.project;
    const loop = range === 'loop' && p.loop.end > p.loop.start;
    const start = loop ? p.loop.start : 0;
    const end = loop ? p.loop.end : Math.max(this.store.lastNoteTime() + 2.5, includeBacking && p.backing && this.audio.backingBuffer ? (p.backing.offset || 0) + this.audio.backingBuffer.duration : 0);
    const notes = this.store.notes.filter((n) => n.t >= start && n.t < end && !p.mutes.includes(n.n));
    if (kind === 'mid') {
      const convert = p.sound.type === 'plugin' ? p.sound.convertGM !== false : false;
      const bytes = writeMidi({
        hits: notes.map((n) => ({ t: n.t - start, n: outputNote(p.drumMap, n.n, convert), v: n.v })),
        ccs: this.store.ccs.filter((c) => c.t >= start && c.t < end).map((c) => ({ t: c.t - start, c: c.c, v: c.v })),
        tempo: quarterBpm(p),
        sig: p.sig,
        name: p.name,
      });
      onProgress?.(0.8);
      return api.saveExport(name, 'mid', new Blob([bytes], { type: 'audio/midi' }));
    }
    if (p.sound.type === 'module') throw new Error('Your module’s own sound can’t be exported. Pick a built-in kit or a plugin in Sound, or export a MIDI file.');
    let pluginAudio = null;
    if (p.sound.type === 'plugin' || p.sound.type === 'sfz') {
      if (this.pluginStatus !== 'ready') throw new Error('The sound isn’t ready. Open the Sound menu to fix it, or switch to a built-in kit.');
      onProgress?.(0.1);
      const all = this.store.notes.filter((n) => !p.mutes.includes(n.n) && n.t >= start - PRE && n.t < end);
      const hits = this.audio.engineHits(all);
      pluginAudio = await api.render({
        notes: hits.notes,
        routes: hits.routes,
        ccs: this.store.ccs.map((c) => [c.t, c.c, c.v]),
        start,
        preroll: Math.min(start, PRE),
        length: end - start,
        sampleRate: this.audio.ctx.sampleRate,
        cc: this.audio.engineCC(),
      });
      onProgress?.(0.45);
    } else if (!this.audio.sampler.kit) {
      await this.loadKit(p.sound.kit || 'black-pearl');
    }
    const channels = await this.audio.renderOffline({ start, end, includeBacking, pluginAudio, onProgress });
    const peak = peakOf(channels);
    if (peak > 0.98) {
      const g = 0.98 / peak;
      for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] *= g;
    }
    const wav = encodeWav(channels, this.audio.ctx.sampleRate, 24);
    onProgress?.(0.95);
    return api.saveExport(name, 'wav', new Blob([wav], { type: 'audio/wav' }));
  }

  // ---- settings, help, welcome ---------------------------------------------
  openSettings() {
    const s = this.settings;
    const m = this.midi;
    const inputSel = el('select', { class: 'select-compact' },
      el('option', { value: 'all' }, 'All connected devices'),
      ...m.inputs.map((i) => el('option', { value: i.id, selected: s.midiInput === i.id }, i.name)));
    inputSel.value = m.inputs.some((i) => i.id === s.midiInput) ? s.midiInput : 'all';
    inputSel.addEventListener('change', () => { this.saveSetting({ midiInput: inputSel.value }); m.setInput(inputSel.value); });
    const outputSel = el('select', { class: 'select-compact' },
      el('option', { value: 'auto' }, 'Same device as the input'),
      ...m.outputs.map((o) => el('option', { value: o.id, selected: s.midiOutput === o.id }, o.name)));
    outputSel.value = m.outputs.some((o) => o.id === s.midiOutput) ? s.midiOutput : 'auto';
    outputSel.addEventListener('change', () => { this.saveSetting({ midiOutput: outputSel.value }); m.setOutput(outputSel.value); });

    const mapList = el('div', { class: 'radio-list' });
    for (const map of Object.values(MAPS)) {
      const input = el('input', { type: 'radio', name: 'drummap', value: map.id, checked: this.store.project.drumMap === map.id });
      input.addEventListener('change', () => this.setDrumMap(map.id));
      mapList.append(el('label', { class: 'check' }, input, el('span', {}, map.name, el('span', { class: 'mi-sub' }, map.hint))));
    }

    const lat = el('input', { type: 'range', min: -60, max: 60, step: 1, value: s.latencyMs });
    const latVal = el('span', { class: 'value' }, `${s.latencyMs > 0 ? '+' : ''}${s.latencyMs} ms`);
    lat.addEventListener('input', () => { latVal.textContent = `${lat.value > 0 ? '+' : ''}${lat.value} ms`; });
    lat.addEventListener('change', () => this.saveSetting({ latencyMs: Number(lat.value) }));

    const monitor = el('input', { type: 'checkbox', checked: s.monitor });
    monitor.addEventListener('change', () => this.saveSetting({ monitor: monitor.checked }));

    const midiState = m.status === 'ok'
      ? el('div', { class: 'callout' }, `Connected: ${m.deviceName}. Hit a pad and watch its lane light up.`)
      : m.status === 'denied'
        ? el('div', { class: 'callout is-error' }, 'MIDI is blocked for this window. Click the icon at the left of the window’s title bar (or the “…” menu), open the site permissions, allow MIDI devices, then reload with F5.')
        : el('div', { class: 'callout is-error' }, 'No drum module found. Plug it in with USB and turn it on. If another program (like Cakewalk or Audacity) is using it, close that program first.');

    modal({
      title: 'Settings',
      wide: true,
      body: el('div', { class: 'help-cols' },
        el('div', {},
          el('h3', {}, 'Drum module'),
          midiState,
          el('div', { class: 'form-row' }, el('label', {}, 'Record from'), inputSel),
          el('div', { class: 'form-row' }, el('label', {}, 'Send to (for “Your drum module” sound)'), outputSel),
          el('h3', {}, 'Note map'),
          el('p', { class: 'note', style: { margin: '2px 8px 4px' } }, 'Which pads your module sends, so lanes get the right names.'),
          mapList),
        el('div', {},
          el('h3', {}, 'Timing'),
          el('div', { class: 'form-row' },
            el('label', {}, 'Timing correction'),
            el('div', { class: 'form-inline' }, lat, latVal),
            el('span', { class: 'help' }, 'If your recorded hits always land a little late compared to the click, move this to the left. Late by about 20 ms? Set −20.')),
          el('label', { class: 'check' }, monitor, el('span', {}, 'Play the built-in kit while I record', el('span', { class: 'mi-sub' }, 'Usually not needed: your module already plays its own sound. It can feel slightly late.'))),
          el('h3', {}, 'Where things are saved'),
          el('p', { class: 'note' }, `Songs: ${this.folders?.projects || 'Projects folder'}`),
          el('p', { class: 'note' }, `Exports: ${this.folders?.exports || 'Exports folder'}`))),
      actions: [{ label: 'Done', primary: true }],
    });
  }

  showHelp() {
    const keys = [
      ['Space', 'Play or stop'], ['R', 'Record or stop recording'], ['Home', 'Back to the start'],
      ['L', 'Loop on or off'], ['M', 'Click on or off'], ['T', 'Tap tempo'],
      ['V / D', 'Select or Draw tool'], ['G', 'Snap to grid on or off'], ['Q', 'Quantize'],
      ['Del', 'Delete selected hits'], ['Ctrl+Z / Ctrl+Y', 'Undo / redo'], ['Ctrl+A', 'Select all hits'],
      ['Ctrl+C / Ctrl+V', 'Copy / paste at the playhead'], ['Ctrl+D', 'Duplicate selection'],
      ['← →', 'Nudge selected hits, or jump one bar'], ['↑ ↓', 'Move selected hits to another drum'],
      ['+ / −', 'Zoom in / out'], ['F', 'Show the whole song'], ['Ctrl+E', 'Export'], ['Ctrl+O / Ctrl+N', 'Open / new song'],
    ];
    const dl = el('dl', { class: 'key-table' });
    for (const [k, d] of keys) dl.append(el('dt', {}, el('kbd', {}, k)), el('dd', {}, d));
    modal({
      title: 'Help',
      wide: true,
      body: el('div', { class: 'help-cols' },
        el('div', {},
          el('h3', {}, 'How it works'),
          el('p', { class: 'note' }, 'While you play, your module keeps its own sound and Simple DAW records every hit as MIDI. On playback you hear the hits through the sound you pick in Sound: a built-in kit, a sample kit like Naked Drums (Sound › Get more kits), your module, or a plugin.'),
          el('p', { class: 'note' }, 'Each recording becomes a new take, so nothing is lost. Songs save themselves; finished files go to the Exports folder.'),
          el('h3', {}, 'Mouse'),
          el('p', { class: 'note' }, 'Double-click a lane to add a hit, double-click a hit to delete it. Drag hits to move them, drag empty space to select several. Scroll to move through the song, Ctrl+scroll to zoom, Shift+scroll to see more drums.'),
          el('h3', {}, 'Drums and their sounds'),
          el('p', { class: 'note' }, 'Right-click a drum name (or use its ••• button) to move, copy or swap its hits with another drum, change its volume, or give it a sound from any of your kits, like a tom from another kit or a conga from Percussion.'),
          el('h3', {}, 'Credits'),
          el('p', { class: 'note' }, 'Built-in kits: AVL Drumkits by Glen MacArthur (CC BY-SA 3.0). Sample kits: Naked Drums by Wilkinson Audio, Muldjord Kit and DRS Kit by the DrumGizmo team, SFZ versions by kinwie (CC BY 4.0). Percussion: samples from the Versilian Community Sample Library by Versilian Studios (CC0). Plugin hosting: DawDreamer (GPLv3). Typefaces: Barlow and Saira Stencil (SIL Open Font License).')),
        el('div', {}, el('h3', {}, 'Keyboard shortcuts'), dl)),
      actions: [{ label: 'Close', primary: true }],
    });
  }

  showWelcome() {
    const steps = el('ol', { class: 'empty-steps', style: { margin: '6px 8px 10px' } },
      el('li', {}, el('span', { class: 'step-n' }, '1'), 'Plug your drum module into the computer with USB and turn it on.'),
      el('li', {}, el('span', { class: 'step-n' }, '2'), 'If the window asks to use MIDI devices, click Allow.'),
      el('li', {}, el('span', { class: 'step-n' }, '3'), 'Hit a pad: its lane lights up. Press R, wait for the count-in, and play.'),
      el('li', {}, el('span', { class: 'step-n' }, '4'), 'Press Space to hear it back with a realistic kit. Try different sounds in the Sound menu.'));
    modal({
      title: 'Welcome to Simple DAW',
      body: el('div', {}, el('p', {}, 'Record your e-drums as MIDI, then hear them with a real-sounding kit instead of the same sample on every hit.'), steps),
      actions: [{ label: 'Start', primary: true, onClick: () => { this.saveSetting({ welcomed: true }); } }],
      onClose: () => this.saveSetting({ welcomed: true }),
    });
  }

  showOffline() {
    modal({
      title: 'Simple DAW isn’t running',
      dismissable: true,
      body: el('p', {}, 'This window can’t reach Simple DAW’s engine, so nothing can be saved. Close this window and double-click “Start Simple DAW” in your Simple DAW folder.'),
      actions: [{ label: 'Try again', primary: true, onClick: () => { location.reload(); } }],
    });
    this.updateSaveState();
  }

  // =====================================================================
  // Keyboard
  // =====================================================================
  bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (modalIsOpen()) return;
      if (isTyping(e)) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key;
      const tl = this.timeline;
      const handled = () => { e.preventDefault(); e.stopPropagation(); };
      if (key === ' ') { handled(); this.togglePlay(); return; }
      if (ctrl) {
        const k = key.toLowerCase();
        if (k === 'z' && !e.shiftKey) { handled(); this.undo(); }
        else if ((k === 'z' && e.shiftKey) || k === 'y') { handled(); this.redo(); }
        else if (k === 'a') { handled(); tl.selectAll(); }
        else if (k === 'c') { handled(); const n = tl.copy(); if (n) this.hint(`Copied ${n} hit${n === 1 ? '' : 's'}.`); }
        else if (k === 'x') { handled(); if (tl.copy()) this.deleteSelected(); }
        else if (k === 'v') { handled(); tl.paste(this.audio.position); }
        else if (k === 'd') { handled(); tl.duplicate(); }
        else if (k === 's') { handled(); this.saveNow().then(() => toast('Saved.')); }
        else if (k === 'e') { handled(); this.showExport(); }
        else if (k === 'o') { handled(); this.showOpenDialog(); }
        else if (k === 'n') { handled(); this.newSong(); }
        return;
      }
      if (e.altKey) return;
      switch (key) {
        case 'r': case 'R': handled(); this.toggleRecord(); break;
        case 'Home': handled(); this.goHome(); break;
        case 'End': handled(); this.audio.seek(this.store.lastNoteTime()); tl.reveal(this.audio.position); break;
        case 'l': case 'L': handled(); this.toggleLoop(); break;
        case 'm': case 'M': handled(); this.saveSetting({ click: !this.settings.click }); break;
        case 't': case 'T': handled(); this.tapTempo(); break;
        case 'v': case 'V': handled(); this.setTool('select'); break;
        case 'd': case 'D': handled(); this.setTool('draw'); break;
        case 'g': case 'G': handled(); this.saveSetting({ snap: !this.settings.snap }); break;
        case 'q': case 'Q': {
          handled();
          const n = tl.quantize({ strength: this.settings.quantizeStrength / 100 });
          if (n) toast(`Quantized ${n} hit${n === 1 ? '' : 's'} to ${GRIDS[tl.grid].label}. Ctrl+Z undoes it.`);
          break;
        }
        case 'f': case 'F': handled(); tl.fit(); break;
        case 'Delete': case 'Backspace': handled(); this.deleteSelected(); break;
        case 'Escape': handled(); if (this.audio.isRecording) this.stopRecording(); else tl.clearSelection(); break;
        case '+': case '=': handled(); tl.zoomBy(1.4, tl.t2x(this.audio.position)); break;
        case '-': case '_': handled(); tl.zoomBy(1 / 1.4, tl.t2x(this.audio.position)); break;
        case '?': handled(); this.showHelp(); break;
        case 'ArrowLeft': case 'ArrowRight': {
          handled();
          const dir = key === 'ArrowLeft' ? -1 : 1;
          if (tl.selection.size) tl.nudge(dir);
          else if (!this.audio.isRecording) {
            const p = this.store.project;
            const bb = barBeatAt(p, this.audio.position + (dir < 0 ? -0.001 : 0));
            const target = timeOfBar(p, dir > 0 ? bb.bar + 1 : Math.max(1, bb.bar));
            this.audio.seek(Math.max(0, target));
            tl.reveal(this.audio.position);
          }
          break;
        }
        case 'ArrowUp': case 'ArrowDown':
          if (tl.selection.size) { handled(); tl.moveLanes(key === 'ArrowUp' ? -1 : 1); }
          break;
        default: break;
      }
    });
  }

  // =====================================================================
  // Audio events & readouts
  // =====================================================================
  bindAudio() {
    this.audio.on('state', (state) => {
      const playBtn = $('#btn-play');
      const playing = state !== 'stopped';
      playBtn.classList.toggle('is-playing', playing);
      playBtn.setAttribute('aria-label', playing ? 'Stop' : 'Play');
      setIcon(playBtn.querySelector('[data-icon]'), playing ? 'stop' : 'play');
      const rec = $('#btn-record');
      rec.setAttribute('aria-pressed', state === 'recording' ? 'true' : 'false');
      rec.dataset.tip = state === 'recording' ? 'Stop recording' : 'Record';
      if (state !== 'recording') rec.classList.remove('is-countin');
      this.timeline.dirty = true;
      this.hint(null);
      this.updateEmptyState();
    });
    this.audio.on('seek', () => { this.timeline.dirty = true; });
    this.audio.on('preparing', (on) => {
      $('#btn-play').classList.toggle('is-busy', on);
      if (on) this.hint('Preparing the plugin sound for this part of the song…');
      else this.hint(null);
    });
    this.audio.on('plugin-busy', (busy) => this.updateEngineStatus(busy));
    this.audio.on('plugin-silent', () => {
      if (this.silentWarned) return;
      this.silentWarned = true;
      const snd = this.store.project.sound;
      const name = (snd.type === 'sfz' ? snd.sfz?.name : snd.plugin?.name) || 'The sound';
      const tip = snd.type === 'sfz' ? 'Some of its files may be missing.' : 'If there’s a VST2 version of it, try that one instead.';
      toast(`${name} isn’t making any sound for your hits. ${tip}`, {
        error: true,
        actionLabel: 'Use built-in kit',
        onAction: () => this.chooseKit(this.store.project.sound.kit || 'black-pearl'),
      });
    });
    let lastErr = 0;
    this.audio.on('plugin-error', (err) => {
      if (/crash|closed|took too long/i.test(err.message)) {
        this.pluginStatus = 'error';
        this.pluginError = err.message;
        this.audio.segments.enabled = false;
        this.updateSoundButton();
      }
      if (performance.now() - lastErr > 5000) {
        lastErr = performance.now();
        toast(`Plugin sound problem: ${err.message}`, { error: true, actionLabel: 'Use built-in kit', onAction: () => this.chooseKit(this.store.project.sound.kit || 'black-pearl') });
      }
    });
  }

  startReadoutLoop() {
    const barNode = $('#pos-bar');
    const beatNode = $('#pos-beat');
    const timeNode = $('#pos-time');
    const unitNode = document.querySelector('.readout-unit');
    const rec = $('#btn-record');
    let last = '';
    const loop = () => {
      const p = this.store.project;
      const pos = this.audio.position;
      let main;
      let unit = 'bar.beat';
      const counting = this.audio.isRecording && this.audio.recordFrom !== null && pos < this.audio.recordFrom - 0.005;
      if (counting) {
        const beats = Math.ceil((this.audio.recordFrom - pos) / beatDur(p) - 1e-6);
        main = [String(beats), ''];
        unit = 'count-in';
      } else {
        const bb = barBeatAt(p, Math.max(0, pos));
        main = [String(bb.bar), String(bb.beat)];
      }
      const time = fmtTime(Math.max(0, pos));
      const key = `${main.join('.')}|${unit}|${time}`;
      if (key !== last) {
        last = key;
        barNode.textContent = main[0];
        beatNode.textContent = main[1];
        beatNode.previousElementSibling.style.visibility = main[1] ? 'visible' : 'hidden';
        unitNode.textContent = unit;
        timeNode.textContent = time;
      }
      rec.classList.toggle('is-countin', counting);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}

const app = new App();
window.simpleDaw = app;
app.api = api;
app.boot().catch((err) => {
  console.error(err);
  toast(`Simple DAW hit a problem while starting: ${err.message}`, { error: true });
});
