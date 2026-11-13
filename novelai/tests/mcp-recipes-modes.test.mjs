import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Phase two of the MCP merge (W3): prepare_recipe in six modes, image sources by history identity, inpaint
// masks (shapes and alpha layers), preview, the per-mode readback, enqueue rules for image and post-processing
// recipes, and queue results by history identity (design.md §4, design-addendum §1, §2.5, §2.7; P1–P12).
// Offline: fetch refused, tag cache redirected, nothing reads .runtime. The host is the REAL client
// queue-recipe service (and, where noted, the real batch service) loaded through jiti with a temporary runtime
// directory, a history-library double behind asset_library and readHistoryOriginal, and an Electron fixture
// whose nativeImage is a small pngjs implementation (decode, nearest-neighbour resize, toPNG).
const tagCacheDir = await mkdtemp(join(tmpdir(), 'novelai-recipes-modes-cache-'));
const removeTagCache = () => rm(tagCacheDir, { recursive: true, force: true });
after(removeTagCache);
// When a top-level load below throws, node:test can exit without running after hooks or 'exit' listeners, so
// every such load goes through loadOrClean(), which removes the cache directory before rethrowing.
const loadOrClean = async load => { try { return await load(); } catch (error) { await removeTagCache(); throw error; } };
process.env.NOVELAI_TAG_QUERY_CACHE_DIR = tagCacheDir;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Real network access is forbidden in recipe mode tests.'); };

const { createJiti } = await loadOrClean(() => import('jiti'));
const clientRequire = createRequire(fileURLToPath(new URL('../client/package.json', import.meta.url)));
const { PNG } = await loadOrClean(() => clientRequire('pngjs'));
const sharp = await loadOrClean(() => clientRequire('sharp'));
const merged = await loadOrClean(() => import('../src/mcp.mjs'));
const recipeQueue = await loadOrClean(() => import('../src/recipe-queue.mjs'));
const { success, errorResult, failure } = await loadOrClean(() => import('../src/mcp-registry.mjs'));
const { projectRoots, PROJECT_ROOT, trustedIdentities } = await loadOrClean(() => import('../src/business-guards.mjs'));
const sources = await loadOrClean(() => import('../src/recipe-sources.mjs'));
const { buildMask } = await loadOrClean(() => import('../src/recipe-masks.mjs'));
const { BridgeError, TOOL_REGISTRY } = merged;

const MiB = 1024 * 1024;
const json = value => JSON.parse(JSON.stringify(value));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const registry = new Map(TOOL_REGISTRY.map(tool => [tool.name, tool]));
const observed = [];

let host, fixtureDir;
before(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'novelai-recipes-modes-host-'));
  const electron = join(fixtureDir, 'electron.mjs'), axios = join(fixtureDir, 'axios.mjs');
  await writeFile(electron, `import { createRequire } from 'node:module';
const { PNG } = createRequire(${JSON.stringify(fileURLToPath(new URL('../client/package.json', import.meta.url)))})('pngjs');
const forbidden = () => { throw new Error('recipe mode fixture cannot access native UI or account paths'); };
function make(png) { return {
  isEmpty: () => !png, getSize: () => ({ width: png.width, height: png.height }),
  resize({ width, height }) { const out = new PNG({ width, height }); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const sx = Math.min(png.width - 1, Math.floor(x * png.width / width)), sy = Math.min(png.height - 1, Math.floor(y * png.height / height)); png.data.copy(out.data, (y * width + x) * 4, (sy * png.width + sx) * 4, (sy * png.width + sx) * 4 + 4); } return make(out); },
  toPNG: () => PNG.sync.write(png) }; }
export const nativeImage = { createFromBuffer(buffer) { try { return make(PNG.sync.read(Buffer.from(buffer))); } catch { return { isEmpty: () => true }; } }, createFromPath: forbidden };
export const app = { getPath: forbidden, getVersion: forbidden }; export const dialog = {};`);
  await writeFile(axios, `const forbidden = () => { throw new Error('recipe mode fixture cannot access the network'); };
export default { get: forbidden, post: forbidden, request: forbidden, create: forbidden };`);
  const jiti = createJiti(import.meta.url, { moduleCache: true, fsCache: false, alias: { electron, axios } });
  const load = file => jiti.import(fileURLToPath(new URL(`../client/${file}`, import.meta.url)));
  // Loaded one after another: concurrent jiti imports can instantiate a shared module twice (two BatchInputError classes).
  // queue-bridge-error.ts shares this module cache, so its instanceof checks see the classes the services throw.
  let service, batch, storage, dimensions, types, bridgeError, effort;
  const modules = [];
  for (const file of ['electron/queue-recipe-service.ts', 'electron/batch-service.ts', 'electron/batch-storage.ts', 'src/nai-dimensions.ts', 'src/types.ts', 'electron/queue-bridge-error.ts', 'src/nai-effort.ts']) modules.push(await load(file));
  [service, batch, storage, dimensions, types, bridgeError, effort] = modules;
  host = { createQueueRecipeService: service.createQueueRecipeService, RECIPE_ASSET_LIMITS: service.RECIPE_ASSET_LIMITS, RECIPE_STORE_LIMITS: service.RECIPE_STORE_LIMITS, queueBridgeError: bridgeError.queueBridgeError,
    createBatchService: batch.createBatchService, queuedExtraNoiseSeed: batch.queuedExtraNoiseSeed, createBatchStorage: storage.createBatchStorage, BatchInputError: storage.BatchInputError, dimensions, types, effort };
});
after(async () => {
  globalThis.fetch = originalFetch;
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------------------------------------ images
const png = (width, height, paint) => { const image = new PNG({ width, height }); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) image.data.set(paint(x, y), (y * width + x) * 4); return PNG.sync.write(image); };
const gradient = (width, height) => png(width, height, (x, y) => [(x * 7) & 255, (y * 5) & 255, 120, 255]);
/** Opaque disc (the "subject") on a transparent background, like a Director bg-removal result. */
const subject = (width, height, radius = Math.min(width, height) / 4) => png(width, height, (x, y) => Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2) <= radius ? [200, 80, 60, 255] : [0, 0, 0, 0]);
const TINY = png(1, 1, () => [0, 0, 0, 255]);
const toJpeg = bytes => sharp(bytes).jpeg().toBuffer();

/**
 * Re-checks `check` until it returns a truthy value: waiting for a condition the real batch service reaches, not for
 * a duration. The bound only keeps a broken test from hanging the whole run (node:test has no default test timeout);
 * it is far above what any machine needs, so a busy machine makes the test slower, never wrong.
 */
const HANG_GUARD_MS = 120_000;
const waitFor = async (check, label) => {
  const guard = Date.now() + HANG_GUARD_MS;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > guard) assert.fail(`never saw ${label}`); await new Promise(resolve => setTimeout(resolve, 5)); }
};
// ------------------------------------------------------------------------------------------------ host
/**
 * Runtimes of every realHost a test created. One after hook per test releases all of them: node:test skips the
 * remaining after hooks once one throws, so a failing dispose in a per-host hook would leave a second host's
 * runtime behind. Every dispose and removal runs; the first failure is rethrown afterwards.
 */
const hostRuntimes = new WeakMap();
function registerHostRuntime(t, base, services) {
  let runtimes = hostRuntimes.get(t);
  if (!runtimes) {
    hostRuntimes.set(t, runtimes = []);
    t.after(async () => {
      const failures = [];
      for (const runtime of runtimes.splice(0)) {
        // Dispose every batch service (it waits for its pending saves) before removing the runtime it writes to.
        for (const value of runtime.services) { try { await value.dispose?.(); } catch (error) { failures.push(error); } }
        try { await rm(runtime.base, { recursive: true, force: true }); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw failures[0];
    });
  }
  runtimes.push({ base, services });
}
/**
 * Real queue-recipe service over a temporary runtime, a history library double and an in-memory batch backend
 * (or, with { realBatch: true }, the real batch service with a recording generation double; with frozenLimits
 * it stores batches in the REAL frozen-queue storage of the same runtime, optionally wrapped by wrapStorage),
 * reached through a bridge double with production's error mapping (the real queueBridgeError). faults[method]: a function applied to the
 * reply, { before } run before the host call or { reply } answering instead of the host. rebuild() restarts the
 * batch and recipe services over the same runtime (for example with other frozen-queue limits).
 */
async function realHost(t, { realBatch = false, frozenLimits = null, wrapStorage = storage => storage, loadMayFail = false } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'novelai-recipes-modes-'));
  const services = [];
  registerHostRuntime(t, base, services);
  const runtimeDir = join(base, 'runtime'); await mkdir(runtimeDir);
  const history = new Map(), studies = new Map(), readerBusy = { on: false };
  const addHistory = (id, bytes, { revision = 1, assetId = `${id}-original`, mimeType = 'image/png', width, height } = {}) => {
    const entry = { id, revision, assetId, bytes, mimeType, width, height };
    history.set(`${id}:${revision}:${assetId}`, entry);
    return { kind: 'history', historyId: id, historyRevision: revision, assetId };
  };
  // Issue #2: studies (imported images) have one registered original per revision, addressed without assetId.
  const addStudy = (bytes, { id = randomUUID(), revision = 1, mimeType = 'image/png', width, height, orientation } = {}) => {
    studies.set(`${id}:${revision}`, { id, revision, assetId: `path:${sha256(Buffer.from(`study-${id}`))}`, bytes, mimeType, width, height, orientation });
    return { kind: 'study', studyId: id, studyRevision: revision };
  };
  const lookupHistory = args => history.get(`${args.id}:${args.revision}:${args.assetId}`);
  const lookupStudy = args => args.assetId === undefined ? studies.get(`${args.id}:${args.revision}`) : undefined;
  const readHistoryOriginal = async args => {
    if (readerBusy.on) throw Object.assign(new Error('busy'), { code: 'image_busy' });
    const entry = args.kind === 'study' ? lookupStudy(args) : args.kind === 'history' ? lookupHistory(args) : undefined;
    if (!entry) throw Object.assign(new Error('missing'), { code: 'library_not_found' });
    return { kind: args.kind, id: entry.id, revision: entry.revision, assetId: entry.assetId, variant: 'original', mimeType: entry.mimeType, data: entry.bytes.toString('base64') };
  };
  const jobs = [], submitted = [];
  let batch, service;
  const build = async ({ limits = frozenLimits, wrap = wrapStorage, mayFail = loadMayFail } = {}) => {
  if (realBatch) {
    const generation = { lookup: async () => null, async submit(args) {
      submitted.push(json(args));
      const n = submitted.length;
      return { jobId: randomUUID(), workspaceId: args.workspaceId, requestKey: args.requestKey, originWorkspaceId: args.workspaceId, submittedRevision: args.expectedRevision, mode: args.mode, status: 'succeeded', actualSeed: null, providerOutcome: 'response_received',
        results: [{ index: 0, id: `history-out-${n}`, width: 128, height: 128, model: 'm', actualSeed: null }], error: null, updatedAt: new Date().toISOString() };
    }, read: async () => null, cancel: async () => null, subscribe: () => () => {} };
    const storage = limits ? wrap(host.createBatchStorage(runtimeDir, limits)) : { async load() { return []; }, async create() { return 1; }, async save() {} };
    batch = host.createBatchService({ generation, storage, isBusy: () => false, wait: () => new Promise(resolve => setTimeout(resolve, 1)) });
    services.push(batch);
    await batch.ready.catch(error => { if (!mayFail) throw error; });
  } else {
    batch = {
      ready: Promise.resolve(),
      async enqueue(args) {
        if (batch.failNext) { const failure = batch.failNext; batch.failNext = null; throw failure; }
        const job = { batchId: randomUUID(), requestKey: args.requestKey, execution: args.execution, status: 'queued', count: args.count, intervalSeconds: args.intervalSeconds,
          originWorkspaceId: args.workspaceId, submittedRevision: args.expectedRevision, mode: args.mode, activeJobId: null,
          items: args.seeds.map((seed, index) => ({ index, status: 'queued', jobId: null, seed, results: [] })) };
        jobs.push({ job, args: json(args) });
        return structuredClone(job);
      },
      lookup: args => structuredClone(jobs.find(entry => entry.job.requestKey === args.requestKey)?.job ?? null),
      list: () => ({ batches: jobs.map(entry => structuredClone(entry.job)) }),
      read: args => structuredClone(jobs.find(entry => entry.job.batchId === args.batchId)?.job),
    };
  }
  const generationResult = { async result(args) { return { jobId: args.jobId, index: args.index, mimeType: 'image/png', data: TINY.toString('base64'), historyId: 'history-out-1', workspaceId: args.workspaceId }; } };
  service = host.createQueueRecipeService({ runtimeDir, batch, randomSeed: () => 777, readHistoryOriginal, ...(realBatch ? { generation: generationResult } : {}) });
  };
  await build();
  const rebuild = async options => { await batch.dispose?.(); await build(options); };
  // The real asset_library {action:image} contract for history and (issue #2) study: a ≤384 thumbnail (here a 1×1 PNG) or the
  // original, with the original's facts; a study reply names its single registered original and its EXIF orientation, if any.
  const assetLibrary = args => {
    const entry = args.action !== 'image' ? null : args.kind === 'history' ? lookupHistory(args) : args.kind === 'study' ? lookupStudy(args) : null;
    if (!entry) throw new BridgeError('library_not_found', `No such ${args.kind} image.`);
    const variant = args.variant ?? 'thumbnail', original = variant === 'original';
    const data = original ? entry.bytes : TINY;
    return { kind: args.kind, id: entry.id, revision: entry.revision, assetId: entry.assetId, role: 'original', variant, mimeType: original ? entry.mimeType : 'image/png',
      width: original ? entry.width : 1, height: original ? entry.height : 1, byteLength: data.length, sha256: sha256(data),
      sourceMimeType: entry.mimeType, sourceWidth: entry.width, sourceHeight: entry.height, sourceByteLength: entry.bytes.length, sourceSha256: sha256(entry.bytes),
      ...(entry.orientation !== undefined ? { sourceOrientation: entry.orientation } : {}), contentBinding: 'recorded-sha256', data: data.toString('base64') };
  };
  const calls = [], faults = {}, transforms = {};
  // Errors raised by this double itself are already MCP BridgeErrors. Host queue errors take production's path:
  // main.ts queueMethods → the real queueBridgeError → HTTP bridge (code, message, details) → bridge client.
  const mapError = error => {
    if (error instanceof BridgeError) return error;
    const bridged = host.queueBridgeError(error);
    return new BridgeError(bridged.code, bridged.message, bridged.details);
  };
  const bridge = { async call(method, args, signal) {
    observed.push(method);
    calls.push({ method, args: structuredClone(args) });
    if (signal !== undefined) assert.ok(signal instanceof AbortSignal);
    const fault = faults[method];
    if (fault && typeof fault === 'object' && typeof fault.before === 'function') { delete faults[method]; await fault.before(args); }
    let result;
    try { result = fault && typeof fault === 'object' && typeof fault.reply === 'function' ? (delete faults[method], json(fault.reply(args))) : method === 'asset_library' ? assetLibrary(json(args)) : typeof service[method] === 'function' ? json(await service[method](json(args))) : (() => { throw new BridgeError('unsupported_method', 'No such host method.'); })(); }
    catch (error) { throw mapError(error); }
    if (typeof fault === 'function') { delete faults[method]; result = json(fault(result, args)); }
    if (typeof transforms[method] === 'function') result = json(transforms[method](result, args));
    return result;
  } };
  const tree = async (dir = runtimeDir) => {
    const out = {};
    for (const name of await readdir(dir).catch(() => [])) {
      const file = join(dir, name), info = await lstat(file);
      if (info.isDirectory()) for (const [key, value] of Object.entries(await tree(file))) out[`${name}/${key}`] = value;
      else out[name] = `${info.size}:${info.mtimeMs}:${sha256(await readFile(file))}`;
    }
    return out;
  };
  return { runtimeDir, get service() { return service; }, get batch() { return batch; }, rebuild, jobs, submitted, history, studies, readerBusy, addHistory, addStudy, bridge, calls, faults, transforms, tree,
    count: method => calls.filter(call => call.method === method).length, methods: () => calls.map(call => call.method) };
}

