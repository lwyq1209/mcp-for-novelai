import fs from 'node:fs/promises';
import path from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { DIRECTOR_TOOLS, NAI_INPAINT_MODELS, seedForBatch, type AugmentOptions, type GenerateExtras, type GenerateParams, type I2IParams } from '../src/types';
import type { ManualEnqueueReply, ManualGenerationRequest, ManualMode } from '../src/workspace/manual-batches';
import { expandWildcards } from '../src/wildcards';
import type { BatchJob } from '../src/workspace/batch-types';
import type { GenerationSnapshot } from '../src/workspace/generation-types';
import { MANUAL_BATCH_LIMITS } from './batch-service';
import { QUEUE_WORKSPACE } from './queue-recipe-service';
import { processableImage } from './ipc/image-codec';
import { hostError } from './host-error';

/**
 * Manual generation in the shared queue (step 4a, user decision 2). A Generate click of this window freezes what the
 * window's manual generation sent — parameters, extras with their reference images, the i2i/inpaint/upscale/Director
 * settings and the current workbench image — into one manual batch of the shared FIFO (batch-service enqueueManual).
 * It starts at once when the queue is idle and waits behind the batches already there otherwise; every image is a
 * child job of the generation service, run with the manual generation's own options (nai.ts execution.manual).
 *
 * One click is one requestKey: an enqueue that was not answered is looked up with the same key (lookup), never
 * resent under another. Manual batches live only while the app runs.
 */
export const MANUAL_MODES: readonly ManualMode[] = ['t2i', 'i2i', 'inpaint', 'upscale', 'director'];
export type { ManualGenerationRequest, ManualMode } from '../src/workspace/manual-batches';
export type ManualEnqueueResult = ManualEnqueueReply;
/** The image of a click (i2i, inpaint, upscale, Director): its bytes as the request uses them, read when the click
 * is made, before the balance refresh and the quote, so a source changed meanwhile (by the user or an agent) does not
 * replace it. */
export interface ManualSource { bytes: Buffer; mimeType: string; name: string }
/** A source file a click may freeze: at most 128 MiB (the window's manual generation read any size; the queue limit of
 * 20 MiB for agent recipes does not apply), and at most 64 megapixels (generation-service). */
export const MANUAL_SOURCE_MAX_BYTES = 128 * 1024 * 1024;
const MIB = 1024 * 1024;
const sniff = (bytes: Buffer) => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png' : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
  : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) ? 'image/gif' : '';

/** Reads the file of a click's image as the window's manual generation read its workbench image (nai.ts
 * readWorkbenchImage): a WebP becomes its first frame, turned by its EXIF orientation, as PNG. */
export async function readManualSourceFile(filePath: unknown): Promise<ManualSource> {
  if (typeof filePath !== 'string' || !filePath || filePath.length > 4096 || /[\x00-\x1f]/.test(filePath) || !path.isAbsolute(filePath)) throw hostError('invalid_arguments', 'The image of this click has no valid file path.', 'manual.source_path');
  let size: number;
  try { const info = await fs.stat(filePath); if (!info.isFile()) throw new Error('not a file'); size = info.size; }
  catch { throw hostError('source_missing', 'The image file of this click cannot be read; load it again.', 'manual.source_unreadable'); }
  if (size > MANUAL_SOURCE_MAX_BYTES) throw hostError('invalid_image', `The image must be a file of at most ${MANUAL_SOURCE_MAX_BYTES / MIB} MiB.`, 'manual.source_too_large', { max: MANUAL_SOURCE_MAX_BYTES / MIB });
  let original: Buffer;
  try { original = await fs.readFile(filePath); } catch { throw hostError('source_missing', 'The image file of this click cannot be read; load it again.', 'manual.source_unreadable'); }
  const mimeType = sniff(original), name = path.basename(filePath);
  if (!mimeType) throw hostError('invalid_image', 'Only PNG, JPEG, WebP and GIF images can be used.', 'manual.source_type');
  if (mimeType !== 'image/webp') return { bytes: original, mimeType, name };
  try { return { bytes: await processableImage(original), mimeType: 'image/png', name }; }
  catch { throw hostError('invalid_image', 'The WebP image could not be decoded (at most 32 MB and 64 megapixels).', 'manual.source_webp'); }
}

/**
 * The sources of clicks between the click and its enqueue (main process memory only): capture reads the file at the
 * click, take hands it to that click's enqueue once. At most `max` are held (the oldest goes first) and each for
 * `ttlMs`, so an abandoned click (no token, a failed balance refresh) does not keep its image.
 */
