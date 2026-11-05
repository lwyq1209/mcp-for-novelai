/**
 * Step 4a acceptance 4 (manual generation in the shared queue, end to end without a window): the real renderer Store
 * (its Generate, i2i, inpaint, upscale actions, Pause and Stop) and workspace adapter talk through a preload-shaped
 * API to the real host services — manual generation (manual-generation.ts), the shared batch scheduler, the
 * single-image generation service, the real nai.ts request builders and file saving, the recipe store, the queue UI
 * handler — and an MCP server over the real HTTP bridge (agent batches, apply_edit). Only NovelAI is a stub (axios
 * answers a ZIP or an event stream), the account store is a fixture and every folder is temporary.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';

const fixture = vi.hoisted(() => ({ outputDir: '', groups: [] as Array<{ id: string; name: string; createdAt: string }>, history: [] as any[], post: vi.fn(), onHistory: (_items: any[]) => {}, stream: true }));
/** axios as the app uses it: a request whose signal aborts rejects at once with ERR_CANCELED, also while its reply is pending. */
const abortable = (url: string, body: unknown, config: any) => {
  const reply = Promise.resolve(fixture.post(url, body, config)), signal: AbortSignal | undefined = config?.signal;
  if (!signal) return reply;
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    reply.then(resolve, reject);
  });
};
vi.mock('electron', async () => {
  const { PNG } = await import('pngjs');
  const make = (png: any): any => ({
    isEmpty: () => false, getSize: () => ({ width: png.width, height: png.height }), toPNG: () => PNG.sync.write(png),
    resize({ width, height }: { width: number; height: number }) { const out = new PNG({ width, height }); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const sx = Math.min(png.width - 1, Math.floor(x * png.width / width)), sy = Math.min(png.height - 1, Math.floor(y * png.height / height)); png.data.copy(out.data, (y * width + x) * 4, (sy * png.width + sx) * 4, (sy * png.width + sx) * 4 + 4); } return make(out); },
  });
  return { app: { getPath: () => fixture.outputDir }, dialog: {}, nativeImage: { createFromBuffer(buffer: Buffer) { try { return make(PNG.sync.read(Buffer.from(buffer))); } catch { return { isEmpty: () => true }; } } } };
});
vi.mock('axios', () => ({ default: { post: (url: string, body: unknown, config: unknown) => abortable(url, body, config), isCancel: (error: any) => error?.code === 'ERR_CANCELED' } }));
vi.mock('./ipc/store', () => ({
  getToken: () => 'synthetic-test-token',
  getSettings: () => ({ imageBaseUrl: 'https://generation-fixture.example.test', allowCustomEndpoint: true, allowCustomEndpointFallback: true, streamPreviewEnabled: fixture.stream, outputDir: fixture.outputDir, generationGroupId: '', keepImageMetadata: true, imageNameTemplate: '' }),
  getHistoryGroups: () => fixture.groups,
  ensureHistoryGroup: (name: string) => { const existing = fixture.groups.find(group => group.name.toLowerCase() === name.toLowerCase()); if (existing) return existing; const created = { id: `group-${fixture.groups.length + 1}`, name, createdAt: new Date().toISOString() }; fixture.groups.push(created); return created; },
  getAccountSummary: () => ({ hasToken: true }), addHistory: (items: any[]) => { fixture.history.push(...structuredClone(items)); fixture.onHistory(structuredClone(items)); return []; },
  setAccountSummary: vi.fn(), setToken: vi.fn(), updateHistoryItem: vi.fn(),
}));
vi.mock('./ipc/logger', () => ({ logError: vi.fn(), logInfo: vi.fn(), appendLog: vi.fn() }));
vi.mock('./ipc/proxy', () => ({ proxyConfig: () => ({}) }));

import { augmentImg, generateI2I, generateImage, inpaintImage, loadImageFromPath, upscaleImg } from './ipc/nai';
import { cancelAllJobs, hasActiveGenerationJobs, reserveQueueGeneration } from './ipc/job-registry';
import { createGenerationService } from './generation-service';
import { createBatchService } from './batch-service';
import { createQueueRecipeService, QUEUE_METHODS } from './queue-recipe-service';
import { createManualGeneration, createManualSourceStore } from './manual-generation';
import { createQueueUiHandler, queueBatchEvent } from './queue-ui';
import { queueBridgeError } from './queue-bridge-error';
import { BridgeError, startHttpBridge } from './bridge-server';
import { useAppStore } from '../src/store';
import { DEFAULT_PARAMS } from '../src/types';
import { createRendererWorkspace } from '../src/workspace/adapter';
import type { BatchJob } from '../src/workspace/batch-types';
import type { ManualItemEvent } from '../src/workspace/manual-batches';
import { createBridgeClient, createNovelAiMcpServer } from '../../src/mcp.mjs';
import { Client } from '../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { waitUntil } from '../src/test-support/wait-until';

