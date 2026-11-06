import type { GenerateParams, NAIInpaintModel, I2IParams, VibeTransferImage, PreciseReferenceImage, CharCaption, AugmentOptions, DirectorTool } from "../types";
import { DEFAULT_PARAMS, baseModelForInpaint, NAI_MODELS, NAI_SAMPLERS, NAI_INPAINT_MODELS, DIRECTOR_TOOLS, EMOTION_OPTIONS, normalizeGenerateParams } from "../types";
import { generationProvenance, imageActualSeed } from "./generation-provenance";
import { normalizeMetadataReplay } from "../metadata-replay";
import { WorkspaceError, type WorkspaceAsset, type WorkspaceDocument } from "./protocol";

/** Explicit allowlist: never spread the application store or its settings into IPC. */
export const CREATIVE_KEYS = [
  "params", "currentImage", "workbenchImage", "i2iOriginalImage", "i2iSourceMode", "inpaintSourceMode",
  "comparisonBeforeImage", "comparisonSurface", "activeCanvasSurface", "activeTab", "promptTab",
  "generateMode", "postprocessMode", "enhanceMagnitude", "enhanceScale",
  "i2iParams", "i2iSizeMode", "inpaintModel", "inpaintStrength", "inpaintNoise", "inpaintPositivePrompt", "inpaintRecipe",
  "brushSize", "brushOpacity", "brushColor", "brushMode", "brushShape", "inpaintMask", "maskRevision",
  "upscaleScale", "directorTool", "augmentOptions", "vibeImages", "preciseReferences", "charCaptions",
  "batchCount", "batchIntervalSeconds", "generationGroupId",
] as const;

export type CreativeState = Record<typeof CREATIVE_KEYS[number], any> & { modelMode: string };
/** Saved UI/editor state that never enters freezeGenerationInput or the review
 * builders. Keep these in documents, but not in the creative concurrency lock.
 * New fields remain revision-bearing unless explicitly classified here. */
export const DISPLAY_ONLY_KEYS = new Set<string>([
  "currentImage", "comparisonBeforeImage", "comparisonSurface", "activeCanvasSurface", "activeTab", "promptTab",
  "generateMode", "postprocessMode", "brushSize", "brushOpacity", "brushColor", "brushMode", "brushShape", "maskRevision",
]);

export function semanticEqual(before: unknown, after: unknown): boolean {
  if (Object.is(before, after)) return true;
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return false;
  if (Array.isArray(before) || Array.isArray(after)) return Array.isArray(before) && Array.isArray(after) && before.length === after.length && before.every((item, index) => semanticEqual(item, after[index]));
  const left = before as Record<string, unknown>, right = after as Record<string, unknown>;
  const keys = Object.keys(left).filter(key => left[key] !== undefined), other = Object.keys(right).filter(key => right[key] !== undefined);
  return keys.length === other.length && keys.every(key => Object.hasOwn(right, key) && semanticEqual(left[key], right[key]));
}
export interface EditablePatch {
  params?: Partial<GenerateParams>;
  i2iParams?: Partial<I2IParams>;
  charCaptions?: CharCaption[];
  vibeImages?: VibeTransferImage[];
  preciseReferences?: PreciseReferenceImage[];
  inpaintMask?: string | null;
  inpaintModel?: string;
  inpaintStrength?: number;
  inpaintNoise?: number;
  inpaintPositivePrompt?: string;
  inpaintRecipe?: Partial<GenerateParams> | null;
  enhanceMagnitude?: number;
  enhanceScale?: number | "max";
  upscaleScale?: number;
  directorTool?: DirectorTool;
  augmentOptions?: Partial<AugmentOptions>;
}

const PATCH_KEYS = new Set(["params", "i2iParams", "charCaptions", "vibeImages", "preciseReferences", "inpaintMask", "inpaintModel", "inpaintStrength", "inpaintNoise", "inpaintPositivePrompt", "inpaintRecipe", "enhanceMagnitude", "enhanceScale", "upscaleScale", "directorTool", "augmentOptions"]);
const IMAGE_KEYS = ["currentImage", "workbenchImage", "i2iOriginalImage", "comparisonBeforeImage"] as const;
export const MAX_ASSET_BASE64_LENGTH = 44 * 1024 * 1024;

