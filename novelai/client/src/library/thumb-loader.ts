import type { Query, QueryClient } from '@tanstack/react-query';

/**
 * Thumbnail reads of the library grid (oss/lib-1103). With a virtual grid tiles mount and unmount as they pass, so:
 * - at most THUMB_PARALLEL reads are sent at once, the most recently asked first (the tiles in view now, not the ones
 *   scrolled past); a read whose tile left before it was sent is dropped (its query was cancelled);
 * - thumbnails no tile shows are kept for at most THUMB_KEPT tiles, the least recently shown dropped first, so the
 *   window's memory does not grow with the distance scrolled (a dropped one is read again when its tile returns).
 */
export const THUMB_PARALLEL = 4;
export const THUMB_KEPT = 400;

type Task = { work: () => Promise<unknown>; resolve(value: unknown): void; reject(reason: unknown): void; signal?: AbortSignal };
const waiting: Task[] = [];
let running = 0;
const aborted = () => Object.assign(new Error('The thumbnail is no longer shown.'), { name: 'AbortError' });
function pump() {
  while (running < THUMB_PARALLEL && waiting.length) {
    const task = waiting.pop()!;
    if (task.signal?.aborted) { task.reject(aborted()); continue; }
    running++;
    task.work().then(task.resolve, task.reject).finally(() => { running--; pump(); });
  }
}
/** Runs one thumbnail read in turn (newest first); rejects without sending it when the signal aborts first. */
export function scheduleThumbnail<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) { reject(aborted()); return; }
    const task: Task = { work, resolve: resolve as (value: unknown) => void, reject, signal };
    signal?.addEventListener('abort', () => { const index = waiting.indexOf(task); if (index >= 0) { waiting.splice(index, 1); reject(aborted()); } }, { once: true });
    waiting.push(task);
    pump();
  });
}
export const thumbnailQueue = () => ({ waiting: waiting.length, running });

const installed = new WeakSet<QueryClient>();
/** Keeps at most `kept` thumbnail queries that no tile shows (asset-library query keys with the 'thumbnail' part). */
export function boundThumbnailCache(client: QueryClient, kept = THUMB_KEPT) {
  if (installed.has(client)) return;
  installed.add(client);
  const cache = client.getQueryCache(), idle = new Map<string, Query>();
  let trimming = false;
  const trim = () => {
    trimming = false;
    while (idle.size > kept) {
      const [hash, query] = idle.entries().next().value!;
      idle.delete(hash);
      if (!query.getObserversCount() && query.state.fetchStatus !== 'fetching') cache.remove(query);
    }
  };
  cache.subscribe(event => {
    const query = event.query as Query | undefined;
    if (!query || (query.queryKey as readonly unknown[])[2] !== 'thumbnail') return;
    if (event.type === 'removed') { idle.delete(query.queryHash); return; }
    if (event.type !== 'observerAdded' && event.type !== 'observerRemoved' && event.type !== 'added') return;
    idle.delete(query.queryHash);
    if (!query.getObserversCount()) idle.set(query.queryHash, query);
    if (idle.size > kept && !trimming) { trimming = true; queueMicrotask(trim); }
  });
}
