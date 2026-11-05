import type { AssetCollection, AssetItem, AssetKind } from '../asset-library/types';
import type { BatchJob } from '../workspace/batch-types';
import { formatDay, type UiLang } from '../ui/i18n';
import { batchFactOf, factsMatch, imageFacts, localDayKey, modelOfFacts, modeOfFacts, sourceOfFacts, type BatchFact, type GenerationMode, type ImageFilterArgs, type ImageSource } from './image-facts';

/**
 * The library page's view model (step 4b1): which section is open and what to ask the host for; since oss/lib-1103 the
 * host list applies the mode / model / date / source / archived filters and counts the days. Pure functions only.
 */
export type LibraryCategory = 'history' | 'imports' | 'tags' | 'combos' | 'notes' | 'presets' | 'artists';
export const LIBRARY_CATEGORIES: readonly LibraryCategory[] = ['history', 'imports', 'tags', 'combos', 'notes', 'presets', 'artists'];
export const CATEGORY_KINDS: Record<LibraryCategory, readonly AssetKind[]> = {
  history: ['history'], imports: ['study'], tags: ['tag'], combos: ['combo'], notes: ['note'],
  presets: ['style_preset', 'positive_preset', 'prompt_chunk', 'reference_preset'], artists: ['artist_favorite'],
};
export type PresetFilter = 'all' | 'style_preset' | 'positive_preset' | 'prompt_chunk' | 'reference_preset';
export const PRESET_FILTERS: readonly PresetFilter[] = ['all', 'style_preset', 'positive_preset', 'prompt_chunk', 'reference_preset'];

/** A user collection id is "user:<id>", a project (history group) id "history:<groupId>" (asset_library collections). */
export type LibraryView =
  | { type: 'category'; category: LibraryCategory }
  | { type: 'collection'; id: string }
  | { type: 'project'; id: string }
  | { type: 'trash' };
export const DEFAULT_VIEW: LibraryView = { type: 'category', category: 'history' };
export const viewKey = (view: LibraryView) => view.type === 'category' ? `category:${view.category}` : view.type === 'trash' ? 'trash' : `${view.type}:${view.id}`;
export const sameView = (a: LibraryView, b: LibraryView) => viewKey(a) === viewKey(b);

export const isImageKind = (kind: AssetKind) => kind === 'history' || kind === 'study';
/** Views whose items are images first (grid, image filters, day groups). */
export const isImageView = (view: LibraryView) => view.type === 'collection' || view.type === 'project' || (view.type === 'category' && (view.category === 'history' || view.category === 'imports'));
/** Views with the mode/model/date/source filters (generation history). */
export const hasImageFilters = (view: LibraryView) => view.type === 'project' || view.type === 'collection' || (view.type === 'category' && view.category === 'history');
export const isTrayView = (view: LibraryView) => view.type === 'category' && (view.category === 'tags' || view.category === 'combos');

export const collectionNamespace = (collection: Pick<AssetCollection, 'id' | 'namespace'>) => collection.namespace ?? collection.id.split(':')[0];
export const userCollections = (collections: readonly AssetCollection[]) => collections.filter(item => collectionNamespace(item) === 'user');
export const projectCollections = (collections: readonly AssetCollection[]) => collections.filter(item => collectionNamespace(item) === 'history');
/** The raw history group id of a project collection id ("history:<groupId>"). */
export const projectGroupId = (collectionId: string) => collectionId.startsWith('history:') ? collectionId.slice('history:'.length) : collectionId;

/** Items per page of the asset_library list (its desktop contract allows at most 100). */
export const LIST_PAGE = 100;
/** Items per page of the window's own list (ui-list allows up to 500; history items come compact). */
export const UI_LIST_PAGE = 200;
export interface ListOptions { query: string; archived: ArchivedFilter; presetFilter: PresetFilter; filters?: ImageFilterArgs }
/**
 * The host list request of one view (the window's ui-list: oss/lib-1103), without offset/limit. The image filters
 * (mode, model, date range, source) apply in the history, project and collection views only.
 */
export function listRequest(view: LibraryView, options: ListOptions): Record<string, unknown> {
  const base = { action: 'ui-list', query: options.query.trim(), archived: options.archived, ...(hasImageFilters(view) ? options.filters ?? {} : {}) };
  if (view.type === 'collection') return { ...base, collectionId: view.id, sortBy: 'createdAt', sortDirection: 'desc' };
  if (view.type === 'project') return { ...base, collectionId: view.id, kinds: ['history'], sortBy: 'createdAt', sortDirection: 'desc' };
  if (view.type === 'trash') throw new Error('Recently deleted is not a library list.');
  const kinds = view.category === 'presets' && options.presetFilter !== 'all' ? [options.presetFilter] : [...CATEGORY_KINDS[view.category]];
  const images = view.category === 'history' || view.category === 'imports';
  return { ...base, kinds, sortBy: images ? 'createdAt' : 'updatedAt', sortDirection: 'desc' };
}

