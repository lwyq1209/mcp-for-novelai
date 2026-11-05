import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import type { LibraryRepository } from './library/repository';
import { LIBRARY_KINDS, knownCollectionNamespace, type LibrarySnapshot, type PendingFileOperation } from './library/types';
import { validateLibraryPayload } from './library/validation';
import type { ReadableBackupZip } from './data-backup-zip';
import { readMaterialCoverMetadata } from './material-covers';
import { hostError, type HostErrorParams } from './host-error';
import { errorText, hostMessage, type HostDetail } from './host-message';

const MANIFEST = 'library/manifest.json';
const MAX_MANIFEST = 128 * 1024 * 1024;
const MAX_ASSET = 256 * 1024 * 1024;
const MAX_TOTAL = 2 * 1024 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
/** Refuses the archive: code library_archive_invalid with the case as its reason (library_archive.<reason>). */
const fail: (reason: string, message: string, params?: HostErrorParams) => never = (reason, message, params) => { throw hostError('library_archive_invalid', message, `library_archive.${reason}`, params); };
/** The archive manifest as JSON; text that is not JSON is an invalid manifest (not a parser message). */
const manifestJson = (bytes: Buffer): unknown => { try { return JSON.parse(bytes.toString('utf8')); } catch { return fail('manifest_invalid', 'The material archive manifest is invalid.'); } };
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = (kind: string, id: string) => JSON.stringify([kind, id]);
const absoluteSource = (file: string) => path.posix.isAbsolute(file) || path.win32.isAbsolute(file);
const sourceKey = (file: string) => /^[a-z]:[\\/]|^\\\\/i.test(file) ? path.win32.normalize(file) : path.posix.normalize(file);
const extension = (file: string) => /\.(png|jpe?g|webp|gif|avif|bmp)$/i.exec(file)?.[0].toLowerCase() ?? '.bin';
const mediaUrl = (file: string) => `nai-local://file/${encodeURIComponent(pathToFileURL(file).toString())}`;
type Destination = { area: 'media'; extension: string } | { area: 'cover'; name: string } | { area: 'study'; id: string; name: string };
interface ArchiveFile { sourcePath: string; destination: Destination; sha256: string | null; byteLength: number; reason?: string }
interface ArchiveManifest { format: 'novelai-library-archive'; schemaVersion: 1; snapshot: LibrarySnapshot; files: ArchiveFile[] }
export interface LibraryArchiveOptions {
  repository: LibraryRepository;
  libraryDirectory: string;
  userDataRoot: string;
  /** Current configured output roots, when generated images live outside userData. */
  assetRoots?: string[];
  includeAssets?: boolean;
  /** Test-only: a smaller per-archive image byte budget than the 2 GiB default (backup side only). */
  maxTotalBytes?: number;
  toFileUrl?: (file: string) => string;
}
export interface LibraryArchiveSummary { items: number; versions: number; assets: number; missing: number; warnings: string[] }
export interface LibraryArchiveInspection { present: boolean; missing: number; warnings: string[] }
/** warnings are English; warningDetails are the same warnings as host texts the window renders in its language. */
export interface LibraryRestoreSummary { present: boolean; imported: number; conflicts: number; assets: number; missing: number; warnings: string[]; warningDetails: HostDetail[] }

function portableSnapshot(repo: LibraryRepository): LibrarySnapshot {
  const snapshot = structuredClone(repo.exportSnapshot());
  // These are local execution state, not authored library data or instructions to replay.
  snapshot.fileOperations = [];
  snapshot.collections = snapshot.collections.filter(value => knownCollectionNamespace(value.namespace));
  snapshot.memberships = snapshot.memberships.filter(value => knownCollectionNamespace(value.namespace));
  return snapshot;
}

