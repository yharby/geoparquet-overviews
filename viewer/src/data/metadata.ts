import type { ColumnChunk, RowGroup, SchemaElement } from 'hyparquet';
import { bboxIntersectsAoi, type Bbox } from '../geo/aoi';
import { parseCrs, reprojectBbox, type CrsInfo } from '../geo/crs';
import { getCachedFile, pinCoarseRanges, type FileMetaData } from './file-cache';

export interface RowGroupInfo {
  index: number;
  rowCount: number;
  totalByteSize: number;
  bbox: Bbox | null;
  // Importance band this row group belongs to in the overview pyramid, or
  // null when the file exposes no `overviews.levels`.
  band: number | null;
}

interface CoveringPaths {
  xmin: string[];
  ymin: string[];
  xmax: string[];
  ymax: string[];
}

// One importance band of the overview pyramid, parsed from the `overviews`
// footer block. A band maps to the cumulative row-group prefix [0..rowGroupEnd]
// because the file is written band-major.
export interface OverviewLevel {
  level: number;
  rowGroupEnd: number;
  // First row group of the level's own slice. 0 for cumulative (banded)
  // layouts, where level k's read is the whole prefix [0..rowGroupEnd];
  // the previous level's rowGroupEnd + 1 for self-contained (duplicating)
  // layouts, where each level is a complete rendering on its own.
  rowGroupStart: number;
  maxZoom: number;
  gsd: number;
  // The lowest web zoom this band serves. Present from 0.3.0 on. Older files
  // lack it, so parseOverviews fills it from the ladder, level 0 starts at zoom
  // 0 and each later band starts one past the previous band's maxZoom.
  minZoom: number;
  // The band's feature count from the footer, or null when the field is absent
  // (pre 0.3.0). Surfaced so the panel can show the thinning payoff.
  featureCount: number | null;
  // Optional 0.2.0 fields. The band's file byte range [start, end) so a reader
  // can price a prefix read, and its padded extent in CRS units.
  bytes: [number, number] | null;
  extent: [number, number, number, number] | null;
  // The reprojected, viewport-comparable form of `extent`, filled in
  // readGeoParquetMetadata where the CRS transform is in scope. Null when the
  // band has no extent or parseOverviews built it with no projection. Drives the
  // whole-band skip in bandsOutsideAoi.
  extentBbox: Bbox | null;
}

export interface OverviewsInfo {
  version: string;
  // How levels map to row groups. 'banded' is this spec's cumulative
  // band-major layout (a level reads the row-group prefix). 'duplicating'
  // is the gpq-tiles geo:overviews mode where every level is a complete,
  // self-contained rendering and a reader fetches exactly one level's
  // own row-group slice.
  mode: 'banded' | 'duplicating';
  spatialKey: string;
  // Simplified-geometry column that coarse bands read instead of `geometry`,
  // or null when the file has no overview column (the flat variants).
  overviewColumn: string | null;
  // How the overview geometry was derived (`simplify_snap`, `thin`, or `none`
  // for a single-band file where nothing was reduced) and how features were
  // ranked into bands (`area_desc`, `length_desc`, ...). Purely descriptive
  // footer fields, surfaced in the read-cost panel.
  overviewMethod: string | null;
  importance: string | null;
  // The per-row density count column (0.3.0 `count_column`, written as
  // `overview_count` by density thinning), or null when absent. Each
  // coarse-band row holds how many source features competed for that
  // survivor's one-pixel thinning cell, itself included, null on the finest
  // band and invalid rows. Drives the density-aware styling.
  countColumn: string | null;
  levels: OverviewLevel[];
}

