import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitUntil } from '../test-support/wait-until';
import { QueryObserver } from '@tanstack/react-query';
import { createLibraryChangeCoalescer, LIBRARY_CHANGE_DEBOUNCE_MS, LIBRARY_CHANGE_MAX_WAIT_MS, libraryChangeIds, mergeLibraryChanges, type LibraryChangeBatch } from './library-changes';
import { assetQueryClient, assetQueryKey, subscribeAssetLibraryChanges, watchAssetLibraryChanges } from './query';

afterEach(() => { vi.useRealTimers(); assetQueryClient.clear(); });
const plain = (batch: LibraryChangeBatch) => ({ unknown: batch.unknown, kinds: [...batch.kinds].sort(), ids: batch.ids && [...batch.ids].sort(), idless: [...batch.idlessKinds].sort(), revision: batch.revision, notifications: batch.notifications });

describe('library change coalescing', () => {
  it('flushes once, 150 ms after the last notification of a burst', () => {
    vi.useFakeTimers();
    const flushed: LibraryChangeBatch[] = [];
    const coalescer = createLibraryChangeCoalescer(batch => flushed.push(batch));
    for (let index = 0; index < 5; index++) { coalescer.push({ revision: index + 1, changedKinds: ['history'], ids: [`h${index}`] }); vi.advanceTimersByTime(100); }
    expect(flushed).toHaveLength(0);
    vi.advanceTimersByTime(LIBRARY_CHANGE_DEBOUNCE_MS - 100 - 1);
    expect(flushed).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(flushed.map(plain)).toEqual([{ unknown: false, kinds: ['history'], ids: ['h0', 'h1', 'h2', 'h3', 'h4'], idless: [], revision: 5, notifications: 5 }]);
  });

  it('still flushes at least once a second while writes never pause', () => {
    vi.useFakeTimers();
    const flushes: number[] = [], start = Date.now();
    const coalescer = createLibraryChangeCoalescer(() => flushes.push(Date.now() - start));
    for (let elapsed = 0; elapsed < 3500; elapsed += 100) { coalescer.push({ changedKinds: ['history'], ids: [String(elapsed)] }); vi.advanceTimersByTime(100); }
    vi.advanceTimersByTime(LIBRARY_CHANGE_DEBOUNCE_MS);
    expect(flushes).toEqual([LIBRARY_CHANGE_MAX_WAIT_MS, 2 * LIBRARY_CHANGE_MAX_WAIT_MS, 3 * LIBRARY_CHANGE_MAX_WAIT_MS, 3400 + LIBRARY_CHANGE_DEBOUNCE_MS]);
    for (let index = 1; index < flushes.length; index++) expect(flushes[index] - flushes[index - 1]).toBeLessThanOrEqual(LIBRARY_CHANGE_MAX_WAIT_MS + 100);
    // Nothing is dropped: the trailing writes flush after the stream stops.
    expect(flushes.at(-1)).toBeGreaterThanOrEqual(3400);
  });

  it('merges kinds and ids as unions; one unnamed notification makes the whole batch unknown', () => {
    expect(plain(mergeLibraryChanges([{ revision: 3, changedKinds: ['history'], ids: ['h1'] }, { revision: 2, changedKinds: ['note'], ids: ['n1', 'h1'] }, { changedKinds: [], ids: [] }])))
      .toEqual({ unknown: false, kinds: ['history', 'note'], ids: ['h1', 'n1'], idless: [], revision: 3, notifications: 3 });
    expect(plain(mergeLibraryChanges([{ changedKinds: ['history'], ids: ['h1'] }, { revision: 9 }, { changedKinds: ['note'], ids: ['n1'] }])))
      .toEqual({ unknown: true, kinds: [], ids: null, idless: [], revision: 9, notifications: 3 });
    // A notification without ids opens only the kinds it names; the others keep their named ids.
    const mixed = mergeLibraryChanges([{ changedKinds: ['history'], ids: ['h1'] }, { changedKinds: ['tag'] }]);
    expect(plain(mixed)).toMatchObject({ unknown: false, kinds: ['history', 'tag'], ids: ['h1'], idless: ['tag'] });
    expect([libraryChangeIds(mixed, 'history'), libraryChangeIds(mixed, 'tag'), libraryChangeIds(mixed, 'note')]).toEqual([['h1'], null, []]);
    expect(libraryChangeIds(mergeLibraryChanges([{ changedKinds: ['history'], ids: ['h1'] }, { changedKinds: ['history'] }]), 'history')).toBeNull();
    expect(plain(mergeLibraryChanges([{ changedKinds: [] }, { changedKinds: ['note'], ids: ['n'] }]))).toMatchObject({ kinds: ['note'], ids: ['n'] });
    expect(plain(mergeLibraryChanges([null, { changedKinds: 'history' }]))).toMatchObject({ unknown: true });
    expect(mergeLibraryChanges(Array.from({ length: 3 }, (_, page) => ({ changedKinds: ['history'], ids: Array.from({ length: 200 }, (_, index) => `h${page}-${index}`) }))).ids).toBeNull();
  });

  it('one host listener feeds query invalidation and other consumers the same batches', async () => {
    let listener: ((event: unknown) => void) | undefined;
    const unsubscribe = vi.fn(), api = { onAssetLibraryChange: vi.fn((callback: (event: unknown) => void) => { listener = callback; return unsubscribe; }) };
    const stopWatch = watchAssetLibraryChanges(api), batches: LibraryChangeBatch[] = [];
    const stopConsumer = subscribeAssetLibraryChanges(api, batch => { batches.push(batch); });
    const failing = subscribeAssetLibraryChanges(api, () => { throw new Error('consumer failed'); });
    expect(api.onAssetLibraryChange).toHaveBeenCalledOnce();
    const catalog = vi.fn(async () => ({ items: [], revision: catalog.mock.calls.length }));
    const observer = new QueryObserver(assetQueryClient, { queryKey: assetQueryKey(api, 'catalog', {}), queryFn: catalog });
    const stopObserver = observer.subscribe(() => undefined);
    await waitUntil(() => expect(catalog).toHaveBeenCalledTimes(1));
    listener!({ revision: 1, changedKinds: ['history'], ids: ['h1'] }); listener!({ revision: 2, changedKinds: [], ids: [] });
    await waitUntil(() => expect(catalog).toHaveBeenCalledTimes(2));
    expect(batches.map(plain)).toEqual([{ unknown: false, kinds: ['history'], ids: ['h1'], idless: [], revision: 2, notifications: 2 }]);
    stopObserver(); failing(); stopWatch(); expect(unsubscribe).not.toHaveBeenCalled();
    stopConsumer(); expect(unsubscribe).toHaveBeenCalledOnce();
    // Released: a late host event is ignored and a new subscriber gets a new listener.
    listener!({ revision: 3 }); await new Promise(resolve => setTimeout(resolve, LIBRARY_CHANGE_DEBOUNCE_MS + 50));
    expect(batches).toHaveLength(1);
    const again = subscribeAssetLibraryChanges(api, () => undefined); expect(api.onAssetLibraryChange).toHaveBeenCalledTimes(2); again();
  });

  it('a change batch supersedes a slow read and discards its late response', async () => {
    let listener: ((event: unknown) => void) | undefined;
    const api = { onAssetLibraryChange: (callback: (event: unknown) => void) => { listener = callback; return () => undefined; } };
    const stop = watchAssetLibraryChanges(api);
    let resolveOld!: (value: { revision: number }) => void;
    const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValue({ revision: 2 });
    const key = assetQueryKey(api, 'catalog', { offset: 0 }), observer = new QueryObserver(assetQueryClient, { queryKey: key, queryFn: read });
    const unsubscribe = observer.subscribe(() => undefined);
    await waitUntil(() => expect(read).toHaveBeenCalledTimes(1));
    listener!({ revision: 2, changedKinds: ['history'], ids: ['h9'] });
    await waitUntil(() => expect(assetQueryClient.getQueryData(key)).toEqual({ revision: 2 }));
    resolveOld({ revision: 1 }); await Promise.resolve(); await Promise.resolve();
    expect(assetQueryClient.getQueryData(key)).toEqual({ revision: 2 });
    expect(read).toHaveBeenCalledTimes(2);
    unsubscribe(); stop();
  });
});
