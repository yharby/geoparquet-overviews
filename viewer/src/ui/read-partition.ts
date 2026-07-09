import type { RowGroupRange } from '../data/rowgroups';

// Build the read range for a single missing page of a page-pruned row group.
// One read range per page, so each page decodes and caches under its own key.
//
// The group's own geometry column MUST ride along. On a banded 0.3.0+ file a
// cumulative-prefix read at an overview level reads a coarser prefix group as
// exact `geometry` while the target band reads `geom_overview` (the fallback
// is version gated in columnForRowGroup, pre-0.3.0 files keep the per-level
// column), so the group carries its column rather than inheriting the plan's
// target column. Drop it
// here and readColumnProgressive falls back to the plan's target column: at an
// overview level the coarser group is then fetched from `geom_overview` yet
// cached under the exact `geometry` key (which is derived from the range's own
// column), so a later exact-zoom read at the same viewport hits that poisoned
// entry and paints grid-snapped overview geometry at fine zoom (giant triangles).
export function uncachedPageRange(
  range: RowGroupRange,
  page: { rowStart: number; rowEnd: number },
): RowGroupRange {
  return {
    index: range.index,
    rowStart: range.rowStart,
    rowEnd: range.rowEnd,
    column: range.column,
    subRanges: [page],
  };
}
