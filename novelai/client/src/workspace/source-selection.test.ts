import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store";
import { DEFAULT_PARAMS, type HistoryItem } from "../types";
import { createRendererWorkspace } from "./adapter";
import { pickCreativeState } from "./state";
import { freezeGenerationInput } from "./generation-input";
import type { GenerationSourceMode } from "./source-selection";
import { waitUntil } from '../test-support/wait-until';

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=";
const PNG_SHA = createHash("sha256").update(Buffer.from(PNG, "base64")).digest("hex");
const priorInput = { filePath: "/fixture/prior-source.png", fileUrl: `data:image/png;base64,${PNG}`, width: 1, height: 1 };
const result: HistoryItem = { id: "completed-result", filePath: "/fixture/completed.png", fileUrl: `data:image/png;base64,${PNG}`, width: 1, height: 1, date: "2026-09-10", createdAt: "2026-09-10T18:00:00Z", actualSeed: 42, model: "nai-diffusion-5-full", params: { ...DEFAULT_PARAMS } };
const disposals: Array<() => void> = [];
let maskEditing = false;
let mainWorkbenchPath: string | null;
let savedCopies: Uint8Array[];
let commit: ReturnType<typeof vi.fn>;
let save: ReturnType<typeof vi.fn>;

function setup() {
  const workspace = createRendererWorkspace();
  disposals.push(workspace.dispose);
  const args = () => ({ workspaceId: workspace.getView().workspaceId, expectedRevision: workspace.getView().revision });
  // The manual "use this image" path: an explicitly chosen workspace image, staged as a reviewable draft.
  const asset = (assetId: string) => { const found = workspace.read().assets.find(item => item.id === assetId); if (!found) throw new Error(`fixture asset ${assetId} is missing`); return found; };
  const stage = (mode: GenerationSourceMode = "i2i", assetId = "currentImage", source: Record<string, unknown> = { mimeType: "image/png", data: PNG }, expectedRevision?: number) =>
    workspace.stageClientSource(asset(assetId), mode, async () => source as { mimeType: string; data: string }, "fixture source", expectedRevision) as Promise<any>;
  const apply = async (draft: any) => workspace.execute("apply_edit", { ...args(), draftId: draft.draftId });
  const undo = async () => workspace.execute("undo_edit", args());
  return { workspace, stage, apply, undo, args };
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  maskEditing = false;
  mainWorkbenchPath = priorInput.filePath;
  savedCopies = [];
  commit = vi.fn((path: string | null) => { mainWorkbenchPath = path; return { ok: true }; });
  save = vi.fn(async (images: Array<{ bytes: Uint8Array }>) => images.map(({ bytes }) => { savedCopies.push(new Uint8Array(bytes)); return `/fixture/prepared-${savedCopies.length}.png`; }));
  vi.stubGlobal("document", { querySelector: () => maskEditing ? {} : null });
  vi.stubGlobal("Image", class {
    naturalWidth = 1; naturalHeight = 1;
    onload?: () => void;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  });
  vi.stubGlobal("window", { naiDesktop: { savePastedImageFiles: save, commitWorkbench: commit, onGenerationJob: () => () => {}, setSetting: vi.fn(async () => {}) } });
  useAppStore.setState({
    currentImage: result, workbenchImage: priorInput, i2iOriginalImage: { ...priorInput, filePath: "/fixture/older-original.png" },
    i2iSourceMode: "latest", inpaintSourceMode: "latest", inpaintMask: PNG, maskRevision: 7,
    comparisonBeforeImage: priorInput, comparisonSurface: "generate:t2i", activeCanvasSurface: "generate:t2i",
    params: { ...DEFAULT_PARAMS, model: "nai-diffusion-5-full", positivePrompt: "adult gardener, sunlit garden" },
    inpaintPositivePrompt: "blue cotton jacket", inpaintModel: "nai-diffusion-5-full-inpainting",
  });
});
afterEach(() => { disposals.splice(0).forEach((dispose) => dispose()); vi.unstubAllGlobals(); });

