import { WORKSPACE_CAPABILITIES, WorkspaceError, workspaceErrorInfo, type WorkspaceRequest, type WorkspaceResponse } from "./protocol";
import { assetManifest, creativeStateChanged, DISPLAY_ONLY_KEYS, semanticEqual, snapshotDocument, summarizeChanges, validatePatch, type CreativeState, type EditablePatch } from "./state";
import type { GenerationSourceMode, GenerationSourceSummary, PreparedGenerationSource } from "./source-selection";
import type { WorkspaceAsset } from "./protocol";
import { GENERATION_MODES, type GenerationMode } from "./generation-types";
import type { PromptReviewInput, PromptReviewPreparation, PromptReviewResult } from "./prompt-review";
import { validateScenePatch } from "./scene-patch";
import { APP_NAME } from "../types";

export interface WorkspacePort {
  read(): CreativeState;
  subscribe(listener: () => void): () => void;
  apply(patch: Partial<CreativeState>, restore: boolean): void;
  validateImages(patch: EditablePatch): Promise<void>;
  prepareGenerationSource?(source: unknown, asset: WorkspaceAsset, mode: GenerationSourceMode, current: CreativeState): Promise<PreparedGenerationSource>;
  readActivity(): unknown;
  promptReview?: (state: CreativeState, mode: GenerationMode) => Promise<PromptReviewInput>;
  /** The preparation a recipe is frozen from (prepare_recipe {canvas}): authored state and image bytes, no seeds drawn. */
  collectPreparation?: (state: CreativeState, mode: GenerationMode) => Promise<PromptReviewPreparation>;
}

export interface WorkspaceDraft {
  draftId: string;
  baseRevision: number;
  changes: ReturnType<typeof summarizeChanges>;
  kind: "edit" | "source_selection";
  origin?: "client";
  sourceName?: string;
  generationSource?: GenerationSourceSummary;
}

export interface WorkspaceView {
  workspaceId: string;
  revision: number;
  previewRevision?: number;
  draft?: WorkspaceDraft;
  undoAvailable: boolean;
  lastApplied?: { draftId: string; kind: WorkspaceDraft['kind']; revision: number; previewRevision: number };
}
type StoredWorkspaceDraft = WorkspaceDraft & { patch: Partial<CreativeState> };

