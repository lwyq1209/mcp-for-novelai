// Recently Deleted (step 3c) through the MCP asset_library tool: exact forwarding, the default page, the derived
// category on entries and receipts, and refusal of incomplete host replies. The host side is tested in the client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createNovelAiMcpServer } from '../src/mcp.mjs';
import { assetLibraryHostRequest, assetLibraryResponse } from '../src/asset-library-response.mjs';

const TRASH_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
async function mcp(t, reply) {
  const calls = [], server = createNovelAiMcpServer({ bridgeClient: { async call(method, args) { calls.push({ method, args }); return reply(args); } } });
  const client = new Client({ name: 'asset-trash-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return { calls, call: args => client.callTool({ name: 'asset_library', arguments: args }) };
}

test('delete, recently-deleted, restore and purge reach the host exactly once with their arguments', async t => {
  const { calls, call } = await mcp(t, args => args.action === 'recently-deleted' ? { entries: [], total: 0, offset: 0, limit: args.limit, hasMore: false, nextOffset: null, retentionDays: 30, revision: 4 }
    : args.action === 'mutate' ? { preview: !!args.preview, deleted: [], revision: 4 } : { restored: [], purged: [], revision: 4 });
  const requests = [
    { action: 'mutate', command: 'delete', items: [{ kind: 'history', id: 'h1', expectedRevision: 3 }] },
    { action: 'mutate', command: 'delete', items: [{ kind: 'study', id: 's1', expectedRevision: 1 }], preview: true },
    { action: 'mutate', command: 'delete', collectionId: 'user:c1' },
    { action: 'mutate', command: 'delete-archived', kinds: ['history'] },
    { action: 'recently-deleted', query: 'cup' },
    { action: 'restore', trashIds: [TRASH_ID] },
    { action: 'purge', trashIds: [TRASH_ID] },
  ];
  for (const args of requests) assert.equal((await call(args)).isError, undefined, JSON.stringify(args));
  assert.deepEqual(calls.map(value => value.method), requests.map(() => 'asset_library'));
  assert.deepEqual(calls.map(value => value.args), requests.map(args => args.action === 'recently-deleted' ? { ...args, limit: 10 } : args));
  // Emptying all of Recently Deleted is not offered to agents: refused before the host, like any unknown field.
  const before = calls.length;
  for (const args of [{ action: 'purge', all: true }, { action: 'purge', all: true, trashIds: [TRASH_ID] }]) assert.equal((await call(args)).structuredContent.error.code, 'invalid_arguments');
  assert.equal(calls.length, before);
});

test('entries and receipts carry the category derived from kind; incomplete replies are refused', () => {
  assert.deepEqual(assetLibraryHostRequest({ action: 'recently-deleted' }), { action: 'recently-deleted', limit: 10 });
  assert.deepEqual(assetLibraryHostRequest({ action: 'recently-deleted', limit: 3 }), { action: 'recently-deleted', limit: 3 });
  const page = assetLibraryResponse({ action: 'recently-deleted' }, { entries: [{ trashId: TRASH_ID, kind: 'study', id: 's1' }, { trashId: TRASH_ID, kind: 'collection', collectionId: 'user:c1' }], total: 2, revision: 7 });
  assert.deepEqual(page.entries, [{ category: 'imports', trashId: TRASH_ID, kind: 'study', id: 's1' }, { trashId: TRASH_ID, kind: 'collection', collectionId: 'user:c1' }]);
  const receipt = assetLibraryResponse({ action: 'mutate', command: 'delete', items: [] }, { preview: false, deleted: [{ kind: 'combo', id: 'c' }], revision: 8, note: 'n' });
  assert.deepEqual(receipt.deleted, [{ category: 'presets', kind: 'combo', id: 'c' }]);
  for (const [request, reply] of [[{ action: 'recently-deleted' }, { entries: [], revision: 1 }], [{ action: 'recently-deleted' }, null], [{ action: 'mutate', command: 'delete-archived' }, { revision: 1 }]])
    assert.throws(() => assetLibraryResponse(request, reply), { code: 'invalid_response' });
});
