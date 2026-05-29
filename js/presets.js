/**
 * presets.js — Genre preset definitions
 * Contains pattern data, BPM, swing, and note sequences
 * for Techno, Tech House, Acid, Minimal, Deep House, Breaks, Industrial
 */

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

/**
 * Convert MIDI note number to name string (e.g. 60 → "C4")
 */
function midiToName(n) {
  const octave = Math.floor(n / 12) - 1;
  return NOTE_NAMES[n % 12] + octave;
}

/**
 * Convert note name to MIDI number (e.g. "C4" → 60)
 */
function nameToMidi(name) {
  const match = name.match(/^([A-Ga-g]#?)(-?\d+)$/);
  if (!match) return 60;
  const noteIdx = NOTE_NAMES.indexOf(match[1].toUpperCase());
  const octave = parseInt(match[2], 10);
  return (octave + 1) * 12 + noteIdx;
}

// ─── Helper: build empty track ─────────────────────────────────
function emptyTrack(name, midiChannel = 1) {
  return {
    name,
    midiChannel,
    muted: false,
    soloed: false,
    volume: 100,
    steps: Array.from({ length: 16 }, () => ({
      active: false,
      note: 60,
      velocity: 100,
      gate: 0.5,
      probability: 100,
    })),
  };
}

// ─── Helper: set specific steps active with note/velocity ──────
function setSteps(track, stepDefs) {
  stepDefs.forEach(([idx, note, vel = 100, gate = 0.5, prob = 100]) => {
    if (idx < track.steps.length) {
      track.steps[idx].active = true;
      track.steps[idx].note = typeof note === 'string' ? nameToMidi(note) : note;
      track.steps[idx].velocity = vel;
      track.steps[idx].gate = gate;
      track.steps[idx].probability = prob;
    }
  });
  return track;
}

// ═══════════════════════════════════════════════════════════════
// PRESETS
// ═══════════════════════════════════════════════════════════════

const PRESETS = {

  // ─── TECHNO ───────────────────────────────────────────────────
  techno: {
    id: 'techno',
    name: 'Techno',
    icon: '⚡',
    bpm: 135,
    swing: 0,
    color: '#00d4ff',
    colorRgb: '0,212,255',
    description: '4/4 kick, offset hats, driving bass (Phrygian)',
    tracks: [
      // Track 1: Kick — every quarter note
      setSteps(emptyTrack('Kick', 10), [
        [0,'C1',120,0.25], [4,'C1',115,0.25], [8,'C1',118,0.25], [12,'C1',112,0.25],
      ]),
      // Track 2: Snare / Clap — beats 2 & 4
      setSteps(emptyTrack('Snare', 10), [
        [4,'D1',100,0.25], [12,'D1',95,0.25],
      ]),
      // Track 3: Hi-Hat closed — 8ths offset
      setSteps(emptyTrack('HH Closed', 10), [
        [0,'F#1',70,0.1], [2,'F#1',55,0.1], [4,'F#1',72,0.1], [6,'F#1',55,0.1],
        [8,'F#1',70,0.1], [10,'F#1',55,0.1], [12,'F#1',72,0.1], [14,'F#1',55,0.1],
      ]),
      // Track 4: Hi-Hat open — offbeats
      setSteps(emptyTrack('HH Open', 10), [
        [3,'A#1',80,0.5,75], [11,'A#1',75,0.5,75],
      ]),
      // Track 5: Bass — Phrygian D minor feel
      setSteps(emptyTrack('Bass', 1), [
        [0,'D2',110,0.5], [2,'D2',80,0.25], [4,'D2',105,0.5], [5,'E2',85,0.25,80],
        [6,'F2',95,0.5], [8,'D2',110,0.5], [10,'C2',90,0.25,75], [12,'D2',105,0.5],
        [14,'A1',80,0.25,70], [15,'D2',95,0.25],
      ]),
      // Track 6: Lead / Stab
      setSteps(emptyTrack('Lead', 2), [
        [0,'D4',90,0.75,80], [8,'A3',85,0.5,70], [10,'C4',80,0.25,65],
      ]),
      // Track 7: FX / Noise
      setSteps(emptyTrack('FX', 3), [
        [15,'G2',60,0.1,50],
      ]),
      // Track 8: Perc
      setSteps(emptyTrack('Perc', 10), [
        [1,'C#1',65,0.1,85], [5,'C#1',60,0.1,75], [9,'C#1',65,0.1,85], [13,'C#1',62,0.1,70],
      ]),
    ],
  },

  // ─── TECH HOUSE ───────────────────────────────────────────────
  techhouse: {
    id: 'techhouse',
    name: 'Tech House',
    icon: '🔥',
    bpm: 128,
    swing: 25,
    color: '#ff7a1a',
    colorRgb: '255,122,26',
    description: 'Groovy 16th bass, shuffled percussion, stabs',
    tracks: [
      // Kick — straight 4/4 with ghost
      setSteps(emptyTrack('Kick', 10), [
        [0,'C1',122,0.25], [4,'C1',118,0.25], [7,'C1',70,0.1,50], [8,'C1',120,0.25], [12,'C1',115,0.25],
      ]),
      // Snare — 2 & 4
      setSteps(emptyTrack('Snare', 10), [
        [4,'D1',110,0.5], [12,'D1',105,0.5],
      ]),
      // Hi-hat — 16th groove
      setSteps(emptyTrack('HH Groove', 10), [
        [0,'F#1',80,0.1],[1,'F#1',60,0.1],[2,'F#1',75,0.1],[3,'F#1',55,0.1],
        [4,'F#1',80,0.1],[5,'F#1',60,0.1],[6,'F#1',75,0.1],[7,'F#1',55,0.1],
        [8,'F#1',80,0.1],[9,'F#1',60,0.1],[10,'F#1',75,0.1],[11,'F#1',55,0.1],
        [12,'F#1',80,0.1],[13,'F#1',60,0.1],[14,'F#1',75,0.1],[15,'F#1',55,0.1],
      ]),
      // Bass — funky 16th
      setSteps(emptyTrack('Bass', 1), [
        [0,'G2',110,0.5],[2,'G2',90,0.25],[3,'A2',80,0.25,80],[4,'G2',105,0.5],
        [6,'F2',85,0.25],[8,'G2',110,0.5],[9,'E2',75,0.25,70],[10,'G2',95,0.5],
        [12,'G2',108,0.5],[14,'A2',80,0.25,85],[15,'G2',90,0.25],
      ]),
      // Chord Stab
      setSteps(emptyTrack('Chord Stab', 2), [
        [2,'G3',80,0.25,75],[6,'G3',75,0.25,75],[10,'F3',78,0.25,70],[14,'G3',82,0.25,75],
      ]),
      // Lead synth riff
      setSteps(emptyTrack('Lead', 3), [
        [0,'G4',90,0.5],[4,'A4',85,0.25,80],[8,'G4',88,0.5],[12,'F4',82,0.5,85],
      ]),
      // Perc 1
      setSteps(emptyTrack('Perc 1', 10), [
        [2,'C#1',70,0.1],[6,'C#1',65,0.1,80],[10,'C#1',72,0.1],[14,'C#1',68,0.1,80],
      ]),
      // Perc 2
      setSteps(emptyTrack('Perc 2', 10), [
        [1,'D#1',55,0.1,70],[5,'D#1',50,0.1,70],[9,'D#1',55,0.1,70],[13,'D#1',52,0.1,70],
      ]),
    ],
  },

  // ─── ACID ─────────────────────────────────────────────────────
  acid: {
    id: 'acid',
    name: 'Acid',
    icon: '🧪',
    bpm: 138,
    swing: 10,
    color: '#00ff88',
    colorRgb: '0,255,136',
    description: 'TB-303 style bass, heavy gate variation, accent',
    tracks: [
      setSteps(emptyTrack('Kick', 10), [
        [0,'C1',122,0.25],[4,'C1',118,0.25],[8,'C1',120,0.25],[12,'C1',115,0.25],
      ]),
      setSteps(emptyTrack('Snare', 10), [
        [4,'D1',100,0.25],[12,'D1',95,0.25],
      ]),
      setSteps(emptyTrack('HH', 10), [
        [0,'F#1',70,0.1],[2,'F#1',50,0.1],[4,'F#1',70,0.1],[6,'F#1',50,0.1],
        [8,'F#1',70,0.1],[10,'F#1',50,0.1],[12,'F#1',70,0.1],[14,'F#1',50,0.1],
      ]),
      // Acid Bass (TB-303 style) — rapid 16ths with gates & accents
      setSteps(emptyTrack('Acid Bass', 1), [
        [0,'A2',120,0.5],[1,'A2',70,0.1],[2,'C3',115,0.75],[3,'A2',110,0.25,80],
        [4,'G2',120,0.5],[5,'A2',80,0.1,75],[6,'E2',115,0.5],[7,'G2',90,0.25],
        [8,'A2',120,0.5],[9,'D3',100,0.25,80],[10,'A2',118,0.5],[11,'G2',85,0.1,70],
        [12,'E2',120,0.75],[13,'A2',115,0.25],[14,'C3',120,0.5],[15,'A2',125,0.25],
      ]),
      setSteps(emptyTrack('Acid Lead', 2), [
        [0,'A4',100,0.5,80],[4,'E4',95,0.75,75],[8,'A4',98,0.5,80],[12,'G4',90,0.5,70],
      ]),
      emptyTrack('FX', 3),
      emptyTrack('Pad', 4),
      setSteps(emptyTrack('Perc', 10), [
        [3,'C#1',65,0.1,80],[7,'C#1',60,0.1,75],[11,'C#1',65,0.1,80],[15,'C#1',62,0.1,70],
      ]),
    ],
  },

  // ─── MINIMAL TECHNO ───────────────────────────────────────────
  minimal: {
    id: 'minimal',
    name: 'Minimal',
    icon: '⬜',
    bpm: 130,
    swing: 5,
    color: '#c084fc',
    colorRgb: '192,132,252',
    description: 'Sparse, evolving, hypnotic',
    tracks: [
      setSteps(emptyTrack('Kick', 10), [
        [0,'C1',118,0.25],[4,'C1',115,0.25],[8,'C1',116,0.25],[12,'C1',112,0.25],
      ]),
      setSteps(emptyTrack('Clap', 10), [
        [4,'D1',85,0.25,90],[12,'D1',80,0.25,90],
      ]),
      setSteps(emptyTrack('HH', 10), [
        [0,'F#1',55,0.1],[4,'F#1',55,0.1],[8,'F#1',55,0.1],[12,'F#1',55,0.1],
      ]),
      setSteps(emptyTrack('Sub Bass', 1), [
        [0,'C2',110,0.75],[8,'C2',105,0.75],[12,'G1',90,0.5,80],
      ]),
      setSteps(emptyTrack('Texture', 2), [
        [0,'E3',60,1.0,70],[8,'D3',55,1.0,65],
      ]),
      emptyTrack('Chord', 3),
      setSteps(emptyTrack('Ping', 4), [
        [3,'G5',45,0.1,60],[11,'A5',42,0.1,55],
      ]),
      emptyTrack('Perc', 10),
    ],
  },

  // ─── DEEP HOUSE ───────────────────────────────────────────────
  deephouse: {
    id: 'deephouse',
    name: 'Deep House',
    icon: '🌊',
    bpm: 122,
    swing: 35,
    color: '#ffaa00',
    colorRgb: '255,170,0',
    description: 'Walking bass, soulful chords, laid-back groove',
    tracks: [
      setSteps(emptyTrack('Kick', 10), [
        [0,'C1',118,0.25],[4,'C1',112,0.25],[7,'C1',65,0.1,50],[8,'C1',115,0.25],[12,'C1',110,0.25],
      ]),
      setSteps(emptyTrack('Snare', 10), [
        [4,'D1',90,0.5],[12,'D1',88,0.5],
      ]),
      setSteps(emptyTrack('HH 16ths', 10), [
        [0,'F#1',75,0.1],[1,'F#1',55,0.1],[2,'F#1',70,0.1],[3,'F#1',50,0.1],
        [4,'F#1',75,0.1],[5,'F#1',55,0.1],[6,'F#1',70,0.1],[7,'F#1',50,0.1],
        [8,'F#1',75,0.1],[9,'F#1',55,0.1],[10,'F#1',70,0.1],[11,'F#1',50,0.1],
        [12,'F#1',75,0.1],[13,'F#1',55,0.1],[14,'F#1',70,0.1],[15,'F#1',50,0.1],
      ]),
      // Walking bass
      setSteps(emptyTrack('Bass', 1), [
        [0,'G2',100,0.75],[2,'A2',85,0.5],[4,'B2',90,0.5],[5,'C3',80,0.25],[6,'D3',88,0.5],
        [8,'G2',100,0.75],[10,'F2',82,0.5],[12,'E2',88,0.5],[14,'D2',75,0.5],
      ]),
      // Chord pads
      setSteps(emptyTrack('Chords', 2), [
        [0,'G3',75,1.0],[4,'C4',70,1.0],[8,'G3',75,1.0],[12,'F3',70,1.0],
      ]),
      setSteps(emptyTrack('Rhodes', 3), [
        [2,'B3',65,0.5,80],[6,'D4',60,0.5,75],[10,'C4',65,0.5,80],[14,'A3',60,0.5,75],
      ]),
      emptyTrack('FX', 4),
      setSteps(emptyTrack('Perc', 10), [
        [2,'C#1',55,0.1,85],[6,'C#1',50,0.1,80],[10,'C#1',55,0.1,85],[14,'C#1',52,0.1,80],
      ]),
    ],
  },

  // ─── BREAKS ───────────────────────────────────────────────────
  breaks: {
    id: 'breaks',
    name: 'Breaks',
    icon: '💥',
    bpm: 150,
    swing: 15,
    color: '#ff6eb4',
    colorRgb: '255,110,180',
    description: 'Syncopated breakbeat, high energy',
    tracks: [
      setSteps(emptyTrack('Kick', 10), [
        [0,'C1',120,0.25],[3,'C1',90,0.1,80],[4,'C1',75,0.1,70],[6,'C1',115,0.25],
        [8,'C1',118,0.25],[10,'C1',80,0.1,75],[12,'C1',100,0.25],[14,'C1',70,0.1,70],
      ]),
      setSteps(emptyTrack('Snare', 10), [
        [4,'D1',110,0.25],[7,'D1',85,0.1,80],[12,'D1',115,0.25],[14,'D1',75,0.1,75],
      ]),
      setSteps(emptyTrack('HH', 10), [
        [0,'F#1',80,0.1],[1,'F#1',55,0.1],[2,'F#1',75,0.1],[3,'F#1',60,0.1],
        [4,'F#1',80,0.1],[5,'F#1',55,0.1],[6,'F#1',75,0.1],[7,'F#1',65,0.1],
        [8,'F#1',80,0.1],[9,'F#1',55,0.1],[10,'F#1',75,0.1],[11,'F#1',60,0.1],
        [12,'F#1',80,0.1],[13,'F#1',55,0.1],[14,'F#1',75,0.1],[15,'F#1',65,0.1],
      ]),
      setSteps(emptyTrack('Bass', 1), [
        [0,'D2',110,0.5],[3,'E2',85,0.25,80],[5,'F2',90,0.25],[8,'D2',108,0.5],
        [10,'E2',80,0.25,75],[12,'D2',105,0.5],[14,'C2',85,0.25],
      ]),
      setSteps(emptyTrack('Lead', 2), [
        [0,'D4',90,0.5],[4,'F4',85,0.25,80],[6,'E4',80,0.25],[8,'D4',88,0.5],
        [12,'A3',82,0.5],[14,'B3',78,0.25,80],
      ]),
      emptyTrack('Synth', 3),
      setSteps(emptyTrack('Perc 1', 10), [
        [2,'C#1',70,0.1],[5,'C#1',65,0.1,80],[9,'C#1',70,0.1],[13,'C#1',65,0.1,80],
      ]),
      setSteps(emptyTrack('Perc 2', 10), [
        [1,'D#1',50,0.1,75],[7,'D#1',55,0.1,80],[11,'D#1',50,0.1,75],[15,'D#1',60,0.1,80],
      ]),
    ],
  },

  // ─── INDUSTRIAL ───────────────────────────────────────────────
  industrial: {
    id: 'industrial',
    name: 'Industrial',
    icon: '🏭',
    bpm: 140,
    swing: 0,
    color: '#7df3e1',
    colorRgb: '125,243,225',
    description: 'Heavy kicks, metallic percussion, dark atmosphere',
    tracks: [
      // Double-kick pattern
      setSteps(emptyTrack('Kick', 10), [
        [0,'C1',127,0.25],[1,'C1',80,0.1,60],[4,'C1',125,0.25],[5,'C1',75,0.1,50],
        [8,'C1',127,0.25],[9,'C1',82,0.1,65],[12,'C1',125,0.25],[13,'C1',78,0.1,55],
      ]),
      setSteps(emptyTrack('Snare', 10), [
        [4,'D1',115,0.5],[8,'D1',110,0.25,85],[12,'D1',118,0.5],
      ]),
      setSteps(emptyTrack('Metal HH', 10), [
        [0,'F#1',90,0.1],[2,'F#1',70,0.1],[4,'F#1',90,0.1],[6,'F#1',70,0.1],
        [8,'F#1',90,0.1],[10,'F#1',70,0.1],[12,'F#1',90,0.1],[14,'F#1',70,0.1],
      ]),
      setSteps(emptyTrack('Bass', 1), [
        [0,'C2',120,0.5],[2,'C2',100,0.25],[4,'G1',115,0.5],[6,'C2',105,0.25],
        [8,'C2',120,0.5],[10,'A#1',100,0.25],[12,'G1',118,0.5],[14,'C2',110,0.25],
      ]),
      setSteps(emptyTrack('Dark Pad', 2), [
        [0,'C3',70,1.0],[8,'G2',65,1.0],
      ]),
      setSteps(emptyTrack('Noise Burst', 3), [
        [3,'D2',80,0.1,70],[7,'D2',75,0.1,65],[11,'D2',80,0.1,70],[15,'D2',85,0.1,75],
      ]),
      setSteps(emptyTrack('Clank', 10), [
        [0,'A#1',85,0.1],[4,'A#1',80,0.1],[8,'A#1',85,0.1],[12,'A#1',82,0.1],
      ]),
      setSteps(emptyTrack('Ride', 10), [
        [0,'D#1',60,0.25],[4,'D#1',58,0.25],[8,'D#1',62,0.25],[12,'D#1',58,0.25],
      ]),
    ],
  },
};

// Expose globally
window.PRESETS = PRESETS;
window.midiToName = midiToName;
window.nameToMidi = nameToMidi;
window.NOTE_NAMES = NOTE_NAMES;
