import { parquetRead, type ParquetParsers } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { withPhase } from '../core/phase';
import { getCachedFile } from './file-cache';
import type { AsyncBuffer } from './byte-cache';

// Override hyparquet's WKB decode with identity, so the geometry column yields
// zero-copy Uint8Array views into the decompressed pages instead of GeoJSON
// objects. hyparquet merges these over its DEFAULT_PARSERS, so a partial
// override is enough; the cast satisfies the full-interface option type.
export const RAW_WKB_PARSERS = {
  geometryFromBytes: (bytes: Uint8Array) => bytes,
  geographyFromBytes: (bytes: Uint8Array) => bytes,
} as unknown as ParquetParsers;

export interface RowGroupRange {
  index: number;
  rowStart: number;
  rowEnd: number;
  // When present, the row group is read as these page-pruned sub-ranges (each an
  // absolute [rowStart, rowEnd)) with the offset index, instead of the whole
  // [rowStart, rowEnd) span. All sub-ranges of one group are read then painted
  // as a single batch, so the byte meter and panels still see one row group.
  subRanges?: { rowStart: number; rowEnd: number }[];
  // The individual kept pages (unmerged), the stable per-page flat-cache units,
  // set alongside subRanges for a page-pruned group. subRanges stays the
  // coalesced fetch spans, pages is what the flat cache keys on.
  pages?: { rowStart: number; rowEnd: number }[];
}

// One row group's read result: the kept geometry values and their absolute
// parquet rows, aligned index for index. The rows travel with the geometry so
// the decoder can stamp each rendered primitive with its source row.
interface GroupValues {
  geometries: unknown[];
  rows: number[];
}

// The cached file handle for a url, so the page-index reader can slice the
// ColumnIndex and OffsetIndex byte ranges over the same range-request buffer the
// column reads use, without re-probing the file.
export async function getFileForUrl(url: string): Promise<AsyncBuffer> {
  return (await getCachedFile(url)).file;
}

// Up to this many row-group reads are in flight at once. A low-zoom overview can
// touch dozens of small coarse row groups, and reading them one at a time pays a
// full network round trip per group, so a whole-extent preview stalls on latency
// rather than bandwidth. Reading a bounded batch concurrently collapses those
// round trips into a few waves. The hosted files are served over HTTP/2 which
// multiplexes many requests over one connection, so the old HTTP/1.1 per-host
// connection ceiling no longer bounds useful concurrency. The shared byte budget
// still caps how many large chunks sit resident at once.
const MAX_CONCURRENT_READS = 16;