async function connect(t, bridgeClient, { create = options => merged.createNovelAiMcpServer(options), compact = false } = {}) {
  // 0.1.4: an unknown enqueue outcome is settled in the call; its sleeps advance a fake clock here instead of waiting.
  const clock = { t: 0 };
  const server = create({ bridgeClient, wholeResults: !compact, recipeQueue: { monotonicNow: () => clock.t, sleep: async ms => { clock.t += ms; } } });
  const client = new Client({ name: 'recipes-modes-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { call: withLookup(client, bridgeClient, { monotonicNow: () => clock.t, sleep: async ms => { clock.t += ms; } }), readRecipe: directRecipes(bridgeClient) };
}
// read_recipe is no longer an MCP tool. Stored-revision readbacks go through the recipe module's read() on the same
// bridge double, in the same success/error envelope a core tool returns.
const directRecipes = (bridgeClient, action = 'read', options = {}) => {
  const recipes = recipeQueue.createRecipeQueue({ bridge: bridgeClient, ...options });
  return async args => {
    try { return success(await recipes[action](args), [], projectRoots(PROJECT_ROOT)); }
    catch (error) { return errorResult(failure(error, { roots: projectRoots(PROJECT_ROOT), trusted: trustedIdentities(args), policy: 'opaque', layer: 'core' })); }
  };
};
// lookup_enqueue is no longer an MCP tool either (retired on 2026-11-13: enqueue_recipes with the same key and plan answers
// what a key holds). What a key holds is still asserted here through the recipe module's lookup(), under the old name.
const withLookup = (client, bridgeClient, options) => { const lookup = directRecipes(bridgeClient, 'lookup', options); return (name, args) => name === 'lookup_enqueue' ? lookup(args) : client.callTool({ name, arguments: args }); };
// The servers of this file answer prepare_recipe with the whole readback (wholeResults, a test option); connect {compact:true} is the
// server an agent gets, with the compact readback (search "compact readback").
const errorOf = result => { assert.equal(result.isError, true, JSON.stringify(result.structuredContent ?? result).slice(0, 2000)); return result.structuredContent.error; };
const ok = result => { assert.ok(!result.isError, JSON.stringify(result.structuredContent ?? result).slice(0, 4000)); return result.structuredContent; };
const ref = recipe => ({ recipeId: recipe.recipeId, recipeRevision: recipe.recipeRevision, inputHash: recipe.inputHash });
const retamper = (reply, mutate) => {
  const copy = structuredClone(reply); mutate(copy.snapshot, copy);
  const { assets, ...input } = copy.snapshot.reviewInput;
  return { ...copy, inputHash: recipeQueue.recipeHash({ ...input, assets: assets.map(({ data: _d, ...asset }) => asset) }) };
};
const GEN = { model: 'nai-diffusion-4-5-full', steps: 28, cfgScale: 5, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', ucPreset: 0, qualityPreset: 'standard', stylePrompt: 'watercolor', positivePrompt: '1girl, garden', negativePrompt: 'blurry', seed: 1234 };
const recipes = source => ({
  i2i: (patch = {}) => ({ mode: 'i2i', source, ...GEN, width: 832, height: 1216, strength: 0.55, ...patch }),
  enhance: (patch = {}) => ({ mode: 'enhance', source, ...GEN, magnitude: 3, scale: 1, ...patch }),
  inpaint: (mask, patch = {}) => ({ mode: 'inpaint', source, ...GEN, strength: 0.8, mask, ...patch }),
  upscale: (patch = {}) => ({ mode: 'upscale', source, scale: 2, ...patch }),
  director: (patch = {}) => ({ mode: 'director', source, tool: 'bg-removal', ...patch }),
});
const RECT_MASK = { units: 'fraction', layers: [{ op: 'add', shape: { type: 'rect', x: 0.25, y: 0.25, width: 0.5, height: 0.25 } }] };
/** Selected 8×8 cells of the host's own request mask (it is already the cell-expanded binary mask). */
async function hostRequestMaskCells(h, recipe) {
  const full = json(await h.service.read_queue_recipe({ recipeId: recipe.recipeId, recipeRevision: recipe.recipeRevision }));
  const asset = full.snapshot.reviewInput.assets.find(item => item.role === 'request-mask');
  const image = PNG.sync.read(Buffer.from(asset.data, 'base64'));
  let selected = 0;
  for (let y = 0; y < image.height; y += 8) for (let x = 0; x < image.width; x += 8) if (image.data[(y * image.width + x) * 4] > 155) selected++;
  return selected;
}

const omit = (value, ...keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const readbackOf = prepared => omit(prepared, 'saved', 'generationSubmitted', 'next');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const historyFacts = (id, bytes, width, height, mimeType = 'image/png') => ({ kind: 'history', historyId: id, historyRevision: 1, assetId: `${id}-original`, sha256: sha256(bytes), mimeType, width, height, byteLength: bytes.length });

// ------------------------------------------------------------------------------------------------ P1
test('P1 i2i, enhance, upscale and director: one source metadata read, one put by reference; the readback names the history source and the actual mode input', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const bytes = gradient(832, 1216), small = gradient(512, 768), big = gradient(1280, 1280);
  const source = h.addHistory('history-source', bytes, { width: 832, height: 1216 }), smallSource = h.addHistory('history-small', small, { width: 512, height: 768 }), bigSource = h.addHistory('history-big', big, { width: 1280, height: 1280 });
  const r = recipes(source);
  const cases = [
    ['i2i', r.i2i(), source, bytes, v => {
      assert.deepEqual(v.authored.strength, 0.55); assert.equal(v.authored.extraNoiseSeed, null); assert.equal(v.authored.width, 832);
      assert.deepEqual(v.effective.i2i, { strength: 0.55, noise: 0, extraNoiseSeedPolicy: 'random_on_submit', extraNoiseSeed: null });
      assert.equal(v.effective.positivePrompt, 'watercolor, 1girl, garden, very aesthetic, masterpiece, no text');
      assert.equal(v.effectiveRequest.action, 'img2img'); assert.deepEqual(v.effectiveRequest.parameters.image, { assetRole: 'request-source' });
      assert.equal(v.effective.sourceResized, null); assert.deepEqual(v.warnings, []);
    }],
    ['i2i within 3% (stretched, warned)', r.i2i({ width: 768, height: 1152, extraNoiseSeed: 99, seed: null }), source, bytes, v => {
      assert.deepEqual(v.effective.sourceResized, { from: { width: 832, height: 1216 }, to: { width: 768, height: 1152 } });
      assert.deepEqual(v.warnings.map(warning => warning.code), ['source_resized_for_i2i']);
      assert.deepEqual(v.effective.i2i, { strength: 0.55, noise: 0, extraNoiseSeedPolicy: 'fixed', extraNoiseSeed: 99 });
      assert.equal(v.authored.extraNoiseSeed, 99); assert.equal(v.effective.seedPolicy, 'random_on_submit'); assert.equal(v.authored.seed, null);
    }],
    ['enhance', r.enhance({ characters: [{ prompt: 'girl', useCoords: false }] }), source, bytes, v => {
      assert.deepEqual([v.effective.width, v.effective.height], [832, 1216]);
      assert.deepEqual(v.effective.enhance, { magnitude: 3, scale: 1, derivedStrength: 0.202 });
      assert.equal(v.effective.processing.resizedInput, false); assert.deepEqual(v.effective.characters.map(item => item.prompt), ['girl']);
    }],
    ['enhance 2×', recipes(smallSource).enhance({ scale: 2, magnitude: 10 }), smallSource, small, v => {
      assert.deepEqual([v.authored.width, v.authored.height, v.effective.width, v.effective.height], [1024, 1536, 1024, 1536]);
      assert.deepEqual(v.effective.enhance, { magnitude: 10, scale: 2, derivedStrength: Math.min(0.48, 0.1 + 10 * 0.034) }, 'the host derives the strength from magnitude');
      assert.deepEqual(v.effective.sourceResized, { from: { width: 512, height: 768 }, to: { width: 1024, height: 1536 } });
    }],
    ['upscale', r.upscale(), source, bytes, v => {
      assert.deepEqual(v.authored, { scale: 2 });
      assert.deepEqual(v.effective, { model: 'nai-diffusion-5-curated', scale: 2, input: { width: 832, height: 1216, resized: false }, output: { width: 1664, height: 2432 }, seedPolicy: 'unused', sampleCount: 1 });
      assert.deepEqual(v.effectiveRequest.image, { assetRole: 'request-source' }); assert.deepEqual(v.warnings, []);
    }],
    ['upscale accepting a downscale', recipes(bigSource).upscale({ acceptDownscale: true }), bigSource, big, v => {
      assert.deepEqual(v.effective.input, { width: 1024, height: 1024, resized: true }); assert.deepEqual(v.effective.output, { width: 2048, height: 2048 });
      assert.deepEqual(v.warnings.map(warning => warning.code), ['source_downscaled']);
    }],
    // 0.1.4: without acceptDownscale a large source is downscaled the same way (the host's own resize), with the warning.
    ['upscale of a large source without acceptDownscale', recipes(bigSource).upscale(), bigSource, big, v => {
      assert.deepEqual(v.effective.input, { width: 1024, height: 1024, resized: true }); assert.deepEqual(v.effective.output, { width: 2048, height: 2048 });
      assert.deepEqual(v.warnings.map(warning => warning.code), ['source_downscaled']); assert.match(v.warnings[0].message, /downscales the source to 1024×1024/);
    }],
    ['director of a large source without acceptDownscale', recipes(bigSource).director(), bigSource, big, v => {
      assert.deepEqual(v.effective.input, { width: 1024, height: 1024, resized: true, alphaFlattened: true });
      assert.deepEqual(v.warnings.map(warning => warning.code), ['source_downscaled']);
    }],
    ['director bg-removal', r.director(), source, bytes, v => {
      assert.deepEqual(v.authored, { tool: 'bg-removal', defry: 0 });
      assert.deepEqual(v.effective, { tool: 'bg-removal', options: { defry: 0 }, input: { width: 832, height: 1216, resized: false, alphaFlattened: true }, output: { width: 832, height: 1216 }, seedPolicy: 'unused', sampleCount: 1 });
    }],
    ['director colorize', r.director({ tool: 'colorize', colorizePrompt: 'red dress', defry: 2 }), source, bytes, v => {
      assert.deepEqual(v.authored, { tool: 'colorize', defry: 2, colorizePrompt: 'red dress' });
      assert.deepEqual(v.effective.options, { defry: 2, colorizePrompt: 'red dress' }); assert.equal(v.effectiveRequest.prompt, 'red dress');
    }],
    ['director emotion', r.director({ tool: 'emotion', emotion: 'sad', emotionLevel: 3 }), source, bytes, v => {
      assert.deepEqual(v.authored, { tool: 'emotion', defry: 0, emotion: 'sad', emotionLevel: 3 });
      assert.deepEqual(v.effective.options, { defry: 0, emotion: 'sad', emotionLevel: 3 }); assert.equal(v.effectiveRequest.prompt, 'sad;;3');
    }],
  ];
  for (const [label, args, used, original, check] of cases) {
    const before = h.calls.length;
    const prepared = ok(await call('prepare_recipe', args));
    assert.deepEqual(h.methods().slice(before), ['asset_library', 'put_queue_recipe'], label);
    const [read, put] = h.calls.slice(before);
    assert.deepEqual(read.args, { action: 'image', kind: 'history', id: used.historyId, revision: used.historyRevision, assetId: used.assetId, variant: 'thumbnail' }, `${label}: metadata only, never the original`);
    assert.equal(put.args.assetData, 'omit', label);
    assert.deepEqual(put.args.preparation.assets, [{ role: 'source', mimeType: 'image/png', ref: { kind: 'history', id: used.historyId, revision: used.historyRevision, assetId: used.assetId }, sha256: sha256(original), byteLength: original.length }], `${label}: a reference bound to the registered original, no bytes`);
    assert.equal(prepared.mode, args.mode); assert.equal(prepared.ready, true, label); assert.equal(prepared.saved, true); assert.equal(Object.hasOwn(prepared, 'review'), false);
    assert.deepEqual(prepared.source, historyFacts(used.historyId, original, ...(used === source ? [832, 1216] : used === smallSource ? [512, 768] : [1280, 1280])), label);
    assert.ok(prepared.assets.every(asset => !('data' in asset)), `${label}: no image bytes in the readback`);
    check(prepared);
    assert.deepEqual(ok(await readRecipe(ref(prepared))), readbackOf(prepared), `${label}: the stored readback is the same`);
  }
});

test('compact readback of image modes: only what the call did not write (the request size and model the host chose, the source size, the mask cells, a derived strength); corrections are listed', async t => {
  const h = await realHost(t);
  const { call } = await connect(t, h.bridge), { call: agent } = await connect(t, h.bridge, { compact: true });
  const source = h.addHistory('history-portrait', gradient(832, 1216), { width: 832, height: 1216 });
  const r = recipes(source), mask = { units: 'fraction', layers: [{ op: 'add', shape: { type: 'ellipse', cx: 0.5, cy: 0.35, rx: 0.2, ry: 0.12 } }] };
  const full = ok(await call('prepare_recipe', r.inpaint(mask, { preview: true })));
  const result = await agent('prepare_recipe', r.inpaint(mask, { preview: true })), compact = ok(result);
  assert.equal(result.content.filter(item => item.type === 'image').length, 1, 'the mask overlay is still attached');
  assert.deepEqual(Object.keys(compact), ['preview', 'ready', 'warnings', 'effective', 'source', 'mask', 'previewImage', 'next']);
  // The call names no size and the plain model: the inpainting model id and the request size are the host's.
  assert.deepEqual(compact.effective, { model: 'nai-diffusion-4-5-full-inpainting', width: 832, height: 1216, automaticQuality: { appendedText: full.effective.automaticQuality.appendedText }, ucPreset: { text: full.effective.ucPreset.text } });
  assert.deepEqual(compact.source, { width: 832, height: 1216 }, 'the identity the call wrote is not repeated');
  assert.deepEqual(compact.mask, { selectedCells: full.mask.selectedCells, totalCells: full.mask.totalCells, bboxCells: full.mask.bboxCells, layers: full.mask.layers });
  assert.deepEqual(compact.previewImage, { width: full.previewImage.width, height: full.previewImage.height, mimeType: 'image/webp', imageAttached: true });
  assert.match(compact.next, /Look at the attached preview/);
  const text = JSON.stringify(compact);
  for (const written of ['watercolor', '1girl, garden', 'blurry', '"spec"', 'history-portrait', full.source.sha256, full.mask.sha256, 'k_euler_ancestral', '"seed"']) assert.equal(text.includes(written), false, `${written} is not in the compact readback`);
  assert.deepEqual(compact.warnings, full.warnings);
  t.diagnostic(`inpaint readback characters: compact ${text.length}, whole ${JSON.stringify(full).length}`);
  // Saved inpaint: the identity, and no next step beyond the routine one.
  const saved = ok(await agent('prepare_recipe', r.inpaint(mask)));
  assert.deepEqual(Object.keys(saved), ['recipeId', 'recipeRevision', 'inputHash', 'ready', 'warnings', 'effective', 'source', 'mask']);

  // i2i as written: nothing but the appended texts and the source size.
  const i2i = ok(await agent('prepare_recipe', r.i2i({ preview: true })));
  assert.deepEqual(Object.keys(i2i.effective).sort(), ['automaticQuality', 'ucPreset']);
  assert.deepEqual(i2i.source, { width: 832, height: 1216 });
  // i2i without a size (the host takes it from the source), a clamped strength and a fixed extra-noise seed that is written.
  const { width: _w, height: _h, ...unsized } = r.i2i({ preview: true, strength: 2, extraNoiseSeed: 99 });
  const sized = ok(await agent('prepare_recipe', unsized));
  assert.deepEqual([sized.effective.width, sized.effective.height, sized.effective.i2i], [832, 1216, { strength: 1 }]);
  assert.ok(sized.warnings.some(warning => warning.field === 'strength'));
  // enhance: the request size and the strength derived from magnitude are the host's.
  const enhance = ok(await agent('prepare_recipe', r.enhance({ preview: true })));
  assert.deepEqual([enhance.effective.width, enhance.effective.height, enhance.effective.enhance], [832, 1216, { derivedStrength: 0.202 }]);
  assert.deepEqual(Object.keys(enhance.effective).sort(), ['automaticQuality', 'enhance', 'height', 'ucPreset', 'width'], 'no second strength, no processing sizes equal to the request size');
  const max = ok(await agent('prepare_recipe', r.enhance({ model: 'nai-diffusion-5-full', scale: 'max', preview: true })));
  assert.deepEqual([max.effective.enhance.expectedOutput, max.effective.processing.upscaledEnhance], [{ width: 1440, height: 2144 }, true]);
  // Post-processing: the sizes; the tool and scale the call wrote are not repeated.
  const upscale = ok(await agent('prepare_recipe', r.upscale({ preview: true })));
  const whole = ok(await call('prepare_recipe', r.upscale({ preview: true }))).effective;
  assert.deepEqual(upscale, { preview: true, ready: true, warnings: [], effective: { input: whole.input, output: whole.output } });
  const director = ok(await agent('prepare_recipe', r.director({ tool: 'emotion', emotion: 'sad', emotionLevel: 3, preview: true })));
  assert.deepEqual(Object.keys(director.effective), ['input', 'output']);
});

test('P1 inpaint with a shape mask, an inverted grown alpha layer and both combined: the host request mask has exactly the cells this server computed', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const bytes = gradient(832, 1216), source = h.addHistory('history-portrait', bytes, { width: 832, height: 1216 });
  const cutout = subject(832, 1216, 300), alpha = h.addHistory('history-cutout', cutout, { width: 832, height: 1216 });
  const half = subject(416, 608, 150), halfAlpha = h.addHistory('history-cutout-half', half, { width: 416, height: 608 });
  const r = recipes(source), id = ({ historyId, historyRevision, assetId }) => ({ historyId, historyRevision, assetId });
  const cases = [
    ['shapes', { units: 'fraction', layers: [{ op: 'add', shape: { type: 'ellipse', cx: 0.5, cy: 0.35, rx: 0.2, ry: 0.12 } }, { op: 'add', shape: { type: 'stroke', points: [[0.3, 0.6], [0.5, 0.7], [0.7, 0.6]], widthPx: 40 } },
      { op: 'add', shape: { type: 'polygon', points: [[0.1, 0.8], [0.3, 0.75], [0.25, 0.95]] } }, { op: 'subtract', shape: { type: 'rect', x: 0.45, y: 0.3, width: 0.1, height: 0.1 } }] }, [], []],
    ['background from an alpha layer', { units: 'px', layers: [{ op: 'add', alpha: id(alpha), growPx: 8, invert: true }] }, [cutout], []],
    ['rect ∩ subject, alpha scaled', { units: 'fraction', layers: [{ op: 'add', shape: { type: 'rect', x: 0.2, y: 0.2, width: 0.6, height: 0.3 } }, { op: 'subtract', alpha: { ...id(halfAlpha), threshold: 200 }, invert: true }] }, [half], ['alpha_scaled']],
  ];
  for (const [label, mask, alphaImages, warningCodes] of cases) {
    const before = h.calls.length;
    const prepared = ok(await call('prepare_recipe', r.inpaint(mask)));
    assert.deepEqual(h.methods().slice(before), ['asset_library', ...alphaImages.map(() => 'asset_library'), 'put_queue_recipe'], label);
    for (const [index, call] of h.calls.slice(before + 1, before + 1 + alphaImages.length).entries()) assert.equal(call.args.variant, 'original', `${label}: alpha layer ${index} reads its original`);
    const local = buildMask(sources.prepareMaskSpec(mask).spec, { width: 832, height: 1216, alphaImages });
    assert.ok(local.selectedCells > 0, label);
    assert.deepEqual(prepared.mask, { sha256: local.sha256, width: 832, height: 1216, selectedCells: local.selectedCells, totalCells: 104 * 152, bboxCells: local.bboxCells, layers: local.readback.layers, spec: local.spec }, label);
    assert.equal(await hostRequestMaskCells(h, prepared), local.selectedCells, `${label}: host request-mask cells = simulated cells`);
    assert.deepEqual(prepared.warnings.map(warning => warning.code), warningCodes, label);
    const put = h.calls.at(-1).args;
    assert.deepEqual(put.preparation.assets.map(asset => asset.role), ['source', 'mask']);
    assert.deepEqual(put.preparation.assets[1].provenance, { spec: local.spec, selectedCells: local.selectedCells, totalCells: local.totalCells, bboxCells: local.bboxCells, layers: local.readback.layers });
    assert.deepEqual(put.preparation.authored, { params: {}, inpaintModel: 'nai-diffusion-4-5-full-inpainting', inpaintStrength: 0.8, inpaintRecipe: { promptAssemblyVersion: 1, model: 'nai-diffusion-4-5-full', stylePrompt: 'watercolor', positivePrompt: '1girl, garden', negativePrompt: 'blurry',
      width: 832, height: 1216, steps: 28, cfgScale: 5, cfgRescale: 0, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', seed: 1234, seedMode: 'fixed', ucPreset: 0, qualityPreset: 'standard', qualityToggle: true, transparentBackground: false } });
    assert.equal(prepared.authored.model, 'nai-diffusion-4-5-full'); assert.equal(prepared.authored.inpaintModel, 'nai-diffusion-4-5-full-inpainting');
    assert.deepEqual(prepared.effective.inpaint, { model: 'nai-diffusion-4-5-full-inpainting', strength: 0.8, width: 832, height: 1216 });
    assert.equal(prepared.effectiveRequest.action, 'infill'); assert.deepEqual(prepared.effective.characters, []);
    assert.deepEqual(prepared.source, historyFacts('history-portrait', bytes, 832, 1216));
    // P12: the stored readback gives the same mask back from the stored provenance (the mask warnings exist only at prepare time).
    assert.deepEqual(ok(await readRecipe(ref(prepared))), { ...readbackOf(prepared), warnings: prepared.warnings.filter(warning => !warningCodes.includes(warning.code)) }, label);
  }
});

// ------------------------------------------------------------------------------------------------ P2
test('P2 every invalid image-mode argument is refused before any host call, mask errors with their reason and path', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const source = { kind: 'history', historyId: 'history-x', historyRevision: 1, assetId: 'asset-x' }, r = recipes(source);
  const rect = { op: 'add', shape: { type: 'rect', x: 0.1, y: 0.1, width: 0.2, height: 0.2 } };
  const mask = (...layers) => ({ units: 'fraction', layers });
  const id = { historyId: 'h-a', historyRevision: 1, assetId: 'a-a' };
  const cases = {
    t2iWithSource: { mode: 't2i', ...GEN, width: 832, height: 1216, source }, unknownMode: { ...r.upscale(), mode: 'variation' },
    i2iTransparent: r.i2i({ transparentBackground: true }), i2iNoSource: omit(r.i2i(), 'source'), i2iNoStrength: omit(r.i2i(), 'strength'), i2iStringStrength: r.i2i({ strength: '0.5' }),
    i2iFractionalNoise: r.i2i({ extraNoiseSeed: 1.5 }), i2iMask: r.i2i({ mask: RECT_MASK }), i2iMagnitude: r.i2i({ magnitude: 3 }), i2iStringWidth: r.i2i({ width: '832' }), i2iAcceptDownscale: r.i2i({ acceptDownscale: true }),
    enhanceWidth: r.enhance({ width: 832 }), enhanceStrength: r.enhance({ strength: 0.5 }), enhanceScale3: r.enhance({ scale: 3 }), enhanceNoScale: omit(r.enhance(), 'scale'), enhanceFractionalMagnitude: r.enhance({ magnitude: 2.5 }),
    enhanceTransparent: r.enhance({ transparentBackground: true }), enhanceNoSeed: omit(r.enhance(), 'seed'),
    inpaintWidth: r.inpaint(RECT_MASK, { width: 832 }), inpaintCharacters: r.inpaint(RECT_MASK, { characters: [{ prompt: 'a', useCoords: false }] }), inpaintFurry: r.inpaint(RECT_MASK, { model: 'nai-diffusion-furry-3', noiseSchedule: 'native' }),
    inpaintInpaintingModel: r.inpaint(RECT_MASK, { model: 'nai-diffusion-4-5-full-inpainting' }), inpaintNoMask: omit(r.inpaint(RECT_MASK), 'mask'), inpaintExtraNoise: r.inpaint(RECT_MASK, { extraNoiseSeed: 5 }),
    inpaintTransparent: r.inpaint(RECT_MASK, { transparentBackground: true }), inpaintNoStrength: omit(r.inpaint(RECT_MASK), 'strength'),
    upscaleScale4: r.upscale({ scale: 4 }), upscaleStringDownscale: r.upscale({ acceptDownscale: 'no' }), upscaleSeed: r.upscale({ seed: 1 }), upscalePrompt: r.upscale({ positivePrompt: 'x' }), upscaleModel: r.upscale({ model: 'nai-diffusion-4-5-full' }), upscaleMask: r.upscale({ mask: RECT_MASK }),
    directorUnknownTool: r.director({ tool: 'paint' }), directorNoTool: omit(r.director(), 'tool'), directorPromptOnBg: r.director({ colorizePrompt: 'x' }), directorEmotionMissing: r.director({ tool: 'emotion', emotionLevel: 2 }),
    directorEmotionOnColorize: r.director({ tool: 'colorize', colorizePrompt: 'x', emotion: 'happy', emotionLevel: 1 }), directorBadEmotion: r.director({ tool: 'emotion', emotion: 'joy', emotionLevel: 1 }),
    directorLevelOnBg: r.director({ emotionLevel: 2 }), directorFractionalDefry: r.director({ defry: 1.5 }), directorSeed: r.director({ seed: 1 }), directorSteps: r.director({ steps: 28 }), directorScale: r.director({ scale: 2 }),
    sourceKind: r.upscale({ source: { ...source, kind: 'file' } }), sourceNoAsset: r.upscale({ source: omit(source, 'assetId') }), sourceRevision0: r.upscale({ source: { ...source, historyRevision: 0 } }),
    sourceBytes: r.upscale({ source: { ...source, data: 'iVBORw0KGgo=' } }), sourcePath: r.upscale({ source: '/Users/x/a.png' }), sourceBlankId: r.upscale({ source: { ...source, historyId: ' ' } }), previewString: r.upscale({ preview: 'yes' }),
    revisionWithoutId: r.upscale({ expectedRevision: 1 }),
  };
  for (const [name, args] of Object.entries(cases)) assert.equal(errorOf(await call('prepare_recipe', args)).code, 'invalid_arguments', name);
  const maskCases = {
    firstSubtract: [mask({ ...rect, op: 'subtract' }), 'mask_first_layer_not_add', 'mask.layers[0].op'], shapeAndAlpha: [mask({ ...rect, alpha: id }), 'mask_spec_invalid', 'mask.layers[0]'],
    rectWithPoints: [mask({ op: 'add', shape: { ...rect.shape, points: [[0, 0]] } }), 'mask_spec_invalid', 'mask.layers[0].shape.points'], seventeenLayers: [mask(...Array.from({ length: 17 }, () => rect)), 'mask_limit_exceeded', 'mask.layers'],
    polygonTwoPoints: [mask({ op: 'add', shape: { type: 'polygon', points: [[0, 0], [1, 1]] } }), 'mask_spec_invalid', 'mask.layers[0].shape.points'],
    strokeWidth0: [mask({ op: 'add', shape: { type: 'stroke', points: [[0.5, 0.5]], widthPx: 0 } }), 'mask_value_out_of_range', 'mask.layers[0].shape.widthPx'],
    strokeWidth513: [mask({ op: 'add', shape: { type: 'stroke', points: [[0.5, 0.5]], widthPx: 513 } }), 'mask_value_out_of_range', 'mask.layers[0].shape.widthPx'],
    threeAlpha: [mask(rect, { op: 'add', alpha: id }, { op: 'add', alpha: id }, { op: 'add', alpha: id }), 'mask_limit_exceeded', 'mask.layers[3].alpha'],
    outOfRange: [mask({ op: 'add', shape: { ...rect.shape, x: 2 } }), 'mask_coordinate_out_of_range', 'mask.layers[0].shape.x'], grow300: [mask({ ...rect, growPx: 300 }), 'mask_value_out_of_range', 'mask.layers[0].growPx'],
    units: [{ units: 'percent', layers: [rect] }, 'mask_spec_invalid', 'mask.units'], alphaNoAsset: [mask(rect, { op: 'add', alpha: omit(id, 'assetId') }), 'mask_spec_invalid', 'mask.layers[1].alpha.assetId'],
    roundedToZero: [{ units: 'px', layers: [{ op: 'add', shape: { type: 'rect', x: 10, y: 10, width: 0.3, height: 20 } }] }, 'mask_value_out_of_range', 'mask.layers[0].shape.width'],
  };
  // The public schema only says "object"; everything inside is checked by the mask module, which reports reason and path.
  assert.equal(errorOf(await call('prepare_recipe', r.inpaint('rect'))).code, 'invalid_arguments');
  for (const [name, [spec, reason, path]] of Object.entries(maskCases)) {
    const error = errorOf(await call('prepare_recipe', r.inpaint(spec)));
    assert.equal(error.code, 'invalid_arguments', name);
    assert.deepEqual([error.details?.reason, error.details?.path], [reason, path], `${name}: ${error.message}`);
  }
  assert.match(errorOf(await call('prepare_recipe', r.inpaint(maskCases.roundedToZero[0]))).message, /after rounding px coordinates to whole pixels/);
  assert.deepEqual(errorOf(await call('prepare_recipe', r.i2i({ transparentBackground: true }))).details, { reason: 'field_not_in_mode', fields: ['transparentBackground'] });
  assert.deepEqual(h.calls, [], 'no invalid preparation reached the host');
});

test('P2b (0.1.4) image-mode values the host would clamp, snap, resize or convert are corrected with a warning each, saved as they run', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const add = (id, width, height) => h.addHistory(id, gradient(width, height), { width, height });
  const portrait = add('c-portrait', 832, 1216), square = add('c-square', 1024, 1024), odd = add('c-odd', 1000, 1500), unaligned = add('c-unaligned', 830, 1216);
  const large = add('c-large', 1216, 1216), huge = add('c-huge', 2048, 2048), big = add('c-big', 1280, 1280), r = recipes(portrait);
  const warning = (prepared, code, field) => prepared.warnings.find(item => item.code === code && (field === undefined || item.field === field));
  const cases = [
    ['i2i strength 2', r.i2i({ strength: 2 }), 'value_clamped', 'strength', 2, 1, v => v.effective.i2i.strength === 1],
    ['i2i width 833', r.i2i({ width: 833 }), 'size_adjusted', 'width×height', { width: 833, height: 1216 }, { width: 832, height: 1216 }, v => v.effective.width === 832],
    ['i2i characters on V3', r.i2i({ model: 'nai-diffusion-3', noiseSchedule: 'native', characters: [{ prompt: 'a', useCoords: false }] }), 'value_dropped', 'characters', 1, 0, v => v.authored.characters.length === 0],
    ['i2i aspect off the source', recipes(square).i2i(), 'i2i_size_adjusted', 'width×height', { width: 832, height: 1216 }, { width: 1024, height: 1024 }, v => v.effective.width === 1024 && v.effective.height === 1024 && v.effective.sourceResized === null],
    ['i2i without a size', omit(r.i2i(), 'width', 'height'), 'i2i_size_from_source', 'width×height', null, { width: 832, height: 1216 }, v => v.effective.width === 832 && v.effective.height === 1216],
    ['i2i without a size, 2:3 source', omit(recipes(odd).i2i(), 'width', 'height'), 'i2i_size_from_source', 'width×height', null, { width: 832, height: 1216 }, v => v.effective.width * v.effective.height <= 1024 * 1024],
    ['i2i without a size, square source', omit(recipes(square).i2i(), 'width', 'height'), 'i2i_size_from_source', 'width×height', null, { width: 1024, height: 1024 }, v => v.effective.sourceResized === null],
    ['i2i with only a width', omit(r.i2i({ width: 1024 }), 'height'), 'i2i_size_from_source', 'width×height', { width: 1024 }, { width: 1024, height: 1472 }, v => v.effective.width === 1024],
    ['enhance magnitude 0', r.enhance({ magnitude: 0 }), 'value_clamped', 'magnitude', 0, 1, v => v.effective.enhance.magnitude === 1],
    ['enhance magnitude 11', r.enhance({ magnitude: 11 }), 'value_clamped', 'magnitude', 11, 10, v => v.effective.enhance.magnitude === 10],
    ['enhance of an unaligned source', recipes(unaligned).enhance(), 'enhance_source_adjusted', 'source', { width: 830, height: 1216 }, { width: 832, height: 1216 }, v => v.effective.width === 832],
    ['enhance 2× over the area', recipes(large).enhance({ scale: 2 }), 'value_replaced', 'scale', 2, 1, v => v.effective.enhance.scale === 1 && v.effective.width === 1216],
    ['enhance 1× over the area', recipes(huge).enhance(), 'enhance_source_adjusted', 'source', { width: 2048, height: 2048 }, { width: 1728, height: 1728 }, v => v.effective.width === 1728],
    ['inpaint light on V4.5', r.inpaint(RECT_MASK, { qualityPreset: 'light' }), 'value_replaced', 'qualityPreset', 'light', 'standard', v => v.authored.qualityPreset === 'standard'],
    ['inpaint strength -1', r.inpaint(RECT_MASK, { strength: -1 }), 'value_clamped', 'strength', -1, 0, v => v.authored.strength === 0],
    ['inpaint of an unaligned source', recipes(unaligned).inpaint(RECT_MASK), 'inpaint_source_adjusted', 'source', { width: 830, height: 1216 }, { width: 832, height: 1216 }, v => v.effective.inpaint.width === 832 && v.effective.requestSource.width === 832],
    ['upscale scale 1', r.upscale({ scale: 1 }), 'value_replaced', 'scale', 1, 2, v => v.effective.scale === 2],
    ['director emotion without a level', r.director({ tool: 'emotion', emotion: 'happy' }), 'value_defaulted', 'emotionLevel', null, 0, v => v.effective.options.emotionLevel === 0],
    ['director emotion level 6', r.director({ tool: 'emotion', emotion: 'happy', emotionLevel: 6 }), 'value_clamped', 'emotionLevel', 6, 5, v => v.effective.options.emotionLevel === 5],
    ['director defry 6', r.director({ defry: 6 }), 'value_clamped', 'defry', 6, 5, v => v.effective.options.defry === 5],
  ];
  for (const [label, args, code, field, from, to, check] of cases) {
    const prepared = ok(await call('prepare_recipe', args));
    const found = warning(prepared, code, field);
    assert.ok(found, `${label}: ${JSON.stringify(prepared.warnings)}`);
    assert.deepEqual([found.from, found.to], [from, to], label); assert.equal(typeof found.message, 'string');
    assert.equal(prepared.ready, true, label);
    assert.ok(check(prepared), `${label}: ${JSON.stringify({ effective: prepared.effective, authored: prepared.authored })}`);
    assert.equal(ok(await readRecipe(ref(prepared))).inputHash, prepared.inputHash, `${label}: stored as it runs`);
  }
  // An i2i size within 3% of the source aspect is kept as given (the host's slight stretch is the readback's own warning).
  const near = ok(await call('prepare_recipe', r.i2i({ width: 768, height: 1152 })));
  assert.deepEqual([near.effective.width, near.effective.height], [768, 1152]); assert.equal(warning(near, 'i2i_size_adjusted'), undefined);
  // Without a size the readback names it: the i2i request is exactly the chosen size.
  const sized = ok(await call('prepare_recipe', omit(recipes(odd).i2i(), 'width', 'height')));
  assert.deepEqual([sized.authored.width, sized.authored.height, sized.effectiveRequest.parameters.width, sized.effectiveRequest.parameters.height], [832, 1216, 832, 1216]);
  assert.match(warning(sized, 'i2i_size_from_source').message, /keeps the source aspect \(1000×1500/);
  // The aspect helper: closest area within the 3% stretch tolerance, never over the limit.
  assert.deepEqual(recipeQueue.aspectSize(1024, 1024, 832 * 1216, 1024 * 1024), { width: 1024, height: 1024 });
  assert.deepEqual(recipeQueue.aspectSize(1920, 1080, 832 * 1216, 1024 * 1024), { width: 1344, height: 768 });
  const wide = recipeQueue.aspectSize(8000, 100, 3_145_728);
  assert.ok(wide.width * wide.height <= 3_145_728 && Math.abs(wide.width / wide.height - 80) / 80 <= 0.03, JSON.stringify(wide));
  const strip = recipeQueue.aspectSize(100_000, 10, 832 * 1216, 1024 * 1024);
  assert.deepEqual(strip.height, 64, 'an aspect no size can keep: as close as any size gets'); assert.ok(strip.width * strip.height <= 1024 * 1024);
  // A colorize without colorizePrompt runs with an empty one; Upscale needs no scale at all.
  assert.equal(ok(await call('prepare_recipe', r.director({ tool: 'colorize' }))).effective.options.colorizePrompt, '');
  assert.deepEqual(ok(await call('prepare_recipe', omit(r.upscale(), 'scale'))).warnings, []);
  // A large upscale source is downscaled by default (P1), here with the module's own plan.
  assert.equal(recipeQueue.recipePlan(recipes(big).upscale()).acceptDownscale, true);
  assert.equal(recipeQueue.recipePlan(recipes(big).upscale({ acceptDownscale: false })).acceptDownscale, false);
});

test('P9 (W3 side) mask coordinates are rounded before rasterizing: fraction to 4 decimals, px to whole pixels; widths, grow and thresholds are kept', () => {
  const { spec } = sources.prepareMaskSpec({ units: 'fraction', layers: [{ op: 'add', shape: { type: 'rect', x: 0.123456, y: 0.1, width: 0.333333, height: 0.2 } }, { op: 'add', shape: { type: 'stroke', points: [[0.11114, 0.5], [0.6, 0.77777]], widthPx: 12.5 }, growPx: 3 }] });
  assert.deepEqual(spec.layers[0].shape, { type: 'rect', x: 0.1235, y: 0.1, width: 0.3333, height: 0.2 });
  assert.deepEqual(spec.layers[1], { op: 'add', shape: { type: 'stroke', points: [[0.1111, 0.5], [0.6, 0.7778]], widthPx: 12.5 }, growPx: 3, invert: false });
  const px = sources.prepareMaskSpec({ units: 'px', layers: [{ op: 'add', shape: { type: 'ellipse', cx: 100.6, cy: -0.4, rx: 30.2, ry: 10.5 } }, { op: 'add', alpha: { historyId: 'h', historyRevision: 1, assetId: 'a', threshold: 7 }, invert: true }] }).spec;
  assert.deepEqual(px.layers[0].shape, { type: 'ellipse', cx: 101, cy: 0, rx: 30, ry: 11 }); assert.ok(Object.is(px.layers[0].shape.cy, 0), 'no negative zero');
  assert.deepEqual(px.layers[1], { op: 'add', alpha: { historyId: 'h', historyRevision: 1, assetId: 'a', threshold: 7 }, growPx: 0, invert: true });
});

// ------------------------------------------------------------------------------------------------ P3
test('P3 sources and alpha layers that cannot run (or whose downscale was declined) are refused after the metadata read and before any put', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const add = (id, width, height, bytes = gradient(width, height), options = {}) => h.addHistory(id, bytes, { width, height, ...options });
  const portrait = add('portrait', 832, 1216), r = recipes(portrait), id = ({ historyId, historyRevision, assetId }) => ({ historyId, historyRevision, assetId });
  const alphaMask = alpha => ({ units: 'fraction', layers: [{ op: 'add', shape: { type: 'rect', x: 0.1, y: 0.1, width: 0.5, height: 0.5 } }, { op: 'subtract', alpha: id(alpha) }] });
  const noise = Buffer.alloc(1800 * 1900 * 4); for (let i = 0; i < noise.length; i += 4) noise.writeUInt32BE((Math.random() * 0xffffffff) >>> 0, i);
  const hugeAlpha = PNG.sync.write(Object.assign(new PNG({ width: 1800, height: 1900 }), { data: noise }), { deflateLevel: 0 });
  assert.ok(hugeAlpha.length > 12 * MiB && hugeAlpha.length < 20 * MiB, `${hugeAlpha.length}`);
  const cases = [
    ['gif source', recipes(add('gif', 1, 1, GIF, { mimeType: 'image/gif' })).upscale(), 'source_unsupported_type', 1],
    ['inpaint over 1600', recipes(add('wide', 1664, 1024)).inpaint(RECT_MASK), 'inpaint_source_too_large', 1],
    ['inpaint over 1600 once aligned up', recipes(add('wide-odd', 1610, 1024)).inpaint(RECT_MASK), 'inpaint_source_too_large', 1],
    ['upscale over 1 MP, downscale declined', recipes(add('big-up', 1280, 1280)).upscale({ acceptDownscale: false }), 'source_needs_downscale', 1],
    ['upscale output over 4096', recipes(add('strip', 4096, 128)).upscale(), 'upscale_output_too_large', 1],
    ['director over 1 MP, downscale declined', recipes(add('big-director', 1280, 1280)).director({ acceptDownscale: false }), 'source_needs_downscale', 1],
    ['alpha is a JPEG', r.inpaint(alphaMask(add('alpha-jpeg', 832, 1216, await toJpeg(subject(832, 1216)), { mimeType: 'image/jpeg' }))), 'alpha_not_png', 2],
    ['alpha is 16-bit', r.inpaint(alphaMask(add('alpha-16', 832, 1216, PNG.sync.write(PNG.sync.read(subject(832, 1216)), { bitDepth: 16 })))), 'alpha_png_unsupported', 2],
    ['alpha is interlaced', r.inpaint(alphaMask(add('alpha-adam7', 832, 1216, await sharp(subject(832, 1216)).png({ progressive: true }).toBuffer()))), 'alpha_png_unsupported', 2],
    ['alpha aspect differs', r.inpaint(alphaMask(add('alpha-square', 1000, 1000, subject(1000, 1000)))), 'alpha_aspect_mismatch', 2],
    ['alpha over 12 MiB', r.inpaint(alphaMask(add('alpha-huge', 1800, 1900, hugeAlpha))), 'alpha_png_too_large', 2],
  ];
  for (const [label, args, reason, reads] of cases) {
    const before = h.calls.length;
    const error = errorOf(await call('prepare_recipe', args));
    assert.equal(error.code, 'invalid_arguments', `${label}: ${error.message}`); assert.equal(error.details?.reason, reason, `${label}: ${error.message}`);
    assert.deepEqual(h.methods().slice(before), Array(reads).fill('asset_library'), `${label}: nothing saved`);
  }
  const declined = errorOf(await call('prepare_recipe', recipes(add('big-up-2', 1280, 1280)).upscale({ acceptDownscale: false })));
  assert.match(declined.message, /acceptDownscale is false; the host would downscale it to 1024×1024/); assert.deepEqual(declined.details.downscaledTo, { width: 1024, height: 1024 });
  // A mask that selects no latent cell after the host's 8×8 sampling.
  const empty = errorOf(await call('prepare_recipe', r.inpaint({ units: 'fraction', layers: [{ op: 'add', shape: { type: 'rect', x: 0.5, y: 0.5, width: 0.002, height: 0.002 } }] })));
  assert.equal(empty.code, 'mask_empty'); assert.equal(empty.details.reason, 'mask_empty'); assert.equal(empty.details.selectedCells, 0);
  // An unknown history identity is the asset library's own answer, passed through; nothing is saved.
  const missing = errorOf(await call('prepare_recipe', recipes({ kind: 'history', historyId: 'gone', historyRevision: 1, assetId: 'gone-original' }).upscale()));
  assert.equal(missing.code, 'library_not_found'); assert.equal(missing.details.saved, false); assert.equal(missing.details.path, 'source');
  const missingAlpha = errorOf(await call('prepare_recipe', r.inpaint({ units: 'px', layers: [{ op: 'add', alpha: { historyId: 'gone', historyRevision: 1, assetId: 'x' } }] })));
  assert.equal(missingAlpha.code, 'library_not_found'); assert.equal(missingAlpha.details.path, 'mask.layers[0].alpha');
  // An asset library reply that is not the requested identity is refused.
  h.faults.asset_library = reply => ({ ...reply, id: 'someone-else' });
  assert.equal(errorOf(await call('prepare_recipe', r.upscale())).code, 'invalid_response');
  assert.equal(h.count('put_queue_recipe'), 0, 'no put at all');
  assert.deepEqual(await h.tree(), {}, 'nothing was written');
});

// ------------------------------------------------------------------------------------------------ P4
test('P4 a put reply whose stored mode input, source, mask, mode or sample count differs is never adopted', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const bytes = gradient(832, 1216), source = h.addHistory('history-p4', bytes, { width: 832, height: 1216 }), r = recipes(source);
  const authored = mutate => reply => retamper(reply, snapshot => mutate(snapshot.reviewInput.authored));
  const mismatches = [
    [r.i2i(), authored(a => { a.i2iParams.strength = 0.7; }), ['i2iParams.strength']],
    [r.i2i(), authored(a => { a.i2iSizeMode = 'adaptive'; }), ['i2iSizeMode']],
    [r.i2i({ extraNoiseSeed: 5 }), authored(a => { a.i2iParams.extraNoiseSeed = 0; }), ['i2iParams.extraNoiseSeed']],
    [r.i2i(), authored(a => { a.params.steps = 27; }), ['params.steps']],
    [r.enhance(), authored(a => { a.enhanceMagnitude = 4; }), ['enhanceMagnitude']],
    [r.enhance(), authored(a => { a.params.width = 768; }), ['params.width']],
    [r.inpaint(RECT_MASK), authored(a => { a.inpaintModel = 'nai-diffusion-4-full-inpainting'; }), ['inpaintModel']],
    [r.inpaint(RECT_MASK), authored(a => { a.inpaintRecipe.seed = 9; }), ['inpaintRecipe.seed']],
    [r.inpaint(RECT_MASK), authored(a => { a.inpaintStrength = 1; }), ['inpaintStrength']],
    [r.inpaint(RECT_MASK), reply => ({ ...reply, assetProvenance: { mask: { spec: { units: 'px', layers: [] } } } }), ['assetProvenance.mask']],
    [r.upscale(), authored(a => { a.upscaleScale = 4; }), ['upscaleScale']],
    [r.upscale(), reply => retamper(reply, snapshot => { snapshot.reviewInput.effective.sampling.sampleCount = 2; }), ['effective.sampleCount']],
    [r.director({ tool: 'emotion', emotion: 'sad', emotionLevel: 2 }), authored(a => { a.augmentOptions.emotionLevel = 5; }), ['augmentOptions.emotionLevel']],
    [r.director(), authored(a => { a.directorTool = 'lineart'; }), ['directorTool']],
    [r.director({ tool: 'colorize', colorizePrompt: 'blue' }), authored(a => { a.augmentOptions.colorizePrompt = 'red'; }), ['augmentOptions.colorizePrompt']],
  ];
  for (const [args, fault, fields] of mismatches) {
    h.faults.put_queue_recipe = fault;
    const error = errorOf(await call('prepare_recipe', args));
    assert.equal(error.code, 'recipe_input_mismatch', `${args.mode} ${fields}: ${error.message}`); assert.deepEqual(error.details.fields, fields, args.mode);
  }
  const otherSha = 'e'.repeat(64);
  const unconfirmed = [
    // The stored source is another image (consistently claimed in the snapshot and the reference).
    [r.i2i(), reply => retamper(reply, (snapshot, copy) => { snapshot.reviewInput.assets.find(asset => asset.role === 'source').sha256 = otherSha; copy.assetRefs[0].sha256 = otherSha; }), 'source'],
    // The reference points at another history image.
    [r.upscale(), reply => ({ ...reply, assetRefs: [{ ...reply.assetRefs[0], ref: { ...reply.assetRefs[0].ref, id: 'another' } }] }), 'source'],
    [r.inpaint(RECT_MASK), reply => retamper(reply, snapshot => { snapshot.reviewInput.assets.find(asset => asset.role === 'mask').sha256 = otherSha; }), 'mask'],
    [r.upscale(), reply => retamper(reply, snapshot => { snapshot.mode = 'director'; snapshot.reviewInput.mode = 'director'; }), 'mode'],
    [r.i2i(), reply => retamper(reply, (snapshot, copy) => { delete copy.assetRefs; }), 'source'],
    // The host decoded another size than the library reported (the size rules were checked against the library).
    [r.inpaint(RECT_MASK), reply => retamper(reply, snapshot => { snapshot.reviewInput.assets.find(asset => asset.role === 'source').width = 768; }), 'source.size'],
  ];
  for (const [args, fault, label] of unconfirmed) {
    h.faults.put_queue_recipe = fault;
    const error = errorOf(await call('prepare_recipe', args));
    assert.equal(error.code, 'recipe_identity_unconfirmed', `${label}: ${error.message}`);
  }
  assert.equal(h.count('enqueue_queue_recipes'), 0);
});

// ------------------------------------------------------------------------------------------------ P5
test('P5 enqueue: mixed modes are refused before dispatch (key unused); post-processing seeds, counts or repeats are sent once, a fixed seed counts up; image recipes freeze their source', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const bytes = gradient(832, 1216), source = h.addHistory('history-p5', bytes, { width: 832, height: 1216 }), r = recipes(source);
  const i2i = ok(await call('prepare_recipe', r.i2i())), upscale = ok(await call('prepare_recipe', r.upscale())), director = ok(await call('prepare_recipe', r.director()));
  const refused = async (requestKey, items, check) => {
    const before = h.count('enqueue_queue_recipes');
    const error = errorOf(await call('enqueue_recipes', { requestKey, items }));
    assert.equal(error.code, 'invalid_arguments', error.message); assert.equal(error.details.enqueueSent, false); assert.equal(error.details.status, 'not_sent');
    assert.equal(h.count('enqueue_queue_recipes'), before, 'never dispatched');
    assert.equal(ok(await call('lookup_enqueue', { requestKey })).status, 'not_found', 'the key was not consumed');
    check?.(error);
  };
  await refused('mixed', [{ ...ref(i2i), seeds: [1] }, ref(upscale)], error => {
    assert.deepEqual(error.details.modes, [{ recipeId: i2i.recipeId, recipeRevision: 1, mode: 'i2i' }, { recipeId: upscale.recipeId, recipeRevision: 1, mode: 'upscale' }]);
    assert.match(error.message, /separate enqueue_recipes calls, each with its own requestKey/);
  });
  await refused('up-and-director', [ref(upscale), ref(director)], error => assert.deepEqual(error.details.modes.map(item => item.mode), ['upscale', 'director']));
  // The same key works once the plan is right: nothing was recorded under it.
  const mixedFixed = ok(await call('enqueue_recipes', { requestKey: 'mixed', items: [{ ...ref(i2i), seeds: [1, 2] }] }));
  assert.equal(mixedFixed.status, 'enqueued'); assert.deepEqual(mixedFixed.items.map(item => item.seed), [1, 2]);
  // 0.1.4: a post-processing recipe with a seed, a count or listed twice is sent once (each image would be the same
  // paid request); a fixed-seed i2i recipe for two images gets seed and seed + 1.
  const otherBytes = gradient(768, 1152), other = ok(await call('prepare_recipe', recipes(h.addHistory('history-p5-other', otherBytes, { width: 768, height: 1152 })).upscale()));
  const up = ok(await call('enqueue_recipes', { requestKey: 'up-seed', items: [{ ...ref(upscale), seeds: [5] }, ref(other), ref(upscale)] }));
  assert.equal(up.status, 'enqueued'); assert.deepEqual(up.items.map(item => [item.recipeId, item.seed]), [[upscale.recipeId, null], [other.recipeId, null]], 'post-processing images have no seed');
  const single = up.warnings.find(warning => warning.code === 'postprocess_single_image');
  assert.deepEqual([single.recipeId, single.from, single.to], [upscale.recipeId, 2, 1]); assert.match(single.message, /sent once and its seeds are not used/);
  const director3 = ok(await call('enqueue_recipes', { requestKey: 'dir-count', items: [{ ...ref(director), count: 3 }] }));
  assert.equal(director3.batch.count, 1); assert.equal(director3.warnings[0].code, 'postprocess_single_image');
  const fixed = ok(await call('enqueue_recipes', { requestKey: 'i2i-fixed', items: [{ ...ref(i2i), count: 2 }] }));
  assert.deepEqual(fixed.items.map(item => item.seed), [1234, 1235]); assert.ok(fixed.warnings.some(warning => warning.code === 'fixed_seed_incremented'));
  // What the host froze: the source bytes the history reference points at (the batch no longer depends on the library).
  const frozen = h.jobs.map(entry => entry.args);
  assert.deepEqual(frozen.map(args => args.mode), ['i2i', 'upscale', 'director', 'i2i']);
  assert.equal(frozen[0].snapshot.sourceImage.data, bytes.toString('base64'), 'one snapshot for one recipe, with the source bytes');
  assert.deepEqual(frozen[1].snapshots.map(snapshot => snapshot.sourceImage.data), [bytes.toString('base64'), otherBytes.toString('base64')], 'one snapshot per image for different recipes');
  assert.deepEqual(frozen[1].seeds, [0, 0], 'the host plans a placeholder seed for unseeded modes');
});

test('P5 the estimated frozen input of one enqueue is bounded at 32 MiB (one copy per recipe when all images share it), before dispatch', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const source = h.addHistory('history-p5b', gradient(832, 1216), { width: 832, height: 1216 }), r = recipes(source);
  const a = ok(await call('prepare_recipe', r.i2i())), b = ok(await call('prepare_recipe', r.i2i({ strength: 0.4 })));
  // The reported asset sizes (outside reviewInput, so the inputHash still verifies) stand in for a 13 MiB source.
  h.transforms.read_queue_recipe = reply => ({ ...reply, assetBytes: { source: 13 * MiB } });
  const over = errorOf(await call('enqueue_recipes', { requestKey: 'too-big', items: [{ ...ref(a), seeds: [1] }, { ...ref(b), seeds: [2] }] }));
  assert.equal(over.code, 'invalid_arguments'); assert.equal(over.details.estimatedBytes, 2 * Math.ceil(13 * MiB / 3) * 4); assert.equal(over.details.limitBytes, 32 * MiB);
  assert.equal(h.count('enqueue_queue_recipes'), 0); assert.equal(ok(await call('lookup_enqueue', { requestKey: 'too-big' })).status, 'not_found');
  assert.equal(ok(await call('enqueue_recipes', { requestKey: 'shared', items: [{ ...ref(a), seeds: [1, 2, 3, 4, 5, 6, 7, 8] }] })).status, 'enqueued', 'eight images of one recipe freeze one copy');
  assert.equal(recipeQueue.frozenInputEstimate([{ recipeId: 'x', recipeRevision: 1 }, { recipeId: 'x', recipeRevision: 1 }], new Map([['x:1', { source: 3, mask: 6 }]])), 4 + 8);
  assert.equal(recipeQueue.frozenInputEstimate([{ recipeId: 'x', recipeRevision: 1 }, { recipeId: 'y', recipeRevision: 1 }, { recipeId: 'x', recipeRevision: 1 }], new Map([['x:1', { source: 3 }], ['y:1', undefined]])), 8);
});

