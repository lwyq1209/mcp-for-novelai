/** NovelAI generation dimensions are expressed in 64-pixel blocks. */
export const NAI_DIMENSION_STEP = 64;
export const NAI_MIN_DIMENSION = 64;
/** Current official custom-size ceiling: the pair may not exceed 3 Mi pixels. */
export const NAI_MAX_PIXEL_AREA = 3_145_728;
/** A single side can consume the whole area only when the other side is 64. */
export const NAI_MAX_DIMENSION = NAI_MAX_PIXEL_AREA / NAI_MIN_DIMENSION;

export interface NAIImageSize {
  width: number;
  height: number;
}

export interface NAIEnhanceOutputSize extends NAIImageSize {
  exceedsLimit: boolean;
}

export function snapNAIDimension(value: unknown, fallback = 1024): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return snapNAIDimension(fallback, 1024);
  return Math.min(
    NAI_MAX_DIMENSION,
    Math.max(
      NAI_MIN_DIMENSION,
      Math.round(parsed / NAI_DIMENSION_STEP) * NAI_DIMENSION_STEP,
    ),
  );
}

export function maxNAIDimensionFor(pairedDimension: unknown): number {
  const paired = snapNAIDimension(pairedDimension, NAI_MIN_DIMENSION);
  return Math.max(
    NAI_MIN_DIMENSION,
    Math.floor(NAI_MAX_PIXEL_AREA / paired / NAI_DIMENSION_STEP) *
      NAI_DIMENSION_STEP,
  );
}

/**
 * Commit one completed field while respecting the official total-pixel cap.
 * Callers intentionally invoke this on blur/Enter, never for each keystroke.
 */
export function snapNAIDimensionWithinArea(
  value: unknown,
  pairedDimension: unknown,
  fallback = 1024,
): number {
  return Math.min(
    snapNAIDimension(value, fallback),
    maxNAIDimensionFor(pairedDimension),
  );
}

export function fitNAIImageSize(
  width: unknown,
  height: unknown,
  fallback: NAIImageSize = { width: 832, height: 1216 },
): NAIImageSize {
  const snapped = {
    width: snapNAIDimension(width, fallback.width),
    height: snapNAIDimension(height, fallback.height),
  };
  if (snapped.width * snapped.height <= NAI_MAX_PIXEL_AREA) return snapped;

  const scale = Math.sqrt(
    NAI_MAX_PIXEL_AREA / (snapped.width * snapped.height),
  );
  return {
    width: Math.max(
      NAI_MIN_DIMENSION,
      Math.floor((snapped.width * scale) / NAI_DIMENSION_STEP) *
        NAI_DIMENSION_STEP,
    ),
    height: Math.max(
      NAI_MIN_DIMENSION,
      Math.floor((snapped.height * scale) / NAI_DIMENSION_STEP) *
        NAI_DIMENSION_STEP,
    ),
  };
}

export function adaptiveNAIImageSize(
  width: unknown,
  height: unknown,
  fallback: NAIImageSize = { width: 832, height: 1216 },
): NAIImageSize {
  return fitNAIImageSize(width, height, fallback);
}

/**
 * Resolve the requested Enhance output without silently shrinking it. This is
 * used by the 2x Enhance path so an oversized request can be stopped locally.
 */
export function resolveNAIEnhanceOutputSize(
  width: unknown,
  height: unknown,
  scale: unknown,
  fallback: NAIImageSize = { width: 832, height: 1216 },
): NAIEnhanceOutputSize {
  const parsedScale = Number(scale);
  const safeScale = Number.isFinite(parsedScale)
    ? Math.max(1, parsedScale)
    : 1;
  const output = {
    width: snapNAIDimension(Number(width) * safeScale, fallback.width),
    height: snapNAIDimension(Number(height) * safeScale, fallback.height),
  };
  return {
    ...output,
    exceedsLimit: output.width * output.height > NAI_MAX_PIXEL_AREA,
  };
}

export function isNAIDimension(value: unknown): boolean {
  const parsed = Number(value);
  return (
    Number.isInteger(parsed) &&
    parsed >= NAI_MIN_DIMENSION &&
    parsed <= NAI_MAX_DIMENSION &&
    parsed % NAI_DIMENSION_STEP === 0
  );
}

