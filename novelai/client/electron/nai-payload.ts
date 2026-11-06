/** The actual client payload assembler. Pure: no settings, accounts, files, network or random seed draws. */
import crypto from "node:crypto";
import { assertPromptAssemblyVersion, isNAIV4PlusModel, isNAIV5Model, maxNAICharacterPrompts, MAX_NAI_SEED,
  normalizeGenerateParams, NAI_INPAINT_MODELS, supportsNAIPreciseReference, supportsNAIVibeTransfer, supportsNAIVariety,
  type GenerateParams, type GenerateExtras } from "../src/types";
import { applyNAIEffort, naiMediumUndesiredContent, naiRequestModel, NAI_MEDIUM_UC_PRESET_HINT } from "../src/nai-effort";

function isV4Plus(model: string) { return isNAIV4PlusModel(model); }
function usesModernStructuredPrompt(model: string) { return isNAIV4PlusModel(model); }
function normalizeModel(model: string) { return model.endsWith("-inpainting") ? model.slice(0, -"-inpainting".length) : model; }
function clamp01(value: number, fallback = 0) { return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback; }
function round2(value: number) { return Math.round(value * 100) / 100; }
function stripBase64Prefix(value: string) {
  const idx = value.indexOf(",");
  return idx >= 0 ? value.slice(idx + 1) : value;
}

function qualityTags(
  model: string,
  preset: GenerateParams["qualityPreset"] = "standard",
  positivePrompt = "",
) {
  if (preset === "none") return "";
  let tags = "";
  if (preset === "light" && isNAIV5Model(model)) {
    tags = "very aesthetic, amazing quality, no text";
  } else {
    tags = switchQualityTags(model);
  }

  // NovelAI's official quality presets contain `no text`. Keeping it beside
  // V5's explicit `Text:` directive makes the request contradict itself and
  // measurably suppresses requested lettering.
  if (/(?:^|[\s,;|])Text\s*:\s*\S/i.test(positivePrompt)) {
    tags = tags
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => !/^no text$/i.test(tag))
      .join(", ");
  }
  return tags;
}

function switchQualityTags(model: string) {
  switch (normalizeModel(model)) {
    case "nai-diffusion-5-full":
    case "nai-diffusion-5-curated":
      return "very aesthetic, masterpiece, no text";
    case "nai-diffusion-4-5-full":
      return "very aesthetic, masterpiece, no text";
    case "nai-diffusion-4-5-curated":
      return "very aesthetic, masterpiece, no text, -0.8::feet::, rating:general";
    case "nai-diffusion-4-full":
      return "no text, best quality, very aesthetic, absurdres";
    case "nai-diffusion-4-curated":
      return "rating:general, best quality, very aesthetic, absurdres";
    case "nai-diffusion-3":
      return "best quality, amazing quality, very aesthetic, absurdres";
    default:
      return "";
  }
}

function ucPresetText(model: string, preset: number) {
  if (preset === 3) return "";
  const key = normalizeModel(model);
  // Official V5 Full and Curated UC tables, checked 2026-09-11:
  // https://docs.novelai.net/en/image/undesiredcontent/
  // Keep the existing 0/1/2/3 choices; V5 no longer aliases V4.5 presets.
  if (key === "nai-diffusion-5-full" || key === "nai-diffusion-5-curated") {
    const heavy = "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page";
    if (preset === 2) return `${heavy}, @_@, mismatched pupils, glowing eyes, bad anatomy`;
    return preset === 0
      ? heavy
      : "lowres, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, very displeasing, jpeg artifacts, 0::ai-generated::";
  }
  if (preset === 2) {
    if (key === "nai-diffusion-4-5-full") {
      return "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, @_@, mismatched pupils, glowing eyes, bad anatomy";
    }
    if (key === "nai-diffusion-4-5-curated") {
      return "blurry, lowres, upscaled, artistic error, film grain, scan artifacts, bad anatomy, bad hands, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, @_@, mismatched pupils, glowing eyes, negative space, blank page";
    }
    if (key === "nai-diffusion-3") {
      return "lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract], bad anatomy, bad hands, @_@, mismatched pupils, heart-shaped pupils, glowing eyes";
    }
    return "";
  }
  if (key === "nai-diffusion-4-5-full") {
    return preset === 0
      ? "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page"
      : "lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page";
  }
  if (key === "nai-diffusion-4-5-curated") {
    return preset === 0
      ? "blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page"
      : "blurry, lowres, upscaled, artistic error, scan artifacts, jpeg artifacts, logo, too many watermarks, negative space, blank page";
  }
  if (key === "nai-diffusion-4-full") {
    return preset === 0
      ? "blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks"
      : "blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing";
  }
  if (key === "nai-diffusion-4-curated") {
    return preset === 0
      ? "blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, logo, dated, signature, multiple views, gigantic breasts"
      : "blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, logo, dated, signature";
  }
  if (key === "nai-diffusion-3") {
    return preset === 0
      ? "lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract]"
      : "lowres, jpeg artifacts, worst quality, watermark, blurry, very displeasing";
  }
  return "";
}

