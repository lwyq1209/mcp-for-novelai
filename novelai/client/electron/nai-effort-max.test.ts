/**
 * V5 Full Effort (Medium) and Enhance Max✨ request construction, against what the official web client sends
 * (https://novelai.net/image, build b94bdee-production, fetched 2026-11-06; facts and chunk names in
 * src/nai-effort.ts and src/nai-dimensions.ts). NovelAI is never called.
 */
import { describe, expect, it } from "vitest";
import { applyI2IParameters, applyOfficialInpaintParameters, buildPayload, prepareInpaintAssets } from "./ipc/nai";
import { DEFAULT_PARAMS, type GenerateParams } from "../src/types";
import { applyNAIEffort, naiRequestModel, NAI_MEDIUM_FIXED } from "../src/nai-effort";
import { maxEnhanceInputSize, maxEnhanceOutputSize, NAI_MAX_ENHANCE_INPUT_LIMIT } from "../src/nai-dimensions";
import { resolvePostprocessRecipe } from "../src/workspace/generation-postprocess";
import type { GenerationSnapshot } from "../src/workspace/generation-types";
import { PNG } from "pngjs";

const HEAVY = "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page";
const medium = (over: Partial<GenerateParams> = {}): GenerateParams => ({
  ...DEFAULT_PARAMS, model: "nai-diffusion-5-full", effort: "medium", positivePrompt: "1girl, smile", stylePrompt: "", negativePrompt: "hat, glasses",
  steps: 28, sampler: "k_dpmpp_2m", cfgScale: 4.5, cfgRescale: 0.3, ucPreset: 2, seed: 7, seedMode: "fixed", ...over,
});
const characters = { vibeImages: [], charCaptions: [{ prompt: "girl, red coat", negativePrompt: "hat", useCoords: false, x: 0.5, y: 0.5 }] };
const png = (width: number, height: number) => { const image = new PNG({ width, height }); image.data.fill(255); return PNG.sync.write(image); };

