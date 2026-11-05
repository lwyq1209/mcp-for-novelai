// Step 3a: the two queue safety settings (single enqueue at most, total queue limit or no limit). Settings are
// validated by the store; the host checks them at every new enqueue before a receipt exists, so a refusal never
// uses the requestKey, and names the current limit. All storage is in temporary folders.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';
import { PNG } from 'pngjs';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('axios', () => ({ default: { get: () => { throw new Error('No network'); }, post: () => { throw new Error('No network'); } } }));
vi.mock('electron', () => ({
  app: { getPath: (key: string) => path.join(state.root, key), isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unavailable'); }, decryptString: () => { throw new Error('unavailable'); } },
  dialog: {},
  nativeImage: { createFromBuffer: (buffer: Buffer) => { const png = PNG.sync.read(buffer); return { isEmpty: () => false, getSize: () => ({ width: png.width, height: png.height }), toPNG: () => buffer }; } },
}));
import { QUEUE_ENQUEUE_ITEMS, QUEUE_PENDING_ITEMS, QUEUE_RETENTION_DAYS, normalizeQueueEnqueueItems, normalizeQueuePendingItems, normalizeQueueRetentionDays, queueSettingError } from '../src/queue-limits';
import { createQueueRecipeService, recipeHash, receiptSlotBytes, RECIPE_STORE_LIMITS } from './queue-recipe-service';
import { createBatchService, QUEUED_BATCH_MAX_ITEMS, QUEUED_PENDING_ITEM_LIMIT } from './batch-service';
import { DEFAULT_PARAMS } from '../src/types';

const cleanups: Array<() => unknown> = [];
afterEach(() => runCleanups([...cleanups.splice(0).reverse(), () => vi.resetModules()]));
async function temporary(prefix: string) { const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix))); cleanups.push(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
const prep = (positivePrompt = 'teacup, table') => ({ mode: 't2i', authored: { params: { positivePrompt, negativePrompt: 'text', seed: 42, seedMode: 'fixed', width: 64, height: 64 } }, assets: [] });
const item = (value: any, seed: number) => ({ recipeId: value.recipeId, recipeRevision: value.recipeRevision, inputHash: value.inputHash, seed });
const items = (recipe: any, count: number) => Array.from({ length: count }, (_, index) => item(recipe, index + 1));
function fakeBatch(admission?: () => { pendingItems: number; pendingItemLimit: number | null }) {
  const jobs = new Map<string, any>();
  const batch = { ready: Promise.resolve(), enqueue: vi.fn(async (args: any) => {
    const job = { ...args, batchId: randomUUID(), originWorkspaceId: args.workspaceId, submittedRevision: 0, status: 'queued', items: args.seeds.map((plannedSeed: number, index: number) => ({ index, plannedSeed, status: 'pending', jobId: null, results: [] })) };
    delete job.snapshots; delete job.snapshot; jobs.set(args.requestKey, job); return job;
  }), lookup: vi.fn((args: any) => jobs.get(args.requestKey) ?? null), list: vi.fn(() => ({ batches: [...jobs.values()] })),
    read: vi.fn(), pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(), ...(admission ? { queueAdmission: admission } : {}) };
  return batch;
}
async function recipes(limit: () => number, admission?: () => { pendingItems: number; pendingItemLimit: number | null }) {
  const runtimeDir = await temporary('nai-queue-safety-'), batch = fakeBatch(admission);
  const service = createQueueRecipeService({ runtimeDir, batch, randomSeed: () => 97, enqueueItemLimit: limit });
  const receipt = (key: string) => path.join(runtimeDir, 'queue-recipes', `request-${recipeHash(key)}.json`);
  return { service, batch, receipt, recipe: await service.put_queue_recipe({ preparation: prep() }) };
}

describe('queue safety values', () => {
  it('default to 20 per enqueue and 200 in total; the per-enqueue value is 1–200; the total may be unlimited (null)', () => {
    expect([QUEUE_ENQUEUE_ITEMS.default, QUEUE_ENQUEUE_ITEMS.min, QUEUE_ENQUEUE_ITEMS.max]).toEqual([20, 1, 200]);
    expect(QUEUE_PENDING_ITEMS.default).toBe(200);
    expect(QUEUED_BATCH_MAX_ITEMS).toBe(200); expect(QUEUED_PENDING_ITEM_LIMIT).toBe(200);
    for (const value of [1, 20, 200]) expect(queueSettingError('queueMaxItemsPerEnqueue', value)).toBeNull();
    for (const value of [0, 201, 2.5, '20', null, undefined, -1]) expect(queueSettingError('queueMaxItemsPerEnqueue', value)).toMatch(/1–200/);
    for (const value of [null, 1, 200, 5000, 100_000]) expect(queueSettingError('queueMaxPendingItems', value)).toBeNull();
    for (const value of [0, 100_001, 1.5, '200', undefined]) expect(queueSettingError('queueMaxPendingItems', value)).toMatch(/不限制/);
    expect([normalizeQueueEnqueueItems(undefined), normalizeQueueEnqueueItems(500), normalizeQueueEnqueueItems(50)]).toEqual([20, 20, 50]);
    expect([normalizeQueuePendingItems(undefined), normalizeQueuePendingItems(null), normalizeQueuePendingItems(0), normalizeQueuePendingItems(1000)]).toEqual([200, null, 200, 1000]);
    // Queue retention: 7, 30 or 90 days, or never (null); default 30.
    expect([...QUEUE_RETENTION_DAYS.choices, QUEUE_RETENTION_DAYS.default]).toEqual([7, 30, 90, 30]);
    for (const value of [7, 30, 90, null]) expect(queueSettingError('queueRetentionDays', value)).toBeNull();
    for (const value of [0, 1, 14, 365, '30', undefined, 30.5]) expect(queueSettingError('queueRetentionDays', value)).toMatch(/永不清理/);
    expect([normalizeQueueRetentionDays(undefined), normalizeQueueRetentionDays(null), normalizeQueueRetentionDays(14), normalizeQueueRetentionDays(90)]).toEqual([30, null, 30, 90]);
  });

  it('are saved and validated by the settings store, and an invalid stored value reads as the default', async () => {
    state.root = await temporary('nai-queue-settings-');
    const userData = path.join(state.root, 'userData');
    fsSync.mkdirSync(userData, { recursive: true });
    fsSync.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ settings: { hasOnboarded: true, queueMaxItemsPerEnqueue: 0, queueMaxPendingItems: 'lots', queueRetentionDays: 3 }, history: [], historyGroups: [] }));
    const store = await import('./ipc/store');
    expect(store.getSettings()).toMatchObject({ queueMaxItemsPerEnqueue: 20, queueMaxPendingItems: 200, queueRetentionDays: 30 });
    expect(store.setSetting('queueRetentionDays', null)).toBeNull();
    expect(() => store.setSetting('queueRetentionDays', 14)).toThrow(/永不清理/);
    expect(store.getSettings().queueRetentionDays).toBeNull();
    expect(store.setSetting('queueRetentionDays', 7)).toBe(7);
    expect(store.setSetting('queueMaxItemsPerEnqueue', 200)).toBe(200);
    expect(store.setSetting('queueMaxPendingItems', null)).toBeNull();
    expect(() => store.setSetting('queueMaxItemsPerEnqueue', 201)).toThrow(/1–200/);
    expect(() => store.setSetting('queueMaxPendingItems', 0)).toThrow(/不限制/);
    const saved = JSON.parse(fsSync.readFileSync(path.join(userData, 'settings.json'), 'utf8')).settings;
    expect(saved).toMatchObject({ queueMaxItemsPerEnqueue: 200, queueMaxPendingItems: null });
    expect(store.defaultSettings()).toMatchObject({ queueMaxItemsPerEnqueue: 20, queueMaxPendingItems: 200, queueRetentionDays: 30 });
  });
});

