import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// SSR reads a zustand store's initial state; select from the live state instead (as the other SSR tests do).
vi.mock('../store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store')>();
  const store = actual.useAppStore;
  const select = (selector: (state: ReturnType<typeof store.getState>) => unknown) => selector(store.getState());
  return { ...actual, useAppStore: Object.assign(select, store) };
});
// The UI kit's portal renders nothing on the server; render dialogs in place so their markup can be read.
vi.mock('../ui/Portal', () => ({ UiPortal: ({ children }: { children: unknown }) => children, uiPortalRoot: () => null }));

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { useAppStore } from '../store';
import { uiText } from '../ui/i18n';
import { DEFAULT_PARAMS, type HistoryItem, type StylePromptPreset } from '../types';
import { HistoryParametersDialog, historyApplyErrorText } from './HistoryParametersDialog';
import { ReferencePresetQuickSaveDialog } from './ReferenceQuickSave';
import { StylePresetImagesView } from './StylePresetImages';

const CJK = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;
const setLanguage = (language: 'zh-CN' | 'en-US') => useAppStore.setState({ settings: { ...(useAppStore.getState().settings ?? {}), language } as never });
const text = (html: string) => html.replace(/<[^>]*>/g, ' ');
/** The rendered <button> whose text is exactly `label`, and whether it is disabled. */
const button = (html: string, label: string) => {
  const match = [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].find(found => text(found[2]).trim() === label);
  return match ? { disabled: /\sdisabled=""/.test(match[1]), attrs: match[1] } : null;
};

const image: HistoryItem = { id: 'garden', filePath: '/fixtures/garden.png', fileUrl: 'nai-local://garden', model: DEFAULT_PARAMS.model, width: 832, height: 1216, date: '2026-09-12', createdAt: '2026-09-12T12:00:00Z', params: { ...DEFAULT_PARAMS, stylePrompt: 'watercolor', positivePrompt: 'adult gardener, garden', negativePrompt: '', seed: 321, seedMode: 'random' }, actualSeed: 7, characterSnapshot: { version: 1, captions: [{ prompt: 'adult gardener', negativePrompt: '', useCoords: true, x: .25, y: .75 }] }, feature: 'inpaint' } as HistoryItem;
const { characterSnapshot: _snapshot, feature: _feature, ...legacy } = image as HistoryItem & { feature?: string };
const sparse = { ...legacy, actualSeed: undefined, params: { positivePrompt: 'sunlit garden', cfgScale: '9' } } as unknown as HistoryItem;
const nothing = { ...legacy, actualSeed: undefined, params: {} } as unknown as HistoryItem;
const row: HistoryItem = { id: 'offline', filePath: '/fixture.png', fileUrl: 'fixture://image', model: DEFAULT_PARAMS.model, date: '2026-09-20', createdAt: '2026-09-20', width: 832, height: 1216, params: DEFAULT_PARAMS, actualSeed: 0, characterSnapshot: { version: 1, captions: [] } };

beforeEach(() => {
  useAppStore.setState({ ...useAppStore.getInitialState(), settings: { language: 'zh-CN' } as never }, true);
  vi.stubGlobal('window', { naiDesktop: { listReferencePresets: vi.fn(async () => ({ groups: [], presets: [] })), saveReferencePreset: vi.fn() }, addEventListener: vi.fn(), removeEventListener: vi.fn(), setTimeout });
});
afterEach(() => vi.unstubAllGlobals());

