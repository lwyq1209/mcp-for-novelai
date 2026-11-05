import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// #28: the host's asset-library reader takes two history-image reads at once and refuses a third with image_busy
// (client/electron/asset-library-image.ts HISTORY_IMAGE_LIMITS.active). One MCP process therefore queues its own
// history-image reads (asset_library {action:"image"}) two at a time, and the recipe-source error text tells a busy
// refusal (from another process) apart from an identity problem. Offline: fetch refused, tag cache redirected; the
// host is a recording double that enforces the same two-read limit.
const tagCacheDir = await mkdtemp(join(tmpdir(), 'novelai-image-reads-cache-'));
const removeTagCache = () => rm(tagCacheDir, { recursive: true, force: true });
test.after(removeTagCache);
// When a top-level load below throws, node:test can exit without running after hooks or 'exit' listeners, so
// every such load goes through loadOrClean(), which removes the cache directory before rethrowing.
const loadOrClean = async load => { try { return await load(); } catch (error) { await removeTagCache(); throw error; } };
process.env.NOVELAI_TAG_QUERY_CACHE_DIR = tagCacheDir;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Real network access is forbidden in MCP tests.'); };
test.after(() => { globalThis.fetch = originalFetch; });

const { createNovelAiMcpServer, BridgeError } = await loadOrClean(() => import('../src/mcp.mjs'));
const { createSlotGate, guardBridge, hostCallScope, HISTORY_IMAGE_READ_SLOTS, isHistoryImageRead } = await loadOrClean(() => import('../src/business-guards.mjs'));
const { historyImageReadMessage, historyImageBusy } = await loadOrClean(() => import('../src/recipe-sources.mjs'));

const ENTRY = '12345678-1234-1234-1234-123456789abc';
const SOURCE = { kind: 'history', historyId: 'h-1', historyRevision: 1, assetId: 'a-1' };
const I2I = { mode: 'i2i', source: SOURCE, strength: 0.5, model: 'nai-diffusion-5-full', width: 832, height: 1216, steps: 28, cfgScale: 5,
  sampler: 'k_euler_ancestral', noiseSchedule: 'karras', ucPreset: 1, qualityPreset: 'standard', stylePrompt: '', positivePrompt: '1girl', negativePrompt: '', seed: 1 };
const IMAGE = { action: 'image', kind: 'history', id: 'h-1', revision: 1, assetId: 'a-1' };
const COVER = { action: 'set_cover_from_history', entryId: ENTRY, revision: 1, expectedCoverRevision: 0, historyId: 'h-1', historyRevision: 1, assetId: 'a-1' };
const tick = () => new Promise(resolve => setImmediate(resolve));
const errorOf = result => { assert.equal(result.isError, true, JSON.stringify(result.structuredContent ?? result)); return result.structuredContent.error; };

