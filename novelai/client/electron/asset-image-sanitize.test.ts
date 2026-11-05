import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { PNG } from 'pngjs';
import { exportImageBytes, hasKnownStealth, verifyCleanPng, pngChunkTypes } from './asset-image-sanitize';
import { parseImageStudy } from './image-study-parser';
import { plain, metadataPng, stealth, animatedPng, SECRET } from './asset-image-export-fixtures';
describe('private image export uses real decode and metadata fixtures',()=>{
  it('regression: ordinary Sharp re-encoding retains NAI alpha metadata',async()=>{
    expect(hasKnownStealth(await sharp(stealth()).png().toBuffer())).toBe(true);
  });
  it('copies original PNG bytes exactly including private fields',async()=>{const source=await metadataPng();const output=await exportImageBytes(source,false);expect(output.bytes).toEqual(source);expect(output.extension).toBe('png');expect((await parseImageStudy(output.bytes)).prompts.some(row=>row.value.includes(SECRET))).toBe(true);});
  it('strips text/compressed text/XMP while retaining raster and partial/zero alpha',async()=>{
    const source=await metadataPng(), output=await exportImageBytes(source,true);
    expect(output.extension).toBe('png');expect(output.bytes.includes(Buffer.from(SECRET))).toBe(false);
    const parsed=await parseImageStudy(output.bytes);expect(parsed.sources).toEqual([]);expect(parsed.prompts).toEqual([]);expect(parsed.parameters).toEqual([]);
    expect(PNG.sync.read(output.bytes).data).toEqual(PNG.sync.read(source).data);
    expect(pngChunkTypes(output.bytes).every(type=>['IHDR','IDAT','IEND','pHYs'].includes(type))).toBe(true);
  });
  it.each(['jpeg','webp'] as const)('decodes %s by signature, strips real EXIF/XMP and bakes orientation + ICC',async(format)=>{
    const source=await sharp(await plain()).flatten({background:'white'}).withExif({IFD0:{ImageDescription:SECRET,Artist:SECRET}}).withXmp(`<x:xmpmeta xmlns:x="adobe:ns:meta/">${SECRET}</x:xmpmeta>`).withMetadata({orientation:6}).withIccProfile('p3')[format]().toBuffer();
    const meta=await sharp(source).metadata();expect(meta.exif?.length).toBeGreaterThan(0);expect(meta.icc?.length).toBeGreaterThan(0);expect(meta.xmp?.length).toBeGreaterThan(0);
    const output=await exportImageBytes(source,true), parsed=await parseImageStudy(output.bytes), decoded=PNG.sync.read(output.bytes);
    expect([decoded.width,decoded.height]).toEqual([12,16]);expect(parsed.sources).toEqual([]);expect(output.bytes.includes(Buffer.from(SECRET))).toBe(false);
    const expected=await sharp(source).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer();expect(decoded.data).toEqual(expected);
    expect((await sharp(output.bytes).metadata()).hasAlpha).toBe(false);
  });
  it.each([false,true])('refuses known stealth even with corrupt payload=%s; never resets alpha',async(invalid)=>{
    const source=stealth(invalid);expect(hasKnownStealth(source)).toBe(true);
    await expect(exportImageBytes(source,true)).rejects.toMatchObject({reason:'stealth'});
    expect((await exportImageBytes(source,false)).bytes).toEqual(source);
  });
  it('rejects animated PNG, unsupported formats and 16-bit PNG without silently taking frame one',async()=>{
    const animation=await animatedPng();await expect(exportImageBytes(animation,true)).rejects.toMatchObject({reason:'animated'});expect((await exportImageBytes(animation,false)).bytes).toEqual(animation);
    await expect(exportImageBytes(Buffer.from('GIF89a'),true)).rejects.toMatchObject({reason:'unsupported'});
    const highDepth=await sharp(await plain()).toColourspace('rgb16').png().toBuffer();expect(highDepth[24]).toBe(16);await expect(exportImageBytes(highDepth,true)).rejects.toMatchObject({reason:'unsupported'});
  });
  it('verification fails closed on residual chunks and stealth',async()=>{
    await expect(verifyCleanPng(await metadataPng(),16,12,undefined,true)).rejects.toMatchObject({reason:'verification'});
    await expect(verifyCleanPng(stealth(),96,80,undefined,true)).rejects.toMatchObject({reason:'verification'});
  });
});
it('rejects giant dimensions before full raster allocation',async()=>{
  const {chunk}=await import('./asset-image-export-fixtures');const source=await plain(),header=Buffer.from(source.subarray(16,29));header.writeUInt32BE(16_000_001,0);header.writeUInt32BE(1,4);
  const giant=Buffer.concat([source.subarray(0,8),chunk('IHDR',header),source.subarray(33)]);
  await expect(exportImageBytes(giant,true)).rejects.toBeDefined();
});
it.each([1,2,3,4,5,6,7,8])('bakes EXIF orientation %s including mirrored cases',async(orientation)=>{
  const input=await sharp(await plain()).jpeg().withMetadata({orientation}).toBuffer();const result=await exportImageBytes(input,true);
  const decoded=PNG.sync.read(result.bytes);expect(decoded.data).toEqual(await sharp(input).rotate().ensureAlpha().raw().toBuffer());expect((await sharp(result.bytes).metadata()).orientation).toBeUndefined();
});
it('retains both frames of raw animated WebP and rejects cleaning instead of exporting frame one',async()=>{
  const data=Buffer.alloc(8*16*4);for(let n=0;n<8*16;n++){data[n*4]=n<64?255:0;data[n*4+2]=n>=64?255:0;data[n*4+3]=255;}
  const input=await sharp(data,{raw:{width:8,height:16,channels:4,pageHeight:8}}).webp({lossless:true,delay:[100,100],loop:0}).toBuffer();
  expect((await sharp(input).metadata()).pages).toBe(2);expect((await exportImageBytes(input,false)).bytes).toEqual(input);await expect(exportImageBytes(input,true)).rejects.toMatchObject({reason:'animated'});
});
it('bounds compressed PNG metadata before the decoder, and independently recognises the actual NAI fixture',async()=>{
  const {deflateSync}=await import('node:zlib'),{append,chunk}=await import('./asset-image-export-fixtures');
  const bomb=append(await plain(),[chunk('zTXt',Buffer.concat([Buffer.from('Comment\0\0'),deflateSync(Buffer.alloc(4*1024*1024+1,65))]))]);
  await expect(exportImageBytes(bomb,true)).rejects.toMatchObject({reason:'limit'});
  const parsed=await parseImageStudy(stealth());expect(parsed.sources).toEqual(['png-stealth']);expect(parsed.prompts.some(field=>field.value===SECRET)).toBe(true);
});
it.each([1,2,3,4,5,6,7,8])('checks lossless WebP source alpha before EXIF %s / ICC transformations',async(orientation)=>{
  const input=await sharp(stealth()).webp({lossless:true}).withMetadata({orientation}).withIccProfile('p3').toBuffer(),before=Buffer.from(input);
  await expect(exportImageBytes(input,true)).rejects.toMatchObject({reason:'stealth'});expect(input).toEqual(before);
});
it('shares a 4 MiB inflated PNG budget across compressed metadata types, not 4 MiB per chunk',async()=>{
  const {deflateSync}=await import('node:zlib'),{append,chunk}=await import('./asset-image-export-fixtures');
  const payload=deflateSync(Buffer.alloc(2*1024*1024,65));
  const input=append(await plain(),[
    chunk('zTXt',Buffer.concat([Buffer.from('Comment\0\0'),payload])),
    chunk('iTXt',Buffer.concat([Buffer.from('XMP\0\x01\0\0\0'),payload])),
    chunk('iCCP',Buffer.concat([Buffer.from('ICC\0\0'),payload])),
  ]);
  await expect(exportImageBytes(input,true)).rejects.toMatchObject({reason:'limit'});
});
it('bounds the independent PNG decoder Adam7 path as well as metadata inflation',async()=>{
  const {deflateSync}=await import('node:zlib'),{chunk}=await import('./asset-image-export-fixtures');
  const legitimate=await sharp(await plain()).png({progressive:true}).toBuffer();expect(legitimate[28]).toBe(1);
  expect(PNG.sync.read((await exportImageBytes(legitimate,true)).bytes).data).toEqual(PNG.sync.read(legitimate).data);
  const malicious=Buffer.concat([legitimate.subarray(0,33),chunk('IDAT',deflateSync(Buffer.alloc(2*1024*1024))),chunk('IEND',Buffer.alloc(0))]);
  await expect(exportImageBytes(malicious,true)).rejects.toMatchObject({reason:'limit'});
});
