import nodeTest, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp, { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Phase two (independent recipes + shared FIFO enqueue). Offline: fetch refused, tag
// cache redirected. The host is the REAL client queue-recipe service
// (client/electron/queue-recipe-service.ts, loaded through jiti like
// v5-uc-presets.test.mjs) with a temporary runtime directory and an in-memory
// batch backend, reached through a bridge double that mirrors the HTTP bridge's
// error mapping. Review policies live only in temporary files.
const tagCacheDir = await mkdtemp(join(tmpdir(), 'novelai-business-recipes-cache-'));
process.env.NOVELAI_TAG_QUERY_CACHE_DIR = tagCacheDir;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Real network access is forbidden in business MCP tests.'); };

const { createJiti } = await import('jiti');
const merged = await import('../src/mcp.mjs');
const recipeQueue = await import('../src/recipe-queue.mjs');
const { success, errorResult, failure } = await import('../src/mcp-registry.mjs');
const { projectRoots, PROJECT_ROOT, trustedIdentities } = await import('../src/business-guards.mjs');
const { BridgeError } = merged;

// Every server test runs against the `novelai` server (src/mcp.mjs). Until 2026-10-09 each also ran against the
// `novelai-business` alias; the alias is gone, and the [novelai] label and SERVERS table are kept for stable names.
const SERVERS = [
  { label: 'novelai', module: 'src/mcp.mjs', factory: 'createNovelAiMcpServer', create: options => merged.createNovelAiMcpServer(options) },
];
let serverUnderTest = SERVERS[0];
const test = (name, fn) => { for (const variant of SERVERS) nodeTest(`[${variant.label}] ${name}`, t => { serverUnderTest = variant; return fn(t); }); };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The four raw recipe/queue methods plus list_queue (lookup_enqueue checks a stuck unknown receipt against the queue).
const RECIPE_METHODS = new Set(['put_queue_recipe', 'read_queue_recipe', 'lookup_queue_request', 'enqueue_queue_recipes', 'list_queue']);
const observedHostMethods = new Set();
// Independent expectation: official V5 Human Focus UC text (docs.novelai.net, checked 2026-09-11; same as v5-uc-presets.test.mjs).
const V5_HEAVY = 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page';
const V5_HUMAN = `${V5_HEAVY}, @_@, mismatched pupils, glowing eyes, bad anatomy`;

let createQueueRecipeService, queueBridgeError, buildPayload, fixtureDir;
before(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'novelai-business-recipes-host-'));
  const electron = join(fixtureDir, 'electron.mjs'), axios = join(fixtureDir, 'axios.mjs');
  await writeFile(electron, `const forbidden = () => { throw new Error('recipe fixture cannot access native UI or account paths'); };
export const app = { getPath: forbidden, getVersion: forbidden }; export const dialog = {};
export const nativeImage = { createFromBuffer: forbidden, createFromPath: forbidden };`);
  await writeFile(axios, `const forbidden = () => { throw new Error('recipe fixture cannot access the network'); };
export default { get: forbidden, post: forbidden, request: forbidden, create: forbidden };`);
  // One module cache, loaded one after another: queueBridgeError must see the same WorkspaceError/BatchError classes
  // the service throws (separate module instances would fail its instanceof checks).
  const jiti = createJiti(import.meta.url, { moduleCache: true, fsCache: false, alias: { electron, axios } });
  ({ createQueueRecipeService } = await jiti.import(fileURLToPath(new URL('../client/electron/queue-recipe-service.ts', import.meta.url))));
  ({ queueBridgeError } = await jiti.import(fileURLToPath(new URL('../client/electron/queue-bridge-error.ts', import.meta.url))));
  ({ buildPayload } = await jiti.import(fileURLToPath(new URL('../client/electron/nai-payload.ts', import.meta.url))));
});
after(async () => {
  globalThis.fetch = originalFetch;
  await rm(tagCacheDir, { recursive: true, force: true });
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

const json = value => JSON.parse(JSON.stringify(value));
/**
 * A host queue error as production delivers it: main.ts queueMethods wraps it with the real queueBridgeError (code
 * rule; message and plain JSON details only for WorkspaceError/BatchError), the HTTP bridge sends code, message
 * and details, and the bridge client raises them as an MCP BridgeError.
 */
const hostError = error => { const bridged = queueBridgeError(error); return new BridgeError(bridged.code, bridged.message, bridged.details); };
// Same secret-key filter the real HTTP bridge client applies to host results (src/mcp.mjs sanitize).
const transportKey = /^(?:.*(?:token|password|secret|credential|authorization|cookie)|api_?key|auth|settings)$/i;
const transport = value => Array.isArray(value) ? value.map(transport) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => !transportKey.test(key)).map(([key, item]) => [key, transport(item)])) : value;
/**
 * Real host service + in-memory FIFO backend + bridge double with production's error mapping (hostError).
 * Faults per method: 'lost-before-host', 'reply-lost', 'held' (the request is held back and reaches the
 * host only when releaseHeld() runs; the caller sees a timeout), { before } (runs before the host call)
 * or a function applied to the host reply.
 */