test('P5/P6 upscale through the real host batch service: the generation service gets mode upscale and the source; read_queue and get_queue_result give the result by history identity', async t => {
  const h = await realHost(t, { realBatch: true });
  const { call, readRecipe } = await connect(t, h.bridge);
  const bytes = gradient(832, 1216), source = h.addHistory('history-p6', bytes, { width: 832, height: 1216 });
  const upscale = ok(await call('prepare_recipe', recipes(source).upscale()));
  const receipt = ok(await call('enqueue_recipes', { requestKey: 'real-up', items: [ref(upscale)] }));
  assert.equal(receipt.status, 'enqueued'); assert.deepEqual(receipt.items.map(item => item.seed), [null]);
  await waitFor(() => h.submitted.length, 'the upscale submission');
  assert.equal(h.submitted.length, 1);
  assert.equal(h.submitted[0].mode, 'upscale'); assert.equal(h.submitted[0].snapshot.upscale.scale, 2); assert.equal(h.submitted[0].snapshot.sourceImage.data, bytes.toString('base64'));
  const read = await waitFor(async () => { const value = ok(await call('read_queue', { batchId: receipt.batch.batchId })); return value.results.length ? value : null; }, 'the upscale result');
  assert.deepEqual(read.results, [{ itemIndex: 0, index: 0, historyId: 'history-out-1', actualSeed: null }], 'upscale has no seed');
  assert.equal(read.items[0].resultCount, 1);
  const result = await call('get_queue_result', { batchId: receipt.batch.batchId, itemIndex: 0 });
  assert.equal(result.structuredContent.historyId, 'history-out-1'); assert.equal(result.structuredContent.actualSeed, null); assert.equal(result.structuredContent.imageAttached, true);
  assert.equal(result.content.filter(item => item.type === 'image').length, 1);
});

