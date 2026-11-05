/**
 * Runtime-neutral inspection and control of the shared independent host queue.
 *
 * Behavioural twin of the former `novelai_queue` tool of the removed native agent
 * extension, kept as a dependency-free module so any runtime can reuse it. It deliberately imports
 * nothing from the enqueue/recipe path: each action maps to exactly one fixed
 * host method, and there is no enqueue, recipe read/write or lookup here.
 */
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const KEYS = new Set(['action', 'batchId', 'itemIndex', 'index']);

export const QUEUE_HOST_METHODS = Object.freeze({
  list: 'list_queue', read: 'read_queue', pause: 'pause_queue', resume: 'resume_queue', cancel: 'cancel_queue', result: 'get_queue_result',
});
export const QUEUE_ACTIONS = Object.freeze(Object.keys(QUEUE_HOST_METHODS));
export const QUEUE_LIST_LIMIT = 8;
/**
 * Hard upper bound of images in one enqueue (so item indexes are 0–199). The host refuses anything above its own
 * setting "single enqueue at most" (default 20, 1–200) with enqueue_limit_exceeded, naming that limit.
 */
export const MAX_QUEUE_ITEMS = 200;

export class QueueControlError extends Error {
  constructor(code, message) { super(message); this.name = 'QueueControlError'; this.code = code; }
}
const invalidArguments = message => { throw new QueueControlError('invalid_arguments', message); };
const invalidResponse = message => { throw new QueueControlError('invalid_response', message); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const OUTPUT_FIELDS = ['historyGroup', 'historyGroupId', 'historyGroupName', 'fileNamePrefix'];
/** The enqueue's requested and resolved output (issue #1), string fields only; omitted when the batch has none. */
function compactOutput(output) {
  if (!record(output)) return {};
  const fields = OUTPUT_FIELDS.filter(key => typeof output[key] === 'string').map(key => [key, output[key]]);
  return fields.length ? { output: Object.fromEntries(fields) } : {};
}
const INVISIBLE_FORMAT_CHARACTERS = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g;
/** A client name or version as plain text: invisible format characters (bidirectional controls, zero-width) removed. */
const sourceText = (value, max) => {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f-\x9f]/.test(value)) return null;
  const text = value.replace(INVISIBLE_FORMAT_CHARACTERS, '').trim();
  return text && text.length <= max ? text : null;
};
/**
 * Who put the batch in (host 2026-11, step 4a): {kind:'agent', client:{name, version}|null} for an MCP enqueue (the
 * client's initialize clientInfo), {kind:'manual', persistent:false} for a Generate click in the app (kept only while
 * the app runs). A batch the host stores without one predates the field and was an agent batch.
 */
export function batchSource(source) {
  if (record(source) && source.kind === 'manual') return { kind: 'manual', persistent: false };
  const client = record(source) && source.kind === 'agent' && record(source.client) ? source.client : null;
  const name = client ? sourceText(client.name, 100) : null;
  return { kind: 'agent', client: name ? { name, version: sourceText(client.version, 50) } : null };
}
/**
 * Why a batch is paused, blocked or holding (step 4b2; stopReason in outputs): the host's code for it, with this server's own English
 * explanation for the codes the host queue sets (electron/batch-service.ts). The host's message is never passed on
 * (as with item errors): an unknown code is reported by its code only.
 */
export const BATCH_REASONS = Object.freeze({
  queue_halted: 'An earlier agent batch failed or has an unknown result, so this batch was paused before sending anything more. It keeps its original frozen recipes; resume it only when the user asks.',
  child_stopped: 'Some images of this batch did not succeed, so it stopped and submits nothing more. Failed or unknown images are never resent.',
  child_rejected: 'An image was refused before any request was sent; the remaining images of this batch did not run.',
  submission_unconfirmed: 'Whether an image was submitted could not be confirmed (it may have been generated and charged), so the batch stopped without resending it. Check the history before enqueuing again.',
  restart_unconfirmed: 'The app closed while an image was running; its outcome is unknown and it is not resent. This batch cannot be resumed.',
  restart_blocked: 'An image of this batch did not succeed before the app closed; the images not yet submitted do not continue.',
  recovered_paused: 'The app restarted; the images not yet submitted wait, paused, for an explicit resume.',
  child_lookup_failed: 'Whether the next image was already submitted could not be confirmed, so it was not submitted and the batch paused.',
  child_status_unavailable: 'The running image cannot be read right now; the batch holds and submits nothing more.',
  cancel_unconfirmed: 'The cancellation could not be confirmed; the running image is awaited and no further image starts.',
  queue_storage_error: 'The frozen queue cannot be read or written safely: agent batches are paused and new enqueues are refused until it is fixed.',
  scheduler_stopped: 'The queue scheduler hit an error and stopped this batch; nothing more is submitted for it. Check the images already created before enqueuing again.',
  scheduler_closed: 'The app was closing, so this batch stopped before its remaining images; they did not run and are not resent.',
});
const REASON_CODE = /^[a-z][a-z0-9_]{0,79}$/;
/**
 * The batch's stop reason as {code, message?}, or null when it has none (a well-formed host code only). Named
 * stopReason in outputs, apart from the window-only error reason that never crosses the bridge (step 4a).
 */
