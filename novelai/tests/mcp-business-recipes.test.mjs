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

async function connect(t, bridgeClient, options = {}) {
  const server = serverUnderTest.create({ bridgeClient, ...options });
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

test('unknown outcomes are only looked up with the same key and never resent automatically', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const prepared = ok(await call('prepare_recipe', t2i()));
  // (a) The host accepted but the reply was lost.
  h.faults.enqueue_queue_recipes = 'reply-lost';
  const lostReply = errorOf(await call('enqueue_recipes', { requestKey: 'lost-reply', items: [{ ...ref(prepared), seeds: [1] }] }));
  assert.equal(lostReply.code, 'queue_acceptance_unknown'); assert.equal(lostReply.details.enqueueSent, true); assert.equal(Object.hasOwn(lostReply.details, 'review'), false);
  assert.equal(h.jobs.length, 1);
  const resolved = ok(await call('lookup_enqueue', { requestKey: 'lost-reply' }));
  assert.equal(resolved.status, 'enqueued'); assert.equal(resolved.batch.batchId, h.jobs[0].job.batchId);
  assert.equal(ok(await call('enqueue_recipes', { requestKey: 'lost-reply', items: [{ ...ref(prepared), seeds: [1] }] })).status, 'already_enqueued');
  assert.equal(h.count('enqueue_queue_recipes'), 1);
  // (b) The request never reached the host: held until a lookup proves there is no receipt.
  h.faults.enqueue_queue_recipes = 'lost-before-host';
  const lostRequest = { requestKey: 'lost-request', items: [{ ...ref(prepared), seeds: [2] }] };
  assert.equal(errorOf(await call('enqueue_recipes', lostRequest)).code, 'queue_acceptance_unknown');
  const held = errorOf(await call('enqueue_recipes', lostRequest));
  assert.equal(held.code, 'queue_acceptance_unknown'); assert.equal(held.details.enqueueSent, false);
  assert.equal(h.count('enqueue_queue_recipes'), 2, 'the held retry sent nothing');
  assert.equal(ok(await call('lookup_enqueue', { requestKey: 'lost-request' })).status, 'not_found');
  assert.equal(ok(await call('enqueue_recipes', lostRequest)).status, 'enqueued', 'an explicit call after not_found may use the same key');
  assert.equal(h.count('enqueue_queue_recipes'), 3); assert.equal(h.jobs.length, 2);
  // (c) The host itself could not confirm acceptance: its receipt is unknown and stays lookup-only, even after a restart.
  h.backend.failNext = new Error('backend connection dropped');
  const hostUnknown = { requestKey: 'host-unknown', items: [{ ...ref(prepared), seeds: [3] }] };
  const unknown = errorOf(await call('enqueue_recipes', hostUnknown));
  assert.equal(unknown.code, 'queue_acceptance_unknown'); assert.equal(unknown.details.hostCode, 'queue_acceptance_unknown');
  assert.equal(ok(await call('lookup_enqueue', { requestKey: hostUnknown.requestKey })).status, 'unknown');
  const restarted = await connect(t, h.bridge);
  const stillUnknown = errorOf(await restarted.call('enqueue_recipes', hostUnknown));
  assert.equal(stillUnknown.code, 'queue_acceptance_unknown'); assert.equal(stillUnknown.details.enqueueSent, false);
  assert.equal(h.count('enqueue_queue_recipes'), 4); assert.equal(h.jobs.length, 2);
  // (d) An unconfirmable reply is unknown too.
  h.faults.enqueue_queue_recipes = reply => ({ ...reply, recipePlanHash: 'b'.repeat(64) });
  assert.equal(errorOf(await call('enqueue_recipes', { requestKey: 'odd-reply', items: [{ ...ref(prepared), seeds: [4] }] })).code, 'queue_acceptance_unknown');
  // (e) Explicit host rejection is final for that key and reported as such.
  h.backend.failNext = Object.assign(new Error('queue is full'), { code: 'queue_full' });
  const full = errorOf(await call('enqueue_recipes', { requestKey: 'full', items: [{ ...ref(prepared), seeds: [5] }] }));
  assert.equal(full.code, 'queue_full'); assert.equal(full.details.status, 'rejected'); assert.equal(full.details.keyStatus, 'rejected');
  assert.match(full.message, /recorded the rejection; nothing was queued under this requestKey/);
  const fullLookup = ok(await call('lookup_enqueue', { requestKey: 'full' }));
  assert.equal(fullLookup.status, 'rejected'); assert.equal(fullLookup.hostError.code, 'queue_full');
  assert.equal(errorOf(await call('enqueue_recipes', { requestKey: 'full', items: [{ ...ref(prepared), seeds: [5] }] })).code, 'queue_request_rejected');
  const enqueueCalls = h.count('enqueue_queue_recipes');
  assert.equal(enqueueCalls, 6, 'each dispatch above happened exactly once');
  assert.equal(ok(await call('lookup_enqueue', { requestKey: 'never-used' })).status, 'not_found');
  // (f) The idempotency lookup itself fails: nothing is sent.
  h.faults.lookup_queue_request = 'lost-before-host';
  const lookupDown = errorOf(await call('enqueue_recipes', { requestKey: 'lookup-down', items: [{ ...ref(prepared), seeds: [6] }] }));
  assert.equal(lookupDown.code, 'timeout'); assert.equal(lookupDown.details.enqueueSent, false); assert.equal(lookupDown.details.status, 'not_sent');
  assert.equal(h.count('enqueue_queue_recipes'), enqueueCalls, 'lookups never enqueue');
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
  // (b) An unrecognized dispatch failure is unknown; its host details are kept too.
  hostFails('enqueue_queue_recipes', 'odd_failure', { stage: 'dispatch' });
  const unknown = errorOf(await call('enqueue_recipes', { requestKey: 'host-details-unknown', items: [{ ...ref(prepared), seeds: [3] }] }));
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

test('exact identity: a revision or inputHash mismatch, a blocked recipe, mixed modes or duplicate fixed seeds are refused before anything is sent', async t => {
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
  await refused({ requestKey: 'exact', items: [{ ...ref(prepared), count: 2 }] }, 'invalid_arguments');
  await refused({ requestKey: 'exact', items: [{ ...ref(prepared), seeds: [1] }, { ...ref(prepared), count: 1 }, { ...ref(prepared), count: 1 }] }, 'invalid_arguments');
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

test('F1: a request_conflict after dispatch attaches the batch already under the key; not_found says only the same plan and key may be resent', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  const prepared = ok(await call('prepare_recipe', t2i()));
  // Reviewer d2: plan A times out on the way and has not reached the host yet.
  h.faults.enqueue_queue_recipes = 'held';
  const first = errorOf(await call('enqueue_recipes', { requestKey: 'late2', items: [{ ...ref(prepared), seeds: [1] }] }));
  assert.equal(first.code, 'queue_acceptance_unknown'); assert.equal(first.details.enqueueSent, true);
  const look = ok(await call('lookup_enqueue', { requestKey: 'late2' }));
  assert.equal(look.status, 'not_found');
  assert.match(look.instruction, /No receipt yet/); assert.match(look.instruction, /Resending the same plan with the same requestKey is safe/);
  assert.match(look.instruction, /timed out can still arrive and be accepted late/); assert.match(look.instruction, /Before changing the plan, look up this same requestKey again in about \d+ seconds/);
  assert.equal(look.settlement.state, 'settling'); assert.ok(look.settlement.retryAfterSeconds > 0 && look.settlement.retryAfterSeconds <= 130);
  // The model changes the plan under the same key; plan A reaches the host just before plan B.
  h.faults.enqueue_queue_recipes = { before: async () => { const [resultA] = await h.releaseHeld(); assert.equal(resultA.count, 1); } };
  const second = errorOf(await call('enqueue_recipes', { requestKey: 'late2', items: [{ ...ref(prepared), seeds: [1, 2] }] }));
  assert.equal(second.code, 'request_conflict'); assert.equal(second.details.status, 'conflict'); assert.equal(second.details.enqueueSent, true); assert.equal(second.details.hostCode, 'request_conflict');
  assert.equal(second.details.existingBatch.batchId, h.jobs[0].job.batchId); assert.equal(second.details.existingBatch.count, 1);
  assert.match(second.message, /already holds a different accepted batch/);
  assert.doesNotMatch(second.message, /nothing was queued/i);
  assert.equal(h.jobs.length, 1, 'plan A is the only batch');
  // Asking again is answered from the key's receipt before anything is sent.
  const again = errorOf(await call('enqueue_recipes', { requestKey: 'late2', items: [{ ...ref(prepared), seeds: [1, 2] }] }));
  assert.equal(again.code, 'request_conflict'); assert.equal(again.details.enqueueSent, false); assert.equal(again.details.existingBatch.batchId, h.jobs[0].job.batchId);
  assert.equal(ok(await call('enqueue_recipes', { requestKey: 'late2', items: [{ ...ref(prepared), seeds: [1] }] })).status, 'already_enqueued');
});

test('F2/N-1: an unknown receipt settles for the settle window; only two unknown lookups at least that far apart with no batch justify a new key', async t => {
  const h = await realHost(t);
  const clock = { t: 1_000_000 };
  const { call, readRecipe } = await connect(t, h.bridge, { recipeQueue: { monotonicNow: () => clock.t } });
  const prepared = ok(await call('prepare_recipe', t2i()));
  h.backend.failNext = new Error('backend connection dropped');
  assert.equal(errorOf(await call('enqueue_recipes', { requestKey: 'stuck', items: [{ ...ref(prepared), seeds: [1] }] })).code, 'queue_acceptance_unknown');
  clock.t += 10_000;
  const first = ok(await call('lookup_enqueue', { requestKey: 'stuck' }));
  assert.equal(first.status, 'unknown'); assert.deepEqual(first.queueCheck, { batchFound: false, batchesScanned: 0 });
  assert.deepEqual(first.settlement, { state: 'settling', retryAfterSeconds: 130, unknownObservedForSeconds: 0, newKeyAdvised: false });
  assert.match(first.instruction, /still settling/); assert.match(first.instruction, /again in about 130 seconds/); assert.doesNotMatch(first.instruction, /NEW requestKey|never clears|permanent/);
  clock.t += 60_000;
  const second = ok(await call('lookup_enqueue', { requestKey: 'stuck' }));
  assert.deepEqual(second.settlement, { state: 'settling', retryAfterSeconds: 70, unknownObservedForSeconds: 60, newKeyAdvised: false });
  const gate = errorOf(await call('enqueue_recipes', { requestKey: 'stuck', items: [{ ...ref(prepared), seeds: [1] }] }));
  assert.equal(gate.details.enqueueSent, false); assert.match(gate.message, /may still turn into accepted/);
  clock.t += 70_000;
  const stale = ok(await call('lookup_enqueue', { requestKey: 'stuck' }));
  assert.deepEqual(stale.settlement, { state: 'stale', unknownObservedForSeconds: 130, newKeyAdvised: true });
  assert.match(stale.instruction, /NEW requestKey/); assert.match(stale.instruction, /accepted late, which would duplicate/);
  assert.equal(ok(await call('enqueue_recipes', { requestKey: 'stuck-2', items: [{ ...ref(prepared), seeds: [1] }] })).status, 'enqueued', 'the documented path works');
  // A restarted server has never seen the key: it waits a full settle window before advising anything.
  const restarted = await connect(t, h.bridge, { recipeQueue: { monotonicNow: () => clock.t } });
  const fresh = ok(await restarted.call('lookup_enqueue', { requestKey: 'stuck' }));
  assert.deepEqual(fresh.settlement, { state: 'settling', retryAfterSeconds: 130, unknownObservedForSeconds: 0, newKeyAdvised: false });
  clock.t += 129_000;
  assert.equal(ok(await restarted.call('lookup_enqueue', { requestKey: 'stuck' })).settlement.state, 'settling');
  clock.t += 1_000;
  assert.equal(ok(await restarted.call('lookup_enqueue', { requestKey: 'stuck' })).settlement.newKeyAdvised, true);
  // Any non-unknown answer resets the clock: a later unknown starts a fresh settle window.
  h.faults.lookup_queue_request = () => ({ batch: null, status: 'unknown' });
  assert.equal(ok(await call('lookup_enqueue', { requestKey: 'blinking' })).settlement.state, 'settling');
  clock.t += 200_000;
  h.faults.lookup_queue_request = () => ({ batch: null });
  assert.equal(ok(await call('lookup_enqueue', { requestKey: 'blinking' })).status, 'not_found');
  clock.t += 1_000;
  h.faults.lookup_queue_request = () => ({ batch: null, status: 'unknown' });
  assert.deepEqual(ok(await call('lookup_enqueue', { requestKey: 'blinking' })).settlement, { state: 'settling', retryAfterSeconds: 130, unknownObservedForSeconds: 0, newKeyAdvised: false });
  // If the queue does hold a batch under the key although the receipt says unknown, the lookup reports it.
  h.faults.lookup_queue_request = () => ({ batch: null, status: 'unknown' });
  const found = ok(await call('lookup_enqueue', { requestKey: 'stuck-2' }));
  assert.equal(found.status, 'enqueued'); assert.equal(found.queueCheck.batchFound, true); assert.equal(found.batch.batchId, h.jobs[0].job.batchId); assert.equal(found.receiptPersisted, false);
  assert.equal(found.settlement, undefined);
  assert.equal(h.count('enqueue_queue_recipes'), 2);
});

test('N-1 (single process): an in-flight host enqueue demoted to unknown by our lookup is never turned into a new-key advice inside the window, and later settles to the one batch', async t => {
  const h = await realHost(t);
  const clock = { t: 5_000_000 };
  const { call, readRecipe } = await connect(t, h.bridge, { recipeQueue: { monotonicNow: () => clock.t } });
  const prepared = ok(await call('prepare_recipe', t2i()));
  const inFlight = h.gateBackend();
  h.faults.enqueue_queue_recipes = 'timeout-host-continues';
  const first = errorOf(await call('enqueue_recipes', { requestKey: 'portrait-1', items: [{ ...ref(prepared), seeds: [7] }] }));
  assert.equal(first.code, 'queue_acceptance_unknown'); assert.match(first.message, /settle window about 130 seconds/);
  await inFlight.inside; // the host wrote the receipt with its args and is waiting on the backend
  const advice = [];
  for (const step of [5_000, 60_000, 60_000]) {
    clock.t += step;
    const look = ok(await call('lookup_enqueue', { requestKey: 'portrait-1' }));
    assert.equal(look.status, 'unknown', 'the lookup demoted the in-flight receipt, exactly as in the reviewer probe');
    advice.push(look.settlement);
    assert.equal(look.settlement.newKeyAdvised, false); assert.doesNotMatch(look.instruction, /NEW requestKey/);
  }
  assert.deepEqual(advice.map(value => value.retryAfterSeconds), [130, 70, 10]);
  inFlight.release(); await Promise.allSettled(h.background);
  clock.t += 10_000;
  const settled = ok(await call('lookup_enqueue', { requestKey: 'portrait-1' }));
  assert.equal(settled.status, 'enqueued'); assert.equal(settled.settlement, undefined);
  assert.equal(h.jobs.length, 1, 'no duplicate batch'); assert.deepEqual(h.jobs.map(entry => entry.args.seeds), [[7]]);
});

test('N-1 (two processes): a second server that meets the in-flight unknown waits the full window and then sees the single accepted batch', async t => {
  const h = await realHost(t);
  const clock = { t: 9_000_000 };
  const A = await connect(t, h.bridge, { recipeQueue: { monotonicNow: () => clock.t } });
  const B = await connect(t, h.bridge, { recipeQueue: { monotonicNow: () => clock.t } });
  const prepared = ok(await A.call('prepare_recipe', t2i()));
  const plan = { requestKey: 'shared-intent', items: [{ ...ref(prepared), seeds: [7] }] };
  const inFlight = h.gateBackend();
  const pendingA = A.call('enqueue_recipes', plan);
  await inFlight.inside;
  clock.t += 5_000;
  const b1 = errorOf(await B.call('enqueue_recipes', plan));
  assert.equal(b1.code, 'queue_acceptance_unknown'); assert.equal(b1.details.enqueueSent, false);
  const bl = ok(await B.call('lookup_enqueue', { requestKey: 'shared-intent' }));
  assert.equal(bl.status, 'unknown'); assert.deepEqual(bl.settlement, { state: 'settling', retryAfterSeconds: 130, unknownObservedForSeconds: 0, newKeyAdvised: false });
  clock.t += 100_000;
  assert.equal(ok(await B.call('lookup_enqueue', { requestKey: 'shared-intent' })).settlement.newKeyAdvised, false);
  inFlight.release(); await pendingA;
  clock.t += 40_000;
  const settled = ok(await B.call('lookup_enqueue', { requestKey: 'shared-intent' }));
  assert.equal(settled.status, 'enqueued'); assert.equal(settled.batch.batchId, h.jobs[0].job.batchId);
  assert.equal(h.jobs.length, 1, 'no duplicate batch');
});

test('p3 A: the settle window runs on the monotonic clock; a wall-clock jump of one hour never advises a new key, only monotonic time past the window does', async t => {
  const h = await realHost(t);
  const wall = { t: 1_700_000_000_000 }, mono = { t: 50_000 };
  const { call, readRecipe } = await connect(t, h.bridge, { recipeQueue: { now: () => wall.t, monotonicNow: () => mono.t } });
  const prepared = ok(await call('prepare_recipe', t2i()));
  h.backend.failNext = new Error('backend connection dropped');
  assert.equal(errorOf(await call('enqueue_recipes', { requestKey: 'jump', items: [{ ...ref(prepared), seeds: [1] }] })).code, 'queue_acceptance_unknown');
  const first = ok(await call('lookup_enqueue', { requestKey: 'jump' }));
  assert.deepEqual(first.settlement, { state: 'settling', retryAfterSeconds: 130, unknownObservedForSeconds: 0, newKeyAdvised: false });
  // Laptop sleep, NTP or a manual change: the wall clock jumps one hour, monotonic time does not move.
  wall.t += 3_600_000;
  const jumped = ok(await call('lookup_enqueue', { requestKey: 'jump' }));
  assert.equal(jumped.status, 'unknown');
  assert.deepEqual(jumped.settlement, { state: 'settling', retryAfterSeconds: 130, unknownObservedForSeconds: 0, newKeyAdvised: false });
  assert.doesNotMatch(jumped.instruction, /NEW requestKey/);
  // Host stuck beyond the window: monotonic time past the window still yields stale with a new-key advice.
  mono.t += 130_000;
  const stale = ok(await call('lookup_enqueue', { requestKey: 'jump' }));
  assert.deepEqual(stale.settlement, { state: 'stale', unknownObservedForSeconds: 130, newKeyAdvised: true });
  assert.match(stale.instruction, /NEW requestKey/);
});

nodeTest('p3 A: the default window clock ignores Date.now; only an injected monotonic clock or real elapsed time moves it', async t => {
  const h = await realHost(t);
  // Date.now is replaced before the queue exists, so a default that captured Date.now would see the jump too.
  const realNow = Date.now, wall = { offset: 0 };
  Date.now = () => realNow() + wall.offset;
  try {
    const queue = recipeQueue.createRecipeQueue({ bridge: h.bridge });
    const prepared = await queue.prepare(t2i());
    h.backend.failNext = new Error('backend connection dropped');
    await assert.rejects(queue.enqueue({ requestKey: 'jump-default', items: [{ ...ref(prepared), seeds: [1] }] }), error => error.code === 'queue_acceptance_unknown');
    assert.equal((await queue.lookup({ requestKey: 'jump-default' })).settlement.state, 'settling');
    wall.offset = 3_600_000;
    const jumped = await queue.lookup({ requestKey: 'jump-default' });
    assert.equal(jumped.settlement.state, 'settling'); assert.equal(jumped.settlement.newKeyAdvised, false);
  } finally { Date.now = realNow; }
  assert.throws(() => recipeQueue.createRecipeQueue({ bridge: h.bridge, monotonicNow: 5 }), /Invalid settle clock/);
});

test('p3 B: after a restart (or from another process) a first not_found gets a full settle window; after the window a second not_found is clear', async t => {
  const h = await realHost(t);
  const clock = { t: 7_000_000 };
  const A = await connect(t, h.bridge, { recipeQueue: { monotonicNow: () => clock.t } });
  const prepared = ok(await A.call('prepare_recipe', t2i()));
  const plan = { requestKey: 'night-restart', items: [{ ...ref(prepared), seeds: [1] }] };
  // The request times out on the way and has not reached the host; then the agent restarts.
  h.faults.enqueue_queue_recipes = 'held';
  assert.equal(errorOf(await A.call('enqueue_recipes', plan)).code, 'queue_acceptance_unknown');
  const B = await connect(t, h.bridge, { recipeQueue: { monotonicNow: () => clock.t } });
  const first = ok(await B.call('lookup_enqueue', { requestKey: 'night-restart' }));
  assert.equal(first.status, 'not_found');
  assert.deepEqual(first.settlement, { state: 'settling', retryAfterSeconds: 130, newKeyAdvised: false });
  assert.match(first.instruction, /Resending the same plan with the same requestKey right now is safe \(the host deduplicates it\)/);
  assert.match(first.instruction, /Before changing the plan or switching to a new requestKey, wait about 130 seconds and look up this same requestKey again/);
  assert.match(first.instruction, /If it is still not_found after that, changing the plan or the requestKey is fine/);
  // Looking again inside the window never shortens it.
  clock.t += 60_000;
  const inside = ok(await B.call('lookup_enqueue', { requestKey: 'night-restart' }));
  assert.deepEqual(inside.settlement, { state: 'settling', retryAfterSeconds: 70, newKeyAdvised: false });
  clock.t += 70_000;
  const clear = ok(await B.call('lookup_enqueue', { requestKey: 'night-restart' }));
  assert.equal(clear.status, 'not_found');
  assert.deepEqual(clear.settlement, { state: 'clear', notFoundObservedForSeconds: 130, newKeyAdvised: false });
  assert.match(clear.instruction, /Changing the plan or switching to a new requestKey is fine now/);
  assert.match(clear.instruction, /can still be accepted late, which would duplicate the images; before switching keys you can check list_queue/);
  // The same-process dispatch path keeps its behaviour: A dispatched the key, so its not_found carries A's dispatch window.
  const own = ok(await A.call('lookup_enqueue', { requestKey: 'night-restart' }));
  assert.equal(own.status, 'not_found'); assert.equal(own.settlement, undefined);
  assert.match(own.instruction, /Before changing the plan, look up this same requestKey again; a different plan needs a different key/);
  // A late arrival after all is reported as enqueued and resets the not_found clock.
  await h.releaseHeld();
  const late = ok(await B.call('lookup_enqueue', { requestKey: 'night-restart' }));
  assert.equal(late.status, 'enqueued'); assert.equal(late.settlement, undefined);
  assert.equal(h.jobs.length, 1);
});

test('p3 B: resending the same plan under the same key inside a fresh not_found window is accepted once and not duplicated', async t => {
  const h = await realHost(t);
  const clock = { t: 3_000_000 };
  const { call, readRecipe } = await connect(t, h.bridge, { recipeQueue: { monotonicNow: () => clock.t } });
  const prepared = ok(await call('prepare_recipe', t2i()));
  const look = ok(await call('lookup_enqueue', { requestKey: 'fresh-1' }));
  assert.deepEqual(look.settlement, { state: 'settling', retryAfterSeconds: 130, newKeyAdvised: false });
  const plan = { requestKey: 'fresh-1', items: [{ ...ref(prepared), seeds: [4] }] };
  assert.equal(ok(await call('enqueue_recipes', plan)).status, 'enqueued');
  assert.equal(ok(await call('enqueue_recipes', plan)).status, 'already_enqueued');
  const after = ok(await call('lookup_enqueue', { requestKey: 'fresh-1' }));
  assert.equal(after.status, 'enqueued'); assert.equal(after.settlement, undefined);
  assert.equal(h.jobs.length, 1);
  // A key this process already saw unknown (never dispatched here) keeps the existing not_found behaviour: no fresh window.
  h.faults.lookup_queue_request = () => ({ batch: null, status: 'unknown' });
  assert.equal(ok(await call('lookup_enqueue', { requestKey: 'seen-unknown' })).settlement.state, 'settling');
  h.faults.lookup_queue_request = () => ({ batch: null });
  for (const step of [0, 1_000]) {
    clock.t += step;
    const look = ok(await call('lookup_enqueue', { requestKey: 'seen-unknown' }));
    assert.equal(look.status, 'not_found'); assert.equal(look.settlement, undefined);
    assert.match(look.instruction, /Before changing the plan, look up this same requestKey again; a different plan needs a different key/);
  }
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

test('p3 R1: a same-process lookup landing before the host records the plan makes the host abandon the dispatch; stale after the window, one batch under the new key', async t => {
  const h = await realHost(t);
  const clock = { t: 2_000_000 };
  const { call, readRecipe } = await connect(t, h.bridge, { recipeQueue: { monotonicNow: () => clock.t } });
  const prepared = ok(await call('prepare_recipe', t2i()));
  const plan = key => ({ requestKey: key, items: [{ ...ref(prepared), seeds: [7] }] });
  const gate = receiptGate();
  try {
    h.faults.enqueue_queue_recipes = 'timeout-host-continues';
    assert.equal(errorOf(await call('enqueue_recipes', plan('race-1'))).code, 'queue_acceptance_unknown');
    await gate.inside;
    const look = ok(await call('lookup_enqueue', { requestKey: 'race-1' }));
    assert.equal(look.status, 'unknown'); assert.equal(look.settlement.state, 'settling'); assert.equal(look.settlement.newKeyAdvised, false);
  } finally { gate.release(); gate.restore(); }
  const [outcome] = await Promise.allSettled(h.background);
  assert.equal(outcome.status, 'rejected'); assert.equal(outcome.reason.code, 'queue_storage_failed');
  assert.equal(outcome.reason.message, recipeQueue.RECEIPT_TRANSITION_MESSAGE);
  assert.equal(h.jobs.length, 0, 'the host abandoned the dispatch');
  clock.t += 60_000;
  assert.equal(ok(await call('lookup_enqueue', { requestKey: 'race-1' })).settlement.state, 'settling');
  clock.t += 70_000;
  const stale = ok(await call('lookup_enqueue', { requestKey: 'race-1' }));
  assert.deepEqual(stale.settlement, { state: 'stale', unknownObservedForSeconds: 130, newKeyAdvised: true });
  assert.equal(ok(await call('enqueue_recipes', plan('race-1b'))).status, 'enqueued');
  assert.equal(ok(await call('lookup_enqueue', { requestKey: 'race-1' })).status, 'unknown', 'the abandoned receipt never changes');
  assert.equal(h.jobs.length, 1);
});

test('p3 R2: another process looking up in that gap makes the host abandon the dispatch; the caller is told so, without a full-store or may-still-accept claim', async t => {
  const h = await realHost(t);
  const clock = { t: 4_000_000 };
  const A = await connect(t, h.bridge, { recipeQueue: { monotonicNow: () => clock.t } });
  const B = await connect(t, h.bridge, { recipeQueue: { monotonicNow: () => clock.t } });
  const prepared = ok(await A.call('prepare_recipe', t2i()));
  const gate = receiptGate();
  let pendingA;
  try {
    pendingA = A.call('enqueue_recipes', { requestKey: 'race-2', items: [{ ...ref(prepared), seeds: [7] }] });
    await gate.inside;
    const lookB = ok(await B.call('lookup_enqueue', { requestKey: 'race-2' }));
    assert.equal(lookB.status, 'unknown'); assert.equal(lookB.settlement.newKeyAdvised, false);
  } finally { gate.release(); gate.restore(); }
  const refusal = errorOf(await pendingA);
  assert.equal(refusal.code, 'queue_storage_failed');
  assert.equal(refusal.details.keyStatus, 'unknown'); assert.equal(refusal.details.abandoned, true); assert.equal(refusal.details.enqueueSent, true);
  assert.match(refusal.message, /host abandoned this dispatch/); assert.match(refusal.message, /nothing was queued/);
  assert.match(refusal.message, /reports stale, and then enqueue the same plan under a new requestKey/);
  assert.doesNotMatch(refusal.message, /store is full|archiving|can still turn into accepted/);
  assert.equal(ok(await A.call('lookup_enqueue', { requestKey: 'race-2' })).settlement.state, 'settling');
  clock.t += 131_000;
  assert.equal(ok(await A.call('lookup_enqueue', { requestKey: 'race-2' })).settlement.newKeyAdvised, true);
  assert.equal(ok(await B.call('lookup_enqueue', { requestKey: 'race-2' })).settlement.newKeyAdvised, true);
  assert.equal(h.jobs.length, 0);
});

test('p3: a lookup that itself collides with a receipt transition says to look up the same key again later', async t => {
  const h = await realHost(t);
  const { call, readRecipe } = await connect(t, h.bridge);
  h.faults.lookup_queue_request = { before: async () => { throw new BridgeError('queue_storage_failed', recipeQueue.RECEIPT_TRANSITION_MESSAGE); } };
  const failed = errorOf(await call('lookup_enqueue', { requestKey: 'collide' }));
  assert.equal(failed.code, 'queue_storage_failed');
  assert.match(failed.message, /Only the lookup failed; nothing was sent\. Look up the same requestKey again in a few seconds; do not resend and do not switch keys/);
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

test('p3: any lookup result other than not_found resets the first-not_found clock of an unseen key', async t => {
  const h = await realHost(t);
  const clock = { t: 6_000_000 };
  const A = await connect(t, h.bridge, { recipeQueue: { monotonicNow: () => clock.t } });
  const B = await connect(t, h.bridge, { recipeQueue: { monotonicNow: () => clock.t } });
  const prepared = ok(await A.call('prepare_recipe', t2i()));
  assert.deepEqual(ok(await A.call('lookup_enqueue', { requestKey: 'reset-1' })).settlement, { state: 'settling', retryAfterSeconds: 130, newKeyAdvised: false });
  // Another process enqueues the key; A sees it enqueued.
  assert.equal(ok(await B.call('enqueue_recipes', { requestKey: 'reset-1', items: [{ ...ref(prepared), seeds: [1] }] })).status, 'enqueued');
  clock.t += 100_000;
  assert.equal(ok(await A.call('lookup_enqueue', { requestKey: 'reset-1' })).status, 'enqueued');
  // If the host later answers not_found again, A starts a fresh full window instead of the 30 s left on the old one.
  h.faults.lookup_queue_request = () => ({ batch: null });
  assert.deepEqual(ok(await A.call('lookup_enqueue', { requestKey: 'reset-1' })).settlement, { state: 'settling', retryAfterSeconds: 130, newKeyAdvised: false });
  // Same for a rejected answer.
  assert.equal(ok(await A.call('lookup_enqueue', { requestKey: 'reset-2' })).settlement.retryAfterSeconds, 130);
  clock.t += 100_000;
  h.faults.lookup_queue_request = () => ({ batch: null, status: 'rejected', error: { code: 'invalid_argument', message: 'bad' } });
  assert.equal(ok(await A.call('lookup_enqueue', { requestKey: 'reset-2' })).status, 'rejected');
  h.faults.lookup_queue_request = () => ({ batch: null });
  assert.deepEqual(ok(await A.call('lookup_enqueue', { requestKey: 'reset-2' })).settlement, { state: 'settling', retryAfterSeconds: 130, newKeyAdvised: false });
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
  assert.match(refused.message, /nothing was queued/); assert.match(refused.message, /only resend the same plan with the same requestKey/);
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
  const unknown = errorOf(await call('enqueue_recipes', { requestKey: otherKey, items: [{ ...ref(prepared), seeds: [2] }] }));
  assert.equal(unknown.code, 'queue_acceptance_unknown'); assert.equal(unknown.details.requestKey, otherKey);
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
  h.faults.enqueue_queue_recipes = reply => ({ ...reply, intervalSeconds: 9 });
  assert.equal(errorOf(await call('enqueue_recipes', { requestKey: 'interval-reply', intervalSeconds: 5, items: [{ ...ref(prepared), seeds: [1] }] })).code, 'queue_acceptance_unknown');
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