test('P6 read_queue lists every saved result by history identity and passes the compaction marker; list_queue passes host storage usage, tolerating its absence', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const batchId = randomUUID(), batch = { batchId, requestKey: recipeQueue.mcpHostRequestKey('k'), execution: 'queued', status: 'succeeded', count: 2, recipePlanHash: 'a'.repeat(64), intervalSeconds: 0,
    items: [{ index: 0, status: 'succeeded', jobId: 'j0', results: [{ index: 0, id: 'history-a', width: 1, height: 1, actualSeed: 11 }] }, { index: 1, status: 'succeeded', jobId: 'j1', results: [{ index: 0, id: 'history-b', actualSeed: 0 }, { index: 1, id: 'history-c', actualSeed: -1 }] }] };
  h.faults.read_queue = { reply: () => ({ ...batch, inputCompacted: true, compactedAt: '2026-10-08T00:00:00.000Z' }) };
  const read = ok(await call('read_queue', { batchId }));
  assert.deepEqual(read.results, [{ itemIndex: 0, index: 0, historyId: 'history-a', actualSeed: 11 }, { itemIndex: 1, index: 0, historyId: 'history-b', actualSeed: 0 }, { itemIndex: 1, index: 1, historyId: 'history-c', actualSeed: null }], 'an invalid seed reads back null');
  assert.equal(read.inputCompacted, true); assert.equal(read.compactedAt, '2026-10-08T00:00:00.000Z');
  h.faults.read_queue = { reply: () => batch };
  assert.equal(ok(await call('read_queue', { batchId })).inputCompacted, undefined);
  // P3-7: an unusable history identity degrades that one result to null with a warning (as get_queue_result does); the rest stays readable.
  h.faults.read_queue = { reply: () => ({ ...batch, items: [{ index: 0, status: 'succeeded', results: [{ index: 0, id: '' }, { index: 1, id: 'history-ok' }] }, { index: 1, status: 'succeeded', results: [{ index: 'x', id: { path: '/Users/x' } }] }] }) };
  const degraded = ok(await call('read_queue', { batchId }));
  assert.deepEqual(degraded.results, [{ itemIndex: 0, index: 0, historyId: null, actualSeed: null }, { itemIndex: 0, index: 1, historyId: 'history-ok', actualSeed: null }, { itemIndex: 1, index: null, historyId: null, actualSeed: null }]);
  assert.deepEqual(degraded.warnings.map(({ code, itemIndex, index }) => ({ code, itemIndex, index })), [{ code: 'result_identity_unavailable', itemIndex: 0, index: 0 }, { code: 'result_identity_unavailable', itemIndex: 1, index: null }]);
  assert.ok(!JSON.stringify(degraded).includes('/Users/x'), 'nothing of an invalid identity is echoed');
  assert.equal(degraded.items[0].resultCount, 2, 'the compact batch itself is unchanged');
  h.faults.read_queue = { reply: () => batch };
  assert.equal(ok(await call('read_queue', { batchId })).warnings, undefined, 'no warnings field when every identity is usable');
  // list_queue: storage {frozenQueue, recipeStore} (design-addendum §2.7). The real host reports its recipe store (this
  // in-memory batch backend has no durable frozen queue, so frozenQueue is null; real counts: the W2d tests below).
  const reported = ok(await call('list_queue', {})).storage, files = await readdir(join(h.runtimeDir, 'queue-recipes'));
  let bytes = 0; for (const name of files) bytes += (await lstat(join(h.runtimeDir, 'queue-recipes', name))).size;
  assert.deepEqual(reported, { frozenQueue: null, recipeStore: { records: files.length, recordLimit: 16_384, bytes, byteLimit: 512 * MiB } });
  // An older host without the field, or one that reports null: list_queue simply omits it (injected replies).
  h.faults.list_queue = reply => omit(reply, 'storage');
  assert.equal(ok(await call('list_queue', {})).storage, undefined, 'a host without the field: omitted');
  const storage = { frozenQueue: { batches: 3, batchLimit: 4096, bytes: 1000, byteLimit: 512 * MiB, extra: 'dropped' }, recipeStore: null };
  h.faults.list_queue = reply => ({ ...reply, storage });
  assert.deepEqual(ok(await call('list_queue', {})).storage, { frozenQueue: { batches: 3, batchLimit: 4096, bytes: 1000, byteLimit: 512 * MiB }, recipeStore: null });
  h.faults.list_queue = reply => ({ ...reply, storage: null });
  assert.equal(ok(await call('list_queue', {})).storage, undefined);
  h.faults.list_queue = reply => ({ ...reply, storage: { recipeStore: { records: 1, recordLimit: 16384, bytes: 10, byteLimit: 20 } } });
  assert.deepEqual(ok(await call('list_queue', {})).storage, { frozenQueue: null, recipeStore: { records: 1, recordLimit: 16384, bytes: 10, byteLimit: 20 } });
  h.faults.list_queue = reply => ({ ...reply, storage: { frozenQueue: { batches: -1, batchLimit: 1, bytes: 1, byteLimit: 1 } } });
  assert.equal(errorOf(await call('list_queue', {})).code, 'invalid_response');
});

// ------------------------------------------------------------------------------------------------ P7
test('P7 image recipe revisions: same mode with every field again; another mode or a missing source is refused', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const source = h.addHistory('history-p7', gradient(832, 1216), { width: 832, height: 1216 }), other = h.addHistory('history-p7b', gradient(768, 1152), { width: 768, height: 1152 }), r = recipes(source);
  const first = ok(await call('prepare_recipe', r.i2i()));
  let before = h.calls.length;
  const second = ok(await call('prepare_recipe', recipes(other).i2i({ recipeId: first.recipeId, expectedRevision: 1, width: 768, height: 1152, strength: 0.3 })));
  assert.deepEqual(h.methods().slice(before), ['read_queue_recipe', 'asset_library', 'put_queue_recipe']);
  assert.equal(h.calls[before].args.assetData, 'omit');
  assert.equal(second.recipeId, first.recipeId); assert.equal(second.recipeRevision, 2); assert.equal(second.source.historyId, 'history-p7b'); assert.equal(second.authored.strength, 0.3);
  before = h.calls.length;
  const t2i = errorOf(await call('prepare_recipe', { mode: 't2i', ...GEN, width: 832, height: 1216, recipeId: first.recipeId, expectedRevision: 2 }));
  assert.equal(t2i.code, 'invalid_arguments'); assert.match(t2i.message, /Only a plain t2i recipe .* this one is a i2i recipe/);
  assert.deepEqual(h.methods().slice(before), ['read_queue_recipe'], 'refused after the read, before any source read or put');
  const upscale = ok(await call('prepare_recipe', r.upscale()));
  before = h.calls.length;
  assert.equal(errorOf(await call('prepare_recipe', r.director({ recipeId: upscale.recipeId, expectedRevision: 1 }))).code, 'invalid_arguments');
  assert.deepEqual(h.methods().slice(before), ['read_queue_recipe']);
  before = h.calls.length;
  assert.equal(errorOf(await call('prepare_recipe', omit(r.i2i({ recipeId: first.recipeId, expectedRevision: 2 }), 'source'))).code, 'invalid_arguments', 'a revision rewrites everything, including the source');
  assert.equal(h.calls.length, before);
  assert.equal(errorOf(await call('prepare_recipe', r.i2i({ recipeId: first.recipeId, expectedRevision: 1 }))).code, 'recipe_conflict', 'a stale revision is the host conflict');
});

// ------------------------------------------------------------------------------------------------ P8 and parity
test('P8 the enhance target size port matches client resolveNAIEnhanceOutputSize + adaptiveNAIImageSize on 200 sampled sizes', () => {
  let seed = 0x5eed;
  const random = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
  const sizes = [[832, 1216], [64, 64], [1, 1], [830, 1216], [1216, 1216], [2048, 2048], [49152, 64], [100000, 64], [1600, 1600], [1024, 1536]];
  while (sizes.length < 200) sizes.push([1 + Math.floor(random() * 3200), 1 + Math.floor(random() * 3200)]);
  for (const [width, height] of sizes) for (const scale of [1, 2]) {
    const requested = host.dimensions.resolveNAIEnhanceOutputSize(width, height, scale), size = host.dimensions.adaptiveNAIImageSize(requested.width, requested.height);
    assert.deepEqual(recipeQueue.enhanceTargetSize(width, height, scale), { ...size, exceedsLimit: requested.exceedsLimit }, `${width}×${height} × ${scale}`);
  }
});

