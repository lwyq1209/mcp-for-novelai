import {afterEach,describe,expect,it} from 'vitest';
import { runCleanupsSync } from '../../src/test-support/temp-dirs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {DEFAULT_PARAMS} from '../../src/types';
import {openLibraryRepository,type LibraryRepository} from './repository';
import {createAssetLibraryService} from '../asset-library-service';
import {buildHistoryTagIndex} from './history-tag-index';
import {extractHistoryTags,normalizeHistoryTag} from './history-tags';

const roots:string[]=[],repos:LibraryRepository[]=[];
const stamp='2026-09-12T00:00:00Z';
function setup(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'nai-history-tags-'));roots.push(root);const databasePath=path.join(root,'library.sqlite');const repo=openLibraryRepository({filePath:databasePath});repos.push(repo);return {root,databasePath,repo,call:createAssetLibraryService({repository:repo}).asset_library};}
const history=(id:string,positive='blue_eyes, red_hair',style='{{watercolor}}',characters?:string[])=>({id,filePath:`/missing/${id}.png`,fileUrl:`file:///missing/${id}.png`,createdAt:stamp,date:'2026-09-12',params:{...DEFAULT_PARAMS,positivePrompt:positive,stylePrompt:style,negativePrompt:'blurry, cropped, bad_hands',seed:0},actualSeed:0,model:DEFAULT_PARAMS.model,width:32,height:32,...(characters===undefined?{}:{characterPrompts:characters})});
afterEach(()=>runCleanupsSync([...repos.splice(0).map(repo=>()=>repo.close()),...roots.splice(0).map(root=>()=>fs.rmSync(root,{recursive:true,force:true}))]));

