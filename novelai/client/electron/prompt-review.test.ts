import { beforeEach, describe, expect, it, vi } from "vitest";
import { PNG } from "pngjs";
import { createHash } from "node:crypto";
const effects = vi.hoisted(() => ({ network: vi.fn(() => { throw new Error("No network in review"); }), account: vi.fn(() => { throw new Error("No account reads in review"); }) }));
vi.mock("axios", () => ({ default: { get: effects.network, post: effects.network } }));
vi.mock("./ipc/store", () => ({ getToken: effects.account, getSettings: effects.account }));
vi.mock("electron", async () => {
  const { PNG } = await import("pngjs");
  const wrap = (buffer: Buffer): any => {
    let png: PNG; try { png = PNG.sync.read(buffer); } catch { return { isEmpty: () => true }; }
    return { isEmpty: () => false, getSize: () => ({ width: png.width, height: png.height }), toPNG: () => PNG.sync.write(png), resize: ({ width, height }: { width: number; height: number }) => {
      const target = new PNG({ width, height });
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const from = (Math.floor(y * png.height / height) * png.width + Math.floor(x * png.width / width)) * 4;
        png.data.copy(target.data, (y * width + x) * 4, from, from + 4);
      }
      return wrap(PNG.sync.write(target));
    } };
  };
  return { app: {}, dialog: {}, nativeImage: { createFromBuffer: wrap } };
});
import { DEFAULT_PARAMS } from "../src/types";
import { useAppStore } from "../src/store";
import { pickCreativeState, type CreativeState } from "../src/workspace/state";
import { collectPromptReview, type PromptReviewResult } from "../src/workspace/prompt-review";
import { createWorkspaceController, type WorkspacePort } from "../src/workspace/controller";
import { prepareGenerationSourceSelection } from "../src/workspace/source-selection";
import { buildPromptReview } from "./prompt-review";
import { waitUntil } from '../src/test-support/wait-until';

function picture(value: number, width = 64, height = 64) { const png = new PNG({ width, height }); png.data.fill(value); for (let index = 3; index < png.data.length; index += 4) png.data[index] = 255; return PNG.sync.write(png).toString("base64"); }
const source = picture(80), mask = picture(255), newSource = picture(160), newMask = picture(220);
const params = { ...DEFAULT_PARAMS, positivePrompt: "teacup, table", negativePrompt: "text, watermark", width: 64, height: 64, seed: 42, seedMode: "fixed" as const, ucPreset: 3 };
const image = { filePath: "/fixture/first.png", fileUrl: "localmedia://first", width: 64, height: 64 };
const readImage = vi.fn(async (item: any) => ({ mimeType: "image/png", data: item.filePath.includes("second") ? newSource : source }));
function initial(patch: Record<string, any> = {}) { useAppStore.setState(useAppStore.getInitialState(), true); useAppStore.setState({ params, workbenchImage: image, inpaintMask: mask, inpaintModel: "nai-diffusion-5-full-inpainting", inpaintRecipe: { ...params, positivePrompt: "brooch" }, ...patch } as any); return pickCreativeState(useAppStore.getState()); }
async function review(mode: any = "t2i", patch: Record<string, any> = {}) { return buildPromptReview(await collectPromptReview(initial(patch), mode, readImage)); }
function setup(override: Partial<WorkspacePort> = {}) {
  const apply = vi.fn((patch) => useAppStore.setState(patch));
  const port: WorkspacePort = { read: () => pickCreativeState(useAppStore.getState()), subscribe: listener => useAppStore.subscribe(listener), apply, validateImages: async () => {}, readActivity: () => ({ isGenerating: false }), promptReview: async (state, mode) => buildPromptReview(await collectPromptReview(state, mode, readImage)), ...override };
  return { controller: createWorkspaceController(port, "review-fixture"), apply };
}
const args = { workspaceId: "review-fixture", expectedRevision: 0, mode: "inpaint" };
beforeEach(() => { effects.account.mockClear(); effects.network.mockClear(); readImage.mockClear(); initial(); });