describe('restore saved parameters (step 4c2 rebuild)', () => {
  it('renders every block in English without Chinese, for full and sparse records', () => {
    setLanguage('en-US');
    for (const item of [image, sparse]) {
      const html = renderToStaticMarkup(<HistoryParametersDialog item={item} onClose={() => {}} />);
      expect(html).toContain('Restore saved parameters');
      expect(html).toContain('class="ui-modal');
      expect(html.match(CJK)).toBeNull();
    }
    const full = renderToStaticMarkup(<HistoryParametersDialog item={image} onClose={() => {}} />);
    for (const part of ['Source: garden.png', 'Restores the settings and saved characters only', 'Seed: 7', ' (fixed once applied)',
      'This image came from Inpaint', 'Character group (in saved order)', 'Character 1', 'Position: On · x=0.25, y=0.75', '<th>Parameter</th><th>Saved value</th><th>Value to apply</th>', 'Where an old value is out of range']) expect(full).toContain(part);
    expect(button(full, 'Apply to canvas')).toEqual(expect.objectContaining({ disabled: false }));
    expect(button(full, 'Cancel')).toEqual(expect.objectContaining({ disabled: false }));
    const old = text(renderToStaticMarkup(<HistoryParametersDialog item={sparse} onClose={() => {}} />));
    expect(old).toContain('Not saved: '); expect(old).toContain('Saved values that can’t be used: Guidance.');
    expect(old).toContain('your 0 current characters stay. References, the source image and the mask stay as they are');
  });

  it('renders every block in Chinese', () => {
    const html = renderToStaticMarkup(<HistoryParametersDialog item={image} onClose={() => {}} />);
    for (const part of ['恢复已保存的参数', '来源：garden.png', '只恢复参数和已保存的角色',
      '将用历史保存的整组 1 个角色替换当前角色。参考图、源图和蒙版保持现状（0 个氛围参考、0 个精确参考、无源图、无蒙版），不会出图；恢复的模型不支持它们时，出图前请检查。',
      '这张图来自局部重绘', '种子：7', '（应用后固定）', '整组角色（按保存顺序）', '角色 1', '位置：开启 · x=0.25，y=0.75',
      '<th>参数</th><th>历史保存值</th><th>将应用的值</th>', '>模型<']) expect(html).toContain(part);
    expect(button(html, '应用到画布')?.disabled).toBe(false);
    expect(button(html, '取消')?.disabled).toBe(false);
    const old = text(renderToStaticMarkup(<HistoryParametersDialog item={sparse} onClose={() => {}} />));
    expect(old).toContain('这条记录没有完整的角色信息，当前 0 个角色保留。');
    expect(old).toContain('实际 seed（当前种子与策略保留）'); expect(old).toContain('无法使用的保存值：引导。这些字段保留当前值。');
  });

  it('keeps the apply off while a generation runs, in both languages', () => {
    useAppStore.setState({ isGenerating: true });
    const zh = renderToStaticMarkup(<HistoryParametersDialog item={row} onClose={() => {}} />);
    expect(button(zh, '应用到画布')?.disabled).toBe(true);
    expect(zh).toContain('正在出图，结束后再恢复参数。');
    useAppStore.setState({ settings: { language: 'en-US' } as never });
    const en = renderToStaticMarkup(<HistoryParametersDialog item={row} onClose={() => {}} />);
    expect(button(en, 'Apply to canvas')?.disabled).toBe(true);
    expect(en).toContain('Generating; restore the settings when it ends.');
    expect(en.match(CJK)).toBeNull();
  });

  it('leaves the apply on once generation is idle, and off for a record with nothing to restore', () => {
    expect(button(renderToStaticMarkup(<HistoryParametersDialog item={row} onClose={() => {}} />), '应用到画布')?.disabled).toBe(false);
    const blocked = renderToStaticMarkup(<HistoryParametersDialog item={nothing} onClose={() => {}} />);
    expect(blocked).toContain('这条历史没有可恢复的生成参数。');
    expect(blocked).not.toContain('<table');
    expect(button(blocked, '应用到画布')?.disabled).toBe(true);
  });

  it('renders our apply errors by key and any other error through the host error text', () => {
    const en = (key: Parameters<typeof uiText>[1], params?: Parameters<typeof uiText>[2]) => uiText('en', key, params);
    const zh = (key: Parameters<typeof uiText>[1], params?: Parameters<typeof uiText>[2]) => uiText('zh', key, params);
    const ours = Object.assign(new Error('Generating.'), { uiKey: 'hp.generating' as const });
    expect(historyApplyErrorText(ours, zh, 'zh-CN')).toBe('正在出图，结束后再恢复参数。');
    expect(historyApplyErrorText(ours, en, 'en-US')).toBe('Generating; restore the settings when it ends.');
    expect(historyApplyErrorText(new Error('Store said no.'), en, 'en-US')).toBe('Store said no.');
    expect(historyApplyErrorText(undefined, en, 'en-US')).toBe('Couldn’t restore the parameters');
  });
});

