import { buildPayload as buildPurePayload, shouldRetryCharCaptionsAsPipe, normalizedCharCaptions,
  type PayloadParams, type CharCaptionMode } from "../nai-payload";
export { shouldRetryCharCaptionsAsPipe };
import { snapshotCharacters } from "../../src/character-snapshot";
import { activeLibrary } from '../library-runtime';
import { sanitizeGroupFolderName } from '../queue-output';
import { beginLibraryFileOperation } from '../library-file-operations';
import { validateGeneratedHistoryPayload } from '../library/validation';
import { QUEUE_UPSCALE_MODEL } from "../../src/workspace/generation-postprocess";
import { nativeImageInput, processableImage } from "./image-codec";
import { beginInpaintDiagnosticCapture, finishInpaintDiagnosticCapture } from "./inpaint-diagnostics";
import { app, dialog, nativeImage } from "electron";
import axios from "axios";
import FormData from "form-data";
import JSZip from "jszip";
import { PNG } from "pngjs";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { toLocalMediaUrl } from "./local-media-protocol";
import {
  DEFAULT_PARAMS,
  assertPromptAssemblyVersion,
  isNAIV4PlusModel,
  normalizeGenerateParams,
  supportsNAIPreciseReference,
  supportsNAIVibeTransfer,
  MAX_NAI_DIRECTOR_INPUT_PIXELS,
  MAX_NAI_UPSCALE_INPUT_PIXELS,
  MAX_NAI_UPSCALE_OUTPUT_DIMENSION,
  supportsNAIMaxEnhance,
  type AccountSummary,
  type AnlasQuoteRequest,
  type AnlasQuoteResult,
  type AugmentOptions,
  type DirectorTool,
  type GenerateExtras,
  type GenerateParams,
  type GenerateResult,
  type GenerationPreviewEvent,
  type HistoryItem,
  type GenerationOrigin,
  type I2IParams,
  type LoadImageResult,
  type NAIInpaintModel,
  type SingleImageResult,
  type TagSuggestion,
  type TokenStatus,
  type UpscaleScale,
  type WorkingImage,
} from "../../src/types";
import { inspectImageMetadata, parseImageMeta } from "../../src/png-meta";
import { calculateFeatureAnlasQuote } from "../../src/anlas";
import { applyNAIEffort, naiRequestModel } from "../../src/nai-effort";
import { compactRemoteErrorText, describeRemoteError, type RemoteError } from "../../src/error-message";
import { hostError, type HostErrorParams } from "../host-error";
import { cleanUpstreamText, type UpstreamReason } from "../upstream-reason";

/**
 * A failure of an image request the host found itself (step 4c1): an English message (logs, the generation's own
 * message) with the reason the window renders in its language (src/host-errors/queue.ts generation.*).
 */
const generationRefusal = (reason: string, message: string, params?: HostErrorParams, code = "generation_failed") => hostError(code, message, reason, params);
import {
  addHistory,
  getAccountSummary,
  getHistoryGroups,
  getSettings,
  getToken,
  setAccountSummary,
  setToken,
} from "./store";
import { TAG_DICTIONARY } from "../data/tag-dictionary";
import { logError, logInfo, appendLog } from "./logger";
import { proxyConfig } from "./proxy";
import { beginJob } from "./job-registry";
import { NaiSseFrameDecoder, NaiStreamFrameDecoder, type NaiStreamFrame } from "./nai-stream";
import { hostText } from "../host-language";

let workbenchImagePath: string | null = null;

function normalizeBaseUrl(url: string, fallback: string) {
  const value = (url || fallback).trim().replace(/\/+$/, "");
  return value.length > 0 ? value : fallback;
}

// Only official NovelAI hosts (and localhost, for local proxies/mirrors a user
// runs themselves) may receive the Bearer token unless the user explicitly opts
// into a custom endpoint. Prevents a mistyped/hostile endpoint from exfiltrating
// the token.
export function isOfficialNaiHost(baseUrl: string): boolean {
  try {
    const { hostname, protocol } = new URL(baseUrl);
    const host = hostname.toLowerCase();
    const isNovelAi = host === "novelai.net" || host.endsWith(".novelai.net");
    // The real API only ever runs on HTTPS — matching the hostname alone would
    // let a plain http:// URL (e.g. a misconfigured or malicious proxy) still
    // count as "official" and carry the Bearer token in the clear.
    if (isNovelAi) return protocol === "https:";
    // Loopback stays allowed over plain HTTP: it's for local dev/reverse-proxy
    // setups where the traffic never leaves the machine.
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

// Returns a token-safe base URL: the configured endpoint when it is trusted (or
// the user opted into custom endpoints), otherwise the official fallback.
function tokenSafeBaseUrl(rawUrl: string, fallback: string): string {
  const resolved = normalizeBaseUrl(rawUrl, fallback);
  if (isOfficialNaiHost(resolved)) {
    try {
      const resolvedHost = new URL(resolved).hostname.toLowerCase();
      const fallbackHost = new URL(fallback).hostname.toLowerCase();
      const loopback = resolvedHost === "localhost" || resolvedHost === "127.0.0.1" || resolvedHost === "::1";
      if (loopback || resolvedHost === fallbackHost) return resolved;
      // A custom-endpoint opt-in must not turn an accidentally swapped official
      // NovelAI subdomain into a valid target. api.novelai.net and
      // image.novelai.net are not interchangeable and stale settings here can
      // surface as opaque generation HTTP 500 responses.
      const isNovelAi = resolvedHost === "novelai.net" || resolvedHost.endsWith(".novelai.net");
      if (isNovelAi) return fallback;
    } catch {
      /* fall through to the configured custom-endpoint policy */
    }
  }
  if (getSettings().allowCustomEndpoint) return resolved;
  appendLog(
    "WARN",
    `[security] refusing to send token to non-official endpoint ${resolved}; using ${fallback}.`,
  );
  return fallback;
}

/** Resolve the dedicated upscaler endpoint.
 *
 * NovelAI currently serves POST /ai/upscale from image.novelai.net.  Keeping
 * this separate from the account API endpoint prevents the deterministic
 * `Cannot POST /ai/upscale` response returned by api.novelai.net.
 */
export function resolveUpscaleBaseUrl(rawImageBaseUrl: string): string {
  return tokenSafeBaseUrl(rawImageBaseUrl, "https://image.novelai.net");
}

const UPSCALE_MODEL = QUEUE_UPSCALE_MODEL;
const UPSCALE_DECLARED_BLUR_SIGMA = 0;

/** Normalize the current generation model for the dedicated upscale API.
 *
 * The official web client uses the dedicated V5 Curated upscaler regardless of
 * the model that produced the source image. Generation model IDs such as V4.5
 * Full/Curated are rejected by this endpoint and must not reach the request.
 */
export function resolveUpscaleModel(_rawModel: string): string {
  return UPSCALE_MODEL;
}

export function buildUpscalePayload(image: Buffer, rawModel: string) {
  return {
    image: image.toString("base64"),
    model: resolveUpscaleModel(rawModel),
    declared_blur_sigma: UPSCALE_DECLARED_BLUR_SIGMA,
  };
}

/** Pure request construction shared by execution and read-only prompt review. */
export function buildDirectorPayload(image: { base64: string; width: number; height: number }, tool: DirectorTool, options: AugmentOptions): Record<string, unknown> {
  const payload: Record<string, unknown> = { image: image.base64, width: image.width, height: image.height, req_type: tool, defry: Math.min(5, Math.max(0, options.defry)) };
  if (tool === "colorize") payload.prompt = options.colorizePrompt;
  if (tool === "emotion") payload.prompt = `${options.emotion};;${Math.min(5, Math.max(0, options.emotionLevel))}`;
  return payload;
}

export function applyI2IParameters(payload: ReturnType<typeof buildPayload>, image: string, i2i: I2IParams, extraNoiseSeed: number) {
  payload.action = "img2img";
  Object.assign(payload.parameters, { image, strength: clamp01(i2i.strength, 0.7), noise: 0, extra_noise_seed: extraNoiseSeed });
  // Enhance Max✨ (V5): the source goes at its own size and NovelAI returns it about 2× larger (official
  // generateEnhance, see src/nai-dimensions.ts maxEnhanceInputSize). Only the V5 models have it.
  if (i2i.upscaledEnhance === true) {
    if (!supportsNAIMaxEnhance(payload.model)) throw generationRefusal("generation.max_enhance_model", "Enhance Max✨ exists only for the V5 models.", undefined, "invalid_configuration");
    payload.parameters.upscaled_enhance = true;
  }
  return payload;
}

export function resolveUpscaleOutputSize(
  width: number,
  height: number,
  scale: UpscaleScale,
) {
  const outputWidth = width * scale;
  const outputHeight = height * scale;
  return {
    width: outputWidth,
    height: outputHeight,
    exceedsLimit:
      outputWidth > MAX_NAI_UPSCALE_OUTPUT_DIMENSION ||
      outputHeight > MAX_NAI_UPSCALE_OUTPUT_DIMENSION,
  };
}

function tierName(tier?: number) {
  return tier === 3
    ? "Opus"
    : tier === 2
      ? "Scroll"
      : tier === 1
        ? "Tablet"
        : tier === 0
          ? "Paper"
          : "未知";
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value))
    return Math.round(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.round(parsed);
  }
  return undefined;
}

function readFinite(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseAccount(data: any): Omit<AccountSummary, "hasToken"> {
  // The website payload has changed wrappers before. Read the same
  // subscription object whether /user/data returns it at the top level or
  // inside `information`/`data`, without inventing allowance values.
  const sub =
    data?.subscription ??
    data?.information?.subscription ??
    data?.data?.subscription ??
    data?.data?.information?.subscription ??
    {};
  const tierLevel = readNumber(sub?.tier);
  const active = typeof sub?.active === "boolean" ? sub.active : true;
  let anlasBalance: number | undefined;

  if (typeof sub?.trainingStepsLeft === "object" && sub.trainingStepsLeft) {
    anlasBalance =
      (readNumber(sub.trainingStepsLeft.fixedTrainingStepsLeft) ?? 0) +
      (readNumber(sub.trainingStepsLeft.purchasedTrainingSteps) ?? 0);
  } else {
    anlasBalance = readNumber(sub?.trainingStepsLeft);
  }

  let expiresAt: string | undefined;
  const rawExpires = readNumber(sub?.expiresAt);
  if (rawExpires) {
    const seconds =
      rawExpires > 10_000_000_000 ? Math.floor(rawExpires / 1000) : rawExpires;
    expiresAt = new Date(seconds * 1000).toISOString().slice(0, 10);
  }

  const rawUsage = sub?.usage;
  const usagePercent = readFinite(rawUsage?.percent);
  const usageSeconds = readFinite(rawUsage?.timeUntilNextPercent);
  const opusUsage = rawUsage && usagePercent !== undefined && usageSeconds !== undefined
    ? {
        percent: usagePercent,
        isNegative: rawUsage.isNegative === true,
        timeUntilNextPercent: Math.max(0, usageSeconds),
      }
    : undefined;

  return {
    tierName: tierName(tierLevel),
    tierLevel,
    anlasBalance,
    expiresAt,
    hasActiveSubscription: Boolean(active && tierLevel && tierLevel > 0),
    opusUsage,
    opusUsageUpdatedAt: opusUsage ? Date.now() : undefined,
  };
}

async function fetchAccount(
  token: string,
): Promise<Omit<AccountSummary, "hasToken">> {
  const settings = getSettings();
  // NovelAI now rejects /user/data on api.novelai.net for at least some accounts
  // with a 400 telling third-party tools to "update to the image URL" — confirmed
  // live that image.novelai.net serves the identical payload successfully.
  const imageBaseUrl = tokenSafeBaseUrl(
    settings.imageBaseUrl,
    "https://image.novelai.net",
  );
  const res = await axios.get(`${imageBaseUrl}/user/data`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15_000,
    ...proxyConfig("nai"),
  });
  return parseAccount(res.data);
}

/**
 * Checks a token against the account route and saves it only when valid. The answer is English with a reason (and
 * params) the window renders in its language (step 4c1): token.empty, token.invalid (HTTP 401), remote.unavailable /
 * remote.html_page / remote.failed (no readable answer), else token.verify_failed with NovelAI's own message.
 */
export async function verifyToken(token: string): Promise<TokenStatus> {
  const normalized = token.trim();
  if (!normalized) {
    return { valid: false, message: "Enter your NovelAI Persistent API Token.", reason: "token.empty" };
  }

  try {
    // This is the account route used by the official image web client. It may
    // wrap the subscription payload differently across deployments, which is
    // why parseAccount accepts all observed wrappers above.
    const account = await fetchAccount(normalized);

    setToken(normalized);
    setAccountSummary(account);
    return { valid: true, message: "The API token is verified.", ...account };
  } catch (error: any) {
    const status = error?.response?.status;
    if (status === 401) return { valid: false, message: "The token is invalid or has expired.", reason: "token.invalid", params: httpParams(status) };
    const remote = responseError(error);
    return {
      valid: false,
      message: `Token verification failed: ${remote.text}`,
      ...(remote.reason ? { reason: remote.reason, params: { ...httpParams(status), ...remote.params } } : { reason: "token.verify_failed", params: { ...httpParams(status), detail: remote.text } }),
    };
  }
}

export async function refreshStoredAccount(): Promise<AccountSummary> {
  const token = getToken();
  if (!token) return { hasToken: false };

  try {
    const account = await fetchAccount(token);
    setAccountSummary(account);
    return { hasToken: true, ...account };
  } catch {
    // Live refresh failed — return the last known summary but flag it as stale so
    // the UI can show "缓存余额" instead of presenting an outdated number as current.
    return { ...getAccountSummary(), stale: true };
  }
}

function isV4Plus(model: string) {
  return isNAIV4PlusModel(model);
}

function inpaintSizeHint(image: Pick<WorkingImage, "width" | "height">) {
  const width = image.width || 0;
  const height = image.height || 0;
  if (!width || !height) return { reason: "generation.inpaint_500_nosize", message: "The source size cannot be read; load the source again and retry." };
  if (width % 64 === 0 && height % 64 === 0) return null;
  return { reason: "generation.inpaint_500_size", message: `The source is ${width}×${height}, not a multiple of 64; NovelAI's inpaint often answers HTTP 500 for such sizes. Use a source whose width and height are multiples of 64.`, params: { width, height } };
}

function inpaintModelCandidates(model: NAIInpaintModel) {
  const candidates = [model];
  if (model === "nai-diffusion-5-curated-inpainting") {
    candidates.push("nai-diffusion-5-full-inpainting");
  } else if (model === "nai-diffusion-4-5-curated-inpainting") {
    candidates.push("nai-diffusion-4-5-full-inpainting");
  } else if (model === "nai-diffusion-4-curated-inpainting") {
    candidates.push("nai-diffusion-4-full-inpainting");
  }
  return [...new Set(candidates)];
}

function isInpaintModelCompatibilityError(error: any): boolean {
  const status = error?.response?.status;
  if (status !== 400 && status !== 422) return false;
  const detail = responseErrorText(error) || error?.message || "";
  return /(?:doesn'?t|does not|not)\s+support|unsupported|invalid\s+model|action\s+infill/i.test(
    detail,
  );
}

