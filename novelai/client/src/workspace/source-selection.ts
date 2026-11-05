import type { WorkingImage } from "../types";
import { WorkspaceError, type WorkspaceAsset } from "./protocol";
import { imageBase64, imageMime, record, type CreativeState } from "./state";

export type GenerationSourceMode = "i2i" | "inpaint" | "enhance" | "upscale" | "director";
export interface GenerationSourceSummary {
  assetId: string;
  role: string;
  mode: GenerationSourceMode;
  sha256: string;
  width: number;
  height: number;
  maskPolicy: "clear";
  clearedMask: boolean;
}
export interface PreparedGenerationSource {
  patch: Partial<CreativeState>;
  source: GenerationSourceSummary;
}
export const GENERATION_SOURCE_ROLES = new Set(["currentImage", "workbenchImage", "i2iOriginalImage", "comparisonBeforeImage", "vibeImages", "preciseReferences"]);

/** Only host-resolved image bytes enter here. Public tools accept manifest ids. */
export async function prepareGenerationSourceSelection(
  input: unknown,
  asset: WorkspaceAsset,
  mode: GenerationSourceMode,
  current: CreativeState,
  prepareWorkingCopy: (data: string) => Promise<WorkingImage>,
): Promise<PreparedGenerationSource> {
  if (!GENERATION_SOURCE_ROLES.has(asset.role)) throw new WorkspaceError("invalid_source", "Mask cannot be selected as a generation source image.");
  const source = record(input, "generation source");
  if (Object.keys(source).some((key) => !["mimeType", "data"].includes(key))) throw new WorkspaceError("invalid_source", "Generation source must contain only host-resolved image bytes.");
  const data = imageBase64(source.data, "generation source");
  if (source.mimeType !== imageMime(data)) throw new WorkspaceError("invalid_source", "Generation source MIME type does not match its bytes.");
  const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
  if (bytes.byteLength > 20 * 1024 * 1024) throw new WorkspaceError("invalid_source", "Generation source exceeds 20 MiB.");
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const image = await prepareWorkingCopy(data);
  if ((asset.width !== undefined && asset.width !== image.width) || (asset.height !== undefined && asset.height !== image.height)) throw new WorkspaceError("invalid_source", "Selected source dimensions changed. Read and select the image again.");
  return {
    source: { assetId: asset.id, role: asset.role, mode, sha256, width: image.width, height: image.height, maskPolicy: "clear", clearedMask: Boolean(current.inpaintMask) },
    patch: {
      // currentImage is a generated HistoryItem. Clear it instead of inventing
      // generation metadata for an ordinary source image; i2i previews its input.
      currentImage: null,
      workbenchImage: image,
      i2iOriginalImage: image,
      i2iSourceMode: "original",
      inpaintSourceMode: "original",
      comparisonBeforeImage: null,
      comparisonSurface: null,
      inpaintMask: null,
      ...(mode === "inpaint" ? { activeTab: "inpaint", activeCanvasSurface: "inpaint" }
        : mode === "i2i" || mode === "enhance" ? { activeTab: "generate", generateMode: mode, activeCanvasSurface: `generate:${mode}` }
        : { activeTab: "postprocess", postprocessMode: mode, activeCanvasSurface: `postprocess:${mode}` }),
    },
  };
}
