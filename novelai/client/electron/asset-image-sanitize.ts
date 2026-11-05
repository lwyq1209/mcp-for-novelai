import sharp from 'sharp';
import { PNG } from 'pngjs';
import { inflateSync } from 'node:zlib';
import type { ImageExportReason } from '../src/asset-library/image-export';

export const IMAGE_EXPORT_LIMITS = Object.freeze({ items: 100, images: 300, fileBytes: 64 * 1024 * 1024, totalBytes: 512 * 1024 * 1024, pixels: 16_000_000 });
export class ImageExportError extends Error {
  constructor(readonly reason: ImageExportReason) { super(reason); }
}
export const rejectImage = (reason: ImageExportReason): never => { throw new ImageExportError(reason); };
export function imageFormat(bytes: Buffer): 'png' | 'jpg' | 'webp' {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') return 'webp';
  return rejectImage('unsupported');
}
export function pngChunkTypes(bytes: Buffer): string[] {
  const types: string[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    if (length > bytes.length - offset - 12) return rejectImage('verification');
    types.push(type); if (types.length > 10_000) return rejectImage('limit'); offset += length + 12;
    if (type === 'IEND') { if (offset !== bytes.length) return rejectImage('verification'); return types; }
  }
  return rejectImage('verification');
}
/** Recognise the known NovelAI alpha.T / RGB.T signatures, even with corrupt payloads.
 * Refuse rather than erase/quantise transparency. This is NOT arbitrary steganalysis. */
