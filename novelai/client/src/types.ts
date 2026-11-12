import type { GenerateParams as ContractGenerateParams, HistoryPayload as ContractHistoryItem, GenerationOrigin as ContractGenerationOrigin, StylePresetPayload as ContractStylePromptPreset, PositivePresetPayload as ContractPositivePromptPreset, PromptChunkPayload as ContractPromptChunk, ReferencePresetPayload as ContractReferencePreset, PreviewImage as ContractStylePromptPreviewImage } from "./generated/library-contracts.mjs" with { "resolution-mode": "import" };
import { normalizeMetadataReplay, type MetadataReplay } from "./metadata-replay";
import { version as packageVersion } from "../package.json";
import { fitNAIImageSize } from "./nai-dimensions";

// package.json is the single desktop release-version source. Keeping this
// derived keeps the title bar and About page on the version the installer
// carries, and it is the version the new-version check compares with.
export const APP_VERSION = packageVersion;
export const APP_NAME = "MCP for NovelAI";
/** The User-Agent product token of the public requests this app makes (Danbooru tag search and covers, the GitHub new-version check). */
export const USER_AGENT = `MCP-for-NovelAI/${APP_VERSION}`;
/** Prefix of every app-owned localStorage key; backups carry exactly these keys (data/workspace.json). */
export const APP_STORAGE_PREFIX = "mcp-for-novelai.";
/** This project's home: source code, releases (the new-version notice links there) and issues. */
export const PROJECT_HOMEPAGE_URL = "https://github.com/lwyq1209/mcp-for-novelai";
/** MIT-licensed upstream this client is derived from (credited on the About page). */
export const UPSTREAM_REPOSITORY_URL =
  "https://github.com/2786886095/novelai-image-desktop";

export type ModelMode = "anime" | "furry";

export const NAI_MODELS = [
  {
    label: "NAI Diffusion V5 Full（最新完整模型）",
    value: "nai-diffusion-5-full",
    mode: "anime",
  },
  {
    label: "NAI Diffusion V5 Curated（最新精选模型）",
    value: "nai-diffusion-5-curated",
    mode: "anime",
  },
  {
    label: "NAI Diffusion 4.5 Full（完整模型）",
    value: "nai-diffusion-4-5-full",
    mode: "anime",
  },
  {
    label: "NAI Diffusion 4.5 Curated（精选模型）",
    value: "nai-diffusion-4-5-curated",
    mode: "anime",
  },
  {
    label: "NAI Diffusion 4 Full（完整模型）",
    value: "nai-diffusion-4-full",
    mode: "anime",
  },
  {
    label: "NAI Diffusion 4 Curated（精选模型）",
    value: "nai-diffusion-4-curated",
    mode: "anime",
  },
  {
    label: "NAI Diffusion 3（旧版通用）",
    value: "nai-diffusion-3",
    mode: "anime",
  },
  {
    label: "NAI Diffusion Furry 3（兽人模型）",
    value: "nai-diffusion-furry-3",
    mode: "furry",
  },
] as const;

export type NAIModel = (typeof NAI_MODELS)[number]["value"];

/** Model capability helpers mirrored from NovelAI's current Image frontend. */
export function isNAIV5Model(model: string): boolean {
  return normalizeNAIBaseModel(model).startsWith("nai-diffusion-5-");
}

export function isNAIV4PlusModel(model: string): boolean {
  const normalized = normalizeNAIBaseModel(model);
  return normalized.startsWith("nai-diffusion-4-") || normalized.startsWith("nai-diffusion-5-");
}

/**
 * NovelAI does not publish a separate V4/V4.5/V5 Furry checkpoint.  The
 * official UI exposes those checkpoints in Furry mode and prefixes the prompt
 * with `fur dataset,`; only Furry V3 remains a dedicated model.
 */
export function supportsNAIModelMode(model: string, mode: ModelMode): boolean {
  const normalized = normalizeNAIBaseModel(model);
  if (mode === "anime") return normalized !== "nai-diffusion-furry-3";
  return normalized === "nai-diffusion-furry-3" || isNAIV4PlusModel(normalized);
}

export function supportsNAIPreciseReference(model: string): boolean {
  const normalized = normalizeNAIBaseModel(model);
  // NovelAI's V5 launch does not include Precise Reference. Keep this
  // capability separate from the V4+/structured-prompt capability so adding a
  // new base model cannot accidentally send Director Reference fields to an
  // unsupported backend again.
  return normalized.startsWith("nai-diffusion-4-5-");
}

export function supportsNAICharacterPrompts(model: string): boolean {
  return isNAIV4PlusModel(model);
}

export function supportsNAIVibeTransfer(model: string): boolean {
  return !isNAIV5Model(model);
}

export function supportsNAINoiseScheduleControl(model: string): boolean {
  return !isNAIV5Model(model);
}

export function supportsNAIVariety(model: string): boolean {
  return !isNAIV5Model(model);
}

/** Enhance Max✨ exists for the V5 models only (official `maxEnhance`: V5 Curated and Full; see nai-dimensions.ts). */
export function supportsNAIMaxEnhance(model: string): boolean {
  return isNAIV5Model(model);
}

export function maxNAICharacterPrompts(model: string): number {
  return isNAIV5Model(model) ? 32 : isNAIV4PlusModel(model) ? 6 : 0;
}

function normalizeNAIBaseModel(model: string): string {
  return model.endsWith("-inpainting")
    ? model.slice(0, -"-inpainting".length)
    : model;
}

/** Default model selected when switching into each mode. */
export const DEFAULT_MODEL_FOR_MODE: Record<ModelMode, NAIModel> = {
  anime: "nai-diffusion-5-full",
  furry: "nai-diffusion-5-full",
};

export const NAI_SAMPLERS = [
  { label: "Euler Ancestral（欧拉祖先，推荐）", value: "k_euler_ancestral" },
  { label: "Euler（欧拉）", value: "k_euler" },
  { label: "DPM++ 2M（稳定采样）", value: "k_dpmpp_2m" },
  { label: "DPM++ 2M SDE（随机微分）", value: "k_dpmpp_2m_sde" },
  { label: "DPM++ SDE（高质量随机微分）", value: "k_dpmpp_sde" },
  { label: "DPM++ 2S Ancestral（祖先采样）", value: "k_dpmpp_2s_ancestral" },
  { label: "DDIM（快速采样）", value: "ddim_v3" },
] as const;

export type NAISampler = (typeof NAI_SAMPLERS)[number]["value"];

export const NAI_UC_PRESETS = [
  { label: "Heavy（强负面）", value: 0 },
  { label: "Light（轻负面）", value: 1 },
  { label: "Human Focus（人物优先）", value: 2 },
  { label: "None（不使用预设）", value: 3 },
] as const;

export type UcPreset = 0 | 1 | 2 | 3;

export type QualityPreset = "standard" | "light" | "none";
export type ImageToImageSizeMode = "adaptive" | "custom";

export type GenerateParams = ContractGenerateParams;

