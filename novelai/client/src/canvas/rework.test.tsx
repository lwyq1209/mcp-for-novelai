import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// SSR reads a zustand store's initial state; select from the live state instead (as the other SSR tests do).
vi.mock('../store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store')>();
  const store = actual.useAppStore;
  const select = (selector: (state: ReturnType<typeof store.getState>) => unknown) => selector(store.getState());
  return { ...actual, useAppStore: Object.assign(select, store) };
});

import { useAppStore } from '../store';
import { DEFAULT_PARAMS } from '../types';
import { uiText } from '../ui/i18n';
import { getToasts, dismissToast } from '../ui';
import type { MaterialComponent } from '../workspace/material-library-types';
import { planCombo, readComboFields } from './combo-apply';
import { applyArtistRecipe, applyComboByUse, defaultComboCharacter, pickerTabs } from './LibraryPicker';
import { adoptPromptAssemblyV1 } from './sections/params';
import { ReferencesSection } from './sections/references';
import { CharactersSection } from './sections/characters';
import { sameValues, undoStep, showStepToast } from './guarded-undo';
import { applyTrayToCanvas } from '../library/ComboTray';

const t = (key: Parameters<typeof uiText>[1], params?: Record<string, string | number>) => uiText('en', key, params);
const member = (text: string, target: MaterialComponent['target'], weight = 1, extra: Partial<MaterialComponent> = {}): MaterialComponent => ({ text, source: 'english', category: null, target, weight, ...extra });
const lastToast = () => getToasts().at(-1);
const clickUndo = () => lastToast()!.action!.onClick();
const clearToasts = () => getToasts().forEach(toast => dismissToast(toast.id));

beforeEach(() => {
  vi.stubGlobal('window', { naiDesktop: { setSetting: vi.fn().mockResolvedValue(undefined) } });
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    settings: { language: 'en-US', autoComplete: false, lockNegativePrompt: false, lockStylePrompt: false } as never,
    params: { ...DEFAULT_PARAMS, model: 'nai-diffusion-4-5-full', positivePrompt: 'base, ', negativePrompt: 'neg', stylePrompt: 'old style', seedMode: 'random', seed: 5 },
    inpaintPositivePrompt: 'inpaint text',
    inpaintRecipe: null,
    charCaptions: [{ id: 'c1', prompt: 'girl', negativePrompt: '', useCoords: false, x: 0.5, y: 0.5 }, { id: 'c2', prompt: 'boy', negativePrompt: '', useCoords: false, x: 0.5, y: 0.5 }],
  });
  clearToasts();
});
afterEach(() => { clearToasts(); vi.unstubAllGlobals(); });

