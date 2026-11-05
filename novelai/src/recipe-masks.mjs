/**
 * Inpaint masks for prepare_recipe (design-addendum §1.2–§1.4, §1.6, §1.7).
 * Pure functions, Node built-ins only: no MCP registration, no host calls.
 *
 * Spec (`mask` argument): { units: 'fraction'|'px', layers: [layer, …] } with 1–16 layers applied in order to an
 * initially empty mask: `add` = union, `subtract` = difference; the first layer must add. Each layer has exactly one
 * of `shape` ({type:'rect'|'ellipse'|'polygon'|'stroke', …}) or `alpha` (a history PNG identity + threshold), plus
 * optional `growPx` (integer, + dilate / − erode, exact Euclidean distance) and `invert`. Per layer:
 * rasterize → grow → invert → combine.
 *
 * Geometry: origin at the source's top-left, x right, y down. fraction units scale x by the source width and y by
 * the source height (so a fraction "circle" is an ellipse on a non-square image); px units are source pixels and
 * may be fractional. A pixel (i, j) is tested at its centre (i + 0.5, j + 0.5):
 *  - rect    x ≤ cx < x + width and y ≤ cy < y + height (half-open, so adjacent rects tile exactly);
 *  - ellipse ((cx − ecx) / rx)² + ((cy − ecy) / ry)² ≤ 1;
 *  - polygon even-odd ray casting with the half-open edge rule (an edge counts when (yi > cy) ≠ (yj > cy), and
 *            the centre is inside when an odd number of crossings lie strictly to its right); a rect equals the
 *            polygon of its corners, and self-intersections become holes;
 *  - stroke  distance from the centre to the polyline ≤ widthPx / 2 (round caps and joins; one point = a dot).
 * Everything outside the canvas is clipped. Erosion treats only in-image unselected pixels as background, so a
 * selection touching the border does not shrink from the border.
 *
 * Latent cells: the host (client/electron/ipc/nai.ts prepareLatentInpaintMask) pads the source to a multiple of
 * 64, splits it into 8×8 cells and samples ONE mask pixel per cell, at floor((cell + 0.5) · size / cells). This
 * module simulates exactly that and reports selected cells; a final selection of 0 cells is refused (`mask_empty`).
 * The stored mask is an 8-bit greyscale PNG (255 = repaint, 0 = keep) of the source size; the host reads it as
 * fully opaque and selects brightness > 155.
 *
 * Errors are BridgeError: `invalid_arguments` with details {reason, path, …}, or `mask_empty`.
 */
import * as zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { BridgeError } from './bridge-client.mjs';

const MiB = 1024 * 1024;
const range = (min, max) => Object.freeze([min, max]);
export const MASK_LIMITS = Object.freeze({
  layers: 16, alphaLayers: 2, totalPoints: 2048,
  polygonPoints: range(3, 256), strokePoints: range(1, 512),
  widthPx: range(1, 512), growPx: range(-256, 256), threshold: range(1, 255), defaultThreshold: 128,
  /** fraction coordinates; px coordinates are limited to [−W, 2W] horizontally and [−H, 2H] vertically. */
  fractionRange: range(-0.5, 1.5), pxRange: range(-1, 2),
  /** Strokes thinner than this can fall between latent cell centres (diagonals need ≥ 12 px). */
  thinStrokePx: 12, cellSize: 8, alignment: 64,
  /** The host's inpaint limit per side (prepareInpaintAssets refuses more); also bounds px coordinates before the size is known. */
  canvasSide: 1600,
  alphaAspectTolerance: 0.01, alphaPngBytes: 12 * MiB, alphaPixels: 32_000_000, maskPngBytes: 4 * MiB,
});
export const MASK_SHAPE_TYPES = Object.freeze(['rect', 'ellipse', 'polygon', 'stroke']);
const SHAPE_KEYS = Object.freeze({
  rect: ['type', 'x', 'y', 'width', 'height'], ellipse: ['type', 'cx', 'cy', 'rx', 'ry'],
  polygon: ['type', 'points'], stroke: ['type', 'points', 'widthPx'],
});
const LAYER_KEYS = ['op', 'shape', 'alpha', 'growPx', 'invert'];
const ALPHA_KEYS = ['historyId', 'historyRevision', 'assetId', 'threshold'];

// ---------------------------------------------------------------------------------------------- errors / checks

const fail = (code, reason, message, details = {}) => { throw new BridgeError(code, message, { reason, ...details }); };
const bad = (path, message, reason = 'mask_spec_invalid', extra = {}) => fail('invalid_arguments', reason, `${path} ${message}`, { path, ...extra });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const show = value => { try { const text = JSON.stringify(value); return text === undefined ? String(value) : text.length > 40 ? `${text.slice(0, 40)}…` : text; } catch { return typeof value; } };

