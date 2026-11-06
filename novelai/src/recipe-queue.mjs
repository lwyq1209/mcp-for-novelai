/**
 * Independent recipes and shared FIFO enqueue (core layer of the novelai server).
 *
 * Composes exactly six fixed host methods — put_queue_recipe, read_queue_recipe,
 * preview_queue_recipe, lookup_queue_request, enqueue_queue_recipes and (only to
 * check a stuck unknown receipt against the queue) list_queue — plus the source
 * reads of src/recipe-sources.mjs (asset_library {action:image}).
 *
 * What this module adds on top of the host:
 * - six modes (t2i, i2i, inpaint, enhance, upscale, director). Image modes reference
 *   their source by history identity, or (issue #2) by study identity for an image
 *   imported with material_studies; the host stores that reference and rereads the
 *   original. Inpaint masks are built locally (src/recipe-masks.mjs) and
 *   stored inline with their spec as provenance. Every read asks the host to omit
 *   image bytes (assetData:"omit"); a host too old to know that answers host_outdated;
 * - strict field validation. put_queue_recipe accepts out-of-range values and
 *   then normalizes them silently (steps 99 -> 50, unaligned sizes snapped, V4
 *   "light" quality -> "standard", characters beyond the model limit dropped,
 *   sources stretched, snapped or downscaled); here every such value is rejected
 *   before anything is saved;
 * - preview: the same validation and host builder as a save, through the host's
 *   write-free preview_queue_recipe (inpaint returns an overlay image);
 * - reply checks (identity, revision, recomputed inputHash, snapshot shape, expected
 *   revision after a put), plus a comparison of the stored authored fields with the
 *   request;
 * - a readback of the actual effective input built by the host's generation
 *   builder (final prompts, automatic quality text, UC preset text, characters);
 * - idempotent enqueue: a server-namespaced stable host key, lookup before every
 *   dispatch, exact recipe pre-reads, one dispatch, no retries, and a per-process
 *   hold after an unknown outcome until a lookup resolves it. After an explicit
 *   host refusal one confirming lookup (a read, never a resend) reports what the
 *   key now holds, including an existing batch;
 * - enqueue stays permissive about recipe origin (any host-ready recipe, also one
 *   prepared elsewhere), but reports warnings: a prepare-time recipe_input_mismatch,
 *   characters the builder does not send, inputs prepare_recipe cannot set, and
 *   presets that add no text on the chosen model.
 */
import { createHash } from 'node:crypto';
import { BridgeError } from './bridge-client.mjs';
import { MAX_QUEUE_ITEMS, cleanedBatchInstruction, compactQueuedBatch } from './queue-control.mjs';
import { buildMask } from './recipe-masks.mjs';
import { maskProvenance, maskReadback, prepareMaskSpec, readAlphaImages, readSourceMetadata, sourceIdentity } from './recipe-sources.mjs';

export { RECIPE_SOURCE_HOST_METHODS } from './recipe-sources.mjs';
export const RECIPE_HOST_METHODS = Object.freeze({ put: 'put_queue_recipe', read: 'read_queue_recipe', preview: 'preview_queue_recipe', lookup: 'lookup_queue_request', enqueue: 'enqueue_queue_recipes', list: 'list_queue', capture: 'capture_canvas_recipe' });
/**
 * Fixed, server-owned dispatch scope. Never a tool argument; stable across MCP process restarts. It must never change:
 * it decides the host key of every existing receipt.
 */
export const DISPATCH_SCOPE = 'mcp-for-novelai/recipe-queue/v1';
/** Prefix of every host request key this server derives (mcpHostRequestKey); the host compacts ended receipts and batches of this prefix only. */
export const HOST_REQUEST_KEY_PREFIX = 'mcp-';

// Mirrors client/src/types.ts (NAI_MODELS, NAI_SAMPLERS) and nai-dimensions.ts; a test pins parity with the TS source.
export const T2I_MODELS = Object.freeze(['nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated', 'nai-diffusion-4-full', 'nai-diffusion-4-curated', 'nai-diffusion-3', 'nai-diffusion-furry-3']);
export const T2I_SAMPLERS = Object.freeze(['k_euler_ancestral', 'k_euler', 'k_dpmpp_2m', 'k_dpmpp_2m_sde', 'k_dpmpp_sde', 'k_dpmpp_2s_ancestral', 'ddim_v3']);
export const NOISE_SCHEDULES = Object.freeze(['native', 'karras', 'exponential']);
export const QUALITY_PRESETS = Object.freeze(['standard', 'light', 'none']);
export const MAX_QUEUE_SEED = 2147483646; // host queue validSeed bound
export const MAX_PIXEL_AREA = 3_145_728;
export const MAX_DIMENSION = MAX_PIXEL_AREA / 64;
export const MAX_TEXT = 12000;
/**
 * V5 Full Effort (NovelAI 2026-10-08). Mirrors client/src/nai-effort.ts, from the official web client (build
 * b94bdee-production, read 2026-11-06): Medium runs nai-diffusion-5-full-medium (inpaint: -medium-inpainting) with
 * 14 steps, Euler Ancestral, no CFG rescale, the Heavy UC preset (prefixed with "nsfw, " unless the prompt contains
 * nsfw) and no negative prompt or character UC. Only V5 Full t2i, i2i and inpaint have it. A test pins parity.
 */
export const EFFORT_VALUES = Object.freeze(['high', 'medium']);
export const EFFORT_MODEL = 'nai-diffusion-5-full';
export const MEDIUM_MODELS = Object.freeze(['nai-diffusion-5-full-medium', 'nai-diffusion-5-full-medium-inpainting']);
export const MEDIUM_FIXED = Object.freeze({ steps: 14, sampler: 'k_euler_ancestral', cfgRescale: 0, ucPreset: 0, negativePrompt: '' });
const EFFORT_MODES = Object.freeze(['t2i', 'i2i', 'inpaint']);
/**
 * Enhance Max✨ (V5 Curated and Full). Mirrors client/src/nai-dimensions.ts (maxEnhanceInputSize, maxEnhanceOutputSize),
 * from the same official build: the source goes at its own size under 0.8 × 3,145,728 pixels with upscaled_enhance, the
 * result is about 2× of it (each side floored to 16 and doubled, fitted into 3,145,728 pixels in steps of 32), and it
 * costs Anlas on Opus too. A test pins parity with the client.
 */
export const MAX_ENHANCE_INPUT_LIMIT = 0.8 * 3_145_728;
// MAX_QUEUE_ITEMS (200, defined with the queue tools in src/queue-control.mjs): the hard bound of one enqueue.
export { MAX_QUEUE_ITEMS };
/**
 * enqueue output (2026-10-14, issue #1): where the host saves this enqueue's images. Same rules as the host's
 * client/electron/queue-output.ts (a test pins them together): a history-group name (created on first use, reused
 * by name as the host stores it: whitespace runs collapsed, case-insensitive, NFC) and a file-system-safe file-name prefix.
 */
// Both limits count UTF-16 code units, an emoji counts 2 (the host truncates group and file names that way).
export const QUEUE_HISTORY_GROUP_MAX = 80;
export const QUEUE_FILE_PREFIX_MAX = 40;
// Schema-safe (no \p escapes, so a client compiling it without the u flag reads it the same way); the server
// check below adds what a pattern cannot say portably.
export const QUEUE_FILE_PREFIX_PATTERN = '^(?![.-])[^\\s\\x00-\\x1f\\x7f\\\\/:*?"<>|]+$';
const FILE_PREFIX = new RegExp(QUEUE_FILE_PREFIX_PATTERN, 'u');
// C0, DEL and C1 controls.
const CONTROL = /\p{Cc}/u;
// Lone surrogates and the invisible format characters that disguise a name; joiners only between visible characters;
// tag characters only inside the three RGI subdivision flags. These regex lines are copied from client/electron/queue-output.ts
// (a client test compares their text).
const INVISIBLE = /[\p{Cs}\u00ad\u061c\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}]/u;
const STRAY_JOINER = /^[\u200c\u200d]|[\u200c\u200d]$|\s[\u200c\u200d]|[\u200c\u200d]\s/u;
const FLAG_TAG_SEQUENCE = /\u{1f3f4}\u{e0067}\u{e0062}(?:\u{e0065}\u{e006e}\u{e0067}|\u{e0073}\u{e0063}\u{e0074}|\u{e0077}\u{e006c}\u{e0073})\u{e007f}/gu;
const STRAY_TAG = /[\u{e0000}-\u{e007f}]/u;
const disguised = value => INVISIBLE.test(value) || STRAY_JOINER.test(value) || STRAY_TAG.test(value.replace(FLAG_TAG_SEQUENCE, ''));
// Windows device names, also with an extension (s: an extension may hold any character).
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/is;
// The host's group-name normalization (queue-output.ts normalizeHistoryGroupName, used by ensureHistoryGroup) and
// folder naming (sanitizeGroupFolderName), same code; a client test pins both copies.
export const normalizeHistoryGroupName = name => name.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
export const groupFolderName = name => name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '_').replace(/^\.+/, '').trim().slice(0, 80) || 'group';
export const validHistoryGroupName = value => typeof value === 'string' && value.length >= 1 && value.length <= QUEUE_HISTORY_GROUP_MAX
  && value === value.trim() && !CONTROL.test(value) && !disguised(value) && !value.startsWith('.') && !value.endsWith('.')
  && !WINDOWS_RESERVED.test(value) && !WINDOWS_RESERVED.test(groupFolderName(normalizeHistoryGroupName(value)));
export const validFileNamePrefix = value => typeof value === 'string' && value.length >= 1 && value.length <= QUEUE_FILE_PREFIX_MAX && FILE_PREFIX.test(value) && !CONTROL.test(value) && !disguised(value) && !WINDOWS_RESERVED.test(value);
export const RECIPE_MODES = Object.freeze(['t2i', 'i2i', 'inpaint', 'enhance', 'upscale', 'director']);
/** Modes that use no seed: one image per recipe per enqueue (client generation-types isSeededGeneration). */
export const POSTPROCESS_MODES = Object.freeze(['upscale', 'director']);
// Mirrors client/src/types.ts NAI_INPAINT_MODELS (base models that have an inpainting model), DIRECTOR_TOOLS and EMOTION_OPTIONS; a test pins parity.
export const INPAINT_BASE_MODELS = Object.freeze(T2I_MODELS.filter(model => model !== 'nai-diffusion-furry-3'));
export const inpaintModelFor = model => `${model}-inpainting`;
export const DIRECTOR_TOOLS = Object.freeze(['bg-removal', 'lineart', 'sketch', 'colorize', 'emotion', 'declutter']);
export const DIRECTOR_EMOTIONS = Object.freeze(['neutral', 'happy', 'sad', 'angry', 'surprised', 'scared', 'disgusted', 'amazed']);
const MiB = 1024 * 1024;
/**
 * Image-recipe limits (design.md §4.1/§4.4/§4.7 as amended by design-addendum §1.6 and §2.5); a test pins them.
 * sourceBytes: the host history reader's bound for a referenced original. maskBytes: the encoded mask PNG.
 * frozenEnqueueBytes: estimated frozen input of one enqueue (base64 of source + mask). The pixel and side limits
 * mirror the host (MAX_NAI_UPSCALE_INPUT_PIXELS, MAX_NAI_DIRECTOR_INPUT_PIXELS, MAX_NAI_UPSCALE_OUTPUT_DIMENSION,
 * the 1600 px inpaint bound of prepareInpaintAssets).
 */
export const RECIPE_LIMITS = Object.freeze({
  sourceBytes: 20 * MiB, maskBytes: 4 * MiB, frozenEnqueueBytes: 32 * MiB, i2iAspectTolerance: 0.03, inpaintMaxSide: 1600,
  postprocessInputPixels: 1024 * 1024, upscaleMaxOutputSide: 4096, enhanceMagnitude: Object.freeze([1, 10]), directorLevel: Object.freeze([0, 5]),
});
/** The host's shared recipe store (client queue-recipe-service RECIPE_STORE_LIMITS); a test pins parity. */
export const RECIPE_STORE_LIMITS = Object.freeze({ records: 16_384, bytes: 512 * MiB });
const STORE_FULL = `The shared recipe store is full (${RECIPE_STORE_LIMITS.records} records or ${RECIPE_STORE_LIMITS.bytes / MiB} MiB)`;
/** A host queue_storage_failed that means the record or byte limit is reached (details.reason store_full; the host's
 * own "Recipe storage is full / exceeds" wording as well). Every other queue_storage_failed (for example an entry in
 * the store folder that the app does not use) is reported with the host's own reason only. */
const storeFullRefusal = error => error instanceof BridgeError && error.code === 'queue_storage_failed'
  && ((record(error.details) && error.details.reason === 'store_full') || /Recipe storage (?:is full|exceeds)/.test(error.message ?? ''));
const putStorageRefusal = error => storeFullRefusal(error)
  ? `The host refused to store the recipe (${error.message}). Nothing was saved. ${STORE_FULL}; it needs explicit archiving before new recipes or enqueues succeed.`
  : `The host refused to store the recipe: ${error.message} Nothing was saved.`;
/** Explicit answer when the host does not know a request this server needs (assetData, preview_queue_recipe). */
export const HOST_OUTDATED_MESSAGE = 'The NovelAI client is older than this MCP server and does not accept this request. Fully rebuild and restart the client, then try again. Nothing was saved or enqueued, and no requestKey was used.';
/**
 * How long an unknown host receipt may still turn into accepted. The host marks an in-flight enqueue
 * unknown when a lookup lands before it finishes and flips it to accepted once the batch exists; the
 * bridge client gives up after 65 s while the host keeps working, so two bridge timeouts (130 s) is the
 * settle window before an unknown key may be treated as stale.
 */
export const UNKNOWN_SETTLE_MS = 2 * 65_000;
/** Host text when a receipt changed under it during a state transition (an enqueue and a lookup of one key colliding). */
export const RECEIPT_TRANSITION_MESSAGE = 'Queue receipt changed during its state transition.';
const receiptTransition = error => typeof error?.message === 'string' && error.message.includes(RECEIPT_TRANSITION_MESSAGE);

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MODES = RECIPE_MODES;
const seeded = mode => !POSTPROCESS_MODES.includes(mode);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const GENERATION_FIELDS = ['model', 'steps', 'cfgScale', 'sampler', 'noiseSchedule', 'ucPreset', 'qualityPreset', 'stylePrompt', 'positivePrompt', 'negativePrompt', 'seed'];
/** Per mode: required and optional prepare_recipe fields. A field of another mode is refused, never ignored. */
export const MODE_FIELDS = Object.freeze({
  t2i: { required: [...GENERATION_FIELDS, 'width', 'height'], optional: ['cfgRescale', 'characters', 'transparentBackground', 'effort'] },
  i2i: { required: ['source', ...GENERATION_FIELDS, 'width', 'height', 'strength'], optional: ['cfgRescale', 'characters', 'extraNoiseSeed', 'effort'] },
  enhance: { required: ['source', ...GENERATION_FIELDS, 'magnitude', 'scale'], optional: ['cfgRescale', 'characters', 'extraNoiseSeed', 'effort'] },
  inpaint: { required: ['source', 'mask', ...GENERATION_FIELDS, 'strength'], optional: ['cfgRescale', 'effort'] },
  upscale: { required: ['source', 'scale'], optional: ['acceptDownscale', 'effort'] },
  director: { required: ['source', 'tool'], optional: ['defry', 'colorizePrompt', 'emotion', 'emotionLevel', 'acceptDownscale', 'effort'] },
});
/** What effort medium fills in: a recipe on Medium may leave these out (any given value is replaced, with a warning). */
const MEDIUM_FILLED = Object.freeze(['steps', 'sampler', 'ucPreset', 'negativePrompt']);
const COMMON_KEYS = ['recipeId', 'expectedRevision', 'mode', 'preview'];
const PREPARE_KEYS = [...new Set([...COMMON_KEYS, 'canvas', ...Object.values(MODE_FIELDS).flatMap(fields => [...fields.required, ...fields.optional])])];
/** prepare_recipe {canvas}: the only fields beside it, and its own keys. */
const CANVAS_COMPANIONS = ['canvas', 'mode', 'preview'];
const CANVAS_KEYS = ['workspaceId', 'expectedRevision', 'draftId', 'patch'];
/**
 * Host codes of a canvas capture that mean nothing was saved: the renderer's own refusals (stale revision, draft,
 * busy mask stroke, unreadable source), its timeout, and the host capture's own checks (client/electron/canvas-recipe-capture.ts).
 */
