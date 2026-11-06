import sharp from 'sharp';

/** A preview of one saved queue result: at most 384 px on its longer side, WebP. */
export type QueueResultThumbnail = (original: Buffer) => Promise<{ mimeType: 'image/webp'; data: Buffer; width: number; height: number }>;
/** Edge and bounds of the preview (as the library's thumbnails: asset-library-image HISTORY_IMAGE_LIMITS). */
export const QUEUE_THUMBNAIL = Object.freeze({ edge: 384, pixels: 64 * 1024 * 1024, decodeSeconds: 5, quality: 76 });

/** get_queue_result variant thumbnail: decodes the saved original (already read and checked by the caller) and shrinks it. */
export const queueResultThumbnail: QueueResultThumbnail = async original => {
  const { data, info } = await sharp(original, { limitInputPixels: QUEUE_THUMBNAIL.pixels, failOn: 'warning' }).timeout({ seconds: QUEUE_THUMBNAIL.decodeSeconds })
    .rotate().resize({ width: QUEUE_THUMBNAIL.edge, height: QUEUE_THUMBNAIL.edge, fit: 'inside', withoutEnlargement: true }).webp({ quality: QUEUE_THUMBNAIL.quality }).toBuffer({ resolveWithObject: true });
  return { mimeType: 'image/webp', data, width: info.width, height: info.height };
};
