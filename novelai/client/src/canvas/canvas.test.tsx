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
import { setWorkspaceRuntime } from '../workspace/runtime';
import type { WorkspaceController, WorkspaceView } from '../workspace/controller';
import { InpaintSettings, useInpaintBlock } from './sections/inpaint';
import { ModelSection, PromptSection, StyleSection } from './sections/prompt';
import { ParamsSection } from './sections/params';
import { CharactersSection } from './sections/characters';
import { ReferencesSection } from './sections/references';
import { DirectorSettings, EnhanceSettings, UpscaleSettings, fitSizeWithinPixels } from './sections/post';
import { DraftLayer, valueText } from './DraftReview';
import { costText } from './GenerateBar';
import { draftGroup, elide, promptDiff, reviewRows } from './draft-model';

const en = (key: Parameters<typeof uiText>[1], params?: Record<string, string | number>) => uiText('en', key, params);
const text = (html: string) => html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const source = { filePath: 'fixture.png', fileUrl: 'local-media://fixture.png', width: 1216, height: 832 };

beforeEach(() => {
  vi.stubGlobal('window', { naiDesktop: { setSetting: vi.fn().mockResolvedValue(undefined) } });
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    settings: { language: 'en-US', autoComplete: false, lockNegativePrompt: true, lockStylePrompt: true } as never,
    params: { ...DEFAULT_PARAMS, model: 'nai-diffusion-4-5-full', positivePrompt: 'base composition', negativePrompt: 'base negative', stylePrompt: 'base style', seedMode: 'fixed', seed: 111 },
    inpaintModel: 'nai-diffusion-4-5-full-inpainting',
    inpaintRecipe: { ...DEFAULT_PARAMS, model: 'nai-diffusion-4-5-full', positivePrompt: 'small silver brooch', negativePrompt: 'oversized badge', stylePrompt: 'local shading', seedMode: 'fixed', seed: 222 },
    inpaintPositivePrompt: 'legacy detail',
    charCaptions: [{ id: 'adult', prompt: 'adult woman', negativePrompt: '', useCoords: false, x: 0.5, y: 0.5 }],
    workbenchImage: source,
  });
});
afterEach(() => { setWorkspaceRuntime(null); vi.unstubAllGlobals(); });

describe('inpaint settings of the rebuilt canvas (step 4b3; the old independent-recipe editor checks)', () => {
  it('shows the separate recipe: its positive prompt, Style and seed, and the source size; no base-only sections', () => {
    const html = renderToStaticMarkup(<InpaintSettings />);
    expect(html).toContain('small silver brooch');
    expect(html).toContain('value="local shading"');
    expect(html).toContain('value="222"');
    expect(text(html)).toContain(en('cv.size.locked', { size: '1216×832' }));
    expect(html).not.toContain('base composition');
    expect(html).not.toContain('value="base style"');
    expect(html).not.toContain('data-testid="cv-characters"');
    expect(html).not.toContain('data-testid="cv-references"');
    expect(html).toContain('aria-checked="true"'); // the separate-settings switch is on
  });
  it('edits the separate negative prompt without the base lock', () => {
    useAppStore.setState({ promptTab: 'negative' });
    const html = renderToStaticMarkup(<InpaintSettings />);
    expect(html).toContain('oversized badge');
    expect(html).not.toContain('base negative');
    expect(html).not.toContain(`aria-label="${en('cv.unlock')}"`);
    expect(html).not.toContain(`>${en('cv.unlock')}<`);
  });
  it('without the separate recipe: the inpaint positive prompt and the shared base negative prompt with its lock', () => {
    useAppStore.setState({ inpaintRecipe: null });
    expect(renderToStaticMarkup(<InpaintSettings />)).toContain('legacy detail');
    useAppStore.setState({ promptTab: 'negative' });
    const html = renderToStaticMarkup(<InpaintSettings />);
    expect(html).toContain('base negative');
    expect(text(html)).toContain(en('cv.unlock'));
  });
  it('names why a click would be refused before any request', () => {
    const block = () => { let value = ''; function Probe() { value = useInpaintBlock(); return null; } renderToStaticMarkup(<Probe />); return value; };
    expect(block()).toBe(en('cv.ip.needMask'));
    useAppStore.setState({ inpaintMask: 'mask' });
    expect(block()).toBe('');
    useAppStore.setState({ vibeImages: [{ id: 'v', base64: 'x', previewUrl: '', infoExtracted: 1, strength: 1 }] });
    expect(block()).toBe(en('cv.ip.noRefs'));
    useAppStore.setState({ vibeImages: [], inpaintRecipe: { ...useAppStore.getState().inpaintRecipe!, model: 'nai-diffusion-5-full' } });
    expect(block()).toBe(en('cv.ip.modelMismatch'));
  });
});