export interface GeoParquetMetadata {
  rowGroups: RowGroupInfo[];
  totalRows: number;
  coveringPaths: CoveringPaths | null;
  geo: Record<string, unknown> | null;
  overviews: Record<string, unknown> | null;
  // The interpreted pyramid, or null for files without an `overviews.levels`
  // block. Drives the zoom slider and the overview-column read path.
  overviewsInfo: OverviewsInfo | null;
  // The coordinate reference system of the file. Projected data carries a
  // transform to lon/lat, applied to bboxes here and to decoded geometry at read
  // time so the web-mercator map can render it.
  projection: CrsInfo;
  // The declared geometry types of the primary column, from
  // geo.columns[primary].geometry_types, or null when the file omits it (many
  // files do). Descriptive only, the renderer never depends on it, but it drives
  // the "nothing renderable" notice and the panels.
  geometryTypes: string[] | null;
  // The raw hyparquet row groups, kept so the page reader can find each column
  // chunk's ColumnIndex and OffsetIndex byte offsets for sub-row-group reads.
  rawRowGroups: RowGroup[];
  // The flat schema element list, used to resolve a covering column's
  // SchemaElement when converting its ColumnIndex min/max values.
  schema: SchemaElement[];
}

interface RawKeyValue {
  key: string;
  value: string;
}

interface RawStatistics {
  min_value?: number;
  max_value?: number;
}

interface RawGeoStatsBbox {
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
}

interface RawColumn {
  meta_data: {
    path_in_schema: string[];
    statistics?: RawStatistics;
    // Native Parquet GeospatialStatistics (GEOMETRY logical type), the row
    // group pruning surface for Profile B files with no covering column.
    geospatial_statistics?: { bbox?: RawGeoStatsBbox };
  };
}

interface RawRowGroup {
  columns: RawColumn[];
  num_rows: bigint | number;
  total_byte_size: bigint | number;
}

interface RawMetadata {
  row_groups: RawRowGroup[];
  num_rows: bigint | number;
  key_value_metadata?: RawKeyValue[];
}

function findKeyValue(metadata: RawMetadata, key: string): string | null {
  const entry = (metadata.key_value_metadata ?? []).find((kv) => kv.key === key);
  return entry ? entry.value : null;
}

function pathsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((part, i) => part === b[i]);
}

function findColumnStatistics(rowGroup: RawRowGroup, path: string[]): RawStatistics | null {
  const column = rowGroup.columns.find((c) => pathsEqual(c.meta_data.path_in_schema, path));
  return column?.meta_data.statistics ?? null;
}

// True when a native GeospatialStatistics bbox carries finite, correctly
// ordered bounds. An all-null column chunk (e.g. the finest band's
// `geom_overview`, which is null for every row in that band) still gets
// `geospatial_statistics` from the writer, but with null bounds, so this
// guard rejects it and lets the caller fall through to the next candidate.
function isUsableGeoStatsBbox(bbox: RawGeoStatsBbox | undefined): bbox is RawGeoStatsBbox {
  return (
    !!bbox &&
    Number.isFinite(bbox.xmin) &&
    Number.isFinite(bbox.ymin) &&
    Number.isFinite(bbox.xmax) &&
    Number.isFinite(bbox.ymax) &&
    bbox.xmin <= bbox.xmax &&
    bbox.ymin <= bbox.ymax
  );
}

// The native GeospatialStatistics bbox of one column chunk, or null when the
// column is absent or its stats are unusable (see isUsableGeoStatsBbox).
function findGeospatialStatsBbox(rowGroup: RawRowGroup, path: string[]): RawGeoStatsBbox | null {
  const column = rowGroup.columns.find((c) => pathsEqual(c.meta_data.path_in_schema, path));
  const bbox = column?.meta_data.geospatial_statistics?.bbox;
  return isUsableGeoStatsBbox(bbox) ? bbox : null;
}

// The GeoJSON geometry types the viewer can flatten and draw. Any type not in
// this set (or a declared-but-empty type list) means the file carries nothing
// renderable, which the UI surfaces as a notice.
const RENDERABLE_TYPES = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
]);

// True when the file has at least one geometry type the renderer can draw, or
// when the types are unknown (null), since a missing geometry_types is common and
// must not be treated as unrenderable. A declared-but-empty or all-unknown list
// returns false so the caller can warn.
export function hasRenderableGeometry(types: string[] | null): boolean {
  if (types === null) return true;
  return types.some((t) => RENDERABLE_TYPES.has(t.split(' ')[0]));
}

