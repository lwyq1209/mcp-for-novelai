import { activeLibrary } from '../library-runtime';
import path from "node:path";

/**
 * Artist favorites are library items (artist_favorite, id "<collection>:<favorite id>") and members of the library's
 * 'artist-favorites' collections of these names. No feature of this version creates new favorites; the favorites a
 * user has are listed and applied from the library, and the data backup's artist library category carries them.
 */
export const ARTIST_FAVORITE_COLLECTIONS = [
  "random",
  "v5-repair",
  "artist-string-draw",
] as const;

export type ArtistFavoriteCollectionName = typeof ARTIST_FAVORITE_COLLECTIONS[number];

export interface ArtistFavoriteLibrarySnapshot {
  version: 1;
  updatedAt: string;
  collections: Record<ArtistFavoriteCollectionName, unknown[]>;
}

const writeQueues = new Map<string, Promise<void>>();

function emptyLibrary(): ArtistFavoriteLibrarySnapshot {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    collections: {
      random: [],
      "v5-repair": [],
      "artist-string-draw": [],
    },
  };
}

function normalizeFavorites(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => (
    item !== null
    && typeof item === "object"
    && typeof (item as { id?: unknown }).id === "string"
  ));
}

function library(userDataRoot: string) {
  const repo = activeLibrary(userDataRoot);
  if (!repo) throw new Error("素材库尚未打开。");
  return repo;
}

/** The unarchived favorites of each collection, in their saved order. */
export async function loadArtistFavoriteLibrary(
  userDataRoot: string,
): Promise<ArtistFavoriteLibrarySnapshot> {
  const repo = library(userDataRoot);
  const snapshot = emptyLibrary();
  for (const collection of ARTIST_FAVORITE_COLLECTIONS) {
    const members = new Set(repo.memberships().filter(value => value.namespace === 'artist-favorites' && value.collectionId === collection).map(value => value.id));
    snapshot.collections[collection] = repo.all('artist_favorite').sort((a,b) => (a.source.position ?? Number.MAX_SAFE_INTEGER) - (b.source.position ?? Number.MAX_SAFE_INTEGER)).filter(item => !item.archived && members.has(item.id)).map(item => { const { collection: _collection, ...payload } = item.payload; return payload; });
  }
  snapshot.updatedAt = new Date().toISOString();
  return snapshot;
}

function writeLibrary(
  userDataRoot: string,
  snapshot: ArtistFavoriteLibrarySnapshot,
) {
  const repo = library(userDataRoot);
  // A list read before a favorite went to Recently Deleted (or an older backup naming it) must not bring it back.
  const deleted = repo.trashedIds('artist_favorite');
  repo.transaction(() => {
    for (const collection of ARTIST_FAVORITE_COLLECTIONS) {
      repo.putCollection({ namespace: 'artist-favorites', id: collection, name: collection, payload: {} });
      const values = (snapshot.collections[collection] as Array<Record<string, any>>).filter(value => !deleted.has(`${collection}:${value.id}`));
      const ids = new Set(values.map(value => `${collection}:${value.id}`));
      for (const membership of repo.memberships().filter(value => value.namespace === 'artist-favorites' && value.collectionId === collection)) if (!ids.has(membership.id)) repo.setMembership(membership, false);
      for (const value of values) {
        const id = `${collection}:${value.id}`, payload = { ...value, collection }, old = repo.get('artist_favorite', id);
        if (!old || JSON.stringify(old.payload) !== JSON.stringify(payload)) repo.put('artist_favorite', id, payload, { expectedRevision: old?.revision ?? 0, source: { namespace: `artist-favorites:${collection}`, legacyId: value.id } });
        repo.setMembership({ namespace: 'artist-favorites', collectionId: collection, kind: 'artist_favorite', id });
      }
    }
  });
}

/** Serialize updates from different tools so two near-simultaneous saves do
 * not overwrite each other's independent favorite collection. */
export function saveArtistFavoriteCollection(
  userDataRoot: string,
  collection: ArtistFavoriteCollectionName,
  favorites: unknown,
): Promise<void> {
  if (!ARTIST_FAVORITE_COLLECTIONS.includes(collection)) {
    return Promise.reject(new TypeError("Unknown artist favorite collection."));
  }
  const root = path.resolve(userDataRoot);
  const previous = writeQueues.get(root) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const current = await loadArtistFavoriteLibrary(root);
    const snapshot: ArtistFavoriteLibrarySnapshot = {
      ...current,
      updatedAt: new Date().toISOString(),
      collections: {
        ...current.collections,
        [collection]: normalizeFavorites(favorites),
      },
    };
    writeLibrary(root, snapshot);
  });
  writeQueues.set(root, next);
  const cleanup = () => {
    if (writeQueues.get(root) === next) writeQueues.delete(root);
  };
  void next.then(cleanup, cleanup);
  return next;
}
