import { afterEach, describe, expect, it } from 'vitest';
import { runCleanupsSync } from '../../src/test-support/temp-dirs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLibraryRepository, type LibraryRepository } from './repository';

const roots: string[] = [], connections: LibraryRepository[] = [];
function open() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-library-test-')); roots.push(root);
  const filePath = path.join(root, 'library.sqlite');
  const repository = openLibraryRepository({ filePath }); connections.push(repository);
  return { repository, filePath };
}
afterEach(() => runCleanupsSync([...connections.splice(0).map(value => () => value.close()), ...roots.splice(0).map(root => () => fs.rmSync(root, { recursive: true, force: true }))]));

describe('unified library repository', () => {
  it('retains every authored revision and exact source text across reopening', () => {
    const { repository: repo, filePath } = open();
    const original = { id: 'tag-1', name: '茶杯', notes: '  a porcelain cup\n', tag: { text: 'teacup', source: 'danbooru', target: 'base' }, revision: 4 };
    repo.put('tag', 'tag-1', original, { revision: 4 });
    repo.put('tag', 'tag-1', { ...original, notes: 'on a wooden table', revision: 5 }, { revision: 5, expectedRevision: 4 });
    expect(() => repo.put('tag', 'tag-1', original, { expectedRevision: 4 })).toThrow(/changed/);
    expect(repo.get('tag', 'tag-1', 4)?.payload).toEqual(original);
    repo.close();
    const reopened = openLibraryRepository({ filePath }); connections.push(reopened);
    expect(reopened.readVersions('tag', 'tag-1').map(item => item.revision)).toEqual([4, 5]);
    expect(reopened.get('tag', 'tag-1', 4)?.payload.notes).toBe('  a porcelain cup\n');
  });

  it('searches tags, full Chinese substrings and one-character terms without SQL/query syntax interpretation', () => {
    const { repository: repo } = open();
    repo.put('note', 'n1', { name: '雨夜茶杯', notes: 'dark_blue porcelain cup, artist_(sample) and "quoted"', group: '灯光' });
    repo.put('note', 'n2', { name: '山', notes: 'quiet landscape', group: '背景' });
    for (const query of ['雨', '夜茶', '雨夜茶', 'dark_blue', 'artist_(sample)', '"quoted"']) expect(repo.list({ query }).items.map(item => item.id)).toEqual(['n1']);
    expect(repo.list({ query: "' OR 1=1 --" }).total).toBe(0);
    expect(repo.list({ group: '灯光' }).items.map(item => item.id)).toEqual(['n1']);
  });

  it('keeps collection membership, source namespaces, relations and cover revisions separate', () => {
    const { repository: repo } = open();
    repo.put('history', 'image-1', { id: 'image-1', name: 'cup', actualSeed: 7 });
    repo.put('artist_favorite', 'random:same', { id: 'same', collection: 'random', name: 'cup' }, { source: { namespace: 'artist-favorites:random', legacyId: 'same' } });
    repo.put('artist_favorite', 'v5-repair:same', { id: 'same', collection: 'v5-repair', name: 'cup' }, { source: { namespace: 'artist-favorites:v5-repair', legacyId: 'same' } });
    repo.put('tag', 't', { name: 'porcelain' });
    repo.putCollection({ namespace: 'artist-favorites', id: 'random', name: 'Random favorites', payload: {} });
    repo.setMembership({ namespace: 'artist-favorites', collectionId: 'random', kind: 'artist_favorite', id: 'random:same' });
    repo.setRelations('artist_favorite', 'random:same', 1, [{ targetKind: 'history', targetId: 'image-1', payload: { role: 'result' } }]);
    repo.setCover('tag', 't', { sha256: 'sample', sourceUrl: 'https://example.invalid/general' }, 0);
    expect(repo.getCover('tag', 't').coverRevision).toBe(1);
    expect(repo.get('tag', 't')?.revision).toBe(1);
    repo.setMembership({ namespace: 'artist-favorites', collectionId: 'random', kind: 'artist_favorite', id: 'random:same' }, false);
    expect(repo.get('history', 'image-1')).not.toBeNull();
    expect(repo.relations({ targetKind: 'history', targetId: 'image-1' })).toHaveLength(1);
    expect(repo.all('artist_favorite')).toHaveLength(2);
  });

  it('rolls back a failed multi-item transaction and emits only after a successful commit', () => {
    const { repository: repo } = open(), revisions: number[] = [];
    repo.subscribe(revision => revisions.push(revision));
    expect(() => repo.tx(() => { repo.put('note', 'a', { name: 'cup' }); repo.put('note', 'a', { name: 'other' }, { expectedRevision: 0 }); })).toThrow();
    expect(repo.get('note', 'a')).toBeNull(); expect(revisions).toEqual([]); expect(repo.getRevision()).toBe(0);
    repo.tx(() => { repo.put('note', 'a', { name: 'cup' }); repo.put('note', 'b', { name: 'plant' }); });
    expect(revisions).toEqual([1]);
  });

  it('exports and imports complete versions, dangling provenance and pending file operations', () => {
    const { repository: first } = open(), { repository: second } = open();
    first.put('study', 'study', { study: { id: 'study', revision: 8, name: 'General still life' }, notes: 'Original note' }, { revision: 8, name: 'General still life' });
    first.setRelations('study', 'study', 8, [{ targetId: 'external-batch', payload: { batchId: 'external-batch' } }]);
    first.putAsset({ id: 'image', payload: { path: '/fixture/original.png', sha256: 'example', mimeType: 'image/png' } });
    first.linkAsset({ kind: 'study', id: 'study', role: 'original', assetId: 'image' });
    first.putFileOperation({ id: 'rename-1', action: 'rename', state: 'pending', payload: { from: '/fixture/a.png', to: '/fixture/b.png' }, createdAt: '2026-09-12T00:00:00.000Z' });
    second.importSnapshot(first.exportSnapshot());
    expect(second.exportSnapshot()).toEqual(first.exportSnapshot());
    expect(second.integrityCheck()).toBe('ok');
    expect(() => second.importSnapshot(first.exportSnapshot())).toThrow(/empty/);
  });

  it('projects new writes and preserves manual collection membership when a source group changes', () => {
    const { repository: repo } = open();
    repo.put('tag','tag',{name:'cup'});
    repo.put('combo','combo',{name:'still life',group:'old',components:[{entryId:'tag',entryRevision:1}],links:[{batchId:'batch'}]});
    repo.putCollection({namespace:'library',id:'manual',name:'Selected',payload:{}});
    repo.setMembership({namespace:'library',collectionId:'manual',kind:'combo',id:'combo'});
    repo.put('combo','combo',{name:'still life',group:'new',components:[{entryId:'tag',entryRevision:1}],links:[{batchId:'batch'}]},{expectedRevision:1});
    expect(repo.memberships('combo','combo').map(item=>item.collectionId).sort()).toEqual(['manual','new']);
    expect(repo.relations({kind:'combo',id:'combo',revision:2}).map(item=>item.targetId)).toEqual(['tag','batch']);
    const { repository: restored } = open();
    repo.setMembership({namespace:'material',collectionId:'new',kind:'combo',id:'combo'},false);
    restored.importSnapshot(repo.exportSnapshot());
    expect(restored.exportSnapshot()).toEqual(repo.exportSnapshot());
  });

  it('starts a fresh transaction when a committed-change observer performs a follow-up write', () => {
    const { repository: repo } = open(), revisions:number[]=[];
    repo.subscribe(value=>{revisions.push(value);if(value===1)repo.put('note','second',{name:'second'});});
    repo.put('note','first',{name:'first'});
    expect(revisions).toEqual([1,2]);expect(repo.getRevision()).toBe(2);
  });

  it('lists the history images of one queue batch or request key from their provenance only (issue #1)', () => {
    const { repository: repo } = open();
    const generation = (jobId: string) => ({ jobId, mode: 't2i', originWorkspaceId: 'recipe-queue', submittedRevision: 0, actualSeed: 1 });
    repo.put('history', 'a-0', { id: 'a-0', generationOrigin: generation('j1'), queueOrigin: { batchId: 'batch-a', requestKey: 'mcp-a', itemIndex: 0 } });
    repo.put('history', 'a-1', { id: 'a-1', generationOrigin: generation('j2'), queueOrigin: { batchId: 'batch-a', requestKey: 'mcp-a', itemIndex: 1 } });
    repo.put('history', 'b-0', { id: 'b-0', generationOrigin: generation('j3'), queueOrigin: { batchId: 'batch-b', requestKey: 'mcp-b', itemIndex: 0 } });
    repo.put('history', 'old', { id: 'old', generationOrigin: generation('j4') });
    repo.put('history', 'manual', { id: 'manual' });
    // A note that merely carries the same values is not a queue image; neither is a value inside generationOrigin.
    repo.put('note', 'n', { name: 'batch-a', queueOrigin: { batchId: 'batch-a', requestKey: 'mcp-a', itemIndex: 0 } });
    repo.put('history', 'odd', { id: 'odd', generationOrigin: { ...generation('j5'), batchId: 'batch-a', requestKey: 'mcp-a' } });
    const ids = (filters: Parameters<typeof repo.list>[0]) => repo.list(filters).items.map(item => item.id).sort();
    expect(ids({ queueBatchId: 'batch-a' })).toEqual(['a-0', 'a-1']);
    expect(ids({ queueRequestKey: 'mcp-b' })).toEqual(['b-0']);
    expect(ids({ queueRequestKey: 'mcp-a', queueBatchId: 'batch-b' })).toEqual([]);
    expect(ids({ queueBatchId: 'batch-a', kinds: ['history'], query: 'nothing-matches' })).toEqual([]);
    expect(repo.list({ queueBatchId: 'missing' })).toMatchObject({ items: [], total: 0 });
    expect(() => repo.list({ queueBatchId: '' })).toThrow(/Invalid library/);
  });
});
