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
 * Why a batch holds, is paused or ended early (stopReason in outputs): the host's code for it, with this server's own
 * English explanation for the codes the host queue sets (electron/batch-service.ts). The host's message is never passed
 * on (as with item errors): an unknown code is reported by its code only. Since 0.1.4 no failure stops the queue: a
 * failed or unknown image marks only itself (see ITEM_REASONS) and its batch goes on; the codes marked "before
 * 0.1.4" appear only on batches an older app version stored.
 */
export const BATCH_REASONS = Object.freeze({
  cancel_unconfirmed: 'The cancellation could not be confirmed; the running image is awaited and no further image of this batch starts.',
  queue_storage_error: 'The frozen queue cannot be read or written safely: agent batches are paused and new enqueues are refused until it is fixed (this protects the queued data).',
  scheduler_stopped: 'The queue hit an internal error and ended this batch early; its remaining images were skipped and are not sent. Other batches are not affected.',
  scheduler_closed: 'The app was closing; this batch continues by itself after the next app start (an image that was running then is marked unknown and not resent).',
  update_pending: 'The app is about to restart to install an update, so no image starts right now; nothing of this batch was sent. A batch that arrives now calls the update off, and the batch then runs as usual.',
  // Stored by app versions before 0.1.4 only.
  queue_halted: 'Before 0.1.4 the app paused later agent batches after a failure; it no longer does, and such a batch continues after the next app start.',
  child_stopped: 'Before 0.1.4 the app stopped a batch at its first unsuccessful image; the images after it were skipped. Failed or unknown images are never resent.',
  child_rejected: 'Before 0.1.4 the app stopped this batch when an image was refused before sending; the images after it were skipped.',
  submission_unconfirmed: 'Before 0.1.4 the app stopped this batch when whether an image was submitted could not be confirmed; that image was not resent and the images after it were skipped.',
  restart_unconfirmed: 'Before 0.1.4 the app ended this batch after a restart because an image had an unknown outcome; nothing was resent.',
  restart_blocked: 'Before 0.1.4 the app ended this batch after a restart because an image had not succeeded; the images not yet submitted were skipped.',
  recovered_paused: 'Before 0.1.4 the app kept unfinished batches paused after a restart; such a batch continues after the next app start.',
  child_lookup_failed: 'Before 0.1.4 the app paused this batch when whether its next image was submitted could not be confirmed.',
  child_status_unavailable: 'Before 0.1.4 the app held this batch when its running image could not be read.',
});
/**
 * What an item's error code means (read_queue itemReasons, for the codes present), for the codes the queue itself sets
 * on one image. Codes of the generation request (generation_failed, authentication_failed, …) speak for themselves.
 */
export const ITEM_REASONS = Object.freeze({
  rate_limited: 'NovelAI answered HTTP 429 (too many requests, e.g. another generation running on the account); the image was sent again automatically for about 60 seconds, was not generated and is not sent again.',
  child_lookup_failed: 'Whether this image had already been submitted could not be confirmed for about 90 seconds; it is marked unknown and never resent. The batch went on.',
  child_status_unavailable: 'The running image could not be read for about 90 seconds; its outcome is unknown (it may have been generated and charged) and it is never resent. The batch went on.',
  submission_unconfirmed: 'Whether this image was submitted could not be confirmed (it may have been generated and charged); it is never resent. The batch went on.',
  restart_unconfirmed: 'The app closed while this image ran; its outcome is unknown and it is never resent. The rest of the batch continued after the restart.',
  scheduler_error: 'The queue hit an internal error while handling this image; it is never resent. The batch went on.',
  provider_unknown: 'The request may have been sent and its outcome is unknown (it may have been generated and charged); it is never resent.',
  authentication_failed: 'NovelAI refused the token (HTTP 401/403); the image failed. Later images fail the same way until the user fixes the token in the app.',
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
const COUNTED_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'unknown', 'cancelled', 'skipped'];
/** Images per status (running = submitting or running), so a partial end says how many failed or are unknown. */
export function batchItemCounts(batch) {
  const counts = Object.fromEntries(COUNTED_STATUSES.map(status => [status, 0]));
  for (const item of Array.isArray(batch?.items) ? batch.items : []) { const status = item?.status === 'submitting' ? 'running' : item?.status; if (Object.hasOwn(counts, status)) counts[status]++; }
  return counts;
}

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
    recipePlanHash: batch.recipePlanHash, intervalSeconds: batch.intervalSeconds, activeJobId: batch.activeJobId ?? null, ...compactOutput(batch.output), itemCounts: batchItemCounts(batch),
    items: (batch.items ?? []).map(item => ({ index: item.index, status: item.status, jobId: item.jobId ?? null, resultCount: item.results?.length ?? 0, error: item.error?.code ?? null, ...(Number.isSafeInteger(item.rateLimitRetries) && item.rateLimitRetries > 0 ? { rateLimitRetries: item.rateLimitRetries } : {}) })) };
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

