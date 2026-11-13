/**
 * Step 3a+ end to end (canvas into the queue): the MCP server talks over the real HTTP bridge to the real host services
 * (recipe store with canvas capture and reclamation, frozen batch queue, single-image generation service, the real
 * nai.ts request builder and file saving, the asset library over SQLite) and to the real renderer workspace (adapter +
 * controller over the real Store). Only NovelAI itself is a stub (axios answers a ZIP), the account store is a fixture
 * and every directory is temporary. The renderer channel mirrors bridge-host: host methods first, every other method
 * to the renderer controller's handle().
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';

const fixture = vi.hoisted(() => ({ outputDir: '', groups: [] as Array<{ id: string; name: string; createdAt: string }>, history: [] as any[], post: vi.fn(), onHistory: (_items: any[]) => {} }));
vi.mock('electron', async () => {
  const { PNG } = await import('pngjs');
  const make = (png: any): any => ({
    isEmpty: () => false, getSize: () => ({ width: png.width, height: png.height }), toPNG: () => PNG.sync.write(png),
    resize({ width, height }: { width: number; height: number }) { const out = new PNG({ width, height }); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const sx = Math.min(png.width - 1, Math.floor(x * png.width / width)), sy = Math.min(png.height - 1, Math.floor(y * png.height / height)); png.data.copy(out.data, (y * width + x) * 4, (sy * png.width + sx) * 4, (sy * png.width + sx) * 4 + 4); } return make(out); },
  });
  return { app: { getPath: () => fixture.outputDir }, dialog: {}, nativeImage: { createFromBuffer(buffer: Buffer) { try { return make(PNG.sync.read(Buffer.from(buffer))); } catch { return { isEmpty: () => true }; } } } };
});
vi.mock('axios', () => ({ default: { post: fixture.post, isCancel: (error: any) => error?.code === 'ERR_CANCELED' } }));
vi.mock('./ipc/store', () => ({
  getToken: () => 'synthetic-test-token',
  getSettings: () => ({ imageBaseUrl: 'https://generation-fixture.example.test', allowCustomEndpoint: true, allowCustomEndpointFallback: true, streamPreviewEnabled: false, outputDir: fixture.outputDir, generationGroupId: '', keepImageMetadata: true, imageNameTemplate: '' }),
  getHistoryGroups: () => fixture.groups,
  ensureHistoryGroup: (name: string) => { const existing = fixture.groups.find(group => group.name.toLowerCase() === name.toLowerCase()); if (existing) return existing; const created = { id: `group-${fixture.groups.length + 1}`, name, createdAt: new Date().toISOString() }; fixture.groups.push(created); return created; },
  getAccountSummary: () => ({ hasToken: true }), addHistory: (items: any[]) => { fixture.history.push(...structuredClone(items)); fixture.onHistory(structuredClone(items)); return []; },
  setAccountSummary: vi.fn(), setToken: vi.fn(), updateHistoryItem: vi.fn(),
}));
vi.mock('./ipc/logger', () => ({ logError: vi.fn(), logInfo: vi.fn(), appendLog: vi.fn() }));
vi.mock('./ipc/proxy', () => ({ proxyConfig: () => ({}) }));

import { generateI2I, generateImage } from './ipc/nai';
import { cancelAllJobs, hasActiveGenerationJobs, reserveQueueGeneration } from './ipc/job-registry';
import { createGenerationService } from './generation-service';
import { createBatchService } from './batch-service';
import { createQueueRecipeService, QUEUE_METHODS } from './queue-recipe-service';
import { createCanvasRecipeCapture } from './canvas-recipe-capture';
import { queueBridgeError } from './queue-bridge-error';
import { buildPromptReview } from './prompt-review';
import { BridgeError, startHttpBridge } from './bridge-server';
import { openLibraryRepository } from './library/repository';
import { createAssetLibraryService } from './asset-library-service';
import { resolveQueueHistoryGroup } from './queue-output';
import { ensureHistoryGroup, getHistoryGroups } from './ipc/store';
import { useAppStore } from '../src/store';
import { DEFAULT_PARAMS } from '../src/types';
import { createRendererWorkspace } from '../src/workspace/adapter';
import type { GenerationJob } from '../src/workspace/generation-types';
import { createBridgeClient, createNovelAiMcpServer } from '../../src/mcp.mjs';
import { Client } from '../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { waitUntil } from '../src/test-support/wait-until';

const DAY = 24 * 60 * 60 * 1000;
const RETIRED = ['submit_generation', 'submit_batch', 'list_generation_jobs', 'read_generation_job', 'get_generation_result', 'list_batches', 'read_batch', 'control_generation',
  'read_prompt_review', 'get_asset', 'draft_edit', 'apply_edit', 'undo_edit'];
const png = (width: number, height: number, value: number) => { const image = new PNG({ width, height }); for (let i = 0; i < image.data.length; i += 4) image.data.set([value, (i / 4) % 255, 120, 255], i); return PNG.sync.write(image); };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
async function zipReply(width = 64, height = 64) { const zip = new JSZip(); zip.file('image_0.png', png(width, height, 200)); return { data: await zip.generateAsync({ type: 'nodebuffer' }) }; }

let base = '';
const closers: Array<() => Promise<unknown> | unknown> = [];
beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'novelai-canvas-queue-e2e-')));
  // The default output folder lies outside the project root (like <Pictures>/MCP for NovelAI), so read_queue says file:null.
  fixture.outputDir = path.join(base, 'pictures'); await fs.mkdir(fixture.outputDir, { recursive: true });
  fixture.groups = []; fixture.history = []; fixture.post.mockReset(); fixture.post.mockImplementation(() => zipReply());
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ params: { ...DEFAULT_PARAMS, model: 'nai-diffusion-4-5-full', positivePrompt: 'a harbor at dawn', negativePrompt: '', stylePrompt: '', width: 64, height: 64, steps: 1, seed: 5, seedMode: 'fixed', promptAssemblyVersion: 1 }, settings: { modelMode: 'anime' } as any });
  vi.stubGlobal('document', { querySelector: () => null });
  // decodeWorkspaceImage: the renderer checks that a source's bytes have its displayed size.
  vi.stubGlobal('Image', class { naturalWidth = 0; naturalHeight = 0; onload: (() => void) | null = null; onerror: (() => void) | null = null;
    set src(value: string) { queueMicrotask(() => { try { const image = PNG.sync.read(Buffer.from(value.split(',')[1], 'base64')); this.naturalWidth = image.width; this.naturalHeight = image.height; this.onload?.(); } catch { this.onerror?.(); } }); } });
});
afterEach(() => runCleanups([...closers.splice(0).reverse(), () => cancelAllJobs(), () => vi.unstubAllGlobals(), () => fs.rm(base, { recursive: true, force: true })]));

async function start(options: { batch?: Partial<Parameters<typeof createBatchService>[0]> } = {}) {
  const runtimeDir = path.join(base, 'runtime'), projectRoot = path.join(base, 'project');
  await fs.mkdir(runtimeDir, { recursive: true }); await fs.mkdir(projectRoot, { recursive: true });
  const clock = { now: Date.now() };
  // The history library: what nai.ts saves (addHistory) also lands in the real SQLite asset library.
  const repository = openLibraryRepository({ filePath: path.join(base, 'library.sqlite') });
  closers.push(() => repository.close());
  fixture.onHistory = items => { for (const item of items) repository.put('history', item.id, { ...item, mimeType: 'image/png' }); };
  const assets = createAssetLibraryService({ repository });
  const rendererJobs = new Set<(job: GenerationJob) => void>();
  const sizeOf = (bytes: Buffer) => { const image = PNG.sync.read(bytes); return { width: image.width, height: image.height }; };
  const generation = createGenerationService({ isBusy: hasActiveGenerationJobs, reserve: reserveQueueGeneration, validateImage: sizeOf,
    async execute(mode, snapshot, execution) {
      if (mode === 't2i') return generateImage(snapshot.params, snapshot.extras, undefined, execution);
      if (mode === 'i2i') return generateI2I(snapshot.params, snapshot.i2i!, snapshot.extras, execution);
      throw new Error(`mode ${mode} is not part of this fixture`);
    },
    onJob: job => rendererJobs.forEach(listener => listener(structuredClone(job))) });
  const batch = createBatchService({ generation, isBusy: hasActiveGenerationJobs, runtimeDir, ...options.batch });
  closers.push(() => batch.dispose());
  const queue: any = createQueueRecipeService({ runtimeDir, batch, generation, historyById: id => (repository.get('history', id)?.payload as any) ?? null, validateImage: data => sizeOf(data),
    resolveHistoryGroup: name => resolveQueueHistoryGroup(name, getHistoryGroups(), ensureHistoryGroup), recipeReclaim: { auto: false, now: () => clock.now, log: () => {} } });

  // The renderer: the real adapter and controller, with the preload API the host offers.
  vi.stubGlobal('window', { naiDesktop: {
    onGenerationJob: (listener: (job: GenerationJob) => void) => { rendererJobs.add(listener); return () => rendererJobs.delete(listener); },
    workspacePromptReview: async (preparation: any) => ({ ok: true, result: await buildPromptReview(preparation) }),
    setSetting: vi.fn(async () => {}), getHistoryItems: vi.fn(async () => []), getHistory: vi.fn(async () => []), getHistoryDates: vi.fn(async () => []), getHistoryGroups: vi.fn(async () => []),
  } });
  const workspace = createRendererWorkspace(); closers.push(() => workspace.dispose());
  const toRenderer = async (method: string, args: Record<string, unknown>) => {
    const response: any = await workspace.handle({ requestId: randomUUID(), method, args });
    if (response.error) throw new BridgeError(response.error.code, response.error.message, /conflict/.test(response.error.code) ? 409 : 400, response.error.details);
    return response.result;
  };
  // Host methods exactly as main.ts wires them: the queue methods, the asset library and the canvas capture.
  const wrap = (call: (args: any) => Promise<any>) => async (args: any) => { try { return await call(args); } catch (error) { throw queueBridgeError(error); } };
  const capture = createCanvasRecipeCapture({ collect: args => toRenderer('collect_canvas_preparation', args), put: args => queue.put_canvas_recipe(args), preview: args => queue.preview_canvas_recipe(args) });
  const hostMethods: Record<string, (args: any) => Promise<any>> = { ...Object.fromEntries(QUEUE_METHODS.map(method => [method, wrap(args => queue[method](args))])), capture_canvas_recipe: wrap(capture),
    asset_library: async args => { try { return await assets.asset_library(args); } catch (error: any) { throw new BridgeError(error?.code ?? 'material_failed', error?.message ?? 'failed'); } } };
  const dispatched: string[] = [];
  const dispatch = async (method: string, args: Record<string, unknown>) => { dispatched.push(method); return Object.hasOwn(hostMethods, method) ? hostMethods[method](args) : toRenderer(method, args); };
  const bridge = await startHttpBridge({ runtimeDir, dispatch }); closers.push(() => bridge.close());
  const server = createNovelAiMcpServer({ rawRecipeReadback: true, bridgeClient: createBridgeClient({ runtimeDir }), projectRoot, projectRootSource: 'NOVELAI_PROJECT_ROOT' });
  const client = new Client({ name: 'canvas-queue-e2e', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  closers.push(async () => { await client.close(); await server.close(); });
  // rawRecipeReadback (a test option of the server): these tests read the whole readback; the compact one agents get is tested in novelai/tests.
  const call = async (name: string, args: Record<string, unknown> = {}) => { const result: any = await client.callTool({ name, arguments: args }); return { ok: !result.isError, value: result.structuredContent, content: result.content }; };
  // The draft methods are the window's own (the MCP draft tools were retired on 2026-11-12): called on the renderer as the window does.
  const host = (method: string, args: Record<string, unknown>) => toRenderer(method, args);
  const ok = async (name: string, args: Record<string, unknown> = {}) => { const result = await call(name, args); expect(result.ok, `${name}: ${JSON.stringify(result.value).slice(0, 1500)}`).toBe(true); return result.value; };
  const refused = async (name: string, args: Record<string, unknown>) => { const result = await call(name, args); expect(result.ok, `${name} should fail`).toBe(false); return result.value.error; };
  // Until the batch ends (the test timeout bounds it).
  const settle = (batchId: string) => waitUntil(async () => { const read = await ok('read_queue', { batchId }); expect(['succeeded', 'partial', 'blocked', 'cancelled'], `batch ${read.status}`).toContain(read.status); return read; }, { interval: 25 });
  const workspaceId = (await ok('list_workspaces')).workspaces[0].workspaceId;
  const revision = async () => (await ok('read_workspace', { workspaceId, includeImages: false })).revision;
  return { queue, repository, clock, projectRoot, call, ok, host, refused, settle, workspace, workspaceId, revision, dispatched };
}
const ref = (recipe: any) => ({ recipeId: recipe.recipeId, recipeRevision: recipe.recipeRevision, inputHash: recipe.inputHash });

describe('canvas → prepare_recipe {canvas} → enqueue_recipes → read_queue/get_queue_result', () => {
  it('t2i: a draft is read, not adopted; the queue runs while apply_edit works; results carry their seeds; a stale revision is a conflict; retired tools never reach the host', async () => {
    const h = await start();
    const r0 = await h.revision();
    const draft = await h.host('draft_edit', { workspaceId: h.workspaceId, expectedRevision: r0, patch: { params: { positivePrompt: 'a lighthouse at dusk' } } });
    const recipe = await h.ok('prepare_recipe', { mode: 't2i', canvas: { workspaceId: h.workspaceId, expectedRevision: r0, draftId: draft.draftId } });
    expect(recipe).toMatchObject({ lineage: 'canvas', saved: true, ready: true, canvas: { workspaceId: h.workspaceId, revision: r0, draftId: draft.draftId, patched: false } });
    expect(recipe.authored.positivePrompt).toBe('a lighthouse at dusk');
    expect(recipe.effective.seed).toBe(5);
    // Not adopted: the canvas still shows its own prompt at the same revision, with the draft still pending.
    const unchanged = await h.ok('read_workspace', { workspaceId: h.workspaceId, includeImages: false });
    expect(unchanged).toMatchObject({ revision: r0, draft: { draftId: draft.draftId } });
    expect(unchanged.state.params.positivePrompt).toBe('a harbor at dawn');
    expect(recipe.warnings.map((warning: any) => warning.code)).not.toContain('canvas_draft_not_captured');
    // Without draftId the visible state is captured, and the readback says the pending draft was not (review rework P3-1).
    const visible = await h.ok('prepare_recipe', { mode: 't2i', canvas: { workspaceId: h.workspaceId, expectedRevision: r0 }, preview: true });
    expect(visible.authored.positivePrompt).toBe('a harbor at dawn');
    expect(visible.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'canvas_draft_not_captured', message: expect.stringContaining(`unapplied draft (${draft.draftId})`) })]));

    // The first image waits at the provider: the queue is executing while the draft is applied to the canvas.
    const first = deferred<any>();
    fixture.post.mockImplementationOnce(() => first.promise);
    const receipt = await h.ok('enqueue_recipes', { requestKey: 'e2e-canvas-t2i', historyGroup: 'e2e', items: [{ ...ref(recipe), count: 2, seeds: [11, 12] }] });
    expect(receipt.status).toBe('enqueued');
    await waitUntil(() => expect(fixture.post).toHaveBeenCalledTimes(1));
    expect((await h.ok('read_queue', { batchId: receipt.batch.batchId })).status).toBe('running');
    expect(useAppStore.getState().isGenerating).toBe(false);
    // (Manual generation joins this same queue since step 4a: electron/manual-queue-e2e.test.ts.)
    const applied = await h.host('apply_edit', { workspaceId: h.workspaceId, expectedRevision: r0, draftId: draft.draftId });
    expect(applied.state.params.positivePrompt).toBe('a lighthouse at dusk');
    expect(applied.revision).toBe(r0 + 1);
    first.resolve(await zipReply());
    const read = await h.settle(receipt.batch.batchId);
    expect(read.status).toBe('succeeded');
    expect(read.results.map((result: any) => [result.itemIndex, result.actualSeed, result.file])).toEqual([[0, 11, null], [1, 12, null]]);
    const image = await h.call('get_queue_result', { batchId: receipt.batch.batchId, itemIndex: 1 });
    expect(image.value).toMatchObject({ itemIndex: 1, actualSeed: 12, imageAttached: true, file: null });
    expect(image.content.filter((item: any) => item.type === 'image')).toHaveLength(1);
    // The provider got the captured draft's prompt, not the canvas state of that moment; the canvas kept its own image.
    expect(fixture.post.mock.calls.map(([, body]: any[]) => body.input)).toEqual(expect.arrayContaining([expect.stringContaining('a lighthouse at dusk')]));
    expect(useAppStore.getState().currentImage).toBeNull();
    expect(useAppStore.getState().isGenerating).toBe(false);

    // The capture's revision is gone now: a conflict, and nothing is saved.
    const conflict = await h.refused('prepare_recipe', { mode: 't2i', canvas: { workspaceId: h.workspaceId, expectedRevision: r0 } });
    expect(conflict).toMatchObject({ code: 'conflict', details: { saved: false, putOutcome: 'rejected', hostDetails: { currentRevision: r0 + 1 } } });
    await expect(h.refused('prepare_recipe', { mode: 't2i', canvas: { workspaceId: h.workspaceId, expectedRevision: r0 + 1, draftId: draft.draftId } })).resolves.toMatchObject({ code: 'draft_not_found' });

    // A manual batch of this window is frozen too (step 4a): apply_edit works while it runs, and a capture reads as before.
    const r1 = await h.revision();
    const next = await h.host('draft_edit', { workspaceId: h.workspaceId, expectedRevision: r1, patch: { params: { positivePrompt: 'a quiet pier' } } });
    useAppStore.setState({ isGenerating: true, activeGenerationRunId: 'manual-run', generationPhase: 'requesting' });
    expect((await h.ok('prepare_recipe', { mode: 't2i', canvas: { workspaceId: h.workspaceId, expectedRevision: r1, draftId: next.draftId }, preview: true })).saved).toBe(false);
    await h.host('apply_edit', { workspaceId: h.workspaceId, expectedRevision: r1, draftId: next.draftId });
    useAppStore.setState({ isGenerating: false, activeGenerationRunId: null, generationPhase: 'idle' });

    // The retired canvas generation tools are unknown and reach nothing.
    const before = h.dispatched.length;
    for (const name of RETIRED) expect((await h.refused(name, { workspaceId: h.workspaceId, expectedRevision: r1 + 1, requestKey: 'k', mode: 't2i', jobId: 'j', batchId: receipt.batch.batchId, action: 'cancel', count: 2, intervalSeconds: 0, seedMode: 'fixed' })).code).toBe('unknown_tool');
    expect(h.dispatched.length).toBe(before);
    expect(fixture.post).toHaveBeenCalledTimes(2);

    // Reclamation of this capture: kept while within its grace period after the batch ended; afterwards removed,
    // and the ended batch still reads, looks up and repeats exactly as before.
    h.clock.now = Date.now() + 6 * DAY;
    expect(await h.queue.reclaimRecipes()).toMatchObject({ reclaimed: 0 });
    h.clock.now = Date.now() + 8 * DAY;
    const round = await h.queue.reclaimRecipes();
    expect(round.reclaimed).toBe(1);
    expect(await h.ok('lookup_enqueue', { requestKey: 'e2e-canvas-t2i' })).toMatchObject({ status: 'enqueued', batch: { batchId: receipt.batch.batchId, status: 'succeeded' } });
    expect((await h.ok('read_queue', { batchId: receipt.batch.batchId })).results.map((result: any) => result.actualSeed)).toEqual([11, 12]);
    expect(await h.ok('enqueue_recipes', { requestKey: 'e2e-canvas-t2i', historyGroup: 'e2e', items: [{ ...ref(recipe), count: 2, seeds: [11, 12] }] })).toMatchObject({ status: 'already_enqueued', enqueueSent: false });
    expect((await h.ok('get_queue_result', { batchId: receipt.batch.batchId, itemIndex: 0 })).actualSeed).toBe(11);
    expect(fixture.post).toHaveBeenCalledTimes(2);
    expect(await h.refused('enqueue_recipes', { requestKey: 'e2e-canvas-t2i-more', items: [{ ...ref(recipe), seeds: [13] }] })).toMatchObject({ code: 'recipe_not_found' });
  });

  it('a 429 is sent again and succeeds, a 500 marks only its image, the batch ends partial; read_queue waits and get_queue_result shows the whole batch as thumbnails', async () => {
    const h = await start({ batch: { rateLimitDelaysMs: [20] } });
    const answer = (status: number, message: string) => Object.assign(new Error(`Request failed with status code ${status}`), { isAxiosError: true, response: { status, headers: { 'content-type': 'application/json' }, data: Buffer.from(JSON.stringify({ statusCode: status, message })) } });
    const held = deferred<any>(), limited = deferred<void>();
    fixture.post
      .mockImplementationOnce(() => held.promise)
      .mockImplementationOnce(() => limited.promise.then(() => Promise.reject(answer(429, 'Concurrent generation is locked'))))
      .mockImplementationOnce(() => zipReply())
      .mockImplementationOnce(() => Promise.reject(answer(500, 'Upstream GPU melted')))
      .mockImplementation(() => zipReply());
    const recipe = await h.ok('prepare_recipe', { mode: 't2i', canvas: { workspaceId: h.workspaceId, expectedRevision: await h.revision() } });
    const receipt = await h.ok('enqueue_recipes', { requestKey: 'e2e-no-stop', items: [{ ...ref(recipe), count: 4, seeds: [31, 32, 33, 34] }] });
    const later = await h.ok('enqueue_recipes', { requestKey: 'e2e-no-stop-later', items: [{ ...ref(recipe), seeds: [41] }] });
    await waitUntil(() => expect(fixture.post).toHaveBeenCalledTimes(1));
    // The later batch waits behind the four images of the first; no image time is known yet.
    expect(await h.ok('read_queue', { batchId: later.batch.batchId })).toMatchObject({ status: 'queued', ahead: { images: 4, batches: 1 }, etaSeconds: null });
    // A wait for the next result returns once the first image is saved.
    const waiting = h.ok('read_queue', { batchId: receipt.batch.batchId, wait: { until: 'next', seconds: 60 } });
    held.resolve(await zipReply());
    const next = await waiting;
    expect(next.wait).toMatchObject({ until: 'next', ended: 'next' });
    expect(next).toMatchObject({ status: 'running', results: [{ itemIndex: 0, actualSeed: 31 }] });
    limited.resolve();
    // Then a wait for the end: the 429 was sent again (same seed), the 500 marked only its image, the rest ran.
    const done = await h.ok('read_queue', { batchId: receipt.batch.batchId, wait: { until: 'done', seconds: 60 } });
    expect(done).toMatchObject({ status: 'partial', stopReason: null, wait: { ended: 'done' }, itemCounts: { succeeded: 3, unknown: 1, failed: 0 }, ahead: { images: 0, batches: 0 }, etaSeconds: 0 });
    expect(done.items.map((item: any) => [item.status, item.rateLimitRetries ?? 0])).toEqual([['succeeded', 0], ['succeeded', 1], ['unknown', 0], ['succeeded', 0]]);
    expect(fixture.post.mock.calls.slice(0, 5).map(([, body]: any[]) => body.parameters.seed)).toEqual([31, 32, 32, 33, 34]);
    const after = await h.ok('read_queue', { batchId: later.batch.batchId, wait: { until: 'done', seconds: 60 } });
    expect(after).toMatchObject({ status: 'succeeded', wait: { ended: 'done' } });
    expect(after.imageSeconds).toEqual(expect.any(Number));
    // The whole batch at once: three thumbnails in item order.
    const all = await h.call('get_queue_result', { batchId: receipt.batch.batchId });
    expect(all.ok, JSON.stringify(all.value)).toBe(true);
    expect(all.value).toMatchObject({ status: 'partial', total: 3, returned: 3, nextOffset: null });
    expect(all.value.results.map((entry: any) => [entry.itemIndex, entry.actualSeed, entry.imageAttached, entry.width <= 384])).toEqual([[0, 31, true, true], [1, 32, true, true], [3, 34, true, true]]);
    const images = all.content.filter((entry: any) => entry.type === 'image');
    expect(images).toHaveLength(3);
    expect(images.every((entry: any) => entry.mimeType === 'image/webp')).toBe(true);
  });

  it('i2i: the canvas source is copied into the recipe; preview saves nothing; the queued image carries its seed and can be exported into the project', async () => {
    const h = await start();
    const source = png(64, 64, 30);
    useAppStore.setState({ workbenchImage: { filePath: path.join(base, 'canvas-source.png'), fileUrl: `data:image/png;base64,${source.toString('base64')}`, width: 64, height: 64 }, i2iParams: { strength: 0.45, noise: 0, extraNoiseSeed: 77 } });
    const r0 = await h.revision();
    const preview = await h.ok('prepare_recipe', { mode: 'i2i', canvas: { workspaceId: h.workspaceId, expectedRevision: r0 }, preview: true });
    expect(preview).toMatchObject({ preview: true, saved: false, lineage: 'canvas', source: { kind: 'embedded', width: 64, height: 64 } });
    const recipe = await h.ok('prepare_recipe', { mode: 'i2i', canvas: { workspaceId: h.workspaceId, expectedRevision: r0 } });
    expect(recipe).toMatchObject({ lineage: 'canvas', saved: true, source: { kind: 'embedded', width: 64, height: 64 }, effective: { i2i: { strength: 0.45, extraNoiseSeed: 77 } } });
    // The canvas image changes afterwards; the recipe keeps the captured bytes.
    useAppStore.setState({ workbenchImage: { filePath: path.join(base, 'later.png'), fileUrl: `data:image/png;base64,${png(64, 64, 250).toString('base64')}`, width: 64, height: 64 } });
    const receipt = await h.ok('enqueue_recipes', { requestKey: 'e2e-canvas-i2i', items: [{ ...ref(recipe), seeds: [21] }] });
    const read = await h.settle(receipt.batch.batchId);
    expect(read.status).toBe('succeeded');
    expect(read.results).toEqual([expect.objectContaining({ itemIndex: 0, index: 0, actualSeed: 21, file: null })]);
    const body = fixture.post.mock.calls[0][1];
    expect(body.action).toBe('img2img');
    expect(Buffer.from(body.parameters.image, 'base64').equals(Buffer.from(source))).toBe(true);
    expect((await h.ok('get_queue_result', { batchId: receipt.batch.batchId, itemIndex: 0 })).actualSeed).toBe(21);

    // The saved original is outside the project (file:null); asset_library export copies it in, never overwriting.
    const listed = await h.ok('asset_library', { action: 'list', category: 'history', queueBatchId: receipt.batch.batchId });
    expect(listed.items).toHaveLength(1);
    const item = listed.items[0], target = { kind: 'history', id: item.id, revision: item.revision, assetId: item.image.preview.assetId };
    const exported = await h.ok('asset_library', { action: 'export', ...target });
    expect(exported).toMatchObject({ pathBase: 'project-root', projectRoot: 'NOVELAI_PROJECT_ROOT', exported: true, mimeType: 'image/png', width: 64, height: 64 });
    expect(exported.file).toMatch(/^novelai\/library-exports\/history-.+-r1\.png$/);
    const saved = fixture.history.find(entry => entry.id === item.id);
    expect(await fs.readFile(path.join(h.projectRoot, exported.file))).toEqual(await fs.readFile(saved.filePath));
    const again = await h.ok('asset_library', { action: 'export', ...target });
    expect(again.file).toBe(exported.file.replace(/\.png$/, '-2.png'));
    expect(await fs.readFile(path.join(h.projectRoot, exported.file))).toEqual(await fs.readFile(saved.filePath));
    const exportsDir = path.join(h.projectRoot, 'novelai', 'library-exports'), elsewhere = path.join(base, 'elsewhere');
    await fs.rename(exportsDir, path.join(base, 'moved-exports')); await fs.mkdir(elsewhere); await fs.symlink(elsewhere, exportsDir);
    expect(await h.refused('asset_library', { action: 'export', ...target })).toMatchObject({ code: 'invalid_input' });
    expect(await fs.readdir(elsewhere)).toEqual([]);
  });
});
