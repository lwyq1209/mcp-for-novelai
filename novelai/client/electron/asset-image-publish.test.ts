import { afterEach, expect, it, vi } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { createPrivateExportStage } from './asset-image-publish';
import { plain } from './asset-image-export-fixtures';
const roots:string[]=[];
afterEach(()=>runCleanups([()=>vi.restoreAllMocks(),...roots.splice(0).map(root=>()=>fs.rm(root,{recursive:true,force:true}))]));
async function fixture() {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'private-publish-')));roots.push(root);
  const stage=await createPrivateExportStage(root),target=path.join(root,'out.zip');
  const zip=new JSZip();zip.file('fixture.png',await plain());const bytes=await zip.generateAsync({type:'nodebuffer'});
  await stage.handle.writeFile(bytes);await stage.handle.sync();
  const expected={size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  return {root,stage,target,bytes,publish:()=>stage.publish(target,expected)};
}
it('uses private permissions, keeps the written descriptor pinned, verifies actual published bytes and cleans stage',async()=>{
  const {root,stage,target,bytes,publish}=await fixture();const [folder]=await fs.readdir(root);if(process.platform!=='win32'){expect((await fs.stat(path.join(root,folder))).mode&0o777).toBe(0o700);expect((await stage.handle.stat()).mode&0o777).toBe(0o600);} // win32 reports no POSIX permission bits.
  await publish();expect(await fs.readFile(target)).toEqual(bytes);expect((await stage.handle.stat()).ino).toBe((await fs.stat(target)).ino);await stage.cleanup();expect(await fs.readdir(root)).toEqual(['out.zip']);
});
it.each(['replace','in-place'] as const)('rejects %s at the fs.link gap and removes its own unverified published object',async(kind)=>{
  const {root,stage,target,bytes,publish}=await fixture();const link=fs.link.bind(fs);let once=false;
  vi.spyOn(fs,'link').mockImplementation(async(a,b)=>{if(!once){once=true;if(kind==='replace')await fs.unlink(a);await fs.writeFile(a,Buffer.alloc(bytes.length,65));}return link(a,b);});
  await expect(publish()).rejects.toMatchObject({reason:'verification'});await expect(fs.lstat(target)).rejects.toMatchObject({code:'ENOENT'});await stage.cleanup();expect(await fs.readdir(root)).toEqual([]);
});
it('does not delete a different process destination replacement after fs.link returns',async()=>{
  const {stage,target,publish}=await fixture(),foreign=Buffer.from('FOREIGN_TARGET_KEEP');const link=fs.link.bind(fs);
  vi.spyOn(fs,'link').mockImplementation(async(a,b)=>{await link(a,b);await fs.unlink(b);await fs.writeFile(b,foreign);});
  await expect(publish()).rejects.toMatchObject({reason:'verification'});expect(await fs.readFile(target)).toEqual(foreign);await stage.cleanup();expect(await fs.readFile(target)).toEqual(foreign);
});
it.each([false,true])('preserves a different inode swapped in the rollback rename gap (restore occupied=%s)',async(occupied)=>{
  const {root,stage,target,publish}=await fixture(),foreign=Buffer.from('FOREIGN_CAPTURE_KEEP'),newer=Buffer.from('NEWER_TARGET_KEEP');
  const link=fs.link.bind(fs),rename=fs.rename.bind(fs);let once=false;
  vi.spyOn(fs,'link').mockImplementation(async(a,b)=>{if(!once){once=true;await fs.unlink(a);await fs.writeFile(a,'NOT_ZIP');}return link(a,b);});
  vi.spyOn(fs,'rename').mockImplementation(async(a,b)=>{await fs.unlink(a);await fs.writeFile(a,foreign);await rename(a,b);if(occupied)await fs.writeFile(a,newer);});
  await expect(publish()).rejects.toMatchObject({reason:'verification'});await stage.cleanup();expect(await fs.readFile(target)).toEqual(occupied?newer:foreign);
  if(occupied){const directory=(await fs.readdir(root)).find(name=>name.startsWith('.image-export-'))!;const files=await fs.readdir(path.join(root,directory));expect(files).toHaveLength(1);expect(files[0]).toMatch(/^rollback-/);expect(await fs.readFile(path.join(root,directory,files[0]))).toEqual(foreign);}
  else expect(await fs.readdir(root)).toEqual(['out.zip']);
});
it('checks the destination path again after hashing its pinned descriptor and preserves a later replacement',async()=>{
  const {stage,target,publish}=await fixture(),foreign=Buffer.from('REPLACED_DURING_HASH');const open=fs.open.bind(fs);let replaced=false;
  vi.spyOn(fs,'open').mockImplementation(async(name:any,flags:any,mode:any)=>{const handle=await open(name,flags,mode);if(name===target){const read=handle.read.bind(handle);vi.spyOn(handle,'read').mockImplementation(async(...args:any[])=>{if(!replaced){replaced=true;await fs.unlink(target);await fs.writeFile(target,foreign);}return (read as any)(...args);});}return handle;});
  await expect(publish()).rejects.toMatchObject({reason:'verification'});await stage.cleanup();expect(await fs.readFile(target)).toEqual(foreign);
});
it('retains no-clobber semantics even when target exists at publication',async()=>{
  const {stage,target,publish}=await fixture();await fs.writeFile(target,'keep');await expect(publish()).rejects.toMatchObject({reason:'destination_exists'});await stage.cleanup();expect(await fs.readFile(target,'utf8')).toBe('keep');
});
it('checks the captured library selection again after publication verification and rolls back a late conflict',async()=>{
  const {stage,target,bytes}=await fixture();let checks=0;
  const expected={size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  await expect(stage.publish(target,expected,()=>{if(++checks===2)throw new Error('selection changed');})).rejects.toThrow('selection changed');
  expect(checks).toBe(2);await expect(fs.stat(target)).rejects.toMatchObject({code:'ENOENT'});await stage.cleanup();
});
