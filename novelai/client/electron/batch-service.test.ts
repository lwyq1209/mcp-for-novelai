import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('axios', () => ({ default: { get: () => { throw new Error('No network'); }, post: () => { throw new Error('No generation'); } } }));
vi.mock('./ipc/store', () => ({ getToken: () => { throw new Error('No account'); }, getSettings: () => { throw new Error('No settings'); } }));
vi.mock('electron', () => ({ app: {}, dialog: {}, nativeImage: {} }));
import { DEFAULT_PARAMS } from '../src/types';
import { createBatchService, BatchError, queuedExtraNoiseSeed, scenePlanHash, type BatchDependencies } from './batch-service';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBatchStorage, BatchInputError } from './batch-storage';
import { createGenerationService } from './generation-service';
import { createQueueRecipeService } from './queue-recipe-service';
import type { BatchChildJob, BatchChildRequest, BatchGenerationPort, BatchJob } from '../src/workspace/batch-types';
import type { GenerationSnapshot } from '../src/workspace/generation-types';
import { waitUntil } from '../src/test-support/wait-until';
import { runCleanups } from '../src/test-support/temp-dirs';

const cleanups: Array<() => void | Promise<void>> = [];
// Last registered, first run (a service is disposed before its runtime folder goes); every cleanup runs even when one throws.
afterEach(async () => { vi.restoreAllMocks(); await runCleanups(cleanups.splice(0).reverse()); });
const snapshot = (): GenerationSnapshot => ({ params: { ...DEFAULT_PARAMS, positivePrompt: 'a blue teacup on a wooden table', seed: 42, seedMode: 'fixed' }, extras: { vibeImages: [], preciseReferences: [], charCaptions: [] }, batchCount: 19 });
const request = (extra: Record<string, unknown> = {}) => ({ workspaceId: 'origin', expectedRevision: 7, requestKey: 'teacup-study', mode: 't2i', count: 3, intervalSeconds: 0, seedMode: 'increment', snapshot: snapshot(), ...extra });
const sceneRequest = (extra: Record<string, unknown> = {}) => {
  const snapshots = ['red cup on a table', 'blue cup beside a plant'].map((positivePrompt, index) => ({ ...snapshot(), params: { ...snapshot().params, positivePrompt, seed: 50 + index * 10, seedMode: 'fixed' as const, steps: 20 + index }, extras: { ...snapshot().extras, charCaptions: index ? [{ prompt: 'adult gardener', negativePrompt: '', useCoords: true, x: .2, y: .7 }] : [] } }));
  return request({ count: 2, seedMode: 'fixed', snapshot: undefined, snapshots, scenes: snapshots.map((value, index) => ({ sceneId: `scene-${index + 1}`, patch: { params: value.params, charCaptions: value.extras.charCaptions } })), ...extra });
};
function setup(extra: Partial<BatchDependencies> = {}) {
  const jobs = new Map<string, BatchChildJob>();
  const accepted: Array<{ request: BatchChildRequest; snapshot: GenerationSnapshot }> = [];
  const subscribers = new Set<(job: BatchChildJob) => void>();
  let revision = 7;
  const generation: BatchGenerationPort = {
    lookup: vi.fn((args) => structuredClone([...jobs.values()].find((job) => job.originWorkspaceId === args.workspaceId && job.requestKey === args.requestKey) ?? null)),
    submit: vi.fn((args) => {
      if ([...jobs.values()].some((job) => ['preparing', 'running', 'cancelling'].includes(job.status))) throw new BatchError('workspace_busy', 'already executing');
      const { snapshot: input, ...childRequest } = args;
      accepted.push({ request: structuredClone(childRequest), snapshot: structuredClone(input) });
      const now = new Date().toISOString();
      const job: BatchChildJob = { ...childRequest, jobId: `child-${accepted.length}`, originWorkspaceId: args.workspaceId, submittedRevision: args.expectedRevision,
        status: 'running', createdAt: now, updatedAt: now, startedAt: now, finishedAt: null, model: input.params.model,
        actualSeed: input.params.seed, providerRequestId: null, inputSummary: { sampleCount: 1, width: input.params.width, height: input.params.height, steps: input.params.steps, sampler: input.params.sampler, cfgScale: input.params.cfgScale, characterCount: 0 },
        quote: { source: 'fixture', amount: null }, error: null, results: [], cancelRequested: false, providerOutcome: 'unknown' };
      jobs.set(job.jobId, job); subscribers.forEach((listener) => listener(structuredClone(job))); return structuredClone(job);
    }),
    read: vi.fn(({ jobId }) => structuredClone(jobs.get(jobId)!)),
    cancel: vi.fn(({ jobId }) => { const job = jobs.get(jobId)!; job.status = 'cancelling'; job.cancelRequested = true; return structuredClone(job); }),
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
  };
  const service = createBatchService({ generation, wait: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2))), ...extra });
  cleanups.push(service.dispose);
  const read = (batch: Pick<BatchJob, 'batchId'>) => service.read({ workspaceId: 'viewer', batchId: batch.batchId });
  const args = (batch: Pick<BatchJob, 'batchId'>) => ({ workspaceId: 'viewer', batchId: batch.batchId });
  const settle = (index: number, status: BatchChildJob['status'] = 'succeeded') => {
    const job = jobs.get(`child-${index + 1}`)!;
    job.status = status; job.finishedAt = new Date().toISOString(); job.updatedAt = job.finishedAt;
    job.providerOutcome = ['succeeded', 'failed'].includes(status) ? 'response_received' : 'unknown';
    job.results = status === 'succeeded' ? [{ index: 0, id: `result-${index + 1}`, width: 832, height: 1216, model: job.model, actualSeed: job.actualSeed! }] : [];
    job.error = status === 'succeeded' ? null : { code: status, message: 'fixture terminal outcome' };
    subscribers.forEach((listener) => listener(structuredClone(job)));
  };
  return { service, generation, accepted, jobs, read, args, settle, emitJob: (job: BatchChildJob) => subscribers.forEach(listener => listener(structuredClone(job))), setRevision: (value: number) => { revision = value; } };
}
const expectCount = async (h: ReturnType<typeof setup>, count: number) => waitUntil(() => expect(h.accepted).toHaveLength(count));
/** Polling a state file on disk: every 25 ms, not every 2. On Windows a reader holding the file keeps the service from
 * replacing it (MoveFileEx); a reader polling every 2 ms had it open so much that a replacement stayed refused for
 * over 4 s of retries on the CI runner, and the queue then stopped on the failed state write. */