describe("V5 Full Medium effort requests", () => {
  it("t2i: the Medium model id, fixed steps/sampler/CFG rescale, Heavy UC with the nsfw rule, no negative prompts", () => {
    const payload = buildPayload(medium(), 7, characters);
    expect(payload.model).toBe("nai-diffusion-5-full-medium");
    expect(payload.action).toBe("generate");
    const p = payload.parameters as Record<string, any>;
    expect(p).toMatchObject({ steps: 14, sampler: "k_euler_ancestral", cfg_rescale: 0, scale: 4.5, ucPreset: 0, uc_preset: 0, tag_hint_uc_preset: 2, noise_schedule: "karras" });
    // The official builder: Heavy text built against an empty negative prompt; "nsfw, " because the prompt has none.
    expect(p.uc).toBe(`nsfw, ${HEAVY}`);
    expect(p.negative_prompt).toBe(`nsfw, ${HEAVY}`);
    expect(p.v4_negative_prompt.caption.base_caption).toBe(`nsfw, ${HEAVY}`);
    // Every character's uc is empty (the official builder sends ""), so no negative character caption is sent.
    expect(p.v4_negative_prompt.caption.char_captions).toEqual([]);
    expect(p.v4_prompt.caption.char_captions).toEqual([{ char_caption: "girl, red coat", centers: [{ x: 0.5, y: 0.5 }] }]);
    // Euler Ancestral with Karras: the sampler fields the official client sends for it.
    expect(p).toMatchObject({ deliberate_euler_ancestral_bug: false, prefer_brownian: true });
    expect(payload.input).toBe("1girl, smile, very aesthetic, masterpiece, no text");
  });

  it("leaves out the nsfw prefix when the prompt (any case) already asks for nsfw", () => {
    const p = buildPayload(medium({ positivePrompt: "1girl, NSFW" }), 7).parameters as Record<string, any>;
    expect(p.uc).toBe(HEAVY);
    expect(p.v4_negative_prompt.caption.base_caption).toBe(HEAVY);
  });

  it("i2i: the same Medium request with the img2img fields", () => {
    const payload = applyI2IParameters(buildPayload(medium({ width: 832, height: 1216 }), 7), "SOURCE", { strength: 0.6, noise: 0, extraNoiseSeed: 5 }, 5);
    expect(payload.model).toBe("nai-diffusion-5-full-medium");
    expect(payload.action).toBe("img2img");
    expect(payload.parameters).toMatchObject({ image: "SOURCE", strength: 0.6, extra_noise_seed: 5, steps: 14, sampler: "k_euler_ancestral", uc: `nsfw, ${HEAVY}`, tag_hint_uc_preset: 2 });
    expect(payload.parameters).not.toHaveProperty("upscaled_enhance");
  });

  it("inpaint: the Medium inpainting model; strength below 1 adds img2img {strength, color_correct: true} as on High", () => {
    const assets = prepareInpaintAssets(png(64, 64), png(64, 64).toString("base64"));
    const payload = buildPayload({ ...medium(), model: "nai-diffusion-5-full-inpainting", width: assets.width, height: assets.height }, 9);
    payload.action = "infill";
    applyOfficialInpaintParameters(payload.parameters, assets, 0.6, 0, 9);
    expect(payload.model).toBe("nai-diffusion-5-full-medium-inpainting");
    expect(payload.parameters).toMatchObject({ steps: 14, sampler: "k_euler_ancestral", cfg_rescale: 0, uc: `nsfw, ${HEAVY}`, tag_hint_uc_preset: 2, inpaintImg2ImgStrength: 0.6, img2img: { strength: 0.6, color_correct: true } });
    const full = buildPayload({ ...medium(), model: "nai-diffusion-5-full-inpainting", width: assets.width, height: assets.height }, 9);
    applyOfficialInpaintParameters(full.parameters, assets, 1, 0, 9);
    expect(full.parameters).not.toHaveProperty("img2img");
  });

  it("High (no effort) is unchanged, and Medium on a model without it is not sent", () => {
    const high = buildPayload({ ...medium(), effort: undefined }, 7);
    expect(high.model).toBe("nai-diffusion-5-full");
    expect(high.parameters).toMatchObject({ steps: 28, sampler: "k_dpmpp_2m", cfg_rescale: 0.3 });
    expect(high.parameters).not.toHaveProperty("tag_hint_uc_preset");
    expect(buildPayload({ ...medium(), effort: "high" }, 7)).toEqual(high);
    for (const model of ["nai-diffusion-5-curated", "nai-diffusion-4-5-full"] as const) {
      const payload = buildPayload(medium({ model }), 7);
      expect(payload.model).toBe(model);
      expect(payload.parameters).toMatchObject({ steps: 28 });
    }
    expect(buildPayload({ ...medium(), model: "nai-diffusion-5-curated-inpainting" }, 7).model).toBe("nai-diffusion-5-curated-inpainting");
  });

  it("applyNAIEffort lists what Medium replaced and strips a High or unsupported effort", () => {
    const applied = applyNAIEffort(medium(), "nai-diffusion-5-full");
    expect(applied.effort).toBe("medium");
    expect(applied.params).toMatchObject({ ...NAI_MEDIUM_FIXED, negativePrompt: "", effort: "medium" });
    expect(applied.replaced).toEqual([
      { field: "steps", from: 28, to: 14 }, { field: "sampler", from: "k_dpmpp_2m", to: "k_euler_ancestral" },
      { field: "cfgRescale", from: 0.3, to: 0 }, { field: "ucPreset", from: 2, to: 0 }, { field: "negativePrompt", from: "hat, glasses", to: "" },
    ]);
    expect(applyNAIEffort(medium(), "nai-diffusion-4-5-full").params).not.toHaveProperty("effort");
    const high = { ...DEFAULT_PARAMS };
    expect(applyNAIEffort(high, "nai-diffusion-5-full").params).toBe(high);
    expect(naiRequestModel("nai-diffusion-5-full-inpainting", "medium")).toBe("nai-diffusion-5-full-medium-inpainting");
    expect(naiRequestModel("nai-diffusion-5-curated", "medium")).toBe("nai-diffusion-5-curated");
  });
});

