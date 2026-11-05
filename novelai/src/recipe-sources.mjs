/**
 * Source images and inpaint masks of image recipes (prepare_recipe modes i2i, inpaint, enhance, upscale,
 * director). design.md §4.1 as replaced by design-addendum §1 and §2.5, extended by issue #2:
 * - a source is referenced by history identity {kind:"history", historyId, historyRevision, assetId} or by
 *   study identity {kind:"study", studyId, studyRevision} (an image imported with material_studies; a study has
 *   one registered original, so no assetId). This module reads its METADATA through asset_library {action:image,
 *   variant:thumbnail} (one ≤384 px thumbnail, strictly validated by assetLibraryResponse) and never the original:
 *   the host rereads the original by reference and binds it to the sha256/byteLength recorded here. A study source
 *   with EXIF orientation other than 1 is refused (source_orientation_unsupported); a client too old to read study
 *   images answers host_outdated;
 * - an inpaint mask is built locally by src/recipe-masks.mjs. Alpha layers read their history ORIGINAL (PNG only)
 *   through the same asset_library method. Coordinates are rounded first (fraction to 4 decimals, px to whole
 *   pixels) and the rounded spec is what gets rasterized and recorded;
 * - the mask spec travels as the mask asset's provenance (≤ 32 KiB, outside reviewInput, so never part of
 *   inputHash). A spec too large for that keeps only {specSha256, specJsonBytes, layers}; prepare_recipe still
 *   returns the full spec in its own readback.
 * Host access: RECIPE_SOURCE_HOST_METHODS.image only. Errors are BridgeError (invalid_arguments with
 * details {reason, path}, invalid_response, host_outdated, or the host's own code for an unreadable image).
 */
import { createHash } from 'node:crypto';
import { BridgeError } from './bridge-client.mjs';
import { normalizeAssetLibraryRequest } from './asset-library-categories.mjs';
import { assetLibraryHostRequest, assetLibraryResponse } from './asset-library-response.mjs';
import { MASK_LIMITS, validateMaskSpec } from './recipe-masks.mjs';

export const RECIPE_SOURCE_HOST_METHODS = Object.freeze({ image: 'asset_library' });
/** Recipe sources the host recipe store accepts (queue-recipe-service IMAGE_TYPES); GIF is refused. */
export const SOURCE_IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
/** Host asset provenance limit (queue-recipe-service RECIPE_ASSET_LIMITS.provenanceBytes). */
export const MASK_PROVENANCE_BYTES = 32 * 1024;
const SOURCE_KEYS = Object.freeze({ history: ['kind', 'historyId', 'historyRevision', 'assetId'], study: ['kind', 'studyId', 'studyRevision'] });
const STUDY_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
/** A client from before issue #2 refuses the study image read itself (its contract has no study branch). */
export const STUDY_SOURCE_HOST_OUTDATED_MESSAGE = 'The NovelAI client is older than this MCP server and cannot read imported-image (study) sources. Fully rebuild and restart the client, then try again. Nothing was saved; history sources keep working.';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const refuse = (reason, path, message, extra = {}) => { throw new BridgeError('invalid_arguments', message, { reason, path, ...extra }); };
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && /\S/.test(value);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/**
 * Exactly one of two shapes: {kind:"history", historyId, historyRevision, assetId} (the identity asset_library lists
 * and set_cover_from_history uses) or {kind:"study", studyId, studyRevision} (material_studies import id/revision).
 * A field of the other shape is refused with its own path.
 */
