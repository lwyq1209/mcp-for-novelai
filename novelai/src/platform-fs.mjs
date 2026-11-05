// Windows filesystem compatibility helpers shared by novelai/src and novelai/pi.
// Keep behavior identical to novelai/client/electron/platform-fs.ts; both run
// the vectors in novelai/tests/fixtures/platform-fs-vectors.json.
// Every non-win32 branch is the exact operation the call sites used before.
import { constants } from 'node:fs';
import { open, lstat, rename } from 'node:fs/promises';

/** Backoff before each retry of an overwriting rename on win32 (sum 200 ms). */
export const RENAME_RETRY_DELAYS_MS = Object.freeze([10, 20, 40, 60, 70]);
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

const refused = code => Object.assign(new Error(code === 'ELOOP'
  ? 'Refusing to open a symbolic link or a file replaced while opening.'
  : 'Refusing to open a non-regular file.'), { code });

// Forward through the live ESM bindings so a patched node:fs/promises (tests use
// syncBuiltinESMExports) is observed exactly as by a direct import at the call site.
const liveIo = { open: (...args) => open(...args), lstat: (...args) => lstat(...args), rename: (...args) => rename(...args) };

export function createPlatformFs({ platform = process.platform, io = liveIo, sleep = ms => new Promise(done => setTimeout(done, ms)) } = {}) {
  const win32 = platform === 'win32';
  /**
   * Flush a directory entry. Windows refuses FlushFileBuffers on directory
   * handles (EPERM); NTFS journals its metadata, so win32 skips the flush.
   */
  async function syncDirectory(directory) {
    if (win32) return;
    const handle = await io.open(directory, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  /**
   * Read-only open that never follows a symbolic link. POSIX uses the caller's
   * own flags (O_NOFOLLOW, optionally O_NONBLOCK). win32 has neither flag, so
   * it lstat-s first, refuses links and non-regular files, and verifies the
   * opened handle is the same file (dev/ino) as the lstat-ed entry.
   */
  async function openNoFollow(file, posixFlags) {
    if (!win32) return io.open(file, posixFlags);
    const entry = await io.lstat(file, { bigint: true });
    if (entry.isSymbolicLink()) throw refused('ELOOP');
    if (!entry.isFile()) throw refused('EINVAL');
    const handle = await io.open(file, constants.O_RDONLY);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino) throw refused('ELOOP');
      return handle;
    } catch (error) { await handle.close().catch(() => {}); throw error; }
  }
  /** POSIX private mode (no group/other bits). win32 does not report ACLs as mode bits. */
  function privateModeOk(stat) {
    if (win32) return true;
    return (stat.mode & 0o077) === 0;
  }
  /**
   * Overwriting rename. On win32 a destination briefly held open by another
   * reader fails with EPERM/EBUSY/EACCES; retry a bounded number of times.
   */
  async function renameReplace(source, destination) {
    if (!win32) return io.rename(source, destination);
    for (let attempt = 0; ; attempt++) {
      try { return await io.rename(source, destination); }
      catch (error) {
        if (!RENAME_RETRY_CODES.has(error?.code) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error;
        await sleep(RENAME_RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  return { syncDirectory, openNoFollow, privateModeOk, renameReplace };
}

export const { syncDirectory, openNoFollow, privateModeOk, renameReplace } = createPlatformFs();
