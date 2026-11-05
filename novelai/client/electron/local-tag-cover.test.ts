import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseLibraryBackup } from '../src/library/library-backup';
import { runCleanups } from '../src/test-support/temp-dirs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createMaterialLibraryService } from './material-library';
import { MATERIAL_COVER_LIMITS } from './material-covers';
import * as coverModule from './material-covers';
import { openLibraryRepository, type LibraryRepository } from './library/repository';
import { waitUntil } from '../src/test-support/wait-until';

const roots: string[] = [];
const repositories: LibraryRepository[] = [];
afterEach(() => runCleanups([
  () => vi.restoreAllMocks(),
  ...repositories.splice(0).map(repository => () => repository.close()),
  ...roots.splice(0).map(root => () => fs.rm(root, { recursive: true, force: true })),
]));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const tag = (text = 'soft_lighting', source: 'danbooru' | 'nai' | 'english' = 'english') => ({ kind: 'tag', name: text, tag: { text, source, category: source === 'danbooru' ? 'general' : null, target: 'style' } });
async function fixture(source: 'danbooru' | 'nai' | 'english' = 'english') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-upload-cover-')); roots.push(root);
  const tags = { search: vi.fn(), details: vi.fn(async ({ name }: any) => ({ checkedAt: '2026-09-14T00:00:00.000Z', items: [{ name, canonicalName: name, resolution: 'canonical', tagStatus: 'found', category: 'general', postCount: 10, deprecated: false, aliasStatus: 'checked', wiki: { status: 'not_found' }, sources: [] }] })) };
  const gallery = { search: vi.fn(), detail: vi.fn(), image: vi.fn() };
  const repo = openLibraryRepository({ filePath: path.join(root, 'library.sqlite'), libraryDirectory: root });
  repositories.push(repo);
  const service = createMaterialLibraryService({ directory: root, repository: repo, tags, gallery: gallery as any });
  const { entry } = await service.library({ action: 'save', entry: tag('soft_lighting', source) });
  tags.details.mockClear();
  const set = (data: string, extra: any = {}) => service.samples({ action: 'set_local_cover', entryId: entry.id, revision: 1, expectedCoverRevision: 0, fileName: 'cover.png', data, ...extra });
  return { root, repo, service, entry, tags, gallery, set };
}

async function formats() {
  const create = sharp({ create: { width: 37, height: 19, channels: 4, background: '#31a0d8' } });
  return {
    png: await create.clone().png().toBuffer(),
    jpeg: await create.clone().jpeg().toBuffer(),
    webp: await create.clone().webp().toBuffer(),
    gif: await create.clone().gif().toBuffer(),
  };
}

