/**
 * Recently Deleted and recipe sources: the real recipe store, frozen batch queue, history reader, SQLite library and
 * Recently Deleted service over real files (only the provider is a stub that records frozen child inputs).
 */
import { afterEach, expect, it, vi } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
vi.mock('axios', () => ({ default: { get: () => { throw new Error('No network'); }, post: () => { throw new Error('No generation'); } } }));
vi.mock('./ipc/store', () => ({ getToken: () => { throw new Error('No account'); }, getSettings: () => { throw new Error('No settings'); } }));
vi.mock('electron', () => ({ app: {}, dialog: {}, nativeImage: {} }));
import { createQueueRecipeService } from './queue-recipe-service';
import { createBatchService } from './batch-service';
import { createHistoryImageReader } from './asset-library-image';
import { openLibraryRepository } from './library/repository';
import { createLibraryTrash } from './library-trash';
import type { BatchChildJob, BatchGenerationPort } from '../src/workspace/batch-types';
import type { GenerationSnapshot } from '../src/workspace/generation-types';
import { waitUntil } from '../src/test-support/wait-until';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(() => runCleanups(cleanup.splice(0).reverse()));
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const gradient = () => { const png = new PNG({ width: 64, height: 64 }); for (let i = 0; i < png.data.length; i += 4) png.data.set([i % 251, (i / 4) % 64 * 4, 90, 255], i); return PNG.sync.write(png); };

it('a deleted source is listed, fails new enqueues until restored, and never touches a batch already queued', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nai-trash-queue-')));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, 'runtime'), library = path.join(root, 'library'), output = path.join(root, 'output');
  for (const dir of [runtimeDir, library, output]) await fs.mkdir(dir);
  const repo = openLibraryRepository({ filePath: path.join(root, 'library.sqlite'), libraryDirectory: library, userDataRoot: root });
  cleanup.push(() => repo.close());
  const bytes = gradient(), file = path.join(output, 'source.png');
  await fs.writeFile(file, bytes);
  const source = repo.put('history', 'source', { id: 'source', filePath: file, fileUrl: 'fixture:source', sha256: sha256(bytes), byteLength: bytes.length, date: '2026-11-02', createdAt: '2026-11-02T00:00:00Z', params: { positivePrompt: 'teacup' }, actualSeed: 1, model: 'nai-diffusion-4-5-full', width: 64, height: 64 });
  const assetId = repo.itemAssets('history', 'source').find(asset => asset.role === 'original')!.id;

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
  cleanup.push(() => batch.dispose());
  const queue = createQueueRecipeService({ runtimeDir, batch, readHistoryOriginal: createHistoryImageReader(repo), validateImage: data => { const png = PNG.sync.read(data); return { width: png.width, height: png.height }; } });
  const trash = createLibraryTrash({ repository: repo, userDataRoot: root, libraryDirectory: library, managedRoots: () => [output], log: () => undefined, recipeReferences: targets => queue.sourceReferences(targets) });

  const params = { positivePrompt: 'teacup, table', negativePrompt: 'text', seed: 42, seedMode: 'fixed', width: 64, height: 64 };
  const recipe = await queue.put_queue_recipe({ preparation: { mode: 'i2i', authored: { params, i2iParams: { strength: 0.6, noise: 0, extraNoiseSeed: 5 } },
    assets: [{ role: 'source', mimeType: 'image/png', ref: { kind: 'history', id: 'source', revision: source.revision, assetId }, sha256: sha256(bytes), byteLength: bytes.length }] } });
  const item = (seed: number) => ({ recipeId: recipe.recipeId, recipeRevision: recipe.recipeRevision, inputHash: recipe.inputHash, seed });
  const queued = await queue.enqueue_queue_recipes({ requestKey: 'mcp-trash-frozen', items: [item(11), item(12)] });
  await waitUntil(() => expect(accepted).toHaveLength(1));
  const frozenFile = path.join(runtimeDir, 'frozen-queue', `${queued.batchId}.input.json`), frozenBefore = await fs.readFile(frozenFile, 'utf8');
  expect(frozenBefore).toContain(bytes.toString('base64'));

  const { deleted } = await trash.deleteItems([{ kind: 'history', id: 'source', expectedRevision: source.revision }]);
  expect(deleted[0]).toMatchObject({ files: { moved: 1 }, impacts: { recipes: [{ recipeId: recipe.recipeId, recipeRevision: recipe.recipeRevision, sourceRevision: source.revision }] } });
  await expect(fs.access(file)).rejects.toMatchObject({ code: 'ENOENT' });

  // A new enqueue of the recipe reports the missing source and queues nothing (the existing behavior).
  await expect(queue.enqueue_queue_recipes({ requestKey: 'mcp-trash-after-delete', items: [item(13)] })).rejects.toMatchObject({ code: 'recipe_source_unavailable', message: expect.stringContaining('library_not_found') });
  // The batch queued before the deletion runs on its frozen copy.
  const settle = (index: number) => { const job = jobs.get(`child-${index}`)!; job.status = 'succeeded'; job.finishedAt = new Date().toISOString(); job.updatedAt = job.finishedAt; job.results = [{ index: 0, id: `result-${index}`, width: 64, height: 64, model: job.model, actualSeed: job.actualSeed! }]; subscribers.forEach(listener => listener(structuredClone(job))); };
  settle(1);
  await waitUntil(() => expect(accepted).toHaveLength(2));
  expect(accepted[1].assets?.find(asset => asset.role === 'source')?.data ?? JSON.stringify(accepted[1])).toContain(bytes.toString('base64').slice(0, 64));
  expect(await fs.readFile(frozenFile, 'utf8')).toBe(frozenBefore);
  settle(2);

  // Restored, the same recipe enqueues again.
  await trash.restore([(deleted[0] as any).trashId]);
  const again = await queue.enqueue_queue_recipes({ requestKey: 'mcp-trash-after-restore', items: [item(14)] });
  expect(again.status).toBe('queued');
});
