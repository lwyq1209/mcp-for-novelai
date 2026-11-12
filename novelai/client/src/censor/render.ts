import { CENSORED_EXPORT_LIMITS } from './export-types';
import { blurSizeOf, hasCensoring, mosaicCells, mosaicSizeOf, type CensorSettings, type CensorStroke } from './model';

/**
 * Canvas drawing of the censored JPG export. The editor's live view and the export call the same functions, so the
 * saved file is what the editor shows.
 *
 * base    the image on white (JPEG has no transparency), at its own size
 * layer   the whole image censored (mosaic, blur or a flat colour)
 * mask    the strokes, opaque where the image is to be covered
 * overlay the layer cut to the mask (soft edge included); drawn over the base it gives the result
 */
export type CensorImageFailure = 'too_large' | 'unreadable';
export class CensorImageError extends Error { constructor(readonly failure: CensorImageFailure) { super(failure); } }

export function canvasOf(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  return canvas;
}
export function contextOf(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) throw new CensorImageError('unreadable');
  return context;
}

const readUrl = async (url: string) => { const response = await fetch(url); if (!response.ok) throw new Error('unreadable'); return response.arrayBuffer(); };

/** The image at `url`, upright (EXIF orientation applied), in sRGB, on white. Only its pixels are read. */
export async function loadBase(url: string, read: (url: string) => Promise<ArrayBuffer> = readUrl): Promise<HTMLCanvasElement> {
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(new Blob([await read(url)])); } catch { throw new CensorImageError('unreadable'); }
  try {
    if (bitmap.width < 1 || bitmap.height < 1) throw new CensorImageError('unreadable');
    if (bitmap.width * bitmap.height > CENSORED_EXPORT_LIMITS.pixels) throw new CensorImageError('too_large');
    const canvas = canvasOf(bitmap.width, bitmap.height), context = contextOf(canvas);
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0);
    return canvas;
  } finally { bitmap.close(); }
}

/** The whole image censored in the chosen way. */
export function buildLayer(base: HTMLCanvasElement, settings: CensorSettings): HTMLCanvasElement {
  const { width, height } = base;
  const layer = canvasOf(width, height), context = contextOf(layer);
  if (settings.style === 'black' || settings.style === 'white') {
    context.fillStyle = settings.style === 'black' ? '#000' : '#fff';
    context.fillRect(0, 0, width, height);
    return layer;
  }
  if (settings.style === 'blur') {
    const soft = canvasOf(width, height), softContext = contextOf(soft);
    softContext.filter = `blur(${blurSizeOf(settings, width, height)}px)`;
    softContext.drawImage(base, 0, 0);
    // A blur fades out towards the image's border (nothing lies beyond it). Drawn several times it is opaque there
    // again with the right colour; the sharp image underneath only fills what is still left of the last fraction.
    context.drawImage(base, 0, 0);
    for (let pass = 0; pass < 6; pass++) context.drawImage(soft, 0, 0);
    return layer;
  }
  const block = mosaicSizeOf(settings, width, height);
  const cells = mosaicCells(contextOf(base).getImageData(0, 0, width, height).data, width, height, block);
  const small = canvasOf(cells.width, cells.height);
  contextOf(small).putImageData(new ImageData(cells.data as Uint8ClampedArray<ArrayBuffer>, cells.width, cells.height), 0, 0);
  context.imageSmoothingEnabled = false;
  context.drawImage(small, 0, 0, cells.width * block, cells.height * block);
  return layer;
}

/** A curve through the points (x0, y0, x1, y1 …): each point steers, the curve passes through the midpoints. */
function tracePath(context: CanvasRenderingContext2D, points: readonly number[], closed: boolean) {
  const count = points.length >> 1;
  const x = (index: number) => points[(index % count) * 2], y = (index: number) => points[(index % count) * 2 + 1];
  if (closed) {
    context.moveTo((x(count - 1) + x(0)) / 2, (y(count - 1) + y(0)) / 2);
    for (let index = 0; index < count; index++) context.quadraticCurveTo(x(index), y(index), (x(index) + x(index + 1)) / 2, (y(index) + y(index + 1)) / 2);
    context.closePath();
    return;
  }
  context.moveTo(x(0), y(0));
  for (let index = 1; index < count - 1; index++) context.quadraticCurveTo(x(index), y(index), (x(index) + x(index + 1)) / 2, (y(index) + y(index + 1)) / 2);
  context.lineTo(x(count - 1), y(count - 1));
}

/** Adds one stroke to the mask. */
export function drawStroke(context: CanvasRenderingContext2D, stroke: CensorStroke, width: number, height: number) {
  if (stroke.tool === 'clear') { context.clearRect(0, 0, width, height); return; }
  const points = stroke.points, count = points.length >> 1;
  if (!count) return;
  context.save();
  context.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
  context.fillStyle = context.strokeStyle = '#000';
  context.beginPath();
  if (stroke.tool === 'lasso') {
    if (count >= 3) { tracePath(context, points, true); context.fill(); }
  } else if (count === 1) {
    context.arc(points[0], points[1], stroke.size / 2, 0, Math.PI * 2);
    context.fill();
  } else {
    context.lineWidth = stroke.size; context.lineCap = 'round'; context.lineJoin = 'round';
    tracePath(context, points, false);
    context.stroke();
  }
  context.restore();
}

export function paintMask(mask: HTMLCanvasElement, strokes: readonly CensorStroke[]) {
  const context = contextOf(mask);
  context.clearRect(0, 0, mask.width, mask.height);
  for (const stroke of strokes) drawStroke(context, stroke, mask.width, mask.height);
}

/** The layer where the mask is, with `feather` pixels of soft edge. */
export function composeOverlay(overlay: HTMLCanvasElement, mask: HTMLCanvasElement, layer: HTMLCanvasElement, feather: number) {
  const context = contextOf(overlay);
  context.globalCompositeOperation = 'source-over';
  context.clearRect(0, 0, overlay.width, overlay.height);
  context.filter = feather > 0 ? `blur(${feather / 2}px)` : 'none';
  context.drawImage(mask, 0, 0);
  context.filter = 'none';
  context.globalCompositeOperation = 'source-in';
  context.drawImage(layer, 0, 0);
  context.globalCompositeOperation = 'source-over';
}

/** The finished picture: RGBA pixels, opaque. */
export function renderCensored(base: HTMLCanvasElement, strokes: readonly CensorStroke[], settings: CensorSettings): ImageData {
  const { width, height } = base;
  if (!hasCensoring({ strokes: [...strokes], redo: [] })) return contextOf(base).getImageData(0, 0, width, height);
  const mask = canvasOf(width, height), overlay = canvasOf(width, height), out = canvasOf(width, height);
  paintMask(mask, strokes);
  composeOverlay(overlay, mask, buildLayer(base, settings), settings.feather);
  const context = contextOf(out);
  context.drawImage(base, 0, 0);
  context.drawImage(overlay, 0, 0);
  return context.getImageData(0, 0, width, height);
}
