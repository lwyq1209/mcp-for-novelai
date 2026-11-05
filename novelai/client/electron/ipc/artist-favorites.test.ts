import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCleanups } from '../../src/test-support/temp-dirs';
import { openLibraryRepository, type LibraryRepository } from "../library/repository";
import { activateLibrary, deactivateLibrary } from "../library-runtime";
import { loadArtistFavoriteLibrary, saveArtistFavoriteCollection } from "./artist-favorites";

const roots: string[] = [], repositories: LibraryRepository[] = [];

/** A data root whose library is open (artist favorites are library items). */
async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nai-artist-favorites-"));
  roots.push(root);
  const repository = openLibraryRepository({ filePath: path.join(root, "library.sqlite"), userDataRoot: root, libraryDirectory: path.join(root, "library") });
  repositories.push(repository);
  activateLibrary(repository, { userDataRoot: root, libraryDirectory: path.join(root, "library") });
  return { root, repository };
}

afterEach(() => runCleanups([() => deactivateLibrary(), ...repositories.splice(0).map(repository => () => repository.close()), ...roots.splice(0).map((root) => () => fs.rm(root, { recursive: true, force: true }))]));

describe("artist favorites in the library", () => {
  it("serializes simultaneous updates without mixing the three collections", async () => {
    const { root, repository } = await temporaryRoot();
    await Promise.all([
      saveArtistFavoriteCollection(root, "random", [{ id: "random-a" }]),
      saveArtistFavoriteCollection(root, "v5-repair", [{ id: "repair-a" }]),
      saveArtistFavoriteCollection(root, "artist-string-draw", [{ id: "draw-a" }]),
    ]);

    const library = await loadArtistFavoriteLibrary(root);
    expect(library.collections.random).toEqual([{ id: "random-a" }]);
    expect(library.collections["v5-repair"]).toEqual([{ id: "repair-a" }]);
    expect(library.collections["artist-string-draw"]).toEqual([{ id: "draw-a" }]);
    expect(repository.get("artist_favorite", "random:random-a")?.payload).toEqual({ id: "random-a", collection: "random" });
    expect(repository.memberships("artist_favorite", "v5-repair:repair-a")).toEqual([{ namespace: "artist-favorites", collectionId: "v5-repair", kind: "artist_favorite", id: "v5-repair:repair-a" }]);
    // No settings or JSON file of their own.
    expect((await fs.readdir(root)).sort()).toEqual(["library.sqlite"]);
  });

  it("writes only what changed; a favorite left out of a collection's list leaves that collection, its record stays", async () => {
    const { root, repository } = await temporaryRoot();
    await saveArtistFavoriteCollection(root, "random", [{ id: "a" }, { id: "b" }]);
    await saveArtistFavoriteCollection(root, "random", [{ id: "b" }, { id: "c" }]);
    expect(((await loadArtistFavoriteLibrary(root)).collections.random as Array<{ id: string }>).map(value => value.id).sort()).toEqual(["b", "c"]);
    expect(repository.get("artist_favorite", "random:b")?.revision).toBe(1);
    expect(repository.get("artist_favorite", "random:a")?.revision).toBe(1);
    expect(repository.memberships("artist_favorite", "random:a")).toEqual([]);
  });

  it("refuses to load or save without an open library", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nai-artist-favorites-")); roots.push(root);
    await expect(loadArtistFavoriteLibrary(root)).rejects.toThrow(/素材库尚未打开/);
    await expect(saveArtistFavoriteCollection(root, "random", [{ id: "x" }])).rejects.toThrow(/素材库尚未打开/);
    expect(await fs.readdir(root)).toEqual([]);
  });
});
