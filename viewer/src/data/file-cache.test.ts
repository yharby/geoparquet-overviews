import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock hyparquet so no network happens. asyncBufferFromUrl returns a fake base
// buffer, parquetMetadataAsync is a spy returning a distinct metadata object.
const parquetMetadataAsync = vi.fn();
const asyncBufferFromUrl = vi.fn();
vi.mock('hyparquet', () => ({
  asyncBufferFromUrl: (...args: unknown[]) => asyncBufferFromUrl(...args),
  parquetMetadataAsync: (...args: unknown[]) => parquetMetadataAsync(...args),
}));

import {
  getCachedFile,
  getPageRangeMemo,
  isFilePrefetched,
  pageIndexRegion,
  resetFileCache,
  withCoalescedIndexRegion,
  type FileMetaData,
} from './file-cache';

const OVER_THRESHOLD = 40 * 1024 * 1024;

const fetchMock = vi.fn();

beforeEach(() => {
  resetFileCache();
  parquetMetadataAsync.mockReset();
  asyncBufferFromUrl.mockReset();
  asyncBufferFromUrl.mockImplementation(async () => ({ byteLength: 1000, slice: () => new ArrayBuffer(0) }));
  parquetMetadataAsync.mockImplementation(async () => ({ row_groups: [], schema: [] }));
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1000) }));
  vi.stubGlobal('fetch', fetchMock);
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
    // One plain un-ranged GET of the whole file (browser-cacheable, unlike the
    // no-store ranged buffer), then metadata read from memory. The ranged
    // buffer itself must stay untouched.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('small.parquet');
    expect(slice).not.toHaveBeenCalled();
    expect(isFilePrefetched('small.parquet')).toBe(true);
    const passed = parquetMetadataAsync.mock.calls[0][0] as { byteLength: number };
    expect(passed.byteLength).toBe(1000);
  });

  it('opens the ranged buffer with the browser HTTP cache bypassed', async () => {
    // Chrome serializes concurrent same-url fetches on its cache-entry lock,
    // so the ranged buffer must opt out of the disk cache or parallel range
    // reads execute one at a time.
    await getCachedFile('a.parquet');
    expect(asyncBufferFromUrl).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'a.parquet', requestInit: { cache: 'no-store' } }),
    );
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

// Build minimal metadata carrying page-index offsets. Offsets are bigint like
// hyparquet's real thrift decode.
function metaWithIndexes(
  cols: Array<{ ci?: [number, number]; oi?: [number, number] }>,
): FileMetaData {
  return {
    row_groups: [
      {
        columns: cols.map((c) => ({
          column_index_offset: c.ci ? BigInt(c.ci[0]) : undefined,
          column_index_length: c.ci ? c.ci[1] : undefined,
          offset_index_offset: c.oi ? BigInt(c.oi[0]) : undefined,
          offset_index_length: c.oi ? c.oi[1] : undefined,
        })),
      },
    ],
  } as unknown as FileMetaData;
}

describe('pageIndexRegion', () => {
  it('spans the min column-index start to the max offset-index end', () => {
    const meta = metaWithIndexes([
      { ci: [1000, 40], oi: [2000, 60] },
      { ci: [1040, 40], oi: [2060, 60] },
    ]);
    expect(pageIndexRegion(meta)).toEqual([1000, 2120]);
  });

  it('returns null when the file carries no page indexes', () => {
    expect(pageIndexRegion(metaWithIndexes([{}, {}]))).toBeNull();
  });

  it('returns null past the size cap', () => {
    const meta = metaWithIndexes([{ ci: [0, 10], oi: [64 * 1024 * 1024, 10] }]);
    expect(pageIndexRegion(meta)).toBeNull();
  });
});

describe('withCoalescedIndexRegion', () => {
  // A base whose slices are identifiable: byte i of the file has value i % 251.
  function countingBase(byteLength: number) {
    const slice = vi.fn(async (start: number, end?: number) => {
      const e = end ?? byteLength;
      const buf = new Uint8Array(e - start);
      for (let i = 0; i < buf.length; i++) buf[i] = (start + i) % 251;
      return buf.buffer;
    });
    return { base: { byteLength, slice }, slice };
  }

  it('serves all in-region slices from one base read', async () => {
    const { base, slice } = countingBase(10_000);
    const wrapped = withCoalescedIndexRegion(base, [4000, 4500]);
    const [a, b] = await Promise.all([wrapped.slice(4000, 4037), wrapped.slice(4400, 4415)]);
    expect(slice).toHaveBeenCalledTimes(1);
    expect(slice).toHaveBeenCalledWith(4000, 4500);
    // Correct bytes, not just correct lengths.
    expect(new Uint8Array(a)[0]).toBe(4000 % 251);
    expect(new Uint8Array(b)[0]).toBe(4400 % 251);
    expect(a.byteLength).toBe(37);
    expect(b.byteLength).toBe(15);
  });

  it('passes slices outside or straddling the region to the base unchanged', async () => {
    const { base, slice } = countingBase(10_000);
    const wrapped = withCoalescedIndexRegion(base, [4000, 4500]);
    await wrapped.slice(0, 100);
    await wrapped.slice(3990, 4010);
    expect(slice).toHaveBeenCalledWith(0, 100);
    expect(slice).toHaveBeenCalledWith(3990, 4010);
    expect(slice).toHaveBeenCalledTimes(2);
  });

  it('retries the region read after a failure instead of staying poisoned', async () => {
    const { base, slice } = countingBase(10_000);
    slice.mockRejectedValueOnce(new Error('transient'));
    const wrapped = withCoalescedIndexRegion(base, [4000, 4500]);
    await expect(wrapped.slice(4000, 4010)).rejects.toThrow('transient');
    const ok = await wrapped.slice(4000, 4010);
    expect(ok.byteLength).toBe(10);
    expect(slice).toHaveBeenCalledTimes(2);
  });
});
