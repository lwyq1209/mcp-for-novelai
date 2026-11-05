import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import { contractSchemas, validateContract, validateMaterialRequest } from '../contracts/validate.mjs';
import { TOOL_DEFINITIONS } from '../src/mcp.mjs';
import { materialToolAction } from '../src/material-tools.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const now = '2026-09-12T12:00:00.000Z';
const params = {
  model:'nai-diffusion-5-full',stylePrompt:'watercolor',positivePrompt:'a red mug',negativePrompt:'low quality',
  width:832,height:1216,steps:28,cfgScale:6,cfgRescale:0,sampler:'k_euler_ancestral',noiseSchedule:'karras',
  seed:42,seedMode:'fixed',ucPreset:2,qualityPreset:'standard',qualityToggle:true,transparentBackground:false,
  smea:false,smeaDyn:false,variety:false,fileNamePrefix:'fixture',preservePromptText:true,promptAssemblyVersion:1,
  metadataReplay:{model:'nai-diffusion-5-full',parameters:{straight_alpha:false,uncond_scale:1,cfg_sched_eligibility:'enable'},positive:{use_order:true},negative:{legacy_uc:false},keepEmptyNegativeCharacters:true},
};
const history = {id:'image-1',filePath:'/fixture/image.png',fileUrl:'file:///fixture/image.png',date:now,createdAt:now,groupId:'group-1',params,actualSeed:42,model:params.model,width:832,height:1216,feature:'illustration',generationOrigin:{jobId:'job-1',mode:'t2i',originWorkspaceId:'workspace-1',submittedRevision:5,actualSeed:42}};
const material = {schemaVersion:1,id:'material-1',revision:2,name:'Visual material',group:'bench',notes:' Keep exact\nsource text. ',archived:false,createdAt:now,updatedAt:now};
const token = {raw:'1.2::watercolor::',value:'watercolor',weight:1.2,kind:'style'};
const preview = {id:'preview-1',name:'sample',filePath:'/fixture/preview.webp',fileUrl:'file:///fixture/preview.webp',createdAt:now};
const payloads = {
  tag:{...material,kind:'tag',tag:{text:'watercolor',source:'danbooru',category:'general',target:'style',evidence:{checkedAt:now,canonicalName:'watercolor',resolution:'canonical',tagStatus:'active',category:'general',postCount:123,deprecated:false,aliasStatus:'none',aliases:[{from:'watercolour',to:'watercolor'}],wiki:{status:'found',body:'A medium.',format:'dtext',truncated:false},sources:['fixture'],errors:[]}}},
  combo:{...material,kind:'combo',components:[{text:'watercolor',source:'danbooru',category:'general',weight:1.2,target:'style',entryId:'material-1',entryRevision:1},{text:'blue sky',source:'english',weight:0.8,target:'base'}],links:[{studyId:'study-1',sourceSha256:'a'.repeat(64),field:'Comment.prompt',excerpt:'  original\ntext  ',batchId:'batch-1',itemIndex:1,feedback:'User observation'}]},
  note:{...material,kind:'note'},
  study:{schemaVersion:1,parserVersion:1,study:{id:'study-1',revision:1,name:'Study',sha256:'a'.repeat(64),mimeType:'image/png',width:832,height:1216,byteLength:100,sourceUrl:'https://example.com/art',sourceAuthor:'Fixture artist',createdAt:now,updatedAt:now,archived:false,metadataStatus:'generation',metadataKind:'novelai',sources:['png-text'],warnings:[],promptFieldCount:1,parameterFieldCount:1},notes:'Authored notes',originalName:'Original.png',previewSha256:'b'.repeat(64),previewByteLength:50,sections:{prompts:[{key:'Comment.prompt',label:'Prompt',value:'  a red mug\n  '}],parameters:[{key:'Comment.seed',label:'Seed',value:'42'}],raw:{'png-text':{Comment:'{"seed":42,"prompt":"a red mug"}'}}}},
  history,
  artist_favorite:{collection:'artist-string-draw',id:'recipe-1',artists:[{name:'fixture_artist',weight:1.1}],auxiliary:[token],mutations:[{...token,category:'medium'}],franchiseStyles:[{...token,category:'franchise'}],basePrompt:'a red mug',prompt:'watercolor, a red mug',move:'weight',pairId:'pair-1',variant:'mutated',sequence:2,status:'done',image:history,liked:true,saving:false,generationModel:params.model,generationSeed:42},
  style_preset:{id:'style-1',name:'Watercolor',prompt:'  watercolor,\nsoft light  ',group:'paint',createdAt:now,previewImages:[preview]},
  positive_preset:{id:'positive-1',name:'Mug',prompt:'a red mug',createdAt:now,previewImages:[preview]},
  prompt_chunk:{id:'chunk-1',name:'Light',content:'\nsoft light,\n',createdAt:now,updatedAt:now},
  reference_preset:{id:'reference-1',name:'Reference',group:'paint',kind:'precise',filePath:'/fixture/reference.png',fileUrl:'file:///fixture/reference.png',createdAt:now,infoExtracted:1,strength:0.6,preciseType:'character&style',fidelity:0.5,informationExtracted:0.8,width:832,height:1216,sourceId:'remote-1',sourceNames:{'zh-CN':'参考','en-US':'Reference'},sourceGameNames:{'ja-JP':'作品'},sourceGameId:'game-1',sourceCategory:'character'},
};

