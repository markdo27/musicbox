/**
 * tests/screenshot.mjs — Capture a screenshot of the running app.
 * Usage: node tests/screenshot.mjs [outfile.png] [width] [height]
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = process.argv[2] || path.join(ROOT, 'docs', 'screenshot.png');
const W = parseInt(process.argv[3] || '1600', 10);
const H = parseInt(process.argv[4] || '1000', 10);

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
];
const browser = CANDIDATES.find(p => { try { return fs.existsSync(p); } catch { return false; } });
if (!browser) { console.log('no browser'); process.exit(0); }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, rel === '/' ? '/index.html' : rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-shot-'));
const debugPort = 9800 + Math.floor(Math.random() * 150);
const chrome = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--force-device-scale-factor=1', '--window-size=' + W + ',' + H,
  `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

async function waitDevtools() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${debugPort}/json/version`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('devtools timeout');
}
await waitDevtools();

const tab = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/index.html`)}`, { method: 'PUT' })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise(res => {
  const i = ++id; pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});
await new Promise(r => ws.addEventListener('open', r, { once: true }));
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await new Promise(r => setTimeout(r, 3000));

// Optional: a JS expression to evaluate before the capture.
const script = process.argv[5];
if (script) {
  const res = await send('Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) {
    console.error('script failed:', JSON.stringify(res.exceptionDetails).slice(0, 300));
  }
  await new Promise(r => setTimeout(r, 900));
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log('wrote ' + OUT);
try { chrome.kill(); } catch {}
server.close();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
