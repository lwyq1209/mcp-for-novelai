import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { useAppStore } from './store';
import { DEFAULT_PARAMS, type HistoryItem } from './types';
import { applyHistoryParameters, planHistoryParameters } from './history-parameters';

const captions = [
  { prompt: '  adult gardener, adult gardener, {blue coat}  \n', negativePrompt: ' hat, hat  ', useCoords: true, x: 0, y: 1 },
  { prompt: ' adult botanist ', negativePrompt: '', useCoords: false, x: .25, y: .75 },
];
const row = { id: 'fixture', model: DEFAULT_PARAMS.model, filePath: '/fixture.png', fileUrl: 'fixture://image', date: '2026-09-20', createdAt: '2026-09-20', width: 832, height: 1216, params: { ...DEFAULT_PARAMS, positivePrompt: 'garden' }, actualSeed: 0 } as HistoryItem;
let settings: any;
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  settings = { persistGenerateParams: true, lastGenerationState: null };
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network forbidden'); }));
  vi.stubGlobal('window', { naiDesktop: {
    setSetting: vi.fn(async (key, value) => { settings[key] = structuredClone(value); }),
    getSettings: vi.fn(async () => structuredClone(settings)), accountCached: vi.fn(async () => ({ hasToken: false })),
    isFirstRun: vi.fn(async () => false), getHistoryDates: vi.fn(async () => []), getHistoryGroups: vi.fn(async () => []),
    getHistory: vi.fn(async () => []), onGenerationPreview: vi.fn(), onUpdateEvent: vi.fn(),
    manualEnqueue: vi.fn(), saveMetadataSnapshotFromPath: vi.fn(),
  } });
  useAppStore.setState({ settings });
});
afterEach(() => vi.unstubAllGlobals());

it('original counterexample: remembers the whole authored group across a restart', async () => {
  for (const caption of captions) {
    useAppStore.getState().addCharCaption();
    useAppStore.getState().updateCharCaption(useAppStore.getState().charCaptions.at(-1)!.id, caption);
  }
  // Existing base-parameter persistence still omitted characters before this fix.
  useAppStore.getState().setParam('positivePrompt', 'garden');
  useAppStore.setState(useAppStore.getInitialState(), true);
  await useAppStore.getState().load();
  expect(useAppStore.getState().charCaptions.map(({ id, ...caption }) => caption)).toEqual(captions);
});

it('original counterexample: saved history parameters restore authored characters', async () => {
  const item = { ...row, characterSnapshot: { version: 1, captions } } as HistoryItem;
  await applyHistoryParameters(planHistoryParameters(item, useAppStore.getState().params));
  expect(useAppStore.getState().charCaptions.map(({ id, ...caption }) => caption)).toEqual(captions);
});

const authored = () => useAppStore.getState().charCaptions.map(({ id, ...caption }) => caption);
const savedRow = (value: unknown = { version: 1, captions }): HistoryItem => ({ ...row, characterSnapshot: value } as HistoryItem);
const plan = (item = savedRow()) => planHistoryParameters(item, useAppStore.getState().params);

it('persists add/edit/remove/clear independently, without a base-parameter edit', () => {
  const state = useAppStore.getState();
  state.addCharCaption();
  expect(settings.lastGenerationState.charCaptions).toEqual(authored());
  const id = useAppStore.getState().charCaptions[0].id;
  state.updateCharCaption(id, captions[0]);
  expect(settings.lastGenerationState.charCaptions).toEqual([captions[0]]);
  state.addCharCaption(); state.removeCharCaption(id);
  expect(settings.lastGenerationState.charCaptions).toEqual(authored());
  state.clearCharCaptions();
  expect(settings.lastGenerationState.charCaptions).toEqual([]);
  expect(window.naiDesktop.setSetting).toHaveBeenCalledTimes(5);
});

it('does not turn on or restore a disabled persistence switch', async () => {
  settings.persistGenerateParams = false;
  useAppStore.getState().addCharCaption();
  useAppStore.setState(useAppStore.getInitialState(), true);
  await useAppStore.getState().load();
  expect(authored()).toEqual([]);
  expect(settings.persistGenerateParams).toBe(false);
  expect(window.naiDesktop.setSetting).not.toHaveBeenCalledWith('persistGenerateParams', true);
});

it('restores editing state without model truncation, while absent old fields preserve current characters', async () => {
  useAppStore.setState({ params: { ...DEFAULT_PARAMS, model: 'nai-diffusion-3' }, charCaptions: captions.map((c, i) => ({ ...c, id: String(i) })) });
  useAppStore.getState().setParam('positivePrompt', 'garden');
  const last = structuredClone(settings.lastGenerationState);
  useAppStore.setState(useAppStore.getInitialState(), true);
  await useAppStore.getState().load();
  expect(authored()).toEqual(captions);
  expect(useAppStore.getState().params.model).toBe('nai-diffusion-3');
  delete last.charCaptions; settings.lastGenerationState = last;
  const before = useAppStore.getState().charCaptions;
  await useAppStore.getState().load();
  expect(useAppStore.getState().charCaptions).toBe(before);
});