// Read the primary column's declared geometry_types, normalising to a string
// array or null when the field is absent or not an array.
function extractGeometryTypes(geo: Record<string, unknown> | null): string[] | null {
  if (!geo) return null;
  const primaryColumn = (geo.primary_column as string) ?? 'geometry';
  const columns = geo.columns as Record<string, { geometry_types?: unknown }> | undefined;
  const types = columns?.[primaryColumn]?.geometry_types;
  if (!Array.isArray(types)) return null;
  return types.map((t) => String(t));
}

// Interpret the raw `overviews` block into a typed pyramid. Returns null when
// the block is absent or carries no `levels` array (the flat sort variants),
// in which case the viewer falls back to reading the full geometry column.
//
// Two dialects are accepted. This spec's `overviews` key writes per-level
// `level` ordinals and `max_zoom`; the gpq-tiles `geo:overviews` key writes
// `zoom` and no ordinal (levels are already sorted coarsest-first), plus a
// `mode` field distinguishing its cumulative `partitioning` layout (same
// prefix reads as this spec) from its self-contained `duplicating` layout.
export function parseOverviews(raw: Record<string, unknown> | null): OverviewsInfo | null {
  if (!raw || !Array.isArray(raw.levels) || raw.levels.length === 0) return null;
  const mode = raw.mode === 'duplicating' ? 'duplicating' : 'banded';
  const levels: OverviewLevel[] = (raw.levels as Record<string, unknown>[])
    .map((l, i) => ({
      level: l.level !== undefined ? Number(l.level) : i,
      rowGroupEnd: Number(l.row_group_end),
      rowGroupStart: 0, // stamped after the sort, from the previous level
      maxZoom: l.max_zoom !== undefined ? Number(l.max_zoom) : Number(l.zoom),
      gsd: Number(l.gsd),
      // NaN when absent, so the ladder post-pass below can fill it.
      minZoom: l.min_zoom != null ? Number(l.min_zoom) : NaN,
      featureCount: l.feature_count != null ? Number(l.feature_count) : null,
      bytes:
        Array.isArray(l.bytes) && l.bytes.length === 2
          ? ([Number(l.bytes[0]), Number(l.bytes[1])] as [number, number])
          : null,
      extent:
        Array.isArray(l.extent) && l.extent.length === 4
          ? (l.extent.map(Number) as [number, number, number, number])
          : null,
      // parseOverviews has no projection, so the reprojected form is filled
      // later in readGeoParquetMetadata.
      extentBbox: null as Bbox | null,
    }))
    .sort((a, b) => a.level - b.level);
  if (mode === 'duplicating') {
    for (let i = 1; i < levels.length; i++) {
      levels[i].rowGroupStart = levels[i - 1].rowGroupEnd + 1;
    }
  }
  // Fill any missing minZoom from the band ladder, so the field is robust
  // whether or not the footer carries it. Level 0 starts at zoom 0, every later
  // band starts one past the previous band's maxZoom.
  for (let i = 0; i < levels.length; i++) {
    if (!Number.isFinite(levels[i].minZoom)) {
      // Never let the fill run past this band's own maxZoom, a non-monotonic
      // older footer would otherwise print a backwards range like z25-10.
      levels[i].minZoom = i === 0 ? 0 : Math.min(levels[i - 1].maxZoom + 1, levels[i].maxZoom);
    }
  }
  return {
    version: String(raw.version ?? ''),
    mode,
    spatialKey: String(raw.spatial_key ?? ''),
    overviewColumn: typeof raw.overview_column === 'string' ? raw.overview_column : null,
    overviewMethod: typeof raw.overview_method === 'string' ? raw.overview_method : null,
    importance: typeof raw.importance === 'string' ? raw.importance : null,
    countColumn: typeof raw.count_column === 'string' ? raw.count_column : null,
    levels,
  };
}

// Stamp each row group with its band from the level prefixes. Row groups sit in
// the band whose rowGroupEnd first covers their index (band-major layout).
function bandForIndex(index: number, levels: OverviewLevel[]): number | null {
  for (const level of levels) {
    if (index <= level.rowGroupEnd) return level.level;
  }
  return null;
}

