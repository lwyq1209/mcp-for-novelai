import { afterEach, describe, expect, it } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { openLibraryRepository, type LibraryRepository } from './library/repository';
import { beginLibraryFileOperation, fileReferencedElsewhere, recoverLibraryFileOperations } from './library-file-operations';

const roots: string[] = [], repositories: LibraryRepository[] = [];
const stamp = '2026-09-12T00:00:00.000Z';
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-file-recovery-')); roots.push(root);
  const databasePath = path.join(root, 'library.sqlite'), target = path.join(root, 'teacup.png'), bytes = Buffer.from('SFW teacup file fixture');
  const repo = openLibraryRepository({ filePath: databasePath }); repositories.push(repo);
  const item = { id: 'history-1', filePath: target, fileUrl: 'file:///fixture/teacup.png', date: '2026-09-12', createdAt: stamp, params: { positivePrompt: 'teacup' }, actualSeed: 7, model: 'nai-diffusion-5-full', width: 16, height: 16 };
  return { root, repo, databasePath, target, bytes, item };
}
afterEach(() => runCleanups([...repositories.splice(0).map(repo=>()=>repo.close()), ...roots.splice(0).map(root=>()=>fs.rm(root,{recursive:true,force:true}))]));

describe('library file operation recovery', () => {
  it('recovers a file saved before a crash without writing another copy or duplicating a published item', async () => {
    const f=await setup();
    beginLibraryFileOperation(f.repo,'create',{kind:'history',id:f.item.id,item:f.item,target:f.target,byteLength:f.bytes.length,sha256:sha(f.bytes)});
    await fs.writeFile(f.target,f.bytes); f.repo.close();
    const restarted=openLibraryRepository({filePath:f.databasePath});repositories.push(restarted);
    await recoverLibraryFileOperations(restarted);
    expect(restarted.get('history',f.item.id)?.payload).toEqual(f.item);expect(restarted.pendingFileOps()).toEqual([]);
    beginLibraryFileOperation(restarted,'create',{kind:'history',id:f.item.id,item:f.item,target:f.target,byteLength:f.bytes.length,sha256:sha(f.bytes)});
    await recoverLibraryFileOperations(restarted);
    expect(restarted.get('history',f.item.id)?.revision).toBe(1);expect(await fs.readFile(f.target)).toEqual(f.bytes);
  });

  it.each(['digest','missing'] as const)('retains a failed %s create journal and never publishes invalid image metadata',async failure=>{
    const f=await setup();
    if(failure==='digest')await fs.writeFile(f.target,f.bytes);
    beginLibraryFileOperation(f.repo,'create',{kind:'history',id:f.item.id,item:f.item,target:f.target,byteLength:f.bytes.length,sha256:'0'.repeat(64)});
    await recoverLibraryFileOperations(f.repo);
    expect(f.repo.get('history',f.item.id)).toBeNull();expect(f.repo.pendingFileOps()[0].state).toBe('failed');
    const before=f.repo.getRevision();await recoverLibraryFileOperations(f.repo);expect(f.repo.getRevision()).toBe(before);
  });

  it('updates only the journaled expected version and preserves a later edit',async()=>{
    const f=await setup();await fs.writeFile(f.target,f.bytes);f.repo.put('history',f.item.id,f.item);
    const update={...f.item,params:{positivePrompt:'blue teacup'}};
    beginLibraryFileOperation(f.repo,'create',{kind:'history',id:f.item.id,item:update,expectedRevision:1,target:f.target,byteLength:f.bytes.length,sha256:sha(f.bytes)});
    await recoverLibraryFileOperations(f.repo);expect(f.repo.get('history',f.item.id)?.payload).toEqual(update);
    beginLibraryFileOperation(f.repo,'create',{kind:'history',id:f.item.id,item:f.item,expectedRevision:1,target:f.target,byteLength:f.bytes.length,sha256:sha(f.bytes)});
    await recoverLibraryFileOperations(f.repo);expect(f.repo.get('history',f.item.id)?.payload).toEqual(update);expect(f.repo.pendingFileOps()[0].state).toBe('failed');
  });

  it('distinguishes rename not executed, completed, and both paths missing',async()=>{
    const f=await setup(),target=path.join(f.root,'renamed.png');f.repo.put('history',f.item.id,f.item);
    await fs.writeFile(f.target,f.bytes);
    const journal=()=>beginLibraryFileOperation(f.repo,'rename',{kind:'history',id:f.item.id,original:f.target,target,fileUrl:'file:///fixture/renamed.png'});
    journal();await recoverLibraryFileOperations(f.repo);expect(f.repo.get('history',f.item.id)?.payload.filePath).toBe(f.target);expect(f.repo.pendingFileOps()).toEqual([]);
    journal();await fs.rename(f.target,target);await recoverLibraryFileOperations(f.repo);expect(f.repo.get('history',f.item.id)?.payload.filePath).toBe(target);expect(f.repo.pendingFileOps()).toEqual([]);
    journal();await fs.unlink(target);await recoverLibraryFileOperations(f.repo);expect(f.repo.pendingFileOps()[0].state).toBe('failed');expect(f.repo.get('history',f.item.id)?.payload.filePath).toBe(target);
  });

  it('protects shared paths and provenance from deletion even when the original file is missing',async()=>{
    const f=await setup();f.repo.put('history',f.item.id,f.item);
    f.repo.put('artist_favorite','random:fav',{id:'fav',collection:'random',image:f.item});
    expect(fileReferencedElsewhere(f.repo,'history',f.item.id,f.target)).toBe(true);
    beginLibraryFileOperation(f.repo,'delete',{kind:'history',id:f.item.id,original:f.target});
    await recoverLibraryFileOperations(f.repo);expect(f.repo.get('history',f.item.id)).not.toBeNull();expect(f.repo.pendingFileOps()[0].state).toBe('failed');
    f.repo.remove('artist_favorite','random:fav');expect(fileReferencedElsewhere(f.repo,'history',f.item.id,f.target)).toBe(false);
    beginLibraryFileOperation(f.repo,'delete',{kind:'history',id:f.item.id,original:f.target});await recoverLibraryFileOperations(f.repo);expect(f.repo.get('history',f.item.id)).toBeNull();
  });

  it('does not execute an interrupted delete against a surviving file',async()=>{
    const f=await setup();await fs.writeFile(f.target,f.bytes);f.repo.put('history',f.item.id,f.item);
    beginLibraryFileOperation(f.repo,'delete',{kind:'history',id:f.item.id,original:f.target});await recoverLibraryFileOperations(f.repo);
    expect(await fs.readFile(f.target)).toEqual(f.bytes);expect(f.repo.get('history',f.item.id)).not.toBeNull();expect(f.repo.pendingFileOps()).toEqual([]);
  });

  it.each([false,true])('publishes a study only after both journaled files verify (corrupt preview: %s)',async corrupt=>{
    const f=await setup(),id='55555555-5555-4555-8555-555555555555',folder=path.join(f.root,'studies',id),preview=Buffer.from('SFW small preview');
    await fs.mkdir(folder,{recursive:true});
    const originalPath=path.join(folder,'original.png'),previewPath=path.join(folder,'preview.webp');
    await fs.writeFile(originalPath,f.bytes);await fs.writeFile(previewPath,corrupt?Buffer.alloc(preview.length):preview);
    const item={schemaVersion:1,parserVersion:1,study:{id,revision:1,name:'Cup study',sha256:sha(f.bytes),mimeType:'image/png',width:16,height:16,byteLength:f.bytes.length,sourceUrl:'',sourceAuthor:'',createdAt:stamp,updatedAt:stamp,archived:false,metadataStatus:'missing',metadataKind:'unknown',sources:[],warnings:[],promptFieldCount:0,parameterFieldCount:0},notes:'',previewSha256:sha(preview),previewByteLength:preview.length,sections:{prompts:[],parameters:[],raw:{}}};
    beginLibraryFileOperation(f.repo,'create',{kind:'study',id,item,files:[{target:originalPath,byteLength:f.bytes.length,sha256:sha(f.bytes)},{target:previewPath,byteLength:preview.length,sha256:sha(preview)}]});
    await recoverLibraryFileOperations(f.repo);
    if(corrupt){expect(f.repo.get('study',id)).toBeNull();expect(f.repo.pendingFileOps()[0].state).toBe('failed');}
    else{expect(f.repo.get('study',id)?.payload).toEqual(item);expect(f.repo.pendingFileOps()).toEqual([]);}
    expect(await fs.readFile(originalPath)).toEqual(f.bytes);
  });
});
