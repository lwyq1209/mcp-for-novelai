/**
 * Step 3c review rework: the reviewer's repros (.tmp/oss-step3c-review, R1–R11) as regression tests, with the
 * findings fixed. Real repository, real service, real files in throwaway folders.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { libraryPathKey, openLibraryRepository, type LibraryRepository } from './library/repository';
import { createLibraryTrash, TRASH_RECEIPT_BYTES, type LibraryTrashOptions } from './library-trash';
import { activateLibrary, deactivateLibrary } from './library-runtime';
import { saveArtistFavoriteCollection } from './ipc/artist-favorites';

/**
 * Cases that write hundreds of library entries (more than one 500-item request) run in about 1–3 s alone but can pass
 * 30 s when two full suites share the disk: they get an explicit longer limit; what they check is unchanged.
 */
const HEAVY_IO_TIMEOUT_MS = 120_000;

const roots: string[] = [], repositories: LibraryRepository[] = [];
afterEach(() => {
  deactivateLibrary();
  for (const repo of repositories.splice(0)) { try { repo.close(); } catch { /* closed */ } }
  for (const root of roots.splice(0)) { try { fs.chmodSync(root, 0o700); } catch { /* gone */ } fs.rmSync(root, { recursive: true, force: true }); }
});
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/** `memory`: the repository in an in-memory database (files stay real) for tests that never reopen it. */
function fixture(extra: Partial<LibraryTrashOptions> = {}, { memory = false }: { memory?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-trash-review-')); roots.push(root);
  const library = path.join(root, 'library'), output = path.join(root, 'output'), database = path.join(root, 'library.sqlite');
  fs.mkdirSync(library, { recursive: true }); fs.mkdirSync(output, { recursive: true });
  const open = () => { const repo = openLibraryRepository({ filePath: memory ? ':memory:' : database, libraryDirectory: library, userDataRoot: root }); repositories.push(repo); return repo; };
  const repo = open();
  const service = (more: Partial<LibraryTrashOptions> = {}) => createLibraryTrash({ repository: repo, userDataRoot: root, libraryDirectory: library, managedRoots: () => [output], toFileUrl: file => `fixture:${file}`, log: () => undefined, ...extra, ...more });
  const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
  const history = (id: string, file = path.join(output, '2026-11-02', `${id}.png`), writeFile = true) => {
    if (writeFile) write(file, `SFW teacup image ${id}`);
    return repo.put('history', id, { id, filePath: file, fileUrl: `fixture:${file}`, date: '2026-11-02', createdAt: '2026-11-02T00:00:00.000Z', params: { positivePrompt: `teacup ${id}` }, actualSeed: 7, model: 'nai-diffusion-4-5-full', width: 8, height: 8 });
  };
  const favorite = (id: string, image: Record<string, any>) => repo.put('artist_favorite', `random:${id}`, { id, collection: 'random', artists: [], prompt: 'cup', image });
  const tag = (name = 'teacup') => { const id = randomUUID(); return repo.put('tag', id, { id, schemaVersion: 1, kind: 'tag', name, group: '', notes: '', tag: { text: name, source: 'english', target: 'base', category: null } }); };
  const cover = (tagId: string, fileName: string, bytes: string) => {
    const digest = sha(bytes);
    write(path.join(library, 'covers', `${digest}.webp`), bytes);
    return repo.setCover('tag', tagId, { sha256: digest, mimeType: 'image/webp', width: 8, height: 8, byteLength: Buffer.byteLength(bytes), postId: null, sourceUrl: null, tagText: 'teacup', tagCategory: null, rating: null, savedAt: '2026-11-02T00:00:00.000Z', verification: 'local', checkedAt: null, source: 'local', fileName, sourceSha256: digest, tagSource: 'english' }, { expectedRevision: repo.getCover('tag', tagId).coverRevision });
  };
  return { root, library, output, repo, open, service, write, history, favorite, tag, cover };
}
const caseInsensitiveVolume = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-case-probe-')); try { fs.writeFileSync(path.join(dir, 'CaseProbe'), 'x'); return fs.existsSync(path.join(dir, 'caseprobe')); } finally { fs.rmSync(dir, { recursive: true, force: true }); } };
const caseFolding = process.platform === 'darwin' || process.platform === 'win32';

describe('R1 one path key for shared files: case and Unicode normalization, few files or many', () => {
  it('path keys fold case where the file system does and always compare NFC', () => {
    expect(libraryPathKey('/out/Cup.png', 'darwin')).toBe(libraryPathKey('/out/cup.png', 'darwin'));
    expect(libraryPathKey('/out/Cup.png', 'linux')).not.toBe(libraryPathKey('/out/cup.png', 'linux'));
    expect(libraryPathKey('/out/Cafe\u0301.png', 'linux')).toBe(libraryPathKey('/out/Caf\u00e9.png', 'linux'));
  });

  it('fileOwners finds a case- or NFD-spelled reference the same way for <=8 and >8 files', () => {
    const f = fixture();
    const nfc = path.join(f.output, 'Caf\u00e9-Cup.png'), nfd = path.join(f.output, 'Cafe\u0301-Cup.png'), lower = path.join(f.output, 'caf\u00e9-cup.png');
    f.history('h', nfc, false);
    f.favorite('nfd', { id: 'h', filePath: nfd });
    if (caseFolding) f.favorite('lower', { id: 'h', filePath: lower });
    const expected = ['item:history:h', 'item:artist_favorite:random:nfd', ...(caseFolding ? ['item:artist_favorite:random:lower'] : [])].sort();
    const few = f.repo.fileOwners([nfc]), many = f.repo.fileOwners([nfc, ...Array.from({ length: 9 }, (_, index) => path.join(f.output, `other-${index}.png`))]);
    expect([...few.get(nfc)!].sort()).toEqual(expected);
    expect([...many.get(nfc)!].sort()).toEqual(expected);
    // The NFD spelling asks the same question and gets the same answer.
    expect([...f.repo.fileOwners([nfd]).get(nfd)!].sort()).toEqual(expected);
  });

  it.runIf(caseInsensitiveVolume())('a favorite naming Cup.png as cup.png keeps the file in place, single or batch, and a purge never deletes it', async () => {
    const f = fixture(), trash = f.service();
    const upper = path.join(f.output, '2026-11-02', 'Cup.png'), lower = path.join(f.output, '2026-11-02', 'cup.png');
    const h = f.history('h', upper);
    f.favorite('fav', { ...h.payload, filePath: lower, fileUrl: `fixture:${lower}` });
    const single = await trash.deleteItems([{ kind: 'history', id: 'h', expectedRevision: 1 }], { preview: true });
    const others = Array.from({ length: 8 }, (_, index) => f.history(`o${index}`));
    const batch = await trash.deleteItems([{ kind: 'history', id: 'h', expectedRevision: 1 }, ...others.map(o => ({ kind: 'history' as const, id: o.id, expectedRevision: 1 }))], { preview: true });
    expect((single.deleted[0] as any).files).toEqual({ moved: 0, kept: 1, missing: 0 });
    expect((batch.deleted[0] as any).files).toEqual({ moved: 0, kept: 1, missing: 0 });
    const done = await trash.deleteItems([{ kind: 'history', id: 'h', expectedRevision: 1 }]);
    expect(fs.existsSync(lower)).toBe(true);
    await trash.purge({ trashIds: [(done.deleted[0] as any).trashId] });
    expect(fs.readFileSync(lower, 'utf8')).toBe('SFW teacup image h');
  });
});

describe('R2 a batch restore gives two relocated files different names', () => {
  it('two entries from the same original path both come back, each under its own -restored name', async () => {
    const f = fixture(), trash = f.service();
    const p = path.join(f.output, '2026-11-02', 'same.png');
    f.history('a', p);
    const a = (await trash.deleteItems([{ kind: 'history', id: 'a', expectedRevision: 1 }])).deleted[0] as any;
    f.history('b', p);
    const b = (await trash.deleteItems([{ kind: 'history', id: 'b', expectedRevision: 1 }])).deleted[0] as any;
    f.write(p, 'a third image now at that name');
    const back = await trash.restore([a.trashId, b.trashId]);
    expect(back.restored.map((value: any) => value.files.relocated)).toEqual([1, 1]);
    const [pathA, pathB] = [f.repo.get('history', 'a')!.payload.filePath, f.repo.get('history', 'b')!.payload.filePath];
    expect(pathA).not.toBe(pathB);
    expect(fs.readFileSync(pathA, 'utf8')).toBe('SFW teacup image a');
    expect(fs.readFileSync(pathB, 'utf8')).toBe('SFW teacup image b');
    expect(fs.readFileSync(p, 'utf8')).toBe('a third image now at that name');
  });
});

describe('R3 the artist favorites full-list writer skips an identity in Recently Deleted', () => {
  it('saving a list that still names a deleted favorite saves the others and leaves the deleted one where it is', async () => {
    const f = fixture(), trash = f.service();
    activateLibrary(f.repo, { userDataRoot: f.root, libraryDirectory: f.library });
    await saveArtistFavoriteCollection(f.root, 'random', [{ id: 'f1', artists: [], prompt: 'cup' }]);
    const item = f.repo.get('artist_favorite', 'random:f1')!;
    await trash.deleteItems([{ kind: 'artist_favorite', id: item.id, expectedRevision: item.revision }]);
    await saveArtistFavoriteCollection(f.root, 'random', [{ id: 'f2', artists: [], prompt: 'saucer' }, { id: 'f1', artists: [], prompt: 'cup' }]);
    expect(f.repo.get('artist_favorite', 'random:f2')).not.toBeNull();
    expect(f.repo.get('artist_favorite', 'random:f1')).toBeNull();
    expect(f.repo.listTrash().entries.map(entry => entry.itemId)).toEqual(['random:f1']);
  });
});

describe('R4 an entry left moving is rechecked right before its files move', () => {
  it('a file a live item started using after an interrupted deletion stays in place and survives the purge', async () => {
    const f = fixture();
    const h = f.history('h'), file = h.payload.filePath as string;
    const failing = f.service({ interrupt: phase => { if (phase === 'delete-files') throw new Error('interrupted after the commit'); } });
    // The deletion committed: the call reports it (entry still moving) instead of failing.
    const receipt = await failing.deleteItems([{ kind: 'history', id: 'h', expectedRevision: 1 }]);
    expect(receipt.deleted[0]).toMatchObject({ state: 'moving' });
    expect(f.repo.listTrash().entries[0].state).toBe('moving');
    f.favorite('fav', h.payload);
    const trash = f.service();
    const purged = await trash.purge({ trashIds: [(receipt.deleted[0] as any).trashId] });
    expect(purged.purged).toMatchObject([{ id: 'h', files: { deleted: 0, kept: 1 } }]);
    expect(fs.readFileSync(file, 'utf8')).toBe('SFW teacup image h');
  });

  it('startup recovery rechecks too, and moves a half-moved file back for the item that uses it', async () => {
    const f = fixture();
    const h = f.history('h'), file = h.payload.filePath as string;
    const hanging = f.service({ interrupt: phase => phase === 'delete-files' ? new Promise(() => undefined) : undefined });
    void hanging.deleteItems([{ kind: 'history', id: 'h', expectedRevision: 1 }]);
    for (let waited = 0; f.repo.get('history', 'h') && waited < 2000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
    const [planned] = f.repo.trashFiles(f.repo.listTrash().entries[0].trashId);
    // The move had happened when a favorite started naming the original path.
    fs.mkdirSync(path.dirname(planned.trashPath!), { recursive: true }); fs.renameSync(file, planned.trashPath!);
    f.favorite('fav', h.payload);
    await f.service().recover();
    expect(fs.readFileSync(file, 'utf8')).toBe('SFW teacup image h');
    expect(f.repo.trashFiles(planned.trashId)[0].state).toBe('kept-shared');
    expect(f.repo.pendingFileOps()).toEqual([]);
  });
});

describe('R6 a cleared cover whose tag is deleted too comes back whichever is restored first', () => {
  it.each(['history first', 'tag first', 'both at once'] as const)('%s', async order => {
    const f = fixture(), trash = f.service();
    f.history('h1');
    const t = f.tag('cup');
    const cover = f.cover(t.id, 'history-h1-r1.png', 'cover made from h1');
    const blob = path.join(f.library, 'covers', `${cover.cover!.sha256}.webp`);
    const h = (await trash.deleteItems([{ kind: 'history', id: 'h1', expectedRevision: 1 }])).deleted[0] as any;
    const tagEntry = (await trash.deleteItems([{ kind: 'tag', id: t.id, expectedRevision: 1 }])).deleted[0] as any;
    if (order === 'history first') {
      const back = await trash.restore([h.trashId]);
      expect((back.restored[0] as any).covers.notRestored).toEqual([{ id: t.id, reason: 'tag_in_recently_deleted' }]);
      expect(fs.existsSync(blob)).toBe(true);
      await trash.restore([tagEntry.trashId]);
    } else if (order === 'tag first') { await trash.restore([tagEntry.trashId]); await trash.restore([h.trashId]); }
    else await trash.restore([h.trashId, tagEntry.trashId]);
    expect(f.repo.getCover('tag', t.id).cover).toEqual(cover.cover);
    expect(f.repo.itemAssets('tag', t.id).some(asset => asset.role === 'cover')).toBe(true);
    expect(fs.existsSync(blob)).toBe(true);
    expect(f.repo.listTrash().total).toBe(0);
  });

  it('a handed-over cover file is purged with the tag entry once nothing uses it', async () => {
    const f = fixture(), trash = f.service();
    f.history('h1');
    const t = f.tag('cup');
    const cover = f.cover(t.id, 'history-h1-r1.png', 'cover made from h1');
    const blob = path.join(f.library, 'covers', `${cover.cover!.sha256}.webp`);
    const h = (await trash.deleteItems([{ kind: 'history', id: 'h1', expectedRevision: 1 }])).deleted[0] as any;
    const tagEntry = (await trash.deleteItems([{ kind: 'tag', id: t.id, expectedRevision: 1 }])).deleted[0] as any;
    await trash.restore([h.trashId]);
    await trash.purge({ trashIds: [tagEntry.trashId] });
    expect(fs.existsSync(blob)).toBe(false);
  });
});

describe('R7 a preview leaves no trace', () => {
  it('previewing a deletion (items, archived items or a collection) creates no folder, file, row or journal', async () => {
    const f = fixture(), trash = f.service();
    f.history('h');
    f.repo.putCollection({ namespace: 'user', id: 'u', name: 'U', payload: {} });
    const item = f.repo.get('history', 'h')!; f.repo.put('history', 'h', item.payload, { expectedRevision: 1, archived: true });
    const before = { revision: f.repo.getRevision(), entries: fs.readdirSync(f.root).sort() };
    await trash.deleteItems([{ kind: 'history', id: 'h', expectedRevision: 2 }], { preview: true });
    await trash.deleteArchived({ preview: true });
    await trash.deleteCollection('user:u', { preview: true });
    expect(fs.existsSync(path.join(f.root, 'trash'))).toBe(false);
    expect(fs.readdirSync(f.root).sort()).toEqual(before.entries);
    expect(f.repo.getRevision()).toBe(before.revision);
    expect(f.repo.pendingFileOps()).toEqual([]);
  });
});

describe('R8 links are never moved or purged', () => {
  it.skipIf(process.platform === 'win32')('a hard-linked twin survives; a symlinked file and a folder linked outside stay', async () => {
    const f = fixture(), trash = f.service();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-trash-review-outside-')); roots.push(outside);
    const a = f.history('a');
    const twin = path.join(f.output, 'twin.png'); fs.linkSync(a.payload.filePath, twin); f.history('b', twin, false);
    const target = f.write(path.join(outside, 'real.png'), 'outside bytes');
    const link = path.join(f.output, 'link.png'); fs.symlinkSync(target, link); f.history('c', link, false);
    fs.symlinkSync(outside, path.join(f.output, 'linked-folder')); f.history('d', path.join(f.output, 'linked-folder', 'real.png'), false);
    const { deleted } = await trash.deleteItems(['a', 'c', 'd'].map(id => ({ kind: 'history' as const, id, expectedRevision: 1 })));
    expect(deleted.map((value: any) => value.files)).toEqual([{ moved: 1, kept: 0, missing: 0 }, { moved: 0, kept: 1, missing: 0 }, { moved: 0, kept: 1, missing: 0 }]);
    await trash.purge({ all: true });
    expect(fs.readFileSync(twin, 'utf8')).toBe('SFW teacup image a');
    expect(fs.readFileSync(target, 'utf8')).toBe('outside bytes');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });
});

describe('R9 receipts stay bounded for large batches', () => {
  it('500 deletions, restores and purges each answer within the receipt budget, entries with effects listed first', { timeout: HEAVY_IO_TIMEOUT_MS }, async () => {
    // About 2,000 small database transactions: in memory they do not wait for disk syncs, which on a busy machine
    // took longer than the test timeout. The receipts and the real files are the same.
    const f = fixture({}, { memory: true }), trash = f.service();
    const items = Array.from({ length: 500 }, (_, index) => f.history(`h${String(index).padStart(3, '0')}`));
    f.repo.putCollection({ namespace: 'user', id: 'u', name: 'Picked', payload: {} });
    f.repo.setMembership({ namespace: 'user', collectionId: 'u', kind: 'history', id: 'h499' });
    const selection = items.map(item => ({ kind: 'history' as const, id: item.id, expectedRevision: 1 }));
    const sizes: Record<string, number> = {};
    const preview = await trash.deleteItems(selection, { preview: true });
    const receipt = await trash.deleteItems(selection);
    sizes.preview = Buffer.byteLength(JSON.stringify(preview)); sizes.delete = Buffer.byteLength(JSON.stringify(receipt));
    expect((receipt.deleted[0] as any).id).toBe('h499');
    expect((receipt as any).omitted).toMatchObject({ count: 500 - receipt.deleted.length });
    expect((receipt as any).totals).toMatchObject({ entries: 500, files: { moved: 500, kept: 0, missing: 0 }, impacts: { collections: 1 } });
    const all = trash.list({ limit: 500 }).entries.map((entry: any) => entry.trashId);
    const restored = await trash.restore(all);
    sizes.restore = Buffer.byteLength(JSON.stringify(restored));
    const again = await trash.deleteItems(selection);
    const purged = await trash.purge({ trashIds: trash.list({ limit: 500 }).entries.map((entry: any) => entry.trashId) });
    sizes.purge = Buffer.byteLength(JSON.stringify(purged));
    // Measured with a fuller fixture in .tmp/oss-step3c/receipt-sizes.log (delete ≈ 42 KB; ≈ 178 KB before the bound).
    for (const [name, bytes] of Object.entries(sizes)) expect(bytes, name).toBeLessThan(TRASH_RECEIPT_BYTES + 24 * 1024);
    expect(again.deleted.length).toBeGreaterThan(0);
    // A small batch is listed in full.
    const small = await trash.deleteItems([{ kind: 'history', id: f.history('x').id, expectedRevision: 1 }]);
    expect(small).not.toHaveProperty('omitted');
    // No assertion here depends on time; at the batch limit this is about 2,500 real file operations, which on a
    // fully loaded machine can outlast the default 30 s test timeout, so it gets a longer hang guard.
  }, 120_000);
});

describe('R11 a file left in place is purged only while it is still that file', () => {
  it('an in-place original edited by the user keeps; an unchanged one goes; without a digest the size decides, and without either it stays', async () => {
    const f = fixture(), trash = f.service();
    const h = f.history('h');
    f.favorite('fav', h.payload);
    const first = (await trash.deleteItems([{ kind: 'history', id: 'h', expectedRevision: 1 }])).deleted[0] as any;
    expect(first.files).toEqual({ moved: 0, kept: 1, missing: 0 });
    const recorded = f.repo.trashFiles(first.trashId)[0];
    expect(recorded).toMatchObject({ state: 'kept-shared', byteLength: Buffer.byteLength('SFW teacup image h'), sha256: sha('SFW teacup image h') });
    const fav = f.repo.get('artist_favorite', 'random:fav')!;
    const second = (await trash.deleteItems([{ kind: 'artist_favorite', id: fav.id, expectedRevision: fav.revision }])).deleted[0] as any;
    f.write(h.payload.filePath, 'the user edited this picture and saved it over the same name');
    const purged = await trash.purge({ trashIds: [first.trashId, second.trashId] });
    expect(purged.purged).toMatchObject([{ files: { deleted: 0, kept: 1, changed: 1 }, note: expect.stringContaining('changed') }, { files: { deleted: 0, kept: 1, changed: 1 } }]);
    expect(fs.readFileSync(h.payload.filePath, 'utf8')).toBe('the user edited this picture and saved it over the same name');

    // Unchanged: deleted. No digest recorded (an interrupted deletion): the size decides; nothing recorded: kept.
    for (const [label, patch, expectGone] of [['unchanged', {}, true], ['size only', { sha256: null }, true], ['nothing recorded', { sha256: null, byteLength: null }, false]] as const) {
      const id = `g-${label.replace(/ /g, '-')}`, item = f.history(id);
      f.favorite(id, item.payload);
      const entryA = (await trash.deleteItems([{ kind: 'history', id, expectedRevision: 1 }])).deleted[0] as any;
      const favorite = f.repo.get('artist_favorite', `random:${id}`)!;
      const entryB = (await trash.deleteItems([{ kind: 'artist_favorite', id: favorite.id, expectedRevision: favorite.revision }])).deleted[0] as any;
      for (const entry of [entryA, entryB]) for (const file of f.repo.trashFiles(entry.trashId)) f.repo.setTrashFile(entry.trashId, file.ordinal, patch);
      await trash.purge({ trashIds: [entryA.trashId, entryB.trashId] });
      expect(fs.existsSync(item.payload.filePath), label).toBe(!expectGone);
    }
  });
});

describe('P3-11 a file a purge cannot remove now is retried, never leaked', () => {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an undeletable entry folder stays in the journal and goes at the next purge', async () => {
    const f = fixture(), trash = f.service();
    f.history('a'); f.history('b');
    const { deleted } = await trash.deleteItems([{ kind: 'history', id: 'a', expectedRevision: 1 }, { kind: 'history', id: 'b', expectedRevision: 1 }]);
    const folder = path.join(f.root, 'trash', (deleted[0] as any).trashId);
    fs.chmodSync(folder, 0o500);
    try {
      const first = await trash.purge({ trashIds: [(deleted[0] as any).trashId] });
      expect(first).toMatchObject({ retryLater: 1 });
      expect(f.repo.pendingFileOps()).toMatchObject([{ action: 'trash-purge', state: 'pending' }]);
      expect(fs.existsSync(folder)).toBe(true);
    } finally { fs.chmodSync(folder, 0o700); }
    await trash.purge({ trashIds: [(deleted[1] as any).trashId] });
    expect(fs.existsSync(folder)).toBe(false);
    expect(f.repo.pendingFileOps()).toEqual([]);
    expect(fs.readdirSync(path.join(f.root, 'trash'))).toEqual([]);
  });
});
