import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import type { HistoryItem } from '../src/types';
import type { GenerationResult } from '../src/workspace/generation-types';

export const RESULT_IMAGE_LIMIT = 20 * 1024 * 1024;
export function resultImageMime(data: Buffer): string {
  if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) return 'image/gif';
  throw Object.assign(new Error('The result is not a readable image.'), { code: 'invalid_image' });
}

/** Reads an already-owned history record, never a caller-supplied path. */
export async function readSavedGenerationResult(
  item: HistoryItem,
  context: Pick<GenerationResult, 'jobId'|'workspaceId'|'originWorkspaceId'|'submittedRevision'|'index'|'actualSeed'|'model'>,
  validateImage: (data: Buffer, mimeType: string) => { width: number; height: number },
  read?: (item: HistoryItem) => Promise<Buffer>,
): Promise<GenerationResult> {
  let data: Buffer;
  if (read) data = await read(structuredClone(item));
  else {
    const file = await fs.open(item.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > RESULT_IMAGE_LIMIT) throw Object.assign(new Error('The result file is invalid or larger than 20 MiB.'), { code: 'invalid_image' });
      data = await file.readFile();
    } finally { await file.close(); }
  }
  if (!data.length || data.length > RESULT_IMAGE_LIMIT) throw Object.assign(new Error('The result image is empty or larger than 20 MiB.'), { code: 'invalid_image' });
  const mimeType = resultImageMime(data), size = validateImage(data, mimeType);
  if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width < 1 || size.height < 1 || size.width * size.height > 64 * 1024 * 1024) throw Object.assign(new Error('The result image size is invalid.'), { code: 'invalid_image' });
  return { ...context, ...size, mimeType, data: data.toString('base64'), historyItem: structuredClone(item), historyId: item.id, createdAt: item.createdAt, providerRequestId: null };
}
