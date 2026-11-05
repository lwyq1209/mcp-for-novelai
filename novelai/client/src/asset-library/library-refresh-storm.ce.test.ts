// Frozen counterexamples CE-1, CE-2 (renderer query layer) — library refresh storm, 2026-11-01.
// Install as novelai/client/src/asset-library/library-refresh-storm.ce.test.ts. Base: f30714b.
// Observed on the daily client: every library write notification invalidated every
// 'asset-library' query, including loaded thumbnails whose keys already pin revision+cacheKey,
// and each notification of a burst started its own re-read.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryObserver } from '@tanstack/react-query';
import { assetQueryClient, assetQueryKey, watchAssetLibraryChanges } from './query';
import { waitUntil } from '../test-support/wait-until';

afterEach(() => { assetQueryClient.clear(); });

function harness() {
  let listener: ((event: unknown) => void) | undefined;
  const api = { onAssetLibraryChange: vi.fn((callback: (event: unknown) => void) => { listener = callback; return () => { listener = undefined; }; }) };
  const stop = watchAssetLibraryChanges(api);
  const unsubscribers: Array<() => void> = [];
  return {
    api,
    emit(event: unknown) { if (!listener) throw new Error('no library listener installed'); listener(event); },
    observe(queryKey: readonly unknown[], queryFn: () => Promise<unknown>) {
      const observer = new QueryObserver(assetQueryClient, { queryKey, queryFn });
      unsubscribers.push(observer.subscribe(() => undefined));
    },
    dispose() { unsubscribers.splice(0).forEach(unsubscribe => unsubscribe()); stop(); },
  };
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('library refresh storm (frozen counterexamples)', () => {
  it('CE-1 a library change re-reads the catalog but not loaded thumbnails or revision-pinned details', async () => {
    const h = harness();
    const catalog = vi.fn(async () => ({ items: [], total: 0, offset: 0, limit: 30, hasMore: false, revision: catalog.mock.calls.length }));
    const thumbnail = vi.fn(async () => ({ status: 'ready', dataUrl: 'data:image/png;base64,AAAA' }));
    const pinnedDetail = vi.fn(async () => ({ item: { kind: 'history', id: 'h1', revision: 3 } }));
    h.observe(assetQueryKey(h.api, 'catalog', { action: 'list', query: '', offset: 0, limit: 30 }), catalog);
    h.observe(assetQueryKey(h.api, 'thumbnail', 'history', 'h1', 3, 'cache-h1-r3'), thumbnail);
    h.observe(assetQueryKey(h.api, 'detail', 'history', 'h1', 3), pinnedDetail);
    await waitUntil(() => { expect(catalog).toHaveBeenCalledTimes(1); expect(thumbnail).toHaveBeenCalledTimes(1); expect(pinnedDetail).toHaveBeenCalledTimes(1); });

    // A new image was saved (notification names what changed).
    h.emit({ revision: 2, changedKinds: ['history'], ids: ['h2'] });
    await waitUntil(() => expect(catalog).toHaveBeenCalledTimes(2));
    // A notification that names nothing (older host) is still a reason to re-read lists.
    h.emit({ revision: 3 });
    await waitUntil(() => expect(catalog).toHaveBeenCalledTimes(3));
    await wait(400);

    // Thumbnail keys pin kind/id/revision/cacheKey and a pinned detail pins its revision: their content cannot change.
    expect(thumbnail).toHaveBeenCalledTimes(1);
    expect(pinnedDetail).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  it('CE-2 a burst of notifications (one image = several writes) is re-read once or twice, ending after the last one', async () => {
    const h = harness();
    const callTimes: number[] = [];
    const catalog = vi.fn(async () => { callTimes.push(Date.now()); await wait(5); return { items: [], total: 0, offset: 0, limit: 30, hasMore: false, revision: 0 }; });
    h.observe(assetQueryKey(h.api, 'catalog', { action: 'list', query: '', offset: 0, limit: 30 }), catalog);
    await waitUntil(() => expect(catalog).toHaveBeenCalledTimes(1));

    let lastEmit = 0;
    for (let index = 0; index < 10; index++) {
      h.emit({ revision: 10 + index, changedKinds: ['history'], ids: [`h${index}`] });
      lastEmit = Date.now();
      await wait(20);
    }
    await wait(1500);

    const rereads = catalog.mock.calls.length - 1;
    expect(rereads).toBeGreaterThanOrEqual(1);
    expect(rereads).toBeLessThanOrEqual(2);
    // Coalescing must not drop the trailing change: the final read starts after the final notification.
    expect(callTimes.at(-1)!).toBeGreaterThanOrEqual(lastEmit);
    h.dispose();
  });
});