export const DEFAULT_PARAMS: GenerateParams = {
  // New drafts use literal field-boundary assembly. Historical objects without
  // this optional marker remain on the legacy comma-deduplicating path.
  promptAssemblyVersion: 1,
  model: "nai-diffusion-5-full",
  stylePrompt: "",
  positivePrompt: "",
  negativePrompt: "",
  width: 832,
  height: 1216,
  steps: 28,
  cfgScale: 6,
  cfgRescale: 0,
  sampler: "k_euler_ancestral",
  noiseSchedule: "karras",
  seed: 0,
  seedMode: "random",
  ucPreset: 2,
  qualityPreset: "standard",
  qualityToggle: true,
  transparentBackground: false,
  smea: false,
  smeaDyn: false,
  variety: false,
  fileNamePrefix: "",
};

/** NovelAI seeds are unsigned 32-bit values in exported image metadata. */
export const MAX_NAI_SEED = 0xffff_ffff;

/** Preserve the first fixed seed; subsequent images wrap in the full uint32 range. */
export function seedForBatch(seed: number, index: number): number {
  const initial = Math.min(MAX_NAI_SEED, Math.max(0, Number.isFinite(seed) ? Math.round(seed) : 0));
  const offset = Number.isSafeInteger(index) && index > 0 ? index : 0;
  return (initial + offset % (MAX_NAI_SEED + 1)) % (MAX_NAI_SEED + 1);
}

const SUPPORTED_MODEL_VALUES = new Set<string>(NAI_MODELS.map((item) => item.value));
const SUPPORTED_SAMPLER_VALUES = new Set<string>(NAI_SAMPLERS.map((item) => item.value));
const SUPPORTED_NOISE_SCHEDULES = new Set(["native", "karras", "exponential"]);

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export class InvalidPromptAssemblyVersionError extends Error {
  readonly code = "invalid_argument";
  constructor() {
    super("promptAssemblyVersion 仅接受数字 1；省略字段表示历史兼容装配。");
    this.name = "InvalidPromptAssemblyVersionError";
  }
}

/** Reject explicit corrupt input before permissive legacy normalization can drop it. */
export function assertPromptAssemblyVersion(
  source: unknown,
  options: { allowUndefinedClear?: boolean } = {},
): void {
  if (!source || typeof source !== "object" || Array.isArray(source) || !Object.hasOwn(source, "promptAssemblyVersion")) return;
  const value = (source as { promptAssemblyVersion?: unknown }).promptAssemblyVersion;
  if (value === 1 || (value === undefined && options.allowUndefinedClear === true)) return;
  throw new InvalidPromptAssemblyVersionError();
}

/** Repair generation state restored from older releases or imported metadata. */
export function normalizeGenerateParams(value?: Partial<GenerateParams> | null): GenerateParams {
  const source = value ?? {};
  const model = String(source.model ?? DEFAULT_PARAMS.model);
  const normalizedModel = (SUPPORTED_MODEL_VALUES.has(model)
    ? model
    : DEFAULT_PARAMS.model) as NAIModel;
  const sampler = String(source.sampler ?? DEFAULT_PARAMS.sampler);
  const noiseSchedule = String(source.noiseSchedule ?? DEFAULT_PARAMS.noiseSchedule);
  const steps = Math.round(finiteNumber(source.steps, DEFAULT_PARAMS.steps));
  const cfgScale = finiteNumber(source.cfgScale, DEFAULT_PARAMS.cfgScale);
  const cfgRescale = finiteNumber(source.cfgRescale, DEFAULT_PARAMS.cfgRescale);
  const seed = Math.round(finiteNumber(source.seed, DEFAULT_PARAMS.seed));
  const ucPreset = Math.round(finiteNumber(source.ucPreset, DEFAULT_PARAMS.ucPreset));
  const smea = typeof source.smea === "boolean" ? source.smea : DEFAULT_PARAMS.smea;
  const requestedQualityPreset =
    source.qualityPreset === "standard" ||
    source.qualityPreset === "light" ||
    source.qualityPreset === "none"
      ? source.qualityPreset
      : source.qualityToggle === false
        ? "none"
        : DEFAULT_PARAMS.qualityPreset;
  const qualityPreset: QualityPreset =
    !isNAIV5Model(normalizedModel) && requestedQualityPreset === "light"
      ? "standard"
      : requestedQualityPreset;
  const dimensions = fitNAIImageSize(source.width, source.height, DEFAULT_PARAMS);
  return {
    model: normalizedModel,
    ...(source.preservePromptText === true ? { preservePromptText: true } : {}),
    ...(source.promptAssemblyVersion === 1 ? { promptAssemblyVersion: 1 as const } : {}),
    ...(normalizeMetadataReplay(source.metadataReplay) ? { metadataReplay: normalizeMetadataReplay(source.metadataReplay) } : {}),
    stylePrompt: typeof source.stylePrompt === "string" ? source.stylePrompt : "",
    positivePrompt: typeof source.positivePrompt === "string" ? source.positivePrompt : "",
    negativePrompt: typeof source.negativePrompt === "string" ? source.negativePrompt : "",
    width: dimensions.width,
    height: dimensions.height,
    steps: Math.min(50, Math.max(1, steps)),
    cfgScale: Math.min(10, Math.max(0, cfgScale)),
    cfgRescale: Math.min(1, Math.max(0, cfgRescale)),
    sampler: (SUPPORTED_SAMPLER_VALUES.has(sampler) ? sampler : DEFAULT_PARAMS.sampler) as NAISampler,
    noiseSchedule: SUPPORTED_NOISE_SCHEDULES.has(noiseSchedule) ? noiseSchedule : DEFAULT_PARAMS.noiseSchedule,
    seed: Math.min(MAX_NAI_SEED, Math.max(0, seed)),
    seedMode: source.seedMode === "fixed" ? "fixed" : "random",
    ucPreset: Math.min(3, Math.max(0, ucPreset)) as UcPreset,
    qualityPreset,
    qualityToggle: qualityPreset !== "none",
    transparentBackground:
      isNAIV5Model(normalizedModel) && source.transparentBackground === true,
    smea,
    smeaDyn: smea && (typeof source.smeaDyn === "boolean" ? source.smeaDyn : DEFAULT_PARAMS.smeaDyn),
    variety: typeof source.variety === "boolean" ? source.variety : DEFAULT_PARAMS.variety,
    fileNamePrefix: typeof source.fileNamePrefix === "string" ? source.fileNamePrefix : "",
    // Only Medium is stored (absent = high): a High recipe keeps exactly the fields it always had. Whether it runs
    // depends on the execution model (src/nai-effort.ts applyNAIEffort), so it is kept for any model here.
    ...(source.effort === "medium" ? { effort: "medium" as const } : {}),
  };
}

/** Fill ordinary legacy omissions without accidentally upgrading prompt assembly. */
export function normalizeInheritedGenerateParams(
  source: Partial<GenerateParams>,
  fallback: GenerateParams = DEFAULT_PARAMS,
): GenerateParams {
  assertPromptAssemblyVersion(source);
  assertPromptAssemblyVersion(fallback);
  const merged: Partial<GenerateParams> = { ...fallback, ...source };
  if (!Object.hasOwn(source, "promptAssemblyVersion")) delete merged.promptAssemblyVersion;
  return normalizeGenerateParams(merged);
}

