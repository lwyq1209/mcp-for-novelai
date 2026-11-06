import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
vi.mock('axios', () => ({ default: { get: () => { throw new Error('No network'); }, post: () => { throw new Error('No network'); } } }));
vi.mock('./ipc/store', () => ({ getToken: () => { throw new Error('No account'); }, getSettings: () => { throw new Error('No settings'); } }));
vi.mock('electron', () => ({ app: {}, dialog: {}, nativeImage: {} }));
import { createQueueRecipeService, recipeHash, QUEUE_RETENTION, type CanvasOrigin } from './queue-recipe-service';
import { createBatchService } from './batch-service';
import { QUEUE_TOMBSTONE_FILE } from './queue-tombstones';
import { waitUntil } from '../src/test-support/wait-until';

// Queue retention (2026-11): ended agent batches older than the retention period are cleaned with their receipts and
// the plain recipes only they used; a record per batch stays, so the old requestKey answers "accepted, ended, cleaned"
// and is never queued again (a "not found" could make an agent resend and pay twice). Real recipe store, real batch
// service and frozen storage in a temporary runtime; the generator is a double that counts what it was asked to send.
const DAY = QUEUE_RETENTION.dayMs;
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); await runCleanups(cleanups.splice(0).reverse()); });
const prep = (positivePrompt = 'teacup, table') => ({ mode: 't2i', authored: { params: { positivePrompt, negativePrompt: 'text', seed: 42, seedMode: 'fixed', width: 64, height: 64 } }, assets: [] });
const item = (value: any, seed?: number) => ({ recipeId: value.recipeId, recipeRevision: value.recipeRevision, inputHash: value.inputHash, ...(seed === undefined ? {} : { seed }) });
const origin = (capturedAt: number): CanvasOrigin => ({ workspaceId: 'novelai-window', revision: 3, draftId: null, patched: false, capturedAt: new Date(capturedAt).toISOString() });