async function connect(t, bridgeClient) {
  const server = createNovelAiMcpServer({ bridgeClient });
  const client = new Client({ name: 'image-reads-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, call: (name, args, options) => client.callTool({ name, arguments: args }, undefined, options) };
}

/** A host double with the real reader's rule: at most two image reads at once, a third is refused with image_busy. */
function busyHost({ hold = false } = {}) {
  const state = { active: 0, peak: 0, images: [], other: [], busy: 0, pending: [] };
  const bridgeClient = { async call(method, args) {
    if (!isHistoryImageRead(method, args)) { state.other.push({ method, action: args?.action }); return method === 'asset_library' ? { items: [], total: 0, offset: 0, limit: 10, revision: 1 } : {}; }
    if (state.active >= 2) { state.busy++; throw new BridgeError('image_busy', '已有历史图片读取正在处理；未排队或重试。'); }
    state.active++; state.peak = Math.max(state.peak, state.active); state.images.push(args.variant ?? 'thumbnail');
    try {
      if (hold) await new Promise(resolve => state.pending.push(resolve));
      else await new Promise(resolve => setTimeout(resolve, 15));
      throw new BridgeError('stop', 'Recorded; this test stops after the read.');
    } finally { state.active--; }
  } };
  return { state, bridgeClient, releaseAll: () => { for (const resolve of state.pending.splice(0)) resolve(); } };
}

test('createSlotGate runs at most `limit` tasks, in FIFO order, and hands a freed slot to the next waiter', { timeout: 10_000 }, async () => {
  assert.throws(() => createSlotGate(0), TypeError);
  const gate = createSlotGate(2);
  const order = [], releases = [];
  const task = name => () => new Promise(resolve => { order.push(name); releases.push(resolve); });
  const runs = ['a', 'b', 'c', 'd'].map(name => gate.run(undefined, task(name)));
  await tick();
  assert.deepEqual(order, ['a', 'b']); assert.equal(gate.active, 2); assert.equal(gate.waiting, 2);
  releases[0]();
  await tick();
  // A newcomer arriving right after a release still queues behind the waiters.
  const late = gate.run(undefined, task('late'));
  await tick();
  assert.deepEqual(order, ['a', 'b', 'c']); assert.equal(gate.active, 2); assert.equal(gate.waiting, 2);
  for (let index = 1; index < 5; index++) { releases[index](); await tick(); }
  await Promise.all([...runs, late]);
  assert.deepEqual(order, ['a', 'b', 'c', 'd', 'late']);
  assert.equal(gate.active, 0); assert.equal(gate.waiting, 0);
});

test('createSlotGate: a waiter aborted in the queue never runs; an already aborted signal never runs; a failing task frees its slot', { timeout: 10_000 }, async () => {
  const gate = createSlotGate(1);
  let release;
  const first = gate.run(undefined, () => new Promise(resolve => { release = resolve; }));
  const controller = new AbortController();
  let ran = false;
  const queued = gate.run(controller.signal, async () => { ran = true; });
  await tick();
  assert.equal(gate.waiting, 1);
  controller.abort();
  await assert.rejects(queued, error => error instanceof BridgeError && error.code === 'aborted' && /nothing was sent/.test(error.message));
  assert.equal(gate.waiting, 0);
  await assert.rejects(gate.run(AbortSignal.abort(), async () => { ran = true; }), error => error.code === 'aborted');
  release(); await first;
  assert.equal(ran, false, 'neither aborted task ran');
  await assert.rejects(gate.run(undefined, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(gate.active, 0, 'a failed task released its slot');
  assert.equal(await gate.run(undefined, async () => 'next'), 'next');
});

test('the guarded bridge gates only asset_library {action:"image"}; other methods and actions pass at once', { timeout: 10_000 }, async () => {
  assert.equal(HISTORY_IMAGE_READ_SLOTS, 2);
  assert.equal(isHistoryImageRead('asset_library', { action: 'image' }), true);
  for (const [method, args] of [['asset_library', { action: 'list' }], ['asset_library', null], ['get_asset', { action: 'image' }], ['material_samples', { action: 'image' }]]) assert.equal(isHistoryImageRead(method, args), false, `${method} ${JSON.stringify(args)}`);
  const pending = [];
  const sent = [];
  const bridge = guardBridge({ async call(method, args) { sent.push(`${method}:${args.action}`); if (args.action === 'image') await new Promise(resolve => pending.push(resolve)); return { ok: true }; } });
  const scope = { tool: 'asset_library', allowed: new Set(['asset_library', 'list_queue']), denied: [] };
  await hostCallScope.run(scope, async () => {
    const reads = [1, 2, 3].map(() => bridge.call('asset_library', { action: 'image' }));
    await tick();
    assert.deepEqual(sent, ['asset_library:image', 'asset_library:image'], 'the third image read waits');
    assert.deepEqual(await bridge.call('asset_library', { action: 'list' }), { ok: true }, 'a list is not gated');
    assert.deepEqual(await bridge.call('list_queue', {}), { ok: true });
    pending.shift()(); await tick();
    assert.equal(sent.filter(item => item === 'asset_library:image').length, 3);
    for (const resolve of pending.splice(0)) resolve();
    await Promise.all(reads);
  });
  // The method allowlist is still checked first: a refused method never takes a slot.
  await hostCallScope.run({ tool: 'x', allowed: new Set(), denied: [] }, async () => {
    await assert.rejects(bridge.call('asset_library', { action: 'image' }), error => error.code === 'host_method_not_allowed');
  });
  await assert.rejects(bridge.call('asset_library', { action: 'image' }), error => error.code === 'host_call_outside_tool');
});

test('one MCP process: concurrent prepare_recipe, asset_library image and set_cover_from_history never exceed two host reads and never meet image_busy', async t => {
  const host = busyHost();
  const { call } = await connect(t, host.bridgeClient);
  const results = await Promise.all([
    ...Array.from({ length: 5 }, () => call('prepare_recipe', I2I)),
    call('asset_library', IMAGE), call('asset_library', IMAGE),
    call('material_library', COVER),
  ]);
  const codes = results.map(result => errorOf(result).code);
  assert.deepEqual(codes, Array(8).fill('stop'), 'every call reached its read; none was refused as busy');
  assert.equal(host.state.busy, 0);
  assert.equal(host.state.peak, 2);
  assert.equal(host.state.images.length, 8);
  assert.deepEqual(host.state.images.filter(variant => variant === 'original').length, 1, 'the cover reads the original');
});

test('a queued history-image read whose MCP request is cancelled is never sent', { timeout: 10_000 }, async t => {
  const host = busyHost({ hold: true });
  const { call } = await connect(t, host.bridgeClient);
  const first = [call('prepare_recipe', I2I), call('asset_library', IMAGE)];
  for (let attempt = 0; attempt < 50 && host.state.images.length < 2; attempt++) await tick();
  assert.equal(host.state.images.length, 2);
  const controller = new AbortController();
  const queued = call('prepare_recipe', I2I, { signal: controller.signal });
  await tick(); await tick();
  controller.abort();
  await assert.rejects(queued);
  // Give the server time to see the cancellation, then free both slots.
  await new Promise(resolve => setTimeout(resolve, 20));
  host.releaseAll();
  assert.deepEqual((await Promise.all(first)).map(result => errorOf(result).code), ['stop', 'stop']);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(host.state.images.length, 2, 'the cancelled read never reached the host');
  // The slots are free again.
  const next = call('asset_library', IMAGE);
  for (let attempt = 0; attempt < 50 && host.state.images.length < 3; attempt++) await tick();
  host.releaseAll();
  assert.equal(errorOf(await next).code, 'stop');
});

test('source-read failures say what to do next by code: busy retries, transport retries, identity codes keep asset_library', async t => {
  const cases = [
    ['image_busy', '已有历史图片读取正在处理；未排队或重试。', /busy with other history-image reads, most likely from another session[\s\S]*Nothing was saved[\s\S]*Retry the same call in a moment\.$/],
    ['timeout', 'The client request was interrupted or timed out.', /Nothing was saved; the read did not complete[\s\S]*Retry the same call/],
    ['unavailable', 'NovelAI client connection is unavailable.', /the read did not complete/],
    ['http_502', 'The client rejected the request.', /the read did not complete/],
    ['library_not_found', '历史条目不存在；没有读取文件。', /Nothing was saved; check the identity with asset_library\./],
    ['library_conflict', 'assetId 不属于这个历史版本登记的原图。', /check the identity with asset_library/],
    ['image_unavailable', '这个历史版本没有登记原图。', /check the identity with asset_library/],
  ];
  for (const [code, hostMessage, expected] of cases) {
    const { call } = await connect(t, { async call(method) { if (method === 'asset_library') throw new BridgeError(code, hostMessage); throw new BridgeError('stop', 'stop'); } });
    const error = errorOf(await call('prepare_recipe', I2I));
    assert.equal(error.code, code);
    assert.match(error.message, expected, `${code}: ${error.message}`);
    if (code === 'image_busy' || code === 'timeout' || code === 'unavailable' || code === 'http_502') assert.doesNotMatch(error.message, /check the identity/i, code);
    // The host limit is two reads in total, not per image: the busy text never asks to serialize by source image.
    assert.doesNotMatch(error.message, /one after another|same source image/, code);
    assert.equal(error.details.saved, false); assert.equal(error.details.path, 'source');
    assert.deepEqual([error.details.historyId, error.details.historyRevision, error.details.assetId], ['h-1', 1, 'a-1']);
  }
  // History reads keep their wording for content and storage codes (only study reads changed).
  for (const code of ['unsupported_image', 'invalid_image', 'image_changed']) assert.match(historyImageReadMessage('source', { code, message: 'x' }), /check the identity with asset_library\.$/, code);
  // #14: the host's own details travel along under hostDetails; this server's identity fields stay on top.
  const withDetails = await connect(t, { async call(method) { if (method === 'asset_library') throw new BridgeError('image_busy', 'busy', { active: 2, saved: true }); throw new BridgeError('stop', 'stop'); } });
  const detailed = errorOf(await withDetails.call('prepare_recipe', I2I));
  assert.equal(detailed.details.saved, false); assert.equal(detailed.details.path, 'source'); assert.deepEqual(detailed.details.hostDetails, { active: 2, saved: true });
  // Alpha layers read their originals through the same text.
  assert.match(historyImageReadMessage('mask.layers[0].alpha', { code: 'image_busy', message: 'busy' }), /^The history image at mask\.layers\[0\]\.alpha could not be read now/);
  assert.equal(historyImageBusy('image_busy'), true); assert.equal(historyImageBusy('recipe_source_busy'), true); assert.equal(historyImageBusy('library_not_found'), false); assert.equal(historyImageBusy(undefined), false);
});

// Issue #2: a study (imported image) source is read through the same asset_library {action:"image"} method, so it
// shares the in-process two-read gate; its failure text points at material_studies instead of asset_library.
const STUDY = { kind: 'study', studyId: '0f0e0d0c-0b0a-4908-8706-050403020100', studyRevision: 2 };
const STUDY_I2I = { ...I2I, source: STUDY };
const STUDY_IMAGE = { action: 'image', kind: 'study', id: STUDY.studyId, revision: 2 };

test('study reads share the two-read gate with history reads and never meet image_busy in one process', async t => {
  const host = busyHost();
  const { call } = await connect(t, host.bridgeClient);
  const results = await Promise.all([
    ...Array.from({ length: 3 }, () => call('prepare_recipe', STUDY_I2I)), call('prepare_recipe', I2I),
    call('asset_library', STUDY_IMAGE), call('asset_library', IMAGE),
  ]);
  assert.deepEqual(results.map(result => errorOf(result).code), Array(6).fill('stop'));
  assert.equal(host.state.busy, 0); assert.equal(host.state.peak, 2); assert.equal(host.state.images.length, 6);
});

test('study source-read failures: busy and transport retry, identity codes point at material_studies; details name the study', async t => {
  for (const [code, expected] of [['image_busy', /^The study image at source could not be read now: the client is busy with other library-image reads[\s\S]*Retry the same call in a moment\.$/], ['timeout', /the read did not complete/], ['library_not_found', /check the identity with material_studies/], ['library_conflict', /check the identity with material_studies/],
    // Review P3-3: content the reader refuses (APNG, animation, over 32 MP) or a broken stored original is never "import again".
    ['unsupported_image', /cannot be used as a recipe source[\s\S]*Importing the same file again returns the same study[\s\S]*static \(non-animated\) PNG of at most 32 million pixels and 20 MiB[\s\S]*use its new id\.$/], ['invalid_image', /convert it locally first/], ['image_too_large', /convert it locally first/],
    ['image_changed', /stored original of the study[\s\S]*returns this same study; tell the user[\s\S]*re-saved copy/], ['image_unavailable', /stored original of the study/]]) {
    const { call } = await connect(t, { async call(method) { if (method === 'asset_library') throw new BridgeError(code, 'host text'); throw new BridgeError('stop', 'stop'); } });
    const error = errorOf(await call('prepare_recipe', STUDY_I2I));
    assert.equal(error.code, code); assert.match(error.message, expected, `${code}: ${error.message}`);
    assert.deepEqual(error.details, { path: 'source', studyId: STUDY.studyId, studyRevision: 2, saved: false });
  }
});