export function batchReason(error) {
  const code = record(error) && typeof error.code === 'string' && REASON_CODE.test(error.code) ? error.code : null;
  if (!code) return null;
  return Object.hasOwn(BATCH_REASONS, code) ? { code, message: BATCH_REASONS[code] } : { code };
}
const itemCount = (batch, status) => (Array.isArray(batch.items) ? batch.items : []).filter(item => item?.status === status).length;

const CLEANED_COUNTS = ['succeeded', 'failed', 'unknown', 'cancelled', 'skipped'];
const isoTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
/**
 * A batch the host's queue retention cleaned (2026-11): it ended long ago, so its frozen recipes, receipt and per-image
 * records are gone; the host keeps how it ended, its per-status image counts and when it was cleaned. Its requestKey
 * stays accepted and is never queued again.
 */
export function compactCleanedBatch(batch) {
  const counts = record(batch.itemCounts) ? Object.fromEntries(CLEANED_COUNTS.map(key => [key, Number.isSafeInteger(batch.itemCounts[key]) && batch.itemCounts[key] >= 0 ? batch.itemCounts[key] : 0])) : null;
  return { batchId: batch.batchId, ...(typeof batch.requestKey === 'string' ? { requestKey: batch.requestKey } : {}), execution: batch.execution, status: batch.status, stopReason: batchReason(batch.error), count: batch.count ?? null,
    ...(typeof batch.recipePlanHash === 'string' ? { recipePlanHash: batch.recipePlanHash } : {}), intervalSeconds: batch.intervalSeconds ?? null, activeJobId: null, ...compactOutput(batch.output),
    cleaned: true, ...(batch.recovered === true ? { recovered: true, savedImages: Number.isSafeInteger(batch.savedImages) ? batch.savedImages : null } : {}),
    cleanedAt: isoTime(batch.cleanedAt), finishedAt: isoTime(batch.finishedAt), itemCounts: counts };
}
/** What an agent does with a cleaned batch (lookup_enqueue, a repeated enqueue_recipes, read_queue). */
export const cleanedBatchInstruction = batch => batch.recovered === true
  ? `This requestKey was accepted. Its queue record was lost and rebuilt from the library${typeof batch.cleanedAt === 'string' ? ` on ${batch.cleanedAt}` : ''} (${Number.isSafeInteger(batch.savedImages) ? batch.savedImages : 'some'} saved images); how the batch ended and its plan are unknown. It is never queued or sent again: never enqueue this intent again. Its saved images are in the library: asset_library {action:"list", category:"history", queueRequestKey: this requestKey} (or queueBatchId) lists them.`
  : `This requestKey was accepted. Its batch ended (${batch.status}) and its queue record was cleaned${typeof batch.cleanedAt === 'string' ? ` on ${batch.cleanedAt}` : ''} under the client's queue retention; only how it ended and its per-status image counts are kept. It is never queued or sent again: never enqueue this intent again. Its saved images stay in the library: asset_library {action:"list", category:"history", queueRequestKey: this requestKey} (or queueBatchId) lists them.`;
/** read_queue: what to do about images whose outcome is unknown (review rework P2-2). */
const unknownInstruction = batch => {
  const unknown = (Array.isArray(batch.items) ? batch.items : []).filter(item => item?.status === 'unknown').map(item => item.index);
  return unknown.length ? { instruction: `Item${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} ha${unknown.length > 1 ? 've' : 's'} an unknown outcome: ${unknown.length > 1 ? 'they' : 'it'} may have been generated and charged, and ${unknown.length > 1 ? 'are' : 'is'} never resent. First check asset_library {action:"list", category:"history", queueBatchId:"${batch.batchId}"}; only if the images are not there, decide with the user whether to make them again (that is a new paid request under a new requestKey).` } : {};
};

