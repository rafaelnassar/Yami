import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { columnsFor, computeGridLayout, itemOffset, itemsInRows, nearEnd, visibleRange } from './virtual.ts';

describe('virtual grid math', () => {
  it('fits as many columns as the minimum width allows (at least one, at most maxColumns)', () => {
    assert.equal(columnsFor(1000, 200, 12), 4);
    assert.equal(columnsFor(150, 200, 12), 1);
    assert.equal(columnsFor(0, 200, 12), 1);
    assert.equal(columnsFor(2000, 200, 12, 4), 4);
  });

  it('computes item size, rows and total height', () => {
    const layout = computeGridLayout({
      itemCount: 10,
      containerWidth: 836,
      minItemWidth: 200,
      gap: 12,
      itemHeight: (w) => w + 64
    });
    assert.equal(layout.columns, 4);
    assert.equal(layout.itemWidth, 200);
    assert.equal(layout.itemHeight, 264);
    assert.equal(layout.rowHeight, 276);
    assert.equal(layout.rowCount, 3);
    assert.equal(layout.totalHeight, 3 * 276 - 12);
  });

  it('has no rows and zero height for empty lists', () => {
    const layout = computeGridLayout({
      itemCount: 0,
      containerWidth: 500,
      minItemWidth: 100,
      gap: 8,
      itemHeight: (w) => w
    });
    assert.equal(layout.rowCount, 0);
    assert.equal(layout.totalHeight, 0);
    assert.deepEqual(visibleRange(0, 500, layout.rowHeight, 0, 2), { start: 0, end: 0 });
  });

  it('returns the rows intersecting the viewport plus overscan, clamped', () => {
    assert.deepEqual(visibleRange(0, 300, 100, 50, 2), { start: 0, end: 5 });
    assert.deepEqual(visibleRange(1000, 300, 100, 50, 2), { start: 8, end: 15 });
    assert.deepEqual(visibleRange(4900, 300, 100, 50, 2), { start: 47, end: 50 });
    assert.deepEqual(visibleRange(-50, 300, 100, 50, 0), { start: 0, end: 3 });
  });

  it('maps rows to item indices and items to offsets', () => {
    assert.deepEqual(itemsInRows({ start: 2, end: 4 }, 3, 10), { from: 6, to: 10 });
    assert.deepEqual(itemOffset(5, 3, 100, 120, 10), { top: 120, left: 220 });
  });

  it('detects the end of the content', () => {
    assert.equal(nearEnd(700, 300, 1000, 50), true);
    assert.equal(nearEnd(100, 300, 1000, 50), false);
    assert.equal(nearEnd(0, 300, 0, 50), false);
  });
});
