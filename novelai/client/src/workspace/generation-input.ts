import type { CharCaption, WorkingImage } from "../types";
import { baseModelForInpaint } from "../types";
import { adaptiveNAIImageSize } from "../nai-dimensions";
import { WorkspaceError } from "./protocol";
import type { CreativeState } from "./state";
import { isSeededGeneration, type GenerationMode, type GenerationSnapshot } from "./generation-types";
import { resolvePostprocessRecipe } from "./generation-postprocess";
import { applyNAIEffort } from "../nai-effort";

export async function freezeGenerationInput(
  current: CreativeState,
  mode: GenerationMode,
  readImage: (image: WorkingImage) => Promise<{ mimeType: string; data: string }>,
): Promise<GenerationSnapshot> {
  // Clone before any file read; renderer edits must never alter a submitted recipe.
  const state = structuredClone(current);
  if (isSeededGeneration(mode) && (state.vibeImages.length || state.preciseReferences.length)) throw new WorkspaceError("unsupported_reference", "Queue generation does not encode references in this version. Keep these materials and remove them from the active recipe before submitting.");
  const independentInpaint = mode === "inpaint" && state.inpaintRecipe != null;
  if (mode === "inpaint" && !independentInpaint && state.charCaptions.length) throw new WorkspaceError("unsupported_configuration", "The current inpaint protocol does not accept character captions. They were preserved; use a recipe without character captions for this operation.");
  const params = { ...(independentInpaint ? state.inpaintRecipe : state.params) };
  if (independentInpaint && params.model !== baseModelForInpaint(state.inpaintModel)) throw new WorkspaceError("invalid_configuration", "The independent recipe model must match the selected inpaint model.");
  if (mode === "inpaint" && !independentInpaint) params.positivePrompt = state.inpaintPositivePrompt;
  if (isSeededGeneration(mode) && !params.positivePrompt.trim()) throw new WorkspaceError("invalid_configuration", "Enter a positive prompt for this generation mode first.");
  // V5 Full Effort: Medium's fixed steps, sampler, CFG rescale, UC preset and empty negative prompt are frozen as
  // they will run (its execution model: the inpainting model for inpaint). Enhance drops it (resolvePostprocessRecipe).
  const effective = mode === "t2i" || mode === "i2i" || mode === "inpaint" ? applyNAIEffort(params, mode === "inpaint" ? state.inpaintModel : params.model).params : params;
  const snapshot: GenerationSnapshot = {
    params: effective,
    extras: {
      vibeImages: [], preciseReferences: [],
      charCaptions: (isSeededGeneration(mode) && !independentInpaint ? state.charCaptions : []).map(({ prompt, negativePrompt, useCoords, x, y }: CharCaption) => ({ prompt, negativePrompt, useCoords, x, y })),
      modelMode: state.modelMode as "anime" | "furry",
      historyGroupId: state.generationGroupId,
    },
    batchCount: state.batchCount,
    ...(independentInpaint ? { recipeScope: "independent_inpaint" as const, unusedInputs: ["params", "charCaptions", "inpaintPositivePrompt"] } : {}),
  };
  if (mode !== "t2i") {
    const sourceMode = mode === "i2i" ? state.i2iSourceMode : mode === "inpaint" ? state.inpaintSourceMode : "latest";
    const source = (sourceMode === "original" ? state.i2iOriginalImage ?? state.workbenchImage : state.workbenchImage) as WorkingImage | null;
    if (!source) throw new WorkspaceError("invalid_configuration", "Select a source image before submitting this mode.");
    if (mode === "inpaint") {
      if (!state.inpaintMask) throw new WorkspaceError("invalid_mask", "Paint or apply a mask before submitting inpaint.");
      snapshot.inpaint = { model: state.inpaintModel, maskBase64: state.inpaintMask, strength: state.inpaintStrength, noise: 0 };
      Object.assign(snapshot.params, { width: source.width, height: source.height });
    } else if (mode === "i2i") {
      snapshot.i2i = { ...state.i2iParams };
      if (state.i2iSizeMode === "adaptive") Object.assign(snapshot.params, adaptiveNAIImageSize(source.width, source.height, snapshot.params));
    }
    if (mode === "enhance") {
      snapshot.enhance = { magnitude: state.enhanceMagnitude, scale: state.enhanceScale, requestedNoise: 0 };
      snapshot.i2i = { ...state.i2iParams };
    }
    if (mode === "upscale") snapshot.upscale = { scale: state.upscaleScale as 2 };
    if (mode === "director") snapshot.director = { tool: state.directorTool, options: { ...state.augmentOptions } };
    resolvePostprocessRecipe(snapshot, mode, source);
    snapshot.sourceSummary = { width: source.width, height: source.height, sourceMode };
    snapshot.sourceImage = await readImage(source);
  }
  return snapshot;
}
