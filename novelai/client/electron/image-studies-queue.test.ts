import { afterEach, expect, it, vi } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
vi.mock('axios', () => ({ default: { get: () => { throw new Error('No network'); }, post: () => { throw new Error('No generation'); } } }));
vi.mock('./ipc/store', () => ({ getToken: () => { throw new Error('No account'); }, getSettings: () => { throw new Error('No settings'); } }));
vi.mock('electron', () => ({ app: {}, dialog: {}, nativeImage: {} }));
import { createQueueRecipeService } from './queue-recipe-service';
import { createBatchService } from './batch-service';
import { createImageStudyService } from './image-studies';
import { openLibraryRepository } from './library/repository';
import { parseImageStudy } from './image-study-parser';
import type { BatchChildJob, BatchGenerationPort } from '../src/workspace/batch-types';
import type { GenerationSnapshot } from '../src/workspace/generation-types';
import { waitUntil } from '../src/test-support/wait-until';

const cleanup: Array<() => Promise<void>> = [];
// Runs in list order; every entry runs even if an earlier one throws (the first failure is rethrown).
afterEach(async () => { vi.restoreAllMocks(); await runCleanups(cleanup.splice(0)); });

it('keeps the durable FIFO and other queue submissions independent of stalled study parsing and failed study publication', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-study-queue-'));
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true })); // removed last, also if setup below throws
  const runtimeDir = path.join(directory, 'runtime'), studiesDir = path.join(directory, 'library', 'studies');
  await fs.mkdir(runtimeDir);
  // Same real batch/recipe services and manually completed SFW provider fixture
  // as material-queue: assertions observe actual frozen child inputs.
  const jobs = new Map<string, BatchChildJob>(), accepted: GenerationSnapshot[] = [], subscribers = new Set<(job: BatchChildJob) => void>();
  const generation: BatchGenerationPort = {
    lookup: args => structuredClone([...jobs.values()].find(job => job.originWorkspaceId === args.workspaceId && job.requestKey === args.requestKey) ?? null),
    submit: args => {
      const { snapshot, ...request } = args; accepted.push(structuredClone(snapshot));
      const now = new Date().toISOString();
      const job: BatchChildJob = { ...request, jobId: `child-${accepted.length}`, originWorkspaceId: args.workspaceId, submittedRevision: args.expectedRevision, status: 'running', createdAt: now, updatedAt: now, startedAt: now, finishedAt: null, model: snapshot.params.model,
        actualSeed: snapshot.params.seed, providerRequestId: null, inputSummary: { sampleCount: 1, width: snapshot.params.width, height: snapshot.params.height, steps: snapshot.params.steps, sampler: snapshot.params.sampler, cfgScale: snapshot.params.cfgScale, characterCount: 0 },
        quote: { source: 'fixture', amount: null }, error: null, results: [], cancelRequested: false, providerOutcome: 'unknown' };
      jobs.set(job.jobId, job); subscribers.forEach(listener => listener(structuredClone(job))); return structuredClone(job);
    },
    read: ({ jobId }) => structuredClone(jobs.get(jobId)!),
    cancel: vi.fn(({ jobId }) => structuredClone(jobs.get(jobId)!)),
    subscribe: listener => { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
  };
  const batch = createBatchService({ generation, runtimeDir, wait: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 2))) });
  await batch.ready;
  cleanup.unshift(() => batch.dispose()); // disposed before the directory is removed
  const queue = createQueueRecipeService({ runtimeDir, batch });
  const prep = (positivePrompt: string) => ({ mode: 't2i', authored: { params: { positivePrompt, stylePrompt: 'watercolor', negativePrompt: 'text', seedMode: 'fixed', seed: 10, width: 64, height: 64 } }, assets: [] });
  const first = await queue.put_queue_recipe({ preparation: prep('red teacup on a table') });
  const requestItem = (recipe: any, seed: number) => ({ recipeId: recipe.recipeId, recipeRevision: recipe.recipeRevision, inputHash: recipe.inputHash, seed });
  const a = await queue.enqueue_queue_recipes({ requestKey: 'client-one/study-isolation', items: [requestItem(first, 11), requestItem(first, 12)] });
  await waitUntil(() => expect(accepted).toHaveLength(1));
  const inputFile = path.join(runtimeDir, 'frozen-queue', `${a.batchId}.input.json`), frozenBefore = await fs.readFile(inputFile, 'utf8');
  const firstBefore = await queue.read_queue_recipe({ recipeId: first.recipeId, recipeRevision: first.recipeRevision });

  const image = (background: string) => sharp({ create: { width: 4, height: 3, channels: 3, background } }).png().toBuffer();
  const red = await image('#ff0000'), blue = await image('#0000ff');
  let releaseParse!: () => void;
  const gate = new Promise<void>(resolve => { releaseParse = resolve; });
  let firstParse = true;
  const parse = vi.fn(async (bytes: Buffer) => { if (firstParse) { firstParse = false; await gate; } return parseImageStudy(bytes); });
  const repository = openLibraryRepository({ filePath: path.join(directory, 'library.sqlite'), libraryDirectory: path.join(directory, 'library') });
  cleanup.unshift(async () => repository.close());
  const studies = createImageStudyService({ directory: studiesDir, repository, parse });
  const pending = studies.material_studies({ action: 'import', name: 'red.png', data: red.toString('base64') });
  const outcome = pending.then(value => ({ value, error: null }), error => ({ value: null, error }));
  cleanup.unshift(async () => { releaseParse(); await outcome; studies.dispose(); });
  await waitUntil(() => expect(parse).toHaveBeenCalledOnce());

  const originalRename = fs.rename;
  const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).startsWith(`${studiesDir}${path.sep}`)) throw Object.assign(new Error('fixture study disk failure'), { code: 'EIO' });
    return originalRename(from, to);
  });
  await expect(studies.material_studies({ action: 'import', name: 'blue.png', data: blue.toString('base64') })).rejects.toMatchObject({ code: 'EIO' });
  expect((await studies.material_studies({ action: 'list' })).total).toBe(0);

  const second = await queue.put_queue_recipe({ preparation: prep('green plant on a shelf') });
  const b = await queue.enqueue_queue_recipes({ requestKey: 'client-two/study-isolation', items: [requestItem(second, 99)] });
  expect(b.status).toBe('queued'); expect(accepted).toHaveLength(1);
  const settle = (index: number) => {
    const job = jobs.get(`child-${index}`)!; job.status = 'succeeded'; job.finishedAt = new Date().toISOString(); job.updatedAt = job.finishedAt;
    job.results = [{ index: 0, id: `result-${index}`, width: 64, height: 64, model: job.model, actualSeed: job.actualSeed! }];
    subscribers.forEach(listener => listener(structuredClone(job)));
  };
  settle(1); await waitUntil(() => expect(accepted).toHaveLength(2));
  expect((await studies.material_studies({ action: 'list' })).total).toBe(0);
  rename.mockRestore(); releaseParse();
  const imported = await outcome;
  expect(imported.error).toBeNull();
  const saved = imported.value.study;
  expect(saved).toMatchObject({ revision: 1, metadataStatus: 'missing', sourceAuthor: '' });
  expect((await studies.material_studies({ action: 'list' })).total).toBe(1);
  const original = await studies.material_studies({ action: 'original', id: saved.id });
  expect(Buffer.from(original.data, 'base64')).toEqual(red);
  const compact = await studies.material_studies({ action: 'read', id: saved.id });
  expect(compact.section).toBe('summary'); expect(JSON.stringify(compact)).not.toContain(red.toString('base64'));

  settle(2); await waitUntil(() => expect(accepted).toHaveLength(3));
  settle(3); await waitUntil(() => expect(batch.read({ workspaceId: 'viewer', batchId: b.batchId }).status).toBe('succeeded'));
  expect(batch.read({ workspaceId: 'viewer', batchId: a.batchId }).status).toBe('succeeded');
  expect(accepted.map(snapshot => snapshot.params.positivePrompt)).toEqual(['red teacup on a table', 'red teacup on a table', 'green plant on a shelf']);
  expect(accepted.map(snapshot => snapshot.params.seed)).toEqual([11, 12, 99]);
  expect(accepted.every(snapshot => snapshot.params.stylePrompt === 'watercolor' && snapshot.batchCount === 1)).toBe(true);
  expect(await fs.readFile(inputFile, 'utf8')).toBe(frozenBefore);
  expect(await queue.read_queue_recipe({ recipeId: first.recipeId, recipeRevision: first.recipeRevision })).toEqual(firstBefore);
  expect(generation.cancel).not.toHaveBeenCalled();
});
