import { lockOwnerIdentity, lockStillHeld, memoStartTimes } from './lock-owner';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID, randomInt } from 'node:crypto';
import { renameReplace, syncDirectory } from './platform-fs';
import { DEFAULT_PARAMS, DEFAULT_I2I_PARAMS, DEFAULT_AUGMENT_OPTIONS, type HistoryItem } from '../src/types';
import { readSavedGenerationResult } from './generation-result';
import { record, validatePatch, type CreativeState } from '../src/workspace/state';
import { authoredPromptReview, type PromptReviewPreparation, type PromptReviewInput } from '../src/workspace/prompt-review';
import { isBatchTerminal, type BatchJob, type BatchSource } from '../src/workspace/batch-types';
import type { BatchAdmission, BatchCapacity } from './batch-service';
import { FROZEN_QUEUE_LIMITS } from './batch-storage';
import { GENERATION_MODES, isSeededGeneration, type GenerationSnapshot } from '../src/workspace/generation-types';
import { buildPromptReview, freezeReviewedGeneration } from './prompt-review';
import { queueRecipePreviewResult } from './recipe-preview';
import { WorkspaceError } from '../src/workspace/protocol';
import { parseQueueOutput, QueueHistoryGroupConflict, type QueueOutput } from './queue-output';
import { QUEUE_ENQUEUE_ITEMS, normalizeQueueEnqueueItems } from '../src/queue-limits';
import { isSystemMetadataFile } from './system-metadata-files';
import { withReason } from './host-error';
import { createQueueTombstones, CLEANED_ITEM_STATUSES, QueueTombstoneError, validCleanedRecord, type CleanedBatchRecord, type CleanedItemCounts, type CleanedRecord, type KeyRecord, type QueueTombstones, type RecoveredBatchRecord, type TornIdentity } from './queue-tombstones';

export const QUEUE_WORKSPACE = 'recipe-queue'; // The generation ledger's origin for queued batches; never a renderer identity.
export const QUEUE_METHODS = ['put_queue_recipe', 'read_queue_recipe', 'preview_queue_recipe', 'enqueue_queue_recipes', 'lookup_queue_request', 'list_queue', 'read_queue', 'pause_queue', 'resume_queue', 'cancel_queue', 'get_queue_result'] as const;
/** Referenced sources are bounded by the history reader (20 MiB); asset provenance is a small JSON note outside reviewInput. */
export const RECIPE_ASSET_LIMITS = { referenceBytes: 20 * 1024 * 1024, provenanceBytes: 32 * 1024 } as const;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
/** Inline assets carry bytes (inline sources, masks). A library
 * reference (history, or since issue #2 a study = imported image) stores only identity
 * and content binding; the host rereads it. */
export interface QueueInlineAsset { role: string; mimeType: string; data: string; provenance?: Record<string, unknown> }
export interface QueueHistoryReference { kind: 'history'; id: string; revision: number; assetId: string }
/** A study has exactly one registered original, so its reference carries no assetId. */
export interface QueueStudyReference { kind: 'study'; id: string; revision: number }
export type QueueLibraryReference = QueueHistoryReference | QueueStudyReference;
export interface QueueReferenceAsset { role: 'source'; mimeType: string; ref: QueueLibraryReference; sha256: string; byteLength: number }
export type QueueAsset = QueueInlineAsset | QueueReferenceAsset;
export interface QueuePreparation { mode: PromptReviewPreparation['mode']; authored: Record<string, any>; assets: QueueAsset[] }
/** The host library reader (asset-library-image createHistoryImageReader); it reads history and study originals. */
export type ReadHistoryOriginal = (args: QueueLibraryReference & { variant: 'original' }) => Promise<{ data?: unknown }>;
export const isReferenceAsset = (asset: QueueAsset): asset is QueueReferenceAsset => Object.hasOwn(asset, 'ref');
const libraryIdentifier = (value: unknown) => typeof value === 'string' && value.trim() !== '' && value.length <= 512;
const sniffImageType = (bytes: Buffer) => bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
  : bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
  : bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : undefined;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
/** A receipt reserves 16 KiB per started 20 items (a 20-item body with a 2 KiB error is about 6 KB) and keeps that
 * slot across every state transition. */
export const RECIPE_STORE_LIMITS = Object.freeze({ records: 16_384, bytes: MAX_TOTAL_BYTES, receiptSlot: 16 * 1024, receiptErrorBytes: 2048, receiptErrorCode: 128 });
const RECEIPT_SLOT_BYTES = RECIPE_STORE_LIMITS.receiptSlot;
/** The slot of a receipt for `items` queue items: 16 KiB for up to 20 items, one more 16 KiB per further 20. */
export const receiptSlotBytes = (items: number) => RECEIPT_SLOT_BYTES * Math.max(1, Math.ceil(items / 20));
/**
 * Automatic reclamation of canvas captures (prepare_recipe {canvas}, 2026-11-02). The recipe store otherwise only
 * grows (RECIPE_STORE_LIMITS), and a canvas capture of an image mode stores its source inline. Only a record with a
 * canvas origin is ever removed; plain recipes and every receipt stay. A capture is removed
 * once it is older than graceMs AND every receipt naming it is settled that long: its batch ended (succeeded,
 * cancelled or blocked) graceMs ago, or its enqueue was rejected graceMs ago. A receipt still preparing or unknown, an
 * unfinished batch, a receipt whose batch cannot be found, an unreadable receipt or an unreadable frozen queue keeps
 * it (the last two skip the whole round). A running batch never needs its recipe (it runs from its frozen input);
 * lookups, queue reads and history never read recipes, and a repeated enqueue of an existing key is answered from
 * its receipt before any recipe is read. Rounds run at start (after startDelayMs), every intervalMs, on demand
 * (reclaimRecipes) and once before a put would be refused for a full store.
 */
export const RECIPE_RECLAIM_POLICY = Object.freeze({ graceMs: 7 * 24 * 60 * 60 * 1000, roundLimit: 200, startDelayMs: 30_000, intervalMs: 6 * 60 * 60 * 1000 });
/** `auto:false` disables the timers (reclaimRecipes and the full-store attempt still work). */
export interface RecipeReclaimOptions { auto?: boolean; graceMs?: number; roundLimit?: number; startDelayMs?: number; intervalMs?: number; now?: () => number; log?: (message: string) => void }
/**
 * Queue retention (2026-11, Settings › Queue: 7, 30 or 90 days, or never; default 30). An ended agent batch (succeeded,
 * cancelled or blocked; never a queued, running or paused one) whose end lies MORE than that many days back is cleaned
 * together with its receipt and the plain recipes only it used (option B: no receipt of any status still names the
 * recipe; a recipe never enqueued and every canvas capture keep their own rules). A record per batch and per recipe
 * stays (queue-tombstones): the old requestKey keeps answering "accepted, ended, cleaned" and is never queued again.
 * Rounds run after start (startDelayMs), every intervalMs, and on demand (runRetention, also when the setting changes);
 * one round takes at most roundLimit batches, and a run repeats rounds until none is due.
 */
export const QUEUE_RETENTION = Object.freeze({ choices: Object.freeze([7, 30, 90] as const), defaultDays: 30, startDelayMs: 15_000, intervalMs: 24 * 60 * 60 * 1000, roundLimit: 1000, dayMs: 24 * 60 * 60 * 1000,
  /** A run that stopped (a store briefly locked, for example by a process that died holding it) is retried after 1, 2, 4 … minutes, at most intervalMs. */
  retryMs: 60_000 });
export interface QueueRetentionOptions { auto?: boolean; days?: () => number | null; startDelayMs?: number; intervalMs?: number; retryMs?: number; roundLimit?: number; now?: () => number; log?: (message: string) => void;
  /** After every run (main.ts: Settings › Queue shows it). */
  onRun?: (run: QueueRetentionRun) => void }
/** One retention run (runRetention): what was cleaned and what it cost. */
export interface QueueRetentionRun {
  at: string; days: number | null; skipped: null | 'never' | 'frozen_queue_unreadable' | 'cleaned_records_unreadable';
  cleaned: number; receipts: number; recipes: number; frozenBytes: number; recipeBytes: number; deferred: number; rounds: number;
  /** Due batches left as they are: their receipt could not be read, or names another batch. */
  kept: number;
  /** Due batches left as they are because their record would not pass the check (they keep their receipt). */
  invalid: number;
  receiptsRead: number; receiptReadMs: number; ms: number;
}
/** A bounded synchronous frozen-queue cleanup before refusing a new batch for space. */
const FROZEN_RECLAIM_LIMIT = 8;
/** Room kept beyond the estimate for in-flight batches that save progress between this precheck and the
 * frozen create (one maximal state revision; typical saves are a few KiB, so this covers hundreds). */
export const FROZEN_PRECHECK_SAVE_MARGIN = FROZEN_QUEUE_LIMITS.state;
/** Upper bound of one frozen snapshot from a stored preparation, before anything is built: the snapshot
 * carries a subset of the normalized authored fields plus the source/mask base64; 1 KiB covers its small extras. */
const frozenSnapshotUpperBound = (preparation: QueuePreparation) => Buffer.byteLength(JSON.stringify(preparation.authored)) + 1024
  + preparation.assets.reduce((sum, asset) => sum + (Object.hasOwn(asset, 'ref') ? Math.ceil((asset as QueueReferenceAsset).byteLength / 3) * 4 : Buffer.byteLength((asset as QueueInlineAsset).data)), 0);
/** Conservative upper bound of what the frozen queue adds for one submission (one item per entry, in order):
 * stored input (snapshots — one when every item is the same recipe — request, fingerprint, initial job),
 * its current state, the first history state and the create transaction. */
export function estimateFrozenBatchBytes(requestKey: string, items: Array<{ recipe: string; preparation: QueuePreparation }>) {
  const single = new Set(items.map(entry => entry.recipe)).size === 1, snapshots = (single ? items.slice(0, 1) : items).reduce((sum, entry) => sum + frozenSnapshotUpperBound(entry.preparation), 0);
  const key = Buffer.byteLength(JSON.stringify(requestKey)), count = items.length;
  const job = 1024 + 2 * key + count * 320, request = 256 + key + count * 12;
  const input = snapshots + 3 * request + job + 512;
  return input + 2 * (job + 512) + 512;
}
const utf8Prefix = (text: string, bytes: number) => { let used = 0, end = 0; for (const char of text) { const size = Buffer.byteLength(JSON.stringify(char)) - 2; if (used + size > bytes) break; used += size; end += char.length; } return text.slice(0, end); };
/** Receipt errors are bounded before they are stored or thrown, so a repeat returns the identical error. */
const receiptError = (code: unknown, message: unknown) => ({ code: utf8Prefix(typeof code === 'string' && code ? code : 'invalid_argument', RECIPE_STORE_LIMITS.receiptErrorCode), message: utf8Prefix(typeof message === 'string' ? message : 'Queue input was rejected.', RECIPE_STORE_LIMITS.receiptErrorBytes) });
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
export const recipeHash = (value: unknown) => { preflight(value); return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); };
const fail = (code: string, message: string): never => { throw new WorkspaceError(code, message); };
const keys = (value: any, allowed: string[]) => { record(value, 'queue arguments'); if (Object.keys(value).some(key => !allowed.includes(key))) fail('invalid_argument', 'Unknown queue field.'); };
const revision = (value: any) => { if (!Number.isSafeInteger(value) || value < 1) fail('invalid_argument', 'A positive recipe revision is required.'); return value as number; };
const recipeId = (value: any) => { if (typeof value !== 'string' || !UUID.test(value)) fail('invalid_argument', 'Invalid recipe ID.'); return value as string; };
const requestKey = (value: any) => { if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\x00-\x1f]/.test(value)) fail('invalid_argument', 'Invalid request key.'); return value as string; };
const validSeed = (value: any) => Number.isSafeInteger(value) && value >= 0 && value <= 2147483646;
const preflight = (value: unknown, maximum = MAX_BYTES) => {
  let nodes = 0, bytes = 0; const active = new WeakSet<object>(), stack: Array<{ item: unknown; depth: number; exit?: boolean }> = [{ item: value, depth: 0 }];
  const stringBytes = (text: string) => { let size = Buffer.byteLength(text) + 2; for (let index = 0; index < text.length; index++) { const code = text.charCodeAt(index); if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) size++; else if (code < 32) size += 5; } return size; };
  while (stack.length) {
    const frame = stack.pop()!, { item, depth } = frame; if (frame.exit) { active.delete(item as object); continue; }
    if (++nodes > 750_000 || depth > 96) fail('queue_input_too_large', 'Queue input is structurally too large.');
    if (typeof item === 'string') bytes += stringBytes(item);
    else if (item && typeof item === 'object') {
      if (active.has(item as object)) fail('invalid_argument', 'Queue input is cyclic.'); active.add(item as object); stack.push({ item, depth, exit: true });
      if (Array.isArray(item)) { bytes += item.length + 2; for (let index = item.length - 1; index >= 0; index--) stack.push({ item: item[index], depth: depth + 1 }); }
      else { const names = Object.keys(item); bytes += names.length + 2; for (let index = names.length - 1; index >= 0; index--) { const key = names[index]; bytes += stringBytes(key) + 1; stack.push({ item: (item as Record<string, unknown>)[key], depth: depth + 1 }); } }
    } else if (item === null || ['number', 'boolean'].includes(typeof item)) bytes += 32;
    else if (item !== undefined) fail('invalid_argument', 'Queue input contains an unsupported value.');
    if (bytes > maximum) fail('queue_input_too_large', 'Queue input exceeds its bounded size.');
  }
};

/** Uses the editor's allowlist/normalizer with explicit defaults, never its store.
 * authoredAssembly (canvas captures): every prompt recipe (params, inpaintRecipe) keeps its promptAssemblyVersion
 * exactly as authored, so a canvas still on the historical assembly (no marker) is frozen as read_prompt_review shows it. */