// Generation and review use the same pure assembler. Keep transport diagnostics here.
export function buildPayload(params: PayloadParams, actualSeed: number, extras?: GenerateExtras, charCaptionMode: CharCaptionMode = "structured") {
  const payload = buildPurePayload(params, actualSeed, extras, charCaptionMode);
  const parameters = payload.parameters;
  if (parameters.director_reference_images && extras?.preciseReferences?.length) {
    const preciseRefs = extras.preciseReferences;
    // Log the EXACT precise-reference fields we send (sans base64) so it can be
    // diffed against the official client's F12 "Copy request payload". This is an
    // unverified reverse-engineered shape — the log is how we confirm/correct it.
    logInfo(
      "precise-ref payload → " +
        JSON.stringify({
          model: payload.model,
          director_reference_descriptions:
            parameters.director_reference_descriptions,
          director_reference_strength_values:
            parameters.director_reference_strength_values,
          director_reference_secondary_strength_values:
            parameters.director_reference_secondary_strength_values,
          director_reference_information_extracted:
            parameters.director_reference_information_extracted,
          director_reference_images: preciseRefs.map(
            (r) => `<base64 ${r.base64.length} chars>`,
          ),
        }),
    );
  }
  return payload;
}

/**
 * Cache of encode-vibe results. encode-vibe is a paid, deterministic endpoint:
 * the same raw image + model + information_extracted always yields the same vibe
 * encoding, so we cache by their hash to avoid re-encoding (and re-charging) the
 * same reference for every image in a batch.
 */
const vibeEncodeCache = new Map<string, string>();

function clamp01(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

// Precise/Director reference: accept ANY size and replicate the OFFICIAL client
// preprocessing (per https://docs.novelai.net/en/image/precisereference): the
// feature "always uses one of those three image sizes" — 1024×1536 / 1472×1472 /
// 1536×1024 — and a smaller/bigger image is "upscaled/downscaled AND padded" to
// reach one of them. We pick the size whose ASPECT RATIO is closest to the
// source (so padding is minimal — the earlier grid artifacts came from forcing
// every image into 1024×1536, which over-padded landscapes), scale to fit, then
// black-pad the remainder. No cropping.
const DIRECTOR_REFERENCE_SIZES: Array<{ width: number; height: number }> = [
  { width: 1024, height: 1536 },
  { width: 1472, height: 1472 },
  { width: 1536, height: 1024 },
];

function prepareDirectorReferenceImage(
  rawBase64: string,
  index: number,
): string {
  const image = nativeImage.createFromBuffer(Buffer.from(rawBase64, "base64"));
  if (image.isEmpty()) {
    throw generationRefusal("generation.precise_undecodable", `Precise reference #${index + 1} cannot be decoded; use a valid PNG, JPG or WebP image.`, { index: index + 1 });
  }
  const { width, height } = image.getSize();
  if (!width || !height) {
    throw generationRefusal("generation.precise_size", `Precise reference #${index + 1} has an invalid size; use a valid PNG, JPG or WebP image.`, { index: index + 1 });
  }

  // Pick the official target whose aspect ratio best matches the source.
  const sourceAspect = width / height;
  const target = DIRECTOR_REFERENCE_SIZES.reduce((best, candidate) => {
    const bestDiff = Math.abs(best.width / best.height - sourceAspect);
    const candidateDiff = Math.abs(
      candidate.width / candidate.height - sourceAspect,
    );
    return candidateDiff < bestDiff ? candidate : best;
  }, DIRECTOR_REFERENCE_SIZES[0]);

  // Scale to FIT inside the target (preserve aspect), then center on a black canvas.
  const scale = Math.min(target.width / width, target.height / height);
  const fitW = Math.max(1, Math.round(width * scale));
  const fitH = Math.max(1, Math.round(height * scale));
  const fg = PNG.sync.read(
    image.resize({ width: fitW, height: fitH, quality: "best" }).toPNG(),
  );
  // Flatten any alpha onto WHITE and pad with WHITE. The reference encoder is fed
  // RGB only; transparent pixels in an RGBA PNG otherwise carry undefined/black
  // RGB that bleeds in as dark blotches, and a BLACK letterbox reads as image
  // content (the source of the earlier grid/line artifacts). White is the neutral
  // choice. (Hypothesis for the halftone/cross-hatch overlay — verify against the
  // official F12 payload before treating as settled.)
  let alphaPresent = false;
  const canvas = new PNG({ width: target.width, height: target.height });
  canvas.data.fill(255); // white, fully opaque
  const offsetX = Math.floor((target.width - fg.width) / 2);
  const offsetY = Math.floor((target.height - fg.height) / 2);
  for (let y = 0; y < fg.height; y += 1) {
    for (let x = 0; x < fg.width; x += 1) {
      const src = (y * fg.width + x) * 4;
      const dst = ((y + offsetY) * target.width + (x + offsetX)) * 4;
      const a = fg.data[src + 3] / 255;
      if (a < 1) alphaPresent = true;
      canvas.data[dst] = Math.round(fg.data[src] * a + 255 * (1 - a));
      canvas.data[dst + 1] = Math.round(fg.data[src + 1] * a + 255 * (1 - a));
      canvas.data[dst + 2] = Math.round(fg.data[src + 2] * a + 255 * (1 - a));
      canvas.data[dst + 3] = 255;
    }
  }
  logInfo(
    `precise-ref image #${index + 1}: src ${width}x${height}` +
      `${alphaPresent ? " RGBA→RGB(white-flattened)" : " RGB"} → ${target.width}x${target.height}` +
      ` (fit ${fitW}x${fitH}, white pad)`,
  );
  return PNG.sync.write(canvas).toString("base64");
}

function vibeCacheKey(
  rawBase64: string,
  model: string,
  infoExtracted: number,
): string {
  const hash = crypto.createHash("sha256").update(rawBase64).digest("hex");
  return `${model}|${infoExtracted}|${hash}`;
}

// How many of the request's vibe references are already encoded+cached this
// session (so they incur NO further encode charge). Used to make the pre-run
// quote accurate — re-generating with the same references won't re-encode.
function countCachedVibes(
  extras: GenerateExtras | undefined,
  params: GenerateParams | undefined,
): number {
  if (!extras?.vibeImages?.length || !params) return 0;
  let cached = 0;
  for (const vibe of extras.vibeImages) {
    const key = vibeCacheKey(
      stripBase64Prefix(vibe.base64),
      params.model,
      vibe.infoExtracted,
    );
    if (vibeEncodeCache.has(key)) cached += 1;
  }
  return cached;
}

/**
 * V4/V4.5 Vibe Transfer requires reference images to be pre-encoded through the
 * /ai/encode-vibe endpoint (legacy V3 accepted raw image bytes directly). For
 * V4+ models we encode each vibe and cache the result. If the endpoint fails we
 * now abort with a clear error instead of silently sending the raw image bytes —
 * the raw fallback produced a second downstream failure (or a silently wrong /
 * reference-less result) rather than a usable image.
 *
 * NOTE: needs verification against a live V4.5 token — the encode-vibe payload
 * shape is based on the NovelAI web client and may need adjustment.
 */
export async function prepareExtras(
  params: GenerateParams,
  extras?: GenerateExtras,
  signal?: AbortSignal,
): Promise<GenerateExtras | undefined> {
  if (!extras) return extras;
  if (extras.vibeImages?.length) extras = {...extras, vibeImages: await Promise.all(extras.vibeImages.map(async ref => ({...ref, base64:(await processableImage(Buffer.from(stripBase64Prefix(ref.base64), "base64"))).toString("base64")})))};

  // Precise/director references: any size accepted, preprocessed to the nearest
  // of NovelAI's three official sizes (scale-to-fit + black pad), matching the
  // official client.
  let preciseReferences = extras.preciseReferences;
  if (preciseReferences && preciseReferences.length > 0) {
    if (!supportsNAIPreciseReference(params.model)) {
      throw generationRefusal("generation.precise_model", "Precise references work with NovelAI V4.5 only for now; switch to V4.5 Full or Curated, or remove the precise references.");
    }
    preciseReferences = await Promise.all(preciseReferences.map(async (ref, index) => ({
      ...ref,
      base64: prepareDirectorReferenceImage(
        (await processableImage(Buffer.from(stripBase64Prefix(ref.base64), "base64"))).toString("base64"),
        index,
      ),
    })));
  }

  if (!extras.vibeImages || extras.vibeImages.length === 0) {
    return { ...extras, preciseReferences };
  }
  if (!supportsNAIVibeTransfer(params.model)) {
    throw generationRefusal("generation.vibe_model", "NovelAI V5 does not support Vibe Transfer for now; switch to V4.5, or remove the Vibe images.");
  }
  if (!isV4Plus(params.model)) return { ...extras, preciseReferences }; // V3 path unchanged

  const token = getToken();
  const settings = getSettings();
  const imageBaseUrl = tokenSafeBaseUrl(
    settings.imageBaseUrl,
    "https://image.novelai.net",
  );

  const encoded = await Promise.all(
    extras.vibeImages.map(async (vibe) => {
      const rawBase64 = stripBase64Prefix(vibe.base64);
      const cacheKey = vibeCacheKey(
        rawBase64,
        params.model,
        vibe.infoExtracted,
      );
      const cached = vibeEncodeCache.get(cacheKey);
      if (cached) return { ...vibe, base64: cached };
      try {
        const res = await requestWithRetry(
          () =>
            axios.post(
              `${imageBaseUrl}/ai/encode-vibe`,
              {
                image: rawBase64,
                information_extracted: vibe.infoExtracted,
                model: params.model,
              },
              {
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                },
                responseType: "arraybuffer",
                timeout: 60_000,
                signal,
                ...proxyConfig("nai"),
              },
            ),
          // encode-vibe is a paid endpoint; only retry pre-charge 429s.
          { retries: 2, signal, retryStatuses: [429] },
        );
        const encodedBase64 = Buffer.from(res.data).toString("base64");
        vibeEncodeCache.set(cacheKey, encodedBase64);
        return { ...vibe, base64: encodedBase64 };
      } catch (error: any) {
        if (signal?.aborted) throw error;
        const remote = responseError(error), detail = remote.text;
        logError("[vibe] encode-vibe failed", detail);
        // Abort rather than send raw bytes — a failed encode cannot produce a
        // correct vibe-transfer result, so surface it instead of charging for
        // a wrong (or reference-less) image.
        throw Object.assign(generationRefusal(remote.reason ?? "generation.vibe_encode_failed", `Encoding a Vibe image failed (encode-vibe): ${detail}`, remote.reason ? remote.params : { detail }), { encodeFailure: true });
      }
    }),
  );

  return { ...extras, vibeImages: encoded, preciseReferences };
}

export async function extractImages(
  zipBytes: ArrayBuffer | Buffer,
): Promise<Buffer[]> {
  const zip = await JSZip.loadAsync(zipBytes);
  const images: Buffer[] = [];
  const files = Object.values(zip.files).filter((file) => !file.dir);
  for (const file of files) {
    const bytes = await file.async("nodebuffer");
    // ZIPs may also contain metadata or other attachments. A filename (including
    // a .png extension) does not make those bytes an image. Keep supported image
    // bytes and order intact; never guess a generated candidate from its name.
    const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jpeg = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    const webp = bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
    if (!png && !jpeg && !webp) continue;
    try {
      await sharp(bytes).raw().toBuffer();
    } catch {
      throw generationRefusal("generation.zip_undecodable", "An image in NovelAI's ZIP answer cannot be decoded; the generation was not retried.");
    }
    images.push(bytes);
  }
  return images;
}

