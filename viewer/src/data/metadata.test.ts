import { describe, it, expect } from 'vitest';
import {
  levelForZoom,
  columnForLevel,
  columnForRowGroup,
  rowGroupsForLevel,
  bandsOutsideAoi,
  coarseColumnIntervals,
  computeFileFacts,
  columnChunkBytes,
  parseOverviews,
  hasRenderableGeometry,
  attributeColumns,
  readGeoParquetMetadata,
  type OverviewsInfo,
  type RowGroupInfo,
  type GeoParquetMetadata,
} from './metadata';

// A three band overviews footer, band major with an overview column.
const INFO: OverviewsInfo = {
  version: '0.1.0',
  mode: 'banded',
  spatialKey: 'hilbert',
  overviewColumn: 'geom_overview',
  overviewMethod: 'simplify_snap',
  importance: 'area_desc',
  countColumn: null,
  levels: [
    { level: 0, rowGroupEnd: 19, rowGroupStart: 0, maxZoom: 8, gsd: 0.005, minZoom: 0, featureCount: null, bytes: null, extent: null, extentBbox: null },
    { level: 1, rowGroupEnd: 53, rowGroupStart: 0, maxZoom: 10, gsd: 0.00125, minZoom: 9, featureCount: null, bytes: null, extent: null, extentBbox: null },
    { level: 2, rowGroupEnd: 80, rowGroupStart: 0, maxZoom: 24, gsd: 0.0, minZoom: 11, featureCount: null, bytes: null, extent: null, extentBbox: null },
  ],
};

describe('levelForZoom', () => {
  it('picks the overview band at low zoom', () => {
    expect(levelForZoom(INFO, 4).level).toBe(0);
    expect(levelForZoom(INFO, 8).level).toBe(0);
  });

  it('picks the mid band just past the overview ceiling', () => {
    expect(levelForZoom(INFO, 8.5).level).toBe(1);
    expect(levelForZoom(INFO, 10).level).toBe(1);
  });

  it('picks the exact band above the mid ceiling', () => {
    expect(levelForZoom(INFO, 10.5).level).toBe(2);
    expect(levelForZoom(INFO, 22).level).toBe(2);
  });

  it('clamps beyond the last band to the exact band', () => {
    expect(levelForZoom(INFO, 999).level).toBe(2);
  });
});