describe('single enqueue at most (enqueue_limit_exceeded)', () => {
  it('refuses a larger new enqueue before its receipt, names the limit, and leaves the key unused', async () => {
    let limit = 3;
    const h = await recipes(() => limit);
    const refused = await h.service.enqueue_queue_recipes({ requestKey: 'four', items: items(h.recipe, 4) }).catch((error: any) => error);
    expect(refused).toMatchObject({ code: 'enqueue_limit_exceeded', details: { requestedItems: 4, maxItemsPerEnqueue: 3 } });
    expect(refused.message).toMatch(/at most 3 per enqueue/);
    expect(h.batch.enqueue).not.toHaveBeenCalled();
    await expect(fs.stat(h.receipt('four'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await h.service.lookup_queue_request({ requestKey: 'four' })).toEqual({ batch: null });
    // The same key is free: after the user raises the limit the same plan is accepted.
    limit = 4;
    const accepted = await h.service.enqueue_queue_recipes({ requestKey: 'four', items: items(h.recipe, 4) });
    expect(accepted.count).toBe(4);
    // Lowering the setting afterwards never turns the accepted request into a refusal.
    limit = 1;
    expect((await h.service.enqueue_queue_recipes({ requestKey: 'four', items: items(h.recipe, 4) })).batchId).toBe(accepted.batchId);
    expect(h.batch.enqueue).toHaveBeenCalledTimes(1);
  });

  it('accepts up to 200 images when the setting allows it, in a receipt slot sized for them, and refuses 201 as an invalid argument', async () => {
    const h = await recipes(() => 200);
    expect(receiptSlotBytes(20)).toBe(RECIPE_STORE_LIMITS.receiptSlot);
    expect(receiptSlotBytes(21)).toBe(2 * RECIPE_STORE_LIMITS.receiptSlot);
    expect(receiptSlotBytes(200)).toBe(10 * RECIPE_STORE_LIMITS.receiptSlot);
    const accepted = await h.service.enqueue_queue_recipes({ requestKey: 'two-hundred', items: items(h.recipe, 200) });
    expect(accepted.count).toBe(200);
    expect((await fs.stat(h.receipt('two-hundred'))).size).toBe(receiptSlotBytes(200));
    expect((await h.service.lookup_queue_request({ requestKey: 'two-hundred' })).status).toBe('accepted');
    await expect(h.service.enqueue_queue_recipes({ requestKey: 'too-many', items: items(h.recipe, 201) })).rejects.toMatchObject({ code: 'invalid_argument', message: expect.stringMatching(/1–200/) });
  });

  it('without a setting keeps the default of 20', async () => {
    const runtimeDir = await temporary('nai-queue-safety-default-');
    const service = createQueueRecipeService({ runtimeDir, batch: fakeBatch(), randomSeed: () => 97 });
    const recipe = await service.put_queue_recipe({ preparation: prep() });
    await expect(service.enqueue_queue_recipes({ requestKey: 'k', items: items(recipe, 21) })).rejects.toMatchObject({ code: 'enqueue_limit_exceeded', details: { maxItemsPerEnqueue: 20 } });
  });
});

describe('total queue limit (queue_full)', () => {
  it('names the current limit before the receipt, and an unlimited setting admits any count', async () => {
    let admission: { pendingItems: number; pendingItemLimit: number | null } = { pendingItems: 9, pendingItemLimit: 10 };
    const h = await recipes(() => 200, () => admission);
    const full = await h.service.enqueue_queue_recipes({ requestKey: 'full', items: items(h.recipe, 2) }).catch((error: any) => error);
    expect(full).toMatchObject({ code: 'queue_full', details: { pendingItems: 9, pendingItemLimit: 10 } });
    expect(full.message).toMatch(/at most 10/);
    await expect(fs.stat(h.receipt('full'))).rejects.toMatchObject({ code: 'ENOENT' });
    admission = { pendingItems: 5000, pendingItemLimit: null };
    expect((await h.service.enqueue_queue_recipes({ requestKey: 'full', items: items(h.recipe, 2) })).count).toBe(2);
  });

  it('is read by the batch service at every enqueue: a number refuses above it, null never refuses by count', async () => {
    const root = await temporary('nai-queue-safety-batch-');
    let limit: number | null = 3;
    const generation = { lookup: async () => null, submit: async () => { throw new Error('no generation'); }, read: async () => null, cancel: async () => null, subscribe: () => () => {} } as any;
    const batch = createBatchService({ generation, runtimeDir: root, isBusy: () => true, pendingItemLimit: () => limit, wait: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.min(ms, 2))) });
    cleanups.push(() => batch.dispose());
    await batch.ready;
    const snapshot = { params: { ...DEFAULT_PARAMS, positivePrompt: 'a blue teacup', seed: 42, seedMode: 'fixed' }, extras: { vibeImages: [], preciseReferences: [], charCaptions: [] }, batchCount: 1 };
    const queued = (requestKey: string, count: number) => ({ execution: 'queued', workspaceId: 'queue', expectedRevision: 0, requestKey, mode: 't2i', count, intervalSeconds: 0, seeds: Array.from({ length: count }, (_, index) => index + 1), snapshot });
    expect(batch.queueAdmission()).toEqual({ pendingItems: 0, pendingItemLimit: 3 });
    await batch.enqueue(queued('a', 2));
    await expect(batch.enqueue(queued('b', 2))).rejects.toMatchObject({ code: 'queue_full', message: expect.stringContaining('3') });
    limit = null;
    expect(batch.queueAdmission()).toEqual({ pendingItems: 2, pendingItemLimit: null });
    expect((await batch.enqueue(queued('b', 2))).count).toBe(2);
    // One batch may hold up to 200 items whatever the settings say; the canvas batch keeps its 2–20.
    expect((await batch.enqueue(queued('c', 200))).count).toBe(200);
    await expect(batch.enqueue(queued('d', 201))).rejects.toMatchObject({ code: 'invalid_arguments' });
  });
});