export interface LastGenerationState {
  /** Absent in older settings; authored editing state, never model-truncated. */
  charCaptions?: CharCaptionItem[];
  params: GenerateParams;
  batchCount: number;
  batchIntervalSeconds?: number;
  i2iParams: I2IParams;
  inpaintModel: NAIInpaintModel;
  inpaintStrength: number;
  inpaintNoise: number;
  inpaintPositivePrompt: string;
  /** Optional in older settings; null keeps the legacy shared-parameter mode. */
  inpaintRecipe?: GenerateParams | null;
  brushSize: number;
  brushOpacity: number;
  brushColor?: string;
  brushShape?: InpaintBrushShape;
  brushSizeUnit?: "grid8";
  upscaleScale: UpscaleScale;
  directorTool: DirectorTool;
  augmentOptions: AugmentOptions;
}

export type InpaintBrushShape = "round" | "square";

export interface WorkingImage {
  filePath: string;
  fileUrl: string;
  width: number;
  height: number;
}

export interface I2IParams {
  strength: number;
  noise: number;
  extraNoiseSeed: number;
  /**
   * Enhance Max✨ (V5) only, set per request and never stored in the canvas state: the request carries
   * `upscaled_enhance: true`, sends the source at its own size and NovelAI returns it about 2× larger
   * (src/nai-dimensions.ts NAI_MAX_ENHANCE_*).
   */
  upscaledEnhance?: boolean;
}

export const DEFAULT_I2I_PARAMS: I2IParams = {
  strength: 0.7,
  noise: 0,
  extraNoiseSeed: 0,
};

/** Vibe Transfer / Precise Reference — slim type sent over IPC */
export interface VibeTransferItem {
  base64: string; // pure base64 without data-URL prefix
  infoExtracted: number; // 0.0 – 1.0, new Vibe Transfer default 1.0
  strength: number; // 0.0 – 1.0, new Vibe Transfer default 1.0
}

/** Renderer store representation (adds id + preview for display) */
export interface VibeTransferImage extends VibeTransferItem {
  id: string;
  name?: string;
  previewUrl: string; // data URL, never sent to main process
}

/** NovelAI V4.5/V5 Precise (Director) Reference — distinct from Vibe Transfer.
 * Sent over IPC; the main process emits director_reference_* fields. */
export type PreciseReferenceType = "character" | "style" | "character&style";
export interface PreciseReferenceItem {
  base64: string; // pure base64 (resized to an official reference resolution in main)
  type: PreciseReferenceType; // -> director_reference_descriptions[].caption.base_caption
  strength: number; // 0.0 – 1.0 -> director_reference_strength_values
  fidelity: number; // 0.0 – 1.0 -> secondary = round(1 - fidelity, 2)
  /** Legacy persisted compatibility field. NovelAI's Precise Reference UI only
   * exposes Strength and Fidelity; the main process always sends 1.0. */
  informationExtracted?: number;
}

/** Renderer store representation of a precise reference (adds id + preview) */
export interface PreciseReferenceImage extends PreciseReferenceItem {
  id: string;
  name?: string;
  previewUrl: string; // data URL, never sent to main process
  srcWidth?: number; // original pixel size (renderer-only, for the size hint)
  srcHeight?: number;
}

/** Character prompt item — slim type sent over IPC */
export interface CharCaptionItem {
  prompt: string;
  /** Per-character undesired content used by NovelAI V4/V4.5/V5. */
  negativePrompt?: string;
  useCoords: boolean;
  x: number; // 0.0 – 1.0
  y: number; // 0.0 – 1.0
}

/** Renderer store representation (adds id) */
export interface CharCaption extends CharCaptionItem {
  id: string;
}

/** Extras passed alongside GenerateParams to the main process */
export interface GenerateExtras {
  vibeImages: VibeTransferItem[];
  charCaptions: CharCaptionItem[];
  preciseReferences?: PreciseReferenceItem[];
  /** Snapshot of the ordinary generation destination; never sent to NovelAI. */
  historyGroupId?: string;
  /** Queue enqueue output: frozen file-name prefix for every mode (wins over params.fileNamePrefix); never sent to NovelAI. */
  fileNamePrefix?: string;
  /** Official Anime/Furry mode. V4+ Furry mode injects `fur dataset,`. */
  modelMode?: ModelMode;
}

export type GenerateFailureKind =
  "auth" | "reference" | "validation" | "api" | "cancelled";

export const NAI_INPAINT_MODELS = [
  {
    label: "NAI Diffusion V5 Full Inpaint（推荐）",
    value: "nai-diffusion-5-full-inpainting",
  },
  {
    label: "NAI Diffusion V5 Curated Inpaint",
    value: "nai-diffusion-5-curated-inpainting",
  },
  {
    label: "NAI Diffusion 4.5 Full Inpaint（推荐）",
    value: "nai-diffusion-4-5-full-inpainting",
  },
  {
    label: "NAI Diffusion 4.5 Curated Inpaint",
    value: "nai-diffusion-4-5-curated-inpainting",
  },
  { label: "NAI Diffusion 4 Full Inpaint", value: "nai-diffusion-4-full-inpainting" },
  {
    label: "NAI Diffusion 4 Curated Inpaint",
    value: "nai-diffusion-4-curated-inpainting",
  },
  { label: "NAI Diffusion 3 Inpaint", value: "nai-diffusion-3-inpainting" },
] as const;

export type NAIInpaintModel = (typeof NAI_INPAINT_MODELS)[number]["value"];

const INPAINT_BASE_MODELS = {
  "nai-diffusion-5-full-inpainting": "nai-diffusion-5-full",
  "nai-diffusion-5-curated-inpainting": "nai-diffusion-5-curated",
  "nai-diffusion-4-5-full-inpainting": "nai-diffusion-4-5-full",
  "nai-diffusion-4-5-curated-inpainting": "nai-diffusion-4-5-curated",
  "nai-diffusion-4-full-inpainting": "nai-diffusion-4-full",
  "nai-diffusion-4-curated-inpainting": "nai-diffusion-4-curated",
  "nai-diffusion-3-inpainting": "nai-diffusion-3",
} satisfies Record<NAIInpaintModel, NAIModel>;

/** The independent recipe uses the same capabilities as its execution model. */
export function baseModelForInpaint(model: NAIInpaintModel): NAIModel {
  const base = INPAINT_BASE_MODELS[model];
  if (!base) throw new Error("Unknown inpaint model.");
  return base;
}

export type UpscaleScale = 2 | 4;
export const MAX_NAI_UPSCALE_INPUT_PIXELS = 1024 * 1024;
export const MAX_NAI_UPSCALE_OUTPUT_DIMENSION = 4096;
export const MAX_NAI_DIRECTOR_INPUT_PIXELS = 1024 * 1024;

export const DIRECTOR_TOOLS = [
  { label: "移除背景", value: "bg-removal", hasPrompt: false },
  { label: "线稿提取", value: "lineart", hasPrompt: false },
  { label: "草图化", value: "sketch", hasPrompt: false },
  { label: "上色", value: "colorize", hasPrompt: true },
  { label: "表情迁移", value: "emotion", hasPrompt: true },
  { label: "去除杂乱", value: "declutter", hasPrompt: false },
] as const;

export type DirectorTool = (typeof DIRECTOR_TOOLS)[number]["value"];

