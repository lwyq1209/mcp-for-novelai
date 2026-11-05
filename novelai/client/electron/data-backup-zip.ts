import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { Readable } from 'node:stream';
import { openNoFollow } from './platform-fs';
import { hostError, type HostErrorParams } from './host-error';

const unzipper:any=require('unzipper');
const MAX_ARCHIVE_BYTES=16*1024*1024*1024;
const MAX_ENTRY_BYTES=256*1024*1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES=16*1024*1024*1024;
const MAX_ENTRIES=100_000;
const CHUNK_BYTES=8*1024*1024;
/** A backup ZIP this reader refuses (backup_invalid_archive) or could not read through (backup_read_failed), with the case as its reason. */
const invalid=(reason:string,message:string,params?:HostErrorParams)=>hostError('backup_invalid_archive',message,`backup_zip.${reason}`,params);
const unreadable=(reason:string,message:string)=>hostError('backup_read_failed',message,`backup_zip.${reason}`);

export interface ReadableBackupZipEntry {
  name:string;
  dir:boolean;
  async(type:'nodebuffer'):Promise<Buffer>;
  async(type:'string'|'base64'):Promise<string>;
}
export interface ReadableBackupZip {
  files:Record<string,ReadableBackupZipEntry>;
  file(name:string):ReadableBackupZipEntry|null;
  readonly sourcePath:string;
  readonly sourceSize:number;
  readonly sourceSha256:string;
  copyTo(file:string):Promise<void>;
  close():Promise<void>;
}

function rangeStream(handle:fs.FileHandle,sourceSize:number,start:number,length?:number){
  if(!Number.isSafeInteger(start)||start<0||start>sourceSize||length!==undefined&&(!Number.isSafeInteger(length)||length<0))throw invalid('invalid_range','The backup ZIP requested an invalid read range.');
  let position=start,active=false;
  const end=Math.min(sourceSize,!length?sourceSize:start+length+1);
  return new Readable({
    read(requested){
      if(active)return;
      const wanted=Math.min(Math.max(1,requested),CHUNK_BYTES,end-position);
      if(wanted<=0){this.push(null);return;}
      active=true;
      const buffer=Buffer.allocUnsafe(wanted),at=position;
      handle.read(buffer,0,wanted,at).then(result=>{
        active=false;
        if(result.bytesRead!==wanted){this.destroy(unreadable('range_truncated','The backup file was truncated during a range read.'));return;}
        position+=wanted;this.push(buffer);
      },error=>{active=false;this.destroy(error);});
    },
  });
}
async function hashHandle(handle:fs.FileHandle,size:number){
  const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(CHUNK_BYTES);let position=0;
  while(position<size){const wanted=Math.min(buffer.length,size-position),result=await handle.read(buffer,0,wanted,position);if(!result.bytesRead)throw unreadable('truncated','The backup file was truncated while it was read.');hash.update(buffer.subarray(0,result.bytesRead));position+=result.bytesRead;}
  return hash.digest('hex');
}
async function streamEntry(raw:any,collect:boolean){
  if(!Number.isSafeInteger(raw.uncompressedSize)||raw.uncompressedSize<0||raw.uncompressedSize>MAX_ENTRY_BYTES)throw invalid('entry_too_large',`The backup entry ${raw.path} exceeds the per-entry read limit.`,{name:raw.path});
  let checksum=0,total=0;const chunks:Buffer[]=[];
  for await(const value of raw.stream()){
    const chunk=Buffer.isBuffer(value)?value:Buffer.from(value);total+=chunk.length;
    if(total>raw.uncompressedSize||total>MAX_ENTRY_BYTES)throw invalid('entry_size_invalid',`The uncompressed size of the backup entry ${raw.path} is invalid.`,{name:raw.path});
    checksum=crc32(chunk,checksum);
    if(collect)chunks.push(chunk);
  }
  if(total!==raw.uncompressedSize||(checksum>>>0)!==(Number(raw.crc32)>>>0))throw invalid('entry_crc_failed',`The CRC-32 check of the backup entry ${raw.path} failed.`,{name:raw.path});
  return collect?Buffer.concat(chunks,total):Buffer.alloc(0);
}

