import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BridgeError, createBridgeClient, createNovelAiMcpServer, TOOL_DEFINITIONS } from '../src/mcp.mjs';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9AAAAABJRU5ErkJggg==';
const picture = { mimeType: 'image/png', data: png };
const snapshot = () => ({ workspaceId: 'window-1', revision: 4, state: { params: { prompt: 'SFW garden illustration', width: 1024 }, charCaptions: [{ prompt: 'adult gardener' }, { prompt: 'adult visitor' }] }, assets: [{ id: 'current', role: 'currentImage', mimeType: 'image/png' }, { id: 'reference-1', role: 'preciseReferences', mimeType: 'image/png' }, { id: 'mask', role: 'inpaintMask', mimeType: 'image/png' }], capabilities: { generation: false }, undoAvailable: false });

async function mcp(t, handler) {
  const calls = [];
  const server = createNovelAiMcpServer({ bridgeClient: { call: async (method, args, signal) => { calls.push({ method, args }); return handler(method, args, signal); } } });
  const client = new Client({ name: 'novelai-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, calls };
}

async function localBridge(t, handler) {
  const runtimeDir = await mkdtemp(resolve(tmpdir(), 'novelai-mcp-test-'));
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const connection = { schemaVersion: 1, url: `http://127.0.0.1:${server.address().port}`, token: 'test-bridge-credential-do-not-expose', pid: process.pid };
  await writeFile(resolve(runtimeDir, 'bridge.json'), JSON.stringify(connection), { mode: 0o600 });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(runtimeDir, { recursive: true, force: true }); });
  return { runtimeDir, connection };
}

test('MCP initializes and advertises one server: core tools first, then canvas tools', async t => {
  const { client } = await mcp(t, () => ({}));
  assert.deepEqual(client.getServerVersion(), { name: 'novelai', version: '0.1.3' });
  const instructions = client.getInstructions() ?? '';
  assert.match(instructions, /Adult fictional NSFW/);
  assert.match(instructions, /target, harass or harm real people/);
  for (const phrase of ['MCP for NovelAI tools in two layers', 'settles an unknown outcome itself', 'never a new key while an outcome is still settling', 'Credentials are local']) assert.ok(instructions.includes(phrase), phrase);
  assert.doesNotMatch(instructions, /novelai-business/, 'one server; the removed alias is not advertised');
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['material_library', 'tag_details', 'material_studies', 'asset_library', 'prepare_recipe', 'enqueue_recipes', 'list_queue', 'read_queue', 'get_queue_result',
    'read_workspace']);
  assert.deepEqual(tools, TOOL_DEFINITIONS);
  // Every schema is a flat closed object: no top-level union (a client keeping only properties must still see every parameter).
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    for (const key of ['anyOf', 'oneOf', 'allOf', 'if']) assert.equal(tool.inputSchema[key], undefined, `${tool.name} has top-level ${key}`);
  }
  assert.equal(tools.find(tool => tool.name === 'read_workspace').annotations.readOnlyHint, true);
  // Only enqueue_recipes generates (open world); no canvas tool does.
  assert.deepEqual(tools.filter(tool => tool.annotations.openWorldHint && !['material_library', 'tag_details'].includes(tool.name)).map(tool => tool.name), ['enqueue_recipes']);
  for (const tool of tools.filter(tool => tool.name !== 'prepare_recipe')) assert.doesNotMatch(tool.description, /submit_generation|submit_batch|list_batches|read_batch|control_generation|generation_jobs?|get_generation_result/, tool.name);
  assert.match(instructions, /prepare_recipe \{canvas:/);
  assert.doesNotMatch(instructions, /submit_generation|submit_batch|generation jobs and batches/);
});

