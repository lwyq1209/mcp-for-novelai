/**
 * Public schemas and descriptions of the recipe tools (prepare_recipe,
 * enqueue_recipes). Kept apart from src/mcp-core-tools.mjs so the
 * recipe modes can evolve here without touching the rest of the core layer. The
 * server-side rules stay in src/recipe-queue.mjs, which validates every
 * field again (per mode) before any host call; the mask is validated only there,
 * so its errors carry details {reason, path}.
 */
import { DIRECTOR_EMOTIONS, DIRECTOR_TOOLS, EFFORT_VALUES, MAX_QUEUE_ITEMS, MAX_QUEUE_SEED, MAX_TEXT, NOISE_SCHEDULES, QUALITY_PRESETS, QUEUE_FILE_PREFIX_MAX, QUEUE_FILE_PREFIX_PATTERN, QUEUE_HISTORY_GROUP_MAX, RECIPE_HOST_METHODS, RECIPE_MODES, RECIPE_SOURCE_HOST_METHODS, T2I_MODELS, T2I_SAMPLERS } from './recipe-queue.mjs';

const schema = (properties = {}, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const positive = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const uuid = { type: 'string', pattern: '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' };
const hash64 = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const promptText = { type: 'string', maxLength: MAX_TEXT };
// Numbers the host would clamp or snap are taken as given and corrected by the server (warnings), so the schema keeps only the type.
const pixels = { type: 'number' };
const whole = { type: 'integer' };
const queueSeed = { type: 'integer', minimum: 0, maximum: MAX_QUEUE_SEED };
const identity = { type: 'string', minLength: 1, maxLength: 512, pattern: '\\S' };
const requestKey = { type: 'string', minLength: 1, maxLength: 120, pattern: '\\S', description: 'Your idempotency key for this enqueue intent (1–120 printable characters). The server namespaces it (mcp-…); reuse the same key for the same intent, including after a restart.' };
const recipeRef = { recipeId: { ...uuid, description: 'Recipe ID from prepare_recipe.' }, recipeRevision: positive, inputHash: { ...hash64, description: 'Exact inputHash returned with that recipe revision.' } };

const text = { type: 'string', minLength: 1, pattern: '\\S' };
// The live-canvas input (src/recipe-queue.mjs canvasPlan checks it again); patch is a detached t2i text patch.
const canvasInput = { type: 'object', additionalProperties: false, required: ['workspaceId', 'expectedRevision'],
  description: 'Capture the live canvas instead of inline fields (only mode and preview may accompany it); see the tool description.',
  properties: { workspaceId: text, expectedRevision: { type: 'integer', minimum: 0, description: 'The workspace revision from read_workspace.' }, draftId: text,
    patch: { type: 'object', additionalProperties: false, properties: { params: { type: 'object' }, charCaptions: { type: 'array' } }, description: 't2i only, without draftId: a detached text patch.' } } };

const PREPARE_RECIPE_SCHEMA = schema({
  canvas: canvasInput,
  recipeId: { ...uuid, description: 'Revise: the plain recipe of the same mode to revise; requires expectedRevision (its current revision).' },
  expectedRevision: positive,
  mode: { type: 'string', enum: [...RECIPE_MODES] },
  preview: { type: 'boolean', description: 'Dry run: validate and build without saving (no recipeId, revision or quota).' },
  // Two shapes in one nested object (no anyOf); the server checks the per-kind fields (src/recipe-sources.mjs sourceIdentity).
  source: { type: 'object', additionalProperties: false, required: ['kind'], description: 'Image modes: see the tool description.',
    properties: { kind: { enum: ['history', 'study'] }, historyId: identity, historyRevision: positive, assetId: identity, studyId: uuid, studyRevision: positive } },
  mask: { type: 'object', description: 'inpaint only: {units:"fraction"|"px", layers:[1–16]} applied in order to an empty mask, first layer add. Layer {op:"add"|"subtract", shape|alpha, growPx? −256…256 (+ grow, − shrink), invert?}; per layer rasterize → grow → invert → combine. shape: {type:"rect",x,y,width,height} | {type:"ellipse",cx,cy,rx,ry} | {type:"polygon",points:[[x,y],…] 3–256, even-odd} | {type:"stroke",points 1–512,widthPx 1–512 (≥12 for thin lines)}. alpha (≤2 layers): {historyId,historyRevision,assetId,threshold? 1–255, default 128} of a PNG history original; alpha ≥ threshold selects. fraction scales x by width and y by height; px are source pixels; origin top-left. Coordinates are rounded (fraction 4 decimals, px whole pixels). The host repaints whole 8×8 latent cells; 0 selected cells is refused (mask_empty).' },
  model: { type: 'string', enum: [...T2I_MODELS] },
  effort: { type: 'string', enum: [...EFFORT_VALUES], description: 'Optional, default high; medium: see the description.' },
  width: pixels, height: pixels,
  steps: { type: 'number' },
  cfgScale: { type: 'number' },
  cfgRescale: { type: 'number', description: 'Optional, default 0.' },
  sampler: { type: 'string', enum: [...T2I_SAMPLERS] },
  noiseSchedule: { type: 'string', enum: [...NOISE_SCHEDULES], description: 'V5 models require karras.' },
  ucPreset: { type: 'integer', description: 'UC preset index; its text depends on the model (commonly 0 Heavy, 1 Light, 2 Human Focus, 3 None). On some models a preset adds nothing (for example 2 on V4 Full/Curated, every preset on Furry V3); the readback shows the actual text and warns when it is empty.' },
  qualityPreset: { type: 'string', enum: [...QUALITY_PRESETS], description: 'Automatic quality tags; light is V5-only, none disables them. Some models add no quality text (Furry V3); the readback shows the actual text and warns when it is empty.' },
  stylePrompt: promptText,
  positivePrompt: { ...promptText, minLength: 1, pattern: '\\S' },
  negativePrompt: promptText,
  seed: { type: ['integer', 'null'], description: 'Fixed seed 0–2147483646, or null (or negative) for a random seed drawn at enqueue.' },
  characters: { type: 'array', description: 't2i/i2i/enhance, V4+ models only: up to 6 (V4/V4.5) or 32 (V5).', items: { type: 'object', additionalProperties: false, required: ['prompt', 'useCoords'], properties: {
    prompt: { ...promptText, minLength: 1, pattern: '\\S' }, negativePrompt: promptText, useCoords: { type: 'boolean' },
    x: { type: 'number', description: '0–1; used when useCoords is true (default 0.5).' }, y: { type: 'number', description: '0–1; used when useCoords is true (default 0.5).' } } } },
  transparentBackground: { type: 'boolean', description: 'Optional, default false. t2i on V5 models only: requests a transparent background (the builder appends "transparent background" to the prompt and sets tag_hint_transparent_background and straight_alpha); judge the actual result from the image. Do not also write that text in the prompt. A revision rewrites every field, so pass true again to keep it. Rejected on other models, where the host would turn it off silently.' },
  strength: { type: 'number', description: 'i2i: how much to change the source; inpaint: repaint strength (1 = full).' },
  extraNoiseSeed: { type: ['integer', 'null'], description: 'i2i/enhance, optional: fixed extra noise seed; omit, 0 or null for a random one per image.' },
  magnitude: { ...whole, description: 'enhance: 1–10 (strength is derived from it).' },
  scale: { enum: [1, 2, 'max'], description: 'enhance: 1, 2 or "max" (V5 only); upscale: 2 (optional).' },
  tool: { type: 'string', enum: [...DIRECTOR_TOOLS], description: 'director tool.' },
  defry: { ...whole, description: 'director, optional, default 0.' },
  colorizePrompt: { ...promptText, description: 'director tool colorize only (may be empty).' },
  emotion: { type: 'string', enum: [...DIRECTOR_EMOTIONS], description: 'director tool emotion only.' },
  emotionLevel: { ...whole, description: 'director tool emotion only, 0–5 (default 0).' },
  acceptDownscale: { type: 'boolean', description: 'upscale/director: a source over 1,048,576 px is downscaled by the host (default true, warning source_downscaled); false refuses it instead.' },
}, ['mode']);
const ENQUEUE_RECIPES_SCHEMA = schema({
  requestKey,
  intervalSeconds: { type: 'number', minimum: 0, maximum: 60, description: 'Pause between images, default 0.' },
  historyGroup: { type: 'string', minLength: 1, maxLength: QUEUE_HISTORY_GROUP_MAX, pattern: '^\\S(?:.*\\S)?$', description: 'Optional history group (your project name): images save under outputDir/<date>/<group>/ and join that group. Created on first use, reused by case-insensitive name.' },
  fileNamePrefix: { type: 'string', minLength: 1, maxLength: QUEUE_FILE_PREFIX_MAX, pattern: QUEUE_FILE_PREFIX_PATTERN, description: 'Optional file-name prefix for every image (all modes): "proj" → proj_<date>_01_<model>.png.' },
  items: { type: 'array', minItems: 1, maxItems: MAX_QUEUE_ITEMS, items: { type: 'object', additionalProperties: false, required: ['recipeId', 'recipeRevision', 'inputHash'], properties: {
    ...recipeRef, count: { type: 'integer', minimum: 1, maximum: MAX_QUEUE_ITEMS }, seeds: { type: 'array', minItems: 1, maxItems: MAX_QUEUE_ITEMS, items: queueSeed, description: 'Explicit seed per image; length must equal count. Not for upscale/director.' } } } },
}, ['requestKey', 'items']);

const PREPARE_RECIPE_DESCRIPTION = 'Freeze one independent recipe revision in the shared host recipe store from inline fields (no inbox file) or from the live canvas, or dry-run it with preview:true. Six modes; a field of another mode is refused, never ignored. A value the host would clamp, snap, resize, convert or drop is corrected to what runs before it is saved, and each correction is a readback warning with field, from and to; only what cannot run (a missing field, an unknown model or sampler, an unreadable source) is refused. '
  + 't2i: model; width/height (snapped to multiples of 64 within width×height ≤ 3,145,728); steps 1–50; cfgScale 0–10; optional cfgRescale 0–1; sampler; noiseSchedule (V5 uses karras); ucPreset 0–3; qualityPreset standard/light (V5; else standard)/none; stylePrompt; non-blank positivePrompt; negativePrompt; seed 0–2147483646 or null for random at enqueue; optional characters (V4+: up to 6, V5 32; more are dropped) and transparentBackground (V5 only). '
  + 'effort (default high): medium runs the distilled V5 Full Medium model (nai-diffusion-5-full t2i/i2i/inpaint; elsewhere High; sent as nai-diffusion-5-full-medium[-inpainting], about 42% cheaper) with fixed steps 14, k_euler_ancestral, cfgRescale 0, Heavy UC (nsfw-prefixed unless the prompt has nsfw) and no negative prompts; omit those, or given values are replaced (warning). '
  + 'Image modes take source {kind:"history", historyId, historyRevision, assetId} from asset_library (look at it first with action:image; read_queue/get_queue_result give the historyId of queue results), or {kind:"study", studyId, studyRevision} of an imported image (material_studies id/revision): a PNG/JPEG/WebP original; nothing else is a source. '
  + 'i2i: the t2i fields without transparentBackground, plus source and strength 0–1, optional extraNoiseSeed; width/height are optional: a size more than 3% off the source aspect is refitted to it at about the same area, and without one the source aspect is used at about 832×1216 (Opus free size). '
  + 'enhance: the t2i fields without width/height/transparentBackground, plus source, magnitude 1–10, scale 1|2|"max", optional extraNoiseSeed; for 1|2 the request is source × scale in multiples of 64 within 3,145,728 px (2 becomes 1 when it does not fit). "max" (Max✨, V5 only; elsewhere the largest of 2|1 that fits) sends the source at its own size (made 64-aligned, < 2,516,582 px) and returns about 2× (≤ ~3.1 MP), costs Anlas on Opus too. '
  + 'inpaint: the generation fields without width/height/characters/transparentBackground (model: no furry-3; runs as <model>-inpainting), plus source (aligned up to 64, then ≤ 1600 px per side), strength 0–1 and mask (shapes and alpha layers, see mask). '
  + 'upscale: source (scale 2). director: source, tool, optional defry 0–5, colorizePrompt (colorize only), emotion + optional emotionLevel 0–5 (emotion only). upscale/director use no seed; a source over 1,048,576 px is downscaled (warning source_downscaled) unless acceptDownscale:false. '
  + 'preview:true runs the same checks and the host builder without saving anything; for inpaint it returns a WebP of the actual request source with the latent cells the mask selects tinted red, so check the mask, adjust and preview again before saving. '
  + 'To revise, pass recipeId with its current expectedRevision, the same mode and every field again (source too); the host saves a new immutable revision. '
  + 'canvas {workspaceId, expectedRevision, patch?} with mode (and optional preview) instead captures the live canvas at exactly that revision into a new recipe: every input of that mode as the canvas holds it, its source and mask copied in. patch is a detached t2i text patch (params/charCaptions); nothing is adopted or changed, and a newer revision is a conflict (read the workspace again). A canvas recipe takes no other field, cannot be revised and does not inherit the canvas history group (pass historyGroup to enqueue_recipes). '
  + 'Returns recipeId, recipeRevision and inputHash (a preview: preview:true instead), ready, warnings and effective: only what the host decided, changed or appended. A value not listed there runs as you wrote it (it was compared with your call; a stored difference is recipe_input_mismatch); listed are corrected values, values you left to the host (a size, the model id sent, a derived strength) and the text appended to your prompts (automaticQuality.appendedText, ucPreset.text; absent when none). source and mask give the source size and the selected cells; a canvas recipe lists every value and its texts (authoredPrompts). Check them before enqueueing. Does not generate or enqueue. An unknown save outcome is never retried automatically.';

const { put, read, preview, lookup, enqueue, list, capture } = RECIPE_HOST_METHODS;
/**
 * name -> public definition parts and the fixed host methods the tool may reach
 * (named once, in RECIPE_HOST_METHODS and RECIPE_SOURCE_HOST_METHODS); annotations
 * are completed by the registry entry in src/mcp-core-tools.mjs. A test checks every
 * observed host call against hostMethods.
 */
export const RECIPE_TOOL_SPECS = Object.freeze({
  prepare_recipe: { readOnlyHint: false, openWorldHint: false, hostMethods: [read, RECIPE_SOURCE_HOST_METHODS.image, put, preview, capture], inputSchema: PREPARE_RECIPE_SCHEMA, description: PREPARE_RECIPE_DESCRIPTION },
  enqueue_recipes: { readOnlyHint: false, openWorldHint: true, hostMethods: [lookup, read, enqueue, list], inputSchema: ENQUEUE_RECIPES_SCHEMA,
    description: 'Enqueue exact frozen recipes into the shared host FIFO queue; the host then GENERATES these images with NovelAI (paid), with no further confirmation. items [{recipeId, recipeRevision, inputHash, count?, seeds?}]: 1 up to the client\'s per-enqueue limit of images in total (a client setting, default 20, at most 200; a larger plan is refused with enqueue_limit_exceeded naming the current limit, and the client\'s total queue limit, default 200, refuses with queue_full), one provider request each (n_samples=1), one generation mode per enqueue (split other modes into their own enqueue and requestKey), optional intervalSeconds 0–60. seeds: one explicit seed per image (length = count); without them a random-seed recipe draws each and a fixed-seed one counts up (seed, seed+1, …; warning fixed_seed_incremented). upscale and director use no seed: one image per recipe per enqueue (count, seeds or repeats are dropped; warning postprocess_single_image). The images\' frozen sources and masks are bounded at about 32 MiB per enqueue. requestKey is your idempotency key: the server namespaces it and looks it up first, so a key that already has a host receipt never enqueues again; reuse the same requestKey for the same intent, including after a restart, because a new key is a new paid request. A mismatched revision or inputHash, a blocked recipe, mixed modes or a source that is gone are rejected before anything is sent, and the key stays unused. Any host-ready recipe may be enqueued, including ones prepared elsewhere; the receipt lists warnings (for example a recipe_input_mismatch reported by prepare_recipe, characters not sent, presets that add nothing). An explicit host refusal is followed by one confirming lookup and reported as definite, with any batch already under the key attached. A lost answer is settled in the same call (up to about 150 s): lookups, and the same plan under the same requestKey again while the host holds nothing (deduplicated, never a second batch), ending in enqueued (reconciled) or the definite refusal; it stays queue_acceptance_unknown only if the client is silent, and calling again with the same key and plan is then safe: that call is also how to ask what a key holds (already_enqueued with its batch, and nothing is sent). It never switches keys. Returns status, batchId and count (seeds where the server chose them, warnings); follow the batch with read_queue. '
      + 'Projects share this queue and output folder: pass historyGroup and fileNamePrefix for your project (both part of the plan), and take files only by the fileName/file read_queue gives per historyId, never by number ranges.' },
});
