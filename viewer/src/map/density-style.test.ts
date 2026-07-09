import { describe, it, expect } from 'vitest';
import {
  densityAlpha,
  densityRadius,
  perPrimitiveColors,
  perVertexColors,
  pointRadii,
  type Rgba,
} from './density-style';

const BASE: Rgba = [53, 193, 193, 180];

describe('densityRadius', () => {
  it('keeps the base radius at count 1 (multiplier clamps up to 1)', () => {
    // 0.6 + 0.5*log2(1) = 0.6, clamped to 1.
    expect(densityRadius(1, 2.5)).toBe(2.5);
  });

  it('grows with count and clamps at 5x', () => {
    // count 16: 0.6 + 0.5*4 = 2.6x.
    expect(densityRadius(16, 2.5)).toBeCloseTo(2.5 * 2.6, 6);
    expect(densityRadius(1_000_000, 2.5)).toBe(2.5 * 5);
  });

  it('falls back to the base radius for an unknown (0) count', () => {
    expect(densityRadius(0, 2.5)).toBe(2.5);
  });
});

describe('densityAlpha', () => {
  it('is 110 at count 1 and clamps at 255', () => {
    expect(densityAlpha(1, 180)).toBe(110);
    expect(densityAlpha(1_000_000, 180)).toBe(255);
  });

  it('grows on the log2 ladder', () => {
    // count 4: 110 + 36*2 = 182.
    expect(densityAlpha(4, 180)).toBeCloseTo(182, 6);
  });

  it('keeps the constant fallback alpha for an unknown (0) count', () => {
    expect(densityAlpha(0, 180)).toBe(180);
    expect(densityAlpha(0, 230)).toBe(230);
  });
});

describe('pointRadii', () => {
  it('builds one radius per point from its row count', () => {
    const points = {
      positions: new Float64Array(6), // three xy pairs
      rowIds: Uint32Array.from([10, 11, 12]),
    };
    const count = (row: number) => (row === 11 ? 16 : row === 12 ? 0 : 1);
    const radii = pointRadii(points, 2.5, count);
    expect(radii).toHaveLength(3);
    expect(radii[0]).toBe(2.5); // count 1, base
    expect(radii[1]).toBeCloseTo(2.5 * 2.6, 5); // count 16
    expect(radii[2]).toBe(2.5); // unknown, base
  });
});

describe('perVertexColors', () => {
  it('repeats each primitive color across its vertex span', () => {
    // Two primitives, vertices [0,3) and [3,5).
    const bucket = {
      startIndices: Uint32Array.from([0, 3, 5]),
      rowIds: Uint32Array.from([7, 8]),
    };
    const count = (row: number) => (row === 7 ? 1 : 16);
    const colors = perVertexColors(bucket, BASE, count);
    expect(colors).toHaveLength(5 * 4);
    // First primitive, count 1, alpha 110 on every vertex.
    for (let v = 0; v < 3; v++) {
      expect([colors[v * 4], colors[v * 4 + 1], colors[v * 4 + 2], colors[v * 4 + 3]]).toEqual([53, 193, 193, 110]);
    }
    // Second primitive, count 16, alpha 110 + 36*4 = 254.
    for (let v = 3; v < 5; v++) {
      expect(colors[v * 4 + 3]).toBe(254);
    }
  });

  it('uses the base alpha for a primitive with an unknown count', () => {
    const bucket = { startIndices: Uint32Array.from([0, 2]), rowIds: Uint32Array.from([1]) };
    const colors = perVertexColors(bucket, BASE, () => 0);
    expect(colors[3]).toBe(180);
    expect(colors[7]).toBe(180);
  });
});

describe('perPrimitiveColors', () => {
  it('builds one RGBA per primitive', () => {
    const rowIds = Uint32Array.from([5, 6]);
    const count = (row: number) => (row === 5 ? 0 : 256);
    const colors = perPrimitiveColors(rowIds, BASE, count);
    expect(colors).toHaveLength(8);
    expect([...colors.slice(0, 4)]).toEqual([53, 193, 193, 180]); // unknown, base alpha
    expect([...colors.slice(4, 8)]).toEqual([53, 193, 193, 255]); // 110 + 36*8 clamps to 255
  });
});
