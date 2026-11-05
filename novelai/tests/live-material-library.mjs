#!/usr/bin/env node
// Isolated real Electron/IPC/HTTP/React acceptance. Only external Danbooru
// transport is substituted with repository SFW fixtures; no NovelAI request.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { createBridgeClient } from '../src/mcp.mjs';
import { materialToolAction } from '../src/material-tools.mjs';
const root = fileURLToPath(new URL('..', import.meta.url)), client = resolve(root,'client');
const requireClient = createRequire(resolve(client,'package.json'));
const output = resolve(root,'.runtime/material-library-live',new Date().toISOString().replace(/[:.]/g,'-'));
// The client under test runs on its own data root (NOVELAI_DATA_DIR); its bridge.json is in <data root>/runtime.
const dataDir = resolve(output,'data'), runtimeDir = resolve(dataDir,'runtime'); await mkdir(runtimeDir,{recursive:true});
const png = await requireClient('sharp')(await readFile(resolve(root,'fixtures/garden-study.svg'))).png().toBuffer();
const report={runtimeDir,generated:false,transport:'fixture Danbooru; real Electron/IPC/HTTP and MCP tool helper',steps:[],screenshots:[]};
let application;
async function until(fn,predicate){for(let i=0;i<150;i++){try{const value=await fn();if(predicate(value))return value;}catch{} await new Promise(r=>setTimeout(r,100));}throw new Error('Acceptance setup timeout');}
try {
  const env={...process.env,NOVELAI_DATA_DIR:dataDir,electron_config_cache:resolve(output,'electron-cache')};
  for(const key of ['VITE_DEV_SERVER_URL','NAI_UI_CAPTURE_PATH','ELECTRON_RUN_AS_NODE'])delete env[key];
  application=await electron.launch({executablePath:requireClient('electron'),args:[client],cwd:client,env,timeout:45000});
  await application.evaluate((_electron,image)=>{
    const original=globalThis.fetch;
    globalThis.__materialGenerationRequests=0;
    globalThis.fetch=async(input,options)=>{
      const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
      if(/novelai\.net$/.test(url.hostname)){globalThis.__materialGenerationRequests++;throw new Error('Generation forbidden in this acceptance');}
      const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
      const post=id=>({id,rating:'g',is_deleted:false,is_banned:false,file_ext:'png',image_width:320,image_height:320,score:id===900000003?5:100,
        preview_file_url:`https://cdn.donmai.us/material/${id}.png`,large_file_url:`https://cdn.donmai.us/material/${id}.png`,file_url:`https://cdn.donmai.us/material/${id}.png`,
        tag_string_general:'garden sweat',tag_string_artist:'fixture_artist',tag_string_character:'',tag_string_copyright:'',tag_string_meta:''});
      if(url.hostname==='cdn.donmai.us')return new Response(Buffer.from(image,'base64'),{headers:{'content-type':'image/png'}});
      if(url.hostname!=='danbooru.donmai.us')return original(input,options);
      if(url.pathname==='/tag_aliases.json')return json([]);
      const raw=url.searchParams.get('search[name]')??url.searchParams.get('search[name_matches]')??url.searchParams.get('search[title]')??'';
      const name=raw.replaceAll('*','')||'sweat';
      if(url.pathname==='/tags.json')return json([{id:name==='sweat'?9001:9002,name,category:name==='sweat'?0:1,post_count:1234,is_deprecated:false}]);
      if(url.pathname==='/wiki_pages.json')return json([{id:9003,title:name,body:name==='sweat'?'Perspiration visible on a person.':'An artist used in an isolated SFW transport fixture.',is_deleted:false}]);
      if(url.pathname==='/posts.json')return json([post(900000001),post(900000003)]);
      const found=/^\/posts\/(\d+)\.json$/.exec(url.pathname);if(found)return json(post(Number(found[1])));
      return new Response('Unknown fixture route',{status:404});
    };
  },png.toString('base64'));
  const page=await application.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.getByRole('button',{name:'跳过向导',exact:true}).click();
  await page.locator('.onboarding-backdrop').waitFor({state:'detached'});
  await page.locator('.splash-page').waitFor({state:'detached'});
  const bridge=createBridgeClient({runtimeDir});
  await until(()=>bridge.call('material_library',{action:'list'}),result=>Array.isArray(result.items));
  const listing=await until(()=>bridge.call('list_workspaces',{}),result=>result.workspaces?.length===1);
  const workspaceId=listing.workspaces[0].workspaceId;
  let workspace=await bridge.call('read_workspace',{workspaceId});
  const draft=await bridge.call('draft_edit',{workspaceId,expectedRevision:workspace.revision,patch:{
    params:{model:'nai-diffusion-5-full',positivePrompt:'adult gardener in a sunlit garden',negativePrompt:'',stylePrompt:'',seed:17,seedMode:'fixed'},
    charCaptions:[{id:'material-adult',prompt:'adult gardener, work shirt',negativePrompt:'',useCoords:false,x:0.5,y:0.5}],
  }});
  workspace=await bridge.call('apply_edit',{workspaceId,expectedRevision:workspace.revision,draftId:draft.draftId});
  const save=entry=>materialToolAction({action:'save',entry},{bridge});
  const sweat=await save({kind:'tag',name:'汗水细节',group:'身体状态',notes:'用于明确角色的身体状态。',tag:{text:'sweat',source:'danbooru',category:null,target:'character'}});
  const artist=await save({kind:'tag',name:'示例画师',group:'画师',tag:{text:'fixture_artist',source:'danbooru',category:null,target:'style'}});
  assert.equal(sweat.tag.text,'sweat');assert.equal(sweat.tag.target,'character');assert.equal(artist.tag.category,'artist');
  const listed=await materialToolAction({action:'list'},{bridge});assert.equal(listed.total,2);assert.ok(!JSON.stringify(listed).includes('Perspiration visible'));
  report.steps.push('MCP tool helper saves verified tag; host compact list shared with UI');
  const before=await bridge.call('list_queue',{});
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('novelai:open-material-library',{detail:{scope:'base'}})));
  await page.getByRole('heading',{name:'我的素材库',exact:true}).waitFor();
  await page.getByRole('button',{name:/汗水细节/}).first().click();
  await page.getByText('sweat',{exact:true}).first().waitFor();
  await page.screenshot({path:resolve(output,'library-desktop.png'),fullPage:true});report.screenshots.push(resolve(output,'library-desktop.png'));
  const samples=await materialToolAction({action:'samples',entryId:artist.id},{bridge});assert.equal(samples.items.length,1);assert.equal(samples.items[0].score,100);
  const picture=await materialToolAction({action:'sample_image',entryId:artist.id,postId:samples.items[0].postId},{bridge});assert.equal(picture.mimeType,'image/png');
  assert.deepEqual(await bridge.call('list_queue',{}),before);
  assert.equal((await bridge.call('read_workspace',{workspaceId})).revision,workspace.revision);
  report.steps.push('General score filter and native sample retrieval do not enqueue or pause anything');
  // Same endpoint is reachable from the actual renderer preload without a workspace.
  const current=await page.evaluate(id=>window.naiDesktop.materialLibrary({action:'read',id}),sweat.id);assert.equal(current.entry.tag.text,'sweat');
  await page.getByRole('button',{name:'选入 汗水细节',exact:true}).click();
  await page.getByLabel('应用角色',{exact:true}).selectOption('material-adult');
  await page.getByRole('button',{name:'追加到当前配方的对应字段',exact:true}).click();
  const applied=await until(()=>bridge.call('read_workspace',{workspaceId}),result=>result.state.charCaptions[0].prompt.includes('sweat'));
  assert.equal(applied.state.params.stylePrompt,workspace.state.params.stylePrompt);
  assert.equal(applied.state.params.positivePrompt,workspace.state.params.positivePrompt);
  assert.deepEqual(await bridge.call('list_queue',{}),before);
  report.steps.push('Manual content tag application changes only the explicitly selected character; no generation');
  await page.getByRole('button',{name:'关闭素材库',exact:true}).click();
  await page.getByTestId('material-library').waitFor({state:'detached'});
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('novelai:open-material-library',{detail:{scope:'base'}})));
  await page.setViewportSize({width:1024,height:768});
  await page.screenshot({path:resolve(output,'library-compact.png'),fullPage:true});report.screenshots.push(resolve(output,'library-compact.png'));
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);assert.equal(overflow,false);
  report.steps.push('Desktop and compact UI render shared records without horizontal page overflow');
  assert.equal(await application.evaluate(()=>globalThis.__materialGenerationRequests),0);
  report.passed=true;
}catch(error){report.error=error.stack??String(error);throw error;}
finally{await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));if(application)await application.close();console.log(JSON.stringify(report));}
