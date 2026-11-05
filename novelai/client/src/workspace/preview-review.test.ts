import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PNG } from "pngjs";

const effects = vi.hoisted(() => ({
  network: vi.fn(() => { throw new Error("No network in preview/review acceptance"); }),
  account: vi.fn(() => { throw new Error("No account reads in preview/review acceptance"); }),
  imageOperation: vi.fn(() => { throw new Error("No generated or edited images in this test"); }),
}));
vi.mock("axios", () => ({ default: { get: effects.network, post: effects.network } }));
vi.mock("../../electron/ipc/store", () => ({ getToken: effects.account, getSettings: effects.account }));
vi.mock("electron", () => ({ app: {}, dialog: {}, nativeImage: { createFromBuffer: effects.imageOperation } }));

import { DEFAULT_PARAMS, type HistoryItem } from "../types";
import { useAppStore } from "../store";
import { createWorkspaceController } from "./controller";
import { collectPromptReview, type PromptReviewResult } from "./prompt-review";
import { pickCreativeState } from "./state";
import { buildPromptReview } from "../../electron/prompt-review";

function picture(value: number) {
  const png = new PNG({ width: 64, height: 64 });
  png.data.fill(value);
  for (let index = 3; index < png.data.length; index += 4) png.data[index] = 255;
  return PNG.sync.write(png).toString("base64");
}
const source = picture(80), mask = picture(255), changedSource = picture(160), changedMask = picture(220);
const workbench = { filePath: "/fixture/source.png", fileUrl: "localmedia://source", width: 64, height: 64 };
const preview: HistoryItem = { id: "fixture-preview", filePath: "/fixture/preview.png", fileUrl: "localmedia://preview",
  width: 64, height: 64, actualSeed: 42, model: DEFAULT_PARAMS.model, params: { ...DEFAULT_PARAMS },
  date: "2026-09-11", createdAt: "2026-09-11T00:00:00Z" };
const workspaceId = "preview-review-fixture";
const cleanups: Array<() => void> = [];

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    params: { ...DEFAULT_PARAMS, positivePrompt: "1girl, library, medium shot", negativePrompt: "text, watermark",
      seed: 42, seedMode: "fixed", width: 64, height: 64, ucPreset: 3 },
    charCaptions: [{ id: "reader", prompt: "adult woman, holding_book", useCoords: true, x: .3, y: .5 }],
    workbenchImage: workbench, inpaintMask: mask,
  });
  Object.values(effects).forEach(effect => effect.mockClear());
});
afterEach(() => {
  cleanups.splice(0).forEach(dispose => dispose());
  expect(effects.account).not.toHaveBeenCalled();
  expect(effects.network).not.toHaveBeenCalled();
  expect(effects.imageOperation).not.toHaveBeenCalled();
});

function setup() {
  const apply = vi.fn(patch => useAppStore.setState(patch));
  const controller = createWorkspaceController({
    read: () => pickCreativeState(useAppStore.getState()),
    subscribe: listener => useAppStore.subscribe(listener), apply,
    validateImages: async () => {},
    readActivity: () => ({ isGenerating: false, maskEditing: false }),
    promptReview: async (state, mode) => buildPromptReview(await collectPromptReview(state, mode,
      async image => ({ mimeType: "image/png", data: image.filePath.includes("changed-source") ? changedSource : source }))),
  }, workspaceId);
  cleanups.push(controller.dispose);
  const review = (expectedRevision = 0, draftId?: string) => controller.execute("read_prompt_review", {
    workspaceId, expectedRevision, mode: "t2i", ...(draftId ? { draftId } : {}),
  }) as Promise<PromptReviewResult>;
  return { controller, apply, review };
}

