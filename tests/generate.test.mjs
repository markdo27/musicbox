/**
 * tests/generate.test.mjs — Node test harness for the generative engine.
 * Run:  node tests/generate.test.mjs
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Generator = require(path.join(__dirname, '..', 'js', 'generate.js'));

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { passed++; }
  else { failed++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); }
}

function eq(name, a, b) {
  ok(name, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ─── PRNG determinism ────────────────────────────────────────────
{
  const a = Generator.makeRng('hello');
  const b = Generator.makeRng('hello');
  const c = Generator.makeRng('world');
  const seqA = [a(), a(), a(), a(), a()];
  const seqB = [b(), b(), b(), b(), b()];
  const seqC = [c(), c(), c(), c(), c()];
  ok('PRNG: same seed → same stream', JSON.stringify(seqA) === JSON.stringify(seqB));
  ok('PRNG: different seed → different stream', JSON.stringify(seqA) !== JSON.stringify(seqC));
  ok('PRNG: values in [0,1)', seqA.every(v => v >= 0 && v < 1));
}

// ─── Euclidean rhythm correctness ────────────────────────────────
{
  const e38 = Generator.bjorklund(3, 8);
  eq('E(3,8) length', e38.length, 8);
  eq('E(3,8) onset count', e38.filter(Boolean).length, 3);
  ok('E(3,8) pattern', JSON.stringify(e38) === JSON.stringify([true,false,false,true,false,false,true,false]),
    JSON.stringify(e38));

  const e58 = Generator.bjorklund(5, 8);
  ok('E(5,8) pattern', JSON.stringify(e58) === JSON.stringify([true,false,true,true,false,true,true,false]),
    JSON.stringify(e58));

  const e316 = Generator.bjorklund(3, 16);
  eq('E(3,16) length', e316.length, 16);
  eq('E(3,16) onset count', e316.filter(Boolean).length, 3);

  // E(k,n) must have exactly k onsets for all k in range.
  let allGood = true;
  for (let k = 0; k <= 16; k++) {
    const p = Generator.bjorklund(k, 16);
    if (p.length !== 16 || p.filter(Boolean).length !== k) allGood = false;
  }
  ok('E(k,16) always has exactly k onsets', allGood);

  // Rotation must preserve onset count.
  const rot = Generator.rotatePattern(Generator.bjorklund(5, 16), 3);
  eq('rotate preserves onsets', rot.filter(Boolean).length, 5);

  // Two-voice XOR.
  const x = Generator.euclid2(3, 8, 5, 8, 'xor');
  eq('euclid2 length', x.length, 8);
}

// ─── Scale theory ────────────────────────────────────────────────
{
  const minor = Generator.SCALES.minor;
  eq('degreeToMidi C', Generator.degreeToMidi(48, minor, 0), 48);
  eq('degreeToMidi degree 1', Generator.degreeToMidi(48, minor, 1), 50);
  eq('degreeToMidi octave wrap', Generator.degreeToMidi(48, minor, 7), 60);
  eq('degreeToMidi negative', Generator.degreeToMidi(48, minor, -1), 46);

  eq('scaleDegreeOf in-scale', Generator.scaleDegreeOf(48, minor, 50), 1);
  eq('scaleDegreeOf out-of-scale', Generator.scaleDegreeOf(48, minor, 49), -1);

  eq('quantizeToScale snaps down', Generator.quantizeToScale(48, minor, 49), 48);
  eq('quantizeToScale snaps up', Generator.quantizeToScale(48, minor, 49), 48);
  eq('quantizeToScale keeps in-scale', Generator.quantizeToScale(48, minor, 50), 50);

  // Diatonic triad in A minor: A, C, E
  const tri = Generator.triadForDegree(45, minor, 0);
  ok('triad A minor = A C E', JSON.stringify(tri) === JSON.stringify([45, 48, 52]), JSON.stringify(tri));
}

// ─── Determinism of full generation ──────────────────────────────
{
  const input = { genre: 'techno', seed: 'K7F-3QM', root: 40, scale: 'phrygian', stepCount: 16 };
  const a = Generator.generate(input);
  const b = Generator.generate(input);
  eq('generate: same seed → identical JSON', JSON.stringify(a), JSON.stringify(b));

  const c = Generator.generate({ ...input, seed: 'ZZZ-999' });
  ok('generate: different seed → different output', JSON.stringify(a) !== JSON.stringify(c));
}

// ─── Musical constraints: every note is in scale ─────────────────
{
  const genres = Object.keys(Generator.GENRES);
  const scaleNames = Object.keys(Generator.SCALES);
  const MELODIC = ['bass', 'acid', 'lead', 'pad', 'chords'];
  let violations = 0;
  let checked = 0;

  for (const g of genres) {
    for (const s of scaleNames) {
      // Force every track to a melodic role so the assertion is meaningful.
      const overrides = MELODIC.concat(MELODIC).slice(0, 8)
        .map(role => ({ role }));
      const patch = Generator.generate({
        genre: g, scale: s, seed: 'SCALE-TEST', root: 45, stepCount: 16,
        tracks: overrides,
      });
      for (const t of patch.tracks) {
        for (const st of t.steps) {
          if (!st.active) continue;
          checked++;
          if (Generator.scaleDegreeOf(patch.meta.root, Generator.SCALES[s], st.note) < 0) {
            violations++;
          }
        }
      }
    }
  }
  ok('all generated scale-degree notes are in scale', violations === 0,
    `${violations}/${checked} out of scale`);
  ok('scale check actually ran', checked > 1000, `checked ${checked}`);
}

// ─── Drum tracks use valid GM percussion notes ──────────────────
{
  const GM_DRUM = new Set([35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,55,56,57,59]);
  let bad = 0;
  for (const g of Object.keys(Generator.GENRES)) {
    const patch = Generator.generate({ genre: g, seed: 'GM-TEST' });
    for (const t of patch.tracks) {
      const isDrum = ['kick','snare','clap','hat','openhat','perc'].includes(t.role);
      if (!isDrum) continue;
      for (const st of t.steps) {
        if (st.active && !GM_DRUM.has(st.note)) bad++;
      }
    }
  }
  ok('drum tracks use GM percussion notes', bad === 0, `${bad} invalid drum notes`);
}

// ─── Musical constraints: drum notes are correct ─────────────────
{
  const patch = Generator.generate({ genre: 'techno', seed: 'DRUMS' });
  const kick = patch.tracks.find(t => t.role === 'kick');
  ok('kick has 4 hits per bar', kick.steps.filter(s => s.active).length >= 4);
  ok('kick uses MIDI 36', kick.steps.every(s => !s.active || s.note === 36));
  const snare = patch.tracks.find(t => t.role === 'snare');
  ok('snare lands on 4 and 12', snare.steps[4].active && snare.steps[12].active);
  ok('snare uses MIDI 38', snare.steps.every(s => !s.active || s.note === 38));
}

// ─── Step schema completeness ────────────────────────────────────
{
  const patch = Generator.generate({ genre: 'acid', seed: 'SCHEMA' });
  const s = patch.tracks[0].steps[0];
  for (const key of ['active','note','velocity','gate','probability','accent','slide','offset','repeats']) {
    ok(`step has "${key}"`, Object.prototype.hasOwnProperty.call(s, key));
  }
  ok('velocity in 1..127', s.velocity >= 1 && s.velocity <= 127);
  ok('probability in 0..100', s.probability >= 0 && s.probability <= 100);
  ok('gate in 0..1', s.gate > 0 && s.gate <= 1);
}

// ─── Humanise ────────────────────────────────────────────────────
{
  const patch = Generator.generate({
    genre: 'techno', seed: 'HUMAN',
    humanize: { timing: 8, velocity: 12 },
  });
  const offsets = patch.tracks.flatMap(t => t.steps.filter(s => s.active).map(s => s.offset));
  ok('humanise produced non-zero offsets', offsets.some(o => o !== 0));
  ok('humanise offsets within +-30ms', offsets.every(o => Math.abs(o) <= 30));
  const vels = patch.tracks.flatMap(t => t.steps.filter(s => s.active).map(s => s.velocity));
  ok('humanise kept velocity in range', vels.every(v => v >= 1 && v <= 127));
}

// ─── Humanise is zero by default ────────────────────────────────
{
  const patch = Generator.generate({ genre: 'techno', seed: 'NOHUMAN' });
  const offsets = patch.tracks.flatMap(t => t.steps.map(s => s.offset));
  ok('no offsets by default', offsets.every(o => o === 0));
}

// ─── 32-step mode fills the whole bar ───────────────────────────
{
  const patch = Generator.generate({ genre: 'techno', seed: 'THIRTYTWO', stepCount: 32 });
  ok('32-step: every track has 32 steps', patch.tracks.every(t => t.steps.length === 32));
  const kick = patch.tracks.find(t => t.role === 'kick');
  ok('32-step: kick hits across the whole bar',
    kick.steps.slice(16).some(s => s.active), 'second half of the bar is empty');
}

// ─── Param validation ────────────────────────────────────────────
{
  const p = Generator.generate({ genre: 'nonsense', stepCount: 999, bpm: 9999, density: 5 });
  ok('unknown genre falls back', p.meta.genre === 'techno');
  ok('stepCount clamped', p.stepCount === 16);
  ok('bpm clamped', p.bpm <= 240 && p.bpm >= 40);
  ok('density clamped', p.meta.density <= 1);
  ok('tracks array has 8', p.tracks.length === 8);
}

// ─── Per-track generation ────────────────────────────────────────
{
  const steps = Generator.generateTrack('kick', { genre: 'techno', seed: 'TRACK' });
  eq('generateTrack length', steps.length, 16);
  ok('generateTrack produced hits', steps.filter(s => s.active).length >= 4);
}

// ─── Progression chords are diatonic ─────────────────────────────
{
  const patch = Generator.generate({
    genre: 'house', seed: 'CHORDS', scale: 'minor', root: 45, progression: 'i-iv-v',
  });
  const pad = patch.tracks.find(t => t.role === 'chords');
  const inScale = pad.steps.filter(s => s.active)
    .every(s => Generator.scaleDegreeOf(45, Generator.SCALES.minor, s.note) >= 0);
  ok('chord notes are diatonic', inScale);
}

// ─── 16 Variations ─────────────────────────────────────────────
{
  const base = { genre: 'techno', seed: 'VAR-BASE', stepCount: 16 };
  const set1 = Generator.generateVariations(base, 16);
  eq('16 variations are produced', set1.length, 16);

  // Every variation must be distinct.
  const sigs = new Set(set1.map(p => JSON.stringify(p.tracks.map(t => t.steps))));
  eq('every variation is different', sigs.size, 16);

  // Every variation must be valid.
  let bad = 0;
  set1.forEach(p => {
    if (!p.tracks || p.tracks.length !== 8) bad++;
    p.tracks.forEach(t => t.steps.forEach(s => {
      if (typeof s.active !== 'boolean') bad++;
    }));
  });
  ok('every variation is well formed', bad === 0, `${bad} problems`);

  // The set must be reproducible from the base seed.
  const set2 = Generator.generateVariations(base, 16);
  eq('the same base seed gives the same set',
     JSON.stringify(set1.map(p => p.meta.seed)),
     JSON.stringify(set2.map(p => p.meta.seed)));
  eq('the same base seed gives the same patterns',
     JSON.stringify(set1.map(p => p.tracks)),
     JSON.stringify(set2.map(p => p.tracks)));

  // A different base seed gives a different set.
  const set3 = Generator.generateVariations({ ...base, seed: 'OTHER' }, 16);
  ok('a different base seed gives a different set',
     JSON.stringify(set1.map(p => p.tracks)) !== JSON.stringify(set3.map(p => p.tracks)));

  // The seeds must be unique within a set.
  const seeds = new Set(set1.map(p => p.meta.seed));
  eq('every variation has a unique seed', seeds.size, 16);
  ok('every variation records its index', set1.every((p, i) => p.meta.variantIndex === i));
  ok('every variation records its base seed', set1.every(p => p.meta.baseSeed === 'VAR-BASE'));

  // The variations must still be musically valid (in scale).
  const scale = Generator.SCALES[Generator.GENRES.techno.scale];
  let offScale = 0;
  set1.forEach(p => {
    p.tracks.forEach(t => {
      if (!['bass', 'acid', 'lead', 'pad', 'chords'].includes(t.role)) return;
      t.steps.forEach(s => {
        if (s.active && Generator.scaleDegreeOf(p.meta.root, scale, s.note) < 0) offScale++;
      });
    });
  });
  ok('every variation stays in scale', offScale === 0, `${offScale} out of scale`);
}

// ─── Report ──────────────────────────────────────────────────────
console.log('\n  MusicBox — generative engine tests\n');
console.log(`  passed: ${passed}`);
console.log(`  failed: ${failed}`);
if (failures.length) {
  console.log('\n  FAILURES:');
  failures.forEach(f => console.log('   ✗ ' + f));
  process.exit(1);
}
console.log('\n  ✓ all green\n');
