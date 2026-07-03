import { readColumnIndex, readOffsetIndex } from 'hyparquet';
import type { ColumnChunk, RowGroup, SchemaElement } from 'hyparquet';
import { bboxIntersectsAoi, type Bbox } from '../geo/aoi';
import { reprojectBbox, type CoordTransform } from '../geo/crs';

// A single data page of a row group, tagged with its reprojected bbox and its
// ABSOLUTE file row range [rowStart, rowEnd). Page-level pruning keeps only the
// pages whose bbox meets the viewport, so hyparquet fetches a fraction of a
// large row group's geometry column instead of the whole chunk.
export interface PageRange {
  rowStart: number;
  rowEnd: number;
  bbox: Bbox;
}

// Dotted covering paths for the primary column's bbox struct, e.g.
// ['bbox','xmin']. These carry a ColumnIndex (per-page min/max) and an
// OffsetIndex (per-page first row + byte offset) in our converter output.
export interface CoveringPaths {
  xmin: string[];
  ymin: string[];
  xmax: string[];
  ymax: string[];
}

// The minimal slice surface the page reader needs. Both the hyparquet
// AsyncBuffer and the viewer's AsyncBuffer satisfy it.
interface SliceSource {
  slice(start: number, end?: number): Promise<ArrayBuffer> | ArrayBuffer;
}

function pathsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((part, i) => part === b[i]);
}

function findChunk(rowGroup: RowGroup, path: string[]): ColumnChunk | undefined {
  return rowGroup.columns.find((c) => c.meta_data && pathsEqual(c.meta_data.path_in_schema, path));
}

async function toReader(source: SliceSource, start: number, length: number) {
  const buffer = await source.slice(start, start + length);
  return { view: new DataView(buffer), offset: 0 };
}

// A minimal DOUBLE schema element is enough for readColumnIndex to convert the
// covering column's min/max values to JS numbers, so a real SchemaElement is
// optional. The covering leaves are always DOUBLE in our converter output.
function schemaForLeaf(path: string[], lookup?: Map<string, SchemaElement>): SchemaElement {
  const name = path[path.length - 1];
  return lookup?.get(name) ?? ({ type: 'DOUBLE', name } as SchemaElement);
}

// Build per-page bboxes and absolute row ranges for one row group from the
// covering columns' ColumnIndex and OffsetIndex. Returns null (so the caller
// falls back to a whole-group read) when the covering columns lack the page
// indexes, when the four columns disagree on page count or on their per-page
// row boundaries, or on any read error, so the page path can never break a
// fetch.
export async function pageRangesForRowGroup(
  file: SliceSource,
  rawRowGroup: RowGroup,
  coveringPaths: CoveringPaths,
  groupRowOffset: number,
  groupRowCount: number,
  transform: CoordTransform | null,
  schemaLookup?: Map<string, SchemaElement>,
): Promise<PageRange[] | null> {
  try {
    const chunks = {
      xmin: findChunk(rawRowGroup, coveringPaths.xmin),
      ymin: findChunk(rawRowGroup, coveringPaths.ymin),
      xmax: findChunk(rawRowGroup, coveringPaths.xmax),
      ymax: findChunk(rawRowGroup, coveringPaths.ymax),
    };
    if (!chunks.xmin || !chunks.ymin || !chunks.xmax || !chunks.ymax) return null;
    for (const c of [chunks.xmin, chunks.ymin, chunks.xmax, chunks.ymax]) {
      if (c.column_index_offset == null || !c.column_index_length) return null;
      if (c.offset_index_offset == null || !c.offset_index_length) return null;
    }

    const [xminCI, yminCI, xmaxCI, ymaxCI, xminOI, yminOI, xmaxOI, ymaxOI] = await Promise.all([
      toReader(file, Number(chunks.xmin.column_index_offset), chunks.xmin.column_index_length!).then((r) =>
        readColumnIndex(r, schemaForLeaf(coveringPaths.xmin, schemaLookup)),
      ),
      toReader(file, Number(chunks.ymin.column_index_offset), chunks.ymin.column_index_length!).then((r) =>
        readColumnIndex(r, schemaForLeaf(coveringPaths.ymin, schemaLookup)),
      ),
      toReader(file, Number(chunks.xmax.column_index_offset), chunks.xmax.column_index_length!).then((r) =>
        readColumnIndex(r, schemaForLeaf(coveringPaths.xmax, schemaLookup)),
      ),
      toReader(file, Number(chunks.ymax.column_index_offset), chunks.ymax.column_index_length!).then((r) =>
        readColumnIndex(r, schemaForLeaf(coveringPaths.ymax, schemaLookup)),
      ),
      toReader(file, Number(chunks.xmin.offset_index_offset), chunks.xmin.offset_index_length!).then((r) =>
        readOffsetIndex(r),
      ),
      toReader(file, Number(chunks.ymin.offset_index_offset), chunks.ymin.offset_index_length!).then((r) =>
        readOffsetIndex(r),
      ),
      toReader(file, Number(chunks.xmax.offset_index_offset), chunks.xmax.offset_index_length!).then((r) =>
        readOffsetIndex(r),
      ),
      toReader(file, Number(chunks.ymax.offset_index_offset), chunks.ymax.offset_index_length!).then((r) =>
        readOffsetIndex(r),
      ),
    ]);

    return pairPageRanges(
      { xmin: xminCI, ymin: yminCI, xmax: xmaxCI, ymax: ymaxCI },
      { xmin: xminOI, ymin: yminOI, xmax: xmaxOI, ymax: ymaxOI },
      groupRowOffset,
      groupRowCount,
      transform,
    );
  } catch {
    return null;
  }
}

