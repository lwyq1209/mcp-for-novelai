// Synthetic SFW fixtures only; no user files or network.
import sharp from 'sharp';
import { PNG } from 'pngjs';
import { gzipSync, deflateSync } from 'node:zlib';
export const SECRET = 'PRIVATE_FIXTURE_ceramic_mug_seed_123_author_example';
export function chunk(type: string, data: Buffer) {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type,4);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([Buffer.from(type),data])) { crc ^= byte; for (let bit=0;bit<8;bit++) crc=(crc>>>1)^(0xedb88320 & -(crc & 1)); }
  const tail=Buffer.alloc(4); tail.writeUInt32BE((crc^0xffffffff)>>>0);
  return Buffer.concat([head,data,tail]);
}
export const append = (image: Buffer, chunks: Buffer[]) => Buffer.concat([image.subarray(0,-12),...chunks,image.subarray(-12)]);
export async function plain() {
  const image = new PNG({ width: 16,height: 12 });
  for (let n=0;n<image.width*image.height;n++) { image.data[n*4]=n%256; image.data[n*4+1]=120; image.data[n*4+2]=50; image.data[n*4+3]=n%3===0?0:n%3===1?128:255; }
  return PNG.sync.write(image);
}
export async function metadataPng() {
  return append(await plain(),[
    chunk('tEXt',Buffer.from(`Comment\0{"prompt":"${SECRET}","seed":123}`)),
    chunk('zTXt',Buffer.concat([Buffer.from('Description\0\0'),deflateSync(Buffer.from(SECRET))])),
    chunk('iTXt',Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\0\0\0\0'),Buffer.from(SECRET)])),
  ]);
}
export function stealth(invalid = false, magic = 'stealth_pngcomp') {
  const width=96,height=80,image=new PNG({width,height}); image.data.fill(255);
  const payload=invalid?Buffer.from('broken'):gzipSync(Buffer.from(JSON.stringify({Software:'NovelAI',Comment:{prompt:SECRET}}))), size=Buffer.alloc(4);size.writeUInt32BE(payload.length*8);
  const bits=Buffer.concat([Buffer.from(magic),size,payload]);
  for(let n=0;n<bits.length*8;n++){const x=Math.floor(n/height),y=n%height;image.data[(y*width+x)*4+3]=254|((bits[n>>3]>>(7-(n&7)))&1);}
  return PNG.sync.write(image);
}
export async function animatedPng() {
  const first=await sharp({create:{width:3,height:2,channels:4,background:'red'}}).png().toBuffer();
  const second=await sharp({create:{width:3,height:2,channels:4,background:'blue'}}).png().toBuffer();
  const idats=(png:Buffer)=>{const chunks:Buffer[]=[];let at=8;while(at+12<=png.length){const size=png.readUInt32BE(at);if(png.toString('ascii',at+4,at+8)==='IDAT')chunks.push(png.subarray(at+8,at+8+size));at+=size+12;}return Buffer.concat(chunks);};
  const actl=Buffer.alloc(8);actl.writeUInt32BE(2);
  const frame=(n:number)=>{const data=Buffer.alloc(26);data.writeUInt32BE(n);data.writeUInt32BE(3,4);data.writeUInt32BE(2,8);data.writeUInt16BE(1,20);data.writeUInt16BE(10,22);return chunk('fcTL',data);};
  const sequence=Buffer.alloc(4);sequence.writeUInt32BE(2);
  return Buffer.concat([first.subarray(0,33),chunk('acTL',actl),frame(0),chunk('IDAT',idats(first)),frame(1),chunk('fdAT',Buffer.concat([sequence,idats(second)])),chunk('IEND',Buffer.alloc(0))]);
}
