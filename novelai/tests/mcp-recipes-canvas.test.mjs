import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// prepare_recipe {canvas}: the canvas capture through the REAL host capture (client/electron/canvas-recipe-capture.ts)
// and the REAL recipe store (client/electron/queue-recipe-service.ts), loaded through jiti over a temporary runtime.
// The renderer is a double answering collect_canvas_preparation with what the real controller returns (the renderer
// side, with the real controller and bridge, is covered by client/electron/canvas-queue-e2e.test.ts). Offline: fetch
// refused, nothing reads .runtime.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Real network access is forbidden in canvas recipe tests.'); };
const { createJiti } = await import('jiti');
const clientRequire = createRequire(fileURLToPath(new URL('../client/package.json', import.meta.url)));
const { PNG } = clientRequire('pngjs');
const merged = await import('../src/mcp.mjs');
const { BridgeError } = merged;

let host, fixtureDir;
before(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'novelai-recipes-canvas-host-'));
  const electron = join(fixtureDir, 'electron.mjs'), axios = join(fixtureDir, 'axios.mjs');
  await writeFile(electron, `import { createRequire } from 'node:module';
const { PNG } = createRequire(${JSON.stringify(fileURLToPath(new URL('../client/package.json', import.meta.url)))})('pngjs');
const forbidden = () => { throw new Error('canvas recipe fixture cannot access native UI or account paths'); };
function make(png) { return {
  isEmpty: () => !png, getSize: () => ({ width: png.width, height: png.height }),
  resize({ width, height }) { const out = new PNG({ width, height }); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const sx = Math.min(png.width - 1, Math.floor(x * png.width / width)), sy = Math.min(png.height - 1, Math.floor(y * png.height / height)); png.data.copy(out.data, (y * width + x) * 4, (sy * png.width + sx) * 4, (sy * png.width + sx) * 4 + 4); } return make(out); },
  toPNG: () => PNG.sync.write(png) }; }
export const nativeImage = { createFromBuffer(buffer) { try { return make(PNG.sync.read(Buffer.from(buffer))); } catch { return { isEmpty: () => true }; } }, createFromPath: forbidden };
export const app = { getPath: forbidden, getVersion: forbidden }; export const dialog = {};`);
  await writeFile(axios, `const forbidden = () => { throw new Error('canvas recipe fixture cannot access the network'); };
export default { get: forbidden, post: forbidden, request: forbidden, create: forbidden };`);
  const jiti = createJiti(import.meta.url, { moduleCache: true, fsCache: false, alias: { electron, axios } });
  const modules = [];
  for (const file of ['electron/queue-recipe-service.ts', 'electron/canvas-recipe-capture.ts', 'electron/queue-bridge-error.ts', 'src/workspace/prompt-review.ts', 'src/types.ts'])
    modules.push(await jiti.import(fileURLToPath(new URL(`../client/${file}`, import.meta.url))));
  const [service, capture, bridgeError, review, types] = modules;
  host = { createQueueRecipeService: service.createQueueRecipeService, createCanvasRecipeCapture: capture.createCanvasRecipeCapture, queueBridgeError: bridgeError.queueBridgeError, authoredPromptReview: review.authoredPromptReview, DEFAULT_PARAMS: types.DEFAULT_PARAMS };
});
after(async () => { globalThis.fetch = originalFetch; if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true }); });

const png = (width, height, paint) => { const image = new PNG({ width, height }); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) image.data.set(paint(x, y), (y * width + x) * 4); return PNG.sync.write(image); };
const gradient = (width, height) => png(width, height, (x, y) => [(x * 7) & 255, (y * 5) & 255, 120, 255]);
const rectMask = (width, height) => png(width, height, (x, y) => x >= width / 4 && x < width * 3 / 4 && y >= height / 4 && y < height / 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]);
const json = value => JSON.parse(JSON.stringify(value));
const WORKSPACE = `novelai-${randomUUID()}`;

