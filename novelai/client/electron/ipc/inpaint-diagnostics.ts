import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import sharp from "sharp";

export interface InpaintDiagnosticCaptureOptions {
  enabled: boolean;
  rootDir: string;
  request: { input: unknown; model: unknown; action: unknown; parameters: unknown };
  sourcePng: Buffer;
  requestMaskPng: Buffer;
  blendAlpha: Uint8Array;
  width: number;
  height: number;
  rawBuffers: Buffer[];
  jobId?: string;
}

export interface InpaintDiagnosticCaptureHandle {
  status: "disabled" | "saved" | "failed";
  directory?: string;
}

type JsonRecord = Record<string, unknown>;
interface ImageRecord {
  file: string;
  bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
  decoded: boolean;
}
interface Manifest {
  schemaVersion: 1;
  captureId: string;
  stage: "pre-composite" | "complete";
  createdAt: string;
  completedAt?: string;
  jobId?: string;
  request: JsonRecord;
  processing: { width: number; height: number };
  files: { source: ImageRecord; requestMask: ImageRecord; blendAlpha: ImageRecord; raw: ImageRecord[]; composite?: ImageRecord[] };
}

// Keep internal state out of the public handle and never trust a caller-supplied
// directory as permission to write. No account or settings object is accepted.
const captures = new WeakMap<InpaintDiagnosticCaptureHandle, { directory: string; manifest: Manifest }>();
const numericParameters = new Set([
  "params_version", "width", "height", "scale", "steps", "n_samples", "seed",
  "cfg_rescale", "uncond_scale", "ucPreset", "uc_preset", "extra_noise_seed",
  "inpaintImg2ImgStrength", "strength", "noise", "skip_cfg_above_sigma",
  "skip_cfg_below_sigma", "tag_hint_qt", "tag_hint_uc_preset",
  "dynamic_thresholding_percentile", "dynamic_thresholding_mimic_scale",
]);
const booleanParameters = new Set([
  "legacy", "legacy_v3_extend", "dynamic_thresholding", "qualityToggle", "quality_toggle",
  "sm", "sm_dyn", "deliberate_euler_ancestral_bug", "prefer_brownian", "use_coords",
  "add_original_image", "tag_hint_transparent_background", "straight_alpha", "quality_boost",
  "explike_fine_detail", "minimize_sigma_inf", "uncond_per_vibe", "wonky_vibe_correlation",
]);
const enumParameters: Record<string, readonly string[]> = {
  sampler: ["k_euler", "k_euler_ancestral", "k_dpmpp_2s_ancestral", "k_dpmpp_2m", "k_dpmpp_sde", "k_dpmpp_2m_sde", "ddim_v3"],
  noise_schedule: ["native", "karras", "exponential", "polyexponential"],
  qualityPresetId: ["none", "standard", "light"],
  cfg_sched_eligibility: ["enable_for_post_summer_samplers", "enable", "disable"],
};

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function caption(value: unknown): JsonRecord {
  const source = record(value), output: JsonRecord = {}, content = record(source.caption);
  for (const key of ["use_coords", "use_order", "legacy_uc"]) if (typeof source[key] === "boolean") output[key] = source[key];
  const clean: JsonRecord = {};
  if (typeof content.base_caption === "string") clean.base_caption = content.base_caption;
  if (Array.isArray(content.char_captions)) clean.char_captions = content.char_captions.map(value => {
    const item = record(value), character: JsonRecord = {};
    if (typeof item.char_caption === "string") character.char_caption = item.char_caption;
    if (Array.isArray(item.centers)) character.centers = item.centers.map(value => {
      const center = record(value), result: JsonRecord = {};
      if (finite(center.x)) result.x = center.x;
      if (finite(center.y)) result.y = center.y;
      return result;
    });
    return character;
  });
  output.caption = clean;
  return output;
}

function sanitizedRequest(value: InpaintDiagnosticCaptureOptions["request"]): JsonRecord {
  const source = record(value), output: JsonRecord = {}, parameters = record(source.parameters), clean: JsonRecord = {};
  if (typeof source.input === "string") output.input = source.input;
  if (typeof source.model === "string" && /^nai-diffusion-[a-z0-9-]{1,64}$/.test(source.model)) output.model = source.model;
  if (source.action === "infill" || source.action === "generate") output.action = source.action;
  for (const key of numericParameters) if (finite(parameters[key]) || parameters[key] === null) clean[key] = parameters[key];
  for (const key of booleanParameters) if (typeof parameters[key] === "boolean") clean[key] = parameters[key];
  for (const [key, values] of Object.entries(enumParameters)) if (typeof parameters[key] === "string" && values.includes(parameters[key] as string)) clean[key] = parameters[key];
  for (const key of ["uc", "negative_prompt"]) if (typeof parameters[key] === "string") clean[key] = parameters[key];
  for (const key of ["v4_prompt", "v4_negative_prompt"]) if (parameters[key] !== undefined) clean[key] = caption(parameters[key]);
  if (parameters.img2img === null) clean.img2img = null;
  else if (parameters.img2img !== undefined) {
    const input = record(parameters.img2img), nested: JsonRecord = {};
    if (finite(input.strength)) nested.strength = input.strength;
    if (typeof input.color_correct === "boolean") nested.color_correct = input.color_correct;
    clean.img2img = nested;
  }
  output.parameters = clean;
  return output;
}

