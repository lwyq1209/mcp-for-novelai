import { createHash, randomInt, randomUUID } from 'node:crypto';
import { GENERATION_MODES, type GenerationSnapshot } from '../src/workspace/generation-types';
import { isBatchTerminal, MANUAL_BATCH_MAX_ITEMS, QUEUED_BATCH_MAX_ITEMS as MAX_BATCH_ITEMS, type BatchChildJob, type BatchGenerationPort, type BatchItem, type BatchJob, type BatchRequest, type BatchSource } from '../src/workspace/batch-types';
import { parseBatchScenes } from '../src/workspace/scene-patch';
import { batchSeedInputError, isValidBatchSeed as validSeed, MAX_BATCH_SEED as MAX_SEED } from '../src/workspace/batch-seeds';
import { withReason } from './host-error';
import { plainClientText } from '../src/agent-clients';
import { createBatchStorage, FROZEN_COMPACTION_POLICY, frozenBatchCompactionDue, MAX_FROZEN_BATCH_INPUT_BYTES, BatchCompactionDeferredError, BatchInputError, BatchQuotaError, BatchStorageError, type FrozenBatchInput, type FrozenQueueCapacity, type BatchStorage, type StoredFrozenBatchInput } from './batch-storage';
import { upstreamReason } from './upstream-reason';

export class BatchError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export interface BatchDependencies {
  generation: BatchGenerationPort;
  isBusy?(): boolean;
  /**
   * Why the queue holds now (the app is handing over to its update helper), or null. While it is set no image starts
   * (a batch waits right before its next submit, as for isBusy); batches still queue, and every queued batch without a
   * stop reason of its own shows this one (expose). holdChanged() publishes the queued batches again when it changes.
   */
  holdReason?(): { code: string; message: string } | null;
  onBatch?(batch: BatchJob): void;
  randomSeed?(): number;
  wait?(milliseconds: number): Promise<void>;
  runtimeDir?: string;
  storage?: BatchStorage;
  /** Unfinished items all queued batches may hold together, read at every enqueue (the queueMaxPendingItems
   * setting; null = no limit). Default QUEUED_PENDING_ITEM_LIMIT. */
  pendingItemLimit?(): number | null;
  /** Operational notes (default console.warn, which the main-process logger records). */
  log?(message: string): void;
  /** Tests only: the delay of a deferred state write (default BATCH_STATE_FLUSH_MS). */
  stateFlushMs?: number;
  /** Tests only: the pauses before each resend after HTTP 429 (default RATE_LIMIT_RETRY.delaysMs). */
  rateLimitDelaysMs?: readonly number[];
  /** Tests only: how long a failing read-only lookup or status read is tried again (default CHILD_READ_RETRY_MS). */
  childReadRetryMs?: number;
  /** Batches retire() removed (queue retention): the window's queue view drops them. */
  onRemoved?(batchIds: string[]): void;
  /**
   * The images the library saved for one item of a durable batch (history queueOrigin batchId + itemIndex), read when a
   * restart finds the item in flight (review rework 2026-11): an image that was saved before the app died is the
   * item's result (it succeeded and was charged); without one the item stays unknown. main.ts reads the library.
   */
  savedResults?(batchId: string, itemIndex: number): Array<{ id: string; width: number; height: number; model: string; actualSeed: number | null; jobId: string | null }>;
}
/**
 * manual (step 4a): a batch of the window's Generate click. It lives only in this process (never stored, never
 * recovered), runs in the same FIFO as the durable batches and is paused, resumed and cancelled the same way; prepare
 * shapes each item's snapshot right before it is submitted (the window's per-image wildcards).
 */
interface ManualEntry { prepare?: (snapshot: GenerationSnapshot, index: number) => GenerationSnapshot; source?: { bytes: Buffer; mimeType: string } }
interface Entry { public: BatchJob; fingerprint: string; snapshots?: GenerationSnapshot[]; working: boolean; pauseRequested: boolean; nextAt: number; cancelSent: Set<string>; sequence?: number; payloadHash?: string; persistedState?: string; compactedAt?: string; manual?: ManualEntry;
  /** The state save in flight (its state key), so an identical write waits for it instead of writing again. */
  saving?: { key: string; done: Promise<void> };
  /** A deferred write (durable 'later') waiting for BATCH_STATE_FLUSH_MS. */
  flushTimer?: ReturnType<typeof setTimeout> | null }
/** `capacity()` of the durable frozen queue, from the storage's latest scan. */
export type BatchCapacity = FrozenQueueCapacity;
/** Default of the unfinished (pending, submitting or running) items all queued batches may hold together; the
 * client's queueMaxPendingItems setting replaces it (deps.pendingItemLimit). */
export const QUEUED_PENDING_ITEM_LIMIT = 200;
/** Items one queued batch may hold at most, whatever the per-enqueue setting says (the MCP schema bound too).
 * Stored batches are checked against this, so lowering the setting never invalidates an accepted batch. */
export const QUEUED_BATCH_MAX_ITEMS = MAX_BATCH_ITEMS;
/** A manual batch (the window's Generate) takes as many images and as long a pause as the window always offered. */
/** Its seeds are NovelAI's whole range (0 … 2^32 − 1), like the window's seed field. */
export const MANUAL_BATCH_LIMITS = Object.freeze({ items: MANUAL_BATCH_MAX_ITEMS, intervalSeconds: 3600, maxSeed: 0xffff_ffff });
const seedWithin = (maxSeed?: number) => maxSeed === undefined ? validSeed : (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maxSeed;
/** `queueAdmission()`: what a caller needs to know before committing a queued submission of its own.
 * pendingItemLimit null: the user chose no limit. */
export interface BatchAdmission { pendingItems: number; pendingItemLimit: number | null }
/** Durable queued batches carry every recipe mode, post-processing (upscale, director) included. The linked canvas
 * batches (submit_batch, every image behind a workspace checkpoint) were retired on 2026-11-02. */
const QUEUED_BATCH_MODES: readonly string[] = GENERATION_MODES;
/** Backoff for a compaction deferred before publication (input held open): 1, 2, 4 … minutes, at most an hour. */
const COMPACTION_RETRY_BASE_MS = 60 * 1000, COMPACTION_RETRY_MAX_MS = 60 * 60 * 1000;
/** Batch events (onBatch, the window's queue view and manual tracking): batches above `items` images push their
 * progress at most every `intervalMs` (changes of status at once), since every event carries all their items. */
export const BATCH_EVENT_THROTTLE = Object.freeze({ items: 20, intervalMs: 250 });
/**
 * Frozen-queue state writes (durable): a state the payment safety depends on is written before the call that needs it
 * returns — the planned image marked as possibly sent (providerOutcome unknown) before the request, an image's settled
 * outcome (ended child, NovelAI's answer received, or an image marked failed or unknown without one), a resend after
 * HTTP 429, every pause, cancel, resume and ending and the state recovered after a restart. Progress that changes nothing a restart relies on
 * (the running image's job ID while it runs, the gap between two images) is written later, merged into the next
 * write, and at the latest after this delay. A restart reads the not yet written progress as the earlier state, which
 * recovers exactly as the later one would (an image marked possibly sent stays unknown and is never resent).
 */
export const BATCH_STATE_FLUSH_MS = 2000;
/** One background round compacts at most this many batches; a capacity-driven reclaim at most 8. */
export const BATCH_COMPACTION_ROUND_LIMIT = 50, BATCH_RECLAIM_LIMIT = 8;
/**
 * NovelAI answered HTTP 429 to an image (a refusal before any work, e.g. "Concurrent generation is locked"; the response
 * was received, nothing was generated): the same image is sent again with its frozen recipe after each of these pauses
 * (about 60 s in all), then it fails as rate_limited and the batch goes on. Only a received 429 counts; a timeout, a
 * dropped connection or any unknown outcome is never resent.
 */
export const RATE_LIMIT_RETRY = Object.freeze({ delaysMs: Object.freeze([2000, 4000, 8000, 16_000, 30_000]) as readonly number[] });
/** A read-only lookup or status read of the generation service that fails is tried again for this long (growing
 * pauses) before the image is marked unknown (never resent) and the batch goes on. */
export const CHILD_READ_RETRY_MS = 90_000;
/** Recent image times kept for the time-left estimate (position). */
export const IMAGE_TIME_SAMPLES = 20;
/** Refusals of the generation service before any request was sent: the image failed, nothing was sent. */
const REFUSED_BEFORE_SENDING = new Set(['invalid_arguments', 'invalid_configuration', 'unsupported_mode', 'unsupported_reference', 'unsupported_configuration', 'invalid_image', 'unavailable']);
/** The child request key of an image's current attempt: its own key, then one per resend after a 429 (`-r1`, `-r2` …). */
const childRequestKey = (item: Pick<BatchItem, 'requestKey' | 'rateLimitRetries'>) => item.rateLimitRetries ? `${item.requestKey}-r${item.rateLimitRetries}` : item.requestKey;
/** Where a batch stands in the shared FIFO (position): unfinished images and batches before it, and the time left. */
export interface BatchPosition { ahead: { images: number; batches: number }; etaSeconds: number | null; imageSeconds: number | null }
const terminalChild = new Set(['succeeded', 'failed', 'cancelled', 'unknown']);
function fail(code: string, message: string): never { throw new BatchError(code, message); }
function record(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_arguments', 'Batch arguments must be an object.');
  return raw as Record<string, any>;
}
function identifier(raw: unknown, name: string) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 120 || /[\x00-\x1f]/.test(raw)) return fail('invalid_arguments', `${name} is invalid.`);
  return raw;
}
function preflight(value: unknown, maximum = MAX_FROZEN_BATCH_INPUT_BYTES) {
  let nodes = 0, bytes = 0; const stack: Array<{ item: unknown; depth: number; exit?: boolean }> = [{ item: value, depth: 0 }], active = new WeakSet<object>();
  const stringBytes = (text: string) => { let size = Buffer.byteLength(text) + 2; for (let index = 0; index < text.length; index++) { const code = text.charCodeAt(index); if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) size++; else if (code < 32) size += 5; } return size; };
  while (stack.length) {
    const frame = stack.pop()!, { item, depth } = frame; if (frame.exit) { active.delete(item as object); continue; }
    if (++nodes > 750_000 || depth > 96) return fail('queue_input_too_large', 'The frozen queue input is structurally too large.');
    if (typeof item === 'string') bytes += stringBytes(item);
    else if (item && typeof item === 'object') {
      if (active.has(item as object)) return fail('invalid_arguments', 'The frozen queue input must not be cyclic.'); active.add(item as object); stack.push({ item, depth, exit: true });
      if (Array.isArray(item)) { bytes += item.length + 2; for (let index = item.length - 1; index >= 0; index--) stack.push({ item: item[index], depth: depth + 1 }); }
      else { const names = Object.keys(item); bytes += names.length + 2; for (let index = names.length - 1; index >= 0; index--) { const key = names[index]; bytes += stringBytes(key) + 1; stack.push({ item: (item as Record<string, unknown>)[key], depth: depth + 1 }); } }
    } else if (item === null || ['number', 'boolean'].includes(typeof item)) bytes += 32;
    else if (item !== undefined) return fail('invalid_arguments', 'The frozen queue input contains an unsupported value.');
    if (bytes > maximum) return fail('queue_input_too_large', 'The frozen queue input exceeds its size limit.');
  }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}
