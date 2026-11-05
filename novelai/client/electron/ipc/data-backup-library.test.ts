import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCleanups } from '../../src/test-support/temp-dirs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { openLibraryRepository, type LibraryRepository } from '../library/repository';
import { activateLibrary, deactivateLibrary } from '../library-runtime';
import {DEFAULT_PARAMS} from '../../src/types';
import { hostMessageText } from '../../src/host-errors/compose';
import { loadArtistFavoriteLibrary, saveArtistFavoriteCollection } from './artist-favorites';

const mock = vi.hoisted(()=>({userData:'/private/tmp/unset-backup-test',state:{} as any,showSaveDialog:vi.fn(),showOpenDialog:vi.fn()}));
vi.mock('electron',()=>({
  app:{getPath:()=>mock.userData,getVersion:()=> 'fixture'},
  dialog:{showSaveDialog:mock.showSaveDialog,showOpenDialog:mock.showOpenDialog},shell:{openPath:vi.fn()},
  safeStorage:{isEncryptionAvailable:()=>false},
}));
vi.mock('./store',async()=>{
  // The real known-key filter (it computes the known keys from the real defaults, not from the fixture settings).
  const actual=await vi.importActual<typeof import('./store')>('./store');
  return {readStore:()=>mock.state,writeStore:(value:unknown)=>{mock.state=value;},defaultSettings:()=>mock.state.settings,retainKnownSettings:(raw:Record<string,unknown>)=>actual.retainKnownSettings(raw),librarySettings:actual.librarySettings};
});
import { createdFolderPath, exportDataBackup, importDataBackup, inspectDataBackup, runAutomaticBackup } from './data-backup';

const characterSnapshot = { version: 1 as const, captions: [
  { prompt: '  adult gardener, adult gardener, {blue coat}  \n', negativePrompt: ' hat, hat  ', useCoords: true, x: 0, y: 1 },
  { prompt: '  adult botanist  ', negativePrompt: '', useCoords: false, x: .25, y: .75 },
] };
const roots:string[] = [], repositories:LibraryRepository[] = [];
const now = '2026-09-12T12:00:00.000Z';
const categories = ['imageHistory','artistLibrary','referencePresets','promptPresets'] as const;
afterEach(()=>runCleanups([()=>deactivateLibrary(),...repositories.splice(0).map(repo=>()=>repo.close()),...roots.splice(0).map(root=>()=>fs.rm(root,{recursive:true,force:true})),()=>vi.clearAllMocks()]));
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'nai-backup-route-'));roots.push(root);
  const libraryDirectory=path.join(root,'library'),userDataRoot=path.join(root,'user-data');
  await fs.mkdir(libraryDirectory);await fs.mkdir(userDataRoot);
  const repository=openLibraryRepository({filePath:path.join(root,'library.sqlite'),libraryDirectory,userDataRoot});repositories.push(repository);
  activateLibrary(repository,{libraryDirectory,userDataRoot});mock.userData=userDataRoot;
  // settings.json data: token, account and settings; the history and presets are in the library.
  mock.state={settings:{outputDir:path.join(userDataRoot,'output'),backupDir:path.join(userDataRoot,'backups'),promptTemplates:[]},token:'fixture-secret-that-must-not-enter-library'};
  await fs.mkdir(mock.state.settings.outputDir);
  return {root,repository,libraryDirectory,userDataRoot};
}
async function zipTextContains(file:string,text:string){const zip=await JSZip.loadAsync(await fs.readFile(file));for(const entry of Object.values(zip.files))if(!entry.dir&&await entry.async('string').then(value=>value.includes(text),()=>false))return true;return false;}
async function source(missing=false) {
  const context=await fixture(),filePath=path.join(mock.state.settings.outputDir,'mug.png');
  if(!missing)await fs.writeFile(filePath,Buffer.from('SFW image fixture'));
  const item={id:'history-1',filePath,date:now,createdAt:now,params:{seed:7,positivePrompt:' a red mug\n'},actualSeed:7,model:'nai-diffusion-5-full',width:832,height:1216};
  context.repository.put('history','history-1',item,{revision:3});context.repository.put('history','history-1',{...item,params:{...item.params,stylePrompt:'watercolor'}},{revision:4});
  const preset={id:'style-1',name:'Watercolor',prompt:' watercolor\n',group:'paint',createdAt:now};
  context.repository.put('style_preset','style-1',preset);
  context.repository.put('note','note-1',{schemaVersion:1,id:'note-1',revision:1,kind:'note',name:'Material note',group:'bench',notes:'Keep exact text\n',archived:false,createdAt:now,updatedAt:now});
  mock.state.settings.promptTemplates=[{id:'template-1',name:'Still life',prefix:'a red mug',suffix:'soft light',negativePrompt:'low quality'}];
  return context;
}

