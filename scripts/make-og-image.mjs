// Renders public/og.png: the preview image Twitter, Discord, LinkedIn etc. show for the gym's link.
// It paints the gym with the same code the site uses (public/gym.js), so rerun it after changing the look:
//   tools\node\node.exe scripts/make-og-image.mjs
// No dependencies: a tiny pixel buffer stands in for a canvas, and the PNG is encoded with node:zlib.
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';

// `--thumb` makes a 16:9 video thumbnail (recordings/thumbnail.png) instead of the link-preview image.
const THUMB = process.argv.includes('--thumb');
const W = THUMB ? 1280 : 1200;
const H = THUMB ? 720 : 630;

function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

function parseColor(c) {
  const s = String(c).trim();
  let m;
  if ((m = /^#([0-9a-f]{3})$/i.exec(s))) return [...m[1]].map((x) => parseInt(x + x, 16)).concat(1);
  if ((m = /^#([0-9a-f]{6})$/i.exec(s))) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  if ((m = /^rgba?\(([^)]+)\)$/i.exec(s))) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p[3] ?? 1];
  }
  if ((m = /^hsla?\(([^)]+)\)$/i.exec(s))) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    return hslToRgb(p[0], p[1] / 100, p[2] / 100).concat(p[3] ?? 1);
  }
  throw new Error(`Unsupported color: ${c}`);
}

/** Just enough of CanvasRenderingContext2D for the gym's painter: fillStyle + fillRect. */
class PixelCtx {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
    this.rgba = [0, 0, 0, 1];
  }

  set fillStyle(c) {
    this.rgba = parseColor(c);
  }

  fillRect(x, y, w, h) {
    const [r, g, b, a] = this.rgba;
    const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w)), y1 = Math.min(this.height, Math.round(y + h));
    const d = this.data;
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const i = (yy * this.width + xx) * 4;
        d[i] = r * a + d[i] * (1 - a);
        d[i + 1] = g * a + d[i + 1] * (1 - a);
        d[i + 2] = b * a + d[i + 2] * (1 - a);
        d[i + 3] = 255;
      }
    }
  }

  /** Copies `src` here, scaled up by a whole number (nearest neighbour). Unpainted pixels are skipped. */
  blit(src, dx, dy, scale) {
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const i = (y * src.width + x) * 4;
        if (!src.data[i + 3]) continue;
        this.rgba = [src.data[i], src.data[i + 1], src.data[i + 2], 1];
        this.fillRect(dx + x * scale, dy + y * scale, scale, scale);
      }
    }
  }
}

function encodePng(ctx) {
  const { width: w, height: h, data } = ctx;
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const o = y * stride + 1 + x * 3;
      raw[o] = data[i];
      raw[o + 1] = data[i + 1];
      raw[o + 2] = data[i + 2];
    }
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(typed));
    return Buffer.concat([len, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Load the gym's painter. It only touches `window` to register itself.
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(new URL('../public/gym.js', import.meta.url), 'utf8'), sandbox, { filename: 'gym.js' });
const S = sandbox.window.Gym.snapshot;

const scene = new PixelCtx(S.VW, S.VH);
S.paint(scene);

const out = new PixelCtx(W, H);
const rect = (x, y, w, h, c) => {
  out.fillStyle = c;
  out.fillRect(x, y, w, h);
};
const text = (str, x, y, scale, color) => {
  const t = new PixelCtx(S.textW(str), 5);
  S.paintText(t, str, 0, 0, color);
  out.blit(t, x, y, scale);
};

rect(0, 0, W, H, '#0b0c10');
for (let x = 0; x < W; x += 24) rect(x, 0, 1, H, '#10121a');
for (let y = 0; y < H; y += 24) rect(0, y, W, 1, '#10121a');

// The gym, framed, on the right.
const scale = 2;
const gx = W - S.VW * scale - 40;
const gy = Math.round((H - S.VH * scale) / 2) + (THUMB ? 60 : 0);
rect(gx - 8, gy - 8, S.VW * scale + 16, S.VH * scale + 16, '#262838');
rect(gx - 4, gy - 4, S.VW * scale + 8, S.VH * scale + 8, '#c6ff3d');
out.blit(scene, gx, gy, scale);

if (THUMB) {
  // Video thumbnail: a big title across the top, the pitch under it, the gym below on the right.
  text('GRADIENT', 56, 52, 13, '#e9ecf1');
  text('GYM', 56 + S.textW('GRADIENT') * 13 + 40, 52, 13, '#c6ff3d');
  rect(56, 136, 150, 8, '#ff4d8d');
  text('BUILD YOUR OWN', 56, 190, 6, '#e9ecf1');
  text('CHARACTER.', 56, 244, 6, '#c6ff3d');
  text('WATCH THEM FIGHT.', 56, 330, 4, '#8a93a3');
  text('TRAIN. HANG OUT.', 56, 366, 4, '#8a93a3');
  const tcta = 'PLAY FREE';
  rect(56, 450, S.textW(tcta) * 4 + 44, 56, '#c6ff3d');
  text(tcta, 78, 468, 4, '#11140a');
  text('GRADIENT-GYM.GRADIENT-GYM.WORKERS.DEV', 56, 650, 2, '#5b6473');
} else {
  // The pitch, on the left.
  text('GRADIENT', 64, 118, 10, '#e9ecf1');
  text('GYM', 64, 184, 10, '#c6ff3d');
  rect(64, 246, 110, 6, '#ff4d8d');
  text('BUILD YOUR OWN CHARACTER.', 64, 280, 3, '#e9ecf1');
  text('TRAIN. FIGHT. HANG OUT.', 64, 314, 4, '#8a93a3');
  text('WATCH IT ALL LIVE.', 64, 348, 4, '#8a93a3');
  const cta = 'PLAY FREE';
  rect(64, 410, S.textW(cta) * 3 + 36, 45, '#c6ff3d');
  text(cta, 82, 425, 3, '#11140a');
  text('GRADIENT-GYM.GRADIENT-GYM.WORKERS.DEV', 64, 566, 2, '#5b6473');
}

const file = THUMB ? new URL('../recordings/thumbnail.png', import.meta.url) : new URL('../public/og.png', import.meta.url);
fs.writeFileSync(file, encodePng(out));
console.log(`Wrote ${file.pathname} (${W}x${H}, ${Math.round(fs.statSync(file).size / 1024)} KB)`);