function fields(value, path, allowed, required, what = '') {
  if (!isObject(value)) bad(path, `must be an object; got ${show(value)}.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) bad(`${path}.${key}`, `is not allowed${what}; allowed: ${allowed.join(', ')}.`);
  for (const key of required) if (value[key] === undefined) bad(`${path}.${key}`, 'is required.');
}
function finite(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) bad(path, `must be a finite number; got ${show(value)}.`);
  return value;
}
function positive(value, path) {
  if (finite(value, path) <= 0) bad(path, `must be greater than 0; got ${value}.`, 'mask_value_out_of_range');
  return value;
}
function integerIn(value, [min, max], path) {
  if (!Number.isSafeInteger(value) || value < min || value > max) bad(path, `must be an integer from ${min} to ${max}; got ${show(value)}.`, Number.isSafeInteger(value) ? 'mask_value_out_of_range' : 'mask_spec_invalid');
  return value;
}
function identity(value, path) {
  if (typeof value !== 'string' || !value.length || value.length > 512 || !/\S/.test(value)) bad(path, 'must be the exact identity from asset_library (a non-empty string).');
  return value;
}
function revision(value, path) {
  if (!Number.isSafeInteger(value) || value < 1) bad(path, `must be the exact history revision from asset_library (an integer ≥ 1); got ${show(value)}.`);
  return value;
}
function canvas(width, height) {
  for (const [value, name] of [[width, 'width'], [height, 'height']])
    if (!Number.isSafeInteger(value) || value < 1 || value > MASK_LIMITS.canvasSide) fail('invalid_arguments', 'mask_canvas_invalid', `The mask canvas ${name} must be an integer from 1 to ${MASK_LIMITS.canvasSide}; got ${show(value)}.`, { path: `source.${name}` });
  return { width, height };
}

/** Coordinate bounds per axis: fraction [−0.5, 1.5]; px [−W, 2W] / [−H, 2H] (before the size is known: W = H = canvasSide). */
function bounds(units, dims) {
  if (units === 'fraction') { const [lo, hi] = MASK_LIMITS.fractionRange; return { x: [lo, hi, 'of the source width'], y: [lo, hi, 'of the source height'] }; }
  const [lo, hi] = MASK_LIMITS.pxRange, w = dims?.width ?? MASK_LIMITS.canvasSide, h = dims?.height ?? MASK_LIMITS.canvasSide;
  const note = dims ? 'px for this source' : `px (sources are at most ${MASK_LIMITS.canvasSide} px per side)`;
  return { x: [lo * w, hi * w, note], y: [lo * h, hi * h, note] };
}
function within(value, [lo, hi, note], path, label = '') {
  if (value < lo || value > hi) bad(path, `${label}must be within [${lo}, ${hi}] ${note}; got ${value}.`, 'mask_coordinate_out_of_range');
  return value;
}
function point(value, path, limits) {
  if (!Array.isArray(value) || value.length !== 2) bad(path, `must be a point [x, y]; got ${show(value)}.`);
  return [within(finite(value[0], `${path}[0]`), limits.x, `${path}[0]`), within(finite(value[1], `${path}[1]`), limits.y, `${path}[1]`)];
}
function pointList(value, path, [min, max], type, limits) {
  if (!Array.isArray(value)) bad(path, `must be an array of [x, y] points; got ${show(value)}.`);
  if (value.length < min || value.length > max) bad(path, `of a ${type} must have ${min}–${max} points; got ${value.length}.`, value.length > max ? 'mask_limit_exceeded' : 'mask_spec_invalid');
  return value.map((item, index) => point(item, `${path}[${index}]`, limits));
}

function shapeSpec(shape, path, limits) {
  if (!isObject(shape)) bad(path, `must be an object; got ${show(shape)}.`);
  if (!MASK_SHAPE_TYPES.includes(shape.type)) bad(`${path}.type`, `must be one of ${MASK_SHAPE_TYPES.join(', ')}; got ${show(shape.type)}.`);
  const keys = SHAPE_KEYS[shape.type];
  fields(shape, path, keys, keys, ` for type "${shape.type}"`);
  if (shape.type === 'rect') {
    const x = within(finite(shape.x, `${path}.x`), limits.x, `${path}.x`), y = within(finite(shape.y, `${path}.y`), limits.y, `${path}.y`);
    const width = positive(shape.width, `${path}.width`), height = positive(shape.height, `${path}.height`);
    within(x + width, limits.x, `${path}.width`, '(x + width) '); within(y + height, limits.y, `${path}.height`, '(y + height) ');
    return { type: 'rect', x, y, width, height };
  }
  if (shape.type === 'ellipse') {
    const cx = within(finite(shape.cx, `${path}.cx`), limits.x, `${path}.cx`), cy = within(finite(shape.cy, `${path}.cy`), limits.y, `${path}.cy`);
    const rx = positive(shape.rx, `${path}.rx`), ry = positive(shape.ry, `${path}.ry`);
    within(cx - rx, limits.x, `${path}.rx`, '(cx − rx) '); within(cx + rx, limits.x, `${path}.rx`, '(cx + rx) ');
    within(cy - ry, limits.y, `${path}.ry`, '(cy − ry) '); within(cy + ry, limits.y, `${path}.ry`, '(cy + ry) ');
    return { type: 'ellipse', cx, cy, rx, ry };
  }
  if (shape.type === 'polygon') return { type: 'polygon', points: pointList(shape.points, `${path}.points`, MASK_LIMITS.polygonPoints, 'polygon', limits) };
  const points = pointList(shape.points, `${path}.points`, MASK_LIMITS.strokePoints, 'stroke', limits);
  const widthPx = finite(shape.widthPx, `${path}.widthPx`), [minWidth, maxWidth] = MASK_LIMITS.widthPx;
  if (widthPx < minWidth || widthPx > maxWidth) bad(`${path}.widthPx`, `must be from ${minWidth} to ${maxWidth}; got ${widthPx}.`, 'mask_value_out_of_range');
  return { type: 'stroke', points, widthPx };
}

/**
 * Structural validation of the `mask` argument; no host calls. Without {width, height} px coordinates are only
 * bounded by [−canvasSide, 2·canvasSide] = [−1600, 3200]; with them, by the exact [−W, 2W] × [−H, 2H] rule. Returns the normalized spec (defaults
 * filled: growPx 0, invert false, alpha.threshold 128), the alpha-layer identities to read (in layer order) and
 * spec-time warnings (`stroke_thin`). Throws BridgeError invalid_arguments with details {reason, path}.
 */
export function validateMaskSpec(spec, { width, height } = {}) {
  const dims = width === undefined && height === undefined ? null : canvas(width, height);
  fields(spec, 'mask', ['units', 'layers'], ['units', 'layers']);
  if (spec.units !== 'fraction' && spec.units !== 'px') bad('mask.units', `must be "fraction" or "px"; got ${show(spec.units)}.`);
  if (!Array.isArray(spec.layers) || !spec.layers.length) bad('mask.layers', 'must be a non-empty array of layers.');
  if (spec.layers.length > MASK_LIMITS.layers) bad('mask.layers', `may have at most ${MASK_LIMITS.layers} layers; got ${spec.layers.length}.`, 'mask_limit_exceeded');
  const limits = bounds(spec.units, dims), layers = [], alphaRefs = [], warnings = [];
  let totalPoints = 0;
  spec.layers.forEach((layer, index) => {
    const at = `mask.layers[${index}]`;
    fields(layer, at, LAYER_KEYS, ['op']);
    if (layer.op !== 'add' && layer.op !== 'subtract') bad(`${at}.op`, `must be "add" or "subtract"; got ${show(layer.op)}.`);
    if (index === 0 && layer.op !== 'add') bad(`${at}.op`, 'must be "add": the mask starts empty, so the first layer has to add something.', 'mask_first_layer_not_add');
    if ((layer.shape === undefined) === (layer.alpha === undefined)) bad(at, 'must have exactly one of shape or alpha.');
    const growPx = layer.growPx === undefined ? 0 : integerIn(layer.growPx, MASK_LIMITS.growPx, `${at}.growPx`);
    if (layer.invert !== undefined && typeof layer.invert !== 'boolean') bad(`${at}.invert`, `must be true or false; got ${show(layer.invert)}.`);
    const invert = layer.invert === true;
    if (layer.shape !== undefined) {
      const shape = shapeSpec(layer.shape, `${at}.shape`, limits);
      if (shape.type === 'stroke' && shape.widthPx < MASK_LIMITS.thinStrokePx)
        warnings.push({ code: 'stroke_thin', layer: index, op: layer.op, kind: 'stroke', widthPx: shape.widthPx, message: `Layer ${index} (${layer.op} stroke): widthPx ${shape.widthPx} is below ${MASK_LIMITS.thinStrokePx} px. The host samples one pixel per 8×8 latent cell, so a thin stroke can miss cell centres (lines need ≥ 8 px across, diagonals ≥ 12 px); check this layer's cells.` });
      totalPoints += shape.points?.length ?? 0;
      if (totalPoints > MASK_LIMITS.totalPoints) bad('mask.layers', `have more than ${MASK_LIMITS.totalPoints} polygon/stroke points in total (reached ${totalPoints} at layer ${index}).`, 'mask_limit_exceeded');
      layers.push({ op: layer.op, shape, growPx, invert });
      return;
    }
    if (alphaRefs.length >= MASK_LIMITS.alphaLayers) bad(`${at}.alpha`, `exceeds the limit of ${MASK_LIMITS.alphaLayers} alpha layers per mask.`, 'mask_limit_exceeded');
    fields(layer.alpha, `${at}.alpha`, ALPHA_KEYS, ['historyId', 'historyRevision', 'assetId']);
    const alpha = {
      historyId: identity(layer.alpha.historyId, `${at}.alpha.historyId`),
      historyRevision: revision(layer.alpha.historyRevision, `${at}.alpha.historyRevision`),
      assetId: identity(layer.alpha.assetId, `${at}.alpha.assetId`),
      threshold: layer.alpha.threshold === undefined ? MASK_LIMITS.defaultThreshold : integerIn(layer.alpha.threshold, MASK_LIMITS.threshold, `${at}.alpha.threshold`),
    };
    alphaRefs.push({ layer: index, historyId: alpha.historyId, historyRevision: alpha.historyRevision, assetId: alpha.assetId });
    layers.push({ op: layer.op, alpha, growPx, invert });
  });
  return { spec: { units: spec.units, layers }, alphaRefs, warnings };
}

