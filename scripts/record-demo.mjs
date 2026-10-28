// Records the gym's demo mode (?demo) to an MP4, with a hidden browser window.
// Nothing on your screen is captured: Edge runs headless in its own temporary profile, and its frames are
// saved straight from the page (Chrome DevTools "screencast"), then FFmpeg encodes them.
//
//   tools\node\node.exe scripts\record-demo.mjs [seconds] [url] [output.mp4]
//
// Needs FFmpeg at tools\ffmpeg\bin\ffmpeg.exe (or on PATH) and Microsoft Edge or Chrome installed.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const seconds = Number(process.argv[2]) || 45;
const url = process.argv[3] || 'https://gradient-gym.gradient-gym.workers.dev/?demo';
const out = resolve(process.argv[4] || join(root, 'recordings', 'gradient-gym-demo.mp4'));
const music = process.argv[5] ? resolve(process.argv[5]) : null; // optional background track (e.g. from make-music.mjs)
const FPS = 60;
const CSS_W = 960, CSS_H = 540, DSF = 2; // 1920x1080 frames; pixel art stays crisp at an integer scale

const browser = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find(existsSync);
const ffmpeg = [join(root, 'tools/ffmpeg/bin/ffmpeg.exe')].find(existsSync) || 'ffmpeg';
if (!browser) throw new Error('Install Microsoft Edge or Chrome to record.');
if (ffmpeg !== 'ffmpeg' || spawnSync('ffmpeg', ['-version']).status === 0) {} else throw new Error('FFmpeg not found (tools\\ffmpeg\\bin\\ffmpeg.exe).');

const work = mkdtempSync(join(tmpdir(), 'gym-rec-'));
const frames = join(work, 'frames');
mkdirSync(frames);
mkdirSync(dirname(out), { recursive: true });
const port = 9300 + Math.floor(Math.random() * 500);

const proc = spawn(browser, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(work, 'profile')}`,
  // A real 2x display scale (not emulation), so the page is drawn with 2x2 device pixels per CSS pixel.
  // A headless window also loses ~24x126 px to its frame.
  `--force-device-scale-factor=${DSF}`, `--window-size=${CSS_W + 24},${CSS_H + 126}`, '--hide-scrollbars', '--mute-audio', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank',
], { stdio: 'ignore' });
const cleanup = () => {
  try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
};
process.on('exit', cleanup);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pageSocket() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('The browser did not start.');
}

const ws = new WebSocket(await pageSocket());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('DevTools connection failed')); });
let nextId = 1;
const pending = new Map();
const shots = []; // { file, t }
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
  } else if (msg.method === 'Page.screencastFrame') {
    const file = join(frames, `f${String(shots.length).padStart(6, '0')}.jpg`);
    writeFileSync(file, Buffer.from(msg.params.data, 'base64'));
    if (!shots.length) console.log('First frame metadata:', JSON.stringify(msg.params.metadata));
    shots.push({ file, t: msg.params.metadata.timestamp });
    send('Page.screencastFrameAck', { sessionId: msg.params.sessionId }).catch(() => {});
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = nextId++;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});

try {
  await send('Page.enable');
  // Size the window until the page's viewport is exactly CSS_W x CSS_H (the frame around it varies by browser version).
  const { windowId } = await send('Browser.getWindowForTarget');
  for (let i = 0; i < 3; i++) {
    const { bounds } = await send('Browser.getWindowForTarget');
    const v = JSON.parse((await send('Runtime.evaluate', { expression: 'JSON.stringify([innerWidth, innerHeight])', returnByValue: true })).result.value);
    if (v[0] === CSS_W && v[1] === CSS_H) break;
    await send('Browser.setWindowBounds', { windowId, bounds: { width: bounds.width + CSS_W - v[0], height: bounds.height + CSS_H - v[1] } });
    await sleep(400);
  }
  await send('Page.navigate', { url });
  console.log(`Loading ${url} ...`);
  await sleep(9000); // let the gym load and the first demo events and the camera get going
  const vp = await send('Runtime.evaluate', { expression: 'JSON.stringify([innerWidth, innerHeight, devicePixelRatio])', returnByValue: true });
  console.log('Viewport (css width, css height, pixel ratio):', vp.result.value);
  await send('Runtime.evaluate', { expression: 'window.Gym && Gym.demoRestart && Gym.demoRestart()' }); // the tour starts now
  console.log(`Recording ${seconds} s ...`);
  const t0 = Date.now();
  await send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: CSS_W * DSF, maxHeight: CSS_H * DSF, everyNthFrame: 1 });
  while (Date.now() - t0 < seconds * 1000) await sleep(250);
  await send('Page.stopScreencast');
} finally {
  ws.close();
  cleanup();
}

if (shots.length < 10) throw new Error(`Only ${shots.length} frames were captured.`);
const span = shots[shots.length - 1].t - shots[0].t;
console.log(`Captured ${shots.length} frames over ${span.toFixed(1)} s (${(shots.length / span).toFixed(1)} per second). Encoding ...`);

// Each frame is held until the next one arrived, so timing matches what the page really did.
const list = shots.map((s, i) => `file '${s.file.replaceAll('\\', '/')}'\nduration ${Math.max(0.001, (shots[i + 1]?.t ?? s.t + 1 / FPS) - s.t).toFixed(6)}`);
list.push(`file '${shots[shots.length - 1].file.replaceAll('\\', '/')}'`);
const listFile = join(work, 'frames.txt');
writeFileSync(listFile, list.join('\n'));
const audio = music
  ? ['-i', music, '-af', `afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, span - 2.5).toFixed(2)}:d=2.5`, '-c:a', 'aac', '-b:a', '192k', '-shortest']
  : [];
const enc = spawnSync(ffmpeg, [
  '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, ...audio,
  '-vf', `fps=${FPS},scale=1920:1080:flags=neighbor:in_range=pc:out_range=tv,format=yuv420p`,
  '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-movflags', '+faststart', out,
], { stdio: 'inherit' });
rmSync(work, { recursive: true, force: true });
if (enc.status !== 0) throw new Error('FFmpeg failed.');
console.log(`Saved ${out}`);