test('unified material MCP route uses shared cross-kind schemas and excludes image paths and migration', async t => {
  const {client,calls}=await mcp(t,(_method,args)=>args.action==='read'?{item:{kind:args.kind,id:args.id,revision:args.revision??1,payload:{}}}:{items:[],total:0,revision:0,request:args});
  const requests=[{action:'list',kinds:['history','style_preset'],query:'watercolor'},{action:'read',kind:'reference_preset',id:'reference-1'},{action:'collections'},{action:'create-collection',name:'雨窗书店'},{action:'mutate',command:'archive',items:[{kind:'note',id:'note-1',expectedRevision:1}]}];
  for(const args of requests) assert.equal((await client.callTool({name:'asset_library',arguments:args})).isError,undefined);
  assert.deepEqual(calls,requests.map(args=>({method:'asset_library',args:args.action==='list'?{...args,limit:10}:args})));
  for(const args of [{action:'save'},{action:'migrate-renderer',collections:{}},{action:'create-collection',name:'SFW',namespace:'style'},{action:'delete-collection',collectionId:'user:fixture'},{action:'mutate',command:'update',items:[{kind:'history',id:'image-1',expectedRevision:1}],patch:{filePath:'/outside.png'}}]) assert.equal((await client.callTool({name:'asset_library',arguments:args})).structuredContent.error.code,'invalid_arguments');
  const {tools}=await client.listTools();
  assert.match(tools.find(tool=>tool.name==='asset_library').description,/history: groupId only/);
  assert.equal(calls.length,requests.length);
});

test('the 34 removed, merged or retired tool names (11 removed, 7 merged, 8 canvas generation tools, 5 canvas self-check and draft tools and 3 more retired) are unknown_tool and never reach the host', async t => {
  const { client, calls } = await mcp(t, () => { throw new Error('No host call expected'); });
  const removed = ['search_gallery', 'read_gallery', 'select_gallery_item', 'get_gallery_image', 'get_gallery_sheet', 'draft_gallery_import', 'save_project', 'list_projects', 'restore_project', 'draft_generation_source', 'read_recipe',
    'pause_queue', 'resume_queue', 'cancel_queue', 'pause_batch', 'resume_batch', 'cancel_batch', 'cancel_generation_job',
    // Retired on 2026-11-02: images from the canvas are prepare_recipe {canvas} + enqueue_recipes.
    'submit_generation', 'submit_batch', 'list_generation_jobs', 'read_generation_job', 'get_generation_result', 'list_batches', 'read_batch', 'control_generation',
    // Retired on 2026-11-12: the self-check is prepare_recipe {canvas, preview:true}, images are read_workspace {assetIds}, the canvas is edited in the app.
    'read_prompt_review', 'get_asset', 'draft_edit', 'apply_edit', 'undo_edit',
    // Retired on 2026-11-13: enqueue_recipes with the same key answers what a key holds, batches are paused or cancelled in the app, read_workspace finds the one workspace itself.
    'lookup_enqueue', 'control_queue', 'list_workspaces'];
  assert.equal(removed.length, 34);
  const listed = new Set((await client.listTools()).tools.map(tool => tool.name));
  for (const name of removed) {
    assert.ok(!listed.has(name), name);
    for (const args of [{}, { workspaceId: 'window-1', batchId: '00000000-0000-4000-8000-000000000000', jobId: 'job-1', expectedRevision: 1 }, { workspaceId: 'window-1', expectedRevision: 1, requestKey: 'k', mode: 't2i', count: 2, intervalSeconds: 0, seedMode: 'fixed', action: 'cancel' }]) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.structuredContent.error.code, 'unknown_tool', name);
    }
  }
  assert.deepEqual(calls, []);
});

test('the former canvas search_tags is an unknown tool like any other name, and nothing reaches the host', async t => {
  const { client, calls } = await mcp(t, () => { throw new Error('No host call expected'); });
  assert.ok(!(await client.listTools()).tools.some(tool => tool.name === 'search_tags'));
  for (const args of [{ workspaceId: 'window-1', query: '握手' }, { workspaceId: 'window-1', query: 'garden', limit: 51 }, {}]) {
    const result = await client.callTool({ name: 'search_tags', arguments: args });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'unknown_tool');
    assert.doesNotMatch(result.structuredContent.error.message, /material_library|search_tags/);
    assert.deepEqual(JSON.parse(result.content[0].text), { error: result.structuredContent.error });
  }
  assert.equal(calls.length, 0);
});

