import { asyncBufferFromUrl, parquetMetadataAsync } from 'hyparquet';
import { withPhase } from '../core/phase';
import { createByteCache, type AsyncBuffer, type ByteCache } from './byte-cache';
import { createFlatCache, type FlatCache } from './flat-cache';
import type { PageRange } from './pageindex';

// The parsed Parquet footer. Immutable for a file, so it is parsed once and
// shared by the GeoParquet metadata interpretation and every column read.
export type FileMetaData = Awaited<ReturnType<typeof parquetMetadataAsync>>;

// Files at or below this size are downloaded whole in one request, the way
// DuckDB's force_download_threshold does. Below it, the many small range reads
// a page-pruned or multi-row-group view issues cost more in round trips than
// the bytes they save, so one contiguous GET is faster and every later slice is
// served from memory. Larger files keep the range-request overview path, which
// is the whole point of the convention.
const PREFETCH_THRESHOLD_BYTES = 32 * 1024 * 1024;

// Range reads bypass the browser HTTP cache. Chrome serializes concurrent
// fetches of the same URL on a per-cache-entry lock, so a burst of parallel
// range reads (page indexes, column chunks) executes one at a time, each
// paying full latency — an observed 9s stall for ~1.3 KB of index data. The
// disk cache also almost never re-hits viewport-dependent byte ranges, so
// `no-store` trades a ~0% hit rate for real request parallelism. The
// whole-file prefetch below deliberately keeps the default cache mode: a
// single un-ranged GET has no concurrency to lose and re-serves from disk on
// reload.
const RANGE_REQUEST_INIT: RequestInit = { cache: 'no-store' };

// Upper bound on the coalesced page-index region read. The region normally
// measures a few hundred KB even for a country-scale file, so a size past this
// cap means an unusual layout where one contiguous read would hurt more than
// per-structure reads, and the wrapper is skipped.
const INDEX_REGION_CAP_BYTES = 16 * 1024 * 1024;

interface FileEntry {
  url: string;
  file: AsyncBuffer;
  metadata: FileMetaData;
  // The LRU byte cache, or null when the whole file was prefetched into memory
  // and slices are served directly from it (no range requests, nothing to pin).
  cache: ByteCache | null;
  // True when the file was small enough to download whole. The page-prune path
  // reads this to skip its index reads, since a resident file saves no bytes by
  // pruning and would only add decode work.
  prefetched: boolean;
  // Decoded per-page ranges keyed by row-group index. The page indexes are
  // immutable for the file, so this is filled once and reused across every pan
  // and zoom. A null value records that a group cannot be page pruned, so the
  // caller falls back to a whole-group read without re-reading the indexes.
  pageRangeMemo: Map<number, PageRange[] | null>;
  // In-flight page-index reads keyed by row-group index. Two overlapping view
  // fetches (e.g. two moveends settling before either's page-index round trip
  // returns) can both see a group missing from pageRangeMemo and, without this,
  // would each issue their own read for the same range. Single-flight per index,
  // mirroring the whole-file `pending` dedup above. Cleared once the read settles
  // and its result lands in pageRangeMemo.
  pageRangePending: Map<number, Promise<PageRange[] | null>>;
  // Decoded, flattened, reprojected geometry keyed per row group and level of
  // detail, so a repeat view reuses the buckets instead of re-reading and
  // re-decoding. Dies with the file entry, so switching urls frees it.
  flatCache: FlatCache;
  // Decoded density counts of the footer's count column, keyed by row-group
  // index, aligned to the group's own rows. The column is immutable for the
  // file, so each group is read once. A null value records a failed read, so
  // styling falls back to constant without refetching on every view.
  countsMemo: Map<number, Int32Array | null>;
  // In-flight count reads keyed by row-group index, single-flight for the same
  // reason as pageRangePending.
  countsPending: Map<number, Promise<Int32Array | null>>;
}