function extractCoveringPaths(geo: Record<string, unknown> | null): CoveringPaths | null {
  if (!geo) return null;
  const primaryColumn = (geo.primary_column as string) ?? 'geometry';
  const columns = geo.columns as Record<string, { covering?: { bbox?: CoveringPaths } }> | undefined;
  return columns?.[primaryColumn]?.covering?.bbox ?? null;
}

export function readGeoParquetMetadata(rawMeta: FileMetaData): GeoParquetMetadata {
  const metadata = rawMeta as unknown as RawMetadata;

  const geoRaw = findKeyValue(metadata, 'geo');
  const geo = geoRaw ? (JSON.parse(geoRaw) as Record<string, unknown>) : null;
  // `overviews` is this spec's key; `geo:overviews` is the gpq-tiles
  // incubation key for the same idea. When both are present the spec key wins.
  const overviewsRaw = findKeyValue(metadata, 'overviews') ?? findKeyValue(metadata, 'geo:overviews');
  const overviews = overviewsRaw ? (JSON.parse(overviewsRaw) as Record<string, unknown>) : null;
  const overviewsInfo = parseOverviews(overviews);
  const coveringPaths = extractCoveringPaths(geo);
  const geometryTypes = extractGeometryTypes(geo);
  const projection = parseCrs(geo);

  // Reproject each band's padded extent to lon/lat, the same transform applied
  // to every row-group bbox below, so a band extent can be compared to a
  // lon/lat AOI for the whole-band skip. A band with no extent keeps a null
  // extentBbox and is never skipped.
  if (overviewsInfo) {
    for (const level of overviewsInfo.levels) {
      if (level.extent) {
        const [xmin, ymin, xmax, ymax] = level.extent;
        level.extentBbox = reprojectBbox({ xmin, ymin, xmax, ymax }, projection.transform);
      }
    }
  }

  const rowGroups: RowGroupInfo[] = metadata.row_groups.map((rowGroup, index) => {
    let bbox: Bbox | null = null;
    if (coveringPaths) {
      const xminStats = findColumnStatistics(rowGroup, coveringPaths.xmin);
      const yminStats = findColumnStatistics(rowGroup, coveringPaths.ymin);
      const xmaxStats = findColumnStatistics(rowGroup, coveringPaths.xmax);
      const ymaxStats = findColumnStatistics(rowGroup, coveringPaths.ymax);
      if (
        xminStats?.min_value !== undefined &&
        yminStats?.min_value !== undefined &&
        xmaxStats?.max_value !== undefined &&
        ymaxStats?.max_value !== undefined
      ) {
        bbox = reprojectBbox(
          {
            xmin: xminStats.min_value,
            ymin: yminStats.min_value,
            xmax: xmaxStats.max_value,
            ymax: ymaxStats.max_value,
          },
          projection.transform,
        );
      }
    }
    if (!bbox) {
      // Profile B files (converter --no-bbox) carry no physical covering
      // column. Fall back to native GeospatialStatistics, which hyparquet
      // exposes as `geospatial_statistics` on meta_data. At coarse zoom the
      // viewer paints the grid-snapped `geom_overview` column, not the exact
      // `geometry` column, so prefer the overview column's own native stats
      // here: they are computed from the overview geometry actually written,
      // so (unlike the exact column's stats) they need no separate padding
      // for the grid snap (see SPEC.md's Profile B paragraph). The finest
      // band's `geom_overview` chunk is all null, so it carries no usable
      // bounds (isUsableGeoStatsBbox rejects it) and this falls through to
      // the primary geometry column's stats, which is correct since the
      // finest band renders exact geometry anyway. Same reprojection as the
      // covering path so pruning is identical either way.
      const primary = (geo?.primary_column as string) ?? 'geometry';
      const overviewColumn = overviewsInfo?.overviewColumn ?? null;
      const gs =
        (overviewColumn ? findGeospatialStatsBbox(rowGroup, [overviewColumn]) : null) ??
        findGeospatialStatsBbox(rowGroup, [primary]);
      if (gs) {
        bbox = reprojectBbox({ xmin: gs.xmin, ymin: gs.ymin, xmax: gs.xmax, ymax: gs.ymax }, projection.transform);
      }
    }
    return {
      index,
      rowCount: Number(rowGroup.num_rows),
      totalByteSize: Number(rowGroup.total_byte_size),
      bbox,
      band: overviewsInfo ? bandForIndex(index, overviewsInfo.levels) : null,
    };
  });

  return {
    rowGroups,
    totalRows: Number(metadata.num_rows),
    coveringPaths,
    geo,
    overviews,
    overviewsInfo,
    geometryTypes,
    projection,
    rawRowGroups: rawMeta.row_groups,
    schema: rawMeta.schema,
  };
}