async function runtime() { const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nai-queue-retention-'))); cleanups.push(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
type Host = Awaited<ReturnType<typeof host>>;
/** `outcome` decides each image: succeeded at once (default), unknown (the batch ends partial) or held (busy). */
async function host({ runtimeDir: given, days = 30 as number | null }: { runtimeDir?: string; days?: number | null } = {}) {
  const runtimeDir = given ?? await runtime();
  const state = { busy: false, clock: Date.now(), submitted: 0, days, outcome: 'succeeded' as 'succeeded' | 'unknown', removed: [] as string[] };
  const generation = {
    lookup: async () => null, read: async () => null, cancel: async () => null, subscribe: () => () => {},
    async submit(args: any) {
      state.submitted++;
      const now = new Date().toISOString(), ok = state.outcome === 'succeeded';
      return { jobId: randomUUID(), workspaceId: args.workspaceId, requestKey: args.requestKey, originWorkspaceId: args.workspaceId, submittedRevision: args.expectedRevision, mode: args.mode, status: ok ? 'succeeded' : 'unknown', actualSeed: args.snapshot.params.seed,
        providerOutcome: ok ? 'response_received' : 'unknown', results: ok ? [{ index: 0, id: `history-${state.submitted}`, width: 64, height: 64, model: 'm', actualSeed: args.snapshot.params.seed }] : [], error: ok ? null : { code: 'submission_unconfirmed', message: 'fixture' }, createdAt: now, updatedAt: now };
    },
  } as any;
  const batch = createBatchService({ generation, runtimeDir, isBusy: () => state.busy, wait: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.min(ms, 2))), onRemoved: ids => state.removed.push(...ids) });
  cleanups.push(() => batch.dispose()); await batch.ready;
  const logs: string[] = [];
  const service = createQueueRecipeService({ runtimeDir, batch, randomSeed: () => 97, recipeReclaim: { auto: false, log: () => {} }, retention: { auto: false, days: () => state.days, now: () => state.clock, log: message => logs.push(message) }, log: message => logs.push(message) });
  const store = path.join(runtimeDir, 'queue-recipes'), frozen = path.join(runtimeDir, 'frozen-queue');
  const recordFile = (recipe: any) => path.join(store, `${recipe.recipeId}.${recipe.recipeRevision}.json`);
  const exists = (file: string) => fs.lstat(file).then(() => true, () => false);
  const receiptFile = (key: string) => path.join(store, `request-${recipeHash(key)}.json`);
  const put = (positivePrompt?: string) => service.put_queue_recipe({ preparation: prep(positivePrompt) });
  const enqueue = (key: string, items: any[]) => service.enqueue_queue_recipes({ requestKey: key, items });
  const settled = (batchId: string, status = 'succeeded') => waitUntil(async () => expect((await service.read_queue({ batchId })).status).toBe(status), { interval: 5 });
  const finishedAt = async (batchId: string) => Date.parse((await service.read_queue({ batchId })).finishedAt);
  const tombstoneLines = async () => (await fs.readFile(path.join(runtimeDir, QUEUE_TOMBSTONE_FILE.directory, QUEUE_TOMBSTONE_FILE.name), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const frozenFiles = async (batchId: string) => (await fs.readdir(frozen)).filter(name => name.startsWith(batchId));
  return { service, batch, state, runtimeDir, store, frozen, logs, recordFile, exists, receiptFile, put, enqueue, settled, finishedAt, tombstoneLines, frozenFiles };
}
/** An ended batch of `count` images under `key`, of one fresh plain recipe (or the given one). */
async function endedBatch(h: Host, key: string, recipe?: any, count = 2) {
  const used = recipe ?? await h.put(`recipe of ${key}`);
  const accepted = await h.enqueue(key, Array.from({ length: count }, (_, index) => item(used, 10 + index)));
  await h.settled(accepted.batchId);
  return { recipe: used, batch: accepted, finishedAt: await h.finishedAt(accepted.batchId) };
}

describe('queue retention: cleaning ended agent batches', () => {
  it('cleans an ended batch past the period with its receipt and recipe; the old key answers accepted (cleaned), never not found, and is never sent again', async () => {
    const h = await host(), { recipe, batch, finishedAt } = await endedBatch(h, 'mcp-old');
    const usage = (await h.service.list_queue({})).storage;
    expect(h.state.submitted).toBe(2);
    h.state.clock = finishedAt + 30 * DAY + 1;
    const run = await h.service.runRetention();
    expect(run).toMatchObject({ skipped: null, days: 30, cleaned: 1, receipts: 1, recipes: 1, deferred: 0, kept: 0 });
    expect(run.frozenBytes).toBeGreaterThan(0); expect(run.recipeBytes).toBeGreaterThan(16 * 1024);
    // Every file is gone; one record per batch and recipe stays.
    expect(await h.exists(h.receiptFile('mcp-old'))).toBe(false); expect(await h.exists(h.recordFile(recipe))).toBe(false);
    expect(await h.frozenFiles(batch.batchId)).toEqual([]);
    expect(h.state.removed).toEqual([batch.batchId]);
    const lines = await h.tombstoneLines();
    expect(lines).toEqual([
      expect.objectContaining({ kind: 'batch', keyHash: recipeHash('mcp-old'), batchId: batch.batchId, mode: 't2i', status: 'succeeded', count: 2, counts: { succeeded: 2, failed: 0, unknown: 0, cancelled: 0, skipped: 0 }, requestHash: expect.stringMatching(/^[a-f0-9]{64}$/), recipePlanHash: batch.recipePlanHash }),
      expect.objectContaining({ kind: 'recipe', recipeId: recipe.recipeId, recipeRevision: 1 }),
    ]);
    expect(JSON.stringify(lines)).not.toContain('mcp-old');
    // The old key: accepted, ended, cleaned.
    const cleaned = { batchId: batch.batchId, requestKey: 'mcp-old', execution: 'queued', status: 'succeeded', cleaned: true, count: 2, recipePlanHash: batch.recipePlanHash, intervalSeconds: 0, itemCounts: { succeeded: 2, failed: 0, unknown: 0, cancelled: 0, skipped: 0 }, items: [] };
    expect(await h.service.lookup_queue_request({ requestKey: 'mcp-old' })).toEqual({ status: 'accepted', batch: expect.objectContaining(cleaned) });
    // The same plan again: the cleaned batch, nothing sent; another plan under the key: a conflict, nothing sent.
    await expect(h.enqueue('mcp-old', [item(recipe, 10), item(recipe, 11)])).resolves.toMatchObject(cleaned);
    await expect(h.enqueue('mcp-old', [item(recipe, 12)])).rejects.toMatchObject({ code: 'request_conflict' });
    expect(h.state.submitted).toBe(2); expect(await h.exists(h.receiptFile('mcp-old'))).toBe(false);
    // Read, pause and cancel answer its end; nothing can be resumed; its images are not served from the queue.
    for (const method of ['read_queue', 'pause_queue', 'cancel_queue'] as const) await expect(h.service[method]({ batchId: batch.batchId })).resolves.toMatchObject({ batchId: batch.batchId, status: 'succeeded', cleaned: true });
    await expect(h.service.resume_queue({ batchId: batch.batchId })).rejects.toMatchObject({ code: 'batch_not_paused' });
    await expect(h.service.get_queue_result({ batchId: batch.batchId, itemIndex: 0 })).rejects.toMatchObject({ code: 'result_unavailable', message: expect.stringContaining('queueBatchId') });
    // The queue no longer lists it, and its slot and bytes are back.
    const after = await h.service.list_queue({});
    expect(after.batches).toEqual([]);
    expect(after.storage.frozenQueue).toMatchObject({ batches: usage.frozenQueue!.batches - 1 }); expect(after.storage.frozenQueue!.bytes).toBeLessThan(usage.frozenQueue!.bytes);
    expect(after.storage.recipeStore).toMatchObject({ records: usage.recipeStore!.records - 2 });
    // The reclaimed recipe says so; a new request for it is refused before any receipt: the key stays unused, nothing is sent.
    await expect(h.service.read_queue_recipe({ recipeId: recipe.recipeId, recipeRevision: 1 })).rejects.toMatchObject({ code: 'recipe_not_found', message: expect.stringContaining('reclaimed under the queue retention rule') });
    await expect(h.enqueue('mcp-new', [item(recipe, 1)])).rejects.toMatchObject({ code: 'recipe_not_found', message: expect.stringContaining('same inputHash') });
    expect(await h.exists(h.receiptFile('mcp-new'))).toBe(false);
    expect(await h.service.lookup_queue_request({ requestKey: 'mcp-new' })).toEqual({ batch: null });
    expect(h.state.submitted).toBe(2);
    // Prepared again with the same fields: same inputHash, a new recipeId, and it queues normally.
    const again = await h.put('recipe of mcp-old');
    expect(again.inputHash).toBe(recipe.inputHash); expect(again.recipeId).not.toBe(recipe.recipeId);
    const status = h.service.retentionStatus();
    expect(status).toMatchObject({ days: 30, cleanedBatches: 1, running: false, lastRun: { cleaned: 1 } });
  });

  it.each([7, 30, 90])('time boundary at %i days: exactly that long ago is kept, one millisecond more is cleaned', async days => {
    const h = await host({ days }), { batch, finishedAt } = await endedBatch(h, `mcp-boundary-${days}`, undefined, 1);
    h.state.clock = finishedAt + days * DAY;
    expect(await h.service.runRetention()).toMatchObject({ cleaned: 0 });
    expect(await h.service.lookup_queue_request({ requestKey: `mcp-boundary-${days}` })).toMatchObject({ status: 'accepted', batch: { batchId: batch.batchId, status: 'succeeded' } });
    expect((await h.service.read_queue({ batchId: batch.batchId })).cleaned).toBeUndefined();
    h.state.clock += 1;
    expect(await h.service.runRetention()).toMatchObject({ cleaned: 1 });
    expect(await h.service.lookup_queue_request({ requestKey: `mcp-boundary-${days}` })).toMatchObject({ status: 'accepted', batch: { batchId: batch.batchId, cleaned: true } });
  });

  it('never cleans when the period is "never", however old', async () => {
    const h = await host({ days: null }), { batch, finishedAt } = await endedBatch(h, 'mcp-never', undefined, 1);
    h.state.clock = finishedAt + 3650 * DAY;
    expect(await h.service.runRetention()).toMatchObject({ skipped: 'never', cleaned: 0, days: null });
    expect((await h.service.list_queue({})).batches.map((value: any) => value.batchId)).toEqual([batch.batchId]);
    expect(await h.exists(h.receiptFile('mcp-never'))).toBe(true); expect(await h.tombstoneLines()).toEqual([]);
  });

  it('never cleans a queued, running or paused batch however old; a partial or cancelled one only past the period', async () => {
    const h = await host(), now = Date.now();
    const partial = await (async () => { h.state.outcome = 'unknown'; const recipe = await h.put('partial'); const accepted = await h.enqueue('mcp-partial', [item(recipe, 1), item(recipe, 2)]); await h.settled(accepted.batchId, 'partial'); h.state.outcome = 'succeeded'; return accepted; })();
    h.state.busy = true;
    // The partial batch paused nothing: the next one is queued as usual.
    const queued = await h.enqueue('mcp-queued', [item(await h.put('queued'), 1)]);
    expect(queued).toMatchObject({ status: 'queued', error: null });
    const cancelled = await h.enqueue('mcp-cancelled', [item(await h.put('cancelled'), 1)]); await h.service.cancel_queue({ batchId: cancelled.batchId }); await h.settled(cancelled.batchId, 'cancelled');
    const paused = await h.enqueue('mcp-paused', [item(await h.put('paused'), 1)]); await h.service.pause_queue({ batchId: paused.batchId });
    h.state.clock = now + 10 * DAY;
    expect(await h.service.runRetention(), 'partial and cancelled ended less than 30 days ago').toMatchObject({ cleaned: 0 });
    h.state.clock = now + 1000 * DAY;
    expect(await h.service.runRetention()).toMatchObject({ cleaned: 2 });
    expect((await h.service.list_queue({})).batches.map((value: any) => value.status).sort()).toEqual(['paused', 'queued']);
    expect(await h.service.lookup_queue_request({ requestKey: 'mcp-partial' })).toMatchObject({ batch: { batchId: partial.batchId, status: 'partial', cleaned: true, itemCounts: { unknown: 2, skipped: 0 }, error: null } });
    expect(await h.service.lookup_queue_request({ requestKey: 'mcp-cancelled' })).toMatchObject({ batch: { batchId: cancelled.batchId, status: 'cancelled', cleaned: true, itemCounts: { cancelled: 1 } } });
    for (const [key, batch] of [['mcp-paused', paused], ['mcp-queued', queued]] as const) expect((await h.service.lookup_queue_request({ requestKey: key })).batch).toMatchObject({ batchId: batch.batchId, status: key === 'mcp-paused' ? 'paused' : 'queued' });
    // Both images of the partial batch were sent once each; nothing of the others.
    expect(h.state.submitted).toBe(2);
  });

  it('never cleans a manual batch (the window\'s own, kept only while the app runs)', async () => {
    const h = await host(), manual = await h.batch.enqueueManual({ workspaceId: 'recipe-queue', expectedRevision: 0, requestKey: 'mcp-looks-like-agent', execution: 'queued', mode: 't2i', count: 1, intervalSeconds: 0, seeds: [1], snapshot: { params: { ...prep().authored.params, model: 'nai-diffusion-4-5-full' }, extras: { vibeImages: [], preciseReferences: [], charCaptions: [] } } });
    await waitUntil(() => expect(h.batch.read({ workspaceId: 'recipe-queue', batchId: manual.batchId }).status).toBe('succeeded'), { interval: 5 });
    h.state.clock = Date.now() + 1000 * DAY;
    expect(await h.service.runRetention()).toMatchObject({ cleaned: 0 });
    expect(h.batch.read({ workspaceId: 'recipe-queue', batchId: manual.batchId }).status).toBe('succeeded');
  });

  it('recipes (option B): another receipt of any status keeps what it names; a canvas capture and a never-enqueued recipe are kept', async () => {
    const h = await host(), now = Date.now();
    const shared = await h.put('shared'), only = await h.put('only old'), unused = await h.put('never enqueued'), rejectedToo = await h.put('also named by a rejected receipt');
    const canvas = await h.service.put_canvas_recipe({ preparation: prep('canvas capture'), canvasOrigin: origin(now), assetData: 'omit' });
    const old = await h.enqueue('mcp-old', [item(shared, 1), item(only, 2), item(canvas, 3), item(rejectedToo, 4)]); await h.settled(old.batchId);
    h.state.clock = (await h.finishedAt(old.batchId)) + 31 * DAY;
    // An unfinished batch's receipt names `shared`; a receipt rejected after it was written names `rejectedToo`.
    h.state.busy = true;
    await h.enqueue('mcp-unfinished', [item(shared, 5)]);
    vi.spyOn(h.batch, 'enqueue').mockRejectedValueOnce(Object.assign(new Error('full'), { code: 'queue_full' }));
    await expect(h.enqueue('mcp-rejected', [item(rejectedToo, 6)])).rejects.toMatchObject({ code: 'queue_full' });
    expect(await h.service.lookup_queue_request({ requestKey: 'mcp-rejected' })).toMatchObject({ status: 'rejected' });
    expect(await h.service.runRetention()).toMatchObject({ cleaned: 1, receipts: 1, recipes: 1 });
    expect(await h.exists(h.recordFile(only))).toBe(false);
    expect(await h.exists(h.recordFile(shared)), 'named by an unfinished batch').toBe(true);
    expect(await h.exists(h.recordFile(rejectedToo)), 'named by a rejected receipt').toBe(true);
    expect(await h.exists(h.recordFile(canvas)), 'canvas captures keep their own rule').toBe(true);
    expect(await h.exists(h.recordFile(unused)), 'never enqueued').toBe(true);
    expect((await h.tombstoneLines()).filter(line => line.kind === 'recipe').map(line => line.recipeId)).toEqual([only.recipeId]);
    // The kept recipes still read; the reclaimed one says why it is gone.
    await expect(h.service.read_queue_recipe({ recipeId: shared.recipeId, recipeRevision: 1, assetData: 'omit' })).resolves.toMatchObject({ recipeId: shared.recipeId });
    await expect(h.service.read_queue_recipe({ recipeId: only.recipeId, recipeRevision: 1 })).rejects.toMatchObject({ code: 'recipe_not_found', message: expect.stringContaining('reclaimed') });
  });

  it('a frozen queue that stopped is left as it is: nothing is recorded or removed', async () => {
    const h = await host(), { batch, finishedAt } = await endedBatch(h, 'mcp-stopped');
    // An entry the app does not use stops the frozen queue at its next write.
    await fs.writeFile(path.join(h.frozen, 'stray.txt'), 'x');
    h.state.busy = true; await h.enqueue('mcp-trigger', [item(await h.put('trigger'), 1)]).catch(() => undefined);
    await expect(h.enqueue('mcp-trigger-2', [item(await h.put('trigger 2'), 1)])).rejects.toMatchObject({ code: 'queue_storage_error' });
    h.state.clock = finishedAt + 31 * DAY;
    expect(await h.service.runRetention()).toMatchObject({ skipped: 'frozen_queue_unreadable', cleaned: 0, receipts: 0, recipes: 0 });
    expect(await h.tombstoneLines()).toEqual([]); expect(await h.exists(h.receiptFile('mcp-stopped'))).toBe(true);
    expect(await h.frozenFiles(batch.batchId)).not.toEqual([]);
  });

  it('a receipt that cannot be read keeps its batch (and every recipe this round); the others are cleaned', async () => {
    const h = await host(), a = await endedBatch(h, 'mcp-a'), b = await endedBatch(h, 'mcp-b');
    const text = await fs.readFile(h.receiptFile('mcp-b'), 'utf8'); await fs.writeFile(h.receiptFile('mcp-b'), text.replace('"accepted"', '"acceptex"'));
    h.state.clock = Math.max(a.finishedAt, b.finishedAt) + 31 * DAY;
    expect(await h.service.runRetention()).toMatchObject({ cleaned: 1, receipts: 1, recipes: 0, kept: 1 });
    expect(h.logs.some(line => line.includes(b.batch.batchId) && line.includes('cannot be read'))).toBe(true);
    expect(await h.exists(h.recordFile(a.recipe)), 'an unreadable receipt might name it').toBe(true);
    expect(h.batch.list({ workspaceId: 'recipe-queue' }).batches.map(value => value.batchId)).toEqual([b.batch.batchId]);
  });
});

describe('queue retention: interruptions, restarts and concurrent calls', () => {
  /** A new process on the same data: new batch service and recipe service. */
  async function restart(h: Host) { await h.batch.dispose(); return host({ runtimeDir: h.runtimeDir, days: h.state.days }); }
  const failUnlinks = (match: (file: string) => boolean, after = 0) => {
    const original = fs.unlink.bind(fs); let seen = 0;
    return vi.spyOn(fs, 'unlink').mockImplementation(async (...args: any[]) => { if (match(String(args[0])) && ++seen > after) throw Object.assign(new Error('process killed'), { code: 'EIO' }); return (original as any)(...args); });
  };

  it('stopped after its records (before any file was removed): the receipt still answers; the next round finishes the cleaning', async () => {
    const h = await host(), { recipe, batch, finishedAt } = await endedBatch(h, 'mcp-interrupted');
    h.state.clock = finishedAt + 31 * DAY;
    failUnlinks(file => file.endsWith(`${recipe.recipeId}.1.json`));
    await expect(h.service.runRetention()).rejects.toMatchObject({ code: 'EIO' });
    vi.restoreAllMocks();
    expect((await h.tombstoneLines()).map(line => line.kind)).toEqual(['batch', 'recipe']);
    expect(await h.exists(h.receiptFile('mcp-interrupted'))).toBe(true);
    expect(await h.service.lookup_queue_request({ requestKey: 'mcp-interrupted' })).toMatchObject({ status: 'accepted', batch: { batchId: batch.batchId, status: 'succeeded' } });
    await expect(h.enqueue('mcp-interrupted', [item(recipe, 10), item(recipe, 11)])).resolves.toMatchObject({ batchId: batch.batchId });
    const next = await restart(h); next.state.clock = h.state.clock;
    expect(await next.service.runRetention()).toMatchObject({ cleaned: 1, receipts: 1, recipes: 1 });
    expect((await next.tombstoneLines()).map(line => line.kind), 'the records are not written twice').toEqual(['batch', 'recipe']);
    expect(await next.service.lookup_queue_request({ requestKey: 'mcp-interrupted' })).toMatchObject({ batch: { batchId: batch.batchId, cleaned: true } });
    expect(next.state.submitted + h.state.submitted).toBe(2);
  });

  it('killed inside the frozen purge (receipt already gone): the restart rolls the purge forward; the key answers cleaned throughout', async () => {
    const h = await host(), { recipe, batch, finishedAt } = await endedBatch(h, 'mcp-killed');
    h.state.clock = finishedAt + 31 * DAY;
    failUnlinks(file => file.includes(`${path.sep}frozen-queue${path.sep}`) && file.includes(batch.batchId), 1);
    await expect(h.service.runRetention()).rejects.toMatchObject({ code: 'queue_storage_error' });
    vi.restoreAllMocks();
    expect(await h.exists(h.receiptFile('mcp-killed'))).toBe(false);
    // Still in this process: the key answers from its record; the batch is gone from the queue view.
    expect(await h.service.lookup_queue_request({ requestKey: 'mcp-killed' })).toMatchObject({ status: 'accepted', batch: { batchId: batch.batchId, cleaned: true } });
    await expect(h.enqueue('mcp-killed', [item(recipe, 10), item(recipe, 11)])).resolves.toMatchObject({ batchId: batch.batchId, cleaned: true });
    const next = await restart(h);
    expect(await next.frozenFiles(batch.batchId)).toEqual([]);
    expect((await fs.readdir(next.frozen)).filter(name => name.startsWith('.txn-'))).toEqual([]);
    expect((await next.service.list_queue({})).batches).toEqual([]);
    expect(await next.service.lookup_queue_request({ requestKey: 'mcp-killed' })).toMatchObject({ status: 'accepted', batch: { batchId: batch.batchId, cleaned: true } });
    await expect(next.enqueue('mcp-killed', [item(recipe, 10), item(recipe, 11)])).resolves.toMatchObject({ batchId: batch.batchId, cleaned: true });
    expect(next.state.submitted + h.state.submitted).toBe(2);
  });

  it('a run that stopped is retried within minutes, not only the next day, and completes the cleaning by itself', async () => {
    const h = await host(), { recipe, batch, finishedAt } = await endedBatch(h, 'mcp-retry'), clock = finishedAt + 31 * DAY;
    failUnlinks(file => file.endsWith(`${recipe.recipeId}.1.json`));
    const runs: any[] = [];
    const auto = createQueueRecipeService({ runtimeDir: h.runtimeDir, batch: h.batch, recipeReclaim: { auto: false, log: () => {} }, log: () => {},
      retention: { auto: true, startDelayMs: 0, retryMs: 20, intervalMs: 60 * 60 * 1000, days: () => 30, now: () => clock, log: () => {}, onRun: run => runs.push(run) } });
    cleanups.push(async () => auto.stopRetention());
    await waitUntil(() => expect(runs.length).toBeGreaterThanOrEqual(1), { interval: 5 });
    expect(await h.exists(h.receiptFile('mcp-retry')), 'the first run stopped before the receipt').toBe(true);
    vi.restoreAllMocks();
    await waitUntil(async () => expect(await auto.lookup_queue_request({ requestKey: 'mcp-retry' })).toMatchObject({ status: 'accepted', batch: { batchId: batch.batchId, cleaned: true } }), { interval: 5 });
    await waitUntil(async () => expect(await h.frozenFiles(batch.batchId)).toEqual([]), { interval: 5 });
    auto.stopRetention(); await waitUntil(() => expect(auto.retentionStatus().running).toBe(false), { interval: 5 });
    expect(runs.filter(run => run.cleaned === 1), JSON.stringify(runs.map(run => ({ cleaned: run.cleaned, rounds: run.rounds, skipped: run.skipped })))).toHaveLength(1);
  });

  it('a retention run and same-key enqueues and lookups at the same time: every answer is the batch or its record, nothing is sent again', async () => {
    const h = await host(), runs = await Promise.all(Array.from({ length: 6 }, (_, index) => endedBatch(h, `mcp-race-${index}`, undefined, 1)));
    h.state.clock = Math.max(...runs.map(run => run.finishedAt)) + 31 * DAY;
    // Slow every removal down so the calls below land while the run is in progress.
    const original = fs.unlink.bind(fs);
    vi.spyOn(fs, 'unlink').mockImplementation(async (...args: any[]) => { await new Promise(resolve => setTimeout(resolve, 3)); return (original as any)(...args); });
    const cleaning = h.service.runRetention(), answers: any[] = [], pending: Array<Promise<any>> = [];
    let done = false, during = 0; void cleaning.finally(() => { done = true; });
    while (!done) {
      for (const index of runs.keys()) { answers.push(await h.service.lookup_queue_request({ requestKey: `mcp-race-${index}` })); if (!done) during++; }
      // Same-key enqueues wait for the round in progress (they share its sequence) and are answered right after it.
      pending.push(...runs.map((run, index) => h.enqueue(`mcp-race-${index}`, [item(run.recipe, 10)]).catch(error => ({ error: error.code }))));
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    expect(await cleaning).toMatchObject({ cleaned: 6 });
    for (const [index, run] of runs.entries()) {
      answers.push(await h.service.lookup_queue_request({ requestKey: `mcp-race-${index}` }));
      answers.push(await h.enqueue(`mcp-race-${index}`, [item(run.recipe, 10)]));
    }
    answers.push(...await Promise.all(pending));
    expect(during, 'lookups landed while the run was in progress').toBeGreaterThan(6);
    const batchIds = new Set(runs.map(run => run.batch.batchId));
    for (const answer of answers) {
      expect(typeof answer.error, JSON.stringify(answer)).not.toBe('string');
      const value = answer.batch ?? answer;
      expect(batchIds.has(value.batchId), JSON.stringify(answer)).toBe(true);
    }
    expect(answers.some(answer => (answer.batch ?? answer).cleaned === true)).toBe(true);
    expect(h.state.submitted).toBe(6);
  });

  it('records survive a restart and are re-read when another process appended them', async () => {
    const h = await host(), other = createQueueRecipeService({ runtimeDir: h.runtimeDir, batch: h.batch, recipeReclaim: { auto: false, log: () => {} } });
    expect(await other.lookup_queue_request({ requestKey: 'mcp-unseen' })).toEqual({ batch: null });
    const { batch, finishedAt } = await endedBatch(h, 'mcp-shared');
    h.state.clock = finishedAt + 31 * DAY;
    await h.service.runRetention();
    // `other` had read the (then missing) records before; it reads what was appended since.
    expect(await other.lookup_queue_request({ requestKey: 'mcp-shared' })).toMatchObject({ batch: { batchId: batch.batchId, cleaned: true } });
    const next = await restart(h);
    expect(await next.service.read_queue({ batchId: batch.batchId })).toMatchObject({ batchId: batch.batchId, cleaned: true, status: 'succeeded' });
  });

  it('damaged records (review rework P1): every answer that depends on them is refused, never "not found", nothing is sent; a key with a receipt still answers', async () => {
    const damages: Array<[string, (h: Host, file: string) => Promise<void>]> = [
      ['a line removed', async (_h, file) => { const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean); lines.splice(0, 1); await fs.writeFile(file, `${lines.join('\n')}\n`); }],
      ['the file deleted', async (_h, file) => { await fs.rm(file); }],
      ['cut at a line boundary', async (_h, file) => { const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean); await fs.writeFile(file, `${lines.slice(0, -1).join('\n')}\n`); }],
      ['cut inside a line', async (_h, file) => { const bytes = await fs.readFile(file); await fs.writeFile(file, bytes.subarray(0, bytes.length - 30)); }],
      ['an anchor deleted', async h => { await fs.rm(path.join(h.runtimeDir, 'queue-cleaned-anchor', QUEUE_TOMBSTONE_FILE.secondAnchor)); }],
      ['an anchor changed', async h => { const anchor = path.join(h.runtimeDir, QUEUE_TOMBSTONE_FILE.directory, QUEUE_TOMBSTONE_FILE.anchor); await fs.writeFile(anchor, (await fs.readFile(anchor, 'utf8')).replace(/"count":\d+/, '"count":1')); }],
    ];
    for (const [name, damage] of damages) {
      const h = await host(), one = await endedBatch(h, 'mcp-one'), two = await endedBatch(h, 'mcp-two');
      h.state.clock = Math.max(one.finishedAt, two.finishedAt) + 31 * DAY; await h.service.runRetention();
      h.state.busy = true; const live = await h.enqueue('mcp-live', [item(await h.put('live'), 1)]);
      const file = path.join(h.runtimeDir, QUEUE_TOMBSTONE_FILE.directory, QUEUE_TOMBSTONE_FILE.name);
      await damage(h, file);
      const damaged = await host({ runtimeDir: h.runtimeDir }), recipe = await damaged.put('after damage');
      for (const key of ['mcp-one', 'mcp-two', 'mcp-brand-new']) await expect(damaged.service.lookup_queue_request({ requestKey: key }), `${name}: ${key}`).rejects.toMatchObject({ code: 'queue_storage_failed', details: { reason: 'cleaned_records_unreadable' } });
      await expect(damaged.enqueue('mcp-brand-new', [item(recipe, 1)]), name).rejects.toMatchObject({ code: 'queue_storage_failed' });
      await expect(damaged.enqueue('mcp-one', [item(one.recipe, 10), item(one.recipe, 11)]), name).rejects.toMatchObject({ code: 'queue_storage_failed' });
      await expect(damaged.service.read_queue({ batchId: one.batch.batchId }), name).rejects.toMatchObject({ code: 'queue_storage_failed' });
      expect(await damaged.exists(damaged.receiptFile('mcp-brand-new')), name).toBe(false);
      expect(await damaged.service.lookup_queue_request({ requestKey: 'mcp-live' }), name).toMatchObject({ status: 'accepted', batch: { batchId: live.batchId } });
      expect(await damaged.service.runRetention(), name).toMatchObject({ skipped: 'cleaned_records_unreadable' });
      expect(damaged.service.retentionStatus().records, name).toMatchObject({ state: 'broken' });
      expect(damaged.state.submitted + h.state.submitted, name).toBe(4);
      await damaged.batch.dispose(); await h.batch.dispose();
    }
  });

  it('a knowing repair keeps what is readable and recovers from the library every lost key that made images; only the others stay lost', async () => {
    const h = await host(), a = await endedBatch(h, 'mcp-a'), b = await endedBatch(h, 'mcp-b'), c = await endedBatch(h, 'mcp-c');
    h.state.clock = Math.max(a.finishedAt, b.finishedAt, c.finishedAt) + 31 * DAY; await h.service.runRetention();
    const file = path.join(h.runtimeDir, QUEUE_TOMBSTONE_FILE.directory, QUEUE_TOMBSTONE_FILE.name);
    // The records of a and b lost (their lines removed); the library knows b made images (history queueOrigin).
    const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).filter(line => ![a.batch.batchId, b.batch.batchId].includes(JSON.parse(line).batchId));
    await fs.writeFile(file, `${lines.join('\n')}\n`);
    await h.batch.dispose();
    const origins = [{ requestKey: 'mcp-b', batchId: b.batch.batchId, images: 2 }, { requestKey: 'mcp-c', batchId: c.batch.batchId, images: 2 }, { requestKey: 'mcp-live-still', batchId: randomUUID(), images: 1 }];
    const runtimeDir = h.runtimeDir, restarted = await host({ runtimeDir });
    const service = createQueueRecipeService({ runtimeDir, batch: restarted.batch, recipeReclaim: { auto: false, log: () => {} }, log: () => {}, libraryQueueOrigins: () => origins });
    await fs.writeFile(restarted.receiptFile('mcp-live-still'), 'x'); // a key that still has a receipt is never recovered
    const plan = await service.repairPlan();
    // unrecoverable: at most every lost line (review rework 2: a true upper bound).
    expect(plan).toMatchObject({ needed: true, health: { state: 'broken', problem: 'chain_broken' }, lost: 2, recoverable: 1, unrecoverable: 2 });
    expect(await service.repairCleanedRecords({ lost: 2, recoverable: 0 })).toMatchObject({ repaired: false, reason: 'plan_changed' });
    await fs.rm(restarted.receiptFile('mcp-live-still'));
    const changed = await service.repairPlan();
    expect(await service.repairCleanedRecords({ lost: changed.lost, recoverable: changed.recoverable })).toMatchObject({ repaired: true, recovered: 2 });
    expect(service.retentionStatus().records).toMatchObject({ state: 'ok' });
    expect(await service.lookup_queue_request({ requestKey: 'mcp-b' })).toMatchObject({ status: 'accepted', batch: { batchId: b.batch.batchId, cleaned: true, recovered: true, status: 'unknown', savedImages: 2 } });
    await expect(service.enqueue_queue_recipes({ requestKey: 'mcp-b', items: [item(b.recipe, 77)] })).resolves.toMatchObject({ cleaned: true, recovered: true });
    expect(await service.lookup_queue_request({ requestKey: 'mcp-c' })).toMatchObject({ batch: { batchId: c.batch.batchId, cleaned: true, status: 'succeeded' } });
    // The key whose batch made no image stays lost: a repair cannot know it.
    expect(await service.lookup_queue_request({ requestKey: 'mcp-a' })).toEqual({ batch: null });
    expect(restarted.state.submitted + h.state.submitted).toBe(6);
    expect((await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line).kind)).toEqual(['batch', 'recipe', 'recipe', 'recipe', 'recovered', 'recovered', 'repair']);
  });
});

