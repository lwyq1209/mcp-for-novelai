import { lockOwnerIdentity, lockStillHeld, memoStartTimes, validLockIdentity } from './lock-owner';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openNoFollow, renameReplace, syncDirectory as syncDirectoryEntry } from './platform-fs';
import type { BatchJob, BatchRequest } from '../src/workspace/batch-types';
import type { GenerationSnapshot } from '../src/workspace/generation-types';
import { isSystemMetadataFile, isSystemMetadataName } from './system-metadata-files';

export interface FrozenBatchInput {
  schemaVersion: 1;
  batchId: string;
  sequence: number;
  request: BatchRequest;
  fingerprint: string;
  payloadHash: string;
  snapshots: GenerationSnapshot[];
  initial: BatchJob;
}
/** Terminal MCP batch whose snapshots were dropped and whose state history was
 * trimmed to the current revision. State files keep `inputHash` =
 * `compaction.originalDigest`; the input itself is bound by `compactedHash`. */
export interface FrozenBatchCompaction {
  compactedAt: string;
  originalDigest: string;
  snapshotCount: number;
  snapshotBytes: number;
  historyFrom: number;
  historyAnchor: string | null;
}
export interface CompactedFrozenBatchInput {
  schemaVersion: 2;
  batchId: string;
  sequence: number;
  request: BatchRequest;
  fingerprint: string;
  payloadHash: string;
  initial: BatchJob;
  compaction: FrozenBatchCompaction;
  compactedHash: string;
}
export type StoredFrozenBatchInput = FrozenBatchInput | CompactedFrozenBatchInput;
export interface FrozenBatchRecord { input: StoredFrozenBatchInput; job: BatchJob }
/** Last scanned usage, adjusted for this instance's own later writes. */
export interface FrozenQueueCapacity { batches: number; batchLimit: number; bytes: number; byteLimit: number; reserve: number }
export type FrozenBatchCompactionResult =
  | { status: 'compacted'; compactedAt: string; reclaimedBytes: number; removedHistoryFiles: number }
  | { status: 'already_compacted'; compactedAt: string }
  | { status: 'not_eligible'; reason: 'unknown_batch' | 'not_terminal' | 'not_mcp' | 'no_finish_time' | 'no_gain'; eligibleAt?: undefined }
  | { status: 'not_eligible'; reason: 'grace_period'; eligibleAt: number };
/** purge(): the batches whose files are gone, the bytes freed, and those whose removal a busy file deferred (they are
 * hidden from now on and removed by the next locked operation or start). */
export interface FrozenBatchPurgeResult { removed: string[]; reclaimedBytes: number; deferred: string[] }
export interface BatchStorage {
  load(): Promise<FrozenBatchRecord[]>;
  /** Allocates and returns the durable FIFO sequence while holding the global lock. */
  create(input: FrozenBatchInput): Promise<number>;
  save(batchId: string, job: BatchJob): Promise<void>;
  /** Drops snapshots and old state history of one eligible terminal MCP batch. */
  compact?(batchId: string, options?: { now?: number }): Promise<FrozenBatchCompactionResult>;
  /** Removes ended batches with all their files (queue retention). Each one must be stored ended, exactly as this
   * instance last read or wrote it; a transaction marker lists them first, so a crash is rolled forward. */
  purge?(batchIds: string[]): Promise<FrozenBatchPurgeResult>;
  capacity?(): FrozenQueueCapacity | null;
}
export class BatchStorageError extends Error {
  code = 'queue_storage_error';
  /** `entry`: the folder entry (relative to the data root) this app does not use, when that is the whole problem. */
  constructor(message = 'The frozen queue files are invalid or cannot be written safely; new submissions are stopped. Keep the files and check the storage.', public entry?: string) { super(message); }
}
/** An explicit, recoverable refusal: nothing was written and the store stays usable. */
export class BatchQuotaError extends Error {
  code = 'queue_storage_full';
  constructor(public reason: 'batches' | 'bytes') { super(reason === 'batches' ? 'The frozen queue holds its maximum number of batches; nothing was written.' : 'The frozen queue storage is full (including the room kept for running batches); nothing was written.'); }
}
/** The new batch's own input failed validation before anything was written. Unlike damage found on
 * disk (BatchStorageError), it is refused alone and the store stays usable. */
export class BatchInputError extends Error {
  code = 'queue_input_invalid';
  constructor() { super('The frozen input failed its self-check (snapshot, checksum or structure); nothing was written and the storage is unaffected.'); }
}
/** A compaction step hit a file another process holds open (still busy after the bounded win32
 * retries). Nothing is damaged and the store stays usable; the transaction marker stays for the next
 * locked operation. `published: false` — the input replacement itself was refused, so nothing changed
 * and recovery just drops the marker; `published: true` — the compacted input is in place and only the
 * removal of superseded files is pending, which recovery rolls forward. */
export class BatchCompactionDeferredError extends Error {
  code = 'queue_compaction_deferred';
  constructor(public batchId: string, public compactedAt: string, public cause: unknown, public published: boolean) {
    super(published ? `The frozen queue compaction was published, but removing superseded files is blocked (${(cause as any)?.code ?? 'unknown'}); the transaction marker stays and the next locked operation finishes it.` : `The frozen input is in use (${(cause as any)?.code ?? 'unknown'}); the compaction was not published and nothing changed. It is retried later.`);
  }
}
/** Codes a file briefly held open by another process (indexer, antivirus, backup) reports on unlink. */
const BUSY_UNLINK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const deferrableCleanup = (error: unknown) => BUSY_UNLINK_CODES.has((error as any)?.code);
/** Backoff before each retry of a busy compaction unlink on win32 (sum 200 ms). Shorter than renameReplace's: a
 * cleanup that stays busy is deferred and rolled forward later, it never stops the queue. */
export const COMPACTION_UNLINK_DELAYS_MS: readonly number[] = Object.freeze([10, 20, 40, 60, 70]);
/** Removal of a file compaction no longer needs. On win32 a busy file is retried with a short bounded backoff;
 * elsewhere the operation is the plain unlink. A missing file is already gone. */
export function createCompactionUnlink({ platform = process.platform as string, unlink = (file: string) => fs.unlink(file), sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms)), retry = true }: { platform?: string; unlink?: (file: string) => Promise<void>; sleep?: (ms: number) => Promise<void>; retry?: boolean } = {}) {
  return async (file: string): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      try { await unlink(file); return; }
      catch (error: any) {
        if (error?.code === 'ENOENT') return;
        if (!retry || platform !== 'win32' || !BUSY_UNLINK_CODES.has(error?.code) || attempt >= COMPACTION_UNLINK_DELAYS_MS.length) throw error;
        await sleep(COMPACTION_UNLINK_DELAYS_MS[attempt]);
      }
    }
  };
}
const removeSuperseded = createCompactionUnlink();
/** A marker whose cleanup was already deferred is tried once per lock, without backoff: the bounded wait is
 * spent only when a busy file is first met, so lingering busy markers do not slow every later operation. */