export function createManualSourceStore(options: { read?: (filePath: unknown) => Promise<ManualSource>; ttlMs?: number; max?: number } = {}) {
  const read = options.read ?? readManualSourceFile, ttlMs = options.ttlMs ?? 5 * 60 * 1000, max = options.max ?? 2;
  const held = new Map<string, { source: ManualSource; timer: ReturnType<typeof setTimeout> }>();
  const drop = (id: string) => { const entry = held.get(id); if (entry) { clearTimeout(entry.timer); held.delete(id); } };
  return {
    async capture(filePath: unknown): Promise<{ sourceId: string }> {
      const source = await read(filePath);
      while (held.size >= max) drop(held.keys().next().value!);
      const sourceId = randomUUID(), timer = setTimeout(() => held.delete(sourceId), ttlMs);
      timer.unref?.();
      held.set(sourceId, { source, timer });
      return { sourceId };
    },
    take(sourceId: string): ManualSource | null { const entry = held.get(sourceId); if (!entry) return null; drop(sourceId); return entry.source; },
    /** Sources held now (tests). */
    size: () => held.size,
    clear() { for (const id of [...held.keys()]) drop(id); },
  };
}
export type ManualSourceStore = ReturnType<typeof createManualSourceStore>;

export interface ManualGenerationDependencies {
  batch: {
    enqueueManual(raw: unknown, options: { prepare?: (snapshot: GenerationSnapshot, index: number) => GenerationSnapshot; source?: { bytes: Buffer; mimeType: string } }): Promise<BatchJob>;
    lookupManual(workspaceId: string, requestKey: string): BatchJob | null;
    itemsAhead(batchId?: string): number;
  };
  /** The images captured at their clicks (sourceId of the request). */
  sources: Pick<ManualSourceStore, 'take'>;
  /** Tests: the random seed of an image whose seed mode is random. */
  randomSeed?: () => number;
}

const fail = (code: string, message: string, reason?: string, params?: Record<string, string | number>): never => { throw hostError(code, message, reason, params); };
const SOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const object = (value: unknown, name: string): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : fail('invalid_arguments', `${name} must be an object.`, 'manual.request_shape', { name });
const REQUEST_KEY = /^manual-[A-Za-z0-9-]{8,100}$/;
const seeded = (mode: ManualMode) => mode !== 'upscale' && mode !== 'director';

/** The checked request of one click. */
export function parseManualRequest(raw: unknown): ManualGenerationRequest {
  const value = object(raw, 'The manual generation request');
  if (typeof value.requestKey !== 'string' || !REQUEST_KEY.test(value.requestKey)) fail('invalid_arguments', 'A manual generation needs its own requestKey (manual-…).', 'manual.request_key');
  if (!MANUAL_MODES.includes(value.mode)) fail('invalid_arguments', 'Unknown manual generation mode.', 'manual.mode');
  const mode = value.mode as ManualMode, single = !seeded(mode);
  if (!Number.isSafeInteger(value.count) || value.count < 1 || value.count > (single ? 1 : MANUAL_BATCH_LIMITS.items)) fail('invalid_arguments', single ? 'Upscale and Director make one image per click.' : `A manual batch has 1–${MANUAL_BATCH_LIMITS.items} images.`, single ? 'manual.count_single' : 'manual.count', { max: MANUAL_BATCH_LIMITS.items });
  if (typeof value.intervalSeconds !== 'number' || !Number.isFinite(value.intervalSeconds) || value.intervalSeconds < 0 || value.intervalSeconds > MANUAL_BATCH_LIMITS.intervalSeconds) fail('invalid_arguments', `The pause between images is 0–${MANUAL_BATCH_LIMITS.intervalSeconds} seconds.`, 'manual.interval', { max: MANUAL_BATCH_LIMITS.intervalSeconds });
  const params = object(value.params, 'params') as GenerateParams, extras = object(value.extras, 'extras') as GenerateExtras;
  if (!Array.isArray(extras.charCaptions) || !Array.isArray(extras.vibeImages)) fail('invalid_arguments', 'extras need charCaptions and vibeImages.', 'manual.extras');
  const request: ManualGenerationRequest = { requestKey: value.requestKey, mode, count: value.count, intervalSeconds: value.intervalSeconds, params, extras };
  // Image modes name the source captured at the click (novelai:manual:capture-source).
  if (mode !== 't2i') {
    if (value.sourceId === undefined) fail('source_missing', 'Load an image first.');
    if (typeof value.sourceId !== 'string' || !SOURCE_ID.test(value.sourceId)) fail('invalid_arguments', 'The source of this click is invalid.', 'manual.source_id');
    request.sourceId = value.sourceId;
  }
  if (mode === 'i2i') request.i2i = object(value.i2i, 'i2i') as I2IParams;
  if (mode === 'inpaint') {
    const inpaint = object(value.inpaint, 'inpaint');
    if (!NAI_INPAINT_MODELS.some(model => model.value === inpaint.model) || typeof inpaint.maskBase64 !== 'string' || !inpaint.maskBase64 || typeof inpaint.strength !== 'number') fail('invalid_arguments', 'Inpaint needs a model, a strength and a mask.', 'manual.inpaint_settings');
    request.inpaint = { model: inpaint.model, strength: inpaint.strength, maskBase64: inpaint.maskBase64 };
  }
  if (mode === 'upscale') {
    const upscale = object(value.upscale, 'upscale');
    if (upscale.scale !== 2 && upscale.scale !== 4) fail('invalid_arguments', 'Upscale is 2× or 4×.', 'manual.upscale_scale');
    request.upscale = { scale: upscale.scale };
  }
  if (mode === 'director') {
    const director = object(value.director, 'director');
    if (!DIRECTOR_TOOLS.some(tool => tool.value === director.tool)) fail('invalid_arguments', 'Unknown Director tool.', 'manual.director_tool');
    request.director = { tool: director.tool, options: object(director.options, 'director options') as AugmentOptions };
  }
  return request;
}