export const EMOTION_OPTIONS = [
  { label: "中性（Neutral）", value: "neutral" },
  { label: "开心（Happy）", value: "happy" },
  { label: "悲伤（Sad）", value: "sad" },
  { label: "愤怒（Angry）", value: "angry" },
  { label: "惊讶（Surprised）", value: "surprised" },
  { label: "害怕（Scared）", value: "scared" },
  { label: "厌恶（Disgusted）", value: "disgusted" },
  { label: "惊叹（Amazed）", value: "amazed" },
] as const;

export type EmotionValue = (typeof EMOTION_OPTIONS)[number]["value"];

export interface AugmentOptions {
  defry: number;
  colorizePrompt: string;
  emotion: EmotionValue;
  emotionLevel: number;
}

export const DEFAULT_AUGMENT_OPTIONS: AugmentOptions = {
  defry: 0,
  colorizePrompt: "",
  emotion: "happy",
  emotionLevel: 0,
};

export interface TokenStatus {
  valid: boolean;
  /** English; the window shows reason/params in its language (host-errors catalog, step 4c1). */
  message: string;
  reason?: string;
  params?: Record<string, string | number>;
  tierName?: string;
  tierLevel?: number;
  anlasBalance?: number;
  expiresAt?: string;
  hasActiveSubscription?: boolean;
  opusUsage?: OpusGenerationUsage;
  opusUsageUpdatedAt?: number;
}

export interface OpusGenerationUsage {
  /** Remaining V5 allowance percentage returned by NovelAI `/user/data`. */
  percent: number;
  /** Official flag indicating the free allowance has been exhausted. */
  isNegative: boolean;
  /** Seconds required to refill one percentage point. */
  timeUntilNextPercent: number;
}

export interface AccountSummary {
  hasToken: boolean;
  tierName?: string;
  tierLevel?: number;
  anlasBalance?: number;
  expiresAt?: string;
  hasActiveSubscription?: boolean;
  opusUsage?: OpusGenerationUsage;
  opusUsageUpdatedAt?: number;
  // True when this summary is a cached copy returned because a live refresh
  // failed — the balance may be out of date and must be labelled as such.
  stale?: boolean;
}

export type AnlasQuoteFeature =
  "generate" | "i2i" | "inpaint" | "upscale" | "director";
// "official-api" = price returned by NovelAI's /request-price endpoint (authoritative).
// "estimate-formula"/"estimate-fixed" = our local web-frontend formula / fixed rules,
// which are close but NOT guaranteed to match the final charge — must be shown as estimates.
export type AnlasQuoteSource =
  "official-api" | "estimate-formula" | "estimate-fixed" | "unavailable";
export type AnlasQuoteUnavailableReason =
  | "missing-token"
  | "missing-image"
  | "missing-params"
  | "image-too-large";

export interface AnlasQuoteRequest {
  feature: AnlasQuoteFeature;
  params?: GenerateParams;
  extras?: GenerateExtras;
  batchCount?: number;
  i2iParams?: I2IParams;
  inpaintModel?: NAIInpaintModel;
  inpaintStrength?: number;
  inpaintNoise?: number;
  maskBase64?: string | null;
  upscaleScale?: UpscaleScale;
  directorTool?: DirectorTool;
  image?: Pick<WorkingImage, "width" | "height"> | null;
  account?: AccountSummary;
  /** Vibe refs already covered by the active run / earlier queued jobs (encoded once). */
  alreadyQueuedVibes?: number;
}

export interface AnlasQuoteResult {
  ok: boolean;
  amount?: number;
  source?: AnlasQuoteSource;
  reason?: AnlasQuoteUnavailableReason;
  balance?: number;
  insufficient?: boolean;
  message: string;
  details?: string[];
}

/** Explicit task provenance distinguishes seedless postprocessing from legacy seed 0. */
export type GenerationOrigin = ContractGenerationOrigin;

export type HistoryItem = ContractHistoryItem;
/** Incremental history read (2026-11-01): the named items plus the identities of one view, in getHistory order. */
export interface HistoryItemsRequest { ids: string[]; date?: string; groupId?: string; order?: boolean }
export interface HistoryItemsSnapshot {
  /** Current payloads (fileUrl rebuilt as in getHistory) of the requested items visible in the view. */
  items: HistoryItem[];
  /** Requested items that no longer exist or are archived. */
  removed: string[];
  /** Identities of the whole view in getHistory order, unless the request said `order: false`. */
  order?: string[];
}

export interface HistoryGroup {
  id: string;
  name: string;
  createdAt: string;
}

export interface GenerateResult {
  ok: boolean;
  message: string;
  items: HistoryItem[];
  actualSeed?: number;
  failureKind?: GenerateFailureKind;
  statusCode?: number;
  /** A refusal before any request was sent, by its stable code (the queue's job error code), e.g. history_params_invalid. */
  errorCode?: string;
  /** The window's catalog message id and placeholder values of this failure (step 4a, src/host-errors). */
  reason?: string;
  params?: Record<string, string | number>;
  /** What NovelAI answered, cleaned (electron/upstream-reason.ts; step 4c1): kept on an agent item's error for the window. */
  upstream?: UpstreamReasonFields;
}

/** NovelAI's answer to a failed image, cleaned (electron/upstream-reason.ts): window only, never sent to MCP (step 4c1). */
export interface UpstreamReasonFields { status?: number; message?: string; reason?: string; params?: Record<string, string | number> }

export interface GenerationPreviewEvent {
  requestId: string;
  progress: number;
  currentStep?: number;
  totalSteps?: number;
  sampleIndex: number;
  imageDataUrl: string;
}

export interface SingleImageResult {
  ok: boolean;
  message: string;
  item?: HistoryItem;
}

export interface LoadImageResult {
  ok: boolean;
  image?: WorkingImage;
  metadata?: {
    imported: ImportedParams;
    characterCaptions: CharCaptionItem[];
  };
  message?: string;
  /** The window's catalog reason of a failure (step 4c1), rendered in the interface language. */
  reason?: string;
  params?: Record<string, string | number>;
}

export interface MetadataSnapshotPayload {
  name: string;
  type: string;
  lastModified: number;
  base64: string;
}

export interface MetadataSnapshotResult {
  ok: boolean;
  snapshot?: MetadataSnapshotPayload;
  message?: string;
}

export type DataBackupCategory =
  | "configuration"
  | "apiCredentials"
  | "artistLibrary"
  | "referencePresets"
  | "imageHistory"
  | "promptPresets"
  | "workspaceData";

export interface DataBackupExportRequest {
  categories: DataBackupCategory[];
  /** App-owned localStorage values. The main process cannot read Chromium's
   * storage directly, so the renderer supplies this portable workspace layer. */
  workspaceData?: Record<string, string>;
  destination?: "dialog" | "automatic" | "internal";
  /** Required by the host for an explicit manual credentials export. Ignored
   * for automatic and rescue archives, which never contain credentials. */
  confirmApiCredentialsExport?: boolean;
}

export interface DataBackupCategorySummary {
  category: DataBackupCategory;
  items: number;
  bytes: number;
}

export interface DataBackupIntegrityReason {
  code: string;
  message: string;
  categories: DataBackupCategory[];
}
export interface DataBackupIntegrity {
  scope: "selected-categories";
  complete: boolean;
  degraded: boolean;
  reasons: DataBackupIntegrityReason[];
}

