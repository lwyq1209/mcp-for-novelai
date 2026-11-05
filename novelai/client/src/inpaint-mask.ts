export function buildBinaryInpaintMask(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
) {
  if (width <= 0 || height <= 0 || rgba.length < width * height * 4) {
    throw new RangeError("Invalid inpaint mask dimensions or RGBA buffer.");
  }
  const binary = new Uint8ClampedArray(width * height * 4);
  let any = false;

  for (let index = 0; index < binary.length; index += 4) {
    // Selection is stored in alpha, not in a magic RGB value. This keeps all
    // display colors valid mask colors too (especially pure black), while a
    // transparent pixel remains the single unambiguous "preserve" state.
    const selected = rgba[index + 3] > 0;
    const value = selected ? 255 : 0;
    binary[index] = value;
    binary[index + 1] = value;
    binary[index + 2] = value;
    // NovelAI's editor thresholds the downscaled mask alpha. Encode the binary
    // selection in alpha as well as RGB so the transport path can match it.
    binary[index + 3] = value;
    any ||= selected;
  }

  return { rgba: binary, any };
}

/**
 * Build an unmistakable on-canvas visualization of the exact binary mask.
 * The transport mask stays lossless black/white; this helper only adds alpha
 * for the preview so users can see both the selected and preserved regions.
 */
export function buildInpaintMaskPreview(
  binaryRgba: Uint8ClampedArray,
  width: number,
  height: number,
  color = "#ffffff",
) {
  if (
    width <= 0 ||
    height <= 0 ||
    binaryRgba.length < width * height * 4
  ) {
    throw new RangeError("Invalid inpaint mask dimensions or RGBA buffer.");
  }
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  const packed = Number.parseInt(match?.[1] ?? "ffffff", 16);
  const red = (packed >> 16) & 255;
  const green = (packed >> 8) & 255;
  const blue = packed & 255;
  const preview = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < preview.length; index += 4) {
    const selected = binaryRgba[index + 3] > 0;
    preview[index] = selected ? red : 0;
    preview[index + 1] = selected ? green : 0;
    preview[index + 2] = selected ? blue : 0;
    // The preview is laid over the source image. Preserved pixels must stay
    // transparent so previewing the exact mask never hides the original.
    // Opacity is controlled once by the canvas CSS layer. Keeping pixel alpha
    // at 255 makes the UI's 100% setting genuinely opaque instead of silently
    // multiplying it by an additional 230/255 factor.
    preview[index + 3] = selected ? 255 : 0;
  }
  return preview;
}

/** The size of one cell of the inpaint mask grid (NovelAI repaints whole 8×8 latent cells). */
export const MASK_CELL_PIXELS = 8;

/**
 * How many 8×8 cells of a mask select something (any pixel with alpha above 0): the number the mask tool bar shows
 * ("选中 N 格"). A cell at the right or bottom edge may be partial.
 */
export function countMaskCells(rgba: ArrayLike<number>, width: number, height: number, cell = MASK_CELL_PIXELS): number {
  if (width <= 0 || height <= 0) return 0;
  const columns = Math.ceil(width / cell);
  const seen = new Uint8Array(columns * Math.ceil(height / cell));
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    const row = Math.floor(y / cell) * columns;
    for (let x = 0; x < width; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] <= 0) continue;
      const index = row + Math.floor(x / cell);
      if (!seen[index]) { seen[index] = 1; count += 1; }
    }
  }
  return count;
}

/** Inverts a drawn mask in place: selected pixels become transparent, the others opaque in the display colour. */
export function invertMaskPixels(rgba: Uint8ClampedArray, color = "#ffffff") {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  const packed = Number.parseInt(match?.[1] ?? "ffffff", 16);
  const red = (packed >> 16) & 255, green = (packed >> 8) & 255, blue = packed & 255;
  for (let index = 0; index < rgba.length; index += 4) {
    if (rgba[index + 3] > 0) {
      rgba[index] = 0; rgba[index + 1] = 0; rgba[index + 2] = 0; rgba[index + 3] = 0;
    } else {
      rgba[index] = red; rgba[index + 1] = green; rgba[index + 2] = blue; rgba[index + 3] = 255;
    }
  }
  return rgba;
}
