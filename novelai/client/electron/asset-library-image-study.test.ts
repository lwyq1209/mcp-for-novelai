// Issue #2: the library image reader reads study (imported image) originals with the same checks as history
// originals. Real SQLite repository with libraryDirectory, real study service (parse = parseImageStudy), real asset
// library service and reader; temporary directories only.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';
import { openLibraryRepository } from './library/repository';
import { createAssetLibraryService } from './asset-library-service';
import { createHistoryImageReader } from './asset-library-image';
import { createImageStudyService } from './image-studies';
import { parseImageStudy } from './image-study-parser';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { vi.restoreAllMocks(); await runCleanups(cleanups.splice(0).reverse()); });

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nai-study-image-')));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, '.runtime'), libraryDirectory = path.resolve(runtimeDir, '..', 'library'), userData = path.join(root, 'user-data');
  for (const dir of [runtimeDir, libraryDirectory, userData]) await fs.mkdir(dir, { recursive: true });
  const repository = openLibraryRepository({ filePath: path.join(userData, 'library.sqlite'), libraryDirectory, userDataRoot: userData });
  cleanups.push(() => repository.close());
  const studies = createImageStudyService({ directory: path.join(libraryDirectory, 'studies'), repository, parse: parseImageStudy });
  cleanups.push(() => studies.dispose());
  const service = createAssetLibraryService({ repository, study: args => studies.material_studies(args) });
  const reader = createHistoryImageReader(repository);
  const importStudy = async (bytes: Buffer, name: string) => {
    const result = await studies.material_studies({ action: 'import', name, data: bytes.toString('base64') }) as any;
    const id = result.study.id as string, revision = result.study.revision as number;
    const extension = result.study.mimeType === 'image/jpeg' ? 'jpg' : result.study.mimeType === 'image/webp' ? 'webp' : 'png';
    const originals = repository.versionAssets(repository.get('study', id, revision)!).filter(asset => asset.role === 'original');
    return { id, revision, duplicate: result.duplicate as boolean, original: path.join(libraryDirectory, 'studies', id, `original.${extension}`), assetId: originals[0]?.id };
  };
  return { root, repository, studies, service, reader, importStudy };
}
const png = (width: number, height: number, background = '#4a7bd0') => sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();

it('reads the exact study revision: thumbnail and original, recorded sha256, the single registered original as assetId', async () => {
  const f = await fixture(), bytes = await png(640, 960), study = await f.importStudy(bytes, 'portrait.png');
  const facts = { kind: 'study', id: study.id, revision: 1, assetId: study.assetId, role: 'original', sourceMimeType: 'image/png', sourceWidth: 640, sourceHeight: 960, sourceByteLength: bytes.length, sourceSha256: sha256(bytes), contentBinding: 'recorded-sha256' };
  const thumbnail = await f.service.asset_library({ action: 'image', kind: 'study', id: study.id, revision: 1 });
  expect(thumbnail).toMatchObject({ ...facts, variant: 'thumbnail', mimeType: 'image/webp', width: 256, height: 384 });
  expect(thumbnail).not.toHaveProperty('sourceOrientation'); // a PNG without EXIF has no orientation
  const original = await f.service.asset_library({ action: 'image', kind: 'study', id: study.id, revision: 1, variant: 'original' });
  expect(original).toMatchObject({ ...facts, variant: 'original', mimeType: 'image/png', width: 640, height: 960 });
  expect(Buffer.from(original.data, 'base64')).toEqual(bytes);
  // The reader itself accepts the original's assetId (and nothing else), as the recipe store never sends one.
  await expect(f.reader({ kind: 'study', id: study.id, revision: 1, assetId: study.assetId, variant: 'thumbnail' })).resolves.toMatchObject({ assetId: study.assetId });
  await expect(f.reader({ kind: 'study', id: study.id, revision: 1, assetId: `path:${'0'.repeat(64)}`, variant: 'thumbnail' })).rejects.toMatchObject({ code: 'library_conflict' });
});

it('every existing revision reads the same original; archived studies stay readable; unknown studies or revisions are library_not_found', async () => {
  const f = await fixture(), bytes = await png(128, 128), study = await f.importStudy(bytes, 'tile.png');
  await f.studies.material_studies({ action: 'update', id: study.id, expectedRevision: 1, patch: { name: 'renamed' } });
  await f.service.asset_library({ action: 'mutate', command: 'archive', items: [{ kind: 'study', id: study.id, expectedRevision: 2 }], patch: { archived: true } });
  expect(f.repository.get('study', study.id)?.revision).toBe(3);
  for (const revision of [1, 2, 3]) {
    const original = await f.service.asset_library({ action: 'image', kind: 'study', id: study.id, revision, variant: 'original' });
    expect([original.revision, original.assetId, original.sourceSha256]).toEqual([revision, study.assetId, sha256(bytes)]);
  }
  await expect(f.service.asset_library({ action: 'image', kind: 'study', id: study.id, revision: 4 })).rejects.toMatchObject({ code: 'library_not_found' });
  await expect(f.service.asset_library({ action: 'image', kind: 'study', id: randomUUID(), revision: 1 })).rejects.toMatchObject({ code: 'library_not_found' });
  // A history id of the same value is a different record: kinds never borrow each other's originals.
  await expect(f.reader({ kind: 'history', id: study.id, revision: 1, assetId: study.assetId!, variant: 'thumbnail' })).rejects.toMatchObject({ code: 'library_not_found' });
});

