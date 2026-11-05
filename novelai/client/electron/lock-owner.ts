import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

/**
 * Who holds a queue storage lock (the frozen queue's and the recipe store's .quota.lock and their recovery claims;
 * review rework 2026-11). A lock names its owner's pid, the time that process started and the host. A lock whose owner
 * is gone is taken over at once instead of after its 60 s lease, so a crashed or killed client no longer leaves a minute
 * of refused calls behind; a pid now used by another process (it started at another time) is gone too.
 * A lock in the older form (no start or host) or from another host keeps the lease rule: a missing process there only
 * counts once its lease ran out.
 */

/** When this process started (ms since the epoch, whole seconds as ps reports them). */
export const PROCESS_STARTED_AT = Math.floor((Date.now() - process.uptime() * 1000) / 1000) * 1000;
export const LOCK_HOST = os.hostname().slice(0, 255);
/** How far a recorded start may be from the one the system reports and still be the same process. */
const START_TOLERANCE_MS = 2500;

const BOOT_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
let bootId: string | null | undefined;
/**
 * This boot of the machine (macOS kern.bootsessionuuid, Linux /proc/sys/kernel/random/boot_id), or null when it cannot
 * be read (Windows, a sandbox). A lock from another boot names a process that is gone, whatever its pid now is.
 */
export function currentBootId(): string | null {
  if (bootId !== undefined) return bootId;
  let value: string | null = null;
  try {
    if (process.platform === 'darwin') value = execFileSync('sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    else if (process.platform === 'linux') value = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch { value = null; }
  bootId = value && BOOT_PATTERN.test(value) ? value : null;
  return bootId;
}

/** What a new lock owner records besides its own fields (boot only where it can be read). */
export const lockOwnerIdentity = () => { const boot = currentBootId(); return { startedAt: PROCESS_STARTED_AT, host: LOCK_HOST, ...(boot ? { boot } : {}) }; };
export const validLockIdentity = (owner: any) => Number.isSafeInteger(owner?.startedAt) && owner.startedAt >= 0 && typeof owner?.host === 'string' && owner.host.length > 0 && owner.host.length <= 255
  && (owner.boot === undefined || (typeof owner.boot === 'string' && BOOT_PATTERN.test(owner.boot)));

/**
 * The start time (ms since the epoch, whole seconds) of a running process, or null when it cannot be read. ps prints it
 * in UTC here (TZ=UTC) and it is read as UTC, so neither the machine's time zone nor a daylight-saving change moves it.
 */
export function processStartTime(pid: number): Promise<number | null> {
  if (process.platform === 'win32' || !Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(null);
  return new Promise(resolve => {
    execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' }, timeout: 2000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve(null);
      const text = String(stdout).trim().replace(/\s+/g, ' ');
      const at = text ? Date.parse(`${text} UTC`) : NaN;
      resolve(Number.isFinite(at) ? at : null);
    });
  });
}

export type LockOwnerLiveness = 'alive' | 'dead' | 'unknown';
/**
 * alive: the owner runs (or cannot be told apart from a running one); dead: on this host no process has its pid, or the
 * process with that pid started at another time; unknown: no process has its pid but the lock is in the older form or
 * from another host (its lease decides).
 */
export async function lockOwnerLiveness(owner: { pid: number; startedAt?: unknown; host?: unknown; boot?: unknown }, startTimeOf: (pid: number) => Promise<number | null> = processStartTime): Promise<LockOwnerLiveness> {
  let running = true;
  try { process.kill(owner.pid, 0); } catch (error: any) { running = error?.code !== 'ESRCH'; }
  const identified = validLockIdentity(owner) && owner.host === LOCK_HOST;
  // Taken before this boot of the machine: its process is gone, even if a process has that pid now.
  const boot = identified ? currentBootId() : null;
  if (identified && typeof owner.boot === 'string' && boot && owner.boot !== boot) return 'dead';
  if (!running) return identified ? 'dead' : 'unknown';
  if (!identified) return 'alive';
  const startedAt = owner.startedAt as number;
  if (owner.pid === process.pid) return Math.abs(startedAt - PROCESS_STARTED_AT) <= START_TOLERANCE_MS ? 'alive' : 'dead';
  const actual = await startTimeOf(owner.pid).catch(() => null);
  return actual === null || Math.abs(actual - startedAt) <= START_TOLERANCE_MS ? 'alive' : 'dead';
}
/** Whether a lock or claim still holds: its owner runs, or it is in the older form/another host and its lease runs. */
export async function lockStillHeld(owner: { pid: number; leaseUntil: number; startedAt?: unknown; host?: unknown; boot?: unknown }, now = Date.now(), startTimeOf?: (pid: number) => Promise<number | null>) {
  const liveness = await lockOwnerLiveness(owner, startTimeOf);
  return liveness === 'alive' || (liveness === 'unknown' && now <= owner.leaseUntil);
}
/** One acquisition's memo of start times read with ps (a retry loop never runs ps again for the same pid). */
export function memoStartTimes(read: (pid: number) => Promise<number | null> = processStartTime) {
  const known = new Map<number, Promise<number | null>>();
  return (pid: number) => { let value = known.get(pid); if (!value) { value = read(pid); known.set(pid, value); } return value; };
}