// Reads a single column of the given row groups over HTTP range requests,
// concurrently up to MAX_CONCURRENT_READS, and hands each finished group to
// onBatch. hyparquet range-reads just the requested column chunk for each row
// range, so a coarse overview costs a few MB instead of the full geometry
// column, which is the whole point of the overview path.
//
// The reads run in parallel but onBatch is called strictly one group at a time,
// serialized through a promise chain. onBatch decodes and paints into shared
// mutable caller state (running feature counts, deck.gl layers, the flat cache),
// which is not safe to interleave, and decode plus GPU upload is main-thread work
// anyway, so only the network fetch is worth parallelizing. Groups therefore
// paint in completion order, not request order, which is fine since each carries
// its own row-group index.
//
// The read goes through hyparquet's columnar path (parquetRead with onChunk, no
// onComplete), so the geometry column arrives as a plain array of values with no
// per-row {column: value} wrapper and no row transpose. With RAW_WKB_PARSERS the
// GEOMETRY logical type hyparquet honors on the registered GeoParquet geometry
// and overview columns yields raw WKB Uint8Arrays, which onBatch's decoder scans
// straight into flat buffers.
//
// utf8 is set false so hyparquet does not decode bare BYTE_ARRAY columns as utf8
// strings. Per hyparquet's types an onChunk chunk may contain data outside the
// requested range, so each chunk is clipped to [span.rowStart, span.rowEnd) using
// the chunk's own rowStart/rowEnd.
// shouldStop is polled before each group read, each page sub-range, and each
// paint, so a view superseded by a newer pan or zoom abandons the read at the
// next boundary instead of reading every remaining group. hyparquet itself takes
// no abort signal, so cancellation is cooperative at the row-group grain: any
// in-flight reads finish, then the workers return. A read error aborts the whole
// batch so the caller's failure handler runs once, not once per worker.
export async function readColumnProgressive(
  url: string,
  ranges: RowGroupRange[],
  column: string,
  onBatch: (geometries: unknown[], rows: number[], indices: number[]) => void | Promise<void>,
  shouldStop?: () => boolean,
): Promise<void> {
  const { file, metadata } = await getCachedFile(url);

  // A worker that hits an error trips this so the others stop pulling new groups,
  // turning one failure into a single rejection rather than a storm of them.
  let aborted = false;
  const stopped = () => aborted || (shouldStop?.() ?? false);

  // Read one whole row group (all its page sub-ranges) into a flat value array.
  // Returns null if cancellation tripped mid-read, so its partial result is
  // never painted.
  const readGroup = async (range: RowGroupRange): Promise<GroupValues | null> => {
    // A page-pruned group reads its sub-ranges, otherwise the whole group span.
    // useOffsetIndex is a no-op for a whole-group span (the range covers the
    // group, so hyparquet reads the whole chunk) and only prunes pages for a
    // sub-range, so it is safe to set for every read.
    const spans = range.subRanges ?? [{ rowStart: range.rowStart, rowEnd: range.rowEnd }];
    const geometries: unknown[] = [];
    // The absolute parquet row of each kept geometry, aligned with `geometries`.
    // Nulls are dropped so the array index is not the row ordinal, so the row is
    // tracked here explicitly and carried to onBatch, where the flattener stamps
    // it onto every rendered primitive for pick-to-row resolution.
    const rows: number[] = [];
    for (const span of spans) {
      if (stopped()) return null;
      await parquetRead({
        file,
        metadata,
        columns: [column],
        rowStart: span.rowStart,
        rowEnd: span.rowEnd,
        compressors,
        utf8: false,
        useOffsetIndex: true,
        parsers: RAW_WKB_PARSERS,
        onChunk: (chunk) => {
          // A chunk may spill past the requested span, so clip to the overlap
          // and index into the chunk by its own rowStart. `r` is the absolute
          // file row, so it is exactly the provenance a kept geometry needs.
          const from = Math.max(span.rowStart, chunk.rowStart);
          const to = Math.min(span.rowEnd, chunk.rowEnd);
          const data = chunk.columnData;
          for (let r = from; r < to; r++) {
            const v = data[r - chunk.rowStart];
            if (v != null) {
              geometries.push(v);
              rows.push(r);
            }
          }
        },
      });
    }
    return { geometries, rows };
  };

  // Serialize onBatch. Each read awaits its turn on this chain, so paints never
  // interleave no matter which reads finish first.
  let paintChain: Promise<void> = Promise.resolve();
  const paint = (values: GroupValues, index: number): Promise<void> => {
    paintChain = paintChain.then(() => {
      if (stopped()) return;
      return onBatch(values.geometries, values.rows, [index]);
    });
    return paintChain;
  };

  // A pool of workers pulling from a shared cursor. Each reads a group, then
  // waits its turn to paint before pulling the next, which caps read-ahead at
  // the pool size and keeps decode bursts bounded.
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!stopped()) {
      const i = next++;
      if (i >= ranges.length) return;
      const range = ranges[i];
      let values: GroupValues | null;
      try {
        values = await readGroup(range);
      } catch (err) {
        aborted = true;
        throw err;
      }
      if (values === null || stopped()) return;
      await paint(values, range.index);
    }
  };

  const pool = Math.min(MAX_CONCURRENT_READS, ranges.length);
  await withPhase('row-group-fetch', () => Promise.all(Array.from({ length: pool }, () => worker())));
  // Let the last queued paint settle before returning, so the caller's post-read
  // finalize runs after every group has painted.
  await paintChain;
}
