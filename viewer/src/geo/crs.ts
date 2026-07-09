import proj4 from 'proj4';
import type { Bbox } from './aoi';

// Reads the GeoParquet `crs` and, for projected data, reprojects coordinates to
// WGS84 lon/lat so the rest of the viewer (deck.gl and MapLibre, both web
// mercator) can render it. Geographic data passes through untouched.

export type CoordTransform = (x: number, y: number) => [number, number];

// proj4 definitions for projected CRSes the viewer can reproject to lon/lat.
// EPSG:4326 and 3857 already ship inside proj4, so `projected()` handles those
// without an entry here. Add any other projected code you need, keyed by EPSG
// code. The viewer shows a clear notice for any code it cannot resolve.
const PROJ_DEFS: Record<number, string> = {
  // ETRS89 / TM35FIN(E,N), the Finnish national grid, metres.
  3067: '+proj=utm +zone=35 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
};

export interface CrsInfo {
  // True for lon/lat degrees (CRS84 default or an EPSG geographic CRS), where
  // no reprojection is needed.
  geographic: boolean;
  epsg: number | null;
  // True when the viewer can place the data on the basemap, geographic data or
  // a projected code we have a proj4 definition for.
  supported: boolean;
  // Source coordinates to WGS84 lon/lat, or null when coordinates are already
  // lon/lat (identity).
  transform: CoordTransform | null;
  label: string;
}

// Frozen so a caller that reads this shared singleton can never mutate the
// value returned to every other geographic file.
const GEOGRAPHIC: CrsInfo = Object.freeze({
  geographic: true,
  epsg: null,
  supported: true,
  transform: null,
  label: 'CRS84 lon/lat',
});

function epsgFromCrs(crs: Record<string, unknown>): number | null {
  // PROJJSON carries the authority code in a single `id` object, but some
  // producers (and hyparquet's own CRS check) use an `ids` array. Honor both,
  // taking the first EPSG entry.
  const candidates = Array.isArray(crs.ids)
    ? (crs.ids as unknown[])
    : crs.id != null
      ? [crs.id]
      : [];
  for (const raw of candidates) {
    const id = raw as { authority?: string; code?: number | string } | undefined;
    if (id && String(id.authority).toUpperCase() === 'EPSG' && id.code != null) {
      const code = Number(id.code);
      if (Number.isFinite(code)) return code;
    }
  }
  return null;
}

// True only when 4326 appears as a standalone token, so a longer code that
// merely contains those digits (for example 104326) is not read as WGS84.
function mentions4326(text: string): boolean {
  return /(^|[^0-9])4326([^0-9]|$)/.test(text);
}

function projected(epsg: number, label: string): CrsInfo {
  const name = `EPSG:${epsg}`;
  const localDef = PROJ_DEFS[epsg];
  if (localDef) proj4.defs(name, localDef);
  // proj4 ships a few common codes built in (notably EPSG:3857 web mercator),
  // so a code with no local def may still be resolvable. If neither a local
  // def nor a proj4 built-in covers it, report it unsupported so the viewer
  // shows a notice instead of a broken render.
  if (!localDef && !proj4.defs(name)) {
    return { geographic: false, epsg, supported: false, transform: null, label };
  }
  const transform: CoordTransform = (x, y) => proj4(name, 'EPSG:4326', [x, y]) as [number, number];
  return { geographic: false, epsg, supported: true, transform, label };
}

// Interpret the `crs` on the primary geometry column. An absent or null crs is
// the CRS84 lon/lat default per the spec.
export function parseCrs(geo: Record<string, unknown> | null): CrsInfo {
  if (!geo) return GEOGRAPHIC;
  const primary = (geo.primary_column as string) ?? 'geometry';
  const columns = geo.columns as Record<string, { crs?: unknown }> | undefined;
  const col = columns?.[primary];
  if (!col || !('crs' in col) || col.crs == null) return GEOGRAPHIC;

  const crs = col.crs;
  if (typeof crs === 'string') {
    const u = crs.toUpperCase();
    if (u.includes('CRS84')) return GEOGRAPHIC;
    // Match an explicit EPSG code first and compare it, so a code like
    // EPSG:104326 is read as its own (projected) code, not mistaken for 4326.
    const m = u.match(/EPSG[:/]+(\d+)/);
    if (m) {
      const code = Number(m[1]);
      if (code === 4326) return GEOGRAPHIC;
      return projected(code, `EPSG:${code}`);
    }
    // Only with no explicit EPSG code do we treat a bare, standalone 4326 as
    // WGS84. A substring like 104326 does not match.
    if (mentions4326(u)) return GEOGRAPHIC;
    return { geographic: false, epsg: null, supported: false, transform: null, label: crs };
  }

  if (typeof crs === 'object') {
    const c = crs as Record<string, unknown>;
    const type = String(c.type ?? '');
    const name = String(c.name ?? 'projected CRS');
    if (type.includes('Geographic')) return GEOGRAPHIC;
    const epsg = epsgFromCrs(c);
    if (epsg === 4326) return GEOGRAPHIC;
    if (epsg != null) return projected(epsg, `EPSG:${epsg} ${name}`.trim());
    return { geographic: false, epsg: null, supported: false, transform: null, label: name };
  }

  return GEOGRAPHIC;
}

