import { createHash } from "node:crypto";
import { buildT2iReviewEffective } from './t2i-review-effective';
import sharp from "sharp";
import { PNG } from "pngjs";
import { buildPayload, applyI2IParameters, applyOfficialInpaintParameters, prepareInpaintAssets, resizeImageBufferToPng, prepareLimitedImage, buildUpscalePayload, buildDirectorPayload } from "./ipc/nai";
import { MAX_NAI_DIRECTOR_INPUT_PIXELS, MAX_NAI_UPSCALE_INPUT_PIXELS, NAI_INPAINT_MODELS } from "../src/types";
import { freezeGenerationInput } from "../src/workspace/generation-input";
import { isSeededGeneration, GENERATION_MODES } from "../src/workspace/generation-types";
import { authoredPromptReview, type PromptReviewPreparation, type PromptReviewInput, type PromptReviewAsset } from "../src/workspace/prompt-review";
import { imageBase64, imageMime, type CreativeState } from "../src/workspace/state";
import { WorkspaceError } from "../src/workspace/protocol";
import { ImageConversionError, nativeImageInput } from "./ipc/image-codec";

/** One state adapter for both reviewed requests and independent queued recipes. */
function reviewState(authored: Record<string, any>, assets: PromptReviewAsset[]): CreativeState {
  const source = assets.find(asset => asset.role === "source"), mask = assets.find(asset => asset.role === "mask");
  const state = structuredClone(authored) as CreativeState;
  state.workbenchImage = source ? { width: source.width, height: source.height } : null;
  state.i2iOriginalImage = state.workbenchImage;
  state.inpaintMask = mask?.data ?? null;
  state.generationGroupId = "";
  state.batchCount = 1;
  return state;
}

export async function freezeReviewedGeneration(input: PromptReviewInput) {
  if (input.readiness.status !== "ready" || !input.effective) throw new WorkspaceError("recipe_blocked", "Resolve the complete recipe before enqueueing.");
  const source = input.assets.find(asset => asset.role === "source");
  return freezeGenerationInput(reviewState(input.authored, input.assets), input.mode, async () => ({ mimeType: source!.mimeType, data: source!.data }));
}

