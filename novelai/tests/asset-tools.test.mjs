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
