import { afterEach, describe, expect, it } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { openLibraryRepository, type LibraryRepository } from './library/repository';
import { appendLibraryArchive, inspectLibraryArchive, restoreLibraryArchive } from './library-archive';
import { initializeAssetLibrary } from './library-startup';
import { deactivateLibrary } from './library-runtime';

const roots:string[] = [], repositories:LibraryRepository[] = [];
const hash = (value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
const now = '2026-09-12T12:00:00.000Z';
const studyId = '00000000-0000-4000-8000-000000000001';
afterEach(()=>runCleanups([()=>deactivateLibrary(),...repositories.splice(0).map(repo=>()=>repo.close()),...roots.splice(0).map(root=>()=>fs.rm(root,{recursive:true,force:true}))]));
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'nai-library-archive-')); roots.push(root);
  const libraryDirectory = path.join(root,'library'), userDataRoot = path.join(root,'user-data'), output = path.join(root,'output');
  for (const directory of [libraryDirectory,userDataRoot,output]) await fs.mkdir(directory);
  const repository = openLibraryRepository({filePath:path.join(root,'library.sqlite'),libraryDirectory,userDataRoot}); repositories.push(repository);
  return {root,libraryDirectory,userDataRoot,output,repository,assetRoots:[output]};
}
async function populated() {
  const context = await fixture(), {repository:repo,libraryDirectory} = context;
  const original = Buffer.from('SFW fixture image bytes'), preview = Buffer.from('SFW fixture preview'), cover = Buffer.from('SFW fixture cover');
  const filePath = path.join(context.output,'mug.png'); await fs.writeFile(filePath,original);
  const history = {id:'history-1',filePath,fileUrl:'nai-local://fixture',date:now,createdAt:now,params:{seed:7,positivePrompt:' a red mug\n'},actualSeed:7,model:'nai-diffusion-5-full',width:832,height:1216,groupId:'history-group'};
  repo.put('history',history.id,history,{revision:1}); repo.put('history',history.id,{...history,params:{...history.params,stylePrompt:'watercolor'}},{revision:2});
  repo.put('style_preset','style-1',{id:'style-1',name:'Watercolor',prompt:'  watercolor\n',group:'paint',createdAt:now,previewImages:[{id:'preview-1',name:'Visual note',filePath,fileUrl:'nai-local://fixture',createdAt:now}]});
  const material = {schemaVersion:1,id:'tag-1',revision:1,kind:'tag',name:'Watercolor',group:'paint',notes:'Authored note',archived:false,createdAt:now,updatedAt:now,tag:{text:'watercolor',source:'english',category:null,target:'style'}};
  repo.put('tag','tag-1',material);
  const folder = path.join(libraryDirectory,'studies',studyId); await fs.mkdir(folder,{recursive:true});
  await fs.writeFile(path.join(folder,'original.png'),original); await fs.writeFile(path.join(folder,'preview.webp'),preview);
  repo.put('study',studyId,{schemaVersion:1,parserVersion:1,study:{id:studyId,revision:7,name:'Mug study',sha256:hash(original),mimeType:'image/png',width:832,height:1216,byteLength:original.length,sourceUrl:'https://example.com/mug',sourceAuthor:'Fixture',createdAt:now,updatedAt:now,archived:false,metadataStatus:'generation',metadataKind:'novelai',sources:['png-text'],warnings:[],promptFieldCount:1,parameterFieldCount:1},notes:'Original study note',originalName:'mug.png',previewSha256:hash(preview),previewByteLength:preview.length,sections:{prompts:[{key:'Comment.prompt',label:'Prompt',value:' a red mug\n'}],parameters:[{key:'Comment.seed',label:'Seed',value:'7'}],raw:{'png-text':{Comment:'{"prompt":" a red mug\\n","seed":7}'}}}},{revision:7});
  const coverValue = {sha256:hash(cover),mimeType:'image/webp',width:32,height:32,byteLength:cover.length,postId:1,sourceUrl:'https://danbooru.donmai.us/posts/1',tagText:'watercolor',tagCategory:null,rating:'g',savedAt:now,verification:'imported',checkedAt:null};
  await fs.mkdir(path.join(libraryDirectory,'covers')); await fs.writeFile(path.join(libraryDirectory,'covers',`${hash(cover)}.webp`),cover); repo.setCover('tag','tag-1',coverValue,{coverRevision:3});
  repo.putCollection({namespace:'user',id:'collection-1',name:'Selected',payload:{description:'Keep membership'}}); repo.setMembership({namespace:'user',collectionId:'collection-1',kind:'history',id:'history-1'});
  repo.setRelations('history','history-1',2,[{targetKind:'study',targetId:studyId,targetRevision:7,payload:{role:'source',excerpt:' a red mug\n'}}]);
  repo.putFileOperation({id:'not-portable',action:'delete',state:'pending',createdAt:now,payload:{filePath:'/never/replay'}});
  return {...context,filePath,original,preview,cover};
}
async function archive(context:Awaited<ReturnType<typeof populated>>) {const zip = new JSZip(); const result = await appendLibraryArchive(zip,context); return {zip,result};}

