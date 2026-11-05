import fs from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openNoFollow } from './platform-fs';
import sharp from 'sharp';
import type { LibraryRepository } from './library/repository';
import type { LibraryItemAsset } from './library/types';
import { hostError, type HostErrorParams } from './host-error';

export const HISTORY_IMAGE_LIMITS = { bytes: 20 * 1024 * 1024, pixels: 32_000_000, edge: 384, active: 2, decodeSeconds: 5 } as const;
const fail = (code: string, message: string, reason?: string, params?: HostErrorParams): never => { throw hostError(code, message, reason, params); };
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const signature = (stat: Stats) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const imageMime = (bytes: Buffer): string | undefined => {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 10 && ['GIF87a','GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  return undefined;
};
function animatedPng(bytes: Buffer, kind: ImageKind = 'history') {
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (offset + length + 12 > bytes.length) fail('invalid_image', ...about(kind, 'png_truncated'));
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'acTL') return true;
    offset += length + 12;
  }
  return false;
}
/** history: a version-registered original chosen by assetId. study (issue #2): the single original registered for one
 * study (imported image) revision; assetId is optional and, when given, must be that original. */
export type LibraryImageTarget =
  | { kind: 'history'; id: string; revision: number; assetId: string; variant?: 'thumbnail' | 'original' }
  | { kind: 'study'; id: string; revision: number; assetId?: string; variant?: 'thumbnail' | 'original' };
type Target = LibraryImageTarget;
type ImageKind = 'history' | 'study';
const kindOf = (args: Target): ImageKind => args.kind === 'study' ? 'study' : 'history';
/** Errors that name the record type of the request: the English message and the window reason of that kind
 * (library.history_image_* or library.study_image_*, src/host-errors/library.ts). */
const KIND_MESSAGES = {
  png_truncated: 'The {kind} PNG data is incomplete.',
  busy: 'A {kind} image read is already in progress; nothing was queued or retried.',
  symlink: 'The {kind} image path contains a symbolic link or a non-canonical alias.',
  not_file: 'The {kind} image must be a plain file, not a symbolic link or folder.',
  size: 'The {kind} image is empty or exceeds 20 MiB.',
  changed_open: 'The {kind} image changed while it was opened; no image was returned.',
  changed_read: 'The {kind} image changed while it was read; no image was returned.',
  path_changed: 'The {kind} image path changed while it was read.',
  binding_changed: 'The {kind} revision or its registered assets changed while reading; no image was returned.',
  digest: 'The original does not match the digest registered for this {kind} revision.',
  byte_length: 'The original size does not match the {kind} record.',
  pixels: 'The {kind} image exceeds 32 million pixels.',
  missing: 'The registered original is missing or unreadable; the {kind} record is unchanged.',
  decode: 'The {kind} image cannot be decoded safely or exceeds the pixel or decode limits; the original was not changed.',
} as const;
const about = (kind: ImageKind, key: keyof typeof KIND_MESSAGES): [string, string] => [KIND_MESSAGES[key].replaceAll('{kind}', kind), `library.${kind}_image_${key}`];

/** Only immutable version-registered originals confer read authority. No job,
 * workspace, caller paths, global asset lookup or desktop thumbnail fallback.
 * Reads history originals and (issue #2) study originals with the same checks;
 * the name stays for its existing callers (main.ts readHistoryOriginal). */
