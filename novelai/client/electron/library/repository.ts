import { extractHistoryTags, normalizeHistoryTag, HISTORY_TAG_SOURCES } from './history-tags';
import type { HistoryTag, HistoryTagSource } from '../../src/generated/library-contracts.mjs' with { 'resolution-mode': 'import' };
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LIBRARY_KINDS, LIBRARY_CHANGE_ID_LIMIT, LIBRARY_COLLECTION_NAMESPACE_KINDS, type LibraryChange, type LibraryChangeListener, type LibraryKind, type LibraryPayload, type LibraryItem, type PutOptions, type ListFilters, type LibraryList, type LibraryListFact, type LibraryCollection, type LibraryMembership, type LibraryRelation, type LibraryAsset, type LibraryAssetLink, type LibraryItemAsset, type LibraryCover, type PendingFileOperation, type LibrarySnapshot, type TrashEntry, type TrashEntryKind, type TrashFile, type TrashFileState } from './types';
import { bytesKey, createHistoryViewIndex, HISTORY_DATE_TYPE_SQL, HISTORY_DATE_VALUE_SQL, HISTORY_GROUP_TYPE_SQL, HISTORY_GROUP_VALUE_SQL, HISTORY_UNGROUPED_SQL, type HistoryViewIndex, type HistoryViewQuery } from './history-view-index';
import { withReason, type HostErrorParams } from '../host-error';
export * from './types';

/**
 * Library schema version rule. The schema version is 8: the core tables created below (idempotently, on every
 * writable open). An open accepts only a library of version 8. A new library (version 0 and no tables at all) is
 * created at 8 by a writable open. Every other version is refused without changing the file: 1–7 were written by
 * unsupported older versions, anything above 8 by a newer client, and a version-0 file that already holds tables is
 * not a library of this app. A future migration must use a version of 9 or higher and must run for every lower
 * supported version.
 *
 * The Recently Deleted tables (trash_entries, trash_versions, trash_files; 2026-11-02) are not part of an open: the
 * first deletion creates them (CREATE … IF NOT EXISTS in its own write transaction), so opening a library changes
 * nothing, and every reader treats their absence as an empty Recently Deleted. They need no version of their own.
 */
export const LIBRARY_SCHEMA_VERSION = 8;

/**
 * Comparison key of a file path: resolved, Unicode-normalized (NFC; macOS file systems treat NFC and NFD names alike)
 * and case-folded on the case-insensitive default file systems of macOS and Windows. Every check of whether two
 * paths name one file uses this key.
 */
export function libraryPathKey(file: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = path.resolve(file).normalize('NFC');
  return platform === 'darwin' || platform === 'win32' ? resolved.toLowerCase() : resolved;
}
/** Printable ASCII runs (3+) of a name as it appears inside JSON text, lowercased: a case- and normalization-proof text prefilter. */
function asciiRuns(name: string): string[] {
  return JSON.stringify(name.normalize('NFC')).slice(1, -1).toLowerCase().match(/[\x20\x21\x23-\x5b\x5d-\x7e]{3,}/g) ?? [];
}

const TRASH_DDL = `CREATE TABLE IF NOT EXISTS trash_entries(id TEXT PRIMARY KEY,kind TEXT NOT NULL,item_id TEXT NOT NULL,revision INTEGER,name TEXT NOT NULL,deleted_ms INTEGER NOT NULL,expires_ms INTEGER NOT NULL,state TEXT NOT NULL,summary_json TEXT NOT NULL,data_json TEXT NOT NULL,UNIQUE(kind,item_id));
  CREATE INDEX IF NOT EXISTS trash_entries_expiry ON trash_entries(expires_ms);
  CREATE INDEX IF NOT EXISTS trash_entries_order ON trash_entries(deleted_ms DESC,id);
  CREATE TABLE IF NOT EXISTS trash_versions(trash_id TEXT NOT NULL,revision INTEGER NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(trash_id,revision),FOREIGN KEY(trash_id) REFERENCES trash_entries(id) ON DELETE CASCADE);
  CREATE TABLE IF NOT EXISTS trash_files(trash_id TEXT NOT NULL,ordinal INTEGER NOT NULL,role TEXT NOT NULL,path TEXT NOT NULL,path_key TEXT NOT NULL,trash_path TEXT,state TEXT NOT NULL,byte_length INTEGER,real_dir TEXT,sha256 TEXT,PRIMARY KEY(trash_id,ordinal),FOREIGN KEY(trash_id) REFERENCES trash_entries(id) ON DELETE CASCADE);
  CREATE INDEX IF NOT EXISTS trash_files_path ON trash_files(path_key);`;
const TRASH_FILE_STATES: readonly TrashFileState[] = ['planned', 'moved', 'kept-shared', 'kept-outside', 'kept-unsafe', 'kept-failed', 'missing', 'retained'];
/** Files a trash entry still names at their original path: the ones a purge or another deletion must treat as used. */
const TRASH_FILES_IN_PLACE = "state NOT IN ('moved','missing')";

/** The renderer notice for one committed change (`novelai:library:change`); an unknown change carries only its revision. */
export function libraryChangeNotice(revision: number, change: LibraryChange): { revision: number; changedKinds?: string[]; ids?: string[] } {
  return { revision, ...(change.changedKinds ? { changedKinds: [...change.changedKinds] } : {}), ...(change.ids ? { ids: [...change.ids] } : {}) };
}

/** A history list view: an empty or missing field does not filter. */
export interface HistoryViewFilter { date?: string; groupId?: string }

/** reason/params: the window's catalog message (src/host-errors/library.ts); the message is English. */
export class LibraryError extends Error {
  declare reason?: string; declare params?: HostErrorParams;
  constructor(public code: string, message: string, reason?: string, params?: HostErrorParams) { super(message); this.name = 'LibraryError'; if (reason) withReason(this, reason, params); }
}
const fail = (code: string, message: string, reason?: string, params?: HostErrorParams): never => { throw new LibraryError(code, message, reason, params); };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const identity = (value: unknown, label = 'id'): string => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\x00-\x1f]/.test(value) ? value : fail('invalid_argument', `Invalid library ${label}.`);
const kindOf = (value: unknown): LibraryKind => LIBRARY_KINDS.includes(value as LibraryKind) ? value as LibraryKind : fail('invalid_argument', 'Invalid library kind.');
const version = (value: unknown, minimum = 1): number => Number.isSafeInteger(value) && Number(value) >= minimum ? Number(value) : fail('invalid_argument', 'Invalid library revision.');
const json = (value: unknown): string => {
  let result: string | undefined;
  try { result = JSON.stringify(value); } catch { return fail('invalid_argument', 'Library values must be JSON serializable.'); }
  if (!result || Buffer.byteLength(result) > 40 * 1024 * 1024) return fail('invalid_argument', 'Library record is missing or exceeds 40 MiB.');
  return result;
};
const object = (value: unknown): LibraryPayload => value && typeof value === 'object' && !Array.isArray(value) ? value as LibraryPayload : fail('invalid_argument', 'Library payload must be an object.');
const date = (value: unknown, fallback: string): string => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fallback;
function searchable(payload: LibraryPayload, name: string): string {
  const values = [name];
  const visit = (value: unknown, key = '', depth = 0) => {
    if (depth > 12 || /^(?:data|base64|raw|filePath|fileUrl|preview|thumbnail|imageBase64|maskBase64)$/i.test(key)) return;
    if (typeof value === 'string') { if (value.length < 100_000 && !value.startsWith('data:image/')) values.push(value); }
    else if (Array.isArray(value)) value.forEach(item => visit(item, key, depth + 1));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([childKey, item]) => visit(item, childKey, depth + 1));
  };
  visit(payload);
  return values.join('\n').normalize('NFC').toLowerCase();
}

/** Refuses a library file whose version this build does not open (see LIBRARY_SCHEMA_VERSION); the file is left as it is. */
function refuseVersion(version: number, holdsTables: boolean): never {
  if (version > LIBRARY_SCHEMA_VERSION) return fail('library_schema_unsupported', 'This library requires a newer client.');
  if (version >= 1) return fail('library_schema_unsupported', `This library was created by an unsupported older version (library version ${version}); this version opens only library version ${LIBRARY_SCHEMA_VERSION}. The file was not changed.`);
  return fail('library_schema_unsupported', holdsTables ? 'This file is not a library this app can recognize: it holds tables but no library version. The file was not changed.' : 'Library has not been initialized.');
}

