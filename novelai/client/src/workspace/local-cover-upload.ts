import type { MaterialEntry } from './material-library-types';

export const LOCAL_COVER_MAX_BYTES = 20 * 1024 * 1024;
export const LOCAL_COVER_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif';
export type LocalCoverTarget = Pick<MaterialEntry, 'id' | 'revision' | 'coverRevision' | 'name'>;
export type LocalCoverUploadRequest = {
  action: 'set_local_cover'; entryId: string; revision: number; expectedCoverRevision: number; fileName: string; data: string;
};
/** A refusal with the reason the window renders in its language (src/host-errors/library.ts cover.local_*; step 4c1). */
const refused = (reason: string, message: string, params?: Record<string, string | number>) => Object.assign(new Error(message), { code: 'invalid_argument', reason, ...(params ? { params } : {}) });
export const localCoverTargetKey = (entry: LocalCoverTarget) => `${entry.id}:${entry.revision}:${entry.coverRevision ?? 0}`;

export function validateLocalCoverFile(file: Pick<File, 'name' | 'size' | 'type'>) {
  if (!file.name.trim() || file.name.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(file.name)) throw refused('cover.local_name', 'Choose a local image file with a valid name.');
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > LOCAL_COVER_MAX_BYTES) throw refused('cover.local_size', 'The cover image must be non-empty and at most 20 MiB.');
  if (!/^image\/(png|jpeg|webp|gif)$/i.test(file.type) && !/\.(png|jpe?g|webp|gif)$/i.test(file.name)) throw refused('cover.local_type', 'Choose a PNG, JPEG, WebP or GIF image.');
}

/** Reads only the explicitly selected File, and only after Save. No path, URL,
 * canvas, network request or image decoder is involved in this browser step. */
export async function localCoverUploadRequest(file: File, target: LocalCoverTarget, signal?: AbortSignal): Promise<LocalCoverUploadRequest> {
  validateLocalCoverFile(file);
  const captured = { ...target };
  if (signal?.aborted) throw refused('cover.local_cancelled', 'Reading the image was cancelled.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (signal?.aborted) throw refused('cover.local_cancelled', 'Reading the image was cancelled.');
  if (bytes.length !== file.size || bytes.length > LOCAL_COVER_MAX_BYTES) throw refused('cover.local_changed', 'The file changed while it was read; choose it again.');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return { action: 'set_local_cover', entryId: captured.id, revision: captured.revision, expectedCoverRevision: captured.coverRevision ?? 0, fileName: file.name, data: btoa(binary) };
}
