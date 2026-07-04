// Network benchmark, Task 13. Plans reads for a ladder of viewports per
// dataset per data version (v0.1.0, v0.2.0) and sums the compressed bytes of
// the planned geometry chunks, i.e. what the viewer would fetch at row-group
// granularity. Deliberately outside `pnpm test`, see vitest.bench.config.ts.
// Not run by this task, see viewer/bench/RESULTS.md for the recorded output.
import { describe, expect, it } from 'vitest';
import { asyncBufferFromUrl, parquetMetadataAsync } from 'hyparquet';
import { readGeoParquetMetadata, fileExtent, columnChunkBytes } from '../src/data/metadata';
import { detectLayout } from '../src/data/layout';
import type { Bbox } from '../src/geo/aoi';

const BASE = 'https://data.source.coop/youssef-harby/geoparquet-overviews';
const DATASETS = [
  'sample.parquet',
  'big_sample.parquet',
  'nls_rakennus_overviews.parquet',
  'overture-tokyo/buildings.parquet',
  'overture-tokyo/segments.parquet',
  'overture-tokyo/pois.parquet',
];
// Viewport ladder as fractions of the dataset extent, with a zoom that a map
// showing that fraction of the world-side extent would sit at.
const VIEWPORTS = [
  { name: 'full extent', frac: 1, zoom: 5 },
  { name: 'region', frac: 1 / 8, zoom: 9 },
  { name: 'city', frac: 1 / 64, zoom: 12 },
  { name: 'district', frac: 1 / 512, zoom: 15 },
];

function centered(bbox: Bbox, frac: number): Bbox {
  const cx = (bbox.xmin + bbox.xmax) / 2;
  const cy = (bbox.ymin + bbox.ymax) / 2;
  const hw = ((bbox.xmax - bbox.xmin) * frac) / 2;
  const hh = ((bbox.ymax - bbox.ymin) * frac) / 2;
  return { xmin: cx - hw, ymin: cy - hh, xmax: cx + hw, ymax: cy + hh };
}

async function sweep(url: string): Promise<Record<string, unknown>[]> {
  const file = await asyncBufferFromUrl({ url });
  const raw = await parquetMetadataAsync(file);
  const meta = readGeoParquetMetadata(raw);
  const strategy = detectLayout(meta);
  const extent = fileExtent(meta.rowGroups);
  if (!extent) return [];
  const rows: Record<string, unknown>[] = [];
  for (const vp of VIEWPORTS) {
    const plan = strategy.planRead(centered(extent, vp.frac), vp.zoom);
    let bytes = 0;
    for (const idx of plan.indices) {
      bytes += columnChunkBytes(meta, idx, plan.column) ?? 0;
    }
    rows.push({
      viewport: vp.name,
      column: plan.column,
      rowGroups: plan.indices.length,
      mb: (bytes / 1e6).toFixed(2),
    });
  }
  return rows;
}

describe('v0.1.0 vs v0.2.0 planned read bytes', () => {
  for (const ds of DATASETS) {
    it(ds, async () => {
      const results: Record<string, unknown> = {};
      for (const version of ['v0.1.0', 'v0.2.0']) {
        results[version] = await sweep(`${BASE}/${version}/${ds}`);
      }
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ dataset: ds, results }, null, 2));
      expect(results).toBeTruthy();
    });
  }
});

// Profile A (physical bbox covering column) vs Profile B (no bbox column, row
// groups pruned from native GeospatialStatistics alone). Both are v0.2.0 nls.
// This is the release's headline, that row-group pruning survives with no
// physical covering column, so the two sweeps should track each other closely.
describe('v0.2.0 nls Profile A vs Profile B planned read bytes', () => {
  it('nls_rakennus Profile A vs Profile B', async () => {
    const results: Record<string, unknown> = {};
    results['profile A (bbox)'] = await sweep(`${BASE}/v0.2.0/nls_rakennus_overviews.parquet`);
    results['profile B (no bbox)'] = await sweep(`${BASE}/v0.2.0/nls_rakennus_overviews.nobbox.parquet`);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ dataset: 'nls Profile A vs B', results }, null, 2));
    expect(results).toBeTruthy();
  });
});
