/**
 * Queued results of every mode keep their history record: the MCP server over the real HTTP bridge to the real host
 * services (recipe store with canvas capture, frozen batch queue, generation service, nai.ts save path) and the REAL
 * store.addHistory (the complete generation parameters check and the library put over SQLite). All modes from history
 * sources (t2i, i2i, enhance, inpaint, upscale, each director tool), plus canvas t2i and i2i captures: every batch
 * succeeds, read_queue names each result's historyId, get_queue_result attaches the image, asset_library lists the
 * batch's records, no file journal is left. Then the strict check failing before the request (the item is refused
 * with its own code, nothing is sent) and, not expected, after it (the record and the queue link are kept).
 * Only NovelAI is a stub (axios answers a ZIP); the token and endpoint come from a partial store mock.
 */
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { PNG } from 'pngjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ base: '', post: vi.fn(), strict: [] as Array<'pass' | 'fail'>, warnings: [] as string[] }));
vi.mock('electron', async () => {
  const { PNG } = await import('pngjs');
  const nodePath = await import('node:path');
  const make = (png: any): any => ({
    isEmpty: () => false, getSize: () => ({ width: png.width, height: png.height }), toPNG: () => PNG.sync.write(png),
    resize({ width, height }: { width: number; height: number }) { const out = new PNG({ width, height }); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const sx = Math.min(png.width - 1, Math.floor(x * png.width / width)), sy = Math.min(png.height - 1, Math.floor(y * png.height / height)); png.data.copy(out.data, (y * width + x) * 4, (sy * png.width + sx) * 4, (sy * png.width + sx) * 4 + 4); } return make(out); },
  });
  return {
    app: { getPath: (key: string) => key === 'userData' ? nodePath.join(fixture.base, 'data') : nodePath.join(fixture.base, key), getVersion: () => 'test', isPackaged: false, getName: () => 'test' },
    dialog: {}, shell: {},
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(`k:${value}`), decryptString: (value: Buffer) => value.toString().slice(2) },
    nativeImage: { createFromBuffer(buffer: Buffer) { try { return make(PNG.sync.read(Buffer.from(buffer))); } catch { return { isEmpty: () => true }; } } },
  };
});
vi.mock('axios', () => ({ default: { post: fixture.post, get: () => Promise.reject(new Error('offline test')), isCancel: (error: any) => error?.code === 'ERR_CANCELED' } }));
vi.mock('./ipc/store', async (importOriginal) => {
  const real: any = await importOriginal();
  return { ...real, getToken: () => 'synthetic-test-token',
    getSettings: () => ({ ...real.getSettings(), imageBaseUrl: 'https://generation-fixture.example.test', allowCustomEndpoint: true, allowCustomEndpointFallback: true, streamPreviewEnabled: false }) };
});
// The real strict check, unless a test queues a decision: 'fail' makes that call refuse as an incomplete record would.
vi.mock('./library/validation', async (importOriginal) => {
  const real: any = await importOriginal();
  return { ...real, validateGeneratedHistoryPayload: (payload: unknown) => {
    if (fixture.strict.shift() === 'fail') throw Object.assign(new Error("生成历史字段无效：data/params must have required property 'qualityPreset'"), { code: 'invalid_argument' });
    return real.validateGeneratedHistoryPayload(payload);
  } };
});
vi.mock('./ipc/logger', () => ({ logError: vi.fn(), logInfo: vi.fn(), appendLog: (level: string, message: string) => { if (level === 'WARN') fixture.warnings.push(message); } }));
vi.mock('./ipc/proxy', () => ({ proxyConfig: () => ({}) }));

