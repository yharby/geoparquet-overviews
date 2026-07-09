import { describe, it, expect } from 'vitest';
import { detectLayout } from './layout';
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
