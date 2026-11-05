import { readHostError } from '../host-errors/bridge';
import type { AssetItem, AssetLibraryApi } from '../asset-library/types';
import type { ImageExportRequest, ImageExportResult } from '../asset-library/image-export';
import type { HistoryGroup } from '../types';
import type { DeleteReceipt, ReceiptRow, TrashEntry, TrashPage } from './impacts';

/**
 * What the library page asks the host for (step 4b1): the library IPC of window.naiDesktop (since oss/lib-1103 also the
 * window's own ui-list, ui-read, ui-archived and ui-trash-totals of the same assetLibrary call).
 * A sample implementation (capture.ts) stands in for it in UI capture runs; tests pass the real host services.
 */
export interface LibraryApi extends AssetLibraryApi {
  exportAssetImages?: (request: ImageExportRequest) => Promise<ImageExportResult>;
  materialLibrary?: (args: Record<string, unknown>) => Promise<any>;
  materialSamples?: (args: Record<string, unknown>) => Promise<any>;
  materialTags?: (args: Record<string, unknown>) => Promise<any>;
  materialStudies?: (args: Record<string, unknown>) => Promise<any>;
  renameHistoryGroup?: (id: string, name: string) => Promise<HistoryGroup[]>;
  deleteHistoryGroup?: (id: string) => Promise<HistoryGroup[]>;
  exportHistoryGroup?: (groupId: string) => Promise<unknown>;
  renameHistoryItem?: (id: string, name: string) => Promise<{ ok: boolean; message?: string; item?: unknown }>;
  openInExplorer?: (targetPath: string) => Promise<unknown>;
  startImageDrag?: (filePath: string) => void;
}

export type ItemRef = Pick<AssetItem, 'kind' | 'id' | 'revision'>;
export const selectionOf = (items: readonly ItemRef[]) => items.map(item => ({ kind: item.kind, id: item.id, expectedRevision: item.revision }));

/** The host handles at most this many items or Recently deleted entries per request (TRASH_BATCH_LIMIT, selection size). */
export const BATCH_LIMIT = 500;
/** Splits a list into requests of at most BATCH_LIMIT. */
export function chunks<T>(values: readonly T[], size = BATCH_LIMIT): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}
// Read with readHostError: a host error that crossed contextBridge keeps its code and reason only in its message.
const reasonOf = (failure: unknown) => readHostError(failure).reason ?? '';
const codeOf = (failure: unknown) => readHostError(failure).code ?? '';

// ── Deleting (always previewed first) ───────────────────────────────────────
// The confirmation shows the preview of exactly the list it then commits; the host refuses the whole commit when an
// item changed or left since (revision check), so nothing outside what the user saw is ever deleted.
export const previewDelete = (api: LibraryApi, items: readonly ItemRef[]): Promise<DeleteReceipt> =>
  api.assetLibrary({ action: 'mutate', command: 'delete', items: selectionOf(items), preview: true });
export const commitDelete = (api: LibraryApi, items: readonly ItemRef[]): Promise<DeleteReceipt> =>
  api.assetLibrary({ action: 'mutate', command: 'delete', items: selectionOf(items) });
/** Every archived item now (the window's ui-archived: the complete list, oss/lib-1103), with its name. */
export async function listArchived(api: LibraryApi): Promise<ArchivedList> {
  const result = await api.assetLibrary({ action: 'ui-archived' }) as { items?: unknown[]; total?: number };
  const items = (Array.isArray(result?.items) ? result.items : []).filter((row: any) => row && typeof row.id === 'string' && typeof row.kind === 'string' && Number.isSafeInteger(row.revision))
    .map((row: any) => ({ kind: row.kind, id: row.id, revision: row.revision, name: typeof row.name === 'string' ? row.name : row.id }));
  return { items, total: Math.max(items.length, Number(result?.total) || 0) };
}
export interface ArchivedList { items: Array<ItemRef & { name: string }>; total: number }