function dateStamp(date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function detectExt(buffer: Buffer) {
  if (
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "png";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF") return "webp";
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
    return "jpg";
  return "png";
}

/**
 * What a failed NovelAI request says (describeRemoteError): English text for logs and messages, and the reason
 * (remote.unavailable, remote.html_page, remote.failed) when the window should render it in its language. NovelAI's own
 * answer (an HTTP response) is cleaned the one way the queue page's upstream answer is (cleanUpstreamText: no
 * credentials, paths, addresses or invisible characters; review rework), so the canvas, the account check and the log
 * show the same.
 */
function responseError(error: any): RemoteError {
  // Only an HTTP answer is NovelAI's text; a local failure (a refused connection, a timeout) says what this computer did.
  const remote = describedResponse(error);
  return remote.reason || !error?.response ? remote : { ...remote, text: cleanUpstreamText(remote.text) };
}
function describedResponse(error: any): RemoteError {
  const data = error?.response?.data;
  const status = Number(error?.response?.status);
  const source = Buffer.isBuffer(data)
    ? data.toString("utf8")
    : data instanceof ArrayBuffer
      ? Buffer.from(data).toString("utf8")
      : data ?? error?.message ?? "";
  return describeRemoteError(source, { status: Number.isInteger(status) ? status : undefined });
}
const responseErrorText = (error: any) => responseError(error).text;

function stripBase64Prefix(value: string) {
  const idx = value.indexOf(",");
  return idx >= 0 ? value.slice(idx + 1) : value;
}

const INPAINT_SIZE_MULTIPLE = 64;
const INPAINT_MASK_GRID_SIZE = 8;
const INPAINT_BLEND_DILATE_CELLS = 4;
const INPAINT_BLEND_BLUR_RADIUS = 20;
const INPAINT_BLEND_BLUR_PASSES = 2;

export interface PreparedInpaintAssets {
  imageBase64: string;
  maskBase64: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  resized: boolean;
  /** Normalized source resized to the request dimensions, as in NovelAI's editor. */
  sourcePng: Buffer;
  /** Official-client-style feathered mask, one alpha byte per request pixel. */
  blendAlpha: Uint8Array;
}

interface PreparedLimitedImage {
  base64: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  resized: boolean;
}

function ceilToMultiple(value: number, multiple: number) {
  return Math.max(multiple, Math.ceil(value / multiple) * multiple);
}

function fitWithinPixels(width: number, height: number, maxPixels: number) {
  const pixels = width * height;
  if (!width || !height || pixels <= maxPixels)
    return { width, height, resized: false };
  const ratio = Math.sqrt(maxPixels / pixels);
  return {
    width: Math.max(1, Math.floor(width * ratio)),
    height: Math.max(1, Math.floor(height * ratio)),
    resized: true,
  };
}

function bufferToPng(buffer: Buffer) {
  if (
    buffer.length >= 8 &&
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return buffer;
  }
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty())
    throw generationRefusal("generation.source_undecodable", "The source image cannot be decoded; use a PNG, JPG or WebP image.");
  return image.toPNG();
}

function flattenPngAlpha(
  buffer: Buffer,
  background = { r: 255, g: 255, b: 255 },
) {
  const png = PNG.sync.read(buffer);
  for (let idx = 0; idx < png.data.length; idx += 4) {
    const alpha = png.data[idx + 3] / 255;
    if (alpha >= 1) continue;
    png.data[idx] = Math.round(
      png.data[idx] * alpha + background.r * (1 - alpha),
    );
    png.data[idx + 1] = Math.round(
      png.data[idx + 1] * alpha + background.g * (1 - alpha),
    );
    png.data[idx + 2] = Math.round(
      png.data[idx + 2] * alpha + background.b * (1 - alpha),
    );
    png.data[idx + 3] = 255;
  }
  return PNG.sync.write(png);
}

export function prepareLimitedImage(
  buffer: Buffer,
  maxPixels: number,
  options: { flattenAlpha?: boolean; forcePng?: boolean } = {},
): PreparedLimitedImage {
  const source = nativeImage.createFromBuffer(buffer);
  if (source.isEmpty())
    throw generationRefusal("generation.source_undecodable", "The image cannot be decoded; use a PNG, JPG or WebP image.");
  const size = source.getSize();
  const fitted = fitWithinPixels(size.width, size.height, maxPixels);
  let output = buffer;
  if (fitted.resized) {
    output = source
      .resize({ width: fitted.width, height: fitted.height, quality: "best" })
      .toPNG();
  } else if (options.forcePng || options.flattenAlpha) {
    output = source.toPNG();
  }
  if (options.flattenAlpha) output = flattenPngAlpha(output);
  return {
    base64: output.toString("base64"),
    width: fitted.width,
    height: fitted.height,
    originalWidth: size.width,
    originalHeight: size.height,
    resized: fitted.resized,
  };
}

export function resizeImageBufferToPng(buffer: Buffer, width: number, height: number) {
  if (nativeImage?.createFromBuffer) {
    const image = nativeImage.createFromBuffer(buffer);
    if (!image.isEmpty()) {
      return image.resize({ width, height, quality: "best" }).toPNG();
    }
  }
  // Vitest and a few headless Electron contexts do not expose nativeImage.
  // Keep the official resize behavior available instead of falling back to
  // edge padding; the 64-alignment resize is normally only a few percent.
  const source = PNG.sync.read(bufferToPng(buffer));
  if (source.width === width && source.height === height) return PNG.sync.write(source);
  const target = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.max(
      0,
      Math.min(source.height - 1, ((y + 0.5) * source.height) / height - 0.5),
    );
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(source.height - 1, y0 + 1);
    const fy = sourceY - y0;
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.max(
        0,
        Math.min(source.width - 1, ((x + 0.5) * source.width) / width - 0.5),
      );
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(source.width - 1, x0 + 1);
      const fx = sourceX - x0;
      const dst = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const top =
          source.data[(y0 * source.width + x0) * 4 + channel] * (1 - fx) +
          source.data[(y0 * source.width + x1) * 4 + channel] * fx;
        const bottom =
          source.data[(y1 * source.width + x0) * 4 + channel] * (1 - fx) +
          source.data[(y1 * source.width + x1) * 4 + channel] * fx;
        target.data[dst + channel] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return PNG.sync.write(target);
}

function prepareLatentInpaintMask(
  mask: PNG,
  targetWidth: number,
  targetHeight: number,
) {
  const width = targetWidth / INPAINT_MASK_GRID_SIZE;
  const height = targetHeight / INPAINT_MASK_GRID_SIZE;
  const selected = new Uint8Array(width * height);
  let any = false;
  // Editor masks encode the selection in alpha. A fully opaque mask selects by
  // brightness instead: that is the 8-bit greyscale mask prepare_recipe builds
  // (novelai/src/recipe-masks.mjs, 255 = repaint), and any opaque black/white mask.
  let usesAlpha = false;
  for (let index = 3; index < mask.data.length; index += 4) {
    if (mask.data[index] !== 255) {
      usesAlpha = true;
      break;
    }
  }

  for (let cellY = 0; cellY < height; cellY += 1) {
    for (let cellX = 0; cellX < width; cellX += 1) {
      // The official client first resizes to the 1/8 latent grid with nearest
      // sampling, then thresholds alpha at 155. Sampling one source pixel per
      // destination cell avoids the over-wide "any painted pixel in 8x8" mask.
      const sourceX = Math.min(
        mask.width - 1,
        Math.floor(((cellX + 0.5) * mask.width) / width),
      );
      const sourceY = Math.min(
        mask.height - 1,
        Math.floor(((cellY + 0.5) * mask.height) / height),
      );
      const sourceIndex = (sourceY * mask.width + sourceX) * 4;
      const alpha = mask.data[sourceIndex + 3];
      const brightest = Math.max(
        mask.data[sourceIndex],
        mask.data[sourceIndex + 1],
        mask.data[sourceIndex + 2],
      );
      const active = usesAlpha ? alpha > 155 : alpha > 0 && brightest > 155;

      const latentIndex = cellY * width + cellX;
      selected[latentIndex] = active ? 1 : 0;
      any ||= active;
    }
  }

  if (!any) throw generationRefusal("generation.no_mask", "The mask is empty; paint the area to inpaint first.");
  // The official editor quantizes on a 1/8-resolution canvas, but its request
  // pipeline expands that binary grid back to the requested image dimensions
  // with nearest-neighbour sampling before upload. Sending the tiny latent PNG
  // itself makes the API reinterpret/resize the mask and can severely degrade
  // the inpainted region (large flat blobs, text, or unrelated content).
  const requestMask = new PNG({ width: targetWidth, height: targetHeight });
  for (let y = 0; y < targetHeight; y += 1) {
    const cellY = Math.min(height - 1, Math.floor(y / INPAINT_MASK_GRID_SIZE));
    for (let x = 0; x < targetWidth; x += 1) {
      const cellX = Math.min(width - 1, Math.floor(x / INPAINT_MASK_GRID_SIZE));
      const value = selected[cellY * width + cellX] ? 255 : 0;
      const rgbaIndex = (y * targetWidth + x) * 4;
      requestMask.data[rgbaIndex] = value;
      requestMask.data[rgbaIndex + 1] = value;
      requestMask.data[rgbaIndex + 2] = value;
      requestMask.data[rgbaIndex + 3] = 255;
    }
  }
  return { png: PNG.sync.write(requestMask), selected, width, height };
}

function dilateLatentMask(
  source: Uint8Array,
  width: number,
  height: number,
  radius: number,
) {
  const output = new Uint8Array(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let active = false;
      for (let dy = -radius; dy <= radius && !active; dy += 1) {
        const sy = y + dy;
        if (sy < 0 || sy >= height) continue;
        for (let dx = -radius; dx <= radius; dx += 1) {
          const sx = x + dx;
          if (sx >= 0 && sx < width && source[sy * width + sx] !== 0) {
            active = true;
            break;
          }
        }
      }
      output[y * width + x] = active ? 1 : 0;
    }
  }
  return output;
}

function officialBoxBlurAlpha(
  source: Uint8Array,
  width: number,
  height: number,
  radius: number,
) {
  const horizontal = new Int32Array(source.length);
  const output = new Uint8Array(source.length);

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = source[row] * radius;
    for (let x = 0; x <= radius && x < width; x += 1) sum += source[row + x];
    for (let x = 0; x < width; x += 1) {
      horizontal[row + x] = sum;
      const removeX = Math.max(0, x - radius);
      const addX = Math.min(width - 1, x + radius + 1);
      sum -= source[row + removeX];
      sum += source[row + addX];
    }
  }

  for (let x = 0; x < width; x += 1) {
    let sum = horizontal[x] * radius;
    for (let y = 0; y <= radius && y < height; y += 1) {
      sum += horizontal[y * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      // NovelAI's worker uses the integer approximation 39 / 65536 for the
      // 41x41 (radius 20) box average. Preserve that result byte-for-byte.
      output[y * width + x] = Math.max(
        0,
        Math.min(255, (sum * 39) >> 16),
      );
      const removeY = Math.max(0, y - radius);
      const addY = Math.min(height - 1, y + radius + 1);
      sum -= horizontal[removeY * width + x];
      sum += horizontal[addY * width + x];
    }
  }
  return output;
}

function buildInpaintBlendAlpha(
  latentMask: Uint8Array,
  latentWidth: number,
  latentHeight: number,
  width: number,
  height: number,
) {
  const dilated = dilateLatentMask(
    latentMask,
    latentWidth,
    latentHeight,
    INPAINT_BLEND_DILATE_CELLS,
  );
  let alpha = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const cellY = Math.min(latentHeight - 1, Math.floor(y / INPAINT_MASK_GRID_SIZE));
    for (let x = 0; x < width; x += 1) {
      const cellX = Math.min(latentWidth - 1, Math.floor(x / INPAINT_MASK_GRID_SIZE));
      alpha[y * width + x] = dilated[cellY * latentWidth + cellX] ? 255 : 0;
    }
  }
  for (let pass = 0; pass < INPAINT_BLEND_BLUR_PASSES; pass += 1) {
    alpha = officialBoxBlurAlpha(
      alpha,
      width,
      height,
      INPAINT_BLEND_BLUR_RADIUS,
    );
  }
  return alpha;
}

function extractOfficialAnlasPrice(data: unknown): number | undefined {
  if (typeof data === "number" && Number.isFinite(data))
    return Math.max(0, Math.ceil(data));
  if (typeof data === "string" && Number.isFinite(Number(data)))
    return Math.max(0, Math.ceil(Number(data)));
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  const directKeys = [
    "price",
    "cost",
    "amount",
    "anlas",
    "requestPrice",
    "trainingSteps",
    "trainingStepsCost",
  ];
  for (const key of directKeys) {
    const value = record[key];
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value)
          : NaN;
    if (Number.isFinite(parsed)) return Math.max(0, Math.ceil(parsed));
  }
  for (const key of ["data", "result", "subscription"]) {
    const nested = extractOfficialAnlasPrice(record[key]);
    if (nested != null) return nested;
  }
  return undefined;
}

async function requestOfficialGenerationPrice(
  params: GenerateParams,
  extras?: GenerateExtras,
) {
  const token = getToken();
  if (!token) return undefined;
  const settings = getSettings();
  const imageBaseUrl = tokenSafeBaseUrl(
    settings.imageBaseUrl,
    "https://image.novelai.net",
  );
  const quoteParams: GenerateParams = {
    ...params,
    stylePrompt: params.stylePrompt || "",
    positivePrompt: params.positivePrompt.trim() || "quote",
    negativePrompt: params.negativePrompt || "",
  };
  const payload = buildPayload(quoteParams, 1, {
    vibeImages: [],
    charCaptions: [],
    modelMode: extras?.modelMode,
  });
  try {
    const response = await axios.post(
      `${imageBaseUrl}/ai/generate-image/request-price`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 12_000,
        ...proxyConfig("nai"),
      },
    );
    return extractOfficialAnlasPrice(response.data);
  } catch {
    return undefined;
  }
}

export async function quoteAnlasCost(
  request: AnlasQuoteRequest,
): Promise<AnlasQuoteResult> {
  const token = getToken();
  if (!token) {
    return {
      ok: false,
      source: "unavailable",
      reason: "missing-token",
      message: "请先配置 NovelAI Token，才能读取生成前扣费。",
    };
  }

  const account = request.account?.hasToken
    ? request.account
    : await refreshStoredAccount();
  let image: Pick<WorkingImage, "width" | "height"> | null =
    request.image ?? null;
  if (request.feature === "upscale" || request.feature === "inpaint") {
    if (!image) {
      try {
        image = (await readWorkbenchImage()).image;
      } catch {
        image = null;
      }
    }
  }

  const calculated = calculateFeatureAnlasQuote({
    feature: request.feature,
    params: request.params,
    extras: request.extras,
    batchCount: request.batchCount,
    i2iParams: request.i2iParams,
    inpaintModel: request.inpaintModel,
    inpaintStrength: request.inpaintStrength,
    account,
    image,
    upscaleScale: request.upscaleScale,
    directorTool: request.directorTool,
    // Encoded = already in the session cache, OR already covered by an earlier
    // queued job / the active run (the renderer's hint). Take the larger of the
    // two (they refer to the same references) and cap at the vibe count.
    alreadyEncodedVibes: Math.min(
      request.extras?.vibeImages?.length ?? 0,
      Math.max(
        countCachedVibes(request.extras, request.params),
        request.alreadyQueuedVibes ?? 0,
      ),
    ),
  });
  if (!calculated.ok) return calculated;

  const hasVibes = (request.extras?.vibeImages?.length ?? 0) > 0;
  if (request.feature !== "generate" || !request.params || hasVibes)
    return calculated;

  const officialPerRequest = await requestOfficialGenerationPrice(
    request.params,
    request.extras,
  );
  if (officialPerRequest == null) return calculated;

  const amount =
    officialPerRequest * Math.max(1, Math.floor(request.batchCount ?? 1));
  const balance = account.anlasBalance;
  return {
    ok: true,
    amount,
    source: "official-api",
    balance,
    insufficient: typeof balance === "number" && amount > balance,
    message: `生成前官方报价：${amount} Anlas。`,
    details: [
      `NovelAI request-price returned ${officialPerRequest} Anlas per request.`,
      request.batchCount && request.batchCount > 1
        ? `The desktop app sends ${Math.floor(request.batchCount)} single-image requests: ${officialPerRequest} x ${Math.floor(request.batchCount)}.`
        : "The desktop app sends one single-image request.",
    ],
  };
}

export function prepareInpaintAssets(
  imageBuffer: Buffer,
  maskBase64: string,
): PreparedInpaintAssets {
  const sourcePng = PNG.sync.read(bufferToPng(imageBuffer));
  const originalWidth = sourcePng.width;
  const originalHeight = sourcePng.height;
  const width = ceilToMultiple(originalWidth, INPAINT_SIZE_MULTIPLE);
  const height = ceilToMultiple(originalHeight, INPAINT_SIZE_MULTIPLE);
  if (width > 1600 || height > 1600) {
    throw generationRefusal("generation.inpaint_too_large", `The inpaint source is ${originalWidth}×${originalHeight}, beyond what NovelAI accepts; shrink it so that, padded to multiples of 64, it is at most 1600×1600.`, { width: originalWidth, height: originalHeight });
  }
  const maskPng = PNG.sync.read(
    Buffer.from(stripBase64Prefix(maskBase64), "base64"),
  );
  const resized = width !== originalWidth || height !== originalHeight;
  const normalizedSource = resized
    ? resizeImageBufferToPng(PNG.sync.write(sourcePng), width, height)
    : PNG.sync.write(sourcePng);
  // Match the official two-stage mask path: quantize to the model's 1/8 grid,
  // then upload a full-size nearest-neighbour expansion of that binary grid.
  // A separately grown and feathered copy is used for local compositing.
  const latentMask = prepareLatentInpaintMask(maskPng, width, height);
  return {
    imageBase64: normalizedSource.toString("base64"),
    maskBase64: latentMask.png.toString("base64"),
    width,
    height,
    originalWidth,
    originalHeight,
    resized,
    sourcePng: normalizedSource,
    blendAlpha: buildInpaintBlendAlpha(
      latentMask.selected,
      latentMask.width,
      latentMask.height,
      width,
      height,
    ),
  };
}

export function compositeInpaintBuffers(
  buffers: Buffer[],
  assets: PreparedInpaintAssets,
) {
  const source = PNG.sync.read(assets.sourcePng);
  return buffers.map((buffer) => {
    let generatedBuffer = buffer;
    let generated = PNG.sync.read(bufferToPng(generatedBuffer));
    if (generated.width !== assets.width || generated.height !== assets.height) {
      generatedBuffer = resizeImageBufferToPng(
        generatedBuffer,
        assets.width,
        assets.height,
      );
      generated = PNG.sync.read(generatedBuffer);
    }

    const composited = new PNG({ width: assets.width, height: assets.height });
    for (let pixel = 0; pixel < assets.width * assets.height; pixel += 1) {
      const alpha = assets.blendAlpha[pixel] / 255;
      const rgba = pixel * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        composited.data[rgba + channel] = Math.round(
          generated.data[rgba + channel] * alpha +
            source.data[rgba + channel] * (1 - alpha),
        );
      }
    }

    // The official editor keeps the 64-aligned request dimensions instead of
    // cropping back to the imported file. Restore NovelAI's prompt/seed chunks
    // after local compositing re-encodes the pixels.
    return copyPngMetadataChunks(buffer, PNG.sync.write(composited));
  });
}

