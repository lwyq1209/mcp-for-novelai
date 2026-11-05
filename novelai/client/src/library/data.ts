import { useEffect, useMemo } from 'react';
import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import { assetQueryClient, assetQueryKey, useLocalAssetQuery, watchAssetLibraryChanges } from '../asset-library/query';
import type { AssetCollection, AssetDetail, AssetItem, AssetList } from '../asset-library/types';
import { TRASH_PAGE, type LibraryApi } from './api';
import { CATEGORY_KINDS, LIBRARY_CATEGORIES, LIST_PAGE, UI_LIST_PAGE, membershipIndex, projectCollections, userCollections, type LibraryCategory, type MembershipIndex } from './model';
import type { TrashEntry, TrashPage } from './impacts';

/**
 * Reads of the library page (step 4b1), all through the existing asset_library IPC and the shared query client:
 * every list key here re-reads on any host change batch (asset-library/query.ts, default branch), details re-read
 * when their item changed.
 */

/** Keeps the page's queries following host changes while it is mounted. */
export function useLibraryChanges(api: LibraryApi) {
  useEffect(() => watchAssetLibraryChanges(api), [api]);
}

export type CategoryCounts = Record<LibraryCategory, number> & { trash: number };
const ZERO_COUNTS: CategoryCounts = { history: 0, imports: 0, tags: 0, combos: 0, notes: 0, presets: 0, artists: 0, trash: 0 };
/** Totals of every sidebar section (one list of a single item each; the host counts). */
export function useCategoryCounts(api: LibraryApi, enabled = true) {
  const query = useLocalAssetQuery<CategoryCounts>(assetQueryKey(api, 'ui-counts'), async () => {
    const totals = await Promise.all(LIBRARY_CATEGORIES.map(category => api.assetLibrary({ action: 'list', kinds: [...CATEGORY_KINDS[category]], limit: 1 }).then((list: AssetList) => list.total)));
    const trash = await api.assetLibrary({ action: 'recently-deleted', limit: 1 }).then((page: TrashPage) => page.total).catch(() => 0);
    return { ...Object.fromEntries(LIBRARY_CATEGORIES.map((category, index) => [category, totals[index]])), trash } as CategoryCounts;
  }, enabled, ZERO_COUNTS);
  return query.data ?? ZERO_COUNTS;
}

export interface CollectionsState { collections: AssetCollection[]; revision: number }
/** User collections and projects (history groups), with their member counts. */
export function useCollections(api: LibraryApi, enabled = true) {
  const query = useLocalAssetQuery<CollectionsState>(assetQueryKey(api, 'collections'), () => api.assetLibrary({ action: 'collections' }), enabled);
  const all = query.data?.collections ?? [];
  // The host's order (creation order), as the user made them.
  const user = useMemo(() => userCollections(all), [all]);
  const projects = useMemo(() => projectCollections(all), [all]);
  const ids = [...user, ...projects].map(item => item.id);
  const counts = useLocalAssetQuery<Record<string, number>>(assetQueryKey(api, 'ui-collection-counts', ids), async () => {
    const values = await Promise.all(ids.map(id => api.assetLibrary({ action: 'list', collectionId: id, ...(id.startsWith('history:') ? { kinds: ['history'] } : {}), limit: 1 }).then((list: AssetList) => list.total).catch(() => 0)));
    return Object.fromEntries(ids.map((id, index) => [id, values[index]]));
  }, enabled && ids.length > 0, {});
  return { user, projects, counts: counts.data ?? {}, loaded: query.isSuccess, error: query.error, revision: query.data?.revision ?? 0 };
}

/** Members read per collection for the star on a tile (pages of 100, the list contract's maximum). */
export const MEMBERS_LIMIT = 500;
/** The image members of one collection, page by page up to MEMBERS_LIMIT. */
export async function collectionImageMembers(api: LibraryApi, collectionId: string): Promise<AssetItem[]> {
  const items: AssetItem[] = [];
  for (let offset = 0; offset < MEMBERS_LIMIT;) {
    const list = await api.assetLibrary({ action: 'list', collectionId, kinds: ['history', 'study'], includeArchived: true, offset, limit: LIST_PAGE }) as AssetList;
    items.push(...list.items);
    if (!list.hasMore || !list.items.length) break;
    offset += list.items.length;
  }
  return items;
}
/** Which images are in which user collections (for the star on a tile). */
export function useMembershipIndex(api: LibraryApi, collections: readonly AssetCollection[], enabled = true): MembershipIndex {
  const ids = collections.map(item => item.id);
  const query = useLocalAssetQuery<MembershipIndex>(assetQueryKey(api, 'ui-memberships', ids), async () => {
    const members = await Promise.all(ids.map(id => collectionImageMembers(api, id).then(items => ({ collectionId: id, items })).catch(() => ({ collectionId: id, items: [] as AssetItem[] }))));
    return membershipIndex(members);
  }, enabled && ids.length > 0, new Map());
  return query.data ?? new Map();
}

