import { afterEach, describe, expect, it } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { crc32 } from 'node:zlib';
import JSZip from 'jszip';
import { openBackupZip } from './data-backup-zip';

const roots:string[]=[];
async function temporaryFile(name:string){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'data-backup-zip-test-'));
  roots.push(root);
  return path.join(root,name);
}
afterEach(()=>runCleanups(roots.splice(0).map(root=>()=>fs.rm(root,{recursive:true,force:true}))));

function localHeader(name:Buffer,crc:number,size:number){
  const value=Buffer.alloc(30+name.length);
  value.writeUInt32LE(0x04034b50,0);value.writeUInt16LE(20,4);value.writeUInt16LE(0,6);value.writeUInt16LE(0,8);
  value.writeUInt32LE(crc>>>0,14);value.writeUInt32LE(size,18);value.writeUInt32LE(size,22);value.writeUInt16LE(name.length,26);name.copy(value,30);
  return value;
}
function centralHeader(name:Buffer,crc:number,size:number,offset:number){
  const value=Buffer.alloc(46+name.length);
  value.writeUInt32LE(0x02014b50,0);value.writeUInt16LE(20,4);value.writeUInt16LE(20,6);value.writeUInt16LE(0,8);value.writeUInt16LE(0,10);
  value.writeUInt32LE(crc>>>0,16);value.writeUInt32LE(size,20);value.writeUInt32LE(size,24);value.writeUInt16LE(name.length,28);value.writeUInt32LE(offset,42);name.copy(value,46);
  return value;
}
async function writeLargeSparseZip(file:string){
  const handle=await fs.open(file,'wx',0o600),records:Array<{name:Buffer;crc:number;size:number;offset:number}>=[];
  let position=0;
  const fillerSize=240*1024*1024,zero=Buffer.alloc(8*1024*1024);let zeroCrc=0;
  for(let remaining=fillerSize;remaining;remaining-=zero.length)zeroCrc=crc32(zero,zeroCrc);
  try{
    for(let index=0;index<9;index++){
      const name=Buffer.from(`padding/${index}.bin`),offset=position,header=localHeader(name,zeroCrc,fillerSize);
      await handle.write(header,0,header.length,position);position+=header.length+fillerSize;
      records.push({name,crc:zeroCrc,size:fillerSize,offset});
    }
    const tail=Buffer.from('{"format":"large-reader-fixture","ok":true}'),name=Buffer.from('tail/manifest.json'),offset=position,tailCrc=crc32(tail),header=localHeader(name,tailCrc,tail.length),tailDataOffset=offset+header.length;
    await handle.write(header,0,header.length,position);position+=header.length;await handle.write(tail,0,tail.length,position);position+=tail.length;
    records.push({name,crc:tailCrc,size:tail.length,offset});
    const centralOffset=position;
    expect(offset).toBeGreaterThan(0x7fffffff);
    for(const record of records){const central=centralHeader(record.name,record.crc,record.size,record.offset);await handle.write(central,0,central.length,position);position+=central.length;}
    const centralSize=position-centralOffset,eocd=Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50,0);eocd.writeUInt16LE(records.length,8);eocd.writeUInt16LE(records.length,10);eocd.writeUInt32LE(centralSize,12);eocd.writeUInt32LE(centralOffset,16);
    await handle.write(eocd,0,eocd.length,position);position+=eocd.length;await handle.truncate(position);await handle.sync();
    return{size:position,tailOffset:offset,tailDataOffset};
  }finally{await handle.close();}
}

describe('large backup ZIP reader',()=>{
  it('reads ordinary archives and rejects a payload whose CRC no longer matches',async()=>{
    const zip=new JSZip();zip.file('manifest.json','{"ok":true}',{compression:'STORE'});
    const bytes=await zip.generateAsync({type:'nodebuffer'}),good=await temporaryFile('good.naisbackup');await fs.writeFile(good,bytes);
    const opened=await openBackupZip(good),copy=path.join(path.dirname(good),'staged.naisbackup');
    try{expect(await opened.file('manifest.json')!.async('string')).toBe('{"ok":true}');expect(opened.sourceSha256).toMatch(/^[a-f0-9]{64}$/);await opened.copyTo(copy);expect(await fs.readFile(copy)).toEqual(bytes);}finally{await opened.close();}
    const bad=await temporaryFile('bad.naisbackup'),corrupt=Buffer.from(bytes),nameLength=corrupt.readUInt16LE(26),extraLength=corrupt.readUInt16LE(28);
    corrupt[30+nameLength+extraLength]^=0xff;await fs.writeFile(bad,corrupt);
    await expect(openBackupZip(bad)).rejects.toThrow(/CRC/i);
  });

  it.runIf(process.env.NAI_LARGE_BACKUP_READER_TEST==='1')('reads a real sparse ZIP whose archive and tail entry offset cross 2 GiB',async()=>{
    const file=await temporaryFile('large.naisbackup'),fixture=await writeLargeSparseZip(file);
    expect(fixture.size).toBeGreaterThan(0x80000000);expect(fixture.tailOffset).toBeGreaterThan(0x7fffffff);
    const opened=await openBackupZip(file);
    try{expect(opened.sourceSize).toBe(fixture.size);expect(JSON.parse(await opened.file('tail/manifest.json')!.async('string'))).toEqual({format:'large-reader-fixture',ok:true});}finally{await opened.close();}
    const corrupt=await temporaryFile('large-corrupt.naisbackup');await fs.copyFile(file,corrupt);const handle=await fs.open(corrupt,'r+');
    try{const byte=Buffer.alloc(1);await handle.read(byte,0,1,fixture.tailDataOffset);byte[0]^=0xff;await handle.write(byte,0,1,fixture.tailDataOffset);}finally{await handle.close();}
    await expect(openBackupZip(corrupt)).rejects.toThrow(/CRC/i);
  },120_000);
});