test('all material kinds preserve complete typed payloads and exact authored data', () => {
  assert.deepEqual(Object.keys(contractSchemas.libraryPayloads), Object.keys(payloads));
  for (const [kind, payload] of Object.entries(payloads)) {
    const before = structuredClone(payload);
    assert.equal(validateContract(payload, contractSchemas.libraryPayloads[kind]), payload);
    assert.deepEqual(payload, before, kind);
    const item = {schemaVersion:1,kind,id:`fixture:${payload.id ?? 'study-1'}`,revision:1,name:'Fixture',archived:false,createdAt:now,updatedAt:now,source:{namespace:'fixture',legacyId:'old-id'},payload};
    validateContract(item, contractSchemas.libraryItem);
    assert.deepEqual(JSON.parse(JSON.stringify(item)).payload, before, kind);
  }
  const future = {...history, retainedExtension:{authored:'future data'}};
  validateContract(future, contractSchemas.libraryPayloads.history);
  assert.deepEqual(future.retainedExtension, {authored:'future data'}, 'forward fields are retained rather than stripped');
});

test('nested payload errors are rejected without coercion, defaults or deletion', () => {
  for (const [kind, patch] of [
    ['history', value => {value.params.metadataReplay.parameters.uncond_scale = Infinity;}],
    ['history', value => {value.params.promptAssemblyVersion = 2;}],
    ['artist_favorite', value => {value.artists[0].weight = '1.1';}],
    ['study', value => {value.sections.prompts[0].value = 42;}],
    ['reference_preset', value => {value.sourceNames['zh-CN'] = 2;}],
    ['combo', value => {value.components[1].weight = NaN;}],
  ]) {
    const input = structuredClone(payloads[kind]); patch(input); const before = structuredClone(input);
    assert.throws(() => validateContract(input, contractSchemas.libraryPayloads[kind]), {code:'invalid_arguments'});
    assert.deepEqual(input, before);
  }
  const legacyList = {action:'list'};
  validateMaterialRequest('material_library', legacyList);
  assert.deepEqual(legacyList, {action:'list'});
});

test('stored history keeps sparse generation parameters without inventing defaults; a new generation record needs them all', () => {
  validateContract(structuredClone(history), contractSchemas.generatedHistoryPayload);
  const sparse = structuredClone(history);
  delete sparse.params.qualityPreset;
  delete sparse.params.transparentBackground;
  delete sparse.fileUrl;
  sparse.params.olderExtension = {authored:'  original data  '};
  const before = structuredClone(sparse);
  validateContract(sparse, contractSchemas.libraryPayloads.history);
  assert.deepEqual(sparse, before);
  assert.throws(() => validateContract(sparse, contractSchemas.generatedHistoryPayload), {code:'invalid_arguments'});
  const favorite = {...payloads.artist_favorite,image:sparse};
  validateContract(favorite, contractSchemas.libraryPayloads.artist_favorite);
  const reference = structuredClone(payloads.reference_preset); delete reference.fileUrl;
  validateContract(reference, contractSchemas.libraryPayloads.reference_preset);
  assert.equal(Object.hasOwn(reference,'fileUrl'),false);
  // A present value still has to match its field schema.
  sparse.params.steps = '28';
  assert.throws(() => validateContract(sparse, contractSchemas.libraryPayloads.history), {code:'invalid_arguments'});
  assert.throws(() => validateContract(favorite, contractSchemas.libraryPayloads.artist_favorite), {code:'invalid_arguments'});
  assert.deepEqual(Object.keys(contractSchemas).sort(), ['generatedHistoryPayload','libraryItem','libraryPayloads','requests'], 'one storage schema; no second payload family');
});

