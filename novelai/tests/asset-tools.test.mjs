import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createNovelAiMcpServer } from '../src/mcp.mjs';

async function mcp(t,bridge){
  const server=createNovelAiMcpServer({ wholeResults: true, bridgeClient:bridge}),client=new Client({name:'asset-tools-test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
  t.after(async()=>{await client.close();await server.close();});
  const call=args=>client.callTool({name:'asset_library',arguments:args});
  const ok=async args=>{const result=await call(args);assert.equal(result.isError,undefined,JSON.stringify(result.structuredContent));return result.structuredContent;};
  const code=async args=>{const result=await call(args);assert.equal(result.isError,true,JSON.stringify(args));return result.structuredContent.error.code;};
  return {client,call,ok,code};
}

test('MCP asset_library forwards typed cross-kind queries and revisioned mutations without a workspace',async t=>{
  const calls=[],bridge={async call(method,args){calls.push({method,args});return args.action==='read'?{item:{kind:args.kind,id:args.id,revision:args.revision??1,payload:{}}}:{items:[],total:0,revision:0};}};
  const inputs=[{action:'list',query:'水彩',kinds:['history','artist_favorite','reference_preset'],limit:20},{action:'read',kind:'artist_favorite',id:'random:recipe-1',revision:2},{action:'collections'},{action:'create-collection',name:'雨窗书店'},{action:'mutate',command:'archive',items:[{kind:'note',id:'note-1',expectedRevision:3}],patch:{archived:true}},{action:'mutate',command:'update',items:[{kind:'prompt_chunk',id:'chunk-1',expectedRevision:1}],patch:{content:'\nsoft light,\n'}}];
  const {ok,code}=await mcp(t,bridge);
  for(const input of inputs)await ok(input);
  assert.deepEqual(calls,inputs.map(args=>({method:'asset_library',args})));
  for(const args of [{action:'save',kind:'history',payload:{filePath:'/outside'}},{action:'migrate-renderer',collections:{}},{action:'mutate',command:'update',items:[{kind:'history',id:'image-1',expectedRevision:1}],patch:{filePath:'/outside'}},{action:'mutate',command:'archive',items:[{kind:'note',id:'note-1',expectedRevision:'3'}]}])assert.equal(await code(args),'invalid_arguments');
  assert.equal(calls.length,inputs.length);
});

test('public collection creation accepts only a name and leaves private desktop operations unexposed',async t=>{
  const calls=[],bridge={async call(method,args){calls.push({method,args});return {};}};
  const {code}=await mcp(t,bridge);
  for(const args of [
    {action:'create-collection',name:''},{action:'create-collection',name:'  \n '},{action:'create-collection',name:7},
    {action:'create-collection',name:'SFW',namespace:'user'},{action:'create-collection',name:'SFW',namespace:'style'},
    {action:'create-collection',name:'SFW',id:'injected'},{action:'delete-collection',collectionId:'user:fixture'},
    {action:'mutate',command:'update',items:[{kind:'note',id:'note-1',expectedRevision:1}],patch:{observations:'invented field'}},
  ])assert.equal(await code(args),'invalid_arguments');
  assert.deepEqual(calls,[]);
});

test('MCP advertises the generated asset schema and returns bounded summaries',async t=>{
  const bridge={call:async(method,args)=>args.action==='list'?(args.query==='oversize'?{items:[{kind:'history',id:'i'.repeat(20000),revision:1}],total:1,revision:3}:{items:[],total:0,revision:3}):({method,args})};
  const {client,call,ok}=await mcp(t,bridge);
  const tool=(await client.listTools()).tools.find(item=>item.name==='asset_library');
  assert.equal(tool.inputSchema.type,'object');assert.equal(tool.inputSchema.additionalProperties,false);
  assert.match(tool.description,/create-collection/);assert.match(tool.description,/history: groupId only/);assert.match(tool.description,/Note prose belongs in notes/);
  const result=await call({action:'list',kinds:['prompt_chunk']});
  assert.equal(result.structuredContent.detail,'summary');assert.equal(result.structuredContent.limit,10);assert.deepEqual(result.structuredContent.items,[]);assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);
  const oversized=await call({action:'list',query:'oversize'});
  assert.equal(oversized.isError,true);assert.equal(oversized.structuredContent.error.code,'asset_summary_too_large');assert.ok(Buffer.byteLength(oversized.content[0].text)<1024);
  assert.deepEqual(await ok({action:'create-collection',name:'雨窗书店'}),{method:'asset_library',args:{action:'create-collection',name:'雨窗书店'}});
});

// Issue #1: style presets written by an agent.
test('asset_library writes style presets: create, the structured update fields and the sample-image commands are checked here and forwarded as they are', async t => {
  const calls = [];
  const stored = { kind: 'style_preset', id: 'preset-1', revision: 1, name: 'Ink', archived: false, createdAt: 'now', updatedAt: 'now', payload: { id: 'preset-1', name: 'Ink', prompt: 'ink', group: '', createdAt: 'now' } };
  const bridge = { async call(method, args) { calls.push({ method, args }); return args.action === 'create' ? { item: stored, revision: 5 } : { items: [{ ...stored, revision: 2 }], revision: 6, ...(args.command === 'update' ? {} : { previews: [{ previewId: 'sample-1', name: 'bench.png', label: 'one character' }] }) }; } };
  const artists = [{ name: 'artist:someone', weight: 1.2, enabled: true }, { name: 'artist:other', weight: -1.5, enabled: false }];
  const params = { model: 'nai-diffusion-5-full', steps: 28, cfgScale: 5, cfgRescale: 0, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', ucPreset: 0, qualityPreset: 'standard' };
  const items = [{ kind: 'style_preset', id: 'preset-1', expectedRevision: 1 }];
  const inputs = [
    { action: 'create', kind: 'style_preset', patch: { name: 'Ink', group: 'Line', prompt: 'ink lineart', artists, negativePrompt: '3d', textNegativePrompt: 'text, speech bubble', params, notes: 'One character: Base only.' } },
    { action: 'create', kind: 'style_preset', patch: { name: 'Bare' } },
    { action: 'mutate', command: 'update', items, patch: { artists: [], params: { steps: 23 }, negativePrompt: '', textNegativePrompt: 'text', notes: 'n' } },
    { action: 'mutate', command: 'add-preview', items, image: { kind: 'history', id: 'h1', revision: 1, assetId: 'path:abc' }, label: 'one character' },
    { action: 'mutate', command: 'add-preview', items, image: { kind: 'study', id: '00000000-0000-4000-8000-000000000001', revision: 2 } },
    { action: 'mutate', command: 'label-preview', items, previewId: 'sample-1', label: '' },
    { action: 'mutate', command: 'remove-preview', items, previewId: 'sample-1' },
  ];
  // The agent's server (compact results): the new identity, the new revision, the samples by previewId.
  const server = createNovelAiMcpServer({ bridgeClient: bridge }), client = new Client({ name: 'asset-style-preset-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const call = args => client.callTool({ name: 'asset_library', arguments: args });
  const results = [];
  for (const input of inputs) { const result = await call(input); assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent)); results.push(result.structuredContent); }
  assert.deepEqual(calls, inputs.map(args => ({ method: 'asset_library', args })));
  assert.deepEqual(results[0], { item: { kind: 'style_preset', id: 'preset-1', revision: 1, name: 'Ink' }, revision: 5 });
  assert.deepEqual(results[2], { items: [{ kind: 'style_preset', id: 'preset-1', revision: 2 }], revision: 6 });
  assert.deepEqual(results[3], { items: [{ kind: 'style_preset', id: 'preset-1', revision: 2 }], revision: 6, previews: [{ previewId: 'sample-1', name: 'bench.png', label: 'one character' }] });
  // Refused here, before the host: a field no style preset has, a value prepare_recipe would not take, another kind, a malformed image or selection.
  const sent = calls.length;
  for (const args of [
    { action: 'create', kind: 'style_preset', patch: {} }, { action: 'create', kind: 'style_preset', patch: { name: 'x', suffixPrompt: 'y' } }, { action: 'create', kind: 'style_preset', patch: { name: 'x', previewImages: [] } },
    { action: 'create', kind: 'style_preset' }, { action: 'create', kind: 'positive_preset', patch: { name: 'x' } }, { action: 'create', kind: 'style_preset', patch: { name: 'x' }, id: 'chosen' },
    { action: 'create', kind: 'style_preset', patch: { name: 'x', artists: [{ name: 'artist:a', weight: 1 }] } }, { action: 'create', kind: 'style_preset', patch: { name: 'x', artists: [{ name: 'artist:a', weight: 1, enabled: true, raw: 'x' }] } },
    { action: 'create', kind: 'style_preset', patch: { name: 'x', params: { steps: 51 } } }, { action: 'create', kind: 'style_preset', patch: { name: 'x', params: { noiseSchedule: 'linear' } } }, { action: 'create', kind: 'style_preset', patch: { name: 'x', params: { seed: 1 } } },
    { action: 'mutate', command: 'update', items, patch: { params: { model: 'no-such-model' } } }, { action: 'mutate', command: 'update', items, patch: { artists: 'artist:a' } },
    { action: 'mutate', command: 'add-preview', items }, { action: 'mutate', command: 'add-preview', items, image: { kind: 'style_preset', id: 'x', revision: 1 } }, { action: 'mutate', command: 'add-preview', items, image: { kind: 'history', id: 'h1', revision: 1, assetId: 'a', filePath: '/outside.png' } },
    { action: 'mutate', command: 'add-preview', items, image: { kind: 'history', id: 'h1', revision: 1, assetId: 'a' }, label: 'x'.repeat(61) }, { action: 'mutate', command: 'add-preview', items: [...items, ...items], image: { kind: 'history', id: 'h1', revision: 1, assetId: 'a' } },
    { action: 'mutate', command: 'add-preview', items: [{ kind: 'positive_preset', id: 'p', expectedRevision: 1 }], image: { kind: 'history', id: 'h1', revision: 1, assetId: 'a' } },
    { action: 'mutate', command: 'label-preview', items, previewId: 'sample-1' }, { action: 'mutate', command: 'remove-preview', items }, { action: 'mutate', command: 'remove-preview', items, previewId: 'sample-1', label: 'x' },
  ]) { const result = await call(args); assert.equal(result.isError, true, JSON.stringify(args)); assert.equal(result.structuredContent.error.code, 'invalid_arguments', JSON.stringify(args)); }
  assert.equal(calls.length, sent, 'nothing invalid reached the host');
  const tool = (await client.listTools()).tools.find(item => item.name === 'asset_library');
  for (const action of ['create']) assert.ok(tool.inputSchema.properties.action.enum.includes(action));
  for (const command of ['add-preview', 'label-preview', 'remove-preview']) assert.ok(tool.inputSchema.properties.command.enum.includes(command));
  for (const text of [/artists \[\{name,weight,enabled\}\]/, /create \{kind:"style_preset",patch\}/, /add-preview/, /previewId/]) assert.match(tool.description, text);
});

test('asset_library style preset writes on an older client: its contract refuses the request this server validated, which is reported as host_outdated; other refusals pass as they are', async t => {
  let reply;
  const { call } = await mcp(t, { async call() { throw reply; } });
  const { BridgeError } = await import('../src/bridge-client.mjs');
  const items = [{ kind: 'style_preset', id: 'preset-1', expectedRevision: 1 }];
  const writes = [
    { action: 'create', kind: 'style_preset', patch: { name: 'Ink' } }, { action: 'mutate', command: 'update', items, patch: { artists: [] } }, { action: 'mutate', command: 'update', items, patch: { params: { steps: 28 } } },
    { action: 'mutate', command: 'add-preview', items, image: { kind: 'study', id: 's', revision: 1 } }, { action: 'mutate', command: 'label-preview', items, previewId: 'a', label: 'x' }, { action: 'mutate', command: 'remove-preview', items, previewId: 'a' },
  ];
  reply = new BridgeError('invalid_argument', 'Invalid library request: data/action must be equal to constant, data must match a schema in anyOf');
  for (const args of writes) {
    const error = (await call(args)).structuredContent.error;
    assert.equal(error.code, 'host_outdated', JSON.stringify(args));
    assert.match(error.message, /older than this MCP server .* Nothing was changed\.$/);
  }
  // An update of fields every client knows keeps the client's own answer.
  assert.equal((await call({ action: 'mutate', command: 'update', items, patch: { prompt: 'ink' } })).structuredContent.error.code, 'invalid_argument');
  // A current client's own refusals of these writes are not rewritten.
  reply = new BridgeError('invalid_argument', 'This style preset already has 6 sample images, the most it keeps; remove one first (remove-preview).');
  assert.equal((await call(writes[3])).structuredContent.error.code, 'invalid_argument');
  reply = new BridgeError('library_conflict', 'The item changed; read it again before saving.');
  assert.equal((await call(writes[1])).structuredContent.error.code, 'library_conflict');
});