export function record(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceError("invalid_argument", `${label} must be an object.`);
  return value as Record<string, any>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new WorkspaceError("invalid_argument", `${label} must be a string.`);
  return value;
}

function number(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new WorkspaceError("invalid_argument", `${label} must be a finite number in [${min}, ${max}].`);
  }
  return value;
}

function keysOnly(value: Record<string, unknown>, allowed: Set<string>, label: string) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new WorkspaceError("invalid_argument", `Unsupported ${label} field: ${key}`);
}

export function imageBase64(value: unknown, label: string): string {
  const data = string(value, label).replace(/^data:image\/(?:png|jpeg|webp|gif);base64,/, "");
  if (!data || data.length > MAX_ASSET_BASE64_LENGTH || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new WorkspaceError("invalid_argument", `${label} must contain image base64 (up to 32 MB).`);
  }
  if (!/^(?:iVBOR|\/9j\/|UklGR|R0lGOD)/.test(data)) throw new WorkspaceError("invalid_argument", `${label} is not a PNG, JPEG, WebP or GIF image.`);
  return data;
}

export function imageMime(data: string): string {
  if (data.startsWith("/9j/")) return "image/jpeg";
  if (data.startsWith("UklGR")) return "image/webp";
  if (data.startsWith("R0lGOD")) return "image/gif";
  return "image/png";
}

export function pickCreativeState(store: Record<string, any>): CreativeState {
  const result: Record<string, any> = {};
  for (const key of CREATIVE_KEYS) result[key] = store[key];
  result.modelMode = store.settings?.modelMode ?? store.modelMode ?? "anime";
  return result as CreativeState;
}

export function creativeStateChanged(before: CreativeState, after: CreativeState): boolean {
  // Source images, Mask bytes, references and output grouping are deliberately
  // retained. Browsing cannot change these; explicit source/edit actions can.
  return before.modelMode !== after.modelMode || CREATIVE_KEYS.some((key) => !DISPLAY_ONLY_KEYS.has(key) && !semanticEqual(before[key], after[key]));
}

export function snapshotDocument(raw: CreativeState, previewRevision = 0): WorkspaceDocument {
  const state = structuredClone(raw) as Record<string, any>;
  const assets: WorkspaceAsset[] = [];
  for (const role of IMAGE_KEYS) {
    const source = state[role];
    if (!source) continue;
    // The initial legacy IDs remain usable until the first preview change.
    // Afterwards stale preview IDs cannot silently resolve to a different image.
    const id = previewRevision && ["currentImage", "comparisonBeforeImage"].includes(role) ? `${role}:preview-${previewRevision}` : role;
    const { filePath, fileUrl, ...metadata } = source;
    const inline = typeof fileUrl === "string" && fileUrl.startsWith("data:image/") ? imageBase64(fileUrl, role) : undefined;
    if (!filePath && !inline) throw new WorkspaceError("asset_unavailable", `${role} has no readable image source.`);
    assets.push({ id, role, mimeType: inline ? imageMime(inline) : /\.jpe?g$/i.test(filePath) ? "image/jpeg" : /\.webp$/i.test(filePath) ? "image/webp" : "image/png", width: source.width, height: source.height, ...(filePath ? { path: filePath } : { data: inline }) });
    const provenance = generationProvenance(source.generationOrigin);
    state[role] = { ...metadata, ...(provenance ? { generationOrigin: provenance, actualSeed: imageActualSeed(source) } : {}), assetId: id };
  }
  for (const role of ["vibeImages", "preciseReferences"] as const) {
    state[role] = (state[role] ?? []).map((source: any, index: number) => {
      const { base64, previewUrl: _previewUrl, ...metadata } = source;
      const data = imageBase64(base64, `${role}[${index}]`);
      const id = `${role}:${source.id ?? index}`;
      assets.push({ id, role, mimeType: imageMime(data), data, ...(source.srcWidth ? { width: source.srcWidth, height: source.srcHeight } : {}) });
      return { ...metadata, assetId: id };
    });
  }
  if (state.inpaintMask) {
    const data = imageBase64(state.inpaintMask, "inpaintMask");
    assets.push({ id: "inpaintMask", role: "inpaintMask", mimeType: imageMime(data), data, width: state.workbenchImage?.width, height: state.workbenchImage?.height });
    state.inpaintMask = { assetId: "inpaintMask" };
  }
  return { schemaVersion: 1, state, assets };
}

