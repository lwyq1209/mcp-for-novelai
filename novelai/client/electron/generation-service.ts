import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { NAI_MODELS, NAI_INPAINT_MODELS, normalizeGenerateParams, type GenerateResult, type HistoryItem } from '../src/types';
import { applyNAIEffort, naiEffortOf, naiRequestModel } from '../src/nai-effort';
import { GENERATION_MODES, isSeededGeneration } from "../src/workspace/generation-types";
import { QUEUE_UPSCALE_MODEL, resolvePostprocessRecipe } from "../src/workspace/generation-postprocess";
import type { GenerationJob, GenerationRequest, GenerationSnapshot, GenerationResult } from '../src/workspace/generation-types';
import { MANUAL_BATCH_MAX_ITEMS, QUEUED_BATCH_MAX_ITEMS } from '../src/workspace/batch-types';
import { httpParams, type GenerationExecutionOptions } from './ipc/nai';
import { validFileNamePrefix } from './queue-output';
import { webpDimensions } from './ipc/image-codec';
import { withReason } from './host-error';
import { upstreamReason } from './upstream-reason';

export type { GenerationJob, GenerationRequest, GenerationSnapshot, GenerationResult } from '../src/workspace/generation-types';
const MAX_IMAGE = 20 * 1024 * 1024;
/** A manual item's source (manual-generation MANUAL_SOURCE_MAX_BYTES). */
const MANUAL_SOURCE_BYTES = 128 * 1024 * 1024;
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'unknown']);
export class GenerationError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
function fail(code: string, message: string, reason?: string, params?: Record<string, string | number>): never { const error = new GenerationError(code, message); throw reason ? withReason(error, reason, params) : error; }
function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('invalid_arguments', 'Job arguments must be an object.');
  return value as Record<string, any>;
}
function identifier(value: unknown, name: string, max = 120): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) return fail('invalid_arguments', `${name} is invalid.`);
  return value;
}
function request(raw: unknown): GenerationRequest {
  const args = record(raw);
  const workspaceId = identifier(args.workspaceId, 'Workspace ID');
  const requestKey = identifier(args.requestKey, 'Request key');
  if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0 || !GENERATION_MODES.includes(args.mode)) return fail('invalid_arguments', 'Invalid revision or generation mode.');
  return { workspaceId, requestKey, expectedRevision: args.expectedRevision, mode: args.mode, ...(args.draftId === undefined ? {} : { draftId: identifier(args.draftId, 'Draft ID') }) };
}
function bytes(data: unknown): Buffer {
  if (typeof data !== 'string' || data.length > MAX_IMAGE * 1.4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return fail('invalid_image', 'The image encoding is invalid or larger than 20 MiB.', 'generation.image_encoding');
  const value = Buffer.from(data, 'base64');
  if (!value.length || value.length > MAX_IMAGE || value.toString('base64').replace(/=+$/, '') !== data.replace(/=+$/, '')) return fail('invalid_image', 'The image encoding is invalid or larger than 20 MiB.', 'generation.image_encoding');
  return value;
}
function mime(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  return fail('invalid_image', 'Only PNG, JPEG, WebP and GIF images are supported.', 'generation.image_type');
}
function sha(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex'); }
/** The durable queue item a child job runs for (batch service, queued batches only); saved as history queueOrigin. */
interface QueueOrigin { batchId: string; requestKey: string; itemIndex: number }
/** The item index of a queue origin stays below the item limit of its batch: a manual batch (the window's Generate)
 * holds up to MANUAL_BATCH_MAX_ITEMS images, a durable queued batch up to QUEUED_BATCH_MAX_ITEMS. */
function queueOrigin(raw: unknown, manual: boolean): QueueOrigin | undefined {
  const value = record(raw).queue;
  if (value === undefined) return undefined;
  const origin = record(value);
  const items = manual ? MANUAL_BATCH_MAX_ITEMS : QUEUED_BATCH_MAX_ITEMS;
  if (Object.keys(origin).some(key => !['batchId', 'requestKey', 'itemIndex'].includes(key)) || !Number.isSafeInteger(origin.itemIndex) || origin.itemIndex < 0 || origin.itemIndex >= items) return fail('invalid_arguments', 'Invalid queue origin.');
  return { batchId: identifier(origin.batchId, 'Batch ID'), requestKey: identifier(origin.requestKey, 'Queue request key'), itemIndex: origin.itemIndex };
}
interface Entry { public: GenerationJob; snapshot: GenerationSnapshot; sourceBytes?: Buffer; maskSummary?: { sha256: string; width: number; height: number }; controller: AbortController; items: HistoryItem[]; release: () => void; queue?: QueueOrigin; manual?: true; historySeedMode?: 'random' }
/** What a manual batch item settled as (main.ts tells the window, which shows a saved image on its canvas). */
export interface ManualItemOutcome { job: GenerationJob; queue: QueueOrigin; items: HistoryItem[] }
interface Dependencies {
  execute: (mode: GenerationRequest['mode'], snapshot: GenerationSnapshot, execution: GenerationExecutionOptions) => Promise<GenerateResult>;
  quote?: (mode: GenerationRequest['mode'], snapshot: GenerationSnapshot) => Promise<{ source: string; amount: number | null }>;
  validateImage: (bytes: Buffer, mimeType: string) => { width: number; height: number };
  reserve?: () => (() => void);
  isBusy?: () => boolean;
  onJob?: (job: GenerationJob) => void;
  readResult?: (item: HistoryItem) => Promise<Buffer>;
  /** Stream preview frames of a manual batch item (t2i), for the window that clicked Generate. */
  onPreview?: (job: GenerationJob, queue: QueueOrigin, preview: Parameters<NonNullable<GenerationExecutionOptions['onPreview']>>[0]) => void;
  /** A manual batch item ended (any status); its saved history items, if any. */
  onManualSettled?: (outcome: ManualItemOutcome) => void;
}

/** Drops the image bytes a job was frozen with (it ended; nothing reads them again). */
function releaseInputs(entry: Entry) {
  entry.sourceBytes = undefined;
  delete entry.snapshot.sourceImage;
  if (entry.snapshot.inpaint) entry.snapshot.inpaint.maskBase64 = '';
  entry.snapshot.extras = { ...entry.snapshot.extras, vibeImages: [], preciseReferences: [] };
}
/** Bytes of frozen image input (source, mask, references) a job still holds (diagnostics and tests; not a bridge method). */
function heldInputBytes(entry: Entry) {
  const text = (value: unknown) => typeof value === 'string' ? value.length : 0;
  const references = JSON.stringify([...(entry.snapshot.extras.vibeImages ?? []), ...(entry.snapshot.extras.preciseReferences ?? [])]).length - 2;
  return { source: (entry.sourceBytes?.length ?? 0) + text(entry.snapshot.sourceImage?.data), mask: text(entry.snapshot.inpaint?.maskBase64), references };
}

/** Process-owned jobs: never re-execute after a renderer reload or failed reply. */
export function createGenerationService(deps: Dependencies) {
  const entries = new Map<string, Entry>();
  const requests = new Map<string, string>();
  let activeId: string | null = null;
  const context = (raw: unknown) => identifier(record(raw).workspaceId, 'Workspace ID');
  const expose = (entry: Entry, workspaceId = entry.public.originWorkspaceId): GenerationJob => structuredClone({ ...entry.public, workspaceId });
  const emit = (entry: Entry) => { entry.public.updatedAt = new Date().toISOString(); try { deps.onJob?.(expose(entry)); } catch { /* A closing/reloading renderer must not affect a paid task. */ } };
  const lookup = (raw: unknown) => {
    const args = request(raw); const id = requests.get(JSON.stringify([args.workspaceId, args.requestKey]));
    if (!id) return null;
    const entry = entries.get(id)!;
    if (entry.public.mode !== args.mode || entry.public.expectedRevision !== args.expectedRevision || entry.public.draftId !== args.draftId) return fail('request_conflict', 'This requestKey was used for another revision, mode or draft; read the existing job.');
    return expose(entry, args.workspaceId);
  };
  const find = (raw: unknown) => {
    const args = record(raw); const workspaceId = context(args); const id = identifier(args.jobId, 'Job ID');
    const entry = entries.get(id); if (!entry) return fail('job_not_found', 'This client process has no such job.');
    return { args, workspaceId, entry };
  };
  const dimensions = (data: Buffer) => {
    // Electron nativeImage (main.ts validateImage) decodes PNG and JPEG only. A WebP source is sized from its header
    // here and decoded right before execution, where ipc/nai.ts hands nativeImage a PNG derivative (nativeImageInput);
    // a WebP that cannot be converted fails there, before any provider request.
    const type = mime(data);
    const size = type === 'image/webp' ? webpDimensions(data) ?? fail('invalid_image', 'The WebP header is invalid; its size cannot be read.', 'generation.webp_header') : deps.validateImage(data, type);
    if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width < 1 || size.height < 1 || size.width * size.height > 64 * 1024 * 1024) return fail('invalid_image', 'The image cannot be decoded or exceeds 64 megapixels.', 'generation.image_pixels');
    return size;
  };
  const run = async (entry: Entry) => {
    const job = entry.public;
    try {
      try { if (deps.quote) job.quote = await deps.quote(job.mode, structuredClone(entry.snapshot)); }
      catch { job.quote = { source: 'unavailable', amount: null }; }
      if (!Number.isFinite(job.quote.amount) || (job.quote.amount as number) < 0) job.quote.amount = null;
      if (entry.controller.signal.aborted) { job.status = 'cancelled'; return; }
      job.status = 'running'; job.startedAt = new Date().toISOString(); emit(entry);
      const queue = entry.queue;
      const manual = entry.manual && queue ? {
        manual: true as const,
        ...(job.mode === 't2i' ? { onPreview: (preview: Parameters<NonNullable<GenerationExecutionOptions['onPreview']>>[0]) => { try { deps.onPreview?.(expose(entry), { ...queue }, preview); } catch { /* A closing window never affects the request. */ } } } : {}),
        ...(typeof entry.snapshot.sourceName === 'string' ? { sourceName: entry.snapshot.sourceName } : {}),
        ...(entry.historySeedMode ? { historySeedMode: entry.historySeedMode } : {}),
        // The click's mode on its saved records (history feature), so the library can filter manual images by mode.
        generationMode: job.mode,
      } : {};
      const result = await deps.execute(job.mode, structuredClone(entry.snapshot), {
        ...manual,
        singleRequest: true, signal: entry.controller.signal, sourceBytes: entry.sourceBytes ? Buffer.from(entry.sourceBytes) : undefined,
        historyGroupId: entry.snapshot.extras.historyGroupId ?? '',
        ...(entry.snapshot.extras.fileNamePrefix ? { fileNamePrefix: entry.snapshot.extras.fileNamePrefix } : {}),
        provenance: { jobId: job.jobId, mode: job.mode, originWorkspaceId: job.originWorkspaceId, submittedRevision: job.submittedRevision, actualSeed: job.actualSeed },
        // Saved beside generationOrigin (history queueOrigin), never inside it: older renderers check its key set strictly.
        ...(entry.queue ? { queueOrigin: { ...entry.queue } } : {}),
        onSubmitted() { job.providerOutcome = 'unknown'; emit(entry); },
      });
      if (result.ok && result.items.length) {
        // A manual item is the saved record as it is (manual images carry no generation origin).
        entry.items = structuredClone(result.items).map(item => entry.manual ? item : ({ ...item, generationOrigin: {
          jobId: job.jobId, mode: job.mode, originWorkspaceId: job.originWorkspaceId, submittedRevision: job.submittedRevision,
          actualSeed: isSeededGeneration(job.mode) ? item.actualSeed : null,
        } }));
        job.results = entry.items.map((item, index) => ({ index, id: item.id, width: item.width, height: item.height, model: item.model, actualSeed: isSeededGeneration(job.mode) ? item.actualSeed : null }));
        job.actualSeed = isSeededGeneration(job.mode) ? result.actualSeed ?? entry.items[0].actualSeed : null;
        job.model = entry.items[0].model;
        job.providerOutcome = 'response_received'; job.status = 'succeeded'; job.error = null;
      } else {
        const submitted = job.providerOutcome !== 'not_submitted';
        const statusCode = result.statusCode;
        const rejected = typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500;
        const cancelled = entry.controller.signal.aborted || result.failureKind === 'cancelled';
        job.status = cancelled ? 'cancelled' : submitted && !rejected ? 'unknown' : 'failed';
        if (rejected) job.providerOutcome = 'response_received';
        // A refusal before any request names its own code and reason (for example history_params_invalid and the field).
        const refused = !cancelled && job.status === 'failed' && !submitted && typeof result.errorCode === 'string' && result.errorCode ? result.errorCode : null;
        job.error = { code: cancelled ? 'cancelled' : job.status === 'unknown' ? 'provider_unknown' : refused ?? (result.failureKind === 'auth' ? 'authentication_failed' : 'generation_failed'), message: cancelled ? 'The local request was cancelled; if it was already sent, this does not confirm that the server stopped or did not charge.' : job.status === 'unknown' ? 'The outcome after sending could not be confirmed; do not retry automatically, check the history first.' : refused ? result.message : `The generation request did not complete${statusCode ? ` (HTTP ${statusCode})` : ''}; check the account and the input.`, ...(statusCode ? { statusCode } : {}) };
        // A manual item keeps the request's own explanation (and its window reason), as the manual generation showed it.
        if (entry.manual && !cancelled && typeof result.message === 'string' && result.message.trim()) {
          job.error.message = result.message;
          if (typeof result.reason === 'string') job.error.reason = result.reason;
          if (result.params) job.error.params = { ...result.params };
        }
        if (!job.error.reason && job.error.code === 'generation_failed') { job.error.reason = 'generation.request_failed'; job.error.params = httpParams(statusCode); }
        // An agent image keeps what NovelAI answered, cleaned (upstream-reason.ts), for the window's queue page only:
        // the bridge drops it and MCP reads the item's code (step 4c1). A manual item's message already says it.
        if (!entry.manual && !cancelled) { const upstream = upstreamReason(result.upstream); if (upstream) job.error.upstream = upstream; }
      }
    } catch {
      const submitted = job.providerOutcome !== 'not_submitted';
      job.status = entry.controller.signal.aborted ? 'cancelled' : submitted ? 'unknown' : 'failed';
      job.error = { code: job.status === 'unknown' ? 'provider_unknown' : job.status === 'cancelled' ? 'cancelled' : 'generation_failed', message: submitted ? 'The request may have been sent; whether it ran and was saved is unknown. Check the history; do not retry automatically.' : 'The local preparation did not complete; there is no confirmed result.' };
    } finally {
      job.finishedAt = new Date().toISOString();
      // An ended job never runs again (a requestKey only ever names it): its large frozen inputs — the source and mask
      // bytes and the Vibe/Precise reference images — leave memory now; the record keeps what read() and the queue show.
      releaseInputs(entry);
      if (activeId === job.jobId) activeId = null;
      entry.release(); emit(entry);
      if (entry.manual && entry.queue) { try { deps.onManualSettled?.({ job: expose(entry), queue: { ...entry.queue }, items: structuredClone(entry.items) }); } catch { /* A closing window never affects a paid task. */ } }
    }
  };
  return {
    lookup,
    isBusy: () => activeId !== null,
    submit(raw: unknown) {
      const existing = lookup(raw); if (existing) return existing;
      const args = request(raw);
      const submittedRevision = record(raw).submittedRevision ?? args.expectedRevision;
      if (!Number.isSafeInteger(submittedRevision) || submittedRevision < args.expectedRevision || (args.draftId === undefined && submittedRevision !== args.expectedRevision)) return fail('invalid_arguments', 'Invalid adopted generation revision.');
      if (activeId || deps.isBusy?.()) return fail('workspace_busy', 'The client already runs a job; this call does not queue another.');
      // A manual batch item (batch-service, the window's Generate): its request keeps the manual generation's own
      // options (references, Furry, 4× upscale, i2i noise, inpaint sizing), which queued recipes refuse or pin.
      const manual = record(raw).manual === true;
      const queue = queueOrigin(raw, manual);
      if (manual && !queue) return fail('invalid_arguments', 'A manual batch item must belong to a queued batch.');
      const snapshot = structuredClone(record(record(raw).snapshot)) as GenerationSnapshot;
      record(snapshot.params); record(snapshot.extras);
      if (snapshot.extras.fileNamePrefix !== undefined && !validFileNamePrefix(snapshot.extras.fileNamePrefix)) return fail('invalid_arguments', 'The frozen file name prefix is invalid.');
      if (snapshot.recipeScope !== undefined) {
        if (snapshot.recipeScope !== 'independent_inpaint' || args.mode !== 'inpaint') return fail('invalid_arguments', 'An independent recipe scope applies to inpaint only.');
        if (typeof snapshot.inpaint?.model !== 'string' || snapshot.params.model !== snapshot.inpaint.model.replace(/-inpainting$/, '')) return fail('invalid_configuration', 'The independent recipe model must match the selected inpaint model.');
        // These describe unused workspace fields, not the effective params below.
        // Rebuild the list in the host rather than trusting renderer metadata.
        snapshot.unusedInputs = ['params', 'charCaptions', 'inpaintPositivePrompt'];
      }
      if (!NAI_MODELS.some(item => item.value === snapshot.params.model)) return fail('invalid_arguments', 'Invalid generation model.', 'generation.invalid_model');
      if (!manual && isSeededGeneration(args.mode) && ((snapshot.extras.vibeImages?.length ?? 0) || (snapshot.extras.preciseReferences?.length ?? 0))) return fail('unsupported_reference', 'Queued generation does not encode Precise/Vibe references or generate with them; the references and the model are kept.');
      if (!Array.isArray(snapshot.extras.charCaptions)) return fail('invalid_arguments', 'Invalid character prompt structure.', 'generation.characters');
      // Manual inpaint sends neither characters nor the Furry mode (it never did); the request below takes none.
      if (manual && args.mode === 'inpaint') snapshot.extras = { ...snapshot.extras, charCaptions: [] };
      if (args.mode === 'inpaint' && snapshot.extras.charCaptions.length) return fail('unsupported_configuration', 'Queued inpaint does not send character prompts yet; keep the setup and use another mode.');
      if (!manual && args.mode === 'inpaint' && snapshot.extras.modelMode === 'furry') return fail('unsupported_configuration', 'Queued inpaint does not send the Furry mode yet; keep the setup and use another mode.');
      snapshot.params = normalizeGenerateParams(snapshot.params);
      // V5 Full Effort: what runs (fixed Medium values, or no effort at all) on this mode's execution model; enhance
      // (also a manual Max✨ enhance, an i2i request with upscaledEnhance) always runs High.
      const effortModel = args.mode === 'inpaint' ? snapshot.inpaint?.model ?? '' : args.mode === 't2i' || (args.mode === 'i2i' && snapshot.i2i?.upscaledEnhance !== true) ? snapshot.params.model : '';
      snapshot.params = applyNAIEffort(snapshot.params, effortModel).params;
      const requestModel = naiRequestModel(effortModel || snapshot.params.model, naiEffortOf(snapshot.params, effortModel));
      if (!isSeededGeneration(args.mode)) snapshot.extras = { ...snapshot.extras, vibeImages: [], preciseReferences: [], charCaptions: [] };
      if (isSeededGeneration(args.mode) && !snapshot.params.positivePrompt.trim()) return fail('invalid_arguments', 'Enter a positive prompt.', 'generation.no_prompt');
      const actualSeed = !isSeededGeneration(args.mode) ? null : snapshot.params.seedMode === 'random' || snapshot.params.seed < 0 ? randomInt(1, 2_147_483_647) : snapshot.params.seed;
      if (actualSeed !== null) snapshot.params = { ...snapshot.params, seedMode: 'fixed', seed: actualSeed };
      let sourceBytes: Buffer | undefined; let source: GenerationJob['inputSummary']['source']; let maskSummary: Entry['maskSummary'];
      if (args.mode !== 't2i') {
        // A manual item brings the bytes captured at its click (larger than the queue's 20 MiB; a WebP already decoded).
        const captured = manual ? record(raw).manualSource : undefined;
        if (captured !== undefined) {
          const given = record(captured);
          if (!Buffer.isBuffer(given.bytes) || !given.bytes.length || given.bytes.length > MANUAL_SOURCE_BYTES) return fail('invalid_image', `The image must be a file of at most ${MANUAL_SOURCE_BYTES / 1024 / 1024} MiB.`, 'manual.source_too_large', { max: MANUAL_SOURCE_BYTES / 1024 / 1024 });
          sourceBytes = given.bytes;
        } else {
          if (!snapshot.sourceImage) return fail('invalid_image', 'This img2img or inpaint request has no frozen source image.', 'generation.no_source');
          sourceBytes = bytes(snapshot.sourceImage.data);
        }
        const size = dimensions(sourceBytes);
        source = { ...size, sha256: sha(sourceBytes) };
        snapshot.sourceSummary = { ...size, sourceMode: snapshot.sourceSummary?.sourceMode === 'latest' ? 'latest' : 'original' };
      }
      try { if (source) resolvePostprocessRecipe(snapshot, args.mode, source, { manual }); }
      catch (error: any) { return fail(error.code || 'invalid_configuration', error.message || 'Invalid post-processing parameters.', typeof error.reason === 'string' ? error.reason : undefined, error.params); }
      if (args.mode === 'i2i' && (!snapshot.i2i || !Number.isFinite(snapshot.i2i.strength) || snapshot.i2i.strength < 0 || snapshot.i2i.strength > 1)) return fail('invalid_arguments', 'Invalid img2img strength.', 'generation.i2i_strength');
      if (args.mode === 'i2i' || args.mode === 'enhance') snapshot.i2i = { ...snapshot.i2i!, noise: 0, extraNoiseSeed: snapshot.i2i!.extraNoiseSeed > 0 ? snapshot.i2i!.extraNoiseSeed : randomInt(1, 2_147_483_647) };
      if (args.mode === 'inpaint' && manual) {
        // The manual request sizes source and mask itself (inpaintImage: alignment and the adaptive size), as it always did.
        if (!snapshot.inpaint || !NAI_INPAINT_MODELS.some(item => item.value === snapshot.inpaint!.model) || !Number.isFinite(snapshot.inpaint.strength) || snapshot.inpaint.strength < 0 || snapshot.inpaint.strength > 1) return fail('invalid_arguments', 'Invalid inpaint model or strength.', 'generation.inpaint_settings');
        const maskBytes = bytes(snapshot.inpaint.maskBase64); maskSummary = { ...dimensions(maskBytes), sha256: sha(maskBytes) };
        snapshot.inpaint.noise = 0;
      } else if (args.mode === 'inpaint') {
        if (!snapshot.inpaint || !NAI_INPAINT_MODELS.some(item => item.value === snapshot.inpaint!.model) || !Number.isFinite(snapshot.inpaint.strength) || snapshot.inpaint.strength < 0 || snapshot.inpaint.strength > 1) return fail('invalid_arguments', 'Invalid inpaint model or strength.', 'generation.inpaint_settings');
        const maskBytes = bytes(snapshot.inpaint.maskBase64); const size = dimensions(maskBytes);
        if (size.width !== source!.width || size.height !== source!.height) return fail('invalid_image', 'The mask and the frozen source differ in size.');
        maskSummary = { ...size, sha256: sha(maskBytes) };
        // Match prepareInpaintAssets: use source dimensions, aligned upward to
        // the model grid, rather than unrelated t2i dimensions left in the UI.
        snapshot.params.width = Math.ceil(source!.width / 64) * 64;
        snapshot.params.height = Math.ceil(source!.height / 64) * 64;
        if (snapshot.params.width > 1600 || snapshot.params.height > 1600) return fail('invalid_image', 'The inpaint source exceeds 1600×1600 after alignment.');
        snapshot.inpaint.noise = 0;
      }
      const release = deps.reserve?.() ?? (() => {});
      const now = new Date().toISOString(); const jobId = randomUUID();
      // A manual click with a random seed: the request runs with the drawn seed, its record keeps seedMode random.
      const historySeedMode = manual && isSeededGeneration(args.mode) && record(raw).historySeedMode === 'random' ? 'random' as const : undefined;
      const entry: Entry = { snapshot, sourceBytes, maskSummary, controller: new AbortController(), items: [], release, ...(queue ? { queue } : {}), ...(manual ? { manual: true as const } : {}), ...(historySeedMode ? { historySeedMode } : {}), public: {
        jobId, workspaceId: args.workspaceId, originWorkspaceId: args.workspaceId, submittedRevision, expectedRevision: args.expectedRevision, requestKey: args.requestKey, mode: args.mode, ...(args.draftId === undefined ? {} : { draftId: args.draftId }),
        status: 'preparing', createdAt: now, updatedAt: now, startedAt: null, finishedAt: null, model: args.mode === 'upscale' ? QUEUE_UPSCALE_MODEL : args.mode === 'director' ? `director-${snapshot.director!.tool}` : requestModel,
        actualSeed, providerRequestId: null, inputSummary: { sampleCount: 1, width: snapshot.processing?.outputWidth ?? snapshot.params.width, height: snapshot.processing?.outputHeight ?? snapshot.params.height, steps: snapshot.params.steps, sampler: snapshot.params.sampler, cfgScale: snapshot.params.cfgScale, characterCount: snapshot.extras.charCaptions.length, ...(source ? { source } : {}), ...(snapshot.batchCount && snapshot.batchCount > 1 ? { ignoredBatchCount: snapshot.batchCount } : {}) },
        quote: { source: 'unavailable', amount: null }, error: null, results: [], cancelRequested: false, providerOutcome: 'not_submitted',
      } };
      entries.set(jobId, entry); requests.set(JSON.stringify([args.workspaceId, args.requestKey]), jobId); activeId = jobId; emit(entry);
      queueMicrotask(() => { void run(entry); });
      return expose(entry);
    },
    /** Bytes of frozen image input this job still holds: zero for every part once it ended. */
    heldInputs(raw: unknown) { return heldInputBytes(find(raw).entry); },
    list(raw: unknown) { const workspaceId = context(raw); return { workspaceId, jobs: [...entries.values()].map(entry => expose(entry, workspaceId)).reverse() }; },
    read(raw: unknown) {
      const { workspaceId, entry } = find(raw); const snapshot = entry.snapshot;
      return { ...expose(entry, workspaceId), input: structuredClone({ params: snapshot.params, extras: { charCaptions: snapshot.extras.charCaptions, ...(snapshot.extras.modelMode ? { modelMode: snapshot.extras.modelMode } : {}) }, ...(snapshot.recipeScope ? { recipeScope: snapshot.recipeScope } : {}), ...(snapshot.enhance ? { enhance: snapshot.enhance } : {}), ...(snapshot.upscale ? { upscale: snapshot.upscale } : {}), ...(snapshot.director ? { director: snapshot.director } : {}), ...(snapshot.processing ? { processing: snapshot.processing } : {}), ...(snapshot.unusedInputs ? { unusedInputs: snapshot.unusedInputs } : {}), ...(snapshot.i2i ? { i2i: snapshot.i2i } : {}), ...(snapshot.inpaint ? { inpaint: { model: snapshot.inpaint.model, strength: snapshot.inpaint.strength, noise: snapshot.inpaint.noise, mask: entry.maskSummary! } } : {}) }) };
    },
    cancel(raw: unknown) {
      const { workspaceId, entry } = find(raw);
      if (!terminal.has(entry.public.status)) { entry.public.cancelRequested = true; entry.public.status = 'cancelling'; entry.controller.abort(); emit(entry); }
      return expose(entry, workspaceId);
    },
    async result(raw: unknown): Promise<GenerationResult> {
      const { args, workspaceId, entry } = find(raw); const index = args.index ?? 0;
      if (!Number.isSafeInteger(index) || index < 0) return fail('invalid_arguments', 'Invalid result index.');
      const item = entry.items[index]; if (!item) return fail('result_not_ready', 'This job has no such saved result yet.');
      let data: Buffer;
      if (deps.readResult) data = await deps.readResult(structuredClone(item));
      else {
        const file = await fs.open(item.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { const stat = await file.stat(); if (!stat.isFile() || stat.size > MAX_IMAGE) return fail('invalid_image', 'The job result is invalid or larger than 20 MiB.'); data = await file.readFile(); }
        finally { await file.close(); }
      }
      if (data.length > MAX_IMAGE) return fail('invalid_image', 'The job result is larger than 20 MiB.');
      const size = dimensions(data);
      return { jobId: entry.public.jobId, workspaceId, index, mimeType: mime(data), data: data.toString('base64'), ...size, model: item.model, actualSeed: isSeededGeneration(entry.public.mode) ? item.actualSeed : null, historyItem: structuredClone(item), originWorkspaceId: entry.public.originWorkspaceId, submittedRevision: entry.public.submittedRevision, historyId: item.id, createdAt: item.createdAt, providerRequestId: null };
    },
  };
}