export function createWorkspaceController(port: WorkspacePort, workspaceId = `novelai-${crypto.randomUUID()}`) {
  // The canvas never generates (generation and batchGeneration stay false): prepare_recipe {canvas} freezes it into a
  // recipe (canvasRecipe), in every mode including independent inpaint and post-processing, and the queue generates it.
  const canvasRecipe = Boolean(port.collectPreparation);
  const capabilities = { ...WORKSPACE_CAPABILITIES, promptReview: Boolean(port.promptReview), canvasRecipe, independentInpaintRecipe: canvasRecipe, postprocess: canvasRecipe };
  let previous = port.read();
  let revision = 0;
  let previewRevision = 0;
  let lastApplied: WorkspaceView['lastApplied'];
  let draft: StoredWorkspaceDraft | undefined;
  // Internal only (not part of any reply): advanced whenever a draft is created, replaced or discarded, so an
  // asynchronous draft preparation that started before can tell that it is stale.
  let draftGeneration = 0;
  let undo: { state: Partial<CreativeState>; appliedRevision: number; appliedDisplay: Partial<CreativeState>; restore: boolean } | undefined;
  const listeners = new Set<() => void>();
  let view: WorkspaceView = { workspaceId, revision, undoAvailable: false };
  const pending = new Map<string, { fingerprint: string; response: Promise<WorkspaceResponse> }>();

  function publicDraft() {
    if (!draft) return undefined;
    const { patch: _patch, ...summary } = draft;
    return summary;
  }
  function replaceDraft(next?: StoredWorkspaceDraft) {
    draft = next;
    // Clearing a draft is also an intent change: null -> draft -> null must
    // invalidate an older asynchronous preparation without changing recipes.
    draftGeneration += 1;
  }
  /** An asynchronous preparation that began at draft generation `expected` is stale once a draft was created, replaced or discarded. */
  function checkDraftGeneration(expected: number) {
    if (expected !== draftGeneration) throw new WorkspaceError("conflict", "准备更改期间草稿已被创建、替换或放弃；请重新读取，当前草稿已保留。");
  }
  function publish() {
    view = { workspaceId, revision, previewRevision, draft: publicDraft(), undoAvailable: undo?.appliedRevision === revision, lastApplied };
    listeners.forEach((listener) => listener());
  }
  const unsubscribe = port.subscribe(() => {
    const next = port.read();
    const creativeChanged = creativeStateChanged(previous, next);
    const previewChanged = !semanticEqual(previous.currentImage, next.currentImage) || !semanticEqual(previous.comparisonBeforeImage, next.comparisonBeforeImage);
    const displayChanged = [...DISPLAY_ONLY_KEYS].some(key => !semanticEqual(previous[key as keyof CreativeState], next[key as keyof CreativeState]));
    previous = next;
    if (creativeChanged) revision += 1;
    if (previewChanged) previewRevision += 1;
    if (creativeChanged || displayChanged) publish();
  });

  function requireWorkspace(args: Record<string, unknown>, requireRevision = false) {
    if (args.workspaceId !== workspaceId) throw new WorkspaceError("workspace_mismatch", "Choose the current workspace again; the window may have reloaded.", { workspaceId });
    if (requireRevision && (!Number.isInteger(args.expectedRevision) || args.expectedRevision !== revision)) throw new WorkspaceError("conflict", "The workspace changed. Read it again before applying a new draft.", { expectedRevision: args.expectedRevision, currentRevision: revision });
  }

  function read() {
    const raw = port.read();
    const doc = snapshotDocument(raw, previewRevision);
    const activity = port.readActivity() as { isGenerating?: boolean };
    const activeImageRole = raw.activeTab === "inpaint" ? (raw.workbenchImage ? "workbenchImage" : null)
      : ["generate", "postprocess"].includes(raw.activeTab) ? (raw.currentImage ? "currentImage" : raw.workbenchImage ? "workbenchImage" : null) : null;
    const activeImageAssetId = doc.assets.find(asset => asset.role === activeImageRole)?.id ?? null;
    return { workspaceId, revision, previewRevision, state: doc.state, assets: assetManifest(doc.assets), activeImageAssetId,
      activeImageContext: activity.isGenerating ? "last completed image or input; the live generation preview is not attached"
        : activeImageAssetId === "workbenchImage" && !["inpaint","postprocess"].includes(raw.activeTab) && !(raw.activeTab === "generate" && ["i2i","enhance"].includes(raw.generateMode)) ? "input thumbnail; central result canvas has no image" : "current editing surface",
      activity, capabilities, draft: publicDraft(), undoAvailable: undo?.appliedRevision === revision };
  }

  function checkDraft(selected: StoredWorkspaceDraft) {
    if (draft !== selected) throw new WorkspaceError("conflict", "The draft changed while preparing this operation.");
    if (selected.baseRevision !== revision) throw new WorkspaceError("conflict", "This draft predates a manual change. Create a new draft.", { currentRevision: revision, draftRevision: selected.baseRevision });
  }
  function selectDraft(draftId: unknown) {
    if (!draft || draft.draftId !== draftId) throw new WorkspaceError("draft_not_found", "The requested draft is no longer available.");
    checkDraft(draft);
    return draft;
  }
  function applyDraft(selected: StoredWorkspaceDraft) {
    checkDraft(selected);
    const before = structuredClone(port.read());
    const restore = selected.kind === "source_selection";
    port.apply(selected.patch, restore);
    const state = Object.fromEntries(Object.keys(selected.patch).map(key => [key, before[key as keyof CreativeState]]));
    const appliedDisplay = Object.fromEntries([...DISPLAY_ONLY_KEYS].map(key => [key, structuredClone(port.read()[key as keyof CreativeState])]));
    undo = { state, appliedRevision: revision, appliedDisplay, restore };
    lastApplied = { draftId: selected.draftId, kind: selected.kind, revision, previewRevision };
    replaceDraft();
    publish();
    return revision;
  }

  /** The state a review or capture reads: the visible state, or that state with one unapplied draft or one detached t2i text patch. */
  function reviewTarget(args: Record<string, unknown>) {
    const beforeRevision = revision, selectedDraft = args.draftId === undefined ? undefined : selectDraft(args.draftId);
    const baseline = structuredClone(port.read());
    const detached = args.patch === undefined ? undefined : validateScenePatch(args.patch, baseline);
    return { beforeRevision, selectedDraft, detached, state: { ...baseline, ...(detached ?? selectedDraft?.patch ?? {}) } as CreativeState };
  }

  /** collect_canvas_preparation (capture_canvas_recipe in the host): read only, nothing is adopted or changed. */
  async function collectCanvasPreparation(args: Record<string, unknown>) {
    requireWorkspace(args);
    if (!port.collectPreparation) throw new WorkspaceError("workspace_unavailable", "This window cannot capture the canvas into a recipe.");
    if (Object.keys(args).some(key => !["workspaceId", "expectedRevision", "mode", "draftId", "patch"].includes(key)) || !GENERATION_MODES.includes(args.mode as GenerationMode) || (args.draftId !== undefined && typeof args.draftId !== "string") || (args.patch !== undefined && (args.mode !== "t2i" || args.draftId !== undefined))) throw new WorkspaceError("invalid_argument", "Choose a recipe mode and optionally the current draft or a detached t2i text patch.");
    const stale = () => new WorkspaceError("conflict", `The canvas is at revision ${revision}, not ${String(args.expectedRevision)}: it changed. Read the workspace again and capture its current revision.`, { expectedRevision: args.expectedRevision, currentRevision: revision });
    if (args.expectedRevision !== revision) throw stale();
    if ((port.readActivity() as { maskEditing?: boolean })?.maskEditing) throw new WorkspaceError("workspace_busy", "Finish the current mask stroke before capturing the canvas.");
    const { beforeRevision, selectedDraft, detached, state } = reviewTarget(args);
    const preparation = await port.collectPreparation(state, args.mode as GenerationMode);
    // Reading the source image awaited: the canvas, its draft and the mask stroke must still be as captured.
    if (revision !== beforeRevision) throw stale();
    if (selectedDraft) checkDraft(selectedDraft);
    if ((port.readActivity() as { maskEditing?: boolean })?.maskEditing) throw new WorkspaceError("workspace_busy", "A mask stroke started while capturing; capture again once it ends.");
    // Not captured: an unapplied draft beside the visible state; the host passes this notice on to the readback.
    return { schemaVersion: 1, workspaceId, revision, mode: args.mode as GenerationMode, draftId: selectedDraft?.draftId ?? null, patched: detached !== undefined, unappliedDraftId: selectedDraft ? null : draft?.draftId ?? null, preparation };
  }

  async function execute(method: string, args: Record<string, unknown>): Promise<unknown> {
    if (method === "collect_canvas_preparation") return collectCanvasPreparation(args);
    if (method === "list_workspaces") return { workspaces: [{ workspaceId, title: `${APP_NAME} · 当前作品`, revision, capabilities }] };
    requireWorkspace(args, !["read_workspace"].includes(method));
    if (method === "read_workspace") return read();
    if ((port.readActivity() as { maskEditing?: boolean })?.maskEditing) throw new WorkspaceError("workspace_busy", "Finish the current mask stroke before reading images or changing the workspace.");
    if (method === "read_prompt_review") {
      if (!port.promptReview) throw new WorkspaceError("unavailable", "Effective prompt review is not enabled in this window.");
      if (Object.keys(args).some(key => !["workspaceId", "expectedRevision", "mode", "draftId", "patch"].includes(key)) || !GENERATION_MODES.includes(args.mode as GenerationMode) || (args.draftId !== undefined && typeof args.draftId !== "string") || (args.patch !== undefined && (args.mode !== "t2i" || args.draftId !== undefined))) throw new WorkspaceError("invalid_argument", "Choose a supported review mode and optional current draft, or a detached t2i text patch.");
      const { state, beforeRevision, selectedDraft } = reviewTarget(args);
      const reviewInput = await port.promptReview(state, args.mode as GenerationMode);
      requireWorkspace({ ...args, expectedRevision: beforeRevision }, true);
      if (selectedDraft) checkDraft(selectedDraft);
      if ((port.readActivity() as { maskEditing?: boolean })?.maskEditing) throw new WorkspaceError("workspace_busy", "Finish the mask stroke and read the review again.");
      return { schemaVersion: 1, workspaceId, revision, mode: args.mode as GenerationMode, draftId: selectedDraft?.draftId ?? null, reviewInput } satisfies PromptReviewResult;
    }
    if (method === "get_asset") {
      const asset = snapshotDocument(port.read(), previewRevision).assets.find((item) => item.id === args.assetId);
      if (!asset) throw new WorkspaceError("asset_not_found", "This image is not part of the current workspace manifest.");
      return { mimeType: asset.mimeType, ...(asset.data ? { data: asset.data } : { path: asset.path }) };
    }
    if (method === "draft_edit") {
      const baseRevision = revision;
      const baseDraftGeneration = draftGeneration;
      const before = port.read();
      const patch = validatePatch(args.patch, before);
      await port.validateImages(patch);
      requireWorkspace({ ...args, expectedRevision: baseRevision }, true);
      checkDraftGeneration(baseDraftGeneration);
      const changes = summarizeChanges(before, patch);
      if (!changes.length) throw new WorkspaceError("no_changes", "The draft matches the current workspace.");
      replaceDraft({ draftId: `draft-${crypto.randomUUID()}`, baseRevision, kind: "edit", changes, patch: structuredClone(patch) });
      publish();
      return publicDraft();
    }
    if (method === "apply_edit") {
      applyDraft(selectDraft(args.draftId));
      return read();
    }
    if (method === "undo_edit") {
      if (!undo) throw new WorkspaceError("undo_unavailable", "There is no bridge edit to undo.");
      if (undo.appliedRevision !== revision) throw new WorkspaceError("conflict", "A manual change followed this edit. Undo would overwrite it; read the current state instead.", { currentRevision: revision });
      const previousUndo = undo;
      const current = port.read();
      const preserveDisplay = new Set([...DISPLAY_ONLY_KEYS].filter(key => !semanticEqual(current[key as keyof CreativeState], previousUndo.appliedDisplay[key as keyof CreativeState])));
      // Comparison pairs and tool surfaces are coherent groups: preserving a
      // newer current image must not restore an unrelated old comparison image.
      for (const group of [
        ["currentImage", "comparisonBeforeImage", "comparisonSurface"],
        ["activeTab", "activeCanvasSurface", "generateMode", "postprocessMode"],
        ["brushSize", "brushOpacity", "brushColor", "brushMode", "brushShape"],
      ]) if (group.some(key => preserveDisplay.has(key))) group.forEach(key => preserveDisplay.add(key));
      const state = Object.fromEntries(Object.entries(previousUndo.state).filter(([key]) => !preserveDisplay.has(key)));
      port.apply(state, previousUndo.restore);
      undo = undefined;
      replaceDraft();
      publish();
      return read();
    }
    throw new WorkspaceError("method_not_found", `Unsupported workspace method: ${method}`);
  }

  function handle(request: WorkspaceRequest): Promise<WorkspaceResponse> {
    const fingerprint = JSON.stringify([request.method, request.args]);
    const seen = pending.get(request.requestId);
    if (seen) return seen.fingerprint === fingerprint ? seen.response : Promise.resolve({ requestId: request.requestId, error: { code: "request_id_reused", message: "A request id cannot be reused for a different operation." } });
    const response = Promise.resolve().then(async (): Promise<WorkspaceResponse> => {
      try {
        if (!request.requestId || typeof request.method !== "string" || !request.args || typeof request.args !== "object" || Array.isArray(request.args)) throw new WorkspaceError("invalid_argument", "Invalid workspace request.");
        return { requestId: request.requestId, result: await execute(request.method, request.args) };
      } catch (error) { return { requestId: request.requestId, error: workspaceErrorInfo(error) }; }
    });
    pending.set(request.requestId, { fingerprint, response });
    // Correlation is bounded for a long-running renderer. No background retries.
    if (pending.size > 128) pending.delete(pending.keys().next().value!);
    return response;
  }

  return {
    handle,
    execute,
    read,
    /** Local UI entry: resolves an explicitly selected image without first
     * replacing the canvas. Never exposed as another public RPC method. */
    async stageClientSource(asset: WorkspaceAsset, mode: GenerationSourceMode, loadSource: () => Promise<{ data: string; mimeType: string }>, name: string, expectedRevision = revision) {
      requireWorkspace({ workspaceId, expectedRevision }, true);
      if (!port.prepareGenerationSource) throw new WorkspaceError("unavailable", "当前作品的源图服务尚未就绪。");
      if (draft) throw new WorkspaceError("unapplied_draft", "请先应用或放弃待应用更改，再选择输入图片。");
      // A batch already queued keeps its own frozen source, so only an unfinished mask stroke blocks a new source.
      const activity = port.readActivity() as { maskEditing?: boolean };
      if (activity.maskEditing) throw new WorkspaceError("workspace_busy", "请先结束当前绘制，再替换输入图片。");
      const baseRevision = revision, basePreviewRevision = previewRevision, baseDraftGeneration = draftGeneration, before = structuredClone(port.read());
      const checkSourceContext = () => {
        requireWorkspace({ workspaceId, expectedRevision: baseRevision }, true);
        checkDraftGeneration(baseDraftGeneration);
        const latest = port.readActivity() as { maskEditing?: boolean };
        if (previewRevision !== basePreviewRevision || draft || latest.maskEditing) throw new WorkspaceError("conflict", "准备图片期间作品状态已改变，请重新选择。");
      };
      const source = await loadSource();
      checkSourceContext();
      const prepared = await port.prepareGenerationSource(source, asset, mode, before);
      checkSourceContext();
      replaceDraft({ draftId: `draft-${crypto.randomUUID()}`, baseRevision, kind: "source_selection", origin: "client", sourceName: name, changes: summarizeChanges(before, prepared.patch), patch: structuredClone(prepared.patch), generationSource: prepared.source });
      publish();
      return publicDraft();
    },
    getView: () => view,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    discardDraft: () => { replaceDraft(); publish(); },
    dispose: () => { unsubscribe(); listeners.clear(); },
  };
}

export type WorkspaceController = ReturnType<typeof createWorkspaceController>;