// One file resident at a time, matching the previous single-slot behavior.
// Switching urls drops the prior entry and its byte cache, releasing memory.
let entry: FileEntry | null = null;
// The in-flight load of a not-yet-resident url. Concurrent callers for the same
// url (e.g. the metadata read and the first view fetch overlapping under rapid
// file switching) share this one download and parse instead of each doing the
// full work and racing to overwrite `entry`, which would flap the flat cache,
// page memo, and pinning. Cleared once the load settles.
let pending: { url: string; promise: Promise<FileEntry> } | null = null;

// Download (or prefetch) a url and parse its footer into a fresh FileEntry. Does
// not touch the shared `entry`, so it is safe to run under the single-flight
// dedup in getCachedFile.
async function loadFileEntry(url: string): Promise<FileEntry> {
  const base = await withPhase('footer', () =>
    asyncBufferFromUrl({ url, requestInit: RANGE_REQUEST_INIT }),
  );

  let file: AsyncBuffer;
  let cache: ByteCache | null;
  let prefetched: boolean;
  if (base.byteLength <= PREFETCH_THRESHOLD_BYTES) {
    // One contiguous GET of the whole file. Every later slice is a cheap
    // in-memory copy, so there is no LRU and nothing to pin. A plain un-ranged
    // fetch, not base.slice, so the response stays browser-cacheable (the
    // ranged buffer is no-store) and a reload re-serves it from disk.
    const whole = await withPhase('prefetch', async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`prefetch failed ${res.status}`);
      return res.arrayBuffer();
    });
    file = memoryBuffer(whole);
    cache = null;
    prefetched = true;
  } else {
    cache = createByteCache(base);
    file = cache.buffer;
    prefetched = false;
  }

  const metadata = await withPhase('metadata', () => parquetMetadataAsync(file));
  if (!prefetched) {
    // Page-index structures (ColumnIndex/OffsetIndex) are tiny and contiguous
    // just before the footer, but are sliced one 15-100 byte structure at a
    // time — by the page-prune path and by hyparquet's useOffsetIndex read —
    // so a deep-zoom view was paying one round trip per structure. Serve them
    // all from one coalesced read of the whole region instead.
    const region = pageIndexRegion(metadata);
    if (region) file = withCoalescedIndexRegion(file, region);
  }
  return {
    url,
    file,
    metadata,
    cache,
    prefetched,
    pageRangeMemo: new Map(),
    pageRangePending: new Map(),
    flatCache: createFlatCache(),
    countsMemo: new Map(),
    countsPending: new Map(),
  };
}

// The contiguous byte region holding every ColumnIndex and OffsetIndex in the
// file, [start, end), or null when the file carries none or the region is
// implausibly large (see INDEX_REGION_CAP_BYTES).
export function pageIndexRegion(metadata: FileMetaData): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const rg of metadata.row_groups) {
    for (const c of rg.columns) {
      if (c.column_index_offset != null && c.column_index_length) {
        const s = Number(c.column_index_offset);
        lo = Math.min(lo, s);
        hi = Math.max(hi, s + c.column_index_length);
      }
      if (c.offset_index_offset != null && c.offset_index_length) {
        const s = Number(c.offset_index_offset);
        lo = Math.min(lo, s);
        hi = Math.max(hi, s + c.offset_index_length);
      }
    }
  }
  if (!Number.isFinite(lo) || hi <= lo || hi - lo > INDEX_REGION_CAP_BYTES) return null;
  return [lo, hi];
}

// Wrap an AsyncBuffer so any slice falling entirely inside the page-index
// region is served from a single lazily-fetched read of the whole region.
// The region read itself goes through the underlying buffer, so it lands in
// the byte cache like any other range. A failed region read clears the memo,
// so one transient error does not poison every later index read.
export function withCoalescedIndexRegion(base: AsyncBuffer, region: [number, number]): AsyncBuffer {
  const [regionStart, regionEnd] = region;
  let regionBytes: Promise<ArrayBuffer> | null = null;
  return {
    byteLength: base.byteLength,
    slice(start, end) {
      const e = end === undefined ? base.byteLength : end;
      const s = start < 0 ? base.byteLength + start : start;
      if (s < regionStart || e > regionEnd || e <= s) return base.slice(start, end);
      if (!regionBytes) {
        regionBytes = Promise.resolve(base.slice(regionStart, regionEnd)).catch((err) => {
          regionBytes = null;
          throw err;
        });
      }
      return regionBytes.then((buf) => buf.slice(s - regionStart, e - regionStart));
    },
  };
}

