/**
 * material_library action set_cover_from_history: use one saved history
 * original as a tag's local cover without copying it into library-inbox.
 *
 * Composes two existing host methods and nothing else:
 * 1. asset_library {action:image, kind:history, variant:original} for the exact
 *    history id, revision and registered assetId — validated by the same
 *    dependency-free response checks as the workspace server (sha256, magic bytes,
 *    dimensions, 20 MiB bound, original == source);
 * 2. material_samples {action:set_local_cover} with those bytes, so the host
 *    still enforces the tag revision and coverRevision CAS, decodes the image
 *    once and stores a normalized, metadata-free WebP (verification: local).
 * Nothing is retried. An unknown save outcome requires reading the entry's
 * coverRevision before any further cover change.
 */
import { createHash } from 'node:crypto';
import { BridgeError } from './bridge-client.mjs';
import { validateMaterialRequest } from '../contracts/validate.mjs';
import { normalizeAssetLibraryRequest } from './asset-library-categories.mjs';
import { assetLibraryHostRequest, assetLibraryResponse } from './asset-library-response.mjs';

export const HISTORY_COVER_HOST_METHODS = Object.freeze({ image: 'asset_library', cover: 'material_samples' });
export const HISTORY_COVER_KEYS = Object.freeze(['action', 'entryId', 'revision', 'expectedCoverRevision', 'historyId', 'historyRevision', 'assetId']);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
// Explicit host refusals of set_local_cover: the old cover is kept and nothing changed.
const COVER_REJECTED = new Set(['invalid_argument', 'invalid_arguments', 'material_conflict', 'material_not_found', 'cover_conflict', 'cover_invalid_image', 'cover_storage_full', 'cover_stale']);

const invalid = message => { throw new BridgeError('invalid_arguments', message); };
const identity = (value, label) => { if (typeof value !== 'string' || !value.length || value.length > 512 || !/\S/.test(value)) invalid(`${label} must be the exact identity from asset_library.`); return value; };
const integer = (value, min, label) => { if (!Number.isSafeInteger(value) || value < min) invalid(`${label} must be an integer of at least ${min}.`); return value; };

/** Stable, host-valid provenance file name; history ids that are not plain names are hashed. */
export function historyCoverFileName(historyId, historyRevision, mimeType) {
  const name = /^[A-Za-z0-9._-]{1,120}$/.test(historyId) && !/^\.+$/.test(historyId) ? historyId : `h-${createHash('sha256').update(historyId).digest('hex').slice(0, 24)}`;
  return `history-${name}-r${historyRevision}.${EXTENSIONS[mimeType]}`;
}

/**
 * Allowlisted cover metadata only: nothing else the host puts in its cover object (storage paths,
 * messages, tag copies or future fields) is passed through.
 */
const HEX64 = /^[a-f0-9]{64}$/;
const WORD = /^[a-z][a-z_]{0,31}$/;
export const COVER_RESULT_FIELDS = Object.freeze({
  sha256: value => typeof value === 'string' && HEX64.test(value), sourceSha256: value => typeof value === 'string' && HEX64.test(value),
  mimeType: value => typeof value === 'string' && /^image\/(?:png|jpeg|webp|gif)$/.test(value),
  width: value => Number.isSafeInteger(value) && value > 0, height: value => Number.isSafeInteger(value) && value > 0, byteLength: value => Number.isSafeInteger(value) && value > 0,
  source: value => typeof value === 'string' && WORD.test(value), verification: value => typeof value === 'string' && WORD.test(value),
  savedAt: value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(value),
});
export function coverSummary(cover) {
  if (!cover || typeof cover !== 'object' || Array.isArray(cover)) return null;
  return Object.fromEntries(Object.entries(COVER_RESULT_FIELDS).filter(([key, valid]) => valid(cover[key])).map(([key]) => [key, cover[key]]));
}

export async function setCoverFromHistory(args, { bridge, signal } = {}) {
  if (!args || typeof args !== 'object' || Object.keys(args).some(key => !HISTORY_COVER_KEYS.includes(key)) || args.action !== 'set_cover_from_history')
    invalid('set_cover_from_history accepts only entryId, revision, expectedCoverRevision, historyId, historyRevision and assetId; no data, files, paths or URLs.');
  if (typeof args.entryId !== 'string' || !UUID.test(args.entryId)) invalid('entryId must be the tag entry UUID from list/read.');
  integer(args.revision, 1, 'revision'); integer(args.expectedCoverRevision, 0, 'expectedCoverRevision');
  identity(args.historyId, 'historyId'); integer(args.historyRevision, 1, 'historyRevision'); identity(args.assetId, 'assetId');
  const cover = { entryId: args.entryId, revision: args.revision, expectedCoverRevision: args.expectedCoverRevision };
  const source = { historyId: args.historyId, historyRevision: args.historyRevision, assetId: args.assetId };

  // 1. The exact history original, strictly validated. Nothing has changed yet.
  const request = normalizeAssetLibraryRequest({ action: 'image', kind: 'history', id: args.historyId, revision: args.historyRevision, assetId: args.assetId, variant: 'original' });
  const reply = await bridge.call(HISTORY_COVER_HOST_METHODS.image, assetLibraryHostRequest(request), signal);
  let image;
  try { image = assetLibraryResponse(request, reply); }
  catch { throw new BridgeError('invalid_response', 'The history original did not match the requested identity or is not a valid bounded image; no cover was changed.', { ...cover, ...source, coverChanged: false }); }

  // 2. One cover save through the host's own local-cover path (CAS, decode, metadata stripping).
  const fileName = historyCoverFileName(args.historyId, args.historyRevision, image.mimeType);
  const payload = validateMaterialRequest('material_samples', { action: 'set_local_cover', ...cover, fileName, data: image.data });
  signal?.throwIfAborted?.();
  let saved;
  try { saved = await bridge.call(HISTORY_COVER_HOST_METHODS.cover, payload, signal); }
  catch (error) {
    if (error instanceof BridgeError && COVER_REJECTED.has(error.code)) throw new BridgeError(error.code, `${error.message} The old cover is kept; read the entry (revision, coverRevision) before choosing again.`, { ...cover, ...source, coverChanged: false });
    throw new BridgeError('cover_save_unknown', 'The cover save outcome is unknown. Do not resend; read the entry and compare its coverRevision with expectedCoverRevision before any further cover change.', { ...cover, ...source, coverChanged: 'unknown', hostCode: error instanceof BridgeError ? error.code : null });
  }
  return { entryId: args.entryId, coverRevision: Number.isSafeInteger(saved?.coverRevision) ? saved.coverRevision : null, cover: coverSummary(saved?.cover),
    source: { kind: 'history', ...source, mimeType: image.mimeType, width: image.width, height: image.height, byteLength: image.byteLength, sha256: image.sha256 },
    fileName, generationSubmitted: false,
    instruction: 'The host stored a normalized local cover (verification: local). View it with material_library cover {entryId}.' };
}
