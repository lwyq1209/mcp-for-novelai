import { afterEach, describe, expect, it, vi } from 'vitest';
// SSR reads a zustand store's initial state; select from the live state instead (as the other SSR tests do).
vi.mock('../store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store')>();
  const store = actual.useAppStore;
  const select = (selector: (state: ReturnType<typeof store.getState>) => unknown) => selector(store.getState());
  return { ...actual, useAppStore: Object.assign(select, store) };
});

import { renderToStaticMarkup } from 'react-dom/server';
import { assetQueryClient, assetQueryKey } from '../asset-library/query';
import type { AssetItem } from '../asset-library/types';
import { useAppStore } from '../store';
import { uiText } from '../ui/i18n';
import { createCaptureFixture } from './capture-fixture';
import { Sidebar } from './Sidebar';
import { VirtualGrid } from './VirtualGrid';
import type { LayoutSection } from './grid-layout';
import { SelectionBar } from './SelectionBar';
import { ImpactList, impactLines } from './dialogs';
import { TrashView } from './TrashView';
import { batchIndex, dayGroups, imageAspect, itemKey, membershipIndex, type BatchIndex, type MembershipIndex } from './model';
import { summarizeDeleteReceipt } from './impacts';

afterEach(() => assetQueryClient.clear());
const now = new Date();
const setLanguage = (language: 'zh-CN' | 'en-US') => useAppStore.setState({ settings: { ...(useAppStore.getState().settings ?? {}), language } as never });
const list = async (api: ReturnType<typeof createCaptureFixture>['api'], args: Record<string, unknown>) => (await api.assetLibrary({ action: 'list', limit: 100, ...args })).items as AssetItem[];
/** The virtual grid as the page renders it, laid out for a 1200×4000 view (server rendering has no window to measure). */
function grid(api: ReturnType<typeof createCaptureFixture>['api'], options: { images?: AssetItem[]; cards?: AssetItem[]; selected?: Set<string>; selecting?: boolean; memberships?: MembershipIndex; batches?: BatchIndex; tray?: boolean; lang?: 'zh' | 'en' }) {
  const images = options.images ?? [], cards = options.cards ?? [];
  const sections: LayoutSection[] = [];
  if (images.length) sections.push({ type: 'days', headings: true, groups: dayGroups(images, options.lang ?? 'zh', now).map(group => ({ key: group.key, label: group.label, count: group.items.length, items: group.items.map(item => ({ key: itemKey(item), aspect: imageAspect(item) })) })) });
  if (cards.length) sections.push({ type: 'cards', items: cards.map(item => ({ key: itemKey(item), estimate: () => 180 })) });
  return renderToStaticMarkup(<VirtualGrid api={api} scrollRef={{ current: null }} sections={sections} items={[...images, ...cards]} rowHeight={212} listKey="test" initialSize={{ width: 1200, height: 4000 }}
    selected={options.selected ?? new Set()} selecting={options.selecting ?? false} activeKey={null} memberships={options.memberships ?? new Map()} batches={options.batches ?? new Map()}
    onOpen={() => undefined} onSelect={() => undefined} collectEntries={() => []} onAddToTray={options.tray ? () => undefined : undefined} />);
}

