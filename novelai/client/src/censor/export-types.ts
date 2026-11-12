/**
 * Censored JPG export (desktop only): the window renders each image with its censoring already applied and hands the
 * main process plain pixels; the main process only encodes them as JPEG and writes the files. Nothing of the library
 * record (prompts, settings, the original file's bytes or metadata) crosses this boundary, only a file name stem.
 */
export const CENSORED_EXPORT_LIMITS = Object.freeze({ images: 100, pixels: 24_000_000, minQuality: 60, maxQuality: 100, stem: 120 });

export type CensoredExportRequest =
  /** Asks where to save: a file for one image, a folder for several. */
  | { action: 'begin'; count: number; name: string }
  /** One rendered image: RGBA, 8 bit, width × height × 4 bytes, already opaque. */
  | { action: 'write'; session: string; name: string; width: number; height: number; pixels: Uint8Array; quality: number }
  | { action: 'finish'; session: string };

export type CensoredExportResult =
  | { status: 'cancelled' }
  | { status: 'ready'; session: string }
  | { status: 'written'; bytes: number; file: string }
  /** reveal: the saved file (the first of several), for "show in folder". */
  | { status: 'done'; written: number; reveal: string | null };

export function isCensoredExportResult(value: unknown): value is CensoredExportResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  switch (result.status) {
    case 'cancelled': return true;
    case 'ready': return typeof result.session === 'string' && result.session.length > 0;
    case 'written': return Number.isSafeInteger(result.bytes) && (result.bytes as number) > 0 && typeof result.file === 'string';
    case 'done': return Number.isSafeInteger(result.written) && (result.written as number) >= 0 && (result.reveal === null || typeof result.reveal === 'string');
    default: return false;
  }
}

/** A file name stem that is safe on macOS, Windows and Linux; never a path. */
export function censoredExportStem(name: unknown): string {
  const base = (typeof name === 'string' ? name : '').split(/[\\/]/).pop() ?? '';
  const stem = base.replace(/\.(?:png|jpe?g|webp|gif|avif)$/i, '')
    .replace(/[\u0000-\u001f\u007f<>:"|?*\\/]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, CENSORED_EXPORT_LIMITS.stem).replace(/[.\s]+$/g, '');
  return !stem || /^(?:con|prn|aux|nul|com\d|lpt\d)$/i.test(stem) ? 'image' : stem;
}