const DISK_POLL = { interval: 25 };
const expectStatus = async (h: ReturnType<typeof setup>, batch: BatchJob, status: BatchJob['status']) => waitUntil(() => expect(h.read(batch).status).toBe(status));
const queued = (extra: Record<string, unknown> = {}) => request({ execution: 'queued', count: 1, ...extra });
async function queueSetup(extra: Partial<BatchDependencies> = {}) {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-frozen-queue-'));
  // Registered before the service (whose dispose setup registers), so it is removed after it, also when it never gets ready.
  cleanups.push(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const h = setup({ runtimeDir, ...extra }); await h.service.ready;
  return { ...h, runtimeDir };
}

describe('durable frozen recipe FIFO', () => {
  it('accepts later independent batches during execution and drains all recipes without a workspace checkpoint', async () => {
    const h = await queueSetup();
    const firstInput: Record<string, unknown> = queued({ count: 2, snapshots: [snapshot(), { ...snapshot(), params: { ...snapshot().params, positivePrompt: 'a green plant' } }], snapshot: undefined, seeds: [31, 32], seedMode: undefined });
    delete firstInput.seedMode;
    const a = await h.service.enqueue(firstInput); await expectCount(h, 1);
    h.setRevision(900);
    const b = await h.service.enqueue(queued({ requestKey: 'later-recipe', mode: 'i2i', snapshot: { ...snapshot(), sourceImage: { mimeType: 'image/png', data: 'fixture-source' }, i2i: { strength: .5, noise: 0, extraNoiseSeed: 5 } } }));
    expect(b.status).toBe('queued'); expect(h.accepted).toHaveLength(1);
    h.settle(0); await expectCount(h, 2); h.settle(1); await expectCount(h, 3); h.settle(2);
    await expectStatus(h, a, 'succeeded'); await expectStatus(h, b, 'succeeded');
    expect(h.accepted.map(item => item.snapshot.params.positivePrompt)).toEqual(['a blue teacup on a wooden table', 'a green plant', 'a blue teacup on a wooden table']);
    expect(h.accepted.map(item => item.snapshot.params.seed)).toEqual([31, 32, 42]);
    expect(h.accepted.every(item => item.snapshot.batchCount === 1)).toBe(true);
    expect(h.accepted.map(item => item.request.mode)).toEqual(['t2i', 't2i', 'i2i']);
    expect(h.accepted.every(item => item.request.expectedRevision === 7)).toBe(true);
  });

  it('names the durable batch item on every queued child (issue #1)', async () => {
    const h = await queueSetup();
    const a = await h.service.enqueue(queued({ count: 2, requestKey: 'mcp-queued-key' }));
    await expectCount(h, 1); h.settle(0); await expectCount(h, 2); h.settle(1); await expectStatus(h, a, 'succeeded');
    expect(vi.mocked(h.generation.submit).mock.calls.map(([args]) => (args as any).queue)).toEqual([0, 1].map(itemIndex => ({ batchId: a.batchId, requestKey: 'mcp-queued-key', itemIndex })));
  });

  it('persists immutable inputs before accepting and submitting status before calling the single executor', async () => {
    let busy = true;
    const h = await queueSetup({ isBusy: () => busy });
    const batch = await h.service.enqueue(queued());
    const dir = path.join(h.runtimeDir, 'frozen-queue');
    const inputBytes = await fs.readFile(path.join(dir, `${batch.batchId}.input.json`), 'utf8');
    const input = JSON.parse(inputBytes);
    expect(input.snapshots[0].params.positivePrompt).toContain('teacup'); expect(input.initial.items[0].plannedSeed).toBe(42);
    expect(JSON.parse(await fs.readFile(path.join(dir, `${batch.batchId}.state.json`), 'utf8')).job.status).toBe('queued');
    const submit = h.generation.submit as ReturnType<typeof vi.fn>, original = submit.getMockImplementation()!;
    submit.mockImplementation((args: any) => {
      const state = JSON.parse(readFileSync(path.join(dir, `${batch.batchId}.state.json`), 'utf8'));
      expect(state.job.items[0]).toMatchObject({ status: 'submitting', requestKey: args.requestKey });
      return original(args);
    });
    busy = false; await expectCount(h, 1); h.settle(0); await expectStatus(h, batch, 'succeeded'); await h.service.dispose();
    expect(await fs.readFile(path.join(dir, `${batch.batchId}.input.json`), 'utf8')).toBe(inputBytes);
    expect(JSON.parse(await fs.readFile(path.join(dir, `${batch.batchId}.state.json`), 'utf8')).job.items[0].results[0].id).toBe('result-1');
  });

  it('deduplicates simultaneous enqueue receipts and rejects same-key different frozen content', async () => {
    const h = await queueSetup({ isBusy: () => true }), input = queued();
    const [a, b] = await Promise.all([h.service.enqueue(input), h.service.enqueue(input)]);
    expect(a.batchId).toBe(b.batchId); expect(h.service.list({ workspaceId: 'q' }).batches).toHaveLength(1);
    await expect(h.service.enqueue(queued({ snapshot: { ...snapshot(), params: { ...snapshot().params, positivePrompt: 'different content' } } }))).rejects.toMatchObject({ code: 'request_conflict' });
    expect(h.service.lookup({ ...input, snapshot: undefined })?.batchId).toBe(a.batchId);
    await expect(h.service.enqueue(queued({ submittedRevision: 8, requestKey: 'no-adopt' }))).rejects.toMatchObject({ code: 'invalid_arguments' });
    expect(h.accepted).toHaveLength(0);
  });

  it('waits through a known local busy race without resubmitting an accepted child', async () => {
    const h = await queueSetup();
    vi.mocked(h.generation.submit).mockImplementationOnce(() => { throw new BatchError('workspace_busy', 'not accepted'); });
    const a = await h.service.enqueue(queued()); await expectCount(h, 1); h.settle(0); await expectStatus(h, a, 'succeeded');
    expect(h.generation.submit).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(h.generation.submit).mock.calls;
    expect(calls[0][0].requestKey).toBe(calls[1][0].requestKey);
  });

  it('pauses later pending batches after an unknown child and never retries it', async () => {
    const h = await queueSetup(), a = await h.service.enqueue(queued()); await expectCount(h, 1);
    const b = await h.service.enqueue(queued({ requestKey: 'second' }));
    h.settle(0, 'unknown'); await expectStatus(h, a, 'blocked'); await expectStatus(h, b, 'paused');
    expect(h.accepted).toHaveLength(1); expect(h.read(b).error?.code).toBe('queue_halted');
    const c = await h.service.enqueue(queued({ requestKey: 'third' })); expect(c.status).toBe('paused');
  });

  it('cancels only the selected active batch and continues FIFO after its child confirms cancellation', async () => {
    const h = await queueSetup(), a = await h.service.enqueue(queued({ count: 2 })); await expectCount(h, 1);
    const b = await h.service.enqueue(queued({ requestKey: 'second' }));
    await h.service.cancel(h.args(a)); expect(h.accepted).toHaveLength(1);
    expect(h.generation.cancel).toHaveBeenCalledWith({ workspaceId: 'origin', jobId: 'child-1' });
    h.settle(0, 'cancelled'); await expectStatus(h, a, 'cancelled'); await expectCount(h, 2);
    h.settle(1); await expectStatus(h, b, 'succeeded');
    expect(h.read(a).items.map(item => item.status)).toEqual(['cancelled', 'cancelled']);
  });

  it.each(['not_submitted', 'response_received'] as const)('normalizes a blocked v2 unknown/%s item without erasing response evidence', async providerOutcome => {
    const h = await queueSetup({ isBusy: () => true }), batch = await h.service.enqueue(queued({ requestKey: `blocked-${providerOutcome}` })); await h.service.dispose();
    const disk = createBatchStorage(h.runtimeDir), [record] = await disk.load(), blocked = structuredClone(record.job);
    Object.assign(blocked, { status: 'blocked', activeIndex: null, activeJobId: null, finishedAt: new Date().toISOString(), error: { code: 'fixture_unknown', message: 'old v2 unknown checkpoint' } });
    Object.assign(blocked.items[0], { status: 'unknown', providerOutcome, error: { code: 'fixture_unknown', message: 'old v2 unknown checkpoint' } });
    await disk.save(batch.batchId, blocked);
    const restored = setup({ runtimeDir: h.runtimeDir, isBusy: () => true }); await restored.service.ready;
    expect(restored.read(batch).items[0]).toMatchObject({ status: 'unknown', providerOutcome: providerOutcome === 'response_received' ? 'response_received' : 'unknown' });
    expect(restored.generation.submit).not.toHaveBeenCalled(); await restored.service.dispose();
  });

  it('recovers a submit-await crash checkpoint as provider-unknown without replaying it', async () => {
    const h = await queueSetup(); let entered = false, rejectSubmit!: (error: Error) => void;
    vi.mocked(h.generation.submit).mockImplementation(async () => { entered = true; return new Promise<BatchChildJob>((_resolve, reject) => { rejectSubmit = reject; }); });
    const batch = await h.service.enqueue(queued()); await waitUntil(() => expect(entered).toBe(true));
    expect(h.read(batch).items[0]).toMatchObject({ status: 'submitting' });
    const copy = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-submit-await-copy-')); cleanups.push(() => fs.rm(copy, { recursive: true, force: true })); await fs.cp(h.runtimeDir, copy, { recursive: true });
    const closing = h.service.dispose(); rejectSubmit(new Error('controlled submit stopped after checkpoint copy')); await closing;
    const restored = setup({ runtimeDir: copy, isBusy: () => true }); await restored.service.ready;
    expect(restored.read(batch).items[0]).toMatchObject({ status: 'unknown', providerOutcome: 'unknown' });
    expect(restored.generation.submit).not.toHaveBeenCalled(); await restored.service.dispose();
  });

  it('conservatively recovers running checkpoints while preserving an already observed response', async () => {
    for (const providerOutcome of ['not_submitted', 'response_received'] as const) {
      const h = await queueSetup({ isBusy: () => true }), batch = await h.service.enqueue(queued({ requestKey: `recover-${providerOutcome}` })); await h.service.dispose();
      const disk = createBatchStorage(h.runtimeDir), [record] = await disk.load(), interrupted = structuredClone(record.job);
      Object.assign(interrupted, { status: 'running', activeIndex: 0, activeJobId: 'child-checkpoint' });
      Object.assign(interrupted.items[0], { status: 'running', jobId: 'child-checkpoint', actualSeed: 42, providerOutcome, results: providerOutcome === 'response_received' ? [{ index: 0, id: 'observed-result', width: 64, height: 64, model: snapshot().params.model, actualSeed: 42 }] : [] });
      await disk.save(batch.batchId, interrupted);
      const restored = setup({ runtimeDir: h.runtimeDir, isBusy: () => true }); await restored.service.ready;
      expect(restored.read(batch).items[0]).toMatchObject({ status: 'unknown', providerOutcome: providerOutcome === 'response_received' ? 'response_received' : 'unknown' });
      expect(restored.read(batch).items[0].results).toHaveLength(providerOutcome === 'response_received' ? 1 : 0); expect(restored.generation.submit).not.toHaveBeenCalled(); await restored.service.dispose();
    }
  });

  it('keeps an equal-timestamp terminal subscriber event when a stale read and subscriber follow it', async () => {
    const waits: Array<() => void> = [], h = await queueSetup({ wait: () => new Promise<void>(resolve => waits.push(resolve)) });
    const submit = vi.mocked(h.generation.submit), original = submit.getMockImplementation()!;
    submit.mockImplementation((args: any) => { const child = original(args) as BatchChildJob; child.providerOutcome = 'not_submitted'; h.jobs.set(child.jobId, structuredClone(child)); return child; });
    const batch = await h.service.enqueue(queued()); await waitUntil(() => expect(waits).toHaveLength(1));
    const stale = structuredClone(h.jobs.get('child-1')!); h.settle(0, 'succeeded'); const terminal = structuredClone(h.jobs.get('child-1')!); stale.updatedAt = terminal.updatedAt;
    vi.mocked(h.generation.read).mockImplementation(() => structuredClone(stale)); h.emitJob(stale); waits.shift()!();
    await expectStatus(h, batch, 'succeeded');
    expect(h.read(batch).items[0]).toMatchObject({ status: 'succeeded', providerOutcome: 'response_received', results: [{ id: 'result-1' }] });
  });

  it('keeps response, unknown and proven-not-submitted facts independent and durable across reopen', async () => {
    const h = await queueSetup(), batch = await h.service.enqueue(queued({ count: 3 }));
    await expectCount(h, 1); h.settle(0, 'succeeded'); await expectCount(h, 2); h.settle(1, 'unknown'); await expectStatus(h, batch, 'blocked');
    expect(h.read(batch).items.map(item => item.providerOutcome)).toEqual(['response_received', 'unknown', 'not_submitted']);
    expect(h.read(batch).items.map(item => item.status)).toEqual(['succeeded', 'unknown', 'skipped']);
    await h.service.dispose(); const restored = setup({ runtimeDir: h.runtimeDir }); await restored.service.ready;
    expect(restored.read(batch).items.map(item => item.providerOutcome)).toEqual(['response_received', 'unknown', 'not_submitted']);
    expect(restored.generation.submit).not.toHaveBeenCalled(); await restored.service.dispose();
  });

  it('does not let a later stale child projection downgrade an observed provider response', async () => {
    const h = await queueSetup(), batch = await h.service.enqueue(queued()); await expectCount(h, 1);
    const child = h.jobs.get('child-1')!; child.providerOutcome = 'response_received'; child.updatedAt = new Date(Date.now() + 10).toISOString();
    await waitUntil(() => expect(h.read(batch).items[0].providerOutcome).toBe('response_received'));
    child.providerOutcome = 'unknown'; child.updatedAt = new Date(Date.now() + 20).toISOString();
    await new Promise(resolve => setTimeout(resolve, 10)); expect(h.read(batch).items[0].providerOutcome).toBe('response_received');
    h.settle(0); await expectStatus(h, batch, 'succeeded');
  });

  it.each([
    ['cleaned', { status: 400, message: 'denied for /data/users/alice/x.png, Authorization: Basic YWxpY2U6aHVudGVyMg== \u2066x\u2069', extra: 'pst-abcdefghijkl' }, { status: 400, message: 'denied for …, Authorization: … x' }],
    ['dropped when nothing usable is left', { status: 99999, message: 42 }, undefined],
  ] as const)('a stored item\'s upstream answer read back is %s (review rework)', async (_case, upstream, expected) => {
    const h = await queueSetup({ isBusy: () => true }), batch = await h.service.enqueue(queued({ requestKey: 'upstream-readback' })); await h.service.dispose();
    const disk = createBatchStorage(h.runtimeDir), [record] = await disk.load(), stored = structuredClone(record.job);
    Object.assign(stored, { status: 'blocked', activeIndex: null, activeJobId: null, finishedAt: new Date().toISOString(), error: { code: 'fixture_unknown', message: 'old v2 unknown checkpoint' } });
    Object.assign(stored.items[0], { status: 'unknown', providerOutcome: 'response_received', error: { code: 'generation_failed', message: 'm', upstream } });
    await disk.save(batch.batchId, stored);
    const restored = setup({ runtimeDir: h.runtimeDir, isBusy: () => true }); await restored.service.ready;
    expect(restored.read(batch).items[0].error).toEqual({ code: 'generation_failed', message: 'm', ...(expected ? { upstream: expected } : {}) });
    await restored.service.dispose();
  });

  it('treats a missing provider field in an old valid state as unknown instead of inferring not-submitted', async () => {
    const h = await queueSetup({ isBusy: () => true }), batch = await h.service.enqueue(queued()); await h.service.dispose();
    const disk = createBatchStorage(h.runtimeDir), [record] = await disk.load(), old = structuredClone(record.job);
    delete old.items[0].providerOutcome; await disk.save(batch.batchId, old);
    const restored = setup({ runtimeDir: h.runtimeDir, isBusy: () => true }); await restored.service.ready;
    expect(restored.read(batch).items[0]).toMatchObject({ status: 'pending', providerOutcome: 'unknown' });
    expect(restored.generation.submit).not.toHaveBeenCalled(); await restored.service.dispose();
  });

  it('recovers pending entries paused and resumes the exact saved recipe without a live workspace', async () => {
    const h = await queueSetup({ isBusy: () => true }); const batch = await h.service.enqueue(queued()); await h.service.dispose();
    const restored = setup({ runtimeDir: h.runtimeDir }); await restored.service.ready;
    expect(restored.read(batch).status).toBe('paused'); expect(restored.accepted).toHaveLength(0);
    await restored.service.resume({ workspaceId: 'recipe-queue', expectedRevision: 0, batchId: batch.batchId });
    await expectCount(restored, 1); expect(restored.accepted[0].snapshot.params).toEqual(snapshot().params);
    restored.settle(0); await expectStatus(restored, batch, 'succeeded'); await restored.service.dispose();
  });

  it('recovers an in-flight item as unknown with no provider replay', async () => {
    const h = await queueSetup(), batch = await h.service.enqueue(queued({ count: 2 })); await expectCount(h, 1); await h.service.dispose();
    const restored = setup({ runtimeDir: h.runtimeDir }); await restored.service.ready;
    expect(restored.read(batch)).toMatchObject({ status: 'blocked', error: { code: 'restart_unconfirmed' } });
    expect(restored.read(batch).items.map(item => item.status)).toEqual(['unknown', 'skipped']);
    await expect(restored.service.resume({ ...restored.args(batch), expectedRevision: 7 })).rejects.toMatchObject({ code: 'batch_not_paused' });
    expect(restored.accepted).toHaveLength(0); await restored.service.dispose();
  });

  it.each(['failed', 'unknown', 'cancelled'] as const)('blocks a persisted %s child terminal window before any pending follower can run', async status => {
    const h = await queueSetup({ isBusy: () => true }), batch = await h.service.enqueue(queued({ count: 2 })); await h.service.dispose();
    const disk = createBatchStorage(h.runtimeDir), [record] = await disk.load();
    const crashed = structuredClone(record.job); crashed.status = 'running'; crashed.items[0].status = status; crashed.items[0].jobId = 'terminal-child'; crashed.items[0].actualSeed = crashed.items[0].plannedSeed;
    crashed.items[0].error = { code: status, message: 'durable child terminal before batch block' }; crashed.activeIndex = null; crashed.activeJobId = null;
    await disk.save(batch.batchId, crashed);
    const restored = setup({ runtimeDir: h.runtimeDir }); await restored.service.ready;
    expect(restored.read(batch).status).toBe('blocked'); expect(restored.read(batch).items.map(item => item.status)).toEqual([status, 'skipped']);
    expect(restored.generation.submit).not.toHaveBeenCalled();
    await expect(restored.service.resume({ ...restored.args(batch), expectedRevision: 0 })).rejects.toMatchObject({ code: 'batch_not_paused' });
    await restored.service.dispose();
  });

  it('recovers a durable batch when storage.create publishes files and then throws before current-process registration', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-queue-create-uncertain-')), disk = createBatchStorage(runtimeDir);
    cleanups.push(() => fs.rm(runtimeDir, { recursive: true, force: true }));
    const storage = { load: () => disk.load(), save: (id: string, job: BatchJob) => disk.save(id, job), create: async (input: any) => {
      await disk.create(input); throw new Error('published input/state but final acknowledgement failed');
    } };
    const first = setup({ storage, isBusy: () => true }); await first.service.ready;
    await expect(first.service.enqueue(queued())).rejects.toMatchObject({ code: 'queue_storage_error' });
    expect(() => first.service.lookup(queued())).toThrow(expect.objectContaining({ code: 'queue_storage_error' }));
    expect(first.generation.submit).not.toHaveBeenCalled(); await first.service.dispose();
    const restarted = setup({ runtimeDir, isBusy: () => true }); await restarted.service.ready;
    expect(restarted.service.lookup(queued())).toMatchObject({ requestKey: 'teacup-study', status: 'paused', error: { code: 'recovered_paused' } });
    expect(restarted.generation.submit).not.toHaveBeenCalled(); await restarted.service.dispose();
  });

  it('stops before a provider call when the submitting checkpoint cannot be persisted', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-queue-disk-fail-')), disk = createBatchStorage(dir);
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true })); // removed after the service's dispose
    const h = setup({ storage: { ...disk, save: async (id, job) => { if (job.items.some(item => item.status === 'submitting')) throw new Error('disk full'); return disk.save(id, job); } } });
    await h.service.ready;
    await h.service.enqueue(queued());
    await waitUntil(() => expect(() => h.service.lookup(queued())).toThrow(expect.objectContaining({ code: 'queue_storage_error' })));
    await expect(h.service.enqueue(queued({ requestKey: 'second' }))).rejects.toMatchObject({ code: 'queue_storage_error' });
    expect(h.accepted).toHaveLength(0); expect(h.generation.submit).not.toHaveBeenCalled();
  });

  it('bounds queued backlog and rejects a 201st item without accepting it', async () => {
    const h = await queueSetup({ isBusy: () => true });
    for (let i = 0; i < 10; i++) await h.service.enqueue(queued({ count: 20, requestKey: `batch-${i}` }));
    await expect(h.service.enqueue(queued({ requestKey: 'overflow' }))).rejects.toMatchObject({ code: 'queue_full' });
    expect(h.service.list({ workspaceId: 'q' }).batches).toHaveLength(10); expect(h.accepted).toHaveLength(0);
  });

  it('dispose does not wait for an unresolved provider operation in the actual single-image service', async () => {
    let complete!: (value: any) => void;
    const execute = vi.fn(async () => new Promise<any>(resolve => { complete = resolve; }));
    const generation = createGenerationService({ execute, validateImage: () => ({ width: 1, height: 1 }) });
    const h = await queueSetup({ generation }); await h.service.enqueue(queued());
    await waitUntil(() => expect(execute).toHaveBeenCalledOnce());
    // The provider operation is completed only after dispose has returned: a dispose that waited for it would never
    // return (the test timeout reports that), however slow the machine is.
    try { await h.service.dispose(); }
    finally { complete({ ok: false, message: 'fixture ended', items: [] }); }
  });

  it.each(['malformed', 'contradictory-terminal', 'pending-with-child', 'mismatched-active-child'])('refuses %s recovered state without erasing files or accepting any new job', async damage => {
    const h = await queueSetup({ isBusy: () => true }), batch = await h.service.enqueue(queued()); await h.service.dispose();
    const file = path.join(h.runtimeDir, 'frozen-queue', `${batch.batchId}.state.json`), saved = JSON.parse(await fs.readFile(file, 'utf8'));
    if (damage === 'contradictory-terminal') saved.job.status = 'succeeded';
    if (damage === 'pending-with-child') { saved.job.items[0].jobId = 'already-accepted-child'; saved.job.items[0].actualSeed = 42; }
    if (damage === 'mismatched-active-child') { saved.job.activeIndex = 0; saved.job.activeJobId = 'wrong-child'; Object.assign(saved.job.items[0], { status: 'running', jobId: 'actual-child', actualSeed: 42 }); }
    const broken = damage === 'malformed' ? '{' : JSON.stringify(saved);
    await fs.writeFile(file, broken);
    const restored = setup({ runtimeDir: h.runtimeDir });
    await expect(restored.service.ready).rejects.toMatchObject({ code: 'queue_storage_error' });
    await expect(restored.service.enqueue(queued({ requestKey: 'later' }))).rejects.toMatchObject({ code: 'queue_storage_error' });
    expect(() => restored.service.lookup(queued({ requestKey: 'later' }))).toThrow(expect.objectContaining({ code: 'queue_storage_error' }));
    expect(restored.accepted).toHaveLength(0); expect(await fs.readFile(file, 'utf8')).toBe(broken);
  });
});

