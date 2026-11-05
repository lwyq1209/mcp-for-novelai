import { GENERATION_MODES, isSeededGeneration, type GenerationMode } from '../src/workspace/generation-types';
import { WorkspaceError } from '../src/workspace/protocol';
import type { CanvasOrigin } from './queue-recipe-service';

/**
 * capture_canvas_recipe (prepare_recipe {canvas}): one host method that freezes the live canvas into a recipe.
 * 1. The renderer collects the effective preparation at exactly expectedRevision (collect_canvas_preparation, the
 *    same selection and collection as read_prompt_review: the visible state, or that state with one unapplied
 *    draft or one detached t2i text patch). It adopts and changes nothing, and rechecks revision, draft and mask
 *    stroke after reading the source image.
 * 2. The host stores it as a new recipe (put_canvas_recipe) or dry-runs it (preview_queue_recipe), so a canvas
 *    recipe passes the same normalization, source checks and builder as any other recipe.
 * Only the images the chosen mode uses are kept (no source in t2i, no mask outside inpaint); references are kept
 * for the seeded modes, where the recipe refuses them (unsupported_reference), and dropped for upscale/director,
 * which never send them. Every renderer refusal comes back with its own code and message, and nothing was saved.
 * Captured without draftId while the canvas holds an unapplied draft, the reply names that draft (unappliedDraftId):
 * the recipe is the visible state (or its detached patch), not the draft. The notice is not stored with the recipe.
 */
export const CANVAS_CAPTURE_KEYS = ['workspaceId', 'expectedRevision', 'mode', 'draftId', 'patch', 'preview'] as const;
type Args = Record<string, unknown>;
type Preparation = { mode: GenerationMode; authored: Record<string, any>; assets: Array<{ role: string; mimeType: string; data: string }> };
export interface CanvasCaptureDependencies {
  /** The renderer method collect_canvas_preparation (main.ts: workspaceBridge.dispatch). */
  collect(args: Args): Promise<any>;
  /** put_canvas_recipe / preview_canvas_recipe: the canvas keeps its own prompt assembly (no upgrade of a canvas without the marker). */
  put(args: { preparation: Preparation; canvasOrigin: CanvasOrigin; assetData: 'omit' }): Promise<any>;
  preview(args: { preparation: Preparation; assetData: 'omit' }): Promise<any>;
  now?: () => Date;
}

/** Renderer codes passed on as they are (each means: nothing was read into a recipe); any other failure is canvas_capture_failed. */
export const RENDERER_REFUSALS = new Set(['conflict', 'draft_not_found', 'workspace_mismatch', 'workspace_busy', 'workspace_not_ready', 'workspace_unavailable', 'invalid_argument', 'invalid_image', 'invalid_mask']);
const fail = (code: string, message: string, details?: Record<string, unknown>): never => { throw new WorkspaceError(code, message, details); };
const record = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown) => typeof value === 'string' && value.trim() !== '' && value.length <= 120 && !/[\x00-\x1f\x7f]/.test(value);

/** The canvas request, before anything is asked of the renderer. */
export function parseCanvasCapture(raw: unknown) {
  if (!record(raw) || Object.keys(raw).some(key => !(CANVAS_CAPTURE_KEYS as readonly string[]).includes(key))) return fail('invalid_argument', 'A canvas capture takes workspaceId, expectedRevision, mode and optionally draftId, patch or preview.');
  if (!identifier(raw.workspaceId)) return fail('invalid_argument', 'workspaceId must be the current workspace ID from list_workspaces.');
  if (!Number.isSafeInteger(raw.expectedRevision) || (raw.expectedRevision as number) < 0) return fail('invalid_argument', 'expectedRevision must be the workspace revision from read_workspace.');
  if (!GENERATION_MODES.includes(raw.mode as GenerationMode)) return fail('invalid_argument', 'Choose one of the six recipe modes.');
  if (raw.draftId !== undefined && !identifier(raw.draftId)) return fail('invalid_argument', 'draftId must identify the current visible draft.');
  if (raw.patch !== undefined && (!record(raw.patch) || !Object.keys(raw.patch).length || raw.mode !== 't2i' || raw.draftId !== undefined)) return fail('invalid_argument', 'A detached canvas patch needs a nonempty t2i text patch and no draftId.');
  if (raw.preview !== undefined && typeof raw.preview !== 'boolean') return fail('invalid_argument', 'preview must be true or false.');
  return { workspaceId: raw.workspaceId as string, expectedRevision: raw.expectedRevision as number, mode: raw.mode as GenerationMode,
    ...(raw.draftId !== undefined ? { draftId: raw.draftId as string } : {}), ...(raw.patch !== undefined ? { patch: structuredClone(raw.patch) } : {}), preview: raw.preview === true };
}

