import { describe, it, expect } from 'vitest';
import { roundKeyDecimals, viewFetchKey } from './fetch-key';
import type { Bbox } from '../geo/aoi';

const bbox = (xmin: number, ymin: number, xmax: number, ymax: number): Bbox => ({ xmin, ymin, xmax, ymax });

describe('roundKeyDecimals', () => {
  it('uses more precision at high zoom and less at low zoom', () => {
    expect(roundKeyDecimals(4)).toBeLessThan(roundKeyDecimals(15));
  });

  it('stays within a sane clamp', () => {
    expect(roundKeyDecimals(0)).toBe(2);
    expect(roundKeyDecimals(30)).toBe(7);
  });
});

describe('viewFetchKey', () => {
  it('changes when the level of detail changes even if the view is identical', () => {
    const b = bbox(0, 0, 1, 1);
    // Two coarse levels that read the same overview column must still differ, so
    // a zoom that crosses a band boundary refetches.
    expect(viewFetchKey('L0:geom_overview', b, 6)).not.toBe(viewFetchKey('L1:geom_overview', b, 6));
  });

  it('is stable for the same LOD and unchanged view', () => {
    const b = bbox(10, 20, 11, 21);
    expect(viewFetchKey('flat', b, 10)).toBe(viewFetchKey('flat', b, 10));
  });

  it('does not swallow a small pan at high zoom', () => {
    // A pan of 0.0005 degrees (about 55 m) at zoom 15 must produce a new key,
    // where the old fixed 0.001-degree rounding would have collapsed it.
    const before = bbox(10.0, 20.0, 11.0, 21.0);
    const after = bbox(10.0005, 20.0005, 11.0005, 21.0005);
    expect(viewFetchKey('flat', before, 15)).not.toBe(viewFetchKey('flat', after, 15));
  });

  it('collapses a negligible change at low zoom', () => {
    // At zoom 4 the rounding is coarse, so a sub-metre jitter is one key.
    const before = bbox(10.0, 20.0, 11.0, 21.0);
    const after = bbox(10.00001, 20.00001, 11.00001, 21.00001);
    expect(viewFetchKey('flat', before, 4)).toBe(viewFetchKey('flat', after, 4));
  });
});
