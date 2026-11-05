import test from 'node:test';
import assert from 'node:assert/strict';
import { createNovelAiMcpServer } from '../src/mcp.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

export const bigItem = (id = 'history-1', kind = 'history') => ({
  kind, id, revision: 7, name: '雨窗😀'.repeat(2000), createdAt: '2026-09-20', updatedAt: '2026-09-20',
  source: { namespace: 'fixture'.repeat(2000), unknown: 'LEAK' },
  matchedTags: Array.from({length: 100}, (_, i) => ({tag: '光😀'.repeat(1000), source: 'character', characterIndex: i})),
  preview: {assetId: 'preview-1', role: 'output', cacheKey: 'abc', status: 'unavailable', filePath: '/LEAK'},
  payload: { params: {positivePrompt: 'PROMPT_SENTINEL'.repeat(4000), negativePrompt: 'NEGATIVE_SENTINEL'.repeat(4000)},
    charCaptions: Array.from({length: 32}, () => ({prompt:'CHAR_SENTINEL'.repeat(4000)})),
    image: {params: {positivePrompt:'IMAGE_SENTINEL'.repeat(4000)}, dataUrl:'data:image/png;base64,LEAK'},
    study: {name: 'study'.repeat(2000), nested: 'STUDY_SENTINEL'.repeat(4000)}, sections: {raw:'LEAK'}, model:'nai-diffusion-5-full', width:1024, height:1024 },
  unknown: 'UNKNOWN_SENTINEL'.repeat(4000),
});
export async function mcpClient(t, bridge) {
  const server = createNovelAiMcpServer({bridgeClient: bridge});
  const client = new Client({name:'summary-test',version:'1'});
  const [a,b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async()=>{await client.close();await server.close();});
  return client;
}
test('MCP bounds actual text plus structured content, with no hidden full payload', async t => {
  const items = Array.from({length:10}, (_,i)=>bigItem(`id-${i}`, ['history','artist_favorite','study'][i%3]));
  const bridge = {call: async()=>({items,total:10,offset:0,limit:10,revision:9})};
  const client = await mcpClient(t,bridge);
  const mcp = await client.callTool({name:'asset_library',arguments:{action:'list'}});
  for(const result of [mcp]) {
    const text = result.content[0].text;
    console.log('list UTF-8 bytes:',Buffer.byteLength(text));
    assert.ok(Buffer.byteLength(text)<=12*1024, `oversize: ${Buffer.byteLength(text)}`);
    assert.deepEqual(JSON.parse(text),result.structuredContent);
    assert.ok(!/NEGATIVE_SENTINEL|CHAR_SENTINEL|STUDY_SENTINEL|UNKNOWN_SENTINEL|LEAK/.test(JSON.stringify(result)));
    assert.ok(!text.includes('IMAGE_SENTINEL'.repeat(20)));
    assert.equal(JSON.parse(text).detail,'summary');
  }
});

test('schema rejects AI limit 21; defaults and all filters survive one host request', async t => {
  const calls=[]; const bridge={call:async(method,args)=>{calls.push(args);return {items:[],total:0,revision:11,offset:args.offset};}};
  const request={action:'list',offset:42,query:'雨窗',kinds:['history'],collectionId:'user:a',historyTags:['blue sky'],historyTagMatch:'any',historyTagSources:['character'],sortBy:'name',sortDirection:'asc',includeArchived:true};
  const client=await mcpClient(t,bridge);
  const mcp=await client.callTool({name:'asset_library',arguments:request});
  const structured=mcp.structuredContent;assert.equal(structured.nextOffset,null);assert.equal(structured.returned,0);assert.equal(structured.hasMore,false);
  assert.deepEqual(calls,[{...request,limit:10}]);
  assert.equal((await client.callTool({name:'asset_library',arguments:{action:'list',limit:21}})).structuredContent.error.code,'invalid_arguments');
  assert.equal(calls.length,1);
});