// ── Image facts (image-facts.ts: the same functions the host's list filters use) ─────────────────────────
export type { GenerationMode, ImageSource } from './image-facts';
export { GENERATION_MODES } from './image-facts';

/** What the window knows of the queue batches (from the queue monitor): batch id → its source label and mode. */
export type BatchIndex = ReadonlyMap<string, BatchFact & { createdAt: string }>;
export function batchIndex(batches: readonly BatchJob[]): BatchIndex {
  return new Map(batches.map(batch => [batch.batchId, { ...batchFactOf(batch), createdAt: batch.createdAt }]));
}

/**
 * Where an image came from. Agent images carry a generationOrigin (and the queue item they ran for); manual images
 * from the canvas do not (step 4a). The agent's name comes from its batch when the queue still lists it.
 */
export function imageSource(item: Pick<AssetItem, 'kind' | 'payload'> & { createdAt?: string }, batches: BatchIndex = new Map()): ImageSource {
  return sourceOfFacts(imageFacts({ createdAt: '', ...item }), batches);
}

/** The generation mode of a history image: exact for agent images (and manual batches still listed), inferred for
 * the post tools from the saved model, null when the record does not tell. */
export function imageMode(item: Pick<AssetItem, 'kind' | 'payload'> & { createdAt?: string }, batches: BatchIndex = new Map()): GenerationMode | null {
  return modeOfFacts(imageFacts({ createdAt: '', ...item }), batches);
}

export const imageModel = (item: Pick<AssetItem, 'kind' | 'payload'> & { createdAt?: string }): string | null => modelOfFacts(imageFacts({ createdAt: '', ...item }));

/** When an image was made: the library's created_at (the list's sort order, its day group and the date filters). */
export const imageCreatedAt = (item: Pick<AssetItem, 'createdAt'>): string => item.createdAt;

/** Width / height of an image item (1 when unknown, so a tile still gets a square). */
export function imageAspect(item: Pick<AssetItem, 'kind' | 'payload' | 'preview'>): number {
  const width = Number(item.payload?.width ?? item.preview?.width), height = Number(item.payload?.height ?? item.preview?.height);
  if (!(width > 0) || !(height > 0)) return 1;
  return Math.min(4, Math.max(0.25, width / height));
}

// ── Filters (oss/lib-1103: applied by the host list, ui-list) ─────────────────────────────────────────────
/** A date filter: the last days (calendar days, local), or one calendar month ("month:2026-10"). */
export type DateFilter = '' | 'today' | '7d' | '30d' | `month:${string}`;
export const DATE_FILTERS: readonly Exclude<DateFilter, '' | `month:${string}`>[] = ['today', '7d', '30d'];
/** source: '' any, 'agent' any agent, 'manual', 'imported', or 'agent:<label>' one agent by its display name. */
export interface ImageFilters { mode: GenerationMode | ''; model: string; date: DateFilter; source: string }
export const NO_FILTERS: ImageFilters = { mode: '', model: '', date: '', source: '' };
export const filtersActive = (filters: ImageFilters) => !!(filters.mode || filters.model || filters.date || filters.source);
/** Which archived items a list shows: none (the default), with the others, or only them. */
export type ArchivedFilter = 'exclude' | 'include' | 'only';

/** The earliest moment a date filter keeps (local midnight based), or null. */
export function dateFloor(filter: DateFilter, now: Date = new Date()): number | null {
  return dateRange(filter, now).from ?? null;
}
/** The time range of a date filter: from (inclusive) and before (exclusive), epoch ms; local calendar days. */
export function dateRange(filter: DateFilter, now: Date = new Date()): { from?: number; before?: number } {
  if (!filter) return {};
  const month = /^month:(\d{4})-(\d{2})$/.exec(filter);
  if (month) {
    const year = Number(month[1]), index = Number(month[2]) - 1;
    return { from: new Date(year, index, 1).getTime(), before: new Date(year, index + 1, 1).getTime() };
  }
  // Calendar days, so a daylight-saving change in between does not move the floor by an hour.
  return { from: new Date(now.getFullYear(), now.getMonth(), now.getDate() - (filter === 'today' ? 0 : filter === '7d' ? 6 : 29)).getTime() };
}
/** The host list arguments of the filters (ui-list mode / model / source / createdFrom / createdBefore). */
export function filterArgs(filters: ImageFilters, now: Date = new Date()): ImageFilterArgs {
  const range = dateRange(filters.date, now);
  return {
    ...(filters.mode ? { mode: filters.mode } : {}), ...(filters.model ? { model: filters.model } : {}), ...(filters.source ? { source: filters.source } : {}),
    ...(range.from !== undefined ? { createdFrom: range.from } : {}), ...(range.before !== undefined ? { createdBefore: range.before } : {}),
  };
}
/** Whether one image matches the filters (the same test the host list applies, image-facts.ts). */
export function matchesFilters(item: AssetItem, filters: ImageFilters, batches: BatchIndex = new Map(), now: Date = new Date()): boolean {
  if (!filtersActive(filters)) return true;
  return factsMatch(imageFacts(item), filterArgs(filters, now), batches);
}

