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
import { createMaterialLibraryService } from './material-library';
import { openLibraryRepository } from './library/repository';
import type { BatchChildJob, BatchGenerationPort } from '../src/workspace/batch-types';
import type { GenerationSnapshot } from '../src/workspace/generation-types';
import { waitUntil } from '../src/test-support/wait-until';

const cleanup: Array<() => Promise<void>> = [];
// Runs in list order; every entry runs even if an earlier one throws (the first failure is rethrown).
afterEach(async () => { vi.restoreAllMocks(); await runCleanups(cleanup.splice(0)); });

it('real durable FIFO advances while tag/cover requests hang or fail, and cover edits preserve frozen inputs', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-material-queue-'));
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true })); // removed last, also if setup below throws
  const runtimeDir = path.join(directory, 'runtime'), libraryDir = path.join(directory, 'library'); await fs.mkdir(runtimeDir);
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
  const batch = createBatchService({ generation, runtimeDir, wait: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 2))) }); await batch.ready;
  cleanup.unshift(() => batch.dispose()); // disposed before the directory is removed
  const queue = createQueueRecipeService({ runtimeDir, batch });
  let releaseLookup!: (value: any) => void;
  const tags = { search: vi.fn(() => new Promise<any>(resolve => { releaseLookup = resolve; })), details: vi.fn(async () => ({ checkedAt: '2026-09-11T00:00:00.000Z', items: [{ name: 'sample_artist', canonicalName: 'sample_artist', resolution: 'canonical', tagStatus: 'found', category: 'artist', postCount: 42, deprecated: false, aliasStatus: 'checked', wiki: { status: 'found', body: 'SFW fixture artist.' }, sources: [] }] })) };
  const item = (postId: number) => ({ postId, rating: 'g', sourceUrl: `https://danbooru.donmai.us/posts/${postId}`, width: 4, height: 3, previewUrl: `https://cdn.donmai.us/${postId}-preview.png`, sampleUrl: `https://cdn.donmai.us/${postId}-sample.png`, score: 30, tags: { general: [], artists: ['sample_artist'], characters: [], copyrights: [], meta: [] } });
  const image = async (postId: number) => ({ postId, mimeType: 'image/png', data: (await sharp({ create: { width: 4, height: 3, channels: 3, background: postId === 42 ? '#ff0000' : '#0000ff' } }).png().toBuffer()).toString('base64'), sourceUrl: item(postId).sourceUrl, imageUrl: item(postId).sampleUrl, variant: 'sample' });
  const gallery = { search: vi.fn(), detail: vi.fn(async ({ postId }) => item(postId) as any), image: vi.fn(async ({ postId }) => image(postId) as any) };
  const repository = openLibraryRepository({ filePath: path.join(directory, 'library.sqlite'), libraryDirectory: libraryDir });
  cleanup.unshift(async () => repository.close());
  const materials = createMaterialLibraryService({ directory: libraryDir, repository, tags, gallery });
  const { entry } = await materials.library({ action: 'save', entry: { kind: 'tag', name: 'Fixture artist', tag: { text: 'sample_artist', source: 'danbooru', category: 'artist', target: 'style' } } });
  const contentBefore = repository.readVersions('tag', entry.id);
  await materials.samples({ action: 'set_cover', entryId: entry.id, revision: 1, postId: 42, expectedCoverRevision: 0 });
  const originalCover = await materials.samples({ action: 'cover', entryId: entry.id });
  const compact = await materials.library({ action: 'list' });
  expect(compact.items[0]).toMatchObject({ revision: 1, coverRevision: 1, cover: { postId: 42 }, coverStatus: 'ready' });
  expect(JSON.stringify(compact)).not.toContain(originalCover.data);
  expect(JSON.stringify(compact)).not.toContain('"data":');
  const prep = (positivePrompt: string) => ({ mode: 't2i', authored: { params: { positivePrompt, stylePrompt: 'sample_artist', negativePrompt: 'text', seedMode: 'fixed', seed: 10, width: 64, height: 64 } }, assets: [] });
  const first = await queue.put_queue_recipe({ preparation: prep('red teacup on a table') });
  const requestItem = (recipe: any, seed: number) => ({ recipeId: recipe.recipeId, recipeRevision: recipe.recipeRevision, inputHash: recipe.inputHash, seed });
  const a = await queue.enqueue_queue_recipes({ requestKey: 'client-one/batch', items: [requestItem(first, 11), requestItem(first, 12)] });
  await waitUntil(() => expect(accepted).toHaveLength(1));
  const inputFile = path.join(runtimeDir, 'frozen-queue', `${a.batchId}.input.json`), frozenBefore = await fs.readFile(inputFile, 'utf8');
  const slowLookup = materials.tags({ action: 'search', query: 'artist', category: 'artist' });
  await waitUntil(() => expect(releaseLookup).toBeTypeOf('function'));
  let releaseCover!: (value: any) => void;
  gallery.image.mockImplementationOnce(() => new Promise(resolve => { releaseCover = resolve; }));
  const slowCover = materials.samples({ action: 'set_cover', entryId: entry.id, revision: 1, postId: 43, expectedCoverRevision: 1 });
  // Attach the rejection handler before releasing the deliberately stalled download.
  const coverOutcome = slowCover.then(value => ({ value, error: null }), error => ({ value: null, error }));
  await waitUntil(() => expect(releaseCover).toBeTypeOf('function'));
  // The library cannot be written while the queue keeps running: neither the entry nor its cover record.
  const diskFailure = () => { throw Object.assign(new Error('fixture material disk failure'), { code: 'EIO' }); };
  const put = vi.spyOn(repository, 'put').mockImplementation(diskFailure), setCover = vi.spyOn(repository, 'setCover').mockImplementation(diskFailure);
  await expect(materials.library({ action: 'save', id: entry.id, expectedRevision: 1, entry: { kind: 'tag', name: 'Ink', tag: { text: 'ink', source: 'english', category: null, target: 'style' } } })).rejects.toMatchObject({ code: 'EIO' });
  const second = await queue.put_queue_recipe({ preparation: prep('green plant on a shelf') });
  const b = await queue.enqueue_queue_recipes({ requestKey: 'client-two/batch', items: [requestItem(second, 99)] });
  expect(b.status).toBe('queued'); expect(accepted).toHaveLength(1);
  const settle = (index: number) => {
    const job = jobs.get(`child-${index}`)!; job.status = 'succeeded'; job.finishedAt = new Date().toISOString(); job.updatedAt = job.finishedAt;
    job.results = [{ index: 0, id: `result-${index}`, width: 64, height: 64, model: job.model, actualSeed: job.actualSeed! }];
    subscribers.forEach(listener => listener(structuredClone(job)));
  };
  settle(1); await waitUntil(() => expect(accepted).toHaveLength(2));
  releaseCover(await image(43));
  expect((await coverOutcome).error).toMatchObject({ code: 'EIO' });
  expect(await materials.samples({ action: 'cover', entryId: entry.id })).toEqual(originalCover);
  expect(repository.getCover('tag', entry.id).coverRevision).toBe(1);
  put.mockRestore(); setCover.mockRestore();
  const cleared = await materials.samples({ action: 'clear_cover', entryId: entry.id, expectedCoverRevision: 1 });
  expect(cleared).toMatchObject({ entryRevision: 1, coverRevision: 2, cover: null, coverStatus: 'none' });
  // The image file stays: the earlier cover revision still names it.
  expect((await fs.readdir(path.join(libraryDir, 'covers'))).filter(name => name.endsWith('.webp'))).toContain(`${originalCover.cover.sha256}.webp`);
  expect(repository.readVersions('tag', entry.id)).toEqual(contentBefore);
  expect((await queue.read_queue_recipe({ recipeId: first.recipeId, recipeRevision: first.recipeRevision })).inputHash).toBe(first.inputHash);
  settle(2); await waitUntil(() => expect(accepted).toHaveLength(3));
  settle(3); await waitUntil(() => expect(batch.read({ workspaceId: 'viewer', batchId: b.batchId }).status).toBe('succeeded'));
  expect(batch.read({ workspaceId: 'viewer', batchId: a.batchId }).status).toBe('succeeded');
  expect(accepted.map(snapshot => snapshot.params.positivePrompt)).toEqual(['red teacup on a table', 'red teacup on a table', 'green plant on a shelf']);
  expect(accepted.map(snapshot => snapshot.params.seed)).toEqual([11, 12, 99]);
  expect(accepted.every(snapshot => snapshot.params.stylePrompt === 'sample_artist' && snapshot.batchCount === 1)).toBe(true);
  expect(await fs.readFile(inputFile, 'utf8')).toBe(frozenBefore);
  expect(generation.cancel).not.toHaveBeenCalled();
  releaseLookup({ query: 'artist', source: 'fixture', items: [] }); await slowLookup;
  expect((await materials.library({ action: 'read', id: entry.id })).entry).toMatchObject({ revision: 1, tag: entry.tag, coverRevision: 2, cover: null });
});