test('parity: modes, inpaint models, Director tools and emotions, post-processing limits and asset limits mirror the client', () => {
  const { types } = host;
  assert.deepEqual([...recipeQueue.RECIPE_MODES], ['t2i', 'i2i', 'inpaint', 'enhance', 'upscale', 'director']);
  assert.deepEqual(types.NAI_INPAINT_MODELS.map(item => types.baseModelForInpaint(item.value)), [...recipeQueue.INPAINT_BASE_MODELS]);
  assert.deepEqual(types.NAI_INPAINT_MODELS.map(item => item.value), recipeQueue.INPAINT_BASE_MODELS.map(recipeQueue.inpaintModelFor));
  assert.deepEqual(types.DIRECTOR_TOOLS.map(item => item.value), [...recipeQueue.DIRECTOR_TOOLS]);
  assert.deepEqual(types.EMOTION_OPTIONS.map(item => item.value), [...recipeQueue.DIRECTOR_EMOTIONS]);
  assert.equal(types.MAX_NAI_UPSCALE_INPUT_PIXELS, recipeQueue.RECIPE_LIMITS.postprocessInputPixels);
  assert.equal(types.MAX_NAI_DIRECTOR_INPUT_PIXELS, recipeQueue.RECIPE_LIMITS.postprocessInputPixels);
  assert.equal(types.MAX_NAI_UPSCALE_OUTPUT_DIMENSION, recipeQueue.RECIPE_LIMITS.upscaleMaxOutputSide);
  assert.equal(host.RECIPE_ASSET_LIMITS.referenceBytes, recipeQueue.RECIPE_LIMITS.sourceBytes);
  assert.equal(host.RECIPE_ASSET_LIMITS.provenanceBytes, sources.MASK_PROVENANCE_BYTES);
  assert.deepEqual({ ...recipeQueue.RECIPE_LIMITS, enhanceMagnitude: [...recipeQueue.RECIPE_LIMITS.enhanceMagnitude], directorLevel: [...recipeQueue.RECIPE_LIMITS.directorLevel] },
    { sourceBytes: 20 * MiB, maskBytes: 4 * MiB, frozenEnqueueBytes: 32 * MiB, i2iAspectTolerance: 0.03, inpaintMaxSide: 1600, postprocessInputPixels: 1048576, upscaleMaxOutputSide: 4096, enhanceMagnitude: [1, 10], directorLevel: [0, 5] });
  assert.deepEqual(recipeQueue.postprocessInputSize(1280, 1280), { width: 1024, height: 1024, resized: true });
  assert.deepEqual(recipeQueue.postprocessInputSize(832, 1216), { width: 832, height: 1216, resized: false });
  assert.deepEqual(Object.keys(recipeQueue.MODE_FIELDS).sort(), [...recipeQueue.RECIPE_MODES].sort());
});

// ------------------------------------------------------------------------------------------------ P10
test('P10 preview writes nothing, returns the WebP overlay of the actual request mask for inpaint, and reads back what the save then stores', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const bytes = gradient(832, 1216), source = h.addHistory('history-p10', bytes, { width: 832, height: 1216 }), r = recipes(source);
  assert.deepEqual(await h.tree(), {});
  const result = await call('prepare_recipe', r.inpaint(RECT_MASK, { preview: true }));
  const preview = ok(result);
  assert.deepEqual(h.methods(), ['asset_library', 'preview_queue_recipe']);
  assert.deepEqual(h.calls[1].args.assetData, 'omit'); assert.equal(h.calls[1].args.recipeId, undefined);
  assert.deepEqual(await h.tree(), {}, 'no directory, record, revision or quota was created');
  assert.equal(preview.preview, true); assert.equal(preview.saved, false); assert.equal(preview.recipeId, null); assert.equal(preview.recipeRevision, null); assert.equal(preview.generationSubmitted, false);
  const images = result.content.filter(item => item.type === 'image');
  assert.equal(images.length, 1); assert.equal(images[0].mimeType, 'image/webp');
  const webp = Buffer.from(images[0].data, 'base64');
  assert.deepEqual([webp.toString('ascii', 0, 4), webp.toString('ascii', 8, 12)], ['RIFF', 'WEBP']);
  assert.ok(!JSON.stringify(preview).includes(images[0].data), 'the image bytes are only in the image block');
  const { previewImage } = preview;
  assert.equal(previewImage.imageAttached, true); assert.equal(previewImage.mimeType, 'image/webp');
  assert.ok(Math.max(previewImage.width, previewImage.height) <= 768 && previewImage.byteLength <= MiB && previewImage.byteLength === webp.length && previewImage.sha256 === sha256(webp));
  assert.deepEqual(previewImage.cells, { selected: preview.mask.selectedCells, total: preview.mask.totalCells });
  const meta = await sharp(webp).metadata();
  assert.deepEqual([meta.width, meta.height], [previewImage.width, previewImage.height]);
  // The save with the same arguments stores exactly the previewed input.
  const saved = ok(await call('prepare_recipe', r.inpaint(RECT_MASK)));
  const strip = value => omit(value, 'recipeId', 'recipeRevision', 'saved', 'preview', 'previewImage', 'next');
  assert.deepEqual(strip(preview), strip(saved)); assert.equal(preview.inputHash, saved.inputHash);
  // A changed shape previews a different selection; the store is untouched by any preview.
  const stored = await h.tree();
  const bigger = ok(await call('prepare_recipe', r.inpaint({ units: 'fraction', layers: [{ op: 'add', shape: { type: 'rect', x: 0, y: 0, width: 0.75, height: 0.5 } }] }, { preview: true })));
  assert.ok(bigger.previewImage.cells.selected > preview.previewImage.cells.selected); assert.equal(bigger.previewImage.cells.selected, bigger.mask.selectedCells);
  assert.notEqual(bigger.inputHash, saved.inputHash);
  // Other modes: a write-free dry run without an image. With recipeId the base is read and checked, still nothing is written.
  const up = await call('prepare_recipe', recipes(source).upscale({ preview: true }));
  assert.equal(ok(up).previewImage, null); assert.equal(up.content.filter(item => item.type === 'image').length, 0); assert.equal(ok(up).effective.output.width, 1664);
  const before = h.calls.length;
  const revisionPreview = ok(await call('prepare_recipe', r.inpaint(RECT_MASK, { preview: true, recipeId: saved.recipeId, expectedRevision: 1, strength: 0.5 })));
  assert.deepEqual(h.methods().slice(before), ['read_queue_recipe', 'asset_library', 'preview_queue_recipe']);
  assert.equal(revisionPreview.recipeId, null); assert.equal(revisionPreview.authored.strength, 0.5);
  assert.deepEqual(await h.tree(), stored, 'no preview changed the store');
  // A host preview reply that is not a dry run, or tampers with the input, is refused.
  h.faults.preview_queue_recipe = reply => ({ ...reply, saved: true });
  assert.equal(errorOf(await call('prepare_recipe', r.inpaint(RECT_MASK, { preview: true }))).code, 'invalid_response');
  // A preview reply naming a recipe source or a continuation carries an identity: refused too.
  for (const extra of [{ source: { recipeId: saved.recipeId, recipeRevision: 1 } }, { continuation: { schemaVersion: 1, kind: 'semantic_continuation' } }]) {
    h.faults.preview_queue_recipe = reply => ({ ...reply, ...extra });
    assert.equal(errorOf(await call('prepare_recipe', r.inpaint(RECT_MASK, { preview: true }))).code, 'invalid_response', Object.keys(extra)[0]);
  }
  h.faults.preview_queue_recipe = reply => retamper(reply, snapshot => { snapshot.reviewInput.authored.inpaintStrength = 0.2; });
  const mismatch = errorOf(await call('prepare_recipe', r.inpaint(RECT_MASK, { preview: true })));
  assert.equal(mismatch.code, 'recipe_input_mismatch'); assert.equal(mismatch.details.saved, false);
  h.faults.preview_queue_recipe = reply => ({ ...reply, previewImage: { ...reply.previewImage, sha256: 'f'.repeat(64) } });
  assert.equal(errorOf(await call('prepare_recipe', r.inpaint(RECT_MASK, { preview: true }))).code, 'invalid_response');
  assert.deepEqual(await h.tree(), stored);
});

// ------------------------------------------------------------------------------------------------ P12
test('P12 the mask spec is provenance: the stored readback returns it, the same pixels under another spec keep the inputHash, and an oversized spec keeps only its hash', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const source = h.addHistory('history-p12', gradient(832, 1216), { width: 832, height: 1216 }), r = recipes(source);
  const fraction = ok(await call('prepare_recipe', r.inpaint(RECT_MASK)));
  const px = ok(await call('prepare_recipe', r.inpaint({ units: 'px', layers: [{ op: 'add', shape: { type: 'rect', x: 208, y: 304, width: 416, height: 304 } }] })));
  assert.equal(px.mask.sha256, fraction.mask.sha256, 'the same pixels'); assert.equal(px.inputHash, fraction.inputHash, 'provenance is not part of inputHash');
  assert.notDeepEqual(px.mask.spec, fraction.mask.spec);
  assert.deepEqual(ok(await readRecipe(ref(px))).mask.spec, px.mask.spec);
  assert.deepEqual(ok(await readRecipe(ref(fraction))).mask.spec, fraction.mask.spec);
  // A tampered stored provenance changes only the informational readback; the identity still verifies.
  h.faults.read_queue_recipe = reply => ({ ...reply, assetProvenance: { mask: { ...reply.assetProvenance.mask, spec: { units: 'px', layers: [] } } } });
  const tampered = ok(await readRecipe(ref(px)));
  assert.equal(tampered.inputHash, px.inputHash); assert.deepEqual(tampered.mask.spec, { units: 'px', layers: [] });
  // Over 32 KiB of spec (2048 points with 4-decimal fractions): only {specSha256, specJsonBytes, layers} is stored.
  let seed = 7; const random = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  const coordinate = () => Math.round((-0.4 + random() * 1.8) * 1e4) / 1e4 || 0.1111;
  const polygons = Array.from({ length: 8 }, () => ({ op: 'add', shape: { type: 'polygon', points: Array.from({ length: 256 }, () => [coordinate(), coordinate()]) } }));
  const spec = { units: 'fraction', layers: [{ op: 'add', shape: { type: 'rect', x: 0.1, y: 0.1, width: 0.3, height: 0.3 } }, ...polygons] };
  assert.ok(Buffer.byteLength(JSON.stringify(sources.prepareMaskSpec(spec).spec)) > 32 * 1024);
  const large = ok(await call('prepare_recipe', r.inpaint(spec)));
  const storedProvenance = json(await h.service.read_queue_recipe({ recipeId: large.recipeId, recipeRevision: 1, assetData: 'omit' })).assetProvenance.mask;
  assert.deepEqual(Object.keys(storedProvenance).sort(), ['layers', 'specJsonBytes', 'specSha256']);
  const specJson = JSON.stringify(large.mask.spec);
  assert.deepEqual(storedProvenance, { specSha256: sha256(specJson), specJsonBytes: Buffer.byteLength(specJson), layers: large.mask.layers });
  assert.equal(large.mask.specStored, false); assert.equal(large.mask.specSha256, sha256(specJson)); assert.equal(large.mask.spec.layers.length, 9, 'prepare still returns the full spec');
  const readLarge = ok(await readRecipe(ref(large)));
  assert.equal(readLarge.mask.spec, null); assert.equal(readLarge.mask.specStored, false); assert.equal(readLarge.mask.specSha256, large.mask.specSha256);
  assert.deepEqual(readLarge.mask.layers, large.mask.layers); assert.equal(readLarge.mask.selectedCells, null);
  assert.equal(readLarge.mask.sha256, large.mask.sha256);
});

// ------------------------------------------------------------------------------------------------ host compatibility and sources
test('host_outdated: a client that does not know assetData or preview_queue_recipe is reported as outdated, never retried in another form, and nothing is saved or enqueued', async t => {
  const h = await realHost(t);
  // An older host: the same service, but it refuses the assetData field and has no preview method (bridge-server's answers).
  const old = { async call(method, args, signal) {
    observed.push(method);
    h.calls.push({ method, args: structuredClone(args) });
    if (args && Object.hasOwn(args, 'assetData')) throw new BridgeError('invalid_argument', 'Unknown queue field.');
    if (method === 'preview_queue_recipe') throw new BridgeError('unsupported_method', '当前客户端未支持此操作。请正常重开客户端加载当前版本后再试；这不是填写参数错误，不要反复简化参数或自动重试。');
    h.calls.pop();
    return h.bridge.call(method, args, signal);
  } };
  const { call, readRecipe } = await connect(t, old);
  const outdated = (error, label) => {
    assert.equal(error.code, 'host_outdated', `${label}: ${error.message}`);
    assert.equal(error.message, recipeQueue.HOST_OUTDATED_MESSAGE);
    assert.match(error.message, /Fully rebuild and restart the client/); assert.match(error.message, /Nothing was saved or enqueued, and no requestKey was used/);
    assert.equal(error.details.saved, false); assert.equal(error.details.enqueueSent, false);
  };
  // t2i keeps its original put (no assetData), so saving still works on the older host.
  const t2i = ok(await call('prepare_recipe', { mode: 't2i', ...GEN, width: 832, height: 1216 }));
  assert.equal(h.calls.at(-1).args.assetData, undefined);
  let before = h.count('read_queue_recipe');
  outdated(errorOf(await readRecipe(ref(t2i))), 'recipe read');
  assert.equal(h.count('read_queue_recipe'), before + 1, 'one read, no retry without assetData');
  const enqueue = errorOf(await call('enqueue_recipes', { requestKey: 'old-host', items: [{ ...ref(t2i), seeds: [1] }] }));
  outdated(enqueue, 'enqueue'); assert.equal(enqueue.details.status, 'not_sent'); assert.equal(enqueue.details.requestKey, 'old-host');
  assert.equal(h.count('enqueue_queue_recipes'), 0); assert.equal(ok(await call('lookup_enqueue', { requestKey: 'old-host' })).status, 'not_found', 'the key is unused');
  const source = h.addHistory('history-old', gradient(832, 1216), { width: 832, height: 1216 });
  before = h.calls.length;
  outdated(errorOf(await call('prepare_recipe', recipes(source).i2i())), 'image put');
  assert.deepEqual(h.methods().slice(before), ['asset_library', 'put_queue_recipe']);
  outdated(errorOf(await call('prepare_recipe', recipes(source).upscale({ preview: true }))), 'preview');
  outdated(errorOf(await call('prepare_recipe', { mode: 't2i', ...GEN, width: 832, height: 1216, recipeId: t2i.recipeId, expectedRevision: 1 })), 'revision read');
  assert.deepEqual(Object.keys(await h.tree()).filter(name => name.endsWith('.json') && !name.includes('request-')).length, 1, 'only the t2i recipe exists');
});

test('a history source deleted or replaced after prepare: the stored readback and enqueue stop before any receipt, and the requestKey stays unused', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const bytes = gradient(832, 1216), source = h.addHistory('history-gone', bytes, { width: 832, height: 1216 });
  const prepared = ok(await call('prepare_recipe', recipes(source).i2i()));
  const key = `history-gone:1:history-gone-original`;
  h.history.delete(key);
  assert.equal(errorOf(await readRecipe(ref(prepared))).code, 'recipe_source_unavailable');
  const refused = errorOf(await call('enqueue_recipes', { requestKey: 'gone', items: [{ ...ref(prepared), seeds: [1] }] }));
  assert.equal(refused.code, 'recipe_source_unavailable'); assert.equal(refused.details.enqueueSent, false); assert.equal(refused.details.status, 'not_sent');
  assert.equal(h.count('enqueue_queue_recipes'), 0);
  assert.equal(ok(await call('lookup_enqueue', { requestKey: 'gone' })).status, 'not_found');
  h.addHistory('history-gone', gradient(832, 1216).reverse(), { width: 832, height: 1216 });
  assert.equal(errorOf(await call('enqueue_recipes', { requestKey: 'gone', items: [{ ...ref(prepared), seeds: [1] }] })).code, 'recipe_source_changed');
  h.history.set(key, { ...h.history.get(key), bytes });
  // A busy history reader is temporary: nothing was saved or queued; the same call works later.
  h.readerBusy.on = true;
  const busy = errorOf(await call('enqueue_recipes', { requestKey: 'gone', items: [{ ...ref(prepared), seeds: [1] }] }));
  assert.equal(busy.code, 'recipe_source_busy'); assert.match(busy.message, /retry the same call later/); assert.equal(busy.details.enqueueSent, false);
  // #14: the host's own facts about the source travel along under hostDetails.
  assert.deepEqual(busy.details.hostDetails, { recipeId: prepared.recipeId, recipeRevision: prepared.recipeRevision, ref: { kind: 'history', id: source.historyId, revision: source.historyRevision, assetId: source.assetId }, sha256: prepared.source.sha256, byteLength: prepared.source.byteLength, readerCode: 'image_busy' });
  const busyPut = errorOf(await call('prepare_recipe', recipes(source).i2i()));
  assert.equal(busyPut.code, 'recipe_source_busy'); assert.equal(busyPut.details.saved, false); assert.equal(busyPut.details.putOutcome, 'rejected');
  assert.equal(busyPut.details.hostDetails.readerCode, 'image_busy'); assert.equal(busyPut.details.hostDetails.sha256, prepared.source.sha256);
  h.readerBusy.on = false;
  assert.equal(ok(await call('enqueue_recipes', { requestKey: 'gone', items: [{ ...ref(prepared), seeds: [1] }] })).status, 'enqueued', 'the same key works once the source is back');
});

test('P3-9 revising a recipe whose history source was deleted or replaced fails at its read and says to prepare a new recipe for another source', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const bytes = gradient(832, 1216), source = h.addHistory('history-revise', bytes, { width: 832, height: 1216 }), other = h.addHistory('history-other', gradient(768, 1152), { width: 768, height: 1152 });
  const prepared = ok(await call('prepare_recipe', recipes(source).i2i()));
  const key = 'history-revise:1:history-revise-original';
  for (const [label, change, code] of [['deleted', () => h.history.delete(key), 'recipe_source_unavailable'], ['replaced', () => h.addHistory('history-revise', gradient(832, 1216).reverse(), { width: 832, height: 1216 }), 'recipe_source_changed']]) {
    change();
    const before = h.calls.length;
    const error = errorOf(await call('prepare_recipe', recipes(other).i2i({ recipeId: prepared.recipeId, expectedRevision: 1, width: 768, height: 1152 })));
    assert.equal(error.code, code, label);
    assert.match(error.message, /To use another source image, prepare a new recipe \(without recipeId\)/, `${label}: ${error.message}`);
    assert.deepEqual(h.methods().slice(before), ['read_queue_recipe'], `${label}: stopped at the read, nothing saved`);
    // The host's facts about the stored source travel under hostDetails, like every other rewritten host error.
    assert.equal(error.details.saved, false); assert.equal(error.details.putAttempted, false);
    assert.deepEqual(error.details.hostDetails, { recipeId: prepared.recipeId, recipeRevision: 1, ref: { kind: 'history', id: source.historyId, revision: source.historyRevision, assetId: source.assetId }, sha256: prepared.source.sha256, byteLength: prepared.source.byteLength, ...(label === 'deleted' ? { readerCode: 'library_not_found' } : {}) });
    for (const key of ['recipeId', 'recipeRevision', 'ref', 'sha256', 'byteLength', 'readerCode']) assert.equal(Object.hasOwn(error.details, key), false, `${label}: ${key} is not spread on top`);
  }
  // As advised: a new recipe from the other source works.
  assert.equal(ok(await call('prepare_recipe', recipes(other).i2i({ width: 768, height: 1152 }))).recipeRevision, 1);
});

// ------------------------------------------------------------------------------------------------ W2d / CE-7 (real host)

