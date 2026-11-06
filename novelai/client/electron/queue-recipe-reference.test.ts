import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
vi.mock('axios', () => ({ default: { get: () => { throw new Error('No network'); }, post: () => { throw new Error('No network'); } } }));
vi.mock('./ipc/store', () => ({ getToken: () => { throw new Error('No account'); }, getSettings: () => { throw new Error('No settings'); } }));
vi.mock('electron', () => ({ app: {}, dialog: {}, nativeImage: { createFromBuffer: (buffer: Buffer) => {
  const png = PNG.sync.read(buffer);
  return { isEmpty: () => false, getSize: () => ({ width: png.width, height: png.height }), toPNG: () => buffer, resize: () => ({ toPNG: () => buffer }) };
} } }));
import { createQueueRecipeService, normalizeQueuePreparation, recipeHash, type ReadHistoryOriginal } from './queue-recipe-service';
import { createHistoryImageReader } from './asset-library-image';
import { runCleanups } from '../src/test-support/temp-dirs';

// Pinned on the unchanged base (516e54b) with this file's nativeImage mock, before by-reference sources existed.
// The inputHash formula and the builder output for embedded recipes must not move.
const PINNED = {
  t2i: 'c504c7be2f01d54850a45efcaafb8961b23f6f6c2f7d953a5e66ed3ae4853de9',
  i2i: '4af61c7805a71b8f225c2478fe9d92545e4f923fe6f9ca62eca008335975d3ac',
  inpaint: '31611d307837d7062d45d449502b18101b02f013495ea9b402cde051b9e4687a',
  sourceSha256: '8000c37264a9d0570d2375d8c5f7044d13cf49140164438f61ab280a1c49518c',
};
const params = { positivePrompt: 'teacup, table', negativePrompt: 'text, watermark', seed: 42, seedMode: 'fixed', width: 64, height: 64, promptAssemblyVersion: 1 };
const gradientPng = (width = 64, height = 64, shift = 0) => { const png = new PNG({ width, height }); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const i = (y * width + x) * 4; png.data[i] = (x * 4 + shift) & 255; png.data[i + 1] = (y * 4) & 255; png.data[i + 2] = (x ^ y) & 255; png.data[i + 3] = 255; } return PNG.sync.write(png); };
const maskPng = (width = 64, height = 64) => { const png = new PNG({ width, height }); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const i = (y * width + x) * 4, on = x >= 16 && x < 48 && y >= 16 && y < 48 ? 255 : 0; png.data[i] = on; png.data[i + 1] = on; png.data[i + 2] = on; png.data[i + 3] = 255; } return PNG.sync.write(png); };
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const i2iPreparation = (source: Record<string, unknown>) => ({ mode: 'i2i', authored: { params, i2iParams: { strength: 0.6, noise: 0, extraNoiseSeed: 5 } }, assets: [source] });
const inpaintPreparation = (assets: Record<string, unknown>[]) => ({ mode: 'inpaint', authored: { params: {}, inpaintModel: 'nai-diffusion-4-5-full-inpainting', inpaintStrength: 0.8, inpaintRecipe: { ...params, model: 'nai-diffusion-4-5-full' } }, assets });
const item = (value: any, seed?: number) => ({ recipeId: value.recipeId, recipeRevision: value.recipeRevision, inputHash: value.inputHash, ...(seed === undefined ? {} : { seed }) });

const cleanups: string[] = [];
afterEach(async () => { await runCleanups(cleanups.splice(0).map(dir => () => fs.rm(dir, { recursive: true, force: true }))); });
const temporary = async (prefix: string) => { const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix))); cleanups.push(dir); return dir; };

