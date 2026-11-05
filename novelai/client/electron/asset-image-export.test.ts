import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import sharp from 'sharp';
import { openLibraryRepository, type LibraryRepository } from './library/repository';
import { createAssetImageExporter, parseImageExportRequest } from './asset-image-export';
import type { ImageExportRequest } from '../src/asset-library/image-export';
import { IMAGE_EXPORT_LIMITS } from './asset-image-sanitize';
import { metadataPng, plain, stealth, SECRET } from './asset-image-export-fixtures';
import { parseImageStudy } from './image-study-parser';
import { waitUntil } from '../src/test-support/wait-until';

const roots: string[]=[], repos: LibraryRepository[]=[];
async function setup() {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'export-fixture-')));roots.push(root);
  const repo=openLibraryRepository({filePath:path.join(root,'fixture.sqlite'),libraryDirectory:root});repos.push(repo);
  const target=path.join(root,'out.zip');
  const choose=vi.fn(async()=>target);
  const run=createAssetImageExporter({repository:repo,chooseDestination:choose});
  async function add(id:string,bytes?:Buffer,extension='misleading.jpeg') {
    const file=path.join(root,`${id}.${extension}`);if(bytes)await fs.writeFile(file,bytes);
    const item=repo.put('history',id,{name:SECRET,id,filePath:file,params:{positivePrompt:SECRET}});
    return {file,item,identity:{kind:'history' as const,id,revision:item.revision}};
  }
  return {root,repo,target,choose,run,add};
}
const request=(...items:ImageExportRequest['items']):ImageExportRequest=>({items,stripMetadata:false});
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
afterEach(()=>runCleanups([()=>vi.restoreAllMocks(),...repos.splice(0).map(repo=>()=>repo.close()),...roots.splice(0).map(root=>()=>fs.rm(root,{recursive:true,force:true}))]));

