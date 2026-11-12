import { describe, expect, it } from 'vitest';
import {
  addStroke, clearStrokes, DEFAULT_CENSOR_SETTINGS, emptyHistory, hasCensoring, loadCensorSettings, mosaicCells, mosaicSizeOf, parseCensorSettings, recallHistory, redoStroke, rememberHistory,
  saveCensorSettings, standardMosaicSize, undoStroke, type CensorStroke,
} from './model';
import { censoredExportStem, isCensoredExportResult } from './export-types';

const brush = (x: number): CensorStroke => ({ tool: 'brush', size: 20, points: [x, 0, x + 5, 5] });

describe('mosaic size', () => {
  it('defaults to 1/100 of the longer side, never under 4 px', () => {
    expect(standardMosaicSize(1024, 1536)).toBe(16);
    expect(standardMosaicSize(1536, 1024)).toBe(16);
    expect(standardMosaicSize(832, 1216)).toBe(13);
    expect(standardMosaicSize(1000, 1000)).toBe(10);
    expect(standardMosaicSize(320, 200)).toBe(4);
    expect(mosaicSizeOf(DEFAULT_CENSOR_SETTINGS, 2048, 3072)).toBe(31);
  });
  it('uses the chosen size when there is one, within the range', () => {
    expect(mosaicSizeOf({ ...DEFAULT_CENSOR_SETTINGS, mosaicSize: 6 }, 1024, 1536)).toBe(6);
    expect(mosaicSizeOf({ ...DEFAULT_CENSOR_SETTINGS, mosaicSize: 1000 }, 1024, 1536)).toBe(96);
  });
});

describe('mosaicCells', () => {
  it('averages each cell, with the cells of the right and bottom edges covering what is left', () => {
    // 5 × 3 pixels, cells of 2: columns 2 + 2 + 1, rows 2 + 1. The red channel is x * 10 + y, green 100, blue 0.
    const width = 5, height = 3, data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([x * 10 + y, 100, 0, 255], (y * width + x) * 4);
    const cells = mosaicCells(data, width, height, 2);
    expect([cells.width, cells.height]).toEqual([3, 2]);
    const red = (column: number, row: number) => cells.data[(row * cells.width + column) * 4];
    expect(red(0, 0)).toBe(Math.round((0 + 10 + 1 + 11) / 4));
    expect(red(1, 0)).toBe(Math.round((20 + 30 + 21 + 31) / 4));
    expect(red(2, 0)).toBe(Math.round((40 + 41) / 2));
    expect(red(0, 1)).toBe(Math.round((2 + 12) / 2));
    expect(red(2, 1)).toBe(42);
    for (let cell = 0; cell < 6; cell++) expect([...cells.data.slice(cell * 4 + 1, cell * 4 + 4)]).toEqual([100, 0, 255]);
  });
  it('keeps a flat colour flat and ignores the source alpha', () => {
    const data = new Uint8ClampedArray(7 * 7 * 4);
    for (let at = 0; at < data.length; at += 4) data.set([12, 200, 99, at % 8 ? 254 : 255], at);
    const cells = mosaicCells(data, 7, 7, 3);
    expect([cells.width, cells.height]).toEqual([3, 3]);
    for (let cell = 0; cell < 9; cell++) expect([...cells.data.slice(cell * 4, cell * 4 + 4)]).toEqual([12, 200, 99, 255]);
  });
});