/** Keeps the images the mode uses; post-processing modes never send references, so their authored copies go too. */
export function canvasPreparation(mode: GenerationMode, raw: unknown): Preparation {
  if (!record(raw) || raw.mode !== mode || !record(raw.authored) || !Array.isArray(raw.assets)) return fail('canvas_capture_mismatch', 'The canvas returned an incomplete preparation; nothing was saved. Read the workspace and capture again.');
  const authored = structuredClone(raw.authored);
  if (!isSeededGeneration(mode)) { authored.vibeImages = []; authored.preciseReferences = []; }
  const assets = (raw.assets as Preparation['assets']).filter(asset => record(asset) && ((asset.role === 'source' && mode !== 't2i') || (asset.role === 'mask' && mode === 'inpaint')))
    .map(asset => ({ role: asset.role, mimeType: asset.mimeType, data: asset.data }));
  return { mode, authored, assets };
}

export function createCanvasRecipeCapture(deps: CanvasCaptureDependencies) {
  const now = deps.now ?? (() => new Date());
  return async function capture_canvas_recipe(raw: unknown) {
    const args = parseCanvasCapture(raw);
    const request = { workspaceId: args.workspaceId, expectedRevision: args.expectedRevision, mode: args.mode, ...(args.draftId !== undefined ? { draftId: args.draftId } : {}), ...(args.patch !== undefined ? { patch: args.patch } : {}) };
    let collected: any;
    try { collected = await deps.collect(request); }
    catch (error: any) {
      // The renderer is read only here: whatever it answered, nothing was saved. Its own refusals keep their code.
      const code = typeof error?.code === 'string' ? error.code : '';
      const message = typeof error?.message === 'string' && error.message ? error.message : 'The canvas could not be read.';
      if (code === 'timeout') return fail('workspace_timeout', 'The canvas did not answer in time; nothing was saved. Read the workspace and capture again.');
      if (code === 'method_not_found') return fail('workspace_unavailable', 'This window cannot capture the canvas into a recipe; nothing was saved. Restart the client.');
      if (!RENDERER_REFUSALS.has(code)) return fail('canvas_capture_failed', `The canvas could not be captured (${message}); nothing was saved. Read the workspace and capture again.`);
      return fail(code, `${message} Nothing was saved.`, record(error?.details) ? error.details : undefined);
    }
    if (!record(collected) || collected.schemaVersion !== 1 || collected.workspaceId !== args.workspaceId || collected.revision !== args.expectedRevision || collected.mode !== args.mode
      || (collected.draftId ?? null) !== (args.draftId ?? null) || collected.patched !== (args.patch !== undefined)) return fail('canvas_capture_mismatch', 'The canvas answered for a different workspace, revision, mode or draft; nothing was saved. Read the workspace and capture again.');
    // Older renderers do not report it (undefined): no notice. A malformed value is a mismatched reply.
    const pending = collected.unappliedDraftId ?? null;
    if (pending !== null && (args.draftId !== undefined || !identifier(pending))) return fail('canvas_capture_mismatch', 'The canvas answered with an inconsistent draft notice; nothing was saved. Read the workspace and capture again.');
    const notice = pending === null ? {} : { unappliedDraftId: pending as string };
    const preparation = canvasPreparation(args.mode, collected.preparation);
    const canvasOrigin: CanvasOrigin = { workspaceId: args.workspaceId, revision: args.expectedRevision, draftId: args.draftId ?? null, patched: args.patch !== undefined, capturedAt: now().toISOString() };
    if (args.preview) return { ...(await deps.preview({ preparation, assetData: 'omit' })), canvasOrigin, ...notice };
    return { ...(await deps.put({ preparation, canvasOrigin, assetData: 'omit' })), ...notice };
  };
}