const receiptFile = (h, requestKey) => join(h.runtimeDir, 'queue-recipes', `request-${recipeQueue.recipeHash(recipeQueue.mcpHostRequestKey(requestKey))}.json`);
const exists = file => lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
/** Bytes under dir; an entry that vanishes while it is listed (a finished storage transaction) counts as 0. */
async function directoryBytes(dir) {
  let total = 0;
  for (const name of await readdir(dir).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
    const file = join(dir, name);
    const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info) total += info.isDirectory() ? await directoryBytes(file) : info.size;
  }
  return total;
}
/** Every batch ended and the frozen queue quiet: on-disk bytes and the reported capacity unchanged over three samples 40 ms apart. */
async function quietFrozenQueue(h, call, batchIds, dir) {
  await waitFor(async () => { for (const batchId of batchIds) if (ok(await call('read_queue', { batchId })).status !== 'succeeded') return false; return true; }, 'the batches to end');
  const samples = [];
  return waitFor(async () => {
    samples.push({ disk: await directoryBytes(dir), capacity: h.batch.capacity()?.bytes });
    await new Promise(resolve => setTimeout(resolve, 40));
    const last = samples.slice(-3);
    return last.length === 3 && last.every(sample => sample.disk === last[0].disk && sample.capacity === last[0].capacity) ? last[0] : null;
  }, 'the frozen queue to be quiet');
}

test('W2d the host refuses upscale/director seeds and repeats before writing a receipt (key unused); this server sends such a recipe once, without seeds', async t => {
  const h = await realHost(t, { realBatch: true, frozenLimits: {} });
  const { call, readRecipe } = await connect(t, h.bridge);
  const source = h.addHistory('history-w2d-post', gradient(832, 1216), { width: 832, height: 1216 }), r = recipes(source);
  const upscale = ok(await call('prepare_recipe', r.upscale())), director = ok(await call('prepare_recipe', r.director()));
  // Straight to the host (as another caller could), bypassing this server's own check.
  for (const [label, items] of [['seed', [{ ...ref(upscale), seed: 5 }]], ['repeat', [ref(upscale), ref(upscale)]], ['director-seed', [{ ...ref(director), seed: 1 }]]]) {
    const requestKey = `host-${label}`, hostKey = recipeQueue.mcpHostRequestKey(requestKey);
    await assert.rejects(h.bridge.call('enqueue_queue_recipes', { requestKey: hostKey, items }), error => error.code === 'invalid_argument', label);
    assert.deepEqual(json(await h.service.lookup_queue_request({ requestKey: hostKey })), { batch: null, inFlight: false }, `${label}: no receipt was written`);
    assert.equal(await exists(receiptFile(h, requestKey)), false, label);
    assert.equal(ok(await call('lookup_enqueue', { requestKey })).status, 'not_found', `${label}: the key is unused`);
  }
  // Through this server (0.1.4): the seed is dropped and the recipe sent once, with a warning; the host accepts that.
  const accepted = ok(await call('enqueue_recipes', { requestKey: 'host-seed', items: [{ ...ref(upscale), seeds: [5] }] }));
  assert.equal(accepted.status, 'enqueued'); assert.deepEqual(accepted.items.map(item => item.seed), [null]);
  assert.deepEqual(accepted.warnings.map(warning => warning.code), ['postprocess_single_image']);
  const once = ok(await call('enqueue_recipes', { requestKey: 'host-repeat', items: [ref(director), { ...ref(director), count: 2 }] }));
  assert.equal(once.batch.count, 1); assert.equal(once.count, 1); assert.deepEqual(once.warnings.map(warning => [warning.code, warning.from, warning.to]), [['postprocess_single_image', 3, 1]]);
});

test('W2d a full frozen queue is refused (queue_full) before the receipt: the MCP reports the key unused, without an unknown hold, and the same key enqueues once there is room', async t => {
  const h = await realHost(t, { realBatch: true, frozenLimits: { batches: 1 } });
  const { call, readRecipe } = await connect(t, h.bridge);
  const source = h.addHistory('history-w2d-full', gradient(832, 1216), { width: 832, height: 1216 });
  const i2i = ok(await call('prepare_recipe', recipes(source).i2i()));
  assert.equal(ok(await call('enqueue_recipes', { requestKey: 'fill', items: [{ ...ref(i2i), seeds: [1] }] })).status, 'enqueued');
  assert.equal(h.batch.capacity().batches, 1);
  const plan = { requestKey: 'second', items: [{ ...ref(i2i), seeds: [2] }] };
  const full = errorOf(await call('enqueue_recipes', plan));
  assert.equal(full.code, 'queue_full', full.message);
  assert.equal(full.details.status, 'rejected'); assert.equal(full.details.keyStatus, 'not_found'); assert.equal(full.details.enqueueSent, true);
  assert.match(full.message, /Nothing was queued and this requestKey was not used/); assert.match(full.message, /before recording the requestKey; nothing was queued/);
  // #14: the host's capacity facts travel along under hostDetails.
  assert.deepEqual(Object.keys(full.details.hostDetails).sort(), ['estimatedBytes', 'frozenQueue']);
  assert.equal(full.details.hostDetails.frozenQueue.batches, 1); assert.equal(full.details.hostDetails.frozenQueue.batchLimit, 1); assert.ok(full.details.hostDetails.estimatedBytes > 0);
  assert.equal(await exists(receiptFile(h, 'second')), false, 'no receipt');
  assert.equal(ok(await call('lookup_enqueue', { requestKey: 'second' })).status, 'not_found');
  assert.equal(h.batch.list({ workspaceId: 'recipe-queue' }).batches.length, 1);
  // The host restarts with room for more batches (standing in for cleanup): the very same key and plan go through.
  await h.rebuild({ limits: { batches: 4 } });
  const accepted = ok(await call('enqueue_recipes', plan));
  assert.equal(accepted.status, 'enqueued'); assert.equal(accepted.enqueueSent, true);
  assert.equal(h.batch.list({ workspaceId: 'recipe-queue' }).batches.length, 2);
});

test('W2d list_queue.storage carries the real host counts of the frozen queue and the recipe store', async t => {
  const h = await realHost(t, { realBatch: true, frozenLimits: {} });
  const { call, readRecipe } = await connect(t, h.bridge);
  const source = h.addHistory('history-w2d-count', gradient(832, 1216), { width: 832, height: 1216 }), r = recipes(source);
  const i2i = ok(await call('prepare_recipe', r.i2i())), upscale = ok(await call('prepare_recipe', r.upscale()));
  const first = ok(await call('enqueue_recipes', { requestKey: 'count-1', items: [{ ...ref(i2i), seeds: [1, 2] }] }));
  const second = ok(await call('enqueue_recipes', { requestKey: 'count-2', items: [ref(upscale)] }));
  const frozenDirs = (await readdir(h.runtimeDir)).filter(name => name !== 'queue-recipes');
  assert.equal(frozenDirs.length, 1, `one frozen-queue directory: ${frozenDirs}`);
  // P3-1: compare only once both batches ended and nothing is being saved (background saves create and remove .txn files).
  const quiet = await quietFrozenQueue(h, call, [first.batch.batchId, second.batch.batchId], join(h.runtimeDir, frozenDirs[0]));
  const { storage } = ok(await call('list_queue', {}));
  const capacity = h.batch.capacity(), store = join(h.runtimeDir, 'queue-recipes'), files = await readdir(store);
  let recipeBytes = 0; for (const name of files) recipeBytes += (await lstat(join(store, name))).size;
  assert.deepEqual(storage.recipeStore, { records: files.length, recordLimit: host.RECIPE_STORE_LIMITS.records, bytes: recipeBytes, byteLimit: host.RECIPE_STORE_LIMITS.bytes });
  assert.equal(files.filter(name => name.startsWith('request-')).length, 2); assert.equal(files.length, 4, 'two recipes and two receipts');
  assert.deepEqual(storage.frozenQueue, { batches: 2, batchLimit: 4096, bytes: capacity.bytes, byteLimit: 512 * MiB });
  assert.equal(capacity.bytes, quiet.capacity);
  // The host reports its latest scan, which runs under its own storage lock and so also counts the lock (and any
  // transaction) file of that moment: at rest it may exceed the files on disk by those few hundred bytes.
  t.diagnostic(`frozen queue: reported ${capacity.bytes} bytes, ${quiet.disk} on disk at rest`);
  assert.ok(capacity.bytes > 0 && Math.abs(capacity.bytes - quiet.disk) <= 4096, `frozen bytes ${capacity.bytes} vs ${quiet.disk} on disk`);
  assert.deepEqual(recipeQueue.RECIPE_STORE_LIMITS, { records: host.RECIPE_STORE_LIMITS.records, bytes: host.RECIPE_STORE_LIMITS.bytes }, 'parity with the host recipe store limits');
});