/** Minimal version-addressed history library for the real host reader: originals are real files. */
async function historyLibrary() {
  const root = await temporary('nai-recipe-history-'), versions = new Map<string, Map<number, any>>();
  const add = async (id: string, revision: number, bytes: Buffer, options: { recordSha?: boolean; file?: string } = {}) => {
    const filePath = options.file ?? path.join(root, `${id}-${randomUUID()}.png`);
    if (!options.file) await fs.writeFile(filePath, bytes);
    const asset = { id: `${id}-original`, role: 'original', payload: { filePath, mimeType: 'image/png', ...(options.recordSha === false ? {} : { sha256: sha256(bytes), byteLength: bytes.length }) } };
    if (!versions.has(id)) versions.set(id, new Map());
    versions.get(id)!.set(revision, { item: { kind: 'history', id, revision }, assets: [asset] });
    return { kind: 'history' as const, id, revision, assetId: asset.id, filePath };
  };
  const repo = {
    get: (_kind: string, id: string, revision?: number) => { const all = versions.get(id); if (!all) return null; return revision === undefined ? [...all.values()].at(-1).item : all.get(revision)?.item ?? null; },
    versionAssets: (item: any) => versions.get(item.id)!.get(item.revision).assets,
  };
  return { add, remove: (id: string) => versions.delete(id), reader: createHistoryImageReader(repo as any) };
}

async function setup(readHistoryOriginal?: ReadHistoryOriginal) {
  const runtimeDir = await temporary('nai-queue-reference-');
  const jobs = new Map<string, any>();
  const batch = { ready: Promise.resolve(), enqueue: vi.fn(async (args: any) => {
    const job = { ...args, batchId: randomUUID(), originWorkspaceId: args.workspaceId, submittedRevision: 0, status: 'queued', items: args.seeds.map((plannedSeed: number, index: number) => ({ index, plannedSeed, status: 'pending', jobId: null, results: [] })) };
    delete job.snapshots; delete job.snapshot; jobs.set(args.requestKey, job); return job;
  }), lookup: vi.fn((args: any) => jobs.get(args.requestKey) ?? null), list: vi.fn(() => ({ batches: [...jobs.values()] })), read: vi.fn(), pause: vi.fn(), resume: vi.fn(), cancel: vi.fn() };
  const reader = readHistoryOriginal ? vi.fn(readHistoryOriginal) : undefined;
  const service = createQueueRecipeService({ runtimeDir, batch, randomSeed: () => 97, ...(reader ? { readHistoryOriginal: reader } : {}) });
  const store = path.join(runtimeDir, 'queue-recipes');
  const files = async () => { try { return Object.fromEntries(await Promise.all((await fs.readdir(store)).sort().map(async name => [name, sha256(await fs.readFile(path.join(store, name)))]))); } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; } };
  return { service, batch, jobs, runtimeDir, store, files, reader };
}
const referenceTo = (target: { kind: 'history'; id: string; revision: number; assetId: string }, bytes: Buffer, change: Record<string, unknown> = {}) =>
  ({ role: 'source', mimeType: 'image/png', ref: { kind: target.kind, id: target.id, revision: target.revision, assetId: target.assetId }, sha256: sha256(bytes), byteLength: bytes.length, ...change });

