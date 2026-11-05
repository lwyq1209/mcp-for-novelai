import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import * as zlib from 'node:zlib';
import { BridgeError } from '../src/bridge-client.mjs';
import { MASK_LIMITS, validateMaskSpec, composeMask, buildMask, decodePngAlpha, encodeMaskPng, sampleCells, latentGrid, crc32Fallback } from '../src/recipe-masks.mjs';

// Inpaint mask module (design-addendum §1, W3a): P9 rasterization, P11 PNG decoder, host parity, boundaries and the
// §1.9 benchmark. Offline. The host side is the REAL client code loaded through jiti (as in
// mcp-business-recipes.test.mjs): ipc/nai.ts prepareInpaintAssets for the 8×8 latent sampling and the real
// queue-recipe service builder for complete inpaint recipes. Electron is a fixture whose nativeImage decodes
// nothing ("empty image"), so the host takes its own headless pngjs path (resizeImageBufferToPng's documented
// Vitest fallback); app/dialog/axios refuse every call.
const { createJiti } = await import('jiti');
const clientRequire = createRequire(fileURLToPath(new URL('../client/package.json', import.meta.url)));
const { PNG } = clientRequire('pngjs');

let hostPromise = null, hostDir = null;
/** Real host modules, loaded once on first use. */
function host() {
  hostPromise ??= (async () => {
    const dir = hostDir = await mkdtemp(join(tmpdir(), 'recipe-masks-host-'));
    const electron = join(dir, 'electron.mjs'), axios = join(dir, 'axios.mjs');
    await writeFile(electron, `const forbidden = () => { throw new Error('mask fixture cannot access native UI or account paths'); };
export const app = { getPath: forbidden, getVersion: forbidden }; export const dialog = {};
// An image Electron cannot decode: the host falls back to its own pngjs code path.
export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true }), createFromPath: forbidden };`);
    await writeFile(axios, `const forbidden = () => { throw new Error('mask fixture cannot access the network'); };
export default { get: forbidden, post: forbidden, request: forbidden, create: forbidden };`);
    const jiti = createJiti(import.meta.url, { moduleCache: true, fsCache: false, alias: { electron, axios } });
    const { prepareInpaintAssets } = await jiti.import(fileURLToPath(new URL('../client/electron/ipc/nai.ts', import.meta.url)));
    const { createQueueRecipeService } = await jiti.import(fileURLToPath(new URL('../client/electron/queue-recipe-service.ts', import.meta.url)));
    return { dir, prepareInpaintAssets, createQueueRecipeService };
  })();
  return hostPromise;
}
// Removes the directory even when loading the host modules failed after it was created.
test.after(async () => { if (hostDir) await rm(hostDir, { recursive: true, force: true }); });

// ------------------------------------------------------------------------------------------------ helpers

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const between = (rand, lo, hi) => lo + rand() * (hi - lo);
const intBetween = (rand, lo, hi) => Math.floor(between(rand, lo, hi + 1));
const art = (selection, W, H) => Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => selection[y * W + x] ? '#' : '.').join(''));
const fromArt = rows => { const H = rows.length, W = rows[0].length, sel = new Uint8Array(W * H); rows.forEach((row, y) => [...row].forEach((c, x) => { sel[y * W + x] = c === '#' ? 1 : 0; })); return sel; };
const px = (W, H, layers) => composeMask({ units: 'px', layers }, { width: W, height: H }).selection;
const ID = { historyId: 'history-1', historyRevision: 2, assetId: 'asset-1' };
const ID2 = { historyId: 'history-2', historyRevision: 1, assetId: 'asset-2' };
/** A decodePngAlpha-shaped object holding an arbitrary selection (255 = opaque). */
const alphaOf = (sel, W, H) => ({ width: W, height: H, alpha: Uint8Array.from(sel, v => v ? 255 : 0) });
const raster = (W, H, inside) => { const out = new Uint8Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = inside(x + 0.5, y + 0.5) ? 1 : 0; return out; };
const differences = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (!!a[i] !== !!b[i]) n++; return n; };
const rejects = (fn, { code = 'invalid_arguments', reason, path }) => assert.throws(fn, error => {
  assert.ok(error instanceof BridgeError, `expected BridgeError, got ${error?.stack ?? error}`);
  assert.equal(error.code, code, error.message);
  if (reason) assert.equal(error.details?.reason, reason, error.message);
  if (path !== undefined) assert.ok(path instanceof RegExp ? path.test(error.details?.path) : error.details?.path === path, `path ${error.details?.path} ≠ ${path} (${error.message})`);
  return true;
});

// Independent brute-force references at pixel centres (written differently from the module's span fills).
const refRect = s => (x, y) => s.x <= x && x < s.x + s.width && s.y <= y && y < s.y + s.height;
const refEllipse = s => (x, y) => { const u = (x - s.cx) / s.rx, v = (y - s.cy) / s.ry; return u * u + v * v <= 1; };
const refPolygon = pts => (x, y) => { let inside = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside; } return inside; };
function segmentDistance2(x, y, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, wx = x - ax, wy = y - ay, c1 = vx * wx + vy * wy;
  if (c1 <= 0) return wx * wx + wy * wy;
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return (x - bx) * (x - bx) + (y - by) * (y - by);
  const t = c1 / c2, dx = ax + t * vx - x, dy = ay + t * vy - y;
  return dx * dx + dy * dy;
}
const refStroke = s => (x, y) => { const r2 = (s.widthPx / 2) ** 2, p = s.points; if (p.length === 1) return segmentDistance2(x, y, p[0][0], p[0][1], p[0][0], p[0][1]) <= r2; for (let i = 1; i < p.length; i++) if (segmentDistance2(x, y, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) <= r2) return true; return false; };
const refShape = s => ({ rect: refRect, ellipse: refEllipse, polygon: s => refPolygon(s.points), stroke: refStroke })[s.type](s);
function refGrow(sel, W, H, g) {
  if (!g) return sel.slice();
  const out = new Uint8Array(W * H), r2 = g * g, target = g > 0 ? 1 : 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let near = false;
    for (let v = 0; v < H && !near; v++) for (let u = 0; u < W; u++) if (sel[v * W + u] === target && (u - x) ** 2 + (v - y) ** 2 <= r2) { near = true; break; }
    out[y * W + x] = g > 0 ? (near ? 1 : 0) : (sel[y * W + x] && !near ? 1 : 0);
  }
  return out;
}
function randomShape(rand, W, H) {
  const X = () => between(rand, -0.4 * W, 1.4 * W), Y = () => between(rand, -0.4 * H, 1.4 * H), type = ['rect', 'ellipse', 'polygon', 'stroke'][intBetween(rand, 0, 3)];
  // stays inside both the fraction range [−0.5, 1.5] (W = H = 1) and the px range [−W, 2W]
  if (type === 'rect') { const x = X(), y = Y(); return { type, x, y, width: between(rand, 0.01, 1.45 * W - x), height: between(rand, 0.01, 1.45 * H - y) }; }
  if (type === 'ellipse') { const cx = between(rand, -0.2 * W, 1.2 * W), cy = between(rand, -0.2 * H, 1.2 * H); return { type, cx, cy, rx: between(rand, 0.05, Math.min(cx + 0.5 * W, 1.5 * W - cx) * 0.9), ry: between(rand, 0.05, Math.min(cy + 0.5 * H, 1.5 * H - cy) * 0.9) }; }
  if (type === 'polygon') return { type, points: Array.from({ length: intBetween(rand, 3, 9) }, () => [X(), Y()]) };
  return { type, points: Array.from({ length: intBetween(rand, 1, 6) }, () => [X(), Y()]), widthPx: between(rand, 1, Math.max(2, Math.min(W, H) / 2)) };
}
/** Host request mask (full-size RGBA, one value per 8×8 cell) → per-cell 0/1 grid. */
function hostGrid(requestMaskBase64) {
  const png = PNG.sync.read(Buffer.from(requestMaskBase64, 'base64')), gw = png.width / 8, gh = png.height / 8, cells = new Uint8Array(gw * gh);
  for (let cy = 0; cy < gh; cy++) for (let cx = 0; cx < gw; cx++) cells[cy * gw + cx] = png.data[((cy * 8) * png.width + cx * 8) * 4] === 255 ? 1 : 0;
  return { cells, gridWidth: gw, gridHeight: gh };
}
function sourcePng(W, H, seed = 1) {
  const png = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; png.data[i] = (x * 3 + seed) & 255; png.data[i + 1] = (y * 2) & 255; png.data[i + 2] = ((x ^ y) * 5) & 255; png.data[i + 3] = 255; }
  return PNG.sync.write(png);
}
/** RGBA PNG whose alpha is a soft-edged ellipse (a background-removal-like subject cut-out). */
function subjectPng(W, H, { softEdge = 0.1, rx = 0.3, ry = 0.4 } = {}) {
  const png = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, d = ((x - W / 2) / (W * rx)) ** 2 + ((y - H / 2) / (H * ry)) ** 2;
    png.data[i] = 200; png.data[i + 1] = 150; png.data[i + 2] = 120; png.data[i + 3] = d < 1 ? 255 : d < 1 + softEdge ? Math.round(255 * (1 + softEdge - d) / softEdge) : 0;
  }
  return PNG.sync.write(png);
}