/** The main process owns this connection. No renderer, accounts, files, or provider calls are involved. */
export function openLibraryRepository(options: { filePath: string; readOnly?: boolean; libraryDirectory?: string; userDataRoot?: string }) {
  const memory = options.filePath === ':memory:';
  const filePath = memory ? options.filePath : path.resolve(options.filePath);
  if (!memory) {
    if (!options.readOnly) fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    for (const candidate of [path.dirname(filePath), filePath]) {
      try { if (fs.lstatSync(candidate).isSymbolicLink()) fail('library_storage_failed', 'Library database cannot use a symbolic link.'); }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  const db = new DatabaseSync(filePath, { readOnly: options.readOnly ?? false, timeout: 200 });
  let closed = false, transactionDepth = 0, readTransactionDepth = 0;
  // Whether the Recently Deleted tables exist (created by the first deletion); re-read after a rolled-back write.
  let trashReady = false;
  const tableExists = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const listeners = new Set<LibraryChangeListener>();
  // What the outermost open write transaction changed. Writers record what
  // they touch before writing, so a partially failed nested write can only
  // over-report. Rolled-back transactions announce nothing.
  let pendingChange: { unknown: boolean; kinds: Set<LibraryKind>; ids: Set<string>; idsComplete: boolean } | null = null;
  function changedItem(kind: LibraryKind, id: string) {
    const change = pendingChange; if (!change || change.unknown) return;
    change.kinds.add(kind);
    if (!change.idsComplete) return;
    change.ids.add(id);
    if (change.ids.size > LIBRARY_CHANGE_ID_LIMIT) { change.idsComplete = false; change.ids.clear(); }
  }
  function changedKinds(kinds: readonly LibraryKind[]) {
    const change = pendingChange; if (!change || change.unknown) return;
    for (const kind of kinds) change.kinds.add(kind);
    change.idsComplete = false; change.ids.clear();
  }
  function changedUnknown() { if (pendingChange) { pendingChange.unknown = true; pendingChange.kinds.clear(); pendingChange.ids.clear(); } }
  /** A collection feeds the views of its namespace's kinds; other namespaces (user/library collections of any kind) are unknown. */
  function changedCollection(namespace: string) {
    const kinds = Object.hasOwn(LIBRARY_COLLECTION_NAMESPACE_KINDS, namespace) ? LIBRARY_COLLECTION_NAMESPACE_KINDS[namespace] : undefined;
    if (kinds) changedKinds(kinds); else changedUnknown();
  }
  // An empty change ([] / []) is announced too; see the constraint at putFileOperation for what may rely on it.
  function announcement(change: NonNullable<typeof pendingChange>): LibraryChange {
    if (change.unknown) return Object.freeze({});
    const kinds = Object.freeze([...change.kinds].sort());
    return Object.freeze(change.idsComplete ? { changedKinds: kinds, ids: Object.freeze([...change.ids].sort()) } : { changedKinds: kinds });
  }
  db.exec('PRAGMA foreign_keys = ON');
  const userVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  if (options.readOnly) {
    if (userVersion !== LIBRARY_SCHEMA_VERSION) {
      // The same answer as a writable open: a version-0 file with tables is not a library of this app.
      const holdsTables = userVersion === 0 && !!db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
      db.close(); refuseVersion(userVersion, holdsTables);
    }
  } else {
    try {
      db.exec('BEGIN IMMEDIATE');
      const lockedUserVersion=Number(db.prepare('PRAGMA user_version').get()?.user_version);
      if(lockedUserVersion!==LIBRARY_SCHEMA_VERSION&&(lockedUserVersion!==0||db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get()))refuseVersion(lockedUserVersion,lockedUserVersion===0);
      db.exec(`CREATE TABLE IF NOT EXISTS items(kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,name TEXT NOT NULL,archived INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,source_namespace TEXT NOT NULL,record_json TEXT NOT NULL,search_text TEXT NOT NULL,PRIMARY KEY(kind,id));
        CREATE TABLE IF NOT EXISTS versions(kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(kind,id,revision));
        CREATE TABLE IF NOT EXISTS history_tags(history_id TEXT NOT NULL,tag TEXT NOT NULL,source TEXT NOT NULL,character_index INTEGER NOT NULL,PRIMARY KEY(history_id,source,character_index,tag));
        CREATE INDEX IF NOT EXISTS history_tags_lookup ON history_tags(tag,source,history_id);
        CREATE INDEX IF NOT EXISTS items_order ON items(updated_at DESC,kind,id);
        CREATE INDEX IF NOT EXISTS items_created_order ON items(created_at,kind,id);
        CREATE INDEX IF NOT EXISTS items_name_order ON items(name COLLATE NOCASE,kind,id);
        CREATE INDEX IF NOT EXISTS items_kind ON items(kind,archived,updated_at DESC);
        CREATE TABLE IF NOT EXISTS collections(namespace TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(namespace,id));
        CREATE TABLE IF NOT EXISTS memberships(namespace TEXT NOT NULL,collection_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(namespace,collection_id,kind,id),FOREIGN KEY(namespace,collection_id) REFERENCES collections(namespace,id) ON DELETE CASCADE,FOREIGN KEY(kind,id) REFERENCES items(kind,id) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS membership_item ON memberships(kind,id);
        CREATE TABLE IF NOT EXISTS relations(kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,ordinal INTEGER NOT NULL,target_kind TEXT,target_id TEXT,target_revision INTEGER,payload_json TEXT NOT NULL,PRIMARY KEY(kind,id,revision,ordinal));
        CREATE INDEX IF NOT EXISTS relations_target ON relations(target_kind,target_id);
        CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,payload_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS asset_links(kind TEXT NOT NULL,id TEXT NOT NULL,role TEXT NOT NULL,asset_id TEXT NOT NULL,PRIMARY KEY(kind,id,role),FOREIGN KEY(kind,id) REFERENCES items(kind,id) ON DELETE CASCADE,FOREIGN KEY(asset_id) REFERENCES assets(id));
        CREATE TABLE IF NOT EXISTS covers(kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,payload_json TEXT,PRIMARY KEY(kind,id),FOREIGN KEY(kind,id) REFERENCES items(kind,id) ON DELETE CASCADE);
        CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS file_operations(id TEXT PRIMARY KEY,record_json TEXT NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(kind UNINDEXED,id UNINDEXED,search_text,tokenize='trigram');
      `);
      // A new library: the core tables above, then its version.
      if(lockedUserVersion===0)db.exec(`PRAGMA user_version = ${LIBRARY_SCHEMA_VERSION}`);
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} db.close(); throw error; }
    if (!memory) fs.chmodSync(filePath, 0o600);
  }
  const historyIndex = createHistoryViewIndex(db);
  trashReady = tableExists('trash_entries');
  function active() { if (closed) fail('library_closed', 'Library connection is closed.'); }
  function getRevision() { active(); const row: any = db.prepare('SELECT value_json FROM metadata WHERE key=?').get('revision'); return row ? Number(JSON.parse(row.value_json)) : 0; }
  /** Consistent synchronous read boundary. No revision write or mutation notification.
   * Nested exports share the owner's active transaction; writes cannot upgrade this boundary.
   */
  function readTransaction<T>(work: () => T): T {
    active();
    const ownsTransaction = transactionDepth === 0 && readTransactionDepth === 0;
    if (ownsTransaction) db.exec('BEGIN DEFERRED');
    readTransactionDepth++;
    try {
      // BEGIN is deferred: pin the SQLite snapshot before invoking any callback/export seam.
      if (ownsTransaction) getRevision();
      const result = work();
      if (result && typeof (result as { then?: unknown }).then === 'function') fail('invalid_argument', 'Read transactions require synchronous callbacks.');
      if (ownsTransaction) db.exec('COMMIT');
      return result;
    } catch (error) {
      if (ownsTransaction) db.exec('ROLLBACK');
      throw error;
    } finally { readTransactionDepth--; }
  }
  /** One write boundary. After COMMIT, listeners hear once what it changed; `unknownChange` marks writes this repository cannot classify. */
  function transaction<T>(work: () => T, transactionOptions: { unknownChange?: boolean } = {}): T {
    active();
    if (options.readOnly || readTransactionDepth) return fail('library_read_only', readTransactionDepth ? 'Writes are forbidden inside a consistent read transaction.' : 'Library is read-only.');
    if (transactionDepth) { if (transactionOptions.unknownChange) changedUnknown(); return work(); }
    db.exec('BEGIN IMMEDIATE'); transactionDepth++;
    historyIndex.writeBegan();
    pendingChange = { unknown: transactionOptions.unknownChange === true, kinds: new Set(), ids: new Set(), idsComplete: true };
    let result: T, revision: number, change: NonNullable<typeof pendingChange> | undefined;
    try {
      result = work(); revision = getRevision() + 1;
      db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run('revision', JSON.stringify(revision));
      db.exec('COMMIT');
      change = pendingChange;
    }
    catch (error) { db.exec('ROLLBACK'); trashReady = tableExists('trash_entries'); throw error; }
    finally {
      transactionDepth--; pendingChange = null;
      // The history view index hears every outcome first: what a commit changed, or that nothing did.
      settleHistoryIndex(change);
    }
    const announced = announcement(change!);
    for (const listener of listeners) { try { listener(revision, announced); } catch { /* Observation cannot undo a committed mutation. */ } }
    return result;
  }
  function settleHistoryIndex(change: NonNullable<typeof pendingChange> | undefined) {
    try { historyIndex.writeEnded(change ? announcement(change) : null); } catch { historyIndex.invalidate(); }
  }
  const decode = (row: any): LibraryItem | null => row ? JSON.parse(String(row.record_json)) : null;
  function get(kind: LibraryKind, id: string, revision?: number): LibraryItem | null {
    active(); kindOf(kind); identity(id);
    return decode(revision === undefined ? db.prepare('SELECT record_json FROM items WHERE kind=? AND id=?').get(kind, id) : db.prepare('SELECT record_json FROM versions WHERE kind=? AND id=? AND revision=?').get(kind, id, version(revision)));
  }
  function put(kind: LibraryKind, id: string, payload: LibraryPayload, options: PutOptions = {}): LibraryItem {
    kindOf(kind); identity(id); object(payload);
    return transaction(() => {
      changedItem(kind, id);
      const previous = get(kind, id), current = previous?.revision ?? 0;
      // One identity is never live and in Recently Deleted at once: a stale copy cannot recreate a deleted item.
      if (!previous && trashReady && db.prepare('SELECT 1 FROM trash_entries WHERE kind=? AND item_id=?').get(kind, id)) fail('library_conflict', 'This item is in Recently Deleted; restore it there, or purge it, before saving it again.', 'library.save_item_in_trash');
      if (options.expectedRevision !== undefined && version(options.expectedRevision, 0) !== current) fail('library_conflict', 'The library item changed; read its current revision.', 'library.item_revision_changed');
      const nextRevision = options.revision === undefined ? current + 1 : version(options.revision);
      if (nextRevision <= current) fail('library_conflict', 'Library revisions are immutable and must increase.');
      const metadata = kind === 'study' && payload.study && typeof payload.study === 'object' ? payload.study : payload;
      const now = new Date().toISOString(), source = options.source ?? previous?.source ?? { namespace: kind === 'artist_favorite' && typeof payload.collection === 'string' ? `artist-favorites:${payload.collection}` : kind, ...(typeof metadata.id === 'string' ? { legacyId: metadata.id } : {}) };
      identity(source.namespace, 'source namespace'); if (source.legacyId !== undefined) identity(source.legacyId, 'legacy id');
      const name = options.name ?? (typeof metadata.name === 'string' ? metadata.name : typeof metadata.title === 'string' ? metadata.title : kind === 'history' && typeof payload.filePath === 'string' ? path.basename(payload.filePath) : kind === 'history' && typeof payload.params?.positivePrompt === 'string' ? payload.params.positivePrompt.slice(0, 120) : previous?.name ?? id);
      if (typeof name !== 'string' || name.length > 4000) fail('invalid_argument', 'Invalid library name.');
      const archived = options.archived ?? (typeof metadata.archived === 'boolean' ? metadata.archived : previous?.archived ?? false);
      if (typeof archived !== 'boolean') fail('invalid_argument', 'Invalid archive state.');
      const item: LibraryItem = { schemaVersion: 1, kind, id, revision: nextRevision, name, archived, createdAt: date(options.createdAt ?? metadata.createdAt, previous?.createdAt ?? now), updatedAt: date(options.updatedAt ?? metadata.updatedAt, now), source: clone(source), payload: clone(payload) };
      const text = options.searchText === undefined ? searchable(payload, name) : String(options.searchText).normalize('NFC').toLowerCase(), encoded = json(item);
      db.prepare('INSERT INTO versions VALUES(?,?,?,?)').run(kind, id, nextRevision, encoded);
      db.prepare('INSERT INTO items VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,name=excluded.name,archived=excluded.archived,created_at=excluded.created_at,updated_at=excluded.updated_at,source_namespace=excluded.source_namespace,record_json=excluded.record_json,search_text=excluded.search_text').run(kind,id,nextRevision,name,archived?1:0,item.createdAt,item.updatedAt,source.namespace,encoded,text);
      // Deleting by (kind,id) scans the whole FTS table (both columns are
      // UNINDEXED): ~all of a put's time in a large library (2026-11-01). A new
      // identity has no FTS row, because put and remove write items and
      // items_fts rows together in one transaction. Even a stray row would not
      // change search results: list() also requires instr() on items.search_text.
      if (previous) db.prepare('DELETE FROM items_fts WHERE kind=? AND id=?').run(kind,id);
      db.prepare('INSERT INTO items_fts(kind,id,search_text) VALUES(?,?,?)').run(kind,id,text);
      project(item);
      if(kind==='history')projectHistoryTags(item);
      return clone(item);
    });
  }
  /** The WHERE clause of list() and listFacts() for the same filters (oss/lib-1103: factored out of list). */
  function listWhere(filters: ListFilters): { where: string; args: Array<string | number> } {
    const args: Array<string | number> = [], clauses: string[] = [];
    if (filters.archivedOnly) clauses.push('i.archived=1');
    else if (!filters.includeArchived) clauses.push('i.archived=0');
    const kinds = filters.kinds ?? (filters.kind ? [filters.kind] : []);
    if (kinds.length) { kinds.forEach(kindOf); clauses.push(`i.kind IN (${kinds.map(() => '?').join(',')})`); args.push(...kinds); }
    if (filters.sourceNamespace !== undefined) { clauses.push('i.source_namespace=?'); args.push(identity(filters.sourceNamespace)); }
    if (filters.group !== undefined) { clauses.push("coalesce(json_extract(i.record_json,'$.payload.group'),'')=?"); args.push(String(filters.group)); }
    if (filters.collectionId !== undefined) { clauses.push('EXISTS(SELECT 1 FROM memberships m WHERE m.kind=i.kind AND m.id=i.id AND m.namespace=? AND m.collection_id=?)'); args.push(identity(filters.collectionNamespace ?? 'library'),identity(filters.collectionId)); }
    // Queued images name their batch and namespaced request key in queueOrigin (2026-10-14); only history has them.
    for (const [value, field] of [[filters.queueRequestKey, 'requestKey'], [filters.queueBatchId, 'batchId']] as const) {
      if (value === undefined) continue;
      clauses.push(`i.kind='history' AND json_extract(i.record_json,'$.payload.queueOrigin.${field}')=?`); args.push(identity(value));
    }
    const query = (filters.query ?? '').trim().normalize('NFC').toLowerCase();
    if (query.length > 1000) fail('invalid_argument', 'Library search is too long.');
    if (query) {
      if(kinds.length===1&&kinds[0]==='history'){
        // The history image finder searches declared tags and the actual
        // displayed name, never negative prompts or hidden replay metadata.
        const tagQuery=normalizeHistoryTag(query);
        clauses.push(`(instr(lower(i.name),?)>0${tagQuery?" OR EXISTS(SELECT 1 FROM history_tags ht WHERE ht.history_id=i.id AND instr(ht.tag,?)>0)":""})`);
        args.push(query,...(tagQuery?[tagQuery]:[]));
      }else{
        // All-material search keeps its existing complete text semantics.
        // Short Chinese queries use the same parameterized substring match.
        if ([...query].length >= 3) { clauses.push('EXISTS(SELECT 1 FROM items_fts f WHERE f.kind=i.kind AND f.id=i.id AND items_fts MATCH ?)'); args.push(`"${query.replaceAll('"','""')}"`); }
        clauses.push('instr(i.search_text,?)>0'); args.push(query);
      }
    }
    const historyTags=normalizedTagFilter(filters.historyTags??[]),tagSources=checkedTagSources(filters.historyTagSources);
    if(historyTags.length){
      if(!['all','any'].includes(filters.historyTagMatch??'all'))fail('invalid_argument','Invalid history tag match.');
      clauses.push("i.kind='history'");
      const sources=tagSources.map(()=>'?').join(',');
      if((filters.historyTagMatch??'all')==='all')for(const tag of historyTags){clauses.push(`EXISTS(SELECT 1 FROM history_tags ht WHERE ht.history_id=i.id AND ht.tag=? AND ht.source IN (${sources}))`);args.push(tag,...tagSources);}
      else {clauses.push(`EXISTS(SELECT 1 FROM history_tags ht WHERE ht.history_id=i.id AND ht.tag IN (${historyTags.map(()=>'?').join(',')}) AND ht.source IN (${sources}))`);args.push(...historyTags,...tagSources);}
    }
    return { where: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', args };
  }
  const LIST_ORDER = { updatedAt: 'i.updated_at', createdAt: 'i.created_at', name: 'i.name COLLATE NOCASE' };
  function listOrder(filters: ListFilters): string {
    const sortBy = filters.sortBy ?? 'updatedAt', direction = filters.sortDirection ?? 'desc';
    if (!Object.hasOwn(LIST_ORDER,sortBy) || !['asc','desc'].includes(direction)) fail('invalid_argument', 'Invalid library sort.');
    return ` ORDER BY ${LIST_ORDER[sortBy]} ${direction.toUpperCase()},i.kind,i.id`;
  }
  function list(filters: ListFilters = {}): LibraryList {
    active();
    const offset = version(filters.offset ?? 0, 0), limit = version(filters.limit ?? 30);
    if (limit > 500) fail('invalid_argument', 'Public library pages are limited to 500 items.');
    const { where, args } = listWhere(filters);
    const total = Number(db.prepare(`SELECT count(*) AS count FROM items i${where}`).get(...args)?.count);
    const order = listOrder(filters);
    const items = db.prepare(`SELECT i.record_json FROM items i${where}${order} LIMIT ? OFFSET ?`).all(...args,limit,offset).map(row => decode(row)!);
    return { items,total,offset,limit,hasMore:offset+items.length<total };
  }
  /**
   * The complete order of a list (the same filters and order as list(), no page) with, per item, the facts the window's
   * image filters read (LibraryListFact), taken with SQL expressions so no record is decoded (oss/lib-1103).
   */
  function listFacts(filters: ListFilters = {}): LibraryListFact[] {
    active();
    const { where, args } = listWhere(filters);
    const r = 'i.record_json', type = (field: string) => `json_type(${r},'$.payload.${field}')`, value = (field: string) => `json_extract(${r},'$.payload.${field}')`;
    const text = (field: string) => `CASE WHEN ${type(field)}='text' THEN ${value(field)} END`;
    // Boolean(payload.generationOrigin) as JavaScript reads it.
    const origin = `CASE ${type('generationOrigin')} WHEN 'object' THEN 1 WHEN 'array' THEN 1 WHEN 'true' THEN 1 WHEN 'text' THEN ${value('generationOrigin')}<>'' WHEN 'integer' THEN ${value('generationOrigin')}<>0 WHEN 'real' THEN ${value('generationOrigin')}<>0 ELSE 0 END`;
    const rows = db.prepare(`SELECT i.kind,i.id,i.revision,i.name,i.archived,i.created_at,
      CASE WHEN i.kind='history' THEN ${origin} ELSE 0 END AS has_origin,
      CASE WHEN i.kind='history' THEN coalesce(${text('generationOrigin.mode')},${text('feature')}) END AS origin_mode,
      CASE WHEN i.kind='history' THEN ${text('queueOrigin.batchId')} END AS batch_id,
      CASE WHEN i.kind='history' THEN ${text('model')} END AS model,
      CASE WHEN i.kind='history' THEN coalesce(${type('model')},'null') END AS model_type,
      CASE WHEN i.kind='history' THEN ${text('params.model')} END AS params_model,
      CASE WHEN i.kind='history' THEN ${type('params.positivePrompt')}='text' AND ${value('params.positivePrompt')}='upscale' ELSE 0 END AS upscale
      FROM items i${where}${listOrder(filters)}`).all(...args) as any[];
    return rows.map(row => ({
      kind: row.kind as LibraryKind, id: String(row.id), revision: Number(row.revision), name: String(row.name), archived: Number(row.archived) === 1,
      createdAt: String(row.created_at),
      hasOrigin: Number(row.has_origin) === 1, originMode: row.origin_mode === null ? null : String(row.origin_mode), batchId: row.batch_id === null ? null : String(row.batch_id),
      // payload.model when it is text; a missing or null payload.model falls back to params.model (payload.model ?? params.model).
      model: row.model === null ? null : String(row.model),
      paramsModel: row.model_type === 'null' && row.params_model !== null ? String(row.params_model) : null,
      upscalePrompt: Number(row.upscale) === 1,
    }));
  }
  /** The current records of the named items, in the order given; items that are gone are left out. */
  function getMany(keys: ReadonlyArray<{ kind: LibraryKind; id: string }>): LibraryItem[] {
    active();
    if (keys.length > 500) fail('invalid_argument', 'At most 500 items are read at once.');
    const statement = db.prepare('SELECT record_json FROM items WHERE kind=? AND id=?');
    const items: LibraryItem[] = [];
    for (const key of keys) { const row = statement.get(kindOf(key.kind), identity(key.id)); if (row) items.push(decode(row)!); }
    return items;
  }
  function checkedTagSources(raw?:HistoryTagSource[]):HistoryTagSource[]{
    const sources=raw??HISTORY_TAG_SOURCES;
    if(!Array.isArray(sources)||!sources.length||sources.length>4||sources.some(source=>!HISTORY_TAG_SOURCES.includes(source)))fail('invalid_argument','Invalid history tag sources.');
    return [...new Set(sources)];
  }
  function normalizedTagFilter(raw:string[]):string[]{
    if(!Array.isArray(raw)||raw.length>30||raw.some(tag=>typeof tag!=='string'||tag.length>256))fail('invalid_argument','Invalid history tag filter.');
    const tags=raw.map(normalizeHistoryTag);if(tags.some(tag=>!tag))fail('invalid_argument','History tags cannot contain only whitespace or weight wrappers.');return [...new Set(tags)];
  }
  function projectHistoryTags(item:LibraryItem){
    db.prepare('DELETE FROM history_tags WHERE history_id=?').run(item.id);
    const insert=db.prepare('INSERT INTO history_tags VALUES(?,?,?,?)');
    for(const tag of extractHistoryTags(item.payload).tags)insert.run(item.id,tag.tag,tag.source,tag.characterIndex??-1);
  }
  function historyTagsReady():boolean{active();return !!db.prepare('SELECT 1 FROM metadata WHERE key=?').get('history-tags-v1');}
  /** Startup worker only. A transaction makes interruption safely repeatable. */
  function rebuildHistoryTags(){
    active();if(historyTagsReady())return {rebuilt:false};
    transaction(()=>{changedKinds(['history']);db.exec('DELETE FROM history_tags');for(const row of db.prepare("SELECT record_json FROM items WHERE kind='history'").iterate())projectHistoryTags(decode(row)!);db.prepare('INSERT INTO metadata VALUES(?,?)').run('history-tags-v1','true');});
    return {rebuilt:true};
  }
  function historyTagMatches(ids:string[],rawTags:string[],rawSources?:HistoryTagSource[],query?:string):Map<string,HistoryTag[]>{
    active();if(!ids.length)return new Map();
    if(ids.length>500)fail('invalid_argument','Too many history identities.');ids.forEach(id=>identity(id));
    const tags=normalizedTagFilter(rawTags),sources=checkedTagSources(rawSources);
    if(query!==undefined&&(typeof query!=='string'||query.length>1000))fail('invalid_argument','Invalid history tag query.');
    const tagQuery=normalizeHistoryTag(query??''),conditions:string[]=[],matchArgs:string[]=[];
    if(tags.length){conditions.push(`tag IN (${tags.map(()=>'?').join(',')})`);matchArgs.push(...tags);}
    if(tagQuery){conditions.push('instr(tag,?)>0');matchArgs.push(tagQuery);}
    if(!conditions.length)return new Map();
    const rows=db.prepare(`SELECT * FROM history_tags WHERE history_id IN (${ids.map(()=>'?').join(',')}) AND (${conditions.join(' OR ')}) AND source IN (${sources.map(()=>'?').join(',')}) ORDER BY history_id,tag,source,character_index`).all(...ids,...matchArgs,...sources);
    const found=new Map<string,HistoryTag[]>();
    for(const row of rows as any[]){const values=found.get(row.history_id)??[];values.push({tag:row.tag,source:row.source,...(row.character_index<0?{}:{characterIndex:row.character_index})});found.set(row.history_id,values);}
    return found;
  }
  function historyTagSuggestions(query='',limit=20){
    active();if(typeof query!=='string'||query.length>256||!Number.isSafeInteger(limit)||limit<1||limit>50)fail('invalid_argument','Invalid history tag suggestion query.');
    const normalized=normalizeHistoryTag(query);
    const rows=db.prepare(`SELECT t.tag,count(DISTINCT t.history_id) AS count,group_concat(DISTINCT t.source) AS sources FROM history_tags t JOIN items i ON i.kind='history' AND i.id=t.history_id WHERE i.archived=0 AND instr(t.tag,?)>0 GROUP BY t.tag ORDER BY count DESC,t.tag LIMIT ?`).all(normalized,limit);
    return rows.map((row:any)=>({tag:row.tag,sources:String(row.sources).split(',').sort() as HistoryTagSource[],count:Number(row.count)}));
  }
  function all(kind?: LibraryKind): LibraryItem[] {
    active(); if (kind !== undefined) kindOf(kind);
    return db.prepare(`SELECT record_json FROM items${kind ? ' WHERE kind=?' : ''} ORDER BY updated_at DESC,kind,id`).all(...(kind ? [kind] : [])).map(row => decode(row)!);
  }
  // History views (2026-11-01). The SQL filter reproduces the original JS
  // filter exactly: `date && item.date !== date`, and for groups `!groupId`,
  // `"__ungrouped"` => `!item.groupId` (missing, null, false, "" and 0), else
  // strict string equality. Rows keep the `all()` order; only rows the caller
  // needs are decoded.
  function historyView(filter: HistoryViewFilter): HistoryViewQuery {
    const view: HistoryViewQuery = { ungrouped: false };
    if (filter.date !== undefined && filter.date !== '') {
      if (typeof filter.date !== 'string') fail('invalid_argument', 'Invalid history date filter.');
      view.date = filter.date;
    }
    if (filter.groupId === '__ungrouped') view.ungrouped = true;
    else if (filter.groupId !== undefined && filter.groupId !== '') {
      if (typeof filter.groupId !== 'string') fail('invalid_argument', 'Invalid history group filter.');
      view.groupId = filter.groupId;
    }
    return view;
  }
  function historyWhere(view: HistoryViewQuery): { sql: string; args: string[] } {
    const clauses = ["kind='history'", 'archived=0'], args: string[] = [];
    if (view.date !== undefined) { clauses.push(`${HISTORY_DATE_TYPE_SQL}='text'`, `${HISTORY_DATE_VALUE_SQL}=?`); args.push(view.date); }
    if (view.ungrouped) clauses.push(HISTORY_UNGROUPED_SQL);
    else if (view.groupId !== undefined) { clauses.push(`${HISTORY_GROUP_TYPE_SQL}='text'`, `${HISTORY_GROUP_VALUE_SQL}=?`); args.push(view.groupId); }
    return { sql: clauses.join(' AND '), args };
  }
  /**
   * Answer a history view from the in-memory index (history-view-index.ts) in
   * one read transaction, so its token, any re-read rows and the records
   * fetched for the answer share one snapshot. Inside a transaction of this
   * connection (uncommitted or pinned data), on a read-only connection (no
   * commit announcements) and whenever the index cannot answer, the SQL view
   * answers instead.
   */
  function indexedHistory<T>(work: (index: HistoryViewIndex) => T, sql: () => T): T {
    if (options.readOnly || transactionDepth || readTransactionDepth) return sql();
    db.exec('BEGIN DEFERRED'); readTransactionDepth++;
    try {
      const result = historyIndex.sync() ? work(historyIndex) : sql();
      db.exec('COMMIT');
      return result;
    } catch (error) { try { db.exec('ROLLBACK'); } catch { /* already ended */ } throw error; }
    finally { readTransactionDepth--; }
  }
  /** Unarchived history matching the view, decoded, in `all('history')` order. */
  function historyItems(filter: HistoryViewFilter = {}): LibraryItem[] {
    active(); const where = historyWhere(historyView(filter));
    return db.prepare(`SELECT record_json FROM items WHERE ${where.sql} ORDER BY updated_at DESC,kind,id`).all(...where.args).map(row => decode(row)!);
  }
  /** Identities of the same view in the same order, without decoding any record. */
  function historyOrder(filter: HistoryViewFilter = {}): string[] {
    active(); const view = historyView(filter);
    return indexedHistory(index => index.order(view), () => sqlHistoryOrder(view));
  }
  function sqlHistoryOrder(view: HistoryViewQuery): string[] {
    const where = historyWhere(view);
    return db.prepare(`SELECT id FROM items WHERE ${where.sql} ORDER BY updated_at DESC,kind,id`).all(...where.args).map((row: any) => String(row.id));
  }
  /** Distinct `String(payload.date)` of unarchived history, sorted descending like the original list. Only non-text dates are decoded. */
  function historyDates(): string[] {
    active();
    return indexedHistory(index => index.dates(), sqlHistoryDates);
  }
  function sqlHistoryDates(): string[] {
    const dates = new Set<string>(); let other = false;
    for (const row of db.prepare(`SELECT DISTINCT ${HISTORY_DATE_TYPE_SQL} AS type,${HISTORY_DATE_VALUE_SQL} AS date FROM items WHERE kind='history' AND archived=0`).all() as any[]) {
      if (row.type === 'text') dates.add(String(row.date)); else other = true;
    }
    if (other) for (const row of db.prepare(`SELECT record_json FROM items WHERE kind='history' AND archived=0 AND ${HISTORY_DATE_TYPE_SQL} IS NOT 'text'`).all()) dates.add(String(decode(row)!.payload.date));
    return [...dates].sort().reverse();
  }
  /** Current state of named history items for one view: missing ids are absent; only visible rows are decoded. */
  function historyEntries(ids: readonly string[], filter: HistoryViewFilter = {}): Array<{ id: string; archived: boolean; visible: boolean; item?: LibraryItem }> {
    active();
    if (!Array.isArray(ids) || ids.length > LIBRARY_CHANGE_ID_LIMIT) fail('invalid_argument', 'Too many history identities.');
    // An identity the repository could never have stored is simply missing.
    const wanted = [...new Set(ids.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 500 && !/[\x00-\x1f]/.test(id)))];
    if (!wanted.length) return [];
    const view = historyView(filter);
    return indexedHistory(index => {
      // The index decides presence, archive state and view membership; only visible records are read.
      const entries = index.entries(wanted, view), visible = entries.filter(entry => entry.visible), records = new Map<string, LibraryItem>();
      if (visible.length) for (const row of db.prepare(`SELECT CAST(id AS BLOB) AS id_key,record_json FROM items WHERE kind='history' AND id IN (${visible.map(() => '?').join(',')})`).all(...visible.map(entry => entry.bind)) as any[]) records.set(bytesKey(row.id_key), decode(row)!);
      if (visible.some(entry => !records.has(entry.key))) { historyIndex.invalidate(); return sqlHistoryEntries(wanted, view); }
      return entries.map(entry => ({ id: entry.id, archived: entry.archived, visible: entry.visible, ...(entry.visible ? { item: records.get(entry.key)! } : {}) }));
    }, () => sqlHistoryEntries(wanted, view));
  }
  function sqlHistoryEntries(wanted: string[], view: HistoryViewQuery): Array<{ id: string; archived: boolean; visible: boolean; item?: LibraryItem }> {
    const where = historyWhere(view);
    return db.prepare(`SELECT id,archived,CASE WHEN ${where.sql} THEN record_json END AS record_json FROM items WHERE kind='history' AND id IN (${wanted.map(() => '?').join(',')})`).all(...where.args, ...wanted)
      .map((row: any) => ({ id: String(row.id), archived: Number(row.archived) !== 0, visible: row.record_json !== null, ...(row.record_json !== null ? { item: decode(row)! } : {}) }));
  }
  function readVersions(kind: LibraryKind,id: string): LibraryItem[] { active();kindOf(kind);identity(id);return db.prepare('SELECT record_json FROM versions WHERE kind=? AND id=? ORDER BY revision').all(kind,id).map(row=>decode(row)!); }
  function project(item: LibraryItem) {
    const { kind,id,revision,payload } = item;
    const links: Array<Omit<LibraryRelation,'kind'|'id'|'revision'|'ordinal'>> = [];
    for (const component of Array.isArray(payload.components) ? payload.components : []) if (typeof component.entryId === 'string') {
      const targetKind = (['tag','combo','note'] as const).find(candidate => get(candidate,component.entryId));
      links.push({ ...(targetKind ? {targetKind} : {}),targetId:component.entryId,...(Number.isSafeInteger(component.entryRevision)?{targetRevision:component.entryRevision}:{}),payload:{...component,role:'component'} });
    }
    for (const link of Array.isArray(payload.links) ? payload.links : []) if (link && typeof link === 'object') {
      const targets = [
        ...(typeof link.studyId==='string'?[{targetKind:'study' as const,targetId:link.studyId}]:[]),
        ...(typeof link.batchId==='string'?[{targetId:link.batchId}]:[]),
      ];
      for(const target of targets.length?targets:[{}])links.push({...target,payload:clone(link)});
    }
    if (kind==='history' && payload.generationOrigin && typeof payload.generationOrigin==='object') links.push({...(typeof payload.generationOrigin.jobId==='string'?{targetId:payload.generationOrigin.jobId}:{}),payload:{...payload.generationOrigin,role:'generation'}});
    if (kind==='artist_favorite' && typeof payload.image?.id==='string') links.push({targetKind:'history',targetId:payload.image.id,payload:{role:'favorite-image',historyId:payload.image.id}});
    setRelations(kind,id,revision,links);

    const namespaces:Partial<Record<LibraryKind,string>>={tag:'material',combo:'material',note:'material',history:'history',style_preset:'style',positive_preset:'positive',prompt_chunk:'chunk',reference_preset:'reference',artist_favorite:'artist-favorites'};
    const namespace=namespaces[kind],group=kind==='history'?payload.groupId:kind==='artist_favorite'?payload.collection:payload.group;
    const key=`managed-membership:${kind}:${id}`,row:any=db.prepare('SELECT value_json FROM metadata WHERE key=?').get(key),old:LibraryMembership|null=row?JSON.parse(row.value_json):null;
    if(old && (old.namespace!==namespace||old.collectionId!==group))setMembership(old,false);
    if(namespace&&typeof group==='string'&&group&&group!=='__ungrouped'){
      if(!collections(namespace).some(value=>value.id===group))putCollection({namespace,id:group,name:group,payload:{id:group,name:group}});
      const membership={namespace,collectionId:group,kind,id};setMembership(membership);
      db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run(key,json(membership));
    }else db.prepare('DELETE FROM metadata WHERE key=?').run(key);

    const images = imagesForItem(item);
    const assetKey=`managed-assets:${kind}:${id}`,assetRow:any=db.prepare('SELECT value_json FROM metadata WHERE key=?').get(assetKey),previousRoles:string[]=assetRow?JSON.parse(assetRow.value_json):[];
    for(const role of previousRoles)if(!images.some(image=>image.role===role))db.prepare('DELETE FROM asset_links WHERE kind=? AND id=? AND role=?').run(kind,id,role);
    for(const {role,image}of images){
      const assetId=`path:${createHash('sha256').update(image.filePath).digest('hex')}`;
      putAsset({id:assetId,payload:{filePath:image.filePath,...(typeof image.fileUrl==='string'?{fileUrl:image.fileUrl}:{}),sha256:typeof image.sha256==='string'?image.sha256:null,...(Number.isFinite(image.width)?{width:image.width}:{}),...(Number.isFinite(image.height)?{height:image.height}:{}),...(Number.isFinite(image.byteLength)?{byteLength:image.byteLength}:{}),...(typeof image.mimeType==='string'?{mimeType:image.mimeType}:{}),availability:'unknown'}});
      linkAsset({kind,id,role,assetId});
    }
    db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run(assetKey,json(images.map(image=>image.role)));
  }
  /** Only file identities actually recorded in this version are projected. */
  function imagesForItem(item: LibraryItem) {
    const { kind, id, payload } = item;
    const images:Array<{role:string;image:LibraryPayload}>=[];
    if(typeof payload.filePath==='string')images.push({role:'original',image:payload});
    if(kind==='artist_favorite'&&typeof payload.image?.filePath==='string')images.push({role:'favorite-image',image:payload.image});
    for(const [index,image]of(Array.isArray(payload.images)?payload.images:[]).entries())if(image&&typeof image==='object'&&typeof image.filePath==='string')images.push({role:`image:${index}`,image});
    for(const [index,image]of(Array.isArray(payload.previewImages)?payload.previewImages:[]).entries())if(image&&typeof image==='object'&&typeof image.filePath==='string')images.push({role:`preview:${index}`,image});
    if(kind==='study'&&options.libraryDirectory&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)){
      const study=payload.study,extension:Record<string,string>={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'};
      if(study&&extension[study.mimeType]){
        const folder=path.join(path.resolve(options.libraryDirectory),'studies',id);
        images.push({role:'original',image:{...study,filePath:path.join(folder,`original.${extension[study.mimeType]}`)}});
        images.push({role:'preview',image:{filePath:path.join(folder,'preview.webp'),sha256:payload.previewSha256,byteLength:payload.previewByteLength,mimeType:'image/webp'}});
      }
    }
    // Covers have an independent revision. Old bodies without a recorded
    // cover do not acquire today's cover merely because it is available.
    if(payload.cover && options.libraryDirectory && /^[a-f0-9]{64}$/.test(payload.cover.sha256)) images.push({role:'cover',image:{...payload.cover,filePath:path.join(options.libraryDirectory,'covers',`${payload.cover.sha256}.webp`)}});
    return images;
  }
  function versionAssets(item: LibraryItem): LibraryItemAsset[] {
    return imagesForItem(item).map(({role,image})=>({id:`path:${createHash('sha256').update(image.filePath).digest('hex')}`,role,payload:{
      filePath:image.filePath, ...(typeof image.fileUrl==='string'?{fileUrl:image.fileUrl}:{}),
      ...(typeof image.sha256==='string'?{sha256:image.sha256}:{}), ...(typeof image.mimeType==='string'?{mimeType:image.mimeType}:{}),
      ...(Number.isFinite(image.width)?{width:image.width}:{}), ...(Number.isFinite(image.height)?{height:image.height}:{}),
      ...(Number.isFinite(image.byteLength)?{byteLength:image.byteLength}:{}), availability:'unknown',
    }}));
  }
  function itemAssets(kind: LibraryKind,id: string): LibraryItemAsset[] {
    active(); kindOf(kind); identity(id);
    return db.prepare('SELECT a.id,a.payload_json,l.role FROM asset_links l JOIN assets a ON a.id=l.asset_id WHERE l.kind=? AND l.id=? ORDER BY l.role').all(kind,id).map((row:any)=>({id:row.id,role:row.role,payload:JSON.parse(row.payload_json)}));
  }
  /** One bounded SQL query for the page; no per-card read or image decoding. */
  function previewAssets(items: Array<Pick<LibraryItem,'kind'|'id'>>): Map<string,LibraryItemAsset> {
    active(); if (!items.length) return new Map();
    if (items.length>500) fail('invalid_argument','Preview page exceeds 500 items.');
    const args=items.flatMap(item=>[kindOf(item.kind),identity(item.id)]);
    const rows=db.prepare(`WITH selected(kind,id) AS (VALUES ${items.map(()=>'(?,?)').join(',')}), ranked AS (
      SELECT l.kind,l.id,l.role,a.id AS asset_id,a.payload_json,row_number() OVER (PARTITION BY l.kind,l.id ORDER BY
        CASE WHEN l.role='cover' THEN 0 WHEN l.role='preview' THEN 1 WHEN l.role LIKE 'preview:%' THEN 2 WHEN l.role='favorite-image' THEN 3 WHEN l.role='original' THEN 4 ELSE 5 END,l.role,a.id) AS rank
      FROM selected s JOIN asset_links l ON l.kind=s.kind AND l.id=s.id JOIN assets a ON a.id=l.asset_id
      WHERE json_type(a.payload_json,'$.filePath')='text')
      SELECT * FROM ranked WHERE rank=1`).all(...args);
    return new Map(rows.map((row:any)=>[JSON.stringify([row.kind,row.id]),{id:row.asset_id,role:row.role,payload:JSON.parse(row.payload_json)}]));
  }
  function rebuildProjections() { return transaction(() => { for(const row of db.prepare('SELECT record_json FROM versions ORDER BY kind,id,revision').all())project(decode(row)!); }, { unknownChange: true }); }
  function remove(kind: LibraryKind,id: string,options: {expectedRevision?:number} = {}): LibraryItem | null {
    return transaction(()=>{ const item=get(kind,id); if (!item) return null; changedItem(item.kind,item.id); if(options.expectedRevision!==undefined&&item.revision!==version(options.expectedRevision)) fail('library_conflict','The library item changed.'); db.prepare('DELETE FROM items_fts WHERE kind=? AND id=?').run(kind,id);db.prepare('DELETE FROM relations WHERE kind=? AND id=?').run(kind,id);db.prepare('DELETE FROM versions WHERE kind=? AND id=?').run(kind,id);db.prepare('DELETE FROM items WHERE kind=? AND id=?').run(kind,id);if(kind==='history')db.prepare('DELETE FROM history_tags WHERE history_id=?').run(id);for(const prefix of ['managed-membership','managed-assets'])db.prepare('DELETE FROM metadata WHERE key=?').run(`${prefix}:${kind}:${id}`);return item; });
  }
  function putCollection(collection: LibraryCollection): LibraryCollection { identity(collection.namespace);identity(collection.id);object(collection.payload);if(typeof collection.name!=='string')fail('invalid_argument','Invalid collection name.'); return transaction(()=>{changedCollection(collection.namespace);db.prepare('INSERT INTO collections VALUES(?,?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET name=excluded.name,payload_json=excluded.payload_json').run(collection.namespace,collection.id,collection.name,json(collection.payload));return clone(collection);}); }
  function collections(namespace?: string): LibraryCollection[] { active();if(namespace!==undefined)identity(namespace); return db.prepare(`SELECT * FROM collections${namespace===undefined?'':' WHERE namespace=?'} ORDER BY namespace,name,id`).all(...(namespace===undefined?[]:[namespace])).map((r:any)=>({namespace:r.namespace,id:r.id,name:r.name,payload:JSON.parse(r.payload_json)})); }
  function deleteCollection(namespace:string,id:string) { identity(namespace);identity(id);return transaction(()=>{changedCollection(namespace);db.prepare('DELETE FROM collections WHERE namespace=? AND id=?').run(namespace,id);}); }
  function setMembership(value: LibraryMembership, member=true) { identity(value.namespace);identity(value.collectionId);kindOf(value.kind);identity(value.id);return transaction(()=>{changedItem(value.kind,value.id);if(member)db.prepare('INSERT OR IGNORE INTO memberships VALUES(?,?,?,?)').run(value.namespace,value.collectionId,value.kind,value.id);else db.prepare('DELETE FROM memberships WHERE namespace=? AND collection_id=? AND kind=? AND id=?').run(value.namespace,value.collectionId,value.kind,value.id);}); }
  function memberships(kind?:LibraryKind,id?:string):LibraryMembership[] {active();if(kind!==undefined)kindOf(kind);if(id!==undefined)identity(id);const clauses:string[]=[],args:string[]=[];if(kind){clauses.push('kind=?');args.push(kind);}if(id){clauses.push('id=?');args.push(id);}return db.prepare(`SELECT * FROM memberships${clauses.length?' WHERE '+clauses.join(' AND '):''} ORDER BY namespace,collection_id,kind,id`).all(...args).map((r:any)=>({namespace:r.namespace,collectionId:r.collection_id,kind:r.kind,id:r.id}));}
  function setRelations(kind:LibraryKind,id:string,revision:number,values:Array<Omit<LibraryRelation,'kind'|'id'|'revision'|'ordinal'>>) {kindOf(kind);identity(id);version(revision);return transaction(()=>{changedItem(kind,id);if(!get(kind,id,revision))fail('library_not_found','The source revision does not exist.');db.prepare('DELETE FROM relations WHERE kind=? AND id=? AND revision=?').run(kind,id,revision);values.forEach((value,ordinal)=>{object(value.payload);if(value.targetKind)kindOf(value.targetKind);if(value.targetId)identity(value.targetId);if(value.targetRevision!==undefined)version(value.targetRevision);db.prepare('INSERT INTO relations VALUES(?,?,?,?,?,?,?,?)').run(kind,id,revision,ordinal,value.targetKind??null,value.targetId??null,value.targetRevision??null,json(value.payload));});});}
  function relations(filter:{kind?:LibraryKind;id?:string;revision?:number;targetKind?:LibraryKind;targetId?:string}={}):LibraryRelation[]{active();const clauses:string[]=[],args:Array<string|number>=[];for(const [key,column]of[['kind','kind'],['id','id'],['revision','revision'],['targetKind','target_kind'],['targetId','target_id']]as const){const value=filter[key];if(value!==undefined){clauses.push(`${column}=?`);args.push(value);}}return db.prepare(`SELECT * FROM relations${clauses.length?' WHERE '+clauses.join(' AND '):''} ORDER BY kind,id,revision,ordinal`).all(...args).map((r:any)=>({kind:r.kind,id:r.id,revision:r.revision,ordinal:r.ordinal,...(r.target_kind?{targetKind:r.target_kind}:{}),...(r.target_id?{targetId:r.target_id}:{}),...(r.target_revision!==null?{targetRevision:r.target_revision}:{}),payload:JSON.parse(r.payload_json)}));}
  function putAsset(asset:LibraryAsset){identity(asset.id);object(asset.payload);return transaction(()=>{
    const encoded=json(asset.payload);
    // An asset belongs to the items that link it. Rewriting identical bytes changes nothing they show.
    if(pendingChange&&!pendingChange.unknown){const previous:any=db.prepare('SELECT payload_json FROM assets WHERE id=?').get(asset.id);if(!previous||previous.payload_json!==encoded)for(const owner of db.prepare('SELECT kind,id FROM asset_links WHERE asset_id=?').all(asset.id) as any[])changedItem(owner.kind,owner.id);}
    db.prepare('INSERT INTO assets VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json').run(asset.id,encoded);return clone(asset);});}
  function assets():LibraryAsset[]{active();return db.prepare('SELECT * FROM assets ORDER BY id').all().map((r:any)=>({id:r.id,payload:JSON.parse(r.payload_json)}));}
  function linkAsset(link:LibraryAssetLink){kindOf(link.kind);identity(link.id);identity(link.role);identity(link.assetId);return transaction(()=>{changedItem(link.kind,link.id);db.prepare('INSERT INTO asset_links VALUES(?,?,?,?) ON CONFLICT(kind,id,role) DO UPDATE SET asset_id=excluded.asset_id').run(link.kind,link.id,link.role,link.assetId);});}
  function assetLinks(kind?:LibraryKind,id?:string):LibraryAssetLink[]{active();const clauses:string[]=[],args:string[]=[];if(kind){kindOf(kind);clauses.push('kind=?');args.push(kind);}if(id){identity(id);clauses.push('id=?');args.push(id);}return db.prepare(`SELECT * FROM asset_links${clauses.length?' WHERE '+clauses.join(' AND '):''} ORDER BY kind,id,role`).all(...args).map((r:any)=>({kind:r.kind,id:r.id,role:r.role,assetId:r.asset_id}));}
  function getCover(kind:LibraryKind,id:string):LibraryCover{active();kindOf(kind);identity(id);const r:any=db.prepare('SELECT * FROM covers WHERE kind=? AND id=?').get(kind,id);return {kind,id,coverRevision:r?.revision??0,cover:r?.payload_json?JSON.parse(r.payload_json):null};}
  function setCover(kind:LibraryKind,id:string,cover:LibraryPayload|null,rawOptions:{expectedRevision?:number;coverRevision?:number}|number={}):LibraryCover{return transaction(()=>{changedItem(kind,id);const coverOptions=typeof rawOptions==='number'?{expectedRevision:rawOptions}:rawOptions;if(!get(kind,id))fail('library_not_found','Cover owner does not exist.');const old=getCover(kind,id);if(coverOptions.expectedRevision!==undefined&&old.coverRevision!==version(coverOptions.expectedRevision,0))fail('library_conflict','Cover changed.');const next=coverOptions.coverRevision===undefined?old.coverRevision+1:version(coverOptions.coverRevision,0);if(next<old.coverRevision||(next===old.coverRevision&&json(cover)!==json(old.cover)))fail('library_conflict','Cover revision is immutable.');if(cover!==null)object(cover);db.prepare('INSERT INTO covers VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,payload_json=excluded.payload_json').run(kind,id,next,cover===null?null:json(cover));
    if(cover&&options.libraryDirectory&&typeof cover.sha256==='string'&&/^[a-f0-9]{64}$/.test(cover.sha256)){
      const filePath=path.join(path.resolve(options.libraryDirectory),'covers',`${cover.sha256}.webp`),assetId=`path:${createHash('sha256').update(filePath).digest('hex')}`;
      putAsset({id:assetId,payload:{...cover,filePath,availability:'unknown'}});linkAsset({kind,id,role:'cover',assetId});
    }else db.prepare('DELETE FROM asset_links WHERE kind=? AND id=? AND role=?').run(kind,id,'cover');
    return getCover(kind,id);});}
  // ------------------------------------------------------------------ Recently Deleted (library trash)
  // Data primitives only; library-trash.ts owns the policy (references, files, retention, recovery). A deleted item's
  // rows leave the live tables byte for byte: its versions go to trash_versions, everything else it owned (search
  // text, relations, memberships, asset links, cover, managed metadata, the group collections it belonged to) to the
  // entry's data. Restoring writes the same rows back, so revisions, versions and relations are exactly as before.
  function ensureTrash() { if (!trashReady) { db.exec(TRASH_DDL); trashReady = true; } }
  const trashRow = (row: any, withData = true): TrashEntry => ({ trashId: String(row.id), kind: row.kind, itemId: String(row.item_id), revision: row.revision === null || row.revision === undefined ? null : Number(row.revision), name: String(row.name),
    deletedMs: Number(row.deleted_ms), expiresMs: Number(row.expires_ms), state: row.state, summary: JSON.parse(String(row.summary_json)), data: withData ? JSON.parse(String(row.data_json)) : {} });
  const trashKind = (value: unknown): TrashEntryKind => value === 'collection' ? 'collection' : kindOf(value);
  const trashFileRow = (row: any): TrashFile => ({ trashId: String(row.trash_id), ordinal: Number(row.ordinal), role: String(row.role), path: String(row.path), trashPath: row.trash_path === null ? null : String(row.trash_path), state: row.state, byteLength: row.byte_length === null ? null : Number(row.byte_length), realDirectory: row.real_dir === null || row.real_dir === undefined ? null : String(row.real_dir), sha256: typeof row.sha256 === 'string' ? row.sha256 : null });
  function trashEntry(trashId: string): TrashEntry | null {
    active(); identity(trashId, 'trash id'); if (!trashReady) return null;
    const row = db.prepare('SELECT * FROM trash_entries WHERE id=?').get(trashId); return row ? trashRow(row) : null;
  }
  function trashEntryFor(kind: TrashEntryKind, itemId: string): TrashEntry | null {
    active(); trashKind(kind); identity(itemId); if (!trashReady) return null;
    const row = db.prepare('SELECT * FROM trash_entries WHERE kind=? AND item_id=?').get(kind, itemId); return row ? trashRow(row) : null;
  }
  /** Newest deletion first; entries carry their summary, not their captured rows. */
  function listTrash(filters: { query?: string; kinds?: TrashEntryKind[]; offset?: number; limit?: number } = {}) {
    active();
    const offset = version(filters.offset ?? 0, 0), limit = version(filters.limit ?? 30);
    if (limit > 500) fail('invalid_argument', 'Recently Deleted pages are limited to 500 entries.');
    if (!trashReady) return { entries: [] as TrashEntry[], total: 0, offset, limit, hasMore: false };
    const clauses: string[] = [], args: Array<string | number> = [];
    if (filters.kinds?.length) { filters.kinds.forEach(trashKind); clauses.push(`kind IN (${filters.kinds.map(() => '?').join(',')})`); args.push(...filters.kinds); }
    const query = (filters.query ?? '').trim().normalize('NFC').toLowerCase();
    if (query.length > 1000) fail('invalid_argument', 'Recently Deleted search is too long.');
    if (query) { clauses.push('(instr(lower(name),?)>0 OR instr(lower(item_id),?)>0)'); args.push(query, query); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const total = Number((db.prepare(`SELECT count(*) AS count FROM trash_entries${where}`).get(...args) as any)?.count);
    const entries = db.prepare(`SELECT id,kind,item_id,revision,name,deleted_ms,expires_ms,state,summary_json FROM trash_entries${where} ORDER BY deleted_ms DESC,id LIMIT ? OFFSET ?`).all(...args, limit, offset).map(row => trashRow(row, false));
    return { entries, total, offset, limit, hasMore: offset + entries.length < total };
  }
  function trashFiles(trashId: string): TrashFile[] { active(); identity(trashId, 'trash id'); return trashReady ? db.prepare('SELECT * FROM trash_files WHERE trash_id=? ORDER BY ordinal').all(trashId).map(trashFileRow) : []; }
  function trashVersions(trashId: string): LibraryItem[] { active(); identity(trashId, 'trash id'); return trashReady ? db.prepare('SELECT record_json FROM trash_versions WHERE trash_id=? ORDER BY revision').all(trashId).map(row => decode(row)!) : []; }
  /** Entry ids whose retention ended at or before nowMs, oldest expiry first. */
  function expiredTrash(nowMs: number, limit = 500): string[] {
    active(); if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(limit) || limit < 1) fail('invalid_argument', 'Invalid Recently Deleted expiry query.');
    return trashReady ? db.prepare('SELECT id FROM trash_entries WHERE expires_ms<=? ORDER BY expires_ms,id LIMIT ?').all(nowMs, limit).map((row: any) => String(row.id)) : [];
  }
  function allTrashIds(): string[] { active(); return trashReady ? db.prepare('SELECT id FROM trash_entries ORDER BY deleted_ms,id').all().map((row: any) => String(row.id)) : []; }
  /** Identities of one kind in Recently Deleted (what a stale full-list writer must not recreate). */
  function trashedIds(kind: LibraryKind): Set<string> { active(); kindOf(kind); return new Set(trashReady ? db.prepare('SELECT item_id FROM trash_entries WHERE kind=?').all(kind).map((row: any) => String(row.item_id)) : []); }
  function insertTrash(entry: TrashEntry, files: TrashFile[]) {
    if (entry.state !== 'moving' && entry.state !== 'trashed') fail('invalid_argument', 'Invalid Recently Deleted state.');
    if (!Number.isSafeInteger(entry.deletedMs) || !Number.isSafeInteger(entry.expiresMs)) fail('invalid_argument', 'Invalid Recently Deleted time.');
    db.prepare('INSERT INTO trash_entries VALUES(?,?,?,?,?,?,?,?,?,?)').run(identity(entry.trashId, 'trash id'), entry.kind, identity(entry.itemId), entry.revision, entry.name, entry.deletedMs, entry.expiresMs, entry.state, json(entry.summary), json(entry.data));
    insertTrashFiles(entry.trashId, files);
  }
  function insertTrashFiles(trashId: string, files: TrashFile[]) {
    const insert = db.prepare('INSERT INTO trash_files VALUES(?,?,?,?,?,?,?,?,?,?)');
    for (const file of files) {
      if (!TRASH_FILE_STATES.includes(file.state) || typeof file.path !== 'string' || !path.isAbsolute(file.path)) fail('invalid_argument', 'Invalid Recently Deleted file.');
      if (file.sha256 != null && !/^[a-f0-9]{64}$/.test(file.sha256)) fail('invalid_argument', 'Invalid Recently Deleted file digest.');
      insert.run(trashId, file.ordinal, file.role, file.path, libraryPathKey(file.path), file.trashPath, file.state, file.byteLength, file.realDirectory ?? null, file.sha256 ?? null);
    }
  }
  /**
   * Moves one live item into Recently Deleted inside one write transaction: expectedRevision must be its current
   * revision. The entry's data gains `rows` (everything restoreTrashedItem writes back). Returns the deleted item.
   */
  function trashItem(kind: LibraryKind, id: string, expectedRevision: number, entry: Omit<TrashEntry, 'kind' | 'itemId' | 'revision'>, files: TrashFile[]): LibraryItem {
    kindOf(kind); identity(id); version(expectedRevision);
    return transaction(() => {
      ensureTrash();
      const item = get(kind, id);
      if (!item) return fail('library_not_found', 'The library item does not exist.', 'library.item_not_found');
      if (item.revision !== expectedRevision) fail('library_conflict', 'The library item changed; read its current revision.', 'library.item_revision_changed');
      if (db.prepare('SELECT 1 FROM trash_entries WHERE kind=? AND item_id=?').get(kind, id)) fail('library_conflict', 'This identity is already in Recently Deleted.', 'library.identity_in_trash');
      const own = [kind, id] as const;
      const itemRow: any = db.prepare('SELECT record_json,search_text FROM items WHERE kind=? AND id=?').get(...own);
      const versions = db.prepare('SELECT revision,record_json FROM versions WHERE kind=? AND id=? ORDER BY revision').all(...own) as any[];
      const memberships = db.prepare('SELECT namespace,collection_id FROM memberships WHERE kind=? AND id=? ORDER BY namespace,collection_id').all(...own) as any[];
      const rows = {
        searchText: String(itemRow.search_text),
        // The live row normally repeats the newest version; only a different one is kept separately.
        ...(versions.at(-1)?.record_json === itemRow.record_json ? {} : { itemRecordJson: String(itemRow.record_json) }),
        relations: db.prepare('SELECT revision,ordinal,target_kind,target_id,target_revision,payload_json FROM relations WHERE kind=? AND id=? ORDER BY revision,ordinal').all(...own),
        memberships,
        // The group collections (not user collections) it belonged to, so a restore can bring back a group removed meanwhile.
        groups: memberships.filter(value => value.namespace !== 'user').flatMap(value => db.prepare('SELECT namespace,id,name,payload_json FROM collections WHERE namespace=? AND id=?').all(value.namespace, value.collection_id)),
        assetLinks: db.prepare('SELECT role,asset_id FROM asset_links WHERE kind=? AND id=? ORDER BY role').all(...own),
        assets: db.prepare('SELECT DISTINCT a.id,a.payload_json FROM assets a JOIN asset_links l ON l.asset_id=a.id WHERE l.kind=? AND l.id=? ORDER BY a.id').all(...own),
        cover: db.prepare('SELECT revision,payload_json FROM covers WHERE kind=? AND id=?').get(...own) ?? null,
        metadata: ['managed-membership', 'managed-assets'].flatMap(prefix => db.prepare('SELECT key,value_json FROM metadata WHERE key=?').all(`${prefix}:${kind}:${id}`)),
      };
      remove(kind, id);
      // Its file descriptions go with it (a backup would otherwise report their moved files as missing); a description
      // another item still links stays. A restore writes them back.
      for (const asset of rows.assets as any[]) db.prepare('DELETE FROM assets WHERE id=? AND NOT EXISTS(SELECT 1 FROM asset_links WHERE asset_id=?)').run(asset.id, asset.id);
      insertTrash({ ...entry, kind, itemId: id, revision: item.revision, data: { ...entry.data, rows } }, files);
      const insert = db.prepare('INSERT INTO trash_versions VALUES(?,?,?)');
      for (const row of versions) insert.run(entry.trashId, row.revision, row.record_json);
      return item;
    });
  }
  /**
   * Writes a deleted item back exactly as it was and removes its entry. Group collections removed meanwhile are
   * recreated from the captured copy; a user collection that no longer exists is skipped, or, when it is itself in
   * Recently Deleted, the item is added to that collection's entry so restoring the collection brings it back.
   */
  function restoreTrashedItem(trashId: string) {
    identity(trashId, 'trash id');
    return transaction(() => {
      const entry = trashEntry(trashId);
      if (!entry || entry.kind === 'collection') return fail('library_not_found', 'This Recently Deleted entry does not exist.', 'trash.entry_missing');
      const kind = entry.kind, id = entry.itemId, rows = entry.data.rows;
      if (get(kind, id)) fail('library_conflict', 'A live item with this identity exists; delete or rename it before restoring.', 'trash.live_item_exists');
      changedItem(kind, id);
      const versions = db.prepare('SELECT revision,record_json FROM trash_versions WHERE trash_id=? ORDER BY revision').all(trashId) as any[];
      if (!versions.length || !rows) fail('library_corrupt', 'This Recently Deleted entry has no captured versions.');
      const insertVersion = db.prepare('INSERT INTO versions VALUES(?,?,?,?)');
      for (const row of versions) insertVersion.run(kind, id, row.revision, row.record_json);
      const encoded = rows.itemRecordJson ?? String(versions.at(-1).record_json), item = JSON.parse(encoded) as LibraryItem;
      db.prepare('INSERT INTO items VALUES(?,?,?,?,?,?,?,?,?,?)').run(kind, id, item.revision, item.name, item.archived ? 1 : 0, item.createdAt, item.updatedAt, item.source.namespace, encoded, rows.searchText);
      db.prepare('INSERT INTO items_fts(kind,id,search_text) VALUES(?,?,?)').run(kind, id, rows.searchText);
      const insertRelation = db.prepare('INSERT INTO relations VALUES(?,?,?,?,?,?,?,?)');
      for (const row of rows.relations ?? []) insertRelation.run(kind, id, row.revision, row.ordinal, row.target_kind, row.target_id, row.target_revision, row.payload_json);
      for (const row of rows.assets ?? []) db.prepare('INSERT OR IGNORE INTO assets VALUES(?,?)').run(row.id, row.payload_json);
      for (const row of rows.assetLinks ?? []) db.prepare('INSERT INTO asset_links VALUES(?,?,?,?)').run(kind, id, row.role, row.asset_id);
      if (rows.cover) db.prepare('INSERT INTO covers VALUES(?,?,?,?)').run(kind, id, rows.cover.revision, rows.cover.payload_json);
      for (const row of rows.metadata ?? []) db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run(row.key, row.value_json);
      const memberships = { restored: [] as string[], recreatedGroups: [] as string[], pending: [] as string[], skipped: [] as string[] };
      for (const row of rows.memberships ?? []) {
        const label = `${row.namespace}:${row.collection_id}`;
        if (!db.prepare('SELECT 1 FROM collections WHERE namespace=? AND id=?').get(row.namespace, row.collection_id)) {
          const group = (rows.groups ?? []).find((value: any) => value.namespace === row.namespace && value.id === row.collection_id);
          if (row.namespace !== 'user' && group) { putCollection({ namespace: group.namespace, id: group.id, name: group.name, payload: JSON.parse(group.payload_json) }); memberships.recreatedGroups.push(label); }
          else {
            const holder = trashEntryFor('collection', label);
            if (holder && Array.isArray(holder.data.members)) {
              if (!holder.data.members.some((member: any) => member.kind === kind && member.id === id)) db.prepare('UPDATE trash_entries SET data_json=? WHERE id=?').run(json({ ...holder.data, members: [...holder.data.members, { kind, id }] }), holder.trashId);
              memberships.pending.push(label);
            } else memberships.skipped.push(label);
            continue;
          }
        }
        setMembership({ namespace: row.namespace, collectionId: row.collection_id, kind, id });
        memberships.restored.push(label);
      }
      if (kind === 'history') projectHistoryTags(item);
      db.prepare('DELETE FROM trash_entries WHERE id=?').run(trashId);
      return { item: clone(item), memberships };
    });
  }
  /** Moves one collection (and its membership list) into Recently Deleted; its members stay where they are. */
  function trashCollection(namespace: string, collectionId: string, entry: Omit<TrashEntry, 'kind' | 'itemId' | 'revision' | 'name'>): { collection: LibraryCollection; members: Array<{ kind: LibraryKind; id: string }> } {
    identity(namespace); identity(collectionId);
    return transaction(() => {
      ensureTrash();
      const collection = collections(namespace).find(value => value.id === collectionId);
      if (!collection) return fail('library_not_found', 'This collection does not exist.', 'trash.collection_not_found');
      const itemId = `${namespace}:${collectionId}`;
      if (db.prepare('SELECT 1 FROM trash_entries WHERE kind=? AND item_id=?').get('collection', itemId)) fail('library_conflict', 'This collection is already in Recently Deleted.', 'trash.collection_already_deleted');
      const members = memberships().filter(value => value.namespace === namespace && value.collectionId === collectionId).map(value => ({ kind: value.kind, id: value.id }));
      for (const member of members) changedItem(member.kind, member.id);
      deleteCollection(namespace, collectionId);
      insertTrash({ ...entry, kind: 'collection', itemId, revision: null, name: collection.name, data: { ...entry.data, collection, members } }, []);
      return { collection, members };
    });
  }
  /** Recreates a deleted collection under its id (a taken user collection name gets a " (n)" suffix) with the members that are live again. */
  function restoreTrashedCollection(trashId: string) {
    identity(trashId, 'trash id');
    return transaction(() => {
      const entry = trashEntry(trashId);
      if (!entry || entry.kind !== 'collection') return fail('library_not_found', 'This Recently Deleted entry does not exist.', 'trash.entry_missing');
      const saved = entry.data.collection as LibraryCollection;
      if (collections(saved.namespace).some(value => value.id === saved.id)) fail('library_conflict', 'A collection with this identity exists.', 'trash.collection_identity_exists');
      const names = new Set(collections(saved.namespace).map(value => value.name));
      let name = saved.name;
      for (let index = 2; names.has(name); index++) name = `${saved.name} (${index})`;
      putCollection({ ...saved, name });
      const members = { restored: [] as Array<{ kind: LibraryKind; id: string }>, pending: [] as Array<{ kind: LibraryKind; id: string }>, skipped: [] as Array<{ kind: LibraryKind; id: string }> };
      for (const member of entry.data.members ?? []) {
        if (get(member.kind, member.id)) { setMembership({ namespace: saved.namespace, collectionId: saved.id, kind: member.kind, id: member.id }); members.restored.push(member); continue; }
        // A member in Recently Deleted rejoins when it is restored.
        const holder = trashEntryFor(member.kind, member.id);
        if (holder?.data.rows) {
          const memberRows = holder.data.rows;
          if (!(memberRows.memberships ?? []).some((row: any) => row.namespace === saved.namespace && row.collection_id === saved.id))
            db.prepare('UPDATE trash_entries SET data_json=? WHERE id=?').run(json({ ...holder.data, rows: { ...memberRows, memberships: [...(memberRows.memberships ?? []), { namespace: saved.namespace, collection_id: saved.id }] } }), holder.trashId);
          members.pending.push(member);
        } else members.skipped.push(member);
      }
      db.prepare('DELETE FROM trash_entries WHERE id=?').run(trashId);
      return { collection: { ...saved, name }, renamed: name !== saved.name, members };
    });
  }
  function updateTrashEntry(trashId: string, patch: { state?: TrashEntry['state']; summary?: LibraryPayload; data?: LibraryPayload }) {
    identity(trashId, 'trash id');
    return transaction(() => {
      const entry = trashEntry(trashId); if (!entry) return fail('library_not_found', 'This Recently Deleted entry does not exist.', 'trash.entry_missing');
      if (patch.state !== undefined && !['moving', 'trashed'].includes(patch.state)) fail('invalid_argument', 'Invalid Recently Deleted state.');
      if (entry.kind !== 'collection') changedItem(entry.kind, entry.itemId);
      db.prepare('UPDATE trash_entries SET state=?,summary_json=?,data_json=? WHERE id=?').run(patch.state ?? entry.state, json(patch.summary ?? entry.summary), json(patch.data ?? entry.data), trashId);
    });
  }
  function setTrashFile(trashId: string, ordinal: number, patch: { state?: TrashFileState; trashPath?: string | null; byteLength?: number | null; sha256?: string | null }) {
    identity(trashId, 'trash id'); if (patch.state !== undefined && !TRASH_FILE_STATES.includes(patch.state)) fail('invalid_argument', 'Invalid Recently Deleted file state.');
    if (patch.sha256 != null && !/^[a-f0-9]{64}$/.test(patch.sha256)) fail('invalid_argument', 'Invalid Recently Deleted file digest.');
    return transaction(() => {
      ensureTrash();
      const row: any = db.prepare('SELECT * FROM trash_files WHERE trash_id=? AND ordinal=?').get(trashId, ordinal);
      if (!row) fail('library_not_found', 'This Recently Deleted file does not exist.', 'trash.file_missing');
      const pick = <T,>(value: T | undefined, old: T) => value === undefined ? old : value;
      db.prepare('UPDATE trash_files SET state=?,trash_path=?,byte_length=?,sha256=? WHERE trash_id=? AND ordinal=?').run(pick(patch.state, row.state), pick(patch.trashPath, row.trash_path), pick(patch.byteLength, row.byte_length), pick(patch.sha256, row.sha256), trashId, ordinal);
    });
  }
  /**
   * A tag cover that a history deletion cleared, whose tag is itself in Recently Deleted when that history image is
   * restored: the tag's entry takes it over (it comes back when the tag is restored) and keeps its file.
   */
  function adoptClearedCover(trashId: string, cleared: LibraryPayload, blob: { path: string; sha256: string }) {
    identity(trashId, 'trash id');
    return transaction(() => {
      const entry = trashEntry(trashId);
      if (!entry || entry.kind !== 'tag') return false;
      const clearedCovers = Array.isArray(entry.data.clearedCovers) ? entry.data.clearedCovers : [];
      if (!clearedCovers.some((value: any) => value.id === cleared.id && value.clearedCoverRevision === cleared.clearedCoverRevision)) db.prepare('UPDATE trash_entries SET data_json=? WHERE id=?').run(json({ ...entry.data, clearedCovers: [...clearedCovers, cleared] }), trashId);
      const ordinal = Number((db.prepare('SELECT coalesce(max(ordinal),-1)+1 AS next FROM trash_files WHERE trash_id=?').get(trashId) as any).next);
      insertTrashFiles(trashId, [{ trashId, ordinal, role: `cleared-cover:${cleared.id}`, path: blob.path, trashPath: null, state: 'retained', byteLength: null, realDirectory: null, sha256: blob.sha256 }]);
      changedItem('tag', entry.itemId);
      return true;
    });
  }
  /** Removes entries for good (their versions and file rows go with them). Announces the identities they held. */
  function deleteTrashEntries(trashIds: string[]) {
    trashIds.forEach(trashId => identity(trashId, 'trash id'));
    return transaction(() => {
      const removed: TrashEntry[] = [];
      for (const trashId of trashIds) {
        const entry = trashEntry(trashId); if (!entry) continue;
        if (entry.kind !== 'collection') changedItem(entry.kind, entry.itemId);
        db.prepare('DELETE FROM trash_entries WHERE id=?').run(trashId); removed.push(entry);
      }
      return removed;
    });
  }
  /**
   * Who uses each named file: `item:<kind>:<id>` for every live item any of whose versions names it (an image path of
   * the record, a study's own folder or a tag cover digest), and `trash:<trashId>` for every Recently Deleted entry
   * that still names it in place. Paths are compared by libraryPathKey (resolved, NFC, case-folded where the file
   * system is case-insensitive) whatever the number of files: a few files find their candidate versions through a
   * case- and normalization-proof text prefilter, many through one pass; every candidate is decoded and compared by key.
   */
  function fileOwners(files: readonly string[]): Map<string, Set<string>> {
    active();
    const result = new Map<string, Set<string>>(files.map(file => [file, new Set<string>()]));
    if (!files.length) return result;
    const library = options.libraryDirectory ? path.resolve(options.libraryDirectory) : null;
    const wanted = new Map<string, string[]>();
    for (const file of files) { const key = libraryPathKey(file); wanted.set(key, [...(wanted.get(key) ?? []), file]); }
    const note = (file: unknown, owner: string) => { if (typeof file === 'string') for (const input of wanted.get(libraryPathKey(file)) ?? []) result.get(input)!.add(owner); };
    const inFolder = (file: string, folder: string) => libraryPathKey(path.dirname(path.resolve(file))) === libraryPathKey(folder);
    const noteVersions = (rows: Iterable<unknown>) => { for (const row of rows) { const item = decode(row)!; for (const { image } of imagesForItem(item)) note(image.filePath, `item:${item.kind}:${item.id}`); } };
    // Study files follow from the study's identity (its own folder), never from text in a record.
    if (library) for (const file of files) {
      const folder = path.dirname(path.resolve(file)), id = path.basename(folder).toLowerCase();
      if (inFolder(folder, path.join(library, 'studies')) && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) && get('study', id)) result.get(file)!.add(`item:study:${id}`);
    }
    const FILE_RECORDS = `kind<>'study' AND (instr(record_json,'"filePath"')>0 OR instr(record_json,'"cover":{')>0)`;
    if (files.length <= 8) {
      for (const file of files) {
        const resolved = path.resolve(file);
        const needles = [...new Set([...asciiRuns(path.basename(resolved)), ...asciiRuns(path.basename(path.dirname(resolved)))])];
        noteVersions(db.prepare(`SELECT record_json FROM versions WHERE ${FILE_RECORDS}${needles.map(() => ' AND instr(lower(record_json),?)>0').join('')}`).iterate(...needles));
        // Older tag bodies may carry their cover inline (a digest, not a path).
        const digest = /^([a-f0-9]{64})\.webp$/.exec(path.basename(resolved).toLowerCase())?.[1];
        if (digest && library && inFolder(file, path.join(library, 'covers'))) noteVersions(db.prepare(`SELECT record_json FROM versions WHERE ${FILE_RECORDS} AND instr(lower(record_json),?)>0`).iterate(digest));
      }
    } else noteVersions(db.prepare(`SELECT record_json FROM versions WHERE ${FILE_RECORDS}`).iterate());
    if (library) for (const row of db.prepare("SELECT kind,id,json_extract(payload_json,'$.sha256') AS sha256 FROM covers WHERE payload_json IS NOT NULL").all() as any[]) if (typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/.test(row.sha256)) note(path.join(library, 'covers', `${row.sha256}.webp`), `item:${row.kind}:${row.id}`);
    if (trashReady) for (const row of db.prepare(`SELECT trash_id,path FROM trash_files WHERE ${TRASH_FILES_IN_PLACE}`).all() as any[]) note(String(row.path), `trash:${row.trash_id}`);
    return result;
  }
  /** Archived live items (identity and revision), most recently updated first, and how many there are in all. */
  function archivedItems(kinds: readonly LibraryKind[] = [], limit = 500): { items: Array<{ kind: LibraryKind; id: string; revision: number; name: string }>; total: number } {
    active(); kinds.forEach(kindOf); version(limit);
    const where = `archived=1${kinds.length ? ` AND kind IN (${kinds.map(() => '?').join(',')})` : ''}`;
    const total = Number((db.prepare(`SELECT count(*) AS count FROM items WHERE ${where}`).get(...kinds) as any)?.count);
    const items = db.prepare(`SELECT kind,id,revision,name FROM items WHERE ${where} ORDER BY updated_at DESC,kind,id LIMIT ?`).all(...kinds, limit).map((row: any) => ({ kind: row.kind as LibraryKind, id: String(row.id), revision: Number(row.revision), name: String(row.name) }));
    return { items, total };
  }
  /** Every saved cover (tag covers): kind, id, coverRevision and cover metadata. */
  function allCovers(): LibraryCover[] { active(); return db.prepare('SELECT kind,id FROM covers WHERE payload_json IS NOT NULL ORDER BY kind,id').all().map((row: any) => getCover(row.kind, row.id)); }
  /** The highest wall-clock time Recently Deleted has seen (ms), so a clock set back never shortens a retention. */
  function trashClock(): number { active(); const row: any = db.prepare('SELECT value_json FROM metadata WHERE key=?').get('trash-clock'); const value = row ? Number(JSON.parse(row.value_json)) : 0; return Number.isSafeInteger(value) ? value : 0; }
  function advanceTrashClock(nowMs: number) { if (!Number.isSafeInteger(nowMs)) fail('invalid_argument', 'Invalid clock.'); return transaction(() => { if (nowMs > trashClock()) db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run('trash-clock', JSON.stringify(nowMs)); }); }
  function pendingFileOps():PendingFileOperation[]{active();return db.prepare('SELECT record_json FROM file_operations ORDER BY id').all().map((r:any)=>JSON.parse(r.record_json));}
  // Constraint (review P3-3): file-operation writes record no item change, so
  // their commits announce changedKinds [] with ids []. That is safe only
  // because no selective renderer query reads this data, and every list query
  // re-reads on any change, including an empty one (src/asset-library/query.ts
  // assetQueryNeedsRefresh). Whoever adds a selective query key or read model
  // that reads file operations must first give these writes a kind here.
  function putFileOperation(operation:PendingFileOperation){identity(operation.id);if(!['create','rename','delete','trash-move','trash-restore','trash-purge'].includes(operation.action)||!['pending','failed'].includes(operation.state))fail('invalid_argument','Invalid file operation.');object(operation.payload);return transaction(()=>{db.prepare('INSERT INTO file_operations VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(operation.id,json(operation));});}
  function completeFileOperation(id:string){identity(id);return transaction(()=>{db.prepare('DELETE FROM file_operations WHERE id=?').run(id);});}
  function exportSnapshot():LibrarySnapshot{return readTransaction(()=>({schemaVersion:1,items:db.prepare('SELECT record_json FROM versions ORDER BY kind,id,revision').all().map(r=>decode(r)!),collections:collections(),memberships:memberships(),relations:relations(),assets:assets(),assetLinks:assetLinks(),covers:db.prepare('SELECT kind,id FROM covers ORDER BY kind,id').all().map((r:any)=>getCover(r.kind,r.id)),fileOperations:pendingFileOps()}));}
  function importSnapshot(snapshot:LibrarySnapshot,options:{requireEmpty?:boolean}={}){
    // schemaVersion 2 snapshots were written with style experiment domains; any such domain is not imported. Fields of a
    // snapshot this version does not read (for example a former migration status) are ignored.
    if(snapshot.schemaVersion!==1||!Array.isArray(snapshot.items))fail('invalid_argument','Unsupported library snapshot.');
    return transaction(()=>{
      changedUnknown();
      if(options.requireEmpty!==false&&Number(db.prepare('SELECT count(*) AS count FROM versions').get()?.count)!==0)fail('library_conflict','Import requires an empty library.');
      for(const item of [...snapshot.items].sort((a,b)=>a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id)||a.revision-b.revision)){
        const old=get(item.kind,item.id,item.revision);if(old){if(json(old)!==json(item))fail('library_conflict','An imported immutable revision differs.');continue;}
        put(item.kind,item.id,item.payload,{revision:item.revision,name:item.name,archived:item.archived,createdAt:item.createdAt,updatedAt:item.updatedAt,source:item.source});
      }
      if(options.requireEmpty!==false)db.exec('DELETE FROM memberships; DELETE FROM relations; DELETE FROM asset_links; DELETE FROM covers; DELETE FROM assets; DELETE FROM collections');
      for(const value of snapshot.collections??[])putCollection(value);
      for(const value of snapshot.memberships??[])setMembership(value);
      const groups=new Map<string,LibraryRelation[]>();for(const value of snapshot.relations??[]){const key=JSON.stringify([value.kind,value.id,value.revision]);groups.set(key,[...(groups.get(key)??[]),value]);}for(const values of groups.values()){values.sort((a,b)=>a.ordinal-b.ordinal);const source=values[0];setRelations(source.kind,source.id,source.revision,values);}
      for(const value of snapshot.assets??[])putAsset(value);for(const value of snapshot.assetLinks??[])linkAsset(value);
      for(const value of snapshot.covers??[])setCover(value.kind,value.id,value.cover,{coverRevision:value.coverRevision});
      for(const value of snapshot.fileOperations??[])putFileOperation(value);
    });
  }
  return {get,put,list,listFacts,getMany,all,historyItems,historyOrder,historyDates,historyEntries,historyViewIndexStats:()=>historyIndex.stats(),readVersions,historyTagsReady,rebuildHistoryTags,historyTagMatches,historyTagSuggestions,remove,delete:remove,transaction,tx:transaction,readTransaction,getRevision,revision:getRevision,subscribe(listener:LibraryChangeListener){listeners.add(listener);return()=>{listeners.delete(listener);};},collections,putCollection,deleteCollection,setMembership,memberships,setRelations,relations,rebuildProjections,putAsset,assets,itemAssets,versionAssets,previewAssets,linkAsset,assetLinks,getCover,setCover,pendingFileOps,putFileOperation,completeFileOperation,exportSnapshot,importSnapshot,trashEntry,trashEntryFor,listTrash,trashFiles,trashVersions,expiredTrash,allTrashIds,trashedIds,trashItem,restoreTrashedItem,trashCollection,restoreTrashedCollection,updateTrashEntry,setTrashFile,deleteTrashEntries,adoptClearedCover,fileOwners,archivedItems,allCovers,trashClock,advanceTrashClock,integrityCheck:()=>String(db.prepare('PRAGMA integrity_check').get()?.integrity_check),close(){if(!closed){historyIndex.drop();db.close();closed=true;listeners.clear();}}};
}
export type LibraryRepository = ReturnType<typeof openLibraryRepository>;
