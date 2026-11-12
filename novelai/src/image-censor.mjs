/**
 * asset_library action censor: cover parts of one saved image (a history original or an imported image) with a
 * mosaic, a blur, black or white and write the result as a JPEG without any metadata into the project's
 * novelai/library-exports folder — the agent's way to the window's "Censor and export" editor.
 *
 * - The image is named by its library identity: {kind:"history", id, revision, assetId} or {kind:"study", id,
 *   revision}. Its size comes from the same strict thumbnail read recipes use (recipe-sources readSourceMetadata:
 *   GIF and rotated or mirrored originals are refused).
 * - `mask` is the mask grammar of prepare_recipe inpaint (recipe-masks.mjs: shapes and alpha layers, growPx,
 *   invert), rasterized here at the image's size. Latent cells do not matter for censoring: any selected pixel
 *   counts, and a mask that selects none is refused (mask_empty).
 * - The host (censor_image, client/electron/censor-image.ts) reads the registered original itself, renders and
 *   returns either a preview (WebP, long edge ≤ 1024) or the JPEG; it writes nothing. This module writes the JPEG
 *   under a new name (never replacing a file), exactly like the export action.
 * - preview:true writes nothing and returns the censored picture to look at.
 * Host access: asset_library (image reads) and censor_image. A client without censor_image answers host_outdated.
 */
import { createHash } from 'node:crypto';
import { BridgeError } from './bridge-client.mjs';
import { historyCoverFileName } from './history-cover.mjs';
import { preflightDirectory, writeExclusive } from './history-export.mjs';
import { composeMask, decodePngAlpha, encodeMaskPng } from './recipe-masks.mjs';
import { prepareMaskSpec, readAlphaImages, readSourceMetadata } from './recipe-sources.mjs';

export const CENSOR_HOST_METHODS = Object.freeze({ image: 'asset_library', render: 'censor_image' });
export const CENSOR_KEYS = Object.freeze(['action', 'kind', 'id', 'revision', 'assetId', 'mask', 'style', 'sizePx', 'featherPx', 'quality', 'preview']);
export const CENSOR_STYLES = Object.freeze(['mosaic', 'blur', 'black', 'white']);
/** The ranges of the window's editor (client/src/censor/model.ts CENSOR_RANGES) and of the host's JPEG encoder. */
export const CENSOR_LIMITS = Object.freeze({ sizePx: Object.freeze([2, 96]), featherPx: Object.freeze([0, 48]), quality: Object.freeze([60, 100]), defaultQuality: 95, previewBytes: 1024 * 1024, jpegBytes: 48 * 1024 * 1024 });
export const CENSOR_HOST_OUTDATED_MESSAGE = 'The NovelAI client is older than this MCP server and cannot censor images. Fully rebuild and restart the client, then try again. Nothing was written.';

