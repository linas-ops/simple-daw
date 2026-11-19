// How MIDI note numbers from a drum module turn into named lanes, and how
// those notes are sent on to plugins and the built-in kits.
//
// Lane order follows drum notation: cymbals on top, kick at the bottom.

export const FAMILIES = {
  cym:   { label: 'Cymbals', color: '#e8bc5a' },
  ride:  { label: 'Ride', color: '#7cc3a4' },
  hat:   { label: 'Hi-hat', color: '#e08b4f' },
  tom:   { label: 'Toms', color: '#6fa3e8' },
  snare: { label: 'Snare', color: '#ece8de' },
  kick:  { label: 'Kick', color: '#e0566b' },
  perc:  { label: 'Percussion', color: '#b79be6' },
};

// [note, label, family, order, built-in voice, General MIDI equivalent]
const GM_ENTRIES = [
  [49, 'Crash', 'cym', 10, 'crash1', 49],
  [57, 'Crash 2', 'cym', 12, 'crash2', 57],
  [55, 'Splash', 'cym', 14, 'splash', 55],
  [52, 'China', 'cym', 16, 'china', 52],
  [51, 'Ride', 'ride', 20, 'ride', 51],
  [59, 'Ride 2', 'ride', 22, 'rideEdge', 59],
  [53, 'Ride bell', 'ride', 24, 'bell', 53],
  [46, 'Hi-hat open', 'hat', 30, 'hhOpen', 46],
  [42, 'Hi-hat closed', 'hat', 32, 'hhClosed', 42],
  [44, 'Hi-hat pedal', 'hat', 34, 'hhPedal', 44],
  [50, 'High tom', 'tom', 40, 'tom1', 50],
  [48, 'Tom 1', 'tom', 41, 'tom1', 48],
  [47, 'Low-mid tom', 'tom', 42, 'tom2', 47],
  [45, 'Tom 2', 'tom', 43, 'tom2', 45],
  [43, 'Tom 3', 'tom', 44, 'tom3', 43],
  [41, 'Tom 4', 'tom', 45, 'tom4', 41],
  [38, 'Snare', 'snare', 50, 'snare', 38],
  [40, 'Snare rim', 'snare', 51, 'snareRim', 40],
  [37, 'Cross-stick', 'snare', 52, 'xstick', 37],
  [36, 'Kick', 'kick', 60, 'kick', 36],
  [35, 'Kick 2', 'kick', 61, 'kick', 35],
  [39, 'Hand clap', 'perc', 70, 'clap', 39],
  [58, 'Vibraslap', 'perc', 99, null, 58],
];

// General MIDI percussion. These lanes appear when they have hits, so hits can
// be moved onto them, and a percussion kit plays them.
const PERCUSSION_ENTRIES = [
  [54, 'Tambourine', 'perc', 71, 'tamb', 54],
  [56, 'Cowbell', 'perc', 72, 'cowbell', 56],
  [60, 'Bongo high', 'perc', 73, null, 60],
  [61, 'Bongo low', 'perc', 74, null, 61],
  [62, 'Conga high muted', 'perc', 75, null, 62],
  [63, 'Conga high open', 'perc', 76, null, 63],
  [64, 'Conga low', 'perc', 77, null, 64],
  [65, 'Timbale high', 'perc', 78, null, 65],
  [66, 'Timbale low', 'perc', 79, null, 66],
  [67, 'Agogô high', 'perc', 80, null, 67],
  [68, 'Agogô low', 'perc', 81, null, 68],
  [69, 'Cabasa', 'perc', 82, null, 69],
  [70, 'Maracas', 'perc', 83, null, 70],
  [71, 'Whistle short', 'perc', 84, null, 71],
  [72, 'Whistle long', 'perc', 85, null, 72],
  [73, 'Guiro short', 'perc', 86, null, 73],
  [74, 'Guiro long', 'perc', 87, null, 74],
  [75, 'Claves', 'perc', 88, null, 75],
  [76, 'Wood block high', 'perc', 89, null, 76],
  [77, 'Wood block low', 'perc', 90, null, 77],
  [78, 'Cuíca muted', 'perc', 91, null, 78],
  [79, 'Cuíca open', 'perc', 92, null, 79],
  [80, 'Triangle muted', 'perc', 93, null, 80],
  [81, 'Triangle open', 'perc', 94, null, 81],
  [82, 'Shaker', 'perc', 95, null, 82],
  [83, 'Jingle bell', 'perc', 96, null, 83],
  [84, 'Bell tree', 'perc', 97, null, 84],
  [85, 'Castanets', 'perc', 98, null, 85],
  [86, 'Surdo muted', 'perc', 100, null, 86],
  [87, 'Surdo open', 'perc', 101, null, 87],
];

