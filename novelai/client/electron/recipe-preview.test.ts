import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import sharp from 'sharp';
vi.mock('axios', () => ({ default: { get: () => { throw new Error('No network'); }, post: () => { throw new Error('No network'); } } }));
vi.mock('./ipc/store', () => ({ getToken: () => { throw new Error('No account'); }, getSettings: () => { throw new Error('No settings'); } }));
vi.mock('electron', () => ({ app: {}, dialog: {}, nativeImage: { createFromBuffer: (buffer: Buffer) => {
  const png = PNG.sync.read(buffer);
  return { isEmpty: () => false, getSize: () => ({ width: png.width, height: png.height }), toPNG: () => buffer, resize: () => ({ toPNG: () => buffer }) };
} } }));
import { createQueueRecipeService } from './queue-recipe-service';
import { RECIPE_PREVIEW_LIMITS } from './recipe-preview';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const gray = (width: number, height: number) => { const png = new PNG({ width, height }); for (let index = 0; index < png.data.length; index += 4) png.data.set([128, 128, 128, 255], index); return PNG.sync.write(png); };
/** Opaque white rectangle on black, in source pixels. */
const rectMask = (width: number, height: number, rect: { x: number; y: number; w: number; h: number }) => {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const on = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h ? 255 : 0; png.data.set([on, on, on, 255], (y * width + x) * 4); }
  return PNG.sync.write(png);
};
const recipe = { positivePrompt: 'garden, bench', negativePrompt: '', stylePrompt: '', model: 'nai-diffusion-4-5-full', steps: 28, cfgScale: 5, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', seed: 9, seedMode: 'fixed', ucPreset: 0, qualityPreset: 'standard', qualityToggle: true, promptAssemblyVersion: 1 };
const inpaint = (assets: Record<string, unknown>[]) => ({ mode: 'inpaint', authored: { params: {}, inpaintModel: 'nai-diffusion-4-5-full-inpainting', inpaintStrength: 0.8, inpaintRecipe: recipe }, assets });

const cleanups: string[] = [];
afterEach(() => runCleanups(cleanups.splice(0).map(dir => () => fs.rm(dir, { recursive: true, force: true }))));
async function tree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name), info = await fs.lstat(file);
    if (entry.isDirectory()) for (const [name, value] of Object.entries(await tree(file))) result[`${entry.name}/${name}`] = value;
    else result[entry.name] = `${info.size}:${info.mtimeMs}:${sha256(await fs.readFile(file))}`;
  }
  return result;
}
async function setup() {
  const runtimeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nai-recipe-preview-'))); cleanups.push(runtimeDir);
  const originals = new Map<string, Buffer>();
  const readHistoryOriginal = vi.fn(async (args: any) => {
    const bytes = originals.get(`${args.id}:${args.revision}:${args.assetId}`);
    if (!bytes) throw Object.assign(new Error('missing'), { code: 'library_not_found' });
    return { kind: 'history', id: args.id, revision: args.revision, assetId: args.assetId, variant: 'original', mimeType: 'image/png', data: bytes.toString('base64') };
  });
  const batch = { ready: Promise.resolve(), enqueue: vi.fn(async () => { throw new Error('preview never enqueues'); }), lookup: vi.fn(() => null), list: vi.fn(() => ({ batches: [] })), read: vi.fn(), pause: vi.fn(), resume: vi.fn(), cancel: vi.fn() };
  const service = createQueueRecipeService({ runtimeDir, batch, readHistoryOriginal });
  const historySource = (id: string, bytes: Buffer) => { originals.set(`${id}:1:${id}-original`, bytes); return { role: 'source', mimeType: 'image/png', ref: { kind: 'history', id, revision: 1, assetId: `${id}-original` }, sha256: sha256(bytes), byteLength: bytes.length }; };
  return { service, batch, runtimeDir, readHistoryOriginal, historySource };
}