export interface DataBackupInspectResult {
  ok: boolean;
  cancelled?: boolean;
  message?: string;
  path?: string;
  formatVersion?: number;
  createdAt?: string;
  sourcePlatform?: string;
  appVersion?: string;
  categories: DataBackupCategorySummary[];
  requiresConfigurationConfirmation?: boolean;
  complete?: boolean;
  degraded?: boolean;
  integrityReasons?: DataBackupIntegrityReason[];
  warnings?: string[];
}

export interface DataBackupImportRequest {
  path: string;
  categories: DataBackupCategory[];
  /** Must be true whenever configuration or API credentials are selected.
   * The settings screen only sets it after the dedicated second confirmation. */
  confirmConfigurationOverwrite: boolean;
  /** Required when inspection proves that the selected import scope is
   * degraded. It never bypasses malformed structures or hash failures. */
  confirmDegradedImport?: boolean;
  currentWorkspaceData?: Record<string, string>;
}

export interface DataBackupImportResult {
  ok: boolean;
  message: string;
  imported: number;
  skipped: number;
  renamed: number;
  warnings?: string[];
  /** Non-destructive renderer storage additions. Existing conflicting keys are
   * intentionally returned but never silently overwritten by the main process. */
  workspaceData?: Record<string, string>;
  rescueBackupPath?: string;
  complete?: boolean;
  degraded?: boolean;
  integrityReasons?: DataBackupIntegrityReason[];
}

export interface DataBackupOperationResult {
  ok: boolean;
  cancelled?: boolean;
  message: string;
  path?: string;
  categories?: DataBackupCategorySummary[];
  complete?: boolean;
  degraded?: boolean;
  integrityReasons?: DataBackupIntegrityReason[];
  warnings?: string[];
}

export interface DataBackupStatus {
  directory: string;
  automaticEnabled: boolean;
  intervalHours: number;
  retentionCount: number;
  latestPath?: string;
  latestCreatedAt?: string;
  backupCount: number;
  totalBytes: number;
  due: boolean;
}

export interface PromptTemplate {
  id: string;
  name: string;
  prefix: string;
  suffix: string;
  negativePrompt: string;
}

export type StylePromptPreset = ContractStylePromptPreset;

/** A reusable positive-prompt preset. Reference images are visual notes only:
 * applying the preset replaces the positive prompt text and never injects an
 * image into generation, i2i, vibe transfer, or precise reference inputs. */
export type PositivePromptPreset = ContractPositivePromptPreset;

/** A reusable text fragment inserted into the prompt being edited. Unlike a
 * positive prompt preset it never replaces the complete positive prompt and
 * carries no preview images or generation state. */
export type PromptChunk = ContractPromptChunk;

export type ReferencePresetKind = "vibe" | "precise";

/** Durable, named reference image stored under the app's userData directory.
 * The JSON shape intentionally matches the mobile .nairp manifest so archives
 * can move between desktop, Android and iOS without conversion. */
export type ReferencePreset = ContractReferencePreset;

export interface ReferencePresetLibrary {
  groups: string[];
  presets: ReferencePreset[];
}

export interface ReferencePresetSaveRequest {
  name: string;
  group?: string;
  kind: ReferencePresetKind;
  base64: string;
  extension?: string;
  infoExtracted?: number;
  strength?: number;
  preciseType?: PreciseReferenceType;
  fidelity?: number;
  informationExtracted?: number;
  width?: number;
  height?: number;
  sourceId?: string;
  sourceNames?: Partial<Record<ReferencePresetNameLocale, string>>;
  sourceGameNames?: Partial<Record<ReferencePresetNameLocale, string>>;
  sourceGameId?: string;
  sourceCategory?: string;
}

export interface ReferencePresetExportRequest {
  presetId?: string;
  group?: string;
}

export interface ReferencePresetOperationResult {
  ok: boolean;
  message?: string;
  library?: ReferencePresetLibrary;
  preset?: ReferencePreset;
  base64?: string;
  path?: string;
  count?: number;
}

export type ReferenceImportDecision = "import" | "skip" | "copy";
export interface ReferenceImportEntry {
  entryId: string;
  name: string;
  kind?: ReferencePresetKind;
  group?: string;
  previewUrl?: string;
  status: "new" | "identical" | "conflict" | "invalid";
  defaultAction: ReferenceImportDecision;
  message: string;
  localNames?: string[];
  parameters?: Record<string, unknown>;
  localParameters?: Array<{ name: string; parameters: Record<string, unknown> }>;
}
export interface ReferenceImportPreview {
  ok: boolean;
  canceled?: boolean;
  message?: string;
  importId?: string;
  libraryRevision?: number;
  packageName?: string;
  entries?: ReferenceImportEntry[];
}
export interface ReferenceImportCommitRequest {
  importId: string;
  libraryRevision: number;
  decisions: Array<{ entryId: string; action: ReferenceImportDecision }>;
}
export interface ReferenceImportCommitResult {
  ok: boolean;
  message: string;
  requiresReview?: boolean;
  imported: number;
  skipped: number;
  failed: number;
  entries: Array<{ entryId: string; name: string; status: "imported" | "skipped" | "failed"; localId?: string; message?: string }>;
}

export type StylePromptPreviewImage = ContractStylePromptPreviewImage;

/** A single tag suggestion from the NAI suggest-tags endpoint */
export interface TagSuggestion {
  tag: string;
  count: number;
  /** 0=general, 1=artist, 3=copyright, 4=character, 5=meta */
  category: number;
  /** Optional Chinese note shown in the renderer autocomplete menu. */
  description?: string;
}

export type AppLanguage = "zh-CN" | "en-US";

/**
 * Keys of a reference preset's localized source names (sourceNames/sourceGameNames). This is the stored and
 * imported preset data format and keeps all five keys; the interface shows only the AppLanguage ones.
 */
export type ReferencePresetNameLocale = "zh-CN" | "zh-TW" | "en-US" | "ja-JP" | "ko-KR";

/** Suffix of a credentialIssues entry for a credential the settings file holds in plaintext, a form this version never
 * writes: it is not used, and it is dropped on the next write (the user enters it again). */
export const CREDENTIAL_FORMAT_ISSUE_SUFFIX = ":unsupported-format";