// The serial scheduler behaviours below were exercised through the linked canvas batches (submit_batch) until they
// were retired on 2026-11-02; every one that is not about a workspace checkpoint or draft adoption runs here on a
// durable queued batch, which is the scheduler's only path now.
describe('queued batch scheduler', () => {
  it('rejects a linked canvas batch outright: only durable queued batches exist', async () => {
    const h = await queueSetup();
    await expect(h.service.enqueue(request())).rejects.toMatchObject({ code: 'invalid_arguments' });
    expect(() => h.service.lookup(request())).toThrow(expect.objectContaining({ code: 'invalid_arguments' }));
    expect((h.service as Record<string, unknown>).submit).toBeUndefined();
    expect(h.accepted).toHaveLength(0);
  });

  it.each([{ draftId: '' }, { draftId: 'x\n' }, { draftId: 4 }, { submittedRevision: 8 }, { submittedRevision: 8.5 }, { submittedRevision: null }])('rejects invalid draft metadata or an adopted revision %j without accepting children', async extra => {
    const h = await queueSetup();
    await expect(h.service.enqueue(queued({ count: 3, ...extra }))).rejects.toMatchObject({ code: 'invalid_arguments' });
    expect(h.accepted).toHaveLength(0);
    expect(h.service.list({ workspaceId: 'w' }).batches).toHaveLength(0);
  });

  it('rejects scenes mixed with a draft identity before creating a batch', async () => {
    const h = await queueSetup();
    await expect(h.service.enqueue(sceneRequest({ execution: 'queued', draftId: 'draft' }))).rejects.toMatchObject({ code: 'invalid_arguments' });
    expect(h.accepted).toHaveLength(0);
  });

  it('exposes the canonical authored scene-plan hash and excludes it for batches without scenes', async () => {
    const scenes = [
      { sceneId: 'red', patch: { params: { seed: 1, positivePrompt: 'red cup' }, charCaptions: [] } },
      { sceneId: 'blue', patch: { charCaptions: [], params: { positivePrompt: 'blue cup', seed: 2 } } },
    ];
    const canonicalText = '[{"patch":{"charCaptions":[],"params":{"positivePrompt":"red cup","seed":1}},"sceneId":"red"},{"patch":{"charCaptions":[],"params":{"positivePrompt":"blue cup","seed":2}},"sceneId":"blue"}]';
    const hash = createHash('sha256').update(canonicalText, 'utf8').digest('hex');
    expect(scenePlanHash(scenes)).toBe(hash);
    expect(scenePlanHash([...scenes].reverse())).not.toBe(hash);
    const h = await queueSetup({ isBusy: () => true }), batch = await h.service.enqueue(sceneRequest({ execution: 'queued', scenes }));
    expect(batch.scenePlanHash).toBe(hash);
    expect(h.read(batch).scenePlanHash).toBe(hash);
    await h.service.cancel(h.args(batch)); await expectStatus(h, batch, 'cancelled');
    const plain = await h.service.enqueue(queued({ requestKey: 'plain' }));
    expect(plain).not.toHaveProperty('scenePlanHash');
  });

  it('runs each frozen scene with its own complete recipe and traces authored versus execution seeds', async () => {
    const h = await queueSetup(), input = sceneRequest({ execution: 'queued' }), batch = await h.service.enqueue(input);
    expect(batch.items.map(item => [item.sceneId, item.authoredSeed, item.authoredSeedMode, item.plannedSeed, item.executionSeedMode])).toEqual([
      ['scene-1', 50, 'fixed', 50, 'fixed'], ['scene-2', 60, 'fixed', 60, 'fixed'],
    ]);
    (input as any).snapshots[1].params.positivePrompt = 'later change';
    await expectCount(h, 1); await h.service.pause(h.args(batch)); h.settle(0); await expectStatus(h, batch, 'paused');
    await h.service.resume({ ...h.args(batch), expectedRevision: 0 });
    await expectCount(h, 2); h.settle(1); await expectStatus(h, batch, 'succeeded');
    expect(h.accepted.map(item => [item.snapshot.params.positivePrompt, item.snapshot.params.steps, item.snapshot.extras.charCaptions.length, item.snapshot.params.seed])).toEqual([
      ['red cup on a table', 20, 0, 50], ['blue cup beside a plant', 21, 1, 60],
    ]);
    expect(h.read(batch).items.map(item => [item.sceneId, item.jobId, item.actualSeed])).toEqual([['scene-1', 'child-1', 50], ['scene-2', 'child-2', 60]]);
  });

  it.each(['increment', 'random', 'explicit'] as const)('plans and exposes %s scene seeds once without hiding the original recipe policy', async kind => {
    const randomSeed = vi.fn().mockReturnValueOnce(81).mockReturnValueOnce(92), h = await queueSetup({ randomSeed });
    const input = sceneRequest({ execution: 'queued', ...(kind === 'explicit' ? { seeds: [71, 72] } : { seedMode: kind }) });
    if (kind === 'explicit') delete (input as Record<string, unknown>).seedMode;
    (input as any).snapshots[0].params.seedMode = 'random';
    const batch = await h.service.enqueue(input), planned = kind === 'increment' ? [50, 51] : kind === 'random' ? [81, 92] : [71, 72];
    expect(batch.items.map(item => item.plannedSeed)).toEqual(planned);
    expect(batch.items[0]).toMatchObject({ authoredSeedMode: 'random', executionSeedMode: 'fixed' });
    for (let i = 0; i < 2; i++) { await expectCount(h, i + 1); expect(h.accepted[i].snapshot.params).toMatchObject({ seed: planned[i], seedMode: 'fixed' }); h.settle(i); }
    await expectStatus(h, batch, 'succeeded');
    expect(randomSeed).toHaveBeenCalledTimes(kind === 'random' ? 2 : 0);
  });

  it('includes scene identities, recipes and order in idempotency without re-submitting an accepted batch', async () => {
    const h = await queueSetup({ isBusy: () => true }), input = sceneRequest({ execution: 'queued' }), batch = await h.service.enqueue(input);
    expect((await h.service.enqueue(input)).batchId).toBe(batch.batchId);
    const reordered = (input as any).scenes.map((scene: any) => ({ patch: { charCaptions: scene.patch.charCaptions, params: Object.fromEntries(Object.entries(scene.patch.params).reverse()) }, sceneId: scene.sceneId }));
    expect((await h.service.enqueue({ ...input, scenes: reordered })).batchId).toBe(batch.batchId);
    for (const scenes of [
      [...(input as any).scenes].reverse(),
      (input as any).scenes.map((item: any, index: number) => index ? item : { ...item, patch: { params: { positivePrompt: 'changed recipe' } } }),
    ]) await expect(h.service.enqueue({ ...input, scenes })).rejects.toMatchObject({ code: 'request_conflict' });
    await h.service.cancel(h.args(batch)); await expectStatus(h, batch, 'cancelled'); expect(h.accepted).toHaveLength(0);
  });

  it('rejects incomplete scene preparation before creating a batch or any child', async () => {
    const h = await queueSetup();
    for (const extra of [
      { snapshots: [snapshot()] }, { snapshots: [snapshot(), {}] }, { snapshot: snapshot() },
      { mode: 'i2i' }, { scenes: [{ sceneId: 'same', patch: { params: {} } }, { sceneId: 'same', patch: { params: {} } }] },
    ]) await expect(h.service.enqueue(sceneRequest({ execution: 'queued', ...extra }))).rejects.toBeTruthy();
    expect(h.service.list({ workspaceId: 'origin' }).batches).toEqual([]);
    expect(h.generation.submit).not.toHaveBeenCalled();
  });

  it('blocks remaining distinct scenes after an unknown child result without retrying', async () => {
    const h = await queueSetup(), batch = await h.service.enqueue(sceneRequest({ execution: 'queued' }));
    await expectCount(h, 1); h.settle(0, 'unknown'); await expectStatus(h, batch, 'blocked');
    expect(h.accepted).toHaveLength(1);
    expect(h.read(batch).items.map(item => [item.sceneId, item.status])).toEqual([['scene-1', 'unknown'], ['scene-2', 'skipped']]);
    await expect(h.service.resume({ ...h.args(batch), expectedRevision: 0 })).rejects.toMatchObject({ code: 'batch_not_paused' });
  });

  it('returns at once, freezes the recipe and executes exactly one child at a time with deterministic increment seeds', async () => {
    const h = await queueSetup(), input = queued({ count: 3 }), batch = await h.service.enqueue(input);
    expect(batch.items.map((item) => item.plannedSeed)).toEqual([42, 43, 44]);
    expect(batch.items.every((item) => item.jobId === null)).toBe(true);
    (input.snapshot as GenerationSnapshot).params.positivePrompt = 'later user edit';
    for (let index = 0; index < 3; index++) {
      await expectCount(h, index + 1);
      expect(h.accepted[index].snapshot.params).toMatchObject({ positivePrompt: 'a blue teacup on a wooden table', seedMode: 'fixed', seed: 42 + index });
      expect(h.accepted[index].snapshot.batchCount).toBe(1);
      expect(h.read(batch).activeJobId).toBe(`child-${index + 1}`);
      h.settle(index);
    }
    await expectStatus(h, batch, 'succeeded');
    expect(h.read(batch).items.map((item) => [item.jobId, item.actualSeed, item.results[0].id])).toEqual([['child-1', 42, 'result-1'], ['child-2', 43, 'result-2'], ['child-3', 44, 'result-3']]);
  });

  it('deduplicates an accepted request even while the generator is busy and rejects any changed plan under the same request key', async () => {
    const busy = vi.fn(() => false), h = await queueSetup({ isBusy: busy }), input = queued({ count: 3 });
    busy.mockReturnValue(true);
    const batch = await h.service.enqueue(input);
    expect((await h.service.enqueue(input)).batchId).toBe(batch.batchId);
    for (const change of [{ count: 2 }, { expectedRevision: 8 }, { mode: 'i2i' }, { seedMode: 'fixed' }, { intervalSeconds: 1 }]) await expect(h.service.enqueue({ ...input, ...change })).rejects.toMatchObject({ code: 'request_conflict' });
    await h.service.cancel(h.args(batch));
    await expectStatus(h, batch, 'cancelled');
    expect(h.accepted).toHaveLength(0);
  });

  it.each(['fixed', 'random', 'explicit'] as const)('determines all %s seeds at acceptance without later reroll', async (kind) => {
    const randomSeed = vi.fn().mockReturnValueOnce(13).mockReturnValueOnce(17).mockReturnValueOnce(19), h = await queueSetup({ randomSeed, isBusy: () => true });
    const input = queued({ count: 3, ...(kind === 'explicit' ? { seeds: [3, 2, 1] } : { seedMode: kind }) });
    if (kind === 'explicit') delete (input as Record<string, unknown>).seedMode;
    const batch = await h.service.enqueue(input);
    expect(batch.items.map((item) => item.plannedSeed)).toEqual(kind === 'fixed' ? [42, 42, 42] : kind === 'random' ? [13, 17, 19] : [3, 2, 1]);
    expect((await h.service.enqueue(input)).items).toEqual(batch.items);
    expect(randomSeed).toHaveBeenCalledTimes(kind === 'random' ? 3 : 0);
    await h.service.cancel(h.args(batch)); await expectStatus(h, batch, 'cancelled');
  });

  it('pauses after the active child without cancelling it, then resumes the next untouched item', async () => {
    const h = await queueSetup(), batch = await h.service.enqueue(queued({ count: 3 })); await expectCount(h, 1);
    expect((await h.service.pause(h.args(batch))).status).toBe('pausing');
    expect(h.generation.cancel).not.toHaveBeenCalled();
    h.settle(0); await expectStatus(h, batch, 'paused');
    expect(h.accepted).toHaveLength(1);
    await h.service.resume({ ...h.args(batch), expectedRevision: 0 }); await expectCount(h, 2);
    expect(h.accepted[1].snapshot.params.seed).toBe(43);
    await h.service.cancel(h.args(batch)); h.settle(1, 'cancelled'); await expectStatus(h, batch, 'cancelled');
  });

  it('keeps the batch cancelling until the actual child settles, retaining prior results, and starts no later batch meanwhile', async () => {
    const h = await queueSetup(), batch = await h.service.enqueue(queued({ count: 3 })); await expectCount(h, 1); h.settle(0); await expectCount(h, 2);
    expect((await h.service.cancel(h.args(batch))).status).toBe('cancelling');
    await h.service.cancel(h.args(batch));
    expect(h.generation.cancel).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'origin', jobId: 'child-2' });
    const later = await h.service.enqueue(queued({ requestKey: 'another-batch' }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(h.accepted).toHaveLength(2);
    expect(h.read(later).status).toBe('queued');
    h.settle(1, 'succeeded'); await expectStatus(h, batch, 'cancelled');
    expect(h.read(batch).items.map((item) => item.status)).toEqual(['succeeded', 'succeeded', 'cancelled']);
    expect(h.read(batch).items[1].results).toHaveLength(1);
    await expectCount(h, 3); h.settle(2); await expectStatus(h, later, 'succeeded');
  });

  it.each(['failed', 'unknown', 'cancelled'] as const)('blocks subsequent children after an independent %s result and never resumes or retries it', async (status) => {
    const h = await queueSetup(), batch = await h.service.enqueue(queued({ count: 3 })); await expectCount(h, 1); h.settle(0, status); await expectStatus(h, batch, 'blocked');
    expect(h.read(batch).items.map((item) => item.status)).toEqual([status, 'skipped', 'skipped']);
    await expect(h.service.resume({ ...h.args(batch), expectedRevision: 0 })).rejects.toMatchObject({ code: 'batch_not_paused' });
    expect(h.generation.submit).toHaveBeenCalledTimes(1);
  });

  it('recovers a lost submit reply by lookup without submitting a paid child twice', async () => {
    const h = await queueSetup(), submit = h.generation.submit;
    h.generation.submit = vi.fn((args) => { submit(args); throw new Error('lost local reply'); });
    const batch = await h.service.enqueue(queued({ count: 3 })); await expectCount(h, 1);
    await waitUntil(() => expect(h.read(batch).activeJobId).toBe('child-1'));
    await h.service.pause(h.args(batch)); h.settle(0); await expectStatus(h, batch, 'paused');
    expect(h.generation.submit).toHaveBeenCalledTimes(1);
    expect(h.generation.lookup).toHaveBeenCalledTimes(2);
    await h.service.cancel(h.args(batch));
  });

  it('does not retry an unconfirmed submission and preserves the child key for investigation', async () => {
    const h = await queueSetup(); h.generation.submit = vi.fn(() => { throw new Error('unknown response'); });
    const batch = await h.service.enqueue(queued({ count: 3 })); await expectStatus(h, batch, 'blocked');
    expect(h.generation.submit).toHaveBeenCalledTimes(1);
    expect(h.read(batch).items[0]).toMatchObject({ status: 'unknown', jobId: null, requestKey: `batch-${batch.batchId}-0` });
    expect(h.read(batch).items.slice(1).map((item) => item.status)).toEqual(['skipped', 'skipped']);
  });

  it('blocks a child projection whose request identity does not belong to the frozen item', async () => {
    const h = await queueSetup(), original = h.generation.submit;
    h.generation.submit = vi.fn(async args => ({ ...await original(args), requestKey: 'another-child-request' }));
    const batch = await h.service.enqueue(queued()); await expectStatus(h, batch, 'blocked');
    expect(h.read(batch).items[0]).toMatchObject({ status: 'unknown', providerOutcome: 'unknown', jobId: null });
    expect(h.accepted).toHaveLength(1);
  });

  it('retains a definitive not-submitted outcome for a trusted pre-provider rejection', async () => {
    const h = await queueSetup(); h.generation.submit = vi.fn(() => { throw new BatchError('invalid_image', 'rejected before provider'); });
    const batch = await h.service.enqueue(queued({ count: 3 })); await expectStatus(h, batch, 'blocked');
    expect(h.read(batch).items[0]).toMatchObject({ status: 'failed', providerOutcome: 'not_submitted', error: { code: 'invalid_image' } });
    expect(h.read(batch).items.slice(1).map(item => item.providerOutcome)).toEqual(['not_submitted', 'not_submitted']);
    expect(h.generation.submit).toHaveBeenCalledOnce();
  });

  it('preflights depth, cycles and JSON escape expansion before canonical clone/stringify', async () => {
    const h = await queueSetup(); let cursor: any = {}, deep = cursor; for (let index = 0; index < 98; index++) cursor = cursor.child = {};
    await expect(h.service.enqueue({ ...queued(), extra: deep })).rejects.toMatchObject({ code: 'queue_input_too_large' });
    const cyclic: any = queued(); cyclic.self = cyclic; await expect(h.service.enqueue(cyclic)).rejects.toMatchObject({ code: 'invalid_arguments' });
    const escaped = '\\'.repeat(33 * 1024 * 1024); await expect(h.service.enqueue({ ...queued(), padding: escaped })).rejects.toMatchObject({ code: 'queue_input_too_large' });
    expect(h.generation.submit).not.toHaveBeenCalled();
  });

  it('validates the explicit bounded plan before accepting anything', async () => {
    const h = await queueSetup();
    for (const change of [{ count: 0 }, { count: 201 }, { intervalSeconds: -1 }, { intervalSeconds: 61 }, { seedMode: 'wat' }, { seeds: [1, 2, 3] }, { mode: 'video' }, { snapshot: { ...snapshot(), params: { ...snapshot().params, seed: 2_147_483_647 } }, seedMode: 'fixed' }])
      await expect(h.service.enqueue(queued(change))).rejects.toBeTruthy();
    expect(h.generation.submit).not.toHaveBeenCalled();
    expect(h.service.list({ workspaceId: 'viewer' }).batches).toEqual([]);
  });

  it('allows pausing and cancelling the accepted plan before its first child is dispatched', async () => {
    const h = await queueSetup({ isBusy: () => true }), batch = await h.service.enqueue(queued({ count: 3 }));
    expect((await h.service.pause(h.args(batch))).status).toBe('paused');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.generation.submit).not.toHaveBeenCalled();
    expect((await h.service.cancel(h.args(batch))).items.every((item) => item.status === 'cancelled')).toBe(true);
  });

  it('honors the inter-image interval and lets pause prevent the next scheduled child', async () => {
    const h = await queueSetup(), batch = await h.service.enqueue(queued({ count: 3, intervalSeconds: .1 })); await expectCount(h, 1); h.settle(0);
    await waitUntil(() => expect(h.read(batch).activeJobId).toBeNull(), { interval: 2 });
    await h.service.pause(h.args(batch)); await expectStatus(h, batch, 'paused');
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(h.accepted).toHaveLength(1);
    await h.service.resume({ ...h.args(batch), expectedRevision: 0 }); await expectCount(h, 2);
    await h.service.cancel(h.args(batch)); h.settle(1, 'cancelled'); await expectStatus(h, batch, 'cancelled');
  });

  it('waits for an in-flight submit response before targeting its child cancellation', async () => {
    const h = await queueSetup(), submit = h.generation.submit;
    let resolve!: (job: BatchChildJob) => void;
    h.generation.submit = vi.fn(async (args) => { const job = await submit(args); return new Promise<BatchChildJob>((done) => { resolve = () => done(job); }); });
    const batch = await h.service.enqueue(queued({ count: 3 })); await expectCount(h, 1);
    expect((await h.service.cancel(h.args(batch))).status).toBe('cancelling');
    expect(h.generation.cancel).not.toHaveBeenCalled();
    resolve(h.jobs.get('child-1')!);
    await waitUntil(() => expect(h.generation.cancel).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'origin', jobId: 'child-1' }));
    h.settle(0, 'cancelled'); await expectStatus(h, batch, 'cancelled');
    expect(h.accepted).toHaveLength(1);
  });

  it('finishes successfully when pause arrives on the final child and there is nothing left to pause', async () => {
    const h = await queueSetup(), batch = await h.service.enqueue(queued({ count: 2 })); await expectCount(h, 1); h.settle(0); await expectCount(h, 2);
    await h.service.pause(h.args(batch)); h.settle(1); await expectStatus(h, batch, 'succeeded');
    expect(h.read(batch).items.every((item) => item.status === 'succeeded')).toBe(true);
  });
});