function imageExtension(bytes: Buffer): "png" | "jpg" | "webp" | "bin" {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "jpg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return "bin";
}

async function imageRecord(file: string, bytes: Buffer): Promise<ImageRecord> {
  const result: ImageRecord = { file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), width: null, height: null, decoded: false };
  try {
    const extension = imageExtension(bytes);
    if (extension === "bin") return result;
    const image = extension === "png" ? PNG.sync.read(bytes) : await sharp(bytes).metadata();
    if (image.width && image.height) { result.width = image.width; result.height = image.height; result.decoded = true; }
  } catch { /* Preserve even an unexpected response member for diagnosis. */ }
  return result;
}

async function writeNew(directory: string, file: string, bytes: Buffer | string) {
  await fs.writeFile(path.join(directory, file), bytes, { flag: "wx", mode: 0o600 });
}

/** Local opt-in evidence capture. Failures must never fail or retry generation. */
export async function beginInpaintDiagnosticCapture(options: InpaintDiagnosticCaptureOptions): Promise<InpaintDiagnosticCaptureHandle> {
  if (!options.enabled) return { status: "disabled" };
  let directory: string | undefined;
  try {
    const { width, height } = options;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 64 * 1024 * 1024 || options.blendAlpha.length !== width * height) throw new Error("Invalid diagnostic dimensions");
    const source = Buffer.from(options.sourcePng), mask = Buffer.from(options.requestMaskPng);
    const raw = options.rawBuffers.map(buffer => Buffer.from(buffer));
    const alpha = new PNG({ width, height });
    for (let pixel = 0; pixel < width * height; pixel++) {
      const index = pixel * 4, value = options.blendAlpha[pixel];
      alpha.data[index] = value; alpha.data[index + 1] = value; alpha.data[index + 2] = value; alpha.data[index + 3] = 255;
    }
    const alphaBytes = PNG.sync.write(alpha, { colorType: 0 });
    const captureId = randomUUID();
    const request = sanitizedRequest(options.request), rootDir = options.rootDir, jobId = options.jobId;
    const rawRecords = await Promise.all(raw.map((bytes, index) => imageRecord(`raw-${index}.${imageExtension(bytes)}`, bytes)));
    const manifest: Manifest = {
      schemaVersion: 1, captureId, stage: "pre-composite", createdAt: new Date().toISOString(),
      ...(typeof jobId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(jobId) ? { jobId } : {}),
      request, processing: { width, height },
      files: { source: await imageRecord("source.png", source), requestMask: await imageRecord("request-mask.png", mask), blendAlpha: await imageRecord("blend-alpha.png", alphaBytes), raw: rawRecords },
    };
    await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
    directory = path.join(rootDir, captureId);
    await fs.mkdir(directory, { mode: 0o700 });
    await writeNew(directory, "source.png", source);
    await writeNew(directory, "request-mask.png", mask);
    await writeNew(directory, "blend-alpha.png", alphaBytes);
    for (let index = 0; index < raw.length; index++) await writeNew(directory, rawRecords[index].file, raw[index]);
    await writeNew(directory, "manifest.json", JSON.stringify(manifest, null, 2) + "\n");
    const handle: InpaintDiagnosticCaptureHandle = { status: "saved", directory };
    captures.set(handle, { directory, manifest });
    return handle;
  } catch {
    return { status: "failed", ...(directory ? { directory } : {}) };
  }
}

export async function finishInpaintDiagnosticCapture(handle: InpaintDiagnosticCaptureHandle, compositeBuffers: Buffer[]): Promise<InpaintDiagnosticCaptureHandle> {
  if (handle.status !== "saved") return handle;
  const capture = captures.get(handle);
  if (!capture) return { status: "failed" };
  const { manifest, directory } = capture;
  if (manifest.stage === "complete") return handle;
  try {
    const buffers = compositeBuffers.map(buffer => Buffer.from(buffer));
    const composite = await Promise.all(buffers.map((bytes, index) => imageRecord(`composite-${index}.${imageExtension(bytes)}`, bytes)));
    const complete: Manifest = { ...manifest, stage: "complete", completedAt: new Date().toISOString(), files: { ...manifest.files, composite } };
    for (let index = 0; index < buffers.length; index++) await writeNew(directory, composite[index].file, buffers[index]);
    const pending = `manifest-${randomUUID()}.tmp`;
    await writeNew(directory, pending, JSON.stringify(complete, null, 2) + "\n");
    await fs.rename(path.join(directory, pending), path.join(directory, "manifest.json"));
    captures.set(handle, { directory, manifest: complete });
    return handle;
  } catch {
    return { status: "failed", directory };
  }
}
