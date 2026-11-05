// Root-owned regression: actual MCP adapter -> real existing host service -> isolated SQLite.
// Synthetic images only. No live bridge, workspace, credentials, or generation.
import { afterEach, expect, it, vi } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createMaterialLibraryService } from './material-library';
import { openLibraryRepository } from './library/repository';
// @ts-ignore JS MCP adapter is tested as executed code.
import { materialToolAction, materialToolResponse } from '../../src/material-tools.mjs';
const roots: string[] = [], repos: any[] = [];
afterEach(() => runCleanups([...repos.splice(0).map(repo => () => repo.close()), ...roots.splice(0).map(root => () => fs.rm(root,{recursive:true,force:true}))]));
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'root-cover-')); roots.push(root);
  const inbox=path.join(root,'inbox'); await fs.mkdir(inbox);
  const repository=openLibraryRepository({filePath:path.join(root,'library.sqlite'),libraryDirectory:root}); repos.push(repository);
  const forbidden=vi.fn(() => { throw new Error('Network must not be called'); });
  const service=createMaterialLibraryService({directory:root,repository,tags:{search:forbidden,details:forbidden},gallery:{search:forbidden,detail:forbidden,image:forbidden} as any});
  const entryInput={kind:'tag',name:'Root cover fixture',tag:{text:'root fixture lighting',source:'english',category:null,target:'style'}};
  const {entry}=await service.library({action:'save',entry:entryInput});
  const calls: any[]=[];
  const bridge={async call(method: string,args: any) { calls.push({method,action:args.action}); if(method==='material_samples') return service.samples(args); if(method==='material_library') return service.library(args); throw new Error(`Unexpected bridge method: ${method}`); }};
  const invoke=(args: any) => materialToolAction(args,{inbox,bridge});
  const request=(file: string,expectedCoverRevision=0,revision=1) => ({action:'set_local_cover',entryId:entry.id,revision,expectedCoverRevision,file});
  return {root,inbox,repository,forbidden,service,entry,entryInput,calls,bridge,invoke,request};
}
it('original missing action: the MCP adapter sets/replaces/reads/clears four real image formats without touching tag revision',async () => {
  const f=await fixture();
  const base=sharp({create:{width:37,height:19,channels:4,background:'#45a0bc'}});
  const images={png:await base.clone().png().toBuffer(),jpg:await base.clone().jpeg().toBuffer(),webp:await base.clone().webp().toBuffer(),gif:await base.clone().gif().toBuffer()};
  const before=(await f.service.library({action:'read',id:f.entry.id})).entry;
  let revision=0;
  for(const [ext,bytes] of Object.entries(images)) {
    const file=`主代理封面.${ext}`; await fs.writeFile(path.join(f.inbox,file),bytes);
    const saved=await f.invoke(f.request(file,revision)); revision++;
    expect(saved).toMatchObject({entryId:f.entry.id,entryRevision:1,coverRevision:revision,coverStatus:'ready',cover:{source:'local',fileName:file,sourceSha256:hash(bytes),rating:null,mimeType:'image/webp'}});
    expect(JSON.stringify(materialToolResponse(saved))).not.toContain(bytes.toString('base64'));
    const read=await f.invoke({action:'cover',entryId:f.entry.id});
    const response=materialToolResponse(read);
    expect(response.content[1].type).toBe('image'); expect(response.content[1].mimeType).toBe('image/webp');
    expect(response.content[0].text).not.toContain(read.data); expect(JSON.stringify(response.details)).not.toContain(read.data);
    expect(await sharp(Buffer.from(read.data,'base64')).metadata()).toMatchObject({format:'webp',width:37,height:19});
    expect(await fs.readFile(path.join(f.inbox,file))).toEqual(bytes);
  }
  const after=(await f.service.library({action:'read',id:f.entry.id})).entry;
  for(const key of Object.keys(before).filter(key=>!['coverRevision','cover','coverStatus'].includes(key))) expect(after[key]).toEqual(before[key]);
  expect(f.calls.filter(x=>x.action==='set_local_cover')).toHaveLength(4);
  expect(await f.invoke({action:'clear_cover',entryId:f.entry.id,expectedCoverRevision:4})).toMatchObject({entryRevision:1,coverRevision:5,coverStatus:'none'});
  expect(f.forbidden).not.toHaveBeenCalled();
});
it('real host rejects corrupt images and stale CAS, preserving saved cover; adapter never retries',async () => {
  const f=await fixture(); const bytes=await sharp({create:{width:16,height:8,channels:3,background:'#abcdef'}}).png().toBuffer();
  await fs.writeFile(path.join(f.inbox,'cover.png'),bytes); const saved=await f.invoke(f.request('cover.png'));
  await expect(f.invoke(f.request('cover.png'))).rejects.toMatchObject({code:'cover_conflict'});
  await fs.writeFile(path.join(f.inbox,'broken.png'),'not a PNG');
  await expect(f.invoke(f.request('broken.png',1))).rejects.toMatchObject({code:'cover_invalid_image'});
  expect((await f.invoke({action:'cover',entryId:f.entry.id})).cover.sha256).toBe(saved.cover.sha256);
  await f.service.library({action:'save',id:f.entry.id,expectedRevision:1,entry:{...f.entryInput,notes:'manual fixture edit'}});
  await expect(f.invoke(f.request('cover.png',1,1))).rejects.toMatchObject({code:'material_conflict'});
  const read=(await f.service.library({action:'read',id:f.entry.id})).entry;
  expect(read).toMatchObject({revision:2,coverRevision:1,cover:{sha256:saved.cover.sha256}});
  expect(f.calls.filter(x=>x.action==='set_local_cover')).toHaveLength(4); expect(f.forbidden).not.toHaveBeenCalled();
});
it('lost acknowledgement saves once; explicit read reconciles without a mutation retry',async () => {
  const f=await fixture(); const bytes=await sharp({create:{width:12,height:6,channels:3,background:'#119977'}}).png().toBuffer();
  await fs.writeFile(path.join(f.inbox,'cover.png'),bytes); let writes=0;
  const uncertainBridge={async call(method: string,args: any) { if(method==='material_samples'&&args.action==='set_local_cover'){writes++;await f.service.samples(args);throw Object.assign(new Error('Synthetic lost acknowledgement'),{code:'timeout'});} return f.bridge.call(method,args); }};
  await expect(materialToolAction(f.request('cover.png'),{inbox:f.inbox,bridge:uncertainBridge})).rejects.toMatchObject({code:'timeout'});
  expect(writes).toBe(1);
  const read=await f.invoke({action:'read',id:f.entry.id});
  expect(read.entry).toMatchObject({revision:1,coverRevision:1,cover:{sourceSha256:hash(bytes)}});
  expect(f.forbidden).not.toHaveBeenCalled();
});