test('W2d inputCompacted end to end: after an ended MCP batch is compacted (grace passed by injected time), read_queue reports it and keeps the results by history identity', async t => {
  const h = await realHost(t, { realBatch: true, frozenLimits: {} });
  const { call, readRecipe } = await connect(t, h.bridge);
  const upscale = ok(await call('prepare_recipe', recipes(h.addHistory('history-w2d-compact', gradient(832, 1216), { width: 832, height: 1216 })).upscale()));
  const receipt = ok(await call('enqueue_recipes', { requestKey: 'compact-batch', items: [ref(upscale)] })), batchId = receipt.batch.batchId;
  const ended = await waitFor(async () => { const value = ok(await call('read_queue', { batchId })); return value.status === 'succeeded' && value.results.length ? value : null; }, 'the batch to end');
  assert.equal(ended.inputCompacted, undefined);
  const bytesBefore = ok(await call('list_queue', {})).storage.frozenQueue.bytes;
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60 * 1000; // past FROZEN_COMPACTION_POLICY.graceMs (10 minutes) for the batch service and its storage
  let reclaimed;
  try { reclaimed = await h.batch.reclaim(8); } finally { Date.now = realNow; }
  assert.equal(reclaimed.compacted, 1);
  const read = ok(await call('read_queue', { batchId }));
  assert.equal(read.inputCompacted, true); assert.match(read.compactedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(read.results, ended.results); assert.equal(read.status, 'succeeded');
  assert.ok(ok(await call('list_queue', {})).storage.frozenQueue.bytes < bytesBefore, 'the frozen input was released');
  const result = await call('get_queue_result', { batchId, itemIndex: 0 });
  assert.equal(result.structuredContent.historyId, ended.results[0].historyId);
  assert.equal(ok(await call('lookup_enqueue', { requestKey: 'compact-batch' })).batch.batchId, batchId);
  assert.equal(ok(await call('enqueue_recipes', { requestKey: 'compact-batch', items: [ref(upscale)] })).status, 'already_enqueued');
});

test('CE-7 an i2i recipe with a random extra-noise seed enqueues through the real frozen queue; the same requestKey returns the same batch and the host holds one', async t => {
  const h = await realHost(t, { realBatch: true, frozenLimits: {} });
  const { call, readRecipe } = await connect(t, h.bridge);
  const source = h.addHistory('history-ce7', gradient(832, 1216), { width: 832, height: 1216 });
  const i2i = ok(await call('prepare_recipe', recipes(source).i2i()));
  assert.equal(i2i.effective.i2i.extraNoiseSeedPolicy, 'random_on_submit');
  const plan = { requestKey: 'noise-1', items: [{ ...ref(i2i), seeds: [1, 2] }] }, hostKey = recipeQueue.mcpHostRequestKey('noise-1');
  const first = ok(await call('enqueue_recipes', plan));
  assert.equal(first.status, 'enqueued');
  const again = ok(await call('enqueue_recipes', plan));
  assert.equal(again.status, 'already_enqueued'); assert.equal(again.batch.batchId, first.batch.batchId); assert.equal(again.enqueueSent, false);
  const restarted = await connect(t, h.bridge);
  assert.equal(ok(await restarted.call('enqueue_recipes', plan)).batch.batchId, first.batch.batchId, 'also from a restarted server');
  assert.equal(h.batch.list({ workspaceId: 'recipe-queue' }).batches.filter(batch => batch.requestKey === hostKey).length, 1, 'one host batch');
  // The host derived the noise seed from the batch identity (one snapshot for one recipe: index 0).
  await waitFor(() => h.submitted.length >= 2, 'both images');
  const seed = host.queuedExtraNoiseSeed('recipe-queue', hostKey, 0);
  assert.ok(Number.isSafeInteger(seed) && seed > 0);
  assert.deepEqual(h.submitted.map(args => args.snapshot.i2i.extraNoiseSeed), [seed, seed]);
  assert.equal(ok(await call('list_queue', {})).storage.frozenQueue.batches, 1, 'the store stayed usable');
});

test('queue_input_invalid (a new batch input failing the storage self-check) is an explicit refusal, never an unknown outcome; the store stays usable', async t => {
  // (a) The real chain, which is what the host actually reports: storage refuses the new input (BatchInputError,
  // storage code queue_input_invalid) → the batch service answers invalid_arguments → the queue service records the
  // rejection AFTER its receipt, so the requestKey is spent (keyStatus rejected) and the same key is refused again.
  let failOnce = true;
  const h = await realHost(t, { realBatch: true, frozenLimits: {}, wrapStorage: storage => ({ ...storage, async create(...args) { if (failOnce) { failOnce = false; throw new host.BatchInputError(); } return storage.create(...args); } }) });
  const { call, readRecipe } = await connect(t, h.bridge);
  const i2i = ok(await call('prepare_recipe', recipes(h.addHistory('history-self-check', gradient(832, 1216), { width: 832, height: 1216 })).i2i()));
  const rejected = errorOf(await call('enqueue_recipes', { requestKey: 'bad-input', items: [{ ...ref(i2i), seeds: [1] }] }));
  assert.equal(rejected.code, 'invalid_arguments'); assert.equal(rejected.details.status, 'rejected'); assert.equal(rejected.details.keyStatus, 'rejected'); assert.match(rejected.message, /failed its self-check/);
  assert.equal(ok(await call('lookup_enqueue', { requestKey: 'bad-input' })).status, 'rejected', 'the key is spent');
  assert.equal(errorOf(await call('enqueue_recipes', { requestKey: 'bad-input', items: [{ ...ref(i2i), seeds: [1] }] })).code, 'queue_request_rejected');
  assert.equal(ok(await call('enqueue_recipes', { requestKey: 'after-bad-input', items: [{ ...ref(i2i), seeds: [2] }] })).status, 'enqueued', 'the store was not marked broken');
  assert.equal(ok(await call('list_queue', {})).storage.frozenQueue.batches, 1);
  // (b) Defensive mapping only: queue_input_invalid is NOT a normal host output (see above). Should a host ever pass the raw
  // storage code through, it is still an explicit refusal (never unknown, no hold), and the key status comes from the
  // confirming lookup — here the same rejected receipt the real chain records.
  const plain = await realHost(t);
  const passthrough = { async call(method, args, signal) {
    try { return await plain.bridge.call(method, args, signal); }
    catch (error) { if (method === 'enqueue_queue_recipes' && error.code === 'invalid_arguments') throw new BridgeError('queue_input_invalid', error.message, error.details); throw error; }
  } };
  const direct = await connect(t, passthrough);
  const t2i = ok(await direct.call('prepare_recipe', { mode: 't2i', ...GEN, width: 832, height: 1216 }));
  plain.batch.failNext = Object.assign(new Error('冻结输入自检未通过（快照与校验值或结构不一致）；本次未入队，其它批次照常运行。'), { code: 'invalid_arguments' });
  const refused = errorOf(await direct.call('enqueue_recipes', { requestKey: 'self-check', items: [{ ...ref(t2i), seeds: [1] }] }));
  assert.equal(refused.code, 'queue_input_invalid'); assert.equal(refused.details.status, 'rejected'); assert.equal(refused.details.keyStatus, 'rejected'); assert.equal(refused.details.hostCode, 'queue_input_invalid');
  assert.doesNotMatch(refused.message, /unknown/i);
  assert.equal(errorOf(await direct.call('enqueue_recipes', { requestKey: 'self-check', items: [{ ...ref(t2i), seeds: [1] }] })).code, 'queue_request_rejected', 'answered from the receipt, no unknown hold');
  assert.equal(ok(await direct.call('enqueue_recipes', { requestKey: 'self-check-2', items: [{ ...ref(t2i), seeds: [1] }] })).status, 'enqueued');
});

test('queue_storage_error: a failed frozen-queue store refuses before the receipt (definite, key unused); a store failing after the receipt stays unknown and holds the key', async t => {
  // The batch store fails inside its first create (after the host wrote this request's receipt) and stays failed.
  let failCreate = true;
  const h = await realHost(t, { realBatch: true, frozenLimits: {}, wrapStorage: storage => ({ ...storage, async create(...args) { if (failCreate) { failCreate = false; throw new Error('the disk went away'); } return storage.create(...args); } }) });
  const { call, readRecipe } = await connect(t, h.bridge);
  const i2i = ok(await call('prepare_recipe', recipes(h.addHistory('history-storage-error', gradient(832, 1216), { width: 832, height: 1216 })).i2i()));
  // 1. After the receipt: the host looks for a batch, finds none and reports queue_acceptance_unknown; this server holds the key.
  //    (This pins the host's conversion: if it ever reported queue_storage_error here instead, the key would look unused.)
  const afterReceipt = errorOf(await call('enqueue_recipes', { requestKey: 'after-receipt', items: [{ ...ref(i2i), seeds: [1] }] }));
  assert.equal(afterReceipt.code, 'queue_acceptance_unknown'); assert.equal(afterReceipt.details.hostCode, 'queue_acceptance_unknown');
  assert.equal(afterReceipt.details.status, 'unknown'); assert.equal(afterReceipt.details.enqueueSent, true);
  // The settle stops at its first lookup: the host cannot read its frozen queue, so waiting would change nothing.
  assert.ok(afterReceipt.message.startsWith(recipeQueue.FROZEN_UNREADABLE_MESSAGE), afterReceipt.message);
  assert.deepEqual([afterReceipt.details.settled.lookups, afterReceipt.details.settled.resends, afterReceipt.details.newKeyAdvised], [1, 0, false]);
  assert.equal(await exists(receiptFile(h, 'after-receipt')), true, 'the receipt exists');
  assert.equal(JSON.parse(await readFile(receiptFile(h, 'after-receipt'), 'utf8')).status, 'unknown', 'the host keeps the key as unknown');
  // Repeating it sends nothing: the host's lookup of a key with a receipt answers queue_acceptance_unknown while the
  // store is unreadable, which this server reports as such (never a new-key advice), and the key stays held.
  const sentBefore = h.count('enqueue_queue_recipes');
  const held = errorOf(await call('enqueue_recipes', { requestKey: 'after-receipt', items: [{ ...ref(i2i), seeds: [1] }] }));
  assert.equal(held.code, 'queue_acceptance_unknown'); assert.ok(held.message.startsWith(recipeQueue.FROZEN_UNREADABLE_MESSAGE), held.message);
  assert.equal(held.details.enqueueSent, false); assert.equal(held.details.status, 'unknown'); assert.equal(held.details.newKeyAdvised, false);
  assert.equal(h.count('enqueue_queue_recipes'), sentBefore, 'held: nothing sent again');
  // 2. Before the receipt: the failed store now refuses at admission (queueAdmission), before any receipt is written.
  const before = h.count('enqueue_queue_recipes');
  const refused = errorOf(await call('enqueue_recipes', { requestKey: 'before-receipt', items: [{ ...ref(i2i), seeds: [2] }] }));
  assert.equal(refused.code, 'queue_storage_error', refused.message);
  assert.equal(refused.details.status, 'rejected'); assert.equal(refused.details.keyStatus, 'not_found'); assert.equal(refused.details.enqueueSent, true);
  assert.match(refused.message, /frozen queue storage has failed/); assert.match(refused.message, /stopped accepting new batches/);
  assert.match(refused.message, /Check the NovelAI client first/); assert.match(refused.message, /whether to restart it is the user's decision/);
  assert.match(refused.message, /Nothing was queued and this requestKey was not used/);
  assert.equal(await exists(receiptFile(h, 'before-receipt')), false, 'no receipt');
  assert.equal(ok(await call('lookup_enqueue', { requestKey: 'before-receipt' })).status, 'not_found');
  // Not held: the same call is sent again (and refused again while the store stays failed).
  assert.equal(errorOf(await call('enqueue_recipes', { requestKey: 'before-receipt', items: [{ ...ref(i2i), seeds: [2] }] })).code, 'queue_storage_error');
  assert.equal(h.count('enqueue_queue_recipes'), before + 2);
});

test('frozen queue unreadable at load: a key without a receipt is refused before any receipt (key unused); a key with a receipt is never resent and never advised a new key', async t => {
  const unreadable = storage => ({ ...storage, async load() { throw new Error('the frozen queue cannot be read'); } });
  const h = await realHost(t, { realBatch: true, frozenLimits: {} });
  const clock = { t: 1_000_000 };
  const { call, readRecipe } = await connect(t, h.bridge, { create: options => merged.createNovelAiMcpServer({ ...options, recipeQueue: { monotonicNow: () => clock.t } }) });
  const t2i = ok(await call('prepare_recipe', { mode: 't2i', ...GEN, width: 832, height: 1216 }));
  // A healthy store first: this key gets its receipt and its batch on disk.
  const kept = { requestKey: 'has-receipt', items: [{ ...ref(t2i), seeds: [1] }] };
  const accepted = ok(await call('enqueue_recipes', kept));
  assert.equal(accepted.status, 'enqueued');
  await waitFor(() => h.submitted.length >= 1, 'the generation');
  const receiptBytes = await readFile(receiptFile(h, 'has-receipt'));
  // The client restarts and its frozen queue cannot be loaded.
  await h.rebuild({ wrap: unreadable, mayFail: true });

  // (A) No receipt for the key: the gate lookup finds none, the host refuses the dispatch before writing a receipt.
  const refused = errorOf(await call('enqueue_recipes', { requestKey: 'load-failed', items: [{ ...ref(t2i), seeds: [2] }] }));
  assert.equal(refused.code, 'queue_storage_error');
  assert.ok(refused.message.startsWith(recipeQueue.FROZEN_STORE_FAILED_MESSAGE), refused.message);
  assert.match(refused.message, /Nothing was queued and this requestKey was not used/);
  assert.equal(refused.details.keyStatus, 'not_found'); assert.equal(refused.details.status, 'rejected');
  assert.equal(await exists(receiptFile(h, 'load-failed')), false, 'no receipt');
  const notFound = ok(await call('lookup_enqueue', { requestKey: 'load-failed' }));
  assert.equal(notFound.status, 'not_found'); assert.notEqual(notFound.settlement?.newKeyAdvised, true);

  // (B) The key has a receipt: neither the enqueue gate nor lookup_enqueue sends anything or advises a new key, however long it lasts.
  const sent = h.count('enqueue_queue_recipes');
  for (let round = 0; round < 3; round++) {
    const gate = errorOf(await call('enqueue_recipes', kept));
    assert.equal(gate.code, 'queue_acceptance_unknown', gate.message);
    assert.ok(gate.message.startsWith(recipeQueue.FROZEN_UNREADABLE_MESSAGE), gate.message);
    assert.doesNotMatch(gate.message, /Retry the same call once the host is reachable/);
    assert.equal(gate.details.enqueueSent, false); assert.equal(gate.details.status, 'unknown'); assert.equal(gate.details.newKeyAdvised, false);
    const looked = errorOf(await call('lookup_enqueue', { requestKey: 'has-receipt' }));
    assert.equal(looked.code, 'queue_acceptance_unknown');
    assert.ok(looked.message.startsWith(recipeQueue.FROZEN_UNREADABLE_MESSAGE), looked.message);
    assert.equal(looked.details.status, 'lookup_failed'); assert.equal(looked.details.newKeyAdvised, false); assert.equal(looked.details.requestKey, 'has-receipt');
    clock.t += 200_000; // well past the settle window: still no advice to switch keys
  }
  assert.equal(h.count('enqueue_queue_recipes'), sent, 'nothing dispatched for the key with a receipt');
  assert.ok((await readFile(receiptFile(h, 'has-receipt'))).equals(receiptBytes), 'the receipt is untouched');
  // Once the client loads its queue again, the same key finds the same batch.
  await h.rebuild({ wrap: storage => storage, mayFail: false });
  assert.equal(ok(await call('lookup_enqueue', { requestKey: 'has-receipt' })).batch.batchId, accepted.batch.batchId);
  assert.equal(ok(await call('enqueue_recipes', kept)).status, 'already_enqueued');
});

test('refused(): details.status is rejected only when the confirming lookup finds not_found or a recorded rejection; otherwise it is unknown, and the same call settles it', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const t2i = ok(await call('prepare_recipe', { mode: 't2i', ...GEN, width: 832, height: 1216 }));
  const storeFailed = () => { throw new BridgeError('queue_storage_error', '冻结队列无法安全读取或写入；保留文件，已停止新的任务提交。'); };
  const cases = [
    ['storage error, lookup fails', 'queue_storage_error', storeFailed, { before: () => { throw new BridgeError('timeout', 'The client request was interrupted or timed out.'); } }, 'lookup_failed'],
    ['storage error, receipt unknown', 'queue_storage_error', storeFailed, () => ({ batch: null, status: 'unknown' }), 'unknown'],
    ['queue_full, lookup fails', 'queue_full', () => { throw new BridgeError('queue_full', 'The queue is full.'); }, { before: () => { throw new BridgeError('timeout', 'The client request was interrupted or timed out.'); } }, 'lookup_failed'],
  ];
  for (const [label, code, enqueueFault, lookupFault, keyStatus] of cases) {
    const requestKey = `status-${label.replace(/\W+/g, '-')}`, plan = { requestKey, items: [{ ...ref(t2i), seeds: [1] }] };
    // The idempotency lookup before the dispatch answers normally; the dispatch is refused; only then the confirming lookup misbehaves.
    h.faults.enqueue_queue_recipes = { before: () => { h.faults.lookup_queue_request = lookupFault; enqueueFault(); } };
    const refused = errorOf(await call('enqueue_recipes', plan));
    assert.equal(refused.code, code, label); assert.equal(refused.details.keyStatus, keyStatus, label);
    assert.equal(refused.details.status, 'unknown', `${label}: not a confirmed rejection`); assert.equal(refused.details.enqueueSent, true);
    assert.match(refused.message, /call enqueue_recipes (again )?with the same requestKey and plan/i, label);
    // No hold (0.1.4): the lookup says nothing was recorded, and the same call again is safe and enqueues it.
    assert.equal(ok(await call('lookup_enqueue', { requestKey })).status, 'not_found', `${label}: the host never recorded it`);
    assert.equal(ok(await call('enqueue_recipes', plan)).status, 'enqueued', `${label}: the same key works`);
  }
  // A confirmed answer keeps status rejected: not_found (key unused) and a recorded rejection.
  h.faults.enqueue_queue_recipes = { before: storeFailed };
  const notFound = errorOf(await call('enqueue_recipes', { requestKey: 'status-not-found', items: [{ ...ref(t2i), seeds: [2] }] }));
  assert.equal(notFound.details.status, 'rejected'); assert.equal(notFound.details.keyStatus, 'not_found');
  h.batch.failNext = Object.assign(new Error('stopped'), { code: 'queue_full' });
  const recorded = errorOf(await call('enqueue_recipes', { requestKey: 'status-recorded', items: [{ ...ref(t2i), seeds: [3] }] }));
  assert.equal(recorded.details.status, 'rejected'); assert.equal(recorded.details.keyStatus, 'rejected');
});

test('wording: a queue_storage_error refusal under a recorded rejection, and a recipe_changed refusal before the receipt', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const t2i = ok(await call('prepare_recipe', { mode: 't2i', ...GEN, width: 832, height: 1216 }));
  // The key already holds a recorded rejection when the store error is reported.
  h.batch.failNext = Object.assign(new Error('stopped'), { code: 'queue_full' });
  errorOf(await call('enqueue_recipes', { requestKey: 'recorded', items: [{ ...ref(t2i), seeds: [1] }] }));
  const storageOnRejected = errorOf(await recipeQueueRefusal(h, 'recorded', t2i, 'queue_storage_error'));
  assert.match(storageOnRejected.message, /Nothing was queued; this requestKey already has a recorded rejection, so a new requestKey is needed once the client is healthy again\./);
  assert.doesNotMatch(storageOnRejected.message, /the host recorded the rejection/);
  // recipe_changed before any receipt: the corrected recipe is a new plan.
  h.faults.enqueue_queue_recipes = { before: () => { throw new BridgeError('recipe_changed', 'The builder no longer produces the stored reviewed input.'); } };
  const changed = errorOf(await call('enqueue_recipes', { requestKey: 'changed', items: [{ ...ref(t2i), seeds: [1] }] }));
  assert.equal(changed.code, 'recipe_changed'); assert.equal(changed.details.keyStatus, 'not_found');
  assert.match(changed.message, /Once corrected, the recipe's inputHash changes and the enqueue becomes a new plan, which may use a new requestKey\./);
});
/** Drives refused() for a key whose receipt is already rejected: the host answers code to a dispatch this server sends. */
async function recipeQueueRefusal(h, requestKey, recipe, code) {
  // A fresh recipe queue so that the receipt check before the dispatch does not stop it: its first lookup reports
  // nothing, then the dispatch is refused and the confirming lookup reads the real (rejected) receipt.
  const queue = recipeQueue.createRecipeQueue({ bridge: { async call(method, args, signal) {
    if (method === 'lookup_queue_request' && !queue.gateDone) { queue.gateDone = true; return {}; }
    if (method === 'enqueue_queue_recipes') throw new BridgeError(code, '冻结队列无法安全读取或写入；保留文件，已停止新的任务提交。');
    return h.bridge.call(method, args, signal);
  } } });
  try { await queue.enqueue({ requestKey, items: [{ ...ref(recipe), seeds: [1] }] }); return { isError: false }; }
  catch (error) { return { isError: true, structuredContent: { error: { code: error.code, message: error.message, details: error.details } } }; }
}

// ------------------------------------------------------------------------------------------------ P13 (issue #2): study sources
const studyFacts = (identity, bytes, width, height, mimeType = 'image/png') => ({ kind: 'study', studyId: identity.studyId, studyRevision: identity.studyRevision, sha256: sha256(bytes), mimeType, width, height, byteLength: bytes.length });

test('P13 study source shapes: malformed or mixed study sources are refused before any host call, each with its path', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const study = { kind: 'study', studyId: randomUUID(), studyRevision: 1 }, history = { kind: 'history', historyId: 'h', historyRevision: 1, assetId: 'a' };
  // Server-side checks (the flat schema lets these through): details {reason:"source_invalid", path}.
  const server = {
    noStudyId: [omit(study, 'studyId'), 'source.studyId'], noStudyRevision: [omit(study, 'studyRevision'), 'source.studyRevision'],
    withAssetId: [{ ...study, assetId: 'path:x' }, 'source.assetId'], withHistoryId: [{ ...study, historyId: 'h' }, 'source.historyId'],
    historyWithStudyId: [{ ...history, studyId: study.studyId }, 'source.studyId'], historyWithStudyRevision: [{ ...history, studyRevision: 1 }, 'source.studyRevision'],
    historyWithoutAssetId: [omit(history, 'assetId'), 'source.assetId'],
  };
  for (const [name, [source, path]] of Object.entries(server)) {
    const error = errorOf(await call('prepare_recipe', recipes(source).upscale()));
    assert.equal(error.code, 'invalid_arguments', name);
    assert.deepEqual([error.details?.reason, error.details?.path], ['source_invalid', path], `${name}: ${error.message}`);
  }
  // The public schema refuses these first; its message names the field.
  const schema = { notUuid: [{ ...study, studyId: 'study-1' }, 'source/studyId'], upperUuid: [{ ...study, studyId: study.studyId.toUpperCase() }, 'source/studyId'], revision0: [{ ...study, studyRevision: 0 }, 'source/studyRevision'],
    revisionText: [{ ...study, studyRevision: '1' }, 'source/studyRevision'], kindImports: [{ ...study, kind: 'imports' }, 'source/kind'], noKind: [omit(study, 'kind'), 'source'], extra: [{ ...study, file: 'a.png' }, 'source'] };
  for (const [name, [source, path]] of Object.entries(schema)) {
    const error = errorOf(await call('prepare_recipe', recipes(source).i2i()));
    assert.equal(error.code, 'invalid_arguments', name); assert.match(error.message, new RegExp(`arguments/${path.replace('/', '\\/')}`), `${name}: ${error.message}`);
  }
  assert.deepEqual(h.calls, [], 'no malformed source reached the host');
  // The server check itself, without the schema in front of it.
  for (const [value, path] of [[omit(study, 'studyId'), 'source.studyId'], [{ ...study, studyId: 'x' }, 'source.studyId'], [{ ...study, studyId: study.studyId.toUpperCase() }, 'source.studyId'], [{ ...study, studyRevision: 0 }, 'source.studyRevision'],
    [{ ...study, studyRevision: 1.5 }, 'source.studyRevision'], [{ ...study, assetId: 'a' }, 'source.assetId'], [{ ...study, historyId: 'h', historyRevision: 1 }, 'source.historyId'], [{ ...history, studyId: 'x' }, 'source.studyId'],
    [{ ...study, kind: 'imports' }, 'source.kind'], [omit(study, 'kind'), 'source.kind'], ['/Users/x/a.png', 'source']])
    assert.throws(() => sources.sourceIdentity(value), error => error.code === 'invalid_arguments' && error.details.reason === 'source_invalid' && error.details.path === path, JSON.stringify(value));
  assert.deepEqual(sources.sourceIdentity(study), study);
  assert.deepEqual(sources.sourceIdentity(history), history, 'history sources are unchanged');
});

test('P13 study sources in every image mode: one study metadata read without assetId, one put of a study reference; the readback names the study', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const bytes = gradient(768, 1216), study = h.addStudy(bytes, { width: 768, height: 1216 }), r = recipes(study);
  const prepared = {};
  for (const [label, args] of [['i2i', r.i2i({ width: 768, height: 1216 })], ['enhance', r.enhance()], ['inpaint', r.inpaint(RECT_MASK)], ['upscale', r.upscale()], ['director', r.director()]]) {
    const before = h.calls.length;
    const result = prepared[label] = ok(await call('prepare_recipe', args));
    assert.deepEqual(h.methods().slice(before), ['asset_library', 'put_queue_recipe'], label);
    const [read, put] = h.calls.slice(before);
    assert.deepEqual(read.args, { action: 'image', kind: 'study', id: study.studyId, revision: 1, variant: 'thumbnail' }, `${label}: metadata only, no assetId`);
    assert.deepEqual(put.args.preparation.assets[0], { role: 'source', mimeType: 'image/png', ref: { kind: 'study', id: study.studyId, revision: 1 }, sha256: sha256(bytes), byteLength: bytes.length }, label);
    assert.deepEqual(result.source, studyFacts(study, bytes, 768, 1216), label);
    assert.equal(result.ready, true, label); assert.equal(result.saved, true, label);
    assert.ok(result.assets.every(asset => !('data' in asset)), label);
    assert.deepEqual(ok(await readRecipe(ref(result))), { ...readbackOf(result), warnings: result.warnings.filter(warning => !['stroke_thin', 'layer_below_cell_resolution', 'layer_empty', 'layer_no_effect', 'alpha_scaled', 'alpha_opaque', 'mask_covers_all'].includes(warning.code)) }, `${label}: the stored readback is the same`);
  }
  assert.equal(prepared.inpaint.mask.selectedCells, await hostRequestMaskCells(h, prepared.inpaint));
  // The reference is not part of inputHash: the same image as a history source gives the same inputHash.
  const twin = ok(await call('prepare_recipe', recipes(h.addHistory('history-twin', bytes, { width: 768, height: 1216 })).i2i({ width: 768, height: 1216 })));
  assert.equal(twin.inputHash, prepared.i2i.inputHash); assert.equal(twin.source.kind, 'history');
  // A preview reads the same study and names it too; nothing is written.
  const files = await h.tree();
  const preview = ok(await call('prepare_recipe', r.inpaint(RECT_MASK, { preview: true })));
  assert.equal(preview.preview, true); assert.deepEqual(preview.source, studyFacts(study, bytes, 768, 1216)); assert.deepEqual(await h.tree(), files);
});

test('P13 study sources: the size rules and the EXIF orientation check run after the metadata read and before any put', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const add = (width, height, options = {}) => h.addStudy(options.bytes ?? gradient(width, height), { width, height, ...options });
  const cases = [
    ['inpaint over 1600', recipes(add(1664, 1024)).inpaint(RECT_MASK), 'inpaint_source_too_large'],
    ['upscale over 1 MP, downscale declined', recipes(add(1280, 1280)).upscale({ acceptDownscale: false }), 'source_needs_downscale'],
    ['gif', recipes(add(1, 1, { bytes: GIF, mimeType: 'image/gif' })).upscale(), 'source_unsupported_type'],
    ['EXIF orientation 6', recipes(add(832, 1216, { bytes: await toJpeg(gradient(832, 1216)), mimeType: 'image/jpeg', orientation: 6 })).i2i(), 'source_orientation_unsupported'],
    ['EXIF orientation 8 (inpaint preview)', recipes(add(768, 1216, { orientation: 8 })).inpaint(RECT_MASK, { preview: true }), 'source_orientation_unsupported'],
  ];
  for (const [label, args, reason] of cases) {
    const before = h.calls.length;
    const error = errorOf(await call('prepare_recipe', args));
    assert.equal(error.code, 'invalid_arguments', `${label}: ${error.message}`); assert.equal(error.details?.reason, reason, `${label}: ${error.message}`);
    assert.deepEqual(h.methods().slice(before), ['asset_library'], `${label}: nothing saved`);
  }
  const rotated = errorOf(await call('prepare_recipe', recipes(add(832, 1216, { orientation: 3 })).i2i()));
  assert.deepEqual(rotated.details.source, { orientation: 3 }); assert.match(rotated.message, /Apply the rotation locally \(save an upright copy without the orientation tag, for example as PNG\) and import that copy\. Nothing was saved\./);
  assert.equal(h.count('put_queue_recipe'), 0); assert.deepEqual(await h.tree(), {}, 'nothing was written');
  // Orientation 1 is upright: accepted.
  assert.equal(ok(await call('prepare_recipe', recipes(add(832, 1216, { orientation: 1 })).i2i())).source.kind, 'study');
  // A study the library does not know: its own code, a study-specific next step, nothing saved.
  const missing = errorOf(await call('prepare_recipe', recipes({ kind: 'study', studyId: randomUUID(), studyRevision: 1 }).upscale()));
  assert.equal(missing.code, 'library_not_found'); assert.equal(missing.details.saved, false); assert.equal(missing.details.path, 'source');
  assert.equal(missing.details.studyRevision, 1); assert.ok(!('historyId' in missing.details)); assert.match(missing.message, /check the identity with material_studies/);
  // An asset library reply for another study, or a study reply without a usable assetId, is refused.
  const known = add(768, 1216);
  for (const tamper of [reply => ({ ...reply, id: randomUUID() }), reply => ({ ...reply, kind: 'history' }), reply => ({ ...reply, assetId: ' ' }), reply => omit(reply, 'assetId'), reply => ({ ...reply, sourceOrientation: 9 })]) {
    h.faults.asset_library = tamper;
    assert.equal(errorOf(await call('prepare_recipe', recipes(known).upscale())).code, 'invalid_response');
  }
});

test('P13 a put, preview or read reply whose study reference differs (kind, id, revision, an added assetId, none) is never adopted', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const bytes = gradient(768, 1216), study = h.addStudy(bytes, { width: 768, height: 1216 }), r = recipes(study);
  const refOf = reply => reply.assetRefs[0].ref;
  const withRef = change => reply => ({ ...reply, assetRefs: [{ ...reply.assetRefs[0], ref: change(refOf(reply)) }] });
  const tampers = [
    ['kind history', withRef(value => ({ kind: 'history', id: value.id, revision: value.revision, assetId: 'path:x' }))],
    ['another study', withRef(value => ({ ...value, id: randomUUID() }))],
    ['another revision', withRef(value => ({ ...value, revision: 2 }))],
    ['study with assetId', withRef(value => ({ ...value, assetId: 'path:x' }))],
    ['no reference', reply => omit(reply, 'assetRefs')],
  ];
  for (const [label, fault] of tampers) {
    h.faults.put_queue_recipe = fault;
    assert.equal(errorOf(await call('prepare_recipe', r.i2i({ width: 768, height: 1216 }))).code, 'recipe_identity_unconfirmed', `put: ${label}`);
    h.faults.preview_queue_recipe = fault;
    // A malformed reference fails the preview's structural check (invalid_response); a well-formed other one is an identity mismatch.
    assert.equal(errorOf(await call('prepare_recipe', r.upscale({ preview: true }))).code, label === 'study with assetId' ? 'invalid_response' : 'recipe_identity_unconfirmed', `preview: ${label}`);
  }
  const saved = ok(await call('prepare_recipe', r.i2i({ width: 768, height: 1216 })));
  h.faults.read_queue_recipe = withRef(value => ({ ...value, assetId: 'path:x' }));
  assert.equal(errorOf(await readRecipe(ref(saved))).code, 'invalid_response');
  assert.equal(ok(await readRecipe(ref(saved))).source.kind, 'study');
});

