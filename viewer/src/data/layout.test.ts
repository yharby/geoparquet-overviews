import { describe, it, expect } from 'vitest';
import { detectLayout, PREVIEW_MAX_ZOOM } from './layout';
import type { GeoParquetMetadata, RowGroupInfo } from './metadata';

const rg = (index: number, xmin: number, xmax: number): RowGroupInfo => ({
  index, rowCount: 100, totalByteSize: 1000, bbox: { xmin, ymin: 0, xmax, ymax: 1 }, band: null,
});

const rgNoBbox = (index: number): RowGroupInfo => ({
  index, rowCount: 100, totalByteSize: 1000, bbox: null, band: null,
});

function baseMeta(over: Partial<GeoParquetMetadata>): GeoParquetMetadata {
  return {
    rowGroups: [rg(0, 0, 1), rg(1, 1, 2), rg(2, 2, 3)],
    totalRows: 300, coveringPaths: null, geo: null, overviews: null,
    overviewsInfo: null,
    geometryTypes: null,
    projection: { geographic: true, epsg: null, supported: true, transform: null, label: 'CRS84 lon/lat' },
    rawRowGroups: [], schema: [],
    ...over,
  };
}

const AOI = { xmin: 0, ymin: 0, xmax: 3, ymax: 1 };

describe('detectLayout', () => {
  it('picks the overviews strategy when overview levels are present', () => {
    const meta = baseMeta({
      overviewsInfo: {
        version: '0.1.0', mode: 'banded', spatialKey: 'hilbert', overviewColumn: 'geom_overview',
        overviewMethod: 'simplify_snap', importance: 'area_desc', countColumn: null,
        levels: [
          { level: 0, rowGroupEnd: 1, rowGroupStart: 0, maxZoom: 8, gsd: 0.005, minZoom: 0, featureCount: null, bytes: null, extent: null, extentBbox: null },
          { level: 1, rowGroupEnd: 2, rowGroupStart: 0, maxZoom: 24, gsd: 0, minZoom: 9, featureCount: null, bytes: null, extent: null, extentBbox: null },
        ],
      },
    });
    const s = detectLayout(meta);
    expect(s.kind).toBe('overviews');
    expect(s.hasZoomLevels).toBe(true);
    const coarse = s.planRead(AOI, 4);
    expect(coarse.column).toBe('geom_overview'); // low zoom reads the overview
    expect(s.planRead(AOI, 20).column).toBe('geometry'); // high zoom reads exact
  });

  // Three bands: 0 (rg0), 1 (rg1), 2/finest (rg2), with row groups carrying
  // their stamped band ordinal as readGeoParquetMetadata fills via bandForIndex.
  // Shared by the two prefix-column tests below, which differ only in version.
  const threeBandMeta = (version: string): GeoParquetMetadata =>
    baseMeta({
      rowGroups: [
        { ...rg(0, 0, 1), band: 0 },
        { ...rg(1, 1, 2), band: 1 },
        { ...rg(2, 2, 3), band: 2 },
      ],
      overviewsInfo: {
        version, mode: 'banded', spatialKey: 'hilbert', overviewColumn: 'geom_overview',
        overviewMethod: 'simplify_snap', importance: 'area_desc', countColumn: null,
        levels: [
          { level: 0, rowGroupEnd: 0, rowGroupStart: 0, maxZoom: 4, gsd: 0.1, minZoom: 0, featureCount: null, bytes: null, extent: null, extentBbox: null },
          { level: 1, rowGroupEnd: 1, rowGroupStart: 0, maxZoom: 8, gsd: 0.01, minZoom: 5, featureCount: null, bytes: null, extent: null, extentBbox: null },
          { level: 2, rowGroupEnd: 2, rowGroupStart: 0, maxZoom: 24, gsd: 0, minZoom: 9, featureCount: null, bytes: null, extent: null, extentBbox: null },
        ],
      },
    });

  it('reads exact geometry for a coarser band caught in a finer band prefix (0.3.0)', () => {
    // At a zoom served by the middle band, the cumulative prefix reads rg0 and
    // rg1. The target band rg1 reads its overview, but the coarser band rg0
    // must read exact geometry, not its own too-coarse per-band-grid overview,
    // else its coarse blob paints over the view.
    const s = detectLayout(threeBandMeta('0.3.0'));
    const plan = s.planRead(AOI, 8); // served by the middle band
    expect(plan.column).toBe('geom_overview'); // target band's column
    expect(plan.indices).toEqual([0, 1]); // prefix, both coarser and target
    expect(plan.columnForIndex(0)).toBe('geometry'); // coarser band, exact
    expect(plan.columnForIndex(1)).toBe('geom_overview'); // target band, overview
    // At the finest zoom the whole prefix is exact.
    const exact = s.planRead(AOI, 20);
    expect(exact.columnForIndex(0)).toBe('geometry');
    expect(exact.columnForIndex(2)).toBe('geometry');
  });

  it('keeps the overview column for the whole coarse prefix on a pre-0.3.0 file', () => {
    // 0.1.0/0.2.0 snapped every band to one fine global grid, so a coarser
    // band's overview is correct at this zoom and its band 0 holds the heaviest
    // exact WKB. The exact fallback would multiply the mid-zoom read cost, so
    // the version gate keeps the plain per-level column.
    const s = detectLayout(threeBandMeta('0.2.0'));
    const plan = s.planRead(AOI, 8);
    expect(plan.columnForIndex(0)).toBe('geom_overview'); // no exact fallback
    expect(plan.columnForIndex(1)).toBe('geom_overview');
    // The finest level still reads exact geometry for everything.
    const exact = s.planRead(AOI, 20);
    expect(exact.columnForIndex(0)).toBe('geometry');
  });

  it('reads exact geometry past a depth-capped ladder whose deepest overview level maxZoom is z9', () => {
    // The light-overviews depth cap can end the ladder well short of z24, so the
    // exact (last) level's own maxZoom may be far below a requested zoom too.
    // levelForZoom's fallback must still resolve to that last level on nothing
    // more than "no earlier level's maxZoom covers this zoom", never a
    // hard-coded assumption that overviews (or the exact band) reach z24.
    const meta = baseMeta({
      rowGroups: [
        { ...rg(0, 0, 1), band: 0 },
        { ...rg(1, 1, 2), band: 1 },
      ],
      overviewsInfo: {
        version: '0.3.0', mode: 'banded', spatialKey: 'hilbert', overviewColumn: 'geom_overview',
        overviewMethod: 'simplify_snap', importance: 'area_desc', countColumn: null,
        levels: [
          { level: 0, rowGroupEnd: 0, rowGroupStart: 0, maxZoom: 9, gsd: 0.05, minZoom: 0, featureCount: null, bytes: null, extent: null, extentBbox: null },
          { level: 1, rowGroupEnd: 1, rowGroupStart: 0, maxZoom: 10, gsd: 0, minZoom: 10, featureCount: null, bytes: null, extent: null, extentBbox: null },
        ],
      },
    });
    const s = detectLayout(meta);
    const plan = s.planRead(AOI, 12); // past both levels' own maxZoom
    expect(plan.column).toBe('geometry'); // resolves to the last (exact) level
    expect(plan.band).toBe(1);
    expect(plan.columnForIndex(0)).toBe('geometry'); // coarser band in the prefix, exact too
    expect(plan.columnForIndex(1)).toBe('geometry');
  });

  it('falls back to flat-wkb and prunes by bbox when a covering is present', () => {
    // A covering is what makes bbox pruning possible, so a flat file that has
    // one is prunable and only the intersecting groups are read.
    const cover = { xmin: ['bbox', 'xmin'], ymin: ['bbox', 'ymin'], xmax: ['bbox', 'xmax'], ymax: ['bbox', 'ymax'] };
    const s = detectLayout(baseMeta({ coveringPaths: cover }));
    expect(s.kind).toBe('flat-wkb');
    expect(s.hasZoomLevels).toBe(false);
    expect(s.prunable).toBe(true);
    const plan = s.planRead({ xmin: 0.5, ymin: 0, xmax: 1.5, ymax: 1 }, 10);
    expect(plan.column).toBe('geometry');
    expect(plan.indices).toEqual([0, 1]); // bbox prune only
  });

  it('reads the file primary geometry column, not a hardcoded "geometry" (web-optimized gpio files)', () => {
    // gpio's --optimize-for web keeps the source geometry column name, which is
    // often `geom` (DuckDB/GDAL default), not `geometry`. The flat path must read
    // whatever geo.primary_column names, else hyparquet finds no column and the
    // map stays empty.
    const cover = { xmin: ['bbox', 'xmin'], ymin: ['bbox', 'ymin'], xmax: ['bbox', 'xmax'], ymax: ['bbox', 'ymax'] };
    const s = detectLayout(
      baseMeta({
        coveringPaths: cover,
        geo: { primary_column: 'geom', columns: { geom: {} } },
      }),
    );
    expect(s.kind).toBe('flat-wkb');
    const plan = s.planRead(AOI, 10);
    expect(plan.column).toBe('geom');
    expect(plan.columnForIndex(0)).toBe('geom');
  });

  it('defaults the flat geometry column to "geometry" when geo is absent', () => {
    const s = detectLayout(baseMeta({ coveringPaths: null }));
    const plan = s.planRead(AOI, 10);
    expect(plan.column).toBe('geometry');
    expect(plan.columnForIndex(0)).toBe('geometry');
  });

  it('prunes by the native-stats bbox even without a covering column (Profile B, V5)', () => {
    // Profile B files have no covering, but readGeoParquetMetadata falls back to
    // the geometry chunk's native GeospatialStatistics, so rowGroups still carry
    // a bbox and pruning works identically, and the strategy reports prunable.
    const s = detectLayout(baseMeta({ coveringPaths: null }));
    expect(s.kind).toBe('flat-wkb');
    expect(s.prunable).toBe(true);
    const plan = s.planRead({ xmin: 0.5, ymin: 0, xmax: 1.5, ymax: 1 }, 10);
    expect(plan.indices).toEqual([0, 1]); // bbox prune still applies
  });

  it('previews the pruned row-group bboxes at low zoom instead of fetching geometry', () => {
    // A flat file has no cheap coarse geometry, so below PREVIEW_MAX_ZOOM the
    // plan carries the pruned groups' footer bboxes as rectangles and reads no
    // geometry. rg(0..2) span x 0..3, so an AOI over 0.5..1.5 keeps groups 0,1.
    const s = detectLayout(baseMeta({}));
    const plan = s.planRead({ xmin: 0.5, ymin: 0, xmax: 1.5, ymax: 1 }, PREVIEW_MAX_ZOOM - 1);
    expect(plan.previewBoxes).toBeDefined();
    expect(plan.previewBoxes).toHaveLength(2); // one box per pruned row group
    expect(plan.previewBoxes![0]).toEqual({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 });
    expect(plan.lodKey).toBe('flat:preview');
  });

  it('reads geometry, not the bbox preview, once past PREVIEW_MAX_ZOOM', () => {
    const s = detectLayout(baseMeta({}));
    const plan = s.planRead(AOI, PREVIEW_MAX_ZOOM);
    expect(plan.previewBoxes).toBeUndefined();
    expect(plan.lodKey).toBe('flat:geom');
    expect(plan.column).toBe('geometry');
  });

  it('skips the preview at low zoom when no row group has a bbox to draw', () => {
    // No boxes means nothing to preview, so fall through to a geometry read even
    // below the preview zoom rather than paint an empty preview.
    const s = detectLayout(baseMeta({ coveringPaths: null, rowGroups: [rgNoBbox(0), rgNoBbox(1)] }));
    const plan = s.planRead(AOI, PREVIEW_MAX_ZOOM - 1);
    expect(plan.previewBoxes).toBeUndefined();
    expect(plan.lodKey).toBe('flat:geom');
  });

  it('reads every row group when no row group has any bbox at all', () => {
    // Neither a covering column nor native geospatial statistics resolved a
    // bbox, so there is nothing to prune against and every row group is a
    // candidate, and the strategy reports it is not prunable.
    const s = detectLayout(baseMeta({ coveringPaths: null, rowGroups: [rgNoBbox(0), rgNoBbox(1), rgNoBbox(2)] }));
    expect(s.kind).toBe('flat-wkb');
    expect(s.prunable).toBe(false);
    const plan = s.planRead({ xmin: 0.5, ymin: 0, xmax: 1.5, ymax: 1 }, 10);
    expect(plan.indices).toEqual([0, 1, 2]);
  });
});
