import fs, { type FileHandle } from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { privateModeOk } from './platform-fs';
import { IMAGE_EXPORT_LIMITS, rejectImage } from './asset-image-sanitize';

const sameObject = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a: Stats, b: Stats) => sameObject(a,b) && a.size===b.size && a.mtimeMs===b.mtimeMs && a.ctimeMs===b.ctimeMs;
const lstat = (name: string) => fs.lstat(name).catch(()=>undefined);
async function hashFile(handle: FileHandle, expectedSize: number) {
  const before = await handle.stat();
  if (!before.isFile() || before.size !== expectedSize || before.size > IMAGE_EXPORT_LIMITS.totalBytes) return rejectImage('verification');
  const hash = createHash('sha256'), buffer = Buffer.alloc(1024*1024);
  for (let offset=0; offset<before.size;) {
    const {bytesRead} = await handle.read(buffer,0,Math.min(buffer.length,before.size-offset),offset);
    if (!bytesRead) return rejectImage('verification');
    hash.update(buffer.subarray(0,bytesRead)); offset+=bytesRead;
  }
  if (!unchanged(before,await handle.stat())) return rejectImage('verification');
  return hash.digest('hex');
}

/** Private same-volume staging, held descriptor + digest, and post-publication checks.
 * No recursive cleanup and no check-then-unlink on the public destination path. */
export async function createPrivateExportStage(parent: string) {
  const parentIdentity = await fs.lstat(parent);
  if (!parentIdentity.isDirectory() || parentIdentity.isSymbolicLink()) return rejectImage('verification');
  const directory = await fs.mkdtemp(path.join(parent,'.image-export-'));
  await fs.chmod(directory,0o700);
  const directoryIdentity = await fs.lstat(directory);
  const temporary = path.join(directory,'archive.tmp');
  let handle: FileHandle;
  try { handle = await fs.open(temporary,'wx+',0o600); }
  catch (error) { await fs.rmdir(directory).catch(()=>{}); throw error; }
  const original = await handle.stat();
  async function ownDirectory() {
    const now=await lstat(directory), parentNow=await lstat(parent);
    return !!parentNow && parentNow.isDirectory() && !parentNow.isSymbolicLink() && sameObject(parentNow,parentIdentity) && !!now && now.isDirectory() && !now.isSymbolicLink() && sameObject(now,directoryIdentity) && privateModeOk(now);
  }
  /** Atomic quarantine captures the pathname BEFORE inspecting it. If a different
   * process won the rename gap, preserve/restore its inode instead of deleting it.
   * Restoration is no-clobber; if another replacement already occupies destination,
   * keep the captured foreign file in the private recovery directory, never rm -r. */
  async function rollback(destination: string, owned: Stats[]) {
    if (!await ownDirectory()) return;
    const visible=await lstat(destination);
    if (!visible || !owned.some(identity=>sameObject(identity,visible))) return;
    const quarantine=path.join(directory,`rollback-${randomUUID()}`);
    try { await fs.rename(destination,quarantine); } catch { return; }
    const captured=await lstat(quarantine);
    if (!captured) return;
    if (owned.some(identity=>sameObject(identity,captured))) { await fs.unlink(quarantine).catch(()=>{}); return; }
    // Do not overwrite a replacement and do not delete an unrelated captured file.
    try {
      await fs.link(quarantine,destination);
      const restored=await lstat(destination);
      if (restored && sameObject(restored,captured)) await fs.unlink(quarantine);
    } catch { /* preserve the quarantined foreign inode for recovery */ }
  }
  return {
    handle,
    async publish(destination: string, expected: { size: number; sha256: string }, checkSelection: () => void = () => {}) {
      if (!await ownDirectory()) return rejectImage('verification');
      if (await hashFile(handle,expected.size)!==expected.sha256) return rejectImage('verification');
      const before=await lstat(temporary);
      if (!before || !before.isFile() || !sameObject(before,original)) return rejectImage('verification');
      checkSelection();
      try { await fs.link(temporary,destination); }
      catch (error: any) { if (error.code==='EEXIST') return rejectImage('destination_exists'); throw error; }
      // fs.link is path-based: it may have linked a replacement despite the precheck.
      // Observe that source inode as well, to roll back our bad link, not a later
      // independently replaced destination. Keep the original descriptor open.
      const observedSource=await lstat(temporary);
      const owned=[original,...(observedSource?[observedSource]:[])];
      let published: FileHandle | undefined;
      try {
        published=await fs.open(destination,constants.O_RDONLY|constants.O_NOFOLLOW);
        const pinned=await published.stat();
        if (!pinned.isFile() || !sameObject(pinned,original) || !observedSource || !sameObject(observedSource,original)) return rejectImage('verification');
        if (await hashFile(published,expected.size)!==expected.sha256) return rejectImage('verification');
        const visible=await lstat(destination), sourceNow=await lstat(temporary);
        if (!visible || !unchanged(visible,await published.stat()) || !sourceNow || !sameObject(sourceNow,original) || !await ownDirectory()) return rejectImage('verification');
        checkSelection();
      } catch (error) {
        // Keep even an unexpected published inode pinned through rollback, so
        // unlink/recreate cannot recycle its identity into a foreign file.
        await rollback(destination,owned);
        throw error;
      } finally { await published?.close().catch(()=>{}); }
    },
    async cleanup() {
      await handle.close().catch(()=>{});
      if (await ownDirectory()) {
        await fs.unlink(temporary).catch(()=>{});
        // Only remove an empty private directory. Never discard foreign recovery data.
        await fs.rmdir(directory).catch(()=>{});
      }
    },
  };
}