describe('recovery from the library (review rework 2): records rolled back or removed outside the app', () => {
  const recordFiles = (runtimeDir: string) => ({ dir: path.join(runtimeDir, QUEUE_TOMBSTONE_FILE.directory), anchorDir: path.join(runtimeDir, 'queue-cleaned-anchor') });
  const copyRecords = async (runtimeDir: string, to: string) => { const { dir, anchorDir } = recordFiles(runtimeDir); await fs.cp(dir, path.join(to, 'a'), { recursive: true }); await fs.cp(anchorDir, path.join(to, 'b'), { recursive: true }); };
  const putRecords = async (runtimeDir: string, from: string) => { const { dir, anchorDir } = recordFiles(runtimeDir); await fs.rm(dir, { recursive: true, force: true }); await fs.rm(anchorDir, { recursive: true, force: true }); await fs.cp(path.join(from, 'a'), dir, { recursive: true }); await fs.cp(path.join(from, 'b'), anchorDir, { recursive: true }); };
  /** Batches a, b (2 images each) and z (no image: partial) cleaned first; n (2 images) cleaned later. */
  async function cleanedHistory() {
    const h = await host(), a = await endedBatch(h, 'mcp-a'), b = await endedBatch(h, 'mcp-b');
    h.state.outcome = 'unknown'; const zRecipe = await h.put('recipe of z'); const z = await h.enqueue('mcp-z', [item(zRecipe, 5)]); await h.settled(z.batchId, 'partial'); h.state.outcome = 'succeeded';
    // The first cleaning (a, b, z); the records as they were then are kept (T0).
    h.state.clock = Math.max(a.finishedAt, b.finishedAt, await h.finishedAt(z.batchId)) + 31 * DAY;
    await h.service.runRetention();
    const t0 = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-records-t0-')); cleanups.push(() => fs.rm(t0, { recursive: true, force: true }));
    await copyRecords(h.runtimeDir, t0);
    // n afterwards (it runs at once: z paused nothing), cleaned by a second cleaning.
    const nRecipe = await h.put('recipe of n'), nAccepted = await h.enqueue('mcp-n', [item(nRecipe, 10), item(nRecipe, 11)]);
    await h.settled(nAccepted.batchId);
    const n = { recipe: nRecipe, batch: nAccepted, finishedAt: await h.finishedAt(nAccepted.batchId) };
    h.state.clock = n.finishedAt + 31 * DAY; await h.service.runRetention();
    expect((await h.tombstoneLines()).filter(line => line.kind === 'batch').map(line => line.batchId).sort()).toEqual([a.batch.batchId, b.batch.batchId, z.batchId, n.batch.batchId].sort());
    await h.batch.dispose();
    // What the library knows: the images of a, b and n (z made none).
    const origins = [{ requestKey: 'mcp-a', batchId: a.batch.batchId, images: 2 }, { requestKey: 'mcp-b', batchId: b.batch.batchId, images: 2 }, { requestKey: 'mcp-n', batchId: n.batch.batchId, images: 2 },
      { requestKey: 'window-manual-1', batchId: randomUUID(), images: 1 }];
    return { h, a, b, z, n, t0, origins, submitted: h.state.submitted };
  }
  const restart = async (runtimeDir: string, origins: any[]) => {
    const again = await host({ runtimeDir }), logs: string[] = [];
    const service = createQueueRecipeService({ runtimeDir, batch: again.batch, recipeReclaim: { auto: false, log: () => {} }, log: message => logs.push(message), libraryQueueOrigins: () => origins });
    return { ...again, service, logs };
  };

  it('all three files rolled back to an older consistent copy (C4): the key cleaned since answers accepted (recovered at start), never not_found, and is never sent', async () => {
    const { h, n, t0, origins, submitted } = await cleanedHistory();
    await putRecords(h.runtimeDir, t0);
    const r = await restart(h.runtimeDir, origins);
    // Asked at once, before the start check could have finished on its own: it waits for it.
    const lookup = r.service.lookup_queue_request({ requestKey: 'mcp-n' });
    expect(await lookup).toMatchObject({ status: 'accepted', batch: { batchId: n.batch.batchId, cleaned: true, recovered: true, savedImages: 2 } });
    await expect(r.service.enqueue_queue_recipes({ requestKey: 'mcp-n', items: [item(n.recipe, 10), item(n.recipe, 11)] })).resolves.toMatchObject({ cleaned: true, recovered: true });
    expect(r.state.submitted + submitted).toBe(submitted + 0);
    expect(r.service.retentionStatus()).toMatchObject({ records: { state: 'ok' }, recoveredFromLibrary: 1 });
    expect(r.logs.some(line => /1 cleaned record\(s\) recovered from the library \(start\)/.test(line))).toBe(true);
    // The window's own batch key (no "mcp-" prefix) is never recorded.
    expect(r.service.retentionStatus().recoveredFromLibrary).toBe(1);
  });

  it('both record folders removed (C5): every key whose batch made images answers accepted; a batch that made no image is the remaining risk (not_found)', async () => {
    const { h, a, b, n, origins, submitted } = await cleanedHistory();
    const { dir, anchorDir } = recordFiles(h.runtimeDir);
    await fs.rm(dir, { recursive: true }); await fs.rm(anchorDir, { recursive: true });
    const r = await restart(h.runtimeDir, origins);
    for (const [key, value] of [['mcp-a', a], ['mcp-b', b], ['mcp-n', n]] as const) {
      expect(await r.service.lookup_queue_request({ requestKey: key })).toMatchObject({ status: 'accepted', batch: { batchId: value.batch.batchId, cleaned: true, recovered: true } });
      await expect(r.service.enqueue_queue_recipes({ requestKey: key, items: [item(value.recipe, 99)] })).resolves.toMatchObject({ cleaned: true, recovered: true });
    }
    expect(await r.service.lookup_queue_request({ requestKey: 'mcp-z' })).toEqual({ batch: null });
    expect(r.state.submitted).toBe(0); expect(h.state.submitted).toBe(submitted);
    expect(r.service.retentionStatus()).toMatchObject({ records: { state: 'ok', readable: 3 }, recoveredFromLibrary: 3 });
  });

  it('after a library restore and before every cleaning, keys the library newly names are recorded; a key with a receipt, record or batch never is', async () => {
    const h = await host(), live = await endedBatch(h, 'mcp-live'), origins: any[] = [], logs: string[] = [];
    const service = createQueueRecipeService({ runtimeDir: h.runtimeDir, batch: h.batch, recipeReclaim: { auto: false, log: () => {} }, retention: { auto: false, days: () => 30, now: () => h.state.clock, log: () => {} }, log: message => logs.push(message), libraryQueueOrigins: () => origins });
    expect(await service.lookup_queue_request({ requestKey: 'mcp-nothing' })).toEqual({ batch: null }); // the start check is done
    // Images restored from a backup of another data root: their key has nothing here.
    const other = randomUUID();
    origins.push({ requestKey: 'mcp-other-root', batchId: other, images: 1 }, { requestKey: 'mcp-live', batchId: live.batch.batchId, images: 2 });
    expect(await service.libraryRestored(), logs.join('\n')).toBe(1);
    expect(await service.lookup_queue_request({ requestKey: 'mcp-other-root' })).toMatchObject({ status: 'accepted', batch: { batchId: other, recovered: true } });
    expect(await service.lookup_queue_request({ requestKey: 'mcp-live' })).toMatchObject({ batch: { batchId: live.batch.batchId, status: 'succeeded' } });
    expect((await service.lookup_queue_request({ requestKey: 'mcp-live' })).batch.cleaned).toBeUndefined();
    // One more, found before the next cleaning runs (nothing due).
    const third = randomUUID(); origins.push({ requestKey: 'mcp-third', batchId: third, images: 3 });
    const run = await service.runRetention();
    expect(run.cleaned).toBe(0);
    expect(await service.lookup_queue_request({ requestKey: 'mcp-third' })).toMatchObject({ batch: { batchId: third, recovered: true, savedImages: 3 } });
    expect(await service.libraryRestored()).toBe(0);
    expect((await h.tombstoneLines()).map(line => line.kind)).toEqual(['recovered', 'recovered']);
    expect(h.state.submitted).toBe(2);
  });
});

