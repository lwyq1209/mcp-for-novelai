import type { AssetKind } from '../asset-library/types';
import { agentClientLabel } from '../agent-clients';

/**
 * Reading the host's Recently Deleted receipts (electron/library-trash.ts) for the window (step 4b1): the delete /
 * delete-archived preview that fills the confirmation, and the recently-deleted entries. Pure functions; the host's
 * numbers are used as they are, nothing is estimated.
 */
export interface ReceiptRow {
  kind: AssetKind; id: string; revision: number; name: string; trashId?: string;
  files?: { moved?: number; kept?: number; missing?: number };
  bytes?: { moved?: number; unknownSize?: number };
  impacts?: {
    collections?: Array<{ collectionId: string; name: string }>;
    coversCleared?: Array<{ kind: 'tag'; id: string; name: string }>;
    recipes?: Array<{ recipeId: string }>;
    referencedBy?: Array<{ kind: string; id: string; name: string }>;
    sharedFiles?: Array<{ role: string; usedBy: string[] }>;
    recipesUnknown?: boolean;
  };
}
export interface DeleteReceipt {
  preview?: boolean;
  deleted?: ReceiptRow[];
  omitted?: { count?: number; trashIds?: string[] };
  totals?: { entries?: number; files?: Record<string, number>; bytes?: Record<string, number> };
  remaining?: number;
  more?: string;
}

export interface DeleteSummary {
  /** Items the deletion covers (listed and not listed). */
  count: number;
  /** Items the receipt did not list (it lists about 24 KB of rows; totals count all). */
  omitted: number;
  filesMoved: number;
  /** Known bytes of the moving files; null when the host gave no sizes. */
  bytesMoved: number | null;
  unknownSize: number;
  filesKept: number;
  filesMissing: number;
  /** User collections the items leave (unique names, listed rows). */
  collections: string[];
  recipes: number;
  recipesUnknown: boolean;
  coversCleared: string[];
  referencedBy: number;
  byKind: Array<{ kind: AssetKind; count: number }>;
  rows: ReceiptRow[];
  /** delete-archived: archived items left for another run (it handles 500 at a time). */
  remaining: number;
}

const sum = (rows: readonly ReceiptRow[], pick: (row: ReceiptRow) => number | undefined) => rows.reduce((total, row) => total + (Number(pick(row)) || 0), 0);
const unique = <T,>(values: readonly T[]) => [...new Set(values)];

export function summarizeDeleteReceipt(receipt: DeleteReceipt | null | undefined): DeleteSummary {
  const rows = Array.isArray(receipt?.deleted) ? receipt!.deleted! : [];
  const totals = receipt?.totals;
  const omitted = Math.max(0, Number(receipt?.omitted?.count) || 0);
  const count = Number.isSafeInteger(totals?.entries) ? Number(totals!.entries) : rows.length + omitted;
  const hasBytes = totals?.bytes ? true : rows.length > 0 && rows.every(row => row.bytes && Number.isFinite(row.bytes.moved));
  const kinds = new Map<AssetKind, number>();
  for (const row of rows) kinds.set(row.kind, (kinds.get(row.kind) ?? 0) + 1);
  return {
    count, omitted,
    filesMoved: totals?.files ? Number(totals.files.moved) || 0 : sum(rows, row => row.files?.moved),
    bytesMoved: hasBytes ? (totals?.bytes ? Number(totals.bytes.moved) || 0 : sum(rows, row => row.bytes?.moved)) : null,
    unknownSize: totals?.bytes ? Number(totals.bytes.unknownSize) || 0 : sum(rows, row => row.bytes?.unknownSize),
    filesKept: totals?.files ? Number(totals.files.kept) || 0 : sum(rows, row => row.files?.kept),
    filesMissing: totals?.files ? Number(totals.files.missing) || 0 : sum(rows, row => row.files?.missing),
    collections: unique(rows.flatMap(row => (row.impacts?.collections ?? []).filter(value => value.collectionId.startsWith('user:')).map(value => value.name))),
    recipes: unique(rows.flatMap(row => (row.impacts?.recipes ?? []).map(value => value.recipeId))).length,
    recipesUnknown: rows.some(row => row.impacts?.recipesUnknown === true),
    coversCleared: unique(rows.flatMap(row => (row.impacts?.coversCleared ?? []).map(value => value.name))),
    referencedBy: unique(rows.flatMap(row => (row.impacts?.referencedBy ?? []).map(value => `${value.kind}:${value.id}`))).length,
    byKind: [...kinds.entries()].map(([kind, value]) => ({ kind, count: value })),
    rows,
    remaining: Math.max(0, Number(receipt?.remaining) || 0),
  };
}

