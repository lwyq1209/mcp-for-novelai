import fs from 'node:fs/promises';
import path from 'node:path';
import { describeAssetPreview } from './asset-library-preview';
import type { LibraryRepository } from './library/repository';
import type { LibraryItem, LibraryKind, LibraryListFact, ListFilters } from './library/types';
import type { LibraryTrash } from './library-trash';
import { factsMatch, imageFilterActive, localDayKey, modelOfFacts, sourceOfFacts, type BatchFacts, type GenerationMode, type ImageFacts, type ImageFilterArgs } from '../src/library/image-facts';

/**
 * The library page's own reads (oss/lib-1103). Only the window's IPC (main.ts novelai:assets, context window) reaches
 * them: bridge calls and so MCP never do, and their output is not bound by the MCP receipt budget. Nothing here writes.
 *
 * - ui-list: one view of the library, filtered in the host (mode, model, created range, source: the functions of
 *   src/library/image-facts.ts on facts read with SQL, so the result matches what a tile shows; archived none / with /
 *   only), with exact totals and pages of up to 500. The complete order of a view is kept per library revision, so the
 *   next pages (and the re-read of every loaded page after a change) cost one page each. With summary: the day counts of
 *   the result, and the models, agents and months of the view (the filter choices). History items come compact: the
 *   fields the grid reads; the drawer reads the whole record (ui-read). historyTags / historyTagMatch (step 4c1): only
 *   history images with those prompt tags (all or any; the history-tags-v1 index).
 * - ui-read: the read action, plus the size of each image file whose record has none (lstat of a regular file; the
 *   record is not changed). Its item carries its preview (the same image and cache key ui-list gives it; the read's own
 *   since the 4c1 review rework), so a tile that only knows an id (the queue page's finished images) reads its thumbnail.
 * - ui-archived: every archived item (kind, id, revision, name): the complete list 清空已归档 previews and deletes.
 * - ui-trash-totals: how many entries Recently Deleted holds and how large its files are, in all.
 */
export const WINDOW_LIBRARY_ACTIONS: readonly string[] = ['ui-list', 'ui-read', 'ui-archived', 'ui-trash-totals'];

/** Payload fields a history tile, the selection and the filters read (src/library: ImageGrid, model.ts, api.ts). */
const HISTORY_TILE_FIELDS = ['id', 'filePath', 'date', 'createdAt', 'width', 'height', 'model', 'groupId', 'generationOrigin', 'queueOrigin', 'feature'] as const;
/** A history item as the grid needs it: its identity and the tile fields; params only the model and the upscale marker. */
export function compactHistoryItem(item: LibraryItem): LibraryItem {
  const payload = item.payload ?? {}, compact: Record<string, unknown> = {};
  for (const field of HISTORY_TILE_FIELDS) if (payload[field] !== undefined) compact[field] = payload[field];
  const params = payload.params && typeof payload.params === 'object' ? payload.params : null;
  if (params) compact.params = { ...(params.model !== undefined ? { model: params.model } : {}), ...(params.positivePrompt === 'upscale' ? { positivePrompt: 'upscale' } : {}) };
  return { ...item, payload: compact as LibraryItem['payload'] };
}

/** The facts image-facts.ts reads, from one listFacts row (the SQL reading of the same payload fields). */
export function factsOfRow(row: LibraryListFact): ImageFacts {
  return {
    kind: row.kind, hasOrigin: row.hasOrigin, originMode: row.originMode ?? undefined, batchId: row.batchId ?? undefined,
    model: row.model ?? undefined, shownModel: row.model ?? row.paramsModel ?? undefined, upscalePrompt: row.upscalePrompt,
    createdAt: row.createdAt,
  };
}