import { generateI2I, generateImage, inpaintImage, upscaleImg, augmentImg } from './ipc/nai';
import { cancelAllJobs, hasActiveGenerationJobs, reserveQueueGeneration } from './ipc/job-registry';
import { createGenerationService } from './generation-service';
import { createBatchService } from './batch-service';
import { createQueueRecipeService, QUEUE_METHODS } from './queue-recipe-service';
import { createCanvasRecipeCapture } from './canvas-recipe-capture';
import { queueBridgeError } from './queue-bridge-error';
import { buildPromptReview } from './prompt-review';
import { BridgeError, startHttpBridge } from './bridge-server';
import { openLibraryRepository } from './library/repository';
import { activateLibrary, deactivateLibrary } from './library-runtime';
import { createAssetLibraryService } from './asset-library-service';
import { createHistoryImageReader } from './asset-library-image';
import { resolveQueueHistoryGroup } from './queue-output';
import { ensureHistoryGroup, getHistoryGroups } from './ipc/store';
import { toLocalMediaUrl } from './ipc/local-media-protocol';
import { useAppStore } from '../src/store';
import { DEFAULT_PARAMS, DIRECTOR_TOOLS } from '../src/types';
import { createRendererWorkspace } from '../src/workspace/adapter';
import type { GenerationJob } from '../src/workspace/generation-types';
import { createBridgeClient, createNovelAiMcpServer } from '../../src/mcp.mjs';
import { Client } from '../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { waitUntil } from '../src/test-support/wait-until';

const png = (width: number, height: number, value: number) => { const image = new PNG({ width, height }); for (let i = 0; i < image.data.length; i += 4) image.data.set([value, (i / 4) % 255, 120, 255], i); return PNG.sync.write(image); };
async function zipReply(width = 64, height = 64) { const zip = new JSZip(); zip.file('image_0.png', png(width, height, 200)); return { data: await zip.generateAsync({ type: 'nodebuffer' }) }; }
const closers: Array<() => Promise<unknown> | unknown> = [];
const previousDataDir = process.env.NOVELAI_DATA_DIR;
// One data root for the file (the real store caches settings.json, whose default outputDir is <NOVELAI_DATA_DIR>/output);
// each test gets its own library file and runtime folder below it.
let sub = '';
beforeAll(async () => {
  fixture.base = fss.realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'nai-queue-history-')));
  await fs.mkdir(path.join(fixture.base, 'data'), { recursive: true });
  process.env.NOVELAI_DATA_DIR = path.join(fixture.base, 'data');
});
afterAll(async () => {
  if (previousDataDir === undefined) delete process.env.NOVELAI_DATA_DIR; else process.env.NOVELAI_DATA_DIR = previousDataDir;
  await fs.rm(fixture.base, { recursive: true, force: true });
});
beforeEach(async () => {
  sub = await fs.mkdtemp(path.join(fixture.base, 'data', 't-'));
  fixture.post.mockReset(); fixture.post.mockImplementation(async (url: string) => /upscale/.test(url) ? zipReply(128, 128) : zipReply()); fixture.strict = []; fixture.warnings = [];
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ params: { ...DEFAULT_PARAMS, model: 'nai-diffusion-4-5-full', positivePrompt: 'a harbor at dawn', negativePrompt: '', stylePrompt: '', width: 64, height: 64, steps: 1, seed: 5, seedMode: 'fixed', promptAssemblyVersion: 1 }, settings: { modelMode: 'anime' } as any });
  vi.stubGlobal('document', { querySelector: () => null });
  vi.stubGlobal('Image', class { naturalWidth = 0; naturalHeight = 0; onload: (() => void) | null = null; onerror: (() => void) | null = null;
    set src(value: string) { queueMicrotask(() => { try { const image = PNG.sync.read(Buffer.from(value.split(',')[1], 'base64')); this.naturalWidth = image.width; this.naturalHeight = image.height; this.onload?.(); } catch { this.onerror?.(); } }); } });
});
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) { try { await close(); } catch { /* closed */ } }
  cancelAllJobs(); vi.unstubAllGlobals();
});

