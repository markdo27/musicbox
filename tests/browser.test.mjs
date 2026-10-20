/**
 * tests/browser.test.mjs — Real headless-Chrome test over the DevTools protocol.
 *
 * Loads index.html in Chrome, captures console errors and uncaught
 * exceptions, and asserts that the app actually rendered the grid,
 * the generator panel, the mixer, the keyboard and the device list.
 *
 * Requires Chrome (or Edge). Skips gracefully if absent.
 *
 * Run:  node tests/browser.test.mjs
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) passed++;
  else { failed++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, a, b) {
  ok(name, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ─── Locate a browser ───────────────────────────────────────────
const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const browser = CANDIDATES.find(p => { try { return fs.existsSync(p); } catch { return false; } });
if (!browser) {
  console.log('\n  MusicBox — browser test\n  ⚠ no Chrome/Edge found — skipped\n');
  process.exit(0);
}

// ─── Serve the app over http (Web MIDI needs a secure context) ──
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const appUrl = `http://127.0.0.1:${port}/index.html`;

// ─── Launch Chrome with the DevTools protocol ───────────────────
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'musicbox-chrome-'));
const debugPort = 9500 + Math.floor(Math.random() * 400);
const chrome = spawn(browser, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--mute-audio',
  // Without this the AudioContext stays 'suspended' (no user gesture),
  // nothing renders, and the capture worklet never runs.
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let chromeErr = '';
chrome.stderr.on('data', d => { chromeErr += d.toString(); });

function cleanup() {
  try { chrome.kill(); } catch { /* ignore */ }
  try { server.close(); } catch { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.on('exit', cleanup);

// Wait for the DevTools endpoint.
async function waitForDevtools() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('DevTools endpoint never came up:\n' + chromeErr.slice(-800));
}

await waitForDevtools();

