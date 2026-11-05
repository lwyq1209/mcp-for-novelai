// Library startup (step 3e++): the library has one store, <data root>/library.sqlite. A data root without one gets a
// new empty library of version 8; there is no older store to read and no snapshot to keep.
import { afterEach, describe, expect, it } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import JSZip from 'jszip';
import { initializeAssetLibrary } from './library-startup';
import { activeLibrary, deactivateLibrary } from './library-runtime';
import { openLibraryRepository, type LibraryRepository } from './library/repository';
import { createAssetLibraryService } from './asset-library-service';
import { appendLibraryArchive } from './library-archive';

const roots: string[] = [], repositories: LibraryRepository[] = [];
const stamp = '2026-11-03T00:00:00.000Z';
async function dataRoot() { const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nai-library-startup-'))); roots.push(root); return root; }
async function start(root: string) {
  const repository = await initializeAssetLibrary({ userDataRoot: root, libraryDirectory: path.join(root, 'library'), useWorker: false });
  repositories.push(repository); return repository;
}
async function stop(repository: LibraryRepository) { repositories.splice(repositories.indexOf(repository), 1); repository.close(); deactivateLibrary(); }
const sql = <T>(file: string, read: (db: DatabaseSync) => T) => { const db = new DatabaseSync(file, { readOnly: true }); try { return read(db); } finally { db.close(); } };
const versionOf = (file: string) => sql(file, db => Number((db.prepare('PRAGMA user_version').get() as any).user_version));
const tablesOf = (file: string) => sql(file, db => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'items_fts_%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name));
const metadataKeys = (file: string) => sql(file, db => (db.prepare('SELECT key FROM metadata ORDER BY key').all() as Array<{ key: string }>).map(row => row.key));
const CORE_TABLES = ['assets', 'asset_links', 'collections', 'covers', 'file_operations', 'history_tags', 'items', 'items_fts', 'memberships', 'metadata', 'relations', 'versions'].sort();
const chunk = (id: string) => ({ id, name: id, content: 'soft light', createdAt: stamp, updatedAt: stamp });
afterEach(() => runCleanups([() => deactivateLibrary(), ...repositories.splice(0).map(repo => () => repo.close()), ...roots.splice(0).map(root => () => fs.rm(root, { recursive: true, force: true }))]));

describe('library startup', () => {
  it('creates a new empty library of version 8 in a fresh data root and nothing else, ready to read and write', async () => {
    const root = await dataRoot(), file = path.join(root, 'library.sqlite');
    const repository = await start(root);
    expect(activeLibrary()).toBe(repository);
    expect(await fs.readdir(root)).toEqual(['library.sqlite']);
    expect(versionOf(file)).toBe(8);
    expect(tablesOf(file)).toEqual(CORE_TABLES);
    // The history tag index is built (an empty one); there is no migration status of any kind.
    expect(metadataKeys(file)).toEqual(['history-tags-v1', 'revision']);
    expect(repository.exportSnapshot()).toEqual({ schemaVersion: 1, items: [], collections: [], memberships: [], relations: [], assets: [], assetLinks: [], covers: [], fileOperations: [] });
    expect(repository.integrityCheck()).toBe('ok');
    repository.put('prompt_chunk', 'chunk', chunk('chunk'));
    expect(repository.get('prompt_chunk', 'chunk')?.payload).toEqual(chunk('chunk'));
    // The next start opens the same library as it is.
    await stop(repository);
    const reopened = await start(root);
    expect(reopened.all().map(item => [item.kind, item.id, item.revision])).toEqual([['prompt_chunk', 'chunk', 1]]);
    expect(await fs.readdir(root)).toEqual(['library.sqlite']);
  });

  it('does not read settings.json: library arrays an earlier build wrote there are not imported, and the file is not changed', async () => {
    const root = await dataRoot(), settingsFile = path.join(root, 'settings.json');
    const history = { id: 'old-history', filePath: path.join(root, 'old.png'), date: '2026-01-01', createdAt: stamp, params: { positivePrompt: 'cup' }, actualSeed: 1, model: 'nai-diffusion-4-5-full', width: 8, height: 8 };
    const contents = JSON.stringify({ settings: { hasOnboarded: true, stylePromptPresets: [{ id: 'style', name: 'Style', prompt: 'watercolor', group: '', createdAt: stamp }], stylePromptPresetGroups: ['Default', 'Old'], positivePromptPresets: [], promptChunks: [chunk('old-chunk')] }, history: [history], historyGroups: [{ id: 'g', name: 'Group', createdAt: stamp }] });
    await fs.writeFile(settingsFile, contents);
    const repository = await start(root);
    expect(repository.all()).toEqual([]);
    expect(repository.collections()).toEqual([]);
    expect(readFileSync(settingsFile, 'utf8')).toBe(contents);
    expect((await fs.readdir(root)).sort()).toEqual(['library.sqlite', 'settings.json']);
  });

  it('creates the library again after a start that stopped while creating it: an empty file left behind', async () => {
    const root = await dataRoot(), file = path.join(root, 'library.sqlite');
    await fs.writeFile(file, '');
    const repository = await start(root);
    expect(versionOf(file)).toBe(8);
    expect(tablesOf(file)).toEqual(CORE_TABLES);
    repository.put('prompt_chunk', 'after-crash', chunk('after-crash'));
    expect(repository.all()).toHaveLength(1);
  });

  it('creates the library again after a process killed inside the creating transaction (a hot journal is rolled back)', async () => {
    const root = await dataRoot(), file = path.join(root, 'library.sqlite');
    // A process that dies before COMMIT: enough writes to spill pages into the file, then SIGKILL.
    const crash = `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(${JSON.stringify(file)});
      db.exec('PRAGMA cache_size=10'); db.exec('BEGIN IMMEDIATE'); db.exec('CREATE TABLE partial(x BLOB)');
      const insert = db.prepare('INSERT INTO partial VALUES(?)'); for (let i = 0; i < 200; i++) insert.run(Buffer.alloc(8192, 1));
      process.kill(process.pid, 'SIGKILL');`;
    try { execFileSync(process.execPath, ['-e', crash], { stdio: 'pipe' }); } catch { /* killed, as intended */ }
    expect(existsSync(`${file}-journal`)).toBe(true);
    const repository = await start(root);
    expect(versionOf(file)).toBe(8);
    expect(tablesOf(file)).toEqual(CORE_TABLES);
    expect(existsSync(`${file}-journal`)).toBe(false);
    expect(repository.all()).toEqual([]);
    repository.put('prompt_chunk', 'after-crash', chunk('after-crash'));
    expect(repository.get('prompt_chunk', 'after-crash')?.revision).toBe(1);
  });

  it('opens a library holding a migration metadata row or migration-namespace collections like any other; both are ignored', async () => {
    const root = await dataRoot(), file = path.join(root, 'library.sqlite');
    const seeded = openLibraryRepository({ filePath: file });
    seeded.put('prompt_chunk', 'chunk', chunk('chunk'));
    seeded.putCollection({ namespace: 'migration', id: 'legacy', name: 'legacy', payload: {} });
    seeded.setMembership({ namespace: 'migration', collectionId: 'legacy', kind: 'prompt_chunk', id: 'chunk' });
    seeded.putCollection({ namespace: 'user', id: 'kept', name: 'Kept', payload: {} });
    seeded.close();
    // What earlier development builds wrote: an unfinished one, too, is not a gate any more.
    const db = new DatabaseSync(file);
    try { db.prepare('INSERT INTO metadata VALUES(?,?)').run('migration', JSON.stringify({ state: 'pending', sourceHash: 'x' })); } finally { db.close(); }
    const repository = await start(root);
    expect(repository.get('prompt_chunk', 'chunk')?.payload).toEqual(chunk('chunk'));
    repository.put('prompt_chunk', 'chunk', { ...chunk('chunk'), content: 'edited' }, { expectedRevision: 1 });
    repository.setMembership({ namespace: 'user', collectionId: 'kept', kind: 'prompt_chunk', id: 'chunk' });
    const service = createAssetLibraryService({ repository });
    expect((await service.asset_library({ action: 'collections' })).collections.map((value: any) => value.id)).toEqual(['user:kept']);
    // Hidden the same way everywhere: an item's memberships, and the collection id itself.
    expect((await service.asset_library({ action: 'read', kind: 'prompt_chunk', id: 'chunk' })).memberships).toEqual([{ namespace: 'user', collectionId: 'kept', kind: 'prompt_chunk', id: 'chunk' }]);
    await expect(service.asset_library({ action: 'list', collectionId: 'migration:legacy' })).rejects.toMatchObject({ code: 'library_not_found', message: 'This collection does not exist.', reason: 'library.collection_not_found' });
    await expect(service.asset_library({ action: 'mutate', command: 'add-to-collection', collectionId: 'migration:legacy', items: [{ kind: 'prompt_chunk', id: 'chunk', expectedRevision: 2 }] })).rejects.toMatchObject({ code: 'library_not_found' });
    expect((await service.asset_library({ action: 'list', collectionId: 'user:kept' })).items.map((item: any) => item.id)).toEqual(['chunk']);
    expect(repository.exportSnapshot()).not.toHaveProperty('migration');
    const zip = new JSZip();
    await appendLibraryArchive(zip, { repository, libraryDirectory: path.join(root, 'library'), userDataRoot: root, includeAssets: false });
    const archived = JSON.parse(await zip.file('library/manifest.json')!.async('string')).snapshot;
    expect(archived).not.toHaveProperty('migration');
    expect(archived.collections.map((value: any) => value.namespace)).toEqual(['user']);
    expect(archived.memberships.filter((value: any) => value.namespace === 'migration')).toEqual([]);
    // Ignored, not removed: the rows stay in the file as they were.
    expect(metadataKeys(file)).toContain('migration');
    expect(repository.collections('migration')).toHaveLength(1);
  });
});