/** SHA256 of UTF-8 JSON.stringify(recursively key-sorted raw parsed scenes).
 * Array order and authored parameter values are retained; no recipe normalization. */
export function scenePlanHash(scenes: NonNullable<BatchRequest['scenes']>): string {
  preflight(scenes); return createHash('sha256').update(JSON.stringify(canonical(scenes)), 'utf8').digest('hex');
}
function parse(raw: unknown, limits: { items: number; intervalSeconds: number; maxSeed?: number } = { items: QUEUED_BATCH_MAX_ITEMS, intervalSeconds: 60 }): BatchRequest {
  preflight(raw); const value = record(raw);
  const workspaceId = identifier(value.workspaceId, 'Workspace ID'), requestKey = identifier(value.requestKey, 'Request key');
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) return fail('invalid_arguments', 'Invalid workspace revision.');
  if (value.execution !== 'queued') return fail('invalid_arguments', 'Only frozen queue batches (execution: queued) are accepted; canvas batches were retired.');
  if (!QUEUED_BATCH_MODES.includes(value.mode)) return fail('unsupported_mode', 'Queued batches support text-to-image, img2img, inpaint, enhance, upscale and the Director tools only.');
  if (!Number.isSafeInteger(value.count) || value.count < 1 || value.count > limits.items) return fail('invalid_arguments', `A queued batch has 1–${limits.items} images.`);
  if (typeof value.intervalSeconds !== 'number' || !Number.isFinite(value.intervalSeconds) || value.intervalSeconds < 0 || value.intervalSeconds > limits.intervalSeconds) return fail('invalid_arguments', `The pause between images is 0–${limits.intervalSeconds} seconds.`);
  if (Object.hasOwn(value, 'seeds') === Object.hasOwn(value, 'seedMode')) return fail('invalid_arguments', 'Provide either seedMode or explicit seeds, not both.');
  if (Object.hasOwn(value, 'seeds') && (!Array.isArray(value.seeds) || value.seeds.length !== value.count || !value.seeds.every(seedWithin(limits.maxSeed)))) return fail('invalid_arguments', 'seeds must hold one valid integer seed per image.');
  if (Object.hasOwn(value, 'seedMode') && !['increment', 'random', 'fixed'].includes(value.seedMode)) return fail('invalid_arguments', 'Invalid seed mode.');
  const scenes = value.scenes === undefined ? undefined : parseBatchScenes(value.scenes, value.count, value.mode, true);
  const draftId = value.draftId === undefined ? undefined : identifier(value.draftId, 'Draft ID');
  if (draftId !== undefined && scenes) return fail('invalid_arguments', 'A single-recipe draft and a multi-scene plan cannot be submitted together.');
  return { workspaceId, requestKey, expectedRevision: value.expectedRevision, mode: value.mode, count: value.count, intervalSeconds: value.intervalSeconds, ...(Object.hasOwn(value, 'seeds') ? { seeds: [...value.seeds] } : { seedMode: value.seedMode }), ...(scenes ? { scenes } : {}), ...(draftId === undefined ? {} : { draftId }), execution: 'queued' as const };
}
// The bridge hands names in as plain text (plainClientText); one that still carries invisible format characters is refused.
const sourceText = (value: unknown, max: number) => typeof value === 'string' && plainClientText(value, max) === value;
/** The source an agent enqueue names (queue-recipe-service); absent stays absent (read as an agent batch of unknown client). */
function agentSource(raw: unknown): BatchSource | undefined {
  if (raw === undefined) return undefined;
  const value = record(raw), client = value.client;
  if (value.kind !== 'agent' || Object.keys(value).some(key => !['kind', 'client'].includes(key))) return fail('invalid_arguments', 'Invalid batch source.');
  if (client === null) return { kind: 'agent', client: null };
  const named = record(client);
  if (!sourceText(named.name, 100) || (named.version !== null && !sourceText(named.version, 50)) || Object.keys(named).some(key => !['name', 'version'].includes(key))) return fail('invalid_arguments', 'Invalid batch source client.');
  return { kind: 'agent', client: { name: named.name, version: named.version } };
}
/** NovelAI's cleaned answer to a failed agent image (upstream-reason.ts), window only (step 4c1). */
const upstreamField = (value: unknown) => { const upstream = upstreamReason(value); return upstream ? { upstream } : {}; };
/** A refusal's window reason and placeholder values (host-error.ts), for a manual item's error. */
function reasonOf(error: unknown): { reason?: string; params?: Record<string, string | number> } {
  const value = error as { reason?: unknown; params?: unknown } | null;
  if (typeof value?.reason !== 'string') return {};
  const params = value.params && typeof value.params === 'object' && !Array.isArray(value.params)
    ? Object.fromEntries(Object.entries(value.params as Record<string, unknown>).filter((entry): entry is [string, string | number] => typeof entry[1] === 'string' || (typeof entry[1] === 'number' && Number.isFinite(entry[1])))) : undefined;
  return { reason: value.reason, ...(params && Object.keys(params).length ? { params } : {}) };
}
function errorCode(error: unknown): string { return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'batch_error'; }
const snapshotHash = (input: Record<string, any>) => createHash('sha256').update(JSON.stringify(canonical(input.snapshots ?? [input.snapshot])), 'utf8').digest('hex');
/** A durable queued batch derives a missing i2i/enhance extra-noise seed from its own identity
 * (workspace, requestKey, snapshot index) instead of drawing it. The frozen input then stores the
 * resolved seed, payloadHash is the hash of exactly what is stored, and preparing the same request
 * again — a same-key retry, in this or a restarted process — yields the same recipes and hash. */
const QUEUED_NOISE_SEED_DOMAIN = 'novelai.frozen-batch.extra-noise-seed/v1';
export const queuedExtraNoiseSeed = (workspaceId: string, requestKey: string, index: number) =>
  createHash('sha256').update(JSON.stringify([QUEUED_NOISE_SEED_DOMAIN, workspaceId, requestKey, index]), 'utf8').digest().readUIntBE(0, 6) % MAX_SEED + 1;
/** A zero noise seed means "choose randomly" to the single-image service. Resolve it once so only the
 * explicitly planned main seed varies: a queued batch derives it from its own identity. */
function resolveNoiseSeeds(snapshots: GenerationSnapshot[], args: BatchRequest) {
  if (!['i2i', 'enhance'].includes(args.mode)) return;
  for (const [index, snapshot] of snapshots.entries()) if (snapshot?.i2i && !(snapshot.i2i.extraNoiseSeed > 0))
    snapshot.i2i.extraNoiseSeed = queuedExtraNoiseSeed(args.workspaceId, args.requestKey, index);
}
/** payloadHash of a queued submission: its snapshots after the same noise-seed resolution prepareEntry applies. */
const queuedPayloadHash = (input: Record<string, any>, args: BatchRequest) => { const snapshots = structuredClone(input.snapshots ?? [input.snapshot]) as GenerationSnapshot[]; resolveNoiseSeeds(snapshots, args); return snapshotHash({ snapshots }); };

/** Only schedules existing single-request jobs of the durable recipe queue. There is no direct provider call
 * or retry path for an uncertain child submission. Inputs and state are durable. */
