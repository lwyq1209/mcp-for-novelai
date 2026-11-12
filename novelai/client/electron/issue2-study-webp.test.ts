// Issue #2 review P2-1: Electron nativeImage decodes PNG and JPEG only, so a WebP study source must reach every image
// builder and every paid execution as a PNG derivative, while the bound original (bytes, sha256, readback, frozen
// input) stays the WebP. Whole chain with a decoder stand-in that behaves like Electron (native-image-fixture: PNG and
// JPEG decode, WebP is an empty image): real MCP → real HTTP bridge → real study service, asset library, reader and
// recipe store (host builder) → enqueue to a recording batch backend → the frozen snapshot through the real generation
// service and the real ipc/nai.ts execution functions (as main.ts wires them), with the provider POST stubbed.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';

const fixture = vi.hoisted(() => ({ outputDir: '', post: vi.fn(), addHistory: vi.fn() }));
vi.mock('electron', async () => ({ app: { getPath: () => fixture.outputDir, getVersion: () => '0.0.0-test' }, dialog: {}, nativeImage: (await import('./native-image-fixture')).strictNativeImage }));
vi.mock('axios', () => ({ default: { post: fixture.post, get: () => Promise.reject(new Error('No network')), isCancel: (error: any) => error?.code === 'ERR_CANCELED' } }));
vi.mock('./ipc/store', () => ({
  getToken: () => 'synthetic-test-token',
  getSettings: () => ({ imageBaseUrl: 'https://generation-fixture.example.test', allowCustomEndpoint: true, allowCustomEndpointFallback: true, streamPreviewEnabled: false, outputDir: fixture.outputDir, generationGroupId: '', keepImageMetadata: false, imageNameTemplate: '{date}_{seed}_{seq}' }),
  getHistoryGroups: () => [], getAccountSummary: () => ({ hasToken: true }), addHistory: fixture.addHistory,
  ensureHistoryGroup: vi.fn(() => ({ id: 'fixture-group', name: 'Fixture', createdAt: '2026-11-01' })), setAccountSummary: vi.fn(), setToken: vi.fn(), updateHistoryItem: vi.fn(),
}));
vi.mock('./ipc/logger', () => ({ logError: vi.fn(), logInfo: vi.fn(), appendLog: vi.fn() }));
vi.mock('./ipc/proxy', () => ({ proxyConfig: () => ({}) }));

import { nativeImageCalls, strictNativeImage } from './native-image-fixture';
import { openLibraryRepository } from './library/repository';
import { createAssetLibraryService } from './asset-library-service';
import { createHistoryImageReader } from './asset-library-image';
import { createImageStudyService } from './image-studies';
import { parseImageStudy } from './image-study-parser';
import { createQueueRecipeService, QUEUE_METHODS } from './queue-recipe-service';
import { queueBridgeError } from './queue-bridge-error';
import { BridgeError, startHttpBridge } from './bridge-server';
import { createGenerationService, GenerationError } from './generation-service';
import { augmentImg, generateI2I, inpaintImage, upscaleImg } from './ipc/nai';
import { buildPromptReview } from './prompt-review';
import { waitUntil } from '../src/test-support/wait-until';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const cleanups: Array<() => Promise<unknown> | unknown> = [];
beforeEach(async () => { fixture.outputDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'issue2-webp-output-'))); fixture.post.mockReset(); fixture.addHistory.mockReset(); fixture.addHistory.mockReturnValue([]); nativeImageCalls.length = 0; });
afterEach(() => runCleanups([...cleanups.splice(0).reverse(), () => fs.rm(fixture.outputDir, { recursive: true, force: true })]));