const displayChanges = [
  () => useAppStore.setState({ currentImage: preview, comparisonBeforeImage: preview,
    comparisonSurface: "generate:t2i", activeCanvasSurface: "postprocess:director",
    activeTab: "postprocess", promptTab: "negative", generateMode: "i2i", postprocessMode: "director" }),
  () => useAppStore.setState({ brushSize: 41, brushOpacity: .45, brushColor: "#224466", brushMode: "erase", brushShape: "square" }),
  () => {
    const state = useAppStore.getState();
    useAppStore.setState({ params: structuredClone(state.params), charCaptions: structuredClone(state.charCaptions),
      i2iParams: structuredClone(state.i2iParams), augmentOptions: structuredClone(state.augmentOptions),
      workbenchImage: structuredClone(state.workbenchImage), vibeImages: structuredClone(state.vibeImages),
      preciseReferences: structuredClone(state.preciseReferences) });
  },
  () => useAppStore.setState({ maskRevision: useAppStore.getState().maskRevision + 1 }),
];

describe("display changes preserve reviewed recipes and creative transactions", () => {
  it("keeps complete effective review inputs identical across display, brush and equal-value clones", async () => {
    const h = setup(), before = await h.review();
    expect(before.reviewInput.readiness.status).toBe("ready");
    expect(before.reviewInput.assets.map(asset => asset.role)).toEqual(["source", "mask"]);
    for (const change of displayChanges) {
      change();
      expect(h.controller.getView().revision).toBe(0);
      expect((await h.review()).reviewInput).toEqual(before.reviewInput);
    }
    expect(h.controller.getView().previewRevision).toBeGreaterThan(0);
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("retains an existing reviewed draft through browsing and brush changes, then applies that exact recipe without rolling back the display", async () => {
    const h = setup();
    const draft = await h.controller.execute("draft_edit", { workspaceId, expectedRevision: 0,
      patch: { params: { positivePrompt: "1girl, quiet library, open book, medium shot" } } }) as { draftId: string };
    const reviewed = await h.review(0, draft.draftId);
    for (const change of displayChanges) {
      change();
      expect(h.controller.getView().revision).toBe(0);
      expect(h.controller.getView().draft?.draftId).toBe(draft.draftId);
      expect((await h.review(0, draft.draftId)).reviewInput).toEqual(reviewed.reviewInput);
    }
    await h.controller.execute("apply_edit", { workspaceId, expectedRevision: 0, draftId: draft.draftId });
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect((await h.review(1)).reviewInput).toEqual(reviewed.reviewInput);
    expect(useAppStore.getState()).toMatchObject({ currentImage: preview, brushSize: 41,
      brushOpacity: .45, brushMode: "erase", activeTab: "postprocess", promptTab: "negative" });
  });

  it.each(["prompt", "mask bytes", "workbench source"] as const)("keeps real %s changes revision-bearing and rejects old reviews and drafts", async change => {
    const h = setup(), original = await h.review();
    const draft = await h.controller.execute("draft_edit", { workspaceId, expectedRevision: 0,
      patch: { params: { positivePrompt: "1girl, sunlit library, medium shot" } } }) as { draftId: string };
    if (change === "prompt") useAppStore.getState().setParam("positivePrompt", "1girl, garden, medium shot");
    if (change === "mask bytes") useAppStore.setState({ inpaintMask: changedMask });
    if (change === "workbench source") useAppStore.setState({ workbenchImage: { ...workbench,
      filePath: "/fixture/changed-source.png", fileUrl: "localmedia://changed-source" } });
    expect(h.controller.getView().revision).toBe(1);
    await expect(h.review()).rejects.toMatchObject({ code: "conflict" });
    await expect(h.review(1, draft.draftId)).rejects.toMatchObject({ code: "conflict" });
    await expect(h.controller.execute("apply_edit", { workspaceId, expectedRevision: 1, draftId: draft.draftId })).rejects.toMatchObject({ code: "conflict" });
    expect(h.apply).not.toHaveBeenCalled();
    h.controller.discardDraft();
    const current = await h.review(1);
    expect(current.reviewInput).not.toEqual(original.reviewInput);
    if (change === "prompt") expect(current.reviewInput.effective!.request.input).toContain("garden");
    if (change === "mask bytes") expect(current.reviewInput.assets.find(asset => asset.role === "mask")!.sha256)
      .not.toBe(original.reviewInput.assets.find(asset => asset.role === "mask")!.sha256);
    if (change === "workbench source") expect(current.reviewInput.assets.find(asset => asset.role === "source")!.sha256)
      .not.toBe(original.reviewInput.assets.find(asset => asset.role === "source")!.sha256);
  });
});
