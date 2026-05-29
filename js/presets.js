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
    description: 'Heavy driving bd, dark industrial percussions, minor stabs',
    instruments: ['bd', 'sn', 'hh', 'hh', 'bass', 'arpy', 'casio', 'industrial'],
    tracks: [
      // Track 1: Kick — straight 4/4
      setSteps(emptyTrack('Kick', 10), [
        [0,'C2',120,0.25], [4,'C2',115,0.25], [8,'C2',118,0.25], [12,'C2',112,0.25],
      ]),
      // Track 2: Snare — beats 2 & 4
      setSteps(emptyTrack('Snare', 10), [
        [4,'D2',100,0.25], [12,'D2',95,0.25],
      ]),
      // Track 3: Hi-Hat closed — driving eighth notes
      setSteps(emptyTrack('HH Closed', 10), [
        [0,'F#2',70,0.1], [2,'F#2',55,0.1], [4,'F#2',72,0.1], [6,'F#2',55,0.1],
        [8,'F#2',70,0.1], [10,'F#2',55,0.1], [12,'F#2',72,0.1], [14,'F#2',55,0.1],
      ]),
      // Track 4: Hi-Hat open — offbeats
      setSteps(emptyTrack('HH Open', 10), [
        [2,'A#2',85,0.35,100], [6,'A#2',80,0.35,100], [10,'A#2',85,0.35,100], [14,'A#2',80,0.35,100],
      ]),
      // Track 5: Bass — Phrygian D minor feel
      setSteps(emptyTrack('Bass', 1), [
        [0,'D2',110,0.5], [2,'D2',80,0.25], [4,'D2',105,0.5], [5,'E2',85,0.25,80],
        [6,'F2',95,0.5], [8,'D2',110,0.5], [10,'C2',90,0.25,75], [12,'D2',105,0.5],
        [14,'A1',80,0.25,70], [15,'D2',95,0.25],
      ]),
      // Track 6: Lead Stab
      setSteps(emptyTrack('Lead', 2), [
        [2,'D3',90,0.5,85], [6,'A3',85,0.5,75], [10,'C4',80,0.25,85], [14,'F3',85,0.3,80]
      ]),
      // Track 7: Pad / Chord
      setSteps(emptyTrack('Pad', 3), [
        [0,'D3',65,0.9,100], [8,'A2',60,0.9,100],
      ]),
      // Track 8: Metallic Percussion
      setSteps(emptyTrack('Perc', 10), [
        [1,'C2',65,0.1,85], [5,'C#2',60,0.1,75], [9,'D2',65,0.1,85], [13,'D#2',62,0.1,70],
      ]),
    ],
  },

  // ─── TECH HOUSE ───────────────────────────────────────────────
  techhouse: {
    id: 'techhouse',
    name: 'Tech House',
    icon: '🔥',
    bpm: 126,
    swing: 25,
    color: '#ff7a1a',
    colorRgb: '255,122,26',
    description: 'Groovy walking bass, offbeat hand claps, shuffled hats',
    instruments: ['808bd', 'cp', 'hh', 'hh', 'bass3', 'arpy', 'casio', 'clak'],
    tracks: [
      // 808 Kick
      setSteps(emptyTrack('Kick', 10), [
        [0,'C2',120,0.25], [4,'C2',118,0.25], [8,'C2',120,0.25], [12,'C2',115,0.25], [14,'C2',70,0.1,40],
      ]),
      // Snare / Clap
      setSteps(emptyTrack('Clap', 10), [
        [4,'D#2',110,0.35], [12,'D#2',105,0.35],
      ]),
      // Hi-hat closed shuffled
      setSteps(emptyTrack('HH Closed', 10), [
        [0,'F#2',75,0.1], [1,'F#2',55,0.05,80], [2,'F#2',70,0.1], [3,'F#2',50,0.05,80],
        [4,'F#2',75,0.1], [5,'F#2',55,0.05,80], [6,'F#2',70,0.1], [7,'F#2',50,0.05,80],
        [8,'F#2',75,0.1], [9,'F#2',55,0.05,80], [10,'F#2',70,0.1], [11,'F#2',50,0.05,80],
        [12,'F#2',75,0.1], [13,'F#2',55,0.05,80], [14,'F#2',70,0.1], [15,'F#2',50,0.05,80],
      ]),
      // Hi-hat open
      setSteps(emptyTrack('HH Open', 10), [
        [2,'A#2',80,0.5,100], [6,'A#2',75,0.5,100], [10,'A#2',80,0.5,100], [14,'A#2',78,0.5,100],
      ]),
      // Walking Bass
      setSteps(emptyTrack('Walking Bass', 1), [
        [2,'G2',100,0.35], [3,'G2',80,0.15], [6,'F2',90,0.35], [7,'F#2',80,0.15],
        [10,'G2',105,0.35], [11,'Bb2',85,0.25], [14,'D2',90,0.35], [15,'F2',80,0.15],
      ]),
      // Synth Hook
      setSteps(emptyTrack('Synth Hook', 2), [
        [2,'G3',85,0.25,90], [6,'Bb3',80,0.25,80], [10,'D4',85,0.25,90], [14,'C4',75,0.25,80],
      ]),
      // Chord Pad
      setSteps(emptyTrack('Chord Pad', 3), [
        [0,'G3',65,0.8,100], [8,'F3',60,0.8,100],
      ]),
      // Wood Clak
      setSteps(emptyTrack('Wood Clak', 10), [
        [3,'C2',60,0.1,70], [7,'C#2',55,0.1,70], [11,'C2',60,0.1,70], [15,'C#2',55,0.1,70],
      ]),
    ],
  },

  // ─── ACID ─────────────────────────────────────────────────────
  acid: {
    id: 'acid',
    name: 'Acid',
    icon: '🧪',
    bpm: 138,
    swing: 5,
    color: '#00ff88',
    colorRgb: '0,255,136',
    description: 'TB-303 rapid 16th bassline, classic kicks, chiptune lead',
    instruments: ['bd', 'sn', 'hh', 'hh', 'bass1', 'sid', 'arpy', 'industrial'],
    tracks: [
      setSteps(emptyTrack('Kick', 10), [
        [0,'C2',122,0.25], [4,'C2',118,0.25], [8,'C2',120,0.25], [12,'C2',115,0.25],
      ]),
      setSteps(emptyTrack('Snare', 10), [
        [4,'D2',100,0.25], [12,'D2',95,0.25],
      ]),
      setSteps(emptyTrack('HH Closed', 10), [
        [0,'F#2',70,0.1], [2,'F#2',50,0.1], [4,'F#2',70,0.1], [6,'F#2',50,0.1],
        [8,'F#2',70,0.1], [10,'F#2',50,0.1], [12,'F#2',70,0.1], [14,'F#2',50,0.1],
      ]),
      setSteps(emptyTrack('HH Open', 10), [
        [2,'A#2',80,0.3,100], [6,'A#2',75,0.3,100], [10,'A#2',80,0.3,100], [14,'A#2',75,0.3,100],
      ]),
      // TB-303 Acid Bassline
      setSteps(emptyTrack('Acid Bass', 1), [
        [0,'A2',120,0.5], [1,'A2',70,0.1], [2,'C3',115,0.75], [3,'A2',110,0.25,90],
        [4,'G2',120,0.5], [5,'A2',80,0.1,75], [6,'E2',115,0.5], [7,'G2',90,0.25],
        [8,'A2',120,0.5], [9,'D3',100,0.25,90], [10,'A2',118,0.5], [11,'G2',85,0.1,70],
        [12,'E2',120,0.75], [13,'A2',115,0.25], [14,'C3',120,0.5], [15,'A2',125,0.25],
      ]),
      // Retro Chiptune Lead
      setSteps(emptyTrack('Acid Lead', 2), [
        [0,'A3',100,0.5,80], [4,'E3',95,0.75,75], [8,'A3',98,0.5,80], [12,'G3',90,0.5,70],
      ]),
      emptyTrack('Chord', 3),
      setSteps(emptyTrack('FX Noise', 10), [
        [3,'C2',65,0.1,80], [11,'D2',65,0.1,80],
      ]),
    ],
  },

  // ─── MINIMAL ──────────────────────────────────────────────────
  minimal: {
    id: 'minimal',
    name: 'Minimal',
    icon: '⬜',
    bpm: 128,
    swing: 10,
    color: '#c084fc',
    colorRgb: '192,132,252',
    description: 'Sparse hypnotic kicks, rimshots, bubbling textures, low sub',
    instruments: ['bd', 'clak', 'hh', 'hh', 'bass0', 'arpy', 'casio', 'bubble'],
    tracks: [
      setSteps(emptyTrack('Kick', 10), [
        [0,'C2',118,0.25], [4,'C2',115,0.25], [8,'C2',116,0.25], [12,'C2',112,0.25],
      ]),
      setSteps(emptyTrack('Rimshot', 10), [
        [4,'C2',85,0.1,100], [12,'C2',80,0.1,100],
      ]),
      setSteps(emptyTrack('HH Closed', 10), [
        [0,'F#2',55,0.1], [4,'F#2',55,0.1], [8,'F#2',55,0.1], [12,'F#2',55,0.1],
      ]),
      setSteps(emptyTrack('HH Open', 10), [
        [2,'A#2',70,0.3,80], [10,'A#2',70,0.3,80],
      ]),
      // Low Sub Bass
      setSteps(emptyTrack('Sub Bass', 1), [
        [0,'C2',110,0.75], [8,'C2',105,0.75], [12,'G1',90,0.5,80],
      ]),
      // Minimal Lead
      setSteps(emptyTrack('Minimal Lead', 2), [
        [3,'G3',45,0.1,65], [11,'A3',42,0.1,65],
      ]),
      setSteps(emptyTrack('Chord Pad', 3), [
        [0,'E3',60,0.95,70], [8,'D3',55,0.95,65],
      ]),
      // Sparse Bubbles
      setSteps(emptyTrack('Bubbles', 10), [
        [5,'C2',50,0.2,70], [13,'D2',50,0.2,70],
      ]),
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
    description: 'Soulful walking bassline, claps, warm electric piano chords',
    instruments: ['808bd', 'cp', 'hh', 'hh', 'bass3', 'casio', 'casio', 'bubble'],
    tracks: [
      setSteps(emptyTrack('Kick', 10), [
        [0,'C2',118,0.25], [4,'C2',112,0.25], [8,'C2',115,0.25], [12,'C2',110,0.25],
      ]),
      setSteps(emptyTrack('Clap', 10), [
        [4,'D#2',90,0.5], [12,'D#2',88,0.5],
      ]),
      setSteps(emptyTrack('HH Closed', 10), [
        [0,'F#2',75,0.1], [1,'F#2',55,0.05], [2,'F#2',70,0.1], [3,'F#2',50,0.05],
        [4,'F#2',75,0.1], [5,'F#2',55,0.05], [6,'F#2',70,0.1], [7,'F#2',50,0.05],
        [8,'F#2',75,0.1], [9,'F#2',55,0.05], [10,'F#2',70,0.1], [11,'F#2',50,0.05],
        [12,'F#2',75,0.1], [13,'F#2',55,0.05], [14,'F#2',70,0.1], [15,'F#2',50,0.05],
      ]),
      setSteps(emptyTrack('HH Open', 10), [
        [2,'A#2',80,0.5,95], [6,'A#2',75,0.5,90], [10,'A#2',80,0.5,95], [14,'A#2',78,0.5,90],
      ]),
      // Soulful walking bass
      setSteps(emptyTrack('Soulful Bass', 1), [
        [0,'G2',100,0.75], [2,'A2',85,0.5], [4,'B2',90,0.5], [5,'C3',80,0.25], [6,'D3',88,0.5],
        [8,'G2',100,0.75], [10,'F2',82,0.5], [12,'E2',88,0.5], [14,'D2',75,0.5],
      ]),
      // E-Piano Chords (Rhodes)
      setSteps(emptyTrack('E-Piano', 2), [
        [2,'B3',65,0.5,80], [6,'D4',60,0.5,75], [10,'C4',65,0.5,80], [14,'A3',60,0.5,75],
      ]),
      // Pad chords
      setSteps(emptyTrack('Chord Pad', 3), [
        [0,'G3',75,1.0], [4,'C4',70,1.0], [8,'G3',75,1.0], [12,'F3',70,1.0],
      ]),
      // Organic Percussion
      setSteps(emptyTrack('Bubbles', 10), [
        [2,'C2',55,0.1,85], [6,'C#2',50,0.1,80], [10,'C2',55,0.1,85], [14,'C#2',52,0.1,80],
      ]),
    ],
  },

  // ─── DRUM & BASS ──────────────────────────────────────────────
  breaks: {
    id: 'breaks',
    name: 'Drum & Bass',
    icon: '💥',
    bpm: 172,
    swing: 5,
    color: '#ff6eb4',
    colorRgb: '255,110,180',
    description: 'Sliced legendary Amen Break, deep rolling sub bass, liquid chord pads',
    instruments: ['amencutup', 'sn', 'hh', 'hh', 'bass0', 'sid', 'arpy', 'kurt'],
    tracks: [
      // Sliced Amen Break!
      setSteps(emptyTrack('Amen Slices', 10), [
        [0,'C2',110,0.5],   // Kick
        [1,'F#2',70,0.25],  // Hat
        [2,'F#2',75,0.25],  // Hat
        [3,'E2',85,0.25],   // Ghost Snare
        [4,'D2',115,0.5],   // Snare
        [5,'F#2',70,0.25],  // Hat
        [6,'F#2',75,0.25],  // Hat
        [7,'C2',90,0.25],   // Ghost Kick
        [8,'C2',110,0.5],   // Kick
        [9,'F#2',70,0.25],  // Hat
        [10,'C2',105,0.5],  // Double Kick
        [11,'F#2',75,0.25], // Hat
        [12,'D2',118,0.5],  // Snare
        [13,'F#2',70,0.25], // Hat
        [14,'E2',85,0.25],  // Ghost Snare
        [15,'F#2',75,0.25]  // Hat
      ]),
      // Snare Layer for extra punch
      setSteps(emptyTrack('Snare Layer', 10), [
        [4,'D2',100,0.25], [12,'D2',100,0.25],
      ]),
      // Sizzling hihats
      setSteps(emptyTrack('HH Closed', 10), [
        [0,'F#2',70,0.1], [2,'F#2',70,0.1], [4,'F#2',70,0.1], [6,'F#2',70,0.1],
        [8,'F#2',70,0.1], [10,'F#2',70,0.1], [12,'F#2',70,0.1], [14,'F#2',70,0.1],
      ]),
      // Open Hat / Ride
      setSteps(emptyTrack('Ride Cymbal', 10), [
        [0,'A#2',60,0.2], [4,'A#2',60,0.2], [8,'A#2',60,0.2], [12,'A#2',60,0.2],
      ]),
      // Deep Sub Bass
      setSteps(emptyTrack('Deep Sub', 1), [
        [0,'D2',110,0.5], [3,'E2',85,0.25,80], [5,'F2',90,0.25], [8,'D2',108,0.5],
        [10,'E2',80,0.25,75], [12,'D2',105,0.5], [14,'C2',85,0.25],
      ]),
      // Chiptune Lead
      setSteps(emptyTrack('Lead Lead', 2), [
        [0,'D3',90,0.5], [4,'F3',85,0.25,80], [6,'E3',80,0.25], [8,'D3',88,0.5],
        [12,'A2',82,0.5], [14,'B2',78,0.25,80],
      ]),
      // Liquid Chord Pad
      setSteps(emptyTrack('Liquid Pad', 3), [
        [0,'D3',65,0.85], [8,'F3',60,0.85],
      ]),
      // Glitch FX
      setSteps(emptyTrack('Glitch FX', 10), [
        [2,'C2',70,0.1], [5,'C#2',65,0.1,80], [9,'C2',70,0.1], [13,'C#2',65,0.1,80],
      ]),
    ],
  },

  // ─── LO-FI HIP-HOP ────────────────────────────────────────────
  industrial: {
    id: 'industrial',
    name: 'Lo-Fi Hip-Hop',
    icon: '☕',
    bpm: 85,
    swing: 50,
    color: '#7df3e1',
    colorRgb: '125,243,225',
    description: 'Laid-back swinging beat, dusty clicks, jazzy chords, bird chirps ambiance',
    instruments: ['808bd', 'sn', 'hh', 'bottle', 'bass', 'casio', 'casio', 'birds'],
    tracks: [
      // Dusty Kick
      setSteps(emptyTrack('Dusty Kick', 10), [
        [0,'C2',110,0.25], [8,'C2',100,0.25], [11,'C2',85,0.1,70], [14,'C2',90,0.25,60],
      ]),
      // Crunchy Snare
      setSteps(emptyTrack('Crunch Snare', 10), [
        [4,'D2',105,0.25], [12,'D2',100,0.25],
      ]),
      // Swinging hihats
      setSteps(emptyTrack('Swing Hat', 10), [
        [0,'F#2',70,0.1], [1,'F#2',45,0.05,80], [2,'F#2',65,0.1], [3,'F#2',40,0.05,80],
        [4,'F#2',70,0.1], [5,'F#2',45,0.05,80], [6,'F#2',65,0.1], [7,'F#2',40,0.05,80],
        [8,'F#2',70,0.1], [9,'F#2',45,0.05,80], [10,'F#2',65,0.1], [11,'F#2',40,0.05,80],
        [12,'F#2',70,0.1], [13,'F#2',45,0.05,80], [14,'F#2',65,0.1], [15,'F#2',40,0.05,80],
      ]),
      // Foley dusty clicks
      setSteps(emptyTrack('Foley Clicks', 10), [
        [2,'C2',60,0.1,70], [6,'C#2',55,0.1,65], [10,'C2',60,0.1,70], [14,'D2',60,0.1,65],
      ]),
      // Jazz Bassline
      setSteps(emptyTrack('Jazz Bass', 1), [
        [0,'D2',95,0.6], [4,'G2',85,0.4], [8,'C2',90,0.6], [12,'A1',80,0.5],
      ]),
      // Electric Piano Lead (Jazzy)
      setSteps(emptyTrack('E-Piano', 2), [
        [2,'A3',80,0.3,90], [5,'C4',85,0.3,95], [10,'B3',80,0.3,90], [13,'G3',75,0.3,85],
      ]),
      // Rhodes Chord Pad
      setSteps(emptyTrack('Rhodes Pad', 3), [
        [0,'F3',60,0.9,100], [4,'B2',55,0.9,100], [8,'E3',60,0.9,100], [12,'A2',55,0.9,100],
      ]),
      // Birds chirping FX (Dusty background ambiance)
      setSteps(emptyTrack('Birds Ambient', 10), [
        [0,'C2',50,0.85,60], [8,'C#2',45,0.85,55],
      ]),
    ],
  },

  // ─── DAYDREAM AMBIENT ─────────────────────────────────────────
  daydream: {
    id: 'daydream',
    name: 'Daydream Ambient',
    icon: '🌌',
    bpm: 90,
    swing: 45,
    color: '#a78bfa',
    colorRgb: '167,139,250',
    description: 'Spacious nice yet complex ambient electronic soundscape',
    instruments: ['casio', 'bubble', 'hh', 'bottle', 'bass', 'arpy', 'casio', 'birds'],
    spatialFX: {
      reverbMix: 0.65,      // Lush 65% reverb mix!
      reverbDecay: 5.5,     // Enormous 5.5s tail!
      delayMix: 0.45,       // High 45% delay mix!
      delayTime: 0.36,      // 1/8 Dotted time
      delayFeedback: 0.72   // Long feedback echoes!
    },
    tracks: [
      // Track 1: Deep Evolving Chord Pad 1
      setSteps(emptyTrack('Rhodes Pad 1', 3), [
        [0,'C3',60,1.0,100], [8,'F3',55,1.0,100],
      ]),
      // Track 2: Micro Percussion / Bubbles
      setSteps(emptyTrack('Bubbles', 10), [
        [2,'C2',50,0.1,80], [6,'D2',45,0.1,80], [10,'C2',50,0.1,80], [14,'D2',45,0.1,80],
      ]),
      // Track 3: Dotted Delay Hats
      setSteps(emptyTrack('Delay Hats', 10), [
        [0,'F#2',60,0.05,90], [4,'F#2',55,0.05,90], [8,'F#2',60,0.05,90], [12,'F#2',55,0.05,90],
      ]),
      // Track 4: Foley organic clicks
      setSteps(emptyTrack('Foley bottle', 10), [
        [3,'C2',55,0.1,70], [11,'C#2',50,0.1,70],
      ]),
      // Track 5: Smooth Sine Sub Bass
      setSteps(emptyTrack('Jazz Bass', 1), [
        [0,'C2',90,0.85], [3,'G2',80,0.6], [8,'F2',85,0.85], [11,'C2',75,0.5],
      ]),
      // Track 6: Sparkling microtonal chime lead
      setSteps(emptyTrack('Chime Melody', 2), [
        [2,'G4',85,0.3,90], [5,'C5',90,0.3,95], [6,'D5',80,0.25,90], [10,'B4',85,0.3,90], [13,'G4',75,0.3,80]
      ]),
      // Track 7: Chord Pad 2
      setSteps(emptyTrack('Rhodes Pad 2', 3), [
        [4,'E3',65,1.0,100], [12,'A2',60,1.0,100],
      ]),
      // Track 8: Ambient birds background
      setSteps(emptyTrack('Birds Ambient', 10), [
        [0,'C2',45,0.95,70], [8,'D2',40,0.95,70],
      ]),
    ],
  },
};

// Expose globally
window.PRESETS = PRESETS;
window.midiToName = midiToName;
window.nameToMidi = nameToMidi;
window.NOTE_NAMES = NOTE_NAMES;
