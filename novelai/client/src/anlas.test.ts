import { describe, expect, it } from "vitest";
import {
  calculateDirectorAnlas,
  calculateImageGenerationAnlas,
  calculateUpscaleAnlas,
} from "./anlas";
import { DEFAULT_PARAMS, type AccountSummary } from "./types";

const paidAccount: AccountSummary = {
  hasToken: true,
  tierLevel: 1,
  tierName: "Tablet",
  hasActiveSubscription: true,
  anlasBalance: 1000,
};

const opusAccount: AccountSummary = {
  hasToken: true,
  tierLevel: 3,
  tierName: "Opus",
  hasActiveSubscription: true,
  anlasBalance: 1000,
};

describe("official Anlas pricing", () => {
  it("prices the V5 default with the established 832x1216, 28-step parameters at 20 Anlas", () => {
    const quote = calculateImageGenerationAnlas({
      params: { ...DEFAULT_PARAMS, model: "nai-diffusion-4-5-full" },
      account: paidAccount,
    });
    expect(quote.amount).toBe(20);
  });

  it("makes eligible single-image text generation free for active Opus", () => {
    const quote = calculateImageGenerationAnlas({
      params: { ...DEFAULT_PARAMS, model: "nai-diffusion-4-5-full" },
      account: opusAccount,
    });
    expect(quote.amount).toBe(0);
  });

  it("applies image-to-image strength to the official base price", () => {
    const quote = calculateImageGenerationAnlas({
      params: { ...DEFAULT_PARAMS, model: "nai-diffusion-4-5-full" },
      account: paidAccount,
      action: "img2img",
      strength: 0.7,
    });
    expect(quote.amount).toBe(14);
  });

  // The official web client's price (build b94bdee-production, 2026-11-06, chunk 274ff5q_u23hy.js): every V5 model
  // costs 1.5× the formula; V5 Full Medium effort is (base + step·23) / 1.75 whatever its 14 steps.
  it("prices V5 at 1.5× the formula and V5 Full Medium effort about 42 % below High at 23 steps", () => {
    const at = (params: Partial<typeof DEFAULT_PARAMS>, extra: Partial<Parameters<typeof calculateImageGenerationAnlas>[0]> = {}) =>
      calculateImageGenerationAnlas({ params: { ...DEFAULT_PARAMS, ...params }, account: paidAccount, ...extra }).amount;
    expect(at({ steps: 28 }, { action: "img2img", strength: 0.7 })).toBe(21);
    expect(at({ steps: 23 })).toBe(26);
    expect(at({ steps: 23, effort: "medium" })).toBe(15);
    // Medium ignores the stored steps (it always runs 14) and applies only on V5 Full (or its inpainting model).
    expect(at({ steps: 50, effort: "medium" })).toBe(15);
    expect(at({ steps: 23, effort: "medium", model: "nai-diffusion-5-curated" })).toBe(26);
    expect(at({ steps: 23, effort: "medium" }, { action: "infill", executionModel: "nai-diffusion-5-full-inpainting" })).toBe(15);
    expect(at({ steps: 23, effort: "medium" }, { action: "infill", executionModel: "nai-diffusion-4-5-full-inpainting" })).toBe(26);
  });

  it("keeps Medium effort within the Opus allowance at 14 steps", () => {
    const quote = calculateImageGenerationAnlas({ params: { ...DEFAULT_PARAMS, steps: 40, effort: "medium" }, account: opusAccount });
    expect(quote.amount).toBe(0);
  });

  it("charges V4 vibe encoding as a one-time fee, not per batch image", () => {
    const quote = calculateImageGenerationAnlas({
      params: { ...DEFAULT_PARAMS, model: "nai-diffusion-4-5-full" },
      account: opusAccount,
      batchCount: 3,
      extras: {
        vibeImages: [
          { base64: "", infoExtracted: 0.7, strength: 0.5 },
          { base64: "", infoExtracted: 0.7, strength: 0.5 },
        ],
        charCaptions: [],
      },
    });
    // 2 vibes x 2 Anlas one-time = 4 (NOT multiplied by the 3-image batch).
    expect(quote.amount).toBe(4);
  });

  it("does not re-charge vibe encoding for already-cached references", () => {
    const vibes = {
      vibeImages: [
        { base64: "", infoExtracted: 0.7, strength: 0.5 },
        { base64: "", infoExtracted: 0.7, strength: 0.5 },
      ],
      charCaptions: [],
    };
    // Both already encoded+cached → no encode charge.
    expect(
      calculateImageGenerationAnlas({ params: { ...DEFAULT_PARAMS, model: "nai-diffusion-4-5-full" }, account: opusAccount, extras: vibes, alreadyEncodedVibes: 2 })
        .amount,
    ).toBe(0);
    // One cached, one new → only the new one is charged (2 Anlas).
    expect(
      calculateImageGenerationAnlas({ params: { ...DEFAULT_PARAMS, model: "nai-diffusion-4-5-full" }, account: opusAccount, extras: vibes, alreadyEncodedVibes: 1 })
        .amount,
    ).toBe(2);
  });

  it("charges a flat 5 Anlas per image for precise reference, regardless of reference count", () => {
    const oneRef = calculateImageGenerationAnlas({
      params: { ...DEFAULT_PARAMS, model: "nai-diffusion-4-5-full" },
      account: opusAccount, // base image is free for Opus, so only the reference fee remains
      batchCount: 2,
      extras: {
        vibeImages: [],
        charCaptions: [],
        preciseReferences: [{ base64: "", type: "character", strength: 1, fidelity: 1 }],
      },
    });
    expect(oneRef.amount).toBe(10); // 5 Anlas x 2 images (flat per image)

    const twoRefs = calculateImageGenerationAnlas({
      params: { ...DEFAULT_PARAMS, model: "nai-diffusion-4-5-full" },
      account: opusAccount,
      batchCount: 2,
      extras: {
        vibeImages: [],
        charCaptions: [],
        preciseReferences: [
          { base64: "", type: "character", strength: 1, fidelity: 1 },
          { base64: "", type: "style", strength: 1, fidelity: 1 },
        ],
      },
    });
    // Official docs: "5 Anlas to each image generation" — flat, NOT per reference.
    expect(twoRefs.amount).toBe(10);
  });

  it("does not estimate a Precise Reference surcharge on V5", () => {
    const quote = calculateImageGenerationAnlas({
      params: DEFAULT_PARAMS,
      account: opusAccount,
      batchCount: 2,
      extras: {
        vibeImages: [],
        charCaptions: [],
        preciseReferences: [{ base64: "", type: "character", strength: 1, fidelity: 1 }],
      },
    });
    expect((quote.details ?? []).join("\n")).not.toContain("Precise reference");
  });

  it("uses the official upscale pixel tier", () => {
    const quote = calculateUpscaleAnlas({
      image: { width: 1024, height: 1024 },
      account: opusAccount,
      scale: 4,
    });
    expect(quote.amount).toBe(14);
    expect(quote.details?.join("\n")).toContain("two fixed 2x");
  });

  it("returns a stable reason code when an upscale image is missing", () => {
    const quote = calculateUpscaleAnlas({
      image: null,
      account: opusAccount,
      scale: 4,
    });
    expect(quote.ok).toBe(false);
    expect(quote.reason).toBe("missing-image");
  });

  it("uses the fixed background-removal price", () => {
    const quote = calculateDirectorAnlas({
      tool: "bg-removal",
      account: paidAccount,
    });
    expect(quote.amount).toBe(65);
  });
});
