import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
vi.mock('axios', () => ({ default: { get: () => { throw new Error('No network'); }, post: () => { throw new Error('No network'); } } }));
vi.mock('./ipc/store', () => ({ getToken: () => { throw new Error('No account'); }, getSettings: () => { throw new Error('No settings'); } }));
vi.mock('electron', () => ({ app: {}, dialog: {}, nativeImage: { createFromBuffer: (buffer: Buffer) => {
  const png = PNG.sync.read(buffer);
  return { isEmpty: () => false, getSize: () => ({ width: png.width, height: png.height }), toPNG: () => buffer, resize: () => ({ toPNG: () => buffer }) };
} } }));
import { createQueueRecipeService, estimateFrozenBatchBytes, FROZEN_PRECHECK_SAVE_MARGIN, recipeHash, RECIPE_STORE_LIMITS, QUEUE_WORKSPACE } from './queue-recipe-service';
import { createBatchService } from './batch-service';
import { createBatchStorage } from './batch-storage';

const SLOT = 16 * 1024;
const prep = (positivePrompt = 'teacup, table') => ({ mode: 't2i', authored: { params: { positivePrompt, negativePrompt: 'text', seed: 42, seedMode: 'fixed', width: 64, height: 64 } }, assets: [] });
const item = (value: any, seed?: number) => ({ recipeId: value.recipeId, recipeRevision: value.recipeRevision, inputHash: value.inputHash, ...(seed === undefined ? {} : { seed }) });
const noisePng = (size = 256) => { const png = new PNG({ width: size, height: size }); randomBytes(png.data.length).copy(png.data); for (let index = 3; index < png.data.length; index += 4) png.data[index] = 255; return PNG.sync.write(png).toString('base64'); };

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { await runCleanups(cleanups.splice(0).reverse()); });
async function runtime(prefix = 'nai-recipe-capacity-') { const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix))); cleanups.push(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
function fakeBatch(extra: Record<string, any> = {}) {
  const jobs = new Map<string, any>();
  const batch = { ready: Promise.resolve(), enqueue: vi.fn(async (args: any) => {
    const job = { ...args, batchId: randomUUID(), originWorkspaceId: args.workspaceId, submittedRevision: 0, status: 'queued', items: args.seeds.map((plannedSeed: number, index: number) => ({ index, plannedSeed, status: 'pending', jobId: null, results: [] })) };
    delete job.snapshots; delete job.snapshot; jobs.set(args.requestKey, job); return job;
  }), lookup: vi.fn((args: any) => jobs.get(args.requestKey) ?? null), list: vi.fn(() => ({ batches: [...jobs.values()] })),
    read: vi.fn((args: any) => [...jobs.values()].find(value => value.batchId === args.batchId)), pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(), ...extra };
  return { batch, jobs };
}
async function setup(options: { batch?: any; runtimeDir?: string } = {}) {
  const runtimeDir = options.runtimeDir ?? await runtime(), fake = fakeBatch(), batch = options.batch ?? fake.batch;
  const make = () => createQueueRecipeService({ runtimeDir, batch, randomSeed: () => 97 });
  const store = path.join(runtimeDir, 'queue-recipes'), receiptFile = (key: string) => path.join(store, `request-${recipeHash(key)}.json`);
  return { service: make(), restart: make, batch, jobs: fake.jobs, runtimeDir, store, receiptFile };
}
/** The real batch service and frozen storage in a temporary runtime; nothing ever runs (always busy). */
async function realBatch(root: string, limits?: Record<string, number>) {
  const generation = { lookup: async () => null, submit: async () => { throw new Error('no generation'); }, read: async () => null, cancel: async () => null, subscribe: () => () => {} } as any;
  const batch = createBatchService({ generation, ...(limits ? { storage: createBatchStorage(root, limits) } : { runtimeDir: root }), isBusy: () => true, wait: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.min(ms, 2))) });
  cleanups.push(() => batch.dispose());
  await batch.ready; return batch;
}