export interface AppSettings {
  /** Runtime-only: credentials that could not be read. A plain key ("token") is ciphertext that did not decrypt here
   * (retained for recovery); "<key>:unsupported-format" (CREDENTIAL_FORMAT_ISSUE_SUFFIX) is a plaintext value that
   * was not used and is not written back. */
  credentialIssues?: string[];
  hasOnboarded: boolean;
  language: AppLanguage;
  outputDir: string;
  /** Folder for the app.log error log. Empty = default <userData>/logs. */
  logDir: string;
  apiBaseUrl: string;
  imageBaseUrl: string;
  // Opt-in to sending the NovelAI Bearer token to a non-official endpoint host.
  // Default false: a custom (non *.novelai.net) endpoint is refused to avoid
  // leaking the token to an untrusted server.
  allowCustomEndpoint: boolean;
  // Opt-in to retrying a failed (401/403) custom image endpoint against the
  // official one. Default false: without this, a custom-endpoint failure just
  // fails — it doesn't silently and invisibly also become a real, billed
  // request against the user's official account.
  allowCustomEndpointFallback: boolean;
  proxyMode: "auto" | "http" | "direct" | "socks" | "custom";
  // Manual proxy override. Empty in auto/direct modes. Accepts
  // http://host:port or socks5://host:port.
  proxyUrl: string;
  // Per-category proxy opt-out (all default true = everything goes through proxy).
  proxyForNai: boolean;
  proxyForUpdate: boolean;
  /** Check GitHub for a newer release shortly after start and every 6 hours (default true). */
  autoCheckUpdates: boolean;
  /** A release version the user chose to skip; automatic checks do not announce it again ("" = none). */
  ignoredUpdateVersion: string;
  theme: "light" | "dark" | "system";
  /** Explicit accessibility preference. It is intentionally independent from
   * Windows' generic animation-effects flag so performance tuning does not
   * silently disable every product transition. */
  reduceMotion: boolean;
  autoComplete: boolean;
  weightHighlight: boolean;
  promptRandomizer: boolean;
  superDrop: boolean;
  /** Show intermediate NovelAI generation frames. Defaults on; unsupported
   * endpoints safely keep using the normal ZIP response. */
  streamPreviewEnabled: boolean;
  showFloatingToolbar: boolean;
  historyJumpAfterGenerate: boolean;
  historyRetentionDays: number;
  /** Write app.log (errors + call info). Default on. */
  loggingEnabled: boolean;
  /** Keep the generation metadata (prompt / seed / params, embedded in the saved
   * PNG) on disk. Default on. Turn off to save clean images with the embedded
   * info stripped — useful before sharing. */
  keepImageMetadata: boolean;
  /** Local portable archive schedule. Manual exports still select every
   * category by default. Automatic archives stay metadata-only unless the
   * user explicitly opts into copying the potentially very large image set. */
  autoBackupEnabled: boolean;
  autoBackupIntervalHours: number;
  autoBackupRetentionCount: number;
  autoBackupIncludeImages: boolean;
  /** Empty = <userData>/backups. */
  backupDir: string;
  activeHistoryGroupId: string;
  // Persisted save destination for ordinary generation, independent from the
  // history panel's current filter (`activeHistoryGroupId`).
  generationGroupId: string;
  // Anime vs Furry model family (official site offers both; anime is default).
  modelMode: ModelMode;
  // Saved/locked style + negative prompts. When locked, they persist across
  // sessions and are protected from reset / template overwrites.
  lockStylePrompt: boolean;
  lockNegativePrompt: boolean;
  savedStylePrompt: string;
  savedNegativePrompt: string;
  // Filename template for saved images. Tokens: {date} {time} {seq} {seed} {model} {ext}
  imageNameTemplate: string;
  // Prompt templates
  promptTemplates: PromptTemplate[];
  // Named style-prompt presets available from the generation panel.
  stylePromptPresets: StylePromptPreset[];
  // Stored separately so empty user-created groups survive restarts.
  stylePromptPresetGroups: string[];
  // Positive-only reusable prompt presets shared by Generate and compatible
  // artist-string tools. Optional images are view-only notes (maximum three).
  positivePromptPresets: PositivePromptPreset[];
  // Small reusable phrases inserted into any positive/character prompt. These
  // are intentionally stored separately from whole-prompt presets.
  promptChunks: PromptChunk[];
  lastGenerationState: LastGenerationState | null;
  // Per-tool opt-out for restoring lastGenerationState across restarts.
  // All default true (today's behavior); turning one off means that tool
  // falls back to hardcoded defaults on next launch instead of restoring
  // what was last used there.
  persistGenerateParams: boolean;
  persistI2IParams: boolean;
  persistInpaintParams: boolean;
  persistUpscaleParams: boolean;
  persistDirectorParams: boolean;
  /** Queue safety (src/queue-limits.ts): images one enqueue may add, 1–200, default 20. */
  queueMaxItemsPerEnqueue: number;
  /** Queue safety: unfinished items all queued batches may hold together, default 200; null = no limit. */
  queueMaxPendingItems: number | null;
  /** Queue retention (src/queue-limits.ts QUEUE_RETENTION_DAYS): ended agent batches older than this many days are
   * cleaned (7, 30 or 90, default 30); null = never. */
  queueRetentionDays: number | null;
}

export type SettingKey = keyof AppSettings;

/** Settings › Queue (electron/queue-recipe-service.ts retentionStatus): what the queue retention cleaned. */
export interface QueueRetentionStatus {
  days: number | null;
  /** Ended batches cleaned so far (their records stay; their batch is gone). */
  cleanedBatches: number;
  /** Records recovered from the library (history queueOrigin) for keys whose records were rolled back or removed. */
  recoveredFromLibrary?: number;
  running: boolean;
  lastRun: { at: string; days: number | null; skipped: string | null; cleaned: number; recipes: number; receipts: number; kept?: number; invalid?: number; ms: number } | null;
  /** The cleaned records (review rework P1): broken while they are damaged or missing (answers that need them are refused). */
  records?: { state: 'ok' | 'broken'; problem?: string; detail?: string; anchored: number | null; readable: number };
  recordFiles?: { records: string; anchors: string[] };
}
/** Settings › Queue: the knowing repair of damaged cleaned records (electron/queue-recipe-service.ts repairPlan). */
export interface QueueRecordsRepairPlan { needed: boolean; readable: number; lost: number | null; recoverable: number; unrecoverable: number | null; health: NonNullable<QueueRetentionStatus['records']> }
export type QueueRetentionRequest = { action?: 'status' } | { action: 'preview'; days: number | null } | { action: 'repairPlan' } | { action: 'repair'; confirm: { lost: number | null; recoverable: number } };

/** Settings → MCP access (electron/mcp-access.ts): how MCP clients start this app's MCP server. */
export interface McpAccessInfo {
  platform: string;
  packaged: boolean;
  executable: string;
  bundle: string;
  bundleExists: boolean;
  sourceEntry: string | null;
  dataRoot: string;
  customDataRoot: boolean;
  dataDirEnv: string;
  projectRootEnv: string;
  workspaceRoot: string;
  materialInbox: string;
  studyInbox: string;
  inboxFolders: string[];
  temporaryLocation: boolean;
  claudeCommand: string;
  jsonConfig: string;
  sourceCommand: string;
  /** Step 4b2: the workspace bridge of this client is serving. */
  bridgeReady: boolean;
  /** The tool timeout and the startup wait the snippets ask for (seconds). */
  toolTimeoutSeconds: number;
  startupTimeoutSeconds: number;
  /** Step 4b2: the configuration for each MCP client, with this run's real paths. */
  clients: Record<McpClientId, McpClientConfig>;
}
export type McpClientId = "claude" | "cursor" | "codex" | "pi" | "dsh" | "other";
export interface McpClientConfig {
  /** command: run once in a terminal; json / toml / yaml: merge into the file named (or the client's own configuration). */
  format: "command" | "json" | "toml" | "yaml";
  /** The user configuration file the client documents, ~ for the home folder; null for a command or an unnamed file. */
  file: string | null;
  snippet: string;
  /** default: the client's default is long enough; set: the snippet sets it; unavailable: the client documents no
   * setting; manual: set it in the client yourself. */
  toolTimeout: "default" | "set" | "unavailable" | "manual";
}

