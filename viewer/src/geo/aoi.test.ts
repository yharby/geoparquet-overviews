import { describe, it, expect } from 'vitest';
import { bboxIntersectsAoi, splitAoiAtSeam, type Bbox } from './aoi';

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