/** One receipt of several (each at most BATCH_LIMIT items): rows, omitted and totals added up. */
export function mergeReceipts(receipts: readonly DeleteReceipt[]): DeleteReceipt {
  if (receipts.length === 1) return receipts[0];
  const add = (into: Record<string, number>, from: Record<string, unknown> | undefined) => { for (const [name, value] of Object.entries(from ?? {})) if (typeof value === 'number') into[name] = (into[name] ?? 0) + value; };
  const deleted: ReceiptRow[] = [], trashIds: string[] = [], files: Record<string, number> = {}, bytes: Record<string, number> = {};
  let entries = 0, omitted = 0, sized = true;
  for (const receipt of receipts) {
    const rows = receipt.deleted ?? [];
    deleted.push(...rows);
    omitted += Number(receipt.omitted?.count) || 0;
    trashIds.push(...(receipt.omitted?.trashIds ?? []));
    entries += Number.isSafeInteger(receipt.totals?.entries) ? Number(receipt.totals!.entries) : rows.length + (Number(receipt.omitted?.count) || 0);
    if (receipt.totals?.files) add(files, receipt.totals.files); else for (const row of rows) add(files, row.files);
    if (receipt.totals?.bytes) add(bytes, receipt.totals.bytes);
    else if (rows.length && rows.every(row => row.bytes && Number.isFinite(row.bytes.moved))) for (const row of rows) add(bytes, row.bytes);
    else if (rows.length) sized = false;
  }
  return { preview: receipts[0]?.preview, deleted, ...(omitted || trashIds.length ? { omitted: { count: omitted, ...(trashIds.length ? { trashIds } : {}) } } : {}), totals: { entries, files, ...(sized ? { bytes } : {}) } };
}
/** Previews deleting a list of any length, BATCH_LIMIT per request, as one receipt (nothing changes). */
export async function previewDeleteAll(api: LibraryApi, items: readonly ItemRef[], progress?: (done: number, total: number) => void): Promise<DeleteReceipt> {
  const receipts: DeleteReceipt[] = [];
  let done = 0;
  for (const part of chunks(items)) { receipts.push(await previewDelete(api, part)); done += part.length; progress?.(done, items.length); }
  return mergeReceipts(receipts);
}
/**
 * Deleting a list that was previewed (清空已归档): BATCH_LIMIT per request, in order. Each request is the host's ordinary
 * delete of exactly those items, refused whole when one of them changed or left since its preview. The run stops at
 * the first refusal: PartialDeleteError carries what was deleted before it (its receipt, for Undo) and the items left.
 */
export async function commitDeleteAll(api: LibraryApi, items: readonly ItemRef[]): Promise<DeleteReceipt> {
  const receipts: DeleteReceipt[] = [];
  const parts = chunks(items);
  for (const [index, part] of parts.entries()) {
    try { receipts.push(await commitDelete(api, part)); }
    catch (failure) { if (!receipts.length) throw failure; throw new PartialDeleteError(failure, mergeReceipts(receipts), parts.slice(index).flat()); }
  }
  return mergeReceipts(receipts);
}
export class PartialDeleteError extends Error {
  /** receipt: what was deleted before the refusal; left: the items not deleted (from the refused request on). */
  constructor(readonly failure: unknown, readonly receipt: DeleteReceipt, readonly left: readonly ItemRef[]) { super('stopped part way'); }
}
export const previewDeleteCollection = (api: LibraryApi, collectionId: string): Promise<{ collections?: Array<{ collectionId: string; name: string; members: number }> }> =>
  api.assetLibrary({ action: 'mutate', command: 'delete', collectionId, preview: true });
export const commitDeleteCollection = (api: LibraryApi, collectionId: string): Promise<{ collections?: Array<{ trashId?: string }> }> =>
  api.assetLibrary({ action: 'mutate', command: 'delete', collectionId });