describe('combos by the use of their members (the old composer rules, review rework)', () => {
  const combo = [member('watercolor', 'style', 1.2), member('wlop', 'style', 1, { source: 'danbooru', category: 'artist' }), member('rain', 'base'), member('smiling', 'character')];

  it('base: Style replaced as a whole with weights and artist:, Base appended after the trailing comma, character to the chosen one, negative untouched', () => {
    expect(applyComboByUse(t, 'C', combo, 'base', 'c2')).toBe(true);
    const state = useAppStore.getState();
    expect(state.params.stylePrompt).toBe('1.2::watercolor ::, artist:wlop');
    expect(state.params.positivePrompt).toBe('base, rain');
    expect(state.charCaptions.map(caption => caption.prompt)).toEqual(['girl', 'boy, smiling']);
    expect(state.params.negativePrompt).toBe('neg');
    expect(lastToast()!.message).toBe(t('cv.combo.done', { name: 'C', parts: [t('cv.combo.part.style'), t('cv.combo.part.positive'), t('cv.combo.part.character', { n: 2 })].join(t('c.listSep')) }));
  });
  it('without Style members the Style stays byte for byte', () => {
    applyComboByUse(t, 'C', [member('rain', 'base')], 'base', null);
    expect(useAppStore.getState().params.stylePrompt).toBe('old style');
  });
  it('character members need a chosen character; none on the canvas is said as it is; nothing is changed', () => {
    expect(planCombo(combo, 'base', null)).toEqual({ ok: false, refusal: 'cv.combo.pickChar' });
    expect(planCombo(combo, 'base', 'gone')).toEqual({ ok: false, refusal: 'cv.combo.pickChar' });
    useAppStore.setState({ charCaptions: [] });
    expect(applyComboByUse(t, 'C', combo, 'base', null)).toBe(false);
    expect(lastToast()!.message).toBe(t('cv.combo.noChars'));
    expect(useAppStore.getState().params.stylePrompt).toBe('old style');
  });
  it('a locked Style refuses Style members (base and legacy inpaint), not the separate inpaint recipe', () => {
    useAppStore.setState({ settings: { ...useAppStore.getState().settings!, lockStylePrompt: true } });
    expect(planCombo([member('x', 'style')], 'base', null)).toEqual({ ok: false, refusal: 'cv.combo.styleLocked' });
    expect(planCombo([member('x', 'style')], 'legacyInpaint', null)).toEqual({ ok: false, refusal: 'cv.combo.styleLocked' });
    expect(planCombo([member('x', 'base')], 'base', null).ok).toBe(true);
    useAppStore.setState({ inpaintRecipe: { ...DEFAULT_PARAMS, positivePrompt: 'r', stylePrompt: 'rs' } });
    expect(planCombo([member('x', 'style')], 'inpaint', null).ok).toBe(true);
  });
  it('legacy inpaint: Base members go to the inpaint prompt the canvas shows, Style to the shared Style; characters are not sent there', () => {
    applyComboByUse(t, 'C', [member('watercolor', 'style'), member('scarf', 'base')], 'legacyInpaint', null);
    const state = useAppStore.getState();
    expect(state.inpaintPositivePrompt).toBe('inpaint text, scarf');
    expect(state.params.positivePrompt).toBe('base, ');
    expect(state.params.stylePrompt).toBe('watercolor');
    expect(lastToast()!.message).toContain(t('cv.combo.part.inpaintPositive'));
    expect(planCombo(combo, 'legacyInpaint', 'c1')).toEqual({ ok: false, refusal: 'cv.combo.noCharsLegacy' });
  });
  it('the separate inpaint recipe: its own Style and positive prompt; no characters; none yet is refused', () => {
    expect(planCombo([member('x', 'base')], 'inpaint', null)).toEqual({ ok: false, refusal: 'cv.combo.noRecipe' });
    useAppStore.setState({ inpaintRecipe: { ...DEFAULT_PARAMS, positivePrompt: 'recipe', stylePrompt: 'rs' } });
    applyComboByUse(t, 'C', [member('ink', 'style'), member('scarf', 'base')], 'inpaint', null);
    const state = useAppStore.getState();
    expect(state.inpaintRecipe).toMatchObject({ stylePrompt: 'ink', positivePrompt: 'recipe, scarf' });
    expect(state.params).toMatchObject({ stylePrompt: 'old style', positivePrompt: 'base, ' });
    expect(planCombo(combo, 'inpaint', 'c1')).toEqual({ ok: false, refusal: 'cv.combo.noCharsInpaint' });
  });
  it('a weight outside 0–10 is refused', () => {
    expect(planCombo([member('x', 'base', 11)], 'base', null)).toEqual({ ok: false, refusal: 'cv.combo.badWeight' });
  });
  it('undo puts back only while the fields are as the combo left them', () => {
    applyComboByUse(t, 'C', combo, 'base', 'c1');
    clickUndo();
    expect(readComboFields('base', 'c1')).toEqual({ style: 'old style', positive: 'base, ', character: 'girl' });
    applyComboByUse(t, 'C', combo, 'base', 'c1');
    useAppStore.getState().setParam('positivePrompt', 'typed later');
    clickUndo();
    expect(useAppStore.getState().params.positivePrompt).toBe('typed later');
    expect(lastToast()!.message).toBe(t('cv.undo.changed'));
  });
  it('which character by default: the one the picker was opened from, else the only one, else none (the user picks)', () => {
    const captions = [{ id: 'a' }, { id: 'b' }];
    expect(defaultComboCharacter('b', captions)).toBe('b');
    expect(defaultComboCharacter(undefined, captions)).toBe('');
    expect(defaultComboCharacter(undefined, [{ id: 'a' }])).toBe('a');
  });
  it('the library combo tray: same rules, the chosen character (not the first one)', () => {
    expect(applyTrayToCanvas([member('smiling', 'character')], null, t)).toBe('cv.combo.pickChar');
    expect(applyTrayToCanvas([member('smiling', 'character'), member('rain', 'base')], 'c2', t)).toBeNull();
    expect(useAppStore.getState().charCaptions.map(caption => caption.prompt)).toEqual(['girl', 'boy, smiling']);
    expect(useAppStore.getState().params.positivePrompt).toBe('base, rain');
  });
});

