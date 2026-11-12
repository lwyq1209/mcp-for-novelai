import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// MCP merge, phase one (N1–N10): one `novelai` server with a core and a canvas layer,
// flat public schemas, one idempotency namespace (the novelai-business alias was removed
// on 2026-10-09), one error envelope and fixed host methods per tool. Offline: fetch refused, tag cache redirected; every host
// is a recording double, and no test reads .runtime.
const tagCacheDir = await mkdtemp(join(tmpdir(), 'novelai-merge-tag-cache-'));
process.env.NOVELAI_TAG_QUERY_CACHE_DIR = tagCacheDir;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Real network access is forbidden in MCP merge tests.'); };
test.after(async () => { globalThis.fetch = originalFetch; await rm(tagCacheDir, { recursive: true, force: true }); });

const mcp = await import('../src/mcp.mjs');
const { contractSchemas: _contracts, validateContract } = await import('../contracts/validate.mjs');
const { assetLibraryFlatSchema, normalizeAssetLibraryRequest } = await import('../src/asset-library-categories.mjs');
const { DISPATCH_SCOPE, RECIPE_HOST_METHODS, mcpHostRequestKey } = await import('../src/recipe-queue.mjs');
const { INTERNAL_MESSAGES } = await import('../src/mcp-registry.mjs');
const { BridgeError, TOOL_DEFINITIONS, TOOL_REGISTRY, CORE_TOOL_NAMES, CANVAS_TOOL_NAMES } = mcp;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The production default project root (NOVELAI_PROJECT_ROOT, else <data root>/workspace).
const { PROJECT_ROOT } = await import('../src/business-guards.mjs');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9AAAAABJRU5ErkJggg==';
const UUID = '12345678-1234-4234-8234-123456789abc';
const registry = new Map(TOOL_REGISTRY.map(tool => [tool.name, tool]));