// ---- W2b: queued post-processing modes, quota, compaction ----
const minutes = (count: number) => count * 60 * 1000;
const mcpKey = (name: string) => `mcp-${'c'.repeat(24)}-${createHash('sha256').update(name).digest('hex')}`;
const imageRequest = (requestKey: string, extra: Record<string, unknown> = {}) => queued({ requestKey, mode: 'i2i', snapshot: { ...snapshot(), sourceImage: { mimeType: 'image/png', data: 'I'.repeat(64 * 1024) }, i2i: { strength: .5, noise: 0, extraNoiseSeed: 5 } }, ...extra });
function postProcessing(mode: 'upscale' | 'director') {
  const value: Record<string, unknown> = queued({ requestKey: `post-${mode}`, mode, seeds: [0], snapshot: { ...snapshot(), params: { ...snapshot().params, seed: 0 }, sourceImage: { mimeType: 'image/png', data: 'fixture-source' },
    ...(mode === 'upscale' ? { upscale: { scale: 2 } } : { director: { tool: 'bg-removal', options: { defry: 0, prompt: '', emotion: 'happy', emotionLevel: 0 } } }) } });
  delete value.seedMode; return value;
}
const frozenFile = (runtimeDir: string, name: string) => path.join(runtimeDir, 'frozen-queue', name);
async function ageFinishedBatches(runtimeDir: string, by = minutes(11)) {
  const disk = createBatchStorage(runtimeDir);
  for (const record of await disk.load()) if (record.job.finishedAt) await disk.save(record.input.batchId, { ...record.job, finishedAt: new Date(Date.parse(record.job.finishedAt) - by).toISOString() });
}

