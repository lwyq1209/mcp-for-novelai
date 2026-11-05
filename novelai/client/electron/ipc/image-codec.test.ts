import {describe,it,expect} from "vitest";
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import {processableImage,validateImage,isWebp,nativeImageInput,webpDimensions,ImageConversionError} from "./image-codec";

describe('WebP processing boundary',()=>{
  for (const name of ['lossy','lossless','alpha','animated']) it(`decodes ${name} WebP to a complete static PNG`,async()=>{
    const input=fs.readFileSync(path.resolve('shared/image-input-fixtures',name+'.webp'));
    const before=Buffer.from(input),output=await processableImage(input);
    const meta=await sharp(output).metadata();
    expect(meta.format).toBe('png');expect([meta.width,meta.height]).toEqual([96,64]);
    expect(await validateImage(input)).toMatchObject({width:96,height:64,extension:'webp'});
    expect(input).toEqual(before);expect(isWebp(output)).toBe(false);
    if(name==='alpha') expect((await sharp(output).stats()).isOpaque).toBe(false);
  });
  it('rejects corrupt WebP and preserves already processable bytes',async()=>{
    const corrupt=Buffer.from('RIFF0000WEBPinvalid');
    await expect(processableImage(corrupt)).rejects.toThrow();
    await expect(validateImage(corrupt)).rejects.toThrow();
    const png=await sharp({create:{width:2,height:2,channels:4,background:'white'}}).png().toBuffer();
    expect(await processableImage(png)).toBe(png);
  });
});

// Issue #2 review P2-1: Electron nativeImage decodes PNG and JPEG only; recipe sources reach it through nativeImageInput.
describe('nativeImage decoder input',()=>{
  it('turns every WebP fixture into a PNG with the stored size and pixels; PNG and JPEG pass through as the same object',async()=>{
    for (const name of ['lossy','lossless','alpha','animated']) {
      const input=fs.readFileSync(path.resolve('shared/image-input-fixtures',name+'.webp')),before=Buffer.from(input);
      const output=await nativeImageInput(input),meta=await sharp(output).metadata();
      expect([meta.format,meta.width,meta.height]).toEqual(['png',96,64]);expect(input).toEqual(before);
      expect(webpDimensions(input)).toEqual({width:96,height:64});
      if(name==='lossless') expect(await sharp(output).raw().toBuffer()).toEqual(await sharp(input).raw().toBuffer());
    }
    const png=await sharp({create:{width:3,height:2,channels:4,background:'white'}}).png().toBuffer(),jpeg=await sharp(png).jpeg().toBuffer();
    expect(await nativeImageInput(png)).toBe(png);expect(await nativeImageInput(jpeg)).toBe(jpeg);
    expect(webpDimensions(png)).toBeNull();
  });
  it('keeps the stored orientation (no EXIF rotation) and refuses an unreadable WebP with source_conversion_failed',async()=>{
    const rotated=await sharp({create:{width:40,height:20,channels:3,background:'#123456'}}).webp().withMetadata({orientation:6}).toBuffer();
    expect((await sharp(await nativeImageInput(rotated)).metadata())).toMatchObject({width:40,height:20});
    expect(webpDimensions(rotated)).toEqual({width:40,height:20});
    const lossy=await sharp({create:{width:300,height:200,channels:3,background:'#654321'}}).webp().toBuffer();
    expect(webpDimensions(lossy)).toEqual({width:300,height:200});
    const broken=Buffer.concat([lossy.subarray(0,40),Buffer.alloc(200,9)]);
    await expect(nativeImageInput(broken)).rejects.toBeInstanceOf(ImageConversionError);
    await expect(nativeImageInput(broken)).rejects.toMatchObject({code:'source_conversion_failed'});
    expect(webpDimensions(Buffer.from('RIFF0000WEBPinvalid'))).toBeNull();
  });
});
