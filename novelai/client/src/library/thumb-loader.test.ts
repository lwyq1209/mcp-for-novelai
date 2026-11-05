import { describe, expect, it } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { boundThumbnailCache, scheduleThumbnail, THUMB_PARALLEL, thumbnailQueue } from './thumb-loader';

/** oss/lib-1103: thumbnails of a virtual grid are read in turn and kept only for a bounded number of tiles. */
describe('thumbnail reads', () => {
  it('sends at most THUMB_PARALLEL at once, the newest asked first, and drops one whose tile left before it was sent', async () => {
    const started: number[] = [], release: Array<() => void> = [];
    const work = (id: number) => () => { started.push(id); return new Promise<number>(resolve => release.push(() => resolve(id))); };
    const controllers = Array.from({ length: 10 }, () => new AbortController());
    const results = controllers.map((controller, id) => scheduleThumbnail(work(id), controller.signal).catch(error => error.name));
    expect(started).toEqual([0, 1, 2, 3].slice(0, THUMB_PARALLEL));
    expect(thumbnailQueue()).toEqual({ waiting: 10 - THUMB_PARALLEL, running: THUMB_PARALLEL });
    controllers[8].abort(); // a tile scrolled past before its read was sent
    release.shift()!();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(started.at(-1)).toBe(9); // the newest first
    while (release.length) { release.shift()!(); await new Promise(resolve => setTimeout(resolve, 0)); }
    expect(await results[8]).toBe('AbortError');
    expect(started).not.toContain(8);
    expect(await results[5]).toBe(5);
    expect(thumbnailQueue()).toEqual({ waiting: 0, running: 0 });
  });

  it('keeps at most `kept` thumbnails no tile shows, the least recently shown dropped first; shown ones always stay', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, staleTime: Infinity, retry: false } } });
    boundThumbnailCache(client, 5);
    const key = (index: number) => ['asset-library', 1, 'thumbnail', 'history', `h${index}`, 1, 'c'];
    const observers = Array.from({ length: 12 }, (_, index) => new QueryObserver(client, { queryKey: key(index), queryFn: async () => ({ status: 'ready', dataUrl: `data:${index}` }) }));
    const unsubscribe = observers.map(observer => observer.subscribe(() => undefined));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(client.getQueryCache().findAll({ queryKey: ['asset-library', 1, 'thumbnail'] })).toHaveLength(12);
    // The first 10 tiles scroll away; 2 stay shown.
    for (let index = 0; index < 10; index++) unsubscribe[index]();
    await new Promise(resolve => setTimeout(resolve, 10));
    const left = client.getQueryCache().findAll({ queryKey: ['asset-library', 1, 'thumbnail'] }).map(query => query.queryKey[4]);
    expect(left.sort()).toEqual(['h10', 'h11', 'h5', 'h6', 'h7', 'h8', 'h9']);
    // Another cache entry kind is never touched.
    client.setQueryData(['asset-library', 1, 'detail', 'history', 'h1'], { item: {} });
    expect(client.getQueryData(['asset-library', 1, 'detail', 'history', 'h1'])).toBeTruthy();
    unsubscribe[10](); unsubscribe[11](); client.clear();
  });
});
