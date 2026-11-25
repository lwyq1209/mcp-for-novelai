import { afterEach, describe, expect, it, vi } from 'vitest';
// SSR reads a zustand store's initial state; select from the live state instead (as the other SSR tests do).
vi.mock('../store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store')>();
  const store = actual.useAppStore;
  const select = (selector: (state: ReturnType<typeof store.getState>) => unknown) => selector(store.getState());
  return { ...actual, useAppStore: Object.assign(select, store) };
});

import { renderToStaticMarkup } from 'react-dom/server';
import { assetQueryClient } from '../asset-library/query';
import type { AssetDetail, AssetItem } from '../asset-library/types';
import type { ImageMetadataReport } from '../png-meta';
import { useAppStore } from '../store';
import { uiText } from '../ui/i18n';
import { StylePresetFields, StylePresetView, stylePresetDraftError, stylePresetDraftOf, stylePresetDraftParams, stylePresetPatch } from './StylePresetDetail';
import { saveImageStylePreset, stylePresetFromReport } from './StudyStylePreset';
import { saveEdit } from './MaterialDetail';

// A Style preset in the library (issue #1): the structured fields shown, edited and saved, and a preset made from an
// imported image. Pure functions and server-rendered markup; the host side is electron/asset-library-style-presets.test.ts.
afterEach(() => { assetQueryClient.clear(); useAppStore.setState({ settings: null as never }); });
const setLanguage = (language: 'zh-CN' | 'en-US') => useAppStore.setState({ settings: { language } as never });
const t = (key: Parameters<typeof uiText>[1], params?: Record<string, string | number>) => uiText('zh', key, params);
const CJK = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;
const stored = {
  id: 'ink', name: 'Ink', prompt: 'ink lineart, flat color', group: 'Line', createdAt: '2026-11-25T00:00:00.000Z',
  artists: [{ name: 'artist:alpha', weight: 1, enabled: true }, { name: 'artist:beta', weight: 1.3, enabled: true }, { name: 'artist:off', weight: 1, enabled: false }],
  negativePrompt: '3d, photo', textNegativePrompt: 'text, speech bubble',
  params: { model: 'nai-diffusion-5-full', steps: 28, cfgScale: 5, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', ucPreset: 0, qualityPreset: 'standard' }, notes: 'One character: Base only.',
  previewImages: [{ id: 's1', name: 'bench.png', filePath: '/data/style-prompt-previews/ink/s1.png', fileUrl: 'stale://s1', createdAt: '2026-11-25T00:00:00.000Z', label: '单人' }, { id: 's2', name: 'ref.png', filePath: '/data/style-prompt-previews/ink/s2.png', fileUrl: 'stale://s2', createdAt: '2026-11-25T00:00:00.000Z' }],
};
const item = (payload: Record<string, unknown> = stored, patch: Partial<AssetItem> = {}) => ({ kind: 'style_preset', id: 'ink', revision: 4, name: 'Ink', archived: false, payload, ...patch } as AssetItem);
const detail = (payload: Record<string, unknown> = stored): AssetDetail => ({ item: item(payload), assets: [{ id: 'a1', role: 'preview:0', fileUrl: 'served://s1' }, { id: 'a2', role: 'preview:1', fileUrl: 'served://s2' }], links: [] });
const api = { assetLibrary: vi.fn(async () => ({})) };

describe('the edit draft of a Style preset', () => {
  it('reads the stored fields, numbers as the text being typed, and writes back only what changed', () => {
    const draft = stylePresetDraftOf(stored);
    expect(draft).toEqual({ artists: stored.artists, negativePrompt: '3d, photo', textNegativePrompt: 'text, speech bubble', params: { model: 'nai-diffusion-5-full', steps: '28', cfgScale: '5', sampler: 'k_euler_ancestral', noiseSchedule: 'karras', ucPreset: 0, qualityPreset: 'standard' } });
    expect(stylePresetPatch(draft, stored)).toEqual({});
    expect(stylePresetDraftParams(draft)).toEqual(stored.params);
    // One artist switched off, one setting cleared, one changed: each changed field as a whole value.
    const edited = { ...draft, artists: draft.artists.map((artist, index) => index === 1 ? { ...artist, enabled: false } : artist), params: { ...draft.params, steps: ' 23 ', sampler: '' }, textNegativePrompt: '' };
    expect(stylePresetPatch(edited, stored)).toEqual({ artists: [stored.artists[0], { ...stored.artists[1], enabled: false }, stored.artists[2]], textNegativePrompt: '',
      params: { model: 'nai-diffusion-5-full', steps: 23, cfgScale: 5, noiseSchedule: 'karras', ucPreset: 0, qualityPreset: 'standard' } });
    // A preset from before the structured fields keeps its plain shape when nothing of them is filled in.
    const plain = { id: 'old', name: 'Old', prompt: 'watercolor', group: '', createdAt: stored.createdAt };
    expect(stylePresetDraftOf(plain)).toEqual({ artists: [], negativePrompt: '', textNegativePrompt: '', params: {} });
    expect(stylePresetPatch(stylePresetDraftOf(plain), plain)).toEqual({});
    expect(stylePresetPatch({ ...stylePresetDraftOf(plain), negativePrompt: 'blurry' }, plain)).toEqual({ negativePrompt: 'blurry' });
  });
  it('names the first thing that cannot be saved', () => {
    const draft = stylePresetDraftOf(stored);
    expect(stylePresetDraftError(draft, t)).toBe('');
    expect(stylePresetDraftError({ ...draft, artists: [{ name: ' ', weight: 1, enabled: true }] }, t)).toBe('画师名称不能为空');
    expect(stylePresetDraftError({ ...draft, artists: [{ name: 'artist:a', weight: Number.NaN, enabled: true }] }, t)).toBe('画师权重要是数字');
    for (const [params, message] of [[{ steps: '0' }, '步数要是 1–50 的整数'], [{ steps: '27.5' }, '步数要是 1–50 的整数'], [{ steps: 'x' }, '步数要是 1–50 的整数'], [{ cfgScale: '11' }, '引导要在 0–10 之间'], [{ cfgRescale: '-0.1' }, '引导缩放要在 0–1 之间']] as const)
      expect(stylePresetDraftError({ ...draft, params }, t), JSON.stringify(params)).toBe(message);
    expect(stylePresetDraftError({ ...draft, params: { steps: '', cfgScale: ' ' } }, t)).toBe('');
  });
  it('saves through one update of the preset: name, group, the rest of the Style and the changed structured fields', async () => {
    const calls: Array<Record<string, unknown>> = [], library = { assetLibrary: async (args: Record<string, unknown>) => { calls.push(args); return {}; } };
    const base = { name: 'Ink', group: 'Line', notes: stored.notes, text: '', source: 'danbooru', target: 'base', prompt: stored.prompt, components: [], strength: 1, infoExtracted: 1, fidelity: 1, style: stylePresetDraftOf(stored) } as never as Parameters<typeof saveEdit>[2];
    await saveEdit(library, item(), base);
    await saveEdit(library, item(), { ...base, notes: 'Two characters: character boxes.', prompt: 'ink', style: { ...base.style, negativePrompt: '3d' } });
    expect(calls.map(call => call.patch)).toEqual([{ name: 'Ink', group: 'Line', prompt: stored.prompt }, { name: 'Ink', group: 'Line', prompt: 'ink', notes: 'Two characters: character boxes.', negativePrompt: '3d' }]);
    expect(calls[0]).toMatchObject({ action: 'mutate', command: 'update', items: [{ kind: 'style_preset', id: 'ink', expectedRevision: 4 }] });
  });
});

describe('the Style preset in the drawer (SSR)', () => {
  it('shows the Style as it is applied, the artists with the ones that are off, both negative texts, the settings and the labelled samples', () => {
    setLanguage('zh-CN');
    const html = renderToStaticMarkup(<StylePresetView api={api} detail={detail()} />);
    for (const part of ['套用后的 Style', 'artist:alpha, 1.3::artist:beta::, ink lineart, flat color', '画师', '2/3', 'artist:off', '停用', '配套负面提示词', '3d, photo', '禁文字负面词', 'text, speech bubble', '推荐参数', '步数', '28', 'Euler Ancestral', '样张', '2/6', '单人', '加说明', '从素材库添加', '导入本地图片']) expect(html, part).toContain(part);
    // The pictures come from this read's URLs, not from the saved ones of an earlier run.
    expect(html).toContain('src="served://s1"'); expect(html).not.toContain('stale://');
    // A preset with only its prompt: the Style and the (empty) samples, no empty sections.
    const plain = renderToStaticMarkup(<StylePresetView api={api} detail={{ item: item({ id: 'old', name: 'Old', prompt: 'watercolor', group: '', createdAt: stored.createdAt }), assets: [], links: [] }} />);
    expect(plain).toContain('watercolor'); expect(plain).toContain('还没有样张');
    for (const absent of ['画师', '配套负面提示词', '禁文字负面词', '推荐参数']) expect(plain, absent).not.toContain(absent);
    // Six samples: no more can be added from the library; an archived preset is only shown.
    const six = { ...stored, previewImages: Array.from({ length: 6 }, (_, index) => ({ ...stored.previewImages[0], id: `s${index}` })) };
    expect(renderToStaticMarkup(<StylePresetView api={api} detail={detail(six)} />)).toMatch(/<button[^>]*disabled=""[^>]*data-testid="style-preset-add-sample"|data-testid="style-preset-add-sample"[^>]*disabled=""/);
    expect(renderToStaticMarkup(<StylePresetView api={api} detail={{ ...detail(), item: item(stored, { archived: true }) }} />)).not.toContain('从素材库添加');
  });
  it('edits the artists, the rest of the Style with the applied text, the negatives and the settings; English has no Chinese', () => {
    setLanguage('zh-CN');
    const fields = (language: 'zh-CN' | 'en-US') => { setLanguage(language); return renderToStaticMarkup(<StylePresetFields draft={stylePresetDraftOf(stored)} prompt={stored.prompt} onChange={() => undefined} onPrompt={() => undefined} />); };
    const zh = fields('zh-CN');
    for (const part of ['启用画师 1', 'value="artist:beta"', 'value="1.3"', '移除画师 3', '添加画师', '从下面的文本里提取画师', '其余 Style 文本', 'artist:alpha, 1.3::artist:beta::, ink lineart, flat color', '把上面的禁文字词分到这里', '推荐参数', '不指定', 'value="28"']) expect(zh, part).toContain(part);
    const en = fields('en-US');
    for (const part of ['Use artist 1', 'Add artist', 'Rest of the Style', 'Style as applied', 'Text-suppressing negative', 'Recommended settings', 'Not set']) expect(en, part).toContain(part);
    expect(en.match(CJK)).toBeNull();
    setLanguage('en-US');
    expect(renderToStaticMarkup(<StylePresetView api={api} detail={detail({ ...stored, previewImages: [] })} />).match(CJK)).toBeNull();
  });
});

describe('a Style preset from an imported image', () => {
  const report = (imported: Record<string, unknown>) => ({ kind: 'novelai', software: 'NovelAI', imported, characterCaptions: [], entries: [], rawMetadata: {}, rawText: '', warnings: [] }) as never as ImageMetadataReport;
  it('takes the artists of the style text and of the prompt, holds the text negatives apart and keeps the settings the app generates with', () => {
    const draft = stylePresetFromReport(report({
      stylePrompt: 'artist:alpha, watercolor, 1.2::artist:beta::', positivePrompt: '1girl, garden, artist:gamma, Artist:Alpha, 0.8::artist:delta::, very aesthetic',
      negativePrompt: 'lowres, text, 3d, speech bubble, bad hands', model: 'nai-diffusion-5-full', steps: 28, cfgScale: 5, cfgRescale: 0.2, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', ucPreset: 3, qualityPreset: 'none', seed: 7, width: 832,
    }));
    expect(draft).toEqual({
      artists: [{ name: 'artist:alpha', weight: 1, enabled: true }, { name: 'artist:beta', weight: 1.2, enabled: true }, { name: 'artist:gamma', weight: 1, enabled: true }, { name: 'artist:delta', weight: 0.8, enabled: true }],
      prompt: 'watercolor', negativePrompt: 'lowres, 3d, bad hands', textNegativePrompt: 'text, speech bubble',
      params: { model: 'nai-diffusion-5-full', steps: 28, cfgScale: 5, cfgRescale: 0.2, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', ucPreset: 3, qualityPreset: 'none' },
    });
    // Another program's image: values this app does not generate with are left out; nothing is invented.
    expect(stylePresetFromReport(report({ positivePrompt: 'a castle', model: 'sdxl-base', steps: 80, cfgScale: 12, sampler: 'DPM++ 3M', noiseSchedule: 'beta', ucPreset: 9 }))).toEqual({ artists: [], prompt: '', negativePrompt: '', textNegativePrompt: '', params: {} });
  });
  it('creates the preset and adds the image as its first sample; a sample that cannot be added leaves the preset saved', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const library = (failSample = false) => ({ assetLibrary: async (args: Record<string, unknown>) => { calls.push(args); if (args.action === 'create') return { item: { id: 'new', revision: 1 } }; if (failSample) throw new Error('unreadable'); return {}; } });
    const draft = stylePresetFromReport(report({ stylePrompt: 'artist:alpha, watercolor', negativePrompt: 'text', steps: 28 }));
    expect(await saveImageStylePreset(library(), { id: 'study-1', revision: 2 }, { name: ' Watercolor ', group: '', draft, withParams: true, referenceLabel: '参考原图' })).toEqual({ id: 'new', sampleError: undefined });
    expect(calls).toEqual([
      { action: 'create', kind: 'style_preset', patch: { name: 'Watercolor', group: '', prompt: 'watercolor', artists: [{ name: 'artist:alpha', weight: 1, enabled: true }], textNegativePrompt: 'text', params: { steps: 28 } } },
      { action: 'mutate', command: 'add-preview', items: [{ kind: 'style_preset', id: 'new', expectedRevision: 1 }], image: { kind: 'study', id: 'study-1', revision: 2 }, label: '参考原图' },
    ]);
    calls.length = 0;
    const partial = await saveImageStylePreset(library(true), { id: 'study-1', revision: 2 }, { name: 'W', group: 'G', draft, withParams: false, referenceLabel: 'Reference' });
    expect(partial.id).toBe('new'); expect(partial.sampleError).toBeInstanceOf(Error);
    expect(calls[0].patch).toEqual({ name: 'W', group: 'G', prompt: 'watercolor', artists: [{ name: 'artist:alpha', weight: 1, enabled: true }], textNegativePrompt: 'text' });
  });
});
