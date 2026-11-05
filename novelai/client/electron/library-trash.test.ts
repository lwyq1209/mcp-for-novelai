import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { runCleanupsSync } from '../src/test-support/temp-dirs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openLibraryRepository, type LibraryRepository } from './library/repository';
import { createLibraryTrash, TRASH_RETENTION_MS, type LibraryTrashOptions } from './library-trash';
import type { LibraryKind } from './library/types';

// Real repository, real files, real service: every fixture lives in a throwaway data root.
const roots: string[] = [], repositories: LibraryRepository[] = [];
afterEach(() => { for (const repo of repositories.splice(0)) { try { repo.close(); } catch { /* closed by the test */ } } runCleanupsSync(roots.splice(0).map(root => () => fs.rmSync(root, { recursive: true, force: true }))); });
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const DAY = 24 * 60 * 60 * 1000;

function fixture(extra: Partial<LibraryTrashOptions> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-trash-')); roots.push(root);
  const library = path.join(root, 'library'), output = path.join(root, 'output'), database = path.join(root, 'library.sqlite');
  fs.mkdirSync(library, { recursive: true }); fs.mkdirSync(output, { recursive: true });
  const open = () => { const repo = openLibraryRepository({ filePath: database, libraryDirectory: library, userDataRoot: root }); repositories.push(repo); return repo; };
  const repo = open();
  const clock = { now: Date.parse('2026-11-02T00:00:00.000Z') };
  const service = (repository: LibraryRepository = repo, more: Partial<LibraryTrashOptions> = {}) => createLibraryTrash({ repository, userDataRoot: root, libraryDirectory: library, managedRoots: () => [output], toFileUrl: file => `fixture:${file}`, now: () => clock.now, log: () => undefined, ...extra, ...more });
  const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(text)); return file; };
  const history = (id: string, file = path.join(output, '2026-11-02', `${id}.png`), extraPayload: Record<string, unknown> = {}) => {
    write(file, `SFW teacup image ${id}`);
    return repo.put('history', id, { id, filePath: file, fileUrl: `fixture:${file}`, date: '2026-11-02', createdAt: '2026-11-02T00:00:00.000Z', params: { positivePrompt: `teacup ${id}` }, actualSeed: 7, model: 'nai-diffusion-4-5-full', width: 8, height: 8, ...extraPayload });
  };
  const study = () => {
    const id = randomUUID(), folder = path.join(library, 'studies', id), original = Buffer.from(`study original ${id}`), preview = Buffer.from(`study preview ${id}`);
    write(path.join(folder, 'original.png'), original.toString()); write(path.join(folder, 'preview.webp'), preview.toString());
    const item = repo.put('study', id, { schemaVersion: 1, parserVersion: 1, study: { id, revision: 1, name: 'garden study', sha256: sha(original), mimeType: 'image/png', width: 8, height: 8, byteLength: original.length, sourceUrl: '', sourceAuthor: '', createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z', archived: false, metadataStatus: 'missing', metadataKind: 'unknown', sources: [], warnings: [], promptFieldCount: 0, parameterFieldCount: 0 }, notes: '', previewSha256: sha(preview), previewByteLength: preview.length }, { revision: 1 });
    return { item, folder };
  };
  const cover = (tagId: string, fileName: string, bytes = `cover for ${tagId} ${fileName}`) => {
    const data = Buffer.from(bytes), digest = sha(data);
    write(path.join(library, 'covers', `${digest}.webp`), bytes);
    const current = repo.getCover('tag', tagId);
    return repo.setCover('tag', tagId, { sha256: digest, mimeType: 'image/webp', width: 8, height: 8, byteLength: data.length, postId: null, sourceUrl: null, tagText: 'teacup', tagCategory: null, rating: null, savedAt: '2026-11-02T00:00:00.000Z', verification: 'local', checkedAt: null, source: 'local', fileName, sourceSha256: digest, tagSource: 'english' }, { expectedRevision: current.coverRevision });
  };
  const tag = (name = 'teacup') => { const id = randomUUID(); return repo.put('tag', id, { id, schemaVersion: 1, kind: 'tag', name, group: '', notes: '', tag: { text: name, source: 'english', target: 'base', category: null }, revision: 1, archived: false, createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z' }); };
  return { root, library, output, database, repo, open, clock, service, write, history, study, cover, tag };
}
const exists = (file: string) => fs.existsSync(file);
const folderFiles = (folder: string) => fs.existsSync(folder) ? fs.readdirSync(folder, { recursive: true }).map(String).sort() : [];

describe('Recently Deleted: every kind goes in and comes back exactly', () => {
  it('history: rows and the original move to the trash folder and back, versions and memberships unchanged', async () => {
    const f = fixture(), trash = f.service();
    const item = f.history('h1');
    f.repo.put('history', 'h1', { ...item.payload, params: { positivePrompt: 'teacup, revised' } }, { expectedRevision: 1 });
    f.repo.putCollection({ namespace: 'user', id: 'u1', name: 'Favourites', payload: {} });
    f.repo.setMembership({ namespace: 'user', collectionId: 'u1', kind: 'history', id: 'h1' });
    const versions = f.repo.readVersions('history', 'h1'), memberships = f.repo.memberships('history', 'h1'), relations = f.repo.relations({ kind: 'history', id: 'h1' }), assets = f.repo.itemAssets('history', 'h1');
    const file = item.payload.filePath as string, bytes = fs.readFileSync(file);
    const receipt = await trash.deleteItems([{ kind: 'history', id: 'h1', expectedRevision: 2 }]);
    expect(receipt.deleted).toHaveLength(1);
    const deleted = receipt.deleted[0] as any;
    expect(deleted).toMatchObject({ kind: 'history', id: 'h1', revision: 2, files: { moved: 1, kept: 0, missing: 0 }, impacts: { collections: [{ collectionId: 'user:u1', name: 'Favourites' }] } });
    expect(Date.parse(deleted.expiresAt) - Date.parse(deleted.deletedAt)).toBe(TRASH_RETENTION_MS);
    expect(f.repo.get('history', 'h1')).toBeNull();
    expect(f.repo.list({ kinds: ['history'], includeArchived: true }).total).toBe(0);
    expect(f.repo.historyOrder()).toEqual([]);
    expect(f.repo.list({ query: 'revised' }).total).toBe(0);
    expect(f.repo.memberships('history', 'h1')).toEqual([]);
    expect(exists(file)).toBe(false);
    expect(folderFiles(path.join(f.root, 'trash', deleted.trashId))).toHaveLength(1);
    const listed = trash.list();
    expect(listed.entries).toMatchObject([{ trashId: deleted.trashId, kind: 'history', id: 'h1', revision: 2, files: { moved: 1 } }]);
    const restored = await trash.restore([deleted.trashId]);
    expect(restored.restored).toMatchObject([{ kind: 'history', id: 'h1', revision: 2, files: { restored: 1, relocated: 0 }, collections: { restored: ['user:u1'] } }]);
    expect(f.repo.readVersions('history', 'h1')).toEqual(versions);
    expect(f.repo.memberships('history', 'h1')).toEqual(memberships);
    expect(f.repo.relations({ kind: 'history', id: 'h1' })).toEqual(relations);
    expect(f.repo.itemAssets('history', 'h1')).toEqual(assets);
    expect(f.repo.historyOrder()).toEqual(['h1']);
    // Full-text search finds it again (its search row came back with it).
    expect(f.repo.list({ query: 'revised' }).items.map(value => value.id)).toEqual(['h1']);
    expect(fs.readFileSync(file)).toEqual(bytes);
    expect(exists(path.join(f.root, 'trash', deleted.trashId))).toBe(false);
    expect(trash.list().total).toBe(0);
    expect(f.repo.pendingFileOps()).toEqual([]);
  });

  it('study, tag with cover, combo, note, presets, prompt chunk, reference preset and artist favorite', async () => {
    const f = fixture(), trash = f.service();
    const { item: studyItem, folder } = f.study();
    const tagItem = f.tag(); f.cover(tagItem.id, 'teacup.png');
    const combo = f.repo.put('combo', randomUUID(), { schemaVersion: 1, kind: 'combo', name: 'cup combo', group: '', notes: '', components: [{ entryId: tagItem.id, text: 'teacup', source: 'english', weight: 1, target: 'base' }] });
    const note = f.repo.put('note', randomUUID(), { schemaVersion: 1, kind: 'note', name: 'study note', group: '', notes: 'quote', links: [{ studyId: studyItem.id, sourceSha256: 'a'.repeat(64), field: 'prompt', excerpt: 'teacup' }] });
    const styleId = randomUUID(), previewFolder = path.join(f.root, 'style-prompt-previews', styleId), preview = f.write(path.join(previewFolder, 'p1.png'), 'style preview');
    f.write(path.join(previewFolder, 'manifest.json'), '{}');
    const style = f.repo.put('style_preset', styleId, { id: styleId, name: 'ink', prompt: 'ink', group: 'Looks', createdAt: '2026-11-02T00:00:00Z', previewImages: [{ id: 'p1', name: 'p1.png', filePath: preview, fileUrl: `fixture:${preview}`, createdAt: '2026-11-02T00:00:00Z' }] });
    const positive = f.repo.put('positive_preset', randomUUID(), { id: 'pp', name: 'positive', prompt: 'teacup' });
    const chunk = f.repo.put('prompt_chunk', randomUUID(), { id: 'pc', name: 'chunk', content: 'teacup' });
    const referenceId = randomUUID(), referenceFile = f.write(path.join(f.root, 'reference-presets', `${referenceId}.png`), 'reference image');
    const reference = f.repo.put('reference_preset', referenceId, { id: referenceId, name: 'ref', group: '', kind: 'precise', preciseType: 'character', strength: 1, fidelity: 1, informationExtracted: 1, filePath: referenceFile, createdAt: '2026-11-02T00:00:00Z' });
    const historyItem = f.history('fav-source');
    const favorite = f.repo.put('artist_favorite', 'random:fav', { id: 'fav', collection: 'random', artists: [], prompt: 'teacup', image: historyItem.payload });
    const all = [studyItem, tagItem, combo, note, style, positive, chunk, reference, favorite];
    const before = new Map(all.map(item => [`${item.kind}:${item.id}`, { versions: f.repo.readVersions(item.kind, item.id), memberships: f.repo.memberships(item.kind, item.id), cover: f.repo.getCover(item.kind, item.id), assets: f.repo.itemAssets(item.kind, item.id) }]));
    const coverFile = f.repo.itemAssets('tag', tagItem.id).find(asset => asset.role === 'cover')!.payload.filePath as string;
    const receipt = await trash.deleteItems(all.map(item => ({ kind: item.kind, id: item.id, expectedRevision: item.revision })));
    const byKind = Object.fromEntries(receipt.deleted.map((value: any) => [value.kind, value]));
    expect(byKind.study.files).toEqual({ moved: 2, kept: 0, missing: 0 });
    expect(byKind.tag.files).toEqual({ moved: 1, kept: 0, missing: 0 });
    expect(byKind.style_preset.files).toEqual({ moved: 2, kept: 0, missing: 0 });
    expect(byKind.reference_preset.files).toEqual({ moved: 1, kept: 0, missing: 0 });
    // The favorite's image is the live history original: it stays in place for the history item.
    expect(byKind.artist_favorite.files).toEqual({ moved: 0, kept: 1, missing: 0 });
    expect(byKind.artist_favorite.impacts.sharedFiles).toEqual([{ role: 'favorite-image', usedBy: ['history:fav-source'] }]);
    for (const file of [path.join(folder, 'original.png'), path.join(folder, 'preview.webp'), coverFile, preview, referenceFile]) expect(exists(file), file).toBe(false);
    expect(exists(folder)).toBe(false);
    expect(exists(historyItem.payload.filePath)).toBe(true);
    for (const item of all) expect(f.repo.get(item.kind, item.id)).toBeNull();
    expect(f.repo.getCover('tag', tagItem.id)).toEqual({ kind: 'tag', id: tagItem.id, coverRevision: 0, cover: null });
    expect(f.repo.memberships('style_preset', styleId)).toEqual([]);
    const restored = await trash.restore(receipt.deleted.map((value: any) => value.trashId));
    expect(restored.restored).toHaveLength(all.length);
    for (const item of all) {
      const saved = before.get(`${item.kind}:${item.id}`)!;
      expect(f.repo.readVersions(item.kind, item.id), item.kind).toEqual(saved.versions);
      expect(f.repo.memberships(item.kind, item.id), item.kind).toEqual(saved.memberships);
      expect(f.repo.getCover(item.kind, item.id), item.kind).toEqual(saved.cover);
      expect(f.repo.itemAssets(item.kind, item.id), item.kind).toEqual(saved.assets);
    }
    for (const file of [path.join(folder, 'original.png'), path.join(folder, 'preview.webp'), coverFile, preview, path.join(previewFolder, 'manifest.json'), referenceFile]) expect(exists(file), file).toBe(true);
    expect(folderFiles(path.join(f.root, 'trash'))).toEqual([]);
  });

  it('a user collection goes to Recently Deleted with its member list; items stay, and restoring brings the members back', async () => {
    const f = fixture(), trash = f.service();
    f.history('a'); f.history('b');
    f.repo.putCollection({ namespace: 'user', id: 'c1', name: 'Garden', payload: {} });
    for (const id of ['a', 'b']) f.repo.setMembership({ namespace: 'user', collectionId: 'c1', kind: 'history', id });
    expect((await trash.deleteCollection('user:c1', { preview: true })).collections).toEqual([{ collectionId: 'user:c1', name: 'Garden', members: 2 }]);
    expect(f.repo.collections('user')).toHaveLength(1);
    const receipt = await trash.deleteCollection('user:c1');
    expect(f.repo.collections('user')).toEqual([]);
    expect(f.repo.get('history', 'a')).not.toBeNull();
    // b is deleted while its collection is in Recently Deleted; a new collection takes the old name.
    const deletedB = (await trash.deleteItems([{ kind: 'history', id: 'b', expectedRevision: 1 }])).deleted[0] as any;
    f.repo.putCollection({ namespace: 'user', id: 'c2', name: 'Garden', payload: {} });
    const back = await trash.restore([(receipt.collections[0] as any).trashId]);
    expect(back.collections).toMatchObject([{ collectionId: 'user:c1', name: 'Garden (2)', renamedFrom: 'Garden', members: { restored: 1, pending: 1, skipped: 0 } }]);
    expect(f.repo.memberships('history', 'a')).toEqual([{ namespace: 'user', collectionId: 'c1', kind: 'history', id: 'a' }]);
    await trash.restore([deletedB.trashId]);
    expect(f.repo.memberships('history', 'b')).toEqual([{ namespace: 'user', collectionId: 'c1', kind: 'history', id: 'b' }]);
    await expect(trash.deleteCollection('history:any')).rejects.toMatchObject({ code: 'invalid_argument' });
  });
});

describe('Recently Deleted: batches, archived items and conflicts', () => {
  it('a batch is all or nothing: a stale revision changes nothing', async () => {
    const f = fixture(), trash = f.service();
    f.history('a'); f.history('b');
    const before = f.repo.getRevision();
    await expect(trash.deleteItems([{ kind: 'history', id: 'a', expectedRevision: 1 }, { kind: 'history', id: 'b', expectedRevision: 2 }])).rejects.toMatchObject({ code: 'library_conflict' });
    await expect(trash.deleteItems([{ kind: 'history', id: 'a', expectedRevision: 1 }, { kind: 'history', id: 'a', expectedRevision: 1 }])).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(trash.deleteItems([{ kind: 'history', id: 'missing', expectedRevision: 1 }])).rejects.toMatchObject({ code: 'library_not_found' });
    expect(f.repo.getRevision()).toBe(before);
    expect(f.repo.get('history', 'a')).not.toBeNull();
    const done = await trash.deleteItems([{ kind: 'history', id: 'a', expectedRevision: 1 }, { kind: 'history', id: 'b', expectedRevision: 1 }]);
    expect(done.deleted.map((value: any) => value.id)).toEqual(['a', 'b']);
    await expect(trash.deleteItems([{ kind: 'history', id: 'a', expectedRevision: 1 }])).rejects.toThrow(/already in Recently Deleted/);
  });

  it('deletes only archived items, per kind, and reports what remains', async () => {
    const f = fixture(), trash = f.service();
    for (const id of ['a', 'b', 'c']) f.history(id);
    const t = f.tag();
    for (const [kind, id] of [['history', 'a'], ['history', 'b']] as Array<[LibraryKind, string]>) { const item = f.repo.get(kind, id)!; f.repo.put(kind, id, item.payload, { expectedRevision: item.revision, archived: true }); }
    f.repo.put('tag', t.id, t.payload, { expectedRevision: 1, archived: true });
    const preview = await trash.deleteArchived({ kinds: ['history'], preview: true });
    expect(preview).toMatchObject({ preview: true, remaining: 2 });
    expect(f.repo.get('history', 'a')).not.toBeNull();
    const done = await trash.deleteArchived({ kinds: ['history'] });
    expect(done.deleted.map((value: any) => value.id).sort()).toEqual(['a', 'b']);
    expect(done.remaining).toBe(0);
    expect(f.repo.get('history', 'c')).not.toBeNull();
    expect(f.repo.get('tag', t.id)).not.toBeNull();
    expect((await trash.deleteArchived()).deleted.map((value: any) => value.kind)).toEqual(['tag']);
    expect((await trash.deleteArchived()).deleted).toEqual([]);
  });

  it('an identity in Recently Deleted cannot be recreated by a stale writer, and a restore never overwrites', async () => {
    const f = fixture(), trash = f.service();
    const item = f.history('a');
    const { deleted } = await trash.deleteItems([{ kind: 'history', id: 'a', expectedRevision: 1 }]);
    expect(() => f.repo.put('history', 'a', item.payload, { expectedRevision: 0 })).toThrow(/Recently Deleted/);
    expect(f.repo.trashedIds('history')).toEqual(new Set(['a']));
    await expect(trash.restore([randomUUID()])).rejects.toMatchObject({ code: 'library_not_found' });
    await expect(trash.restore(['not-a-uuid'])).rejects.toMatchObject({ code: 'invalid_argument' });
    await trash.restore([(deleted[0] as any).trashId]);
    expect(f.repo.get('history', 'a')?.revision).toBe(1);
  });
});

describe('Recently Deleted: referenced items are deleted and their effects listed', () => {
  it('clears a tag cover made from a deleted image, lists recipes, collections and references, and restores the cover', async () => {
    const recipes = new Map([['history:h1', [{ recipeId: randomUUID(), recipeRevision: 1, sourceRevision: 1 }]]]);
    const f = fixture({ recipeReferences: async targets => { expect(targets).toEqual([{ kind: 'history', id: 'h1' }]); return recipes; } }), trash = f.service();
    f.history('h1');
    const fromImage = f.tag('cup'), other = f.tag('saucer');
    f.cover(fromImage.id, 'history-h1-r1.png', 'cover made from h1');
    f.cover(other.id, 'saucer.png');
    f.repo.put('artist_favorite', 'random:f1', { id: 'f1', collection: 'random', artists: [], prompt: 'cup', image: f.repo.get('history', 'h1')!.payload });
    const preview = await trash.deleteItems([{ kind: 'history', id: 'h1', expectedRevision: 1 }], { preview: true });
    expect(preview.preview).toBe(true);
    expect(preview.deleted[0]).toMatchObject({ impacts: { coversCleared: [{ kind: 'tag', id: fromImage.id, name: 'cup' }], recipes: recipes.get('history:h1'), referencedBy: [{ kind: 'artist_favorite', id: 'random:f1', role: 'favorite-image' }] }, files: { moved: 0, kept: 1 } });
    expect(f.repo.getCover('tag', fromImage.id).cover).not.toBeNull();
    expect(f.repo.get('history', 'h1')).not.toBeNull();
    const coverBefore = f.repo.getCover('tag', fromImage.id);
    const { deleted } = await trash.deleteItems([{ kind: 'history', id: 'h1', expectedRevision: 1 }]);
    expect(deleted[0]).toMatchObject({ impacts: { coversCleared: [{ id: fromImage.id, coverRevision: coverBefore.coverRevision + 1 }] } });
    expect(f.repo.getCover('tag', fromImage.id)).toMatchObject({ coverRevision: coverBefore.coverRevision + 1, cover: null });
    expect(f.repo.getCover('tag', other.id).cover).not.toBeNull();
    expect(trash.list().entries[0]).toMatchObject({ impacts: { coversCleared: 1, recipes: 1, referencedBy: 1, sharedFiles: 1 } });
    const back = await trash.restore([(deleted[0] as any).trashId]);
    expect(back.restored[0]).toMatchObject({ covers: { restored: [fromImage.id], notRestored: [] } });
    expect(f.repo.getCover('tag', fromImage.id)).toEqual({ ...coverBefore, coverRevision: coverBefore.coverRevision + 2 });
  });

  it('keeps a cover someone changed after the deletion, and reports that recipes could not be scanned', async () => {
    const f = fixture({ recipeReferences: async () => { throw new Error('store unreadable'); } }), trash = f.service();
    f.history('h1');
    const t = f.tag();
    f.cover(t.id, 'history-h1-r1.webp');
    const { deleted } = await trash.deleteItems([{ kind: 'history', id: 'h1', expectedRevision: 1 }]);
    expect(deleted[0]).toMatchObject({ impacts: { recipesUnknown: true } });
    const oldBlob = path.join(f.library, 'covers', `${f.repo.trashEntry((deleted[0] as any).trashId)!.data.clearedCovers[0].cover.sha256}.webp`);
    f.cover(t.id, 'new.png');
    const changed = f.repo.getCover('tag', t.id);
    const back = await trash.restore([(deleted[0] as any).trashId]);
    expect(back.restored[0]).toMatchObject({ covers: { restored: [], notRestored: [{ id: t.id, reason: 'cover_changed' }] } });
    expect(f.repo.getCover('tag', t.id)).toEqual(changed);
    // The old cover's file is used by nothing any more, so it does not stay behind.
    expect(exists(oldBlob)).toBe(false);
    expect(exists(path.join(f.library, 'covers', `${changed.cover!.sha256}.webp`))).toBe(true);
  });
});

describe('Recently Deleted: shared files', () => {
  it('a purge deletes a shared file only when no live item and no other entry uses it', async () => {
    const f = fixture(), trash = f.service();
    const shared = path.join(f.output, 'shared.png');
    f.history('a', shared); f.history('b', shared);
    const first = (await trash.deleteItems([{ kind: 'history', id: 'a', expectedRevision: 1 }])).deleted[0] as any;
    expect(first.files).toEqual({ moved: 0, kept: 1, missing: 0 });
    expect(first.impacts.sharedFiles).toEqual([{ role: 'original', usedBy: ['history:b'] }]);
    expect((await trash.purge({ trashIds: [first.trashId] })).purged).toMatchObject([{ id: 'a', files: { deleted: 0, kept: 1 } }]);
    expect(exists(shared)).toBe(true);
    // b's file is now its own: it moves to the trash folder, and its purge deletes it.
    const second = (await trash.deleteItems([{ kind: 'history', id: 'b', expectedRevision: 1 }])).deleted[0] as any;
    expect(second.files).toEqual({ moved: 1, kept: 0, missing: 0 });
    expect(exists(shared)).toBe(false);
    await trash.purge({ trashIds: [second.trashId] });
    expect(folderFiles(path.join(f.root, 'trash'))).toEqual([]);
  });

  it('a file left in place by one entry stays while another entry still uses it, and goes with the last one', async () => {
    const f = fixture(), trash = f.service();
    const shared = path.join(f.output, 'shared.png');
    f.history('a', shared); f.history('b', shared);
    const { deleted } = await trash.deleteItems([{ kind: 'history', id: 'a', expectedRevision: 1 }, { kind: 'history', id: 'b', expectedRevision: 1 }]);
    expect(deleted.map((value: any) => value.files)).toEqual([{ moved: 0, kept: 1, missing: 0 }, { moved: 0, kept: 1, missing: 0 }]);
    await trash.purge({ trashIds: [(deleted[0] as any).trashId] });
    expect(exists(shared)).toBe(true);
    await trash.restore([(deleted[1] as any).trashId]);
    expect(exists(shared)).toBe(true);
    expect(f.repo.get('history', 'b')?.payload.filePath).toBe(shared);
    const again = (await trash.deleteItems([{ kind: 'history', id: 'b', expectedRevision: 1 }])).deleted[0] as any;
    expect(again.files.moved).toBe(1);
    const all = await trash.purge({ all: true });
    expect(all).toMatchObject({ remaining: 0 });
    expect(exists(shared)).toBe(false);
  });

  it('never moves or purges a file outside the managed folders, and a cover blob shared by two tags stays', async () => {
    const f = fixture(), trash = f.service();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-trash-outside-')); roots.push(outside);
    f.history('far', path.join(outside, 'far.png'));
    const one = f.tag('one'), two = f.tag('two');
    f.cover(one.id, 'same.png', 'identical cover bytes'); f.cover(two.id, 'same.png', 'identical cover bytes');
    const blob = f.repo.itemAssets('tag', one.id).find(asset => asset.role === 'cover')!.payload.filePath as string;
    const { deleted } = await trash.deleteItems([{ kind: 'history', id: 'far', expectedRevision: 1 }, { kind: 'tag', id: one.id, expectedRevision: 1 }]);
    expect(deleted.map((value: any) => value.files)).toEqual([{ moved: 0, kept: 1, missing: 0 }, { moved: 0, kept: 1, missing: 0 }]);
    await trash.purge({ all: true });
    expect(exists(path.join(outside, 'far.png'))).toBe(true);
    expect(exists(blob)).toBe(true);
    expect(f.repo.getCover('tag', two.id).cover).not.toBeNull();
  });
});

describe('Recently Deleted: interruptions', () => {
  it('a crash after the deletion committed is finished at the next start: no orphan, nothing lost', async () => {
    const f = fixture();
    const shared = path.join(f.output, 'shared.png');
    f.history('a'); f.history('b'); f.history('c', shared); f.history('d', shared);
    let renames = 0;
    const crashing = f.service(f.repo, { rename: async (from, to) => { if (++renames === 2) await new Promise(() => undefined); await fs.promises.rename(from, to); } });
    void crashing.deleteItems(['a', 'b', 'c'].map(id => ({ kind: 'history' as const, id, expectedRevision: 1 })));
    for (let waited = 0; renames < 2 && waited < 2000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
    expect(f.repo.get('history', 'a')).toBeNull();
    expect(f.repo.pendingFileOps().map(value => value.action)).toEqual(['trash-move']);
    f.repo.close();
    const restarted = f.open(), trash = f.service(restarted);
    await trash.recover();
    expect(restarted.pendingFileOps()).toEqual([]);
    const entries = trash.list().entries as any[];
    expect(entries.map(entry => [entry.id, entry.state ?? 'trashed', entry.files])).toEqual(expect.arrayContaining([['a', 'trashed', { moved: 1, kept: 0, missing: 0 }], ['b', 'trashed', { moved: 1, kept: 0, missing: 0 }], ['c', 'trashed', { moved: 0, kept: 1, missing: 0 }]]));
    for (const id of ['a', 'b']) expect(exists(path.join(f.output, '2026-11-02', `${id}.png`))).toBe(false);
    expect(exists(shared)).toBe(true);
    await trash.restore(entries.map(entry => entry.trashId));
    for (const id of ['a', 'b']) expect(fs.readFileSync(path.join(f.output, '2026-11-02', `${id}.png`), 'utf8')).toBe(`SFW teacup image ${id}`);
    expect(folderFiles(path.join(f.root, 'trash'))).toEqual([]);
  });

  it('a crash between moving restored files and the commit puts the files back into Recently Deleted', async () => {
    const f = fixture(), trash = f.service();
    f.history('a');
    const { deleted } = await trash.deleteItems([{ kind: 'history', id: 'a', expectedRevision: 1 }]);
    const original = path.join(f.output, '2026-11-02', 'a.png');
    const crashing = f.service(f.repo, { interrupt: phase => phase === 'restore-commit' ? new Promise(() => undefined) : undefined });
    void crashing.restore([(deleted[0] as any).trashId]);
    for (let waited = 0; !exists(original) && waited < 2000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
    expect(exists(original)).toBe(true);
    expect(f.repo.get('history', 'a')).toBeNull();
    f.repo.close();
    const restarted = f.open(), recovered = f.service(restarted);
    await recovered.recover();
    expect(exists(original)).toBe(false);
    expect(restarted.pendingFileOps()).toEqual([]);
    expect(folderFiles(path.join(f.root, 'trash', (deleted[0] as any).trashId))).toHaveLength(1);
    await recovered.restore([(deleted[0] as any).trashId]);
    expect(fs.readFileSync(original, 'utf8')).toBe('SFW teacup image a');
  });

  it('a failed restore commit moves its files back; a crash during a purge finishes without deleting what is still used', async () => {
    const f = fixture();
    const shared = path.join(f.output, 'shared.png');
    f.history('a'); f.history('b', shared); f.history('c', shared);
    const trash = f.service();
    const { deleted } = await trash.deleteItems([{ kind: 'history', id: 'a', expectedRevision: 1 }, { kind: 'history', id: 'b', expectedRevision: 1 }]);
    const failing = f.service(f.repo, { interrupt: phase => { if (phase === 'restore-commit') throw Object.assign(new Error('disk said no'), { code: 'library_storage_failed' }); } });
    await expect(failing.restore([(deleted[0] as any).trashId])).rejects.toThrow(/disk said no/);
    expect(exists(path.join(f.output, '2026-11-02', 'a.png'))).toBe(false);
    expect(f.repo.pendingFileOps()).toEqual([]);
    const purging = f.service(f.repo, { interrupt: phase => phase === 'purge-files' ? new Promise(() => undefined) : undefined });
    void purging.purge({ trashIds: deleted.map((value: any) => value.trashId) });
    for (let waited = 0; f.repo.listTrash().total > 0 && waited < 2000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
    expect(f.repo.pendingFileOps().map(value => value.action)).toEqual(['trash-purge']);
    expect(folderFiles(path.join(f.root, 'trash'))).not.toEqual([]);
    f.repo.close();
    const restarted = f.open(), recovered = f.service(restarted);
    await recovered.recover();
    expect(restarted.pendingFileOps()).toEqual([]);
    expect(folderFiles(path.join(f.root, 'trash'))).toEqual([]);
    // c still uses the shared original.
    expect(exists(shared)).toBe(true);
  });

  it('moves across volumes by copy, verify and remove, and settles an interrupted copy', async () => {
    const f = fixture();
    const exdev = async () => { throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' }); };
    const trash = f.service(f.repo, { rename: exdev });
    f.history('a');
    const original = path.join(f.output, '2026-11-02', 'a.png');
    const { deleted } = await trash.deleteItems([{ kind: 'history', id: 'a', expectedRevision: 1 }]);
    expect(deleted[0]).toMatchObject({ files: { moved: 1 } });
    expect(exists(original)).toBe(false);
    const [stored] = f.repo.trashFiles((deleted[0] as any).trashId);
    expect(fs.readFileSync(stored.trashPath!, 'utf8')).toBe('SFW teacup image a');
    await trash.restore([(deleted[0] as any).trashId]);
    expect(fs.readFileSync(original, 'utf8')).toBe('SFW teacup image a');
    // An interrupted copy (both copies present) is settled by keeping one verified copy in Recently Deleted.
    f.history('b');
    const hanging = f.service(f.repo, { interrupt: phase => phase === 'delete-files' ? new Promise(() => undefined) : undefined });
    void hanging.deleteItems([{ kind: 'history', id: 'b', expectedRevision: 1 }]);
    for (let waited = 0; f.repo.get('history', 'b') && waited < 2000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
    const entry = f.repo.listTrash().entries.find(value => value.itemId === 'b')!;
    const [planned] = f.repo.trashFiles(entry.trashId);
    fs.mkdirSync(path.dirname(planned.trashPath!), { recursive: true }); fs.copyFileSync(planned.path, planned.trashPath!); fs.writeFileSync(`${planned.trashPath}.partial`, 'half');
    f.repo.close();
    const restarted = f.open(), recovered = f.service(restarted);
    await recovered.recover();
    expect(exists(planned.path)).toBe(false);
    expect(exists(`${planned.trashPath}.partial`)).toBe(false);
    expect(fs.readFileSync(planned.trashPath!, 'utf8')).toBe('SFW teacup image b');
    expect(restarted.trashFiles(entry.trashId)[0].state).toBe('moved');
  });
});

describe('Recently Deleted: retention', () => {
  it('purges after 30 days, at startup and on the timer, never earlier when the clock is set back', async () => {
    const f = fixture(), trash = f.service();
    const start = f.clock.now;
    f.history('a');
    await trash.deleteItems([{ kind: 'history', id: 'a', expectedRevision: 1 }]);
    f.clock.now = start + 29 * DAY;
    expect(await trash.purgeExpired()).toEqual({ purged: 0 });
    // Set back 10 days, then delete b: its retention still starts no earlier than the latest time seen.
    f.clock.now = start - 10 * DAY;
    f.history('b');
    const b = (await trash.deleteItems([{ kind: 'history', id: 'b', expectedRevision: 1 }])).deleted[0] as any;
    expect(Date.parse(b.expiresAt)).toBe(start + TRASH_RETENTION_MS);
    expect(await trash.purgeExpired()).toEqual({ purged: 0 });
    f.clock.now = start + 30 * DAY - 1;
    expect(await trash.purgeExpired()).toEqual({ purged: 0 });
    f.clock.now = start + 30 * DAY;
    expect(await trash.purgeExpired()).toEqual({ purged: 2 });
    expect(folderFiles(path.join(f.root, 'trash'))).toEqual([]);
    // A deletion while the clock ran ahead is purged only once that later time is reached (a delay, never early).
    f.clock.now = start + 100 * DAY;
    f.history('c');
    await trash.deleteItems([{ kind: 'history', id: 'c', expectedRevision: 1 }]);
    f.clock.now = start + 31 * DAY;
    expect(await trash.purgeExpired()).toEqual({ purged: 0 });
    f.clock.now = start + 130 * DAY;
    trash.startAutoPurge(60_000);
    await new Promise(resolve => setTimeout(resolve, 0));
    await trash.idle();
    trash.stop();
    expect(trash.list().total).toBe(0);
  });

  it('relocates a restored history original whose name was taken by a different file, keeping both', async () => {
    const f = fixture(), trash = f.service();
    const item = f.history('a');
    const { deleted } = await trash.deleteItems([{ kind: 'history', id: 'a', expectedRevision: 1 }]);
    const original = item.payload.filePath as string;
    f.write(original, 'a newer image that took the name');
    const back = await trash.restore([(deleted[0] as any).trashId]);
    const restored = f.repo.get('history', 'a')!;
    expect(back.restored[0]).toMatchObject({ revision: 2, relocatedFrom: 1, files: { restored: 1, relocated: 1 } });
    expect(restored.payload.filePath).toBe(original.replace(/\.png$/, '-restored.png'));
    expect(restored.payload.fileUrl).toBe(`fixture:${restored.payload.filePath}`);
    expect(fs.readFileSync(restored.payload.filePath, 'utf8')).toBe('SFW teacup image a');
    expect(fs.readFileSync(original, 'utf8')).toBe('a newer image that took the name');
    expect(f.repo.readVersions('history', 'a').map(value => value.revision)).toEqual([1, 2]);
    // The same bytes at the old name are simply reused.
    const again = (await trash.deleteItems([{ kind: 'history', id: 'a', expectedRevision: 2 }])).deleted[0] as any;
    f.write(restored.payload.filePath, 'SFW teacup image a');
    expect((await trash.restore([again.trashId])).restored[0]).toMatchObject({ revision: 2, files: { restored: 1, relocated: 0 } });
    expect(folderFiles(path.join(f.root, 'trash'))).toEqual([]);
  });
});

describe('Recently Deleted: the output folder setting changes while entries wait', () => {
  it('restores into the folder a file came from and purges a file kept there once nothing uses it', async () => {
    const roots = { output: '' };
    const f = fixture({ managedRoots: () => [roots.output] });
    roots.output = f.output;
    const trash = f.service();
    const shared = path.join(f.output, 'shared.png');
    f.history('a'); f.history('b', shared); f.history('c', shared);
    const { deleted } = await trash.deleteItems([{ kind: 'history', id: 'a', expectedRevision: 1 }, { kind: 'history', id: 'b', expectedRevision: 1 }, { kind: 'history', id: 'c', expectedRevision: 1 }]);
    // The user picks another output folder: the old one is no longer managed.
    const newOutput = roots.output = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-trash-new-output-'));
    onTestFinished(() => fs.rmSync(newOutput, { recursive: true, force: true })); // backstop for a timeout
    try {
      await trash.restore([(deleted[0] as any).trashId]);
      expect(fs.readFileSync(path.join(f.output, '2026-11-02', 'a.png'), 'utf8')).toBe('SFW teacup image a');
      await trash.purge({ trashIds: deleted.slice(1).map((value: any) => value.trashId) });
      expect(exists(shared)).toBe(false);
      // A folder swapped for a link to elsewhere is refused.
      const again = (await trash.deleteItems([{ kind: 'history', id: 'a', expectedRevision: 1 }])).deleted[0] as any;
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-trash-elsewhere-'));
      onTestFinished(() => fs.rmSync(elsewhere, { recursive: true, force: true })); // also when an assertion below fails
      fs.rmSync(path.join(f.output, '2026-11-02'), { recursive: true }); fs.symlinkSync(elsewhere, path.join(f.output, '2026-11-02'));
      await expect(trash.restore([again.trashId])).rejects.toMatchObject({ code: 'library_conflict' });
      expect(fs.readdirSync(elsewhere)).toEqual([]);
      expect(f.repo.get('history', 'a')).toBeNull();
      fs.rmSync(elsewhere, { recursive: true, force: true });
    } finally { fs.rmSync(roots.output, { recursive: true, force: true }); }
  });
});

describe('Recently Deleted: change notices', () => {
  it('deleting, restoring and purging each announce the identities they changed (the renderer refreshes from these)', async () => {
    const f = fixture(), trash = f.service();
    f.history('a');
    const t = f.tag(); f.cover(t.id, 'history-a-r1.png');
    const notices: any[] = [];
    const unsubscribe = f.repo.subscribe((revision, change) => notices.push({ revision, ...change }));
    const named = (kind: string, id: string) => notices.some(notice => notice.changedKinds?.includes(kind) && (!notice.ids || notice.ids.includes(id)));
    const { deleted } = await trash.deleteItems([{ kind: 'history', id: 'a', expectedRevision: 1 }]);
    expect(named('history', 'a')).toBe(true);
    expect(named('tag', t.id)).toBe(true);
    notices.length = 0;
    await trash.restore([(deleted[0] as any).trashId]);
    expect(named('history', 'a')).toBe(true);
    expect(named('tag', t.id)).toBe(true);
    const again = (await trash.deleteItems([{ kind: 'history', id: 'a', expectedRevision: 1 }])).deleted[0] as any;
    notices.length = 0;
    await trash.purge({ trashIds: [again.trashId] });
    expect(named('history', 'a')).toBe(true);
    f.repo.putCollection({ namespace: 'user', id: 'u', name: 'U', payload: {} });
    notices.length = 0;
    await trash.deleteCollection('user:u');
    expect(notices.some(notice => notice.changedKinds === undefined)).toBe(true);
    unsubscribe();
  });
});