describe('existing data backup UI with unified library',()=>{
  it('the original backup entry writes all four portable carriers beside the library snapshot and imports them live', async () => {
    const context = await source();
    const history = { ...context.repository.get('history', 'history-1')!.payload, characterSnapshot };
    context.repository.put('history', 'history-1', history);
    mock.state.settings.promptTemplates = [{ id: 'portable-template', name: 'Portable', prefix: 'adult painter', suffix: 'still life', negativePrompt: 'text' }];
    const exported = await exportDataBackup({ destination: 'internal', categories: [...categories] });
    expect(exported).toMatchObject({ ok: true, complete: true });
    const zip = await JSZip.loadAsync(await fs.readFile(exported.path!));
    expect(zip.file('data/image-history.json')).not.toBeNull(); expect(zip.file('data/prompt-presets.json')).not.toBeNull();
    const carrier = JSON.parse(await zip.file('data/image-history.json')!.async('string'));
    expect(carrier.items[0].characterSnapshot).toEqual(characterSnapshot);
    expect(carrier.items[0].params).toEqual(history.params);
    const library = JSON.parse(await zip.file('library/manifest.json')!.async('string'));
    expect(library.snapshot.items.find((item: any) => item.kind === 'history' && item.revision === 5).payload.characterSnapshot).toEqual(characterSnapshot);
    const destination = await fixture();
    const legacyReader = vi.spyOn(JSZip, 'loadAsync').mockRejectedValue(new Error('legacy JSZip reader must not run'));
    let imported;
    try { imported = await importDataBackup({ path: exported.path!, categories: [...categories], confirmConfigurationOverwrite: false }); }
    finally { legacyReader.mockRestore(); }
    expect(imported).toMatchObject({ ok: true, complete: true });
    expect(imported.imported).toBeGreaterThan(0);
    expect(destination.repository.get('history', 'history-1')!.payload.characterSnapshot).toEqual(characterSnapshot);
    expect(mock.state.settings.promptTemplates.map((value: any) => value.id)).toEqual(['portable-template']);
  });
  it('an automatic backup above the safe image size leaves image bytes out, reads back and keeps one file at retention 1', async () => {
    const context = await source(), backupDir = mock.state.settings.backupDir;
    Object.assign(mock.state.settings, { autoBackupEnabled: true, autoBackupIncludeImages: true, autoBackupIntervalHours: 24, autoBackupRetentionCount: 1 });
    await fs.mkdir(backupDir, { recursive: true });
    const older = path.join(backupDir, 'auto-older.naisbackup'); await fs.writeFile(older, 'previous backup placeholder');
    const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000); await fs.utimes(older, twoDaysAgo, twoDaysAgo);
    const result = await runAutomaticBackup(undefined, { imageByteLimit: 4 });
    expect(result).toMatchObject({ ok: true, degraded: true });
    expect(result.integrityReasons?.map(value => value.code)).toContain('auto-images-skipped');
    const kept = (await fs.readdir(backupDir)).filter((name: string) => name.startsWith('auto-'));
    expect(kept).toEqual([path.basename(result.path!)]);
    const zip = await JSZip.loadAsync(await fs.readFile(result.path!));
    expect(Object.keys(zip.files).filter(name => name.startsWith('library/blobs/'))).toEqual([]);
    mock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [result.path!] });
    expect(await inspectDataBackup()).toMatchObject({ ok: true, degraded: true });
    void context;
  });
  it('full material backup and restore retain SQL versions and also restore non-SQL prompt templates',async()=>{
    await source();
    const exported=await exportDataBackup({destination:'internal',categories:[...categories]});
    expect(exported.ok).toBe(true);expect(exported.complete).toBe(true);
    const zip=await JSZip.loadAsync(await fs.readFile(exported.path!));
    expect(zip.file('library/manifest.json')).not.toBeNull();expect(zip.file('data/prompt-presets.json')).not.toBeNull();
    expect(zip.file('data/api-credentials.json')).toBeNull();
    expect(await zip.file('library/manifest.json')!.async('string')).not.toContain('fixture-secret');
    const destination=await fixture();
    mock.state.settings.promptTemplates=[{id:'local-template',name:'Local',prefix:'a vase',suffix:'',negativePrompt:''}];
    const restored=await importDataBackup({path:exported.path!,categories:[...categories],confirmConfigurationOverwrite:false});
    expect(restored.ok,restored.message).toBe(true);
    expect(destination.repository.readVersions('history','history-1').map(item=>item.revision)).toEqual([3,4]);
    expect(destination.repository.all('style_preset').map(item=>item.id)).toEqual(['style-1']);
    expect(destination.repository.get('note','note-1')!.payload.notes).toBe('Keep exact text\n');
    expect(mock.state.settings.promptTemplates.map((item:any)=>item.id)).toEqual(['local-template','template-1']);
    expect(destination.repository.all('history')).toHaveLength(1);
    expect(Object.hasOwn(destination.repository.get('history','history-1')!.payload.params,'qualityPreset')).toBe(false);
    // The settings data stays settings only.
    expect(Object.keys(mock.state).sort()).toEqual(['settings','token']);expect(mock.state.settings).not.toHaveProperty('stylePromptPresets');
    expect(restored.rescueBackupPath).toBeTruthy();const rescue=await JSZip.loadAsync(await fs.readFile(restored.rescueBackupPath!));expect(rescue.file('data/api-credentials.json')).toBeNull();expect(JSON.stringify(Object.keys(rescue.files))).not.toContain('fixture-secret');
  });
  it('shows unavailable asset warnings through the existing export and import messages',async()=>{
    await source(true);
    const exported=await exportDataBackup({destination:'internal',categories:[...categories]});
    expect(exported.ok).toBe(true);expect(exported.complete).toBe(false);expect(exported.message).toContain('unavailable');expect(exported).toMatchObject({code:'backup_exported',reason:'backup.exported_limited'});expect(exported.warnings!.length).toBeGreaterThan(0);
    await fixture();
    const refused=await importDataBackup({path:exported.path!,categories:[...categories],confirmConfigurationOverwrite:false});expect(refused).toMatchObject({ok:false,degraded:true,imported:0});expect(refused.message).toContain('confirm the degraded import explicitly');expect(refused.code).toBe('backup_degraded_confirmation_required');
    const restored=await importDataBackup({path:exported.path!,categories:[...categories],confirmConfigurationOverwrite:false,confirmDegradedImport:true});
    expect(restored.ok,restored.message).toBe(true);expect(restored).toMatchObject({complete:false,degraded:true});expect(restored.message).toContain('Degraded import complete');expect(restored.warnings!.length).toBeGreaterThan(0);
  });
  it('a partial category selection keeps the old portable format and does not import unrelated SQL material',async()=>{
    await source();
    const exported=await exportDataBackup({destination:'internal',categories:['promptPresets']});
    const zip=await JSZip.loadAsync(await fs.readFile(exported.path!));expect(zip.file('library/manifest.json')).toBeNull();expect(exported).toMatchObject({complete:true,degraded:false});
    const destination=await fixture();
    const restored=await importDataBackup({path:exported.path!,categories:['promptPresets'],confirmConfigurationOverwrite:false});
    expect(restored.ok,restored.message).toBe(true);expect(destination.repository.all('history')).toEqual([]);expect(destination.repository.all('note')).toEqual([]);
    expect(mock.state.settings.promptTemplates[0].id).toBe('template-1');expect(destination.repository.all('style_preset').map(item=>item.id)).toEqual(['style-1']);
  });
  it('tracks a missing portable image inside a partial selected-category scope',async()=>{
    await source(true);const exported=await exportDataBackup({destination:'internal',categories:['imageHistory']});expect(exported).toMatchObject({ok:true,complete:false,degraded:true});expect(exported.integrityReasons?.map(value=>value.code)).toContain('portable-assets-missing:imageHistory');
    const zip=await JSZip.loadAsync(await fs.readFile(exported.path!)),manifest=JSON.parse(await zip.file('manifest.json')!.async('string'));manifest.integrity={scope:'selected-categories',complete:true,degraded:false,reasons:[]};zip.file('manifest.json',JSON.stringify(manifest));await fs.writeFile(exported.path!,await zip.generateAsync({type:'nodebuffer'}));mock.showOpenDialog.mockResolvedValueOnce({canceled:false,filePaths:[exported.path!]});expect(await inspectDataBackup()).toMatchObject({ok:true,complete:false,degraded:true});
  });
  it('keeps a historical generation recipe on legacy assembly when configuration backup omits the version marker',async()=>{
    await fixture();mock.state.settings.lastGenerationState={params:{model:'nai-diffusion-5-full',positivePrompt:'red mug, red mug',negativePrompt:'',stylePrompt:'red mug',seed:7,preservePromptText:false}};
    const exported=await exportDataBackup({destination:'internal',categories:['configuration']});
    await fixture();mock.state.settings.lastGenerationState={params:{...mock.state.settings.lastGenerationState?.params,promptAssemblyVersion:1}};
    const restored=await importDataBackup({path:exported.path!,categories:['configuration'],confirmConfigurationOverwrite:true});
    expect(restored.ok,restored.message).toBe(true);expect(Object.hasOwn(mock.state.settings.lastGenerationState.params,'promptAssemblyVersion')).toBe(false);
  });
  it('never writes credential sentinels to automatic or rescue archives and requires explicit manual confirmation',async()=>{
    await fixture();const sentinel='TOKEN-SENTINEL-NEVER-IMPLICIT';mock.state.token=sentinel;mock.state.account={accessToken:sentinel};
    const automatic=await exportDataBackup({destination:'automatic',categories:['apiCredentials','configuration'],confirmApiCredentialsExport:true});expect(automatic.ok).toBe(true);expect(await zipTextContains(automatic.path!,sentinel)).toBe(false);const automaticZip=await JSZip.loadAsync(await fs.readFile(automatic.path!)),automaticManifest=JSON.parse(await automaticZip.file('manifest.json')!.async('string'));expect(automaticManifest.categories.map((value:any)=>value.category)).not.toContain('apiCredentials');
    const refused=await exportDataBackup({destination:'internal',categories:['apiCredentials']});expect(refused.ok).toBe(false);expect(refused).toMatchObject({code:'backup_credentials_confirmation_required',message:expect.stringContaining('second confirmation')});
    const manual=await exportDataBackup({destination:'internal',categories:['apiCredentials'],confirmApiCredentialsExport:true});expect(manual.ok).toBe(true);expect(await zipTextContains(manual.path!,sentinel)).toBe(true);
    const portable=await exportDataBackup({destination:'internal',categories:['configuration']});const restored=await importDataBackup({path:portable.path!,categories:['configuration'],confirmConfigurationOverwrite:true});expect(restored.ok).toBe(true);expect(await zipTextContains(restored.rescueBackupPath!,sentinel)).toBe(false);
  });
  it('blocks every mutation when the committed rescue archive is incomplete and preserves it for inspection',async()=>{
    await fixture();mock.state.settings.language='en-US';const incoming=await exportDataBackup({destination:'internal',categories:['configuration']});
    const destination=await source(true);mock.state.settings.language='zh-CN';const before=JSON.stringify(mock.state),versions=destination.repository.readVersions('history','history-1').length;
    const result=await importDataBackup({path:incoming.path!,categories:['configuration'],confirmConfigurationOverwrite:true});expect(result).toMatchObject({ok:false,imported:0,degraded:true});expect(result).toMatchObject({code:'backup_rescue_incomplete',message:expect.stringContaining('safety backup before the import is incomplete')});expect(result.rescueBackupPath).toBeTruthy();expect(JSON.stringify(mock.state)).toBe(before);expect(destination.repository.readVersions('history','history-1')).toHaveLength(versions);
    const rescue=await JSZip.loadAsync(await fs.readFile(result.rescueBackupPath!)),manifest=JSON.parse(await rescue.file('manifest.json')!.async('string'));expect(manifest.integrity).toMatchObject({complete:false,degraded:true});expect(manifest.integrity.reasons.map((value:any)=>value.code)).toContain('library-assets-missing');
  });
  it('derives missing files even when top-level complete is forged',async()=>{
    await source(true);
    const exported=await exportDataBackup({destination:'internal',categories:[...categories]});expect(exported).toMatchObject({complete:false,degraded:true});
    const zip=await JSZip.loadAsync(await fs.readFile(exported.path!)),manifest=JSON.parse(await zip.file('manifest.json')!.async('string'));manifest.integrity={scope:'selected-categories',complete:true,degraded:false,reasons:[]};zip.file('manifest.json',JSON.stringify(manifest));await fs.writeFile(exported.path!,await zip.generateAsync({type:'nodebuffer'}));
    mock.showOpenDialog.mockResolvedValueOnce({canceled:false,filePaths:[exported.path!]});const inspected=await inspectDataBackup();expect(inspected).toMatchObject({ok:true,complete:false,degraded:true});expect(inspected.integrityReasons?.map(value=>value.code)).toEqual(expect.arrayContaining(['library-assets-missing']));
  });
  it.each(['missing','top-level-array','wrong-key-array','empty-object'] as const)('rejects a declared prompt carrier with %s before rescue or any publication',async failure=>{
    await source();const exported=await exportDataBackup({destination:'internal',categories:[...categories]}),base=await fs.readFile(exported.path!),zip=await JSZip.loadAsync(base),manifest=JSON.parse(await zip.file('manifest.json')!.async('string'));expect(manifest.categories.find((value:any)=>value.category==='promptPresets').items).toBe(2);
    if(failure==='missing')zip.remove('data/prompt-presets.json');else if(failure==='top-level-array')zip.file('data/prompt-presets.json','[]');else zip.file('data/prompt-presets.json',JSON.stringify({promptTemplates:failure==='wrong-key-array'?{}:[],stylePromptPresetGroups:[],stylePromptPresets:[],positivePromptPresets:[],promptChunks:[]}));const broken=path.join(path.dirname(exported.path!),`broken-${failure}.naisbackup`);await fs.writeFile(broken,await zip.generateAsync({type:'nodebuffer'}));
    mock.showOpenDialog.mockResolvedValueOnce({canceled:false,filePaths:[broken]});const inspected=await inspectDataBackup();expect(inspected.ok).toBe(false);expect(inspected.message).toMatch(/prompt-presets|promptTemplates|structure|counts/);
    const destination=await fixture(),beforeState=JSON.stringify(mock.state),beforeRows=destination.repository.all(),backupDir=path.join(destination.userDataRoot,'backups'),beforeFiles=await fs.readdir(backupDir).catch(()=>[]);const restored=await importDataBackup({path:broken,categories:[...categories],confirmConfigurationOverwrite:false,confirmDegradedImport:true});expect(restored).toMatchObject({ok:false,imported:0,skipped:0,renamed:0});expect(restored.rescueBackupPath).toBeUndefined();expect(JSON.stringify(mock.state)).toBe(beforeState);expect(destination.repository.all()).toEqual(beforeRows);expect(await fs.readdir(backupDir).catch(()=>[])).toEqual(beforeFiles);
  });
  it('refuses an archive whose integrity conclusion was removed, even with a forged empty payload',async()=>{
    await source();const exported=await exportDataBackup({destination:'internal',categories:[...categories]}),zip=await JSZip.loadAsync(await fs.readFile(exported.path!)),manifest=JSON.parse(await zip.file('manifest.json')!.async('string'));expect(manifest.categories.find((value:any)=>value.category==='promptPresets').items).toBe(2);delete manifest.integrity;zip.file('manifest.json',JSON.stringify(manifest));zip.file('data/prompt-presets.json','{}');const broken=path.join(path.dirname(exported.path!),'legacy-empty-prompt.naisbackup');await fs.writeFile(broken,await zip.generateAsync({type:'nodebuffer'}));
    mock.showOpenDialog.mockResolvedValueOnce({canceled:false,filePaths:[broken]});expect(await inspectDataBackup()).toMatchObject({ok:false});const destination=await fixture(),beforeState=JSON.stringify(mock.state),beforeRows=destination.repository.all(),backupDir=path.join(destination.userDataRoot,'backups');const restored=await importDataBackup({path:broken,categories:[...categories],confirmConfigurationOverwrite:false,confirmDegradedImport:true});expect(restored).toMatchObject({ok:false,imported:0});expect(restored.rescueBackupPath).toBeUndefined();expect(JSON.stringify(mock.state)).toBe(beforeState);expect(destination.repository.all()).toEqual(beforeRows);expect(await fs.readdir(backupDir).catch(()=>[])).toEqual([]);
  });
  it('checks portable asset declared bytes against the actual blob before rescue',async()=>{
    await source();const exported=await exportDataBackup({destination:'internal',categories:['imageHistory']}),zip=await JSZip.loadAsync(await fs.readFile(exported.path!)),payload=JSON.parse(await zip.file('data/image-history.json')!.async('string')),manifest=JSON.parse(await zip.file('manifest.json')!.async('string')),actual=payload.items[0].asset.bytes;expect(actual).toBeGreaterThan(1);payload.items[0].asset.bytes=1;manifest.categories.find((value:any)=>value.category==='imageHistory').bytes=1;zip.file('data/image-history.json',JSON.stringify(payload));zip.file('manifest.json',JSON.stringify(manifest));const broken=path.join(path.dirname(exported.path!),'forged-asset-bytes.naisbackup');await fs.writeFile(broken,await zip.generateAsync({type:'nodebuffer'}));
    mock.showOpenDialog.mockResolvedValueOnce({canceled:false,filePaths:[broken]});const inspected=await inspectDataBackup();expect(inspected.ok).toBe(false);expect(inspected.message).toMatch(/size|checksum/);const destination=await fixture(),beforeState=JSON.stringify(mock.state),beforeRows=destination.repository.all(),backupDir=path.join(destination.userDataRoot,'backups');const restored=await importDataBackup({path:broken,categories:['imageHistory'],confirmConfigurationOverwrite:false,confirmDegradedImport:true});expect(restored).toMatchObject({ok:false,imported:0});expect(restored.rescueBackupPath).toBeUndefined();expect(JSON.stringify(mock.state)).toBe(beforeState);expect(destination.repository.all()).toEqual(beforeRows);expect(await fs.readdir(backupDir).catch(()=>[])).toEqual([]);
  });
  it('does not let degraded confirmation bypass a corrupt declared blob or create a rescue side effect',async()=>{
    await source();const exported=await exportDataBackup({destination:'internal',categories:[...categories]}),zip=await JSZip.loadAsync(await fs.readFile(exported.path!)),blob=Object.keys(zip.files).find(name=>/^library\/blobs\/[a-f0-9]{64}$/.test(name))!;zip.file(blob,Buffer.from('corrupt'));await fs.writeFile(exported.path!,await zip.generateAsync({type:'nodebuffer'}));
    await fixture();const before=JSON.stringify(mock.state);const result=await importDataBackup({path:exported.path!,categories:[...categories],confirmConfigurationOverwrite:false,confirmDegradedImport:true});expect(result.ok).toBe(false);expect(result.message).toMatch(/SHA-256|checksum/);expect(result.rescueBackupPath).toBeUndefined();expect(JSON.stringify(mock.state)).toBe(before);
  });
  it('inspects through the bounded reader without invoking the legacy JSZip loader',async()=>{
    await fixture();const exported=await exportDataBackup({destination:'internal',categories:['configuration']});mock.showOpenDialog.mockResolvedValueOnce({canceled:false,filePaths:[exported.path!]});const legacyReader=vi.spyOn(JSZip,'loadAsync').mockRejectedValue(new Error('legacy JSZip reader must not run'));
    try{expect(await inspectDataBackup()).toMatchObject({ok:true,categories:[{category:'configuration'}]});}finally{legacyReader.mockRestore();}
  });
  it('rejects an explicitly invalid assembly marker in a real configuration restore without mutating the target store',async()=>{
    await fixture();mock.state.settings.lastGenerationState={params:{promptAssemblyVersion:2},inpaintRecipe:{...DEFAULT_PARAMS,promptAssemblyVersion:1}};const exported=await exportDataBackup({destination:'internal',categories:['configuration']});expect(exported.ok).toBe(true);
    await fixture();const before=structuredClone(mock.state);const restored=await importDataBackup({path:exported.path!,categories:['configuration'],confirmConfigurationOverwrite:true});
    expect(restored.ok).toBe(false);expect(restored.message).toContain('promptAssemblyVersion');expect(mock.state).toEqual(before);
  });
  it('preflights nested inpaint params before a selected image-history category can publish files or store rows',async()=>{
    await source();mock.state.settings.lastGenerationState={params:{...DEFAULT_PARAMS,promptAssemblyVersion:1},inpaintRecipe:{...DEFAULT_PARAMS,promptAssemblyVersion:2}};
    const exported=await exportDataBackup({destination:'internal',categories:['imageHistory','configuration']});expect(exported.ok).toBe(true);
    await fixture();const before=structuredClone(mock.state),outputDir=mock.state.settings.outputDir,beforeFiles=await fs.readdir(outputDir);
    const restored=await importDataBackup({path:exported.path!,categories:['imageHistory','configuration'],confirmConfigurationOverwrite:true});
    expect(restored.ok).toBe(false);expect(restored.message).toContain('promptAssemblyVersion');expect(mock.state).toEqual(before);expect(await fs.readdir(outputDir)).toEqual(beforeFiles);
  });
  it('rejects an invalid configuration-nested inpaint recipe beside a valid generation params carrier',async()=>{
    await fixture();mock.state.settings.lastGenerationState={params:{...DEFAULT_PARAMS,promptAssemblyVersion:1},inpaintRecipe:{...DEFAULT_PARAMS,promptAssemblyVersion:null}};
    const exported=await exportDataBackup({destination:'internal',categories:['configuration']}),zip=await JSZip.loadAsync(await fs.readFile(exported.path!));expect(zip.file('data/generation-params.json')).not.toBeNull();
    await fixture();const before=structuredClone(mock.state);const restored=await importDataBackup({path:exported.path!,categories:['configuration'],confirmConfigurationOverwrite:true});
    expect(restored.ok).toBe(false);expect(restored.message).toContain('promptAssemblyVersion');expect(mock.state).toEqual(before);
  });
  it('validates the current nested inpaint fallback when an independent params carrier exists but configuration has no last-generation state',async()=>{
    await fixture();delete mock.state.settings.lastGenerationState;const exported=await exportDataBackup({destination:'internal',categories:['configuration']});
    await fixture();mock.state.settings.lastGenerationState={params:{...DEFAULT_PARAMS,promptAssemblyVersion:1},inpaintRecipe:{...DEFAULT_PARAMS,promptAssemblyVersion:false}};const before=structuredClone(mock.state);
    const restored=await importDataBackup({path:exported.path!,categories:['configuration'],confirmConfigurationOverwrite:true});expect(restored.ok).toBe(false);expect(restored.message).toContain('promptAssemblyVersion');expect(mock.state).toEqual(before);
  });
  it('accepts literal-v1 base params with a marker-less strict inpaint recipe and preserves both forms',async()=>{
    await fixture();const strictInpaint:any={...DEFAULT_PARAMS,preservePromptText:true};delete strictInpaint.promptAssemblyVersion;mock.state.settings.lastGenerationState={params:{...DEFAULT_PARAMS,promptAssemblyVersion:1},inpaintRecipe:strictInpaint};
    const exported=await exportDataBackup({destination:'internal',categories:['configuration']});await fixture();const restored=await importDataBackup({path:exported.path!,categories:['configuration'],confirmConfigurationOverwrite:true});
    expect(restored.ok,restored.message).toBe(true);expect(mock.state.settings.lastGenerationState.params.promptAssemblyVersion).toBe(1);expect(mock.state.settings.lastGenerationState.inpaintRecipe.preservePromptText).toBe(true);expect(mock.state.settings.lastGenerationState.inpaintRecipe).not.toHaveProperty('promptAssemblyVersion');
  });
  it('refuses an archive without an integrity conclusion before any rescue or write',async()=>{
    await fixture();const exported=await exportDataBackup({destination:'internal',categories:['configuration']}),zip=await JSZip.loadAsync(await fs.readFile(exported.path!)),manifest=JSON.parse(await zip.file('manifest.json')!.async('string'));delete manifest.integrity;zip.file('manifest.json',JSON.stringify(manifest));await fs.writeFile(exported.path!,await zip.generateAsync({type:'nodebuffer'}));
    mock.showOpenDialog.mockResolvedValueOnce({canceled:false,filePaths:[exported.path!]});expect(await inspectDataBackup()).toMatchObject({ok:false,code:'backup_read_failed',details:{detail:{code:'backup_invalid_archive',reason:'backup.integrity_invalid'}},message:expect.stringContaining('The backup integrity record is invalid')});
    const before=structuredClone(mock.state);const refused=await importDataBackup({path:exported.path!,categories:['configuration'],confirmConfigurationOverwrite:true,confirmDegradedImport:true});expect(refused).toMatchObject({ok:false,imported:0});expect(refused.rescueBackupPath).toBeUndefined();expect(mock.state).toEqual(before);
  });
});