describe('parseOverviews', () => {
  it('parses a footer with an overview column', () => {
    const info = parseOverviews({
      version: '0.1.0',
      spatial_key: 'hilbert',
      overview_column: 'geom_overview',
      levels: [
        { level: 0, row_group_end: 3, max_zoom: 8, gsd: 0.005 },
        { level: 1, row_group_end: 9, max_zoom: 24, gsd: 0 },
      ],
    });
    expect(info).not.toBeNull();
    expect(info!.overviewColumn).toBe('geom_overview');
    expect(info!.levels).toHaveLength(2);
    expect(info!.levels[0].rowGroupEnd).toBe(3);
  });

  it('parses a thin-mode footer with no overview_column (points), keeping levels', () => {
    // Pure-point files thin points into bands but write no geom_overview column,
    // so overviewColumn is null while the banded levels still parse.
    const info = parseOverviews({
      version: '0.1.0',
      spatial_key: 'hilbert',
      levels: [
        { level: 0, row_group_end: 2, max_zoom: 6, gsd: 0.01 },
        { level: 1, row_group_end: 5, max_zoom: 24, gsd: 0 },
      ],
    });
    expect(info).not.toBeNull();
    expect(info!.overviewColumn).toBeNull();
    expect(info!.levels).toHaveLength(2);
  });

  it('returns null when the block is absent or has no levels', () => {
    expect(parseOverviews(null)).toBeNull();
    expect(parseOverviews({ version: '0.1.0' })).toBeNull();
    expect(parseOverviews({ levels: [] })).toBeNull();
  });

  it('parses optional level bytes and extent', () => {
    const info = parseOverviews({
      version: '0.2.0',
      levels: [
        { level: 0, row_group_end: 1, max_zoom: 8, gsd: 100, bytes: [4, 9000], extent: [0, 0, 10, 10] },
        { level: 1, row_group_end: 5, max_zoom: 22, gsd: 0 },
      ],
    });
    expect(info!.levels[0].bytes).toEqual([4, 9000]);
    expect(info!.levels[0].extent).toEqual([0, 0, 10, 10]);
    expect(info!.levels[1].bytes).toBeNull();
    expect(info!.levels[1].extent).toBeNull();
  });

  it('reads min_zoom when present (0.3.0 file)', () => {
    const info = parseOverviews({
      version: '0.3.0',
      levels: [
        { level: 0, row_group_end: 1, max_zoom: 8, gsd: 100, min_zoom: 0 },
        { level: 1, row_group_end: 5, max_zoom: 12, gsd: 10, min_zoom: 9 },
        { level: 2, row_group_end: 9, max_zoom: 22, gsd: 0, min_zoom: 13 },
      ],
    });
    expect(info!.levels.map((l) => l.minZoom)).toEqual([0, 9, 13]);
  });

  it('fills min_zoom from the ladder when absent (old 0.2.0 file)', () => {
    // No min_zoom on any level, so the ladder derives it, level 0 at zoom 0 and
    // each later band one past the previous band's max_zoom.
    const info = parseOverviews({
      version: '0.2.0',
      levels: [
        { level: 0, row_group_end: 1, max_zoom: 8, gsd: 100 },
        { level: 1, row_group_end: 5, max_zoom: 12, gsd: 10 },
        { level: 2, row_group_end: 9, max_zoom: 22, gsd: 0 },
      ],
    });
    expect(info!.levels.map((l) => l.minZoom)).toEqual([0, 9, 13]);
  });

  it('parses feature_count when present and is null when absent', () => {
    const info = parseOverviews({
      version: '0.3.0',
      levels: [
        { level: 0, row_group_end: 1, max_zoom: 8, gsd: 100, feature_count: 350_000_000 },
        { level: 1, row_group_end: 5, max_zoom: 22, gsd: 0 },
      ],
    });
    expect(info!.levels[0].featureCount).toBe(350_000_000);
    expect(info!.levels[1].featureCount).toBeNull();
  });

  it('parses count_column when present and is null when absent', () => {
    const levels = [
      { level: 0, row_group_end: 1, max_zoom: 8, gsd: 100 },
      { level: 1, row_group_end: 5, max_zoom: 22, gsd: 0 },
    ];
    const withCounts = parseOverviews({ version: '0.3.0', count_column: 'overview_count', levels });
    expect(withCounts!.countColumn).toBe('overview_count');
    // Absent (pre 0.3.0, or 0.3.0 with no thinning counts) reads as null.
    expect(parseOverviews({ version: '0.2.0', levels })!.countColumn).toBeNull();
    // A non-string value is ignored, not stringified.
    expect(parseOverviews({ version: '0.3.0', count_column: 7, levels })!.countColumn).toBeNull();
  });
});

describe('bandsOutsideAoi', () => {
  // Band 0's extent sits far east of the AOI, band 1 overlaps it, band 2 has no
  // extentBbox at all (unknown extent).
  const level = (l: number, extentBbox: { xmin: number; ymin: number; xmax: number; ymax: number } | null) => ({
    level: l,
    rowGroupEnd: l,
    rowGroupStart: 0,
    maxZoom: 8,
    gsd: 0,
    minZoom: 0,
    featureCount: null,
    bytes: null,
    extent: null,
    extentBbox,
  });
  const levels = [
    level(0, { xmin: 100, ymin: 0, xmax: 110, ymax: 10 }),
    level(1, { xmin: 0, ymin: 0, xmax: 10, ymax: 10 }),
    level(2, null),
  ];
  const aoi = { xmin: 1, ymin: 1, xmax: 5, ymax: 5 };

  it('returns a band whose extent misses the AOI', () => {
    const skip = bandsOutsideAoi(levels, aoi);
    expect(skip.has(0)).toBe(true);
  });

  it('never returns a band whose extent intersects the AOI', () => {
    expect(bandsOutsideAoi(levels, aoi).has(1)).toBe(false);
  });

  it('never returns a band with a null extentBbox (unknown extent means keep)', () => {
    expect(bandsOutsideAoi(levels, aoi).has(2)).toBe(false);
  });
});

describe('hasRenderableGeometry', () => {
  it('treats unknown (null) types as renderable so a missing field never warns', () => {
    expect(hasRenderableGeometry(null)).toBe(true);
  });

  it('is true when at least one declared type is drawable, ignoring Z suffixes', () => {
    expect(hasRenderableGeometry(['Point'])).toBe(true);
    expect(hasRenderableGeometry(['Polygon Z', 'MultiPolygon'])).toBe(true);
  });

  it('is false for a declared-but-empty or all-unknown type list', () => {
    expect(hasRenderableGeometry([])).toBe(false);
    expect(hasRenderableGeometry(['Curve', 'Surface'])).toBe(false);
  });
});

