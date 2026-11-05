#!/usr/bin/env node
// Regenerates every app icon and the two brand images from the SVG sources in build/icon-source/:
//   icon.svg        the app icon (dark rounded square, violet-to-cyan star, cyan connector at the bottom right)
//   icon-small.svg  the same without the connector, for 16-32 px where it cannot be made out
// Output:
//   build/icon.png            1024 px, Linux (and electron-builder's fallback)
//   build/icon.icns           macOS, built with iconutil from an iconset (16/32 px entries use icon-small.svg). As in
//                             Apple's icon template, the rounded square fills 824 of 1024 px (100 px transparent
//                             margin on every side, scaled for each size); Windows and Linux icons stay full-bleed.
//   build/icon.ico            Windows: PNG-compressed entries of 16, 24, 32 (icon-small.svg), 48, 64, 128, 256 px
//   public/icon.png           512 px: window icon, splash and About page
//   public/icon-small.png     64 px of icon-small.svg: the favicon
//   public/splash.png         startup image: the icon centred on a dark background
// Run: npm run build:icons (node scripts/build-icons.mjs). Repeatable: it overwrites the files above. iconutil only
// exists on macOS; elsewhere build/icon.icns is left as it is and a warning is printed.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const client = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = path.join(client, 'build', 'icon-source');
const full = await readFile(path.join(sources, 'icon.svg'), 'utf8');
const small = await readFile(path.join(sources, 'icon-small.svg'), 'utf8');
const SMALL_MAX = 32;
const VIEWBOX = 512;

/** One square PNG of an SVG with a 512-unit viewBox, rendered at its final size (no resampling of a raster). */
function render(svg, size) {
  return sharp(Buffer.from(svg), { density: (72 * size) / VIEWBOX }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
}
const icon = size => render(size <= SMALL_MAX ? small : full, size);

// macOS app icons: the artwork's 512 units drawn into the central 824 px of a 1024 px canvas (Apple's template).
const MAC_CANVAS = 1024, MAC_BODY = 824;
const innerOf = svg => svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const macSvg = svg => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MAC_CANVAS} ${MAC_CANVAS}"><svg x="${(MAC_CANVAS - MAC_BODY) / 2}" y="${(MAC_CANVAS - MAC_BODY) / 2}" width="${MAC_BODY}" height="${MAC_BODY}" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}">${innerOf(svg)}</svg></svg>`;
const macIcon = size => sharp(Buffer.from(macSvg(size <= SMALL_MAX ? small : full)), { density: (72 * size) / MAC_CANVAS }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

/** The icon centred on a dark background with a faint glow, width × height px, the icon `scale` of the width. */
function brandImage(width, height, scale) {
  const size = Math.round(width * scale);
  const inner = innerOf(full);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs><radialGradient id="glow" cx="50%" cy="50%" r="60%"><stop offset="0" stop-color="#211c38"/><stop offset="1" stop-color="#0c0a14"/></radialGradient></defs>
  <rect width="${width}" height="${height}" fill="url(#glow)"/>
  <svg x="${(width - size) / 2}" y="${(height - size) / 2}" width="${size}" height="${size}" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}">${inner}</svg>
</svg>`;
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

function ico(entries) {
  const header = Buffer.alloc(6 + 16 * entries.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(({ size, data }, index) => {
    const entry = 6 + 16 * index;
    header.writeUInt8(size >= 256 ? 0 : size, entry); header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2); header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...entries.map(entry => entry.data)]);
}

const build = path.join(client, 'build');
const pub = path.join(client, 'public');
await mkdir(build, { recursive: true });
const written = [];
async function write(file, data) { await writeFile(file, data); written.push(path.relative(client, file)); }

await write(path.join(build, 'icon.png'), await icon(1024));
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
await write(path.join(build, 'icon.ico'), ico(await Promise.all(icoSizes.map(async size => ({ size, data: await icon(size) })))));

// macOS iconset: name → pixel size (the @2x entries are twice their point size).
const iconset = { 'icon_16x16.png': 16, 'icon_16x16@2x.png': 32, 'icon_32x32.png': 32, 'icon_32x32@2x.png': 64, 'icon_128x128.png': 128,
  'icon_128x128@2x.png': 256, 'icon_256x256.png': 256, 'icon_256x256@2x.png': 512, 'icon_512x512.png': 512, 'icon_512x512@2x.png': 1024 };
const iconutil = process.platform === 'darwin' ? spawnSync('iconutil', ['--help'], { stdio: 'ignore' }) : null;
if (iconutil && !iconutil.error) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'nai-iconset-'));
  try {
    const folder = path.join(temporary, 'icon.iconset');
    await mkdir(folder);
    for (const [name, size] of Object.entries(iconset)) await writeFile(path.join(folder, name), await macIcon(size));
    const result = spawnSync('iconutil', ['--convert', 'icns', '--output', path.join(build, 'icon.icns'), folder], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`iconutil failed: ${result.stderr || result.stdout}`);
    written.push('build/icon.icns');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
} else {
  console.warn('iconutil is not available (macOS only): build/icon.icns was not regenerated.');
}

await write(path.join(pub, 'icon.png'), await icon(512));
await write(path.join(pub, 'icon-small.png'), await render(small, 64));
await write(path.join(pub, 'splash.png'), await brandImage(832, 1216, 0.36));
console.log(`Written: ${written.join(', ')}`);