describe('library views on the sample data (SSR)', () => {
  it('the sidebar lists sections with counts, collections, projects (with the historyGroup hint) and Recently deleted', async () => {
    setLanguage('zh-CN');
    const fixture = createCaptureFixture('zh', now);
    const { collections } = await fixture.api.assetLibrary({ action: 'collections' });
    const html = renderToStaticMarkup(<Sidebar view={{ type: 'category', category: 'history' }} onView={() => undefined} counts={{ history: 1284, imports: 36, tags: 212, combos: 18, notes: 9, presets: 24, artists: 41, trash: 8 }}
      collections={collections.filter((value: any) => value.namespace === 'user')} projects={collections.filter((value: any) => value.namespace === 'history')} memberCounts={{ 'user:c1': 24 }}
      onNewCollection={() => undefined} collectionMenu={() => []} projectMenu={() => []} />);
    for (const text of ['历史成图', '导入图片', '标签', '组合', '心得', '预设', '画师收藏', '收藏夹', '项目', '最近删除', '1,284', '夏日企划', 'cafe-scene']) expect(html).toContain(text);
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('historyGroup');
  });

  it('the image grid always shows the agent dot and the collection star; selection marks tiles', async () => {
    setLanguage('en-US');
    const fixture = createCaptureFixture('en', now);
    const items = await list(fixture.api, { kinds: ['history'] });
    const members = await list(fixture.api, { collectionId: 'user:c2', kinds: ['history'] });
    const html = grid(fixture.api, { images: items, lang: 'en', selected: new Set([`history:${items[0].id}`]), selecting: true, memberships: membershipIndex([{ collectionId: 'user:c2', items: members }]), batches: batchIndex(fixture.batches) });
    expect(html).toContain('Today');
    expect(html).toContain('lib-tile-src');
    expect(html).toContain('From Claude Code');
    expect(html).toContain('lib-tile-fav');
    expect(html).toContain('is-sel');
    expect(html.match(/data-testid="tile-/g)?.length).toBeGreaterThan(30);
  });

  it('cards show tags with use and post count, presets with their kind; tags and combos offer the tray', async () => {
    setLanguage('zh-CN');
    const fixture = createCaptureFixture('zh', now);
    const tags = await list(fixture.api, { kinds: ['tag'] });
    const html = grid(fixture.api, { cards: tags, tray: true });
    expect(html).toContain('smile');
    expect(html).toContain('1,640,122 帖');
    expect(html).toContain('全图');
    expect(html).toContain(uiText('zh', 'tile.addToTray'));
    const presets = await list(fixture.api, { kinds: ['style_preset', 'positive_preset', 'prompt_chunk', 'reference_preset'] });
    const presetHtml = grid(fixture.api, { cards: presets });
    for (const text of ['Style', '正文', '片段', '参考', '氛围参考']) expect(presetHtml).toContain(text);
    expect(presetHtml).not.toContain(uiText('zh', 'tile.addToTray'));
  });

  it('the selection bar and the delete confirmation read the host preview (sizes, shared files, collections, recipes, covers)', async () => {
    setLanguage('zh-CN');
    const fixture = createCaptureFixture('zh', now);
    const bar = renderToStaticMarkup(<SelectionBar count={6} allSelected={false} onAll={() => undefined} collectEntries={[]} projectEntries={[]} onExport={() => undefined} archived={false} onArchive={() => undefined} onDelete={() => undefined} onDone={() => undefined} />);
    for (const text of ['已选 6 项', '全选', '加入收藏夹', '移到项目', '导出', '归档', '删除', '完成']) expect(bar).toContain(text);
    const items = await list(fixture.api, { kinds: ['history'] });
    const selected = items.filter(item => ['h1', 'h2', 'h3', 'h5', 'h6', 'h7'].includes(item.id));
    const receipt = await fixture.api.assetLibrary({ action: 'mutate', command: 'delete', preview: true, items: selected.map(item => ({ kind: item.kind, id: item.id, expectedRevision: item.revision })) });
    const t = (key: Parameters<typeof uiText>[1], params?: Record<string, string | number>) => uiText('zh', key, params);
    const lines = impactLines(summarizeDeleteReceipt(receipt), t, 'zh', 'items').map(line => line.text);
    expect(lines[0]).toMatch(/^移走 5 个文件（共 1\d\.\d MB）$/);
    expect(lines).toContain('1 个文件也被其它条目使用，会留在原处');
    expect(lines).toContain('从收藏夹「夏日企划」「封面候选」中移除');
    expect(lines).toContain('2 份配方用它们当源图，之后入队会提示「来源不存在」');
    expect(lines).toContain('标签「cafe interior」的封面会被清空');
    const html = renderToStaticMarkup(<ImpactList title={t('del.impact')} lines={impactLines(summarizeDeleteReceipt(receipt), t, 'zh', 'items')} />);
    expect(html).toContain('is-warn');
    const archived = impactLines(summarizeDeleteReceipt(await fixture.api.assetLibrary({ action: 'mutate', command: 'delete-archived', preview: true })), t, 'zh', 'archived').map(line => line.text);
    expect(archived[0]).toBe('历史成图 7 · 标签 3 · Style 预设 2');
  });

  it('Recently deleted lists who deleted, when, days left (warning at 7 or fewer) and the impact', async () => {
    setLanguage('en-US');
    const fixture = createCaptureFixture('en', now);
    const page = await fixture.api.assetLibrary({ action: 'recently-deleted', offset: 0, limit: 100 });
    assetQueryClient.setQueryData(assetQueryKey(fixture.api, 'ui-trash'), { pages: [page], pageParams: [0] });
    const html = renderToStaticMarkup(<TrashView api={fixture.api} now={now.getTime()} />);
    for (const text of ['Recently deleted', 'You · ', 'Claude Code · ', 'Pi · ', '30 days left', '2 days left', 'Left 2 collections', 'Source of 1 recipe', '17 members (items kept)', 'Restore', 'Delete forever', 'Empty Recently deleted…']) expect(html).toContain(text);
    expect(html).toContain('lib-left is-warn');
    expect(html).toMatch(/8 items · \d+\.\d MB/);
  });
});
