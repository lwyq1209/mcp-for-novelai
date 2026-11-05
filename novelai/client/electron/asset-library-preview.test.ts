import {afterEach,describe,expect,it,vi} from 'vitest';
import { runCleanupsSync } from '../src/test-support/temp-dirs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {LibraryItem,LibraryItemAsset} from './library/types';

const state=vi.hoisted(()=>({active:0,maximum:0,calls:0}));
vi.mock('sharp',()=>({default:()=>{
  const pipeline={rotate:()=>pipeline,resize:()=>pipeline,webp:()=>pipeline,toBuffer:async()=>{
    state.calls++;state.active++;state.maximum=Math.max(state.maximum,state.active);
    await new Promise(resolve=>setTimeout(resolve,5));state.active--;return Buffer.from('derived-webp-fixture');
  }};return pipeline;
}}));
import {createAssetThumbnailCache} from './asset-library-preview';
const roots:string[]=[];
afterEach(()=>{state.active=0;state.maximum=0;state.calls=0;runCleanupsSync(roots.splice(0).map(root=>()=>fs.rmSync(root,{recursive:true,force:true})));});
describe('visible asset thumbnail work limits',()=>{
 it('deduplicates matching requests and limits actual decoders to two without touching source bytes',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nai-preview-cache-'));roots.push(root);
  const file=path.join(root,'source.png');fs.writeFileSync(file,'original fixture bytes');
  const assets:LibraryItemAsset[]=Array.from({length:8},(_,index)=>({id:`asset:${index}`,role:'original',payload:{filePath:file,sha256:String(index)}}));
  const item={kind:'history',id:'h',revision:1} as LibraryItem;
  const thumbnail=createAssetThumbnailCache();
  const results=await Promise.all([...assets,assets[0],assets[0]].map(asset=>thumbnail(item,asset)));
  expect(results.every(result=>result.status==='ready')).toBe(true);
  expect(state.maximum).toBe(2);expect(state.calls).toBe(8);
  await thumbnail(item,assets[0]);expect(state.calls).toBe(8);
  fs.writeFileSync(file,'updated original fixture bytes');await thumbnail(item,assets[0]);expect(state.calls).toBe(9);
  expect(fs.readFileSync(file,'utf8')).toBe('updated original fixture bytes');
 });
});
