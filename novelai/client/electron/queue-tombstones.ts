import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openNoFollow, renameReplace, syncDirectory } from './platform-fs';

/**
 * Records of cleaned queue batches (queue retention, 2026-11). Once an ended agent batch is older than the retention
 * period, its frozen files, its request receipt and the plain recipes only it used are removed; what a later call with
 * the old requestKey or batchId must still learn stays here: that the key was accepted, which batch it made, how it
 * ended and when it was cleaned. A key with such a record is never "not found" (an agent could read that as safe to
 * resend) and is never queued again.
 *
 * The record file is append-only, one JSON line per record, each line bound by its own hash and by the hash of the line
 * before it (a chain). Two anchors in two folders — runtime/queue-cleaned/anchor-v1.json and <data root>/queue-anchor/
 * cleaned-v1.anchor.json — hold the number of lines and the hash of the last one (review rework, 2026-11). Both are
 * created (count 0) before the first line is written and updated after every append, so on reading:
 *   - a missing or cut file, a removed or changed line, a missing, changed or disagreeing anchor is damage, never a
 *     crash state: the store fails closed (every answer that depends on the records is refused; nothing answers "not
 *     found" and nothing new is queued) until the records are restored from a backup or the user repairs them knowingly;
 *   - lines after the anchored count are an append the anchors had not caught up with yet (a crash): they only add
 *     protection and are adopted, and the anchors are brought forward;
 *   - an anchor behind the other is the same crash (each must still match the chain at its own count);
 *   - a torn last line (no newline) is an append that never completed: cut off before the next append, but only when the
 *     key, batch or recipe it names still has its receipt, batch or recipe file (nothing of it was removed yet); a torn
 *     line that cannot be read that far fails closed.
 * Records are appended (file, then anchors, all synced) before anything they describe is removed. The recipe store's
 * lock guards appends across processes; a reader that does not find a record checks whether the files changed since it
 * read them and reads them again before it answers.
 */
export const QUEUE_TOMBSTONE_FILE = { directory: 'queue-cleaned', name: 'cleaned-v1.jsonl', anchor: 'anchor-v1.json', secondAnchor: 'cleaned-v1.anchor.json' } as const;
const MAX_LINE_BYTES = 8 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CODE = /^[a-z][a-z0-9_]{0,79}$/;
export const CLEANED_ITEM_STATUSES = ['succeeded', 'failed', 'unknown', 'cancelled', 'skipped'] as const;
export type CleanedItemCounts = Record<(typeof CLEANED_ITEM_STATUSES)[number], number>;
/** The requested and resolved output of the enqueue (its receipt's output), kept for the plan identity. */
export interface CleanedOutput { historyGroup?: string; fileNamePrefix?: string; historyGroupId?: string; historyGroupName?: string }
export interface CleanedBatchRecord {
  kind: 'batch'; v: 1;
  /** recipeHash(requestKey): the hash in the receipt's file name (request-<keyHash>.json); the key itself is not kept. */
  keyHash: string; batchId: string; mode: string; status: 'succeeded' | 'partial' | 'cancelled' | 'blocked'; stopCode: string | null;
  count: number; counts: CleanedItemCounts;
  /** The receipt's plan identity; null when the batch had no receipt (not made by this app's enqueue). */
  requestHash: string | null; recipePlanHash: string | null; intervalSeconds: number; output?: CleanedOutput;
  createdAt: string; finishedAt: string; cleanedAt: string;
}
export interface CleanedRecipeRecord { kind: 'recipe'; v: 1; recipeId: string; recipeRevision: number; cleanedAt: string }
/** A key the library knows made images (history queueOrigin) whose record was lost: written by a knowing repair. How the
 * batch ended is unknown; it is accepted and never queued again. */
export interface RecoveredBatchRecord { kind: 'recovered'; v: 1; keyHash: string; batchId: string; savedImages: number; recoveredAt: string }
/** A knowing repair of damaged records (who accepted what was lost), kept in the chain. */
export interface RepairRecord { kind: 'repair'; v: 1; at: string; anchored: number | null; readable: number; recovered: number; problem: string }
export type CleanedRecord = CleanedBatchRecord | CleanedRecipeRecord | RecoveredBatchRecord | RepairRecord;
export type KeyRecord = CleanedBatchRecord | RecoveredBatchRecord;

