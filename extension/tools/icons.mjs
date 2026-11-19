// Draws the extension's icons (two white browser tabs on an amber rounded
// square) as PNGs, so no image files need to be kept in the repository.
//
//   node tools/icons.mjs <out-dir> [sizes, e.g. 1024]

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const out = process.argv[2];
mkdirSync(out, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// Coverage of a shape at a pixel, by 4×4 supersampling.
function cover(inside, x, y, n = 4) {
  let c = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (inside(x + (i + 0.5) / n, y + (j + 0.5) / n)) c++;
  return c / (n * n);
}

function rounded(x, y, x0, y0, x1, y1, rr) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + rr), x1 - rr);
  const cy = Math.min(Math.max(y, y0 + rr), y1 - rr);
  return (x - cx) ** 2 + (y - cy) ** 2 <= rr * rr;
}

const sizes = process.argv[3] ? process.argv[3].split(",").map(Number) : [16, 32, 48, 128];
for (const s of sizes) {
  const square = (x, y) => rounded(x, y, 0, 0, s, s, s * 0.22);
  // A browser tab: a page with a tab on its top left.
  const tab = (x, y, ox, oy) => {
    const w = s * 0.5, h = s * 0.36, tw = s * 0.22, th = s * 0.09, rr = s * 0.04;
    return rounded(x, y, ox, oy + th, ox + w, oy + th + h, rr) || rounded(x, y, ox, oy, ox + tw, oy + th + rr, rr);
  };
  const front = (x, y) => tab(x, y, s * 0.2, s * 0.36);
  // The back tab shows only clear of the front one's edge.
  const gap = s * 0.045;
  const nearFront = (x, y) => [[0, 0], [gap, 0], [-gap, 0], [0, gap], [0, -gap]].some(([dx, dy]) => front(x + dx, y + dy));
  const back = (x, y) => tab(x, y, s * 0.3, s * 0.18) && !nearFront(x, y);
  const buf = png(s, (x, y) => {
    const a = cover(square, x, y);
    const k = Math.min(1, cover(front, x, y) + cover(back, x, y) * 0.8);
    const top = [255, 204, 64], bottom = [232, 150, 0];
    const g = y / s;
    const bg = top.map((c, i) => Math.round(c * (1 - g) + bottom[i] * g));
    const col = bg.map((c) => Math.round(c * (1 - k) + 255 * k));
    return [...col, Math.round(a * 255)];
  });
  writeFileSync(join(out, `${s}.png`), buf);
}
console.log(`Icons written to ${out}`);
