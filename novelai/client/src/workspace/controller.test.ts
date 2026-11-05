import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store";
import { createWorkspaceController, type WorkspacePort } from "./controller";
import { pickCreativeState, snapshotDocument, validatePatch } from "./state";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=";

function setup(overrides: Partial<WorkspacePort> = {}) {
  const apply = vi.fn((patch) => useAppStore.setState(patch));
  const port: WorkspacePort = {
    read: () => pickCreativeState(useAppStore.getState()),
    subscribe: (listener) => useAppStore.subscribe(listener),
    apply,
    validateImages: async () => {},
       readActivity: () => ({ isGenerating: false }),
    ...overrides,
  };
  return { controller: createWorkspaceController(port, "test-workspace"), apply };
}

describe("Live workspace transactions", () => {
  beforeEach(() => { useAppStore.setState(useAppStore.getInitialState(), true); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("reads all characters, sources, references and mask without settings or image bytes in manifest", () => {
    useAppStore.setState({
      workbenchImage: { filePath: "/fixture.png", fileUrl: "localmedia://fixture", width: 1, height: 1 },
      inpaintMask: PNG,
      vibeImages: [{ id: "vibe-1", base64: PNG, previewUrl: `data:image/png;base64,${PNG}`, infoExtracted: 1, strength: .7 }],
      preciseReferences: [{ id: "precise-1", base64: PNG, previewUrl: `data:image/png;base64,${PNG}`, type: "character", strength: .8, fidelity: .6 }],
      charCaptions: [{ id: "a", prompt: "adult woman", useCoords: true, x: .3, y: .5 }, { id: "b", prompt: "adult man", useCoords: true, x: .7, y: .5 }],
      settings: { token: "must-not-appear", modelMode: "anime" } as any,
    });
    const { controller } = setup();
    const read = controller.read();
    expect(read.state.charCaptions).toHaveLength(2);
    expect(read.assets.map((asset) => asset.role)).toEqual(["workbenchImage", "vibeImages", "preciseReferences", "inpaintMask"]);
    expect(read.activeImageAssetId).toBe("workbenchImage");
    expect(JSON.stringify(read)).not.toContain(PNG);
    expect(JSON.stringify(read)).not.toContain("must-not-appear");
    expect(snapshotDocument(pickCreativeState(useAppStore.getState())).assets.find((asset) => asset.role === "inpaintMask")?.data).toBe(PNG);
    controller.dispose();
  });

  it("a draft never changes inputs, and a stale draft cannot overwrite a manual edit even with a fresh revision argument", async () => {
    const { controller, apply } = setup();
    const draft = await controller.execute("draft_edit", { workspaceId: "test-workspace", expectedRevision: 0, patch: { params: { positivePrompt: "sunlit garden" } } }) as any;
    expect(useAppStore.getState().params.positivePrompt).toBe("");
    useAppStore.getState().setParam("positivePrompt", "user's latest drawing");
    await expect(controller.execute("apply_edit", { workspaceId: "test-workspace", expectedRevision: 1, draftId: draft.draftId })).rejects.toMatchObject({ code: "conflict" });
    expect(apply).not.toHaveBeenCalled();
    expect(useAppStore.getState().params.positivePrompt).toBe("user's latest drawing");
    controller.dispose();
  });

  it("applies once to the real Store, keeps an undo, and refuses undo after a manual change", async () => {
    const { controller, apply } = setup();
    const draft = await controller.execute("draft_edit", { workspaceId: "test-workspace", expectedRevision: 0, patch: { params: { positivePrompt: "adult reading a book", steps: 100 } } }) as any;
    const result = await controller.execute("apply_edit", { workspaceId: "test-workspace", expectedRevision: 0, draftId: draft.draftId }) as any;
    expect(useAppStore.getState().params.positivePrompt).toBe("adult reading a book");
    expect(useAppStore.getState().params.steps).toBe(50);
    expect(result.undoAvailable).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
    useAppStore.getState().setParam("width", 1024);
    await expect(controller.execute("undo_edit", { workspaceId: "test-workspace", expectedRevision: controller.getView().revision })).rejects.toMatchObject({ code: "conflict" });
    expect(useAppStore.getState().params.width).toBe(1024);
    controller.dispose();
  });

  it("undo restores the full prior recipe when no manual change intervened", async () => {
    const { controller } = setup();
    const before = useAppStore.getState().params;
    const draft = await controller.execute("draft_edit", { workspaceId: "test-workspace", expectedRevision: 0, patch: { params: { positivePrompt: "evening", cfgScale: 3 }, charCaptions: [{ id: "first", prompt: "adult", useCoords: false, x: .5, y: .5 }] } }) as any;
    await controller.execute("apply_edit", { workspaceId: "test-workspace", expectedRevision: 0, draftId: draft.draftId });
    await controller.execute("undo_edit", { workspaceId: "test-workspace", expectedRevision: controller.getView().revision });
    expect(useAppStore.getState().params).toEqual(before);
    expect(useAppStore.getState().charCaptions).toEqual([]);
    expect(controller.getView().undoAvailable).toBe(false);
    controller.dispose();
  });

  it("stages, applies and undoes an independent recipe without changing base work", async () => {
    const { controller } = setup();
    const before = structuredClone(pickCreativeState(useAppStore.getState()));
    const draft = await controller.execute("draft_edit", { workspaceId: "test-workspace", expectedRevision: 0, patch: { inpaintRecipe: { positivePrompt: "small silver brooch", negativePrompt: "oversized brooch", cfgScale: 4.5 } } }) as any;
    expect(pickCreativeState(useAppStore.getState())).toEqual(before);
    await controller.execute("apply_edit", { workspaceId: "test-workspace", expectedRevision: 0, draftId: draft.draftId });
    const applied = pickCreativeState(useAppStore.getState());
    expect(applied.params).toEqual(before.params);
    expect(applied.charCaptions).toEqual(before.charCaptions);
    expect(applied.inpaintRecipe).toMatchObject({ positivePrompt: "small silver brooch", negativePrompt: "oversized brooch", cfgScale: 4.5 });
    const next = validatePatch({ inpaintRecipe: { steps: 24 } }, { ...applied, params: { ...applied.params, negativePrompt: "new base" } });
    expect(next.inpaintRecipe).toMatchObject({ negativePrompt: "oversized brooch", steps: 24 });
    const changedModel = validatePatch({ inpaintModel: "nai-diffusion-4-5-full-inpainting" }, applied);
    expect(changedModel.inpaintRecipe?.model).toBe("nai-diffusion-4-5-full");
    expect(changedModel.inpaintRecipe?.positivePrompt).toBe("small silver brooch");
    expect(changedModel.params).toBeUndefined();
    expect(() => validatePatch({ inpaintRecipe: { model: "nai-diffusion-3" } }, applied)).toThrow("must match");
    await controller.execute("undo_edit", { workspaceId: "test-workspace", expectedRevision: controller.getView().revision });
    expect(pickCreativeState(useAppStore.getState())).toEqual(before);
    expect(validatePatch({ inpaintRecipe: null }, applied).inpaintRecipe).toBeNull();
    for (const invalid of ["recipe", [], { apiToken: "secret" }, { steps: "24" }, { model: "invalid" }]) {
      expect(() => validatePatch({ inpaintRecipe: invalid }, applied)).toThrow();
    }
    controller.dispose();
  });

  it("rejects old workspace ids, unknown fields and invalid arrays before mutation", async () => {
    const { controller, apply } = setup();
    await expect(controller.execute("read_workspace", { workspaceId: "old-window" })).rejects.toMatchObject({ code: "workspace_mismatch" });
    for (const patch of [{ settings: {} }, { params: { apiToken: "x" } }, { params: { model: "unknown" } }, { charCaptions: "not an array" }, { i2iParams: { strength: -1 } }]) {
      await expect(controller.execute("draft_edit", { workspaceId: "test-workspace", expectedRevision: 0, patch })).rejects.toMatchObject({ code: "invalid_argument" });
    }
    expect(apply).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("maintains request/response ids and deduplicates an in-flight request without executing twice", async () => {
    let resolve!: () => void;
    const validateImages = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const { controller } = setup({ validateImages });
    const request = { requestId: "request-A", method: "draft_edit", args: { workspaceId: "test-workspace", expectedRevision: 0, patch: { params: { positivePrompt: "library" } } } };
    const first = controller.handle(request);
    const duplicate = controller.handle(request);
    await Promise.resolve();
    expect(validateImages).toHaveBeenCalledTimes(1);
    const read = await controller.handle({ requestId: "request-B", method: "read_workspace", args: { workspaceId: "test-workspace" } });
    expect(read.requestId).toBe("request-B");
    resolve();
    expect(await first).toEqual(await duplicate);
    expect((await first).requestId).toBe("request-A");
    expect(await controller.handle({ ...request, method: "apply_edit" })).toMatchObject({ requestId: "request-A", error: { code: "request_id_reused" } });
    controller.dispose();
  });

  it("only resolves assets from the selected revision and never accepts an arbitrary path", async () => {
    useAppStore.setState({ workbenchImage: { filePath: "/fixture.png", fileUrl: "localmedia://fixture", width: 1, height: 1 } });
    const { controller } = setup();
    expect(await controller.execute("get_asset", { workspaceId: "test-workspace", expectedRevision: 0, assetId: "workbenchImage" })).toEqual({ mimeType: "image/png", path: "/fixture.png" });
    await expect(controller.execute("get_asset", { workspaceId: "test-workspace", expectedRevision: 0, assetId: "/private/other" })).rejects.toMatchObject({ code: "asset_not_found" });
    useAppStore.getState().setParam("positivePrompt", "new source context");
    await expect(controller.execute("get_asset", { workspaceId: "test-workspace", expectedRevision: 0, assetId: "workbenchImage" })).rejects.toMatchObject({ code: "conflict" });
    controller.dispose();
  });

  it("browses history with a separate preview identity while keeping source, Mask and draft unchanged", async () => {
    const source = { filePath: "/source.png", fileUrl: "localmedia://source", width: 1, height: 1 };
    const first = { ...source, id: "first", filePath: "/first.png", date: "2026-09-11" } as any;
    const second = { ...first, id: "second", filePath: "/second.png" };
    useAppStore.setState({ currentImage: first, workbenchImage: source, i2iOriginalImage: source, inpaintMask: PNG });
    const { controller } = setup(), args = { workspaceId: "test-workspace", expectedRevision: 0 };
    const draft = await controller.execute("draft_edit", { ...args, patch: { params: { positivePrompt: "sunlit garden" } } }) as any;
    const previousId = controller.read().activeImageAssetId!;
    useAppStore.getState().selectImage(second);
    const read = controller.read();
    expect(read.revision).toBe(0); expect(read.previewRevision).toBe(1);
    expect(read.activeImageAssetId).not.toBe(previousId);
    expect((read.state.currentImage as { assetId: string }).assetId).toBe(read.activeImageAssetId);
    expect(await controller.execute("get_asset", { ...args, assetId: read.activeImageAssetId })).toEqual({ mimeType: "image/png", path: "/second.png" });
    await expect(controller.execute("get_asset", { ...args, assetId: previousId })).rejects.toMatchObject({ code: "asset_not_found" });
    expect(useAppStore.getState()).toMatchObject({ workbenchImage: source, i2iOriginalImage: source, inpaintMask: PNG });
    await controller.execute("apply_edit", { ...args, draftId: draft.draftId });
    expect(useAppStore.getState().currentImage?.id).toBe("second");
    expect(controller.read().revision).toBe(1);
    useAppStore.setState({ workbenchImage: { ...source, filePath: "/changed-source.png" } });
    expect(controller.read().revision).toBe(2);
    useAppStore.getState().setInpaintMask(null); expect(controller.read().revision).toBe(3);
    controller.dispose();
  });

  it("undoes only the authored edit while preserving later preview, navigation and brush choices", async () => {
    const { controller } = setup(), args = { workspaceId: "test-workspace", expectedRevision: 0 };
    const draft = await controller.execute("draft_edit", { ...args, patch: { params: { positivePrompt: "sunlit garden" } } }) as any;
    await controller.execute("apply_edit", { ...args, draftId: draft.draftId });
    const image = { id: "browse", filePath: "/browse.png", fileUrl: "localmedia://browse", width: 1, height: 1 } as any;
    useAppStore.setState({ currentImage: image, activeTab: "inpaint", activeCanvasSurface: "inpaint", brushSize: 123 });
    expect(controller.read().revision).toBe(1);
    await controller.execute("undo_edit", { ...args, expectedRevision: 1 });
    expect(useAppStore.getState()).toMatchObject({ params: { positivePrompt: "" }, currentImage: image, activeTab: "inpaint", activeCanvasSurface: "inpaint", brushSize: 123 });
    controller.dispose();
  });

  it("keeps a newer comparison group intact when undoing a source selection", async () => {
    const picture = (id: string) => ({ id, filePath: `/${id}.png`, fileUrl: `localmedia://${id}`, width: 1, height: 1 }) as any;
    useAppStore.setState({ currentImage: picture("before"), comparisonBeforeImage: picture("old-comparison"), comparisonSurface: "generate:t2i" });
    const original = pickCreativeState(useAppStore.getState());
    const source = { assetId: "currentImage", role: "currentImage", mode: "i2i" as const, sha256: "a".repeat(64), width: 1, height: 1, maskPolicy: "clear" as const, clearedMask: false };
    const { controller } = setup({ prepareGenerationSource: async () => ({ patch: { currentImage: null, workbenchImage: picture("selected"), comparisonBeforeImage: null, comparisonSurface: null }, source }) });
    const args = { workspaceId: "test-workspace", expectedRevision: 0 };
    const draft = await controller.stageClientSource({ id: "currentImage", role: "currentImage", mimeType: "image/png" }, "i2i", async () => ({ mimeType: "image/png", data: PNG }), "fixture") as any;
    await controller.execute("apply_edit", { ...args, draftId: draft.draftId });
    useAppStore.setState({ currentImage: picture("latest-preview") });
    await controller.execute("undo_edit", { ...args, expectedRevision: 1 });
    expect(useAppStore.getState()).toMatchObject({ currentImage: { id: "latest-preview" }, comparisonBeforeImage: null, comparisonSurface: null, workbenchImage: original.workbenchImage });
    controller.dispose();
  });

  it("preserves bounded replay metadata when a saved recipe is validated for restoration", () => {
    const current = pickCreativeState(useAppStore.getState());
    const metadataReplay = { model: "nai-diffusion-5-full", parameters: { quality_boost: true }, positive: {}, negative: {}, keepEmptyNegativeCharacters: false };
    expect(validatePatch({ params: { ...current.params, metadataReplay } }, current).params?.metadataReplay).toEqual(metadataReplay);
    expect(() => validatePatch({ params: { metadataReplay: { ...metadataReplay, parameters: { token: "secret" } } } }, current)).toThrow("Unsupported metadata replay parameter");
  });

  it("keeps manual tool selection and the shared surface in one Store update", () => {
    const { controller } = setup();
    useAppStore.getState().setGenerateMode("i2i");
    expect(controller.getView().revision).toBe(0);
    expect(controller.read().state).toMatchObject({ generateMode: "i2i", activeCanvasSurface: "generate:i2i" });
    useAppStore.getState().setActiveTab("postprocess");
    useAppStore.getState().setPostprocessMode("director");
    expect(controller.read().state).toMatchObject({ postprocessMode: "director", activeCanvasSurface: "postprocess:director" });
    useAppStore.getState().setActiveTab("generate");
    expect(controller.read().state.activeCanvasSurface).toBe("generate:i2i");
    controller.dispose();
  });

  it("reports an unfinished mask stroke and rejects image reads or apply until it ends", async () => {
    const { controller, apply } = setup({ readActivity: () => ({ maskEditing: true }) });
    expect(controller.read().activity).toMatchObject({ maskEditing: true });
    await expect(controller.execute("get_asset", { workspaceId: "test-workspace", expectedRevision: 0, assetId: "currentImage" })).rejects.toMatchObject({ code: "workspace_busy" });
    await expect(controller.execute("apply_edit", { workspaceId: "test-workspace", expectedRevision: 0, draftId: "draft" })).rejects.toMatchObject({ code: "workspace_busy" });
    expect(apply).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("collects a canvas preparation at the exact revision, with a draft or a detached patch, without adopting or changing anything", async () => {
    const collectPreparation = vi.fn(async (state: any, mode: any) => ({ mode, authored: { params: { positivePrompt: state.params.positivePrompt } }, assets: [] }));
    const { controller, apply } = setup({ collectPreparation, readActivity: () => ({ isGenerating: true }) });
    useAppStore.getState().setParam("positivePrompt", "harbor at dawn");
    const revision = controller.getView().revision;
    const base = { workspaceId: "test-workspace", expectedRevision: revision, mode: "t2i" };
    // A running generation (or queue item) does not block a read-only capture.
    expect(await controller.execute("collect_canvas_preparation", base)).toEqual({ schemaVersion: 1, workspaceId: "test-workspace", revision, mode: "t2i", draftId: null, patched: false, unappliedDraftId: null, preparation: { mode: "t2i", authored: { params: { positivePrompt: "harbor at dawn" } }, assets: [] } });
    const draft = await controller.execute("draft_edit", { workspaceId: "test-workspace", expectedRevision: revision, patch: { params: { positivePrompt: "harbor at dusk" } } }) as any;
    const drafted = await controller.execute("collect_canvas_preparation", { ...base, draftId: draft.draftId }) as any;
    expect(drafted).toMatchObject({ draftId: draft.draftId, patched: false, unappliedDraftId: null, preparation: { authored: { params: { positivePrompt: "harbor at dusk" } } } });
    // Without draftId beside that unapplied draft: the visible state, and the draft named as not captured (review rework P3-1).
    expect(await controller.execute("collect_canvas_preparation", base)).toMatchObject({ draftId: null, unappliedDraftId: draft.draftId, preparation: { authored: { params: { positivePrompt: "harbor at dawn" } } } });
    expect(controller.getView()).toMatchObject({ revision, draft: { draftId: draft.draftId }, undoAvailable: false });
    expect(useAppStore.getState().params.positivePrompt).toBe("harbor at dawn");
    const detached = await controller.execute("collect_canvas_preparation", { ...base, patch: { params: { positivePrompt: "harbor at noon" } } }) as any;
    expect(detached).toMatchObject({ draftId: null, patched: true, unappliedDraftId: draft.draftId, preparation: { authored: { params: { positivePrompt: "harbor at noon" } } } });
    expect(apply).not.toHaveBeenCalled();
    await expect(controller.execute("collect_canvas_preparation", { ...base, expectedRevision: revision - 1 })).rejects.toMatchObject({ code: "conflict", details: { currentRevision: revision } });
    await expect(controller.execute("collect_canvas_preparation", { ...base, draftId: "draft-gone" })).rejects.toMatchObject({ code: "draft_not_found" });
    await expect(controller.execute("collect_canvas_preparation", { ...base, mode: "i2i", patch: { params: {} } })).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(controller.execute("collect_canvas_preparation", { ...base, workspaceId: "old-window" })).rejects.toMatchObject({ code: "workspace_mismatch" });
    expect(collectPreparation).toHaveBeenCalledTimes(4);
    controller.dispose();
  });

  it("refuses a capture when the canvas changes or a mask stroke starts while its source is read", async () => {
    let resolve!: (value: any) => void;
    const collectPreparation = vi.fn(() => new Promise<any>(done => { resolve = done; }));
    let maskEditing = false;
    const { controller } = setup({ collectPreparation, readActivity: () => ({ maskEditing }) });
    const pending = controller.execute("collect_canvas_preparation", { workspaceId: "test-workspace", expectedRevision: 0, mode: "t2i" });
    await Promise.resolve();
    useAppStore.getState().setParam("positivePrompt", "hand edit during capture");
    resolve({ mode: "t2i", authored: {}, assets: [] });
    await expect(pending).rejects.toMatchObject({ code: "conflict" });
    const revision = controller.getView().revision;
    const stroke = controller.execute("collect_canvas_preparation", { workspaceId: "test-workspace", expectedRevision: revision, mode: "t2i" });
    await Promise.resolve();
    maskEditing = true;
    resolve({ mode: "t2i", authored: {}, assets: [] });
    await expect(stroke).rejects.toMatchObject({ code: "workspace_busy" });
    await expect(controller.execute("collect_canvas_preparation", { workspaceId: "test-workspace", expectedRevision: revision, mode: "t2i" })).rejects.toMatchObject({ code: "workspace_busy" });
    const { controller: plain } = setup();
    await expect(plain.execute("collect_canvas_preparation", { workspaceId: "test-workspace", expectedRevision: 0, mode: "t2i" })).rejects.toMatchObject({ code: "workspace_unavailable" });
    controller.dispose(); plain.dispose();
  });

  it("keeps history filters out of the workspace snapshot and preserves current filters through apply and undo", async () => {
    vi.stubGlobal("window", { naiDesktop: { getHistory: vi.fn().mockResolvedValue([]), setSetting: vi.fn().mockResolvedValue(undefined) } });
    useAppStore.setState({ selectedDate: "saved-day", selectedGroupId: "saved-gallery", generationGroupId: "output-destination" });
    const document = snapshotDocument(pickCreativeState(useAppStore.getState()));
    expect(document.state).not.toHaveProperty("selectedDate");
    expect(document.state).not.toHaveProperty("selectedGroupId");
    expect(document.state.generationGroupId).toBe("output-destination");
    useAppStore.getState().setParam("positivePrompt", "current artwork");
    await useAppStore.getState().setSelectedDate("current-day");
    await useAppStore.getState().setSelectedGroupId("current-gallery");
    const { controller } = setup();
    const draft = await controller.execute("draft_edit", { workspaceId: "test-workspace", expectedRevision: 0, patch: { params: { positivePrompt: "edited artwork" } } }) as any;
    await controller.execute("apply_edit", { workspaceId: "test-workspace", expectedRevision: 0, draftId: draft.draftId });
    expect(useAppStore.getState()).toMatchObject({ selectedDate: "current-day", selectedGroupId: "current-gallery", params: { positivePrompt: "edited artwork" } });
    const appliedRevision = controller.getView().revision;
    await useAppStore.getState().setSelectedDate("later-day");
    await useAppStore.getState().setSelectedGroupId("later-gallery");
    expect(controller.getView().revision).toBe(appliedRevision);
    await controller.execute("undo_edit", { workspaceId: "test-workspace", expectedRevision: appliedRevision });
    expect(useAppStore.getState()).toMatchObject({ selectedDate: "later-day", selectedGroupId: "later-gallery", params: { positivePrompt: "current artwork" }, generationGroupId: "output-destination" });
    controller.dispose();
  });
});