describe('recipe sources stored by history reference (H8)', () => {
  it('put, read and enqueue each reread the reference and bind it to the recorded sha256; the record keeps only the reference', async () => {
    const history = await historyLibrary(), bytes = gradientPng(), target = await history.add('history-a', 3, bytes);
    const { service, batch, store, reader } = await setup(history.reader);
    const saved = await service.put_queue_recipe({ preparation: i2iPreparation(referenceTo(target, bytes)) });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenLastCalledWith({ kind: 'history', id: 'history-a', revision: 3, assetId: 'history-a-original', variant: 'original' });
    expect(saved.inputHash).toBe(PINNED.i2i); // a reference and the old embedded copy of the same image hash identically
    expect(saved.snapshot.reviewInput.readiness.status).toBe('ready');
    expect(saved.snapshot.reviewInput.assets.find((asset: any) => asset.role === 'source')).toMatchObject({ sha256: PINNED.sourceSha256, data: bytes.toString('base64') });
    expect(saved).toMatchObject({ assetRefs: [{ role: 'source', mimeType: 'image/png', ref: { kind: 'history', id: 'history-a', revision: 3, assetId: 'history-a-original' }, sha256: sha256(bytes), byteLength: bytes.length }], assetBytes: { source: bytes.length } });
    const stored = JSON.parse(await fs.readFile(path.join(store, `${saved.recipeId}.1.json`), 'utf8'));
    expect(stored.preparation.assets).toEqual([referenceTo(target, bytes)]);
    expect(JSON.stringify(stored)).not.toContain(bytes.toString('base64').slice(0, 64));
    expect(stored).not.toHaveProperty('assetRefs');

    const read = await service.read_queue_recipe({ recipeId: saved.recipeId, recipeRevision: 1 });
    expect(reader).toHaveBeenCalledTimes(2); expect(read).toEqual(saved);
    const omitted = await service.read_queue_recipe({ recipeId: saved.recipeId, recipeRevision: 1, assetData: 'omit' });
    expect(reader).toHaveBeenCalledTimes(3);
    expect(omitted.inputHash).toBe(saved.inputHash);
    expect(omitted.snapshot.reviewInput.assets.every((asset: any) => !('data' in asset))).toBe(true);
    expect(omitted.snapshot.reviewInput.assets.map((asset: any) => [asset.role, asset.sha256, asset.width, asset.height])).toEqual(saved.snapshot.reviewInput.assets.map((asset: any) => [asset.role, asset.sha256, asset.width, asset.height]));
    expect(recipeHash({ ...omitted.snapshot.reviewInput, assets: omitted.snapshot.reviewInput.assets })).toBe(saved.inputHash);
    expect(omitted.assetRefs).toEqual(saved.assetRefs);
    const putOmitted = await service.put_queue_recipe({ preparation: i2iPreparation(referenceTo(target, bytes)), assetData: 'omit' });
    expect(putOmitted.inputHash).toBe(saved.inputHash); expect(JSON.stringify(putOmitted)).not.toContain(bytes.toString('base64').slice(0, 64));
    await expect(service.read_queue_recipe({ recipeId: saved.recipeId, recipeRevision: 1, assetData: 'bytes' })).rejects.toMatchObject({ code: 'invalid_argument' });

    reader!.mockClear();
    const job = await service.enqueue_queue_recipes({ requestKey: 'reference-enqueue', items: [item(saved, 1), item(saved, 2)] });
    expect(reader).toHaveBeenCalledTimes(1); // one reread per distinct recipe, before the receipt
    const sent = batch.enqueue.mock.calls[0][0];
    expect(sent).toMatchObject({ mode: 'i2i', seeds: [1, 2], snapshot: { sourceImage: { data: bytes.toString('base64') } } });
    // An accepted batch carries its own bytes: replay and lookup never reread a source, even after it is gone.
    history.remove('history-a'); reader!.mockClear();
    expect((await service.enqueue_queue_recipes({ requestKey: 'reference-enqueue', items: [item(saved, 1), item(saved, 2)] })).batchId).toBe(job.batchId);
    expect((await service.lookup_queue_request({ requestKey: 'reference-enqueue' })).status).toBe('accepted');
    expect(reader).not.toHaveBeenCalled(); expect(batch.enqueue).toHaveBeenCalledTimes(1);
  });

  it('returns explicit codes when the history entry is deleted, the original is replaced, only metadata changed, or the reader is busy', async () => {
    const history = await historyLibrary(), bytes = gradientPng();
    const kept = await history.add('history-keep', 1, bytes), deleted = await history.add('history-deleted', 1, bytes), missing = await history.add('history-missing', 1, bytes);
    const replaced = await history.add('history-replaced', 1, bytes), unbound = await history.add('history-unbound', 1, bytes, { recordSha: false });
    let busy = false;
    const { service, batch, files } = await setup(async args => { if (busy) throw Object.assign(new Error('busy'), { code: 'image_busy' }); return history.reader(args); });
    const recipes = Object.fromEntries(await Promise.all(Object.entries({ kept, deleted, missing, replaced, unbound }).map(async ([name, target]) => [name, await service.put_queue_recipe({ preparation: i2iPreparation(referenceTo(target, bytes)) })])));
    // Metadata-only change: a newer history revision exists, the referenced revision still reads.
    await history.add('history-keep', 2, bytes, { file: kept.filePath });
    expect((await service.read_queue_recipe({ recipeId: recipes.kept.recipeId, recipeRevision: 1 })).inputHash).toBe(PINNED.i2i);

    history.remove('history-deleted'); await fs.unlink(missing.filePath);
    await fs.writeFile(replaced.filePath, gradientPng(64, 64, 9)); await fs.writeFile(unbound.filePath, gradientPng(64, 64, 9));
    const expectations: Array<[string, string, string]> = [['deleted', 'recipe_source_unavailable', 'library_not_found'], ['missing', 'recipe_source_unavailable', 'image_unavailable'], ['replaced', 'recipe_source_changed', 'image_changed'], ['unbound', 'recipe_source_changed', '']];
    for (const [name, code, readerCode] of expectations) {
      const recipe = recipes[name];
      const failure: any = await service.read_queue_recipe({ recipeId: recipe.recipeId, recipeRevision: 1 }).catch(error => error);
      expect(failure).toMatchObject({ code, details: { recipeId: recipe.recipeId, recipeRevision: 1, ref: recipe.assetRefs[0].ref, sha256: sha256(bytes) } });
      expect(failure.message).toContain(recipe.recipeId); expect(failure.message).toContain(recipe.assetRefs[0].ref.id);
      if (readerCode) expect(failure.details.readerCode).toBe(readerCode); else expect(failure.details).not.toHaveProperty('readerCode');
      // Enqueue stops before writing a receipt: the key is not consumed and nothing reaches the batch service.
      const before = await files();
      await expect(service.enqueue_queue_recipes({ requestKey: `source-${name}`, items: [item(recipe, 3)] })).rejects.toMatchObject({ code });
      expect(await files()).toEqual(before);
      expect(await service.lookup_queue_request({ requestKey: `source-${name}` })).toEqual({ batch: null, inFlight: false });
      await expect(service.put_queue_recipe({ preparation: i2iPreparation(referenceTo(name === 'unbound' ? unbound : name === 'replaced' ? replaced : name === 'missing' ? missing : deleted, bytes)) })).rejects.toMatchObject({ code });
      expect(await files()).toEqual(before);
    }
    busy = true;
    const before = await files();
    await expect(service.read_queue_recipe({ recipeId: recipes.kept.recipeId, recipeRevision: 1 })).rejects.toMatchObject({ code: 'recipe_source_busy', details: { readerCode: 'image_busy' } });
    await expect(service.put_queue_recipe({ preparation: i2iPreparation(referenceTo(kept, bytes)) })).rejects.toMatchObject({ code: 'recipe_source_busy' });
    await expect(service.enqueue_queue_recipes({ requestKey: 'source-busy', items: [item(recipes.kept, 4)] })).rejects.toMatchObject({ code: 'recipe_source_busy' });
    expect(await files()).toEqual(before);
    busy = false; // the same call succeeds once the reader is free
    await service.enqueue_queue_recipes({ requestKey: 'source-busy', items: [item(recipes.kept, 4)] });
    expect(batch.enqueue).toHaveBeenCalledTimes(1);
  });

  it('rejects a mismatched reference before saving, and a host without a history reader', async () => {
    const history = await historyLibrary(), bytes = gradientPng(), target = await history.add('history-b', 1, bytes);
    const { service, files } = await setup(history.reader);
    await expect(service.put_queue_recipe({ preparation: i2iPreparation(referenceTo(target, bytes, { sha256: '0'.repeat(64) })) })).rejects.toMatchObject({ code: 'recipe_source_changed' });
    await expect(service.put_queue_recipe({ preparation: i2iPreparation(referenceTo(target, bytes, { byteLength: bytes.length + 1 })) })).rejects.toMatchObject({ code: 'recipe_source_changed' });
    await expect(service.put_queue_recipe({ preparation: i2iPreparation(referenceTo(target, bytes, { mimeType: 'image/jpeg' })) })).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(service.put_queue_recipe({ preparation: i2iPreparation(referenceTo({ ...target, assetId: 'not-registered' }, bytes)) })).rejects.toMatchObject({ code: 'recipe_source_changed', details: { readerCode: 'library_conflict' } });
    for (const bad of [{ role: 'mask' }, { ref: { ...referenceTo(target, bytes).ref, kind: 'inbox' } }, { ref: { ...referenceTo(target, bytes).ref, revision: -1 } }, { sha256: 'abc' }, { byteLength: 20 * 1024 * 1024 + 1 }, { data: bytes.toString('base64') }, { provenance: { from: 'history' } }, { mimeType: 'image/gif' }])
      await expect(service.put_queue_recipe({ preparation: i2iPreparation(referenceTo(target, bytes, bad)) })).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(service.put_queue_recipe({ preparation: i2iPreparation({ role: 'source', mimeType: 'image/png', ref: { kind: 'history', id: 'history-b', revision: 1 }, sha256: sha256(bytes), byteLength: bytes.length }) })).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(await files()).toEqual({});
    const readerless = await setup();
    await expect(readerless.service.put_queue_recipe({ preparation: i2iPreparation(referenceTo(target, bytes)) })).rejects.toMatchObject({ code: 'recipe_source_unavailable' });
    expect(await readerless.files()).toEqual({});
  });

  it('an embedded copy has the same input hash', async () => {
    const history = await historyLibrary(), bytes = gradientPng(), target = await history.add('history-c', 1, bytes);
    const { service } = await setup(history.reader);
    const saved = await service.put_queue_recipe({ preparation: i2iPreparation(referenceTo(target, bytes)) });
    const embedded = await service.put_queue_recipe({ preparation: i2iPreparation({ role: 'source', mimeType: 'image/png', data: bytes.toString('base64') }) });
    expect(embedded.inputHash).toBe(saved.inputHash);
  });

  it('keeps asset provenance in the record and readback, outside reviewInput and inputHash', async () => {
    const { service, store } = await setup();
    const source = { role: 'source', mimeType: 'image/png', data: gradientPng().toString('base64') }, mask = { role: 'mask', mimeType: 'image/png', data: maskPng().toString('base64') };
    const spec = { units: 'fraction', layers: [{ op: 'add', shape: { type: 'rect', x: 0.25, y: 0.25, width: 0.5, height: 0.5 } }] };
    const plain = await service.put_queue_recipe({ preparation: inpaintPreparation([source, mask]) });
    const noted = await service.put_queue_recipe({ preparation: inpaintPreparation([source, { ...mask, provenance: { spec } }]) });
    expect(plain.inputHash).toBe(PINNED.inpaint); expect(noted.inputHash).toBe(PINNED.inpaint);
    expect(plain).not.toHaveProperty('assetProvenance');
    expect(noted.assetProvenance).toEqual({ mask: { spec } });
    expect(noted.assetBytes).toEqual({ source: Buffer.from(source.data, 'base64').length, mask: Buffer.from(mask.data, 'base64').length });
    expect(noted.snapshot.reviewInput.assets.every((asset: any) => !('provenance' in asset))).toBe(true);
    expect((await service.read_queue_recipe({ recipeId: noted.recipeId, recipeRevision: 1 })).assetProvenance).toEqual({ mask: { spec } });
    expect(JSON.parse(await fs.readFile(path.join(store, `${noted.recipeId}.1.json`), 'utf8')).preparation.assets[1].provenance).toEqual({ spec });
    await expect(service.put_queue_recipe({ preparation: inpaintPreparation([source, { ...mask, provenance: { spec: 'x'.repeat(33 * 1024) } }]) })).rejects.toMatchObject({ code: 'invalid_argument', message: 'Asset provenance exceeds 32 KiB.' });
    await expect(service.put_queue_recipe({ preparation: inpaintPreparation([source, { ...mask, provenance: ['not', 'an', 'object'] }]) })).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(service.put_queue_recipe({ preparation: inpaintPreparation([source, source]) })).rejects.toMatchObject({ code: 'invalid_argument', message: 'Invalid or duplicate review image role.' });
  });
});