export function sourceIdentity(value, path = 'source') {
  if (!record(value)) refuse('source_invalid', path, `${path} must be {kind:"history", historyId, historyRevision, assetId} from asset_library or {kind:"study", studyId, studyRevision} from material_studies.`);
  if (value.kind !== 'history' && value.kind !== 'study') refuse('source_invalid', `${path}.kind`, `${path}.kind must be "history" or "study".`);
  const extra = Object.keys(value).filter(key => !SOURCE_KEYS[value.kind].includes(key));
  if (extra.length) refuse('source_invalid', `${path}.${extra[0]}`, `${path} with kind "${value.kind}" does not accept: ${extra.join(', ')}. Use {kind:"history", historyId, historyRevision, assetId} or {kind:"study", studyId, studyRevision}; no bytes, paths, URLs or canvas assets.`);
  if (value.kind === 'study') {
    if (typeof value.studyId !== 'string' || !STUDY_ID.test(value.studyId)) refuse('source_invalid', `${path}.studyId`, `${path}.studyId must be the study id (a lowercase UUID) that material_studies import returned.`);
    if (!Number.isSafeInteger(value.studyRevision) || value.studyRevision < 1) refuse('source_invalid', `${path}.studyRevision`, `${path}.studyRevision must be an existing study revision (an integer ≥ 1).`);
    return { kind: 'study', studyId: value.studyId, studyRevision: value.studyRevision };
  }
  if (!identifier(value.historyId)) refuse('source_invalid', `${path}.historyId`, `${path}.historyId must be the exact history id from asset_library.`);
  if (!Number.isSafeInteger(value.historyRevision) || value.historyRevision < 1) refuse('source_invalid', `${path}.historyRevision`, `${path}.historyRevision must be the exact history revision (an integer ≥ 1).`);
  if (!identifier(value.assetId)) refuse('source_invalid', `${path}.assetId`, `${path}.assetId must be the registered original assetId (asset_library image.preview.assetId).`);
  return { kind: 'history', historyId: value.historyId, historyRevision: value.historyRevision, assetId: value.assetId };
}

/** The host's history-image reader is busy (image_busy, or any other *_busy code): a temporary refusal, not an identity fact. */
export const historyImageBusy = code => typeof code === 'string' && /_busy$/.test(code);
/** The read did not complete (client unreachable, timed out, cancelled or garbled reply): says nothing about the identity. */
const TRANSPORT_CODES = new Set(['unavailable', 'invalid_connection', 'timeout', 'aborted', 'invalid_response']);
const transportFailure = code => TRANSPORT_CODES.has(code) || /^http_\d+$/.test(code);

/** The library reader refused the image content itself (animated, undecodable, over its pixel or byte bound). */
const CONTENT_CODES = new Set(['unsupported_image', 'invalid_image', 'image_too_large']);
/** The study's stored original is missing or no longer matches its record (host storage, not the identity). */
const STORAGE_CODES = new Set(['image_unavailable', 'image_changed']);

/** Next-step text for a failed history- or study-image read, by host code; every case says that nothing was saved. */
export function historyImageReadMessage(path, error, kind = 'history') {
  const noun = kind === 'study' ? 'study' : 'history', checker = kind === 'study' ? 'material_studies (list or import the file again)' : 'asset_library';
  if (historyImageBusy(error.code)) return `The ${noun} image at ${path} could not be read now: the client is busy with other ${kind === 'study' ? 'library' : 'history'}-image reads, most likely from another session (${error.message}). Nothing was saved and the identity was not checked. Retry the same call in a moment.`;
  if (transportFailure(error.code)) return `The ${noun} image at ${path} could not be read (${error.message}). Nothing was saved; the read did not complete, so this says nothing about the identity. Retry the same call once the client is reachable.`;
  // Importing the same bytes again only returns the same study (duplicate), so it cannot fix these two cases.
  if (kind === 'study' && CONTENT_CODES.has(error.code)) return `The study image at ${path} cannot be used as a recipe source (${error.message}). Nothing was saved. Importing the same file again returns the same study, so convert it locally first: a static (non-animated) PNG of at most 32 million pixels and 20 MiB. Import that copy and use its new id.`;
  if (kind === 'study' && STORAGE_CODES.has(error.code)) return `The stored original of the study at ${path} is missing or no longer matches its record (${error.message}). Nothing was saved. Importing the same file again returns this same study; tell the user. To continue now, import a re-saved copy (for example as PNG) and use its new id.`;
  return `The ${noun} image at ${path} could not be read (${error.message}). Nothing was saved; check the identity with ${checker}.`;
}