function referencedFiles(snapshot: LibrarySnapshot, libraryDirectory: string) {
  const files = new Map<string, { sourcePath: string; destination: Destination; expectedHash?: string }>();
  const add = (file: unknown, destination: Destination, expectedHash?: unknown) => {
    if (typeof file !== 'string' || !path.isAbsolute(file)) return;
    const sourcePath = path.resolve(file);
    files.set(`${sourcePath}\0${JSON.stringify(destination)}`, {sourcePath, destination, ...(typeof expectedHash === 'string' && HASH.test(expectedHash) ? {expectedHash} : {})});
  };
  const image = (value: unknown) => { if (object(value)) add(value.filePath ?? value.path, {area:'media',extension:extension(value.filePath ?? value.path ?? '')}, value.sha256); };
  for (const item of snapshot.items) {
    const payload = item.payload;
    image(payload); image(payload.image);
    for (const value of [...(Array.isArray(payload.previewImages) ? payload.previewImages : []), ...(Array.isArray(payload.images) ? payload.images : [])]) image(value);
    if (item.kind === 'study') {
      if (!UUID.test(item.id)) fail('study_identity_invalid', 'A study identity cannot be turned into a controlled original path.');
      const suffix = ({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'} as Record<string,string>)[payload.study?.mimeType as string];
      if (!suffix) fail('study_format_invalid', 'A study original has an invalid format.');
      for (const [name, hash] of [[`original.${suffix}`,payload.study.sha256],['preview.webp',payload.previewSha256]]) add(path.join(libraryDirectory,'studies',item.id,name),{area:'study',id:item.id,name},hash);
    }
  }
  for (const asset of snapshot.assets) image(asset.payload);
  for (const {cover} of snapshot.covers) if (cover && HASH.test(cover.sha256)) add(path.join(libraryDirectory,'covers',`${cover.sha256}.webp`),{area:'cover',name:`${cover.sha256}.webp`},cover.sha256);
  return [...files.values()];
}

async function boundedRead(file: string, roots: string[]) {
  const resolved = await fs.realpath(file);
  if (!roots.some(root => resolved.startsWith(`${root}${path.sep}`))) fail('image_outside_roots', 'A linked image is outside the current controlled material or output directories.');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ASSET) fail('image_size_invalid', 'A linked image is empty or larger than 256 MiB.');
    const bytes = Buffer.alloc(stat.size + 1); let position = 0;
    while (position < bytes.length) { const result = await handle.read(bytes,position,bytes.length-position,null); if (!result.bytesRead) break; position += result.bytesRead; }
    if (position !== stat.size) fail('image_changed', 'A linked image changed during the backup.');
    return bytes.subarray(0,position);
  } finally { await handle.close(); }
}

/** Bytes of the distinct image files the library references (stat only; unreadable files count 0). */
export async function libraryAssetBytes(options: { repository: LibraryRepository; libraryDirectory: string }): Promise<number> {
  const seen = new Set<string>(); let total = 0;
  for (const file of referencedFiles(portableSnapshot(options.repository), options.libraryDirectory)) {
    if (seen.has(file.sourcePath)) continue; seen.add(file.sourcePath);
    try { const stat = await fs.stat(file.sourcePath); if (stat.isFile()) total += stat.size; } catch { /* missing files add nothing */ }
  }
  return total;
}

