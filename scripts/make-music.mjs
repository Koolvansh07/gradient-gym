// Writes an original chiptune track (square-wave arpeggio and lead, triangle bass, drums) as a WAV file.
// Made from scratch in code, so there is nothing to license. Used as background music for the demo video.
//
//   tools\node\node.exe scripts\make-music.mjs [output.wav] [seconds]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const out = resolve(process.argv[2] || 'recordings/gym-theme.wav');
const wanted = Number(process.argv[3]) || 64;
const SR = 44100, BPM = 132, beat = 60 / BPM, bar = beat * 4;
const bars = Math.ceil(wanted / bar);
const total = Math.ceil(bars * bar * SR);
const mix = new Float32Array(total);

const add = (t0, dur, fn, gain) => {
  const s = Math.floor(t0 * SR), n = Math.floor(dur * SR);
  for (let i = 0; i < n && s + i < total; i++) mix[s + i] += fn(i / SR, i / n) * gain;
};
const pulse = (f, duty) => (t) => ((t * f) % 1 < duty ? 1 : -1);
const tri = (f) => (t) => 4 * Math.abs(((t * f) % 1) - 0.5) - 1;
const hz = (root, semis) => root * 2 ** (semis / 12);
let seed = 7;
const noise = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 31) - 1;

// A minor, F, C, G. Roots in the bass octave; the arpeggio and lead sit above.
const ROOTS = [110, 87.31, 130.81, 98];
const CHORDS = [[0, 3, 7, 12], [0, 4, 7, 12], [0, 4, 7, 12], [0, 4, 7, 12]];
const ARP = [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 2, 3, 2, 1];
const PENT = [0, 3, 5, 7, 10, 12, 15, 17]; // A minor pentatonic above A4
const LEAD = [ // one list per bar of a 4-bar phrase: scale steps (-1 = rest), eighth notes
  [4, -1, 3, 4, 5, -1, 4, 3],
  [2, 3, -1, 2, 3, 4, -1, 2],
  [4, 5, 6, -1, 5, 4, -1, 3],
  [5, -1, 4, 3, 2, -1, 3, -1],
];

for (let b = 0; b < bars; b++) {
  const t = b * bar, c = b % 4, root = ROOTS[c];
  const intro = b < 4, brk = b >= 16 && b < 20;
  // arpeggio, 16th notes
  for (let s = 0; s < 16; s++) {
    const f = hz(root * 4, CHORDS[c][ARP[s]]);
    add(t + s * beat / 4, beat / 4, (x, p) => pulse(f, 0.125)(x) * (1 - p) ** 1.4, intro ? 0.07 : 0.05);
  }
  if (!intro) {
    // bass: eighth notes, octave jump on the offbeats
    for (let s = 0; s < 8; s++) {
      const f = s % 2 ? root * 2 : root;
      add(t + s * beat / 2, beat / 2 * 0.9, (x, p) => tri(f)(x) * (1 - p * 0.6), 0.28);
    }
    // lead melody
    for (let s = 0; s < 8; s++) {
      const step = LEAD[c][s];
      if (step < 0 || (b >= 8 && b < 12 && s % 2)) continue;
      const f = hz(440, PENT[step]) * (b >= 24 ? 2 : 1);
      add(t + s * beat / 2, beat / 2 * 0.95, (x, p) => pulse(f, 0.25)(x) * (1 - p) ** 0.8 * (1 + 0.04 * Math.sin(x * 40)), 0.075);
    }
  }
  // drums
  for (let s = 0; s < 8; s++) {
    const ts = t + s * beat / 2;
    add(ts, 0.03, (x, p) => noise() * (1 - p) ** 2, intro && s % 2 ? 0 : 0.05); // hat
    if (intro || brk) continue;
    if (s % 4 === 0) add(ts, 0.18, (x, p) => Math.sin(2 * Math.PI * (130 * x - 450 * x * x * 0.5 * (1 - p))) * (1 - p) ** 1.6, 0.5); // kick
    if (s % 4 === 2) add(ts, 0.14, (x, p) => (noise() * 0.8 + Math.sin(x * 2 * Math.PI * 190) * 0.3) * (1 - p) ** 2, 0.16); // snare
  }
}

// Leave headroom, then write 16-bit stereo.
let peak = 0;
for (const v of mix) peak = Math.max(peak, Math.abs(v));
const gain = 0.7 / (peak || 1);
const pcm = Buffer.alloc(44 + total * 4);
pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + total * 4, 4); pcm.write('WAVEfmt ', 8);
pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(2, 22); pcm.writeUInt32LE(SR, 24);
pcm.writeUInt32LE(SR * 4, 28); pcm.writeUInt16LE(4, 32); pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(total * 4, 40);
for (let i = 0; i < total; i++) {
  const v = Math.max(-1, Math.min(1, mix[i] * gain)) * 32767;
  pcm.writeInt16LE(v, 44 + i * 4);
  pcm.writeInt16LE(v, 46 + i * 4);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, pcm);
console.log(`Wrote ${out}: ${(total / SR).toFixed(1)} s, ${BPM} bpm, ${bars} bars`);
