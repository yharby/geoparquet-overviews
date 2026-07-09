import { parquetRead } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { getCachedFile } from './file-cache';

// Density counts for coarse-band features, read from the column the footer's
// `count_column` names (0.3.0 density thinning writes `overview_count`). Each
// coarse-band row holds how many source features competed for that survivor's
// one-pixel thinning cell, itself included, so it is the signal that separates
// a 10,000-feature city cell from a 2-feature rural cell once both paint as a
// single survivor. The column is null on the finest band and on invalid rows;
// nulls read as 0 here, the "unknown" marker that styles as the constant
// fallback.

// One row group's counts plus the absolute row range they cover. counts[i] is
// the count of absolute row rowStart + i, 0 standing in for null.
export interface GroupCounts {
  rowStart: number;
  rowEnd: number;
  counts: Int32Array;
}

// Maps an absolute parquet row to its density count, or 0 when unknown.
export type CountForRow = (row: number) => number;

// Read one row group's count column as a whole-group columnar read, the same
// hyparquet path the geometry read uses but over a far smaller int32 chunk.
// The chunk clipping mirrors readColumnProgressive, a chunk may spill past the
// requested span, so index into it by its own rowStart.
export async function readGroupCounts(
  url: string,
  column: string,
  rowStart: number,
  rowEnd: number,
): Promise<Int32Array> {
  const { file, metadata } = await getCachedFile(url);
  const counts = new Int32Array(rowEnd - rowStart);
  await parquetRead({
    file,
    metadata,
    columns: [column],
    rowStart,
    rowEnd,
    compressors,
    utf8: false,
    onChunk: (chunk) => {
      const from = Math.max(rowStart, chunk.rowStart);
      const to = Math.min(rowEnd, chunk.rowEnd);
      const data = chunk.columnData;
      for (let r = from; r < to; r++) {
        const v = data[r - chunk.rowStart];
        // Null (finest band, invalid rows) stays 0, the unknown marker.
        if (v != null) counts[r - rowStart] = Number(v);
      }
    },
  });
  return counts;
}

// Build the row-to-count lookup over the fetched groups. Entries are sorted by
// rowStart and binary searched, so a lookup is O(log groups) per primitive with
// no per-call allocation. Returns null when no group carries counts, which
// callers treat as constant styling.
export function buildCountLookup(groups: GroupCounts[]): CountForRow | null {
  const entries = groups.filter((g) => g.counts.length > 0).sort((a, b) => a.rowStart - b.rowStart);
  if (entries.length === 0) return null;
  return (row) => {
    let lo = 0;
    let hi = entries.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const e = entries[mid];
      if (row < e.rowStart) hi = mid - 1;
      else if (row >= e.rowEnd) lo = mid + 1;
      else return e.counts[row - e.rowStart];
    }
    return 0;
  };
}
