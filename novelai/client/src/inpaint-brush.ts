export interface InpaintBrushPoint {
  x: number;
  y: number;
}

/** NovelAI's inpaint mask is drawn on a 1/8-resolution mask layer. */
export const INPAINT_MASK_GRID_SIZE = 8;
/** The official range slider covers 4..50 mask cells. */
export const INPAINT_BRUSH_SLIDER_MIN = 4;
export const INPAINT_BRUSH_SLIDER_MAX = 50;
/** Direct numeric entry is intentionally less restricted than the slider. */
export const INPAINT_BRUSH_DIRECT_MAX = 500;

export type InpaintBrushShapeValue = "round" | "square";

/**
 * Match the official mask editor's numeric input rules: square tips can be a
 * single 8px mask cell, while round tips are even-sized and at least 2 cells.
 */
export function normalizeInpaintBrushSize(
  value: number,
  shape: InpaintBrushShapeValue,
): number {
  const finite = Number.isFinite(value) ? value : INPAINT_BRUSH_SLIDER_MIN;
  const rounded = Math.round(finite);
  if (shape === "round") {
    return Math.max(2, Math.min(INPAINT_BRUSH_DIRECT_MAX, 2 * Math.round(rounded / 2)));
  }
  return Math.max(1, Math.min(INPAINT_BRUSH_DIRECT_MAX, rounded));
}

export function inpaintBrushSliderValue(value: number): number {
  return Math.max(
    INPAINT_BRUSH_SLIDER_MIN,
    Math.min(INPAINT_BRUSH_SLIDER_MAX, value),
  );
}

/** Integer-grid rasterization for the square tip. This mirrors a pixel editor:
 * every stamp is anchored to a source-image pixel and diagonal movement cannot
 * create fractional, feathered, or disconnected blocks. */
export function rasterizeInpaintGridSegment(
  from: InpaintBrushPoint,
  to: InpaintBrushPoint,
): InpaintBrushPoint[] {
  let x = Math.round(from.x);
  let y = Math.round(from.y);
  const targetX = Math.round(to.x);
  const targetY = Math.round(to.y);
  const deltaX = Math.abs(targetX - x);
  const deltaY = Math.abs(targetY - y);
  const stepX = x < targetX ? 1 : -1;
  const stepY = y < targetY ? 1 : -1;
  let error = deltaX - deltaY;
  const points: InpaintBrushPoint[] = [];

  while (true) {
    points.push({ x, y });
    if (x === targetX && y === targetY) break;
    const doubled = error * 2;
    if (doubled > -deltaY) {
      error -= deltaY;
      x += stepX;
    }
    if (doubled < deltaX) {
      error += deltaX;
      y += stepY;
    }
  }
  return points;
}