/** The host's summary of a list (ui-list summary): day counts of the result, and the filter choices of the view. */
export interface ListSummary {
  /** Local day ("2026-11-03" or "unknown") → images that day in the result. */
  days: ReadonlyMap<string, number>;
  /** Models and agents of the view's images, most frequent first; months ("2026-10") newest first, with counts. */
  models: string[];
  agents: string[];
  months: Array<{ month: string; count: number }>;
}
export interface ItemsState {
  items: AssetItem[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: Error | null;
  /** From the first page (ui-list summary), when the request asked for it. */
  summary: ListSummary | null;
  loadMore: () => void;
  refetch: () => void;
}
type ListPage = AssetList & { summary?: { days?: Array<{ day: string; count: number }>; models?: Array<{ model: string; count: number }>; agents?: Array<{ label: string; count: number }>; months?: Array<{ month: string; count: number }> } };
/**
 * The query of one list request, page by page (exported for tests): the window's ui-list (oss/lib-1103), UI_LIST_PAGE
 * items a page; the first page also asks for the summary when the request has summary. enabled is off while the page
 * is hidden (review rework): a host change then only marks the pages stale, and they are read again once when the page
 * shows.
 */
export function libraryListOptions(api: LibraryApi, request: Record<string, unknown> | null, enabled = true) {
  const { summary, ...base } = request ?? {};
  return {
    queryKey: assetQueryKey(api, 'ui-list', request),
    queryFn: ({ pageParam }: { pageParam: number }) => api.assetLibrary({ ...base, offset: pageParam, limit: UI_LIST_PAGE, ...(summary && pageParam === 0 ? { summary: true } : {}) }) as Promise<ListPage>,
    initialPageParam: 0,
    getNextPageParam: (last: ListPage) => last.hasMore ? last.offset + last.items.length : undefined,
    enabled: request !== null && enabled,
  };
}
function summaryOf(page: ListPage | undefined): ListSummary | null {
  const value = page?.summary;
  if (!value) return null;
  return {
    days: new Map((value.days ?? []).map(entry => [entry.day, entry.count])),
    models: (value.models ?? []).map(entry => entry.model), agents: (value.agents ?? []).map(entry => entry.label), months: value.months ?? [],
  };
}
/** The pages of one list request, newest first; more pages load on request (scrolling near the end, the drawer's →). */
export function useLibraryItems(api: LibraryApi, request: Record<string, unknown> | null, enabled = true): ItemsState {
  const query = useInfiniteQuery<ListPage, Error, InfiniteData<ListPage, number>, readonly unknown[], number>(libraryListOptions(api, request, enabled), assetQueryClient);
  const pages = query.data?.pages ?? [];
  const items = useMemo(() => {
    // A later page can repeat an item when the list changed between page reads; the first copy wins.
    const seen = new Set<string>(), out: AssetItem[] = [];
    for (const page of pages) for (const item of page.items) { const key = `${item.kind}:${item.id}`; if (!seen.has(key)) { seen.add(key); out.push(item); } }
    return out;
  }, [pages]);
  const summary = useMemo(() => summaryOf(pages[0]), [pages[0]]);
  return {
    items, total: pages.at(-1)?.total ?? pages[0]?.total ?? 0, hasMore: !!query.hasNextPage, summary,
    loading: query.isPending && request !== null, loadingMore: query.isFetchingNextPage, error: query.error ?? null,
    loadMore: () => { if (enabled && query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage(); },
    refetch: () => { void query.refetch(); },
  };
}

/**
 * The current saved state of one item (the window's ui-read: the read action, with the file size of images whose record
 * has none): item, its image assets, links and collection memberships.
 */
export function useItemDetail(api: LibraryApi, target: { kind: AssetItem['kind']; id: string } | null, enabled = true) {
  return useLocalAssetQuery<AssetDetail & { memberships?: Array<{ namespace: string; collectionId: string }> }>(
    assetQueryKey(api, 'detail', target?.kind, target?.id, undefined),
    () => api.assetLibrary({ action: 'ui-read', kind: target!.kind, id: target!.id }),
    !!target && enabled,
  );
}

/** Recently deleted in all (the window's ui-trash-totals): entries, files and their size. */
export interface TrashTotals { entries: number; collections: number; files: { moved: number; kept: number; missing: number }; bytes: { moved: number; unknownSize: number } }
export function useTrashTotals(api: LibraryApi, enabled = true) {
  return useLocalAssetQuery<TrashTotals>(assetQueryKey(api, 'ui-trash-totals'), () => api.assetLibrary({ action: 'ui-trash-totals' }), enabled).data ?? null;
}

export interface TrashState { entries: TrashEntry[]; total: number; hasMore: boolean; loading: boolean; loadingMore: boolean; error: Error | null; loadMore(): void }
/** Recently deleted, 100 entries per page (the host's maximum) with 加载更多; the host keeps entries 30 days. */
export function useTrash(api: LibraryApi, enabled = true): TrashState {
  const query = useInfiniteQuery<TrashPage, Error, InfiniteData<TrashPage, number>, readonly unknown[], number>({
    queryKey: assetQueryKey(api, 'ui-trash'),
    queryFn: ({ pageParam }) => api.assetLibrary({ action: 'recently-deleted', offset: pageParam, limit: TRASH_PAGE }),
    initialPageParam: 0,
    getNextPageParam: last => last.hasMore ? (last.nextOffset ?? last.offset + last.entries.length) : undefined,
    enabled,
  }, assetQueryClient);
  const pages = query.data?.pages ?? [];
  const entries = useMemo(() => {
    const seen = new Set<string>(), out: TrashEntry[] = [];
    for (const page of pages) for (const entry of page.entries) if (!seen.has(entry.trashId)) { seen.add(entry.trashId); out.push(entry); }
    return out;
  }, [pages]);
  return {
    entries, total: pages.at(-1)?.total ?? 0, hasMore: !!query.hasNextPage, loading: query.isPending, loadingMore: query.isFetchingNextPage, error: query.error ?? null,
    loadMore: () => { if (enabled && query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage(); },
  };
}