export async function openBackupZip(file:string):Promise<ReadableBackupZip>{
  const sourcePath=await fs.realpath(file),handle=await openNoFollow(sourcePath,constants.O_RDONLY|constants.O_NOFOLLOW);let closed=false;
  try{
    const stat=await handle.stat();
    if(!stat.isFile()||stat.size<=0||stat.size>MAX_ARCHIVE_BYTES||!Number.isSafeInteger(stat.size))throw invalid('file_size_invalid','The backup file is empty or exceeds the 16 GiB read limit.');
    const source={size:async()=>stat.size,stream:(offset:number,length?:number)=>rangeStream(handle,stat.size,offset,length)};
    // A file that is not a ZIP (no central directory) is an invalid backup, not a parser message (FILE_ENDED and the like).
    let directory:any;
    try{directory=await unzipper.Open.custom(source,{tailSize:Math.min(stat.size,65_557)});}
    catch{throw invalid('not_zip','The file is not a readable backup ZIP.');}
    const rawFiles:any[]=directory.files;
    if(!Array.isArray(rawFiles)||rawFiles.length>MAX_ENTRIES)throw invalid('entry_count_invalid','The number of backup ZIP entries is invalid.');
    const files:Record<string,ReadableBackupZipEntry>={},seen=new Set<string>();let totalUncompressed=0;
    for(const raw of rawFiles){
      if(typeof raw.path!=='string'||!raw.path||seen.has(raw.path))throw invalid('entry_invalid','The backup ZIP has an invalid or duplicate entry.');
      seen.add(raw.path);
      if(!Number.isSafeInteger(raw.uncompressedSize)||raw.uncompressedSize<0||(totalUncompressed+=raw.uncompressedSize)>MAX_TOTAL_UNCOMPRESSED_BYTES)throw invalid('total_too_large','The uncompressed total of the backup ZIP exceeds the 16 GiB limit.');
      const dir=raw.type==='Directory';
      files[raw.path]={name:raw.path,dir,async:async(type:'nodebuffer'|'string'|'base64')=>{if(dir)throw invalid('entry_is_directory',`The backup entry ${raw.path} is a directory.`,{name:raw.path});const bytes=await streamEntry(raw,true);return type==='nodebuffer'?bytes:bytes.toString(type==='base64'?'base64':'utf8');}} as ReadableBackupZipEntry;
    }
    for(const raw of rawFiles)if(raw.type!=='Directory')await streamEntry(raw,false);
    const sourceSha256=await hashHandle(handle,stat.size);
    return{
      files,file:name=>files[name]??null,sourcePath,sourceSize:stat.size,sourceSha256,
      async copyTo(target:string){
        const output=await fs.open(target,'wx',0o600),hash=createHash('sha256'),buffer=Buffer.allocUnsafe(CHUNK_BYTES);let position=0;
        let failure:unknown;
        try{
          while(position<stat.size){const wanted=Math.min(buffer.length,stat.size-position),result=await handle.read(buffer,0,wanted,position);if(!result.bytesRead)throw unreadable('staging_truncated','The backup file was truncated while it was staged.');const chunk=buffer.subarray(0,result.bytesRead);hash.update(chunk);let written=0;while(written<chunk.length){const result=await output.write(chunk,written,chunk.length-written,position+written);if(!result.bytesWritten)throw unreadable('staging_stalled','Writing the staged backup made no progress.');written+=result.bytesWritten;}position+=chunk.length;}
          await output.sync();
          if(position!==stat.size||hash.digest('hex')!==sourceSha256)throw unreadable('changed','The backup file changed between verification and staging.');
        }catch(error){failure=error;}
        finally{await output.close();}
        if(failure){await fs.unlink(target).catch(()=>{});throw failure;}
      },
      async close(){if(!closed){closed=true;await handle.close();}},
    };
  }catch(error){await handle.close().catch(()=>{});throw error;}
}