/** Adds only the library snapshot and explicitly referenced image bytes to an existing backup ZIP. */
export async function appendLibraryArchive(zip: JSZip, options: LibraryArchiveOptions): Promise<LibraryArchiveSummary> {
  const snapshot = portableSnapshot(options.repository), files: ArchiveFile[] = [], warnings: string[] = [];
  const roots: string[] = [];
  for (const directory of [options.libraryDirectory,options.userDataRoot,...(options.assetRoots ?? [])]) {
    try { if (!(await fs.lstat(directory)).isSymbolicLink()) roots.push(await fs.realpath(directory)); } catch { /* Missing roots produce explicit per-file warnings below. */ }
  }
  const hashes = new Set<string>(); let total = 0;
  // When the byte budget cannot hold every image, spend it first on tag covers and studies,
  // then everything else. Order within each tier is unchanged.
  const tier = (file: {sourcePath:string; destination:Destination}) => file.destination.area === 'cover' || file.destination.area === 'study' ? 0 : 1;
  const ordered = referencedFiles(snapshot,options.libraryDirectory).map((file,index)=>({file,index})).sort((a,b)=>tier(a.file)-tier(b.file)||a.index-b.index).map(value=>value.file);
  const skipped = new Map<string,string[]>();
  for (const file of ordered) {
    try {
      if (options.includeAssets === false) throw new Error('This backup does not include image bytes.');
      const bytes = await boundedRead(file.sourcePath,roots), sha256 = digest(bytes);
      if (file.expectedHash && file.expectedHash !== sha256) throw new Error('A linked image does not match its saved SHA-256.');
      if (!hashes.has(sha256)) {
        if (total + bytes.length > Math.min(MAX_TOTAL, options.maxTotalBytes ?? MAX_TOTAL)) throw new Error('Linked images exceed the 2 GiB limit of this archive.');
        total += bytes.length; hashes.add(sha256); zip.file(`library/blobs/${sha256}`,bytes,{binary:true,compression:'STORE'});
      }
      files.push({sourcePath:file.sourcePath,destination:file.destination,sha256,byteLength:bytes.length});
    } catch (error) {
      // File-system errors carry the full path; keep reasons path-free so they group and never leak paths.
      const code = (error as {code?: unknown})?.code;
      const reason = code === 'ENOENT' ? 'The linked image does not exist.' : typeof code === 'string' && /^E[A-Z]+$/.test(code) ? `The linked image cannot be read (${code}).` : error instanceof Error ? error.message : 'The linked image cannot be read.';
      files.push({sourcePath:file.sourcePath,destination:file.destination,sha256:null,byteLength:0,reason});
      const names = skipped.get(reason) ?? []; names.push(path.basename(file.sourcePath)); skipped.set(reason,names);
    }
  }
  // One warning per reason: a lightweight backup of a large library would otherwise emit one
  // line per image and exceed the backup manifest's 10000-warning limit on read-back.
  for (const [reason,names] of skipped) warnings.push(names.length === 1 ? `${names[0]}: ${reason}` : `${names.length} linked images: ${reason} (for example ${names.slice(0,3).join(', ')})`);
  const manifest: ArchiveManifest = {format:'novelai-library-archive',schemaVersion:1,snapshot,files};
  const data = JSON.stringify(manifest);
  if (Buffer.byteLength(data) > MAX_MANIFEST) fail('manifest_too_large', 'The material versions and relations exceed 128 MiB; no incomplete snapshot was made.');
  zip.file(MANIFEST,data);
  return {items:new Set(snapshot.items.map(item=>identity(item.kind,item.id))).size,versions:snapshot.items.length,assets:hashes.size,missing:files.filter(file=>!file.sha256).length,warnings};
}