describe('receipt slots (H7)', () => {
  it('new receipts take a 16 KiB slot in every state and bound a stored error to 2 KiB', async () => {
    const { service, batch, receiptFile } = await setup(), recipe = await service.put_queue_recipe({ preparation: prep() });
    await service.enqueue_queue_recipes({ requestKey: 'slot-accepted', items: [item(recipe, 1)] });
    batch.enqueue.mockRejectedValueOnce(Object.assign(new Error(`full ${'é"\n'.repeat(4000)}`), { code: 'queue_full' }));
    const rejected: any = await service.enqueue_queue_recipes({ requestKey: 'slot-rejected', items: [item(recipe, 2)] }).catch(error => error);
    batch.enqueue.mockRejectedValueOnce(new Error('connection dropped'));
    await expect(service.enqueue_queue_recipes({ requestKey: 'slot-unknown', items: [item(recipe, 3)] })).rejects.toMatchObject({ code: 'queue_acceptance_unknown' });
    for (const key of ['slot-accepted', 'slot-rejected', 'slot-unknown']) expect((await fs.stat(receiptFile(key))).size).toBe(SLOT);
    expect(rejected.code).toBe('queue_full');
    expect(Buffer.byteLength(JSON.stringify(rejected.message)) - 2).toBeLessThanOrEqual(RECIPE_STORE_LIMITS.receiptErrorBytes);
    expect(rejected.message.startsWith('full é"\né"\n')).toBe(true);
    // The thrown, stored and replayed error are the same bounded text.
    await expect(service.enqueue_queue_recipes({ requestKey: 'slot-rejected', items: [item(recipe, 2)] })).rejects.toMatchObject({ code: 'queue_full', message: rejected.message });
    expect(await service.lookup_queue_request({ requestKey: 'slot-rejected' })).toEqual({ batch: null, status: 'rejected', inFlight: false, error: { code: 'queue_full', message: rejected.message } });
  });

});

