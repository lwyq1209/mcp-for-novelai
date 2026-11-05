import { describe, expect, it } from 'vitest';
import { deflateSync, gzipSync } from 'node:zlib';
import sharp from 'sharp';
import { PNG } from 'pngjs';
import { parseImageStudy, STUDY_PARSE_LIMITS } from './image-study-parser';

function chunk(type: string, data: Buffer) {
  const header = Buffer.alloc(8); header.writeUInt32BE(data.length); header.write(type, 4);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([Buffer.from(type), data])) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  const tail = Buffer.alloc(4); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, data, tail]);
}
async function plain() { return sharp({ create: { width: 6, height: 4, channels: 4, background: '#83ab8f' } }).png().toBuffer(); }
function append(png: Buffer, chunks: Buffer[]) { return Buffer.concat([png.subarray(0, -12), ...chunks, png.subarray(-12)]); }
function textChunk(key: string, value: string) { return chunk('tEXt', Buffer.from(`${key}\0${value}`)); }
function compressed(key: string, value: string, international = false) { return chunk(international ? 'iTXt' : 'zTXt', Buffer.concat([Buffer.from(international ? `${key}\0\x01\x00\0\0` : `${key}\0\x00`), deflateSync(Buffer.from(value))])); }
function stealth(meta: object, invalid = false) {
  const width = 96, height = 80, image = new PNG({ width, height }); image.data.fill(255);
  const payload = invalid ? Buffer.from('invalid gzip') : gzipSync(Buffer.from(JSON.stringify(meta))), length = Buffer.alloc(4); length.writeUInt32BE(payload.length * 8);
  const bits = Buffer.concat([Buffer.from('stealth_pngcomp'), length, payload]);
  for (let i = 0; i < bits.length * 8; i++) { const x = Math.floor(i / height), y = i % height, alpha = (y * width + x) * 4 + 3; image.data[alpha] = 254 | ((bits[i >> 3] >> (7 - (i & 7))) & 1); }
  return PNG.sync.write(image);
}