/** One strictly validated asset_library image read of a history or study original. Nothing is saved before or by it. */
async function readLibraryImage(bridge, identity, variant, path, signal) {
  const study = identity.kind === 'study';
  const request = normalizeAssetLibraryRequest(study
    ? { action: 'image', kind: 'study', id: identity.studyId, revision: identity.studyRevision, variant }
    : { action: 'image', kind: 'history', id: identity.historyId, revision: identity.historyRevision, assetId: identity.assetId, variant });
  const at = study ? { path, studyId: identity.studyId, studyRevision: identity.studyRevision, saved: false }
    : { path, historyId: identity.historyId, historyRevision: identity.historyRevision, assetId: identity.assetId, saved: false };
  let reply;
  try { reply = await bridge.call(RECIPE_SOURCE_HOST_METHODS.image, assetLibraryHostRequest(request), signal); }
  catch (error) {
    if (!(error instanceof BridgeError)) throw error;
    // This request already passed the current contract here, so a host refusing it as an argument error has an older
    // contract without the study branch: an outdated client, not a wrong identity.
    if (study && (error.code === 'invalid_argument' || error.code === 'invalid_arguments')) throw new BridgeError('host_outdated', STUDY_SOURCE_HOST_OUTDATED_MESSAGE, { ...at, hostCode: error.code });
    throw new BridgeError(error.code, historyImageReadMessage(path, error, identity.kind), { ...at, ...(record(error.details) ? { hostDetails: error.details } : {}) });
  }
  try { return assetLibraryResponse(request, reply); }
  catch { throw new BridgeError('invalid_response', `The asset library returned an image for ${path} that does not match the requested identity or is not a valid bounded image. Nothing was saved.`, at); }
}

/**
 * Source metadata from the thumbnail read: the registered original's mimeType, size, byteLength and sha256.
 * A GIF (or any type the recipe store refuses) and a rotated or mirrored original (EXIF orientation 2–8: the
 * reported size is the stored one, while decoders may turn the image) are rejected here, before anything is saved.
 */
export async function readSourceMetadata(bridge, identity, { signal, path = 'source' } = {}) {
  const image = await readLibraryImage(bridge, identity, 'thumbnail', path, signal);
  if (!SOURCE_IMAGE_TYPES.includes(image.sourceMimeType))
    refuse('source_unsupported_type', path, `The source is ${image.sourceMimeType}; recipe sources must be PNG, JPEG or WebP. Nothing was saved.`, { source: { mimeType: image.sourceMimeType } });
  if (image.sourceOrientation !== undefined && image.sourceOrientation !== 1)
    refuse('source_orientation_unsupported', path, `The source carries EXIF orientation ${image.sourceOrientation} (rotated or mirrored), so its stored size and its displayed size or direction can disagree. Apply the rotation locally (save an upright copy without the orientation tag, for example as PNG) and import that copy. Nothing was saved.`, { source: { orientation: image.sourceOrientation } });
  return { ...identity, mimeType: image.sourceMimeType, width: image.sourceWidth, height: image.sourceHeight, byteLength: image.sourceByteLength, sha256: image.sourceSha256 };
}

/** Raw PNG bytes of every alpha layer's history original, in alphaRefs order. */
export async function readAlphaImages(bridge, alphaRefs, { signal } = {}) {
  const images = [];
  for (const ref of alphaRefs) {
    const path = `mask.layers[${ref.layer}].alpha`;
    const image = await readLibraryImage(bridge, { kind: 'history', ...ref }, 'original', path, signal);
    if (image.mimeType !== 'image/png') refuse('alpha_not_png', path, `${path}: the alpha image is ${image.mimeType}; alpha layers need a PNG history original (for example a Director bg-removal or V5 transparent-background result).`);
    images.push(Buffer.from(image.data, 'base64'));
  }
  return images;
}