// Hand-written PNG builder for decoder fixtures pngjs cannot write (palette, tRNS keys, split IDAT, broken files).
const MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function pngChunk(type, data = Buffer.alloc(0), { badCrc = false } = {}) {
  const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); Buffer.from(data).copy(out, 8);
  out.writeUInt32BE((crc32Fallback(out.subarray(4, 8 + data.length)) ^ (badCrc ? 1 : 0)) >>> 0, 8 + data.length); return out;
}
const ihdr = (W, H, colorType, depth = 8, interlace = 0) => { const b = Buffer.alloc(13); b.writeUInt32BE(W, 0); b.writeUInt32BE(H, 4); b[8] = depth; b[9] = colorType; b[12] = interlace; return b; };
function filterRows(rows, bpp, filterFor) {
  const out = [];
  rows.forEach((cur, y) => {
    const prev = y ? rows[y - 1] : new Uint8Array(cur.length), f = filterFor(y), line = new Uint8Array(cur.length + 1); line[0] = f;
    for (let i = 0; i < cur.length; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0, p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f] ?? 0;
      line[i + 1] = (cur[i] - predictor) & 255;
    }
    out.push(line);
  });
  return Buffer.concat(out);
}
function handPng({ W, H, colorType, rows, bpp, filterFor = y => y % 5, plte, trns, before = [], after = [], split = 1, depth = 8, interlace = 0, idat }) {
  const data = idat ?? zlib.deflateSync(filterRows(rows, bpp, filterFor)), parts = [], size = Math.ceil(data.length / split);
  for (let i = 0; i < data.length; i += size) parts.push(pngChunk('IDAT', data.subarray(i, i + size)));
  return Buffer.concat([MAGIC, pngChunk('IHDR', ihdr(W, H, colorType, depth, interlace)), ...before, ...(plte ? [pngChunk('PLTE', plte)] : []), ...(trns ? [pngChunk('tRNS', trns)] : []), ...parts, ...after, pngChunk('IEND')]);
}
const pngjsAlpha = buf => { const png = PNG.sync.read(buf); return Uint8Array.from({ length: png.width * png.height }, (_, i) => png.data[i * 4 + 3]); };

// ------------------------------------------------------------------------------------------------ P9 rasterization

test('P9 rect golden: half-open edges at pixel centres, clipping outside the canvas', () => {
  const sel = px(10, 8, [
    { op: 'add', shape: { type: 'rect', x: 1.5, y: 1, width: 3, height: 2.5 } },
    { op: 'add', shape: { type: 'rect', x: -3, y: 5, width: 4.2, height: 10 } },
    { op: 'add', shape: { type: 'rect', x: 6.5, y: 0.5, width: 2, height: 1 } }, // edges exactly on centres: left/top in, right/bottom out
  ]);
  assert.deepEqual(art(sel, 10, 8), ['......##..', '.###......', '.###......', '..........', '..........', '#.........', '#.........', '#.........']);
  // two adjacent rects tile without gap or overlap
  const a = px(10, 4, [{ op: 'add', shape: { type: 'rect', x: 0, y: 0, width: 4.5, height: 4 } }]), b = px(10, 4, [{ op: 'add', shape: { type: 'rect', x: 4.5, y: 0, width: 5.5, height: 4 } }]);
  for (let i = 0; i < 40; i++) assert.equal(a[i] + b[i], 1);
});

test('P9 ellipse golden: closed boundary, a pixel centre exactly on the ellipse is inside', () => {
  assert.deepEqual(art(px(10, 8, [{ op: 'add', shape: { type: 'ellipse', cx: 5, cy: 4, rx: 3, ry: 2 } }]), 10, 8),
    ['..........', '..........', '...####...', '..######..', '..######..', '...####...', '..........', '..........']);
  assert.deepEqual(art(px(9, 7, [{ op: 'add', shape: { type: 'ellipse', cx: 4.5, cy: 3.5, rx: 2, ry: 2 } }]), 9, 7),
    ['.........', '....#....', '...###...', '..#####..', '...###...', '....#....', '.........']);
});

test('P9 polygon golden: half-open hypotenuse, even-odd ring hole, self-intersection hole, rect == polygon of its corners', () => {
  assert.deepEqual(art(px(8, 8, [{ op: 'add', shape: { type: 'polygon', points: [[0, 0], [8, 0], [0, 8]] } }]), 8, 8),
    ['#######.', '######..', '#####...', '####....', '###.....', '##......', '#.......', '........']);
  // outer square, zero-width bridge, inner square: even-odd leaves the inner square as a hole
  assert.deepEqual(art(px(10, 10, [{ op: 'add', shape: { type: 'polygon', points: [[1, 1], [9, 1], [9, 9], [1, 9], [1, 1], [3, 3], [3, 7], [7, 7], [7, 3], [3, 3]] } }]), 10, 10),
    ['..........', '.########.', '.########.', '.##....##.', '.##....##.', '.##....##.', '.##....##.', '.########.', '.########.', '..........']);
  // pentagram: the centre pentagon is crossed twice → hole; the tips are filled
  const star = Array.from({ length: 5 }, (_, k) => { const a = (-90 + k * 144) * Math.PI / 180; return [20.5 + 18 * Math.cos(a), 20.5 + 18 * Math.sin(a)]; });
  const sel = px(41, 41, [{ op: 'add', shape: { type: 'polygon', points: star } }]);
  assert.equal(sel[20 * 41 + 20], 0, 'centre of a pentagram is a hole under even-odd');
  assert.equal(sel[6 * 41 + 20], 1, 'top tip is filled');
  assert.equal(differences(sel, raster(41, 41, refPolygon(star))), 0);
  const rand = rng(11);
  for (let n = 0; n < 200; n++) {
    const W = intBetween(rand, 1, 40), H = intBetween(rand, 1, 40), x = between(rand, -W, W), y = between(rand, -H, H), width = between(rand, 0.01, 2 * W - x), height = between(rand, 0.01, 2 * H - y);
    assert.deepEqual(px(W, H, [{ op: 'add', shape: { type: 'rect', x, y, width, height } }]), px(W, H, [{ op: 'add', shape: { type: 'polygon', points: [[x, y], [x + width, y], [x + width, y + height], [x, y + height]] } }]));
  }
});

test('P9 stroke golden: capsule with round caps, single-point dot, round join', () => {
  assert.deepEqual(art(px(10, 8, [{ op: 'add', shape: { type: 'stroke', points: [[2, 4], [7, 4]], widthPx: 3 } }]), 10, 8),
    ['..........', '..........', '..#####...', '.#######..', '.#######..', '..#####...', '..........', '..........']);
  assert.deepEqual(art(px(10, 10, [{ op: 'add', shape: { type: 'stroke', points: [[5, 5]], widthPx: 4 } }]), 10, 10),
    ['..........', '..........', '..........', '....##....', '...####...', '...####...', '....##....', '..........', '..........', '..........']);
  // round join: the outside corner of an L is the arc around the joint, not a square corner
  const L = { type: 'stroke', points: [[3.3, 20.2], [20.1, 20.2], [20.1, 3.4]], widthPx: 9 }, sel = px(30, 30, [{ op: 'add', shape: L }]);
  assert.equal(differences(sel, raster(30, 30, refStroke(L))), 0);
  assert.equal(sel[22 * 30 + 22], 1, 'pixel (22,22) is 3.3 px from the joint: inside the round join');
  assert.equal(sel[23 * 30 + 23], 0, 'pixel (23,23) is 4.7 px from the joint: a square join would include it, a round one does not');
});

test('P9 every shape matches an independent brute-force pixel-centre reference on random canvases', () => {
  const rand = rng(2024);
  for (let n = 0; n < 800; n++) {
    const W = intBetween(rand, 1, 48), H = intBetween(rand, 1, 48), shape = randomShape(rand, W, H);
    const got = px(W, H, [{ op: 'add', shape }]), want = raster(W, H, refShape(shape));
    assert.equal(differences(got, want), 0, `${JSON.stringify(shape)} on ${W}×${H}`);
  }
});

test('P9 growPx (exact Euclidean dilation and erosion) equals brute force on random small images', () => {
  const rand = rng(77);
  for (let n = 0; n < 300; n++) {
    const W = intBetween(rand, 1, 24), H = intBetween(rand, 1, 24), density = rand(), sel = new Uint8Array(W * H);
    for (let i = 0; i < sel.length; i++) sel[i] = rand() < density * 0.3 ? 1 : 0;
    for (let k = intBetween(rand, 0, 2); k > 0; k--) { const cx = rand() * W, cy = rand() * H, r = rand() * 6; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) sel[y * W + x] = 1; }
    const g = intBetween(rand, -7, 7), spec = { units: 'px', layers: [{ op: 'add', alpha: { ...ID }, growPx: g }] };
    const got = composeMask(spec, { width: W, height: H, alphas: [alphaOf(sel, W, H)] }).selection;
    assert.equal(differences(got, refGrow(sel, W, H, g)), 0, `growPx ${g} on ${W}×${H}`);
  }
  // erosion ignores the image border: a full selection stays full, an edge-touching block shrinks only inwards
  const full = new Uint8Array(12 * 8).fill(1);
  assert.equal(differences(composeMask({ units: 'px', layers: [{ op: 'add', alpha: { ...ID }, growPx: -3 }] }, { width: 12, height: 8, alphas: [alphaOf(full, 12, 8)] }).selection, full), 0);
  const block = fromArt(['######......', '######......', '######......', '######......']);
  assert.deepEqual(art(composeMask({ units: 'px', layers: [{ op: 'add', alpha: { ...ID }, growPx: -2 }] }, { width: 12, height: 4, alphas: [alphaOf(block, 12, 4)] }).selection, 12, 4),
    ['####........', '####........', '####........', '####........']);
});