// One importance band's share of the file, for the read-cost panel's file
// facts. rows is the feature count in the band, isExact marks the finest band
// that carries exact geometry and no overview.
export interface BandFact {
  level: number;
  rows: number;
  maxZoom: number;
  gsd: number;
  isExact: boolean;
}

// Static, per-file facts derived once from the footer. Everything here is known
// before any view is fetched, so it describes the file's own read behavior
// rather than the cost of one viewport.
export interface FileFacts {
  fileBytes: number;
  totalRows: number;
  rowGroupCount: number;
  medianRowGroupBytes: number;
  // The primary geometry column's compression codec, or 'mixed' when its chunks
  // disagree. Overall ratio is total uncompressed over total compressed bytes.
  codec: string;
  compressionRatio: number;
  bands: BandFact[];
  overviewMethod: string | null;
  importance: string | null;
  overviewColumn: string | null;
  hasCovering: boolean;
  hasPageIndex: boolean;
  // Total compressed bytes of the exact `geometry` column and of the overview
  // column across every row group, so the panel can frame what a full exact read
  // would have cost against what the overview path actually read.
  exactGeometryBytes: number;
  overviewGeometryBytes: number;
  // Whether the whole file was downloaded once (small file) rather than read
  // over ranges, since that changes what "bytes over the wire" means per view.
  prefetched: boolean;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Minimal shape of a raw column chunk's metadata needed for the file facts.
interface RawChunkMeta {
  path_in_schema: string[];
  codec?: string;
  total_compressed_size?: bigint | number;
  total_uncompressed_size?: bigint | number;
}

// Derive the static file facts from parsed metadata. fileBytes and prefetched
// come from the caller since they are known at load time, not from the footer.
export function computeFileFacts(meta: GeoParquetMetadata, fileBytes: number, prefetched: boolean): FileFacts {
  const info = meta.overviewsInfo;
  const overviewColumn = info?.overviewColumn ?? null;

  let totalCompressed = 0;
  let totalUncompressed = 0;
  let exactGeometryBytes = 0;
  let overviewGeometryBytes = 0;
  const geometryCodecs = new Set<string>();
  for (const rg of meta.rawRowGroups) {
    for (const col of rg.columns) {
      const md = col.meta_data as RawChunkMeta | undefined;
      if (!md) continue;
      const compressed = Number(md.total_compressed_size ?? 0);
      totalCompressed += compressed;
      totalUncompressed += Number(md.total_uncompressed_size ?? 0);
      const leaf = md.path_in_schema.length === 1 ? md.path_in_schema[0] : null;
      if (leaf === 'geometry') {
        exactGeometryBytes += compressed;
        if (md.codec) geometryCodecs.add(md.codec);
      } else if (overviewColumn && leaf === overviewColumn) {
        overviewGeometryBytes += compressed;
      }
    }
  }

  const bands: BandFact[] = (info?.levels ?? []).map((level, i, all) => ({
    level: level.level,
    rows: meta.rowGroups.filter((rg) => rg.band === level.level).reduce((sum, rg) => sum + rg.rowCount, 0),
    maxZoom: level.maxZoom,
    gsd: level.gsd,
    isExact: i === all.length - 1,
  }));

  const coveringCols = coveringChunks(meta);
  const hasPageIndex =
    coveringCols !== null &&
    coveringCols.every(
      (c) =>
        c.column_index_offset != null && !!c.column_index_length && c.offset_index_offset != null && !!c.offset_index_length,
    );

  return {
    fileBytes,
    totalRows: meta.totalRows,
    rowGroupCount: meta.rowGroups.length,
    medianRowGroupBytes: median(meta.rowGroups.map((rg) => rg.totalByteSize)),
    codec: geometryCodecs.size === 1 ? [...geometryCodecs][0] : geometryCodecs.size === 0 ? 'unknown' : 'mixed',
    compressionRatio: totalCompressed > 0 ? totalUncompressed / totalCompressed : 0,
    bands,
    overviewMethod: info?.overviewMethod ?? null,
    importance: info?.importance ?? null,
    overviewColumn,
    hasCovering: meta.coveringPaths !== null,
    hasPageIndex,
    exactGeometryBytes,
    overviewGeometryBytes,
    prefetched,
  };
}

// Compressed bytes of one leaf column's chunk in a given row group, or null when
// the file exposes no such chunk. Lets the row-group popup show what fetching
// this group's geometry actually costs, as opposed to its whole size on disk.
export function columnChunkBytes(meta: GeoParquetMetadata, rowGroupIndex: number, leaf: string): number | null {
  const rg = meta.rawRowGroups[rowGroupIndex];
  if (!rg) return null;
  const col = rg.columns.find((c) => {
    const md = c.meta_data as RawChunkMeta | undefined;
    return md != null && md.path_in_schema.length === 1 && md.path_in_schema[0] === leaf;
  });
  const md = col?.meta_data as RawChunkMeta | undefined;
  return md ? Number(md.total_compressed_size ?? 0) : null;
}

// The first row group's four bbox covering column chunks, used to probe whether
// the file carries the page indexes the sub-row-group prune path needs. The
// ColumnIndex/OffsetIndex offsets live on the outer ColumnChunk (not on
// meta_data), the same object the reader in pageindex.ts reads them from, so we
// return the ColumnChunk itself. All four leaves must be present for the page
// path to run, matching pageRangesForRowGroup's guard.
function coveringChunks(meta: GeoParquetMetadata): ColumnChunk[] | null {
  if (!meta.coveringPaths || meta.rawRowGroups.length === 0) return null;
  const rg = meta.rawRowGroups[0];
  const chunks: ColumnChunk[] = [];
  for (const path of [meta.coveringPaths.xmin, meta.coveringPaths.ymin, meta.coveringPaths.xmax, meta.coveringPaths.ymax]) {
    const col = rg.columns.find((c) => c.meta_data && pathsEqual(c.meta_data.path_in_schema, path));
    if (!col) return null;
    chunks.push(col);
  }
  return chunks;
}

// Index the flat schema by leaf column name, so the page reader can resolve a
// covering column's SchemaElement when converting its ColumnIndex values.
export function schemaLookup(schema: SchemaElement[]): Map<string, SchemaElement> {
  const map = new Map<string, SchemaElement>();
  for (const element of schema) map.set(element.name, element);
  return map;
}

// The top-level non-geometry columns, i.e. the feature attributes to show in the
// click popup. Excluded are every geometry column named in the `geo` block, the
// primary geometry column (so a non-conformant file with no `geo` block but a
// column literally named `geometry` still drops it), the overview column, and the
// `bbox` covering struct (dropped by its root name, not by being nested, so real
// struct attributes survive). Every remaining top-level column is emitted once by
// its root name, so both a scalar column and a struct attribute column (whose
// leaves carry multi-part paths, e.g. an Overture `names.primary`) come through,
// the struct read whole by hyparquet. The importance `band` ordinal is kept.
// Reads the first row group's column list, which every row group shares. Order
// follows the file's schema.
export function attributeColumns(meta: GeoParquetMetadata): string[] {
  const excluded = new Set<string>();
  const geo = meta.geo && typeof meta.geo === 'object' ? meta.geo : null;
  const geoColumns = geo && typeof geo.columns === 'object' ? (geo.columns as Record<string, unknown>) : null;
  if (geoColumns) {
    for (const name of Object.keys(geoColumns)) excluded.add(name);
  }
  excluded.add(geo && typeof geo.primary_column === 'string' ? geo.primary_column : 'geometry');
  const overviewCol = meta.overviewsInfo?.overviewColumn;
  if (overviewCol) excluded.add(overviewCol);
  // The covering struct's root (e.g. `bbox`), so its members drop by name rather
  // than by being nested, which would also drop legitimate struct attributes.
  const coveringRoot = meta.coveringPaths?.xmin?.[0];
  if (coveringRoot) excluded.add(coveringRoot);

  const first = meta.rawRowGroups[0];
  if (!first) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const column of first.columns as ColumnChunk[]) {
    const path = column.meta_data?.path_in_schema ?? [];
    if (path.length === 0) continue;
    const root = path[0]; // a struct's leaves collapse to one top-level entry
    if (excluded.has(root) || seen.has(root)) continue;
    seen.add(root);
    out.push(root);
  }
  return out;
}