describe("Enhance Max✨", () => {
  it("sends upscaled_enhance with the source at its own size, on V5 only", () => {
    const payload = applyI2IParameters(buildPayload({ ...DEFAULT_PARAMS, positivePrompt: "1girl", width: 832, height: 1216 }, 3), "SOURCE", { strength: 0.2, noise: 0, extraNoiseSeed: 4, upscaledEnhance: true }, 4);
    expect(payload.action).toBe("img2img");
    expect(payload.parameters).toMatchObject({ width: 832, height: 1216, upscaled_enhance: true, strength: 0.2, image: "SOURCE" });
    // Max takes no "-2::upscaled, blurry::" prompt addition (the official 1×/1.5×/2× enhance does; this app never did).
    expect(payload.input).not.toContain("upscaled");
    expect(() => applyI2IParameters(buildPayload({ ...DEFAULT_PARAMS, model: "nai-diffusion-4-5-full", positivePrompt: "1girl" }, 3), "SOURCE", { strength: 0.2, noise: 0, extraNoiseSeed: 4, upscaledEnhance: true }, 4)).toThrow(/V5/);
  });

  it("sizes: the input is the 64-aligned source under 0.8 × 3,145,728 pixels; the result is the official expected size", () => {
    expect(maxEnhanceInputSize(832, 1216)).toEqual({ width: 832, height: 1216, resized: false });
    expect(maxEnhanceInputSize(830, 1210)).toEqual({ width: 832, height: 1216, resized: true });
    const big = maxEnhanceInputSize(1600, 1600);
    expect(big.width * big.height).toBeLessThan(NAI_MAX_ENHANCE_INPUT_LIMIT);
    expect(big).toEqual({ width: 1536, height: 1536, resized: true });
    // A side already at 64 cannot shrink with the other: only the long side is shortened.
    const strip = maxEnhanceInputSize(49152, 64);
    expect(strip).toEqual({ width: 39296, height: 64, resized: true });
    expect(strip.width * strip.height).toBeLessThan(NAI_MAX_ENHANCE_INPUT_LIMIT);
    // The official `T`: each side floored to 16 and doubled, fitted into 3,145,728 pixels in steps of 32.
    expect(maxEnhanceOutputSize(512, 768)).toEqual({ width: 1024, height: 1536 });
    expect(maxEnhanceOutputSize(832, 1216)).toEqual({ width: 1440, height: 2144 });
    expect(maxEnhanceOutputSize(1024, 1024)).toEqual({ width: 1760, height: 1760 });
  });

  it("the enhance recipe: scale max freezes the Max input size, upscaled_enhance and the expected result, and runs High", () => {
    const snapshot = { params: { ...DEFAULT_PARAMS, positivePrompt: "1girl", effort: "medium" }, extras: { vibeImages: [], charCaptions: [] }, enhance: { magnitude: 3, scale: "max", requestedNoise: 0 }, i2i: { strength: 0.9, noise: 0, extraNoiseSeed: 0 } } as GenerationSnapshot;
    resolvePostprocessRecipe(snapshot, "enhance", { width: 830, height: 1210 });
    expect(snapshot.params).toMatchObject({ width: 832, height: 1216 });
    expect(snapshot.params).not.toHaveProperty("effort");
    expect(snapshot.i2i).toMatchObject({ upscaledEnhance: true, strength: Math.min(0.48, 0.10 + 3 * 0.034) });
    expect(snapshot.processing).toEqual({ inputWidth: 832, inputHeight: 1216, outputWidth: 1440, outputHeight: 2144, resizedInput: true, alphaFlattened: false, upscaledEnhance: true });
    expect(snapshot.unusedInputs).toContain("params.effort");
    const v45 = { ...snapshot, params: { ...DEFAULT_PARAMS, model: "nai-diffusion-4-5-full" as const }, enhance: { magnitude: 3, scale: "max" as const, requestedNoise: 0 } };
    expect(() => resolvePostprocessRecipe(v45, "enhance", { width: 832, height: 1216 })).toThrow(/V5/);
    // 1× and 2× are unchanged.
    const one = { ...snapshot, params: { ...DEFAULT_PARAMS, positivePrompt: "1girl" }, enhance: { magnitude: 3, scale: 2 as const, requestedNoise: 0 } };
    resolvePostprocessRecipe(one, "enhance", { width: 512, height: 768 });
    expect(one.params).toMatchObject({ width: 1024, height: 1536 });
    expect(one.i2i).not.toHaveProperty("upscaledEnhance");
    expect(one.processing).toEqual({ inputWidth: 1024, inputHeight: 1536, outputWidth: 1024, outputHeight: 1536, resizedInput: true, alphaFlattened: false });
  });
});