/** Apply the current official frontend's infill transport fields. */
export function applyOfficialInpaintParameters(
  parameters: Record<string, unknown>,
  assets: PreparedInpaintAssets,
  strength: number,
  noise: number,
  seed: number,
) {
  const normalizedStrength = Math.max(
    0,
    Math.min(1, Number.isFinite(strength) ? strength : 1),
  );
  // Keep the argument and transport field for compatibility after removing
  // the ineffective control, but never forward a stale persisted value.
  void noise;
  const normalizedNoise = 0;
  parameters.image = assets.imageBase64;
  parameters.mask = assets.maskBase64;
  parameters.add_original_image = false;
  parameters.inpaintImg2ImgStrength = normalizedStrength;
  // The official payload retains the generic img2img default even for infill;
  // inpaintImg2ImgStrength/nested img2img control the editor's strength UI.
  parameters.strength = 0.7;
  if (normalizedStrength !== 1) {
    parameters.img2img = {
      strength: normalizedStrength,
      color_correct: true,
    };
  } else {
    delete parameters.img2img;
  }
  parameters.noise = normalizedNoise;
  parameters.extra_noise_seed = Math.max(0, Math.round(seed) - 1);
  return parameters;
}

function annotateInpaintError(
  error: any,
  assets: PreparedInpaintAssets,
  model: string,
) {
  if (!assets.resized || error?.response?.status !== 500) return;
  // The window's reason (step 4c1); NovelAI's own answer stays in the response (its upstream text).
  error.reason = "generation.inpaint_500_resized";
  error.params = { originalWidth: assets.originalWidth, originalHeight: assets.originalHeight, width: assets.width, height: assets.height, model };
  error.userMessage = `Inpaint failed (HTTP 500): the source ${assets.originalWidth}×${assets.originalHeight} was fitted to ${assets.width}×${assets.height} as the official client does, but NovelAI's inpaint still answered with an internal error. Load the source again, repaint the mask, make the area smaller, or try later. Model: ${model}.`;
}

function readImageDimensions(buf: Buffer): { width: number; height: number } {
  if (
    buf
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset < buf.length - 9) {
      if (buf[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buf[offset + 1];
      const len = buf.readUInt16BE(offset + 2);
      if (
        marker === 0xc0 ||
        marker === 0xc1 ||
        marker === 0xc2 ||
        marker === 0xc3
      ) {
        return {
          height: buf.readUInt16BE(offset + 5),
          width: buf.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + len;
    }
  }

  if (
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    const chunk = buf.subarray(12, 16).toString("ascii");
    if (chunk === "VP8 " && buf.length > 29) {
      return {
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunk === "VP8L" && buf.length > 25) {
      const bits = buf.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    if (chunk === "VP8X" && buf.length > 29) {
      const width = 1 + buf.readUIntLE(24, 3);
      const height = 1 + buf.readUIntLE(27, 3);
      return { width, height };
    }
  }

  return { width: 0, height: 0 };
}

async function readWorkbenchImage(): Promise<{
  base64: string;
  buffer: Buffer;
  image: WorkingImage;
}> {
  if (!workbenchImagePath) throw generationRefusal("generation.no_source", "Load an image first.");
  const buffer = await processableImage(await fs.readFile(workbenchImagePath));
  const dims = readImageDimensions(buffer);
  return {
    base64: buffer.toString("base64"),
    buffer,
    image: {
      filePath: workbenchImagePath,
      fileUrl: toLocalMediaUrl(workbenchImagePath),
      width: dims.width,
      height: dims.height,
    },
  };
}

/** Render a save filename (without extension) from the user template. */
function buildImageFileName(
  template: string,
  ctx: {
    date: string;
    now: Date;
    seq: number;
    seed: number;
    model: string;
    prefix: string;
    name?: string;
  },
): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(ctx.now.getHours())}${pad(ctx.now.getMinutes())}${pad(ctx.now.getSeconds())}`;
  const custom = (ctx.name ?? "").trim();
  const tokens: Record<string, string> = {
    date: ctx.date,
    time,
    seq: pad(ctx.seq),
    seed: String(ctx.seed),
    model: ctx.model,
    type: ctx.prefix,
    name: custom,
    ts: String(ctx.now.getTime()),
  };
  let name = (template && template.trim()) || "{date}_{seq}_{model}";
  name = name.replace(/\{(\w+)\}/g, (_m, key: string) => tokens[key] ?? "");
  // If the user typed a custom name but the template has no {name} slot, prepend it
  // so the custom name always takes effect without forcing a template edit.
  if (custom && !/\{name\}/.test(template || "")) {
    const safeCustom = custom
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, "_");
    name = `${safeCustom}_${name}`;
  }
  name = name
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "_")
    .slice(0, 100);
  return name || `${ctx.now.getTime()}-${ctx.seq}`;
}

/** Return a non-colliding path, appending -1, -2... if needed. */
async function uniqueFilePath(
  dir: string,
  base: string,
  ext: string,
): Promise<string> {
  let candidate = path.join(dir, `${base}.${ext}`);
  let n = 1;
  for (;;) {
    try {
      await fs.access(candidate);
      candidate = path.join(dir, `${base}-${n++}.${ext}`);
    } catch {
      return candidate; // does not exist
    }
  }
}

// Sanitize a user group name into a safe folder segment (strip path-illegal
// characters, collapse whitespace, drop leading dots so we never produce a
// hidden/`..`-like folder, cap length). Shared with the queue's group checks.

// The generation destination is independent from the history panel's filter.
// A request may carry a snapshot so changing the selector while a queued image
// is running cannot redirect that image midway through the request.
function resolveGenerationSaveGroup(requestedId?: string):
  { groupId: string; folderName: string } | undefined {
  const activeId = requestedId === undefined
    ? getSettings().generationGroupId
    : requestedId;
  if (!activeId || activeId === "__ungrouped") return undefined;
  const group = getHistoryGroups().find((g) => g.id === activeId);
  if (!group) return undefined;
  return { groupId: group.id, folderName: sanitizeGroupFolderName(group.name) };
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
// PNG chunk types that carry human-readable / embedded generation metadata.
const PNG_METADATA_CHUNKS = new Set(["tEXt", "iTXt", "zTXt", "eXIf"]);

/**
 * Copy already checksummed metadata chunks from one PNG into another without
 * touching either image's pixel stream. This is used after local inpaint
 * compositing, which necessarily re-encodes pixels through pngjs.
 */
export function copyPngMetadataChunks(source: Buffer, target: Buffer): Buffer {
  if (
    source.length < 8 ||
    target.length < 8 ||
    !source.subarray(0, 8).equals(PNG_SIGNATURE) ||
    !target.subarray(0, 8).equals(PNG_SIGNATURE)
  ) {
    return target;
  }

  const metadata: Buffer[] = [];
  let sourceOffset = 8;
  while (sourceOffset + 12 <= source.length) {
    const length = source.readUInt32BE(sourceOffset);
    const type = source.toString("ascii", sourceOffset + 4, sourceOffset + 8);
    const end = sourceOffset + 12 + length;
    if (end > source.length) break;
    if (PNG_METADATA_CHUNKS.has(type)) metadata.push(source.subarray(sourceOffset, end));
    sourceOffset = end;
    if (type === "IEND") break;
  }
  if (metadata.length === 0) return target;

  const cleanTarget = stripPngMetadata(target);
  let insertAt = 8;
  while (insertAt + 12 <= cleanTarget.length) {
    const length = cleanTarget.readUInt32BE(insertAt);
    const type = cleanTarget.toString("ascii", insertAt + 4, insertAt + 8);
    if (type === "IDAT" || type === "IEND") break;
    const end = insertAt + 12 + length;
    if (end > cleanTarget.length) return target;
    insertAt = end;
  }
  return Buffer.concat([
    cleanTarget.subarray(0, insertAt),
    ...metadata,
    cleanTarget.subarray(insertAt),
  ]);
}

/**
 * Remove embedded metadata (tEXt/iTXt/zTXt/eXIf — where NovelAI stores the
 * prompt / seed / parameters JSON) from a PNG WITHOUT re-encoding the pixels, so
 * it stays lossless. Non-PNG buffers are returned untouched.
 */
export function stripPngMetadata(buffer: Buffer): Buffer {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE))
    return buffer;
  const out: Buffer[] = [buffer.subarray(0, 8)];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const chunkEnd = offset + 12 + length; // length(4) + type(4) + data + crc(4)
    if (chunkEnd > buffer.length) break; // malformed — keep the rest as-is
    if (!PNG_METADATA_CHUNKS.has(type))
      out.push(buffer.subarray(offset, chunkEnd));
    offset = chunkEnd;
    if (type === "IEND") break;
  }
  return Buffer.concat(out);
}

/** Apply the user's metadata preference at every image save boundary. */
export function prepareImageBufferForSave(
  buffer: Buffer,
  keepImageMetadata: boolean,
): Buffer {
  return keepImageMetadata ? buffer : stripPngMetadata(buffer);
}

interface HistorySaveOptions {
  ignoreActiveGroup?: boolean;
  groupOverride?: { groupId: string; folderName: string };
  generationOrigin?: GenerationOrigin;
  /** Frozen queue file prefix; names the file instead of params.fileNamePrefix (the history params stay as they were). */
  fileNamePrefix?: string;
  /** Queued images: the durable batch item, saved as history queueOrigin beside generationOrigin. */
  queueOrigin?: { batchId: string; requestKey: string; itemIndex: number };
  characterPrompts?: string[];
  characterSnapshot?: HistoryItem["characterSnapshot"];
  /** A manual item with a random seed: the record keeps seedMode random (the request ran with the drawn seed). */
  historySeedMode?: "random";
  /** A manual item: the mode of its click (GenerationExecutionOptions.generationMode). */
  feature?: string;
  /** Record each image with the size it decodes to, not the requested size (Enhance Max✨ returns about 2× the request). */
  measureImageSize?: boolean;
}

/** The history record generation saves for one image (saveBuffers); without a file yet, the record a generation is
 * about to save (refuseUnsavableHistory). */
function generatedHistoryItem(
  file: { id: string; filePath: string; fileUrl: string; date: string; createdAt: string },
  groupId: string | undefined,
  params: GenerateParams,
  actualSeed: number,
  modelOverride?: string,
  saveOptions?: HistorySaveOptions,
  imageSize?: { width: number; height: number },
): HistoryItem {
  return {
    ...file,
    params: { ...params, seed: actualSeed, ...(saveOptions?.historySeedMode ? { seedMode: saveOptions.historySeedMode } : {}) },
    actualSeed,
    model: modelOverride ?? params.model,
    width: imageSize?.width ?? params.width,
    height: imageSize?.height ?? params.height,
    groupId,
    ...(saveOptions?.characterSnapshot ? { characterSnapshot: structuredClone(saveOptions.characterSnapshot) } : {}),
    ...(saveOptions?.characterPrompts ? { characterPrompts: [...saveOptions.characterPrompts] } : {}),
    ...(saveOptions?.generationOrigin ? { generationOrigin: { ...saveOptions.generationOrigin, actualSeed: saveOptions.generationOrigin.actualSeed === null ? null : actualSeed } } : {}),
    ...(saveOptions?.queueOrigin ? { queueOrigin: { ...saveOptions.queueOrigin } } : {}),
    ...(saveOptions?.feature ? { feature: saveOptions.feature } : {}),
  };
}

/** The code of a generation refused because its history record would not pass the complete generation parameters. */
export const HISTORY_PARAMS_INVALID = "history_params_invalid";

/**
 * Checks the history record a generation is about to save (without its file: placeholder id, path and date) against
 * the complete generation parameters, before anything is sent to NovelAI. A record that would not pass is refused here:
 * no request is sent and nothing is charged. addHistory checks the saved record again.
 */
function refuseUnsavableHistory(record: HistoryItem): GenerateResult | null {
  try {
    validateGeneratedHistoryPayload(record);
    return null;
  } catch (error) {
    return {
      ok: false,
      message: `${HISTORY_PARAMS_INVALID}: ${error instanceof Error ? error.message : String(error)}；没有发送生成请求，也不会扣费。`,
      items: [],
      failureKind: "validation",
      errorCode: HISTORY_PARAMS_INVALID,
    };
  }
}
/** The file fields of a record that has no file yet (the schema checks only their types). */
const PLANNED_FILE = { id: "planned", filePath: "", fileUrl: "", date: "", createdAt: "" };

async function saveBuffers(
  buffers: Buffer[],
  params: GenerateParams,
  actualSeed: number,
  prefix: string,
  modelOverride?: string,
  saveOptions?: HistorySaveOptions,
): Promise<HistoryItem[]> {
  const settings = getSettings();
  const now = new Date();
  const date = dateStamp(now);
  // An explicit groupOverride (queue output or a snapshotted ordinary
  // generation) wins; otherwise use the persisted generation destination.
  const activeGroup = saveOptions?.groupOverride ??
    (saveOptions?.ignoreActiveGroup ? undefined : resolveGenerationSaveGroup());
  const dir = activeGroup
    ? path.join(settings.outputDir, date, activeGroup.folderName)
    : path.join(settings.outputDir, date);
  await fs.mkdir(dir, { recursive: true });

  const items: HistoryItem[] = [];
  const repository = activeLibrary();
  const fileOperations: string[] = [];
  for (let index = 0; index < buffers.length; index += 1) {
    const id = crypto.randomUUID();
    const ext = detectExt(buffers[index]);
    const safeModel = (modelOverride ?? params.model).replace(/[^\w.-]+/g, "-");
    const base = buildImageFileName(settings.imageNameTemplate, {
      date,
      now,
      seq: index + 1,
      seed: actualSeed,
      model: safeModel,
      prefix,
      name: saveOptions?.fileNamePrefix ?? params.fileNamePrefix,
    });
    const filePath = await uniqueFilePath(dir, base, ext);
    // Optionally strip embedded generation metadata before writing to disk.
    const outBuffer = prepareImageBufferForSave(
      buffers[index],
      settings.keepImageMetadata !== false,
    );
    const measured = saveOptions?.measureImageSize ? nativeImage.createFromBuffer(buffers[index]) : null;
    if (measured?.isEmpty()) throw generationRefusal("generation.image_undecodable", "The returned image cannot be decoded.");
    const item = generatedHistoryItem({ id, filePath, fileUrl: toLocalMediaUrl(filePath), date, createdAt: now.toISOString() }, activeGroup?.groupId, params, actualSeed, modelOverride, saveOptions, measured ? measured.getSize() : undefined);
    if (repository) fileOperations.push(beginLibraryFileOperation(repository, 'create', { kind: 'history', id, item, target: filePath, byteLength: outBuffer.length, sha256: crypto.createHash('sha256').update(outBuffer).digest('hex') }));
    await fs.writeFile(filePath, outBuffer, { flag: 'wx' });
    items.push(item);
  }
  saveGeneratedHistory(items);
  if (repository) repository.transaction(() => { for (const operation of fileOperations) repository.completeFileOperation(operation); });
  return items;
}

/** addHistory, with a warning in the log for a record it saved without the complete generation parameters. */
function saveGeneratedHistory(items: HistoryItem[]) {
  for (const saved of addHistory(items)) appendLog("WARN", `生成历史未通过完整生成参数检查，已按存储格式保存（图片已生成并保存，队列关联保留）：${saved.id} | ${saved.reason}`);
}

/** The wait before a retry was stopped (the operation was cancelled): read as a cancellation (ERR_CANCELED). */
const cancelledError = () => Object.assign(generationRefusal("generation.cancelled", "The operation was cancelled."), { code: "ERR_CANCELED" });

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(cancelledError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function isPreflightNetworkFailure(error: any): boolean {
  if (error?.response) return false;
  const message = String(error?.message ?? "").toLowerCase();
  return (
    message.includes("before secure tls connection was established") ||
    message.includes("tls handshake") ||
    error?.code === "ERR_SSL_HANDSHAKE_FAILURE"
  );
}

/** Retry only the explicitly permitted statuses/errors with exponential backoff. */
async function requestWithRetry<T>(
  fn: () => Promise<T>,
  {
    retries = 3,
    baseDelay = 2_000,
    signal,
    retryStatuses = [429],
    retryPreflightNetworkFailures = false,
  }: {
    retries?: number;
    baseDelay?: number;
    signal?: AbortSignal;
    retryStatuses?: number[];
    retryPreflightNetworkFailures?: boolean;
  } = {},
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error: any) {
      if (
        signal?.aborted ||
        axios.isCancel?.(error) ||
        error?.code === "ERR_CANCELED"
      )
        throw error;
      const status = error?.response?.status;
      const retryable =
        (typeof status === "number" && retryStatuses.includes(status)) ||
        (retryPreflightNetworkFailures && isPreflightNetworkFailure(error));
      if (!retryable || attempt >= retries) throw error;

      const retryAfter = Number(error?.response?.headers?.["retry-after"]);
      const wait =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : baseDelay * 2 ** attempt;
      attempt += 1;
      await sleep(Math.min(wait, 30_000), signal);
    }
  }
}

export function buildGenerateImageHttpBody(
  payload: ReturnType<typeof buildPayload>,
) {
  const params = payload.parameters as Record<string, unknown>;
  const cached = params?.director_reference_images_cached;
  const useMultipart = Array.isArray(cached) && cached.length > 0;
  let body: unknown = payload;
  let bodyHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (useMultipart) {
    const images = Array.isArray(params.director_reference_images)
      ? (params.director_reference_images as string[])
      : [];
    // In multipart mode NovelAI treats image-bearing JSON fields as the NAME of a
    // binary form part, not as base64. Director references ride as director_ref_N
    // (referenced via director_reference_images_cached). The img2img / inpaint
    // source image + mask must ALSO be uploaded as parts and referenced by name —
    // otherwise the API rejects with "image field references unknown form part".
    const requestJson = { ...payload, parameters: { ...params } };
    const rp = requestJson.parameters as Record<string, unknown>;
    delete rp.director_reference_images;
    const form = new FormData();
    const attachImagePart = (field: "image" | "mask") => {
      const b64 = rp[field];
      if (typeof b64 === "string" && b64) {
        form.append(field, Buffer.from(stripBase64Prefix(b64), "base64"), {
          filename: field,
          contentType: "image/png",
        });
        rp[field] = field; // reference the binary part by name
      }
    };
    attachImagePart("image");
    attachImagePart("mask");
    form.append("request", JSON.stringify(requestJson), {
      contentType: "application/json",
    });
    images.forEach((b64, index) => {
      form.append(
        `director_ref_${index}`,
        Buffer.from(stripBase64Prefix(b64), "base64"),
        {
          filename: "blob",
          contentType: "image/png",
        },
      );
    });
    body = form;
    bodyHeaders = form.getHeaders();
  }

  return { body, bodyHeaders, useMultipart };
}

/** Policy of queue (frozen recipe) generation; omitted by every manual entry point. */
export interface GenerationExecutionOptions {
  singleRequest: true;
  signal: AbortSignal;
  sourceBytes?: Buffer;
  /** Frozen renderer destination; empty/omitted explicitly means ungrouped. */
  historyGroupId?: string;
  /** Frozen queue file prefix (enqueue output); omitted keeps the params/template naming of every mode. */
  fileNamePrefix?: string;
  provenance?: GenerationOrigin;
  /** Queued images only: the durable batch item (history queueOrigin). */
  queueOrigin?: { batchId: string; requestKey: string; itemIndex: number };
  onSubmitted?: () => void;
  /**
   * A manual batch item (step 4a: a Generate click of this window, run by the shared queue): the request behaves as
   * the window's manual generation always did — Vibe/Precise references, 429 and pre-request network retries, the
   * custom-endpoint fallback, the structured-to-pipe character caption retry, inpaint model fallback, 4× upscale, the
   * stream preview (onPreview) and the manual file names — while its inputs (source bytes, group) stay frozen from
   * the click. Its history records carry no queue or generation origin, like every manual image.
   */
  manual?: true;
  /** Manual t2i only: the stream preview frames of this request. */
  onPreview?: GenerationPreviewCallback;
  /** Manual upscale only: the source file's name at the click (manual upscale names its file after it). */
  sourceName?: string;
  /** Manual seeded items whose click had a random seed: the saved record says seedMode random, as before. */
  historySeedMode?: "random";
  /**
   * Manual items (step 4b3c): the mode of the click, saved as the history record's feature (the record's optional mode
   * field the window already reads when there is no generationOrigin), so the library's mode filter finds manual images.
   */
  generationMode?: "t2i" | "i2i" | "inpaint" | "enhance" | "upscale" | "director";
}

/** A queue execution with the queue's single-request rules (not a manual batch item). */
const strictQueue = (execution?: GenerationExecutionOptions) => Boolean(execution && !execution.manual);

function assertQueueReferences(extras: GenerateExtras | undefined, execution?: GenerationExecutionOptions) {
  if (strictQueue(execution) && ((extras?.vibeImages?.length ?? 0) > 0 || (extras?.preciseReferences?.length ?? 0) > 0)) {
    throw generationRefusal("generation.queue_references", "Queued generation does not encode Precise/Vibe references or generate with them; the references and the model are kept.", undefined, "unsupported_reference");
  }
}

function queueGenerationSaveOptions(execution?: GenerationExecutionOptions) {
  // A manual item saves like the window always did (into the generation group, frozen at the click), with no origin.
  if (execution?.manual) return { ignoreActiveGroup: true, groupOverride: resolveGenerationSaveGroup(execution.historyGroupId ?? ''), ...(execution.historySeedMode ? { historySeedMode: execution.historySeedMode } : {}), ...(execution.generationMode ? { feature: execution.generationMode } : {}) };
  return execution ? { ignoreActiveGroup: true, groupOverride: resolveGenerationSaveGroup(execution.historyGroupId ?? ''), ...(execution.fileNamePrefix ? { fileNamePrefix: execution.fileNamePrefix } : {}), ...(execution.provenance ? { generationOrigin: structuredClone(execution.provenance) } : {}), ...(execution.queueOrigin ? { queueOrigin: { ...execution.queueOrigin } } : {}) } : undefined;
}

async function postGenerateImage(
  payload: ReturnType<typeof buildPayload>,
  signal?: AbortSignal,
  execution?: GenerationExecutionOptions,
) {
  const token = getToken();
  if (!token) throw generationRefusal("generation.no_token", "Set up your NovelAI API token in Settings first.");
  const settings = getSettings();
  const imageBaseUrl = tokenSafeBaseUrl(
    settings.imageBaseUrl,
    "https://image.novelai.net",
  );

  const postTo = (baseUrl: string) =>
    requestWithRetry(
      () => {
        // FormData is a one-shot stream. Rebuild it for every 429 attempt or
        // custom-endpoint fallback; reusing the consumed stream produces an
        // empty/partial multipart request and misleading server errors.
        if (execution) {
          signal?.throwIfAborted();
          payload.parameters.n_samples = 1;
        }
        const { body, bodyHeaders } = buildGenerateImageHttpBody(payload);
        execution?.onSubmitted?.();
        return axios.post(`${baseUrl}/ai/generate-image`, body, {
          headers: {
            Authorization: `Bearer ${token}`,
            ...bodyHeaders,
            Accept: "application/zip, application/octet-stream",
          },
          responseType: "arraybuffer",
          timeout: 180_000,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          ...(strictQueue(execution) ? { maxRedirects: 0 } : {}),
          signal,
          ...proxyConfig("nai"),
        });
      },
      // A paid generate POST may have already produced (and charged for) an image
      // even when the gateway reports a 5xx, so we never auto-retry server errors
      // here — only 429 rate-limits, which are rejected before any work is done.
      {
        signal,
        retries: strictQueue(execution) ? 0 : undefined,
        retryStatuses: [429],
        retryPreflightNetworkFailures: !strictQueue(execution),
      },
    );
  let res;
  try {
    res = await postTo(imageBaseUrl);
  } catch (error: any) {
    const defaultImageBaseUrl = "https://image.novelai.net";
    const status = error?.response?.status;
    if (
      (status === 401 || status === 403) &&
      imageBaseUrl !== defaultImageBaseUrl &&
      !strictQueue(execution) &&
      settings.allowCustomEndpointFallback
    ) {
      res = await postTo(defaultImageBaseUrl);
    } else {
      if (error?.response?.status === 500 && payload.action === "infill") {
        const width = Number(payload.parameters?.width);
        const height = Number(payload.parameters?.height);
        const sizeHint = inpaintSizeHint({ width, height });
        // The window's reason (step 4c1); NovelAI's own answer stays in the response (its upstream text).
        error.reason = sizeHint?.reason ?? "generation.inpaint_500";
        error.params = { ...(sizeHint?.params ?? {}), model: String(payload.model) };
        error.userMessage = `Inpaint failed (HTTP 500): NovelAI's inpaint answered with an internal error. ${sizeHint?.message ?? "It was not retried, to avoid generating or charging twice; switch the inpaint model, load the source again and repaint the mask, or try later."} Model: ${String(payload.model)}.`;
      }
      throw error;
    }
  }
  return extractImages(res.data);
}