// ---------------------------------------------------------------------------------------------- rasterization

/** Extends/shrinks a candidate pixel span [i0, i1] to exactly the pixels whose centres satisfy `inside` (convex in i). */
function refineSpan(i0, i1, inside) {
  while (inside(i0 - 1)) i0--;
  while (i0 <= i1 && !inside(i0)) i0++;
  while (inside(i1 + 1)) i1++;
  while (i1 >= i0 && !inside(i1)) i1--;
  return [i0, i1];
}
function fillSpan(sel, W, row, i0, i1) {
  if (i0 < 0) i0 = 0;
  if (i1 > W - 1) i1 = W - 1;
  if (i0 <= i1) sel.fill(1, row * W + i0, row * W + i1 + 1);
}
function fillRect(sel, W, H, x, y, width, height) {
  const x2 = x + width, y2 = y + height;
  const [c0, c1] = refineSpan(Math.ceil(x - 0.5), Math.ceil(x2 - 0.5) - 1, i => x <= i + 0.5 && i + 0.5 < x2);
  const [r0, r1] = refineSpan(Math.ceil(y - 0.5), Math.ceil(y2 - 0.5) - 1, j => y <= j + 0.5 && j + 0.5 < y2);
  for (let row = Math.max(0, r0); row <= Math.min(H - 1, r1); row++) fillSpan(sel, W, row, c0, c1);
}
function fillEllipse(sel, W, H, cx, cy, rx, ry) {
  for (let row = Math.max(0, Math.floor(cy - ry) - 1); row <= Math.min(H - 1, Math.ceil(cy + ry) + 1); row++) {
    const ty = (row + 0.5 - cy) / ry, ty2 = ty * ty;
    if (ty2 > 1) continue;
    const half = rx * Math.sqrt(1 - ty2);
    const [i0, i1] = refineSpan(Math.ceil(cx - half - 0.5), Math.floor(cx + half - 0.5), i => { const tx = (i + 0.5 - cx) / rx; return tx * tx + ty2 <= 1; });
    fillSpan(sel, W, row, i0, i1);
  }
}
function fillPolygon(sel, W, H, pts) {
  const n = pts.length, xs = [];
  let minY = Infinity, maxY = -Infinity;
  for (const [, y] of pts) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
  for (let row = Math.max(0, Math.floor(minY) - 1); row <= Math.min(H - 1, Math.ceil(maxY) + 1); row++) {
    const sy = row + 0.5;
    xs.length = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > sy) !== (yj > sy)) xs.push(xi + (sy - yi) * (xj - xi) / (yj - yi));
    }
    xs.sort((a, b) => a - b);
    // even-odd: a centre is inside when an odd number of crossings lie strictly to its right ⇔ xs[2m] ≤ cx < xs[2m+1]
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = xs[k], b = xs[k + 1];
      const [i0, i1] = refineSpan(Math.ceil(a - 0.5), Math.ceil(b - 0.5) - 1, i => a <= i + 0.5 && i + 0.5 < b);
      fillSpan(sel, W, row, i0, i1);
    }
  }
}
/** One capsule (segment with round ends) per row: the span is found around the closest point by binary search. */
function fillCapsule(sel, W, H, ax, ay, bx, by, r) {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy, r2 = r * r;
  const xLo = Math.max(0, Math.floor(Math.min(ax, bx) - r - 1)), xHi = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + r + 1));
  if (xLo > xHi) return;
  for (let row = Math.max(0, Math.floor(Math.min(ay, by) - r - 1)); row <= Math.min(H - 1, Math.ceil(Math.max(ay, by) + r + 1)); row++) {
    const sy = row + 0.5, qy = sy - ay;
    const inside = i => {
      const qx = i + 0.5 - ax, t = len2 ? Math.max(0, Math.min(1, (qx * dx + qy * dy) / len2)) : 0, ex = qx - t * dx, ey = qy - t * dy;
      return ex * ex + ey * ey <= r2;
    };
    // x of the segment point nearest to this row: the crossing, else the endpoint nearest in y
    const xm = (ay <= sy && sy <= by) || (by <= sy && sy <= ay) ? (dy ? ax + qy * dx / dy : (ax + bx) / 2) : Math.abs(qy) < Math.abs(sy - by) ? ax : bx;
    const near = Math.floor(xm - 0.5), iL = Math.min(xHi, Math.max(xLo, near)), iR = Math.min(xHi, Math.max(xLo, near + 1));
    const start = inside(iL) ? iL : inside(iR) ? iR : -1;
    if (start < 0) continue;
    let lo = xLo, hi = start;
    if (inside(lo)) hi = lo;
    else while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (inside(mid)) hi = mid; else lo = mid; }
    const left = hi;
    lo = start; hi = xHi;
    if (inside(hi)) lo = hi;
    else while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (inside(mid)) lo = mid; else hi = mid; }
    sel.fill(1, row * W + left, row * W + lo + 1);
  }
}
function fillStroke(sel, W, H, pts, widthPx) {
  const r = widthPx / 2;
  if (pts.length === 1) return fillCapsule(sel, W, H, pts[0][0], pts[0][1], pts[0][0], pts[0][1], r);
  for (let i = 1; i < pts.length; i++) fillCapsule(sel, W, H, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], r);
}
function rasterizeShape(sel, W, H, shape, fx, fy) {
  if (shape.type === 'rect') fillRect(sel, W, H, shape.x * fx, shape.y * fy, shape.width * fx, shape.height * fy);
  else if (shape.type === 'ellipse') fillEllipse(sel, W, H, shape.cx * fx, shape.cy * fy, shape.rx * fx, shape.ry * fy);
  else if (shape.type === 'polygon') fillPolygon(sel, W, H, shape.points.map(([x, y]) => [x * fx, y * fy]));
  else fillStroke(sel, W, H, shape.points.map(([x, y]) => [x * fx, y * fy]), shape.widthPx);
}

