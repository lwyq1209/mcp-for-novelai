import Ajv from 'ajv';
import contracts from '../generated/library-contracts.json';
import type { MaterialBackup } from '../workspace/material-library-types';

/**
 * The library's material backup (tags, combos, notes and their local covers as one JSON file): the one check and the
 * one import the library page and Settings › Storage share (step 4c1). The host's material_library import adds every
 * entry as a new one (existing entries are kept); before it, the window previews what the file holds and which entries
 * look like ones the library already has, and may leave those out.
 */
export const LIBRARY_BACKUP_MAX_BYTES = 64 * 1024 * 1024;
/** The material library's entry limit (electron/material-library.ts MAX_ENTRIES): an import past it is refused whole. */
export const MATERIAL_ENTRY_LIMIT = 1000;
const KINDS = ['tag', 'combo', 'note'] as const;
export type MaterialBackupKind = typeof KINDS[number];

export type BackupRefusal =
  | { reason: 'too_big' | 'bad_json' | 'bad_format' }
  /** Entry n (from 1) is not a complete library entry (name: its name when it has one). */
  | { reason: 'bad_entry'; n: number; name: string }
  /** Cover n (from 1) is not a complete saved cover. */
  | { reason: 'bad_cover'; n: number }
  | { reason: 'too_many_covers' };
export type BackupParse = { ok: true; data: MaterialBackup } | ({ ok: false } & BackupRefusal);

// The host's own contract for material_library import (contracts: requests.material_library, its import branch's data),
// with the host's Ajv settings (electron/library/validation.ts): a file that passes here passes the host's check.
type Branch = { properties?: { action?: { const?: unknown }; data?: object } };
const importSchema = (contracts.schemas.requests.material_library as unknown as { anyOf: Branch[] }).anyOf.find(branch => branch.properties?.action?.const === 'import')!.properties!.data!;
const validateBackup = new Ajv({ strict: false, strictNumbers: true, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false }).compile(importSchema);

/**
 * A backup file's text as the host's import takes it: size, JSON, then the host's contract (schema version, every
 * entry and cover complete), the closed top level and no more covers than entries. A refusal names the first entry or
 * cover that does not pass, never the validator's own report (review rework: a hand-made file).
 */
export function parseLibraryBackup(text: string): BackupParse {
  if (new TextEncoder().encode(text).length > LIBRARY_BACKUP_MAX_BYTES) return { ok: false, reason: 'too_big' };
  let data: unknown;
  try { data = JSON.parse(text); } catch { return { ok: false, reason: 'bad_json' }; }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['schemaVersion', 'entries', 'covers'].includes(key))) return { ok: false, reason: 'bad_format' };
  if (!validateBackup(data)) {
    const where = /^\/(entries|covers)\/(\d+)(?:\/|$)/.exec(validateBackup.errors?.[0]?.instancePath ?? '');
    if (where?.[1] === 'entries') {
      const index = Number(where[2]), entry = (data as { entries: unknown[] }).entries[index] as { name?: unknown } | null;
      return { ok: false, reason: 'bad_entry', n: index + 1, name: typeof entry?.name === 'string' ? entry.name.trim().slice(0, 60) : '' };
    }
    if (where?.[1] === 'covers') return { ok: false, reason: 'bad_cover', n: Number(where[2]) + 1 };
    return { ok: false, reason: 'bad_format' };
  }
  const value = data as MaterialBackup;
  if ((value.covers?.length ?? 0) > value.entries.length) return { ok: false, reason: 'too_many_covers' };
  return { ok: true, data: value };
}

/** What the library holds now, for the duplicate check: kind, name and (tags) the tag text. */
export interface ExistingMaterial { kind: string; name: string; text?: string }
const sameKey = (kind: string, name: string, text?: string) => `${kind}\u0000${name.trim().toLowerCase()}\u0000${(text ?? '').trim().toLowerCase()}`;