const png = (width: number, height: number, value: number) => { const image = new PNG({ width, height }); for (let i = 0; i < image.data.length; i += 4) image.data.set([value, (i / 4) % 255, 120, 255], i); return PNG.sync.write(image); };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
async function zipReply(width = 64, height = 64, value = 200) { const zip = new JSZip(); zip.file('image_0.png', png(width, height, value)); return { data: await zip.generateAsync({ type: 'nodebuffer' }) }; }
/** The streaming endpoint's event stream: one intermediate frame, then the final image. */
function streamReply(width = 64, height = 64) {
  const image = png(width, height, 90).toString('base64');
  const body = `event: intermediate\ndata: {"samp_ix":0,"step_ix":0,"image":"${image}"}\n\nevent: final\ndata: {"samp_ix":0,"image":"${image}"}\n\n`;
  return { data: (async function* () { yield Buffer.from(body); })(), headers: { 'content-type': 'text/event-stream' } };
}
const urlOf = (call: any[]) => String(call[0]);

let base = '';
const closers: Array<() => Promise<unknown> | unknown> = [];
beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'novelai-manual-queue-e2e-')));
  fixture.outputDir = path.join(base, 'pictures'); await fs.mkdir(fixture.outputDir, { recursive: true });
  fixture.groups = []; fixture.history = []; fixture.stream = true; fixture.post.mockReset();
  fixture.post.mockImplementation((url: string) => String(url).endsWith('/ai/generate-image-stream') ? Promise.resolve(streamReply()) : zipReply());
  useAppStore.setState(useAppStore.getInitialState(), true);
  vi.stubGlobal('document', { querySelector: () => null });
  vi.stubGlobal('Image', class { naturalWidth = 0; naturalHeight = 0; onload: (() => void) | null = null; onerror: (() => void) | null = null; decode = () => Promise.resolve();
    set src(value: string) { queueMicrotask(() => { try { const image = PNG.sync.read(Buffer.from(value.split(',')[1] ?? '', 'base64')); this.naturalWidth = image.width; this.naturalHeight = image.height; } catch { /* a local-media URL */ } this.onload?.(); }); } });
});
afterEach(() => runCleanups([...closers.splice(0).reverse(), () => cancelAllJobs(), () => vi.unstubAllGlobals(), () => fs.rm(base, { recursive: true, force: true })]));

