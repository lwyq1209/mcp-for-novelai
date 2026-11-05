/**
 * Step 3c review rework (R3, P3-9): an older-format or partial backup import (not the unified library archive) and
 * Recently Deleted. Identities in Recently Deleted are skipped and reported, the rest imports, and an import that
 * stops removes the image files it wrote for records it never saved. Real repository, service, files and backup ZIP.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { runCleanups } from '../../src/test-support/temp-dirs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openLibraryRepository, type LibraryRepository } from '../library/repository';
import { activateLibrary, deactivateLibrary } from '../library-runtime';
import { createLibraryTrash } from '../library-trash';
import { saveArtistFavoriteCollection } from './artist-favorites';

const mock = vi.hoisted(() => ({ userData: '/private/tmp/unset-backup-trash-test', state: {} as any }));
vi.mock('electron', () => ({ app: { getPath: () => mock.userData, getVersion: () => 'fixture' }, dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() }, shell: { openPath: vi.fn() }, safeStorage: { isEncryptionAvailable: () => false } }));
vi.mock('./store', async () => {
  const actual = await vi.importActual<typeof import('./store')>('./store');
  return { readStore: () => mock.state, writeStore: (value: unknown) => { mock.state = value; }, defaultSettings: () => mock.state.settings, retainKnownSettings: (raw: Record<string, unknown>) => actual.retainKnownSettings(raw), librarySettings: actual.librarySettings };
});
import { exportDataBackup, importDataBackup } from './data-backup';

const roots: string[] = [], repositories: LibraryRepository[] = [];
const now = '2026-11-02T00:00:00.000Z';
afterEach(() => { vi.restoreAllMocks(); return runCleanups([() => deactivateLibrary(), ...repositories.splice(0).map(repo => () => repo.close()), ...roots.splice(0).map(root => () => fs.rm(root, { recursive: true, force: true }))]); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-backup-trash-')); roots.push(root);
  const libraryDirectory = path.join(root, 'library'), userDataRoot = path.join(root, 'user-data'), output = path.join(userDataRoot, 'output');
  for (const directory of [libraryDirectory, userDataRoot, output]) await fs.mkdir(directory, { recursive: true });
  const repository = openLibraryRepository({ filePath: path.join(root, 'library.sqlite'), libraryDirectory, userDataRoot }); repositories.push(repository);
  activateLibrary(repository, { libraryDirectory, userDataRoot }); mock.userData = userDataRoot;
  mock.state = { settings: { outputDir: output, backupDir: path.join(userDataRoot, 'backups'), promptTemplates: [] } };
  const trash = createLibraryTrash({ repository, userDataRoot, libraryDirectory, managedRoots: () => [output], log: () => undefined });
  const image = async (id: string) => {
    const filePath = path.join(output, `${id}.png`); await fs.writeFile(filePath, `SFW image ${id}`);
    const item = { id, filePath, date: now, createdAt: now, params: { seed: 1, positivePrompt: id }, actualSeed: 1, model: 'nai-diffusion-5-full', width: 8, height: 8 };
    repository.put('history', id, item); return item;
  };
  return { root, repository, output, trash, image, userDataRoot };
}
const files = async (directory: string) => (await fs.readdir(directory)).sort();
// Not every library category: this import takes the per-category (older format) route, not the unified archive.
const PARTIAL = ['imageHistory', 'artistLibrary', 'promptPresets'] as const;

it('skips history, favorites, presets and chunks that are in Recently Deleted, reports them and imports the rest', async () => {
  const f = await fixture();
  const gone = await f.image('gone'), kept = await f.image('kept');
  await saveArtistFavoriteCollection(f.userDataRoot, 'random', [{ id: 'fav-gone', artists: [], prompt: 'cup' }, { id: 'fav-new', artists: [], prompt: 'saucer' }]);
  const style = { id: 'style-gone', name: 'Ink', prompt: 'ink', group: '', createdAt: now };
  const chunk = { id: 'chunk-gone', name: 'Chunk', content: 'soft light', createdAt: now, updatedAt: now };
  f.repository.put('style_preset', style.id, style); f.repository.put('prompt_chunk', chunk.id, chunk);
  void gone; void kept;
  const exported = await exportDataBackup({ destination: 'internal', categories: [...PARTIAL] });
  expect(exported.ok).toBe(true);
  const favorite = f.repository.get('artist_favorite', 'random:fav-gone')!;
  await f.trash.deleteItems([{ kind: 'history', id: 'gone', expectedRevision: 1 }, { kind: 'style_preset', id: style.id, expectedRevision: 1 }, { kind: 'prompt_chunk', id: chunk.id, expectedRevision: 1 }, { kind: favorite.kind, id: favorite.id, expectedRevision: favorite.revision }]);
  // fav-new is simply gone (not in Recently Deleted): the backup brings it back in the same save that skips fav-gone.
  f.repository.remove('artist_favorite', 'random:fav-new');
  // Live state before the import: nothing of these left.
  const outputBefore = await files(f.output);
  const result = await importDataBackup({ path: exported.path!, categories: [...PARTIAL], confirmConfigurationOverwrite: false });
  expect(result).toMatchObject({ ok: true });
  expect(result.warnings?.join('\n')).toMatch(/4 item\(s\) are in Recently Deleted and were not imported/);
  expect(result.message).toContain('Recently Deleted'); expect(result).toMatchObject({ code: 'backup_imported', reason: 'backup.imported_warnings', details: { warnings: [expect.objectContaining({ reason: 'backup.in_trash', params: { count: 4 } })] } });
  expect(f.repository.all('history').map(item => item.id)).toEqual(['kept']);
  expect(f.repository.all('style_preset')).toEqual([]);
  expect(f.repository.all('prompt_chunk')).toEqual([]);
  // The deleted favorite stays in Recently Deleted; the other favorite of the same backup is back.
  expect(f.repository.get('artist_favorite', 'random:fav-gone')).toBeNull();
  expect(f.repository.get('artist_favorite', 'random:fav-new')).not.toBeNull();
  expect(f.repository.listTrash().total).toBe(4);
  expect(await files(f.output)).toEqual(outputBefore);
});

it('an import that stops before saving removes the image files it wrote, never one something uses', async () => {
  const f = await fixture();
  await f.image('a');
  const exported = await exportDataBackup({ destination: 'internal', categories: [...PARTIAL] });
  // The record is gone (a plain removal, not Recently Deleted), so the import writes the image again (as "a (1).png").
  f.repository.remove('history', 'a');
  const outputBefore = await files(f.output);
  // The library write that would save the imported records fails.
  const transaction = f.repository.transaction;
  vi.spyOn(f.repository, 'transaction').mockImplementation(((work: () => unknown, options?: { unknownChange?: boolean }) => {
    if (options?.unknownChange) throw new Error('fixture: the library could not be written');
    return transaction(work, options);
  }) as typeof transaction);
  const result = await importDataBackup({ path: exported.path!, categories: [...PARTIAL], confirmConfigurationOverwrite: false });
  expect(result.ok).toBe(false);
  expect(result.message).toMatch(/the 1 image file\(s\) written but not saved by this import were deleted/); expect(result).toMatchObject({ code: 'backup_import_aborted', reason: 'backup.import_aborted_removed', params: { removed: 1 } });
  expect(await files(f.output)).toEqual(outputBefore);
});