describe('local-only uploaded material covers', () => {
  it('accepts sniffed PNG, JPEG, WebP and GIF first frames and stores only normalized metadata/bytes', async () => {
    const images = await formats();
    for (const [format, bytes] of Object.entries(images)) {
      const f = await fixture();
      const saved = await f.set(bytes.toString('base64'), { fileName: `用户封面.${format}` });
      expect(saved).toMatchObject({ entryId: f.entry.id, entryRevision: 1, coverRevision: 1, coverStatus: 'ready', cover: {
        source: 'local', fileName: `用户封面.${format}`, sourceSha256: sha(bytes), tagSource: 'english', tagText: 'soft_lighting', tagCategory: null,
        postId: null, sourceUrl: null, rating: null, checkedAt: null, verification: 'local', mimeType: 'image/webp', width: 37, height: 19,
      } });
      const image = await f.service.samples({ action: 'cover', entryId: f.entry.id });
      const metadata = await sharp(Buffer.from(image.data, 'base64')).metadata();
      expect(metadata).toMatchObject({ format: 'webp', width: 37, height: 19 });
      expect(metadata.pages ?? 1).toBe(1); expect(metadata.orientation).toBeUndefined();
      // The covers folder holds the normalized image; its record is the library's cover of the tag.
      expect(await fs.readdir(path.join(f.root, 'covers'))).toEqual([`${saved.cover.sha256}.webp`]);
      expect(f.repo.getCover('tag', f.entry.id)).toMatchObject({ coverRevision: 1, cover: { sha256: saved.cover.sha256 } });
      expect(JSON.stringify(await f.service.library({ action: 'export' }))).not.toContain(bytes.toString('base64'));
    }
  });

  it('honors orientation, keeps the complete image, never enlarges it, and strips source metadata', async () => {
    const f = await fixture();
    const jpeg = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#efe5c8' } }).withMetadata({ orientation: 6, exif: { IFD0: { Copyright: 'private fixture metadata' } } }).jpeg().toBuffer();
    const saved = await f.set(jpeg.toString('base64'), { fileName: 'camera.jpg' });
    expect(saved.cover).toMatchObject({ width: 40, height: 80, sourceSha256: sha(jpeg) });
    const output = Buffer.from((await f.service.samples({ action: 'cover', entryId: f.entry.id })).data, 'base64');
    const meta = await sharp(output).metadata();
    expect(meta.exif).toBeUndefined(); expect(meta.orientation).toBeUndefined();
    const width = 8, pageHeight = 8, height = 16, channels = 3, pixels = Buffer.alloc(width * height * channels);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const offset = (y * width + x) * channels; pixels[offset] = y < pageHeight ? 255 : 0; pixels[offset + 2] = y < pageHeight ? 0 : 255; }
    const animated = await sharp(pixels, { raw: { width, height, channels, pageHeight } }).gif({ delay: [100, 100], loop: 0 }).toBuffer();
    const firstFrame = await f.set(animated.toString('base64'), { expectedCoverRevision: 1, fileName: 'animated.gif' });
    expect(firstFrame.cover).toMatchObject({ width: 8, height: 8, sourceSha256: sha(animated) });
    const decoded = await sharp(Buffer.from((await f.service.samples({ action: 'cover', entryId: f.entry.id })).data, 'base64')).removeAlpha().raw().toBuffer();
    expect(decoded[0]).toBeGreaterThan(250); expect(decoded[1]).toBeLessThan(5); expect(decoded[2]).toBeLessThan(5);
  });

  it('rejects SVG, damaged/spoofed data, byte/pixel excess and every path-like file name while retaining the old cover', async () => {
    const f = await fixture(); const images = await formats();
    const first = await f.set(images.png.toString('base64'));
    const invalid = [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>').toString('base64'),
      Buffer.from('not an image').toString('base64'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64'),
    ];
    for (const data of invalid) await expect(f.set(data, { expectedCoverRevision: 1 })).rejects.toMatchObject({ code: 'cover_invalid_image' });
    for (const fileName of ['../cover.png', 'folder/cover.png', 'folder\\cover.png', 'C:cover.png', 'bad\u0000.png', '   ', '\t', '.', '..', 'x'.repeat(256)]) {
      await expect(f.set(images.jpeg.toString('base64'), { expectedCoverRevision: 1, fileName })).rejects.toMatchObject({ code: 'invalid_argument' });
    }
    const inputBytes = MATERIAL_COVER_LIMITS.inputBytes, inputPixels = MATERIAL_COVER_LIMITS.inputPixels, outputBytes = MATERIAL_COVER_LIMITS.outputBytes;
    try {
      MATERIAL_COVER_LIMITS.inputBytes = images.jpeg.length - 1;
      await expect(f.set(images.jpeg.toString('base64'), { expectedCoverRevision: 1 })).rejects.toMatchObject({ code: 'cover_invalid_image' });
      MATERIAL_COVER_LIMITS.inputBytes = inputBytes; MATERIAL_COVER_LIMITS.inputPixels = 100;
      await expect(f.set(images.png.toString('base64'), { expectedCoverRevision: 1 })).rejects.toMatchObject({ code: 'cover_invalid_image' });
      MATERIAL_COVER_LIMITS.inputPixels = inputPixels;
      const outputFixture = await fixture(); MATERIAL_COVER_LIMITS.outputBytes = 1;
      await expect(outputFixture.set(images.webp.toString('base64'))).rejects.toMatchObject({ code: 'cover_invalid_image' });
    } finally { MATERIAL_COVER_LIMITS.inputBytes = inputBytes; MATERIAL_COVER_LIMITS.inputPixels = inputPixels; MATERIAL_COVER_LIMITS.outputBytes = outputBytes; }
    const decoder = vi.spyOn(coverModule, 'normalizeMaterialCover');
    await expect(f.service.samples({ action: 'set_local_cover', entryId: f.entry.id, revision: 1, expectedCoverRevision: 1, fileName: 'large.png', data: 'A'.repeat(27_962_029) })).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(decoder).not.toHaveBeenCalled();
    expect(await f.service.samples({ action: 'cover', entryId: f.entry.id })).toMatchObject({ coverRevision: 1, cover: { sha256: first.cover.sha256 } });
  });

  it('does no tag/gallery/network work, supports every saved tag source, and requires save before upload', async () => {
    const images = await formats();
    for (const source of ['danbooru', 'nai', 'english'] as const) {
      const f = await fixture(source);
      await f.set(images.webp.toString('base64'));
      expect(f.tags.details).not.toHaveBeenCalled(); expect(f.tags.search).not.toHaveBeenCalled();
      expect(f.gallery.search).not.toHaveBeenCalled(); expect(f.gallery.detail).not.toHaveBeenCalled(); expect(f.gallery.image).not.toHaveBeenCalled();
      expect((await f.service.library({ action: 'list' })).items[0].cover).toMatchObject({ source: 'local', tagSource: source });
    }
    const f = await fixture();
    await expect(f.service.samples({ action: 'set_local_cover', entryId: '11111111-1111-4111-8111-111111111111', revision: 1, expectedCoverRevision: 0, fileName: 'x.png', data: images.png.toString('base64') })).rejects.toMatchObject({ code: 'material_not_found' });
  });

  it('replaces and clears independently of tag revision, with pre-decode and final tag/cover CAS', async () => {
    const f = await fixture(); const images = await formats();
    await f.set(images.png.toString('base64'));
    expect(await f.set(images.jpeg.toString('base64'), { expectedCoverRevision: 1, fileName: 'second.jpg' })).toMatchObject({ entryRevision: 1, coverRevision: 2, cover: { fileName: 'second.jpg' } });
    await expect(f.set('not-base64', { expectedCoverRevision: 1 })).rejects.toMatchObject({ code: 'cover_conflict' });
    await f.service.library({ action: 'save', id: f.entry.id, expectedRevision: 1, entry: tag('different', 'english') });
    await expect(f.set('not-base64', { revision: 1, expectedCoverRevision: 2 })).rejects.toMatchObject({ code: 'material_conflict' });
    expect((await f.service.library({ action: 'read', id: f.entry.id })).entry).toMatchObject({ revision: 2, coverRevision: 2, cover: null, coverStatus: 'stale' });
    const cleared = await f.service.samples({ action: 'clear_cover', entryId: f.entry.id, expectedCoverRevision: 2 });
    expect(cleared).toMatchObject({ entryRevision: 2, coverRevision: 3, cover: null, coverStatus: 'none' });
    expect((await f.service.readEntry(f.entry.id)).revision).toBe(2);
  });

  it('caps local work at two active plus two pending, rejects the fifth, and never retries accepted work', async () => {
    const f = await fixture(); const images = await formats();
    let active = 0, maximum = 0, started = 0;
    const releases: Array<() => void> = [];
    const decoder = vi.spyOn(coverModule, 'normalizeMaterialCover').mockImplementation(async () => {
      active++; started++; maximum = Math.max(maximum, active);
      await new Promise<void>(resolve => releases.push(resolve));
      active--;
      throw Object.assign(new Error('fixture decode stopped'), { code: 'fixture_decode' });
    });
    const accepted = [0, 1].map(index => f.set(images.png.toString('base64'), { fileName: `${index}.png` }).catch(error => error));
    await waitUntil(() => expect(started).toBe(2));
    let pendingSettled = 0;
    accepted.push(...[2, 3].map(index => f.set(images.png.toString('base64'), { fileName: `${index}.png` }).catch(error => error).finally(() => { pendingSettled++; })));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(pendingSettled).toBe(0); expect(active).toBe(2); expect(maximum).toBe(2);
    const rejected = await f.set(images.png.toString('base64'), { fileName: '4.png' }).catch(error => error);
    expect(rejected).toMatchObject({ code: 'material_busy' }); expect(decoder).toHaveBeenCalledTimes(2);
    for (let completed = 0; completed < 4; completed++) {
      await waitUntil(() => expect(releases.length).toBeGreaterThan(0));
      releases.shift()!();
      if (completed < 2) await waitUntil(() => expect(started).toBe(completed + 3));
    }
    expect((await Promise.all(accepted)).map(error => error.code)).toEqual(Array(4).fill('fixture_decode'));
    expect(maximum).toBe(2); expect(decoder).toHaveBeenCalledTimes(4);
    expect((await f.service.library({ action: 'read', id: f.entry.id })).entry).toMatchObject({ revision: 1, coverRevision: 0, cover: null, coverStatus: 'none' });
  });

  it('drops queued work made stale by either tag or cover revision before calling Sharp', async () => {
    const images = await formats();
    for (const stale of ['tag', 'cover'] as const) {
      const f = await fixture();
      let expectedCoverRevision = 0;
      if (stale === 'cover') { await f.set(images.webp.toString('base64')); expectedCoverRevision = 1; }
      const releases: Array<() => void> = [];
      const decoder = vi.spyOn(coverModule, 'normalizeMaterialCover').mockImplementation(async () => {
        await new Promise<void>(resolve => releases.push(resolve));
        throw Object.assign(new Error('fixture decode stopped'), { code: 'fixture_decode' });
      });
      const held = [0, 1].map(index => f.set(images.png.toString('base64'), { expectedCoverRevision, fileName: `held-${index}.png` }).catch(error => error));
      await waitUntil(() => expect(decoder).toHaveBeenCalledTimes(2));
      let queuedSettled = false;
      const queued = f.set(images.jpeg.toString('base64'), { expectedCoverRevision, fileName: 'queued.jpg' }).then(value => ({ value, error: null }), error => ({ value: null, error })).finally(() => { queuedSettled = true; });
      // Both decode slots remain gated while the third request completes its
      // initial filesystem CAS and waits in the lane queue.
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(queuedSettled).toBe(false); expect(decoder).toHaveBeenCalledTimes(2);
      if (stale === 'tag') await f.service.library({ action: 'save', id: f.entry.id, expectedRevision: 1, entry: tag('changed', 'english') });
      else await f.service.samples({ action: 'clear_cover', entryId: f.entry.id, expectedCoverRevision: 1 });
      releases.shift()!();
      const outcome = await queued;
      expect(outcome.error).toMatchObject({ code: stale === 'tag' ? 'material_conflict' : 'cover_conflict' });
      expect(decoder).toHaveBeenCalledTimes(2);
      releases.shift()!(); await Promise.all(held);
      expect(decoder).toHaveBeenCalledTimes(2);
      decoder.mockRestore();
    }
  });

  it('has one concurrent cover CAS winner and rejects a tag edit racing decode without publishing bytes', async () => {
    const f = await fixture();
    const largeA = await sharp({ create: { width: 4000, height: 4000, channels: 3, background: '#112233' } }).png().toBuffer();
    const largeB = await sharp({ create: { width: 4000, height: 4000, channels: 3, background: '#332211' } }).png().toBuffer();
    const contenders = await Promise.allSettled([f.set(largeA.toString('base64'), { fileName: 'a.png' }), f.set(largeB.toString('base64'), { fileName: 'b.png' })]);
    expect(contenders.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect((contenders.find(value => value.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('cover_conflict');
    const current = await f.service.samples({ action: 'cover', entryId: f.entry.id });
    const pending = f.set(largeA.toString('base64'), { revision: 1, expectedCoverRevision: 1, fileName: 'racing.png' });
    await f.service.library({ action: 'save', id: f.entry.id, expectedRevision: 1, entry: tag('changed', 'english') });
    await expect(pending).rejects.toMatchObject({ code: 'material_conflict' });
    await f.service.library({ action: 'save', id: f.entry.id, expectedRevision: 2, entry: tag('soft_lighting', 'english') });
    expect((await f.service.samples({ action: 'cover', entryId: f.entry.id })).cover.sha256).toBe(current.cover.sha256);
  });

  it('restarts offline, exports/imports local provenance and leaves changed text/source stale', async () => {
    const f = await fixture(); const images = await formats(); await f.set(images.gif.toString('base64'), { fileName: 'first-frame.gif' });
    const before = await f.service.samples({ action: 'cover', entryId: f.entry.id }), backup = await f.service.library({ action: 'export' });
    // The window's preview check (the host's own contract) takes the host's export, cover included (4c1 review rework).
    expect(parseLibraryBackup(JSON.stringify(backup.data))).toMatchObject({ ok: true });
    const offlineTags = { search: vi.fn(), details: vi.fn(() => Promise.reject(new Error('offline'))) }, offlineGallery = { search: vi.fn(), detail: vi.fn(), image: vi.fn() };
    const reopened = openLibraryRepository({ filePath: path.join(f.root, 'library.sqlite'), libraryDirectory: f.root }); repositories.push(reopened);
    const restarted = createMaterialLibraryService({ directory: f.root, repository: reopened, tags: offlineTags, gallery: offlineGallery as any });
    expect(await restarted.samples({ action: 'cover', entryId: f.entry.id })).toEqual(before);
    expect((await restarted.library({ action: 'list' })).items[0].coverStatus).toBe('ready');
    expect(offlineTags.details).not.toHaveBeenCalled(); expect(offlineGallery.image).not.toHaveBeenCalled();
    const imported = await restarted.library({ action: 'import', data: backup.data });
    const copy = imported.items[0];
    const image = await restarted.samples({ action: 'cover', entryId: copy.id });
    expect(image.data).toBe(before.data);
    expect(image.cover).toMatchObject({ source: 'local', fileName: 'first-frame.gif', sourceSha256: sha(images.gif), tagSource: 'english', verification: 'imported', checkedAt: null, postId: null, sourceUrl: null, rating: null });
    await restarted.library({ action: 'save', id: copy.id, expectedRevision: 1, entry: tag('soft_lighting', 'nai') });
    expect((await restarted.library({ action: 'read', id: copy.id })).entry).toMatchObject({ coverStatus: 'stale', cover: null });
    await expect(restarted.samples({ action: 'cover', entryId: copy.id })).rejects.toMatchObject({ code: 'cover_stale' });
  });

  it('routes SQLite reads/lists through the unified repository and retains immutable old blobs/assets', async () => {
    const f = await fixture('english'); const images = await formats();
    const first = await f.set(images.png.toString('base64'));
    const second = await f.set(images.jpeg.toString('base64'), { expectedCoverRevision: 1, fileName: 'replacement.jpg' });
    expect((await f.service.library({ action: 'read', id: f.entry.id })).entry).toMatchObject({ coverRevision: 2, coverStatus: 'ready', cover: { source: 'local', sha256: second.cover.sha256 } });
    expect((await f.service.library({ action: 'list' })).items[0]).toMatchObject({ coverRevision: 2, cover: { source: 'local', fileName: 'replacement.jpg' } });
    const blobs = (await fs.readdir(path.join(f.root, 'covers'))).filter(name => name.endsWith('.webp'));
    expect(blobs).toEqual(expect.arrayContaining([`${first.cover.sha256}.webp`, `${second.cover.sha256}.webp`]));
    const hashes = f.repo!.assets().map(asset => asset.payload.sha256);
    expect(hashes).toEqual(expect.arrayContaining([first.cover.sha256, second.cover.sha256]));
    const databasePath = path.join(f.root, 'library.sqlite'); f.repo!.close(); repositories.splice(repositories.indexOf(f.repo!), 1);
    const reopened = openLibraryRepository({ filePath: databasePath, libraryDirectory: f.root }); repositories.push(reopened);
    const offline = createMaterialLibraryService({ directory: f.root, repository: reopened, tags: { search: vi.fn(), details: vi.fn() }, gallery: { search: vi.fn(), detail: vi.fn(), image: vi.fn() } as any });
    expect((await offline.samples({ action: 'cover', entryId: f.entry.id })).cover.sha256).toBe(second.cover.sha256);
    expect((await offline.library({ action: 'list' })).items[0].coverStatus).toBe('ready');
  });
});
