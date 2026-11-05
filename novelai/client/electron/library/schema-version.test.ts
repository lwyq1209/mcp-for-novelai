// The library version rule (LIBRARY_SCHEMA_VERSION in repository.ts): an open accepts only version 8, a writable
// open of a new file creates it at 8, and every other version is refused without changing the file.
import { afterEach, describe, expect, it } from 'vitest';
import { runCleanupsSync } from '../../src/test-support/temp-dirs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { LIBRARY_SCHEMA_VERSION, openLibraryRepository, type LibraryRepository } from './repository';

const roots: string[] = [], repositories: LibraryRepository[] = [];
afterEach(() => runCleanupsSync([...repositories.splice(0).map(repository => () => repository.close()), ...roots.splice(0).map(root => () => fs.rmSync(root, { recursive: true, force: true }))]));
const now = '2026-11-02T00:00:00.000Z';
const tag = (id: string) => ({ schemaVersion: 1, id, revision: 1, kind: 'tag', name: id, group: '', notes: '', archived: false, createdAt: now, updatedAt: now, tag: { text: id, source: 'english', category: null, target: 'base' } });
function folder() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-library-version-')); roots.push(root); return root; }
function open(options: Parameters<typeof openLibraryRepository>[0]) { const repository = openLibraryRepository(options); repositories.push(repository); return repository; }
function close(repository: LibraryRepository) { repositories.splice(repositories.indexOf(repository), 1); repository.close(); }
/** A database file of the given version holding one table (the shape does not matter: the version alone decides). */
function databaseOf(version: number, withTable = true) {
  const root = folder(), file = path.join(root, 'library.sqlite'), db = new DatabaseSync(file);
  try {
    if (withTable) db.exec("CREATE TABLE items(kind TEXT NOT NULL,id TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(kind,id)); INSERT INTO items VALUES('tag','kept','{}')");
    db.exec(`PRAGMA user_version=${version}`);
  } finally { db.close(); }
  return { root, file };
}
/** Everything in the folder with its bytes and modification time: a refusal must leave all of it as it was. */
function state(root: string) {
  return Object.fromEntries(fs.readdirSync(root).sort().map(name => {
    const file = path.join(root, name), info = fs.statSync(file);
    return [name, { sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'), mtimeMs: info.mtimeMs, mode: info.mode }];
  }));
}
const versionOf = (file: string) => { const db = new DatabaseSync(file, { readOnly: true }); try { return Number((db.prepare('PRAGMA user_version').get() as any).user_version); } finally { db.close(); } };
const tablesOf = (file: string) => { const db = new DatabaseSync(file, { readOnly: true }); try { return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'items_fts%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name); } finally { db.close(); } };

describe('library schema version', () => {
  it('is 8', () => expect(LIBRARY_SCHEMA_VERSION).toBe(8));

  it('creates a new library at version 8 with the core tables only, and opens it again read-only and writable', () => {
    const root = folder(), file = path.join(root, 'library.sqlite');
    const created = open({ filePath: file }); created.put('tag', 'fresh', tag('fresh')); close(created);
    expect(versionOf(file)).toBe(8);
    expect(tablesOf(file)).toEqual(['asset_links', 'assets', 'collections', 'covers', 'file_operations', 'history_tags', 'items', 'memberships', 'metadata', 'relations', 'versions']);
    const readOnly = open({ filePath: file, readOnly: true }); expect(readOnly.get('tag', 'fresh')?.payload.name).toBe('fresh'); close(readOnly);
    const writable = open({ filePath: file }); writable.put('tag', 'second', tag('second')); expect(writable.integrityCheck()).toBe('ok'); close(writable);
    expect(versionOf(file)).toBe(8);
  });

  it('refuses a library of an older version (1–7), read-only or writable, without changing any file', () => {
    for (const version of [1, 2, 3, 4, 5, 6, 7]) {
      const { root, file } = databaseOf(version), before = state(root);
      for (const readOnly of [true, false]) {
        let error: any;
        try { openLibraryRepository({ filePath: file, readOnly }); } catch (caught) { error = caught; }
        expect(error, `v${version} readOnly=${readOnly}`).toMatchObject({ code: 'library_schema_unsupported', message: expect.stringMatching(new RegExp(`created by an unsupported older version \\(library version ${version}\\)`)) });
        expect(state(root), `v${version} readOnly=${readOnly}: nothing changed`).toEqual(before);
      }
      expect(versionOf(file)).toBe(version);
    }
  });

  it('refuses a library of an older version at startup too, before the history tag index or anything else touches it', async () => {
    const { initializeAssetLibrary } = await import('../library-startup');
    const { root } = databaseOf(7), before = state(root);
    await expect(initializeAssetLibrary({ userDataRoot: root, libraryDirectory: path.join(root, 'library'), useWorker: false })).rejects.toMatchObject({ code: 'library_schema_unsupported' });
    expect(state(root)).toEqual(before);
  });

  it('refuses a library of a newer version without changing it', () => {
    for (const version of [9, 10]) {
      const { root, file } = databaseOf(version), before = state(root);
      expect(() => openLibraryRepository({ filePath: file })).toThrow(/newer client/);
      expect(() => openLibraryRepository({ filePath: file, readOnly: true })).toThrow(/newer client/);
      expect(state(root)).toEqual(before);
    }
  });

  it('refuses a version-0 file that already holds tables with one answer on every path, and reads no uninitialized file', async () => {
    const { root, file } = databaseOf(0), before = state(root);
    const answers: Array<{ code: string; message: string }> = [];
    for (const readOnly of [false, true]) {
      try { openLibraryRepository({ filePath: file, readOnly }); } catch (error: any) { answers.push({ code: error.code, message: error.message }); }
    }
    // The startup path (main.ts) refuses it the same way.
    const { initializeAssetLibrary } = await import('../library-startup');
    try { await initializeAssetLibrary({ userDataRoot: root, libraryDirectory: path.join(root, 'library'), useWorker: false }); }
    catch (error: any) { answers.push({ code: error.code, message: error.message }); }
    expect(answers).toHaveLength(3);
    for (const answer of answers) expect(answer).toEqual({ code: 'library_schema_unsupported', message: 'This file is not a library this app can recognize: it holds tables but no library version. The file was not changed.' });
    expect(state(root)).toEqual(before);
    const blank = databaseOf(0, false);
    expect(() => openLibraryRepository({ filePath: blank.file, readOnly: true })).toThrow(/not been initialized/);
  });

  it('imports only a version-1 library snapshot', () => {
    const source = open({ filePath: path.join(folder(), 'library.sqlite') }); source.put('tag', 'snap', tag('snap'));
    const snapshot = source.exportSnapshot(); expect(snapshot.schemaVersion).toBe(1);
    const target = open({ filePath: path.join(folder(), 'library.sqlite') });
    expect(() => target.importSnapshot({ ...snapshot, schemaVersion: 2 } as never)).toThrow(/Unsupported library snapshot/);
    expect(target.all()).toEqual([]);
    target.importSnapshot(snapshot);
    expect(target.get('tag', 'snap')?.payload.name).toBe('snap');
  });
});