describe('artist picks: recipe first, applied on request, undone only while unchanged (review rework)', () => {
  const pick = (image?: Record<string, unknown>) => ({ kind: 'artist_favorite', id: 'f1', revision: 1, name: 'pick', payload: { basePrompt: '1girl, portrait', prompt: 'artist:a', generationSeed: 77, generationModel: 'nai-diffusion-4-5-curated', ...(image ? { image } : {}) } }) as never;
  const image = { params: { ...DEFAULT_PARAMS, model: 'nai-diffusion-4-5-full', width: 1216, height: 832, steps: 23, cfgScale: 5.5 }, actualSeed: 9, model: 'nai-diffusion-4-5-full' };

  it('applies the whole recipe (model too, seed fixed) and the undo restores every setting from before', () => {
    const before = useAppStore.getState().params;
    expect(applyArtistRecipe(t, pick(image))).toBe(true);
    expect(useAppStore.getState().params).toMatchObject({ model: 'nai-diffusion-4-5-curated', positivePrompt: '1girl, portrait', stylePrompt: 'artist:a', width: 1216, height: 832, steps: 23, seedMode: 'fixed', seed: 77 });
    clickUndo();
    expect(useAppStore.getState().params).toEqual(before);
    expect(window.naiDesktop.setSetting).toHaveBeenCalledWith('lastGenerationState', expect.objectContaining({ params: expect.objectContaining({ model: before.model }) }));
  });
  it('a setting changed since is kept: nothing is undone', () => {
    applyArtistRecipe(t, pick(image));
    useAppStore.getState().setParam('steps', 40);
    clickUndo();
    expect(useAppStore.getState().params).toMatchObject({ steps: 40, model: 'nai-diffusion-4-5-curated' });
    expect(lastToast()!.message).toBe(t('cv.undo.changed'));
  });
  it('without a complete recipe nothing is applied', () => {
    const before = useAppStore.getState().params;
    expect(applyArtistRecipe(t, pick())).toBe(false);
    expect(useAppStore.getState().params).toBe(before);
  });
  it('the picker offers artist picks only on the Txt2Img positive prompt (not in Inpaint, legacy or separate)', () => {
    expect(pickerTabs('positive', 'base', true)).toEqual(['tags', 'combos', 'chunks', 'presets', 'templates', 'artists']);
    expect(pickerTabs('positive', 'legacyInpaint', true)).not.toContain('artists');
    expect(pickerTabs('positive', 'inpaint', true)).not.toContain('artists');
    expect(pickerTabs('negative', 'base', true)).toEqual(['tags', 'combos', 'chunks', 'presets']);
    expect(pickerTabs('character', 'base', false)).not.toContain('artists');
  });
});

