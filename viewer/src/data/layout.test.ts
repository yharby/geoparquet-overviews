import { describe, it, expect } from 'vitest';
import { detectLayout } from './layout';
import type { GeoParquetMetadata, RowGroupInfo } from './metadata';

const rg = (index: number, xmin: number, xmax: number): RowGroupInfo => ({
  index, rowCount: 100, totalByteSize: 1000, bbox: { xmin, ymin: 0, xmax, ymax: 1 }, band: null,
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
        version: '0.1.0', spatialKey: 'hilbert', overviewColumn: 'geom_overview',
        overviewMethod: 'simplify_snap', importance: 'area_desc',
        levels: [
          { level: 0, rowGroupEnd: 1, maxZoom: 8, gsd: 0.005 },
          { level: 1, rowGroupEnd: 2, maxZoom: 24, gsd: 0 },
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

  it('reads every row group when a flat file has no covering (V5)', () => {
    // With no covering there is nothing to prune against, so every row group is
    // a candidate rather than none, and the strategy reports it is not prunable.
    const s = detectLayout(baseMeta({ coveringPaths: null }));
    expect(s.kind).toBe('flat-wkb');
    expect(s.prunable).toBe(false);
    const plan = s.planRead({ xmin: 0.5, ymin: 0, xmax: 1.5, ymax: 1 }, 10);
    expect(plan.indices).toEqual([0, 1, 2]);
  });
});