describe('preview_queue_recipe (H9)', () => {
  it('writes nothing — no directory on a fresh runtime, byte-identical store on a used one — and returns a WebP overlay of the actual request mask', async () => {
    const { service, runtimeDir, historySource, batch } = await setup();
    const source = historySource('history-preview', gray(832, 1216)), mask = rectMask(832, 1216, { x: 208, y: 304, w: 416, h: 304 });
    const preparation = inpaint([source, { role: 'mask', mimeType: 'image/png', data: mask.toString('base64'), provenance: { spec: { units: 'px', layers: [{ op: 'add', shape: { type: 'rect', x: 208, y: 304, width: 416, height: 304 } }] } } }]);
    expect(await fs.readdir(runtimeDir)).toEqual([]);
    const preview = await service.preview_queue_recipe({ preparation });
    expect(await fs.readdir(runtimeDir)).toEqual([]); // not even queue-recipes/ is created
    expect(preview).toMatchObject({ preview: true, saved: false, recipeId: null, recipeRevision: null, snapshot: { schemaVersion: 1, workspaceId: null, revision: null, draftId: null, mode: 'inpaint', reviewInput: { readiness: { status: 'ready' } } } });
    const image = preview.previewImage!;
    expect(image).toMatchObject({ mimeType: 'image/webp', width: 525, height: 768, basis: { sourceRole: 'request-source', maskRole: 'request-mask', width: 832, height: 1216 }, cells: { selected: (416 / 8) * (304 / 8), total: (832 / 8) * (1216 / 8) } });
    const bytes = Buffer.from(image.data, 'base64');
    expect(bytes.length).toBe(image.byteLength); expect(image.byteLength).toBeLessThanOrEqual(RECIPE_PREVIEW_LIMITS.maxBytes); expect(sha256(bytes)).toBe(image.sha256);
    expect([bytes.toString('ascii', 0, 4), bytes.toString('ascii', 8, 12)]).toEqual(['RIFF', 'WEBP']);
    const decoded = await sharp(bytes).raw().toBuffer({ resolveWithObject: true }), pixel = (x: number, y: number) => [...decoded.data.subarray((y * decoded.info.width + x) * decoded.info.channels, (y * decoded.info.width + x) * decoded.info.channels + 3)];
    const [insideRed, insideGreen] = pixel(262, 344), outside = pixel(40, 40);
    expect(insideRed).toBeGreaterThan(170); expect(insideGreen).toBeLessThan(105); // tinted red over gray
    for (const channel of outside) expect(Math.abs(channel - 128)).toBeLessThan(10); // untouched gray

    // The preview is the would-be put: same input, readback and asset details, without identity.
    const saved = await service.put_queue_recipe({ preparation });
    expect(preview.inputHash).toBe(saved.inputHash);
    expect(preview.snapshot.reviewInput).toEqual(saved.snapshot.reviewInput);
    expect(preview.characterIds).toEqual(saved.characterIds);
    expect({ assetRefs: preview.assetRefs, assetBytes: preview.assetBytes, assetProvenance: preview.assetProvenance }).toEqual({ assetRefs: saved.assetRefs, assetBytes: saved.assetBytes, assetProvenance: saved.assetProvenance });

    // On a used store: every file is byte-identical (and untouched) after previews, including a failing one.
    const before = await tree(runtimeDir);
    const smaller = await service.preview_queue_recipe({ preparation: inpaint([source, { role: 'mask', mimeType: 'image/png', data: rectMask(832, 1216, { x: 0, y: 0, w: 64, h: 64 }).toString('base64') }]), assetData: 'omit' });
    expect(smaller.previewImage!.cells.selected).toBe(64);
    expect(smaller.snapshot.reviewInput.assets.every((asset: any) => !('data' in asset))).toBe(true);
    await expect(service.preview_queue_recipe({ preparation: inpaint([{ ...source, ref: { ...source.ref, id: 'history-gone' } }, { role: 'mask', mimeType: 'image/png', data: mask.toString('base64') }]) })).rejects.toMatchObject({ code: 'recipe_source_unavailable' });
    await expect(service.preview_queue_recipe({ preparation: inpaint([source, { role: 'mask', mimeType: 'image/png', data: gray(832, 1216).toString('base64') }]) })).resolves.toMatchObject({ previewImage: null, snapshot: { reviewInput: { readiness: { status: 'blocked' } } } });
    expect(await tree(runtimeDir)).toEqual(before);
    expect(batch.enqueue).not.toHaveBeenCalled();
  });

  it('is a dry run for every mode: no image outside a ready inpaint, the same inputHash as the put, and no identity arguments', async () => {
    const { service, runtimeDir, historySource } = await setup();
    const t2i = { mode: 't2i', authored: { params: { ...recipe, width: 64, height: 64 } }, assets: [] };
    const source = historySource('history-small', gray(64, 64));
    const cases = [t2i, { mode: 'i2i', authored: { params: { ...recipe, width: 64, height: 64 }, i2iParams: { strength: 0.5, noise: 0 } }, assets: [source] }, { mode: 'upscale', authored: { params: {}, upscaleScale: 2 }, assets: [source] }, { mode: 'director', authored: { params: {}, directorTool: 'bg-removal' }, assets: [source] }];
    const previews = [];
    for (const preparation of cases) previews.push(await service.preview_queue_recipe({ preparation }));
    expect(await fs.readdir(runtimeDir)).toEqual([]);
    for (const [index, preparation] of cases.entries()) {
      expect(previews[index]).toMatchObject({ preview: true, saved: false, recipeId: null, previewImage: null, snapshot: { mode: preparation.mode, reviewInput: { readiness: { status: 'ready' } } } });
      expect(previews[index].inputHash).toBe((await service.put_queue_recipe({ preparation })).inputHash);
    }
    const files = await tree(runtimeDir);
    await expect(service.preview_queue_recipe({ preparation: t2i, recipeId: randomUUID(), expectedRevision: 1 })).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(service.preview_queue_recipe({ preparation: { ...t2i, mode: 'variation' } })).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(service.preview_queue_recipe({ preparation: t2i, assetData: 'none' })).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(await tree(runtimeDir)).toEqual(files);
  });
});