/**
 * read only: where the batch stands in the shared FIFO, as the host reports it (0.1.4): ahead {images, batches} not
 * yet done before it (not paused), etaSeconds until it ends (from the median time of the images the queue finished
 * recently, plus intervals; null without such a time or while it is paused, 0 once it ended) and imageSeconds, that
 * median. An older host reports none of them: null.
 */
function positionOf(batch) {
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const seconds = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const ahead = record(batch.ahead) && count(batch.ahead.images) && count(batch.ahead.batches) ? { images: batch.ahead.images, batches: batch.ahead.batches } : null;
  return { ahead, etaSeconds: seconds(batch.etaSeconds), imageSeconds: seconds(batch.imageSeconds) };
}
/** read only: this server's explanation of the queue's own item codes present in the batch. */
function itemReasonsOf(batch) {
  const codes = [...new Set((Array.isArray(batch.items) ? batch.items : []).map(item => item?.error?.code).filter(code => typeof code === 'string' && Object.hasOwn(ITEM_REASONS, code)))];
  return codes.length ? { itemReasons: Object.fromEntries(codes.map(code => [code, ITEM_REASONS[code]])) } : {};
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
    return { value: { ...compactQueuedBatch(result), ...(args.action === 'read' ? { ...readExtras(result, projectPath), ...positionOf(result), ...itemReasonsOf(result), ...unknownInstruction(result) } : {}) } };
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

/** read_queue wait (0.1.4): the longest wait one call takes (the MCP clients' tool timeout is 1560 s) and its default. */
export const QUEUE_WAIT = Object.freeze({ maxSeconds: 1200, defaultSeconds: 300, pollMs: 1000, slowPollMs: 2000 });
export const QUEUE_WAIT_UNTIL = Object.freeze(['done', 'next']);
const ENDED = new Set(['succeeded', 'partial', 'cancelled', 'blocked']);
/** Failures a wait does not read through: the arguments, the batch or this server are wrong, so another read says the same. */
const FINAL_READ_ERRORS = new Set(['invalid_arguments', 'invalid_argument', 'invalid_response', 'batch_not_found', 'unknown_tool', 'unsupported_method', 'invalid_connection', 'host_method_not_allowed', 'host_call_outside_tool']);
const abortError = () => Object.assign(new Error('The request was cancelled.'), { name: 'AbortError' });
/** Sleeps `milliseconds`, or rejects at once when the request is cancelled. */
function abortableSleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const done = () => { signal?.removeEventListener('abort', stop); resolve(); };
    const timer = setTimeout(done, milliseconds);
    const stop = () => { clearTimeout(timer); reject(abortError()); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}
const resultKey = result => `${result.itemIndex}:${result.index}:${result.historyId}`;
/** Why a wait ends now with this read, or null to go on waiting. */
function waitEnded(value, until, before) {
  if (value.cleaned === true) return 'done';
  if (value.status === 'cancelled' || value.status === 'cancelling') return 'cancelled';
  if (ENDED.has(value.status)) return 'done';
  if (value.status === 'paused') return 'paused';
  if (until === 'next' && (value.results ?? []).some(result => result.historyId !== null && !before.has(resultKey(result)))) return 'next';
  return null;
}
/**
 * read_queue with wait {until, seconds}: reads the batch every 1–2 s (2 s while its time left is over a minute) and
 * returns as soon as it ended ("done"; "cancelled" for a cancelled or cancelling one), is paused ("paused"), or, for
 * until "next", shows a saved result of this batch that was not there at the first read ("next"); else after `seconds`
 * ("timeout"). A read that fails with anything but a definite refusal is tried again at the next poll; only when no read
 * succeeded at all does the wait end with that error. The request's abort signal stops it at once. Read-only: nothing
 * is enqueued, resumed or resent.
 */
export async function waitForQueuedBatch(args, { bridge, signal, projectPath, now = Date.now, sleep = abortableSleep } = {}) {
  const until = args.wait.until, seconds = args.wait.seconds ?? QUEUE_WAIT.defaultSeconds;
  if (!QUEUE_WAIT_UNTIL.includes(until) || typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 1 || seconds > QUEUE_WAIT.maxSeconds) invalidArguments(`wait needs until "done" or "next" and seconds 1–${QUEUE_WAIT.maxSeconds}.`);
  const started = now(), deadline = started + seconds * 1000;
  let last = null, before = null, failure = null;
  const finish = ended => ({ value: { ...last, wait: { until, ended, waitedSeconds: Math.round((now() - started) / 100) / 10, ...(failure ? { lastReadFailed: failure.code ?? 'internal_error' } : {}) } } });
  for (;;) {
    if (signal?.aborted) throw abortError();
    try { last = (await queueControlAction({ action: 'read', batchId: args.batchId }, { bridge, signal, projectPath })).value; failure = null; }
    catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      if (FINAL_READ_ERRORS.has(error?.code) || error instanceof QueueControlError) throw error;
      failure = error;
    }
    if (last && !failure) {
      before ??= new Set((last.results ?? []).filter(result => result.historyId !== null).map(resultKey));
      const ended = waitEnded(last, until, before);
      if (ended) return finish(ended);
    }
    const left = deadline - now();
    if (left <= 0) { if (!last) throw failure; return finish('timeout'); }
    await sleep(Math.min(left, last && typeof last.etaSeconds === 'number' && last.etaSeconds > 60 ? QUEUE_WAIT.slowPollMs : QUEUE_WAIT.pollMs), signal);
  }
}

