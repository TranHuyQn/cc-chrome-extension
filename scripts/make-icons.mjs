// Generates simple solid-color PNG icons for the extension (no image libs needed).
// Draws an orange rounded square with a white "C"-like arc, rendered per-pixel.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "extension", "icons");
mkdirSync(outDir, { recursive: true });

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makePng(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const cx = size / 2, cy = size / 2;
  const outer = size * 0.38, inner = size * 0.22;
  const corner = size * 0.18;

  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const o = y * (size * 4 + 1) + 1 + x * 4;
      // rounded-square mask
      const dx = Math.max(Math.abs(x - cx + 0.5) - (size / 2 - corner), 0);
      const dy = Math.max(Math.abs(y - cy + 0.5) - (size / 2 - corner), 0);
      const inSquare = Math.hypot(dx, dy) <= corner;
      let [r, g, b, a] = inSquare ? [0xd9, 0x77, 0x57, 255] : [0, 0, 0, 0];
      if (inSquare) {
        // white "C": ring with a right-side gap
        const ddx = x - cx + 0.5, ddy = y - cy + 0.5;
        const dist = Math.hypot(ddx, ddy);
        const angle = Math.atan2(ddy, ddx); // -PI..PI, 0 = right
        const inRing = dist <= outer && dist >= inner;
        const inGap = Math.abs(angle) < Math.PI / 4;
        if (inRing && !inGap) [r, g, b] = [255, 255, 255];
      }
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [16, 48, 128]) {
  writeFileSync(join(outDir, `icon${size}.png`), makePng(size));
  console.log(`icon${size}.png`);
}