const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const isObject = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const sameKeys = (value: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const time = (value: unknown) => typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value));
const text = (value: unknown, max: number) => typeof value === 'string' && value.length >= 1 && value.length <= max;
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;

/** The shape check of one record (also run before a record is written). */
export function validCleanedRecord(value: unknown): value is CleanedRecord {
  if (!isObject(value) || value.v !== 1) return false;
  if (value.kind === 'recipe') return sameKeys(value, ['kind', 'v', 'recipeId', 'recipeRevision', 'cleanedAt']) && typeof value.recipeId === 'string' && UUID.test(value.recipeId)
    && Number.isSafeInteger(value.recipeRevision) && value.recipeRevision >= 1 && time(value.cleanedAt);
  if (value.kind === 'recovered') return sameKeys(value, ['kind', 'v', 'keyHash', 'batchId', 'savedImages', 'recoveredAt']) && typeof value.keyHash === 'string' && HASH.test(value.keyHash)
    && typeof value.batchId === 'string' && UUID.test(value.batchId) && count(value.savedImages) && time(value.recoveredAt);
  if (value.kind === 'repair') return sameKeys(value, ['kind', 'v', 'at', 'anchored', 'readable', 'recovered', 'problem']) && time(value.at) && (value.anchored === null || count(value.anchored))
    && count(value.readable) && count(value.recovered) && typeof value.problem === 'string' && CODE.test(value.problem);
  if (value.kind !== 'batch' || !sameKeys(value, ['kind', 'v', 'keyHash', 'batchId', 'mode', 'status', 'stopCode', 'count', 'counts', 'requestHash', 'recipePlanHash', 'intervalSeconds', 'createdAt', 'finishedAt', 'cleanedAt'], ['output'])) return false;
  const counts = value.counts, output = value.output;
  return typeof value.keyHash === 'string' && HASH.test(value.keyHash) && typeof value.batchId === 'string' && UUID.test(value.batchId)
    && ['t2i', 'i2i', 'inpaint', 'enhance', 'upscale', 'director'].includes(value.mode) && ['succeeded', 'partial', 'cancelled', 'blocked'].includes(value.status) && (value.stopCode === null || (typeof value.stopCode === 'string' && CODE.test(value.stopCode)))
    && Number.isSafeInteger(value.count) && value.count >= 1 && value.count <= 200
    && isObject(counts) && sameKeys(counts, [...CLEANED_ITEM_STATUSES]) && CLEANED_ITEM_STATUSES.every(key => count(counts[key]))
    && CLEANED_ITEM_STATUSES.reduce((sum, key) => sum + counts[key], 0) === value.count
    && (value.requestHash === null || (typeof value.requestHash === 'string' && HASH.test(value.requestHash))) && (value.recipePlanHash === null || (typeof value.recipePlanHash === 'string' && HASH.test(value.recipePlanHash)))
    && typeof value.intervalSeconds === 'number' && Number.isFinite(value.intervalSeconds) && value.intervalSeconds >= 0 && value.intervalSeconds <= 3600
    && (output === undefined || (isObject(output) && Object.keys(output).length > 0 && sameKeys(output, [], ['historyGroup', 'fileNamePrefix', 'historyGroupId', 'historyGroupName']) && Object.values(output).every(entry => text(entry, 256))))
    && time(value.createdAt) && time(value.finishedAt) && time(value.cleanedAt);
}

/** Why the records cannot be trusted (Settings › Queue names each, with what to do). */
export type TombstoneProblem = 'records_missing' | 'chain_broken' | 'anchor_missing' | 'anchor_invalid' | 'anchor_mismatch' | 'torn_unverified' | 'read_failed';
export interface TombstoneHealth { state: 'ok' | 'broken'; problem?: TombstoneProblem; detail?: string; anchored: number | null; readable: number }
export class QueueTombstoneError extends Error {
  code = 'queue_storage_failed';
  constructor(public entry: string, public problem: TombstoneProblem, detail: string) {
    super(`The records of cleaned queue batches (${entry} in the data folder) cannot be trusted: ${detail}. Whether a requestKey without a receipt had a batch is unknown, so nothing was looked up or queued for it. Restore the folder runtime/queue-cleaned from a backup, or repair the records in Settings › Queue.`);
  }
}

