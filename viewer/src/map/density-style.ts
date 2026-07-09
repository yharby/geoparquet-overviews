import type { CountForRow } from '../data/counts';
import type { FlatPoints } from '../geo/geojson';

// Density-aware styling from the per-survivor thinning counts (see
// data/counts.ts). One survivor per pixel makes a dense city cell and a
// sparse rural cell paint identically, so the count scales the survivor's
// visual weight back up, points grow, fills and lines get more opaque. A count
// of 0 means unknown (old file, finest band, invalid row, or a failed count
// read) and keeps the constant fallback style. Everything here is a pure
// array builder run once at layer-assembly time, the results feed deck.gl as
// binary attributes, never per-frame accessors over row objects.

export type Rgba = [number, number, number, number];

// Point radius scaled by count, `base` (2.5 px) times a log2 ladder clamped to
// [1, 5], so a count of 1 stays at the base radius and a very dense cell tops
// out at 5x.
export function densityRadius(count: number, base: number): number {
  if (!(count > 0)) return base;
  return base * Math.min(5, Math.max(1, 0.6 + 0.5 * Math.log2(count)));
}

// Fill or line alpha scaled by count, clamp(110 + 36*log2(count), 110, 255),
// so a count of 1 reads faint and a dense cell saturates. An unknown count
// keeps the constant `fallback` alpha.
export function densityAlpha(count: number, fallback: number): number {
  if (!(count > 0)) return fallback;
  return Math.min(255, Math.max(110, 110 + 36 * Math.log2(count)));
}

// Per-instance point radii, one Float32 per xy pair, aligned with the bucket's
// rowIds, for ScatterplotLayer's binary getRadius attribute.
export function pointRadii(points: FlatPoints, base: number, countForRow: CountForRow): Float32Array {
  const out = new Float32Array(points.rowIds.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = densityRadius(countForRow(points.rowIds[i]), base);
  }
  return out;
}

// Per-vertex RGBA for a startIndices bucket (hole-free polygons or paths).
// Every vertex of primitive p repeats that primitive's color, since deck.gl's
// binary-attribute path with startIndices expects one value per vertex. The
// alpha carries the density, the rgb stays the bucket's base color.
export function perVertexColors(
  bucket: { startIndices: Uint32Array; rowIds: Uint32Array },
  base: Rgba,
  countForRow: CountForRow,
): Uint8ClampedArray {
  const totalVertices = bucket.startIndices[bucket.startIndices.length - 1];
  const out = new Uint8ClampedArray(totalVertices * 4);
  for (let p = 0; p < bucket.rowIds.length; p++) {
    const alpha = densityAlpha(countForRow(bucket.rowIds[p]), base[3]);
    const from = bucket.startIndices[p];
    const to = bucket.startIndices[p + 1];
    for (let v = from; v < to; v++) {
      const o = v * 4;
      out[o] = base[0];
      out[o + 1] = base[1];
      out[o + 2] = base[2];
      out[o + 3] = alpha;
    }
  }
  return out;
}

// Per-primitive RGBA, 4 bytes per rowIds entry, for the holed-polygon fill
// whose data is already one object per polygon (see buildHoledPolygonLayer),
// so its accessor indexes this array by polygon ordinal.
export function perPrimitiveColors(rowIds: Uint32Array, base: Rgba, countForRow: CountForRow): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rowIds.length * 4);
  for (let i = 0; i < rowIds.length; i++) {
    const o = i * 4;
    out[o] = base[0];
    out[o + 1] = base[1];
    out[o + 2] = base[2];
    out[o + 3] = densityAlpha(countForRow(rowIds[i]), base[3]);
  }
  return out;
}