export function normalizeQueuePreparation(raw: unknown, options: { newRecipe?: boolean; inheritedPromptAssemblyVersion?: 1; authoredAssembly?: boolean } = {}): QueuePreparation {
  preflight(raw); const input = record(raw, 'preparation'); keys(input, ['mode', 'authored', 'assets']);
  if (!GENERATION_MODES.includes(input.mode)) fail('invalid_argument', 'Independent queues support t2i, i2i, inpaint, enhance, upscale and director.');
  // Only inpaint consumes a mask; any other mode carrying one is a malformed preparation, not unused context.
  if (input.mode !== 'inpaint' && Array.isArray(input.assets) && input.assets.some((asset: any) => asset?.role === 'mask')) fail('invalid_argument', 'Only inpaint recipes take a mask asset.');
  const authored = record(input.authored, 'authored');
  const scalars: Record<string, string[]> = { modelMode: ['anime', 'furry'], i2iSourceMode: ['latest', 'original'], inpaintSourceMode: ['latest', 'original'], i2iSizeMode: ['manual', 'adaptive'] };
  const defaults = { params: structuredClone(DEFAULT_PARAMS), i2iParams: structuredClone(DEFAULT_I2I_PARAMS), augmentOptions: structuredClone(DEFAULT_AUGMENT_OPTIONS),
    modelMode: 'anime', inpaintModel: 'nai-diffusion-5-full-inpainting', inpaintStrength: 1, inpaintNoise: 0, inpaintPositivePrompt: '', inpaintRecipe: null,
    i2iSourceMode: 'latest', inpaintSourceMode: 'latest', i2iSizeMode: 'manual', enhanceMagnitude: 3, enhanceScale: 1, upscaleScale: 2, directorTool: 'bg-removal', charCaptions: [], vibeImages: [], preciseReferences: [] } as unknown as CreativeState;
  const authoredParams=record(authored.params,'authored.params');
  if(Object.hasOwn(authoredParams,'promptAssemblyVersion')&&authoredParams.promptAssemblyVersion!==1)fail('invalid_argument','Invalid promptAssemblyVersion.');
  const authoredAssembly = options.authoredAssembly === true;
  if(!Object.hasOwn(authoredParams,'promptAssemblyVersion')&&(authoredAssembly||(options.newRecipe===false&&options.inheritedPromptAssemblyVersion!==1)))delete defaults.params.promptAssemblyVersion;
  const patch = structuredClone(authored);
  for (const [field, allowed] of Object.entries(scalars)) if (field in patch) {
    if (!allowed.includes(patch[field])) fail('invalid_argument', `Invalid ${field}.`);
    defaults[field as keyof CreativeState] = patch[field]; delete patch[field];
  }
  // Sources are bytes with roles, not renderer paths or IDs. Reference transport is deferred.
  if ('inpaintMask' in patch) fail('invalid_argument', 'Supply mask bytes in preparation.assets.');
  for (const field of ['vibeImages', 'preciseReferences']) {
    if (field in patch && (!Array.isArray(patch[field]) || patch[field].length)) fail('unsupported_reference', 'Queued reference encoding is not implemented.');
  }
  const state = Object.keys(patch).length ? { ...defaults, ...validatePatch(patch, defaults) } : defaults;
  // An independent inpaint recipe is merged over the base defaults; without its own marker it stays on the historical assembly.
  if (authoredAssembly && state.inpaintRecipe && authored.inpaintRecipe && typeof authored.inpaintRecipe === 'object' && !Object.hasOwn(authored.inpaintRecipe, 'promptAssemblyVersion')) {
    state.inpaintRecipe = { ...state.inpaintRecipe }; delete state.inpaintRecipe.promptAssemblyVersion;
  }
  if (!Array.isArray(input.assets) || input.assets.length > 2) fail('invalid_argument', 'Provide assets:[] or source/mask image bytes.');
  for (const asset of input.assets) {
    if (asset && typeof asset === 'object' && Object.hasOwn(asset, 'ref')) {
      const refusal = 'A referenced source needs role "source", a PNG/JPEG/WebP mimeType, ref {kind:"history", id, revision, assetId} or {kind:"study", id, revision}, sha256 and byteLength (at most 20 MiB).';
      keys(asset, ['role', 'mimeType', 'ref', 'sha256', 'byteLength']); const ref = record(asset.ref, 'source reference');
      // Exact key sets: a study (issue #2) is a study UUID and revision, no assetId (it has one registered original).
      const study = ref.kind === 'study';
      if (!study) keys(ref, ['kind', 'id', 'revision', 'assetId']);
      else if (Object.keys(ref).some(key => !['kind', 'id', 'revision'].includes(key))) fail('invalid_argument', refusal);
      const validRef = study ? typeof ref.id === 'string' && UUID.test(ref.id) && Number.isSafeInteger(ref.revision) && ref.revision >= 1
        : ref.kind === 'history' && libraryIdentifier(ref.id) && Number.isSafeInteger(ref.revision) && ref.revision >= 0 && libraryIdentifier(ref.assetId);
      if (asset.role !== 'source' || !IMAGE_TYPES.includes(asset.mimeType) || !validRef
        || typeof asset.sha256 !== 'string' || !HASH.test(asset.sha256) || !Number.isSafeInteger(asset.byteLength) || asset.byteLength < 1 || asset.byteLength > RECIPE_ASSET_LIMITS.referenceBytes)
        fail('invalid_argument', refusal);
      continue;
    }
    keys(asset, ['role', 'mimeType', 'data', 'provenance']);
    if (!['source', 'mask'].includes(asset.role) || !IMAGE_TYPES.includes(asset.mimeType) || typeof asset.data !== 'string') fail('invalid_argument', 'Invalid queue image asset.');
    if (asset.provenance !== undefined && Buffer.byteLength(JSON.stringify(record(asset.provenance, 'asset provenance'))) > RECIPE_ASSET_LIMITS.provenanceBytes) fail('invalid_argument', 'Asset provenance exceeds 32 KiB.');
  }
  if (new Set(input.assets.map((asset: any) => asset.role)).size !== input.assets.length) fail('invalid_argument', 'Invalid or duplicate review image role.');
  const normalizedAuthored = authoredPromptReview(state), characters = Array.isArray(state.charCaptions) ? state.charCaptions : [];
  normalizedAuthored.charCaptions = (normalizedAuthored.charCaptions ?? []).map((character: any, index: number) => typeof characters[index]?.id === 'string' && characters[index].id ? { id: characters[index].id, ...character } : character);
  return { mode: input.mode, authored: normalizedAuthored, assets: structuredClone(input.assets) };
}

/** Where a canvas capture came from (prepare_recipe {canvas}, electron/canvas-recipe-capture.ts): the workspace, its
 * revision, the unapplied draft or detached text patch read with it, and when. Stored beside the preparation, never in
 * reviewInput, so it is not part of inputHash. A record without it is a plain recipe (prepared from inline fields). */
export interface CanvasOrigin { workspaceId: string; revision: number; draftId: string | null; patched: boolean; capturedAt: string }
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
export function parseCanvasOrigin(raw: unknown): CanvasOrigin {
  const value = record(raw, 'canvasOrigin'); keys(value, ['workspaceId', 'revision', 'draftId', 'patched', 'capturedAt']);
  const identifier = (text: unknown) => typeof text === 'string' && text.trim() !== '' && text.length <= 120 && !/[\x00-\x1f\x7f]/.test(text);
  if (!identifier(value.workspaceId) || !Number.isSafeInteger(value.revision) || value.revision < 0 || (value.draftId !== null && !identifier(value.draftId))
    || typeof value.patched !== 'boolean' || (value.patched && value.draftId !== null) || typeof value.capturedAt !== 'string' || !ISO_TIME.test(value.capturedAt) || !Number.isFinite(Date.parse(value.capturedAt)))
    fail('invalid_argument', 'Invalid canvas origin.');
  return { workspaceId: value.workspaceId, revision: value.revision, draftId: value.draftId, patched: value.patched, capturedAt: value.capturedAt };
}
/** A stored recipe revision: exactly these fields (canvasOrigin only on a canvas capture); a record with any other
 * field was not written by this version and is refused. */
interface RecipeRecord { schemaVersion: 1; recipeId: string; recipeRevision: number; preparation: QueuePreparation; inputHash: string; canvasOrigin?: CanvasOrigin; recordHash?: string }
const RECIPE_RECORD_FIELDS = new Set(['schemaVersion', 'recipeId', 'recipeRevision', 'canvasOrigin', 'preparation', 'inputHash', 'recordHash']);
interface QueueItem { recipeId: string; recipeRevision: number; inputHash: string; seed?: number }
interface ReceiptError { code: string; message: string }
/** `output` (2026-10-14, issue #1): only on receipts of enqueues that asked for a history group or file prefix — the
 * request (part of requestHash) plus the group the host resolved before writing the receipt. */
interface Receipt { schemaVersion: 2; requestKey: string; requestHash: string; recipePlanHash: string; items: QueueItem[]; args: Record<string, any> | null; status: 'preparing' | 'accepted' | 'rejected' | 'unknown'; revision: number; batchId: string | null; result: Record<string, any> | null; error: ReceiptError | null; previousRecordHash: string | null; updatedAt: string; output?: QueueOutput; _padding?: string; recordHash?: string }
interface QueueBackend {
  ready: Promise<unknown>;
  enqueue(args: unknown): Promise<BatchJob>;
  lookup(args: unknown): BatchJob | null;
  list(args: unknown): { batches: BatchJob[] };
  read(args: unknown): BatchJob;
  pause(args: unknown): BatchJob | Promise<BatchJob>;
  resume(args: unknown): BatchJob | Promise<BatchJob>;
  cancel(args: unknown): BatchJob | Promise<BatchJob>;
  /** Frozen-queue capacity from the batch service's latest storage scan; null when unknown. */
  capacity?(): BatchCapacity | null;
  /** Bounded synchronous compaction of ended batches (frees bytes, never batch slots). */
  reclaim?(maxBatches?: number): Promise<{ compacted: number; capacity: BatchCapacity | null }>;
  /** Throws when the frozen queue cannot accept anything; otherwise its unfinished-item load. */
  queueAdmission?(): BatchAdmission;
  /** Queue retention: removes ended batches (their cleaned records are written first). */
  retire?(batchIds: string[]): Promise<{ removed: string[]; reclaimedBytes: number; deferred: string[] }>;
}

