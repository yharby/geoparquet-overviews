import { describe, it, expect } from 'vitest';
import {
  levelForZoom,
  columnForLevel,
  rowGroupsForLevel,
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
  spatialKey: 'hilbert',
  overviewColumn: 'geom_overview',
  overviewMethod: 'simplify_snap',
  importance: 'area_desc',
  levels: [
    { level: 0, rowGroupEnd: 19, maxZoom: 8, gsd: 0.005, bytes: null, extent: null },
    { level: 1, rowGroupEnd: 53, maxZoom: 10, gsd: 0.00125, bytes: null, extent: null },
    { level: 2, rowGroupEnd: 80, maxZoom: 24, gsd: 0.0, bytes: null, extent: null },
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
});