test('P9 invert and add/subtract order follow set algebra on the per-layer selections', () => {
  const rand = rng(5);
  for (let n = 0; n < 60; n++) {
    const W = intBetween(rand, 8, 40), H = intBetween(rand, 8, 40), [A, B, C] = [0, 1, 2].map(() => randomShape(rand, W, H));
    const [a, b, c] = [A, B, C].map(shape => px(W, H, [{ op: 'add', shape }]));
    const expect = f => Uint8Array.from(a, (_, i) => f(a[i], b[i], c[i]) ? 1 : 0);
    assert.deepEqual(px(W, H, [{ op: 'add', shape: A }, { op: 'subtract', shape: B }, { op: 'add', shape: C }]), expect((x, y, z) => (x && !y) || z));
    assert.deepEqual(px(W, H, [{ op: 'add', shape: A }, { op: 'add', shape: C }, { op: 'subtract', shape: B }]), expect((x, y, z) => (x || z) && !y));
    assert.deepEqual(px(W, H, [{ op: 'add', shape: A }, { op: 'subtract', shape: B, invert: true }]), expect((x, y) => x && y), 'subtract an inverted layer = intersection');
    assert.deepEqual(px(W, H, [{ op: 'add', shape: A, invert: true }]), expect(x => !x));
    // invert applies after grow, and only to its own layer
    const grown = composeMask({ units: 'px', layers: [{ op: 'add', shape: B, growPx: 2 }] }, { width: W, height: H }).selection;
    assert.deepEqual(px(W, H, [{ op: 'add', shape: A }, { op: 'add', shape: B, growPx: 2, invert: true }]), Uint8Array.from(a, (x, i) => x || !grown[i] ? 1 : 0));
  }
});

test('P9 fraction and px units are equivalent (x by width, y by height; widthPx and growPx stay pixels)', () => {
  const rand = rng(99);
  for (let n = 0; n < 200; n++) {
    const W = intBetween(rand, 1, 70), H = intBetween(rand, 1, 70), toPx = ([x, y]) => [x * W, y * H];
    const fractionShape = randomShape(rand, 1, 1), growPx = intBetween(rand, -3, 3);
    const s = fractionShape, pxShape = s.type === 'rect' ? { ...s, x: s.x * W, y: s.y * H, width: s.width * W, height: s.height * H }
      : s.type === 'ellipse' ? { ...s, cx: s.cx * W, cy: s.cy * H, rx: s.rx * W, ry: s.ry * H }
        : { ...s, points: s.points.map(toPx), ...(s.type === 'stroke' ? { widthPx: 1 + rand() * 9 } : {}) };
    if (s.type === 'stroke') fractionShape.widthPx = pxShape.widthPx;
    const f = composeMask({ units: 'fraction', layers: [{ op: 'add', shape: fractionShape, growPx }] }, { width: W, height: H });
    const p = composeMask({ units: 'px', layers: [{ op: 'add', shape: pxShape, growPx }] }, { width: W, height: H });
    assert.deepEqual(f.selection, p.selection, JSON.stringify({ W, H, fractionShape }));
  }
  // a fraction "circle" is an ellipse on a non-square image
  const circle = composeMask({ units: 'fraction', layers: [{ op: 'add', shape: { type: 'ellipse', cx: 0.5, cy: 0.5, rx: 0.25, ry: 0.25 } }] }, { width: 64, height: 32 });
  assert.deepEqual(circle.selection, px(64, 32, [{ op: 'add', shape: { type: 'ellipse', cx: 32, cy: 16, rx: 16, ry: 8 } }]));
});

test('P9 latent cell sampling equals the real host prepareInpaintAssets on random masks (64-aligned and not)', async () => {
  const { prepareInpaintAssets } = await host(), rand = rng(31337);
  let compared = 0, emptyChecked = 0;
  for (const [W, H] of [[64, 64], [128, 64], [192, 320], [100, 75], [130, 190], [257, 129], [64, 1600]]) {
    const source = sourcePng(W, H);
    for (let n = 0; n < 7; n++) {
      let selection;
      if (n < 2) { selection = new Uint8Array(W * H); const p = n ? 0.02 : 0.5; for (let i = 0; i < selection.length; i++) selection[i] = rand() < p ? 1 : 0; } // pixel noise
      else selection = composeMask({ units: 'px', layers: Array.from({ length: intBetween(rand, 1, 4) }, (_, k) => ({ op: k && rand() < 0.3 ? 'subtract' : 'add', shape: randomShape(rand, W, H), ...(rand() < 0.3 ? { growPx: intBetween(rand, -6, 6) } : {}) })) }, { width: W, height: H }).selection;
      const mcp = sampleCells(selection, W, H), maskBase64 = encodeMaskPng(selection, W, H).toString('base64');
      if (!mcp.selected) { assert.throws(() => prepareInpaintAssets(source, maskBase64), { reason: 'generation.no_mask' }); emptyChecked++; continue; }
      const prepared = prepareInpaintAssets(source, maskBase64), hostCells = hostGrid(prepared.maskBase64);
      assert.equal(hostCells.gridWidth, mcp.gridWidth); assert.equal(hostCells.gridHeight, mcp.gridHeight);
      assert.equal(differences(hostCells.cells, mcp.cells), 0, `${W}×${H} sample ${n}: per-cell grid`);
      compared++;
    }
  }
  // 4 px line between two rows of cell centres (y = 9; centres at 4 and 12): pixels but no cells — the host agrees it is empty
  const thin = px(64, 64, [{ op: 'add', shape: { type: 'stroke', points: [[0, 9], [64, 9]], widthPx: 4 } }]);
  assert.equal(sampleCells(thin, 64, 64).selected, 0);
  assert.throws(() => prepareInpaintAssets(sourcePng(64, 64), encodeMaskPng(thin, 64, 64).toString('base64')), { reason: 'generation.no_mask' });
  assert.ok(compared >= 35, `compared ${compared}, empty ${emptyChecked}`);
});