describe('W2b frozen queue capacity', () => {
  it('H3 accepts queued upscale and director recipes and recovers them unchanged', async () => {
    const h = await queueSetup({ isBusy: () => true });
    const up = await h.service.enqueue(postProcessing('upscale')), director = await h.service.enqueue(postProcessing('director'));
    expect(up).toMatchObject({ mode: 'upscale', execution: 'queued', status: 'queued', items: [{ plannedSeed: 0, status: 'pending' }] }); expect(director).toMatchObject({ mode: 'director', status: 'queued' });
    await expect(h.service.enqueue(queued({ requestKey: 'unknown-mode', mode: 'video' }))).rejects.toMatchObject({ code: 'unsupported_mode' });
    await h.service.dispose();
    const restored = setup({ runtimeDir: h.runtimeDir }); await restored.service.ready;
    expect(restored.read(up)).toMatchObject({ mode: 'upscale', status: 'paused', error: { code: 'recovered_paused' } }); expect(restored.read(director)).toMatchObject({ mode: 'director', status: 'paused' });
    expect(restored.service.lookup(postProcessing('upscale'))?.batchId).toBe(up.batchId);
    await restored.service.resume({ workspaceId: 'recipe-queue', expectedRevision: 0, batchId: up.batchId }); await expectCount(restored, 1);
    expect(restored.accepted[0]).toMatchObject({ request: { mode: 'upscale', requestKey: `batch-${up.batchId}-0` }, snapshot: { upscale: { scale: 2 }, sourceImage: { data: 'fixture-source' }, batchCount: 1, params: { seed: 0 } } });
    restored.settle(0); await expectStatus(restored, up, 'succeeded'); expect(restored.read(director).status).toBe('paused');
    await restored.service.dispose();
  });

  it('H4 reports a frozen-queue quota refusal as queue_full while other queued batches keep running', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-queue-full-'));
    cleanups.push(() => fs.rm(runtimeDir, { recursive: true, force: true })); // removed after the service's dispose
    let busy = true; const h = setup({ storage: createBatchStorage(runtimeDir, { total: 512 * 1024 }), isBusy: () => busy });
    await h.service.ready;
    const first = await h.service.enqueue(queued({ requestKey: 'first', count: 2 })), second = await h.service.enqueue(queued({ requestKey: 'second' }));
    const before = h.service.capacity()!;
    // Physically fits under 512 KiB, but not with the 32 KiB save reserve.
    const huge = queued({ requestKey: 'too-large', snapshot: { ...snapshot(), sourceImage: { mimeType: 'image/png', data: 'x'.repeat(470 * 1024) } } });
    await expect(h.service.enqueue(huge)).rejects.toMatchObject({ code: 'queue_full' });
    expect(h.service.capacity()).toMatchObject({ batches: 2, bytes: before.bytes, batchLimit: 4096, byteLimit: 512 * 1024, reserve: 32 * 1024 });
    expect(h.service.lookup(huge)).toBeNull();
    expect([first, second].map(batch => [h.read(batch).status, h.read(batch).error])).toEqual([['queued', null], ['queued', null]]);
    busy = false; await expectCount(h, 1); h.settle(0); await expectCount(h, 2); h.settle(1); await expectStatus(h, first, 'succeeded');
    await expectCount(h, 3); h.settle(2); await expectStatus(h, second, 'succeeded');
    await expect(h.service.enqueue(queued({ requestKey: 'fits-later' }))).resolves.toMatchObject({ status: 'queued' });
  });

  it('H6 compacts ended MCP batches in the background after startup and keeps lookup, read, list and restart intact', async () => {
    const h = await queueSetup(), mcp = imageRequest(mcpKey('mcp')), foreign = imageRequest('style-plan-host-key'), unknown = imageRequest(mcpKey('unknown'));
    const a = await h.service.enqueue(mcp); await expectCount(h, 1); h.settle(0); await expectStatus(h, a, 'succeeded');
    const b = await h.service.enqueue(foreign); await expectCount(h, 2); h.settle(1); await expectStatus(h, b, 'succeeded');
    const c = await h.service.enqueue(unknown); await expectCount(h, 3); h.settle(2, 'unknown'); await expectStatus(h, c, 'blocked');
    await h.service.dispose(); await ageFinishedBatches(h.runtimeDir);
    const restarted = setup({ runtimeDir: h.runtimeDir, isBusy: () => true }); await restarted.service.ready;
    await waitUntil(() => expect(restarted.read(a)).toMatchObject({ inputCompacted: true, compactedAt: expect.any(String) }));
    const compacted = JSON.parse(await fs.readFile(frozenFile(h.runtimeDir, `${a.batchId}.input.json`), 'utf8'));
    expect(compacted).toMatchObject({ schemaVersion: 2, compaction: { snapshotCount: 1 } }); expect(compacted).not.toHaveProperty('snapshots');
    expect(await fs.readdir(frozenFile(h.runtimeDir, `${a.batchId}.states`))).toHaveLength(1);
    for (const batch of [b, c]) {
      expect(restarted.read(batch)).not.toHaveProperty('inputCompacted');
      expect(JSON.parse(await fs.readFile(frozenFile(h.runtimeDir, `${batch.batchId}.input.json`), 'utf8')).schemaVersion).toBe(1);
    }
    expect(restarted.service.lookup(mcp)).toMatchObject({ batchId: a.batchId, status: 'succeeded', inputCompacted: true });
    expect(restarted.service.lookup({ ...mcp, snapshot: undefined })?.batchId).toBe(a.batchId);
    expect(() => restarted.service.lookup({ ...mcp, snapshot: { ...snapshot(), params: { ...snapshot().params, positivePrompt: 'other recipe' } } })).toThrow(expect.objectContaining({ code: 'request_conflict' }));
    expect(restarted.service.list({ workspaceId: 'recipe-queue' }).batches.find(batch => batch.batchId === a.batchId)).toMatchObject({ inputCompacted: true, items: [{ status: 'succeeded', results: [{ id: 'result-1' }] }] });
    expect((await restarted.service.enqueue(mcp)).batchId).toBe(a.batchId);
    const compactedAt = restarted.read(a).compactedAt; await restarted.service.dispose();
    const again = setup({ runtimeDir: h.runtimeDir, isBusy: () => true }); await again.service.ready;
    expect(again.read(a)).toMatchObject({ status: 'succeeded', inputCompacted: true, compactedAt, items: [{ results: [{ id: 'result-1' }] }] });
    expect(again.generation.submit).not.toHaveBeenCalled(); await again.service.dispose();
  });

  it('H6 arms the background compaction when an MCP batch ends and fires it after the grace period', async () => {
    const h = await queueSetup(), a = await h.service.enqueue(imageRequest(mcpKey('timer-a'))); await expectCount(h, 1); h.settle(0); await expectStatus(h, a, 'succeeded');
    const b = await h.service.enqueue(imageRequest(mcpKey('timer-b'))); await expectCount(h, 2); h.settle(1); await expectStatus(h, b, 'succeeded');
    await waitUntil(async () => expect(JSON.parse(await fs.readFile(frozenFile(h.runtimeDir, `${b.batchId}.state.json`), 'utf8')).job.status).toBe('succeeded'), DISK_POLL);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      expect(await h.service.reclaim()).toMatchObject({ compacted: 0 }); // nothing due yet; re-arms the timer under fake time
      vi.advanceTimersByTime(minutes(10) + 1000);
      // Fake setTimeout here: vi.waitFor advances the fake timers on every check.
      await vi.waitFor(() => { expect(h.read(a).inputCompacted).toBe(true); expect(h.read(b).inputCompacted).toBe(true); }, { timeout: 10_000 });
    } finally { vi.useRealTimers(); }
  });

  it('H6 reclaim compacts at most the requested number of due batches and reports capacity', async () => {
    const h = await queueSetup(), batches: BatchJob[] = [];
    for (let index = 0; index < 3; index++) { const batch = await h.service.enqueue(imageRequest(mcpKey(`reclaim-${index}`))); await expectCount(h, index + 1); h.settle(index); await expectStatus(h, batch, 'succeeded'); batches.push(batch); }
    await waitUntil(async () => expect(JSON.parse(await fs.readFile(frozenFile(h.runtimeDir, `${batches[2].batchId}.state.json`), 'utf8')).job.status).toBe('succeeded'), DISK_POLL);
    const before = h.service.capacity()!; expect(before.batches).toBe(3);
    for (const invalid of [0, 9, 1.5]) await expect(h.service.reclaim(invalid)).rejects.toMatchObject({ code: 'invalid_arguments' });
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + minutes(11));
    try {
      const one = await h.service.reclaim(1); expect(one.compacted).toBe(1); expect(one.capacity!.bytes).toBeLessThan(before.bytes - 64 * 1024);
      expect(batches.filter(batch => h.read(batch).inputCompacted)).toHaveLength(1);
      expect((await h.service.reclaim()).compacted).toBe(2); expect((await h.service.reclaim()).compacted).toBe(0);
    } finally { vi.useRealTimers(); }
    expect(batches.every(batch => h.read(batch).inputCompacted)).toBe(true); expect(h.service.capacity()!.batches).toBe(3);
  });

  it('H6 refuses a compacted input owned by an unfinished batch and restores a finished one', async () => {
    const source = await queueSetup({ isBusy: () => true }), batch = await source.service.enqueue(queued()); await source.service.dispose();
    const [record] = await createBatchStorage(source.runtimeDir).load(), { snapshots: _dropped, ...kept } = record.input as any;
    const compactedInput = { ...kept, schemaVersion: 2, compaction: { compactedAt: '2026-10-08T00:00:00.000Z', originalDigest: 'a'.repeat(64), snapshotCount: 1, snapshotBytes: 10, historyFrom: 1, historyAnchor: null }, compactedHash: 'b'.repeat(64) };
    const unfinished = { load: async () => [{ input: compactedInput, job: record.job }], create: vi.fn(), save: vi.fn() };
    const h = setup({ storage: unfinished as any });
    await expect(h.service.ready).rejects.toMatchObject({ code: 'queue_storage_error' });
    await expect(h.service.enqueue(queued({ requestKey: 'later' }))).rejects.toMatchObject({ code: 'queue_storage_error' });
    expect(unfinished.save).not.toHaveBeenCalled(); expect(h.generation.submit).not.toHaveBeenCalled();
    const ended = { ...record.job, status: 'cancelled', cancelRequested: true, finishedAt: '2026-10-08T00:00:00.000Z', items: record.job.items.map(item => ({ ...item, status: 'cancelled' })) } as BatchJob;
    const ok = setup({ storage: { load: async () => [{ input: compactedInput, job: ended }], create: vi.fn(), save: vi.fn() } as any }); await ok.service.ready;
    expect(ok.read(batch)).toMatchObject({ status: 'cancelled', inputCompacted: true, compactedAt: '2026-10-08T00:00:00.000Z' });
  });

  it('keeps queue receipts reconcilable while a compaction cleanup stays busy, and rolls the cleanup forward on restart', async () => {
    const h = await queueSetup(), queue = createQueueRecipeService({ runtimeDir: h.runtimeDir, batch: h.service });
    const recipe = await queue.put_queue_recipe({ preparation: { mode: 't2i', authored: { params: { positivePrompt: 'a paper lantern', negativePrompt: 'text', seed: 7, seedMode: 'fixed', width: 64, height: 64 } }, assets: [] } });
    const args = { requestKey: mcpKey('receipt'), items: [{ recipeId: recipe.recipeId, recipeRevision: recipe.recipeRevision, inputHash: recipe.inputHash, seed: 11 }] };
    const accepted = await queue.enqueue_queue_recipes(args); await expectCount(h, 1); h.settle(0); await expectStatus(h, accepted, 'succeeded'); await h.service.dispose();
    await ageFinishedBatches(h.runtimeDir);
    const receipts = path.join(h.runtimeDir, 'queue-recipes'), receiptBytes = async () => Object.fromEntries(await Promise.all((await fs.readdir(receipts)).filter(name => name.startsWith('request-')).map(async name => [name, await fs.readFile(path.join(receipts, name), 'utf8')])));
    const receiptsBefore = await receiptBytes(); expect(Object.keys(receiptsBefore)).toHaveLength(1);
    const markers = async () => (await fs.readdir(path.join(h.runtimeDir, 'frozen-queue'))).filter(name => /^\.txn-[a-f0-9-]{36}\.json$/.test(name));
    const history = frozenFile(h.runtimeDir, `${accepted.batchId}.states`), originalUnlink = fs.unlink.bind(fs);
    // A Windows indexer or virus scanner holding the superseded history files open.
    vi.spyOn(fs, 'unlink').mockImplementation(async (...unlinkArgs: any[]) => { if (String(unlinkArgs[0]).startsWith(history + path.sep)) throw Object.assign(new Error('simulated busy file'), { code: 'EBUSY' }); return (originalUnlink as any)(...unlinkArgs); });
    const log = vi.fn(), busy = setup({ runtimeDir: h.runtimeDir, isBusy: () => true, log }); await busy.service.ready;
    await waitUntil(() => expect(busy.read(accepted)).toMatchObject({ inputCompacted: true }));
    const queueBusy = createQueueRecipeService({ runtimeDir: h.runtimeDir, batch: busy.service });
    expect(busy.service.lookup({ ...args, workspaceId: 'recipe-queue', expectedRevision: 0, mode: 't2i', count: 1, intervalSeconds: 0, seeds: [11], execution: 'queued' })?.batchId).toBe(accepted.batchId);
    expect(await queueBusy.lookup_queue_request({ requestKey: args.requestKey })).toMatchObject({ status: 'accepted', batch: { batchId: accepted.batchId, status: 'succeeded', inputCompacted: true } });
    expect((await queueBusy.enqueue_queue_recipes(args)).batchId).toBe(accepted.batchId);
    expect(await markers()).toHaveLength(1); expect(log).toHaveBeenCalledTimes(1); expect(String(log.mock.calls[0][0])).toMatch(/EBUSY/);
    expect(await busy.service.reclaim()).toMatchObject({ compacted: 0 }); // nothing else is due; the deferred cleanup does not throw
    vi.restoreAllMocks(); await busy.service.dispose();
    const restarted = setup({ runtimeDir: h.runtimeDir, isBusy: () => true }); await restarted.service.ready;
    const queueAgain = createQueueRecipeService({ runtimeDir: h.runtimeDir, batch: restarted.service });
    expect(await queueAgain.lookup_queue_request({ requestKey: args.requestKey })).toMatchObject({ status: 'accepted', batch: { batchId: accepted.batchId, status: 'succeeded', inputCompacted: true, items: [{ status: 'succeeded', results: [{ id: 'result-1' }] }] } });
    expect((await queueAgain.enqueue_queue_recipes(args)).batchId).toBe(accepted.batchId);
    expect(await fs.readdir(history)).toHaveLength(1); expect(await markers()).toEqual([]);
    expect(await receiptBytes()).toEqual(receiptsBefore); expect(restarted.generation.submit).not.toHaveBeenCalled();
    await restarted.service.dispose();
  });

  it('P2-1 a busy compaction cleanup affects only its own batch: the running batch finishes, new batches enqueue, lookups answer', async () => {
    const h = await queueSetup(), ended = await h.service.enqueue(imageRequest(mcpKey('ended'))); await expectCount(h, 1); h.settle(0); await expectStatus(h, ended, 'succeeded');
    await h.service.dispose();
    const history = frozenFile(h.runtimeDir, `${ended.batchId}.states`), originalUnlink = fs.unlink.bind(fs); let armed = false;
    vi.spyOn(fs, 'unlink').mockImplementation(async (...unlinkArgs: any[]) => { if (armed && String(unlinkArgs[0]).startsWith(history + path.sep)) throw Object.assign(new Error('simulated busy file'), { code: 'EBUSY' }); return (originalUnlink as any)(...unlinkArgs); });
    const log = vi.fn(), r = setup({ runtimeDir: h.runtimeDir, log }); await r.service.ready;
    const runningRequest: Record<string, unknown> = imageRequest(mcpKey('running'), { count: 2, seeds: [1, 2], seedMode: undefined }); delete runningRequest.seedMode;
    const running = await r.service.enqueue(runningRequest); await expectCount(r, 1);
    expect(r.read(running).status).toBe('running');
    // The ended batch becomes due while the other one is mid-flight; its cleanup cannot remove files.
    armed = true; vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + minutes(11));
    let reclaimed; try { reclaimed = await r.service.reclaim(); } finally { vi.useRealTimers(); }
    expect(reclaimed).toMatchObject({ compacted: 0 });
    expect(r.read(ended)).toMatchObject({ inputCompacted: true });
    expect(r.read(running)).toMatchObject({ status: 'running', error: null });
    r.settle(0); await expectCount(r, 2); r.settle(1); await expectStatus(r, running, 'succeeded');
    await expect(r.service.enqueue(queued({ requestKey: 'after-busy-cleanup' }))).resolves.toMatchObject({ status: 'queued' });
    expect(r.service.lookup(runningRequest)?.batchId).toBe(running.batchId);
    expect(log).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks(); await r.service.dispose();
    const again = setup({ runtimeDir: h.runtimeDir, isBusy: () => true }); await again.service.ready;
    expect(again.read(running)).toMatchObject({ status: 'succeeded' }); expect(again.read(ended)).toMatchObject({ inputCompacted: true });
    expect(await fs.readdir(history)).toHaveLength(1); expect((await fs.readdir(path.join(h.runtimeDir, 'frozen-queue'))).filter(name => name.startsWith('.txn-'))).toEqual([]);
    await again.service.dispose();
  });

  it('P3-5 a reclaim waits for at most the compaction in progress, not a whole background round', async () => {
    const h = await queueSetup();
    for (let index = 0; index < 8; index++) { const batch = await h.service.enqueue(queued({ requestKey: mcpKey(`round-${index}`) })); await expectCount(h, index + 1); h.settle(index); await expectStatus(h, batch, 'succeeded'); }
    await h.service.dispose(); await ageFinishedBatches(h.runtimeDir);
    const disk = createBatchStorage(h.runtimeDir); let started!: () => void, finished = 0; const firstStarted = new Promise<void>(resolve => { started = resolve; });
    const storage = { ...disk, compact: async (id: string, options?: { now?: number }) => { started(); await new Promise(resolve => setTimeout(resolve, 40)); try { return await disk.compact!(id, options); } finally { finished++; } } };
    const r = setup({ storage, isBusy: () => true }); await r.service.ready;
    await firstStarted; // the startup background round is under way
    const reclaimed = await r.service.reclaim(1), finishedAtReclaim = finished;
    expect(reclaimed.compacted).toBe(1);
    expect(finishedAtReclaim).toBeLessThanOrEqual(3);
    await waitUntil(() => expect(finished).toBe(8));
    await r.service.dispose();
  });
});

