/**
 * Virtualized grid with fixed item size (height derived from the column width).
 * Only rows intersecting the viewport (+ overscan) are mounted, so libraries and
 * conversations with thousands of files stay cheap to render and scroll.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useElementSize } from '../hooks/useElementSize.ts';
import { computeGridLayout, itemOffset, itemsInRows, nearEnd, visibleRange } from '../lib/virtual.ts';

export interface VirtualGridProps<T> {
  readonly items: readonly T[];
  readonly getKey: (item: T, index: number) => string;
  /** `itemWidth` is the laid-out column width in CSS pixels (e.g. to pick a thumbnail size). */
  readonly renderItem: (item: T, index: number, itemWidth: number) => ReactNode;
  readonly minItemWidth: number;
  readonly itemHeight: (itemWidth: number) => number;
  readonly gap?: number;
  readonly maxColumns?: number;
  readonly overscanRows?: number;
  readonly ariaLabel: string;
  readonly className?: string;
  /** Called when the user scrolls near the end (load the next page). */
  readonly onEndReached?: () => void;
  readonly footer?: ReactNode;
  /** Changing it scrolls back to the top (e.g. a new folder was opened). */
  readonly resetKey?: string;
}

export function VirtualGrid<T>({
  items,
  getKey,
  renderItem,
  minItemWidth,
  itemHeight,
  gap = 12,
  maxColumns,
  overscanRows = 2,
  ariaLabel,
  className = '',
  onEndReached,
  footer,
  resetKey
}: VirtualGridProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const viewport = useElementSize(scrollRef);
  const grid = useElementSize(gridRef);
  const [scrollTop, setScrollTop] = useState(0);

  const layout = useMemo(
    () =>
      computeGridLayout({
        itemCount: items.length,
        containerWidth: grid.width,
        minItemWidth,
        gap,
        itemHeight,
        ...(maxColumns ? { maxColumns } : {})
      }),
    [gap, grid.width, itemHeight, items.length, maxColumns, minItemWidth]
  );

  const gridTop = gridRef.current?.offsetTop ?? 0;
  const range = visibleRange(scrollTop - gridTop, viewport.height, layout.rowHeight, layout.rowCount, overscanRows);
  const { from, to } = itemsInRows(range, layout.columns, items.length);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    setScrollTop(0);
  }, [resetKey]);

  const endReached = nearEnd(scrollTop - gridTop, viewport.height, layout.totalHeight, layout.rowHeight * 2);
  useEffect(() => {
    if (endReached && onEndReached) onEndReached();
  }, [endReached, items.length, onEndReached]);

  const visible: ReactNode[] = [];
  for (let index = from; index < to; index += 1) {
    const item = items[index];
    if (item === undefined) continue;
    const offset = itemOffset(index, layout.columns, layout.itemWidth, layout.rowHeight, gap);
    visible.push(
      <div
        key={getKey(item, index)}
        role="listitem"
        aria-posinset={index + 1}
        aria-setsize={items.length}
        className="absolute"
        style={{ top: offset.top, left: offset.left, width: layout.itemWidth, height: layout.itemHeight }}
      >
        {renderItem(item, index, layout.itemWidth)}
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className={`relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain ${className}`}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div
        ref={gridRef}
        role="list"
        aria-label={ariaLabel}
        className="relative w-full"
        style={{ height: layout.totalHeight }}
      >
        {grid.width > 0 ? visible : null}
      </div>
      {footer}
    </div>
  );
}