export async function loadMetadataFromUrl(url: string): Promise<GeoParquetMetadata> {
  const { metadata: rawMeta } = await getCachedFile(url);
  const meta = readGeoParquetMetadata(rawMeta);
  pinCoarseRanges(url, coarseColumnIntervals(meta));
  return meta;
}

// The physical byte intervals of the coarse bands' overview column chunks. The
// coarse bands are every level except the last (exact) one, and they read the
// overview column, so pinning these keeps the low-zoom preview resident once
// fetched. Returns nothing for files with no overview column or fewer than two
// levels, in which case there is no coarse band to pin.
export function coarseColumnIntervals(meta: GeoParquetMetadata): Array<[number, number]> {
  const info = meta.overviewsInfo;
  if (!info || !info.overviewColumn || info.levels.length < 2) return [];
  const lastCoarseEnd = info.levels[info.levels.length - 2].rowGroupEnd;
  const intervals: Array<[number, number]> = [];
  for (let i = 0; i <= lastCoarseEnd && i < meta.rawRowGroups.length; i++) {
    const chunk = meta.rawRowGroups[i].columns.find(
      (c) =>
        c.meta_data &&
        c.meta_data.path_in_schema.length === 1 &&
        c.meta_data.path_in_schema[0] === info.overviewColumn,
    );
    const md = chunk?.meta_data;
    if (!md) continue;
    const startBig = md.dictionary_page_offset ?? md.data_page_offset;
    if (startBig == null) continue;
    const start = Number(startBig);
    intervals.push([start, start + Number(md.total_compressed_size)]);
  }
  return intervals;
}