async function start(options: { enqueueItemLimit?: number } = {}) {
  const runtimeDir = path.join(base, 'runtime'), projectRoot = path.join(base, 'project');
  await fs.mkdir(runtimeDir, { recursive: true }); await fs.mkdir(projectRoot, { recursive: true });
  const listeners = { batch: new Set<(batch: BatchJob) => void>(), item: new Set<(event: ManualItemEvent) => void>(), preview: new Set<(event: any) => void>(), job: new Set<(job: any) => void>() };
  const previews: any[] = [];
  const sizeOf = (bytes: Buffer) => { const image = PNG.sync.read(bytes); return { width: image.width, height: image.height }; };
  // As main.ts wires them.
  const generation = createGenerationService({ isBusy: hasActiveGenerationJobs, reserve: reserveQueueGeneration, validateImage: sizeOf,
    async execute(mode, snapshot, execution) {
      if (mode === 't2i') return generateImage(snapshot.params, snapshot.extras, undefined, execution);
      if (mode === 'i2i' || mode === 'enhance') return generateI2I(snapshot.params, snapshot.i2i!, snapshot.extras, execution);
      if (mode === 'upscale') { const result = await upscaleImg(snapshot.upscale!.scale, snapshot.params.model, execution); return { ...result, items: result.ok && result.item ? [result.item] : [] }; }
      if (mode === 'director') return augmentImg(snapshot.director!.tool, snapshot.director!.options, execution);
      return inpaintImage(snapshot.params, snapshot.inpaint!.model, snapshot.inpaint!.maskBase64, snapshot.inpaint!.strength, 0, execution);
    },
    onJob: job => listeners.job.forEach(listener => listener(structuredClone(job))),
    onPreview: (_job, queue, preview) => { const event = { ...preview, requestId: queue.batchId }; previews.push(event); listeners.preview.forEach(listener => listener(event)); },
    onManualSettled: ({ job, queue, items }) => { const event: ManualItemEvent = { batchId: queue.batchId, requestKey: queue.requestKey, itemIndex: queue.itemIndex, mode: job.mode as any, status: job.status as any, items, actualSeed: job.actualSeed, error: job.error }; listeners.item.forEach(listener => listener(structuredClone(event))); } });
  const batch = createBatchService({ generation, isBusy: hasActiveGenerationJobs, runtimeDir,
    onBatch: job => { const event = queueBatchEvent(job); if (event) listeners.batch.forEach(listener => listener(structuredClone(event))); } });
  closers.push(() => batch.dispose());
  const queue: any = createQueueRecipeService({ runtimeDir, batch, generation, ...(options.enqueueItemLimit ? { enqueueItemLimit: () => options.enqueueItemLimit! } : {}), historyById: id => fixture.history.find(item => item.id === id) ?? null, validateImage: data => sizeOf(data), recipeReclaim: { auto: false } });
  const sources = createManualSourceStore();
  const manual = createManualGeneration({ batch, sources });
  const queueUi = createQueueUiHandler(queue);
  const enqueueCalls: any[] = [];
  /** Set to make the next enqueue reply be lost after the host queued it (an IPC failure). */
  const lose = { next: false };

  // The renderer: the real Store and workspace adapter over a preload-shaped API.
  const api: any = {
    getSettings: async () => ({ language: 'en-US', modelMode: 'anime', streamPreviewEnabled: true }), accountCached: async () => ({ hasToken: true, anlasBalance: 1000 }), isFirstRun: async () => false,
    getHistoryDates: async () => [], getHistoryGroups: async () => [], getHistory: async () => [], getHistoryItems: async () => ({ order: [], items: [] }),
    hasToken: async () => ({ hasToken: true, anlasBalance: 1000, tierName: 'Opus' }), quoteAnlas: async () => ({ ok: true, amount: 0, balance: 1000 }),
    onUpdateEvent: () => () => {}, getUpdateStatus: async () => null, setSetting: vi.fn(async () => {}),
    onGenerationPreview: (listener: any) => { listeners.preview.add(listener); return () => listeners.preview.delete(listener); },
    onQueueBatch: (listener: any) => { listeners.batch.add(listener); return () => listeners.batch.delete(listener); },
    onManualItem: (listener: any) => { listeners.item.add(listener); return () => listeners.item.delete(listener); },
    onGenerationJob: (listener: any) => { listeners.job.add(listener); return () => listeners.job.delete(listener); },
    queueCall: (method: string, args: Record<string, unknown>) => queueUi(method, args),
    manualEnqueue: async (request: any) => {
      enqueueCalls.push(structuredClone(request));
      let reply; try { reply = { ok: true, result: await manual.enqueue(request) }; } catch (error: any) { reply = { ok: false, error: { code: error.code ?? 'failed', message: error.message } }; }
      if (lose.next) { lose.next = false; throw new Error('IPC reply lost'); }
      return reply;
    },
    manualLookup: async (requestKey: string) => ({ ok: true, result: manual.lookup({ requestKey }) }),
    manualCaptureSource: async (filePath: string) => { try { return { ok: true, result: await sources.capture(filePath) }; } catch (error: any) { return { ok: false, error: { code: error.code ?? 'failed', message: error.message, ...(error.reason ? { reason: error.reason } : {}), ...(error.params ? { params: error.params } : {}) } }; } },
    loadImageFromPath: (file: string) => loadImageFromPath(file),
    workspacePromptReview: async () => ({ ok: false, error: { code: 'unused', message: 'unused' } }),
  };
  vi.stubGlobal('window', { naiDesktop: api });
  await useAppStore.getState().load();
  useAppStore.setState({ account: { hasToken: true, anlasBalance: 1000, tierName: 'Opus' } as any, params: { ...DEFAULT_PARAMS, model: 'nai-diffusion-4-5-full', positivePrompt: 'a harbor at dawn', negativePrompt: '', stylePrompt: '', width: 64, height: 64, steps: 1, seed: 5, seedMode: 'fixed', promptAssemblyVersion: 1 } });
  const workspace = createRendererWorkspace(); closers.push(() => workspace.dispose());
  const toRenderer = async (method: string, args: Record<string, unknown>) => {
    const response: any = await workspace.handle({ requestId: randomUUID(), method, args });
    if (response.error) throw new BridgeError(response.error.code, response.error.message, /conflict/.test(response.error.code) ? 409 : 400, response.error.details);
    return response.result;
  };
  const wrap = (call: (args: any) => Promise<any>) => async (args: any) => { try { return await call(args); } catch (error) { throw queueBridgeError(error); } };
  const hostMethods: Record<string, (args: any) => Promise<any>> = Object.fromEntries(QUEUE_METHODS.map(method => [method, wrap(args => queue[method](args))]));
  const bridge = await startHttpBridge({ runtimeDir, dispatch: async (method, args) => Object.hasOwn(hostMethods, method) ? hostMethods[method](args) : toRenderer(method, args) }); closers.push(() => bridge.close());
  const server = createNovelAiMcpServer({ bridgeClient: createBridgeClient({ runtimeDir }), projectRoot, projectRootSource: 'NOVELAI_PROJECT_ROOT' });
  const client = new Client({ name: 'claude-code', version: '2.1.112' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  closers.push(async () => { await client.close(); await server.close(); });
  const ok = async (name: string, args: Record<string, unknown> = {}) => { const result: any = await client.callTool({ name, arguments: args }); expect(result.isError, `${name}: ${JSON.stringify(result.structuredContent).slice(0, 1500)}`).not.toBe(true); return result.structuredContent; };
  const workspaceId = (await ok('list_workspaces')).workspaces[0].workspaceId;
  const revision = async () => (await ok('read_workspace', { workspaceId, includeImages: false })).revision;
  const listed = async () => (await queue.list_queue({})).batches as any[];
  const settled = () => waitUntil(() => { expect({ batches: useAppStore.getState().manualBatches, status: useAppStore.getState().statusText }).toMatchObject({ batches: [] }); expect(useAppStore.getState().manualPreparing).toBe(false); }, { interval: 20 });
  const agentRecipe = async (positivePrompt: string) => ok('prepare_recipe', { mode: 't2i', model: 'nai-diffusion-4-5-full', width: 64, height: 64, steps: 1, cfgScale: 5, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', ucPreset: 0, qualityPreset: 'standard', stylePrompt: '', positivePrompt, negativePrompt: '', seed: 9 });
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as any;
  return { queue, manual, sources, batch, generation, ok, call, workspaceId, revision, listed, settled, previews, enqueueCalls, lose, agentRecipe, queueUi };
}
const ref = (recipe: any) => ({ recipeId: recipe.recipeId, recipeRevision: recipe.recipeRevision, inputHash: recipe.inputHash });

describe('manual generation through the shared queue', () => {
  it('a click of 25 images runs every one of them (item indexes past 19), and an agent can read the last', async () => {
    const h = await start();
    fixture.stream = false;
    useAppStore.setState(state => ({ batchCount: 25, params: { ...state.params, seed: 100 } }));
    await useAppStore.getState().generate();
    await h.settled();
    const [batch] = await h.listed();
    expect(batch).toMatchObject({ status: 'succeeded', count: 25, error: null, source: { kind: 'manual', persistent: false } });
    expect(batch.items.map((item: any) => [item.status, item.actualSeed])).toEqual(Array.from({ length: 25 }, (_, index) => ['succeeded', 100 + index]));
    expect(fixture.post).toHaveBeenCalledTimes(25);
    expect(fixture.history).toHaveLength(25);
    expect(await h.ok('get_queue_result', { batchId: batch.batchId, itemIndex: 24 })).toMatchObject({ actualSeed: 124, imageAttached: true });
    expect(useAppStore.getState().statusText).toBe('Batch generation complete: 25 images, spent 0 Anlas.');
  }, 60_000);

  it('an agent batch of 25 images runs every one of them when the per-enqueue setting allows 200', async () => {
    const h = await start({ enqueueItemLimit: 200 });
    fixture.stream = false;
    const recipe = await h.agentRecipe('an agent series');
    const seeds = Array.from({ length: 25 }, (_, index) => 300 + index);
    const receipt = await h.ok('enqueue_recipes', { requestKey: 'agent-twenty-five', items: [{ ...ref(recipe), count: 25, seeds }] });
    await waitUntil(async () => expect((await h.listed())[0].status).toBe('succeeded'), { timeout: 30_000 });
    const [batch] = await h.listed();
    expect(batch.batchId).toBe(receipt.batch.batchId);
    expect(batch.items.map((item: any) => [item.status, item.actualSeed])).toEqual(seeds.map(seed => ['succeeded', seed]));
    expect(fixture.history.map(item => item.queueOrigin.itemIndex)).toEqual(Array.from({ length: 25 }, (_, index) => index));
    expect(await h.ok('get_queue_result', { batchId: batch.batchId, itemIndex: 24 })).toMatchObject({ actualSeed: 324 });
  }, 60_000);

  it('starts at once on an idle queue, streams its preview and puts the result on the canvas; it is a manual batch without queue origin', async () => {
    const h = await start();
    await useAppStore.getState().generate();
    await h.settled();
    expect(h.enqueueCalls).toHaveLength(1);
    const [batch] = await h.listed();
    expect(batch).toMatchObject({ status: 'succeeded', count: 1, mode: 't2i', source: { kind: 'manual', persistent: false } });
    expect(batch.requestKey).toMatch(/^manual-/);
    // The stream went to the streaming endpoint and its frames reached the window under this batch's id.
    expect(fixture.post.mock.calls.map(urlOf)).toEqual(['https://generation-fixture.example.test/ai/generate-image-stream']);
    expect(h.previews.map(event => [event.requestId, event.progress])).toEqual([[batch.batchId, 0.99], [batch.batchId, 1]]);
    const saved = fixture.history[0];
    expect(useAppStore.getState().currentImage?.id).toBe(saved.id);
    expect(useAppStore.getState().params.seed).toBe(5);
    expect(saved).not.toHaveProperty('queueOrigin'); expect(saved).not.toHaveProperty('generationOrigin');
    expect(useAppStore.getState().currentImage).not.toHaveProperty('generationOrigin');
    // Step 4b3c: the saved record names the click's mode (feature), and the library reads it as a manual t2i image.
    expect(saved.feature).toBe('t2i');
    expect(useAppStore.getState()).toMatchObject({ isGenerating: false, activeGenerationRunId: null, generationPhase: 'idle' });
    // An agent sees the manual batch in the shared queue, with its source and saved file.
    const listedByAgent = await h.ok('list_queue');
    expect(listedByAgent.batches).toEqual([expect.objectContaining({ batchId: batch.batchId, source: { kind: 'manual', persistent: false }, status: 'succeeded' })]);
    const read = await h.ok('read_queue', { batchId: batch.batchId });
    expect(read).toMatchObject({ source: { kind: 'manual', persistent: false }, results: [{ itemIndex: 0, historyId: saved.id, fileName: path.basename(saved.filePath) }] });
    expect(await h.ok('get_queue_result', { batchId: batch.batchId, itemIndex: 0 })).toMatchObject({ historyId: saved.id, actualSeed: 5, imageAttached: true });
  });

  it('waits behind an agent batch and reports the images ahead; the agent image never reaches the canvas; apply_edit works while the queue runs', async () => {
    const h = await start();
    const recipe = await h.agentRecipe('an agent lighthouse');
    const held = deferred<any>(), manualHeld = deferred<any>();
    fixture.post.mockImplementationOnce(() => held.promise).mockImplementationOnce(() => zipReply()).mockImplementationOnce(() => manualHeld.promise);
    const receipt = await h.ok('enqueue_recipes', { requestKey: 'agent-first', items: [{ ...ref(recipe), count: 2, seeds: [11, 12] }] });
    await waitUntil(() => expect(fixture.post).toHaveBeenCalledTimes(1));
    // A draft is applied while the agent batch runs.
    const r0 = await h.revision();
    const draft = await h.ok('draft_edit', { workspaceId: h.workspaceId, expectedRevision: r0, patch: { params: { positivePrompt: 'a manual pier' } } });
    expect((await h.ok('apply_edit', { workspaceId: h.workspaceId, expectedRevision: r0, draftId: draft.draftId })).revision).toBe(r0 + 1);
    await useAppStore.getState().generate();
    expect(useAppStore.getState().statusText).toBe('Added to the queue; 2 ahead.');
    expect(useAppStore.getState().generationPhase).toBe('queued');
    expect(useAppStore.getState().isGenerating).toBe(false);
    const [manualBatch, agentBatch] = await h.listed();
    expect(manualBatch).toMatchObject({ status: 'queued', source: { kind: 'manual', persistent: false } });
    expect(agentBatch).toMatchObject({ batchId: receipt.batch.batchId, status: 'running' });
    expect(agentBatch.source).toBeUndefined(); // this harness sends no caller: an agent batch of unknown client
    // The agent batch ends while the manual image is being generated: its images never reach the canvas.
    held.resolve(await zipReply());
    await waitUntil(async () => expect((await h.listed()).map(value => value.status)).toEqual(['running', 'succeeded']));
    await waitUntil(() => expect(useAppStore.getState()).toMatchObject({ isGenerating: true, generationPhase: 'requesting' }));
    expect(useAppStore.getState().currentImage).toBeNull();
    manualHeld.resolve(streamReply());
    await h.settled();
    const batches = await h.listed();
    expect(batches.map(value => [value.source?.kind ?? 'agent', value.status])).toEqual([['manual', 'succeeded'], ['agent', 'succeeded']]);
    const manualImage = fixture.history.find(item => !item.queueOrigin);
    expect(fixture.history.filter(item => item.queueOrigin)).toHaveLength(2);
    expect(useAppStore.getState().currentImage?.id).toBe(manualImage.id);
    expect(manualImage.params.positivePrompt).toBe('a manual pier');
    expect(manualImage.feature).toBe('t2i');
    expect(fixture.history.filter(item => item.queueOrigin).every(item => item.feature === undefined)).toBe(true);
    // The agent images ran first; the manual one after them.
    expect(fixture.post.mock.calls.map(urlOf).map(url => url.endsWith('-stream'))).toEqual([false, false, true]);
  });

  it('a manual batch of three counts its fixed seed up and draws {a|b} per image; a lost reply is looked up, never queued twice', async () => {
    const h = await start();
    vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.9).mockReturnValue(0);
    fixture.stream = false;
    useAppStore.setState(state => ({ batchCount: 3, params: { ...state.params, positivePrompt: '{red|blue} mug', seed: 40 } }));
    h.lose.next = true;
    await useAppStore.getState().generate();
    await h.settled();
    expect(h.enqueueCalls).toHaveLength(1);
    const batches = await h.listed();
    expect(batches).toHaveLength(1);
    expect(batches[0].items.map((item: any) => [item.plannedSeed, item.status])).toEqual([[40, 'succeeded'], [41, 'succeeded'], [42, 'succeeded']]);
    expect(fixture.post.mock.calls.map(([, body]: any[]) => body.input.includes('red mug') ? 'red' : body.input.includes('blue mug') ? 'blue' : '?')).toEqual(['red', 'blue', 'red']);
    expect(useAppStore.getState().params.seed).toBe(42);
    // The same requestKey again (a renderer retry) returns the same batch; nothing is queued twice.
    const again = await h.manual.enqueue({ ...h.enqueueCalls[0] });
    expect(again.batch.batchId).toBe(batches[0].batchId);
    expect(await h.listed()).toHaveLength(1);
  });

  it('i2i freezes the workbench of the click; inpaint sends its mask; upscale 4× makes two requests', async () => {
    const h = await start();
    fixture.stream = false;
    const sourceFile = path.join(base, 'source.png'); await fs.writeFile(sourceFile, png(64, 64, 30));
    await useAppStore.getState().loadWorkbenchFromPath(sourceFile, { silent: true });
    useAppStore.setState({ i2iParams: { strength: 0.4, noise: 0.1, extraNoiseSeed: 7 }, i2iSourceMode: 'original' });
    await useAppStore.getState().generateI2I();
    // The workbench changes right after the click; the queued image keeps the clicked source.
    await fs.writeFile(path.join(base, 'later.png'), png(64, 64, 250));
    await h.settled();
    const i2iBody = fixture.post.mock.calls.at(-1)![1];
    expect(i2iBody.action).toBe('img2img');
    // (The request always sends noise 0, as the manual i2i always did.)
    expect(i2iBody.parameters).toMatchObject({ strength: 0.4, noise: 0, extra_noise_seed: 7 });
    expect(Buffer.from(i2iBody.parameters.image, 'base64').equals(png(64, 64, 30))).toBe(true);

    const mask = png(64, 64, 255).toString('base64');
    useAppStore.setState({ inpaintMask: mask, inpaintModel: 'nai-diffusion-4-5-full-inpainting', inpaintStrength: 1, inpaintSourceMode: 'original' });
    // Without a prompt the host refuses before any request, and the window says why.
    await useAppStore.getState().inpaint();
    await h.settled();
    expect(useAppStore.getState().toast).toContain('Enter a positive prompt.');
    const requests = fixture.post.mock.calls.length;
    useAppStore.setState({ inpaintPositivePrompt: 'a red flower' });
    await useAppStore.getState().inpaint();
    await h.settled();
    expect(fixture.post.mock.calls.length).toBe(requests + 1);
    expect(fixture.post.mock.calls.at(-1)![1].action).toBe('infill');

    fixture.post.mockClear();
    useAppStore.setState({ upscaleScale: 4 });
    await useAppStore.getState().upscaleCurrentImage();
    await h.settled();
    expect(fixture.post.mock.calls.map(urlOf).filter(url => url.endsWith('/ai/upscale'))).toHaveLength(2);
    const modes = (await h.listed()).map(value => [value.mode, value.status]);
    expect(modes).toEqual([['upscale', 'succeeded'], ['inpaint', 'succeeded'], ['inpaint', 'blocked'], ['i2i', 'succeeded']]);
    expect((await h.listed()).every(value => value.source?.kind === 'manual')).toBe(true);
    expect(useAppStore.getState().currentImage?.id).toBe(fixture.history.at(-1).id);
  });

  it('Stop while the image is being generated aborts its request: the batch is cancelled, nothing is saved, and the window says so', async () => {
    const h = await start();
    fixture.stream = false;
    useAppStore.setState({ batchCount: 2 });
    const held = deferred<any>();
    fixture.post.mockImplementationOnce(() => held.promise);
    await useAppStore.getState().generate();
    await waitUntil(() => expect(fixture.post).toHaveBeenCalledTimes(1));
    await useAppStore.getState().cancel();
    // The reply that would have come back after the abort is never read.
    held.resolve(await zipReply());
    await h.settled();
    const [batch] = await h.listed();
    expect(batch.status).toBe('cancelled');
    expect(batch.items.map((item: any) => item.status)).toEqual(['cancelled', 'cancelled']);
    expect(batch.items[0].error).toMatchObject({ code: 'cancelled' });
    expect(fixture.post).toHaveBeenCalledTimes(1);
    expect(fixture.history).toHaveLength(0);
    expect(useAppStore.getState().currentImage).toBeNull();
    expect(useAppStore.getState().statusText).toBe('Batch cancelled: 0 succeeded, spent 0 Anlas. The image being generated was stopped; if its request was already sent it may have been charged, and the image is not saved.');
    // A batch stopped while it waited says only that it was cancelled.
    const blocker = deferred<any>();
    fixture.post.mockImplementationOnce(() => blocker.promise);
    useAppStore.setState({ batchCount: 1 });
    await useAppStore.getState().generate();
    await waitUntil(() => expect(fixture.post).toHaveBeenCalledTimes(2));
    await useAppStore.getState().generate();
    await waitUntil(() => expect(useAppStore.getState().manualBatches).toHaveLength(2));
    const waiting = useAppStore.getState().manualBatches[1];
    const response: any = await h.queueUi('cancel_queue', { batchId: waiting.batchId });
    expect(response.result.status).toBe('cancelled');
    blocker.resolve(await zipReply());
    await h.settled();
    expect(fixture.history).toHaveLength(1);
  }, 30_000);

  it('an ended manual image keeps none of its reference, source or mask bytes; the ended batch keeps no frozen recipe', async () => {
    const h = await start();
    fixture.stream = false;
    const vibe = png(256, 256, 77).toString('base64');
    useAppStore.setState({ batchCount: 3, vibeImages: [{ id: 'v', base64: vibe, infoExtracted: 1, strength: 0.6, previewUrl: '' }] as any,
      preciseReferences: [{ id: 'p', base64: vibe, type: 'character', strength: 0.5, fidelity: 1, previewUrl: '' }] as any });
    // The second image fails, the third is cancelled while it runs: every ending releases its inputs.
    const held = deferred<any>();
    let requests = 0;
    fixture.post.mockImplementation((url: string) => { if (!String(url).includes('/ai/generate-image')) return zipReply(); requests++; return requests === 2 ? Promise.reject(Object.assign(new Error('x'), { response: { status: 500, data: Buffer.from('upstream') } })) : requests === 3 ? held.promise : zipReply(); });
    await useAppStore.getState().generate();
    const [running] = await h.listed();
    await waitUntil(() => expect(requests).toBe(3));
    expect(h.batch.heldInputBytes({ workspaceId: 'recipe-queue', batchId: running.batchId })).toBeGreaterThan(vibe.length);
    await useAppStore.getState().cancel();
    held.resolve(await zipReply());
    await h.settled();
    const [batch] = await h.listed();
    expect(batch.items.map((item: any) => item.status)).toEqual(['succeeded', 'unknown', 'cancelled']);
    const jobs = batch.items.map((item: any) => item.jobId);
    expect(jobs.every(Boolean)).toBe(true);
    for (const jobId of jobs) expect(h.generation.heldInputs({ workspaceId: 'recipe-queue', jobId })).toEqual({ source: 0, mask: 0, references: 0 });
    expect(h.batch.heldInputBytes({ workspaceId: 'recipe-queue', batchId: batch.batchId })).toBe(0);
  }, 30_000);

  it('a stray entry in the frozen-queue folder stops the agent side (naming it); Generate, Pause and Stop keep working', async () => {
    await fs.mkdir(path.join(base, 'runtime', 'frozen-queue'), { recursive: true });
    await fs.writeFile(path.join(base, 'runtime', 'frozen-queue', 'notes.txt'), 'stray');
    const h = await start();
    fixture.stream = false;
    await useAppStore.getState().generate();
    await h.settled();
    expect(fixture.history).toHaveLength(1);
    expect(useAppStore.getState().currentImage?.id).toBe(fixture.history[0].id);
    expect(useAppStore.getState().statusText).toBe('Generation complete; saved 1 image, spent 0 Anlas.');
    // Pause and Stop of a manual batch go through the queue as usual.
    useAppStore.setState({ batchCount: 3 });
    const held = deferred<any>();
    fixture.post.mockImplementationOnce(() => held.promise);
    await useAppStore.getState().generate();
    await waitUntil(() => expect(fixture.post).toHaveBeenCalledTimes(2));
    await useAppStore.getState().togglePause();
    held.resolve(await zipReply());
    await waitUntil(() => expect(useAppStore.getState().manualBatches[0]?.status).toBe('paused'));
    await useAppStore.getState().togglePause();
    await waitUntil(() => expect(fixture.post).toHaveBeenCalledTimes(3));
    await useAppStore.getState().cancel();
    await h.settled();
    expect(useAppStore.getState().statusText).toMatch(/^Batch cancelled: [12] succeeded/);
    // The agent side fails closed and names the entry.
    const recipe = await h.agentRecipe('an agent lighthouse');
    for (const [tool, args] of [['list_queue', {}], ['enqueue_recipes', { requestKey: 'agent-blocked', items: [{ ...ref(recipe), count: 1, seeds: [3] }] }]] as const) {
      const result = await h.call(tool, args);
      expect(result.isError, tool).toBe(true);
      expect(JSON.stringify(result.structuredContent ?? result.content), tool).toContain('notes.txt');
    }
  }, 30_000);

  it('a click freezes its source at the click: a source changed during the balance refresh and quote (by the user or an agent) is not sent', async () => {
    const h = await start();
    fixture.stream = false;
    const clicked = path.join(base, 'clicked.png'); await fs.writeFile(clicked, png(64, 64, 30));
    const other = path.join(base, 'other.png'); await fs.writeFile(other, png(64, 64, 222));
    await useAppStore.getState().loadWorkbenchFromPath(clicked, { silent: true });
    const api = (globalThis as any).window.naiDesktop, quoteAnlas = api.quoteAnlas;
    for (const [action, run] of [['i2i', () => useAppStore.getState().generateI2I()], ['upscale', () => useAppStore.getState().upscaleCurrentImage()]] as const) {
      await useAppStore.getState().loadWorkbenchFromPath(clicked, { silent: true });
      const quote = deferred<any>(); api.quoteAnlas = () => quote.promise;
      useAppStore.setState({ batchCount: 1, i2iParams: { strength: 0.5, noise: 0, extraNoiseSeed: 3 }, i2iSourceMode: 'original', upscaleScale: 2 } as any);
      const click = run();
      await waitUntil(() => expect(useAppStore.getState().statusText).toMatch(/Preparing generation|Loaded image/));
      await new Promise(resolve => setTimeout(resolve, 30));
      // An agent's applied source (or the user loading another image) while the price is asked.
      await loadImageFromPath(other);
      await useAppStore.getState().loadWorkbenchFromPath(other, { silent: true });
      expect(useAppStore.getState().workbenchImage?.filePath).toBe(other);
      quote.resolve({ ok: true, amount: 0, balance: 1000 }); api.quoteAnlas = quoteAnlas;
      await click; await h.settled();
      const body = fixture.post.mock.calls.at(-1)![1];
      const sent = Buffer.from(action === 'i2i' ? body.parameters.image : body.image, 'base64');
      expect(sent.equals(png(64, 64, 30)), action).toBe(true);
      expect(useAppStore.getState().comparisonBeforeImage?.filePath, action).toBe(clicked);
    }
  }, 30_000);

  it('a click with a random seed saves its images with seedMode random and the seed each one was generated with', async () => {
    const h = await start();
    fixture.stream = false;
    useAppStore.setState(state => ({ batchCount: 2, params: { ...state.params, seed: 5, seedMode: 'random' } }));
    await useAppStore.getState().generate();
    await h.settled();
    const seeds = fixture.post.mock.calls.map(([, body]: any[]) => body.parameters.seed);
    expect(new Set(seeds).size).toBe(2);
    expect(fixture.history.map(item => [item.params.seedMode, item.params.seed, item.actualSeed])).toEqual(seeds.map((seed: number) => ['random', seed, seed]));
    expect(useAppStore.getState().params).toMatchObject({ seedMode: 'random', seed: seeds[1] });
    // A fixed seed stays fixed.
    fixture.history = []; fixture.post.mockClear();
    useAppStore.setState(state => ({ batchCount: 1, params: { ...state.params, seed: 77, seedMode: 'fixed' } }));
    await useAppStore.getState().generate();
    await h.settled();
    expect(fixture.history.map(item => [item.params.seedMode, item.actualSeed])).toEqual([['fixed', 77]]);
  }, 30_000);

  it('the summary counts an image of unknown outcome apart from failures and says it may have been charged', async () => {
    const h = await start();
    fixture.stream = false;
    const upstream = () => Promise.reject(Object.assign(new Error('gateway'), { response: { status: 500, data: Buffer.from('upstream') } }));
    useAppStore.setState({ batchCount: 3 });
    fixture.post.mockImplementationOnce(upstream);
    await useAppStore.getState().generate();
    await h.settled();
    expect((await h.listed())[0].items.map((item: any) => item.status)).toEqual(['unknown', 'succeeded', 'succeeded']);
    expect(useAppStore.getState().statusText).toBe('Done: 2 succeeded, spent 0 Anlas. 1 more with an unknown outcome: the request may have been sent and charged; nothing was resent. Check the history first.');
    expect(useAppStore.getState().lastError).toBe('');
    useAppStore.setState({ batchCount: 1 });
    fixture.post.mockImplementationOnce(upstream);
    await useAppStore.getState().generate();
    await h.settled();
    expect(useAppStore.getState().statusText).toBe('1 with an unknown outcome, spent 0 Anlas: the request may have been sent and charged; nothing was resent. Check the history first.');
    // A failure and an unknown outcome: the failure names its error, the unknown one is added.
    useAppStore.setState({ batchCount: 3 });
    fixture.post.mockImplementationOnce(upstream).mockImplementationOnce(() => Promise.reject(Object.assign(new Error('bad'), { response: { status: 400, data: Buffer.from('prompt too long') } })));
    await useAppStore.getState().generate();
    await h.settled();
    expect(useAppStore.getState().statusText).toMatch(/prompt too long.* 1 more with an unknown outcome: the request may have been sent and charged/);
  }, 30_000);

  it('Pause, Resume and Stop act on the window\'s manual batch through the queue; a paused batch does not hold up the next', async () => {
    const h = await start();
    fixture.stream = false;
    useAppStore.setState({ batchCount: 3 });
    const held = deferred<any>();
    fixture.post.mockImplementationOnce(() => held.promise);
    await useAppStore.getState().generate();
    await waitUntil(() => expect(useAppStore.getState().isGenerating).toBe(true));
    await useAppStore.getState().togglePause();
    await waitUntil(() => expect(useAppStore.getState().manualBatches[0]?.status).toBe('pausing'));
    held.resolve(await zipReply());
    await waitUntil(() => expect(useAppStore.getState().manualBatches[0]?.status).toBe('paused'));
    expect(fixture.post).toHaveBeenCalledTimes(1);
    // A second click runs although the first batch is paused ahead of it.
    useAppStore.setState({ batchCount: 1 });
    await useAppStore.getState().generate();
    await waitUntil(() => expect(useAppStore.getState().manualBatches).toHaveLength(1));
    expect(fixture.post).toHaveBeenCalledTimes(2);
    // Resumed, the first batch sends its second image; Stop aborts it while it runs.
    const resumedHeld = deferred<any>();
    fixture.post.mockImplementationOnce(() => resumedHeld.promise);
    await useAppStore.getState().togglePause();
    await waitUntil(() => expect(fixture.post).toHaveBeenCalledTimes(3));
    await useAppStore.getState().cancel();
    resumedHeld.resolve(await zipReply());
    await h.settled();
    const [second, first] = await h.listed();
    expect(second.status).toBe('succeeded');
    expect(first.status).toBe('cancelled');
    expect(first.items.map((item: any) => item.status)).toEqual(['succeeded', 'cancelled', 'cancelled']);
    expect(useAppStore.getState().statusText).toContain('Batch cancelled: 1 succeeded');
    expect(useAppStore.getState().statusText).toContain('the image is not saved');
  });
});
