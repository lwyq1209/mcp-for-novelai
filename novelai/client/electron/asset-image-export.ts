import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import type { LibraryRepository } from './library/repository';
import { LIBRARY_KINDS, type LibraryItemAsset } from './library/types';
import { exportImageBytes, IMAGE_EXPORT_LIMITS as limits, ImageExportError, rejectImage } from './asset-image-sanitize';
import { createPrivateExportStage } from './asset-image-publish';
import type { ImageExportRequest, ImageExportResult, ImageExportRow } from '../src/asset-library/image-export';

export const imageExportRequestSchema = {
  type: 'object', additionalProperties: false, required: ['items','stripMetadata'], properties: {
    stripMetadata: { type: 'boolean' }, items: { type: 'array', minItems: 1, maxItems: limits.items, items: {
      type: 'object', additionalProperties: false, required: ['kind','id','revision'], properties: {
        kind: { enum: [...LIBRARY_KINDS] }, id: { type: 'string', minLength: 1, maxLength: 512 }, revision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      },
    } },
  },
} as const;
const validate = new Ajv({ strict: true }).compile<ImageExportRequest>(imageExportRequestSchema);
export function parseImageExportRequest(value: unknown): ImageExportRequest {
  if (!validate(value) || new Set(value.items.map(item => JSON.stringify([item.kind,item.id]))).size !== value.items.length) throw new Error('Select 1–100 distinct items; the export arguments are invalid.');
  return structuredClone(value);
}
type Identity = ImageExportRequest['items'][number];
type FileSnapshot = { asset: LibraryItemAsset; signature?: string };
type Plan = { identity: Identity; key?: string; files: FileSnapshot[]; reason?: ImageExportRow['reason'] };
const signature = (stat: Awaited<ReturnType<typeof fs.stat>>) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const safePath = async (file: string) => {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.split(/[\\/]/).includes('..') || await fs.realpath(file) !== path.resolve(file)) rejectImage('unavailable');
};
async function sourceStat(file: string) {
  await safePath(file);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) return rejectImage('unavailable');
  if (stat.size > limits.fileBytes) return rejectImage('limit');
  return stat;
}
async function readSource(file: FileSnapshot) {
  const name = file.asset.payload.filePath;
  const before = await sourceStat(name);
  if (!file.signature || signature(before) !== file.signature) return rejectImage('unavailable');
  const handle = await fs.open(name, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (signature(await handle.stat()) !== file.signature) return rejectImage('unavailable');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes,offset,bytes.length-offset,offset);
      if (!read.bytesRead) return rejectImage('unavailable');
      offset += read.bytesRead;
    }
    if (bytes.length > limits.fileBytes || signature(await handle.stat()) !== file.signature || signature(await sourceStat(name)) !== file.signature) return rejectImage('unavailable');
    const hash = file.asset.payload.sha256;
    if (hash && (!/^[a-f0-9]{64}$/i.test(hash) || createHash('sha256').update(bytes).digest('hex') !== hash.toLowerCase())) return rejectImage('unavailable');
    return bytes;
  } finally { await handle.close(); }
}
// Bounded, sequential STORE ZIP writer: only a single source/encoded image in RAM.
// No path/title/comment/timestamp from the library enters the ZIP.
const crcTable = Array.from({ length: 256 }, (_, value) => { for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1; return value >>> 0; });
function crc32(bytes: Buffer) { let crc = 0xffffffff; for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]; return (crc ^ 0xffffffff) >>> 0; }
class ZipWriter {
  private offset = 0;
  private hash = createHash('sha256');
  private directory: Buffer[] = [];
  constructor(private handle: Awaited<ReturnType<typeof fs.open>>) {}
  private async write(bytes: Buffer) { if (this.offset + bytes.length > limits.totalBytes) rejectImage('limit'); let at = 0; while (at < bytes.length) { const result = await this.handle.write(bytes, at, bytes.length-at); if (!result.bytesWritten) throw new Error('write'); at += result.bytesWritten; } this.offset += bytes.length; this.hash.update(bytes); }
  async entry(name: string, bytes: Buffer) {
    if (!/^(?:item-\d{3}-image-\d{3}\.(?:png|jpg|webp)|report\.json)$/.test(name)) throw new Error('name');
    const encoded = Buffer.from(name), crc = crc32(bytes), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50,0); local.writeUInt16LE(20,4); local.writeUInt16LE(33,12); local.writeUInt32LE(crc,14); local.writeUInt32LE(bytes.length,18); local.writeUInt32LE(bytes.length,22); local.writeUInt16LE(encoded.length,26);
    central.writeUInt32LE(0x02014b50,0); central.writeUInt16LE(20,4); central.writeUInt16LE(20,6); central.writeUInt16LE(33,14); central.writeUInt32LE(crc,16); central.writeUInt32LE(bytes.length,20); central.writeUInt32LE(bytes.length,24); central.writeUInt16LE(encoded.length,28); central.writeUInt32LE(this.offset,42);
    this.directory.push(Buffer.concat([central,encoded]));
    await this.write(Buffer.concat([local,encoded])); await this.write(bytes);
  }
  async finish() {
    const start = this.offset;
    for (const entry of this.directory) await this.write(entry);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50,0); end.writeUInt16LE(this.directory.length,8); end.writeUInt16LE(this.directory.length,10); end.writeUInt32LE(this.offset-start,12); end.writeUInt32LE(start,16); await this.write(end); await this.handle.sync();
    return {size:this.offset,sha256:this.hash.digest('hex')};
  }
}
const result = (status: ImageExportResult['status'], stripMetadata: boolean, rows: ImageExportRow[]): ImageExportResult => ({ status, stripMetadata, rows, success: rows.filter(row=>row.status==='success').length, skipped: rows.filter(row=>row.status==='skipped').length, failed: rows.filter(row=>row.status==='failed').length });
const reasonOf = (error: unknown): ImageExportRow['reason'] => error instanceof ImageExportError ? error.reason : 'unavailable';
export function createAssetImageExporter(options: { repository: LibraryRepository; chooseDestination: () => Promise<string | undefined> }) {
  let running = false;
  const repo = options.repository;
  function resolve(identity: Identity) {
    const current = repo.get(identity.kind,identity.id);
    // Initial desktop release exports selected current revisions only. Stale/old
    // selections fail closed; never substitute new images or today's cover.
    if (!current || current.revision !== identity.revision) return rejectImage('changed');
    let assets = repo.itemAssets(identity.kind,identity.id);
    const originals = assets.filter(asset => ['original','favorite-image'].includes(asset.role));
    if (['history','study','artist_favorite'].includes(identity.kind) && originals.length) assets = originals;
    return { key: JSON.stringify([current,assets]), assets };
  }
  function unchanged(plan: Plan) { if (resolve(plan.identity).key !== plan.key) rejectImage('changed'); }
  return async (raw: unknown): Promise<ImageExportResult> => {
    const request = parseImageExportRequest(raw);
    if (running) throw new Error('An image export is already running; do not start another.');
    running = true;
    let stage: Awaited<ReturnType<typeof createPrivateExportStage>> | undefined;
    const rows: ImageExportRow[] = [];
    try {
      let imageCount = 0;
      const plans: Plan[] = [];
      for (const identity of request.items) {
        try {
          const resolved = resolve(identity);
          if (imageCount + resolved.assets.length > limits.images) rejectImage('limit');
          imageCount += resolved.assets.length;
          const files: FileSnapshot[] = [];
          for (const asset of resolved.assets) {
            let stamp: string | undefined;
            try { stamp = signature(await sourceStat(asset.payload.filePath)); } catch { /* diagnosed after confirmation */ }
            files.push({ asset: structuredClone(asset), signature: stamp });
          }
          plans.push({ identity, key: resolved.key, files });
        } catch (error) { plans.push({ identity, files: [], reason: reasonOf(error) }); }
      }
      const chosen = await options.chooseDestination();
      if (!chosen) return result('cancelled',request.stripMetadata,[]);
      // A fresh file only; even native overwrite confirmation cannot replace a source.
      if (!path.isAbsolute(chosen) || path.extname(chosen).toLowerCase() !== '.zip') throw new Error('destination');
      const parent = path.dirname(chosen), canonicalParent = await fs.realpath(parent);
      const destination = path.join(canonicalParent,path.basename(chosen));
      if (plans.some(plan=>plan.files.some(file=>path.resolve(file.asset.payload.filePath)===destination))) rejectImage('destination_exists');
      try { await fs.lstat(destination); rejectImage('destination_exists'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      const parentStamp = await fs.stat(canonicalParent);
      stage = await createPrivateExportStage(canonicalParent);
      const zip = new ZipWriter(stage.handle);
      let inputBytes = 0, outputBytes = 0;
      for (const [index,plan] of plans.entries()) {
        const item = index + 1;
        if (plan.reason) { rows.push({item,status:'failed',reason:plan.reason}); continue; }
        try { unchanged(plan); } catch { rows.push({item,status:'failed',reason:'changed'}); continue; }
        if (!plan.files.length) { rows.push({item,status:'skipped',reason:'no_image'}); continue; }
        for (const [imageIndex,file] of plan.files.entries()) {
          const image = imageIndex + 1;
          let encoded: Awaited<ReturnType<typeof exportImageBytes>>;
          try {
            unchanged(plan);
            const stat = await sourceStat(file.asset.payload.filePath);
            if (inputBytes + stat.size > limits.totalBytes) rejectImage('limit');
            inputBytes += stat.size;
            encoded = await exportImageBytes(await readSource(file),request.stripMetadata);
            if (outputBytes + encoded.bytes.length > limits.totalBytes) rejectImage('limit');
            unchanged(plan);
            if (signature(await sourceStat(file.asset.payload.filePath)) !== file.signature) rejectImage('unavailable');
          } catch (error) { rows.push({item,image,status:'failed',reason:reasonOf(error)}); continue; }
          const name = `item-${String(item).padStart(3,'0')}-image-${String(image).padStart(3,'0')}.${encoded.extension}`;
          // Any partial ZIP write is fatal, never a per-image recoverable success.
          await zip.entry(name,encoded.bytes); outputBytes += encoded.bytes.length;
          rows.push({item,image,status:'success',reason:['original','favorite-image'].includes(file.asset.role)?'original':'preview',file:name});
        }
      }
      if (!rows.some(row=>row.status==='success')) return result('failed',request.stripMetadata,rows);
      await zip.entry('report.json',Buffer.from(JSON.stringify({ mode: request.stripMetadata?'metadata-cleaned-png':'original-bytes', rows },null,2)));
      const expectedZip = await zip.finish();
      const now = await fs.stat(canonicalParent);
      if (await fs.realpath(parent) !== canonicalParent || now.dev !== parentStamp.dev || now.ino !== parentStamp.ino) throw new Error('destination');
      // Recheck after fsync as well: mutations during a long write must not publish
      // a ZIP claiming to represent a selection that has since changed.
      for (const row of rows.filter(row=>row.status==='success')) {
        const plan = plans[row.item-1], file = plan.files[row.image!-1];
        if (signature(await sourceStat(file.asset.payload.filePath)) !== file.signature) rejectImage('unavailable');
      }
      for (const row of rows.filter(row=>row.status==='success')) unchanged(plans[row.item-1]);
      // Atomic no-clobber publication on the same filesystem. No rename-overwrite.
      await stage.publish(destination,expectedZip,()=>{ for (const row of rows.filter(row=>row.status==='success')) unchanged(plans[row.item-1]); });
      return result('saved',request.stripMetadata,rows);
    } catch (error) {
      const reason = error instanceof ImageExportError ? error.reason : 'io';
      const failedRows = rows.map(row => row.status==='success' ? { item: row.item, image: row.image, status:'failed' as const, reason } : row);
      for (let item=1; item<=request.items.length; item++) if (!failedRows.some(row=>row.item===item)) failedRows.push({ item,status:'failed',reason });
      return result('failed',request.stripMetadata,failedRows);
    } finally {
      await stage?.cleanup();
      running = false;
    }
  };
}