type GenerationPreviewCallback = (
  event: Omit<GenerationPreviewEvent, "requestId">,
) => void;

function buildGenerateImageStreamHttpBody(
  payload: ReturnType<typeof buildPayload>,
) {
  // The streaming endpoint follows the official multipart shape even for a
  // plain text-to-image request: one JSON file part named `request`. Reference
  // images use a more involved cached-part protocol, so those requests stay on
  // the proven ZIP path below instead of risking a silently ignored reference.
  const form = new FormData();
  form.append("request", JSON.stringify(payload), {
    filename: "blob",
    contentType: "application/json",
  });
  return form;
}

function supportsSafeStreamTransport(
  payload: ReturnType<typeof buildPayload>,
) {
  const parameters = payload.parameters as Record<string, unknown>;
  return (
    payload.action === "generate" &&
    !parameters.image &&
    !parameters.mask &&
    !parameters.reference_image &&
    !(Array.isArray(parameters.reference_image_multiple) && parameters.reference_image_multiple.length > 0) &&
    !(Array.isArray(parameters.director_reference_images) && parameters.director_reference_images.length > 0) &&
    !(Array.isArray(parameters.director_reference_images_cached) && parameters.director_reference_images_cached.length > 0)
  );
}

function isStreamingNotAllowedMessage(value: unknown) {
  const text = String(value ?? "").toLowerCase();
  return (
    text.includes("streaming is not allowed") ||
    text.includes("streaming not allowed") ||
    text.includes("stream is not allowed") ||
    text.includes("stream not allowed")
  );
}

function imageDataUrl(buffer: Buffer) {
  const mime =
    buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      ? "image/png"
      : buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
        ? "image/jpeg"
        : buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP"
          ? "image/webp"
          : "image/png";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

async function readStreamErrorText(error: any): Promise<string> {
  const data = error?.response?.data;
  if (typeof data === "string") return data.slice(0, 65_536);
  if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
    return Buffer.from(data).subarray(0, 65_536).toString("utf8");
  }
  if (!data || typeof data[Symbol.asyncIterator] !== "function") {
    return String(error?.message ?? "");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of data as AsyncIterable<Uint8Array>) {
      if (length >= 65_536) break;
      const bytes = Buffer.from(chunk);
      const kept = bytes.subarray(0, 65_536 - length);
      chunks.push(kept);
      length += kept.length;
    }
  } catch {
    return String(error?.message ?? "");
  }
  return Buffer.concat(chunks).toString("utf8");
}

function orderedFinalImages(finals: Map<number, Buffer>): Buffer[] {
  return Array.from(finals.entries())
    .sort(([left], [right]) => left - right)
    .map(([, image]) => image);
}

function isRecoverableCompletedStreamClose(error: any): boolean {
  if (
    error?.naiStreamFrameError ||
    axios.isCancel(error) ||
    error?.code === "ERR_CANCELED" ||
    error?.code === "ABORT_ERR" ||
    error?.name === "AbortError"
  ) {
    return false;
  }
  const code = String(error?.code ?? "").toUpperCase();
  if (code === "ECONNRESET" || code === "ERR_STREAM_PREMATURE_CLOSE") return true;
  const message = String(error?.message ?? error ?? "").trim().toLowerCase();
  return (
    message === "aborted" ||
    message.includes("premature close") ||
    message.includes("socket hang up") ||
    message.includes("connection reset") ||
    message.includes("stream closed") ||
    message === "terminated"
  );
}

