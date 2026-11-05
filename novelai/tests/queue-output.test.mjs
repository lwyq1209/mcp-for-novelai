import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Issue #1 (2026-10-14): enqueue output (historyGroup / fileNamePrefix), the saved file of each queue result and
// the history lookup by queue request key or batch, on the MCP side. The host side and the end-to-end two-session
// run are in client/electron/queue-output-isolation.test.ts.
const { createNovelAiMcpServer, TOOL_DEFINITIONS, BridgeError } = await import('../src/mcp.mjs');
const recipeQueue = await import('../src/recipe-queue.mjs');
const { compactQueuedBatch: businessCompact, queueControlAction } = await import('../src/queue-control.mjs');

const BATCH = 'abcdef01-2345-6789-abcd-ef0123456789';
const RECIPE = '12345678-1234-1234-1234-123456789abc';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9AAAAABJRU5ErkJggg==';
const PROJECT = '/fixture/comic-project';

async function connect(t, handler) {
  const calls = [];
  const bridgeClient = { async call(method, args) { calls.push({ method, args: structuredClone(args) }); return handler(method, args); } };
  const server = createNovelAiMcpServer({ bridgeClient, projectRoot: PROJECT, projectRootSource: 'NOVELAI_PROJECT_ROOT' });
  const client = new Client({ name: 'queue-output-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { calls, call: async (name, args) => { const result = await client.callTool({ name, arguments: args }); return { ok: !result.isError, value: result.structuredContent }; } };
}

test('enqueue output: same rules in the public schema and the server check, before any host call', () => {
  const schema = TOOL_DEFINITIONS.find(tool => tool.name === 'enqueue_recipes').inputSchema.properties;
  const prefix = new RegExp(schema.fileNamePrefix.pattern, 'u'), group = new RegExp(schema.historyGroup.pattern, 'u');
  const base = { requestKey: 'k', items: [{ recipeId: RECIPE, recipeRevision: 1, inputHash: 'a'.repeat(64) }] };
  for (const value of ['sketchbook6', 'ClockworkDetective', '项目_2026.10', 'a', 'x'.repeat(40)]) {
    assert.ok(prefix.test(value) && value.length <= schema.fileNamePrefix.maxLength && recipeQueue.validFileNamePrefix(value), value);
    assert.deepEqual(recipeQueue.normalizeEnqueue({ ...base, fileNamePrefix: value }).output, { fileNamePrefix: value });
  }
  for (const value of ['', 'a b', '.hidden', '-dash', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a|b', 'a\tb', 'x'.repeat(41), '😀'.repeat(21), 'p\u202e', 'p\ud800', 'a\u200bb', 'CON', 'nul.txt']) {
    assert.equal(recipeQueue.validFileNamePrefix(value), false, JSON.stringify(value));
    assert.throws(() => recipeQueue.normalizeEnqueue({ ...base, fileNamePrefix: value }), { code: 'invalid_arguments' }, JSON.stringify(value));
  }
  for (const value of ['sketchbook6', 'ClockworkDetective · 美术', 'a b', '🧑\u200d💻 studio', 'می\u200cخواهم']) {
    assert.ok(group.test(value) && recipeQueue.validHistoryGroupName(value), value);
    assert.deepEqual(recipeQueue.normalizeEnqueue({ ...base, historyGroup: value }).output, { historyGroup: value });
  }
  // Windows device names, dotted ends, invisible characters (bidi override, zero-width, lone surrogate) are refused.
  for (const value of ['', ' a', 'a ', 'a\nb', 'x'.repeat(81), 'CON', 'con.txt', 'Com1', 'LPT9.x', 'aux', 'a.', '.a', 'g\u202egnp.exe', '\u200b', 'g\udc00', 'proj\u0085', 'CONIN$', 'con.\u2028x']) assert.throws(() => recipeQueue.normalizeEnqueue({ ...base, historyGroup: value }), { code: 'invalid_arguments' }, JSON.stringify(value));
  // Without either field the plan is exactly the old one.
  assert.equal(Object.hasOwn(recipeQueue.normalizeEnqueue(base), 'output'), false);
});

test('acceptance identity includes the requested output, and is unchanged without one', () => {
  const items = [{ recipeId: RECIPE, recipeRevision: 1, inputHash: 'a'.repeat(64), seed: 1 }];
  const batch = { batchId: BATCH, execution: 'queued', requestKey: 'mcp-x', count: 1, recipePlanHash: recipeQueue.recipeHash(items), intervalSeconds: 0 };
  const args = { requestKey: 'mcp-x', items, intervalSeconds: 0 };
  assert.equal(recipeQueue.acceptanceMatches(batch, args), true);
  const output = { historyGroup: 'p', historyGroupId: 'g-1', historyGroupName: 'P', fileNamePrefix: 'p' };
  assert.equal(recipeQueue.acceptanceMatches({ ...batch, output }, { ...args, output: { historyGroup: 'p', fileNamePrefix: 'p' } }), true, 'the resolved group id/name do not take part');
  assert.equal(recipeQueue.acceptanceMatches({ ...batch, output }, args), false);
  assert.equal(recipeQueue.acceptanceMatches(batch, { ...args, output: { historyGroup: 'p' } }), false);
  assert.equal(recipeQueue.acceptanceMatches({ ...batch, output }, { ...args, output: { historyGroup: 'p', fileNamePrefix: 'q' } }), false);
});

test('the compact batch carries the output, string fields only', () => {
  const batch = { batchId: BATCH, requestKey: 'mcp-x', execution: 'queued', status: 'queued', count: 1, recipePlanHash: 'a'.repeat(64), intervalSeconds: 0, items: [],
    output: { historyGroup: 'p', historyGroupId: 'g-1', historyGroupName: 'P', fileNamePrefix: 'p', extra: 'dropped', other: 1 } };
  const compact = { batchId: BATCH, requestKey: 'mcp-x', execution: 'queued', source: { kind: 'agent', client: null }, status: 'queued', stopReason: null, count: 1, recipePlanHash: 'a'.repeat(64), intervalSeconds: 0, activeJobId: null, items: [] };
  assert.deepEqual(businessCompact(batch), { ...compact, output: { historyGroup: 'p', historyGroupId: 'g-1', historyGroupName: 'P', fileNamePrefix: 'p' } });
  const { output: _output, ...plain } = batch;
  assert.equal(Object.hasOwn(businessCompact(plain), 'output'), false);
  assert.deepEqual(businessCompact(plain), compact);
});

test('read_queue and get_queue_result name each saved file project-relative, never absolute', async t => {
  const inside = join(PROJECT, 'novelai/.runtime/output/2026-10-14/sketchbook6/sketchbook6_2026-10-14_01_nai-diffusion-5-full.png');
  const outside = '/Volumes/elsewhere/output/2026-10-14/b.png';
  const batch = { batchId: BATCH, requestKey: 'mcp-x', execution: 'queued', status: 'succeeded', count: 3, recipePlanHash: 'a'.repeat(64), intervalSeconds: 0, output: { historyGroup: 'sketchbook6', historyGroupId: 'g-1', historyGroupName: 'sketchbook6', fileNamePrefix: 'sketchbook6' },
    items: [
      { index: 0, status: 'succeeded', jobId: 'j0', results: [{ index: 0, id: 'h0', fileName: 'ignored-host-field', filePath: inside }] },
      { index: 1, status: 'succeeded', jobId: 'j1', results: [{ index: 0, id: 'h1', filePath: outside }] },
      { index: 2, status: 'succeeded', jobId: 'j2', results: [{ index: 0, id: 'h2' }] },
    ] };
  const { call } = await connect(t, (method, args) => {
    if (method === 'read_queue') return batch;
    // The production shape after the HTTP bridge's projection: fileName/filePath at the top level, no historyItem.
    if (method === 'get_queue_result') { const filePath = [inside, outside, undefined][args.itemIndex]; return { jobId: `j${args.itemIndex}`, index: 0, mimeType: 'image/png', data: png, historyId: `h${args.itemIndex}`, ...(filePath ? { fileName: filePath.split('/').pop(), filePath } : {}) }; }
    throw new Error(`unexpected ${method}`);
  });
  const read = await call('read_queue', { batchId: BATCH });
  assert.equal(read.ok, true, JSON.stringify(read.value));
  assert.deepEqual(read.value.output, batch.output);
  assert.deepEqual(read.value.results, [
    { itemIndex: 0, index: 0, historyId: 'h0', actualSeed: null, fileName: 'sketchbook6_2026-10-14_01_nai-diffusion-5-full.png', file: 'novelai/.runtime/output/2026-10-14/sketchbook6/sketchbook6_2026-10-14_01_nai-diffusion-5-full.png' },
    { itemIndex: 1, index: 0, historyId: 'h1', actualSeed: null, fileName: 'b.png', file: null },
    { itemIndex: 2, index: 0, historyId: 'h2', actualSeed: null },
  ]);
  assert.equal(read.value.pathBase, 'project-root');
  assert.equal(read.value.projectRoot, 'NOVELAI_PROJECT_ROOT', 'the result names which project root the paths are relative to');
  assert.ok(!JSON.stringify(read.value).includes('/Volumes/'), 'an absolute path outside the project never reaches the model');
  assert.ok(!JSON.stringify(read.value).includes(PROJECT), 'nor does the project root itself');
  const first = await call('get_queue_result', { batchId: BATCH, itemIndex: 0 });
  assert.deepEqual(first.value, { batchId: BATCH, itemIndex: 0, index: 0, jobId: 'j0', historyId: 'h0', actualSeed: null, fileName: 'sketchbook6_2026-10-14_01_nai-diffusion-5-full.png', file: 'novelai/.runtime/output/2026-10-14/sketchbook6/sketchbook6_2026-10-14_01_nai-diffusion-5-full.png', imageAttached: true, pathBase: 'project-root', projectRoot: 'NOVELAI_PROJECT_ROOT' });
  const second = await call('get_queue_result', { batchId: BATCH, itemIndex: 1 });
  assert.deepEqual(second.value, { batchId: BATCH, itemIndex: 1, index: 0, jobId: 'j1', historyId: 'h1', actualSeed: null, fileName: 'b.png', file: null, imageAttached: true });
  const old = await call('get_queue_result', { batchId: BATCH, itemIndex: 2 });
  assert.deepEqual(old.value, { batchId: BATCH, itemIndex: 2, index: 0, jobId: 'j2', historyId: 'h2', actualSeed: null, imageAttached: true }, 'an older host without a file path adds nothing');
});

test('asset_library list by queueRequestKey sends the namespaced host key; queueBatchId passes through', async t => {
  const { call, calls } = await connect(t, () => ({ items: [], total: 0, offset: 0, limit: 10, hasMore: false, revision: 1 }));
  const byKey = await call('asset_library', { action: 'list', category: 'history', queueRequestKey: 'sketchbook6-ch3-v1' });
  assert.equal(byKey.ok, true, JSON.stringify(byKey.value));
  assert.equal(calls.at(-1).args.queueRequestKey, recipeQueue.mcpHostRequestKey('sketchbook6-ch3-v1'));
  assert.match(calls.at(-1).args.queueRequestKey, /^mcp-[a-f0-9]{24}-[a-f0-9]{64}$/);
  const byBatch = await call('asset_library', { action: 'list', queueBatchId: BATCH });
  assert.equal(byBatch.ok, true, JSON.stringify(byBatch.value));
  assert.equal(calls.at(-1).args.queueBatchId, BATCH);
  const bad = await call('asset_library', { action: 'list', queueRequestKey: '' });
  assert.equal(bad.ok, false);
  assert.equal(calls.length, 2, 'an invalid filter never reaches the host');
});

test('an older client refusing the queue filters is host_outdated, not an argument error', async t => {
  // The 55133ca host's exact reply (recorded in a copy of that client), as the bridge client raises it.
  const { call } = await connect(t, () => { throw new BridgeError('invalid_argument', '素材请求无效：data must NOT have additional properties, data must match a schema in anyOf'); });
  const result = await call('asset_library', { action: 'list', category: 'history', queueBatchId: BATCH });
  assert.equal(result.ok, false);
  assert.equal(result.value.error.code, 'host_outdated');
  assert.match(result.value.error.message, /rebuild and restart the client/);
});

test('queueControlAction never returns an absolute path, with or without a projectPath function', async () => {
  const bridge = { async call() { return { batchId: BATCH, requestKey: 'mcp-x', execution: 'queued', status: 'succeeded', count: 1, recipePlanHash: 'a'.repeat(64), intervalSeconds: 0,
    items: [{ index: 0, status: 'succeeded', jobId: 'j0', results: [{ index: 0, id: 'h0', filePath: '/abs/out/x.png' }] }] }; } };
  const bare = await queueControlAction({ action: 'read', batchId: BATCH }, { bridge });
  assert.deepEqual(bare.value.results, [{ itemIndex: 0, index: 0, historyId: 'h0', actualSeed: null, fileName: 'x.png', file: null }]);
  assert.equal(Object.hasOwn(bare.value, 'pathBase'), false);
  const mapped = await queueControlAction({ action: 'read', batchId: BATCH }, { bridge, projectPath: path => path.replace('/abs/', '') });
  assert.deepEqual(mapped.value.results, [{ itemIndex: 0, index: 0, historyId: 'h0', actualSeed: null, fileName: 'x.png', file: 'out/x.png' }]);
  assert.equal(mapped.value.pathBase, 'project-root');
  assert.ok(!JSON.stringify([bare, mapped]).includes('/abs/'));
});
