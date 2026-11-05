import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { startHttpBridge } from './bridge-server';
import { createAssetLibraryService } from './asset-library-service';
import { openLibraryRepository } from './library/repository';
import { runCleanups, type Cleanup } from '../src/test-support/temp-dirs';

// Each resource is registered as soon as it exists and released in reverse order after the test, also when it
// fails, times out or is retried; one failing close does not skip the others.
const cleanups:Cleanup[]=[];
afterEach(()=>runCleanups(cleanups.splice(0).reverse()));

it('MCP → own HTTP → SQLite: bounded pages, old full, unchanged desktop/database, no canvas', async () => {
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const load = (name:string) => import(/* @vite-ignore */ new URL(name,import.meta.url).href);
  const {createBridgeClient,createNovelAiMcpServer}=await load('../../src/mcp.mjs');
  const {Client}=await load('../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const {InMemoryTransport}=await load('../../node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js');
  const directory=await mkdtemp(path.join(os.tmpdir(),'nai-ai-history-'));cleanups.push(()=>rm(directory,{recursive:true,force:true}));
  const dbPath=path.join(directory,'library.sqlite');
  const repo=openLibraryRepository({filePath:dbPath});cleanups.push(()=>repo.close());
  const service=createAssetLibraryService({repository:repo});
  const calls:Array<{method:string;args:any}>=[];
  const measurements:any[]=[];
  const host=await startHttpBridge({runtimeDir:path.join(directory,'bridge'),dispatch:async(method,args)=>{
    calls.push({method,args});expect(method).toBe('asset_library');return service.asset_library(args);
  }});
  cleanups.push(()=>host.close());
  let client:any,server:any;
  cleanups.push(async()=>{await server?.close();},async()=>{await client?.close();}); // reversed: client closes first
  {
    const original={id:'h-00',filePath:'/synthetic/never-read.png',date:'2026-09-20',createdAt:'2026-09-20T00:00:00Z',
      model:'nai-diffusion-5-full',width:1024,height:1024,
      params:{positivePrompt:'blue sky, '+'雨窗😀'.repeat(3000),negativePrompt:'NEGATIVE_ONLY'.repeat(2000),seed:0},
      characterPrompts:Array.from({length:32},(_,i)=>`character ${i}, blue sky, `+'CHARACTER_ONLY'.repeat(1000)),
      charCaptions:Array.from({length:32},(_,i)=>({prompt:`原文${i}\n`,uc:'角色负向',center:{x:0.2,y:0.8}})),
      legacyUnknown:{exact:'  unknown old field\n'},actualSeed:0};
    for(let i=0;i<25;i++) repo.put('history',`h-${String(i).padStart(2,'0')}`,{...original,id:`h-${String(i).padStart(2,'0')}`},{name:`雨窗 ${i}`});
    repo.put('history','h-00',{...original,params:{...original.params,positivePrompt:'NEW VERSION'}},{expectedRevision:1});
    repo.put('artist_favorite','random:f',{id:'f',collection:'random',image:original,prompt:'favorite',name:'收藏'});
    repo.put('study','study-1',{study:{id:'study-1',name:'研究',longUnknown:'STUDY_RAW'.repeat(4000)},sections:{raw:'RAW_ONLY'.repeat(3000)}});
    repo.put('note','note-1',{id:'note-1',name:'心得',notes:'NOTE_FULL'.repeat(4000)});
    const snapshot=repo.exportSnapshot(), revision=repo.getRevision();
    const dbHash=async()=>{
      const hashes=[];
      for(const suffix of ['', '-wal', '-shm']) hashes.push(await readFile(dbPath+suffix).then(data=>createHash('sha256').update(data).digest('hex'),error=>error.code==='ENOENT'?'absent':Promise.reject(error)));
      return hashes;
    };
    const beforeFiles=await dbHash();
    const rawPage=await service.asset_library({action:'list',kinds:['history']});
    measurements.push({route:'desktop/internal default',textBytes:Buffer.byteLength(JSON.stringify(rawPage)),returned:rawPage.items.length});
    const bridge=createBridgeClient({runtimeDir:path.join(directory,'bridge')});
    server=createNovelAiMcpServer({bridgeClient:bridge});client=new Client({name:'http-history-test',version:'1'});
    const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
    const invokeMcp=(args:any)=>client.callTool({name:'asset_library',arguments:args});
    for(const invoke of [invokeMcp]) {
      const first=await invoke({action:'list',kinds:['history']});const data=first.details??first.structuredContent;
      expect(data.limit).toBe(10);expect(data.returned).toBe(10);expect(data.total).toBe(25);expect(data.nextOffset).toBe(10);
      expect(Buffer.byteLength(first.content[0].text)).toBeLessThanOrEqual(12288);
      measurements.push({route:'MCP / HTTP',textBytes:Buffer.byteLength(first.content[0].text),returned:data.returned,limit:data.limit,total:data.total});
      expect(JSON.parse(first.content[0].text)).toEqual(data);expect(first.content).toHaveLength(1);
      expect(first.content[0].text).not.toMatch(/NEGATIVE_ONLY|CHARACTER_ONLY|\/synthetic\/never-read|legacyUnknown|charCaptions/);
      // The omission marker names payload, but no payload object may appear.
      expect(data.items.every((item:any)=>!Object.hasOwn(item,'payload'))).toBe(true);
      const all:string[]=[];let offset:any=0;
      do {
        const page=await invoke({action:'list',kinds:['history'],historyTags:['blue sky'],historyTagSources:['character'],limit:20,offset,sortBy:'name',sortDirection:'asc'});
        const body=page.details??page.structuredContent;expect(page.isError).not.toBe(true);
        expect(Buffer.byteLength(page.content[0].text)).toBeLessThanOrEqual(12288);
        measurements.push({route:'MCP filtered page',textBytes:Buffer.byteLength(page.content[0].text),offset,returned:body.returned,nextOffset:body.nextOffset});
        all.push(...body.items.map((item:any)=>item.id));
        for(const item of body.items){expect(item.matchedTags[0]).toMatchObject({tag:'blue sky',source:'character',characterIndex:0});expect(item.image.inspected).toBe(false);}
        offset=body.nextOffset;
      } while(offset!==null && all.length<=25);
      expect(new Set(all).size).toBe(25);expect(all).toHaveLength(25);
      const full=await invoke({action:'read',kind:'history',id:'h-00',revision:1,detail:'full'});
      const fullData=full.details??full.structuredContent;
      expect(fullData.item.payload).toEqual(original);expect(fullData.item.revision).toBe(1);
      expect(fullData.assets).toEqual((await service.asset_library({action:'read',kind:'history',id:'h-00',revision:1})).assets);
      expect(fullData.responseInfo.truncated).toBe(false);
      measurements.push({route:'MCP full',textBytes:Buffer.byteLength(full.content[0].text)});
      const summary=await invoke({action:'read',kind:'history',id:'h-00',revision:1});
      expect(Buffer.byteLength(summary.content[0].text)).toBeLessThanOrEqual(12288);
      expect((summary.details??summary.structuredContent).item.revision).toBe(1);
      const mixed=await invoke({action:'list',kinds:['artist_favorite','study','note']});
      expect((mixed.details??mixed.structuredContent).items).toHaveLength(3);
      expect(mixed.content[0].text).not.toMatch(/STUDY_RAW|RAW_ONLY|NOTE_FULL|NEGATIVE_ONLY|CHARACTER_ONLY/);
    }
    // Raw HTTP cannot evade public max or invoke desktop-only actions.
    for(const args of [{action:'list',limit:21},{action:'list',limit:100},{action:'thumbnail',kind:'history',id:'h-00',revision:1,assetId:'a'}])
      await expect(bridge.call('asset_library',args)).rejects.toMatchObject({code:'invalid_argument'});
    const desktop=await service.asset_library({action:'list',limit:100,kinds:['history']});
    expect(desktop.items).toHaveLength(25);expect(desktop.items[0].payload).toBeDefined();
    const desktopRead=await service.asset_library({action:'read',kind:'history',id:'h-00',revision:1});
    expect(desktopRead.item.payload).toEqual(original);expect(desktopRead.tags.length).toBeGreaterThan(6);
    expect(repo.getRevision()).toBe(revision);expect(repo.exportSnapshot()).toEqual(snapshot);expect(await dbHash()).toEqual(beforeFiles);
    expect(calls.every(call=>call.method==='asset_library')).toBe(true);
    if(process.env.ASSET_AI_MEASUREMENTS) await writeFile(process.env.ASSET_AI_MEASUREMENTS,JSON.stringify({measurements,libraryRevision:revision,databaseHashesUnchanged:true,versionsUnchanged:true,canvasCalls:0},null,2)+'\n');
  }
});
