import type { Bbox } from '../geo/aoi';

// Decimal places used to round an AOI's edges for the dedupe key. More precision
// at high zoom, so a small pan still refetches, and fewer at low zoom, where a
// tiny bbox change is not worth a new read. A fixed 0.001 degrees (about 111 m)
// swallowed small pans at high zoom, this scales the threshold with the zoom.
export function roundKeyDecimals(zoom: number): number {
  return Math.max(2, Math.min(7, Math.round(zoom / 2)));
}

// The dedupe key for a view fetch. It combines the level-of-detail identity with
// the zoom-rounded AOI edges, so a fetch is skipped only when both the LOD and
// the (rounded) viewport are unchanged since the last fetch.
export function viewFetchKey(lodKey: string, bbox: Bbox, zoom: number): string {
  const d = roundKeyDecimals(zoom);
  return `${lodKey}|${bbox.xmin.toFixed(d)},${bbox.ymin.toFixed(d)},${bbox.xmax.toFixed(d)},${bbox.ymax.toFixed(d)}`;
}
