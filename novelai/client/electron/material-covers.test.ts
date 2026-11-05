import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { DatabaseSync } from 'node:sqlite';
import { createMaterialLibraryService } from './material-library';
import { MATERIAL_COVER_LIMITS, createMaterialCoverStore } from './material-covers';
import { openLibraryRepository, type LibraryRepository } from './library/repository';
import { waitUntil } from '../src/test-support/wait-until';

const directories: string[] = [], repositories: LibraryRepository[] = [];
afterEach(async () => { vi.restoreAllMocks(); await runCleanups([...repositories.splice(0).map(repository => () => repository.close()), ...directories.splice(0).map(directory => () => fs.rm(directory, { recursive: true, force: true }))]); });
const details = (name: string) => ({ checkedAt: '2026-09-11T00:00:00.000Z', items: [{ name, canonicalName: name, resolution: 'canonical', tagStatus: 'found', category: 'artist', postCount: 42, deprecated: false, aliasStatus: 'checked', wiki: { status: 'not_found' }, sources: [] }] });
const post = (postId = 42, extra: any = {}) => ({ postId, rating: 'g' as const, sourceUrl: `https://danbooru.donmai.us/posts/${postId}`, width: 2000, height: 500, previewUrl: `https://cdn.donmai.us/${postId}-preview.png`, sampleUrl: `https://cdn.donmai.us/${postId}-sample.png`, score: 40, tags: { artists: ['sample_artist'], general: [], copyrights: [], characters: [], meta: [] }, ...extra });
const tag = (text = 'sample_artist') => ({ kind: 'tag', name: text, tag: { text, source: 'danbooru', category: 'artist', target: 'style' } });
async function setup() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-local-cover-')); directories.push(directory);
  const red = (await sharp({ create: { width: 2000, height: 500, channels: 3, background: '#e04040' } }).png().toBuffer()).toString('base64');
  const blue = (await sharp({ create: { width: 100, height: 200, channels: 3, background: '#4040e0' } }).png().toBuffer()).toString('base64');
  const tags = { search: vi.fn(), details: vi.fn(async ({ name }: any) => details(name)) };
  const gallery = { search: vi.fn(), detail: vi.fn(async ({ postId, rating }: any) => post(postId, { rating })), image: vi.fn(async ({ postId, variant }: any) => ({ postId, variant, mimeType: 'image/png', data: postId === 42 ? red : blue, sourceUrl: post(postId).sourceUrl, imageUrl: post(postId).sampleUrl })) };
  const databasePath = path.join(directory, 'library.sqlite');
  // Every open is another connection to the same library file (a restart).
  const open = () => { const repository = openLibraryRepository({ filePath: databasePath, libraryDirectory: directory }); repositories.push(repository); return repository; };
  const repository = open();
  const service = createMaterialLibraryService({ directory, repository, tags, gallery });
  const { entry } = await service.library({ action: 'save', entry: tag() });
  const set = (extra: any = {}) => service.samples({ action: 'set_cover', entryId: entry.id, revision: 1, postId: 42, expectedCoverRevision: 0, ...extra });
  /** Rewrites the saved cover record of the tag as another build (or damage) might have left it. */
  const rewriteCover = (payload: string) => { const db = new DatabaseSync(databasePath); try { db.prepare("UPDATE covers SET payload_json=? WHERE kind='tag' AND id=?").run(payload, entry.id); } finally { db.close(); } };
  return { directory, repository, open, rewriteCover, tags, gallery, service, entry, set, red, blue };
}