const removeOnce = createCompactionUnlink({ retry: false });
export const MAX_FROZEN_BATCH_INPUT_BYTES = 64 * 1024 * 1024;
/** `reserve` is kept free by create() so accepted batches can still save progress. */
export const FROZEN_QUEUE_LIMITS = Object.freeze({ input: MAX_FROZEN_BATCH_INPUT_BYTES, state: 1024 * 1024, total: 512 * 1024 * 1024, batches: 4096, stateRevisions: 4096, reserve: 32 * 1024 * 1024 });
/** Only batches the MCP server enqueued (its host keys start with `mcp-`, HOST_REQUEST_KEY_PREFIX in novelai/src/recipe-queue.mjs)
 * are compacted; a batch under any other key is left as it is. */
export const FROZEN_COMPACTION_POLICY = Object.freeze({ requestKeyPrefix: 'mcp-', graceMs: 10 * 60 * 1000, unknownGraceMs: 7 * 24 * 60 * 60 * 1000 });
const terminalStatus = (status: unknown) => status === 'succeeded' || status === 'partial' || status === 'cancelled' || status === 'blocked';
/** Mirrors the compaction rule for callers that schedule it (unknown items wait longer). */
export function frozenBatchCompactionDue(job: BatchJob): number | null {
  if (!terminalStatus(job.status) || typeof job.finishedAt !== 'string') return null;
  const finished = Date.parse(job.finishedAt); if (!Number.isFinite(finished)) return null;
  const unknown = job.items.some(item => item.status === 'unknown' || (item.providerOutcome !== 'not_submitted' && item.providerOutcome !== 'response_received'));
  return finished + (unknown ? FROZEN_COMPACTION_POLICY.unknownGraceMs : FROZEN_COMPACTION_POLICY.graceMs);
}
const idSource = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const idPattern = new RegExp(`^${idSource}$`);
const atomicCandidatePattern = new RegExp(`^\\.txn-${idSource}-${idSource}\\.tmp$`);
const transactionPattern = new RegExp(`^\\.txn-${idSource}\\.json$`);
const recoveryClaimPattern = new RegExp(`^\\.quota\\.recover-${idSource}$`);
const staleLockPattern = new RegExp(`^\\.quota\\.lock\\.stale-${idSource}$`);
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const isObject = (value: any) => value && typeof value === 'object' && !Array.isArray(value);
// A lock owner: schema 1 (pid, nonce, times), or schema 2 that also names the owner's start and host (lock-owner.ts),
// so a lock whose owner is gone is taken over at once instead of after its lease.
const validLockOwner = (owner: any) => isObject(owner)
  && (owner.schemaVersion === 1 ? Object.keys(owner).length === 5 : owner.schemaVersion === 2 && Object.keys(owner).length === (Object.hasOwn(owner, 'boot') ? 8 : 7) && validLockIdentity(owner))
  && ['schemaVersion', 'pid', 'nonce', 'createdAt', 'leaseUntil'].every(key => Object.hasOwn(owner, key))
  && Number.isSafeInteger(owner.pid) && owner.pid > 0 && idPattern.test(owner.nonce)
  && Number.isSafeInteger(owner.createdAt) && owner.createdAt >= 0 && Number.isSafeInteger(owner.leaseUntil) && owner.leaseUntil >= owner.createdAt;
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
function preflight(value: unknown, maximum: number) {
  let nodes = 0, bytes = 0; const stack: Array<{ item: unknown; depth: number; exit?: boolean }> = [{ item: value, depth: 0 }], active = new WeakSet<object>();
  const stringBytes = (text: string) => { let size = Buffer.byteLength(text) + 2; for (let index = 0; index < text.length; index++) { const code = text.charCodeAt(index); if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) size++; else if (code < 32) size += 5; } return size; };
  while (stack.length) {
    const frame = stack.pop()!, { item, depth } = frame; if (frame.exit) { active.delete(item as object); continue; }
    if (++nodes > 750_000 || depth > 96) throw new BatchStorageError();
    if (typeof item === 'string') bytes += stringBytes(item);
    else if (item && typeof item === 'object') {
      if (active.has(item as object)) throw new BatchStorageError(); active.add(item as object); stack.push({ item, depth, exit: true });
      if (Array.isArray(item)) { bytes += item.length + 2; for (let index = item.length - 1; index >= 0; index--) stack.push({ item: item[index], depth: depth + 1 }); }
      else { const names = Object.keys(item); bytes += names.length + 2; for (let index = names.length - 1; index >= 0; index--) { const key = names[index]; bytes += stringBytes(key) + 1; stack.push({ item: (item as Record<string, unknown>)[key], depth: depth + 1 }); } }
    } else if (item === null || ['number', 'boolean'].includes(typeof item)) bytes += 32;
    else if (item !== undefined) throw new BatchStorageError();
    if (bytes > maximum) throw new BatchStorageError();
  }
}
interface StoredState { schemaVersion: 2; batchId: string; inputHash: string; revision: number; previousStateHash: string | null; job: BatchJob; stateHash: string }
/** `purge` (queue retention) names its batches in `batchIds` (batchId is the first of them, revision 0). */
interface Transaction { schemaVersion: 1; nonce: string; kind: 'create' | 'save' | 'compact' | 'purge'; batchId: string; revision: number; batchIds?: string[] }
/** Batches one purge transaction marker names at most (its marker stays below the 8 KiB marker read bound). */
export const FROZEN_PURGE_CHUNK = 150;
interface ScanUsage { ids: Set<string>; total: number; records: number; files: Map<string, Map<string, string>> }
const hexDigest = /^[a-f0-9]{64}$/;
const compactedInputKeys = ['batchId', 'compactedHash', 'compaction', 'fingerprint', 'initial', 'payloadHash', 'request', 'schemaVersion', 'sequence'];
const compactionKeys = ['compactedAt', 'historyAnchor', 'historyFrom', 'originalDigest', 'snapshotBytes', 'snapshotCount'];
const sameKeys = (value: any, keys: string[]) => isObject(value) && Object.keys(value).sort().join('\n') === keys.join('\n');
/** File identity for incremental revalidation. On POSIX any rewrite, replacement or attribute change
 * moves ctime, which ordinary callers cannot set back. Windows differs: NTFS "ChangeTime" can be set
 * back by any process with write access (SetFileInformationByHandle), and libuv's stat may return
 * cached timestamps, so an in-place edit that restores size and times can go unnoticed there until a
 * full validation (load, or any change to the batch's file set or sizes). This is a fast path for
 * unchanged files, not a tamper proof. */
const fileSignature = (info: import('node:fs').BigIntStats) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
const sameFiles = (left: Map<string, string>, right: Map<string, string>) => left.size === right.size && [...left].every(([name, signature]) => right.get(name) === signature);

/** Immutable frozen input + hash-chained immutable state history. All quota
 * scans and publications share one cross-process owner lock. */
