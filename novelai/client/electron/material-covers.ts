import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { MaterialBackupCover, MaterialCover, MaterialCoverState, MaterialEntry, MaterialLocalCover, MaterialSource } from '../src/workspace/material-library-types';
import { DANBOORU_RATINGS } from '../src/workspace/danbooru-types';
import type { LibraryRepository } from './library/repository';
import { withReason, type HostErrorParams } from './host-error';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
export const MATERIAL_COVER_LIMITS = { inputBytes: 20 * 1024 * 1024, outputBytes: 2 * 1024 * 1024, inputPixels: 64 * 1024 * 1024, edge: 1200, storageBytes: 64 * 1024 * 1024 };
/** reason/params: the window's catalog message (src/host-errors/library.ts); the message is English. */
class CoverError extends Error { declare reason?: string; declare params?: HostErrorParams; constructor(public code: string, message: string, reason?: string, params?: HostErrorParams) { super(message); if (reason) withReason(this, reason, params); } }
const fail = (code: string, message: string, reason?: string, params?: HostErrorParams): never => { throw new CoverError(code, message, reason, params); };
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const id = (value: string) => UUID.test(value) ? value : fail('invalid_argument', 'Invalid cover entry ID.', 'cover.invalid_id');
const version = (value: number) => Number.isSafeInteger(value) && value >= 0 ? value : fail('invalid_argument', 'Invalid cover revision.', 'cover.invalid_revision');
const timestamp = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const SOURCES: readonly MaterialSource[] = ['danbooru', 'nai', 'english'];
const commonMetadata = (value: any) => HASH.test(value.sha256) && value.mimeType === 'image/webp' && Number.isSafeInteger(value.width) && Number.isSafeInteger(value.height) && value.width >= 1 && value.height >= 1 && value.width <= MATERIAL_COVER_LIMITS.edge && value.height <= MATERIAL_COVER_LIMITS.edge && Number.isSafeInteger(value.byteLength) && value.byteLength >= 1 && value.byteLength <= MATERIAL_COVER_LIMITS.outputBytes && typeof value.tagText === 'string' && !!value.tagText && value.tagText.length <= 400 && !/[^\x20-\x7e]/.test(value.tagText) && (value.tagCategory === null || (typeof value.tagCategory === 'string' && value.tagCategory.length <= 60)) && timestamp(value.savedAt) && (value.importedAt === undefined || timestamp(value.importedAt));
/** The one check of saved cover metadata (a library cover, a cover manifest, a material backup or a library archive):
 * the cover this version reads, or cover_corrupt. */
