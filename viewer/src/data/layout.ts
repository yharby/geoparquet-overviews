import type { Bbox } from '../geo/aoi';
import type { FlatGeometries } from '../geo/geojson';
import { decodeFlat } from '../geo/wkb-flatten';
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
      lodKey: 'flat',
      band: null,
      decode: (geometries, rows) => decodeFlat(geometries, transform, rows),
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
        band: level.level,
        decode: (geometries, rows) => decodeFlat(geometries, transform, rows),
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
