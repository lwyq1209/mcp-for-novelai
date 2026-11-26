/**
 * Recipe files of `nai`: a history image's settings as a prepare_recipe argument object (`nai asset recipe`), the
 * overrides of `nai prepare`, and the recipe identities `nai enqueue -f` takes from prepare receipts. Pure.
 */
import { MEDIUM_MODELS, MODE_FIELDS, T2I_MODELS } from './recipe-queue.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const allowed = mode => new Set(['mode', ...MODE_FIELDS[mode].required, ...MODE_FIELDS[mode].optional]);

export class RecipeExtractionError extends Error {
  constructor(code, message) { super(message); this.name = 'RecipeExtractionError'; this.code = code; }
}

/** Modes whose images carry no generation recipe of their own (a post-process of another image). */
const POSTPROCESS_MODES = new Set(['upscale', 'director']);
/** Modes made from another image: their prompts and settings can be reused, their source is not in the record. */
const SOURCE_MODES = new Set(['i2i', 'enhance', 'inpaint']);
/** Fields effort medium fixes itself (src/recipe-queue.mjs MEDIUM_FILLED, plus cfgRescale): left out of a medium recipe. */
const MEDIUM_FIXED_FIELDS = ['steps', 'sampler', 'ucPreset', 'negativePrompt', 'cfgRescale'];
/** The app's defaults of those fields on High (client/src/types.ts DEFAULT_PARAMS). */
const HIGH_DEFAULTS = Object.freeze({ steps: 28, sampler: 'k_euler_ancestral', ucPreset: 2, negativePrompt: '', cfgRescale: 0 });
/** History records do not keep the reference images of a request, so nothing can tell whether an image used them. */
export const REFERENCES_NOTE = 'History records do not keep precise reference or vibe images: if the original used them, add references to the file yourself.';
/**
 * How a history image was made: the queue's generationOrigin.mode (`mode` of the compact view) or, for an image made
 * with Generate in the app, the record's `feature` (client/electron/ipc/nai.ts: the click's mode t2i, i2i, inpaint,
 * enhance, upscale or director; "generate" is the t2i of older records). Null when the record says neither.
 */
export function madeWith(view) {
  const value = typeof view?.mode === 'string' ? view.mode : typeof view?.feature === 'string' ? view.feature : null;
  return value === 'generate' ? 't2i' : value;
}

/**
 * The model id a recipe takes for the model an image was sent with: the inpainting variant is its base model
 * (`-inpainting`), Medium is V5 Full with effort medium (`nai-diffusion-5-full-medium[-inpainting]`). Null for a model no
 * recipe takes (a Director tool, an upscale).
 */
export function recipeModel(sent) {
  if (typeof sent !== 'string') return null;
  if (MEDIUM_MODELS.includes(sent)) return { model: 'nai-diffusion-5-full', effort: 'medium' };
  const base = sent.endsWith('-inpainting') ? sent.slice(0, -'-inpainting'.length) : sent;
  return T2I_MODELS.includes(base) ? { model: base } : null;
}

/**
 * The prepare_recipe arguments that remake a history image, from the asset_library read of it (the compact history
 * view: mode, model, width, height, actualSeed, params, characters, assetId). mode t2i by default; i2i and enhance take
 * this image as their source. Returns {recipe, dropped (params that are not recipe fields of that mode), missing
 * (required fields the image does not give: strength, magnitude, scale, or older records' gaps), warnings}. How the
 * image was made comes from madeWith (queued: mode; made in the app: feature). Throws
 * RecipeExtractionError recipe_not_reproducible for an image no recipe can remake (an upscale or a Director result, or
 * a model no recipe takes): nothing is written then.
 */
