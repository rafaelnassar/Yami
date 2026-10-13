/** Image zoom/pan math for the preview (pure). */

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 3;
export const ZOOM_STEP = 0.15;

export function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))));
}

/** Wheel up zooms in, wheel down zooms out. */
export function zoomFromWheel(current: number, deltaY: number): number {
  return clampZoom(current + (deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
}

/**
 * Keeps the scaled image covering the viewport: the pan offset (in unscaled
 * pixels) cannot exceed half of the overflow on each axis.
 */
export function clampPan(
  x: number,
  y: number,
  zoom: number,
  viewportWidth: number,
  viewportHeight: number,
  baseWidth: number,
  baseHeight: number
): { x: number; y: number } {
  if (zoom <= 1 || baseWidth <= 0 || baseHeight <= 0) return { x: 0, y: 0 };
  const maxX = Math.max(0, (baseWidth * zoom - viewportWidth) / (2 * zoom));
  const maxY = Math.max(0, (baseHeight * zoom - viewportHeight) / (2 * zoom));
  return { x: Math.min(maxX, Math.max(-maxX, x)), y: Math.min(maxY, Math.max(-maxY, y)) };
}