const CANVAS_REFUSED = new Set(['conflict', 'draft_not_found', 'workspace_mismatch', 'workspace_busy', 'workspace_not_ready', 'workspace_unavailable', 'workspace_timeout', 'invalid_image', 'invalid_mask', 'canvas_capture_failed', 'canvas_capture_mismatch'])
// Stored scalar inputs each mode depends on, compared after a put (paths into reviewInput.authored).
const MODE_SCALARS = Object.freeze({
  t2i: [], i2i: ['i2iParams.strength', 'i2iParams.noise', 'i2iParams.extraNoiseSeed', 'i2iSizeMode'], enhance: ['i2iParams.extraNoiseSeed', 'enhanceMagnitude', 'enhanceScale'],
  inpaint: ['inpaintModel', 'inpaintStrength'], upscale: ['upscaleScale'], director: ['directorTool', 'augmentOptions.defry', 'augmentOptions.colorizePrompt', 'augmentOptions.emotion', 'augmentOptions.emotionLevel'],
});
// What the host builder appends to the positive prompt of a V5 transparent-background request (client/electron/nai-payload.ts).
const TRANSPARENT_BACKGROUND_TEXT = 'transparent background';
const CHARACTER_KEYS = ['prompt', 'negativePrompt', 'useCoords', 'x', 'y'];
// Host fields this tool never exposes; a stored value other than these defaults is a mismatch.
const FIXED_PARAM_DEFAULTS = Object.freeze({ smea: false, smeaDyn: false, variety: false, fileNamePrefix: '' });
// Host codes that are explicit refusals of a put: nothing usable was saved. queue_storage_failed is
// the host's storage refusal (record/byte quota full, storage not owned), raised before publication.
// recipe_source_* are the host's explicit answers about a referenced history or study source (busy: retry the same call later).
const SOURCE_REJECTED = ['recipe_source_unavailable', 'recipe_source_changed', 'recipe_source_busy', 'unsupported_reference_source'];
const PUT_REJECTED = new Set(['invalid_argument', 'invalid_arguments', 'recipe_conflict', 'unsupported_reference', 'unsupported_mode', 'queue_input_too_large', 'recipe_changed', 'queue_storage_failed', ...SOURCE_REJECTED]);
// Host codes that are explicit refusals of an enqueue (the former enqueue core's rejectedCodes plus the host's own
// explicit ones, including storage). Anything else, or no reply, is an unknown outcome.
// queue_full: the host's frozen-queue capacity precheck (before its receipt) or the batch service's quota refusal
// (after it); either way the key status is what the confirming lookup in refused() finds, never assumed.
// queue_storage_error: the host's frozen-queue store has failed. The host reports this code only BEFORE writing
// the request's receipt (batch.ready failed, queueAdmission() or reclaim() found the store failed); a store that
// fails after the receipt is reported as queue_acceptance_unknown (the host looks for a batch first), which stays
// unknown here. A test pins both halves of that premise.
// queue_input_invalid is NOT a normal host answer: it is the frozen storage's code for a new batch input failing its
// self-check, which the batch service reports as invalid_arguments (the receipt is then recorded as rejected). It is
// listed only so that a host passing the raw code through would still be a definite refusal, never unknown.
// enqueue_limit_exceeded: the plan has more images than the client's per-enqueue setting (checked before the receipt).
const ENQUEUE_REJECTED = new Set(['enqueue_limit_exceeded', 'history_group_unavailable', 'history_group_conflict', 'request_conflict', 'invalid_argument', 'invalid_arguments', 'conflict', 'unsupported_mode', 'unsupported_configuration', 'recipe_not_found', 'recipe_conflict', 'recipe_changed', 'recipe_blocked', 'unsupported_reference', 'queue_full', 'queue_input_too_large', 'queue_input_invalid', 'queue_unavailable', 'style_plan_dispatch_required', 'queue_storage_failed', 'queue_storage_error', ...SOURCE_REJECTED]);
/**
 * The host's lookup of a requestKey that already has a receipt answers queue_acceptance_unknown while its frozen
 * queue cannot be read (it failed to load, or failed later): the batch may already be on disk. Nothing is sent, and
 * this is never counted toward the settle window, so it never turns into advice to switch keys.
 */
export const FROZEN_UNREADABLE_MESSAGE = 'This requestKey already has a receipt, but the host\'s frozen queue cannot be read right now, so its batch may already be on disk. Do not resend and do not switch to a new requestKey. Check the NovelAI client first; whether to restart it is the user\'s decision. Afterwards, look up this same requestKey again.';
/** What a queue_storage_error refusal tells the caller (the key status follows from the confirming lookup). */
export const FROZEN_STORE_FAILED_MESSAGE = 'The host\'s frozen queue storage has failed and the host has stopped accepting new batches; its frozen-queue files are kept as they are. Check the NovelAI client first; whether to restart it is the user\'s decision. Do not retry automatically.';
// Inputs a stored recipe can carry that prepare_recipe never sets (reported as unexposed_inputs).
const UNEXPOSED_DEFAULTS = Object.freeze({ smea: false, smeaDyn: false, variety: false });

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
/** Same canonical-JSON SHA-256 as the host's recipeHash. */
export const recipeHash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const sameValue = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const invalid = (message, details) => { throw new BridgeError('invalid_arguments', message, details); };
const valueAt = (value, path) => path.split('.').reduce((node, key) => record(node) ? node[key] : undefined, value);
/** The host refused a field or method only a newer client knows (assetData, preview_queue_recipe). */
const outdatedHost = error => error instanceof BridgeError && (error.code === 'unsupported_method' || (['invalid_argument', 'invalid_arguments'].includes(error.code) && /Unknown queue field/.test(error.message)));
const hostOutdated = (error, details = {}) => new BridgeError('host_outdated', HOST_OUTDATED_MESSAGE, { hostCode: error.code, saved: false, enqueueSent: false, ...details });
const invalidResponse = message => { throw new BridgeError('invalid_response', message); };
/**
 * The host's own structured details of a refusal (for example queue_full {pendingItems, pendingItemLimit} or a
 * recipe_source_* {recipeId, ref, sha256, readerCode}), kept under hostDetails when this server rewrites an error
 * with details of its own. Never spread at the top level, so it cannot replace status, keyStatus or enqueueSent.
 */
