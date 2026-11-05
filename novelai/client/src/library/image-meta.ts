import { inspectImageMetadata, parseImageMeta, type ImageMetadataReport } from '../png-meta';
import { metadataApplyKeys, selectedMetadata } from '../metadata-selection';
import { useAppStore } from '../store';

/**
 * Reading the settings inside an image (user decision 4: 读取图片原数据 is part of 导入图片). The parsing is the
 * existing renderer parser (png-meta.ts, NovelAI / Stable Diffusion / ComfyUI); nothing is sent anywhere.
 */
export const IMPORT_FILE_LIMIT = 20 * 1024 * 1024;
export const IMPORT_BATCH_LIMIT = 20;
export const IMPORT_TYPES = /\.(png|jpe?g|webp)$/i;

export type ImportCheck = { ok: true } | { ok: false; reason: 'type' | 'size' };
export function checkImportFile(file: Pick<File, 'name' | 'size' | 'type'>): ImportCheck {
  if (!IMPORT_TYPES.test(file.name) && !/^image\/(png|jpeg|webp)$/i.test(file.type)) return { ok: false, reason: 'type' };
  if (!file.size || file.size > IMPORT_FILE_LIMIT) return { ok: false, reason: 'size' };
  return { ok: true };
}

export function readReport(buffer: ArrayBuffer): ImageMetadataReport {
  return inspectImageMetadata(parseImageMeta(buffer));
}

/** Whether a report has settings worth applying (a prompt or generation parameters). */
export function reportHasSettings(report: ImageMetadataReport | null | undefined) {
  if (!report || report.kind === 'unknown') return false;
  const imported = report.imported;
  return !!(imported.positivePrompt || imported.negativePrompt || imported.stylePrompt || imported.steps !== undefined || imported.seed !== undefined || imported.model);
}

/** The settings rows of a report for display (labels are chosen by the caller). */
export function reportFields(report: ImageMetadataReport) {
  const imported = report.imported;
  return {
    stylePrompt: imported.stylePrompt ?? '', positivePrompt: imported.positivePrompt ?? '', negativePrompt: imported.negativePrompt ?? '',
    characters: report.characterCaptions.map(caption => ({ prompt: caption.prompt ?? '', negativePrompt: caption.negativePrompt ?? '' })),
    model: imported.model, width: imported.width, height: imported.height, steps: imported.steps, cfgScale: imported.cfgScale, cfgRescale: imported.cfgRescale,
    sampler: imported.sampler, noiseSchedule: imported.noiseSchedule, seed: imported.seed, ucPreset: imported.ucPreset,
  };
}

/**
 * 复用到画布 from an image's own settings: the prompt, characters and parameters it carries replace the canvas's;
 * the canvas's reference images stay (they are not inside the image). Nothing is generated.
 */
export function applyReportToCanvas(report: ImageMetadataReport) {
  const keys = metadataApplyKeys(report).filter(key => key !== 'referenceImages');
  const { patch, captions, options } = selectedMetadata(report, new Set(keys));
  const store = useAppStore.getState();
  store.restoreImportedMetadata(patch, captions, options);
  store.setActiveTab('generate');
}

/** An image file's bytes as base64 (for material_studies import). */
export async function fileBase64(file: Pick<File, 'arrayBuffer'>): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text = '';
  for (let index = 0; index < bytes.length; index += 32768) text += String.fromCharCode(...bytes.subarray(index, index + 32768));
  return btoa(text);
}
