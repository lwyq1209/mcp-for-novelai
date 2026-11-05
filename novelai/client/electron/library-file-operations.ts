import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { constants } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { LibraryRepository } from './library/repository';
import type { LibraryKind, PendingFileOperation } from './library/types';
import { validateLibraryPayload } from './library/validation';

export function beginLibraryFileOperation(repo: LibraryRepository, action: PendingFileOperation['action'], payload: Record<string, any>) {
  const id = randomUUID(); repo.putFileOperation({ id, action, state: 'pending', payload, createdAt: new Date().toISOString() }); return id;
}
export function fileReferencedElsewhere(repo: LibraryRepository, kind: LibraryKind, id: string, filePath: string) {
  const assets = new Set(repo.assets().filter(value => typeof value.payload.filePath === 'string' && path.resolve(value.payload.filePath) === path.resolve(filePath)).map(value => value.id));
  return repo.assetLinks().some(link => assets.has(link.assetId) && (link.kind !== kind || link.id !== id)) || repo.relations({ targetKind: kind, targetId: id }).some(link => link.kind !== kind || link.id !== id)
    // A Recently Deleted entry that left this file in place restores it from here.
    || [...repo.fileOwners([filePath]).get(filePath) ?? []].some(owner => owner.startsWith('trash:'));
}

async function statOrMissing(file: string) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('文件操作路径无效。');
  try { return await fs.lstat(file); }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
}

async function verifyCreatedFile(value: Record<string, any>) {
  if (typeof value.target !== 'string' || !path.isAbsolute(value.target) || !Number.isSafeInteger(value.byteLength) || value.byteLength < 1 || value.byteLength > 50 * 1024 * 1024 || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('新文件恢复记录无效。');
  const handle = await fs.open(value.target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== value.byteLength) throw new Error('已保存文件大小不匹配。');
    const bytes = await handle.readFile();
    if (bytes.length !== value.byteLength || createHash('sha256').update(bytes).digest('hex') !== value.sha256) throw new Error('已保存文件摘要不匹配。');
  } finally { await handle.close(); }
}

/** Finish only previously journaled local file operations; never submit a provider request. */
export async function recoverLibraryFileOperations(repo: LibraryRepository) {
  for (const operation of repo.pendingFileOps()) {
    if (operation.state === 'failed') continue;
    // Recently Deleted journals belong to library-trash.ts, which recovers them itself.
    if (operation.payload?.scope === 'trash') continue;
    const value = operation.payload;
    try {
      if (!['history','study','reference_preset'].includes(value.kind) || typeof value.id !== 'string' || !value.id) throw new Error('不支持的文件恢复记录，已保留供核对。');
      if (operation.action === 'create') {
        validateLibraryPayload(value.kind, value.item);
        const itemId = value.kind === 'study' ? value.item.study.id : value.item.id;
        if (itemId !== value.id) throw new Error('文件恢复条目身份不匹配。');
        const files = value.files ?? [value];
        if (!Array.isArray(files) || files.length < 1 || files.length > 64) throw new Error('文件恢复清单无效。');
        if (value.kind !== 'study' && !files.some(file => file.target === value.item.filePath)) throw new Error('文件恢复清单与素材原图路径不匹配。');
        if (value.kind === 'study') {
          const extension: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
          const original = files.find(file => typeof file.target === 'string' && path.basename(file.target) === `original.${extension[value.item.study.mimeType]}` && path.basename(path.dirname(file.target)) === value.id);
          const preview = files.find(file => typeof file.target === 'string' && path.basename(file.target) === 'preview.webp' && path.dirname(file.target) === path.dirname(original?.target ?? ''));
          if (!original || !preview || original.sha256 !== value.item.study.sha256 || original.byteLength !== value.item.study.byteLength || preview.sha256 !== value.item.previewSha256 || preview.byteLength !== value.item.previewByteLength) throw new Error('研读原图或预览清单与记录不匹配。');
        }
        for (const file of files) await verifyCreatedFile(file);
        const expectedRevision = value.expectedRevision ?? 0, current = repo.get(value.kind, value.id);
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('文件恢复版本无效。');
        if (value.source !== undefined && (!value.source || typeof value.source !== 'object' || typeof value.source.namespace !== 'string' || !value.source.namespace || (value.source.legacyId !== undefined && (typeof value.source.legacyId !== 'string' || !value.source.legacyId)))) throw new Error('文件恢复来源无效。');
        if (!current || !isDeepStrictEqual(current.payload, value.item) || (value.source !== undefined && !isDeepStrictEqual(current.source, value.source))) {
          if ((current?.revision ?? 0) !== expectedRevision) throw new Error('素材已有较新的修改，未覆盖当前记录。');
          repo.put(value.kind, value.id, value.item, { expectedRevision, ...(value.source !== undefined ? { source: value.source } : {}) });
        }
      } else if (operation.action === 'rename') {
        const target = await statOrMissing(value.target), original = await statOrMissing(value.original);
        const item = repo.get(value.kind, value.id);
        if (!item || ![value.original,value.target].includes(item.payload.filePath)) throw new Error('素材路径已修改，未覆盖当前记录。');
        if (original?.isFile() && !original.isSymbolicLink() && !target && item.payload.filePath === value.original) { repo.completeFileOperation(operation.id); continue; }
        if (!target?.isFile() || target.isSymbolicLink() || original) throw new Error('重命名状态无法确定，已保留原记录。');
        if (item.payload.filePath === value.original) {
          if (fileReferencedElsewhere(repo, value.kind, value.id, value.original)) throw new Error('原路径仍被其他素材引用，重命名需要核对。');
          repo.put(value.kind, value.id, { ...item.payload, filePath: value.target, fileUrl: value.fileUrl }, { expectedRevision: item.revision });
        }
      } else if (operation.action === 'delete') {
        // A surviving original means unlink did not complete. Do not delete on startup.
        if (await statOrMissing(value.original)) { repo.completeFileOperation(operation.id); continue; }
        const item = repo.get(value.kind, value.id);
        if (item) {
          if (item.payload.filePath !== value.original) throw new Error('素材路径已修改，未删除当前记录。');
          if (fileReferencedElsewhere(repo, value.kind, value.id, value.original)) throw new Error('图片仍被其他素材引用，已保留原记录。');
          repo.remove(value.kind, value.id, { expectedRevision: item.revision });
        }
      } else throw new Error('不支持的文件操作，已保留供核对。');
      repo.completeFileOperation(operation.id);
    } catch (failure) {
      repo.putFileOperation({ ...operation, state: 'failed', error: failure instanceof Error ? failure.message : '文件操作需人工核对。' });
    }
  }
}