describe('character persistence through existing backup and repository routes', () => {
  const captions = [
    { prompt: '  adult gardener, adult gardener  \n', negativePrompt: ' hat, hat ', useCoords: true, x: 0, y: 1 },
    { prompt: '  adult gardener, adult gardener  \n', negativePrompt: '', useCoords: false, x: .25, y: .75 },
  ];
  it('retains the entire editing group and disabled switch through configuration backup/import', async () => {
    await fixture();
    mock.state.settings.persistGenerateParams = false;
    mock.state.settings.lastGenerationState = { params: { ...DEFAULT_PARAMS }, charCaptions: captions };
    const exported = await exportDataBackup({ destination: 'internal', categories: ['configuration'] });
    expect(exported.ok, exported.message).toBe(true);
    await fixture();
    const restored = await importDataBackup({ path: exported.path!, categories: ['configuration'], confirmConfigurationOverwrite: true });
    expect(restored.ok, restored.message).toBe(true);
    expect(mock.state.settings.lastGenerationState.charCaptions).toEqual(captions);
    expect(mock.state.settings.persistGenerateParams).toBe(false);
  });
  it.each(['portable', 'sql'] as const)('retains new and old rows without inventing snapshots through %s history backup', async route => {
    const origin = await source();
    const previous = origin.repository.get('history', 'history-1')!.payload;
    const characterSnapshot = { version: 1, captions };
    origin.repository.put('history', 'history-1', { ...previous, characterSnapshot, characterPrompts: ['adult gardener'] });
    const selected = route === 'sql' ? [...categories] : ['imageHistory' as const];
    const exported = await exportDataBackup({ destination: 'internal', categories: selected });
    expect(exported.ok, exported.message).toBe(true);
    const destination = await fixture();
    const restored = await importDataBackup({ path: exported.path!, categories: selected, confirmConfigurationOverwrite: false });
    expect(restored.ok, restored.message).toBe(true);
    expect(destination.repository.get('history', 'history-1')!.payload.characterSnapshot).toEqual(characterSnapshot);
    expect(destination.repository.get('history', 'history-1')!.payload.characterPrompts).toEqual(['adult gardener']);
    if (route === 'sql') {
      expect(destination.repository.get('history', 'history-1')!.payload.characterSnapshot).toEqual(characterSnapshot);
      expect(destination.repository.get('history', 'history-1', 3)!.payload).not.toHaveProperty('characterSnapshot');
    }
  });
  it('rejects malformed configuration characters before publishing selected history or params', async () => {
    await source();
    mock.state.settings.lastGenerationState = { params: { ...DEFAULT_PARAMS }, charCaptions: [{ ...captions[0], x: null }] };
    const exported = await exportDataBackup({ destination: 'internal', categories: ['configuration', 'imageHistory'] });
    expect(exported.ok).toBe(true);
    const destination = await fixture(), before = structuredClone(mock.state);
    const restored = await importDataBackup({ path: exported.path!, categories: ['configuration', 'imageHistory'], confirmConfigurationOverwrite: true });
    expect(restored.ok).toBe(false); expect(restored.message).toContain('character snapshot'); expect(hostMessageText(restored, 'zh-CN')).toContain('角色快照'); expect(hostMessageText(restored, 'en-US')).not.toMatch(/[\u4e00-\u9fff]/);
    expect(mock.state).toEqual(before);
    expect(destination.repository.all('history')).toEqual([]);
  });
});

