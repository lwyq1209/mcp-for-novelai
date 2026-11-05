/** storage:delete (the history panel's delete) goes to Recently Deleted: real repository, real files, real service. */
import { afterEach, expect, it, vi } from 'vitest';
import { runCleanupsSync } from '../../src/test-support/temp-dirs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
vi.mock('electron', () => ({ dialog: {}, shell: {}, protocol: { registerSchemesAsPrivileged: () => undefined } }));
vi.mock('./store', () => ({ getSetting: () => { throw new Error('The library path reads no setting.'); } }));
import { deleteHistoryItem } from './storage';
import { openLibraryRepository, type LibraryRepository } from '../library/repository';
import { createLibraryTrash } from '../library-trash';
import { activateLibrary, activateLibraryTrash, deactivateLibrary } from '../library-runtime';

const roots: string[] = [], repositories: LibraryRepository[] = [];
afterEach(() => runCleanupsSync([() => deactivateLibrary(), ...repositories.splice(0).map(repo => () => repo.close()), ...roots.splice(0).map(root => () => fs.rmSync(root, { recursive: true, force: true }))]));

it('moves the record and its original to Recently Deleted, deletes a referenced image too, and can be restored', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-storage-delete-')); roots.push(root);
  const library = path.join(root, 'library'), output = path.join(root, 'output'); fs.mkdirSync(library); fs.mkdirSync(output);
  const repo = openLibraryRepository({ filePath: path.join(root, 'library.sqlite'), libraryDirectory: library, userDataRoot: root }); repositories.push(repo);
  activateLibrary(repo, { userDataRoot: root, libraryDirectory: library });
  const file = path.join(output, 'cup.png'); fs.writeFileSync(file, 'SFW cup');
  const item = repo.put('history', 'cup', { id: 'cup', filePath: file, fileUrl: 'fixture:cup', date: '2026-11-02', createdAt: '2026-11-02T00:00:00Z', params: { positivePrompt: 'cup' }, actualSeed: 1, model: 'nai-diffusion-4-5-full', width: 8, height: 8 });
  // Before this step a referenced image was refused ("仍被其他素材引用"); now its references are listed and it is deleted.
  repo.put('artist_favorite', 'random:cup', { id: 'cup', collection: 'random', artists: [], prompt: 'cup', image: item.payload });
  expect(await deleteHistoryItem('cup')).toMatchObject({ ok: false, code: 'library_unavailable', reason: 'history.trash_unavailable', message: expect.stringContaining('Recently Deleted') });
  const trash = createLibraryTrash({ repository: repo, userDataRoot: root, libraryDirectory: library, managedRoots: () => [output], log: () => undefined });
  activateLibraryTrash(trash);
  const result = await deleteHistoryItem('cup');
  expect(result).toMatchObject({ ok: true, trashId: expect.stringMatching(/^[a-f0-9-]{36}$/) });
  expect(repo.get('history', 'cup')).toBeNull();
  // The favorite still uses the original, so it stays in place until nothing uses it.
  expect(fs.existsSync(file)).toBe(true);
  expect(trash.list().entries).toMatchObject([{ trashId: (result as any).trashId, kind: 'history', id: 'cup', files: { moved: 0, kept: 1 }, impacts: { referencedBy: 1, sharedFiles: 1 } }]);
  expect(await deleteHistoryItem('cup')).toEqual({ ok: true });
  await trash.restore([(result as any).trashId]);
  expect(repo.get('history', 'cup')?.revision).toBe(1);
  // Without the favorite the original itself moves to the trash folder.
  repo.remove('artist_favorite', 'random:cup');
  expect(await deleteHistoryItem('cup')).toMatchObject({ ok: true });
  expect(fs.existsSync(file)).toBe(false);
  expect(fs.readdirSync(path.join(root, 'trash'))).toHaveLength(1);
});

it('says what actually happened when the delete call fails before or after the record went to Recently Deleted (review P3-8)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-storage-delete-')); roots.push(root);
  const library = path.join(root, 'library'), output = path.join(root, 'output'); fs.mkdirSync(library); fs.mkdirSync(output);
  const repo = openLibraryRepository({ filePath: path.join(root, 'library.sqlite'), libraryDirectory: library, userDataRoot: root }); repositories.push(repo);
  activateLibrary(repo, { userDataRoot: root, libraryDirectory: library });
  for (const id of ['early', 'late']) { const file = path.join(output, `${id}.png`); fs.writeFileSync(file, `SFW ${id}`); repo.put('history', id, { id, filePath: file, fileUrl: 'fixture', date: '2026-11-02', createdAt: '2026-11-02T00:00:00Z', params: { positivePrompt: id }, actualSeed: 1, model: 'nai-diffusion-4-5-full', width: 8, height: 8 }); }
  const trash = createLibraryTrash({ repository: repo, userDataRoot: root, libraryDirectory: library, managedRoots: () => [output], log: () => undefined });
  activateLibraryTrash({ ...trash, deleteItems: async () => { throw new Error('refused before anything changed'); } });
  expect(await deleteHistoryItem('early')).toMatchObject({ ok: false, code: 'history_delete_failed', message: expect.stringMatching(/^The delete did not complete; the history record and image are still there/), params: { detail: expect.any(String) } });
  expect(repo.get('history', 'early')).not.toBeNull();
  activateLibraryTrash({ ...trash, deleteItems: async (...args: Parameters<typeof trash.deleteItems>) => { await trash.deleteItems(...args); throw new Error('failed after the commit'); } });
  const late = await deleteHistoryItem('late');
  expect(late).toMatchObject({ ok: true, trashId: repo.trashEntryFor('history', 'late')!.trashId, code: 'history_trash_pending', message: expect.stringContaining('Moved to Recently Deleted') });
});