export function createHistoryImageReader(repo: LibraryRepository) {
  let active = 0;
  const resolve = (args: Target): LibraryItemAsset => {
    if (args.kind === 'study') {
      if (!repo.get('study', args.id)) return fail('library_not_found', 'The study entry does not exist; no file was read.', 'library.study_image_entry_missing');
      const study = repo.get('study', args.id, args.revision);
      if (!study) return fail('library_not_found', 'The study revision does not exist; name an exact saved revision.', 'library.study_image_revision_missing');
      const registered = repo.versionAssets(study).filter(asset => asset.role === 'original');
      if (registered.length !== 1) return fail('image_unavailable', 'This study revision has no single registered original; no image is guessed from other entries or the canvas.', 'library.study_image_unregistered');
      // Only the original the repository derives for a study (<libraryDirectory>/studies/<id>/original.<ext>) counts;
      // a filePath written into a study payload is never a study original.
      const file = registered[0].payload.filePath;
      if (typeof file !== 'string' || !/^original\.(?:png|jpg|webp)$/.test(path.basename(file)) || path.basename(path.dirname(file)) !== args.id || path.basename(path.dirname(path.dirname(file))) !== 'studies')
        return fail('image_unavailable', 'The registered original of this study revision is not in the study folder; no other path is read.', 'library.study_image_outside');
      if (args.assetId !== undefined && registered[0].id !== args.assetId) return fail('library_conflict', 'assetId is not the registered original of this study revision.', 'library.study_image_asset_mismatch');
      return registered[0];
    }
    if (args.kind !== 'history') return fail('invalid_argument', 'Only registered originals of history or study entries are read.', 'library.image_kind');
    if (!repo.get('history', args.id)) return fail('library_not_found', 'The history entry does not exist; no file was read.', 'library.history_image_entry_missing');
    const item = repo.get('history', args.id, args.revision);
    if (!item) return fail('library_not_found', 'The history revision does not exist; name an exact saved revision.', 'library.history_image_revision_missing');
    const originals = repo.versionAssets(item).filter(asset => asset.role === 'original');
    if (!originals.length) return fail('image_unavailable', 'This history revision has no registered original; no image is guessed from other entries or the canvas.', 'library.history_image_unregistered');
    const asset = originals.find(value => value.id === args.assetId);
    if (!asset) return fail('library_conflict', 'assetId is not a registered original of this history revision.', 'library.history_image_asset_mismatch');
    return asset;
  };
  return async (args: Target) => {
    if (active >= HISTORY_IMAGE_LIMITS.active) return fail('image_busy', ...about(kindOf(args), 'busy'));
    active++;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      const asset = resolve(args), binding = JSON.stringify(asset), file = asset.payload.filePath;
      if (typeof file !== 'string' || !path.isAbsolute(file) || /^[\\/]{2}/.test(file)) return fail('invalid_image', 'The registered image is not a plain local absolute path; URLs and UNC network paths are not read.', 'library.image_path_not_local');
      // Inspect the registered spelling before any filesystem access or
      // lexical folding: symlink/../file can name a DIFFERENT file than resolve().
      const root = path.parse(file).root;
      const components = file.slice(root.length).split(path.sep);
      if (file.includes('\0') || components.some(part => !part || part === '.' || part === '..') || (path.sep === '\\' && (file.includes('/') || !/^[a-zA-Z]:\\$/.test(root)))) return fail('invalid_image', 'The registered image path has non-canonical components; authorized paths are not collapsed or rewritten.', 'library.image_path_noncanonical');
      const absolute = file;
      // Reject filesystem aliases in any component, not only a leaf symlink.
      // The original authority remains unchanged for all checks and reads.
      if (await fs.realpath(absolute) !== absolute) return fail('invalid_image', ...about(kindOf(args), 'symlink'));
      const before = await fs.lstat(absolute);
      if (!before.isFile() || before.isSymbolicLink()) return fail('invalid_image', ...about(kindOf(args), 'not_file'));
      if (!before.size || before.size > HISTORY_IMAGE_LIMITS.bytes) return fail('image_too_large', ...about(kindOf(args), 'size'));
      handle = await openNoFollow(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = await handle.stat();
      if (!opened.isFile() || signature(opened) !== signature(before)) return fail('image_changed', ...about(kindOf(args), 'changed_open'));
      // One extra byte detects growth without unbounded readFile allocation.
      const buffer = Buffer.alloc(opened.size + 1); let used = 0;
      while (used < buffer.length) {
        const next = await handle.read(buffer, used, buffer.length - used, used);
        if (!next.bytesRead) break;
        used += next.bytesRead;
      }
      if (used !== opened.size) return fail('image_changed', ...about(kindOf(args), 'changed_read'));
      const bytes = buffer.subarray(0, used);
      const unchanged = async () => {
        if (await fs.realpath(absolute) !== absolute) return fail('image_changed', ...about(kindOf(args), 'path_changed'));
        const [now, current] = await Promise.all([handle!.stat(), fs.lstat(absolute)]);
        if (!current.isFile() || current.isSymbolicLink() || signature(now) !== signature(opened) || signature(current) !== signature(opened)) return fail('image_changed', ...about(kindOf(args), 'changed_read'));
        if (JSON.stringify(resolve(args)) !== binding) return fail('library_conflict', ...about(kindOf(args), 'binding_changed'));
      };
      await unchanged();
      const sourceSha256 = hash(bytes), expected = asset.payload.sha256;
      if (expected !== undefined && expected !== null && (!/^[a-f0-9]{64}$/.test(expected) || expected !== sourceSha256)) return fail('image_changed', ...about(kindOf(args), 'digest'));
      if (Number.isSafeInteger(asset.payload.byteLength) && asset.payload.byteLength !== bytes.length) return fail('image_changed', ...about(kindOf(args), 'byte_length'));
      const mimeType = imageMime(bytes);
      if (!mimeType) return fail('unsupported_image', 'Native images support only static PNG, JPEG, WebP and GIF; SVG and other files are not supported.', 'library.image_unsupported');
      if (asset.payload.mimeType && asset.payload.mimeType !== mimeType) return fail('invalid_image', 'The registered MIME type does not match the file signature.', 'library.image_mime_mismatch');
      if (mimeType === 'image/png' && animatedPng(bytes, kindOf(args))) return fail('unsupported_image', 'Animated originals are not supported; the first frame is not passed off as the original.', 'library.image_animated');
      const decoder = () => sharp(bytes, { limitInputPixels: HISTORY_IMAGE_LIMITS.pixels, failOn: 'warning' }).timeout({ seconds: HISTORY_IMAGE_LIMITS.decodeSeconds });
      const metadata = await decoder().metadata();
      const formats: Record<string, string> = { 'image/png':'png', 'image/jpeg':'jpeg', 'image/webp':'webp', 'image/gif':'gif' };
      if (metadata.format !== formats[mimeType] || !metadata.width || !metadata.height) return fail('invalid_image', 'The image signature, format and size do not agree.', 'library.image_format_mismatch');
      if ((metadata.pages ?? 1) !== 1 || (metadata.pageHeight && metadata.pageHeight !== metadata.height)) return fail('unsupported_image', 'Animated originals are not supported; the first frame is not passed off as the original.', 'library.image_animated');
      if (metadata.width * metadata.height > HISTORY_IMAGE_LIMITS.pixels) return fail('image_too_large', ...about(kindOf(args), 'pixels'));
      // Decode and bound even originals; returned original bytes are never this
      // derivative. Passing raw buffers prevents the decoder reopening paths.
      const original = args.variant === 'original';
      const pipeline = decoder().rotate().resize({ width:384, height:384, fit:'inside', withoutEnlargement:true });
      const decoded = await (original ? pipeline.raw() : pipeline.webp({ quality:76 })).toBuffer({ resolveWithObject:true });
      await unchanged();
      const output = original ? bytes : decoded.data;
      if (output.length > HISTORY_IMAGE_LIMITS.bytes) return fail('image_too_large', 'The image attachment exceeds 20 MiB.', 'library.image_attachment_size');
      // A study original may carry EXIF orientation (the thumbnail above is auto-rotated, source sizes are as stored);
      // it is reported so a recipe can refuse a rotated source. History replies stay exactly as before.
      const orientation = args.kind === 'study' && Number.isSafeInteger(metadata.orientation) ? { sourceOrientation: metadata.orientation } : {};
      return {
        kind:args.kind, id:args.id, revision:args.revision, assetId:asset.id, role:'original', variant:original ? 'original' : 'thumbnail',
        mimeType:original ? mimeType : 'image/webp', width:original ? metadata.width : decoded.info.width, height:original ? metadata.height : decoded.info.height,
        sourceMimeType:mimeType, sourceWidth:metadata.width, sourceHeight:metadata.height, sourceByteLength:bytes.length,
        byteLength:output.length, sha256:hash(output), sourceSha256, contentBinding:expected ? 'recorded-sha256' : 'read-time-sha256',
        ...orientation, data:output.toString('base64'),
      };
    } catch (error: any) {
      // invalid_argument (unknown kind, or an id the repository refuses) passes through for non-history reads only, so
      // every history failure keeps exactly its earlier code.
      if (['library_not_found','library_conflict','image_unavailable','image_changed','invalid_image','image_too_large','unsupported_image'].includes(error?.code) || (error?.code === 'invalid_argument' && args.kind !== 'history')) throw error;
      if (['ENOENT','ENOTDIR','EACCES','EPERM'].includes(error?.code)) return fail('image_unavailable', ...about(kindOf(args), 'missing'));
      if (error?.code === 'ELOOP') return fail('invalid_image', 'The registered original contains a symbolic link; reading was refused.', 'library.image_symlink_refused');
      return fail('invalid_image', ...about(kindOf(args), 'decode'));
    } finally { try { await handle?.close(); } finally { active--; } }
  };
}