describe('strokes', () => {
  it('undoes and redoes, and a new stroke drops what could be redone', () => {
    let history = addStroke(addStroke(emptyHistory(), brush(1)), brush(2));
    history = undoStroke(history);
    expect(history.strokes).toHaveLength(1); expect(history.redo).toHaveLength(1);
    history = redoStroke(history);
    expect(history.strokes.map(stroke => stroke.points[0])).toEqual([1, 2]);
    history = addStroke(undoStroke(history), brush(3));
    expect(history.strokes.map(stroke => stroke.points[0])).toEqual([1, 3]);
    expect(history.redo).toEqual([]);
    expect(undoStroke(emptyHistory())).toEqual(emptyHistory());
  });
  it('clears as a step that undo takes back', () => {
    const drawn = addStroke(emptyHistory(), brush(1));
    const cleared = clearStrokes(drawn);
    expect(hasCensoring(drawn)).toBe(true);
    expect(hasCensoring(cleared)).toBe(false);
    expect(hasCensoring(undoStroke(cleared))).toBe(true);
    expect(clearStrokes(cleared)).toBe(cleared);
    expect(hasCensoring(addStroke(emptyHistory(), { tool: 'eraser', size: 10, points: [0, 0] }))).toBe(false);
  });
  it('remembers the strokes of an image while the app runs', () => {
    const history = addStroke(emptyHistory(), brush(7));
    rememberHistory('history:a', history);
    expect(recallHistory('history:a')).toBe(history);
    expect(recallHistory('history:b')).toEqual(emptyHistory());
    rememberHistory('history:a', emptyHistory());
    expect(recallHistory('history:a')).toEqual(emptyHistory());
  });
});

describe('settings', () => {
  it('falls back to the defaults for anything unknown or out of range', () => {
    expect(parseCensorSettings(null)).toEqual(DEFAULT_CENSOR_SETTINGS);
    expect(parseCensorSettings({ style: 'sticker', mosaicSize: 'big', feather: -3, quality: 5, brushSize: 9999 })).toEqual({ ...DEFAULT_CENSOR_SETTINGS, feather: 0, quality: 70, brushSize: 600 });
    expect(parseCensorSettings({ style: 'blur', mosaicSize: 8, blurSize: 20, feather: 6, brushSize: 44, quality: 90 })).toEqual({ style: 'blur', mosaicSize: 8, blurSize: 20, feather: 6, brushSize: 44, quality: 90 });
  });
  it('saves and reads back', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(loadCensorSettings(storage)).toEqual(DEFAULT_CENSOR_SETTINGS);
    saveCensorSettings({ ...DEFAULT_CENSOR_SETTINGS, style: 'black', quality: 88 }, storage);
    expect(loadCensorSettings(storage)).toEqual({ ...DEFAULT_CENSOR_SETTINGS, style: 'black', quality: 88 });
    values.set([...values.keys()][0], '{broken');
    expect(loadCensorSettings(storage)).toEqual(DEFAULT_CENSOR_SETTINGS);
  });
});

describe('export names and results', () => {
  it('makes a file name stem, never a path', () => {
    expect(censoredExportStem('proj_2026-11-03_01_nai-diffusion-5-full.png')).toBe('proj_2026-11-03_01_nai-diffusion-5-full');
    expect(censoredExportStem('/Users/a/Pictures/夏日 01.JPEG')).toBe('夏日 01');
    expect(censoredExportStem('..\\..\\evil:name?.webp')).toBe('evil_name_');
    expect(censoredExportStem('  ...  ')).toBe('image');
    expect(censoredExportStem('CON.png')).toBe('image');
    expect(censoredExportStem(undefined)).toBe('image');
    expect(censoredExportStem('x'.repeat(300)).length).toBe(120);
  });
  it('accepts only complete results', () => {
    expect(isCensoredExportResult({ status: 'cancelled' })).toBe(true);
    expect(isCensoredExportResult({ status: 'ready', session: 'abc' })).toBe(true);
    expect(isCensoredExportResult({ status: 'ready' })).toBe(false);
    expect(isCensoredExportResult({ status: 'written', bytes: 10, file: 'a.jpg' })).toBe(true);
    expect(isCensoredExportResult({ status: 'written', bytes: 0, file: 'a.jpg' })).toBe(false);
    expect(isCensoredExportResult({ status: 'done', written: 2, reveal: null })).toBe(true);
    expect(isCensoredExportResult({ status: 'saved' })).toBe(false);
    expect(isCensoredExportResult(undefined)).toBe(false);
  });
});
