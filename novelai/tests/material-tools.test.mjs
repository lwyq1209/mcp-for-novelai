import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { materialToolAction, materialToolResponse } from '../src/material-tools.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'nai-material-tools-'));
  t.after(() => rm(directory, { recursive:true, force:true }));
  const inbox = join(directory,'inbox'), exportsDirectory = join(directory,'exports'); await mkdir(inbox);
  const calls = [];
  const bridge = { async call(method,args) { calls.push({method,args}); return {entry:{id:'fixture',revision:1,kind:'tag',name:'汗水',tag:{text:'sweat',source:'danbooru',target:'character',evidence:{resolution:'canonical',wiki:{body:'not part of save output'}}}}}; } };
  return { directory,inbox,exportsDirectory,calls,bridge };
}
test('file save forwards only one library mutation and returns compact identity',async t=>{
  const f=await fixture(t); const entry={kind:'tag',name:'汗水',tag:{text:'sweat',source:'danbooru',target:'character'}};
  await writeFile(join(f.inbox,'sweat.json'),JSON.stringify({entry}));
  const result=await materialToolAction({action:'save',file:'sweat.json'},f);
  assert.deepEqual(f.calls,[{method:'material_library',args:{action:'save',entry}}]);
  assert.equal(result.id,'fixture'); assert.equal(result.tag.text,'sweat'); assert.equal(result.generationSubmitted,false);
  assert.ok(!JSON.stringify(result).includes('wiki'));
});
test('rejects escaping paths, symlinks and action replacement without bridge calls',async t=>{
  const f=await fixture(t); await writeFile(join(f.directory,'outside.json'),'{}'); await symlink(join(f.directory,'outside.json'),join(f.inbox,'linked.json'));
  for(const file of ['../outside.json','/tmp/outside.json','linked.json']) await assert.rejects(materialToolAction({action:'save',file},f));
  await writeFile(join(f.inbox,'action.json'),JSON.stringify({action:'enqueue'}));
  await assert.rejects(materialToolAction({action:'save',file:'action.json'},f));
  await assert.rejects(materialToolAction({action:'read',file:'action.json'},f)); assert.equal(f.calls.length,0);
});
test('tag and sample queries never touch workspace or generation methods',async t=>{
  const f=await fixture(t);
  const fields={search_tags:{query:'sweat'},tag_details:{name:'sweat'},samples:{entryId:'fixture'},sample_image:{entryId:'fixture',postId:321},set_cover:{entryId:'fixture',revision:1,postId:321,expectedCoverRevision:0},cover:{entryId:'fixture'},clear_cover:{entryId:'fixture',expectedCoverRevision:1}};
  for(const [action,method,mapped] of [['search_tags','material_tags','search'],['tag_details','material_tags','details'],['samples','material_samples','list'],['sample_image','material_samples','image'],['set_cover','material_samples','set_cover'],['cover','material_samples','cover'],['clear_cover','material_samples','clear_cover']]) {
    await materialToolAction({action,...fields[action]},f); assert.equal(f.calls.at(-1).method,method); assert.equal(f.calls.at(-1).args.action,mapped);
  }
});
test('backup goes to disk rather than expanding all prompts into the tool response',async t=>{
  const f=await fixture(t); const data={schemaVersion:1,entries:[{schemaVersion:1,id:'test',revision:1,kind:'note',name:'Visual note',group:'',notes:'long user notes',archived:false,createdAt:'2026-09-12',updatedAt:'2026-09-12'}],covers:[{entryId:'test',cover:{sha256:'a'.repeat(64),mimeType:'image/webp',width:10,height:10,byteLength:12,postId:321,sourceUrl:'https://danbooru.donmai.us/posts/321',tagText:'sweat',tagCategory:null,rating:'g',savedAt:'2026-09-12',verification:'imported',checkedAt:null},data:'bG9jYWwtY292ZXI='}]}; f.bridge.call=async()=>({data});
  const result=await materialToolAction({action:'export'},f);
  assert.equal(result.exported,true); assert.ok(!JSON.stringify(result).includes('long user notes'));
  assert.deepEqual(JSON.parse(await readFile(result.file,'utf8')),data);
  await writeFile(join(f.inbox,'backup.json'),await readFile(result.file));
  let imported;
  f.bridge.call=async(method,args)=>{ imported={method,args}; return {count:1,items:[]}; };
  await materialToolAction({action:'import',file:'backup.json'},f);
  assert.deepEqual(imported,{method:'material_library',args:{action:'import',data}});
});
test('image returns native image block with no base64 in text or details',()=>{
  const result=materialToolResponse({postId:1,mimeType:'image/png',data:'ZmFrZQ=='});
  assert.equal(result.content[1].type,'image'); assert.ok(!result.content[0].text.includes('ZmFrZQ')); assert.ok(!('data' in result.details));
});
test('partial cover backup preserves warnings without expanding image data into the tool context', async t => {
  const f = await fixture(t), data = { schemaVersion:1, entries:[], covers:[] };
  f.bridge.call = async () => ({data, warnings:Array.from({length:12}, (_,i)=>({entryId:`entry-${i}`,code:'cover_unavailable'}))});
  const result = await materialToolAction({action:'export'},f);
  assert.equal(result.exported,true);assert.equal(result.complete,false);assert.equal(result.warningCount,12);assert.equal(result.warnings.length,8);
  assert.deepEqual(JSON.parse(await readFile(result.file,'utf8')),data);
});
test('one slow metadata call does not serialize another library request',async t=>{
  const f=await fixture(t); let release; const pending=new Promise(r=>release=r);
  f.bridge.call=async(method)=>method==='material_tags'?pending:{items:[]};
  const slow=materialToolAction({action:'tag_details',name:'sweat'},f);
  assert.deepEqual(await materialToolAction({action:'list'},f),{items:[]}); release({}); await slow;
});