it('a per-category import refuses a history record that is no valid stored record before writing any image or row, naming it and the field', async () => {
  await source();
  const exported = await exportDataBackup({ destination: 'internal', categories: ['imageHistory', 'promptPresets'] });
  const zip = await JSZip.loadAsync(await fs.readFile(exported.path!));
  const data = JSON.parse(await zip.file('data/image-history.json')!.async('string'));
  data.items[0].params = { ...data.items[0].params, steps: '28' };
  zip.file('data/image-history.json', JSON.stringify(data));
  await fs.writeFile(exported.path!, await zip.generateAsync({ type: 'nodebuffer' }));
  const destination = await fixture(), before = structuredClone(mock.state);
  const restored = await importDataBackup({ path: exported.path!, categories: ['imageHistory', 'promptPresets'], confirmConfigurationOverwrite: false });
  expect(restored.ok).toBe(false);
  expect(restored.message).toMatch(/The history record "history-1" in the backup is not a valid material record; no material was written: .*params\/steps/);
  expect(restored).toMatchObject({ code: 'backup_import_aborted', reason: 'backup.import_aborted', details: { detail: { code: 'backup_invalid_record', reason: 'backup.invalid_record.history', params: { id: '"history-1"' } } } });
  // Refused before its image was written (no image had to be removed again).
  expect(restored.message).not.toMatch(/written but not saved/);
  expect(mock.state).toEqual(before);
  expect(destination.repository.all()).toEqual([]);
  expect(await fs.readdir(mock.state.settings.outputDir)).toEqual([]);
});