export function literalPromptSegments(...segments: string[]) {
  return segments.filter((segment) => segment !== "").join(", ");
}

/** Historical assembler retained only for records without an explicit version. */
function mergePrompt(...segments: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const segment of segments) {
    for (const part of segment
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)) {
      const key = part.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        result.push(part);
      }
    }
  }
  return result.join(", ");
}

function promptSegmentAssembler(params: Pick<GenerateParams, "preservePromptText" | "promptAssemblyVersion">) {
  return params.preservePromptText || params.promptAssemblyVersion === 1
    ? literalPromptSegments
    : mergePrompt;
}

export type CharCaptionMode = "structured" | "pipe";

function finiteClamped(value: number, fallback: number) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

export function normalizedCharCaptions(extras: GenerateExtras | undefined, model: string, preserveText = false, literalText = preserveText) {
  return (extras?.charCaptions ?? [])
    .map((c) => ({
      prompt: literalText ? c.prompt : c.prompt.trim(),
      negativePrompt: literalText ? c.negativePrompt ?? "" : c.negativePrompt?.trim() ?? "",
      useCoords: Boolean(c.useCoords),
      x: finiteClamped(Number(c.x), 0.5),
      y: finiteClamped(Number(c.y), 0.5),
    }))
    .filter((c) => c.prompt.length > 0)
    .slice(0, maxNAICharacterPrompts(model));
}

function hasCharCaptions(extras: GenerateExtras | undefined, model: string, literalText = false) {
  return normalizedCharCaptions(extras, model, false, literalText).length > 0;
}

export function shouldRetryCharCaptionsAsPipe(
  error: any,
  params: GenerateParams,
  extras?: GenerateExtras,
) {
  const status = error?.response?.status;
  return (
    !params.preservePromptText &&
    isV4Plus(params.model) &&
    hasCharCaptions(extras, params.model, params.promptAssemblyVersion === 1) &&
    (status === 400 || status === 422)
  );
}

function withPipeCharCaptions(
  basePrompt: string,
  captions: ReturnType<typeof normalizedCharCaptions>,
) {
  if (captions.length === 0) return basePrompt;
  return [basePrompt, ...captions.map((c) => c.prompt)]
    .filter(Boolean)
    .join(" | ");
}

export type PayloadParams = Omit<GenerateParams, "model"> & { model: string };