test('local cover uses its own revision and returns native image without leaking bytes into metadata', async t => {
  const f = await fixture(t);
  const stored = { entryId:'cover-entry', entryRevision:7, coverRevision:2, coverStatus:'ready', cover:{sha256:'abc',postId:321} };
  f.bridge.call=async(method,args)=>{ f.calls.push({method,args}); return args.action==='cover' ? {...stored,mimeType:'image/webp',data:'Y292ZXI='} : stored; };
  const params={action:'set_cover',entryId:'cover-entry',revision:7,expectedCoverRevision:1,postId:321,minScore:20,rating:'q'};
  assert.deepEqual(await materialToolAction(params,f),stored);
  assert.deepEqual(f.calls[0],{method:'material_samples',args:params});
  const response=materialToolResponse(await materialToolAction({action:'cover',entryId:'cover-entry'},f));
  assert.equal(response.content[1].type,'image');assert.equal(response.content[1].mimeType,'image/webp');
  assert.ok(!JSON.stringify(response.details).includes('Y292ZXI='));
  assert.ok(!response.content[0].text.includes('Y292ZXI='));
  await materialToolAction({action:'clear_cover',entryId:'cover-entry',expectedCoverRevision:2},f);
  assert.equal(f.calls.at(-1).method,'material_samples');
});
test('a material backup with a Danbooru cover without its rating is refused naming that cover, without a bridge call', async t => {
  const f = await fixture(t);
  const cover = { sha256: 'a'.repeat(64), mimeType: 'image/webp', width: 10, height: 10, byteLength: 12, postId: 321, sourceUrl: 'https://danbooru.donmai.us/posts/321', tagText: 'sweat', tagCategory: null, savedAt: '2026-09-12', verification: 'imported', checkedAt: null };
  const data = { schemaVersion: 1, entries: [], covers: [{ entryId: 'fixture', cover: { ...cover, rating: 'g' }, data: 'bG9jYWwtY292ZXI=' }, { entryId: 'second', cover, data: 'bG9jYWwtY292ZXI=' }] };
  await assert.rejects(materialToolAction({ action: 'import', data }, f), { code: 'invalid_arguments', message: /^arguments\/data\/covers\/1\/cover is a Danbooru cover without its rating \(g, s, q or e\)/ });
  await writeFile(join(f.inbox, 'backup.json'), JSON.stringify(data));
  await assert.rejects(materialToolAction({ action: 'import', file: 'backup.json' }, f), { code: 'invalid_arguments', message: /covers\/1\/cover is a Danbooru cover without its rating/ });
  assert.equal(f.calls.length, 0);
  data.covers[1].cover = { ...cover, rating: 's' };
  await materialToolAction({ action: 'import', data }, f);
  assert.equal(f.calls.length, 1);
});