const roundCoordinate = units => units === 'fraction' ? value => Math.round(value * 1e4) / 1e4 || 0 : value => Math.round(value) || 0;
function roundShape(shape, round) {
  if (shape.type === 'rect') return { type: 'rect', x: round(shape.x), y: round(shape.y), width: round(shape.width), height: round(shape.height) };
  if (shape.type === 'ellipse') return { type: 'ellipse', cx: round(shape.cx), cy: round(shape.cy), rx: round(shape.rx), ry: round(shape.ry) };
  const points = shape.points.map(([x, y]) => [round(x), round(y)]);
  return shape.type === 'polygon' ? { type: 'polygon', points } : { type: 'stroke', points, widthPx: shape.widthPx };
}

/**
 * Structural validation (no host call), then coordinates rounded — fraction to 4 decimals, px to whole
 * pixels; widthPx, growPx and thresholds are kept — and validated again. Returns validateMaskSpec's result
 * for the rounded spec: {spec, alphaRefs, warnings}. A shape that rounding made invalid (for example a
 * 0.3 px wide rect) is refused with its path.
 */
export function prepareMaskSpec(raw) {
  const { spec } = validateMaskSpec(raw);
  const round = roundCoordinate(spec.units);
  const rounded = { units: spec.units, layers: spec.layers.map(layer => layer.shape ? { ...layer, shape: roundShape(layer.shape, round) } : layer) };
  try { return validateMaskSpec(rounded); }
  catch (error) {
    if (!(error instanceof BridgeError)) throw error;
    throw new BridgeError(error.code, `${error.message} (after rounding ${spec.units === 'fraction' ? 'fraction coordinates to 4 decimals' : 'px coordinates to whole pixels'})`, error.details);
  }
}

/**
 * Provenance stored with the mask asset: {spec, selectedCells, totalCells, bboxCells, layers} when it fits the
 * host's 32 KiB, otherwise only {specSha256, specJsonBytes, layers} (sha256 and UTF-8 size of JSON.stringify(spec)).
 */
export function maskProvenance(built) {
  const layers = built.readback.layers;
  const full = { spec: built.spec, selectedCells: built.selectedCells, totalCells: built.totalCells, bboxCells: built.bboxCells, layers };
  if (Buffer.byteLength(JSON.stringify(full)) <= MASK_PROVENANCE_BYTES) return full;
  const json = JSON.stringify(built.spec);
  return { specSha256: sha256(json), specJsonBytes: Buffer.byteLength(json), layers };
}

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const bbox = value => record(value) && ['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0) ? { x: value.x, y: value.y, width: value.width, height: value.height } : null;
const layerList = value => Array.isArray(value) && value.length <= MASK_LIMITS.layers && value.every(layer => record(layer) && ['add', 'subtract'].includes(layer.op) && typeof layer.kind === 'string' && count(layer.cells) !== null)
  ? value.map(({ op, kind, cells }) => ({ op, kind, cells })) : null;

/**
 * Mask readback (design-addendum §1.7) from the stored mask asset and its stored provenance; fields the
 * provenance does not hold are null. `built` (prepare and preview only) supplies the full spec and counts.
 */
export function maskReadback(asset, provenance, built = null) {
  const stored = record(provenance) ? provenance : {};
  const omitted = typeof stored.specSha256 === 'string' && /^[a-f0-9]{64}$/.test(stored.specSha256);
  return {
    sha256: asset?.sha256 ?? null, width: asset?.width ?? null, height: asset?.height ?? null,
    selectedCells: built ? built.selectedCells : count(stored.selectedCells), totalCells: built ? built.totalCells : count(stored.totalCells),
    bboxCells: built ? built.bboxCells : bbox(stored.bboxCells), layers: built ? built.readback.layers : layerList(stored.layers),
    spec: built ? built.spec : record(stored.spec) ? stored.spec : null,
    ...(omitted ? { specStored: false, specSha256: stored.specSha256, specJsonBytes: count(stored.specJsonBytes) } : {}),
  };
}
