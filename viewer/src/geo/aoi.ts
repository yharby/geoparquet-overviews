export interface Bbox {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

export function bboxIntersects(a: Bbox, b: Bbox): boolean {
  return a.xmin <= b.xmax && a.xmax >= b.xmin && a.ymin <= b.ymax && a.ymax >= b.ymin;
}

// Smallest span kept after clamping, about 0.1 m of latitude, far below what a
// camera fit can resolve, so it only ever repairs the degenerate case below.
const CLAMP_EPSILON = 1e-6;

// Clamp one axis to [lo, hi]. When the clamped range collapses (a bbox
// entirely past a pole or the antimeridian maps both edges onto the same
// value), expand it by a tiny epsilon around the clamped edge, kept inside
// [lo, hi], so camera fits always receive a valid nonzero span.
function clampSpan(min: number, max: number, lo: number, hi: number): [number, number] {
  const cmin = Math.max(lo, Math.min(hi, min));
  const cmax = Math.max(lo, Math.min(hi, max));
  if (cmin < cmax) return [cmin, cmax];
  const mid = (cmin + cmax) / 2;
  return [Math.max(lo, mid - CLAMP_EPSILON), Math.min(hi, mid + CLAMP_EPSILON)];
}

// Clamp a lon/lat bbox to the valid geographic ranges before handing it to a
// MapLibre camera call. MapLibre's LngLat rejects any latitude outside
// [-90, 90], and a coarse overview band grid-snapped near the poles can push a
// whole-file extent a fraction of a cell past them (a global timezones file
// snapped its ymax to 90.0439), which made a fit-to-extent throw. A bbox
// entirely past a pole (e.g. ymin 91, ymax 95) would clamp to a zero-height
// line, so each axis is guarded by clampSpan above. Only the camera fit is
// clamped, the raw bbox still drives data pruning.
export function clampGeographicBbox(b: Bbox): Bbox {
  const [xmin, xmax] = clampSpan(b.xmin, b.xmax, -180, 180);
  const [ymin, ymax] = clampSpan(b.ymin, b.ymax, -90, 90);
  return { xmin, ymin, xmax, ymax };
}

// The closed five-point outline of a bbox, used to draw a rectangle on the
// mini-map (both the row-group covering boxes and the live viewport outline).
export function bboxRing(b: Bbox): [number, number][] {
  return [
    [b.xmin, b.ymin],
    [b.xmax, b.ymin],
    [b.xmax, b.ymax],
    [b.xmin, b.ymax],
    [b.xmin, b.ymin],
  ];
}

// A ring clamped to the projectable range before it becomes a deck.gl path or
// polygon. MapLibre's map.getBounds() reports north above 90 and south below
// -90 when the main map is zoomed out, and a coarse overview band's
// grid-snapped covering bbox can push a row group's own extent a fraction of
// a cell past a pole too (see clampGeographicBbox). Either raw bbox feeds a
// deck.gl layer whose WebMercator projection asserts lat in [-90, 90], and an
// unclamped ring threw "invalid latitude" and tore down the overlay. Used for
// both the live viewport outline and the row-group covering boxes.
export function viewportRing(b: Bbox): [number, number][] {
  return bboxRing(clampGeographicBbox(b));
}

// Split an AOI that crosses the antimeridian into in-range [-180, 180] parts, so
// intersection against normalized row-group and page bboxes near the seam is
// correct. A wrapped view (MapLibre can return an east edge past 180, so xmax
// exceeds 180 or the wrapped west edge is greater than the wrapped east edge)
// becomes two bboxes, one east of the seam and one west of it. A normal in-range
// view stays a single bbox.
export function splitAoiAtSeam(bbox: Bbox): Bbox[] {
  const { ymin, ymax } = bbox;
  const { xmin, xmax } = bbox;
  // A span a full turn or wider covers every longitude.
  if (xmax - xmin >= 360) return [{ xmin: -180, ymin, xmax: 180, ymax }];
  const wrap = (x: number) => ((((x + 180) % 360) + 360) % 360) - 180;
  const w = wrap(xmin);
  const e = wrap(xmax);
  if (w <= e) return [{ xmin: w, ymin, xmax: e, ymax }];
  // The wrapped west edge sits east of the wrapped east edge, so the view spans
  // the seam. Read it as two ranges that meet at 180.
  return [
    { xmin: w, ymin, xmax: 180, ymax },
    { xmin: -180, ymin, xmax: e, ymax },
  ];
}

// True when b meets any part of a possibly seam-crossing AOI.
export function bboxIntersectsAoi(b: Bbox, aoi: Bbox): boolean {
  return splitAoiAtSeam(aoi).some((part) => bboxIntersects(b, part));
}