describe('frozen-queue capacity precheck before the receipt (H4, recipe side)', () => {
  const capacity = (bytes: number, batches = 1) => ({ batches, batchLimit: 4096, bytes, byteLimit: 512 * 1024 * 1024, reserve: 32 * 1024 * 1024 });
  it('refuses queue_full without writing a receipt or using the key; one bounded reclaim is tried first', async () => {
    const state = { capacity: capacity(480 * 1024 * 1024 - 1000) as any };
    const { batch } = fakeBatch({ capacity: vi.fn(() => state.capacity), reclaim: vi.fn(async () => ({ compacted: 0, capacity: state.capacity })) });
    const h = await setup({ batch }), recipe = await h.service.put_queue_recipe({ preparation: prep() }), args = { requestKey: 'mcp-no-room', items: [item(recipe, 1)] };
    const failure: any = await h.service.enqueue_queue_recipes(args).catch(error => error);
    expect(failure).toMatchObject({ code: 'queue_full', details: { frozenQueue: { bytes: state.capacity.bytes }, estimatedBytes: expect.any(Number) } });
    expect(failure.message).toMatch(/requestKey was not used/);
    expect(batch.reclaim).toHaveBeenCalledExactlyOnceWith(8);
    expect(await h.service.lookup_queue_request({ requestKey: args.requestKey })).toEqual({ batch: null, inFlight: false });
    expect(await fs.readdir(h.store)).not.toContain(path.basename(h.receiptFile(args.requestKey)));
    expect(batch.enqueue).not.toHaveBeenCalled();
    // Reclaim frees space: the same key is accepted.
    batch.reclaim.mockImplementationOnce(async () => ({ compacted: 3, capacity: capacity(100 * 1024 * 1024) }));
    expect((await h.service.enqueue_queue_recipes(args)).requestKey).toBe(args.requestKey);
    expect(batch.reclaim).toHaveBeenCalledTimes(2); expect(batch.enqueue).toHaveBeenCalledTimes(1);
    // A full batch count cannot be reclaimed: refused at once.
    state.capacity = capacity(1024, 4096); batch.reclaim.mockClear();
    await expect(h.service.enqueue_queue_recipes({ requestKey: 'mcp-no-slot', items: [item(recipe, 2)] })).rejects.toMatchObject({ code: 'queue_full', message: /maximum of 4096 batches/ });
    expect(batch.reclaim).not.toHaveBeenCalled();
    // Unknown capacity leaves the decision to the batch service.
    state.capacity = null;
    await h.service.enqueue_queue_recipes({ requestKey: 'mcp-unknown-capacity', items: [item(recipe, 3)] });
    expect(batch.enqueue).toHaveBeenCalledTimes(2);
  });

  it('with the real batch service and storage: refuses an image batch that does not fit, before any receipt, and the queue stays usable', async () => {
    const root = await runtime(), batch = await realBatch(root, { total: 4 * 1024 * 1024 });
    const h = await setup({ batch, runtimeDir: root });
    // Fixed extra-noise seeds: see the report on queued i2i with a random extra-noise seed.
    const image = (index: number) => h.service.put_queue_recipe({ preparation: { mode: 'i2i', authored: { params: { positivePrompt: `room ${index}`, negativePrompt: '', seed: 3, seedMode: 'fixed', width: 512, height: 512 }, i2iParams: { strength: 0.5, noise: 0, extraNoiseSeed: 11 } }, assets: [{ role: 'source', mimeType: 'image/png', data: noisePng(512) }] } });
    const big = [await image(1), await image(2)];
    const before = batch.capacity()!;
    await h.service.enqueue_queue_recipes({ requestKey: 'mcp-fits', items: big.map(value => item(value, 1)) });
    const used = batch.capacity()!;
    const refused: any = await h.service.enqueue_queue_recipes({ requestKey: 'mcp-too-big', items: big.map(value => item(value, 2)) }).catch(error => error);
    expect(refused.code).toBe('queue_full');
    expect(refused.details.estimatedBytes).toBeGreaterThanOrEqual(used.bytes - before.bytes);
    expect(await h.service.lookup_queue_request({ requestKey: 'mcp-too-big' })).toEqual({ batch: null, inFlight: false });
    expect(batch.capacity()).toEqual(used); // nothing reached frozen storage
    const small = await h.service.put_queue_recipe({ preparation: prep() });
    expect((await h.service.enqueue_queue_recipes({ requestKey: 'mcp-small', items: [item(small, 4)] })).status).toBe('queued');
  });

  it('estimates, from the stored recipes alone, an upper bound of what the frozen queue really adds (within 8 KiB + 2 KiB per stored snapshot)', async () => {
    const root = await runtime(), batch = await realBatch(root), h = await setup({ batch, runtimeDir: root });
    const t2i = await Promise.all(Array.from({ length: 20 }, (_, index) => h.service.put_queue_recipe({ preparation: index ? prep(`cup ${index}`) : { ...prep('cup 0'), authored: { ...prep().authored, charCaptions: [{ prompt: 'adult woman, red coat', negativePrompt: 'hat', useCoords: true, x: 0.3, y: 0.6 }] } } })));
    const source = { role: 'source', mimeType: 'image/png', data: noisePng(256) }, mask = (() => { const png = new PNG({ width: 256, height: 256 }); for (let index = 0; index < png.data.length; index += 4) { const on = index % 1024 < 512 ? 255 : 0; png.data.set([on, on, on, 255], index); } return { role: 'mask', mimeType: 'image/png', data: PNG.sync.write(png).toString('base64') }; })();
    const imageParams = { positivePrompt: 'room', negativePrompt: '', seed: 3, seedMode: 'fixed', width: 256, height: 256 };
    const recipes = {
      // Fixed extra-noise seeds: see the report on queued i2i/enhance with a random extra-noise seed.
      i2i: await h.service.put_queue_recipe({ preparation: { mode: 'i2i', authored: { params: imageParams, i2iParams: { strength: 0.5, noise: 0, extraNoiseSeed: 11 } }, assets: [source] } }),
      enhance: await h.service.put_queue_recipe({ preparation: { mode: 'enhance', authored: { params: imageParams, i2iParams: { extraNoiseSeed: 12 }, enhanceMagnitude: 3, enhanceScale: 1 }, assets: [source] } }),
      inpaint: await h.service.put_queue_recipe({ preparation: { mode: 'inpaint', authored: { params: {}, inpaintModel: 'nai-diffusion-4-5-full-inpainting', inpaintStrength: 0.8, inpaintRecipe: { ...imageParams, model: 'nai-diffusion-4-5-full' } }, assets: [source, mask] } }),
      upscale: await h.service.put_queue_recipe({ preparation: { mode: 'upscale', authored: { params: {}, upscaleScale: 2 }, assets: [source] } }),
      director: await h.service.put_queue_recipe({ preparation: { mode: 'director', authored: { params: {}, directorTool: 'colorize', augmentOptions: { defry: 1, colorizePrompt: 'blue', emotion: 'happy', emotionLevel: 0 } }, assets: [source] } }),
    };
    const stored = async (value: any) => JSON.parse(await fs.readFile(path.join(h.store, `${value.recipeId}.${value.recipeRevision}.json`), 'utf8')).preparation;
    const plans: Array<[string, any[]]> = [['one', [item(t2i[0], 1)]], ['same', t2i.map((_, index) => item(t2i[1], index + 1))], ['distinct', t2i.map((value, index) => item(value, 2147483000 + index))], ['random', t2i.map(value => item(value))],
      ['i2i', [item(recipes.i2i, 1), item(recipes.i2i, 2)]], ['enhance', [item(recipes.enhance, 1)]], ['inpaint', [item(recipes.inpaint, 1), item(recipes.inpaint, 2)]], ['upscale', [item(recipes.upscale)]], ['director', [item(recipes.director)]]];
    for (const [label, items] of plans) for (const requestKey of [`mcp-${label}`, `${label}-${'ключ"\\'.repeat(40)}`.slice(0, 120)]) {
      const before = batch.capacity()!.bytes, job = await h.service.enqueue_queue_recipes({ requestKey, items });
      expect(job.status).toBe('queued');
      const actual = batch.capacity()!.bytes - before + 160; // + the create transaction the storage reserves
      const estimate = estimateFrozenBatchBytes(requestKey, await Promise.all(items.map(async value => ({ recipe: `${value.recipeId}:${value.recipeRevision}`, preparation: await stored(value) }))));
      expect(estimate, `${label} ${requestKey}`).toBeGreaterThanOrEqual(actual); expect(estimate - actual, `${label} ${requestKey}`).toBeLessThan(8 * 1024 + 2048 * (new Set(items.map(value => value.recipeId)).size === 1 ? 1 : items.length));
    }
  });
});