/** The compact projection of a queued batch that read_queue and control_queue (pause, resume, cancel) return. */
export function compactQueuedBatch(batch) {
  if (batch?.cleaned === true) return compactCleanedBatch(batch);
  return { batchId: batch.batchId, requestKey: batch.requestKey, execution: batch.execution, source: batchSource(batch.source), status: batch.status, stopReason: batchReason(batch.error), count: batch.count,
    recipePlanHash: batch.recipePlanHash, intervalSeconds: batch.intervalSeconds, activeJobId: batch.activeJobId ?? null, ...compactOutput(batch.output),
    items: (batch.items ?? []).map(item => ({ index: item.index, status: item.status, jobId: item.jobId ?? null, resultCount: item.results?.length ?? 0, error: item.error?.code ?? null })) };
}

/**
 * The saved file of a result as the host reports it: its base name, and `file` = projectPath(host path), the
 * project-relative path or null. The absolute host path itself never leaves this module; without a projectPath
 * function `file` is null.
 */
const fileOf = (filePath, projectPath) => {
  if (typeof filePath !== 'string' || !filePath || filePath.length > 4096 || /[\x00-\x1f]/.test(filePath)) return {};
  const fileName = filePath.split(/[\\/]/).pop();
  if (!fileName) return {};
  const file = typeof projectPath === 'function' ? projectPath(filePath) : null;
  return { fileName, file: typeof file === 'string' && file ? file : null };
};

const historyIdentity = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && /\S/.test(value);
/** The seed an image was generated with as the host reports it; null for upscale/director, an unknown or an invalid value. */
const actualSeedOf = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
/**
 * read only: the saved images of each item by history identity ({itemIndex, index, historyId, actualSeed}), so a later
 * recipe can use them as its source; plus the host's compaction marker of an ended batch. Like
 * get_queue_result, a result whose identity is unusable degrades to null (with a warning) instead of
 * failing the whole read; nothing of the invalid value is echoed.
 */
function readExtras(batch, projectPath) {
  const results = [], warnings = [];
  for (const [position, item] of (Array.isArray(batch.items) ? batch.items : []).entries()) {
    for (const result of Array.isArray(item?.results) ? item.results : []) {
      const entry = { itemIndex: Number.isSafeInteger(item.index) ? item.index : position, index: Number.isSafeInteger(result?.index) && result.index >= 0 ? result.index : null, historyId: historyIdentity(result?.id) ? result.id : null, actualSeed: actualSeedOf(result?.actualSeed) };
      // A host from 2026-10-14 on names the saved file of each result; an older host does not.
      if (entry.historyId !== null) Object.assign(entry, fileOf(result?.filePath, projectPath));
      results.push(entry);
      if (entry.historyId === null || entry.index === null) warnings.push({ code: 'result_identity_unavailable', itemIndex: entry.itemIndex, index: entry.index,
        message: `Item ${entry.itemIndex} has a saved result without a usable history identity; it cannot be used as a recipe source. Find it in asset_library (history) instead.` });
    }
  }
  return { results, ...(results.some(entry => typeof entry.file === 'string') ? { pathBase: 'project-root' } : {}), ...(warnings.length ? { warnings } : {}), ...(batch.inputCompacted === true ? { inputCompacted: true, compactedAt: typeof batch.compactedAt === 'string' ? batch.compactedAt : null } : {}) };
}

const STORAGE_FIELDS = { frozenQueue: ['batches', 'batchLimit', 'bytes', 'byteLimit'], recipeStore: ['records', 'recordLimit', 'bytes', 'byteLimit'] };
/**
 * Host storage usage (design-addendum §2.7), when the host reports it: each store is its four counters or null
 * (numbers unavailable). An older host without the field yields undefined, so list_queue simply omits it.
 */
function storageUsage(storage) {
  if (storage === undefined || storage === null) return undefined;
  if (!record(storage)) invalidResponse('The host returned invalid queue storage usage.');
  return Object.fromEntries(Object.entries(STORAGE_FIELDS).map(([name, fields]) => {
    const value = storage[name];
    if (value === undefined || value === null) return [name, null];
    if (!record(value) || fields.some(field => !Number.isSafeInteger(value[field]) || value[field] < 0)) invalidResponse('The host returned invalid queue storage usage.');
    return [name, Object.fromEntries(fields.map(field => [field, value[field]]))];
  }));
}

/**
 * Returns `{ value }`, plus `image: { mimeType, data }` for `result`.
 * Argument errors are raised before any host call; host mismatches are
 * `invalid_response`. Never retries and never starts anything implicitly.
 */
