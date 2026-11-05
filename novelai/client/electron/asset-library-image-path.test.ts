import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { openLibraryRepository } from './library/repository';
import { createAssetLibraryService } from './asset-library-service';
import { runCleanups, type Cleanup } from '../src/test-support/temp-dirs';

// Each resource is registered as soon as it exists and released in reverse order after the test, also when
// setup or the test fails, times out or is retried; one failing close does not skip the others.
const cleanups:Cleanup[]=[];
afterEach(()=>runCleanups(cleanups.splice(0).reverse()));

async function setup() {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'image-path-guard-')));cleanups.push(()=>fs.rm(root,{recursive:true,force:true}));
  const repo=openLibraryRepository({filePath:path.join(root,'library.sqlite')});cleanups.push(()=>repo.close());
  const a=path.join(root,'a'),b=path.join(root,'b');await fs.mkdir(a);await fs.mkdir(path.join(b,'sub'),{recursive:true});
  const red=await sharp({create:{width:18,height:12,channels:3,background:'red'}}).png().toBuffer();
  const blue=await sharp({create:{width:18,height:12,channels:3,background:'blue'}}).png().toBuffer();
  await fs.writeFile(path.join(a,'image.png'),red);await fs.writeFile(path.join(b,'image.png'),blue);await fs.writeFile(path.join(b,'sub','image.png'),blue);
  await fs.symlink(path.join(b,'sub'),path.join(a,'link'),'dir');
  const register=(id:string,filePath:string)=>{
    const item=repo.put('history',id,{filePath,params:{positivePrompt:'SFW fixture'}});
    const asset=repo.versionAssets(item)[0];expect(asset.payload.filePath).toBe(filePath);
    return {action:'image',kind:'history',id,revision:item.revision,assetId:asset.id,variant:'original'};
  };
  const service=createAssetLibraryService({repository:repo});
  return {root,repo,a,b,red,blue,register,call:service.asset_library,close:async()=>{vi.restoreAllMocks();repo.close();await fs.rm(root,{recursive:true,force:true});}};
}

it('Root counter: an unhashed symlink/../ locator must not return the normalized-path red picture instead of blue',async()=>{
  const f=await setup();
  try {
    const locator=`${f.a}/link/../image.png`;
    expect(await fs.readFile(locator)).toEqual(f.blue);
    const request=f.register('path-counter',locator);const revision=f.repo.getRevision();
    let error:any,result:any;try{result=await f.call(request);}catch(e){error=e;}
    const returned=result?.data?Buffer.from(result.data,'base64'):undefined;
    if(process.env.IMAGE_PATH_REPORT)await fs.writeFile(process.env.IMAGE_PATH_REPORT,JSON.stringify({
      originalFilesystemReadSha256:createHash('sha256').update(f.blue).digest('hex'),
      collapsedWrongPictureSha256:createHash('sha256').update(f.red).digest('hex'),
      returnedSha256:returned?createHash('sha256').update(returned).digest('hex'):null,
      returnedWrongImage:returned?.equals(f.red)??false,rejected:!!error,errorCode:error?.code??null,
    },null,2));
    expect(error?.code).toBe('invalid_image');expect(result).toBeUndefined();expect(f.repo.getRevision()).toBe(revision);
  } finally {await f.close();}
});

it('raw noncanonical components are refused before realpath/stat/open/read or normalization, even without SHA',async()=>{
  const f=await setup();
  try {
    const locators=[`${f.a}/link/../image.png`,`${f.a}/./image.png`,`${f.a}//image.png`,`${f.a}/absent/../image.png`,`${f.a}/image.png/`,`${f.a}/image.png//`];
    const requests=locators.map((locator,index)=>f.register('alias-'+index,locator));
    const before=f.repo.exportSnapshot();
    const calls=[vi.spyOn(fs,'realpath'),vi.spyOn(fs,'lstat'),vi.spyOn(fs,'stat'),vi.spyOn(fs,'open'),vi.spyOn(fs,'readFile'),vi.spyOn(fs,'access')];
    for(const spy of calls)spy.mockImplementation((()=>{throw new Error('FORBIDDEN_FS_FOR_NONCANONICAL_LOCATOR');}) as any);
    const normalize=vi.spyOn(path,'normalize'),resolve=vi.spyOn(path,'resolve');
    for(const request of requests)await expect(f.call(request)).rejects.toMatchObject({code:'invalid_image'});
    for(const spy of [...calls,normalize,resolve])expect(spy).not.toHaveBeenCalled();
    expect(f.repo.exportSnapshot()).toEqual(before);
  } finally {await f.close();}
});

it('canonical original bytes stay exact; canonical-spelling leaf and parent symlinks still reject before open',async()=>{
  const f=await setup();
  try {
    const normal=f.register('normal',path.join(f.a,'image.png'));
    const result=await f.call(normal);expect(Buffer.from(result.data,'base64')).toEqual(f.red);
    const leaf=path.join(f.a,'leaf.png');await fs.symlink(path.join(f.b,'image.png'),leaf);
    const requests=[f.register('leaf',leaf),f.register('parent',`${f.a}/link/image.png`)];
    const opened=vi.spyOn(fs,'open');
    for(const request of requests)await expect(f.call(request)).rejects.toMatchObject({code:'invalid_image'});
    expect(opened).not.toHaveBeenCalled();
  } finally {await f.close();}
});
