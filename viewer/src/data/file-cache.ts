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
  // Decoded, flattened, reprojected geometry keyed per row group and level of
  // detail, so a repeat view reuses the buckets instead of re-reading and
  // re-decoding. Dies with the file entry, so switching urls frees it.
  flatCache: FlatCache;
}

// One file resident at a time, matching the previous single-slot behavior.
// Switching urls drops the prior entry and its byte cache, releasing memory.
let entry: FileEntry | null = null;

export async function getCachedFile(url: string): Promise<{ file: AsyncBuffer; metadata: FileMetaData }> {
  if (entry && entry.url === url) return { file: entry.file, metadata: entry.metadata };
  const base = await withPhase('footer', () => asyncBufferFromUrl({ url }));

  let file: AsyncBuffer;
  let cache: ByteCache | null;
  let prefetched: boolean;
  if (base.byteLength <= PREFETCH_THRESHOLD_BYTES) {
    // One contiguous GET of the whole file. Every later slice is a cheap
    // in-memory copy, so there is no LRU and nothing to pin.
    const whole = await withPhase('prefetch', async () => base.slice(0, base.byteLength));
    file = memoryBuffer(whole);
    cache = null;
    prefetched = true;
  } else {
    cache = createByteCache(base);
    file = cache.buffer;
    prefetched = false;
  }

  const metadata = await withPhase('metadata', () => parquetMetadataAsync(file));
  entry = {
    url,
    file,
    metadata,
    cache,
    prefetched,
    pageRangeMemo: new Map(),
    flatCache: createFlatCache(),
  };
  return { file: entry.file, metadata: entry.metadata };
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

// The flat-geometry cache for the resident file. An unknown url gets a throwaway
// cache (never reused), mirroring getPageRangeMemo, so a stray caller cannot
// crash but also cannot pollute the resident file's cache.
export function getFlatCache(url: string): FlatCache {
  if (entry && entry.url === url) return entry.flatCache;
  return createFlatCache();
}

// Test seam. Drops the resident file so each test starts clean.
export function resetFileCache(): void {
  entry = null;
}