// Every host call made in this file, attributed to the tool being called (N10).
const observed = [];
let currentTool = null;
async function connect(t, handler = () => { throw new Error('No host call expected'); }, { create = mcp.createNovelAiMcpServer, ...options } = {}) {
  const calls = [];
  const bridgeClient = { async call(method, args) {
    observed.push({ tool: currentTool, method });
    calls.push({ method, args: structuredClone(args) });
    return handler(method, args);
  } };
  const server = create({ bridgeClient, ...options });
  const client = new Client({ name: 'merge-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, calls, call: async (name, args) => { currentTool = name; try { return await client.callTool({ name, arguments: args }); } finally { currentTool = null; } } };
}
const errorOf = result => { assert.equal(result.isError, true, JSON.stringify(result.structuredContent ?? result)); return result.structuredContent.error; };
const size = value => JSON.stringify(value).length;

// --------------------------------------------------------------------------- N1
const NO_ARGUMENT_TOOLS = ['list_queue', 'list_workspaces'];
// Some MCP clients keep only these three keys of a tool's input schema when they pass it to a model (for example a
// non-strict Anthropic messages conversion); every tool must still have its parameters after that projection.
const minimalProjection = schema => ({ type: 'object', properties: schema.properties ?? {}, required: schema.required ?? [] });

test('N1 surface: 13 tools, core layer first, flat closed schemas that survive a minimal client projection', async t => {
  const { client } = await connect(t);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 13);
  assert.deepEqual(tools, TOOL_DEFINITIONS);
  assert.deepEqual(tools.map(tool => tool.name), [...CORE_TOOL_NAMES, ...CANVAS_TOOL_NAMES]);
  assert.equal(CORE_TOOL_NAMES.length, 11); assert.deepEqual(CANVAS_TOOL_NAMES, ['list_workspaces', 'read_workspace'], 'the canvas generation tools were retired on 2026-11-02, the self-check and draft tools on 2026-11-12');
  assert.ok(!tools.some(tool => tool.name === 'style_sweep'), 'the style sweep tool was removed');
  assert.ok(!tools.some(tool => tool.name === 'search_tags'));
  assert.deepEqual(new Set(tools.map(tool => tool.name)).size, 13, 'no duplicate names');
  for (const tool of TOOL_REGISTRY) assert.ok(['core', 'canvas'].includes(tool.layer), tool.name);
  assert.deepEqual(TOOL_REGISTRY.filter(tool => tool.layer === 'core').map(tool => tool.name), CORE_TOOL_NAMES);
  for (const tool of tools) {
    const schema = tool.inputSchema;
    assert.equal(schema.type, 'object', tool.name);
    assert.equal(schema.additionalProperties, false, tool.name);
    for (const key of ['anyOf', 'oneOf', 'allOf', 'if', 'then', 'else', 'not']) assert.equal(schema[key], undefined, `${tool.name} has top-level ${key}`);
    assert.ok((schema.required ?? []).every(key => Object.hasOwn(schema.properties ?? {}, key)), `${tool.name}: required ⊆ properties`);
    const projected = minimalProjection(schema);
    if (NO_ARGUMENT_TOOLS.includes(tool.name)) assert.deepEqual(projected, { type: 'object', properties: {}, required: [] }, tool.name);
    else assert.ok(Object.keys(projected.properties).length > 0, `${tool.name} would have no parameters after the projection`);
    assert.deepEqual(Object.keys(tool).sort(), ['annotations', 'description', 'inputSchema', 'name'], 'registry internals stay private');
  }
  for (const name of CORE_TOOL_NAMES) assert.equal(registry.get(name).inputSchema.properties?.workspaceId, undefined, `${name} is core but takes a workspace`);
});

// --------------------------------------------------------------------------- N2 (removed together with the style sweep tool)
const accepts = (schema, value) => { try { validateContract(value, schema); return true; } catch { return false; } };

// --------------------------------------------------------------------------- N3
const ASSET_VALID = [
  { action: 'list' }, { action: 'list', category: 'presets' }, { action: 'list', kinds: ['combo'] }, { action: 'list', kinds: ['history', 'style_preset'], query: 'watercolor', limit: 20, offset: 0, sortBy: 'name', sortDirection: 'asc', includeArchived: true },
  { action: 'list', category: 'history', historyTags: ['rain'], historyTagMatch: 'any', historyTagSources: ['positive'] }, { action: 'list', collectionId: 'user:fixture' },
  { action: 'read', kind: 'reference_preset', id: 'reference-1' }, { action: 'read', kind: 'combo', id: 'combo:fixture', revision: 7, detail: 'full' },
  { action: 'image', kind: 'history', id: 'h1', revision: 2, assetId: 'a1', variant: 'original' }, { action: 'image', kind: 'history', id: 'h1', revision: 2, assetId: 'a1' },
  { action: 'collections' }, { action: 'create-collection', name: '雨窗书店' },
  { action: 'mutate', command: 'archive', items: [{ kind: 'note', id: 'note-1', expectedRevision: 1 }] },
  { action: 'mutate', command: 'archive', items: [{ kind: 'note', id: 'note:fixture', expectedRevision: 7 }], patch: { archived: true } },
  { action: 'mutate', command: 'update', items: [{ kind: 'combo', id: 'combo:fixture', expectedRevision: 7 }], patch: { notes: '  keep exact\n' } },
  { action: 'mutate', command: 'update', items: [{ kind: 'history', id: 'h1', expectedRevision: 1 }], patch: { groupId: '' } },
  { action: 'mutate', command: 'add-to-collection', items: [{ kind: 'combo', id: 'combo:fixture', expectedRevision: 7 }], collectionId: 'user:fixture' },
  { action: 'mutate', command: 'remove-from-collection', items: [{ kind: 'combo', id: 'combo:fixture', expectedRevision: 7 }], collectionId: 'user:fixture' },
  // Recently Deleted (step 3c).
  { action: 'mutate', command: 'delete', items: [{ kind: 'history', id: 'h1', expectedRevision: 2 }] }, { action: 'mutate', command: 'delete', items: [{ kind: 'study', id: 's1', expectedRevision: 1 }], preview: true },
  { action: 'mutate', command: 'delete', collectionId: 'user:fixture' }, { action: 'mutate', command: 'delete-archived' }, { action: 'mutate', command: 'delete-archived', kinds: ['history', 'tag'], preview: true },
  { action: 'recently-deleted' }, { action: 'recently-deleted', query: 'cup', offset: 20, limit: 20 },
  { action: 'restore', trashIds: ['0f8fad5b-d9cb-469f-a165-70867728950e'] }, { action: 'purge', trashIds: ['0f8fad5b-d9cb-469f-a165-70867728950e'] },
];
const ASSET_INVALID = [
  { action: 'list', category: 'all' }, { action: 'save' }, { action: 'migrate-renderer', collections: {} }, { action: 'create-collection', name: 'SFW', namespace: 'style' },
  { action: 'delete-collection', collectionId: 'user:fixture' }, { action: 'mutate', command: 'update', items: [{ kind: 'history', id: 'image-1', expectedRevision: 1 }], patch: { filePath: '/outside.png' } },
  { action: 'list', category: 'presets', kinds: ['history'] }, { action: 'list', category: 'presets', kinds: [] }, { action: 'list', category: 'tags', historyTags: ['rain'] },
  { action: 'list', limit: 21 }, { action: 'list', limit: 0 }, { action: 'read', kind: 'note', id: 'x', category: 'notes' }, { action: 'read', kind: 'note' },
  { action: 'image', kind: 'note', id: 'x', revision: 1, assetId: 'a' }, { action: 'image', kind: 'history', id: 'x', assetId: 'a' }, { action: 'collections', query: 'x' },
  { action: 'create-collection' }, { action: 'create-collection', name: '  ' }, { action: 'mutate', command: 'update', items: [{ kind: 'note', id: 'n', expectedRevision: 1 }] },
  { action: 'mutate', command: 'add-to-collection', items: [{ kind: 'note', id: 'n', expectedRevision: 1 }] }, { action: 'mutate', command: 'archive', items: [] },
  { action: 'mutate', command: 'archive', items: [{ kind: 'note', id: 'n', expectedRevision: '3' }] }, { action: 'mutate', command: 'update', items: [{ kind: 'note', id: 'n', expectedRevision: 1 }], patch: { observations: 'invented' } },
  { action: 'list', workspaceId: 'w' }, {},
  // Recently Deleted (step 3c): CAS is required, one target form at a time, trash ids are UUIDs, purge all is explicit.
  { action: 'mutate', command: 'delete', items: [{ kind: 'history', id: 'h1' }] }, { action: 'mutate', command: 'delete', items: [] }, { action: 'mutate', command: 'delete' },
  { action: 'mutate', command: 'delete', items: [{ kind: 'history', id: 'h1', expectedRevision: 1 }], collectionId: 'user:fixture' },
  { action: 'mutate', command: 'delete', items: [{ kind: 'history', id: 'h1', expectedRevision: 1 }], patch: { archived: true } }, { action: 'mutate', command: 'delete-archived', kinds: [] },
  { action: 'mutate', command: 'delete-archived', items: [{ kind: 'history', id: 'h1', expectedRevision: 1 }] }, { action: 'mutate', command: 'archive', items: [{ kind: 'note', id: 'n', expectedRevision: 1 }], preview: true },
  { action: 'recently-deleted', limit: 21 }, { action: 'recently-deleted', kinds: ['history'] }, { action: 'restore' }, { action: 'restore', trashIds: [] }, { action: 'restore', trashIds: ['trash-1'] },
  { action: 'restore', trashIds: ['0f8fad5b-d9cb-469f-a165-70867728950e', '0f8fad5b-d9cb-469f-a165-70867728950e'] }, { action: 'purge' }, { action: 'purge', all: false },
  { action: 'purge', all: true, trashIds: ['0f8fad5b-d9cb-469f-a165-70867728950e'] }, { action: 'restore', all: true },
  // Emptying all of Recently Deleted is the desktop's action only (review rework): agents purge named trashIds.
  { action: 'purge', all: true },
];

test('N3 asset_library: every valid request passes the flat schema and the full public contract and reaches the host; every invalid one is refused before it', async t => {
  const { call, calls } = await connect(t, () => { throw new BridgeError('stop_here', 'Recorded; no reply needed.'); });
  for (const args of ASSET_VALID) {
    assert.ok(accepts(assetLibraryFlatSchema, args), `flat accepts ${JSON.stringify(args)}`);
    assert.doesNotThrow(() => normalizeAssetLibraryRequest(args), JSON.stringify(args));
    const before = calls.length;
    assert.equal(errorOf(await call('asset_library', args)).code, 'stop_here', JSON.stringify(args));
    assert.equal(calls.length, before + 1, `${JSON.stringify(args)} reached the host once`);
    assert.equal(calls.at(-1).method, 'asset_library');
  }
  const forwarded = calls.length;
  for (const args of ASSET_INVALID) {
    const flatRejects = !accepts(assetLibraryFlatSchema, args);
    let contractRejects = false;
    try { normalizeAssetLibraryRequest(args); } catch { contractRejects = true; }
    assert.ok(flatRejects || contractRejects, `${JSON.stringify(args)} must be invalid`);
    assert.equal(errorOf(await call('asset_library', args)).code, 'invalid_arguments', JSON.stringify(args));
  }
  assert.equal(calls.length, forwarded, 'no invalid request reached the host');
  // The flat schema is never stricter than the contract for the advertised fields.
  assert.deepEqual(assetLibraryFlatSchema.properties.category.enum, ['history', 'imports', 'tags', 'presets', 'notes']);
  assert.equal(assetLibraryFlatSchema.properties.limit.maximum, 20);
});

// --------------------------------------------------------------------------- N4
test('N4 size budget: tools/list totals stay under the agreed ceilings', async t => {
  const { client } = await connect(t);
  const { tools } = await client.listTools();
  const total = tools.reduce((sum, tool) => sum + size(tool), 0);
  const core = tools.filter(tool => CORE_TOOL_NAMES.includes(tool.name)).reduce((sum, tool) => sum + size(tool), 0);
  const asset = size(tools.find(tool => tool.name === 'asset_library'));
  t.diagnostic(`tools/list characters: total ${total}, core ${core}, canvas ${total - core}, asset_library ${asset}, instructions ${(client.getInstructions() ?? '').length}`);
  const prepare = size(tools.find(tool => tool.name === 'prepare_recipe'));
  t.diagnostic(`prepare_recipe ${prepare}`);
  // design-addendum §1.8: the phase-two prepare_recipe (six modes, mask, preview) raised the ceilings to 78k / 38k.
  // New budget after the canvas tools were retired (approved by the main session 2026-11-02): the canvas capture of
  // prepare_recipe and the asset_library export action raise core to 40k and asset_library to 5k; without the eight
  // canvas generation tools the whole server fits in 50k. Step 3c (Recently Deleted: delete, recently-deleted, restore,
  // purge; approved for that step) raises asset_library to 5.8k inside the same core and server ceilings.
  // read_queue wait and the whole-batch get_queue_result (thumbnails) raised core to 42k (approved by the main session
  // 2026-11-05). V5 Full Effort (prepare_recipe effort) and Enhance Max✨ (scale "max") add their rules, which must be
  // visible before a call (Medium's fixed values, Max's size and its Anlas cost on Opus; approved by the main session
  // 2026-11-05): together they raise core to 42.5k (about 42.1k used). 0.1.4 (approved by the main session 2026-11-05):
  // prepare_recipe corrects instead of refusing and enqueue_recipes settles an unknown outcome itself, so the rules of
  // multipleOf/bounds, acceptDownscale, explicit seeds and the 130-second settle window are gone and the new behaviour
  // is described instead; core came out about 42.1k again, so the ceiling goes down to 42.4k (a few hundred spare).
  // asset_library censor (the agent's way to the window's Censor and export; asked for by the user 2026-11-11) adds
  // its action, five fields and the rules a caller must know before the call (what is written and where, the mask
  // grammar it shares with inpaint, the default cell size, preview first): asset_library goes to 6.9k and core to
  // 43.3k; the whole server still fits in 50k. Compact reads (asked for by the user 2026-11-12): the five canvas
  // self-check and draft tools are retired and prepare_recipe describes its compact readback inside the same core
  // ceiling, so the whole server goes down to 45.5k (about 44.9k used).
  assert.ok(total <= 45_500, `whole server ${total}`);
  assert.ok(core <= 43_300, `core layer ${core}`);
  assert.ok(asset <= 6_900, `asset_library ${asset}`);
});

// --------------------------------------------------------------------------- N5
test('N5 one idempotency namespace: one requestKey maps to one host key on separate server instances (sessions)', async t => {
  const first = await connect(t, () => ({}));
  const second = await connect(t, () => ({}));
  const requestKey = 'n5 same intent /Users/x token: y';
  for (const server of [first, second]) await server.call('lookup_enqueue', { requestKey });
  const keys = [...first.calls, ...second.calls].filter(item => item.method === RECIPE_HOST_METHODS.lookup).map(item => item.args.requestKey);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.equal(keys[0], mcpHostRequestKey(requestKey));
});

// --------------------------------------------------------------------------- N6
test('N6 golden: the idempotency namespace and its host key never change', async () => {
  assert.equal(DISPATCH_SCOPE, 'mcp-for-novelai/recipe-queue/v1');
  assert.equal(mcpHostRequestKey('mcp-merge-golden-2026-10-08'), 'mcp-55bd29d3d6d437b025bc617b-a792ca4674952e0501b71cbaca8936af894881f42dd8489b3d6f6e3783fadb6a');
  const source = await readFile(join(root, 'src/recipe-queue.mjs'), 'utf8');
  assert.match(source, /^export const DISPATCH_SCOPE = 'mcp-for-novelai\/recipe-queue\/v1';$/m);
});

// N7 (module graph of the entry point) lives in mcp-business.test.mjs with the stdio check.

// --------------------------------------------------------------------------- N8
test('N8 unknown names: former tool names (search_tags), raw host methods and strangers are all unknown_tool, none reaches the host', async t => {
  const { call, calls } = await connect(t);
  assert.equal(Object.hasOwn(mcp, 'RETIRED_TOOLS'), false, 'no former tool name gets a special answer');
  for (const args of [{ workspaceId: 'w', query: 'garden' }, {}, { query: 'x', limit: 99 }]) assert.equal(errorOf(await call('search_tags', args)).code, 'unknown_tool');
  const raw = ['put_queue_recipe', 'read_queue_recipe', 'derive_queue_recipe', 'lookup_derived_queue_recipe', 'enqueue_queue_recipes', 'lookup_queue_request', 'material_tags', 'material_samples', 'style_trial', 'style_experiment', 'style_sweep',
    'search_tags ', 'Search_tags', 'novelai_enqueue', 'bridge', 'rpc', '__proto__', 'constructor', 'toString', 'hasOwnProperty', ''];
  for (const name of raw) assert.equal(errorOf(await call(name, { requestKey: 'x', preparation: {} })).code, 'unknown_tool', JSON.stringify(name));
  assert.deepEqual(calls, []);
});

// --------------------------------------------------------------------------- N9
test('N9 one error envelope: canvas tools hide unrecognized failures, scrub paths and credentials from host errors, and echo the submitted requestKey', async t => {
  let thrower;
  const { call } = await connect(t, () => thrower());
  const envelope = result => {
    assert.deepEqual(Object.keys(result).sort(), ['content', 'isError', 'structuredContent']);
    assert.equal(result.content.length, 1);
    assert.deepEqual(JSON.parse(result.content[0].text), { error: result.structuredContent.error });
    return result.structuredContent.error;
  };
  thrower = () => { throw new TypeError("/Users/someone/private/secret.js exploded; token=abc123"); };
  for (const [name, args] of [['list_workspaces', {}], ['read_workspace', { workspaceId: 'w' }]]) {
    const result = await call(name, args);
    assert.deepEqual(envelope(result), { code: 'internal_error', message: INTERNAL_MESSAGES.canvas }, name);
  }
  const projectFile = join(PROJECT_ROOT, 'novelai', 'library', 'entry.json');
  thrower = () => { throw new BridgeError('conflict', `open '/Users/someone/x/y.json' and '${projectFile}' failed; api_key: k-123; Authorization: Bearer abc.def.ghi`, { note: "path '/Users/someone/a.png'", currentRevision: 5, apiKey: 'dropped', requestKey: 'injected /Users/someone/x token=zz' }); };
  const conflict = envelope(await call('read_workspace', { workspaceId: 'w', includeImages: false }));
  assert.equal(conflict.code, 'conflict');
  for (const secret of ['/Users/someone', 'k-123', 'abc.def.ghi', 'zz', PROJECT_ROOT]) assert.ok(!JSON.stringify(conflict).includes(secret), `${secret} leaked: ${JSON.stringify(conflict)}`);
  assert.match(conflict.message, /novelai\/library\/entry\.json/, 'project paths become project-relative');
  assert.match(conflict.message, /<path>/);
  assert.deepEqual(Object.keys(conflict.details).sort(), ['currentRevision', 'note', 'requestKey']);
  assert.equal(conflict.details.currentRevision, 5);
  // A host key in its own format comes back byte-for-byte; other identity-named fields are scrubbed.
  const requestKey = 'night /Users/Alice/drafts token: v1';
  thrower = () => { throw new BridgeError('timeout', 'Outcome unknown; read the workspace before continuing.', { requestKey: `mcp-${'a'.repeat(24)}-${'b'.repeat(64)}`, other: { requestKey: 'different /Users/Alice/x/y' }, note: requestKey }); };
  const unknown = envelope(await call('read_workspace', { workspaceId: 'w', includeImages: false }));
  assert.equal(unknown.code, 'timeout');
  assert.equal(unknown.details.requestKey, `mcp-${'a'.repeat(24)}-${'b'.repeat(64)}`, 'a host key in its own format passes unchanged');
  assert.equal(unknown.details.other.requestKey, 'different <path>');
  assert.ok(!JSON.stringify(unknown).includes('/Users/Alice'));
  // Parameter errors of every layer share the envelope.
  for (const [name, args] of [['read_workspace', { workspace_id: 'w' }], ['asset_library', { action: 'save' }], ['material_library', {}]]) {
    assert.equal(envelope(await call(name, args)).code, 'invalid_arguments', name);
  }
  assert.deepEqual(envelope(await call('no_such_tool', {})).code, 'unknown_tool');
});

// --------------------------------------------------------------------------- N10
const STRICT_HISTORY = { kind: 'history', id: 'h', revision: 1, assetId: 'a' };
const T2I = { mode: 't2i', model: 'nai-diffusion-5-full', width: 832, height: 1216, steps: 28, cfgScale: 5, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', ucPreset: 0, qualityPreset: 'standard', stylePrompt: '', positivePrompt: 'garden', negativePrompt: '', seed: 1 };
const UPSCALE = { mode: 'upscale', source: { kind: 'history', historyId: 'h', historyRevision: 1, assetId: 'a' }, scale: 2 };
const w = { workspaceId: 'w' };
/** One valid call per tool (several for multi-method tools), enough to reach every fixed host method. */
const EXERCISE = {
  material_library: [{ action: 'list' }, { action: 'search_tags', query: 'garden', limit: 20 }, { action: 'cover', entryId: 'e' }, { action: 'set_cover_from_history', entryId: UUID, revision: 1, expectedCoverRevision: 0, historyId: 'h', historyRevision: 1, assetId: 'a' }],
  tag_details: [{ name: 'garden' }], material_studies: [{ action: 'list' }], asset_library: [{ action: 'list' }, { action: 'image', ...STRICT_HISTORY }, { action: 'export', ...STRICT_HISTORY },
    { action: 'censor', ...STRICT_HISTORY, mask: { units: 'px', layers: [{ op: 'add', shape: { type: 'rect', x: 0, y: 0, width: 1, height: 1 } }] }, preview: true }],
  prepare_recipe: [T2I, { ...T2I, recipeId: UUID, expectedRevision: 1 }, UPSCALE, { ...UPSCALE, preview: true }, { mode: 't2i', canvas: { workspaceId: 'w', expectedRevision: 1 } }],
  enqueue_recipes: [{ requestKey: 'n10', items: [{ recipeId: UUID, recipeRevision: 1, inputHash: 'a'.repeat(64) }] }], lookup_enqueue: [{ requestKey: 'n10' }],
  list_queue: [{}], read_queue: [{ batchId: UUID }], get_queue_result: [{ batchId: UUID, itemIndex: 0 }], control_queue: ['pause', 'resume', 'cancel'].map(action => ({ batchId: UUID, action })),
  list_workspaces: [{}], read_workspace: [w],
};
// Replies just complete enough to reach each tool's follow-up host calls.
const pngBytes = Buffer.from(png, 'base64'), pngSha = createHash('sha256').update(pngBytes).digest('hex');
const replies = (method, args) => {
  // A strictly valid history thumbnail, so an image-mode prepare_recipe goes on to its put or preview.
  if (method === 'asset_library' && args.action === 'image') return { kind: 'history', id: args.id, revision: args.revision, assetId: args.assetId, role: 'original', variant: args.variant ?? 'thumbnail',
    mimeType: 'image/png', width: 1, height: 1, byteLength: pngBytes.length, sha256: pngSha, sourceMimeType: 'image/png', sourceWidth: 1, sourceHeight: 1, sourceByteLength: pngBytes.length, sourceSha256: pngSha, contentBinding: 'recorded-sha256', data: png };
  if (method === 'read_workspace') return { workspaceId: 'w', revision: 1, assets: [{ id: 'current', role: 'currentImage', mimeType: 'image/png' }] };
  if (method === 'get_asset') return { mimeType: 'image/png', data: png };
  if (method === 'lookup_queue_request') return {};
  return {};
};
function bridgeMethods() {
  const source = readFile(join(root, 'client/electron/bridge-server.ts'), 'utf8');
  return source.then(text => {
    const methods = new Set();
    const initial = /const METHODS = new Set\(\[([^\]]*)\]\)/.exec(text);
    assert.ok(initial, 'METHODS declaration found');
    for (const match of initial[1].matchAll(/'([a-z_]+)'/g)) methods.add(match[1]);
    for (const match of text.matchAll(/METHODS\.add\('([a-z_]+)'\)/g)) methods.add(match[1]);
    for (const match of text.matchAll(/for \(const method of \[([^\]]*)\]\) METHODS\.add\(method\)/g)) for (const name of match[1].matchAll(/'([a-z_]+)'/g)) methods.add(name[1]);
    return methods;
  });
}