/** Version-addressed study library for the real host reader: one registered original per revision (or a deliberately broken registration). */
async function studyLibrary() {
  const root = await temporary('nai-recipe-study-'), versions = new Map<string, Map<number, any>>();
  const add = async (bytes: Buffer, options: { id?: string; revision?: number; originals?: number } = {}) => {
    // Same layout as the repository derives for a study: <libraryDirectory>/studies/<id>/original.<ext>.
    const id = options.id ?? randomUUID(), revision = options.revision ?? 1, folder = path.join(root, 'studies', id);
    await fs.mkdir(folder, { recursive: true });
    const filePath = path.join(folder, 'original.png'); await fs.writeFile(filePath, bytes);
    const original = (index: number) => ({ id: `path:${sha256(Buffer.from(`${filePath}#${index}`))}`, role: 'original', payload: { filePath, mimeType: 'image/png', sha256: sha256(bytes), byteLength: bytes.length } });
    const assets = [...Array.from({ length: options.originals ?? 1 }, (_, index) => original(index)), { id: 'path:preview', role: 'preview', payload: { filePath: path.join(folder, 'preview.webp'), mimeType: 'image/webp' } }];
    if (!versions.has(id)) versions.set(id, new Map());
    versions.get(id)!.set(revision, { item: { kind: 'study', id, revision }, assets });
    return { kind: 'study' as const, id, revision, filePath };
  };
  const repo = {
    get: (kind: string, id: string, revision?: number) => { const all = kind === 'study' ? versions.get(id) : undefined; if (!all) return null; return revision === undefined ? [...all.values()].at(-1).item : all.get(revision)?.item ?? null; },
    versionAssets: (item: any) => versions.get(item.id)!.get(item.revision).assets,
  };
  return { add, remove: (id: string) => versions.delete(id), reader: createHistoryImageReader(repo as any) };
}
const studyReferenceTo = (target: { id: string; revision: number }, bytes: Buffer, change: Record<string, unknown> = {}) =>
  ({ role: 'source', mimeType: 'image/png', ref: { kind: 'study', id: target.id, revision: target.revision }, sha256: sha256(bytes), byteLength: bytes.length, ...change });

describe('recipe sources stored by study reference (issue #2)', () => {
  it('the reader gets {kind:"study", id, revision} without assetId; the record keeps the exact reference; the inputHash equals an embedded copy', async () => {
    const studies = await studyLibrary(), bytes = gradientPng(), target = await studies.add(bytes, { revision: 2 });
    const { service, store, reader } = await setup(studies.reader);
    const saved = await service.put_queue_recipe({ preparation: i2iPreparation(studyReferenceTo(target, bytes)) });
    expect(reader).toHaveBeenLastCalledWith({ kind: 'study', id: target.id, revision: 2, variant: 'original' });
    expect(saved.inputHash).toBe(PINNED.i2i);
    expect(saved.assetRefs).toEqual([{ role: 'source', mimeType: 'image/png', ref: { kind: 'study', id: target.id, revision: 2 }, sha256: sha256(bytes), byteLength: bytes.length }]);
    // The MCP's 32 MiB frozen-input estimate reads assetBytes: a study reference reports its original's byteLength.
    expect(saved.assetBytes).toEqual({ source: bytes.length });
    expect(JSON.parse(await fs.readFile(path.join(store, `${saved.recipeId}.1.json`), 'utf8')).preparation.assets).toEqual([studyReferenceTo(target, bytes)]);
    const omitted = await service.read_queue_recipe({ recipeId: saved.recipeId, recipeRevision: 1, assetData: 'omit' });
    expect(omitted.assetRefs).toEqual(saved.assetRefs); expect(omitted.inputHash).toBe(saved.inputHash);
  });

  it('refuses malformed study references before reading or saving anything', async () => {
    const studies = await studyLibrary(), bytes = gradientPng(), target = await studies.add(bytes);
    const { service, files, reader } = await setup(studies.reader);
    for (const ref of [
      { kind: 'study', id: target.id, revision: 0 }, { kind: 'study', id: target.id }, { kind: 'study', id: target.id.toUpperCase(), revision: 1 },
      { kind: 'study', id: target.id, revision: 1, assetId: 'path:x' }, { kind: 'study', id: target.id, revision: 1, extra: true }, { kind: 'study', id: target.id, revision: '1' },
      { kind: 'imports', id: target.id, revision: 1 },
    ]) await expect(service.put_queue_recipe({ preparation: i2iPreparation({ ...studyReferenceTo(target, bytes), ref }) })).rejects.toMatchObject({ code: 'invalid_argument', message: expect.stringContaining('{kind:"study", id, revision}') });
    expect(reader).not.toHaveBeenCalled(); expect(await files()).toEqual({});
  });

  it('a busy reader, a missing study and a broken registration are explicit recipe_source_* answers naming the study', async () => {
    const studies = await studyLibrary(), bytes = gradientPng();
    const kept = await studies.add(bytes), doubled = await studies.add(bytes, { originals: 2 }), gone = await studies.add(bytes);
    let busy = false;
    const { service, files } = await setup(async args => { if (busy) throw Object.assign(new Error('busy'), { code: 'image_busy' }); return studies.reader(args); });
    const recipe = await service.put_queue_recipe({ preparation: i2iPreparation(studyReferenceTo(kept, bytes)) });
    const goneRecipe = await service.put_queue_recipe({ preparation: i2iPreparation(studyReferenceTo(gone, bytes)) });
    await expect(service.put_queue_recipe({ preparation: i2iPreparation(studyReferenceTo(doubled, bytes)) })).rejects.toMatchObject({ code: 'recipe_source_unavailable', details: { readerCode: 'image_unavailable', ref: { kind: 'study', id: doubled.id, revision: 1 } } });
    studies.remove(gone.id);
    const missing: any = await service.read_queue_recipe({ recipeId: goneRecipe.recipeId, recipeRevision: 1 }).catch(error => error);
    expect(missing).toMatchObject({ code: 'recipe_source_unavailable', details: { recipeId: goneRecipe.recipeId, recipeRevision: 1, ref: { kind: 'study', id: gone.id, revision: 1 }, readerCode: 'library_not_found' } });
    expect(missing.message).toContain(`source (study ${gone.id} revision 1)`); expect(missing.details.ref).not.toHaveProperty('assetId');
    busy = true;
    const before = await files();
    const failure: any = await service.enqueue_queue_recipes({ requestKey: 'study-busy', items: [item(recipe, 1)] }).catch(error => error);
    expect(failure).toMatchObject({ code: 'recipe_source_busy', details: { readerCode: 'image_busy', ref: { kind: 'study', id: kept.id, revision: 1 } } });
    expect(failure.message).toMatch(/busy in the study reader.*retry the same call later/);
    expect(await files()).toEqual(before); expect(await service.lookup_queue_request({ requestKey: 'study-busy' })).toEqual({ batch: null, inFlight: false });
    busy = false;
    expect((await service.enqueue_queue_recipes({ requestKey: 'study-busy', items: [item(recipe, 1)] })).batchId).toEqual(expect.any(String));
  });
});

describe('legacy embedded recipes (no reference, no provenance)', () => {
  it('a hand-written pre-reference record reads and enqueues unchanged, with the inputHash pinned before this change', async () => {
    const { service, batch, store, reader } = await setup(async () => { throw new Error('legacy recipes never call the history reader'); });
    await fs.mkdir(store, { recursive: true, mode: 0o700 });
    const source = gradientPng(), cases = {
      t2i: { mode: 't2i', authored: { params }, assets: [] },
      i2i: i2iPreparation({ role: 'source', mimeType: 'image/png', data: source.toString('base64') }),
      inpaint: inpaintPreparation([{ role: 'source', mimeType: 'image/png', data: source.toString('base64') }, { role: 'mask', mimeType: 'image/png', data: maskPng().toString('base64') }]),
    };
    for (const [mode, raw] of Object.entries(cases) as Array<[keyof typeof cases, any]>) {
      const recipeId = randomUUID(), preparation = normalizeQueuePreparation(raw);
      expect(preparation.assets.every(asset => Object.keys(asset).sort().join() === 'data,mimeType,role')).toBe(true);
      const legacy = { schemaVersion: 1, recipeId, recipeRevision: 1, preparation, inputHash: PINNED[mode] };
      await fs.writeFile(path.join(store, `${recipeId}.1.json`), JSON.stringify({ ...legacy, recordHash: recipeHash(legacy) }), { mode: 0o600 });
      const read = await service.read_queue_recipe({ recipeId, recipeRevision: 1 });
      expect(read.inputHash).toBe(PINNED[mode]);
      expect(read).not.toHaveProperty('assetRefs'); expect(read).not.toHaveProperty('assetProvenance');
      if (mode === 't2i') expect(read).not.toHaveProperty('assetBytes');
      const { assets, ...input } = read.snapshot.reviewInput;
      expect(recipeHash({ ...input, assets: assets.map(({ data: _data, ...asset }: any) => asset) })).toBe(PINNED[mode]);
      await service.enqueue_queue_recipes({ requestKey: `legacy-${mode}`, items: [item(read, 7)] });
      const sent = batch.enqueue.mock.calls.at(-1)![0];
      expect(sent).toMatchObject({ mode, seeds: [7] });
      if (mode !== 't2i') expect(sent.snapshots[0].sourceImage.data).toBe(source.toString('base64'));
      // A fresh embedded put of the same input still produces the pinned value.
      expect((await service.put_queue_recipe({ preparation: raw })).inputHash).toBe(PINNED[mode]);
    }
    expect(reader).not.toHaveBeenCalled(); expect(batch.enqueue).toHaveBeenCalledTimes(3);
  });
});
