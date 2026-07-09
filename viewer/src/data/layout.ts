import type { Bbox } from '../geo/aoi';
import { flattenGeoJson, type FlatGeometries } from '../geo/geojson';
import { flattenWkb } from '../geo/wkb-flatten';
import type { CoordTransform } from '../geo/crs';
import {
  levelForZoom,
  columnForLevel,
  columnForRowGroup,
  rowGroupsForLevel,
  rowGroupsIntersecting,
  bandsOutsideAoi,
  type GeoParquetMetadata,
} from './metadata';

export interface ReadPlan {
  // Row groups to read, already pruned to the viewport by bbox.
  indices: number[];
  // The geometry column readColumnProgressive fetches for the level's own band,
  // the flat exact `geometry` column, or the simplified `geom_overview` column
  // at low zoom. A cumulative-prefix read can mix columns per row group, see
  // columnForIndex; this is the target band's column, used for status and the
  // read-cost panel.
  column: string;
  // The geometry column to read for one specific row group index. In the
  // overviews path on a banded 0.3.0+ file, a coarser band caught in the prefix
  // reads exact `geometry` instead of its own too-coarse overview (version
  // gated in columnForRowGroup), so the column varies per group. The flat path
  // always returns 'geometry'.
  columnForIndex: (index: number) => string;
  // A stable identity for the level of detail this plan reads, so a change in
  // level refetches even when the viewport is unchanged. It encodes the level
  // ordinal for the overviews path, since several coarse levels can share one
  // overview column, and a fixed token for the flat path.
  lodKey: string;
  // The overview level this plan reads, for the read-cost panel's efficiency
  // readout. Null for the flat path, which has no pyramid. Taken from the level
  // the zoom selects, not a row group, so the finest (exact) level reports its
  // own level even though it owns the whole prefix and therefore reads row
  // groups that span several levels.
  band: number | null;
  // `rows` is the parallel absolute-parquet-row of each raw value, carried
  // through so a picked geometry resolves to its source row for the click popup.
  decode: (rawValues: unknown[], rows?: ArrayLike<number>) => FlatGeometries;
}

// Decode a batch of geometry values into flat buckets. With hyparquet's parser
// overridden to identity the values arrive as raw WKB Uint8Arrays, so the
// zero-copy scanner runs; the GeoJSON flattener is kept as a fallback in case any
// value is already a decoded object (belt and braces during the transition). The
// probe skips leading nulls, which the finest band's null geom_overview yields.
function decodeGeometries(
  values: unknown[],
  transform: CoordTransform | null,
  rows?: ArrayLike<number>,
): FlatGeometries {
  for (const v of values) {
    if (v == null) continue;
    if (v instanceof Uint8Array) return flattenWkb(values, transform, rows);
    return flattenGeoJson(values, transform, rows);
  }
  return flattenWkb(values, transform, rows);
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
  // Prunability now reflects reality: a row group carries a usable bbox from
  // either the physical covering column or, for Profile B (--no-bbox) files,
  // the native Parquet GeospatialStatistics on the geometry chunk. A file with
  // neither on any row group cannot be pruned to the viewport, so every row
  // group is a candidate. The progressive reader still reads them one at a
  // time and a newer view supersedes an in-flight read.
  const prunable = metadata.rowGroups.some((rg) => rg.bbox !== null);
  return {
    kind: 'flat-wkb',
    hasZoomLevels: false,
    prunable,
    prepare: async () => {},
    planRead: (aoi) => ({
      indices: prunable
        ? rowGroupsIntersecting(metadata.rowGroups, aoi)
        : metadata.rowGroups.map((rg) => rg.index),
      column: 'geometry',
      columnForIndex: () => 'geometry',
      lodKey: 'flat',
      band: null,
      decode: (geometries, rows) => decodeGeometries(geometries, transform, rows),
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
      // Skip whole coarse bands whose padded extent misses the view, so their
      // row groups (null-bbox ones included) never read. The finest exact band
      // spans the dataset, so it is never skipped, which is correct.
      const skipBands = bandsOutsideAoi(info.levels, aoi);
      return {
        indices: rowGroupsForLevel(metadata.rowGroups, level, aoi, skipBands),
        column,
        // A coarser band in the prefix reads exact geometry on 0.3.0+ files,
        // the target band its own column. Keyed off the row group's stamped
        // band ordinal, version gated in columnForRowGroup.
        columnForIndex: (index) =>
          columnForRowGroup(info, level, metadata.rowGroups[index]?.band ?? null),
        lodKey: `L${level.level}:${column}`,
        band: level.level,
        decode: (geometries, rows) => decodeGeometries(geometries, transform, rows),
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