// The minimal ColumnIndex and OffsetIndex shapes pairPageRanges reads. Keeping
// them local lets the pairing logic be unit tested with synthetic structures.
export interface ColumnIndexLike {
  min_values: unknown[];
  max_values: unknown[];
  null_pages?: boolean[];
}

export interface OffsetIndexLike {
  page_locations: { first_row_index: number | bigint }[];
}

// Pair the four covering leaves' per-page bounds with a single row range per
// page. Parquet paginates each column chunk independently, so equal page counts
// do NOT imply equal page boundaries. This returns null (falling back to a
// whole-group read) when the four leaves disagree on page count, or when their
// per-page first_row_index arrays are not elementwise equal, because otherwise a
// per-page bbox would pair with the wrong row range and could prune away pages
// that actually meet the view.
export function pairPageRanges(
  columnIndexes: {
    xmin: ColumnIndexLike;
    ymin: ColumnIndexLike;
    xmax: ColumnIndexLike;
    ymax: ColumnIndexLike;
  },
  offsetIndexes: {
    xmin: OffsetIndexLike;
    ymin: OffsetIndexLike;
    xmax: OffsetIndexLike;
    ymax: OffsetIndexLike;
  },
  groupRowOffset: number,
  groupRowCount: number,
  transform: CoordTransform | null,
): PageRange[] | null {
  const { xmin: xminCI, ymin: yminCI, xmax: xmaxCI, ymax: ymaxCI } = columnIndexes;
  const pageCount = xminCI.min_values.length;
  if (
    yminCI.min_values.length !== pageCount ||
    xmaxCI.max_values.length !== pageCount ||
    ymaxCI.max_values.length !== pageCount
  ) {
    return null;
  }

  const ois = [offsetIndexes.xmin, offsetIndexes.ymin, offsetIndexes.xmax, offsetIndexes.ymax];
  for (const oi of ois) {
    if (oi.page_locations.length !== pageCount) return null;
  }
  // Require the four leaves to share identical page boundaries. If any leaf
  // paginated differently, the per-page bboxes cannot be paired to one row
  // range, so return null and let the caller read the whole group.
  for (let p = 0; p < pageCount; p++) {
    const first = Number(offsetIndexes.xmin.page_locations[p].first_row_index);
    for (const oi of [offsetIndexes.ymin, offsetIndexes.xmax, offsetIndexes.ymax]) {
      if (Number(oi.page_locations[p].first_row_index) !== first) return null;
    }
  }

  const oi = offsetIndexes.xmin;
  const pages: PageRange[] = [];
  for (let p = 0; p < pageCount; p++) {
    const first = Number(oi.page_locations[p].first_row_index);
    const nextFirst = p + 1 < pageCount ? Number(oi.page_locations[p + 1].first_row_index) : groupRowCount;
    // A page hyparquet marks fully null carries no usable bounds, so keep it
    // with an infinite bbox rather than risk pruning away real rows.
    const nullPage = xminCI.null_pages?.[p];
    const rawBbox: Bbox = nullPage
      ? { xmin: -Infinity, ymin: -Infinity, xmax: Infinity, ymax: Infinity }
      : {
          xmin: Number(xminCI.min_values[p]),
          ymin: Number(yminCI.min_values[p]),
          xmax: Number(xmaxCI.max_values[p]),
          ymax: Number(ymaxCI.max_values[p]),
        };
    pages.push({
      rowStart: groupRowOffset + first,
      rowEnd: groupRowOffset + nextFirst,
      bbox: nullPage ? rawBbox : reprojectBbox(rawBbox, transform),
    });
  }
  return pages;
}

// Keep pages whose bbox meets the AOI and merge adjacent or contiguous kept
// pages into the fewest contiguous [rowStart, rowEnd) ranges. A gap between kept
// pages (a dropped page in between) splits the ranges, so hyparquet skips the
// dropped page's bytes.
export function mergePageRanges(pages: PageRange[], aoi: Bbox): { rowStart: number; rowEnd: number }[] {
  const kept = pages
    .filter((p) => bboxIntersectsAoi(p.bbox, aoi))
    .sort((a, b) => a.rowStart - b.rowStart);
  const ranges: { rowStart: number; rowEnd: number }[] = [];
  for (const page of kept) {
    const last = ranges[ranges.length - 1];
    if (last && page.rowStart <= last.rowEnd) {
      last.rowEnd = Math.max(last.rowEnd, page.rowEnd);
    } else {
      ranges.push({ rowStart: page.rowStart, rowEnd: page.rowEnd });
    }
  }
  return ranges;
}