test('host parity: real queue-recipe builder request-mask equals the MCP simulation for shape and alpha-derived masks', async () => {
  const { dir, createQueueRecipeService } = await host();
  const runtimeDir = join(dir, 'rt'); await mkdir(runtimeDir, { recursive: true });
  const service = createQueueRecipeService({ runtimeDir, batch: { ready: Promise.resolve(), enqueue() {}, lookup: () => null, list: () => ({ batches: [] }), read() {} } });
  const params = (W, H) => ({ model: 'nai-diffusion-4-5-full', positivePrompt: 'garden', negativePrompt: '', stylePrompt: '', width: W, height: H, steps: 28, cfgScale: 5, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', seed: 9, seedMode: 'fixed', ucPreset: 0, qualityPreset: 'standard', qualityToggle: true });
  const shapes = { units: 'fraction', layers: [
    { op: 'add', shape: { type: 'ellipse', cx: 0.5, cy: 0.35, rx: 0.2, ry: 0.12 } },
    { op: 'add', shape: { type: 'stroke', points: [[0.3, 0.6], [0.5, 0.7], [0.7, 0.6]], widthPx: 40 } },
    { op: 'add', shape: { type: 'polygon', points: [[0.1, 0.8], [0.3, 0.75], [0.25, 0.95]] } },
    { op: 'subtract', shape: { type: 'rect', x: 0.45, y: 0.3, width: 0.1, height: 0.1 } },
  ] };
  const cases = [
    ['shapes', 832, 1216, shapes, []],
    ['shapes grown/shrunk + thin diagonal', 832, 1216, { units: 'px', layers: [{ op: 'add', shape: { type: 'polygon', points: [[100, 100], [700, 160], [400, 900], [380, 300]] }, growPx: 24 }, { op: 'subtract', shape: { type: 'ellipse', cx: 400, cy: 400, rx: 120, ry: 90 }, growPx: -10 }, { op: 'add', shape: { type: 'stroke', points: [[50, 1150], [780, 1000]], widthPx: 12 } }] }, []],
    ['alpha background (grow 8, invert)', 832, 1216, { units: 'px', layers: [{ op: 'add', alpha: { ...ID, threshold: 128 }, growPx: 8, invert: true }] }, [subjectPng(832, 1216)]],
    ['alpha edge (shrink 8, invert)', 832, 1216, { units: 'px', layers: [{ op: 'add', alpha: { ...ID }, growPx: -8, invert: true }] }, [subjectPng(832, 1216)]],
    ['rect ∩ subject, scaled alpha', 832, 1216, { units: 'fraction', layers: [{ op: 'add', shape: { type: 'rect', x: 0.2, y: 0.1, width: 0.6, height: 0.4 } }, { op: 'subtract', alpha: { ...ID, threshold: 200 }, invert: true }] }, [subjectPng(416, 608)]],
    ['mixed, two alpha layers', 1024, 1536, { units: 'fraction', layers: [{ op: 'add', alpha: { ...ID }, growPx: 16 }, { op: 'subtract', alpha: { ...ID2, threshold: 1 } }, { op: 'add', shape: { type: 'stroke', points: [[0.1, 0.1], [0.9, 0.12]], widthPx: 30 } }] }, [subjectPng(1024, 1536), subjectPng(1024, 1536, { rx: 0.15, ry: 0.2, softEdge: 0.5 })]],
  ];
  for (const [label, W, H, spec, alphaImages] of cases) {
    const mask = buildMask(spec, { width: W, height: H, alphaImages });
    const put = await service.put_queue_recipe({ preparation: { mode: 'inpaint', authored: { params: {}, inpaintModel: 'nai-diffusion-4-5-full-inpainting', inpaintStrength: 0.8, inpaintRecipe: params(W, H) }, assets: [{ role: 'source', mimeType: 'image/png', data: sourcePng(W, H).toString('base64') }, { role: 'mask', mimeType: 'image/png', data: mask.png.toString('base64') }] } });
    const input = put.snapshot.reviewInput;
    assert.equal(input.readiness.status, 'ready', `${label}: ${JSON.stringify(input.readiness)}`);
    assert.equal(input.assets.find(a => a.role === 'mask').sha256, mask.sha256, `${label}: the host stores the MCP mask bytes unchanged`);
    const hostCells = hostGrid(input.assets.find(a => a.role === 'request-mask').data);
    const mcp = sampleCells(composeMask(spec, { width: W, height: H, alphas: alphaImages.map(png => decodePngAlpha(png)) }).selection, W, H);
    assert.equal(differences(hostCells.cells, mcp.cells), 0, `${label}: per-cell grid`);
    assert.equal(hostCells.cells.reduce((s, v) => s + v, 0), mask.selectedCells, `${label}: selectedCells`);
    assert.ok(mask.selectedCells > 0 && mask.selectedCells < mask.totalCells, label);
  }
});

// ------------------------------------------------------------------------------------------------ P11 PNG decoder

test('P11 decoder: colour types 0/2/4/6 written by pngjs with every filter type match pngjs alpha', () => {
  const rand = rng(8);
  for (const [W, H] of [[37, 23], [1, 1], [1, 9], [9, 1], [64, 3]]) {
    const png = new PNG({ width: W, height: H });
    for (let i = 0; i < W * H; i++) { png.data[i * 4] = rand() * 256; png.data[i * 4 + 1] = rand() * 256; png.data[i * 4 + 2] = rand() * 256; png.data[i * 4 + 3] = i % 7 === 0 ? 0 : i % 5 === 0 ? 255 : rand() * 256; }
    for (const colorType of [0, 2, 4, 6]) for (const filterType of [0, 1, 2, 3, 4, -1]) {
      const buf = PNG.sync.write(png, { colorType, filterType });
      assert.equal(buf[25], colorType); assert.equal(buf[24], 8);
      const decoded = decodePngAlpha(buf);
      assert.equal(decoded.width, W); assert.equal(decoded.height, H); assert.equal(decoded.colorType, colorType);
      assert.deepEqual(decoded.alpha, pngjsAlpha(buf), `type ${colorType} filter ${filterType} ${W}×${H}`);
      if (colorType === 4 || colorType === 6) assert.deepEqual(decoded.alpha, Uint8Array.from({ length: W * H }, (_, i) => png.data[i * 4 + 3]));
      else assert.equal(decoded.hasTransparency, false);
    }
  }
});

test('P11 decoder: palette with tRNS, grey/RGB tRNS keys and split IDAT, every filter type, match pngjs', () => {
  const rand = rng(9), W = 29, H = 17;
  const plte = Buffer.from(Array.from({ length: 20 * 3 }, () => Math.floor(rand() * 256))), trns = Buffer.from(Array.from({ length: 12 }, (_, i) => i * 21));
  for (const filter of [0, 1, 2, 3, 4]) {
    const rows = Array.from({ length: H }, () => Uint8Array.from({ length: W }, () => Math.floor(rand() * 20)));
    const indexed = handPng({ W, H, colorType: 3, rows, bpp: 1, filterFor: () => filter, plte, trns, split: 3 });
    const decoded = decodePngAlpha(indexed);
    assert.deepEqual(decoded.alpha, pngjsAlpha(indexed), `palette filter ${filter}`);
    assert.deepEqual(decoded.alpha, Uint8Array.from(rows.flatMap(r => [...r]), i => i < 12 ? i * 21 : 255));
    const greyRows = Array.from({ length: H }, () => Uint8Array.from({ length: W }, () => rand() < 0.3 ? 77 : Math.floor(rand() * 256)));
    const grey = handPng({ W, H, colorType: 0, rows: greyRows, bpp: 1, filterFor: y => (y + filter) % 5, trns: Buffer.from([0, 77]) });
    assert.deepEqual(decodePngAlpha(grey).alpha, pngjsAlpha(grey)); assert.equal(decodePngAlpha(grey).hasTransparency, true);
    const rgbRows = Array.from({ length: H }, () => Uint8Array.from({ length: W * 3 }, (_, i) => rand() < 0.4 ? [10, 20, 30][i % 3] : Math.floor(rand() * 256)));
    const rgb = handPng({ W, H, colorType: 2, rows: rgbRows, bpp: 3, filterFor: () => filter, trns: Buffer.from([0, 10, 0, 20, 0, 30]) });
    assert.deepEqual(decodePngAlpha(rgb).alpha, pngjsAlpha(rgb), `rgb key filter ${filter}`);
  }
  // a 16-bit key that no 8-bit sample can equal; a palette without tRNS; ancillary chunks are ignored
  const rows = Array.from({ length: 4 }, () => Uint8Array.from({ length: 4 }, (_, i) => i * 60));
  assert.equal(decodePngAlpha(handPng({ W: 4, H: 4, colorType: 0, rows, bpp: 1, trns: Buffer.from([1, 44]) })).hasTransparency, false);
  assert.equal(decodePngAlpha(handPng({ W: 4, H: 4, colorType: 3, rows: rows.map(r => r.map(v => v / 60)), bpp: 1, plte: Buffer.alloc(12), before: [pngChunk('tEXt', Buffer.from('Comment\0x'))], after: [pngChunk('tIME', Buffer.alloc(7))] })).hasTransparency, false);
});

test('P11 decoder refuses corrupt, truncated, 16-bit, interlaced, animated and otherwise unsupported PNGs', async () => {
  const sharp = clientRequire('sharp');
  const rows = Array.from({ length: 6 }, (_, y) => Uint8Array.from({ length: 8 * 4 }, (_, i) => (i * 13 + y) & 255));
  const good = handPng({ W: 8, H: 6, colorType: 6, rows, bpp: 4 });
  assert.equal(decodePngAlpha(good).width, 8);
  const corrupt = { reason: 'alpha_png_corrupt' }, unsupported = { reason: 'alpha_png_unsupported' };
  const flipped = Buffer.from(good); flipped[45] ^= 0x40; // inside IDAT data, CRC not updated
  rejects(() => decodePngAlpha(flipped), corrupt);
  rejects(() => decodePngAlpha(good.subarray(0, good.length - 20)), corrupt); // cut inside IDAT
  rejects(() => decodePngAlpha(good.subarray(0, good.length - 12)), corrupt); // IEND missing
  rejects(() => decodePngAlpha(handPng({ W: 8, H: 6, colorType: 6, rows, bpp: 4, filterFor: y => (y === 3 ? 5 : 0) })), corrupt); // unknown filter byte
  rejects(() => decodePngAlpha(handPng({ W: 8, H: 6, colorType: 6, rows, bpp: 4, idat: Buffer.from('not a zlib stream at all') })), corrupt);
  rejects(() => decodePngAlpha(handPng({ W: 8, H: 5, colorType: 6, rows, bpp: 4 })), corrupt); // more data than the header declares
  rejects(() => decodePngAlpha(handPng({ W: 8, H: 7, colorType: 6, rows, bpp: 4 })), corrupt); // less data
  rejects(() => decodePngAlpha(handPng({ W: 8, H: 6, colorType: 5, rows, bpp: 4 })), corrupt); // invalid colour type
  rejects(() => decodePngAlpha(handPng({ W: 8, H: 6, colorType: 3, rows: rows.map(r => r.subarray(0, 8)), bpp: 1 })), corrupt); // palette image without PLTE
  rejects(() => decodePngAlpha(handPng({ W: 8, H: 6, colorType: 3, rows: rows.map(r => r.subarray(0, 8)), bpp: 1, plte: Buffer.alloc(9) })), corrupt); // index ≥ 3 entries
  rejects(() => decodePngAlpha(handPng({ W: 8, H: 6, colorType: 6, rows, bpp: 4, before: [], after: [pngChunk('tEXt', Buffer.from('a\0b')), pngChunk('IDAT', Buffer.alloc(0))] })), corrupt); // IDAT not consecutive
  rejects(() => decodePngAlpha(Buffer.concat([MAGIC, pngChunk('tEXt', Buffer.from('a\0b')), good.subarray(8)])), corrupt); // IHDR not first
  rejects(() => decodePngAlpha(Buffer.concat([MAGIC, pngChunk('IHDR', ihdr(8, 6, 6)), pngChunk('IEND')])), corrupt); // no IDAT
  rejects(() => decodePngAlpha(Buffer.concat([MAGIC, pngChunk('IHDR', ihdr(8, 6, 6), { badCrc: true }), good.subarray(33)])), corrupt);
  // unsupported but well-formed
  const rgba16 = PNG.sync.write(Object.assign(new PNG({ width: 4, height: 4 }), {}), { bitDepth: 16 });
  assert.equal(rgba16[24], 16);
  rejects(() => decodePngAlpha(rgba16), unsupported);
  const interlaced = await sharp(subjectPng(40, 30)).png({ progressive: true }).toBuffer();
  assert.equal(interlaced[28], 1, 'sharp wrote an Adam7 PNG');
  rejects(() => decodePngAlpha(interlaced), unsupported);
  rejects(() => decodePngAlpha(handPng({ W: 8, H: 6, colorType: 0, depth: 4, rows: rows.map(r => r.subarray(0, 4)), bpp: 1 })), unsupported);
  rejects(() => decodePngAlpha(handPng({ W: 8, H: 6, colorType: 6, rows, bpp: 4, before: [pngChunk('acTL', Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]))] })), unsupported);
  rejects(() => decodePngAlpha(handPng({ W: 8, H: 6, colorType: 6, rows, bpp: 4, before: [pngChunk('XYZW', Buffer.alloc(4))] })), unsupported); // unknown critical chunk
  assert.equal(decodePngAlpha(handPng({ W: 8, H: 6, colorType: 6, rows, bpp: 4, before: [pngChunk('xyZw', Buffer.alloc(4))] })).width, 8, 'unknown ancillary chunk is ignored');
});

