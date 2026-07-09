import { describe, it, expect } from 'vitest';
import { buildCountLookup, type GroupCounts } from './counts';

describe('buildCountLookup', () => {
  const group = (rowStart: number, counts: number[]): GroupCounts => ({
    rowStart,
    rowEnd: rowStart + counts.length,
    counts: Int32Array.from(counts),
  });

  it('resolves rows across several groups, given out of order', () => {
    // Two coarse row groups with a gap between them, deliberately unsorted so
    // the lookup's own sort is exercised.
    const lookup = buildCountLookup([group(100, [7, 1, 4000]), group(10, [1, 2, 3])])!;
    expect(lookup(10)).toBe(1);
    expect(lookup(12)).toBe(3);
    expect(lookup(100)).toBe(7);
    expect(lookup(102)).toBe(4000);
  });

  it('returns 0 for rows outside every group (finest band, gaps)', () => {
    const lookup = buildCountLookup([group(10, [5, 5]), group(100, [9])])!;
    expect(lookup(9)).toBe(0); // before the first group
    expect(lookup(12)).toBe(0); // in the gap
    expect(lookup(101)).toBe(0); // past the last group
  });

  it('returns 0 for a null (unknown) count stored as 0', () => {
    // readGroupCounts stores a null cell as 0, so the styling falls back to
    // the constant look for that row.
    const lookup = buildCountLookup([group(0, [0, 12])])!;
    expect(lookup(0)).toBe(0);
    expect(lookup(1)).toBe(12);
  });

  it('is null with no groups or only empty groups', () => {
    expect(buildCountLookup([])).toBeNull();
    expect(buildCountLookup([group(5, [])])).toBeNull();
  });

  it('hits exact group boundaries (rowEnd is exclusive)', () => {
    const lookup = buildCountLookup([group(0, [1, 2]), group(2, [3, 4])])!;
    expect(lookup(1)).toBe(2);
    expect(lookup(2)).toBe(3);
    expect(lookup(3)).toBe(4);
    expect(lookup(4)).toBe(0);
  });
});
