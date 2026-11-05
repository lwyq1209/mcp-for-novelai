import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "./store";
import { baseModelForInpaint, DEFAULT_PARAMS, NAI_INPAINT_MODELS, NAI_MODELS } from "./types";

const characters = [{ id: "adult-one", prompt: "adult woman, red shirt", negativePrompt: "hat", useCoords: true, x: .25, y: .45 }];

function desktop(settings: any = {}) {
  return {
    setSetting: vi.fn().mockResolvedValue(undefined),
    onGenerationPreview: vi.fn(() => vi.fn()), onUpdateEvent: vi.fn(() => vi.fn()),
    getSettings: vi.fn().mockResolvedValue({ language: "zh-CN", persistGenerateParams: true, persistInpaintParams: true, ...settings }),
    accountCached: vi.fn().mockResolvedValue({ hasToken: false }),
    isFirstRun: vi.fn().mockResolvedValue(false), getHistoryDates: vi.fn().mockResolvedValue([]),
    getHistoryGroups: vi.fn().mockResolvedValue([]),
    getHistory: vi.fn().mockResolvedValue([]),
  };
}

describe("independent manual inpaint recipe", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
    vi.stubGlobal("window", { naiDesktop: desktop() });
  });

  it("copies once, merges later changes and preserves base characters and the legacy prompt", () => {
    useAppStore.setState({ params: { ...DEFAULT_PARAMS, positivePrompt: "three adults", negativePrompt: "base negative", steps: 28 },
      charCaptions: characters, inpaintPositivePrompt: "silver brooch" });
    const base = structuredClone(useAppStore.getState().params);
    useAppStore.getState().setInpaintRecipe({});
    expect(useAppStore.getState().inpaintRecipe).toEqual({ ...base, positivePrompt: "silver brooch" });
    useAppStore.getState().setParam("steps", 35);
    useAppStore.getState().setInpaintPositivePrompt("legacy changed");
    expect(useAppStore.getState().inpaintRecipe).toEqual({ ...base, positivePrompt: "silver brooch" });
    useAppStore.getState().setInpaintRecipe({ negativePrompt: "local negative" });
    useAppStore.getState().setInpaintRecipeParam("steps", 12);
    useAppStore.getState().setInpaintRecipeParam("qualityPreset", "none");
    expect(useAppStore.getState().inpaintRecipe).toMatchObject({ positivePrompt: "silver brooch", negativePrompt: "local negative", steps: 12, qualityPreset: "none", qualityToggle: false });
    expect(useAppStore.getState().params).toEqual({ ...base, steps: 35 });
    expect(useAppStore.getState().charCaptions).toEqual(characters);
    expect(useAppStore.getState().inpaintPositivePrompt).toBe("legacy changed");
    useAppStore.getState().setInpaintRecipe(null);
    useAppStore.getState().setInpaintRecipeParam("positivePrompt", "late async UI result");
    expect(useAppStore.getState().inpaintRecipe).toBeNull();
    expect(useAppStore.getState().params).toEqual({ ...base, steps: 35 });
  });

  it("persists and restores both recipes, while old settings restore a null independent recipe", async () => {
    const naiDesktop = desktop();
    vi.stubGlobal("window", { naiDesktop });
    useAppStore.setState({ settings: { language: "zh-CN" } as any, params: { ...DEFAULT_PARAMS, positivePrompt: "base composition" }, inpaintPositivePrompt: "legacy local" });
    useAppStore.getState().setInpaintRecipe({ positivePrompt: "new brooch", negativePrompt: "large badge", steps: 16 });
    const saved = naiDesktop.setSetting.mock.calls.at(-1)![1];
    expect(saved.params.positivePrompt).toBe("base composition");
    expect(saved.inpaintPositivePrompt).toBe("legacy local");
    expect(saved.inpaintRecipe).toMatchObject({ positivePrompt: "new brooch", negativePrompt: "large badge", steps: 16 });
    useAppStore.setState(useAppStore.getInitialState(), true);
    vi.stubGlobal("window", { naiDesktop: desktop({ lastGenerationState: saved }) });
    await useAppStore.getState().load();
    expect(useAppStore.getState().inpaintRecipe).toEqual(saved.inpaintRecipe);
    expect(useAppStore.getState().params).toEqual(saved.params);
    const legacyParams: any = structuredClone(saved.params);delete legacyParams.promptAssemblyVersion;
    vi.stubGlobal("window", { naiDesktop: desktop({ lastGenerationState: { ...saved, params: legacyParams } }) });
    await useAppStore.getState().load();
    expect(useAppStore.getState().params).not.toHaveProperty("promptAssemblyVersion");
    expect(useAppStore.getState().params.preservePromptText).toBeUndefined();
    useAppStore.getState().variationFromImage({ id:"legacy",filePath:"fixture.png",fileUrl:"fixture://old",date:"2026-09-17",createdAt:"2026-09-17T00:00:00Z",params:legacyParams,actualSeed:77,model:legacyParams.model,width:legacyParams.width,height:legacyParams.height } as any);
    expect(useAppStore.getState().params).not.toHaveProperty("promptAssemblyVersion");
    const { inpaintRecipe: _oldMissing, ...oldSaved } = saved;
    vi.stubGlobal("window", { naiDesktop: desktop({ lastGenerationState: oldSaved }) });
    await useAppStore.getState().load();
    expect(useAppStore.getState().inpaintRecipe).toBeNull();
    expect(useAppStore.getState().params).toEqual(saved.params);
  });

  it("fails closed on invalid restored base, inpaint, and history markers without silently normalizing them", async () => {
    const validState = {
      params: { ...DEFAULT_PARAMS, positivePrompt: "saved base" },
      inpaintRecipe: { ...DEFAULT_PARAMS, positivePrompt: "saved inpaint" },
    };
    for (const invalidState of [
      { ...validState, params: { ...validState.params, promptAssemblyVersion: 2 } },
      { ...validState, inpaintRecipe: { ...validState.inpaintRecipe, promptAssemblyVersion: "1" } },
    ]) {
      useAppStore.setState(useAppStore.getInitialState(), true);
      vi.stubGlobal("window", { naiDesktop: desktop({ lastGenerationState: invalidState }) });
      await useAppStore.getState().load();
      expect(useAppStore.getState().bootDone).toBe(false);
      expect(useAppStore.getState().bootError).toContain("提示词装配版本无效");
      expect(useAppStore.getState().params.positivePrompt).not.toBe("saved base");
    }

    const before = useAppStore.getState().params;
    const invalidHistory = { id:"invalid",filePath:"fixture.png",fileUrl:"fixture://invalid",date:"2026-09-17",createdAt:"2026-09-17T00:00:00Z",params:{...DEFAULT_PARAMS,promptAssemblyVersion:false},actualSeed:77,model:DEFAULT_PARAMS.model,width:832,height:1216 } as any;
    useAppStore.getState().variationFromImage(invalidHistory);
    expect(useAppStore.getState().params).toBe(before);
    expect(useAppStore.getState().toast).toContain("提示词装配版本无效");
  });

  it("keeps recipe capabilities aligned with the selected inpaint model while leaving the base model intact", () => {
    for (const { value } of NAI_INPAINT_MODELS) {
      expect(NAI_MODELS.some((model) => model.value === baseModelForInpaint(value))).toBe(true);
      expect(`${baseModelForInpaint(value)}-inpainting`).toBe(value);
    }
    useAppStore.setState({ params: { ...DEFAULT_PARAMS, model: "nai-diffusion-3", positivePrompt: "base" }, inpaintPositivePrompt: "silver brooch" });
    useAppStore.getState().setInpaintModel("nai-diffusion-5-curated-inpainting");
    useAppStore.getState().setInpaintRecipe({ qualityPreset: "light" });
    expect(useAppStore.getState().inpaintRecipe).toMatchObject({ model: "nai-diffusion-5-curated", qualityPreset: "light" });
    useAppStore.getState().setInpaintRecipeParam("model", "nai-diffusion-3");
    expect(useAppStore.getState().inpaintRecipe?.model).toBe("nai-diffusion-5-curated");
    useAppStore.getState().setInpaintModel("nai-diffusion-4-5-full-inpainting");
    expect(useAppStore.getState().inpaintRecipe).toMatchObject({ model: "nai-diffusion-4-5-full", qualityPreset: "standard" });
    expect(useAppStore.getState().params).toMatchObject({ model: "nai-diffusion-3", positivePrompt: "base" });
  });

  it("uses the independent text and sampling for manual quote and request, with the selected source size and model", async () => {
    const source = { filePath: "fixture.png", fileUrl: "local-media://fixture.png", width: 1216, height: 832 };
    const naiDesktop = {
      ...desktop(), hasToken: vi.fn().mockResolvedValue({ hasToken: true, anlasBalance: 100 }),
      manualCaptureSource: vi.fn().mockResolvedValue({ ok: true, result: { sourceId: "0b5c6a52-35a8-4a52-9d8e-3c6f4f1b2a01" } }),
      quoteAnlas: vi.fn().mockImplementation(async (_request: any) => {
        useAppStore.getState().setParam("negativePrompt", "manual base edit during quote");
        useAppStore.getState().setInpaintRecipeParam("positivePrompt", "next edit");
        return { ok: true, amount: 1, balance: 100 };
      }),
      manualEnqueue: vi.fn().mockResolvedValue({ ok: false, error: { code: "fixture", message: "fixture response" } }),
    };
    vi.stubGlobal("window", { naiDesktop });
    useAppStore.setState({ account: { hasToken: true }, workbenchImage: source, i2iOriginalImage: source,
      charCaptions: characters, inpaintMask: "fixture-mask", inpaintModel: "nai-diffusion-5-curated-inpainting", inpaintStrength: .72,
      params: { ...DEFAULT_PARAMS, positivePrompt: "base composition", steps: 28 }, inpaintPositivePrompt: "legacy text" });
    useAppStore.getState().setInpaintRecipe({ positivePrompt: "small silver brooch", negativePrompt: "large badge", stylePrompt: "cel shading", steps: 17, cfgScale: 4, width: 512, height: 512, seedMode: "fixed", seed: 4321 });
    await useAppStore.getState().inpaint();
    const quoted = naiDesktop.quoteAnlas.mock.calls[0][0];
    const request = naiDesktop.manualEnqueue.mock.calls[0][0];
    expect(naiDesktop.manualEnqueue).toHaveBeenCalledTimes(1);
    expect(request.params).toEqual(quoted.params);
    expect(request.params).toMatchObject({ positivePrompt: "small silver brooch", negativePrompt: "large badge", stylePrompt: "cel shading", steps: 17, cfgScale: 4, width: 1216, height: 832, seed: 4321 });
    expect(request).toMatchObject({ mode: "inpaint", count: 1, inpaint: { model: "nai-diffusion-5-curated-inpainting", maskBase64: "fixture-mask", strength: .72 }, sourceId: "0b5c6a52-35a8-4a52-9d8e-3c6f4f1b2a01" });
    // The source is read at the click, before the quote, from the chosen source's file.
    expect(naiDesktop.manualCaptureSource).toHaveBeenCalledExactlyOnceWith("fixture.png");
    expect(naiDesktop.manualCaptureSource.mock.invocationCallOrder[0]).toBeLessThan(naiDesktop.quoteAnlas.mock.invocationCallOrder[0]);
    // No character or reference extras in this protocol.
    expect(request.extras).toMatchObject({ charCaptions: [], vibeImages: [], preciseReferences: [] });
    expect(useAppStore.getState().params).toMatchObject({ positivePrompt: "base composition", steps: 28, negativePrompt: "manual base edit during quote" });
    expect(useAppStore.getState().charCaptions).toEqual(characters);
    expect(useAppStore.getState().inpaintRecipe?.positivePrompt).toBe("next edit");
    expect(useAppStore.getState().inpaintPositivePrompt).toBe("legacy text");
  });

  it.each([
    ["references", "zh-CN"], ["furry", "zh-CN"], ["mismatched model", "zh-CN"],
    ["references", "en-US"], ["furry", "en-US"], ["mismatched model", "en-US"],
  ] as const)("rejects unsupported %s before any manual paid call without deleting base state (%s)", async (kind, language) => {
    const naiDesktop = { ...desktop(), manualEnqueue: vi.fn(), quoteAnlas: vi.fn() };
    vi.stubGlobal("window", { naiDesktop });
    useAppStore.setState({ account: { hasToken: true }, charCaptions: characters, settings: { ...useAppStore.getState().settings, language, ...(kind === "furry" ? { modelMode: "furry" } : {}) } as any,
      ...(kind === "references" ? { vibeImages: [{ id: "vibe", base64: "fixture" }] as any } : {}) });
    useAppStore.getState().setInpaintRecipe({ positivePrompt: "brooch" });
    if (kind === "mismatched model") useAppStore.setState({ inpaintRecipe: { ...useAppStore.getState().inpaintRecipe!, model: "nai-diffusion-3" } });
    await useAppStore.getState().inpaint();
    expect(naiDesktop.manualEnqueue).not.toHaveBeenCalled();
    expect(naiDesktop.quoteAnlas).not.toHaveBeenCalled();
    expect(useAppStore.getState().charCaptions).toEqual(characters);
    // In the interface language (step 4c1; review rework: each language asserted on its own).
    const toast = useAppStore.getState().toast ?? "";
    if (language === "zh-CN") { expect(toast).toContain("没有出图"); expect(toast).not.toMatch(/[Nn]othing was generated/); }
    else { expect(toast).toMatch(/Nothing was generated|nothing was generated/); expect(toast).not.toMatch(/[\u4e00-\u9fff]/); }
  });
});