describe('queued i2i/enhance with a random extra-noise seed (CE-7)', () => {
  const noisy = (mode: string, requestKey: string, extra: Record<string, unknown> = {}) => queued({ requestKey, mode, count: 2, snapshot: { ...snapshot(), sourceImage: { mimeType: 'image/png', data: 'fixture-source' }, i2i: { strength: .5, noise: 0, extraNoiseSeed: 0 } }, ...extra });
  const storedInput = async (runtimeDir: string, batchId: string) => JSON.parse(await fs.readFile(path.join(runtimeDir, 'frozen-queue', `${batchId}.input.json`), 'utf8'));
  const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const canonicalJson = (value: any): any => Array.isArray(value) ? value.map(canonicalJson) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonicalJson(value[key])])) : value;

  it.each(['i2i', 'enhance'])('%s: resolves the seed once, freezes it, keeps same-key retries on one batch, and the generation service receives it', async mode => {
    const h = await queueSetup({ isBusy: () => true }), requestKey = `mcp-noise-${mode}`, raw = noisy(mode, requestKey);
    const batch = await h.service.enqueue(raw);
    expect(batch.status).toBe('queued');
    const input = await storedInput(h.runtimeDir, batch.batchId), seed = input.snapshots[0].i2i.extraNoiseSeed;
    expect(seed).toBe(queuedExtraNoiseSeed('origin', requestKey, 0)); expect(seed).toBeGreaterThan(0); expect(seed).toBeLessThanOrEqual(2_147_483_646);
    expect(input.payloadHash).toBe(sha(canonicalJson(input.snapshots))); // payloadHash is the hash of exactly what is frozen
    // Same key, same request (as a caller whose reply was lost would resend): same batch, no conflict, no second batch.
    expect((await h.service.enqueue(structuredClone(raw))).batchId).toBe(batch.batchId);
    expect(h.service.lookup(structuredClone(raw))?.batchId).toBe(batch.batchId);
    expect(h.service.list({ workspaceId: 'origin' }).batches).toHaveLength(1);
    // A different plan under the same key still conflicts.
    await expect(h.service.enqueue(noisy(mode, requestKey, { snapshot: { ...snapshot(), sourceImage: { mimeType: 'image/png', data: 'other-source' }, i2i: { strength: .5, noise: 0, extraNoiseSeed: 0 } } }))).rejects.toMatchObject({ code: 'request_conflict' });
    // The store is healthy: another batch still goes in.
    await expect(h.service.enqueue(queued({ requestKey: `after-${mode}` }))).resolves.toMatchObject({ status: 'queued' });
    await h.service.dispose();
    // Restart: recovered paused, a same-key retry with the original request still matches, and resuming sends the frozen seed.
    const restored = setup({ runtimeDir: h.runtimeDir }); await restored.service.ready;
    expect(restored.read(batch).status).toBe('paused');
    expect(restored.service.lookup(structuredClone(raw))?.batchId).toBe(batch.batchId);
    expect((await restored.service.enqueue(structuredClone(raw))).batchId).toBe(batch.batchId);
    await restored.service.resume({ workspaceId: 'recipe-queue', expectedRevision: 0, batchId: batch.batchId });
    await expectCount(restored, 1); restored.settle(0); await expectCount(restored, 2); restored.settle(1); await expectStatus(restored, batch, 'succeeded');
    expect(restored.accepted.map(item => item.snapshot.i2i?.extraNoiseSeed)).toEqual([seed, seed]);
    expect(restored.accepted.map(item => item.snapshot.params.seed)).toEqual(h.read(batch).items.map(item => item.plannedSeed));
    await restored.service.dispose();
  });

  it('per-item recipes each get their own derived seed; a fixed seed is kept; the derivation follows the request identity', async () => {
    const h = await queueSetup(), requestKey = 'mcp-noise-per-item';
    const items = [0, 0, 77].map((extraNoiseSeed, index) => ({ ...snapshot(), params: { ...snapshot().params, positivePrompt: `room ${index}` }, sourceImage: { mimeType: 'image/png', data: `source-${index}` }, i2i: { strength: .5, noise: 0, extraNoiseSeed } }));
    const raw: Record<string, unknown> = queued({ requestKey, mode: 'i2i', count: 3, snapshot: undefined, snapshots: items, seeds: [1, 2, 3], seedMode: undefined }); delete raw.seedMode;
    const batch = await h.service.enqueue(raw), stored = (await storedInput(h.runtimeDir, batch.batchId)).snapshots.map((value: any) => value.i2i.extraNoiseSeed);
    expect(stored).toEqual([queuedExtraNoiseSeed('origin', requestKey, 0), queuedExtraNoiseSeed('origin', requestKey, 1), 77]);
    expect(new Set(stored).size).toBe(3);
    for (let index = 0; index < 3; index++) { await expectCount(h, index + 1); h.settle(index); }
    await expectStatus(h, batch, 'succeeded');
    expect(h.accepted.map(item => item.snapshot.i2i?.extraNoiseSeed)).toEqual(stored);
    expect(queuedExtraNoiseSeed('origin', 'mcp-other-key', 0)).not.toBe(stored[0]);
    expect(queuedExtraNoiseSeed('other-workspace', requestKey, 0)).not.toBe(stored[0]);
  });

  it.each(['i2i', 'enhance'])('freezes source bytes, Mask and the derived %s noise seed of one recipe across every child', async (mode) => {
    const input = queued({ mode, count: 2, snapshot: { ...snapshot(), sourceImage: { mimeType: 'image/png', data: 'immutable-source-bytes' }, i2i: { strength: .5, noise: 0, extraNoiseSeed: 0 }, inpaint: { model: 'nai-diffusion-5-full-inpainting', maskBase64: 'immutable-mask', strength: .5, noise: 0 } } });
    const h = await queueSetup(), batch = await h.service.enqueue(input);
    (input.snapshot as any).sourceImage.data = 'later source';
    for (let index = 0; index < 2; index++) { await expectCount(h, index + 1); h.settle(index); }
    await expectStatus(h, batch, 'succeeded');
    expect(h.accepted[0].snapshot.sourceImage).toEqual(h.accepted[1].snapshot.sourceImage);
    expect(h.accepted[0].snapshot.sourceImage?.data).toBe('immutable-source-bytes');
    expect(h.accepted[0].snapshot.inpaint?.maskBase64).toBe('immutable-mask');
    expect(h.accepted[0].snapshot.i2i?.extraNoiseSeed).toBe(queuedExtraNoiseSeed('origin', 'teacup-study', 0));
    expect(h.accepted[0].snapshot.i2i).toEqual(h.accepted[1].snapshot.i2i);
  });

  it('a frozen input that fails the storage self-check is refused alone; the store and other batches keep working', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-input-check-')), disk = createBatchStorage(runtimeDir);
    let corrupt = false;
    const storage = { ...disk, create: (input: any) => disk.create(corrupt ? { ...input, payloadHash: 'f'.repeat(64) } : input) };
    cleanups.push(() => fs.rm(runtimeDir, { recursive: true, force: true })); // removed after the service's dispose
    const h = setup({ storage, isBusy: () => true });
    await h.service.ready;
    const first = await h.service.enqueue(queued({ requestKey: 'kept' }));
    corrupt = true;
    await expect(h.service.enqueue(queued({ requestKey: 'inconsistent' }))).rejects.toMatchObject({ code: 'invalid_arguments' });
    expect(h.service.lookup(queued({ requestKey: 'inconsistent' }))).toBeNull();
    corrupt = false;
    await expect(h.service.enqueue(queued({ requestKey: 'after' }))).resolves.toMatchObject({ status: 'queued' });
    expect(h.read(first)).toMatchObject({ status: 'queued', error: null });
    expect(h.service.capacity()).toMatchObject({ batches: 2 });
    expect(BatchInputError).toBeDefined();
  });

  it('end to end through the recipe service: a random-noise i2i recipe enqueues, retries under the same key and survives a restart', async () => {
    const h = await queueSetup({ isBusy: () => true });
    const recipes = createQueueRecipeService({ runtimeDir: h.runtimeDir, batch: h.service, randomSeed: () => 97 });
    const image = new PNG({ width: 64, height: 64 }); image.data.fill(180); const png = PNG.sync.write(image).toString('base64');
    const saved = await recipes.put_queue_recipe({ preparation: { mode: 'i2i', authored: { params: { positivePrompt: 'room', seed: 4, seedMode: 'fixed', width: 64, height: 64 }, i2iParams: { strength: .5, noise: 0 } }, assets: [{ role: 'source', mimeType: 'image/png', data: png }] } });
    expect(saved.snapshot.reviewInput.readiness).toEqual({ status: 'ready', issues: [] });
    const plan = { requestKey: 'mcp-recipe-noise', items: [{ recipeId: saved.recipeId, recipeRevision: 1, inputHash: saved.inputHash, seed: 5 }] };
    const job = await recipes.enqueue_queue_recipes(plan);
    expect((await recipes.enqueue_queue_recipes(plan)).batchId).toBe(job.batchId);
    expect((await recipes.lookup_queue_request({ requestKey: plan.requestKey })).status).toBe('accepted');
    const seed = (await storedInput(h.runtimeDir, job.batchId)).snapshots[0].i2i.extraNoiseSeed;
    expect(seed).toBe(queuedExtraNoiseSeed('recipe-queue', plan.requestKey, 0));
    await h.service.dispose();
    const restored = setup({ runtimeDir: h.runtimeDir, isBusy: () => true }); await restored.service.ready;
    const again = createQueueRecipeService({ runtimeDir: h.runtimeDir, batch: restored.service, randomSeed: () => 97 });
    expect((await again.enqueue_queue_recipes(plan)).batchId).toBe(job.batchId);
    expect(restored.read(job).status).toBe('paused');
    await restored.service.dispose();
  });
});

describe('review round 3: deferred compactions affect only their own batch', () => {
  it('P2-b a busy input replacement defers only that batch: reclaim does not throw, the running batch continues, other batches compact, and the deferred one is retried after a backoff', async () => {
    const h = await queueSetup(), a = await h.service.enqueue(imageRequest(mcpKey('busy-input'))); await expectCount(h, 1); h.settle(0); await expectStatus(h, a, 'succeeded');
    const b = await h.service.enqueue(imageRequest(mcpKey('free-input'))); await expectCount(h, 2); h.settle(1); await expectStatus(h, b, 'succeeded');
    await h.service.dispose(); await ageFinishedBatches(h.runtimeDir);
    const inputA = frozenFile(h.runtimeDir, `${a.batchId}.input.json`), originalRename = fs.rename.bind(fs); let busy = true;
    vi.spyOn(fs, 'rename').mockImplementation(async (...args: any[]) => { if (busy && String(args[1]) === inputA) throw Object.assign(new Error('input held open'), { code: 'EBUSY' }); return (originalRename as any)(...args); });
    const log = vi.fn(), r = setup({ runtimeDir: h.runtimeDir, log }); await r.service.ready;
    await waitUntil(() => expect(r.read(b)).toMatchObject({ inputCompacted: true }));
    expect(r.read(a)).not.toHaveProperty('inputCompacted');
    expect(log).toHaveBeenCalledTimes(1); expect(String(log.mock.calls[0][0])).toContain(a.batchId);
    const runningRequest: Record<string, unknown> = imageRequest(mcpKey('running-round3'), { count: 2, seeds: [1, 2], seedMode: undefined }); delete runningRequest.seedMode;
    const running = await r.service.enqueue(runningRequest); await expectCount(r, 1);
    expect(await r.service.reclaim()).toMatchObject({ compacted: 0 }); // the deferred batch is backing off; nothing else is due
    expect(r.read(running)).toMatchObject({ status: 'running', error: null });
    r.settle(0); await expectCount(r, 2); r.settle(1); await expectStatus(r, running, 'succeeded');
    await expect(r.service.enqueue(queued({ requestKey: 'after-busy-input' }))).resolves.toMatchObject({ status: 'queued' });
    busy = false;
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + minutes(2));
    let retried; try { retried = await r.service.reclaim(); } finally { vi.useRealTimers(); }
    expect(retried).toMatchObject({ compacted: 1 }); expect(r.read(a)).toMatchObject({ inputCompacted: true });
    expect((await fs.readdir(path.join(h.runtimeDir, 'frozen-queue'))).filter(name => name.startsWith('.txn-'))).toEqual([]);
    vi.restoreAllMocks(); await r.service.dispose();
  });

  it('P3-b after a deferred cleanup, compaction goes on: once the files are free, reclaim compacts another batch that became due', async () => {
    const h = await queueSetup(), a = await h.service.enqueue(imageRequest(mcpKey('busy-history'))); await expectCount(h, 1); h.settle(0); await expectStatus(h, a, 'succeeded');
    await h.service.dispose(); await ageFinishedBatches(h.runtimeDir);
    const history = frozenFile(h.runtimeDir, `${a.batchId}.states`), originalUnlink = fs.unlink.bind(fs); let busy = true;
    vi.spyOn(fs, 'unlink').mockImplementation(async (...args: any[]) => { if (busy && String(args[0]).startsWith(history + path.sep)) throw Object.assign(new Error('history held open'), { code: 'EBUSY' }); return (originalUnlink as any)(...args); });
    const log = vi.fn(), r = setup({ runtimeDir: h.runtimeDir, log }); await r.service.ready;
    await waitUntil(() => expect(r.read(a)).toMatchObject({ inputCompacted: true })); // published; only the cleanup was deferred
    expect(log).toHaveBeenCalledTimes(1);
    const c = await r.service.enqueue(imageRequest(mcpKey('later'))); await expectCount(r, 1); r.settle(0); await expectStatus(r, c, 'succeeded');
    busy = false;
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + minutes(11));
    let reclaimed; try { reclaimed = await r.service.reclaim(); } finally { vi.useRealTimers(); }
    expect(reclaimed).toMatchObject({ compacted: 1 }); expect(r.read(c)).toMatchObject({ inputCompacted: true });
    expect(await fs.readdir(history)).toHaveLength(1); // the deferred cleanup was rolled forward on the way
    expect((await fs.readdir(path.join(h.runtimeDir, 'frozen-queue'))).filter(name => name.startsWith('.txn-'))).toEqual([]);
    vi.restoreAllMocks(); await r.service.dispose();
  });
});


describe('a frozen-queue folder holding an entry the app does not use', () => {
  it('stops the queue naming the entry (also in the log), and works again after it is removed and the app restarts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-frozen-stray-')); cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const runtimeDir = path.join(root, 'runtime'), stray = path.join(runtimeDir, 'frozen-queue', 'notes.txt');
    await fs.mkdir(path.dirname(stray), { recursive: true }); await fs.writeFile(stray, 'mine');
    await fs.writeFile(path.join(runtimeDir, 'frozen-queue', '.DS_Store'), 'finder');
    const log = vi.fn(), h = setup({ runtimeDir, log });
    // The window names the entry in its own language (reason queue.stray_entry with the entry, step 4a).
    const refusal = { code: 'queue_storage_error', message: expect.stringContaining('runtime/frozen-queue/notes.txt'), reason: 'queue.stray_entry', params: { entry: 'runtime/frozen-queue/notes.txt' } };
    await expect(h.service.ready).rejects.toMatchObject(refusal);
    await expect(h.service.enqueue(queued({ requestKey: 'while-stray' }))).rejects.toMatchObject(refusal);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/runtime\/frozen-queue\/notes\.txt.*restart the app/));
    expect(await fs.readFile(stray, 'utf8')).toBe('mine');
    await fs.rm(stray);
    const restarted = setup({ runtimeDir, log }); await restarted.service.ready;
    expect((await restarted.service.enqueue(queued({ requestKey: 'after-removal' }))).status).toBe('queued');
    expect(await fs.readFile(path.join(runtimeDir, 'frozen-queue', '.DS_Store'), 'utf8')).toBe('finder');
  });
});

describe('batch source (step 4a)', () => {
  it('keeps the enqueuing agent on the durable batch through a restart; a batch stored before the field has none', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-frozen-source-'));
    cleanups.push(() => fs.rm(runtimeDir, { recursive: true, force: true }));
    // Busy: nothing is submitted, so both batches stay unstarted until the restart.
    const first = setup({ runtimeDir, isBusy: () => true }); await first.service.ready;
    const source = { kind: 'agent' as const, client: { name: 'claude-code', version: '2.1.112' } };
    const named = await first.service.enqueue(queued({ requestKey: 'mcp-named', source }));
    const plain = await first.service.enqueue(queued({ requestKey: 'mcp-plain' }));
    expect(named.source).toEqual(source);
    expect(plain).not.toHaveProperty('source');
    // The same key from another client is the same batch, still naming the first client.
    const repeat = await first.service.enqueue(queued({ requestKey: 'mcp-named', source: { kind: 'agent', client: { name: 'pi', version: '1.5.0' } } }));
    expect(repeat.batchId).toBe(named.batchId); expect(repeat.source).toEqual(source);
    await first.service.dispose();
    const second = setup({ runtimeDir, isBusy: () => true }); await second.service.ready;
    expect(second.read(named).source).toEqual(source);
    expect(second.read(plain)).not.toHaveProperty('source');
    await expect(second.service.enqueue(queued({ requestKey: 'mcp-bad', source: { kind: 'agent', client: { name: 'x'.repeat(101), version: null } } }))).rejects.toMatchObject({ code: 'invalid_arguments' });
    await expect(second.service.enqueue(queued({ requestKey: 'mcp-bad-kind', source: { kind: 'manual', persistent: false } }))).rejects.toMatchObject({ code: 'invalid_arguments' });
  });

  it('an agent enqueue through the recipe service names its client on the batch, never in the receipt', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-recipe-source-'));
    cleanups.push(() => fs.rm(runtimeDir, { recursive: true, force: true }));
    const h = setup({ runtimeDir, isBusy: () => true }); await h.service.ready;
    const queue = createQueueRecipeService({ runtimeDir, batch: h.service, recipeReclaim: { auto: false } });
    const recipe = await queue.put_queue_recipe({ preparation: { mode: 't2i', authored: { params: { positivePrompt: 'teacup', seed: 5, seedMode: 'fixed', width: 64, height: 64 } }, assets: [] } });
    const source = { kind: 'agent' as const, client: { name: 'codex-mcp-client', version: '0.50.0' } };
    const batch = await queue.enqueue_queue_recipes({ requestKey: 'mcp-source-key', items: [{ recipeId: recipe.recipeId, recipeRevision: 1, inputHash: recipe.inputHash }] }, { source });
    expect(batch.source).toEqual(source);
    const receipts = (await fs.readdir(path.join(runtimeDir, 'queue-recipes'))).filter(name => name.startsWith('request-'));
    expect(receipts).toHaveLength(1);
    expect(await fs.readFile(path.join(runtimeDir, 'queue-recipes', receipts[0]), 'utf8')).not.toContain('codex-mcp-client');
    expect((await queue.list_queue({})).batches.map((value: any) => value.source)).toEqual([source]);
  });
});