it.each([
  ['a prompt chunk, checked where the records are written', 'promptChunks', 'prompt chunk'],
  ['a style preset, checked before its preview files are written', 'stylePromptPresets', 'style preset'],
] as const)('a per-category import checks every record it would write before the first write: %s', async (_label, list, name) => {
  await source();
  const exported = await exportDataBackup({ destination: 'internal', categories: ['imageHistory', 'promptPresets'] });
  const zip = await JSZip.loadAsync(await fs.readFile(exported.path!));
  const presets = JSON.parse(await zip.file('data/prompt-presets.json')!.async('string'));
  if (list === 'promptChunks') presets.promptChunks = [{ id: 'chunk-1', name: 'Light', content: 'soft light', createdAt: now, updatedAt: now }];
  // An identity that is not a string: the record the import would add is not a valid stored record.
  presets[list][0].id = 123;
  zip.file('data/prompt-presets.json', JSON.stringify(presets));
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
  manifest.categories.find((value: any) => value.category === 'promptPresets').items = presets.promptTemplates.length + presets.stylePromptPresets.length + presets.positivePromptPresets.length + presets.promptChunks.length;
  zip.file('manifest.json', JSON.stringify(manifest));
  await fs.writeFile(exported.path!, await zip.generateAsync({ type: 'nodebuffer' }));
  const destination = await fixture(), before = structuredClone(mock.state), revision = destination.repository.getRevision();
  const restored = await importDataBackup({ path: exported.path!, categories: ['imageHistory', 'promptPresets'], confirmConfigurationOverwrite: false });
  expect(restored.ok, restored.message).toBe(false);
  expect(restored.message).toMatch(new RegExp(`The ${name} 123 in the backup is not a valid material record; no material was written: .*/id`));
  // Nothing of the import was written: not the history record of the same import (its image file is removed again), no preset, no setting.
  expect(destination.repository.all()).toEqual([]);
  expect(destination.repository.getRevision()).toBe(revision);
  expect(mock.state).toEqual(before);
  expect(await fs.readdir(mock.state.settings.outputDir)).toEqual([]);
  expect(await fs.readdir(destination.userDataRoot)).not.toContain('style-prompt-previews');
});