describe('columnForLevel', () => {
  it('reads the overview column for coarse bands', () => {
    expect(columnForLevel(INFO, INFO.levels[0])).toBe('geom_overview');
    expect(columnForLevel(INFO, INFO.levels[1])).toBe('geom_overview');
  });

  it('reads the exact geometry for the finest band', () => {
    expect(columnForLevel(INFO, INFO.levels[2])).toBe('geometry');
  });

  it('always reads geometry when there is no overview column', () => {
    const flat: OverviewsInfo = { ...INFO, overviewColumn: null };
    expect(columnForLevel(flat, flat.levels[0])).toBe('geometry');
  });

  it('reads geometry for every band in thin mode, coarse bands included', () => {
    // Thin-mode point files carry banded levels but no overview column, so even
    // the coarse bands must fall back to the primary geometry column.
    const thin: OverviewsInfo = { ...INFO, overviewColumn: null };
    expect(columnForLevel(thin, thin.levels[0])).toBe('geometry');
    expect(columnForLevel(thin, thin.levels[1])).toBe('geometry');
    expect(columnForLevel(thin, thin.levels[2])).toBe('geometry');
  });
});

describe('columnForRowGroup', () => {
  // The exact-geometry fallback for a coarser band caught in a finer band's
  // prefix is version gated. 0.3.0 snaps each band to its own coarse grid, so
  // painting a coarse overview at a finer zoom shows giant blocks and the
  // fallback is required. 0.1.0/0.2.0 snapped every band to one fine global
  // grid, so their coarse overviews are correct at mid zoom and their band 0
  // holds the heaviest exact WKB, so the fallback would multiply the read cost.
  const INFO_030: OverviewsInfo = { ...INFO, version: '0.3.0' };

  it('reads exact geometry for a coarser band in the prefix on a 0.3.0 file', () => {
    expect(columnForRowGroup(INFO_030, INFO_030.levels[1], 0)).toBe('geometry');
    expect(columnForRowGroup(INFO_030, INFO_030.levels[2], 0)).toBe('geometry');
    expect(columnForRowGroup(INFO_030, INFO_030.levels[2], 1)).toBe('geometry');
  });

  it('reads the level column for the target band and past 0.3.0', () => {
    expect(columnForRowGroup(INFO_030, INFO_030.levels[1], 1)).toBe('geom_overview');
    expect(columnForRowGroup(INFO_030, INFO_030.levels[2], 2)).toBe('geometry');
    // A later draft keeps the fallback, the compare is >=, not ===.
    const future: OverviewsInfo = { ...INFO, version: '1.0.0' };
    expect(columnForRowGroup(future, future.levels[1], 0)).toBe('geometry');
  });

  it('keeps the overview column for a coarser prefix band on a pre-0.3.0 file', () => {
    // INFO is 0.1.0, one fine global snap grid, so the coarse overview is
    // correct at this zoom and stays the cheap read.
    expect(columnForRowGroup(INFO, INFO.levels[1], 0)).toBe('geom_overview');
    expect(columnForRowGroup(INFO, INFO.levels[2], 0)).toBe('geometry'); // finest level is exact anyway
    const v020: OverviewsInfo = { ...INFO, version: '0.2.0' };
    expect(columnForRowGroup(v020, v020.levels[1], 0)).toBe('geom_overview');
  });

  it('treats a missing or unparsable version as old (no fallback)', () => {
    const noVersion: OverviewsInfo = { ...INFO, version: '' };
    expect(columnForRowGroup(noVersion, noVersion.levels[1], 0)).toBe('geom_overview');
    const junk: OverviewsInfo = { ...INFO, version: 'draft' };
    expect(columnForRowGroup(junk, junk.levels[1], 0)).toBe('geom_overview');
  });

  it('leaves the duplicating dialect on the per-level column', () => {
    // A duplicating level is self-contained, so a coarser band never appears in
    // its read anyway; the gate keeps the behavior byte-identical regardless.
    const dup: OverviewsInfo = { ...INFO, version: '0.3.0', mode: 'duplicating' };
    expect(columnForRowGroup(dup, dup.levels[1], 0)).toBe('geom_overview');
  });

  it('keeps the level column for an unknown (null) band', () => {
    expect(columnForRowGroup(INFO_030, INFO_030.levels[1], null)).toBe('geom_overview');
  });
});

