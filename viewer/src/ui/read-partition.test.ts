import { describe, it, expect } from 'vitest';
import { uncachedPageRange } from './read-partition';
import type { RowGroupRange } from '../data/rowgroups';

describe('uncachedPageRange', () => {
  // Regression: the per-page read range must carry the group's own column.
  // On a banded 0.3.0+ file a coarser prefix group read at an overview level
  // names 'geometry' (exact) even though the plan target is 'geom_overview'
  // (the fallback is version gated in columnForRowGroup, pre-0.3.0 files keep
  // the per-level column). If the column were dropped,
  // readColumnProgressive would fall back to the target 'geom_overview', fetch
  // overview bytes, and cache them under the exact 'geometry' key, poisoning a
  // later exact read at the same viewport (grid-snapped overview at fine zoom).
  it('preserves the range column for a page-pruned exact prefix group', () => {
    const range: RowGroupRange = {
      index: 68,
      rowStart: 1_200_000,
      rowEnd: 1_260_000,
      column: 'geometry',
      pages: [{ rowStart: 1_218_734, rowEnd: 1_235_118 }],
    };
    const out = uncachedPageRange(range, { rowStart: 1_218_734, rowEnd: 1_235_118 });
    expect(out.column).toBe('geometry');
    expect(out.subRanges).toEqual([{ rowStart: 1_218_734, rowEnd: 1_235_118 }]);
    expect(out.index).toBe(68);
    expect(out.rowStart).toBe(1_200_000);
    expect(out.rowEnd).toBe(1_260_000);
  });

  it('carries an overview column through unchanged', () => {
    const range: RowGroupRange = {
      index: 135,
      rowStart: 0,
      rowEnd: 100,
      column: 'geom_overview',
    };
    const out = uncachedPageRange(range, { rowStart: 10, rowEnd: 20 });
    expect(out.column).toBe('geom_overview');
  });

  it('leaves column undefined when the range has none (flat path)', () => {
    const range: RowGroupRange = { index: 1, rowStart: 0, rowEnd: 50 };
    const out = uncachedPageRange(range, { rowStart: 0, rowEnd: 25 });
    expect(out.column).toBeUndefined();
  });
});