const hostDetailsOf = error => error instanceof BridgeError && record(error.details) ? { hostDetails: error.details } : {};
const isV5 = model => model.startsWith('nai-diffusion-5-');
const isV4Plus = model => /^nai-diffusion-[45]-/.test(model);
export const maxCharacters = model => isV5(model) ? 32 : isV4Plus(model) ? 6 : 0;
const exactKeys = (value, allowed, label) => {
  if (!record(value)) invalid(`${label} must be an object.`);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) invalid(`${label} does not accept: ${unknown.join(', ')}.`);
};
const integerIn = (value, min, max, label) => { if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${label} must be an integer from ${min} to ${max}.`); return value; };
const numberIn = (value, min, max, label) => { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid(`${label} must be a number from ${min} to ${max}.`); return value; };
const text = (value, label, { required = false } = {}) => {
  if (typeof value !== 'string' || value.length > MAX_TEXT) invalid(`${label} must be a string of at most ${MAX_TEXT} characters.`);
  if (required && !/\S/.test(value)) invalid(`${label} must not be blank.`);
  return value;
};
const requestKeyOf = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\x00-\x1f\x7f]/.test(value)) invalid('requestKey must be 1–120 printable characters.');
  return value;
};

// ------------------------------------------------------------------ preparation
const boolean = (value, label) => { if (typeof value !== 'boolean') invalid(`${label} must be true or false.`); return value; };

/**
 * The effort of a recipe: "medium" only for V5 Full t2i, i2i and inpaint (anything else that asks for Medium cannot
 * run and is refused); "high" (or none) everywhere is the model as it always ran.
 */
function effortOf(args, mode) {
  if (args.effort === undefined) return 'high';
  if (!EFFORT_VALUES.includes(args.effort)) invalid('effort must be "high" or "medium".');
  if (args.effort === 'high') return 'high';
  if (!EFFORT_MODES.includes(mode)) invalid(`effort medium exists only for V5 Full txt2img, img2img and inpaint; mode ${mode} runs without it (omit effort or pass "high").`, { reason: 'effort_not_supported', mode });
  if (args.model !== EFFORT_MODEL) invalid(`effort medium exists only for ${EFFORT_MODEL}${mode === 'inpaint' ? ' (its inpainting model)' : ''}; ${typeof args.model === 'string' ? args.model : 'this model'} has no Medium effort. Use ${EFFORT_MODEL} or omit effort.`, { reason: 'effort_not_supported', model: args.model ?? null });
  return 'medium';
}

/** What Medium replaced, as warnings: `effort medium fixes steps to 14; your 28 was replaced.` */
function mediumWarnings(args, characters) {
  const warnings = [], given = args;
  const shown = value => typeof value === 'string' ? JSON.stringify(value) : String(value);
  for (const [field, fixed] of Object.entries(MEDIUM_FIXED)) {
    if (given[field] === undefined || sameValue(given[field], fixed)) continue;
    const to = field === 'ucPreset' ? '0 (Heavy)' : field === 'negativePrompt' ? 'empty (Medium sends only the Heavy UC)' : shown(fixed);
    warnings.push({ code: 'effort_medium_fixed', field, from: given[field], to: fixed, message: `effort medium fixes ${field} to ${to}; your ${shown(given[field])} was replaced.` });
  }
  const dropped = (characters ?? []).map((character, index) => character.negativePrompt ? index : -1).filter(index => index >= 0);
  if (dropped.length) warnings.push({ code: 'effort_medium_fixed', field: 'characters.negativePrompt', characters: dropped, message: `effort medium sends no character negative prompt; the negativePrompt of characters ${dropped.join(', ')} was removed (use negative emphasis such as -3::hat:: in the prompt instead).` });
  return warnings;
}

/** Shared generation fields of t2i, i2i, enhance and inpaint (inpaint: the base model of its inpainting model). */
function generationFields(args, mode, effort = 'high') {
  const model = args.model, models = mode === 'inpaint' ? INPAINT_BASE_MODELS : T2I_MODELS;
  if (!models.includes(model)) invalid(mode === 'inpaint' && T2I_MODELS.includes(model) ? `${model} has no inpainting model; inpaint takes ${models.join(', ')} (run as <model>-inpainting).` : `model must be one of ${models.join(', ')}.`);
  const medium = effort === 'medium';
  // Medium's fixed values are filled in and replace whatever was given (mediumWarnings reports it), so they are not checked.
  if (!medium) integerIn(args.steps, 1, 50, 'steps');
  numberIn(args.cfgScale, 0, 10, 'cfgScale');
  const cfgRescale = medium ? MEDIUM_FIXED.cfgRescale : args.cfgRescale ?? 0;
  numberIn(cfgRescale, 0, 1, 'cfgRescale');
  if (!medium && !T2I_SAMPLERS.includes(args.sampler)) invalid(`sampler must be one of ${T2I_SAMPLERS.join(', ')}.`);
  if (!NOISE_SCHEDULES.includes(args.noiseSchedule)) invalid(`noiseSchedule must be one of ${NOISE_SCHEDULES.join(', ')}.`);
  if (isV5(model) && args.noiseSchedule !== 'karras') invalid('V5 models always generate with noiseSchedule karras; set karras explicitly.');
  if (!medium) integerIn(args.ucPreset, 0, 3, 'ucPreset');
  if (!QUALITY_PRESETS.includes(args.qualityPreset)) invalid(`qualityPreset must be one of ${QUALITY_PRESETS.join(', ')}.`);
  if (args.qualityPreset === 'light' && !isV5(model)) invalid('qualityPreset light exists only for V5 models; the host would otherwise convert it to standard.');
  text(args.stylePrompt, 'stylePrompt');
  text(args.positivePrompt, 'positivePrompt', { required: true });
  if (!medium) text(args.negativePrompt, 'negativePrompt');
  if (args.seed !== null) integerIn(args.seed, 0, MAX_QUEUE_SEED, 'seed');
  return { model, cfgRescale };
}
function explicitSize(args) {
  for (const side of ['width', 'height']) {
    integerIn(args[side], 64, MAX_DIMENSION, side);
    if (args[side] % 64) invalid(`${side} must be a multiple of 64; the host would otherwise snap it silently.`);
  }
  if (args.width * args.height > MAX_PIXEL_AREA) invalid(`width × height must not exceed ${MAX_PIXEL_AREA} pixels (e.g. 1024×1024, 832×1216, 1216×832); the host would otherwise shrink it silently.`);
  return { width: args.width, height: args.height };
}
function characterCaptions(args, model) {
  const characters = args.characters ?? [];
  if (!Array.isArray(characters)) invalid('characters must be an array.');
  const limit = maxCharacters(model);
  if (characters.length > limit) invalid(limit ? `${model} accepts at most ${limit} characters; the host would otherwise drop the rest.` : `${model} does not support character prompts; the host would otherwise drop them.`);
  return characters.map((character, index) => {
    const label = `characters[${index}]`;
    exactKeys(character, CHARACTER_KEYS, label);
    text(character.prompt, `${label}.prompt`, { required: true });
    if (character.negativePrompt !== undefined) text(character.negativePrompt, `${label}.negativePrompt`);
    if (typeof character.useCoords !== 'boolean') invalid(`${label}.useCoords must be boolean.`);
    for (const axis of ['x', 'y']) {
      if (character[axis] === undefined) { if (character.useCoords) invalid(`${label}.${axis} is required when useCoords is true.`); }
      else numberIn(character[axis], 0, 1, `${label}.${axis}`);
    }
    return { prompt: character.prompt, ...(character.negativePrompt !== undefined ? { negativePrompt: character.negativePrompt } : {}), useCoords: character.useCoords, x: character.x ?? 0.5, y: character.y ?? 0.5 };
  });
}
const extraNoiseSeedOf = value => { if (value === undefined || value === null) return null; integerIn(value, 1, MAX_QUEUE_SEED, 'extraNoiseSeed'); return value; };

/**
 * Pure validation of prepare_recipe arguments, before any host call. Returns the plan that, with the source
 * metadata (and the built mask for inpaint), becomes the exact preparation sent to the host.
 */
export function recipePlan(args) {
  exactKeys(args, PREPARE_KEYS, 'prepare_recipe');
  if (!RECIPE_MODES.includes(args.mode)) invalid(`mode must be one of ${RECIPE_MODES.join(', ')}.`);
  if (Object.hasOwn(args, 'canvas')) return canvasPlan(args);
  const mode = args.mode, fields = MODE_FIELDS[mode];
  const foreign = Object.keys(args).filter(key => !COMMON_KEYS.includes(key) && !fields.required.includes(key) && !fields.optional.includes(key));
  if (foreign.length) invalid(`mode ${mode} does not accept: ${foreign.join(', ')}. Fields of other modes are refused, not ignored.`, { reason: 'field_not_in_mode', fields: foreign });
  const effort = effortOf(args, mode);
  const missing = fields.required.filter(key => !Object.hasOwn(args, key) && !(effort === 'medium' && MEDIUM_FILLED.includes(key)));
  if (missing.length) invalid(`Missing ${missing.join(', ')}; every ${mode} field is explicit and no host default is inherited.`, { reason: 'missing_fields', fields: missing });
  if ((args.recipeId === undefined) !== (args.expectedRevision === undefined)) invalid('Revising a recipe requires both recipeId and its current expectedRevision.');
  if (args.recipeId !== undefined && (typeof args.recipeId !== 'string' || !UUID.test(args.recipeId))) invalid('recipeId must be a recipe UUID.');
  if (args.expectedRevision !== undefined) integerIn(args.expectedRevision, 1, Number.MAX_SAFE_INTEGER, 'expectedRevision');
  if (args.preview !== undefined) boolean(args.preview, 'preview');
  const plan = { mode, updating: args.recipeId !== undefined, preview: args.preview === true, source: mode === 't2i' ? null : sourceIdentity(args.source), effort, warnings: [] };
  if (seeded(mode)) {
    const { model, cfgRescale } = generationFields(args, mode, effort);
    plan.generation = { model, stylePrompt: args.stylePrompt, positivePrompt: args.positivePrompt, negativePrompt: args.negativePrompt, steps: args.steps, cfgScale: args.cfgScale, cfgRescale,
      sampler: args.sampler, noiseSchedule: args.noiseSchedule, seed: args.seed, ucPreset: args.ucPreset, qualityPreset: args.qualityPreset };
    if (effort === 'medium') {
      plan.warnings.push(...mediumWarnings(args, Array.isArray(args.characters) ? args.characters : []));
      Object.assign(plan.generation, { steps: MEDIUM_FIXED.steps, sampler: MEDIUM_FIXED.sampler, ucPreset: MEDIUM_FIXED.ucPreset, negativePrompt: MEDIUM_FIXED.negativePrompt });
    }
    if (mode === 't2i' || mode === 'i2i') plan.size = explicitSize(args);
    if (args.transparentBackground !== undefined) boolean(args.transparentBackground, 'transparentBackground');
    plan.transparentBackground = args.transparentBackground ?? false;
    if (plan.transparentBackground && !isV5(model)) invalid('transparentBackground exists only for V5 models; the host would otherwise turn it off silently.');
    if (mode !== 'inpaint') plan.charCaptions = characterCaptions(args, model).map(character => effort === 'medium' ? (({ negativePrompt: _dropped, ...rest }) => rest)(character) : character);
  }
  if (mode === 'i2i') plan.i2i = { strength: numberIn(args.strength, 0, 1, 'strength'), extraNoiseSeed: extraNoiseSeedOf(args.extraNoiseSeed) };
  if (mode === 'enhance') {
    integerIn(args.magnitude, ...RECIPE_LIMITS.enhanceMagnitude, 'magnitude');
    if (args.scale !== 1 && args.scale !== 2 && args.scale !== 'max') invalid('enhance scale must be 1, 2 or "max" (Max✨, V5 models only).');
    if (args.scale === 'max' && !isV5(args.model)) invalid(`Enhance Max✨ exists only for the V5 models (nai-diffusion-5-full, nai-diffusion-5-curated); ${args.model} has scale 1 or 2.`, { reason: 'max_enhance_not_supported', model: args.model });
    plan.enhance = { magnitude: args.magnitude, scale: args.scale, extraNoiseSeed: extraNoiseSeedOf(args.extraNoiseSeed) };
  }
  if (mode === 'inpaint') {
    plan.inpaint = { strength: numberIn(args.strength, 0, 1, 'strength') };
    plan.mask = prepareMaskSpec(args.mask);
  }
  if (mode === 'upscale' || mode === 'director') {
    if (args.acceptDownscale !== undefined) boolean(args.acceptDownscale, 'acceptDownscale');
    plan.acceptDownscale = args.acceptDownscale === true;
  }
  if (mode === 'upscale' && args.scale !== 2) invalid('upscale scale must be 2: the host sends one 2× request (for 4× upscale the 2× result again).');
  if (mode === 'director') {
    if (!DIRECTOR_TOOLS.includes(args.tool)) invalid(`tool must be one of ${DIRECTOR_TOOLS.join(', ')}.`);
    const tool = args.tool, [low, high] = RECIPE_LIMITS.directorLevel;
    const defry = args.defry === undefined ? 0 : integerIn(args.defry, low, high, 'defry');
    if ((tool === 'colorize') !== (args.colorizePrompt !== undefined)) invalid(tool === 'colorize' ? 'tool colorize requires colorizePrompt (it may be empty).' : `colorizePrompt belongs to tool colorize, not ${tool}.`);
    if (args.colorizePrompt !== undefined) text(args.colorizePrompt, 'colorizePrompt');
    for (const key of ['emotion', 'emotionLevel']) if ((tool === 'emotion') !== (args[key] !== undefined)) invalid(tool === 'emotion' ? `tool emotion requires ${key}.` : `${key} belongs to tool emotion, not ${tool}.`);
    if (tool === 'emotion') {
      if (!DIRECTOR_EMOTIONS.includes(args.emotion)) invalid(`emotion must be one of ${DIRECTOR_EMOTIONS.join(', ')}.`);
      integerIn(args.emotionLevel, low, high, 'emotionLevel');
    }
    // Options a tool does not use are sent as the host defaults ('', happy, 0).
    plan.director = { tool, options: { defry, colorizePrompt: args.colorizePrompt ?? '', emotion: args.emotion ?? 'happy', emotionLevel: args.emotionLevel ?? 0 } };
  }
  return plan;
}

const canvasIdentifier = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\x00-\x1f\x7f]/.test(value)) invalid(`${label} must be 1–120 printable characters.`);
  return value;
};
/** prepare_recipe {canvas, mode, preview?}: the canvas identity and its optional draft or detached t2i text patch, nothing else. */
export function canvasPlan(args) {
  const foreign = Object.keys(args).filter(key => !CANVAS_COMPANIONS.includes(key));
  if (foreign.length) invalid(`A canvas capture takes every input from the canvas; beside canvas only mode and preview are accepted, not: ${foreign.join(', ')}.`, { reason: 'field_not_with_canvas', fields: foreign });
  exactKeys(args.canvas, CANVAS_KEYS, 'canvas');
  const canvas = { workspaceId: canvasIdentifier(args.canvas.workspaceId, 'canvas.workspaceId'), expectedRevision: integerIn(args.canvas.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'canvas.expectedRevision') };
  if (args.canvas.draftId !== undefined) canvas.draftId = canvasIdentifier(args.canvas.draftId, 'canvas.draftId');
  if (args.canvas.patch !== undefined) {
    exactKeys(args.canvas.patch, ['params', 'charCaptions'], 'canvas.patch');
    if (args.mode !== 't2i' || canvas.draftId !== undefined || !Object.keys(args.canvas.patch).length) invalid('canvas.patch is a nonempty detached t2i text patch (params, charCaptions) and cannot be combined with draftId.');
    if (args.canvas.patch.params !== undefined && !record(args.canvas.patch.params)) invalid('canvas.patch.params must be an object.');
    if (args.canvas.patch.charCaptions !== undefined && !Array.isArray(args.canvas.patch.charCaptions)) invalid('canvas.patch.charCaptions must be an array.');
    canvas.patch = structuredClone(args.canvas.patch);
  }
  if (args.preview !== undefined) boolean(args.preview, 'preview');
  return { mode: args.mode, updating: false, preview: args.preview === true, source: null, canvas };
}

const aspectDeviation = (width, height, sourceWidth, sourceHeight) => Math.abs(width * sourceHeight - sourceWidth * height) / (sourceWidth * height);
/** Valid t2i/i2i sizes within the aspect tolerance of a source, one per wanted area (closest area first). */
function aspectCandidates(sourceWidth, sourceHeight, areas) {
  const sizes = [];
  for (let width = 64; width <= MAX_DIMENSION; width += 64) {
    const height = Math.max(64, Math.round((width * sourceHeight) / sourceWidth / 64) * 64);
    if (width * height <= MAX_PIXEL_AREA && aspectDeviation(width, height, sourceWidth, sourceHeight) <= RECIPE_LIMITS.i2iAspectTolerance) sizes.push({ width, height });
  }
  const picked = [];
  for (const area of areas) {
    const best = sizes.reduce((closest, size) => !closest || Math.abs(size.width * size.height - area) < Math.abs(closest.width * closest.height - area) ? size : closest, null);
    if (best && !picked.includes(best)) picked.push(best);
  }
  return picked;
}
/** Port of client resolveNAIEnhanceOutputSize + adaptiveNAIImageSize (src/nai-dimensions.ts); a test compares them. */
export function enhanceTargetSize(width, height, scale) {
  const snap = (value, fallback) => Number.isFinite(value) ? Math.min(MAX_DIMENSION, Math.max(64, Math.round(value / 64) * 64)) : fallback;
  const output = { width: snap(width * Math.max(1, scale), 832), height: snap(height * Math.max(1, scale), 1216) };
  const exceedsLimit = output.width * output.height > MAX_PIXEL_AREA;
  if (!exceedsLimit) return { ...output, exceedsLimit };
  const ratio = Math.sqrt(MAX_PIXEL_AREA / (output.width * output.height));
  return { width: Math.max(64, Math.floor((output.width * ratio) / 64) * 64), height: Math.max(64, Math.floor((output.height * ratio) / 64) * 64), exceedsLimit };
}
/** Port of client maxEnhanceInputSize (src/nai-dimensions.ts): the 64-aligned source size under the Max input limit. */
export function maxEnhanceInputSize(width, height) {
  const snap = value => Math.min(MAX_DIMENSION, Math.max(64, Math.round(value / 64) * 64));
  let size = { width: snap(width), height: snap(height) };
  if (size.width * size.height > MAX_PIXEL_AREA) {
    const ratio = Math.sqrt(MAX_PIXEL_AREA / (size.width * size.height));
    size = { width: Math.max(64, Math.floor((size.width * ratio) / 64) * 64), height: Math.max(64, Math.floor((size.height * ratio) / 64) * 64) };
  }
  if (size.width * size.height >= MAX_ENHANCE_INPUT_LIMIT) {
    const ratio = Math.sqrt((MAX_ENHANCE_INPUT_LIMIT - 1) / (size.width * size.height));
    size = { width: Math.max(64, Math.floor((size.width * ratio) / 64) * 64), height: Math.max(64, Math.floor((size.height * ratio) / 64) * 64) };
    if (size.width * size.height >= MAX_ENHANCE_INPUT_LIMIT) {
      const long = Math.floor((MAX_ENHANCE_INPUT_LIMIT - 1) / Math.min(size.width, size.height) / 64) * 64;
      size = size.width >= size.height ? { width: long, height: size.height } : { width: size.width, height: long };
    }
  }
  return { ...size, resized: size.width !== width || size.height !== height };
}
/** Port of client maxEnhanceOutputSize: the size the official client expects back from a Max✨ enhance of this input. */
export function maxEnhanceOutputSize(width, height) {
  const doubledWidth = Math.floor(width / 16) * 16 * 2, doubledHeight = Math.floor(height / 16) * 16 * 2;
  const scale = Math.min(1, Math.sqrt(MAX_PIXEL_AREA / (doubledWidth * doubledHeight)));
  let outWidth = 32 * Math.round((doubledWidth * scale) / 32), outHeight = 32 * Math.round((doubledHeight * scale) / 32);
  if (outWidth * outHeight > MAX_PIXEL_AREA) { outWidth = 32 * Math.floor((doubledWidth * scale) / 32); outHeight = 32 * Math.floor((doubledHeight * scale) / 32); }
  return { width: Math.max(32, outWidth), height: Math.max(32, outHeight) };
}
/** Host downscale of an upscale/director input (generation-postprocess.ts resolvePostprocessRecipe). */
export function postprocessInputSize(width, height) {
  const cap = RECIPE_LIMITS.postprocessInputPixels, ratio = width * height > cap ? Math.sqrt(cap / (width * height)) : 1;
  return { width: Math.max(1, Math.floor(width * ratio)), height: Math.max(1, Math.floor(height * ratio)), resized: ratio !== 1 };
}

/**
 * Source checks once the registered original's metadata is known, still before anything is saved: every case
 * where the host would stretch, snap, align, shrink or refuse the source is refused here instead. Returns the
 * size the generation parameters use (enhance: source × scale; inpaint: the source size), or null.
 */
export function checkRecipeSource(plan, source) {
  const at = { path: 'source', source: { width: source.width, height: source.height, mimeType: source.mimeType, byteLength: source.byteLength } };
  const refuse = (reason, message, extra = {}) => invalid(`${message} Nothing was saved.`, { reason, ...at, ...extra });
  const { width, height } = source;
  if (source.byteLength > RECIPE_LIMITS.sourceBytes) refuse('source_too_large', `The source is ${source.byteLength} bytes; at most ${RECIPE_LIMITS.sourceBytes} (20 MiB).`);
  if (plan.mode === 'i2i') {
    const deviation = aspectDeviation(plan.size.width, plan.size.height, width, height);
    if (deviation > RECIPE_LIMITS.i2iAspectTolerance) {
      const candidates = aspectCandidates(width, height, [plan.size.width * plan.size.height, Math.min(width * height, MAX_PIXEL_AREA)]);
      refuse('source_aspect_mismatch', `width×height ${plan.size.width}×${plan.size.height} differs from the source aspect (${width}×${height}) by ${(deviation * 100).toFixed(1)}%; the host would stretch it (at most ${RECIPE_LIMITS.i2iAspectTolerance * 100}% is accepted).${candidates.length ? ` Sizes keeping the aspect: ${candidates.map(item => `${item.width}×${item.height}`).join(', ')}.` : ''}`, { aspectDeviation: Math.round(deviation * 1e4) / 1e4, candidates });
    }
    return plan.size;
  }
  if (plan.mode === 'enhance' && plan.enhance.scale === 'max') {
    // Max✨: the size is worked out, never refused: a source that is not 64-aligned or too large is adjusted.
    // (The readback reports the adjusted size, the expected result and the cost: enhance_max_paid, enhance_max_source_adjusted.)
    const input = maxEnhanceInputSize(width, height);
    return { width: input.width, height: input.height };
  }
  if (plan.mode === 'enhance') {
    const { scale } = plan.enhance, exact = { width: width * scale, height: height * scale }, host = enhanceTargetSize(width, height, scale);
    if (host.width !== exact.width || host.height !== exact.height) {
      refuse(width % 64 || height % 64 ? 'enhance_source_not_aligned' : 'enhance_size_too_large', width % 64 || height % 64
        ? `Enhance needs a source whose width and height are multiples of 64; ${width}×${height} would be resized by the host to ${host.width}×${host.height}.`
        : `The source ${width}×${height} at scale ${scale} is ${exact.width}×${exact.height}, over ${MAX_PIXEL_AREA} pixels; the host would ${scale === 2 ? 'refuse it' : `shrink it to ${host.width}×${host.height}`}.`, { hostSize: { width: host.width, height: host.height } });
    }
    return exact;
  }
  if (plan.mode === 'inpaint') {
    if (width % 64 || height % 64) refuse('inpaint_source_not_aligned', `Inpaint needs a source whose width and height are multiples of 64; ${width}×${height} would be padded and stretched by the host.`);
    if (width > RECIPE_LIMITS.inpaintMaxSide || height > RECIPE_LIMITS.inpaintMaxSide) refuse('inpaint_source_too_large', `Inpaint sources are at most ${RECIPE_LIMITS.inpaintMaxSide} px per side; this one is ${width}×${height}.`);
    return { width, height };
  }
  const input = postprocessInputSize(width, height);
  if (input.resized && !plan.acceptDownscale) refuse('source_needs_downscale', `The source ${width}×${height} has more than ${RECIPE_LIMITS.postprocessInputPixels} pixels; the host would downscale it to ${input.width}×${input.height} before ${plan.mode}. Pass acceptDownscale:true to accept that.`, { downscaledTo: { width: input.width, height: input.height } });
  if (plan.mode === 'upscale' && (input.width * 2 > RECIPE_LIMITS.upscaleMaxOutputSide || input.height * 2 > RECIPE_LIMITS.upscaleMaxOutputSide))
    refuse('upscale_output_too_large', `A 2× upscale of ${input.width}×${input.height} exceeds ${RECIPE_LIMITS.upscaleMaxOutputSide} px per side.`);
  return null;
}

function generationParams(plan, size) {
  const g = plan.generation;
  return { promptAssemblyVersion: 1, model: g.model, stylePrompt: g.stylePrompt, positivePrompt: g.positivePrompt, negativePrompt: g.negativePrompt,
    width: size.width, height: size.height, steps: g.steps, cfgScale: g.cfgScale, cfgRescale: g.cfgRescale, sampler: g.sampler, noiseSchedule: g.noiseSchedule,
    seed: g.seed ?? 0, seedMode: g.seed === null ? 'random' : 'fixed', ucPreset: g.ucPreset, qualityPreset: g.qualityPreset, qualityToggle: g.qualityPreset !== 'none', transparentBackground: plan.transparentBackground,
    // Only Medium is stored: a High recipe keeps exactly the fields (and inputHash) it always had.
    ...(plan.effort === 'medium' ? { effort: 'medium' } : {}) };
}

/** The host reference of a source identity: history {kind, id, revision, assetId}; study {kind, id, revision} (no assetId). */
const hostReference = source => source.kind === 'study' ? { kind: 'study', id: source.studyId, revision: source.studyRevision }
  : { kind: 'history', id: source.historyId, revision: source.historyRevision, assetId: source.assetId };

/**
 * The exact {mode, authored, assets} sent to put_queue_recipe / preview_queue_recipe. The source is a history or
 * study reference bound to the registered original's sha256 and byteLength; the inpaint mask is inline with its
 * spec as provenance.
 */
export function recipePreparation(plan, { source = null, size = null, mask = null } = {}) {
  const { mode } = plan;
  const assets = source ? [{ role: 'source', mimeType: source.mimeType, ref: hostReference(source), sha256: source.sha256, byteLength: source.byteLength }] : [];
  if (mode === 't2i') return { mode, authored: { params: generationParams(plan, plan.size), charCaptions: plan.charCaptions }, assets };
  if (mode === 'i2i') return { mode, authored: { params: generationParams(plan, size), charCaptions: plan.charCaptions, i2iParams: { strength: plan.i2i.strength, noise: 0, extraNoiseSeed: plan.i2i.extraNoiseSeed ?? 0 }, i2iSizeMode: 'manual' }, assets };
  if (mode === 'enhance') return { mode, authored: { params: generationParams(plan, size), charCaptions: plan.charCaptions, i2iParams: { extraNoiseSeed: plan.enhance.extraNoiseSeed ?? 0 }, enhanceMagnitude: plan.enhance.magnitude, enhanceScale: plan.enhance.scale }, assets };
  if (mode === 'inpaint') return { mode, authored: { params: {}, inpaintModel: inpaintModelFor(plan.generation.model), inpaintStrength: plan.inpaint.strength, inpaintRecipe: generationParams(plan, size) },
    assets: [...assets, { role: 'mask', mimeType: 'image/png', data: mask.png.toString('base64'), provenance: mask.provenance }] };
  if (mode === 'upscale') return { mode, authored: { params: {}, upscaleScale: 2 }, assets };
  return { mode, authored: { params: {}, directorTool: plan.director.tool, augmentOptions: { ...plan.director.options } }, assets };
}

/** Strict t2i preparation (mode t2i only): the exact {mode, authored, assets} sent to put_queue_recipe. */
export function t2iPreparation(args) {
  if (record(args) && args.mode !== 't2i' && RECIPE_MODES.includes(args.mode)) invalid('t2iPreparation builds mode t2i only.');
  return recipePreparation(recipePlan(args));
}

/** Fields whose stored value differs from what this tool sent (after the host's own normalization). */
export function authoredDifferences(preparation, snapshot) {
  const stored = snapshot?.reviewInput?.authored ?? {}, sent = preparation.authored, mode = preparation.mode;
  const differences = [];
  if (seeded(mode)) {
    const key = mode === 'inpaint' ? 'inpaintRecipe' : 'params', expected = sent[key], actual = record(stored[key]) ? stored[key] : {};
    for (const [field, value] of Object.entries(expected)) if (!sameValue(actual[field], value)) differences.push(`${key}.${field}`);
    for (const [field, value] of Object.entries(FIXED_PARAM_DEFAULTS)) if (actual[field] !== value) differences.push(`${key}.${field}`);
    // Any other stored parameter (preservePromptText, metadataReplay or anything new) was not requested.
    const known = new Set([...Object.keys(expected), ...Object.keys(FIXED_PARAM_DEFAULTS)]);
    for (const field of Object.keys(actual)) if (!known.has(field) && actual[field] !== undefined) differences.push(`${key}.${field}`);
    const characters = sent.charCaptions ?? [], storedCharacters = Array.isArray(stored.charCaptions) ? stored.charCaptions : [];
    if (storedCharacters.length !== characters.length) differences.push('charCaptions.length');
    else characters.forEach((character, index) => {
      for (const field of ['prompt', 'useCoords', 'x', 'y']) if (!sameValue(storedCharacters[index]?.[field], character[field])) differences.push(`charCaptions.${index}.${field}`);
      if ((storedCharacters[index]?.negativePrompt ?? '') !== (character.negativePrompt ?? '')) differences.push(`charCaptions.${index}.negativePrompt`);
    });
  }
  if ((stored.modelMode ?? 'anime') !== 'anime') differences.push('modelMode');
  for (const key of ['vibeImages', 'preciseReferences']) if (Array.isArray(stored[key]) && stored[key].length) differences.push(key);
  for (const path of MODE_SCALARS[mode] ?? []) if (!sameValue(valueAt(stored, path), valueAt(sent, path))) differences.push(path);
  return differences;
}

// ------------------------------------------------------------------ host reply checks
/**
 * Structural checks of a host recipe snapshot, reimplemented here so that this module loads nothing of the host. Image
 * bytes are omitted on request (assetData:"omit"): an asset without data keeps only its sha256 claim; one with
 * data must match it. A preview snapshot has no identity (workspaceId and revision null).
 */
function validateSnapshotShape(snapshot, { preview = false } = {}) {
  const input = snapshot?.reviewInput;
  const identity = preview ? snapshot?.workspaceId === null && snapshot.revision === null
    : typeof snapshot?.workspaceId === 'string' && Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0;
  if (snapshot?.schemaVersion !== 1 || !identity || !MODES.includes(snapshot.mode) || input?.mode !== snapshot.mode || !record(input.authored) || !Object.hasOwn(input, 'effective')
    || !Array.isArray(input.assets) || !Array.isArray(input.unusedInputs) || !['ready', 'blocked'].includes(input.readiness?.status) || !Array.isArray(input.readiness.issues)) invalidResponse('The host returned an incomplete recipe snapshot.');
  if (input.readiness.status === 'ready' && !record(input.effective)) invalidResponse('A ready recipe must contain its actual effective input.');
  const roles = new Set();
  for (const asset of input.assets) {
    if (typeof asset?.role !== 'string' || roles.has(asset.role) || !IMAGE_TYPES.has(asset.mimeType) || !HASH.test(asset.sha256 ?? '')
      || (asset.data !== undefined && (typeof asset.data !== 'string' || !asset.data.length || createHash('sha256').update(Buffer.from(asset.data, 'base64')).digest('hex') !== asset.sha256)))
      invalidResponse('The host returned an incomplete or inconsistent recipe image.');
    roles.add(asset.role);
  }
}

/** A stored reference: history {kind, id, revision, assetId}; study {kind, id, revision} with no assetId (issue #2). */
const referenceShape = ref => record(ref) && typeof ref.id === 'string' && Number.isSafeInteger(ref.revision)
  && (ref.kind === 'history' ? typeof ref.assetId === 'string' : ref.kind === 'study' && !Object.hasOwn(ref, 'assetId'));

/** assetRefs / assetBytes / assetProvenance (present only when there is something to report) must be well formed and agree with the snapshot. */
function validateAssetDetails(result) {
  const assets = result.snapshot.reviewInput.assets;
  if (result.assetRefs !== undefined) {
    if (!Array.isArray(result.assetRefs) || result.assetRefs.some(item => !record(item) || item.role !== 'source' || !referenceShape(item.ref)
      || !HASH.test(item.sha256 ?? '') || !Number.isSafeInteger(item.byteLength) || item.byteLength < 1 || assets.find(asset => asset.role === item.role)?.sha256 !== item.sha256))
      invalidResponse('The host returned an inconsistent recipe source reference.');
  }
  if (result.assetBytes !== undefined && (!record(result.assetBytes) || Object.values(result.assetBytes).some(value => !Number.isSafeInteger(value) || value < 0))) invalidResponse('The host returned invalid recipe asset sizes.');
  if (result.assetProvenance !== undefined && (!record(result.assetProvenance) || Object.values(result.assetProvenance).some(value => !record(value)))) invalidResponse('The host returned invalid recipe asset provenance.');
}

/** A capture without canvas.draftId while the canvas holds an unapplied draft (host notice unappliedDraftId, not stored with the recipe). */
function unappliedDraftWarning(reply, canvas) {
  const draftId = reply?.unappliedDraftId;
  if (canvas.draftId !== undefined || typeof draftId !== 'string' || !draftId) return [];
  const named = /^[\w.:-]{1,120}$/.test(draftId) ? ` (${draftId})` : '';
  return [{ code: 'canvas_draft_not_captured', message: `The canvas has an unapplied draft${named}; this recipe captured the visible canvas state${canvas.patch !== undefined ? ' with your detached patch' : ''}, not that draft. To use the draft, capture again with canvas.draftId, or apply it (apply_edit) and capture the new revision.` }];
}

/** A canvas recipe's origin as the host stores it (client queue-recipe-service CanvasOrigin). */
const canvasOriginShape = value => record(value) && typeof value.workspaceId === 'string' && Boolean(value.workspaceId) && Number.isSafeInteger(value.revision) && value.revision >= 0
  && (value.draftId === null || (typeof value.draftId === 'string' && Boolean(value.draftId))) && typeof value.patched === 'boolean' && typeof value.capturedAt === 'string' && Number.isFinite(Date.parse(value.capturedAt));
function validateCanvasOrigin(result) {
  if (result.canvasOrigin !== undefined && !canvasOriginShape(result.canvasOrigin)) invalidResponse('The host returned an invalid canvas origin.');
}

const recomputedInputHash = snapshot => { const { assets, ...input } = snapshot.reviewInput; return recipeHash({ ...input, assets: assets.map(({ data: _data, ...asset }) => asset) }); };

/** Host reply validation (identity, recomputed inputHash), first ported from the former enqueue core. Blocked recipes are allowed here. */
export function validateRecipeResult(result, expected) {
  if (!record(result) || typeof result.recipeId !== 'string' || !UUID.test(result.recipeId) || !Number.isSafeInteger(result.recipeRevision) || result.recipeRevision < 1 || typeof result.inputHash !== 'string' || !HASH.test(result.inputHash)
    || (expected && (result.recipeId !== expected.recipeId || result.recipeRevision !== expected.recipeRevision))) invalidResponse('The independent recipe identity or revision does not match.');
  const snapshot = result.snapshot;
  validateSnapshotShape(snapshot);
  if (snapshot.workspaceId !== `recipe:${result.recipeId}` || snapshot.revision !== result.recipeRevision || (snapshot.draftId ?? null) !== null)
    invalidResponse('The recipe snapshot has a different source identity or revision.');
  if (recomputedInputHash(snapshot) !== result.inputHash) invalidResponse('The independent recipe input hash does not match its actual snapshot.');
  validateAssetDetails(result);
  validateCanvasOrigin(result);
  return result;
}

const PREVIEW_IMAGE_LIMITS = { longEdge: 768, bytes: 1024 * 1024 };
/** A write-free preview reply: no identity, a consistent snapshot, and an optional bounded WebP overlay. */
export function validatePreviewResult(result) {
  if (!record(result) || result.preview !== true || result.saved !== false || result.recipeId !== null || result.recipeRevision !== null || typeof result.inputHash !== 'string' || !HASH.test(result.inputHash))
    invalidResponse('The host preview is not a write-free dry run.');
  validateSnapshotShape(result.snapshot, { preview: true });
  // A preview has no identity and no lineage: a reply naming a recipe source or a continuation is not a preview.
  if ((result.snapshot.draftId ?? null) !== null || result.source !== undefined || result.continuation !== undefined) invalidResponse('The host preview carries a recipe identity.');
  if (recomputedInputHash(result.snapshot) !== result.inputHash) invalidResponse('The preview input hash does not match its snapshot.');
  validateAssetDetails(result);
  validateCanvasOrigin(result);
  const image = result.previewImage ?? null;
  if (image !== null) {
    const bytes = record(image) && typeof image.data === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(image.data) ? Buffer.from(image.data, 'base64') : null;
    if (!bytes || image.mimeType !== 'image/webp' || bytes.length !== image.byteLength || bytes.length > PREVIEW_IMAGE_LIMITS.bytes || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP'
      || createHash('sha256').update(bytes).digest('hex') !== image.sha256 || ![image.width, image.height].every(side => Number.isSafeInteger(side) && side > 0 && side <= PREVIEW_IMAGE_LIMITS.longEdge)
      || !record(image.cells) || !Number.isSafeInteger(image.cells.selected) || !Number.isSafeInteger(image.cells.total)) invalidResponse('The host preview image is not a bounded WebP overlay.');
  }
  return result;
}

/** canvas: a capture of the live canvas (prepare_recipe {canvas}); plain: prepared from inline fields. */
export function recipeLineage(result) {
  return result.canvasOrigin ? 'canvas' : 'plain';
}

/** One provider request per image: seeded modes also check the request's n_samples. */
const oneSample = snapshot => {
  const effective = snapshot.reviewInput.effective;
  if (!effective) return true;
  return effective.sampling?.sampleCount === 1 && (!seeded(snapshot.mode) || effective.request?.parameters?.n_samples === 1);
};

/**
 * Identity problems of a put/preview reply against what was sent: the stored source must be the registered
 * original (same reference, sha256) and the stored mask the one built here.
 */
function imageIdentityProblems(result, source, mask) {
  const problems = [], assets = result.snapshot.reviewInput.assets;
  if (source) {
    const stored = assets.find(asset => asset.role === 'source'), ref = result.assetRefs?.find(item => item.role === 'source');
    if (stored?.sha256 !== source.sha256) problems.push('source.sha256');
    // The size rules above were checked against the library's metadata; the host must have decoded the same size.
    if (stored && (stored.width !== source.width || stored.height !== source.height)) problems.push('source.size');
    // The stored reference must be the requested one, kind included (a study reference carries no assetId).
    if (!ref || !sameValue(ref.ref, hostReference(source)) || ref.sha256 !== source.sha256 || ref.byteLength !== source.byteLength) problems.push('source.ref');
  }
  if (mask && assets.find(asset => asset.role === 'mask')?.sha256 !== mask.sha256) problems.push('mask.sha256');
  return problems;
}

// ------------------------------------------------------------------ readback
function suffixAfter(full, prefix) {
  if (typeof full !== 'string' || typeof prefix !== 'string') return null;
  if (prefix === '') return full;
  if (full === prefix) return '';
  return full.startsWith(`${prefix}, `) ? full.slice(prefix.length + 2) : null;
}

/** full without a trailing literal segment, or null when it does not end with that segment. */
function withoutTrailing(full, segment) {
  if (typeof full !== 'string') return null;
  if (full === segment) return '';
  return full.endsWith(`, ${segment}`) ? full.slice(0, -(segment.length + 2)) : null;
}

const sizeOf = asset => asset ? { width: asset.width ?? null, height: asset.height ?? null } : null;
const sameSize = (a, b) => a && b && a.width === b.width && a.height === b.height;

/** The generation view (t2i, i2i, enhance, inpaint): prompts and sampling read off the builder's own request. */
function generationView(input) {
  const authored = input.authored ?? {}, mode = input.mode, effectiveInput = input.effective;
  const source = input.recipeScope === 'independent_inpaint' ? authored.inpaintRecipe ?? {}
    : input.recipeScope === 'legacy_inpaint' ? { ...(authored.params ?? {}), positivePrompt: authored.inpaintPositivePrompt ?? '' } : authored.params ?? {};
  const request = effectiveInput?.request ?? null, parameters = request?.parameters ?? {};
  const literal = source.promptAssemblyVersion === 1 || source.preservePromptText === true;
  const base = [source.stylePrompt ?? '', source.positivePrompt ?? ''].filter(value => value !== '').join(', ');
  // A V5 transparent-background request appends its own text after the quality text; separate it first.
  const transparentSent = parameters.tag_hint_transparent_background === true;
  const beforeTransparent = literal && request ? (transparentSent ? withoutTrailing(request.input, TRANSPARENT_BACKGROUND_TEXT) : request.input) : null;
  const qualityText = beforeTransparent === null ? null : suffixAfter(beforeTransparent, base);
  // Medium sends only its fixed Heavy UC (no negative prompt of the recipe), so all of it is the preset's text.
  const medium = MEDIUM_MODELS.includes(request?.model);
  const ucText = medium ? parameters.negative_prompt ?? null : literal && request ? suffixAfter(parameters.negative_prompt, source.negativePrompt ?? '') : null;
  const positives = parameters.v4_prompt?.caption?.char_captions ?? [], negatives = parameters.v4_negative_prompt?.caption?.char_captions ?? [];
  const authoredCharacters = Array.isArray(authored.charCaptions) ? authored.charCaptions : [];
  const asset = role => role ? input.assets.find(item => item.role === role) : undefined;
  const sourceAsset = asset('source'), requestSource = asset(effectiveInput?.sourceRole), requestMask = asset(effectiveInput?.maskRole);
  const i2iLike = mode === 'i2i' || mode === 'enhance';
  const effective = request && {
    model: request.model, width: parameters.width, height: parameters.height, steps: parameters.steps, cfgScale: parameters.scale, cfgRescale: parameters.cfg_rescale,
    sampler: parameters.sampler, noiseSchedule: parameters.noise_schedule, seed: parameters.seed ?? null, seedPolicy: effectiveInput.sampling?.seedPolicy ?? null, nSamples: parameters.n_samples,
    positivePrompt: request.input,
    automaticQuality: { preset: parameters.qualityPresetId ?? null, appendedText: qualityText, derivedFromBuilderOutput: qualityText !== null },
    negativePrompt: parameters.negative_prompt,
    ucPreset: { preset: parameters.ucPreset ?? null, text: ucText, derivedFromBuilderOutput: ucText !== null, ...(medium ? { fixedByEffort: true } : {}) },
    effort: medium
      ? { level: 'medium', requestModel: request.model, fixed: { steps: parameters.steps, sampler: parameters.sampler, cfgRescale: parameters.cfg_rescale, ucPreset: 'Heavy', undesiredContent: parameters.negative_prompt ?? null, nsfwPrefixed: typeof parameters.negative_prompt === 'string' && parameters.negative_prompt.startsWith('nsfw'), characterNegativePrompts: 'not sent', tagHintUcPreset: parameters.tag_hint_uc_preset ?? null } }
      : { level: 'high', requestModel: request.model },
    transparentBackground: { enabled: transparentSent, straightAlpha: parameters.straight_alpha === true, appendedText: transparentSent && beforeTransparent !== null ? TRANSPARENT_BACKGROUND_TEXT : null },
    useCoords: parameters.use_coords ?? false,
    characters: positives.map((character, index) => ({ index, prompt: character.char_caption, negativePrompt: negatives[index]?.char_caption ?? '', center: character.centers?.[0] ?? null })),
    ...(authoredCharacters.length > positives.length && isV4Plus(request.model ?? '') ? { charactersNotSent: authoredCharacters.length - positives.length } : {}),
    ...(i2iLike ? { i2i: { strength: parameters.strength ?? null, noise: parameters.noise ?? null, extraNoiseSeedPolicy: effectiveInput.sampling?.extraNoiseSeedPolicy ?? null, extraNoiseSeed: parameters.extra_noise_seed ?? null } } : {}),
    ...(mode === 'enhance' ? { enhance: { magnitude: authored.enhanceMagnitude ?? null, scale: authored.enhanceScale ?? null, derivedStrength: parameters.strength ?? null,
      ...(parameters.upscaled_enhance === true ? { max: true, upscaledEnhance: true, expectedOutput: effectiveInput.sampling?.processing ? { width: effectiveInput.sampling.processing.outputWidth, height: effectiveInput.sampling.processing.outputHeight } : null, costsAnlasOnOpus: true } : {}) },
    processing: effectiveInput.sampling?.processing ?? null } : {}),
    ...(mode === 'inpaint' ? { inpaint: { model: request.model, strength: parameters.inpaintImg2ImgStrength ?? null, width: parameters.width, height: parameters.height } } : {}),
    ...(mode !== 't2i' && requestSource ? { requestSource: { ...sizeOf(requestSource), sha256: requestSource.sha256 }, sourceResized: sameSize(sizeOf(sourceAsset), sizeOf(requestSource)) ? null : { from: sizeOf(sourceAsset), to: sizeOf(requestSource) } } : {}),
    ...(requestMask ? { requestMask: { ...sizeOf(requestMask), sha256: requestMask.sha256 } } : {}),
  };
  const extraNoiseSeed = authored.i2iParams?.extraNoiseSeed > 0 ? authored.i2iParams.extraNoiseSeed : null;
  const modeAuthored = mode === 'i2i' ? { strength: authored.i2iParams?.strength ?? null, extraNoiseSeed }
    : mode === 'enhance' ? { magnitude: authored.enhanceMagnitude ?? null, scale: authored.enhanceScale ?? null, extraNoiseSeed }
      : mode === 'inpaint' ? { inpaintModel: authored.inpaintModel ?? null, strength: authored.inpaintStrength ?? null } : {};
  return {
    source, effective: effective || null, request, authoredCharacters,
    authored: {
      model: source.model, width: source.width, height: source.height, steps: source.steps, cfgScale: source.cfgScale, cfgRescale: source.cfgRescale, sampler: source.sampler,
      noiseSchedule: source.noiseSchedule, ucPreset: source.ucPreset, qualityPreset: source.qualityPreset, transparentBackground: source.transparentBackground === true, seed: source.seedMode === 'random' ? null : source.seed ?? null,
      effort: source.effort === 'medium' ? 'medium' : 'high',
      stylePrompt: source.stylePrompt, positivePrompt: source.positivePrompt, negativePrompt: source.negativePrompt,
      characters: authoredCharacters.map(({ prompt, negativePrompt, useCoords, x, y }) => ({ prompt, negativePrompt: negativePrompt ?? '', useCoords, x, y })),
      ...modeAuthored,
    },
  };
}

/** The post-processing view (upscale, director): no prompt, no seed; the request and the processing sizes. */
function postprocessView(input) {
  const authored = input.authored ?? {}, mode = input.mode, effectiveInput = input.effective, request = effectiveInput?.request ?? null;
  const processing = effectiveInput?.sampling?.processing ?? null, options = record(authored.augmentOptions) ? authored.augmentOptions : {};
  const tool = authored.directorTool ?? null;
  const used = { defry: options.defry ?? null, ...(tool === 'colorize' ? { colorizePrompt: options.colorizePrompt ?? '' } : {}), ...(tool === 'emotion' ? { emotion: options.emotion ?? null, emotionLevel: options.emotionLevel ?? null } : {}) };
  const sizes = processing && { input: { width: processing.inputWidth, height: processing.inputHeight, resized: processing.resizedInput === true }, output: { width: processing.outputWidth, height: processing.outputHeight } };
  let effective = null;
  if (request && mode === 'upscale') effective = { model: request.model ?? null, scale: processing ? processing.outputWidth / processing.inputWidth : null, ...sizes, seedPolicy: effectiveInput.sampling?.seedPolicy ?? null, sampleCount: effectiveInput.sampling?.sampleCount ?? null };
  if (request && mode === 'director') {
    const [emotion, level] = typeof request.prompt === 'string' && request.req_type === 'emotion' ? request.prompt.split(';;') : [];
    effective = { tool: request.req_type ?? null, options: { defry: request.defry ?? null, ...(request.req_type === 'colorize' ? { colorizePrompt: request.prompt ?? '' } : {}), ...(request.req_type === 'emotion' ? { emotion: emotion ?? null, emotionLevel: level === undefined ? null : Number(level) } : {}) },
      ...sizes, ...(sizes ? { input: { ...sizes.input, alphaFlattened: processing.alphaFlattened === true } } : {}), seedPolicy: effectiveInput.sampling?.seedPolicy ?? null, sampleCount: effectiveInput.sampling?.sampleCount ?? null };
  }
  return { effective, request, authored: mode === 'upscale' ? { scale: authored.upscaleScale ?? null } : { tool, ...used } };
}

/** The source by history or study identity (from assetRefs) with the stored original's facts; an embedded source has no identity. */
function sourceReadback(result) {
  const input = result.snapshot.reviewInput, asset = input.assets.find(item => item.role === 'source');
  if (!asset || input.mode === 't2i') return undefined;
  const ref = result.assetRefs?.find(item => item.role === 'source');
  const identity = !ref ? { kind: 'embedded' } : ref.ref.kind === 'study' ? { kind: 'study', studyId: ref.ref.id, studyRevision: ref.ref.revision }
    : { kind: 'history', historyId: ref.ref.id, historyRevision: ref.ref.revision, assetId: ref.ref.assetId };
  return { ...identity,
    sha256: asset.sha256, mimeType: asset.mimeType, width: asset.width ?? null, height: asset.height ?? null, byteLength: ref?.byteLength ?? result.assetBytes?.source ?? null };
}

/**
 * Compact view of the effective input the host builder actually produced, plus
 * the full effective request. Automatic quality and UC preset text are read off
 * the builder's own output (the text appended after the authored prompt), not
 * recomputed from a local table. Image modes add the source (history or study
 * identity, sha256, size) and, for inpaint, the mask (cells, layers and spec from its
 * stored provenance; `built` supplies the full spec at prepare/preview time).
 */
export function recipeReadback(result, { built = null } = {}) {
  const snapshot = result.snapshot, input = snapshot.reviewInput, mode = snapshot.mode;
  const view = seeded(mode) ? generationView(input) : postprocessView(input);
  const lineage = recipeLineage(result);
  const source = sourceReadback(result), maskAsset = mode === 'inpaint' ? input.assets.find(item => item.role === 'mask') : undefined;
  return {
    recipeId: result.recipeId, recipeRevision: result.recipeRevision, inputHash: result.inputHash, mode, lineage,
    ready: input.readiness.status === 'ready', readiness: input.readiness,
    warnings: readbackWarnings({ mode, input, view }),
    authored: view.authored,
    effective: view.effective,
    effectiveRequest: view.request,
    unusedInputs: input.unusedInputs,
    assets: input.assets.map(({ data: _data, ...asset }) => asset),
    ...(source ? { source } : {}),
    ...(maskAsset ? { mask: maskReadback(maskAsset, result.assetProvenance?.mask, built) } : {}),
    ...(result.canvasOrigin ? { canvas: { workspaceId: result.canvasOrigin.workspaceId, revision: result.canvasOrigin.revision, draftId: result.canvasOrigin.draftId, patched: result.canvasOrigin.patched, capturedAt: result.canvasOrigin.capturedAt } } : {}),
  };
}

/**
 * Facts about the actual effect that are easy to miss. Empty preset text is the
 * real behaviour of that preset on that model (for example ucPreset 2 on V4 Full
 * or any preset on Furry V3), not a readback failure.
 */
function readbackWarnings({ mode, input, view }) {
  const warnings = [], { effective } = view;
  if (!seeded(mode)) {
    if (effective?.input?.resized) warnings.push({ code: 'source_downscaled', message: `The host downscales the source to ${effective.input.width}×${effective.input.height} (at most ${RECIPE_LIMITS.postprocessInputPixels} pixels) before ${mode}.` });
    return warnings;
  }
  const { source } = view, authored = input.authored ?? {}, model = effective?.model ?? source.model ?? 'this model';
  if (effective) {
    const quality = effective.automaticQuality, uc = effective.ucPreset;
    if (quality.appendedText === null || uc.text === null) warnings.push({ code: 'readback_not_derived', message: 'The automatic quality or UC text could not be separated from the builder output (legacy prompt assembly or a mode prefix); compare the full positivePrompt and negativePrompt instead.' });
    if (quality.preset !== 'none' && quality.appendedText === '') warnings.push({ code: 'quality_preset_adds_nothing', message: `qualityPreset ${quality.preset} adds no quality text on ${model}; this is the actual effect of that preset on this model.` });
    if (uc.preset !== 3 && uc.text === '') warnings.push({ code: 'uc_preset_adds_nothing', message: `ucPreset ${uc.preset} adds no UC text on ${model}; the negative prompt is only what was written. This is the actual effect of that preset on this model.` });
    if (effective.charactersNotSent) warnings.push({ code: 'characters_not_sent', message: `${effective.charactersNotSent} stored character(s) exceed what ${model} sends; the builder drops them from the request.` });
    if (source.transparentBackground === true && !effective.transparentBackground.enabled) warnings.push({ code: 'transparent_background_not_sent', message: `The recipe asks for a transparent background, but the builder does not send it on ${model} (V5 only); the image will have a normal background.` });
    // Medium effort (canvas captures and stored recipes): what the recipe holds but Medium does not send.
    if (effective.effort?.level === 'medium') {
      const authoredCharacters = Array.isArray(authored.charCaptions) ? authored.charCaptions : [];
      const replaced = [['steps', source.steps, effective.steps], ['sampler', source.sampler, effective.sampler], ['cfgRescale', source.cfgRescale ?? 0, effective.cfgRescale], ['ucPreset', source.ucPreset, effective.ucPreset.preset]]
        .filter(([, from, to]) => from !== undefined && from !== to).map(([field, from, to]) => `${field} ${JSON.stringify(from)} → ${JSON.stringify(to)}`);
      if (source.negativePrompt) replaced.push('negativePrompt (not sent)');
      if (mode !== 'inpaint' && authoredCharacters.some(character => character?.negativePrompt)) replaced.push('character negativePrompt (not sent)');
      if (replaced.length) warnings.push({ code: 'effort_medium_fixed', message: `effort medium runs ${effective.effort.requestModel} with fixed steps 14, Euler Ancestral, no CFG rescale and the Heavy UC only; the recipe's ${replaced.join(', ')} are replaced.` });
    } else if (source.effort === 'medium' && mode !== 'enhance') warnings.push({ code: 'effort_not_applied', message: `The recipe asks for effort medium, but ${model} has no Medium effort (only ${EFFORT_MODEL}${mode === 'inpaint' ? "'s inpainting model" : ''}); it runs on High.` });
    if (mode === 'enhance' && effective.enhance?.max) {
      const out = effective.enhance.expectedOutput;
      if (effective.sourceResized) { const { from, to } = effective.sourceResized; warnings.push({ code: 'enhance_max_source_adjusted', from, to, message: `Max✨ sends the source at its own size, 64-aligned and under ${Math.floor(MAX_ENHANCE_INPUT_LIMIT)} pixels: ${from.width}×${from.height} is sent as ${to.width}×${to.height}.` }); }
      warnings.push({ code: 'enhance_max_paid', expectedOutput: out, message: `Enhance Max✨ sends the source at ${effective.width}×${effective.height} with upscaled_enhance and returns about ${out ? `${out.width}×${out.height}` : '2×'} (at most about 3.1 MP; the saved image has the size NovelAI returns); it costs Anlas on Opus too.` });
    }
    if (mode === 'i2i' && effective.sourceResized) {
      const { from, to } = effective.sourceResized;
      warnings.push({ code: 'source_resized_for_i2i', from, to, message: `The source ${from.width}×${from.height} is resized (stretched, not cropped) to ${to.width}×${to.height} for image-to-image; their aspect ratios differ by ${(aspectDeviation(to.width, to.height, from.width, from.height) * 100).toFixed(1)}%.` });
    }
  }
  const params = record(source) ? source : {};
  const unexposed = [...Object.entries(UNEXPOSED_DEFAULTS).filter(([key, value]) => params[key] !== undefined && params[key] !== value).map(([key]) => `params.${key}`),
    ...['preservePromptText', 'metadataReplay'].filter(key => params[key] !== undefined).map(key => `params.${key}`),
    ...((authored.modelMode ?? 'anime') !== 'anime' ? ['modelMode'] : [])];
  if (unexposed.length) warnings.push({ code: 'unexposed_inputs', message: `This recipe uses inputs prepare_recipe cannot set: ${unexposed.join(', ')}.` });
  return warnings;
}