export async function getCachedFile(url: string): Promise<{ file: AsyncBuffer; metadata: FileMetaData }> {
  if (entry && entry.url === url) return { file: entry.file, metadata: entry.metadata };
  // Share one in-flight load per url. A second caller arriving mid-load awaits
  // the same promise rather than kicking off a duplicate download and parse.
  if (!pending || pending.url !== url) {
    pending = { url, promise: loadFileEntry(url) };
  }
  const load = pending;
  try {
    const loaded = await load.promise;
    entry = loaded;
    return { file: loaded.file, metadata: loaded.metadata };
  } finally {
    // Clear only our own in-flight marker, so a newer url's load (which replaced
    // `pending`) is left intact, and a retry after a failure is not blocked by a
    // settled rejected promise.
    if (pending === load) pending = null;
  }
}

// Wrap an already-downloaded ArrayBuffer as an AsyncBuffer. ArrayBuffer.slice
// already handles negative starts and an omitted end, so it matches the same
// slice contract hyparquet expects from a ranged buffer.
function memoryBuffer(buf: ArrayBuffer): AsyncBuffer {
  return {
    byteLength: buf.byteLength,
    slice: (start, end) => buf.slice(start, end),
  };
}

// Whether the resident file was small enough to download whole. Callers use it
// to skip page pruning, which cannot save bytes once the file is in memory.
export function isFilePrefetched(url: string): boolean {
  return !!entry && entry.url === url && entry.prefetched;
}

// Pin the coarse-band column-chunk byte intervals so the low-zoom preview stays
// resident. Intervals are physical [start, end) byte ranges of whole column
// chunks. Only an exact whole-interval read is pinned, so a page-pruned
// sub-range read that falls inside a coarse chunk rides the LRU instead of
// creating a new forever-pinned entry per viewport, which would grow pinned
// bytes without bound.
export function pinCoarseRanges(url: string, intervals: Array<[number, number]>): void {
  if (!entry || entry.url !== url || !entry.cache) return;
  entry.cache.setPinned((start, end) => intervals.some(([s, e]) => start === s && end === e));
}

export function getPageRangeMemo(url: string): Map<number, PageRange[] | null> {
  if (entry && entry.url === url) return entry.pageRangeMemo;
  return new Map();
}

// The in-flight page-index read map for the resident file, see pageRangePending.
// An unknown url gets a throwaway map, mirroring getPageRangeMemo.
export function getPageRangePending(url: string): Map<number, Promise<PageRange[] | null>> {
  if (entry && entry.url === url) return entry.pageRangePending;
  return new Map();
}

// The density-count memo for the resident file, keyed by row-group index. An
// unknown url gets a throwaway map, mirroring getPageRangeMemo, so a stray
// caller cannot pollute the resident file's entry.
export function getCountsMemo(url: string): Map<number, Int32Array | null> {
  if (entry && entry.url === url) return entry.countsMemo;
  return new Map();
}

// The in-flight count read map for the resident file, see countsPending. An
// unknown url gets a throwaway map, mirroring getPageRangeMemo.
export function getCountsPending(url: string): Map<number, Promise<Int32Array | null>> {
  if (entry && entry.url === url) return entry.countsPending;
  return new Map();
}

// The flat-geometry cache for the resident file. An unknown url gets a throwaway
// cache (never reused), mirroring getPageRangeMemo, so a stray caller cannot
// crash but also cannot pollute the resident file's cache.
export function getFlatCache(url: string): FlatCache {
  if (entry && entry.url === url) return entry.flatCache;
  return createFlatCache();
}

// Test seam. Drops the resident file and any in-flight load so each test starts
// clean.
export function resetFileCache(): void {
  entry = null;
  pending = null;
}