/** The current saved version of each item (for a new preview after a conflict); items gone since are left out. */
export async function refreshItems<T extends ItemRef>(api: LibraryApi, items: readonly T[]): Promise<{ items: T[]; gone: T[] }> {
  const fresh: T[] = [], gone: T[] = [];
  for (const group of chunks(items, 16)) {
    const read = await Promise.all(group.map(item => api.assetLibrary({ action: 'read', kind: item.kind, id: item.id }).then((detail: { item?: T }) => detail?.item ?? null, (failure: unknown) => {
      // Gone since: deleted (in Recently deleted) or no longer there at all.
      if (/not_found|already_deleted|in_trash/.test(reasonOf(failure)) || codeOf(failure) === 'library_not_found') return null;
      throw failure;
    })));
    read.forEach((value, index) => { if (value && Number.isSafeInteger(value.revision)) fresh.push({ ...group[index], ...value }); else gone.push(group[index]); });
  }
  return { items: fresh, gone };
}

// ── Recently deleted ────────────────────────────────────────────────────────
/** The host's page size for recently-deleted (its contract allows 1–100). */
export const TRASH_PAGE = 100;
export const listTrash = (api: LibraryApi, offset = 0, limit = TRASH_PAGE): Promise<TrashPage> =>
  api.assetLibrary({ action: 'recently-deleted', offset, limit });
/** Every entry Recently deleted lists right now, page by page (deduplicated by trashId). */
export async function listAllTrash(api: LibraryApi): Promise<TrashEntry[]> {
  const seen = new Map<string, TrashEntry>();
  for (let offset = 0, round = 0; round < 1000; round++) {
    const page = await listTrash(api, offset, TRASH_PAGE);
    for (const entry of page.entries) if (!seen.has(entry.trashId)) seen.set(entry.trashId, entry);
    if (!page.hasMore || !page.entries.length) break;
    offset = page.nextOffset ?? offset + page.entries.length;
  }
  return [...seen.values()];
}
export const restoreTrash = (api: LibraryApi, trashIds: readonly string[]): Promise<{ restored?: unknown[]; collections?: unknown[]; totals?: { entries?: number } }> =>
  api.assetLibrary({ action: 'restore', trashIds: [...trashIds] });
export const purgeTrash = (api: LibraryApi, trashIds: readonly string[]): Promise<{ purged?: unknown[]; retryLater?: number; totals?: { entries?: number } }> =>
  api.assetLibrary({ action: 'purge', trashIds: [...trashIds] });

/** A batch run that stopped part way: how far it got before the failure. */
export class PartialRunError extends Error {
  /**
   * done: how many were done; settled: the ids already handled (done, or skipped as gone), so a retry sends only the
   * rest; gone: how many of those were skipped as no longer there.
   */
  constructor(readonly failure: unknown, readonly done: number, readonly settled: readonly string[] = [], readonly gone = 0) { super('stopped part way'); }
}
/**
 * Restores or purges exactly the named entries, 500 per request. The host refuses a whole request when one of them
 * is no longer in Recently deleted (restored or purged elsewhere since); that request is then sent again with only
 * the named entries still listed, never with others. Counts what was done and what was already gone.
 */