async function realHost(t, serviceOptions = {}) {
  const base = await mkdtemp(join(tmpdir(), 'novelai-business-recipes-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const runtimeDir = join(base, 'runtime'); await mkdir(runtimeDir);
  const jobs = [];
  const backend = {
    ready: Promise.resolve(),
    async enqueue(args) {
      if (backend.failNext) { const failure = backend.failNext; backend.failNext = null; throw failure; }
      // An in-flight host enqueue: the receipt (with args) is written and the backend has not returned yet.
      if (backend.gate) { const gate = backend.gate; backend.gate = null; backend.onEnter?.(); await gate; }
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
  const service = createQueueRecipeService({ runtimeDir, batch: backend, randomSeed: () => 777, ...serviceOptions });
  const calls = [], faults = {}, held = [], background = [];
  const invoke = async (method, args) => {
    try { return json(await service[method](json(args))); }
    catch (error) { throw hostError(error); }
  };
  const releaseHeld = async () => { const results = []; for (const request of held.splice(0)) results.push(await invoke(request.method, request.args).catch(error => error)); return results; };
  const bridge = { async call(method, args, signal) {
    observedHostMethods.add(method);
    calls.push({ method, args: structuredClone(args) });
    if (signal !== undefined) assert.ok(signal instanceof AbortSignal);
    const fault = faults[method];
    if (fault === 'lost-before-host') { delete faults[method]; throw new BridgeError('timeout', 'The client request was interrupted or timed out. Its outcome is unknown.'); }
    if (fault === 'held') { delete faults[method]; held.push({ method, args: structuredClone(args) }); throw new BridgeError('timeout', 'The client request was interrupted or timed out. Its outcome is unknown.'); }
    if (fault === 'timeout-host-continues') { delete faults[method]; const work = invoke(method, args); work.catch(() => undefined); background.push(work); throw new BridgeError('timeout', 'The client request was interrupted or timed out. Its outcome is unknown.'); }
    if (fault && typeof fault === 'object' && typeof fault.before === 'function') { delete faults[method]; await fault.before(); }
    if (typeof service[method] !== 'function') throw new BridgeError('unknown_method', 'No such host method.');
    let result;
    try { result = json(await service[method](json(args))); }
    catch (error) { throw hostError(error); }
    if (fault === 'reply-lost') { delete faults[method]; throw new BridgeError('timeout', 'The client request was interrupted or timed out. Its outcome is unknown.'); }
    if (typeof fault === 'function') { delete faults[method]; return transport(fault(result)); }
    return transport(result);
  } };
  /** Hold the next backend enqueue inside the host (receipt already written) until release(). */
  const gateBackend = () => { let release, entered; const promise = new Promise(resolve => { release = resolve; }); const inside = new Promise(resolve => { entered = resolve; }); backend.gate = promise; backend.onEnter = entered; return { release, inside }; };
  return { base, runtimeDir, service, backend, jobs, bridge, calls, faults, held, releaseHeld, background, gateBackend, count: method => calls.filter(call => call.method === method).length, methods: () => calls.map(call => call.method) };
}
/** A host reply whose snapshot was changed, with inputHash recomputed so only the change itself differs. */
const retamper = (reply, mutate) => {
  const snapshot = structuredClone(reply.snapshot); mutate(snapshot, reply);
  const { assets, ...input } = snapshot.reviewInput;
  return { ...reply, snapshot, inputHash: recipeQueue.recipeHash({ ...input, assets: assets.map(({ data: _d, ...asset }) => asset) }) };
};

/**
 * A settle clock for one server (0.1.4: enqueue_recipes settles an unknown outcome itself): sleeping advances the
 * injected monotonic time instead of waiting, so a settle runs at once and its budget is spent in fake seconds.
 */
const settleClock = (clock = { t: 0 }) => ({ monotonicNow: () => clock.t, sleep: async ms => { clock.t += ms; }, clock });
async function connect(t, bridgeClient, options = {}) {
  const { clock: _clock, ...recipeQueueOptions } = options.recipeQueue ?? settleClock();
  const server = serverUnderTest.create({ bridgeClient, ...options, recipeQueue: { sleep: settleClock().sleep, ...recipeQueueOptions } });
  const client = new Client({ name: 'business-recipes-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { call: (name, args) => client.callTool({ name, arguments: args }), readRecipe: directRecipes(bridgeClient) };
}
// read_recipe is no longer an MCP tool. Stored-revision readbacks go through the recipe module's read() on the same
// bridge double, in the same success/error envelope a core tool returns.
const directRecipes = bridgeClient => {
  const recipes = recipeQueue.createRecipeQueue({ bridge: bridgeClient });
  return async args => {
    try { return success(await recipes.read(args), [], projectRoots(PROJECT_ROOT)); }
    catch (error) { return errorResult(failure(error, { roots: projectRoots(PROJECT_ROOT), trusted: trustedIdentities(args), policy: 'opaque', layer: 'core' })); }
  };
};
const errorOf = result => { assert.equal(result.isError, true, JSON.stringify(result.structuredContent ?? result)); return result.structuredContent.error; };
const ok = result => { assert.ok(!result.isError, JSON.stringify(result.structuredContent ?? result)); return result.structuredContent; };
const t2i = (patch = {}) => ({ mode: 't2i', model: 'nai-diffusion-5-full', width: 832, height: 1216, steps: 28, cfgScale: 5, sampler: 'k_euler_ancestral', noiseSchedule: 'karras',
  ucPreset: 2, qualityPreset: 'standard', stylePrompt: 'watercolor', positivePrompt: '1girl, garden', negativePrompt: 'blurry', seed: 1234,
  characters: [{ prompt: 'girl, red dress', negativePrompt: 'hat', useCoords: true, x: 0.3, y: 0.5 }], ...patch });
const ref = recipe => ({ recipeId: recipe.recipeId, recipeRevision: recipe.recipeRevision, inputHash: recipe.inputHash });
const policyFile = async (t, required) => {
  const directory = await mkdtemp(join(tmpdir(), 'novelai-business-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'review-policy.json');
  await writeFile(file, JSON.stringify({ schemaVersion: 1, required, updatedAt: '2026-09-27T00:00:00.000Z' }));
  return file;
};

test('prepare_recipe freezes a t2i recipe through the real host builder and reads back the actual effective input', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const prepared = ok(await call('prepare_recipe', t2i()));
  assert.deepEqual(h.methods(), ['put_queue_recipe'], 'a new recipe is one put');
  assert.match(prepared.recipeId, /^[a-f0-9-]{36}$/); assert.equal(prepared.recipeRevision, 1); assert.match(prepared.inputHash, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(prepared, 'review'), false, 'no review field');
  assert.equal(prepared.saved, true); assert.equal(prepared.generationSubmitted, false); assert.equal(prepared.ready, true); assert.equal(prepared.lineage, 'plain');
  const effective = prepared.effective;
  assert.equal(effective.positivePrompt, 'watercolor, 1girl, garden, very aesthetic, masterpiece, no text');
  assert.deepEqual(effective.automaticQuality, { preset: 'standard', appendedText: 'very aesthetic, masterpiece, no text', derivedFromBuilderOutput: true });
  assert.equal(effective.negativePrompt, `blurry, ${V5_HUMAN}`);
  assert.deepEqual(effective.ucPreset, { preset: 2, text: V5_HUMAN, derivedFromBuilderOutput: true });
  assert.deepEqual(effective.characters, [{ index: 0, prompt: 'girl, red dress', negativePrompt: 'hat', center: { x: 0.3, y: 0.5 } }]);
  assert.equal(effective.useCoords, true);
  assert.deepEqual({ model: effective.model, width: effective.width, height: effective.height, steps: effective.steps, cfgScale: effective.cfgScale, sampler: effective.sampler, noiseSchedule: effective.noiseSchedule, seed: effective.seed, seedPolicy: effective.seedPolicy, nSamples: effective.nSamples },
    { model: 'nai-diffusion-5-full', width: 832, height: 1216, steps: 28, cfgScale: 5, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', seed: 1234, seedPolicy: 'fixed', nSamples: 1 });
  assert.equal(prepared.effectiveRequest.parameters.n_samples, 1);
  assert.deepEqual(prepared.authored.characters, [{ prompt: 'girl, red dress', negativePrompt: 'hat', useCoords: true, x: 0.3, y: 0.5 }]);
  // The readback is the host's own frozen snapshot: the same identity reads back identically.
  const read = ok(await readRecipe(ref(prepared)));
  const { saved: _saved, generationSubmitted: _submitted, next: _next, ...readback } = prepared;
  assert.deepEqual(read, readback);
  assert.equal(errorOf(await readRecipe({ ...ref(prepared), inputHash: 'f'.repeat(64) })).code, 'recipe_changed');

  // Random seed, no quality tags, no UC preset: the readback shows exactly that.
  const plain = ok(await call('prepare_recipe', t2i({ seed: null, qualityPreset: 'none', ucPreset: 3, stylePrompt: '', negativePrompt: '', characters: [] })));
  assert.equal(plain.effective.positivePrompt, '1girl, garden');
  assert.deepEqual(plain.effective.automaticQuality, { preset: 'none', appendedText: '', derivedFromBuilderOutput: true });
  assert.deepEqual(plain.effective.ucPreset, { preset: 3, text: '', derivedFromBuilderOutput: true });
  assert.equal(plain.effective.seed, null); assert.equal(plain.effective.seedPolicy, 'random_on_submit'); assert.equal(plain.authored.seed, null);
  assert.deepEqual(plain.effective.characters, []);

  // Revision: exact current revision required; a stale one is the host's explicit conflict, nothing saved.
  const before = h.calls.length;
  const revised = ok(await call('prepare_recipe', t2i({ recipeId: prepared.recipeId, expectedRevision: 1, positivePrompt: '1girl, rose garden' })));
  assert.deepEqual(h.methods().slice(before), ['read_queue_recipe', 'put_queue_recipe']);
  assert.equal(revised.recipeId, prepared.recipeId); assert.equal(revised.recipeRevision, 2); assert.notEqual(revised.inputHash, prepared.inputHash);
  const stale = errorOf(await call('prepare_recipe', t2i({ recipeId: prepared.recipeId, expectedRevision: 1 })));
  assert.equal(stale.code, 'recipe_conflict'); assert.equal(stale.details.putOutcome, 'rejected'); assert.equal(stale.details.saved, false);
  // V4.5 with characters and the non-V5 quality table.
  const v45 = ok(await call('prepare_recipe', t2i({ model: 'nai-diffusion-4-5-full', noiseSchedule: 'native', ucPreset: 1, characters: [{ prompt: 'a', useCoords: false }, { prompt: 'b', useCoords: true, x: 0.9, y: 0.1 }] })));
  assert.deepEqual(v45.effective.characters, [{ index: 0, prompt: 'a', negativePrompt: '', center: { x: 0.5, y: 0.5 } }, { index: 1, prompt: 'b', negativePrompt: '', center: { x: 0.9, y: 0.1 } }]);
  assert.equal(v45.effective.noiseSchedule, 'native');
  assert.equal(v45.effective.automaticQuality.appendedText, 'very aesthetic, masterpiece, no text');
  assert.ok(v45.effective.ucPreset.text.length > 0 && v45.effective.negativePrompt === `blurry, ${v45.effective.ucPreset.text}`);
});

test('transparentBackground: V5 recipes send the real builder flags and read back the appended text separately from the quality text', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const prepared = ok(await call('prepare_recipe', t2i({ transparentBackground: true })));
  assert.equal(prepared.ready, true); assert.deepEqual(prepared.warnings, []);
  assert.equal(prepared.authored.transparentBackground, true);
  // Builder order (nai-payload.ts): authored prompt, automatic quality text, then the transparent-background text.
  assert.equal(prepared.effective.positivePrompt, 'watercolor, 1girl, garden, very aesthetic, masterpiece, no text, transparent background');
  assert.deepEqual(prepared.effective.automaticQuality, { preset: 'standard', appendedText: 'very aesthetic, masterpiece, no text', derivedFromBuilderOutput: true });
  assert.deepEqual(prepared.effective.transparentBackground, { enabled: true, straightAlpha: true, appendedText: 'transparent background' });
  assert.equal(prepared.effectiveRequest.parameters.tag_hint_transparent_background, true);
  assert.equal(prepared.effectiveRequest.parameters.straight_alpha, true);
  assert.equal(prepared.effective.negativePrompt, `blurry, ${V5_HUMAN}`, 'the negative prompt is unchanged');
  const { saved: _saved, generationSubmitted: _submitted, next: _next, ...readback } = prepared;
  assert.deepEqual(ok(await readRecipe(ref(prepared))), readback);

  // Without quality tags the transparent text is the only appended segment.
  const bare = ok(await call('prepare_recipe', t2i({ transparentBackground: true, qualityPreset: 'none', stylePrompt: '', characters: [] })));
  assert.equal(bare.effective.positivePrompt, '1girl, garden, transparent background');
  assert.deepEqual(bare.effective.automaticQuality, { preset: 'none', appendedText: '', derivedFromBuilderOutput: true });
  assert.deepEqual(bare.warnings, []);

  // Omitted and explicit false store the same input as before this option existed, and V5 sends the flags as false.
  const omitted = ok(await call('prepare_recipe', t2i()));
  const explicit = ok(await call('prepare_recipe', t2i({ transparentBackground: false })));
  for (const recipe of [omitted, explicit]) {
    assert.equal(recipe.authored.transparentBackground, false);
    assert.deepEqual(recipe.effective.transparentBackground, { enabled: false, straightAlpha: false, appendedText: null });
    assert.equal(recipe.effective.positivePrompt, 'watercolor, 1girl, garden, very aesthetic, masterpiece, no text');
    assert.equal(recipe.effectiveRequest.parameters.tag_hint_transparent_background, false);
  }
  const stored = recipe => h.service.read_queue_recipe({ recipeId: recipe.recipeId, recipeRevision: recipe.recipeRevision }).then(result => json(result).snapshot.reviewInput.authored);
  assert.deepEqual(await stored(omitted), await stored(explicit));
  assert.equal((await stored(omitted)).params.transparentBackground, false);
  assert.equal((await stored(prepared)).params.transparentBackground, true);
  // Control for "as before": a preparation without the key at all stores the same input and inputHash.
  const legacyPreparation = recipeQueue.t2iPreparation(t2i()); delete legacyPreparation.authored.params.transparentBackground;
  const legacy = json(await h.service.put_queue_recipe({ preparation: legacyPreparation }));
  assert.equal(legacy.inputHash, omitted.inputHash);
  assert.deepEqual(legacy.snapshot.reviewInput.authored, await stored(omitted));

  // The prompt already ends with the text: only the builder's trailing segment is separated.
  const doubled = ok(await call('prepare_recipe', t2i({ transparentBackground: true, positivePrompt: '1girl, garden, transparent background', characters: [] })));
  assert.equal(doubled.effective.positivePrompt, 'watercolor, 1girl, garden, transparent background, very aesthetic, masterpiece, no text, transparent background');
  assert.deepEqual(doubled.effective.automaticQuality, { preset: 'standard', appendedText: 'very aesthetic, masterpiece, no text', derivedFromBuilderOutput: true });
  assert.deepEqual(doubled.warnings, []);

  // Non-V5 models (0.1.4): the option is dropped, as the host would turn it off (client/src/types.ts), and said so.
  for (const model of ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated', 'nai-diffusion-4-full', 'nai-diffusion-3']) {
    const dropped = ok(await call('prepare_recipe', t2i({ model, noiseSchedule: 'native', characters: [], transparentBackground: true })));
    const warning = dropped.warnings.find(item => item.code === 'value_dropped');
    assert.deepEqual([warning.field, warning.from, warning.to], ['transparentBackground', true, false], model);
    assert.match(warning.message, /V5/, model);
    assert.equal(dropped.authored.transparentBackground, false, model); assert.equal(dropped.effective.transparentBackground.enabled, false, model);
    assert.equal(recipeQueue.t2iPreparation(t2i({ model, noiseSchedule: 'native', characters: [], transparentBackground: true })).authored.params.transparentBackground, false, model);
  }
  const before = h.calls.length;
  for (const value of ['true', 1, null]) {
    assert.equal(errorOf(await call('prepare_recipe', t2i({ transparentBackground: value }))).code, 'invalid_arguments', String(value));
    assert.throws(() => recipeQueue.t2iPreparation(t2i({ transparentBackground: value })), error => error instanceof BridgeError && error.code === 'invalid_arguments', `module ${String(value)}`);
  }
  assert.equal(h.calls.length, before, 'no refused preparation reached the host');
  // V4.5 without the option still prepares, with no transparent text.
  const v45 = ok(await call('prepare_recipe', t2i({ model: 'nai-diffusion-4-5-full', noiseSchedule: 'native', characters: [] })));
  assert.deepEqual(v45.effective.transparentBackground, { enabled: false, straightAlpha: false, appendedText: null });

  // A revision rewrites every field: true is kept only when passed again, omitting it goes back to false.
  const revised = ok(await call('prepare_recipe', t2i({ recipeId: omitted.recipeId, expectedRevision: 1, transparentBackground: true })));
  assert.equal(revised.recipeRevision, 2); assert.notEqual(revised.inputHash, omitted.inputHash); assert.equal(revised.effective.transparentBackground.enabled, true);
  const dropped = ok(await call('prepare_recipe', t2i({ recipeId: omitted.recipeId, expectedRevision: 2 })));
  assert.equal(dropped.recipeRevision, 3); assert.equal(dropped.authored.transparentBackground, false); assert.equal(dropped.effective.transparentBackground.enabled, false);
  assert.equal(dropped.inputHash, omitted.inputHash, 'revision 3 has the same input as revision 1');
  // A non-V5 revision asking for it is saved without it.
  const nonV5 = ok(await call('prepare_recipe', t2i({ recipeId: omitted.recipeId, expectedRevision: 3, model: 'nai-diffusion-4-5-full', noiseSchedule: 'native', characters: [], transparentBackground: true })));
  assert.equal(nonV5.recipeRevision, 4); assert.equal(nonV5.authored.transparentBackground, false); assert.ok(nonV5.warnings.some(warning => warning.code === 'value_dropped'));

  // Mixed enqueue: one transparent and one normal recipe; no unexposed-input warning for the option.
  const receipt = ok(await call('enqueue_recipes', { requestKey: 'transparent-1', items: [{ ...ref(prepared), seeds: [11] }, { ...ref(dropped), seeds: [12] }] }));
  assert.equal(receipt.status, 'enqueued'); assert.equal(receipt.warnings, undefined, 'no warnings: the receipt omits the field');
  assert.equal(h.jobs.length, 1);
  // Each frozen execution snapshot carries its own option, and the real payload builder rebuilds the readback request from it.
  const { snapshots } = h.jobs[0].args;
  assert.equal(snapshots?.length, 2, 'different recipes are frozen per item');
  for (const [index, recipe] of [prepared, dropped].entries()) {
    assert.equal(snapshots[index].params.transparentBackground, recipe.authored.transparentBackground, `item ${index}`);
    const request = buildPayload(snapshots[index].params, recipe.effectiveRequest.parameters.seed, snapshots[index].extras);
    assert.equal(request.input, recipe.effectiveRequest.input, `item ${index} input`);
    for (const key of ['tag_hint_transparent_background', 'straight_alpha']) assert.equal(request.parameters[key], recipe.effectiveRequest.parameters[key], `item ${index} ${key}`);
  }

  // The stored-input comparison catches the option flipped either way and a dropped key.
  const flips = [['requested true, stored false', { transparentBackground: true }, params => { params.transparentBackground = false; }],
    ['requested true, key dropped', { transparentBackground: true }, params => { delete params.transparentBackground; }],
    ['requested false, key dropped', {}, params => { delete params.transparentBackground; }]];
  for (const [label, patch, mutate] of flips) {
    h.faults.put_queue_recipe = reply => retamper(reply, snapshot => mutate(snapshot.reviewInput.authored.params));
    const error = errorOf(await call('prepare_recipe', t2i(patch)));
    assert.equal(error.code, 'recipe_input_mismatch', label); assert.deepEqual(error.details.fields, ['params.transparentBackground'], label);
  }
});

test('transparentBackground: a stored transparent recipe that the builder does not send (non-V5, made elsewhere) is flagged', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const v5 = json(await h.service.put_queue_recipe({ preparation: { mode: 't2i', authored: { params: { promptAssemblyVersion: 1, model: 'nai-diffusion-5-full', noiseSchedule: 'karras', positivePrompt: 'x', transparentBackground: true, seed: 5, seedMode: 'fixed' } }, assets: [] } }));
  const v5Read = ok(await readRecipe(ref(v5)));
  assert.deepEqual(v5Read.warnings, [], 'a V5 transparent recipe made elsewhere is no longer an unexposed input');
  assert.equal(v5Read.effective.transparentBackground.enabled, true);
  // The real host normalizer already turns the flag off on V4.5; a tampered stored true shows the warning path.
  const v45 = json(await h.service.put_queue_recipe({ preparation: { mode: 't2i', authored: { params: { promptAssemblyVersion: 1, model: 'nai-diffusion-4-5-full', positivePrompt: 'x', transparentBackground: true } }, assets: [] } }));
  assert.equal(v45.snapshot.reviewInput.authored.params.transparentBackground, false, 'host evidence: V4.5 silently drops the option');
  const flagged = recipeQueue.recipeReadback(retamper(v45, snapshot => { snapshot.reviewInput.authored.params.transparentBackground = true; }));
  assert.deepEqual(flagged.warnings.map(warning => warning.code), ['transparent_background_not_sent']);
  assert.equal(flagged.authored.transparentBackground, true); assert.equal(flagged.effective.transparentBackground.enabled, false);
});

test('prepare_recipe corrects every value the host would otherwise normalize silently, with a warning each; only what cannot run is refused before any host call', async t => {
  const h = await realHost(t);
  // Evidence of the gap: the real host put accepts steps 99 and stores 50, snaps 833 and converts V4.5 "light", silently.
  const direct = await h.service.put_queue_recipe({ preparation: { mode: 't2i', authored: { params: { promptAssemblyVersion: 1, model: 'nai-diffusion-4-5-full', positivePrompt: 'x', steps: 99, width: 833, height: 1216, qualityPreset: 'light' } }, assets: [] } });
  assert.deepEqual([direct.snapshot.reviewInput.authored.params.steps, direct.snapshot.reviewInput.authored.params.width, direct.snapshot.reviewInput.authored.params.qualityPreset], [50, 832, 'standard']);
  h.calls.length = 0;
  const { call, readRecipe } = await connect(t, h.bridge);
  const seven = Array.from({ length: 7 }, (_, index) => ({ prompt: `c${index}`, useCoords: false }));
  // 0.1.4: each of these is corrected to what runs, saved with that value, and reported (code, field, from, to).
  const corrections = [
    ['steps99', t2i({ steps: 99 }), 'value_clamped', 'steps', 99, 50, v => v.effective.steps === 50],
    ['steps0', t2i({ steps: 0 }), 'value_clamped', 'steps', 0, 1, v => v.effective.steps === 1],
    ['steps 27.6', t2i({ steps: 27.6 }), 'value_clamped', 'steps', 27.6, 28, v => v.effective.steps === 28],
    ['1000×1500', t2i({ width: 1000, height: 1500 }), 'size_adjusted', 'width×height', { width: 1000, height: 1500 }, { width: 1024, height: 1472 }, v => v.effective.width === 1024 && v.effective.height === 1472],
    ['width833', t2i({ width: 833 }), 'size_adjusted', 'width×height', { width: 833, height: 1216 }, { width: 832, height: 1216 }, v => v.effective.width === 832],
    ['area', t2i({ width: 2048, height: 2048 }), 'size_adjusted', 'width×height', { width: 2048, height: 2048 }, { width: 1728, height: 1728 }, v => v.effective.width * v.effective.height <= 3_145_728],
    ['cfg11', t2i({ cfgScale: 11 }), 'value_clamped', 'cfgScale', 11, 10, v => v.effective.cfgScale === 10],
    ['rescale2', t2i({ cfgRescale: 2 }), 'value_clamped', 'cfgRescale', 2, 1, v => v.effective.cfgRescale === 1],
    ['ucPreset4', t2i({ ucPreset: 4 }), 'value_clamped', 'ucPreset', 4, 3, v => v.effective.ucPreset.preset === 3],
    ['lightOnV45', t2i({ model: 'nai-diffusion-4-5-full', noiseSchedule: 'native', qualityPreset: 'light' }), 'value_replaced', 'qualityPreset', 'light', 'standard', v => v.authored.qualityPreset === 'standard'],
    ['nativeOnV5', t2i({ noiseSchedule: 'native' }), 'value_replaced', 'noiseSchedule', 'native', 'karras', v => v.effective.noiseSchedule === 'karras'],
    ['charsOnV3', t2i({ model: 'nai-diffusion-3', noiseSchedule: 'native' }), 'value_dropped', 'characters', 1, 0, v => v.authored.characters.length === 0],
    ['sevenOnV45', t2i({ model: 'nai-diffusion-4-5-full', noiseSchedule: 'native', characters: seven }), 'value_dropped', 'characters', 7, 6, v => v.effective.characters.length === 6 && v.authored.characters.at(-1).prompt === 'c5'],
    ['coordsWithoutX', t2i({ characters: [{ prompt: 'a', useCoords: true, y: 0.2 }] }), 'value_defaulted', 'characters[0].x', null, 0.5, v => v.authored.characters[0].x === 0.5 && v.authored.characters[0].y === 0.2],
    ['x2', t2i({ characters: [{ prompt: 'a', useCoords: true, x: 2, y: 0.5 }] }), 'value_clamped', 'characters[0].x', 2, 1, v => v.effective.characters[0].center.x === 1],
    ['seedTooBig', t2i({ seed: 2147483647 }), 'seed_wrapped', 'seed', 2147483647, 0, v => v.effective.seed === 0 && v.effective.seedPolicy === 'fixed'],
    ['seedNegative', t2i({ seed: -1 }), 'seed_random', 'seed', -1, null, v => v.effective.seedPolicy === 'random_on_submit' && v.authored.seed === null],
  ];
  for (const [name, args, code, field, from, to, check] of corrections) {
    const prepared = ok(await call('prepare_recipe', args));
    const warning = prepared.warnings.find(item => item.code === code && item.field === field);
    assert.ok(warning, `${name}: ${JSON.stringify(prepared.warnings)}`);
    assert.deepEqual([warning.from, warning.to], [from, to], name); assert.equal(typeof warning.message, 'string', name);
    assert.ok(check(prepared), `${name}: ${JSON.stringify({ effective: prepared.effective, authored: prepared.authored })}`);
    assert.equal(prepared.ready, true, name);
    // The stored recipe holds the corrected value: its stored readback is the same (only the prepare-time warnings differ).
    const read = ok(await readRecipe(ref(prepared)));
    assert.deepEqual(read.authored, prepared.authored, name); assert.equal(read.inputHash, prepared.inputHash, name);
  }
  // The same correction from the module, without the MCP schema in front of it.
  assert.equal(recipeQueue.t2iPreparation(t2i({ steps: 99 })).authored.params.steps, 50);
  assert.deepEqual(recipeQueue.recipePlan(t2i({ width: 1000, height: 1500 })).size, { width: 1024, height: 1472 });
  // Several corrections at once: one warning each, in field order.
  const many = ok(await call('prepare_recipe', t2i({ steps: 80, cfgScale: -1, noiseSchedule: 'exponential' })));
  assert.deepEqual(many.warnings.map(item => `${item.code}:${item.field}`), ['value_clamped:steps', 'value_clamped:cfgScale', 'value_replaced:noiseSchedule']);
  // An exact recipe carries no correction warning.
  assert.deepEqual(ok(await call('prepare_recipe', t2i())).warnings, []);
  // Still refused: what cannot run or means nothing (missing fields, unknown names, wrong types, fields of no mode).
  const before = h.calls.length;
  const cases = {
    blankPositive: t2i({ positivePrompt: '   ' }), blankCharacter: t2i({ characters: [{ prompt: ' ', useCoords: false }] }), charExtra: t2i({ characters: [{ prompt: 'a', useCoords: false, id: 'x' }] }),
    seedMissing: (({ seed: _s, ...rest }) => rest)(t2i()), modelMissing: (({ model: _m, ...rest }) => rest)(t2i()), widthMissing: (({ width: _w, ...rest }) => rest)(t2i()),
    unknownModel: t2i({ model: 'nai-diffusion-9' }), unknownSampler: t2i({ sampler: 'k_lms' }), unknownSchedule: t2i({ noiseSchedule: 'linear' }), unknownQuality: t2i({ qualityPreset: 'max' }), i2i: t2i({ mode: 'i2i' }),
    samples: t2i({ n_samples: 2 }), count: t2i({ count: 2 }), workspace: t2i({ workspaceId: 'w' }), idWithoutRevision: t2i({ recipeId: randomUUID() }), revisionWithoutId: t2i({ expectedRevision: 1 }),
    longPrompt: t2i({ positivePrompt: 'x'.repeat(12001) }), stringSteps: t2i({ steps: '28' }), fractionalSeed: t2i({ seed: 1.5 }), unknownEffort: t2i({ effort: 'low' }),
  };
  for (const [name, args] of Object.entries(cases)) assert.equal(errorOf(await call('prepare_recipe', args)).code, 'invalid_arguments', name);
  assert.equal(h.calls.length, before, 'no refused preparation reached the host');
  for (const name of ['blankPositive', 'coordsWithoutX', 'samples', 'i2i', 'unknownSampler', 'fractionalSeed'].filter(name => cases[name]))
    assert.throws(() => recipeQueue.t2iPreparation(cases[name]), error => error instanceof BridgeError && error.code === 'invalid_arguments', name);
  // A revision of a non-plain or non-t2i recipe is refused after its read, before any put.
  const blocked = await h.service.put_queue_recipe({ preparation: { mode: 'enhance', authored: { params: { promptAssemblyVersion: 1, positivePrompt: 'x' } }, assets: [] } });
  const callsBefore = h.calls.length;
  const error = errorOf(await call('prepare_recipe', t2i({ recipeId: blocked.recipeId, expectedRevision: 1 })));
  assert.equal(error.code, 'invalid_arguments');
  assert.deepEqual(h.methods().slice(callsBefore), ['read_queue_recipe']);
});

test('prepare_recipe reply checks: unknown save outcome, unexpected identity and a stored-input mismatch are never adopted', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  h.faults.put_queue_recipe = 'reply-lost';
  const unknown = errorOf(await call('prepare_recipe', t2i()));
  assert.equal(unknown.code, 'recipe_save_unknown');
  assert.equal(unknown.details.putOutcome, 'unknown'); assert.equal(unknown.details.generationSubmitted, false);
  assert.equal(h.count('put_queue_recipe'), 1, 'never resent');
  h.faults.put_queue_recipe = reply => ({ ...reply, recipeRevision: 2 });
  assert.equal(errorOf(await call('prepare_recipe', t2i())).code, 'recipe_identity_unconfirmed');
  h.faults.put_queue_recipe = reply => ({ ...reply, inputHash: 'a'.repeat(64) });
  assert.equal(errorOf(await call('prepare_recipe', t2i())).code, 'recipe_identity_unconfirmed');
  // A host that stored something else (here: silently clamped steps) is caught by the authored comparison.
  h.faults.put_queue_recipe = reply => {
    const snapshot = structuredClone(reply.snapshot); snapshot.reviewInput.authored.params.steps = 27;
    const { assets, ...input } = snapshot.reviewInput;
    return { ...reply, snapshot, inputHash: recipeQueue.recipeHash({ ...input, assets: assets.map(({ data: _d, ...asset }) => asset) }) };
  };
  const mismatch = errorOf(await call('prepare_recipe', t2i()));
  assert.equal(mismatch.code, 'recipe_input_mismatch'); assert.deepEqual(mismatch.details.fields, ['params.steps']);
  assert.equal(h.count('enqueue_queue_recipes'), 0);
});

test('recovery guidance without read_recipe: an unknown revision save, an incomplete reply and a stale inputHash point back to prepare_recipe', async t => {
  const h = await realHost(t);
  const { call } = await connect(t, h.bridge);
  const first = ok(await call('prepare_recipe', t2i()));
  // (1) The host saves the revision, but its reply is lost.
  h.faults.put_queue_recipe = 'reply-lost';
  const revision = t2i({ recipeId: first.recipeId, expectedRevision: 1, seed: 77 });
  const unknown = errorOf(await call('prepare_recipe', revision));
  assert.equal(unknown.code, 'recipe_save_unknown'); assert.equal(unknown.details.putOutcome, 'unknown');
  assert.match(unknown.message, /call prepare_recipe once with the same recipeId, expectedRevision and fields: recipe_conflict means the earlier save landed as expectedRevision\+1/);
  delete h.faults.put_queue_recipe;
  // Following that guidance: the identical call reports recipe_conflict without saving again ...
  const conflict = errorOf(await call('prepare_recipe', revision));
  assert.equal(conflict.code, 'recipe_conflict'); assert.equal(conflict.details.saved, false);
  // ... and revising from expectedRevision+1 returns an identity to enqueue.
  const next = ok(await call('prepare_recipe', { ...revision, expectedRevision: 2 }));
  assert.equal(next.recipeId, first.recipeId); assert.equal(next.recipeRevision, 3);
  // (2) An incomplete reply is never adopted.
  h.faults.put_queue_recipe = reply => ({ ...reply, snapshot: null });
  const incomplete = errorOf(await call('prepare_recipe', t2i({ seed: 78 })));
  assert.equal(incomplete.code, 'recipe_identity_unconfirmed');
  assert.match(incomplete.message, /Do not enqueue from it; prepare the recipe again and enqueue only an identity whose readback you checked\./);
  delete h.faults.put_queue_recipe;
  // (3) A stale inputHash is refused before anything is sent.
  const stale = errorOf(await call('enqueue_recipes', { requestKey: 'stale-hash', items: [{ ...ref(next), inputHash: 'c'.repeat(64), seeds: [1] }] }));
  assert.equal(stale.code, 'recipe_changed');
  assert.match(stale.message, /Nothing was sent; prepare or revise the recipe again and enqueue the exact identity it returns\./);
  for (const error of [unknown, incomplete, stale]) assert.doesNotMatch(error.message, /read_recipe/);
  assert.equal(h.count('enqueue_queue_recipes'), 0);
});

test('a leftover required:true review policy file does not gate recipes or enqueues, and is left untouched', async t => {
  const h = await realHost(t);
  const onFile = await policyFile(t, true), onBytes = await readFile(onFile, 'utf8');
  const { call, readRecipe } = await connect(t, h.bridge);
  const prepared = ok(await call('prepare_recipe', t2i()));
  assert.equal(Object.hasOwn(ok(await readRecipe(ref(prepared))), 'review'), false);
  const receipt = ok(await call('enqueue_recipes', { requestKey: 'garden-v1', items: [{ ...ref(prepared), seeds: [11, 22] }] }));
  assert.equal(receipt.status, 'enqueued'); assert.equal(receipt.enqueueSent, true); assert.equal(Object.hasOwn(receipt, 'review'), false);
  assert.equal(receipt.hostRequestKey, recipeQueue.mcpHostRequestKey('garden-v1'));
  assert.equal(receipt.batch.requestKey, receipt.hostRequestKey); assert.equal(receipt.batch.count, 2); assert.equal(receipt.batch.execution, 'queued');
  assert.deepEqual(receipt.items.map(item => item.seed), [11, 22]);
  assert.deepEqual(h.jobs.map(entry => entry.args.seeds), [[11, 22]]);
  assert.deepEqual(h.methods(), ['put_queue_recipe', 'read_queue_recipe', 'lookup_queue_request', 'read_queue_recipe', 'enqueue_queue_recipes']);
  assert.equal(h.jobs.length, 1);
  assert.equal(await readFile(onFile, 'utf8'), onBytes, 'the policy file is neither read into a gate nor rewritten');
});

test('idempotency: one requestKey never produces a second host enqueue, across repeats, concurrency and a server restart', async t => {
  const h = await realHost(t);
  const first = await connect(t, h.bridge);
  const prepared = ok(await first.call('prepare_recipe', t2i({ seed: null })));
  const args = { requestKey: 'night-market #3', intervalSeconds: 2, items: [{ ...ref(prepared), count: 3 }] };
  const accepted = ok(await first.call('enqueue_recipes', args));
  assert.equal(accepted.status, 'enqueued'); assert.equal(accepted.count, 3); assert.equal(accepted.intervalSeconds, 2);
  assert.deepEqual(accepted.items.map(item => item.seed), [null, null, null], 'random-seed recipe without explicit seeds keeps its policy');
  const again = ok(await first.call('enqueue_recipes', args));
  assert.equal(again.status, 'already_enqueued'); assert.equal(again.enqueueSent, false); assert.equal(again.batch.batchId, accepted.batch.batchId);
  // Restart: a new server process has no memory; the stable namespaced key and the host receipt still dedupe.
  const restarted = await connect(t, h.bridge);
  const afterRestart = ok(await restarted.call('enqueue_recipes', args));
  assert.equal(afterRestart.status, 'already_enqueued'); assert.equal(afterRestart.batch.batchId, accepted.batch.batchId);
  assert.equal(ok(await restarted.call('lookup_enqueue', { requestKey: args.requestKey })).status, 'enqueued');
  // Same key, different plan: conflict, nothing sent.
  const conflict = errorOf(await restarted.call('enqueue_recipes', { ...args, items: [{ ...ref(prepared), seeds: [1, 2, 3] }] }));
  assert.equal(conflict.code, 'request_conflict'); assert.equal(conflict.details.enqueueSent, false); assert.equal(conflict.details.existingBatch.batchId, accepted.batch.batchId);
  assert.equal(h.count('enqueue_queue_recipes'), 1); assert.equal(h.jobs.length, 1);
  // Concurrent duplicates inside one process: exactly one dispatch.
  const parallel = { requestKey: 'parallel', items: [{ ...ref(prepared), seeds: [5] }] };
  const results = await Promise.all([first.call('enqueue_recipes', parallel), first.call('enqueue_recipes', parallel), first.call('enqueue_recipes', parallel)]);
  assert.deepEqual(results.map(result => ok(result).status).sort(), ['already_enqueued', 'already_enqueued', 'enqueued']);
  assert.equal(h.count('enqueue_queue_recipes'), 2); assert.equal(h.jobs.length, 2);
  // Namespacing is server-owned: stable, bounded, hashed, never a tool argument.
  const key = recipeQueue.mcpHostRequestKey('parallel');
  assert.equal(key, recipeQueue.mcpHostRequestKey('parallel')); assert.match(key, /^mcp-[a-f0-9]{24}-[a-f0-9]{64}$/); assert.ok(key.length <= 120);
  assert.notEqual(recipeQueue.mcpHostRequestKey(key), key, 'a key that imitates a host key is hashed again');
  assert.match(recipeQueue.mcpHostRequestKey(key), /^mcp-[a-f0-9]{24}-[a-f0-9]{64}$/);
  assert.match(recipeQueue.mcpHostRequestKey('other-0123456789abcdef01234567-' + 'a'.repeat(64)), /^mcp-[a-f0-9]{24}-/);
  for (const extra of [{ dispatchScope: 'other-scope' }, { scope: 'x' }, { sessionId: 's' }, { hostRequestKey: key }])
    assert.equal(errorOf(await first.call('enqueue_recipes', { ...parallel, ...extra })).code, 'invalid_arguments');
});

nodeTest('N5: two server instances (two sessions) share one idempotency namespace, so one requestKey yields one batch whichever enqueues first', async t => {
  const h = await realHost(t);
  // Each server has its own recipe queue (own unknown-outcome hold and settle clock), like a second agent session.
  const [first, second] = [await connect(t, h.bridge), await connect(t, h.bridge)];
  const prepared = ok(await first.call('prepare_recipe', t2i({ seed: null })));
  for (const [a, b, requestKey] of [[first, second, 'n5 first session first'], [second, first, 'n5 second session first']]) {
    const args = { requestKey, items: [{ ...ref(prepared), count: 2 }] };
    const accepted = ok(await a.call('enqueue_recipes', args));
    assert.equal(accepted.status, 'enqueued');
    assert.equal(accepted.hostRequestKey, recipeQueue.mcpHostRequestKey(requestKey));
    const again = ok(await b.call('enqueue_recipes', args));
    assert.equal(again.status, 'already_enqueued'); assert.equal(again.enqueueSent, false); assert.equal(again.batch.batchId, accepted.batch.batchId);
    assert.equal(ok(await b.call('lookup_enqueue', { requestKey })).batch.batchId, accepted.batch.batchId);
    assert.equal(h.jobs.filter(entry => entry.job.requestKey === recipeQueue.mcpHostRequestKey(requestKey)).length, 1);
  }
  assert.equal(h.count('enqueue_queue_recipes'), 2); assert.equal(h.jobs.length, 2);
});

nodeTest('the namespaced host key is identical in separate processes, so a restarted MCP server reuses the same host receipt', () => {
  const script = `const m = await import(${JSON.stringify(new URL('../src/recipe-queue.mjs', import.meta.url).href)}); process.stdout.write(m.mcpHostRequestKey('night-market #3'));`;
  const env = { PATH: process.env.PATH ?? '', NOVELAI_TAG_QUERY_CACHE_DIR: tagCacheDir };
  const [a, b] = [0, 1].map(() => execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8', env }));
  assert.equal(a, b);
  assert.equal(a, recipeQueue.mcpHostRequestKey('night-market #3'));
});

/** A fault that stays until the returned stop(): every call of `method` runs `fault` before (or instead of) the host. */
const persistently = (h, method, fault) => {
  // This harness calls before() without arguments; the call it runs for is the last one recorded.
  const wrap = { before: async args => { h.faults[method] = wrap; await fault(args ?? h.calls.at(-1)?.args); } };
  h.faults[method] = wrap;
  return () => { delete h.faults[method]; };
};
const timeout = () => { throw new BridgeError('timeout', 'The client request was interrupted or timed out. Its outcome is unknown.'); };

test('0.1.4 an unknown enqueue outcome is settled in the same call: a lookup, and the same plan under the same key again when the host holds nothing; one batch, never another key', async t => {
  const h = await realHost(t);
  const { call } = await connect(t, h.bridge);
  const prepared = ok(await call('prepare_recipe', t2i()));
  // (a) The host accepted but the reply was lost: the first lookup finds the batch.
  h.faults.enqueue_queue_recipes = 'reply-lost';
  const lostReply = ok(await call('enqueue_recipes', { requestKey: 'lost-reply', items: [{ ...ref(prepared), seeds: [1] }] }));
  assert.equal(lostReply.status, 'enqueued'); assert.equal(lostReply.reconciled, true); assert.equal(lostReply.enqueueSent, true);
  assert.deepEqual([lostReply.settled.lookups, lostReply.settled.resends], [1, 0]); assert.equal(lostReply.batch.batchId, h.jobs[0].job.batchId);
  assert.match(lostReply.instruction, /there is one batch/); assert.deepEqual(lostReply.items.map(item => item.seed), [1]);
  assert.equal(h.count('enqueue_queue_recipes'), 1);
  assert.equal(ok(await call('enqueue_recipes', { requestKey: 'lost-reply', items: [{ ...ref(prepared), seeds: [1] }] })).status, 'already_enqueued');
  // (b) The request never reached the host: the lookup says nothing arrived and nothing is in flight, so the same plan
  //     goes again under the same key.
  h.faults.enqueue_queue_recipes = 'lost-before-host';
  const lostRequest = ok(await call('enqueue_recipes', { requestKey: 'lost-request', items: [{ ...ref(prepared), seeds: [2] }] }));
  assert.equal(lostRequest.status, 'enqueued'); assert.deepEqual([lostRequest.settled.lookups, lostRequest.settled.resends], [1, 1]);
  assert.equal(h.count('enqueue_queue_recipes'), 3); assert.equal(h.jobs.length, 2);
  // (c) The host's own batch service failed without an answer (its queue readable, no batch): the host keeps the
  //     receipt unknown and restartable, and the same plan under the same key starts it over.
  h.backend.failNext = new Error('backend connection dropped');
  const hostUnknown = ok(await call('enqueue_recipes', { requestKey: 'host-unknown', items: [{ ...ref(prepared), seeds: [3] }] }));
  assert.equal(hostUnknown.status, 'enqueued'); assert.equal(hostUnknown.settled.resends, 1); assert.equal(h.jobs.length, 3);
  // (d) A reply that cannot confirm the plan is settled by the lookup that sees the real batch.
  h.faults.enqueue_queue_recipes = reply => ({ ...reply, recipePlanHash: 'b'.repeat(64) });
  const odd = ok(await call('enqueue_recipes', { requestKey: 'odd-reply', items: [{ ...ref(prepared), seeds: [4] }] }));
  assert.equal(odd.status, 'enqueued'); assert.equal(odd.reconciled, true); assert.equal(odd.settled.resends, 0); assert.equal(h.jobs.length, 4);
  // (e) An explicit host rejection is final for that key and reported as such, without settling.
  h.backend.failNext = Object.assign(new Error('queue is full'), { code: 'queue_full' });
  const full = errorOf(await call('enqueue_recipes', { requestKey: 'full', items: [{ ...ref(prepared), seeds: [5] }] }));
  assert.equal(full.code, 'queue_full'); assert.equal(full.details.status, 'rejected'); assert.equal(full.details.keyStatus, 'rejected'); assert.equal(full.details.settled, undefined);
  assert.match(full.message, /recorded the rejection; nothing was queued under this requestKey/);
  const fullLookup = ok(await call('lookup_enqueue', { requestKey: 'full' }));
  assert.equal(fullLookup.status, 'rejected'); assert.equal(fullLookup.hostError.code, 'queue_full');
  assert.equal(errorOf(await call('enqueue_recipes', { requestKey: 'full', items: [{ ...ref(prepared), seeds: [5] }] })).code, 'queue_request_rejected');
  const enqueueCalls = h.count('enqueue_queue_recipes');
  assert.equal(enqueueCalls, 7, 'one dispatch each, plus one resend for (b) and (c)');
  assert.equal(ok(await call('lookup_enqueue', { requestKey: 'never-used' })).status, 'not_found');
  // (f) The idempotency lookup itself fails: nothing is sent.
  h.faults.lookup_queue_request = 'lost-before-host';
  const lookupDown = errorOf(await call('enqueue_recipes', { requestKey: 'lookup-down', items: [{ ...ref(prepared), seeds: [6] }] }));
  assert.equal(lookupDown.code, 'timeout'); assert.equal(lookupDown.details.enqueueSent, false); assert.equal(lookupDown.details.status, 'not_sent');
  assert.equal(h.count('enqueue_queue_recipes'), enqueueCalls, 'lookups never enqueue');
  // (g) A client that never answers: the call ends after the settle budget with the outcome still unknown, having
  //     resent the same plan at most SETTLE_RESENDS times and never under another key.
  const stopEnqueue = persistently(h, 'enqueue_queue_recipes', timeout), stopLookup = persistently(h, 'lookup_queue_request', async args => { if (h.calls.filter(item => item.method === 'lookup_queue_request' && item.args.requestKey === args.requestKey).length > 1) timeout(); });
  const silent = errorOf(await call('enqueue_recipes', { requestKey: 'silent', items: [{ ...ref(prepared), seeds: [7] }] }));
  stopEnqueue(); stopLookup();
  assert.equal(silent.code, 'queue_acceptance_unknown', JSON.stringify(silent)); assert.equal(silent.details.status, 'unknown'); assert.equal(silent.details.enqueueSent, true); assert.equal(silent.details.newKeyAdvised, false);
  assert.equal(silent.details.keyStatus, 'lookup_failed'); assert.equal(silent.details.settled.resends, 0, 'no lookup ever said the host holds nothing');
  assert.ok(silent.details.settled.seconds >= recipeQueue.SETTLE_BUDGET_MS / 1000 - 1 && silent.details.settled.seconds <= recipeQueue.SETTLE_BUDGET_MS / 1000 + 6, JSON.stringify(silent.details.settled));
  assert.match(silent.message, /call enqueue_recipes with the same requestKey and plan/); assert.match(silent.message, /Do not switch keys/);
  const keys = new Set(h.calls.filter(item => item.method === 'enqueue_queue_recipes').map(item => item.args.requestKey));
  assert.equal(keys.size, 6, 'every dispatch and resend used its own call\'s key');
  // Asking again once the client answers settles it: nothing arrived, so this call sends it.
  assert.equal(ok(await call('enqueue_recipes', { requestKey: 'silent', items: [{ ...ref(prepared), seeds: [7] }] })).status, 'enqueued');
  assert.equal(h.jobs.length, 5);
});

test('0.1.4 an enqueue that never gets an answer and whose lookups say nothing arrived is resent at most SETTLE_RESENDS times', async t => {
  const h = await realHost(t);
  const { call } = await connect(t, h.bridge);
  const prepared = ok(await call('prepare_recipe', t2i()));
  const stop = persistently(h, 'enqueue_queue_recipes', timeout);
  const error = errorOf(await call('enqueue_recipes', { requestKey: 'never-arrives', items: [{ ...ref(prepared), seeds: [1] }] }));
  stop();
  assert.equal(error.code, 'queue_acceptance_unknown'); assert.equal(error.details.keyStatus, 'not_found'); assert.equal(error.details.hostCode, 'timeout');
  assert.equal(error.details.settled.resends, recipeQueue.SETTLE_RESENDS);
  assert.equal(h.count('enqueue_queue_recipes'), 1 + recipeQueue.SETTLE_RESENDS); assert.equal(h.jobs.length, 0);
  assert.equal(ok(await call('lookup_enqueue', { requestKey: 'never-arrives' })).settlement.state, 'clear');
});

test('step 3a: an enqueue above the client per-enqueue setting is a definite refusal naming the limit; the same plan and key work once it is raised', async t => {
  let limit = 2;
  const h = await realHost(t, { enqueueItemLimit: () => limit });
  const { call } = await connect(t, h.bridge);
  const prepared = ok(await call('prepare_recipe', t2i()));
  const plan = { requestKey: 'over-the-setting', items: [{ ...ref(prepared), seeds: [1, 2, 3] }] };
  const refused = errorOf(await call('enqueue_recipes', plan));
  assert.equal(refused.code, 'enqueue_limit_exceeded');
  assert.match(refused.message, /at most 2 per enqueue/);
  assert.deepEqual(refused.details.hostDetails, { requestedItems: 3, maxItemsPerEnqueue: 2 });
  assert.equal(refused.details.status, 'rejected'); assert.equal(refused.details.keyStatus, 'not_found');
  assert.equal(h.jobs.length, 0, 'nothing was queued');
  limit = 3;
  const accepted = ok(await call('enqueue_recipes', plan));
  assert.equal(accepted.status, 'enqueued'); assert.equal(accepted.batch.count, 3); assert.equal(h.jobs.length, 1);
  // The schema takes up to 200 images in one call; the host decides with its setting.
  const big = errorOf(await call('enqueue_recipes', { requestKey: 'two-hundred', items: [{ ...ref(prepared), count: 200, seeds: Array.from({ length: 200 }, (_, index) => index + 1) }] }));
  assert.equal(big.code, 'enqueue_limit_exceeded'); assert.deepEqual(big.details.hostDetails, { requestedItems: 200, maxItemsPerEnqueue: 3 });
});

test('#14 the host\'s structured error details travel under details.hostDetails and never replace this server\'s own fields', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const prepared = ok(await call('prepare_recipe', t2i()));
  const hostFails = (method, code, details) => { h.faults[method] = { before: () => { throw new BridgeError(code, `${code} from the host`, details); } }; };
  // (a) A real host refusal before the receipt: queue_full with its admission facts. A host detail named like one of
  //     this server's own fields stays inside hostDetails.
  h.backend.queueAdmission = () => ({ pendingItems: 200, pendingItemLimit: 200 });
  const full = errorOf(await call('enqueue_recipes', { requestKey: 'host-details-full', items: [{ ...ref(prepared), seeds: [1] }] }));
  assert.equal(full.code, 'queue_full');
  assert.deepEqual(full.details.hostDetails, { pendingItems: 200, pendingItemLimit: 200 });
  assert.equal(full.details.status, 'rejected'); assert.equal(full.details.keyStatus, 'not_found'); assert.equal(full.details.enqueueSent, true); assert.equal(full.details.hostCode, 'queue_full');
  delete h.backend.queueAdmission;
  hostFails('enqueue_queue_recipes', 'queue_full', { status: 'enqueued', keyStatus: 'accepted', enqueueSent: false, pendingItems: 3 });
  const spoof = errorOf(await call('enqueue_recipes', { requestKey: 'host-details-spoof', items: [{ ...ref(prepared), seeds: [2] }] }));
  assert.equal(spoof.details.status, 'rejected'); assert.equal(spoof.details.keyStatus, 'not_found'); assert.equal(spoof.details.enqueueSent, true);
  assert.deepEqual(spoof.details.hostDetails, { status: 'enqueued', keyStatus: 'accepted', enqueueSent: false, pendingItems: 3 });
  // (b) An unrecognized dispatch failure is settled (the same plan again); while the host keeps failing that way the
  //     outcome stays unknown, and the first failure's host details are kept.
  const stop = persistently(h, 'enqueue_queue_recipes', () => { throw new BridgeError('odd_failure', 'odd_failure from the host', { stage: 'dispatch' }); });
  const unknown = errorOf(await call('enqueue_recipes', { requestKey: 'host-details-unknown', items: [{ ...ref(prepared), seeds: [3] }] }));
  stop();
  assert.equal(unknown.code, 'queue_acceptance_unknown'); assert.equal(unknown.details.hostCode, 'odd_failure'); assert.deepEqual(unknown.details.hostDetails, { stage: 'dispatch' }); assert.equal(unknown.details.status, 'unknown');
  // (c) The idempotency lookup and the exact recipe read fail with details: nothing is sent, details kept.
  hostFails('lookup_queue_request', 'queue_storage_error', { frozenQueue: { state: 'failed' } });
  const lookupDown = errorOf(await call('enqueue_recipes', { requestKey: 'host-details-lookup', items: [{ ...ref(prepared), seeds: [4] }] }));
  assert.equal(lookupDown.code, 'queue_storage_error'); assert.equal(lookupDown.details.status, 'not_sent'); assert.deepEqual(lookupDown.details.hostDetails, { frozenQueue: { state: 'failed' } });
  hostFails('read_queue_recipe', 'recipe_source_unavailable', { recipeId: prepared.recipeId, recipeRevision: 1, readerCode: 'library_not_found' });
  const readDown = errorOf(await call('enqueue_recipes', { requestKey: 'host-details-read', items: [{ ...ref(prepared), seeds: [5] }] }));
  assert.equal(readDown.code, 'recipe_source_unavailable'); assert.equal(readDown.details.status, 'not_sent'); assert.equal(readDown.details.enqueueSent, false);
  assert.deepEqual(readDown.details.hostDetails, { recipeId: prepared.recipeId, recipeRevision: 1, readerCode: 'library_not_found' });
  // (d) lookup_enqueue failures keep them as well.
  hostFails('lookup_queue_request', 'queue_storage_error', { frozenQueue: { state: 'failed' } });
  const lookupTool = errorOf(await call('lookup_enqueue', { requestKey: 'host-details-full' }));
  assert.equal(lookupTool.details.status, 'lookup_failed'); assert.deepEqual(lookupTool.details.hostDetails, { frozenQueue: { state: 'failed' } });
  // (e) A refused recipe save keeps the host's details; an unknown save keeps them too.
  hostFails('put_queue_recipe', 'queue_storage_failed', { recipeStore: { bytes: 10, byteLimit: 10 } });
  const putRefused = errorOf(await call('prepare_recipe', t2i({ seed: 9 })));
  assert.equal(putRefused.code, 'queue_storage_failed'); assert.equal(putRefused.details.saved, false); assert.equal(putRefused.details.putOutcome, 'rejected');
  assert.deepEqual(putRefused.details.hostDetails, { recipeStore: { bytes: 10, byteLimit: 10 } });
  hostFails('put_queue_recipe', 'odd_failure', { stage: 'put' });
  const putUnknown = errorOf(await call('prepare_recipe', t2i({ seed: 10 })));
  assert.equal(putUnknown.code, 'recipe_save_unknown'); assert.equal(putUnknown.details.putOutcome, 'unknown'); assert.deepEqual(putUnknown.details.hostDetails, { stage: 'put' });
  // Without host details there is no hostDetails key at all.
  hostFails('lookup_queue_request', 'timeout', undefined);
  assert.equal(Object.hasOwn(errorOf(await call('lookup_enqueue', { requestKey: 'host-details-none' })).details ?? {}, 'hostDetails'), false);
  assert.equal(h.jobs.length, 0, 'nothing was queued');
});

test('exact identity: a revision or inputHash mismatch, a blocked recipe or mixed modes are refused before anything is sent', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const prepared = ok(await call('prepare_recipe', t2i()));
  const refused = async (args, code) => {
    const before = h.count('enqueue_queue_recipes');
    const error = errorOf(await call('enqueue_recipes', args));
    assert.equal(error.code, code, JSON.stringify(error));
    assert.equal(h.count('enqueue_queue_recipes'), before, `${code}: nothing sent`);
    return error;
  };
  const wrongHash = await refused({ requestKey: 'exact', items: [{ ...ref(prepared), inputHash: 'c'.repeat(64) }] }, 'recipe_changed');
  assert.equal(wrongHash.details.enqueueSent, false);
  // A missing recipe revision is the host's explicit recipe_not_found (since 2026-11-02: a canvas capture can be reclaimed).
  for (const missing of [{ recipeRevision: 2 }, { recipeId: randomUUID() }]) {
    const error = await refused({ requestKey: 'exact', items: [{ ...ref(prepared), ...missing }] }, 'recipe_not_found');
    assert.equal(error.details.status, 'not_sent'); assert.match(error.message, /does not exist/);
  }
  // A blocked recipe (blank positive prompt, created directly on the host) reads back as not ready and is refused.
  const blocked = await h.service.put_queue_recipe({ preparation: { mode: 't2i', authored: { params: { promptAssemblyVersion: 1, positivePrompt: '' } }, assets: [] } });
  const blockedRead = ok(await readRecipe(ref(blocked)));
  assert.equal(blockedRead.ready, false); assert.equal(blockedRead.effective, null); assert.equal(blockedRead.readiness.issues[0].code, 'invalid_configuration');
  await refused({ requestKey: 'exact', items: [{ ...ref(blocked), seeds: [1] }] }, 'recipe_blocked');
  // Mixed modes: a reply presenting the second recipe as i2i (hash recomputed, so only the mode differs).
  const other = ok(await call('prepare_recipe', t2i({ positivePrompt: 'other' })));
  const bridge = { async call(method, args, signal) {
    const result = await h.bridge.call(method, args, signal);
    if (method !== 'read_queue_recipe' || args.recipeId !== other.recipeId) return result;
    const snapshot = structuredClone(result.snapshot); snapshot.mode = 'i2i'; snapshot.reviewInput.mode = 'i2i';
    const { assets, ...input } = snapshot.reviewInput;
    return { ...result, snapshot, inputHash: recipeQueue.recipeHash({ ...input, assets: assets.map(({ data: _d, ...asset }) => asset) }) };
  } };
  const mixed = await connect(t, bridge);
  const otherHash = recipeQueue.validateRecipeResult(await bridge.call('read_queue_recipe', { recipeId: other.recipeId, recipeRevision: 1 })).inputHash;
  const before = h.count('enqueue_queue_recipes');
  assert.equal(errorOf(await mixed.call('enqueue_recipes', { requestKey: 'exact', items: [{ ...ref(prepared), seeds: [1] }, { ...ref(other), inputHash: otherHash, seeds: [2] }] })).code, 'invalid_arguments');
  assert.equal(h.count('enqueue_queue_recipes'), before);
  // None of the refusals consumed the key: it is still unused and works for the correct plan.
  assert.equal(ok(await call('lookup_enqueue', { requestKey: 'exact' })).status, 'not_found');
  assert.equal(ok(await call('enqueue_recipes', { requestKey: 'exact', items: [{ ...ref(prepared), count: 2, seeds: [7, 7] }] })).status, 'enqueued', 'a deliberate repeated seed is allowed when explicit');
});

test('0.1.4 a fixed-seed recipe used for several images without seeds counts its seed up (wrapping after 2147483646), listed in the receipt with a warning; explicit seeds are kept', async t => {
  const h = await realHost(t);
  const { call } = await connect(t, h.bridge);
  const prepared = ok(await call('prepare_recipe', t2i()));
  const three = ok(await call('enqueue_recipes', { requestKey: 'fixed-3', items: [{ ...ref(prepared), count: 3 }] }));
  assert.equal(three.status, 'enqueued'); assert.deepEqual(three.items.map(item => item.seed), [1234, 1235, 1236]);
  assert.deepEqual(h.jobs.at(-1).args.seeds, [1234, 1235, 1236], 'the host gets the seeds as explicit item seeds');
  const warning = three.warnings.find(item => item.code === 'fixed_seed_incremented');
  assert.deepEqual([warning.recipeId, warning.recipeRevision, warning.field, warning.from, warning.to], [prepared.recipeId, 1, 'seeds', 1234, [1234, 1235, 1236]]);
  assert.match(warning.message, /use 1234, 1235, 1236 so that they differ/);
  // The same call is the same plan: answered from the receipt, nothing sent again.
  assert.equal(ok(await call('enqueue_recipes', { requestKey: 'fixed-3', items: [{ ...ref(prepared), count: 3 }] })).status, 'already_enqueued');
  assert.equal(errorOf(await call('enqueue_recipes', { requestKey: 'fixed-3', items: [{ ...ref(prepared), count: 2 }] })).code, 'request_conflict');
  // Explicit seeds stay as given; the unseeded images count up from the recipe seed in order.
  const mixed = ok(await call('enqueue_recipes', { requestKey: 'fixed-mixed', items: [{ ...ref(prepared), seeds: [5] }, { ...ref(prepared), count: 2 }] }));
  assert.deepEqual(mixed.items.map(item => item.seed), [5, 1234, 1235]);
  // At the top of the range the seeds wrap to 0.
  const top = ok(await call('prepare_recipe', t2i({ seed: 2147483645 })));
  assert.deepEqual(ok(await call('enqueue_recipes', { requestKey: 'fixed-top', items: [{ ...ref(top), count: 3 }] })).items.map(item => item.seed), [2147483645, 2147483646, 0]);
  // One image, explicit seeds and random-seed recipes are as before, without the warning.
  const one = ok(await call('enqueue_recipes', { requestKey: 'fixed-1', items: [ref(prepared)] }));
  assert.deepEqual(one.items.map(item => item.seed), [null]); assert.equal(one.warnings, undefined);
  const explicit = ok(await call('enqueue_recipes', { requestKey: 'fixed-explicit', items: [{ ...ref(prepared), seeds: [7, 7] }] }));
  assert.deepEqual(explicit.items.map(item => item.seed), [7, 7]); assert.equal(explicit.warnings, undefined);
  const random = ok(await call('prepare_recipe', t2i({ seed: null })));
  const randoms = ok(await call('enqueue_recipes', { requestKey: 'random-3', items: [{ ...ref(random), count: 3 }] }));
  assert.deepEqual(randoms.items.map(item => item.seed), [null, null, null]); assert.equal(randoms.warnings, undefined);
  assert.deepEqual(h.jobs.at(-1).args.seeds, [777, 777, 777], 'random seeds are the host\'s to draw');
});

test('invalid enqueue, lookup and read arguments are rejected before the host', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const good = { recipeId: randomUUID(), recipeRevision: 1, inputHash: 'd'.repeat(64) };
  const enqueueCases = {
    noKey: { items: [good] }, emptyKey: { requestKey: '', items: [good] }, blankKey: { requestKey: '   ', items: [good] }, longKey: { requestKey: 'k'.repeat(121), items: [good] }, controlKey: { requestKey: 'a\nb', items: [good] },
    noItems: { requestKey: 'k', items: [] }, tooManyItems: { requestKey: 'k', items: Array.from({ length: 201 }, () => good) }, expandedTooMany: { requestKey: 'k', items: [{ ...good, count: 200 }, { ...good, count: 1, seeds: [1] }] },
    count0: { requestKey: 'k', items: [{ ...good, count: 0 }] }, count201: { requestKey: 'k', items: [{ ...good, count: 201 }] }, seedsMismatch: { requestKey: 'k', items: [{ ...good, count: 2, seeds: [1] }] },
    seedTooBig: { requestKey: 'k', items: [{ ...good, seeds: [2147483647] }] }, seedFloat: { requestKey: 'k', items: [{ ...good, seeds: [1.5] }] }, noHash: { requestKey: 'k', items: [{ recipeId: good.recipeId, recipeRevision: 1 }] },
    badHash: { requestKey: 'k', items: [{ ...good, inputHash: 'D'.repeat(64) }] }, badId: { requestKey: 'k', items: [{ ...good, recipeId: 'x' }] }, revision0: { requestKey: 'k', items: [{ ...good, recipeRevision: 0 }] },
    reviewId: { requestKey: 'k', items: [{ ...good, reviewId: randomUUID() }] }, interval61: { requestKey: 'k', intervalSeconds: 61, items: [good] }, intervalNegative: { requestKey: 'k', intervalSeconds: -1, items: [good] },
    twoHashes: { requestKey: 'k', items: [{ ...good, seeds: [1] }, { ...good, inputHash: 'e'.repeat(64), seeds: [2] }] }, nSamples: { requestKey: 'k', n_samples: 2, items: [good] },
  };
  for (const [name, args] of Object.entries(enqueueCases)) assert.equal(errorOf(await call('enqueue_recipes', args)).code, 'invalid_arguments', name);
  for (const args of [{}, { requestKey: '' }, { requestKey: 'k', batchId: randomUUID() }]) assert.equal(errorOf(await call('lookup_enqueue', args)).code, 'invalid_arguments');
  for (const args of [{}, { recipeId: 'x', recipeRevision: 1 }, { recipeId: good.recipeId }, { ...good, inputHash: 'x' }, { ...good, workspaceId: 'w' }]) assert.equal(errorOf(await readRecipe(args)).code, 'invalid_arguments');
  assert.deepEqual(h.calls, []);
  // The module enforces the expansion rules without the schema in front of it.
  for (const name of ['expandedTooMany', 'seedsMismatch', 'twoHashes', 'reviewId', 'blankKey'])
    assert.throws(() => recipeQueue.normalizeEnqueue(enqueueCases[name]), error => error instanceof BridgeError && error.code === 'invalid_arguments', name);
});

nodeTest('host reply validation accepts the real snapshot and rejects every tampered one', async t => {
  const h = await realHost(t);
  const recipe = json(await h.service.put_queue_recipe({ preparation: { mode: 't2i', authored: { params: { promptAssemblyVersion: 1, positivePrompt: 'x' } }, assets: [] } }));
  const identity = { recipeId: recipe.recipeId, recipeRevision: recipe.recipeRevision };
  const tampered = {
    real: recipe, hash: { ...recipe, inputHash: 'a'.repeat(64) }, revision: { ...recipe, recipeRevision: 2 }, workspace: { ...recipe, snapshot: { ...recipe.snapshot, workspaceId: 'recipe:00000000-0000-0000-0000-000000000000' } },
    draft: { ...recipe, snapshot: { ...recipe.snapshot, draftId: 'd' } }, mode: { ...recipe, snapshot: { ...recipe.snapshot, mode: 'upscale' } },
    prompt: { ...recipe, snapshot: { ...recipe.snapshot, reviewInput: { ...recipe.snapshot.reviewInput, authored: { ...recipe.snapshot.reviewInput.authored, params: { ...recipe.snapshot.reviewInput.authored.params, positivePrompt: 'y' } } } } },
  };
  for (const [name, value] of Object.entries(tampered)) {
    let accepted = true;
    try { recipeQueue.validateRecipeResult(structuredClone(value), identity); } catch (error) { accepted = false; assert.ok(error instanceof BridgeError); }
    assert.equal(accepted, name === 'real', name);
  }
  // Canonical JSON: sorted keys, undefined members dropped, array order kept (the host's recipeHash uses the same form).
  assert.equal(recipeQueue.recipeHash({ b: 1, a: [2, { d: undefined, c: 3 }] }), createHash('sha256').update('{"a":[2,{"c":3}],"b":1}').digest('hex'));
});

nodeTest('client constant parity: models, samplers and dimension limits mirror client/src/types.ts and nai-dimensions.ts', async () => {
  const types = await readFile(join(root, 'client/src/types.ts'), 'utf8');
  const block = name => types.slice(types.indexOf(`export const ${name} = [`), types.indexOf('] as const;', types.indexOf(`export const ${name} = [`)));
  const values = source => [...source.matchAll(/value: "([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(values(block('NAI_MODELS')), [...recipeQueue.T2I_MODELS]);
  assert.deepEqual(values(block('NAI_SAMPLERS')), [...recipeQueue.T2I_SAMPLERS]);
  assert.match(types, /const SUPPORTED_NOISE_SCHEDULES = new Set\(\["native", "karras", "exponential"\]\)/);
  const dimensions = await readFile(join(root, 'client/src/nai-dimensions.ts'), 'utf8');
  assert.match(dimensions, /export const NAI_MAX_PIXEL_AREA = 3_145_728;/);
  assert.equal(recipeQueue.MAX_PIXEL_AREA, 3_145_728);
  const service = await readFile(join(root, 'client/electron/queue-recipe-service.ts'), 'utf8');
  assert.match(service, /const validSeed = \(value: any\) => Number\.isSafeInteger\(value\) && value >= 0 && value <= 2147483646;/);
  assert.equal(recipeQueue.MAX_QUEUE_SEED, 2147483646);
});

test('F1: a request held on the way is settled by sending the same plan again; the late original is answered from the receipt (one batch); a request_conflict after dispatch attaches the batch under the key', async t => {
  const h = await realHost(t);
  const { call } = await connect(t, h.bridge);
  const prepared = ok(await call('prepare_recipe', t2i()));
  h.faults.enqueue_queue_recipes = 'held';
  const first = ok(await call('enqueue_recipes', { requestKey: 'late2', items: [{ ...ref(prepared), seeds: [1] }] }));
  assert.equal(first.status, 'enqueued'); assert.equal(first.reconciled, true); assert.deepEqual([first.settled.lookups, first.settled.resends], [1, 1]);
  const [late] = await h.releaseHeld();
  assert.equal(late.batchId, first.batch.batchId, 'the late original is answered from the key\'s receipt'); assert.equal(h.jobs.length, 1);
  // Another plan under a key reaches the host just before ours: request_conflict with the batch already under the key.
  h.faults.enqueue_queue_recipes = { before: async () => { await h.service.enqueue_queue_recipes({ requestKey: recipeQueue.mcpHostRequestKey('late3'), items: [{ ...ref(prepared), seed: 9 }], intervalSeconds: 0 }); } };
  const second = errorOf(await call('enqueue_recipes', { requestKey: 'late3', items: [{ ...ref(prepared), seeds: [1, 2] }] }));
  assert.equal(second.code, 'request_conflict'); assert.equal(second.details.status, 'conflict'); assert.equal(second.details.enqueueSent, true); assert.equal(second.details.hostCode, 'request_conflict');
  assert.equal(second.details.existingBatch.batchId, h.jobs[1].job.batchId); assert.equal(second.details.existingBatch.count, 1);
  assert.match(second.message, /already holds a different accepted batch/); assert.doesNotMatch(second.message, /nothing was queued/i);
  // Asking again is answered from the key's receipt before anything is sent.
  const again = errorOf(await call('enqueue_recipes', { requestKey: 'late3', items: [{ ...ref(prepared), seeds: [1, 2] }] }));
  assert.equal(again.code, 'request_conflict'); assert.equal(again.details.enqueueSent, false); assert.equal(again.details.existingBatch.batchId, h.jobs[1].job.batchId);
  assert.equal(h.jobs.length, 2);
});

test('0.1.4 lookup_enqueue answers at once: in flight -> settling a few seconds; nothing recorded -> clear; a restartable receipt -> clear (same plan, same key); stale only for a receipt the host can neither confirm nor restart; an older host is never advised a new key', async t => {
  const h = await realHost(t);
  const { call } = await connect(t, h.bridge);
  const prepared = ok(await call('prepare_recipe', t2i()));
  const plan = requestKey => ({ requestKey, items: [{ ...ref(prepared), seeds: [1] }] });
  // Nothing arrived for the key and nothing is in flight: clear at once, no window.
  const none = ok(await call('lookup_enqueue', { requestKey: 'nothing' }));
  assert.equal(none.status, 'not_found'); assert.equal(none.inFlight, false); assert.deepEqual(none.settlement, { state: 'clear', newKeyAdvised: false });
  assert.match(none.instruction, /nothing was queued under this requestKey/); assert.match(none.instruction, /same plan or a changed one/);
  // An enqueue the host is still handling (the batch service holds it): settling, inFlight, a few seconds; never a new key.
  const gate = h.gateBackend();
  const pending = h.service.enqueue_queue_recipes({ requestKey: recipeQueue.mcpHostRequestKey('running'), items: [{ ...ref(prepared), seed: 1 }], intervalSeconds: 0 });
  await gate.inside;
  const running = ok(await call('lookup_enqueue', { requestKey: 'running' }));
  assert.equal(running.status, 'unknown'); assert.equal(running.inFlight, true);
  assert.deepEqual(running.settlement, { state: 'settling', retryAfterSeconds: 2, inFlight: true, newKeyAdvised: false });
  assert.match(running.instruction, /still handling it/); assert.doesNotMatch(running.instruction, /NEW requestKey/);
  gate.release(); await pending;
  const done = ok(await call('lookup_enqueue', { requestKey: 'running' }));
  assert.equal(done.status, 'enqueued'); assert.equal(done.settlement, undefined); assert.equal(done.inFlight, false);
  // A receipt whose enqueue ended without a batch (the batch service failed, its queue readable): clear, resend the same plan.
  h.backend.failNext = new Error('backend connection dropped');
  await assert.rejects(h.service.enqueue_queue_recipes({ requestKey: recipeQueue.mcpHostRequestKey('ended'), items: [{ ...ref(prepared), seed: 1 }], intervalSeconds: 0 }), error => error.code === 'queue_acceptance_unknown');
  const ended = ok(await call('lookup_enqueue', { requestKey: 'ended' }));
  assert.equal(ended.status, 'unknown'); assert.deepEqual(ended.settlement, { state: 'clear', resend: 'same_plan_same_key', newKeyAdvised: false }); assert.deepEqual(ended.queueCheck, { batchFound: false, batchesScanned: 1 });
  assert.match(ended.instruction, /Call enqueue_recipes with the same requestKey and the same plan: the host starts it again, never a second batch/);
  const restarted = ok(await call('enqueue_recipes', plan('ended')));
  assert.equal(restarted.status, 'enqueued'); assert.equal(restarted.reconciled, undefined, 'a plain dispatch restarted it');
  // A receipt the host can neither confirm nor restart: stale, a new key advised (as the host says nothing more will happen).
  h.faults.lookup_queue_request = () => ({ batch: null, status: 'unknown', inFlight: false });
  const stale = ok(await call('lookup_enqueue', { requestKey: 'stuck' }));
  assert.deepEqual(stale.settlement, { state: 'stale', newKeyAdvised: true }); assert.match(stale.instruction, /NEW requestKey/); assert.match(stale.instruction, /in case the old request still appears/);
  h.faults.lookup_queue_request = () => ({ batch: null, status: 'unknown', inFlight: false });
  const stuckEnqueue = errorOf(await call('enqueue_recipes', plan('stuck')));
  assert.equal(stuckEnqueue.code, 'queue_acceptance_unknown'); assert.equal(stuckEnqueue.details.enqueueSent, false); assert.equal(stuckEnqueue.details.newKeyAdvised, true);
  // An older host does not say whether it is still working on the key: settling, never a new-key advice, and a plain
  // not_found is clear for resending the same plan.
  h.faults.lookup_queue_request = () => ({ batch: null, status: 'unknown' });
  const old = ok(await call('lookup_enqueue', { requestKey: 'old-host' }));
  assert.deepEqual(old.settlement, { state: 'settling', retryAfterSeconds: 30, newKeyAdvised: false }); assert.equal(Object.hasOwn(old, 'inFlight'), false);
  assert.match(old.instruction, /older than this MCP server/); assert.doesNotMatch(old.instruction, /NEW requestKey/);
  h.faults.lookup_queue_request = () => ({ batch: null });
  const oldNone = ok(await call('lookup_enqueue', { requestKey: 'old-host' }));
  assert.deepEqual(oldNone.settlement, { state: 'clear', newKeyAdvised: false }); assert.match(oldNone.instruction, /Resending the same plan with the same requestKey is safe/);
  // If the queue holds a batch under the key although the receipt says unknown, the lookup reports it.
  h.faults.lookup_queue_request = () => ({ batch: null, status: 'unknown', inFlight: false });
  const found = ok(await call('lookup_enqueue', { requestKey: 'running' }));
  assert.equal(found.status, 'enqueued'); assert.equal(found.queueCheck.batchFound, true); assert.equal(found.receiptPersisted, false); assert.equal(found.settlement, undefined);
  assert.equal(h.jobs.length, 2);
});

test('N-1 (single process): an enqueue the host is still handling when its reply times out is waited for in the same call, and its one batch is the answer', async t => {
  const h = await realHost(t);
  const inFlight = h.gateBackend();
  // The settle sleeps advance fake time; after the second one the host's batch service is let go.
  const clock = { t: 5_000_000 }, seen = [];
  let sleeps = 0;
  const { call } = await connect(t, h.bridge, { recipeQueue: { monotonicNow: () => clock.t, sleep: async ms => { clock.t += ms; if (++sleeps === 2) inFlight.release(); await new Promise(resolve => setTimeout(resolve, 2)); } } });
  const prepared = ok(await call('prepare_recipe', t2i()));
  h.faults.enqueue_queue_recipes = 'timeout-host-continues';
  const observe = h.bridge.call;
  h.bridge.call = async (method, args, signal) => { const result = await observe(method, args, signal); if (method === 'lookup_queue_request') seen.push(result.inFlight); return result; };
  const settled = ok(await call('enqueue_recipes', { requestKey: 'portrait-1', items: [{ ...ref(prepared), seeds: [7] }] }));
  assert.equal(settled.status, 'enqueued'); assert.equal(settled.reconciled, true); assert.equal(settled.settled.resends, 0, 'nothing was sent again while the host worked on it');
  assert.equal(seen[1], true, 'the first settle lookup saw the enqueue in flight');
  await Promise.allSettled(h.background);
  assert.equal(h.jobs.length, 1, 'no duplicate batch'); assert.deepEqual(h.jobs.map(entry => entry.args.seeds), [[7]]);
  assert.equal(h.count('enqueue_queue_recipes'), 1);
});

test('N-1 (two processes): a second server that meets the in-flight enqueue sends the same plan, which the host answers with the single batch once the first finishes', async t => {
  const h = await realHost(t);
  const A = await connect(t, h.bridge), B = await connect(t, h.bridge);
  const prepared = ok(await A.call('prepare_recipe', t2i()));
  const plan = { requestKey: 'shared-intent', items: [{ ...ref(prepared), seeds: [7] }] };
  const inFlight = h.gateBackend();
  const pendingA = A.call('enqueue_recipes', plan);
  await inFlight.inside;
  const look = ok(await B.call('lookup_enqueue', { requestKey: 'shared-intent' }));
  assert.equal(look.status, 'unknown'); assert.equal(look.inFlight, true); assert.equal(look.settlement.newKeyAdvised, false);
  // B's dispatch reaches the host while A's enqueue still runs there (A is let go just before it).
  h.faults.enqueue_queue_recipes = { before: async () => { inFlight.release(); } };
  const pendingB = B.call('enqueue_recipes', plan);
  const [a, b] = (await Promise.all([pendingA, pendingB])).map(ok);
  assert.equal(a.status, 'enqueued'); assert.equal(b.status, 'enqueued'); assert.equal(b.batch.batchId, a.batch.batchId);
  assert.equal(h.jobs.length, 1, 'no duplicate batch'); assert.equal(h.count('enqueue_queue_recipes'), 2);
});

test('p3 A: the settle budget runs on the monotonic clock; a wall-clock jump never ends or lengthens it', async t => {
  const h = await realHost(t);
  // Date.now is replaced before the queue exists, so a default that captured Date.now would see the jump too.
  const realNow = Date.now, wall = { offset: 0 };
  Date.now = () => realNow() + wall.offset;
  try {
    const queue = recipeQueue.createRecipeQueue({ bridge: h.bridge, settleBudgetMs: 300, pollMs: 20 });
    const prepared = await queue.prepare(t2i());
    const stop = persistently(h, 'enqueue_queue_recipes', () => { wall.offset += 3_600_000; timeout(); });
    const started = performance.now();
    await assert.rejects(queue.enqueue({ requestKey: 'jump-default', items: [{ ...ref(prepared), seeds: [1] }] }), error => error.code === 'queue_acceptance_unknown' && error.details.settled.resends === recipeQueue.SETTLE_RESENDS);
    stop();
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 250 && elapsed < 5_000, `${elapsed} ms`);
  } finally { Date.now = realNow; }
  assert.throws(() => recipeQueue.createRecipeQueue({ bridge: h.bridge, monotonicNow: 5 }), /Invalid settle clock/);
  assert.throws(() => recipeQueue.createRecipeQueue({ bridge: h.bridge, settleBudgetMs: -1 }), /Invalid settle clock/);
});

test('p3 B: after a restart (or from another process) a not_found is clear at once; a request that arrives late after all is reported enqueued', async t => {
  const h = await realHost(t);
  const A = await connect(t, h.bridge);
  const prepared = ok(await A.call('prepare_recipe', t2i()));
  const plan = { requestKey: 'night-restart', items: [{ ...ref(prepared), seeds: [1] }] };
  // A dispatch held on the way while its server restarts: the new server has no memory of it.
  h.faults.enqueue_queue_recipes = 'held'; h.faults.lookup_queue_request = 'lost-before-host';
  const lost = errorOf(await A.call('enqueue_recipes', plan));
  assert.equal(lost.code, 'timeout', 'the gate lookup failed, nothing was sent'); delete h.faults.enqueue_queue_recipes;
  const B = await connect(t, h.bridge);
  const first = ok(await B.call('lookup_enqueue', { requestKey: 'night-restart' }));
  assert.equal(first.status, 'not_found'); assert.deepEqual(first.settlement, { state: 'clear', newKeyAdvised: false });
  assert.equal(ok(await B.call('enqueue_recipes', plan)).status, 'enqueued');
  assert.equal(ok(await B.call('enqueue_recipes', plan)).status, 'already_enqueued');
  assert.equal(ok(await A.call('lookup_enqueue', { requestKey: 'night-restart' })).status, 'enqueued');
  assert.equal(h.jobs.length, 1);
});

/**
 * Reviewer receiptGate: after the host publishes a new request-*.json receipt (preparing, no args yet), the next
 * recipe-file open inside the host blocks until release(). Lookups never open recipe files, so they pass through
 * and land exactly between "receipt published" and "plan recorded". restore() must run in a finally block.
 */
const receiptGate = () => {
  const realLink = fsp.link, realOpen = fsp.open;
  let armed = false, release, entered;
  const gate = new Promise(resolve => { release = resolve; }), inside = new Promise(resolve => { entered = resolve; });
  fsp.link = async function (from, to) { const out = await realLink.call(this, from, to); if (/^request-[a-f0-9]{64}\.json$/.test(basename(String(to)))) armed = true; return out; };
  fsp.open = async function (file, ...rest) { if (armed && /^[a-f0-9-]{36}\.\d+\.json$/.test(basename(String(file)))) { armed = false; entered(); await gate; } return realOpen.call(this, file, ...rest); };
  return { release, inside, restore: () => { fsp.link = realLink; fsp.open = realOpen; } };
};

test('p3 R1: a lookup landing after the host published the receipt and before it recorded the plan no longer makes it abandon the dispatch: it reports inFlight, and the call settles to the one batch', async t => {
  const h = await realHost(t);
  const gate = receiptGate();
  const clock = { t: 2_000_000 };
  let sleeps = 0;
  const { call } = await connect(t, h.bridge, { recipeQueue: { monotonicNow: () => clock.t, sleep: async ms => { clock.t += ms; if (++sleeps === 2) { gate.release(); } await new Promise(resolve => setTimeout(resolve, 2)); } } });
  try {
    const prepared = ok(await call('prepare_recipe', t2i()));
    h.faults.enqueue_queue_recipes = 'timeout-host-continues';
    const settled = ok(await call('enqueue_recipes', { requestKey: 'race-1', items: [{ ...ref(prepared), seeds: [7] }] }));
    assert.equal(settled.status, 'enqueued'); assert.equal(settled.reconciled, true); assert.equal(settled.settled.resends, 0);
  } finally { gate.release(); gate.restore(); }
  const [outcome] = await Promise.allSettled(h.background);
  assert.equal(outcome.status, 'fulfilled', 'the host finished its dispatch'); assert.equal(h.jobs.length, 1);
  assert.equal(ok(await call('lookup_enqueue', { requestKey: 'race-1' })).status, 'enqueued');
});

test('p3 R2: another process looking up in that gap is told the enqueue is in flight; the first call finishes with its batch', async t => {
  const h = await realHost(t);
  const A = await connect(t, h.bridge), B = await connect(t, h.bridge);
  const prepared = ok(await A.call('prepare_recipe', t2i()));
  const gate = receiptGate();
  let pendingA;
  try {
    pendingA = A.call('enqueue_recipes', { requestKey: 'race-2', items: [{ ...ref(prepared), seeds: [7] }] });
    await gate.inside;
    const lookB = ok(await B.call('lookup_enqueue', { requestKey: 'race-2' }));
    assert.equal(lookB.status, 'unknown'); assert.equal(lookB.inFlight, true); assert.equal(lookB.settlement.state, 'settling'); assert.equal(lookB.settlement.newKeyAdvised, false);
  } finally { gate.release(); gate.restore(); }
  const accepted = ok(await pendingA);
  assert.equal(accepted.status, 'enqueued'); assert.equal(accepted.reconciled, undefined);
  assert.equal(ok(await B.call('lookup_enqueue', { requestKey: 'race-2' })).status, 'enqueued');
  assert.equal(h.jobs.length, 1);
});

test('p3 R3: a receipt left without its plan by a host that stopped in that gap (a crash) is started again by the same plan under the same key after a restart', async t => {
  const h = await realHost(t);
  const { call } = await connect(t, h.bridge);
  const prepared = ok(await call('prepare_recipe', t2i()));
  const gate = receiptGate(), key = recipeQueue.mcpHostRequestKey('crash-1');
  let crashed;
  try {
    const pending = h.service.enqueue_queue_recipes({ requestKey: key, items: [{ ...ref(prepared), seed: 7 }], intervalSeconds: 0 });
    await gate.inside;
    // The app stops here: a copy of its data folder is what the next start finds.
    crashed = join(h.base, 'after-crash'); await fsp.cp(h.runtimeDir, crashed, { recursive: true });
    gate.release(); gate.restore();
    await pending;
  } finally { gate.release(); gate.restore(); }
  const jobs = [];
  const backend = { ready: Promise.resolve(), async enqueue(args) { const job = { batchId: randomUUID(), requestKey: args.requestKey, execution: args.execution, status: 'queued', count: args.count, intervalSeconds: args.intervalSeconds, originWorkspaceId: args.workspaceId, submittedRevision: args.expectedRevision, mode: args.mode, activeJobId: null, items: args.seeds.map((seed, index) => ({ index, status: 'queued', jobId: null, seed, results: [] })) }; jobs.push(job); return structuredClone(job); },
    lookup: args => structuredClone(jobs.find(job => job.requestKey === args.requestKey) ?? null), list: () => ({ batches: jobs.map(job => structuredClone(job)) }), read: args => structuredClone(jobs.find(job => job.batchId === args.batchId)) };
  const restarted = createQueueRecipeService({ runtimeDir: crashed, batch: backend, randomSeed: () => 777 });
  assert.deepEqual(json(await restarted.lookup_queue_request({ requestKey: key })), { batch: null, status: 'unknown', inFlight: false, restartable: true });
  const again = json(await restarted.enqueue_queue_recipes({ requestKey: key, items: [{ ...ref(prepared), seed: 7 }], intervalSeconds: 0 }));
  assert.equal(again.requestKey, key); assert.equal(jobs.length, 1);
  assert.equal(json(await restarted.lookup_queue_request({ requestKey: key })).status, 'accepted');
});

test('p3: a lookup that itself collides with a receipt transition says to look up the same key again later', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  h.faults.lookup_queue_request = { before: async () => { throw new BridgeError('queue_storage_failed', recipeQueue.RECEIPT_TRANSITION_MESSAGE); } };
  const failed = errorOf(await call('lookup_enqueue', { requestKey: 'collide' }));
  assert.equal(failed.code, 'queue_storage_failed');
  assert.match(failed.message, /Only the lookup failed; nothing was sent\. Look up the same requestKey again in a few seconds; do not switch keys/);
  assert.equal(failed.details.status, 'lookup_failed'); assert.equal(failed.details.instruction, 'Look up the same requestKey again later.');
  assert.equal(failed.details.requestKey, 'collide');
  // Any other lookup failure is passed through unchanged.
  h.faults.lookup_queue_request = { before: async () => { throw new BridgeError('queue_storage_failed', 'disk quota exceeded'); } };
  const other = errorOf(await call('lookup_enqueue', { requestKey: 'collide' }));
  assert.equal(other.message, 'disk quota exceeded'); assert.equal(other.details?.status, undefined);
  // An enqueue refused with the transition text is never blamed on a full recipe store, whatever the key then holds.
  const prepared = ok(await call('prepare_recipe', t2i()));
  h.faults.enqueue_queue_recipes = { before: async () => { throw new BridgeError('queue_storage_failed', recipeQueue.RECEIPT_TRANSITION_MESSAGE); } };
  const refusal = errorOf(await call('enqueue_recipes', { requestKey: 'collide-2', items: [{ ...ref(prepared), seeds: [1] }] }));
  assert.equal(refusal.code, 'queue_storage_failed'); assert.equal(refusal.details.keyStatus, 'not_found');
  assert.doesNotMatch(refusal.message, /store is full|archiving/);
  // Only a refusal the host marks as a full store (details.reason store_full) is reported as one; any other storage
  // refusal is passed on with the host's own reason.
  h.faults.enqueue_queue_recipes = { before: async () => { throw new BridgeError('queue_storage_failed', 'Queue storage quota exceeded.', { reason: 'store_full' }); } };
  assert.match(errorOf(await call('enqueue_recipes', { requestKey: 'collide-3', items: [{ ...ref(prepared), seeds: [1] }] })).message, /store is full \(16384 records or 512 MiB\)/);
  h.faults.enqueue_queue_recipes = { before: async () => { throw new BridgeError('queue_storage_failed', 'The recipe store holds an entry this app does not use: runtime/queue-recipes/notes.txt (in the data folder).', { reason: 'unsupported_entry', entry: 'runtime/queue-recipes/notes.txt' }); } };
  const stray = errorOf(await call('enqueue_recipes', { requestKey: 'collide-4', items: [{ ...ref(prepared), seeds: [1] }] }));
  assert.match(stray.message, /runtime\/queue-recipes\/notes\.txt/); assert.doesNotMatch(stray.message, /store is full|archiving/);
  assert.equal(h.jobs.length, 0);
});

test('N-4: the unknown-receipt queue check scans the whole host queue, not just the first 8 batches', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const prepared = ok(await call('prepare_recipe', t2i()));
  for (let index = 0; index < 11; index++) assert.equal(ok(await call('enqueue_recipes', { requestKey: `filler-${index}`, items: [{ ...ref(prepared), seeds: [index] }] })).status, 'enqueued');
  assert.equal(ok(await call('enqueue_recipes', { requestKey: 'target', items: [{ ...ref(prepared), seeds: [99] }] })).status, 'enqueued');
  const listed = json(await h.service.list_queue({})).batches;
  assert.equal(listed.length, 12);
  const position = listed.findIndex(batch => batch.requestKey === recipeQueue.mcpHostRequestKey('target'));
  assert.ok(position >= 8, `target is at ${position}, beyond the first 8`);
  h.faults.lookup_queue_request = () => ({ batch: null, status: 'unknown' });
  const found = ok(await call('lookup_enqueue', { requestKey: 'target' }));
  assert.equal(found.status, 'enqueued'); assert.deepEqual(found.queueCheck, { batchFound: true, batchesScanned: 12 });
  assert.equal(found.batch.batchId, listed[position].batchId);
});

test('F3b: an entry the recipe store does not use is reported with its name, never as a full store, and the store works once it is gone', async t => {
  const h = await realHost(t);
  const { call } = await connect(t, h.bridge);
  const prepared = ok(await call('prepare_recipe', t2i()));
  const stray = join(h.runtimeDir, 'queue-recipes', 'notes.txt');
  await writeFile(stray, 'mine');
  await writeFile(join(h.runtimeDir, 'queue-recipes', '.DS_Store'), 'finder');
  const put = errorOf(await call('prepare_recipe', t2i({ positivePrompt: 'stray entry' })));
  assert.equal(put.code, 'queue_storage_failed'); assert.equal(put.details.saved, false);
  assert.match(put.message, /queue-recipes\/notes\.txt/); assert.match(put.message, /Move or delete that entry/); assert.match(put.message, /Nothing was saved/);
  assert.doesNotMatch(put.message, /full|archiving|16384/);
  assert.equal(put.details.hostDetails.reason, 'unsupported_entry'); assert.match(put.details.hostDetails.entry, /queue-recipes\/notes\.txt$/);
  const enqueue = errorOf(await call('enqueue_recipes', { requestKey: 'stray-entry', items: [{ ...ref(prepared), seeds: [1] }] }));
  assert.equal(enqueue.code, 'queue_storage_failed'); assert.match(enqueue.message, /queue-recipes\/notes\.txt/); assert.doesNotMatch(enqueue.message, /full|archiving|reachable/);
  assert.equal(h.count('enqueue_queue_recipes'), 0);
  await rm(stray);
  assert.equal(ok(await call('prepare_recipe', t2i({ positivePrompt: 'after removal' }))).recipeRevision, 1);
  assert.equal(ok(await call('enqueue_recipes', { requestKey: 'stray-entry', items: [{ ...ref(prepared), seeds: [1] }] })).status, 'enqueued');
  assert.equal(await readFile(join(h.runtimeDir, 'queue-recipes', '.DS_Store'), 'utf8'), 'finder');
});

test('F3: explicit host storage refusals are definite, not unknown; the unused key works once space is freed', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const prepared = ok(await call('prepare_recipe', t2i()));
  const store = join(h.runtimeDir, 'queue-recipes');
  // The host record limit (W2d: 16,384 records, RECIPE_STORE_LIMITS); this server's refusal text names it.
  assert.equal(recipeQueue.RECIPE_STORE_LIMITS.records, 16_384);
  const existing = (await fsp.readdir(store)).length;
  const fillers = Array.from({ length: recipeQueue.RECIPE_STORE_LIMITS.records - existing }, (_, index) => join(store, `request-${createHash('sha256').update(`filler-${index}`).digest('hex')}.json`));
  for (let index = 0; index < fillers.length; index += 256) await Promise.all(fillers.slice(index, index + 256).map(file => writeFile(file, '{}')));
  const put = errorOf(await call('prepare_recipe', t2i({ positivePrompt: 'full store' })));
  assert.equal(put.code, 'queue_storage_failed'); assert.equal(put.details.putOutcome, 'rejected'); assert.equal(put.details.saved, false); assert.match(put.message, /store is full \(16384 records or 512 MiB\)/);
  const refused = errorOf(await call('enqueue_recipes', { requestKey: 'full-store', items: [{ ...ref(prepared), seeds: [1] }] }));
  assert.equal(refused.code, 'queue_storage_failed'); assert.equal(refused.details.status, 'rejected'); assert.equal(refused.details.keyStatus, 'not_found'); assert.equal(refused.details.enqueueSent, true);
  assert.match(refused.message, /nothing was queued/); assert.match(refused.message, /after fixing the cause, enqueue again with the same requestKey/);
  assert.equal(ok(await call('lookup_enqueue', { requestKey: 'full-store' })).status, 'not_found');
  assert.match(refused.message, /store is full \(16384 records or 512 MiB\)/);
  for (let index = 0; index < fillers.length; index += 256) await Promise.all(fillers.slice(index, index + 256).map(file => rm(file)));
  assert.equal(ok(await call('enqueue_recipes', { requestKey: 'full-store', items: [{ ...ref(prepared), seeds: [1] }] })).status, 'enqueued', 'no unknown hold after a definite refusal');
  assert.equal(h.count('enqueue_queue_recipes'), 2); assert.equal(h.jobs.length, 1);
});

test('F4: enqueue accepts any host-ready recipe (also made elsewhere or host-normalized) and lists warnings instead of blocking', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const base = ok(await call('prepare_recipe', t2i()));
  const seven = Array.from({ length: 7 }, (_, index) => ({ prompt: `c${index}`, useCoords: false, x: 0.5, y: 0.5 }));
  const crowded = json(await h.service.put_queue_recipe({ preparation: { mode: 't2i', authored: { params: { promptAssemblyVersion: 1, model: 'nai-diffusion-4-5-full', positivePrompt: 'x', seed: 5, seedMode: 'fixed' }, charCaptions: seven }, assets: [] } }));
  const variety = json(await h.service.put_queue_recipe({ preparation: { mode: 't2i', authored: { params: { promptAssemblyVersion: 1, model: 'nai-diffusion-4-5-full', positivePrompt: 'x', variety: true, steps: 99 } }, assets: [] } }));
  h.faults.put_queue_recipe = reply => retamper(reply, snapshot => { snapshot.reviewInput.authored.params.steps = 27; });
  const mismatch = errorOf(await call('prepare_recipe', t2i({ positivePrompt: 'flagged' })));
  assert.equal(mismatch.code, 'recipe_input_mismatch');
  const flagged = ok(await readRecipe({ recipeId: mismatch.details.observedIdentity.recipeId, recipeRevision: 1 }));
  const receipt = ok(await call('enqueue_recipes', { requestKey: 'mixed-origin', items: [{ ...ref(crowded), seeds: [1] }, { ...ref(variety), seeds: [2] }, { ...ref(flagged), seeds: [3] }] }));
  assert.equal(receipt.status, 'enqueued'); assert.equal(receipt.count, 3);
  const codes = recipeId => receipt.warnings.filter(warning => warning.recipeId === recipeId).map(warning => warning.code).sort();
  assert.deepEqual(codes(crowded.recipeId), ['characters_not_sent']);
  assert.deepEqual(codes(variety.recipeId), ['unexposed_inputs']);
  assert.deepEqual(codes(flagged.recipeId), ['recipe_input_mismatch']);
  assert.match(receipt.warnings.find(warning => warning.code === 'recipe_input_mismatch').message, /params\.steps/);
  assert.equal(h.jobs.length, 1);
});

test('F5: presets that add no text on the chosen model are flagged in the readback as the actual effect', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const v4 = ok(await call('prepare_recipe', t2i({ model: 'nai-diffusion-4-full', noiseSchedule: 'native', ucPreset: 2, characters: [] })));
  assert.equal(v4.effective.ucPreset.text, ''); assert.deepEqual(v4.warnings.map(warning => warning.code), ['uc_preset_adds_nothing']);
  assert.match(v4.warnings[0].message, /actual effect/);
  const furry = ok(await call('prepare_recipe', t2i({ model: 'nai-diffusion-furry-3', noiseSchedule: 'native', ucPreset: 0, characters: [] })));
  assert.deepEqual(furry.warnings.map(warning => warning.code).sort(), ['quality_preset_adds_nothing', 'uc_preset_adds_nothing']);
  const v5 = ok(await call('prepare_recipe', t2i()));
  assert.deepEqual(v5.warnings, []);
  const none = ok(await call('prepare_recipe', t2i({ model: 'nai-diffusion-4-full', noiseSchedule: 'native', ucPreset: 3, qualityPreset: 'none', characters: [] })));
  assert.deepEqual(none.warnings, [], 'explicit none is not a surprise');
});