const invalid = (message, details) => { throw new BridgeError('invalid_arguments', message, details); };
const integer = (value, [min, max], name) => { if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${name} must be an integer from ${min} to ${max}.`); return value; };
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && /\S/.test(value);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** The request rules, before any host call or file access. Returns the normalized request. */
export function validateCensor(args) {
  if (!args || typeof args !== 'object' || args.action !== 'censor') invalid('censor takes {action:"censor", kind, id, revision, assetId?, mask, style?, sizePx?, featherPx?, quality?, preview?}.');
  const extra = Object.keys(args).filter(key => !CENSOR_KEYS.includes(key));
  if (extra.length) invalid(`censor does not accept: ${extra.join(', ')}. It takes kind, id, revision, assetId (history), mask, style, sizePx, featherPx, quality and preview; no paths, file names or URLs.`);
  if (args.kind !== 'history' && args.kind !== 'study') invalid('censor takes kind:"history" (a saved image) or kind:"study" (an imported image).');
  if (!identifier(args.id)) invalid('id must be the exact id from asset_library (or material_studies for an imported image).');
  if (!Number.isSafeInteger(args.revision) || args.revision < 1) invalid('revision must be the exact saved revision.');
  if (args.kind === 'history' && !identifier(args.assetId)) invalid('assetId must be the registered original assetId (asset_library image.preview.assetId).');
  if (args.kind === 'study' && args.assetId !== undefined) invalid('An imported image (kind:"study") has one original; leave assetId out.');
  if (args.mask === undefined) invalid('censor needs mask: what to cover, written like the inpaint mask of prepare_recipe ({units, layers}).');
  const style = args.style ?? 'mosaic';
  if (!CENSOR_STYLES.includes(style)) invalid(`style must be one of ${CENSOR_STYLES.join(', ')}.`);
  if (args.sizePx !== undefined) {
    if (style === 'black' || style === 'white') invalid('sizePx is the mosaic cell or the blur radius; leave it out with black or white.');
    integer(args.sizePx, CENSOR_LIMITS.sizePx, 'sizePx');
  }
  if (args.preview !== undefined && typeof args.preview !== 'boolean') invalid('preview must be true or false.');
  return {
    identity: args.kind === 'history' ? { kind: 'history', historyId: args.id, historyRevision: args.revision, assetId: args.assetId } : { kind: 'study', studyId: args.id, studyRevision: args.revision },
    target: args.kind === 'history' ? { kind: 'history', id: args.id, revision: args.revision, assetId: args.assetId } : { kind: 'study', id: args.id, revision: args.revision },
    style, sizePx: args.sizePx, featherPx: args.featherPx === undefined ? 0 : integer(args.featherPx, CENSOR_LIMITS.featherPx, 'featherPx'),
    quality: args.quality === undefined ? CENSOR_LIMITS.defaultQuality : integer(args.quality, CENSOR_LIMITS.quality, 'quality'), preview: args.preview === true,
  };
}

const MAGIC = { 'image/jpeg': bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff, 'image/webp': bytes => bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' };
/** The host's rendered image, checked against what it says about it; anything else is an invalid response. */
function renderedImage(reply, { preview, width, height }) {
  const fail = () => { throw new BridgeError('invalid_response', `The client did not return a valid censored ${preview ? 'preview' : 'JPEG'}; nothing was written.`, { exported: false }); };
  const image = reply?.image, type = preview ? 'image/webp' : 'image/jpeg';
  if (!image || typeof image !== 'object' || image.mimeType !== type || typeof image.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data) || image.data.length % 4 !== 0) return fail();
  const bytes = Buffer.from(image.data, 'base64');
  if (!bytes.length || bytes.length > (preview ? CENSOR_LIMITS.previewBytes : CENSOR_LIMITS.jpegBytes) || image.byteLength !== bytes.length || image.sha256 !== sha256(bytes) || !MAGIC[type](bytes)) return fail();
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1) return fail();
  // The saved JPEG has the image's own size; a preview is the same picture, smaller.
  if (preview ? image.width > width || image.height > height : image.width !== width || image.height !== height) return fail();
  if (reply.preview !== preview || reply.saved !== false) return fail();
  return { bytes, mimeType: type, width: image.width, height: image.height, byteLength: bytes.length, sha256: image.sha256, data: image.data };
}

/** censored-history-<id>-r<revision>.jpg (the export action's naming rule) or censored-study-<id>-r<revision>.jpg. */
const exportName = target => `censored-${target.kind === 'history' ? historyCoverFileName(target.id, target.revision, 'image/jpeg') : `study-${target.id}-r${target.revision}.jpg`}`;

/**
 * Censors one image. Returns the facts of the result; with preview the picture's base64 under previewImage.data (the
 * tool attaches it as an image and drops the bytes from the JSON), otherwise the absolute path of the written JPEG
 * under file (the tool turns it project-relative).
 */
export async function censorImage(args, { bridge, signal, exportsDirectory } = {}) {
  const request = validateCensor(args);
  const { spec, alphaRefs } = prepareMaskSpec(args.mask);
  if (!request.preview) {
    if (typeof exportsDirectory !== 'string' || !exportsDirectory) throw new TypeError('An export directory is required.');
    await preflightDirectory(exportsDirectory);
  }
  const source = await readSourceMetadata(bridge, request.identity, { signal, path: 'source' });
  const { width, height } = source;
  const alphas = (await readAlphaImages(bridge, alphaRefs, { signal })).map((bytes, index) => decodePngAlpha(bytes, { path: `mask.layers[${alphaRefs[index].layer}].alpha`, target: { width, height } }));
  const composed = composeMask(spec, { width, height, alphas });
  let selected = 0;
  for (let index = 0; index < composed.selection.length; index++) selected += composed.selection[index];
  if (!selected) throw new BridgeError('mask_empty', 'The mask selects no pixel of the image, so nothing would be covered. Check the coordinates, units and subtract or invert layers. Nothing was written.', { reason: 'mask_empty', width, height, exported: false });
  // The 8×8 latent-cell warnings of an inpaint mask say nothing about censoring.
  const warnings = composed.warnings.filter(warning => !['layer_below_cell_resolution', 'layer_no_effect', 'mask_covers_all'].includes(warning.code));
  signal?.throwIfAborted?.();
  let reply;
  try {
    reply = await bridge.call(CENSOR_HOST_METHODS.render, { ...request.target, sourceSha256: source.sha256, mask: encodeMaskPng(composed.selection, width, height).toString('base64'),
      style: request.style, ...(request.sizePx === undefined ? {} : { sizePx: request.sizePx }), featherPx: request.featherPx, quality: request.quality, preview: request.preview }, signal);
  } catch (error) {
    if (error instanceof BridgeError && error.code === 'unsupported_method') throw new BridgeError('host_outdated', CENSOR_HOST_OUTDATED_MESSAGE, { hostCode: error.code, exported: false });
    throw error;
  }
  const image = renderedImage(reply, { preview: request.preview, width, height });
  const facts = {
    ...request.target, style: request.style, sizePx: Number.isSafeInteger(reply.sizePx) ? reply.sizePx : null, featherPx: request.featherPx,
    width, height, covered: { pixels: selected, percent: Math.round(selected / (width * height) * 10000) / 100, bbox: bboxOf(composed.selection, width, height) },
    mask: { spec: composed.spec, layers: composed.layers.map(({ op, kind, pixels }) => ({ op, kind, pixels })) }, warnings, generationSubmitted: false,
  };
  if (request.preview) return { ...facts, preview: true, exported: false, previewImage: { mimeType: image.mimeType, width: image.width, height: image.height, byteLength: image.byteLength, data: image.data } };
  signal?.throwIfAborted?.();
  const file = await writeExclusive(exportsDirectory, exportName(request.target), image.bytes);
  return { ...facts, preview: false, exported: true, file, fileName: file.split(/[\\/]/).pop(), mimeType: image.mimeType, quality: request.quality, byteLength: image.byteLength, sha256: image.sha256, metadata: 'none' };
}

function bboxOf(selection, width, height) {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0, at = 0; y < height; y++) for (let x = 0; x < width; x++, at++) if (selection[at]) { if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y; }
  return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}
