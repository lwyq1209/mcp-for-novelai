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
