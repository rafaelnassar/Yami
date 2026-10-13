/**
 * Virtualization math for fixed-size rows/grids (pure, unit-tested).
 */

export interface GridLayout {
  readonly columns: number;
  readonly itemWidth: number;
  readonly itemHeight: number;
  readonly rowHeight: number;
  readonly rowCount: number;
  readonly totalHeight: number;
}

export interface GridInput {
  readonly itemCount: number;
  readonly containerWidth: number;
  readonly minItemWidth: number;
  readonly gap: number;
  readonly maxColumns?: number;
  /** Item height as a function of the computed item width (e.g. square cover + footer). */
  readonly itemHeight: (itemWidth: number) => number;
}

/** Number of columns that fit `containerWidth` with items at least `minItemWidth` wide. */
export function columnsFor(containerWidth: number, minItemWidth: number, gap: number, maxColumns = Infinity): number {
  if (containerWidth <= 0 || minItemWidth <= 0) return 1;
  const fit = Math.floor((containerWidth + gap) / (minItemWidth + gap));
  return Math.max(1, Math.min(maxColumns, fit));
}

export function computeGridLayout(input: GridInput): GridLayout {
  const columns = columnsFor(input.containerWidth, input.minItemWidth, input.gap, input.maxColumns);
  const itemWidth = Math.max(0, (input.containerWidth - input.gap * (columns - 1)) / columns);
  const itemHeight = Math.max(1, Math.round(input.itemHeight(itemWidth)));
  const rowHeight = itemHeight + input.gap;
  const rowCount = Math.ceil(Math.max(0, input.itemCount) / columns);
  const totalHeight = rowCount === 0 ? 0 : rowCount * rowHeight - input.gap;
  return { columns, itemWidth, itemHeight, rowHeight, rowCount, totalHeight };
}

export interface VisibleRange {
  /** First row to render (inclusive). */
  readonly start: number;
  /** Last row to render (exclusive). */
  readonly end: number;
}

/** Rows intersecting the viewport, extended by `overscan` rows on each side. */
export function visibleRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  rowCount: number,
  overscan: number
): VisibleRange {
  if (rowCount <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const last = Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewportHeight)) / rowHeight);
  return {
    start: Math.max(0, Math.min(rowCount, first - overscan)),
    end: Math.max(0, Math.min(rowCount, last + overscan))
  };
}

/** Item indices `[from, to)` for a row range in a grid with `columns`. */
export function itemsInRows(
  range: VisibleRange,
  columns: number,
  itemCount: number
): { readonly from: number; readonly to: number } {
  return { from: Math.min(itemCount, range.start * columns), to: Math.min(itemCount, range.end * columns) };
}

export function itemOffset(
  index: number,
  columns: number,
  itemWidth: number,
  rowHeight: number,
  gap: number
): { readonly top: number; readonly left: number } {
  const row = Math.floor(index / columns);
  const column = index % columns;
  return { top: row * rowHeight, left: column * (itemWidth + gap) };
}

/** True when the viewport bottom is within `threshold` px of the content end. */
export function nearEnd(scrollTop: number, viewportHeight: number, totalHeight: number, threshold: number): boolean {
  return totalHeight > 0 && scrollTop + viewportHeight >= totalHeight - threshold;
}
