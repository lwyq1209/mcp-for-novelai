import sharp from "sharp";

export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;
export function isWebp(bytes: Buffer) {
  return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
}
/** Electron nativeImage does not decode WebP on every platform. Keep source files
 * untouched; use the first composited frame as the static processing input. */
export async function processableImage(bytes: Buffer): Promise<Buffer> {
  if (!isWebp(bytes)) return bytes;
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Image exceeds 32 MB");
  return sharp(bytes, {limitInputPixels: MAX_IMAGE_PIXELS, pages: 1}).rotate().png().toBuffer();
}

/** A WebP source could not be turned into the PNG that nativeImage needs; no provider request was built. */
export class ImageConversionError extends Error {
  readonly code = "source_conversion_failed";
  constructor(message = "The WebP source could not be converted to PNG for the image builder; nothing was sent. Convert it to PNG locally and use that copy.") { super(message); }
}
/** Decoder input for Electron nativeImage, which decodes PNG and JPEG only (createFromBuffer). A WebP becomes a PNG
 * of its first frame with the pixels as stored: no EXIF rotation, as nativeImage ignores EXIF for PNG and JPEG too,
 * so sizes stay the stored ones. Other bytes are returned unchanged. Callers keep the original bytes as the bound
 * source (sha256, readback, receipts); this derivative only feeds the decoder and the provider request. */
export async function nativeImageInput(bytes: Buffer): Promise<Buffer> {
  if (!isWebp(bytes)) return bytes;
  if (bytes.length > MAX_IMAGE_BYTES) throw new ImageConversionError("The WebP source exceeds 32 MB and was not converted; nothing was sent.");
  try { return await sharp(bytes, {limitInputPixels: MAX_IMAGE_PIXELS, pages: 1}).png().toBuffer(); }
  catch { throw new ImageConversionError(); }
}
/** Width and height from a WebP header (VP8, VP8L or VP8X) without decoding, or null when the header is not one of them. */
export function webpDimensions(bytes: Buffer): {width: number; height: number} | null {
  if (!isWebp(bytes) || bytes.length < 30) return null;
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return {width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff};
  if (chunk === "VP8L" && bytes[20] === 0x2f) { const bits = bytes.readUInt32LE(21); return {width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1}; }
  if (chunk === "VP8X") return {width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3)};
  return null;
}

export async function validateImage(bytes: Buffer) {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("Image is empty or exceeds 32 MB");
  const meta = await sharp(bytes, {limitInputPixels: MAX_IMAGE_PIXELS, pages: 1}).metadata();
  if (!meta.width || !meta.height || !["png", "jpeg", "webp", "gif", "avif", "tiff"].includes(meta.format ?? "")) throw new Error("Unsupported image data");
  // Decoding, not just the filename/header, validates the clipboard payload.
  await sharp(bytes, {limitInputPixels: MAX_IMAGE_PIXELS, pages: 1}).resize({width: 1, height: 1}).raw().toBuffer();
  return {width: meta.width, height: meta.pageHeight ?? meta.height, extension: meta.format === "jpeg" ? "jpg" : meta.format!};
}