export function buildPayload(
  params: PayloadParams,
  actualSeed: number,
  extras?: GenerateExtras,
  charCaptionMode: CharCaptionMode = "structured",
) {
  assertPromptAssemblyVersion(params);
  // Persisted/imported JSON is untrusted at the process boundary. Keep the one
  // intentional inpaint model override while normalizing every other field.
  const inpaintModel = NAI_INPAINT_MODELS.some((item) => item.value === params.model)
    ? params.model
    : null;
  params = {
    ...normalizeGenerateParams(params as GenerateParams),
    ...(inpaintModel ? { model: inpaintModel } : {}),
  } as PayloadParams;
  // V5 Full Effort: Medium fixes steps, sampler, CFG rescale, the UC preset and the negative prompts, and runs the
  // Medium checkpoint (src/nai-effort.ts, from the official client). params.model stays the execution model, so the
  // quality and UC tables below keep reading V5 Full; only the model sent changes.
  const effort = applyNAIEffort(params as GenerateParams, params.model);
  params = effort.params as PayloadParams;
  const medium = effort.effort === "medium";
  const requestModel = naiRequestModel(params.model, effort.effort);
  actualSeed = Math.min(MAX_NAI_SEED, Math.max(0, Math.round(Number.isFinite(Number(actualSeed)) && Number(actualSeed) >= 0 ? Number(actualSeed) : 1)));
  const merge = promptSegmentAssembler(params);
  const replay = params.metadataReplay?.model === params.model ? params.metadataReplay : undefined;
  const basePrompt = merge(params.stylePrompt, params.positivePrompt);
  // In the official client, Furry is a mode for every V4+ checkpoint rather
  // than a separate V4/V5 model. It is represented by placing `fur dataset,`
  // at the very start of the prompt. Keep the dedicated Furry V3 unchanged.
  const modePrompt =
    extras?.modelMode === "furry" && isV4Plus(params.model) &&
    !/(?:^|,\s*)fur dataset(?:\s*,|$)/i.test(basePrompt)
      ? merge("fur dataset", basePrompt)
      : basePrompt;
  const qualityPreset = params.qualityPreset ?? (params.qualityToggle ? "standard" : "none");
  const transparentBackground = isNAIV5Model(params.model) && params.transparentBackground;
  const qualityPrompt = merge(
    modePrompt,
    qualityTags(params.model, qualityPreset, modePrompt),
  );
  const effectivePrompt = transparentBackground
    ? merge(qualityPrompt, "transparent background")
    : qualityPrompt;
  // Medium: the Heavy text alone (its negative prompt is empty), with the official `nsfw, ` rule.
  const effectiveNegative = medium
    ? naiMediumUndesiredContent(effectivePrompt, ucPresetText(params.model, params.ucPreset))
    : merge(
      params.negativePrompt,
      ucPresetText(params.model, params.ucPreset),
    );
  const v4Plus = isV4Plus(params.model);
  const cleanedCharCaptions = normalizedCharCaptions(extras, params.model, params.preservePromptText, params.preservePromptText || params.promptAssemblyVersion === 1)
    // Medium takes no per-character undesired content either (the official builder sends every character's uc as "").
    .map((caption) => medium ? { ...caption, negativePrompt: "" } : caption);
  const inputPrompt =
    charCaptionMode === "pipe"
      ? withPipeCharCaptions(effectivePrompt, cleanedCharCaptions)
      : effectivePrompt;

  // Defensive clamp: NovelAI rejects CFG above its supported range. Dimensions
  // are snapped in the UI (img2img/inpaint override them with image-matched
  // sizes, so we must not re-snap here).
  const safeScale = Math.min(10, Math.max(0, Number(params.cfgScale) || 0));

  const v5 = isNAIV5Model(params.model);
  // The official V5 frontend does not expose a noise-schedule control and
  // normalizes every V5 request to Karras.  Do not derive it from the sampler:
  // doing so made DPM++ requests silently use Exponential and diverge from the
  // website even when every visible parameter matched.
  const effectiveNoiseSchedule = v5
    ? "karras"
    : params.noiseSchedule || "native";
  const parameters: Record<string, unknown> = {
    params_version: 4,
    width: params.width,
    height: params.height,
    scale: safeScale,
    sampler: params.sampler,
    steps: params.steps,
    n_samples: 1,
    seed: actualSeed,
    noise_schedule: effectiveNoiseSchedule,
    uc: effectiveNegative,
    negative_prompt: effectiveNegative,
    ucPreset: params.ucPreset,
    uc_preset: params.ucPreset,
    cfg_rescale: params.cfgRescale,
    legacy: false,
    legacy_v3_extend: false,
    dynamic_thresholding: v5 ? false : params.cfgRescale > 0,
    skip_cfg_above_sigma: null,
    qualityPresetId: qualityPreset,
    qualityToggle: qualityPreset !== "none",
    quality_toggle: qualityPreset !== "none",
    tag_hint_qt: qualityPreset === "standard" ? 1 : qualityPreset === "light" ? 3 : 0,
  };

  if (v5) {
    parameters.tag_hint_transparent_background = transparentBackground;
    parameters.straight_alpha = transparentBackground;
  }
  // Every official Medium request names its fixed Heavy preset (even where High leaves the hint out).
  if (medium) parameters.tag_hint_uc_preset = NAI_MEDIUM_UC_PRESET_HINT;

  // "Variety+" is implemented by skipping CFG above a sigma threshold — NovelAI
  // has no boolean `variety` field, so the previous `variety: true` was a no-op.
  if (params.variety && supportsNAIVariety(params.model)) {
    parameters.skip_cfg_above_sigma = 58;
  }

  if (
    params.sampler === "k_euler_ancestral" &&
    effectiveNoiseSchedule !== "native"
  ) {
    parameters.deliberate_euler_ancestral_bug = false;
    parameters.prefer_brownian = true;
  }

  if (v4Plus) {
    const charCaptionsPayload = cleanedCharCaptions.map((c) => ({
      char_caption: c.prompt,
      // NovelAI still requires one center for AI-choice placement. An empty
      // centers array causes the V4/V4.5 endpoint to return HTTP 500 even when
      // use_coords is false. (0.5, 0.5) is the protocol's AI-choice sentinel.
      centers: [{ x: c.useCoords ? c.x : 0.5, y: c.useCoords ? c.y : 0.5 }],
    }));
    const negativeCharCaptionsPayload = (replay?.keepEmptyNegativeCharacters || cleanedCharCaptions.some((c) => c.negativePrompt))
      ? cleanedCharCaptions.map((c) => ({
          char_caption: c.negativePrompt,
          centers: [{ x: c.useCoords ? c.x : 0.5, y: c.useCoords ? c.y : 0.5 }],
        }))
      : [];
    const useStructuredChars = charCaptionMode === "structured";
    const useCoords =
      useStructuredChars && cleanedCharCaptions.some((c) => c.useCoords);

    parameters.use_coords = useCoords;
    parameters.v4_prompt = {
      caption: {
        base_caption:
          charCaptionMode === "pipe" ? inputPrompt : effectivePrompt,
        char_captions: useStructuredChars ? charCaptionsPayload : [],
      },
      use_coords: useCoords,
      use_order: true,
      ...replay?.positive,
    };
    parameters.v4_negative_prompt = {
      caption: {
        base_caption: effectiveNegative,
        char_captions: useStructuredChars ? negativeCharCaptionsPayload : [],
      },
      use_coords: useCoords && negativeCharCaptionsPayload.length > 0,
      use_order: false,
      legacy_uc: !usesModernStructuredPrompt(params.model),
      ...replay?.negative,
    };
  } else {
    parameters.sm = params.smea;
    parameters.sm_dyn = params.smea && params.smeaDyn;
  }

  if (replay) Object.assign(parameters, replay.parameters);

  // Vibe Transfer (reference_image_multiple) — legacy reference conditioning.
  if (supportsNAIVibeTransfer(params.model) && extras?.vibeImages && extras.vibeImages.length > 0) {
    parameters.reference_image_multiple = extras.vibeImages.map(
      (v) => v.base64,
    );
    parameters.reference_information_extracted_multiple = extras.vibeImages.map(
      (v) => v.infoExtracted,
    );
    parameters.reference_strength_multiple = extras.vibeImages.map(
      (v) => v.strength,
    );
  }

  // Precise / Director Reference — V4.5 only. Distinct from Vibe Transfer: uses
  // the director_reference_* fields with a type (character/style/character&style),
  // strength, and secondary strength derived from fidelity (1 - fidelity).
  const preciseRefs = extras?.preciseReferences ?? [];
  if (v4Plus && supportsNAIPreciseReference(params.model) && preciseRefs.length > 0) {
    // Confirmed against the official client's real request (F12 HAR): V4.5 precise
    // references are uploaded as multipart BINARY parts named director_ref_N (done
    // in postGenerateImage); the JSON references them via
    // director_reference_images_cached = [{cache_secret_key: sha256(bytes), data}],
    // and base_caption carries the TYPE. Our old director_reference_images:[base64]
    // in a JSON POST is silently ignored by the API — which is exactly why precise
    // reference had no effect regardless of base_caption. We keep the (preprocessed)
    // base64 here only as the byte source for the multipart parts.
    parameters.director_reference_images = preciseRefs.map((r) =>
      stripBase64Prefix(r.base64),
    );
    parameters.director_reference_images_cached = preciseRefs.map(
      (r, index) => ({
        cache_secret_key: crypto
          .createHash("sha256")
          .update(Buffer.from(stripBase64Prefix(r.base64), "base64"))
          .digest("hex"),
        data: `director_ref_${index}`,
      }),
    );
    parameters.normalize_reference_strength_multiple = true;
    parameters.director_reference_descriptions = preciseRefs.map((r) => ({
      caption: { base_caption: r.type || "character&style", char_captions: [] },
      legacy_uc: false,
    }));
    parameters.director_reference_strength_values = preciseRefs.map((r) =>
      round2(clamp01(r.strength, 1)),
    );
    parameters.director_reference_secondary_strength_values = preciseRefs.map(
      (r) => round2(clamp01(1 - r.fidelity, 0)),
    );
    // NovelAI's Precise Reference UI exposes only Strength and Fidelity.
    // Keep this compatibility transport field fixed instead of presenting a
    // third user-facing control or replaying stale values from older presets.
    parameters.director_reference_information_extracted = preciseRefs.map(() => 1);

  }

  return {
    input: inputPrompt,
    model: requestModel,
    action: "generate",
    parameters,
  };
}