async function zipBytes(zip: JSZip|ReadableBackupZip, name: string, maximum: number): Promise<Buffer> {
  const entry = zip.file(name);
  if (!entry || entry.dir) fail('entry_missing', `The archive is missing ${name}.`, { name });
  if(!('nodeStream' in entry)){
    const bytes=await entry.async('nodebuffer');
    if(bytes.length>maximum)fail('entry_too_large', 'An archive entry exceeds the limit once uncompressed.');
    return bytes;
  }
  return new Promise((resolve,reject)=> {
    let length = 0, done = false; const chunks: Buffer[] = [];
    const stream = entry.nodeStream('nodebuffer') as Readable;
    stream.on('data',(data: Buffer)=>{ if (done) return; length += data.length; if (length > maximum) { stream.destroy(hostError('library_archive_invalid', 'An archive entry exceeds the limit once uncompressed.', 'library_archive.entry_too_large')); return; } chunks.push(data); });
    stream.on('error',(error: Error)=>{ if (!done) { done = true; reject(error); } });
    stream.on('end',()=>{ if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    stream.resume();
  });
}

function checkedManifest(value: unknown): ArchiveManifest {
  if (!object(value) || value.format !== 'novelai-library-archive' || value.schemaVersion !== 1 || !object(value.snapshot) || !Array.isArray(value.files) || value.files.length > 100000) fail('manifest_invalid', 'The material archive manifest is invalid.');
  const snapshot = value.snapshot as LibrarySnapshot;
  for (const field of ['items','collections','memberships','relations','assets','assetLinks','covers'] as const) if (!Array.isArray(snapshot[field])) fail('snapshot_incomplete', 'The material archive is missing its version or relation lists.');
  if (snapshot.schemaVersion !== 1 || snapshot.items.length > 100000) fail('version_invalid', 'The material archive version is invalid.');
  const versions = new Set<string>();
  for (const item of snapshot.items) {
    if (!object(item) || !LIBRARY_KINDS.includes(item.kind) || typeof item.id !== 'string' || !item.id || !Number.isSafeInteger(item.revision) || item.revision < 1 || item.schemaVersion !== 1 || typeof item.name !== 'string' || typeof item.archived !== 'boolean' || typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string' || !object(item.source) || typeof item.source.namespace !== 'string') fail('item_invalid', 'The material archive has an unsupported or damaged item.');
    validateLibraryPayload(item.kind,item.payload);
    const key = JSON.stringify([item.kind,item.id,item.revision]); if (versions.has(key)) fail('duplicate_version', 'The material archive has a duplicate version.'); versions.add(key);
  }
  const keys = new Set<string>();
  for (const file of value.files as ArchiveFile[]) {
    if (!object(file) || typeof file.sourcePath !== 'string' || !absoluteSource(file.sourcePath) || !object(file.destination) || !Number.isSafeInteger(file.byteLength) || file.byteLength < 0 || file.byteLength > MAX_ASSET || (file.sha256 !== null && (typeof file.sha256 !== 'string' || !HASH.test(file.sha256)))) fail('files_invalid', 'The material archive file list is invalid.');
    const target = file.destination;
    if (target.area === 'media' ? !/^\.(png|jpe?g|webp|gif|avif|bmp|bin)$/.test(target.extension) : target.area === 'cover' ? !/^[a-f0-9]{64}\.webp$/.test(target.name) || (file.sha256 !== null && target.name !== `${file.sha256}.webp`) : target.area === 'study' ? !UUID.test(target.id) || !/^(original\.(png|jpg|webp)|preview\.webp)$/.test(target.name) : true) fail('target_invalid', 'A target path of the material archive is invalid.');
    const key = `${file.sourcePath}\0${JSON.stringify(target)}`; if (keys.has(key)) fail('files_duplicate', 'The material archive file list has duplicates.'); keys.add(key);
  }
  // Fields and collection namespaces this version does not know are ignored (left out of the import).
  snapshot.fileOperations = [];
  snapshot.collections = snapshot.collections.filter(item=>knownCollectionNamespace(item?.namespace));
  snapshot.memberships = snapshot.memberships.filter(item=>knownCollectionNamespace(item?.namespace));
  const sources = new Set((value.files as ArchiveFile[]).map(file=>sourceKey(file.sourcePath)));
  const checkPaths = (payload: Record<string,any>) => {
    for (const image of [payload,payload.image,...(Array.isArray(payload.previewImages)?payload.previewImages:[]),...(Array.isArray(payload.images)?payload.images:[])]) if (object(image)) {
      for (const key of ['filePath','path']) if (typeof image[key] === 'string' && image[key] && (!absoluteSource(image[key]) || !sources.has(sourceKey(image[key])))) fail('reference_unlisted', 'A material reference has no controlled file entry.');
    }
  };
  for (const item of snapshot.items) {
    checkPaths(item.payload);
    if (item.kind === 'study') {
      for (const [name,hash] of [['preview.webp',item.payload.previewSha256],[`original.${({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'} as Record<string,string>)[item.payload.study.mimeType]}`,item.payload.study.sha256]]) {
        if (!value.files.some((file:ArchiveFile)=>file.destination.area === 'study' && file.destination.id === item.id && file.destination.name === name && (file.sha256 === null || file.sha256 === hash))) fail('study_unlisted', 'A study original or preview has no matching file entry.');
      }
    }
  }
  for (const asset of snapshot.assets) { if (!object(asset) || !object(asset.payload)) fail('assets_invalid', 'The material asset list is invalid.'); checkPaths(asset.payload); }
  // Covers are checked as the library reads them, so a cover this version would refuse to show is refused here, before anything is imported.
  for (const entry of snapshot.covers) {
    if (!object(entry) || typeof entry.id !== 'string' || !LIBRARY_KINDS.includes(entry.kind)) fail('covers_invalid', 'The cover list of the material archive is invalid.');
    if (entry.cover === null) continue;
    if (object(entry.cover) && entry.cover.source !== 'local' && !Object.hasOwn(entry.cover, 'rating')) fail('cover_rating_missing', `The Danbooru cover of tag ${entry.id} in the material archive has no rating; this version does not support such cover records.`, { id: entry.id });
    try { readMaterialCoverMetadata(entry.cover); } catch (error: any) { fail('cover_unsupported', `This version does not support the cover record of tag ${entry.id} in the material archive: ${errorText(error, 'invalid format')}`, { id: entry.id, detail: errorText(error, 'invalid format') }); }
  }
  for (const {cover} of snapshot.covers) if (cover && HASH.test(cover.sha256) && !value.files.some((file:ArchiveFile)=>file.destination.area === 'cover' && file.destination.name === `${cover.sha256}.webp`)) fail('cover_unlisted', 'A cover has no matching file entry.');
  return value as unknown as ArchiveManifest;
}

/** Validates the embedded library manifest and every declared blob without
 * publishing files or SQL. This is used by backup inspection so a forged
 * top-level complete flag cannot hide missing or corrupt library content. */
export async function inspectLibraryArchive(zip: JSZip|ReadableBackupZip): Promise<LibraryArchiveInspection> {
  if (!zip.file(MANIFEST)) return {present:false,missing:0,warnings:[]};
  const manifest = checkedManifest(manifestJson(await zipBytes(zip,MANIFEST,MAX_MANIFEST)));
  const blobs = new Map<string,number>(); let total = 0;
  for (const file of manifest.files) {
    if (!file.sha256) continue;
    const previous = blobs.get(file.sha256);
    if (previous !== undefined) { if (previous !== file.byteLength) fail('blob_size_conflict', 'The same image checksum has different sizes.'); continue; }
    const bytes = await zipBytes(zip,`library/blobs/${file.sha256}`,Math.min(MAX_ASSET,MAX_TOTAL-total));
    if (bytes.length !== file.byteLength || digest(bytes) !== file.sha256) fail('blob_checksum_failed', 'The size or SHA-256 check of a material archive image failed.');
    total += bytes.length; blobs.set(file.sha256,bytes.length);
  }
  const missing = manifest.files.filter(file=>!file.sha256).length;
  return {present:true,missing,warnings:manifest.files.filter(file=>!file.sha256).map(file=>file.reason ?? 'The linked image cannot be read.')};
}

function targetFile(file: ArchiveFile, options: LibraryArchiveOptions) {
  const target = file.destination;
  if (target.area === 'study') return path.join(options.libraryDirectory,'studies',target.id,target.name);
  if (target.area === 'cover') return path.join(options.libraryDirectory,'covers',target.name);
  return path.join(options.userDataRoot,'library-media',`${file.sha256 ?? `missing-${digest(file.sourcePath)}`}${target.extension}`);
}
function relocatePayload(payload: Record<string, any>, locations: Map<string,string>, toFileUrl: (file:string)=>string) {
  const image = (value: unknown) => {
    if (!object(value)) return;
    for (const key of ['filePath','path']) if (typeof value[key] === 'string' && locations.has(sourceKey(value[key]))) {
      value[key] = locations.get(sourceKey(value[key]))!;
      if (key === 'filePath' || typeof value.fileUrl === 'string') value.fileUrl = toFileUrl(value[key]);
    }
  };
  image(payload); image(payload.image);
  for (const entry of [...(Array.isArray(payload.previewImages)?payload.previewImages:[]),...(Array.isArray(payload.images)?payload.images:[])]) image(entry);
}

async function ensureDirectory(directory: string, root: string) {
  const absoluteRoot = path.resolve(root), absolute = path.resolve(directory);
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${path.sep}`)) fail('restore_outside_root', 'A restore directory is outside the current material root.');
  await fs.mkdir(absoluteRoot,{recursive:true,mode:0o700});
  if ((await fs.lstat(absoluteRoot)).isSymbolicLink()) fail('restore_root_symlink', 'The restore root cannot be a symbolic link.');
  let current = absoluteRoot;
  for (const segment of path.relative(absoluteRoot,absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current,segment);
    await fs.mkdir(current,{mode:0o700}).catch(error=>{if(error.code !== 'EEXIST') throw error;});
    const stat = await fs.lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('restore_path_unsafe', 'A restore directory has an unsafe path.');
  }
}

/** Merges absent identities only. Existing items and their complete revision histories remain untouched. */
export async function restoreLibraryArchive(zip: JSZip|ReadableBackupZip, options: LibraryArchiveOptions): Promise<LibraryRestoreSummary> {
  if (!zip.file(MANIFEST)) return {present:false,imported:0,conflicts:0,assets:0,missing:0,warnings:[],warningDetails:[]};
  const manifest = checkedManifest(manifestJson(await zipBytes(zip,MANIFEST,MAX_MANIFEST)));
  const snapshot = manifest.snapshot, existing = options.repository.exportSnapshot(), warningDetails: HostDetail[] = [];
  const warn = (detail: HostDetail) => { warningDetails.push(detail); };
  const conflicts = new Set<string>(), accepted = new Set<string>(), existingItems = new Set(existing.items.map(item=>identity(item.kind,item.id)));
  // An identity in Recently Deleted counts as existing: its newer state is restored from there, never shadowed by an older backup copy.
  const deleted = new Set<string>(); for (const kind of LIBRARY_KINDS) for (const id of options.repository.trashedIds(kind)) deleted.add(identity(kind,id));
  let inTrash = 0;
  for (const item of snapshot.items) { const key = identity(item.kind,item.id); if (existingItems.has(key)) conflicts.add(key); else if (deleted.has(key)) { if (!conflicts.has(key)) inTrash++; conflicts.add(key); } else accepted.add(key); }
  const existingAssets = new Map(existing.assets.map(asset=>[asset.id,asset]));
  for (const link of snapshot.assetLinks) if (accepted.has(identity(link.kind,link.id)) && existingAssets.has(link.assetId)) {
    const incoming = snapshot.assets.find(asset=>asset.id === link.assetId);
    if (JSON.stringify(incoming) !== JSON.stringify(existingAssets.get(link.assetId))) { const key = identity(link.kind,link.id); accepted.delete(key); conflicts.add(key); }
  }
  if (conflicts.size) warn(hostMessage('backup_warning', `${conflicts.size} identities already exist or have conflicting linked assets; local content and versions are kept in full.`, 'library_archive.conflicts', { count: conflicts.size }));
  if (inTrash) warn(hostMessage('backup_warning', `${inTrash} of them are in Recently Deleted and were not imported from the backup; restore them from Recently Deleted when needed.`, 'library_archive.in_trash', { count: inTrash }));
  const locations = new Map<string,string>(), blobs = new Map<string,Buffer>(); let total = 0;
  for (const file of manifest.files) {
    const target = targetFile(file,options), source = sourceKey(file.sourcePath);
    const old = locations.get(source);
    // A study/cover path is more specific than a generic asset-table path for the same bytes.
    if (!old || file.destination.area !== 'media') locations.set(source,target);
    if (file.sha256 && !blobs.has(file.sha256)) {
      const bytes = await zipBytes(zip,`library/blobs/${file.sha256}`,Math.min(MAX_ASSET,MAX_TOTAL-total));
      if (bytes.length !== file.byteLength || digest(bytes) !== file.sha256) fail('blob_checksum_failed', 'The size or SHA-256 check of a material archive image failed.');
      total += bytes.length; blobs.set(file.sha256,bytes);
    }
    if (file.sha256 && blobs.get(file.sha256)!.length !== file.byteLength) fail('blob_size_conflict', 'The same image checksum has different sizes.');
  }
  const owns = (value:{kind:string;id:string})=>accepted.has(identity(value.kind,value.id));
  const incoming: LibrarySnapshot = {
    schemaVersion:snapshot.schemaVersion,items:snapshot.items.filter(owns),
    collections:snapshot.collections.filter(value=>!existing.collections.some(old=>old.namespace === value.namespace && old.id === value.id)),
    memberships:snapshot.memberships.filter(owns),relations:snapshot.relations.filter(owns),
    assets:snapshot.assets.filter(value=>!existingAssets.has(value.id)),assetLinks:snapshot.assetLinks.filter(owns),
    covers:snapshot.covers.filter(owns),fileOperations:[],
  };
  const toFileUrl = options.toFileUrl ?? mediaUrl;
  for (const item of incoming.items) { relocatePayload(item.payload,locations,toFileUrl); }
  const relocatedAssetIds=new Map<string,string>();
  for (const asset of incoming.assets) {
    const originalPath=typeof asset.payload.filePath==='string'?asset.payload.filePath:null;
    relocatePayload(asset.payload,locations,toFileUrl);
    if(originalPath&&asset.id===`path:${digest(originalPath)}`&&typeof asset.payload.filePath==='string'&&asset.payload.filePath!==originalPath){const nextId=`path:${digest(asset.payload.filePath)}`;relocatedAssetIds.set(asset.id,nextId);asset.id=nextId;}
    if (typeof asset.payload.filePath === 'string' && manifest.files.some(file=>!file.sha256 && locations.get(sourceKey(file.sourcePath)) === asset.payload.filePath)) asset.payload.availability = 'missing';
  }
  for(const link of incoming.assetLinks)if(relocatedAssetIds.has(link.assetId))link.assetId=relocatedAssetIds.get(link.assetId)!;
  const relevant = referencedFiles(incoming,options.libraryDirectory);
  const wanted = new Set(relevant.map(file=>path.resolve(file.sourcePath)));
  const journal = new Map<string,PendingFileOperation>(); let restored = 0;
  try {
    for (const file of manifest.files) {
      const target = targetFile(file,options);
      if (!file.sha256 || !wanted.has(target)) continue;
      const bytes = blobs.get(file.sha256)!;
      await ensureDirectory(path.dirname(target),file.destination.area === 'media' ? options.userDataRoot : options.libraryDirectory);
      const journalId = `archive-restore:${digest(target)}:${file.sha256}`;
      const previous = options.repository.pendingFileOps().find(value=>value.id === journalId);
      if (previous && (previous.payload.scope !== 'library-archive-restore' || previous.payload.target !== target || previous.payload.sha256 !== file.sha256 || typeof previous.payload.temporary !== 'string' || path.dirname(previous.payload.temporary) !== path.dirname(target) || !path.basename(previous.payload.temporary).startsWith('.archive-'))) fail('restore_journal_mismatch', 'The archive restore journal does not match the current target.');
      const temporary = previous?.payload.temporary ?? path.join(path.dirname(target),`.archive-${randomUUID()}.pending`);
      const operation: PendingFileOperation = {id:journalId,action:'create',state:'pending',createdAt:previous?.createdAt ?? new Date().toISOString(),payload:{scope:'library-archive-restore',target,temporary,sha256:file.sha256,byteLength:bytes.length}};
      options.repository.putFileOperation(operation); journal.set(journalId,operation);
      // Only a temporary file already owned by this exact durable journal can be replaced after interruption.
      const flags = constants.O_WRONLY|constants.O_CREAT|constants.O_NOFOLLOW|(previous ? constants.O_TRUNC : constants.O_EXCL);
      const handle = await fs.open(temporary,flags,0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      try { await fs.link(temporary,target); restored++; }
      catch(error:any) {
        if (error.code !== 'EEXIST') throw error;
        const local = await boundedRead(target,[await fs.realpath(options.libraryDirectory).catch(()=>''),await fs.realpath(options.userDataRoot)]);
        if (digest(local) !== file.sha256) fail('restore_target_differs', 'The restore target already has a different image; the local file was not overwritten.');
      }
      await fs.unlink(temporary);
    }
    options.repository.importSnapshot(incoming,{requireEmpty:false});
    // A previous crash may have happened after the SQL commit; matching journal cleanup is idempotent.
    for (const operation of options.repository.pendingFileOps()) if (operation.payload.scope === 'library-archive-restore' && manifest.files.some(file=>file.sha256 === operation.payload.sha256 && targetFile(file,options) === operation.payload.target)) options.repository.completeFileOperation(operation.id);
  } catch(error) {
    for (const operation of journal.values()) options.repository.putFileOperation({...operation,state:'failed',error:error instanceof Error?error.message:'Library restore interrupted.'});
    const detail = error instanceof Error ? error.message : '';
    throw hostError('library_archive_restore_failed', `The material restore did not complete; the controlled staging and restore journal were kept, and the same archive can be retried.${detail ? ` ${detail}` : ''}`, 'library_archive.restore_failed', { detail });
  }
  const missing = manifest.files.filter(file=>!file.sha256).length;
  if (missing) warn(hostMessage('backup_warning', `${missing} original(s) or preview(s) are unavailable in the archive; their metadata is kept and marked missing.`, 'library_archive.assets_missing', { count: missing }));
  return {present:true,imported:accepted.size,conflicts:conflicts.size,assets:restored,missing,warnings:warningDetails.map(detail=>detail.message),warningDetails};
}
