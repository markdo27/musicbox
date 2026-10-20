/**
 * tests/dom.test.mjs — Static check that every element the JS reaches for
 * actually exists in index.html, and that every script the page loads is
 * present on disk.
 *
 * Catches the classic "renamed an id and forgot three handlers" class of bug.
 *
 * Run:  node tests/dom.test.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) passed++;
  else { failed++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); }
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// ─── 1. Every getElementById() in the JS must exist in the HTML ──
// Ids that the JS injects at runtime (step editor, mixer, instruments,
// generator preview) are legitimate too — collect them from the source.
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));

const jsFiles = fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js'));
const dynamicIds = new Set();
for (const f of jsFiles) {
  const src = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
  for (const m of src.matchAll(/id="([A-Za-z0-9_-]+)"/g)) dynamicIds.add(m[1]);
  for (const m of src.matchAll(/id="\$\{[^}]*\}([A-Za-z0-9_-]+)"/g)) dynamicIds.add(m[1]);
}
for (const f of jsFiles) {
  const src = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
  for (const m of src.matchAll(/id="([A-Za-z0-9_-]+)"/g)) dynamicIds.add(m[1]);
}
// Runtime-generated ids use a template, e.g. id="step-${trackIdx}-${stepIdx}".
// Register their prefixes so the check below recognises them.
const DYNAMIC_PREFIXES = ['step-', 'mixer-', 'instr-', 'track-', 'slot-btn-', 'preset-btn-', 'key-', 'step-ind-'];

const known = (id) => htmlIds.has(id) || dynamicIds.has(id) ||
  DYNAMIC_PREFIXES.some(p => id.startsWith(p));

const missing = [];
for (const f of jsFiles) {
  const src = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
  // Only literal string ids — dynamic ones (${...}) are skipped.
  for (const m of src.matchAll(/getElementById\(\s*'([^'$]+)'\s*\)/g)) {
    if (!known(m[1])) missing.push(`${f} → #${m[1]}`);
  }
  for (const m of src.matchAll(/\$\(\s*'([^'$]+)'\s*\)/g)) {
    if (!known(m[1])) missing.push(`${f} → #${m[1]} (via $())`);
  }
}
ok('every getElementById target exists in index.html', missing.length === 0,
  missing.join(', '));

// ─── 2. Every querySelector('#id') must exist ───────────────────
const missingQs = [];
for (const f of jsFiles) {
  const src = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
  for (const m of src.matchAll(/querySelector(?:All)?\(\s*'#([A-Za-z0-9_-]+)'/g)) {
    if (!htmlIds.has(m[1])) missingQs.push(`${f} → #${m[1]}`);
  }
}
ok('every querySelector target exists in index.html', missingQs.length === 0,
  missingQs.join(', '));

// ─── 3. Every <script src> must exist on disk ───────────────────
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
ok('at least 8 scripts are loaded', scripts.length >= 8, `got ${scripts.length}`);
const missingScripts = scripts.filter(s => !fs.existsSync(path.join(ROOT, s)));
ok('every script src exists on disk', missingScripts.length === 0, missingScripts.join(', '));

// ─── 4. Script load order: generate.js must precede its users ──
const genIdx = scripts.indexOf('js/generate.js');
ok('generate.js is loaded', genIdx >= 0);
ok('generate.js loads before audio.js', genIdx >= 0 && genIdx < scripts.indexOf('js/audio.js'));
ok('generate.js loads before sequencer.js', genIdx >= 0 && genIdx < scripts.indexOf('js/sequencer.js'));
ok('presets.js loads before sequencer.js',
   scripts.indexOf('js/presets.js') < scripts.indexOf('js/sequencer.js'));
ok('app.js loads last', scripts[scripts.length - 1] === 'js/app.js');

// ─── 5. Every element the app.js wires must exist ───────────────
const appSrc = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
const wired = [...appSrc.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]);
const unwired = [...new Set(wired)].filter(id => !htmlIds.has(id));
ok('every id app.js wires exists in the HTML', unwired.length === 0, unwired.join(', '));

// ─── 6. The generator panel controls the UI expects must exist ──
const GEN_IDS = [
  'gen-genre', 'gen-root', 'gen-scale', 'gen-progression',
  'gen-density', 'gen-euclid-k', 'gen-euclid-n', 'gen-euclid-rot',
  'gen-probability', 'gen-accent', 'gen-slide', 'gen-motif',
  'gen-human-timing', 'gen-human-velocity', 'gen-seed',
  'gen-reroll', 'gen-copy', 'gen-generate', 'gen-generate-track',
  'gen-target-track', 'gen-preview-grid', 'gen-preview-info',
];
const missingGen = GEN_IDS.filter(id => !htmlIds.has(id));
ok('every generator control exists in the HTML', missingGen.length === 0, missingGen.join(', '));

// ─── 6b. The MIDI controller layer must exist ──────────────────
const MIDI_IDS = [
  'clock-source', 'midi-learn-banner', 'midi-learn-text', 'midi-learn-cancel',
  'midi-cc-led', 'synth-track', 'synth-params', 'synth-reset',
  'synth-cutoff', 'synth-resonance', 'synth-env', 'synth-decay',
  'synth-drive', 'synth-glide', 'synth-level', 'synth-tune',
  'fx-params', 'fx-eq-low', 'fx-eq-mid', 'fx-eq-high',
  'fx-drive', 'fx-send-delay', 'fx-send-reverb',
  'btn-audio-rec', 'rec-timer',
  'pattern-slots', 'song-strip', 'song-enabled', 'song-bars',
  'gen-variations', 'modal-variations', 'variations-grid', 'variations-info',
  'variations-regenerate', 'variations-cancel',
];
const missingMidi = MIDI_IDS.filter(id => !htmlIds.has(id));
ok('every MIDI controller element exists in the HTML', missingMidi.length === 0, missingMidi.join(', '));

// Every synth / FX slider must have a matching value readout.
const synthParams = ['cutoff', 'resonance', 'env', 'decay', 'drive', 'glide', 'level', 'tune'];
const missingVals = synthParams.filter(p => !htmlIds.has(`synth-${p}-val`));
ok('every synth parameter has a value readout', missingVals.length === 0, missingVals.join(', '));

const fxParams = ['eq-low', 'eq-mid', 'eq-high', 'drive', 'send-delay', 'send-reverb'];
const missingFxVals = fxParams.filter(p => !htmlIds.has(`fx-${p}-val`));
ok('every FX parameter has a value readout', missingFxVals.length === 0, missingFxVals.join(', '));

// Learnable controls must declare data-learn.
const learnables = [...html.matchAll(/<(input|select)[^>]*id="([^"]+)"[^>]*>/g)]
  .filter(m => /data-learn/.test(m[0]));
ok('at least 12 controls are MIDI-learnable', learnables.length >= 12, `got ${learnables.length}`);

// The learn module must be loaded before the app that uses it.
const learnIdx = scripts.indexOf('js/midilearn.js');
ok('midilearn.js is loaded', learnIdx >= 0);
ok('midilearn.js loads before app.js', learnIdx >= 0 && learnIdx < scripts.indexOf('js/app.js'));
ok('midilearn.js loads after midi.js', learnIdx > scripts.indexOf('js/midi.js'));

// ─── 7. The UI's GEN_PARAM_IDS list must match the HTML ─────────
const uiSrc = fs.readFileSync(path.join(ROOT, 'js', 'ui.js'), 'utf8');
const genParamBlock = uiSrc.match(/const GEN_PARAM_IDS = \[([\s\S]*?)\];/);
ok('GEN_PARAM_IDS is declared', !!genParamBlock);
if (genParamBlock) {
  const listed = [...genParamBlock[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  const notInHtml = listed.filter(id => !htmlIds.has(id));
  ok('every GEN_PARAM_IDS entry exists in the HTML', notInHtml.length === 0, notInHtml.join(', '));
  const notListed = GEN_IDS.filter(id => !listed.includes(id) &&
    !['gen-reroll', 'gen-copy', 'gen-generate', 'gen-generate-track',
      'gen-target-track', 'gen-preview-grid', 'gen-preview-info'].includes(id));
  ok('every generator parameter control is listed in GEN_PARAM_IDS', notListed.length === 0,
    notListed.join(', '));
}

// ─── 8. The CSS classes the UI creates must be styled ───────────
const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
const CLASSES = [
  'generator-panel', 'gen-panel-head', 'gen-seed-wrap', 'gen-seed', 'gen-body',
  'gen-controls', 'gen-row', 'gen-val', 'gen-preview', 'gen-preview-label',
  'gen-preview-info', 'gen-preview-grid', 'gen-cell', 'gen-actions',
  'gen-preview-row', 'gen-preview-row-label', 'gen-preview-cells',
  'gen-subrow', 'gen-row-wide', 'gen-hint',
  'mixer-master', 'master-meter', 'master-meter-fill',
  'track-mode-select', 'track-out-select', 'device-selected',
  'clock-source-block', 'midi-learn-banner', 'midi-learn-dot',
  'midi-cc-led', 'learn-badge', 'synth-params', 'synth-row', 'synth-val',
  'synth-track-select', 'synth-subhead',
  'variations-box', 'variations-grid', 'variation', 'variation-canvas',
  'variation-meta', 'variations-info', 'variations-hint',
  'pattern-slots', 'slot-pad', 'song-strip', 'song-cell',
  'song-toggle', 'song-bars-select', 'pattern-hint',
  'rec-toggle', 'rec-timer',
];
const unstyled = CLASSES.filter(c => !css.includes(`.${c}`));
ok('every new UI class has CSS', unstyled.length === 0, unstyled.join(', '));

// ─── 9. Responsive breakpoints exist ───────────────────────────
const mediaQueries = [...css.matchAll(/@media\s*\(max-width:\s*(\d+)px\)/g)].map(m => +m[1]);
ok('at least 3 responsive breakpoints', mediaQueries.length >= 3, `got ${mediaQueries.length}`);
ok('the layout collapses for narrow screens', mediaQueries.some(w => w <= 1000));

// ─── 10. No leftover debug logging or TODO markers ──────────────
const allSrc = jsFiles.map(f => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')).join('\n');
ok('no console.log spam in the library modules',
   (allSrc.match(/console\.log\(/g) || []).length <= 3,
   `${(allSrc.match(/console\.log\(/g) || []).length} console.log calls`);
ok('no TODO/FIXME markers left', !/TODO|FIXME|XXX/.test(allSrc));

console.log('\n  MusicBox — DOM / wiring tests\n');
console.log(`  passed: ${passed}`);
console.log(`  failed: ${failed}`);
if (failures.length) {
  console.log('\n  FAILURES:');
  failures.forEach(f => console.log('   ✗ ' + f));
  process.exit(1);
}
console.log('\n  ✓ all green\n');
