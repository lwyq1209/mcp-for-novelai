/**
 * The queue panel's host side (review rework P1-1): novelai:queue:call reaches exactly the host queue methods
 * list_queue / pause_queue / resume_queue / cancel_queue of the real recipe queue over the real durable batch
 * service, with the host rules unchanged: a resumed batch continues with its original frozen recipe,
 * and a failed or unknown image is never resent. The child generator is a fixture; nothing reaches NovelAI.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';
vi.mock('axios', () => ({ default: { get: () => { throw new Error('No network'); }, post: () => { throw new Error('No generation'); } } }));
vi.mock('./ipc/store', () => ({ getToken: () => { throw new Error('No account'); }, getSettings: () => { throw new Error('No settings'); } }));
vi.mock('electron', () => ({ app: {}, dialog: {}, nativeImage: {} }));
import { createBatchService } from './batch-service';
import { createQueueRecipeService, QUEUE_WORKSPACE } from './queue-recipe-service';
import { createQueueUiHandler, queueBatchEvent, QUEUE_UI_METHODS } from './queue-ui';
import type { BatchChildJob, BatchGenerationPort, BatchJob } from '../src/workspace/batch-types';
import type { GenerationSnapshot } from '../src/workspace/generation-types';
import { waitUntil } from '../src/test-support/wait-until';

const cleanups: Array<() => unknown> = [];
afterEach(() => runCleanups(cleanups.splice(0).reverse()));

async function setup() {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-queue-ui-'));
  cleanups.push(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const jobs = new Map<string, BatchChildJob>(), accepted: Array<{ requestKey: string; snapshot: GenerationSnapshot }> = [];
  const subscribers = new Set<(job: BatchChildJob) => void>();
  const generation: BatchGenerationPort = {
    lookup: args => structuredClone([...jobs.values()].find(job => job.requestKey === args.requestKey) ?? null),
    submit: vi.fn(args => {
      const { snapshot, ...request } = args; accepted.push({ requestKey: args.requestKey, snapshot: structuredClone(snapshot) });
      const now = new Date().toISOString();
      const job: BatchChildJob = { ...request, jobId: `child-${accepted.length}`, originWorkspaceId: args.workspaceId, submittedRevision: args.expectedRevision, status: 'running', createdAt: now, updatedAt: now, startedAt: now, finishedAt: null,
        model: snapshot.params.model, actualSeed: snapshot.params.seed, providerRequestId: null, inputSummary: { sampleCount: 1, width: 64, height: 64, steps: 1, sampler: snapshot.params.sampler, cfgScale: 5, characterCount: 0 },
        quote: { source: 'fixture', amount: null }, error: null, results: [], cancelRequested: false, providerOutcome: 'unknown' };
      jobs.set(job.jobId, job); return structuredClone(job);
    }),
    read: ({ jobId }) => structuredClone(jobs.get(jobId)!),
    cancel: vi.fn(({ jobId }) => { const job = jobs.get(jobId)!; job.status = 'cancelling'; job.cancelRequested = true; return structuredClone(job); }),
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
  };
  const settle = (index: number, status: BatchChildJob['status']) => {
    const job = jobs.get(`child-${index + 1}`)!;
    Object.assign(job, { status, finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), providerOutcome: status === 'succeeded' || status === 'failed' ? 'response_received' : 'unknown',
      results: status === 'succeeded' ? [{ index: 0, id: `history-${index + 1}`, width: 64, height: 64, model: job.model, actualSeed: job.actualSeed! }] : [], error: status === 'succeeded' ? null : { code: status, message: 'fixture outcome' } });
    subscribers.forEach(listener => listener(structuredClone(job)));
  };
  const events: BatchJob[] = [];
  const batch = createBatchService({ generation, runtimeDir, wait: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 2))), onBatch: job => { const event = queueBatchEvent(job); if (event) events.push(event); } });
  cleanups.push(() => batch.dispose());
  await batch.ready;
  const queue = createQueueRecipeService({ runtimeDir, batch, randomSeed: () => 97 });
  // What main.ts registers for novelai:queue:call, with each host method observed.
  const host = Object.fromEntries(QUEUE_UI_METHODS.map(method => [method, vi.fn((args: Record<string, unknown>) => (queue as any)[method](args))])) as Record<typeof QUEUE_UI_METHODS[number], ReturnType<typeof vi.fn>>;
  const call = createQueueUiHandler(host as any);
  const enqueue = async (requestKey: string, positivePrompt: string, count = 1) => {
    const recipe = await queue.put_queue_recipe({ preparation: { mode: 't2i', authored: { params: { positivePrompt, negativePrompt: 'text', seed: 7, seedMode: 'fixed', width: 64, height: 64 } }, assets: [] } });
    return queue.enqueue_queue_recipes({ requestKey, items: Array.from({ length: count }, (_, index) => ({ recipeId: recipe.recipeId, recipeRevision: recipe.recipeRevision, inputHash: recipe.inputHash, seed: 11 + index })) }) as Promise<BatchJob>;
  };
  const read = (batchId: string) => batch.read({ workspaceId: QUEUE_WORKSPACE, batchId });
  return { call, host, enqueue, read, settle, accepted, events, generation };
}
const ok = (response: any) => { expect(response.ok, JSON.stringify(response)).toBe(true); return response.result; };

describe('queue panel IPC (novelai:queue:call)', () => {
  it('lists the queue and routes pause, resume and cancel to the host methods with only the batchId', async () => {
    const h = await setup();
    const a = await h.enqueue('panel-a', 'a paper lantern', 2);
    await waitUntil(() => expect(h.accepted).toHaveLength(1));
    const listed = ok(await h.call('list_queue', { anything: 'ignored' }));
    expect(h.host.list_queue).toHaveBeenCalledWith({});
    expect(listed.batches.map((item: BatchJob) => [item.batchId, item.status])).toEqual([[a.batchId, 'running']]);

    expect(ok(await h.call('pause_queue', { batchId: a.batchId, workspaceId: 'canvas' }))).toMatchObject({ batchId: a.batchId, status: 'pausing' });
    expect(h.host.pause_queue).toHaveBeenCalledWith({ batchId: a.batchId });
    h.settle(0, 'succeeded');
    await waitUntil(() => expect(h.read(a.batchId).status).toBe('paused'));
    expect(h.accepted).toHaveLength(1);

    expect(ok(await h.call('resume_queue', { batchId: a.batchId }))).toMatchObject({ batchId: a.batchId, status: 'queued', error: null });
    expect(h.host.resume_queue).toHaveBeenCalledWith({ batchId: a.batchId });
    await waitUntil(() => expect(h.accepted).toHaveLength(2));
    expect(h.accepted[1].snapshot.params.positivePrompt).toBe('a paper lantern');

    expect(ok(await h.call('cancel_queue', { batchId: a.batchId }))).toMatchObject({ batchId: a.batchId, status: 'cancelling' });
    expect(h.host.cancel_queue).toHaveBeenCalledWith({ batchId: a.batchId });
    expect(h.generation.cancel).toHaveBeenCalledWith({ workspaceId: QUEUE_WORKSPACE, jobId: 'child-2' });
    h.settle(1, 'cancelled');
    await waitUntil(() => expect(h.read(a.batchId).status).toBe('cancelled'));
    // The panel saw each transition as a queue batch event.
    expect(h.events.filter(event => event.batchId === a.batchId).map(event => event.status)).toEqual(expect.arrayContaining(['running', 'pausing', 'paused', 'queued', 'cancelling', 'cancelled']));
  });

  it('an unknown image pauses nothing: the next batch runs with its original frozen recipe and the unknown image is never resent', async () => {
    const h = await setup();
    const a = await h.enqueue('panel-unknown', 'first recipe');
    await waitUntil(() => expect(h.accepted).toHaveLength(1));
    const b = await h.enqueue('panel-next', 'second recipe');
    h.settle(0, 'unknown');
    await waitUntil(() => expect(h.accepted).toHaveLength(2));
    expect(h.read(a.batchId)).toMatchObject({ status: 'partial', items: [{ status: 'unknown' }] });
    const listed = ok(await h.call('list_queue', {})).batches.find((item: BatchJob) => item.batchId === b.batchId);
    expect(listed).toMatchObject({ status: 'running', error: null });

    // The ended batch with the unknown image cannot be resumed: nothing is resent.
    const refused = await h.call('resume_queue', { batchId: a.batchId });
    expect(refused).toMatchObject({ ok: false, error: { code: 'batch_not_paused' } });
    expect(h.accepted.map(item => item.snapshot.params.positivePrompt)).toEqual(['first recipe', 'second recipe']);
    h.settle(1, 'succeeded');
    await waitUntil(() => expect(h.read(b.batchId).status).toBe('succeeded'));
    expect(h.accepted).toHaveLength(2);
    expect(h.read(a.batchId)).toMatchObject({ status: 'partial', items: [{ status: 'unknown' }] });
  });

  it('offers nothing beyond the four panel methods, and refusals keep the queue\'s own code', async () => {
    const h = await setup();
    for (const method of ['enqueue_queue_recipes', 'put_queue_recipe', 'get_queue_result', 'read_queue', 'capture_canvas_recipe', 42])
      expect(await h.call(method, {})).toMatchObject({ ok: false, error: { code: 'method_not_found' } });
    expect(await h.call('pause_queue', { batchId: 'not-a-batch' })).toMatchObject({ ok: false, error: { code: 'invalid_argument' } });
    expect(Object.values(h.host).every(spy => spy.mock.calls.length <= 1)).toBe(true);
  });

  it('a refusal carries the reason and params the window renders (step 4a), beside its code and English message', async () => {
    const { withReason } = await import('./host-error');
    const { WorkspaceError } = await import('../src/workspace/protocol');
    const handler = createQueueUiHandler({ list_queue: async () => { throw withReason(new WorkspaceError('queue_storage_failed', 'The recipe store holds an entry this app does not use: runtime/queue-recipes/x.txt.', { reason: 'unsupported_entry', entry: 'runtime/queue-recipes/x.txt' }), 'recipe.stray_entry', { entry: 'runtime/queue-recipes/x.txt' }); },
      pause_queue: async () => ({}), resume_queue: async () => ({}), cancel_queue: async () => ({}) });
    expect(await handler('list_queue', {})).toEqual({ ok: false, error: { code: 'queue_storage_failed', message: 'The recipe store holds an entry this app does not use: runtime/queue-recipes/x.txt.', reason: 'recipe.stray_entry', params: { entry: 'runtime/queue-recipes/x.txt' } } });
  });

  it('forwards only recipe-queue batch events', () => {
    const job = { batchId: 'b', execution: 'queued', originWorkspaceId: QUEUE_WORKSPACE } as BatchJob;
    expect(queueBatchEvent(job)).toBe(job);
    expect(queueBatchEvent({ ...job, originWorkspaceId: 'canvas' })).toBeNull();
    expect(queueBatchEvent({ ...job, execution: undefined })).toBeNull();
    expect(queueBatchEvent(null)).toBeNull();
  });
});
