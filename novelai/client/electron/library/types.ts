export const LIBRARY_KINDS = ['tag', 'combo', 'note', 'study', 'history', 'artist_favorite', 'style_preset', 'positive_preset', 'prompt_chunk', 'reference_preset'] as const;
export type LibraryKind = typeof LIBRARY_KINDS[number];
export type LibraryPayload = Record<string, any>;
export interface LibrarySource { namespace: string; legacyId?: string; position?: number }
export interface LibraryItem {
  schemaVersion: 1; kind: LibraryKind; id: string; revision: number; name: string;
  archived: boolean; createdAt: string; updatedAt: string; source: LibrarySource; payload: LibraryPayload;
}
export interface PutOptions {
  expectedRevision?: number; revision?: number; name?: string; archived?: boolean;
  createdAt?: string; updatedAt?: string; source?: LibrarySource; searchText?: string;
}
export interface ListFilters {
  historyTags?: string[]; historyTagMatch?: 'all' | 'any'; historyTagSources?: Array<'positive'|'style'|'character'|'user'>;
  kind?: LibraryKind; kinds?: LibraryKind[]; query?: string; collectionId?: string;
  collectionNamespace?: string; sourceNamespace?: string; includeArchived?: boolean;
  /** Only archived items (the window's list, oss/lib-1103); includeArchived is then irrelevant. */
  archivedOnly?: boolean;
  group?: string;
  /** History images a queued batch saved: queueOrigin.requestKey / queueOrigin.batchId (2026-10-14). */
  queueRequestKey?: string; queueBatchId?: string;
  offset?: number; limit?: number; sortBy?: 'updatedAt' | 'createdAt' | 'name'; sortDirection?: 'asc' | 'desc';
}
export interface LibraryList { items: LibraryItem[]; total: number; offset: number; limit: number; hasMore: boolean }
/**
 * One item of a list's complete order with the facts the window's filters read (oss/lib-1103, repository listFacts):
 * the same fields src/library/image-facts.ts reads from a payload, taken with SQL so no record is decoded.
 */
export interface LibraryListFact {
  kind: LibraryKind; id: string; revision: number; name: string; archived: boolean;
  /** items.created_at (the list's sort column; the day groups, day counts and date filters read it). */
  createdAt: string;
  hasOrigin: boolean; originMode: string | null; batchId: string | null;
  model: string | null; paramsModel: string | null; upscalePrompt: boolean;
}
/**
 * What one committed write transaction changed (2026-11-01). Without
 * changedKinds the change is unknown: anything may have changed. With
 * changedKinds but without ids, any item of those kinds may have changed.
 * An empty changedKinds means no item-level data changed (for example only
 * file-operation bookkeeping); the revision still advanced.
 */
export interface LibraryChange { changedKinds?: readonly LibraryKind[]; ids?: readonly string[] }
export type LibraryChangeListener = (revision: number, change: LibraryChange) => void;
/** Above this many distinct identities a change names only its kinds. */
export const LIBRARY_CHANGE_ID_LIMIT = 500;
/** Item kinds whose views a collection namespace feeds (groups, favorites, preset groups). */
export const LIBRARY_COLLECTION_NAMESPACE_KINDS: Readonly<Record<string, readonly LibraryKind[]>> = {
  material: ['tag', 'combo', 'note'], history: ['history'], style: ['style_preset'], positive: ['positive_preset'],
  chunk: ['prompt_chunk'], reference: ['reference_preset'], 'artist-favorites': ['artist_favorite'],
};
/**
 * The collection namespaces this version knows: the system namespaces above and the user's own collections ('user').
 * A collection row of any other namespace (another build wrote it) stays in the library file as it is, but is not
 * listed, exported or imported.
 */
export const LIBRARY_COLLECTION_NAMESPACES: readonly string[] = Object.freeze([...Object.keys(LIBRARY_COLLECTION_NAMESPACE_KINDS), 'user']);
export const knownCollectionNamespace = (namespace: unknown): boolean => typeof namespace === 'string' && LIBRARY_COLLECTION_NAMESPACES.includes(namespace);
export interface LibraryCollection { id: string; namespace: string; name: string; payload: LibraryPayload }
export interface LibraryMembership { namespace: string; collectionId: string; kind: LibraryKind; id: string }
export interface LibraryRelation {
  kind: LibraryKind; id: string; revision: number; ordinal: number;
  targetKind?: LibraryKind; targetId?: string; targetRevision?: number; payload: LibraryPayload;
}
export interface LibraryAsset { id: string; payload: LibraryPayload }
export interface LibraryItemAsset extends LibraryAsset { role: string }
export interface LibraryAssetLink { kind: LibraryKind; id: string; role: string; assetId: string }
export interface LibraryCover { kind: LibraryKind; id: string; coverRevision: number; cover: LibraryPayload | null }
/** trash-move, trash-restore and trash-purge journal the file work of Recently Deleted (library-trash.ts), which also recovers them. */
export interface PendingFileOperation { id: string; action: 'create' | 'rename' | 'delete' | 'trash-move' | 'trash-restore' | 'trash-purge'; state: 'pending' | 'failed'; payload: LibraryPayload; createdAt: string; error?: string }
/** A Recently Deleted entry: one deleted item, or one deleted user collection (kind 'collection', itemId '<namespace>:<id>'). */
export type TrashEntryKind = LibraryKind | 'collection';
/**
 * moving: committed, its files are still being moved into the trash folder (finished by the same operation or by
 * startup recovery); trashed: settled.
 */
export type TrashEntryState = 'moving' | 'trashed';
export interface TrashEntry {
  trashId: string; kind: TrashEntryKind; itemId: string; revision: number | null; name: string;
  deletedMs: number; expiresMs: number; state: TrashEntryState;
  /** Public summary (counts, impacts); never paths. */
  summary: LibraryPayload;
  /** Captured rows and reference details needed to restore. */
  data: LibraryPayload;
}
/**
 * One file a trash entry depends on. planned: to be moved into the trash folder; moved: it is at trashPath;
 * kept-shared: left in place because another item or entry uses it; kept-outside / kept-unsafe: left in place,
 * outside the managed folders or not a plain file (never deleted by a purge); kept-failed: the move failed and it
 * stayed in place; missing: it did not exist at deletion; retained: a file kept for restoring another item's state
 * (the blob of a tag cover this deletion cleared).
 */
export type TrashFileState = 'planned' | 'moved' | 'kept-shared' | 'kept-outside' | 'kept-unsafe' | 'kept-failed' | 'missing' | 'retained';
/** realDirectory: the resolved folder the file was in at deletion (a restore or purge acts there only while it is the same folder). */
/** byteLength / sha256: the file's size and digest when it was deleted (or left in place); a purge deletes an in-place file only while it still matches. */
export interface TrashFile { trashId: string; ordinal: number; role: string; path: string; trashPath: string | null; state: TrashFileState; byteLength: number | null; realDirectory: string | null; sha256: string | null }
export interface LibrarySnapshot {
  schemaVersion: 1; items: LibraryItem[]; collections: LibraryCollection[]; memberships: LibraryMembership[];
  relations: LibraryRelation[]; assets: LibraryAsset[]; assetLinks: LibraryAssetLink[]; covers: LibraryCover[];
  fileOperations: PendingFileOperation[];
}