// A null bbox means "unknown", not "empty", so it must never be pruned away.
// Keep any row group whose bbox we could not determine, and prune only the
// ones we can prove do not intersect the AOI.
export function rowGroupsIntersecting(rowGroups: RowGroupInfo[], aoi: Bbox): number[] {
  return rowGroups.filter((rg) => rg.bbox === null || bboxIntersectsAoi(rg.bbox, aoi)).map((rg) => rg.index);
}

// The overview level a web zoom should read. Picks the coarsest level whose
// maxZoom still covers the zoom, so overviews win at low zoom and the exact
// level wins once you pass its predecessor's ceiling. Falls back to the last
// (exact) level.
export function levelForZoom(info: OverviewsInfo, zoom: number): OverviewLevel {
  for (const level of info.levels) {
    if (zoom <= level.maxZoom) return level;
  }
  return info.levels[info.levels.length - 1];
}

// The geometry column to read for a level. Coarse bands read the simplified
// overview column, the finest (exact) band reads the full geometry, since the
// overview column is null there.
export function columnForLevel(info: OverviewsInfo, level: OverviewLevel): string {
  const lastLevel = info.levels[info.levels.length - 1];
  if (info.overviewColumn && level.level < lastLevel.level) return info.overviewColumn;
  return 'geometry';
}

// True when the footer's `version` string is at least major.minor, comparing
// only the leading "MAJOR.MINOR" digits. A missing or unparsable version reads
// as old, so behavior newer drafts opt into stays off for it.
function overviewsVersionAtLeast(version: string, major: number, minor: number): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return false;
  const maj = Number(m[1]);
  const min = Number(m[2]);
  return maj > major || (maj === major && min >= minor);
}

