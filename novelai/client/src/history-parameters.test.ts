import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PARAMS, type HistoryItem } from './types';
import { applyHistoryParameters, historyText, historyTextList, planHistoryParameters } from './history-parameters';
import { useAppStore } from './store';

const image: HistoryItem = { id: 'garden', filePath: '/fixtures/garden.png', fileUrl: 'nai-local://garden', model: DEFAULT_PARAMS.model, width: 832, height: 1216, date: '2026-09-12', createdAt: '2026-09-12T12:00:00Z', params: { ...DEFAULT_PARAMS, stylePrompt: 'watercolor', positivePrompt: 'adult gardener, garden', negativePrompt: '', qualityPreset: 'none', qualityToggle: false, ucPreset: 3, seed: 321, seedMode: 'random' }, actualSeed: 0 };
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  vi.stubGlobal('window', { naiDesktop: { setSetting: vi.fn().mockResolvedValue({}), saveMetadataSnapshotFromPath: vi.fn(), manualEnqueue: vi.fn() } });
});
afterEach(() => vi.unstubAllGlobals());
describe('saved history parameter recovery', () => {
  it('restores original Style, authored prompt and quality/UC controls with actual seed zero, without reading PNG or generating', async () => {
    const plan = planHistoryParameters(image, useAppStore.getState().params);
    expect(plan.actualSeed).toBe(0);
    expect(plan.fields.find(field => field.key === 'seedMode')).toMatchObject({ saved: 'random', applied: 'fixed' });
    await applyHistoryParameters(plan);
    expect(useAppStore.getState().params).toMatchObject({ stylePrompt: 'watercolor', positivePrompt: 'adult gardener, garden', negativePrompt: '', qualityToggle: false, qualityPreset: 'none', ucPreset: 3, seed: 0, seedMode: 'fixed' });
    expect(window.naiDesktop.saveMetadataSnapshotFromPath).not.toHaveBeenCalled();
    expect(window.naiDesktop.manualEnqueue).not.toHaveBeenCalled();
  });

  it('keeps characters, reference bytes, source, mask, independent inpaint recipe, mode and preview unchanged', async () => {
    useAppStore.setState({
      charCaptions: [{ id: 'character', prompt: 'adult gardener', negativePrompt: 'hat', useCoords: true, x: .25, y: .75 }],
      vibeImages: [{ id: 'vibe', base64: 'fixture-vibe', previewUrl: 'fixture://vibe', strength: .8, infoExtracted: 1 }],
      preciseReferences: [{ id: 'reference', base64: 'fixture-reference', previewUrl: 'fixture://reference', type: 'character', strength: .5, fidelity: .9, informationExtracted: 1 }],
      workbenchImage: { filePath: '/fixtures/source.png', fileUrl: 'fixture://source', width: 832, height: 1216 },
      inpaintMask: 'fixture-mask', inpaintRecipe: { ...DEFAULT_PARAMS, positivePrompt: 'blue flower' },
      currentImage: image, generateMode: 'i2i', activeTab: 'inpaint',
    });
    const before = useAppStore.getState();
    await applyHistoryParameters(planHistoryParameters(image, before.params));
    const after = useAppStore.getState();
    for (const key of ['charCaptions', 'vibeImages', 'preciseReferences', 'workbenchImage', 'inpaintMask', 'inpaintRecipe', 'currentImage', 'generateMode'] as const) expect(after[key]).toBe(before[key]);
    expect(after.activeTab).toBe('generate');
  });

  it('does not fill sparse rows from defaults or confuse pre-random seed with actual seed', async () => {
    const old = { ...image, actualSeed: undefined, params: { positivePrompt: 'sunlit garden', seed: 555 } } as unknown as HistoryItem;
    const before = useAppStore.getState().params;
    const plan = planHistoryParameters(old, before);
    expect(plan.missing).toEqual(expect.arrayContaining([{ key: 'hp.f.stylePrompt' }, { key: 'hp.f.ucPreset' }, { key: 'hp.f.actualSeed' }]));
    expect(historyTextList('zh', plan.missing)).toContain('Style、');
    expect(plan.missing.map(text => historyText('zh', text))).toEqual(expect.arrayContaining(['Style', '负面预设', '实际 seed（当前种子与策略保留）']));
    expect(plan.missing.map(text => historyText('en', text))).toEqual(expect.arrayContaining(['Style', 'UC preset', 'Actual seed (current seed and seed mode kept)']));
    expect(plan.patch).not.toHaveProperty('seed');
    await applyHistoryParameters(plan);
    expect(useAppStore.getState().params).toMatchObject({ stylePrompt: before.stylePrompt, positivePrompt: 'sunlit garden', seed: before.seed, seedMode: before.seedMode, ucPreset: before.ucPreset });
    expect(useAppStore.getState().params).not.toHaveProperty('promptAssemblyVersion');
  });

  it('keeps a sparse legacy qualityToggle false effective and exposes the derived supported preset', async () => {
    const plan = planHistoryParameters({ ...image, params: { positivePrompt: 'garden', qualityToggle: false } } as HistoryItem, useAppStore.getState().params);
    expect(plan.fields.find(field => field.key === 'qualityPreset')).toMatchObject({ saved: undefined, applied: 'none' });
    await applyHistoryParameters(plan);
    expect(useAppStore.getState().params.qualityToggle).toBe(false);
  });

  it.each([0, 2, '1', null, false, undefined])('blocks a history row with an explicit invalid assembly marker (%s)', async value => {
    const plan = planHistoryParameters({ ...image, params: { ...image.params, promptAssemblyVersion: value } } as unknown as HistoryItem, DEFAULT_PARAMS);
    expect(plan.blocked).toEqual({ key: 'hp.badAssembly' });
    expect(historyText('zh', plan.blocked!)).toBe('这条历史的提示词装配版本无效，未授权恢复或生成。');
    await expect(applyHistoryParameters(plan)).rejects.toMatchObject({ uiKey: 'hp.badAssembly', message: 'This record’s prompt assembly version is invalid, so it can’t be restored or generated.' });
    expect(window.naiDesktop.setSetting).not.toHaveBeenCalled();
  });

  it.each(['upscale', 'director-lineart'])('blocks %s placeholders instead of presenting a full saved recipe', async model => {
    const plan = planHistoryParameters({ ...image, model }, useAppStore.getState().params);
    expect(plan.blocked).toEqual({ key: 'hp.postprocess' });
    expect(historyText('zh', plan.blocked!)).toContain('后期处理');
    await expect(applyHistoryParameters(plan)).rejects.toMatchObject({ uiKey: 'hp.postprocess', message: expect.stringContaining('post-processing') });
    expect(useAppStore.getState().params.positivePrompt).not.toBe(image.params.positivePrompt);
  });

  it('blocks explicitly seedless provenance even when the model name resembles a seeded generation', () => {
    const plan = planHistoryParameters({ ...image, generationOrigin: { jobId: 'post', mode: 'upscale', originWorkspaceId: 'fixture', submittedRevision: 0, actualSeed: null } }, DEFAULT_PARAMS);
    expect(plan.blocked).not.toBeNull(); expect(plan.actualSeed).toBeNull();
  });

  it('rejects malformed saved fields through shared schema, preserving their current values', async () => {
    const plan = planHistoryParameters({ ...image, params: { positivePrompt: 'garden', model: 'unknown', ucPreset: 100, cfgScale: '9' } } as unknown as HistoryItem, DEFAULT_PARAMS);
    expect(plan.invalid).toEqual(expect.arrayContaining([{ key: 'hp.f.model' }, { key: 'hp.f.ucPreset' }, { key: 'hp.f.cfgScale' }]));
    expect(plan.invalid.map(text => historyText('zh', text))).toEqual(expect.arrayContaining(['模型', '负面预设', '引导']));
    await applyHistoryParameters(plan);
    expect(useAppStore.getState().params).toMatchObject({ model: DEFAULT_PARAMS.model, ucPreset: DEFAULT_PARAMS.ucPreset, cfgScale: DEFAULT_PARAMS.cfgScale });
  });

  it('displays supported values before applying normalized legacy dimensions and numeric bounds', async () => {
    const plan = planHistoryParameters({ ...image, params: { ...image.params, steps: 999, width: 835 } }, DEFAULT_PARAMS);
    expect(plan.fields.find(field => field.key === 'steps')).toMatchObject({ saved: 999, applied: 50 });
    await applyHistoryParameters(plan);
    expect(useAppStore.getState().params.width).toBe(plan.fields.find(field => field.key === 'width')!.applied);
  });

  it('does not carry another PNG sampling override into a normal author recipe', async () => {
    useAppStore.setState({ params: { ...DEFAULT_PARAMS, preservePromptText: true, metadataReplay: { model: DEFAULT_PARAMS.model, parameters: { straight_alpha: true } } } });
    await applyHistoryParameters(planHistoryParameters(image, useAppStore.getState().params));
    expect(useAppStore.getState().params.metadataReplay).toBeUndefined();
    expect(useAppStore.getState().params.preservePromptText).toBeUndefined();
  });

  it('refuses stale confirmation and changes during active generation', async () => {
    const plan = planHistoryParameters(image, useAppStore.getState().params);
    useAppStore.getState().setParam('positivePrompt', 'new manual draft');
    await expect(applyHistoryParameters(plan)).rejects.toMatchObject({ uiKey: 'hp.changedParams', message: expect.stringContaining('changed') });
    const next = planHistoryParameters(image, useAppStore.getState().params);
    useAppStore.setState({ isGenerating: true });
    await expect(applyHistoryParameters(next)).rejects.toMatchObject({ uiKey: 'hp.generating', message: expect.stringContaining('Generating') });
    expect(useAppStore.getState().params.positivePrompt).toBe('new manual draft');
  });

  it('also updates the locked Style value so a restart does not revert the restored Style', async () => {
    useAppStore.setState({ settings: { lockStylePrompt: true, savedStylePrompt: 'pencil' } as any });
    await applyHistoryParameters(planHistoryParameters(image, useAppStore.getState().params));
    expect(window.naiDesktop.setSetting).toHaveBeenCalledWith('savedStylePrompt', 'watercolor');
    expect(useAppStore.getState().settings?.savedStylePrompt).toBe('watercolor');
  });

  it('writes the applied notice in the interface language', async () => {
    useAppStore.setState({ settings: { language: 'zh-CN' } as any });
    expect(await applyHistoryParameters(planHistoryParameters(image, useAppStore.getState().params))).toBe('已恢复参数（角色保持不变），没有出图。');
    useAppStore.setState({ settings: { language: 'en-US' } as any });
    const notice = await applyHistoryParameters(planHistoryParameters(image, useAppStore.getState().params));
    expect(notice).toBe('Settings restored (characters unchanged); nothing was generated.');
    expect(useAppStore.getState().toast).toBe(notice);
  });

  it('writes the mode notices in Chinese and English, without Chinese in English', () => {
    const notice = (mode: string) => planHistoryParameters({ ...image, feature: mode } as HistoryItem, DEFAULT_PARAMS).modeNotice;
    expect(historyText('zh', notice('inpaint'))).toBe('这张图来自局部重绘：只恢复文生图参数，重绘设置、源图和蒙版不变。');
    expect(historyText('zh', notice('t2i'))).toBe('这张图来自文生图，当前模式不变。');
    for (const mode of ['inpaint', 'i2i', 't2i', 'other']) expect(historyText('en', notice(mode))).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