test('F7: identity fields (requestKey, recipeId, inputHash, batchId…) come back verbatim in errors and results', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const prepared = ok(await call('prepare_recipe', t2i()));
  const requestKey = 'night token: v1 /Users/Alice/drafts/night';
  const refused = errorOf(await call('enqueue_recipes', { requestKey, items: [{ ...ref(prepared), inputHash: 'c'.repeat(64) }] }));
  assert.equal(refused.code, 'recipe_changed'); assert.equal(refused.details.requestKey, requestKey);
  assert.equal(refused.details.hostRequestKey, recipeQueue.mcpHostRequestKey(requestKey));
  const accepted = ok(await call('enqueue_recipes', { requestKey, items: [{ ...ref(prepared), seeds: [1] }] }));
  assert.equal(accepted.requestKey, requestKey); assert.equal(accepted.items[0].inputHash, prepared.inputHash); assert.equal(accepted.items[0].recipeId, prepared.recipeId);
  assert.equal(ok(await call('lookup_enqueue', { requestKey })).requestKey, requestKey);
  h.faults.enqueue_queue_recipes = 'reply-lost';
  const otherKey = 'retry password: hunter2 at /Users/Alice/x/y';
  const settled = ok(await call('enqueue_recipes', { requestKey: otherKey, items: [{ ...ref(prepared), seeds: [2] }] }));
  assert.equal(settled.reconciled, true); assert.equal(settled.requestKey, otherKey); assert.equal(settled.items[0].recipeId, prepared.recipeId);
  const stop = persistently(h, 'enqueue_queue_recipes', timeout);
  const silentKey = 'silent token: v2 /Users/Alice/x/z';
  const unknown = errorOf(await call('enqueue_recipes', { requestKey: silentKey, items: [{ ...ref(prepared), seeds: [4] }] }));
  stop();
  assert.equal(unknown.code, 'queue_acceptance_unknown'); assert.equal(unknown.details.requestKey, silentKey); assert.equal(unknown.details.hostRequestKey, recipeQueue.mcpHostRequestKey(silentKey));
  const conflict = errorOf(await call('enqueue_recipes', { requestKey, items: [{ ...ref(prepared), seeds: [3] }] }));
  assert.equal(conflict.details.requestKey, requestKey); assert.equal(conflict.details.existingBatch.batchId, accepted.batch.batchId);
});

