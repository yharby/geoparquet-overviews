import { describe, it, expect } from 'vitest';
import {
  bboxIntersectsAoi,
  bboxRing,
  clampGeographicBbox,
  splitAoiAtSeam,
  viewportRing,
  type Bbox,
} from './aoi';

describe('clampGeographicBbox', () => {
  it('clamps a near-global overview extent to valid lon/lat', () => {
    // A coarse band grid-snapped near the poles pushes a global file's extent a
    // fraction of a cell past them, which makes MapLibre fitBounds throw. The
    // clamp brings it back into [-180, 180] x [-90, 90].
    const b = clampGeographicBbox({
      xmin: -180.0439453125,
      ymin: -90.0439453125,
      xmax: 180.0439453125,
      ymax: 90.0439453125,
    });
    expect(b).toEqual({ xmin: -180, ymin: -90, xmax: 180, ymax: 90 });
  });

  it('leaves an in-range bbox unchanged', () => {
    const b: Bbox = { xmin: 10, ymin: -5, xmax: 20, ymax: 5 };
    expect(clampGeographicBbox(b)).toEqual(b);
  });

  it('keeps a bbox entirely past a pole minimally valid instead of zero-height', () => {
    // Both edges clamp onto 90, which used to hand a zero-height bbox to the
    // camera fits. The guard expands the collapsed axis by a tiny epsilon
    // around the clamped edge, kept inside [-90, 90].
    const b = clampGeographicBbox({ xmin: 10, ymin: 91, xmax: 20, ymax: 95 });
    expect(b.xmin).toBe(10);
    expect(b.xmax).toBe(20);
    expect(b.ymin).toBeLessThan(b.ymax);
    expect(b.ymax).toBeLessThanOrEqual(90);
    expect(b.ymin).toBeGreaterThan(89.9);
  });

  it('keeps a bbox entirely past the antimeridian minimally valid on the x axis', () => {
    const b = clampGeographicBbox({ xmin: 181, ymin: 0, xmax: 190, ymax: 5 });
    expect(b.xmin).toBeLessThan(b.xmax);
    expect(b.xmax).toBeLessThanOrEqual(180);
    expect(b.xmin).toBeGreaterThan(179.9);
    expect(b.ymin).toBe(0);
    expect(b.ymax).toBe(5);
  });

  it('expands a degenerate zero-span axis at the low edge too', () => {
    const b = clampGeographicBbox({ xmin: -185, ymin: -95, xmax: -181, ymax: -92 });
    expect(b.xmin).toBe(-180);
    expect(b.xmax).toBeGreaterThan(b.xmin);
    expect(b.ymin).toBe(-90);
    expect(b.ymax).toBeGreaterThan(b.ymin);
  });
});

describe('bboxRing', () => {
  it('builds a closed five-point ring', () => {
    const ring = bboxRing({ xmin: 0, ymin: 1, xmax: 2, ymax: 3 });
    expect(ring).toEqual([
      [0, 1],
      [2, 1],
      [2, 3],
      [0, 3],
      [0, 1],
    ]);
  });
});

describe('viewportRing', () => {
  it('clamps a zoomed-out MapLibre viewport so no vertex leaves projectable latitude', () => {
    // Regression: MapLibre's map.getBounds() returns north above 90 and south
    // below -90 when the main map is zoomed out. That raw bbox drives the
    // mini-map's live viewport outline (a deck.gl PathLayer), and deck.gl's
    // WebMercator projection asserts lat in [-90, 90], so an unclamped ring
    // threw "invalid latitude" and killed the overlay. Clamp keeps the outline
    // inside the projectable range.
    const ring = viewportRing({ xmin: -200, ymin: -128, xmax: 200, ymax: 128 });
    for (const [lon, lat] of ring) {
      expect(lat).toBeGreaterThanOrEqual(-90);
      expect(lat).toBeLessThanOrEqual(90);
      expect(lon).toBeGreaterThanOrEqual(-180);
      expect(lon).toBeLessThanOrEqual(180);
    }
  });

  it('leaves an in-range viewport ring untouched', () => {
    const b: Bbox = { xmin: 10, ymin: -5, xmax: 20, ymax: 5 };
    expect(viewportRing(b)).toEqual(bboxRing(b));
  });
});

describe('splitAoiAtSeam', () => {
  it('leaves an in-range view as a single bbox', () => {
    const b: Bbox = { xmin: 10, ymin: 0, xmax: 20, ymax: 5 };
    expect(splitAoiAtSeam(b)).toEqual([b]);
  });

  it('splits a view whose east edge runs past 180 into two parts', () => {
    // MapLibre can report east past 180 for a view wrapped over the seam.
    const parts = splitAoiAtSeam({ xmin: 170, ymin: 0, xmax: 190, ymax: 5 });
    expect(parts).toEqual([
      { xmin: 170, ymin: 0, xmax: 180, ymax: 5 },
      { xmin: -180, ymin: 0, xmax: -170, ymax: 5 },
    ]);
  });

  it('covers all longitudes for a full-turn span', () => {
    const parts = splitAoiAtSeam({ xmin: -200, ymin: 0, xmax: 200, ymax: 5 });
    expect(parts).toEqual([{ xmin: -180, ymin: 0, xmax: 180, ymax: 5 }]);
  });
});

describe('bboxIntersectsAoi', () => {
  it('finds data near the seam that a single-bbox test would prune', () => {
    // A row group just west of the antimeridian, in normalized [-180,180].
    const rg: Bbox = { xmin: -179, ymin: 0, xmax: -176, ymax: 5 };
    const wrappedView: Bbox = { xmin: 170, ymin: 0, xmax: 190, ymax: 5 };
    expect(bboxIntersectsAoi(rg, wrappedView)).toBe(true);
  });

  it('still prunes a row group the wrapped view does not cover', () => {
    const rg: Bbox = { xmin: 0, ymin: 0, xmax: 10, ymax: 5 };
    const wrappedView: Bbox = { xmin: 170, ymin: 0, xmax: 190, ymax: 5 };
    expect(bboxIntersectsAoi(rg, wrappedView)).toBe(false);
  });
});
