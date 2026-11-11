import { deflateSync } from 'node:zlib';

/**
 * Runtime CAPTCHA image generation (README.md, "Design notes").
 *
 * Everything here is hand-rolled on purpose: a Lambda tuned for cold-start
 * latency has no room for `sharp` or `node-canvas`, and both drag native
 * binaries into a bundle that is otherwise pure JS. What's actually needed is
 * small — rasterise a few digits, distort them, deflate the result — and Node
 * ships the only hard part (zlib) in the standard library.
 *
 * The answer never reaches the client: the page carries the pixels and a signed
 * token committing to the digits (see challenge.ts).
 */

export const HEIGHT = 100;

/** Horizontal room per digit. The image widens with the digit count. */
const CELL = 36;
/** Width of the border band over which the image fades out to transparent. */
const FADE = 14;
/** Keeps glyphs clear of that band, so no digit is ever softened by the fade. */
const MARGIN = 30;

/** Image width for a given number of digits: 240px for the default five. */
export function imageWidth(digits: number): number {
  return 2 * MARGIN + digits * CELL;
}

/**
 * Digits as stroke outlines in a unit box, not a bitmap.
 *
 * A 5x7 bitmap breaks into visibly disconnected squares once scaled to ~50px,
 * which is unreadable however it's distorted. Strokes stay smooth at any size,
 * carry their own anti-aliasing (distance to the nearest segment), and let the
 * pen width vary per image.
 */
type Poly = readonly (readonly [number, number])[];

/** Samples an elliptical arc; angles in degrees, 0 = east, clockwise (y down). */
function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, steps = 14): Poly {
  const pts: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = ((a0 + ((a1 - a0) * i) / steps) * Math.PI) / 180;
    pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return pts;
}

const GLYPHS: readonly (readonly Poly[])[] = [
  [arc(0.5, 0.5, 0.32, 0.45, 0, 360, 16)], // 0
  [
    [[0.24, 0.24], [0.5, 0.05]],
    [[0.5, 0.05], [0.5, 0.95]],
    [[0.24, 0.95], [0.78, 0.95]],
  ], // 1
  [
    arc(0.5, 0.32, 0.29, 0.27, 180, 380, 11),
    [[0.72, 0.44], [0.18, 0.95]],
    [[0.18, 0.95], [0.84, 0.95]],
  ], // 2
  [arc(0.44, 0.28, 0.27, 0.23, 200, 450, 13), arc(0.44, 0.71, 0.3, 0.25, 280, 530, 14)], // 3
  [
    [[0.66, 0.95], [0.66, 0.05]],
    [[0.66, 0.08], [0.14, 0.7]],
    [[0.14, 0.7], [0.9, 0.7]],
  ], // 4
  [
    [[0.76, 0.07], [0.28, 0.07]],
    [[0.28, 0.07], [0.26, 0.45]],
    arc(0.5, 0.68, 0.28, 0.26, 224, 502, 14),
  ], // 5
  [arc(0.52, 0.68, 0.3, 0.27, 0, 360, 15), [[0.8, 0.1], [0.36, 0.52]]], // 6
  [
    [[0.16, 0.06], [0.84, 0.06]],
    [[0.84, 0.06], [0.42, 0.95]],
  ], // 7
  [arc(0.5, 0.27, 0.26, 0.22, 0, 360, 13), arc(0.5, 0.72, 0.31, 0.23, 0, 360, 15)], // 8
  [arc(0.48, 0.32, 0.3, 0.27, 0, 360, 15), [[0.2, 0.9], [0.64, 0.48]]], // 9
];

/**
 * Glyph outlines flattened to [ax, ay, bx, by, …] once at module load. The hot
 * loop runs ~70k times per image, so it works on a flat Float64Array and
 * compares squared distances — Math.hypot and the nested arrays it replaces
 * cost more than the rest of the rasteriser combined.
 */
const SEGMENTS: readonly Float64Array[] = GLYPHS.map((polys) => {
  const out: number[] = [];
  for (const poly of polys) {
    for (let i = 1; i < poly.length; i++) {
      out.push(poly[i - 1][0], poly[i - 1][1], poly[i][0], poly[i][1]);
    }
  }
  return Float64Array.from(out);
});