test('F8: stored-input comparison, lineage, single-sample, interval, lookup and read identity checks each fail closed', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const withCharacter = t2i({ characters: [{ prompt: 'a', negativePrompt: 'n', useCoords: true, x: 0.3, y: 0.3 }] });
  const authored = mutate => reply => retamper(reply, snapshot => mutate(snapshot.reviewInput.authored));
  const cases = {
    'params.width': a => { a.params.width = 768; }, 'params.sampler': a => { a.params.sampler = 'k_euler'; }, 'params.cfgScale': a => { a.params.cfgScale = 5.5; },
    'params.qualityToggle': a => { a.params.qualityToggle = false; }, 'params.seedMode': a => { a.params.seedMode = 'random'; }, 'params.ucPreset': a => { a.params.ucPreset = 0; },
    'params.stylePrompt': a => { a.params.stylePrompt = 'oil'; }, 'params.negativePrompt': a => { a.params.negativePrompt = 'x'; }, 'params.model': a => { a.params.model = 'nai-diffusion-5-curated'; },
    'params.smea': a => { a.params.smea = true; }, 'params.variety': a => { a.params.variety = true; }, 'params.fileNamePrefix': a => { a.params.fileNamePrefix = 'x'; },
    'params.transparentBackground': a => { a.params.transparentBackground = true; },
    modelMode: a => { a.modelMode = 'furry'; }, 'params.preservePromptText': a => { a.params.preservePromptText = true; }, 'params.dynamicThresholding': a => { a.params.dynamicThresholding = true; },
    'charCaptions.length': a => { a.charCaptions = []; }, 'charCaptions.0.x': a => { a.charCaptions[0].x = 0.5; }, 'charCaptions.0.negativePrompt': a => { a.charCaptions[0].negativePrompt = 'z'; },
    'charCaptions.0.prompt': a => { a.charCaptions[0].prompt = 'b'; }, 'charCaptions.0.useCoords': a => { a.charCaptions[0].useCoords = false; }, vibeImages: a => { a.vibeImages = [{ name: 'v' }]; },
  };
  for (const [field, mutate] of Object.entries(cases)) {
    h.faults.put_queue_recipe = authored(mutate);
    const error = errorOf(await call('prepare_recipe', withCharacter));
    assert.equal(error.code, 'recipe_input_mismatch', field); assert.deepEqual(error.details.fields, [field], field);
  }
  // Single sample: a stored request with n_samples 2 is refused at prepare and at enqueue.
  h.faults.put_queue_recipe = reply => retamper(reply, snapshot => { snapshot.reviewInput.effective.request.parameters.n_samples = 2; });
  assert.deepEqual(errorOf(await call('prepare_recipe', t2i())).details.fields, ['effective.n_samples']);
  const prepared = ok(await call('prepare_recipe', t2i()));
  const twoSampleReply = reply => retamper(reply, snapshot => { snapshot.reviewInput.effective.sampling.sampleCount = 2; });
  const twoSampleHash = twoSampleReply(json(await h.service.read_queue_recipe({ recipeId: prepared.recipeId, recipeRevision: 1 }))).inputHash;
  h.faults.read_queue_recipe = twoSampleReply;
  const twoSamples = errorOf(await call('enqueue_recipes', { requestKey: 'two', items: [{ ...ref(prepared), inputHash: twoSampleHash, seeds: [1] }] }));
  assert.equal(twoSamples.code, 'invalid_response'); assert.equal(h.count('enqueue_queue_recipes'), 0);
  // Identity: a put reply whose snapshot names another recipe is not adopted.
  h.faults.put_queue_recipe = reply => ({ ...reply, snapshot: { ...reply.snapshot, workspaceId: `recipe:${randomUUID()}` } });
  assert.equal(errorOf(await call('prepare_recipe', t2i())).code, 'recipe_identity_unconfirmed');
  // Interval is part of the plan identity: at the gate and in the dispatch reply.
  assert.equal(ok(await call('enqueue_recipes', { requestKey: 'interval', items: [{ ...ref(prepared), seeds: [1] }] })).status, 'enqueued');
  assert.equal(errorOf(await call('enqueue_recipes', { requestKey: 'interval', intervalSeconds: 5, items: [{ ...ref(prepared), seeds: [1] }] })).code, 'request_conflict');
  // A dispatch reply with another interval cannot confirm the plan: the lookup that follows decides (here: the real batch).
  h.faults.enqueue_queue_recipes = reply => ({ ...reply, intervalSeconds: 9 });
  const intervalReply = ok(await call('enqueue_recipes', { requestKey: 'interval-reply', intervalSeconds: 5, items: [{ ...ref(prepared), seeds: [1] }] }));
  assert.equal(intervalReply.reconciled, true); assert.equal(intervalReply.batch.intervalSeconds, 5);
  const tamper = reply => { h.faults.lookup_queue_request = tamper; return { ...reply, batch: reply.batch && { ...reply.batch, intervalSeconds: 9 } }; };
  h.faults.enqueue_queue_recipes = reply => ({ ...reply, intervalSeconds: 9 }); h.faults.lookup_queue_request = tamper;
  const otherBatch = errorOf(await call('enqueue_recipes', { requestKey: 'interval-reply-2', intervalSeconds: 5, items: [{ ...ref(prepared), seeds: [1] }] }));
  assert.equal(otherBatch.code, 'request_conflict'); delete h.faults.lookup_queue_request;
  // A lookup reply for another key and a read reply for another recipe/revision are refused.
  h.faults.lookup_queue_request = reply => ({ ...reply, batch: { ...reply.batch, requestKey: recipeQueue.mcpHostRequestKey('someone-else') } });
  assert.equal(errorOf(await call('lookup_enqueue', { requestKey: 'interval' })).code, 'invalid_response');
  const other = ok(await call('prepare_recipe', t2i({ positivePrompt: 'other' })));
  const revised = ok(await call('prepare_recipe', t2i({ recipeId: prepared.recipeId, expectedRevision: 1, positivePrompt: 'revised' })));
  // Fully consistent replies for a different recipe or a different revision: only the exact identity check can refuse them.
  const otherReply = json(await h.service.read_queue_recipe({ recipeId: other.recipeId, recipeRevision: 1 }));
  const revisedReply = json(await h.service.read_queue_recipe({ recipeId: revised.recipeId, recipeRevision: 2 }));
  for (const replacement of [otherReply, revisedReply]) {
    h.faults.read_queue_recipe = () => structuredClone(replacement);
    assert.equal(errorOf(await readRecipe({ recipeId: prepared.recipeId, recipeRevision: 1 })).code, 'invalid_response');
    h.faults.read_queue_recipe = () => structuredClone(replacement);
    const swapped = errorOf(await call('enqueue_recipes', { requestKey: 'swapped', items: [{ recipeId: prepared.recipeId, recipeRevision: 1, inputHash: replacement.inputHash, seeds: [1] }] }));
    assert.equal(swapped.code, 'invalid_response'); assert.equal(swapped.details.enqueueSent, false);
  }
  // Recipe results pass through the message scrub (readiness issues, host errors).
  const blocked = json(await h.service.put_queue_recipe({ preparation: { mode: 't2i', authored: { params: { promptAssemblyVersion: 1, positivePrompt: '' } }, assets: [] } }));
  h.faults.read_queue_recipe = reply => retamper(reply, snapshot => { snapshot.reviewInput.readiness.issues[0].message = "open '/Users/Alice/secret/x.png' failed; token=abc123"; });
  const scrubbed = ok(await readRecipe({ recipeId: blocked.recipeId, recipeRevision: 1 }));
  assert.equal(scrubbed.readiness.issues[0].message, "open '<path>' failed; token=[redacted]");
});

