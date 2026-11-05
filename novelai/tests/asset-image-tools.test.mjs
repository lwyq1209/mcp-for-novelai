import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BridgeError, createNovelAiMcpServer } from '../src/mcp.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9AAAAABJRU5ErkJggg==','base64');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const target={action:'image',kind:'history',id:'manual-1',revision:1,assetId:'path:'+'a'.repeat(64)};
const image=()=>({kind:'history',id:'manual-1',revision:1,assetId:target.assetId,role:'original',variant:'thumbnail',mimeType:'image/png',width:1,height:1,sourceWidth:1,sourceHeight:1,sourceMimeType:'image/png',byteLength:png.length,sourceByteLength:png.length,sha256:sha(png),sourceSha256:sha(png),contentBinding:'read-time-sha256',data:png.toString('base64')});
async function mcp(t,raw){
 const server=createNovelAiMcpServer({bridgeClient:{call:async()=>typeof raw==='function'?raw():raw}}),client=new Client({name:'images-test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 t.after(async()=>{await client.close();await server.close();});return args=>client.callTool({name:'asset_library',arguments:args});
}
test('explicit selected history image yields native MCP block, never generic text bytes',async t=>{
 const call=await mcp(t,{...image(),extra:{data:'DO_NOT_LEAK',filePath:'/private'}});
 const result=await call(target);assert.ok(!result.isError);assert.equal(result.content[1].type,'image');
 assert.equal(result.content[1].data,png.toString('base64'));assert.ok(!result.content[0].text.includes(png.toString('base64')));
 assert.ok(!JSON.stringify(result.structuredContent).includes('DO_NOT_LEAK'));assert.ok(!('data' in result.structuredContent));
});
test('defense: explicit full refuses a host record with different identity/revision',async t=>{
 for(const override of [{id:'other'},{kind:'note'},{revision:2}]) {
  const request={action:'read',kind:'history',id:'manual-1',revision:1,detail:'full'};
  const raw={item:{kind:'history',id:'manual-1',revision:1,payload:{exact:'preserve'},...override}};
  const result=await (await mcp(t,raw))(request);assert.equal(result.structuredContent.error.code,'invalid_response');
 }
});
test('defense: explicit incomplete/error/warning host markers cannot become a successful empty terminal page',async t=>{
 for(const flag of [{partial:true},{complete:false},{error:'huge'.repeat(10000)},{warnings:['huge'.repeat(10000)]},{ok:false},{status:'partial'}]) {
  const raw={items:[],total:0,revision:1,...flag};
  const result=await (await mcp(t,raw))({action:'list'});assert.equal(result.structuredContent.error.code,'asset_response_incomplete');
  assert.ok(result.content[0].text.length<512);assert.ok(!result.content[0].text.includes('huge'));
 }
});

test('image response rejects wrong identity, version, asset, variant, MIME, size, hash, role or binary envelope',async t=>{
 for(const changed of [{id:'other'},{revision:2},{kind:'study'},{assetId:'other'},{variant:'original'},{mimeType:'image/jpeg'},{sourceWidth:32_000_001},{width:385},{byteLength:png.length+1},{sha256:'0'.repeat(64)},{role:'cover'},{data:'bad='},{data:'data:image/png;base64,'+png.toString('base64')},{contentBinding:'verified_by_vision'}]) {
  const raw={...image(),...changed};
  const result=await (await mcp(t,raw))(target);assert.equal(result.isError,true);assert.equal(result.structuredContent.error.code,'invalid_response');
  assert.equal(result.content.length,1);assert.ok(!result.content[0].text.includes(png.toString('base64')));
 }
 const original={...image(),variant:'original',sourceSha256:'0'.repeat(64)};
 assert.equal((await (await mcp(t,original))({...target,variant:'original'})).structuredContent.error.code,'invalid_response');
});

test('image request schema requires exact history selection, one asset and no arbitrary locator or private action',async t=>{
 let calls=0;const call=await mcp(t,()=>{calls++;return image();});
 for(const invalid of [{...target,revision:undefined},{...target,assetId:undefined},{...target,kind:'study'},{...target,filePath:'/outside'},{...target,url:'https://outside'},{...target,data:'bytes'},{...target,assetIds:[target.assetId]},{...target,variant:'sample'},{...target,action:'thumbnail'},{...target,action:'export',variant:'original'},{...target,action:'export',kind:'study'},{...target,action:'export',filePath:'/outside'}])
  assert.equal((await call(invalid)).structuredContent.error.code,'invalid_arguments',JSON.stringify(invalid));
 assert.equal(calls,0);
});

test('full retains valid typed unknown payload while explicit failure markers on read/image fail bounded',async t=>{
 const record={item:{kind:'history',id:target.id,revision:1,payload:{unknown:{error:'authored text, not a host marker'},prompt:'  exactly\n'}},assets:[],links:[]};
 const full={action:'read',kind:'history',id:target.id,revision:1,detail:'full'};
 assert.deepEqual((await (await mcp(t,record))(full)).structuredContent.item,record.item);
 for(const [request,value] of [[full,record],[{...full,detail:'summary'},record],[target,image()]]) {
  for(const marker of [{partial:{reason:'opaque'}},{warnings:['BAD'.repeat(20000)]},{complete:false},{isError:true},{error:{data:'BAD'.repeat(20000)}}]) {
   const raw={...value,...marker};const result=await (await mcp(t,raw))(request);
   assert.equal(result.isError,true);assert.equal(result.structuredContent.error.code,'asset_response_incomplete');assert.ok(result.content[0].text.length<512);assert.equal(result.content.length,1);
  }
 }
});

// Issue #2: asset_library image of a study (imported image) original. The request has no assetId; the reply names the
// study revision's single registered original and may carry its EXIF orientation.
const studyTarget={action:'image',kind:'study',id:'0f0e0d0c-0b0a-4908-8706-050403020100',revision:2};
const studyImage=()=>({...image(),kind:'study',id:studyTarget.id,revision:2,assetId:'path:'+'b'.repeat(64),contentBinding:'recorded-sha256'});
test('study image: native block with the registered original assetId and orientation; wrong identity, kind, blank assetId or orientation are refused',async t=>{
 const result=await (await mcp(t,{...studyImage(),sourceOrientation:6}))(studyTarget);assert.ok(!result.isError,JSON.stringify(result.structuredContent));
 assert.equal(result.content[1].type,'image');
 assert.deepEqual([result.structuredContent.kind,result.structuredContent.id,result.structuredContent.revision,result.structuredContent.assetId,result.structuredContent.sourceOrientation],['study',studyTarget.id,2,'path:'+'b'.repeat(64),6]);
 assert.ok(!('data' in result.structuredContent));
 assert.ok(!('sourceOrientation' in (await (await mcp(t,studyImage()))(studyTarget)).structuredContent),'no orientation reported: none returned');
 for(const changed of [{kind:'history'},{id:'0f0e0d0c-0b0a-4908-8706-050403020101'},{revision:1},{assetId:''},{assetId:' '},{assetId:undefined},{assetId:7},{sourceOrientation:0},{sourceOrientation:9},{sourceOrientation:'6'}]) {
  const result=await (await mcp(t,{...studyImage(),...changed}))(studyTarget);assert.equal(result.structuredContent.error.code,'invalid_response',JSON.stringify(changed));
 }
 let calls=0;const call=await mcp(t,()=>{calls++;return studyImage();});
 for(const invalid of [{...studyTarget,assetId:'path:'+'b'.repeat(64)},{...studyTarget,id:'not-a-uuid'},{...studyTarget,id:studyTarget.id.toUpperCase()},{...studyTarget,revision:0},{...studyTarget,revision:undefined},{...studyTarget,variant:'preview'}])
  assert.equal((await call(invalid)).structuredContent.error.code,'invalid_arguments',JSON.stringify(invalid));
 assert.equal(calls,0);
});

test('study image on a client without the study branch: host_outdated pointing at material_studies; history reads and other study refusals keep their codes',async t=>{
 const refusal=new BridgeError('invalid_argument',"素材请求无效：data must have required property 'assetId', data/kind must be equal to constant");
 const old=await mcp(t,()=>{throw refusal;});
 const error=(await old(studyTarget)).structuredContent.error;
 assert.equal(error.code,'host_outdated');assert.match(error.message,/Fully rebuild and restart the client/);assert.match(error.message,/material_studies \{action:"image", id\}/);
 assert.deepEqual(error.details,{hostCode:'invalid_argument'});assert.ok(!error.message.includes('assetId'),'the raw contract text is not passed on');
 assert.equal((await old(target)).structuredContent.error.code,'invalid_argument','a history read keeps the host answer');
 const missing=await mcp(t,()=>{throw new BridgeError('library_not_found','研读条目不存在');});
 assert.equal((await missing(studyTarget)).structuredContent.error.code,'library_not_found');
});