test('P13 host_outdated: a client without the study branch refuses the study read as an argument error; nothing is saved, history sources keep working', async t => {
  const h = await realHost(t);
  // bridge-server validates asset_library against its generated contract; an older one has no study branch.
  const old = { async call(method, args, signal) {
    if (method === 'asset_library' && args?.kind === 'study') { observed.push(method); h.calls.push({ method, args: structuredClone(args) }); throw new BridgeError('invalid_argument', "素材请求无效：data must have required property 'assetId', data/kind must be equal to constant, data must match a schema in anyOf"); }
    return h.bridge.call(method, args, signal);
  } };
  const { call, readRecipe } = await connect(t, old);
  const study = h.addStudy(gradient(768, 1216), { width: 768, height: 1216 }), r = recipes(study);
  for (const [label, args] of [['i2i', r.i2i({ width: 768, height: 1216 })], ['inpaint preview', r.inpaint(RECT_MASK, { preview: true })], ['upscale', r.upscale()]]) {
    const before = h.calls.length;
    const error = errorOf(await call('prepare_recipe', args));
    assert.equal(error.code, 'host_outdated', `${label}: ${error.message}`); assert.equal(error.message, sources.STUDY_SOURCE_HOST_OUTDATED_MESSAGE);
    assert.match(error.message, /Fully rebuild and restart the client/); assert.match(error.message, /Nothing was saved/);
    assert.deepEqual(error.details, { path: 'source', studyId: study.studyId, studyRevision: 1, saved: false, hostCode: 'invalid_argument' }, label);
    assert.deepEqual(h.methods().slice(before), ['asset_library'], `${label}: one read, no retry in another form, no put`);
  }
  assert.deepEqual(await h.tree(), {}, 'nothing was written');
  const history = h.addHistory('history-on-old-client', gradient(768, 1216), { width: 768, height: 1216 });
  assert.equal(ok(await call('prepare_recipe', recipes(history).i2i({ width: 768, height: 1216 }))).source.kind, 'history');
  // Another refusal code of a study read is the host's own answer, not an outdated client.
  h.faults.asset_library = { before: () => { throw new BridgeError('image_busy', 'busy'); } };
  const busy = errorOf(await (await connect(t, h.bridge)).call('prepare_recipe', r.upscale()));
  assert.equal(busy.code, 'image_busy'); assert.match(busy.message, /^The study image at source could not be read now/);
});

test('P13 revisions switch between study and history sources with every field again', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const study = h.addStudy(gradient(768, 1216), { width: 768, height: 1216 }), other = h.addStudy(gradient(832, 1216), { width: 832, height: 1216 }), history = h.addHistory('history-p13', gradient(768, 1152), { width: 768, height: 1152 });
  const first = ok(await call('prepare_recipe', recipes(study).i2i({ width: 768, height: 1216 })));
  let before = h.calls.length;
  const second = ok(await call('prepare_recipe', recipes(other).i2i({ recipeId: first.recipeId, expectedRevision: 1, width: 832, height: 1216 })));
  assert.deepEqual(h.methods().slice(before), ['read_queue_recipe', 'asset_library', 'put_queue_recipe']);
  assert.deepEqual([second.recipeRevision, second.source.kind, second.source.studyId], [2, 'study', other.studyId]);
  const third = ok(await call('prepare_recipe', recipes(history).i2i({ recipeId: first.recipeId, expectedRevision: 2, width: 768, height: 1152 })));
  assert.deepEqual([third.recipeRevision, third.source.kind, third.source.historyId], [3, 'history', 'history-p13']);
  const fourth = ok(await call('prepare_recipe', recipes(study).i2i({ recipeId: first.recipeId, expectedRevision: 3, width: 768, height: 1216 })));
  assert.deepEqual([fourth.recipeRevision, fourth.source.kind, fourth.source.studyId], [4, 'study', study.studyId]);
  before = h.calls.length;
  assert.equal(errorOf(await call('prepare_recipe', omit(recipes(study).i2i({ recipeId: first.recipeId, expectedRevision: 4, width: 768, height: 1216 }), 'source'))).code, 'invalid_arguments');
  assert.equal(h.calls.length, before, 'a revision without source never reaches the host');
});

test('P13 enqueue freezes the study source bytes; a deleted or replaced study source stops the stored readback and enqueue before any receipt', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const bytes = gradient(768, 1216), study = h.addStudy(bytes, { width: 768, height: 1216 }), r = recipes(study);
  const a = ok(await call('prepare_recipe', r.i2i({ width: 768, height: 1216 }))), b = ok(await call('prepare_recipe', r.i2i({ width: 768, height: 1216, strength: 0.3 })));
  const receipt = ok(await call('enqueue_recipes', { requestKey: 'study-enqueue', items: [{ ...ref(a), seeds: [1, 2] }] }));
  assert.equal(receipt.status, 'enqueued'); assert.equal(h.jobs.at(-1).args.snapshot.sourceImage.data, bytes.toString('base64'), 'the batch carries the study bytes');
  // The 32 MiB frozen-input estimate counts a study reference by its byteLength, like a history reference. The size is
  // injected here; that the host reports a study reference's byteLength in assetBytes is asserted in
  // client/electron/queue-recipe-reference.test.ts (study group).
  h.transforms.read_queue_recipe = reply => ({ ...reply, assetBytes: { source: 17 * MiB } });
  const over = errorOf(await call('enqueue_recipes', { requestKey: 'study-too-big', items: [{ ...ref(a), seeds: [1] }, { ...ref(b), seeds: [2] }] }));
  assert.equal(over.code, 'invalid_arguments'); assert.equal(over.details.estimatedBytes, 2 * Math.ceil(17 * MiB / 3) * 4);
  delete h.transforms.read_queue_recipe;
  const key = `${study.studyId}:1`, entry = h.studies.get(key);
  h.studies.delete(key);
  const gone = errorOf(await readRecipe(ref(a)));
  assert.equal(gone.code, 'recipe_source_unavailable'); assert.deepEqual(gone.details.ref, { kind: 'study', id: study.studyId, revision: 1 });
  assert.match(gone.message, new RegExp(`source \\(study ${study.studyId} revision 1\\)`));
  const refused = errorOf(await call('enqueue_recipes', { requestKey: 'study-gone', items: [{ ...ref(a), seeds: [1] }] }));
  assert.equal(refused.code, 'recipe_source_unavailable'); assert.equal(refused.details.enqueueSent, false);
  assert.deepEqual(refused.details.hostDetails, { recipeId: a.recipeId, recipeRevision: 1, ref: { kind: 'study', id: study.studyId, revision: 1 }, sha256: sha256(bytes), byteLength: bytes.length, readerCode: 'library_not_found' });
  assert.equal(ok(await call('lookup_enqueue', { requestKey: 'study-gone' })).status, 'not_found', 'the key stays unused');
  h.studies.set(key, { ...entry, bytes: gradient(768, 1216).reverse() });
  assert.equal(errorOf(await call('enqueue_recipes', { requestKey: 'study-gone', items: [{ ...ref(a), seeds: [1] }] })).code, 'recipe_source_changed');
  const revise = errorOf(await call('prepare_recipe', r.i2i({ recipeId: a.recipeId, expectedRevision: 1, width: 768, height: 1216 })));
  assert.equal(revise.code, 'recipe_source_changed'); assert.match(revise.message, /prepare a new recipe \(without recipeId\)/);
  h.studies.set(key, entry);
  assert.equal(ok(await call('enqueue_recipes', { requestKey: 'study-gone', items: [{ ...ref(a), seeds: [1] }] })).status, 'enqueued', 'the same key works once the original is back');
});

// ------------------------------------------------------------------------------------------------ V5 Full Effort, Enhance Max✨
// Official web client (https://novelai.net/image, build b94bdee-production, read 2026-11-06): see client/src/nai-effort.ts
// and client/src/nai-dimensions.ts for the facts these requests mirror.
const HEAVY = 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page';
const V5_GEN = { ...GEN, model: 'nai-diffusion-5-full' };
test('effort medium: t2i, i2i and inpaint replace the fixed fields (with a warning each) instead of refusing; the readback shows the Medium request', async t => {
  const h = await realHost(t);
  const { call } = await connect(t, h.bridge);
  const source = h.addHistory('history-medium', gradient(832, 1216), { width: 832, height: 1216 }), r = recipes(source);
  const t2i = ok(await call('prepare_recipe', { mode: 't2i', ...V5_GEN, width: 832, height: 1216, effort: 'medium', steps: 28, sampler: 'k_dpmpp_2m', cfgRescale: 0.3, ucPreset: 2,
    characters: [{ prompt: 'girl', negativePrompt: 'hat', useCoords: false }] }));
  assert.equal(t2i.effective.model, 'nai-diffusion-5-full-medium');
  assert.deepEqual([t2i.effective.steps, t2i.effective.sampler, t2i.effective.cfgRescale, t2i.effective.cfgScale], [14, 'k_euler_ancestral', 0, 5]);
  assert.equal(t2i.effective.negativePrompt, `nsfw, ${HEAVY}`);
  assert.deepEqual(t2i.effective.ucPreset, { preset: 0, text: `nsfw, ${HEAVY}`, derivedFromBuilderOutput: true, fixedByEffort: true });
  assert.equal(t2i.effective.effort.level, 'medium');
  assert.deepEqual(t2i.effective.effort.fixed, { steps: 14, sampler: 'k_euler_ancestral', cfgRescale: 0, ucPreset: 'Heavy', undesiredContent: `nsfw, ${HEAVY}`, nsfwPrefixed: true, characterNegativePrompts: 'not sent', tagHintUcPreset: 2 });
  assert.deepEqual(t2i.effective.characters, [{ index: 0, prompt: 'girl', negativePrompt: '', center: { x: 0.5, y: 0.5 } }]);
  assert.deepEqual(t2i.authored, { ...t2i.authored, effort: 'medium', steps: 14, sampler: 'k_euler_ancestral', cfgRescale: 0, ucPreset: 0, negativePrompt: '' });
  const fixed = t2i.warnings.filter(warning => warning.code === 'effort_medium_fixed');
  assert.deepEqual(fixed.map(warning => warning.field), ['steps', 'sampler', 'cfgRescale', 'ucPreset', 'negativePrompt', 'characters.negativePrompt']);
  assert.equal(fixed[0].message, 'effort medium fixes steps to 14; your 28 was replaced.');
  // Medium may leave its fixed fields out; nothing to replace, so no warning.
  const bare = ok(await call('prepare_recipe', omit({ mode: 't2i', ...V5_GEN, width: 832, height: 1216, effort: 'medium', positivePrompt: '1girl, nsfw' }, 'steps', 'sampler', 'ucPreset', 'negativePrompt')));
  assert.equal(bare.effective.negativePrompt, HEAVY, 'a prompt that asks for nsfw gets no nsfw in the UC');
  assert.deepEqual(bare.warnings, []);
  // High (or no effort) keeps exactly the fields and inputHash it always had.
  const high = ok(await call('prepare_recipe', { mode: 't2i', ...V5_GEN, width: 832, height: 1216, effort: 'high' }));
  const plain = ok(await call('prepare_recipe', { mode: 't2i', ...V5_GEN, width: 832, height: 1216 }));
  assert.equal(high.inputHash, plain.inputHash); assert.equal(plain.effective.model, 'nai-diffusion-5-full'); assert.equal(plain.authored.effort, 'high');
  assert.equal(Object.hasOwn(json(await h.service.read_queue_recipe({ recipeId: plain.recipeId, recipeRevision: plain.recipeRevision })).snapshot.reviewInput.authored.params, 'effort'), false);
  const i2i = ok(await call('prepare_recipe', r.i2i({ ...V5_GEN, effort: 'medium' })));
  assert.deepEqual([i2i.effective.model, i2i.effective.steps, i2i.effectiveRequest.action], ['nai-diffusion-5-full-medium', 14, 'img2img']);
  const inpaint = ok(await call('prepare_recipe', r.inpaint(RECT_MASK, { ...V5_GEN, effort: 'medium', strength: 0.6 })));
  assert.equal(inpaint.effective.model, 'nai-diffusion-5-full-medium-inpainting');
  assert.deepEqual(inpaint.effectiveRequest.parameters.img2img, { strength: 0.6, color_correct: true });
  assert.deepEqual(inpaint.warnings.filter(warning => warning.code === 'effort_medium_fixed').map(warning => warning.field), ['steps', 'negativePrompt']);
});

test('effort medium runs on High where it does not exist (another model, enhance, upscale, director), with effort_not_applied; an unknown effort is refused', async t => {
  const h = await realHost(t);
  const { call } = await connect(t, h.bridge);
  const source = h.addHistory('history-effort', gradient(832, 1216), { width: 832, height: 1216 }), r = recipes(source);
  for (const [args, pattern, check] of [
    [{ mode: 't2i', ...GEN, width: 832, height: 1216, effort: 'medium' }, /effort medium exists only for nai-diffusion-5-full; nai-diffusion-4-5-full has no Medium effort, so it runs on High/, v => v.effective.steps === 28 && v.effective.effort.level === 'high'],
    [{ mode: 't2i', ...V5_GEN, model: 'nai-diffusion-5-curated', width: 832, height: 1216, effort: 'medium' }, /nai-diffusion-5-curated has no Medium effort/, v => v.effective.model === 'nai-diffusion-5-curated'],
    [r.enhance({ ...V5_GEN, effort: 'medium' }), /mode enhance runs on High/, v => v.effective.effort.level === 'high'],
    [r.upscale({ effort: 'medium' }), /mode upscale runs on High/, v => v.effective.scale === 2],
    [r.director({ effort: 'medium' }), /mode director runs on High/, v => v.effective.tool === 'bg-removal'],
  ]) {
    const prepared = ok(await call('prepare_recipe', args));
    const warning = prepared.warnings.find(item => item.code === 'effort_not_applied');
    assert.ok(warning, JSON.stringify(prepared.warnings)); assert.deepEqual([warning.field, warning.from, warning.to], ['effort', 'medium', 'high']); assert.match(warning.message, pattern);
    assert.ok(check(prepared), args.mode); assert.equal(prepared.authored.effort ?? 'high', 'high');
  }
  const before = h.calls.length;
  assert.equal(errorOf(await call('prepare_recipe', { mode: 't2i', ...V5_GEN, width: 832, height: 1216, effort: 'low' })).code, 'invalid_arguments');
  assert.equal(h.calls.length, before, 'refused before any host call');
  ok(await call('prepare_recipe', r.upscale({ effort: 'high' })));
  ok(await call('prepare_recipe', r.enhance({ ...V5_GEN, effort: 'high' })));
});

test('Enhance Max✨: V5 only; the size is worked out (never refused), and the readback gives the expected result and the Opus cost', async t => {
  const h = await realHost(t);
  const { call } = await connect(t, h.bridge);
  const source = h.addHistory('history-max', gradient(832, 1216), { width: 832, height: 1216 });
  const odd = h.addHistory('history-max-odd', gradient(830, 1210), { width: 830, height: 1210 });
  const max = ok(await call('prepare_recipe', recipes(source).enhance({ ...V5_GEN, scale: 'max' })));
  assert.equal(max.effective.model, 'nai-diffusion-5-full');
  assert.deepEqual([max.effective.width, max.effective.height, max.effectiveRequest.parameters.upscaled_enhance], [832, 1216, true]);
  assert.deepEqual(max.effective.enhance, { magnitude: 3, scale: 'max', derivedStrength: 0.202, max: true, upscaledEnhance: true, expectedOutput: { width: 1440, height: 2144 }, costsAnlasOnOpus: true });
  assert.deepEqual(max.effective.processing, { inputWidth: 832, inputHeight: 1216, outputWidth: 1440, outputHeight: 2144, resizedInput: false, alphaFlattened: false, upscaledEnhance: true });
  assert.deepEqual(max.warnings.map(warning => warning.code), ['enhance_max_paid']);
  assert.match(max.warnings[0].message, /returns about 1440×2144 .*costs Anlas on Opus too/);
  const adjusted = ok(await call('prepare_recipe', recipes(odd).enhance({ ...V5_GEN, scale: 'max' })));
  assert.deepEqual([adjusted.effective.width, adjusted.effective.height], [832, 1216]);
  assert.deepEqual(adjusted.warnings.map(warning => warning.code), ['enhance_max_source_adjusted', 'enhance_max_paid']);
  // 0.1.4: Max✨ on another model runs the largest scale that fits (here 1: 2× of 832×1216 is over the pixel limit).
  const elsewhere = ok(await call('prepare_recipe', recipes(source).enhance({ scale: 'max' })));
  const replaced = elsewhere.warnings.find(warning => warning.code === 'value_replaced');
  assert.deepEqual([replaced.field, replaced.from, replaced.to], ['scale', 'max', 1]); assert.match(replaced.message, /Max✨ exists only for the V5 models/);
  assert.equal(elsewhere.effective.enhance.scale, 1); assert.equal(elsewhere.effective.enhance.max, undefined); assert.deepEqual([elsewhere.effective.width, elsewhere.effective.height], [832, 1216]);
  const small = h.addHistory('history-max-small', gradient(512, 768), { width: 512, height: 768 });
  const two = ok(await call('prepare_recipe', recipes(small).enhance({ scale: 'max' })));
  assert.equal(two.effective.enhance.scale, 2); assert.deepEqual([two.effective.width, two.effective.height], [1024, 1536]);
  // 1× of an unaligned source: the host's own resize to 64 multiples, reported.
  const oddOne = ok(await call('prepare_recipe', recipes(odd).enhance({ ...V5_GEN, scale: 1 })));
  assert.deepEqual(oddOne.warnings.find(warning => warning.code === 'enhance_source_adjusted').to, { width: 832, height: 1216 });
});

test('parity: the Medium constants and the Max✨ size ports mirror the client', () => {
  const { effort, dimensions } = host;
  assert.deepEqual({ ...recipeQueue.MEDIUM_FIXED }, { ...effort.NAI_MEDIUM_FIXED, negativePrompt: '' });
  assert.deepEqual([...recipeQueue.MEDIUM_MODELS], [effort.NAI_MEDIUM_MODEL, effort.NAI_MEDIUM_INPAINT_MODEL]);
  assert.equal(recipeQueue.EFFORT_MODEL, effort.NAI_EFFORT_MODEL);
  assert.deepEqual([...recipeQueue.EFFORT_VALUES], [...effort.NAI_EFFORT_VALUES]);
  assert.equal(recipeQueue.MAX_ENHANCE_INPUT_LIMIT, dimensions.NAI_MAX_ENHANCE_INPUT_LIMIT);
  let seed = 0x3a11;
  const random = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
  const sizes = [[832, 1216], [1216, 832], [1024, 1024], [64, 64], [1, 1], [830, 1210], [1600, 1600], [2048, 2048], [49152, 64], [100000, 64]];
  while (sizes.length < 200) sizes.push([1 + Math.floor(random() * 3200), 1 + Math.floor(random() * 3200)]);
  for (const [width, height] of sizes) {
    const input = recipeQueue.maxEnhanceInputSize(width, height);
    assert.deepEqual(input, dimensions.maxEnhanceInputSize(width, height), `${width}×${height}`);
    assert.ok(input.width * input.height < recipeQueue.MAX_ENHANCE_INPUT_LIMIT && input.width % 64 === 0 && input.height % 64 === 0, `${width}×${height} → ${input.width}×${input.height}`);
    assert.deepEqual(recipeQueue.maxEnhanceOutputSize(input.width, input.height), dimensions.maxEnhanceOutputSize(input.width, input.height));
  }
});

test('every host method observed across this file is declared by the recipe and queue tools', () => {
  const declared = new Set(['prepare_recipe', 'enqueue_recipes', 'list_queue', 'read_queue', 'get_queue_result'].flatMap(name => registry.get(name).hostMethods));
  assert.deepEqual([...new Set(observed)].filter(method => !declared.has(method)), []);
  for (const method of ['asset_library', 'put_queue_recipe', 'read_queue_recipe', 'preview_queue_recipe', 'lookup_queue_request', 'enqueue_queue_recipes']) assert.ok(observed.includes(method), method);
  assert.deepEqual(registry.get('prepare_recipe').hostMethods, ['read_queue_recipe', 'asset_library', 'put_queue_recipe', 'preview_queue_recipe', 'capture_canvas_recipe']);
});