describe('rowGroupsForLevel', () => {
  const rg = (index: number, xmin: number, xmax: number): RowGroupInfo => ({
    index,
    rowCount: 100,
    totalByteSize: 1000,
    bbox: { xmin, ymin: 0, xmax, ymax: 1 },
    band: null,
  });
  // Row groups span a strip in x, one every 10 degrees.
  const rowGroups: RowGroupInfo[] = Array.from({ length: 81 }, (_, i) => rg(i, i, i + 1));

  it('returns only the cumulative prefix of the level, pruned by the AOI', () => {
    // AOI covers x in [5, 15], overlapping row groups 4..15 (bbox touches).
    const aoi = { xmin: 5, ymin: 0, xmax: 15, ymax: 1 };
    const level0 = rowGroupsForLevel(rowGroups, INFO.levels[0], aoi);
    // level 0 ends at row group 19, so the whole overlap survives.
    expect(level0).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it('caps the prefix at the level boundary', () => {
    // AOI overlapping row groups 15..25, but level 0 ends at 19.
    const aoi = { xmin: 16, ymin: 0, xmax: 25, ymax: 1 };
    const level0 = rowGroupsForLevel(rowGroups, INFO.levels[0], aoi);
    expect(level0.every((i) => i <= 19)).toBe(true);
    expect(Math.max(...level0)).toBe(19);
    // The exact band would include the row groups past 19.
    const level2 = rowGroupsForLevel(rowGroups, INFO.levels[2], aoi);
    expect(Math.max(...level2)).toBeGreaterThan(19);
  });

  it('drops a null-bbox row group belonging to a skipped band, keeps one in an intersecting band', () => {
    // A skipped band's row groups drop even when their own bbox is null, since
    // the whole band was proven outside the view. Row groups carry a band here,
    // group 0 with a null bbox in skipped band 0, group 1 in band 1 kept.
    const withBand = (index: number, band: number, bbox: RowGroupInfo['bbox']): RowGroupInfo => ({
      index,
      rowCount: 100,
      totalByteSize: 1000,
      bbox,
      band,
    });
    const groups: RowGroupInfo[] = [
      withBand(0, 0, null), // null bbox, band 0 (skipped)
      withBand(1, 1, { xmin: 4, ymin: 0, xmax: 6, ymax: 1 }), // band 1, intersects
    ];
    const aoi = { xmin: 5, ymin: 0, xmax: 15, ymax: 1 };
    const skip = new Set<number>([0]);
    // The finest level owns the whole prefix, so both groups are in range by index.
    const kept = rowGroupsForLevel(groups, INFO.levels[2], aoi, skip);
    expect(kept).toEqual([1]);
    // With no skip set, the null-bbox group 0 is conservatively kept.
    expect(rowGroupsForLevel(groups, INFO.levels[2], aoi)).toEqual([0, 1]);
  });
});

describe('computeFileFacts', () => {
  // Two coarse bands (0, 1) and one exact band (2). Each row group carries a
  // geometry chunk, coarse groups add a geom_overview chunk, and every group
  // has a bbox.xmin covering chunk. Only the first group's covering chunk gets
  // the page-index offsets, which is what the detection probes.
  // The ColumnIndex/OffsetIndex offsets and lengths live on the outer
  // ColumnChunk in real Parquet, not on meta_data, so `extra` spreads onto the
  // outer object here to mirror hyparquet's parsed output.
  const chunk = (
    path: string[],
    codec: string,
    comp: number,
    uncomp: number,
    extra: Record<string, bigint | number> = {},
  ) => ({
    meta_data: { path_in_schema: path, codec, total_compressed_size: BigInt(comp), total_uncompressed_size: BigInt(uncomp) },
    ...extra,
  });
  const covering = { xmin: ['bbox', 'xmin'], ymin: ['bbox', 'ymin'], xmax: ['bbox', 'xmax'], ymax: ['bbox', 'ymax'] };
  // Page-index offsets/lengths a converter-written covering leaf carries.
  const idx = { column_index_offset: 5000n, column_index_length: 40, offset_index_offset: 6000n, offset_index_length: 30 };
  // The four bbox covering leaves for one row group, carrying page indexes.
  const coveringLeaves = (withIndex: boolean) =>
    (['xmin', 'ymin', 'xmax', 'ymax'] as const).map((leaf) => chunk(['bbox', leaf], 'ZSTD', 10, 10, withIndex ? idx : {}));
  const rg = (index: number, band: number, rowCount: number, totalByteSize: number): RowGroupInfo => ({
    index,
    band,
    rowCount,
    totalByteSize,
    bbox: null,
  });
  const meta = {
    totalRows: 1000,
    coveringPaths: covering,
    overviewsInfo: {
      version: '0.1.0',
      spatialKey: 'hilbert',
      overviewColumn: 'geom_overview',
      overviewMethod: 'simplify_snap',
      importance: 'area_desc',
      levels: [
        { level: 0, rowGroupEnd: 0, maxZoom: 8, gsd: 0.005 },
        { level: 1, rowGroupEnd: 1, maxZoom: 10, gsd: 0.001 },
        { level: 2, rowGroupEnd: 2, maxZoom: 24, gsd: 0 },
      ],
    },
    rowGroups: [rg(0, 0, 100, 1000), rg(1, 1, 200, 3000), rg(2, 2, 700, 2000)],
    rawRowGroups: [
      {
        columns: [
          chunk(['geometry'], 'ZSTD', 100, 300),
          chunk(['geom_overview'], 'ZSTD', 50, 100),
          ...coveringLeaves(true),
        ],
      },
      {
        columns: [chunk(['geometry'], 'ZSTD', 200, 600), chunk(['geom_overview'], 'ZSTD', 80, 160), ...coveringLeaves(true)],
      },
      { columns: [chunk(['geometry'], 'ZSTD', 400, 1200), ...coveringLeaves(true)] },
    ],
  } as unknown as GeoParquetMetadata;

  it('derives compression, per-column bytes, bands, and index presence', () => {
    const f = computeFileFacts(meta, 6000, false);
    expect(f.totalRows).toBe(1000);
    expect(f.rowGroupCount).toBe(3);
    expect(f.medianRowGroupBytes).toBe(2000);
    expect(f.codec).toBe('ZSTD');
    expect(f.exactGeometryBytes).toBe(700); // 100 + 200 + 400
    expect(f.overviewGeometryBytes).toBe(130); // 50 + 80
    expect(f.compressionRatio).toBeCloseTo(2480 / 950, 2);
    expect(f.bands).toEqual([
      { level: 0, rows: 100, maxZoom: 8, gsd: 0.005, isExact: false },
      { level: 1, rows: 200, maxZoom: 10, gsd: 0.001, isExact: false },
      { level: 2, rows: 700, maxZoom: 24, gsd: 0, isExact: true },
    ]);
    expect(f.overviewMethod).toBe('simplify_snap');
    expect(f.importance).toBe('area_desc');
    expect(f.hasCovering).toBe(true);
    expect(f.hasPageIndex).toBe(true);
    expect(f.prefetched).toBe(false);
  });

  it('reports no page index when the covering chunks lack the offsets', () => {
    const noIndex = {
      ...meta,
      rawRowGroups: [{ columns: [chunk(['geometry'], 'ZSTD', 100, 300), ...coveringLeaves(false)] }, ...meta.rawRowGroups.slice(1)],
    } as unknown as GeoParquetMetadata;
    expect(computeFileFacts(noIndex, 6000, false).hasPageIndex).toBe(false);
  });

  it('handles a flat file with no overview pyramid', () => {
    const flat = {
      totalRows: 300,
      coveringPaths: null,
      overviewsInfo: null,
      rowGroups: [rg(0, 0, 300, 5000)],
      rawRowGroups: [{ columns: [chunk(['geometry'], 'SNAPPY', 500, 1000)] }],
    } as unknown as GeoParquetMetadata;
    const f = computeFileFacts(flat, 5000, true);
    expect(f.bands).toEqual([]);
    expect(f.overviewColumn).toBeNull();
    expect(f.codec).toBe('SNAPPY');
    expect(f.hasCovering).toBe(false);
    expect(f.hasPageIndex).toBe(false);
    expect(f.prefetched).toBe(true);
  });

  describe('columnChunkBytes', () => {
    it('returns the compressed bytes of a leaf column chunk in a given group', () => {
      expect(columnChunkBytes(meta, 0, 'geometry')).toBe(100);
      expect(columnChunkBytes(meta, 1, 'geom_overview')).toBe(80);
      expect(columnChunkBytes(meta, 2, 'geometry')).toBe(400);
    });

    it('returns null when the group has no such leaf column', () => {
      expect(columnChunkBytes(meta, 2, 'geom_overview')).toBeNull(); // exact band has no overview chunk
      expect(columnChunkBytes(meta, 0, 'bbox')).toBeNull(); // struct path, not a leaf
      expect(columnChunkBytes(meta, 9, 'geometry')).toBeNull(); // out-of-range group
    });
  });
});

describe('attributeColumns', () => {
  const col = (path: string[]) => ({ meta_data: { path_in_schema: path } });

  it('keeps scalar and struct attributes, drops geometry, overview, and the bbox struct', () => {
    // A struct attribute (`names`) contributes several multi-part leaves; it must
    // survive, collapsed to its one top-level root, so hyparquet reads it whole.
    const meta = {
      geo: { primary_column: 'geometry', columns: { geometry: {} } },
      coveringPaths: { xmin: ['bbox', 'xmin'], ymin: ['bbox', 'ymin'], xmax: ['bbox', 'xmax'], ymax: ['bbox', 'ymax'] },
      overviewsInfo: { overviewColumn: 'geom_overview' },
      rawRowGroups: [
        {
          columns: [
            col(['geometry']),
            col(['geom_overview']),
            col(['bbox', 'xmin']),
            col(['bbox', 'ymin']),
            col(['bbox', 'xmax']),
            col(['bbox', 'ymax']),
            col(['band']),
            col(['id']),
            col(['names', 'primary']),
            col(['names', 'common']),
          ],
        },
      ],
    } as unknown as GeoParquetMetadata;
    expect(attributeColumns(meta)).toEqual(['band', 'id', 'names']);
  });

  it('drops a column literally named geometry even when the geo block is absent', () => {
    const meta = {
      geo: null,
      coveringPaths: null,
      overviewsInfo: null,
      rawRowGroups: [{ columns: [col(['geometry']), col(['id']), col(['name'])] }],
    } as unknown as GeoParquetMetadata;
    expect(attributeColumns(meta)).toEqual(['id', 'name']);
  });

  it('returns an empty list when there are no row groups', () => {
    const meta = { geo: null, coveringPaths: null, overviewsInfo: null, rawRowGroups: [] } as unknown as GeoParquetMetadata;
    expect(attributeColumns(meta)).toEqual([]);
  });
});

describe('coarseColumnIntervals', () => {
  // A metadata with two coarse bands (levels 0 and 1) and one exact band
  // (level 2). Row groups 0 and 1 are coarse, row group 2 is exact. Each coarse
  // row group has a geom_overview chunk at a known offset.
  const overviewChunk = (offset: number, size: number) => ({
    meta_data: {
      path_in_schema: ['geom_overview'],
      dictionary_page_offset: BigInt(offset),
      data_page_offset: BigInt(offset + 4),
      total_compressed_size: BigInt(size),
    },
  });
  const meta = {
    overviewsInfo: {
      version: '0.1.0',
      spatialKey: 'hilbert',
      overviewColumn: 'geom_overview',
      levels: [
        { level: 0, rowGroupEnd: 0, maxZoom: 8, gsd: 0.005 },
        { level: 1, rowGroupEnd: 1, maxZoom: 10, gsd: 0.001 },
        { level: 2, rowGroupEnd: 2, maxZoom: 24, gsd: 0 },
      ],
    },
    rawRowGroups: [
      { columns: [overviewChunk(1000, 500)] },
      { columns: [overviewChunk(2000, 800)] },
      { columns: [{ meta_data: { path_in_schema: ['geometry'], data_page_offset: BigInt(9000), total_compressed_size: BigInt(9999) } }] },
    ],
  } as unknown as GeoParquetMetadata;

  it('returns the coarse overview column chunk intervals only', () => {
    // Levels 0 and 1 are coarse, so row groups 0 and 1 are pinned. The exact
    // band row group 2 is not. Start is the dictionary page offset when present.
    expect(coarseColumnIntervals(meta)).toEqual([
      [1000, 1500],
      [2000, 2800],
    ]);
  });

  it('returns nothing when there is no overview column', () => {
    const flat = { ...meta, overviewsInfo: { ...meta.overviewsInfo!, overviewColumn: null } } as GeoParquetMetadata;
    expect(coarseColumnIntervals(flat)).toEqual([]);
  });
});

describe('readGeoParquetMetadata', () => {
  it('falls back to native geospatial statistics when there is no covering', () => {
    const meta = {
      num_rows: 10n,
      schema: [],
      key_value_metadata: [
        { key: 'geo', value: JSON.stringify({ version: '1.1.0', primary_column: 'geometry', columns: { geometry: { encoding: 'WKB' } } }) },
      ],
      row_groups: [
        {
          num_rows: 10n,
          total_byte_size: 1000n,
          columns: [
            {
              meta_data: {
                path_in_schema: ['geometry'],
                geospatial_statistics: { bbox: { xmin: 1, xmax: 2, ymin: 3, ymax: 4 } },
              },
            },
          ],
        },
      ],
    };
    const parsed = readGeoParquetMetadata(meta as never);
    expect(parsed.rowGroups[0].bbox).toEqual({ xmin: 1, ymin: 3, xmax: 2, ymax: 4 });
  });

  it('prefers the geom_overview column native stats over the exact geometry column at coarse zoom', () => {
    // Profile B, no covering column. The row group is coarse (band 0, per the
    // overviews footer below), so the viewer paints geom_overview, not
    // geometry. geom_overview's stats are deliberately the larger box, since
    // grid snapping can push overview vertices outward past the exact bbox,
    // and pruning by the tighter exact-geometry box could drop a row group
    // whose overview still paints (the bug this fallback preference fixes).
    const meta = {
      num_rows: 10n,
      schema: [],
      key_value_metadata: [
        { key: 'geo', value: JSON.stringify({ version: '1.1.0', primary_column: 'geometry', columns: { geometry: { encoding: 'WKB' } } }) },
        {
          key: 'overviews',
          value: JSON.stringify({
            version: '0.2.0',
            spatial_key: 'hilbert',
            overview_column: 'geom_overview',
            levels: [
              { level: 0, row_group_end: 0, max_zoom: 8, gsd: 0.005 },
              { level: 1, row_group_end: 1, max_zoom: 24, gsd: 0 },
            ],
          }),
        },
      ],
      row_groups: [
        {
          num_rows: 10n,
          total_byte_size: 1000n,
          columns: [
            {
              meta_data: {
                path_in_schema: ['geometry'],
                geospatial_statistics: { bbox: { xmin: 1, xmax: 2, ymin: 3, ymax: 4 } },
              },
            },
            {
              meta_data: {
                path_in_schema: ['geom_overview'],
                geospatial_statistics: { bbox: { xmin: 0.5, xmax: 2.5, ymin: 2.5, ymax: 4.5 } },
              },
            },
          ],
        },
        {
          num_rows: 10n,
          total_byte_size: 1000n,
          columns: [
            {
              meta_data: {
                path_in_schema: ['geometry'],
                geospatial_statistics: { bbox: { xmin: 10, xmax: 20, ymin: 30, ymax: 40 } },
              },
            },
            {
              // The finest band's geom_overview chunk is all null, so pyarrow
              // still sets geospatial_statistics but with null bounds. This
              // must be rejected in favor of the exact geometry stats.
              meta_data: {
                path_in_schema: ['geom_overview'],
                geospatial_statistics: { bbox: { xmin: null, xmax: null, ymin: null, ymax: null } as never },
              },
            },
          ],
        },
      ],
    };
    const parsed = readGeoParquetMetadata(meta as never);
    // Row group 0 (coarse, band 0): the overview column's larger bbox wins.
    expect(parsed.rowGroups[0].bbox).toEqual({ xmin: 0.5, ymin: 2.5, xmax: 2.5, ymax: 4.5 });
    // Row group 1 (exact, band 1): geom_overview stats are unusable (null
    // bounds), so it falls back to the exact geometry column's stats.
    expect(parsed.rowGroups[1].bbox).toEqual({ xmin: 10, ymin: 30, xmax: 20, ymax: 40 });
  });
});

// The gpq-tiles `geo:overviews` dialect: same band-major row-group layout,
// different key name and level field names (`zoom`, no `level` ordinal), plus
// a `mode` field. `partitioning` reads like this spec's cumulative prefix;
// `duplicating` levels are self-contained slices. Fixtures mirror the real
// footers written by `gpq-tiles overview` 0.6.0 (buildings-de-central).
describe('gpq-tiles geo:overviews dialect', () => {
  const PART_RAW = {
    version: '0.2.0',
    mode: 'partitioning',
    canonical_level: null,
    levels: [
      { row_group_end: 0, gsd: 305.7, zoom: 7 },
      { row_group_end: 4, gsd: 38.2, zoom: 10 },
      { row_group_end: 532, gsd: 2.4, zoom: 14 },
    ],
  };
  const DUP_RAW = {
    version: '0.2.0',
    mode: 'duplicating',
    canonical_level: 2,
    levels: [
      { row_group_end: 0, gsd: 305.7, zoom: 7 },
      { row_group_end: 4, gsd: 38.2, zoom: 10 },
      { row_group_end: 919, gsd: 2.4, zoom: 14 },
    ],
  };

  it('parses a partitioning footer as a cumulative (banded) pyramid', () => {
    const info = parseOverviews(PART_RAW as never)!;
    expect(info.mode).toBe('banded');
    expect(info.overviewColumn).toBeNull();
    expect(info.levels.map((l) => l.level)).toEqual([0, 1, 2]);
    expect(info.levels.map((l) => l.maxZoom)).toEqual([7, 10, 14]);
    expect(info.levels.every((l) => l.rowGroupStart === 0)).toBe(true);
  });

  it('parses a duplicating footer with self-contained level slices', () => {
    const info = parseOverviews(DUP_RAW as never)!;
    expect(info.mode).toBe('duplicating');
    expect(info.levels.map((l) => l.rowGroupStart)).toEqual([0, 1, 5]);
    expect(info.levels.map((l) => l.rowGroupEnd)).toEqual([0, 4, 919]);
  });

  it('reads only the level slice for a duplicating file, not the prefix', () => {
    const info = parseOverviews(DUP_RAW as never)!;
    const rowGroups: RowGroupInfo[] = Array.from({ length: 920 }, (_, index) => ({
      index,
      rowCount: 10_000,
      totalByteSize: 1_000_000,
      bbox: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
      band: null,
    }));
    const aoi = { xmin: 0, ymin: 0, xmax: 1, ymax: 1 };
    // level 1 (z10) owns row groups 1..4 only; the z7 slice must not leak in
    expect(rowGroupsForLevel(rowGroups, info.levels[1], aoi)).toEqual([1, 2, 3, 4]);
    // the finest level starts after the coarse slices
    const finest = rowGroupsForLevel(rowGroups, info.levels[2], aoi);
    expect(finest[0]).toBe(5);
    expect(finest.length).toBe(915);
  });

  it('reads the cumulative prefix for a partitioning file', () => {
    const info = parseOverviews(PART_RAW as never)!;
    const rowGroups: RowGroupInfo[] = Array.from({ length: 533 }, (_, index) => ({
      index,
      rowCount: 10_000,
      totalByteSize: 1_000_000,
      bbox: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
      band: null,
    }));
    const aoi = { xmin: 0, ymin: 0, xmax: 1, ymax: 1 };
    expect(rowGroupsForLevel(rowGroups, info.levels[1], aoi)).toEqual([0, 1, 2, 3, 4]);
  });

  it('renders the exact geometry column at every level (no overview column)', () => {
    const info = parseOverviews(PART_RAW as never)!;
    for (const level of info.levels) {
      expect(columnForLevel(info, level)).toBe('geometry');
    }
  });

  it('finds the pyramid under the geo:overviews key', () => {
    const meta = {
      num_rows: 100n,
      schema: [],
      key_value_metadata: [
        {
          key: 'geo',
          value: JSON.stringify({
            version: '1.1.0',
            primary_column: 'geometry',
            columns: { geometry: { encoding: 'WKB' } },
          }),
        },
        { key: 'geo:overviews', value: JSON.stringify(PART_RAW) },
      ],
      row_groups: [
        {
          num_rows: 100n,
          total_byte_size: 1000n,
          columns: [{ meta_data: { path_in_schema: ['geometry'] } }],
        },
      ],
    };
    const parsed = readGeoParquetMetadata(meta as never);
    expect(parsed.overviewsInfo).not.toBeNull();
    expect(parsed.overviewsInfo!.levels.length).toBe(3);
    expect(parsed.rowGroups[0].band).toBe(0);
  });
});