describe('recipe store limits and list_queue storage', () => {
  it('enforces the record limit (16,384 in production); a full store refuses a receipt before using the key', async () => {
    expect(RECIPE_STORE_LIMITS.records).toBe(16_384);
    // The same limit path with a small fixture limit; 16,384 real files made the full suite slow enough to starve other tests.
    const runtimeDir = await runtime(), fake = fakeBatch(), limit = 64, service = createQueueRecipeService({ runtimeDir, batch: fake.batch, recordLimit: limit });
    const store = path.join(runtimeDir, 'queue-recipes'), recipe = await service.put_queue_recipe({ preparation: prep() });
    for (let index = (await fs.readdir(store)).length; index < limit - 1; index++) await fs.writeFile(path.join(store, `${randomUUID()}.1.json`), '{}');
    await service.put_queue_recipe({ preparation: prep('the last one') });
    expect((await fs.readdir(store)).length).toBe(limit);
    await expect(service.put_queue_recipe({ preparation: prep('one too many') })).rejects.toMatchObject({ code: 'queue_storage_failed', message: new RegExp(`${limit} records`) });
    await expect(service.enqueue_queue_recipes({ requestKey: 'mcp-store-full', items: [item(recipe, 1)] })).rejects.toMatchObject({ code: 'queue_storage_failed' });
    expect(await service.lookup_queue_request({ requestKey: 'mcp-store-full' })).toEqual({ batch: null, inFlight: false });
    expect(fake.batch.enqueue).not.toHaveBeenCalled();
    expect((await service.list_queue({})).storage.recipeStore).toEqual({ records: limit, recordLimit: limit, bytes: expect.any(Number), byteLimit: 512 * 1024 * 1024 });
    expect((await createQueueRecipeService({ runtimeDir, batch: fake.batch }).list_queue({})).storage.recipeStore).toMatchObject({ records: limit, recordLimit: 16_384 });
  });

  it('list_queue adds storage {frozenQueue, recipeStore} from the latest scans, null when unknown, batches unchanged', async () => {
    const root = await runtime(), batch = await realBatch(root);
    const h = await setup({ batch, runtimeDir: root }), recipe = await h.service.put_queue_recipe({ preparation: prep() });
    await h.service.enqueue_queue_recipes({ requestKey: 'mcp-listed', items: [item(recipe, 1)] });
    const listed = await h.restart().list_queue({}), capacity = batch.capacity()!;
    expect(Object.keys(listed).sort()).toEqual(['batches', 'storage']);
    expect(listed.batches.map((job: any) => job.requestKey)).toEqual(['mcp-listed']);
    let records = 0, bytes = 0; for (const name of await fs.readdir(h.store)) { records++; bytes += (await fs.stat(path.join(h.store, name))).size; }
    expect(listed.storage).toEqual({
      frozenQueue: { batches: capacity.batches, batchLimit: capacity.batchLimit, bytes: capacity.bytes, byteLimit: capacity.byteLimit },
      recipeStore: { records, recordLimit: 16_384, bytes, byteLimit: 512 * 1024 * 1024 },
    });
    const plain = await setup();
    await plain.service.put_queue_recipe({ preparation: prep() });
    expect((await plain.service.list_queue({})).storage).toEqual({ frozenQueue: null, recipeStore: { records: 1, recordLimit: 16_384, bytes: expect.any(Number), byteLimit: 512 * 1024 * 1024 } });
    expect(QUEUE_WORKSPACE).toBe('recipe-queue');
  });
});