describe('desktop library export boundary and actual ZIP',()=>{
  it('exports mixed selections byte exact by signature; safe unique filenames and ordinal-only report',async()=>{
    const {repo,run,add,target,root}=await setup(), png=await metadataPng();
    const a=await add('private-id-'+SECRET,png), missing=await add('missing');
    repo.put('note','noimage',{name:SECRET,notes:SECRET});
    const gif=await add('unsupported',Buffer.from('GIF89a'));
    const jpg=await sharp(await plain()).jpeg().withExif({IFD0:{Artist:SECRET}}).toBuffer();
    const webp=await sharp(await plain()).webp().toBuffer();
    const b=await add('b',jpg,'png'), c=await add('c',webp,'jpg');
    const snapshot=repo.exportSnapshot(), hash=digest(await fs.readFile(a.file));
    const outcome=await run(request(a.identity,missing.identity,{kind:'note',id:'noimage',revision:1},gif.identity,b.identity,c.identity));
    expect(outcome).toMatchObject({status:'saved',success:3,skipped:1,failed:2});
    const zip=await JSZip.loadAsync(await fs.readFile(target),{checkCRC32:true});
    expect(await zip.file('item-001-image-001.png')!.async('nodebuffer')).toEqual(png);
    expect(await zip.file('item-005-image-001.jpg')!.async('nodebuffer')).toEqual(jpg);
    expect(await zip.file('item-006-image-001.webp')!.async('nodebuffer')).toEqual(webp);
    const report=await zip.file('report.json')!.async('string');
    expect(report).not.toContain(SECRET);expect(report).not.toContain(root);expect(report).not.toContain('private-id');
    expect(Object.keys(zip.files)).toEqual(['item-001-image-001.png','item-005-image-001.jpg','item-006-image-001.webp','report.json']);
    expect(digest(await fs.readFile(a.file))).toBe(hash);expect(repo.exportSnapshot()).toEqual(snapshot);
    expect((await fs.readdir(root)).some(file=>file.endsWith('.tmp'))).toBe(false);
  });
  it('privacy mixed success/known stealth never falls back; no metadata through manifest, errors, names or bytes',async()=>{
    const {run,add,target}=await setup(), original=await metadataPng(), hidden=stealth();
    const a=await add('private-'+SECRET,original),b=await add('hidden-'+SECRET,hidden);
    const outcome=await run({...request(a.identity,b.identity),stripMetadata:true});
    expect(outcome).toMatchObject({status:'saved',success:1,failed:1});expect(outcome.rows[1].reason).toBe('stealth');
    const zipBytes=await fs.readFile(target);expect(zipBytes.includes(Buffer.from(SECRET))).toBe(false);
    const zip=await JSZip.loadAsync(zipBytes,{checkCRC32:true});expect(Object.keys(zip.files)).toEqual(['item-001-image-001.png','report.json']);
    expect((await parseImageStudy(await zip.file('item-001-image-001.png')!.async('nodebuffer'))).sources).toEqual([]);
    expect(await fs.readFile(a.file)).toEqual(original);expect(await fs.readFile(b.file)).toEqual(hidden);
  });
  it('cancels with zero writes (including temporary files)',async()=>{
    const {root,choose,run,add}=await setup(),a=await add('a',await plain());
    const before=await fs.readdir(root),write=vi.spyOn(fs,'open');choose.mockResolvedValue(undefined as any);
    expect(await run(request(a.identity))).toMatchObject({status:'cancelled',success:0,failed:0,rows:[]});
    expect(await fs.readdir(root)).toEqual(before);expect(write).not.toHaveBeenCalled();
  });
  it('rejects stale selection and changed revision during the native dialog, without substituting new image',async()=>{
    const {repo,run,add,choose,target}=await setup(),a=await add('a',await plain());
    choose.mockImplementation(async()=>{repo.put('history','a',{id:'a',filePath:a.file,params:{positivePrompt:'changed'}});return target;});
    expect(await run(request(a.identity))).toMatchObject({status:'failed',success:0,rows:[{reason:'changed'}]});
    expect(await run(request(a.identity))).toMatchObject({status:'failed',success:0,rows:[{reason:'changed'}]});
    await expect(fs.stat(target)).rejects.toMatchObject({code:'ENOENT'});
  });
  it('rejects changed same-revision image relationships and cannot accept cross-item assetId',async()=>{
    const {repo,run,add,choose,target}=await setup(),a=await add('a',await plain()),b=await add('b',await metadataPng());
    await expect(run({items:[{...a.identity,assetId:repo.itemAssets('history','b')[0].id}],stripMetadata:false})).rejects.toThrow();
    expect(choose).not.toHaveBeenCalled();
    choose.mockImplementation(async()=>{repo.linkAsset({kind:'history',id:'a',role:'original',assetId:repo.itemAssets('history','b')[0].id});return target;});
    expect(await run(request(a.identity))).toMatchObject({status:'failed',rows:[{reason:'changed'}]});expect(await fs.readFile(b.file)).toEqual(await metadataPng());
  });
  it.each(['symlink','replace','parent-link','traversal','content'] as const)('fails closed on source %s changes',async(mode)=>{
    const {repo,root,run,add,choose,target}=await setup(),a=await add('a',await plain()),b=await add('b',await metadataPng());
    if(mode==='traversal')repo.put('history','a',{filePath:path.join(root,'child')+'/../a.misleading.jpeg'},{revision:2});
    if(mode==='parent-link') {await fs.symlink(root,path.join(root,'alias'),'dir');repo.put('history','a',{filePath:path.join(root,'alias','a.misleading.jpeg')},{revision:2});}
    choose.mockImplementation(async()=>{
      if(mode==='symlink'){await fs.unlink(a.file);await fs.symlink(b.file,a.file);}
      if(mode==='replace'){await fs.unlink(a.file);await fs.writeFile(a.file,await plain());}
      if(mode==='content')await fs.writeFile(a.file,await metadataPng());
      return target;
    });
    const selection={...a.identity,revision:repo.get('history','a')!.revision};
    const result=await run(request(selection));expect(result.status).toBe('failed');expect(result.success).toBe(0);expect(result.rows[0].reason).toBe('unavailable');await expect(fs.stat(target)).rejects.toMatchObject({code:'ENOENT'});
  });
  it('detects swap between no-follow open and earlier stat; does not read alternate bytes',async()=>{
    const {run,add,choose,target}=await setup(),a=await add('a',await plain()),b=await add('b',await metadataPng());
    const realOpen=fs.open.bind(fs);
    choose.mockImplementation(async()=>{vi.spyOn(fs,'open').mockImplementation(async(file:any,flags:any,mode:any)=>{if(file===a.file&&flags===(constants.O_RDONLY|constants.O_NOFOLLOW)){await fs.unlink(a.file);await fs.symlink(b.file,a.file);}return realOpen(file,flags,mode);});return target;});
    expect(await run(request(a.identity))).toMatchObject({status:'failed',success:0,rows:[{reason:'unavailable'}]});
  });
  it.each(['existing','source','symlink','io'] as const)('never overwrites destination %s or leaves partial ZIP',async(mode)=>{
    const {root,choose,run,add,target}=await setup(),a=await add('a',await plain(),'zip'),prior=Buffer.from('existing');
    if(mode==='existing')await fs.writeFile(target,prior);
    if(mode==='source')choose.mockResolvedValue(a.file);
    if(mode==='symlink')await fs.symlink(a.file,target);
    if(mode==='io')choose.mockResolvedValue(path.join(root,'missing','a.zip'));
    expect(await run(request(a.identity))).toMatchObject({status:'failed',success:0,failed:1});
    expect(await fs.readFile(a.file)).toEqual(await plain());
    if(mode==='existing')expect(await fs.readFile(target)).toEqual(prior);
    expect((await fs.readdir(root)).some(file=>file.endsWith('.tmp'))).toBe(false);
  });
  it('atomic publication rejects a target created after native selection',async()=>{
    const {run,add,target,root}=await setup(),a=await add('a',await plain());
    const link=fs.link.bind(fs);vi.spyOn(fs,'link').mockImplementation(async(source,targetName)=>{await fs.writeFile(targetName,'race');return link(source,targetName);});
    expect(await run(request(a.identity))).toMatchObject({status:'failed',success:0,failed:1});expect(await fs.readFile(target,'utf8')).toBe('race');expect((await fs.readdir(root)).some(file=>file.endsWith('.tmp'))).toBe(false);
  });
  it('partial ZIP IO failure yields no success and deletes temporary output',async()=>{
    const {run,add,root}=await setup(),a=await add('a',await plain());const open=fs.open.bind(fs);
    vi.spyOn(fs,'open').mockImplementation(async(file:any,flags:any,mode:any)=>{const handle=await open(file,flags,mode);if(flags==='wx+')vi.spyOn(handle,'write').mockRejectedValue(new Error(SECRET));return handle;});
    const outcome=await run(request(a.identity));expect(outcome).toMatchObject({status:'failed',success:0,failed:1});expect(JSON.stringify(outcome)).not.toContain(SECRET);expect((await fs.readdir(root)).some(file=>file.endsWith('.tmp')||file.endsWith('.zip'))).toBe(false);
  });
  it('blocks concurrent requests while dialog pending, but never automatically replays',async()=>{
    const {choose,run,add,target}=await setup(),a=await add('a',await plain());let resolve!:(target:string)=>void;
    choose.mockImplementation(()=>new Promise<string>(done=>{resolve=done;}));
    const first=run(request(a.identity));
    // Drive async preflight deterministically by observing the dialog callback.
    await waitUntil(()=>expect(choose).toHaveBeenCalledTimes(1));
    await expect(run(request(a.identity))).rejects.toThrow('already running');resolve(target);expect((await first).status).toBe('saved');expect(choose).toHaveBeenCalledTimes(1);
  });
  it('prefers original for favorites and study, exports all registered other previews with unique ordinal names',async()=>{
    const {repo,run,root,target,add}=await setup(),a=await add('a',await plain()),b=await add('b',await metadataPng());
    repo.put('artist_favorite','random:f',{collection:'random',image:{filePath:a.file},previewImages:[{filePath:b.file}]});
    repo.put('style_preset','s',{previewImages:[{filePath:a.file},{filePath:b.file}]});
    const id='11111111-2222-3333-4444-555555555555';await fs.mkdir(path.join(root,'studies',id),{recursive:true});await fs.writeFile(path.join(root,'studies',id,'original.png'),await plain());
    repo.put('study',id,{study:{id,mimeType:'image/png'}});
    const outcome=await run(request({kind:'artist_favorite',id:'random:f',revision:1},{kind:'style_preset',id:'s',revision:1},{kind:'study',id,revision:1}));expect(outcome).toMatchObject({status:'saved',success:4,failed:0});expect(outcome.rows.map(row=>row.reason)).toEqual(['original','preview','preview','original']);
    expect(Object.keys((await JSZip.loadAsync(await fs.readFile(target))).files)).toHaveLength(5);
  });
  it('enforces closed schema and all count/file/batch limits before unbounded reads',async()=>{
    const {repo,run,add,choose}=await setup(),a=await add('a',await plain());
    for(const value of [{...request(a.identity),path:'/secret'},{...request(a.identity),stripMetadata:'yes'},request({...a.identity,kind:'global' as any}),request({...a.identity,revision:0}),request(a.identity,a.identity),request(...Array.from({length:101},(_,n)=>({...a.identity,id:String(n)})))]) expect(()=>parseImageExportRequest(value)).toThrow();
    expect(choose).not.toHaveBeenCalled();
    repo.put('style_preset','s',{previewImages:Array.from({length:301},()=>({filePath:a.file}))});expect(await run(request({kind:'style_preset',id:'s',revision:1}))).toMatchObject({status:'failed',rows:[{reason:'limit'}]});
    const handle=await fs.open(a.file,'r+');await handle.truncate(IMAGE_EXPORT_LIMITS.fileBytes+1);await handle.close();
    expect(await run(request(a.identity))).toMatchObject({status:'failed',rows:[{reason:'limit'}]});
    expect(IMAGE_EXPORT_LIMITS).toMatchObject({items:100,images:300,totalBytes:512*1024*1024,pixels:16_000_000});
  });
});

