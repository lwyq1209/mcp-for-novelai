import { afterEach, describe, expect, it } from 'vitest';
import { runCleanupsSync } from '../../src/test-support/temp-dirs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LIBRARY_CHANGE_ID_LIMIT, libraryChangeNotice, openLibraryRepository, type LibraryChange, type LibraryRepository } from './repository';

const roots: string[] = [], connections: LibraryRepository[] = [];
function open() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-library-change-')); roots.push(root);
  const repository = openLibraryRepository({ filePath: path.join(root, 'library.sqlite'), libraryDirectory: path.join(root, 'library') }); connections.push(repository);
  const seen: Array<[number, LibraryChange]> = [];
  repository.subscribe((revision, change) => { seen.push([revision, change]); });
  return { repository, seen, root };
}
afterEach(() => runCleanupsSync([...connections.splice(0).map(value => () => value.close()), ...roots.splice(0).map(root => () => fs.rmSync(root, { recursive: true, force: true }))]));
const image = (root: string, id: string, extra: Record<string, unknown> = {}) => ({ id, date: '2026-11-01', filePath: path.join(root, 'out', `${id}.png`), params: { positivePrompt: id }, ...extra });

describe('library change announcements', () => {
  it('announces nothing for a rolled-back transaction and once, after COMMIT, for a committed one', () => {
    const { repository, seen } = open();
    expect(() => repository.transaction(() => { repository.put('note', 'a', { name: 'a' }); repository.put('tag', 't', { name: 't' }); throw new Error('abort'); })).toThrow('abort');
    expect(() => repository.put('note', 'a', { name: 'a' }, { expectedRevision: 3 })).toThrow(/changed/);
    expect(seen).toEqual([]);
    expect(repository.get('note', 'a')).toBeNull();
    repository.transaction(() => { repository.put('note', 'a', { name: 'a' }); repository.put('tag', 't', { name: 't' }); });
    expect(seen).toEqual([[1, { changedKinds: ['note', 'tag'], ids: ['a', 't'] }]]);
  });

  it('collects nested transactions, puts, removes and asset writes into the outer announcement', () => {
    const { repository, seen, root } = open();
    repository.put('history', 'old', image(root, 'old'));
    seen.length = 0;
    // linkAsset needs its owner: the nested writes before the failure roll back with the outer transaction.
    expect(() => repository.transaction(() => {
      repository.transaction(() => { repository.put('history', 'h1', image(root, 'h1')); repository.put('history', 'h1', image(root, 'h1', { groupId: 'g' }), { expectedRevision: 1 }); });
      repository.remove('history', 'old');
      repository.putAsset({ id: 'loose', payload: { filePath: path.join(root, 'loose.png') } });
      repository.linkAsset({ kind: 'note', id: 'n', role: 'x', assetId: 'loose' });
    })).toThrow();
    expect(seen).toEqual([]);
    expect(repository.get('history', 'old')).not.toBeNull();
    repository.transaction(() => {
      repository.transaction(() => { repository.put('history', 'h1', image(root, 'h1')); repository.put('history', 'h1', image(root, 'h1', { groupId: 'g' }), { expectedRevision: 1 }); });
      repository.remove('history', 'old');
      repository.put('note', 'n', { name: 'n' });
      repository.putAsset({ id: 'loose', payload: { filePath: path.join(root, 'loose.png') } });
      repository.linkAsset({ kind: 'note', id: 'n', role: 'x', assetId: 'loose' });
    });
    expect(seen).toHaveLength(1);
    // A new group used by a put is a collection change of the history namespace: kinds only.
    expect(seen[0][1]).toEqual({ changedKinds: ['history', 'note'] });
    seen.length = 0;
    repository.transaction(() => { repository.put('history', 'h2', image(root, 'h2', { groupId: 'g' })); repository.remove('history', 'h1'); });
    expect(seen).toEqual([[expect.any(Number), { changedKinds: ['history'], ids: ['h1', 'h2'] }]]);
  });

  it('omits ids above the limit, keeping the kinds', () => {
    const { repository, seen } = open();
    repository.transaction(() => { for (let index = 0; index < LIBRARY_CHANGE_ID_LIMIT; index++) repository.put('note', `n${index}`, { name: `n${index}` }); });
    expect(seen[0][1].ids).toHaveLength(LIBRARY_CHANGE_ID_LIMIT);
    repository.transaction(() => { for (let index = 0; index <= LIBRARY_CHANGE_ID_LIMIT; index++) repository.put('note', `m${index}`, { name: `m${index}` }); });
    expect(seen[1][1]).toEqual({ changedKinds: ['note'] });
  });

  it('classifies collections, memberships, covers, assets and bookkeeping-only writes', () => {
    const { repository, seen, root } = open();
    repository.put('tag', 'tag', { name: 'cup' });
    repository.put('history', 'h', image(root, 'h'));
    seen.length = 0;
    repository.putCollection({ namespace: 'history', id: 'g2', name: 'g2', payload: {} });
    repository.putCollection({ namespace: 'library', id: 'mine', name: 'Mine', payload: {} });
    repository.setMembership({ namespace: 'library', collectionId: 'mine', kind: 'tag', id: 'tag' });
    repository.deleteCollection('style', 'old');
    repository.setCover('tag', 'tag', null);
    repository.putFileOperation({ id: 'op', action: 'create', state: 'pending', payload: {}, createdAt: '2026-11-01T00:00:00.000Z' });
    repository.completeFileOperation('op');
    expect(repository.remove('note', 'missing')).toBeNull();
    expect(seen.map(([, change]) => change)).toEqual([
      { changedKinds: ['history'] },
      {},
      { changedKinds: ['tag'], ids: ['tag'] },
      { changedKinds: ['style_preset'] },
      { changedKinds: ['tag'], ids: ['tag'] },
      { changedKinds: [], ids: [] },
      { changedKinds: [], ids: [] },
      { changedKinds: [], ids: [] },
    ]);
    seen.length = 0;
    // A standalone asset rewrite names the items linking it, and nothing when the bytes are identical.
    const [linked] = repository.itemAssets('history', 'h');
    repository.putAsset({ id: linked.id, payload: linked.payload });
    repository.putAsset({ id: linked.id, payload: { ...linked.payload, availability: 'missing' } });
    repository.putAsset({ id: 'staged', payload: { filePath: path.join(root, 'staged.png') } });
    expect(seen.map(([, change]) => change)).toEqual([{ changedKinds: [], ids: [] }, { changedKinds: ['history'], ids: ['h'] }, { changedKinds: [], ids: [] }]);
  });

  it('marks explicitly unclassified and import writes as unknown', () => {
    const { repository, seen } = open();
    repository.transaction(() => { repository.put('note', 'a', { name: 'a' }); }, { unknownChange: true });
    repository.transaction(() => { repository.put('note', 'b', { name: 'b' }); repository.transaction(() => repository.put('note', 'c', { name: 'c' }), { unknownChange: true }); });
    const other = open();
    other.repository.importSnapshot(repository.exportSnapshot());
    expect(seen.map(([, change]) => change)).toEqual([{}, {}]);
    expect(other.seen.map(([, change]) => change)).toEqual([{}]);
  });

  it('gives listeners a frozen change and forwards it to the renderer as plain arrays', () => {
    const { repository, seen } = open();
    repository.put('note', 'a', { name: 'a' });
    const [revision, change] = seen[0];
    expect(Object.isFrozen(change)).toBe(true);
    expect(Object.isFrozen(change.changedKinds)).toBe(true);
    const notice = libraryChangeNotice(revision, change);
    expect(notice).toEqual({ revision, changedKinds: ['note'], ids: ['a'] });
    expect(Object.isFrozen(notice.changedKinds)).toBe(false);
    expect(libraryChangeNotice(7, {})).toEqual({ revision: 7 });
    expect(libraryChangeNotice(8, { changedKinds: ['history'] })).toEqual({ revision: 8, changedKinds: ['history'] });
  });
});