export function isNAIImageSize(size: NAIImageSize): boolean {
  return (
    isNAIDimension(size.width) &&
    isNAIDimension(size.height) &&
    size.width * size.height <= NAI_MAX_PIXEL_AREA
  );
}

/**
 * Enhance Max✨ (V5 Curated and Full). Official web client (https://novelai.net/image, build b94bdee-production,
 * fetched 2026-11-06): the enhance panel offers "max" only for a model with `maxEnhance` (V5 Curated, V5 Full and
 * its Medium effort) and a source of fewer than 0.8 × 3,145,728 pixels (chunk 3ayz70v6mlfvn.js); the request then
 * keeps the source's own width and height and sets `upscaled_enhance: true` (chunk 0vm-a10r598mm.js generateEnhance,
 * which also skips the "-2::upscaled, blurry::" prompt addition of the 1×/1.5×/2× enhance), and the price is read
 * for the size the result will have (chunk 3ayz70v6mlfvn.js with 274ff5q_u23hy.js `T`: each side floored to 16 and
 * doubled, then fitted into 3,145,728 pixels in steps of 32). Max is never free on Opus: the result is always
 * larger than 1024×1024.
 */
export const NAI_MAX_ENHANCE_INPUT_LIMIT = 0.8 * NAI_MAX_PIXEL_AREA;

/** The size a Max✨ enhance sends: the source when it is 64-aligned and under the limit, else the closest such size. */
export function maxEnhanceInputSize(width: unknown, height: unknown): NAIImageSize & { resized: boolean } {
  const fitted = fitNAIImageSize(width, height);
  let size: NAIImageSize = fitted;
  if (fitted.width * fitted.height >= NAI_MAX_ENHANCE_INPUT_LIMIT) {
    const ratio = Math.sqrt((NAI_MAX_ENHANCE_INPUT_LIMIT - 1) / (fitted.width * fitted.height));
    size = {
      width: Math.max(NAI_MIN_DIMENSION, Math.floor((fitted.width * ratio) / NAI_DIMENSION_STEP) * NAI_DIMENSION_STEP),
      height: Math.max(NAI_MIN_DIMENSION, Math.floor((fitted.height * ratio) / NAI_DIMENSION_STEP) * NAI_DIMENSION_STEP),
    };
    // A side already at the minimum cannot shrink with the other: shorten the long side alone.
    if (size.width * size.height >= NAI_MAX_ENHANCE_INPUT_LIMIT) {
      const long = Math.floor((NAI_MAX_ENHANCE_INPUT_LIMIT - 1) / Math.min(size.width, size.height) / NAI_DIMENSION_STEP) * NAI_DIMENSION_STEP;
      size = size.width >= size.height ? { width: long, height: size.height } : { width: size.width, height: long };
    }
  }
  return { ...size, resized: size.width !== Number(width) || size.height !== Number(height) };
}

/** The size the official client expects back from a Max✨ enhance of this input (its `T`, used for the price). */
export function maxEnhanceOutputSize(width: number, height: number): NAIImageSize {
  const doubledWidth = Math.floor(width / 16) * 16 * 2, doubledHeight = Math.floor(height / 16) * 16 * 2;
  const scale = Math.min(1, Math.sqrt(NAI_MAX_PIXEL_AREA / (doubledWidth * doubledHeight)));
  let outWidth = 32 * Math.round((doubledWidth * scale) / 32), outHeight = 32 * Math.round((doubledHeight * scale) / 32);
  if (outWidth * outHeight > NAI_MAX_PIXEL_AREA) {
    outWidth = 32 * Math.floor((doubledWidth * scale) / 32);
    outHeight = 32 * Math.floor((doubledHeight * scale) / 32);
  }
  return { width: Math.max(32, outWidth), height: Math.max(32, outHeight) };
}

/** The three sizes a V4.5 Precise Reference is fitted into and padded to (docs.novelai.net/en/image/precisereference). */
export const NAI_REFERENCE_PAD_SIZES: readonly NAIImageSize[] = [{ width: 1024, height: 1536 }, { width: 1472, height: 1472 }, { width: 1536, height: 1024 }];