it('blocks damaged remembered characters before restoring any base parameters', async () => {
  useAppStore.getState().setParam('positivePrompt', 'saved garden');
  settings.lastGenerationState.charCaptions = [{ ...captions[0], x: null }];
  useAppStore.setState(useAppStore.getInitialState(), true);
  const before = useAppStore.getState().params;
  await useAppStore.getState().load();
  expect(useAppStore.getState().bootError).toContain('character snapshot');
  expect(useAppStore.getState().params).toBe(before);
  expect(useAppStore.getState().bootDone).toBe(false);
});

it('distinguishes missing history snapshot from explicitly empty group and does not infer from search index', async () => {
  useAppStore.setState({ charCaptions: captions.map((c, i) => ({ ...c, id: String(i) })) });
  const before = useAppStore.getState().charCaptions;
  await applyHistoryParameters(plan({ ...row, characterPrompts: ['not a complete character'] }));
  expect(useAppStore.getState().charCaptions).toBe(before);
  await applyHistoryParameters(plan(savedRow({ version: 1, captions: [] })));
  expect(authored()).toEqual([]);
  expect(settings.lastGenerationState.charCaptions).toEqual([]);
});

it.each([
  undefined, null, { version: 2, captions }, { version: 1, captions: {} },
  { version: 1, captions: [{ ...captions[0], negativePrompt: null }] },
  { version: 1, captions: [{ ...captions[0], useCoords: 'false' }] },
  { version: 1, captions: [{ ...captions[0], x: -1 }] },
  { version: 1, captions: [{ ...captions[0], y: NaN }] },
  { version: 1, captions: [{ prompt: 'gardener', useCoords: true, y: .5 }] },
])('blocks malformed or unsupported snapshot %# without partial parameter application', async value => {
  const item = { ...row, characterSnapshot: value } as HistoryItem;
  const before = useAppStore.getState();
  const p = plan(item);
  expect(p.blocked).toEqual({ key: 'hp.snapshotInvalid' });
  await expect(applyHistoryParameters(p)).rejects.toMatchObject({ uiKey: 'hp.snapshotInvalid', message: expect.stringContaining('character snapshot') });
  expect(useAppStore.getState()).toBe(before);
  expect(window.naiDesktop.setSetting).not.toHaveBeenCalled();
});

it.each(['nai-diffusion-3', 'nai-diffusion-4-full'])('blocks unsupported capacity for %s instead of silently dropping characters', async model => {
  const item = { ...savedRow({ version: 1, captions: Array.from({ length: 7 }, () => captions[0]) }), params: { ...row.params, model } } as HistoryItem;
  const before = useAppStore.getState();
  await expect(applyHistoryParameters(plan(item))).rejects.toMatchObject({ uiKey: 'hp.tooManyChars', message: expect.stringContaining('many characters') });
  expect(useAppStore.getState()).toBe(before);
});

it.each(['prompt', 'negativePrompt', 'useCoords', 'x', 'y', 'order', 'add', 'remove', 'clear'])('rejects character-only stale confirmation after %s', async field => {
  useAppStore.setState({ charCaptions: captions.map((c, i) => ({ ...c, id: String(i) })) });
  const p = plan();
  const state = useAppStore.getState();
  if (field === 'order') useAppStore.setState({ charCaptions: [...state.charCaptions].reverse() });
  else if (field === 'add') state.addCharCaption();
  else if (field === 'remove') state.removeCharCaption('0');
  else if (field === 'clear') state.clearCharCaptions();
  else state.updateCharCaption('0', { [field]: field === 'useCoords' ? false : field === 'x' || field === 'y' ? .3 : 'new text' });
  const before = useAppStore.getState();
  await expect(applyHistoryParameters(p)).rejects.toMatchObject({ uiKey: 'hp.changedParams', message: expect.stringContaining('changed') });
  expect(useAppStore.getState()).toBe(before);
});