describe('base sections', () => {
  it('render the base recipe with characters, references and locks', () => {
    const html = renderToStaticMarkup(<><ModelSection /><PromptSection /><StyleSection /><CharactersSection /><ReferencesSection /><ParamsSection /></>);
    expect(html).toContain('base composition');
    expect(html).toContain('value="base style"');
    expect(html).toContain('adult woman');
    expect(html).toContain('data-testid="cv-references"');
    expect(html).toContain('value="111"');
    expect(html).toContain('data-testid="cv-size-832x1216"');
  });
  it('shows the old joining notice (strict replay and ordinary legacy) in the settings', () => {
    const strict = { ...useAppStore.getState().params, preservePromptText: true };
    delete (strict as Partial<typeof strict>).promptAssemblyVersion;
    useAppStore.setState({ params: strict });
    let html = renderToStaticMarkup(<ParamsSection />);
    expect(html).toContain('data-prompt-assembly="strict"');
    expect(text(html)).toContain(en('cv.asm.strictHint'));
    useAppStore.setState({ params: { ...strict, preservePromptText: false } });
    html = renderToStaticMarkup(<ParamsSection />);
    expect(html).toContain('data-prompt-assembly="legacy"');
    useAppStore.setState({ params: { ...strict, preservePromptText: false, promptAssemblyVersion: 1 } });
    // The literal joining (v1) shows its status line, without the switch (the old assemblyV1 status).
    const v1 = renderToStaticMarkup(<ParamsSection />);
    expect(v1).toContain('data-prompt-assembly="v1"');
    expect(text(v1)).toContain(en('cv.asm.v1'));
    expect(v1).not.toContain(en('cv.asm.adopt'));
  });
});

describe('post tools', () => {
  it('enhance: output size, the Txt2Img prompt it uses, and the 2× limit', () => {
    let html = renderToStaticMarkup(<EnhanceSettings />);
    expect(text(html)).toContain('base composition');
    expect(text(html)).toContain('1216×832 →');
    useAppStore.setState({ enhanceScale: 2, workbenchImage: { ...source, width: 2048, height: 2048 } });
    html = renderToStaticMarkup(<EnhanceSettings />);
    expect(html).toContain('cv-note--warn');
  });
  it('upscale: the shrink before a large source, and the 4× output limit', () => {
    useAppStore.setState({ upscaleScale: 2, workbenchImage: { ...source, width: 1024, height: 1536 } });
    const html = renderToStaticMarkup(<UpscaleSettings />);
    const prepared = fitSizeWithinPixels(1024, 1536, 1024 * 1024);
    expect(prepared.resized).toBe(true);
    expect(text(html)).toContain(`${prepared.width}×${prepared.height}`);
    useAppStore.setState({ upscaleScale: 4 });
    expect(renderToStaticMarkup(<UpscaleSettings />)).toContain('cv-note--warn');
  });
  it('director: six tools, the colorize prompt and the emotion controls only for their tool', () => {
    let html = renderToStaticMarkup(<DirectorSettings />);
    for (const tool of ['bg-removal', 'lineart', 'sketch', 'colorize', 'emotion', 'declutter']) expect(html).toContain(`data-testid="cv-pp-tool-${tool}"`);
    expect(html).not.toContain('data-testid="cv-pp-colorize"');
    useAppStore.setState({ directorTool: 'colorize' });
    html = renderToStaticMarkup(<DirectorSettings />);
    expect(html).toContain('data-testid="cv-pp-colorize"');
  });
});

