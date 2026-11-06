import { describe, expect, it } from "vitest";
import { validatePatch, type CreativeState } from "./state";
import { DEFAULT_I2I_PARAMS, DEFAULT_PARAMS, DEFAULT_AUGMENT_OPTIONS } from "../types";

const current = (): CreativeState => ({
  params: { ...DEFAULT_PARAMS }, i2iParams: { ...DEFAULT_I2I_PARAMS }, augmentOptions: { ...DEFAULT_AUGMENT_OPTIONS }, charCaptions: [], vibeImages: [], preciseReferences: [],
  inpaintModel: "nai-diffusion-5-full-inpainting", inpaintRecipe: null, enhanceMagnitude: 3, enhanceScale: 1, workbenchImage: null, modelMode: "anime",
} as unknown as CreativeState);

describe("draft patches for V5 Full Effort and Enhance Max✨", () => {
  it("params.effort: medium is stored, high clears it, anything else is refused", () => {
    expect(validatePatch({ params: { effort: "medium" } }, current()).params).toMatchObject({ effort: "medium" });
    const cleared = validatePatch({ params: { effort: "high" } }, { ...current(), params: { ...DEFAULT_PARAMS, effort: "medium" } });
    expect(cleared.params).not.toHaveProperty("effort");
    expect(() => validatePatch({ params: { effort: "low" } }, current())).toThrow(/effort/);
    expect(validatePatch({ inpaintRecipe: { effort: "medium" } }, current()).inpaintRecipe).toMatchObject({ model: "nai-diffusion-5-full", effort: "medium" });
  });

  it("enhanceScale takes 1, 2 or \"max\"", () => {
    expect(validatePatch({ enhanceScale: "max" }, current()).enhanceScale).toBe("max");
    expect(validatePatch({ enhanceScale: 2 }, current()).enhanceScale).toBe(2);
    expect(() => validatePatch({ enhanceScale: "huge" }, current())).toThrow();
    expect(() => validatePatch({ enhanceScale: 3 }, current())).toThrow();
  });
});