export interface BackupPreview {
  total: number;
  byKind: Record<MaterialBackupKind, number>;
  covers: number;
  /** Entries of the backup (by their position in the file) of the same kind, name and tag text as one the library has. */
  duplicates: number[];
  /** The library's entries now. */
  existing: number;
  /** Importing them all would pass MATERIAL_ENTRY_LIMIT (the host refuses the whole import). */
  overLimit: boolean;
  /** Importing only the new-looking ones would pass it too. */
  overLimitWithout: boolean;
}
export function previewLibraryBackup(data: MaterialBackup, existing: readonly ExistingMaterial[], limit = MATERIAL_ENTRY_LIMIT): BackupPreview {
  const have = new Set(existing.map(item => sameKey(item.kind, item.name, item.text)));
  const byKind: Record<MaterialBackupKind, number> = { tag: 0, combo: 0, note: 0 };
  const duplicates: number[] = [];
  for (const [index, entry] of data.entries.entries()) {
    if ((KINDS as readonly string[]).includes(entry.kind)) byKind[entry.kind as MaterialBackupKind]++;
    if (have.has(sameKey(entry.kind, entry.name, entry.tag?.text))) duplicates.push(index);
  }
  const total = data.entries.length;
  return { total, byKind, covers: data.covers?.length ?? 0, duplicates, existing: existing.length, overLimit: existing.length + total > limit, overLimitWithout: existing.length + total - duplicates.length > limit };
}

/**
 * The backup without the entries at these positions, and without their covers (the host checks every cover against an
 * entry): by position, so entries sharing or lacking an id are never left out with another one.
 */
export function withoutEntries(data: MaterialBackup, positions: readonly number[]): MaterialBackup {
  const left = new Set(positions);
  const entries = data.entries.filter((_entry, index) => !left.has(index));
  const kept = new Set(entries.map(entry => entry.id));
  const covers = data.covers?.filter(cover => kept.has(cover.entryId));
  return { schemaVersion: 1, entries, ...(covers && covers.length ? { covers } : {}) };
}

type Api = { assetLibrary(args: Record<string, unknown>): Promise<any>; materialLibrary?(args: Record<string, unknown>): Promise<any> };
/** The library's tags, combos and notes now (archived ones too), 500 per read. */
export async function readExistingMaterials(api: Api): Promise<ExistingMaterial[]> {
  const out: ExistingMaterial[] = [];
  for (let offset = 0, round = 0; round < 20; round++) {
    const page = await api.assetLibrary({ action: 'ui-list', kinds: [...KINDS], archived: 'include', sortBy: 'name', sortDirection: 'asc', offset, limit: 500 }) as { items?: Array<{ kind: string; name: string; payload?: { tag?: { text?: string } } }>; hasMore?: boolean };
    for (const item of page.items ?? []) out.push({ kind: item.kind, name: item.name ?? '', text: item.payload?.tag?.text });
    if (!page.hasMore || !page.items?.length) break;
    offset += page.items.length;
  }
  return out;
}

export interface BackupImportResult { count: number; covers: number; error?: { code?: string; message: string; reason?: string } }
/** The host's import (material_library import): new entries; stops at its first failure, keeping what it imported. */
export async function importLibraryBackup(api: Api, data: MaterialBackup): Promise<BackupImportResult> {
  const result = await api.materialLibrary!({ action: 'import', data }) as { count?: number; coverWarnings?: unknown[]; error?: BackupImportResult['error'] };
  return { count: result.count ?? 0, covers: result.coverWarnings?.length ?? 0, ...(result.error ? { error: result.error } : {}) };
}

/** The host's export (material_library export), all entries or the named ones. */
export async function exportLibraryBackup(api: Api, ids?: readonly string[]): Promise<{ data: MaterialBackup; coversLeftOut: number }> {
  const result = await api.materialLibrary!({ action: 'export', ...(ids ? { ids: [...ids] } : {}) }) as { data: MaterialBackup; warnings?: unknown[] };
  return { data: result.data, coversLeftOut: result.warnings?.length ?? 0 };
}

/** Saves a JSON value as a file through the window's download (the save dialog). */
export function saveJsonFile(data: unknown, fileName: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = fileName; link.click();
  URL.revokeObjectURL(url);
}
