import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import sharp from 'sharp';
vi.mock('axios', () => ({ default: { get: () => { throw new Error('No network'); }, post: () => { throw new Error('No network'); } } }));
vi.mock('./ipc/store', () => ({ getToken: () => { throw new Error('No account'); }, getSettings: () => { throw new Error('No settings'); } }));
vi.mock('./ipc/logger', () => ({ logError: vi.fn(), logInfo: vi.fn(), appendLog: vi.fn() }));
// Electron nativeImage decodes the V4.5 pad path and resizes i2i sources; sharp does the V5 bucket path itself.
vi.mock('electron', async () => {
  const { PNG } = await import('pngjs');
  const wrap = (buffer: Buffer): any => {
    let png: PNG; try { png = PNG.sync.read(buffer); } catch { return { isEmpty: () => true }; }
    return { isEmpty: () => false, getSize: () => ({ width: png.width, height: png.height }), toPNG: () => PNG.sync.write(png),
      resize: ({ width, height }: { width: number; height: number }) => {
        const out = new PNG({ width, height });
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const src = (Math.min(png.height - 1, Math.floor(y * png.height / height)) * png.width + Math.min(png.width - 1, Math.floor(x * png.width / width))) * 4;
          png.data.copy(out.data, (y * width + x) * 4, src, src + 4);
        }
        return wrap(PNG.sync.write(out));
      } };
  };
  return { app: {}, dialog: {}, nativeImage: { createFromBuffer: wrap } };
});
import { createQueueRecipeService, estimateFrozenBatchBytes, normalizeQueuePreparation, shareReferenceImages, type ReadHistoryOriginal } from './queue-recipe-service';
import { inflateReferenceImages, referenceTableProblem } from './batch-service';
import { canvasPreparation } from './canvas-recipe-capture';
import { createHistoryImageReader } from './asset-library-image';
import { runCleanups } from '../src/test-support/temp-dirs';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const gradientPng = (width = 64, height = 64, shift = 0) => { const png = new PNG({ width, height }); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const i = (y * width + x) * 4; png.data[i] = (x * 4 + shift) & 255; png.data[i + 1] = (y * 4) & 255; png.data[i + 2] = (x ^ y) & 255; png.data[i + 3] = 255; } return PNG.sync.write(png); };
const params = (model = 'nai-diffusion-5-full', positivePrompt = 'teacup, table') => ({ model, positivePrompt, negativePrompt: 'text, watermark', seed: 42, seedMode: 'fixed', width: 64, height: 64, promptAssemblyVersion: 1 });
const item = (value: any, seed?: number) => ({ recipeId: value.recipeId, recipeRevision: value.recipeRevision, inputHash: value.inputHash, ...(seed === undefined ? {} : { seed }) });
const inline = (index: number, bytes: Buffer) => ({ role: `preciseReferences:${index}`, mimeType: 'image/png', data: bytes.toString('base64') });
const byReference = (index: number, target: { kind: 'history'; id: string; revision: number; assetId: string }, bytes: Buffer) =>
  ({ role: `preciseReferences:${index}`, mimeType: 'image/png', ref: { kind: target.kind, id: target.id, revision: target.revision, assetId: target.assetId }, sha256: sha256(bytes), byteLength: bytes.length });
const t2i = (references: unknown[], assets: unknown[], model?: string, prompt?: string) => ({ mode: 't2i', authored: { params: params(model, prompt), preciseReferences: references }, assets });
const assetOf = (saved: any, role: string) => saved.snapshot.reviewInput.assets.find((asset: any) => asset.role === role);

const cleanups: string[] = [];
afterEach(async () => { await runCleanups(cleanups.splice(0).map(dir => () => fs.rm(dir, { recursive: true, force: true }))); });
const temporary = async (prefix: string) => { const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix))); cleanups.push(dir); return dir; };