/** A canvas state as the renderer's collectPromptReview would read it. */
function canvasState(overrides = {}) {
  return { params: { ...host.DEFAULT_PARAMS, model: 'nai-diffusion-4-5-full', positivePrompt: '1girl, garden', negativePrompt: 'blurry', stylePrompt: '', width: 832, height: 1216, steps: 28, cfgScale: 5, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', seed: 4321, seedMode: 'fixed', ucPreset: 0, qualityToggle: true, promptAssemblyVersion: 1, ...(overrides.params ?? {}) },
    i2iParams: { strength: 0.6, noise: 0, extraNoiseSeed: 0 }, charCaptions: [], vibeImages: [], preciseReferences: [], inpaintRecipe: null, inpaintModel: 'nai-diffusion-4-5-full-inpainting', inpaintStrength: 0.8, augmentOptions: { defry: 0, colorizePrompt: '', emotion: 'happy', emotionLevel: 0 },
    enhanceMagnitude: 3, enhanceScale: 1, upscaleScale: 2, directorTool: 'bg-removal', i2iSizeMode: 'manual', ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'params')) };
}

/**
 * Real recipe store + real capture over a temporary runtime. canvas.state / canvas.images / canvas.revision drive the
 * renderer double; canvas.fail makes it refuse. faults[method](result) rewrites a host reply.
 */