it('createdFolderPath turns the long-path forms Node returns on Windows back into plain paths', () => {
  expect(createdFolderPath(undefined)).toBeUndefined();
  if (process.platform === 'win32') {
    expect(createdFolderPath('\\\\?\\C:\\data\\output\\2026-11-05')).toBe('C:\\data\\output\\2026-11-05');
    expect(createdFolderPath('\\\\?\\UNC\\server\\share\\output')).toBe('\\\\server\\share\\output');
    expect(createdFolderPath('C:\\data\\output')).toBe('C:\\data\\output');
  } else {
    expect(createdFolderPath('\\\\?\\/data/output/2026-11-05')).toBe('/data/output/2026-11-05');
    expect(createdFolderPath('/data/output')).toBe('/data/output');
  }
});

it('an aborted import never removes folders above the ones it created, also when mkdir names them in the Windows long-path form', async () => {
  await source();
  const exported = await exportDataBackup({ destination: 'internal', categories: ['imageHistory', 'promptPresets'] });
  const zip = await JSZip.loadAsync(await fs.readFile(exported.path!));
  const presets = JSON.parse(await zip.file('data/prompt-presets.json')!.async('string'));
  presets.stylePromptPresets[0].id = 123;
  zip.file('data/prompt-presets.json', JSON.stringify(presets));
  await fs.writeFile(exported.path!, await zip.generateAsync({ type: 'nodebuffer' }));
  await fixture();
  // Node on Windows returns the first created folder as \\?\C:\…; here every platform gets that prefix.
  const mkdir = fs.mkdir.bind(fs), prefix = '\\\\?\\';
  const spy = vi.spyOn(fs, 'mkdir').mockImplementation((async (...args: Parameters<typeof fs.mkdir>) => { const created = await mkdir(...args); return typeof created === 'string' && !created.startsWith(prefix) ? `${prefix}${created}` : created; }) as typeof fs.mkdir);
  let restored, created = 0;
  try { restored = await importDataBackup({ path: exported.path!, categories: ['imageHistory', 'promptPresets'], confirmConfigurationOverwrite: false }); }
  finally { created = (await Promise.all(spy.mock.results.map(result => result.value))).filter(value => typeof value === 'string').length; spy.mockRestore(); }
  expect(restored.ok).toBe(false);
  expect(created, 'the import created folders (and removed them again)').toBeGreaterThan(0);
  // The output folder (which existed before) is still there, and empty again.
  expect(await fs.readdir(mock.state.settings.outputDir)).toEqual([]);
});

