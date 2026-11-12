import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCensoredExporter, encodeCensoredJpeg, handleCensoredExport } from './censored-export';

/** width × height RGBA: left half red, right half blue; alpha 254 / 255 alternating (where NovelAI hides its data). */
function pixelsOf(width: number, height: number) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set(x < width / 2 ? [220, 30, 30, 254 + ((x + y) & 1)] : [30, 30, 220, 254 + ((x + y) & 1)], (y * width + x) * 4);
  return pixels;
}
/** The marker segments of a JPEG up to the image data. */
function markers(bytes: Buffer) {
  const found: string[] = [];
  for (let at = 2; at + 4 <= bytes.length && bytes[at] === 0xff;) {
    const marker = bytes[at + 1];
    found.push(marker.toString(16));
    if (marker === 0xda) break;
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return found;
}

let folder = '';
beforeEach(async () => { folder = await fs.mkdtemp(path.join(os.tmpdir(), 'censored-export-')); });
afterEach(async () => { await fs.rm(folder, { recursive: true, force: true }); });

describe('encodeCensoredJpeg', () => {
  it('writes a JPEG of the same size with full-resolution colour and nothing but picture data', async () => {
    const bytes = await encodeCensoredJpeg(pixelsOf(64, 48), 64, 48, 95);
    const meta = await sharp(bytes).metadata();
    expect([meta.format, meta.width, meta.height, meta.channels, meta.chromaSubsampling]).toEqual(['jpeg', 64, 48, 3, '4:4:4']);
    expect(meta.hasAlpha).toBe(false);
    for (const field of ['exif', 'icc', 'xmp', 'iptc', 'comments'] as const) expect((meta as Record<string, unknown>)[field], field).toBeUndefined();
    // JFIF header, quantisation and Huffman tables, the frame and the scan: no APP1 (EXIF, XMP), APP2 (ICC), APP13 or comment.
    const allowed = new Set(['e0', 'db', 'c0', 'c2', 'c4', 'dd', 'da']);
    expect(markers(bytes).filter(marker => !allowed.has(marker))).toEqual([]);
    const { data } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    expect(Math.abs(data[0] - 220)).toBeLessThan(12); expect(Math.abs(data[(63) * 3 + 2] - 220)).toBeLessThan(12);
  });
});

describe('createCensoredExporter', () => {
  it('saves one image to the chosen file, adding .jpg and replacing what the save dialog confirmed', async () => {
    const chosen = path.join(folder, 'post');
    const chooseFile = vi.fn(async (_name: string) => chosen), chooseFolder = vi.fn();
    const run = createCensoredExporter({ chooseFile, chooseFolder });
    await fs.writeFile(`${chosen}.jpg`, 'old');
    const begun = await run({ action: 'begin', count: 1, name: '../a/b:c.png' });
    expect(begun.status).toBe('ready');
    expect(chooseFile).toHaveBeenCalledWith('b_c.jpg');
    const session = (begun as { session: string }).session;
    const written = await run({ action: 'write', session, name: 'ignored', width: 32, height: 16, pixels: pixelsOf(32, 16), quality: 90 });
    expect(written).toMatchObject({ status: 'written', file: 'post.jpg' });
    expect((await sharp(await fs.readFile(`${chosen}.jpg`)).metadata()).width).toBe(32);
    await expect(run({ action: 'write', session, name: 'x', width: 32, height: 16, pixels: pixelsOf(32, 16), quality: 90 })).rejects.toThrow();
    expect(await run({ action: 'finish', session })).toEqual({ status: 'done', written: 1, reveal: `${chosen}.jpg` });
    await expect(run({ action: 'finish', session })).rejects.toThrow();
    expect((await fs.readdir(folder)).sort()).toEqual(['post.jpg']);
  });

  it('saves several images into the chosen folder under their names and never replaces a file', async () => {
    const run = createCensoredExporter({ chooseFile: vi.fn(), chooseFolder: async () => folder });
    await fs.writeFile(path.join(folder, 'a.jpg'), 'mine');
    const begun = await run({ action: 'begin', count: 3, name: 'a' }) as { session: string };
    const write = (name: string) => run({ action: 'write', session: begun.session, name, width: 8, height: 8, pixels: pixelsOf(8, 8), quality: 95 });
    expect(await write('a.png')).toMatchObject({ file: 'a (2).jpg' });
    expect(await write('a.png')).toMatchObject({ file: 'a (3).jpg' });
    expect(await write('../b')).toMatchObject({ file: 'b.jpg' });
    expect(await run({ action: 'finish', session: begun.session })).toEqual({ status: 'done', written: 3, reveal: path.join(folder, 'a (2).jpg') });
    expect(await fs.readFile(path.join(folder, 'a.jpg'), 'utf8')).toBe('mine');
    expect((await fs.readdir(folder)).sort()).toEqual(['a (2).jpg', 'a (3).jpg', 'a.jpg', 'b.jpg']);
  });

  it('reports a cancelled dialog and refuses malformed requests', async () => {
    const run = createCensoredExporter({ chooseFile: async () => undefined, chooseFolder: async () => folder });
    expect(await run({ action: 'begin', count: 1, name: 'a' })).toEqual({ status: 'cancelled' });
    await expect(run({ action: 'begin', count: 0, name: 'a' })).rejects.toThrow();
    await expect(run({ action: 'begin', count: 101, name: 'a' })).rejects.toThrow();
    await expect(run({ action: 'write', session: 'nope', name: 'a', width: 8, height: 8, pixels: pixelsOf(8, 8), quality: 95 })).rejects.toThrow();
    const begun = await run({ action: 'begin', count: 2, name: 'a' }) as { session: string };
    const base = { action: 'write', session: begun.session, name: 'a', width: 8, height: 8, pixels: pixelsOf(8, 8), quality: 95 };
    await expect(run({ ...base, pixels: pixelsOf(8, 7) })).rejects.toThrow();
    await expect(run({ ...base, pixels: [...pixelsOf(8, 8)] })).rejects.toThrow();
    await expect(run({ ...base, quality: 101 })).rejects.toThrow();
    await expect(run({ ...base, width: 8.5 })).rejects.toThrow();
    await expect(run({ ...base, width: 100_000, height: 100_000 })).rejects.toThrow();
    await expect(run({ action: 'other' })).rejects.toThrow();
    expect(await fs.readdir(folder)).toEqual([]);
  });
});

describe('handleCensoredExport', () => {
  const frame = {}, window = { isDestroyed: () => false, webContents: { id: 7, mainFrame: frame } } as any;
  it('answers only the main frame of the main window, and turns a failure into a host error', async () => {
    const run = vi.fn(async () => ({ status: 'cancelled' as const }));
    expect(await handleCensoredExport({ sender: { id: 7 }, senderFrame: frame } as any, window, {}, run)).toEqual({ ok: true, result: { status: 'cancelled' } });
    expect(await handleCensoredExport({ sender: { id: 8 }, senderFrame: frame } as any, window, {}, run)).toMatchObject({ ok: false, error: { code: 'forbidden_workspace' } });
    expect(await handleCensoredExport({ sender: { id: 7 }, senderFrame: {} } as any, window, {}, run)).toMatchObject({ ok: false, error: { code: 'forbidden_workspace' } });
    expect(run).toHaveBeenCalledTimes(1);
    expect(await handleCensoredExport({ sender: { id: 7 }, senderFrame: frame } as any, window, {}, async () => { throw new Error('disk'); })).toMatchObject({ ok: false, error: { code: 'export_failed', reason: 'library.censored_export_failed' } });
  });
});