describe('portable unified library archive',()=>{
  it('restores the artist collections an archive carries into a freshly started target, which holds no collections of its own',async()=>{
    const source=await fixture(),names=['random','v5-repair','artist-string-draw'];for(const name of names)source.repository.putCollection({namespace:'artist-favorites',id:name,name,payload:{}});source.repository.put('artist_favorite','random:archived',{id:'archived',collection:'random',artists:[],auxiliary:[],mutations:[],franchiseStyles:[],basePrompt:'archive',prompt:'archive',pairId:'archive',variant:'plain',sequence:1,status:'done'});
    const zip=new JSZip();await appendLibraryArchive(zip,{...source,includeAssets:false});
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'nai-library-startup-'));roots.push(root);const libraryDirectory=path.join(root,'library'),repository=await initializeAssetLibrary({userDataRoot:root,libraryDirectory,useWorker:false});repositories.push(repository);
    expect(repository.collections()).toEqual([]);
    repository.putCollection({namespace:'user',id:'target-only',name:'Target only',payload:{meaning:'local'}});
    await expect(restoreLibraryArchive(zip,{repository,libraryDirectory,userDataRoot:root})).resolves.toMatchObject({present:true,conflicts:0});
    expect(repository.collections('artist-favorites')).toEqual(names.map(name=>({namespace:'artist-favorites',id:name,name,payload:{}})).sort((a,b)=>a.name.localeCompare(b.name)));expect(repository.collections('user')).toContainEqual({namespace:'user',id:'target-only',name:'Target only',payload:{meaning:'local'}});expect(repository.memberships('artist_favorite','random:archived')).toEqual([{namespace:'artist-favorites',collectionId:'random',kind:'artist_favorite',id:'random:archived'}]);const archived=JSON.parse(await zip.file('library/manifest.json')!.async('string'));expect(archived.snapshot.collections.filter((value:any)=>value.namespace==='artist-favorites').every((value:any)=>Object.keys(value.payload).length===0)).toBe(true);
  });
  it('accepts the same three legacy artist collection forms in reverse while preserving empty target payloads',async()=>{
    const source=await fixture(),target=await fixture(),names=['random','v5-repair','artist-string-draw'];for(const name of names){source.repository.putCollection({namespace:'artist-favorites',id:name,name,payload:{id:name,name}});target.repository.putCollection({namespace:'artist-favorites',id:name,name,payload:{}});}source.repository.put('artist_favorite','v5-repair:reverse',{id:'reverse',collection:'v5-repair',artists:[],auxiliary:[],mutations:[],franchiseStyles:[],basePrompt:'reverse',prompt:'reverse',pairId:'reverse',variant:'plain',sequence:1,status:'done'});target.repository.putCollection({namespace:'user',id:'target-only',name:'Target only',payload:{meaning:'local'}});const zip=new JSZip();await appendLibraryArchive(zip,{...source,includeAssets:false});await expect(restoreLibraryArchive(zip,{...target})).resolves.toMatchObject({conflicts:0});expect(target.repository.collections('artist-favorites')).toEqual(names.map(name=>({namespace:'artist-favorites',id:name,name,payload:{}})).sort((a,b)=>a.name.localeCompare(b.name)));expect(target.repository.collections('user')).toContainEqual({namespace:'user',id:'target-only',name:'Target only',payload:{meaning:'local'}});expect(target.repository.memberships('artist_favorite','v5-repair:reverse')).toEqual([{namespace:'artist-favorites',collectionId:'v5-repair',kind:'artist_favorite',id:'v5-repair:reverse'}]);
  });
  it('retains all revisions, exact study metadata, collections and links with deduplicated original bytes',async()=>{
    const source = await populated(), destination = await fixture(), {zip,result} = await archive(source);
    expect(result).toMatchObject({items:4,versions:5,assets:3,missing:0});
    expect(Object.keys(zip.files).filter(name=>/^library\/blobs\/[a-f0-9]{64}$/.test(name))).toHaveLength(3);
    const packed = await JSZip.loadAsync(await zip.generateAsync({type:'nodebuffer'}));
    const restored = await restoreLibraryArchive(packed,destination);
    expect(restored).toMatchObject({present:true,imported:4,conflicts:0,missing:0});
    const history = destination.repository.get('history','history-1')!;
    expect(history.payload.filePath.startsWith(destination.userDataRoot)).toBe(true);
    expect(await fs.readFile(history.payload.filePath)).toEqual(source.original);
    expect(destination.repository.readVersions('history','history-1').map(item=>item.revision)).toEqual([1,2]);
    expect(destination.repository.get('history','history-1',1)!.payload.params).toEqual({seed:7,positivePrompt:' a red mug\n'});
    expect(destination.repository.get('study',studyId)!.payload.sections).toEqual(source.repository.get('study',studyId)!.payload.sections);
    expect(await fs.readFile(path.join(destination.libraryDirectory,'studies',studyId,'original.png'))).toEqual(source.original);
    expect(await fs.readFile(path.join(destination.libraryDirectory,'covers',`${hash(source.cover)}.webp`))).toEqual(source.cover);
    expect(destination.repository.relations({kind:'history',id:'history-1',revision:2})).toEqual(source.repository.relations({kind:'history',id:'history-1',revision:2}));
    expect(destination.repository.memberships('history','history-1')).toEqual(source.repository.memberships('history','history-1'));
    expect(destination.repository.getCover('tag','tag-1').coverRevision).toBe(3);
    expect(destination.repository.pendingFileOps()).toEqual([]);
    expect(destination.repository.exportSnapshot()).not.toHaveProperty('migration');
  });
  it('keeps conflicting local identities and revision chains while importing other material',async()=>{
    const source = await populated(), destination = await fixture(), {zip} = await archive(source);
    const local = {...source.repository.get('history','history-1')!.payload,params:{seed:99,positivePrompt:'a local vase'}};
    destination.repository.put('history','history-1',local,{revision:8});
    const result = await restoreLibraryArchive(zip,destination);
    expect(result.conflicts).toBeGreaterThanOrEqual(1);
    expect(destination.repository.readVersions('history','history-1')).toHaveLength(1);
    expect(destination.repository.get('history','history-1')!.payload).toEqual(local);
    expect(destination.repository.get('study',studyId)).not.toBeNull();
  });
  it('records originals beyond the byte budget or left out of a lightweight archive as missing, with path-free reasons',async()=>{
    const context = await fixture(), {repository:repo} = context;
    const plainBytes = Buffer.alloc(3000,1), queuedBytes = Buffer.alloc(1000,2);
    const plainPath = path.join(context.output,'plain.png'), queuedPath = path.join(context.output,'queued.png');
    await fs.writeFile(plainPath,plainBytes); await fs.writeFile(queuedPath,queuedBytes);
    const base = {date:now,createdAt:now,params:{seed:1},actualSeed:1,model:'nai-diffusion-5-full',width:8,height:8};
    repo.put('history','plain',{...base,id:'plain',filePath:plainPath,fileUrl:'nai-local://plain'},{revision:1});
    repo.put('history','queued',{...base,id:'queued',filePath:queuedPath,fileUrl:'nai-local://queued'},{revision:1});
    const archived = async (options:{includeAssets:boolean;maxTotalBytes?:number}) => {
      const zip = new JSZip(), summary = await appendLibraryArchive(zip,{...context,...options});
      const manifest = JSON.parse(await zip.file('library/manifest.json')!.async('string'));
      const bySource = new Map<string,any>(manifest.files.map((file:any)=>[path.resolve(file.sourcePath),file]));
      return {summary,queued:bySource.get(path.resolve(queuedPath)),plain:bySource.get(path.resolve(plainPath)),zip};
    };
    // Archive order: plain (3000 bytes) fits the 3500-byte budget, queued (1000 bytes) no longer does.
    const budget = await archived({includeAssets:true,maxTotalBytes:3500});
    expect(budget.plain?.sha256).toBe(hash(plainBytes)); expect(budget.queued?.sha256).toBeNull(); expect(budget.summary.missing).toBe(1);
    expect(budget.queued?.reason).toBe('Linked images exceed the 2 GiB limit of this archive.');
    const light = await archived({includeAssets:false});
    expect(light.zip.file(`library/blobs/${hash(queuedBytes)}`)).toBeNull();
    for (const file of [light.plain,light.queued]) { expect(file?.sha256).toBeNull(); expect(file?.reason).toBe('This backup does not include image bytes.'); }
    // Missing files get a path-free reason, so they group into one warning and never leak paths.
    for (const id of ['gone-1','gone-2']) repo.put('history',id,{...base,id,filePath:path.join(context.output,`${id}.png`),fileUrl:`nai-local://${id}`},{revision:1});
    const zip = new JSZip(), summary = await appendLibraryArchive(zip,{...context,includeAssets:true});
    const manifest = JSON.parse(await zip.file('library/manifest.json')!.async('string'));
    expect(manifest.files.filter((file:any)=>/gone-\d\.png$/.test(file.sourcePath)).map((file:any)=>file.reason)).toEqual(['The linked image does not exist.','The linked image does not exist.']);
    expect(summary.warnings.filter(value=>value.includes('The linked image does not exist'))).toEqual(['2 linked images: The linked image does not exist. (for example gone-1.png, gone-2.png)']);
  });
  it('reports missing original bytes while preserving sparse legacy params and owned placeholder paths',async()=>{
    const source = await populated(), destination = await fixture(); await fs.unlink(source.filePath);
    const {zip,result} = await archive(source); expect(result.missing).toBeGreaterThan(0);expect(await inspectLibraryArchive(zip)).toMatchObject({present:true,missing:expect.any(Number)});
    const restored = await restoreLibraryArchive(zip,destination); expect(restored.missing).toBeGreaterThan(0);
    const item = destination.repository.get('history','history-1')!;
    expect(item.payload.filePath.startsWith(destination.userDataRoot)).toBe(true);
    expect(Object.hasOwn(item.payload.params,'qualityPreset')).toBe(false);
    await expect(fs.access(item.payload.filePath)).rejects.toThrow();
  });
  it('refuses mismatched hashes and escaping or absent file manifests before publishing metadata',async()=>{
    const source = await populated(), destination = await fixture();
    const {zip} = await archive(source), manifest = JSON.parse(await zip.file('library/manifest.json')!.async('string'));
    const first = manifest.files.find((file:any)=>file.sha256);
    zip.file(`library/blobs/${first.sha256}`,Buffer.from('corrupt'));
    await expect(inspectLibraryArchive(zip)).rejects.toThrow(/SHA-256/);await expect(restoreLibraryArchive(zip,destination)).rejects.toThrow(/SHA-256/);
    expect(destination.repository.all()).toEqual([]);
    const fresh = await archive(source); const bad = JSON.parse(await fresh.zip.file('library/manifest.json')!.async('string'));
    bad.files[0].destination = {area:'study',id:'../escape',name:'original.png'}; fresh.zip.file('library/manifest.json',JSON.stringify(bad));
    await expect(restoreLibraryArchive(fresh.zip,destination)).rejects.toMatchObject({ code: 'library_archive_invalid', message: expect.stringMatching(/path/) });
    const absent = await archive(source); const missing = JSON.parse(await absent.zip.file('library/manifest.json')!.async('string'));
    missing.snapshot.items.find((item:any)=>item.kind==='history').payload.filePath='/outside/not-in-manifest.png'; absent.zip.file('library/manifest.json',JSON.stringify(missing));
    await expect(restoreLibraryArchive(absent.zip,destination)).rejects.toMatchObject({ code: 'library_archive_invalid', message: expect.stringMatching(/file entry|file list/) });
    expect(destination.repository.pendingFileOps()).toEqual([]);
  });
  it('refuses a library snapshot of any version but 1 before publishing anything',async()=>{
    const source = await populated(), destination = await fixture(), {zip} = await archive(source);
    const manifest = JSON.parse(await zip.file('library/manifest.json')!.async('string')); expect(manifest.snapshot.schemaVersion).toBe(1);
    manifest.snapshot.schemaVersion = 2; zip.file('library/manifest.json',JSON.stringify(manifest));
    await expect(inspectLibraryArchive(zip)).rejects.toMatchObject({ code: 'library_archive_invalid', reason: 'library_archive.version_invalid' }); await expect(restoreLibraryArchive(zip,destination)).rejects.toThrow(/version is invalid/);
    expect(destination.repository.all()).toEqual([]); expect(destination.repository.pendingFileOps()).toEqual([]);
  });
  it('refuses, already when inspecting, a cover the library would not read (a Danbooru cover without its rating)',async()=>{
    const source = await populated(), destination = await fixture(), {zip} = await archive(source);
    const manifest = JSON.parse(await zip.file('library/manifest.json')!.async('string')), entry = manifest.snapshot.covers.find((value:any)=>value.cover);
    delete entry.cover.rating; zip.file('library/manifest.json',JSON.stringify(manifest));
    await expect(inspectLibraryArchive(zip)).rejects.toMatchObject({ code: 'library_archive_invalid', reason: 'library_archive.cover_rating_missing', params: { id: 'tag-1' }, message: expect.stringMatching(/Danbooru cover of tag tag-1 .* has no rating/) });
    await expect(restoreLibraryArchive(zip,destination)).rejects.toThrow(/has no rating/);
    expect(destination.repository.all()).toEqual([]); expect(destination.repository.pendingFileOps()).toEqual([]);
    entry.cover.rating = 'g'; entry.cover.sourceUrl = 'https://example.com/elsewhere'; zip.file('library/manifest.json',JSON.stringify(manifest));
    await expect(inspectLibraryArchive(zip)).rejects.toMatchObject({ reason: 'library_archive.cover_unsupported', params: { id: 'tag-1' }, message: expect.stringMatching(/cover record of tag tag-1 in the material archive: /) });
  });
  it('records interruption durably and resumes the same archive without overwriting original files',async()=>{
    const source = await populated(), destination = await fixture(), {zip} = await archive(source);
    const importSnapshot = destination.repository.importSnapshot;
    destination.repository.importSnapshot = ()=>{throw new Error('fixture interruption before SQL commit');};
    await expect(restoreLibraryArchive(zip,destination)).rejects.toMatchObject({ code: 'library_archive_restore_failed', reason: 'library_archive.restore_failed', message: expect.stringMatching(/restore journal/) });
    expect(destination.repository.all()).toEqual([]);
    expect(destination.repository.pendingFileOps().every(operation=>operation.state==='failed')).toBe(true);
    const pending = destination.repository.pendingFileOps(); expect(pending.length).toBeGreaterThan(0);
    expect(await fs.readFile(pending[0].payload.target)).not.toHaveLength(0);
    destination.repository.importSnapshot = importSnapshot;
    const result = await restoreLibraryArchive(zip,destination); expect(result.imported).toBe(4);
    expect(destination.repository.pendingFileOps()).toEqual([]);
    expect(await fs.readFile(source.filePath)).toEqual(source.original);
  });
  it('rejects a symlinked restore directory and supports old ZIPs without a unified snapshot',async()=>{
    const source = await populated(), destination = await fixture(), outside = path.join(destination.root,'outside'); await fs.mkdir(outside);
    await fs.symlink(outside,path.join(destination.userDataRoot,'library-media'));
    const {zip} = await archive(source);
    await expect(restoreLibraryArchive(zip,destination)).rejects.toThrow(/path|symbolic link/);
    expect(await fs.readdir(outside)).toEqual([]);
    expect(await restoreLibraryArchive(new JSZip(),destination)).toMatchObject({present:false,imported:0});
  });
});
