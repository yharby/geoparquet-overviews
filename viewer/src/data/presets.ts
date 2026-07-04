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

// The viewer opens on the `url` query parameter when it is present and looks
// like an http or https address, so a link can point straight at any hosted
// GeoParquet file. Anything else falls back to the default preset. The search
// string is a parameter so this stays pure and testable. loadUrl mirrors the
// loaded file back into this parameter, so a refresh reopens the same file.
export function initialUrl(
  search = typeof window === 'undefined' ? '' : window.location.search,
): string {
  const param = new URLSearchParams(search).get('url');
  if (param) {
    const trimmed = param.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
  }
  return DEFAULT_PRESET.url;
}

// A map camera restored from the query string, x longitude, y latitude, z zoom.
export interface CameraView {
  lng: number;
  lat: number;
  zoom: number;
}

// The viewer also opens on x, y, and z query parameters, x longitude, y
// latitude, z zoom, so a link can point straight at a precise camera and not
// just a file. All three must be present and in range or the whole camera is
// ignored, so a partial or malformed set falls back to the default fit. The
// search string is a parameter so this stays pure and testable. loadUrl mirrors
// the live camera back into these on every settle.
export function initialView(
  search = typeof window === 'undefined' ? '' : window.location.search,
): CameraView | null {
  const params = new URLSearchParams(search);
  const x = params.get('x');
  const y = params.get('y');
  const z = params.get('z');
  // A missing or blank value is a no-camera, not a zero. Number('') is 0, which
  // would silently place the camera at the equator or prime meridian, so reject
  // any empty or whitespace-only parameter before coercing.
  if (x === null || y === null || z === null) return null;
  if (x.trim() === '' || y.trim() === '' || z.trim() === '') return null;
  const lng = Number(x);
  const lat = Number(y);
  const zoom = Number(z);
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || !Number.isFinite(zoom)) return null;
  if (lng < -180 || lng > 180 || lat < -85.06 || lat > 85.06) return null;
  if (zoom < 0 || zoom > 28) return null;
  return { lng, lat, zoom };
}