/** 768×1216 RGBA gradient: top 64 rows and right 64 columns transparent (a padded canvas, as in design §7). */
async function gradient(format: 'webp' | 'jpeg' | 'png') {
  const png = new PNG({ width: 768, height: 1216 });
  for (let y = 0; y < 1216; y++) for (let x = 0; x < 768; x++) { const i = (y * 768 + x) * 4; png.data[i] = (x * 3 + y) & 255; png.data[i + 1] = (y * 2) & 255; png.data[i + 2] = (x ^ y) & 255; png.data[i + 3] = y < 64 || x >= 704 ? 0 : 255; }
  const bytes = PNG.sync.write(png);
  return format === 'png' ? bytes : format === 'webp' ? sharp(bytes).webp({ lossless: true }).toBuffer() : sharp(bytes).flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
}
const zipOf = async (image: Buffer) => { const zip = new JSZip(); zip.file('image_0.png', image); return { data: await zip.generateAsync({ type: 'nodebuffer' }) }; };
const GEN = { model: 'nai-diffusion-5-full', steps: 28, cfgScale: 5, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', ucPreset: 0, qualityPreset: 'standard', stylePrompt: '', positivePrompt: '1girl, ponytail', negativePrompt: 'blurry', seed: 4321 };
const MASK = { units: 'px', layers: [{ op: 'add', shape: { type: 'rect', x: 0, y: 0, width: 768, height: 64 } }, { op: 'add', shape: { type: 'rect', x: 704, y: 0, width: 64, height: 1216 } }] };

async function chain() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'issue2-webp-')));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, '.runtime'), libraryDirectory = path.resolve(runtimeDir, '..', 'library'), userData = path.join(root, 'user-data');
  const studyInbox = path.join(root, 'study-inbox'), studyExports = path.join(root, 'study-exports');
  for (const dir of [runtimeDir, libraryDirectory, userData, studyInbox, studyExports]) await fs.mkdir(dir, { recursive: true });
  const repository = openLibraryRepository({ filePath: path.join(userData, 'library.sqlite'), libraryDirectory, userDataRoot: userData });
  cleanups.push(() => repository.close());
  const studies = createImageStudyService({ directory: path.join(libraryDirectory, 'studies'), repository, parse: parseImageStudy });
  cleanups.push(() => studies.dispose());
  const assets = createAssetLibraryService({ repository, study: args => studies.material_studies(args) });
  const enqueued: any[] = [];
  const batch = { ready: Promise.resolve(), enqueue: vi.fn(async (args: any) => { enqueued.push(args); return { batchId: `00000000-0000-4000-8000-00000000000${enqueued.length}`, requestKey: args.requestKey, execution: args.execution, status: 'queued', count: args.count, intervalSeconds: args.intervalSeconds, items: [] }; }), lookup: vi.fn(() => null), list: vi.fn(() => ({ batches: [] })), read: vi.fn(), pause: vi.fn(), resume: vi.fn(), cancel: vi.fn() };
  const queue = createQueueRecipeService({ runtimeDir, batch: batch as any, readHistoryOriginal: createHistoryImageReader(repository) });
  const hostMethods: Record<string, (args: Record<string, unknown>) => Promise<any>> = Object.fromEntries(QUEUE_METHODS.map(method => [method, async (args: Record<string, unknown>) => {
    try { return await (queue as any)[method](args); } catch (error) { throw queueBridgeError(error); }
  }]));
  for (const [method, run] of Object.entries({ material_studies: (args: Record<string, unknown>) => studies.material_studies(args), asset_library: (args: Record<string, unknown>) => assets.asset_library(args) }))
    hostMethods[method] = async args => { try { return await run(args); } catch (error: any) { throw new BridgeError(/^[a-z_]+$/.test(error?.code ?? '') ? error.code : 'material_failed', error instanceof Error ? error.message : 'failed'); } };
  const host = await startHttpBridge({ runtimeDir, dispatch: async (method, args) => { if (Object.hasOwn(hostMethods, method)) return hostMethods[method](args); throw new BridgeError('workspace_unavailable', 'fixture: no renderer', 503); } });
  cleanups.push(() => host.close());
  const load = (name: string) => import(/* @vite-ignore */ new URL(name, import.meta.url).href);
  const { createNovelAiMcpServer, createBridgeClient } = await load('../../src/mcp.mjs');
  const { Client } = await load('../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const { InMemoryTransport } = await load('../../node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js');
  const server = createNovelAiMcpServer({ bridgeClient: createBridgeClient({ runtimeDir }), studyInbox, studyExports });
  const client = new Client({ name: 'issue2-webp', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  cleanups.push(async () => { await client.close(); await server.close(); });
  const call = async (name: string, args: Record<string, unknown>) => {
    // These tests read the full readback (source hash, readiness); the compact default is tested in novelai/tests.
    const result: any = await client.callTool({ name, arguments: name === 'prepare_recipe' && args.detail === undefined ? { ...args, detail: 'full' } : args });
    expect(result.isError, `${name}: ${JSON.stringify(result.structuredContent).slice(0, 2000)}`).not.toBe(true);
    return result.structuredContent;
  };
  const importStudy = async (name: string, bytes: Buffer) => {
    await fs.writeFile(path.join(studyInbox, name), bytes);
    const item = (await call('material_studies', { action: 'import', files: [name] })).items[0];
    expect(item.status).toBe('saved');
    return { kind: 'study', studyId: item.id, studyRevision: item.revision };
  };
  // The generation service with main.ts's validateImage (nativeImage) and execute (the ipc/nai.ts functions).
  const generation = createGenerationService({
    validateImage(bytes) { const image = strictNativeImage.createFromBuffer(bytes); if (image.isEmpty()) throw new GenerationError('invalid_image', '生成素材不能解码。'); return image.getSize(); },
    async execute(mode, snapshot, execution) {
      if (mode === 'i2i' || mode === 'enhance') return generateI2I(snapshot.params, snapshot.i2i!, snapshot.extras, execution);
      if (mode === 'upscale') { const result = await upscaleImg(snapshot.upscale!.scale, snapshot.params.model, execution); return { ...result, items: result.ok && result.item ? [result.item] : [] }; }
      if (mode === 'director') return augmentImg(snapshot.director!.tool, snapshot.director!.options, execution);
      const inpaint = snapshot.inpaint!;
      return inpaintImage(snapshot.params, inpaint.model, inpaint.maskBase64, inpaint.strength, 0, execution);
    },
    reserve: () => () => {},
  });
  /** Runs one frozen batch input as the batch service would (its first item) and waits for the job to end. */
  const execute = async (args: any, requestKey: string) => {
    const job = generation.submit({ workspaceId: args.workspaceId, expectedRevision: args.expectedRevision, requestKey, mode: args.mode, snapshot: structuredClone(args.snapshot ?? args.snapshots[0]) });
    await waitUntil(() => expect(generation.read({ workspaceId: args.workspaceId, jobId: job.jobId }).finishedAt).not.toBeNull());
    return generation.read({ workspaceId: args.workspaceId, jobId: job.jobId });
  };
  return { call, importStudy, enqueued, execute };
}

it('a WebP study works in i2i, enhance, inpaint, upscale and director: the builders and the paid executions get a PNG derivative, the bound original stays the WebP', async () => {
  const c = await chain();
  const webp = await gradient('webp'), source = await c.importStudy('padded.webp', webp);
  const decoded = await sharp(webp).raw().toBuffer();
  const recipes: Record<string, any> = {};
  for (const [mode, args] of [
    ['i2i', { mode: 'i2i', source, ...GEN, width: 768, height: 1216, strength: 0.5 }],
    ['enhance', { mode: 'enhance', source, ...GEN, magnitude: 3, scale: 1 }],
    ['inpaint', { mode: 'inpaint', source, ...GEN, strength: 1, mask: MASK }],
    ['upscale', { mode: 'upscale', source, scale: 2 }],
    ['director', { mode: 'director', source, tool: 'lineart' }],
  ] as const) {
    if (mode === 'inpaint') {
      const preview = await c.call('prepare_recipe', { ...args, preview: true });
      expect(preview).toMatchObject({ preview: true, ready: true, previewImage: { mimeType: 'image/webp', cells: { selected: 1920, total: 14592 } } });
    }
    const recipe = recipes[mode] = await c.call('prepare_recipe', args);
    expect(recipe, mode).toMatchObject({ saved: true, ready: true, readiness: { status: 'ready', issues: [] } });
    // The bound source is the WebP original; the builder's request source is a PNG.
    expect(recipe.source, mode).toMatchObject({ kind: 'study', sha256: sha256(webp), mimeType: 'image/webp', width: 768, height: 1216, byteLength: webp.length });
    expect(recipe.assets.find((asset: any) => asset.role === 'source'), mode).toMatchObject({ mimeType: 'image/webp', sha256: sha256(webp) });
    expect(recipe.assets.find((asset: any) => asset.role === 'request-source'), mode).toMatchObject({ mimeType: 'image/png' });
  }
  // Upscale without a downscale used to send the original bytes: now it sends the PNG derivative.
  expect(recipes.upscale.effective.input).toEqual({ width: 768, height: 1216, resized: false });
  expect(nativeImageCalls).not.toContain('other');

  // Enqueue (one mode per enqueue): the frozen input carries the WebP original, bound by sha256.
  for (const mode of ['i2i', 'enhance', 'inpaint', 'upscale', 'director']) {
    const r = recipes[mode];
    await c.call('enqueue_recipes', { requestKey: `webp-${mode}`, items: [{ recipeId: r.recipeId, recipeRevision: r.recipeRevision, inputHash: r.inputHash, ...(['i2i', 'enhance', 'inpaint'].includes(mode) ? { seeds: [7] } : {}) }] });
  }
  expect(c.enqueued.map(args => args.mode)).toEqual(['i2i', 'enhance', 'inpaint', 'upscale', 'director']);
  for (const args of c.enqueued) expect((args.snapshot ?? args.snapshots[0]).sourceImage.data).toBe(webp.toString('base64'));

  // Each frozen input through the real generation service and execution functions: one provider POST with a PNG.
  const generated = PNG.sync.write(Object.assign(new PNG({ width: 768, height: 1216 }), { data: Buffer.alloc(768 * 1216 * 4, 200) }));
  const upscaled = PNG.sync.write(Object.assign(new PNG({ width: 1536, height: 2432 }), { data: Buffer.alloc(1536 * 2432 * 4, 200) }));
  for (const args of c.enqueued) {
    fixture.post.mockReset().mockResolvedValueOnce(await zipOf(args.mode === 'upscale' ? upscaled : generated));
    nativeImageCalls.length = 0;
    const job = await c.execute(args, `webp-${args.mode}-item-0`);
    expect(job, `${args.mode}: ${JSON.stringify(job.error)}`).toMatchObject({ status: 'succeeded', inputSummary: { source: { width: 768, height: 1216, sha256: sha256(webp) } } });
    expect(fixture.post, args.mode).toHaveBeenCalledTimes(1);
    expect(nativeImageCalls, args.mode).not.toContain('other');
    const body = fixture.post.mock.calls[0][1];
    const sent = Buffer.from(['i2i', 'enhance', 'inpaint'].includes(args.mode) ? body.parameters.image : body.image, 'base64');
    const image = PNG.sync.read(sent);
    expect([image.width, image.height], args.mode).toEqual([768, 1216]);
    if (['i2i', 'enhance', 'upscale'].includes(args.mode)) expect(image.data.equals(decoded), `${args.mode}: the sent pixels are the WebP pixels`).toBe(true);
  }
}, 60_000);

it('a JPEG study passes to nativeImage unchanged (no conversion); a WebP that cannot be converted is a clear source_conversion_failed, never preparation_failed', async () => {
  const c = await chain();
  const jpeg = await gradient('jpeg'), source = await c.importStudy('photo.jpg', jpeg);
  const recipe = await c.call('prepare_recipe', { mode: 'i2i', source, ...GEN, width: 768, height: 1216, strength: 0.5 });
  expect(recipe).toMatchObject({ ready: true, source: { mimeType: 'image/jpeg', sha256: sha256(jpeg) } });
  expect(nativeImageCalls).toContain('jpeg');
  expect(nativeImageCalls).not.toContain('other');

  // A WebP whose header reads but whose image data does not (reachable only for embedded recipes: the library
  // reader decodes every study before it can be a source).
  const webp = await gradient('webp'), broken = Buffer.concat([webp.subarray(0, 64), Buffer.alloc(webp.length - 64, 7)]);
  const review = await buildPromptReview({ mode: 'i2i', authored: { params: { ...GEN, width: 768, height: 1216, seedMode: 'fixed', promptAssemblyVersion: 1 }, i2iParams: { strength: 0.5, noise: 0, extraNoiseSeed: 3 } }, assets: [{ role: 'source', mimeType: 'image/webp', data: broken.toString('base64') }] } as any)
    .catch((error: any) => ({ thrown: error?.code }));
  expect(review).toMatchObject({ readiness: { status: 'blocked', issues: [{ code: 'source_conversion_failed', message: expect.stringMatching(/WebP source could not be converted to PNG.*Convert it to PNG locally/) }] } });

  // The same bytes frozen into a job fail before any provider request, with the same explanation.
  const result = await generateI2I({ ...GEN, width: 768, height: 1216, seedMode: 'fixed', promptAssemblyVersion: 1 } as any, { strength: 0.5, noise: 0, extraNoiseSeed: 3 }, { vibeImages: [], charCaptions: [] } as any, { singleRequest: true, signal: new AbortController().signal, sourceBytes: broken });
  expect(result).toMatchObject({ ok: false, message: expect.stringContaining('WebP source could not be converted to PNG') });
  expect(fixture.post).not.toHaveBeenCalled();
}, 60_000);