export async function consumeGenerateImageStream(
  responseStream: AsyncIterable<Uint8Array>,
  totalSteps: number,
  onPreview: GenerationPreviewCallback,
  contentType = "",
): Promise<Buffer[]> {
  const msgpackDecoder = new NaiStreamFrameDecoder();
  const sseDecoder = new NaiSseFrameDecoder();
  const finals = new Map<number, Buffer>();
  let mode: "unknown" | "msgpack" | "sse" | "zip" = contentType.toLowerCase().includes("text/event-stream")
    ? "sse"
    : "unknown";
  let prefix = Buffer.alloc(0);
  const zipChunks: Buffer[] = [];
  let previewStarted = false;
  let lastPreviewAt = 0;

  const consumeFrames = (frames: NaiStreamFrame[]) => {
    for (const frame of frames) {
      if (frame.error) {
        const frameError: Error & { naiStreamFrameError?: boolean } = new Error(frame.error);
        frameError.naiStreamFrameError = true;
        throw frameError;
      }
      if (!frame.image?.length) continue;
      previewStarted = true;
      const currentStep = (frame.stepIndex ?? 0) + 1;
      if (frame.eventType === "final") {
        finals.set(frame.sampleIndex, frame.image);
        onPreview({
          progress: 1,
          currentStep: totalSteps,
          totalSteps,
          sampleIndex: frame.sampleIndex,
          imageDataUrl: imageDataUrl(frame.image),
        });
      } else {
        const now = Date.now();
        if (now - lastPreviewAt >= 110 || currentStep >= totalSteps) {
          lastPreviewAt = now;
          onPreview({
            progress: Math.min(0.99, Math.max(0, currentStep / Math.max(1, totalSteps))),
            currentStep,
            totalSteps,
            sampleIndex: frame.sampleIndex,
            imageDataUrl: imageDataUrl(frame.image),
          });
        }
      }
    }
  };

  try {
    for await (const rawChunk of responseStream) {
      const chunk = Buffer.from(rawChunk);
      if (mode === "unknown") {
        prefix = prefix.length ? Buffer.concat([prefix, chunk]) : chunk;
        if (prefix.length < 4) continue;
        const textualPrefix = prefix.subarray(0, Math.min(prefix.length, 32)).toString("utf8").replace(/^\uFEFF/, "").trimStart();
        const framedLength = prefix.readUInt32BE(0);
        mode = prefix[0] === 0x50 && prefix[1] === 0x4b
          ? "zip"
          : /^(?:event|data|id|retry)\s*:|^:/.test(textualPrefix)
            ? "sse"
            : framedLength > 0 && framedLength <= 128 * 1024 * 1024
              ? "msgpack"
              : "sse";
        if (mode === "zip") zipChunks.push(prefix);
        else if (mode === "sse") consumeFrames(sseDecoder.push(prefix));
        else consumeFrames(msgpackDecoder.push(prefix));
        prefix = Buffer.alloc(0);
        continue;
      }

      if (mode === "zip") {
        zipChunks.push(chunk);
        continue;
      }
      if (mode === "sse") consumeFrames(sseDecoder.push(chunk));
      else consumeFrames(msgpackDecoder.push(chunk));
    }

    if (mode === "zip") return extractImages(Buffer.concat(zipChunks));
    if (mode === "sse") consumeFrames(sseDecoder.finish());
    if (finals.size === 0) {
      throw generationRefusal("generation.stream_no_image", "The stream ended without a final image; the request was not resent, to avoid charging twice.");
    }
    return orderedFinalImages(finals);
  } catch (error: any) {
    if (isRecoverableCompletedStreamClose(error)) {
      // Some Node/Axios transports emit `aborted`/ECONNRESET after the server's
      // complete final frame has already been decoded. The generation is paid
      // and valid at this point: preserve it instead of turning 100% into a
      // failure and discarding the image.
      if (mode === "sse") {
        try {
          consumeFrames(sseDecoder.finish());
        } catch (frameError: any) {
          if (previewStarted) frameError.streamPreviewStarted = true;
          throw frameError;
        }
      }
      if (mode === "zip" && zipChunks.length > 0) {
        try {
          const images = await extractImages(Buffer.concat(zipChunks));
          if (images.length > 0) {
            logInfo(`stream transport closed after complete ZIP; recovered ${images.length} image(s)`);
            return images;
          }
        } catch {
          // An incomplete archive is not recoverable; keep the original error.
        }
      }
      if (finals.size > 0) {
        logInfo(`stream transport closed after final frame; recovered ${finals.size} image(s)`);
        return orderedFinalImages(finals);
      }
    }
    if (previewStarted) error.streamPreviewStarted = true;
    throw error;
  }
}

/** Returns null only when the server explicitly rejects/doesn't implement
 * streaming before generation starts, allowing a safe one-time ZIP fallback. */
async function postGenerateImageStream(
  payload: ReturnType<typeof buildPayload>,
  signal: AbortSignal | undefined,
  onPreview: GenerationPreviewCallback,
): Promise<Buffer[] | null> {
  const token = getToken();
  if (!token) throw generationRefusal("generation.no_token", "Set up your NovelAI API token in Settings first.");
  const settings = getSettings();
  const configuredBaseUrl = tokenSafeBaseUrl(
    settings.imageBaseUrl,
    "https://image.novelai.net",
  );
  const postTo = async (baseUrl: string): Promise<Buffer[] | null> => {
    let response;
    try {
      response = await requestWithRetry(
        () => {
          const form = buildGenerateImageStreamHttpBody(payload);
          return axios.post(`${baseUrl}/ai/generate-image-stream`, form, {
            headers: {
              Authorization: `Bearer ${token}`,
              ...form.getHeaders(),
              Accept: "application/x-msgpack, text/event-stream, application/zip",
              "x-correlation-id": crypto.randomBytes(8).toString("base64url").slice(0, 6),
              "x-initiated-at": new Date().toISOString(),
            },
            responseType: "stream",
            timeout: 180_000,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            signal,
            ...proxyConfig("nai"),
          });
        },
        {
          signal,
          retryStatuses: [429],
          retryPreflightNetworkFailures: true,
        },
      );
    } catch (error: any) {
      const status = Number(error?.response?.status);
      const body = await readStreamErrorText(error);
      if (
        [404, 405, 415, 501].includes(status) ||
        isStreamingNotAllowedMessage(body) ||
        isStreamingNotAllowedMessage(error?.message)
      ) {
        logInfo(`stream preview unavailable; using ZIP response (HTTP ${status || "n/a"})`);
        return null;
      }
      if (body) {
        // NovelAI's text cleaned as everywhere else (responseError); the host's own reason texts pass unchanged.
        error.userMessage = cleanUpstreamText(compactRemoteErrorText(body, { maxLength: 420 }));
        if (error.response) error.response.data = error.userMessage;
      }
      throw error;
    }
    return consumeGenerateImageStream(
      response.data as AsyncIterable<Uint8Array>,
      Math.max(1, Number(payload.parameters?.steps) || 1),
      onPreview,
      String(response.headers?.["content-type"] ?? ""),
    ).catch((error: any) => {
      if (!error?.streamPreviewStarted && isStreamingNotAllowedMessage(error?.message)) return null;
      throw error;
    });
  };

  try {
    return await postTo(configuredBaseUrl);
  } catch (error: any) {
    const officialBaseUrl = "https://image.novelai.net";
    const status = error?.response?.status;
    if (
      (status === 401 || status === 403) &&
      configuredBaseUrl !== officialBaseUrl &&
      settings.allowCustomEndpointFallback
    ) {
      return postTo(officialBaseUrl);
    }
    throw error;
  }
}

async function postGenerateImageWithOptionalPreview(
  payload: ReturnType<typeof buildPayload>,
  signal: AbortSignal | undefined,
  onPreview?: GenerationPreviewCallback,
  execution?: GenerationExecutionOptions,
) {
  if (strictQueue(execution)) return postGenerateImage(payload, signal, execution);
  // A manual batch item streams its frames to the window like the manual generation it replaces.
  onPreview ??= execution?.onPreview;
  const settings = getSettings();
  if (
    onPreview &&
    settings.streamPreviewEnabled !== false &&
    supportsSafeStreamTransport(payload)
  ) {
    // A manual batch item reports the request as possibly submitted before it is sent, as the ZIP path does.
    if (execution) { signal?.throwIfAborted(); execution.onSubmitted?.(); }
    const streamed = await postGenerateImageStream(payload, signal, onPreview);
    if (streamed) return streamed;
  }
  return postGenerateImage(payload, signal, execution);
}

export function extractEmbeddedGenerationMetadata(buffer: Buffer): LoadImageResult["metadata"] | undefined {
  try {
    const bytes = Uint8Array.from(buffer);
    const report = inspectImageMetadata(parseImageMeta(bytes.buffer));
    if (!Object.keys(report.imported).length && !report.characterCaptions.length) return undefined;
    return {
      imported: report.imported,
      characterCaptions: report.characterCaptions,
    };
  } catch {
    // Metadata is optional. A malformed metadata block must not prevent the
    // image itself from loading into the workbench.
    return undefined;
  }
}

