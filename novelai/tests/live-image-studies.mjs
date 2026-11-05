#!/usr/bin/env node
// Real isolated Electron/IPC/HTTP + MCP helper. SFW fixtures only, no provider calls.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {_electron as electron} from 'playwright-core';
import {createBridgeClient} from '../src/mcp.mjs';
import {studyToolAction,studyToolResponse} from '../src/study-tools.mjs';

const root=fileURLToPath(new URL('..',import.meta.url)),client=resolve(root,'client'),requireClient=createRequire(resolve(client,'package.json'));
const output=resolve(root,'.runtime/image-studies-live',new Date().toISOString().replace(/[:.]/g,'-'));
// The client under test runs on its own data root (NOVELAI_DATA_DIR); its bridge.json is in <data root>/runtime.
const dataDir=resolve(output,'data'),runtimeDir=resolve(dataDir,'runtime');await mkdir(runtimeDir,{recursive:true});
const report={passed:false,generationRequests:0,modelCalls:0,steps:[],screenshots:[]};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const plain=await requireClient('sharp')(await readFile(resolve(root,'fixtures/garden-study.svg'))).png().toBuffer();
function chunk(key,value) {
  const data=Buffer.from(`${key}\0${value}`),type=Buffer.from('tEXt'),result=Buffer.alloc(data.length+12);
  result.writeUInt32BE(data.length);type.copy(result,4);data.copy(result,8);
  let crc=0xffffffff;for(const byte of Buffer.concat([type,data])){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  result.writeUInt32BE((crc^0xffffffff)>>>0,result.length-4);return result;
}
const prompt='adult gardener, garden, watering can, soft lighting. A fully clothed adult gardener waters a flower bed.';
const comment={prompt,uc:'text',seed:17,steps:28,scale:5,width:320,height:320,sampler:'k_euler',v4_prompt:{caption:{base_caption:prompt,char_captions:[{char_caption:'adult gardener, work shirt',centers:[{x:0.25,y:0.5},{x:0.3,y:0.6}]}]},use_coords:true},v4_negative_prompt:{caption:{base_caption:'text',char_captions:[{char_caption:'hat',centers:[{x:0.25,y:0.5}]}]}}};
const original=Buffer.concat([plain.subarray(0,plain.length-12),chunk('Software','NovelAI'),chunk('Source','NovelAI Diffusion V5 Full'),chunk('Description',prompt),chunk('Comment',JSON.stringify(comment)),plain.subarray(plain.length-12)]);
const env={...process.env,NOVELAI_DATA_DIR:dataDir,electron_config_cache:resolve(output,'electron-cache')};
for(const key of ['VITE_DEV_SERVER_URL','NAI_UI_CAPTURE_PATH','ELECTRON_RUN_AS_NODE'])delete env[key];
const bridge=createBridgeClient({runtimeDir});let application,page;
async function until(fn,predicate){let last;for(let i=0;i<150;i++){try{const result=await fn();if(predicate(result))return result;}catch(error){last=error;}await new Promise(resolve=>setTimeout(resolve,100));}throw new Error(`Acceptance timeout: ${last?.message??'state mismatch'}`);}
async function launch(first=false){
  application=await electron.launch({executablePath:requireClient('electron'),args:[client],cwd:client,env,timeout:45000});
  await application.evaluate(()=>{globalThis.__studyGenerationRequests=0;globalThis.fetch=async input=>{const url=new URL(typeof input==='string'?input:input.url);if(/novelai\.net$/.test(url.hostname))globalThis.__studyGenerationRequests++;throw new Error('External network disabled for local image study acceptance');};});
  page=await application.firstWindow();await page.waitForLoadState('domcontentloaded');
  if(first)await page.getByRole('button',{name:'跳过向导',exact:true}).click();
  await page.locator('.onboarding-backdrop').waitFor({state:'detached'});await page.locator('.splash-page').waitFor({state:'detached'});
  await until(()=>bridge.call('material_studies',{action:'list'}),value=>Array.isArray(value.items));
  await page.getByRole('button',{name:'我的素材库',exact:true}).click();
  await page.getByRole('button',{name:'作品研读',exact:true}).click();
}
async function workspace(){const listing=await until(()=>bridge.call('list_workspaces',{}),result=>result.workspaces?.length===1);return bridge.call('read_workspace',{workspaceId:listing.workspaces[0].workspaceId});}
async function screenshot(name){const path=resolve(output,name);await page.screenshot({path,fullPage:true});report.screenshots.push(path);}
try{
  await launch(true);const before=await workspace(),queue=await bridge.call('list_queue',{});
  await page.getByTestId('study-files').setInputFiles([{name:'garden-original.png',mimeType:'image/png',buffer:original},{name:'garden-no-metadata.png',mimeType:'image/png',buffer:plain},{name:'broken.png',mimeType:'image/png',buffer:Buffer.from('not an image')}]);
  const listing=await until(()=>bridge.call('material_studies',{action:'list'}),value=>value.total===2);
  const saved=listing.items.find(item=>item.sha256===sha(original)),missing=listing.items.find(item=>item.sha256===sha(plain));
  await page.getByText(/broken.png · 失败/).waitFor();
  assert.ok(saved);assert.equal(saved.metadataStatus,'generation');assert.equal(missing.metadataStatus,'missing');
  assert.ok(!JSON.stringify(listing).includes(prompt));assert.ok(!('data' in saved));
  const prompts=await studyToolAction({action:'read',id:saved.id,section:'prompts'},{bridge});
  assert.ok(prompts.fields.some(field=>field.value===prompt));assert.ok(JSON.stringify(prompts.fields).includes('work shirt'));
  const parameters=await bridge.call('material_studies',{action:'read',id:saved.id,section:'parameters'});
  assert.ok(!parameters.fields.some(field=>/stylePrompt|qualityToggle|ucPreset/.test(field.key)));
  const picture=studyToolResponse(await studyToolAction({action:'image',id:saved.id},{bridge}));assert.equal(picture.content[1].type,'image');assert.ok(!JSON.stringify(picture.details).includes(picture.content[1].data));
  await page.getByTestId(`study-card-${saved.id}`).click();
  await page.getByTestId('study-field').first().getByRole('button',{name:'摘录此字段',exact:true}).click();
  await page.getByLabel('摘录素材类型',{exact:true}).selectOption('note');
  await page.getByRole('button',{name:'放入素材草稿',exact:true}).click();
  await page.getByLabel('素材名称',{exact:true}).fill('SFW 社区研读摘录');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  const notes=await until(()=>bridge.call('material_library',{action:'list',kind:'note'}),result=>result.total===1);
  const note=await bridge.call('material_library',{action:'read',id:notes.items[0].id});
  assert.equal(note.entry.links[0].studyId,saved.id);assert.equal(note.entry.links[0].sourceSha256,sha(original));assert.equal(note.entry.links[0].excerpt,prompt);
  await page.getByRole('button',{name:'作品研读',exact:true}).click();
  await page.getByTestId(`study-card-${saved.id}`).click();
  await screenshot('study-desktop.png');
  assert.equal((await workspace()).revision,before.revision);assert.deepEqual(await bridge.call('list_queue',{}),queue);
  report.steps.push('Real UI batch import preserves original PNG and raw fields, keeps metadata-free picture, reports corrupt file separately, and leaves workspace/queue unchanged');
  // Exercise the new drop target. Duplicate bytes must not create another entry.
  await page.getByTestId('study-drop').evaluate((element,{bytes})=>{const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(bytes)],'dropped-copy.png',{type:'image/png'}));element.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));},{bytes:Array.from(original)});
  await page.getByText(/dropped-copy.png · 已有原件/).waitFor({state:'attached'});
  assert.equal((await bridge.call('material_studies',{action:'list'})).total,2);
  await page.getByTestId('study-drop').focus();
  await page.getByTestId('study-drop').evaluate((element,{bytes})=>{const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(bytes)],'pasted-copy.png',{type:'image/png'}));element.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));},{bytes:Array.from(plain)});
  await page.getByText(/pasted-copy.png · 已有原件/).waitFor({state:'attached'});
  assert.equal((await bridge.call('material_studies',{action:'list'})).total,2);
  const updated=await bridge.call('material_studies',{action:'update',id:saved.id,expectedRevision:saved.revision,patch:{notes:'User note: study the soft light; effect remains untested.',sourceUrl:'https://discord.com/channels/1/2/3',sourceAuthor:'Fixture author'}});
  assert.equal(updated.study.revision,saved.revision+1);
  const dup=await bridge.call('material_studies',{action:'import',name:'renamed-copy.png',data:original.toString('base64'),sourceAuthor:'Do not overwrite'});
  assert.equal(dup.duplicate,true);assert.equal(dup.study.id,saved.id);assert.equal(dup.study.sourceAuthor,'Fixture author');
  const exported=await studyToolAction({action:'original',id:saved.id},{bridge,exportsDirectory:resolve(output,'exports')});assert.deepEqual(await readFile(exported.file),original);
  assert.equal(await application.evaluate(()=>globalThis.__studyGenerationRequests),0);
  await application.close();application=null;
  await launch();
  const reopened=await bridge.call('material_studies',{action:'read',id:saved.id,section:'notes'});assert.match(reopened.notes,/soft light/);
  const reopenedOriginal=await bridge.call('material_studies',{action:'original',id:saved.id});assert.deepEqual(Buffer.from(reopenedOriginal.data,'base64'),original);
  await page.getByTestId(`study-card-${saved.id}`).click();
  await screenshot('study-reopened.png');
  await page.setViewportSize({width:1024,height:768});await screenshot('study-compact.png');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  assert.equal((await bridge.call('material_studies',{action:'list'})).total,2);
  assert.equal(await application.evaluate(()=>globalThis.__studyGenerationRequests),0);
  report.steps.push('Drop and existing paste router import duplicate bytes without extra entries; MCP exports exact original; real Electron restart retains collection and notes with external network disabled');
  report.steps.push('Actual UI excerpt enters editable material draft and saves exact source field, quote and original SHA without applying a recipe');
  report.steps.push('Desktop and compact collection layouts have no horizontal page overflow');
  report.passed=true;
}catch(error){report.error=error.stack??String(error);if(page)await screenshot('failure.png').catch(()=>{});throw error;}
finally{await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n');if(application)await application.close();console.log(JSON.stringify(report));}