/** True when (gx, gy) in unit-glyph space falls under a pen of radius √penSq. */
function inked(digit: number, gx: number, gy: number, penSq: number): boolean {
  if (gx < -0.3 || gx > 1.3 || gy < -0.3 || gy > 1.3) return false;
  const seg = SEGMENTS[digit];
  for (let i = 0; i < seg.length; i += 4) {
    const ax = seg[i];
    const ay = seg[i + 1];
    const dx = seg[i + 2] - ax;
    const dy = seg[i + 3] - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((gx - ax) * dx + (gy - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = gx - (ax + t * dx);
    const qy = gy - (ay + t * dy);
    if (qx * qx + qy * qy < penSq) return true;
  }
  return false;
}

/** Visual noise only — never the answer. */
const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);

interface Placement {
  digit: number;
  cx: number;
  cy: number;
  gw: number;
  gh: number;
  sin: number;
  cos: number;
  shear: number;
  pen: number;
}

/**
 * Draws `answer` into an 8-bit greyscale buffer.
 *
 * Pixels are computed by inverse mapping — for each candidate pixel, undo the
 * wave and the per-glyph rotation to find where it lands in the glyph's unit
 * box — which makes arbitrary transforms cheap. Drawing forwards would leave
 * holes wherever a transform stretches. Only each glyph's bounding box is
 * scanned, not the whole canvas.
 */
function rasterise(answer: string, width: number): Uint8Array {
  const px = new Uint8Array(width * HEIGHT);

  // Paper: light, faintly mottled, so flat-field background subtraction fails.
  for (let i = 0; i < px.length; i++) px[i] = 236 + Math.floor(rand(0, 12));

  // Independent wave per axis; the glyphs and the strike lines share it, so the
  // distortion can't be undone by straightening the lines.
  const ampX = rand(2, 4);
  const ampY = rand(1.5, 3);
  const freqX = rand(0.05, 0.09);
  const freqY = rand(0.04, 0.08);
  const phaseX = rand(0, Math.PI * 2);
  const phaseY = rand(0, Math.PI * 2);

  const step = CELL;
  const places: Placement[] = [];
  for (let i = 0; i < answer.length; i++) {
    const theta = rand(-0.3, 0.3);
    places.push({
      digit: Number(answer[i]),
      // Overlapping cells and a jittered baseline: adjacent glyphs touch, which
      // defeats naive per-character segmentation.
      cx: MARGIN + step * (i + 0.5) + rand(-2, 2),
      cy: HEIGHT / 2 + rand(-5, 5),
      gw: rand(28, 35),
      gh: rand(44, 54),
      sin: Math.sin(theta),
      cos: Math.cos(theta),
      shear: rand(-0.22, 0.22),
      pen: rand(0.085, 0.115),
    });
  }

  // One sample per pixel, not 2x2. Supersampling exists to anti-alias, and the
  // Gaussian defocus at the end of this function already does that — paying for
  // both was four times the work for no visible difference.
  for (const p of places) {
    // Bound each glyph by its rotated rect rather than a circle: these are tall
    // and narrow, so a half-diagonal radius scans roughly twice the pixels it
    // needs to. Shear widens x only; the wave and pen widen both.
    const ax = p.gw / 2;
    const by = p.gh / 2;
    const c = Math.abs(p.cos);
    const sn = Math.abs(p.sin);
    const slack = ampX + ampY + p.pen * p.gw + 3;
    const reachX = ax * c + by * sn + p.gw * Math.abs(p.shear) + slack;
    const reachY = ax * sn + by * c + slack;
    const penSq = p.pen * p.pen;
    const x0 = Math.max(0, Math.floor(p.cx - reachX));
    const x1 = Math.min(width - 1, Math.ceil(p.cx + reachX));
    const y0 = Math.max(0, Math.floor(p.cy - reachY));
    const y1 = Math.min(HEIGHT - 1, Math.ceil(p.cy + reachY));

    for (let y = y0; y <= y1; y++) {
      const wy = ampY * Math.sin(freqY * (y + 0.5) + phaseY);
      for (let x = x0; x <= x1; x++) {
        const sxp = x + 0.5;
        const syp = y + 0.5;
        const dx = sxp + ampX * Math.sin(freqX * syp + phaseX) - p.cx;
        const dy = syp + wy - p.cy;
        const lx = dx * p.cos + dy * p.sin;
        const ly = -dx * p.sin + dy * p.cos;
        if (inked(p.digit, (lx - ly * p.shear) / p.gw + 0.5, ly / p.gh + 0.5, penSq)) {
          // Vary the ink so a fixed threshold can't cleanly separate glyph from
          // paper; the defocus turns these hard pixels into soft strokes.
          px[y * width + x] = 72 + Math.floor(rand(0, 30));
        }
      }
    }
  }

  // Strike-through lines that follow the same wave as the glyphs.
  for (let n = 0; n < 2; n++) {
    const y0 = rand(14, HEIGHT - 14);
    const slope = rand(-0.16, 0.16);
    const thick = rand(0.5, 1.1);
    const tone = 110 + Math.floor(rand(0, 50));
    for (let x = 0; x < width; x++) {
      const base = y0 + slope * x + ampY * Math.sin(freqY * x + phaseY);
      for (let dy = -thick; dy <= thick; dy += 0.5) {
        const y = Math.round(base + dy);
        if (y >= 0 && y < HEIGHT) px[y * width + x] = tone;
      }
    }
  }

  // Speckle. Applied before the defocus so it reads as film grain rather than
  // as sharp dots sitting on top of a soft image.
  for (let n = 0; n < 400; n++) {
    const i = Math.floor(rand(0, px.length));
    px[i] = Math.floor(rand(120, 215));
  }

  // Defocus everything together. The radius is randomised per image so no fixed
  // sharpening or deconvolution kernel can be calibrated against the output.
  return blur(px, rand(1.5, 2.4), width);
}

/**
 * Separable Gaussian blur. Two 1D passes instead of one 2D kernel: same result,
 * O(n·r) instead of O(n·r²), and at this size it costs well under a millisecond.
 */
function blur(src: Uint8Array, sigma: number, width: number): Uint8Array {
  const radius = Math.max(1, Math.ceil(sigma * 2));
  const k = new Float64Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;

  const tmp = new Float64Array(width * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < width; x++) {
      let a = 0;
      for (let i = -radius; i <= radius; i++) {
        // Clamp at the edges, so the border doesn't darken toward zero.
        const xx = x + i < 0 ? 0 : x + i >= width ? width - 1 : x + i;
        a += src[y * width + xx] * k[i + radius];
      }
      tmp[y * width + x] = a;
    }
  }

  const out = new Uint8Array(width * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < width; x++) {
      let a = 0;
      for (let i = -radius; i <= radius; i++) {
        const yy = y + i < 0 ? 0 : y + i >= HEIGHT ? HEIGHT - 1 : y + i;
        a += tmp[yy * width + x] * k[i + radius];
      }
      out[y * width + x] = a < 0 ? 0 : a > 255 ? 255 : Math.round(a);
    }
  }
  return out;
}