type Count<T extends string> = Array<{ [key in T]: string } & { count: number }>;
const counted = <T extends string>(values: Map<string, number>, key: T, order: 'count' | 'key-desc' | 'seen' = 'count'): Count<T> => {
  const entries = [...values.entries()];
  if (order === 'count') entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  else if (order === 'key-desc') entries.sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
  return entries.map(([value, count]) => ({ [key]: value, count }) as { [k in T]: string } & { count: number });
};
const bump = (values: Map<string, number>, key: string) => values.set(key, (values.get(key) ?? 0) + 1);

export interface LibraryWindowOptions {
  repository: LibraryRepository;
  /** The shared read action of asset_library (its detail answer). */
  read(kind: LibraryKind, id: string): Promise<any>;
  /** A collection id of collections ("user:…", "history:…") as namespace and raw id; throws library_not_found. */
  collection(collectionId: string): { namespace: string; id: string };
  trash?: LibraryTrash;
  /** The queue's batches (agent names, modes of manual batches of this run), for the mode and source filters. */
  batchFacts?: () => BatchFacts;
}

export function createLibraryWindow(options: LibraryWindowOptions) {
  const repo = options.repository;
  // The complete order and facts of the last few views, each valid for the library revision it was read at.
  const views = new Map<string, { revision: number; rows: LibraryListFact[]; facts: ImageFacts[] }>();
  const VIEWS_KEPT = 6;
  function view(filters: ListFilters) {
    const key = JSON.stringify(filters), revision = repo.getRevision(), held = views.get(key);
    if (held && held.revision === revision) { views.delete(key); views.set(key, held); return held; }
    const rows = repo.listFacts(filters), value = { revision, rows, facts: rows.map(factsOfRow) };
    views.delete(key); views.set(key, value);
    while (views.size > VIEWS_KEPT) views.delete(views.keys().next().value!);
    return value;
  }

  function list(args: Record<string, any>) {
    const selected = args.collectionId ? options.collection(args.collectionId) : null;
    const filters: ListFilters = {
      kinds: args.kinds, query: args.query, sortBy: args.sortBy, sortDirection: args.sortDirection,
      ...(args.archived === 'only' ? { archivedOnly: true } : { includeArchived: args.archived === 'include' }),
      ...(selected ? { collectionId: selected.id, collectionNamespace: selected.namespace } : {}),
      // Prompt tags of history images (step 4c1): the repository's history_tags index, all or any of them.
      ...(Array.isArray(args.historyTags) && args.historyTags.length ? { historyTags: args.historyTags, historyTagMatch: args.historyTagMatch === 'any' ? 'any' : 'all' } : {}),
    };
    const offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 100);
    const image: ImageFilterArgs = {
      ...(args.mode ? { mode: args.mode as GenerationMode } : {}), ...(args.model ? { model: String(args.model) } : {}), ...(args.source ? { source: String(args.source) } : {}),
      ...(args.createdFrom !== undefined ? { createdFrom: Number(args.createdFrom) } : {}), ...(args.createdBefore !== undefined ? { createdBefore: Number(args.createdBefore) } : {}),
    };
    const filtering = imageFilterActive(image), current = view(filters);
    const batches: BatchFacts = filtering || args.summary ? options.batchFacts?.() ?? new Map() : new Map();
    const order = filtering ? current.facts.flatMap((facts, index) => factsMatch(facts, image, batches) ? [index] : []) : null;
    const total = order ? order.length : current.rows.length;
    const page = order ? order.slice(offset, offset + limit).map(index => current.rows[index]) : current.rows.slice(offset, offset + limit);
    const records = repo.getMany(page), previews = repo.previewAssets(records);
    const items = records.map(item => {
      const preview = previews.get(JSON.stringify([item.kind, item.id]));
      const shown = item.kind === 'history' ? compactHistoryItem(item) : item.kind === 'study' ? { ...item, payload: { ...item.payload, sections: undefined } } : item;
      return { ...shown, ...(preview ? { preview: describeAssetPreview(item, preview) } : {}) };
    });
    const result: Record<string, unknown> = { items, total, offset, limit, hasMore: offset + items.length < total, revision: current.revision };
    if (args.summary) {
      // Days of the result (their order in the list), and the choices of the view before its own image filters.
      const days = new Map<string, number>(), models = new Map<string, number>(), agents = new Map<string, number>(), months = new Map<string, number>();
      for (const index of order ?? current.facts.keys()) { const facts = current.facts[index]; if (facts.kind === 'history' || facts.kind === 'study') bump(days, localDayKey(facts.createdAt)); }
      for (const facts of current.facts) {
        if (facts.kind !== 'history' && facts.kind !== 'study') continue;
        const model = modelOfFacts(facts); if (model) bump(models, model);
        const source = sourceOfFacts(facts, batches); if (source.kind === 'agent' && source.label !== 'Agent') bump(agents, source.label);
        const day = localDayKey(facts.createdAt); if (day !== 'unknown') bump(months, day.slice(0, 7));
      }
      result.summary = { days: counted(days, 'day', 'seen'), models: counted(models, 'model'), agents: counted(agents, 'label'), months: counted(months, 'month', 'key-desc') };
    }
    return result;
  }

  async function sizeOf(file: unknown): Promise<number | null> {
    if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
    try { const stat = await fs.lstat(file); return stat.isFile() ? stat.size : null; } catch { return null; }
  }

  async function read(args: Record<string, any>) {
    const detail = await options.read(args.kind, args.id);
    const assets = await Promise.all((detail.assets ?? []).map(async (asset: Record<string, any>) => {
      if (Number.isSafeInteger(asset.byteLength) && asset.byteLength >= 0) return asset;
      const size = await sizeOf(asset.filePath);
      return size === null ? asset : { ...asset, byteLength: size, byteLengthFrom: 'file' };
    }));
    // The item's preview comes with the read itself (asset-library-service.ts: the current revision's, as ui-list gives it).
    return { ...detail, assets };
  }

  function archived(args: Record<string, any>) {
    const kinds: LibraryKind[] = args.kinds ?? [];
    const { items, total } = repo.archivedItems(kinds, Number.MAX_SAFE_INTEGER);
    return { items, total, revision: repo.getRevision() };
  }

  async function trashTotals() {
    const files = { moved: 0, kept: 0, missing: 0 }, bytes = { moved: 0, unknownSize: 0 };
    let entries = 0, collections = 0, offset = 0, total = 0;
    const revision = repo.getRevision();
    for (let round = 0; round < 10_000; round++) {
      const page = repo.listTrash({ offset, limit: 500 });
      total = page.total;
      for (const entry of page.entries) {
        entries++;
        if (entry.kind === 'collection') { collections++; continue; }
        const summary = entry.summary ?? {};
        files.moved += Number(summary.files?.moved) || 0; files.kept += Number(summary.files?.kept) || 0; files.missing += Number(summary.files?.missing) || 0;
        if (summary.bytes && Number.isFinite(summary.bytes.moved)) { bytes.moved += Number(summary.bytes.moved) || 0; bytes.unknownSize += Number(summary.bytes.unknownSize) || 0; continue; }
        // An entry from before the size field: the sizes of its moved files, as recorded, else as they are on disk.
        for (const file of repo.trashFiles(entry.trashId)) {
          if (file.state !== 'moved') continue;
          const size = Number.isSafeInteger(file.byteLength) ? file.byteLength : await sizeOf(file.trashPath);
          if (size === null) bytes.unknownSize++; else bytes.moved += size;
        }
      }
      if (!page.hasMore || !page.entries.length) break;
      offset += page.entries.length;
    }
    return { entries: Math.max(entries, total), collections, files, bytes, revision };
  }

  return async function windowAction(args: Record<string, any>): Promise<any> {
    switch (args.action) {
      case 'ui-list': return list(args);
      case 'ui-read': return read(args);
      case 'ui-archived': return archived(args);
      case 'ui-trash-totals': return trashTotals();
      default: throw Object.assign(new Error('Unknown library action.'), { code: 'invalid_argument' });
    }
  };
}