// ------------------------------------------------------------------ enqueue plan
/** Model-facing requestKey -> host key. Hashed, so no argument can reach any other key namespace. */
const SCOPE_HASH = recipeHash(DISPATCH_SCOPE).slice(0, 24);
export const mcpHostRequestKey = requestKey => `${HOST_REQUEST_KEY_PREFIX}${SCOPE_HASH}-${recipeHash(requestKeyOf(requestKey)).slice(0, 64)}`;

export function normalizeEnqueue(args) {
  exactKeys(args, ['requestKey', 'intervalSeconds', 'items', 'historyGroup', 'fileNamePrefix'], 'enqueue_recipes');
  const requestKey = requestKeyOf(args.requestKey);
  if (args.historyGroup !== undefined && !validHistoryGroupName(args.historyGroup)) invalid(`historyGroup must be 1–${QUEUE_HISTORY_GROUP_MAX} UTF-16 code units (an emoji counts 2) without control characters, bidi, zero-width or stray joiner/tag characters, surrounding whitespace, a leading or trailing dot, or a Windows device name (CON, NUL, COM1…).`);
  if (args.fileNamePrefix !== undefined && !validFileNamePrefix(args.fileNamePrefix)) invalid(`fileNamePrefix must be 1–${QUEUE_FILE_PREFIX_MAX} UTF-16 code units (an emoji counts 2) without whitespace, control, bidi, zero-width or stray joiner/tag characters or path characters (\\ / : * ? " < > |), must not start with "." or "-" and must not be a Windows device name.`);
  const output = args.historyGroup === undefined && args.fileNamePrefix === undefined ? undefined
    : { ...(args.historyGroup !== undefined ? { historyGroup: args.historyGroup } : {}), ...(args.fileNamePrefix !== undefined ? { fileNamePrefix: args.fileNamePrefix } : {}) };
  const intervalSeconds = args.intervalSeconds ?? 0;
  numberIn(intervalSeconds, 0, 60, 'intervalSeconds');
  if (!Array.isArray(args.items) || !args.items.length || args.items.length > MAX_QUEUE_ITEMS) invalid(`items must list 1–${MAX_QUEUE_ITEMS} recipes.`);
  const items = [], refs = new Map();
  args.items.forEach((item, index) => {
    const label = `items[${index}]`;
    exactKeys(item, ['recipeId', 'recipeRevision', 'inputHash', 'count', 'seeds'], label);
    if (typeof item.recipeId !== 'string' || !UUID.test(item.recipeId)) invalid(`${label}.recipeId must be a recipe UUID.`);
    integerIn(item.recipeRevision, 1, Number.MAX_SAFE_INTEGER, `${label}.recipeRevision`);
    if (typeof item.inputHash !== 'string' || !HASH.test(item.inputHash)) invalid(`${label}.inputHash must be the recipe's 64-hex inputHash.`);
    const count = item.count ?? item.seeds?.length ?? 1;
    integerIn(count, 1, MAX_QUEUE_ITEMS, `${label}.count`);
    if (item.seeds !== undefined) {
      if (!Array.isArray(item.seeds) || item.seeds.length !== count) invalid(`${label}.seeds must list exactly count seeds.`);
      item.seeds.forEach((seed, seedIndex) => integerIn(seed, 0, MAX_QUEUE_SEED, `${label}.seeds[${seedIndex}]`));
    }
    const key = `${item.recipeId}:${item.recipeRevision}`, prior = refs.get(key);
    if (prior && prior.inputHash !== item.inputHash) invalid(`${label} repeats recipe ${key} with a different inputHash.`);
    // Per recipe: images without explicit seeds, all images, list entries and whether any entry gave seeds
    // (upscale/director recipes allow one entry, one image, no seeds; known only once the recipe is read).
    const ref = prior ?? { recipeId: item.recipeId, recipeRevision: item.recipeRevision, inputHash: item.inputHash, unseeded: 0, images: 0, entries: 0, seeded: false };
    ref.images += count; ref.entries += 1;
    if (item.seeds === undefined) ref.unseeded += count; else ref.seeded = true;
    refs.set(key, ref);
    for (let seedIndex = 0; seedIndex < count; seedIndex++) items.push({ recipeId: item.recipeId, recipeRevision: item.recipeRevision, inputHash: item.inputHash, ...(item.seeds ? { seed: item.seeds[seedIndex] } : {}) });
  });
  if (items.length > MAX_QUEUE_ITEMS) invalid(`The expanded plan has ${items.length} images; one enqueue takes at most ${MAX_QUEUE_ITEMS} (and at most the client's per-enqueue setting, default 20).`);
  return { requestKey, intervalSeconds, items, refs: [...refs.values()], ...(output ? { output } : {}) };
}