// Roland V-Drums (TD-07, TD-17, TD-27 and similar) default note map.
const ROLAND_ENTRIES = [
  [49, 'Crash 1', 'cym', 10, 'crash1', 49],
  [55, 'Crash 1 edge', 'cym', 11, 'crash1', 49],
  [57, 'Crash 2', 'cym', 12, 'crash2', 57],
  [52, 'Crash 2 edge', 'cym', 13, 'crash2', 57],
  [51, 'Ride', 'ride', 20, 'ride', 51],
  [59, 'Ride edge', 'ride', 21, 'rideEdge', 51],
  [53, 'Ride bell', 'ride', 22, 'bell', 53],
  [46, 'Hi-hat open', 'hat', 30, 'hhOpen', 46],
  [26, 'Hi-hat open edge', 'hat', 31, 'hhOpen', 46],
  [42, 'Hi-hat closed', 'hat', 32, 'hhClosed', 42],
  [22, 'Hi-hat closed edge', 'hat', 33, 'hhClosed', 42],
  [44, 'Hi-hat pedal', 'hat', 34, 'hhPedal', 44],
  [48, 'Tom 1', 'tom', 40, 'tom1', 48],
  [50, 'Tom 1 rim', 'tom', 41, 'tom1Rim', 48],
  [45, 'Tom 2', 'tom', 42, 'tom2', 45],
  [47, 'Tom 2 rim', 'tom', 43, 'tom2Rim', 45],
  [43, 'Tom 3', 'tom', 44, 'tom3', 43],
  [58, 'Tom 3 rim', 'tom', 45, 'tom3Rim', 43],
  [41, 'Tom 4', 'tom', 46, 'tom4', 41],
  [39, 'Tom 4 rim', 'tom', 47, 'tom4', 41],
  [38, 'Snare', 'snare', 50, 'snare', 38],
  [40, 'Snare rim', 'snare', 51, 'snareRim', 40],
  [37, 'Cross-stick', 'snare', 52, 'xstick', 37],
  [36, 'Kick', 'kick', 60, 'kick', 36],
];

function build(entries) {
  const byNote = new Map();
  for (const [note, label, family, order, voice, gm] of entries) {
    if (byNote.has(note)) continue;
    byNote.set(note, { note, label, family, order, voice, gm, color: FAMILIES[family].color });
  }
  return byNote;
}

export const MAPS = {
  gm: {
    id: 'gm',
    name: 'Standard (General MIDI)',
    hint: 'Alesis, Yamaha, Donner, Millenium and most other kits',
    notes: build([...GM_ENTRIES, ...PERCUSSION_ENTRIES]),
    core: [49, 51, 53, 46, 42, 44, 48, 45, 43, 38, 40, 37, 36],
  },
  roland: {
    id: 'roland',
    name: 'Roland V-Drums',
    hint: 'TD-07, TD-17, TD-27 and other Roland modules',
    // Roland uses 39 and 58 for tom rims, so those percussion notes are left out.
    notes: build([...ROLAND_ENTRIES, ...PERCUSSION_ENTRIES]),
    core: [49, 57, 51, 53, 46, 42, 44, 48, 45, 43, 38, 40, 37, 36],
  },
};

// Lanes that are drum-kit pieces (not hand percussion).
export function isKitLane(mapId, note) {
  return laneInfo(mapId, note).family !== 'perc';
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function noteName(n) {
  return `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
}

export function getMap(mapId) {
  return MAPS[mapId] || MAPS.gm;
}

export function laneInfo(mapId, note) {
  const map = getMap(mapId);
  const hit = map.notes.get(note);
  if (hit) return hit;
  return {
    note,
    label: `Note ${note}`,
    family: 'perc',
    order: 100 + note / 1000,
    voice: null,
    gm: note,
    color: FAMILIES.perc.color,
  };
}

export function allLaneNotes(mapId) {
  return [...getMap(mapId).notes.keys()];
}

export function sortLanes(mapId, notes) {
  return [...new Set(notes)].sort((a, b) => laneInfo(mapId, a).order - laneInfo(mapId, b).order);
}

// The note a plugin receives. "convert" sends General MIDI numbers, which is
// what most drum plugins expect out of the box.
export function outputNote(mapId, note, convert) {
  if (!convert) return note;
  return laneInfo(mapId, note).gm ?? note;
}

export function familyColor(mapId, note) {
  return laneInfo(mapId, note).color;
}