describe('the shared FIFO with manual batches (step 4a)', () => {
  const manual = (extra: Record<string, unknown> = {}) => ({ ...queued({ workspaceId: 'recipe-queue', expectedRevision: 0, requestKey: `manual-${Math.random().toString(36).slice(2, 10)}`, seedMode: undefined, seeds: [5], ...extra }) });
  const plain = (value: Record<string, unknown>) => { const copy = { ...value }; delete copy.seedMode; return copy; };

  it('a paused batch at the head does not hold up the batches behind it; resumed, it runs next', async () => {
    const h = await queueSetup();
    const a = await h.service.enqueue(queued({ requestKey: 'mcp-a', count: 2 }));
    await expectCount(h, 1);
    await h.service.pause(h.args(a));
    const b = await h.service.enqueue(queued({ requestKey: 'mcp-b' }));
    h.settle(0); await expectStatus(h, a, 'paused');
    // b runs although a is paused ahead of it.
    await expectCount(h, 2); expect(h.accepted[1].request.requestKey).toBe(`batch-${b.batchId}-0`);
    await h.service.resume({ ...h.args(a), expectedRevision: 7 });
    h.settle(1); await expectStatus(h, b, 'succeeded');
    await expectCount(h, 3); expect(h.accepted[2].request.requestKey).toBe(`batch-${a.batchId}-1`);
    h.settle(2); await expectStatus(h, a, 'succeeded');
  });

  it('a manual failure halts nothing: an agent batch queued after it runs at once', async () => {
    const h = await queueSetup();
    const click = await h.service.enqueueManual(plain(manual()));
    await expectCount(h, 1); h.settle(0, 'failed');
    await expectStatus(h, click, 'blocked');
    const agent = await h.service.enqueue(queued({ requestKey: 'mcp-after-manual' }));
    expect(agent.status).toBe('queued');
    await expectCount(h, 2); h.settle(1); await expectStatus(h, agent, 'succeeded');
  });

  it('an agent failure still pauses the agent batches after it; a manual click runs anyway and its failure halts nothing', async () => {
    const h = await queueSetup();
    const failing = await h.service.enqueue(queued({ requestKey: 'mcp-fails' }));
    const follower = await h.service.enqueue(queued({ requestKey: 'mcp-follower' }));
    await expectCount(h, 1); h.settle(0, 'unknown');
    await expectStatus(h, failing, 'blocked');
    await waitUntil(() => expect(h.read(follower)).toMatchObject({ status: 'paused', error: { code: 'queue_halted' } }));
    const click = await h.service.enqueueManual(plain(manual({ count: 2, seeds: [5, 6] })));
    expect(click.source).toEqual({ kind: 'manual', persistent: false });
    expect(click.status).toBe('queued');
    // The manual batch runs; an image whose outcome is unknown does not stop it (as the window's generation did).
    await expectCount(h, 2); h.settle(1, 'unknown');
    await expectCount(h, 3); h.settle(2);
    await expectStatus(h, click, 'blocked');
    expect(h.read(click).items.map(item => item.status)).toEqual(['unknown', 'succeeded']);
    // A new agent batch is saved paused while the queue is halted; a refused manual image halts nothing either.
    const later = await h.service.enqueue(queued({ requestKey: 'mcp-later' }));
    expect(later.status).toBe('paused');
    const refused = await h.service.enqueueManual(plain(manual()));
    await expectCount(h, 4); h.settle(3, 'failed');
    await expectStatus(h, refused, 'blocked');
    expect(h.read(follower).status).toBe('paused');
    expect(vi.mocked(h.generation.submit).mock.calls.slice(1).every(([args]) => (args as any).manual === true)).toBe(true);
  });

  it('resuming a manual batch leaves the halt after an agent failure in place; resuming an agent batch lifts it', async () => {
    const h = await queueSetup();
    const failing = await h.service.enqueue(queued({ requestKey: 'mcp-unknown' }));
    const halted = await h.service.enqueue(queued({ requestKey: 'mcp-halted' }));
    await expectCount(h, 1); h.settle(0, 'unknown');
    await expectStatus(h, failing, 'blocked');
    await waitUntil(() => expect(h.read(halted)).toMatchObject({ status: 'paused', error: { code: 'queue_halted' } }));
    // The user pauses and resumes a manual click meanwhile.
    const click = await h.service.enqueueManual(plain(manual({ count: 2, seeds: [5, 6] })));
    await expectCount(h, 2);
    await h.service.pause({ workspaceId: 'recipe-queue', batchId: click.batchId });
    h.settle(1); await expectStatus(h, click, 'paused');
    await h.service.resume({ workspaceId: 'recipe-queue', batchId: click.batchId, expectedRevision: 0 });
    await expectCount(h, 3); h.settle(2); await expectStatus(h, click, 'succeeded');
    // A new agent batch is still saved paused; nothing of it was submitted.
    const after = await h.service.enqueue(queued({ requestKey: 'mcp-after-manual-resume' }));
    expect(after).toMatchObject({ status: 'paused', error: { code: 'queue_halted' } });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(h.accepted).toHaveLength(3);
    expect(h.read(halted).status).toBe('paused');
    // Resuming an agent batch is the agent-side confirmation: it runs, and the next agent batch is not halted.
    await h.service.resume({ ...h.args(halted), expectedRevision: 7 });
    await expectCount(h, 4); h.settle(3); await expectStatus(h, halted, 'succeeded');
    const next = await h.service.enqueue(queued({ requestKey: 'mcp-after-agent-resume' }));
    expect(next.status).toBe('queued');
    await expectCount(h, 5); h.settle(4); await expectStatus(h, next, 'succeeded');
  });

  it('a frozen-queue storage failure stops the agent side; manual batches keep running, pausing, resuming and cancelling', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-queue-manual-decoupled-'));
    cleanups.push(() => fs.rm(runtimeDir, { recursive: true, force: true }));
    const disk = createBatchStorage(runtimeDir); let broken = false;
    const h = setup({ storage: { ...disk, save: async (id, job) => { if (broken) throw new Error('disk gone'); return disk.save(id, job); } } });
    cleanups.push(() => h.service.dispose()); await h.service.ready;
    const agent = await h.service.enqueue(queued({ workspaceId: 'recipe-queue', expectedRevision: 0, requestKey: 'mcp-before-failure', count: 2 }));
    await expectCount(h, 1);
    broken = true; h.settle(0);
    await waitUntil(() => expect(h.read(agent).error?.code).toBe('queue_storage_error'));
    await expect(h.service.enqueue(queued({ workspaceId: 'recipe-queue', expectedRevision: 0, requestKey: 'mcp-after-failure' }))).rejects.toMatchObject({ code: 'queue_storage_error' });
    const click = await h.service.enqueueManual(plain(manual({ count: 2, seeds: [5, 6] })));
    await expectCount(h, 2); h.settle(1); await expectCount(h, 3); h.settle(2);
    await expectStatus(h, click, 'succeeded');
    const second = await h.service.enqueueManual(plain(manual({ count: 3, seeds: [7, 8, 9] })));
    await expectCount(h, 4);
    await h.service.pause({ workspaceId: 'recipe-queue', batchId: second.batchId });
    h.settle(3); await expectStatus(h, second, 'paused');
    await h.service.resume({ workspaceId: 'recipe-queue', batchId: second.batchId, expectedRevision: 0 });
    await expectCount(h, 5);
    await h.service.cancel({ workspaceId: 'recipe-queue', batchId: second.batchId });
    h.settle(4, 'cancelled'); await expectStatus(h, second, 'cancelled');
    // The agent batch never submitted its second image.
    expect(h.accepted.map(value => value.request.requestKey).filter(key => key.startsWith(`batch-${agent.batchId}`))).toEqual([`batch-${agent.batchId}-0`]);
    expect(['paused', 'pausing']).toContain(h.read(agent).status);
  });

  it('a large batch pushes its progress at most every 250 ms and its changes of status at once; a small one every event', async () => {
    const events: BatchJob[] = [];
    const generation = createGenerationService({ validateImage: () => ({ width: 64, height: 64 }), async execute(_mode, frozen, execution) {
      const index = execution.queueOrigin!.itemIndex;
      return { ok: true, message: 'saved', actualSeed: frozen.params.seed, items: [{ id: `history-${index}`, filePath: `/fixture/${index}.png`, fileUrl: `nai-media://fixture/${index}.png`, date: '2026-11-03', createdAt: '2026-11-03T10:00:00Z', params: frozen.params, actualSeed: frozen.params.seed, model: frozen.params.model, width: 64, height: 64 }] };
    } });
    const service = createBatchService({ generation, onBatch: batch => events.push(batch), wait: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2))) });
    cleanups.push(() => service.dispose());
    const large = await service.enqueueManual(plain(manual({ requestKey: 'manual-large-events', count: 300, seeds: Array.from({ length: 300 }, (_, index) => index + 1) })));
    await waitUntil(() => expect(service.read({ workspaceId: 'recipe-queue', batchId: large.batchId }).status).toBe('succeeded'), { timeout: 30_000 });
    const of = (batchId: string) => events.filter(event => event.batchId === batchId);
    const largeEvents = of(large.batchId);
    // About five events per image unthrottled; throttled, a handful per quarter second.
    expect(largeEvents.length).toBeLessThan(300);
    expect(largeEvents.at(-1)).toMatchObject({ status: 'succeeded' });
    expect(largeEvents.at(-1)!.items.every(item => item.status === 'succeeded')).toBe(true);
    expect(largeEvents.map(event => event.updatedAt)).toEqual([...largeEvents.map(event => event.updatedAt)].sort());
    expect(largeEvents.map(event => event.status).filter((status, index, all) => status !== all[index - 1])).toEqual(['queued', 'running', 'succeeded']);
    const small = await service.enqueueManual(plain(manual({ requestKey: 'manual-small-events', count: 3, seeds: [1, 2, 3] })));
    await waitUntil(() => expect(service.read({ workspaceId: 'recipe-queue', batchId: small.batchId }).status).toBe('succeeded'));
    expect(of(small.batchId).length).toBeGreaterThanOrEqual(3 * 4);
  }, 60_000);

  it('a manual batch takes up to 999 images and NovelAI\'s whole seed range, is never stored, and its requestKey always names the same batch', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-frozen-manual-'));
    cleanups.push(() => fs.rm(runtimeDir, { recursive: true, force: true }));
    // The real generation service runs every image (a fake request answers at once): its queue origin takes every item
    // index of a manual batch (0 … 998), not only the first 20.
    let busy = true; const executed: number[] = [];
    const generation = createGenerationService({ validateImage: () => ({ width: 64, height: 64 }), async execute(_mode, frozen, execution) {
      executed.push(execution.queueOrigin!.itemIndex);
      const seed = frozen.params.seed, index = execution.queueOrigin!.itemIndex;
      return { ok: true, message: 'saved', actualSeed: seed, items: [{ id: `history-${index}`, filePath: `/fixture/${index}.png`, fileUrl: `nai-media://fixture/${index}.png`, date: '2026-11-03', createdAt: '2026-11-03T10:00:00Z', params: frozen.params, actualSeed: seed, model: frozen.params.model, width: 64, height: 64 }] };
    } });
    const service = createBatchService({ generation, runtimeDir, isBusy: () => busy, wait: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2))) });
    cleanups.push(() => service.dispose()); await service.ready;
    const seeds = Array.from({ length: 999 }, (_, index) => 4_000_000_000 + index);
    const waiting = await service.enqueueManual(plain(manual({ requestKey: 'manual-wait-0001', count: 999, seeds, intervalSeconds: 3600 })));
    expect(waiting).toMatchObject({ count: 999, intervalSeconds: 3600 });
    // The same key with other (random) seeds is the same click: the same batch.
    const again = await service.enqueueManual(plain(manual({ requestKey: 'manual-wait-0001', count: 999, seeds: seeds.map(seed => seed + 1), intervalSeconds: 3600 })));
    expect(again.batchId).toBe(waiting.batchId);
    expect(service.lookupManual('recipe-queue', 'manual-wait-0001')?.batchId).toBe(waiting.batchId);
    expect(service.itemsAhead()).toBe(999);
    await expect(service.enqueueManual(plain(manual({ requestKey: 'manual-too-many', count: 1000, seeds: Array(1000).fill(1) })))).rejects.toMatchObject({ code: 'invalid_arguments' });
    // The agent limits do not count it, and nothing of it is on disk.
    expect(service.queueAdmission().pendingItems).toBe(0);
    await service.cancel({ workspaceId: 'recipe-queue', batchId: waiting.batchId });
    const big = await service.enqueueManual(plain(manual({ requestKey: 'manual-big-0001', count: 999, seeds, intervalSeconds: 0 })));
    busy = false;
    await waitUntil(() => expect(service.read({ workspaceId: 'recipe-queue', batchId: big.batchId }).status).toBe('succeeded'), { timeout: 60_000 });
    const done = service.read({ workspaceId: 'recipe-queue', batchId: big.batchId });
    expect(executed).toEqual(Array.from({ length: 999 }, (_, index) => index));
    expect(done.items.every(item => item.status === 'succeeded' && item.error === null)).toBe(true);
    expect(done.items.map(item => item.actualSeed)).toEqual(seeds);
    expect(service.read({ workspaceId: 'recipe-queue', batchId: waiting.batchId }).status).toBe('cancelled');
    const stored = JSON.stringify(await fs.readdir(runtimeDir, { recursive: true }));
    expect(stored).not.toContain(big.batchId); expect(stored).not.toContain(waiting.batchId);
    await service.dispose();
    const restarted = setup({ runtimeDir }); await restarted.service.ready;
    expect(restarted.service.list({ workspaceId: 'recipe-queue' }).batches).toEqual([]);
  }, 90_000);

  it('an agent batch past 20 images runs every item through the real generation service; 200 is the most one batch holds', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-frozen-agent-200-'));
    cleanups.push(() => fs.rm(runtimeDir, { recursive: true, force: true }));
    const executed: number[] = [];
    const generation = createGenerationService({ validateImage: () => ({ width: 64, height: 64 }), async execute(_mode, frozen, execution) {
      const index = execution.queueOrigin!.itemIndex; executed.push(index);
      return { ok: true, message: 'saved', actualSeed: frozen.params.seed, items: [{ id: `history-${index}`, filePath: `/fixture/${index}.png`, fileUrl: `nai-media://fixture/${index}.png`, date: '2026-11-03', createdAt: '2026-11-03T10:00:00Z', params: frozen.params, actualSeed: frozen.params.seed, model: frozen.params.model, width: 64, height: 64 }] };
    } });
    const service = createBatchService({ generation, runtimeDir, wait: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2))) });
    cleanups.push(() => service.dispose()); await service.ready;
    const agent = await service.enqueue(queued({ workspaceId: 'recipe-queue', expectedRevision: 0, requestKey: 'mcp-twenty-five', count: 25, seedMode: 'increment' }));
    await waitUntil(() => expect(service.read({ workspaceId: 'recipe-queue', batchId: agent.batchId }).status).toBe('succeeded'), { timeout: 60_000 });
    expect(executed).toEqual(Array.from({ length: 25 }, (_, index) => index));
    await expect(service.enqueue(queued({ workspaceId: 'recipe-queue', expectedRevision: 0, requestKey: 'mcp-two-hundred-one', count: 201, seedMode: 'increment' }))).rejects.toMatchObject({ code: 'invalid_arguments' });
  }, 90_000);
});