describe("read-only effective prompt review", () => {
  it.each(["t2i", "i2i", "inpaint", "enhance"])("reviews a %s draft through the actual builder without changing the live state or the draft", async mode => {
    const characters = [{ id: "gardener", prompt: "adult gardener", negativePrompt: "hat", useCoords: true, x: .2, y: .7 }];
    const original = initial({ params: { ...params, stylePrompt: "watercolor" }, inpaintRecipe: { ...params, positivePrompt: "brooch", stylePrompt: "watercolor" }, charCaptions: characters });
    const { controller, apply } = setup();
    const before = await controller.execute("read_prompt_review", { ...args, mode }) as PromptReviewResult;
    const draft = await controller.execute("draft_edit", { ...args, patch: {
      params: { positivePrompt: "{teacup}, table", negativePrompt: "[text], watermark", stylePrompt: "ink drawing" },
      inpaintRecipe: { positivePrompt: "{brooch}", negativePrompt: "{text}, watermark", stylePrompt: "ink drawing" },
      charCaptions: [{ ...characters[0], prompt: "{adult gardener}", negativePrompt: "[hat]" }],
    } }) as any;
    const request = { ...args, mode, draftId: draft.draftId };
    const changed = await controller.execute("read_prompt_review", request) as PromptReviewResult;
    expect(changed.reviewInput).not.toEqual(before.reviewInput);
    expect((await controller.execute("read_prompt_review", request) as PromptReviewResult).reviewInput).toEqual(changed.reviewInput);
    expect((await controller.execute("read_prompt_review", { ...args, mode }) as PromptReviewResult).reviewInput).toEqual(before.reviewInput);
    expect(pickCreativeState(useAppStore.getState())).toEqual(original);
    expect(controller.getView()).toMatchObject({ revision: 0, draft: { draftId: draft.draftId } });
    expect(apply).not.toHaveBeenCalled(); expect(effects.account).not.toHaveBeenCalled(); expect(effects.network).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("refuses the retired comparison overrides before building and no longer advertises them", async () => {
    const build = vi.fn(async (state, mode) => buildPromptReview(await collectPromptReview(state, mode, readImage)));
    const { controller, apply } = setup({ promptReview: build });
    for (const extra of [{ promptOverrides: [{ field: "params.positivePrompt", value: "teacup" }] }, { styleOverrides: { params: "watercolor" } }]) {
      await expect(controller.execute("read_prompt_review", { ...args, mode: "t2i", ...extra })).rejects.toMatchObject({ code: "invalid_argument" });
    }
    expect(build).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled(); expect(controller.getView().revision).toBe(0);
    const workspace = await controller.execute("read_workspace", args) as any;
    expect(workspace.capabilities).toMatchObject({ promptReview: true }); expect(workspace.capabilities).not.toHaveProperty("promptTextOverrides");
    expect(workspace).not.toHaveProperty("draftEpoch");
    controller.dispose();
  });

  it.each(["manual", "replace", "discard"])("rejects a draft review when %s changes its identity during the actual build", async change => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const build = vi.fn(async (state, mode) => { await gate; return buildPromptReview(await collectPromptReview(state, mode, readImage)); });
    const { controller, apply } = setup({ promptReview: build });
    const draft = await controller.execute("draft_edit", { ...args, patch: { params: { positivePrompt: "{teacup}, table" } } }) as any;
    const pending = controller.execute("read_prompt_review", { ...args, mode: "t2i", draftId: draft.draftId });
    await waitUntil(() => expect(build).toHaveBeenCalledOnce());
    if (change === "manual") useAppStore.setState({ params: { ...params, positivePrompt: "user replacement" } });
    else if (change === "replace") await controller.execute("draft_edit", { ...args, patch: { params: { positivePrompt: "a new draft" } } });
    else controller.discardDraft();
    release();
    await expect(pending).rejects.toMatchObject({ code: "conflict" });
    expect(apply).not.toHaveBeenCalled();
    expect(useAppStore.getState().params.positivePrompt).toBe(change === "manual" ? "user replacement" : params.positivePrompt);
    controller.dispose();
  });

  it("keeps imported metadata replay in the reviewed request", async () => {
    const replay = { model: "nai-diffusion-5-full", parameters: { quality_boost: true, skip_cfg_below_sigma: .15 }, positive: { use_order: false }, negative: { legacy_uc: true }, keepEmptyNegativeCharacters: true };
    initial({ params: { ...params, model: "nai-diffusion-5-full", stylePrompt: "watercolor", metadataReplay: replay } });
    const { controller } = setup();
    const current = await controller.execute("read_prompt_review", { ...args, mode: "t2i" }) as PromptReviewResult;
    expect(current.reviewInput.authored.params.metadataReplay).toEqual(replay);
    expect(current.reviewInput.effective!.request.parameters).toMatchObject({ quality_boost: true, skip_cfg_below_sigma: .15 });
    expect(current.reviewInput.authored.params.stylePrompt).toBe("watercolor");
    expect(effects.account).not.toHaveBeenCalled(); expect(effects.network).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("uses effective quality, UC and structured character positions with no account/network access", async () => {
    const result = await review("t2i", { charCaptions: [{ id: "private-editor-id", prompt: "adult gardener", negativePrompt: "hat", useCoords: true, x: .2, y: .7 }] });
    expect(result.readiness.status).toBe("ready");
    const request = result.effective!.request;
    expect(request.input).toContain("teacup, table"); expect(request.input).not.toBe("teacup, table");
    expect(request.parameters.uc).toBe("text, watermark");
    expect(request.parameters.v4_prompt.caption.char_captions).toEqual([{ char_caption: "adult gardener", centers: [{ x: .2, y: .7 }] }]);
    expect(request.parameters.v4_negative_prompt.caption.char_captions[0].char_caption).toBe("hat");
    expect(request.parameters.noise_schedule).toBe("karras"); expect(request.parameters.seed).toBe(42);
    expect(JSON.stringify(result)).not.toContain("private-editor-id");
    expect(result.assets.find(a => a.role === "source")!.usedForGeneration).toBe(false);
    expect(effects.account).not.toHaveBeenCalled(); expect(effects.network).not.toHaveBeenCalled();
  });
  it("reports automatic UC together with authored custom UC", async () => {
    const result = await review("t2i", { params: { ...params, ucPreset: 0 } });
    expect(result.effective!.request.parameters.uc).toContain("text, watermark");
    expect(result.effective!.request.parameters.uc.length).toBeGreaterThan("text, watermark".length);
    expect(result.authored.params.negativePrompt).toBe("text, watermark");
  });
  it("includes independent inpaint inputs, exact prepared request mask and local blend support", async () => {
    const result = await review("inpaint", { inpaintStrength: 1, inpaintPositivePrompt: "unused legacy words", charCaptions: [{ id: "a", prompt: "unused character", useCoords: false, x: .5, y: .5 }] });
    expect(result.recipeScope).toBe("independent_inpaint"); expect(result.readiness.status).toBe("ready");
    const request = result.effective!.request;
    expect(request.model).toBe("nai-diffusion-5-full-inpainting"); expect(request.action).toBe("infill"); expect(request.input).toContain("brooch");
    expect(request.input).not.toContain("unused"); expect(request.parameters.v4_prompt.caption.char_captions).toEqual([]);
    expect(request.parameters).toMatchObject({ strength: .7, inpaintImg2ImgStrength: 1, noise: 0, extra_noise_seed: 41, image: { assetRole: "request-source" }, mask: { assetRole: "request-mask" } });
    expect(request.parameters.img2img).toBeUndefined();
    expect(result.assets.find(a => a.role === "source")!.data).toBe(source);
    expect(result.assets.find(a => a.role === "mask")!.sha256).toBe(createHash("sha256").update(Buffer.from(mask, "base64")).digest("hex"));
    expect(result.assets.map(a => a.role)).toEqual(["source", "mask", "request-source", "request-mask", "blend-alpha"]);
    expect(result.unusedInputs).toEqual(expect.arrayContaining(["params", "charCaptions", "inpaintPositivePrompt"]));
  });
  it("uses the legacy inpaint text and base UC when no independent recipe exists", async () => {
    const result = await review("inpaint", { inpaintRecipe: null, inpaintPositivePrompt: "blue ceramic cup" });
    expect(result.recipeScope).toBe("legacy_inpaint"); expect(result.effective!.request.input).toContain("blue ceramic cup");
    expect(result.effective!.request.input).not.toContain("teacup"); expect(result.effective!.request.parameters.uc).toBe("text, watermark");
  });
  it("constructs i2i and Enhance sampling from the actual postprocess resolver", async () => {
    const i2i = await review("i2i", { i2iParams: { strength: .33, noise: .9, extraNoiseSeed: 37 }, i2iSizeMode: "custom" });
    expect(i2i.effective!.request).toMatchObject({ action: "img2img", parameters: { strength: .33, noise: 0, extra_noise_seed: 37 } });
    const enhance = await review("enhance", { enhanceMagnitude: 5, enhanceScale: 1 });
    expect(enhance.effective!.request.parameters.strength).toBeCloseTo(.27); expect(enhance.effective!.request.parameters.noise).toBe(0);
    expect(enhance.unusedInputs).toContain("i2iParams.strength");
  });
  it("marks random seed selection as deferred without drawing or changing a seed", async () => {
    const state = initial({ params: { ...params, seedMode: "random", seed: -1 }, i2iParams: { strength: .5, noise: 0, extraNoiseSeed: 0 } });
    const before = structuredClone(state);
    const first = await buildPromptReview(await collectPromptReview(state, "i2i", readImage));
    const second = await buildPromptReview(await collectPromptReview(state, "i2i", readImage));
    expect(first).toEqual(second); expect(state).toEqual(before);
    expect(first.effective!.request.parameters).toMatchObject({ seed: null, extra_noise_seed: null });
    expect(first.effective!.sampling).toMatchObject({ seedPolicy: "random_on_submit", extraNoiseSeedPolicy: "random_on_submit" });
  });
  it("uses dedicated upscale and Director requests, declaring unrelated prompts unused", async () => {
    const upscale = await review("upscale", { upscaleScale: 2 });
    expect(upscale.effective!.request).toEqual({ image: { assetRole: "request-source" }, model: "nai-diffusion-5-curated", declared_blur_sigma: 0 });
    expect(upscale.unusedInputs).toContain("params");
    const director = await review("director", { directorTool: "colorize", augmentOptions: { defry: 2, colorizePrompt: "blue ceramic", emotion: "happy", emotionLevel: 3 } });
    expect(director.effective!.request).toMatchObject({ req_type: "colorize", prompt: "blue ceramic", defry: 2 });
    expect(director.unusedInputs).toContain("params"); expect(director.effective!.sampling.processing.alphaFlattened).toBe(true);
  });
  it("retains refs as exact unused context and blocks unsupported queue reference combinations", async () => {
    const result = await review("t2i", { vibeImages: [{ id: "temporary", name: "palette", base64: source, strength: .7, infoExtracted: 1 }], preciseReferences: [{ id: "temporary-2", base64: newSource, type: "character", strength: 1, fidelity: .8 }] });
    expect(result.readiness.status).toBe("blocked"); expect(result.readiness.issues[0].code).toBe("unsupported_reference");
    expect(result.effective!.request.parameters.reference_image_multiple).toBeUndefined();
    expect(result.assets.find(a => a.role === "vibeImages:0")).toMatchObject({ data: source, usedForGeneration: false });
    expect(result.authored.vibeImages[0]).toEqual({ name: "palette", infoExtracted: 1, strength: .7 });
  });
  it("does not invent effective inputs for missing/mismatched assets or invalid settings", async () => {
    for (const patch of [{ workbenchImage: null, i2iOriginalImage: null }, { inpaintMask: null }, { inpaintMask: picture(255, 32, 64) }, { inpaintModel: "invented" }]) {
      const result = await review("inpaint", patch); expect(result.readiness.status).toBe("blocked"); expect(result.effective).toBeNull();
    }
    const legacy = await review("inpaint", { inpaintRecipe: null, inpaintPositivePrompt: "cup", charCaptions: [{ prompt: "gardener", id: "a" }] });
    expect(legacy.readiness.status).toBe("blocked");
    const upscale = await review("upscale", { upscaleScale: 4 }); expect(upscale.effective).toBeNull(); expect(upscale.readiness.status).toBe("blocked");
  });
  it("re-applies the whitelist at the IPC boundary, dropping credential/path injections", async () => {
    const prep = await collectPromptReview(initial(), "t2i", readImage);
    Object.assign(prep.authored, { token: "credential-marker", settings: { token: "credential-marker" }, source: { path: "/secret-file" } });
    prep.authored.params.apiKey = "credential-marker"; prep.authored.augmentOptions.secret = "credential-marker";
    (prep.assets[0] as any).path = "/secret-file";
    const result = await buildPromptReview(prep);
    expect(JSON.stringify(result)).not.toContain("credential-marker"); expect(JSON.stringify(result)).not.toContain("/secret-file");
  });
});

describe("live current/draft review identity and conflict handling", () => {
  it("previews independent text scenes concurrently without replacing the visible draft or canvas", async () => {
    const { controller, apply } = setup();
    const visible = await controller.execute("draft_edit", { ...args, patch: { params: { positivePrompt: "retained visible draft" } } }) as any;
    const before = structuredClone(pickCreativeState(useAppStore.getState()));
    const [garden, library] = await Promise.all(["sunlit garden", "quiet library"].map(positivePrompt => controller.execute("read_prompt_review", { ...args, mode: "t2i", patch: { params: { positivePrompt, stylePrompt: "watercolor", negativePrompt: "text", qualityPreset: "none" }, charCaptions: [] } }))) as PromptReviewResult[];
    expect(garden.reviewInput.effective!.request.input).toContain("sunlit garden");
    expect(library.reviewInput.effective!.request.input).toContain("quiet library");
    expect(garden.reviewInput.effective!.request.input).toContain("watercolor");
    expect(garden.draftId).toBeNull(); expect(library.draftId).toBeNull();
    expect(pickCreativeState(useAppStore.getState())).toEqual(before); expect(apply).not.toHaveBeenCalled();
    const retained = await controller.execute("read_prompt_review", { ...args, mode: "t2i", draftId: visible.draftId }) as PromptReviewResult;
    expect(retained.reviewInput.effective!.request.input).toContain("retained visible draft");
    controller.dispose();
  });
  it("rejects mixed draft/patch, non-text fields, invalid params and non-t2i detached previews", async () => {
    const { controller } = setup();
    for (const request of [
      { patch: { params: { positivePrompt: "garden" } } },
      { mode: "t2i", draftId: "draft-any", patch: { params: { positivePrompt: "garden" } } },
      { mode: "t2i", patch: {} }, { mode: "t2i", patch: { inpaintMask: newMask } },
      { mode: "t2i", patch: { params: { inventedField: true } } },
    ]) await expect(controller.execute("read_prompt_review", { ...args, ...request })).rejects.toMatchObject({ code: "invalid_argument" });
    controller.dispose();
  });
  it("invalidates a detached review if its baseline changes during preparation", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { controller, apply } = setup({ promptReview: async (state, mode) => { await gate; return buildPromptReview(await collectPromptReview(state, mode, readImage)); } });
    const pending = controller.execute("read_prompt_review", { ...args, mode: "t2i", patch: { params: { positivePrompt: "sunlit garden" }, charCaptions: [] } });
    useAppStore.getState().setParam("steps", 29); release();
    await expect(pending).rejects.toMatchObject({ code: "conflict" }); expect(apply).not.toHaveBeenCalled(); controller.dispose();
  });
  it("reviews a pending complete recipe without applying, then returns equal canonical input after apply", async () => {
    const { controller, apply } = setup();
    const draft = await controller.execute("draft_edit", { ...args, patch: { inpaintRecipe: { positivePrompt: "silver brooch" }, inpaintMask: newMask } }) as any;
    const before = await controller.execute("read_prompt_review", { ...args, draftId: draft.draftId }) as PromptReviewResult;
    expect(before.reviewInput.effective!.request.input).toContain("silver brooch"); expect(apply).not.toHaveBeenCalled(); expect(useAppStore.getState().inpaintMask).toBe(mask);
    expect(controller.read().revision).toBe(0);
    const current = await controller.execute("read_prompt_review", args) as PromptReviewResult;
    expect(current.reviewInput.effective!.request.input).not.toContain("silver brooch");
    await controller.execute("apply_edit", { workspaceId: args.workspaceId, expectedRevision: 0, draftId: draft.draftId });
    const after = await controller.execute("read_prompt_review", { ...args, expectedRevision: 1 }) as PromptReviewResult;
    expect(after.reviewInput).toEqual(before.reviewInput); expect(after.draftId).toBeNull(); expect(before.draftId).toBe(draft.draftId);
    controller.dispose();
  });
  it("does not bind canonical content to editor IDs or source paths; changing source bytes changes hash", async () => {
    const first = await review("t2i", { charCaptions: [{ id: "first-id", prompt: "gardener", useCoords: false, x: .5, y: .5 }] });
    const renamed = await review("t2i", { charCaptions: [{ id: "another-id", prompt: "gardener", useCoords: false, x: .5, y: .5 }], workbenchImage: { ...image, filePath: "/fixture/same-bytes.png", fileUrl: "localmedia://renamed" } });
    expect(renamed).toEqual(first);
    const changed = await review("t2i", { workbenchImage: { ...image, filePath: "/fixture/second.png" } });
    expect(changed.assets[0].sha256).not.toBe(first.assets[0].sha256);
  });
  it("reviews a staged new source without touching current source or mask; the applied snapshot is identical", async () => {
    const { controller, apply } = setup({ prepareGenerationSource: (input, asset, mode, current) => prepareGenerationSourceSelection(input, asset, mode, current, async () => ({ ...image, filePath: "/fixture/second.png", fileUrl: "localmedia://second" })) });
    const draft = await controller.stageClientSource({ id: "workbenchImage", role: "workbenchImage", mimeType: "image/png" }, "i2i", async () => ({ mimeType: "image/png", data: newSource }), "fixture source") as any;
    const before = await controller.execute("read_prompt_review", { ...args, mode: "i2i", draftId: draft.draftId }) as PromptReviewResult;
    expect(before.reviewInput.assets.find(a => a.role === "source")!.data).toBe(newSource);
    expect(before.reviewInput.assets.find(a => a.role === "mask")).toBeUndefined();
    expect(useAppStore.getState().workbenchImage).toEqual(image); expect(useAppStore.getState().inpaintMask).toBe(mask); expect(apply).not.toHaveBeenCalled();
    await controller.execute("apply_edit", { workspaceId: args.workspaceId, expectedRevision: 0, draftId: draft.draftId });
    const after = await controller.execute("read_prompt_review", { ...args, expectedRevision: 1, mode: "i2i" }) as PromptReviewResult;
    expect(after.reviewInput).toEqual(before.reviewInput); expect(JSON.stringify(after.reviewInput)).not.toContain("piSource"); controller.dispose();
  });
  it("does not invalidate recipe content for brush or batch UI changes", async () => {
    const first = await review("t2i");
    const second = await review("t2i", { brushSize: 32, brushOpacity: .1, brushColor: "#ffff00", brushMode: "erase", brushShape: "square", batchCount: 10, batchIntervalSeconds: 20 });
    expect(second).toEqual(first);
  });
  it("rejects stale revision and stale/replaced drafts", async () => {
    const { controller } = setup();
    const draft = await controller.execute("draft_edit", { ...args, patch: { inpaintRecipe: { positivePrompt: "blue brooch" } } }) as any;
    useAppStore.getState().setParam("positivePrompt", "manual edit");
    await expect(controller.execute("read_prompt_review", args)).rejects.toMatchObject({ code: "conflict" });
    await expect(controller.execute("read_prompt_review", { ...args, expectedRevision: 1, draftId: draft.draftId })).rejects.toMatchObject({ code: "conflict" });
    await expect(controller.execute("read_prompt_review", { ...args, expectedRevision: 1, draftId: "unknown" })).rejects.toMatchObject({ code: "draft_not_found" });
    controller.dispose();
  });
  it("rejects edits during asynchronous image collection and never applies a draft", async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const { controller, apply } = setup({ promptReview: async (state, mode) => { await wait; return buildPromptReview(await collectPromptReview(state, mode, readImage)); } });
    const running = controller.execute("read_prompt_review", args);
    useAppStore.getState().setParam("positivePrompt", "changed while reading"); release();
    await expect(running).rejects.toMatchObject({ code: "conflict" }); expect(apply).not.toHaveBeenCalled(); controller.dispose();
  });
  it("rejects replacement of the same-version draft while collecting its images", async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const { controller } = setup({ promptReview: async (state, mode) => { await wait; return buildPromptReview(await collectPromptReview(state, mode, readImage)); } });
    const draft = await controller.execute("draft_edit", { ...args, patch: { inpaintRecipe: { positivePrompt: "silver brooch" } } }) as any;
    const running = controller.execute("read_prompt_review", { ...args, draftId: draft.draftId });
    await controller.execute("draft_edit", { ...args, patch: { inpaintRecipe: { positivePrompt: "gold brooch" } } }); release();
    await expect(running).rejects.toMatchObject({ code: "conflict" }); controller.dispose();
  });
});
