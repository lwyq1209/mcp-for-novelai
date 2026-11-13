/**
 * Canvas layer of the NovelAI MCP server: the read of the live client workspace
 * (read_workspace; list_workspaces was folded into it on 2026-11-13). Nothing here generates or edits: an image from the canvas is
 * prepare_recipe {canvas} (core layer), then enqueue_recipes. The former canvas
 * generation tools (submit_generation, submit_batch and their job and batch reads and
 * controls) were retired on 2026-11-02; the self-check and draft tools
 * (read_prompt_review, get_asset, draft_edit, apply_edit, undo_edit) on 2026-11-12:
 * prepare_recipe {canvas, preview:true} gives the same effective-input check,
 * read_workspace {assetIds} the images, and the canvas is edited in the app. The host
 * keeps those methods for its own window.
 *
 * Each tool forwards to the host method of the same name unless its entry says
 * otherwise (hostMethods); every argument rule runs before the host.
 */
import { BridgeError } from './bridge-client.mjs';
import { imageBlock, success } from './mcp-registry.mjs';

const canvasImage = asset => imageBlock(asset, 'Read the workspace again.');
const MAX_IMAGES = 5;
const string = { type: 'string', minLength: 1, pattern: '\\S' };
const workspace = { workspaceId: string };
const schema = (properties = {}, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const DETAILS = ['compact', 'full'];

// [name, description, inputSchema, readOnlyHint, openWorldHint]
const CANVAS_DEFINITIONS = [
  ['read_workspace', 'Read the current creative state of the app\'s canvas and its asset manifest; workspaceId and revision are what prepare_recipe {canvas} takes (workspaceId may be left out here: the app has one canvas). One native image is attached by default (activeImageAssetId, else currentImage/workbenchImage); assetIds picks up to 5 from the manifest, includeImages:false none. '
    + 'Default detail compact lists what it left out in omitted: an image entry (currentImage, workbenchImage, i2iOriginalImage, comparisonBeforeImage) keeps its identity, seed and size without its own recipe (promptsMatchCanvas says whether its prompts equal the canvas ones), and the inpaint prompt and recipe appear only while the inpaint tab is active. detail:"full" returns everything. Read again after any manual edit or conflict.',
    schema({ ...workspace, includeImages: { type: 'boolean', default: true }, assetIds: { type: 'array', items: string, uniqueItems: true, maxItems: MAX_IMAGES }, detail: { type: 'string', enum: DETAILS, default: 'compact' } }, []), true],
];

// ---------------------------------------------------------------- compact view
const record = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const IMAGE_ROLES = ['currentImage', 'workbenchImage', 'i2iOriginalImage', 'comparisonBeforeImage'];
/** The recipe an image entry carries: its own params and characters, a copy of the canvas prompts in the usual case. */
const IMAGE_RECIPE_KEYS = ['params', 'characterSnapshot', 'characterPrompts'];
const PROMPT_KEYS = ['stylePrompt', 'positivePrompt', 'negativePrompt'];
/** The inpaint text, shown only while the inpaint tab is active (prepare_recipe {canvas, mode:"inpaint"} reads it back anyway). */
const INPAINT_TEXT_KEYS = ['inpaintPositivePrompt', 'inpaintRecipe'];
const characterPromptsOf = image => Array.isArray(image.characterSnapshot?.captions) ? image.characterSnapshot.captions.map(caption => caption?.prompt ?? '')
  : Array.isArray(image.characterPrompts) ? image.characterPrompts : null;

/** Whether an image entry's own prompts and character prompts equal the canvas ones; null when the entry carries no recipe. */
function promptsMatchCanvas(image, state) {
  if (!record(image.params)) return null;
  const canvas = record(state.params) ? state.params : {};
  if (PROMPT_KEYS.some(key => (image.params[key] ?? '') !== (canvas[key] ?? ''))) return false;
  const own = characterPromptsOf(image), current = Array.isArray(state.charCaptions) ? state.charCaptions.map(caption => caption?.prompt ?? '') : [];
  return own === null ? current.length === 0 : own.length === current.length && own.every((prompt, index) => prompt === current[index]);
}

/**
 * The default read_workspace view: the same snapshot without what repeats the canvas prompts. Each image entry
 * loses its own recipe (params, characterSnapshot, characterPrompts) and says whether its prompts match the
 * canvas; the inpaint prompt and recipe are left out unless the inpaint tab is active. `omitted` names every
 * path left out, so nothing disappears silently; detail:"full" returns the host snapshot as it is.
 */
export function compactWorkspace(result) {
  if (!record(result?.state)) return result;
  const state = { ...result.state }, omitted = [];
  for (const role of IMAGE_ROLES) {
    const image = state[role];
    if (!record(image)) continue;
    const dropped = IMAGE_RECIPE_KEYS.filter(key => image[key] !== undefined);
    if (!dropped.length) continue;
    const match = promptsMatchCanvas(image, state);
    state[role] = { ...Object.fromEntries(Object.entries(image).filter(([key]) => !IMAGE_RECIPE_KEYS.includes(key))), ...(match === null ? {} : { promptsMatchCanvas: match }) };
    omitted.push(...dropped.map(key => `state.${role}.${key}`));
  }
  if (state.activeTab !== 'inpaint') for (const key of INPAINT_TEXT_KEYS) {
    if (state[key] === undefined || state[key] === null || state[key] === '') continue;
    delete state[key];
    omitted.push(`state.${key}`);
  }
  return { ...result, state, detail: 'compact', omitted };
}

// ---------------------------------------------------------------- handlers
// Each returns the MCP result; anything thrown becomes the shared error envelope.
const forward = name => async (args, { bridge, signal, roots }) => success(await bridge.call(name, args, signal), [], roots);

const HANDLERS = {
  async read_workspace(args, { bridge, signal, roots }) {
    // The app has one canvas: without a workspaceId it is looked up first (the former list_workspaces tool, retired on 2026-11-13).
    let workspaceId = args.workspaceId;
    if (workspaceId === undefined) {
      const listed = await bridge.call('list_workspaces', {}, signal);
      workspaceId = Array.isArray(listed?.workspaces) && listed.workspaces.length === 1 ? listed.workspaces[0]?.workspaceId : undefined;
      if (typeof workspaceId !== 'string' || !workspaceId) throw new BridgeError('invalid_response', 'The client did not name exactly one workspace.');
    }
    const result = await bridge.call('read_workspace', { workspaceId }, signal);
    if (result.workspaceId !== workspaceId || !Number.isInteger(result.revision) || !Array.isArray(result.assets)) throw new BridgeError('invalid_response', 'The client returned an invalid workspace snapshot.');
    const defaultAsset = result.activeImageAssetId ?? result.assets.find(asset => asset.role === 'currentImage')?.id ?? result.assets.find(asset => asset.role === 'workbenchImage')?.id;
    const selected = args.includeImages === false ? [] : args.assetIds ?? (defaultAsset ? [defaultAsset] : []);
    if (selected.length > MAX_IMAGES) throw new BridgeError('image_limit', 'Select at most five assetIds, or read without images and request them in another read.');
    for (const id of selected) if (!result.assets.some(asset => asset.id === id)) throw new BridgeError('unknown_asset', 'The requested image is not in this workspace snapshot.', { assetId: id });
    const images = [];
    for (const assetId of selected) images.push(canvasImage(await bridge.call('get_asset', { workspaceId, expectedRevision: result.revision, assetId }, signal)));
    const view = args.detail === 'full' ? { ...result, detail: 'full' } : compactWorkspace(result);
    return success({ ...view, imageAttachments: { includedAssetIds: selected, availableAssetIds: result.assets.map(asset => asset.id), limit: MAX_IMAGES } }, images, roots);
  },
};

// Cross-field rules the flat schemas cannot express; all run before the host.
const VALIDATORS = {
  read_workspace(args) {
    if (args.includeImages === false && args.assetIds?.length) throw new BridgeError('invalid_arguments', 'assetIds cannot be combined with includeImages:false.');
  },
};

// Host methods beyond the tool's own name.
const EXTRA_HOST_METHODS = { read_workspace: ['list_workspaces', 'get_asset'] };

/** The canvas tool. Generating from the canvas is prepare_recipe {canvas} + enqueue_recipes. */
export const CANVAS_TOOLS = [
  ...CANVAS_DEFINITIONS.map(([name, description, inputSchema, readOnlyHint, openWorldHint = false]) => ({
    name, layer: 'canvas', errors: 'opaque', description, inputSchema,
    annotations: { readOnlyHint, destructiveHint: false, idempotentHint: readOnlyHint, openWorldHint },
    hostMethods: [name, ...(EXTRA_HOST_METHODS[name] ?? [])],
    ...(VALIDATORS[name] ? { validate: VALIDATORS[name] } : {}),
    handle: HANDLERS[name] ?? forward(name),
  })),
];
