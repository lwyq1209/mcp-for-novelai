import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import type { LibraryItem, LibraryItemAsset } from './library/types';
import type { AssetPreview, AssetThumbnail } from '../src/generated/library-contracts.mjs' with { 'resolution-mode': 'import' };

export function describeAssetPreview(item: Pick<LibraryItem,'kind'|'id'|'revision'>, asset: LibraryItemAsset): AssetPreview {
  const {mimeType,width,height}=asset.payload;
  return {
    assetId:asset.id,role:asset.role,
    cacheKey:createHash('sha256').update(JSON.stringify([item.kind,item.id,item.revision,asset.id,asset.payload])).digest('hex'),
    ...(typeof mimeType==='string'?{mimeType}:{}),...(Number.isFinite(width)?{width}:{}),...(Number.isFinite(height)?{height}:{}),
  };
}

/** Decode only requested visible images. This derived cache never changes originals. */
export function createAssetThumbnailCache() {
  const cache=new Map<string,{signature:string;result:AssetThumbnail;bytes:number}>();
  const pending=new Map<string,Promise<AssetThumbnail>>();
  const waiting:Array<()=>void>=[];
  let active=0,totalBytes=0;
  const maxBytes=16*1024*1024,maxEntries=128;
  async function slot<T>(work:()=>Promise<T>):Promise<T>{
    if(active>=2) await new Promise<void>(resolve=>waiting.push(resolve));
    else active++;
    try{return await work();}finally{const next=waiting.shift();if(next)next();else active--;}
  }
  return async function thumbnail(item:LibraryItem,asset:LibraryItemAsset):Promise<AssetThumbnail>{
    const {cacheKey}=describeAssetPreview(item,asset);
    const running=pending.get(cacheKey);if(running)return running;
    const request=slot(async()=>{
      try{
        const stat=await fs.stat(asset.payload.filePath);
        if(!stat.isFile()||stat.size>256*1024*1024)throw new Error('unavailable');
        const signature=`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        const found=cache.get(cacheKey);
        if(found?.signature===signature){cache.delete(cacheKey);cache.set(cacheKey,found);return found.result;}
        if(found){cache.delete(cacheKey);totalBytes-=found.bytes;}
        const buffer=await sharp(asset.payload.filePath,{limitInputPixels:100_000_000}).rotate().resize({width:384,height:384,fit:'inside',withoutEnlargement:true}).webp({quality:76}).toBuffer();
        const result:AssetThumbnail={status:'ready',cacheKey,dataUrl:`data:image/webp;base64,${buffer.toString('base64')}`};
        const bytes=Buffer.byteLength(result.dataUrl!);
        cache.set(cacheKey,{signature,result,bytes});totalBytes+=bytes;
        while(cache.size>maxEntries||totalBytes>maxBytes){const key=cache.keys().next().value!;totalBytes-=cache.get(key)!.bytes;cache.delete(key);}
        return result;
      }catch{return {status:'unavailable',cacheKey,message:'The image file is missing or unreadable; the item record is kept.'} satisfies AssetThumbnail;}
    });
    pending.set(cacheKey,request);
    try{return await request;}finally{pending.delete(cacheKey);}
  };
}