// The geometry column to read for one row group within a cumulative-prefix read
// at `level`. The target band reads its own column (its overview, or exact for
// the finest band). On a banded 0.3.0+ file, a coarser band caught in the same
// prefix reads its EXACT geometry instead of its own overview, because 0.3.0
// snaps each band to its own per-band grid tied to that band's zoom, so its
// overview painted at this finer zoom would show as an oversized block (a
// band-2 building snapped to a ~0.6 km grid is a ~1 km triangle at z16).
// Coarse bands hold few features there, so their exact geometry is cheap and
// crisp. Pre-0.3.0 files snapped every band to one fine global grid, so their
// coarse overviews render correctly at mid zoom, and their band 0 holds the
// largest-area (heaviest WKB) features, so reading them exact would multiply
// the mid-zoom read cost on every already-published dataset. Those files, and
// any file with no parsable version, keep the plain per-level column. The
// gpq-tiles duplicating layout reads only the target band's own slice, so the
// fallback never applies there and columnForLevel serves it unchanged.
export function columnForRowGroup(
  info: OverviewsInfo,
  level: OverviewLevel,
  rgBand: number | null,
): string {
  if (
    info.mode === 'banded' &&
    overviewsVersionAtLeast(info.version, 0, 3) &&
    rgBand !== null &&
    rgBand < level.level
  ) {
    return 'geometry';
  }
  return columnForLevel(info, level);
}

// The band ordinals whose padded extent is known and does not intersect the
// AOI. Every feature in such a band is outside the view, so all of its row
// groups can be skipped, including the ones whose own bbox is null. A band with
// an unknown (null) extentBbox is NEVER added, unknown extent means keep, the
// same conservative rule as a null row-group bbox. This can only ever remove
// row groups we can prove are outside the view.
export function bandsOutsideAoi(levels: OverviewLevel[], aoi: Bbox): Set<number> {
  const skip = new Set<number>();
  for (const level of levels) {
    if (level.extentBbox && !bboxIntersectsAoi(level.extentBbox, aoi)) {
      skip.add(level.level);
    }
  }
  return skip;
}

// Row groups a level covers, intersected with the AOI. In the banded (this
// spec's cumulative) layout a level owns the prefix [0..rowGroupEnd]; in the
// duplicating layout it owns only its own slice [rowGroupStart..rowGroupEnd], a
// complete self-contained rendering. rowGroupStart is 0 for banded, so the same
// lower bound serves both. Within that range the bbox covering prunes to the
// viewport, and `skipBands` drops any row group whose whole band was proven
// outside the view (see bandsOutsideAoi), including a band's null-bbox groups
// the per-group bbox check would otherwise keep.
export function rowGroupsForLevel(
  rowGroups: RowGroupInfo[],
  level: OverviewLevel,
  aoi: Bbox,
  skipBands: Set<number> = new Set(),
): number[] {
  return rowGroups
    .filter(
      (rg) =>
        rg.index >= level.rowGroupStart &&
        rg.index <= level.rowGroupEnd &&
        !(rg.band !== null && skipBands.has(rg.band)) &&
        (rg.bbox === null || bboxIntersectsAoi(rg.bbox, aoi)),
    )
    .map((rg) => rg.index);
}

// Union of every row group's covering bbox, i.e. the file's own footprint.
// Used to fly the map to the data on load, before any AOI is chosen. Null
// when no row group exposes a covering bbox.
export function fileExtent(rowGroups: RowGroupInfo[]): Bbox | null {
  let extent: Bbox | null = null;
  for (const rg of rowGroups) {
    if (!rg.bbox) continue;
    if (!extent) {
      extent = { ...rg.bbox };
    } else {
      extent.xmin = Math.min(extent.xmin, rg.bbox.xmin);
      extent.ymin = Math.min(extent.ymin, rg.bbox.ymin);
      extent.xmax = Math.max(extent.xmax, rg.bbox.xmax);
      extent.ymax = Math.max(extent.ymax, rg.bbox.ymax);
    }
  }
  return extent;
}