test('N10 host methods: every declared method is a real bridge method, and every call made by a tool is on its own fixed list', async t => {
  const METHODS = await bridgeMethods();
  assert.deepEqual([...METHODS].sort(), ['apply_edit', 'asset_library', 'cancel_queue', 'capture_canvas_recipe', 'censor_image', 'draft_edit', 'enqueue_queue_recipes', 'get_asset', 'get_queue_result', 'list_queue',
    'list_workspaces', 'lookup_queue_request', 'material_library', 'material_samples', 'material_studies', 'material_tags', 'pause_queue', 'preview_queue_recipe', 'put_queue_recipe', 'read_prompt_review',
    'read_queue', 'read_queue_recipe', 'read_workspace', 'resume_queue', 'undo_edit'], `parsed ${METHODS.size} bridge methods`);
  // The canvas generation methods left the bridge with their tools; the local-continuation methods in step 3e.
  for (const retired of ['submit_generation', 'list_generation_jobs', 'read_generation_job', 'cancel_generation_job', 'get_generation_result', 'submit_batch', 'list_batches', 'read_batch', 'pause_batch', 'resume_batch', 'cancel_batch', 'batch_checkpoint', 'collect_canvas_preparation',
    'derive_queue_recipe', 'lookup_derived_queue_recipe'])
    assert.ok(!METHODS.has(retired), `${retired} is not a bridge method`);
  const declared = new Set(TOOL_REGISTRY.flatMap(tool => tool.hostMethods));
  assert.deepEqual([...declared].filter(method => !METHODS.has(method)), [], 'hostMethods ⊆ bridge-server METHODS');
  assert.ok(!declared.has('search_tags'), 'the retired canvas search_tags host route is no longer declared');
  assert.deepEqual(registry.get('tag_details').hostMethods, [], 'tag details never use the bridge');
  assert.deepEqual(Object.keys(EXERCISE).sort(), TOOL_DEFINITIONS.map(tool => tool.name).sort(), 'every tool is exercised');
  const tagQuery = { fetchImpl: async () => new Response('[]', { headers: { 'content-type': 'application/json' } }) };
  // asset_library export writes the exported original under the project root: a throwaway one of this test, never the
  // default <data root>/workspace (review rework 2: a direct `node --test` run once wrote it into the real data root).
  const projectRoot = await mkdtemp(join(tmpdir(), 'mcp-merge-n10-project-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const { call } = await connect(t, replies, { tagQuery, projectRoot, projectRootSource: 'NOVELAI_PROJECT_ROOT' });
  const reached = new Set();
  for (const [name, list] of Object.entries(EXERCISE)) for (const args of list) {
    const before = observed.length;
    await call(name, args);
    for (const entry of observed.slice(before)) reached.add(`${entry.tool}:${entry.method}`);
  }
  t.diagnostic(`reached ${reached.size} tool:method pairs`);
  // Follow-up methods that only a multi-step success path reaches are exercised here, not just declared.
  for (const pair of ['read_workspace:get_asset', 'material_library:material_tags', 'material_library:material_samples', 'material_library:asset_library',
    'prepare_recipe:put_queue_recipe', 'prepare_recipe:read_queue_recipe', 'prepare_recipe:asset_library', 'prepare_recipe:preview_queue_recipe', 'prepare_recipe:capture_canvas_recipe', 'enqueue_recipes:lookup_queue_request', 'control_queue:pause_queue', 'control_queue:resume_queue', 'control_queue:cancel_queue',
    'asset_library:asset_library', 'lookup_enqueue:lookup_queue_request']) assert.ok(reached.has(pair), pair);
});

test('N10 every host call observed across this file was made by a tool that declares that method', () => {
  assert.ok(observed.length > 25, `${observed.length} host calls observed`);
  const outside = observed.filter(({ tool, method }) => !registry.get(tool)?.hostMethods.includes(method));
  assert.deepEqual(outside, []);
});

// --------------------------------------------------------------------------- P3-4 / P3-5 (review follow-up)
test('P3-4 host-method allowlist at run time: a tool reaching a method outside its hostMethods gets host_method_not_allowed and nothing reaches the host', async t => {
  const { createRegistryServer, defineRegistry } = await import('../src/mcp-registry.mjs');
  const { guardBridge } = await import('../src/business-guards.mjs');
  const { createRecipeQueue } = await import('../src/recipe-queue.mjs');
  const sent = [];
  const bridgeClient = { async call(method) { sent.push(method); if (method === 'read_queue_recipe') throw new BridgeError('recipe_not_found', 'No such recipe.'); return { batches: [] }; } };
  const bridge = guardBridge(bridgeClient);
  const empty = { type: 'object', properties: {}, additionalProperties: false };
  const probe = (name, hostMethods, handle) => ({ name, layer: 'core', errors: 'opaque', description: name, inputSchema: empty, annotations: {}, hostMethods, handle });
  const prepare = registry.get('prepare_recipe');
  const entries = defineRegistry([
    probe('outside', ['list_queue'], async (_args, ctx) => { await ctx.bridge.call('put_queue_recipe', {}); return { content: [] }; }),
    // A tool that swallows the refusal still fails: the allowlist outcome does not depend on the tool's own error handling.
    probe('swallowing', ['list_queue'], async (_args, ctx) => { try { await ctx.bridge.call('enqueue_queue_recipes', {}); } catch {} return { content: [{ type: 'text', text: '{}' }], structuredContent: {} }; }),
    probe('inside', ['list_queue'], async (_args, ctx) => { await ctx.bridge.call('list_queue', {}); return { content: [{ type: 'text', text: '{}' }], structuredContent: {} }; }),
    // The real prepare_recipe with a narrower list: its recipe module holds the server's bridge, created before any call.
    { ...prepare, hostMethods: [] },
  ]);
  const server = createRegistryServer({ serverInfo: { name: 'allowlist-test', version: '1' }, instructions: '', registry: entries, exposed: entries.map(entry => entry.name),
    context: { bridge, recipes: createRecipeQueue({ bridge }), roots: [], dirs: {}, tagOptions: {} } });
  const client = new Client({ name: 'allowlist', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  for (const [name, args] of [['outside', {}], ['swallowing', {}], ['prepare_recipe', T2I]]) {
    const error = errorOf(await client.callTool({ name, arguments: args }));
    assert.equal(error.code, 'host_method_not_allowed', `${name}: ${JSON.stringify(error)}`);
    assert.match(error.message, /outside its fixed list/);
  }
  assert.deepEqual(sent, [], 'not a single host call was sent');
  assert.equal((await client.callTool({ name: 'inside', arguments: {} })).isError, undefined);
  assert.deepEqual(sent, ['list_queue'], 'a declared method goes through');
  // Outside any tool call the guard sends nothing; only an explicit test-only option lets a module be driven directly.
  await assert.rejects(bridge.call('list_queue', {}), error => error.code === 'host_call_outside_tool');
  assert.deepEqual(sent, ['list_queue']);
  await guardBridge(bridgeClient, { allowOutsideToolCalls: true }).call('list_queue', {});
  assert.deepEqual(sent, ['list_queue', 'list_queue']);
});

test('hostCallScope denies by default: in the production wiring a host call outside any tool call is refused and nothing is sent', async t => {
  const sent = [];
  const bridgeClient = { async call(method, args) { sent.push(method); return method === 'lookup_queue_request' ? {} : { batches: [] }; } };
  // createToolContext is exactly what createNovelAiMcpServer builds per server.
  const context = mcp.createToolContext({ bridgeClient });
  await assert.rejects(context.bridge.call('list_queue', {}), error => error.code === 'host_call_outside_tool' && /outside a tool call; nothing was sent/.test(error.message));
  // Also the recipe queue, which holds this bridge from server creation on.
  await assert.rejects(context.recipes.lookup({ requestKey: 'outside' }), error => error.code === 'host_call_outside_tool');
  // A timer started outside any tool call is outside too.
  await assert.rejects(new Promise((resolve, reject) => setTimeout(() => context.bridge.call('list_queue', {}).then(resolve, reject), 1)), error => error.code === 'host_call_outside_tool');
  assert.deepEqual(sent, [], 'nothing reached the host');
  // The server passes no escape option: its only guardBridge call takes the bridge client alone.
  const entry = await readFile(join(root, 'src/mcp.mjs'), 'utf8');
  assert.deepEqual(entry.match(/guardBridge\([^)]*\)/g), ['guardBridge(bridgeClient)']);
  assert.doesNotMatch(entry, /allowOutsideToolCalls/);
  // Inside a tool call the same wiring works on the server.
  const server = mcp.createNovelAiMcpServer({ bridgeClient });
  const client = new Client({ name: 'scope-default', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  assert.equal((await client.callTool({ name: 'lookup_enqueue', arguments: { requestKey: 'inside' } })).isError, undefined);
  assert.equal((await client.callTool({ name: 'list_queue', arguments: {} })).isError, undefined);
  assert.deepEqual(sent, ['lookup_queue_request', 'list_queue']);
});

test('P3-5 the instructions say which canvas tools take no workspaceId', async t => {
  const { client } = await connect(t);
  const instructions = client.getInstructions() ?? '';
  assert.doesNotMatch(instructions, /canvas tools take a workspaceId/i);
  const without = TOOL_REGISTRY.filter(tool => tool.layer === 'canvas' && !tool.inputSchema.properties?.workspaceId).map(tool => tool.name);
  assert.deepEqual(without, ['list_workspaces']);
  for (const name of without) assert.ok(new RegExp(`\\b${name}\\b \\(no arguments\\)`).test(instructions), `${name} is named as taking none: ${instructions}`);
});

test('host_call_outside_tool is mapped like host_method_not_allowed when a tool loses its call context', async t => {
  const { createRegistryServer, defineRegistry } = await import('../src/mcp-registry.mjs');
  const { guardBridge, hostCallScope } = await import('../src/business-guards.mjs');
  const sent = [];
  const bridge = guardBridge({ async call(method) { sent.push(method); return {}; } });
  const empty = { type: 'object', properties: {}, additionalProperties: false };
  const entries = defineRegistry([{ name: 'detached', layer: 'core', errors: 'opaque', description: 'detached', inputSchema: empty, annotations: {}, hostMethods: ['list_queue'],
    // Work that escapes the tool call's context (as a listener registered outside it would).
    async handle(_args, ctx) { await hostCallScope.exit(() => ctx.bridge.call('list_queue', {})); return { content: [] }; } }]);
  const server = createRegistryServer({ serverInfo: { name: 'outside-test', version: '1' }, instructions: '', registry: entries, exposed: ['detached'], context: { bridge, roots: [], dirs: {}, tagOptions: {} } });
  const client = new Client({ name: 'outside', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const error = errorOf(await client.callTool({ name: 'detached', arguments: {} }));
  assert.equal(error.code, 'host_call_outside_tool', JSON.stringify(error));
  assert.match(error.message, /outside a tool call/); assert.match(error.message, /nothing was sent/);
  assert.deepEqual(sent, []);
});