/** Minimal version-addressed history library for the real host reader: originals are real files. */
async function historyLibrary() {
  const root = await temporary('nai-precise-history-'), versions = new Map<string, Map<number, any>>();
  const add = async (id: string, revision: number, bytes: Buffer) => {
    const filePath = path.join(root, `${id}-${randomUUID()}.png`); await fs.writeFile(filePath, bytes);
    const asset = { id: `${id}-original`, role: 'original', payload: { filePath, mimeType: 'image/png', sha256: sha256(bytes), byteLength: bytes.length } };
    if (!versions.has(id)) versions.set(id, new Map());
    versions.get(id)!.set(revision, { item: { kind: 'history', id, revision }, assets: [asset] });
    return { kind: 'history' as const, id, revision, assetId: asset.id, filePath };
  };
  const repo = {
    get: (_kind: string, id: string, revision?: number) => { const all = versions.get(id); if (!all) return null; return revision === undefined ? [...all.values()].at(-1).item : all.get(revision)?.item ?? null; },
    versionAssets: (item: any) => versions.get(item.id)!.get(item.revision).assets,
  };
  return { add, reader: createHistoryImageReader(repo as any) };
}

async function setup(readHistoryOriginal?: ReadHistoryOriginal) {
  const runtimeDir = await temporary('nai-queue-precise-');
  const jobs = new Map<string, any>(), submitted: any[] = [];
  const batch = { ready: Promise.resolve(), enqueue: vi.fn(async (args: any) => {
    submitted.push(structuredClone({ snapshot: args.snapshot, snapshots: args.snapshots }));
    const job = { ...args, batchId: randomUUID(), originWorkspaceId: args.workspaceId, submittedRevision: 0, status: 'queued', items: args.seeds.map((plannedSeed: number, index: number) => ({ index, plannedSeed, status: 'pending', jobId: null, results: [] })) };
    delete job.snapshots; delete job.snapshot; jobs.set(args.requestKey, job); return job;
  }), lookup: vi.fn((args: any) => jobs.get(args.requestKey) ?? null), list: vi.fn(() => ({ batches: [...jobs.values()] })), read: vi.fn(), pause: vi.fn(), resume: vi.fn(), cancel: vi.fn() };
  const service = createQueueRecipeService({ runtimeDir, batch, randomSeed: () => 97, ...(readHistoryOriginal ? { readHistoryOriginal } : {}) });
  return { service, batch, submitted, store: path.join(runtimeDir, 'queue-recipes') };
}

