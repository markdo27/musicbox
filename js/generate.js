/**
 * generate.js — Generative Music Engine
 * ---------------------------------------------------------------------------
 * Pure, seeded, reproducible pattern generation.
 *
 * Design goals (see docs/AUDIT.md):
 *  - Every generator is a PURE function: (rng, params, context) -> patch.
 *  - Every generator is SEEDED: same seed + same params => byte-identical output.
 *  - Output is MUSICIALLY CONSTRAINED: notes are always in scale, always in a
 *    sane register, and always respect the track's role.
 *  - The API is a REGISTRY so adding a generator = adding one function.
 *
 * No DOM, no Web Audio, no globals beyond `window.Generator`.
 * Node-testable: `node tests/generate.test.mjs`
 */

const Generator = (() => {
  'use strict';

  // ═══════════════════════════════════════════════════════════════
  // 1. SEEDED RANDOMNESS
  // ═══════════════════════════════════════════════════════════════

  /** mulberry32 — fast 32-bit PRNG with good distribution. */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), 1 | t);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** FNV-1a — turns a string seed into a 32-bit number. */
  function hashSeed(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /** Build a seeded RNG with convenience helpers. */
  function makeRng(seed) {
    const numeric = typeof seed === 'number' ? (seed >>> 0) : hashSeed(String(seed ?? 'musicbox'));
    const rng = mulberry32(numeric);

    rng.int = (n) => Math.floor(rng() * n);                       // [0, n)
    rng.range = (lo, hi) => lo + rng() * (hi - lo);
    rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
    rng.chance = (p) => rng() < p;
    rng.sign = () => (rng() < 0.5 ? -1 : 1);

    /** Weighted pick. `weights` is parallel to `items`. */
    rng.weighted = (items, weights) => {
      let total = 0;
      for (const w of weights) total += w;
      if (total <= 0) return items[0];
      let r = rng() * total;
      for (let i = 0; i < items.length; i++) {
        r -= weights[i];
        if (r <= 0) return items[i];
      }
      return items[items.length - 1];
    };

    /** Box-Muller gaussian — used for humanisation. */
    rng.gauss = (mu = 0, sigma = 1) => {
      let u = 0, v = 0;
      while (u === 0) u = rng();
      while (v === 0) v = rng();
      return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };

    /** Fisher-Yates shuffle, in place. */
    rng.shuffle = (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = rng.int(i + 1);
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      return arr;
    };

    return rng;
  }

  // ═══════════════════════════════════════════════════════════════
  // 2. MUSIC THEORY
  // ═══════════════════════════════════════════════════════════════

  const SCALES = {
    minor:          [0, 2, 3, 5, 7, 8, 10],
    harmonicMinor:  [0, 2, 3, 5, 7, 8, 11],
    melodicMinor:   [0, 2, 3, 5, 7, 9, 11],
    phrygian:       [0, 1, 3, 5, 7, 8, 10],
    dorian:         [0, 2, 3, 5, 7, 9, 10],
    mixolydian:     [0, 2, 4, 5, 7, 9, 10],
    major:          [0, 2, 4, 5, 7, 9, 11],
    lydian:         [0, 2, 4, 6, 7, 9, 11],
    locrian:        [0, 1, 3, 5, 6, 8, 10],
    harmonicMajor:  [0, 2, 4, 5, 7, 8, 11],
    minorPentatonic:[0, 3, 5, 7, 10],
    majorPentatonic:[0, 2, 4, 7, 9],
    blues:          [0, 3, 5, 6, 7, 10],
    wholeTone:      [0, 2, 4, 6, 8, 10],
  };

  const SCALE_NAMES = {
    minor: 'Minor (Aeolian)',
    harmonicMinor: 'Harmonic Minor',
    melodicMinor: 'Melodic Minor',
    phrygian: 'Phrygian',
    dorian: 'Dorian',
    mixolydian: 'Mixolydian',
    major: 'Major (Ionian)',
    lydian: 'Lydian',
    locrian: 'Locrian',
    harmonicMajor: 'Harmonic Major',
    minorPentatonic: 'Minor Pentatonic',
    majorPentatonic: 'Major Pentatonic',
    blues: 'Blues',
    wholeTone: 'Whole Tone',
  };

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  const ROOTS = [
    { midi: 36, name: 'C2' },  { midi: 37, name: 'C#2' }, { midi: 38, name: 'D2' },
    { midi: 39, name: 'D#2' }, { midi: 40, name: 'E2' },  { midi: 41, name: 'F2' },
    { midi: 42, name: 'F#2' }, { midi: 43, name: 'G2' },  { midi: 44, name: 'G#2' },
    { midi: 45, name: 'A2' },  { midi: 46, name: 'A#2' }, { midi: 47, name: 'B2' },
    { midi: 48, name: 'C3' },  { midi: 49, name: 'C#3' }, { midi: 50, name: 'D3' },
    { midi: 51, name: 'D#3' }, { midi: 52, name: 'E3' },  { midi: 53, name: 'F3' },
    { midi: 54, name: 'F#3' }, { midi: 55, name: 'G3' },  { midi: 56, name: 'G#3' },
    { midi: 57, name: 'A3' },  { midi: 58, name: 'A#3' }, { midi: 59, name: 'B3' },
    { midi: 60, name: 'C4' },
  ];

  /** Scale degree (may be negative or > scale length) -> MIDI note. */
  function degreeToMidi(root, scale, degree, octaveOffset = 0) {
    const n = scale.length;
    const oct = Math.floor(degree / n);
    const idx = ((degree % n) + n) % n;
    return root + oct * 12 + scale[idx] + octaveOffset * 12;
  }

  /** Index of `midi` within the scale, or -1 if it is not in scale. */
  function scaleDegreeOf(root, scale, midi) {
    const rel = (((midi - root) % 12) + 12) % 12;
    return scale.indexOf(rel);
  }

  /** Snap an arbitrary MIDI note to the nearest scale tone (ties go down). */
  function quantizeToScale(root, scale, midi) {
    for (let d = 0; d <= 6; d++) {
      if (scaleDegreeOf(root, scale, midi - d) >= 0) return midi - d;
      if (scaleDegreeOf(root, scale, midi + d) >= 0) return midi + d;
    }
    return midi;
  }

  /**
   * Pick a scale degree, biased towards stable degrees and the tonic.
   * `range` = how many degrees either side of 0 to consider.
   */
  function randomDegree(rng, scale, { bias = 0.35, range = 1 } = {}) {
    const candidates = [];
    for (let d = -range; d <= range; d++) candidates.push(d);
    const stable = [0, 2, 4, 5, 7, 9, 10];
    const weights = candidates.map((d) => {
      const pc = scale[((d % scale.length) + scale.length) % scale.length];
      const stability = stable.includes(pc) ? 1 : 0.5;
      const tonic = d === 0 ? 2.4 : 1;
      return stability * tonic * (1 - bias) + bias * stability * tonic;
    });
    return rng.weighted(candidates, weights);
  }

  /** Diatonic triad for a scale degree (auto maj/min from the scale). */
  function triadForDegree(root, scale, degree, octaveOffset = 0) {
    const third = degreeToMidi(root, scale, degree + 2, octaveOffset);
    const fifth = degreeToMidi(root, scale, degree + 4, octaveOffset);
    return [degreeToMidi(root, scale, degree, octaveOffset), third, fifth];
  }

  // ─── Chord progressions, expressed as scale degrees ─────────────
  const PROGRESSIONS = {
    none:            null,
    'i-VI-III-VII':  [0, 5, 2, 6],
    'i-iv-VI-V':     [0, 3, 5, 4],
    'i-VII-VI-VII':  [0, 6, 5, 6],
    'i-iv-v':        [0, 3, 4],
    'i-V-v-iv':      [0, 5, 4, 3],
    'i-VI-v-iv':     [0, 5, 4, 3],
    'ii-V-I':        [1, 4, 0],
    'I-V-vi-IV':     [0, 4, 5, 3],
    'i-iv-vi-V':     [0, 3, 5, 4],
    'i-VI-iv-V':     [0, 5, 3, 4],
  };

  const PROGRESSION_NAMES = {
    none:           'None',
    'i-VI-III-VII': 'i – VI – III – VII (Dorian pop)',
    'i-iv-VI-V':    'i – iv – VI – V (Andalusian)',
    'i-VII-VI-VII': 'i – VII – VI – VII (Aeolian)',
    'i-iv-v':       'i – iv – v (Modal)',
    'i-V-v-iv':     'i – V – v – iv (Minor classic)',
    'i-VI-v-iv':    'i – VI – v – iv (Dorian minor)',
    'ii-V-I':       'ii – V – I (Major turnarounds)',
    'I-V-vi-IV':    'I – V – vi – IV (Pop)',
    'i-iv-vi-V':    'i – iv – vi – V (Dorian pop)',
    'i-VI-iv-V':    'i – VI – iv – V (Minor wide)',
  };

  // ═══════════════════════════════════════════════════════════════
  // 3. RHYTHM ALGORITHMS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Bjorklund / Toussaint Euclidean rhythm.
   * E(3,8) -> [1,0,0,1,0,0,1,0]   E(5,8) -> [1,0,1,1,0,1,1,0]
   */
  function bjorklund(k, n) {
    if (n <= 0) return [];
    k = Math.max(0, Math.min(k | 0, n));
    if (k === 0) return new Array(n).fill(false);
    if (k === n) return new Array(n).fill(true);

    let a = Array.from({ length: k }, () => [true]);
    let b = Array.from({ length: n - k }, () => [false]);

    while (b.length > 1) {
      const m = Math.min(a.length, b.length);
      const merged = [];
      for (let i = 0; i < m; i++) merged.push(a[i].concat(b[i]));
      const leftover = a.length > b.length ? a.slice(m) : b.slice(m);
      a = merged;
      b = leftover;
    }
    return a.concat(b).flat();
  }

  /** Rotate a boolean pattern by `r` steps. */
  function rotatePattern(pattern, r) {
    const n = pattern.length;
    if (n === 0) return [];
    const k = ((r % n) + n) % n;
    return pattern.slice(k).concat(pattern.slice(0, k));
  }

  /**
   * Two Euclidean voices combined with OR or XOR — the Digitakt II
   * "PL1 / PL2" model.
   */
  function euclid2(k1, n1, k2, n2, mode = 'or', rot1 = 0, rot2 = 0) {
    const a = rotatePattern(bjorklund(k1, n1), rot1);
    const b = rotatePattern(bjorklund(k2, n2), rot2);
    const n = Math.max(a.length, b.length);
    const out = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
      const x = a[i % a.length];
      const y = b[i % b.length];
      out[i] = mode === 'xor' ? (x !== y) : (x || y);
    }
    return out;
  }

  /**
   * Probability-weighted step grammar.
   * Combines a positional prior with a weighted random walk so hits
   * cluster musically instead of scattering as uniform noise.
   */
  function generateGrammar(rng, p, stepCount) {
    const len = p.length ?? stepCount;
    const density = p.density ?? 0.5;
    const cluster = p.cluster ?? 0.3;
    const steps = [];

    const MAX_GAP = 8;
    let gap = 0;
    let strength = 0;

    for (let i = 0; i < len; i++) {
      // Raised-cosine energy profile so the pattern has a shape.
      const phase = (i % 16) / 16;
      const energy = 0.6 + 0.4 * Math.sin(phase * Math.PI);
      const prior = density * energy;

      // Pull towards the quarter-note grid.
      const onGrid = (i % 4 === 0) ? 0.3 : 0;

      const pOn = Math.max(0, Math.min(1,
        prior * (1 + onGrid) * (1 - cluster * (gap / MAX_GAP)) +
        (cluster * strength) * 0.35));

      const on = rng.chance(pOn);
      steps.push({
        on,
        velocity: Math.round(rng.range(70, 118)),
        gate: rng.range(0.08, 0.5),
        probability: 100,
      });

      if (on) { gap = 0; strength = 1; }
      else { gap = Math.min(MAX_GAP, gap + 1); strength *= 0.6; }
    }
    return steps;
  }

  // ═══════════════════════════════════════════════════════════════
  // 4. MELODY ALGORITHMS
  // ═══════════════════════════════════════════════════════════════

  /** Default interval preference tables (in scale degrees) per style. */
  const INTERVAL_WEIGHTS = {
    techno: { '-4': 0.2, '-3': 0.4, '-2': 0.8, '-1': 1.8, '0': 2.6, '1': 1.6, '2': 1.1, '3': 0.6, '4': 0.35, '5': 0.25 },
    acid:   { '-5': 0.2, '-4': 0.3, '-2': 0.7, '-1': 2.2, '0': 2.0, '1': 1.9, '2': 1.4, '3': 0.9, '4': 0.5, '5': 0.2 },
    dub:    { '-4': 0.3, '-3': 0.5, '-2': 1.0, '-1': 1.4, '0': 3.0, '1': 1.0, '2': 0.6, '3': 0.4 },
    house:  { '-3': 0.3, '-2': 0.9, '-1': 1.6, '0': 2.2, '1': 1.4, '2': 1.0, '3': 0.6, '4': 0.3 },
    ambient:{ '-5': 0.6, '-4': 0.8, '-3': 0.7, '-2': 1.0, '-1': 1.2, '0': 1.6, '1': 1.1, '2': 0.9, '3': 0.6, '4': 0.4, '5': 0.3 },
  };

  /**
   * Markov-style melody generation over scale degrees using an
   * interval-preference table. Returns an array of scale DEGREES.
   */
  function generateMelodyDegrees(rng, scale, style, length, octaveRange = 1) {
    const table = INTERVAL_WEIGHTS[style] || INTERVAL_WEIGHTS.techno;
    const deltas = Object.keys(table).map(Number);
    const weights = deltas.map((d) => table[String(d)]);

    const out = [0]; // start on the tonic
    const maxDeg = scale.length * octaveRange;
    for (let i = 1; i < length; i++) {
      const step = rng.weighted(deltas, weights);
      let d = out[i - 1] + step;
      while (d > maxDeg) d -= scale.length;
      while (d < -maxDeg + scale.length) d += scale.length;
      out.push(d);
    }
    return out;
  }

  /**
   * Motif development — generate a short motif then repeat it with
   * mutations (A, A', A'', B). This is what separates a generator from
   * a dice button: variation and identity coexist.
   */
  function developMotif(rng, scale, root, style, motifLength, stepCount) {
    const base = generateMelodyDegrees(rng, scale, style, motifLength, 1);
    const variants = [];

    // A — the motif itself
    variants.push(base.slice());

    // A' — one note transposed
    const a1 = base.slice();
    const idx = rng.int(a1.length);
    a1[idx] += rng.pick([-2, -1, 1, 2]);
    variants.push(a1);

    // A'' — a note dropped, another shifted
    const a2 = base.filter((_, i) => i !== rng.int(base.length));
    variants.push(a2.length ? a2 : base.slice());

    // B — retrograde (same rhythm, reversed contour)
    variants.push(base.slice().reverse());

    // Build the bar from the variants.
    const pattern = [];
    let vi = 0;
    while (pattern.length < stepCount) {
      const v = variants[vi % variants.length];
      vi++;
      for (const d of v) {
        if (pattern.length >= stepCount) break;
        pattern.push(d);
      }
    }
    return pattern.map((d) => degreeToMidi(root, scale, d, 1));
  }

  // ═══════════════════════════════════════════════════════════════
  // 5. STEP / TRACK PRIMITIVES
  // ═══════════════════════════════════════════════════════════════

  /** A blank step in the current schema. */
  function blankStep(overrides = {}) {
    return {
      active: false,
      note: 60,
      velocity: 100,
      gate: 0.5,
      probability: 100,
      accent: false,
      slide: false,
      offset: 0,     // micro-timing in ms (humanise)
      repeats: 1,    // ratchet count
      ...overrides,
    };
  }

  /** Build a step array of `length` blank steps. */
  function blankSteps(length) {
    return Array.from({ length }, () => blankStep());
  }

  /**
   * Apply a rhythm mask (booleans) to a step array, filling in the
   * musical attributes for the hits.
   */
  function applyMask(steps, mask, fill) {
    const n = Math.min(steps.length, mask.length);
    for (let i = 0; i < n; i++) {
      if (!mask[i]) { steps[i].active = false; continue; }
      steps[i].active = true;
      fill(steps[i], i);
    }
    // Any steps beyond the mask keep their inactive state.
    for (let i = n; i < steps.length; i++) steps[i].active = false;
    return steps;
  }

  /** Build a Euclidean mask of the requested length. */
  function euclidMask(k, n, rot = 0) {
    const pattern = rotatePattern(bjorklund(k, n), rot);
    const out = new Array(n).fill(false);
    for (let i = 0; i < n; i++) out[i] = !!pattern[i % pattern.length];
    return out;
  }

  // ═══════════════════════════════════════════════════════════════
  // 6. TRACK ROLES
  // ═══════════════════════════════════════════════════════════════

  /**
   * Each role fills a step array according to its musical function.
   * `ctx` = { rng, root, scale, stepCount, params }
   */
  const ROLES = {
    kick(rng, steps, ctx) {
      const p = ctx.params;
      const bar = ctx.stepCount >= 16 ? 16 : ctx.stepCount;
      // Four on the floor, in a bar that may be longer than 16.
      for (let i = 0; i < ctx.stepCount; i++) {
        if (i % 4 !== 0) continue;
        steps[i].active = true;
        steps[i].note = 36;
        steps[i].velocity = 112 + rng.int(12);
        steps[i].gate = 0.25;
        steps[i].accent = (i % 16) === 0;
      }
      // Occasional ghost kick before the last beat.
      if (rng.chance(0.35 * p.density + 0.1)) {
        const gi = bar - 2;
        if (gi >= 0) {
          steps[gi].active = true;
          steps[gi].note = 36;
          steps[gi].velocity = 62;
          steps[gi].gate = 0.1;
          steps[gi].probability = 70;
        }
      }
      return steps;
    },

    snare(rng, steps, ctx) {
      const p = ctx.params;
      const bar = ctx.stepCount >= 16 ? 16 : ctx.stepCount;
      for (let i = 0; i < ctx.stepCount; i++) {
        if (i % 16 !== 4 && i % 16 !== 12) continue;
        steps[i].active = true;
        steps[i].note = 38;
        steps[i].velocity = 100 + rng.int(16);
        steps[i].gate = 0.25;
        steps[i].accent = true;
      }
      // Ghost snares.
      if (rng.chance(0.6 * p.density)) {
        const g = rng.pick([7, 10, 14, 15]);
        if (g < bar) {
          steps[g].active = true;
          steps[g].note = 38;
          steps[g].velocity = 48 + rng.int(16);
          steps[g].gate = 0.08;
          steps[g].probability = 60;
        }
      }
      return steps;
    },

    clap(rng, steps, ctx) {
      const p = ctx.params;
      const bar = ctx.stepCount >= 16 ? 16 : ctx.stepCount;
      for (let i = 0; i < ctx.stepCount; i++) {
        if (i % 16 !== 4 && i % 16 !== 12) continue;
        steps[i].active = true;
        steps[i].note = 39;
        steps[i].velocity = 100 + rng.int(16);
        steps[i].gate = 0.25;
        steps[i].accent = true;
      }
      if (rng.chance(0.4 * p.density)) {
        const g = rng.pick([14, 15]);
        if (g < bar) {
          steps[g].active = true;
          steps[g].note = 39;
          steps[g].velocity = 55;
          steps[g].gate = 0.1;
          steps[g].probability = 55;
        }
      }
      return steps;
    },

    hat(rng, steps, ctx) {
      const p = ctx.params;
      // Euclidean hats, or straight 8ths/16ths when euclid is disabled.
      let mask;
      if (p.euclidEnabled) {
        mask = euclidMask(p.euclid.k, p.euclid.n, p.euclid.rot);
        const per = ctx.stepCount / Math.max(1, p.euclid.n);
        if (Math.abs(per - Math.round(per)) > 0.01 || p.euclid.n < ctx.stepCount) {
          // Expand the euclid pattern across the whole bar.
          const expanded = new Array(ctx.stepCount).fill(false);
          const n = p.euclid.n;
          for (let i = 0; i < ctx.stepCount; i++) {
            expanded[i] = mask[Math.floor((i * n) / ctx.stepCount)] && mask[i % n] !== undefined
              ? mask[Math.floor((i * n) / ctx.stepCount)]
              : false;
          }
          mask = expanded;
        }
      } else {
        mask = new Array(ctx.stepCount).fill(false);
        const div = p.hatDivision === 8 ? 2 : 1; // 8ths or 16ths
        for (let i = 0; i < ctx.stepCount; i += div) mask[i] = true;
      }
      return applyMask(steps, mask, (s, i) => {
        s.note = 42;
        const accentPhase = i % 4 === 0;
        s.velocity = accentPhase ? 66 + rng.int(10) : 44 + rng.int(12);
        s.gate = 0.07;
        s.probability = 100;
      });
    },

    openhat(rng, steps, ctx) {
      const p = ctx.params;
      const bar = ctx.stepCount >= 16 ? 16 : ctx.stepCount;
      const positions = rng.chance(0.5) ? [6, 14] : [14];
      for (const pos of positions) {
        if (pos >= bar) continue;
        steps[pos].active = true;
        steps[pos].note = 46;
        steps[pos].velocity = 72 + rng.int(14);
        steps[pos].gate = 0.3;
      }
      // Offbeat open hats.
      if (rng.chance(0.4 * p.density)) {
        const g = rng.pick([2, 10]);
        if (g < bar) {
          steps[g].active = true;
          steps[g].note = 46;
          steps[g].velocity = 55;
          steps[g].gate = 0.2;
          steps[g].probability = 60;
        }
      }
      return steps;
    },

    perc(rng, steps, ctx) {
      const p = ctx.params;
      const pool = [1, 3, 5, 7, 9, 11, 13, 15].filter((i) => i < ctx.stepCount);
      const count = 1 + rng.int(Math.max(1, Math.round(3 * p.density)));
      rng.shuffle(pool.slice());
      for (let i = 0; i < count; i++) {
        const pos = pool[i % pool.length];
        steps[pos].active = true;
        steps[pos].note = 37 + rng.int(4);
        steps[pos].velocity = 50 + rng.int(24);
        steps[pos].gate = 0.1;
        steps[pos].probability = 60;
      }
      return steps;
    },

    bass(rng, steps, ctx) {
      const p = ctx.params;
      const { root, scale } = ctx;
      let mask;
      if (p.euclidEnabled) {
        mask = euclidMask(p.euclid.k, p.euclid.n, p.euclid.rot);
        const expanded = new Array(ctx.stepCount).fill(false);
        for (let i = 0; i < ctx.stepCount; i++) {
          expanded[i] = mask[Math.floor((i * p.euclid.n) / ctx.stepCount)];
        }
        mask = expanded;
      } else {
        mask = new Array(ctx.stepCount).fill(false);
        const rhythm = [0, 3, 6, 8, 11, 14].filter((i) => i < ctx.stepCount);
        for (const r of rhythm) if (rng.chance(0.55 + 0.4 * p.density)) mask[r] = true;
      }
      // Always anchor the downbeat.
      mask[0] = true;

      return applyMask(steps, mask, (s, i) => {
        const deg = randomDegree(rng, scale, { bias: 0.45, range: 2 });
        s.note = degreeToMidi(root, scale, deg, -2);
        s.velocity = 92 + rng.int(20);
        s.gate = rng.range(0.3, 0.55);
        s.accent = rng.chance(p.accentChance);
        s.slide = rng.chance(p.slideChance);
        s.probability = 100;
      });
    },

    acid(rng, steps, ctx) {
      const p = ctx.params;
      const { root, scale } = ctx;
      // Dense 16th-driven 303 line.
      const activeCount = Math.max(4, Math.round(ctx.stepCount * (0.35 + 0.45 * p.density)));
      const pool = Array.from({ length: ctx.stepCount }, (_, i) => i);
      rng.shuffle(pool);
      const picked = pool.slice(0, activeCount).sort((a, b) => a - b);
      if (!picked.includes(0)) picked.unshift(0);

      const degrees = picked.map(() => randomDegree(rng, scale, { bias: 0.5, range: 3 }));
      picked.forEach((pos, idx) => {
        const s = steps[pos];
        s.active = true;
        s.note = degreeToMidi(root, scale, degrees[idx], -2);
        s.velocity = 88 + rng.int(26);
        s.gate = rng.range(0.28, 0.52);
        s.accent = (pos % 4 === 0) ? true : rng.chance(p.accentChance);
        s.probability = 100;
      });
      // Slide is a property of the DESTINATION step (glide into this note).
      picked.forEach((pos, idx) => {
        const next = picked[idx + 1];
        if (next !== undefined && next === pos + 1) steps[pos].slide = true;
      });
      return steps;
    },

    lead(rng, steps, ctx) {
      const p = ctx.params;
      const { root, scale } = ctx;
      const motif = developMotif(rng, scale, root, p.style, p.motifLength, ctx.stepCount);
      // Place the motif on a rhythm.
      const rhythm = generateGrammar(rng, { density: 0.3 + 0.4 * p.density, cluster: 0.3 }, ctx.stepCount);
      for (let i = 0; i < ctx.stepCount; i++) {
        const s = steps[i];
        if (!rhythm[i].on) { s.active = false; continue; }
        s.active = true;
        s.note = quantizeToScale(root, scale, motif[i % motif.length]);
        s.velocity = 78 + rng.int(24);
        s.gate = rhythm[i].gate;
        s.probability = 100;
        s.accent = rng.chance(p.accentChance);
      }
      // Guarantee at least one note.
      if (!steps.some((s) => s.active)) {
        steps[0].active = true;
        steps[0].note = degreeToMidi(root, scale, 0, 1);
        steps[0].velocity = 90;
      }
      return steps;
    },

    pad(rng, steps, ctx) {
      const p = ctx.params;
      const { root, scale } = ctx;
      const prog = PROGRESSIONS[p.progression] || PROGRESSIONS['i-VI-III-VII'];
      const degrees = prog || [0, 0, 0, 0];
      const barSteps = Math.max(1, Math.round(ctx.stepCount / degrees.length));
      const bar = ctx.stepCount >= 16 ? 16 : ctx.stepCount;

      // A pad re-triggers on the beat with a long gate, rather than
      // sounding on every 16th — 16 sustained hits is a wall, not a pad.
      for (let i = 0; i < ctx.stepCount; i++) {
        if (i % 4 !== 0) { steps[i].active = false; continue; }
        const chordIdx = Math.floor((i % bar) / barSteps) % degrees.length;
        const deg = degrees[chordIdx];
        const triad = triadForDegree(root, scale, deg, 0);
        // Pick one note of the triad, voiced up an octave for the top end.
        const note = triad[rng.int(3)] + (rng.chance(0.4) ? 12 : 0);
        const s = steps[i];
        s.active = true;
        s.note = note;
        s.velocity = 62 + rng.int(10);
        s.gate = 0.9;
        s.probability = 100;
        s.accent = false;
        s.slide = false;
      }
      return steps;
    },

    chords(rng, steps, ctx) {
      const p = ctx.params;
      const { root, scale } = ctx;
      const prog = PROGRESSIONS[p.progression] || PROGRESSIONS['i-VI-III-VII'];
      const degrees = prog || [0];
      const barSteps = Math.max(1, Math.round(ctx.stepCount / degrees.length));
      const bar = ctx.stepCount >= 16 ? 16 : ctx.stepCount;

      for (let i = 0; i < ctx.stepCount; i++) {
        if (i % 4 !== 0) { steps[i].active = false; continue; }
        const chordIdx = Math.floor((i % bar) / barSteps) % degrees.length;
        const triad = triadForDegree(root, scale, degrees[chordIdx], 0);
        const s = steps[i];
        s.active = true;
        s.note = triad[0];
        s.velocity = 68;
        s.gate = 0.9;
        s.probability = 100;
      }
      return steps;
    },

    fx(rng, steps, ctx) {
      const p = ctx.params;
      const bar = ctx.stepCount >= 16 ? 16 : ctx.stepCount;
      const pos = rng.int(bar);
      steps[pos].active = true;
      steps[pos].note = 60 + rng.int(12);
      steps[pos].velocity = 55;
      steps[pos].gate = 0.7;
      steps[pos].probability = 50;
      return steps;
    },
  };

  // ═══════════════════════════════════════════════════════════════
  // 7. GENRES
  // ═══════════════════════════════════════════════════════════════

  const GENRES = {
    techno: {
      name: 'Techno', bpm: [130, 142], swing: [0, 8], style: 'techno',
      scale: 'phrygian', root: 40, progression: 'none',
      instruments: ['drum', 'drum', 'drum', 'drum', 'bass', 'lead', 'pad', 'drum'],
      tracks: [
        { name: 'Kick',       role: 'kick',   channel: 10 },
        { name: 'Snare',      role: 'snare',  channel: 10 },
        { name: 'HH Closed',  role: 'hat',    channel: 10 },
        { name: 'HH Open',    role: 'openhat',channel: 10 },
        { name: 'Sub Bass',   role: 'bass',   channel: 1 },
        { name: 'Lead Stab',  role: 'lead',   channel: 2 },
        { name: 'Pad',        role: 'pad',    channel: 3 },
        { name: 'Perc',       role: 'perc',   channel: 4 },
      ],
    },
    acid: {
      name: 'Acid', bpm: [134, 146], swing: [0, 4], style: 'acid',
      scale: 'minor', root: 45, progression: 'none',
      instruments: ['drum', 'drum', 'drum', 'drum', 'acid', 'acid', 'lead', 'pad'],
      tracks: [
        { name: 'Kick',       role: 'kick',   channel: 10 },
        { name: 'Clap',       role: 'clap',   channel: 10 },
        { name: 'HH Closed',  role: 'hat',    channel: 10 },
        { name: 'HH Open',    role: 'openhat',channel: 10 },
        { name: 'Acid 303',   role: 'acid',   channel: 1 },
        { name: 'Acid 303 B', role: 'acid',   channel: 2 },
        { name: 'Lead',       role: 'lead',   channel: 3 },
        { name: 'Pad',        role: 'pad',    channel: 4 },
      ],
    },
    house: {
      name: 'House', bpm: [120, 128], swing: [16, 30], style: 'house',
      scale: 'minor', root: 45, progression: 'i-iv-v',
      instruments: ['drum', 'drum', 'drum', 'drum', 'bass', 'lead', 'pad', 'drum'],
      tracks: [
        { name: 'Kick',       role: 'kick',   channel: 10 },
        { name: 'Clap',       role: 'clap',   channel: 10 },
        { name: 'HH Closed',  role: 'hat',    channel: 10 },
        { name: 'HH Open',    role: 'openhat',channel: 10 },
        { name: 'Bass',       role: 'bass',   channel: 1 },
        { name: 'Hook',       role: 'lead',   channel: 2 },
        { name: 'Chords',     role: 'chords', channel: 3 },
        { name: 'Perc',       role: 'perc',   channel: 4 },
      ],
    },
    dnb: {
      name: 'Drum & Bass', bpm: [168, 176], swing: [0, 10], style: 'dub',
      scale: 'minor', root: 43, progression: 'none',
      instruments: ['drum', 'drum', 'drum', 'drum', 'bass', 'lead', 'pad', 'drum'],
      tracks: [
        { name: 'Kick',       role: 'kick',   channel: 10 },
        { name: 'Snare',      role: 'snare',  channel: 10 },
        { name: 'HH Closed',  role: 'hat',    channel: 10 },
        { name: 'Perc',       role: 'perc',   channel: 10 },
        { name: 'Reese',      role: 'bass',   channel: 1 },
        { name: 'Lead',       role: 'lead',   channel: 2 },
        { name: 'Pad',        role: 'pad',    channel: 3 },
        { name: 'FX',         role: 'fx',     channel: 4 },
      ],
    },
    lofi: {
      name: 'Lo-Fi', bpm: [78, 92], swing: [38, 58], style: 'ambient',
      scale: 'majorPentatonic', root: 48, progression: 'ii-V-I',
      instruments: ['drum', 'drum', 'drum', 'drum', 'bass', 'lead', 'pad', 'drum'],
      tracks: [
        { name: 'Dusty Kick', role: 'kick',   channel: 10 },
        { name: 'Snare',      role: 'snare',  channel: 10 },
        { name: 'Swing Hat',  role: 'hat',    channel: 10 },
        { name: 'Foley',      role: 'perc',   channel: 10 },
        { name: 'Jazz Bass',  role: 'bass',   channel: 1 },
        { name: 'Rhodes',     role: 'lead',   channel: 2 },
        { name: 'Pad',        role: 'pad',    channel: 3 },
        { name: 'Birds',      role: 'fx',     channel: 4 },
      ],
    },
    dub: {
      name: 'Dub Techno', bpm: [124, 132], swing: [0, 6], style: 'dub',
      scale: 'minor', root: 40, progression: 'i-V-v-iv',
      instruments: ['drum', 'drum', 'drum', 'drum', 'bass', 'lead', 'pad', 'drum'],
      tracks: [
        { name: 'Kick',       role: 'kick',   channel: 10 },
        { name: 'Snare',      role: 'snare',  channel: 10 },
        { name: 'HH Closed',  role: 'hat',    channel: 10 },
        { name: 'HH Open',    role: 'openhat',channel: 10 },
        { name: 'Chord Bass', role: 'bass',   channel: 1 },
        { name: 'Stab',       role: 'lead',   channel: 2 },
        { name: 'Pad',        role: 'pad',    channel: 3 },
        { name: 'Perc',       role: 'perc',   channel: 4 },
      ],
    },
    ambient: {
      name: 'Ambient', bpm: [60, 80], swing: [0, 20], style: 'ambient',
      scale: 'majorPentatonic', root: 50, progression: 'i-VI-iv-V',
      instruments: ['drum', 'drum', 'drum', 'drum', 'bass', 'lead', 'pad', 'drum'],
      tracks: [
        { name: 'Kick',       role: 'kick',   channel: 10 },
        { name: 'Snare',      role: 'snare',  channel: 10 },
        { name: 'HH Closed',  role: 'hat',    channel: 10 },
        { name: 'HH Open',    role: 'openhat',channel: 10 },
        { name: 'Bass',       role: 'bass',   channel: 1 },
        { name: 'Lead',       role: 'lead',   channel: 2 },
        { name: 'Pad',        role: 'pad',    channel: 3 },
        { name: 'FX',         role: 'fx',     channel: 4 },
      ],
    },
  };

  // ═══════════════════════════════════════════════════════════════
  // 8. PATCH ASSEMBLY
  // ═══════════════════════════════════════════════════════════════

  /** Normalise user params into a complete parameter set. */
  function normaliseParams(input = {}) {
    const genreKey = GENRES[input.genre] ? input.genre : 'techno';
    const genre = GENRES[genreKey];

    const params = {
      genre: genreKey,
      style: input.style || genre.style,
      seed: input.seed === undefined || input.seed === null || input.seed === ''
        ? randomSeedString()
        : String(input.seed),
      root: clampInt(input.root ?? genre.root, 24, 96),
      scale: SCALES[input.scale] ? input.scale : genre.scale,
      density: clampNum(input.density ?? 0.5, 0, 1),
      probability: clampNum(input.probability ?? 0.2, 0, 1),
      accentChance: clampNum(input.accentChance ?? 0.2, 0, 1),
      slideChance: clampNum(input.slideChance ?? 0.25, 0, 1),
      motifLength: clampInt(input.motifLength ?? 4, 1, 16),
      progression: PROGRESSIONS[input.progression] !== undefined ? input.progression : genre.progression,
      euclidEnabled: input.euclidEnabled !== undefined ? !!input.euclidEnabled : true,
      euclid: {
        k: clampInt(input.euclid?.k ?? 5, 0, 32),
        n: clampInt(input.euclid?.n ?? 16, 1, 32),
        rot: clampInt(input.euclid?.rot ?? 0, 0, 31),
      },
      hatDivision: input.hatDivision === 8 ? 8 : 16,
      bpm: clampInt(input.bpm ?? Math.round((genre.bpm[0] + genre.bpm[1]) / 2), 40, 240),
      swing: clampInt(input.swing ?? 0, 0, 100),
      stepCount: input.stepCount === 32 ? 32 : 16,
      humanize: {
        timing: clampNum(input.humanize?.timing ?? 0, 0, 30),   // ms
        velocity: clampNum(input.humanize?.velocity ?? 0, 0, 30),
      },
      tracks: input.tracks || null,   // optional per-track overrides
    };
    return params;
  }

  /** Build a full 8-track patch from normalised params. */
  function buildPatch(params) {
    const rng = makeRng(params.seed);
    const genre = GENRES[params.genre];
    const scale = SCALES[params.scale];
    const stepCount = params.stepCount;

    const tracks = genre.tracks.map((t, i) => {
      const override = params.tracks?.[i] || {};
      const role = ROLES[override.role || t.role];
      const steps = blankSteps(stepCount);

      const ctx = {
        rng,
        root: params.root,
        scale,
        stepCount,
        params: {
          ...params,
          style: params.style,
        },
      };

      if (role) {
        try {
          role(rng, steps, ctx);
        } catch (e) {
          console.error(`[Generator] role "${t.role}" failed:`, e);
        }
      }

      applyHumanise(rng, steps, params.humanize);

      return {
        name: override.name || t.name,
        midiChannel: override.channel ?? t.channel,
        role: override.role || t.role,
        instrument: genre.instruments[i],
        steps,
      };
    });

    return {
      bpm: params.bpm,
      swing: params.swing,
      stepCount,
      tracks,
      meta: {
        seed: params.seed,
        genre: params.genre,
        root: params.root,
        scale: params.scale,
        progression: params.progression,
        density: params.density,
      },
    };
  }

  /**
   * Humanise: micro-timing jitter and velocity variance, so the result
   * sounds played rather than programmed.
   */
  function applyHumanise(rng, steps, humanize) {
    if (!humanize) return steps;
    const tMs = humanize.timing || 0;
    const vAmt = humanize.velocity || 0;
    for (const s of steps) {
      if (!s.active) continue;
      if (tMs > 0) {
        s.offset = Math.round(rng.gauss(0, tMs / 2) * 10) / 10;
      }
      if (vAmt > 0) {
        s.velocity = Math.max(1, Math.min(127,
          Math.round(s.velocity + rng.gauss(0, vAmt / 2))));
      }
    }
    return steps;
  }

  // ═══════════════════════════════════════════════════════════════
  // 9. PUBLIC API
  // ═══════════════════════════════════════════════════════════════

  const SEED_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  /** A short human-shareable seed, e.g. "K7F-3QM". */
  function randomSeedString() {
    let out = '';
    for (let i = 0; i < 6; i++) {
      out += SEED_ALPHABET[Math.floor(Math.random() * SEED_ALPHABET.length)];
      if (i === 2) out += '-';
    }
    return out;
  }

  function clampNum(v, lo, hi) { return Math.max(lo, Math.min(hi, Number(v) || 0)); }
  function clampInt(v, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(Number(v) || 0))); }

  /** Generate a complete patch. */
  function generate(input = {}) {
    const params = normaliseParams(input);
    return buildPatch(params);
  }

  /** Generate a single track's steps for a given role. */
  function generateTrack(role, input = {}) {
    const params = normaliseParams(input);
    const rng = makeRng(params.seed);
    const scale = SCALES[params.scale];
    const steps = blankSteps(params.stepCount);
    const fn = ROLES[role];
    if (!fn) return steps;
    fn(rng, steps, {
      rng, root: params.root, scale, stepCount: params.stepCount,
      params: { ...params, style: params.style },
    });
    applyHumanise(rng, steps, params.humanize);
    return steps;
  }

  /** Note name helper (shared with the UI). */
  function noteName(midi) {
    const n = ((midi % 12) + 12) % 12;
    const oct = Math.floor(midi / 12) - 1;
    return NOTE_NAMES[n] + oct;
  }

  return {
    // randomness
    makeRng, hashSeed, mulberry32, randomSeedString,
    // theory
    SCALES, SCALE_NAMES, ROOTS, NOTE_NAMES, PROGRESSIONS, PROGRESSION_NAMES, GENRES,
    degreeToMidi, scaleDegreeOf, quantizeToScale, randomDegree, triadForDegree, noteName,
    // rhythm
    bjorklund, rotatePattern, euclid2, euclidMask, generateGrammar,
    // melody
    generateMelodyDegrees, developMotif,
    // patch
    generate, generateTrack, normaliseParams, buildPatch, applyHumanise, blankStep, blankSteps,
  };
})();

if (typeof window !== 'undefined') window.Generator = Generator;
if (typeof module !== 'undefined' && module.exports) module.exports = Generator;
