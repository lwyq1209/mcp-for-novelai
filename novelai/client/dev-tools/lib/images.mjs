// Dependency-free placeholder PNGs and stored (uncompressed) ZIP archives, built with node:zlib only.
import zlib from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const crc32 = buffer => zlib.crc32(buffer) >>> 0;

function chunk(type, data) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** HSL (0–360, 0–1, 0–1) → [r, g, b] bytes. */
export function hsl(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = n => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return [f(0), f(8), f(4)];
}

/** A small deterministic hash of any string (for colours and patterns). */
export function hashString(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}

/**
 * An RGB PNG of exactly width×height: a diagonal two-colour gradient with a block pattern, both derived from `seed`,
 * so different requests give visibly different placeholders. `text` entries become tEXt chunks (latin1/UTF-8 bytes).
 */
export function placeholderPng(width, height, { seed = 0, text = {}, level = 1 } = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 64 * 1024 * 1024) throw new RangeError(`Invalid placeholder size ${width}×${height}.`);
  const hue = seed % 360;
  const [r1, g1, b1] = hsl(hue, 0.55, 0.42), [r2, g2, b2] = hsl((hue + 60 + (seed >>> 9) % 90) % 360, 0.6, 0.62);
  const block = Math.max(4, Math.round(Math.min(width, height) / (6 + (seed >>> 3) % 6)));
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  const span = Math.max(1, width + height - 2);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0;
    const by = Math.floor(y / block);
    for (let x = 0; x < width; x++) {
      const t = (x + y) / span;
      const dark = ((Math.floor(x / block) + by) & 1) === 0 ? 0.88 : 1;
      const offset = row + 1 + x * 3;
      raw[offset] = Math.round((r1 + (r2 - r1) * t) * dark);
      raw[offset + 1] = Math.round((g1 + (g2 - g1) * t) * dark);
      raw[offset + 2] = Math.round((b1 + (b2 - b1) * t) * dark);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
  const texts = Object.entries(text).map(([key, value]) => chunk('tEXt', Buffer.concat([Buffer.from(key, 'latin1'), Buffer.from([0]), Buffer.from(String(value), 'utf8')])));
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), ...texts, chunk('IDAT', zlib.deflateSync(raw, { level })), chunk('IEND', Buffer.alloc(0))]);
}

/** Width and height of a PNG (IHDR), or null. Also reads JPEG SOF and WebP VP8/VP8L/VP8X headers. */
export function imageSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return { type: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset++; continue; }
      const marker = buffer[offset + 1], length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { type: 'jpeg', width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      offset += 2 + length;
    }
    return null;
  }
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buffer.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { type: 'webp', width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    if (kind === 'VP8L') { const bits = buffer.readUInt32LE(21); return { type: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
    if (kind === 'VP8 ') return { type: 'webp', width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

/** A ZIP archive with stored entries [{name, data}] (what the NovelAI image endpoints return). */
export function zipStored(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  const dosTime = 0, dosDate = (2026 - 1980) << 9 | 1 << 5 | 1;
  for (const { name, data } of entries) {
    const fileName = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(fileName.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, fileName, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, fileName);
    offset += 30 + fileName.length + data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** Reads the stored/deflated entries of a ZIP (for the tool's own tests). */
export function unzip(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8), size = buffer.readUInt32LE(offset + 18), nameLength = buffer.readUInt16LE(offset + 26), extra = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
    const start = offset + 30 + nameLength + extra;
    const raw = buffer.subarray(start, start + size);
    entries.push({ name, data: method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw) });
    offset = start + size;
  }
  return entries;
}
