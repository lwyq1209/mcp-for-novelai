import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { openLibraryRepository } from './library/repository';
import { createAssetLibraryService } from './asset-library-service';
import { startHttpBridge } from './bridge-server';
import { HISTORY_IMAGE_LIMITS } from './asset-library-image';
import { runCleanups, type Cleanup } from '../src/test-support/temp-dirs';
const hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const assetId=(file:string)=>'path:'+hash(Buffer.from(file));
// Registered as soon as each resource exists, so a fixture or test that throws, times out or is retried leaves nothing behind.
const cleanups:Cleanup[]=[];
afterEach(()=>runCleanups(cleanups.splice(0).reverse()));
async function fixture() {
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nai-history-image-')));cleanups.push(()=>fs.rm(directory,{recursive:true,force:true}));
  const repo=openLibraryRepository({filePath:path.join(directory,'library.sqlite')});cleanups.push(()=>repo.close());
  const service=createAssetLibraryService({repository:repo});
  const png=await sharp({create:{width:800,height:400,channels:3,background:'#77bce6'}}).composite([
    {input:await sharp({create:{width:800,height:100,channels:3,background:'#71975c'}}).png().toBuffer(),left:0,top:300},
    {input:await sharp({create:{width:180,height:140,channels:3,background:'#d9ba81'}}).png().toBuffer(),left:300,top:160},
  ]).png().toBuffer();
  const file=path.join(directory,'landscape.png');await fs.writeFile(file,png);
  const put=(id:string,filePath:string,extra:Record<string,unknown>={})=>repo.put('history',id,{id,filePath,date:'2026-09-20',params:{positivePrompt:'synthetic SFW landscape'},...extra});
  const target=(id:string,filePath=file,revision=1)=>({action:'image',kind:'history',id,revision,assetId:assetId(filePath)});
  const cleanup=async()=>{vi.restoreAllMocks();repo.close();await fs.rm(directory,{recursive:true,force:true});};
  return {directory,repo,service,png,file,put,target,cleanup};
}