/** Host-owned immutable recipe revisions and request receipts; no window or canvas dependency. */
export function createQueueRecipeService(options: { runtimeDir: string; batch: QueueBackend; generation?: { result(args: unknown): Promise<any> }; randomSeed?: () => number; historyById?: (id: string) => HistoryItem | null;
  /** Reuse (by name as stored: whitespace collapsed, case-insensitive, NFC) or create a history group; enqueue output.historyGroup needs it (main.ts: resolveQueueHistoryGroup
   * over ensureHistoryGroup). A QueueHistoryGroupConflict is reported as history_group_conflict. */
  resolveHistoryGroup?: (name: string) => { id: string; name: string };
  /** Images one enqueue may add, read at every new enqueue (the client's queueMaxItemsPerEnqueue setting, 1–200).
   * Default QUEUE_ENQUEUE_ITEMS.default (20). A larger new request is refused before its receipt (enqueue_limit_exceeded). */
  enqueueItemLimit?: () => number; validateImage?: (data: Buffer, mimeType: string) => { width: number; height: number }; readHistoryOriginal?: ReadHistoryOriginal; recipeReclaim?: RecipeReclaimOptions; /** Test fixtures only; production uses RECIPE_STORE_LIMITS. */ recordLimit?: number;
  /** Queue retention (QUEUE_RETENTION). Without it nothing runs by itself; runRetention uses the default 30 days. */
  retention?: QueueRetentionOptions;
  /** The cleaned-batch records (default: the runtime folder's own). */
  tombstones?: QueueTombstones;
  /** The second anchor's folder of the cleaned records (main.ts: <data root>/queue-anchor). */
  cleanedAnchorDir?: string;
  /** Host request keys the library's images name (history queueOrigin), with their batch and image count: a knowing
   * repair of damaged cleaned records adds a record for each key that has neither a receipt nor a readable record. */
  libraryQueueOrigins?: () => Array<{ requestKey: string; batchId: string; images: number }>;
  /** Where a store problem the user can fix is written (an entry the store does not use); default console.warn, which main mirrors into app.log. */
  log?: (message: string) => void }) {
  const directory = path.resolve(options.runtimeDir, 'queue-recipes'), recordLimit = options.recordLimit ?? RECIPE_STORE_LIMITS.records;
  /** Records/bytes of the recipe store from the latest scan (or write) in this process. */
  let recipeUsage: { records: number; total: number } | null = null;
  let sequence: Promise<unknown> = Promise.resolve();
  const log = options.log ?? ((message: string) => console.warn(message)), reportedEntries = new Set<string>();
  const queueDirectory = path.resolve(options.runtimeDir, 'queue-recipes');
  /** Whether what a torn last record names was not removed yet (its receipt, batch or recipe file is still there). */
  const stillPending = async (identity: TornIdentity) => {
    const exists = (file: string) => fs.lstat(file).then(info => info.isFile(), () => false);
    if (identity.kind === 'recipe') return exists(path.join(queueDirectory, `${identity.recipeId}.${identity.recipeRevision}.json`));
    if (await exists(path.join(queueDirectory, `request-${identity.keyHash}.json`))) return true;
    try { return Boolean(identity.batchId && options.batch.list({ workspaceId: QUEUE_WORKSPACE }).batches.some(job => job.batchId === identity.batchId)); } catch { return false; }
  };
  const tombstones = options.tombstones ?? createQueueTombstones(options.runtimeDir, { log, anchorDir: options.cleanedAnchorDir, pending: stillPending });
  /** The cleaned records cannot be trusted: whether a key or batch without a receipt had a batch is unknown (never "not found"). */
  const cleanedUnreadable = (error: unknown): never => {
    const message = error instanceof QueueTombstoneError ? error.message : `The records of cleaned queue batches (${tombstones.entry} in the data folder) cannot be read (${(error as any)?.code ?? 'read_failed'}). Whether a requestKey without a receipt had a batch is unknown, so nothing was looked up or queued for it.`;
    if (!reportedEntries.has(tombstones.entry)) { reportedEntries.add(tombstones.entry); log(`[queue-retention] ${message}`); }
    throw new WorkspaceError('queue_storage_failed', message, { reason: 'cleaned_records_unreadable', entry: tombstones.entry, ...(error instanceof QueueTombstoneError ? { problem: error.problem } : {}) });
  };
  /** A recovery from the library in progress (at start, after a library restore, before a cleaning): answers that
   * depend on the cleaned records wait for it, so none answers "no record" for a key it is about to record. */
  let recordsSettled: Promise<unknown> = Promise.resolve();
  const settled = () => recordsSettled.catch(() => undefined);
  const cleanedByKey = async (key: string) => { await settled(); return tombstones.byKeyHash(recipeHash(key)).catch(cleanedUnreadable); };
  const cleanedByBatch = async (batchId: string) => { await settled(); return tombstones.byBatchId(batchId).catch(cleanedUnreadable); };
  /**
   * What a cleaned batch still answers (lookup, a repeated enqueue, read, pause, cancel): accepted, how it ended, its
   * per-status image counts and when it was cleaned; no items. The request key only when the caller named it (only its
   * hash is kept).
   */
  const cleanedBatch = (record: KeyRecord, requestKey?: string) => record.kind === 'recovered' ? ({
    // Rebuilt from the library after its record was lost (a knowing repair): accepted, how it ended is unknown.
    batchId: record.batchId, ...(requestKey ? { requestKey } : {}), execution: 'queued' as const, workspaceId: QUEUE_WORKSPACE, originWorkspaceId: QUEUE_WORKSPACE,
    expectedRevision: 0, submittedRevision: 0, checkpointWorkspaceId: QUEUE_WORKSPACE, checkpointRevision: 0, status: 'unknown', count: null, intervalSeconds: null,
    error: null, activeJobId: null, activeIndex: null, createdAt: null, finishedAt: null,
    cleaned: true as const, recovered: true as const, cleanedAt: record.recoveredAt, itemCounts: null, savedImages: record.savedImages, items: [] as BatchJob['items'],
  }) as unknown as BatchJob & { requestKey: string; cleaned: true; cleanedAt: string; itemCounts: CleanedItemCounts } : ({
    batchId: record.batchId, ...(requestKey ? { requestKey } : {}), execution: 'queued' as const, workspaceId: QUEUE_WORKSPACE, originWorkspaceId: QUEUE_WORKSPACE,
    expectedRevision: 0, submittedRevision: 0, checkpointWorkspaceId: QUEUE_WORKSPACE, checkpointRevision: 0, mode: record.mode as BatchJob['mode'],
    status: record.status, count: record.count, intervalSeconds: record.intervalSeconds,
    ...(record.recipePlanHash ? { recipePlanHash: record.recipePlanHash } : {}), ...(record.output ? { output: structuredClone(record.output) } : {}),
    error: record.stopCode ? { code: record.stopCode, message: 'The batch had stopped with this reason when it ended.' } : null,
    activeJobId: null, activeIndex: null, createdAt: record.createdAt, finishedAt: record.finishedAt,
    cleaned: true as const, cleanedAt: record.cleanedAt, itemCounts: { ...record.counts }, items: [] as BatchJob['items'],
  }) as unknown as BatchJob & { requestKey: string; cleaned: true; cleanedAt: string; itemCounts: CleanedItemCounts };
  /** An entry of the store folder this app does not write (system metadata files are skipped before this): the store
   * stays exactly as it is and refuses, naming the entry relative to the data root (the parent of the runtime folder),
   * and the first refusal per entry is logged. Moving or deleting the entry makes the store usable again at once. */
  const strayEntry = (name: string): never => {
    const entry = path.relative(path.dirname(path.resolve(options.runtimeDir)), path.join(directory, name)).split(path.sep).join('/');
    const message = `The recipe store holds an entry this app does not use: ${entry} (in the data folder). The store was left exactly as it is; nothing was saved or queued. Move or delete that entry, then try again.`;
    if (!reportedEntries.has(entry)) { reportedEntries.add(entry); log(`[recipe-store] ${message}`); }
    throw withReason(new WorkspaceError('queue_storage_failed', message, { reason: 'unsupported_entry', entry }), 'recipe.stray_entry', { entry });
  };
  /** The record or byte limit of the store is reached: the only queue_storage_failed that means "full". */
  const storeFull = (message: string): never => { throw withReason(new WorkspaceError('queue_storage_failed', message, { reason: 'store_full' }), 'recipe.store_full'); };
  const exclusive = <T>(run: () => Promise<T>): Promise<T> => { const next = sequence.then(run); sequence = next.catch(() => undefined); return next; };
  const init = async () => {
    const runtimePath = path.resolve(options.runtimeDir), runtimeInfo = await fs.lstat(runtimePath);
    if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink()) fail('queue_storage_failed', 'Recipe runtime root is not an owned directory.');
    await fs.mkdir(directory, { recursive: false, mode: 0o700 }).catch((error: any) => { if (error.code !== 'EEXIST') throw error; });
    const info = await fs.lstat(directory);
    if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink() || !info.isDirectory() || info.isSymbolicLink()
      || await fs.realpath(directory) !== path.resolve(await fs.realpath(options.runtimeDir), 'queue-recipes')) fail('queue_storage_failed', 'Recipe storage is not an owned directory.');
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (isSystemMetadataFile(entry)) continue;
      const internal = /^\.quota-owner-[a-f0-9-]{36}\.tmp$/.test(entry.name) || entry.name === '.quota.lock' || /^\.quota\.lock\.stale-[a-f0-9-]{36}$/.test(entry.name) || /^\.quota\.recover-[a-f0-9-]{36}$/.test(entry.name) || /^\.quota-[a-f0-9-]{36}-[a-f0-9-]{36}\.tmp$/.test(entry.name);
      if ((!internal && !ownedName(entry.name)) || !entry.isFile() || entry.isSymbolicLink()) strayEntry(entry.name);
    }
  };
  const filename = (id: string, version: number) => path.join(directory, `${id}.${version}.json`);
  const receiptPath = (key: string) => path.join(directory, `request-${recipeHash(key)}.json`);
  const ownedName = (name: string) => new RegExp(`^(?:${UUID.source.slice(1, -1)}\\.[1-9]\\d*|request-${HASH.source.slice(1, -1)})\\.json$`).test(name);
  const safeSmallRead = async (file: string) => { const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); try { const info = await handle.stat(); if (!info.isFile() || info.size > 4096) fail('queue_storage_failed', 'Recipe quota lock is invalid.'); return await handle.readFile('utf8'); } finally { await handle.close(); } };
  type QuotaOwner = { pid: number; nonce: string; leaseUntil: number; createdAt?: number; startedAt?: number; host?: string; boot?: string };
  type QuotaIdentity = { dev: number; ino: number };
  const ownerMatches = (a: any, b: QuotaOwner) => a?.pid === b.pid && a?.nonce === b.nonce && a?.leaseUntil === b.leaseUntil && a?.createdAt === b.createdAt && a?.startedAt === b.startedAt && a?.host === b.host && a?.boot === b.boot;
  const sameInode = (a: QuotaIdentity, b: QuotaIdentity) => a.dev === b.dev && a.ino === b.ino;
  const releaseQuotaOwner = async (target: string, owner: QuotaOwner, identity: QuotaIdentity) => {
    try {
      const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      let matches = false;
      try {
        const info = await handle.stat();
        if (info.isFile() && info.size <= 4096 && sameInode(info, identity)) matches = ownerMatches(JSON.parse(await handle.readFile('utf8')), owner);
      } finally { await handle.close(); }
      if (!matches) return; // Never remove a foreign/replaced owner, even at our old path.
      const current = await fs.lstat(target);
      if (!current.isFile() || current.isSymbolicLink() || !sameInode(current, identity)) return;
      // Node has no unlink-if-inode primitive. Move the public name into a
      // private tombstone, then verify again before deleting any bytes. A
      // foreign replacement at the rename boundary is retained/restored.
      const retired = path.join(directory, `.quota.lock.stale-${randomUUID()}`);
      await fs.rename(target, retired);
      const retiredHandle = await fs.open(retired, constants.O_RDONLY | constants.O_NOFOLLOW);
      let ownRetired = false;
      try { const info = await retiredHandle.stat(); if (info.isFile() && info.size <= 4096 && sameInode(info, identity)) ownRetired = ownerMatches(JSON.parse(await retiredHandle.readFile('utf8')), owner); } finally { await retiredHandle.close(); }
      if (!ownRetired) {
        try { await fs.link(retired, target); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
        fail('queue_storage_failed', 'Recipe quota owner changed during cleanup; foreign evidence retained.');
      }
      await fs.unlink(retired);
      await syncDirectory(directory);
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  };
  const noteCleanupFailure = (error: unknown, cleanup: unknown) => {
    if (error && typeof error === 'object') Object.assign(error, { quotaCleanupError: { code: (cleanup as any)?.code, message: cleanup instanceof Error ? cleanup.message : String(cleanup) } });
  };
  // null means only the target link returned EEXIST. Other publication failures,
  // including failures after the link, never enter the acquisition retry branch.
  const publishQuotaOwner = async (target: string, owner: QuotaOwner): Promise<QuotaIdentity | null> => {
    const temporary = path.join(directory, `.quota-owner-${randomUUID()}.tmp`), handle = await fs.open(temporary, 'wx', 0o600);
    let identity: QuotaIdentity | undefined, failure: unknown, failed = false, contended = false;
    try {
      try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); const info = await handle.stat(); identity = { dev: info.dev, ino: info.ino }; } finally { await handle.close(); }
      try { await fs.link(temporary, target); } catch (error: any) { if (error.code !== 'EEXIST') throw error; contended = true; }
      if (!contended) { await syncDirectory(directory); }
    } catch (error) { failed = true; failure = error; }
    try { await fs.unlink(temporary); } catch (error: any) { if (error.code !== 'ENOENT') { if (failed) noteCleanupFailure(failure, error); else { failed = true; failure = error; } } }
    if (failed) {
      // We may have publicly linked our owner before directory sync/private
      // candidate cleanup failed. Cover this phase as well as the later run.
      if (identity && !contended) try { await releaseQuotaOwner(target, owner, identity); } catch (cleanup) { noteCleanupFailure(failure, cleanup); }
      throw failure;
    }
    return contended ? null : identity!;
  };
  const withQuota = async <T>(run: (nonce: string) => Promise<T>): Promise<T> => {
    await init(); const lock = path.join(directory, '.quota.lock'), nonce = randomUUID(), claimPattern = /^\.quota\.recover-[a-f0-9-]{36}$/;
    // An owner that is gone (lock-owner.ts: its pid and start) is taken over at once; the lease only for older owners.
    const startTimes = memoStartTimes(), held = (owner: any) => lockStillHeld(owner, Date.now(), startTimes);
    const clearOrWaitClaims = async () => {
      let blocked = false;
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) if (claimPattern.test(entry.name)) {
        if (!entry.isFile() || entry.isSymbolicLink()) return fail('queue_storage_failed', 'Recipe recovery claim is invalid.');
        const file = path.join(directory, entry.name); let claim: any; try { claim = JSON.parse(await safeSmallRead(file)); } catch (error: any) { if (error.code === 'ENOENT') continue; throw error; }
        const filenameNonce = entry.name.slice('.quota.recover-'.length);
        if (!Number.isSafeInteger(claim.pid) || claim.pid <= 0 || !UUID.test(claim.nonce ?? '') || claim.nonce !== filenameNonce
          || !Number.isSafeInteger(claim.createdAt) || !Number.isSafeInteger(claim.leaseUntil) || claim.createdAt < 0 || claim.leaseUntil < claim.createdAt) return fail('queue_storage_failed', 'Recipe recovery claim is invalid.');
        if (await held(claim)) blocked = true;
        else try { await fs.unlink(file); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      }
      return blocked;
    };
    for (let attempt = 0; attempt < 1000; attempt++) {
      if (await clearOrWaitClaims()) { await new Promise(resolve => setTimeout(resolve, 5)); continue; }
      const acquiring: QuotaOwner = { pid: process.pid, nonce, leaseUntil: Date.now() + 60_000, ...lockOwnerIdentity() };
      const acquired = await publishQuotaOwner(lock, acquiring);
      if (acquired) {
        let bodyFailed = false, bodyError: unknown;
        try {
          if (await clearOrWaitClaims()) continue; // finally releases only our own acquired inode.
          for (const entry of await fs.readdir(directory, { withFileTypes: true })) if (/^\.quota-[a-f0-9-]{36}-[a-f0-9-]{36}\.tmp$/.test(entry.name)) {
            if (!entry.isFile() || entry.isSymbolicLink()) fail('queue_storage_failed', 'Recipe temporary entry is invalid.'); await fs.unlink(path.join(directory, entry.name));
          }
          return await run(nonce); // Body EEXIST is a publication conflict, never an acquire retry.
        } catch (error) { bodyFailed = true; bodyError = error; throw error; }
        finally { try { await releaseQuotaOwner(lock, acquiring, acquired); } catch (cleanup) { if (bodyFailed) noteCleanupFailure(bodyError, cleanup); else throw cleanup; } }
      }
      let owner: any; try { owner = JSON.parse(await safeSmallRead(lock)); } catch (read: any) { if (read.code === 'ENOENT') continue; return fail('queue_storage_failed', 'Recipe quota lock is invalid.'); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !UUID.test(owner.nonce ?? '') || !Number.isSafeInteger(owner.leaseUntil)) return fail('queue_storage_failed', 'Recipe quota lock is invalid.');
      if (await held(owner)) { await new Promise(resolve => setTimeout(resolve, 5)); continue; }
      const stale = `${lock}.stale-${nonce}`, claim = path.join(directory, `.quota.recover-${nonce}`), claimCreatedAt = Date.now(), claimOwner: QuotaOwner = { pid: process.pid, nonce, createdAt: claimCreatedAt, leaseUntil: claimCreatedAt + 60_000, ...lockOwnerIdentity() };
      let claimIdentity: QuotaIdentity | null = null;
      try {
        claimIdentity = await publishQuotaOwner(claim, claimOwner); if (!claimIdentity) continue;
        let current: any; try { current = JSON.parse(await safeSmallRead(lock)); } catch (read: any) { if (read.code === 'ENOENT') continue; throw read; }
        if (!ownerMatches(current, owner)) continue;
        await fs.rename(lock, stale); const moved = JSON.parse(await safeSmallRead(stale));
        if (!ownerMatches(moved, owner)) { try { await fs.link(stale, lock); } catch {} return fail('queue_storage_failed', 'Recipe quota owner changed during recovery.'); }
        await fs.unlink(stale); await syncDirectory(directory);
      } catch (rename: any) { if (rename.code !== 'ENOENT') throw rename; }
      finally { if (claimIdentity) await releaseQuotaOwner(claim, claimOwner, claimIdentity); }
    }
    return fail('queue_storage_failed', 'Recipe quota lock could not be acquired.');
  };
  const readFile = async <T extends { recordHash?: string }>(file: string): Promise<T> => {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) fail('queue_storage_failed', 'Recipe file is invalid or too large.');
      const value = JSON.parse(await handle.readFile('utf8'));
      try { preflight(value, MAX_BYTES); } catch { fail('queue_storage_failed', 'Recipe file structure is invalid.'); }
      const { recordHash, ...payload } = value;
      if (typeof recordHash !== 'string' || recipeHash(payload) !== recordHash) fail('queue_storage_failed', 'Recipe file hash does not match.');
      return value;
    } finally { await handle.close(); }
  };
  const scanOwned = async () => {
    let total = 0, records = 0;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (isSystemMetadataFile(entry)) continue;
      // The arbitration lock is transient and removed before publication completes;
      // it has zero committed quota delta, while transaction payloads are reserved.
      if (entry.name === '.quota.lock' || /^\.quota\.lock\.stale-[a-f0-9-]{36}$/.test(entry.name)) { if (!entry.isFile() || entry.isSymbolicLink()) fail('queue_storage_failed', 'Recipe storage lock is invalid.'); continue; }
      if (/^\.quota-owner-[a-f0-9-]{36}\.tmp$/.test(entry.name)) {
        // A contender may still be writing its unpublished owner. Reserve the
        // entire bounded metadata size; never exempt it from quota accounting.
        let info; try { info = await fs.lstat(path.join(directory, entry.name)); } catch (error: any) { if (error.code === 'ENOENT') continue; throw error; }
        if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) fail('queue_storage_failed', 'Recipe quota candidate is invalid.');
        total += 4096; records++; continue;
      }
      if (!ownedName(entry.name) || !entry.isFile() || entry.isSymbolicLink()) strayEntry(entry.name);
      total += (await fs.lstat(path.join(directory, entry.name))).size; records++;
    }
    recipeUsage = { total, records };
    return { total, records };
  };
  const publish = async (file: string, data: string, exclusive: boolean, nonce: string) => {
    const temporary = path.join(directory, `.quota-${nonce}-${randomUUID()}.tmp`), handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    try {
      if (exclusive) { await fs.link(temporary, file); await fs.unlink(temporary); }
      else { const info = await fs.lstat(file); if (!info.isFile() || info.isSymbolicLink()) fail('queue_storage_failed', 'Queue receipt is not an owned file.'); await renameReplace(temporary, file); }
      await syncDirectory(directory);
    } finally { await fs.unlink(temporary).catch(() => undefined); }
  };
  const writeData = async (file: string, data: string) => withQuota(async nonce => {
    if (!ownedName(path.basename(file)) || Buffer.byteLength(data) > MAX_BYTES) fail('queue_storage_failed', 'Recipe exceeds the storage limit.');
    const usage = await scanOwned(); if (usage.records >= recordLimit) storeFull(`Recipe storage is full (${recordLimit} records); retain existing records and archive explicitly.`);
    if (usage.total + Buffer.byteLength(data) > MAX_TOTAL_BYTES) storeFull('Recipe storage exceeds 512 MiB.');
    await publish(file, data, true, nonce);
    recipeUsage = { records: usage.records + 1, total: usage.total + Buffer.byteLength(data) };
  });
  const writeFile = async (file: string, payload: unknown) => writeData(file, JSON.stringify({ ...record(payload, 'record'), recordHash: recipeHash(payload) }));
  /** Pads a receipt to exactly `slot` bytes; only the `_padding` spaces differ between slot sizes. */
  const fixedReceipt = (value: Receipt, slot: number = RECEIPT_SLOT_BYTES) => {
    const { recordHash: _hash, _padding: _oldPadding, ...body } = value, basePayload = { ...body, _padding: '' }, base = JSON.stringify({ ...basePayload, recordHash: recipeHash(basePayload) });
    const padding = slot - Buffer.byteLength(base); if (padding < 0) fail('queue_storage_failed', 'Queue receipt exceeds its storage limit.');
    const payload = { ...body, _padding: ' '.repeat(padding) }, data = JSON.stringify({ ...payload, recordHash: recipeHash(payload) });
    if (Buffer.byteLength(data) !== slot) fail('queue_storage_failed', 'Queue receipt reservation failed.'); return data;
  };
  const inputHash = (input: PromptReviewInput) => recipeHash({ ...input, assets: input.assets.map(({ data: _data, ...asset }) => asset) });
  const characterIdsFor = (preparation: QueuePreparation) => (Array.isArray(preparation.authored.charCaptions) ? preparation.authored.charCaptions : []).map((character: any) => character?.id).filter((id: unknown): id is string => typeof id === 'string' && Boolean(id));
  /** Reference identity, raw byte counts and provenance live beside reviewInput, never in it: inputHash stays the same for a referenced or an embedded copy of one image. */
  const assetDetails = (preparation: QueuePreparation) => {
    const refs = preparation.assets.filter(isReferenceAsset).map(asset => ({ role: asset.role, mimeType: asset.mimeType, ref: { ...asset.ref }, sha256: asset.sha256, byteLength: asset.byteLength }));
    const provenance = Object.fromEntries(preparation.assets.filter((asset): asset is QueueInlineAsset => !isReferenceAsset(asset) && asset.provenance !== undefined).map(asset => [asset.role, structuredClone(asset.provenance)]));
    const bytes = Object.fromEntries(preparation.assets.map(asset => [asset.role, isReferenceAsset(asset) ? asset.byteLength : Buffer.byteLength(asset.data.replace(/^data:image\/(?:png|jpeg|webp|gif);base64,/, ''), 'base64')]));
    return { ...(refs.length ? { assetRefs: refs } : {}), ...(preparation.assets.length ? { assetBytes: bytes } : {}), ...(Object.keys(provenance).length ? { assetProvenance: provenance } : {}) };
  };
  const snapshotFor = (entry: RecipeRecord, reviewInput: PromptReviewInput) => ({
    recipeId: entry.recipeId, recipeRevision: entry.recipeRevision, inputHash: inputHash(reviewInput),
    characterIds: characterIdsFor(entry.preparation),
    ...(entry.canvasOrigin ? { canvasOrigin: structuredClone(entry.canvasOrigin) } : {}),
    snapshot: { schemaVersion: 1 as const, workspaceId: `recipe:${entry.recipeId}`, revision: entry.recipeRevision, draftId: null, mode: entry.preparation.mode, reviewInput },
    ...assetDetails(entry.preparation) });
  const assetDataOmitted = (value: unknown) => { if (value !== undefined && value !== 'omit' && value !== 'include') fail('invalid_argument', 'assetData must be "omit" or "include".'); return value === 'omit'; };
  const withoutAssetData = <T extends { snapshot: { reviewInput: PromptReviewInput } }>(result: T) => ({ ...result, snapshot: { ...result.snapshot, reviewInput: { ...result.snapshot.reviewInput, assets: result.snapshot.reviewInput.assets.map(({ data: _data, ...asset }) => asset) } } });
  type SourceOwner = { recipeId: string; recipeRevision: number } | null;
  const sourceFailure = (code: 'recipe_source_unavailable' | 'recipe_source_changed' | 'recipe_source_busy', asset: QueueReferenceAsset, owner: SourceOwner, detail: string, readerCode?: string): never => {
    const ref = asset.ref, identity = ref.kind === 'study' ? `study ${ref.id} revision ${ref.revision}` : `history ${ref.id} revision ${ref.revision}, asset ${ref.assetId}`;
    const label = `${owner ? `Recipe ${owner.recipeId} revision ${owner.recipeRevision}` : 'The recipe'} source (${identity})`;
    throw new WorkspaceError(code, `${label} ${detail}`, { ...(owner ? { recipeId: owner.recipeId, recipeRevision: owner.recipeRevision } : {}), ref: { ...asset.ref }, sha256: asset.sha256, byteLength: asset.byteLength, ...(readerCode ? { readerCode } : {}) });
  };
  /** Rereads one history or study original through the host reader and binds it to the recorded sha256/byteLength. */
  const readReference = async (asset: QueueReferenceAsset, owner: SourceOwner) => {
    const ref = asset.ref, reader = ref.kind === 'study' ? 'study' : 'history';
    if (!options.readHistoryOriginal) return sourceFailure('recipe_source_unavailable', asset, owner, 'cannot be read: this host has no history library reader. Nothing was saved or queued.');
    let image: { data?: unknown };
    try { image = await options.readHistoryOriginal(ref.kind === 'study' ? { kind: 'study', id: ref.id, revision: ref.revision, variant: 'original' } : { kind: 'history', id: ref.id, revision: ref.revision, assetId: ref.assetId, variant: 'original' }); }
    catch (error: any) {
      const readerCode = typeof error?.code === 'string' ? error.code : 'read_failed';
      if (readerCode === 'image_busy') return sourceFailure('recipe_source_busy', asset, owner, `is busy in the ${reader} reader. Nothing was saved or queued; retry the same call later.`, readerCode);
      if (readerCode === 'image_changed' || readerCode === 'library_conflict') return sourceFailure('recipe_source_changed', asset, owner, `no longer matches its registered original (${readerCode}). Nothing was saved or queued; prepare a new recipe from the current image.`, readerCode);
      return sourceFailure('recipe_source_unavailable', asset, owner, `is unavailable (${readerCode}). Nothing was saved or queued.`, readerCode);
    }
    if (typeof image?.data !== 'string') return sourceFailure('recipe_source_unavailable', asset, owner, `was not returned by the ${reader} reader. Nothing was saved or queued.`, 'invalid_reader_response');
    const bytes = Buffer.from(image.data, 'base64');
    if (bytes.length !== asset.byteLength || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) return sourceFailure('recipe_source_changed', asset, owner, 'differs from the sha256/byteLength recorded for it. Nothing was saved or queued; prepare a new recipe from the current image.');
    if (sniffImageType(bytes) !== asset.mimeType) fail('invalid_argument', 'The referenced source mimeType does not match the registered original.');
    return bytes;
  };
  /** Builder input with bytes: inline assets as stored, references reread and verified. */
  const materialize = async (preparation: QueuePreparation, owner: SourceOwner): Promise<PromptReviewPreparation> => {
    const assets: PromptReviewPreparation['assets'] = [];
    for (const asset of preparation.assets) assets.push(isReferenceAsset(asset)
      ? { role: asset.role, mimeType: asset.mimeType, data: (await readReference(asset, owner)).toString('base64') }
      : { role: asset.role, mimeType: asset.mimeType, data: asset.data });
    return { mode: preparation.mode, authored: preparation.authored, assets };
  };
  const load = async (id: string, version: number) => {
    await init();
    const value = await readFile<RecipeRecord>(filename(recipeId(id), revision(version)));
    if (value.recipeId !== id || value.recipeRevision !== version || value.schemaVersion !== 1) fail('queue_storage_failed', 'Recipe identity mismatch.');
    if (Object.keys(value).some(key => !RECIPE_RECORD_FIELDS.has(key))) fail('queue_storage_failed', `Recipe ${id} revision ${version} has fields this version does not write; it was created by an unsupported older version and is not read.`);
    return value;
  };
  const recipeKey = (id: string, version: number) => `${id}:${version}`;
  /** load() for a recipe the caller names: a missing record is recipe_not_found (a canvas capture or, under the queue
   * retention, a plain recipe may have been reclaimed; a reclaimed plain recipe is named as such). */
  const loadExisting = async (id: string, version: number) => {
    try { return await load(id, version); }
    catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      let reclaimed: { cleanedAt: string } | null = null;
      try { reclaimed = await tombstones.recipe(id, version); } catch { reclaimed = null; }
      if (reclaimed) return fail('recipe_not_found', `Recipe ${id} revision ${version} was reclaimed under the queue retention rule on ${reclaimed.cleanedAt} (every batch that used it had ended more than the retention period before and was cleaned). Prepare it again with the same fields: prepare_recipe returns a new recipeId with the same inputHash. Nothing was saved or queued and no requestKey was used.`);
      return fail('recipe_not_found', `Recipe ${id} revision ${version} does not exist. Recipes are reclaimed under retention rules: a canvas capture ${Math.round(reclaim.graceMs / 86_400_000)} days after its last batch ended; a prepared recipe once every batch that used it ended more than the queue retention period before and was cleaned. Prepare it again with the same fields (same inputHash) or capture the canvas again. Nothing was saved or queued and no requestKey was used.`);
    }
  };
  /** `materialized` lets enqueue reuse sources it already verified before writing its receipt. */
  const readRecipeWith = async (raw: unknown, materialized?: Map<string, PromptReviewPreparation>) => {
    preflight(raw); const args = record(raw, 'recipe read'); keys(args, ['recipeId', 'recipeRevision', 'assetData']);
    assetDataOmitted(args.assetData);
    const entry = await loadExisting(args.recipeId, args.recipeRevision);
    const preparation = materialized?.get(recipeKey(entry.recipeId, entry.recipeRevision)) ?? await materialize(entry.preparation, entry);
    const result = snapshotFor(entry, await buildPromptReview(preparation));
    if (result.inputHash !== entry.inputHash) fail('recipe_changed', 'The builder no longer produces the stored reviewed input. Save and review a new recipe revision.');
    return result;
  };
  const readRecipe = async (raw: unknown) => {
    preflight(raw); const omitAssetData = assetDataOmitted(record(raw, 'recipe read').assetData), result = await readRecipeWith(raw);
    return omitAssetData ? withoutAssetData(result) : result;
  };
  const receipt = async (key: string): Promise<Receipt | null> => {
    try {
      const value = await readFile<Receipt>(receiptPath(key));
      if (value.requestKey !== key) fail('queue_storage_failed', 'Queue receipt identity mismatch.');
      if (value.schemaVersion !== 2) fail('queue_storage_failed', 'Queue receipt of an unsupported format (created by an unsupported older version).');
      if ((!['preparing', 'accepted', 'rejected', 'unknown'].includes(value.status) || !Number.isSafeInteger(value.revision) || value.revision < 1
        || (value.batchId !== null && (typeof value.batchId !== 'string' || !value.batchId)) || (value.error !== null && (typeof value.error?.code !== 'string' || typeof value.error?.message !== 'string'))
        || (value.revision === 1 ? value.previousRecordHash !== null : typeof value.previousRecordHash !== 'string')
        || (value.status === 'accepted' && (!value.args || !value.batchId || !value.result || value.error !== null))
        || (value.status === 'rejected' && (!value.error || value.batchId !== null || value.result !== null))
        || (value.status === 'unknown' && (!value.error || value.batchId !== null || value.result !== null)))) fail('queue_storage_failed', 'Queue receipt state is invalid.');
      return value;
    }
    catch (error) { if ((error as any).code === 'ENOENT') return null; throw error; }
  };
  /** Chain-linked, CAS-checked receipt rewrite under the quota lock. A receipt keeps its file size through
   * every state change, so a transition never needs new quota. Publication is one atomic rename. */
  const replaceReceipt = async (prior: Receipt, next: Receipt) => withQuota(async nonce => {
    const file = receiptPath(prior.requestKey), current = await receipt(prior.requestKey);
    if (!current || current.revision !== prior.revision || current.recordHash !== prior.recordHash) fail('queue_storage_failed', 'Queue receipt changed during its state transition.');
    const transitions = new Set(['preparing:preparing', 'preparing:accepted', 'preparing:rejected', 'preparing:unknown', 'unknown:accepted']);
    if (!transitions.has(`${prior.status}:${next.status}`) || next.revision !== prior.revision + 1 || next.previousRecordHash !== prior.recordHash || next.requestHash !== prior.requestHash || next.recipePlanHash !== prior.recipePlanHash) fail('queue_storage_failed', 'Invalid queue receipt transition.');
    const currentInfo = await fs.lstat(file);
    if (!currentInfo.isFile() || currentInfo.isSymbolicLink()) fail('queue_storage_failed', 'Queue receipt is not an owned file.');
    const data = fixedReceipt(next, currentInfo.size);
    const usage = await scanOwned(); if (usage.total - currentInfo.size + Buffer.byteLength(data) > MAX_TOTAL_BYTES) storeFull('Recipe storage exceeds 512 MiB.');
    await publish(file, data, false, nonce);
    recipeUsage = { records: usage.records, total: usage.total - currentInfo.size + Buffer.byteLength(data) };
    const value = JSON.parse(data); return value as Receipt;
  });
  const moveReceipt = (prior: Receipt, status: Receipt['status'], change: Partial<Receipt> = {}) =>
    replaceReceipt(prior, { ...prior, ...change, schemaVersion: 2, status, revision: prior.revision + 1, previousRecordHash: prior.recordHash!, updatedAt: new Date().toISOString(), recordHash: undefined });
  const receiptName = /^request-[a-f0-9]{64}\.json$/;

  const reclaim = { ...RECIPE_RECLAIM_POLICY, auto: true, ...(options.recipeReclaim ?? {}) };
  const reclaimNow = () => reclaim.now?.() ?? Date.now();
  const reclaimLog = reclaim.log ?? ((message: string) => console.warn(message));
  const recordName = new RegExp(`^(${UUID.source.slice(1, -1)})\\.([1-9]\\d*)\\.json$`);
  /** The canvas origin of a record from its first bytes (put_canvas_recipe writes it before the preparation), or null. */
  const canvasHead = Buffer.from('{"schemaVersion":1,"recipeId":"');
  const canvasOriginAt = async (file: string): Promise<CanvasOrigin | null> => {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const head = Buffer.alloc(2048), { bytesRead } = await handle.read(head, 0, head.length, 0);
      const text = head.subarray(0, bytesRead).toString('utf8');
      if (!text.startsWith(canvasHead.toString())) return null;
      const match = /^\{"schemaVersion":1,"recipeId":"[a-f0-9-]{36}","recipeRevision":[1-9]\d*,"canvasOrigin":(\{[^{}]*\})/.exec(text);
      if (!match) return null;
      try { return parseCanvasOrigin(JSON.parse(match[1])); } catch { return null; }
    } finally { await handle.close(); }
  };
  /**
   * When each recipe named by a receipt may go: Infinity while any receipt naming it is unsettled, else the latest
   * settled time + grace. null when a receipt or the frozen queue cannot be read (the round is skipped).
   */
  const protectedUntil = async (): Promise<Map<string, number> | null> => {
    if (await options.batch.ready.then(() => false, () => true)) return null;
    const until = new Map<string, number>();
    const hold = (items: QueueItem[], at: number) => { for (const item of items) { const key = recipeKey(item.recipeId, item.recipeRevision); until.set(key, Math.max(until.get(key) ?? -Infinity, at)); } };
    for (const name of (await fs.readdir(directory)).filter(name => receiptName.test(name))) {
      let saved: Receipt;
      try { saved = await readFile<Receipt>(path.join(directory, name)); } catch { return null; }
      if (saved.schemaVersion !== 2 || receiptPath(saved.requestKey) !== path.join(directory, name) || !Array.isArray(saved.items)) return null;
      const updated = Date.parse(saved.updatedAt);
      if (saved.status === 'rejected') { hold(saved.items, Number.isFinite(updated) ? updated + reclaim.graceMs : Infinity); continue; }
      if (saved.status !== 'accepted') { hold(saved.items, Infinity); continue; }
      let job: BatchJob | null = null;
      try { job = saved.args ? options.batch.lookup(saved.args) : null; } catch { return null; }
      const finished = job && isBatchTerminal(job.status) && typeof job.finishedAt === 'string' ? Date.parse(job.finishedAt) : NaN;
      hold(saved.items, Number.isFinite(finished) ? finished + reclaim.graceMs : Infinity);
    }
    return until;
  };
  /** One round with the store's sequence held (no put, enqueue or receipt change interleaves). */
  const reclaimLocked = async (limit: number = reclaim.roundLimit) => {
    const result = { reclaimed: 0, bytes: 0, examined: 0, kept: 0, skipped: null as null | 'frozen_queue_unreadable' | 'receipt_unreadable' | 'no_store' };
    try { if (!(await fs.lstat(directory)).isDirectory()) return { ...result, skipped: 'no_store' as const }; }
    catch (error: any) { if (error.code === 'ENOENT') return { ...result, skipped: 'no_store' as const }; throw error; }
    await init();
    const time = reclaimNow(), until = await protectedUntil();
    if (!until) return { ...result, skipped: (await options.batch.ready.then(() => false, () => true)) ? 'frozen_queue_unreadable' as const : 'receipt_unreadable' as const };
    const due: Array<{ file: string; id: string; version: number }> = [];
    for (const name of (await fs.readdir(directory)).sort()) {
      const match = recordName.exec(name); if (!match) continue;
      const file = path.join(directory, name);
      let origin: CanvasOrigin | null;
      try { origin = await canvasOriginAt(file); } catch { continue; }
      if (!origin) continue;
      result.examined++;
      const capturedAt = Date.parse(origin.capturedAt), key = recipeKey(match[1], Number(match[2]));
      if (!(capturedAt + reclaim.graceMs <= time) || (until.get(key) ?? -Infinity) > time) { result.kept++; continue; }
      if (due.length < limit) due.push({ file, id: match[1], version: Number(match[2]) });
    }
    if (!due.length) return result;
    await withQuota(async () => {
      for (const candidate of due) {
        // The whole record is verified (hash, identity, origin) before anything is removed.
        let entry: RecipeRecord;
        try { entry = await load(candidate.id, candidate.version); } catch { continue; }
        if (!entry.canvasOrigin) continue;
        const info = await fs.lstat(candidate.file);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        await fs.unlink(candidate.file);
        result.reclaimed++; result.bytes += info.size;
      }
      await syncDirectory(directory);
      if (recipeUsage) recipeUsage = { records: recipeUsage.records - result.reclaimed, total: recipeUsage.total - result.bytes };
    });
    if (result.reclaimed) reclaimLog(`[recipe-store] reclaimed ${result.reclaimed} canvas recipe(s), ${result.bytes} bytes.`);
    return result;
  };
  /** On demand (maintenance, tests): one bounded reclamation round. Never a bridge method. */
  const reclaimRecipes = (limit: number = reclaim.roundLimit) => {
    if (!Number.isSafeInteger(limit) || limit < 1) fail('invalid_argument', 'Reclaim at least one recipe per round.');
    return exclusive(() => reclaimLocked(limit));
  };
  /** A recipe write that would be refused for a full store first runs one reclamation round (the sequence is already held). */
  const writeRecipe = async (file: string, entry: RecipeRecord) => {
    try { return await writeFile(file, entry); }
    catch (error: any) {
      if (error?.code !== 'queue_storage_failed' || !/Recipe storage (?:is full|exceeds)/.test(error.message ?? '')) throw error;
      const round = await reclaimLocked().catch(() => null);
      if (!round?.reclaimed) throw error;
      return writeFile(file, entry);
    }
  };
  let reclaimTimer: ReturnType<typeof setTimeout> | null = null, reclaimStopped = false;
  const scheduleReclaim = (delay: number) => {
    if (!reclaim.auto || reclaimStopped) return;
    reclaimTimer = setTimeout(() => {
      reclaimTimer = null;
      void reclaimRecipes().then(() => scheduleReclaim(reclaim.intervalMs), (error: any) => { if (error?.code === 'ENOENT') reclaimStopped = true; else scheduleReclaim(reclaim.intervalMs); });
    }, Math.max(0, delay));
    reclaimTimer.unref?.();
  };
  scheduleReclaim(reclaim.startDelayMs);

  const retention = { ...QUEUE_RETENTION, auto: false, days: () => QUEUE_RETENTION.defaultDays as number | null, ...(options.retention ?? {}) };
  const retentionNow = () => retention.now?.() ?? Date.now();
  const retentionLog = retention.log ?? log;
  const retentionDays = (): number | null => { const value = retention.days(); return value === null ? null : Number.isSafeInteger(value) && value >= 1 ? value : QUEUE_RETENTION.defaultDays; };
  let lastRetention: QueueRetentionRun | null = null, retentionRuns = 0;
  /** Ended agent batches past the retention period at `now`: more than `days` whole days after their end, oldest first. */
  const retentionDue = (now: number, days: number, skip: ReadonlySet<string> = new Set()) => options.batch.list({ workspaceId: QUEUE_WORKSPACE }).batches
    .filter(job => !skip.has(job.batchId) && job.execution === 'queued' && job.originWorkspaceId === QUEUE_WORKSPACE && job.source?.kind !== 'manual' && isBatchTerminal(job.status)
      && job.requestKey.startsWith('mcp-') && typeof job.finishedAt === 'string' && Number.isFinite(Date.parse(job.finishedAt)) && now - Date.parse(job.finishedAt) > days * QUEUE_RETENTION.dayMs)
    .sort((a, b) => Date.parse(a.finishedAt!) - Date.parse(b.finishedAt!));
  const itemCounts = (job: BatchJob): CleanedItemCounts => {
    const counts = Object.fromEntries(CLEANED_ITEM_STATUSES.map(status => [status, 0])) as CleanedItemCounts;
    for (const item of job.items) if ((CLEANED_ITEM_STATUSES as readonly string[]).includes(item.status)) counts[item.status as keyof CleanedItemCounts]++;
    return counts;
  };
  /**
   * One retention round with the store's sequence held (no put, enqueue or receipt change interleaves). Step order, so a
   * crash anywhere leaves a state the next round finishes: 1. the records of the batches and recipes (synced); 2. the
   * recipe files; 3. the receipts; 4. the frozen batches (their own purge marker). Lookups that do not wait for the
   * sequence find either the receipt or the record. A frozen queue that has stopped when a round starts is left exactly
   * as it is; one that stops during step 4 leaves the round's records written and its receipts removed, and a later round
   * removes those batches once the frozen queue works again (their keys answer from the records meanwhile).
   */
  const isoTime = (value: unknown, fallback: string) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : fallback;
  const retentionRound = async (now: number, days: number, run: QueueRetentionRun, keptIds: Set<string>) => {
    const due = retentionDue(now, days, keptIds), round = due.slice(0, retention.roundLimit);
    if (!round.length) return 0;
    // A frozen queue that stopped (storage failure) is left exactly as it is: nothing is recorded or removed.
    try { options.batch.queueAdmission?.(); } catch { run.skipped = 'frozen_queue_unreadable'; return 0; }
    run.rounds++;
    // Every receipt is read once: the due batches' own and, for the recipes, every other receipt that may name one.
    const readStart = performance.now(), saved = new Map<string, Receipt | 'unreadable'>();
    for (const name of (await fs.readdir(directory)).filter(name => receiptName.test(name))) {
      try { saved.set(name, await readFile<Receipt>(path.join(directory, name))); } catch { saved.set(name, 'unreadable'); }
    }
    run.receiptsRead += saved.size; run.receiptReadMs += performance.now() - readStart;
    const batches: CleanedRecord[] = [], chosen: Array<{ job: BatchJob; receipt: Receipt | null; file: string }> = [], ownReceipts = new Set<string>();
    const skip = (job: BatchJob, why: string) => { run.kept++; keptIds.add(job.batchId); retentionLog(`[queue-retention] batch ${job.batchId} is kept: ${why}.`); };
    for (const job of round) {
      const file = receiptPath(job.requestKey), name = path.basename(file), value = saved.get(name);
      const owns = (receipt: Receipt) => { try { return Boolean(receipt.args) && options.batch.lookup(receipt.args)?.batchId === job.batchId; } catch { return false; } };
      if (value === 'unreadable' || (value && (value.requestKey !== job.requestKey || value.status === 'rejected' || (value.batchId !== null && value.batchId !== job.batchId) || (value.batchId === null && !owns(value))))) {
        skip(job, `its receipt ${value === 'unreadable' ? 'cannot be read' : 'names another batch'}`); continue;
      }
      const receipt = value ?? null;
      const record: CleanedBatchRecord = { kind: 'batch', v: 1, keyHash: recipeHash(job.requestKey), batchId: job.batchId, mode: job.mode, status: job.status as CleanedBatchRecord['status'],
        stopCode: job.error && /^[a-z][a-z0-9_]{0,79}$/.test(job.error.code) ? job.error.code : null, count: job.count, counts: itemCounts(job),
        requestHash: receipt?.requestHash ?? null, recipePlanHash: receipt?.recipePlanHash ?? null, intervalSeconds: job.intervalSeconds, ...(receipt?.output ? { output: structuredClone(receipt.output) } : {}),
        createdAt: isoTime(job.createdAt, isoTime(job.finishedAt, new Date(now).toISOString())), finishedAt: isoTime(job.finishedAt, new Date(now).toISOString()), cleanedAt: new Date(now).toISOString() };
      // A batch whose record would not pass (an unexpected stored value) is left as it is, with its receipt; the rest go on.
      if (!validCleanedRecord(record)) { run.invalid++; skip(job, 'its record would not pass the check (left with its receipt)'); continue; }
      if (receipt) ownReceipts.add(name);
      chosen.push({ job, receipt, file }); batches.push(record);
    }
    if (!chosen.length) return 0;
    // Plain recipes only these receipts named (option B). Any other receipt, of any status, keeps what it names; an
    // unreadable one keeps every recipe this round. Canvas captures keep their own 7-day rule.
    const kept = new Set<string>(); let blocked = false;
    for (const [name, value] of saved) {
      if (ownReceipts.has(name)) continue;
      if (value === 'unreadable' || !Array.isArray(value.items)) { blocked = true; break; }
      for (const item of value.items) if (item && typeof item.recipeId === 'string') kept.add(recipeKey(item.recipeId, item.recipeRevision));
    }
    const recipeRecords: CleanedRecord[] = [], recipeFiles: string[] = [];
    if (!blocked) {
      const candidates = new Map<string, QueueItem>();
      for (const { receipt } of chosen) for (const item of receipt?.items ?? []) { const identity = recipeKey(item.recipeId, item.recipeRevision); if (!kept.has(identity)) candidates.set(identity, item); }
      for (const item of candidates.values()) {
        const file = filename(item.recipeId, item.recipeRevision);
        let origin: CanvasOrigin | null;
        try { if (!(await fs.lstat(file)).isFile()) continue; origin = await canvasOriginAt(file); } catch { continue; }
        if (origin) continue;
        const record: CleanedRecord = { kind: 'recipe', v: 1, recipeId: item.recipeId, recipeRevision: item.recipeRevision, cleanedAt: new Date(now).toISOString() };
        if (!validCleanedRecord(record)) continue;
        recipeFiles.push(file); recipeRecords.push(record);
      }
    }
    await withQuota(async () => {
      await tombstones.append([...batches, ...recipeRecords]);
      let records = 0, bytes = 0;
      for (const file of recipeFiles) {
        let info; try { info = await fs.lstat(file); } catch (error: any) { if (error.code === 'ENOENT') continue; throw error; }
        if (!info.isFile() || info.isSymbolicLink()) continue;
        await fs.unlink(file); records++; bytes += info.size; run.recipes++; run.recipeBytes += info.size;
      }
      for (const { receipt, file } of chosen) {
        if (!receipt) continue;
        let info; try { info = await fs.lstat(file); } catch (error: any) { if (error.code === 'ENOENT') continue; throw error; }
        if (!info.isFile() || info.isSymbolicLink()) continue;
        await fs.unlink(file); records++; bytes += info.size; run.receipts++; run.recipeBytes += info.size;
      }
      await syncDirectory(directory);
      if (recipeUsage) recipeUsage = { records: recipeUsage.records - records, total: recipeUsage.total - bytes };
    });
    const retired = await options.batch.retire!(chosen.map(entry => entry.job.batchId));
    run.cleaned += retired.removed.length + retired.deferred.length; run.deferred += retired.deferred.length; run.frozenBytes += retired.reclaimedBytes;
    return chosen.length;
  };
  /** Rounds until nothing is due (each with the sequence held, so enqueues run between rounds). */
  const runRetention = async (): Promise<QueueRetentionRun> => {
    const started = performance.now();
    let days = retentionDays();
    const run: QueueRetentionRun = { at: new Date(retentionNow()).toISOString(), days, skipped: null, cleaned: 0, receipts: 0, recipes: 0, frozenBytes: 0, recipeBytes: 0, deferred: 0, rounds: 0, kept: 0, invalid: 0, receiptsRead: 0, receiptReadMs: 0, ms: 0 };
    let reported = false;
    const finish = () => {
      run.ms = Math.round(performance.now() - started); run.receiptReadMs = Math.round(run.receiptReadMs); lastRetention = run;
      if (!reported) { reported = true; try { retention.onRun?.(structuredClone(run)); } catch { /* the window may be closing */ } }
      return run;
    };
    if (days === null) { run.skipped = 'never'; return finish(); }
    retentionRuns++;
    try {
      if (!options.batch.retire || await options.batch.ready.then(() => false, () => true)) { run.skipped = 'frozen_queue_unreadable'; return finish(); }
      try { await tombstones.load(); if (tombstones.health().state !== 'ok') throw new QueueTombstoneError(tombstones.entry, tombstones.health().problem!, tombstones.health().detail ?? ''); }
      catch (error) { run.skipped = 'cleaned_records_unreadable'; try { cleanedUnreadable(error); } catch { /* logged */ } return finish(); }
      const keptIds = new Set<string>();
      // Keys the library names but the records lost are recorded first (a failure is logged; the cleaning goes on).
      await settleAndRecover('cleaning');
      try {
        for (let index = 0; index < 1000; index++) {
          // The period is read again for every round (the setting may change while a long run goes on).
          const current = retentionDays(); if (current === null) { run.skipped = 'never'; break; }
          days = current; run.days = current;
          if (!await exclusive(async () => { await init(); return retentionRound(retentionNow(), current, run, keptIds); })) break;
        }
      } catch (error) { retentionLog(`[queue-retention] a cleaning round stopped (${(error as any)?.code ?? (error instanceof Error ? error.message : 'error')}); what it recorded is finished by the next round.`); throw error; }
    } finally { retentionRuns--; finish(); }
    finish();
    if (run.cleaned || run.recipes) retentionLog(`[queue-retention] cleaned ${run.cleaned} ended batch(es) older than ${days} days (${run.receipts} receipts, ${run.recipes} recipes; ${run.frozenBytes + run.recipeBytes} bytes) in ${run.ms} ms.`);
    return run;
  };
  let retentionTimer: ReturnType<typeof setTimeout> | null = null, retentionFailures = 0, retentionStopped = false;
  /** Stops the timed runs (tests, shutdown); runRetention still works. */
  const stopRetention = () => { retentionStopped = true; if (retentionTimer) { clearTimeout(retentionTimer); retentionTimer = null; } };
  const scheduleRetention = (delay: number) => {
    if (!retention.auto || retentionStopped) return;
    retentionTimer = setTimeout(() => {
      retentionTimer = null;
      void runRetention().then(() => { retentionFailures = 0; return retention.intervalMs; }, () => Math.min(retention.intervalMs, retention.retryMs * 2 ** retentionFailures++)).then(next => scheduleRetention(next));
    }, Math.max(0, delay));
    retentionTimer.unref?.();
  };
  scheduleRetention(retention.startDelayMs);
  /**
   * Recovery from the library (review rework 2). Every agent key (host key "mcp-…") that the library's images name
   * (history queueOrigin) and that has no receipt, no readable record and no batch here gets a record "accepted, ended
   * unknown, cleaned" (batch ID from queueOrigin). Such a key could only have lost its record outside the app (the
   * records rolled back to an older copy, or their folders removed), or come from another data root: either way it is
   * never sent again. Runs at start, after a library restore and before every cleaning; only on healthy records (damaged
   * ones are refused until restored or repaired knowingly). The caller holds the store's sequence.
   */
  const recoverFromLibrary = async (when: 'start' | 'library_restored' | 'cleaning') => {
    const origins = options.libraryQueueOrigins?.() ?? [];
    if (!origins.length) return 0;
    await tombstones.load();
    if (tombstones.health().state !== 'ok') return 0;
    await options.batch.ready.catch(() => undefined);
    let listed: BatchJob[] = [];
    try { listed = options.batch.list({ workspaceId: QUEUE_WORKSPACE }).batches; } catch { listed = []; }
    const liveKeys = new Set(listed.map(job => job.requestKey)), liveIds = new Set(listed.map(job => job.batchId));
    const found = new Map<string, RecoveredBatchRecord>(), at = new Date().toISOString();
    for (const origin of origins) {
      if (typeof origin?.requestKey !== 'string' || !origin.requestKey.startsWith('mcp-') || typeof origin.batchId !== 'string' || !UUID.test(origin.batchId)) continue;
      const keyHash = recipeHash(origin.requestKey);
      if (found.has(keyHash) || tombstones.known.keyHash(keyHash) || tombstones.known.batchId(origin.batchId) || liveKeys.has(origin.requestKey) || liveIds.has(origin.batchId)) continue;
      if (await fs.lstat(receiptPath(origin.requestKey)).then(() => true, () => false)) continue;
      const record: RecoveredBatchRecord = { kind: 'recovered', v: 1, keyHash, batchId: origin.batchId, savedImages: Math.max(0, Math.floor(origin.images) || 0), recoveredAt: at };
      if (validCleanedRecord(record)) found.set(keyHash, record);
    }
    if (!found.size) return 0;
    const added = await withQuota(() => tombstones.append([...found.values()]));
    if (added) log(`[queue-retention] ${added} cleaned record(s) recovered from the library (${when}): agent keys its images name had no receipt, record or batch here (the records were rolled back or removed outside the app, or the images came from another data root); they answer accepted and ended, and are never sent again.`);
    return added;
  };
  /** Healthy records whose anchors are behind (a crash after the lines were synced): the anchors catch up. */
  const settleRecords = async () => { await tombstones.load(); if (tombstones.anchorsBehind()) await withQuota(() => tombstones.settleAnchors()); };
  const settleAndRecover = (when: 'start' | 'library_restored' | 'cleaning') => {
    const work = exclusive(async () => { await settleRecords(); return recoverFromLibrary(when); });
    const done = work.catch(error => { log(`[queue-retention] the cleaned records could not be checked against the library (${when}): ${(error as any)?.code ?? (error instanceof Error ? error.message : 'error')}.`); return 0; });
    recordsSettled = done;
    return done;
  };
  // At start: only when there is something to check (the records exist, or the library names agent keys).
  if (options.libraryQueueOrigins || options.cleanedAnchorDir) void settleAndRecover('start').catch(() => undefined);
  /** Settings › Queue: the retention period, the batches cleaned so far (records whose batch is gone) and the last run. */
  const retentionStatus = () => {
    const loaded = new Set(options.batch.list({ workspaceId: QUEUE_WORKSPACE }).batches.map(job => job.batchId));
    return { days: retentionDays(), cleanedBatches: tombstones.known.batchIds().filter(id => !loaded.has(id)).length, recoveredFromLibrary: tombstones.known.recovered(), running: retentionRuns > 0, lastRun: lastRetention ? structuredClone(lastRetention) : null, records: tombstones.health(), recordFiles: { records: tombstones.entry, anchors: tombstones.anchors } };
  };
  /** Reads the cleaned records again when they changed (so the status names damage found since). */
  const retentionStatusFresh = () => tombstones.load().catch(() => undefined);
  /** Settings › Queue: how many ended batches a period would clean right now (asked before a shorter period is saved). */
  const retentionPreview = (days: number | null) => days === null || !Number.isSafeInteger(days) || days < 1 ? { days, batches: 0 } : { days, batches: retentionDue(retentionNow(), days).length };
  /**
   * A knowing repair of damaged cleaned records (Settings › Queue, review rework 2026-11). The plan: how many records the
   * anchors say were written, how many can still be read, the keys the library's images name that have neither a
   * receipt nor a readable record (they get a record "accepted, ended unknown, cleaned"), and what stays lost (batches
   * that made no image; only those could be sent again if an agent reused their keys).
   */
  const repairPlan = async () => {
    await tombstones.load().catch(() => undefined);
    const health = tombstones.health();
    const readable = health.state === 'ok' ? [] : await tombstones.readable();
    const knownKeys = new Set(readable.flatMap(record => record.kind === 'batch' || record.kind === 'recovered' ? [record.keyHash] : []));
    const recovered = new Map<string, RecoveredBatchRecord>(), at = new Date().toISOString();
    if (health.state !== 'ok') for (const origin of options.libraryQueueOrigins?.() ?? []) {
      // Only agent keys (the ones retention cleans and an agent could send again); window batches have none to protect.
      if (typeof origin?.requestKey !== 'string' || !origin.requestKey.startsWith('mcp-') || typeof origin.batchId !== 'string' || !UUID.test(origin.batchId)) continue;
      const keyHash = recipeHash(origin.requestKey);
      if (knownKeys.has(keyHash) || recovered.has(keyHash) || await fs.lstat(receiptPath(origin.requestKey)).then(() => true, () => false)) continue;
      recovered.set(keyHash, { kind: 'recovered', v: 1, keyHash, batchId: origin.batchId, savedImages: Math.max(0, Math.floor(origin.images) || 0), recoveredAt: at });
    }
    const readableLines = readable.length, lost = health.anchored === null ? null : Math.max(0, health.anchored - readableLines);
    // unrecoverable: at most every lost line (a recovered key may never have had a line here, e.g. from another data root).
    return { needed: health.state !== 'ok', health, readable: readableLines, lost, recoverable: recovered.size, unrecoverable: lost, records: [...recovered.values()] };
  };
  const repairCleanedRecords = (confirm: { lost: number | null; recoverable: number }) => exclusive(async () => {
    const plan = await repairPlan();
    if (!plan.needed) return { repaired: false, reason: 'not_needed' as const, plan: { ...plan, records: undefined } };
    // What the user confirmed must still be what would happen.
    if (plan.lost !== confirm.lost || plan.recoverable !== confirm.recoverable) return { repaired: false, reason: 'plan_changed' as const, plan: { ...plan, records: undefined } };
    const result = await withQuota(() => tombstones.repair(plan.records, { anchored: plan.health.anchored, readable: plan.readable, recovered: plan.recoverable, problem: plan.health.problem ?? 'read_failed' }));
    log(`[queue-retention] cleaned records repaired knowingly (${plan.health.problem}): ${result.kept} readable kept, ${result.added} recovered from the library, ${plan.lost ?? 'an unknown number of'} line(s) lost${plan.lost ? ' (of those, the batches that made no image could be sent again if an agent reused their keys)' : ''}.`);
    return { repaired: true, kept: result.kept, recovered: result.added, plan: { ...plan, records: undefined } };
  });
  /** A backup's cleaned records, added to these (data-backup import); damaged ones are restored only when complete. */
  const restoreCleanedRecords = (files: Array<{ name: string; data: Buffer }>) => exclusive(async () => {
    const result = await withQuota(() => tombstones.restore(files));
    log(`[queue-retention] cleaned records from a backup: ${result.status} (${result.added} added).`);
    return result;
  });
  const cleanedRecordFiles = () => tombstones.exportFiles();
  /** After the library was restored from a backup: its images may name keys the records here do not know. */
  const libraryRestored = () => settleAndRecover('library_restored');
  /** A request that already has a receipt may own a durable batch even when the frozen queue cannot be read now
   * (it failed to load, or failed after this batch's input reached disk). Its outcome is then unknown — never the
   * pre-receipt `queue_storage_error`, which means only "refused before any receipt, nothing queued". */
  const unknownWhileUnreadable = (saved: Receipt): never => fail('queue_acceptance_unknown', saved.status === 'accepted'
    ? 'This request was accepted, but the frozen queue cannot be read right now. Do not resend; look up the same requestKey again after the client restarts.'
    : 'The frozen queue cannot be read right now, so whether this request was accepted is unknown. Do not resend; look up the same requestKey again after the client restarts.');
  const lookupSaved = (saved: Receipt, frozenError: unknown): BatchJob | null => {
    if (frozenError) return unknownWhileUnreadable(saved);
    try { return options.batch.lookup(saved.args); }
    catch (error: any) { if (error?.code === 'queue_storage_error' || error?.code === 'queue_unavailable') return unknownWhileUnreadable(saved); throw error; }
  };
  const decorate = async (job: BatchJob) => { const saved = await receipt(job.requestKey); return { ...job, ...(saved ? { recipePlanHash: saved.recipePlanHash } : {}), ...(saved?.output ? { output: structuredClone(saved.output) } : {}) }; };
  /** read_queue only: the saved file of each result, from the history record that this very item produced. */
  const withResultFiles = (job: BatchJob & Record<string, any>) => ({ ...job, items: job.items.map(item => ({ ...item, results: item.results.map(result => {
    let history: HistoryItem | null = null;
    try { history = item.jobId && options.historyById ? options.historyById(result.id) : null; } catch { history = null; }
    // A manual batch's image is saved like every manual image, without a generation origin; its id binds it.
    const bound = history && history.id === result.id && (history.generationOrigin?.jobId === item.jobId || (job.source?.kind === 'manual' && !history.generationOrigin));
    return history && bound && typeof history.filePath === 'string' && history.filePath
      ? { ...result, fileName: path.basename(history.filePath), filePath: history.filePath } : result;
  }) })) });
  /** Before a receipt exists: refuse (queue_full) without consuming the key when the frozen queue cannot take
   * the batch even after one bounded reclaim. Unknown capacity leaves the decision to the batch service. */
  const ensureFrozenCapacity = async (needed: number) => {
    const fits = (value: BatchCapacity) => value.batches < value.batchLimit && value.bytes + needed + value.reserve + FROZEN_PRECHECK_SAVE_MARGIN <= value.byteLimit;
    let current = options.batch.capacity?.() ?? null;
    if (!current || fits(current)) return;
    if (current.batches < current.batchLimit && options.batch.reclaim) { current = (await options.batch.reclaim(FROZEN_RECLAIM_LIMIT)).capacity; if (!current || fits(current)) return; }
    const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
    throw new WorkspaceError('queue_full', current.batches >= current.batchLimit
      ? `The frozen queue already holds its maximum of ${current.batchLimit} batches. Nothing was queued and this requestKey was not used.`
      : `The frozen queue has no room for this batch (about ${mib(needed)} MiB; ${mib(current.bytes)} of ${mib(current.byteLimit)} MiB used, ${mib(current.reserve)} MiB kept for running batches) even after cleaning ended batches. Nothing was queued and this requestKey was not used.`,
      { frozenQueue: { batches: current.batches, batchLimit: current.batchLimit, bytes: current.bytes, byteLimit: current.byteLimit, reserve: current.reserve }, estimatedBytes: needed });
  };
  /** context.source: who enqueues (main.ts: the MCP client of the bridge call); kept on the batch, outside the request and its receipt. */
  const enqueueRecipes = (raw: unknown, context: { source?: BatchSource } = {}) => exclusive(async () => {
      preflight(raw); const args = record(raw, 'queue submission'); keys(args, ['requestKey', 'items', 'intervalSeconds', 'output']);
      const key = requestKey(args.requestKey), intervalSeconds = args.intervalSeconds ?? 0;
      let output: QueueOutput | undefined;
      try { output = parseQueueOutput(args.output); } catch (error: any) { return fail('invalid_argument', error.message); }
      if (output?.historyGroup !== undefined && !options.resolveHistoryGroup) fail('invalid_argument', 'This client cannot save queued images into a history group.');
      if (!Array.isArray(args.items) || !args.items.length || args.items.length > QUEUE_ENQUEUE_ITEMS.max || typeof intervalSeconds !== 'number' || !Number.isFinite(intervalSeconds) || intervalSeconds < 0 || intervalSeconds > 60) fail('invalid_argument', `Queue 1–${QUEUE_ENQUEUE_ITEMS.max} items with interval 0–60 seconds.`);
      const items: QueueItem[] = args.items.map((raw: any) => {
        keys(raw, ['recipeId', 'recipeRevision', 'inputHash', 'seed']);
        if (typeof raw.inputHash !== 'string' || !HASH.test(raw.inputHash) || (raw.seed !== undefined && !validSeed(raw.seed))) fail('invalid_argument', 'Invalid input hash or seed.');
        return { recipeId: recipeId(raw.recipeId), recipeRevision: revision(raw.recipeRevision), inputHash: raw.inputHash, ...(raw.seed !== undefined ? { seed: raw.seed } : {}) };
      });
      await init();
      const frozenError = await options.batch.ready.then(() => null, (error: unknown) => error);
      // The output is part of the plan; a request without one keeps exactly the original hash.
      const requestHash = recipeHash({ requestKey: key, items, intervalSeconds, ...(output ? { output } : {}) }), recipePlanHash = recipeHash(items);
      // An existing receipt answers first and reads no recipe, so a repeat of an accepted request still works after
      // its canvas recipes were reclaimed.
      let saved = await receipt(key);
      if (saved) {
        if (saved.requestHash !== requestHash) fail('request_conflict', 'This key already identifies a different queue plan.');
        if (saved.status === 'rejected') fail(saved.error!.code, saved.error!.message);
        if (!saved.args) fail('queue_acceptance_unknown', 'Queue preparation was interrupted before acceptance could be determined; do not resend automatically.');
        const job = lookupSaved(saved, frozenError);
        if (job) {
          if (saved.status !== 'accepted') {
            try { saved = await moveReceipt(saved, 'accepted', { batchId: job.batchId, result: { batchId: job.batchId }, error: null }); }
            catch { return decorate(job); } // Lookup proves acceptance; never replay merely because the receipt cannot grow.
          }
          if (saved.batchId && saved.batchId !== job.batchId) fail('queue_storage_failed', 'Queue receipt points to a different accepted batch.');
          return decorate(job);
        }
        if (saved.status === 'accepted') {
          // Its batch was cleaned while this receipt was being read (the cleaned record is written before anything is removed).
          const cleaned = await cleanedByKey(key);
          if (cleaned && cleaned.batchId === saved.batchId) return cleanedBatch(cleaned, key);
          fail('queue_storage_failed', 'An accepted queue receipt has no matching durable batch.');
        }
        if (saved.status === 'preparing') await moveReceipt(saved, 'unknown', { error: { code: 'queue_acceptance_unknown', message: 'Queue acceptance could not be confirmed; do not resend automatically.' } });
        fail('queue_acceptance_unknown', 'This request has a saved receipt but no confirmed batch. Inspect it; do not resend automatically.');
      }
      // No receipt: a key whose batch ended and was cleaned answers from its record and is never queued again.
      const cleaned = await cleanedByKey(key);
      if (cleaned) {
        // A key rebuilt from the library has no plan to compare: it is answered as accepted, whatever the plan (never sent again).
        if (cleaned.kind === 'batch' && cleaned.requestHash !== requestHash) fail('request_conflict', `This requestKey was used for ${cleaned.requestHash ? 'a different queue plan' : 'a queue plan'}; its batch ended (${cleaned.status}) and was cleaned on ${cleaned.cleanedAt}. Nothing was queued; a different plan needs a new requestKey.`);
        return cleanedBatch(cleaned, key);
      }
      const entries = new Map<string, RecipeRecord>();
      for (const item of items) entries.set(recipeKey(item.recipeId, item.recipeRevision), await loadExisting(item.recipeId, item.recipeRevision));
      // Up to the receipt, this runs only for a new request (an accepted batch carries its own bytes) and a
      // rejection leaves no receipt, so the key is not consumed (queue_storage_error means exactly this):
      if (frozenError) throw frozenError;
      // 0. the plan stays within the client's per-enqueue setting (an accepted request above is returned as it is,
      //    even after the setting was lowered);
      const enqueueLimit = normalizeQueueEnqueueItems(options.enqueueItemLimit?.() ?? QUEUE_ENQUEUE_ITEMS.default);
      if (items.length > enqueueLimit) throw new WorkspaceError('enqueue_limit_exceeded',
        `This enqueue has ${items.length} images; the client's setting allows at most ${enqueueLimit} per enqueue (Settings, Queue safety: 1–${QUEUE_ENQUEUE_ITEMS.max}). Split the plan or ask the user to raise the limit. Nothing was queued and this requestKey was not used.`,
        { requestedItems: items.length, maxItemsPerEnqueue: enqueueLimit });
      // 1. every item names the stored recipe's exact inputHash (the builder is rechecked after the receipt);
      for (const item of items) if (entries.get(recipeKey(item.recipeId, item.recipeRevision))!.inputHash !== item.inputHash)
        fail('recipe_changed', 'Queue input differs from the stored recipe (inputHash). Nothing was queued and this requestKey was not used.');
      // 2. history- or study-referenced sources are reread once per recipe (deleted, replaced or busy source);
      const materialized = new Map<string, PromptReviewPreparation>();
      for (const [identity, entry] of entries) if (entry.preparation.assets.some(isReferenceAsset)) materialized.set(identity, await materialize(entry.preparation, entry));
      // 3. Upscale/Director ignore seeds; one item per recipe keeps one submission from paying twice for the same request;
      const unseededRecipes = new Set<string>();
      for (const item of items) {
        const identity = recipeKey(item.recipeId, item.recipeRevision);
        if (isSeededGeneration(entries.get(identity)!.preparation.mode)) continue;
        if (item.seed !== undefined) fail('invalid_argument', 'Upscale and Director recipes do not use a seed; omit seed for these items.');
        if (unseededRecipes.has(identity)) fail('invalid_argument', 'An upscale or Director recipe may appear only once in one queue submission.');
        unseededRecipes.add(identity);
      }
      // 4. the frozen queue must be available and below its unfinished-item limit (an unavailable or failed
      //    queue throws here, so no receipt claims a key it could never settle);
      const admission = options.batch.queueAdmission?.();
      if (admission && admission.pendingItemLimit !== null && admission.pendingItems + items.length > admission.pendingItemLimit) throw new WorkspaceError('queue_full',
        `The queue already holds ${admission.pendingItems} unfinished items and takes at most ${admission.pendingItemLimit} (the client's total queue limit, Settings, Queue safety). Nothing was queued and this requestKey was not used.`, { pendingItems: admission.pendingItems, pendingItemLimit: admission.pendingItemLimit });
      // 5. the frozen queue must have room for this batch, after at most one bounded reclaim.
      await ensureFrozenCapacity(estimateFrozenBatchBytes(key, items.map(item => { const recipe = recipeKey(item.recipeId, item.recipeRevision); return { recipe, preparation: entries.get(recipe)!.preparation }; })));
      // 6. the history group exists (created on first use, reused by name) before the receipt claims the key.
      if (output?.historyGroup !== undefined) {
        let group: { id: string; name: string };
        try { group = options.resolveHistoryGroup!(output.historyGroup); }
        catch (error) {
          if (error instanceof QueueHistoryGroupConflict) return fail(error.code, `${error.message} Nothing was queued and this requestKey was not used.`);
          return fail('history_group_unavailable', 'The history group could not be created or read. Nothing was queued and this requestKey was not used.');
        }
        if (!group || typeof group.id !== 'string' || !group.id || typeof group.name !== 'string') fail('history_group_unavailable', 'The history group could not be created or read. Nothing was queued and this requestKey was not used.');
        output = { ...output, historyGroupId: group.id, historyGroupName: group.name };
      }
      const initial: Receipt = { schemaVersion: 2, requestKey: key, requestHash, recipePlanHash, items, args: null, status: 'preparing', revision: 1, batchId: null, result: null, error: null,
        previousRecordHash: null, updatedAt: new Date().toISOString(), ...(output ? { output } : {}) };
      await writeData(receiptPath(key), fixedReceipt(initial, receiptSlotBytes(items.length)));
      saved = await receipt(key);
      if (!saved) fail('queue_storage_failed', 'Queue receipt could not be committed.');
      // Other input problems are found while freezing, after the receipt, and keep their recorded rejection.
      const rejectBeforeDispatch = async (error: any): Promise<never> => {
        const bounded = receiptError(error?.code, error instanceof Error ? error.message : undefined);
        await moveReceipt(saved as Receipt, 'rejected', { error: bounded, result: null, batchId: null });
        return fail(bounded.code, bounded.message);
      };
      const frozenItems: string[] = [], seeds: number[] = []; let mode = '';
      // One check and freeze per recipe revision: twenty seeds of one recipe rebuild (and decode its source) once.
      const checked = new Map<string, { value: Awaited<ReturnType<typeof readRecipeWith>>; frozen: GenerationSnapshot }>();
      try {
        for (const item of items) {
          const identity = recipeKey(item.recipeId, item.recipeRevision);
          let check = checked.get(identity);
          if (!check) {
            const value = await readRecipeWith({ recipeId: item.recipeId, recipeRevision: item.recipeRevision }, materialized), frozen = await freezeReviewedGeneration(value.snapshot.reviewInput);
            // Every image of this enqueue saves into the requested group and with the requested prefix, in every mode.
            if (output?.historyGroupId) frozen.extras = { ...frozen.extras, historyGroupId: output.historyGroupId };
            if (output?.fileNamePrefix) frozen.extras = { ...frozen.extras, fileNamePrefix: output.fileNamePrefix };
            checked.set(identity, check = { value, frozen });
          }
          const { value, frozen } = check;
          if (item.inputHash !== value.inputHash) fail('recipe_changed', 'Queue input differs from the checked recipe.');
          if (mode && mode !== value.snapshot.mode) fail('invalid_argument', 'Each queue submission must use one generation mode; submit different modes separately.');
          mode = value.snapshot.mode;
          const seeded = isSeededGeneration(value.snapshot.mode);
          // Batch storage requires a valid planned seed; the generation service records actualSeed:null for unseeded modes.
          const seed = !seeded ? 0 : item.seed ?? (frozen.params.seedMode === 'random' || frozen.params.seed < 0 ? (options.randomSeed?.() ?? randomInt(1, 2147483647)) : frozen.params.seed);
          if (!validSeed(seed)) fail('invalid_argument', 'Recipe contains an invalid planned seed.');
          frozenItems.push(identity); seeds.push(seed);
        }
      } catch (error) { return rejectBeforeDispatch(error); }
      const submit = { execution: 'queued', workspaceId: QUEUE_WORKSPACE, expectedRevision: 0, requestKey: key, mode, count: items.length, intervalSeconds, seeds };
      saved = await moveReceipt(saved as Receipt, 'preparing', { args: submit });
      // One snapshot when every image uses the same frozen input (one recipe, or equal ones), else one per image; a
      // repeated recipe gets its own copy there, as if frozen separately (per-item noise seeds stay per item).
      const frozenPayload = (() => {
        if (frozenItems.length > 1 && checked.size === 1) return { snapshot: checked.get(frozenItems[0])!.frozen };
        const firstUse = new Set<string>(), snapshots = frozenItems.map(identity => firstUse.has(identity) ? structuredClone(checked.get(identity)!.frozen) : (firstUse.add(identity), checked.get(identity)!.frozen));
        const first = recipeHash(snapshots[0]);
        return snapshots.length > 1 && snapshots.every(snapshot => recipeHash(snapshot) === first) ? { snapshot: snapshots[0] } : { snapshots };
      })();
      let accepted: BatchJob;
      try { accepted = await options.batch.enqueue({ ...submit, ...frozenPayload, ...(context.source ? { source: context.source } : {}) }); }
      catch (error: any) {
        let job: BatchJob | null = null;
        try { job = options.batch.lookup(submit); } catch { /* A failed lookup cannot authorize replay. */ }
        if (job) {
          try { await moveReceipt(saved as Receipt, 'accepted', { batchId: job.batchId, result: { batchId: job.batchId }, error: null }); } catch { /* The durable batch remains lookup-reconcilable. */ }
          return decorate(job);
        }
        const explicit = new Set(['queue_full', 'queue_input_too_large', 'invalid_argument', 'invalid_arguments', 'unsupported_mode', 'request_conflict', 'unavailable', 'queue_unavailable']);
        if (explicit.has(error?.code)) {
          const bounded = receiptError(error.code, error instanceof Error ? error.message : 'Queue submission was explicitly rejected.');
          await moveReceipt(saved as Receipt, 'rejected', { error: bounded, batchId: null, result: null });
          return fail(bounded.code, bounded.message);
        }
        try { await moveReceipt(saved as Receipt, 'unknown', { error: { code: 'queue_acceptance_unknown', message: 'Queue acceptance could not be confirmed; do not resend automatically.' }, batchId: null, result: null }); } catch { /* Preserve preparing as equally non-replayable. */ }
        return fail('queue_acceptance_unknown', 'Queue acceptance could not be confirmed; inspect the same request and do not resend automatically.');
      }
      try { saved = await moveReceipt(saved as Receipt, 'accepted', { batchId: accepted.batchId, result: { batchId: accepted.batchId }, error: null }); }
      catch { return fail('queue_acceptance_unknown', 'The batch was accepted but its final receipt could not be persisted. Reconcile this same request; do not resend.'); }
      return decorate(accepted);
  });
  /** Dry run of a new-recipe put: same normalization, source reread and builder, plus an inpaint overlay.
   * No init, lock, receipt or record: it creates no directory or file and uses no revision or quota.
   * canvas: the canvas capture's assembly rule (put_canvas_recipe). */
  async function previewRecipe(raw: unknown, canvas: boolean) {
    preflight(raw); const args = record(raw, 'recipe preview'); keys(args, ['preparation', 'assetData']);
    const omitAssetData = assetDataOmitted(args.assetData);
    const preparation = normalizeQueuePreparation(args.preparation, { newRecipe: true, authoredAssembly: canvas });
    const reviewInput = await buildPromptReview(await materialize(preparation, null));
    return queueRecipePreviewResult({ inputHash: inputHash(reviewInput), characterIds: characterIdsFor(preparation), reviewInput, assetDetails: assetDetails(preparation), omitAssetData });
  }
  const api = {
    put_queue_recipe(raw: unknown) { return exclusive(async () => {
      preflight(raw); const args = record(raw, 'recipe write'); keys(args, ['recipeId', 'expectedRevision', 'preparation', 'assetData']);
      const omitAssetData = assetDataOmitted(args.assetData);
      await init();
      if ((args.recipeId === undefined) !== (args.expectedRevision === undefined)) fail('invalid_argument', 'Updating a recipe requires its ID and expectedRevision.');
      const id = args.recipeId === undefined ? randomUUID() : recipeId(args.recipeId);
      let version = 1, inheritedPromptAssemblyVersion: 1 | undefined;
      if (args.recipeId !== undefined) {
        const expected = revision(args.expectedRevision);
        const versions = (await fs.readdir(directory)).filter(name => name.startsWith(`${id}.`) && name.endsWith('.json')).map(name => Number(name.split('.')[1]));
        // A revision number the queue retention reclaimed stays used: a new revision always takes a larger one.
        const reclaimed = await tombstones.reclaimedRevisions(id).catch(cleanedUnreadable);
        const latest = Math.max(0, ...versions, ...reclaimed);
        if (reclaimed.includes(expected) && latest === expected) await loadExisting(id, expected);
        if (!latest || latest !== expected) fail('recipe_conflict', 'Another writer already revised this recipe.');
        const previous = await loadExisting(id, expected);
        // A canvas capture is one revision of one canvas state; it is captured again, never revised.
        if (previous.canvasOrigin) fail('invalid_argument', 'A canvas recipe cannot be revised. Capture the canvas again or prepare a new recipe.');
        if (previous.preparation.authored.params.promptAssemblyVersion === 1) inheritedPromptAssemblyVersion = 1;
        version = expected + 1;
      }
      const preparation = normalizeQueuePreparation(args.preparation,{newRecipe:args.recipeId===undefined,inheritedPromptAssemblyVersion});
      // The builder sees bytes; the record keeps the reference exactly as given.
      const input = await buildPromptReview(await materialize(preparation, null));
      const entry: RecipeRecord = { schemaVersion: 1, recipeId: id, recipeRevision: version, preparation, inputHash: inputHash(input) };
      try { await writeRecipe(filename(id, version), entry); } catch (error: any) { if (error.code === 'EEXIST') fail('recipe_conflict', 'Another writer already published this recipe revision.'); throw error; }
      const result = snapshotFor(entry, input);
      return omitAssetData ? withoutAssetData(result) : result;
    }); },
    /** A new recipe frozen from the live canvas (capture_canvas_recipe): the put of a new recipe, plus its canvas
     * origin. Not a bridge method of its own, so only the host's capture can set that origin. */
    put_canvas_recipe(raw: unknown) { return exclusive(async () => {
      preflight(raw); const args = record(raw, 'canvas recipe'); keys(args, ['preparation', 'canvasOrigin', 'assetData']);
      const omitAssetData = assetDataOmitted(args.assetData), canvasOrigin = parseCanvasOrigin(args.canvasOrigin);
      await init();
      // The canvas keeps its own prompt assembly (a canvas without the marker is not upgraded), as read_prompt_review shows it.
      const preparation = normalizeQueuePreparation(args.preparation, { newRecipe: true, authoredAssembly: true });
      const input = await buildPromptReview(await materialize(preparation, null));
      // The origin is written before the (possibly large) preparation: reclamation reads only a file's head to find captures.
      const entry: RecipeRecord = { schemaVersion: 1, recipeId: randomUUID(), recipeRevision: 1, canvasOrigin, preparation, inputHash: inputHash(input) };
      try { await writeRecipe(filename(entry.recipeId, 1), entry); } catch (error: any) { if (error.code === 'EEXIST') fail('recipe_conflict', 'Another writer already published this recipe revision.'); throw error; }
      const result = snapshotFor(entry, input);
      return omitAssetData ? withoutAssetData(result) : result;
    }); },
    preview_queue_recipe(raw: unknown) { return previewRecipe(raw, false); },
    /** The dry run of put_canvas_recipe (same assembly rule); host-internal like it, so only the canvas capture uses it. */
    preview_canvas_recipe(raw: unknown) { return previewRecipe(raw, true); },
    read_queue_recipe: readRecipe,
    enqueue_queue_recipes(raw: unknown, context?: { source?: BatchSource }) { return enqueueRecipes(raw, context); },
    async lookup_queue_request(raw: unknown) {
      preflight(raw); const args = record(raw, 'request lookup'); keys(args, ['requestKey']); const key = requestKey(args.requestKey);
      await init(); const frozenError = await options.batch.ready.then(() => null, (error: unknown) => error);
      let saved = await receipt(key);
      if (!saved) {
        // A cleaned batch keeps answering "accepted" (with its end and counts), never "no receipt".
        const cleaned = await cleanedByKey(key);
        return cleaned ? { batch: cleanedBatch(cleaned, key), status: 'accepted' } : { batch: null }; // receipts precede batches: no receipt, no batch for this key
      }
      if (saved.status === 'rejected') return { batch: null, status: 'rejected', error: saved.error };
      let job: BatchJob | null = null;
      if (saved.args) job = lookupSaved(saved, frozenError);
      if (!job && saved.status === 'accepted') {
        // Its batch was cleaned while this receipt was being read.
        const cleaned = await cleanedByKey(key);
        if (cleaned && cleaned.batchId === saved.batchId) return { batch: cleanedBatch(cleaned, key), status: 'accepted' };
      }
      if (job) {
        let persisted = saved.status === 'accepted';
        if (saved.status !== 'accepted') {
          try { saved = await moveReceipt(saved, 'accepted', { batchId: job.batchId, result: { batchId: job.batchId }, error: null }); persisted = true; }
          catch { persisted = false; }
        }
        if (saved.batchId && saved.batchId !== job.batchId) fail('queue_storage_failed', 'Queue receipt points to a different accepted batch.');
        return { batch: await decorate(job), status: persisted ? 'accepted' : 'unknown' };
      }
      if (saved.status === 'accepted') fail('queue_storage_failed', 'An accepted queue receipt has no matching durable batch.');
      if (saved.status === 'preparing') saved = await moveReceipt(saved, 'unknown', { error: { code: 'queue_acceptance_unknown', message: 'Queue acceptance could not be confirmed; do not resend automatically.' } });
      return { batch: null, status: 'unknown' };
    },
    async list_queue(raw: unknown) {
      keys(raw, []); await init(); await options.batch.ready;
      const batches = await Promise.all(options.batch.list({ workspaceId: QUEUE_WORKSPACE }).batches.filter(job => job.execution === 'queued' && job.originWorkspaceId === QUEUE_WORKSPACE).map(decorate));
      // Latest scans only; a number the host does not have is null, never estimated.
      const frozen = options.batch.capacity?.() ?? null;
      if (!recipeUsage) try { await scanOwned(); } catch { /* A concurrent publication may be mid-flight; report null. */ }
      return { batches, storage: {
        frozenQueue: frozen ? { batches: frozen.batches, batchLimit: frozen.batchLimit, bytes: frozen.bytes, byteLimit: frozen.byteLimit } : null,
        recipeStore: recipeUsage ? { records: recipeUsage.records, recordLimit, bytes: recipeUsage.total, byteLimit: RECIPE_STORE_LIMITS.bytes } : null,
      } };
    },
    async control(method: 'read' | 'pause' | 'resume' | 'cancel', raw: unknown) {
      preflight(raw); const args = record(raw, 'queue control'); keys(args, ['batchId']); const batchId = recipeId(args.batchId);
      // A manual batch (the window's Generate) is never stored and has no receipt: it is read and controlled without the
      // recipe store or the frozen queue, so a failure of either (which stops the agent side) leaves it controllable.
      const frozenError = await options.batch.ready.then(() => null, (error: unknown) => error);
      let known: BatchJob | null = null;
      try { known = options.batch.read({ workspaceId: QUEUE_WORKSPACE, batchId }); } catch { known = null; }
      // A cleaned batch: read, pause and cancel answer its end (nothing changes); nothing can be resumed.
      const answerCleaned = async () => {
        const cleaned = await cleanedByBatch(batchId);
        if (!cleaned) return null;
        if (method === 'resume') fail('batch_not_paused', cleaned.kind === 'batch' ? `This batch ended (${cleaned.status}) and its queue record was cleaned on ${cleaned.cleanedAt}; nothing can be resumed or resent.` : `This batch's queue record was lost and rebuilt from the library on ${cleaned.recoveredAt}; nothing can be resumed or resent.`);
        return cleanedBatch(cleaned);
      };
      if (!known) { const cleaned = await answerCleaned(); if (cleaned) return cleaned; }
      const manual = known?.source?.kind === 'manual' && known.originWorkspaceId === QUEUE_WORKSPACE && known.execution === 'queued';
      if (!manual) { await init(); if (frozenError) throw frozenError; }
      try {
        const owned = options.batch.read({ workspaceId: QUEUE_WORKSPACE, batchId });
        if (owned.originWorkspaceId !== QUEUE_WORKSPACE || owned.execution !== 'queued') fail('invalid_argument', 'This is not an independent queued batch.');
        const result = await options.batch[method]({ workspaceId: QUEUE_WORKSPACE, expectedRevision: 0, batchId });
        return manual ? result : decorate(result);
      } catch (error: any) {
        // Cleaned while this call was on its way (the cleaning removes it from the queue after writing its record).
        if (error?.code === 'batch_not_found' && !manual) { const cleaned = await answerCleaned(); if (cleaned) return cleaned; }
        throw error;
      }
    },
    async get_queue_result(raw: unknown) {
      preflight(raw); const args = record(raw, 'queue result'); keys(args, ['batchId', 'itemIndex', 'index']);
      const job = await api.control('read', { batchId: args.batchId });
      if ((job as { cleaned?: unknown }).cleaned === true) fail('result_unavailable', `This batch ended and its queue record was cleaned on ${(job as { cleanedAt?: string }).cleanedAt} (queue retention). Its saved images stay in the library: asset_library lists them with queueBatchId or queueRequestKey. Nothing is generated again.`);
      if (!Number.isInteger(args.itemIndex) || args.itemIndex < 0 || args.itemIndex >= job.items.length || (args.index !== undefined && (!Number.isInteger(args.index) || args.index < 0))) fail('invalid_argument', 'Invalid queue result index.');
      const item = job.items[args.itemIndex];
      if (!item.jobId) fail('result_unavailable', 'This queue item has no saved result yet.');
      const index = args.index ?? 0;
      // The saved file by name and host path at the top level: the HTTP bridge forwards only listed result keys
      // (never historyItem); the MCP server turns the path into a project-relative one.
      const withFile = <T extends { historyItem?: HistoryItem; historyId?: string }>(value: T) => value?.historyItem && value.historyItem.id === value.historyId && typeof value.historyItem.filePath === 'string' && value.historyItem.filePath
        ? { ...value, fileName: path.basename(value.historyItem.filePath), filePath: value.historyItem.filePath } : value;
      if (options.generation) {
        try { return withFile(await options.generation.result({ workspaceId: QUEUE_WORKSPACE, jobId: item.jobId, index })); }
        catch (error: any) { if (error?.code !== 'job_not_found') throw error; }
      }
      const result = item.results.find((value: { index: number }) => value.index === index);
      const history = result && options.historyById?.(result.id), provenance = history?.generationOrigin;
      if (!result || !history || !options.validateImage || !provenance || provenance.jobId !== item.jobId || provenance.originWorkspaceId !== QUEUE_WORKSPACE || provenance.mode !== job.mode || provenance.submittedRevision !== job.submittedRevision) fail('result_unavailable', 'The saved image record is missing or does not match this queue item.');
      try { return withFile(await readSavedGenerationResult(history!, { jobId: item.jobId!, workspaceId: QUEUE_WORKSPACE, originWorkspaceId: QUEUE_WORKSPACE, submittedRevision: job.submittedRevision, index, actualSeed: result!.actualSeed, model: result!.model }, options.validateImage!)); }
      catch { return fail('result_unavailable', 'The original cannot be read right now; the job and the history are kept and nothing is generated again.'); }
    },
  };
  // reclaimRecipes is host-internal (tests, maintenance); it is not a bridge method.
  /**
   * Recipes whose library-reference sources name one of these history or study items, any revision (Recently Deleted
   * lists them as effects of a deletion). Recipe files are immutable once published, so each one is read once per
   * process; a recipe without a reference (inline sources only) is skipped without parsing. Never a bridge method.
   */
  const referenceCache = new Map<string, Array<{ kind: string; id: string; revision: number }>>();
  async function sourceReferences(targets: Array<{ kind: 'history' | 'study'; id: string }>) {
    const wanted = new Set(targets.map(target => `${target.kind}:${target.id}`)), found = new Map<string, Array<{ recipeId: string; recipeRevision: number; sourceRevision: number }>>();
    try { if (!(await fs.lstat(directory)).isDirectory()) return found; }
    catch (error: any) { if (error.code === 'ENOENT') return found; throw error; }
    await init();
    const names = new Set<string>();
    for (const name of (await fs.readdir(directory)).sort()) {
      const match = recordName.exec(name); if (!match) continue;
      names.add(name);
      let refs = referenceCache.get(name);
      if (!refs) {
        refs = [];
        const file = path.join(directory, name), info = await fs.lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) continue;
        const text = await fs.readFile(file, 'utf8');
        if (text.includes('"ref":')) {
          try {
            const value = JSON.parse(text);
            for (const asset of Array.isArray(value?.preparation?.assets) ? value.preparation.assets : []) if (asset?.ref && ['history', 'study'].includes(asset.ref.kind) && typeof asset.ref.id === 'string') refs.push({ kind: asset.ref.kind, id: asset.ref.id, revision: Number(asset.ref.revision) });
          } catch { continue; }
        }
        referenceCache.set(name, refs);
      }
      for (const ref of refs) {
        const key = `${ref.kind}:${ref.id}`; if (!wanted.has(key)) continue;
        const list = found.get(key) ?? []; list.push({ recipeId: match[1], recipeRevision: Number(match[2]), sourceRevision: ref.revision }); found.set(key, list);
      }
    }
    for (const name of referenceCache.keys()) if (!names.has(name)) referenceCache.delete(name);
    return found;
  }
  return { ...api, reclaimRecipes, sourceReferences, runRetention, retentionStatus, retentionStatusFresh, retentionPreview, repairPlan: async () => { const plan = await repairPlan(); return { ...plan, records: undefined }; }, repairCleanedRecords, restoreCleanedRecords, cleanedRecordFiles, libraryRestored, stopRetention, read_queue: async (raw: unknown) => withResultFiles(await api.control('read', raw)), pause_queue: (raw: unknown) => api.control('pause', raw), resume_queue: (raw: unknown) => api.control('resume', raw), cancel_queue: (raw: unknown) => api.control('cancel', raw) };
}