it('preflights malformed portable history snapshots before writing any images or rows', async () => {
  await source();
  const exported = await exportDataBackup({ destination: 'internal', categories: ['imageHistory'] });
  const zip = await JSZip.loadAsync(await fs.readFile(exported.path!));
  const data = JSON.parse(await zip.file('data/image-history.json')!.async('string'));
  data.items[0].characterSnapshot = { version: 2, captions: [] };
  zip.file('data/image-history.json', JSON.stringify(data));
  await fs.writeFile(exported.path!, await zip.generateAsync({ type: 'nodebuffer' }));
  const destination = await fixture(), before = structuredClone(mock.state);
  const restored = await importDataBackup({ path: exported.path!, categories: ['imageHistory'], confirmConfigurationOverwrite: false });
  expect(restored.ok).toBe(false); expect(restored.message).toContain('character snapshot'); expect(hostMessageText(restored, 'zh-CN')).toContain('角色快照'); expect(hostMessageText(restored, 'en-US')).not.toMatch(/[\u4e00-\u9fff]/);
  expect(mock.state).toEqual(before);
  expect(destination.repository.all('history')).toEqual([]);
  expect(await fs.readdir(mock.state.settings.outputDir)).toEqual([]);
});


it.each(['portable', 'sql'] as const)('round-trips favorite.image authored character snapshots through %s backup', async route => {
  const origin = await source();
  const image = { ...origin.repository.get('history', 'history-1')!.payload, characterSnapshot };
  await saveArtistFavoriteCollection(origin.userDataRoot, 'random', [{ id: 'favorite', artists: [], auxiliary: [], mutations: [], franchiseStyles: [], basePrompt: 'garden', prompt: 'watercolor', pairId: 'pair', variant: 'plain', sequence: 1, status: 'done', image }]);
  const selected = route === 'sql' ? [...categories] : ['artistLibrary' as const];
  const exported = await exportDataBackup({ destination: 'internal', categories: selected });
  expect(exported.ok, exported.message).toBe(true);
  const destination = await fixture();
  const restored = await importDataBackup({ path: exported.path!, categories: selected, confirmConfigurationOverwrite: false });
  expect(restored.ok, restored.message).toBe(true);
  const favorites = await loadArtistFavoriteLibrary(destination.userDataRoot);
  const savedImage = (favorites.collections.random[0] as any).image;
  expect(savedImage.characterSnapshot).toEqual(characterSnapshot);
  expect(savedImage.params).toEqual(image.params);
  expect(await fs.readFile(savedImage.filePath, 'utf8')).toBe('SFW image fixture');
});

it('rejects damaged SQL character snapshots before database, configuration or asset publication', async () => {
  await source();
  const exported = await exportDataBackup({ destination: 'internal', categories: [...categories] });
  expect(exported.ok).toBe(true);
  const zip = await JSZip.loadAsync(await fs.readFile(exported.path!));
  const manifest = JSON.parse(await zip.file('library/manifest.json')!.async('string'));
  manifest.snapshot.items.find((item: any) => item.kind === 'history').payload.characterSnapshot = { version: 1, captions: [{ ...characterSnapshot.captions[0], x: null }] };
  zip.file('library/manifest.json', JSON.stringify(manifest));
  await fs.writeFile(exported.path!, await zip.generateAsync({ type: 'nodebuffer' }));
  const target = await fixture(), before = structuredClone(mock.state), beforeSQL = target.repository.exportSnapshot();
  const restored = await importDataBackup({ path: exported.path!, categories: [...categories], confirmConfigurationOverwrite: false });
  expect(restored.ok).toBe(false); expect(restored.message).toContain('characterSnapshot');
  expect(restored.imported).toBe(0); expect(restored.rescueBackupPath).toBeUndefined();
  expect(mock.state).toEqual(before); expect(target.repository.exportSnapshot()).toEqual(beforeSQL);
  expect(await fs.readdir(mock.state.settings.outputDir)).toEqual([]);
  expect(await fs.readdir(target.libraryDirectory)).toEqual([]);
});

