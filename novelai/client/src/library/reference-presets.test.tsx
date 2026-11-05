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
import { assetQueryClient, assetQueryKey } from '../asset-library/query';
import { useAppStore } from '../store';
import { uiText } from '../ui/i18n';
import type { ReferenceImportCommitResult, ReferenceImportPreview, ReferencePreset, ReferencePresetLibrary } from '../types';
import ReferencePresetManager, { ImportResult, ReferenceImportReview, presetValuesText } from './ReferencePresets';

const CJK = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;
const setLanguage = (language: 'zh-CN' | 'en-US') => useAppStore.setState({ settings: { ...(useAppStore.getState().settings ?? {}), language } as never });
const text = (html: string) => html.replace(/<[^>]*>/g, ' ');
const button = (html: string, label: string) => {
  const match = [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].find(found => text(found[2]).trim() === label);
  return match ? { disabled: /\sdisabled=""/.test(match[1]) } : null;
};
/** The radiogroup labelled `label` and its radios (value text → checked, disabled). */
const radios = (html: string, label: string) => {
  const group = new RegExp(`<div role="radiogroup" aria-label="${label}"[^>]*>(.*?)</div>`).exec(html)?.[1];
  if (group === undefined) return null;
  return [...group.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].map(found => ({ label: text(found[2]).trim(), checked: /aria-checked="true"/.test(found[1]), disabled: /\sdisabled=""/.test(found[1]) }));
};

const preview: ReferenceImportPreview = { ok: true, importId: 'fixture', libraryRevision: 12, packageName: 'sfw-botanical.nairp', entries: [
  { entryId: 'new', name: 'Watercolor fern', kind: 'vibe', status: 'new', defaultAction: 'import', message: 'New reference', previewUrl: 'fixture://fern' },
  { entryId: 'same', name: 'Saved fern', kind: 'vibe', status: 'identical', defaultAction: 'skip', message: 'Same image and parameters', localNames: ['Fern A', 'Fern B'] },
  { entryId: 'conflict', name: 'Precise fern', kind: 'precise', status: 'conflict', defaultAction: 'skip', message: 'Same source, different parameters', parameters: { strength: 0.2 }, localParameters: [{ name: 'Local precise fern', parameters: { strength: 0.8 } }] },
  { entryId: 'invalid', name: 'Missing image', status: 'invalid', defaultAction: 'skip', message: '图片缺失' },
] };
const review = () => renderToStaticMarkup(<ReferenceImportReview preview={preview} onClose={() => {}} onCommitted={async () => {}} />);