describe('history images by authored tags',()=>{
 it('normalizes only tag spelling and NAI wrappers, preserving prompt bytes and source provenance',()=>{
  const value=history('h','{{Blue_Eyes, Red_Hair}}, 1.2::white_shirt, smile::','0.7::artist:foo_(bar)::',['[green_eyes], standing']);const copy=structuredClone(value);
  const {tags,coverage}=extractHistoryTags(value);expect(tags).toContainEqual({tag:'blue eyes',source:'positive'});expect(tags).toContainEqual({tag:'smile',source:'positive'});expect(tags).toContainEqual({tag:'artist:foo (bar)',source:'style'});expect(tags).toContainEqual({tag:'green eyes',source:'character',characterIndex:0});expect(tags.some(tag=>tag.tag==='bad hands')).toBe(false);expect(coverage).toEqual({positive:true,style:true,character:true,user:true});expect(value).toEqual(copy);expect(normalizeHistoryTag(' {{Blue__Eyes}} ')).toBe('blue eyes');expect(normalizeHistoryTag('{{.5::Blue_Eyes::}}')).toBe('blue eyes');
 });
 it('combines tags with ALL or ANY and source filters in stable paginated SQL, excluding negative-only matches',async()=>{
  const {repo,call}=setup();repo.put('history','a',history('a'));repo.put('history','b',history('b','blue eyes, black hair','watercolor',[]));repo.put('history','c',history('c','forest','oil painting',['blue eyes, red hair']));repo.put('note','unrelated',{name:'blue eyes, red hair'});
  const all=await call({action:'list',historyTags:['BLUE_EYES','red hair'],sortBy:'name',sortDirection:'asc',limit:1});expect(all.total).toBe(2);expect(all.items[0].id).toBe('a');expect(all.items[0].matchedTags).toEqual([{tag:'blue eyes',source:'positive'},{tag:'red hair',source:'positive'}]);const page=await call({action:'list',historyTags:['blue eyes','red_hair'],sortBy:'name',sortDirection:'asc',limit:1,offset:1});expect(page.items[0].matchedTags).toEqual([{tag:'blue eyes',source:'character',characterIndex:0},{tag:'red hair',source:'character',characterIndex:0}]);expect((await call({action:'list',historyTags:['black_hair','oil_painting'],historyTagMatch:'any'})).total).toBe(2);expect((await call({action:'list',historyTags:['blue eyes'],historyTagSources:['character']})).items.map((i:any)=>i.id)).toEqual(['c']);expect((await call({action:'list',historyTags:['bad_hands']})).total).toBe(0);expect((await call({action:'list',historyTags:["' OR 1=1 --"]})).total).toBe(0);await expect(call({action:'list',historyTags:['{}']})).rejects.toMatchObject({code:'invalid_argument'});
 });
 it('keeps the single history search on positive tags and real names, with SQL pagination and no negative replay leakage',async()=>{
  const {repo,call}=setup();
  const negative={...history('negative','adult gardener',''),params:{...history('negative').params,positivePrompt:'adult gardener',stylePrompt:'',negativePrompt:'forest, waterfall',metadataReplay:{model:DEFAULT_PARAMS.model,parameters:{negative_prompt:'forest, snowy mountain'}}}};
  repo.put('history','negative',negative,{name:'Quiet portrait'});
  repo.put('history','positive',history('positive','{{forest_path}}, adult gardener',''),{name:'Morning walk'});
  repo.put('history','style',history('style','adult gardener','0.7::watercolor forest::'),{name:'Painted portrait'});
  repo.put('history','character',history('character','adult gardener','',['forest guide']),{name:'Travel guide'});
  repo.put('history','user',{...history('user','adult gardener',''),annotation:{customTags:['森林 日光']}},{name:'Window light'});
  repo.put('history','named',history('named','adult gardener',''),{name:'Forest sketch'});
  const search=(query:string,extra:Record<string,unknown>={})=>call({action:'list',kinds:['history'],query,sortBy:'name',sortDirection:'asc',...extra});
  const first=await search('FOREST',{limit:2}),second=await search('forest',{limit:2,offset:2});
  expect(first.total).toBe(4);expect(first.hasMore).toBe(true);expect([...first.items,...second.items].map((i:any)=>i.id)).toEqual(['named','positive','style','character']);
  expect(first.items[0].matchedTags).toEqual([]);
  expect(first.items[1].matchedTags).toEqual([{tag:'forest path',source:'positive'}]);
  expect(second.items[0].matchedTags).toEqual([{tag:'watercolor forest',source:'style'}]);
  expect(second.items[1].matchedTags).toEqual([{tag:'forest guide',source:'character',characterIndex:0}]);
  expect((await search('FOREST_PA')).items.map((i:any)=>i.id)).toEqual(['positive']);
  expect((await search('1.2::forest_path::')).items.map((i:any)=>i.id)).toEqual(['positive']);
  expect((await search('森林')).items.map((i:any)=>i.id)).toEqual(['user']);
  expect((await search('Quiet portrait')).items.map((i:any)=>i.id)).toEqual(['negative']);
  expect((await search('waterfall')).total).toBe(0);expect((await search('snowy mountain')).total).toBe(0);
  expect((await search('forest',{historyTags:['adult gardener','watercolor forest'],historyTagMatch:'all'})).items.map((i:any)=>i.id)).toEqual(['style']);
  expect((await search('{}')).total).toBe(0);
  // The explicit all-material mode still includes full authored fields.
  expect((await call({action:'list',query:'waterfall'})).items.map((i:any)=>i.id)).toEqual(['negative']);
 });
 it('counts candidate images once across multiple fields and reports old character coverage as unknown',async()=>{
  const {repo,call}=setup();repo.put('history','a',history('a','blue eyes','blue eyes',['blue eyes']));repo.put('history','b',history('b','blue eyes',''));repo.put('history','archived',history('archived'),{archived:true});
  expect((await call({action:'tag-suggestions',query:'blue_ey'})).tags).toEqual([{tag:'blue eyes',sources:['character','positive','style'],count:2}]);const old=await call({action:'read',kind:'history',id:'b'});expect(old.tagCoverage).toEqual({positive:true,style:true,character:false,user:true});repo.put('history','none',history('none','','',[]));expect((await call({action:'read',kind:'history',id:'none'})).tagCoverage.character).toBe(true);
 });
 it('versioned custom annotations never change generation facts or old versions and stale batches roll back',async()=>{
  const {repo,call}=setup();repo.put('history','a',history('a'));repo.put('history','b',history('b'));const before=repo.get('history','a')!,files=repo.assetLinks('history','a');const result=await call({action:'mutate',command:'set-custom-tags',items:[{kind:'history',id:'a',expectedRevision:1}],tags:[' 日光 ','Blue_Eyes','blue eyes']});expect(result.items[0].payload).toEqual({...before.payload,annotation:{customTags:['日光','Blue_Eyes']}});expect(result.items[0]).toMatchObject({revision:2,source:before.source,archived:before.archived});expect(repo.assetLinks('history','a')).toEqual(files);expect(repo.get('history','a',1)!.payload).toEqual(before.payload);expect((await call({action:'list',historyTags:['日光','blue eyes'],historyTagSources:['user']})).total).toBe(1);await expect(call({action:'mutate',command:'set-custom-tags',items:[{kind:'history',id:'b',expectedRevision:1},{kind:'history',id:'a',expectedRevision:1}],tags:['must not apply']})).rejects.toMatchObject({code:'library_conflict'});expect(repo.get('history','b')!.revision).toBe(1);await call({action:'mutate',command:'set-custom-tags',items:[{kind:'history',id:'a',expectedRevision:2}],tags:[]});expect((await call({action:'list',historyTags:['日光']})).total).toBe(0);expect((await call({action:'read',kind:'history',id:'a'})).item.payload.actualSeed).toBe(0);await expect(call({action:'restore-content',kind:'history',id:'a',revision:1,expectedRevision:3})).rejects.toMatchObject({code:'invalid_argument'});
 });
 it('rebuilds the derived index from snapshot versions and removes deleted images from suggestions',async()=>{
  const {repo}=setup();repo.put('history','a',history('a'));repo.put('history','a',{...history('a'),annotation:{customTags:['日光']}},{expectedRevision:1});const {repo:target,call}=setup();target.importSnapshot(repo.exportSnapshot());expect((await call({action:'list',historyTags:['日光','red_hair']})).total).toBe(1);expect((await call({action:'read',kind:'history',id:'a',revision:1})).tags.some((tag:any)=>tag.source==='user')).toBe(false);target.remove('history','a');expect((await call({action:'tag-suggestions'})).tags).toEqual([]);
 });
 it('performs one recoverable startup build in the actual worker without touching old records or reading missing images',async()=>{
  const {repo,root,databasePath}=setup();repo.put('history','a',history('a'));repo.put('history','b',history('b','green eyes'));const before=repo.exportSnapshot();repo.close();const db=new DatabaseSync(databasePath);db.exec("DELETE FROM history_tags; CREATE TRIGGER interrupt_tags BEFORE INSERT ON history_tags WHEN NEW.history_id='b' BEGIN SELECT RAISE(ABORT,'interrupted tag index'); END;");db.close();
  await expect(buildHistoryTagIndex({databasePath,libraryDirectory:root,useWorker:false})).rejects.toThrow('interrupted');const failed=openLibraryRepository({filePath:databasePath});expect(failed.historyTagsReady()).toBe(false);expect(failed.historyTagSuggestions()).toEqual([]);expect(failed.exportSnapshot()).toEqual(before);failed.close();const unlock=new DatabaseSync(databasePath);unlock.exec('DROP TRIGGER interrupt_tags');unlock.close();
  const client=path.resolve(__dirname,'../..'),build=path.join(root,'compiled');execFileSync(process.execPath,[path.join(client,'node_modules/typescript/bin/tsc'),'--ignoreConfig','--outDir',build,'--rootDir',client,'--strict','--skipLibCheck','--types','node','--esModuleInterop','--resolveJsonModule','--target','ES2022','--module','Node16','--moduleResolution','Node16','--allowJs','electron/library/history-tag-index-worker.ts','shared/runtime/data-paths.cjs'],{cwd:client,stdio:'pipe'});const workerPath=path.join(root,'worker.cjs');fs.writeFileSync(workerPath,`process.env.NODE_PATH=${JSON.stringify(path.join(client,'node_modules'))};require('node:module').Module._initPaths();require(${JSON.stringify(path.join(build,'electron/library/history-tag-index-worker.js'))});`);
  expect(await buildHistoryTagIndex({databasePath,libraryDirectory:root,workerPath})).toEqual({rebuilt:true});const reopened=openLibraryRepository({filePath:databasePath});expect(reopened.exportSnapshot()).toEqual(before);expect(reopened.list({historyTags:['blue_eyes']})).toMatchObject({total:1});const revision=reopened.getRevision();reopened.close();expect(await buildHistoryTagIndex({databasePath,libraryDirectory:root,workerPath:'/must-not-start-worker.js'})).toEqual({rebuilt:false});const unchanged=openLibraryRepository({filePath:databasePath});expect(unchanged.getRevision()).toBe(revision);unchanged.close();
 });
});