export async function loadImageFile(): Promise<LoadImageResult> {
  const result = await dialog.showOpenDialog({
    title: hostText("dialog.chooseImage"),
    filters: [{ name: hostText("dialog.imageFiles"), extensions: ["png", "jpg", "jpeg", "webp"] }],
    properties: ["openFile"],
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false };

  try {
    const filePath = result.filePaths[0];
    const buffer = await fs.readFile(filePath);
    const dims = readImageDimensions(buffer);
    workbenchImagePath = filePath;
    return {
      ok: true,
      image: {
        filePath,
        fileUrl: toLocalMediaUrl(filePath),
        width: dims.width,
        height: dims.height,
      },
      metadata: extractEmbeddedGenerationMetadata(buffer),
    };
  } catch (error: any) {
    return {
      ok: false,
      message: `Loading the image failed: ${error?.message ?? "unknown error"}`, reason: "generation.image_load_failed", params: { detail: String(error?.message ?? "") },
    };
  }
}

export function clearWorkbenchImage() {
  workbenchImagePath = null;
  return { ok: true };
}

/** Only the isolated workspace bridge's validated synchronous commit uses these. */
export function getBridgeWorkbenchPath() {
  return workbenchImagePath;
}

export function setBridgeWorkbenchPath(filePath: string | null) {
  workbenchImagePath = filePath;
}

export async function loadImageFromPath(
  filePath: string,
): Promise<LoadImageResult> {
  try {
    const buffer = await fs.readFile(filePath);
    const dims = readImageDimensions(buffer);
    workbenchImagePath = filePath;
    return {
      ok: true,
      image: {
        filePath,
        fileUrl: toLocalMediaUrl(filePath),
        width: dims.width,
        height: dims.height,
      },
      metadata: extractEmbeddedGenerationMetadata(buffer),
    };
  } catch (error: any) {
    return {
      ok: false,
      message: `Loading the image failed: ${error?.message ?? "unknown error"}`, reason: "generation.image_load_failed", params: { detail: String(error?.message ?? "") },
    };
  }
}

function invalidPromptAssemblyResult(params: unknown): GenerateResult | null {
  try {
    assertPromptAssemblyVersion(params);
    return null;
  } catch (error) {
    return {
      ok: false,
      message: `invalid_argument: ${error instanceof Error ? error.message : String(error)}`,
      items: [],
      statusCode: 422,
      failureKind: "validation",
    };
  }
}

export async function generateImage(
  params: GenerateParams,
  extras?: GenerateExtras,
  saveOptions?: {
    ignoreActiveGroup?: boolean;
    groupOverride?: { groupId: string; folderName: string };
    onPreview?: GenerationPreviewCallback;
  },
  execution?: GenerationExecutionOptions,
): Promise<GenerateResult> {
  const invalidAssembly = invalidPromptAssemblyResult(params);
  if (invalidAssembly) return invalidAssembly;
  assertQueueReferences(extras, execution);
  const characterSnapshot = snapshotCharacters(extras?.charCaptions ?? []);
  const frozenSaveOptions = queueGenerationSaveOptions(execution);
  // The record keeps what ran: Medium effort's fixed values, and the Medium model id (src/nai-effort.ts).
  const normalized = normalizeGenerateParams(params);
  const effort = applyNAIEffort(normalized, normalized.model);
  params = effort.params;
  const requestModel = naiRequestModel(params.model, effort.effort);
  const token = getToken();
  if (!token)
    return {
      ok: false,
      message: "Set up your NovelAI API token in Settings first.", reason: "generation.no_token",
      items: [],
    };
  if (!params.positivePrompt.trim())
    return { ok: false, message: "Enter a positive prompt.", reason: "generation.no_prompt", items: [] };

  // "fixed" mode honors the chosen seed; "random" (or seed<=0) rolls a new one.
  const useFixedSeed = params.seedMode !== "random" && params.seed >= 0;
  const actualSeed = useFixedSeed
    ? params.seed
    : crypto.randomInt(1, 2_147_483_647);
  const unsavable = refuseUnsavableHistory(generatedHistoryItem(PLANNED_FILE, undefined, params, actualSeed, requestModel, { ...frozenSaveOptions, characterSnapshot }));
  if (unsavable) return unsavable;

  logInfo(
    `generate: model=${requestModel} size=${params.width}x${params.height} steps=${params.steps} ` +
      `cfg=${params.cfgScale} vibe=${extras?.vibeImages?.length ?? 0} precise=${extras?.preciseReferences?.length ?? 0}`,
  );
  const job = beginJob(execution ? { signal: execution.signal, isolated: true } : undefined);

  try {
    const preparedExtras = await prepareExtras(
      params,
      extras,
      job.controller.signal,
    );
    const characterPrompts = normalizedCharCaptions(preparedExtras, params.model, params.preservePromptText, params.preservePromptText || params.promptAssemblyVersion === 1).map(character => character.prompt);
    const payload = buildPayload(params, actualSeed, preparedExtras);
    let buffers: Buffer[];
    try {
      buffers = await postGenerateImageWithOptionalPreview(
        payload,
        job.controller.signal,
        saveOptions?.onPreview,
        execution,
      );
    } catch (error: any) {
      if (
        strictQueue(execution) || error?.streamPreviewStarted ||
        !shouldRetryCharCaptionsAsPipe(error, params, preparedExtras)
      )
        throw error;
      const pipePayload = buildPayload(
        params,
        actualSeed,
        preparedExtras,
        "pipe",
      );
      buffers = await postGenerateImageWithOptionalPreview(
        pipePayload,
        job.controller.signal,
        saveOptions?.onPreview,
        execution,
      );
    }
    if (buffers.length === 0)
      return {
        ok: false,
        message: "The request succeeded but returned no image.", reason: "generation.empty_response",
        items: [],
      };
    const requestedGroup = resolveGenerationSaveGroup(extras?.historyGroupId);
    const ordinarySaveOptions = saveOptions?.groupOverride
      ? saveOptions
      : {
          ...saveOptions,
          ignoreActiveGroup: !requestedGroup,
          groupOverride: requestedGroup,
        };
    const items = await saveBuffers(
      buffers,
      params,
      actualSeed,
      "t2i",
      requestModel,
      { ...(frozenSaveOptions ?? ordinarySaveOptions), characterSnapshot, characterPrompts },
    );
    if (!strictQueue(execution)) void refreshStoredAccount();
    return {
      ok: true,
      message: `生成完成，已保存 ${items.length} 张图片。`,
      items,
      actualSeed,
    };
  } catch (error: any) {
    return handleGenerateError(error, "t2i");
  } finally {
    job.end();
  }
}

export async function generateI2I(
  params: GenerateParams,
  i2i: I2IParams,
  extras?: GenerateExtras,
  execution?: GenerationExecutionOptions,
): Promise<GenerateResult> {
  const invalidAssembly = invalidPromptAssemblyResult(params);
  if (invalidAssembly) return invalidAssembly;
  assertQueueReferences(extras, execution);
  const characterSnapshot = snapshotCharacters(extras?.charCaptions ?? []);
  const frozenSaveOptions = queueGenerationSaveOptions(execution);
  const maxEnhance = i2i?.upscaledEnhance === true;
  // Enhance (Max✨ included) always runs High: Medium effort is a txt2img/img2img/inpaint setting only.
  const normalized = normalizeGenerateParams(params);
  const effort = applyNAIEffort(normalized, maxEnhance ? "" : normalized.model);
  params = effort.params;
  const requestModel = naiRequestModel(params.model, effort.effort);
  const token = getToken();
  if (!token) return { ok: false, message: "Set up your NovelAI API token in Settings first.", reason: "generation.no_token", items: [] };
  if (maxEnhance && !supportsNAIMaxEnhance(params.model)) return { ok: false, message: "Enhance Max✨ exists only for the V5 models.", reason: "generation.max_enhance_model", items: [], failureKind: "validation" };
  if (!params.positivePrompt.trim())
    return { ok: false, message: "Enter a positive prompt.", reason: "generation.no_prompt", items: [] };
  if (!execution?.sourceBytes && !workbenchImagePath)
    return { ok: false, message: "Load an image first.", reason: "generation.no_source", items: [] };
  const actualSeed =
    params.seedMode !== "random" && params.seed >= 0
      ? params.seed
      : crypto.randomInt(1, 2_147_483_647);
  const unsavable = refuseUnsavableHistory(generatedHistoryItem(PLANNED_FILE, undefined, params, actualSeed, requestModel, { ...frozenSaveOptions, characterSnapshot }));
  if (unsavable) return unsavable;
  logInfo(
    `img2img: model=${requestModel} size=${params.width}x${params.height} strength=${i2i?.strength}${maxEnhance ? " enhance=max" : ""}`,
  );

  const job = beginJob(execution ? { signal: execution.signal, isolated: true } : undefined);

  try {
    const preparedExtras = await prepareExtras(
      params,
      extras,
      job.controller.signal,
    );
    const characterPrompts = normalizedCharCaptions(preparedExtras, params.model, params.preservePromptText, params.preservePromptText || params.promptAssemblyVersion === 1).map(character => character.prompt);
    // Resize the source to the requested output dimensions — NovelAI's img2img
    // expects the input image to match width×height; sending an arbitrary size
    // risks a 400/500 or a misaligned composition.
    // Frozen bytes are the bound original; nativeImage gets a PNG derivative of a WebP (PNG/JPEG pass through).
    const workbenchBuffer = execution?.sourceBytes ? await nativeImageInput(execution.sourceBytes) : (await readWorkbenchImage()).buffer;
    const base64Image = resizeImageBufferToPng(
      workbenchBuffer,
      params.width,
      params.height,
    ).toString("base64");
    const applyI2I = (payload: ReturnType<typeof buildPayload>) => applyI2IParameters(
      payload, base64Image, i2i,
      i2i.extraNoiseSeed > 0 ? i2i.extraNoiseSeed : crypto.randomInt(1, 2_147_483_647),
    );

    let buffers: Buffer[];
    try {
      buffers = await postGenerateImage(
        applyI2I(buildPayload(params, actualSeed, preparedExtras)),
        job.controller.signal,
        execution,
      );
    } catch (error: any) {
      if (strictQueue(execution) || !shouldRetryCharCaptionsAsPipe(error, params, preparedExtras))
        throw error;
      buffers = await postGenerateImage(
        applyI2I(buildPayload(params, actualSeed, preparedExtras, "pipe")),
        job.controller.signal,
        execution,
      );
    }
    if (buffers.length === 0)
      return { ok: false, message: "The request succeeded but returned no image.", reason: "generation.empty_response", items: [] };
    const items = await saveBuffers(buffers, params, actualSeed, "i2i", requestModel, { ...frozenSaveOptions, characterSnapshot, characterPrompts, ...(maxEnhance ? { measureImageSize: true } : {}) });
    if (!strictQueue(execution)) void refreshStoredAccount();
    return {
      ok: true,
      message: `图生图完成，已保存 ${items.length} 张图片。`,
      items,
      actualSeed,
    };
  } catch (error: any) {
    return handleGenerateError(error, "i2i");
  } finally {
    job.end();
  }
}

export async function inpaintImage(
  params: GenerateParams,
  inpaintModel: NAIInpaintModel,
  maskBase64: string,
  strength = 1,
  noise = 0,
  execution?: GenerationExecutionOptions,
): Promise<GenerateResult> {
  const invalidAssembly = invalidPromptAssemblyResult(params);
  if (invalidAssembly) return invalidAssembly;
  const frozenSaveOptions = queueGenerationSaveOptions(execution);
  // Inpaint's effort follows the inpainting model (V5 Full inpainting has Medium); the record keeps what ran.
  const effort = applyNAIEffort(normalizeGenerateParams(params), inpaintModel);
  params = effort.params;
  const token = getToken();
  if (!token) return { ok: false, message: "Set up your NovelAI API token in Settings first.", reason: "generation.no_token", items: [] };
  if (!params.positivePrompt.trim())
    return { ok: false, message: "Enter a positive prompt.", reason: "generation.no_prompt", items: [] };
  if (!execution?.sourceBytes && !workbenchImagePath)
    return { ok: false, message: "Load an image first.", reason: "generation.no_source", items: [] };
  if (!maskBase64)
    return { ok: false, message: "Paint the area to inpaint first.", reason: "generation.no_mask", items: [] };

  const job = beginJob(execution ? { signal: execution.signal, isolated: true } : undefined);

  try {
    const buffer = execution?.sourceBytes ? await nativeImageInput(execution.sourceBytes) : (await readWorkbenchImage()).buffer;
    const preparedAssets = prepareInpaintAssets(buffer, maskBase64);
    const actualSeed =
      params.seedMode !== "random" && params.seed >= 0
        ? params.seed
        : crypto.randomInt(1, 2_147_483_647);
    const normalizedStrength = Math.max(
      0,
      Math.min(1, Number.isFinite(strength) ? strength : 1),
    );
    // Retain the argument and transport field for backward compatibility while
    // intentionally pinning the removed UI control to zero.
    void noise;
    const normalizedNoise = 0;
    const buildInpaintPayload = (model: NAIInpaintModel) => {
      const inpaintParams: PayloadParams = {
        ...params,
        model,
        width: preparedAssets.width,
        height: preparedAssets.height,
      };
      const historyParams: GenerateParams = {
        ...params,
        width: preparedAssets.width,
        height: preparedAssets.height,
      };
      const payload = buildPayload(inpaintParams, actualSeed);
      payload.action = "infill";
      applyOfficialInpaintParameters(
        payload.parameters,
        preparedAssets,
        normalizedStrength,
        normalizedNoise,
        actualSeed,
      );
      return { payload, historyParams, model: naiRequestModel(model, effort.effort) };
    };

    let chosen: ReturnType<typeof buildInpaintPayload> | null = null;
    let buffers: Buffer[] | null = null;
    let lastError: any = null;
    // Medium runs exactly its own model; the compatibility fallback is for the curated models.
    const candidates = strictQueue(execution) || effort.effort === "medium" ? [inpaintModel] : inpaintModelCandidates(inpaintModel);
    // Every candidate saves the same parameters; only the record's model name differs.
    const planned = buildInpaintPayload(candidates[0]);
    const unsavable = refuseUnsavableHistory(generatedHistoryItem(PLANNED_FILE, undefined, planned.historyParams, actualSeed, planned.model, { ...frozenSaveOptions, characterSnapshot: snapshotCharacters([]), characterPrompts: [] }));
    if (unsavable) return unsavable;
    for (let index = 0; index < candidates.length; index += 1) {
      chosen = buildInpaintPayload(candidates[index]);
      try {
        buffers = await postGenerateImage(
          chosen.payload,
          job.controller.signal,
          execution,
        );
        break;
      } catch (error: any) {
        lastError = error;
        // Only retry when the server explicitly rejects the selected inpaint
        // model. A paid request that reaches a 5xx may already have run, so a
        // broad server-error retry can duplicate both generation and charge.
        const retryable = isInpaintModelCompatibilityError(error);
        if (!retryable || index >= candidates.length - 1) {
          annotateInpaintError(error, preparedAssets, candidates[index]);
          throw error;
        }
      }
    }
    if (!chosen || !buffers)
      throw lastError ?? generationRefusal("generation.inpaint_no_result", "The inpaint request returned no result.");
    if (buffers.length === 0)
      return { ok: false, message: "The request succeeded but returned no image.", reason: "generation.empty_response", items: [] };
    const diagnosticsEnabled = process.env.NOVELAI_INPAINT_DIAGNOSTICS === "1";
    let diagnostics = await beginInpaintDiagnosticCapture({
      enabled: diagnosticsEnabled,
      rootDir: diagnosticsEnabled ? path.join(app.getPath("userData"), "inpaint-diagnostics") : "",
      request: chosen.payload,
      sourcePng: preparedAssets.sourcePng,
      requestMaskPng: Buffer.from(preparedAssets.maskBase64, "base64"),
      blendAlpha: preparedAssets.blendAlpha,
      width: preparedAssets.width,
      height: preparedAssets.height,
      rawBuffers: buffers,
      jobId: execution?.provenance?.jobId,
    });
    if (diagnostics.status === "saved") logInfo(`Inpaint diagnostic raw response saved: ${diagnostics.directory}`);
    const outputBuffers = compositeInpaintBuffers(buffers, preparedAssets);
    diagnostics = await finishInpaintDiagnosticCapture(diagnostics, outputBuffers);
    const items = await saveBuffers(
      outputBuffers,
      chosen.historyParams,
      actualSeed,
      "inpaint",
      chosen.model,
      { ...frozenSaveOptions, characterSnapshot: snapshotCharacters([]), characterPrompts: [] },
    );
    if (!strictQueue(execution)) void refreshStoredAccount();
    const resizedNote = preparedAssets.resized
      ? `已按官网规则自适应尺寸 ${preparedAssets.originalWidth}×${preparedAssets.originalHeight} → ${preparedAssets.width}×${preparedAssets.height}。`
      : "";
    const diagnosticNote = diagnostics.status === "saved" ? "本地重绘诊断已保存。" : diagnostics.status === "failed" ? "本地重绘诊断写入失败，生成结果不受影响。" : "";
    return {
      ok: true,
      message: `重绘完成，已保存 ${items.length} 张图片。${resizedNote}${diagnosticNote}`,
      items,
      actualSeed,
    };
  } catch (error: any) {
    return handleGenerateError(error, "inpaint");
  } finally {
    job.end();
  }
}

/** Decode before saving and report actual response dimensions, including every candidate.
 * Legacy HistoryItem requires a numeric seed; the process ledger explicitly exposes
 * null for these seedless operations instead of treating this compatibility 0 as real.
 */
/** The parameters a postprocess image (upscale, director) is saved with in its history record. */
const postprocessHistoryParams = (prefix: string, width: number, height: number): GenerateParams => ({ ...DEFAULT_PARAMS, positivePrompt: prefix, width, height });

async function savePostprocessBuffers(buffers: Buffer[], prefix: string, model: string, saveOptions: ReturnType<typeof queueGenerationSaveOptions>) {
  const decoded = buffers.map(buffer => {
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) throw generationRefusal("generation.post_undecodable", "The image the post-processing returned cannot be decoded.");
    return { buffer, ...image.getSize() };
  });
  const items: HistoryItem[] = [];
  for (const output of decoded) items.push(...await saveBuffers(
    [output.buffer], postprocessHistoryParams(prefix, output.width, output.height),
    0, prefix, model, saveOptions,
  ));
  return items;
}

/** The history record of a manual upscale (its own save path in upscaleImg). */
function manualUpscaleHistoryItem(file: { id: string; filePath: string; fileUrl: string; date: string; createdAt: string }, groupId: string | undefined, width: number, height: number, feature?: string): HistoryItem {
  return {
    ...file,
    params: {
      ...DEFAULT_PARAMS,
      width,
      height,
      positivePrompt: "upscale",
    },
    actualSeed: 0,
    model: "upscale",
    width,
    height,
    groupId,
    ...(feature ? { feature } : {}),
  };
}

