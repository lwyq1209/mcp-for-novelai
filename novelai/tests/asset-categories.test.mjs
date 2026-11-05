import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BridgeError, createNovelAiMcpServer } from '../src/mcp.mjs';
import { contractSchemas, validateContract } from '../contracts/validate.mjs';
import { normalizeAssetLibraryRequest } from '../src/asset-library-categories.mjs';
import { assetLibraryHostRequest } from '../src/asset-library-response.mjs';
import ts from 'typescript';

// Independent expected mapping: do not import the implementation being tested.
const categories = {
  history: ['history'], imports: ['study'], tags: ['tag', 'artist_favorite'],
  presets: ['combo', 'style_preset', 'positive_preset', 'prompt_chunk', 'reference_preset'], notes: ['note'],
};
const rows = Object.entries(categories).flatMap(([category, kinds]) => kinds.map(kind => ({
  kind, id: `${kind}:fixture`, revision: 7, name: '分类 fixture', payload: { text: '  exact\nfixture ' },
  // Having a cover/preview is deliberately NOT the definition of an image category.
  preview: { assetId: `${kind}:image`, role: kind === 'tag' ? 'cover' : 'original', cacheKey: 'fixture' },
  category: 'untrusted-host-category',
})));
const categoryFor = kind => Object.keys(categories).find(category => categories[category].includes(kind));
function fixtureBridge() {
  const calls = [];
  return { calls, async call(method, args, signal) {
    calls.push({ method, args: structuredClone(args), signal });
    assert.equal(method, 'asset_library');
    assert.ok(!Object.hasOwn(args, 'category'), 'category must not reach the unchanged host');
    assert.ok(!Object.hasOwn(args, 'detail'));
    if (args.action === 'list') {
      const selected = rows.filter(item => !args.kinds?.length || args.kinds.includes(item.kind));
      const offset = args.offset ?? 0;
      return { items: selected.slice(offset, offset + args.limit), total: selected.length, revision: 31, offset };
    }
    if (args.action === 'read') return { item: rows.find(item => item.kind === args.kind && item.id === args.id), assets: [], links: [] };
    return { method, args };
  } };
}
async function mcp(t, bridge) {
  const server = createNovelAiMcpServer({ bridgeClient: bridge });
  const client = new Client({ name: 'asset-category-fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}
test('MCP category presets includes combo and preserves exact typed readback', async t => {
  const bridge = fixtureBridge(), client = await mcp(t, bridge);
  for (const category of ['presets', 'history', 'imports', 'tags', 'notes']) {
    const kinds = categories[category];
    const args = { action: 'list', category, limit: 20 };
    const result = await client.callTool({ name: 'asset_library', arguments: args });
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.deepEqual(result.structuredContent.items.map(item => item.kind), kinds);
    assert.ok(result.structuredContent.items.every(item => item.category === category));
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.deepEqual(bridge.calls.at(-1).args, { action: 'list', kinds, limit: 20 });
  }
  const combo = rows.find(item => item.kind === 'combo');
  const read = { action: 'read', kind: combo.kind, id: combo.id, revision: combo.revision, detail: 'full' };
  const full = await client.callTool({ name: 'asset_library', arguments: read });
  assert.deepEqual(full.structuredContent.item, combo, 'full typed record stays unchanged');
  assert.equal(full.structuredContent.responseInfo.category, 'presets');
});

test('cross-category search labels every result by kind, never by cover or claimed category', async t => {
  const bridge = fixtureBridge(), client = await mcp(t, bridge);
  const args = { action: 'list', query: 'fixture', limit: 20 };
  const result = await client.callTool({ name: 'asset_library', arguments: args });
  const structured = result.structuredContent;
  assert.equal(structured.items.length, 10);
  for (const item of structured.items) {
    assert.equal(item.category, categoryFor(item.kind));
    assert.equal(item.id, `${item.kind}:fixture`);
    assert.equal(item.revision, 7);
    assert.equal(item.image.inspected, false);
  }
  assert.equal(structured.items.find(item => item.kind === 'tag').image.preview.role, 'cover');
  assert.ok(Buffer.byteLength(result.content[0].text) <= 12 * 1024);
  assert.equal(result.content.length, 1, 'list must not read or attach images');
  assert.deepEqual(bridge.calls.map(call => call.args), [args]);
});

test('category intersects kinds and ANDs collection/search/pagination/history filters without widening', async t => {
  const bridge = fixtureBridge(), client = await mcp(t, bridge);
  const requests = [
    { action: 'list', category: 'presets', kinds: ['note', 'combo', 'prompt_chunk'], collectionId: 'user:fixture', query: 'fixture', offset: 1, limit: 1, sortBy: 'name', sortDirection: 'asc', includeArchived: true },
    { action: 'list', category: 'history', kinds: ['history', 'tag'], historyTags: ['blue sky'], historyTagMatch: 'any', historyTagSources: ['character'], limit: 2 },
  ];
  for (const args of requests) {
    const { category, ...expected } = args;
    expected.kinds = args.kinds.filter(kind => categories[category].includes(kind));
    const result = await client.callTool({ name: 'asset_library', arguments: args });
    assert.equal(result.isError, undefined);
    assert.deepEqual(bridge.calls.slice(-1).map(call => call.args), [expected]);
  }
});

test('illegal categories, empty intersections and conflicting history-only filters never call host', async t => {
  const bridge = fixtureBridge(), client = await mcp(t, bridge);
  const invalid = [
    ...['all', 'combo', 'study', 'Presets', '', ' presets ', null, 1, ['presets'], {}].map(category => ({ action: 'list', category })),
    { action: 'list', category: 'presets', kinds: [] },
    { action: 'list', category: 'presets', kinds: ['history', 'note'] },
    { action: 'list', category: 'presets', kinds: ['combo', 'combo'] },
    { action: 'list', category: 'presets', kinds: ['invented'] },
    { action: 'list', category: 'imports', historyTags: ['blue sky'] },
    { action: 'list', category: 'tags', historyTags: [] },
    { action: 'list', category: 'notes', historyTagMatch: 'any' },
    { action: 'list', category: 'presets', historyTagSources: ['positive'] },
    { action: 'list', category: 'history', limit: 21 },
    { action: 'list', category: 'history', limit: '10' },
    { action: 'list', category: 'history', collectionId: '' },
    { action: 'list', category: 'history', detail: 'full' },
    { action: 'list', category: 'history', unexpected: true },
    { action: 'read', category: 'presets', kind: 'combo', id: 'combo:fixture', revision: 7 },
    { action: 'image', category: 'tags', kind: 'tag', id: 'tag:fixture', revision: 7, assetId: 'tag:image' },
    { action: 'collections', category: 'presets' },
    { action: 'create-collection', category: 'presets', name: 'fixture' },
    { action: 'mutate', category: 'presets', command: 'update', items: [{ kind: 'combo', id: 'combo:fixture', expectedRevision: 7 }], patch: { notes: 'fixture' } },
  ];
  for (const args of invalid) {
    const result = await client.callTool({ name: 'asset_library', arguments: args });
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(result.structuredContent.error.code, 'invalid_arguments', JSON.stringify(args));
  }
  assert.equal(bridge.calls.length, 0);
});

test('legacy empty kinds, cross-kind list and revisioned writes retain their host arguments', async t => {
  const bridge = fixtureBridge(), client = await mcp(t, bridge);
  const requests = [
    { action: 'list' }, { action: 'list', kinds: [] },
    { action: 'list', kinds: ['tag', 'combo', 'history'], limit: 20 },
    { action: 'list', historyTags: ['blue sky'], historyTagMatch: 'any' },
    { action: 'read', kind: 'note', id: 'note:fixture', revision: 7 },
    { action: 'collections' }, { action: 'create-collection', name: 'fixture' },
    { action: 'mutate', command: 'update', items: [{ kind: 'combo', id: 'combo:fixture', expectedRevision: 7 }], patch: { notes: '  keep exact\n' } },
    { action: 'mutate', command: 'add-to-collection', items: [{ kind: 'combo', id: 'combo:fixture', expectedRevision: 7 }], collectionId: 'user:fixture' },
    { action: 'mutate', command: 'remove-from-collection', items: [{ kind: 'combo', id: 'combo:fixture', expectedRevision: 7 }], collectionId: 'user:fixture' },
    { action: 'mutate', command: 'archive', items: [{ kind: 'note', id: 'note:fixture', expectedRevision: 7 }], patch: { archived: true } },
  ];
  for (const args of requests) {
    const result = await client.callTool({ name: 'asset_library', arguments: args });
    assert.equal(result.isError, undefined);
    const expected = args.action === 'list' ? { ...args, limit: args.limit ?? 10 } : args;
    assert.deepEqual(bridge.calls.slice(-1).map(call => call.args), [expected]);
  }
});

test('MCP advertises the optional list-only category enum', async t => {
  const bridge = fixtureBridge(), client = await mcp(t, bridge);
  const publicSchema = (await client.listTools()).tools.find(tool => tool.name === 'asset_library').inputSchema;
  assert.ok(publicSchema.properties.category, 'public list schema must declare category');
  assert.deepEqual(publicSchema.properties.category.enum, Object.keys(categories));
  assert.equal(publicSchema.additionalProperties, false);
  assert.deepEqual(contractSchemas.requests.asset_library.properties.category, undefined, 'host/generated contract is not extended');
  assert.throws(() => validateContract({ action: 'list', category: 'presets' }, contractSchemas.requests.asset_library_desktop), { code: 'invalid_arguments' });
  for (const args of [{ action: 'list', category: 'presets' }, { action: 'list', kinds: ['combo'] }]) {
    validateContract(args, publicSchema);
    const result = await client.callTool({ name: 'asset_library', arguments: args });
    assert.equal(result.structuredContent.items[0].kind, 'combo');
    assert.equal(result.structuredContent.items[0].category, 'presets');
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  }
  for (const args of [
    { action: 'list', category: 'all', query: 'host-call-forbidden' },
    { action: 'list', category: 'presets', kinds: ['history'], query: 'host-call-forbidden' },
  ]) assert.equal((await client.callTool({ name: 'asset_library', arguments: args })).structuredContent.error.code, 'invalid_arguments');
  assert.equal(bridge.calls.some(call => call.args.query === 'host-call-forbidden'), false);
});

test('a host ignoring the selected kinds cannot label a cover as a history page', async t => {
  let count = 0;
  const bridge = { async call() { count++; return { items: [rows.find(item => item.kind === 'tag')], total: 1, revision: 31 }; } };
  const args = { action: 'list', category: 'history' };
  const client = await mcp(t, bridge), result = await client.callTool({ name: 'asset_library', arguments: args });
  assert.equal(result.structuredContent.error.code, 'invalid_response');
  assert.equal(result.content.length, 1);
  assert.equal(count, 1, 'one host call, no fallback broad query');
});

test('timeouts and unknown mutations are never retried or followed by workspace/image calls', async t => {
  const calls = [], bridge = { async call(method, args) { calls.push({ method, args }); throw new BridgeError('timeout', 'Fixture outcome unknown; do not retry.'); } };
  const client = await mcp(t, bridge);
  for (const args of [
    { action: 'list', category: 'presets' },
    { action: 'mutate', command: 'update', items: [{ kind: 'combo', id: 'combo:fixture', expectedRevision: 7 }], patch: { notes: 'fixture' } },
  ]) {
    const result = await client.callTool({ name: 'asset_library', arguments: args });
    assert.equal(result.structuredContent.error.code, 'timeout');
  }
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.method === 'asset_library'));
});

test('public request declarations keep category list-only and normalize to the unchanged host type', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const file = join(root, 'tests/__asset-category-typecheck.mts');
  const source = `
import type { AssetLibraryRequest } from '../contracts/generated/library-contracts.mjs';
import { normalizeAssetLibraryRequest, type AssetLibraryPublicRequest, type AssetCategory } from '../src/asset-library-categories.mjs';
const list: AssetLibraryPublicRequest = { action:'list', category:'presets', kinds:['combo'] };
const host: AssetLibraryRequest = normalizeAssetLibraryRequest(list);
const old: AssetLibraryPublicRequest = { action:'mutate', command:'archive', items:[{kind:'combo',id:'fixture',expectedRevision:1}] };
const category: AssetCategory = 'imports';
// @ts-expect-error all is cross-category search, not a category
const invalidCategory: AssetLibraryPublicRequest = { action:'list', category:'all' };
// @ts-expect-error category never replaces kind/id on reads
const invalidRead: AssetLibraryPublicRequest = { action:'read', category:'presets', kind:'combo', id:'fixture' };
// @ts-expect-error host protocol is unchanged
const invalidHost: AssetLibraryRequest = { action:'list', category:'presets' };
`;
  const options = { strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: [] };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host), exists = host.fileExists.bind(host);
  // TypeScript hands the host forward-slash paths on every platform (D:/a/... on Windows): compare resolved paths.
  const virtual = name => resolve(name) === file;
  host.readFile = name => virtual(name) ? source : read(name);
  host.fileExists = name => virtual(name) || exists(name);
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([file], options, host));
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: value => value, getCurrentDirectory: () => root, getNewLine: () => '\n' }));
});

test('summary read derives category for exact typed identities and strips explicitly undefined category before host', async t => {
  const bridge = fixtureBridge(), client = await mcp(t, bridge);
  for (const row of rows) {
    const args = { action: 'read', kind: row.kind, id: row.id, revision: row.revision, detail: 'summary' };
    const result = await client.callTool({ name: 'asset_library', arguments: args });
    const structured = result.structuredContent;
    assert.equal(structured.item.category, categoryFor(row.kind));
    assert.equal(structured.item.revision, row.revision);
    assert.equal(structured.item.image.inspected, false);
  }
  assert.deepEqual(assetLibraryHostRequest(normalizeAssetLibraryRequest({ action: 'list', category: undefined })), { action: 'list', limit: 10 });
});