/**
 * Result of one check for a newer release of this app on GitHub (electron/ipc/update.ts). The app only
 * announces a release and opens its page; it never downloads or installs anything.
 */
export interface UpdateInfo {
  /**
   * available: a newer release than this build exists. current: none newer (or none published yet).
   * ignored: the newer release is the version the user chose to skip (automatic checks only).
   * disabled: automatic checks are off, nothing was requested. failed: the request or its answer failed.
   */
  status: "available" | "current" | "ignored" | "disabled" | "failed";
  /** status === "available" */
  hasUpdate: boolean;
  currentVersion: string;
  /** The latest release's version without a leading v, when one was read. */
  latestVersion?: string;
  /** Its release page on github.com (available only). */
  releaseUrl?: string;
  /** What failed (failed only). */
  error?: string;
  checkedAt?: string;
}

/**
 * The self-update in the main process (electron/update/updater.ts): what "Update and restart" is doing now. idle:
 * nothing yet; checking / downloading / verifying / preparing: under way (cancellable); ready: downloaded, verified and
 * staged, waiting for the queue (queueBusy) or a click; installing: the helper runs and the app is quitting; failed:
 * error says why (verify_failed stops for good; retryable ones may be tried again).
 */
export interface UpdateProgressInfo {
  phase: "idle" | "checking" | "downloading" | "verifying" | "preparing" | "ready" | "installing" | "failed";
  version?: string;
  received?: number;
  total?: number | null;
  error?: { code: "verify_failed" | "download_failed" | "no_update" | "install_unsupported" | "install_failed" | "check_failed" | "cancelled" | "unpack_failed"; message: string; retryable: boolean; reason?: string };
  queueBusy?: boolean;
  /** Whether this installation can update itself; reason when not (then only Download is offered). */
  install?: { supported: boolean; reason?: string };
}

/** The first start after an update: it worked (updated), or the old version is running again (failed, with the reason code). */
export type UpdateNotice =
  | { kind: "updated"; from: string; to: string; releaseUrl: string }
  | { kind: "failed"; to: string; reason: string; releaseUrl: string };

/** Compatible generation parameters extracted from embedded image metadata. */
export interface ImportedParams {
  preservePromptText?: boolean;
  metadataReplay?: MetadataReplay;
  positivePrompt?: string;
  negativePrompt?: string;
  stylePrompt?: string;
  model?: NAIModel;
  /** V5 Full's Effort (src/nai-effort.ts), from the image's model id or `Source`. */
  effort?: "high" | "medium";
  steps?: number;
  cfgScale?: number;
  cfgRescale?: number;
  sampler?: NAISampler;
  noiseSchedule?: string;
  seed?: number;
  seedMode?: "fixed" | "random";
  width?: number;
  height?: number;
  smea?: boolean;
  smeaDyn?: boolean;
  ucPreset?: UcPreset;
  qualityToggle?: boolean;
  qualityPreset?: QualityPreset;
  transparentBackground?: boolean;
  variety?: boolean;
}