/**
 * Every trashId a committed deletion created (for "Undo"): the listed rows' and the ones the receipt names only in
 * omitted.trashIds (review rework: Undo after a large delete restores all of them). unnamed counts deleted items the
 * receipt did not name at all (beyond its budget); they can only be restored from Recently deleted.
 */
export function receiptTrashIds(receipt: DeleteReceipt | null | undefined): string[] {
  const ids = [...(receipt?.deleted ?? []).map(row => row.trashId), ...(Array.isArray(receipt?.omitted?.trashIds) ? receipt!.omitted!.trashIds! : [])];
  return [...new Set(ids.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}
export function receiptUnnamed(receipt: DeleteReceipt | null | undefined): number {
  const summary = summarizeDeleteReceipt(receipt);
  return Math.max(0, summary.count - receiptTrashIds(receipt).length);
}

// ── Recently deleted entries ────────────────────────────────────────────────
export interface TrashEntry {
  trashId: string; kind: AssetKind | 'collection'; id?: string; collectionId?: string; revision?: number; name: string;
  deletedAt: string; expiresAt: string; state?: 'moving';
  files?: { moved?: number; kept?: number; missing?: number };
  bytes?: { moved?: number; unknownSize?: number };
  impacts?: { collections?: number; coversCleared?: number; recipes?: number; referencedBy?: number; sharedFiles?: number; recipesUnknown?: boolean };
  members?: number;
  deletedBy?: { kind: 'user' } | { kind: 'agent'; client: { name: string; version: string | null } | null };
}
export interface TrashPage { entries: TrashEntry[]; total: number; offset: number; limit: number; hasMore: boolean; nextOffset: number | null; retentionDays: number; revision: number }

const DAY = 86_400_000;
/** Days until an entry is purged, rounded up (a fresh deletion shows 30; 0 once it is due), never negative. */
export function trashDaysLeft(entry: Pick<TrashEntry, 'expiresAt'>, now: number = Date.now()) {
  const left = new Date(entry.expiresAt).getTime() - now;
  return Number.isFinite(left) ? Math.max(0, Math.ceil(left / DAY)) : 0;
}
/** Who deleted an entry: "you", the agent's name, or null when the entry predates the field. */
export function trashDeletedBy(entry: Pick<TrashEntry, 'deletedBy'>): { kind: 'user' } | { kind: 'agent'; label: string } | null {
  const by = entry.deletedBy;
  if (!by) return null;
  return by.kind === 'user' ? { kind: 'user' } : { kind: 'agent', label: agentClientLabel(by.client) };
}
export type TrashImpact = { key: 'colls' | 'recipes' | 'covers' | 'referenced' | 'shared' | 'members'; n: number };
/** The effects an entry had when it was deleted, in display order; empty for none. */
export function trashImpacts(entry: TrashEntry): TrashImpact[] {
  if (entry.kind === 'collection') return [{ key: 'members', n: Number(entry.members) || 0 }];
  const impacts = entry.impacts ?? {}, out: TrashImpact[] = [];
  const push = (key: TrashImpact['key'], value: unknown) => { const n = Number(value) || 0; if (n > 0) out.push({ key, n }); };
  push('colls', impacts.collections); push('recipes', impacts.recipes); push('covers', impacts.coversCleared); push('referenced', impacts.referencedBy); push('shared', entry.files?.kept);
  return out;
}
/** Files and known bytes a purge of these entries deletes (bytes null when an entry has no size). */
export function purgeSize(entries: readonly TrashEntry[]) {
  const files = entries.reduce((total, entry) => total + (Number(entry.files?.moved) || 0), 0);
  const sized = entries.every(entry => entry.kind === 'collection' || !(Number(entry.files?.moved) > 0) || (entry.bytes && Number.isFinite(entry.bytes.moved)));
  const bytes = sized ? entries.reduce((total, entry) => total + (Number(entry.bytes?.moved) || 0), 0) : null;
  const shared = entries.reduce((total, entry) => total + (Number(entry.files?.kept) || 0), 0);
  return { files, bytes, shared };
}
