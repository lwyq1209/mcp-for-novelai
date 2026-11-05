import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryObserver } from '@tanstack/react-query';
import { mergeLibraryChanges } from './library-changes';
import { assetQueryClient, assetQueryKey, assetQueryNeedsRefresh, invalidateAssetQueries, invalidateAssetQueriesForChange } from './query';
import { waitUntil } from '../test-support/wait-until';

afterEach(() => { assetQueryClient.clear(); });
const api = {};
const query = (parts: unknown[], state: { status?: 'pending' | 'success' | 'error'; data?: unknown } = {}) => ({ queryKey: assetQueryKey(api, ...parts), state: { status: state.status ?? 'success', data: state.data } as never });
const batches = {
  history: mergeLibraryChanges([{ changedKinds: ['history'], ids: ['h1'] }]),
  historyAndTagKinds: mergeLibraryChanges([{ changedKinds: ['history'], ids: ['h1'] }, { changedKinds: ['tag'] }]),
  historyKinds: mergeLibraryChanges([{ changedKinds: ['history'] }]),
  note: mergeLibraryChanges([{ changedKinds: ['note'], ids: ['h1'] }]),
  reference: mergeLibraryChanges([{ changedKinds: ['reference_preset'], ids: ['r1'] }]),
  empty: mergeLibraryChanges([{ changedKinds: [], ids: [] }]),
  unknown: mergeLibraryChanges([{ revision: 4 }]),
};

describe('which cached reads a change batch refreshes', () => {
  it('never re-reads ready thumbnails; retries failed or unavailable ones on any change', () => {
    for (const batch of Object.values(batches)) {
      expect(assetQueryNeedsRefresh(query(['thumbnail', 'history', 'h1', 3, 'c'], { data: { status: 'ready', dataUrl: 'data:' } }), batch)).toBe(false);
      expect(assetQueryNeedsRefresh(query(['thumbnail', 'history', 'h1', 3, 'c'], { status: 'pending' }), batch)).toBe(false);
      expect(assetQueryNeedsRefresh(query(['thumbnail', 'history', 'h1', 3, 'c'], { data: { status: 'unavailable' } }), batch)).toBe(true);
      expect(assetQueryNeedsRefresh(query(['thumbnail', 'history', 'h1', 3, 'c'], { status: 'error' }), batch)).toBe(true);
    }
  });

  it('never re-reads a revision-pinned detail; current detail and versions follow their (kind, id)', () => {
    for (const batch of Object.values(batches)) expect(assetQueryNeedsRefresh(query(['detail', 'history', 'h1', 3]), batch)).toBe(false);
    const expectations: Array<[keyof typeof batches, boolean, boolean]> = [
      // batch, same (kind,id), other id of the same kind
      ['history', true, false], ['historyAndTagKinds', true, false], ['historyKinds', true, true], ['note', false, false], ['reference', false, false], ['empty', false, false], ['unknown', true, true],
    ];
    for (const [name, same, other] of expectations) {
      expect(assetQueryNeedsRefresh(query(['detail', 'history', 'h1', undefined]), batches[name]), `${name} detail`).toBe(same);
      expect(assetQueryNeedsRefresh(query(['detail', 'history', 'h2', undefined]), batches[name]), `${name} other detail`).toBe(other);
      expect(assetQueryNeedsRefresh(query(['versions', 'history', 'h1']), batches[name]), `${name} versions`).toBe(same);
      expect(assetQueryNeedsRefresh(query(['versions', 'history', 'h2']), batches[name]), `${name} other versions`).toBe(other);
    }
    // A revision of 0 reads the current item, like the browser's own request.
    expect(assetQueryNeedsRefresh(query(['detail', 'history', 'h1', 0]), batches.history)).toBe(true);
  });

  it('re-reads catalog, collections and other lists on any change; reference presets only for their kind', () => {
    for (const batch of Object.values(batches)) {
      for (const parts of [['catalog', { offset: 0 }], ['collections'], ['history-tag-suggestions', 'a'], ['studies', 'list', {}], ['favorites', {}]]) expect(assetQueryNeedsRefresh(query(parts), batch)).toBe(true);
    }
    expect(Object.entries(batches).filter(([, batch]) => assetQueryNeedsRefresh(query(['reference-presets']), batch)).map(([name]) => name)).toEqual(['reference', 'unknown']);
  });

  it('applies the scope to live queries; the user refresh still re-reads everything', async () => {
    const reads: Record<string, { mock: { calls: unknown[] } }> = {};
    const observe = (name: string, parts: unknown[], result: unknown) => {
      const read = vi.fn(async () => result);
      reads[name] = read;
      return new QueryObserver(assetQueryClient, { queryKey: assetQueryKey(api, ...parts), queryFn: read }).subscribe(() => undefined);
    };
    const stops = [
      observe('catalog', ['catalog', {}], { items: [] }), observe('thumb', ['thumbnail', 'history', 'h1', 1, 'c'], { status: 'ready', dataUrl: 'data:' }),
      observe('missing', ['thumbnail', 'history', 'h2', 1, 'c'], { status: 'unavailable' }), observe('pinned', ['detail', 'history', 'h1', 1], { item: {} }),
      observe('current', ['detail', 'history', 'h1', undefined], { item: {} }), observe('other', ['detail', 'note', 'n1', undefined], { item: {} }),
    ];
    await waitUntil(() => Object.values(reads).forEach(read => expect(read).toHaveBeenCalledTimes(1)));
    await invalidateAssetQueriesForChange(batches.history);
    expect(Object.fromEntries(Object.entries(reads).map(([name, read]) => [name, read.mock.calls.length]))).toEqual({ catalog: 2, thumb: 1, missing: 2, pinned: 1, current: 2, other: 1 });
    await invalidateAssetQueries();
    expect(Object.fromEntries(Object.entries(reads).map(([name, read]) => [name, read.mock.calls.length]))).toEqual({ catalog: 3, thumb: 2, missing: 3, pinned: 2, current: 3, other: 2 });
    stops.forEach(stop => stop());
  });
});
