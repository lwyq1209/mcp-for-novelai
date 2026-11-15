import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createNovelAiMcpServer } from '../src/mcp.mjs';
import { compactBatch, compactEnqueue, compactQueueList, compactTags, historyRecipeView, wikiDefinition } from '../src/compact-results.mjs';

// What an agent gets from the queue, library and tag tools: the server as it runs (no wholeResults), over a host double.
// The whole results these are projections of are tested with the modules themselves (wholeResults: true in their files).
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9AAAAABJRU5ErkJggg==';
const BATCH = 'abcdef01-2345-6789-abcd-ef0123456789';
const HOST_KEY = `mcp-${'a'.repeat(24)}-${'b'.repeat(64)}`;

async function connect(t, handler, options = {}) {
  const calls = [];
  const server = createNovelAiMcpServer({ bridgeClient: { async call(method, args) { calls.push({ method, args }); return handler(method, args); } }, ...options });
  const client = new Client({ name: 'compact-results-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const ok = async (name, args) => { const result = await call(name, args); assert.ok(!result.isError, JSON.stringify(result.structuredContent)); return result.structuredContent; };
  return { calls, call, ok, listTools: async () => (await client.listTools()).tools };
}

const hostBatch = (extra = {}) => ({
  batchId: BATCH, requestKey: HOST_KEY, execution: 'queued', source: { kind: 'agent', client: { name: 'pi', version: '1.5.2' } }, status: 'running', error: null, count: 5,
  recipePlanHash: 'c'.repeat(64), intervalSeconds: 0, activeJobId: 'job-3', output: { historyGroup: 'proj', historyGroupId: 'g-1', historyGroupName: 'proj', fileNamePrefix: 'proj' },
  items: [
    { index: 0, status: 'succeeded', jobId: 'job-0', results: [{ index: 0, id: 'h0', actualSeed: 11, filePath: '/pictures/out/proj_01.png' }] },
    { index: 1, status: 'succeeded', jobId: 'job-1', results: [{ index: 0, id: 'h1', actualSeed: 12, filePath: '/pictures/out/proj_02.png' }, { index: 1, id: 'h1b', actualSeed: 12, filePath: '/pictures/out/proj_02b.png' }] },
    { index: 2, status: 'failed', jobId: 'job-2', results: [], error: { code: 'provider_error', message: 'host text that is not passed on' } },
    { index: 3, status: 'running', jobId: 'job-3', results: [] },
    { index: 4, status: 'pending', results: [] },
  ],
  ahead: { images: 0, batches: 0 }, etaSeconds: 21, imageSeconds: 9.9, inputCompacted: true, compactedAt: '2026-11-13T00:00:00.000Z', ...extra,
});

test('read_queue: status, the counts that occur, every saved image and every image that is not simply waiting or done; no host-only identifiers', async t => {
  let reply = hostBatch();
  const { ok } = await connect(t, () => reply);
  const read = await ok('read_queue', { batchId: BATCH });
  assert.deepEqual(read, {
    batchId: BATCH, status: 'running', count: 5, itemCounts: { pending: 1, running: 1, succeeded: 2, failed: 1 },
    results: [{ itemIndex: 0, historyId: 'h0', actualSeed: 11, fileName: 'proj_01.png' }, { itemIndex: 1, historyId: 'h1', actualSeed: 12, fileName: 'proj_02.png' }, { itemIndex: 1, index: 1, historyId: 'h1b', actualSeed: 12, fileName: 'proj_02b.png' }],
    items: [{ itemIndex: 2, status: 'failed', error: 'provider_error' }, { itemIndex: 3, status: 'running' }],
    ahead: { images: 0, batches: 0 }, etaSeconds: 21,
  });
  const text = JSON.stringify(read);
  for (const hidden of [HOST_KEY, 'c'.repeat(64), 'job-', 'historyGroup', 'host text', '"source"', 'execution', 'imageSeconds', 'inputCompacted']) assert.equal(text.includes(hidden), false, hidden);
  // Ended: no place in the queue any more; a stop reason and a manual source are said.
  reply = hostBatch({ status: 'partial', source: { kind: 'manual' }, error: { code: 'child_stopped' }, items: hostBatch().items.slice(0, 3), count: 3, activeJobId: null });
  const ended = await ok('read_queue', { batchId: BATCH });
  assert.deepEqual(Object.keys(ended), ['batchId', 'status', 'stopReason', 'count', 'source', 'itemCounts', 'results', 'items']);
  assert.deepEqual([ended.source, ended.stopReason.code, ended.itemCounts], ['manual', 'child_stopped', { succeeded: 2, failed: 1 }]);
  // wait: the same view with how the wait ended.
  reply = hostBatch({ status: 'succeeded', items: hostBatch().items.slice(0, 1), count: 1 });
  const waited = await ok('read_queue', { batchId: BATCH, wait: { until: 'done', seconds: 5 } });
  assert.deepEqual(waited, { batchId: BATCH, status: 'succeeded', count: 1, itemCounts: { succeeded: 1 }, results: [{ itemIndex: 0, historyId: 'h0', actualSeed: 11, fileName: 'proj_01.png' }], wait: { until: 'done', ended: 'done', waitedSeconds: 0 } });
  // A cleaned batch: how it ended and where its images are.
  reply = { batchId: BATCH, execution: 'queued', cleaned: true, status: 'succeeded', count: 4, cleanedAt: '2026-11-01T00:00:00.000Z', finishedAt: '2026-10-20T00:00:00.000Z', itemCounts: { succeeded: 4, failed: 0, unknown: 0, cancelled: 0, skipped: 0 } };
  const cleaned = await ok('read_queue', { batchId: BATCH });
  assert.deepEqual(Object.keys(cleaned), ['batchId', 'status', 'count', 'cleaned', 'cleanedAt', 'itemCounts', 'instruction']);
  assert.deepEqual(cleaned.itemCounts, { succeeded: 4 }); assert.match(cleaned.instruction, /queueBatchId/);
});

test('list_queue: each batch by id, status and size; storage only when a store is nearly full', async t => {
  const batch = (index, extra = {}) => ({ batchId: `b-${index}`, status: 'succeeded', count: 2, source: { kind: 'agent', client: { name: 'pi', version: '1' } }, items: [{ status: 'succeeded' }, { status: 'succeeded' }], ...extra });
  let storage = { frozenQueue: { batches: 10, batchLimit: 4096, bytes: 1, byteLimit: 1000 }, recipeStore: { records: 5, recordLimit: 16384, bytes: 1, byteLimit: 1000 } };
  const batches = [batch(0, { status: 'running', activeJobId: 'j', source: { kind: 'manual' } }), batch(1, { status: 'partial', error: { code: 'child_stopped' }, items: [{ status: 'failed' }, { status: 'unknown' }] }), ...Array.from({ length: 8 }, (_, i) => batch(i + 2))];
  const { ok } = await connect(t, () => ({ batches, storage }));
  const listed = await ok('list_queue');
  assert.deepEqual(Object.keys(listed), ['total', 'byStatus', 'batches', 'omitted']);
  assert.deepEqual([listed.total, listed.byStatus, listed.omitted, listed.batches.length], [10, { running: 1, partial: 1, succeeded: 8 }, 2, 8]);
  assert.deepEqual(listed.batches[0], { batchId: 'b-0', status: 'running', count: 2, source: 'manual' });
  assert.deepEqual({ ...listed.batches[1], stopReason: listed.batches[1].stopReason.code }, { batchId: 'b-1', status: 'partial', stopReason: 'child_stopped', count: 2, failed: 1, unknown: 1 });
  assert.deepEqual(listed.batches[2], { batchId: 'b-2', status: 'succeeded', count: 2 });
  storage = { ...storage, recipeStore: { records: 15000, recordLimit: 16384, bytes: 1, byteLimit: 1000 } };
  assert.deepEqual((await ok('list_queue')).storage, { recipeStore: storage.recipeStore }, 'a store at four fifths of a limit is reported as it is');
});

test('get_queue_result: the image with its history identity, seed and file; the whole batch as thumbnails in the same terms', async t => {
  const { ok, call } = await connect(t, (method, args) => method === 'read_queue' ? hostBatch({ status: 'succeeded' })
    : args.variant === 'thumbnail' ? { variant: 'thumbnail', mimeType: 'image/png', data: png, width: 1, height: 1, historyId: args.itemIndex === 0 ? 'h0' : args.index ? 'h1b' : 'h1' }
      : { jobId: 'job-0', index: args.index, historyId: 'h0', actualSeed: 11, filePath: '/pictures/out/proj_01.png', mimeType: 'image/png', data: png });
  const one = await call('get_queue_result', { batchId: BATCH, itemIndex: 0 });
  assert.deepEqual(one.structuredContent, { historyId: 'h0', actualSeed: 11, fileName: 'proj_01.png' });
  assert.equal(one.content.filter(item => item.type === 'image').length, 1);
  const all = await call('get_queue_result', { batchId: BATCH });
  assert.deepEqual(all.structuredContent, { status: 'succeeded', total: 3, results: [{ itemIndex: 0, historyId: 'h0', actualSeed: 11, fileName: 'proj_01.png' }, { itemIndex: 1, historyId: 'h1', actualSeed: 12, fileName: 'proj_02.png' }, { itemIndex: 1, index: 1, historyId: 'h1b', actualSeed: 12, fileName: 'proj_02b.png' }] });
  assert.equal(all.content.filter(item => item.type === 'image').length, 3);
  assert.ok(JSON.stringify(await ok('get_queue_result', { batchId: BATCH })).length < 320);
});

test('compactEnqueue: status, batch and count; seeds only where the server chose them; the batch state and instruction only where the answer is not the routine one', () => {
  const batch = { batchId: BATCH, requestKey: HOST_KEY, execution: 'queued', status: 'queued', count: 2, recipePlanHash: 'c'.repeat(64), itemCounts: { pending: 2, running: 0, succeeded: 0, failed: 0, unknown: 0, cancelled: 0, skipped: 0 }, items: [] };
  const item = seed => ({ recipeId: 'r', recipeRevision: 1, inputHash: 'h'.repeat(64), seed });
  const receipt = { requestKey: 'k', hostRequestKey: HOST_KEY, count: 2, intervalSeconds: 0, output: { historyGroup: 'proj' }, status: 'enqueued', enqueueSent: true, batch, items: [item(7), item(8)], instruction: 'Accepted into the shared FIFO queue; …' };
  // Explicit seeds were written by the call; a random-seed recipe has none yet.
  assert.deepEqual(compactEnqueue(receipt, { items: [{ count: 2, seeds: [7, 8] }] }), { status: 'enqueued', batchId: BATCH, count: 2 });
  assert.deepEqual(compactEnqueue({ ...receipt, items: [item(null), item(null)] }, { items: [{ count: 2 }] }), { status: 'enqueued', batchId: BATCH, count: 2 });
  // A fixed seed counted up by the server, with its warning.
  const warnings = [{ code: 'fixed_seed_incremented', message: 'm' }];
  assert.deepEqual(compactEnqueue({ ...receipt, warnings }, { items: [{ count: 2 }] }), { status: 'enqueued', batchId: BATCH, count: 2, seeds: [7, 8], warnings });
  // Already enqueued, or confirmed after a lost answer: what the batch is doing and what to do.
  assert.deepEqual(compactEnqueue({ ...receipt, status: 'already_enqueued', enqueueSent: false, batch: { ...batch, status: 'running' }, instruction: 'This exact plan was already accepted' }, { items: [{ count: 2, seeds: [7, 8] }] }),
    { status: 'already_enqueued', batchId: BATCH, count: 2, batchStatus: 'running', itemCounts: { pending: 2 }, instruction: 'This exact plan was already accepted' });
  const reconciled = compactEnqueue({ ...receipt, reconciled: true, settled: { lookups: 1, resends: 1 }, instruction: 'The first answer was lost' }, { items: [{ count: 2, seeds: [7, 8] }] });
  assert.deepEqual([reconciled.reconciled, reconciled.batchStatus, reconciled.instruction], [true, 'queued', 'The first answer was lost']);
  const text = JSON.stringify([compactEnqueue(receipt, {}), reconciled]);
  for (const hidden of [HOST_KEY, 'c'.repeat(64), 'h'.repeat(64), 'historyGroup', 'enqueueSent']) assert.equal(text.includes(hidden), false, hidden);
  for (const other of [null, undefined, 'text', { error: { code: 'x' } }]) assert.equal(compactEnqueue(other), other);
});

const PROMPT = '1girl, garden, wide shot from across the pond, long shadows, soft warm light';
const historyRecord = () => ({
  item: { kind: 'history', id: 'h0', revision: 1, name: 'proj_01.png', createdAt: '2026-11-13T00:00:00.000Z', updatedAt: '2026-11-13T00:00:01.000Z', archived: false, schemaVersion: 1, source: { namespace: 'history', legacyId: 'h0' },
    preview: { assetId: 'path:abc', role: 'original', cacheKey: 'k'.repeat(64), width: 832, height: 1216 },
    payload: { id: 'h0', date: '2026-11-13', createdAt: '2026-11-13T00:00:00.000Z', groupId: 'g-1', model: 'nai-diffusion-5-full', width: 832, height: 1216, actualSeed: 11, filePath: '/pictures/out/proj_01.png', fileUrl: 'nai-local://file/x',
      params: { model: 'nai-diffusion-5-full', promptAssemblyVersion: 1, stylePrompt: '', positivePrompt: PROMPT, negativePrompt: 'blurry', width: 832, height: 1216, steps: 28, cfgScale: 5, cfgRescale: 0, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', seed: 11, seedMode: 'fixed', ucPreset: 3, qualityPreset: 'none', qualityToggle: true, transparentBackground: false, smea: false, smeaDyn: false, variety: false, fileNamePrefix: '' },
      characterSnapshot: { version: 1, captions: [{ prompt: 'girl, red dress', negativePrompt: 'hat', useCoords: true, x: 0.3, y: 0.5 }, { prompt: 'boy, blue coat', negativePrompt: '', useCoords: false, x: 0.5, y: 0.5 }] }, characterPrompts: ['girl, red dress', 'boy, blue coat'],
      queueOrigin: { batchId: BATCH, requestKey: HOST_KEY, itemIndex: 0 }, generationOrigin: { jobId: 'job-0', mode: 't2i', originWorkspaceId: 'recipe-queue', submittedRevision: 0, actualSeed: 11 }, i2iStrength: 0.5 } },
  tags: [...PROMPT.split(', ').map(tag => ({ tag, source: 'positive' })), { tag: 'keeper', source: 'user' }], assets: [{ filePath: '/pictures/out/proj_01.png', fileUrl: 'nai-local://file/x', id: 'path:abc', role: 'original' }],
  links: [{ kind: 'history', id: 'h0', targetId: 'job-0' }], memberships: [{ namespace: 'history', collectionId: 'g-1', kind: 'history', id: 'h0' }, { namespace: 'user', collectionId: 'favourites', kind: 'history', id: 'h0' }], tagCoverage: { positive: true },
});

test('asset_library read of a history image: what it was made with, once, and where the user filed it; there is no detail option', async t => {
  const { ok, call, listTools } = await connect(t, (_method, args) => args.kind === 'note' ? { item: { kind: 'note', id: 'n1', revision: 3, name: 'a note', payload: { notes: 'text' } } } : historyRecord());
  const read = await ok('asset_library', { action: 'read', kind: 'history', id: 'h0' });
  assert.deepEqual(read, {
    kind: 'history', id: 'h0', revision: 1, name: 'proj_01.png', createdAt: '2026-11-13T00:00:00.000Z', assetId: 'path:abc', model: 'nai-diffusion-5-full', width: 832, height: 1216, mode: 't2i', actualSeed: 11,
    params: { stylePrompt: '', positivePrompt: PROMPT, negativePrompt: 'blurry', steps: 28, cfgScale: 5, cfgRescale: 0, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', seedMode: 'fixed', ucPreset: 3, qualityPreset: 'none' },
    characters: [{ prompt: 'girl, red dress', negativePrompt: 'hat', x: 0.3, y: 0.5 }, { prompt: 'boy, blue coat' }],
    filePath: '/pictures/out/proj_01.png', queue: { batchId: BATCH, itemIndex: 0 }, groupId: 'g-1', userTags: ['keeper'], collections: ['user:favourites'], i2iStrength: 0.5,
  });
  const text = JSON.stringify(read);
  for (const once of [PROMPT, 'girl, red dress', '/pictures/out/proj_01.png']) assert.equal(text.split(once).length - 1, 1, once);
  for (const hidden of [HOST_KEY, 'nai-local', 'cacheKey', '"tags"', '"links"', 'job-0']) assert.equal(text.includes(hidden), false, hidden);
  assert.ok(text.length < JSON.stringify(historyRecord()).length / 2, `${text.length} of ${JSON.stringify(historyRecord()).length}`);
  // One answer: a detail is not an argument of the tool (the response module's summary and full are for its own tests).
  for (const detail of ['full', 'summary']) assert.equal((await call('asset_library', { action: 'read', kind: 'history', id: 'h0', detail })).structuredContent.error.code, 'invalid_arguments', detail);
  assert.equal(Object.hasOwn((await listTools()).find(tool => tool.name === 'asset_library').inputSchema.properties, 'detail'), false);
  // Another kind is returned in full, as before.
  assert.deepEqual(Object.keys(await ok('asset_library', { action: 'read', kind: 'note', id: 'n1' })).sort(), ['item', 'responseInfo']);
  // An image without a character snapshot (older records) lists its character prompts; one without a recipe is still an identity.
  const older = historyRecord(); delete older.item.payload.characterSnapshot;
  assert.deepEqual(historyRecipeView(older).characters, [{ prompt: 'girl, red dress' }, { prompt: 'boy, blue coat' }]);
  assert.deepEqual(historyRecipeView({ item: { kind: 'history', id: 'x', revision: 2, payload: {} } }), { kind: 'history', id: 'x', revision: 2 });
  // The older on/off quality switch is kept only where no preset says it.
  assert.deepEqual(historyRecipeView({ item: { kind: 'history', id: 'x', revision: 2, payload: { params: { qualityToggle: false, steps: 20 } } } }).params, { qualityToggle: false, steps: 20 });
  assert.deepEqual(historyRecipeView({ item: { kind: 'history', id: 'x', revision: 2, payload: { params: { qualityToggle: false, qualityPreset: 'none' } } } }).params, { qualityPreset: 'none' });
});

test('asset_library list: rows an image can be read or viewed by, without the restated notes', async t => {
  const row = index => ({ ...historyRecord().item, id: `h${index}`, name: `proj_0${index}.png`, archived: index === 1, matchedTags: index === 1 ? [{ tag: 'garden', source: 'positive' }] : [] });
  const { ok } = await connect(t, () => ({ items: [row(0), row(1)], total: 5, revision: 9 }));
  const page = await ok('asset_library', { action: 'list', category: 'history', limit: 2 });
  assert.deepEqual(Object.keys(page), ['items', 'total', 'hasMore', 'nextOffset', 'revision']);
  assert.deepEqual(page.items[0], { kind: 'history', id: 'h0', revision: 1, name: 'proj_00.png', createdAt: '2026-11-13T00:00:00.000Z', model: 'nai-diffusion-5-full', width: 832, height: 1216, promptExcerpt: PROMPT, assetId: 'path:abc' });
  assert.deepEqual([page.items[1].archived, page.items[1].matchedTags], [true, [{ tag: 'garden', source: 'positive' }]]);
  assert.deepEqual([page.total, page.hasMore, page.nextOffset], [5, true, 2]);
  assert.ok(JSON.stringify(page.items[0]).length < 330, JSON.stringify(page.items[0]));
});

const WIKI = 'The butt resting on a surface (often a [[chair]] or [[bench]]). For the knees on the floor, use [[kneeling]].\r\n\r\nh4. Examples\r\n\r\n* !post #3279793: Left to right: [[yokozuwari]], [[wariza]]\r\n\r\nh4. Related tags\r\n\r\n* [[seiza]]\r\n* [[indian style]]';
const rawTag = (name, extra = {}) => ({ name, canonicalName: name, resolution: 'canonical', checkedAt: '2026-11-13T00:00:00.000Z', evidence: { retrieval: 'cache', cacheHits: 3 },
  tag: { status: 'found', name, categoryName: 'general', postCount: 1349098, isDeprecated: false, sourceUrl: `https://danbooru.donmai.us/tags/${name}` },
  aliases: { status: 'checked', steps: [] }, wiki: { status: 'found', title: name, body: WIKI, format: 'dtext', truncated: false, sourceUrl: `https://danbooru.donmai.us/wiki_pages/${name}` }, ...extra });

test('tag_details: per tag its category, post count and the wiki definition; anything out of the ordinary is said; full is unchanged', async t => {
  const lookup = async name => name === 'sit' ? rawTag('sit', { canonicalName: 'sitting', resolution: 'alias', aliases: { status: 'checked', steps: [{ antecedentName: 'sit', consequentName: 'sitting' }] } })
    : name === 'nope' ? rawTag('nope', { canonicalName: null, resolution: 'not_found', tag: { status: 'not_found' }, wiki: { status: 'not_found' } }) : rawTag(name);
  const { ok } = await connect(t, () => { throw new Error('tag_details never uses the bridge'); }, { tagQuery: { lookup } });
  const result = await ok('tag_details', { names: ['sitting', 'sit', 'nope'] });
  assert.deepEqual(Object.keys(result), ['count', 'items']);
  assert.deepEqual(result.items[0], { name: 'sitting', category: 'general', postCount: 1349098, wiki: 'The butt resting on a surface (often a [[chair]] or [[bench]]). For the knees on the floor, use [[kneeling]].', wikiMore: true });
  assert.deepEqual([result.items[1].canonicalName, result.items[1].resolution, result.items[1].aliases], ['sitting', 'alias', [{ from: 'sit', to: 'sitting' }]]);
  assert.deepEqual(result.items[2], { name: 'nope', resolution: 'not_found', tagStatus: 'not_found', wikiStatus: 'not_found' });
  const text = JSON.stringify(result);
  for (const hidden of ['https://', 'Related tags', '!post', '"sources"', 'aliasStatus', '"deprecated"', 'format', 'evidence', 'cacheHits']) assert.equal(text.includes(hidden), false, hidden);
  const full = await ok('tag_details', { name: 'sitting', detail: 'full' });
  assert.equal(full.items[0].wiki.body, WIKI); assert.equal(full.detail, 'full');
  // A page that is only a definition has nothing more; one that opens with a heading gives the text under it; a long one is cut.
  assert.deepEqual(wikiDefinition('A short page.'), { text: 'A short page.', more: false });
  assert.deepEqual(wikiDefinition('h4. Definition\n\nSitting with knees up.\n\nh4. See also\n\n* [[x]]'), { text: 'Sitting with knees up.', more: true });
  assert.deepEqual([wikiDefinition('x'.repeat(900)).text.length, wikiDefinition('x'.repeat(900)).more], [600, true]);
  assert.equal(wikiDefinition(undefined), undefined);
  // The cooccurrence and full answers are not this projection's.
  assert.deepEqual(compactTags({ detail: 'full', items: [1] }), { detail: 'full', items: [1] });
});

test('read_workspace finds the one workspace itself when no workspaceId is given', async t => {
  const snapshot = { workspaceId: 'window-1', revision: 4, state: { params: { positivePrompt: 'a harbor' }, activeTab: 'generate' }, assets: [] };
  let workspaces = [{ workspaceId: 'window-1', revision: 4 }];
  const { ok, call, calls } = await connect(t, method => method === 'list_workspaces' ? { workspaces } : snapshot);
  const read = await ok('read_workspace', { includeImages: false });
  assert.deepEqual([read.workspaceId, read.revision, read.state.params.positivePrompt], ['window-1', 4, 'a harbor']);
  assert.deepEqual(calls.map(item => [item.method, item.args]), [['list_workspaces', {}], ['read_workspace', { workspaceId: 'window-1' }]]);
  calls.length = 0;
  await ok('read_workspace', { workspaceId: 'window-1', includeImages: false });
  assert.deepEqual(calls.map(item => item.method), ['read_workspace'], 'a given workspaceId is read directly');
  workspaces = [];
  assert.equal((await call('read_workspace', {})).structuredContent.error.code, 'invalid_response');
  assert.equal((await call('list_workspaces', {})).structuredContent.error.code, 'unknown_tool');
});

test('the projections leave anything that is not their answer alone', () => {
  for (const other of [null, undefined, 'text', { error: { code: 'x' } }]) { assert.equal(compactBatch(other), other); assert.equal(compactQueueList(other), other); assert.equal(compactTags(other), other); }
});
