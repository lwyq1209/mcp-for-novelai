import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
vi.mock('axios', () => ({ default: { get: () => { throw new Error('No network'); }, post: () => { throw new Error('No network'); } } }));
vi.mock('./ipc/store', () => ({ getToken: () => { throw new Error('No account'); }, getSettings: () => { throw new Error('No settings'); } }));
vi.mock('electron', () => ({ app: {}, dialog: {}, nativeImage: {} }));
import { createQueueRecipeService, recipeHash, RECIPE_RECLAIM_POLICY, type CanvasOrigin } from './queue-recipe-service';
import { createBatchService } from './batch-service';
import { QUEUE_WORKSPACE } from './queue-recipe-service';
import { waitUntil } from '../src/test-support/wait-until';

// Reclamation of canvas captures (prepare_recipe {canvas}): what it removes, what it never removes, and that queue
// reads, lookups and repeated enqueues of ended batches keep working afterwards. Real recipe store, real batch service
// and frozen storage in a temporary runtime; the generator is a double that saves nothing.
const DAY = 24 * 60 * 60 * 1000, GRACE = RECIPE_RECLAIM_POLICY.graceMs;
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(() => runCleanups(cleanups.splice(0).reverse()));
const prep = (positivePrompt = 'teacup, table') => ({ mode: 't2i', authored: { params: { positivePrompt, negativePrompt: 'text', seed: 42, seedMode: 'fixed', width: 64, height: 64 } }, assets: [] });
const origin = (capturedAt: number, extra: Partial<CanvasOrigin> = {}): CanvasOrigin => ({ workspaceId: 'novelai-window', revision: 3, draftId: null, patched: false, capturedAt: new Date(capturedAt).toISOString(), ...extra });
const item = (value: any, seed?: number) => ({ recipeId: value.recipeId, recipeRevision: value.recipeRevision, inputHash: value.inputHash, ...(seed === undefined ? {} : { seed }) });

async function runtime() { const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nai-recipe-reclaim-'))); cleanups.push(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
/** Real batch service; `busy` holds every queued batch before its first image; otherwise each image succeeds at once. */
async function host({ batch: given, recordLimit, reclaim = {} }: { batch?: any; recordLimit?: number; reclaim?: Record<string, unknown> } = {}) {
  const runtimeDir = await runtime();
  const state = { busy: false, clock: Date.now(), submitted: 0 };
  const generation = {
    lookup: async () => null, read: async () => null, cancel: async () => null, subscribe: () => () => {},
    async submit(args: any) {
      state.submitted++;
      const now = new Date().toISOString();
      return { jobId: randomUUID(), workspaceId: args.workspaceId, requestKey: args.requestKey, originWorkspaceId: args.workspaceId, submittedRevision: args.expectedRevision, mode: args.mode, status: 'succeeded', actualSeed: args.snapshot.params.seed,
        providerOutcome: 'response_received', results: [{ index: 0, id: `history-${state.submitted}`, width: 64, height: 64, model: 'm', actualSeed: args.snapshot.params.seed }], error: null, createdAt: now, updatedAt: now };
    },
  } as any;
  const batch = given ?? createBatchService({ generation, runtimeDir, isBusy: () => state.busy, wait: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.min(ms, 2))) });
  if (!given) { cleanups.push(() => batch.dispose()); await batch.ready; }
  const service = createQueueRecipeService({ runtimeDir, batch, randomSeed: () => 97, recipeReclaim: { auto: false, now: () => state.clock, log: () => {}, ...reclaim }, ...(recordLimit ? { recordLimit } : {}) });
  const store = path.join(runtimeDir, 'queue-recipes');
  const recordFile = (recipe: any) => path.join(store, `${recipe.recipeId}.${recipe.recipeRevision}.json`);
  const exists = (recipe: any) => fs.lstat(recordFile(recipe)).then(() => true, () => false);
  const capture = (capturedAt: number, positivePrompt?: string) => service.put_canvas_recipe({ preparation: prep(positivePrompt), canvasOrigin: origin(capturedAt), assetData: 'omit' });
  return { service, batch, state, runtimeDir, store, recordFile, exists, capture };
}
const settled = async (h: Awaited<ReturnType<typeof host>>, batchId: string, status = 'succeeded') => waitUntil(async () => expect((await h.service.read_queue({ batchId })).status).toBe(status), { interval: 10 });

