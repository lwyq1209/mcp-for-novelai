import type { CharCaption, PreciseReferenceItem, WorkingImage } from "../types";
import { MAX_NAI_PRECISE_REFERENCES, baseModelForInpaint, naiPreciseReferenceCapability } from "../types";
import { adaptiveNAIImageSize } from "../nai-dimensions";
import { WorkspaceError } from "./protocol";
import type { CreativeState } from "./state";
import { isSeededGeneration, type GenerationMode, type GenerationSnapshot } from "./generation-types";
import { resolvePostprocessRecipe } from "./generation-postprocess";
import { applyNAIEffort } from "../nai-effort";

/** Modes whose queued request carries precise references (the request has no mask and is a generation). */
export const PRECISE_REFERENCE_QUEUE_MODES: readonly GenerationMode[] = ["t2i", "i2i", "enhance"];

/** Queued generation is one provider request; Vibe Transfer needs a separate paid encode-vibe request first. */
export const QUEUE_VIBE_REFUSAL = "Queued generation does not send Vibe Transfer references (they need a separate paid encode request). Keep these materials and remove them from the active recipe before submitting.";

/**
 * Why a queued recipe cannot send these precise references, or null when it can. A queued recipe sends every
 * reference it holds or is refused: a reference the model would skip (an Outfit reference on V4.5) is never dropped
 * silently, because the image would be paid for without it.
 */
export function queuedPreciseReferenceProblem(references: ReadonlyArray<Pick<PreciseReferenceItem, "type">>, mode: GenerationMode, model: string): string | null {
  if (!references.length) return null;
  if (!PRECISE_REFERENCE_QUEUE_MODES.includes(mode)) return `Queued ${mode} does not send precise references (NovelAI V5 takes none with a mask); they are sent in t2i, i2i and enhance. Remove them from this recipe.`;
  const capability = naiPreciseReferenceCapability(model);
  if (!capability) return `The model ${model} has no Precise Reference; NovelAI V4.5 and V5 have it. Use one of those models or remove the precise references.`;
  if (references.length > MAX_NAI_PRECISE_REFERENCES) return `A request takes at most ${MAX_NAI_PRECISE_REFERENCES} precise references; this recipe has ${references.length}.`;
  if (!capability.outfit && references.some((reference) => reference.type === "costume")) return `The model ${model} has no Outfit references (NovelAI V5 has them) and would skip them. Remove the Outfit references or use a V5 model.`;
  return null;
}

export async function freezeGenerationInput(
  current: CreativeState,
  mode: GenerationMode,
  readImage: (image: WorkingImage) => Promise<{ mimeType: string; data: string }>,
): Promise<GenerationSnapshot> {
  // Clone before any file read; renderer edits must never alter a submitted recipe.
  const state = structuredClone(current);
  if (isSeededGeneration(mode) && state.vibeImages.length) throw new WorkspaceError("unsupported_reference", QUEUE_VIBE_REFUSAL);
  // Precise references travel inside the one request of a t2i, i2i or enhance image; upscale and director use none.
  const preciseReferences = isSeededGeneration(mode) ? state.preciseReferences : [];
  const referenceProblem = queuedPreciseReferenceProblem(preciseReferences, mode, state.params.model);
  if (referenceProblem) throw new WorkspaceError("unsupported_reference", referenceProblem);
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
      vibeImages: [],
      preciseReferences: preciseReferences.map(({ base64, type, strength, fidelity, prepared, sha256 }: PreciseReferenceItem) => ({ base64, type, strength, fidelity, ...(prepared ? { prepared: true } : {}), ...(sha256 ? { sha256 } : {}) })),
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