test('read_workspace returns full state and manifest with native image attached at same revision', async t => {
  const { client, calls } = await mcp(t, method => method === 'read_workspace' ? snapshot() : picture);
  const result = await client.callTool({ name: 'read_workspace', arguments: { workspaceId: 'window-1' } });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.state.charCaptions.length, 2);
  assert.equal(result.structuredContent.assets.length, 3);
  assert.deepEqual(result.structuredContent.imageAttachments.includedAssetIds, ['current']);
  assert.deepEqual(result.content[1], { type: 'image', ...picture });
  assert.deepEqual(calls, [{ method: 'read_workspace', args: { workspaceId: 'window-1' } }, { method: 'get_asset', args: { workspaceId: 'window-1', expectedRevision: 4, assetId: 'current' } }]);
  assert.ok(!result.content[0].text.includes(png));
});

test('read_workspace is compact by default: image entries lose their own recipe, inpaint text shows only on the inpaint tab, and omitted names every path; detail:"full" returns the snapshot as it is', async t => {
  const prompts = { stylePrompt: 'flat color', positivePrompt: 'SFW garden illustration', negativePrompt: 'blurry' };
  const captions = [{ prompt: 'adult gardener', negativePrompt: '', useCoords: false, x: 0.5, y: 0.5 }];
  const image = extra => ({ id: 'history-1', actualSeed: 7, width: 832, height: 1216, params: { ...prompts, steps: 28 }, characterSnapshot: { version: 1, captions }, characterPrompts: ['adult gardener'], assetId: 'current', ...extra });
  const state = extra => ({ params: { ...prompts, steps: 28 }, charCaptions: captions, activeTab: 'generate', currentImage: image(), workbenchImage: { width: 64, height: 64, assetId: 'workbenchImage' },
    inpaintPositivePrompt: 'silver brooch', inpaintRecipe: { positivePrompt: 'silver brooch' }, inpaintStrength: 0.7, ...extra });
  let current = state();
  const { client } = await mcp(t, method => method === 'read_workspace' ? { ...snapshot(), state: current } : picture);
  const read = async (extra = {}) => (await client.callTool({ name: 'read_workspace', arguments: { workspaceId: 'window-1', includeImages: false, ...extra } })).structuredContent;

  const compact = await read();
  assert.equal(compact.detail, 'compact');
  assert.deepEqual(compact.state.currentImage, { id: 'history-1', actualSeed: 7, width: 832, height: 1216, assetId: 'current', promptsMatchCanvas: true });
  assert.deepEqual(compact.state.workbenchImage, current.workbenchImage, 'an entry without a recipe is left as it is');
  assert.deepEqual(compact.omitted, ['state.currentImage.params', 'state.currentImage.characterSnapshot', 'state.currentImage.characterPrompts', 'state.inpaintPositivePrompt', 'state.inpaintRecipe']);
  assert.deepEqual([compact.state.inpaintPositivePrompt, compact.state.inpaintRecipe, compact.state.inpaintStrength], [undefined, undefined, 0.7]);
  assert.deepEqual(compact.state.params, current.params, 'the canvas prompts are stated once');
  assert.deepEqual(compact.state.charCaptions, captions);
  assert.equal(JSON.stringify(compact).split('SFW garden illustration').length - 1, 1);

  const full = await read({ detail: 'full' });
  assert.equal(full.detail, 'full'); assert.equal(full.omitted, undefined);
  assert.deepEqual(full.state, current);

  // The inpaint tab shows its text; an image made from other prompts or other characters says so.
  current = state({ activeTab: 'inpaint', currentImage: image({ params: { ...prompts, positivePrompt: 'a lighthouse' } }) });
  const inpaint = await read();
  assert.deepEqual([inpaint.state.inpaintPositivePrompt, inpaint.state.inpaintRecipe], ['silver brooch', { positivePrompt: 'silver brooch' }]);
  assert.equal(inpaint.state.currentImage.promptsMatchCanvas, false);
  assert.ok(!inpaint.omitted.some(path => path.startsWith('state.inpaint')));
  current = state({ charCaptions: [], inpaintPositivePrompt: '', inpaintRecipe: null });
  const others = await read();
  assert.equal(others.state.currentImage.promptsMatchCanvas, false, 'the image has a character the canvas no longer has');
  assert.deepEqual(others.omitted, ['state.currentImage.params', 'state.currentImage.characterSnapshot', 'state.currentImage.characterPrompts'], 'empty inpaint text is not reported as omitted');
  assert.equal(others.state.inpaintRecipe, null);
});