/** Seeds exactly as the window's manual generation chose them: a fixed seed counts up per image, a random one is drawn per image. */
export function manualSeeds(request: Pick<ManualGenerationRequest, 'mode' | 'count' | 'params'>, randomSeed: () => number = () => randomInt(1, 2_147_483_647)) {
  if (!seeded(request.mode)) return Array.from({ length: request.count }, () => 0);
  const fixed = request.params.seedMode !== 'random' && Number.isFinite(request.params.seed) && request.params.seed >= 0;
  return Array.from({ length: request.count }, (_, index) => fixed ? seedForBatch(request.params.seed, index) : randomSeed());
}

export function createManualGeneration(deps: ManualGenerationDependencies) {
  return {
    async enqueue(raw: unknown): Promise<ManualEnqueueResult> {
      const request = parseManualRequest(raw);
      // The same click again (an unanswered IPC reply): its batch, with nothing taken or frozen again.
      const known = deps.batch.lookupManual(QUEUE_WORKSPACE, request.requestKey);
      if (known) return { batch: known, ahead: deps.batch.itemsAhead(known.batchId) };
      const snapshot: GenerationSnapshot = { params: structuredClone(request.params), extras: { ...structuredClone(request.extras), historyGroupId: typeof request.extras.historyGroupId === 'string' ? request.extras.historyGroupId : '' } };
      // The image captured at the click (its bytes stay beside the snapshot, not inside it).
      let source: ManualSource | null = null;
      if (request.mode !== 't2i') {
        source = deps.sources.take(request.sourceId!);
        if (!source) fail('source_missing', 'The image of this click is no longer held (it waited too long or a later click replaced it); click again.', 'manual.source_expired');
        snapshot.sourceName = source!.name;
      }
      if (request.i2i) snapshot.i2i = structuredClone(request.i2i);
      if (request.inpaint) snapshot.inpaint = { ...request.inpaint, noise: 0 };
      if (request.upscale) snapshot.upscale = { ...request.upscale };
      if (request.director) snapshot.director = structuredClone(request.director);
      // {a|b} wildcards pick anew for every image (t2i and i2i), unless the prompt text is kept literally.
      const prepare = (request.mode === 't2i' || request.mode === 'i2i') && !request.params.preservePromptText
        ? (item: GenerationSnapshot) => ({ ...item, params: { ...item.params, positivePrompt: expandWildcards(item.params.positivePrompt), negativePrompt: expandWildcards(item.params.negativePrompt) } })
        : undefined;
      const batch = await deps.batch.enqueueManual({ workspaceId: QUEUE_WORKSPACE, expectedRevision: 0, requestKey: request.requestKey, execution: 'queued', mode: request.mode,
        count: request.count, intervalSeconds: request.intervalSeconds, seeds: manualSeeds(request, deps.randomSeed), snapshot }, { ...(prepare ? { prepare } : {}), ...(source ? { source: { bytes: source.bytes, mimeType: source.mimeType } } : {}) });
      return { batch, ahead: deps.batch.itemsAhead(batch.batchId) };
    },
    /** The batch of this click, or null: nothing was queued under this requestKey in this run of the app. */
    lookup(raw: unknown): ManualEnqueueResult | { batch: null; ahead: number } {
      const value = object(raw, 'The manual lookup');
      if (typeof value.requestKey !== 'string' || !REQUEST_KEY.test(value.requestKey)) fail('invalid_arguments', 'A manual generation needs its own requestKey (manual-…).', 'manual.request_key');
      const batch = deps.batch.lookupManual(QUEUE_WORKSPACE, value.requestKey);
      return batch ? { batch, ahead: deps.batch.itemsAhead(batch.batchId) } : { batch: null, ahead: deps.batch.itemsAhead() };
    },
  };
}
export type ManualGeneration = ReturnType<typeof createManualGeneration>;