test('all existing MCP schemas compile with Ajv and retain whitespace, finite and no-coercion boundaries', () => {
  for (const tool of TOOL_DEFINITIONS) {
    try {validateContract({}, tool.inputSchema);} catch(error) {assert.equal(error.code, 'invalid_arguments', tool.name);}
  }
  // enqueue_recipes took over these boundaries from the retired submit_batch (2026-11-02).
  const schema = TOOL_DEFINITIONS.find(tool => tool.name === 'enqueue_recipes').inputSchema;
  const item = {recipeId:'12345678-1234-4234-8234-123456789abc',recipeRevision:1,inputHash:'a'.repeat(64),count:2};
  const valid = {requestKey:'batch',items:[item],intervalSeconds:0};
  validateContract(valid, schema);
  for (const patch of [{requestKey:'\u3000\t\n'}, {intervalSeconds:'0'}, {items:[{...item,count:NaN}]}, {items:[{...item,recipeRevision:'1'}]}, {intervalSeconds:Infinity}, {intervalSeconds:-Infinity}, {token:'never forwarded'}]) {
    assert.throws(() => validateContract({...valid,...patch}, schema), {code:'invalid_arguments'});
  }
  const canvas = TOOL_DEFINITIONS.find(tool => tool.name === 'prepare_recipe').inputSchema;
  validateContract({mode:'t2i',canvas:{workspaceId:'fixture',expectedRevision:0}}, canvas);
  for (const patch of [{workspaceId:'\u3000\t\n'}, {expectedRevision:'0'}, {expectedRevision:-1}, {expectedRevision:NaN}, {token:'never forwarded'}])
    assert.throws(() => validateContract({mode:'t2i',canvas:{workspaceId:'fixture',expectedRevision:0,...patch}}, canvas), {code:'invalid_arguments'});
  const read = {workspaceId:'fixture'};
  validateContract(read, TOOL_DEFINITIONS.find(tool => tool.name === 'read_workspace').inputSchema);
  assert.deepEqual(read, {workspaceId:'fixture'}, 'schema defaults remain documentation, never input mutation');
});

test('material sample contracts retain all four ratings, list-all paging and exact cover provenance', () => {
  for (const rating of ['g','s','q','e']) {
    validateContract({action:'list',entryId:'fixture',rating,page:2,limit:8}, contractSchemas.requests.material_samples);
    validateContract({action:'image',entryId:'fixture',postId:321,rating}, contractSchemas.requests.material_samples);
    validateContract({action:'set_cover',entryId:'fixture',revision:1,postId:321,expectedCoverRevision:0,minScore:20,rating}, contractSchemas.requests.material_samples);
    validateContract({action:'import',data:{schemaVersion:1,entries:[],covers:[{entryId:'fixture',cover:{sha256:'a'.repeat(64),mimeType:'image/webp',width:10,height:10,byteLength:12,postId:321,sourceUrl:'https://danbooru.donmai.us/posts/321',tagText:'sweat',tagCategory:null,rating,savedAt:'2026-09-12',verification:'imported',checkedAt:null},data:'bG9jYWwtY292ZXI='}]}}, contractSchemas.requests.material_library);
  }
  validateContract({action:'list_all',entryId:'fixture',page:2,limit:12,sort:'score'}, contractSchemas.requests.material_samples);
  assert.throws(() => validateContract({action:'list',entryId:'fixture',rating:'adult'}, contractSchemas.requests.material_samples), {code:'invalid_arguments'});
  assert.throws(() => validateContract({action:'list_all',entryId:'fixture',rating:'g',sort:'random'}, contractSchemas.requests.material_samples), {code:'invalid_arguments'});
  assert.throws(() => validateContract({action:'import',data:{schemaVersion:1,entries:[],covers:[{entryId:'fixture',cover:{sha256:'a'.repeat(64),mimeType:'image/webp',width:10,height:10,byteLength:12,postId:321,sourceUrl:'https://danbooru.donmai.us/posts/321',tagText:'sweat',tagCategory:null,savedAt:'2026-09-12',verification:'imported',checkedAt:null},data:'bG9jYWwtY292ZXI='}]}}, contractSchemas.requests.material_library), {code:'invalid_arguments'}, 'a Danbooru cover without its rating');
  assert.throws(() => validateContract({action:'import',data:{schemaVersion:1,entries:[],covers:[{entryId:'fixture',cover:{sha256:'a'.repeat(64),mimeType:'image/webp',width:10,height:10,byteLength:12,postId:321,sourceUrl:'https://danbooru.donmai.us/posts/321',tagText:'sweat',tagCategory:null,rating:'adult',savedAt:'2026-09-12',verification:'imported',checkedAt:null},data:'bG9jYWwtY292ZXI='}]}}, contractSchemas.requests.material_library), {code:'invalid_arguments'});
});