async function start() {
  const data = sub, runtimeDir = path.join(data, 'runtime'), projectRoot = path.join(data, 'project');
  await fs.mkdir(runtimeDir, { recursive: true }); await fs.mkdir(projectRoot, { recursive: true });
  const repository = openLibraryRepository({ filePath: path.join(data, 'library.sqlite'), userDataRoot: data, libraryDirectory: path.join(data, 'library') });
  activateLibrary(repository, { userDataRoot: data, libraryDirectory: path.join(data, 'library') });
  closers.push(() => { repository.close(); deactivateLibrary(); });
  const assets = createAssetLibraryService({ repository, toFileUrl: toLocalMediaUrl });
  const rendererJobs = new Set<(job: GenerationJob) => void>();
  const sizeOf = (bytes: Buffer) => { const image = PNG.sync.read(bytes); return { width: image.width, height: image.height }; };
  const generation = createGenerationService({ isBusy: hasActiveGenerationJobs, reserve: reserveQueueGeneration, validateImage: sizeOf,
    async execute(mode, snapshot, execution) { // as main.ts
      if (mode === 't2i') return generateImage(snapshot.params, snapshot.extras, undefined, execution);
      if (mode === 'i2i' || mode === 'enhance') return generateI2I(snapshot.params, snapshot.i2i!, snapshot.extras, execution);
      if (mode === 'upscale') { const result = await upscaleImg(snapshot.upscale!.scale, snapshot.params.model, execution); return { ...result, items: result.ok && result.item ? [result.item] : [] }; }
      if (mode === 'director') return augmentImg(snapshot.director!.tool, snapshot.director!.options, execution);
      const inpaint = snapshot.inpaint!;
      return inpaintImage(snapshot.params, inpaint.model, inpaint.maskBase64, inpaint.strength, 0, execution);
    },
    onJob: job => rendererJobs.forEach(listener => listener(structuredClone(job))) });
  const batch = createBatchService({ generation, isBusy: hasActiveGenerationJobs, runtimeDir });
  closers.push(() => batch.dispose());
  const queue: any = createQueueRecipeService({ runtimeDir, batch, generation, historyById: id => (repository.get('history', id)?.payload as any) ?? null, validateImage: data => sizeOf(data),
    resolveHistoryGroup: name => resolveQueueHistoryGroup(name, getHistoryGroups(), ensureHistoryGroup), readHistoryOriginal: createHistoryImageReader(repository), recipeReclaim: { auto: false, now: () => Date.now(), log: () => {} } });
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
  const wrap = (call: (args: any) => Promise<any>) => async (args: any) => { try { return await call(args); } catch (error) { throw queueBridgeError(error); } };
  const capture = createCanvasRecipeCapture({ collect: args => toRenderer('collect_canvas_preparation', args), put: args => queue.put_canvas_recipe(args), preview: args => queue.preview_canvas_recipe(args) });
  const hostMethods: Record<string, (args: any) => Promise<any>> = { ...Object.fromEntries(QUEUE_METHODS.map(method => [method, wrap(args => queue[method](args))])), capture_canvas_recipe: wrap(capture),
    asset_library: async args => { try { return await assets.asset_library(args); } catch (error: any) { throw new BridgeError(error?.code ?? 'material_failed', error?.message ?? 'failed'); } } };
  const dispatch = async (method: string, args: Record<string, unknown>) => Object.hasOwn(hostMethods, method) ? hostMethods[method](args) : toRenderer(method, args);
  const bridge = await startHttpBridge({ runtimeDir, dispatch }); closers.push(() => bridge.close());
  const server = createNovelAiMcpServer({ bridgeClient: createBridgeClient({ runtimeDir }), projectRoot, projectRootSource: 'NOVELAI_PROJECT_ROOT' });
  const client = new Client({ name: 'queue-history', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  closers.push(async () => { await client.close(); await server.close(); });
  const call = async (name: string, args: Record<string, unknown> = {}) => { const result: any = await client.callTool({ name, arguments: args }); return { ok: !result.isError, value: result.structuredContent, content: result.content }; };
  const ok = async (name: string, args: Record<string, unknown> = {}) => { const result = await call(name, args); expect(result.ok, `${name}: ${JSON.stringify(result.value).slice(0, 1500)}`).toBe(true); return result.value; };
  const settle = (batchId: string) => waitUntil(async () => { const read = await ok('read_queue', { batchId }); expect(['succeeded', 'partial', 'blocked', 'cancelled'], `batch ${read.status}`).toContain(read.status); return read; }, { interval: 25 });
  const workspaceId = (await ok('list_workspaces')).workspaces[0].workspaceId;
  const revision = async () => (await ok('read_workspace', { workspaceId, includeImages: false })).revision;
  /** A batch whose every result is a saved history record the MCP tools can reach. */
  const kept = async (label: string, batchId: string, count: number) => {
    const read = await settle(batchId);
    expect(read.status, `${label}: ${JSON.stringify(read).slice(0, 800)}`).toBe('succeeded');
    expect(read.results.length, label).toBe(count);
    for (const result of read.results) {
      expect(typeof result.historyId, label).toBe('string');
      expect(repository.get('history', result.historyId), `${label}: record`).toBeTruthy();
      const image = await call('get_queue_result', { batchId, itemIndex: result.itemIndex });
      expect(image.ok && image.content.some((item: any) => item.type === 'image'), `${label}: image`).toBe(true);
    }
    const listed = await ok('asset_library', { action: 'list', category: 'history', queueBatchId: batchId });
    expect(listed.items.length, `${label}: asset_library list by batch`).toBe(count);
    expect(repository.pendingFileOps(), `${label}: pending journals`).toEqual([]);
    return read;
  };
  return { repository, batch, call, ok, settle, kept, workspaceId, revision };
}
const ref = (recipe: any) => ({ recipeId: recipe.recipeId, recipeRevision: recipe.recipeRevision, inputHash: recipe.inputHash });
const t2i = { mode: 't2i', model: 'nai-diffusion-4-5-full', width: 64, height: 64, steps: 1, cfgScale: 5, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', ucPreset: 0, qualityPreset: 'standard', stylePrompt: '', positivePrompt: 'a blue teacup', negativePrompt: '', seed: 7, characters: [{ prompt: 'a gardener', useCoords: true, x: 0.3, y: 0.7 }] };
const directorArgs: Record<string, Record<string, unknown>> = { colorize: { colorizePrompt: 'blue', defry: 1 }, emotion: { emotion: 'happy', emotionLevel: 2 } };

describe('queued results of every mode keep their history record', () => {
  it('t2i, i2i, enhance, inpaint, upscale, each director tool from history sources; canvas t2i and i2i', async () => {
    const h = await start();
    const base = await h.ok('prepare_recipe', t2i);
    const first = await h.ok('enqueue_recipes', { requestKey: 'history-t2i', historyGroup: 'review', items: [{ ...ref(base), count: 2, seeds: [1, 2] }] });
    const r1 = await h.kept('t2i (group review)', first.batch.batchId, 2);
    expect(r1.results.map((value: any) => h.repository.get('history', value.historyId)?.payload.groupId)).toEqual([getHistoryGroups()[0].id, getHistoryGroups()[0].id]);
    const listed = await h.ok('asset_library', { action: 'list', category: 'history', queueBatchId: first.batch.batchId });
    const src = listed.items[0], source = { kind: 'history', historyId: src.id, historyRevision: src.revision, assetId: src.image.preview.assetId };
    const { mode: _m, width: _w, height: _h, characters: _c, ...fields } = t2i as any;
    const recipes: Array<[string, any]> = [
      ['i2i', { ...fields, mode: 'i2i', width: 64, height: 64, source, strength: 0.5 }],
      ['enhance', { ...fields, mode: 'enhance', source, magnitude: 3, scale: 2 }],
      ['inpaint', { ...fields, mode: 'inpaint', source, strength: 1, mask: { units: 'fraction', layers: [{ op: 'add', shape: { type: 'rect', x: 0, y: 0, width: 0.5, height: 0.5 } }] } }],
      ['upscale', { mode: 'upscale', source, scale: 2 }],
      ...DIRECTOR_TOOLS.map(({ value: tool }) => [`director ${tool}`, { mode: 'director', source, tool, ...(directorArgs[tool] ?? {}) }] as [string, any]),
    ];
    expect(recipes.filter(([label]) => label.startsWith('director'))).toHaveLength(6);
    for (const [label, args] of recipes) {
      const recipe = await h.ok('prepare_recipe', args);
      const seeded = !['upscale', 'director'].includes(args.mode);
      const receipt = await h.ok('enqueue_recipes', { requestKey: `history-${label}`, items: [{ ...ref(recipe), ...(seeded ? { seeds: [9] } : {}) }] });
      await h.kept(label, receipt.batch.batchId, 1);
    }
    // Canvas captures into the queue.
    const canvasT2i = await h.ok('prepare_recipe', { mode: 't2i', canvas: { workspaceId: h.workspaceId, expectedRevision: await h.revision() } });
    const c1 = await h.ok('enqueue_recipes', { requestKey: 'history-canvas-t2i', items: [{ ...ref(canvasT2i), count: 2, seeds: [3, 4] }] });
    await h.kept('canvas t2i', c1.batch.batchId, 2);
    useAppStore.setState({ workbenchImage: { filePath: path.join(fixture.base, 'canvas-source.png'), fileUrl: `data:image/png;base64,${png(64, 64, 30).toString('base64')}`, width: 64, height: 64 }, i2iParams: { strength: 0.45, noise: 0, extraNoiseSeed: 77 } });
    const canvasI2i = await h.ok('prepare_recipe', { mode: 'i2i', canvas: { workspaceId: h.workspaceId, expectedRevision: await h.revision() } });
    const c2 = await h.ok('enqueue_recipes', { requestKey: 'history-canvas-i2i', items: [{ ...ref(canvasI2i), seeds: [21] }] });
    await h.kept('canvas i2i', c2.batch.batchId, 1);
    expect(fixture.warnings).toEqual([]);
  });

  it('the strict check failing before the request: the item is refused with history_params_invalid and the field, nothing is sent for it, and the next image runs', async () => {
    const h = await start();
    const recipe = await h.ok('prepare_recipe', t2i);
    fixture.strict = ['fail'];
    const receipt = await h.ok('enqueue_recipes', { requestKey: 'history-refused', items: [{ ...ref(recipe), count: 2, seeds: [5, 6] }] });
    const read = await h.settle(receipt.batch.batchId);
    expect(read).toMatchObject({ status: 'partial', items: [{ index: 0, status: 'failed', error: 'history_params_invalid', resultCount: 0 }, { index: 1, status: 'succeeded', resultCount: 1 }] });
    expect(read.results.map((value: any) => value.itemIndex)).toEqual([1]);
    // One request, for the second image only.
    expect(fixture.post).toHaveBeenCalledTimes(1);
    const host = h.batch.read({ workspaceId: h.workspaceId, batchId: receipt.batch.batchId });
    expect(host.items[0]).toMatchObject({ providerOutcome: 'not_submitted', error: { code: 'history_params_invalid', message: expect.stringMatching(/qualityPreset.*没有发送生成请求/) } });
    expect(h.repository.all('history').map(item => (item.payload as any).queueOrigin?.itemIndex)).toEqual([1]);
    expect(h.repository.pendingFileOps()).toEqual([]);
    expect((await h.call('get_queue_result', { batchId: receipt.batch.batchId, itemIndex: 0 })).ok).toBe(false);
  });

  it('the strict check failing after the request (not expected): the record, its historyId and the queue link are kept, with a warning', async () => {
    const h = await start();
    const recipe = await h.ok('prepare_recipe', t2i);
    fixture.strict = ['pass', 'fail'];
    const receipt = await h.ok('enqueue_recipes', { requestKey: 'history-relaxed', items: [{ ...ref(recipe), seeds: [5] }] });
    const read = await h.kept('relaxed', receipt.batch.batchId, 1);
    expect(fixture.post).toHaveBeenCalledTimes(1);
    const record = h.repository.get('history', read.results[0].historyId)!.payload;
    expect(record.queueOrigin).toMatchObject({ batchId: receipt.batch.batchId, itemIndex: 0 });
    expect(fixture.warnings).toEqual([expect.stringMatching(new RegExp(`已按存储格式保存.*${read.results[0].historyId}`))]);
  });
});