it('applies base and the full group atomically, with fresh IDs and without changing assets or generation', async () => {
  useAppStore.setState({
    charCaptions: captions.map((c, i) => ({ ...c, id: String(i) })),
    currentImage: row, inpaintMask: 'fixture-mask',
    workbenchImage: { filePath: '/source-fixture.png', fileUrl: 'fixture://source', width: 64, height: 64 },
    vibeImages: [{ id: 'vibe', base64: 'fixture', previewUrl: 'fixture:', strength: .5, infoExtracted: 1 }],
    preciseReferences: [{ id: 'reference', base64: 'fixture', previewUrl: 'fixture:', type: 'character', strength: 1, fidelity: 1, informationExtracted: 1 }],
  });
  const before = useAppStore.getState();
  const transitions: unknown[] = [];
  const unsub = useAppStore.subscribe((next, previous) => {
    if (next.params !== previous.params || next.charCaptions !== previous.charCaptions) transitions.push({ prompt: next.params.positivePrompt, captions: authored() });
  });
  await applyHistoryParameters(plan()); unsub();
  expect(transitions).toEqual([{ prompt: 'garden', captions }]);
  const after = useAppStore.getState();
  expect(after.charCaptions.map(c => c.id)).not.toEqual(['0', '1']);
  for (const key of ['currentImage', 'workbenchImage', 'inpaintMask', 'vibeImages', 'preciseReferences'] as const) expect(after[key]).toBe(before[key]);
  expect(window.naiDesktop.manualEnqueue).not.toHaveBeenCalled();
  expect(window.naiDesktop.saveMetadataSnapshotFromPath).not.toHaveBeenCalled();
});

it('retains same-prompt characters with different negatives and disabled coordinates, including absent negative text', async () => {
  const samePrompt = [{ ...captions[0], prompt: 'gardener' }, { ...captions[1], prompt: 'gardener' }, { prompt: '', useCoords: false, x: 1, y: 0 }];
  await applyHistoryParameters(plan(savedRow({ version: 1, captions: samePrompt })));
  expect(authored()).toEqual(samePrompt);
  expect(Object.hasOwn(authored()[2], 'negativePrompt')).toBe(false);
});

it('refuses a modified plan and also validates direct atomic store restore before writes', async () => {
  const p = plan(); p.characters![0].x = .5;
  const before = useAppStore.getState();
  await expect(applyHistoryParameters(p)).rejects.toMatchObject({ uiKey: 'hp.changedChars', message: expect.stringContaining('characters to apply have changed') });
  expect(() => before.applyHistoricalParams({ positivePrompt: 'must not write' }, [{ ...captions[0], x: NaN }])).toThrow('character snapshot');
  expect(useAppStore.getState()).toBe(before);
});

it('variation entry restores and persists the complete group with fixed actual seed, without touching source, Mask or references', async () => {
  useAppStore.setState({
    charCaptions: [{ ...captions[1], id: 'prior' }], inpaintMask: 'fixture-mask',
    inpaintRecipe: { ...DEFAULT_PARAMS, positivePrompt: 'independent inpaint' },
    workbenchImage: { filePath: '/fixture-source.png', fileUrl: 'fixture://source', width: 64, height: 64 },
    vibeImages: [{ id: 'vibe', base64: 'fixture', previewUrl: 'fixture:', strength: .5, infoExtracted: 1 }],
    preciseReferences: [{ id: 'reference', base64: 'fixture', previewUrl: 'fixture:', type: 'character', strength: 1, fidelity: 1, informationExtracted: 1 }],
  });
  const before = useAppStore.getState();
  const transitions: unknown[] = [];
  const unsub = useAppStore.subscribe((next, prev) => {
    if (next.params !== prev.params || next.charCaptions !== prev.charCaptions) transitions.push({ prompt: next.params.positivePrompt, captions: authored() });
  });
  before.variationFromImage(savedRow()); unsub();
  expect(transitions).toEqual([{ prompt: 'garden', captions }]);
  expect(authored()).toEqual(captions);
  expect(useAppStore.getState().params).toMatchObject({ seed: 0, seedMode: 'fixed' });
  for (const key of ['workbenchImage', 'inpaintMask', 'inpaintRecipe', 'vibeImages', 'preciseReferences'] as const) expect(useAppStore.getState()[key]).toBe(before[key]);
  expect(settings.lastGenerationState.charCaptions).toEqual(captions);
  expect(window.naiDesktop.manualEnqueue).not.toHaveBeenCalled();
  expect(window.naiDesktop.saveMetadataSnapshotFromPath).not.toHaveBeenCalled();
  const ids = useAppStore.getState().charCaptions.map(c => c.id);
  useAppStore.setState(useAppStore.getInitialState(), true);
  await useAppStore.getState().load();
  expect(authored()).toEqual(captions);
  expect(useAppStore.getState().charCaptions.map(c => c.id)).not.toEqual(ids);
});

