export interface Bbox {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

export function bboxIntersects(a: Bbox, b: Bbox): boolean {
  return a.xmin <= b.xmax && a.xmax >= b.xmin && a.ymin <= b.ymax && a.ymax >= b.ymin;
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
