// Test fixture: an Electron nativeImage stand-in with the real decoder coverage. Electron's createFromBuffer
// decodes PNG and JPEG only (docs "Supported Formats"; shell/common/skia_util.cc) and returns an empty image for
// anything else; a manual check with the project's Electron 42 decoded PNG and JPEG and returned an empty 0×0 image
// for WebP. Here PNG is decoded with pngjs and JPEG synchronously with sharp in a child process (EXIF ignored, as in
// nativeImage); WebP, GIF and everything else give an empty image. resize is nearest neighbour; toPNG re-encodes.
// Use inside vi.mock('electron', async () => ({ ..., nativeImage: (await import('./native-image-fixture')).strictNativeImage })).
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const sharpEntry = createRequire(import.meta.url).resolve('sharp');
const decodeJpeg = (bytes: Buffer) => execFileSync(process.execPath, ['-e',
  `const sharp=require(${JSON.stringify(sharpEntry)});const c=[];process.stdin.on('data',d=>c.push(d)).on('end',async()=>{process.stdout.write(await sharp(Buffer.concat(c),{failOn:'error'}).png().toBuffer());});`,
], { input: bytes, maxBuffer: 512 * 1024 * 1024 });

/** Every createFromBuffer call, by detected format, so tests can show which bytes reached the decoder. */
export const nativeImageCalls: Array<'png' | 'jpeg' | 'other'> = [];

const empty = () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toPNG: () => Buffer.alloc(0), resize: () => empty() });
function wrap(png: PNG): any {
  return {
    isEmpty: () => false, getSize: () => ({ width: png.width, height: png.height }), toPNG: () => PNG.sync.write(png),
    resize({ width, height }: { width: number; height: number }) {
      const out = new PNG({ width, height });
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const from = (Math.min(png.height - 1, Math.floor(y * png.height / height)) * png.width + Math.min(png.width - 1, Math.floor(x * png.width / width))) * 4;
        png.data.copy(out.data, (y * width + x) * 4, from, from + 4);
      }
      return wrap(out);
    },
  };
}

export const strictNativeImage = {
  createFromBuffer(buffer: Buffer) {
    const bytes = Buffer.from(buffer);
    try {
      if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) { nativeImageCalls.push('png'); return wrap(PNG.sync.read(bytes)); }
      if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) { nativeImageCalls.push('jpeg'); return wrap(PNG.sync.read(decodeJpeg(bytes))); }
    } catch { return empty(); }
    nativeImageCalls.push('other');
    return empty();
  },
  createFromPath() { throw new Error('fixture: nativeImage.createFromPath is not available'); },
};
