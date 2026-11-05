/** Recently Deleted and backups, startup recovery order and stale full-list writers (real repository and files). */
import { afterEach, expect, it, vi } from 'vitest';
import { runCleanupsSync } from '../src/test-support/temp-dirs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
vi.mock('./ipc/store', () => ({}));
import { openLibraryRepository, type LibraryRepository } from './library/repository';
import { appendLibraryArchive, restoreLibraryArchive } from './library-archive';
import { createLibraryTrash } from './library-trash';
import { activateLibrary, deactivateLibrary } from './library-runtime';
import { loadArtistFavoriteLibrary, saveArtistFavoriteCollection } from './ipc/artist-favorites';
import { fileReferencedElsewhere, recoverLibraryFileOperations } from './library-file-operations';

const roots: string[] = [], repositories: LibraryRepository[] = [];
afterEach(() => { deactivateLibrary(); for (const repo of repositories.splice(0)) { try { repo.close(); } catch { /* closed */ } } runCleanupsSync(roots.splice(0).map(root => () => fs.rmSync(root, { recursive: true, force: true }))); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-trash-backup-')); roots.push(root);
  const library = path.join(root, 'library'), output = path.join(root, 'output');
  fs.mkdirSync(library); fs.mkdirSync(output);
  const open = (name = 'library.sqlite') => { const repo = openLibraryRepository({ filePath: path.join(root, name), libraryDirectory: library, userDataRoot: root }); repositories.push(repo); return repo; };
  const repo = open();
  const trash = createLibraryTrash({ repository: repo, userDataRoot: root, libraryDirectory: library, managedRoots: () => [output], log: () => undefined });
  const image = (id: string, file = path.join(output, `${id}.png`)) => { fs.writeFileSync(file, `SFW image ${id}`); return repo.put('history', id, { id, filePath: file, fileUrl: `fixture:${file}`, date: '2026-11-02', createdAt: '2026-11-02T00:00:00Z', params: { positivePrompt: id }, actualSeed: 1, model: 'nai-diffusion-4-5-full', width: 8, height: 8 }); };
  return { root, library, output, repo, open, trash, image };
}

it('a backup carries no Recently Deleted entry or file; importing one that names a deleted identity keeps the deleted copy', async () => {
  const f = fixture();
  f.image('kept'); f.image('gone');
  f.repo.put('style_preset', 'style-gone', { id: 'style-gone', name: 'gone', prompt: 'ink', group: '', createdAt: '2026-11-02T00:00:00Z' });
  // The backup taken before the deletion still contains both images and the preset.
  const before = new JSZip(); await appendLibraryArchive(before, { repository: f.repo, libraryDirectory: f.library, userDataRoot: f.root, assetRoots: [f.output] });
  const { deleted } = await f.trash.deleteItems([{ kind: 'history', id: 'gone', expectedRevision: 1 }, { kind: 'style_preset', id: 'style-gone', expectedRevision: 1 }]);
  const after = new JSZip(); const summary = await appendLibraryArchive(after, { repository: f.repo, libraryDirectory: f.library, userDataRoot: f.root, assetRoots: [f.output] });
  expect(summary).toMatchObject({ items: 1, missing: 0 });
  const manifest = JSON.parse(await after.file('library/manifest.json')!.async('string'));
  expect(manifest.snapshot.items.map((item: any) => item.id)).toEqual(['kept']);
  expect(JSON.stringify(manifest)).not.toMatch(/[\\/]trash[\\/]|"gone|style-gone|gone\.png/);
  // Importing the older backup: the deleted identities stay in Recently Deleted and are reported, the rest merges.
  const target = f.repo;
  const restored = await restoreLibraryArchive(before, { repository: target, libraryDirectory: f.library, userDataRoot: f.root, assetRoots: [f.output] });
  expect(restored).toMatchObject({ imported: 0, conflicts: 3 });
  expect(restored.warnings.join('\n')).toMatch(/2 of them are in Recently Deleted/);
  expect(restored.warningDetails).toContainEqual(expect.objectContaining({ code: 'backup_warning', reason: 'library_archive.in_trash', params: { count: 2 } }));
  expect(target.get('history', 'gone')).toBeNull();
  expect(target.listTrash().total).toBe(2);
  // The deleted copy restores exactly.
  await f.trash.restore(deleted.map((value: any) => value.trashId));
  expect(target.get('history', 'gone')?.revision).toBe(1);
  expect(target.get('style_preset', 'style-gone')?.payload.name).toBe('gone');
});

it('a stale full-list writer never recreates a deleted item; general recovery leaves Recently Deleted journals to their owner', async () => {
  const f = fixture();
  activateLibrary(f.repo, { userDataRoot: f.root, libraryDirectory: f.library });
  const favorite = (id: string) => ({ id, artists: [], auxiliary: [], mutations: [], franchiseStyles: [], basePrompt: id, prompt: id, pairId: id, variant: 'plain', sequence: 1, status: 'done' });
  await saveArtistFavoriteCollection(f.root, 'random', [favorite('a'), favorite('b')]);
  // The favorite list read before 'a' went to Recently Deleted is written back as a whole.
  const stale = structuredClone((await loadArtistFavoriteLibrary(f.root)).collections.random);
  await f.trash.deleteItems([{ kind: 'artist_favorite', id: 'random:a', expectedRevision: 1 }]);
  await saveArtistFavoriteCollection(f.root, 'random', stale);
  expect(f.repo.get('artist_favorite', 'random:a')).toBeNull();
  expect(f.repo.get('artist_favorite', 'random:b')?.revision).toBe(1);
  expect(f.repo.listTrash().total).toBe(1);

  // A shared file left in place by an entry also blocks a rename of the live item that shares it.
  const shared = path.join(f.output, 'shared.png');
  f.image('x', shared); f.image('y', shared);
  await f.trash.deleteItems([{ kind: 'history', id: 'x', expectedRevision: 1 }]);
  expect(fileReferencedElsewhere(f.repo, 'history', 'y', shared)).toBe(true);

  // An interrupted deletion: the general startup recovery skips the trash journal, Recently Deleted finishes it.
  f.image('z');
  const hanging = createLibraryTrash({ repository: f.repo, userDataRoot: f.root, libraryDirectory: f.library, managedRoots: () => [f.output], log: () => undefined, interrupt: () => new Promise(() => undefined) });
  void hanging.deleteItems([{ kind: 'history', id: 'z', expectedRevision: 1 }]);
  for (let waited = 0; f.repo.get('history', 'z') && waited < 2000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
  await recoverLibraryFileOperations(f.repo);
  expect(f.repo.pendingFileOps().map(value => [value.action, value.state])).toEqual([['trash-move', 'pending']]);
  await f.trash.recover();
  expect(f.repo.pendingFileOps()).toEqual([]);
  expect(fs.existsSync(path.join(f.output, 'z.png'))).toBe(false);
});