describe('image study source extraction', () => {
  it('preserves complete V5 text, all character centers and original-only values', async () => {
    const comment = { model: 'nai-diffusion-5-full', seed: 4_000_000_000, steps: 28, custom: { a: 1 }, v4_prompt: { use_coords: true, caption: { base_caption: 'landscape, 1.2::watercolor::', char_captions: [{ char_caption: 'adult, blue coat', centers: [{ x: 0.1, y: 0.2 }, { x: 0.8, y: 0.9 }] }, { char_caption: 'adult, red coat' }] } }, v4_negative_prompt: { caption: { base_caption: '', char_captions: [{ char_caption: '' }, { char_caption: 'hat' }] } } };
    const result = await parseImageStudy(append(await plain(), [textChunk('Software', 'NovelAI'), textChunk('Description', 'original fallback'), textChunk('Comment', JSON.stringify(comment))]));
    expect(result.metadataStatus).toBe('generation'); expect(result.metadataKind).toBe('novelai');
    expect(result.prompts.find(row => row.key.endsWith('char_captions[0].centers'))?.value).toBe(JSON.stringify(comment.v4_prompt.caption.char_captions[0].centers));
    expect(result.prompts.some(row => row.key.endsWith('char_captions[1].centers'))).toBe(false);
    expect(result.prompts.filter(row => row.key.endsWith('char_caption'))).toHaveLength(4);
    expect(result.parameters.find(row => row.key.endsWith('.seed'))?.value).toBe('4000000000');
    expect(result.parameters.some(row => /qualityPreset|stylePrompt|ucPreset/.test(row.key))).toBe(false);
    expect(result.raw['png-text'].Comment).toBe(JSON.stringify(comment));
  });
  it('supports compressed zTXt and iTXt through the same metadata interpretation', async () => {
    const result = await parseImageStudy(append(await plain(), [compressed('Software', 'NovelAI'), compressed('Comment', JSON.stringify({ prompt: 'red mug', uc: 'text', seed: 7 }), true)]));
    expect(result.sources).toEqual(['png-compressed']); expect(result.metadataStatus).toBe('generation');
    expect(result.prompts.map(row => row.value)).toEqual(['red mug', 'text']);
  });
  it('decodes official alpha-transposed stealth with object Comment', async () => {
    const result = await parseImageStudy(stealth({ Software: 'NovelAI', Comment: { prompt: 'green garden', seed: 123 } }));
    expect(result.sources).toEqual(['png-stealth']); expect(result.prompts[0].value).toBe('green garden');
    expect(result.raw['png-stealth'].Comment).toBe('{"prompt":"green garden","seed":123}');
  });
  it('retains conflicting standard and stealth values and marks partial', async () => {
    const result = await parseImageStudy(append(stealth({ Software: 'NovelAI', Comment: { prompt: 'green garden' } }), [textChunk('Comment', '{"prompt":"red garden"}')]));
    expect(result.sources).toEqual(['png-text', 'png-stealth']); expect(result.metadataStatus).toBe('partial');
    expect(result.prompts.map(row => row.value)).toEqual(['red garden', 'green garden']); expect(result.warnings.join(' ')).toContain('conflict');
  });
  it('distinguishes absent data and ordinary descriptions from generation evidence', async () => {
    expect((await parseImageStudy(await plain())).metadataStatus).toBe('missing');
    const result = await parseImageStudy(append(await plain(), [textChunk('Description', 'A watercolor landscape')]));
    expect(result.metadataStatus).toBe('other_metadata'); expect(result.metadataKind).toBe('unknown');
    expect(result.prompts[0].value).toBe('A watercolor landscape');
  });
  it('keeps malformed/oversized/deep metadata partial without rejecting a sound image', async () => {
    const bad = await parseImageStudy(append(await plain(), [textChunk('Comment', '{broken')]));
    expect(bad.metadataStatus).toBe('partial'); expect(bad.raw['png-text'].Comment).toBe('{broken');
    const deep = await parseImageStudy(append(await plain(), [textChunk('Comment', '['.repeat(40) + '0' + ']'.repeat(40))]));
    expect(deep.metadataStatus).toBe('partial');
    const bomb = await parseImageStudy(append(await plain(), [compressed('Comment', 'a'.repeat(STUDY_PARSE_LIMITS.metadataBytes + 1))]));
    expect(bomb.metadataStatus).toBe('partial'); expect(bomb.raw['png-compressed']).toBeUndefined();
    expect((await parseImageStudy(stealth({}, true))).metadataStatus).toBe('partial');
  });
  it('rejects corrupt, unsupported and empty images', async () => {
    await expect(parseImageStudy(Buffer.alloc(0))).rejects.toMatchObject({ code: 'invalid_image' });
    await expect(parseImageStudy(Buffer.from('GIF89a'))).rejects.toMatchObject({ code: 'invalid_image' });
    await expect(parseImageStudy((await plain()).subarray(0, 35))).rejects.toMatchObject({ code: 'invalid_image' });
  });
  it('ignores checksum-damaged text while retaining valid image and other metadata', async () => {
    const bad = textChunk('Comment', '{"prompt":"bad checksum"}'); bad[bad.length - 1] ^= 1;
    const result = await parseImageStudy(append(await plain(), [textChunk('Software', 'NovelAI'), bad]));
    expect(result.metadataStatus).toBe('partial'); expect(result.raw['png-text'].Comment).toBeUndefined();
    expect(result.width).toBe(6);
  });
  it('reads JPEG and WebP EXIF parameters while preserving original source fields', async () => {
    const description = 'a ceramic mug\nNegative prompt: text\nSteps: 24, Sampler: Euler a, Seed: 45, Size: 6x4';
    for (const format of ['jpeg', 'webp'] as const) {
      const bytes = await sharp(await plain())[format]().withExif({ IFD0: { ImageDescription: description } }).toBuffer();
      const result = await parseImageStudy(bytes);
      expect(result.sources).toEqual(['exif']); expect(result.metadataKind).toBe('stable-diffusion');
      expect(result.prompts.find(field => field.key.endsWith('.positive'))?.value).toBe('a ceramic mug');
      expect(result.raw.exif.ImageDescription).toBe(description);
    }
  });
});
