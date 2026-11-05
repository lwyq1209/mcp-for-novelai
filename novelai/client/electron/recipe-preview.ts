import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { PromptReviewInput } from '../src/workspace/prompt-review';
import { WorkspaceError } from '../src/workspace/protocol';

/** Dry-run recipe preview: the same normalized, materialized builder output as a
 * put, plus an inpaint overlay. Nothing here touches the filesystem. */
export const RECIPE_PREVIEW_LIMITS = { longEdge: 768, quality: 78, fallbackQuality: 50, maxBytes: 1024 * 1024, cell: 8, decodePixels: 64 * 1024 * 1024 } as const;
const TINT = [255, 40, 40, 120] as const;

export interface RecipePreviewImage {
  mimeType: 'image/webp';
  data: string;
  width: number;
  height: number;
  byteLength: number;
  sha256: string;
  /** The exact request images the overlay was drawn from (what the provider would receive). */
  basis: { sourceRole: string; maskRole: string; width: number; height: number };
  /** Latent 8×8 cells selected in the request mask, sampled at each cell's top-left pixel. */
  cells: { selected: number; total: number };
}

/** Overlay of the actual request-mask selection (translucent red) on the actual
 * request-source, long edge ≤ 768, WebP. Only a ready inpaint review has one. */
export async function renderRecipePreviewImage(input: PromptReviewInput): Promise<RecipePreviewImage | null> {
  if (input.mode !== 'inpaint' || input.readiness.status !== 'ready' || !input.effective?.sourceRole || !input.effective.maskRole) return null;
  const { sourceRole, maskRole } = input.effective;
  const source = input.assets.find(asset => asset.role === sourceRole), mask = input.assets.find(asset => asset.role === maskRole);
  if (!source?.data || !mask?.data) throw new WorkspaceError('preview_unavailable', 'The inpaint preview needs the request source and mask image bytes.');
  const decode = (data: string) => sharp(Buffer.from(data, 'base64'), { limitInputPixels: RECIPE_PREVIEW_LIMITS.decodePixels });
  const maskPixels = await decode(mask.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = maskPixels.info;
  if (width !== source.width || height !== source.height || maskPixels.info.channels !== 4) throw new WorkspaceError('preview_unavailable', 'The request mask and source sizes differ.');
  const overlay = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) if (maskPixels.data[pixel * 4] === 255) overlay.set(TINT, pixel * 4);
  const cellsX = Math.ceil(width / RECIPE_PREVIEW_LIMITS.cell), cellsY = Math.ceil(height / RECIPE_PREVIEW_LIMITS.cell);
  let selected = 0;
  for (let cellY = 0; cellY < cellsY; cellY++) for (let cellX = 0; cellX < cellsX; cellX++) if (maskPixels.data[((cellY * RECIPE_PREVIEW_LIMITS.cell) * width + cellX * RECIPE_PREVIEW_LIMITS.cell) * 4] === 255) selected++;
  // Composite at full request size first; sharp would otherwise resize before compositing.
  const composed = await decode(source.data).composite([{ input: overlay, raw: { width, height, channels: 4 } }]).png({ compressionLevel: 0 }).toBuffer();
  const encode = (quality: number) => sharp(composed, { limitInputPixels: RECIPE_PREVIEW_LIMITS.decodePixels })
    .resize({ width: RECIPE_PREVIEW_LIMITS.longEdge, height: RECIPE_PREVIEW_LIMITS.longEdge, fit: 'inside', withoutEnlargement: true })
    .webp({ quality }).toBuffer({ resolveWithObject: true });
  let image = await encode(RECIPE_PREVIEW_LIMITS.quality);
  if (image.data.length > RECIPE_PREVIEW_LIMITS.maxBytes) image = await encode(RECIPE_PREVIEW_LIMITS.fallbackQuality);
  if (image.data.length > RECIPE_PREVIEW_LIMITS.maxBytes) throw new WorkspaceError('preview_unavailable', 'The preview image exceeds 1 MiB.');
  return {
    mimeType: 'image/webp', data: image.data.toString('base64'), width: image.info.width, height: image.info.height, byteLength: image.data.length,
    sha256: createHash('sha256').update(image.data).digest('hex'), basis: { sourceRole, maskRole, width, height }, cells: { selected, total: cellsX * cellsY },
  };
}

export interface RecipePreviewParts {
  inputHash: string;
  characterIds: string[];
  reviewInput: PromptReviewInput;
  /** assetRefs / assetBytes / assetProvenance, exactly as a saved recipe would report them. */
  assetDetails: Record<string, unknown>;
  omitAssetData: boolean;
}

/** Same readback shape as put_queue_recipe, with no identity: nothing was saved. */
export async function queueRecipePreviewResult(parts: RecipePreviewParts) {
  const previewImage = await renderRecipePreviewImage(parts.reviewInput);
  const reviewInput = parts.omitAssetData ? { ...parts.reviewInput, assets: parts.reviewInput.assets.map(({ data: _data, ...asset }) => asset) } : parts.reviewInput;
  return {
    preview: true as const, saved: false as const, recipeId: null, recipeRevision: null, inputHash: parts.inputHash, characterIds: parts.characterIds,
    snapshot: { schemaVersion: 1 as const, workspaceId: null, revision: null, draftId: null, mode: parts.reviewInput.mode, reviewInput },
    ...parts.assetDetails,
    previewImage,
  };
}
