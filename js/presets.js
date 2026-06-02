/**
 * presets.js — Genre preset definitions
 * Techno and Acid presets with authentic rhythm patterns,
 * correct musical scales, and per-step accent/slide flags.
 *
 * Techno: E Phrygian — dark, industrial, driving 4/4
 * Acid:   A minor   — squelchy 303 basslines with accent + slide
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

// ─── Helper: build empty track ──────────────────────────────────
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
      accent: false,
      slide: false,
    })),
  };
}

// ─── Helper: set specific steps active with note/velocity ───────
// stepDefs: [idx, note, vel=100, gate=0.5, prob=100, accent=false, slide=false]
function setSteps(track, stepDefs) {
  stepDefs.forEach(([idx, note, vel = 100, gate = 0.5, prob = 100, accent = false, slide = false]) => {
    if (idx < track.steps.length) {
      track.steps[idx].active    = true;
      track.steps[idx].note      = typeof note === 'string' ? nameToMidi(note) : note;
      track.steps[idx].velocity  = vel;
      track.steps[idx].gate      = gate;
      track.steps[idx].probability = prob;
      track.steps[idx].accent    = accent;
      track.steps[idx].slide     = slide;
    }
  });
  return track;
}

// ═══════════════════════════════════════════════════════════════
// PRESETS — Techno + Acid
// ═══════════════════════════════════════════════════════════════
//
// MIDI note reference (C4=60):
//   C2=36 D2=38 E2=40 F2=41 G2=43 A2=45 B2=47
//   C3=48 D3=50 E3=52 F3=53 G3=55 A3=57 B3=59
//   C4=60 D4=62 E4=64 F4=65 G4=67 A4=69 B4=71
//
// GM Drum map (ch 10):
//   36=Kick  38=Snare  39=Clap  42=HH Closed  46=HH Open
// ═══════════════════════════════════════════════════════════════

const PRESETS = {

  // ─── TECHNO ─────────────────────────────────────────────────
  // Scale: E Phrygian  (E F G A B C D)
  // Root MIDI: E2 = 40
  // Character: dark, industrial, hypnotic — avoid major intervals
  // BPM: 135 | Swing: 0
  techno: {
    id: 'techno',
    name: 'Techno',
    icon: '⚡',
    bpm: 135,
    swing: 0,
    color: '#00d4ff',
    colorRgb: '0,212,255',
    description: 'Dark industrial techno — E Phrygian bass, 4/4 kick, driving 8th hats',
    instruments: ['drum', 'drum', 'drum', 'drum', 'bass', 'lead', 'pad', 'drum'],
    spatialFX: {
      reverbMix: 0.18,
      reverbDecay: 2.2,
      delayMix: 0.12,
      delayTime: 0.36,
      delayFeedback: 0.35,
    },
    tracks: [

      // Track 1 — Kick: straight 4/4
      // [ x . . . | x . . . | x . . . | x . . . ]
      setSteps(emptyTrack('Kick', 10), [
        [0,  36, 122, 0.25],
        [4,  36, 118, 0.25],
        [8,  36, 120, 0.25],
        [12, 36, 115, 0.25],
      ]),

      // Track 2 — Snare: beats 2 & 4
      // [ . . . . | x . . . | . . . . | x . . . ]
      setSteps(emptyTrack('Snare', 10), [
        [4,  38, 105, 0.25],
        [12, 38, 100, 0.25],
      ]),

      // Track 3 — Clap: beats 2 & 4, ghost 16th at end
      // [ . . . . | x . . . | . . . . | x . . x ]
      setSteps(emptyTrack('Clap', 10), [
        [4,  39, 100, 0.2],
        [12, 39,  98, 0.2],
        [15, 39,  62, 0.1, 60],  // ghost — prob 60%
      ]),

      // Track 4 — Hi-Hat Closed: driving 8th notes, velocity groove
      // [ x . x . | x . x . | x . x . | x . x . ]
      setSteps(emptyTrack('HH Closed', 10), [
        [0,  42, 72, 0.08], [2,  42, 50, 0.08],
        [4,  42, 70, 0.08], [6,  42, 50, 0.08],
        [8,  42, 72, 0.08], [10, 42, 50, 0.08],
        [12, 42, 70, 0.08], [14, 42, 50, 0.08],
      ]),

      // Track 5 — Hi-Hat Open: bar-end breath
      // [ . . . . | . . . . | . . . . | . . x . ]
      setSteps(emptyTrack('HH Open', 10), [
        [14, 46, 80, 0.35],
      ]),

      // Track 6 — Bass: E Phrygian syncopated
      // [ x . . x | . . x . | . . x . | . . . . ]
      // Notes: E2(40) b2→F2(41) b3→G2(43) b7→D2(38) — no major intervals
      setSteps(emptyTrack('Bass', 1), [
        [0,  40, 112, 0.45],  // E2 — root
        [3,  38,  88, 0.30],  // D2 — b7 movement
        [6,  41, 100, 0.40],  // F2 — b2 tension (Phrygian hallmark)
        [10, 43,  90, 0.35],  // G2 — b3 resolve
      ]),

      // Track 7 — Lead: sparse Phrygian stabs
      // [ . . . . | . . . . | x . . . | . x . . ]
      setSteps(emptyTrack('Lead', 2), [
        [8,  52, 88, 0.40, 85],  // E3
        [13, 57, 80, 0.30, 80],  // A3
      ]),

      // Track 8 — Pad: long gate, E minor chord tones
      // [ x . . . | . . . . | x . . . | . . . . ]
      setSteps(emptyTrack('Pad', 3), [
        [0, 52, 65, 0.9],  // E3
        [8, 45, 60, 0.9],  // A2
      ]),

    ],
  },

  // ─── ACID ───────────────────────────────────────────────────
  // Scale: A minor  (A B C D E F G)
  // Root MIDI: A2 = 45
  // Character: squelchy TB-303, rapid 16ths, accent + slide hypnosis
  // BPM: 140 | Swing: 0
  acid: {
    id: 'acid',
    name: 'Acid',
    icon: '🧪',
    bpm: 140,
    swing: 0,
    color: '#00ff88',
    colorRgb: '0,255,136',
    description: 'Authentic acid — TB-303 basslines with accent & slide, 16th hats',
    instruments: ['drum', 'drum', 'drum', 'drum', 'acid', 'acid', 'lead', 'pad'],
    spatialFX: {
      reverbMix: 0.15,
      reverbDecay: 1.8,
      delayMix: 0.15,
      delayTime: 0.214,  // 1/16 at 140 BPM
      delayFeedback: 0.30,
    },
    tracks: [

      // Track 1 — Kick: solid 4/4
      setSteps(emptyTrack('Kick', 10), [
        [0,  36, 122, 0.25],
        [4,  36, 118, 0.25],
        [8,  36, 120, 0.25],
        [12, 36, 115, 0.25],
      ]),

      // Track 2 — Snare: beats 2 & 4
      setSteps(emptyTrack('Snare', 10), [
        [4,  38, 100, 0.25],
        [12, 38,  96, 0.25],
      ]),

      // Track 3 — Hi-Hat Closed: full 16th note drive, velocity groove
      // [ x x x x | x x x x | x x x x | x x x x ]
      setSteps(emptyTrack('HH Closed', 10), [
        [0,  42, 72, 0.06], [1,  42, 45, 0.06],
        [2,  42, 70, 0.06], [3,  42, 45, 0.06],
        [4,  42, 72, 0.06], [5,  42, 45, 0.06],
        [6,  42, 70, 0.06], [7,  42, 45, 0.06],
        [8,  42, 72, 0.06], [9,  42, 45, 0.06],
        [10, 42, 70, 0.06], [11, 42, 45, 0.06],
        [12, 42, 72, 0.06], [13, 42, 45, 0.06],
        [14, 42, 70, 0.06], [15, 42, 45, 0.06],
      ]),

      // Track 4 — Hi-Hat Open: off-beat accents
      // [ . . . . | . . . x | . . . . | . . . x ]
      setSteps(emptyTrack('HH Open', 10), [
        [7,  46, 78, 0.3],
        [15, 46, 75, 0.3],
      ]),

      // Track 5 — 303 Acid Bass #1 (main acid line)
      // Pattern: [ x x . x | x . x . | x x . x | . x x . ]
      // Steps:     0 1   3   4   6     8 9   11    13 14
      //
      // Accent (↑ filter open + vol boost) on downbeats: 0, 4, 8
      // Slide (pitch glide, no retrigger) between consecutive pairs:
      //   (0→1): step 0 slide=true
      //   (3→4): step 3 slide=true
      //   (8→9): step 8 slide=true
      //   (13→14): step 13 slide=true
      setSteps(emptyTrack('Acid 303', 1), [
        //  idx  note  vel  gate  prob  accent slide
        [0,  45, 115, 0.50, 100, true,  true ],  // A2 — accent + slide→step1
        [1,  48,  80, 0.25, 100, false, false],  // C3
        [3,  43,  90, 0.35, 100, false, true ],  // G2 — slide→step4
        [4,  45, 115, 0.50, 100, true,  false],  // A2 — accent
        [6,  40,  85, 0.30, 100, false, false],  // E2
        [8,  45, 115, 0.50, 100, true,  true ],  // A2 — accent + slide→step9
        [9,  50,  85, 0.25, 100, false, false],  // D3
        [11, 43,  88, 0.35, 100, false, false],  // G2
        [13, 48,  85, 0.30, 100, false, true ],  // C3 — slide→step14
        [14, 45, 100, 0.45, 100, false, false],  // A2
      ]),

      // Track 6 — 303 Acid Bass #2 (counter-line)
      // Pattern: [ . . x . | . x . x | . . x . | x . . x ]
      // Steps:         2       5   7         10   12      15
      // No slides (not consecutive), accent on downbeat 12
      setSteps(emptyTrack('Acid 303 B', 1), [
        //  idx  note  vel  gate  prob  accent slide
        [2,  40,  88, 0.35, 100, false, false],  // E2
        [5,  43,  80, 0.25, 100, false, false],  // G2
        [7,  50,  90, 0.35, 100, false, false],  // D3
        [10, 45,  85, 0.30, 100, false, false],  // A2
        [12, 48, 110, 0.45, 100, true,  false],  // C3 — accent (downbeat)
        [15, 45,  80, 0.25, 100, false, false],  // A2
      ]),

      // Track 7 — Lead: very sparse A minor
      // [ . . . . | . . . . | . . x . | . . x . ]
      setSteps(emptyTrack('Lead', 2), [
        [10, 57, 85, 0.35, 80],  // A3
        [14, 52, 78, 0.30, 75],  // E3
      ]),

      // Track 8 — Pad: sustained A minor root
      // [ x . . . | . . . . | . . . . | . . . . ]
      setSteps(emptyTrack('Pad', 3), [
        [0, 57, 60, 0.95],  // A3 — sustained whole bar
      ]),

    ],
  },

};

// Expose globally
window.PRESETS    = PRESETS;
window.midiToName = midiToName;
window.nameToMidi = nameToMidi;
window.NOTE_NAMES = NOTE_NAMES;