interface Line { hash: string; prev: string | null; record: CleanedRecord; text: string }
interface Anchor { v: 1; count: number; lastHash: string | null; updatedAt: string }
type AnchorRead = { status: 'missing' } | { status: 'invalid' } | { status: 'valid'; anchor: Anchor };
/** What a torn last line names, as far as it can be read. */
export type TornIdentity = { kind: 'batch' | 'recovered'; keyHash: string; batchId?: string } | { kind: 'recipe'; recipeId: string; recipeRevision: number };

/** One chained line: {prev, kind, <identity first>, …, hash}; the hash binds everything else in it. */
function lineText(prev: string | null, record: CleanedRecord) {
  const body = { prev, ...record }, hash = sha(JSON.stringify(canonical(body)));
  return { hash, text: JSON.stringify({ ...body, hash }) };
}
function parseLine(text: string): Line | null {
  let value: any;
  try { value = JSON.parse(text); } catch { return null; }
  if (!isObject(value) || typeof value.hash !== 'string' || !(value.prev === null || (typeof value.prev === 'string' && HASH.test(value.prev)))) return null;
  const { hash, prev, ...record } = value;
  if (sha(JSON.stringify(canonical({ prev, ...record }))) !== hash || !validCleanedRecord(record)) return null;
  return { hash, prev, record, text };
}
const anchorText = (anchor: Anchor) => JSON.stringify({ ...anchor, hash: sha(JSON.stringify(canonical(anchor))) });
function parseAnchor(text: string): Anchor | null {
  let value: any;
  try { value = JSON.parse(text); } catch { return null; }
  if (!isObject(value) || !sameKeys(value, ['v', 'count', 'lastHash', 'updatedAt', 'hash']) || value.v !== 1 || !count(value.count) || !(value.lastHash === null ? value.count === 0 : typeof value.lastHash === 'string' && HASH.test(value.lastHash) && value.count > 0) || !time(value.updatedAt)) return null;
  const { hash, ...anchor } = value;
  return sha(JSON.stringify(canonical(anchor))) === hash ? anchor as Anchor : null;
}
/** The identity a torn line starts with ({"prev":…,"kind":…,"keyHash":…,"batchId":… or "recipeId":…,"recipeRevision":…}). */
export function tornIdentity(text: string): TornIdentity | null {
  const key = /^\{"prev":(?:null|"[a-f0-9]{64}"),"kind":"(batch|recovered)","keyHash":"([a-f0-9]{64})"(?:,"batchId":"([a-f0-9-]{36})")?/.exec(text);
  if (key) return { kind: key[1] as 'batch' | 'recovered', keyHash: key[2], ...(key[3] && UUID.test(key[3]) ? { batchId: key[3] } : {}) };
  const recipe = /^\{"prev":(?:null|"[a-f0-9]{64}"),"kind":"recipe","recipeId":"([a-f0-9-]{36})","recipeRevision":([1-9]\d*)[,}]/.exec(text);
  if (recipe && UUID.test(recipe[1])) return { kind: 'recipe', recipeId: recipe[1], recipeRevision: Number(recipe[2]) };
  return null;
}
/** A record with its identity fields first, so a torn line can still say what it was about. */
function ordered(record: CleanedRecord): CleanedRecord {
  if (record.kind === 'batch' || record.kind === 'recovered') { const { kind, keyHash, batchId, ...rest } = record as any; return { kind, keyHash, batchId, ...rest }; }
  if (record.kind === 'recipe') { const { kind, recipeId, recipeRevision, ...rest } = record; return { kind, recipeId, recipeRevision, ...rest } as CleanedRecord; }
  return record;
}
const identityOf = (record: CleanedRecord) => record.kind === 'recipe' ? `recipe:${record.recipeId}:${record.recipeRevision}` : record.kind === 'repair' ? `repair:${record.at}` : `key:${record.keyHash}`;

/**
 * The cleaned-batch records of one data root. `anchorDir`: the second anchor's folder (main.ts: <data root>/queue-anchor;
 * default <runtime>/queue-cleaned-anchor, for tests). `pending(identity)`: whether what a torn last line names still has its
 * receipt, batch or recipe file (the recipe store answers).
 */
export function createQueueTombstones(runtimeDir: string, options: { anchorDir?: string; log?: (message: string) => void; pending?: (identity: TornIdentity) => Promise<boolean> } = {}) {
  const root = path.resolve(runtimeDir), directory = path.join(root, QUEUE_TOMBSTONE_FILE.directory), file = path.join(directory, QUEUE_TOMBSTONE_FILE.name);
  const anchorDir = path.resolve(options.anchorDir ?? path.join(root, 'queue-cleaned-anchor'));
  const anchors = [path.join(directory, QUEUE_TOMBSTONE_FILE.anchor), path.join(anchorDir, QUEUE_TOMBSTONE_FILE.secondAnchor)];
  const dataRoot = path.dirname(root), rel = (target: string) => path.relative(dataRoot, target).split(path.sep).join('/');
  const entry = rel(file);
  const log = options.log ?? ((message: string) => console.warn(message));
  const byKey = new Map<string, KeyRecord>(), byBatch = new Map<string, KeyRecord>(), recipes = new Map<string, CleanedRecipeRecord>(), recipeRevisions = new Map<string, Set<number>>();
  let health: TombstoneHealth = { state: 'ok', anchored: null, readable: 0 };
  /** What the last read saw: the chain (complete lines), a torn tail, and file signatures to notice outside changes. */
  let chain: Line[] = [], torn: { bytes: number; identity: TornIdentity | null; cut: boolean } | null = null, seen = '', loaded = false, reading: Promise<void> | null = null, anchorLag = false;
  const adopt = (record: CleanedRecord) => {
    if (record.kind === 'recipe') {
      const key = `${record.recipeId}:${record.recipeRevision}`; if (!recipes.has(key)) recipes.set(key, record);
      let revisions = recipeRevisions.get(record.recipeId); if (!revisions) recipeRevisions.set(record.recipeId, revisions = new Set()); revisions.add(record.recipeRevision); return;
    }
    if (record.kind === 'repair') return;
    const known = byKey.get(record.keyHash);
    // A second record for one key: the first stays (both say "accepted, cleaned"; a key never makes two batches).
    if (known) { if (known.batchId !== record.batchId) log(`[queue-retention] ${entry}: a second cleaned record for one requestKey names another batch (${record.batchId}); the first (${known.batchId}) is kept.`); return; }
    byKey.set(record.keyHash, record); if (!byBatch.has(record.batchId)) byBatch.set(record.batchId, record);
  };
  const signature = async () => (await Promise.all([file, ...anchors].map(target => fs.stat(target, { bigint: true }).then(info => `${info.ino}:${info.size}:${info.mtimeNs}`, () => '-')))).join('|');
  async function readText(target: string, limit: number): Promise<string | null> {
    let handle;
    try { handle = await openNoFollow(target, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error: any) { if (error.code === 'ENOENT' && await underFolders(target)) return null; throw error.code === 'ENOENT' ? Object.assign(new Error('a parent of the path is not a folder'), { code: 'ENOTDIR' }) : error; }
    try { const info = await handle.stat(); if (!info.isFile() || info.size > limit) throw Object.assign(new Error('not a regular file or too large'), { code: 'EINVAL' }); return await handle.readFile('utf8'); }
    finally { await handle.close(); }
  }
  /**
   * Whether the nearest existing ancestor of a missing path is a folder. POSIX reports a path through a file as ENOTDIR;
   * Windows reports it as missing (ENOENT), so a folder replaced by a file would read as absent instead of damaged.
   */
  async function underFolders(target: string) {
    for (let folder = path.dirname(target); ; folder = path.dirname(folder)) {
      try { return (await fs.stat(folder)).isDirectory(); }
      catch (error: any) { if (error.code !== 'ENOENT' || path.dirname(folder) === folder) return false; }
    }
  }
  async function readAnchor(target: string): Promise<AnchorRead> {
    // An anchor that is not a readable regular file (a folder, a dangling path, no permission) counts as changed.
    let textValue: string | null;
    try { textValue = await readText(target, 4096); } catch { return { status: 'invalid' }; }
    if (textValue === null) return { status: 'missing' };
    const anchor = parseAnchor(textValue);
    return anchor ? { status: 'valid', anchor } : { status: 'invalid' };
  }
  /** Reads and checks the file and both anchors; sets the health. Every record read is adopted (none is ever forgotten). */
  async function verify(): Promise<void> {
    const signatureBefore = await signature();
    let content: string | null;
    try { content = await readText(file, 1024 * 1024 * 1024); }
    catch (error: any) { health = { state: 'broken', problem: 'read_failed', detail: `the record file cannot be read (${error?.code ?? 'error'})`, anchored: null, readable: 0 }; seen = signatureBefore; loaded = true; return; }
    const [first, second] = await Promise.all(anchors.map(readAnchor));
    const lines: Line[] = [];
    let problem: TombstoneProblem | null = null, detail = '';
    torn = null;
    if (content !== null) {
      const end = content.lastIndexOf('\n'), complete = end >= 0 ? content.slice(0, end) : '', tail = content.slice(end + 1);
      let at = 0, prev: string | null = null;
      for (const raw of complete ? complete.split('\n') : []) {
        const line = Buffer.byteLength(raw) <= MAX_LINE_BYTES ? parseLine(raw) : null;
        if (!line || line.prev !== prev) { problem = 'chain_broken'; detail = `line ${lines.length + 1} (byte ${at}) is missing, changed or out of order`; break; }
        lines.push(line); adopt(line.record); prev = line.hash; at += Buffer.byteLength(raw) + 1;
      }
      if (!problem && tail) torn = { bytes: Buffer.byteLength(tail), identity: tornIdentity(tail), cut: false };
    }
    const n = lines.length, valid = [first, second].filter((value): value is { status: 'valid'; anchor: Anchor } => value.status === 'valid');
    const anchored = valid.length ? Math.max(...valid.map(value => value.anchor.count)) : null;
    const hashAt = (position: number) => position === 0 ? null : lines[position - 1]?.hash;
    if (!problem) {
      // The record file gone while an anchor says records were written: that is the loss to name (whatever else is gone).
      if (content === null && anchored !== null && anchored > 0) { problem = 'records_missing'; detail = `the record file is missing (${anchored} records were written)`; }
      else if (first.status === 'invalid' || second.status === 'invalid') { problem = 'anchor_invalid'; detail = `the anchor ${rel(anchors[first.status === 'invalid' ? 0 : 1])} is changed or unreadable`; }
      else if (!valid.length) { if (n || torn || content) { problem = 'anchor_missing'; detail = 'both anchors are missing although records exist'; } }
      else if (valid.length === 1 && (valid[0].anchor.count > 0 || n > 0 || torn)) { problem = 'anchor_missing'; detail = `the anchor ${rel(anchors[first.status === 'missing' ? 0 : 1])} is missing`; }
      else if (anchored! > n) { problem = 'records_missing'; detail = content === null ? `the record file is missing (${anchored} records were written)` : `${anchored! - n} of ${anchored} records are missing (the file was cut or lines were removed)`; }
      else if (valid.some(value => hashAt(value.anchor.count) !== value.anchor.lastHash)) { problem = 'anchor_mismatch'; detail = 'an anchor does not match the records'; }
    }
    if (!problem && torn) {
      // An append that never completed names something whose receipt, batch or recipe is still there; anything else fails closed.
      const pending = torn.identity && options.pending ? await options.pending(torn.identity).catch(() => false) : false;
      if (pending) torn.cut = true;
      else { problem = 'torn_unverified'; detail = `the last line is incomplete (${torn.bytes} bytes) and ${torn.identity ? 'what it names was already removed' : 'cannot be read far enough to tell what it names'}`; }
    }
    chain = lines;
    anchorLag = !problem && valid.length === 2 && valid.some(value => value.anchor.count !== n);
    // anchored: what the anchors say (broken: the most any says was written; ok: what both agree on, so a lag shows).
    health = problem ? { state: 'broken', problem, detail, anchored, readable: n } : { state: 'ok', anchored: valid.length ? Math.min(...valid.map(value => value.anchor.count)) : null, readable: n };
    if (problem) log(`[queue-retention] ${entry}: ${detail} (${problem}); answers that depend on the cleaned records are refused until they are restored or repaired.`);
    seen = signatureBefore; loaded = true;
  }
  /** In-process writes (append, repair, restore) run one at a time, and no read starts while one is in progress. */
  let writing: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => { const next = writing.then(work); writing = next.catch(() => undefined); return next; };
  const refresh = () => { reading ??= writing.then(verify).finally(() => { reading = null; }); return reading; };
  /** Reads again only when a file changed since the last read. */
  const refreshIfChanged = async () => { if (!loaded || await signature() !== seen) await refresh(); };
  const brokenError = () => new QueueTombstoneError(entry, health.problem!, health.detail ?? health.problem!);
  /** Known records first; a miss is checked against what another process may have written since. Broken: refused. */
  async function lookup<T>(find: () => T | undefined): Promise<T | null> {
    await refreshIfChanged();
    if (health.state === 'broken') throw brokenError();
    return find() ?? null;
  }
  async function writeAnchor(target: string, anchor: Anchor) {
    const dir = path.dirname(target), temporary = path.join(dir, `.anchor-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(anchorText(anchor)); await handle.sync(); } finally { await handle.close(); }
    try {
      const existing = await fs.lstat(target).catch((error: any) => { if (error.code === 'ENOENT') return null; throw error; });
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('An anchor is not a regular file.');
      if (existing) await renameReplace(temporary, target); else { await fs.link(temporary, target); await fs.unlink(temporary); }
      await syncDirectory(dir);
    } finally { await fs.unlink(temporary).catch(() => undefined); }
  }
  async function ownedDirectory(target: string, parent: string) {
    const parentInfo = await fs.lstat(parent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error('The folder of the cleaned-batch records is not an owned directory.');
    let created = false;
    await fs.mkdir(target, { recursive: false, mode: 0o700 }).then(() => { created = true; }, (error: any) => { if (error.code !== 'EEXIST') throw error; });
    const info = await fs.lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(target) !== path.join(await fs.realpath(parent), path.basename(target))) throw new Error('The folder of the cleaned-batch records is not an owned directory.');
    if (created) await syncDirectory(parent);
  }
  const ensureDirectories = async () => { await ownedDirectory(directory, root); await ownedDirectory(anchorDir, path.dirname(anchorDir)); };
  const anchorAt = (n: number, lastHash: string | null): Anchor => ({ v: 1, count: n, lastHash, updatedAt: new Date().toISOString() });
  const writeAnchors = async (n: number, lastHash: string | null) => { for (const target of anchors) await writeAnchor(target, anchorAt(n, lastHash)); };
  /** Replaces the whole file with these lines (a repair or a restore), then both anchors. */
  async function replaceAll(records: CleanedRecord[]) {
    await ensureDirectories();
    let prev: string | null = null; const texts: string[] = [];
    for (const record of records) { const line = lineText(prev, ordered(record)); texts.push(line.text); prev = line.hash; }
    const temporary = path.join(directory, `.records-${randomUUID()}.tmp`), handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(texts.length ? `${texts.join('\n')}\n` : ''); await handle.sync(); } finally { await handle.close(); }
    try {
      const existing = await fs.lstat(file).catch((error: any) => { if (error.code === 'ENOENT') return null; throw error; });
      if (existing) await renameReplace(temporary, file); else { await fs.link(temporary, file); await fs.unlink(temporary); }
      await syncDirectory(directory);
    } finally { await fs.unlink(temporary).catch(() => undefined); }
    await writeAnchors(texts.length, prev);
    for (const record of records) adopt(record);
    await verify();
  }
  /** Readable records, then those only this process still knows (read from the chain before it was damaged). */
  const salvage = (readable: CleanedRecord[]) => {
    const ids = new Set(readable.map(identityOf)), out = [...readable];
    for (const record of [...byKey.values(), ...recipes.values()]) { const id = identityOf(record); if (!ids.has(id)) { ids.add(id); out.push(record); } }
    return out;
  };
  /** Every complete line of the file that is valid on its own (its own hash), whatever the chain around it. */
  async function readableRecords(content: string | null) {
    const out: CleanedRecord[] = [], seenIds = new Set<string>();
    for (const raw of (content ?? '').split('\n')) {
      const line = raw && Buffer.byteLength(raw) <= MAX_LINE_BYTES ? parseLine(raw) : null;
      if (!line) continue;
      const id = identityOf(line.record); if (seenIds.has(id)) continue; seenIds.add(id); out.push(line.record);
    }
    return out;
  }
  async function appendNow(records: CleanedRecord[]) {
      await verify();
      if (health.state === 'broken') throw brokenError();
      const fresh = records.filter(record => record.kind === 'recipe' ? !recipes.has(`${record.recipeId}:${record.recipeRevision}`) : record.kind === 'repair' || !byKey.has(record.keyHash));
      // Nothing new (the records were synced before a crash, their anchors were not): the anchors catch up now, so a
      // later loss of those lines is noticed.
      if (!fresh.length) { if (anchorLag) { await ensureDirectories(); await writeAnchors(chain.length, chain.at(-1)?.hash ?? null); await verify(); } return 0; }
      for (const record of fresh) if (!validCleanedRecord(record)) throw new Error('Invalid cleaned-batch record.');
      await ensureDirectories();
      // The anchors exist (count 0) before the first line: from then on a missing anchor is damage, never a crash.
      if (!chain.length && !torn) for (const target of anchors) if ((await readAnchor(target)).status !== 'valid') await writeAnchor(target, anchorAt(0, null));
      let prev = chain.at(-1)?.hash ?? null; const texts: string[] = [];
      for (const record of fresh) { const line = lineText(prev, ordered(record)); if (Buffer.byteLength(line.text) > MAX_LINE_BYTES) throw new Error('Cleaned-batch record too long.'); texts.push(line.text); prev = line.hash; }
      const valid = chain.reduce((sum, line) => sum + Buffer.byteLength(line.text) + 1, 0);
      let created = false, handle;
      try { handle = await fs.open(file, constants.O_RDWR | constants.O_NOFOLLOW); }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; handle = await fs.open(file, 'wx', 0o600); created = true; }
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error('The cleaned-batch file is not a regular file.');
        if (stat.size > valid) { await handle.truncate(valid); log(`[queue-retention] ${entry}: an incomplete last line (${stat.size - valid} bytes, an interrupted write whose batch, receipt or recipe is still there) was cut off before appending.`); }
        const data = Buffer.from(`${texts.join('\n')}\n`, 'utf8');
        await handle.write(data, 0, data.length, valid);
        await handle.sync();
      } finally { await handle.close(); }
      if (created) await syncDirectory(directory);
      await writeAnchors(chain.length + texts.length, prev);
      for (const record of fresh) adopt(record);
      await verify();
      return fresh.length;
  }
  /**
   * A backup's records, added to what is here (only ever added). Damaged records are restored only when the backup's
   * lines and the readable ones here link into one chain that reaches what the anchors here (or, without them, the
   * backup's) say was written; otherwise nothing changes and the store stays refused. Healthy records get the backup's
   * unknown ones appended. The caller holds the recipe store's lock.
   */
  async function restoreNow(files: Array<{ name: string; data: Buffer }>): Promise<{ status: 'unchanged' | 'added' | 'restored' | 'incomplete'; added: number }> {
    const backupText = files.find(item => item.name === 'cleaned-v1.jsonl')?.data.toString('utf8') ?? '';
    const backupAnchors = files.filter(item => item.name.startsWith('anchor-')).map(item => parseAnchor(item.data.toString('utf8'))).filter((value): value is Anchor => Boolean(value));
    await verify();
    const backupRecords = await readableRecords(backupText);
    if (health.state === 'ok') {
      const missing = backupRecords.filter(record => record.kind !== 'repair' && !(record.kind === 'recipe' ? recipes.has(`${record.recipeId}:${record.recipeRevision}`) : byKey.has(record.keyHash)));
      if (!missing.length) return { status: 'unchanged', added: 0 };
      return { status: 'added', added: await appendNow(missing) };
    }
    // Splice: from the start, follow prev links through the lines of both sources.
    const hereText = await readText(file, 1024 * 1024 * 1024).catch(() => null) ?? '';
    const next = new Map<string | null, Line>();
    for (const raw of [...backupText.split('\n'), ...hereText.split('\n')]) {
      const line = raw && Buffer.byteLength(raw) <= MAX_LINE_BYTES ? parseLine(raw) : null;
      if (line && !next.has(line.prev)) next.set(line.prev, line);
    }
    const spliced: Line[] = []; let current: string | null = null;
    for (let line = next.get(current); line && spliced.length <= next.size; line = next.get(current)) { spliced.push(line); current = line.hash; }
    const here = (await Promise.all(anchors.map(readAnchor))).flatMap(value => value.status === 'valid' ? [value.anchor] : []);
    const target = [...(here.length ? here : backupAnchors)].sort((a, b) => b.count - a.count)[0] ?? null;
    const reaches = target ? spliced.length >= target.count && (target.count === 0 || spliced[target.count - 1]?.hash === target.lastHash) : spliced.length > 0;
    if (!reaches) return { status: 'incomplete', added: 0 };
    const ids = new Set(spliced.map(line => identityOf(line.record)));
    const extra = [...backupRecords, ...await readableRecords(hereText)].filter(record => { const id = identityOf(record); if (ids.has(id)) return false; ids.add(id); return true; });
    await replaceAll([...spliced.map(line => line.record), ...extra]);
    return { status: 'restored', added: extra.length };
  }
  return {
    file, entry, anchors: anchors.map(rel),
    /** Reads the file and anchors (at start, and again when they changed). */
    load: () => refreshIfChanged(),
    health: () => ({ ...health }),
    byKeyHash: (keyHash: string) => lookup(() => byKey.get(keyHash)),
    byBatchId: (batchId: string) => lookup(() => byBatch.get(batchId)),
    recipe: (recipeId: string, recipeRevision: number) => lookup(() => recipes.get(`${recipeId}:${recipeRevision}`)),
    /** The revisions of one recipe reclaimed so far (never reused for a new revision). */
    reclaimedRevisions: async (recipeId: string) => { await lookup(() => true); return [...(recipeRevisions.get(recipeId) ?? [])]; },
    /** Synchronous view of what is known (no re-read): for counts and the cleaner's own bookkeeping. */
    known: { keyHash: (keyHash: string) => byKey.get(keyHash) ?? null, batchId: (batchId: string) => byBatch.get(batchId) ?? null, batchIds: () => [...byBatch.keys()], batches: () => byKey.size, recipes: () => recipes.size,
      /** Keys recorded from the library (history queueOrigin) rather than by a cleaning. */
      recovered: () => [...byKey.values()].filter(record => record.kind === 'recovered').length },
    /** Whether the anchors are behind the (healthy) chain: a crash after the lines were synced (settleAnchors). */
    anchorsBehind: () => health.state === 'ok' && anchorLag,
    /**
     * Appends records and syncs them (file, then both anchors) before returning. The caller holds the recipe store's lock,
     * so no other process appends at the same time. Records already known are skipped. Refused while the records are damaged.
     */
    append(records: CleanedRecord[]) { return exclusive(() => appendNow(records)); },
    async settleAnchors() { return exclusive(async () => { await verify(); if (health.state === 'ok' && anchorLag) { await ensureDirectories(); await writeAnchors(chain.length, chain.at(-1)?.hash ?? null); await verify(); } }); },
    /** What a knowing repair would keep: every line still valid on its own, and every record this process read before
     * the damage (a verified chain it once held), none twice. */
    async readable() { await refresh(); return salvage(await readableRecords(await readText(file, 1024 * 1024 * 1024).catch(() => null))); },
    /**
     * A knowing repair (Settings › Queue, after the user confirmed what may be lost): every readable record, then `extra`
     * (keys recovered from the library) and a repair line, written as a new chain with new anchors. The caller holds the
     * recipe store's lock.
     */
    repair(extra: CleanedRecord[], info: Omit<RepairRecord, 'kind' | 'v' | 'at'>) {
      return exclusive(async () => {
        const kept = salvage(await readableRecords(await readText(file, 1024 * 1024 * 1024).catch(() => null))), ids = new Set(kept.map(identityOf));
        const added = extra.filter(record => { const id = identityOf(record); if (ids.has(id)) return false; ids.add(id); return true; });
        await replaceAll([...kept, ...added, { kind: 'repair', v: 1, at: new Date().toISOString(), ...info }]);
        return { kept: kept.length, added: added.length };
      });
    },
    restore(files: Array<{ name: string; data: Buffer }>) { return exclusive(() => restoreNow(files)); },
    /** The files a backup carries (the record file and both anchors), as they are. */
    async exportFiles() {
      await writing;
      const out: Array<{ name: string; data: Buffer }> = [];
      for (const [name, target] of [['cleaned-v1.jsonl', file], ['anchor-a.json', anchors[0]], ['anchor-b.json', anchors[1]]] as const) {
        try { out.push({ name, data: await fs.readFile(target) }); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      }
      return out;
    },
  };
}
export type QueueTombstones = ReturnType<typeof createQueueTombstones>;
