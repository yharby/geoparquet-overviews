// A byte-budgeted LRU cache for the flattened geometry of a single row group,
// keyed by (column, row-group index, row-range signature). It mirrors the
// byte-cache design one level up the pipeline: where the byte cache saves the
// network trip on a repeat view, this saves the decode, flatten, and reproject
// work, so panning back over an area already seen at a given level of detail is
// nearly free.
//
// The cached buckets are immutable after creation and are shared by reference
// with every consumer (the same read-only contract as the byte cache's aliasing,
// see byte-cache.ts:7). A consumer that mutated a returned bucket in place would
// corrupt the entry for the next view.

import type { FlatGeometries } from '../geo/geojson';

// The cached value carries the flat buckets plus the feature (row) count that
// produced them, so a cache hit can update the load summary's feature total the
// same way a fresh decode does. The count cannot be recovered from the flat
// buckets alone (one MultiPolygon feature can span many polygon entries).
export interface CachedFlat {
  flat: FlatGeometries;
  features: number;
}

export interface FlatCache {
  get(key: string): CachedFlat | undefined;
  set(key: string, value: CachedFlat): void;
  stats(): { entries: number; residentBytes: number };
  clear(): void;
}

// 192 MB holds a broad low-zoom view's worth of decoded coarse bands resident
// across pans while staying well under the tab's memory ceiling.
const DEFAULT_BUDGET = 192 * 1024 * 1024;

// Resident-byte estimate for one entry. Every bucket, holed polygons included, is
// now a flat typed array, so the estimate is the exact sum of their byteLengths.
export function flatEntryBytes(flat: FlatGeometries): number {
  return (
    flat.points.positions.byteLength +
    flat.paths.positions.byteLength +
    flat.paths.startIndices.byteLength +
    flat.polygons.positions.byteLength +
    flat.polygons.startIndices.byteLength +
    flat.holedPolygons.positions.byteLength +
    flat.holedPolygons.polygonStartIndices.byteLength +
    flat.holedPolygons.ringStartIndices.byteLength
  );
}

export function createFlatCache(budgetBytes: number = DEFAULT_BUDGET): FlatCache {
  // Insertion order is LRU order, oldest first. A hit re-inserts to the end.
  const map = new Map<string, { value: CachedFlat; bytes: number }>();
  let residentBytes = 0;

  // Evict least-recently-used entries until under budget, never evicting the
  // entry just inserted.
  function evict(keepKey: string): void {
    for (const [k, entry] of map) {
      if (residentBytes <= budgetBytes) break;
      if (k === keepKey) continue;
      residentBytes -= entry.bytes;
      map.delete(k);
    }
  }

  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      map.delete(key);
      map.set(key, hit);
      return hit.value;
    },
    set(key, value) {
      const existing = map.get(key);
      if (existing) {
        residentBytes -= existing.bytes;
        map.delete(key);
      }
      const bytes = flatEntryBytes(value.flat);
      map.set(key, { value, bytes });
      residentBytes += bytes;
      evict(key);
    },
    stats() {
      return { entries: map.size, residentBytes };
    },
    clear() {
      map.clear();
      residentBytes = 0;
    },
  };
}