/** get_queue_result without itemIndex (0.1.4): the saved results of one batch per call, as thumbnails. */
export const QUEUE_RESULT_PAGE = 20;
export const QUEUE_THUMBNAIL_EDGE = 384;
/**
 * The saved results of a whole batch (in item order) as native thumbnails of at most 384 px, at most QUEUE_RESULT_PAGE
 * per call from `offset`, each with itemIndex, index, historyId, actualSeed, fileName, file; one read_queue, then one
 * get_queue_result {variant:"thumbnail"} per result. A result whose preview cannot be made stays in the list with
 * imageAttached:false and its error code; the images follow in the order of the entries with imageAttached:true.
 * Returns { value, images }.
 */
export async function queueBatchResults(args, { bridge, signal, projectPath } = {}) {
  if (!bridge || typeof bridge.call !== 'function') throw new QueueControlError('invalid_arguments', 'A bridge client is required.');
  if (typeof args?.batchId !== 'string' || !UUID.test(args.batchId)) invalidArguments('Select one valid queue batch ID.');
  const offset = args.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) invalidArguments('offset is a nonnegative integer.');
  const read = await bridge.call(QUEUE_HOST_METHODS.read, { batchId: args.batchId }, signal);
  if (!record(read) || read.batchId !== args.batchId || read.execution !== 'queued') invalidResponse('The host returned a different queued batch.');
  if (read.cleaned === true) throw new QueueControlError('result_unavailable', 'This batch ended and its queue record was cleaned under the client\'s queue retention; its saved images stay in the library: asset_library {action:"list", category:"history", queueBatchId} lists them.');
  const saved = readExtras(read, projectPath).results.filter(result => result.historyId !== null && result.index !== null);
  const page = saved.slice(offset, offset + QUEUE_RESULT_PAGE), entries = [], images = [];
  for (const result of page) {
    const entry = { itemIndex: result.itemIndex, index: result.index, historyId: result.historyId, actualSeed: result.actualSeed, ...(result.fileName !== undefined ? { fileName: result.fileName, file: result.file } : {}) };
    let reply;
    try { reply = await bridge.call(QUEUE_HOST_METHODS.result, { batchId: args.batchId, itemIndex: result.itemIndex, index: result.index, variant: 'thumbnail' }, signal); }
    catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      // A client from before 0.1.4 refuses the variant as an unknown field (and would send full-size originals).
      if (['invalid_argument', 'invalid_arguments'].includes(error?.code) && /unknown queue field|unknown field/i.test(String(error?.message ?? ''))) throw new QueueControlError('host_outdated', 'The NovelAI client is older than this MCP server and cannot send queue thumbnails. Fully rebuild and restart the client; until then use get_queue_result with an itemIndex for one image. Nothing was changed.');
      entries.push({ ...entry, imageAttached: false, error: typeof error?.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(error.code) ? error.code : 'result_unavailable' });
      continue;
    }
    const thumbnail = record(reply) && reply.variant === 'thumbnail' && IMAGE_TYPES.has(reply.mimeType) && typeof reply.data === 'string' && reply.data && (reply.historyId === undefined || reply.historyId === result.historyId)
      && [reply.width, reply.height].every(edge => Number.isSafeInteger(edge) && edge > 0 && edge <= QUEUE_THUMBNAIL_EDGE);
    if (!thumbnail) { entries.push({ ...entry, imageAttached: false, error: 'invalid_response' }); continue; }
    entries.push({ ...entry, width: reply.width, height: reply.height, imageAttached: true });
    images.push({ mimeType: reply.mimeType, data: reply.data });
  }
  const next = offset + page.length;
  return { value: { batchId: args.batchId, status: read.status, total: saved.length, offset, returned: page.length, nextOffset: next < saved.length ? next : null,
    thumbnails: { maxEdge: QUEUE_THUMBNAIL_EDGE }, results: entries, ...(entries.some(entry => typeof entry.file === 'string') ? { pathBase: 'project-root' } : {}),
    instruction: next < saved.length ? `Showing results ${offset + 1}–${next} of ${saved.length}; call again with offset ${next} for the rest.` : 'Thumbnails only: use get_queue_result with itemIndex (and index) for one full-size image.' }, images };
}