/**
 * Estimated frozen input of one enqueue from the recipes' raw asset sizes: the host freezes one snapshot when
 * every image comes from the same recipe, otherwise one per image, each carrying source and mask as base64.
 */
export function frozenInputEstimate(items, assetBytesByRecipe) {
  const base64 = bytes => Math.ceil(bytes / 3) * 4;
  const perRecipe = key => ['source', 'mask'].reduce((sum, role) => sum + base64(assetBytesByRecipe.get(key)?.[role] ?? 0), 0);
  const keys = items.map(item => `${item.recipeId}:${item.recipeRevision}`);
  return new Set(keys).size === 1 ? perRecipe(keys[0]) : keys.reduce((sum, key) => sum + perRecipe(key), 0);
}

/** Same acceptance identity as the former enqueue core's queued acceptance check, plus the requested output (absent on both sides when not asked for). */
export function acceptanceMatches(batch, hostArgs) {
  return record(batch) && typeof batch.batchId === 'string' && Boolean(batch.batchId) && batch.execution === 'queued' && batch.requestKey === hostArgs.requestKey
    && batch.count === hostArgs.items.length && batch.recipePlanHash === recipeHash(hostArgs.items) && batch.intervalSeconds === hostArgs.intervalSeconds
    && sameOutput(batch.output, hostArgs.output);
}
const sameOutput = (accepted, requested) => {
  const fields = value => record(value) ? [value.historyGroup ?? null, value.fileNamePrefix ?? null] : [null, null];
  return JSON.stringify(fields(accepted)) === JSON.stringify(fields(requested));
};

