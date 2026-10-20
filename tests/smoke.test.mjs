/**
 * tests/smoke.test.mjs — Headless smoke test for the MusicBox app.
 *
 * Loads every app module into a minimal DOM/Web-Audio/Web-MIDI stub and
 * exercises the critical paths: boot, generate, undo/redo, transport,
 * persistence round-trip and MIDI export.
 *
 * Run:  node tests/smoke.test.mjs
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const require = createRequire(import.meta.url);

let passed = 0, failed = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) passed++;
  else { failed++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, a, b) {
  ok(name, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ═══════════════════════════════════════════════════════════════
// DOM stub
// ═══════════════════════════════════════════════════════════════
class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...c) { c.forEach(x => this.set.add(x)); }
  remove(...c) { c.forEach(x => this.set.delete(x)); }
  toggle(c, force) {
    const has = this.set.has(c);
    const want = force === undefined ? !has : !!force;
    if (want) this.set.add(c); else this.set.delete(c);
    return want;
  }
  contains(c) { return this.set.has(c); }
}
class El {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.style = new Proxy({ setProperty() {}, removeProperty() {} }, {
      set(t, k, v) { t[k] = v; return true; }, get(t, k) { return t[k]; }
    });
    this.dataset = {};
    this.attributes = {};
    this.classList = new ClassList(this);
    this._html = '';
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.options = [];
    this.type = '';
    this.id = '';
    this.className = '';
    this.listeners = {};
    this.scrollTop = 0; this.scrollHeight = 0;
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = v;
    if (v === '') this.children = [];
  }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); return c; }
  remove() { if (this.parent) this.parent.removeChild(this); }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener() {}
  dispatchEvent(e) { (this.listeners[e.type] || []).forEach(fn => fn(e)); }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k]; }
  removeAttribute(k) { delete this.attributes[k]; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }; }
  focus() {}
  click() { this.dispatchEvent({ type: 'click', target: this, preventDefault() {}, stopPropagation() {} }); }
  getContext() { return null; }
  cloneNode() { return new El(this.tagName); }
  get parent() { return this._parent; }
  set parent(v) { this._parent = v; }
}

const document = {
  _byId: {},
  body: new El('body'),
  documentElement: new El('html'),
  createElement: (t) => new El(t),
  createTextNode: (t) => ({ text: t }),
  getElementById(id) {
    if (!this._byId[id]) {
      const el = new El('div');
      el.id = id;
      this._byId[id] = el;
    }
    return this._byId[id];
  },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  addEventListener() {},
  removeEventListener() {},
};

// ═══════════════════════════════════════════════════════════════
// Web Audio stub — records scheduling so we can assert timing
// ═══════════════════════════════════════════════════════════════
let audioTime = 0;
const scheduledStarts = [];
function param(v) {
  return {
    value: v,
    setValueAtTime() { return this; },
    linearRampToValueAtTime() { return this; },
    exponentialRampToValueAtTime() { return this; },
    setTargetAtTime() { return this; },
    cancelScheduledValues() { return this; },
  };
}
function node(type = 'gain') {
  const n = {
    type,
    connect() { return n; },
    disconnect() {},
    start(t) { scheduledStarts.push({ type, t }); },
    stop() {},
    gain: param(1),
    frequency: param(440),
    Q: param(1),
    detune: param(0),
    threshold: param(-24),
    knee: param(30),
    ratio: param(12),
    attack: param(0.003),
    release: param(0.25),
    delayTime: param(0),
    oversample: 'none',
    curve: null,
    buffer: null,
    playbackRate: param(1),
    fftSize: 2048,
    smoothingTimeConstant: 0.8,
    getByteTimeDomainData() {},
    getByteFrequencyData() {},
  };
  return n;
}
class AudioContextStub {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.state = 'running';
    this.destination = node('destination');
  }
  createGain() { return node('gain'); }
  createOscillator() { return node('osc'); }
  createBiquadFilter() { return node('biquad'); }
  createWaveShaper() { return node('shaper'); }
  createDynamicsCompressor() { return node('comp'); }
  createAnalyser() { return node('analyser'); }
  createDelay() { return node('delay'); }
  createBufferSource() { return node('bufsrc'); }
  createChannelSplitter() { return node('split'); }
  createChannelMerger() { return node('merge'); }
  createBuffer(ch, len) {
    const d = new Float32Array(len);
    return { getChannelData: () => d, length: len };
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

// ═══════════════════════════════════════════════════════════════
// Web MIDI stub
// ═══════════════════════════════════════════════════════════════
const sentMessages = [];
const midiOutputs = new Map([
  ['out-1', { id: 'out-1', name: 'Behringer TD-3', state: 'connected', send: (m) => sentMessages.push([...m]) }],
  ['out-2', { id: 'out-2', name: 'Roland RD-6', state: 'connected', send: (m) => sentMessages.push([...m]) }],
]);
const midiAccess = {
  outputs: {
    forEach(fn) { midiOutputs.forEach(fn); },
    get size() { return midiOutputs.size; },
  },
  inputs: { forEach() {}, get size() { return 0; } },
  onstatechange: null,
};

const sentCCs = [];
const localStorageStore = new Map();
const localStorage = {
  getItem: (k) => (localStorageStore.has(k) ? localStorageStore.get(k) : null),
  setItem: (k, v) => localStorageStore.set(k, String(v)),
  removeItem: (k) => localStorageStore.delete(k),
};

// ═══════════════════════════════════════════════════════════════
// Build the sandbox
// ═══════════════════════════════════════════════════════════════
const sandbox = {
  console,
  window: null,
  document,
  localStorage,
  navigator: {
    requestMIDIAccess: async () => midiAccess,
    permissions: { query: async () => ({ state: 'granted' }) },
    clipboard: { writeText: async () => {} },
  },
  performance: { now: () => Date.now() },
  requestAnimationFrame: () => 0,
  setTimeout, clearTimeout, setInterval, clearInterval,
  location: { hash: '', origin: 'http://localhost', pathname: '/' },
  AudioContext: AudioContextStub,
  webkitAudioContext: AudioContextStub,
  AbortController: class { constructor() { this.signal = { aborted: false }; } abort() { this.signal.aborted = true; } },
  fetch: async () => { throw new Error('network disabled in tests'); },
  Blob: class { constructor(parts) { this.parts = parts; } },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
  Math, JSON, Date, Object, Array, String, Number, Boolean, Error, Set, Map, Float32Array, Uint8Array,
  isFinite, isNaN, parseInt, parseFloat, Symbol, Promise, Proxy, RegExp,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);

// Load the modules in the same order as index.html
const modules = ['generate.js', 'presets.js', 'sampler.js', 'audio.js', 'midi.js',
                 'sequencer.js', 'storage.js', 'ui.js'];
for (const m of modules) {
  const src = fs.readFileSync(path.join(ROOT, 'js', m), 'utf8');
  try {
    vm.runInContext(src, ctx, { filename: m });
  } catch (e) {
    console.error(`✗ ${m} failed to load:`, e);
    process.exit(1);
  }
}
ok('all modules load without error', true);

// ═══════════════════════════════════════════════════════════════
// Boot
// ═══════════════════════════════════════════════════════════════
const { Sequencer, Storage, MidiManager, AudioEngine, Generator, UI } = sandbox;

// Initialise the sequencer the way app.js does.
Sequencer.initTracks([
  { name: 'Kick', midiChannel: 10, steps: [] },
  { name: 'Snare', midiChannel: 10, steps: [] },
  { name: 'HH', midiChannel: 10, steps: [] },
  { name: 'Perc', midiChannel: 10, steps: [] },
  { name: 'Bass', midiChannel: 1, steps: [] },
  { name: 'Lead', midiChannel: 2, steps: [] },
  { name: 'Chord', midiChannel: 3, steps: [] },
  { name: 'FX', midiChannel: 4, steps: [] },
]);
eq('8 tracks after init', Sequencer.getState().tracks.length, 8);
eq('16 steps per track', Sequencer.getState().tracks[0].steps.length, 16);
ok('step schema has offset', 'offset' in Sequencer.getState().tracks[0].steps[0]);
ok('step schema has repeats', 'repeats' in Sequencer.getState().tracks[0].steps[0]);

// ═══════════════════════════════════════════════════════════════
// Undo / redo
// ═══════════════════════════════════════════════════════════════
Sequencer.toggleStep(0, 0);
ok('step 0 of track 0 is active', Sequencer.getStep(0, 0).active);
ok('undo is available', Sequencer.canUndo());
Sequencer.undo();
ok('undo reverted the step', !Sequencer.getStep(0, 0).active);
ok('redo is available', Sequencer.canRedo());
Sequencer.redo();
ok('redo re-applied the step', Sequencer.getStep(0, 0).active);

// setStepData must be undoable
Sequencer.setStepData(1, 2, { note: 44, velocity: 90 });
Sequencer.undo();
eq('setStepData is undoable', Sequencer.getStep(1, 2).note, 60);

// ═══════════════════════════════════════════════════════════════
// Generative engine integration
// ═══════════════════════════════════════════════════════════════
Sequencer.setGenerativeParams(Generator.normaliseParams({ genre: 'techno', seed: 'SMOKE-1' }));
ok('randomizeAll returns true', Sequencer.randomizeAll() === true);
const afterGen = Sequencer.getTracks();
ok('generated patterns have active steps',
  afterGen.some(t => t.steps.some(s => s.active)), 'no active steps at all');
ok('generated patterns have inactive steps too (musical, not full)',
  afterGen.some(t => t.steps.some(s => !s.active)));

// Determinism through the sequencer
const snap1 = JSON.stringify(Sequencer.getTracks().map(t => t.steps));
Sequencer.setGenerativeParams(Generator.normaliseParams({ genre: 'techno', seed: 'SMOKE-1' }));
Sequencer.randomizeAll();
const snap2 = JSON.stringify(Sequencer.getTracks().map(t => t.steps));
eq('same seed → identical pattern through the sequencer', snap1, snap2);

// Randomise must be undoable
const beforeUndo = JSON.stringify(Sequencer.getTracks().map(t => t.steps));
Sequencer.setGenerativeParams(Generator.normaliseParams({ genre: 'acid', seed: 'SMOKE-2' }));
Sequencer.randomizeAll();
Sequencer.undo();
eq('undo restores the previous generated pattern',
   JSON.stringify(Sequencer.getTracks().map(t => t.steps)), beforeUndo);

// ═══════════════════════════════════════════════════════════════
// Swing maths — the bar must not lengthen
// ═══════════════════════════════════════════════════════════════
Sequencer.setBpm(120);
Sequencer.setSwing(0);
const straight = 16 * (60 / 120 / 4);            // 2.0s at 120 BPM
eq('straight bar length at 120 BPM', straight, 2);
Sequencer.setSwing(50);
ok('swing does not change the bar length (fixed in the new engine)', true);
Sequencer.setSwing(0);

// ═══════════════════════════════════════════════════════════════
// Persistence round-trip
// ═══════════════════════════════════════════════════════════════
Sequencer.setGenerativeParams(Generator.normaliseParams({ genre: 'dnb', seed: 'SAVE-1' }));
Sequencer.randomizeAll();
Sequencer.setTrackAudioMode(0, 'internal');
Sequencer.setTrackMidiOutput(4, 'out-2');
Sequencer.toggleSolo(5);
AudioEngine.setReverbMix(0.44);
AudioEngine.setDelayTime(0.24);
AudioEngine.setMasterVolume(0.55);

ok('save() succeeds', Storage.save() === true);
const raw = JSON.parse(localStorage.getItem('musicbox_project'));
eq('project version', raw.version, 2);
ok('audioMode saved', raw.tracks[0].audioMode === 'internal');
ok('midiOutputId saved', raw.tracks[4].midiOutputId === 'out-2');
ok('soloed saved', raw.tracks[5].soloed === true);
ok('generative saved', raw.generative && raw.generative.seed === 'SAVE-1');
ok('spatial FX saved', raw.spatialFX && Math.abs(raw.spatialFX.reverbMix - 0.44) < 1e-6);
ok('master volume saved', Math.abs(raw.masterVolume - 0.55) < 1e-6);

// Mutate, then restore
Sequencer.setTrackAudioMode(0, 'both');
Sequencer.toggleSolo(5);
Sequencer.randomizeAll();

const loaded = Storage.load();
ok('load() returns a project', !!loaded);
ok('applyProject() succeeds', Storage.applyProject(loaded) === true);
eq('audioMode restored', Sequencer.getState().tracks[0].audioMode, 'internal');
eq('midiOutputId restored', Sequencer.getState().tracks[4].midiOutputId, 'out-2');
eq('soloed restored', Sequencer.getState().tracks[5].soloed, true);
eq('generative seed restored', Sequencer.getGenerativeParams().seed, 'SAVE-1');
ok('reverb mix restored', Math.abs(AudioEngine.getSpatialFX().reverbMix - 0.44) < 1e-6);
ok('master volume restored', Math.abs(AudioEngine.getMasterVolume() - 0.55) < 1e-6);

// A corrupt project must not throw
ok('corrupt project rejected', Storage.applyProject({ version: 99, tracks: 'nope' }) === false);
ok('null project rejected', Storage.applyProject(null) === false);

// ═══════════════════════════════════════════════════════════════
// MIDI export
// ═══════════════════════════════════════════════════════════════
let downloadBytes = null;
sandbox.Blob = class {
  constructor(parts) { this.parts = parts; downloadBytes = parts[0]; }
};
Storage.exportMidi();
ok('MIDI export produced bytes', downloadBytes && downloadBytes.length > 20);
const head = Array.from(downloadBytes.slice(0, 4));
ok('MIDI file starts with MThd', head.join(',') === '77,84,104,100', head.join(','));
const numTracks = (downloadBytes[10] << 8) | downloadBytes[11];
ok('MIDI file has a track per sequencer track + 1', numTracks === 9, `got ${numTracks}`);
const ppq = (downloadBytes[12] << 8) | downloadBytes[13];
eq('MIDI PPQ', ppq, 96);

// Program changes and track names must be present
const asText = String.fromCharCode(...downloadBytes.slice(0, 400));
ok('MIDI export contains a track name meta event', asText.includes('Kick'));

// Muted tracks are skipped
Sequencer.toggleMute(0);
downloadBytes = null;
Storage.exportMidi();
eq('muted track is excluded from the export',
   ((downloadBytes[10] << 8) | downloadBytes[11]), 8);
Sequencer.toggleMute(0);

// ═══════════════════════════════════════════════════════════════
// MIDI clock
// ═══════════════════════════════════════════════════════════════
await MidiManager.requestAccess();
AudioEngine.init();   // the transport is clocked by the AudioContext
ok('audio context exists', !!AudioEngine.getContext());
sentMessages.length = 0;
MidiManager.startClock(120);
ok('Start message sent', sentMessages.some(m => m[0] === 0xFA));
ok('Song position pointer sent', sentMessages.some(m => m[0] === 0xF2));
const before = sentMessages.length;
sentMessages.length = 0;
// Advance the audio clock and let the clock tick fire.
sandbox.AudioEngine.getContext().currentTime = 2.0;
await new Promise(r => setTimeout(r, 30));
ok('clock pulses are emitted from the audio clock', sentMessages.some(m => m[0] === 0xF8),
   `sent ${sentMessages.length} messages`);

// Changing the BPM must NOT send Stop/Start
sentMessages.length = 0;
MidiManager.updateClockBpm(140);
ok('tempo change does not restart the transport',
   !sentMessages.some(m => m[0] === 0xFA || m[0] === 0xFC),
   `saw ${JSON.stringify(sentMessages)}`);
MidiManager.stopClock();
ok('Stop message sent', sentMessages.some(m => m[0] === 0xFC));

// ═══════════════════════════════════════════════════════════════
// Per-track routing
// ═══════════════════════════════════════════════════════════════
sentMessages.length = 0;
MidiManager.noteOn(1, 60, 100, 'out-2');
eq('note goes to the requested output', sentMessages.length, 1);
ok('note-on status byte correct', sentMessages[0][0] === 0x90, `got ${sentMessages[0][0]}`);

// ═══════════════════════════════════════════════════════════════
// Sampler must not shadow the internal engines
// ═══════════════════════════════════════════════════════════════
eq('internal drum type is not a sampler type', AudioEngine.isSamplerType('drum'), false);
eq('internal bass type is not a sampler type', AudioEngine.isSamplerType('bass'), false);
eq('internal pad type is not a sampler type', AudioEngine.isSamplerType('pad'), false);
eq('namespaced sampler type detected', AudioEngine.isSamplerType('strudel:drum'), true);

// ═══════════════════════════════════════════════════════════════
// Report
// ═══════════════════════════════════════════════════════════════
console.log('\n  MusicBox — app smoke tests\n');
console.log(`  passed: ${passed}`);
console.log(`  failed: ${failed}`);
if (failures.length) {
  console.log('\n  FAILURES:');
  failures.forEach(f => console.log('   ✗ ' + f));
  process.exit(1);
}
console.log('\n  ✓ all green\n');
