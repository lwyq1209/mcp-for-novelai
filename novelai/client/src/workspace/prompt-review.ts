import { normalizeGenerateParams, type WorkingImage } from "../types";
import { imageBase64, imageMime, type CreativeState } from "./state";
import type { GenerationMode } from "./generation-types";

export interface PromptReviewAsset {
  role: string;
  mimeType: string;
  data: string;
  width: number;
  height: number;
  sha256: string;
  usedForGeneration: boolean;
}
export interface PromptReviewPreparation {
  mode: GenerationMode;
  authored: Record<string, any>;
  assets: Array<{ role: string; mimeType: string; data: string }>;
}
export interface PromptReviewInput {
  mode: GenerationMode;
  authored: Record<string, any>;
  effective: { request: Record<string, any>; sampling: Record<string, any>; sourceRole: string | null; maskRole: string | null } | null;
  recipeScope: "base" | "legacy_inpaint" | "independent_inpaint" | "postprocess";
  unusedInputs: string[];
  readiness: { status: "ready" | "blocked"; issues: Array<{ code: string; message: string }> };
  assets: PromptReviewAsset[];
}
export interface PromptReviewResult {
  schemaVersion: 1;
  workspaceId: string;
  revision: number;
  mode: GenerationMode;
  draftId: string | null;
  reviewInput: PromptReviewInput;
}

const scalarKeys = ["modelMode", "inpaintModel", "inpaintStrength", "inpaintNoise", "inpaintPositivePrompt", "i2iSourceMode", "inpaintSourceMode", "i2iSizeMode", "enhanceMagnitude", "enhanceScale", "upscaleScale", "directorTool"] as const;
const pick = (value: unknown, keys: readonly string[]) => {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return Object.fromEntries(keys.filter(key => source[key] !== undefined && ["string", "number", "boolean"].includes(typeof source[key])).map(key => [key, source[key]]));
};

/** Shared allowlist. No paths, renderer identifiers, settings or arbitrary objects. */
export function authoredPromptReview(state: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {
    params: normalizeGenerateParams(state.params),
    inpaintRecipe: state.inpaintRecipe == null ? null : normalizeGenerateParams(state.inpaintRecipe),
    i2iParams: pick(state.i2iParams, ["strength", "noise", "extraNoiseSeed"]),
    augmentOptions: pick(state.augmentOptions, ["defry", "colorizePrompt", "emotion", "emotionLevel"]),
    charCaptions: (Array.isArray(state.charCaptions) ? state.charCaptions : []).map((item: unknown) => pick(item, ["prompt", "negativePrompt", "useCoords", "x", "y"])),
    vibeImages: (Array.isArray(state.vibeImages) ? state.vibeImages : []).map((item: unknown) => pick(item, ["name", "infoExtracted", "strength"])),
    preciseReferences: (Array.isArray(state.preciseReferences) ? state.preciseReferences : []).map((item: unknown) => pick(item, ["name", "type", "strength", "fidelity", "informationExtracted"])),
  };
  Object.assign(result, pick(state, scalarKeys));
  return result;
}

/** Freeze authored state and image bytes without choosing seeds or applying drafts. */
export async function collectPromptReview(
  current: CreativeState,
  mode: GenerationMode,
  readImage: (image: WorkingImage) => Promise<{ mimeType: string; data: string }>,
): Promise<PromptReviewPreparation> {
  const state = structuredClone(current), authored = authoredPromptReview(state);
  const assets: PromptReviewPreparation["assets"] = [];
  const sourceMode = mode === "i2i" ? state.i2iSourceMode : mode === "inpaint" ? state.inpaintSourceMode : "latest";
  const source = (sourceMode === "original" ? state.i2iOriginalImage ?? state.workbenchImage : state.workbenchImage) as WorkingImage | null;
  if (source) assets.push({ role: "source", ...await readImage(source) });
  if (state.inpaintMask) {
    const data = imageBase64(state.inpaintMask, "inpaintMask");
    assets.push({ role: "mask", mimeType: imageMime(data), data });
  }
  for (const key of ["vibeImages", "preciseReferences"] as const) for (const [index, item] of state[key].entries()) {
    const data = imageBase64(item.base64, key);
    assets.push({ role: `${key}:${index}`, mimeType: imageMime(data), data });
  }
  return { mode, authored, assets };
}