test('The MCP tools validate assembled material requests before any bridge call', async () => {
  let calls = 0;
  const bridge = {call() {calls++; return {};}};
  for (const args of [{action:'search_tags'}, {action:'samples',entryId:'fixture',rating:'adult'}, {action:'clear_cover',entryId:'fixture',expectedCoverRevision:'1'}, {action:'save',entry:{kind:'combo',name:'Weights',components:[{text:'watercolor',source:'english',target:'style',weight:Infinity}]}}]) {
    await assert.rejects(materialToolAction(args, {bridge}), {code:'invalid_arguments'});
  }
  assert.equal(calls, 0);
});

test('standard declarations are consumed by Electron CJS and renderer without DTO duplication', () => {
  const file = path.join(root, 'client/src/generated/__contract_typecheck.ts');
  const source = `
import type { LibraryKind, LibraryItem, HistoryPayload, GenerateParams, ArtistFavoritePayload, StylePresetPayload, PositivePresetPayload, PromptChunkPayload, ReferencePresetPayload, MaterialEntry } from './library-contracts.mjs' with { 'resolution-mode': 'import' };
import type * as Legacy from '../types';
import type { MaterialEntry as LegacyMaterialEntry } from '../workspace/material-library-types';
type Same<A,B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const kinds: LibraryKind[] = ['tag','combo','note','study','history','artist_favorite','style_preset','positive_preset','prompt_chunk','reference_preset'];
export const params: Same<GenerateParams,Legacy.GenerateParams> = true;
export const history: Same<HistoryPayload,Legacy.HistoryItem> = true;
export const style: Same<StylePresetPayload,Legacy.StylePromptPreset> = true;
export const positive: Same<PositivePresetPayload,Legacy.PositivePromptPreset> = true;
export const chunk: Same<PromptChunkPayload,Legacy.PromptChunk> = true;
export const reference: Same<ReferencePresetPayload,Legacy.ReferencePreset> = true;
export const material: Same<MaterialEntry,LegacyMaterialEntry> = true;
// The renderer no longer has an artist favorite type of its own (the artist lab is gone); the payload stays typed here.
export const favoriteArtists = (payload: ArtistFavoritePayload) => payload.artists;
export function narrow(item:LibraryItem) { if(item.kind === 'artist_favorite') return item.payload.artists[0]?.weight; if(item.kind === 'reference_preset') return item.payload.preciseType; return item.payload; }
// @ts-expect-error invalid kinds must not become arbitrary strings
export const invalidKind: LibraryKind = 'made_up';
`;
  for (const [module, moduleResolution] of [[ts.ModuleKind.Node16,ts.ModuleResolutionKind.Node16],[ts.ModuleKind.ESNext,ts.ModuleResolutionKind.Bundler]]) {
    const options = {strict:true,noEmit:true,skipLibCheck:true,types:['node'],typeRoots:[path.join(root,'client/node_modules/@types')],target:ts.ScriptTarget.ES2022,module,moduleResolution,jsx:ts.JsxEmit.ReactJSX,resolveJsonModule:true,esModuleInterop:true,rootDir:path.join(root,'client')};
    const host = ts.createCompilerHost(options);
    const read = host.readFile.bind(host), exists = host.fileExists.bind(host);
    host.readFile = name => name === file ? source : read(name);
    host.fileExists = name => name === file || exists(name);
    const program = ts.createProgram([file],options,host);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(diagnostics.length,0,ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:file=>file,getCurrentDirectory:()=>root,getNewLine:()=> '\n'}));
  }
});

test('generated runtime JSON and declarations match source and client delivery', async () => {
  const result = spawnSync(process.execPath,['scripts/build-contracts.mjs','--check'],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,0,`${result.stdout}${result.stderr}`);
  assert.equal(await readFile(path.join(root,'contracts/generated/library-contracts.json'),'utf8'),await readFile(path.join(root,'client/src/generated/library-contracts.json'),'utf8'));
});