export interface NaiDesktopApi {
  exportAssetImages: (args: import('./asset-library/image-export').ImageExportRequest) => Promise<import('./asset-library/image-export').ImageExportResult>;
  /** Censored JPG export (src/censor): where to save, one rendered image, done. */
  exportCensoredImage: (args: import('./censor/export-types').CensoredExportRequest) => Promise<import('./censor/export-types').CensoredExportResult>;
  assetLibrary: (args: Record<string, unknown>) => Promise<any>;
  onAssetLibraryChange: (callback: (change: { revision: number; changedKinds?: string[]; ids?: string[] }) => void) => () => void;
  materialLibrary: (args: Record<string, unknown>) => Promise<any>;
  materialTags: (args: Record<string, unknown>) => Promise<any>;
  materialSamples: (args: Record<string, unknown>) => Promise<any>;
  materialStudies: (args: Record<string, unknown>) => Promise<any>;
  workspacePromptReview: (args: import("./workspace/prompt-review").PromptReviewPreparation) => Promise<import("./workspace/generation-types").GenerationResponse<import("./workspace/prompt-review").PromptReviewInput>>;
  onGenerationJob: (listener: (job: import("./workspace/generation-types").GenerationJob) => void) => () => void;
  /** The queue panel: list_queue, pause_queue, resume_queue, cancel_queue of the host recipe queue. */
  queueCall: (method: "list_queue" | "pause_queue" | "resume_queue" | "cancel_queue", args: Record<string, unknown>) => Promise<import("./workspace/generation-types").GenerationResponse<any>>;
  onQueueBatch: (listener: (batch: import("./workspace/batch-types").BatchJob) => void) => () => void;
  /** Queue retention removed these ended batches (the queue view drops them). */
  onQueueRemoved?: (listener: (event: { batchIds: string[] }) => void) => () => void;
  /** Settings › Queue: the retention period, the batches cleaned so far and the last run. */
  queueRetention?: (request?: QueueRetentionRequest) => Promise<import("./workspace/generation-types").GenerationResponse<any>>;
  onQueueRetention?: (listener: (status: QueueRetentionStatus) => void) => () => void;
  /** Recent agent calls (client, tool, time; never arguments) and the clients seen (electron/agent-activity.ts). */
  agentActivity: () => Promise<import("./agent-clients").AgentActivity>;
  onAgentActivity: (listener: (activity: import("./agent-clients").AgentActivity) => void) => () => void;
  onWorkspaceRequest: (callback: (request: import("./workspace/protocol").WorkspaceRequest) => void) => () => void;
  replyWorkspace: (response: import("./workspace/protocol").WorkspaceResponse) => void;
  workspaceReady: (workspaceId?: string) => void;
  commitWorkbench: (filePath: string | null) => { ok: boolean; message?: string };
  platform: NodeJS.Platform;
  exportDataBackup: (request: DataBackupExportRequest) => Promise<DataBackupOperationResult>;
  inspectDataBackup: () => Promise<DataBackupInspectResult>;
  importDataBackup: (request: DataBackupImportRequest) => Promise<DataBackupImportResult>;
  getDataBackupStatus: () => Promise<DataBackupStatus>;
  runAutomaticBackup: (workspaceData?: Record<string, string>) => Promise<DataBackupOperationResult>;
  selectBackupDirectory: () => Promise<string | null>;
  openBackupDirectory: () => Promise<{ ok: boolean; message?: string }>;
  onImageSaveFeedback: (callback: (notices: import("./image-save-feedback").ImageSaveNotice[]) => void) => () => void;
  dismissImageSaveFeedback: (id: number) => void;
  importStylePromptPresetImages: (
    presetId: string,
    availableSlots: number,
    dialogTitle?: string,
  ) => Promise<StylePromptPreviewImage[]>;
  importStylePromptPresetImagePaths: (
    sourcePaths: string[],
    presetId: string,
    availableSlots: number,
  ) => Promise<StylePromptPreviewImage[]>;
  reconcileStylePromptPresetImages: (
    presetId: string,
    knownImages: StylePromptPreviewImage[],
  ) => Promise<StylePromptPreviewImage[]>;
  listReferencePresets: () => Promise<ReferencePresetLibrary>;
  saveReferencePreset: (
    request: ReferencePresetSaveRequest,
  ) => Promise<ReferencePresetOperationResult>;
  readReferencePreset: (
    presetId: string,
  ) => Promise<ReferencePresetOperationResult>;
  deleteReferencePreset: (
    presetId: string,
  ) => Promise<ReferencePresetOperationResult>;
  createReferencePresetGroup: (
    name: string,
  ) => Promise<ReferencePresetOperationResult>;
  deleteReferencePresetGroup: (
    name: string,
  ) => Promise<ReferencePresetOperationResult>;
  moveReferencePresetToGroup: (
    presetId: string,
    group: string,
  ) => Promise<ReferencePresetOperationResult>;
  importReferencePresets: () => Promise<ReferencePresetOperationResult>;
  prepareReferenceImport: () => Promise<ReferenceImportPreview>;
  commitReferenceImport: (request: ReferenceImportCommitRequest) => Promise<ReferenceImportCommitResult>;
  exportReferencePresets: (
    request?: ReferencePresetExportRequest,
  ) => Promise<ReferencePresetOperationResult>;
  hasToken: () => Promise<AccountSummary>;
  accountCached: () => Promise<AccountSummary>;
  /** The saved token, "" when there is none. */
  storedToken: () => Promise<string>;
  verifyToken: (token: string) => Promise<TokenStatus>;
  clearToken: () => Promise<{ ok: boolean }>;
  quoteAnlas: (request: AnlasQuoteRequest) => Promise<AnlasQuoteResult>;
  /** Manual generation (step 4a): freezes one Generate click into a manual batch of the shared queue. */
  manualEnqueue: (request: import("./workspace/manual-batches").ManualGenerationRequest) => Promise<import("./workspace/generation-types").GenerationResponse<import("./workspace/manual-batches").ManualEnqueueReply>>;
  /** The batch of a click whose enqueue went unanswered (same requestKey; never a resend). */
  manualLookup: (requestKey: string) => Promise<import("./workspace/generation-types").GenerationResponse<import("./workspace/manual-batches").ManualEnqueueReply | { batch: null; ahead: number }>>;
  /** Image modes: reads the click's source file at the click (before the balance refresh and the quote); its sourceId goes with the enqueue. */
  manualCaptureSource: (filePath: string) => Promise<import("./workspace/generation-types").GenerationResponse<{ sourceId: string }>>;
  /** Each settled image of a manual batch (saved images go to the canvas). */
  onManualItem: (listener: (event: import("./workspace/manual-batches").ManualItemEvent) => void) => () => void;
  onGenerationPreview: (
    callback: (event: GenerationPreviewEvent) => void,
  ) => () => void;
  readClipboardImageFiles: () => Promise<Array<{name:string;bytes:Uint8Array}>>;
  savePastedImageFiles: (images: Array<{name:string;bytes:Uint8Array}>) => Promise<string[]>;
  loadImage: () => Promise<LoadImageResult>;
  loadImageFromPath: (filePath: string) => Promise<LoadImageResult>;
  saveMetadataSnapshot: (payload: MetadataSnapshotPayload) => Promise<MetadataSnapshotResult>;
  saveMetadataSnapshotFromPath: (filePath: string) => Promise<MetadataSnapshotResult>;
  readMetadataSnapshotFromPath: (filePath: string) => Promise<MetadataSnapshotResult>;
  loadMetadataSnapshot: () => Promise<MetadataSnapshotResult>;
  getPathForFile: (file: File) => string;
  clearWorkbenchImage: () => Promise<{ ok: boolean }>;
  getHistory: (date?: string, groupId?: string) => Promise<HistoryItem[]>;
  /** Optional so older hosts and test doubles fall back to a full getHistory. */
  getHistoryItems?: (request: HistoryItemsRequest) => Promise<HistoryItemsSnapshot>;
  getHistoryDates: () => Promise<string[]>;
  getHistoryGroups: () => Promise<HistoryGroup[]>;
  createHistoryGroup: (name: string) => Promise<HistoryGroup[]>;
  renameHistoryGroup: (id: string, name: string) => Promise<HistoryGroup[]>;
  deleteHistoryGroup: (id: string) => Promise<HistoryGroup[]>;
  exportHistoryGroup: (
    groupId: string,
  ) => Promise<{ ok: boolean; message: string; path?: string }>;
  setHistoryGroup: (id: string, groupId?: string) => Promise<{ ok: boolean }>;
  deleteHistory: (id: string) => Promise<{ ok: boolean }>;
  renameHistoryItem: (
    id: string,
    name: string,
  ) => Promise<{ ok: boolean; message?: string; item?: HistoryItem }>;
  openInExplorer: (targetPath: string) => Promise<{ ok: boolean }>;
  /** Native OS drag-out of a saved image file (drag to desktop / Explorer / other apps). */
  startImageDrag: (filePath: string) => void;
  selectOutputDir: () => Promise<string | null>;
  getSetting: <K extends SettingKey>(key: K) => Promise<AppSettings[K]>;
  setSetting: <K extends SettingKey>(
    key: K,
    value: AppSettings[K],
  ) => Promise<AppSettings[K]>;
  getSettings: () => Promise<AppSettings>;
  isFirstRun: () => Promise<boolean>;
  completeSetup: () => Promise<{ ok: boolean }>;
  suggestTags: (model: string, prompt: string) => Promise<TagSuggestion[]>;
  /** A manual check for a newer release (Settings › About), whatever autoCheckUpdates says. */
  checkUpdate: () => Promise<UpdateInfo>;
  /** The last result of the main process's checks; null before the first one. */
  getUpdateStatus: () => Promise<UpdateInfo | null>;
  /** Settings › About: the text of this app's LICENSE or THIRD_PARTY_NOTICES.md. */
  readLegalDocument: (kind: "license" | "notices") => Promise<string>;
  /** Settings → MCP access: commands and configuration for this run. */
  mcpAccess: () => Promise<McpAccessInfo>;
  /** This launch's key for the error structure the preload writes into messages (src/host-errors/bridge.ts). */
  hostErrorKey?: string;
  /** Every result the main process's checks publish (startup, every 6 hours, manual). */
  onUpdateEvent: (callback: (info: UpdateInfo) => void) => () => void;
  /** "Update and restart": starts (or, when ready, installs) the update of the latest release. */
  startUpdate?: () => Promise<UpdateProgressInfo>;
  /** Stops a download or check under way and removes a staged version. */
  cancelUpdate?: () => Promise<UpdateProgressInfo>;
  /** The self-update's state now, with whether this installation can update itself. */
  getUpdateProgress?: () => Promise<UpdateProgressInfo>;
  /** The result of an update that just ran (this start is the first one after it), or null. */
  getUpdateNotice?: () => Promise<UpdateNotice | null>;
  onUpdateProgress?: (callback: (progress: UpdateProgressInfo) => void) => () => void;
  minimize: () => Promise<void>;
  maximize: () => Promise<void>;
  close: () => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  getLogInfo: () => Promise<{
    path: string;
    dir: string;
    exists: boolean;
    sizeBytes: number;
  }>;
  selectLogDir: () => Promise<string | null>;
  openLogFile: () => Promise<{ ok: boolean; message?: string; code?: string; reason?: string }>;
  openLogDir: () => Promise<{ ok: boolean; message?: string }>;
  readLog: () => Promise<string>;
}
