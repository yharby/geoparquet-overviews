import { describe, it, expect } from 'vitest';
import { createFlatCache, flatEntryBytes } from './flat-cache';
import { flattenGeoJson, type FlatGeometries } from '../geo/geojson';

const point = (x: number, y: number) => ({ type: 'Point', coordinates: [x, y] });

function polygonFlat(vertices: number): FlatGeometries {
  // One polygon ring of `vertices` points, so entry size scales with the count.
  const coords = Array.from({ length: vertices }, (_, i) => [i, i]);
  return flattenGeoJson([{ type: 'Polygon', coordinates: [coords] }]);
}

describe('flatEntryBytes', () => {
  it('counts the typed-array byteLengths of every flat bucket', () => {
    const flat = flattenGeoJson([point(1, 2), point(3, 4)]);
    expect(flatEntryBytes(flat)).toBe(
      flat.points.positions.byteLength +
        flat.paths.positions.byteLength +
        flat.paths.startIndices.byteLength +
        flat.polygons.positions.byteLength +
        flat.polygons.startIndices.byteLength +
        flat.holedPolygons.positions.byteLength +
        flat.holedPolygons.polygonStartIndices.byteLength +
        flat.holedPolygons.ringStartIndices.byteLength,
    );
  });
});

describe('createFlatCache', () => {
  it('returns the same bucket reference on a hit', () => {
    const cache = createFlatCache();
    const flat = polygonFlat(4);
    cache.set('k', { flat, features: 1 });
    const hit = cache.get('k');
    expect(hit?.flat).toBe(flat);
    expect(hit?.features).toBe(1);
  });

  it('returns undefined for a missing key', () => {
    const cache = createFlatCache();
    expect(cache.get('nope')).toBeUndefined();
  });

  it('keeps a partial-read key from colliding with a full-read key', () => {
    const cache = createFlatCache();
    const full = polygonFlat(4);
    const partial = polygonFlat(8);
    // Keys carry the row-range signature, so the same group read two ways stays
    // in two entries and a partial decode is never served to a full read.
    cache.set('geometry 3 full', { flat: full, features: 1 });
    cache.set('geometry 3 100-200', { flat: partial, features: 1 });
    expect(cache.get('geometry 3 full')?.flat).toBe(full);
    expect(cache.get('geometry 3 100-200')?.flat).toBe(partial);
  });

  it('evicts the least-recently-used entry once over the byte budget', () => {
    const entry = polygonFlat(4);
    const bytes = flatEntryBytes(entry);
    // Budget holds two entries but not three.
    const cache = createFlatCache(bytes * 2 + 1);
    cache.set('a', { flat: polygonFlat(4), features: 1 });
    cache.set('b', { flat: polygonFlat(4), features: 1 });
    cache.set('c', { flat: polygonFlat(4), features: 1 });
    // 'a' is the oldest and is evicted, 'b' and 'c' remain.
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.stats().entries).toBe(2);
  });

  it('a hit re-inserts as most-recently-used so it survives the next eviction', () => {
    const bytes = flatEntryBytes(polygonFlat(4));
    const cache = createFlatCache(bytes * 2 + 1);
    cache.set('a', { flat: polygonFlat(4), features: 1 });
    cache.set('b', { flat: polygonFlat(4), features: 1 });
    // Touch 'a' so 'b' becomes the least-recently-used.
    cache.get('a');
    cache.set('c', { flat: polygonFlat(4), features: 1 });
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('replacing a key does not double-count its bytes', () => {
    const bytes = flatEntryBytes(polygonFlat(4));
    const cache = createFlatCache(bytes * 2 + 1);
    cache.set('a', { flat: polygonFlat(4), features: 1 });
    cache.set('a', { flat: polygonFlat(4), features: 2 });
    expect(cache.stats().entries).toBe(1);
    expect(cache.get('a')?.features).toBe(2);
  });
});