describe('cost on the generate button', () => {
  it('reads free, estimated, official, loading and the reasons', () => {
    const t = (key: Parameters<typeof uiText>[1], params?: Record<string, string | number>) => en(key, params);
    expect(costText(t, { ok: true, amount: 0, source: 'official-api' } as never, false)).toBe(en('cv.gen.free'));
    expect(costText(t, { ok: true, amount: 3, source: 'estimate-formula' } as never, false)).toBe(en('cv.gen.cost', { n: 3 }));
    expect(costText(t, { ok: true, amount: 17, source: 'official-api' } as never, false)).toBe(en('cv.gen.costExact', { n: 17 }));
    expect(costText(t, null, true)).toBe(en('cv.gen.costLoading'));
    expect(costText(t, { ok: false, reason: 'missing-image' } as never, false)).toBe(en('cv.gen.noImage'));
  });
});

describe('agent drafts', () => {
  const draft = { draftId: 'draft-1', baseRevision: 4, kind: 'edit' as const, changes: [
    { field: 'params.positivePrompt', before: '1girl, solo, cafe interior, window light, holding cup, upper body, warm lighting', after: '1girl, solo, cafe interior, evening, holding cup, cowboy shot, warm lighting' },
    { field: 'params.width', before: 832, after: 1216 }, { field: 'params.height', before: 1216, after: 832 },
    { field: 'params.seedMode', before: 'fixed', after: 'random' },
  ] };
  const controller = (view: WorkspaceView) => ({ getView: () => view, subscribe: () => () => {}, execute: vi.fn(), discardDraft: vi.fn() }) as unknown as WorkspaceController;

  it('maps fields to the left-column groups', () => {
    expect(draftGroup('params.positivePrompt')).toBe('prompt');
    expect(draftGroup('params.width')).toBe('size');
    expect(draftGroup('params.seed')).toBe('seed');
    expect(draftGroup('params.steps')).toBe('params');
    expect(draftGroup('charCaptions')).toBe('chars');
    expect(draftGroup('inpaintRecipe.stylePrompt')).toBe('inpaintStyle');
    expect(draftGroup('inpaintMask')).toBe('mask');
    expect(draftGroup('augmentOptions')).toBe('director');
  });
  it('merges width and height, and seed and its mode, into one review row each', () => {
    const rows = reviewRows(draft, { seed: 1844674 });
    expect(rows.map(row => row.id)).toEqual(['params.positivePrompt', 'params.size', 'params.seed']);
    const t = (key: Parameters<typeof uiText>[1], params?: Record<string, string | number>) => en(key, params);
    expect(valueText(t, rows[1], rows[1].before, 'en-US')).toBe('832 × 1216');
    expect(valueText(t, rows[1], rows[1].after, 'en-US')).toBe('1216 × 832');
    expect(valueText(t, rows[2], rows[2].before, 'en-US')).toBe('1844674');
    expect(valueText(t, rows[2], rows[2].after, 'en-US')).toBe(en('cv.draft.random'));
  });
  it('marks removed and added prompt parts and shortens long unchanged runs', () => {
    const diff = promptDiff(draft.changes[0].before as string, draft.changes[0].after as string);
    expect(diff.before.filter(part => part.op === 'del').map(part => part.text)).toEqual(['window light', 'upper body']);
    expect(diff.after.filter(part => part.op === 'ins').map(part => part.text)).toEqual(['evening', 'cowboy shot']);
    expect(elide(diff.before).some(part => part.op === 'gap')).toBe(true);
  });
  it('shows a cyan banner with discard, review and apply; an out-of-date draft turns yellow and can only be discarded', () => {
    setWorkspaceRuntime(controller({ workspaceId: 'w', revision: 4, draft, undoAvailable: false }));
    let html = renderToStaticMarkup(<DraftLayer />);
    expect(html).toContain('data-testid="cv-draft-banner"');
    expect(text(html)).toContain(en('cv.draft.title', { name: 'Agent' }));
    for (const id of ['cv-draft-discard', 'cv-draft-review', 'cv-draft-apply']) expect(html).toContain(`data-testid="${id}"`);
    expect(html).not.toContain('data-stale');
    setWorkspaceRuntime(controller({ workspaceId: 'w', revision: 5, draft, undoAvailable: false }));
    html = renderToStaticMarkup(<DraftLayer />);
    expect(html).toContain('data-stale="true"');
    expect(text(html)).toContain(en('cv.draft.stale'));
    expect(html).toContain('data-testid="cv-draft-discard"');
    expect(html).not.toContain('data-testid="cv-draft-apply"');
  });
  it('never shows a source the window staged itself, and marks only the changed sections', () => {
    setWorkspaceRuntime(controller({ workspaceId: 'w', revision: 4, draft: { ...draft, kind: 'source_selection', origin: 'client' }, undoAvailable: false }));
    expect(renderToStaticMarkup(<DraftLayer />)).toBe('');
    setWorkspaceRuntime(controller({ workspaceId: 'w', revision: 4, draft, undoAvailable: false }));
    const html = renderToStaticMarkup(<><PromptSection /><StyleSection /><ParamsSection /></>);
    expect(html.match(/cv-draft-badge/g)?.length).toBe(2); // prompt and settings, not Style
    expect(html).toContain('is-draft'); // the target size chip
    expect(html).toContain('base composition'); // the value itself is unchanged
  });
});