async function realHost(t) {
  const base = await mkdtemp(join(tmpdir(), 'novelai-recipes-canvas-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const runtimeDir = join(base, 'runtime'); await mkdir(runtimeDir);
  const jobs = [];
  const batch = { ready: Promise.resolve(),
    async enqueue(args) { const job = { batchId: randomUUID(), requestKey: args.requestKey, execution: args.execution, status: 'queued', count: args.count, intervalSeconds: args.intervalSeconds, originWorkspaceId: args.workspaceId, submittedRevision: args.expectedRevision, mode: args.mode, activeJobId: null, items: args.seeds.map((seed, index) => ({ index, status: 'pending', jobId: null, results: [] })) }; jobs.push({ job, args: json(args) }); return structuredClone(job); },
    lookup: args => structuredClone(jobs.find(entry => entry.job.requestKey === args.requestKey)?.job ?? null),
    list: () => ({ batches: jobs.map(entry => structuredClone(entry.job)) }),
    read: args => structuredClone(jobs.find(entry => entry.job.batchId === args.batchId)?.job) };
  const service = host.createQueueRecipeService({ runtimeDir, batch, randomSeed: () => 777 });
  const canvas = { revision: 3, state: canvasState(), images: {}, fail: null, collected: [] };
  const collect = async args => {
    canvas.collected.push(json(args));
    if (canvas.fail) throw canvas.fail;
    const state = args.patch ? { ...canvas.state, params: { ...canvas.state.params, ...(args.patch.params ?? {}) } } : canvas.state;
    const assets = Object.entries(canvas.images).map(([role, bytes]) => ({ role, mimeType: 'image/png', data: bytes.toString('base64') }));
    return { schemaVersion: 1, workspaceId: WORKSPACE, revision: canvas.answerRevision ?? canvas.revision, mode: args.mode, draftId: args.draftId ?? null, patched: args.patch !== undefined,
      ...(canvas.unappliedDraftId !== undefined ? { unappliedDraftId: args.draftId ? null : canvas.unappliedDraftId } : {}), preparation: { mode: args.mode, authored: host.authoredPromptReview(state), assets } };
  };
  const captureCanvas = host.createCanvasRecipeCapture({ collect, put: args => service.put_canvas_recipe(args), preview: args => service.preview_canvas_recipe(args), now: () => new Date('2026-11-02T10:00:00.000Z') });
  const methods = { ...service, capture_canvas_recipe: captureCanvas };
  const calls = [], faults = {};
  const bridge = { async call(method, args) {
    calls.push({ method, args: json(args) });
    let result;
    try { if (typeof methods[method] !== 'function') throw new BridgeError('unsupported_method', 'No such host method.'); result = json(await methods[method](json(args))); }
    catch (error) { if (error instanceof BridgeError) throw error; const bridged = host.queueBridgeError(error); throw new BridgeError(bridged.code, bridged.message, bridged.details); }
    if (faults[method]) { const fault = faults[method]; delete faults[method]; result = json(fault(result)); }
    return result;
  } };
  const records = async () => (await readdir(join(runtimeDir, 'queue-recipes')).catch(() => [])).filter(name => /^[a-f0-9-]{36}\.\d+\.json$/.test(name));
  return { service, canvas, bridge, calls, faults, jobs, records };
}
async function connect(t, bridgeClient) {
  const server = merged.createNovelAiMcpServer({ bridgeClient });
  const client = new Client({ name: 'recipes-canvas-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return (name, args) => client.callTool({ name, arguments: fullDetail(name, args) });
}
// The assertions of this file read the full readback; the compact default has its own tests (search "compact readback").
const fullDetail = (name, args) => name === 'prepare_recipe' && args !== null && typeof args === 'object' && !Array.isArray(args) && args.detail === undefined ? { ...args, detail: 'full' } : args;
const ok = result => { assert.ok(!result.isError, JSON.stringify(result.structuredContent ?? result).slice(0, 3000)); return result.structuredContent; };
const errorOf = result => { assert.equal(result.isError, true, JSON.stringify(result.structuredContent ?? result).slice(0, 3000)); return result.structuredContent.error; };
const ref = recipe => ({ recipeId: recipe.recipeId, recipeRevision: recipe.recipeRevision, inputHash: recipe.inputHash });
const at = (expectedRevision = 3, extra = {}) => ({ workspaceId: WORKSPACE, expectedRevision, ...extra });

test('t2i: the canvas becomes a new recipe with canvas lineage; only the images the mode uses are kept; it enqueues like any recipe', async t => {
  const h = await realHost(t), call = await connect(t, h.bridge);
  h.canvas.images = { source: gradient(64, 64), mask: rectMask(64, 64) };
  const recipe = ok(await call('prepare_recipe', { mode: 't2i', canvas: at() }));
  assert.deepEqual(h.calls.map(item => item.method), ['capture_canvas_recipe'], 'one host call');
  assert.deepEqual(h.calls[0].args, { workspaceId: WORKSPACE, expectedRevision: 3, mode: 't2i' });
  assert.deepEqual(h.canvas.collected, [{ workspaceId: WORKSPACE, expectedRevision: 3, mode: 't2i' }]);
  assert.equal(recipe.lineage, 'canvas');
  assert.deepEqual(recipe.canvas, { workspaceId: WORKSPACE, revision: 3, draftId: null, patched: false, capturedAt: '2026-11-02T10:00:00.000Z' });
  assert.equal(recipe.recipeRevision, 1); assert.equal(recipe.saved, true); assert.equal(recipe.ready, true);
  assert.deepEqual(recipe.assets, [], 't2i keeps neither the workbench image nor the mask');
  assert.equal(recipe.source, undefined);
  assert.equal(recipe.effective.positivePrompt, '1girl, garden, very aesthetic, masterpiece, no text');
  assert.equal(recipe.effective.seed, 4321); assert.equal(recipe.effective.width, 832);
  assert.deepEqual(recipe.warnings, [], 'a canvas capture prepared by prepare_recipe has no warnings');
  assert.equal((await h.records()).length, 1);
  // The stored record names its origin; the inputHash is that of the same preparation stored without it.
  const stored = json(await h.service.read_queue_recipe({ recipeId: recipe.recipeId, recipeRevision: 1 }));
  assert.deepEqual(stored.canvasOrigin, recipe.canvas);
  const plain = json(await h.service.put_queue_recipe({ preparation: { mode: 't2i', authored: host.authoredPromptReview(h.canvas.state), assets: [] } }));
  assert.equal(plain.inputHash, recipe.inputHash, 'canvasOrigin is not part of inputHash');
  assert.equal(plain.canvasOrigin, undefined);
  const receipt = ok(await call('enqueue_recipes', { requestKey: 'canvas-t2i', items: [{ ...ref(recipe), count: 2, seeds: [5, 6] }] }));
  assert.equal(receipt.status, 'enqueued');
  assert.equal(receipt.warnings, undefined, 'no warning for a canvas recipe');
  assert.equal(h.jobs[0].args.mode, 't2i'); assert.deepEqual(h.jobs[0].args.seeds, [5, 6]);
});

test('compact readback of a canvas recipe: its texts are stated once (authoredPrompts, characters); image modes keep the source and mask without hashes or spec', async t => {
  const h = await realHost(t), call = await connect(t, h.bridge);
  h.canvas.state = canvasState({ params: { stylePrompt: 'ink wash, muted palette', positivePrompt: 'a lighthouse on a cliff at dusk', negativePrompt: 'blurry, text' },
    charCaptions: [{ prompt: 'keeper, long coat', negativePrompt: 'hat', useCoords: true, x: 0.4, y: 0.6 }, { prompt: 'black cat', negativePrompt: '', useCoords: true, x: 0.7, y: 0.8 }] });
  const full = ok(await call('prepare_recipe', { mode: 't2i', canvas: at(), preview: true }));
  const compact = ok(await call('prepare_recipe', { mode: 't2i', canvas: at(), preview: true, detail: 'compact' }));
  assert.deepEqual(h.calls.at(-1).args, { workspaceId: WORKSPACE, expectedRevision: 3, mode: 't2i', preview: true }, 'detail never reaches the host');
  assert.deepEqual([compact.lineage, compact.inputHash, compact.detail, compact.preview], ['canvas', full.inputHash, 'compact', true]);
  assert.deepEqual(compact.canvas, full.canvas);
  assert.deepEqual(compact.authoredPrompts, { stylePrompt: 'ink wash, muted palette', positivePrompt: 'a lighthouse on a cliff at dusk', negativePrompt: 'blurry, text' });
  assert.deepEqual(compact.effective.characters, [{ index: 0, center: { x: 0.4, y: 0.6 }, prompt: 'keeper, long coat', negativePrompt: 'hat' }, { index: 1, center: { x: 0.7, y: 0.8 }, prompt: 'black cat' }]);
  assert.equal(full.effective.positivePrompt, ['ink wash, muted palette', 'a lighthouse on a cliff at dusk', compact.effective.automaticQuality.appendedText].join(', '));
  assert.equal(full.effective.negativePrompt, ['blurry, text', compact.effective.ucPreset.text].join(', '));
  const text = JSON.stringify(compact);
  for (const once of ['ink wash, muted palette', 'a lighthouse on a cliff at dusk', 'blurry, text', 'keeper, long coat', 'black cat', compact.effective.ucPreset.text]) assert.equal(text.split(once).length - 1, 1, once);
  for (const key of ['authored', 'effectiveRequest', 'unusedInputs', 'assets']) assert.equal(Object.hasOwn(compact, key), false, key);
  t.diagnostic(`canvas t2i readback characters: compact ${text.length}, full ${JSON.stringify(full).length}`);

  const source = gradient(512, 768);
  h.canvas.state = canvasState({ params: { width: 512, height: 768 }, inpaintPositivePrompt: 'a red umbrella' });
  h.canvas.images = { source, mask: rectMask(512, 768) };
  const preview = await call('prepare_recipe', { mode: 'inpaint', canvas: at(), preview: true, detail: 'compact' });
  const inpaint = ok(preview);
  assert.equal(preview.content.filter(item => item.type === 'image').length, 1, 'the mask overlay is still attached');
  assert.equal(inpaint.previewImage.imageAttached, true); assert.equal(Object.hasOwn(inpaint.previewImage, 'data'), false);
  assert.deepEqual(inpaint.source, { kind: 'embedded', width: 512, height: 768 });
  assert.deepEqual(Object.keys(inpaint.mask), ['width', 'height', 'selectedCells', 'totalCells', 'bboxCells', 'layers']);
  assert.deepEqual(inpaint.effective.requestSource, { width: 512, height: 768 }); assert.deepEqual(Object.keys(inpaint.effective.requestMask), ['width', 'height']);
  assert.equal(inpaint.authoredPrompts.positivePrompt, 'a red umbrella');
  const upscale = ok(await call('prepare_recipe', { mode: 'upscale', canvas: at(), preview: true, detail: 'compact' }));
  assert.deepEqual(upscale.effective, ok(await call('prepare_recipe', { mode: 'upscale', canvas: at(), preview: true })).effective, 'a post-processing view is small and stays whole');
  assert.equal(Object.hasOwn(upscale, 'authoredPrompts'), false);
});

test('a V5 Full canvas on Medium effort is captured as the Medium request; the readback names what Medium replaced', async t => {
  const h = await realHost(t), call = await connect(t, h.bridge);
  h.canvas.state = canvasState({ params: { model: 'nai-diffusion-5-full', effort: 'medium', steps: 28, sampler: 'k_dpmpp_2m', ucPreset: 2 }, charCaptions: [{ prompt: 'girl', negativePrompt: 'hat', useCoords: false, x: 0.5, y: 0.5 }] });
  const recipe = ok(await call('prepare_recipe', { mode: 't2i', canvas: at() }));
  assert.equal(recipe.effective.model, 'nai-diffusion-5-full-medium');
  assert.deepEqual([recipe.effective.steps, recipe.effective.sampler, recipe.effective.ucPreset.preset, recipe.effective.effort.level], [14, 'k_euler_ancestral', 0, 'medium']);
  assert.equal(recipe.authored.effort, 'medium');
  assert.deepEqual(recipe.warnings.map(warning => warning.code), ['effort_medium_fixed']);
  assert.match(recipe.warnings[0].message, /steps 28 → 14, sampler "k_dpmpp_2m" → "k_euler_ancestral", ucPreset 2 → 0, negativePrompt \(not sent\), character negativePrompt \(not sent\)/);
  // Medium on a model without it (left from V5 Full on the canvas) runs High, and says so.
  h.canvas.state = canvasState({ params: { effort: 'medium' } });
  const high = ok(await call('prepare_recipe', { mode: 't2i', canvas: at(), preview: true }));
  assert.equal(high.effective.model, 'nai-diffusion-4-5-full');
  assert.deepEqual(high.warnings.map(warning => warning.code), ['effort_not_applied']);
  assert.ok(high.unusedInputs.includes('params.effort'));
});

test('draftId and a detached patch are read, never adopted; their identity is checked and recorded', async t => {
  const h = await realHost(t), call = await connect(t, h.bridge);
  const drafted = ok(await call('prepare_recipe', { mode: 't2i', canvas: at(3, { draftId: 'draft-1' }) }));
  assert.equal(h.canvas.collected.at(-1).draftId, 'draft-1');
  assert.deepEqual([drafted.canvas.draftId, drafted.canvas.patched], ['draft-1', false]);
  const patched = ok(await call('prepare_recipe', { mode: 't2i', canvas: at(3, { patch: { params: { positivePrompt: 'a lighthouse' } } }) }));
  assert.deepEqual(h.canvas.collected.at(-1).patch, { params: { positivePrompt: 'a lighthouse' } });
  assert.deepEqual([patched.canvas.draftId, patched.canvas.patched], [null, true]);
  assert.equal(patched.authored.positivePrompt, 'a lighthouse');
  // The renderer must answer for exactly the requested state.
  h.canvas.answerRevision = 4;
  const mismatch = errorOf(await call('prepare_recipe', { mode: 't2i', canvas: at() }));
  assert.equal(mismatch.code, 'canvas_capture_mismatch'); assert.equal(mismatch.details.saved, false);
  assert.equal((await h.records()).length, 2, 'a mismatching answer saves nothing');
});

test('without draftId beside an unapplied draft, the readback warns that the visible state (not the draft) was captured', async t => {
  const h = await realHost(t), call = await connect(t, h.bridge);
  const plain = ok(await call('prepare_recipe', { mode: 't2i', canvas: at() }));
  assert.equal(plain.warnings.some(item => item.code === 'canvas_draft_not_captured'), false, 'an older renderer without the notice: no warning');
  h.canvas.unappliedDraftId = 'draft-7';
  for (const args of [{ mode: 't2i', canvas: at() }, { mode: 't2i', canvas: at(), preview: true }, { mode: 't2i', canvas: at(3, { patch: { params: { positivePrompt: 'a lighthouse' } } }) }]) {
    const value = ok(await call('prepare_recipe', args));
    const warning = value.warnings.find(item => item.code === 'canvas_draft_not_captured');
    assert.ok(warning, JSON.stringify(value.warnings));
    assert.match(warning.message, /unapplied draft \(draft-7\); this recipe captured the visible canvas state/);
    assert.match(warning.message, /canvas\.draftId/);
    assert.equal(value.canvas.draftId, null, 'the notice is not part of the stored origin');
  }
  const drafted = ok(await call('prepare_recipe', { mode: 't2i', canvas: at(3, { draftId: 'draft-7' }) }));
  assert.equal(drafted.warnings.some(item => item.code === 'canvas_draft_not_captured'), false, 'the draft itself was captured');
  const stored = json(await h.service.read_queue_recipe({ recipeId: plain.recipeId, recipeRevision: 1 }));
  assert.equal(stored.unappliedDraftId, undefined);
  // A notice beside a requested draft, or a malformed one, is an inconsistent reply: nothing saved.
  const before = (await h.records()).length;
  h.canvas.unappliedDraftId = { id: 'draft-7' };
  assert.equal(errorOf(await call('prepare_recipe', { mode: 't2i', canvas: at() })).code, 'canvas_capture_mismatch');
  assert.equal((await h.records()).length, before);
});

test('a canvas on the historical prompt assembly (no promptAssemblyVersion) is captured as it is, not upgraded', async t => {
  const h = await realHost(t), call = await connect(t, h.bridge);
  const { promptAssemblyVersion: _omitted, ...legacy } = { ...canvasState().params, positivePrompt: '1girl, smile, 1girl', stylePrompt: 'smile, best quality', negativePrompt: '' };
  h.canvas.state = { ...canvasState(), params: legacy };
  for (const preview of [true, false]) {
    const value = ok(await call('prepare_recipe', { mode: 't2i', canvas: at(), ...(preview ? { preview: true } : {}) }));
    // The historical assembly folds the repeated tags (version 1 would send "smile, best quality, 1girl, smile, 1girl, …").
    assert.equal(value.effective.positivePrompt, 'smile, best quality, 1girl, very aesthetic, masterpiece, no text');
    assert.ok(value.warnings.some(item => item.code === 'readback_not_derived'), 'legacy assembly: quality text compared on the full prompt');
    if (!preview) {
      const stored = json(await h.service.read_queue_recipe({ recipeId: value.recipeId, recipeRevision: 1 }));
      assert.equal(Object.hasOwn(stored.snapshot.reviewInput.authored.params, 'promptAssemblyVersion'), false);
    }
  }
});

test('renderer refusals keep their code and say nothing was saved; a timeout becomes workspace_timeout', async t => {
  const h = await realHost(t), call = await connect(t, h.bridge);
  const refusal = (code, message, details) => Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
  for (const [failure, code] of [
    [refusal('conflict', 'The canvas is at revision 4, not 3: it changed. Read the workspace again and capture its current revision.', { expectedRevision: 3, currentRevision: 4 }), 'conflict'],
    [refusal('draft_not_found', 'The requested draft is no longer available.'), 'draft_not_found'],
    [refusal('workspace_busy', 'Finish the current mask stroke before capturing the canvas.'), 'workspace_busy'],
    [refusal('workspace_not_ready', '客户端画布尚未就绪。'), 'workspace_not_ready'],
    [refusal('timeout', '客户端响应超时'), 'workspace_timeout'],
    [refusal('internal_error', 'boom'), 'canvas_capture_failed'],
  ]) {
    h.canvas.fail = failure;
    const error = errorOf(await call('prepare_recipe', { mode: 't2i', canvas: at() }));
    assert.equal(error.code, code);
    assert.match(error.message, /[Nn]othing was saved/);
    assert.equal(error.details.saved, false); assert.equal(error.details.putOutcome, 'rejected');
    if (code === 'conflict') assert.equal(error.details.hostDetails.currentRevision, 4);
  }
  assert.deepEqual(await h.records(), []);
});

test('every invalid canvas argument is refused before any host call', async t => {
  const h = await realHost(t), call = await connect(t, h.bridge);
  for (const [args, reason] of [
    [{ mode: 't2i', canvas: at(), positivePrompt: 'x' }, 'field_not_with_canvas'],
    [{ mode: 't2i', canvas: at(), recipeId: randomUUID(), expectedRevision: 1 }, 'field_not_with_canvas'],
    [{ mode: 'i2i', canvas: at(), source: { kind: 'history', historyId: 'h', historyRevision: 1, assetId: 'a' } }, 'field_not_with_canvas'],
    [{ mode: 't2i', canvas: { workspaceId: WORKSPACE } }], [{ mode: 't2i', canvas: at(-1) }], [{ mode: 't2i', canvas: { ...at(), workspaceId: ' ' } }],
    [{ mode: 't2i', canvas: { ...at(), extra: 1 } }], [{ mode: 't2i', canvas: at(3, { draftId: 'd', patch: { params: {} } }) }],
    [{ mode: 'i2i', canvas: at(3, { patch: { params: { positivePrompt: 'x' } } }) }], [{ mode: 't2i', canvas: at(3, { patch: {} }) }],
    [{ mode: 't2i', canvas: at(3, { patch: { params: { positivePrompt: 'x' }, vibeImages: [] } }) }], [{ mode: 'outpaint', canvas: at() }],
    [{ mode: 't2i', canvas: at(), preview: 'yes' }],
  ]) {
    const error = errorOf(await call('prepare_recipe', args));
    assert.equal(error.code, 'invalid_arguments', JSON.stringify(args));
    if (reason) assert.equal(error.details?.reason, reason, JSON.stringify(args));
  }
  assert.deepEqual(h.calls, []);
});

test('image modes copy the canvas source (and the inpaint mask) in; preview saves nothing and shows the mask overlay', async t => {
  const h = await realHost(t), call = await connect(t, h.bridge);
  const source = gradient(512, 768);
  h.canvas.state = canvasState({ params: { width: 512, height: 768 }, inpaintPositivePrompt: 'a red umbrella' });
  h.canvas.images = { source, mask: rectMask(512, 768) };
  const i2i = ok(await call('prepare_recipe', { mode: 'i2i', canvas: at() }));
  assert.equal(i2i.lineage, 'canvas');
  assert.equal(i2i.source.kind, 'embedded', 'the canvas source is stored inline');
  assert.deepEqual([i2i.source.width, i2i.source.height], [512, 768]);
  assert.deepEqual(i2i.assets.map(asset => asset.role).sort(), ['request-source', 'source'], 'no mask outside inpaint');
  assert.equal(i2i.effective.i2i.strength, 0.6);
  const preview = await call('prepare_recipe', { mode: 'inpaint', canvas: at(), preview: true });
  const value = ok(preview);
  assert.equal(value.preview, true); assert.equal(value.saved, false); assert.equal(value.lineage, 'canvas');
  assert.deepEqual(value.canvas, { workspaceId: WORKSPACE, revision: 3, draftId: null, patched: false, capturedAt: '2026-11-02T10:00:00.000Z' });
  assert.equal(value.ready, true, JSON.stringify(value.readiness)); assert.equal(value.previewImage.imageAttached, true); assert.ok(value.previewImage.cells.selected > 0);
  assert.equal(preview.content.filter(item => item.type === 'image').length, 1);
  assert.match(value.next, /Change the mask on the canvas in the app/);
  assert.equal((await h.records()).length, 1, 'the preview saved nothing');
  const inpaint = ok(await call('prepare_recipe', { mode: 'inpaint', canvas: at() }));
  assert.equal(inpaint.mask.width, 512); assert.equal(inpaint.effective.inpaint.strength, 0.8);
  assert.equal(inpaint.source.kind, 'embedded');
  // A canvas whose inputs are incomplete is captured as a blocked recipe, which enqueue refuses.
  h.canvas.state = canvasState({ params: { width: 512, height: 768 } });
  const blocked = ok(await call('prepare_recipe', { mode: 'inpaint', canvas: at() }));
  assert.equal(blocked.ready, false); assert.match(blocked.next, /blocked/);
  // A canvas recipe is never revised: the next step is to edit the canvas and capture it again.
  assert.match(blocked.next, /cannot be revised: change the canvas in the app, then capture it again with prepare_recipe \{canvas\}/); assert.doesNotMatch(blocked.next, /new revision/);
  assert.equal(errorOf(await call('enqueue_recipes', { requestKey: 'canvas-blocked', items: [ref(blocked)] })).code, 'recipe_blocked');
});

test('references: refused for seeded modes, dropped for upscale and director (which never send them)', async t => {
  const h = await realHost(t), call = await connect(t, h.bridge);
  const source = gradient(64, 64);
  h.canvas.state = canvasState({ vibeImages: [{ name: 'v', base64: source.toString('base64'), infoExtracted: 1, strength: 0.6 }] });
  h.canvas.images = { source, 'vibeImages:0': source };
  const refused = errorOf(await call('prepare_recipe', { mode: 't2i', canvas: at() }));
  assert.equal(refused.code, 'unsupported_reference'); assert.equal(refused.details.saved, false);
  const upscale = ok(await call('prepare_recipe', { mode: 'upscale', canvas: at() }));
  assert.equal(upscale.lineage, 'canvas'); assert.equal(upscale.ready, true);
  assert.deepEqual(upscale.assets.map(asset => asset.role).sort(), ['request-source', 'source']);
});

test('a canvas recipe cannot be revised, through MCP or the host; a tampered reply is never adopted', async t => {
  const h = await realHost(t), call = await connect(t, h.bridge);
  const recipe = ok(await call('prepare_recipe', { mode: 't2i', canvas: at() }));
  const t2i = { mode: 't2i', model: 'nai-diffusion-4-5-full', width: 832, height: 1216, steps: 28, cfgScale: 5, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', ucPreset: 0, qualityPreset: 'standard', stylePrompt: '', positivePrompt: 'x', negativePrompt: '', seed: 1 };
  const revise = errorOf(await call('prepare_recipe', { ...t2i, recipeId: recipe.recipeId, expectedRevision: 1 }));
  assert.equal(revise.code, 'invalid_arguments'); assert.match(revise.message, /canvas lineage/);
  await assert.rejects(h.service.put_queue_recipe({ recipeId: recipe.recipeId, expectedRevision: 1, preparation: { mode: 't2i', authored: host.authoredPromptReview(h.canvas.state), assets: [] } }), /cannot be revised/);
  for (const tamper of [result => ({ ...result, canvasOrigin: { ...result.canvasOrigin, revision: 9 } }), result => ({ ...result, canvasOrigin: undefined }), result => ({ ...result, canvasOrigin: { ...result.canvasOrigin, draftId: 'other' } })]) {
    h.faults.capture_canvas_recipe = tamper;
    const error = errorOf(await call('prepare_recipe', { mode: 't2i', canvas: at() }));
    assert.equal(error.code, 'recipe_identity_unconfirmed', JSON.stringify(error));
  }
  h.faults.capture_canvas_recipe = result => ({ ...result, canvasOrigin: { ...result.canvasOrigin, revision: 'x' } });
  assert.equal(errorOf(await call('prepare_recipe', { mode: 't2i', canvas: at() })).code, 'recipe_identity_unconfirmed');
  // A transport failure is an unknown save outcome, never a resend; a preview says nothing was saved.
  const lost = await connect(t, { async call() { throw new BridgeError('timeout', 'The client request was interrupted or timed out.'); } });
  const unknown = errorOf(await lost('prepare_recipe', { mode: 't2i', canvas: at() }));
  assert.equal(unknown.code, 'recipe_save_unknown'); assert.equal(unknown.details.putOutcome, 'unknown'); assert.equal(unknown.details.hostCode, 'timeout');
  assert.match(unknown.message, /never resend automatically/);
  const lostPreview = errorOf(await lost('prepare_recipe', { mode: 't2i', canvas: at(), preview: true }));
  assert.equal(lostPreview.code, 'timeout'); assert.match(lostPreview.message, /This was a preview: nothing was saved/);
  // An older client without the capture method: host_outdated, nothing saved.
  const old = await connect(t, { async call(method) { throw new BridgeError('unsupported_method', '当前客户端未支持此操作。'); } });
  const outdated = errorOf(await old('prepare_recipe', { mode: 't2i', canvas: at() }));
  assert.equal(outdated.code, 'host_outdated'); assert.equal(outdated.details.saved, false);
});