describe("generation source selection through the real renderer adapter", () => {
  it.each(["enhance", "upscale", "director"] as const)("selects a real source for %s, keeps its recipe and undoes the complete prior workbench", async (mode) => {
    if (mode === "upscale") useAppStore.setState({ upscaleScale: 2 });
    const h = setup(), before = structuredClone(pickCreativeState(useAppStore.getState()));
    const draft = await h.stage(mode);
    expect(draft.generationSource).toMatchObject({ mode, assetId: "currentImage", sha256: PNG_SHA });
    expect(pickCreativeState(useAppStore.getState())).toEqual(before);
    await h.apply(draft);
    const state = pickCreativeState(useAppStore.getState());
    expect(state).toMatchObject({ currentImage: null, workbenchImage: { filePath: mainWorkbenchPath }, i2iOriginalImage: { filePath: mainWorkbenchPath }, inpaintMask: null });
    expect(state.activeTab).toBe(mode === "enhance" ? "generate" : "postprocess");
    expect(state.activeCanvasSurface).toBe(`${mode === "enhance" ? "generate" : "postprocess"}:${mode}`);
    expect(mode === "enhance" ? state.generateMode : state.postprocessMode).toBe(mode);
    expect(h.workspace.read().activeImageAssetId).toBe("workbenchImage");
    expect(state.params).toEqual(before.params);
    expect(state.augmentOptions).toEqual(before.augmentOptions);
    const frozen = await freezeGenerationInput(state, mode, async (image) => ({ mimeType: "image/png", data: image.fileUrl.split(",")[1] }));
    expect(createHash("sha256").update(Buffer.from(frozen.sourceImage!.data, "base64")).digest("hex")).toBe(PNG_SHA);
    await h.undo();
    expect(pickCreativeState(useAppStore.getState())).toEqual({ ...before, maskRevision: before.maskRevision + 2 });
    expect(mainWorkbenchPath).toBe(priorInput.filePath);
  });

  it.each(["i2i", "inpaint"] as const)("freezes a completed result for %s, applies the same main/renderer source and fully restores the prior work", async (mode) => {
    const h = setup();
    const before = structuredClone(pickCreativeState(useAppStore.getState()));
    const draft = await h.stage(mode);
    expect(draft).toMatchObject({ kind: "source_selection", generationSource: { assetId: "currentImage", role: "currentImage", mode, sha256: PNG_SHA, width: 1, height: 1, maskPolicy: "clear", clearedMask: true } });
    expect(JSON.stringify(draft)).not.toContain(PNG);
    expect(JSON.stringify(draft)).not.toContain("/fixture/");
    expect(savedCopies).toHaveLength(1);
    expect(createHash("sha256").update(savedCopies[0]).digest("hex")).toBe(PNG_SHA);
    expect(pickCreativeState(useAppStore.getState())).toEqual(before);
    expect(mainWorkbenchPath).toBe(priorInput.filePath);
    expect(commit).not.toHaveBeenCalled();

    await h.apply(draft);
    const applied = pickCreativeState(useAppStore.getState());
    expect(mainWorkbenchPath).toBe(applied.workbenchImage.filePath);
    expect(applied.workbenchImage).toEqual(applied.i2iOriginalImage);
    expect(applied).toMatchObject({ currentImage: null, comparisonBeforeImage: null, comparisonSurface: null, inpaintMask: null, maskRevision: 8, i2iSourceMode: "original", inpaintSourceMode: "original" });
    expect(applied.activeTab).toBe(mode === "i2i" ? "generate" : "inpaint");
    expect(applied.activeCanvasSurface).toBe(mode === "i2i" ? "generate:i2i" : "inpaint");
    expect(applied.params).toEqual(before.params);
    expect(applied.inpaintModel).toEqual(before.inpaintModel);
    expect(h.workspace.read()).toMatchObject({ activeImageAssetId: "workbenchImage", activeImageContext: "current editing surface" });

    // The existing generation freeze must select these bytes after application.
    // A new inpaint Mask would be explicitly supplied separately by the user.
    const input = await freezeGenerationInput({ ...applied, ...(mode === "inpaint" ? { inpaintMask: PNG } : {}) }, mode, async (image) => ({ mimeType: "image/png", data: image.fileUrl.split(",")[1] }));
    expect(createHash("sha256").update(Buffer.from(input.sourceImage!.data, "base64")).digest("hex")).toBe(PNG_SHA);
    await h.undo();
    expect(pickCreativeState(useAppStore.getState())).toEqual({ ...before, maskRevision: 9 });
    expect(mainWorkbenchPath).toBe(priorInput.filePath);
    expect(h.workspace.read().activeImageAssetId).toBe(h.workspace.read().assets.find(asset => asset.role === "currentImage")?.id);
    expect(h.workspace.getView().undoAvailable).toBe(false);
  });

  it("uses a loaded reference without inventing history or changing prompts, models or references", async () => {
    const reference = { id: "loaded-reference", base64: PNG, previewUrl: `data:image/png;base64,${PNG}`, infoExtracted: .6, strength: .5 };
    useAppStore.setState({ currentImage: null, vibeImages: [reference], inpaintMask: null });
    const h = setup();
    const draft = await h.stage("i2i", "vibeImages:loaded-reference");
    expect(draft.generationSource).toMatchObject({ role: "vibeImages", clearedMask: false });
    await h.apply(draft);
    expect(useAppStore.getState().currentImage).toBeNull();
    expect(useAppStore.getState().vibeImages).toEqual([reference]);
    expect(useAppStore.getState().history).toEqual([]);
    expect(h.workspace.read().activeImageAssetId).toBe("workbenchImage");
  });

  it("refuses Mask sources and arbitrary paths before preparation", async () => {
    const h = setup();
    await expect(h.stage("i2i", "inpaintMask")).rejects.toMatchObject({ code: "invalid_source" });
    await expect(h.stage("i2i", "currentImage", { mimeType: "image/png", data: PNG, path: "/untrusted.png" })).rejects.toMatchObject({ code: "invalid_source" });
    expect(save).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it("does not stage a source whose current manifest dimensions disagree with its bytes", async () => {
    useAppStore.setState({ currentImage: { ...result, width: 2 } });
    const h = setup();
    await expect(h.stage()).rejects.toMatchObject({ code: "invalid_source" });
    expect(h.workspace.getView().draft).toBeUndefined();
    expect(commit).not.toHaveBeenCalled();
  });

  it("rejects stale source selection and an asynchronous preparation that overlaps a manual edit", async () => {
    const h = setup();
    let complete!: (paths: string[]) => void;
    save.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const pending = h.stage();
    await waitUntil(() => expect(save).toHaveBeenCalledOnce());
    useAppStore.getState().setParam("positivePrompt", "manual garden composition");
    complete(["/fixture/prepared.png"]);
    await expect(pending).rejects.toMatchObject({ code: "conflict" });
    await expect(h.stage("i2i", "currentImage", undefined, 0)).rejects.toMatchObject({ code: "conflict" });
    expect(h.workspace.getView().draft).toBeUndefined();
    expect(mainWorkbenchPath).toBe(priorInput.filePath);
    expect(useAppStore.getState().params.positivePrompt).toBe("manual garden composition");
  });

  it("preserves old inputs and the reviewable draft when main rejects its workbench commit", async () => {
    const h = setup();
    const before = structuredClone(pickCreativeState(useAppStore.getState()));
    const draft = await h.stage();
    commit.mockReturnValueOnce({ ok: false, message: "Prepared image was removed" });
    await expect(h.apply(draft)).rejects.toMatchObject({ code: "restore_failed" });
    expect(pickCreativeState(useAppStore.getState())).toEqual(before);
    expect(mainWorkbenchPath).toBe(priorInput.filePath);
    expect(h.workspace.getView().draft?.draftId).toBe(draft.draftId);
    expect(h.workspace.getView().undoAvailable).toBe(false);
  });

  it("rejects a source selection if its preview changes while preparing, without changing the creative version", async () => {
    const h = setup();
    let complete!: (paths: string[]) => void;
    save.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const pending = h.stage();
    await waitUntil(() => expect(save).toHaveBeenCalledOnce());
    useAppStore.getState().selectImage({ ...result, id: "newer-preview", filePath: "/fixture/newer-preview.png" });
    expect(h.workspace.read().revision).toBe(0);
    complete(["/fixture/prepared.png"]);
    await expect(pending).rejects.toMatchObject({ code: "conflict" });
    expect(h.workspace.getView().draft).toBeUndefined();
    expect(mainWorkbenchPath).toBe(priorInput.filePath);
    expect(useAppStore.getState().currentImage?.id).toBe("newer-preview");
  });

  it("rejects applying after manual changes and undoing over later user work", async () => {
    const h = setup();
    const stale = await h.stage();
    useAppStore.getState().setParam("steps", 23);
    await expect(h.apply(stale)).rejects.toMatchObject({ code: "conflict" });
    expect(commit).not.toHaveBeenCalled();
    h.workspace.discardDraft();
    const fresh = await h.stage();
    await h.apply(fresh);
    useAppStore.getState().setParam("positivePrompt", "new manual drawing");
    await expect(h.undo()).rejects.toMatchObject({ code: "conflict" });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().params.positivePrompt).toBe("new manual drawing");
  });

  it("blocks source staging during a Mask stroke; a running batch (frozen, step 4a) does not block it", async () => {
    const h = setup();
    maskEditing = true;
    await expect(h.stage()).rejects.toMatchObject({ code: "workspace_busy" });
    expect(save).not.toHaveBeenCalled();
    maskEditing = false;
    useAppStore.setState({ isGenerating: true });
    const draft = await h.stage();
    await h.apply(draft);
    expect(commit).toHaveBeenCalled();
  });
});