export function hasKnownStealth(bytes: Buffer): boolean {
  return hasKnownStealthPixels(PNG.sync.read(bytes));
}
export function hasKnownStealthPixels({ width, height, data }: { width: number; height: number; data: Buffer }): boolean {
  for (const channels of [[3], [0,1,2]]) {
    const header = Buffer.alloc(15);
    for (let bit = 0; bit < header.length * 8; bit++) {
      const pixel = Math.floor(bit / channels.length);
      if (pixel >= width * height) break;
      const x = Math.floor(pixel / height), y = pixel % height;
      header[bit >> 3] |= (data[(y * width + x) * 4 + channels[bit % channels.length]] & 1) << (7 - (bit & 7));
    }
    if (/^stealth_(png|rgb)(comp|info)/.test(header.toString('ascii'))) return true;
  }
  return false;
}
/** Bound PNG dimensions and compressed profiles/text before libvips reads them. */
function preflightPng(bytes: Buffer) {
  const types = pngChunkTypes(bytes);
  if (types.filter(type=>type==='IHDR').length !== 1) return rejectImage('verification');
  if (bytes.length < 33 || bytes.toString('ascii',12,16) !== 'IHDR' || bytes.readUInt32BE(8) !== 13) return rejectImage('verification');
  if (bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > IMAGE_EXPORT_LIMITS.pixels) return rejectImage('limit');
  const interlaced = bytes[28] === 1;
  if (bytes[28] > 1) return rejectImage('verification');
  const idat: Buffer[] = [];
  let remaining = 4 * 1024 * 1024;
  for (let at=8; at+12<=bytes.length;) {
    const size=bytes.readUInt32BE(at), type=bytes.toString('ascii',at+4,at+8), data=bytes.subarray(at+8,at+8+size);
    if (interlaced && type==='IDAT') idat.push(data);
    if (['iCCP','zTXt','iTXt'].includes(type)) {
      const zero=data.indexOf(0);
      if (zero<0) return rejectImage('verification');
      let start=zero+2;
      const compressed=type!=='iTXt'||data[zero+1]===1;
      if (type==='iTXt'&&compressed) { const language=data.indexOf(0,zero+3); start=language<0?0:data.indexOf(0,language+1)+1; if (!start) return rejectImage('verification'); }
      if (compressed) {
        if (remaining <= 0) return rejectImage('limit');
        try { remaining -= inflateSync(data.subarray(start),{maxOutputLength:remaining}).length; }
        catch { return rejectImage('limit'); }
      }
    }
    at+=size+12;
  }
  if (interlaced) {
    // pngjs's Adam7 sync path otherwise uses unbounded zlib.inflateSync. Bound
    // the deterministic IDAT stream to the exact declared pass raster size first.
    const width=bytes.readUInt32BE(16), height=bytes.readUInt32BE(20), depth=bytes[24];
    const channels: Record<number,number> = {0:1,2:3,3:1,4:2,6:4};
    const bands=channels[bytes[25]];
    if (!bands || ![1,2,4,8,16].includes(depth)) return rejectImage('verification');
    let maximum=0;
    for (const [x,y,dx,dy] of [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]]) {
      const w=Math.max(0,Math.ceil((width-x)/dx)), h=Math.max(0,Math.ceil((height-y)/dy));
      if(w&&h)maximum+=(Math.ceil(w*bands*depth/8)+1)*h;
    }
    if (!maximum) return rejectImage('verification');
    try { inflateSync(Buffer.concat(idat),{maxOutputLength:maximum}); }
    catch { return rejectImage('limit'); }
  }
}
const decoder = (bytes: Buffer) => sharp(bytes, { limitInputPixels: IMAGE_EXPORT_LIMITS.pixels, failOn: 'warning', animated: false }).timeout({ seconds: 15 });
export async function exportImageBytes(bytes: Buffer, stripMetadata: boolean): Promise<{ bytes: Buffer; extension: string }> {
  if (bytes.length > IMAGE_EXPORT_LIMITS.fileBytes) return rejectImage('limit');
  const format = imageFormat(bytes);
  try {
    if (format === 'png') preflightPng(bytes);
    const meta = await decoder(bytes).metadata();
    if (!meta.width || !meta.height || meta.width * meta.height > IMAGE_EXPORT_LIMITS.pixels) return rejectImage('limit');
    // Validate the raster without using decoded pixels as the raw-mode output.
    if (!stripMetadata) { await decoder(bytes).stats(); return { bytes, extension: format }; }
    if ((meta.pages ?? 1) > 1 || (format === 'png' && pngChunkTypes(bytes).includes('acTL'))) return rejectImage('animated');
    if (format === 'png') {
      // 16-bit PNG's alpha encoding is not covered by this initial stealth detector.
      if (bytes[24] !== 8) return rejectImage('unsupported');
      if (hasKnownStealth(bytes)) return rejectImage('stealth');
    }
    // Decode the source raster BEFORE auto-orientation or ICC conversion. Output
    // scans alone miss signatures displaced by EXIF transforms (e.g. WebP alpha).
    // PNG also keeps the independent pngjs scan above. JPEG inspection concerns
    // its decoded RGB raster, not arbitrary steganography in compressed data.
    const source = await sharp(bytes, { limitInputPixels: IMAGE_EXPORT_LIMITS.pixels, failOn: 'warning', animated: false, ignoreIcc: true })
      .ensureAlpha().raw().timeout({ seconds: 15 }).toBuffer({ resolveWithObject: true });
    if (source.info.channels !== 4) return rejectImage('unsupported');
    if (hasKnownStealthPixels({ width: source.info.width, height: source.info.height, data: source.data })) return rejectImage('stealth');
    // Sharp honours source profiles; bake EXIF orientation and convert to sRGB.
    // Default metadata stripping removes EXIF/XMP/IPTC/ICC/text. Output is 8-bit PNG.
    const output = await decoder(bytes).rotate().toColourspace('srgb').png().toBuffer();
    if (output.length > IMAGE_EXPORT_LIMITS.fileBytes) return rejectImage('limit');
    await verifyCleanPng(output, meta.width, meta.height, meta.orientation, !!meta.hasAlpha);
    return { bytes: output, extension: 'png' };
  } catch (error) {
    if (error instanceof ImageExportError) throw error;
    return rejectImage('verification');
  }
}
export async function verifyCleanPng(output: Buffer, width: number, height: number, orientation: number | undefined, alpha: boolean) {
  if (imageFormat(output) !== 'png' || pngChunkTypes(output).some(type => !['IHDR','IDAT','IEND','pHYs'].includes(type))) return rejectImage('verification');
  const info = await decoder(output).metadata();
  const rotated = orientation !== undefined && orientation >= 5 && orientation <= 8;
  if (info.width !== (rotated ? height : width) || info.height !== (rotated ? width : height) || !!info.hasAlpha !== alpha || info.exif || info.xmp || info.iptc || info.icc || hasKnownStealth(output)) return rejectImage('verification');
  // Independent decoder checks integrity (including CRC) and full raster.
  const decoded = PNG.sync.read(output);
  if (decoded.width !== info.width || decoded.height !== info.height) return rejectImage('verification');
}
