/**
 * Censored JPG export: what the editor keeps (strokes, settings) and the pixel maths that needs no canvas.
 * Coordinates and sizes are in image pixels. Drawing itself is in render.ts.
 */
export type CensorStyle = 'mosaic' | 'blur' | 'black' | 'white';
export type CensorTool = 'brush' | 'lasso' | 'eraser';
export const CENSOR_STYLES: readonly CensorStyle[] = ['mosaic', 'blur', 'black', 'white'];
export const CENSOR_TOOLS: readonly CensorTool[] = ['brush', 'lasso', 'eraser'];

/** One pen movement. brush / eraser: a round line `size` wide through the points; lasso: the area the points enclose. */
export interface CensorStroke { tool: CensorTool | 'clear'; size: number; points: number[] }
export interface CensorHistory { strokes: CensorStroke[]; redo: CensorStroke[] }

export interface CensorSettings {
  style: CensorStyle;
  /** Mosaic cell edge in pixels; null follows each image (standardMosaicSize). */
  mosaicSize: number | null;
  /** Blur radius in pixels; null follows each image (standardBlurSize). */
  blurSize: number | null;
  /** Soft edge of the censored area, in pixels (0: crisp). */
  feather: number;
  /** Brush diameter in pixels; null follows each image (standardBrushSize). */
  brushSize: number | null;
  /** JPEG quality. */
  quality: number;
}
export const DEFAULT_CENSOR_SETTINGS: CensorSettings = Object.freeze({ style: 'mosaic', mosaicSize: null, blurSize: null, feather: 0, brushSize: null, quality: 95 });
export const CENSOR_RANGES = Object.freeze({
  mosaic: { min: 2, max: 96 }, blur: { min: 2, max: 96 }, feather: { min: 0, max: 48 }, brush: { min: 2, max: 600 }, quality: { min: 70, max: 100 },
});

const long = (width: number, height: number) => Math.max(1, width, height);
/**
 * The usual lower bound of doujin shops for a mosaic: cells of at least 1/100 of the image's longer side, and never
 * under 4 pixels. The default, and the finest mosaic that still meets it.
 */
export const standardMosaicSize = (width: number, height: number) => Math.max(4, Math.ceil(long(width, height) / 100));
export const standardBlurSize = (width: number, height: number) => Math.max(4, Math.round(long(width, height) / 64));
export const standardBrushSize = (width: number, height: number) => Math.max(8, Math.round(long(width, height) / 32));

const clamp = (value: number, range: { min: number; max: number }) => Math.min(range.max, Math.max(range.min, Math.round(value)));
export const mosaicSizeOf = (settings: CensorSettings, width: number, height: number) => settings.mosaicSize === null ? standardMosaicSize(width, height) : clamp(settings.mosaicSize, CENSOR_RANGES.mosaic);
export const blurSizeOf = (settings: CensorSettings, width: number, height: number) => settings.blurSize === null ? standardBlurSize(width, height) : clamp(settings.blurSize, CENSOR_RANGES.blur);
export const brushSizeOf = (settings: CensorSettings, width: number, height: number) => settings.brushSize === null ? standardBrushSize(width, height) : clamp(settings.brushSize, CENSOR_RANGES.brush);

/** Saved settings read back: unknown or out-of-range values fall back to the defaults. */
export function parseCensorSettings(raw: unknown): CensorSettings {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const size = (entry: unknown, range: { min: number; max: number }) => typeof entry === 'number' && Number.isFinite(entry) ? clamp(entry, range) : null;
  return {
    style: CENSOR_STYLES.includes(value.style as CensorStyle) ? value.style as CensorStyle : DEFAULT_CENSOR_SETTINGS.style,
    mosaicSize: size(value.mosaicSize, CENSOR_RANGES.mosaic),
    blurSize: size(value.blurSize, CENSOR_RANGES.blur),
    feather: size(value.feather, CENSOR_RANGES.feather) ?? DEFAULT_CENSOR_SETTINGS.feather,
    brushSize: size(value.brushSize, CENSOR_RANGES.brush),
    quality: size(value.quality, CENSOR_RANGES.quality) ?? DEFAULT_CENSOR_SETTINGS.quality,
  };
}
const SETTINGS_KEY = 'nai.censor.settings.v1';
export function loadCensorSettings(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): CensorSettings {
  try { return parseCensorSettings(JSON.parse(storage?.getItem(SETTINGS_KEY) ?? 'null')); } catch { return { ...DEFAULT_CENSOR_SETTINGS }; }
}
export function saveCensorSettings(settings: CensorSettings, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage) {
  try { storage?.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* the settings then last for this window only */ }
}

