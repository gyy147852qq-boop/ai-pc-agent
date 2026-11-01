'use strict';
/**
 * 生成软件图标 assets/icon.ico（多尺寸，PNG 压缩条目）
 * 纯手写：像素栅格化（4x 超采样抗锯齿）→ PNG 编码 → ICO 封装，零依赖。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ----------------------------- CRC32 ----------------------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // no interlace

  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

/* --------------------------- 图形绘制 --------------------------- */
const SS = 4; // 超采样倍数

function lerp(a, b, t) { return a + (b - a) * t; }

function roundedRectAlpha(x, y, w, h, r) {
  // 点 (x,y) 是否在圆角矩形内 → 0/1
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r ? 1 : 0;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 ? (wx * vx + wy * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = px - (ax + vx * t);
  const dy = py - (ay + vy * t);
  return Math.sqrt(dx * dx + dy * dy);
}

function drawIcon(size) {
  const S = size * SS;
  const buf = Buffer.alloc(S * S * 4, 0);

  const pad = S * 0.02;
  const w = S - pad * 2;
  const r = w * 0.24;

  // 颜色：蓝 → 紫，对角渐变
  const c1 = [47, 109, 246];
  const c2 = [122, 74, 246];

  // 终端提示符：> 与 _
  const chev = [
    [0.30, 0.30], [0.53, 0.50], [0.30, 0.70],
  ].map(([x, y]) => [S * x, S * y]);
  const strokeW = S * 0.072;
  const barX0 = S * 0.58;
  const barX1 = S * 0.76;
  const barY0 = S * 0.635;
  const barY1 = S * 0.705;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (!roundedRectAlpha(px - pad, py - pad, w, w, r)) continue;

      const t = (px / S) * 0.55 + (py / S) * 0.45;
      let R = Math.round(lerp(c1[0], c2[0], t));
      let G = Math.round(lerp(c1[1], c2[1], t));
      let B = Math.round(lerp(c1[2], c2[2], t));

      // 顶部一层很淡的高光，增加体积感
      const gloss = Math.max(0, 1 - py / (S * 0.55)) * 0.10;
      R = Math.round(lerp(R, 255, gloss));
      G = Math.round(lerp(G, 255, gloss));
      B = Math.round(lerp(B, 255, gloss));

      // 白色字形
      let inGlyph = false;
      if (distToSegment(px, py, chev[0][0], chev[0][1], chev[1][0], chev[1][1]) <= strokeW / 2) inGlyph = true;
      if (distToSegment(px, py, chev[1][0], chev[1][1], chev[2][0], chev[2][1]) <= strokeW / 2) inGlyph = true;
      if (px >= barX0 && px <= barX1 && py >= barY0 && py <= barY1) {
        // 让横杠两端略圆
        const rr = (barY1 - barY0) / 2;
        const cx = Math.min(Math.max(px, barX0 + rr), barX1 - rr);
        const cy = (barY0 + barY1) / 2;
        if ((px - cx) ** 2 + (py - cy) ** 2 <= rr * rr) inGlyph = true;
      }
      if (inGlyph) { R = 255; G = 255; B = 255; }

      const o = (y * S + x) * 4;
      buf[o] = R;
      buf[o + 1] = G;
      buf[o + 2] = B;
      buf[o + 3] = 255;
    }
  }

  // 盒式降采样
  const out = Buffer.alloc(size * size * 4, 0);
  const n = SS * SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r0 = 0, g0 = 0, b0 = 0, a0 = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const o = ((y * SS + sy) * S + (x * SS + sx)) * 4;
          r0 += buf[o]; g0 += buf[o + 1]; b0 += buf[o + 2]; a0 += buf[o + 3];
        }
      }
      const o = (y * size + x) * 4;
      out[o] = Math.round(r0 / n);
      out[o + 1] = Math.round(g0 / n);
      out[o + 2] = Math.round(b0 / n);
      out[o + 3] = Math.round(a0 / n);
    }
  }
  return out;
}

/* ----------------------------- ICO ----------------------------- */
function buildIco(sizes) {
  const images = sizes.map((s) => ({ size: s, png: encodePng(s, s, drawIcon(s)) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const dirSize = 16 * images.length;
  let offset = 6 + dirSize;
  const entries = [];
  for (const img of images) {
    const e = Buffer.alloc(16);
    e[0] = img.size >= 256 ? 0 : img.size;
    e[1] = img.size >= 256 ? 0 : img.size;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(img.png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += img.png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

/* ----------------------------- 输出 ----------------------------- */
const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const ico = buildIco(SIZES);
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);

// 附一张 256 的 png 方便预览
fs.writeFileSync(path.join(outDir, 'icon-256.png'), encodePng(256, 256, drawIcon(256)));

console.log('icon.ico  ' + ico.length + ' bytes  (' + SIZES.join('/') + ')');
console.log('icon-256.png 已生成');
