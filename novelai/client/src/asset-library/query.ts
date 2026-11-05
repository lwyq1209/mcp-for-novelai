import { QueryClient, useQuery, type Query, type QueryKey, type UseQueryOptions, type UseQueryResult } from '@tanstack/react-query';
import { createLibraryChangeCoalescer, libraryChangeAffects, libraryChangeAffectsKinds, type LibraryChangeBatch, type LibraryChangeCoalescer } from './library-changes';

/** Local IPC works without network connectivity. Unknown mutations are never retried. */
export const assetQueryClient = new QueryClient({
  defaultOptions: {
    queries: { networkMode: 'always', retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false, staleTime: Infinity, gcTime: 5 * 60_000 },
    mutations: { networkMode: 'always', retry: false },
  },
});

const serviceIds = new WeakMap<object, number>();
let nextServiceId = 1;
export function assetQueryKey(service: object, ...parts: unknown[]) {
  if (!serviceIds.has(service)) serviceIds.set(service, nextServiceId++);
  return ['asset-library', serviceIds.get(service), ...parts] as const;
}

export function useLocalAssetQuery<T>(queryKey: QueryKey, queryFn: () => Promise<T>, enabled = true, initialData?: T): UseQueryResult<T, Error> {
  const options: UseQueryOptions<T, Error, T> = { queryKey, queryFn, enabled, placeholderData: initialData as UseQueryOptions<T, Error, T>['placeholderData'] };
  return useQuery<T, Error, T>(options, assetQueryClient);
}

export function readAssetQuery<T>(queryKey: QueryKey, queryFn: () => Promise<T>, fresh = false) {
  return assetQueryClient.fetchQuery({ queryKey, queryFn, ...(fresh ? { staleTime: 0 } : {}) });
}

export async function invalidateAssetQueries() {
  // IPC cannot always be interrupted, but Query can discard its late response.
  // A host change always starts a fresh read, including during the first load.
  await assetQueryClient.cancelQueries({ queryKey: ['asset-library'] });
  await assetQueryClient.invalidateQueries({ queryKey: ['asset-library'] });
}

/**
 * Which cached reads a host change batch can make stale (2026-11-01).
 * - thumbnail keys pin kind/id/revision/cacheKey: a ready image never changes;
 *   only failed or unavailable ones retry, keeping their old self-healing.
 * - detail with a revision is an immutable version; current detail and
 *   versions re-read when their item may have changed.
 * - reference presets depend only on reference_preset items and their groups.
 * - catalog, collections and every other list re-read on any change (bounded pages).
 *
 * Constraint (review P3-3): the host announces file-operation writes as
 * "no item changed" (changedKinds: [], ids: []). That is safe only because no
 * selective query reads that data, and every list query (the default branch
 * below) re-reads on any change, including an empty one. Whoever adds a
 * selective query key (or read model) that reads file-operation data must
 * first give those writes a kind in the repository change tracking.
 */
export function assetQueryNeedsRefresh(query: Pick<Query, 'queryKey' | 'state'>, batch: LibraryChangeBatch): boolean {
  const [, , type, ...parts] = query.queryKey as readonly unknown[];
  switch (type) {
    case 'thumbnail': return query.state.status === 'error' || (query.state.data as { status?: unknown } | undefined)?.status === 'unavailable';
    case 'detail': { const [kind, id, revision] = parts; return !revision && libraryChangeAffects(batch, kind, id); }
    case 'versions': { const [kind, id] = parts; return libraryChangeAffects(batch, kind, id); }
    case 'reference-presets': return libraryChangeAffectsKinds(batch, ['reference_preset']);
    // Lists re-read on every batch, also an empty one; see the constraint above before adding a selective case.
    default: return true;
  }
}

/** Re-reads only what the batch can have changed; a superseded read is cancelled and its late response discarded. */
export async function invalidateAssetQueriesForChange(batch: LibraryChangeBatch) {
  const filters = { queryKey: ['asset-library'] as const, predicate: (query: Query) => assetQueryNeedsRefresh(query, batch) };
  await assetQueryClient.cancelQueries(filters);
  await assetQueryClient.invalidateQueries(filters);
}

type AssetLibraryChangeSource = { onAssetLibraryChange?: (listener: (event: unknown) => void) => (() => void) };
type ChangeHub = { coalescer: LibraryChangeCoalescer; handlers: Set<{ handle: (batch: LibraryChangeBatch) => unknown }>; unsubscribe: () => void };
const changeHubs = new WeakMap<object, ChangeHub>();
/**
 * One host listener and one shared coalescing scheduler per desktop API.
 * Every consumer (query invalidation, history, settings, favorites) receives
 * the same batches; the last consumer to leave releases the host listener.
 */
export function subscribeAssetLibraryChanges(api: AssetLibraryChangeSource, handle: (batch: LibraryChangeBatch) => unknown): () => void {
  let hub = changeHubs.get(api);
  if (!hub) {
    const handlers: ChangeHub['handlers'] = new Set();
    const coalescer = createLibraryChangeCoalescer(batch => {
      for (const handler of [...handlers]) {
        try { const result = handler.handle(batch) as { catch?: (reject: () => void) => unknown } | undefined; if (result && typeof result.catch === 'function') result.catch(() => undefined); }
        catch { /* One consumer's failure must not starve the others. */ }
      }
    });
    hub = { coalescer, handlers, unsubscribe: () => undefined };
    changeHubs.set(api, hub);
    hub.unsubscribe = api.onAssetLibraryChange?.(event => coalescer.push(event)) ?? (() => undefined);
  }
  const entry = { handle }, current = hub;
  current.handlers.add(entry);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    current.handlers.delete(entry);
    if (!current.handlers.size) { current.coalescer.dispose(); current.unsubscribe(); if (changeHubs.get(api) === current) changeHubs.delete(api); }
  };
}

/** Invalidation refreshes server snapshots; editors own their drafts separately. */
const changeSubscriptions = new WeakMap<object, { count: number; unsubscribe: () => void }>();
export function watchAssetLibraryChanges(api: AssetLibraryChangeSource) {
  let subscription = changeSubscriptions.get(api);
  if (!subscription) {
    subscription = { count: 0, unsubscribe: subscribeAssetLibraryChanges(api, batch => invalidateAssetQueriesForChange(batch)) };
    changeSubscriptions.set(api, subscription);
  }
  subscription.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--subscription!.count === 0) { subscription!.unsubscribe(); changeSubscriptions.delete(api); }
  };
}