// ------------------------------------------------------------------ service
/**
 * `bridge` must be the guarded business bridge. Every host call is one of the
 * RECIPE_HOST_METHODS or, for an image recipe's source and alpha layers, the
 * RECIPE_SOURCE_HOST_METHODS read; nothing is retried. Per-process state is limited to
 * per-key serialization, the unknown-outcome hold and the settle-window clocks;
 * durable idempotency is the host receipt stored under the stable namespaced key.
 * Every elapsed-time decision of the settle window uses the monotonic clock
 * `monotonicNow` (milliseconds, default performance.now), so NTP adjustments and
 * manual wall-clock changes never make the window pass early; time the system
 * spends asleep does count toward the window (performance.now keeps running
 * through sleep on macOS). `now` is the
 * wall clock and is reserved for human-readable receipt timestamps; it never
 * decides a window. `now`, `monotonicNow` and `settleMs` exist only so tests can
 * inject time; tool arguments never reach them.
 */
export function createRecipeQueue({ bridge, now = Date.now, monotonicNow = () => performance.now(), settleMs = UNKNOWN_SETTLE_MS } = {}) {
  if (!bridge || typeof bridge.call !== 'function') throw new TypeError('A bridge client is required.');
  if (typeof now !== 'function' || typeof monotonicNow !== 'function' || !Number.isSafeInteger(settleMs) || settleMs < 0) throw new TypeError('Invalid settle clock.');
  // unresolved: keys whose last dispatch in this process had an unknown outcome (resend hold).
  // mismatched: revisions prepare_recipe reported as recipe_input_mismatch (enqueue warns, never blocks).
  // dispatchedAt / unknownSince: when this process last dispatched a key, and first saw it unknown with no batch.
  // seen: keys this process dispatched or saw unknown at least once (their not_found keeps the existing behaviour).
  // notFoundSince: first not_found for a key this process never dispatched nor saw unknown (restart / other process).
  // All three time maps hold monotonicNow() readings, never wall-clock times.
  // freed: keys whose latest dispatch was refused before any receipt (old client, history group) with no earlier
  // dispatch of this process still inside its settle window: lookup_enqueue says the key is free for any plan.
  const locks = new Map(), unresolved = new Set(), mismatched = new Map(), dispatchedAt = new Map(), unknownSince = new Map(), notFoundSince = new Map(), seen = new Set(), freed = new Set();
  const seconds = ms => Math.ceil(ms / 1000);
  /** Remaining settle time for a key, from this process's own dispatch and (optionally) its first unknown sighting. */
  const settleWait = (hostKey, time, firstUnknown) => {
    const sinceDispatch = dispatchedAt.has(hostKey) ? time - dispatchedAt.get(hostKey) : Infinity;
    const fromDispatch = Math.max(0, settleMs - sinceDispatch);
    return firstUnknown === undefined ? fromDispatch : Math.max(fromDispatch, settleMs - (time - firstUnknown));
  };
  const exclusive = (key, run) => {
    const next = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
    locks.set(key, next);
    const clear = () => { if (locks.get(key) === next) locks.delete(key); };
    next.then(clear, clear);
    return next;
  };
  // Every read asks the host to omit image bytes; a host that does not know assetData is too old (host_outdated).
  const readExact = async (ref, signal) => {
    let reply;
    try { reply = await bridge.call(RECIPE_HOST_METHODS.read, { recipeId: ref.recipeId, recipeRevision: ref.recipeRevision, assetData: 'omit' }, signal); }
    catch (error) { if (outdatedHost(error)) throw hostOutdated(error); throw error; }
    return validateRecipeResult(reply, ref);
  };
  const lookupHost = async (hostKey, signal) => {
    const result = await bridge.call(RECIPE_HOST_METHODS.lookup, { requestKey: hostKey }, signal);
    if (!record(result)) invalidResponse('The host returned an invalid request lookup.');
    if (result.batch !== null && result.batch !== undefined) {
      if (!record(result.batch) || result.batch.requestKey !== hostKey || result.batch.execution !== 'queued' || typeof result.batch.batchId !== 'string' || !result.batch.batchId) invalidResponse('The host returned a different queued batch for this request.');
      return { status: 'enqueued', batch: result.batch, receiptPersisted: result.status === 'accepted' };
    }
    if (result.status === 'rejected') return { status: 'rejected', error: { code: typeof result.error?.code === 'string' ? result.error.code : 'rejected', message: typeof result.error?.message === 'string' ? result.error.message : 'The host rejected this request.' } };
    if (result.status === 'unknown') return { status: 'unknown' };
    if (result.status === undefined) return { status: 'not_found' };
    return invalidResponse('The host returned an unknown request status.');
  };

  async function prepare(args, { signal } = {}) {
    const plan = recipePlan(args);
    if (plan.canvas) return captureCanvas(plan, signal);
    const { mode, updating } = plan;
    const expectedIdentity = updating ? { recipeId: args.recipeId, recipeRevision: args.expectedRevision + 1 } : { recipeId: null, recipeRevision: 1 };
    if (updating) {
      let current;
      try { current = await readExact({ recipeId: args.recipeId, recipeRevision: args.expectedRevision }, signal); }
      catch (error) {
        // The host rereads the current revision's source on every read; once it is gone or replaced,
        // that revision cannot be read, so it cannot be revised either.
        if (error instanceof BridgeError && (error.code === 'recipe_source_unavailable' || error.code === 'recipe_source_changed'))
          throw new BridgeError(error.code, `${error.message} This revision cannot be revised while its source is gone or changed. To use another source image, prepare a new recipe (without recipeId).`, { saved: false, putAttempted: false, ...hostDetailsOf(error) });
        throw error;
      }
      if (recipeLineage(current) !== 'plain' || current.snapshot.mode !== mode) invalid(`Only a plain ${mode} recipe (prepared from inline fields, not a canvas capture) can be revised with mode ${mode}; this one is ${recipeLineage(current) === 'plain' ? `a ${current.snapshot.mode} recipe` : `of ${recipeLineage(current)} lineage`}. Prepare a new recipe instead.`);
    }
    // Image modes: source metadata (thumbnail read), the size rules, then for inpaint the alpha originals and the mask.
    let source = null, size = null, built = null, provenance = null;
    if (plan.source) {
      source = await readSourceMetadata(bridge, plan.source, { signal });
      size = checkRecipeSource(plan, source);
      if (mode === 'inpaint') {
        built = buildMask(plan.mask.spec, { width: source.width, height: source.height, alphaImages: await readAlphaImages(bridge, plan.mask.alphaRefs, { signal }) });
        provenance = maskProvenance(built);
      }
    }
    const preparation = recipePreparation(plan, { source, size, mask: built && { png: built.png, provenance } });
    if (plan.preview) return previewRecipe({ plan, preparation, source, built, provenance, signal });
    const receipt = { putAttempted: true, generationSubmitted: false };
    let reply;
    // t2i keeps its original put; image recipes ask the host to omit image bytes from the reply.
    try { reply = await bridge.call(RECIPE_HOST_METHODS.put, { preparation, ...(updating ? { recipeId: args.recipeId, expectedRevision: args.expectedRevision } : {}), ...(mode === 't2i' ? {} : { assetData: 'omit' }) }, signal); }
    catch (error) {
      if (mode !== 't2i' && outdatedHost(error)) throw hostOutdated(error, { putAttempted: true, putOutcome: 'rejected' });
      if (error instanceof BridgeError && PUT_REJECTED.has(error.code)) throw new BridgeError(error.code, error.code === 'queue_storage_failed'
        ? putStorageRefusal(error)
        : error.code === 'recipe_source_busy' ? `${error.message} Nothing was saved; retry the same call later.` : error.message, { ...receipt, putOutcome: 'rejected', saved: false, ...hostDetailsOf(error) });
      throw new BridgeError('recipe_save_unknown', updating
        ? 'The recipe revision may or may not have been saved. Before any further save, call prepare_recipe once with the same recipeId, expectedRevision and fields: recipe_conflict means the earlier save landed as expectedRevision+1, so revise from expectedRevision+1 and enqueue only the identity that call returns; never resend automatically.'
        : 'The new recipe may or may not have been saved; the host assigns its ID, so an orphan cannot be looked up. Nothing was enqueued. Preparing again creates a separate recipe (an unused orphan is harmless but occupies host storage); never resend automatically.',
      { ...receipt, putOutcome: 'unknown', expectedIdentity, ...hostDetailsOf(error) });
    }
    let observed;
    try { observed = validateRecipeResult(reply); }
    catch (error) { throw new BridgeError('recipe_identity_unconfirmed', 'The host reply is not a complete, consistent recipe snapshot. Do not enqueue from it; prepare the recipe again and enqueue only an identity whose readback you checked.', { ...receipt, putOutcome: 'confirmed', reason: error.message }); }
    const observedIdentity = { recipeId: observed.recipeId, recipeRevision: observed.recipeRevision, inputHash: observed.inputHash };
    if (observed.recipeRevision !== expectedIdentity.recipeRevision || (updating && observed.recipeId !== args.recipeId) || recipeLineage(observed) !== 'plain' || observed.snapshot.mode !== mode)
      throw new BridgeError('recipe_identity_unconfirmed', 'The host saved an unexpected identity or revision. Do not adopt, enqueue or retry either reference automatically.', { ...receipt, putOutcome: 'confirmed', expectedIdentity, observedIdentity });
    const images = imageIdentityProblems(observed, source, built);
    if (images.length) throw new BridgeError('recipe_identity_unconfirmed', `The host stored a different image than this server sent (${images.join(', ')}). Do not enqueue this revision; prepare again.`, { ...receipt, putOutcome: 'confirmed', observedIdentity, fields: images });
    const differences = storedDifferences(preparation, observed, provenance);
    if (differences.length) mismatched.set(`${observed.recipeId}:${observed.recipeRevision}`, differences);
    if (differences.length) throw new BridgeError('recipe_input_mismatch', `The host stored different generation inputs than requested (${differences.join(', ')}). This revision was saved but must not be enqueued.`, { ...receipt, putOutcome: 'confirmed', observedIdentity, fields: differences });
    const readback = recipeReadback(observed, { built });
    return { ...readback, warnings: [...readback.warnings, ...(built?.warnings ?? []), ...plan.warnings], saved: true, generationSubmitted: false, next: nextStep(observed, mode) };
  }

  /** Stored-input comparison of a put or preview reply: authored fields, one sample, and the mask provenance. */
  function storedDifferences(preparation, observed, provenance) {
    const differences = authoredDifferences(preparation, observed.snapshot);
    if (!oneSample(observed.snapshot)) differences.push(seeded(preparation.mode) ? 'effective.n_samples' : 'effective.sampleCount');
    if (provenance && !sameValue(observed.assetProvenance?.mask, provenance)) differences.push('assetProvenance.mask');
    return differences;
  }

  /** Dry run through the host's write-free preview: nothing is saved, no revision or quota is used. */
  async function previewRecipe({ plan, preparation, source, built, provenance, signal }) {
    const details = { preview: true, saved: false, generationSubmitted: false };
    let reply;
    try { reply = await bridge.call(RECIPE_HOST_METHODS.preview, { preparation, assetData: 'omit' }, signal); }
    catch (error) {
      if (outdatedHost(error)) throw hostOutdated(error, { preview: true });
      if (error instanceof BridgeError) throw new BridgeError(error.code, `${error.message} This was a preview: nothing was saved.`, { ...details, ...hostDetailsOf(error) });
      throw error;
    }
    let observed;
    try { observed = validatePreviewResult(reply); }
    catch (error) { throw new BridgeError('invalid_response', 'The host preview is not a complete, consistent dry run. Nothing was saved; preview again or prepare without preview.', { ...details, reason: error.message }); }
    if (observed.snapshot.mode !== plan.mode) throw new BridgeError('invalid_response', 'The host previewed a different mode. Nothing was saved.', details);
    const images = imageIdentityProblems(observed, source, built);
    if (images.length) throw new BridgeError('recipe_identity_unconfirmed', `The host previewed a different image than this server sent (${images.join(', ')}). Nothing was saved.`, { ...details, fields: images });
    const differences = storedDifferences(preparation, observed, provenance);
    if (differences.length) throw new BridgeError('recipe_input_mismatch', `The host preview used different generation inputs than requested (${differences.join(', ')}). Nothing was saved.`, { ...details, fields: differences });
    return previewResponse(observed, built, plan.warnings);
  }

  /** The next step after a saved recipe, by readiness and mode. A canvas recipe cannot be revised: the canvas is captured again. */
  const nextStep = (observed, mode) => observed.snapshot.reviewInput.readiness.status !== 'ready' ? (recipeLineage(observed) === 'canvas'
    ? 'This canvas recipe is blocked (see readiness) and cannot be revised: edit the canvas (draft_edit, apply_edit), then capture it again with prepare_recipe {canvas}.'
    : 'This recipe is blocked (see readiness); fix the inputs with a new revision before enqueueing.')
    : seeded(mode) ? `Check effective (final prompts, automaticQuality, ucPreset, ${mode === 't2i' ? 'transparentBackground' : 'mode parameters, source'}, characters) against your intent, then enqueue_recipes with exactly this recipeId, recipeRevision and inputHash.`
      : `Check effective (${mode} parameters and input size) against your intent, then enqueue_recipes with exactly this recipeId, recipeRevision and inputHash, once, without seeds or count: ${mode} makes one image per recipe per enqueue.`;

  /**
   * prepare_recipe {canvas}: one host call (capture_canvas_recipe) collects the live canvas at exactly the given
   * revision, with its draft or detached patch, and stores it as a new recipe (or previews it). This server cannot
   * compare stored fields with a request it never had, so it checks the reply's identity, lineage, mode, canvas
   * origin and sample count; the readback shows what the host builder made of the canvas.
   */
  async function captureCanvas(plan, signal) {
    const { canvas, mode } = plan;
    const origin = { workspaceId: canvas.workspaceId, revision: canvas.expectedRevision, draftId: canvas.draftId ?? null, patched: canvas.patch !== undefined };
    const details = plan.preview ? { preview: true, saved: false, generationSubmitted: false, canvas: origin } : { putAttempted: true, generationSubmitted: false, canvas: origin };
    const sameOrigin = value => record(value) && value.workspaceId === origin.workspaceId && value.revision === origin.revision && value.draftId === origin.draftId && value.patched === origin.patched;
    let reply;
    try { reply = await bridge.call(RECIPE_HOST_METHODS.capture, { ...canvas, mode, ...(plan.preview ? { preview: true } : {}) }, signal); }
    catch (error) {
      if (outdatedHost(error)) throw hostOutdated(error, plan.preview ? { preview: true } : { putAttempted: true, putOutcome: 'rejected' });
      if (plan.preview && error instanceof BridgeError) throw new BridgeError(error.code, `${error.message} This was a preview: nothing was saved.`, { ...details, ...hostDetailsOf(error) });
      if (error instanceof BridgeError && (PUT_REJECTED.has(error.code) || CANVAS_REFUSED.has(error.code))) throw new BridgeError(error.code, error.code === 'queue_storage_failed'
        ? putStorageRefusal(error) : error.message,
      { ...details, putOutcome: 'rejected', saved: false, ...hostDetailsOf(error) });
      throw new BridgeError('recipe_save_unknown', 'The canvas recipe may or may not have been saved; the host assigns its ID, so an orphan cannot be looked up. Nothing was enqueued. Capturing again creates a separate recipe (an unused orphan is harmless but occupies host storage); never resend automatically.',
        { ...details, putOutcome: 'unknown', expectedIdentity: { recipeId: null, recipeRevision: 1 }, hostCode: error instanceof BridgeError ? error.code : null, ...hostDetailsOf(error) });
    }
    if (plan.preview) {
      let observed;
      try { observed = validatePreviewResult(reply); }
      catch (error) { throw new BridgeError('invalid_response', 'The host preview is not a complete, consistent dry run. Nothing was saved; preview again or capture without preview.', { ...details, reason: error.message }); }
      if (observed.snapshot.mode !== mode || !sameOrigin(observed.canvasOrigin)) throw new BridgeError('invalid_response', 'The host previewed a different mode or canvas state. Nothing was saved.', details);
      if (!oneSample(observed.snapshot)) throw new BridgeError('recipe_input_mismatch', `The host preview does not build a single-sample request (${seeded(mode) ? 'effective.n_samples' : 'effective.sampleCount'}). Nothing was saved.`, details);
      const previewed = previewResponse(observed, null);
      return { ...previewed, warnings: [...previewed.warnings, ...unappliedDraftWarning(reply, canvas)] };
    }
    const receipt = { ...details, putOutcome: 'confirmed' }, expectedIdentity = { recipeId: null, recipeRevision: 1 };
    let observed;
    try { observed = validateRecipeResult(reply); }
    catch (error) { throw new BridgeError('recipe_identity_unconfirmed', 'The host reply is not a complete, consistent recipe snapshot. Do not enqueue from it; capture the canvas again and enqueue only an identity whose readback you checked.', { ...receipt, reason: error.message }); }
    const observedIdentity = { recipeId: observed.recipeId, recipeRevision: observed.recipeRevision, inputHash: observed.inputHash };
    if (observed.recipeRevision !== 1 || recipeLineage(observed) !== 'canvas' || observed.snapshot.mode !== mode || !sameOrigin(observed.canvasOrigin))
      throw new BridgeError('recipe_identity_unconfirmed', 'The host saved an unexpected identity, mode or canvas origin. Do not adopt, enqueue or retry either reference automatically.', { ...receipt, expectedIdentity, observedIdentity });
    if (!oneSample(observed.snapshot)) {
      const fields = [seeded(mode) ? 'effective.n_samples' : 'effective.sampleCount'];
      mismatched.set(`${observed.recipeId}:${observed.recipeRevision}`, fields);
      throw new BridgeError('recipe_input_mismatch', `The host stored a recipe that does not build a single-sample request (${fields.join(', ')}). This revision was saved but must not be enqueued.`, { ...receipt, observedIdentity, fields });
    }
    const readback = recipeReadback(observed);
    return { ...readback, warnings: [...readback.warnings, ...unappliedDraftWarning(reply, canvas)], saved: true, generationSubmitted: false, next: nextStep(observed, mode) };
  }

  /** The readback of a write-free preview reply, with its optional mask overlay (`built`: the mask built here, if any). */
  function previewResponse(observed, built, planWarnings = []) {
    const readback = recipeReadback(observed, { built }), image = observed.previewImage ?? null, warnings = [...readback.warnings, ...(built?.warnings ?? []), ...planWarnings];
    if (image && built && image.cells.selected !== built.selectedCells) warnings.push({ code: 'mask_cells_differ', message: `The host request mask selects ${image.cells.selected} cells; this server computed ${built.selectedCells}. Trust the host count and the preview image.` });
    return { ...readback, warnings, preview: true, saved: false, generationSubmitted: false,
      previewImage: image && { mimeType: image.mimeType, width: image.width, height: image.height, byteLength: image.byteLength, sha256: image.sha256, ...(record(image.basis) ? { basis: image.basis } : {}), cells: { selected: image.cells.selected, total: image.cells.total }, data: image.data },
      next: image ? `Look at the attached preview: the latent cells the host will repaint are tinted red on the actual request source. ${observed.canvasOrigin ? 'Change the canvas mask (draft_edit) and preview again, or call prepare_recipe with the same canvas arguments without preview to save the recipe.' : 'Adjust the mask and preview again, or call prepare_recipe with the same arguments without preview to save the recipe.'}`
        : 'Nothing was saved. Check the readback, then call prepare_recipe with the same arguments without preview to save the recipe.' };
  }

  /** Readback of one stored revision. Not an MCP tool (read_recipe was removed); kept as a module API for tests. */
  async function read(args, { signal } = {}) {
    exactKeys(args, ['recipeId', 'recipeRevision', 'inputHash'], 'recipe read');
    if (typeof args.recipeId !== 'string' || !UUID.test(args.recipeId)) invalid('recipeId must be a recipe UUID.');
    integerIn(args.recipeRevision, 1, Number.MAX_SAFE_INTEGER, 'recipeRevision');
    if (args.inputHash !== undefined && (typeof args.inputHash !== 'string' || !HASH.test(args.inputHash))) invalid('inputHash must be 64 lowercase hex characters.');
    const result = await readExact(args, signal);
    if (args.inputHash !== undefined && result.inputHash !== args.inputHash) throw new BridgeError('recipe_changed', 'This recipe revision has a different inputHash than supplied; do not enqueue with the old hash.', { recipeId: result.recipeId, recipeRevision: result.recipeRevision, inputHash: result.inputHash });
    return recipeReadback(result);
  }

  /** One read of the host queue: is there a batch under this host key? Used only for a stuck unknown receipt. */
  const scanQueue = async (hostKey, signal) => {
    const result = await bridge.call(RECIPE_HOST_METHODS.list, {}, signal);
    if (!record(result) || !Array.isArray(result.batches)) invalidResponse('The host returned an invalid queue list.');
    return { batch: result.batches.find(batch => record(batch) && batch.requestKey === hostKey && batch.execution === 'queued') ?? null, batchesScanned: result.batches.length };
  };

  async function lookup(args, { signal } = {}) {
    exactKeys(args, ['requestKey'], 'lookup_enqueue');
    const requestKey = requestKeyOf(args.requestKey), hostRequestKey = mcpHostRequestKey(requestKey);
    return exclusive(hostRequestKey, async () => {
      let found, queueCheck, settlement;
      try { found = await lookupHost(hostRequestKey, signal); }
      catch (error) {
        // The host's receipt was being rewritten by an in-flight enqueue under this key while it reconciled it.
        if (error instanceof BridgeError && receiptTransition(error)) throw new BridgeError(error.code, `The lookup collided with an enqueue of this requestKey that was changing its receipt (${error.message}). Only the lookup failed; nothing was sent. Look up the same requestKey again in a few seconds; do not resend and do not switch keys.`, { requestKey, hostRequestKey, status: 'lookup_failed', instruction: 'Look up the same requestKey again later.', ...hostDetailsOf(error) });
        if (error instanceof BridgeError && error.code === 'queue_storage_error') throw new BridgeError(error.code, `${FROZEN_STORE_FAILED_MESSAGE} (${error.message}) Only the lookup failed; nothing was sent, and the state of this requestKey could not be read: look it up again once the client is healthy.`, { requestKey, hostRequestKey, status: 'lookup_failed', ...hostDetailsOf(error) });
        // Thrown before any settle bookkeeping: an unreadable queue never counts toward newKeyAdvised.
        if (error instanceof BridgeError && error.code === 'queue_acceptance_unknown') throw new BridgeError(error.code, `${FROZEN_UNREADABLE_MESSAGE} (${error.message})`, { requestKey, hostRequestKey, status: 'lookup_failed', newKeyAdvised: false, ...hostDetailsOf(error) });
        throw error;
      }
      const time = monotonicNow();
      if (found.status === 'unknown') {
        // An unknown receipt may still become accepted (an in-flight enqueue finishing); check the queue itself too.
        const scan = await scanQueue(hostRequestKey, signal);
        queueCheck = { batchFound: Boolean(scan.batch), batchesScanned: scan.batchesScanned };
        if (scan.batch) found = { status: 'enqueued', batch: scan.batch, receiptPersisted: false };
      }
      if (found.status === 'unknown') {
        // Settle window: a key first seen unknown in this process (or dispatched by it recently) must be looked up
        // again after the window. Only two unknown sightings at least settleMs apart, both without a batch in the
        // queue, and no dispatch of our own within the window, justify a new key.
        const first = unknownSince.get(hostRequestKey);
        if (first === undefined) unknownSince.set(hostRequestKey, time);
        seen.add(hostRequestKey); notFoundSince.delete(hostRequestKey);
        const wait = first === undefined ? Math.max(settleMs, settleWait(hostRequestKey, time)) : settleWait(hostRequestKey, time, first);
        settlement = wait > 0
          ? { state: 'settling', retryAfterSeconds: seconds(wait), unknownObservedForSeconds: first === undefined ? 0 : seconds(time - first), newKeyAdvised: false }
          : { state: 'stale', unknownObservedForSeconds: seconds(time - first), newKeyAdvised: true };
      } else {
        // A key this process never dispatched and never saw unknown (after a restart, or sent by another process):
        // a not_found may still be an earlier request that has not reached the host yet, so it gets its own window.
        const unseen = !seen.has(hostRequestKey);
        unresolved.delete(hostRequestKey); unknownSince.delete(hostRequestKey);
        if (found.status !== 'not_found') { dispatchedAt.delete(hostRequestKey); notFoundSince.delete(hostRequestKey); freed.delete(hostRequestKey); }
        else if (unseen) {
          const first = notFoundSince.get(hostRequestKey);
          if (first === undefined) notFoundSince.set(hostRequestKey, time);
          const wait = first === undefined ? settleMs : Math.max(0, settleMs - (time - first));
          settlement = wait > 0
            ? { state: 'settling', retryAfterSeconds: seconds(wait), newKeyAdvised: false }
            : { state: 'clear', notFoundObservedForSeconds: seconds(time - (first ?? time)), newKeyAdvised: false };
        } else {
          notFoundSince.delete(hostRequestKey);
          const wait = settleWait(hostRequestKey, time);
          if (wait > 0) settlement = { state: 'settling', retryAfterSeconds: seconds(wait), newKeyAdvised: false };
        }
      }
      const unseenNotFound = found.status === 'not_found' && notFoundSince.has(hostRequestKey);
      const freedNotFound = found.status === 'not_found' && !settlement && freed.has(hostRequestKey);
      const checked = `${queueCheck?.batchesScanned ?? 0} queued batches checked`;
      const instruction = {
        enqueued: found.batch?.cleaned === true ? cleanedBatchInstruction(found.batch) : 'A batch exists for this requestKey. Track it with read_queue; never enqueue the same intent again.',
        rejected: 'The host rejected this request; nothing was queued under it. After fixing the cause, a new requestKey is required.',
        unknown: settlement?.newKeyAdvised
          ? `Acceptance has stayed unknown for ${settlement.unknownObservedForSeconds} seconds across lookups at least ${seconds(settleMs)} seconds apart, and the host queue has no batch under this key (${checked}). If the images are still wanted, enqueue the same plan under a NEW requestKey. The old request can still be accepted late, which would duplicate the images: check list_queue/read_queue afterwards.`
          : `Acceptance is still settling: the host marks an in-flight enqueue unknown when a lookup lands before it finishes, and turns it into accepted once the batch exists. No batch under this key yet (${checked}). Do not resend and do not switch keys; look up the same requestKey again in about ${settlement?.retryAfterSeconds} seconds.`,
        not_found: freedNotFound
          ? 'No receipt: the latest enqueue under this requestKey was refused before the host recorded anything (for example a client that does not accept a field of this request, or a history-group refusal), and no earlier request under this key is pending in this server process. Enqueue again with the same requestKey, with the same or a corrected plan.'
          : unseenNotFound
          ? (settlement.state === 'settling'
            ? `No receipt yet: nothing is recorded under this requestKey right now, and this server process has no record of sending it (for example after a restart). A request sent earlier under this key that timed out can still arrive and be accepted late. Resending the same plan with the same requestKey right now is safe (the host deduplicates it). Before changing the plan or switching to a new requestKey, wait about ${settlement.retryAfterSeconds} seconds and look up this same requestKey again. If it is still not_found after that, changing the plan or the requestKey is fine.`
            : `Still no receipt after the settle window (not_found for ${settlement.notFoundObservedForSeconds} seconds): no earlier request under this key is expected to arrive any more. Changing the plan or switching to a new requestKey is fine now; resending the same plan with the same requestKey also stays safe. A request that timed out earlier can still be accepted late, which would duplicate the images; before switching keys you can check list_queue for a batch under this key.`)
          : `No receipt yet: nothing is recorded under this requestKey right now. A request sent earlier under this key that timed out can still arrive and be accepted late. Resending the same plan with the same requestKey is safe (the host deduplicates it). Before changing the plan, look up this same requestKey again${settlement ? ` in about ${settlement.retryAfterSeconds} seconds` : ''}; a different plan needs a different key.`,
      }[found.status];
      return { requestKey, hostRequestKey, status: found.status, batch: found.batch ? compactQueuedBatch(found.batch) : null,
        ...(found.status === 'enqueued' && !found.receiptPersisted ? { receiptPersisted: false } : {}), ...(found.error ? { hostError: found.error } : {}), ...(queueCheck ? { queueCheck } : {}),
        ...(settlement ? { settlement } : {}), instruction };
    });
  }

  async function enqueue(args, { signal } = {}) {
    const plan = normalizeEnqueue(args);
    const hostRequestKey = mcpHostRequestKey(plan.requestKey);
    return exclusive(hostRequestKey, async () => {
      const hostArgs = { requestKey: hostRequestKey, items: plan.items, intervalSeconds: plan.intervalSeconds, ...(plan.output ? { output: plan.output } : {}) };
      const base = { requestKey: plan.requestKey, hostRequestKey, count: plan.items.length, intervalSeconds: plan.intervalSeconds, ...(plan.output ? { output: plan.output } : {}) };
      // 1. Idempotency gate: the host receipt for this stable key decides; nothing is sent if one exists.
      let found;
      try { found = await lookupHost(hostRequestKey, signal); }
      catch (error) {
        if (!(error instanceof BridgeError)) throw error;
        if (error.code === 'queue_storage_error') throw new BridgeError(error.code, `${FROZEN_STORE_FAILED_MESSAGE} (${error.message}) The requestKey lookup failed on it, so nothing was sent and this requestKey is unchanged.`, { ...base, status: 'not_sent', enqueueSent: false, ...hostDetailsOf(error) });
        if (error.code === 'queue_acceptance_unknown') throw new BridgeError(error.code, `${FROZEN_UNREADABLE_MESSAGE} (${error.message}) Nothing was sent.`, { ...base, status: 'unknown', enqueueSent: false, newKeyAdvised: false, ...hostDetailsOf(error) });
        throw new BridgeError(error.code, error.code === 'queue_storage_failed'
          ? `The requestKey lookup failed: ${error.message} Nothing was sent and this requestKey is unchanged; retry the same call once that is fixed.`
          : `The requestKey lookup failed (${error.message}); nothing was sent. Retry the same call once the host is reachable.`, { ...base, status: 'not_sent', enqueueSent: false, ...hostDetailsOf(error) });
      }
      if (found.status === 'enqueued') {
        const batch = compactQueuedBatch(found.batch), cleaned = found.batch.cleaned === true;
        // A key rebuilt from the library after its record was lost has no plan to compare: it is accepted, never sent again.
        if (!(cleaned && found.batch.recovered === true) && !acceptanceMatches(found.batch, hostArgs)) throw new BridgeError('request_conflict', cleaned
          ? 'This requestKey already named a different accepted plan (existingBatch), whose batch ended and was cleaned under the client\'s queue retention. Your new plan was not sent. If this different plan is wanted, use a new requestKey.'
          : 'This requestKey already holds a different accepted batch (existingBatch), which is queued and generating. Your new plan was not sent. Do not enqueue the existing plan again; if this different plan is also wanted, use a new requestKey.', { ...base, status: 'conflict', enqueueSent: false, existingBatch: batch });
        unresolved.delete(hostRequestKey);
        return { ...base, status: 'already_enqueued', enqueueSent: false, batch, instruction: cleaned ? `This exact plan was already accepted under this requestKey; nothing was sent again. ${cleanedBatchInstruction(found.batch)}` : 'This exact plan was already accepted under this requestKey; nothing was sent again. Track it with read_queue.' };
      }
      if (found.status === 'rejected') throw new BridgeError('queue_request_rejected', 'The host already rejected this requestKey; nothing was sent. After fixing the cause, a new requestKey is required.', { ...base, status: 'rejected', enqueueSent: false, hostError: found.error });
      if (found.status === 'unknown') throw new BridgeError('queue_acceptance_unknown', 'The host records this requestKey with an unknown acceptance, which may still turn into accepted (an in-flight enqueue finishing). Nothing was sent. Call lookup_enqueue with the same requestKey: it checks the host queue and tells you when to look again and when, after the settle window, a new requestKey is justified.', { ...base, status: 'unknown', enqueueSent: false });
      if (unresolved.has(hostRequestKey)) throw new BridgeError('queue_acceptance_unknown', 'An earlier enqueue with this requestKey in this server process had an unknown outcome. Nothing was sent. Call lookup_enqueue with the same requestKey; only after it reports not_found may this same requestKey be enqueued again. Never switch to a new requestKey for the same intent while it is not_found or enqueued.', { ...base, status: 'unknown', enqueueSent: false });
      // 2. Exact recipes, checked before any receipt exists so a rejected plan does not consume the key.
      //    Any host-ready recipe is accepted, whatever its origin; warnings report what this server did not check.
      const notSent = { ...base, status: 'not_sent', enqueueSent: false };
      const reads = [];
      for (const ref of plan.refs) {
        const at = `${ref.recipeId} revision ${ref.recipeRevision}`;
        let recipe;
        try { recipe = await readExact(ref, signal); }
        catch (error) {
          if (!(error instanceof BridgeError)) throw error;
          if (error.code === 'host_outdated') throw new BridgeError(error.code, error.message, { ...error.details, ...notSent });
          throw new BridgeError(error.code, `Recipe ${at} could not be read exactly (${error.message}); nothing was sent.`, { ...notSent, ...hostDetailsOf(error) });
        }
        if (recipe.inputHash !== ref.inputHash) throw new BridgeError('recipe_changed', `Recipe ${at} has inputHash ${recipe.inputHash}, not the one supplied. Nothing was sent; prepare or revise the recipe again and enqueue the exact identity it returns.`, notSent);
        const readiness = recipe.snapshot.reviewInput.readiness;
        if (readiness.status !== 'ready') throw new BridgeError('recipe_blocked', `Recipe ${at} is blocked; nothing was sent.`, { ...notSent, readiness });
        reads.push({ ref, at, recipe });
      }
      // One mode per enqueue; the whole plan is reported so it can be split by mode (each part with its own key).
      const modes = reads.map(({ ref, recipe }) => ({ recipeId: ref.recipeId, recipeRevision: ref.recipeRevision, mode: recipe.snapshot.mode }));
      if (new Set(modes.map(item => item.mode)).size > 1) throw new BridgeError('invalid_arguments', `All items in one enqueue must use the same generation mode (got ${[...new Set(modes.map(item => item.mode))].join(', ')}); nothing was sent and this requestKey was not used. Split the items by mode into separate enqueue_recipes calls, each with its own requestKey.`, { ...notSent, modes });
      const warnings = [];
      for (const { ref, at, recipe } of reads) {
        const recipeMode = recipe.snapshot.mode;
        if (!oneSample(recipe.snapshot)) invalidResponse(`Recipe ${at} does not build a single-sample request.`);
        // Upscale and Director use no seed: one image per recipe per enqueue (the host would otherwise pay for the same request twice).
        if (!seeded(recipeMode) && (ref.seeded || ref.images > 1 || ref.entries > 1))
          throw new BridgeError('invalid_arguments', `Recipe ${at} has mode ${recipeMode}, which uses no seed and makes one image per recipe per enqueue. List it once, without seeds and with count 1 (or no count); nothing was sent and this requestKey was not used.`, { ...notSent, recipeId: ref.recipeId, recipeRevision: ref.recipeRevision, mode: recipeMode });
        if (recipe.snapshot.reviewInput.effective?.sampling?.seedPolicy === 'fixed' && ref.unseeded > 1)
          throw new BridgeError('invalid_arguments', `Recipe ${at} has a fixed seed; ${ref.unseeded} images without explicit seeds would be identical paid generations. Give explicit seeds (repeat a seed deliberately if identical images are wanted).`, notSent);
        const identity = { recipeId: ref.recipeId, recipeRevision: ref.recipeRevision };
        const flagged = mismatched.get(`${ref.recipeId}:${ref.recipeRevision}`);
        if (flagged) warnings.push({ ...identity, code: 'recipe_input_mismatch', message: `prepare_recipe reported that the host stored different inputs for this revision (${flagged.join(', ')}); it is enqueued anyway, as requested.` });
        for (const warning of recipeReadback(recipe).warnings) warnings.push({ ...identity, ...warning });
      }
      // The frozen queue keeps every image's source and mask until the batch ends; bound one enqueue's share.
      const estimatedBytes = frozenInputEstimate(plan.items, new Map(reads.map(({ ref, recipe }) => [`${ref.recipeId}:${ref.recipeRevision}`, recipe.assetBytes])));
      if (estimatedBytes > RECIPE_LIMITS.frozenEnqueueBytes) throw new BridgeError('invalid_arguments', `This plan would freeze about ${estimatedBytes} bytes of source/mask images (base64) into the host queue; one enqueue takes at most ${RECIPE_LIMITS.frozenEnqueueBytes} (32 MiB). Enqueue fewer images per call or use one recipe for all of them; nothing was sent and this requestKey was not used.`, { ...notSent, estimatedBytes, limitBytes: RECIPE_LIMITS.frozenEnqueueBytes });
      signal?.throwIfAborted?.();
      // 3. One dispatch. No retry; an unrecognized failure holds the key until a lookup resolves it.
      const withWarnings = warnings.length ? { warnings } : {};
      let accepted;
      // An earlier dispatch's settle window must survive a refusal of this one (see release below).
      const previousDispatch = dispatchedAt.get(hostRequestKey);
      dispatchedAt.set(hostRequestKey, monotonicNow()); seen.add(hostRequestKey); notFoundSince.delete(hostRequestKey); freed.delete(hostRequestKey);
      /** This dispatch was refused before any receipt: undo its own settle bookkeeping only. True when the key is now
       * wholly free; false when an earlier dispatch of this key is still inside its window (that window is kept). */
      const release = () => {
        if (previousDispatch !== undefined) { dispatchedAt.set(hostRequestKey, previousDispatch); return false; }
        dispatchedAt.delete(hostRequestKey); freed.add(hostRequestKey); return true;
      };
      try { accepted = await bridge.call(RECIPE_HOST_METHODS.enqueue, hostArgs, signal); }
      catch (error) {
        // A client that does not know historyGroup/fileNamePrefix refuses the field itself, before it reads any receipt.
        // Refused before any receipt, so no settle window applies to this key (lookup_enqueue answers plainly).
        if (plan.output && outdatedHost(error)) { release(); throw hostOutdated(error, { ...base, status: 'not_sent', ...withWarnings }); }
        if (!(error instanceof BridgeError) || !ENQUEUE_REJECTED.has(error.code)) {
          unresolved.add(hostRequestKey);
          throw new BridgeError('queue_acceptance_unknown', `Queue acceptance is unknown; the host may still be working on it (settle window about ${seconds(settleMs)} seconds). Do not resend and do not change requestKey; call lookup_enqueue with the same requestKey.`, { ...base, status: 'unknown', enqueueSent: true, hostCode: error instanceof BridgeError ? error.code : null, ...hostDetailsOf(error), ...withWarnings });
        }
        return refused(error, { base, hostArgs, signal, withWarnings, release });
      }
      if (!acceptanceMatches(accepted, hostArgs)) {
        unresolved.add(hostRequestKey);
        throw new BridgeError('queue_acceptance_unknown', 'The host reply could not confirm this plan. Do not resend; call lookup_enqueue with the same requestKey.', { ...base, status: 'unknown', enqueueSent: true, ...withWarnings });
      }
      return { ...base, status: 'enqueued', enqueueSent: true, batch: compactQueuedBatch(accepted), items: plan.items.map(item => ({ ...item, seed: item.seed ?? null })), ...withWarnings,
        instruction: 'Accepted into the shared FIFO queue; the host now generates these images. Track progress with read_queue {batchId}; view images with get_queue_result. Do not enqueue this intent again.' };
    });
  }

  /**
   * The host explicitly refused the dispatch. Exactly one confirming lookup (a
   * read, never a resend) reports what the key now holds: another accepted
   * batch (attached), a recorded rejection, no receipt, or a stuck unknown.
   */
  async function refused(error, { base, hostArgs, signal, withWarnings, release }) {
    const hostCode = error.code, hostRequestKey = hostArgs.requestKey;
    let after = null;
    try { after = await lookupHost(hostRequestKey, signal); } catch { after = null; }
    const details = { ...base, enqueueSent: true, hostCode, ...hostDetailsOf(error), ...withWarnings };
    // Only a confirmed answer (no receipt, or a recorded rejection) makes this a definite rejection. When the
    // confirming lookup failed or found an unknown receipt the outcome is not known: say so and hold the key here
    // until a lookup_enqueue resolves it (as after any other unknown dispatch).
    const unconfirmed = () => { unresolved.add(hostRequestKey); return 'unknown'; };
    if (after?.status === 'enqueued') {
      const batch = compactQueuedBatch(after.batch);
      if (acceptanceMatches(after.batch, hostArgs)) return { ...base, status: 'enqueued', enqueueSent: true, reconciled: true, hostCode, batch, items: hostArgs.items.map(item => ({ ...item, seed: item.seed ?? null })), ...withWarnings,
        instruction: 'The host reported an error, but the confirming lookup shows this exact plan accepted under this requestKey. Track it with read_queue; do not enqueue it again.' };
      throw new BridgeError('request_conflict', after.batch.cleaned === true
        ? 'This requestKey already named a different accepted plan (existingBatch), whose batch ended and was cleaned under the client\'s queue retention; your new plan was not queued. If this different plan is wanted, use a new requestKey.'
        : 'This requestKey already holds a different accepted batch (existingBatch). That batch is queued and generating; your new plan was not queued. Do not enqueue the existing plan again. If this different plan is also wanted, use a new requestKey.', { ...details, status: 'conflict', existingBatch: batch });
    }
    const transition = receiptTransition(error);
    // A lookup landed after the host published this key's receipt but before it recorded the plan: the host
    // abandoned this dispatch and the receipt stays unknown for good. This is not a full store.
    if (transition && after?.status === 'unknown') throw new BridgeError(hostCode, `The host abandoned this dispatch (${error.message}): a lookup of this requestKey landed before the host recorded the plan, so nothing was queued and this key's receipt stays unknown. Call lookup_enqueue with the same requestKey; once the settle window (about ${seconds(settleMs)} seconds) has passed it reports stale, and then enqueue the same plan under a new requestKey as it advises.`, { ...details, status: unconfirmed(), keyStatus: 'unknown', abandoned: true });
    const storage = hostCode === 'queue_storage_failed' && !transition && storeFullRefusal(error) ? ` ${STORE_FULL} and needs explicit archiving.` : '';
    if (hostCode === 'queue_storage_error') {
      const keyFacts = {
        not_found: [' Nothing was queued and this requestKey was not used: once the client is healthy again, resend the same plan with the same requestKey.', 'not_found'],
        rejected: [' Nothing was queued; this requestKey already has a recorded rejection, so a new requestKey is needed once the client is healthy again.', 'rejected'],
        unknown: [' The receipt for this requestKey is now unknown: call lookup_enqueue with the same requestKey before anything else.', 'unknown'],
      }[after?.status] ?? [' The confirming lookup failed, so the state of this requestKey is not known: look it up with lookup_enqueue before anything else.', 'lookup_failed'];
      const confirmed = after?.status === 'not_found' || after?.status === 'rejected';
      throw new BridgeError(hostCode, `${FROZEN_STORE_FAILED_MESSAGE} (${error.message})${keyFacts[0]}`, { ...details, status: confirmed ? 'rejected' : unconfirmed(), keyStatus: keyFacts[1], ...(after?.status === 'rejected' ? { hostError: after.error } : {}) });
    }
    // recipe_changed: the corrected recipe has another inputHash, so its enqueue is a different plan.
    // A history-group refusal is answered before any receipt and is about the output itself, so its fix is a changed
    // plan. The key is free for it at once unless an earlier dispatch of this key is still settling (kept as it was).
    const outputRefusal = hostCode === 'history_group_conflict' || hostCode === 'history_group_unavailable';
    const free = after?.status === 'not_found' && outputRefusal ? release() : false;
    const next = hostCode === 'recipe_changed' ? ' No receipt yet. Once corrected, the recipe\'s inputHash changes and the enqueue becomes a new plan, which may use a new requestKey.'
      : free ? ' No receipt yet and no earlier request under this requestKey is pending in this server process: change historyGroup (or fix the cause) and enqueue again with the same requestKey.'
      : outputRefusal ? ' No receipt yet, but an earlier request under this requestKey may still arrive: call lookup_enqueue with the same requestKey and follow it before changing the plan or the key.'
      : ' No receipt yet: after fixing the cause, only resend the same plan with the same requestKey.';
    if (after?.status === 'not_found') throw new BridgeError(hostCode, `The host refused this enqueue (${error.message}) before recording the requestKey; nothing was queued.${storage}${next}`, { ...details, status: 'rejected', keyStatus: 'not_found' });
    if (after?.status === 'rejected') throw new BridgeError(hostCode, `The host refused this enqueue (${error.message}) and recorded the rejection; nothing was queued under this requestKey.${storage} After fixing the cause, use a new requestKey.`, { ...details, status: 'rejected', keyStatus: 'rejected', hostError: after.error });
    if (after?.status === 'unknown') throw new BridgeError(hostCode, `The host refused this enqueue (${error.message}), but its receipt for this requestKey is now unknown, which can still turn into accepted if another request under this key is in flight.${storage} Call lookup_enqueue with the same requestKey: it checks the host queue and tells you when to look again and when a new requestKey is justified.`, { ...details, status: unconfirmed(), keyStatus: 'unknown' });
    throw new BridgeError(hostCode, `The host refused this enqueue (${error.message}); the confirming lookup failed, so the outcome is not known.${storage} Call lookup_enqueue with the same requestKey before anything else; do not resend and do not switch keys.`, { ...details, status: unconfirmed(), keyStatus: 'lookup_failed' });
  }

  return { prepare, read, enqueue, lookup };
}