describe('library picker (step 4b3c)', () => {
  it('asks the library page list for one kind, archived left out', async () => {
    const { pickerRequest } = await import('./LibraryPicker');
    expect(pickerRequest('tag', ' cat ')).toEqual({ action: 'ui-list', kinds: ['tag'], query: 'cat', archived: 'exclude', sortBy: 'updatedAt', sortDirection: 'desc' });
    expect(pickerRequest('history', '')).toMatchObject({ kinds: ['history'], sortBy: 'createdAt' });
  });
  it('inserts tags and combos with their weights, snippets and presets as written; Danbooru artists as artist:', async () => {
    const { insertionText, danbooruText } = await import('./LibraryPicker');
    const item = (kind: string, payload: Record<string, unknown>) => ({ kind, id: 'x', revision: 1, name: 'n', payload }) as never;
    expect(insertionText(item('tag', { kind: 'tag', name: 'n', tag: { text: 'smile', source: 'danbooru', category: 'general', target: 'base' } }))).toBe('smile');
    expect(insertionText(item('combo', { kind: 'combo', name: 'n', components: [{ text: 'rain', source: 'english', category: null, target: 'base', weight: 1.2 }, { text: 'wlop', source: 'danbooru', category: 'artist', target: 'style', weight: 1 }] }))).toBe('1.2::rain ::, artist:wlop');
    expect(insertionText(item('prompt_chunk', { content: 'night, city' }))).toBe('night, city');
    expect(insertionText(item('positive_preset', { prompt: '1girl, cafe' }))).toBe('1girl, cafe');
    expect(danbooruText('wlop', 1)).toBe('artist:wlop');
    expect(danbooruText('smile', 0)).toBe('smile');
  });
  it('the prompt box opens the picker from 预设 and 素材库; the old preset and snippet buttons are gone', () => {
    const html = renderToStaticMarkup(<PromptSection />);
    expect(html).toContain('data-testid="cv-prompt-presets"');
    expect(html).toContain('data-testid="cv-prompt-library"');
    expect(html).not.toContain('prompt-tool-btn');
    const refs = renderToStaticMarkup(<ReferencesSection />);
    expect(refs).toContain('data-testid="cv-ref-presets"');
  });
});
