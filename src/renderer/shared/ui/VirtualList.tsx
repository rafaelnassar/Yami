/** Virtualized single-column list with fixed row height. */
import { useRef, useState, type ReactNode } from 'react';
import { useElementSize } from '../hooks/useElementSize.ts';
import { visibleRange } from '../lib/virtual.ts';

export interface VirtualListProps<T> {
  readonly items: readonly T[];
  readonly rowHeight: number;
  readonly getKey: (item: T, index: number) => string;
  readonly renderItem: (item: T, index: number) => ReactNode;
  readonly ariaLabel: string;
  readonly overscan?: number;
  readonly className?: string;
}

export function VirtualList<T>({
  items,
  rowHeight,
  getKey,
  renderItem,
  ariaLabel,
  overscan = 6,
  className = ''
}: VirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewport = useElementSize(scrollRef);
  const [scrollTop, setScrollTop] = useState(0);
  const range = visibleRange(scrollTop, viewport.height, rowHeight, items.length, overscan);

  const rows: ReactNode[] = [];
  for (let index = range.start; index < range.end; index += 1) {
    const item = items[index];
    if (item === undefined) continue;
    rows.push(
      <div
        key={getKey(item, index)}
        role="listitem"
        aria-posinset={index + 1}
        aria-setsize={items.length}
        className="absolute inset-x-0"
        style={{ top: index * rowHeight, height: rowHeight }}
      >
        {renderItem(item, index)}
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className={`min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain ${className}`}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div role="list" aria-label={ariaLabel} className="relative w-full" style={{ height: items.length * rowHeight }}>
        {rows}
      </div>
    </div>
  );
}