/** How a V4.5 Precise Reference is sent: the pad size with the closest aspect ratio and the scaled image inside it. */
export function naiReferencePadSize(width: number, height: number): NAIImageSize & { fitWidth: number; fitHeight: number; unchanged: boolean } {
  const aspect = width / height;
  const target = NAI_REFERENCE_PAD_SIZES.reduce((best, candidate) => Math.abs(candidate.width / candidate.height - aspect) < Math.abs(best.width / best.height - aspect) ? candidate : best, NAI_REFERENCE_PAD_SIZES[0]);
  const scale = Math.min(target.width / width, target.height / height);
  return { ...target, fitWidth: Math.max(1, Math.round(width * scale)), fitHeight: Math.max(1, Math.round(height * scale)), unchanged: width === target.width && height === target.height };
}

/**
 * The buckets a V5 Precise Reference is cropped to, [width, height] in multiples of 64 at about 1 MP, from 1:16 to
 * 16:1. Copied from the official web client (build fac57e6, 2026-11-24; its bucketCharacterReferences table).
 */
export const NAI_REFERENCE_BUCKETS: ReadonlyArray<readonly [number, number]> = [
  [256, 4096], [256, 4032], [256, 3968], [256, 3904], [256, 3840], [256, 3776], [256, 3712], [256, 3648], [256, 3584], [256, 3520],
  [256, 3456], [256, 3392], [256, 3328], [320, 3264], [320, 3200], [320, 3136], [320, 3072], [320, 3008], [320, 2944], [320, 2880],
  [320, 2816], [320, 2752], [384, 2688], [384, 2624], [384, 2560], [384, 2496], [384, 2432], [384, 2368], [448, 2304], [448, 2240],
  [448, 2176], [448, 2112], [512, 2048], [512, 1984], [512, 1920], [512, 1856], [576, 1792], [576, 1728], [576, 1664], [640, 1600],
  [640, 1536], [704, 1472], [704, 1408], [768, 1344], [768, 1280], [832, 1216], [896, 1152], [960, 1088], [1024, 1024], [1088, 960],
  [1152, 896], [1216, 832], [1280, 768], [1344, 768], [1408, 704], [1472, 704], [1536, 640], [1600, 640], [1664, 576], [1728, 576],
  [1792, 576], [1856, 512], [1920, 512], [1984, 512], [2048, 512], [2112, 448], [2176, 448], [2240, 448], [2304, 448], [2368, 384],
  [2432, 384], [2496, 384], [2560, 384], [2624, 384], [2688, 384], [2752, 320], [2816, 320], [2880, 320], [2944, 320], [3008, 320],
  [3072, 320], [3136, 320], [3200, 320], [3264, 320], [3328, 256], [3392, 256], [3456, 256], [3520, 256], [3584, 256], [3648, 256],
  [3712, 256], [3776, 256], [3840, 256], [3904, 256], [3968, 256], [4032, 256], [4096, 256],
];

export interface NAIReferenceBucket extends NAIImageSize {
  /** The size the image is resized to before the crop (it covers the bucket). */
  resizeWidth: number;
  resizeHeight: number;
  /** The crop's corner in the resized image (the crop is centred). */
  left: number;
  top: number;
  /** The image already is the bucket's size and is sent as it is. */
  unchanged: boolean;
}

/**
 * How a V5 Precise Reference is sent, as the official client computes it: the bucket whose aspect ratio is closest in
 * log space (the first one on a tie), the image resized to cover it and cropped around its centre. Nothing is padded.
 */
export function naiReferenceBucket(width: number, height: number): NAIReferenceBucket {
  const aspect = Math.log(Math.max(width, 1) / Math.max(height, 1));
  let bucket = NAI_REFERENCE_BUCKETS[0], distance = Math.abs(aspect - Math.log(bucket[0] / bucket[1]));
  for (const candidate of NAI_REFERENCE_BUCKETS) {
    const next = Math.abs(aspect - Math.log(candidate[0] / candidate[1]));
    if (next < distance) { bucket = candidate; distance = next; }
  }
  const [bucketWidth, bucketHeight] = bucket;
  const scale = Math.max(bucketWidth / width, bucketHeight / height);
  const resizeWidth = Math.max(Math.floor(width * scale + 0.5), bucketWidth), resizeHeight = Math.max(Math.floor(height * scale + 0.5), bucketHeight);
  return { width: bucketWidth, height: bucketHeight, resizeWidth, resizeHeight, left: Math.floor((resizeWidth - bucketWidth) / 2), top: Math.floor((resizeHeight - bucketHeight) / 2), unchanged: width === bucketWidth && height === bucketHeight };
}