export function createBatchStorage(runtimeDir: string, limitOverrides: Partial<typeof FROZEN_QUEUE_LIMITS> = {}): BatchStorage {
  runtimeDir = path.resolve(runtimeDir);
  const limits = { ...FROZEN_QUEUE_LIMITS, ...limitOverrides };
  // Scaled test/bench stores keep the production 1/16 proportion unless set explicitly.
  if (limitOverrides.reserve === undefined) limits.reserve = Math.min(FROZEN_QUEUE_LIMITS.reserve, Math.floor(limits.total / 16));
  const directory = path.join(runtimeDir, 'frozen-queue');
  /** An entry of the frozen-queue folder (or of a batch's .states folder) this app does not write; system metadata
   * files (system-metadata-files.ts) are skipped before this. The queue stops without changing any file and names the
   * entry relative to the data root (the parent of the runtime folder). */
  const strayEntry = (relative: string) => {
    const entry = path.relative(path.dirname(runtimeDir), path.join(directory, ...relative.split('/'))).split(path.sep).join('/');
    return new BatchStorageError(`The frozen queue folder holds an entry this app does not use: ${entry} (in the data folder). The frozen queue stopped without changing any file. Move or delete that entry, then restart the app.`, entry);
  };
  // `hashes` holds the digest every state file of the batch binds (`inputHash`).
  const hashes = new Map<string, string>(), revisions = new Map<string, number>(), stateHashes = new Map<string, string>();
  /** Batches whose files were fully validated, keyed by the signatures observed before that read. */
  const validated = new Map<string, { files: Map<string, string>; sequence: number }>();
  let loaded = false, broken = false, writes = Promise.resolve(), usageSnapshot: { batches: number; bytes: number } | null = null;
  /** Batches whose published compaction still has superseded history to remove (marker kept), by historyFrom. */
  const pendingCompactions = new Map<string, number>();
  /** Compact markers (file names) whose cleanup this instance already deferred once. */
  const deferredMarkers = new Set<string>();
  /** Batches a purge marker names whose files are not all removed yet (a busy file): hidden from scans and loads. */
  const pendingPurges = new Set<string>();
  const validateId = (id: string) => { if (!idPattern.test(id)) throw new BatchStorageError(); return id; };
  const filename = (id: string, kind: 'input' | 'state') => path.join(directory, `${validateId(id)}.${kind}.json`);
  const historyDir = (id: string) => path.join(directory, `${validateId(id)}.states`);
  const historyFile = (id: string, revision: number) => path.join(historyDir(id), `${String(revision).padStart(12, '0')}.json`);
  const guard = async <T>(work: () => Promise<T>): Promise<T> => {
    if (broken) throw new BatchStorageError();
    // Quota and new-input refusals happen before any write; they are explicit and leave the store usable.
    try { return await work(); } catch (error) {
      if (error instanceof BatchQuotaError || error instanceof BatchInputError || error instanceof BatchCompactionDeferredError) throw error;
      // The store stops either way; an entry this app does not use keeps its own message, which names it.
      broken = true; throw error instanceof BatchStorageError && error.entry ? error : new BatchStorageError();
    }
  };
  const serialize = <T>(work: () => Promise<T>): Promise<T> => { const next = writes.then(() => guard(work)); writes = next.then(() => undefined, () => undefined); return next; };
  async function syncDirectory(dir = directory) { await syncDirectoryEntry(dir); }
  async function init() {
    const rootInfo = await fs.lstat(runtimeDir);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new BatchStorageError();
    await fs.mkdir(directory, { recursive: false, mode: 0o700 }).catch((error: any) => { if (error.code !== 'EEXIST') throw error; });
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new BatchStorageError();
    const runtimeReal = await fs.realpath(runtimeDir), actual = await fs.realpath(directory);
    if (actual !== path.join(runtimeReal, 'frozen-queue')) throw new BatchStorageError();
  }
  async function read(file: string, maximum: number) {
    const handle = await openNoFollow(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const info = await handle.stat(); if (!info.isFile() || info.size > maximum) throw new BatchStorageError(); const text = await handle.readFile('utf8'); if (Buffer.byteLength(text) > maximum) throw new BatchStorageError(); return text; }
    finally { await handle.close(); }
  }
  async function atomic(file: string, text: string, exclusive: boolean, nonce: string) {
    const temporary = path.join(directory, `.txn-${nonce}-${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600); try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
      if (exclusive) { await fs.link(temporary, file); await fs.unlink(temporary); }
      else { const previous = await fs.lstat(file); if (!previous.isFile() || previous.isSymbolicLink()) throw new BatchStorageError(); await renameReplace(temporary, file); }
      await syncDirectory(path.dirname(file));
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  const stateBody = (inputHash: string, revision: number, previousStateHash: string | null, job: BatchJob) => ({ schemaVersion: 2 as const, batchId: job.batchId, inputHash, revision, previousStateHash, job });
  function stateText(inputHash: string, revision: number, previousStateHash: string | null, job: BatchJob) {
    preflight(job, limits.state); const body = stateBody(inputHash, revision, previousStateHash, job), text = JSON.stringify({ ...body, stateHash: hash(JSON.stringify(canonical(body))) });
    if (Buffer.byteLength(text) > limits.state) throw new BatchStorageError(); return text;
  }
  function validateState(text: string, id: string, inputHash: string, expectedRevision?: number): StoredState {
    const value = JSON.parse(text); preflight(value, limits.state);
    if (!isObject(value)) throw new BatchStorageError();
    const { stateHash, ...body } = value;
    if (value.schemaVersion !== 2 || value.batchId !== id || value.inputHash !== inputHash || !Number.isSafeInteger(value.revision) || value.revision < 1
      || (expectedRevision !== undefined && value.revision !== expectedRevision) || (value.revision === 1 ? value.previousStateHash !== null : typeof value.previousStateHash !== 'string')
      || !isObject(value.job) || typeof stateHash !== 'string' || hash(JSON.stringify(canonical(body))) !== stateHash) throw new BatchStorageError();
    return value;
  }
  async function acquireLock() {
    await init(); const file = path.join(directory, '.quota.lock'), nonce = randomUUID(), startTimes = memoStartTimes();
    const held = (owner: any) => lockStillHeld(owner, Date.now(), startTimes);
    const retryDelay = () => new Promise(resolve => setTimeout(resolve, 5)), incompleteReads = new Map<string, number>();
    const sameOwner = (a: any, b: any) => validLockOwner(a) && validLockOwner(b) && a.pid === b.pid && a.nonce === b.nonce && a.createdAt === b.createdAt && a.leaseUntil === b.leaseUntil;
    const publishedJson = async (publishedFile: string): Promise<{ status: 'value'; value: any } | { status: 'missing' | 'incomplete' }> => {
      let text: string;
      try { text = await read(publishedFile, 4096); }
      catch (error: any) { if (error.code === 'ENOENT') { incompleteReads.delete(publishedFile); return { status: 'missing' }; } throw error; }
      try { const value = JSON.parse(text); incompleteReads.delete(publishedFile); return { status: 'value', value }; }
      catch {
        const failures = (incompleteReads.get(publishedFile) ?? 0) + 1; incompleteReads.set(publishedFile, failures);
        // Older writers expose the inode before writeFile completes. Keep that
        // publication window bounded; stable malformed bytes still fail closed.
        if (failures >= 200) throw new BatchStorageError();
        return { status: 'incomplete' };
      }
    };
    const claimsBlock = async (): Promise<'clear' | 'blocked' | 'retry'> => {
      let blocked = false;
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) if (recoveryClaimPattern.test(entry.name)) {
        if (!entry.isFile() || entry.isSymbolicLink()) throw new BatchStorageError(); const claimFile = path.join(directory, entry.name), published = await publishedJson(claimFile);
        if (published.status !== 'value') return 'retry'; const claim = published.value, filenameNonce = entry.name.slice('.quota.recover-'.length);
        if (!Number.isSafeInteger(claim.pid) || claim.pid <= 0 || !idPattern.test(claim.nonce) || claim.nonce !== filenameNonce
          || !Number.isSafeInteger(claim.createdAt) || !Number.isSafeInteger(claim.leaseUntil) || claim.createdAt < 0 || claim.leaseUntil < claim.createdAt) throw new BatchStorageError();
        if (await held(claim)) blocked = true;
        else try { await fs.unlink(claimFile); } catch (error: any) { if (error.code === 'ENOENT') return 'retry'; throw error; }
      }
      return blocked ? 'blocked' : 'clear';
    };
    const releaseIfOwned = async (owner: any) => {
      const current = await publishedJson(file); if (current.status === 'missing') return;
      if (current.status !== 'value' || !sameOwner(current.value, owner)) throw new BatchStorageError();
      await fs.unlink(file); await syncDirectory();
    };
    const cleanupStaleLocks = async () => {
      let removed = false;
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (!entry.name.startsWith('.quota.lock.stale-')) continue;
        if (!staleLockPattern.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) throw new BatchStorageError();
        const staleFile = path.join(directory, entry.name); let handle;
        try { handle = await openNoFollow(staleFile, constants.O_RDONLY | constants.O_NOFOLLOW); }
        catch (error: any) { if (error.code === 'ENOENT') continue; throw error; }
        let info, owner;
        try {
          info = await handle.stat(); if (!info.isFile() || info.size > 4096) throw new BatchStorageError();
          const text = await handle.readFile('utf8'); if (Buffer.byteLength(text) > 4096) throw new BatchStorageError();
          try { owner = JSON.parse(text); } catch { throw new BatchStorageError(); }
        } finally { await handle.close(); }
        if (!validLockOwner(owner)) throw new BatchStorageError();
        if (await held(owner)) throw new BatchStorageError();
        let current; try { current = await fs.lstat(staleFile); } catch (error: any) { if (error.code === 'ENOENT') continue; throw error; }
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino) throw new BatchStorageError();
        try { await fs.unlink(staleFile); removed = true; } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      }
      if (removed) await syncDirectory();
    };
    // Match the publication lease: ordinary large scans get a bounded minute
    // to finish, while incomplete JSON has its shorter bound above.
    for (let attempt = 0; attempt < 12_000; attempt++) {
      if (await claimsBlock() !== 'clear') { await retryDelay(); continue; }
      const now = Date.now(), owner = { schemaVersion: 2, pid: process.pid, nonce, createdAt: now, leaseUntil: now + 60_000, ...lockOwnerIdentity() }; let acquired = false;
      try {
        // Link a fully written inode into place. Readers see either no owner or
        // the complete owner; legacy open-then-write owners are handled below.
        await atomic(file, JSON.stringify(owner), true, nonce); acquired = true;
        if (await claimsBlock() !== 'clear') { await releaseIfOwned(owner); await retryDelay(); continue; }
        await cleanupStaleLocks();
        return { nonce, release: async () => { await releaseIfOwned(owner); } };
      } catch (error: any) {
        if (acquired) { await releaseIfOwned(owner); throw error; }
        // A competing lock holder can remove our unpublished atomic temporary
        // while recovering transactions. No owner was published; start over.
        if (error.code === 'ENOENT') { await retryDelay(); continue; }
        if (error.code !== 'EEXIST') throw error;
        const published = await publishedJson(file);
        if (published.status !== 'value') { await retryDelay(); continue; }
        const lockOwner = published.value;
        if (!validLockOwner(lockOwner)) throw new BatchStorageError();
        if (await held(lockOwner)) { await retryDelay(); continue; }
        const stale = `${file}.stale-${nonce}`, claimFile = path.join(directory, `.quota.recover-${nonce}`), claimCreatedAt = Date.now(), claimOwner = { pid: process.pid, nonce, createdAt: claimCreatedAt, leaseUntil: claimCreatedAt + 60_000, ...lockOwnerIdentity() };
        try {
          await atomic(claimFile, JSON.stringify(claimOwner), true, nonce);
          const current = await publishedJson(file); if (current.status === 'missing') continue; if (current.status !== 'value') { await retryDelay(); continue; }
          if (!sameOwner(current.value, lockOwner)) continue;
          await fs.rename(file, stale); const moved = JSON.parse(await read(stale, 4096));
          if (!sameOwner(moved, lockOwner)) { try { await fs.link(stale, file); } catch {} throw new BatchStorageError(); }
          await fs.unlink(stale); await syncDirectory();
        } catch (rename: any) { if (rename.code !== 'ENOENT') throw rename; }
        finally { await fs.unlink(claimFile).catch(() => {}); }
      }
    }
    throw new BatchStorageError();
  }
  async function writeTransaction(value: Transaction, nonce: string) {
    await atomic(path.join(directory, `.txn-${nonce}.json`), JSON.stringify(value), true, nonce);
  }
  const validCompaction = (value: any, count: number) => sameKeys(value, compactionKeys) && typeof value.compactedAt === 'string' && Number.isFinite(Date.parse(value.compactedAt))
    && typeof value.originalDigest === 'string' && hexDigest.test(value.originalDigest) && Number.isSafeInteger(value.snapshotCount) && [1, count].includes(value.snapshotCount)
    && Number.isSafeInteger(value.snapshotBytes) && value.snapshotBytes >= 0 && Number.isSafeInteger(value.historyFrom) && value.historyFrom >= 1
    && (value.historyFrom === 1 ? value.historyAnchor === null : typeof value.historyAnchor === 'string' && hexDigest.test(value.historyAnchor));
  /** `digest` is what every state file binds as `inputHash`: the text hash of a
   * v1 input, or the preserved original digest of a compacted v2 input. */
  function parseInput(text: string, id: string): { input: StoredFrozenBatchInput; digest: string } {
    const input = JSON.parse(text) as StoredFrozenBatchInput;
    preflight(input, limits.input);
    if (!isObject(input) || input.batchId !== id || !Number.isSafeInteger(input.sequence) || input.sequence < 1 || !isObject(input.request) || !isObject(input.initial)
      || input.initial.batchId !== id || input.request.execution !== 'queued' || !Number.isSafeInteger(input.request.count) || input.request.count < 1 || !hexDigest.test(input.payloadHash)) throw new BatchStorageError();
    if (input.schemaVersion === 1) {
      if (!Array.isArray(input.snapshots) || !input.snapshots.length || ![1, input.request.count].includes(input.snapshots.length)
        || input.payloadHash !== hash(JSON.stringify(canonical(input.snapshots)))) throw new BatchStorageError();
      return { input, digest: hash(text) };
    }
    if (input.schemaVersion !== 2 || !sameKeys(input, compactedInputKeys) || !validCompaction(input.compaction, input.request.count)) throw new BatchStorageError();
    const { compactedHash, ...body } = input;
    if (typeof compactedHash !== 'string' || compactedHash !== hash(JSON.stringify(canonical(body)))) throw new BatchStorageError();
    return { input, digest: input.compaction.originalDigest };
  }
  async function readInput(id: string) {
    const text = await read(filename(id, 'input'), limits.input);
    return { text, ...parseInput(text, id) };
  }
  /** Every file of one batch (history, current state, input), then its folder; a missing file is already gone. */
  async function removeBatchFiles(batchId: string, remove: (file: string) => Promise<void>) {
    const dir = historyDir(batchId);
    let names: string[] = [];
    try { names = await fs.readdir(dir); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    for (const entry of names) await remove(path.join(dir, entry));
    // A folder still listing a file another process holds (win32 delete pending) is removed later, like a busy file.
    try { await fs.rmdir(dir); } catch (error: any) { if (error.code === 'ENOTEMPTY') throw Object.assign(new Error('The history folder is not empty yet.'), { code: 'EBUSY' }); if (error.code !== 'ENOENT') throw error; }
    await remove(filename(batchId, 'state')); await remove(filename(batchId, 'input'));
  }
  async function recoverTransactions(nonce: string) {
    pendingCompactions.clear();
    const names = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of names.filter(entry => atomicCandidatePattern.test(entry.name))) {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new BatchStorageError();
      try { await fs.unlink(path.join(directory, entry.name)); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
    const remaining = await fs.readdir(directory);
    for (const name of remaining.filter(name => transactionPattern.test(name))) {
      const file = path.join(directory, name); let txn: Transaction;
      try { txn = JSON.parse(await read(file, 8192)); } catch { throw new BatchStorageError(); }
      const filenameNonce = name.slice(5, -5);
      if (txn.schemaVersion !== 1 || !idPattern.test(txn.nonce) || txn.nonce !== filenameNonce || !idPattern.test(txn.batchId) || !['create', 'save', 'compact', 'purge'].includes(txn.kind) || !Number.isSafeInteger(txn.revision)) throw new BatchStorageError();
      const id = txn.batchId;
      if (txn.kind === 'purge') {
        // Written only after the batches were recorded as cleaned elsewhere: always rolled forward.
        const ids = txn.batchIds;
        if (!Array.isArray(ids) || !ids.length || ids.length > FROZEN_PURGE_CHUNK || ids[0] !== id || ids.some(value => typeof value !== 'string' || !idPattern.test(value)) || new Set(ids).size !== ids.length) throw new BatchStorageError();
        const remove = deferredMarkers.has(name) ? removeOnce : removeSuperseded;
        try { for (const batchId of ids) await removeBatchFiles(batchId, remove); await remove(file); await syncDirectory(); deferredMarkers.delete(name); for (const batchId of ids) pendingPurges.delete(batchId); }
        catch (error) { if (!deferrableCleanup(error)) throw error; deferredMarkers.add(name); for (const batchId of ids) pendingPurges.add(batchId); }
        continue;
      }
      if (txn.kind === 'create') {
        let complete = false;
        try { const input = await readInput(id), state = validateState(await read(filename(id, 'state'), limits.state), id, input.digest, 1), history = validateState(await read(historyFile(id, 1), limits.state), id, input.digest, 1); complete = state.stateHash === history.stateHash; } catch {}
        if (!complete) { await fs.rm(historyDir(id), { recursive: true, force: true }); await fs.unlink(filename(id, 'input')).catch(() => {}); await fs.unlink(filename(id, 'state')).catch(() => {}); }
      } else if (txn.kind === 'compact') {
        // Step order: marker, atomic input replacement, older-history removal, marker removal.
        // A published compacted input means roll forward; anything else changed nothing. A cleanup
        // that is still busy keeps its marker for the next locked operation and blocks nothing else.
        // A marker below the published historyFrom is stale: an earlier attempt that never published, superseded
        // by a later compaction whose own marker covers every older revision. It is dropped like any unpublished one.
        const remove = deferredMarkers.has(name) ? removeOnce : removeSuperseded;
        // A batch purged (queue retention) while its earlier compaction cleanup was still deferred has nothing left to finish.
        let input: StoredFrozenBatchInput | null = null;
        try { input = (await readInput(id)).input; } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
        if (!input) {
          try { await remove(file); await syncDirectory(); deferredMarkers.delete(name); } catch (error) { if (!deferrableCleanup(error)) throw error; deferredMarkers.add(name); }
          continue;
        }
        const published = input.schemaVersion === 2 && input.compaction.historyFrom === txn.revision;
        try {
          if (published) {
            for (const entry of await fs.readdir(historyDir(id))) {
              if (isSystemMetadataName(entry)) continue;
              const match = /^(\d{12})\.json$/.exec(entry); if (!match) throw new BatchStorageError();
              if (Number(match[1]) < txn.revision) await remove(path.join(historyDir(id), entry));
            }
            await syncDirectory(historyDir(id));
          }
          await remove(file); await syncDirectory(); deferredMarkers.delete(name);
        } catch (error) { if (!deferrableCleanup(error)) throw error; deferredMarkers.add(name); if (published) pendingCompactions.set(id, txn.revision); }
        continue;
      } else {
        const input = await readInput(id); let current: StoredState | null = null;
        try { current = validateState(await read(filename(id, 'state'), limits.state), id, input.digest); } catch {}
        let historyText: string | null = null;
        try { historyText = await read(historyFile(id, txn.revision), limits.state); }
        catch (error: any) { if (error.code !== 'ENOENT') throw error; }
        if (historyText === null) {
          // Marker publication alone changes no state; a valid prior current is a safe rollback.
          if (!current || current.revision !== txn.revision - 1) throw new BatchStorageError();
        } else {
          const history = validateState(historyText, id, input.digest, txn.revision);
          if (!current || current.revision === txn.revision - 1) await atomic(filename(id, 'state'), historyText, false, nonce);
          else if (current.revision !== txn.revision || current.stateHash !== history.stateHash) throw new BatchStorageError();
        }
      }
      await fs.unlink(file); await syncDirectory();
    }
  }
  async function scan(): Promise<ScanUsage> {
    const names = await fs.readdir(directory, { withFileTypes: true }); let total = 0, records = 0;
    const ids = new Set<string>(), files = new Map<string, Map<string, string>>(), realDirectory = await fs.realpath(directory);
    // A batch whose purge is deferred (busy file) still uses its bytes, but is no batch any more.
    const note = (id: string, name: string, info: import('node:fs').BigIntStats) => {
      total += Number(info.size); records++; if (pendingPurges.has(id)) return;
      let batch = files.get(id); if (!batch) files.set(id, batch = new Map());
      batch.set(name, fileSignature(info));
    };
    const batchOf = (id: string) => { if (!pendingPurges.has(id)) ids.add(id); };
    for (const entry of names) {
      const name = entry.name;
      if (isSystemMetadataFile(entry)) continue;
      if (atomicCandidatePattern.test(name)) {
        // Lock contenders may create and remove complete publication candidates
        // while this holder scans. They are not durable quota reservations.
        let info; try { info = await fs.lstat(path.join(directory, name)); } catch (error: any) { if (error.code === 'ENOENT') continue; throw error; }
        if (!info.isFile() || info.isSymbolicLink()) throw new BatchStorageError(); continue;
      }
      if (name.startsWith('.quota.lock.stale-')) {
        if (!staleLockPattern.test(name) || !entry.isFile() || entry.isSymbolicLink()) throw new BatchStorageError();
        let owner; try { owner = JSON.parse(await read(path.join(directory, name), 4096)); } catch { throw new BatchStorageError(); }
        if (!validLockOwner(owner)) throw new BatchStorageError();
        // A normal dead/expired artifact is removed immediately after lock
        // acquisition. Anything appearing after that cleanup is preserved and
        // rejected rather than being trusted or silently deleted during quota.
        throw new BatchStorageError();
      }
      if (name === '.quota.lock' || recoveryClaimPattern.test(name) || transactionPattern.test(name)) {
        if (!entry.isFile() || entry.isSymbolicLink()) throw new BatchStorageError();
        let info; try { info = await fs.lstat(path.join(directory, name)); } catch (error: any) { if (error.code === 'ENOENT') continue; throw error; }
        total += info.size; records++; continue;
      }
      let match = /^([a-f0-9-]{36})\.(input|state)\.json$/.exec(name);
      if (match && idPattern.test(match[1])) { if (!entry.isFile() || entry.isSymbolicLink()) throw strayEntry(name); batchOf(match[1]); note(match[1], name, await fs.lstat(path.join(directory, name), { bigint: true })); continue; }
      match = /^([a-f0-9-]{36})\.states$/.exec(name);
      if (match && idPattern.test(match[1])) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || await fs.realpath(path.join(directory, name)) !== path.join(realDirectory, name)) throw strayEntry(name); batchOf(match[1]);
        for (const child of await fs.readdir(path.join(directory, name), { withFileTypes: true })) {
          if (isSystemMetadataFile(child)) continue;
          if (!child.isFile() || child.isSymbolicLink() || !/^\d{12}\.json$/.test(child.name)) throw strayEntry(`${name}/${child.name}`);
          note(match[1], `${name}/${child.name}`, await fs.lstat(path.join(directory, name, child.name), { bigint: true }));
        }
        continue;
      }
      throw strayEntry(name);
    }
    if (ids.size > limits.batches || records > limits.batches * (limits.stateRevisions + 2) || total > limits.total) throw new BatchStorageError();
    usageSnapshot = { batches: ids.size, bytes: total };
    return { ids, total, records, files };
  }
  async function statFiles(names: string[], into = new Map<string, string>()) {
    for (const name of names) into.set(name, fileSignature(await fs.lstat(path.join(directory, ...name.split('/')), { bigint: true })));
    return into;
  }
  const historyName = (id: string, revision: number) => `${id}.states/${String(revision).padStart(12, '0')}.json`;
  async function validateStored(id: string) {
    const { text, input, digest } = await readInput(id), currentText = await read(filename(id, 'state'), limits.state), parsed = JSON.parse(currentText); preflight(parsed, limits.state);
    // Only the revision-chained state (schemaVersion 2) exists; anything else is damage or an unsupported older format.
    if (parsed.schemaVersion !== 2) throw new BatchStorageError();
    // A compacted input keeps only historyFrom..current, anchored to the dropped revision's hash.
    const from = input.schemaVersion === 2 ? input.compaction.historyFrom : 1, anchor = input.schemaVersion === 2 ? input.compaction.historyAnchor : null;
    // Superseded revisions a published compaction could not remove yet (its marker is still pending) are ignored.
    const listed = (await fs.readdir(historyDir(id))).filter(name => !isSystemMetadataName(name)).sort(), pending = input.schemaVersion === 2 && pendingCompactions.get(id) === from;
    const historyNames = pending ? listed.filter(name => !/^\d{12}\.json$/.test(name) || Number(name.slice(0, 12)) >= from) : listed;
    if (!historyNames.length || historyNames.length > limits.stateRevisions) throw new BatchStorageError();
    let previous: StoredState | null = null;
    for (let index = 0; index < historyNames.length; index++) {
      const at = from + index;
      if (historyNames[index] !== `${String(at).padStart(12, '0')}.json`) throw new BatchStorageError();
      const state = validateState(await read(historyFile(id, at), limits.state), id, digest, at);
      if (index ? state.previousStateHash !== previous!.stateHash : state.previousStateHash !== anchor) throw new BatchStorageError(); previous = state;
    }
    const current = validateState(currentText, id, digest);
    if (current.revision !== from + historyNames.length - 1 || current.stateHash !== previous!.stateHash) throw new BatchStorageError();
    // Snapshots are only dropped after the batch ended; anything else is damage.
    if (input.schemaVersion === 2 && !terminalStatus(current.job.status)) throw new BatchStorageError();
    const job = current.job, revision = current.revision, stateHash = current.stateHash, previousStateHash = current.previousStateHash;
    return { text, input, digest, job, revision, stateHash, previousStateHash };
  }
  /** Fully revalidates only batches whose observed file signatures differ from
   * the ones seen before their last full validation (or that were never
   * validated). An external edit, replacement or rollback of any input, state
   * or history file still stops acceptance before the next publication. */
  async function revalidate(usage: ScanUsage, skip?: string) {
    let maximumSequence = 0;
    for (const id of usage.ids) {
      const observed = usage.files.get(id) ?? new Map<string, string>(); let known = validated.get(id);
      if (id !== skip && (!known || !sameFiles(known.files, observed))) { known = { files: observed, sequence: (await validateStored(id)).input.sequence }; validated.set(id, known); }
      if (known) maximumSequence = Math.max(maximumSequence, known.sequence);
    }
    for (const id of [...validated.keys()]) if (!usage.ids.has(id)) validated.delete(id);
    return maximumSequence;
  }
  return {
    load: () => serialize(async () => {
      if (loaded) throw new BatchStorageError(); const lock = await acquireLock();
      try {
        await recoverTransactions(lock.nonce); const usage = await scan(), records: FrozenBatchRecord[] = [], sequences = new Set<number>();
        for (const id of usage.ids) {
          const { input, digest, job, revision, stateHash } = await validateStored(id); if (sequences.has(input.sequence)) throw new BatchStorageError(); sequences.add(input.sequence);
          hashes.set(id, digest); revisions.set(id, revision); stateHashes.set(id, stateHash); records.push({ input, job });
          validated.set(id, { files: usage.files.get(id) ?? new Map(), sequence: input.sequence });
        }
        loaded = true; return records.sort((a, b) => a.input.sequence - b.input.sequence);
      } finally { await lock.release(); }
    }),
    create: input => serialize(async () => {
      if (!loaded || hashes.has(input.batchId)) throw new BatchStorageError(); const lock = await acquireLock();
      try {
        await recoverTransactions(lock.nonce); const usage = await scan();
        // Revalidate under the publication lock (incrementally, see revalidate).
        const maximumSequence = await revalidate(usage);
        if (usage.ids.size >= limits.batches) throw new BatchQuotaError('batches');
        const nextSequence = maximumSequence + 1; if (!Number.isSafeInteger(nextSequence)) throw new BatchStorageError();
        // The new input is checked before anything is written; a failure here concerns this batch only.
        const checked = (() => {
          try {
            preflight(input, limits.input);
            const storedInput = structuredClone(input); storedInput.sequence = nextSequence;
            preflight(storedInput, limits.input); const text = JSON.stringify(storedInput), size = Buffer.byteLength(text), digest = hash(text);
            if (size > limits.input || storedInput.schemaVersion !== 1 || storedInput.initial.batchId !== storedInput.batchId || storedInput.request.execution !== 'queued'
              || storedInput.payloadHash !== hash(JSON.stringify(canonical(storedInput.snapshots)))) throw new BatchInputError();
            return { storedInput, text, size, digest, state: stateText(digest, 1, null, storedInput.initial) };
          } catch { throw new BatchInputError(); }
        })();
        const { storedInput, text, size, digest, state } = checked, transaction = JSON.stringify({ schemaVersion: 1, nonce: lock.nonce, kind: 'create', batchId: storedInput.batchId, revision: 1 });
        const added = size + Buffer.byteLength(state) * 2 + Buffer.byteLength(transaction);
        // New batches leave `reserve` free so already accepted batches can keep saving progress.
        if (usage.total + added + limits.reserve > limits.total) throw new BatchQuotaError('bytes');
        const id = storedInput.batchId;
        await writeTransaction({ schemaVersion: 1, nonce: lock.nonce, kind: 'create', batchId: id, revision: 1 }, lock.nonce);
        await fs.mkdir(historyDir(id), { mode: 0o700 });
        await atomic(filename(id, 'input'), text, true, lock.nonce); await atomic(historyFile(id, 1), state, true, lock.nonce); await atomic(filename(id, 'state'), state, true, lock.nonce);
        await fs.unlink(path.join(directory, `.txn-${lock.nonce}.json`)); await syncDirectory();
        hashes.set(id, digest); revisions.set(id, 1); stateHashes.set(id, validateState(state, id, digest, 1).stateHash);
        validated.set(id, { files: await statFiles([`${id}.input.json`, `${id}.state.json`, historyName(id, 1)]), sequence: nextSequence });
        usageSnapshot = { batches: usage.ids.size + 1, bytes: usage.total + size + Buffer.byteLength(state) * 2 };
        return storedInput.sequence;
      } finally { await lock.release(); }
    }),
    save: (batchId, job) => serialize(async () => {
      if (!loaded || !hashes.has(batchId) || job.batchId !== batchId || !revisions.get(batchId)) throw new BatchStorageError(); const lock = await acquireLock();
      try {
        await recoverTransactions(lock.nonce); const usage = await scan(); await revalidate(usage);
        const digest = hashes.get(batchId)!, revision = revisions.get(batchId)!, priorHash = stateHashes.get(batchId)!;
        const currentText = await read(filename(batchId, 'state'), limits.state), current = validateState(currentText, batchId, digest, revision);
        if (current.stateHash !== priorHash) throw new BatchStorageError();
        const nextText = stateText(digest, revision + 1, priorHash, job), nextSize = Buffer.byteLength(nextText), delta = nextSize + (nextSize - Buffer.byteLength(currentText));
        const transactionSize = Buffer.byteLength(JSON.stringify({ schemaVersion: 1, nonce: lock.nonce, kind: 'save', batchId, revision: revision + 1 }));
        // Saves may use the create reserve; reaching the hard limit still fails closed.
        if (revision >= limits.stateRevisions || usage.total + delta + transactionSize > limits.total) throw new BatchStorageError();
        await writeTransaction({ schemaVersion: 1, nonce: lock.nonce, kind: 'save', batchId, revision: revision + 1 }, lock.nonce);
        await atomic(historyFile(batchId, revision + 1), nextText, true, lock.nonce); await atomic(filename(batchId, 'state'), nextText, false, lock.nonce);
        await fs.unlink(path.join(directory, `.txn-${lock.nonce}.json`)); await syncDirectory();
        const next = validateState(nextText, batchId, digest, revision + 1); revisions.set(batchId, next.revision); stateHashes.set(batchId, next.stateHash);
        const known = validated.get(batchId); if (known) await statFiles([`${batchId}.state.json`, historyName(batchId, revision + 1)], known.files);
        usageSnapshot = { batches: usage.ids.size, bytes: usage.total + delta };
      } finally { await lock.release(); }
    }),
    compact: (batchId, options = {}) => serialize(async (): Promise<FrozenBatchCompactionResult> => {
      if (!loaded) throw new BatchStorageError();
      if (!hashes.has(batchId)) return { status: 'not_eligible', reason: 'unknown_batch' };
      const lock = await acquireLock();
      try {
        // After recovery under the lock no other storage transaction is in progress.
        await recoverTransactions(lock.nonce); const usage = await scan(); await revalidate(usage, batchId);
        const observed = usage.files.get(batchId); if (!usage.ids.has(batchId) || !observed) throw new BatchStorageError();
        const stored = await validateStored(batchId); validated.set(batchId, { files: observed, sequence: stored.input.sequence });
        if (stored.digest !== hashes.get(batchId) || stored.revision !== revisions.get(batchId) || stored.stateHash !== stateHashes.get(batchId)) throw new BatchStorageError();
        const { input, job, revision } = stored, now = options.now ?? Date.now();
        if (!terminalStatus(job.status)) return { status: 'not_eligible', reason: 'not_terminal' };
        if (typeof input.request.requestKey !== 'string' || !input.request.requestKey.startsWith(FROZEN_COMPACTION_POLICY.requestKeyPrefix)) return { status: 'not_eligible', reason: 'not_mcp' };
        const due = frozenBatchCompactionDue(job); if (due === null) return { status: 'not_eligible', reason: 'no_finish_time' };
        if (now < due) return { status: 'not_eligible', reason: 'grace_period', eligibleAt: due };
        if (input.schemaVersion === 2 && input.compaction.historyFrom === revision) return { status: 'already_compacted', compactedAt: input.compaction.compactedAt };
        const removed = (await fs.readdir(historyDir(batchId))).filter(name => /^\d{12}\.json$/.test(name)).sort().filter(name => Number(name.slice(0, 12)) < revision);
        let removedBytes = 0; for (const name of removed) removedBytes += (await fs.lstat(path.join(historyDir(batchId), name))).size;
        const compaction: FrozenBatchCompaction = input.schemaVersion === 2
          ? { ...input.compaction, historyFrom: revision, historyAnchor: stored.previousStateHash }
          : { compactedAt: new Date(now).toISOString(), originalDigest: stored.digest, snapshotCount: input.snapshots.length, snapshotBytes: Buffer.byteLength(JSON.stringify(input.snapshots)), historyFrom: revision, historyAnchor: stored.previousStateHash };
        const body = { schemaVersion: 2 as const, batchId, sequence: input.sequence, request: input.request, fingerprint: input.fingerprint, payloadHash: input.payloadHash, initial: input.initial, compaction };
        const text = JSON.stringify({ ...body, compactedHash: hash(JSON.stringify(canonical(body))) }), size = Buffer.byteLength(text), previousSize = Buffer.byteLength(stored.text);
        // Publish only what the validator accepts and what still binds every kept state file.
        if (parseInput(text, batchId).digest !== stored.digest) throw new BatchStorageError();
        const transaction: Transaction = { schemaVersion: 1, nonce: lock.nonce, kind: 'compact', batchId, revision }, reclaimed = previousSize - size + removedBytes;
        if (reclaimed <= 0 || usage.total + Buffer.byteLength(JSON.stringify(transaction)) + Math.max(0, size - previousSize) > limits.total) return { status: 'not_eligible', reason: 'no_gain' };
        await writeTransaction(transaction, lock.nonce);
        try { await atomic(filename(batchId, 'input'), text, false, lock.nonce); }
        catch (error) {
          if (!deferrableCleanup(error)) throw error;
          // The replacement is a single rename (retried on win32): refused means nothing was published.
          let published = false; try { const current = (await readInput(batchId)).input; published = current.schemaVersion === 2 && current.compaction.historyFrom === revision; } catch {}
          validated.delete(batchId); deferredMarkers.add(`.txn-${lock.nonce}.json`); if (published) pendingCompactions.set(batchId, revision);
          throw new BatchCompactionDeferredError(batchId, compaction.compactedAt, error, published);
        }
        try {
          for (const name of removed) { await removeSuperseded(path.join(historyDir(batchId), name)); observed.delete(`${batchId}.states/${name}`); }
          if (removed.length) await syncDirectory(historyDir(batchId));
          await removeSuperseded(path.join(directory, `.txn-${lock.nonce}.json`)); await syncDirectory();
        } catch (error) {
          if (!deferrableCleanup(error)) throw error;
          // Published already: keep the marker; the next locked operation finishes the removal.
          pendingCompactions.set(batchId, revision); validated.delete(batchId); deferredMarkers.add(`.txn-${lock.nonce}.json`);
          throw new BatchCompactionDeferredError(batchId, compaction.compactedAt, error, true);
        }
        await statFiles([`${batchId}.input.json`], observed);
        usageSnapshot = { batches: usage.ids.size, bytes: usage.total - reclaimed };
        return { status: 'compacted', compactedAt: compaction.compactedAt, reclaimedBytes: reclaimed, removedHistoryFiles: removed.length };
      } finally { await lock.release(); }
    }),
    purge: batchIds => serialize(async (): Promise<FrozenBatchPurgeResult> => {
      if (!loaded || !Array.isArray(batchIds)) throw new BatchStorageError();
      for (const id of batchIds) validateId(id);
      const wanted = [...new Set(batchIds)].filter(id => hashes.has(id)), result: FrozenBatchPurgeResult = { removed: [], reclaimedBytes: 0, deferred: [] };
      if (!wanted.length) return result;
      const lock = await acquireLock();
      try {
        // After recovery under the lock no other storage transaction is in progress.
        await recoverTransactions(lock.nonce); const usage = await scan(); await revalidate(usage);
        // Only an ended batch goes, stored exactly as this instance knows it (anything else is damage: nothing is
        // removed and the store stops); a batch that has not ended is left as it is.
        const sizes = new Map<string, number>(), ended: string[] = [];
        for (const id of wanted) {
          const observed = usage.files.get(id); if (!usage.ids.has(id) || !observed) throw new BatchStorageError();
          const stored = await validateStored(id);
          if (stored.digest !== hashes.get(id) || stored.revision !== revisions.get(id) || stored.stateHash !== stateHashes.get(id)) throw new BatchStorageError();
          if (!terminalStatus(stored.job.status)) continue;
          ended.push(id); sizes.set(id, [...observed.values()].reduce((sum, signature) => sum + Number(signature.split(':')[2]), 0));
        }
        let bytes = usage.total, batches = usage.ids.size;
        for (let start = 0; start < ended.length; start += FROZEN_PURGE_CHUNK) {
          const chunk = ended.slice(start, start + FROZEN_PURGE_CHUNK), marker = `.txn-${lock.nonce}.json`;
          // Step order: marker naming the chunk, every file of each batch, marker removal. A crash or a busy file
          // leaves the marker; the next locked operation (or start) removes what is left before it reads anything.
          await writeTransaction({ schemaVersion: 1, nonce: lock.nonce, kind: 'purge', batchId: chunk[0], revision: 0, batchIds: chunk }, lock.nonce);
          const forget = (id: string) => { hashes.delete(id); revisions.delete(id); stateHashes.delete(id); validated.delete(id); pendingCompactions.delete(id); };
          try {
            for (const id of chunk) await removeBatchFiles(id, removeSuperseded);
            await syncDirectory(); await removeSuperseded(path.join(directory, marker)); await syncDirectory();
          } catch (error) {
            if (!deferrableCleanup(error)) throw error;
            // A busy file defers the rest of this chunk: hidden from now on, finished by recovery; later chunks wait for the next round.
            deferredMarkers.add(marker); for (const id of chunk) { pendingPurges.add(id); forget(id); }
            result.deferred.push(...chunk); batches -= chunk.length;
            break;
          }
          for (const id of chunk) { forget(id); result.removed.push(id); result.reclaimedBytes += sizes.get(id)!; bytes -= sizes.get(id)!; batches--; }
        }
        usageSnapshot = { batches, bytes };
        return result;
      } finally { await lock.release(); }
    }),
    capacity: () => usageSnapshot ? { batches: usageSnapshot.batches, batchLimit: limits.batches, bytes: usageSnapshot.bytes, byteLimit: limits.total, reserve: limits.reserve } : null,
  };
}