describe('review rework P3-1: admission before the receipt', () => {
  const generation = () => ({ lookup: async () => null, submit: async () => { throw new Error('no generation'); }, read: async () => null, cancel: async () => null, subscribe: () => () => {} } as any);
  /** A recipe service over a real frozen store of `total` bytes, with an in-flight 20-item batch and the remaining room
   * set to `above` bytes beyond the new batch's estimate. `beforeCreate` runs inside the frozen create. */
  async function rig(above: number) {
    const root = await runtime(), total = 2 * 1024 * 1024, reserve = 64 * 1024, disk = createBatchStorage(root, { total, reserve });
    const hook: { beforeCreate: null | (() => Promise<void>); calls: number } = { beforeCreate: null, calls: 0 };
    const storage = { ...disk, create: async (input: any) => { const run = hook.beforeCreate; hook.beforeCreate = null; if (run) { hook.calls++; await run(); } return disk.create(input); } };
    const batch = createBatchService({ generation: generation(), storage, isBusy: () => true, wait: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.min(ms, 2))) });
    cleanups.push(() => batch.dispose()); await batch.ready;
    const h = await setup({ batch, runtimeDir: root });
    const inflight = await h.service.put_queue_recipe({ preparation: prep('in flight') });
    const running = await h.service.enqueue_queue_recipes({ requestKey: 'mcp-inflight', items: Array.from({ length: 20 }, (_, index) => item(inflight, index + 1)) });
    const recipe = await h.service.put_queue_recipe({ preparation: prep('raced') }), key = 'mcp-raced';
    const stored = JSON.parse(await fs.readFile(path.join(h.store, `${recipe.recipeId}.1.json`), 'utf8')).preparation;
    const estimate = estimateFrozenBatchBytes(key, [{ recipe: `${recipe.recipeId}:1`, preparation: stored }]);
    // Fill the store with two direct batches so that exactly estimate + `above` stays free above the reserve.
    const remaining = () => { const value = batch.capacity()!; return value.byteLimit - value.reserve - value.bytes; };
    const fill = async (requestKey: string, bytes: number) => batch.enqueue({ execution: 'queued', workspaceId: 'filler', expectedRevision: 0, requestKey, mode: 't2i', count: 1, intervalSeconds: 0, seeds: [1],
      snapshot: { params: { positivePrompt: 'x'.repeat(Math.max(1, bytes)), seed: 1, seedMode: 'fixed' }, extras: { vibeImages: [], preciseReferences: [], charCaptions: [] } } });
    const firstSize = Math.floor((remaining() - estimate - above) / 2), before = remaining();
    await fill('filler-1', firstSize);
    const overhead = before - remaining() - firstSize;
    await fill('filler-2', remaining() - estimate - above - overhead);
    expect(Math.abs(remaining() - estimate - above)).toBeLessThan(256);
    const pauseResume = async () => { for (let index = 0; index < 2; index++) { await batch.pause({ workspaceId: 'recipe-queue', expectedRevision: 0, batchId: running.batchId }); await batch.resume({ workspaceId: 'recipe-queue', expectedRevision: 0, batchId: running.batchId }); } };
    return { h, batch, hook, recipe, key, estimate, remaining, pauseResume, running };
  }

  it('a progress save between the precheck and the frozen create cannot consume the key; enough margin still admits the batch', async () => {
    const tight = await rig(8 * 1024), plan = { requestKey: tight.key, items: [item(tight.recipe, 1)] };
    tight.hook.beforeCreate = tight.pauseResume; // the in-flight batch saves progress four times inside the window
    const refused: any = await tight.h.service.enqueue_queue_recipes(plan).catch(error => error);
    expect(refused.code).toBe('queue_full');
    expect(await tight.h.service.lookup_queue_request({ requestKey: plan.requestKey })).toEqual({ batch: null, inFlight: false });
    expect(tight.hook.calls).toBe(0); // refused before any receipt or frozen create
    const roomy = await rig(FROZEN_PRECHECK_SAVE_MARGIN + 64 * 1024), roomyPlan = { requestKey: roomy.key, items: [item(roomy.recipe, 1)] };
    roomy.hook.beforeCreate = roomy.pauseResume;
    expect((await roomy.h.service.enqueue_queue_recipes(roomyPlan)).status).toBe('queued');
    expect(roomy.hook.calls).toBe(1);
    expect((await roomy.h.service.lookup_queue_request({ requestKey: roomyPlan.requestKey })).status).toBe('accepted');
  });

  it('the 200 unfinished-item limit is checked before the receipt', async () => {
    const root = await runtime(), batch = await realBatch(root), h = await setup({ batch, runtimeDir: root }), recipe = await h.service.put_queue_recipe({ preparation: prep() });
    for (let round = 0; round < 10; round++) await h.service.enqueue_queue_recipes({ requestKey: `mcp-load-${round}`, items: Array.from({ length: 20 }, (_, index) => item(recipe, round * 20 + index + 1)) });
    const refused: any = await h.service.enqueue_queue_recipes({ requestKey: 'mcp-one-more', items: [item(recipe, 999)] }).catch(error => error);
    expect(refused).toMatchObject({ code: 'queue_full' });
    expect(refused.message).toMatch(/200/);
    expect(await h.service.lookup_queue_request({ requestKey: 'mcp-one-more' })).toEqual({ batch: null, inFlight: false });
    expect(await fs.readdir(h.store)).not.toContain(path.basename(h.receiptFile('mcp-one-more')));
  });

  it('a frozen queue that already failed refuses before the receipt instead of leaving an unknown key', async () => {
    const root = await runtime(), disk = createBatchStorage(root); let failNext = true;
    const storage = { ...disk, create: async (input: any) => { if (failNext) { failNext = false; throw new Error('disk vanished'); } return disk.create(input); } };
    const batch = createBatchService({ generation: generation(), storage, isBusy: () => true, wait: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.min(ms, 2))) });
    cleanups.push(() => batch.dispose()); await batch.ready;
    const h = await setup({ batch, runtimeDir: root }), recipe = await h.service.put_queue_recipe({ preparation: prep() });
    await expect(h.service.enqueue_queue_recipes({ requestKey: 'mcp-first', items: [item(recipe, 1)] })).rejects.toMatchObject({ code: 'queue_acceptance_unknown' });
    const second: any = await h.service.enqueue_queue_recipes({ requestKey: 'mcp-second', items: [item(recipe, 2)] }).catch(error => error);
    expect(second.code).toBe('queue_storage_error');
    expect(await h.service.lookup_queue_request({ requestKey: 'mcp-second' })).toEqual({ batch: null, inFlight: false });
  });
});