describe('archives with content this version does not know', () => {
  it('keeps this device\'s folders when restoring a configuration from another machine', async () => {
    await fixture(); Object.assign(mock.state.settings, { logDir: '/other-machine/logs', language: 'en-US' });
    const exported = await exportDataBackup({ destination: 'internal', categories: ['configuration'] });
    expect(exported.ok, exported.message).toBe(true);
    const zip = await JSZip.loadAsync(await fs.readFile(exported.path!));
    expect(JSON.parse(await zip.file('data/configuration.json')!.async('string')).logDir).toBe('/other-machine/logs');
    await fixture(); Object.assign(mock.state.settings, { logDir: '/this-device/logs' });
    const { outputDir, backupDir } = mock.state.settings;
    const restored = await importDataBackup({ path: exported.path!, categories: ['configuration'], confirmConfigurationOverwrite: true });
    expect(restored.ok, restored.message).toBe(true);
    expect(mock.state.settings.language).toBe('en-US');
    expect(mock.state.settings).toMatchObject({ logDir: '/this-device/logs', outputDir, backupDir });
  });
  it('refuses an archive that lists a category this version does not know', async () => {
    await fixture();
    const exported = await exportDataBackup({ destination: 'internal', categories: ['configuration'] });
    expect(exported.ok, exported.message).toBe(true);
    const zip = await JSZip.loadAsync(await fs.readFile(exported.path!)), manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    zip.file('data/unknown-feature.json', JSON.stringify({ version: 1, entries: [] })); manifest.categories.push({ category: 'unknownFeature', items: 0, bytes: 0 });
    zip.file('manifest.json', JSON.stringify(manifest));
    await fs.writeFile(exported.path!, await zip.generateAsync({ type: 'nodebuffer' }));
    mock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [exported.path!] });
    expect(await inspectDataBackup()).toMatchObject({ ok: false, code: 'backup_read_failed', message: expect.stringContaining('The backup category list is invalid') });
    const before = structuredClone(mock.state);
    expect(await importDataBackup({ path: exported.path!, categories: ['configuration'], confirmConfigurationOverwrite: true })).toMatchObject({ ok: false, imported: 0 });
    expect(mock.state).toEqual(before);
  });
  it('restores only the credential keys it knows from an API credentials carrier', async () => {
    await fixture(); mock.state.token = 'fixture-token'; mock.state.settings.language = 'en-US';
    const exported = await exportDataBackup({ destination: 'internal', categories: ['configuration', 'apiCredentials', 'workspaceData'], confirmApiCredentialsExport: true, workspaceData: { 'mcp-for-novelai.kept': '1' } });
    expect(exported.ok, exported.message).toBe(true);
    const zip = await JSZip.loadAsync(await fs.readFile(exported.path!)), manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    const credentials = JSON.parse(await zip.file('data/api-credentials.json')!.async('string'));
    credentials.settings = { ...credentials.settings, apiBaseUrl: 'https://api.novelai.net', otherServiceApiKey: 'enc:v1:b2xk', otherPlainKey: 'plain-other-key' };
    zip.file('data/api-credentials.json', JSON.stringify(credentials));
    manifest.categories.find((item: any) => item.category === 'apiCredentials').items = Object.keys(credentials.settings).length + 1;
    zip.file('manifest.json', JSON.stringify(manifest));
    await fs.writeFile(exported.path!, await zip.generateAsync({ type: 'nodebuffer' }));

    await fixture(); mock.state.settings.language = 'zh-CN';
    const restored = await importDataBackup({ path: exported.path!, categories: ['configuration', 'apiCredentials', 'workspaceData'], confirmConfigurationOverwrite: true });
    expect(restored.ok, restored.message).toBe(true);
    expect(restored.workspaceData).toEqual({ 'mcp-for-novelai.kept': '1' });
    expect(mock.state.settings.language).toBe('en-US');
    expect(mock.state.token).toBe('fixture-token');
    expect(mock.state.settings.apiBaseUrl).toBe('https://api.novelai.net');
    for (const key of ['otherServiceApiKey', 'otherPlainKey']) expect(Object.hasOwn(mock.state.settings, key), key).toBe(false);
  });
});

describe('backup format name', () => {
  async function rewrite(file: string, change: (zip: JSZip, manifest: any) => Promise<void> | void) {
    const zip = await JSZip.loadAsync(await fs.readFile(file)), manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    await change(zip, manifest);
    zip.file('manifest.json', JSON.stringify(manifest));
    await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
  }
  it('writes its format name and restores its own renderer state under the current key prefix', async () => {
    await fixture();
    const exported = await exportDataBackup({ destination: 'internal', categories: ['configuration', 'workspaceData'], workspaceData: { 'mcp-for-novelai.ws.left': '300', 'foreign.key': 'x' } });
    expect(exported.ok, exported.message).toBe(true);
    const written = await JSZip.loadAsync(await fs.readFile(exported.path!));
    expect(JSON.parse(await written.file('manifest.json')!.async('string')).format).toBe('mcp-for-novelai-backup');
    expect(JSON.parse(await written.file('data/workspace.json')!.async('string'))).toEqual({ 'mcp-for-novelai.ws.left': '300' });
    const current = await importDataBackup({ path: exported.path!, categories: ['configuration', 'workspaceData'], confirmConfigurationOverwrite: true });
    expect(current.ok, current.message).toBe(true);
    expect(current.workspaceData).toEqual({ 'mcp-for-novelai.ws.left': '300' });
  });
  it('refuses an archive of any other format name', async () => {
    await fixture();
    const exported = await exportDataBackup({ destination: 'internal', categories: ['configuration'] });
    await rewrite(exported.path!, (_zip, manifest) => { manifest.format = 'some-other-backup'; });
    mock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [exported.path!] });
    expect(await inspectDataBackup()).toMatchObject({ ok: false, code: 'backup_read_failed', details: { detail: { reason: 'backup.format_unsupported' } }, message: expect.stringContaining('The backup format or version is not supported') });
  });
});
