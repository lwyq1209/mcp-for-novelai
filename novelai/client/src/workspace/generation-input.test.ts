import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store";
import { DEFAULT_PARAMS } from "../types";
import { pickCreativeState } from "./state";
import { freezeGenerationInput } from "./generation-input";

// freezeGenerationInput is the one freeze of every recipe (the host builds and queues it through
// electron/prompt-review.ts); these cases were checked through the retired canvas submission until 2026-11-02.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=";
const source = { filePath: "/fixture/source.png", fileUrl: "localmedia://source", width: 832, height: 1216 };
function defer<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const image = async () => ({ mimeType: "image/png", data: PNG });
beforeEach(() => { useAppStore.setState(useAppStore.getInitialState(), true); useAppStore.setState({ params: { ...DEFAULT_PARAMS, positivePrompt: "adult gardener, sunlit garden" }, workbenchImage: source }); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("freezeGenerationInput freezes the given state", () => {
  it("freezes an explicit independent recipe while retaining every base character and parameter", async () => {
    const gate = defer<{ mimeType: string; data: string }>();
    const chars = ["adult gardener", "adult visitor", "adult florist"].map((prompt, i) => ({ id: String(i), prompt, negativePrompt: "hat", useCoords: true, x: .2 + i * .3, y: .5 }));
    const recipe = { ...DEFAULT_PARAMS, positivePrompt: "small silver brooch on blue coat", negativePrompt: "oversized jewelry", steps: 24, cfgScale: 4.5, seedMode: "fixed" as const, seed: 321 };
    useAppStore.setState({ charCaptions: chars, inpaintRecipe: recipe, inpaintMask: PNG, inpaintPositivePrompt: "legacy red coat" });
    const base = structuredClone(useAppStore.getState().params);
    const frozen = freezeGenerationInput(pickCreativeState(useAppStore.getState()), "inpaint", () => gate.promise);
    useAppStore.setState({ inpaintRecipe: { ...recipe, positivePrompt: "manual next detail", steps: 30 } });
    gate.resolve({ mimeType: "image/png", data: PNG });
    const result = await frozen;
    expect(result.params).toMatchObject({ ...recipe, width: source.width, height: source.height });
    expect(result.extras.charCaptions).toEqual([]);
    expect(result.recipeScope).toBe("independent_inpaint");
    expect(result.unusedInputs).toEqual(["params", "charCaptions", "inpaintPositivePrompt"]);
    expect(useAppStore.getState().params).toEqual(base);
    expect(useAppStore.getState().charCaptions).toEqual(chars);
    const baseSnapshot = await freezeGenerationInput(pickCreativeState(useAppStore.getState()), "t2i", image);
    expect(baseSnapshot.params).toEqual(base);
    expect(baseSnapshot.extras.charCaptions).toHaveLength(3);
    expect(baseSnapshot.recipeScope).toBeUndefined();
    const next = await freezeGenerationInput(pickCreativeState(useAppStore.getState()), "inpaint", image);
    expect(next.params).toMatchObject({ positivePrompt: "manual next detail", steps: 30 });
    useAppStore.setState({ inpaintRecipe: null });
    const legacy = await freezeGenerationInput({ ...pickCreativeState(useAppStore.getState()), charCaptions: [] }, "inpaint", image);
    expect(legacy.params).toMatchObject({ positivePrompt: "legacy red coat", negativePrompt: base.negativePrompt });
  });

  it("freezes original source bytes and effective inpaint recipe, independently of later state edits", async () => {
    const gate = defer<{ mimeType: string; data: string }>();
    const original = { ...source, fileUrl: "localmedia://original", width: 513, height: 769 };
    useAppStore.setState({ i2iOriginalImage: original, inpaintSourceMode: "original", inpaintMask: PNG, inpaintPositivePrompt: "blue cotton coat", inpaintNoise: .8, batchCount: 4 });
    const readImage = vi.fn(() => gate.promise);
    const frozen = freezeGenerationInput(pickCreativeState(useAppStore.getState()), "inpaint", readImage);
    useAppStore.setState({ inpaintPositivePrompt: "new manual prompt", i2iOriginalImage: source });
    gate.resolve({ mimeType: "image/png", data: PNG });
    const result = await frozen;
    expect(readImage).toHaveBeenCalledWith(original);
    expect(result.params).toMatchObject({ positivePrompt: "blue cotton coat", width: 513, height: 769 });
    expect(result.inpaint).toMatchObject({ maskBase64: PNG, noise: 0 });
    expect(result.batchCount).toBe(4);
    expect(result.sourceImage?.data).toBe(PNG);
  });
});

describe("Canvas postprocessing freezes the visible source and recipe", () => {
  it("freezes Enhance from the current workbench, disregarding the original-source toggle and old i2i strength", async () => {
    const original = { ...source, filePath: "/fixture/old.png", width: 64, height: 64 };
    const current = { ...source, width: 512, height: 768 };
    useAppStore.setState({ workbenchImage: current, i2iOriginalImage: original, i2iSourceMode: "original", enhanceMagnitude: 4, enhanceScale: 2, i2iParams: { strength: .99, noise: .8, extraNoiseSeed: 333 } });
    const readImage = vi.fn(image);
    const snapshot = await freezeGenerationInput(pickCreativeState(useAppStore.getState()), "enhance", readImage);
    expect(readImage).toHaveBeenCalledWith(current);
    expect(snapshot.params).toMatchObject({ width: 1024, height: 1536 });
    expect(snapshot.enhance).toMatchObject({ magnitude: 4, scale: 2 });
    expect(snapshot.enhance!.requestedNoise).toBeCloseTo(.074);
    expect(snapshot.i2i!.strength).toBeCloseTo(.236); expect(snapshot.i2i).toMatchObject({ noise: 0, extraNoiseSeed: 333 });
    expect(snapshot.processing).toMatchObject({ inputWidth: 1024, outputHeight: 1536, resizedInput: true });
    expect(useAppStore.getState().i2iParams.strength).toBe(.99);
  });

  it("rejects oversized Enhance and 4× Upscale before reading source", async () => {
    useAppStore.setState({ enhanceScale: 2, upscaleScale: 4 });
    const read = vi.fn();
    await expect(freezeGenerationInput(pickCreativeState(useAppStore.getState()), "enhance", read)).rejects.toMatchObject({ code: "invalid_configuration" });
    await expect(freezeGenerationInput(pickCreativeState(useAppStore.getState()), "upscale", read)).rejects.toMatchObject({ code: "unsupported_configuration" });
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["upscale", "director"] as const)("%s keeps unused prompt and references in the workspace while freezing a separate image recipe", async mode => {
    const gate = defer<{ mimeType: string; data: string }>();
    useAppStore.setState({ params: { ...DEFAULT_PARAMS, positivePrompt: "" }, upscaleScale: 2, directorTool: "colorize", augmentOptions: { defry: 2, colorizePrompt: "blue ceramic teacup", emotion: "happy", emotionLevel: 1 }, vibeImages: [{ id: "ref", base64: PNG, previewUrl: "data:image/png;base64," + PNG, strength: .8, infoExtracted: 1 }] });
    const frozen = freezeGenerationInput(pickCreativeState(useAppStore.getState()), mode, () => gate.promise);
    useAppStore.setState({ augmentOptions: { defry: 5, colorizePrompt: "later red object", emotion: "sad", emotionLevel: 5 } });
    gate.resolve({ mimeType: "image/png", data: PNG }); const snapshot = await frozen;
    expect(snapshot.extras.vibeImages).toEqual([]); expect(snapshot.unusedInputs).toContain("params");
    expect(useAppStore.getState().vibeImages).toHaveLength(1);
    expect(snapshot.sourceSummary?.sourceMode).toBe("latest");
    if (mode === "director") expect(snapshot.director).toMatchObject({ tool: "colorize", options: { colorizePrompt: "blue ceramic teacup", defry: 2 } });
  });
});