// A degenerate source coordinate (out of a projection's domain, or already
// non-finite in the source WKB) can make proj4 return NaN, Infinity, or a
// wildly out-of-range value. deck.gl's WebMercator projection asserts every
// vertex's latitude is within [-90, 90] and throws "invalid latitude"
// otherwise, tearing down the whole layer, so one corrupt feature would blank
// the entire map instead of just rendering wrong. Clamp to the valid lon/lat
// range and fall back to (0, 0) for a non-finite value, the same
// never-crash-the-overlay stance as the covering-box clamp in geo/aoi.ts.
function sanitizeLon(x: number): number {
  return Number.isFinite(x) ? Math.min(180, Math.max(-180, x)) : 0;
}

function sanitizeLat(y: number): number {
  return Number.isFinite(y) ? Math.min(90, Math.max(-90, y)) : 0;
}

// Reproject an interleaved-xy positions array to lon/lat in place, reading two
// scratch values and writing them back per vertex. This is the flat-buffer
// counterpart of applying `transform` per GeoJSON vertex: it runs proj4 once per
// (x, y) pair over a finished Float64Array, with no per-vertex array allocation.
// Geographic files pass a null transform and skip this pass entirely.
export function transformPositionsInPlace(positions: Float64Array, transform: CoordTransform): void {
  for (let i = 0; i < positions.length; i += 2) {
    const [x, y] = transform(positions[i], positions[i + 1]);
    positions[i] = sanitizeLon(x);
    positions[i + 1] = sanitizeLat(y);
  }
}

// Samples per edge when reprojecting a bbox. A curved projection (transverse
// Mercator, the EPSG:3067 datasets) bows a rectangle's edges out past its
// corners, so corner-only sampling under-covers the true lon/lat envelope. That
// is unsound for the whole-band skip, a band extent sampled at its corners can
// fall short of a member row group's own reprojected bbox and drop an in-view
// band. Sampling along the edges makes the result a conservative superset, which
// can only ever keep a group that might be in view, never drop one. The extremes
// of a smooth transform over a rectangle lie on its boundary, so the perimeter
// is enough, no interior grid needed.
const REPROJECT_EDGE_SAMPLES = 8;

// Reproject a source-CRS bounding box to lon/lat and take the min/max. Samples
// along every edge, not just the four corners, so the result is a conservative
// superset of the true envelope under a curved projection. Good for row-group
// pruning, the whole-band skip, and flying the map to the data. Returns the
// input unchanged when transform is null.
export function reprojectBbox(bbox: Bbox, transform: CoordTransform | null): Bbox {
  if (!transform) return bbox;
  const n = REPROJECT_EDGE_SAMPLES;
  let xmin = Infinity;
  let ymin = Infinity;
  let xmax = -Infinity;
  let ymax = -Infinity;
  const add = (sx: number, sy: number) => {
    const [x, y] = transform(sx, sy);
    if (x < xmin) xmin = x;
    if (x > xmax) xmax = x;
    if (y < ymin) ymin = y;
    if (y > ymax) ymax = y;
  };
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const sx = bbox.xmin + (bbox.xmax - bbox.xmin) * t;
    const sy = bbox.ymin + (bbox.ymax - bbox.ymin) * t;
    add(sx, bbox.ymin); // bottom edge
    add(sx, bbox.ymax); // top edge
    add(bbox.xmin, sy); // left edge
    add(bbox.xmax, sy); // right edge
  }
  return { xmin, ymin, xmax, ymax };
}