it('rechecks library selection after fsync, and discards the entire temporary ZIP on late change',async()=>{
  const {repo,run,add,target,root}=await setup(),a=await add('a',await plain());const open=fs.open.bind(fs);
  vi.spyOn(fs,'open').mockImplementation(async(file:any,flags:any,mode:any)=>{const handle=await open(file,flags,mode);if(flags==='wx+'){const sync=handle.sync.bind(handle);vi.spyOn(handle,'sync').mockImplementation(async()=>{await sync();repo.put('history','a',{filePath:a.file,name:'changed'});});}return handle;});
  expect(await run(request(a.identity))).toMatchObject({status:'failed',success:0,rows:[{reason:'changed'}]});await expect(fs.stat(target)).rejects.toMatchObject({code:'ENOENT'});expect((await fs.readdir(root)).some(file=>file.endsWith('.tmp'))).toBe(false);
});
it('real residual stealth in lossless WebP fails source verification and cannot export original bytes',async()=>{
  const {run,add,target}=await setup();const input=await sharp(stealth()).webp({lossless:true}).toBuffer();const a=await add('a',input);
  const result=await run({...request(a.identity),stripMetadata:true});expect(result).toMatchObject({status:'failed',success:0,rows:[{reason:'stealth'}]});expect(await fs.readFile(a.file)).toEqual(input);await expect(fs.stat(target)).rejects.toMatchObject({code:'ENOENT'});
});
it('cumulative input budget stops before the ninth 64 MiB read even when earlier files fail',async()=>{
  const {run,add}=await setup(),identities:ImageExportRequest['items']=[];const names=new Set<string>();
  for(let n=0;n<9;n++){const a=await add(String(n),await plain());names.add(a.file);identities.push(a.identity);}
  const lstat=fs.lstat.bind(fs);vi.spyOn(fs,'lstat').mockImplementation(async(...args:any[])=>{const stat=await (lstat as any)(...args);if(names.has(String(args[0])))stat.size=IMAGE_EXPORT_LIMITS.fileBytes;return stat;});
  // Actual fstat mismatch aborts before allocation/read; each attempted source still
  // consumes reserved input budget, so corrupt inputs cannot evade the batch cap.
  const outcome=await run(request(...identities));expect(outcome.success).toBe(0);expect(outcome.rows.slice(0,8).every(row=>row.reason==='unavailable')).toBe(true);expect(outcome.rows[8].reason).toBe('limit');
});
it('produces inspectable synthetic raw/private ZIP evidence with invariant source SHA',async()=>{
  const {run,add,choose,target}=await setup();const source=await metadataPng(),hidden=stealth();const a=await add('evidence',source),b=await add('hidden',hidden);
  const before=digest(await fs.readFile(a.file));const raw=await run(request(a.identity));const rawZip=await fs.readFile(target);
  choose.mockResolvedValue(target.replace('out.zip','clean.zip'));
  const clean=await run({...request(a.identity,b.identity),stripMetadata:true});const cleanZip=await fs.readFile(target.replace('out.zip','clean.zip'));
  expect(cleanZip.includes(Buffer.from(SECRET))).toBe(false);expect(digest(await fs.readFile(a.file))).toBe(before);
  if(process.env.MATERIAL_EXPORT_EVIDENCE_DIR){const directory=process.env.MATERIAL_EXPORT_EVIDENCE_DIR;await fs.mkdir(directory,{recursive:true});for(const [name,bytes] of [['source-metadata.png',source],['source-stealth.png',hidden],['raw.zip',rawZip],['clean.zip',cleanZip]] as const)await fs.writeFile(path.join(directory,name),bytes);await fs.writeFile(path.join(directory,'outcomes.json'),JSON.stringify({synthetic:true,sourceShaBefore:before,sourceShaAfter:digest(await fs.readFile(a.file)),raw,clean},null,2));}
});
it('public asset service and public request schema never expose the desktop export action',async()=>{
  const {repo}=await setup();const {createAssetLibraryService}=await import('./asset-library-service');const {validateLibraryRequest}=await import('./library/validation');
  expect(()=>validateLibraryRequest('asset_library',{action:'export-images',items:[{kind:'history',id:'x',revision:1}],stripMetadata:false})).toThrow();
  await expect(createAssetLibraryService({repository:repo}).asset_library({action:'export-images'})).rejects.toMatchObject({code:'invalid_argument'});
});
it('requires the registered hash when available and detects independent cover changes',async()=>{
  const {repo,root,run,add,choose,target}=await setup(),a=await add('a',await plain());
  repo.put('history','a',{filePath:a.file,sha256:'0'.repeat(64)});
  expect(await run(request({...a.identity,revision:2}))).toMatchObject({status:'failed',rows:[{reason:'unavailable'}]});
  const bytes=await plain(),hash=digest(bytes);await fs.mkdir(path.join(root,'covers'));await fs.writeFile(path.join(root,'covers',hash+'.webp'),bytes);
  repo.put('tag','t',{name:'fixture'});repo.setCover('tag','t',{sha256:hash,mimeType:'image/png'});
  choose.mockImplementation(async()=>{repo.setCover('tag','t',null);return target;});
  expect(await run(request({kind:'tag',id:'t',revision:1}))).toMatchObject({status:'failed',rows:[{reason:'changed'}]});
});