test('read supports explicit references and no-images without truncating text assets', async t => {
  const { client, calls } = await mcp(t, method => method === 'read_workspace' ? snapshot() : picture);
  const references = await client.callTool({ name: 'read_workspace', arguments: { workspaceId: 'window-1', assetIds: ['reference-1', 'mask'] } });
  assert.equal(references.content.filter(item => item.type === 'image').length, 2);
  assert.deepEqual(references.structuredContent.imageAttachments.includedAssetIds, ['reference-1', 'mask']);
  calls.length = 0;
  const text = await client.callTool({ name: 'read_workspace', arguments: { workspaceId: 'window-1', includeImages: false } });
  assert.equal(text.content.length, 1);
  assert.equal(text.structuredContent.assets.length, 3);
  assert.equal(calls.length, 1);
});

test('native image follows the visible workbench rather than a previous generated result', async t => {
  const { client } = await mcp(t, method => method === 'read_workspace' ? { ...snapshot(), activeImageAssetId: 'workbench', assets: [...snapshot().assets, { id: 'workbench', role: 'workbenchImage', mimeType: 'image/png' }] } : picture);
  const result = await client.callTool({ name: 'read_workspace', arguments: { workspaceId: 'window-1' } });
  assert.deepEqual(result.structuredContent.imageAttachments.includedAssetIds, ['workbench']);
  assert.equal(result.content[1].type, 'image');
});

test('a manually loaded image is attached even before the first generated result', async t => {
  const { client } = await mcp(t, method => method === 'read_workspace' ? { ...snapshot(), assets: [{ id: 'source', role: 'workbenchImage', mimeType: 'image/png' }] } : picture);
  const result = await client.callTool({ name: 'read_workspace', arguments: { workspaceId: 'window-1' } });
  assert.deepEqual(result.structuredContent.imageAttachments.includedAssetIds, ['source']);
  assert.equal(result.content[1].type, 'image');
});

