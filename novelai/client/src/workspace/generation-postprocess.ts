import { DIRECTOR_TOOLS, EMOTION_OPTIONS, MAX_NAI_UPSCALE_INPUT_PIXELS, MAX_NAI_UPSCALE_OUTPUT_DIMENSION, MAX_NAI_DIRECTOR_INPUT_PIXELS } from "../types";
import { adaptiveNAIImageSize, resolveNAIEnhanceOutputSize } from "../nai-dimensions";
import { WorkspaceError } from "./protocol";
import type { GenerationMode, GenerationSnapshot } from "./generation-types";

export const QUEUE_UPSCALE_MODEL = "nai-diffusion-5-curated";

/** Resolve the same bounded recipe in both renderer and main from source dimensions. */
/** manual: a manual batch item (the window's Generate), whose upscale may also be 4× (two requests). */
export function resolvePostprocessRecipe(snapshot: GenerationSnapshot, mode: GenerationMode, source: { width: number; height: number }, options: { manual?: boolean } = {}) {
  if (!["enhance", "upscale", "director"].includes(mode)) return;
  if (mode === "enhance") {
    const recipe = snapshot.enhance;
    if (!recipe || !Number.isInteger(recipe.magnitude) || recipe.magnitude < 1 || recipe.magnitude > 10 || ![1, 2].includes(recipe.scale)) throw new WorkspaceError("invalid_configuration", "Enhance requires magnitude 1–10 and scale 1 or 2.");
    const requested = resolveNAIEnhanceOutputSize(source.width, source.height, recipe.scale, snapshot.params);
    if (recipe.scale === 2 && requested.exceedsLimit) throw new WorkspaceError("invalid_configuration", "The requested 2× Enhance size exceeds the generation pixel limit.");
    const size = adaptiveNAIImageSize(requested.width, requested.height, snapshot.params);
    Object.assign(snapshot.params, size);
    recipe.requestedNoise = Math.min(.22, .018 + recipe.magnitude * .014);
    snapshot.i2i = { strength: Math.min(.48, .10 + recipe.magnitude * .034), noise: 0, extraNoiseSeed: snapshot.i2i?.extraNoiseSeed ?? 0 };
    snapshot.processing = { inputWidth: size.width, inputHeight: size.height, outputWidth: size.width, outputHeight: size.height, resizedInput: size.width !== source.width || size.height !== source.height, alphaFlattened: false };
    snapshot.unusedInputs = ["i2iParams.strength", "i2iParams.noise", "inpaintMask", "inpaintPositivePrompt"];
    return;
  }
  const cap = mode === "upscale" ? MAX_NAI_UPSCALE_INPUT_PIXELS : MAX_NAI_DIRECTOR_INPUT_PIXELS;
  const ratio = source.width * source.height > cap ? Math.sqrt(cap / (source.width * source.height)) : 1;
  const width = Math.max(1, Math.floor(source.width * ratio));
  const height = Math.max(1, Math.floor(source.height * ratio));
  const upscale = mode === "upscale" ? snapshot.upscale?.scale ?? 0 : 1;
  if (mode === "upscale") {
    if (upscale !== 2 && !(options.manual && upscale === 4)) throw new WorkspaceError("unsupported_configuration", "Queue upscale supports one 2× request. Manual 4× remains available and requires two requests.");
    // The window names the size and the limit (generation.upscale_too_large), as its manual upscale always did.
    if (width * upscale > MAX_NAI_UPSCALE_OUTPUT_DIMENSION || height * upscale > MAX_NAI_UPSCALE_OUTPUT_DIMENSION) throw Object.assign(new WorkspaceError("invalid_configuration", "Upscale output exceeds the maximum supported dimensions."), { reason: "generation.upscale_too_large", params: { width: width * upscale, height: height * upscale, max: MAX_NAI_UPSCALE_OUTPUT_DIMENSION } });
  } else {
    const recipe = snapshot.director;
    if (!recipe || !DIRECTOR_TOOLS.some(item => item.value === recipe.tool)) throw Object.assign(new WorkspaceError("invalid_configuration", "Unknown Director tool."), { reason: "generation.director_tool" });
    const options = recipe.options;
    if (!options || !Number.isInteger(options.defry) || options.defry < 0 || options.defry > 5 || !Number.isInteger(options.emotionLevel) || options.emotionLevel < 0 || options.emotionLevel > 5 || typeof options.colorizePrompt !== "string" || options.colorizePrompt.length > 30000 || !EMOTION_OPTIONS.some(item => item.value === options.emotion)) throw Object.assign(new WorkspaceError("invalid_configuration", "Invalid Director options."), { reason: "generation.director_options" });
    // Keep only the existing UI's public recipe fields, never arbitrary IPC properties.
    recipe.options = { defry: options.defry, colorizePrompt: options.colorizePrompt, emotion: options.emotion, emotionLevel: options.emotionLevel };
  }
  snapshot.processing = { inputWidth: width, inputHeight: height, outputWidth: mode === "upscale" ? width * upscale : source.width, outputHeight: mode === "upscale" ? height * upscale : source.height, resizedInput: ratio !== 1, alphaFlattened: mode === "director" };
  snapshot.unusedInputs = ["params", "charCaptions", "vibeImages", "preciseReferences", "modelMode", "i2iParams", "inpaintMask", "inpaintPositivePrompt", "batchCount"];
  if (mode === "director") snapshot.unusedInputs.push(...(snapshot.director!.tool === "colorize" ? ["augmentOptions.emotion", "augmentOptions.emotionLevel"] : snapshot.director!.tool === "emotion" ? ["augmentOptions.colorizePrompt"] : ["augmentOptions.colorizePrompt", "augmentOptions.emotion", "augmentOptions.emotionLevel"]));
}