nodeTest('every host method observed across this file is one of the fixed recipe/queue methods', () => {
  assert.deepEqual([...observedHostMethods].sort(), [...RECIPE_METHODS].sort());
});

test('queue retention: a cleaned batch keeps its requestKey accepted through every MCP tool, and nothing is sent again', async t => {
  const DAY = 24 * 60 * 60 * 1000;
  const clock = Date.now();
  const h = await realHost(t, { retention: { days: () => 30, now: () => clock, log: () => {} }, recipeReclaim: { auto: false, log: () => {} }, resolveHistoryGroup: name => ({ id: 'group-lighthouse', name }) });
  // The in-memory backend ends its batch and removes it when the host's cleaning retires it.
  h.backend.retire = async ids => { for (const id of ids) { const index = h.jobs.findIndex(entry => entry.job.batchId === id); if (index >= 0) h.jobs.splice(index, 1); } return { removed: ids, reclaimedBytes: 0, deferred: [] }; };
  const { call } = await connect(t, h.bridge);
  const prepared = ok(await call('prepare_recipe', t2i()));
  const args = { requestKey: 'lighthouse-final', historyGroup: 'Lighthouse', fileNamePrefix: 'lh', items: [{ ...ref(prepared), seeds: [11, 22] }] };
  const accepted = ok(await call('enqueue_recipes', args));
  const [entry] = h.jobs; const finishedAt = new Date(clock - 40 * DAY).toISOString();
  Object.assign(entry.job, { status: 'succeeded', finishedAt, createdAt: finishedAt, source: { kind: 'agent', client: null }, items: entry.job.items.map(value => ({ ...value, status: 'succeeded' })) });
  const run = await h.service.runRetention();
  assert.equal(run.cleaned, 1); assert.equal(run.receipts, 1); assert.equal(run.recipes, 1);
  const enqueues = h.count('enqueue_queue_recipes');

  const lookup = ok(await call('lookup_enqueue', { requestKey: 'lighthouse-final' }));
  assert.equal(lookup.status, 'enqueued', 'an old key is never not_found');
  assert.equal(lookup.settlement, undefined); assert.equal(lookup.receiptPersisted, undefined);
  assert.equal(lookup.batch.batchId, accepted.batch.batchId); assert.equal(lookup.batch.status, 'succeeded'); assert.equal(lookup.batch.cleaned, true);
  assert.equal(lookup.batch.finishedAt, finishedAt); assert.match(lookup.batch.cleanedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(lookup.batch.itemCounts, { succeeded: 2, failed: 0, unknown: 0, cancelled: 0, skipped: 0 });
  assert.deepEqual(lookup.batch.output, accepted.batch.output); assert.equal(Object.hasOwn(lookup.batch, 'items'), false);
  assert.match(lookup.instruction, /ended \(succeeded\) and its queue record was cleaned/); assert.match(lookup.instruction, /never enqueue this intent again/); assert.match(lookup.instruction, /queueRequestKey/);

  // The same plan again: already enqueued, nothing sent; another plan under the key: a conflict, nothing sent.
  const repeat = ok(await call('enqueue_recipes', args));
  assert.equal(repeat.status, 'already_enqueued'); assert.equal(repeat.enqueueSent, false); assert.equal(repeat.batch.cleaned, true); assert.match(repeat.instruction, /nothing was sent again/);
  const other = errorOf(await call('enqueue_recipes', { ...args, items: [{ ...ref(prepared), seeds: [33] }] }));
  assert.equal(other.code, 'request_conflict'); assert.equal(other.details.existingBatch.cleaned, true); assert.match(other.message, /ended and was cleaned/);
  assert.equal(h.count('enqueue_queue_recipes'), enqueues, 'no host enqueue for a cleaned key');

  // read_queue, control_queue and get_queue_result.
  const read = ok(await call('read_queue', { batchId: accepted.batch.batchId }));
  assert.equal(read.cleaned, true); assert.equal(read.status, 'succeeded'); assert.deepEqual(read.results, []); assert.match(read.instruction, /queueBatchId/);
  for (const action of ['pause', 'cancel']) { const value = ok(await call('control_queue', { action, batchId: accepted.batch.batchId })); assert.equal(value.cleaned, true); assert.equal(value.status, 'succeeded'); }
  assert.equal(errorOf(await call('control_queue', { action: 'resume', batchId: accepted.batch.batchId })).code, 'batch_not_paused');
  assert.equal(errorOf(await call('get_queue_result', { batchId: accepted.batch.batchId, itemIndex: 0 })).code, 'result_unavailable');
  assert.equal(ok(await call('list_queue', {})).total, 0);

  // The reclaimed recipe: a new request for it is refused before any receipt, the new key stays unused, nothing is sent.
  const reclaimed = errorOf(await call('enqueue_recipes', { requestKey: 'lighthouse-reprint', items: [{ ...ref(prepared), seeds: [44] }] }));
  assert.equal(reclaimed.code, 'recipe_not_found'); assert.equal(reclaimed.details.enqueueSent, false); assert.equal(reclaimed.details.status, 'not_sent');
  assert.match(reclaimed.message, /reclaimed under the queue retention rule/); assert.match(reclaimed.message, /same inputHash/);
  assert.equal(h.count('enqueue_queue_recipes'), enqueues);
  assert.equal(ok(await call('lookup_enqueue', { requestKey: 'lighthouse-reprint' })).status, 'not_found');
});

test('review rework: damaged cleaned records refuse (never not_found); a key rebuilt from the library is accepted whatever the plan; unknown images say to check the library first', async t => {
  const DAY = 24 * 60 * 60 * 1000, clock = Date.now();
  let origins = [];
  const h = await realHost(t, { retention: { days: () => 30, now: () => clock, log: () => {} }, recipeReclaim: { auto: false, log: () => {} }, libraryQueueOrigins: () => origins });
  h.backend.retire = async ids => { for (const id of ids) { const index = h.jobs.findIndex(entry => entry.job.batchId === id); if (index >= 0) h.jobs.splice(index, 1); } return { removed: ids, reclaimedBytes: 0, deferred: [] }; };
  const { call } = await connect(t, h.bridge);
  const prepared = ok(await call('prepare_recipe', t2i()));
  const args = { requestKey: 'lost-record', items: [{ ...ref(prepared), seeds: [5] }] };
  const accepted = ok(await call('enqueue_recipes', args));
  const [entry] = h.jobs; const finishedAt = new Date(clock - 40 * DAY).toISOString();
  Object.assign(entry.job, { status: 'succeeded', finishedAt, createdAt: finishedAt, source: { kind: 'agent', client: null }, items: entry.job.items.map(value => ({ ...value, status: 'succeeded' })) });
  // Cleaned by another process on the same data (this server's host never read the records), then the file is lost.
  const other = createQueueRecipeService({ runtimeDir: h.runtimeDir, batch: h.backend, recipeReclaim: { auto: false, log: () => {} }, retention: { days: () => 30, now: () => clock, log: () => {} }, log: () => {} });
  assert.equal((await other.runRetention()).cleaned, 1);
  // The record file removed: the cleaned key and a new key are both refused, nothing is sent.
  await rm(join(h.runtimeDir, 'queue-cleaned', 'cleaned-v1.jsonl'));
  const sent = h.count('enqueue_queue_recipes');
  for (const key of ['lost-record', 'never-seen']) {
    const refused = errorOf(await call('lookup_enqueue', { requestKey: key }));
    assert.equal(refused.code, 'queue_storage_failed'); assert.notEqual(refused.details?.status, 'not_found');
  }
  const again = errorOf(await call('enqueue_recipes', args));
  assert.equal(again.code, 'queue_storage_failed'); assert.equal(again.details.enqueueSent, false);
  assert.equal(h.count('enqueue_queue_recipes'), sent, 'nothing reached the host enqueue');
  // Repaired knowingly with the library's keys: the lost key is accepted again (rebuilt), a different plan too.
  origins = [{ requestKey: accepted.hostRequestKey, batchId: accepted.batch.batchId, images: 1 }];
  const plan = await h.service.repairPlan();
  assert.equal(plan.recoverable, 1); assert.equal(plan.lost, 2);
  assert.equal((await h.service.repairCleanedRecords({ lost: plan.lost, recoverable: plan.recoverable })).repaired, true);
  const lookup = ok(await call('lookup_enqueue', { requestKey: 'lost-record' }));
  assert.equal(lookup.status, 'enqueued'); assert.equal(lookup.batch.recovered, true); assert.equal(lookup.batch.status, 'unknown'); assert.equal(lookup.batch.savedImages, 1);
  assert.match(lookup.instruction, /lost and rebuilt from the library/);
  const otherPlan = ok(await call('enqueue_recipes', { ...args, items: [{ ...ref(prepared), seeds: [6] }] }));
  assert.equal(otherPlan.status, 'already_enqueued'); assert.equal(otherPlan.enqueueSent, false);
  assert.equal(h.count('enqueue_queue_recipes'), sent);
  assert.equal(ok(await call('lookup_enqueue', { requestKey: 'never-seen' })).status, 'not_found');
  // A batch with an unknown image: read_queue says to check the library by its batch first.
  const fresh = ok(await call('prepare_recipe', t2i({ positivePrompt: '1girl, fresh recipe' })));
  const second = ok(await call('enqueue_recipes', { requestKey: 'unknown-image', items: [{ ...ref(fresh), seeds: [7, 8] }] }));
  const job = h.jobs.find(value => value.job.batchId === second.batch.batchId).job;
  Object.assign(job, { status: 'blocked', finishedAt: new Date().toISOString(), items: [{ ...job.items[0], status: 'unknown', error: { code: 'restart_unconfirmed', message: 'x' } }, { ...job.items[1], status: 'skipped' }] });
  const read = ok(await call('read_queue', { batchId: second.batch.batchId }));
  assert.match(read.instruction, new RegExp(`Item 0 has an unknown outcome.*queueBatchId:"${second.batch.batchId}"`));
});
