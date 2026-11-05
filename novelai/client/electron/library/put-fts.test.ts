// put() skips the full-table FTS delete for a new identity (2026-11-01). The FTS rows must stay exactly
// one per stored item, and search results must not change, including next to a stray FTS row.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCleanupsSync } from '../../src/test-support/temp-dirs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { openLibraryRepository, type LibraryRepository } from './repository';

const roots: string[] = [], closers: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); closers.splice(0).reverse().forEach(close => { try { close(); } catch { /* closed */ } }); runCleanupsSync(roots.splice(0).map(root => () => fs.rmSync(root, { recursive: true, force: true }))); });
function open() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-put-fts-')); roots.push(root);
  const filePath = path.join(root, 'library.sqlite');
  const repository = openLibraryRepository({ filePath }); closers.push(() => repository.close());
  const reader = new DatabaseSync(filePath, { readOnly: true }); closers.push(() => reader.close());
  return { repository, reader, filePath };
}
const ftsRows = (db: DatabaseSync) => db.prepare('SELECT kind,id,search_text FROM items_fts ORDER BY kind,id,search_text').all().map(row => ({ ...row }));
const itemRows = (db: DatabaseSync) => db.prepare('SELECT kind,id,search_text FROM items ORDER BY kind,id,search_text').all().map(row => ({ ...row }));
const found = (repository: LibraryRepository, query: string) => repository.list({ query, limit: 50 }).items.map(item => `${item.kind}:${item.id}`).sort();

describe('put keeps one FTS row per item', () => {
  it('new, updated, removed, re-created, nested and rolled-back writes leave exactly the items rows in items_fts', () => {
    const { repository, reader } = open();
    repository.put('history', 'a', { id: 'a', params: { positivePrompt: 'alpha sunrise' } });
    repository.put('note', 'a', { name: 'a note', notes: 'beta harbor' });
    repository.put('history', 'b', { id: 'b', params: { positivePrompt: 'gamma forest' } });
    expect(ftsRows(reader)).toEqual(itemRows(reader));
    repository.put('history', 'a', { id: 'a', params: { positivePrompt: 'delta canyon' } }, { expectedRevision: 1 });
    const b = repository.get('history', 'b')!; repository.put('history', 'b', b.payload, { expectedRevision: b.revision, archived: true });
    expect(ftsRows(reader)).toEqual(itemRows(reader));
    repository.remove('history', 'b');
    expect(ftsRows(reader)).toEqual(itemRows(reader));
    // Re-created after removal, written twice in one transaction, and removed + re-created in one transaction.
    repository.transaction(() => {
      repository.put('history', 'b', { id: 'b', params: { positivePrompt: 'epsilon meadow' } });
      repository.put('history', 'b', { id: 'b', params: { positivePrompt: 'zeta glacier' } }, { expectedRevision: 1 });
      repository.remove('history', 'a');
      repository.put('history', 'a', { id: 'a', params: { positivePrompt: 'eta lagoon' } });
    });
    expect(ftsRows(reader)).toEqual(itemRows(reader));
    expect(() => repository.transaction(() => { repository.put('history', 'c', { id: 'c', params: { positivePrompt: 'theta' } }); throw new Error('abort'); })).toThrow('abort');
    expect(ftsRows(reader)).toEqual(itemRows(reader));
    // Import of several revisions of one new identity.
    const snapshot = repository.exportSnapshot();
    const { repository: target, reader: targetReader } = open();
    target.importSnapshot(snapshot);
    expect(ftsRows(targetReader)).toEqual(itemRows(targetReader));
    expect(ftsRows(targetReader)).toEqual(ftsRows(reader));
    expect(found(repository, 'zeta glacier')).toEqual(['history:b']);
    expect(found(repository, 'epsilon')).toEqual([]);
    expect(found(repository, 'delta')).toEqual([]);
    expect(found(repository, 'lagoon')).toEqual(['history:a']);
    expect(found(repository, 'harbor')).toEqual(['note:a']);
  });

  it('runs the FTS delete only when the identity already exists', () => {
    const { repository } = open();
    const run = vi.spyOn(StatementSync.prototype, 'run');
    const deletes = () => run.mock.contexts.filter(statement => (statement as StatementSync).sourceSQL.startsWith('DELETE FROM items_fts')).length;
    repository.put('history', 'new', { id: 'new', params: { positivePrompt: 'one' } });
    expect(deletes()).toBe(0);
    repository.put('history', 'new', { id: 'new', params: { positivePrompt: 'two' } }, { expectedRevision: 1 });
    expect(deletes()).toBe(1);
    repository.remove('history', 'new');
    expect(deletes()).toBe(2);
  });

  it('a stray FTS row (never written by this repository) does not change search results and goes with the next update', () => {
    const { repository, reader, filePath } = open();
    const raw = new DatabaseSync(filePath); closers.push(() => raw.close());
    raw.prepare('INSERT INTO items_fts(kind,id,search_text) VALUES(?,?,?)').run('history', 'x', 'orphan lighthouse');
    repository.put('history', 'x', { id: 'x', params: { positivePrompt: 'iota desert' } });
    expect(found(repository, 'lighthouse')).toEqual([]);
    expect(found(repository, 'desert')).toEqual(['history:x']);
    expect(ftsRows(reader).filter(row => row.id === 'x')).toHaveLength(2);
    repository.put('history', 'x', { id: 'x', params: { positivePrompt: 'kappa tundra' } }, { expectedRevision: 1 });
    expect(ftsRows(reader)).toEqual(itemRows(reader));
    expect(found(repository, 'tundra')).toEqual(['history:x']);
  });
});