describe('explicit local material covers', () => {
  it('normalizes a sample without crop or enlargement, with independent revision and compact metadata', async () => {
    const f = await setup(); const original = f.repository.readVersions('tag', f.entry.id);
    const cover = await f.set();
    expect(cover).toMatchObject({ entryId: f.entry.id, entryRevision: 1, coverRevision: 1, coverStatus: 'ready', cover: { width: 1200, height: 300, mimeType: 'image/webp', postId: 42, tagText: 'sample_artist', tagCategory: 'artist', rating: 'g', verification: 'online' } });
    expect(cover.data).toBeUndefined(); expect(f.gallery.image).toHaveBeenCalledWith({ postId: 42, rating: 'g', variant: 'sample' });
    expect(f.gallery.detail).toHaveBeenCalledTimes(2);
    const list = await f.service.library({ action: 'list' }); expect(list.items[0].cover.sha256).toBe(cover.cover.sha256); expect(list.items[0].coverRevision).toBe(1); expect(JSON.stringify(list)).not.toContain(f.red);
    expect(f.repository.readVersions('tag', f.entry.id)).toEqual(original);
    const image = await f.service.samples({ action: 'cover', entryId: f.entry.id });
    expect(image.coverRevision).toBe(1); expect((await sharp(Buffer.from(image.data, 'base64')).metadata()).format).toBe('webp');
  });
  it('saves the explicitly selected rating in cover provenance', async () => {
    const f = await setup(); const saved = await f.set({ rating: 'e' });
    expect(saved.cover.rating).toBe('e');
    expect(f.gallery.detail).toHaveBeenNthCalledWith(1, { postId: 42, rating: 'e' });
    expect(f.gallery.image).toHaveBeenCalledWith({ postId: 42, rating: 'e', variant: 'sample' });
    expect(f.gallery.detail).toHaveBeenNthCalledWith(2, { postId: 42, rating: 'e' });
  });
  it('refuses saved Danbooru cover metadata without its rating instead of assuming one', async () => {
    const f = await setup(); await f.set();
    const { rating: _rating, ...stripped } = f.repository.getCover('tag', f.entry.id).cover!;
    f.rewriteCover(JSON.stringify(stripped));
    const restarted = createMaterialLibraryService({ directory: f.directory, repository: f.open(), tags: f.tags, gallery: f.gallery });
    await expect(restarted.samples({ action: 'cover', entryId: f.entry.id })).rejects.toMatchObject({ code: 'cover_corrupt' });
  });
  it('reopens exactly the same local image while every network dependency is offline', async () => {
    const f = await setup(); await f.set(); const before = await f.service.samples({ action: 'cover', entryId: f.entry.id });
    f.tags.details.mockRejectedValue(new Error('offline')); f.gallery.detail.mockRejectedValue(new Error('offline')); f.gallery.image.mockRejectedValue(new Error('offline'));
    f.tags.details.mockClear(); f.gallery.detail.mockClear(); f.gallery.image.mockClear();
    const restarted = createMaterialLibraryService({ directory: f.directory, repository: f.open(), tags: f.tags, gallery: f.gallery });
    expect(await restarted.samples({ action: 'cover', entryId: f.entry.id })).toEqual(before);
    expect((await restarted.library({ action: 'list' })).items[0].coverStatus).toBe('ready');
    expect(f.tags.details).not.toHaveBeenCalled(); expect(f.gallery.detail).not.toHaveBeenCalled(); expect(f.gallery.image).not.toHaveBeenCalled();
  });
  it('CAS allows only one concurrent replacement and clear leaves the prompt revision unchanged', async () => {
    const f = await setup(); await f.set();
    const replacements = await Promise.allSettled([43, 44].map(postId => f.set({ postId, expectedCoverRevision: 1 })));
    expect(replacements.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((replacements.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('cover_conflict');
    await expect(f.service.samples({ action: 'clear_cover', entryId: f.entry.id, expectedCoverRevision: 1 })).rejects.toMatchObject({ code: 'cover_conflict' });
    expect(await f.service.samples({ action: 'clear_cover', entryId: f.entry.id, expectedCoverRevision: 2 })).toMatchObject({ entryRevision: 1, coverRevision: 3, cover: null, coverStatus: 'none' });
    expect((await f.service.readEntry(f.entry.id)).revision).toBe(1);
    await expect(f.service.samples({ action: 'cover', entryId: f.entry.id })).rejects.toMatchObject({ code: 'cover_missing' });
  });
  it('rejects a tag edit racing with download, and the old cover is stale until the same identity returns', async () => {
    const f = await setup(); await f.set(); let release!: (value: any) => void;
    f.gallery.image.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = f.set({ postId: 43, expectedCoverRevision: 1 });
    await waitUntil(() => expect(release).toBeTypeOf('function'));
    await f.service.library({ action: 'save', id: f.entry.id, expectedRevision: 1, entry: tag('different_artist') });
    release({ postId: 43, variant: 'sample', mimeType: 'image/png', data: f.blue, sourceUrl: post(43).sourceUrl, imageUrl: post(43).sampleUrl });
    await expect(pending).rejects.toMatchObject({ code: 'material_conflict' });
    expect((await f.service.library({ action: 'read', id: f.entry.id })).entry).toMatchObject({ revision: 2, coverRevision: 1, cover: null, coverStatus: 'stale' });
    await expect(f.service.samples({ action: 'cover', entryId: f.entry.id })).rejects.toMatchObject({ code: 'cover_stale' });
    await f.service.library({ action: 'save', id: f.entry.id, expectedRevision: 2, entry: tag() });
    expect((await f.service.samples({ action: 'cover', entryId: f.entry.id })).cover.postId).toBe(42);
  });
  it('rechecks the selected rating, score, and artist association after download without weakening filters', async () => {
    const f = await setup(); await f.set(); const previous = await f.service.samples({ action: 'cover', entryId: f.entry.id });
    for (const changed of [post(43, { rating: 's' }), post(43, { score: 19 }), post(43, { tags: { ...post(43).tags, artists: ['another_artist'] } })]) {
      f.gallery.detail.mockResolvedValueOnce(post(43)).mockResolvedValueOnce(changed);
      await expect(f.set({ postId: 43, expectedCoverRevision: 1 })).rejects.toMatchObject({ code: 'sample_changed' });
      expect(await f.service.samples({ action: 'cover', entryId: f.entry.id })).toEqual(previous);
    }
  });
  it('never replaces the old image on corrupt downloads or failed metadata publication', async () => {
    const f = await setup(); const first = await f.set(), before = await f.service.samples({ action: 'cover', entryId: f.entry.id });
    f.gallery.image.mockResolvedValueOnce({ postId: 43, variant: 'sample', mimeType: 'image/png', data: 'bm90IGFuIGltYWdl', sourceUrl: post(43).sourceUrl, imageUrl: post(43).sampleUrl });
    await expect(f.set({ postId: 43, expectedCoverRevision: 1 })).rejects.toMatchObject({ code: 'cover_invalid_image' });
    // The cover record cannot be saved after the new image file was published.
    vi.spyOn(f.repository, 'setCover').mockImplementationOnce(() => { throw Object.assign(new Error('disk failed'), { code: 'EIO' }); });
    await expect(f.set({ postId: 43, expectedCoverRevision: 1 })).rejects.toMatchObject({ code: 'EIO' });
    expect(await f.service.samples({ action: 'cover', entryId: f.entry.id })).toEqual(before);
    expect(f.repository.getCover('tag', f.entry.id).coverRevision).toBe(first.coverRevision);
  });
  it('corrupt same-size bytes or corrupt metadata do not break the library list or text reads', async () => {
    const f = await setup(); const first = await f.set(); const blob = path.join(f.directory, 'covers', `${first.cover.sha256}.webp`);
    const bytes = await fs.readFile(blob); bytes[bytes.length - 1] ^= 1; await fs.writeFile(blob, bytes);
    expect((await f.service.library({ action: 'list' })).items[0]).toMatchObject({ coverRevision: 1, coverStatus: 'unavailable' });
    await expect(f.service.samples({ action: 'cover', entryId: f.entry.id })).rejects.toMatchObject({ code: 'cover_corrupt' });
    f.rewriteCover(JSON.stringify({ ...first.cover, sha256: 'not a digest' }));
    expect((await f.service.library({ action: 'read', id: f.entry.id })).entry).toMatchObject({ revision: 1, name: 'sample_artist', coverStatus: 'unavailable' });
    expect((await f.service.tags({ action: 'details', name: 'sample_artist' })).items[0].canonicalName).toBe('sample_artist');
  });
  it('rejects symlink cover storage and arbitrary paths without breaking ordinary metadata', async () => {
    const f = await setup(); const target = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-cover-external-')); directories.push(target);
    await fs.symlink(target, path.join(f.directory, 'covers'));
    expect((await f.service.library({ action: 'list' })).items[0].coverStatus).toBe('none');
    await expect(f.set()).rejects.toMatchObject({ code: 'cover_storage_failed' });
    expect(await fs.readdir(target)).toEqual([]);
    await expect(f.service.samples({ action: 'cover', entryId: '../secret' })).rejects.toMatchObject({ code: 'invalid_argument' });
    expect((await f.service.library({ action: 'save', entry: { kind: 'note', name: 'notes still work' } })).entry.revision).toBe(1);
  });
  it('round-trips local image bytes offline while marking imported provenance and unknown tag checks', async () => {
    const f = await setup(); await f.set(); const before = await f.service.samples({ action: 'cover', entryId: f.entry.id }), backup = await f.service.library({ action: 'export' });
    expect(backup.data.covers).toHaveLength(1);
    f.tags.details.mockRejectedValue(new Error('offline')); f.gallery.image.mockClear(); f.gallery.detail.mockClear();
    const imported = await f.service.library({ action: 'import', data: backup.data });
    expect(imported.count).toBe(1); expect(imported.coverWarnings).toBeUndefined(); const copy = imported.items[0];
    expect(copy.id).not.toBe(f.entry.id); expect(copy.tag.resolution).toBe('unknown');
    const image = await f.service.samples({ action: 'cover', entryId: copy.id });
    expect(image.data).toBe(before.data); expect(image.cover).toMatchObject({ verification: 'imported', tagCategory: 'artist', checkedAt: before.cover.checkedAt });
    expect(f.gallery.image).not.toHaveBeenCalled(); expect(f.gallery.detail).not.toHaveBeenCalled();
    f.tags.details.mockImplementation(async ({ name }: any) => details(name));
    await f.service.library({ action: 'save', id: copy.id, expectedRevision: 1, refreshEvidence: true, entry: tag() });
    expect((await f.service.samples({ action: 'cover', entryId: copy.id })).cover.sha256).toBe(before.cover.sha256);
  });
  it('validates all backup images before importing entries and supports old coverless backups', async () => {
    const f = await setup(); await f.set(); const { data } = await f.service.library({ action: 'export' });
    const corrupt = structuredClone(data); corrupt.covers[0].data = 'YQ==';
    await expect(f.service.library({ action: 'import', data: corrupt })).rejects.toMatchObject({ code: 'cover_corrupt' });
    expect((await f.service.library({ action: 'list' })).total).toBe(1);
    const old = await f.service.library({ action: 'import', data: { schemaVersion: 1, entries: data.entries } });
    expect(old.items[0]).toMatchObject({ coverRevision: 0, cover: null, coverStatus: 'none' });
  });
  it('reports damaged cover omissions in export and keeps successful entries on cover import failure', async () => {
    const f = await setup(); await f.set(); const { data } = await f.service.library({ action: 'export' });
    const originalLink = fs.link;
    vi.spyOn(fs, 'link').mockImplementation(async (from, to) => { if (String(to).includes(`${path.sep}covers${path.sep}`)) throw Object.assign(new Error('cover disk failed'), { code: 'EIO' }); return originalLink(from, to); });
    // The imported copy needs its own image file: remove the existing one so the import publishes it again.
    await fs.unlink(path.join(f.directory, 'covers', `${data.covers[0].cover.sha256}.webp`));
    const imported = await f.service.library({ action: 'import', data });
    expect(imported.count).toBe(1); expect(imported.coverWarnings).toHaveLength(1);
    expect((await f.service.library({ action: 'read', id: imported.items[0].id })).entry.name).toBe('sample_artist');
    const exported = await f.service.library({ action: 'export' });
    expect(exported.data.entries).toHaveLength(2); expect(exported.warnings[0].code).toBe('cover_unavailable');
  });
  it('does not double-charge existing blobs and can clear at the storage cap', async () => {
    const f = await setup(); const first = await f.set(); const coverDir = path.join(f.directory, 'covers');
    const size = await Promise.all((await fs.readdir(coverDir)).map(name => fs.stat(path.join(coverDir, name))));
    const previous = MATERIAL_COVER_LIMITS.storageBytes; MATERIAL_COVER_LIMITS.storageBytes = size.reduce((sum, stat) => sum + stat.size, 0) + 1;
    try {
      expect((await f.set({ expectedCoverRevision: 1 })).coverRevision).toBe(2);
      await expect(f.set({ postId: 43, expectedCoverRevision: 2 })).rejects.toMatchObject({ code: 'cover_storage_full' });
      expect((await f.service.samples({ action: 'clear_cover', entryId: f.entry.id, expectedCoverRevision: 2 })).coverRevision).toBe(3);
      // Kept: the earlier cover revisions still name it (it leaves only with the tag, through Recently Deleted).
      expect((await fs.readdir(coverDir)).filter(name => name.endsWith('.webp'))).toContain(`${first.cover.sha256}.webp`);
    } finally { MATERIAL_COVER_LIMITS.storageBytes = previous; }
  });
});
