// Renders media/icon.png (128x128) from a few rounded rectangles, 4x supersampled.
import * as fs from 'node:fs';
import * as zlib from 'node:zlib';

const S = 128;
const SS = 4;
const px = new Float32Array(S * S * 4);

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function inRound(x, y, r) {
  const [x0, y0, w, h, rad] = r;
  if (x < x0 || y < y0 || x > x0 + w || y > y0 + h) return false;
  const cx = Math.min(Math.max(x, x0 + rad), x0 + w - rad);
  const cy = Math.min(Math.max(y, y0 + rad), y0 + h - rad);
  return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;
}

function rect(r, color, alpha = 1) {
  const [cr, cg, cb] = hex(color);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let cover = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) if (inRound(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, r)) cover++;
      if (!cover) continue;
      const a = (cover / (SS * SS)) * alpha;
      const i = (y * S + x) * 4;
      const da = px[i + 3];
      const oa = a + da * (1 - a);
      px[i] = (cr * a + px[i] * da * (1 - a)) / oa;
      px[i + 1] = (cg * a + px[i + 1] * da * (1 - a)) / oa;
      px[i + 2] = (cb * a + px[i + 2] * da * (1 - a)) / oa;
      px[i + 3] = oa;
    }
  }
}

// Plate.
rect([4, 4, 120, 120, 26], '#18181b');
// Pinned focus bar with an accent edge.
rect([20, 20, 88, 16, 4], '#3a3a40');
rect([20, 20, 5, 16, 2.5], '#f76b15');
// Two columns of cards.
rect([20, 46, 40, 26, 5], '#f4f4f5');
rect([20, 78, 40, 18, 5], '#f4f4f5');
rect([68, 46, 40, 18, 5], '#f4f4f5');
rect([68, 70, 40, 34, 5], '#f4f4f5');
// Accent stripe on one card, as the board marks a card by color.
rect([68, 70, 4, 34, 2], '#2f9e63');
// Arrow from the left column to the right one.
rect([60, 84, 8, 2.2, 1], '#8b8d98');

const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const o = y * (S * 4 + 1) + 1 + x * 4;
    raw[o] = Math.round(px[i]);
    raw[o + 1] = Math.round(px[i + 1]);
    raw[o + 2] = Math.round(px[i + 2]);
    raw[o + 3] = Math.round(px[i + 3] * 255);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync('media/icon.png', png);
console.log('media/icon.png', png.length, 'bytes');