it('actual MCP uses own HTTP → SQLite → safe file reader; exact old original and native-only thumbnail, no canvas/job',async()=>{
  const f=await fixture();const root=fileURLToPath(new URL('../../',import.meta.url));
  const load=(name:string)=>import(/* @vite-ignore */ new URL(name,import.meta.url).href);
  const {createNovelAiMcpServer,createBridgeClient}=await load('../../src/mcp.mjs');
  const {Client}=await load('../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const {InMemoryTransport}=await load('../../node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js');
  const calls:any[]=[];let host:any,server:any,client:any;
  try {
    f.put('manual',f.file,{sha256:hash(f.png),mimeType:'image/png',byteLength:f.png.length});
    const oldList=await f.service.asset_library({action:'list',kinds:['history']});
    const oldAsset=oldList.items[0].preview.assetId;
    const second=path.join(f.directory,'second.png');const secondBytes=await sharp({create:{width:120,height:240,channels:3,background:'#eb9782'}}).png().toBuffer();await fs.writeFile(second,secondBytes);
    f.repo.put('history','manual',{id:'manual',filePath:second,params:{positivePrompt:'version 2'},sha256:hash(secondBytes)},{expectedRevision:1});
    f.put('other',f.file);f.repo.put('history','no-image',{id:'no-image',params:{positivePrompt:'no saved file'}});
    const baseline=f.repo.exportSnapshot(),revision=f.repo.getRevision();
    const fileHashes=async()=>Promise.all(['library.sqlite','library.sqlite-wal','library.sqlite-shm'].map(name=>fs.readFile(path.join(f.directory,name)).then(hash,()=>null)));
    const before=await fileHashes();
    host=await startHttpBridge({runtimeDir:path.join(f.directory,'bridge'),dispatch:async(method,args)=>{calls.push({method,args});expect(method).toBe('asset_library');return f.service.asset_library(args);}});
    const bridge=createBridgeClient({runtimeDir:path.join(f.directory,'bridge')});
    server=createNovelAiMcpServer({ wholeResults: true, bridgeClient:bridge});client=new Client({name:'native-history-test',version:'1'});
    const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
    const execute=[(args:any)=>client.callTool({name:'asset_library',arguments:args})];
    const measurements:any[]=[];
    for(const [index,invoke] of execute.entries()) {
      const list=await invoke({action:'list',kinds:['history']});const rows=(list.details??list.structuredContent).items;
      expect(list.content).toHaveLength(1);const selected=rows.find((item:any)=>item.id==='manual');
      expect(rows.find((item:any)=>item.id==='no-image').image.descriptionPresent).toBe(false);
      const target={action:'image',kind:selected.kind,id:selected.id,revision:selected.revision,assetId:selected.image.preview.assetId};
      const current=await invoke(target);expect(current.isError).not.toBe(true);expect(current.content[1].type).toBe('image');
      expect((current.details??current.structuredContent)).toMatchObject({revision:2,sourceWidth:120,sourceHeight:240,width:120,height:240,variant:'thumbnail',contentBinding:'recorded-sha256'});
      for(const variant of ['thumbnail','original']) {
        const request={...f.target('manual'),assetId:oldAsset,variant};
        const result=await invoke(request);expect(result.isError).not.toBe(true);expect(result.content).toHaveLength(2);
        const [text,image]=result.content;const metadata=result.details??result.structuredContent;
        expect(text.type).toBe('text');expect(image.type).toBe('image');expect(metadata).toEqual(JSON.parse(text.text));
        expect(metadata).toMatchObject({id:'manual',revision:1,assetId:oldAsset,variant,role:'original',sourceWidth:800,sourceHeight:400,imageAttached:true});
        expect(text.text).not.toContain(image.data);expect(JSON.stringify(metadata)).not.toMatch(/dataUrl|base64|filePath|landscape\.png/);expect(metadata.data).toBeUndefined();expect(Buffer.byteLength(text.text)).toBeLessThan(2048);
        const bytes=Buffer.from(image.data,'base64');const decoded=await sharp(bytes).metadata();
        expect(metadata.width).toBe(decoded.width);expect(metadata.height).toBe(decoded.height);
        if(variant==='original'){expect(bytes).toEqual(f.png);expect(metadata.mimeType).toBe('image/png');expect(metadata.transformed).toBe(false);}
        else {expect(decoded.width).toBe(384);expect(decoded.height).toBe(192);expect(metadata.mimeType).toBe('image/webp');expect(metadata.transformed).toBe(true);}
        measurements.push({route:'MCP handler',variant,textBytes:Buffer.byteLength(text.text),imageBytes:bytes.length,width:metadata.width,height:metadata.height,sha256:hash(bytes)});
        if(process.env.ASSET_IMAGE_ARTIFACTS){await fs.mkdir(process.env.ASSET_IMAGE_ARTIFACTS,{recursive:true});await fs.writeFile(path.join(process.env.ASSET_IMAGE_ARTIFACTS,`${index}-${variant}.${variant==='original'?'png':'webp'}`),bytes);}
      }
    }
    // Actual HTTP boundary, including attempts to reuse a current asset for an old version.
    for(const [args,code] of [
      [{...f.target('manual'),assetId:assetId(second)},'library_conflict'],
      [f.target('other',second),'library_conflict'],
      [f.target('manual',f.file,999),'library_not_found'],
      [f.target('no-image'),'image_unavailable'],
      [{...f.target('manual'),filePath:f.file},'invalid_argument'],
      [{...f.target('manual'),kind:'study'},'invalid_argument'],
      [{...f.target('manual'),variant:'preview'},'invalid_argument'],
      [{action:'thumbnail',kind:'history',id:'manual',revision:1,assetId:oldAsset},'invalid_argument'],
      [{...f.target('manual'),revision:undefined},'invalid_argument'],
    ] as const) await expect(bridge.call('asset_library',args)).rejects.toMatchObject({code});
    expect(f.repo.getRevision()).toBe(revision);expect(f.repo.exportSnapshot()).toEqual(baseline);expect(await fileHashes()).toEqual(before);
    expect(await fs.readFile(f.file)).toEqual(f.png);expect(calls.every(call=>call.method==='asset_library')).toBe(true);
    if(process.env.ASSET_IMAGE_ARTIFACTS) await fs.writeFile(path.join(process.env.ASSET_IMAGE_ARTIFACTS,'measurements.json'),JSON.stringify({measurements,libraryRevision:revision,unchangedDatabase:true,canvasCalls:0,generationOriginRequired:false},null,2));
  } finally {await client?.close();await server?.close();await host?.close();await f.cleanup();}
});

it('registered files: missing, directory, symlink (leaf/ancestor), bogus/claimed MIME, SVG, size, pixels and corrupt compressed bytes fail closed',async()=>{
  const f=await fixture();
  try {
    f.put('network','//remote.invalid/history.png');await expect(f.service.asset_library(f.target('network','//remote.invalid/history.png'))).rejects.toMatchObject({code:'invalid_image'});
    const missing=path.join(f.directory,'missing.png');f.put('missing',missing);
    await expect(f.service.asset_library(f.target('missing',missing))).rejects.toMatchObject({code:'image_unavailable'});
    f.put('directory',f.directory);await expect(f.service.asset_library(f.target('directory',f.directory))).rejects.toMatchObject({code:'invalid_image'});
    const link=path.join(f.directory,'link.png');await fs.symlink(f.file,link);f.put('symlink',link);await expect(f.service.asset_library(f.target('symlink',link))).rejects.toMatchObject({code:'invalid_image'});
    const linkDir=path.join(f.directory,'link-dir');await fs.symlink(f.directory,linkDir);const alias=path.join(linkDir,'landscape.png');f.put('alias',alias);await expect(f.service.asset_library(f.target('alias',alias))).rejects.toMatchObject({code:'invalid_image'});
    const bogus=path.join(f.directory,'bogus.png');await fs.writeFile(bogus,'Not a PNG');f.put('bogus',bogus,{mimeType:'image/png'});await expect(f.service.asset_library(f.target('bogus',bogus))).rejects.toMatchObject({code:'unsupported_image'});
    f.put('mime',f.file,{mimeType:'image/jpeg'});await expect(f.service.asset_library(f.target('mime'))).rejects.toMatchObject({code:'invalid_image'});
    const svg=path.join(f.directory,'vector.svg');await fs.writeFile(svg,'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>');f.put('svg',svg);await expect(f.service.asset_library(f.target('svg',svg))).rejects.toMatchObject({code:'unsupported_image'});
    const huge=path.join(f.directory,'huge.png');const h=await fs.open(huge,'w');await h.truncate(HISTORY_IMAGE_LIMITS.bytes+1);await h.close();f.put('huge',huge);await expect(f.service.asset_library(f.target('huge',huge))).rejects.toMatchObject({code:'image_too_large'});
    const pixel=path.join(f.directory,'pixels.png');await sharp({create:{width:6000,height:6000,channels:3,background:'#eee'}}).png().toFile(pixel);f.put('pixels',pixel);await expect(f.service.asset_library(f.target('pixels',pixel))).rejects.toMatchObject({code:expect.stringMatching(/^(invalid_image|image_too_large)$/)});
    const corrupt=path.join(f.directory,'corrupt.png');await fs.writeFile(corrupt,f.png.subarray(0,60));f.put('corrupt',corrupt);await expect(f.service.asset_library(f.target('corrupt',corrupt))).rejects.toMatchObject({code:'invalid_image'});
    expect(f.repo.get('history','missing')).not.toBeNull();expect(f.repo.get('history','pixels')).not.toBeNull();
  } finally {await f.cleanup();}
});

it('byte snapshot and record hash refuse replaced/changed files; path locator alone cannot borrow another registered image',async()=>{
  const f=await fixture();
  try {
    f.put('hash',f.file,{sha256:'0'.repeat(64)});await expect(f.service.asset_library(f.target('hash'))).rejects.toMatchObject({code:'image_changed'});
    f.put('byte-size',f.file,{byteLength:f.png.length+1});await expect(f.service.asset_library(f.target('byte-size'))).rejects.toMatchObject({code:'image_changed'});
    f.put('read-race',f.file);const open=fs.open.bind(fs);let changed=false;
    vi.spyOn(fs,'open').mockImplementation(async(...args:any[])=>{
      const handle=await (open as any)(...args);
      if(args[0]===f.file){const read=handle.read.bind(handle);handle.read=async(...readArgs:any[])=>{const result=await read(...readArgs);if(!changed){changed=true;await fs.appendFile(f.file,'changed');}return result;};}
      return handle;
    });
    await expect(f.service.asset_library(f.target('read-race'))).rejects.toMatchObject({code:'image_changed'});
    expect(changed).toBe(true);vi.restoreAllMocks();
    await fs.writeFile(f.file,f.png);f.put('end-race',f.file);const lstat=fs.lstat.bind(fs);let count=0;
    vi.spyOn(fs,'lstat').mockImplementation(async(...args:any[])=>{
      if(args[0]===f.file && ++count===3)await fs.appendFile(f.file,'changed after decode');
      return (lstat as any)(...args);
    });
    await expect(f.service.asset_library({...f.target('end-race'),variant:'original'})).rejects.toMatchObject({code:'image_changed'});
  } finally {await f.cleanup();}
});

it('animations are explicitly unsupported, while static JPEG/WebP/GIF originals retain exact bytes and detected MIME',async()=>{
  const f=await fixture();
  try {
    const inputs:Record<string,Buffer>={jpeg:await sharp(f.png).jpeg().toBuffer(),webp:await sharp(f.png).webp().toBuffer(),gif:await sharp(f.png).gif().toBuffer()};
    for(const [format,bytes] of Object.entries(inputs)) {
      // Deliberately wrong suffix; the signature, not extension, owns MIME.
      const file=path.join(f.directory,format+'.png');await fs.writeFile(file,bytes);f.put(format,file);
      const result=await f.service.asset_library({...f.target(format,file),variant:'original'});
      expect(result.mimeType).toBe('image/'+format);expect(Buffer.from(result.data,'base64')).toEqual(bytes);expect(result.contentBinding).toBe('read-time-sha256');
    }
    const frames=Buffer.alloc(8*16*3);
    for(let pixel=0;pixel<8*16;pixel++)frames[pixel*3+(pixel<64?0:2)]=255;
    const animated=await sharp(frames,{raw:{width:8,height:16,channels:3,pageHeight:8}}).gif({delay:[100,100]}).toBuffer();
    expect((await sharp(animated,{animated:true}).metadata()).pages).toBe(2);
    const file=path.join(f.directory,'animated.gif');await fs.writeFile(file,animated);f.put('animation',file);
    for(const variant of ['thumbnail','original']) await expect(f.service.asset_library({...f.target('animation',file),variant})).rejects.toMatchObject({code:'unsupported_image'});
    const webp=await sharp(frames,{raw:{width:8,height:16,channels:3,pageHeight:8}}).webp({delay:[100,100]}).toBuffer();
    expect((await sharp(webp,{animated:true}).metadata()).pages).toBe(2);
    const webpFile=path.join(f.directory,'animated.webp');await fs.writeFile(webpFile,webp);f.put('webp-animation',webpFile);
    await expect(f.service.asset_library(f.target('webp-animation',webpFile))).rejects.toMatchObject({code:'unsupported_image'});
  } finally {await f.cleanup();}
});

it('end-of-read rechecks version authority, and changed original content cannot reuse a saved SHA',async()=>{
  const f=await fixture();
  try {
    f.put('replaced',f.file,{sha256:hash(f.png)});
    await fs.writeFile(f.file,await sharp({create:{width:800,height:400,channels:3,background:'#f00'}}).png().toBuffer());
    await expect(f.service.asset_library(f.target('replaced'))).rejects.toMatchObject({code:'image_changed'});
    await fs.writeFile(f.file,f.png);f.put('removed',f.file);
    const lstat=fs.lstat.bind(fs);let count=0;
    vi.spyOn(fs,'lstat').mockImplementation(async(...args:any[])=>{
      if(args[0]===f.file && ++count===3)f.repo.remove('history','removed');
      return (lstat as any)(...args);
    });
    await expect(f.service.asset_library(f.target('removed'))).rejects.toMatchObject({code:'library_not_found'});
  } finally {await f.cleanup();}
});

it('bounded admission has no unbounded pending queue and returns slots after file failures',async()=>{
  const f=await fixture();
  try {
    f.put('manual',f.file);const promises=[f.service.asset_library(f.target('manual')),f.service.asset_library(f.target('manual'))];
    await expect(f.service.asset_library(f.target('manual'))).rejects.toMatchObject({code:'image_busy'});
    await Promise.all(promises);
    await expect(f.service.asset_library(f.target('manual'))).resolves.toMatchObject({variant:'thumbnail'});
    f.put('missing',path.join(f.directory,'absent.png'));
    for(let i=0;i<3;i++)await expect(f.service.asset_library(f.target('missing',path.join(f.directory,'absent.png')))).rejects.toMatchObject({code:'image_unavailable'});
    await expect(f.service.asset_library(f.target('manual'))).resolves.toMatchObject({variant:'thumbnail'});
  } finally {await f.cleanup();}
});