describe('frozen-queue state writes (queue retention rework: what is written at once, what is merged)', () => {
  /** A storage that records every saved job (one per state revision after the first). */
  async function recordingSetup(extra: Partial<BatchDependencies> = {}) {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-state-writes-'));
    cleanups.push(() => fs.rm(runtimeDir, { recursive: true, force: true }));
    const disk = createBatchStorage(runtimeDir), saved: BatchJob[] = [];
    const storage = { ...disk, save: async (id: string, job: BatchJob) => { await disk.save(id, job); saved.push(structuredClone(job)); } };
    const h = setup({ storage, ...extra }); await h.service.ready;
    return { ...h, runtimeDir, saved };
  }
  const stateOnDisk = async (runtimeDir: string, batchId: string) => JSON.parse(await fs.readFile(path.join(runtimeDir, 'frozen-queue', `${batchId}.state.json`), 'utf8')).job as BatchJob;
  const copyRuntime = async (runtimeDir: string) => { const copy = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-state-writes-copy-')); cleanups.push(() => fs.rm(copy, { recursive: true, force: true })); await fs.cp(runtimeDir, copy, { recursive: true, filter: source => !path.basename(source).startsWith('.quota.lock') }); return copy; };

  it('writes each image twice — its possibly-sent mark before the request and its settled outcome — and merges the progress between them', async () => {
    const h = await recordingSetup({ stateFlushMs: 60_000 });
    const batch = await h.service.enqueue(queued({ count: 3, seedMode: 'increment' }));
    for (let index = 0; index < 3; index++) { await expectCount(h, index + 1); await waitUntil(() => expect(h.read(batch).items[index].status).toBe('running')); h.settle(index); }
    await expectStatus(h, batch, 'succeeded');
    await waitUntil(() => expect(h.saved.at(-1)?.status).toBe('succeeded'));
    // 2 per image (possibly sent, settled) and the ending; the running job ID and the gap between images are merged.
    expect(h.saved.map(job => `${job.status}:${job.activeIndex}:${job.items.map(item => item.status[0] + item.providerOutcome![0]).join('')}`)).toHaveLength(7);
    for (let index = 0; index < 3; index++) {
      expect(h.saved[2 * index].items[index]).toMatchObject({ status: 'submitting', providerOutcome: 'unknown', jobId: null });
      expect(h.saved[2 * index].activeIndex).toBe(index);
      expect(h.saved[2 * index + 1].items[index]).toMatchObject({ status: 'succeeded', providerOutcome: 'response_received', jobId: `child-${index + 1}` });
    }
    expect(h.saved[6]).toMatchObject({ status: 'succeeded', activeIndex: null, activeJobId: null });
    expect(await fs.readdir(path.join(h.runtimeDir, 'frozen-queue', `${batch.batchId}.states`))).toHaveLength(8);
  });

  it('the possibly-sent mark is on disk before every request; the submit never runs before that write', async () => {
    const h = await recordingSetup({ stateFlushMs: 60_000 });
    const submit = vi.mocked(h.generation.submit), original = submit.getMockImplementation()!;
    const onDisk: BatchJob[] = [];
    submit.mockImplementation((args: any) => { onDisk.push(JSON.parse(readFileSync(path.join(h.runtimeDir, 'frozen-queue', `${args.queue.batchId}.state.json`), 'utf8')).job); return original(args); });
    const batch = await h.service.enqueue(queued({ count: 2, seedMode: 'increment' }));
    await expectCount(h, 1); h.settle(0); await expectCount(h, 2); h.settle(1); await expectStatus(h, batch, 'succeeded');
    expect(onDisk.map(job => job.items.map(item => `${item.status}/${item.providerOutcome}`))).toEqual([
      ['submitting/unknown', 'pending/not_submitted'], ['succeeded/response_received', 'submitting/unknown']]);
  });

  it('writes the running image\'s progress after the flush delay when it runs long', async () => {
    const h = await recordingSetup({ stateFlushMs: 30 });
    const batch = await h.service.enqueue(queued());
    await expectCount(h, 1);
    await waitUntil(async () => expect((await stateOnDisk(h.runtimeDir, batch.batchId)).items[0]).toMatchObject({ status: 'running', jobId: 'child-1', providerOutcome: 'unknown' }), DISK_POLL);
    h.settle(0); await expectStatus(h, batch, 'succeeded');
    await waitUntil(async () => expect((await stateOnDisk(h.runtimeDir, batch.batchId)).status).toBe('succeeded'), DISK_POLL);
  });

  it('a crash while the image runs (its progress not yet written) restores it as unknown and never resends it', async () => {
    const h = await recordingSetup({ stateFlushMs: 60_000 });
    const batch = await h.service.enqueue(queued({ count: 2, seedMode: 'increment' }));
    await expectCount(h, 1); await waitUntil(() => expect(h.read(batch).items[0]).toMatchObject({ status: 'running', jobId: 'child-1' }));
    expect((await stateOnDisk(h.runtimeDir, batch.batchId)).items[0]).toMatchObject({ status: 'submitting', providerOutcome: 'unknown' });
    const copy = await copyRuntime(h.runtimeDir);
    const restored = setup({ runtimeDir: copy }); await restored.service.ready; cleanups.push(restored.service.dispose);
    expect(restored.read(batch)).toMatchObject({ status: 'blocked', error: { code: 'restart_unconfirmed' } });
    expect(restored.read(batch).items.map(item => `${item.status}/${item.providerOutcome}`)).toEqual(['unknown/unknown', 'skipped/not_submitted']);
    await expect(restored.service.resume({ ...restored.args(batch), expectedRevision: 0 })).rejects.toMatchObject({ code: 'batch_not_paused' });
    expect(restored.generation.submit).not.toHaveBeenCalled();
  });

  it('a start of the app (also one by an agent\'s MCP server) never submits a recovered batch: it stays paused until an explicit resume', async () => {
    const h = await queueSetup({ isBusy: () => true });
    const batch = await h.service.enqueue(queued({ count: 2 })); await h.service.dispose();
    expect(h.generation.submit).not.toHaveBeenCalled();
    // The next start: nothing else is generating, so a queued batch would run at once.
    const restored = setup({ runtimeDir: h.runtimeDir, isBusy: () => false }); await restored.service.ready; cleanups.push(restored.service.dispose);
    expect(restored.read(batch)).toMatchObject({ status: 'paused', error: { code: 'recovered_paused' } });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(restored.generation.submit).not.toHaveBeenCalled();
    expect(restored.read(batch).status).toBe('paused');
  });

  it('a crash after an image settled, before the next one is marked, keeps the settled image and resumes only the rest', async () => {
    let busy = false;
    const h = await recordingSetup({ stateFlushMs: 60_000, isBusy: () => busy });
    const batch = await h.service.enqueue(queued({ count: 2, seedMode: 'increment' }));
    await expectCount(h, 1); busy = true; h.settle(0);
    await waitUntil(async () => expect((await stateOnDisk(h.runtimeDir, batch.batchId)).items[0]).toMatchObject({ status: 'succeeded', providerOutcome: 'response_received' }), DISK_POLL);
    const copy = await copyRuntime(h.runtimeDir);
    const restored = setup({ runtimeDir: copy }); await restored.service.ready; cleanups.push(restored.service.dispose);
    expect(restored.read(batch)).toMatchObject({ status: 'paused', error: { code: 'recovered_paused' } });
    expect(restored.read(batch).items.map(item => item.status)).toEqual(['succeeded', 'pending']);
    await restored.service.resume({ ...restored.args(batch), expectedRevision: 0 });
    await expectCount(restored, 1); expect(vi.mocked(restored.generation.submit).mock.calls[0][0].requestKey).toBe(`batch-${batch.batchId}-1`);
    restored.settle(0); await expectStatus(restored, batch, 'succeeded');
  });

  it('an ended batch read back after a restart is not rewritten by a pause or cancel that changes nothing', async () => {
    const h = await queueSetup(), batch = await h.service.enqueue(queued());
    await expectCount(h, 1); h.settle(0); await expectStatus(h, batch, 'succeeded'); await h.service.dispose();
    const states = path.join(h.runtimeDir, 'frozen-queue', `${batch.batchId}.states`), before = await fs.readdir(states);
    const restored = setup({ runtimeDir: h.runtimeDir }); await restored.service.ready; cleanups.push(restored.service.dispose);
    await restored.service.pause(restored.args(batch)); await restored.service.cancel(restored.args(batch));
    expect(await fs.readdir(states)).toEqual(before);
  });
});

describe('restart recovery is written and matched with the library (review rework P2-1, P2-2)', () => {
  const crashedCopy = async (h: Awaited<ReturnType<typeof queueSetup>>) => { const copy = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-restart-copy-')); cleanups.push(() => fs.rm(copy, { recursive: true, force: true })); await fs.cp(h.runtimeDir, copy, { recursive: true, filter: source => !path.basename(source).startsWith('.quota.lock') }); return copy; };
  const stored = async (runtimeDir: string, batchId: string) => JSON.parse(await fs.readFile(path.join(runtimeDir, 'frozen-queue', `${batchId}.state.json`), 'utf8')).job as BatchJob;

  it('P2-1: a batch restored as blocked is written ended with its finishedAt, which a later restart keeps', async () => {
    const h = await queueSetup(), batch = await h.service.enqueue(queued({ count: 2, seedMode: 'increment' }));
    await expectCount(h, 1);
    const copy = await crashedCopy(h);
    expect((await stored(copy, batch.batchId)).status).not.toBe('blocked');
    const first = setup({ runtimeDir: copy }); await first.service.ready;
    const restored = first.read(batch);
    expect(restored).toMatchObject({ status: 'blocked', error: { code: 'restart_unconfirmed' } });
    expect(await stored(copy, batch.batchId)).toMatchObject({ status: 'blocked', finishedAt: restored.finishedAt, activeIndex: null });
    await first.service.dispose();
    const second = setup({ runtimeDir: copy }); await second.service.ready; cleanups.push(second.service.dispose);
    expect(second.read(batch)).toMatchObject({ status: 'blocked', finishedAt: restored.finishedAt });
    expect(second.generation.submit).not.toHaveBeenCalled();
  });

  it('P2-2: an image the library saved before the app died is the item\'s result; an unmatched one stays unknown', async () => {
    const h = await queueSetup(), batch = await h.service.enqueue(queued({ count: 2, seedMode: 'increment' }));
    await expectCount(h, 1);
    const copy = await crashedCopy(h);
    const saved = { id: 'history-saved-0', width: 832, height: 1216, model: 'nai-diffusion-4-5-full', actualSeed: 42, jobId: 'child-1' };
    const calls: Array<[string, number]> = [];
    const restarted = setup({ runtimeDir: copy, savedResults: (batchId, itemIndex) => { calls.push([batchId, itemIndex]); return itemIndex === 0 ? [saved] : []; } });
    await restarted.service.ready; cleanups.push(restarted.service.dispose);
    expect(calls).toEqual([[batch.batchId, 0]]);
    const value = restarted.read(batch);
    expect(value).toMatchObject({ status: 'paused', error: { code: 'recovered_paused' } });
    expect(value.items[0]).toMatchObject({ status: 'succeeded', providerOutcome: 'response_received', jobId: 'child-1', actualSeed: 42, error: null, results: [{ index: 0, id: 'history-saved-0', width: 832, height: 1216, model: 'nai-diffusion-4-5-full', actualSeed: 42 }] });
    expect(value.items[1].status).toBe('pending');
    expect((await stored(copy, batch.batchId)).items[0].status).toBe('succeeded');
    // Resumed: only the second image is sent.
    await restarted.service.resume({ ...restarted.args(batch), expectedRevision: 0 });
    await expectCount(restarted, 1); expect(vi.mocked(restarted.generation.submit).mock.calls[0][0].requestKey).toBe(`batch-${batch.batchId}-1`);
  });

  it('P2-2: a one-image batch whose image was saved restores as succeeded; without a saved image it is unknown, as before', async () => {
    for (const savedImage of [true, false]) {
      const h = await queueSetup(), batch = await h.service.enqueue(queued({ requestKey: `restart-${savedImage}` }));
      await expectCount(h, 1);
      const copy = await crashedCopy(h);
      const restarted = setup({ runtimeDir: copy, savedResults: () => savedImage ? [{ id: 'h-1', width: 64, height: 64, model: 'm', actualSeed: 42, jobId: null }] : [] });
      await restarted.service.ready; cleanups.push(restarted.service.dispose);
      expect(restarted.read(batch).status).toBe(savedImage ? 'succeeded' : 'blocked');
      expect(restarted.read(batch).items[0].status).toBe(savedImage ? 'succeeded' : 'unknown');
      expect((await stored(copy, batch.batchId)).status).toBe(savedImage ? 'succeeded' : 'blocked');
      expect(restarted.generation.submit).not.toHaveBeenCalled();
    }
  });
});