describe('save a reference as a preset (step 4c2 rebuild)', () => {
  const source = { kind: 'vibe' as const, previewUrl: 'fixture://ref', base64: 'AAAA', infoExtracted: 1, strength: .6 };
  it('asks for a name and a group in both languages, from the new copy table', () => {
    const zh = renderToStaticMarkup(<ReferencePresetQuickSaveDialog source={source} onClose={() => {}} />);
    for (const part of ['存入预设', '预设名称', '分组', '选好图片和参数，保存后可以在画布上使用。', 'src="fixture://ref"']) expect(zh).toContain(part);
    expect(button(zh, '保存')?.disabled).toBe(false);
    expect(button(zh, '取消')?.disabled).toBe(false);
    setLanguage('en-US');
    const en = renderToStaticMarkup(<ReferencePresetQuickSaveDialog source={source} onClose={() => {}} />);
    for (const part of ['Save as preset', 'Preset name', 'Group']) expect(en).toContain(part);
    expect(button(en, 'Save')?.disabled).toBe(false);
    expect(en.match(CJK)).toBeNull();
    // The old shortcut to the material rail (no longer mounted) is gone.
    expect(zh).not.toMatch(/素材栏|library-shortcut/);
  });
});

describe('preset images (step 4c2 rebuild)', () => {
  const images = [{ id: 'a', name: 'a.png', fileUrl: 'fixture://a' }, { id: 'b', name: 'b.png', fileUrl: 'fixture://b' }];
  const preset = (count: number) => ({ id: 's1', name: 'Watercolor', prompt: 'watercolor', previewImages: images.concat([{ id: 'c', name: 'c.png', fileUrl: 'fixture://c' }]).slice(0, count) }) as unknown as StylePromptPreset;
  const view = (count: number, kind: 'style' | 'positive' = 'style') => renderToStaticMarkup(<StylePresetImagesView preset={preset(count)} kind={kind} onImport={() => {}} onDropImages={() => {}} onReplace={() => {}} onDelete={() => {}} onClose={() => {}} />);
  it('shows the empty drop area, the images with replace and delete, and the limit of three', () => {
    const empty = view(0);
    for (const part of ['风格参考图', 'Watercolor · 0/3', '尚未导入风格参考图', '将图片拖到这里，或点击选择图片', '每个风格最多 3 张；双击可以全屏查看。']) expect(empty).toContain(part);
    expect(button(empty, '导入图片')?.disabled).toBe(false);
    const two = view(2);
    expect(two).toContain('Watercolor · 2/3');
    expect(two.match(/>重新导入</g)).toHaveLength(2);
    expect(two.match(/>删除图片</g)).toHaveLength(2);
    expect(two).toContain('alt="Watercolor · a.png"');
    expect(two).toContain('data-image-paste="drop"');
    expect(button(view(3), '导入图片')?.disabled).toBe(true);
  });
  it('names prompt presets in a prompt preset’s dialog, and has no Chinese in English', () => {
    expect(view(0, 'positive')).toContain('尚未导入正文预设参考图');
    setLanguage('en-US');
    const en = view(2);
    for (const part of ['Style reference images', 'Re-import', 'Delete image', 'Import images', 'Close']) expect(en).toContain(part);
    expect(en.match(CJK)).toBeNull();
    expect(view(0, 'positive')).toContain('No prompt preset images yet');
    expect(view(0, 'positive').match(CJK)).toBeNull();
  });
});

describe('the rebuilt dialogs use the UI kit only', () => {
  it('import no old components, icons, confirmAction or old copy', () => {
    for (const file of ['HistoryParametersDialog.tsx', 'ReferenceQuickSave.tsx', 'StylePresetImages.tsx', path.join('..', 'library', 'ReferencePresets.tsx')]) {
      const source = readFileSync(path.resolve(__dirname, file), 'utf8');
      expect(source, file).not.toMatch(/components\/(ui|icons|confirm)['"]/);
      expect(source, file).not.toMatch(/from ['"]\.\.\/i18n['"]/);
      expect(source, file).not.toMatch(/confirmAction|desktopUiText|getGeneratePanelText|\bAppPortal\b|\bSelectMenu\b|\bNumberInput\b/);
      // Every class name written in the file (className="…", clsx('…', …) and the like) is a new one.
      const classes = [...source.matchAll(/className=(?:"([^"]*)"|\{(?:clsx\()?'([^']*)')/g)].flatMap(match => (match[1] ?? match[2]).split(/\s+/)).filter(Boolean);
      expect(classes.length, file).toBeGreaterThan(2);
      for (const name of classes) expect(name, file).toMatch(/^(ui-|hp-|rq-|spi-|rp-|rpi-|rp$|is-|has-)/);
      expect(source, file).not.toMatch(/modal-backdrop|reference-preset-(?!names)|history-parameters-|style-image-|app-confirm-|gallery-|aitag-pagination/);
    }
  });
});