// ---------------------------------------------------------------------------------------------- grow / shrink

const FAR = 1e20;
/** Felzenszwalb–Huttenlocher 1-D squared distance transform of f (length n) into d. */
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const p = v[k]; d[q] = (q - p) * (q - p) + f[p]; }
}
/** Exact squared Euclidean distance (pixel centre to pixel centre) from every pixel to the nearest pixel where sel[i] === target. */
function squaredDistanceTo(sel, W, H, target) {
  const g = new Float64Array(W * H), n = Math.max(W, H), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = sel[y * W + x] === target ? 0 : FAR;
    edt1d(f, H, d, v, z);
    for (let y = 0; y < H; y++) g[y * W + x] = d[y];
  }
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) f[x] = g[row + x];
    edt1d(f, W, d, v, z);
    for (let x = 0; x < W; x++) g[row + x] = d[x];
  }
  return g;
}
/** growPx > 0: pixels within growPx of the selection; growPx < 0: selected pixels farther than |growPx| from any in-image unselected pixel. */
function grow(sel, W, H, growPx) {
  const N = W * H, r2 = growPx * growPx;
  let count = 0;
  for (let i = 0; i < N; i++) count += sel[i];
  if (count === 0 || count === N) return sel; // nothing to grow from / no in-image background to erode from
  const out = new Uint8Array(N);
  if (growPx > 0) { const g = squaredDistanceTo(sel, W, H, 1); for (let i = 0; i < N; i++) out[i] = g[i] <= r2 ? 1 : 0; }
  else { const g = squaredDistanceTo(sel, W, H, 0); for (let i = 0; i < N; i++) out[i] = sel[i] && g[i] > r2 ? 1 : 0; }
  return out;
}