// ── Strokes (undo, redo) ─────────────────────────────────────────────────────
export const emptyHistory = (): CensorHistory => ({ strokes: [], redo: [] });
export const addStroke = (history: CensorHistory, stroke: CensorStroke): CensorHistory => ({ strokes: [...history.strokes, stroke], redo: [] });
export const undoStroke = (history: CensorHistory): CensorHistory => history.strokes.length
  ? { strokes: history.strokes.slice(0, -1), redo: [...history.redo, history.strokes[history.strokes.length - 1]] } : history;
export const redoStroke = (history: CensorHistory): CensorHistory => history.redo.length
  ? { strokes: [...history.strokes, history.redo[history.redo.length - 1]], redo: history.redo.slice(0, -1) } : history;
/** Clearing is a step of its own, so undo brings the strokes back. */
export const clearStrokes = (history: CensorHistory): CensorHistory => hasCensoring(history) ? addStroke(history, { tool: 'clear', size: 0, points: [] }) : history;
/** Whether anything may be covered now (strokes after the last clear that add area). */
export function hasCensoring(history: CensorHistory): boolean {
  for (let index = history.strokes.length - 1; index >= 0; index--) {
    const tool = history.strokes[index].tool;
    if (tool === 'clear') return false;
    if (tool !== 'eraser') return true;
  }
  return false;
}

/**
 * The strokes of each image, kept while the app runs: closing the editor or moving to another image loses nothing,
 * and an image can be exported again later with the same censoring.
 */
const memory = new Map<string, CensorHistory>();
const MEMORY_LIMIT = 300;
export const recallHistory = (key: string): CensorHistory => memory.get(key) ?? emptyHistory();
export function rememberHistory(key: string, history: CensorHistory) {
  memory.delete(key);
  if (history.strokes.length || history.redo.length) memory.set(key, history);
  while (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value as string);
}

// ── Mosaic ───────────────────────────────────────────────────────────────────
/**
 * The mosaic cells of an RGBA image: a grid of `block` × `block` pixel cells from the top left corner, each the plain
 * average of the pixels it covers (cells on the right and bottom edges cover what is left). Returned as a small opaque
 * RGBA image, one pixel per cell.
 */
export function mosaicCells(data: Uint8ClampedArray | Uint8Array, width: number, height: number, block: number): { width: number; height: number; data: Uint8ClampedArray } {
  const size = Math.max(1, Math.floor(block));
  const columns = Math.ceil(width / size), rows = Math.ceil(height / size);
  const sums = new Float64Array(columns * rows * 3);
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / size) * columns;
    for (let x = 0, at = y * width * 4; x < width; x++, at += 4) {
      const cell = (row + Math.floor(x / size)) * 3;
      sums[cell] += data[at]; sums[cell + 1] += data[at + 1]; sums[cell + 2] += data[at + 2];
    }
  }
  const out = new Uint8ClampedArray(columns * rows * 4);
  for (let row = 0; row < rows; row++) {
    const cellHeight = Math.min(size, height - row * size);
    for (let column = 0; column < columns; column++) {
      const count = cellHeight * Math.min(size, width - column * size), from = (row * columns + column) * 3, to = (row * columns + column) * 4;
      out[to] = Math.round(sums[from] / count); out[to + 1] = Math.round(sums[from + 1] / count); out[to + 2] = Math.round(sums[from + 2] / count); out[to + 3] = 255;
    }
  }
  return { width: columns, height: rows, data: out };
}