test('revision change while fetching an image fails the whole read without mixing state and images', async t => {
  const { client, calls } = await mcp(t, method => {
    if (method === 'read_workspace') return snapshot();
    throw new BridgeError('conflict', 'Manual edit changed revision.', { expectedRevision: 4, actualRevision: 5 });
  });
  const result = await client.callTool({ name: 'read_workspace', arguments: { workspaceId: 'window-1' } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'conflict');
  assert.deepEqual(result.structuredContent.error.details, { expectedRevision: 4, actualRevision: 5 });
  assert.equal(result.content.filter(item => item.type === 'image').length, 0);
  assert.equal(calls.length, 2);
});

test('input validation rejects stale-style names, unknown fields and invalid values before HTTP', async t => {
  const { client, calls } = await mcp(t, () => ({}));
  for (const [name, args] of [
    ['run_generation', {}],
    ['read_workspace', { workspace_id: 'window-1' }],
    ['read_workspace', { workspaceId: 'window-1', detail: 'everything' }],
    ['read_workspace', { workspaceId: 'window-1', expectedRevision: 4 }],
    ['read_workspace', { workspaceId: 'window-1', includeImages: false, assetIds: ['current'] }],
    ['read_workspace', { workspaceId: 'window-1', assetIds: Array.from({ length: 6 }, (_, i) => `image-${i}`) }],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
  }
  assert.equal(calls.length, 0);
});

test('MCP result strips credentials from unexpected nested payloads', async t => {
  const { client } = await mcp(t, () => ({ workspaces: [{ workspaceId: 'window-1', token: 'secret', nested: { apiKey: 'secret', authorization: 'secret' } }], settings: { harmless: false, token: 'secret' } }));
  const result = await client.callTool({ name: 'asset_library', arguments: { action: 'collections' } });
  assert.equal(result.isError, undefined); assert.equal(result.structuredContent.workspaces[0].workspaceId, 'window-1');
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.equal(result.structuredContent.settings, undefined);
});

test('HTTP client authenticates using runtime discovery and rereads restarted connection without retry', async t => {
  let count = 0;
  let body;
  let authorization;
  const { runtimeDir, connection } = await localBridge(t, async (request, response) => {
    count++; authorization = request.headers.authorization;
    body = JSON.parse(await Array.fromAsync(request).then(chunks => Buffer.concat(chunks).toString()));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, result: { workspaceId: 'window-1', token: 'should-not-return', note: connection.token } }));
  });
  const bridge = createBridgeClient({ runtimeDir });
  const result = await bridge.call('read_workspace', { workspaceId: 'window-1' });
  assert.equal(authorization, `Bearer ${connection.token}`);
  assert.deepEqual(body, { method: 'read_workspace', args: { workspaceId: 'window-1' } });
  assert.equal(result.token, undefined);
  assert.equal(result.note, '[redacted]');
  await writeFile(resolve(runtimeDir, 'bridge.json'), JSON.stringify({ ...connection, token: 'new-test-token' }));
  await bridge.call('list_workspaces', {});
  assert.equal(authorization, 'Bearer new-test-token');
  assert.equal(count, 2);
});

test('HTTP conflict preserves details and does not retry mutations or leak token in errors', async t => {
  let count = 0;
  const { runtimeDir, connection } = await localBridge(t, (request, response) => {
    count++; response.writeHead(409, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: { code: 'conflict', message: `Revision conflict ${connection.token}`, details: { actualRevision: 7, apiKey: 'secret' } } }));
  });
  const bridge = createBridgeClient({ runtimeDir });
  await assert.rejects(bridge.call('apply_edit', { workspaceId: 'window-1', expectedRevision: 4, draftId: 'draft' }), error => {
    assert.equal(error.code, 'conflict'); assert.equal(error.details.actualRevision, 7); assert.equal(error.details.apiKey, undefined); assert.ok(!error.message.includes(connection.token)); return true;
  });
  assert.equal(count, 1);
});

test('HTTP client rejects remote connection and redirects before credentials can leave loopback endpoint', async t => {
  let redirects = 0;
  const { runtimeDir, connection } = await localBridge(t, (request, response) => { redirects++; response.writeHead(302, { location: 'https://example.com/should-not-follow' }); response.end(); });
  const bridge = createBridgeClient({ runtimeDir });
  await assert.rejects(bridge.call('list_workspaces', {}), error => error.code === 'unavailable');
  assert.equal(redirects, 1);
  await writeFile(resolve(runtimeDir, 'bridge.json'), JSON.stringify({ ...connection, url: 'https://example.com/' }));
  await assert.rejects(bridge.call('list_workspaces', {}), error => error.code === 'invalid_connection');
  assert.equal(redirects, 1);
});

test('HTTP timeout has unknown-outcome guidance and never repeats mutation', async t => {
  let count = 0;
  const { runtimeDir } = await localBridge(t, () => { count++; });
  const bridge = createBridgeClient({ runtimeDir, timeoutMs: 30 });
  await assert.rejects(bridge.call('apply_edit', { workspaceId: 'window-1', expectedRevision: 4, draftId: 'draft' }), error => error.code === 'timeout' && error.message.includes('unknown'));
  assert.equal(count, 1);
});