describe('guarded undo and the clears (review rework)', () => {
  it('compares values, not identity', () => {
    expect(sameValues({ a: [1, 'x'] }, { a: [1, 'x'] })).toBe(true);
    expect(sameValues('a', 'b')).toBe(false);
    let value = 'after', restored = false;
    expect(undoStep({ read: () => value, after: 'after', restore: () => { restored = true; } }, t)).toBe(true);
    expect(restored).toBe(true);
    value = 'changed'; restored = false;
    expect(undoStep({ read: () => value, after: 'after', restore: () => { restored = true; } }, t)).toBe(false);
    expect(restored).toBe(false);
    showStepToast(t, 'm', { read: () => 1, after: 1, restore: () => {} });
    expect(lastToast()!.action?.label).toBe(t('cv.draft.undo'));
  });
  it('characters and references offer 清空 when there is something to clear', () => {
    let html = renderToStaticMarkup(<CharactersSection />);
    expect(html).toContain('data-testid="cv-char-clear"');
    useAppStore.setState({ charCaptions: [] });
    html = renderToStaticMarkup(<CharactersSection />);
    expect(html).not.toContain('data-testid="cv-char-clear"');
    expect(renderToStaticMarkup(<ReferencesSection />)).not.toContain('data-testid="cv-ref-clear"');
    useAppStore.setState({ vibeImages: [{ id: 'v', base64: 'x', previewUrl: '', infoExtracted: 1, strength: 1 }] });
    expect(renderToStaticMarkup(<ReferencesSection />)).toContain('data-testid="cv-ref-clear"');
  });
  it('each reference button has its own file input in its own paste area (image-paste picks exactly one)', () => {
    const html = renderToStaticMarkup(<ReferencesSection />);
    const areas = html.split('data-image-input-area').slice(1).map(part => part.slice(0, part.indexOf('</span>')));
    expect(areas).toHaveLength(2);
    for (const area of areas) expect(area.match(/type="file"/g)).toHaveLength(1);
  });
});

describe('literal prompt joining (the old adoptPromptAssemblyV1 test, restored)', () => {
  it('base: only promptAssemblyVersion changes, and it is persisted', () => {
    const base = { ...useAppStore.getState().params };
    delete (base as Partial<typeof base>).promptAssemblyVersion;
    useAppStore.setState({ params: base });
    expect(adoptPromptAssemblyV1('base')).toBe(true);
    const adopted = { ...useAppStore.getState().params };
    expect(adopted.promptAssemblyVersion).toBe(1);
    delete (adopted as Partial<typeof adopted>).promptAssemblyVersion;
    expect(adopted).toEqual(base);
    expect(window.naiDesktop.setSetting).toHaveBeenCalledWith('lastGenerationState', expect.objectContaining({ params: expect.objectContaining({ promptAssemblyVersion: 1 }) }));
  });
  it('strict replay keeps preservePromptText', () => {
    const strict = { ...useAppStore.getState().params, preservePromptText: true };
    delete (strict as Partial<typeof strict>).promptAssemblyVersion;
    useAppStore.setState({ params: strict });
    adoptPromptAssemblyV1('base');
    expect(useAppStore.getState().params).toMatchObject({ promptAssemblyVersion: 1, preservePromptText: true });
  });
  it('inpaint: the separate recipe only (none: false); the base recipe is untouched', () => {
    expect(adoptPromptAssemblyV1('inpaint')).toBe(false);
    const inpaint = { ...DEFAULT_PARAMS, positivePrompt: 'recipe' };
    delete (inpaint as Partial<typeof inpaint>).promptAssemblyVersion;
    const base = useAppStore.getState().params;
    useAppStore.setState({ inpaintRecipe: inpaint });
    expect(adoptPromptAssemblyV1('inpaint')).toBe(true);
    const adopted = { ...useAppStore.getState().inpaintRecipe! };
    expect(adopted.promptAssemblyVersion).toBe(1);
    delete (adopted as Partial<typeof adopted>).promptAssemblyVersion;
    expect(adopted).toEqual(inpaint);
    expect(useAppStore.getState().params).toBe(base);
  });
});