test('P11 decoder refuses non-PNG bytes, > 12 MiB and > 32 M pixels before decoding', async () => {
  const sharp = clientRequire('sharp'), path = 'mask.layers[1].alpha';
  for (const bytes of [Buffer.alloc(0), Buffer.from([0xff, 0xd8, 0xff, 0xe0]), await sharp(sourcePng(16, 16)).jpeg().toBuffer(), await sharp(sourcePng(16, 16)).webp().toBuffer(), Buffer.from('GIF89a......'), MAGIC.subarray(0, 7)])
    rejects(() => decodePngAlpha(bytes, { path }), { reason: 'alpha_not_png', path });
  const huge = Buffer.alloc(MASK_LIMITS.alphaPngBytes + 1); MAGIC.copy(huge);
  rejects(() => decodePngAlpha(huge), { reason: 'alpha_png_too_large' });
  rejects(() => decodePngAlpha(Buffer.concat([MAGIC, pngChunk('IHDR', ihdr(8000, 5000, 6)), pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(10))), pngChunk('IEND')])), { reason: 'alpha_png_too_large' });
  assert.throws(() => decodePngAlpha('iVBORw0KGgo='), TypeError, 'base64 text must be decoded by the caller');
  // Uint8Array input works like a Buffer
  const png = subjectPng(10, 10);
  assert.deepEqual(decodePngAlpha(new Uint8Array(png)).alpha, decodePngAlpha(png).alpha);
});

