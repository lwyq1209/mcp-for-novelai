/**
 * asset_library action export: copy one saved history original into the project's
 * novelai/library-exports folder, so a workflow that needs a local file (for example
 * outpainting in another tool) gets one even when the output folder lies outside the
 * project (read_queue then reports file:null).
 *
 * One host call and nothing else: asset_library {action:image, kind:history,
 * variant:original} for the exact history id, revision and registered assetId,
 * validated by the same response checks as set_cover_from_history (identity echo,
 * sha256 of the bytes, magic bytes, 20 MiB bound, original == source). The bytes are
 * written unchanged. The file name follows the history-cover naming rule (plain ids
 * kept, any other id hashed); an existing name is never overwritten: the next free
 * name gets a numeric suffix. The export folder must be a real directory (never a
 * symlink), and the file is created with O_CREAT|O_EXCL, so a symlink or any entry
 * already at that name is never followed or replaced.
 */
import { constants } from 'node:fs';
import { lstat, mkdir, realpath, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BridgeError } from './bridge-client.mjs';
import { normalizeAssetLibraryRequest } from './asset-library-categories.mjs';
import { assetLibraryHostRequest, assetLibraryResponse } from './asset-library-response.mjs';
import { historyCoverFileName } from './history-cover.mjs';
import { createExclusive as createFile } from './platform-fs.mjs';

export const HISTORY_EXPORT_KEYS = Object.freeze(['action', 'kind', 'id', 'revision', 'assetId']);
/** How many numbered names are tried after the plain one before the export is refused. */
export const HISTORY_EXPORT_NAME_ATTEMPTS = 100;
const invalid = message => { throw new BridgeError('invalid_arguments', message); };

/** The export request rules, before any host call or file access. */
export function validateHistoryExport(args) {
  if (!args || typeof args !== 'object' || Object.keys(args).some(key => !HISTORY_EXPORT_KEYS.includes(key)) || args.action !== 'export')
    invalid('export accepts only kind:"history", id, revision and assetId (the exact identity from asset_library); no variant, paths, file names or URLs.');
  if (args.kind !== 'history') invalid('export takes kind:"history": only history originals can be exported.');
  if (typeof args.id !== 'string' || !args.id.length || args.id.length > 512 || !/\S/.test(args.id)) invalid('id must be the exact history id from asset_library.');
  if (!Number.isSafeInteger(args.revision) || args.revision < 1) invalid('revision must be the exact history revision from asset_library.');
  if (typeof args.assetId !== 'string' || !args.assetId.length || args.assetId.length > 512 || !/\S/.test(args.assetId)) invalid('assetId must be the registered original assetId (asset_library image.preview.assetId).');
}

/** `name-2.ext`, `name-3.ext` … for the attempt after the plain name. */
const numbered = (fileName, attempt) => attempt === 0 ? fileName : fileName.replace(/(\.[a-z]+)$/, `-${attempt + 1}$1`);

const NOT_A_DIRECTORY = 'novelai/library-exports must be a real directory, not a symlink; nothing was exported.';
const UNAVAILABLE = 'novelai/library-exports under the project root could not be written; nothing was exported. Check that the folder exists or can be created and is writable.';
/** Missing is fine (it is created); a symlink or anything but a directory is refused before the host is asked. */
export async function preflightDirectory(directory) {
  let info;
  try { info = await lstat(directory); }
  catch (error) { if (error?.code === 'ENOENT') return; throw new BridgeError('file_unavailable', UNAVAILABLE); }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new BridgeError('invalid_input', NOT_A_DIRECTORY);
}

/** Creates `bytes` under a new name in `directory` (never replacing anything) and returns its absolute path. */
export async function writeExclusive(directory, fileName, bytes) {
  try { return await createExclusive(directory, fileName, bytes); }
  catch (error) { if (error instanceof BridgeError) throw error; throw new BridgeError('file_unavailable', UNAVAILABLE); }
}
async function createExclusive(directory, fileName, bytes) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new BridgeError('invalid_input', NOT_A_DIRECTORY);
  const base = await realpath(directory);
  for (let attempt = 0; attempt < HISTORY_EXPORT_NAME_ATTEMPTS; attempt++) {
    const target = resolve(base, numbered(fileName, attempt));
    let handle;
    // O_EXCL: an existing file, directory or symlink (also a dangling one) at this name refuses the create (on win32,
    // where O_EXCL alone follows a dangling symlink, platform-fs createExclusive checks the name before and after).
    try { handle = await createFile(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
    catch (error) { if (error?.code === 'EEXIST') continue; throw error; }
    try { await handle.writeFile(bytes); await handle.sync(); }
    catch (error) { await handle.close().catch(() => {}); await unlink(target).catch(() => {}); throw error; }
    await handle.close();
    return target;
  }
  throw new BridgeError('export_name_unavailable', `Every export name for this image (${fileName} and ${HISTORY_EXPORT_NAME_ATTEMPTS - 1} numbered variants) already exists in novelai/library-exports; nothing was overwritten. Remove or rename some of them first.`);
}

/**
 * Exports one history revision's registered original. Returns the absolute file path (the tool turns it
 * project-relative) and the facts of the exported bytes.
 */
export async function exportHistoryOriginal(args, { bridge, signal, exportsDirectory } = {}) {
  validateHistoryExport(args);
  if (typeof exportsDirectory !== 'string' || !exportsDirectory) throw new TypeError('An export directory is required.');
  await preflightDirectory(exportsDirectory);
  const request = normalizeAssetLibraryRequest({ action: 'image', kind: 'history', id: args.id, revision: args.revision, assetId: args.assetId, variant: 'original' });
  const reply = await bridge.call('asset_library', assetLibraryHostRequest(request), signal);
  let image;
  try { image = assetLibraryResponse(request, reply); }
  catch { throw new BridgeError('invalid_response', 'The history original did not match the requested identity or is not a valid bounded image; nothing was exported.', { kind: 'history', id: args.id, revision: args.revision, assetId: args.assetId, exported: false }); }
  signal?.throwIfAborted?.();
  const file = await writeExclusive(exportsDirectory, historyCoverFileName(args.id, args.revision, image.mimeType), Buffer.from(image.data, 'base64'));
  return { kind: 'history', id: args.id, revision: args.revision, assetId: args.assetId, file, fileName: file.split(/[\\/]/).pop(),
    mimeType: image.mimeType, width: image.width, height: image.height, byteLength: image.byteLength, sha256: image.sha256, exported: true, generationSubmitted: false };
}