const preset = (id: string, patch: Partial<ReferencePreset>): ReferencePreset => ({ id, name: id, group: '', kind: 'vibe', fileName: `${id}.png`, fileUrl: `fixture://${id}`, infoExtracted: .7, strength: .55, preciseType: 'character', fidelity: 1, informationExtracted: 1, width: 512, height: 512, createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z', ...patch } as ReferencePreset);
const library: ReferencePresetLibrary = { groups: ['Botanical'], presets: [preset('fern', { name: 'Fern', group: 'Botanical' }), preset('rose', { name: 'Rose', kind: 'precise', preciseType: 'character&style', strength: .4, fidelity: .9, createdAt: '2026-09-11T00:00:00Z' })] };
const naiDesktop = { listReferencePresets: vi.fn(async () => library), commitReferenceImport: vi.fn(), prepareReferenceImport: vi.fn() };

beforeEach(() => {
  useAppStore.setState({ ...useAppStore.getInitialState(), settings: { language: 'zh-CN' } as never }, true);
  vi.stubGlobal('window', { naiDesktop, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  assetQueryClient.setQueryData(assetQueryKey(naiDesktop, 'reference-presets'), library);
});
afterEach(() => { vi.unstubAllGlobals(); assetQueryClient.clear(); });

describe('reference import preview (step 4c2 rebuild)', () => {
  it('previews each entry with a conservative choice and the actual counts, without committing', () => {
    const html = review();
    expect(html).toContain('class="ui-modal');
    for (const part of ['预览参考预设导入', 'sfw-botanical.nairp · 共 4 项，确认后才会导入。', '相同的会跳过；来源相同但内容不同的可以另存副本，原预设不会被覆盖。',
      '>新增<', '>Vibe<', '>内容相同<', '>来源冲突<', '>精确参考<', '>无法导入<', '>未知类型<', '本机：Fern A、Fern B', '查看参数与来源', '本机：Local precise fern', 'alt="Watercolor fern 包内预览"', '图片缺失', '0.2', '0.8']) expect(html).toContain(part);
    expect(button(html, '确认导入 1 项，跳过 3 项')?.disabled).toBe(false);
    expect(button(html, '取消')?.disabled).toBe(false);
    // new: import (chosen) or skip; conflict: keep local (chosen) or save a copy; identical and invalid: skip only, fixed.
    expect(radios(html, 'Watercolor fern 处理方式')).toEqual([{ label: '跳过', checked: false, disabled: false }, { label: '导入新预设', checked: true, disabled: false }]);
    expect(radios(html, 'Precise fern 处理方式')).toEqual([{ label: '保留本地，不导入', checked: true, disabled: false }, { label: '另存为副本（保留原预设）', checked: false, disabled: false }]);
    expect(radios(html, 'Saved fern 处理方式')).toEqual([{ label: '跳过', checked: true, disabled: true }]);
    expect(radios(html, 'Missing image 处理方式')).toEqual([{ label: '跳过', checked: true, disabled: true }]);
    expect(naiDesktop.commitReferenceImport).not.toHaveBeenCalled();
  });

  it('renders the preview without Chinese in English (the host’s own message aside)', () => {
    setLanguage('en-US');
    const html = review().replace('图片缺失', '');
    expect(html.match(CJK)).toBeNull();
    for (const part of ['Preview reference preset import', 'sfw-botanical.nairp · 4 items; nothing is imported until you confirm.', '>New<', '>Same content<', '>Source conflict<', '>Can’t import<',
      '>Vibe Transfer<', '>Precise reference<', '>Unknown type<', 'On this device: Fern A, Fern B', 'On this device: Local precise fern', 'Show parameters and source', 'alt="Watercolor fern preview from the package"']) expect(html).toContain(part);
    expect(radios(html, 'Action for Saved fern')?.[0]).toEqual({ label: 'Skip', checked: true, disabled: true });
    expect(radios(html, 'Action for Precise fern')?.map(radio => radio.label)).toEqual(['Keep local, don’t import', 'Save as a copy (keep the original)']);
    expect(radios(html, 'Action for Watercolor fern')?.map(radio => radio.label)).toEqual(['Skip', 'Import as new preset']);
    expect(button(html, 'Import 1, skip 3')?.disabled).toBe(false);
    expect(button(html, 'Cancel')?.disabled).toBe(false);
  });

  it('shows the result: the host’s summary, failed entries and a new review when the package changed', () => {
    const result: ReferenceImportCommitResult = { ok: false, message: 'Imported 1, 1 failed', requiresReview: true, imported: 1, skipped: 2, failed: 1, entries: [
      { entryId: 'new', name: 'Watercolor fern', status: 'imported' }, { entryId: 'conflict', name: 'Precise fern', status: 'failed', message: 'Disk full' }] };
    const zh = renderToStaticMarkup(<ImportResult result={result} />);
    expect(zh).toContain('role="alert"'); expect(zh).toContain('Imported 1, 1 failed'); expect(zh).toContain('Precise fern：Disk full');
    expect(zh).toContain('关闭后重新选择预设包，核对最新差异再继续。'); expect(zh).not.toContain('Watercolor fern');
    setLanguage('en-US');
    const en = renderToStaticMarkup(<ImportResult result={{ ...result, ok: true, requiresReview: false, entries: [] }} />);
    expect(en).toContain('role="status"'); expect(en.match(CJK)).toBeNull();
    expect(uiText('en', 'rpi.summaryResult', { name: 'p.nairp', n: 1 })).toBe('p.nairp · 1 item');
  });
});

describe('reference preset manager (step 4c2 rebuild)', () => {
  it('shows the presets with every action, in Chinese from the new copy table', () => {
    const html = renderToStaticMarkup(<ReferencePresetManager />);
    for (const part of ['2 个预设 · 1 个分组', '创建参考预设', '导入 .nairp', '导出全部',
      'placeholder="搜索预设名称或分组"', '当前分组 · <b>全部</b>', '每排显示', '每页预设数', '每页 12 个预设', '创建分组', 'aria-label="新分组名称"',
      '>Fern<', '>Rose<', '>Botanical<', '>未分组<', '信息提取 0.70 · 强度 0.55', '参考类型 角色与风格 · 强度 0.40 · 保真度 0.90',
      'title="双击预览大图"', 'aria-label="移动“Fern”到分组"', '第 1 / 1 页 · 1–2 / 2', 'aria-label="选择页数"']) expect(html).toContain(part);
    expect(html.match(/>用到画布</g)).toHaveLength(2);
    expect(html.match(/>删除</g)).toHaveLength(2);
    expect(radios(html, '预设类型')?.map(radio => radio.label)).toEqual(['全部', '氛围参考', '精确参考']);
    // Newest first; one page: both page buttons off; no group chosen: no group export or delete; empty name: create group off.
    expect(html.indexOf('>Rose<')).toBeLessThan(html.indexOf('>Fern<'));
    expect(button(html, '上一页')?.disabled).toBe(true);
    expect(button(html, '下一页')?.disabled).toBe(true);
    expect(button(html, '创建分组')?.disabled).toBe(true);
    expect(button(html, '导出分组')).toBeNull();
    expect(button(html, '删除分组')).toBeNull();
    expect(button(html, '导入 .nairp')?.disabled).toBe(false);
    // The removed picker mode: no selection, no apply-selected footer.
    expect(html).not.toMatch(/应用所选预设|清空选择|type="checkbox"/);
  });

  it('has no Chinese in English', () => {
    setLanguage('en-US');
    const html = renderToStaticMarkup(<ReferencePresetManager />);
    expect(html.match(CJK)).toBeNull();
    for (const part of ['2 presets · 1 group', 'Create reference preset', 'Import .nairp', 'Export all', 'Cards per row', 'Presets per page', '12 presets per page', 'Create group',
      'Use on canvas', 'Delete', 'Double-click to preview', 'Move “Fern” to a group', 'Page 1 of 1 · 1–2 of 2', 'Ungrouped', 'Character and style']) expect(html).toContain(part);
  });

  it('shows the empty state when there are no presets', () => {
    assetQueryClient.setQueryData(assetQueryKey(naiDesktop, 'reference-presets'), { groups: [], presets: [] });
    const html = renderToStaticMarkup(<ReferencePresetManager />);
    expect(html).toContain('还没有保存的参考图预设');
    expect(html).not.toContain('aria-label="选择页数"');
  });

  it('formats a preset’s values for the card', () => {
    const t = (key: Parameters<typeof uiText>[1], params?: Parameters<typeof uiText>[2]) => uiText('en', key, params);
    expect(presetValuesText(t, library.presets[0])).toBe('Information extracted 0.70 · Strength 0.55');
    expect(presetValuesText(t, library.presets[1])).toBe('Reference type Character and style · Strength 0.40 · Fidelity 0.90');
  });

  it('keeps the entrance motion, the pagination and the in-app confirmations (the old source checks of ui-consistency)', () => {
    const source = readFileSync(path.resolve(__dirname, 'ReferencePresets.tsx'), 'utf8');
    expect(source).toContain('animateIn(section, "translateY(10px)", 240)');
    expect(source).toContain('LOCAL_PAGE_SIZE_OPTIONS');
    expect(source).toContain('disabled={localPage <= 1}');
    expect(source).toContain('disabled={localPage >= localPageCount}');
    expect(source).not.toMatch(/load-more|loadMore|window\.confirm\(|confirmAction|gsap|weui/i);
    expect(source.match(/<ConfirmDialog /g)).toHaveLength(2);
  });
});