// ---------------------------------------------------------------------------------------------- latent cells

/** The host's latent grid for a mask of the source size: cell (cx, cy) samples pixel (sx[cx], sy[cy]). */
export function latentGrid(width, height) {
  const { alignment, cellSize } = MASK_LIMITS;
  const gridWidth = Math.max(alignment, Math.ceil(width / alignment) * alignment) / cellSize, gridHeight = Math.max(alignment, Math.ceil(height / alignment) * alignment) / cellSize;
  const pixels = new Int32Array(gridWidth * gridHeight);
  for (let cy = 0; cy < gridHeight; cy++) {
    const sy = Math.min(height - 1, Math.floor(((cy + 0.5) * height) / gridHeight));
    for (let cx = 0; cx < gridWidth; cx++) pixels[cy * gridWidth + cx] = sy * width + Math.min(width - 1, Math.floor(((cx + 0.5) * width) / gridWidth));
  }
  return { gridWidth, gridHeight, pixels };
}
/** Host-equivalent sampling of a selection (non-zero = selected): per-cell grid, selected count and bounding box in cells. */
export function sampleCells(selection, width, height, grid = latentGrid(width, height)) {
  const { gridWidth, gridHeight, pixels } = grid, cells = new Uint8Array(pixels.length);
  let selected = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let c = 0; c < pixels.length; c++) {
    if (!selection[pixels[c]]) continue;
    cells[c] = 1; selected++;
    const cx = c % gridWidth, cy = (c - cx) / gridWidth;
    if (cx < x0) x0 = cx; if (cx > x1) x1 = cx; if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
  }
  return { cells, gridWidth, gridHeight, selected, total: pixels.length, bbox: selected ? { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } : null };
}

// ---------------------------------------------------------------------------------------------- composition

/** Refuses an alpha image whose aspect differs from the W × H source by more than 1% (smaller ones are scaled). */
function checkAlphaAspect(aw, ah, W, H, path) {
  const deviation = Math.abs(aw * H - W * ah) / (W * ah);
  if (deviation > MASK_LIMITS.alphaAspectTolerance)
    fail('invalid_arguments', 'alpha_aspect_mismatch', `${path}: the alpha image is ${aw}×${ah} but the source is ${W}×${H}; their aspect ratios differ by ${(deviation * 100).toFixed(2)}% (only ≤ ${MASK_LIMITS.alphaAspectTolerance * 100}% is scaled to the source size).`,
      { path, alpha: { width: aw, height: ah }, source: { width: W, height: H }, aspectDeviation: Math.round(deviation * 1e6) / 1e6 });
}
function fitAlpha(decoded, W, H, path) {
  if (!decoded || !Number.isSafeInteger(decoded.width) || !Number.isSafeInteger(decoded.height) || !(decoded.alpha instanceof Uint8Array) || decoded.alpha.length !== decoded.width * decoded.height)
    throw new TypeError(`${path}: expected a decoded alpha source from decodePngAlpha.`);
  const { width: aw, height: ah, alpha } = decoded;
  if (aw === W && ah === H) return { alpha, scaled: false };
  checkAlphaAspect(aw, ah, W, H, path);
  // nearest neighbour, same pixel-centre convention as the host's cell sampling
  const out = new Uint8Array(W * H), xs = new Int32Array(W);
  for (let x = 0; x < W; x++) xs[x] = Math.min(aw - 1, Math.floor(((x + 0.5) * aw) / W));
  for (let y = 0; y < H; y++) {
    const src = Math.min(ah - 1, Math.floor(((y + 0.5) * ah) / H)) * aw, row = y * W;
    for (let x = 0; x < W; x++) out[row + x] = alpha[src + xs[x]];
  }
  return { alpha: out, scaled: true };
}

/**
 * Rasterizes and combines all layers on a width × height canvas (the source size). `alphas` are decodePngAlpha
 * results in alpha-layer order (validateMaskSpec(...).alphaRefs). Does not refuse an empty result (buildMask does).
 * Returns { selection: Uint8Array(W·H) of 0/1, width, height, gridWidth, gridHeight, selectedCells, totalCells,
 * bboxCells, layers: [{index, op, kind, pixels, cells, changedCells}], warnings, spec, alpha: [...] }.
 * Per layer: `pixels` / `cells` are what the layer itself selects (after grow and invert); `changedCells` is how
 * many cells it actually added or removed when applied.
 */