test('byte-shortened pages concatenate without omissions/duplicates, including multibyte text', async () => {
  const {assetLibraryResponse}=await import('../src/asset-library-response.mjs');
  const rows=Array.from({length:23},(_,i)=>bigItem(`row-${i}`));
  const seen=[]; let offset=0; let pages=0;
  do {
    const request={action:'list',offset,limit:20};
    const page=assetLibraryResponse(request,{items:rows.slice(offset,offset+20),total:rows.length,revision:37,offset},{budgetBytes:4500});
    assert.ok(Buffer.byteLength(JSON.stringify(page))<=4500); assert.ok(page.returned>0);assert.equal(page.revision,37);
    assert.equal(page.returned,page.items.length);seen.push(...page.items.map(item=>item.id));
    assert.equal(page.hasMore,seen.length<rows.length);
    if(page.hasMore)assert.equal(page.nextOffset,offset+page.returned);
    offset=page.nextOffset; pages++;
  } while(offset!==null && pages<30);
  assert.deepEqual(seen,rows.map(row=>row.id));assert.ok(pages>2);
  for(const offset of [23,100]) {
    const page=assetLibraryResponse({action:'list',offset},{items:[],total:23,revision:37,offset});
    assert.equal(page.nextOffset,null);assert.equal(page.hasMore,false);
  }
});

test('oversized identity/preview is a bounded structured error, never an empty terminal page', async t => {
  for(const item of [bigItem('身'.repeat(20000)),{...bigItem(),preview:{assetId:'图'.repeat(20000)}}]) {
    const bridge={call:async()=>({items:[item],total:1,revision:1})};
    const client=await mcpClient(t,bridge);
    const result=await client.callTool({name:'asset_library',arguments:{action:'list'}});
    assert.equal(result.isError,true);assert.equal(result.structuredContent.error.code,'asset_summary_too_large');
    assert.ok(Buffer.byteLength(result.content[0].text)<1024);
  }
});

test('layered read bounds all side arrays; explicit full preserves exact version and unknown legacy fields', async t => {
  const item=bigItem();item.payload.oldUnknown={authored:'\n legacy exact 😀 \n'};
  const raw={item,assets:Array.from({length:1000},()=>({id:'asset',filePath:'/fixture.png',dataUrl:'LEAK'})),links:Array.from({length:1000},()=>({payload:{text:'LEAK'}})),memberships:Array.from({length:1000},()=>({id:'LEAK'})),tags:Array.from({length:1000},()=>({tag:'标签'.repeat(5000),source:'character',characterIndex:31}))};
  const calls=[];const bridge={call:async(_method,args)=>{calls.push(args);return raw;}};
  const client=await mcpClient(t,bridge);
  for(const detail of [undefined,'summary','full']) {
    const request={action:'read',kind:'history',id:item.id,revision:7,...(detail?{detail}:{})};
    const mcp=await client.callTool({name:'asset_library',arguments:request});
    const structured={details:mcp.structuredContent,content:mcp.content};
    assert.deepEqual(JSON.parse(structured.content[0].text),structured.details);
    if(detail==='full') {
      assert.deepEqual(structured.details.item,item);assert.deepEqual(structured.details.assets,raw.assets);assert.deepEqual(structured.details.links,raw.links);
      assert.equal(structured.details.responseInfo.truncated,false);assert.equal(structured.details.responseInfo.recordBytes,Buffer.byteLength(JSON.stringify(raw)));
    } else {
      assert.ok(Buffer.byteLength(structured.content[0].text)<=12*1024);assert.ok(!structured.content[0].text.includes('LEAK'));
      assert.equal(structured.details.counts.links,1000);assert.equal(structured.details.tags.length,6);assert.equal(structured.details.item.revision,7);
      assert.equal(structured.details.item.image.preview.status,'unavailable');assert.equal(structured.details.item.image.inspected,false);
    }
  }
  assert.ok(calls.every(args=>!Object.hasOwn(args,'detail')));
  for(const kind of ['artist_favorite','study','note','reference_preset']) {
    const record={item:{...item,kind},assets:[],links:[]};const result=(await (await mcpClient(t,{call:async()=>record})).callTool({name:'asset_library',arguments:{action:'read',kind,id:item.id}})).structuredContent;
    assert.deepEqual(result.item,record.item);assert.equal(result.responseInfo.detail,'full');
  }
});