/**
 * Alpha channel: fully opaque in the middle, smoothstepped to transparent over
 * the outermost FADE pixels, so the image dissolves into the page instead of
 * sitting on it as a hard rectangle. Glyph placement is bounded by MARGIN so a
 * digit never lands in the band and gets faded away.
 *
 * Identical for every image of a given width, so it is built once per width
 * (in practice, once per container) rather than per request.
 */
const edgeMasks = new Map<number, Uint8Array>();

function edgeMask(width: number): Uint8Array {
  const cached = edgeMasks.get(width);
  if (cached) return cached;
  const a = new Uint8Array(width * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.min(x, width - 1 - x, y, HEIGHT - 1 - y);
      if (d >= FADE) {
        a[y * width + x] = 255;
      } else {
        const t = d / FADE;
        a[y * width + x] = Math.round(255 * t * t * (3 - 2 * t)); // smoothstep
      }
    }
  }
  edgeMasks.set(width, a);
  return a;
}

// --- Minimal PNG writer (greyscale + alpha, 8-bit, no interlace) ---

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(px: Uint8Array, alpha: Uint8Array, width: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 4; // colour type 4 = greyscale + alpha
  // 10..12 = compression, filter, interlace — all 0.

  // Two bytes per pixel now (grey, alpha), each scanline prefixed with its
  // filter type. Sub (1) rather than None: the alpha channel is a long run of
  // 255s broken by a smooth ramp, which differences to near-zero and shrinks
  // the extra channel to almost nothing.
  const stride = width * 2;
  const raw = Buffer.alloc((stride + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    const row = y * (stride + 1);
    raw[row] = 1; // filter: Sub
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const prevG = x === 0 ? 0 : px[i - 1];
      const prevA = x === 0 ? 0 : alpha[i - 1];
      raw[row + 1 + x * 2] = (px[i] - prevG) & 0xff;
      raw[row + 2 + x * 2] = (alpha[i] - prevA) & 0xff;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Renders `answer` (a string of digits) as a distorted PNG. */
export function renderPng(answer: string): Buffer {
  const width = imageWidth(answer.length);
  return encodePng(rasterise(answer, width), edgeMask(width), width);
}
