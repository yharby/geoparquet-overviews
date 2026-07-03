import { describe, it, expect } from 'vitest';
import { parseCrs, reprojectBbox } from './crs';

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

  it('marks an unknown projected CRS unsupported', () => {
    const c = parseCrs(projected(999999));
    expect(c.geographic).toBe(false);
    expect(c.supported).toBe(false);
    expect(c.transform).toBeNull();
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
});
