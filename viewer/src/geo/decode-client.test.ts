import { describe, it, expect, beforeEach, vi } from 'vitest';
import { decodeBatch, resetDecodeClientForTests } from './decode-client';
import { decodeFlat } from './wkb-flatten';
import type { FlatGeometries } from './geojson';

// The node test env has no Worker global, so decodeBatch takes its synchronous
// fallback. That path must produce exactly what the caller's decodeSync produces
// and must reject when decodeSync throws, so a malformed batch surfaces as a
// failed fetch rather than a silent empty paint.

function wkbPoint(x: number, y: number): Uint8Array {
  const b = new Uint8Array(21);
  const dv = new DataView(b.buffer);
  dv.setUint8(0, 1);
  dv.setUint32(1, 1, true);
  dv.setFloat64(5, x, true);
  dv.setFloat64(13, y, true);
  return b;
}

beforeEach(() => {
  resetDecodeClientForTests();
});

describe('decodeBatch (no-worker fallback)', () => {
  it('confirms this env has no Worker, so the fallback is what runs', () => {
    expect(typeof Worker).toBe('undefined');
  });

  it('returns exactly what decodeSync returns', async () => {
    const values = [wkbPoint(1, 2), wkbPoint(3, 4)];
    const rows = [5, 6];
    const decodeSync = (g: unknown[], r: number[]) => decodeFlat(g, null, r);
    const out = await decodeBatch(values, rows, null, decodeSync);
    const expected = decodeSync(values, rows);
    expect(Array.from(out.points.positions)).toEqual(Array.from(expected.points.positions));
    expect(Array.from(out.points.rowIds)).toEqual([5, 6]);
  });

  it('passes the exact geometries and rows through to decodeSync', async () => {
    const values = [wkbPoint(1, 2)];
    const rows = [42];
    const decodeSync = vi.fn((_g: unknown[], _r: number[]): FlatGeometries => decodeFlat(_g, null, _r));
    await decodeBatch(values, rows, null, decodeSync);
    expect(decodeSync).toHaveBeenCalledTimes(1);
    expect(decodeSync).toHaveBeenCalledWith(values, rows);
  });

  it('rejects when decodeSync throws, rather than resolving empty', async () => {
    const boom = () => {
      throw new Error('malformed');
    };
    await expect(decodeBatch([wkbPoint(1, 2)], [0], null, boom)).rejects.toThrow('malformed');
  });
});