export function readMaterialCoverMetadata(raw: unknown): MaterialCover { return metadata(raw); }
function metadata(raw: unknown): MaterialCover {
  const value = raw as any;
  const commonKeys = ['sha256', 'mimeType', 'width', 'height', 'byteLength', 'postId', 'sourceUrl', 'tagText', 'tagCategory', 'rating', 'savedAt', 'verification', 'checkedAt', 'importedAt', 'source'];
  if (!value || typeof value !== 'object' || !commonMetadata(value)) return fail('cover_corrupt', 'Invalid local cover source record; the old record was not replaced.', 'cover.corrupt_record');
  if (value.source === 'local') {
    if (Object.keys(value).some(key => ![...commonKeys, 'fileName', 'sourceSha256', 'tagSource'].includes(key)) || !validLocalFileName(value.fileName) || !HASH.test(value.sourceSha256) || !SOURCES.includes(value.tagSource) || value.postId !== null || value.sourceUrl !== null || value.rating !== null || value.checkedAt !== null || !['local', 'imported'].includes(value.verification)) return fail('cover_corrupt', 'Invalid uploaded cover source record; the old cover is kept.', 'cover.corrupt_local_record');
    return structuredClone(value) as MaterialLocalCover;
  }
  if (Object.keys(value).some(key => !commonKeys.includes(key)) || (value.source !== undefined && value.source !== 'danbooru') || !Number.isSafeInteger(value.postId) || value.postId < 1 || value.sourceUrl !== `https://danbooru.donmai.us/posts/${value.postId}` || !DANBOORU_RATINGS.includes(value.rating) || !['online', 'imported'].includes(value.verification) || (value.checkedAt !== null && !timestamp(value.checkedAt))) return fail('cover_corrupt', 'Invalid Danbooru cover source record; the old cover is kept.', 'cover.corrupt_danbooru_record');
  return structuredClone(value) as MaterialCover;
}
const matches = (entry: MaterialEntry, cover: MaterialCover) => entry.kind === 'tag' && !!entry.tag && entry.tag.text === cover.tagText && (entry.tag.category === null || entry.tag.category === cover.tagCategory) && (cover.source === 'local' ? entry.tag.source === cover.tagSource : entry.tag.source === 'danbooru');
const validLocalFileName = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 255 && value.trim().length > 0 && value !== '.' && value !== '..' && path.posix.basename(value) === value && path.win32.basename(value) === value && !/[\\/\x00-\x1f\x7f]/.test(value);
export const localFileName = (value: unknown): string => {
  if (!validLocalFileName(value)) return fail('invalid_argument', 'The cover file name must be a plain file name of 1–255 characters, without a path or control characters.', 'cover.invalid_file_name');
  return value;
};
const decodeBase64 = (data: unknown, maximum: number) => {
  if (typeof data !== 'string' || !data || data.length > Math.ceil(maximum / 3) * 4 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return fail('cover_invalid_image', 'The cover image encoding is invalid or too large.', 'cover.invalid_encoding');
  const bytes = Buffer.from(data, 'base64'); if (bytes.length > maximum || bytes.toString('base64') !== data) return fail('cover_invalid_image', 'The cover image encoding is invalid or too large.', 'cover.invalid_encoding');
  return bytes;
};

const sniff = (input: Buffer): 'png' | 'jpeg' | 'webp' | 'gif' => {
  if (input.length >= 8 && input.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (input.length >= 3 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) return 'jpeg';
  if (input.length >= 12 && input.subarray(0, 4).toString('ascii') === 'RIFF' && input.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (input.length >= 6 && ['GIF87a', 'GIF89a'].includes(input.subarray(0, 6).toString('ascii'))) return 'gif';
  return fail('cover_invalid_image', 'A cover must be an actual PNG, JPEG, WebP or GIF image.', 'cover.unsupported_format');
};

/** Bounded asynchronous decoding preserves the full first frame; no crop or upscale. */
export async function normalizeMaterialCover(data: string) {
  const input = decodeBase64(data, MATERIAL_COVER_LIMITS.inputBytes), format = sniff(input), sourceSha256 = digest(input);
  try {
    const decoder = sharp(input, { limitInputPixels: MATERIAL_COVER_LIMITS.inputPixels, failOn: 'error', animated: false });
    const source = await decoder.metadata();
    if (source.format !== format) return fail('cover_invalid_image', 'The cover image signature does not match its decoded format.', 'cover.format_mismatch');
    const { data: bytes, info } = await decoder.timeout({ seconds: 12 }).rotate().resize({ width: MATERIAL_COVER_LIMITS.edge, height: MATERIAL_COVER_LIMITS.edge, fit: 'inside', withoutEnlargement: true }).webp({ quality: 84 }).toBuffer({ resolveWithObject: true });
    if (bytes.length > MATERIAL_COVER_LIMITS.outputBytes) return fail('cover_invalid_image', 'The resized cover exceeds 2 MiB.', 'cover.too_large');
    return { bytes, sourceSha256, sha256: digest(bytes), mimeType: 'image/webp' as const, width: info.width, height: info.height, byteLength: bytes.length };
  } catch (error) { if (error instanceof CoverError) throw error; return fail('cover_invalid_image', 'The cover cannot be decoded safely; the old cover is kept.', 'cover.decode_failed'); }
}

/** Local-only storage: the cover records (coverRevision and metadata) are the library's covers, the image files are
 * <library directory>/covers/<sha256>.webp. The caller holds its independent material persistence lane for set/clear;
 * no generator lock or outbound service is used here. */
export function createMaterialCoverStore(libraryDirectory: string, repository: LibraryRepository) {
  const directory = path.join(path.resolve(libraryDirectory), 'covers');
  const verifiedBlobs = new Map<string, string>();
  /** Creates the covers folder when needed and checks that it is the library's own folder (not a link elsewhere). */
  const ensureDirectory = async () => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== path.join(await fs.realpath(libraryDirectory), 'covers')) fail('cover_storage_failed', 'The cover folder is not owned by the library.', 'cover.folder_not_owned');
  };
  const imageFile = (sha256: string) => path.join(directory, `${HASH.test(sha256) ? sha256 : fail('cover_corrupt', 'Invalid cover digest.', 'cover.invalid_digest')}.webp`);
  const readFile = async (file: string, maximum: number) => {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > maximum) fail('cover_corrupt', 'The cover file is invalid or too large.', 'cover.invalid_file'); return await handle.readFile(); } finally { await handle.close(); }
  };
  const read = async (entryId: string): Promise<{ entryId: string; coverRevision: number; cover: MaterialCover | null }> => {
    id(entryId);
    const value = repository.getCover('tag', entryId);
    return value ? { entryId, coverRevision: value.coverRevision, cover: value.cover === null ? null : metadata(value.cover) } : { entryId, coverRevision: 0, cover: null };
  };
  const state = async (entry: MaterialEntry): Promise<MaterialCoverState> => {
    let coverRevision = 0;
    try {
      const saved = await read(entry.id); coverRevision = saved.coverRevision;
      if (!saved.cover) return { entryId: entry.id, entryRevision: entry.revision, coverRevision, cover: null, coverStatus: 'none' };
      if (!matches(entry, saved.cover)) return { entryId: entry.id, entryRevision: entry.revision, coverRevision, cover: null, coverStatus: 'stale' };
      const stat = await fs.lstat(imageFile(saved.cover.sha256));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== saved.cover.byteLength) fail('cover_corrupt', 'The local cover image is missing or changed.', 'cover.file_changed');
      const signature = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
      if (verifiedBlobs.get(saved.cover.sha256) !== signature) {
        const bytes = await readFile(imageFile(saved.cover.sha256), MATERIAL_COVER_LIMITS.outputBytes);
        if (digest(bytes) !== saved.cover.sha256) fail('cover_corrupt', 'The local cover image digest does not match.', 'cover.digest_mismatch');
        verifiedBlobs.set(saved.cover.sha256, signature);
      }
      return { entryId: entry.id, entryRevision: entry.revision, coverRevision, cover: saved.cover, coverStatus: 'ready' };
    } catch { return { entryId: entry.id, entryRevision: entry.revision, coverRevision, cover: null, coverStatus: 'unavailable' }; }
  };
  const image = async (entry: MaterialEntry) => {
    const saved = await read(entry.id);
    if (!saved.cover) return fail('cover_missing', 'This tag has no saved local cover.', 'cover.missing');
    if (!matches(entry, saved.cover)) return fail('cover_stale', 'The English identity of the tag changed; the old cover does not belong to the current tag.', 'cover.stale');
    try {
      const bytes = await readFile(imageFile(saved.cover.sha256), MATERIAL_COVER_LIMITS.outputBytes);
      if (bytes.length !== saved.cover.byteLength || digest(bytes) !== saved.cover.sha256) fail('cover_corrupt', 'The local cover image digest does not match.', 'cover.digest_mismatch');
      return { entryId: entry.id, entryRevision: entry.revision, coverRevision: saved.coverRevision, cover: saved.cover, coverStatus: 'ready' as const, mimeType: 'image/webp' as const, data: bytes.toString('base64') };
    } catch (error) { if (error instanceof CoverError) throw error; return fail('cover_corrupt', 'The local cover image cannot be read; no network request was made.', 'cover.unreadable'); }
  };
  const budget = async (additional: number) => {
    let bytes = additional;
    for (const name of await fs.readdir(directory)) { const file = path.join(directory, name), stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) fail('cover_storage_failed', 'The cover folder contains unsupported files.', 'cover.folder_unsupported'); bytes += stat.size; }
    if (bytes > MATERIAL_COVER_LIMITS.storageBytes) fail('cover_storage_full', 'Local cover storage exceeds 64 MiB; the old cover is kept.', 'cover.storage_full');
  };
  /** Publishes an immutable image file (named by its digest); an identical existing file is kept. */
  const publish = async (file: string, bytes: Buffer) => {
    const temporary = path.join(directory, `.${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      try { await fs.link(temporary, file); } catch (error: any) { if (error.code !== 'EEXIST' || !(await readFile(file, MATERIAL_COVER_LIMITS.outputBytes)).equals(bytes)) throw error; }
      // Publication has committed. A directory-sync failure cannot be reported
      // as a rejected edit (which would incorrectly imply the old cover stayed).
      try { const dir = await fs.open(directory, 'r'); try { await dir.sync(); } finally { await dir.close(); } } catch { /* atomic file remains readable; no provider or retry work */ }
    } finally { await fs.unlink(temporary).catch(() => undefined); }
  };
  const set = async (entry: MaterialEntry, expected: number, cover: MaterialCover | null, bytes?: Buffer) => {
    version(expected); const previous = await read(entry.id);
    if (previous.coverRevision !== expected) return fail('cover_conflict', 'The cover changed; read it again before saving.', 'cover.changed_save');
    if (cover) { metadata(cover); if (!matches(entry, cover) || !bytes || bytes.length !== cover.byteLength || digest(bytes) !== cover.sha256) return fail('cover_invalid_image', 'The cover does not match the current tag or image.', 'cover.mismatch'); }
    if (!cover && !previous.cover) return state(entry);
    await ensureDirectory();
    let additional = bytes?.length ?? 0;
    if (cover && bytes) {
      try { const existing = await readFile(imageFile(cover.sha256), MATERIAL_COVER_LIMITS.outputBytes); if (!existing.equals(bytes)) fail('cover_corrupt', 'A cover file with the same digest is damaged; the old record is kept.', 'cover.same_digest_damaged'); additional = 0; }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
    // Clearing never requires extra image capacity; reusing a known identical image is not charged again.
    if (cover) await budget(additional);
    if (cover && bytes) await publish(imageFile(cover.sha256), bytes);
    // Image files are kept after a replacement or clear: earlier cover revisions (and Recently Deleted) may still name them.
    repository.setCover('tag', entry.id, cover, previous.coverRevision);
    return state(entry);
  };
  const validateBackup = async (raw: unknown): Promise<MaterialBackupCover> => {
    const value = raw as MaterialBackupCover;
    if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['entryId', 'cover', 'data'].includes(key))) return fail('invalid_argument', 'Invalid backup cover format.', 'cover.backup_format');
    id(value.entryId); const cover = metadata(value.cover), bytes = decodeBase64(value.data, MATERIAL_COVER_LIMITS.outputBytes);
    if (bytes.length !== cover.byteLength || digest(bytes) !== cover.sha256) return fail('cover_corrupt', 'A backup cover digest or size does not match.', 'cover.backup_digest');
    try {
      const info = await sharp(bytes, { limitInputPixels: MATERIAL_COVER_LIMITS.edge ** 2, failOn: 'error', animated: false }).metadata();
      if (info.format !== 'webp' || (info.pages ?? 1) !== 1 || (info.orientation ?? 1) !== 1 || info.width !== cover.width || info.height !== cover.height) return fail('cover_invalid_image', 'A backup cover format or size does not match.', 'cover.backup_dimensions');
      await sharp(bytes, { limitInputPixels: MATERIAL_COVER_LIMITS.edge ** 2, failOn: 'error' }).timeout({ seconds: 8 }).raw().toBuffer();
    } catch (error) { if (error instanceof CoverError) throw error; return fail('cover_invalid_image', 'A backup cover cannot be decoded.', 'cover.backup_decode'); }
    return { entryId: value.entryId, cover, data: value.data };
  };
  const coverRevision = async (entryId: string) => (await read(entryId)).coverRevision;
  return { state, image, set, validateBackup, matches, coverRevision };
}