/** No account, file, network, queue or randomness access. Also usable by fixture providers. */
export async function buildPromptReview(preparation: PromptReviewPreparation): Promise<PromptReviewInput> {
  if (!preparation || !GENERATION_MODES.includes(preparation.mode)) throw new WorkspaceError("invalid_argument", "Unsupported review mode.");
  const { mode } = preparation;
  const authored = authoredPromptReview(preparation.authored);
  const independent = mode === "inpaint" && authored.inpaintRecipe != null;
  const result: PromptReviewInput = {
    mode, authored, effective: null,
    recipeScope: mode === "inpaint" ? independent ? "independent_inpaint" : "legacy_inpaint" : ["upscale", "director", "enhance"].includes(mode) ? "postprocess" : "base",
    unusedInputs: [], readiness: { status: "ready", issues: [] }, assets: [],
  };
  const issue = (code: string, message: string) => { result.readiness.status = "blocked"; result.readiness.issues.push({ code, message }); };
  const addAsset = async (role: string, data: string, usedForGeneration: boolean): Promise<PromptReviewAsset> => {
    const canonical = imageBase64(data, "review image"), bytes = Buffer.from(canonical, "base64");
    const meta = await sharp(bytes, { limitInputPixels: 64 * 1024 * 1024 }).metadata();
    if (!meta.width || !meta.height || meta.width * meta.height > 64 * 1024 * 1024) throw new WorkspaceError("invalid_image", "Review image dimensions are invalid.");
    const asset = { role, mimeType: imageMime(canonical), data: canonical, width: meta.width, height: meta.height, sha256: createHash("sha256").update(bytes).digest("hex"), usedForGeneration };
    result.assets.push(asset); return asset;
  };
  const roles = new Set<string>();
  for (const asset of preparation.assets ?? []) {
    if (!asset || typeof asset.role !== "string" || !/^(?:source|mask|(?:vibeImages|preciseReferences):\d+)$/.test(asset.role) || roles.has(asset.role)) throw new WorkspaceError("invalid_argument", "Invalid or duplicate review image role.");
    roles.add(asset.role);
    await addAsset(asset.role, asset.data, (asset.role === "source" && mode !== "t2i") || (asset.role === "mask" && mode === "inpaint"));
  }
  const source = result.assets.find(asset => asset.role === "source"), mask = result.assets.find(asset => asset.role === "mask");
  const state = reviewState(authored, result.assets);
  if (isSeededGeneration(mode) && (state.vibeImages.length || state.preciseReferences.length)) {
    issue("unsupported_reference", "Queue generation does not encode Precise/Vibe references. Their authored settings and images are retained for review only.");
    state.vibeImages = []; state.preciseReferences = [];
  }
  if (mode === "inpaint" && !independent && state.charCaptions.length) {
    issue("unsupported_configuration", "Legacy inpaint cannot transmit character captions. They are retained in authored context only.");
    state.charCaptions = [];
  }
  if (mode === "inpaint" && state.modelMode === "furry") issue("unsupported_configuration", "Queue inpaint does not transmit Furry mode.");
  const unused = new Set<string>(["batchCount", "batchIntervalSeconds"]);
  for (const key of ["inpaintRecipe", "inpaintModel", "inpaintStrength", "inpaintNoise", "inpaintPositivePrompt", "inpaintSourceMode"]) if (mode !== "inpaint") unused.add(key);
  for (const key of ["i2iParams", "i2iSourceMode", "i2iSizeMode"]) if (mode !== "i2i" && mode !== "enhance") unused.add(key);
  if (mode !== "enhance") { unused.add("enhanceMagnitude"); unused.add("enhanceScale"); }
  if (mode !== "upscale") unused.add("upscaleScale");
  if (mode !== "director") { unused.add("directorTool"); unused.add("augmentOptions"); }
  if (mode === "t2i") unused.add("source");
  if (mode !== "inpaint") unused.add("mask");
  if (mode === "inpaint") { unused.add("inpaintNoise"); unused.add("modelMode"); unused.add("charCaptions"); if (independent) { unused.add("params"); unused.add("inpaintPositivePrompt"); } else unused.add("params.positivePrompt"); }
  unused.add("vibeImages"); unused.add("preciseReferences");
  result.unusedInputs = [...unused].sort();
  if (mode !== "t2i" && !source) { issue("missing_source", "This mode requires a source image; no effective request can be constructed."); return result; }
  if (mode === "inpaint" && !mask) { issue("missing_mask", "Inpaint requires a mask; no effective request can be constructed."); return result; }
  if (mode === "inpaint" && (source!.width !== mask!.width || source!.height !== mask!.height)) { issue("invalid_mask", "Mask dimensions differ from the source image."); return result; }
  if (mode === "inpaint" && (!NAI_INPAINT_MODELS.some(item => item.value === state.inpaintModel) || !Number.isFinite(state.inpaintStrength) || state.inpaintStrength < 0 || state.inpaintStrength > 1)) { issue("invalid_configuration", "Invalid inpaint model or strength."); return result; }
  if (mode === "i2i" && (!Number.isFinite(state.i2iParams.strength) || state.i2iParams.strength < 0 || state.i2iParams.strength > 1)) { issue("invalid_configuration", "Invalid image-to-image strength."); return result; }
  try {
    // Electron nativeImage decodes PNG and JPEG only: the image builders get a PNG derivative of a WebP source. The
    // source asset above (bytes, sha256, inputHash) stays the original; only the request source is the derivative.
    const decodableSource = async () => {
      try { return await nativeImageInput(Buffer.from(source!.data, "base64")); }
      catch (error) { throw new WorkspaceError("source_conversion_failed", error instanceof ImageConversionError ? `${error.message} No effective request was constructed.` : "The source could not be prepared for the image builder; no effective request was constructed."); }
    };
    const snapshot = await freezeGenerationInput(state, mode, async () => ({ mimeType: source!.mimeType, data: source!.data }));
    for (const key of snapshot.unusedInputs ?? []) unused.add(key);
    if (mode === 't2i') {
      result.effective = buildT2iReviewEffective(snapshot);
      result.unusedInputs = [...unused].sort();
      return result;
    }
    const params = snapshot.params;
    const randomSeed = params.seedMode === "random" || params.seed < 0;
    // A deterministic placeholder is removed below. Review never draws a seed.
    const seed = randomSeed ? 1 : params.seed;
    let request: Record<string, any>, sourceRole: string | null = null, maskRole: string | null = null;
    if (mode === "upscale" || mode === "director") {
      const prepared = prepareLimitedImage(await decodableSource(), mode === "upscale" ? MAX_NAI_UPSCALE_INPUT_PIXELS : MAX_NAI_DIRECTOR_INPUT_PIXELS, mode === "director" ? { flattenAlpha: true, forcePng: true } : {});
      sourceRole = "request-source"; await addAsset(sourceRole, prepared.base64, true);
      request = mode === "upscale" ? buildUpscalePayload(Buffer.from(prepared.base64, "base64"), params.model) : buildDirectorPayload(prepared, snapshot.director!.tool, snapshot.director!.options);
      request.image = { assetRole: sourceRole };
    } else if (mode === "inpaint") {
      const prepared = prepareInpaintAssets(await decodableSource(), mask!.data);
      request = buildPayload({ ...params, model: snapshot.inpaint!.model, width: prepared.width, height: prepared.height }, seed);
      request.action = "infill";
      applyOfficialInpaintParameters(request.parameters, prepared, snapshot.inpaint!.strength, 0, seed);
      sourceRole = "request-source"; maskRole = "request-mask";
      await addAsset(sourceRole, prepared.imageBase64, true); await addAsset(maskRole, prepared.maskBase64, true);
      const alpha = new PNG({ width: prepared.width, height: prepared.height });
      for (let index = 0; index < prepared.blendAlpha.length; index++) { alpha.data.fill(prepared.blendAlpha[index], index * 4, index * 4 + 3); alpha.data[index * 4 + 3] = 255; }
      await addAsset("blend-alpha", PNG.sync.write(alpha).toString("base64"), true);
      request.parameters.image = { assetRole: sourceRole }; request.parameters.mask = { assetRole: maskRole };
      if (randomSeed) request.parameters.extra_noise_seed = null;
    } else {
      request = buildPayload(params, seed, snapshot.extras);
      if (mode === "i2i" || mode === "enhance") {
        const prepared = resizeImageBufferToPng(await decodableSource(), params.width, params.height);
        sourceRole = "request-source"; await addAsset(sourceRole, prepared.toString("base64"), true);
        applyI2IParameters(request as ReturnType<typeof buildPayload>, prepared.toString("base64"), snapshot.i2i!, snapshot.i2i!.extraNoiseSeed > 0 ? snapshot.i2i!.extraNoiseSeed : 1);
        request.parameters.image = { assetRole: sourceRole };
        if (!(snapshot.i2i!.extraNoiseSeed > 0)) request.parameters.extra_noise_seed = null;
        unused.add("i2iParams.noise");
      }
    }
    if (isSeededGeneration(mode) && randomSeed) request.parameters.seed = null;
    result.effective = { request, sourceRole, maskRole, sampling: {
      sampleCount: 1,
      seedPolicy: isSeededGeneration(mode) ? randomSeed ? "random_on_submit" : "fixed" : "unused",
      ...(["i2i", "enhance"].includes(mode) ? { extraNoiseSeedPolicy: snapshot.i2i!.extraNoiseSeed > 0 ? "fixed" : "random_on_submit" } : {}),
      ...(snapshot.processing ? { processing: snapshot.processing } : {}),
    } };
    result.unusedInputs = [...unused].sort();
  } catch (error) {
    issue(error instanceof WorkspaceError ? error.code : "preparation_failed", error instanceof WorkspaceError ? error.message : "Image/request preparation failed; no effective request was constructed.");
  }
  return result;
}