export function createBatchService(deps: BatchDependencies) {
  const entries = new Map<string, Entry>(), requests = new Map<string, string>();
  /** Request keys of batches retire() removed in this process: never queued again here (the recipe service's cleaned records answer for them). */
  const retired = new Set<string>();
  const latestChildren = new Map<string, BatchChildJob>();
  const wait = deps.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let disposed = false;
  const storage = deps.storage ?? (deps.runtimeDir ? createBatchStorage(deps.runtimeDir) : undefined);
  /** The current pending-item limit; a missing or invalid value from the setting falls back to the default. */
  const pendingItemLimit = (): number | null => {
    if (!deps.pendingItemLimit) return QUEUED_PENDING_ITEM_LIMIT;
    const value = deps.pendingItemLimit();
    return value === null || (Number.isSafeInteger(value) && value >= 1) ? value : QUEUED_PENDING_ITEM_LIMIT;
  };
  let storageError: BatchError | null = null, storageReady = !storage, sequence = 0, draining = false;
  const rateLimitDelays = () => deps.rateLimitDelaysMs ?? RATE_LIMIT_RETRY.delaysMs;
  const childReadRetryMs = () => deps.childReadRetryMs ?? CHILD_READ_RETRY_MS;
  /** How long recent images took (submit to end, ms; succeeded only, newest last), for the time-left estimate. */
  const durations: number[] = [];
  const medianImageMs = () => { if (!durations.length) return null; const sorted = [...durations].sort((a, b) => a - b), middle = sorted.length >> 1; return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
  const sampleDuration = (item: BatchItem) => {
    if (item.status !== 'succeeded') return;
    const took = Date.parse(item.finishedAt ?? '') - Date.parse(item.startedAt ?? '');
    if (Number.isFinite(took) && took >= 0) { durations.push(took); if (durations.length > IMAGE_TIME_SAMPLES) durations.shift(); }
  };
  /** A frozen-queue storage failure stops the durable (agent) batches; a manual batch is never stored and runs on. */
  const stoppedByStorage = (entry: Entry) => Boolean(storageError) && !entry.manual;
  let accepting = Promise.resolve();
  let drainTask: Promise<void> | null = null;
  // Single-threaded background compaction of ended MCP batches (storage decides eligibility).
  let compactionTimer: ReturnType<typeof setTimeout> | null = null, compactionRun: Promise<unknown> = Promise.resolve();
  /** A compaction deferred before publication is retried for that batch only, after a growing backoff. */
  const compactionRetries = new Map<string, number>();
  const log = deps.log ?? ((message: string) => console.warn(message));
  const compactionDue = new Map<string, number>(), compactionSkipped = new Set<string>();
  const sameChild = (left: BatchChildJob, right: BatchChildJob) => left.jobId === right.jobId && left.requestKey === right.requestKey && left.originWorkspaceId === right.originWorkspaceId && left.submittedRevision === right.submittedRevision && left.mode === right.mode;
  const providerRank = { not_submitted: 0, unknown: 1, response_received: 2 } as const;
  const childStatusRank: Record<string, number> = { preparing: 0, running: 1, cancelling: 2, unknown: 3, cancelled: 4, failed: 5, succeeded: 6 };
  function mergeChild(current: BatchChildJob, observed: BatchChildJob): BatchChildJob {
    if (!sameChild(current, observed)) throw new BatchError('child_identity_mismatch', 'The child job read back differs from the tracked one.');
    const currentTerminal = terminalChild.has(current.status), observedTerminal = terminalChild.has(observed.status);
    const time = (value: BatchChildJob) => Number.isFinite(Date.parse(value.updatedAt)) ? Date.parse(value.updatedAt) : -1;
    const evidence = (value: BatchChildJob) => providerRank[value.providerOutcome ?? 'unknown'] * 100 + Math.min(value.results?.length ?? 0, 20) * 10 + (childStatusRank[value.status] ?? -1);
    let primary: BatchChildJob, secondary: BatchChildJob;
    if (currentTerminal !== observedTerminal) [primary, secondary] = currentTerminal ? [current, observed] : [observed, current];
    else if (currentTerminal && observedTerminal) [primary, secondary] = evidence(observed) > evidence(current) || (evidence(observed) === evidence(current) && time(observed) > time(current)) ? [observed, current] : [current, observed];
    else [primary, secondary] = time(observed) > time(current) || (time(observed) === time(current) && evidence(observed) > evidence(current)) ? [observed, current] : [current, observed];
    const merged = structuredClone(primary);
    if (primary.providerOutcome === 'response_received' || secondary.providerOutcome === 'response_received') merged.providerOutcome = 'response_received';
    else if (terminalChild.has(primary.status) && primary.providerOutcome === 'not_submitted') merged.providerOutcome = 'not_submitted';
    else merged.providerOutcome = primary.providerOutcome === 'unknown' || secondary.providerOutcome === 'unknown' || primary.providerOutcome === undefined || secondary.providerOutcome === undefined ? 'unknown' : 'not_submitted';
    if ((!merged.results?.length || (secondary.results?.length ?? 0) > merged.results.length) && secondary.results?.length) merged.results = structuredClone(secondary.results);
    if (merged.actualSeed === null && secondary.actualSeed !== null) merged.actualSeed = secondary.actualSeed;
    if (!merged.providerRequestId && secondary.providerRequestId) merged.providerRequestId = secondary.providerRequestId;
    return merged;
  }
  const unsubscribe = deps.generation.subscribe?.((job) => {
    const current = latestChildren.get(job.jobId);
    try { latestChildren.set(job.jobId, current ? mergeChild(current, job) : structuredClone(job)); }
    catch { /* A colliding child identity cannot replace the tracked projection. */ }
  });
  // Compaction metadata is a projection only; it is never written into the state chain.
  const held = (entry: Entry) => { const reason = entry.public.status === 'queued' && !entry.public.error ? deps.holdReason?.() ?? null : null; return reason ? { error: { code: reason.code, message: reason.message } } : {}; };
  const expose = (entry: Entry, workspaceId = entry.public.checkpointWorkspaceId): BatchJob & { inputCompacted?: true; compactedAt?: string } => structuredClone({ ...entry.public, workspaceId, ...held(entry), ...(entry.compactedAt ? { inputCompacted: true as const, compactedAt: entry.compactedAt } : {}) });
  const push = (entry: Entry) => { try { deps.onBatch?.(expose(entry)); } catch { /* Closing UI must not alter an accepted batch. */ } };
  /** Large batches: the last push and a pending trailing push per batch (BATCH_EVENT_THROTTLE). */
  const pushed = new Map<string, { at: number; status: string; timer: ReturnType<typeof setTimeout> | null }>();
  // updatedAt rises with every event of a batch (by 1 ms when several fall in one), so a window can order them.
  // Every event of a batch up to BATCH_EVENT_THROTTLE.items images goes out; a larger one (each event carries all its
  // items) pushes a change of status at once and its progress within one status at most every intervalMs, always
  // ending with its latest state.
  const emit = (entry: Entry) => {
    const now = Date.now(), last = Date.parse(entry.public.updatedAt); entry.public.updatedAt = new Date(Number.isFinite(last) && last >= now ? last + 1 : now).toISOString();
    if (!deps.onBatch) return;
    if (entry.public.count <= BATCH_EVENT_THROTTLE.items) { push(entry); return; }
    const id = entry.public.batchId, state = pushed.get(id), terminal = isBatchTerminal(entry.public.status);
    if (!state || state.status !== entry.public.status || terminal || now - state.at >= BATCH_EVENT_THROTTLE.intervalMs) {
      if (state?.timer) clearTimeout(state.timer);
      if (terminal) pushed.delete(id); else pushed.set(id, { at: now, status: entry.public.status, timer: null });
      push(entry); return;
    }
    if (state.timer) return;
    state.timer = setTimeout(() => { state.timer = null; state.at = Date.now(); push(entry); }, Math.max(0, BATCH_EVENT_THROTTLE.intervalMs - (now - state.at)));
    state.timer.unref?.();
  };
  // A terminal batch can never submit again (resume only accepts paused), so its
  // frozen recipes, including image bytes, leave main-process memory now.
  const finish = (entry: Entry, status: 'succeeded' | 'partial' | 'cancelled') => { entry.public.status = status; entry.public.activeIndex = null; entry.public.activeJobId = null; entry.public.finishedAt = new Date().toISOString(); delete entry.public.pausedBy; entry.snapshots = undefined; if (entry.manual) entry.manual.source = undefined; emit(entry); scheduleCompaction(); };
  const pendingItems = (entry: Entry, status: 'cancelled' | 'skipped') => { for (const item of entry.public.items) if (item.status === 'pending') item.status = status; };
  /** Every image had its turn: succeeded when all of them did, else partial (failed and unknown images are never resent). */
  const complete = (entry: Entry) => {
    if (entry.public.error?.code !== 'scheduler_stopped') entry.public.error = null;
    finish(entry, entry.public.items.every(item => item.status === 'succeeded') ? 'succeeded' : 'partial');
  };
  const pauseFor = (entry: Entry, code: string, message: string) => {
    if (isBatchTerminal(entry.public.status)) return;
    if (entry.public.cancelRequested) { pendingItems(entry, 'cancelled'); finish(entry, 'cancelled'); return; }
    entry.pauseRequested = true; entry.public.status = 'paused'; entry.public.activeIndex = null; entry.public.activeJobId = null; entry.public.error = { code, message }; emit(entry);
  };
  const lookup = (raw: unknown, limits?: typeof MANUAL_BATCH_LIMITS) => {
    if (storageError) throw storageError;
    if (!storageReady) return fail('queue_unavailable', 'The frozen queue records are still being read.');
    const args = parse(raw, limits), key = JSON.stringify([args.workspaceId, args.requestKey]);
    const id = requests.get(key); if (!id) return null;
    const entry = entries.get(id)!;
    if (entry.fingerprint !== JSON.stringify(canonical(args))) return fail('request_conflict', 'This requestKey already names a different batch plan; read the original batch.');
    const value = record(raw);
    if (args.execution === 'queued' && (value.snapshot !== undefined || value.snapshots !== undefined) && entry.payloadHash !== (entry.manual ? snapshotHash(value) : queuedPayloadHash(value, args))) return fail('request_conflict', 'The frozen recipes under this request key differ; the earlier batch cannot be reused.');
    return expose(entry, args.workspaceId);
  };
  /** The batch a manual requestKey names (a key of a durable batch is a conflict, never its batch). */
  const manualByKey = (workspaceId: string, requestKey: string) => {
    const id = requests.get(JSON.stringify([workspaceId, requestKey])); if (!id) return null;
    const entry = entries.get(id)!;
    if (!entry.manual) return fail('request_conflict', 'This requestKey already belongs to an agent batch.');
    return expose(entry);
  };
  const find = (raw: unknown) => {
    const args = record(raw), workspaceId = identifier(args.workspaceId, 'Workspace ID'), batchId = identifier(args.batchId, 'Batch ID');
    const entry = entries.get(batchId); if (!entry) return fail('batch_not_found', 'This client process has no such batch.');
    return { args, workspaceId, entry };
  };
  function requireStorage() {
    if (storageError) throw storageError;
    if (!storage || !storageReady) return fail('queue_unavailable', 'The frozen queue storage is not ready yet.');
    return storage;
  }
  const compactionCandidate = (entry: Entry): number | null => {
    if (!storage?.compact || entry.public.execution !== 'queued' || entry.compactedAt || !isBatchTerminal(entry.public.status) || compactionSkipped.has(entry.public.batchId)
      || !entry.public.requestKey.startsWith(FROZEN_COMPACTION_POLICY.requestKeyPrefix)) return null;
    return compactionDue.get(entry.public.batchId) ?? frozenBatchCompactionDue(entry.public);
  };
  async function compactRound(limit: number) {
    let attempted = 0, compacted = 0;
    if (!storage?.compact || disposed || storageError || !storageReady) return { attempted, compacted };
    const now = Date.now(), due = [...entries.values()].map(entry => ({ entry, at: compactionCandidate(entry) }))
      .filter((value): value is { entry: Entry; at: number } => value.at !== null && value.at <= now).sort((a, b) => a.at - b.at).slice(0, limit);
    for (const { entry } of due) {
      if (disposed || storageError) break;
      const batchId = entry.public.batchId; attempted++;
      let result;
      try { result = await storage.compact(batchId); }
      catch (error) {
        if (error instanceof BatchCompactionDeferredError) {
          // A file held open by another process affects this batch only; nothing else stops or waits.
          const code = (error.cause as any)?.code ?? 'unknown';
          if (error.published) {
            entry.compactedAt = error.compactedAt; entry.snapshots = undefined; compactionDue.delete(batchId); compactionRetries.delete(batchId);
            log(`[frozen-queue] batch ${batchId}: compacted, but superseded files are still in use (${code}); the next storage operation or start removes them.`);
          } else {
            const attempt = (compactionRetries.get(batchId) ?? 0) + 1, delay = Math.min(COMPACTION_RETRY_MAX_MS, COMPACTION_RETRY_BASE_MS * 2 ** (attempt - 1));
            compactionRetries.set(batchId, attempt); compactionDue.set(batchId, Date.now() + delay);
            log(`[frozen-queue] batch ${batchId}: its input is in use (${code}); nothing was changed, compaction retried in ${Math.round(delay / 1000)} s.`);
          }
          continue;
        }
        try { storageFailed(error); } catch { /* Recorded; every queued batch is paused. */ } break;
      }
      if (result.status === 'compacted' || result.status === 'already_compacted') { entry.compactedAt = result.compactedAt; entry.snapshots = undefined; compactionDue.delete(batchId); compactionRetries.delete(batchId); if (result.status === 'compacted') compacted++; }
      else if (result.reason === 'grace_period') compactionDue.set(batchId, result.eligibleAt);
      else compactionSkipped.add(batchId);
    }
    return { attempted, compacted };
  }
  /** Compactions run one batch per link of `compactionRun`, so a reclaim waits for at most the
   * compaction in progress instead of a whole background round; a background round yields its next
   * link while a reclaim is active. */
  let activeReclaims = 0, reclaimsDone: Promise<void> = Promise.resolve(), releaseReclaims = () => {};
  async function runCompaction(limit: number, reclaim = false) {
    if (reclaim && activeReclaims++ === 0) reclaimsDone = new Promise<void>(resolve => { releaseReclaims = resolve; });
    try { return await compactLinks(limit, reclaim); }
    finally { if (reclaim && --activeReclaims === 0) releaseReclaims(); }
  }
  async function compactLinks(limit: number, reclaim: boolean) {
    let attempted = 0, compacted = 0;
    for (let index = 0; index < limit; index++) {
      while (!reclaim && activeReclaims) await reclaimsDone;
      const step = compactionRun.then(() => compactRound(1));
      compactionRun = step.catch(() => undefined);
      const round = await step; attempted += round.attempted; compacted += round.compacted;
      if (!round.attempted) break;
    }
    return { attempted, compacted };
  }
  function scheduleCompaction(delayFloor = 0) {
    if (compactionTimer) { clearTimeout(compactionTimer); compactionTimer = null; }
    if (!storage?.compact || disposed || storageError || !storageReady) return;
    let next = Infinity;
    for (const entry of entries.values()) { const due = compactionCandidate(entry); if (due !== null && due < next) next = due; }
    if (next === Infinity) return;
    compactionTimer = setTimeout(() => {
      compactionTimer = null;
      void runCompaction(BATCH_COMPACTION_ROUND_LIMIT).then(round => scheduleCompaction(round.attempted >= BATCH_COMPACTION_ROUND_LIMIT ? 1000 : 0), () => {});
    }, Math.min(Math.max(next - Date.now(), delayFloor, 0), 2 ** 31 - 1));
    compactionTimer.unref?.();
  }
  const pendingQueuedItems = () => [...entries.values()].filter(entry => !entry.manual && entry.public.execution === 'queued' && !isBatchTerminal(entry.public.status))
    .reduce((sum, entry) => sum + entry.public.items.filter(item => ['pending', 'submitting', 'running'].includes(item.status)).length, 0);
  /** Frozen-queue usage from the latest storage scan; null without durable storage, before load or after a storage failure. */
  function capacity(): BatchCapacity | null { return storage && storageReady && !storageError ? storage.capacity?.() ?? null : null; }
  /** `cause`: what the storage threw. An entry of the queue folder this app does not use is named in the error (and
   * logged) so the user can move or delete it; any other failure keeps the general message. */
  function storageFailed(cause?: unknown): never {
    const stray = cause instanceof BatchStorageError && cause.entry ? cause : null;
    storageError = new BatchError('queue_storage_error', stray ? stray.message : 'The frozen queue cannot be read or written safely; its files are kept and new submissions are stopped.');
    // The window names the entry in its language (src/host-errors queue.stray_entry).
    if (stray) { withReason(storageError, 'queue.stray_entry', { entry: stray.entry! }); log(`[frozen-queue] ${stray.message}`); }
    // Manual batches are never stored: they run on (P2-4); only the durable agent batches stop.
    for (const entry of entries.values()) if (!entry.manual && entry.public.execution === 'queued' && !isBatchTerminal(entry.public.status)) { entry.pauseRequested = true; entry.public.error = { code: storageError.code, message: storageError.message, ...(stray ? { reason: 'queue.stray_entry', params: { entry: stray.entry! } } : {}) }; entry.public.status = entry.public.activeIndex === null ? 'paused' : 'pausing'; emit(entry); }
    throw storageError;
  }
  const stateKeyOf = (job: BatchJob) => JSON.stringify({ ...job, updatedAt: undefined });
  const cancelFlush = (entry: Entry) => { if (entry.flushTimer) { clearTimeout(entry.flushTimer); entry.flushTimer = null; } };
  /** Writes the batch's current state unless exactly that state is already stored or being stored. */
  async function persist(entry: Entry) {
    // A batch retire() removed is gone from the store: nothing is written for it any more.
    if (entries.get(entry.public.batchId) !== entry) return;
    const job = structuredClone(entry.public), stateKey = stateKeyOf(job);
    // Polling an unchanged child must not fsync identical state ten times/sec.
    if (entry.persistedState === stateKey) return;
    if (entry.saving?.key === stateKey) return entry.saving.done;
    const done = (async () => {
      try { await requireStorage().save(entry.public.batchId, job); entry.persistedState = stateKey; }
      catch (error) { storageFailed(error); }
    })();
    entry.saving = { key: stateKey, done };
    try { await done; } finally { if (entry.saving?.done === done) entry.saving = undefined; }
  }
  /** 'now': on disk when this resolves (see BATCH_STATE_FLUSH_MS for which states); 'later': merged into the next write, or written after the delay. */
  async function durable(entry: Entry, when: 'now' | 'later' = 'now') {
    // A manual batch lives only in this process.
    if (entry.manual) return;
    if (when === 'later') {
      if (entry.flushTimer || disposed) return;
      entry.flushTimer = setTimeout(() => { entry.flushTimer = null; if (!storageError) void persist(entry).catch(() => { /* storageFailed recorded it */ }); }, deps.stateFlushMs ?? BATCH_STATE_FLUSH_MS);
      entry.flushTimer.unref?.();
      return;
    }
    cancelFlush(entry);
    await persist(entry);
  }
  function updateChild(item: BatchItem, job: BatchChildJob) {
    item.jobId = job.jobId;
    item.actualSeed = job.actualSeed;
    item.status = terminalChild.has(job.status) ? job.status as BatchItem['status'] : 'running';
    const current = item.providerOutcome ?? 'unknown', observed = job.providerOutcome ?? 'unknown';
    item.providerOutcome = observed === 'response_received' || current === 'response_received' ? 'response_received'
      : terminalChild.has(job.status) && observed === 'not_submitted' ? 'not_submitted'
      : observed === 'unknown' || current === 'unknown' ? 'unknown' : 'not_submitted';
    const results = job.results.map(({ index, id, width, height, model, actualSeed }) => ({ index, id, width, height, model, actualSeed }));
    if (results.length || !item.results.length) item.results = results;
    item.error = job.error ? { code: job.error.code, message: job.error.message, ...(job.error.reason ? { reason: job.error.reason } : {}), ...(job.error.params ? { params: { ...job.error.params } } : {}), ...upstreamField(job.error.upstream) } : null;
    if (terminalChild.has(job.status) && !item.finishedAt) { item.finishedAt = new Date().toISOString(); sampleDuration(item); }
  }
  /** An image settled without a (readable) child: only this image is marked; it is never resent. */
  function settleItem(item: BatchItem, status: 'failed' | 'unknown', error: NonNullable<BatchItem['error']>, providerOutcome: NonNullable<BatchItem['providerOutcome']> = status === 'failed' ? 'not_submitted' : 'unknown') {
    item.status = status; item.error = error; item.finishedAt = new Date().toISOString();
    item.providerOutcome = item.providerOutcome === 'response_received' ? 'response_received' : providerOutcome;
  }
  async function cancelChild(entry: Entry, jobId: string) {
    if (entry.cancelSent.has(jobId)) return;
    entry.cancelSent.add(jobId);
    try { await deps.generation.cancel({ workspaceId: entry.public.originWorkspaceId, jobId }); }
    catch { entry.public.error = { code: 'cancel_unconfirmed', message: 'The cancellation could not be confirmed; waiting for this image to end, and no further image starts.' }; emit(entry); }
  }
  /** A pause, a cancel or the closing app ends what the batch waits for (an interval, a busy generator, a retry). */
  const interrupted = (entry: Entry) => entry.pauseRequested || entry.public.cancelRequested || disposed || stoppedByStorage(entry);
  /** Waits `milliseconds` in steps of at most 100 ms; false when interrupted first (only when `interruptible`). */
  async function pauseBetween(entry: Entry, milliseconds: number, interruptible = true) {
    const until = Date.now() + milliseconds;
    while (Date.now() < until) {
      if (disposed || (interruptible && interrupted(entry))) return false;
      await wait(Math.min(100, until - Date.now()));
    }
    return true;
  }
  /**
   * A read-only call to the generation service (lookup), tried again with a growing pause while it fails, for up to
   * childReadRetryMs. Never a submit. `interruptible`: a pause or cancel ends the waiting early (interrupted).
   */
  async function readWithRetry<T>(entry: Entry, read: () => T | Promise<T>, interruptible: boolean): Promise<{ ok: true; value: T } | { ok: false; interrupted: boolean }> {
    const started = Date.now(), total = childReadRetryMs();
    let delay = Math.min(1000, Math.max(1, total / 8));
    for (;;) {
      try { return { ok: true, value: await read() }; } catch { /* tried again below */ }
      const left = total - (Date.now() - started);
      if (left <= 0 || disposed) return { ok: false, interrupted: disposed };
      if (!(await pauseBetween(entry, Math.min(delay, left), interruptible))) return { ok: false, interrupted: true };
      delay = Math.min(delay * 2, 15_000);
    }
  }
  /**
   * Follows the child until it ends. A status read that keeps failing is tried again with a growing pause; after
   * childReadRetryMs without any readable state the image is marked unknown (abandoned: never resent) and the batch
   * goes on. The generator stays reserved meanwhile, so the next image waits for it (isBusy) and two never run at once.
   */
  async function track(entry: Entry, item: BatchItem, initial: BatchChildJob): Promise<{ job: BatchChildJob; abandoned: boolean }> {
    let job = initial, failingSince: number | null = null, pause = 100;
    const key = childRequestKey(item);
    const belongs = (value: BatchChildJob) => value.requestKey === key && value.originWorkspaceId === entry.public.originWorkspaceId && value.submittedRevision === entry.public.submittedRevision && value.mode === entry.public.mode;
    while (true) {
      if (!belongs(job)) throw new BatchError('child_identity_mismatch', 'The child job does not belong to this frozen batch item.');
      // The image's outcome is settled once its child ended or NovelAI answered; until then the job ID and progress can wait.
      updateChild(item, job); emit(entry); await durable(entry, terminalChild.has(job.status) || item.providerOutcome === 'response_received' ? 'now' : 'later');
      if (terminalChild.has(job.status)) return { job, abandoned: false };
      if (disposed || stoppedByStorage(entry)) return { job, abandoned: false };
      if (entry.public.cancelRequested) await cancelChild(entry, job.jobId);
      await wait(failingSince === null ? 100 : pause);
      const observed = latestChildren.get(job.jobId);
      if (observed) job = mergeChild(job, observed);
      if (terminalChild.has(job.status)) continue;
      // Read after event delivery as well: completion can occur before submit's
      // response returns or while a subscriber was disconnected. Merge rather
      // than replace so a stale/equal-time read cannot erase stronger evidence.
      try { job = mergeChild(job, await deps.generation.read({ workspaceId: entry.public.originWorkspaceId, jobId: job.jobId })); failingSince = null; pause = 100; }
      catch (error) {
        if (error instanceof BatchError && error.code === 'child_identity_mismatch') throw error;
        failingSince ??= Date.now(); pause = Math.min(pause * 2, 5000);
        if (Date.now() - failingSince >= childReadRetryMs()) {
          settleItem(item, 'unknown', { code: 'child_status_unavailable', message: 'This image could not be read for a while; whether it was generated and saved is unknown. It is not resent; the batch went on.' });
          emit(entry); await durable(entry);
          return { job, abandoned: true };
        }
      }
    }
  }
  /** NovelAI certainly answered HTTP 429 (a refusal before any work, e.g. "Concurrent generation is locked"): nothing was generated. */
  const rateLimited = (job: BatchChildJob) => job.status === 'failed' && job.providerOutcome === 'response_received' && job.error?.statusCode === 429 && !job.results?.length;
  /** After an image settled: the next one waits for the interval; with nothing left the batch ends. */
  async function nextImage(entry: Entry, settled: 'now' | 'later') {
    entry.public.activeIndex = null; entry.public.activeJobId = null;
    if (entry.public.cancelRequested) { pendingItems(entry, 'cancelled'); finish(entry, 'cancelled'); await durable(entry); return; }
    if (!entry.public.items.some(value => value.status === 'pending')) { complete(entry); await durable(entry); return; }
    entry.nextAt = Date.now() + entry.public.intervalSeconds * 1000;
    // The gap between two images (after a child the outcome is already on disk): merged into the next image's possibly-sent mark.
    emit(entry); await durable(entry, settled);
  }
  /**
   * One turn of a batch: its next pending image, from the possibly-sent mark to its outcome. An image that fails, is
   * refused or has an unknown outcome marks only itself (never resent) and the batch goes on with the rest after its
   * interval; no batch ever stops another. 'stop' when the batch ended, paused or cannot go on now.
   */
  async function turn(entry: Entry): Promise<'next' | 'stop'> {
    if (entry.public.cancelRequested) { pendingItems(entry, 'cancelled'); finish(entry, 'cancelled'); await durable(entry); return 'stop'; }
    if (entry.pauseRequested) { entry.public.status = 'paused'; emit(entry); await durable(entry); return 'stop'; }
    const item = entry.public.items.find((value) => value.status === 'pending');
    if (!item) { complete(entry); await durable(entry); return 'stop'; }
    while (Date.now() < entry.nextAt && !interrupted(entry)) await wait(Math.min(100, entry.nextAt - Date.now()));
    if (interrupted(entry)) return 'next';
    // The accepted recipe is independent of all later editor changes.
    // Wait only for the real local generation reservation, not renderer UI (two images never run at once).
    // A queue hold (the app is about to restart for its update) waits here too: nothing is submitted meanwhile.
    while ((deps.isBusy?.() || deps.holdReason?.()) && !interrupted(entry)) await wait(100);
    if (interrupted(entry)) return 'next';
    const childRequest = { workspaceId: entry.public.originWorkspaceId, expectedRevision: entry.public.submittedRevision, requestKey: childRequestKey(item), mode: entry.public.mode };
    // Written together with the possibly-sent mark below (nothing is sent before it; a restart reads this item as unknown).
    entry.public.activeIndex = item.index; item.status = 'submitting'; item.startedAt = new Date().toISOString(); item.finishedAt = null; emit(entry);
    const found = await readWithRetry(entry, () => deps.generation.lookup(childRequest), true);
    if (!found.ok) {
      if (found.interrupted) { item.status = 'pending'; item.startedAt = null; entry.public.activeIndex = null; return 'next'; }
      settleItem(item, 'unknown', { code: 'child_lookup_failed', message: 'Whether this image was already submitted could not be confirmed for a while; it is marked unknown and never resent. The batch went on.' });
      await nextImage(entry, 'now'); return 'next';
    }
    let child = found.value;
    if (!child) {
      if (interrupted(entry)) { item.status = 'pending'; item.startedAt = null; entry.public.activeIndex = null; return 'next'; }
      let snapshot = structuredClone(entry.snapshots![entry.snapshots!.length === 1 ? 0 : item.index]);
      snapshot.params = { ...snapshot.params, seed: item.plannedSeed, seedMode: 'fixed' };
      snapshot.batchCount = 1;
      if (entry.manual?.prepare) snapshot = entry.manual.prepare(snapshot, item.index);
      // Once submit is invoked, a crash can occur after provider entry but
      // before the child reply. Persist that uncertainty before the call (always written at once, never merged).
      item.providerOutcome = 'unknown'; emit(entry); await durable(entry, 'now');
      // A queued item names its durable batch so the saved history can be found again by batch or request key.
      const queue = { batchId: entry.public.batchId, requestKey: entry.public.requestKey, itemIndex: item.index };
      // A manual item's source (captured at the click) travels beside its snapshot: the same bytes for every image.
      // A manual click with a random seed keeps seedMode random in its saved records (the seed is planned here).
      try { child = await deps.generation.submit({ ...childRequest, snapshot, queue, ...(entry.manual ? { manual: true as const, ...(entry.manual.source ? { manualSource: entry.manual.source } : {}), ...(item.authoredSeedMode === 'random' ? { historySeedMode: 'random' as const } : {}) } : {}) }); }
      catch (error) {
        // An accepted submit may have lost its response. A read-only lookup (tried again while it fails) can recover
        // it; never invoke submit a second time here.
        const again = await readWithRetry(entry, () => deps.generation.lookup(childRequest), false);
        child = again.ok ? again.value : null;
        if (!child) {
          if (again.ok && errorCode(error) === 'workspace_busy') {
            item.status = 'pending'; item.providerOutcome = 'not_submitted'; item.startedAt = null; entry.public.activeIndex = null;
            entry.public.status = 'queued'; emit(entry); await durable(entry); await wait(100); return 'next';
          }
          if (again.ok && REFUSED_BEFORE_SENDING.has(errorCode(error))) {
            // A manual item keeps the refusal's own reason (the window shows it, as its manual generation did).
            settleItem(item, 'failed', { code: errorCode(error), message: entry.manual && error instanceof Error && error.message ? error.message : 'The image was refused before any request was sent.', ...(entry.manual ? reasonOf(error) : {}) });
            item.providerOutcome = 'not_submitted';
          } else settleItem(item, 'unknown', { code: 'submission_unconfirmed', message: 'Whether this image was submitted could not be confirmed; it was not resent. The batch went on.' });
          await nextImage(entry, 'now'); return 'next';
        }
      }
    }
    entry.public.activeJobId = child.jobId;
    entry.public.status = entry.public.cancelRequested ? 'cancelling' : entry.pauseRequested ? 'pausing' : 'running';
    const tracked = await track(entry, item, child);
    if (disposed || stoppedByStorage(entry)) return 'stop';
    if (!tracked.abandoned && !entry.public.cancelRequested && (item.status as BatchItem['status']) === 'failed' && rateLimited(tracked.job)) {
      const attempt = item.rateLimitRetries ?? 0, delays = rateLimitDelays();
      if (attempt < delays.length) {
        // Nothing was generated: the same image (same frozen recipe and seed) is sent again under its own child key.
        Object.assign(item, { status: 'pending', providerOutcome: 'not_submitted', jobId: null, actualSeed: null, results: [], error: null, startedAt: null, finishedAt: null, rateLimitRetries: attempt + 1 });
        entry.public.activeIndex = null; entry.public.activeJobId = null; entry.nextAt = Date.now() + delays[attempt];
        entry.public.status = entry.pauseRequested ? 'pausing' : 'running';
        emit(entry); await durable(entry); return 'next';
      }
      item.error = { ...item.error!, code: 'rate_limited', message: `NovelAI answered HTTP 429 (too many requests) to this image ${attempt + 1} times; it was sent again automatically for about ${Math.round(delays.reduce((sum, value) => sum + value, 0) / 1000)} s, was not generated and is not sent again.` };
      emit(entry); await durable(entry);
    }
    await nextImage(entry, tracked.abandoned ? 'now' : 'later');
    return 'next';
  }
  /**
   * An unexpected error while a batch ran. The image it was handling is marked (failed when nothing was sent, else
   * unknown; never resent) and the batch goes on; without such an image only this batch ends early (partial), its
   * remaining images skipped. Other batches are never affected.
   */
  async function contain(entry: Entry) {
    const active = entry.public.activeIndex === null ? null : entry.public.items[entry.public.activeIndex];
    if (active && ['submitting', 'running'].includes(active.status)) {
      const sent = active.providerOutcome !== 'not_submitted';
      settleItem(active, sent ? 'unknown' : 'failed', { code: 'scheduler_error', message: sent ? 'The queue hit an internal error while this image ran; whether it was generated is unknown. It is not resent; the batch went on.' : 'The queue hit an internal error before this image was sent; it was not sent and the batch went on.' });
      await nextImage(entry, 'now'); return;
    }
    entry.public.error = { code: 'scheduler_stopped', message: 'The queue hit an internal error and ended this batch early; its remaining images were skipped. Other batches are not affected.' };
    pendingItems(entry, 'skipped'); complete(entry); await durable(entry);
  }
  async function pump(entry: Entry) {
    if (entry.working || disposed || isBatchTerminal(entry.public.status)) return;
    entry.working = true;
    try {
      while (!disposed && !stoppedByStorage(entry) && !isBatchTerminal(entry.public.status)) {
        try { if (await turn(entry) === 'stop') return; }
        catch {
          if (disposed || stoppedByStorage(entry)) return;
          try { await contain(entry); }
          catch {
            // Even recording the error failed (and it was no storage failure): this batch ends here in memory, so the
            // FIFO can never spin on it.
            if (!isBatchTerminal(entry.public.status) && !stoppedByStorage(entry)) { pendingItems(entry, 'skipped'); finish(entry, 'partial'); }
            return;
          }
        }
      }
    } finally {
      entry.working = false;
      if (disposed && !isBatchTerminal(entry.public.status) && !entry.public.activeJobId) { pauseFor(entry, 'scheduler_closed', 'The app was closing; the remaining images continue after the next start.'); if (!storageError) await durable(entry); }
    }
  }
  function prepareEntry(raw: unknown, args: BatchRequest, manual = false): Entry {
    const input = record(raw);
    const submittedRevision = input.submittedRevision === undefined ? args.expectedRevision : input.submittedRevision;
    if (submittedRevision !== args.expectedRevision) return fail('invalid_arguments', 'Invalid adopted batch revision.');
    const perItem = Boolean(args.scenes) || input.snapshots !== undefined;
    if (perItem ? !Array.isArray(input.snapshots) || input.snapshots.length !== args.count || input.snapshot !== undefined : input.snapshots !== undefined) return fail('invalid_arguments', 'Per-image frozen recipes must match count; snapshot and snapshots cannot be mixed.');
    const snapshots = structuredClone(perItem ? input.snapshots : [record(input.snapshot)]) as GenerationSnapshot[];
    for (const snapshot of snapshots) { record(snapshot); record(snapshot.params); record(snapshot.extras); }
    // A manual i2i draws its extra noise seed per image, as the window always did.
    if (!manual) resolveNoiseSeeds(snapshots, args);
    // Durable identity of the recipes exactly as frozen (storage and recover verify the same hash).
    const payloadHash = snapshotHash({ snapshots });
    const base = snapshots[0].params.seed;
    const seedError = batchSeedInputError(args, snapshots);
    if (seedError) return fail('invalid_arguments', seedError);
    const seeds = args.seeds ?? Array.from({ length: args.count }, (_, index) => args.seedMode === 'random' ? (deps.randomSeed?.() ?? randomInt(1, MAX_SEED + 1)) : args.seedMode === 'increment' ? base + index : snapshots[perItem ? index : 0].params.seed);
    if (!seeds.every(seedWithin(manual ? MANUAL_BATCH_LIMITS.maxSeed : undefined))) return fail('invalid_arguments', 'The random seed generator returned an invalid seed.');
    const batchId = randomUUID(), now = new Date().toISOString(), source = agentSource(input.source);
    const entry: Entry = { fingerprint: JSON.stringify(canonical(args)), payloadHash, snapshots, working: false, pauseRequested: false, nextAt: 0, cancelSent: new Set(), public: {
      batchId, workspaceId: args.workspaceId, originWorkspaceId: args.workspaceId, expectedRevision: args.expectedRevision, submittedRevision, checkpointWorkspaceId: args.workspaceId, checkpointRevision: submittedRevision,
      ...(args.draftId === undefined ? {} : { draftId: args.draftId }), execution: 'queued' as const,
      requestKey: args.requestKey, mode: args.mode, count: args.count, intervalSeconds: args.intervalSeconds, seedMode: args.seeds ? 'explicit' : args.seedMode!, status: 'queued',
      ...(args.scenes ? { scenePlanHash: scenePlanHash(args.scenes) } : {}),
      activeJobId: null, activeIndex: null, createdAt: now, updatedAt: now, finishedAt: null, error: null, cancelRequested: false,
      items: seeds.map((plannedSeed, index) => ({ index, ...(args.scenes ? { sceneId: args.scenes[index].sceneId } : {}), authoredSeed: snapshots[perItem ? index : 0].params.seed, authoredSeedMode: snapshots[perItem ? index : 0].params.seedMode, executionSeedMode: 'fixed', plannedSeed, actualSeed: null, requestKey: `batch-${batchId}-${index}`, jobId: null, status: 'pending', providerOutcome: 'not_submitted', results: [], error: null })),
      ...(source ? { source } : {}),
    } };
    return entry;
  }
  function recover(input: StoredFrozenBatchInput, job: BatchJob): Entry {
    const args = parse(input.request), original = input.schemaVersion === 1 ? input : null, compaction = input.schemaVersion === 2 ? input.compaction : null;
    const snapshotCount = original ? (Array.isArray(original.snapshots) ? original.snapshots.length : -1) : compaction!.snapshotCount;
    if (input.fingerprint !== JSON.stringify(canonical(args)) || !/^[a-f0-9]{64}$/.test(input.payloadHash) || (original && input.payloadHash !== snapshotHash({ snapshots: original.snapshots }))
      || input.initial.batchId !== input.batchId || job.batchId !== input.batchId || job.execution !== 'queued' || ![1, args.count].includes(snapshotCount) || (args.scenes && snapshotCount !== args.count)) return storageFailed();
    // A compacted input has no recipes left to submit; only an ended batch may own one.
    if (compaction && !isBatchTerminal(job.status)) return storageFailed();
    if (original) for (const snapshot of original.snapshots) { record(snapshot); record(snapshot.params); record(snapshot.extras); }
    // source (step 4a) is absent on batches stored before it; it never changes after the enqueue.
    const immutable = ['batchId','execution','originWorkspaceId','expectedRevision','submittedRevision','requestKey','mode','count','intervalSeconds','seedMode','scenePlanHash','draftId','createdAt','source'];
    for (const key of immutable) if (JSON.stringify((job as any)[key]) !== JSON.stringify((input.initial as any)[key])) return storageFailed();
    if (job.count !== args.count || job.originWorkspaceId !== args.workspaceId || job.requestKey !== args.requestKey || job.mode !== args.mode || job.expectedRevision !== args.expectedRevision || job.submittedRevision !== args.expectedRevision || !['queued','running','pausing','paused','cancelling','succeeded','partial','cancelled','blocked'].includes(job.status) || (job.pausedBy !== undefined && job.pausedBy !== 'user') || typeof job.cancelRequested !== 'boolean' || !Number.isFinite(Date.parse(job.updatedAt)) || !Array.isArray(job.items) || job.items.length !== args.count || !Array.isArray(input.initial.items) || input.initial.items.length !== args.count) return storageFailed();
    if ((job.activeIndex !== null && (!Number.isSafeInteger(job.activeIndex) || job.activeIndex < 0 || job.activeIndex >= job.count)) || (job.activeJobId !== null && (typeof job.activeJobId !== 'string' || !job.activeJobId)) || (job.error !== null && (!record(job.error) || typeof job.error.code !== 'string' || typeof job.error.message !== 'string'))) return storageFailed();
    for (const [index, item] of job.items.entries()) {
      const original = input.initial.items[index];
      if (!record(item) || item.index !== index || !validSeed(item.plannedSeed) || item.requestKey !== `batch-${job.batchId}-${index}` || !['pending','submitting','running','succeeded','failed','unknown','cancelled','skipped'].includes(item.status) || (item.providerOutcome !== undefined && !['not_submitted','unknown','response_received'].includes(item.providerOutcome)) || (item.jobId !== null && (typeof item.jobId !== 'string' || !item.jobId)) || !Array.isArray(item.results) || item.results.length > 20) return storageFailed();
      for (const key of ['index','sceneId','plannedSeed','authoredSeed','authoredSeedMode','executionSeedMode','requestKey']) if (JSON.stringify((item as any)[key]) !== JSON.stringify((original as any)[key])) return storageFailed();
      // An item with child evidence cannot be restored as unsent, even when the
      // JSON remains valid after a damaged status field. Never replay it.
      if (['pending', 'submitting'].includes(item.status) && (item.jobId !== null || item.actualSeed !== null || item.results.length)) return storageFailed();
      // Fields added in 0.1.4 (absent on older records): image times and the resends after HTTP 429.
      const time = (value: unknown) => value === undefined || value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
      if (!time(item.startedAt) || !time(item.finishedAt) || (item.rateLimitRetries !== undefined && (!Number.isSafeInteger(item.rateLimitRetries) || item.rateLimitRetries < 1 || item.rateLimitRetries > 16))) return storageFailed();
      for (const result of item.results) if (!record(result) || typeof result.id !== 'string' || !result.id || !Number.isSafeInteger(result.index) || result.index < 0 || !Number.isFinite(result.width) || result.width <= 0 || !Number.isFinite(result.height) || result.height <= 0 || typeof result.model !== 'string') return storageFailed();
    }
    const activeItems = job.items.filter(item => ['submitting', 'running'].includes(item.status));
    if (activeItems.length > 1 || (activeItems.length && job.activeIndex !== activeItems[0].index) || (job.activeIndex === null && job.activeJobId !== null) || (job.activeIndex !== null && (job.items[job.activeIndex].status === 'pending' || (job.activeJobId !== null && job.activeJobId !== job.items[job.activeIndex].jobId)))) return storageFailed();
    if (isBatchTerminal(job.status) && (job.activeIndex !== null || job.activeJobId !== null || job.items.some(item => ['pending','submitting','running'].includes(item.status)))) return storageFailed();
    if (job.status === 'succeeded' && job.items.some(item => item.status !== 'succeeded')) return storageFailed();
    if (job.status === 'cancelled' && !job.cancelRequested) return storageFailed();
    const restored = structuredClone(job);
    for (const item of restored.items) if (item.providerOutcome === undefined) item.providerOutcome = 'unknown';
    // What a stored item kept of NovelAI's answer is cleaned again when it is read back (review rework): an older or
    // edited file keeps only its known fields, cleaned as when they were made; nothing else of it is adopted.
    for (const item of restored.items) {
      if (!item.error || !Object.hasOwn(item.error, 'upstream')) continue;
      const upstream = upstreamReason((item.error as { upstream?: unknown }).upstream);
      if (upstream) item.error.upstream = upstream; else delete item.error.upstream;
    }
    if (!isBatchTerminal(restored.status)) {
      // An image in flight when the app died whose file the library saved is that item's result (succeeded, charged):
      // matched by its queue origin (batch, item). Anything that does not match stays uncertain below.
      for (const item of restored.items) {
        if (!['submitting', 'running'].includes(item.status)) continue;
        let saved: ReturnType<NonNullable<BatchDependencies['savedResults']>> = [];
        try { saved = (deps.savedResults?.(job.batchId, item.index) ?? []).filter(value => typeof value?.id === 'string' && value.id && Number.isFinite(value.width) && value.width > 0 && Number.isFinite(value.height) && value.height > 0 && typeof value.model === 'string').slice(0, 20); } catch { saved = []; }
        if (!saved.length) continue;
        item.status = 'succeeded'; item.providerOutcome = 'response_received'; item.error = null;
        item.results = saved.map((value, index) => ({ index, id: value.id, width: value.width, height: value.height, model: value.model, actualSeed: value.actualSeed ?? null }));
        item.actualSeed = saved[0].actualSeed ?? item.actualSeed;
        if (saved[0].jobId) item.jobId = saved[0].jobId;
      }
    }
    if (!isBatchTerminal(restored.status)) {
      // A restart goes on where the batch was (0.1.4): only the image that was in flight and not found saved is
      // marked unknown (never resent); the rest continues on its own. A batch the user paused stays paused; a pause
      // the queue made itself (closing app, storage failure, an older version's stop after a failure) does not.
      const now = new Date().toISOString();
      for (const item of restored.items) if (['submitting', 'running'].includes(item.status)) {
        if (item.providerOutcome !== 'response_received') item.providerOutcome = 'unknown';
        item.status = 'unknown'; item.finishedAt = now; item.error = { code: 'restart_unconfirmed', message: 'The app closed while this image was running; whether it was submitted or saved is unknown. It is not resent; the rest of the batch went on.' };
      }
      restored.activeIndex = null; restored.activeJobId = null;
      if (restored.cancelRequested) {
        for (const item of restored.items) if (item.status === 'pending') item.status = 'cancelled';
        restored.status = 'cancelled'; restored.finishedAt = now; delete restored.pausedBy;
      } else if (!restored.items.some(item => item.status === 'pending')) {
        // Every image had its turn while the app was closing.
        restored.status = restored.items.every(item => item.status === 'succeeded') ? 'succeeded' : 'partial'; restored.error = null; restored.finishedAt = now; delete restored.pausedBy;
      } else if (restored.pausedBy === 'user' && ['paused', 'pausing'].includes(restored.status)) {
        restored.status = 'paused'; restored.error = null;
      } else { restored.status = 'queued'; restored.error = null; delete restored.pausedBy; }
    }
    for (const item of restored.items) if (item.status === 'unknown' && item.providerOutcome !== 'response_received') item.providerOutcome = 'unknown';
    // Ended batches never submit again, so only resumable ones keep their recipes in memory.
    return { public: restored, fingerprint: input.fingerprint, payloadHash: input.payloadHash, snapshots: original && !isBatchTerminal(restored.status) ? structuredClone(original.snapshots) : undefined, working: false, pauseRequested: restored.status === 'paused', nextAt: 0, cancelSent: new Set(), sequence: input.sequence, ...(compaction ? { compactedAt: compaction.compactedAt } : {}) };
  }
  const ready = storage ? storage.load().then(async records => {
    const restored = records.map(({ input, job }) => recover(input, job));
    // Stored unfinished (P2-1 review rework): whatever the restart made of it (queued again, paused, cancelled, ended
    // with its finishedAt) is written now, so it is fixed on disk and an ended one can be cleaned later.
    const storedUnfinished = new Set(records.filter(({ job }) => !isBatchTerminal(job.status)).map(({ job }) => job.batchId));
    const keys = new Set<string>();
    for (const entry of restored) {
      const key = JSON.stringify([entry.public.originWorkspaceId, entry.public.requestKey]);
      if (keys.has(key)) return storageFailed(); keys.add(key);
    }
    storageReady = true;
    for (const entry of restored) {
      entries.set(entry.public.batchId, entry); requests.set(JSON.stringify([entry.public.originWorkspaceId, entry.public.requestKey]), entry.public.batchId); sequence = Math.max(sequence, entry.sequence!);
      // A batch stored ended is kept as it is (what recover normalizes changes nothing): a later no-op pause or cancel writes nothing.
      if (storedUnfinished.has(entry.public.batchId)) await durable(entry); else entry.persistedState = stateKeyOf(entry.public);
      emit(entry);
    }
    // The time-left estimate starts from the images the stored batches timed (newest last).
    const timed = restored.flatMap(entry => entry.public.items).filter(item => item.status === 'succeeded' && item.startedAt && item.finishedAt).sort((a, b) => Date.parse(a.finishedAt!) - Date.parse(b.finishedAt!));
    for (const item of timed.slice(-IMAGE_TIME_SAMPLES)) sampleDuration(item);
    scheduleCompaction();
    // Unfinished batches go on after a start, also one by an agent's MCP server (0.1.4).
    queueMicrotask(kick);
  }).catch(error => storageFailed(error)) : Promise.resolve();
  void ready.catch(() => {}); // Callers await ready; no unhandled rejection before IPC is attached.
  async function drain() {
    if (draining || disposed) return;
    draining = true;
    try {
      while (!disposed) {
        // FIFO over the batches that may run: a paused batch waits without holding up the ones behind it (step 4a).
        // After a frozen-queue storage failure only the manual batches (never stored) still run.
        const next = [...entries.values()].find(entry => !stoppedByStorage(entry) && entry.public.execution === 'queued' && !isBatchTerminal(entry.public.status) && !entry.pauseRequested && entry.public.status !== 'paused');
        if (!next) return;
        await pump(next);
      }
    } finally { draining = false; }
  }
  let kickAgain = false;
  const kick = () => {
    if (disposed) return;
    // A batch added or resumed while a drain is finishing is picked up by one more drain.
    if (drainTask) { kickAgain = true; return; }
    kickAgain = false;
    drainTask = drain().catch(() => {}).finally(() => { drainTask = null; if (kickAgain) kick(); });
  };
  return {
    ready,
    lookup,
    /** The hold reason changed: the queued batches are published again (with or without it). */
    holdChanged() { for (const entry of entries.values()) if (entry.public.status === 'queued') emit(entry); },
    async enqueue(raw: unknown): Promise<BatchJob> {
      await ready;
      const work = accepting.then(async () => {
        requireStorage();
        const existing = lookup(raw); if (existing) return existing;
        if (disposed) return fail('unavailable', 'The batch scheduler is closed.');
        const args = parse(raw);
        if (retired.has(JSON.stringify([args.workspaceId, args.requestKey]))) return fail('request_conflict', 'This requestKey named a batch that ended and was cleaned; it is never queued again.');
        const pendingLimit = pendingItemLimit();
        if (pendingLimit !== null && pendingQueuedItems() + args.count > pendingLimit) throw withReason(new BatchError('queue_full', `The queue holds at most ${pendingLimit} unfinished images (Settings, total queue limit); finish or cancel some first.`), 'queue.pending_limit', { limit: pendingLimit });
        const entry = prepareEntry(raw, args); entry.sequence = ++sequence;
        const input: FrozenBatchInput = { schemaVersion: 1, batchId: entry.public.batchId, sequence: entry.sequence, request: structuredClone(args), fingerprint: entry.fingerprint, payloadHash: entry.payloadHash!, snapshots: structuredClone(entry.snapshots!), initial: structuredClone(entry.public) };
        if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_FROZEN_BATCH_INPUT_BYTES) return fail('queue_input_too_large', 'The frozen input of one batch exceeds 64 MiB; use fewer images or smaller sources.');
        try { entry.sequence = await requireStorage().create(input); sequence = Math.max(sequence, entry.sequence); }
        catch (error) {
          // Quota is refused before any write: explicit, and other queued batches keep running.
          if (error instanceof BatchQuotaError) return fail('queue_full', error.reason === 'batches' ? 'The frozen queue holds its maximum number of batches; nothing was queued.' : 'The frozen queue storage is full (room is kept for running batches); nothing was queued and other batches keep running.');
          // This batch's own frozen input failed the storage self-check before any write: refuse it alone.
          if (error instanceof BatchInputError) return fail('invalid_arguments', 'The frozen input failed its self-check (snapshot, checksum or structure); nothing was queued and other batches keep running.');
          return storageFailed(error);
        }
        entries.set(entry.public.batchId, entry); requests.set(JSON.stringify([args.workspaceId, args.requestKey]), entry.public.batchId); emit(entry);
        const accepted = expose(entry);
        queueMicrotask(kick);
        return accepted;
      });
      accepting = work.then(() => undefined, () => undefined);
      return work;
    },
    /**
     * A manual batch (step 4a): the window's Generate click. Same FIFO, controls and child jobs as the durable batches,
     * but only in this process: nothing is written, nothing comes back after a restart, and the agent limits (items
     * per enqueue, unfinished items, halting after a failure) do not apply. The same requestKey returns the same batch.
     */
    async enqueueManual(raw: unknown, options: ManualEntry = {}): Promise<BatchJob> {
      // A manual batch is never stored: it waits for the recovered batches to take their places in the FIFO, but a
      // frozen-queue storage failure (which stops the agent side) does not stop it.
      await ready.catch(() => undefined);
      const work = accepting.then(async () => {
        const args = parse(raw, MANUAL_BATCH_LIMITS);
        // One click is one requestKey: its batch is returned again, even though random seeds are drawn anew per call.
        const existing = manualByKey(args.workspaceId, args.requestKey); if (existing) return existing;
        if (disposed) return fail('unavailable', 'The batch scheduler is closed.');
        if (record(raw).source !== undefined) return fail('invalid_arguments', 'A manual batch names no source of its own.');
        const entry = prepareEntry(raw, args, true);
        if (options.source !== undefined && (!Buffer.isBuffer(options.source.bytes) || !options.source.bytes.length || typeof options.source.mimeType !== 'string')) return fail('invalid_arguments', 'Invalid manual source.');
        entry.manual = { ...(options.prepare ? { prepare: options.prepare } : {}), ...(options.source ? { source: { bytes: options.source.bytes, mimeType: options.source.mimeType } } : {}) };
        entry.public.source = { kind: 'manual', persistent: false };
        entries.set(entry.public.batchId, entry); requests.set(JSON.stringify([args.workspaceId, args.requestKey]), entry.public.batchId); emit(entry);
        const accepted = expose(entry);
        queueMicrotask(kick);
        return accepted;
      });
      accepting = work.then(() => undefined, () => undefined);
      return work;
    },
    /** The manual batch of this requestKey in this process, or null (the window's lookup after an unanswered enqueue). */
    lookupManual: (workspaceId: string, requestKey: string) => manualByKey(workspaceId, requestKey),
    /**
     * Unfinished images (pending, submitting, running) that run before the next new batch, or before batchId: those of
     * every unfinished batch ahead of it in the FIFO that is not paused.
     */
    itemsAhead(batchId?: string): number {
      let ahead = 0;
      for (const entry of entries.values()) {
        if (entry.public.batchId === batchId) break;
        if (entry.public.execution !== 'queued' || isBatchTerminal(entry.public.status) || entry.pauseRequested || entry.public.status === 'paused') continue;
        ahead += entry.public.items.filter(item => ['pending', 'submitting', 'running'].includes(item.status)).length;
      }
      return ahead;
    },
    /**
     * Where this batch stands (read_queue): the unfinished images and batches ahead of it in the FIFO that will run
     * before it (not paused; of a batch pausing only its running image), and the seconds until it ends, estimated from
     * the median time of the recent images this queue finished (imageSeconds) plus the intervals: null without a
     * timed image or while this batch is paused; 0 once it ended. null for a batch this process does not have.
     */
    position(batchId: string): BatchPosition | null {
      const target = entries.get(batchId); if (!target) return null;
      if (isBatchTerminal(target.public.status)) return { ahead: { images: 0, batches: 0 }, etaSeconds: 0, imageSeconds: medianImageMs() === null ? null : Math.round(medianImageMs()! / 100) / 10 };
      const sample = medianImageMs(), now = Date.now();
      const open = (item: BatchItem) => ['pending', 'submitting', 'running'].includes(item.status);
      // Time left of one batch: its running image's rest, its pending images and the intervals before them.
      const left = (entry: Entry, onlyActive: boolean) => {
        if (sample === null) return 0;
        const items = entry.public.items, active = items.filter(item => ['submitting', 'running'].includes(item.status));
        let ms = active.reduce((sum, item) => { const started = Date.parse(item.startedAt ?? ''); return sum + (Number.isFinite(started) ? Math.max(0, sample - (now - started)) : sample); }, 0);
        if (onlyActive) return ms;
        const pending = items.filter(item => item.status === 'pending').length, interval = entry.public.intervalSeconds * 1000;
        const gaps = items.some(item => item.status !== 'pending') ? pending : Math.max(0, pending - 1);
        ms += pending * sample;
        if (!active.length && entry.nextAt > now && pending) ms += (entry.nextAt - now) + Math.max(0, gaps - 1) * interval;
        else ms += gaps * interval;
        return ms;
      };
      let images = 0, batches = 0, ms = 0;
      for (const entry of entries.values()) {
        if (entry === target) break;
        if (entry.public.execution !== 'queued' || isBatchTerminal(entry.public.status) || stoppedByStorage(entry)) continue;
        const paused = entry.pauseRequested || entry.public.status === 'paused' || entry.public.cancelRequested;
        const counted = entry.public.items.filter(item => paused ? ['submitting', 'running'].includes(item.status) : open(item)).length;
        if (!counted) continue;
        images += counted; batches++; ms += left(entry, paused);
      }
      const waiting = target.pauseRequested || target.public.status === 'paused' || stoppedByStorage(target);
      ms += left(target, target.public.cancelRequested);
      return { ahead: { images, batches }, etaSeconds: sample === null || waiting ? null : Math.round(ms / 1000), imageSeconds: sample === null ? null : Math.round(sample / 100) / 10 };
    },
    capacity,
    /** Bytes of frozen recipes (with their image bytes) this batch still holds: zero once it ended (diagnostics and tests). */
    heldInputBytes(raw: unknown) { const { entry } = find(raw); return (entry.snapshots ? JSON.stringify(entry.snapshots).length : 0) + (entry.manual?.source?.bytes.length ?? 0); },
    /** Synchronous admission facts for a caller about to commit a queued submission of its own (for example
     * a request receipt): throws what enqueue would throw for an unavailable queue, otherwise reports the
     * unfinished-item load. Only enqueue adds items and callers serialize it, so the count cannot rise in between. */
    queueAdmission(): BatchAdmission {
      if (storageError) throw storageError;
      if (disposed) return fail('unavailable', 'The batch scheduler is closed.');
      requireStorage();
      return { pendingItems: pendingQueuedItems(), pendingItemLimit: pendingItemLimit() };
    },
    /** Bounded synchronous cleanup for a capacity precheck: compacts at most
     * `maxBatches` (1–8, default 8) ended MCP batches already past their grace period. */
    async reclaim(maxBatches: number = BATCH_RECLAIM_LIMIT): Promise<{ compacted: number; capacity: BatchCapacity | null }> {
      await ready;
      if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > BATCH_RECLAIM_LIMIT) return fail('invalid_arguments', `Clean up 1–${BATCH_RECLAIM_LIMIT} batches per round.`);
      if (storageError) throw storageError;
      const round = await runCompaction(maxBatches, true); scheduleCompaction();
      if (storageError) throw storageError;
      return { compacted: round.compacted, capacity: capacity() };
    },
    /**
     * Queue retention: removes ended agent batches from this process and from the frozen queue, files and all. The
     * caller recorded them as cleaned first (queue-tombstones). Only ended durable agent batches are taken; anything
     * else named is left alone. Their request keys are never queued again in this process.
     */
    async retire(batchIds: string[]): Promise<{ removed: string[]; reclaimedBytes: number; deferred: string[] }> {
      await ready;
      if (storageError) throw storageError;
      const store = requireStorage();
      if (!store.purge) return fail('unavailable', 'This frozen queue cannot remove batches.');
      const chosen = [...new Set(batchIds)].map(id => entries.get(id)).filter((entry): entry is Entry => Boolean(entry) && !entry!.manual && entry!.public.execution === 'queued' && isBatchTerminal(entry!.public.status) && !entry!.working);
      if (!chosen.length) return { removed: [], reclaimedBytes: 0, deferred: [] };
      // Gone from this process first: reads, controls, compaction and deferred writes no longer reach them.
      for (const entry of chosen) {
        const id = entry.public.batchId, key = JSON.stringify([entry.public.originWorkspaceId, entry.public.requestKey]);
        entries.delete(id); requests.delete(key); retired.add(key); cancelFlush(entry);
        compactionDue.delete(id); compactionSkipped.delete(id); compactionRetries.delete(id);
        const state = pushed.get(id); if (state?.timer) clearTimeout(state.timer); pushed.delete(id);
      }
      const ids = chosen.map(entry => entry.public.batchId);
      let result: { removed: string[]; reclaimedBytes: number; deferred: string[] };
      try { result = await store.purge(ids); }
      catch (error) { return storageFailed(error); }
      // A batch the store kept (stored as not ended after all) comes back: nothing of it is lost from this process.
      const gone = new Set([...result.removed, ...result.deferred]);
      for (const entry of chosen) if (!gone.has(entry.public.batchId)) {
        const key = JSON.stringify([entry.public.originWorkspaceId, entry.public.requestKey]);
        entries.set(entry.public.batchId, entry); requests.set(key, entry.public.batchId); retired.delete(key);
        log(`[frozen-queue] batch ${entry.public.batchId} was not removed: it is not stored as ended.`);
      }
      try { deps.onRemoved?.(ids.filter(id => gone.has(id))); } catch { /* Closing UI must not alter the removal. */ }
      return result;
    },
    list(raw: unknown) { const workspaceId = identifier(record(raw).workspaceId, 'Workspace ID'); return { workspaceId, batches: [...entries.values()].map((entry) => expose(entry, workspaceId)).reverse() }; },
    read(raw: unknown) { const { entry, workspaceId } = find(raw); return expose(entry, workspaceId); },
    pause(raw: unknown) {
      const { entry, workspaceId } = find(raw);
      // An explicit pause (the window or control_queue) is the user's: it stays paused across a restart (pausedBy).
      if (!isBatchTerminal(entry.public.status) && !entry.public.cancelRequested) { entry.pauseRequested = true; entry.public.pausedBy = 'user'; entry.public.status = entry.public.activeIndex !== null ? 'pausing' : 'paused'; emit(entry); }
      return entry.public.execution === 'queued' ? durable(entry).then(() => expose(entry, workspaceId)) : expose(entry, workspaceId);
    },
    async resume(raw: unknown) {
      const { entry, workspaceId, args } = find(raw);
      if (entry.public.status !== 'paused') return fail('batch_not_paused', 'Only a paused batch can be resumed; a failed or unknown image is never resent.');
      if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0) return fail('invalid_arguments', 'Resuming needs the current workspace revision.');
      if (entry.public.execution === 'queued') {
        if (!entry.manual) requireStorage();
        if (disposed) return fail('unavailable', 'The queue scheduler is closed.');
        entry.public.checkpointWorkspaceId = workspaceId; entry.public.checkpointRevision = args.expectedRevision;
        entry.pauseRequested = false; entry.public.status = 'queued'; entry.public.error = null; delete entry.public.pausedBy;
        emit(entry); await durable(entry); kick(); return expose(entry, workspaceId);
      }
      return fail('batch_not_queued', 'Only frozen queue batches can be resumed.');
    },
    cancel(raw: unknown) {
      const { entry, workspaceId } = find(raw);
      if (!isBatchTerminal(entry.public.status)) {
        entry.public.cancelRequested = true; pendingItems(entry, 'cancelled');
        if (entry.public.activeIndex === null) finish(entry, 'cancelled');
        else { entry.public.status = 'cancelling'; emit(entry); if (entry.public.activeJobId) void cancelChild(entry, entry.public.activeJobId); }
      }
      if (entry.public.execution === 'queued') return durable(entry).then(() => { kick(); return expose(entry, workspaceId); });
      return expose(entry, workspaceId);
    },
    dispose() {
      disposed = true; unsubscribe?.(); const saves: Promise<unknown>[] = [compactionRun];
      for (const state of pushed.values()) if (state.timer) { clearTimeout(state.timer); state.timer = null; }
      if (compactionTimer) { clearTimeout(compactionTimer); compactionTimer = null; }
      // Deferred progress is written now with the closing state (or, for an ended batch, was already superseded).
      for (const entry of entries.values()) { if (entry.flushTimer && isBatchTerminal(entry.public.status) && !storageError) saves.push(durable(entry)); cancelFlush(entry); }
      for (const entry of entries.values()) if (!isBatchTerminal(entry.public.status)) { entry.pauseRequested = true; entry.public.status = entry.public.activeIndex === null ? 'paused' : 'pausing'; emit(entry); if (!storageError) saves.push(durable(entry)); }
      return Promise.allSettled([...saves, ...(drainTask ? [drainTask] : [])]).then(() => undefined);
    },
  };
}