it('variation entry keeps legacy roles but explicitly empty snapshot clears and persists', () => {
  useAppStore.setState({ charCaptions: captions.map((c, i) => ({ ...c, id: String(i) })) });
  const before = useAppStore.getState().charCaptions;
  useAppStore.getState().variationFromImage({ ...row, characterPrompts: ['index only'] });
  expect(useAppStore.getState().charCaptions).toBe(before);
  useAppStore.getState().variationFromImage(savedRow({ version: 1, captions: [] }));
  expect(authored()).toEqual([]);
  expect(settings.lastGenerationState.charCaptions).toEqual([]);
});

it('variation entry rejects damaged snapshot before parameters or preview change', () => {
  const before = useAppStore.getState();
  before.variationFromImage(savedRow({ version: 1, captions: [{ ...captions[0], x: null }] }));
  expect(useAppStore.getState().params).toBe(before.params);
  expect(useAppStore.getState().charCaptions).toBe(before.charCaptions);
  expect(useAppStore.getState().currentImage).toBe(before.currentImage);
  expect(useAppStore.getState().toast).toContain('character snapshot');
  expect(window.naiDesktop.setSetting).not.toHaveBeenCalled();
});

it.each(['capacity', 'inflight', 'upscale', 'director', 'version'])('variation entry blocks %s before changing recipe or persisting', reason => {
  let item = savedRow();
  if (reason === 'capacity') item = { ...item, params: { ...row.params, model: 'nai-diffusion-3' } };
  if (reason === 'inflight') useAppStore.setState({ isGenerating: true });
  if (reason === 'upscale' || reason === 'director') item = { ...item, model: reason };
  if (reason === 'version') item = savedRow({ version: 2, captions });
  const before = useAppStore.getState();
  before.variationFromImage(item);
  expect(useAppStore.getState().params).toBe(before.params);
  expect(useAppStore.getState().charCaptions).toBe(before.charCaptions);
  expect(useAppStore.getState().currentImage).toBe(before.currentImage);
  // English without a language setting (step 4c1: no Chinese in an English window).
  expect(useAppStore.getState().toast).toContain('not applied');
  expect(window.naiDesktop.setSetting).not.toHaveBeenCalled();
});

it('selectImage remains preview-only even for a complete character snapshot', () => {
  useAppStore.setState({ charCaptions: [{ ...captions[1], id: 'prior' }] });
  const before = useAppStore.getState(), item = savedRow();
  before.selectImage(item);
  expect(useAppStore.getState().currentImage).toBe(item);
  expect(useAppStore.getState().params).toBe(before.params);
  expect(useAppStore.getState().charCaptions).toBe(before.charCaptions);
  expect(window.naiDesktop.setSetting).not.toHaveBeenCalled();
  expect(window.naiDesktop.manualEnqueue).not.toHaveBeenCalled();
});

it.each(['dialog', 'variation'] as const)('accepts V5 32 roles and blocks 33 atomically via %s', async entry => {
  for (const count of [32, 33]) {
    const group = Array.from({ length: count }, (_, index) => ({ ...captions[index % 2], prompt: `  gardener ${index}, gardener ${index}  ` }));
    const item = { ...savedRow({ version: 1, captions: group }), params: { ...row.params, model: 'nai-diffusion-5-full' as const } };
    const before = useAppStore.getState();
    vi.mocked(window.naiDesktop.setSetting).mockClear();
    if (entry === 'dialog') {
      if (count === 32) await applyHistoryParameters(plan(item));
      else await expect(applyHistoryParameters(plan(item))).rejects.toMatchObject({ uiKey: 'hp.tooManyChars', message: expect.stringContaining('many characters') });
    } else before.variationFromImage(item);
    if (count === 32) {
      expect(authored()).toEqual(group);
      expect(settings.lastGenerationState.charCaptions).toEqual(group);
      expect(new Set(useAppStore.getState().charCaptions.map(c => c.id)).size).toBe(32);
    } else {
      expect(useAppStore.getState().params).toBe(before.params);
      expect(useAppStore.getState().charCaptions).toBe(before.charCaptions);
      expect(useAppStore.getState().currentImage).toBe(before.currentImage);
      expect(window.naiDesktop.setSetting).not.toHaveBeenCalled();
    }
  }
});

it('guards the atomic Store recovery lane during a generation and releases normally when it settles', () => {
  useAppStore.setState({ isGenerating: true });
  const before = useAppStore.getState();
  expect(() => before.applyHistoricalParams({ positivePrompt: 'garden' }, captions)).toThrow('Generating');
  expect(useAppStore.getState()).toBe(before);
  expect(window.naiDesktop.setSetting).not.toHaveBeenCalled();
  useAppStore.setState({ isGenerating: false });
  useAppStore.getState().applyHistoricalParams({ positivePrompt: 'garden' }, captions);
  expect(authored()).toEqual(captions);
  expect(useAppStore.getState().isGenerating).toBe(false);
  expect(settings.lastGenerationState.charCaptions).toEqual(captions);
});
