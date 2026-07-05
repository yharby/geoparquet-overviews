import type { RowGroupRange } from './rowgroups';

// A stable, order-independent identity for a resolved read plan (the column plus
// the per-group row ranges actually read). Two fetches with the same signature
// paint identical pixels, so the caller can skip the whole teardown and rebuild.
// The per-range part mirrors the flat-cache key's rangeSignature so a whole-group
// read ('full') never collides with a page-pruned sub-range set.
export function planSignature(column: string, ranges: RowGroupRange[]): string {
  const parts = ranges.map((r) => {
    const sub = r.subRanges ? r.subRanges.map((s) => `${s.rowStart}-${s.rowEnd}`).join(',') : 'full';
    return `${r.index}:${sub}`;
  });
  parts.sort();
  return `${column}|${parts.join('|')}`;
}