export function assetManifest(assets: WorkspaceAsset[]) {
  return assets.map(({ data: _data, path: _path, ...manifest }) => manifest);
}

function array(value: unknown, label: string, limit: number): any[] {
  if (!Array.isArray(value) || value.length > limit) throw new WorkspaceError("invalid_argument", `${label} must be an array of at most ${limit} entries.`);
  return value;
}

/** Validate the entire patch before any application action can run. */
export function validatePatch(input: unknown, current: CreativeState): EditablePatch {
  const source = record(input, "patch");
  keysOnly(source, PATCH_KEYS, "patch");
  if (!Object.keys(source).length) throw new WorkspaceError("invalid_argument", "patch cannot be empty.");
  const patch: EditablePatch = {};
  if ("params" in source) {
    const params = record(source.params, "params");
    keysOnly(params, new Set([...Object.keys(DEFAULT_PARAMS), "preservePromptText", "metadataReplay", "effort"]), "params");
    for (const [key, value] of Object.entries(params)) {
      if (key === "metadataReplay") {
        const replay = record(value, "metadataReplay");
        keysOnly(replay, new Set(["model", "parameters", "positive", "negative", "keepEmptyNegativeCharacters"]), "metadataReplay");
        const normalized = normalizeMetadataReplay(replay);
        if (!normalized) throw new WorkspaceError("invalid_argument", "Invalid metadataReplay.");
        const parameters = record(replay.parameters, "metadataReplay.parameters");
        for (const parameter of Object.keys(parameters)) if (!(parameter in normalized.parameters)) throw new WorkspaceError("invalid_argument", `Unsupported metadata replay parameter: ${parameter}`);
        for (const role of ["positive", "negative"] as const) if (replay[role]) keysOnly(record(replay[role], `metadataReplay.${role}`), new Set(["use_order", "legacy_uc"]), `metadataReplay.${role}`);
        continue;
      }
      // V5 Full Effort: "high" clears it (absent = high), "medium" sets it (src/nai-effort.ts).
      if (key === "effort") { if (value !== "high" && value !== "medium") throw new WorkspaceError("invalid_argument", "params.effort must be \"high\" or \"medium\"."); continue; }
      const exemplar = key === "preservePromptText" ? true : DEFAULT_PARAMS[key as keyof GenerateParams];
      if (typeof value !== typeof exemplar || (typeof value === "number" && !Number.isFinite(value)) || (key === "promptAssemblyVersion" && value !== 1)) throw new WorkspaceError("invalid_argument", `Invalid params.${key}.`);
    }
    if (params.model && !NAI_MODELS.some((m) => m.value === params.model)) throw new WorkspaceError("invalid_argument", "Unknown model.");
    if (params.sampler && !NAI_SAMPLERS.some((s) => s.value === params.sampler)) throw new WorkspaceError("invalid_argument", "Unknown sampler.");
    for (const [key, values] of Object.entries({ seedMode: ["random", "fixed"], qualityPreset: ["standard", "light", "none"], noiseSchedule: ["native", "karras", "exponential"] })) {
      if (key in params && !values.includes(params[key])) throw new WorkspaceError("invalid_argument", `Invalid params.${key}.`);
    }
    patch.params = normalizeGenerateParams({ ...current.params, ...params });
  }
  if ("i2iParams" in source) {
    const params = record(source.i2iParams, "i2iParams");
    keysOnly(params, new Set(["strength", "noise", "extraNoiseSeed"]), "i2iParams");
    for (const [key, value] of Object.entries(params)) number(value, `i2iParams.${key}`, 0, key === "extraNoiseSeed" ? 0xffffffff : 1);
    patch.i2iParams = { ...current.i2iParams, ...params };
  }
  if ("inpaintModel" in source) {
    const model = string(source.inpaintModel, "inpaintModel");
    if (!NAI_INPAINT_MODELS.some((m) => m.value === model)) throw new WorkspaceError("invalid_argument", "Unknown inpaint model.");
    patch.inpaintModel = model;
  }
  if ("inpaintRecipe" in source || ("inpaintModel" in source && current.inpaintRecipe)) {
    const model = baseModelForInpaint((patch.inpaintModel ?? current.inpaintModel) as NAIInpaintModel);
    const inputRecipe = "inpaintRecipe" in source ? source.inpaintRecipe : {};
    if (inputRecipe !== null) {
      const values = record(inputRecipe, "inpaintRecipe");
      if (values.model !== undefined && values.model !== model) throw new WorkspaceError("invalid_argument", "inpaintRecipe.model must match the base model of inpaintModel.");
      const base = { ...(current.inpaintRecipe ?? { ...current.params, positivePrompt: current.inpaintPositivePrompt }), model };
      patch.inpaintRecipe = validatePatch({ params: values }, { ...current, params: base }).params!;
    } else patch.inpaintRecipe = null;
  }
  if ("inpaintStrength" in source) patch.inpaintStrength = number(source.inpaintStrength, "inpaintStrength", 0, 1);
  if ("inpaintNoise" in source) patch.inpaintNoise = number(source.inpaintNoise, "inpaintNoise", 0, 0.99);
  if ("inpaintPositivePrompt" in source) patch.inpaintPositivePrompt = string(source.inpaintPositivePrompt, "inpaintPositivePrompt");
  // Enhance Max✨ (V5): enhanceScale "max" (src/nai-dimensions.ts maxEnhanceInputSize).
  if (source.enhanceScale === "max") patch.enhanceScale = "max";
  for (const key of ["enhanceMagnitude", "enhanceScale", "upscaleScale"] as const) if (key in source && !(key === "enhanceScale" && source[key] === "max")) {
    const value = number(source[key], key, 1, key === "enhanceMagnitude" ? 10 : key === "upscaleScale" ? 4 : 2);
    if (!Number.isInteger(value) || (key === "upscaleScale" && ![2, 4].includes(value))) throw new WorkspaceError("invalid_argument", `Invalid ${key}.`);
    patch[key] = value;
  }
  if ("directorTool" in source) {
    if (!DIRECTOR_TOOLS.some((item) => item.value === source.directorTool)) throw new WorkspaceError("invalid_argument", "Unknown Director tool.");
    patch.directorTool = source.directorTool;
  }
  if ("augmentOptions" in source) {
    const opts = record(source.augmentOptions, "augmentOptions");
    keysOnly(opts, new Set(["defry", "colorizePrompt", "emotion", "emotionLevel"]), "augmentOptions");
    for (const key of ["defry", "emotionLevel"]) if (key in opts && !Number.isInteger(number(opts[key], key, 0, 5))) throw new WorkspaceError("invalid_argument", `${key} must be an integer.`);
    if ("colorizePrompt" in opts) string(opts.colorizePrompt, "colorizePrompt");
    if ("emotion" in opts && !EMOTION_OPTIONS.some((item) => item.value === opts.emotion)) throw new WorkspaceError("invalid_argument", "Unknown emotion.");
    patch.augmentOptions = { ...current.augmentOptions, ...opts };
  }
  if ("inpaintMask" in source) {
    patch.inpaintMask = source.inpaintMask === null ? null : imageBase64(source.inpaintMask, "inpaintMask");
    if (patch.inpaintMask && !current.workbenchImage) throw new WorkspaceError("invalid_argument", "Load a workbench image before attaching a mask.");
  }
  for (const role of ["vibeImages", "preciseReferences"] as const) {
    if (!(role in source)) continue;
    const usedIds = new Set<string>();
    const values = array(source[role], role, 16).map((item, index) => {
      const ref = record(item, `${role}[${index}]`);
      const allowed = role === "vibeImages" ? ["id", "name", "base64", "infoExtracted", "strength"] : ["id", "name", "base64", "type", "strength", "fidelity", "informationExtracted", "srcWidth", "srcHeight"];
      keysOnly(ref, new Set(allowed), role);
      const id = "id" in ref ? string(ref.id, `${role}.id`) : `${role}-${index}`;
      if (!id || usedIds.has(id)) throw new WorkspaceError("invalid_argument", `Duplicate or empty ${role} id.`);
      usedIds.add(id);
      const base64 = imageBase64(ref.base64, `${role}.base64`);
      if (ref.name !== undefined && (typeof ref.name !== "string" || ref.name.length > 1000)) throw new WorkspaceError("invalid_argument", "Reference name must be at most 1000 characters.");
      const common = { id, ...(ref.name !== undefined ? { name: ref.name } : {}), base64, previewUrl: `data:${imageMime(base64)};base64,${base64}`, strength: number(ref.strength, `${role}.strength`, 0, 1) };
      if (role === "vibeImages") return { ...common, infoExtracted: number(ref.infoExtracted, "infoExtracted", 0, 1) };
      if (!["character", "style", "character&style"].includes(ref.type)) throw new WorkspaceError("invalid_argument", "Invalid precise reference type.");
      return { ...common, type: ref.type, fidelity: number(ref.fidelity, "fidelity", 0, 1), ...(ref.informationExtracted !== undefined ? { informationExtracted: number(ref.informationExtracted, "informationExtracted", 0, 1) } : {}), ...(ref.srcWidth !== undefined ? { srcWidth: number(ref.srcWidth, "srcWidth", 1, 32768), srcHeight: number(ref.srcHeight, "srcHeight", 1, 32768) } : {}) };
    });
    (patch as Record<string, unknown>)[role] = values;
  }
  if ("charCaptions" in source) {
    const ids = new Set<string>();
    patch.charCaptions = array(source.charCaptions, "charCaptions", 32).map((item, index) => {
      const value = record(item, "charCaption");
      keysOnly(value, new Set(["id", "prompt", "negativePrompt", "useCoords", "x", "y"]), "charCaption");
      const id = value.id === undefined ? `character-${index}` : string(value.id, "charCaption.id");
      if (!id || ids.has(id)) throw new WorkspaceError("invalid_argument", "Duplicate or empty character id.");
      ids.add(id);
      if (typeof value.useCoords !== "boolean") throw new WorkspaceError("invalid_argument", "useCoords must be boolean.");
      return { id, prompt: string(value.prompt, "charCaption.prompt"), ...(value.negativePrompt !== undefined ? { negativePrompt: string(value.negativePrompt, "negativePrompt") } : {}), useCoords: value.useCoords, x: number(value.x, "x", 0, 1), y: number(value.y, "y", 0, 1) };
    });
  }
  return structuredClone(patch);
}