async function eachTrashChunk(api: LibraryApi, trashIds: readonly string[], send: (ids: string[]) => Promise<{ purged?: unknown[]; restored?: unknown[]; collections?: unknown[]; retryLater?: number; totals?: { entries?: number } }>, counted: (result: any, ids: string[]) => number) {
  let done = 0, gone = 0, retryLater = 0;
  const settled: string[] = [];
  const stop = (failure: unknown) => new PartialRunError(failure, done, [...settled], gone);
  for (const chunk of chunks([...new Set(trashIds)])) {
    let ids = chunk, result;
    try { result = await send(ids); }
    catch (failure) {
      if (reasonOf(failure) !== 'trash.entry_not_found') throw stop(failure);
      const present = new Set((await listAllTrash(api).catch(cause => { throw stop(cause); })).map(entry => entry.trashId));
      ids = chunk.filter(id => present.has(id));
      const missing = chunk.filter(id => !present.has(id));
      gone += missing.length; settled.push(...missing);
      if (!ids.length) continue;
      try { result = await send(ids); } catch (again) { throw stop(again); }
    }
    done += counted(result, ids);
    settled.push(...ids);
    retryLater += Number(result?.retryLater) || 0;
  }
  return { done, gone, retryLater };
}
/** Purges exactly these entries (for 清空最近删除: the ones the confirmation listed when it opened). */
export async function purgeListed(api: LibraryApi, trashIds: readonly string[]) {
  const result = await eachTrashChunk(api, trashIds, ids => purgeTrash(api, ids), (value, ids) => Number(value?.totals?.entries ?? value?.purged?.length ?? ids.length) || 0);
  return { purged: result.done, gone: result.gone, retryLater: result.retryLater };
}
/** Restores exactly these entries (Undo after a delete; the Restore button). */
export async function restoreListed(api: LibraryApi, trashIds: readonly string[]) {
  const result = await eachTrashChunk(api, trashIds, ids => restoreTrash(api, ids), (value, ids) => Number(value?.totals?.entries ?? ((value?.restored?.length ?? 0) + (value?.collections?.length ?? 0))) || ids.length);
  return { restored: result.done, gone: result.gone };
}

// ── Collections, projects, archive ──────────────────────────────────────────
/** A selection action over any number of items, 500 per request (each request is applied on its own). */
async function eachChunk(items: readonly ItemRef[], send: (part: ItemRef[]) => Promise<unknown>) {
  let done = 0;
  for (const part of chunks(items)) { try { await send(part); } catch (failure) { if (!done) throw failure; throw new PartialRunError(failure, done); } done += part.length; }
  return done;
}
export const addToCollection = (api: LibraryApi, items: readonly ItemRef[], collectionId: string) =>
  eachChunk(items, part => api.assetLibrary({ action: 'mutate', command: 'add-to-collection', items: selectionOf(part), collectionId }));
export const removeFromCollection = (api: LibraryApi, items: readonly ItemRef[], collectionId: string) =>
  eachChunk(items, part => api.assetLibrary({ action: 'mutate', command: 'remove-from-collection', items: selectionOf(part), collectionId }));
export const setArchived = (api: LibraryApi, items: readonly ItemRef[], archived: boolean) =>
  eachChunk(items, part => api.assetLibrary({ action: 'mutate', command: 'archive', items: selectionOf(part), patch: { archived } }));
export const createCollection = (api: LibraryApi, name: string): Promise<{ collection: { id: string; name: string } }> =>
  api.assetLibrary({ action: 'create-collection', name: name.trim() });
/** Renames a user collection; the host checks the collections list revision it was read at. */
export async function renameCollection(api: LibraryApi, collectionId: string, name: string) {
  const { revision } = await api.assetLibrary({ action: 'collections' }) as { revision: number };
  return api.assetLibrary({ action: 'rename-collection', collectionId, name: name.trim(), expectedRevision: revision });
}
/** Moves history images into a project (history group "history:<groupId>"); the host sets their groupId. */
export const moveToProject = (api: LibraryApi, items: readonly ItemRef[], projectId: string) => addToCollection(api, items, projectId);
/** Takes history images out of the project they are in (one call per project). */
export async function removeFromProjects(api: LibraryApi, items: ReadonlyArray<ItemRef & { payload?: Record<string, any> }>) {
  const byProject = new Map<string, ItemRef[]>();
  for (const item of items) { const group = item.payload?.groupId; if (typeof group === 'string' && group) byProject.set(`history:${group}`, [...(byProject.get(`history:${group}`) ?? []), item]); }
  for (const [projectId, members] of byProject) await removeFromCollection(api, members, projectId);
  return byProject.size;
}
export const setCustomTags = (api: LibraryApi, item: ItemRef, tags: readonly string[]) =>
  api.assetLibrary({ action: 'mutate', command: 'set-custom-tags', items: [{ kind: 'history', id: item.id, expectedRevision: item.revision }], tags: [...tags] });
