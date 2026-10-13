/** Pure window geometry: work-area clamping and tray panel placement. */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export type PanelAnchor = 'above' | 'below';

const EDGE_PAD = 6;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

/** Fits `bounds` inside `work` (respecting a minimum size); returns `null` when nothing changes. */
export function clampToWorkArea(bounds: Rect, work: Rect, min: Size): Rect | null {
  const width = clamp(bounds.width, Math.min(min.width, work.width), work.width);
  const height = clamp(bounds.height, Math.min(min.height, work.height), work.height);
  const x = clamp(bounds.x, work.x, work.x + work.width - width);
  const y = clamp(bounds.y, work.y, work.y + work.height - height);
  if (x === bounds.x && y === bounds.y && width === bounds.width && height === bounds.height) return null;
  return { x, y, width, height };
}

export interface PanelPlacementInput {
  /** Tray icon bounds; `null`/empty on Linux where they are usually unknown. */
  readonly trayBounds: Rect | null;
  readonly cursor: Point;
  readonly work: Rect;
  readonly size: Size;
}

export interface PanelPlacement {
  readonly x: number;
  readonly y: number;
  readonly anchor: PanelAnchor;
}

/**
 * Places the quick panel next to the tray icon: above it (taskbar at the bottom) or
 * below it when there is no room (taskbar/menu bar at the top). Without tray bounds the
 * cursor x and the work-area bottom are used.
 */
export function placePanelNearTray(input: PanelPlacementInput): PanelPlacement {
  const { work, size } = input;
  const tray = input.trayBounds && input.trayBounds.width > 0 && input.trayBounds.height > 0 ? input.trayBounds : null;
  const anchorX = tray ? tray.x + tray.width / 2 : input.cursor.x;

  let anchor: PanelAnchor = 'above';
  let y = tray ? tray.y - size.height - EDGE_PAD : work.y + work.height - size.height - EDGE_PAD;
  if (y < work.y) {
    anchor = 'below';
    y = tray ? tray.y + tray.height + EDGE_PAD : work.y + EDGE_PAD;
  }
  const x = Math.round(clamp(anchorX - size.width / 2, work.x + EDGE_PAD, work.x + work.width - size.width - EDGE_PAD));
  y = Math.round(clamp(y, work.y + EDGE_PAD, work.y + work.height - size.height - EDGE_PAD));
  return { x, y, anchor };
}