it('a replaced or missing original fails closed; the study record is unchanged', async () => {
  const f = await fixture(), bytes = await png(256, 128), study = await f.importStudy(bytes, 'wide.png');
  const snapshot = f.repository.exportSnapshot();
  await fs.writeFile(study.original, await png(256, 128, '#ff0000'));
  await expect(f.service.asset_library({ action: 'image', kind: 'study', id: study.id, revision: 1 })).rejects.toMatchObject({ code: 'image_changed' });
  await fs.rm(study.original);
  await expect(f.service.asset_library({ action: 'image', kind: 'study', id: study.id, revision: 1, variant: 'original' })).rejects.toMatchObject({ code: 'image_unavailable', message: expect.stringContaining('study'), reason: 'library.study_image_missing' });
  await fs.writeFile(study.original, bytes);
  await expect(f.service.asset_library({ action: 'image', kind: 'study', id: study.id, revision: 1 })).resolves.toMatchObject({ variant: 'thumbnail' });
  expect(f.repository.exportSnapshot()).toEqual(snapshot);
});

it('reports EXIF orientation of a study original; history replies never carry the field', async () => {
  const f = await fixture();
  const rotated = await sharp({ create: { width: 96, height: 64, channels: 3, background: '#335577' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const upright = await sharp({ create: { width: 96, height: 64, channels: 3, background: '#557733' } }).jpeg().withMetadata({ orientation: 1 }).toBuffer();
  const a = await f.importStudy(rotated, 'rotated.jpg'), b = await f.importStudy(upright, 'upright.jpg');
  const read = await f.service.asset_library({ action: 'image', kind: 'study', id: a.id, revision: 1 });
  expect(read).toMatchObject({ sourceOrientation: 6, sourceMimeType: 'image/jpeg', sourceWidth: 96, sourceHeight: 64 });
  expect(await f.service.asset_library({ action: 'image', kind: 'study', id: b.id, revision: 1 })).toMatchObject({ sourceOrientation: 1 });
  // The same rotated JPEG registered as a history original: the history reply shape is unchanged.
  const file = path.join(f.root, 'history.jpg'); await fs.writeFile(file, rotated);
  f.repository.put('history', 'history-jpeg', { id: 'history-jpeg', filePath: file, date: '2026-11-01', params: { positivePrompt: 'x' }, sha256: sha256(rotated), mimeType: 'image/jpeg', byteLength: rotated.length });
  const assetId = f.repository.versionAssets(f.repository.get('history', 'history-jpeg', 1)!).find(asset => asset.role === 'original')!.id;
  const history = await f.service.asset_library({ action: 'image', kind: 'history', id: 'history-jpeg', revision: 1, assetId });
  expect(history).not.toHaveProperty('sourceOrientation');
  expect(history.kind).toBe('history');
});

it('the contract keeps the study branch closed: no assetId, a study UUID, revision ≥ 1; a study needs a registered original', async () => {
  const f = await fixture(), study = await f.importStudy(await png(64, 64), 'small.png');
  for (const args of [
    { action: 'image', kind: 'study', id: study.id, revision: 1, assetId: study.assetId },
    { action: 'image', kind: 'study', id: 'not-a-uuid', revision: 1 },
    { action: 'image', kind: 'study', id: study.id, revision: 0 },
    { action: 'image', kind: 'study', id: study.id },
    { action: 'image', kind: 'study', id: study.id, revision: 1, variant: 'preview' },
    { action: 'image', kind: 'note', id: study.id, revision: 1 },
  ]) await expect(f.service.asset_library(args)).rejects.toMatchObject({ code: 'invalid_argument' });
  // A repository without libraryDirectory registers no study original: image_unavailable, never a guess.
  const bare = openLibraryRepository({ filePath: path.join(f.root, 'bare.sqlite') });
  cleanups.push(() => bare.close());
  bare.put('study', study.id, f.repository.get('study', study.id)!.payload);
  await expect(createHistoryImageReader(bare)({ kind: 'study', id: study.id, revision: 1, variant: 'thumbnail' })).rejects.toMatchObject({ code: 'image_unavailable' });
  // Review P3-4: a filePath inside a study payload never becomes the study original, with or without libraryDirectory.
  const elsewhere = path.join(f.root, 'elsewhere.png'); await fs.writeFile(elsewhere, await png(64, 64, '#00ff00'));
  bare.put('study', study.id, { ...f.repository.get('study', study.id)!.payload, filePath: elsewhere }, { expectedRevision: 1 });
  await expect(createHistoryImageReader(bare)({ kind: 'study', id: study.id, revision: 2, variant: 'thumbnail' })).rejects.toMatchObject({ code: 'image_unavailable', message: expect.stringContaining('study folder'), reason: 'library.study_image_outside' });
  f.repository.put('study', study.id, { ...f.repository.get('study', study.id)!.payload, filePath: elsewhere }, { expectedRevision: 1 });
  await expect(f.reader({ kind: 'study', id: study.id, revision: 2, variant: 'thumbnail' })).rejects.toMatchObject({ code: 'image_unavailable' });
  await expect(f.reader({ kind: 'study', id: study.id, revision: 1, variant: 'thumbnail' })).resolves.toMatchObject({ revision: 1 });
});

it('animated originals are refused: the study import rejects them, and the reader refuses one registered anyway', async () => {
  const f = await fixture();
  const frames = Buffer.alloc(8 * 16 * 3); for (let pixel = 0; pixel < 128; pixel++) frames[pixel * 3 + (pixel < 64 ? 0 : 2)] = 255;
  const animated = await sharp(frames, { raw: { width: 8, height: 16, channels: 3, pageHeight: 8 } }).webp({ delay: [100, 100] }).toBuffer();
  await expect(f.studies.material_studies({ action: 'import', name: 'animated.webp', data: animated.toString('base64') })).rejects.toMatchObject({ code: 'invalid_image' });
  // Defense in depth: a study revision whose registered original is animated (written here directly).
  const study = await f.importStudy(await png(8, 8), 'still.png'), current = f.repository.get('study', study.id)!;
  const payload = { ...current.payload, study: { ...current.payload.study, mimeType: 'image/webp', sha256: sha256(animated), byteLength: animated.length } };
  f.repository.put('study', study.id, payload, { expectedRevision: 1 });
  await fs.writeFile(path.join(path.dirname(study.original), 'original.webp'), animated);
  await expect(f.reader({ kind: 'study', id: study.id, revision: 2, variant: 'thumbnail' })).rejects.toMatchObject({ code: 'unsupported_image' });
  await expect(f.reader({ kind: 'study', id: study.id, revision: 1, variant: 'thumbnail' })).resolves.toMatchObject({ revision: 1 });
});

it('re-importing the same bytes returns the same study; a lost receipt can be checked read-only by listing its sha256', async () => {
  const f = await fixture(), bytes = await png(96, 96), first = await f.importStudy(bytes, 'first.png');
  const again = await f.importStudy(bytes, 'second-name.png');
  expect([again.duplicate, again.id, again.revision, again.assetId]).toEqual([true, first.id, 1, first.assetId]);
  const listed = await f.studies.material_studies({ action: 'list', query: sha256(bytes) }) as any;
  expect(listed.items.map((item: any) => item.id)).toEqual([first.id]);
  await f.service.asset_library({ action: 'mutate', command: 'archive', items: [{ kind: 'study', id: first.id, expectedRevision: 1 }], patch: { archived: true } });
  expect((await f.studies.material_studies({ action: 'list', query: sha256(bytes) }) as any).items).toEqual([]);
  expect((await f.studies.material_studies({ action: 'list', query: sha256(bytes), includeArchived: true }) as any).items.map((item: any) => item.id)).toEqual([first.id]);
  // An archived study re-imported is still the same entry, and stays readable as a source.
  const archived = await f.importStudy(bytes, 'third.png');
  expect([archived.duplicate, archived.id, archived.revision]).toEqual([true, first.id, 2]);
  await expect(f.service.asset_library({ action: 'image', kind: 'study', id: first.id, revision: 2 })).resolves.toMatchObject({ assetId: first.assetId });
});

it('history failure codes are the ones from before issue #2 (review P3-2); an unknown kind is an argument error', async () => {
  const f = await fixture();
  const code = (target: any) => f.reader(target).then(() => 'ok', (error: any) => error.code);
  expect(await code({ kind: 'history', id: 'h1', revision: 0, assetId: 'a', variant: 'original' })).toBe('library_not_found');
  // The repository refuses ids over 500 characters (the contract allows 512): the reader still answers invalid_image, as before.
  expect(await code({ kind: 'history', id: 'x'.repeat(501), revision: 1, assetId: 'a', variant: 'original' })).toBe('invalid_image');
  await expect(f.service.asset_library({ action: 'image', kind: 'history', id: 'x'.repeat(501), revision: 1, assetId: 'a' })).rejects.toMatchObject({ code: 'invalid_image' });
  expect(await code({ kind: 'note', id: 'n1', revision: 1, assetId: 'a', variant: 'original' })).toBe('invalid_argument');
});

it('study and history reads share the reader’s two-read admission', async () => {
  const f = await fixture(), study = await f.importStudy(await png(512, 512), 'busy.png');
  const target = { action: 'image', kind: 'study', id: study.id, revision: 1 };
  const pending = [f.service.asset_library(target), f.service.asset_library(target)];
  await expect(f.service.asset_library(target)).rejects.toMatchObject({ code: 'image_busy' });
  await Promise.all(pending);
  await expect(f.service.asset_library(target)).resolves.toMatchObject({ kind: 'study' });
});
