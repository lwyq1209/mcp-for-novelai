import { hostErrorText } from '../host-errors';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PARAMS } from '../types';
import { applyLibraryItem, assetApplicationLabel, type MaterialApplicationTarget } from './apply';
import type { AssetItem } from './types';

const item = (kind: AssetItem['kind'], payload: Record<string, any>) => ({ kind, id: 'fixture', archived: false, payload } as AssetItem);
function context() {
  const store = { params: { ...DEFAULT_PARAMS, model: 'nai-diffusion-4-5-full', positivePrompt: 'adult gardener, ', negativePrompt: 'blurry' }, inpaintRecipe: { ...DEFAULT_PARAMS, positivePrompt: 'blue shirt', negativePrompt: 'red ribbon' }, settings: {}, charCaptions: [{ id:'left',prompt:'adult gardener',negativePrompt:'hat',useCoords:true,x:.2,y:.7 }, { id:'right',prompt:'adult teacher',negativePrompt:'coat',useCoords:true,x:.8,y:.7 }], setParam: vi.fn(), setInpaintRecipeParam: vi.fn(), updateCharCaption: vi.fn(), selectImage: vi.fn(), applyParams: vi.fn(), addVibeImage: vi.fn(), addPreciseReference: vi.fn() };
  const api = { setSetting: vi.fn(), readReferencePreset: vi.fn() };
  return { store, api, apply: (asset: AssetItem, scope: 'base' | 'inpaint' = 'base', target?: MaterialApplicationTarget) => applyLibraryItem(asset, scope, store as any, api as any, target) };
}
describe('explicit use of unified assets', () => {
  it('replaces the named prompt field and appends chunks with existing comma semantics', async () => {
    const { store, apply } = context();
    await apply(item('style_preset', { prompt: 'watercolor' }));
    await apply(item('positive_preset', { prompt: 'a garden' }));
    await apply(item('prompt_chunk', { content: 'soft light' }));
    expect(store.setParam.mock.calls).toEqual([['stylePrompt', 'watercolor'], ['positivePrompt', 'a garden'], ['positivePrompt', 'adult gardener, soft light, ']]);
    expect(store.applyParams).not.toHaveBeenCalled();
  });
  it('keeps independent inpaint positive, negative and style changes away from base params', async () => {
    const { store, apply } = context();
    await apply(item('prompt_chunk', { content: 'blue ribbon' }), 'inpaint');
    await apply(item('positive_preset', { prompt: 'blurry' }), 'inpaint', {field:'negative'});
    await apply(item('prompt_chunk', { content: 'hat' }), 'inpaint', {field:'negative'});
    await apply(item('style_preset', { prompt: 'watercolor' }), 'inpaint', {field:'negative'});
    expect(store.setInpaintRecipeParam.mock.calls).toEqual([['positivePrompt', 'blue shirt, blue ribbon, '], ['negativePrompt','blurry'], ['negativePrompt','red ribbon, hat, '], ['stylePrompt','watercolor']]);
    expect(store.setParam).not.toHaveBeenCalled();
    expect(assetApplicationLabel(item('reference_preset', {}), 'inpaint')).toBe('');
    expect(assetApplicationLabel(item('positive_preset', {}),'inpaint',{field:'negative'})).toBe('替换重绘负面');
  });
  it('does not change the central image when a history item is used or previewed', async () => {
    const { store, apply } = context(), history = { id: 'image', params: DEFAULT_PARAMS };
    expect(assetApplicationLabel(item('history',history),'base')).toBe('');
    await expect(apply(item('history', history))).rejects.toMatchObject({ reason: 'library.apply_no_entry' });
    expect(store.selectImage).not.toHaveBeenCalled(); expect(store.applyParams).not.toHaveBeenCalled();
  });
  it('targets exactly one existing character and never falls back to the base prompt or another character', async () => {
    const {store,apply}=context();
    await apply(item('positive_preset',{prompt:'adult violinist'}),'base',{field:'character',characterId:'right'});
    await apply(item('prompt_chunk',{content:'holding a book'}),'base',{field:'character',characterId:'left'});
    expect(store.updateCharCaption.mock.calls).toEqual([['right',{prompt:'adult violinist'}],['left',{prompt:'adult gardener, holding a book, '}]]);
    await expect(apply(item('prompt_chunk',{content:'red scarf'}),'base',{field:'character',characterId:'deleted'})).rejects.toMatchObject({ reason: 'library.apply_character_gone' });
    await expect(apply(item('prompt_chunk',{content:'red scarf'}),'inpaint',{field:'character',characterId:'left'})).rejects.toMatchObject({ reason: 'library.apply_inpaint_no_character' });
    expect(store.updateCharCaption).toHaveBeenCalledTimes(2);expect(store.setParam).not.toHaveBeenCalled();expect(store.setInpaintRecipeParam).not.toHaveBeenCalled();
  });
  it('uses base negative targets, keeps Style fixed to its field and honors locked Style persistence failure', async () => {
    const {store,api,apply}=context();
    await apply(item('prompt_chunk',{content:'hat'}),'base',{field:'negative'});
    await apply(item('style_preset',{prompt:'watercolor'}),'base',{field:'character',characterId:'right'});
    expect(store.setParam.mock.calls).toEqual([['negativePrompt','blurry, hat, '],['stylePrompt','watercolor']]);
    store.settings={lockStylePrompt:true};api.setSetting.mockRejectedValue(new Error('disk full'));
    await expect(apply(item('style_preset',{prompt:'oil painting'}))).rejects.toThrow('disk full');
    expect(store.setParam).toHaveBeenCalledTimes(2);
  });
  it('uses the selected historical precise parameters and current bytes of the same original', async () => {
    const { store, api, apply } = context();
    const saved={kind:'precise',preciseType:'style',strength:0,fidelity:.7,width:320,height:320,filePath:'/owned/reference.png',fileUrl:'localmedia://fixture'};
    api.readReferencePreset.mockResolvedValue({ ok: true, base64: 'fixture-bytes', preset: { ...saved,strength:1,fidelity:1,preciseType:'character' } });
    await apply(item('reference_preset',saved));
    expect(store.addPreciseReference).toHaveBeenCalledWith(expect.objectContaining({ type:'style',strength:0,fidelity:.7,informationExtracted:1,srcWidth:320,srcHeight:320,base64:'fixture-bytes' }));
    expect(store.addVibeImage).not.toHaveBeenCalled();
  });
  it('retains historical Vibe parameters and refuses changed original identity or unsupported models',async()=>{
    const {store,api,apply}=context();const saved={kind:'vibe',strength:0,infoExtracted:.4,filePath:'/owned/reference.png',fileUrl:'localmedia://fixture'};
    api.readReferencePreset.mockResolvedValue({ok:true,base64:'fixture-bytes',preset:{...saved,strength:1,infoExtracted:1}});
    await apply(item('reference_preset',saved));expect(store.addVibeImage).toHaveBeenCalledWith(expect.objectContaining({strength:0,infoExtracted:.4}));
    api.readReferencePreset.mockResolvedValue({ok:true,base64:'other-bytes',preset:{...saved,filePath:'/other.png'}});
    await expect(apply(item('reference_preset',saved))).rejects.toMatchObject({ reason: 'library.apply_reference_changed' });
    store.params.model='nai-diffusion-5-full';await expect(apply(item('reference_preset',saved))).rejects.toMatchObject({ reason: 'library.apply_model_no_vibe' });expect(api.readReferencePreset).toHaveBeenCalledTimes(2);expect(store.addVibeImage).toHaveBeenCalledTimes(1);
    store.params.model='nai-diffusion-3';await expect(apply(item('positive_preset',{prompt:'adult gardener'}),'base',{field:'character',characterId:'left'})).rejects.toMatchObject({ reason: 'library.apply_model_no_characters' });
  });
  it('refuses with a reason the window renders in its language (no Chinese in an English window, step 4c1)',async()=>{
    const {store,apply}=context();
    const refusals:unknown[]=[];
    for (const run of [()=>apply(item('artist_favorite',{basePrompt:'x',prompt:'y'})),()=>apply(item('positive_preset',{prompt:'x'}),'inpaint',{field:'character',characterId:'left'})]) { try { await run(); } catch (error) { refusals.push(error); } }
    store.params.model='nai-diffusion-5-full';try{await apply(item('reference_preset',{kind:'precise'}));}catch(error){refusals.push(error);}
    expect(refusals.map(error=>(error as {reason?:string}).reason)).toEqual(['library.apply_no_recipe','library.apply_inpaint_no_character','library.apply_model_no_precise']);
    for (const error of refusals) { expect(hostErrorText(error,'en-US')).not.toMatch(/[\u4e00-\u9fff]/); expect(hostErrorText(error,'zh-CN')).toMatch(/[\u4e00-\u9fff]/); }
  });
  it('preserves a saved artist favorite seed of zero',async()=>{
    const {store,apply}=context();await apply(item('artist_favorite',{basePrompt:'adult gardener',prompt:'watercolor',generationSeed:0,image:{params:DEFAULT_PARAMS,actualSeed:77,model:'nai-diffusion-4-5-full'}}));expect(store.applyParams).toHaveBeenCalledWith(expect.objectContaining({seed:0,seedMode:'fixed'}));expect(store.selectImage).not.toHaveBeenCalled();
  });
});
