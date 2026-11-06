/**
 * NovelAI Diffusion V5 Full "Effort" (announced 2026-10-08: https://docs.novelai.net/en/image/effort/).
 *
 * Facts read from the official web client, https://novelai.net/image, build b94bdee-production, fetched 2026-11-06
 * (chunk names are content hashes of that build):
 * - `_next/static/chunks/1qr-_uukhj8ho.js`: the model ids `nai-diffusion-5-full-medium` and
 *   `nai-diffusion-5-full-medium-inpainting`; their capabilities are V5 Full's with `cfgRescale: false` and
 *   `fixedSettings: {steps: 14, sampler: "k_euler_ancestral", ucPresetId: "heavy"}`; the inpainting model of
 *   `nai-diffusion-5-full-medium` is `nai-diffusion-5-full-medium-inpainting`; the UC builder prefixes `nsfw, ` to the
 *   preset text of a non-curated model unless the (quality-tagged) positive prompt contains "nsfw" (case-insensitive);
 *   PNG `Source` "NovelAI Diffusion V5 93F4BD30" / "… 70AB5786" is the Medium model.
 * - `_next/static/chunks/0vm-a10r598mm.js`: for a model with fixedSettings every request (generate, img2img, infill,
 *   enhance) takes those steps and sampler, `uc` = the Heavy preset text built against an EMPTY negative prompt (the
 *   nsfw rule applies), every character's `uc` = "" and `tag_hint_uc_preset` = 2 (the official id of "heavy"). The UI
 *   also hides steps, sampler and CFG rescale, and forces the undesired-content field empty. Inpaint with strength
 *   < 1 adds `img2img: {strength, color_correct: true}` exactly as on High (`img2imgInpainting` is inherited).
 * - `_next/static/chunks/274ff5q_u23hy.js`: the price of a Medium image is
 *   `(2951823174884865e-21·px + 5753298233447344e-22·px·23) / 1.75` (no step term: always priced as 23 steps, ~42 %
 *   below High at 23 steps), × 1.5 for V5, then ceil, at least 2.
 *
 * In this app the effort is a generation parameter (`params.effort`, absent = high) and the model stays
 * `nai-diffusion-5-full`: the request builder sends the Medium model id when the execution model (the t2i/i2i model,
 * or the inpainting model) is V5 Full and the effort is medium. Everything the Medium model fixes is applied here, in
 * one place, so requests, reviews, recipes and history records agree.
 */
import type { GenerateParams } from "./types";

export type NAIEffort = "high" | "medium";
export const NAI_EFFORT_VALUES: readonly NAIEffort[] = ["high", "medium"];

export const NAI_EFFORT_MODEL = "nai-diffusion-5-full";
export const NAI_EFFORT_INPAINT_MODEL = "nai-diffusion-5-full-inpainting";
export const NAI_MEDIUM_MODEL = "nai-diffusion-5-full-medium";
export const NAI_MEDIUM_INPAINT_MODEL = "nai-diffusion-5-full-medium-inpainting";

/** What the Medium model fixes. ucPreset 0 is this app's Heavy (the official "heavy"); CFG rescale is not supported. */
export const NAI_MEDIUM_FIXED = Object.freeze({ steps: 14, sampler: "k_euler_ancestral", cfgRescale: 0, ucPreset: 0 } as const);
/** The official `tag_hint_uc_preset` id of "heavy", which every Medium request carries. */
export const NAI_MEDIUM_UC_PRESET_HINT = 2;

/** Whether this execution model (a t2i/i2i model or an inpainting model) has the Effort toggle. */
export function supportsNAIEffort(executionModel: string): boolean {
  return executionModel === NAI_EFFORT_MODEL || executionModel === NAI_EFFORT_INPAINT_MODEL;
}

/** Whether a request/history model id is one of the Medium checkpoints. */
export function isNAIMediumModel(model: string): boolean {
  return model === NAI_MEDIUM_MODEL || model === NAI_MEDIUM_INPAINT_MODEL;
}

/** The effort that actually runs: medium only when asked for and the execution model has it. */
export function naiEffortOf(params: Pick<GenerateParams, "effort"> | undefined, executionModel: string): NAIEffort {
  return params?.effort === "medium" && supportsNAIEffort(executionModel) ? "medium" : "high";
}

/** The model id sent to NovelAI for this execution model and effort. */
export function naiRequestModel(executionModel: string, effort: NAIEffort): string {
  if (effort !== "medium") return executionModel;
  if (executionModel === NAI_EFFORT_MODEL) return NAI_MEDIUM_MODEL;
  if (executionModel === NAI_EFFORT_INPAINT_MODEL) return NAI_MEDIUM_INPAINT_MODEL;
  return executionModel;
}

export interface NAIEffortReplacement {
  field: "steps" | "sampler" | "cfgRescale" | "ucPreset" | "negativePrompt";
  from: unknown;
  to: unknown;
}

/**
 * The parameters that actually run on this execution model. Medium: steps, sampler, CFG rescale, the UC preset and
 * the negative prompt take the Medium values (`replaced` lists every value that changed), and `effort: "medium"` is
 * kept. High (also a medium request on a model without Medium): no `effort` key at all, so a High recipe is
 * byte-for-byte what it was before the toggle existed.
 */
export function applyNAIEffort<T extends GenerateParams>(params: T, executionModel: string): { params: T; effort: NAIEffort; replaced: NAIEffortReplacement[] } {
  const effort = naiEffortOf(params, executionModel);
  if (effort === "high") {
    if (!Object.hasOwn(params, "effort")) return { params, effort, replaced: [] };
    const { effort: _ignored, ...rest } = params;
    return { params: rest as T, effort, replaced: [] };
  }
  const target = { ...NAI_MEDIUM_FIXED, negativePrompt: "" };
  const replaced: NAIEffortReplacement[] = [];
  for (const field of ["steps", "sampler", "cfgRescale", "ucPreset", "negativePrompt"] as const) {
    if (params[field] !== target[field]) replaced.push({ field, from: params[field], to: target[field] });
  }
  return { params: { ...params, ...target, effort: "medium" }, effort, replaced };
}

/**
 * The undesired content of a Medium request: the Heavy preset text, prefixed with `nsfw, ` unless the positive
 * prompt (as sent, with its quality tags) contains "nsfw" — the official builder's rule for every non-curated model.
 */
export function naiMediumUndesiredContent(positivePrompt: string, heavyText: string): string {
  return positivePrompt.toLowerCase().includes("nsfw") ? heavyText : heavyText ? `nsfw, ${heavyText}` : "nsfw";
}