export function composeMask(spec, { width, height, alphas = [] } = {}) {
  canvas(width, height);
  const { spec: normalized, alphaRefs, warnings: specWarnings } = validateMaskSpec(spec, { width, height });
  if (!Array.isArray(alphas) || alphas.length !== alphaRefs.length) throw new TypeError(`composeMask needs ${alphaRefs.length} decoded alpha source(s) in layer order; got ${Array.isArray(alphas) ? alphas.length : typeof alphas}.`);
  const W = width, H = height, N = W * H, fx = normalized.units === 'fraction' ? W : 1, fy = normalized.units === 'fraction' ? H : 1;
  const grid = latentGrid(W, H), mask = new Uint8Array(N), layers = [], warnings = [], alpha = [];
  let alphaIndex = 0;
  normalized.layers.forEach((layer, index) => {
    for (const warning of specWarnings) if (warning.layer === index) warnings.push(warning);
    let sel = new Uint8Array(N), kind;
    if (layer.shape) { kind = layer.shape.type; rasterizeShape(sel, W, H, layer.shape, fx, fy); }
    else {
      kind = 'alpha';
      const ref = alphaRefs[alphaIndex], decoded = alphas[alphaIndex++], path = `mask.layers[${index}].alpha`;
      const fitted = fitAlpha(decoded, W, H, path), threshold = layer.alpha.threshold, values = fitted.alpha;
      for (let i = 0; i < N; i++) sel[i] = values[i] >= threshold ? 1 : 0;
      alpha.push({ ...ref, width: decoded.width, height: decoded.height, scaled: fitted.scaled });
      if (fitted.scaled) warnings.push({ code: 'alpha_scaled', layer: index, op: layer.op, kind, from: { width: decoded.width, height: decoded.height }, to: { width: W, height: H }, message: `Layer ${index} (${layer.op} alpha): the alpha image is ${decoded.width}×${decoded.height}; it was scaled (nearest neighbour) to the source size ${W}×${H}.` });
      // Not refused (it may be deliberate), but an opaque image is not a cut-out: every pixel passes any threshold.
      if (decoded.hasTransparency === false) warnings.push({ code: 'alpha_opaque', layer: index, op: layer.op, kind, message: `Layer ${index} (${layer.op} alpha): the alpha image is fully opaque (no transparent pixel), so with threshold ${threshold} it selects the whole image before growPx and invert. For a cut-out, use a PNG with transparency (for example a Director bg-removal or a V5 transparent-background result).` });
    }
    if (layer.growPx) sel = grow(sel, W, H, layer.growPx);
    if (layer.invert) for (let i = 0; i < N; i++) sel[i] ^= 1;
    const add = layer.op === 'add';
    let cells = 0, changedCells = 0, pixels = 0;
    for (const p of grid.pixels) if (sel[p]) { cells++; if (add ? !mask[p] : mask[p]) changedCells++; }
    if (add) for (let i = 0; i < N; i++) { const s = sel[i]; pixels += s; mask[i] |= s; }
    else for (let i = 0; i < N; i++) if (sel[i]) { pixels++; mask[i] = 0; }
    layers.push({ index, op: layer.op, kind, pixels, cells, changedCells });
    if (!pixels) warnings.push({ code: 'layer_empty', layer: index, op: layer.op, kind, message: `Layer ${index} (${layer.op} ${kind}) selects no pixels inside the image${layer.invert ? ' after invert' : ''}; it has no effect.` });
    else if (!cells) warnings.push({ code: 'layer_below_cell_resolution', layer: index, op: layer.op, kind, pixels, message: `Layer ${index} (${layer.op} ${kind}) selects ${pixels} pixels but no 8×8 latent cell centre, so it contributes 0 cells; make it larger or wider (strokes ≥ 12 px).` });
    else if (!changedCells) warnings.push({ code: 'layer_no_effect', layer: index, op: layer.op, kind, cells, message: `Layer ${index} (${layer.op} ${kind}) covers ${cells} cells but changes none of them (${add ? 'all were already selected' : 'none of them was selected'}).` });
  });
  const sampled = sampleCells(mask, W, H, grid);
  if (sampled.selected && sampled.selected === sampled.total) warnings.push({ code: 'mask_covers_all', message: `The mask selects all ${sampled.total} latent cells: the whole image will be repainted.` });
  return { selection: mask, width: W, height: H, gridWidth: grid.gridWidth, gridHeight: grid.gridHeight, selectedCells: sampled.selected, totalCells: sampled.total, bboxCells: sampled.bbox, layers, warnings, spec: normalized, alpha };
}

