import { describe, it, expect } from 'vitest';
import { parseCrs, reprojectBbox, transformPositionsInPlace } from './crs';

// A PROJJSON-ish stub for a projected CRS, only the fields parseCrs reads.
const projected = (code: number) => ({
  primary_column: 'geometry',
  columns: { geometry: { crs: { type: 'ProjectedCRS', name: 'Test', id: { authority: 'EPSG', code } } } },
});

const geographic = {
  primary_column: 'geometry',
  columns: { geometry: { crs: { type: 'GeographicCRS', id: { authority: 'OGC', code: 'CRS84' } } } },
};

describe('parseCrs', () => {
  it('treats a missing geo block as lon/lat', () => {
    const c = parseCrs(null);
    expect(c.geographic).toBe(true);
    expect(c.transform).toBeNull();
  });

  it('treats an absent crs key as the CRS84 default', () => {
    const c = parseCrs({ primary_column: 'geometry', columns: { geometry: {} } });
    expect(c.geographic).toBe(true);
    expect(c.supported).toBe(true);
  });

  it('detects a geographic CRS', () => {
    const c = parseCrs(geographic);
    expect(c.geographic).toBe(true);
    expect(c.transform).toBeNull();
  });

  it('builds a transform for a known projected CRS (EPSG:3067)', () => {
    const c = parseCrs(projected(3067));
    expect(c.geographic).toBe(false);
    expect(c.supported).toBe(true);
    expect(c.epsg).toBe(3067);
    // A point in Helsinki, ~385 km east, ~6.67 Mm north, lands near 25E 60N.
    const [lon, lat] = c.transform!(385000, 6672000);
    expect(lon).toBeGreaterThan(24);
    expect(lon).toBeLessThan(26);
    expect(lat).toBeGreaterThan(59);
    expect(lat).toBeLessThan(61);
  });

  it('supports EPSG:3857 web mercator through a proj4 built-in, with no local def', () => {
    const c = parseCrs(projected(3857));
    expect(c.geographic).toBe(false);
    expect(c.supported).toBe(true);
    expect(c.epsg).toBe(3857);
    // The 3857 origin (0, 0) is lon/lat (0, 0).
    const [lon, lat] = c.transform!(0, 0);
    expect(lon).toBeCloseTo(0, 6);
    expect(lat).toBeCloseTo(0, 6);
  });

  it('marks an unknown projected CRS unsupported', () => {
    const c = parseCrs(projected(999999));
    expect(c.geographic).toBe(false);
    expect(c.supported).toBe(false);
    expect(c.transform).toBeNull();
  });

  it('treats a bare standalone 4326 token (no EPSG prefix) as geographic', () => {
    const c = parseCrs({ primary_column: 'geometry', columns: { geometry: { crs: 'urn:ogc:def:crs:custom:4326' } } });
    expect(c.geographic).toBe(true);
  });

  // V10. A code that merely contains the digits 4326 (like 104326) must not be
  // read as WGS84 just because '4326' appears as a substring.
  it('does not treat a string containing 104326 as geographic', () => {
    const c = parseCrs({ primary_column: 'geometry', columns: { geometry: { crs: 'EPSG:104326' } } });
    expect(c.geographic).toBe(false);
    expect(c.epsg).toBe(104326);
  });

  it('does not treat a bare 104326 token as geographic', () => {
    const c = parseCrs({ primary_column: 'geometry', columns: { geometry: { crs: 'urn:ogc:def:crs:custom:104326' } } });
    expect(c.geographic).toBe(false);
  });

  it('still reads a genuine EPSG:4326 string as geographic', () => {
    const c = parseCrs({ primary_column: 'geometry', columns: { geometry: { crs: 'EPSG:4326' } } });
    expect(c.geographic).toBe(true);
  });

  it('reads a doubled-colon urn EPSG code', () => {
    const c = parseCrs({ primary_column: 'geometry', columns: { geometry: { crs: 'urn:ogc:def:crs:EPSG::4326' } } });
    expect(c.geographic).toBe(true);
  });

  // V10. hyparquet honors a PROJJSON `ids` array, so parseCrs must too.
  it('honors a PROJJSON ids array', () => {
    const c = parseCrs({
      primary_column: 'geometry',
      columns: { geometry: { crs: { type: 'ProjectedCRS', name: 'TM35FIN', ids: [{ authority: 'EPSG', code: 3067 }] } } },
    });
    expect(c.geographic).toBe(false);
    expect(c.epsg).toBe(3067);
    expect(c.supported).toBe(true);
  });
});