export function historyToRecipe(view, { mode = 't2i', randomSeed = false } = {}) {
  if (!record(view) || view.kind !== 'history' || typeof view.id !== 'string') throw new TypeError('A history read is required.');
  const made = madeWith(view);
  if (made && POSTPROCESS_MODES.has(made)) throw new RecipeExtractionError('recipe_not_reproducible', `This image is ${made === 'upscale' ? 'an upscale' : 'a Director result'} of another image: it has no prompt and settings of its own to write as a recipe. Nothing was written. To work on the image itself, use it as the source of a recipe you write (mode upscale, director, i2i …).`);
  const params = record(view.params) ? view.params : {};
  const sentModel = typeof view.model === 'string' ? view.model : typeof params.model === 'string' ? params.model : null;
  const model = recipeModel(sentModel);
  if (!model) throw new RecipeExtractionError('recipe_not_reproducible', `This image was made with ${sentModel ? `the model ${JSON.stringify(sentModel)}` : 'no recorded model'}, which no prepare_recipe recipe takes. Nothing was written.`);
  const fields = allowed(mode);
  const warnings = [];
  const recipe = { mode };
  if (mode !== 't2i') recipe.source = { kind: 'history', historyId: view.id, historyRevision: view.revision, assetId: view.assetId };
  recipe.model = model.model;
  // Medium exists for V5 Full t2i and i2i here (enhance runs on High: the image's own sampling values are kept).
  const medium = model.effort === 'medium' || (params.effort === 'medium' && model.model === 'nai-diffusion-5-full');
  if (medium && ['t2i', 'i2i'].includes(mode)) recipe.effort = 'medium';
  if (sentModel !== model.model) warnings.push({ code: 'model_normalized', message: `The image was sent as ${sentModel}; the recipe names ${model.model}${recipe.effort ? ' with effort medium' : ''}, which prepare_recipe sends as the model of the mode.` });
  if (medium && !recipe.effort) {
    // The values Medium fixed are not the image's choice: a High recipe gets the app's own defaults instead.
    for (const [key, value] of Object.entries(HIGH_DEFAULTS)) if (fields.has(key)) recipe[key] = value;
    warnings.push({ code: 'effort_not_applied', message: `The image was made with effort medium, which does not apply to a ${mode} recipe: it runs on High. The values Medium fixed are not copied; the file has the app's High defaults instead (${Object.entries(HIGH_DEFAULTS).map(([key, value]) => `${key} ${JSON.stringify(value)}`).join(', ')}): change them if you like.` });
  }
  if (made && SOURCE_MODES.has(made)) warnings.push({ code: 'source_not_included', message: `This image was made by ${made} from another image, which the record does not name: the recipe keeps its prompts and settings as a ${mode} recipe${mode === 't2i' ? ' without that source' : ' with this image as its source'}.${made === 'inpaint' ? ' An inpaint prompt often describes only the repainted area: rewrite it for a whole picture.' : ''}` });
  if (fields.has('width') && Number.isFinite(view.width)) recipe.width = view.width;
  if (fields.has('height') && Number.isFinite(view.height)) recipe.height = view.height;
  const dropped = [];
  // effort is decided above from the model the image was sent with (never copied: enhance runs on High). The values
  // Medium fixed are never written: a Medium recipe gets them again, any other runs on the defaults of High.
  const skip = new Set(['seed', 'qualityToggle', 'seedMode', 'model', 'effort', ...(medium ? MEDIUM_FIXED_FIELDS : [])]);
  for (const [key, value] of Object.entries(params)) {
    if (skip.has(key)) continue;
    if (fields.has(key) && !Object.hasOwn(recipe, key) && key !== 'source' && key !== 'references') {
      // transparentBackground is t2i-only; false is the default.
      if (key === 'transparentBackground' && value !== true) continue;
      recipe[key] = value;
    } else if (!Object.hasOwn(recipe, key)) dropped.push(key);
  }
  // The older on/off quality switch, when the image has no quality preset.
  if (fields.has('qualityPreset') && recipe.qualityPreset === undefined) recipe.qualityPreset = params.qualityToggle === false ? 'none' : 'standard';
  if (fields.has('seed')) recipe.seed = randomSeed ? null : Number.isSafeInteger(view.actualSeed) ? view.actualSeed : Number.isSafeInteger(params.seed) ? params.seed : null;
  if (fields.has('characters') && Array.isArray(view.characters) && view.characters.length) {
    recipe.characters = view.characters.map(character => {
      const useCoords = Number.isFinite(character?.x) && Number.isFinite(character?.y);
      return { prompt: character?.prompt ?? '', ...(character?.negativePrompt && recipe.effort !== 'medium' ? { negativePrompt: character.negativePrompt } : {}), useCoords, ...(useCoords ? { x: character.x, y: character.y } : {}) };
    });
  } else if (Array.isArray(view.characters) && view.characters.length) dropped.push('characters');
  if (made === null) warnings.push({ code: 'mode_unknown', message: 'The record does not say how the image was made; the recipe assumes its prompts and settings. Check them before you prepare.' });
  const missing = MODE_FIELDS[mode].required.filter(key => !Object.hasOwn(recipe, key) && !(recipe.effort === 'medium' && MEDIUM_FIXED_FIELDS.includes(key)));
  return { recipe, dropped, missing, warnings };
}