// ── Day groups ──────────────────────────────────────────────────────────────
/** day: the local day ("2026-11-03", or "unknown"); key: unique in the list (a day met again gets "#2", "#3"…). */
export interface DayGroup { key: string; day: string; label: string; items: AssetItem[]; /** The day is split over more than one group. */ split?: boolean }
/**
 * Consecutive items of the same local day (the list is newest first, by created_at), labelled 今天 / 昨天 / 11 月 1 日.
 * A day only comes back later in the list when created_at texts of mixed time zones sort apart; its next group then
 * gets its own key (never two groups with one key), and both are marked split (their headings count what they hold).
 */
export function dayGroups(items: readonly AssetItem[], lang: UiLang, now: Date = new Date()): DayGroup[] {
  const groups: DayGroup[] = [], seen = new Map<string, DayGroup[]>();
  for (const item of items) {
    const created = imageCreatedAt(item), day = localDayKey(created), last = groups.at(-1);
    if (last && last.day === day) { last.items.push(item); continue; }
    const before = seen.get(day) ?? [];
    const group: DayGroup = { key: before.length ? `${day}#${before.length + 1}` : day, day, label: day === 'unknown' ? '' : formatDay(created, lang, now), items: [item] };
    if (before.length) { group.split = true; for (const value of before) value.split = true; }
    seen.set(day, [...before, group]);
    groups.push(group);
  }
  return groups;
}

// ── Collection membership (the star on a tile) ──────────────────────────────
export type MembershipIndex = ReadonlyMap<string, readonly string[]>;
export const itemKey = (item: Pick<AssetItem, 'kind' | 'id'>) => `${item.kind}:${item.id}`;
/** item key → the user collections it belongs to, from each collection's member list. */
export function membershipIndex(members: ReadonlyArray<{ collectionId: string; items: ReadonlyArray<Pick<AssetItem, 'kind' | 'id'>> }>): MembershipIndex {
  const index = new Map<string, string[]>();
  for (const { collectionId, items } of members) for (const item of items) { const key = itemKey(item); index.set(key, [...(index.get(key) ?? []), collectionId]); }
  return index;
}

// ── Selection ───────────────────────────────────────────────────────────────
/** Shift-click range selection over the visible order: the keys between anchor and target (inclusive). */
export function rangeSelection(order: readonly string[], anchor: string | null, target: string): string[] {
  const end = order.indexOf(target);
  const start = anchor === null ? -1 : order.indexOf(anchor);
  if (end < 0) return [];
  if (start < 0) return [target];
  const [from, to] = start <= end ? [start, end] : [end, start];
  return order.slice(from, to + 1);
}

/** The item after (or before) the current one in the visible order, for the drawer's ← →. */
export function neighbour(order: readonly string[], current: string, delta: 1 | -1): string | null {
  const index = order.indexOf(current);
  if (index < 0) return null;
  return order[index + delta] ?? null;
}

/**
 * The selection with the current saved version of every selected item the list shows (review rework): an item that
 * changed since it was selected (moved to a project, renamed, archived, by the user or an agent) is kept with its new
 * revision; the same map comes back when nothing changed. Items the list does not show stay as they are.
 */
export function refreshSelection(selected: ReadonlyMap<string, AssetItem>, items: readonly AssetItem[]): ReadonlyMap<string, AssetItem> {
  if (!selected.size) return selected;
  let next: Map<string, AssetItem> | null = null;
  for (const item of items) {
    const key = itemKey(item), held = selected.get(key);
    if (held && held.revision !== item.revision) { next ??= new Map(selected); next.set(key, item); }
  }
  return next ?? selected;
}

/** Overlays that take the keyboard from the library page: its own dialogs and menus, the settings dialog and the first-run guide (old styles). */
export const SHORTCUT_BLOCKERS = '.ui-scrim, [role="menu"], dialog[open], .modal-backdrop, [role="dialog"][aria-modal="true"]';
export function shortcutsBlocked(doc: Pick<Document, 'querySelector'>) { return !!doc.querySelector(SHORTCUT_BLOCKERS); }
