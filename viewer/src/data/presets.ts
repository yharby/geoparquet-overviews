export interface FilePreset {
  id: string;
  label: string;
  url: string;
}

// All presets are hosted on source.coop and read over HTTP range requests, so
// they behave the same under the dev server and on a static host. Load your own
// file with the URL box. `sample` is a small synthetic demo of the overviews
// layout and is the default on load. `big_sample` is a synthetic dataset with
// large row groups that shows page-level pruning. `nls_rakennus` is a real
// projected dataset (EPSG:3067, Finnish buildings) that exercises in-browser
// reprojection. The three `overture_*` presets are a real greater-Tokyo subset
// of Overture data converted with our overviews layout, one per geometry
// dimension, so the overview payoff is visible on points, lines, and polygons.
const SOURCE_COOP = 'https://data.source.coop/youssef-harby/geoparquet-overviews';

export const FILE_PRESETS: FilePreset[] = [
  { id: 'sample', label: 'sample (overviews demo)', url: `${SOURCE_COOP}/sample.parquet` },
  { id: 'big_sample', label: 'large sample (page pruning)', url: `${SOURCE_COOP}/big_sample.parquet` },
  { id: 'nls_rakennus', label: 'Finland buildings (EPSG:3067)', url: `${SOURCE_COOP}/nls_rakennus_overviews.parquet` },
  { id: 'overture_buildings', label: 'Overture buildings (Tokyo, 6.5M polygons)', url: `${SOURCE_COOP}/overture-tokyo/buildings.parquet` },
  { id: 'overture_segments', label: 'Overture roads (Tokyo, 1.4M lines)', url: `${SOURCE_COOP}/overture-tokyo/segments.parquet` },
  { id: 'overture_pois', label: 'Overture POIs (Tokyo, 266K points)', url: `${SOURCE_COOP}/overture-tokyo/pois.parquet` },
];

// The preset loaded automatically when the viewer opens.
export const DEFAULT_PRESET = FILE_PRESETS[0];