test('CRC-32 fallback table equals zlib.crc32 and the known answer, and verifies every encoded mask chunk', () => {
  assert.equal(crc32Fallback(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32Fallback(Buffer.alloc(0)), 0);
  const rand = rng(3);
  for (let n = 0; n < 50; n++) {
    const bytes = Buffer.from(Array.from({ length: intBetween(rand, 0, 5000) }, () => Math.floor(rand() * 256)));
    if (typeof zlib.crc32 === 'function') assert.equal(crc32Fallback(bytes), zlib.crc32(bytes) >>> 0);
  }
  const png = encodeMaskPng(px(100, 60, [{ op: 'add', shape: { type: 'ellipse', cx: 50, cy: 30, rx: 30, ry: 20 } }]), 100, 60);
  let offset = 8, chunks = 0;
  while (offset < png.length) { const length = png.readUInt32BE(offset); assert.equal(crc32Fallback(png.subarray(offset + 4, offset + 8 + length)), png.readUInt32BE(offset + 8 + length)); offset += 12 + length; chunks++; }
  assert.equal(chunks, 3);
});

// ------------------------------------------------------------------------------------------------ encoding / readback

test('encodeMaskPng writes an 8-bit greyscale PNG that pngjs and the host read back as exactly 0/255', () => {
  const sel = px(130, 66, [{ op: 'add', shape: { type: 'polygon', points: [[3, 3], [120, 10], [60, 62]] } }]), png = encodeMaskPng(sel, 130, 66);
  assert.ok(png.subarray(0, 8).equals(MAGIC)); assert.equal(png[24], 8); assert.equal(png[25], 0); assert.equal(png[28], 0);
  const read = PNG.sync.read(png);
  for (let i = 0; i < sel.length; i++) { assert.equal(read.data[i * 4], sel[i] ? 255 : 0); assert.equal(read.data[i * 4 + 3], 255); }
  assert.deepEqual(decodePngAlpha(png).alpha, new Uint8Array(sel.length).fill(255), 'a greyscale mask has no alpha: the host uses its brightness rule');
  assert.ok(encodeMaskPng(sel, 130, 66).equals(png), 'deterministic');
  assert.throws(() => encodeMaskPng(sel, 131, 66), TypeError);
});

test('buildMask returns the §1.7 readback, normalized spec and statistics; the PNG hash is the readback sha256', () => {
  const spec = { units: 'fraction', layers: [{ op: 'add', shape: { type: 'rect', x: 0.25, y: 0.25, width: 0.5, height: 0.5 } }, { op: 'subtract', alpha: { ...ID }, invert: true }] };
  const result = buildMask(spec, { width: 128, height: 64, alphaImages: [subjectPng(128, 64, { rx: 0.2, ry: 0.3 })] });
  assert.equal(result.sha256, createHash('sha256').update(result.png).digest('hex'));
  assert.deepEqual(Object.keys(result.readback), ['sha256', 'width', 'height', 'selectedCells', 'totalCells', 'bboxCells', 'layers', 'spec']);
  assert.deepEqual(result.readback.layers.map(l => Object.keys(l)), [['op', 'kind', 'cells'], ['op', 'kind', 'cells']]);
  assert.equal(result.totalCells, 16 * 8); assert.equal(result.gridWidth, 16); assert.equal(result.gridHeight, 8);
  assert.deepEqual(result.spec, { units: 'fraction', layers: [{ op: 'add', shape: { type: 'rect', x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, growPx: 0, invert: false }, { op: 'subtract', alpha: { ...ID, threshold: 128 }, growPx: 0, invert: true }] });
  assert.deepEqual(result.alpha, [{ layer: 1, ...ID, width: 128, height: 64, scaled: false }]);
  assert.deepEqual(result.layers.map(({ index, op, kind }) => [index, op, kind]), [[0, 'add', 'rect'], [1, 'subtract', 'alpha']]);
  const cells = sampleCells(composeMask(spec, { width: 128, height: 64, alphas: [decodePngAlpha(subjectPng(128, 64, { rx: 0.2, ry: 0.3 }))] }).selection, 128, 64);
  assert.equal(result.selectedCells, cells.selected); assert.deepEqual(result.bboxCells, cells.bbox);
  assert.ok(result.bboxCells.x >= 4 && result.bboxCells.x + result.bboxCells.width <= 12, JSON.stringify(result.bboxCells));
  assert.doesNotThrow(() => JSON.stringify(result.readback));
  assert.equal(result.specJsonBytes, Buffer.byteLength(JSON.stringify(result.spec)));
  // the largest legal spec can exceed the host's 32 KB provenance budget: reported for W3, not refused here
  const long = { units: 'fraction', layers: Array.from({ length: 4 }, (_, k) => ({ op: 'add', shape: { type: 'stroke', widthPx: 20, points: Array.from({ length: 512 }, (_, i) => [0.1 + 0.8 * i / 511 + 1e-9 * k, 0.123456789012345 + 0.1 * k]) } })) };
  assert.ok(buildMask(long, { width: 64, height: 64 }).specJsonBytes > 32 * 1024);
  const { gridWidth, pixels } = latentGrid(832, 1216);
  assert.equal(gridWidth, 104); assert.equal(pixels[0], 4 * 832 + 4); assert.equal(pixels[105], 12 * 832 + 12, 'cell (1,1) samples pixel (12,12)');
});

// ------------------------------------------------------------------------------------------------ validation and boundaries

const baseSpec = () => ({ units: 'fraction', layers: [
  { op: 'add', shape: { type: 'rect', x: 0.1, y: 0.1, width: 0.3, height: 0.2 } },
  { op: 'add', shape: { type: 'ellipse', cx: 0.6, cy: 0.4, rx: 0.1, ry: 0.15 }, growPx: 4 },
  { op: 'add', shape: { type: 'polygon', points: [[0.1, 0.8], [0.3, 0.75], [0.25, 0.95]] } },
  { op: 'add', shape: { type: 'stroke', points: [[0.3, 0.6], [0.5, 0.7]], widthPx: 24 } },
  { op: 'subtract', alpha: { ...ID }, invert: true },
] });

test('validateMaskSpec accepts the design example, fills defaults and lists alpha identities in layer order (no host calls)', () => {
  const { spec, alphaRefs, warnings } = validateMaskSpec(baseSpec());
  assert.equal(spec.layers.length, 5); assert.deepEqual(warnings, []);
  assert.deepEqual(alphaRefs, [{ layer: 4, ...ID }]);
  assert.deepEqual(spec.layers[4], { op: 'subtract', alpha: { ...ID, threshold: 128 }, growPx: 0, invert: true });
  const two = validateMaskSpec({ units: 'px', layers: [{ op: 'add', alpha: { ...ID2, threshold: 1 } }, { op: 'add', shape: { type: 'rect', x: 0, y: 0, width: 1, height: 1 } }, { op: 'subtract', alpha: { ...ID, threshold: 255 } }] });
  assert.deepEqual(two.alphaRefs.map(r => r.layer), [0, 2]);
  // boundary values are accepted
  validateMaskSpec({ units: 'fraction', layers: [{ op: 'add', shape: { type: 'rect', x: -0.5, y: -0.5, width: 2, height: 2 }, growPx: 256 }, { op: 'subtract', shape: { type: 'stroke', points: [[1.5, 1.5]], widthPx: 512 }, growPx: -256 }, { op: 'add', shape: { type: 'stroke', points: [[0, 0]], widthPx: 12 } }] });
});

test('validateMaskSpec refuses malformed structures with the offending path', () => {
  const at = (mutate, path, reason = 'mask_spec_invalid') => { const spec = baseSpec(), replaced = mutate(spec); rejects(() => validateMaskSpec(replaced === undefined ? spec : replaced), { reason, path }); };
  at(() => null, 'mask'); at(() => [], 'mask'); at(() => 'rect', 'mask');
  at(s => { s.extra = 1; }, 'mask.extra');
  at(s => { delete s.units; }, 'mask.units'); at(s => { s.units = 'percent'; }, 'mask.units');
  at(s => { delete s.layers; }, 'mask.layers'); at(s => { s.layers = []; }, 'mask.layers'); at(s => { s.layers = {}; }, 'mask.layers');
  at(s => { s.layers[1].blend = 'multiply'; }, 'mask.layers[1].blend');
  at(s => { delete s.layers[1].op; }, 'mask.layers[1].op'); at(s => { s.layers[1].op = 'union'; }, 'mask.layers[1].op');
  at(s => { s.layers[0].op = 'subtract'; }, 'mask.layers[0].op', 'mask_first_layer_not_add');
  at(s => { s.layers[1].alpha = { ...ID }; }, 'mask.layers[1]'); // shape and alpha
  at(s => { delete s.layers[1].shape; }, 'mask.layers[1]'); // neither
  at(s => { s.layers[1].shape.type = 'circle'; }, 'mask.layers[1].shape.type');
  at(s => { s.layers[0].shape.points = [[0, 0], [1, 1], [0, 1]]; }, 'mask.layers[0].shape.points'); // rect does not take points
  at(s => { delete s.layers[0].shape.height; }, 'mask.layers[0].shape.height');
  at(s => { s.layers[1].shape.widthPx = 10; }, 'mask.layers[1].shape.widthPx'); // widthPx belongs to stroke only
  at(s => { s.layers[2].shape.widthPx = 10; }, 'mask.layers[2].shape.widthPx');
  at(s => { delete s.layers[3].shape.widthPx; }, 'mask.layers[3].shape.widthPx');
  at(s => { s.layers[3].shape.widthPx = '24'; }, 'mask.layers[3].shape.widthPx');
  at(s => { s.layers[3].shape.widthPx = 0.5; }, 'mask.layers[3].shape.widthPx', 'mask_value_out_of_range');
  at(s => { s.layers[3].shape.widthPx = 513; }, 'mask.layers[3].shape.widthPx', 'mask_value_out_of_range');
  at(s => { s.layers[1].growPx = 1.5; }, 'mask.layers[1].growPx'); at(s => { s.layers[1].growPx = '8'; }, 'mask.layers[1].growPx');
  at(s => { s.layers[1].growPx = 257; }, 'mask.layers[1].growPx', 'mask_value_out_of_range'); at(s => { s.layers[1].growPx = -257; }, 'mask.layers[1].growPx', 'mask_value_out_of_range');
  at(s => { s.layers[1].invert = 'yes'; }, 'mask.layers[1].invert');
  at(s => { s.layers[4].alpha.threshold = 0; }, 'mask.layers[4].alpha.threshold', 'mask_value_out_of_range');
  at(s => { s.layers[4].alpha.threshold = 256; }, 'mask.layers[4].alpha.threshold', 'mask_value_out_of_range');
  at(s => { s.layers[4].alpha.threshold = 12.5; }, 'mask.layers[4].alpha.threshold');
  at(s => { delete s.layers[4].alpha.assetId; }, 'mask.layers[4].alpha.assetId');
  at(s => { s.layers[4].alpha.historyRevision = 0; }, 'mask.layers[4].alpha.historyRevision');
  at(s => { s.layers[4].alpha.historyId = '   '; }, 'mask.layers[4].alpha.historyId');
  at(s => { s.layers[4].alpha.data = 'iVBOR'; }, 'mask.layers[4].alpha.data'); // no image bytes, paths or URLs
  at(s => { s.layers[4].alpha = 'history-1'; }, 'mask.layers[4].alpha');
  at(s => { s.layers[2].shape.points[1] = [0.1]; }, 'mask.layers[2].shape.points[1]');
  at(s => { s.layers[2].shape.points[1] = [0.1, 0.2, 0.3]; }, 'mask.layers[2].shape.points[1]');
  at(s => { s.layers[2].shape.points[1] = { x: 0.1, y: 0.2 }; }, 'mask.layers[2].shape.points[1]');
  at(s => { s.layers[2].shape.points[1] = ['0.1', 0.2]; }, 'mask.layers[2].shape.points[1][0]');
  at(s => { s.layers[2].shape.points[1] = [NaN, 0.2]; }, 'mask.layers[2].shape.points[1][0]');
  at(s => { s.layers[0].shape.x = Infinity; }, 'mask.layers[0].shape.x');
  at(s => { s.layers[0].shape.width = 0; }, 'mask.layers[0].shape.width', 'mask_value_out_of_range');
  at(s => { s.layers[0].shape.height = -0.1; }, 'mask.layers[0].shape.height', 'mask_value_out_of_range');
  at(s => { s.layers[1].shape.rx = 0; }, 'mask.layers[1].shape.rx', 'mask_value_out_of_range');
});

test('coordinates out of range: fraction [−0.5, 1.5] before any host call; px [−W, 2W] × [−H, 2H] once the source size is known', () => {
  const out = 'mask_coordinate_out_of_range';
  const fraction = (shape, path) => rejects(() => validateMaskSpec({ units: 'fraction', layers: [{ op: 'add', shape }] }), { reason: out, path });
  fraction({ type: 'rect', x: 1.6, y: 0, width: 0.1, height: 0.1 }, 'mask.layers[0].shape.x');
  fraction({ type: 'rect', x: -0.51, y: 0, width: 0.1, height: 0.1 }, 'mask.layers[0].shape.x');
  fraction({ type: 'rect', x: 1, y: 0, width: 0.51, height: 0.1 }, 'mask.layers[0].shape.width');
  fraction({ type: 'rect', x: 0, y: 1.4, width: 0.1, height: 0.2 }, 'mask.layers[0].shape.height');
  fraction({ type: 'ellipse', cx: 1.2, cy: 0.5, rx: 0.4, ry: 0.1 }, 'mask.layers[0].shape.rx');
  fraction({ type: 'ellipse', cx: 0.5, cy: -0.4, rx: 0.1, ry: 0.2 }, 'mask.layers[0].shape.ry');
  fraction({ type: 'polygon', points: [[0, 0], [1, 2], [0, 1]] }, 'mask.layers[0].shape.points[1][1]');
  fraction({ type: 'stroke', points: [[0, 0], [-0.6, 0]], widthPx: 20 }, 'mask.layers[0].shape.points[1][0]');
  const pxSpec = shape => ({ units: 'px', layers: [{ op: 'add', shape }] });
  const dims = { width: 64, height: 128 };
  validateMaskSpec(pxSpec({ type: 'polygon', points: [[-64, -128], [128, 256], [0, 256]] }), dims);
  rejects(() => validateMaskSpec(pxSpec({ type: 'polygon', points: [[-64, -128], [129, 0], [0, 256]] }), dims), { reason: out, path: 'mask.layers[0].shape.points[1][0]' });
  rejects(() => validateMaskSpec(pxSpec({ type: 'polygon', points: [[-64, -128.5], [1, 0], [0, 2]] }), dims), { reason: out, path: 'mask.layers[0].shape.points[0][1]' });
  rejects(() => validateMaskSpec(pxSpec({ type: 'stroke', points: [[0, 257]], widthPx: 20 }), dims), { reason: out });
  // without the size, px coordinates are only bounded by the canvas sanity limit; buildMask applies the exact rule
  validateMaskSpec(pxSpec({ type: 'stroke', points: [[3200, -1600]], widthPx: 20 }));
  rejects(() => validateMaskSpec(pxSpec({ type: 'stroke', points: [[3201, 0]], widthPx: 20 })), { reason: out });
  rejects(() => buildMask(pxSpec({ type: 'rect', x: 0, y: 0, width: 129, height: 10 }), dims), { reason: out, path: 'mask.layers[0].shape.width' });
  for (const [width, height] of [[0, 64], [1601, 64], [64, 1664], [64.5, 64], [64, undefined]]) rejects(() => buildMask(baseSpec(), { width, height }), { reason: 'mask_canvas_invalid' });
  for (const [width, height] of [[0, 64], [1601, 64]]) rejects(() => composeMask(baseSpec(), { width, height, alphas: [] }), { reason: 'mask_canvas_invalid' });
});

test('limits: polygon and stroke point counts, total points, layers and alpha layers', () => {
  const limit = 'mask_limit_exceeded', ring = n => Array.from({ length: n }, (_, i) => [0.5 + 0.4 * Math.cos(i / n * 6.283), 0.5 + 0.4 * Math.sin(i / n * 6.283)]);
  const one = shape => ({ units: 'fraction', layers: [{ op: 'add', shape }] });
  validateMaskSpec(one({ type: 'polygon', points: ring(256) })); validateMaskSpec(one({ type: 'stroke', points: ring(512), widthPx: 20 }));
  rejects(() => validateMaskSpec(one({ type: 'polygon', points: ring(257) })), { reason: limit, path: 'mask.layers[0].shape.points' });
  rejects(() => validateMaskSpec(one({ type: 'polygon', points: ring(2) })), { reason: 'mask_spec_invalid', path: 'mask.layers[0].shape.points' });
  rejects(() => validateMaskSpec(one({ type: 'stroke', points: ring(513), widthPx: 20 })), { reason: limit, path: 'mask.layers[0].shape.points' });
  rejects(() => validateMaskSpec(one({ type: 'stroke', points: [], widthPx: 20 })), { reason: 'mask_spec_invalid', path: 'mask.layers[0].shape.points' });
  const many = { units: 'fraction', layers: [...Array.from({ length: 4 }, () => ({ op: 'add', shape: { type: 'stroke', points: ring(512), widthPx: 20 } }))] };
  validateMaskSpec(many); // exactly 2048
  many.layers.push({ op: 'add', shape: { type: 'stroke', points: [[0.5, 0.5]], widthPx: 20 } });
  rejects(() => validateMaskSpec(many), { reason: limit, path: 'mask.layers' });
  const rect = { op: 'add', shape: { type: 'rect', x: 0, y: 0, width: 0.1, height: 0.1 } };
  validateMaskSpec({ units: 'fraction', layers: Array(16).fill(rect) });
  rejects(() => validateMaskSpec({ units: 'fraction', layers: Array(17).fill(rect) }), { reason: limit, path: 'mask.layers' });
  rejects(() => validateMaskSpec({ units: 'fraction', layers: [rect, { op: 'add', alpha: { ...ID } }, { op: 'add', alpha: { ...ID2 } }, { op: 'subtract', alpha: { ...ID } }] }), { reason: limit, path: 'mask.layers[3].alpha' });
});

test('warnings: stroke_thin, layer_empty, layer_below_cell_resolution, layer_no_effect, alpha_scaled, mask_covers_all — each names its layer, op and kind', () => {
  const big = { op: 'add', shape: { type: 'rect', x: 0, y: 0, width: 32, height: 64 } };
  const warn = (layers, W = 64, H = 64, alphas = []) => composeMask({ units: 'px', layers }, { width: W, height: H, alphas }).warnings;
  const only = (warnings, code) => warnings.filter(w => w.code === code);
  // stroke_thin: < 12 px only
  const thin = warn([big, { op: 'add', shape: { type: 'stroke', points: [[40, 4], [60, 4]], widthPx: 11.9 } }]);
  assert.deepEqual(only(thin, 'stroke_thin').map(({ layer, op, kind, widthPx }) => ({ layer, op, kind, widthPx })), [{ layer: 1, op: 'add', kind: 'stroke', widthPx: 11.9 }]);
  assert.deepEqual(only(warn([big, { op: 'add', shape: { type: 'stroke', points: [[40, 4], [60, 4]], widthPx: 12 } }]), 'stroke_thin'), []);
  assert.deepEqual(only(validateMaskSpec({ units: 'px', layers: [big, { op: 'subtract', shape: { type: 'stroke', points: [[1, 1]], widthPx: 2 } }] }).warnings, 'stroke_thin').map(w => w.layer), [1], 'reported before any host call');
  // layer_below_cell_resolution: pixels but no cell centre (4 px line at y = 9 between centre rows 4 and 12)
  const below = warn([big, { op: 'add', shape: { type: 'stroke', points: [[40, 9], [64, 9]], widthPx: 4 } }]);
  assert.deepEqual(only(below, 'layer_below_cell_resolution').map(({ layer, op, kind, pixels }) => ({ layer, op, kind, pixels })), [{ layer: 1, op: 'add', kind: 'stroke', pixels: 4 * 24 + 6 }], '4 rows × 24 plus the round cap');
  // layer_empty: entirely outside the image, or inverted to nothing
  const empty = warn([big, { op: 'add', shape: { type: 'rect', x: -64, y: 0, width: 60, height: 10 } }, { op: 'subtract', shape: { type: 'rect', x: 0, y: 0, width: 64, height: 64 }, invert: true }]);
  assert.deepEqual(only(empty, 'layer_empty').map(({ layer, op, kind }) => [layer, op, kind]), [[1, 'add', 'rect'], [2, 'subtract', 'rect']]);
  const opaque = { width: 64, height: 64, alpha: new Uint8Array(64 * 64).fill(255) };
  assert.deepEqual(only(warn([big, { op: 'add', alpha: { ...ID }, invert: true }], 64, 64, [opaque]), 'layer_empty').map(({ layer, op, kind }) => [layer, op, kind]), [[1, 'add', 'alpha']]);
  // layer_no_effect: covers cells, changes none
  const none = warn([big, { op: 'add', shape: { type: 'rect', x: 4, y: 4, width: 8, height: 8 } }, { op: 'subtract', shape: { type: 'ellipse', cx: 50, cy: 30, rx: 10, ry: 10 } }]);
  assert.deepEqual(only(none, 'layer_no_effect').map(({ layer, op, kind, cells }) => ({ layer, op, kind, cells })), [{ layer: 1, op: 'add', kind: 'rect', cells: 1 }, { layer: 2, op: 'subtract', kind: 'ellipse', cells: 5 }]);
  // at most one of the three layer_* warnings per layer
  for (const list of [below, empty, none]) for (const layer of [0, 1, 2]) assert.ok(list.filter(w => w.layer === layer && w.code.startsWith('layer_')).length <= 1);
  // mask_covers_all; alpha_scaled
  assert.deepEqual(warn([{ op: 'add', shape: { type: 'rect', x: 0, y: 0, width: 64, height: 64 } }]).map(w => w.code), ['mask_covers_all']);
  const half = alphaOf(new Uint8Array(32 * 32).fill(1), 32, 32), scaled = warn([{ op: 'add', alpha: { ...ID }, growPx: -4 }], 64, 64, [half]);
  assert.deepEqual(scaled.filter(w => w.code === 'alpha_scaled').map(({ layer, op, kind, from, to }) => ({ layer, op, kind, from, to })), [{ layer: 0, op: 'add', kind: 'alpha', from: { width: 32, height: 32 }, to: { width: 64, height: 64 } }]);
  assert.deepEqual(warn([big]), [], 'an ordinary mask has no warnings');
  for (const w of [...thin, ...below, ...empty, ...none, ...scaled]) assert.ok(typeof w.message === 'string' && w.message.length > 20, w.code);
});

test('alpha source size: same size used as is, aspect within 1% scaled (nearest neighbour), otherwise refused', () => {
  const spec = { units: 'px', layers: [{ op: 'add', alpha: { ...ID } }] }, build = (W, H, png) => buildMask(spec, { width: W, height: H, alphaImages: [png] });
  const same = build(128, 64, subjectPng(128, 64));
  assert.equal(same.warnings.some(w => w.code === 'alpha_scaled'), false); assert.equal(same.alpha[0].scaled, false);
  // exactly 1% (198×100 for 200×100) is accepted; 1.5% is refused
  assert.equal(build(200, 100, subjectPng(198, 100)).alpha[0].scaled, true);
  assert.equal(build(200, 100, subjectPng(199, 100)).warnings[0].code, 'alpha_scaled');
  rejects(() => build(200, 100, subjectPng(197, 100)), { reason: 'alpha_aspect_mismatch', path: 'mask.layers[0].alpha' });
  rejects(() => build(200, 100, subjectPng(100, 100)), { reason: 'alpha_aspect_mismatch' });
  // a half-size alpha maps every alpha pixel onto a 2×2 block
  const small = fromArt(['....', '.##.', '.#..']), scaled = composeMask(spec, { width: 8, height: 6, alphas: [alphaOf(small, 4, 3)] }).selection;
  assert.deepEqual(art(scaled, 8, 6), ['........', '........', '..####..', '..####..', '..##....', '..##....']);
  // a Director-style downscale (host fits the input into 1024×1024 pixels): 1254×836 for a 1536×1024 source
  assert.equal(build(1536, 1024, subjectPng(1254, 836)).warnings.find(w => w.code === 'alpha_scaled').from.width, 1254);
});

test('P3-2 an alpha PNG whose aspect differs by more than 1% is refused from its IHDR, before any image data is inflated', t => {
  const spec = { units: 'px', layers: [{ op: 'add', alpha: { ...ID } }] };
  // A 5000×5000 RGBA PNG of zeros (≈100 MB once inflated) against an 832×1216 source.
  const W = 5000, H = 5000, raw = Buffer.alloc((W * 4 + 1) * H);
  const big = Buffer.concat([MAGIC, pngChunk('IHDR', ihdr(W, H, 6)), pngChunk('IDAT', zlib.deflateSync(raw, { level: 1 })), pngChunk('IEND')]);
  // The same header followed by image data that is not even a zlib stream: refusing it as an aspect mismatch (not as
  // corrupt) proves the decision is made before the data is read.
  const garbage = Buffer.concat([MAGIC, pngChunk('IHDR', ihdr(W, H, 6)), pngChunk('IDAT', Buffer.from('definitely not zlib')), pngChunk('IEND')]);
  for (const [label, png] of [['zeros', big], ['garbage data', garbage]]) {
    // CPU time of this process, not elapsed time: other processes keeping the machine busy do not count.
    const started = process.cpuUsage();
    rejects(() => buildMask(spec, { width: 832, height: 1216, alphaImages: [png] }), { reason: 'alpha_aspect_mismatch', path: 'mask.layers[0].alpha' });
    const used = process.cpuUsage(started), elapsed = (used.user + used.system) / 1000;
    t.diagnostic(`${label}: refused in ${elapsed.toFixed(2)} ms`);
    // A loose bound only (Mac: ≈ 0.1 ms now, ≈ 35 ms when the 100 MB image was still inflated first), so load cannot
    // make it flaky. The deterministic proof that nothing is inflated is the garbage case: aspect mismatch, not corrupt.
    assert.ok(elapsed < 200, `${label}: refused in ${elapsed.toFixed(1)} ms`);
  }
  rejects(() => decodePngAlpha(garbage, { path: 'mask.layers[0].alpha', target: { width: 832, height: 1216 } }), { reason: 'alpha_aspect_mismatch' });
  // Without a target the decoder still reads the whole image (and here finds it corrupt); within 1% it still decodes and scales.
  rejects(() => decodePngAlpha(garbage), { reason: 'alpha_png_corrupt' });
  assert.equal(buildMask(spec, { width: 200, height: 100, alphaImages: [subjectPng(199, 100)] }).warnings[0].code, 'alpha_scaled');
});

test('P3-3 a fully opaque alpha layer is flagged (alpha_opaque) without being refused', () => {
  const opaque = sourcePng(64, 64);
  const added = buildMask({ units: 'px', layers: [{ op: 'add', alpha: { ...ID } }] }, { width: 64, height: 64, alphaImages: [opaque] });
  const flagged = added.warnings.filter(w => w.code === 'alpha_opaque');
  assert.equal(flagged.length, 1);
  assert.deepEqual((({ layer, op, kind }) => ({ layer, op, kind }))(flagged[0]), { layer: 0, op: 'add', kind: 'alpha' });
  assert.match(flagged[0].message, /fully opaque/);
  assert.ok(added.warnings.some(w => w.code === 'mask_covers_all'), 'it selects everything');
  // Subtracting an inverted opaque layer removes nothing; the warning says why.
  const subtracted = buildMask({ units: 'px', layers: [{ op: 'add', shape: { type: 'rect', x: 0, y: 0, width: 32, height: 32 } }, { op: 'subtract', alpha: { ...ID }, invert: true }] }, { width: 64, height: 64, alphaImages: [opaque] });
  assert.equal(subtracted.warnings.filter(w => w.code === 'alpha_opaque').length, 1);
  // A real cut-out has transparency: no warning.
  assert.equal(buildMask({ units: 'px', layers: [{ op: 'add', alpha: { ...ID } }] }, { width: 64, height: 64, alphaImages: [subjectPng(64, 64)] }).warnings.some(w => w.code === 'alpha_opaque'), false);
});

test('empty masks are refused as mask_empty (tiny shape, full invert, add then subtract all); the host agrees they are empty', async () => {
  const { prepareInpaintAssets } = await host(), W = 832, H = 1216;
  const cases = [
    { units: 'fraction', layers: [{ op: 'add', shape: { type: 'rect', x: 0.5, y: 0.5, width: 0.002, height: 0.002 } }] },
    { units: 'fraction', layers: [{ op: 'add', shape: { type: 'rect', x: 0, y: 0, width: 1, height: 1 }, invert: true }] },
    { units: 'fraction', layers: [{ op: 'add', shape: { type: 'ellipse', cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.3 } }, { op: 'subtract', shape: { type: 'rect', x: -0.5, y: -0.5, width: 2, height: 2 } }] },
    { units: 'px', layers: [{ op: 'add', shape: { type: 'stroke', points: [[0, 9], [832, 9]], widthPx: 4 } }] },
  ];
  for (const spec of cases) {
    rejects(() => buildMask(spec, { width: W, height: H }), { code: 'mask_empty', reason: 'mask_empty' });
    try { buildMask(spec, { width: W, height: H }); } catch (error) { assert.equal(error.details.selectedCells, 0); assert.equal(error.details.totalCells, 104 * 152); assert.equal(error.details.layers.length, spec.layers.length); }
    const composed = composeMask(spec, { width: W, height: H });
    assert.throws(() => prepareInpaintAssets(sourcePng(W, H), encodeMaskPng(composed.selection, W, H).toString('base64')), { reason: 'generation.no_mask' });
  }
  // invert of an alpha source with no transparency is empty too
  const opaque = sourcePng(64, 64);
  rejects(() => buildMask({ units: 'px', layers: [{ op: 'add', alpha: { ...ID }, invert: true }] }, { width: 64, height: 64, alphaImages: [opaque] }), { code: 'mask_empty' });
  // buildMask reads alpha PNG bytes itself: a non-PNG source is refused with the layer path, and the count must match
  rejects(() => buildMask({ units: 'px', layers: [{ op: 'add', shape: { type: 'rect', x: 0, y: 0, width: 8, height: 8 } }, { op: 'add', alpha: { ...ID } }] }, { width: 64, height: 64, alphaImages: [Buffer.from('GIF89a')] }), { reason: 'alpha_not_png', path: 'mask.layers[1].alpha' });
  assert.throws(() => buildMask({ units: 'px', layers: [{ op: 'add', alpha: { ...ID } }] }, { width: 64, height: 64 }), TypeError);
});

// ------------------------------------------------------------------------------------------------ §1.9 speed

test('§1.9 benchmark: every listed operation stays within the design order of magnitude', t => {
  // Best of three, in CPU time of this process (not elapsed time), so a machine kept busy by other processes does not
  // make the budgets fail; the operations are synchronous, so the CPU time is theirs.
  const cpuMs = fn => { const start = process.cpuUsage(), value = fn(), used = process.cpuUsage(start); return { ms: (used.user + used.system) / 1000, value }; };
  const best = (fn, reps = 3) => { let ms = Infinity, value; for (let i = 0; i < reps; i++) { const run = cpuMs(fn); value = run.value; ms = Math.min(ms, run.ms); } return { ms: Math.round(ms * 10) / 10, value }; };
  const rows = [], check = (size, label, budget, fn) => { const { ms } = best(fn); rows.push({ size, label, ms }); assert.ok(ms < budget, `${size} ${label}: ${ms} ms ≥ ${budget} ms`); };
  for (const [W, H] of [[832, 1216], [1024, 1536]]) {
    const size = `${W}x${H}`, dims = { width: W, height: H };
    const poly = Array.from({ length: 256 }, (_, i) => { const a = i / 256 * Math.PI * 2, r = 0.3 + 0.08 * Math.sin(a * 7); return [0.5 + r * Math.cos(a) * H / W * 0.6, 0.5 + r * Math.sin(a)]; });
    const stroke = Array.from({ length: 512 }, (_, i) => [0.1 + 0.8 * i / 511, 0.5 + 0.2 * Math.sin(i / 30)]);
    const layers = [{ op: 'add', shape: { type: 'rect', x: 0.1, y: 0.1, width: 0.3, height: 0.2 } }, { op: 'add', shape: { type: 'ellipse', cx: 0.6, cy: 0.3, rx: 0.15, ry: 0.1 } }, { op: 'add', shape: { type: 'polygon', points: poly } }, { op: 'subtract', shape: { type: 'stroke', points: stroke, widthPx: 24 } }];
    const one = (layer, extra = {}) => composeMask({ units: 'fraction', layers: [{ ...layer, ...extra, op: 'add' }] }, dims);
    // design (Mac, prototype): 3.4–4.5 / 1.5–2.1 / 7.6–10.9 / 14.5–25.1 / 15.9–26.7 / 11.8–17.6 / 16–27.8 / 18.9–27.1 ms
    check(size, 'polygon 256 points', 300, () => one(layers[2]));
    check(size, 'stroke 512 points, 24 px', 300, () => one(layers[3]));
    check(size, '4 layers', 300, () => composeMask({ units: 'fraction', layers }, dims));
    check(size, 'grow +64 (incl. ellipse)', 300, () => one(layers[1], { growPx: 64 }));
    check(size, 'shrink −16 (incl. ellipse)', 300, () => one(layers[1], { growPx: -16 }));
    const subject = subjectPng(W, H);
    check(size, 'decode alpha PNG', 300, () => decodePngAlpha(subject));
    const decoded = decodePngAlpha(subject);
    check(size, 'alpha + grow 8 + invert', 300, () => composeMask({ units: 'px', layers: [{ op: 'add', alpha: { ...ID }, growPx: 8, invert: true }] }, { ...dims, alphas: [decoded] }));
    const selection = composeMask({ units: 'fraction', layers }, dims).selection;
    check(size, 'encode mask PNG', 300, () => encodeMaskPng(selection, W, H));
    check(size, 'buildMask: 4 shape layers + alpha background', 500, () => buildMask({ units: 'fraction', layers: [...layers, { op: 'add', alpha: { ...ID }, growPx: 8, invert: true }] }, { ...dims, alphaImages: [subject] }));
  }
  // worst cases on the largest inpaint source (1600×1600)
  const W = 1600, H = 1600, dims = { width: W, height: H };
  const zigzag = Array.from({ length: 512 }, (_, i) => (i % 2 ? [1599, 1599 - i] : [0, i]));
  check('1600x1600', 'worst stroke: 511 full-diagonal segments, 512 px', 3000, () => composeMask({ units: 'px', layers: [{ op: 'add', shape: { type: 'stroke', points: zigzag, widthPx: 512 } }] }, dims));
  check('1600x1600', 'worst polygon: 256 full-height edges', 3000, () => composeMask({ units: 'px', layers: [{ op: 'add', shape: { type: 'polygon', points: zigzag.slice(0, 256) } }] }, dims));
  const subject = subjectPng(W, H), worst = { units: 'fraction', layers: [
    { op: 'add', alpha: { ...ID }, growPx: 256 }, { op: 'subtract', alpha: { ...ID2 }, growPx: -256, invert: true },
    ...Array.from({ length: 14 }, (_, k) => ({ op: k % 3 ? 'add' : 'subtract', shape: { type: 'ellipse', cx: 0.2 + 0.04 * k, cy: 0.5, rx: 0.2, ry: 0.3 }, growPx: k % 2 ? 256 : -256 })),
  ] };
  check('1600x1600', 'worst buildMask: 16 layers, all grown ±256, 2 alpha', 5000, () => buildMask(worst, { ...dims, alphaImages: [subject, subject] }));
  for (const row of rows) t.diagnostic(`${row.size} ${row.label}: ${row.ms} ms`);
});