// ---------------------------------------------------------------------------------------------- PNG

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
let crcTable = null;
/** Table CRC-32 (PNG/zlib polynomial), used where zlib.crc32 is missing (Node < 22.2). */
export function crc32Fallback(bytes, value = 0) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let c = ~value >>> 0;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}
const crc32 = typeof zlib.crc32 === 'function' ? bytes => zlib.crc32(bytes) >>> 0 : bytes => crc32Fallback(bytes);

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** 8-bit greyscale PNG of the selection: 255 = repaint, 0 = keep. Deterministic for a given Node zlib. */
export function encodeMaskPng(selection, width, height) {
  canvas(width, height);
  if (!selection || selection.length !== width * height) throw new TypeError('encodeMaskPng needs one selection value per pixel.');
  const stride = width + 1, raw = Buffer.alloc(stride * height);
  for (let y = 0, p = 0; y < height; y++) { const row = y * stride + 1; for (let x = 0; x < width; x++, p++) if (selection[p]) raw[row + x] = 255; }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 0; // depth 8, greyscale; compression, filter, interlace 0
  return Buffer.concat([PNG_MAGIC, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
/**
 * Alpha channel of an 8-bit, non-interlaced PNG of colour type 0/2/3/4/6 (tRNS honoured for 0/2/3, CRCs
 * checked). Anything else is refused: not a PNG, > 12 MiB, > 32 M pixels, other depths, interlace, animation,
 * unknown critical chunks, corruption or truncation. With `target` ({width, height} of the source) an image whose
 * aspect differs by more than 1% is refused right after its IHDR, before any image data is read or inflated.
 * Returns { width, height, alpha: Uint8Array, colorType, hasTransparency }. Errors: BridgeError invalid_arguments,
 * reason alpha_not_png | alpha_png_too_large | alpha_png_unsupported | alpha_png_corrupt | alpha_aspect_mismatch.
 */
export function decodePngAlpha(bytes, { path = 'mask.alpha', target } = {}) {
  if (target !== undefined && (!Number.isSafeInteger(target?.width) || !Number.isSafeInteger(target?.height) || target.width < 1 || target.height < 1)) throw new TypeError('decodePngAlpha target must be {width, height} of the source.');
  if (!(bytes instanceof Uint8Array)) throw new TypeError('decodePngAlpha needs the PNG bytes as a Buffer or Uint8Array.');
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const refuse = (reason, message, extra) => fail('invalid_arguments', reason, `${path}: ${message}`, { path, ...extra });
  const corrupt = why => refuse('alpha_png_corrupt', `the alpha image is a corrupt or truncated PNG (${why}).`);
  const unsupported = why => refuse('alpha_png_unsupported', `the alpha image must be an 8-bit, non-interlaced, non-animated PNG of colour type 0, 2, 3, 4 or 6; this one is ${why}.`);
  if (buf.length > MASK_LIMITS.alphaPngBytes) refuse('alpha_png_too_large', `the alpha image is ${buf.length} bytes; at most ${MASK_LIMITS.alphaPngBytes} (12 MiB).`, { byteLength: buf.length });
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_MAGIC)) refuse('alpha_not_png', 'the alpha image is not a PNG (signature mismatch); only PNG alpha sources are supported.');
  let offset = 8, header = null, palette = null, transparency = null, idatState = 0;
  const idat = [];
  for (;;) {
    if (offset + 12 > buf.length) corrupt('missing IEND');
    const length = buf.readUInt32BE(offset);
    if (length > 0x7fffffff || offset + 12 + length > buf.length) corrupt('chunk runs past the end of the file');
    const typeBytes = buf.subarray(offset + 4, offset + 8), type = typeBytes.toString('latin1');
    if (!/^[A-Za-z]{4}$/.test(type)) corrupt('invalid chunk type');
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (crc32(buf.subarray(offset + 4, offset + 8 + length)) !== buf.readUInt32BE(offset + 8 + length)) corrupt(`CRC mismatch in ${type}`);
    offset += 12 + length;
    if (!header && type !== 'IHDR') corrupt('IHDR is not the first chunk');
    if (type === 'IHDR') {
      if (header) corrupt('duplicate IHDR');
      if (length !== 13) corrupt('IHDR length');
      header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colorType: data[9], compression: data[10], filter: data[11], interlace: data[12] };
      const { width, height, depth, colorType, compression, filter, interlace } = header;
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) corrupt('zero or oversized dimensions');
      if (compression !== 0 || filter !== 0 || interlace > 1) corrupt('unknown compression, filter or interlace method');
      if (!(colorType in CHANNELS)) corrupt(`invalid colour type ${colorType}`);
      if (depth !== 8) unsupported(`${depth}-bit`);
      if (interlace) unsupported('interlaced (Adam7)');
      if (width * height > MASK_LIMITS.alphaPixels) refuse('alpha_png_too_large', `the alpha image is ${width}×${height}; at most ${MASK_LIMITS.alphaPixels} pixels.`, { width, height });
      if (target) checkAlphaAspect(width, height, target.width, target.height, path);
    } else if (type === 'IDAT') {
      if (idatState === 2) corrupt('IDAT chunks are not consecutive');
      idatState = 1; idat.push(data);
    } else if (type === 'IEND') break;
    else {
      if (idatState === 1) idatState = 2;
      if (type === 'PLTE') {
        if (idatState || palette || length % 3 || !length || length > 768) corrupt('invalid PLTE');
        if (header.colorType === 0 || header.colorType === 4) corrupt('PLTE in a greyscale image');
        palette = data;
      } else if (type === 'tRNS') {
        if (idatState || transparency) corrupt('invalid tRNS');
        const { colorType } = header;
        if (colorType === 3 && (!palette || length > palette.length / 3)) corrupt('tRNS does not match PLTE');
        if ((colorType === 0 && length !== 2) || (colorType === 2 && length !== 6)) corrupt('tRNS length');
        transparency = data;
      } else if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') unsupported('animated (APNG)');
      else if (!(typeBytes[0] & 0x20)) unsupported(`using the unknown critical chunk ${type}`);
    }
  }
  if (!idat.length) corrupt('no IDAT');
  const { width, height, colorType } = header;
  if (colorType === 3 && !palette) corrupt('palette image without PLTE');
  const bpp = CHANNELS[colorType], stride = width * bpp, expected = (stride + 1) * height;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: expected }); }
  catch (error) { corrupt(error?.code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError ? 'more image data than the header declares' : 'invalid compressed data'); }
  if (raw.length !== expected) corrupt('image data length does not match the header');
  const alpha = new Uint8Array(width * height), entries = palette ? palette.length / 3 : 0;
  const key = transparency && colorType === 0 ? transparency.readUInt16BE(0) : -1;
  const [kr, kg, kb] = transparency && colorType === 2 ? [transparency.readUInt16BE(0), transparency.readUInt16BE(2), transparency.readUInt16BE(4)] : [-1, -1, -1];
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride), transparent = false;
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1), type = raw[at], src = raw.subarray(at + 1, at + 1 + stride);
    if (type === 0) cur.set(src);
    else if (type === 1) for (let i = 0; i < stride; i++) cur[i] = (src[i] + (i >= bpp ? cur[i - bpp] : 0)) & 255;
    else if (type === 2) for (let i = 0; i < stride; i++) cur[i] = (src[i] + prev[i]) & 255;
    else if (type === 3) for (let i = 0; i < stride; i++) cur[i] = (src[i] + (((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1)) & 255;
    else if (type === 4) for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0, p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      cur[i] = (src[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
    }
    else corrupt(`unknown filter type ${type}`);
    const row = y * width;
    if (colorType === 6) for (let x = 0; x < width; x++) alpha[row + x] = cur[x * 4 + 3];
    else if (colorType === 4) for (let x = 0; x < width; x++) alpha[row + x] = cur[x * 2 + 1];
    else if (colorType === 3) for (let x = 0; x < width; x++) {
      const index = cur[x];
      if (index >= entries) corrupt('palette index out of range');
      alpha[row + x] = transparency && index < transparency.length ? transparency[index] : 255;
    }
    else if (colorType === 0) for (let x = 0; x < width; x++) alpha[row + x] = cur[x] === key ? 0 : 255;
    else for (let x = 0; x < width; x++) alpha[row + x] = cur[x * 3] === kr && cur[x * 3 + 1] === kg && cur[x * 3 + 2] === kb ? 0 : 255;
    [prev, cur] = [cur, prev];
  }
  for (let i = 0; i < alpha.length && !transparent; i++) if (alpha[i] !== 255) transparent = true;
  return { width, height, alpha, colorType, hasTransparency: transparent };
}

// ---------------------------------------------------------------------------------------------- one call for prepare_recipe

/**
 * Full pipeline for one inpaint mask on a width × height source. `alphaImages` are the raw PNG bytes of each alpha
 * layer's history original, in validateMaskSpec(...).alphaRefs order. Refuses a mask with 0 selected cells
 * (BridgeError mask_empty) and a mask PNG over 4 MiB. Returns
 * { png, sha256, width, height, selectedCells, totalCells, gridWidth, gridHeight, bboxCells, layers, warnings,
 *   spec, specJsonBytes, alpha, readback } where `readback` is the design §1.7 shape
 * { sha256, width, height, selectedCells, totalCells, bboxCells, layers: [{op, kind, cells}], spec }.
 */
export function buildMask(spec, { width, height, alphaImages = [] } = {}) {
  canvas(width, height);
  const { alphaRefs } = validateMaskSpec(spec, { width, height });
  if (!Array.isArray(alphaImages) || alphaImages.length !== alphaRefs.length) throw new TypeError(`buildMask needs ${alphaRefs.length} alpha PNG(s) in layer order; got ${Array.isArray(alphaImages) ? alphaImages.length : typeof alphaImages}.`);
  const alphas = alphaRefs.map((ref, k) => decodePngAlpha(alphaImages[k], { path: `mask.layers[${ref.layer}].alpha`, target: { width, height } }));
  const composed = composeMask(spec, { width, height, alphas });
  const { selectedCells, totalCells, gridWidth, gridHeight, bboxCells, layers, warnings, alpha } = composed;
  if (!selectedCells) fail('mask_empty', 'mask_empty', `The mask selects 0 of ${totalCells} latent cells after the host's 8×8 sampling (one pixel per cell centre), so the host would refuse it as empty. Enlarge the shapes (strokes ≥ 12 px) or check subtract, invert and growPx.`,
    { selectedCells: 0, totalCells, layers: layers.map(({ index, op, kind, pixels, cells }) => ({ index, op, kind, pixels, cells })) });
  const png = encodeMaskPng(composed.selection, width, height);
  if (png.length > MASK_LIMITS.maskPngBytes) fail('invalid_arguments', 'mask_png_too_large', `The encoded mask is ${png.length} bytes; at most ${MASK_LIMITS.maskPngBytes} (4 MiB). Simplify the mask.`, { byteLength: png.length });
  const sha256 = createHash('sha256').update(png).digest('hex');
  // UTF-8 size of JSON.stringify(spec): the host keeps asset provenance (where W3 stores the spec) to 32 KB, and
  // 2048 points written with long decimals can exceed that. Reported, not enforced here.
  const specJsonBytes = Buffer.byteLength(JSON.stringify(composed.spec));
  return {
    png, sha256, width, height, selectedCells, totalCells, gridWidth, gridHeight, bboxCells, layers, warnings, spec: composed.spec, specJsonBytes, alpha,
    readback: { sha256, width, height, selectedCells, totalCells, bboxCells, layers: layers.map(({ op, kind, cells }) => ({ op, kind, cells })), spec: composed.spec },
  };
}