describe('canvas recipe reclamation', () => {
  it('stores the canvas origin before the preparation, and reclaims nothing but old captures', async () => {
    const h = await host(), now = Date.now();
    const old = await h.capture(now - 30 * DAY), plain = await h.service.put_queue_recipe({ preparation: prep('plain recipe') });
    expect((await fs.readFile(h.recordFile(old), 'utf8')).startsWith(`{"schemaVersion":1,"recipeId":"${old.recipeId}","recipeRevision":1,"canvasOrigin":{`)).toBe(true);
    h.state.clock = now + 365 * DAY;
    expect(await h.service.reclaimRecipes()).toMatchObject({ reclaimed: 1, examined: 1, kept: 0, skipped: null });
    expect(await h.exists(old)).toBe(false);
    expect(await h.exists(plain)).toBe(true);
    // Every receipt, every plain recipe and the store's own lock files are left alone.
    expect((await fs.readdir(h.store)).filter(name => !name.startsWith('.'))).toEqual([`${plain.recipeId}.1.json`]);
    await expect(h.service.read_queue_recipe({ recipeId: old.recipeId, recipeRevision: 1 })).rejects.toMatchObject({ code: 'recipe_not_found' });
  });

  it('keeps a capture within its grace period after capture, even when it was never enqueued', async () => {
    const h = await host(), now = Date.now(), recipe = await h.capture(now);
    h.state.clock = now + GRACE - 60_000;
    expect(await h.service.reclaimRecipes()).toMatchObject({ reclaimed: 0, kept: 1 });
    h.state.clock = now + GRACE + 60_000;
    expect(await h.service.reclaimRecipes()).toMatchObject({ reclaimed: 1 });
    expect(await h.exists(recipe)).toBe(false);
  });

  it('never reclaims a capture an unfinished batch names, however old both are', async () => {
    const h = await host(), now = Date.now(), recipe = await h.capture(now - 300 * DAY);
    h.state.busy = true;
    const accepted = await h.service.enqueue_queue_recipes({ requestKey: 'mcp-unfinished', items: [item(recipe, 1), item(recipe, 2)] });
    expect(accepted.status).toBe('queued');
    h.state.clock = now + 3650 * DAY;
    expect(await h.service.reclaimRecipes()).toMatchObject({ reclaimed: 0, kept: 1 });
    await h.service.pause_queue({ batchId: accepted.batchId });
    expect(await h.service.reclaimRecipes()).toMatchObject({ reclaimed: 0 });
    expect(await h.exists(recipe)).toBe(true);
  });

  it('reclaims a capture only once every batch naming it ended a grace period ago; lookups, reads and repeats of the ended batch still work', async () => {
    const h = await host(), now = Date.now(), recipe = await h.capture(now - 30 * DAY), other = await h.capture(now - 30 * DAY, 'another canvas');
    const first = await h.service.enqueue_queue_recipes({ requestKey: 'mcp-first', items: [item(recipe, 1)] });
    await settled(h, first.batchId);
    h.state.busy = true;
    const second = await h.service.enqueue_queue_recipes({ requestKey: 'mcp-second', items: [item(recipe, 2), item(other, 3)] });
    h.state.clock = Date.now() + GRACE + 60_000;
    expect(await h.service.reclaimRecipes(), 'the second batch has not ended').toMatchObject({ reclaimed: 0, kept: 2 });
    h.state.busy = false;
    await settled(h, second.batchId);
    h.state.clock = Date.now() + GRACE - 60_000;
    expect(await h.service.reclaimRecipes(), 'the second batch ended less than the grace period ago').toMatchObject({ reclaimed: 0 });
    h.state.clock = Date.now() + GRACE + 60_000;
    expect(await h.service.reclaimRecipes()).toMatchObject({ reclaimed: 2 });
    expect([await h.exists(recipe), await h.exists(other)]).toEqual([false, false]);
    // Nothing that answers for an ended batch reads its recipes.
    for (const [key, batch] of [['mcp-first', first], ['mcp-second', second]] as const) {
      expect(await h.service.lookup_queue_request({ requestKey: key })).toMatchObject({ status: 'accepted', batch: { batchId: batch.batchId, status: 'succeeded' } });
      expect(await h.service.read_queue({ batchId: batch.batchId })).toMatchObject({ batchId: batch.batchId, status: 'succeeded', recipePlanHash: batch.recipePlanHash });
    }
    const repeated = await h.service.enqueue_queue_recipes({ requestKey: 'mcp-second', items: [item(recipe, 2), item(other, 3)] });
    expect(repeated.batchId).toBe(second.batchId);
    expect((await h.service.list_queue({})).batches.map((value: any) => value.batchId).sort()).toEqual([first.batchId, second.batchId].sort());
    expect(h.state.submitted).toBe(3);
    // A new request for a reclaimed recipe is refused before it has a receipt.
    await expect(h.service.enqueue_queue_recipes({ requestKey: 'mcp-third', items: [item(recipe, 9)] })).rejects.toMatchObject({ code: 'recipe_not_found' });
    expect(await h.service.lookup_queue_request({ requestKey: 'mcp-third' })).toEqual({ batch: null, inFlight: false });
  });

  it('keeps a capture whose enqueue is preparing or unknown, and one rejected less than the grace period ago', async () => {
    const jobs = new Map<string, any>();
    const batch = { ready: Promise.resolve(), enqueue: vi.fn(async (args: any) => { const job = { ...args, batchId: randomUUID(), originWorkspaceId: args.workspaceId, submittedRevision: 0, status: 'queued', items: args.seeds.map((plannedSeed: number, index: number) => ({ index, plannedSeed, status: 'pending', jobId: null, results: [] })) }; delete job.snapshot; delete job.snapshots; jobs.set(args.requestKey, job); return job; }),
      lookup: vi.fn((args: any) => jobs.get(args.requestKey) ?? null), list: vi.fn(() => ({ batches: [...jobs.values()] })), read: vi.fn((args: any) => [...jobs.values()].find(value => value.batchId === args.batchId)) };
    const h = await host({ batch }), now = Date.now();
    const unknown = await h.capture(now - 30 * DAY, 'unknown'), rejected = await h.capture(now - 30 * DAY, 'rejected');
    batch.enqueue.mockRejectedValueOnce(new Error('connection dropped'));
    await expect(h.service.enqueue_queue_recipes({ requestKey: 'mcp-unknown', items: [item(unknown, 1)] })).rejects.toMatchObject({ code: 'queue_acceptance_unknown' });
    batch.enqueue.mockRejectedValueOnce(Object.assign(new Error('full'), { code: 'queue_full' }));
    await expect(h.service.enqueue_queue_recipes({ requestKey: 'mcp-rejected', items: [item(rejected, 1)] })).rejects.toMatchObject({ code: 'queue_full' });
    h.state.clock = Date.now() + GRACE - 60_000;
    expect(await h.service.reclaimRecipes()).toMatchObject({ reclaimed: 0, kept: 2 });
    h.state.clock = Date.now() + 3650 * DAY;
    expect(await h.service.reclaimRecipes()).toMatchObject({ reclaimed: 1, kept: 1 });
    expect([await h.exists(unknown), await h.exists(rejected)]).toEqual([true, false]);
  });

  it('skips the whole round when the frozen queue or a receipt cannot be read, and never removes a record that does not verify', async () => {
    const failed = { ready: Promise.reject(Object.assign(new Error('broken'), { code: 'queue_storage_error' })), lookup: () => null, list: () => ({ batches: [] }) };
    failed.ready.catch(() => {});
    const broken = await host({ batch: failed }), now = Date.now();
    const kept = await broken.capture(now - 30 * DAY);
    broken.state.clock = now + 3650 * DAY;
    expect(await broken.service.reclaimRecipes()).toMatchObject({ reclaimed: 0, skipped: 'frozen_queue_unreadable' });
    expect(await broken.exists(kept)).toBe(true);

    const h = await host(), recipe = await h.capture(now - 30 * DAY), tampered = await h.capture(now - 30 * DAY, 'tampered');
    const accepted = await h.service.enqueue_queue_recipes({ requestKey: 'mcp-ended', items: [item(await h.service.put_queue_recipe({ preparation: prep('plain') }), 1)] });
    await settled(h, accepted.batchId);
    const receipt = path.join(h.store, `request-${recipeHash('mcp-ended')}.json`);
    const original = await fs.readFile(receipt, 'utf8');
    await fs.writeFile(receipt, original.replace('"status":"accepted"', '"status":"rejected"'));
    h.state.clock = Date.now() + 3650 * DAY;
    expect(await h.service.reclaimRecipes()).toMatchObject({ reclaimed: 0, skipped: 'receipt_unreadable' });
    await fs.writeFile(receipt, original);
    const text = await fs.readFile(h.recordFile(tampered), 'utf8');
    await fs.writeFile(h.recordFile(tampered), text.replace('tampered', 'tamperex'));
    expect(await h.service.reclaimRecipes()).toMatchObject({ reclaimed: 1 });
    expect([await h.exists(recipe), await h.exists(tampered)]).toEqual([false, true]);
  });

  it('a full store reclaims once before refusing a new recipe, and still refuses when nothing may go', async () => {
    const h = await host({ recordLimit: 3 }), now = Date.now() + 10 * DAY;
    h.state.clock = now;
    const a = await h.capture(now - 30 * DAY, 'a'), b = await h.capture(now - 30 * DAY, 'b'), c = await h.capture(now - DAY, 'c');
    const d = await h.capture(now, 'd');
    expect([await h.exists(a), await h.exists(b), await h.exists(c), await h.exists(d)]).toEqual([false, false, true, true]);
    await h.capture(now, 'e');
    await expect(h.capture(now, 'f')).rejects.toMatchObject({ code: 'queue_storage_failed' });
    await expect(h.service.put_queue_recipe({ preparation: prep('plain') })).rejects.toMatchObject({ code: 'queue_storage_failed' });
  });

  it('runs a round at start, and the reclaimed store reports its smaller usage', async () => {
    const seed = await host(), now = Date.now(), recipe = await seed.capture(now - 30 * DAY);
    const usage = (await seed.service.list_queue({})).storage.recipeStore;
    const restarted = createQueueRecipeService({ runtimeDir: seed.runtimeDir, batch: seed.batch, recipeReclaim: { startDelayMs: 0, log: () => {} } });
    await waitUntil(() => expect(seed.exists(recipe)).resolves.toBe(false), { interval: 10 });
    // Rounds share the store's sequence: this one starts only after the start-up round has completely finished.
    expect(await restarted.reclaimRecipes()).toMatchObject({ reclaimed: 0 });
    const after = (await restarted.list_queue({})).storage.recipeStore;
    expect(after.records).toBe(usage.records - 1);
    expect(after.bytes).toBeLessThan(usage.bytes);
    expect(QUEUE_WORKSPACE).toBe('recipe-queue');
  });
});