export async function upscaleImg(
  scale: UpscaleScale,
  model: string,
  execution?: GenerationExecutionOptions,
): Promise<SingleImageResult & Pick<GenerateResult, "failureKind" | "statusCode" | "errorCode" | "reason" | "params">> {
  const token = getToken();
  if (!token) return { ok: false, message: "Set up your NovelAI API token in Settings first.", reason: "generation.no_token" };
  if (strictQueue(execution) && scale !== 2) return { ok: false, message: "A queued upscale is one 2× request.", reason: "generation.queue_upscale_2x", failureKind: "validation" };
  if (execution ? !execution.sourceBytes : !workbenchImagePath) return { ok: false, message: "Load an image first.", reason: "generation.no_source" };
  logInfo(`upscale: scale=${scale}x`);

  const job = beginJob(execution ? { signal: execution.signal, isolated: true } : undefined);
  const saveOptions = queueGenerationSaveOptions(execution);
  const abort = job.controller;

  try {
    // A WebP source is sent as its PNG derivative (nativeImage decodes PNG/JPEG only), also when no downscale is needed.
    const { buffer, image } = execution?.sourceBytes ? { buffer: await nativeImageInput(Buffer.from(execution.sourceBytes)), image: readImageDimensions(execution.sourceBytes) } : await readWorkbenchImage();
    if (!image.width || !image.height) {
      return { ok: false, message: "The image size cannot be read; load the image again.", reason: "generation.source_size_unreadable" };
    }
    const preparedImage = prepareLimitedImage(
      buffer,
      MAX_NAI_UPSCALE_INPUT_PIXELS,
    );
    const outputSize = resolveUpscaleOutputSize(
      preparedImage.width,
      preparedImage.height,
      scale,
    );
    if (outputSize.exceedsLimit) {
      return {
        ok: false,
        message: `The upscaled image would be ${outputSize.width}×${outputSize.height}, larger than the maximum ${MAX_NAI_UPSCALE_OUTPUT_DIMENSION}×${MAX_NAI_UPSCALE_OUTPUT_DIMENSION}; nothing was sent. Use 2× or a smaller image.`,
        reason: "generation.upscale_too_large", params: { width: outputSize.width, height: outputSize.height, max: MAX_NAI_UPSCALE_OUTPUT_DIMENSION },
      };
    }
    const upscaleModel = resolveUpscaleModel(model);
    const unsavable = refuseUnsavableHistory(strictQueue(execution)
      ? generatedHistoryItem(PLANNED_FILE, undefined, postprocessHistoryParams("upscale", outputSize.width, outputSize.height), 0, upscaleModel, saveOptions)
      : manualUpscaleHistoryItem(PLANNED_FILE, undefined, outputSize.width, outputSize.height));
    if (unsavable) return { ok: false, message: unsavable.message, failureKind: unsavable.failureKind, errorCode: unsavable.errorCode };
    const settings = getSettings();
    // The dedicated upscaler is served by image.novelai.net and returns a ZIP
    // archive (same as generate-image), not a raw PNG.
    const imageBaseUrl = resolveUpscaleBaseUrl(settings.imageBaseUrl);
    const passes = scale === 4 ? 2 : 1;
    let passInput = Buffer.from(preparedImage.base64, "base64");
    let outBuffer = passInput;
    for (let pass = 0; pass < passes; pass += 1) {
      const res = await requestWithRetry(
        () => {
          execution?.signal.throwIfAborted();
          execution?.onSubmitted?.();
          return axios.post(
            `${imageBaseUrl}/ai/upscale`,
            buildUpscalePayload(passInput, upscaleModel),
            {
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                Accept: "application/zip, application/octet-stream, image/png",
              },
              ...(strictQueue(execution) ? { maxRedirects: 0 } : {}),
              responseType: "arraybuffer",
              timeout: 180_000,
              signal: abort.signal,
              ...proxyConfig("nai"),
            },
          );
        },
        // Paid upscale POST — only retry pre-charge 429s, never 5xx.
        { signal: abort.signal, retryStatuses: [429], ...(strictQueue(execution) ? { retries: 0 } : {}) },
      );

      // Response is usually a ZIP containing the upscaled PNG; fall back to raw bytes.
      try {
        const images = await extractImages(res.data);
        outBuffer = images.length > 0 ? images[0] : Buffer.from(res.data);
      } catch {
        outBuffer = Buffer.from(res.data); // not a zip — treat as raw image bytes
      }
      if (outBuffer.length === 0) break;
      passInput = outBuffer;
    }
    if (outBuffer.length === 0) {
      return { ok: false, message: "The request succeeded but returned no image.", reason: "generation.empty_response" };
    }

    if (strictQueue(execution)) {
      const items = await savePostprocessBuffers([outBuffer], "upscale", upscaleModel, saveOptions);
      return { ok: true, message: "单次超分完成。", item: items[0] };
    }
    const now = new Date();
    const date = dateStamp(now);
    // A manual batch item saves into the group and after the source name frozen at its click.
    const activeGroup = execution?.manual ? saveOptions?.groupOverride : resolveGenerationSaveGroup();
    const sourceName = execution?.manual ? execution.sourceName ?? "source" : workbenchImagePath ?? "source";
    const dir = activeGroup
      ? path.join(settings.outputDir, date, activeGroup.folderName)
      : path.join(settings.outputDir, date);
    await fs.mkdir(dir, { recursive: true });
    const baseName = path
      .basename(sourceName, path.extname(sourceName))
      .replace(/[^\w.-]+/g, "-");
    const filePath = path.join(
      dir,
      `${now.getTime()}-upscale${scale}x-${baseName}.png`,
    );
    const savedBuffer = prepareImageBufferForSave(outBuffer, settings.keepImageMetadata !== false);
    const outDims = readImageDimensions(outBuffer);
    const outWidth = outDims.width || preparedImage.width * scale;
    const outHeight = outDims.height || preparedImage.height * scale;
    const item = manualUpscaleHistoryItem({ id: crypto.randomUUID(), filePath, fileUrl: toLocalMediaUrl(filePath), date, createdAt: now.toISOString() }, activeGroup?.groupId, outWidth, outHeight, execution?.manual ? execution.generationMode : undefined);
    const repo = activeLibrary();
    const operation = repo && beginLibraryFileOperation(repo, 'create', { kind: 'history', id: item.id, item, target: filePath, byteLength: savedBuffer.length, sha256: crypto.createHash('sha256').update(savedBuffer).digest('hex') });
    await fs.writeFile(filePath, savedBuffer, { flag: 'wx' });
    saveGeneratedHistory([item]);
    if (repo && operation) repo.completeFileOperation(operation);
    void refreshStoredAccount();
    const resizeNote = preparedImage.resized
      ? `原图 ${preparedImage.originalWidth}×${preparedImage.originalHeight} 超过 NovelAI 超分输入上限，已先缩至 ${preparedImage.width}×${preparedImage.height} 后执行。`
      : "";
    return { ok: true, message: `超分 ${scale}x 完成。${resizeNote}`, item };
  } catch (error: any) {
    if (execution) {
      const { items: _items, ...failure } = handleGenerateError(error, "upscale");
      return failure;
    }
    if (axios.isCancel(error) || error?.code === "ERR_CANCELED")
      return { ok: false, message: "The operation was cancelled.", reason: "generation.cancelled" };
    const status = error?.response?.status;
    const remote = responseError(error);
    const detail = remote.text;
    const tooLarge = /resolution too high/i.test(detail);
    const hint = tooLarge ? "NovelAI upscales inputs of up to about 1024×1024 in area; the app shrinks larger images and tries again, so if it still fails use a smaller image." : "";
    return {
      ok: false,
      message: `Upscale failed${status ? ` (HTTP ${status})` : ""}: ${detail}${hint ? ` ${hint}` : ""}`,
      ...remoteFailureReason(remote, status) ?? (tooLarge
        ? { reason: "generation.upscale_resolution", params: { ...httpParams(status), detail } }
        : { reason: "generation.failed_upscale", params: { ...httpParams(status), detail } }),
    };
  } finally {
    job.end();
  }
}

export async function augmentImg(
  tool: DirectorTool,
  options: AugmentOptions,
  execution?: GenerationExecutionOptions,
): Promise<GenerateResult> {
  const token = getToken();
  if (!token) return { ok: false, message: "Set up your NovelAI API token in Settings first.", reason: "generation.no_token", items: [] };
  if (execution ? !execution.sourceBytes : !workbenchImagePath)
    return { ok: false, message: "Load an image first.", reason: "generation.no_source", items: [] };
  logInfo(`director: tool=${tool}`);

  options = { ...options };
  const job = beginJob(execution ? { signal: execution.signal, isolated: true } : undefined);
  const saveOptions = queueGenerationSaveOptions(execution);

  try {
    // A WebP source is sent as its PNG derivative (nativeImage decodes PNG/JPEG only), also when no downscale is needed.
    const { buffer, image } = execution?.sourceBytes ? { buffer: await nativeImageInput(Buffer.from(execution.sourceBytes)), image: readImageDimensions(execution.sourceBytes) } : await readWorkbenchImage();
    if (!image.width || !image.height) {
      return {
        ok: false,
        message: "The image size cannot be read; load the image again.",
        reason: "generation.source_size_unreadable",
        items: [],
      };
    }
    const preparedImage = prepareLimitedImage(
      buffer,
      MAX_NAI_DIRECTOR_INPUT_PIXELS,
      {
        flattenAlpha: true,
        forcePng: true,
      },
    );
    const settings = getSettings();
    const imageBaseUrl = tokenSafeBaseUrl(
      settings.imageBaseUrl,
      "https://image.novelai.net",
    );
    const payload = buildDirectorPayload(preparedImage, tool, options);
    const historyParams: GenerateParams = postprocessHistoryParams(`director:${tool}`, preparedImage.originalWidth, preparedImage.originalHeight);
    const unsavable = refuseUnsavableHistory(strictQueue(execution)
      ? generatedHistoryItem(PLANNED_FILE, undefined, postprocessHistoryParams(`director-${tool}`, preparedImage.originalWidth, preparedImage.originalHeight), 0, `director-${tool}`, saveOptions)
      : generatedHistoryItem(PLANNED_FILE, undefined, historyParams, 0, `director-${tool}`, saveOptions));
    if (unsavable) return unsavable;

    execution?.signal.throwIfAborted();
    execution?.onSubmitted?.();
    const res = await axios.post(`${imageBaseUrl}/ai/augment-image`, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/zip, application/octet-stream",
      },
      ...(strictQueue(execution) ? { maxRedirects: 0 } : {}),
      responseType: "arraybuffer",
      timeout: 180_000,
      signal: job.controller.signal,
      ...proxyConfig("nai"),
    });

    const buffers = await extractImages(res.data);
    if (buffers.length === 0)
      return { ok: false, message: "The request succeeded but returned no image.", reason: "generation.empty_response", items: [] };
    const outputBuffers = preparedImage.resized
      ? buffers.map((buffer) =>
          resizeImageBufferToPng(
            buffer,
            preparedImage.originalWidth,
            preparedImage.originalHeight,
          ),
        )
      : buffers;
    const items = strictQueue(execution) ? await savePostprocessBuffers(outputBuffers, `director-${tool}`, `director-${tool}`, saveOptions) : await saveBuffers(
      outputBuffers,
      historyParams,
      0,
      `director-${tool}`,
      `director-${tool}`,
      saveOptions,
    );
    if (!strictQueue(execution)) void refreshStoredAccount();
    const resizeNote = preparedImage.resized
      ? `原图 ${preparedImage.originalWidth}×${preparedImage.originalHeight} 超过后期接口稳态尺寸，已先缩至 ${preparedImage.width}×${preparedImage.height} 处理，并恢复到原尺寸。`
      : "";
    return {
      ok: true,
      message: `后期处理完成，已保存 ${items.length} 张图片。${resizeNote}`,
      items,
    };
  } catch (error: any) {
    return handleGenerateError(error, "director");
  } finally {
    job.end();
  }
}

// Only treat a 400/422 as a reference problem when the server error actually
// names a reference field. A generic 400 (bad size, model, prompt, etc.) must
// NOT be classified as "reference", otherwise a caller that retries without
// references would fire a second *paid* reference-less retry that both wastes Anlas and hides the
// real cause.
function looksLikeReferenceError(detail: string): boolean {
  return /reference|vibe|director_reference|encode|information_extracted|controlnet/i.test(
    detail,
  );
}

/** The HTTP status of a failure as the window's catalog shows it: "（HTTP 400）" in Chinese, " (HTTP 400)" in English; empty without one. */
export const httpParams = (status: unknown): Record<string, string | number> => Number.isInteger(status) ? { status: status as number, httpZh: `（HTTP ${status}）`, httpEn: ` (HTTP ${status})` } : { httpZh: "", httpEn: "" };
/** What failed, in the window's catalog (generation.failed_<action>) and in the English message. */
type GenerationAction = "t2i" | "i2i" | "inpaint" | "upscale" | "director";
const ACTION_TEXT: Record<GenerationAction, string> = { t2i: "Image generation", i2i: "Img2img", inpaint: "Inpaint", upscale: "Upscale", director: "Post-processing" };

function handleGenerateError(error: any, action: GenerationAction): GenerateResult {
  if (axios.isCancel(error) || error?.code === "ERR_CANCELED") {
    return {
      ok: false,
      message: "The operation was cancelled.",
      reason: "generation.cancelled",
      items: [],
      failureKind: "cancelled",
    };
  }
  const status = error?.response?.status;
  const remote = responseError(error);
  const detail = remote.text;
  logError(`${ACTION_TEXT[action]} failed${status ? ` (HTTP ${status})` : ""}`, detail);
  // What NovelAI answered (an HTTP response only, never a local error's text), cleaned: an agent item keeps it for
  // the window's queue page (generation-service.ts; step 4c1).
  const upstream = upstreamOf(error, remote);
  const failureKind =
    status === 401 || status === 403
      ? "auth"
      : status === 400 || status === 422
        ? looksLikeReferenceError(detail)
          ? "reference"
          : "validation"
        : status
          ? "api"
          : "validation";
  if (failureKind === "auth") {
    return {
      ok: false,
      message: `NovelAI authentication failed${status ? ` (HTTP ${status})` : ""}: paste and verify your Persistent API Token again in Settings, and check that the Image Endpoint is https://image.novelai.net.`,
      reason: "generation.auth", params: httpParams(status),
      items: [], failureKind, statusCode: status, ...(upstream ? { upstream } : {}),
    };
  }
  // HTTP 402: NovelAI refused to charge (not enough Anlas, or the subscription does not cover the request).
  if (status === 402) {
    return {
      ok: false,
      message: `${ACTION_TEXT[action]} failed (HTTP 402): not enough Anlas or subscription: ${detail}`,
      reason: "generation.payment_required", params: { ...httpParams(status), detail },
      items: [], failureKind, statusCode: status, ...(upstream ? { upstream } : {}),
    };
  }
  // A failure the host named itself (generationRefusal, or a reason put on the request's error, e.g. an inpaint 500).
  const own = typeof error?.reason === "string" && error.reason ? { reason: error.reason as string, params: { ...httpParams(status), ...(error.params && typeof error.params === "object" ? error.params : {}) } } : undefined;
  return {
    ok: false,
    message: own && typeof error?.userMessage === "string" && error.userMessage ? error.userMessage : own && !error?.response ? String(error.message) : `${ACTION_TEXT[action]} failed${status ? ` (HTTP ${status})` : ""}: ${detail}`,
    // No readable upstream message (an unavailable service, an error page, nothing): the window renders that reason
    // in its language instead of an English detail (step 4c1).
    ...own ?? remoteFailureReason(remote, status) ?? { reason: `generation.failed_${action}`, params: { ...httpParams(status), detail } },
    items: [],
    failureKind,
    statusCode: status,
    ...(upstream ? { upstream } : {}),
  };
}

/** NovelAI's answer to a failed request, cleaned (electron/upstream-reason.ts), or undefined without an HTTP answer. */
function upstreamOf(error: any, remote: RemoteError): UpstreamReason | undefined {
  if (!error?.response) return undefined;
  const status = Number(error.response.status);
  const value: UpstreamReason = { ...(Number.isInteger(status) ? { status } : {}) };
  if (remote.reason) { value.reason = remote.reason; if (remote.params) value.params = { ...remote.params }; }
  // responseError has cleaned it already; cleaning again changes nothing and keeps this the one place that bounds it.
  else { const message = cleanUpstreamText(remote.text); if (message) value.message = message; }
  return value.status !== undefined || value.reason || value.message ? value : undefined;
}

/** The reason and params of a failure without a readable upstream message, or undefined when it has one. */
function remoteFailureReason(remote: RemoteError, status: unknown): { reason: string; params: Record<string, string | number> } | undefined {
  if (remote.reason === "remote.failed") return { reason: "generation.request_failed", params: httpParams(status) };
  if (remote.reason) return { reason: remote.reason, params: { ...httpParams(status), ...remote.params } };
  return undefined;
}


function localSuggestTags(prompt: string): TagSuggestion[] {
  const query = prompt.trim().toLowerCase().replace(/_/g, " ");
  if (!query) return [];
  const isCjk = /[㐀-鿿]/.test(query);

  return TAG_DICTIONARY.map((item) => {
    // Chinese input matches Chinese keywords; latin input matches tag/aliases.
    const terms = isCjk
      ? [item.zh, ...(item.keywords ?? [])]
      : [item.tag, ...(item.aliases ?? [])].map((x) =>
          x.toLowerCase().replace(/_/g, " "),
        );
    let score = 0;
    for (const term of terms) {
      const t = term.toLowerCase();
      if (t === query) score = Math.max(score, 3);
      else if (t.startsWith(query)) score = Math.max(score, 2);
      else if (t.includes(query)) score = Math.max(score, 1);
    }
    return { item, score };
  })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.item.count - a.item.count)
    .slice(0, 12)
    .map(({ item }) => ({
      tag: item.tag,
      count: item.count,
      category: item.category,
      description: item.zh,
    }));
}

/** Tag autocomplete — calls NAI suggest-tags endpoint, with local fallback when API is unavailable. */
export async function suggestTags(
  model: string,
  prompt: string,
): Promise<TagSuggestion[]> {
  const token = getToken();
  if (!prompt.trim()) return [];
  const fallback = localSuggestTags(prompt);
  if (!token) return fallback;
  const settings = getSettings();
  const apiBaseUrl = tokenSafeBaseUrl(
    settings.apiBaseUrl,
    "https://api.novelai.net",
  );
  try {
    const res = await axios.get(
      `${apiBaseUrl}/ai/generate-image/suggest-tags`,
      {
        params: { model, prompt },
        headers: { Authorization: `Bearer ${token}` },
        timeout: 5000,
        ...proxyConfig("nai"),
      },
    );
    const tags = (res.data?.tags ?? []) as TagSuggestion[];
    return tags.length > 0 ? tags : fallback;
  } catch {
    return fallback;
  }
}
