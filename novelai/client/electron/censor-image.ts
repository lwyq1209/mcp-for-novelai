import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { hostError } from './host-error';
import { encodeCensoredJpeg } from './censored-export';
import { CENSOR_RANGES, CENSOR_STYLES, mosaicCells, standardBlurSize, standardMosaicSize, type CensorStyle } from '../src/censor/model';

/**
 * censor_image (bridge method of the asset_library tool's censor action): one registered history or study original
 * with a mask the MCP server rasterized, censored the way the window's editor does it (src/censor: the same mosaic
 * cells from the top left corner, the image on white), returned as a preview or as the JPEG to save. The original is
 * read through the library's strict original read and never written; nothing is saved here (the MCP server writes the
 * file into the project's export folder).
 */
export const CENSOR_IMAGE_LIMITS = Object.freeze({ maskBytes: 4 * 1024 * 1024, pixels: 32_000_000, previewEdge: 1024, previewBytes: 1024 * 1024, seconds: 30, minQuality: 60, maxQuality: 100 });
const refuse = (message: string): never => { throw hostError('invalid_argument', message); };
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export interface CensorRenderInput {
  /** The original's bytes (PNG, JPEG or WebP, upright). */
  source: Buffer;
  /** 8-bit greyscale PNG of the source size: 255 where the image is covered. */
  mask: Buffer;
  style: CensorStyle;
  /** Mosaic cell edge or blur radius in pixels; undefined follows the image (src/censor/model.ts). */
  sizePx?: number;
  /** Soft edge in pixels; 0 keeps the edge one anti-aliased pixel wide. */
  featherPx: number;
}
export interface CensorRendered { pixels: Buffer; width: number; height: number; sizePx: number | null; covered: { pixels: number; fraction: number; bbox: { x: number; y: number; width: number; height: number } | null } }

/** The censored picture as opaque RGBA pixels. */
export async function renderCensoredPixels(input: CensorRenderInput): Promise<CensorRendered> {
  const open = (bytes: Buffer) => sharp(bytes, { limitInputPixels: CENSOR_IMAGE_LIMITS.pixels }).timeout({ seconds: CENSOR_IMAGE_LIMITS.seconds });
  const base = await open(input.source).flatten({ background: '#ffffff' }).toColourspace('srgb').removeAlpha().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = base.info;
  if (base.info.channels !== 4) return refuse('The image cannot be read as an RGB picture.');
  const mask = await open(input.mask).extractChannel(0).toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
  if (mask.info.width !== width || mask.info.height !== height || mask.info.channels !== 1) return refuse(`The mask is ${mask.info.width}×${mask.info.height}; it must have the size of the image, ${width}×${height}.`);
  let count = 0, left = width, top = height, right = -1, bottom = -1;
  for (let y = 0, at = 0; y < height; y++) for (let x = 0; x < width; x++, at++) if (mask.data[at] >= 128) { count++; if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y; }
  // The strokes of the editor have anti-aliased edges; a rasterized mask gets the same one-pixel transition.
  const soft = await sharp(mask.data, { raw: { width, height, channels: 1 } }).blur(Math.max(0.5, input.featherPx / 2)).toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
  if (soft.info.channels !== 1 || soft.data.length !== width * height) return refuse('The mask could not be prepared.');
  const weights = soft.data;
  const out = Buffer.from(base.data);
  let sizePx: number | null = null, layer: (at: number, x: number, y: number) => readonly [number, number, number];
  if (input.style === 'mosaic') {
    const block = sizePx = input.sizePx ?? standardMosaicSize(width, height);
    const cells = mosaicCells(base.data, width, height, block);
    layer = (_at, x, y) => { const cell = (Math.floor(y / block) * cells.width + Math.floor(x / block)) * 4; return [cells.data[cell], cells.data[cell + 1], cells.data[cell + 2]]; };
  } else if (input.style === 'blur') {
    sizePx = input.sizePx ?? standardBlurSize(width, height);
    const blurred = await sharp(base.data, { raw: { width, height, channels: 4 } }).removeAlpha().blur(sizePx).raw().toBuffer({ resolveWithObject: true });
    if (blurred.info.channels !== 3) return refuse('The image could not be blurred.');
    layer = at => [blurred.data[at * 3], blurred.data[at * 3 + 1], blurred.data[at * 3 + 2]];
  } else {
    const flat = input.style === 'black' ? [0, 0, 0] as const : [255, 255, 255] as const;
    layer = () => flat;
  }
  for (let y = 0, at = 0; y < height; y++) for (let x = 0; x < width; x++, at++) {
    const weight = weights[at];
    if (!weight) continue;
    const colour = layer(at, x, y), pixel = at * 4;
    for (let channel = 0; channel < 3; channel++) out[pixel + channel] = Math.round(out[pixel + channel] + (colour[channel] - out[pixel + channel]) * weight / 255);
  }
  return { pixels: out, width, height, sizePx, covered: { pixels: count, fraction: count / (width * height), bbox: count ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : null } };
}