/** The one-line facts `nai asset recipe` prints instead of the prompts. */
export function recipeSummary(recipe) {
  const length = value => typeof value === 'string' ? value.length : 0;
  return {
    mode: recipe.mode, model: recipe.model, ...(recipe.width ? { width: recipe.width, height: recipe.height } : {}),
    seed: recipe.seed, characters: Array.isArray(recipe.characters) ? recipe.characters.length : 0,
    promptChars: length(recipe.stylePrompt) + length(recipe.positivePrompt) + (Array.isArray(recipe.characters) ? recipe.characters.reduce((sum, character) => sum + length(character.prompt), 0) : 0),
  };
}

/** A --set value: JSON when it parses, else the text itself. */
export function parseSetValue(raw) {
  try { return JSON.parse(raw); } catch { return raw; }
}

const RECIPE_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
export class RecipeReferenceError extends Error {
  constructor(message) { super(message); this.name = 'RecipeReferenceError'; this.code = 'invalid_recipe_reference'; }
}

/** One enqueue item from a receipt-like object: recipeId, recipeRevision, inputHash (and count/seeds when present). */
export function enqueueItemFrom(value, label) {
  if (!record(value) || typeof value.recipeId !== 'string' || !RECIPE_ID.test(value.recipeId) || !Number.isSafeInteger(value.recipeRevision) || value.recipeRevision < 1 || typeof value.inputHash !== 'string' || !HASH.test(value.inputHash))
    throw new RecipeReferenceError(`${label} has no recipeId, recipeRevision and inputHash of a saved recipe (a preview is not saved: prepare without --preview).`);
  return { recipeId: value.recipeId, recipeRevision: value.recipeRevision, inputHash: value.inputHash,
    ...(Number.isSafeInteger(value.count) ? { count: value.count } : {}), ...(Array.isArray(value.seeds) ? { seeds: value.seeds } : {}) };
}

/** The enqueue items in a prepared file: one receipt, an array of them, or {items:[…]}. */
export function enqueueItemsFromFile(value, label) {
  const list = Array.isArray(value) ? value : record(value) && Array.isArray(value.items) && value.recipeId === undefined ? value.items : [value];
  if (!list.length) throw new RecipeReferenceError(`${label} lists no recipe.`);
  return list.map((item, index) => enqueueItemFrom(item, list.length > 1 ? `${label} item ${index}` : label));
}

/** A --recipe <id>:<revision>:<inputHash> value. */
export function enqueueItemFromArgument(text) {
  const [recipeId, revision, inputHash, ...rest] = String(text).split(':');
  if (rest.length || !/^\d+$/.test(revision ?? '')) throw new RecipeReferenceError(`--recipe takes <recipeId>:<recipeRevision>:<inputHash>, not ${JSON.stringify(text)}.`);
  return enqueueItemFrom({ recipeId, recipeRevision: Number(revision), inputHash }, `--recipe ${JSON.stringify(text)}`);
}

/** What `nai prepare -o` writes: the identity of the saved recipe revision, for nai enqueue -f. */
export function preparedReceipt(readback, args) {
  return { recipeId: readback.recipeId, recipeRevision: readback.recipeRevision, inputHash: readback.inputHash, mode: args.mode ?? readback.mode, ...(readback.ready !== undefined ? { ready: readback.ready } : {}) };
}
