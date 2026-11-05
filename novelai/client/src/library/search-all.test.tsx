import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { createCaptureFixture } from './capture-fixture';
import { LIBRARY_CATEGORIES } from './model';
import { SearchAll, searchAllRequest, SEARCH_ALL_PER_GROUP } from './SearchAll';

afterEach(() => assetQueryClient.clear());
const setLanguage = (language: 'zh-CN' | 'en-US') => useAppStore.setState({ settings: { ...(useAppStore.getState().settings ?? {}), language } as never });
const textOf = (html: string) => html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('searching all categories (step 4c1)', () => {
  it('asks every category with the request its own view uses (one short page each)', () => {
    expect(searchAllRequest('history', ' cat ', 'exclude')).toEqual({ action: 'ui-list', kinds: ['history'], query: 'cat', archived: 'exclude', sortBy: 'createdAt', sortDirection: 'desc', limit: SEARCH_ALL_PER_GROUP });
    expect(searchAllRequest('presets', 'cat', 'include')).toMatchObject({ kinds: ['style_preset', 'positive_preset', 'prompt_chunk', 'reference_preset'], sortBy: 'updatedAt', archived: 'include' });
    expect(LIBRARY_CATEGORIES.map(category => searchAllRequest(category, 'x', 'exclude').kinds.length)).toEqual([1, 1, 1, 1, 1, 4, 1]);
  });

  it('groups the results by category with their whole counts; an empty category is left out; nothing found says so', async () => {
    const fixture = createCaptureFixture('en', new Date());
    const read = async (args: Record<string, unknown>) => fixture.api.assetLibrary({ ...args, action: 'list', limit: 100 }) as Promise<{ items: AssetItem[] }>;
    const history = (await read({ kinds: ['history'] })).items.slice(0, 3), tags = (await read({ kinds: ['tag'] })).items.slice(0, 2);
    for (const category of LIBRARY_CATEGORIES) {
      const page = category === 'history' ? { items: history, total: 41 } : category === 'tags' ? { items: tags, total: 2 } : { items: [], total: 0 };
      assetQueryClient.setQueryData(assetQueryKey(fixture.api, 'ui-search-all', searchAllRequest(category, 'cat', 'exclude')), page);
    }
    for (const language of ['zh-CN', 'en-US'] as const) {
      setLanguage(language);
      const html = renderToStaticMarkup(<SearchAll api={fixture.api} query="cat" archived="exclude" onOpen={() => {}} onShowAll={() => {}} />);
      expect(html).toContain('data-testid="search-all-history" data-total="41"');
      expect(html).toContain('data-testid="search-all-tags" data-total="2"');
      expect(html).not.toContain('search-all-notes');
      for (const item of [...history, ...tags]) expect(html).toContain(`data-testid="search-all-item-${item.id}"`);
      const text = textOf(html);
      expect(text).toContain(language === 'zh-CN' ? '全部类别中的「cat」' : 'All categories: “cat”');
      expect(text).toContain(language === 'zh-CN' ? '查看全部 41 项' : 'Show all 41');
      expect(text).toContain(language === 'zh-CN' ? '43 项' : '43 items');
      if (language === 'en-US') expect(text).not.toMatch(/[\u4e00-\u9fff]/);
    }
    assetQueryClient.clear();
    for (const category of LIBRARY_CATEGORIES) assetQueryClient.setQueryData(assetQueryKey(fixture.api, 'ui-search-all', searchAllRequest(category, 'zzz', 'exclude')), { items: [], total: 0 });
    setLanguage('en-US');
    expect(textOf(renderToStaticMarkup(<SearchAll api={fixture.api} query="zzz" archived="exclude" onOpen={() => {}} onShowAll={() => {}} />))).toContain('Nothing in any category');
  });
});
