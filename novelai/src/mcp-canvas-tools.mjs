/**
 * Canvas layer of the NovelAI MCP server: tools bound to the live client workspace
 * (workspaceId) — workspace reads, the effective-recipe self-check and visible drafts.
 * Nothing here generates: an image from the canvas is prepare_recipe {canvas} (core
 * layer), then enqueue_recipes; the former canvas generation tools (submit_generation,
 * submit_batch and their job and batch reads and controls) were retired on 2026-11-02.
 *
 * Definitions and their special handling moved here unchanged from the former
 * src/mcp.mjs. Each tool forwards to the host method of the same name unless its
 * entry says otherwise (hostMethods); every argument rule runs before the host.
 */
import { BridgeError } from './bridge-client.mjs';
import { imageBlock, success } from './mcp-registry.mjs';

const canvasImage = asset => imageBlock(asset, 'Read the workspace again.');
const MAX_IMAGES = 5;
const string = { type: 'string', minLength: 1, pattern: '\\S' };
const revision = { type: 'integer', minimum: 0 };
const workspace = { workspaceId: string };
const versioned = { ...workspace, expectedRevision: revision };
const schema = (properties = {}, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const scenePatch = schema({ params: { type: 'object' }, charCaptions: { type: 'array' } }, []);

// [name, description, inputSchema, readOnlyHint, openWorldHint]
const CANVAS_DEFINITIONS = [
  ['list_workspaces', 'List the live NovelAI client workspace. Select its workspaceId before reading or editing.', schema(), true],
  ['read_workspace', 'Read the current complete creative state and asset manifest. Native image attachments default to activeImageAssetId, with currentImage/workbenchImage fallback for older snapshots. Other assets remain available through get_asset. Read again after any manual edit or conflict.', schema({ ...workspace, includeImages: { type: 'boolean', default: true }, assetIds: { type: 'array', items: string, uniqueItems: true, maxItems: MAX_IMAGES } }, ['workspaceId']), true],
  ['read_prompt_review', 'Read the full effective recipe using the same builders as actual generation, at the exact workspace revision. Optional draftId reads the matching unapplied draft without applying. Alternatively patch previews detached t2i params/charCaptions against the same baseline without replacing the visible draft; patch and draftId are mutually exclusive. Includes all authored and effective prompts, automatic quality/UC, characters/positions, sampling, readiness and unused inputs. Images are native attachments (default first five); use assetRoles to inspect remaining source/Mask/reference images. Does not generate, encode references, choose a random seed or modify the workspace. This is a self-check of the effective input.', schema({ ...versioned, mode: { type: 'string', enum: ['t2i','i2i','inpaint','enhance','upscale','director'] }, draftId: string, patch: scenePatch, includeImages: { type: 'boolean', default: true }, assetRoles: { type: 'array', items: string, uniqueItems: true, minItems: 1, maxItems: MAX_IMAGES } }, ['workspaceId','expectedRevision','mode']), true],
  ['get_asset', 'View one actual image from a previously read workspace manifest at its exact revision. Returns native image content; never reads arbitrary paths.', schema({ ...versioned, assetId: string }), true],
  ['draft_edit', 'Stage a visible edit proposal at the exact current revision. Does not apply changes or generate. Arrays replace whole arrays; params, i2iParams and inpaintRecipe merge partial fields. A non-null inpaintRecipe explicitly enables an independent inpaint recipe, preserving base parameters and characters; null selects legacy inpaint. For existing reference entries and masks, use assetId from the current manifest instead of copying base64. Storing references does not prove generation support; never silently change the model. Respect read_workspace capabilities. params.effort "high"|"medium" is the V5 Full Effort (Medium: fixed 14 steps, Euler Ancestral, Heavy UC, no negatives; also inpaintRecipe.effort, used when the inpaint model is V5 Full inpainting); enhanceScale "max" is Enhance Max✨ (V5 only, paid on Opus too).', schema({ ...versioned, patch: schema({ params: { type: 'object' }, i2iParams: { type: 'object' }, charCaptions: { type: 'array' }, vibeImages: { type: 'array' }, preciseReferences: { type: 'array' }, inpaintMask: { type: ['string', 'null', 'object'], properties: { assetId: string }, required: ['assetId'], additionalProperties: false }, inpaintModel: string, inpaintStrength: { type: 'number', minimum: 0, maximum: 1 }, inpaintNoise: { type: 'number', minimum: 0, maximum: 0.99 }, inpaintPositivePrompt: { type: 'string' }, inpaintRecipe: { type: ['object', 'null'] }, enhanceMagnitude: { type: 'integer', minimum: 1, maximum: 10 }, enhanceScale: { enum: [1, 2, 'max'] }, upscaleScale: { type: 'integer', enum: [2, 4] }, directorTool: { type: 'string', enum: ['bg-removal', 'lineart', 'sketch', 'colorize', 'emotion', 'declutter'] }, augmentOptions: schema({ defry: { type: 'integer', minimum: 0, maximum: 5 }, colorizePrompt: { type: 'string' }, emotion: string, emotionLevel: { type: 'integer', minimum: 0, maximum: 5 } }, []) }, []) }), false],
  ['apply_edit', 'Apply a previously staged, visible draft only if its base and current revision still match. Never automatically retry a failed or timed-out mutation. Does not generate.', schema({ ...versioned, draftId: string }), false],
  ['undo_edit', 'Undo the last bridge edit only while its resulting state still matches. Refuses to overwrite later manual changes. Does not generate.', schema(versioned), false],
];

// ---------------------------------------------------------------- handlers
// Each returns the MCP result; anything thrown becomes the shared error envelope.
const forward = name => async (args, { bridge, signal, roots }) => success(await bridge.call(name, args, signal), [], roots);

const HANDLERS = {
  async read_workspace(args, { bridge, signal, roots }) {
    const result = await bridge.call('read_workspace', { workspaceId: args.workspaceId }, signal);
    if (result.workspaceId !== args.workspaceId || !Number.isInteger(result.revision) || !Array.isArray(result.assets)) throw new BridgeError('invalid_response', 'The client returned an invalid workspace snapshot.');
    const defaultAsset = result.activeImageAssetId ?? result.assets.find(asset => asset.role === 'currentImage')?.id ?? result.assets.find(asset => asset.role === 'workbenchImage')?.id;
    const selected = args.includeImages === false ? [] : args.assetIds ?? (defaultAsset ? [defaultAsset] : []);
    if (selected.length > MAX_IMAGES) throw new BridgeError('image_limit', 'Select at most five assetIds, or read without images and request assets individually.');
    for (const id of selected) if (!result.assets.some(asset => asset.id === id)) throw new BridgeError('unknown_asset', 'The requested image is not in this workspace snapshot.', { assetId: id });
    const images = [];
    for (const assetId of selected) images.push(canvasImage(await bridge.call('get_asset', { workspaceId: args.workspaceId, expectedRevision: result.revision, assetId }, signal)));
    return success({ ...result, imageAttachments: { includedAssetIds: selected, availableAssetIds: result.assets.map(asset => asset.id), limit: MAX_IMAGES } }, images, roots);
  },
  async read_prompt_review(args, { bridge, signal, roots }) {
    const { assetRoles, includeImages = true, ...identity } = args;
    const result = await bridge.call('read_prompt_review', identity, signal);
    if (result?.schemaVersion !== 1 || result.workspaceId !== args.workspaceId || result.revision !== args.expectedRevision || result.mode !== args.mode || (result.draftId ?? null) !== (args.draftId ?? null) || !Array.isArray(result.reviewInput?.assets)) throw new BridgeError('invalid_response', 'The effective recipe snapshot does not match the requested version.');
    const assets = result.reviewInput.assets;
    const roles = !includeImages ? [] : assetRoles ?? assets.slice(0, MAX_IMAGES).map(asset => asset.role);
    const images = roles.map(role => {
      const asset = assets.find(item => item.role === role);
      if (!asset) throw new BridgeError('unknown_asset', 'The requested role is not in this review snapshot.');
      return canvasImage(asset);
    });
    return success({ ...result, reviewInput: { ...result.reviewInput, assets: assets.map(({ data, ...asset }) => asset) }, imageAttachments: { includedRoles: roles, availableRoles: assets.map(asset => asset.role), limit: MAX_IMAGES } }, images, roots);
  },
  async get_asset(args, { bridge, signal, roots }) {
    const asset = await bridge.call('get_asset', args, signal);
    return success({ workspaceId: args.workspaceId, revision: args.expectedRevision, assetId: args.assetId, mimeType: asset.mimeType, imageAttached: true }, [canvasImage(asset)], roots);
  },
};

// Cross-field rules the flat schemas cannot express; all run before the host.
const VALIDATORS = {
  read_workspace(args) {
    if (args.includeImages === false && args.assetIds?.length) throw new BridgeError('invalid_arguments', 'assetIds cannot be combined with includeImages:false.');
  },
  read_prompt_review(args) {
    if (args.patch !== undefined && (args.mode !== 't2i' || args.draftId !== undefined || !Object.keys(args.patch).length)) throw new BridgeError('invalid_arguments', 'Detached review requires a nonempty t2i text patch and no draftId.');
    if (args.includeImages === false && args.assetRoles) throw new BridgeError('invalid_arguments', 'assetRoles requires includeImages:true.');
  },
};

// Host methods beyond the tool's own name.
const EXTRA_HOST_METHODS = { read_workspace: ['get_asset'] };

/** The 7 canvas tools in tools/list order. Generating from the canvas is prepare_recipe {canvas} + enqueue_recipes. */
export const CANVAS_TOOLS = [
  ...CANVAS_DEFINITIONS.map(([name, description, inputSchema, readOnlyHint, openWorldHint = false]) => ({
    name, layer: 'canvas', errors: 'opaque', description, inputSchema,
    annotations: { readOnlyHint, destructiveHint: false, idempotentHint: readOnlyHint, openWorldHint },
    hostMethods: [name, ...(EXTRA_HOST_METHODS[name] ?? [])],
    ...(VALIDATORS[name] ? { validate: VALIDATORS[name] } : {}),
    handle: HANDLERS[name] ?? forward(name),
  })),
];
