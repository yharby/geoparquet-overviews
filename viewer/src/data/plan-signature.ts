import type { RowGroupRange } from './rowgroups';

// A stable, order-independent identity for a resolved read plan (the column plus
// the per-group row ranges actually read). Two fetches with the same signature
// paint identical pixels, so the caller can skip the whole teardown and rebuild.
// A whole-group read encodes as 'full' and a page-pruned group encodes its sorted
// sub-ranges, so the two never collide for the same group. Each group also
// encodes its own column, since a cumulative-prefix read mixes overview and
// exact geometry across bands and a group read as exact must not match the same
// group read as overview.
export function planSignature(column: string, ranges: RowGroupRange[]): string {
  const parts = ranges.map((r) => {
    const sub = r.subRanges ? r.subRanges.map((s) => `${s.rowStart}-${s.rowEnd}`).join(',') : 'full';
    return `${r.index}:${r.column ?? column}:${sub}`;
  });
  parts.sort();
  return `${column}|${parts.join('|')}`;
}