// Open a tab for the app.
const tabRes = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(appUrl)}`, { method: 'PUT' });
const tab = await tabRes.json();
const wsUrl = tab.webSocketDebuggerUrl;

if (typeof WebSocket === 'undefined') {
  console.log('\n  MusicBox — browser test\n  ⚠ no global WebSocket — skipped\n');
  cleanup();
  process.exit(0);
}

const ws = new WebSocket(wsUrl);
let msgId = 0;
const pending = new Map();
const consoleErrors = [];
const exceptions = [];
const logs = [];

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
    logs.push(`${msg.params.type}: ${text}`);
    if (msg.params.type === 'error') consoleErrors.push(text);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    exceptions.push(d.exception?.description || d.text || 'unknown exception');
  }
  if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry;
    logs.push(`${e.source}: ${e.text}`);
    if (e.level === 'error') consoleErrors.push(e.text);
  }
});

function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' timed out')); }
    }, 30000);
  });
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  }
  return res.result.value;
}

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

// Navigate to the app.
await send('Page.navigate', { url: appUrl });
await new Promise(r => setTimeout(r, 3500));   // let the app boot

// ─── Assertions ─────────────────────────────────────────────────
const q = (sel) => evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);

const stepButtons = await q('.step-btn');
ok('step grid rendered 128 buttons', stepButtons === 128, `got ${stepButtons}`);

const trackRows = await q('.track-row');
ok('8 track rows rendered', trackRows === 8, `got ${trackRows}`);

const genreOpts = await q('#gen-genre option');
ok('generator genre list populated', genreOpts >= 7, `got ${genreOpts}`);

const rootOpts = await q('#gen-root option');
ok('generator root list populated', rootOpts >= 14, `got ${rootOpts}`);

const scaleOpts = await q('#gen-scale option');
ok('generator scale list populated', scaleOpts >= 12, `got ${scaleOpts}`);

const genCells = await q('.gen-cell');
ok('generator preview rendered cells', genCells >= 16, `got ${genCells}`);

const deviceCards = await q('.device-card');
ok('MIDI device cards rendered', deviceCards >= 5, `got ${deviceCards}`);

const faders = await q('.mixer-fader');
ok('mixer rendered 8 faders', faders === 8, `got ${faders}`);

const keys = await q('.key');
ok('keyboard rendered 24 keys', keys === 24, `got ${keys}`);

const instrRows = await q('.instr-row');
ok('instrument panel rendered 8 rows', instrRows === 8, `got ${instrRows}`);

// ─── MIDI controller layer ──────────────────────────────────────
const clockOpts = await q('#clock-source option');
ok('clock source selector populated', clockOpts === 2, `got ${clockOpts}`);

const synthRows = await q('#synth-params .synth-row');
ok('synth parameter panel rendered 8 rows', synthRows === 8, `got ${synthRows}`);

const fxRows = await q('#fx-params .synth-row');
ok('insert FX panel rendered 6 rows', fxRows === 6, `got ${fxRows}`);

const learnBadges = await q('.learn-badge');
ok('MIDI Learn badges were injected', learnBadges >= 12, `got ${learnBadges}`);

// The synth panel must be bound to a track and reflect the engine state.
const synthState = await evaluate(`(() => {
  AudioEngine.setTrackParam(4, 'cutoff', 0.77);
  UI.syncSynthPanel();
  return {
    slider: document.getElementById('synth-cutoff').value,
    label: document.getElementById('synth-cutoff-val').textContent,
    param: AudioEngine.getTrackParams(4).cutoff,
  };
})()`);
eq('the synth slider follows the engine', synthState.slider, '77');
eq('the synth readout follows the engine', synthState.label, '77%');
ok('the engine holds the value', Math.abs(synthState.param - 0.77) < 1e-6);

// The per-track insert FX must be per track and clamped.
const fxState = await evaluate(`(() => {
  AudioEngine.setTrackFx(2, 'eqLow', -4.5);
  AudioEngine.setTrackFx(2, 'sendReverb', 0.6);
  AudioEngine.setTrackFx(2, 'eqHigh', 99);       // out of range
  AudioEngine.setTrackFx(2, 'drive', -3);        // out of range
  UI.setSynthTrackIdx(2);
  UI.syncSynthPanel();
  const other = AudioEngine.getTrackFx(3);
  return {
    low: AudioEngine.getTrackFx(2).eqLow,
    rev: AudioEngine.getTrackFx(2).sendReverb,
    high: AudioEngine.getTrackFx(2).eqHigh,
    drive: AudioEngine.getTrackFx(2).drive,
    otherLow: other.eqLow,
    slider: document.getElementById('fx-eq-low').value,
    label: document.getElementById('fx-eq-low-val').textContent,
  };
})()`);
ok('the FX value is stored', Math.abs(fxState.low + 4.5) < 1e-6);
ok('the FX value is clamped to ±12 dB', fxState.high === 12, `got ${fxState.high}`);
ok('the FX drive is clamped to 0..1', fxState.drive === 0, `got ${fxState.drive}`);
ok('FX is per track', fxState.otherLow === 0);
eq('the FX slider follows the engine', fxState.slider, '-4');
eq('the FX readout follows the engine', fxState.label, '-4.5dB');

// MIDI Learn: learn a CC and check the control follows.
const learnState = await evaluate(`(() => {
  const el = document.getElementById('master-vol');
  MidiLearn.beginLearn(el);
  const armed = MidiLearn.isLearning();
  const consumed = MidiLearn.handleCC(1, 7, 100);
  return {
    armed,
    consumed,
    learning: MidiLearn.isLearning(),
    value: el.value,
    mapped: MidiLearn.getMap()['master-vol'],
  };
})()`);
ok('learn mode arms', learnState.armed === true);
ok('the learning CC is consumed', learnState.consumed === true);
ok('learn mode ends after the CC', learnState.learning === false);
// CC 100 of 127 across a 0..100 range = 79.
eq('the learned control follows the CC', learnState.value, '79');
ok('the mapping records the CC', learnState.mapped && learnState.mapped.cc === 7);
eq('the mapping records the channel', learnState.mapped.ch, 1);

// The badge should now show the CC number.
const badgeText = await evaluate(
  `document.querySelector('#master-vol').parentNode.querySelector('.learn-badge').textContent`);
ok('the badge shows the mapped CC', badgeText === 'CC7', `got "${badgeText}"`);

// Clean up the mapping so the test is repeatable.
await evaluate(`MidiLearn.unbind(document.getElementById('master-vol'))`);

// The clock source must switch.
const clockSwitch = await evaluate(`(() => {
  const sel = document.getElementById('clock-source');
  sel.value = 'external';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  const ext = {
    seq: Sequencer.getClockSource(),
    midi: MidiManager.getClockSource(),
  };
  sel.value = 'internal';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return { ext, back: Sequencer.getClockSource() };
})()`);
eq('the sequencer follows the clock source', clockSwitch.ext.seq, 'external');
eq('the MIDI layer follows the clock source', clockSwitch.ext.midi, 'external');
eq('the clock source switches back', clockSwitch.back, 'internal');

// ─── 16 Variations picker ───────────────────────────────────────
const variations = await evaluate(`(() => {
  document.getElementById('gen-variations').click();
  const modal = document.getElementById('modal-variations');
  const cells = document.querySelectorAll('#variations-grid .variation');
  const canvases = document.querySelectorAll('#variations-grid .variation-canvas');
  const open = !modal.hidden;

  // Apply the third candidate and check the sequencer changed.
  const before = JSON.stringify(Sequencer.getTracks().map(t => t.steps));
  document.querySelectorAll('#variations-grid .variation')[2].click();
  const after = JSON.stringify(Sequencer.getTracks().map(t => t.steps));
  const closed = modal.hidden;
  const seed = document.getElementById('gen-seed').value;

  return { open, count: cells.length, canvases: canvases.length,
           changed: before !== after, closed, seed };
})()`);
ok('the variations modal opens', variations.open === true);
eq('16 variations are shown', variations.count, 16);
eq('each variation has a canvas thumbnail', variations.canvases, 16);
ok('applying a variation changes the pattern', variations.changed === true);
ok('applying a variation closes the modal', variations.closed === true);
ok('the applied variation records its seed', /#/.test(variations.seed), `seed "${variations.seed}"`);

// ─── WAV recording ──────────────────────────────────────────────
const rec = await evaluate(`(async () => {
  AudioEngine.init();
  const ctx = AudioEngine.getContext();
  await ctx.resume();
  const started = await AudioEngine.startRecording();
  if (!started) return { started: false };
  // Play a note so the capture has signal in it.
  AudioEngine.triggerNote(0, 10, 60, 110, 0.2, false, false,
                           AudioEngine.getContext().currentTime + 0.05);
  await new Promise(r => setTimeout(r, 600));
  const blob = AudioEngine.stopRecording();
  if (!blob) return { started: true, blob: false };
  const buf = new Uint8Array(await blob.arrayBuffer());
  const h = (i) => String.fromCharCode(buf[i]);
  return {
    started: true,
    blob: true,
    size: buf.length,
    riff: h(0) + h(1) + h(2) + h(3),
    wave: h(8) + h(9) + h(10) + h(11),
    fmt: h(12) + h(13) + h(14) + h(15),
    channels: buf[22] | (buf[23] << 8),
    rate: buf[24] | (buf[25] << 8) | (buf[26] << 16) | (buf[27] << 24),
    bits: buf[34] | (buf[35] << 8),
    dataSize: buf[40] | (buf[41] << 8) | (buf[42] << 16) | (buf[43] << 24),
    type: blob.type,
  };
})()`);
ok('the capture worklet starts', rec.started === true);
ok('a WAV blob was produced', rec.blob === true);
eq('the file is a RIFF container', rec.riff, 'RIFF');
eq('the container holds a WAVE', rec.wave, 'WAVE');
eq('the chunk is a fmt chunk', rec.fmt, 'fmt ');
eq('the WAV is 16-bit', rec.bits, 16);
eq('the WAV is stereo', rec.channels, 2);
ok('the sample rate is sensible', rec.rate >= 22050 && rec.rate <= 192000, `${rec.rate}`);
ok('the data chunk is non-empty', rec.dataSize > 0, `${rec.dataSize}`);
ok('the file size matches the header', rec.size === 44 + rec.dataSize,
  `size ${rec.size}, header says ${rec.dataSize}`);
eq('the blob type is audio/wav', rec.type, 'audio/wav');

// The record button must reflect the state.
const recBtn = await evaluate(`(() => {
  const b = document.getElementById('btn-audio-rec');
  return { exists: !!b, title: b ? b.title : '' };
})()`);
ok('the record button exists', recBtn.exists === true);
ok('the record button is labelled', /WAV/i.test(recBtn.title));

// ─── Pattern bank + song arranger ──────────────────────────────
const bankUI = await evaluate(`(() => {
  const pads = document.querySelectorAll('#pattern-slots .slot-pad');
  const cells = document.querySelectorAll('#song-strip .song-cell');
  return { pads: pads.length, cells: cells.length };
})()`);
eq('the pattern bank shows 8 slots', bankUI.pads, 8);
eq('the song strip shows 16 bars', bankUI.cells, 16);

const songUI = await evaluate(`(() => {
  // Save the current pattern into slot A, make slot B different.
  Sequencer.saveToSlot(0);
  Sequencer.toggleStep(0, 0);
  Sequencer.saveToSlot(1);
  Sequencer.toggleStep(0, 0);

  // Turn song mode on and put slot A on bar 0, slot B on bar 1.
  const toggle = document.getElementById('song-enabled');
  toggle.checked = true;
  toggle.dispatchEvent(new Event('change', { bubbles: true }));
  Sequencer.setArrangementBar(0, 0);
  Sequencer.setArrangementBar(1, 1);
  UI.renderSong();

  const a = Sequencer.getActiveTracks(0)[0].steps[0].active;
  const b = Sequencer.getActiveTracks(16)[0].steps[0].active;
  const cellText = Array.from(document.querySelectorAll('#song-strip .song-cell'))
    .map(c => c.textContent).join('');

  // Resize the arrangement.
  const bars = document.getElementById('song-bars');
  bars.value = '32';
  bars.dispatchEvent(new Event('change', { bubbles: true }));
  const cells32 = document.querySelectorAll('#song-strip .song-cell').length;

  // Back off.
  toggle.checked = false;
  toggle.dispatchEvent(new Event('change', { bubbles: true }));

  return { a, b, cellText, cells32, enabled: Sequencer.getSong().enabled };
})()`);
ok('bar 0 and bar 1 play different slots', songUI.a !== songUI.b);
ok('the strip shows the slot letters', /A/.test(songUI.cellText) && /B/.test(songUI.cellText));
eq('the arrangement resizes to 32 bars', songUI.cells32, 32);
ok('song mode can be turned off', songUI.enabled === false);

// Clicking a slot in the bank switches the edit buffer.
const slotClick = await evaluate(`(() => {
  const before = JSON.stringify(Sequencer.getTracks().map(t => t.steps));
  document.querySelectorAll('#pattern-slots .slot-pad')[1].click();
  const after = JSON.stringify(Sequencer.getTracks().map(t => t.steps));
  return { changed: before !== after, active: Sequencer.getBank().activeSlot };
})()`);
eq('clicking a slot selects it', slotClick.active, 1);
ok('clicking a slot loads its pattern', slotClick.changed === true);

// Arrow keys move the selection in the variations picker.
const arrowNav = await evaluate(`(() => {
  document.getElementById('gen-variations').click();
  const sel = () => Array.from(document.querySelectorAll('#variations-grid .variation'))
    .findIndex(e => e.classList.contains('selected'));
  const start = sel();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  const moved = sel();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  const back = sel();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
  return { start, moved, back, closed: document.getElementById('modal-variations').hidden };
})()`);
eq('the first variation starts selected', arrowNav.start, 0);
eq('the right arrow moves the selection', arrowNav.moved, 1);
eq('the left arrow moves it back', arrowNav.back, 0);
ok('Escape closes the picker without stopping', arrowNav.closed === true);

// The app must have booted.
const booted = await evaluate('typeof window.Sequencer !== "undefined" && typeof window.Generator !== "undefined" && typeof window.UI !== "undefined"');
ok('all modules exposed on window', booted === true);

// The generator must have produced an actual pattern in the sequencer.
const activeSteps = await evaluate(
  'Sequencer.getTracks().reduce((n,t) => n + t.steps.filter(s=>s.active).length, 0)');
ok('generator produced active steps', activeSteps > 0, `got ${activeSteps}`);

// Stepping a step must work and must be undoable.
const toggled = await evaluate(`(() => {
  const before = Sequencer.getStep(0,0).active;
  Sequencer.toggleStep(0, 0);
  const after = Sequencer.getStep(0,0).active;
  const canUndo = Sequencer.canUndo();
  Sequencer.undo();
  const restored = Sequencer.getStep(0,0).active;
  return { before, after, canUndo, restored };
})()`);
ok('step toggle flips the step', toggled.after === !toggled.before,
  `before=${toggled.before} after=${toggled.after}`);
ok('step toggle is undoable', toggled.canUndo === true);
ok('undo restores the step', toggled.restored === toggled.before,
  `before=${toggled.before} restored=${toggled.restored}`);

// The generator must be deterministic through the UI path.
const deterministic = await evaluate(`(() => {
  const p = Generator.normaliseParams({ genre:'techno', seed:'BROWSER-1' });
  const a = JSON.stringify(Generator.generate(p).tracks.map(t=>t.steps));
  const b = JSON.stringify(Generator.generate(p).tracks.map(t=>t.steps));
  return a === b;
})()`);
ok('generation is deterministic in the browser', deterministic === true);

// Play must not throw.
const playResult = await evaluate(`(() => {
  try { AudioEngine.init(); Sequencer.play(); Sequencer.stop(); return 'ok'; }
  catch (e) { return String(e); }
})()`);
ok('transport starts and stops without throwing', playResult === 'ok', playResult);

// No uncaught exceptions.
ok('no uncaught exceptions', exceptions.length === 0, exceptions.slice(0, 3).join(' | '));

// No console errors (the offline sample DB is a warning, not an error).
const realErrors = consoleErrors.filter(e => !/strudel|Dirt-Samples|Failed to load|SamplerEngine|net::ERR/i.test(e));
ok('no console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

// The boot banner.
ok('app.js reached the end of initialisation',
  logs.some(l => l.includes('MusicBox v2 initialized')), 'boot banner not found');

cleanup();

console.log('\n  MusicBox — headless browser test\n');
console.log(`  browser: ${browser}`);
console.log(`  passed: ${passed}`);
console.log(`  failed: ${failed}`);
if (failures.length) {
  console.log('\n  FAILURES:');
  failures.forEach(f => console.log('   ✗ ' + f));
  process.exit(1);
}
console.log('\n  ✓ all green\n');