describe('review round 3: P3-d', () => {
  it('a request whose inputHash differs from the stored recipe is refused before the receipt', async () => {
    const h = await setup(), recipe = await h.service.put_queue_recipe({ preparation: prep() });
    const plan = { requestKey: 'mcp-stale-hash', items: [{ ...item(recipe, 1), inputHash: '0'.repeat(64) }] };
    await expect(h.service.enqueue_queue_recipes(plan)).rejects.toMatchObject({ code: 'recipe_changed', message: /requestKey was not used/ });
    expect(await h.service.lookup_queue_request({ requestKey: plan.requestKey })).toEqual({ batch: null, inFlight: false });
    expect((await h.service.enqueue_queue_recipes({ requestKey: plan.requestKey, items: [item(recipe, 1)] })).requestKey).toBe(plan.requestKey); // the key is still free
    expect(h.batch.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('review round 4 P3-2: after a receipt exists, an unreadable frozen queue is reported as unknown, never as queue_storage_error', () => {
  const generation = () => ({ lookup: async () => null, submit: async () => { throw new Error('no generation'); }, read: async () => null, cancel: async () => null, subscribe: () => () => {} } as any);
  const service = (root: string, storage: any) => {
    const batch = createBatchService({ generation: generation(), storage, isBusy: () => true, wait: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.min(ms, 2))) });
    cleanups.push(() => batch.dispose()); return batch;
  };
  it('the frozen input reached disk and then the store failed (script E): same-key retries and lookups answer queue_acceptance_unknown; a restart finds the batch', async () => {
    const root = await runtime(), disk = createBatchStorage(root); let failAfterWrite = true;
    const storage = { ...disk, create: async (input: any) => { const sequence = await disk.create(input); if (failAfterWrite) { failAfterWrite = false; throw new Error('fsync failed after publication'); } return sequence; } };
    const batch = service(root, storage); await batch.ready;
    const h = await setup({ batch, runtimeDir: root }), recipe = await h.service.put_queue_recipe({ preparation: prep() }), plan = { requestKey: 'mcp-written-then-failed', items: [item(recipe, 1)] };
    await expect(h.service.enqueue_queue_recipes(plan)).rejects.toMatchObject({ code: 'queue_acceptance_unknown' });
    const retry: any = await h.service.enqueue_queue_recipes(plan).catch(error => error);
    const lookup: any = await h.service.lookup_queue_request({ requestKey: plan.requestKey }).catch(error => error);
    expect([retry.code, lookup.code]).toEqual(['queue_acceptance_unknown', 'queue_acceptance_unknown']);
    expect(retry.message).toMatch(/do not resend/i);
    // A request without a receipt is still refused up front with queue_storage_error (nothing written).
    await expect(h.service.enqueue_queue_recipes({ requestKey: 'mcp-new-after-failure', items: [item(recipe, 2)] })).rejects.toMatchObject({ code: 'queue_storage_error' });
    expect(await h.service.lookup_queue_request({ requestKey: 'mcp-new-after-failure' })).toEqual({ batch: null, inFlight: false });
    await batch.dispose();
    const restarted = service(root, createBatchStorage(root)); await restarted.ready;
    const again = createQueueRecipeService({ runtimeDir: root, batch: restarted });
    expect(await again.lookup_queue_request({ requestKey: plan.requestKey })).toMatchObject({ status: 'accepted', batch: { requestKey: plan.requestKey } });
  });

  it('a frozen queue that failed to load: requests with a receipt are unknown, requests without one are refused up front', async () => {
    const root = await runtime(), good = service(root, createBatchStorage(root)); await good.ready;
    const h = await setup({ batch: good, runtimeDir: root }), recipe = await h.service.put_queue_recipe({ preparation: prep() }), plan = { requestKey: 'mcp-before-damage', items: [item(recipe, 1)] };
    await h.service.enqueue_queue_recipes(plan); await good.dispose();
    const disk = createBatchStorage(root), broken = { ...disk, load: async () => { throw new Error('unreadable frozen queue'); } };
    const failed = service(root, broken); await failed.ready.catch(() => undefined);
    const queue = createQueueRecipeService({ runtimeDir: root, batch: failed });
    const retry: any = await queue.enqueue_queue_recipes(plan).catch(error => error), lookup: any = await queue.lookup_queue_request({ requestKey: plan.requestKey }).catch(error => error);
    expect([retry.code, lookup.code]).toEqual(['queue_acceptance_unknown', 'queue_acceptance_unknown']);
    await expect(queue.enqueue_queue_recipes({ requestKey: 'mcp-no-receipt', items: [item(recipe, 2)] })).rejects.toMatchObject({ code: 'queue_storage_error' });
    expect(await queue.lookup_queue_request({ requestKey: 'mcp-no-receipt' })).toEqual({ batch: null, inFlight: false });
  });
});