export function summarizeChanges(before: CreativeState, after: Partial<CreativeState>): Array<{ field: string; before: unknown; after: unknown }> {
  const changes: Array<{ field: string; before: unknown; after: unknown }> = [];
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(before[key as keyof CreativeState]) === JSON.stringify(value)) continue;
    if (key === "params" || key === "i2iParams" || (key === "inpaintRecipe" && value !== null && before.inpaintRecipe !== null)) {
      for (const [field, next] of Object.entries(value ?? {})) if (JSON.stringify(before[key]?.[field]) !== JSON.stringify(next)) changes.push({ field: `${key}.${field}`, before: before[key]?.[field], after: next });
    } else if (["vibeImages", "preciseReferences"].includes(key)) {
      const summarize = (refs: any[]) => ({ count: refs.length, references: refs.map(({ base64: _data, previewUrl: _url, ...meta }) => meta) });
      changes.push({ field: key, before: summarize(before[key as keyof CreativeState] ?? []), after: summarize(value as any[]) });
    } else if (key === "inpaintMask") changes.push({ field: key, before: before.inpaintMask ? "Mask present" : null, after: value ? "Mask present (image changed)" : null });
    else if ((IMAGE_KEYS as readonly string[]).includes(key)) changes.push({ field: key, before: before[key as keyof CreativeState] ? "Image present" : null, after: value ? "Selected image (prepared working copy)" : null });
    else changes.push({ field: key, before: before[key as keyof CreativeState], after: value });
  }
  return changes;
}