/** The whole censored picture, long edge at most 1024, as WebP of at most 1 MiB: what the caller looks at before saving. */
async function previewOf(rendered: CensorRendered) {
  const encode = (quality: number) => sharp(rendered.pixels, { raw: { width: rendered.width, height: rendered.height, channels: 4 } }).removeAlpha()
    .resize({ width: CENSOR_IMAGE_LIMITS.previewEdge, height: CENSOR_IMAGE_LIMITS.previewEdge, fit: 'inside', withoutEnlargement: true }).webp({ quality }).toBuffer({ resolveWithObject: true });
  let image = await encode(82);
  if (image.data.length > CENSOR_IMAGE_LIMITS.previewBytes) image = await encode(55);
  if (image.data.length > CENSOR_IMAGE_LIMITS.previewBytes) throw hostError('preview_unavailable', 'The preview image exceeds 1 MiB.');
  return { mimeType: 'image/webp' as const, data: image.data, width: image.info.width, height: image.info.height };
}

type Original = { data: string; mimeType: string; width: number; height: number; sha256: string; assetId: string };
type Target = { kind: 'history'; id: string; revision: number; assetId: string } | { kind: 'study'; id: string; revision: number };
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : refuse('censor_image takes an object.');
const KEYS = ['kind', 'id', 'revision', 'assetId', 'sourceSha256', 'mask', 'style', 'sizePx', 'featherPx', 'quality', 'preview'];

/** readOriginal: the library's strict original read (asset_library {action:image, variant:original}). */
export function createCensorImageMethod(readOriginal: (target: Target) => Promise<Original>) {
  return async (raw: unknown) => {
    const args = record(raw);
    const unknown = Object.keys(args).filter(key => !KEYS.includes(key));
    if (unknown.length) refuse(`censor_image does not accept: ${unknown.join(', ')}.`);
    if (args.kind !== 'history' && args.kind !== 'study') refuse('kind must be history or study.');
    if (typeof args.id !== 'string' || !args.id || !Number.isSafeInteger(args.revision) || args.revision < 1) refuse('id and revision must name one saved revision.');
    if (args.kind === 'history' ? typeof args.assetId !== 'string' || !args.assetId : args.assetId !== undefined) refuse('assetId names a history original; a study has none.');
    if (!CENSOR_STYLES.includes(args.style)) refuse(`style must be one of ${CENSOR_STYLES.join(', ')}.`);
    const range = args.style === 'blur' ? CENSOR_RANGES.blur : CENSOR_RANGES.mosaic;
    if (args.sizePx !== undefined && (!Number.isSafeInteger(args.sizePx) || args.sizePx < range.min || args.sizePx > range.max || args.style === 'black' || args.style === 'white')) refuse(`sizePx is the mosaic cell or the blur radius: an integer from ${range.min} to ${range.max}, not used with black or white.`);
    const featherPx = args.featherPx ?? 0, quality = args.quality ?? 95;
    if (!Number.isSafeInteger(featherPx) || featherPx < CENSOR_RANGES.feather.min || featherPx > CENSOR_RANGES.feather.max) refuse(`featherPx must be an integer from ${CENSOR_RANGES.feather.min} to ${CENSOR_RANGES.feather.max}.`);
    if (!Number.isSafeInteger(quality) || quality < CENSOR_IMAGE_LIMITS.minQuality || quality > CENSOR_IMAGE_LIMITS.maxQuality) refuse(`quality must be an integer from ${CENSOR_IMAGE_LIMITS.minQuality} to ${CENSOR_IMAGE_LIMITS.maxQuality}.`);
    if (typeof args.preview !== 'boolean') refuse('preview must be true or false.');
    if (typeof args.mask !== 'string' || !args.mask || args.mask.length > CENSOR_IMAGE_LIMITS.maskBytes * 1.4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(args.mask)) refuse('mask must be the base64 of a PNG of at most 4 MiB.');
    const mask = Buffer.from(args.mask, 'base64');
    if (mask.length > CENSOR_IMAGE_LIMITS.maskBytes || !mask.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) refuse('mask must be the base64 of a PNG of at most 4 MiB.');
    const original = await readOriginal(args.kind === 'history' ? { kind: 'history', id: args.id, revision: args.revision, assetId: args.assetId } : { kind: 'study', id: args.id, revision: args.revision });
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(original.mimeType)) throw hostError('unsupported_image', 'Only PNG, JPEG and WebP originals can be censored.');
    // The mask was made for the original the caller measured; a different original now is refused, never censored.
    if (args.sourceSha256 !== undefined && args.sourceSha256 !== original.sha256) throw hostError('image_changed', 'The original is not the one the mask was made for; read the image again.');
    let rendered: CensorRendered;
    try { rendered = await renderCensoredPixels({ source: Buffer.from(original.data, 'base64'), mask, style: args.style, sizePx: args.sizePx, featherPx }); }
    catch (error: any) { if (typeof error?.code === 'string' && /^[a-z_]+$/.test(error.code)) throw error; throw hostError('invalid_image', 'The image or the mask could not be decoded; nothing was produced.'); }
    const image = args.preview ? await previewOf(rendered)
      : { mimeType: 'image/jpeg' as const, data: await encodeCensoredJpeg(rendered.pixels, rendered.width, rendered.height, quality), width: rendered.width, height: rendered.height };
    return {
      kind: args.kind, id: args.id, revision: args.revision, assetId: original.assetId, preview: args.preview, saved: false,
      style: args.style, sizePx: rendered.sizePx, featherPx, quality: args.preview ? null : quality,
      source: { width: rendered.width, height: rendered.height, sha256: original.sha256 }, covered: rendered.covered,
      image: { mimeType: image.mimeType, width: image.width, height: image.height, byteLength: image.data.length, sha256: sha256(image.data), data: image.data.toString('base64') },
    };
  };
}
