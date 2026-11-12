import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { createCensorImageMethod, renderCensoredPixels } from './censor-image';
import { mosaicCells } from '../src/censor/model';

const W = 64, H = 48;
/** A picture with detail everywhere: red and green ramps, blue stripes; alpha 254 / 255 as NovelAI's stealth data leaves it. */
function sourcePixels(alpha = true) {
  const pixels = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) pixels.set([x * 4, y * 5, (x + y) % 2 ? 230 : 20, alpha ? 254 + ((x * y) & 1) : 255], (y * W + x) * 4);
  return pixels;
}
const sourcePng = (pixels = sourcePixels()) => sharp(pixels, { raw: { width: W, height: H, channels: 4 } }).png().withExif({ IFD0: { ImageDescription: 'SECRET_PROMPT' } }).toBuffer();
/** 8-bit greyscale mask PNG: 255 inside the rectangle. */
function maskPng(x0: number, y0: number, x1: number, y1: number, width = W, height = H) {
  const mask = Buffer.alloc(width * height);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mask[y * width + x] = 255;
  return sharp(mask, { raw: { width, height, channels: 1 } }).png().toBuffer();
}
const at = (pixels: Buffer, x: number, y: number) => [...pixels.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)];
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('renderCensoredPixels', () => {
  it('puts the mosaic cells of the whole image inside the mask and leaves the rest as it was', async () => {
    const source = await sourcePng(), flat = await sharp(source).flatten({ background: '#fff' }).ensureAlpha().raw().toBuffer();
    const result = await renderCensoredPixels({ source, mask: await maskPng(16, 8, 48, 40), style: 'mosaic', sizePx: 8, featherPx: 0 });
    expect([result.width, result.height, result.sizePx]).toEqual([W, H, 8]);
    expect(result.covered).toEqual({ pixels: 32 * 32, fraction: (32 * 32) / (W * H), bbox: { x: 16, y: 8, width: 32, height: 32 } });
    const cells = mosaicCells(flat, W, H, 8);
    // Well inside: exactly the cell's mean. Well outside: untouched. Always opaque.
    for (const [x, y] of [[20, 12], [31, 23], [44, 36]]) { const cell = (Math.floor(y / 8) * cells.width + Math.floor(x / 8)) * 4; expect(at(result.pixels, x, y)).toEqual([...cells.data.subarray(cell, cell + 3), 255]); }
    for (const [x, y] of [[2, 2], [10, 20], [60, 44], [30, 3]]) expect(at(result.pixels, x, y)).toEqual(at(flat, x, y));
    // The edge is one soft pixel wide: just inside is mostly the cell, just outside mostly the picture.
    const inside = at(result.pixels, 16, 20), cellAt = (Math.floor(20 / 8) * cells.width + 2) * 4;
    expect(Math.abs(inside[0] - cells.data[cellAt])).toBeLessThan(Math.abs(inside[0] - at(flat, 16, 20)[0]) + 1);
  });

  it('follows the image for the default cell size, and covers with black, white and blur', async () => {
    const source = await sourcePng(), flat = await sharp(source).flatten({ background: '#fff' }).ensureAlpha().raw().toBuffer(), mask = await maskPng(8, 8, 56, 40);
    expect((await renderCensoredPixels({ source, mask, style: 'mosaic', featherPx: 0 })).sizePx).toBe(4);
    const black = await renderCensoredPixels({ source, mask, style: 'black', featherPx: 0 });
    expect(at(black.pixels, 30, 20)).toEqual([0, 0, 0, 255]); expect(black.sizePx).toBeNull();
    expect(at((await renderCensoredPixels({ source, mask, style: 'white', featherPx: 0 })).pixels, 30, 20)).toEqual([255, 255, 255, 255]);
    const blur = await renderCensoredPixels({ source, mask, style: 'blur', sizePx: 6, featherPx: 0 });
    // The stripes (blue 20 / 230 on neighbouring pixels) are gone inside and still there outside.
    expect(Math.abs(at(blur.pixels, 30, 20)[2] - at(blur.pixels, 31, 20)[2])).toBeLessThan(12);
    expect(Math.abs(at(blur.pixels, 2, 2)[2] - at(blur.pixels, 3, 2)[2])).toBe(210);
    expect(at(blur.pixels, 2, 2)).toEqual(at(flat, 2, 2));
    // A soft edge reaches further than the crisp one.
    const soft = await renderCensoredPixels({ source, mask, style: 'black', featherPx: 12 });
    expect(at(soft.pixels, 4, 20)[0]).toBeLessThan(at(black.pixels, 4, 20)[0]);
    expect(at(soft.pixels, 30, 24)).toEqual([0, 0, 0, 255]);
  });

  it('puts a transparent picture on white and refuses a mask of another size', async () => {
    const clear = Buffer.alloc(W * H * 4);
    const result = await renderCensoredPixels({ source: await sharp(clear, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer(), mask: await maskPng(0, 0, 8, 8), style: 'mosaic', sizePx: 4, featherPx: 0 });
    expect(at(result.pixels, 40, 40)).toEqual([255, 255, 255, 255]); expect(at(result.pixels, 2, 2)).toEqual([255, 255, 255, 255]);
    await expect(renderCensoredPixels({ source: await sourcePng(), mask: await maskPng(0, 0, 4, 4, 32, 24), style: 'mosaic', featherPx: 0 })).rejects.toMatchObject({ code: 'invalid_argument' });
  });
});

describe('censor_image', () => {
  const target = { kind: 'history', id: 'h1', revision: 2, assetId: 'a1' } as const;
  async function setup() {
    const source = await sourcePng();
    const readOriginal = vi.fn(async () => ({ data: source.toString('base64'), mimeType: 'image/png', width: W, height: H, sha256: sha(source), assetId: 'a1' }));
    return { source, readOriginal, run: createCensorImageMethod(readOriginal), mask: (await maskPng(16, 8, 48, 40)).toString('base64') };
  }

  it('returns the JPEG of the image size with nothing but picture data', async () => {
    const { source, readOriginal, run, mask } = await setup();
    const result = await run({ ...target, sourceSha256: sha(source), mask, style: 'mosaic', sizePx: 8, featherPx: 0, quality: 90, preview: false });
    expect(readOriginal).toHaveBeenCalledWith(target);
    expect(result).toMatchObject({ ...target, preview: false, saved: false, style: 'mosaic', sizePx: 8, featherPx: 0, quality: 90, source: { width: W, height: H, sha256: sha(source) }, covered: { pixels: 1024 } });
    const bytes = Buffer.from(result.image.data, 'base64'), meta = await sharp(bytes).metadata();
    expect(result.image).toMatchObject({ mimeType: 'image/jpeg', width: W, height: H, byteLength: bytes.length, sha256: sha(bytes) });
    expect([meta.format, meta.width, meta.height, meta.chromaSubsampling, meta.exif, meta.icc, meta.xmp]).toEqual(['jpeg', W, H, '4:4:4', undefined, undefined, undefined]);
    expect(bytes.toString('latin1')).not.toContain('SECRET_PROMPT');
    // The covered area is flat cells (JPEG noise aside); the picture outside still has its stripes.
    const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer();
    expect(Math.abs(at(decoded, 26, 18)[2] - at(decoded, 27, 18)[2])).toBeLessThan(16);
    expect(Math.abs(at(decoded, 4, 4)[2] - at(decoded, 5, 4)[2])).toBeGreaterThan(150);
  });

  it('returns a WebP preview and takes a study without assetId', async () => {
    const { run, readOriginal, mask } = await setup();
    const result = await run({ kind: 'study', id: 's1', revision: 1, mask, style: 'black', preview: true });
    expect(readOriginal).toHaveBeenCalledWith({ kind: 'study', id: 's1', revision: 1 });
    expect(result).toMatchObject({ kind: 'study', preview: true, saved: false, style: 'black', sizePx: null, featherPx: 0, quality: null });
    const bytes = Buffer.from(result.image.data, 'base64');
    expect((await sharp(bytes).metadata()).format).toBe('webp');
    expect(result.image).toMatchObject({ mimeType: 'image/webp', width: W, height: H, byteLength: bytes.length });
  });

  it('refuses another original than the mask was made for, and malformed requests before reading anything', async () => {
    const { run, readOriginal, mask } = await setup();
    await expect(run({ ...target, sourceSha256: 'f'.repeat(64), mask, style: 'mosaic', preview: false })).rejects.toMatchObject({ code: 'image_changed' });
    readOriginal.mockClear();
    const base = { ...target, mask, style: 'mosaic', preview: false };
    for (const bad of [{ ...base, style: 'sticker' }, { ...base, sizePx: 1 }, { ...base, style: 'black', sizePx: 8 }, { ...base, featherPx: 49 }, { ...base, quality: 59 }, { ...base, preview: undefined }, { ...base, mask: 'not base64!' },
      { ...base, mask: Buffer.from('plain text').toString('base64') }, { ...base, assetId: undefined }, { ...base, kind: 'tag' }, { ...base, path: '/tmp/x' }, { ...base, kind: 'study' }, null])
      await expect(run(bad), JSON.stringify(bad)?.slice(0, 80)).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(readOriginal).not.toHaveBeenCalled();
    readOriginal.mockResolvedValueOnce({ data: 'R0lGODlh', mimeType: 'image/gif', width: 1, height: 1, sha256: 'x', assetId: 'a1' });
    await expect(run(base)).rejects.toMatchObject({ code: 'unsupported_image' });
  });
});