describe('precise references in queued recipes', () => {
  it('a V5 t2i recipe is ready with its references prepared as the request sends them, by library reference or inline', async () => {
    const history = await historyLibrary(), sheet = gradientPng(100, 150), outfit = gradientPng(64, 64, 9), target = await history.add('sheet', 2, sheet);
    const { service, store } = await setup(history.reader);
    const references = [{ type: 'character_mainoutfit', strength: 1 }, { type: 'costume', strength: 7 > 5 ? 2.5 : 0, fidelity: 0.2 }];
    const saved = await service.put_queue_recipe({ preparation: t2i(references, [byReference(0, target, sheet), inline(1, outfit)]) });
    const input = saved.snapshot.reviewInput;
    expect(input.readiness).toEqual({ status: 'ready', issues: [] });
    expect(input.unusedInputs).not.toContain('preciseReferences');
    expect(input.unusedInputs).toContain('vibeImages');
    expect(input.authored.preciseReferences).toEqual([{ type: 'character_mainoutfit', strength: 1, fidelity: 1 }, { type: 'costume', strength: 2.5, fidelity: 0.2 }]);
    // The originals stay the bound inputs; the request images are their V5 buckets (100×150 → 832×1216, 64×64 → 1024×1024).
    expect(assetOf(saved, 'preciseReferences:0')).toMatchObject({ sha256: sha256(sheet), width: 100, height: 150, usedForGeneration: true });
    expect(assetOf(saved, 'preciseReferences:1')).toMatchObject({ sha256: sha256(outfit), usedForGeneration: true });
    const first = assetOf(saved, 'request-reference:0'), second = assetOf(saved, 'request-reference:1');
    expect([first.width, first.height, first.mimeType, first.usedForGeneration]).toEqual([832, 1216, 'image/png', true]);
    expect([second.width, second.height]).toEqual([1024, 1024]);
    expect(first.sha256).toBe(sha256(Buffer.from(first.data, 'base64')));
    const request = input.effective.request.parameters;
    expect(request.director_reference_images).toEqual([{ assetRole: 'request-reference:0' }, { assetRole: 'request-reference:1' }]);
    expect(request.director_reference_images_cached).toEqual([{ cache_secret_key: first.sha256, data: 'director_ref_0' }, { cache_secret_key: second.sha256, data: 'director_ref_1' }]);
    expect(request.director_reference_descriptions.map((entry: any) => entry.caption.base_caption)).toEqual(['character_mainoutfit', 'costume']);
    expect(request.director_reference_strength_values).toEqual([1, 2.5]);
    expect(request.director_reference_secondary_strength_values).toEqual([0, 0]); // V5 has no fidelity
    expect(JSON.stringify(input.effective)).not.toContain(first.data.slice(0, 64));
    // The record keeps the reference (no bytes) for the library image and the bytes of the inline one.
    expect(saved.assetRefs).toEqual([{ role: 'preciseReferences:0', mimeType: 'image/png', ref: { kind: 'history', id: 'sheet', revision: 2, assetId: 'sheet-original' }, sha256: sha256(sheet), byteLength: sheet.length }]);
    const stored = JSON.parse(await fs.readFile(path.join(store, `${saved.recipeId}.1.json`), 'utf8'));
    expect(JSON.stringify(stored)).not.toContain(sheet.toString('base64').slice(0, 64));
    expect(JSON.stringify(stored)).not.toContain(first.data.slice(0, 64));
    // Reading again prepares the same bytes: the same inputHash.
    expect((await service.read_queue_recipe({ recipeId: saved.recipeId, recipeRevision: 1, assetData: 'omit' })).inputHash).toBe(saved.inputHash);
    // The reference settings and images are part of the identity.
    const stronger = await service.put_queue_recipe({ preparation: t2i([{ type: 'character_mainoutfit', strength: 1.2 }, references[1]], [byReference(0, target, sheet), inline(1, outfit)]) });
    const other = await service.put_queue_recipe({ preparation: t2i(references, [byReference(0, target, sheet), inline(1, gradientPng(64, 64, 30))]) });
    const none = await service.put_queue_recipe({ preparation: t2i([], []) });
    expect(new Set([saved.inputHash, stronger.inputHash, other.inputHash, none.inputHash]).size).toBe(4);
    expect(none.snapshot.reviewInput.unusedInputs).toContain('preciseReferences');
    expect(none.snapshot.reviewInput.effective.request.parameters.director_reference_images).toBeUndefined();
  });

  it('i2i and enhance send them too; V4.5 pads into its three sizes, keeps fidelity and clamps strength to 1', async () => {
    const sheet = gradientPng(64, 96), source = gradientPng();
    const { service } = await setup();
    const preparation = (mode: string, extra: Record<string, unknown>) => ({ mode, authored: { params: params('nai-diffusion-4-5-full'), preciseReferences: [{ type: 'character&style', strength: 3, fidelity: 0.75 }], ...extra },
      assets: [{ role: 'source', mimeType: 'image/png', data: source.toString('base64') }, inline(0, sheet)] });
    for (const [mode, extra] of [['i2i', { i2iParams: { strength: 0.6, noise: 0, extraNoiseSeed: 5 } }], ['enhance', { enhanceMagnitude: 3, enhanceScale: 1 }]] as const) {
      const saved = await service.put_queue_recipe({ preparation: preparation(mode, extra) }), input = saved.snapshot.reviewInput;
      expect(input.readiness.status, mode).toBe('ready');
      const request = assetOf(saved, 'request-reference:0');
      expect([request.width, request.height], mode).toEqual([1024, 1536]);
      expect(input.effective.request.parameters.director_reference_images, mode).toEqual([{ assetRole: 'request-reference:0' }]);
      expect(input.effective.request.parameters.image, mode).toEqual({ assetRole: 'request-source' });
      expect(input.effective.request.parameters.director_reference_strength_values, mode).toEqual([1]);
      expect(input.effective.request.parameters.director_reference_secondary_strength_values, mode).toEqual([0.25]);
    }
  });

  it('refuses what cannot be sent before anything is saved, each with its reason', async () => {
    const image = gradientPng(), { service, store } = await setup();
    const put = (preparation: unknown) => service.put_queue_recipe({ preparation });
    const one = [{ type: 'character', strength: 1 }];
    // Vibe Transfer needs a second paid request.
    await expect(put({ mode: 't2i', authored: { params: params(), vibeImages: [{ strength: 1, infoExtracted: 1 }] }, assets: [] })).rejects.toMatchObject({ code: 'unsupported_reference', message: expect.stringContaining('Vibe Transfer') });
    // A model without the feature, an Outfit reference on V4.5, more than 16, a mode that sends none.
    await expect(put(t2i(one, [inline(0, image)], 'nai-diffusion-4-full'))).rejects.toMatchObject({ code: 'unsupported_reference', message: expect.stringContaining('has no Precise Reference') });
    await expect(put(t2i([{ type: 'costume', strength: 1 }], [inline(0, image)], 'nai-diffusion-4-5-full'))).rejects.toMatchObject({ code: 'unsupported_reference', message: expect.stringContaining('Outfit') });
    await expect(put(t2i(Array.from({ length: 17 }, () => one[0]), Array.from({ length: 17 }, (_, index) => inline(index, image))))).rejects.toMatchObject({ code: 'unsupported_reference', message: expect.stringContaining('at most 16') });
    await expect(put({ mode: 'inpaint', authored: { params: {}, inpaintModel: 'nai-diffusion-5-full-inpainting', inpaintStrength: 0.8, inpaintRecipe: params(), preciseReferences: one },
      assets: [{ role: 'source', mimeType: 'image/png', data: image.toString('base64') }, { role: 'mask', mimeType: 'image/png', data: image.toString('base64') }, inline(0, image)] })).rejects.toMatchObject({ code: 'unsupported_reference', message: expect.stringContaining('inpaint') });
    // Settings and images that do not match, or malformed settings.
    await expect(put(t2i(one, []))).rejects.toMatchObject({ code: 'invalid_argument', message: expect.stringContaining('exactly one image asset') });
    await expect(put(t2i(one, [inline(1, image)]))).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(put(t2i([], [inline(0, image)]))).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(put(t2i([{ type: 'outfit', strength: 1 }], [inline(0, image)]))).rejects.toMatchObject({ code: 'invalid_argument', message: expect.stringContaining('costume') });
    await expect(put(t2i([{ type: 'style', strength: 5.5 }], [inline(0, image)]))).rejects.toMatchObject({ code: 'invalid_argument', message: expect.stringContaining('0 to 5') });
    await expect(put(t2i([{ type: 'style', strength: 1, base64: image.toString('base64') }], [inline(0, image)]))).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(fs.readdir(store).then(names => names.filter(name => name.endsWith('.json')))).resolves.toEqual([]);
    // Bytes that are no image: saved as a blocked recipe that cannot be enqueued (like an unreadable source).
    expect(() => normalizeQueuePreparation(t2i(one, [inline(0, image)]))).not.toThrow();
  });

  it('a reference whose library original changed is named as that reference, at put and at enqueue', async () => {
    const history = await historyLibrary(), sheet = gradientPng(96, 96), target = await history.add('sheet', 1, sheet);
    const { service } = await setup(history.reader);
    await expect(service.put_queue_recipe({ preparation: t2i([{ type: 'character', strength: 1 }], [byReference(0, target, gradientPng(96, 96, 5))]) }))
      .rejects.toMatchObject({ code: 'recipe_source_changed', message: expect.stringContaining('precise reference #1 (history sheet revision 1') });
    const saved = await service.put_queue_recipe({ preparation: t2i([{ type: 'character', strength: 1 }], [byReference(0, target, sheet)]) });
    await fs.writeFile(target.filePath, gradientPng(96, 96, 77));
    await expect(service.enqueue_queue_recipes({ requestKey: 'changed-reference', items: [item(saved)] })).rejects.toMatchObject({ code: 'recipe_source_changed' });
  });

  it('enqueue freezes the prepared images: inline for one recipe, stored once for a set of recipes that share them', async () => {
    const history = await historyLibrary(), sheet = gradientPng(100, 150), target = await history.add('sheet', 1, sheet);
    const { service, submitted } = await setup(history.reader);
    const reference = [{ type: 'character', strength: 1 }];
    const recipes = [];
    for (const prompt of ['teacup, table', 'teacup, garden', 'teacup, night']) recipes.push(await service.put_queue_recipe({ preparation: t2i(reference, [byReference(0, target, sheet)], undefined, prompt) }));
    const plain = await service.put_queue_recipe({ preparation: t2i([], [], undefined, 'no reference') });
    const prepared = assetOf(recipes[0], 'request-reference:0');

    await service.enqueue_queue_recipes({ requestKey: 'one-recipe', items: [item(recipes[0], 1), item(recipes[0], 2)] });
    expect(submitted[0].snapshots).toBeUndefined();
    expect(submitted[0].snapshot.extras.preciseReferences).toEqual([{ base64: prepared.data, type: 'character', strength: 1, fidelity: 1, prepared: true, sha256: prepared.sha256 }]);
    expect(submitted[0].snapshot.referenceImages).toBeUndefined();

    await service.enqueue_queue_recipes({ requestKey: 'a-set', items: [item(recipes[0]), item(recipes[1]), item(plain), item(recipes[2]), item(recipes[1], 7)] });
    const snapshots = submitted[1].snapshots;
    expect(snapshots).toHaveLength(5);
    expect(snapshots[0].referenceImages).toEqual({ [prepared.sha256]: prepared.data });
    for (const [index, snapshot] of snapshots.entries()) {
      if (index > 0) expect(snapshot.referenceImages, String(index)).toBeUndefined();
      expect(snapshot.extras.preciseReferences, String(index)).toEqual(index === 2 ? [] : [{ base64: '', type: 'character', strength: 1, fidelity: 1, prepared: true, sha256: prepared.sha256 }]);
    }
    // The stored set holds the image once, and every image gets its bytes back when it is submitted.
    expect(JSON.stringify(snapshots).split(prepared.data.slice(0, 64)).length - 1).toBe(1);
    expect(referenceTableProblem(snapshots)).toBeNull();
    for (const index of [0, 1, 3, 4]) {
      const inflated = inflateReferenceImages(snapshots, index);
      expect(inflated.referenceImages).toBeUndefined();
      expect(inflated.extras.preciseReferences).toEqual([{ base64: prepared.data, type: 'character', strength: 1, fidelity: 1, prepared: true, sha256: prepared.sha256 }]);
      expect(inflated.params.positivePrompt).toBe(snapshots[index].params.positivePrompt);
    }
    expect(inflateReferenceImages(snapshots, 2).extras.preciseReferences).toEqual([]);
    // Submitting the same plan under its key again produces the same frozen set (the key's batch answers it).
    await service.enqueue_queue_recipes({ requestKey: 'a-set', items: [item(recipes[0]), item(recipes[1]), item(plain), item(recipes[2]), item(recipes[1], 7)] });
    expect(submitted).toHaveLength(2);
  });

  it('the shared table is checked: a missing or wrong image is a refused batch, never a request without its reference', () => {
    const bytes = gradientPng(), data = bytes.toString('base64'), key = sha256(bytes);
    const snapshot = (base64: string, hash = key) => ({ params: params(), extras: { vibeImages: [], charCaptions: [], preciseReferences: [{ base64, type: 'character', strength: 1, fidelity: 1, prepared: true, sha256: hash }] } }) as any;
    const shared = shareReferenceImages([snapshot(data), snapshot(data)]);
    expect(shared[0].referenceImages).toEqual({ [key]: data });
    expect(shared[1].extras.preciseReferences[0].base64).toBe('');
    expect(referenceTableProblem(shared)).toBeNull();
    expect(referenceTableProblem([{ ...shared[0], referenceImages: {} }, shared[1]])).toBe('A precise reference has no image bytes.');
    expect(referenceTableProblem([{ ...shared[0], referenceImages: { [key]: gradientPng(64, 64, 1).toString('base64') } }, shared[1]])).toBe('A shared reference image does not match its sha256.');
    expect(referenceTableProblem([shared[0], { ...shared[1], referenceImages: { [key]: data } }])).toBe('Only the first frozen recipe may carry the shared reference images.');
    // Inline bytes need no table; snapshots without references are left alone.
    expect(referenceTableProblem([snapshot(data)])).toBeNull();
    const plain = [{ params: params(), extras: { vibeImages: [], charCaptions: [], preciseReferences: [] } }] as any;
    expect(shareReferenceImages(plain)).toBe(plain);
    // A table entry that is missing leaves the reference empty; the generation service refuses that before sending.
    expect(inflateReferenceImages([{ ...shared[0], referenceImages: {} }, shared[1]], 1).extras.preciseReferences[0].base64).toBe('');
  });

  it('the space estimate counts a shared reference once per batch of several recipes', () => {
    const sheet = gradientPng(100, 150), other = gradientPng(64, 64, 3);
    const recipe = (name: string, assets: unknown[]) => ({ recipe: name, preparation: normalizeQueuePreparation(t2i(assets.map(() => ({ type: 'character', strength: 1 })), assets, undefined, name)) });
    const none = estimateFrozenBatchBytes('key', [recipe('a', []), recipe('b', []), recipe('c', [])]);
    const sharedOne = estimateFrozenBatchBytes('key', [recipe('a', [inline(0, sheet)]), recipe('b', [inline(0, sheet)]), recipe('c', [inline(0, sheet)])]);
    const distinct = estimateFrozenBatchBytes('key', [recipe('a', [inline(0, sheet)]), recipe('b', [inline(0, other)]), recipe('c', [inline(0, sheet)])]);
    const one = sharedOne - none, two = distinct - none;
    expect(one).toBeGreaterThan(5_000_000); expect(one).toBeLessThan(6_500_000); // one 1024×1024 RGBA PNG as base64, at most
    expect(two).toBeGreaterThan(1.9 * one); expect(two).toBeLessThan(2.1 * one);
    // The same recipe for every image is one snapshot with its images inline.
    const single = recipe('a', [inline(0, sheet), inline(1, sheet)]);
    expect(estimateFrozenBatchBytes('key', [single, single, single]) - estimateFrozenBatchBytes('key', [recipe('a', []), recipe('a', []), recipe('a', [])])).toBeGreaterThan(1.9 * one);
  });

  it('a canvas capture keeps the reference images of a generation mode and drops them for post-processing', () => {
    const data = gradientPng().toString('base64'), asset = (role: string) => ({ role, mimeType: 'image/png', data });
    const raw = (mode: string) => ({ mode, authored: { params: params(), vibeImages: [], preciseReferences: [{ name: 'sheet', type: 'character', strength: 1, fidelity: 1 }] }, assets: [asset('source'), asset('preciseReferences:0'), asset('vibeImages:0')] });
    expect(canvasPreparation('t2i', raw('t2i')).assets.map(entry => entry.role)).toEqual(['preciseReferences:0']);
    expect(canvasPreparation('i2i', raw('i2i')).assets.map(entry => entry.role)).toEqual(['source', 'preciseReferences:0']);
    expect(canvasPreparation('enhance', raw('enhance')).assets.map(entry => entry.role)).toEqual(['source', 'preciseReferences:0']);
    const upscale = canvasPreparation('upscale', raw('upscale'));
    expect(upscale.assets.map(entry => entry.role)).toEqual(['source']);
    expect(upscale.authored.preciseReferences).toEqual([]);
    // What the canvas wrote passes the recipe store as it is (name kept, image by role).
    expect(normalizeQueuePreparation(canvasPreparation('t2i', raw('t2i'))).authored.preciseReferences).toEqual([{ name: 'sheet', type: 'character', strength: 1, fidelity: 1 }]);
  });

  it('prepares a real illustration-sized reference once per enqueue of a set (the request image is cached by its original)', async () => {
    const big = await sharp({ create: { width: 1000, height: 1500, channels: 3, background: '#7a8fb0' } }).png().toBuffer();
    const { service } = await setup();
    const started = Date.now(), saved = [];
    for (const prompt of ['a', 'b', 'c', 'd']) saved.push(await service.put_queue_recipe({ preparation: t2i([{ type: 'character', strength: 1 }], [inline(0, big)], undefined, prompt) }));
    expect(new Set(saved.map(value => assetOf(value, 'request-reference:0').sha256)).size).toBe(1);
    expect(assetOf(saved[0], 'request-reference:0')).toMatchObject({ width: 832, height: 1216 });
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});
