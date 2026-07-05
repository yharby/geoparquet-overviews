import { describe, it, expect } from 'vitest';
import {
  mergePageRanges,
  keptPageRanges,
  pairPageRanges,
  type PageRange,
  type ColumnIndexLike,
  type OffsetIndexLike,
} from './pageindex';
import type { Bbox } from '../geo/aoi';

// A page over a 1x1 tile at (col,row) in a grid, spanning 100 rows per page,
// laid out so consecutive pages are contiguous in the row index.
const page = (ordinal: number, xmin: number, xmax: number, ymin = 0, ymax = 1): PageRange => ({
  rowStart: ordinal * 100,
  rowEnd: ordinal * 100 + 100,
  bbox: { xmin, ymin, xmax, ymax },
});

describe('mergePageRanges', () => {
  it('keeps only pages whose bbox meets the AOI', () => {
    const pages = [page(0, 0, 1), page(1, 5, 6), page(2, 10, 11)];
    const aoi: Bbox = { xmin: 4.5, ymin: 0, xmax: 6.5, ymax: 1 };
    // Only page 1 overlaps.
    expect(mergePageRanges(pages, aoi)).toEqual([{ rowStart: 100, rowEnd: 200 }]);
  });

  it('merges adjacent kept pages into one contiguous range', () => {
    const pages = [page(0, 0, 1), page(1, 1, 2), page(2, 2, 3)];
    const aoi: Bbox = { xmin: 0, ymin: 0, xmax: 3, ymax: 1 };
    // All three overlap and are contiguous, so they collapse into one range.
    expect(mergePageRanges(pages, aoi)).toEqual([{ rowStart: 0, rowEnd: 300 }]);
  });

  it('splits into separate ranges when a dropped page leaves a gap', () => {
    // Pages 0 and 2 meet the AOI, page 1 does not, so the kept pages are not
    // contiguous and stay as two ranges (skipping page 1's bytes).
    const pages = [page(0, 0, 1), page(1, 20, 21), page(2, 0, 1)];
    const aoi: Bbox = { xmin: 0, ymin: 0, xmax: 1, ymax: 1 };
    expect(mergePageRanges(pages, aoi)).toEqual([
      { rowStart: 0, rowEnd: 100 },
      { rowStart: 200, rowEnd: 300 },
    ]);
  });

  it('drops everything when no page meets the AOI', () => {
    const pages = [page(0, 0, 1), page(1, 1, 2)];
    const aoi: Bbox = { xmin: 50, ymin: 50, xmax: 60, ymax: 60 };
    expect(mergePageRanges(pages, aoi)).toEqual([]);
  });

  it('sorts out-of-order pages before merging', () => {
    // Same three contiguous pages, supplied out of row order.
    const pages = [page(2, 2, 3), page(0, 0, 1), page(1, 1, 2)];
    const aoi: Bbox = { xmin: 0, ymin: 0, xmax: 3, ymax: 1 };
    expect(mergePageRanges(pages, aoi)).toEqual([{ rowStart: 0, rowEnd: 300 }]);
  });

  it('keeps a page that shares only an edge with the AOI', () => {
    // bboxIntersects is inclusive, so an edge touch counts as an overlap.
    const pages = [page(0, 0, 1)];
    const aoi: Bbox = { xmin: 1, ymin: 0, xmax: 2, ymax: 1 };
    expect(mergePageRanges(pages, aoi)).toEqual([{ rowStart: 0, rowEnd: 100 }]);
  });
});

describe('keptPageRanges', () => {
  const box = (xmin: number, xmax: number): PageRange['bbox'] => ({ xmin, ymin: 0, xmax, ymax: 1 });
  const pages: PageRange[] = [
    { rowStart: 0, rowEnd: 10, bbox: box(0, 1) },
    { rowStart: 10, rowEnd: 20, bbox: box(1, 2) },
    { rowStart: 20, rowEnd: 30, bbox: box(5, 6) },
  ];

  it('returns intersecting pages as individual unmerged ranges', () => {
    const aoi = { xmin: 0.5, ymin: 0, xmax: 1.5, ymax: 1 };
    expect(keptPageRanges(pages, aoi)).toEqual([
      { rowStart: 0, rowEnd: 10 },
      { rowStart: 10, rowEnd: 20 },
    ]);
  });

  it('does not merge adjacent kept pages', () => {
    const aoi = { xmin: 0, ymin: 0, xmax: 6, ymax: 1 };
    expect(keptPageRanges(pages, aoi)).toHaveLength(3);
  });
});

// V6. The four covering leaves must share page boundaries for the per-page
// bboxes to pair correctly with row ranges. These build synthetic column and
// offset index structures rather than read a real file.
describe('pairPageRanges', () => {
  const ci = (mins: number[], maxs: number[]): ColumnIndexLike => ({ min_values: mins, max_values: maxs });
  const oi = (firsts: number[]): OffsetIndexLike => ({
    page_locations: firsts.map((first_row_index) => ({ first_row_index })),
  });

  it('pairs pages when all four leaves share page boundaries', () => {
    const columnIndexes = {
      xmin: ci([0, 10], [0, 10]),
      ymin: ci([0, 20], [0, 20]),
      xmax: ci([5, 15], [5, 15]),
      ymax: ci([5, 25], [5, 25]),
    };
    const bounds = oi([0, 100]);
    const pages = pairPageRanges(
      columnIndexes,
      { xmin: bounds, ymin: bounds, xmax: bounds, ymax: bounds },
      1000,
      200,
      null,
    );
    expect(pages).not.toBeNull();
    expect(pages).toEqual([
      { rowStart: 1000, rowEnd: 1100, bbox: { xmin: 0, ymin: 0, xmax: 5, ymax: 5 } },
      { rowStart: 1100, rowEnd: 1200, bbox: { xmin: 10, ymin: 20, xmax: 15, ymax: 25 } },
    ]);
  });

  it('returns null when the leaves paginate to different page counts', () => {
    const columnIndexes = {
      xmin: ci([0, 10], [0, 10]),
      ymin: ci([0], [0]), // one page, not two
      xmax: ci([5, 15], [5, 15]),
      ymax: ci([5, 25], [5, 25]),
    };
    const two = oi([0, 100]);
    const one = oi([0]);
    const pages = pairPageRanges(
      columnIndexes,
      { xmin: two, ymin: one, xmax: two, ymax: two },
      0,
      200,
      null,
    );
    expect(pages).toBeNull();
  });

  it('returns null when page counts match but first_row_index boundaries differ', () => {
    // Equal page count does not imply equal boundaries. ymin split its second
    // page at row 90 instead of 100, so the per-page bboxes cannot pair.
    const columnIndexes = {
      xmin: ci([0, 10], [0, 10]),
      ymin: ci([0, 20], [0, 20]),
      xmax: ci([5, 15], [5, 15]),
      ymax: ci([5, 25], [5, 25]),
    };
    const pages = pairPageRanges(
      columnIndexes,
      { xmin: oi([0, 100]), ymin: oi([0, 90]), xmax: oi([0, 100]), ymax: oi([0, 100]) },
      0,
      200,
      null,
    );
    expect(pages).toBeNull();
  });
});
