// 4c1 review rework (approved): the host's asset_library read now carries the current revision's preview, as list does.
// What the model reads: the summary's image.preview {assetId, role, cacheKey, status}, the full record's item.preview;
// an older revision's read has neither. Tool definitions and INSTRUCTIONS are unchanged (mcp-tool-definitions tests).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNovelAiMcpServer } from '../src/mcp.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

async function mcpClient(t, bridge) {
  const server = createNovelAiMcpServer({ wholeResults: true,  bridgeClient: bridge });
  const client = new Client({ name: 'read-preview-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

const hex = c => c.repeat(64);
const preview = { assetId: `path:${hex('a')}`, role: 'original', cacheKey: hex('b'), mimeType: 'image/png', width: 832, height: 1216 };
const history = (revision, withPreview) => ({
  item: { kind: 'history', id: 'h-1', revision, name: 'h-1.png', createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', archived: false,
    payload: { params: { positivePrompt: 'a teacup', model: 'nai-diffusion-5-full', width: 832, height: 1216 }, model: 'nai-diffusion-5-full', width: 832, height: 1216 },
    ...(withPreview ? { preview } : {}) },
  assets: [{ id: preview.assetId, role: 'original', mimeType: 'image/png', width: 832, height: 1216 }], links: [], memberships: [], tags: [{ tag: 'teacup', source: 'positive' }], tagCoverage: 'complete',
});
const read = async (t, reply, args) => (await (await mcpClient(t, { call: async () => reply })).callTool({ name: 'asset_library', arguments: { action: 'read', kind: 'history', id: 'h-1', ...args } }));

test('the read summary projects the current revision\'s preview within the 12 KiB budget', async t => {
  const result = await read(t, history(2, true), {});
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent.item.image, { descriptionPresent: true, inspected: false, preview: { assetId: preview.assetId, role: 'original', cacheKey: preview.cacheKey } });
  assert.ok(Buffer.byteLength(result.content[0].text) <= 12 * 1024);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});

test('the full read keeps the host\'s item.preview (identity and size only); an older revision has none in either detail', async t => {
  const withPreview = await read(t, history(2, true), { detail: 'full' }), without = await read(t, history(2, false), { detail: 'full' });
  assert.deepEqual(withPreview.structuredContent.item.preview, preview);
  // The preview adds this much to the complete record (no other change; full has no summary budget).
  const added = withPreview.structuredContent.responseInfo.recordBytes - without.structuredContent.responseInfo.recordBytes;
  assert.equal(added, Buffer.byteLength(JSON.stringify({ preview })) - 2 + 1);
  const old = history(1, false);
  for (const detail of ['summary', 'full']) {
    const result = await read(t, old, { revision: 1, detail });
    assert.equal(JSON.stringify(result.structuredContent).includes('"preview"'), false, detail);
  }
});