export async function queueControlAction(args, { bridge, signal, projectPath } = {}) {
  if (!bridge || typeof bridge.call !== 'function') throw new QueueControlError('invalid_arguments', 'A bridge client is required.');
  if (!record(args) || Object.keys(args).some(key => !KEYS.has(key)) || !QUEUE_ACTIONS.includes(args.action)) invalidArguments('Choose a queue action.');
  if (args.action === 'list') {
    if (args.batchId !== undefined || args.itemIndex !== undefined || args.index !== undefined) invalidArguments('Queue list takes no item identity.');
    const result = await bridge.call(QUEUE_HOST_METHODS.list, {}, signal);
    if (!Array.isArray(result?.batches) || result.batches.some(batch => !record(batch))) invalidResponse('Queue list is unavailable.');
    const byStatus = new Map(), storage = storageUsage(result.storage);
    for (const batch of result.batches) byStatus.set(batch.status, (byStatus.get(batch.status) ?? 0) + 1);
    return { value: { total: result.batches.length, byStatus: Object.fromEntries(byStatus), ...(storage ? { storage } : {}),
      batches: result.batches.slice(0, QUEUE_LIST_LIMIT).map(batch => ({ batchId: batch.batchId, source: batchSource(batch.source), status: batch.status, stopReason: batchReason(batch.error), count: batch.count, activeJobId: batch.activeJobId ?? null,
        itemsFailed: itemCount(batch, 'failed'), itemsUnknown: itemCount(batch, 'unknown') })),
      omitted: Math.max(0, result.batches.length - QUEUE_LIST_LIMIT), instruction: 'Use read with a batchId for its item progress.' } };
  }
  if (typeof args.batchId !== 'string' || !UUID.test(args.batchId)) invalidArguments('Select one valid queue batch ID.');
  if (args.action !== 'result') {
    if (args.itemIndex !== undefined || args.index !== undefined) invalidArguments('Only result accepts an image index.');
    const result = await bridge.call(QUEUE_HOST_METHODS[args.action], { batchId: args.batchId }, signal);
    if (!record(result) || result.batchId !== args.batchId || result.execution !== 'queued') invalidResponse('The host returned a different queued batch.');
    // A cleaned batch (queue retention): how it ended and when it was cleaned; pause and cancel changed nothing.
    if (result.cleaned === true) return { value: { ...compactCleanedBatch(result), ...(args.action === 'read' ? { results: [] } : {}),
      instruction: args.action === 'read' ? 'This batch ended and its queue record was cleaned under the client\'s queue retention; its per-image details are gone and nothing of it runs or is resent. Its saved images stay in the library: asset_library {action:"list", category:"history", queueBatchId} lists them.' : 'This batch ended and its queue record was cleaned under the client\'s queue retention; nothing was changed.' } };
    return { value: { ...compactQueuedBatch(result), ...(args.action === 'read' ? { ...readExtras(result, projectPath), ...unknownInstruction(result) } : {}) } };
  }
  if (!Number.isSafeInteger(args.itemIndex) || args.itemIndex < 0 || args.itemIndex >= MAX_QUEUE_ITEMS || (args.index !== undefined && (!Number.isSafeInteger(args.index) || args.index < 0))) invalidArguments('Select a queue item and nonnegative image index.');
  const index = args.index ?? 0;
  const result = await bridge.call(QUEUE_HOST_METHODS.result, { batchId: args.batchId, itemIndex: args.itemIndex, index }, signal);
  if (!record(result) || !IMAGE_TYPES.has(result.mimeType) || typeof result.data !== 'string' || !result.data || (result.index !== undefined && result.index !== index)) invalidResponse('Queue result image is unavailable or mismatched.');
  const historyId = historyIdentity(result.historyId) ? result.historyId : null;
  // The host names the file at the top level (the HTTP bridge forwards no historyItem); older test doubles nest it.
  const hostPath = typeof result.filePath === 'string' ? result.filePath : record(result.historyItem) && result.historyItem.id === historyId ? result.historyItem.filePath : undefined;
  const file = historyId !== null ? fileOf(hostPath, projectPath) : {};
  return { value: { batchId: args.batchId, itemIndex: args.itemIndex, index, jobId: result.jobId, historyId, actualSeed: actualSeedOf(result.actualSeed), ...file, ...(typeof file.file === 'string' ? { pathBase: 'project-root' } : {}), imageAttached: true }, image: { mimeType: result.mimeType, data: result.data } };
}
