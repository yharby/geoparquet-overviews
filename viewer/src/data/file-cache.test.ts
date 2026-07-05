import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock hyparquet so no network happens. asyncBufferFromUrl returns a fake base
// buffer, parquetMetadataAsync is a spy returning a distinct metadata object.
const parquetMetadataAsync = vi.fn();
const asyncBufferFromUrl = vi.fn();
vi.mock('hyparquet', () => ({
  asyncBufferFromUrl: (...args: unknown[]) => asyncBufferFromUrl(...args),
  parquetMetadataAsync: (...args: unknown[]) => parquetMetadataAsync(...args),
}));

import { getCachedFile, getPageRangeMemo, isFilePrefetched, resetFileCache } from './file-cache';

const OVER_THRESHOLD = 40 * 1024 * 1024;

beforeEach(() => {
  resetFileCache();
  parquetMetadataAsync.mockReset();
  asyncBufferFromUrl.mockReset();
  asyncBufferFromUrl.mockImplementation(async () => ({ byteLength: 1000, slice: () => new ArrayBuffer(0) }));
  parquetMetadataAsync.mockImplementation(async () => ({ row_groups: [], schema: [] }));
});

describe('getCachedFile', () => {
  it('parses metadata once for two calls with the same url', async () => {
    await getCachedFile('a.parquet');
    await getCachedFile('a.parquet');
    expect(parquetMetadataAsync).toHaveBeenCalledTimes(1);
    expect(asyncBufferFromUrl).toHaveBeenCalledTimes(1);
  });

  it('parses through a wrapping buffer, not the raw base', async () => {
    // The footer parse must read a wrapping buffer (the LRU byte cache above the
    // threshold, the in-memory prefetch below it) rather than the raw base, so
    // the footer read is reused by later reads. Parsing the raw base would
    // silently defeat that. Use an above-threshold file to exercise the byte
    // cache path.
    const base = { byteLength: OVER_THRESHOLD, slice: () => new ArrayBuffer(0) };
    asyncBufferFromUrl.mockImplementation(async () => base);
    await getCachedFile('a.parquet');
    const passed = parquetMetadataAsync.mock.calls[0][0] as { slice: unknown };
    expect(passed).not.toBe(base);
    expect(typeof passed.slice).toBe('function');
  });

  it('downloads the whole file once when it is at or below the threshold', async () => {
    const slice = vi.fn(async (s: number, e?: number) => new ArrayBuffer((e ?? 1000) - s));
    asyncBufferFromUrl.mockImplementation(async () => ({ byteLength: 1000, slice }));
    await getCachedFile('small.parquet');
    // One contiguous GET of the whole file, then metadata read from memory.
    expect(slice).toHaveBeenCalledWith(0, 1000);
    expect(isFilePrefetched('small.parquet')).toBe(true);
    const passed = parquetMetadataAsync.mock.calls[0][0] as { byteLength: number };
    expect(passed.byteLength).toBe(1000);
  });

  it('keeps the range-request path above the threshold', async () => {
    // Metadata is mocked, so nothing reads the file. The point is that no
    // whole-file GET was issued and the file is not marked prefetched.
    const slice = vi.fn(async (s: number, e?: number) => new ArrayBuffer((e ?? OVER_THRESHOLD) - s));
    asyncBufferFromUrl.mockImplementation(async () => ({ byteLength: OVER_THRESHOLD, slice }));
    await getCachedFile('big.parquet');
    expect(isFilePrefetched('big.parquet')).toBe(false);
    expect(slice).not.toHaveBeenCalledWith(0, OVER_THRESHOLD);
  });

  it('reports prefetch only for the resident url', async () => {
    await getCachedFile('small.parquet');
    expect(isFilePrefetched('small.parquet')).toBe(true);
    expect(isFilePrefetched('other.parquet')).toBe(false);
  });

  it('re-parses when the url changes', async () => {
    await getCachedFile('a.parquet');
    await getCachedFile('b.parquet');
    expect(parquetMetadataAsync).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight load across concurrent same-url calls', async () => {
    // Gate the download so both calls are in flight before either resolves,
    // which is the race the single-flight dedup guards: without it each concurrent
    // caller would download and parse, then flap the resident entry.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    asyncBufferFromUrl.mockImplementation(async () => {
      await gate;
      return { byteLength: 1000, slice: () => new ArrayBuffer(0) };
    });
    const p1 = getCachedFile('a.parquet');
    const p2 = getCachedFile('a.parquet');
    release();
    const [a, b] = await Promise.all([p1, p2]);
    expect(asyncBufferFromUrl).toHaveBeenCalledTimes(1);
    expect(parquetMetadataAsync).toHaveBeenCalledTimes(1);
    expect(a.metadata).toBe(b.metadata);
  });

  it('lets a retry re-attempt after a failed load', async () => {
    // A failed load must clear the in-flight marker, so a retry actually
    // re-downloads instead of awaiting the settled rejected promise forever.
    asyncBufferFromUrl.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    await expect(getCachedFile('a.parquet')).rejects.toThrow('boom');
    await getCachedFile('a.parquet');
    expect(asyncBufferFromUrl).toHaveBeenCalledTimes(2);
    expect(parquetMetadataAsync).toHaveBeenCalledTimes(1);
  });

  it('returns the same metadata object across same-url calls', async () => {
    const first = await getCachedFile('a.parquet');
    const second = await getCachedFile('a.parquet');
    expect(second.metadata).toBe(first.metadata);
  });
});

describe('getPageRangeMemo', () => {
  it('is stable per url and survives repeated getCachedFile calls', async () => {
    await getCachedFile('a.parquet');
    const memo = getPageRangeMemo('a.parquet');
    memo.set(3, null);
    await getCachedFile('a.parquet');
    expect(getPageRangeMemo('a.parquet').get(3)).toBeNull();
  });

  it('returns an empty throwaway map for an unknown url', () => {
    expect(getPageRangeMemo('missing.parquet').size).toBe(0);
  });
});
