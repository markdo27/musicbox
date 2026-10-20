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
