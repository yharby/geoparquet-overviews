import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock hyparquet's parquetRead so no real file is read. Each call synthesizes one
// chunk covering the requested span. hyparquet-compressors is stubbed since the
// mock never decompresses. getCachedFile is stubbed to a bare file/metadata pair.
const parquetRead = vi.fn();
vi.mock('hyparquet', () => ({ parquetRead: (...a: unknown[]) => parquetRead(...a) }));
vi.mock('hyparquet-compressors', () => ({ compressors: {} }));
const getCachedFile = vi.fn();
vi.mock('./file-cache', () => ({ getCachedFile: (...a: unknown[]) => getCachedFile(...a) }));

import { readColumnProgressive, type RowGroupRange } from './rowgroups';

function ranges(n: number): RowGroupRange[] {
  return Array.from({ length: n }, (_, i) => ({ index: i, rowStart: i * 10, rowEnd: i * 10 + 10 }));
}

beforeEach(() => {
  parquetRead.mockReset();
  getCachedFile.mockReset();
  getCachedFile.mockResolvedValue({ file: {}, metadata: {} });
});

describe('readColumnProgressive', () => {
  it('reads groups concurrently, bounded by the pool, and paints them serially', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    parquetRead.mockImplementation(async ({ rowStart, rowEnd, onChunk }: any) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      const columnData = Array.from({ length: rowEnd - rowStart }, () => new Uint8Array([1]));
      onChunk({ columnData, rowStart, rowEnd });
      inFlight -= 1;
    });

    let painting = false;
    let overlapped = false;
    const painted: number[] = [];
    await readColumnProgressive('u', ranges(20), 'geometry', async (_geoms, _rows, idx) => {
      if (painting) overlapped = true; // two paints interleaved
      painting = true;
      await Promise.resolve();
      painted.push(idx[0]);
      painting = false;
    });

    expect(maxInFlight).toBeGreaterThan(1); // genuinely concurrent
    expect(maxInFlight).toBeLessThanOrEqual(16); // capped at the pool size, and 20 ranges exceed it so the cap is exercised
    expect(overlapped).toBe(false); // paints never interleave
    expect(painted.slice().sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i),
    ); // every group painted
  });

  it('reads each page sub-range of a group then paints the group once', async () => {
    const spans: Array<[number, number]> = [];
    parquetRead.mockImplementation(async ({ rowStart, rowEnd, onChunk }: any) => {
      spans.push([rowStart, rowEnd]);
      onChunk({ columnData: [new Uint8Array([1])], rowStart, rowEnd });
    });
    const paints: number[] = [];
    const pruned: RowGroupRange[] = [
      { index: 0, rowStart: 0, rowEnd: 100, subRanges: [{ rowStart: 5, rowEnd: 10 }, { rowStart: 40, rowEnd: 50 }] },
    ];
    await readColumnProgressive('u', pruned, 'geometry', (_g, _rows, idx) => {
      paints.push(idx[0]);
    });
    expect(spans).toEqual([[5, 10], [40, 50]]); // both sub-ranges read
    expect(paints).toEqual([0]); // painted once for the group
  });

  it('carries each geometry its absolute row and drops nulls', async () => {
    parquetRead.mockImplementation(async ({ rowStart, rowEnd, onChunk }: any) => {
      // A null geometry at the second row of the span; the rest are present.
      const columnData = Array.from({ length: rowEnd - rowStart }, (_, i) =>
        i === 1 ? null : new Uint8Array([1]),
      );
      onChunk({ columnData, rowStart, rowEnd });
    });
    const seen: { rows: number[]; count: number }[] = [];
    await readColumnProgressive(
      'u',
      [{ index: 0, rowStart: 10, rowEnd: 15 }],
      'geometry',
      (geoms, rows) => {
        seen.push({ rows: rows.slice(), count: geoms.length });
      },
    );
    // Rows 10..14 minus the null at 11, so four geometries carrying their
    // absolute file rows, not the compacted array positions.
    expect(seen).toEqual([{ rows: [10, 12, 13, 14], count: 4 }]);
  });

  it('stops pulling new groups once shouldStop trips', async () => {
    parquetRead.mockImplementation(async ({ rowStart, rowEnd, onChunk }: any) => {
      onChunk({ columnData: [new Uint8Array([1])], rowStart, rowEnd });
    });
    let stop = false;
    const painted: number[] = [];
    await readColumnProgressive(
      'u',
      ranges(20),
      'geometry',
      (_g, _rows, idx) => {
        painted.push(idx[0]);
        if (painted.length >= 2) stop = true;
      },
      () => stop,
    );
    expect(painted.length).toBeLessThan(20); // abandoned, did not read every group
  });

  it('aborts the whole batch on a read error instead of throwing per worker', async () => {
    let calls = 0;
    parquetRead.mockImplementation(async () => {
      calls += 1;
      throw new Error('boom');
    });
    await expect(readColumnProgressive('u', ranges(20), 'geometry', () => {})).rejects.toThrow('boom');
    // Only the first wave of workers ran, no worker pulled a second group.
    expect(calls).toBeLessThanOrEqual(16);
  });
});