describe('reprojectBbox', () => {
  it('returns the input unchanged for a null transform', () => {
    const b = { xmin: 0, ymin: 0, xmax: 1, ymax: 1 };
    expect(reprojectBbox(b, null)).toBe(b);
  });

  it('reprojects a projected bbox into a lon/lat range', () => {
    const c = parseCrs(projected(3067));
    const b = reprojectBbox({ xmin: 375000, ymin: 6662000, xmax: 395000, ymax: 6682000 }, c.transform);
    expect(b.xmin).toBeGreaterThan(20);
    expect(b.xmax).toBeLessThan(30);
    expect(b.ymin).toBeGreaterThan(59);
    expect(b.ymax).toBeLessThan(61);
    expect(b.xmin).toBeLessThan(b.xmax);
    expect(b.ymin).toBeLessThan(b.ymax);
  });

  it('reprojects a sub-box within its parent under a curved projection (whole-band skip soundness)', () => {
    // EPSG:3067 is transverse Mercator, so a rectangle's edges bow out past its
    // corners. A member row group sits inside its band's CRS extent, so its
    // reprojected bbox must stay inside the band extent's reprojected envelope,
    // else the whole-band skip could drop a group that is actually in view.
    const c = parseCrs(projected(3067));
    const parent = { xmin: 100000, ymin: 6600000, xmax: 700000, ymax: 7700000 };
    const child = { xmin: 380000, ymin: 7680000, xmax: 420000, ymax: 7700000 }; // top-center sliver
    const P = reprojectBbox(parent, c.transform);
    const C = reprojectBbox(child, c.transform);
    const eps = 1e-9;
    expect(C.xmin).toBeGreaterThanOrEqual(P.xmin - eps);
    expect(C.ymin).toBeGreaterThanOrEqual(P.ymin - eps);
    expect(C.xmax).toBeLessThanOrEqual(P.xmax + eps);
    expect(C.ymax).toBeLessThanOrEqual(P.ymax + eps);
  });
});

describe('transformPositionsInPlace', () => {
  it('passes a well-behaved transform through unchanged', () => {
    const positions = new Float64Array([1, 2, 3, 4]);
    transformPositionsInPlace(positions, (x, y) => [x * 2, y * 2]);
    expect(Array.from(positions)).toEqual([2, 4, 6, 8]);
  });

  // A degenerate source coordinate or a transform's domain edge can make
  // proj4 return NaN/Infinity/out-of-range values. deck.gl's WebMercator
  // projection throws "invalid latitude" and tears down the whole layer on
  // any such vertex, so one corrupt feature must not be able to blank the
  // entire map. See the sanitizeLon/sanitizeLat comment in crs.ts.
  it('clamps an out-of-range result into the valid lon/lat envelope', () => {
    const positions = new Float64Array([0, 0]);
    transformPositionsInPlace(positions, () => [200, 95]);
    expect(positions[0]).toBe(180);
    expect(positions[1]).toBe(90);
  });

  it('clamps a negative out-of-range result', () => {
    const positions = new Float64Array([0, 0]);
    transformPositionsInPlace(positions, () => [-200, -95]);
    expect(positions[0]).toBe(-180);
    expect(positions[1]).toBe(-90);
  });

  it('replaces a non-finite result with (0, 0) instead of propagating NaN/Infinity', () => {
    const positions = new Float64Array([0, 0, 0, 0]);
    transformPositionsInPlace(positions.subarray(0, 2), () => [NaN, 45]);
    transformPositionsInPlace(positions.subarray(2, 4), () => [10, Infinity]);
    expect(positions[0]).toBe(0);
    expect(positions[1]).toBe(45);
    expect(positions[2]).toBe(10);
    expect(positions[3]).toBe(0);
  });
});
