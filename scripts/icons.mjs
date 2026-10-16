// Renders the extension icon (gradient rounded square with an "N") to PNG without dependencies.
import { deflateSync, crc32 } from 'node:zlib';

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Coverage of the shape at unit coordinates (0..1). Returns [alpha, isGlyph]. */
function sample(u, v) {
  const r = 0.22;
  const cx = Math.min(Math.max(u, r), 1 - r);
  const cy = Math.min(Math.max(v, r), 1 - r);
  if (Math.hypot(u - cx, v - cy) > r) return [0, false];
  const stroke = 0.065;
  const glyph =
    distToSegment(u, v, 0.33, 0.27, 0.33, 0.73) < stroke ||
    distToSegment(u, v, 0.67, 0.27, 0.67, 0.73) < stroke ||
    distToSegment(u, v, 0.33, 0.27, 0.67, 0.73) < stroke ||
    Math.hypot(u - 0.67, v - 0.27) < 0.095;
  return [1, glyph];
}

export function renderIcon(size) {
  const ss = 4;
  const out = Buffer.alloc(size * size * 4);
  const from = [124, 58, 237];
  const to = [6, 182, 212];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = 0;
      let g = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const [alpha, glyph] = sample((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          a += alpha;
          if (glyph) g += 1;
        }
      }
      a /= ss * ss;
      g /= ss * ss;
      const t = (x + y) / (2 * size);
      const base = from.map((c, i) => c + (to[i] - c) * t);
      const rgb = base.map((c) => Math.round(c * (1 - g / Math.max(a, 1e-6)) + 255 * (g / Math.max(a, 1e-6))));
      const o = (y * size + x) * 4;
      out[o] = rgb[0];
      out[o + 1] = rgb[1];
      out[o + 2] = rgb[2];
      out[o + 3] = Math.round(a * 255);
    }
  }
  return encodePng(size, out);
}
