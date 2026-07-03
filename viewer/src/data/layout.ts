import type { Bbox } from '../geo/aoi';
import { flattenGeoJson, type FlatGeometries } from '../geo/geojson';
import { flattenWkb } from '../geo/wkb-flatten';
import type { CoordTransform } from '../geo/crs';
import {
  levelForZoom,
  columnForLevel,
  rowGroupsForLevel,
  rowGroupsIntersecting,
  type GeoParquetMetadata,
} from './metadata';

export interface ReadPlan {
  // Row groups to read, already pruned to the viewport by bbox.
  indices: number[];
  // The geometry column readColumnProgressive fetches, the flat exact
  // `geometry` column, or the simplified `geom_overview` column at low zoom.
  column: string;
  // A stable identity for the level of detail this plan reads, so a change in
  // level refetches even when the viewport is unchanged. It encodes the level
  // ordinal for the overviews path, since several coarse levels can share one
  // overview column, and a fixed token for the flat path.
  lodKey: string;
  decode: (rawValues: unknown[]) => FlatGeometries;
}

// Decode a batch of geometry values into flat buckets. With hyparquet's parser
// overridden to identity the values arrive as raw WKB Uint8Arrays, so the
// zero-copy scanner runs; the GeoJSON flattener is kept as a fallback in case any
// value is already a decoded object (belt and braces during the transition). The
// probe skips leading nulls, which the finest band's null geom_overview yields.
function decodeGeometries(values: unknown[], transform: CoordTransform | null): FlatGeometries {
  for (const v of values) {
    if (v == null) continue;
    if (v instanceof Uint8Array) return flattenWkb(values, transform);
    return flattenGeoJson(values, transform);
  }
  return flattenWkb(values, transform);
}

export interface LayoutStrategy {
  kind: 'overviews' | 'flat-wkb';
  hasZoomLevels: boolean;
  // False when the file carries no covering bbox, so reads cannot be pruned to
  // the viewport and every row group is a candidate. The UI surfaces this.
  prunable: boolean;
  // Fill in anything the read path needs that is not already in the footer.
  prepare(url: string): Promise<void>;
  planRead(aoi: Bbox, zoom: number): ReadPlan;
}

function flatStrategy(metadata: GeoParquetMetadata): LayoutStrategy {
  const transform = metadata.projection.transform;
  // A plain GeoParquet file with no covering bbox cannot be pruned to the
  // viewport, so every row group is a candidate. The progressive reader still
  // reads them one at a time and a newer view supersedes an in-flight read.
  const hasCovering = metadata.coveringPaths !== null;
  return {
    kind: 'flat-wkb',
    hasZoomLevels: false,
    prunable: hasCovering,
    prepare: async () => {},
    planRead: (aoi) => ({
      indices: hasCovering
        ? rowGroupsIntersecting(metadata.rowGroups, aoi)
        : metadata.rowGroups.map((rg) => rg.index),
      column: 'geometry',
      lodKey: 'flat',
      decode: (geometries) => decodeGeometries(geometries, transform),
    }),
  };
}

function overviewsStrategy(metadata: GeoParquetMetadata): LayoutStrategy {
  const info = metadata.overviewsInfo!;
  const transform = metadata.projection.transform;
  return {
    kind: 'overviews',
    hasZoomLevels: true,
    prunable: true,
    prepare: async () => {},
    planRead: (aoi, zoom) => {
      const level = levelForZoom(info, zoom);
      const column = columnForLevel(info, level);
      return {
        indices: rowGroupsForLevel(metadata.rowGroups, level, aoi),
        column,
        lodKey: `L${level.level}:${column}`,
        decode: (geometries) => decodeGeometries(geometries, transform),
      };
    },
  };
}

// Pick the read strategy from the footer. A file with an `overviews.levels`
// block reads the pyramid, everything else reads the flat geometry column.
export function detectLayout(metadata: GeoParquetMetadata): LayoutStrategy {
  if (metadata.overviewsInfo) return overviewsStrategy(metadata);
  return flatStrategy(metadata);
}
