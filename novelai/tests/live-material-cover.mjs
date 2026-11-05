#!/usr/bin/env node
// Real isolated Electron UI, local cover persistence and offline restart.
// All remote pictures use the repository SFW fixture. Never touches user data.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { createBridgeClient } from '../src/mcp.mjs';
import { materialToolAction, materialToolResponse } from '../src/material-tools.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const client = resolve(root, 'client'), requireClient = createRequire(resolve(client, 'package.json'));
const output = resolve(root, '.runtime/material-cover-live', new Date().toISOString().replace(/[:.]/g, '-'));
// The client under test runs on its own data root (NOVELAI_DATA_DIR); its bridge.json is in <data root>/runtime.
const dataDir = resolve(output, 'data'), runtimeDir = resolve(dataDir, 'runtime'); await mkdir(runtimeDir, {recursive:true});
const fixture = await requireClient('sharp')(await readFile(resolve(root, 'fixtures/garden-study.svg'))).png().toBuffer();
const report = {runtimeDir, generationRequests:0, modelCalls:0, steps:[], screenshots:[], passed:false};
let application, page;
const env = {...process.env, NOVELAI_DATA_DIR:dataDir, electron_config_cache:resolve(output, 'electron-cache')};
for (const name of ['VITE_DEV_SERVER_URL','NAI_UI_CAPTURE_PATH','ELECTRON_RUN_AS_NODE']) delete env[name];
const bridge = createBridgeClient({runtimeDir});
async function until(fn, predicate) {
  let last;
  for(let i=0;i<150;i++) { try {const value=await fn(); if(predicate(value)) return value;} catch(error) {last=error;} await new Promise(resolve=>setTimeout(resolve,100)); }
  throw new Error(`Isolated setup timed out: ${last?.message ?? 'no matching state'}`);
}
async function launch(offline=false) {
  application=await electron.launch({executablePath:requireClient('electron'), args:[client], cwd:client, env, timeout:45000});
  await application.evaluate((_electron, {image, offline}) => {
    const original=globalThis.fetch;
    globalThis.__coverNetwork={remote:0,generation:0};
    globalThis.fetch=async(input,options)=>{
      const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
      if(/novelai\.net$/.test(url.hostname)) {globalThis.__coverNetwork.generation++;throw new Error('No generation during cover acceptance');}
      if(url.hostname!=='cdn.donmai.us' && url.hostname!=='danbooru.donmai.us') return original(input,options);
      globalThis.__coverNetwork.remote++;
      if(offline) throw new Error('External images and metadata offline after restart');
      const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
      if(url.hostname==='cdn.donmai.us') return new Response(Buffer.from(image,'base64'),{headers:{'content-type':'image/png'}});
      const post=id=>({id,rating:'g',is_deleted:false,is_banned:false,file_ext:'png',image_width:320,image_height:320,score:100,
        preview_file_url:`https://cdn.donmai.us/material/${id}.png`,large_file_url:`https://cdn.donmai.us/material/${id}.png`,file_url:`https://cdn.donmai.us/material/${id}.png`,
        tag_string_general:'garden sweat',tag_string_artist:'fixture_artist',tag_string_character:'',tag_string_copyright:'',tag_string_meta:''});
      if(url.pathname==='/tag_aliases.json')return json([]);
      const name=(url.searchParams.get('search[name]')??url.searchParams.get('search[name_matches]')??url.searchParams.get('search[title]')??'sweat').replaceAll('*','');
      if(url.pathname==='/tags.json')return json([{id:9001,name,category:0,post_count:1234,is_deprecated:false}]);
      if(url.pathname==='/wiki_pages.json')return json([{id:9002,title:name,body:'Visible perspiration on a person.',is_deleted:false}]);
      if(url.pathname==='/posts.json')return json([post(900000001)]);
      const match=/^\/posts\/(\d+)\.json$/.exec(url.pathname);if(match)return json(post(Number(match[1])));
      return new Response('Unrecognized fixture route',{status:404});
    };
  }, {image:fixture.toString('base64'),offline});
  page=await application.firstWindow();await page.waitForLoadState('domcontentloaded');
  if(!offline) await page.getByRole('button',{name:'跳过向导',exact:true}).click();
  await page.locator('.onboarding-backdrop').waitFor({state:'detached'});
  await page.locator('.splash-page').waitFor({state:'detached'});
  await until(()=>bridge.call('material_library',{action:'list'}),result=>Array.isArray(result.items));
}
async function workspace() {
  const found=await until(()=>bridge.call('list_workspaces',{}),result=>result.workspaces?.length===1);
  return bridge.call('read_workspace',{workspaceId:found.workspaces[0].workspaceId});
}
async function openLibrary() {
  await page.getByRole('button',{name:'我的素材库',exact:true}).click();
  await page.getByRole('heading',{name:'我的素材库',exact:true}).waitFor();
}
try {
  await launch();
  const before=await workspace(), queue=await bridge.call('list_queue',{});
  const saved=await materialToolAction({action:'save',entry:{kind:'tag',name:'汗水细节',group:'身体状态',tag:{text:'sweat',source:'danbooru',category:null,target:'character'}}},{bridge});
  await openLibrary();
  await page.getByRole('button',{name:/汗水细节/}).first().click();
  await page.getByRole('button',{name:'查看 General 示例',exact:true}).click();
  await page.getByRole('img',{name:'Danbooru #900000001',exact:true}).waitFor();
  await page.getByRole('button',{name:'保存为标签封面',exact:true}).click();
  const withCover=await until(()=>bridge.call('material_library',{action:'read',id:saved.id}),result=>result.entry.coverStatus==='ready');
  assert.equal(withCover.entry.revision,saved.revision);assert.equal(withCover.entry.coverRevision,1);
  const local=await materialToolAction({action:'cover',entryId:saved.id},{bridge});
  assert.ok(local.data.length>0);assert.equal(local.cover.sha256,withCover.entry.cover.sha256);
  assert.deepEqual(await bridge.call('list_queue',{}),queue);
  assert.equal((await workspace()).revision,before.revision);
  report.steps.push('UI explicitly saves one General example locally; tag revision, queue and workspace unchanged');
  await page.screenshot({path:resolve(output,'saved-cover-desktop.png'),fullPage:true});report.screenshots.push(resolve(output,'saved-cover-desktop.png'));
  assert.equal((await application.evaluate(()=>globalThis.__coverNetwork)).generation,0);
  await application.close();application=undefined;

  await launch(true);
  const offlineBefore=await workspace(),offlineQueue=await bridge.call('list_queue',{});
  const counters=await application.evaluate(()=>globalThis.__coverNetwork);
  await openLibrary();
  await page.locator('.material-entries img').first().waitFor();
  assert.ok(await page.locator('.material-entries img').first().evaluate(img=>img.complete && img.naturalWidth>0));
  const restored=await materialToolAction({action:'cover',entryId:saved.id},{bridge});
  assert.equal(restored.data,local.data);assert.equal(restored.cover.sha256,local.cover.sha256);
  const list=await materialToolAction({action:'list'},{bridge});assert.equal(list.items[0].revision,saved.revision);
  assert.ok(!JSON.stringify(list).includes(restored.data));
  const response=materialToolResponse(restored);assert.equal(response.content[1].type,'image');assert.ok(!JSON.stringify(response.details).includes(restored.data));
  assert.equal((await application.evaluate(()=>globalThis.__coverNetwork)).remote,counters.remote);
  assert.equal((await application.evaluate(()=>globalThis.__coverNetwork)).generation,0);
  assert.equal((await workspace()).revision,offlineBefore.revision);assert.deepEqual(await bridge.call('list_queue',{}),offlineQueue);
  report.steps.push('After actual Electron restart with remote access blocked, photo card automatically reads identical local image; MCP metadata stays compact');
  await page.screenshot({path:resolve(output,'offline-card-desktop.png'),fullPage:true});report.screenshots.push(resolve(output,'offline-card-desktop.png'));
  await page.setViewportSize({width:1024,height:768});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  await page.screenshot({path:resolve(output,'offline-card-compact.png'),fullPage:true});report.screenshots.push(resolve(output,'offline-card-compact.png'));
  report.steps.push('Desktop and compact photo-card layouts retain usable local image and no horizontal page overflow');
  report.passed=true;
}catch(error){report.error=error.stack??String(error);if(page)await page.screenshot({path:resolve(output,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
finally {await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n');if(application)await application.close();console.log(JSON.stringify(report));}
