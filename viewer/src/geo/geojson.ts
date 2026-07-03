import { type CoordTransform, transformPositionsInPlace } from './crs';

// hyparquet hands the WKB geometry column to us either as raw bytes (the
// zero-copy path, see wkb-flatten.ts) or, in the belt-and-braces fallback, as
// GeoJSON geometry objects. flattenGeoJson handles the latter: it flattens the
// objects, in one pass, to the interleaved-xy typed-array layouts deck.gl's
// binary layers want, split into four buckets: points, paths (lines), hole-free
// polygons, and polygons with holes. The WKB scanner produces the identical
// bucket shape by a different route, so the flat-cache, the layer merge, and the
// map layers are shared by both paths. GeometryCollections are recursed into. A
// projected file reprojects the finished flat buffers to lon/lat in one pass
// after flattening. Any Z or M ordinates are ignored.

type Position = number[];
type Ring = Position[];

// Hole-free geometry is packed into interleaved xy typed arrays. Points hold one
// xy pair per feature. Paths and polygons hold a positions array plus a
// startIndices array marking where each path/ring begins (last entry is the total
// vertex count), the exact shape deck.gl's binary attribute path expects.
export interface FlatPoints {
  positions: Float64Array;
}

export interface FlatPaths {
  positions: Float64Array;
  startIndices: Uint32Array;
}

export interface FlatPolygons {
  positions: Float64Array;
  startIndices: Uint32Array;
}

// Polygons with holes, on the flat binary path. All rings of all holed polygons
// are packed into one interleaved-xy positions array. polygonStartIndices marks
// where each polygon begins (its exterior ring plus all its holes, contiguous);
// ringStartIndices marks where each individual ring begins. Both are vertex
// counts with a leading 0 and a trailing total, so [i, i+1) reads one span. The
// polygon boundaries are a subset of the ring boundaries (every polygon ends on a
// ring end). The fill layer groups rings into polygons via polygonStartIndices
// and cuts holes; the outline traces every ring via ringStartIndices.
export interface FlatHoledPolygons {
  positions: Float64Array;
  polygonStartIndices: Uint32Array;
  ringStartIndices: Uint32Array;
}

export interface FlatGeometries {
  points: FlatPoints;
  paths: FlatPaths;
  polygons: FlatPolygons;
  holedPolygons: FlatHoledPolygons;
}

interface GeometryLike {
  type: string;
  coordinates?: unknown;
  geometries?: unknown[];
}

// Growable Float64 buffer that doubles its backing store, so a large batch of
// features never grows a plain number[] element by element or reallocates on
// every push. finish() returns a right-sized copy.
export class Float64Builder {
  private buf: Float64Array;
  private len = 0;

  constructor(initial = 1024) {
    this.buf = new Float64Array(initial);
  }

  push2(a: number, b: number): void {
    if (this.len + 2 > this.buf.length) this.grow(this.len + 2);
    this.buf[this.len++] = a;
    this.buf[this.len++] = b;
  }

  private grow(min: number): void {
    let cap = this.buf.length * 2;
    while (cap < min) cap *= 2;
    const next = new Float64Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  finish(): Float64Array {
    return this.buf.slice(0, this.len);
  }
}

// Growable Uint32 buffer for the startIndices arrays, seeded with a leading 0 so
// consumers can read [i, i+1) spans directly.
export class Uint32Builder {
  private buf: Uint32Array;
  private len = 0;

  constructor(initial = 256) {
    this.buf = new Uint32Array(initial);
    this.buf[this.len++] = 0;
  }

  push(value: number): void {
    if (this.len + 1 > this.buf.length) this.grow(this.len + 1);
    this.buf[this.len++] = value;
  }

  private grow(min: number): void {
    let cap = this.buf.length * 2;
    while (cap < min) cap *= 2;
    const next = new Uint32Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  finish(): Uint32Array {
    return this.buf.slice(0, this.len);
  }
}

// The mutable set of builders both the GeoJSON and the WKB flatteners fill. The
// scanner in wkb-flatten.ts pushes doubles straight into these; flattenGeoJson
// below routes GeoJSON objects into the same sinks, so both produce the identical
// FlatGeometries. Coordinates are pushed raw (source CRS); reprojection is a
// single post-pass over the finished arrays in finalizeBuckets.
export class FlatBuilders {
  readonly pointPos = new Float64Builder();
  readonly pathPos = new Float64Builder();
  readonly pathStarts = new Uint32Builder();
  pathVertices = 0;
  readonly polyPos = new Float64Builder();
  readonly polyStarts = new Uint32Builder();
  polyVertices = 0;
  readonly holedPos = new Float64Builder();
  readonly holedPolyStarts = new Uint32Builder();
  readonly holedRingStarts = new Uint32Builder();
  holedVertices = 0;
}

// Finish every builder into typed arrays, then reproject all four positions
// arrays in place when the file is projected. The flat-cache stores the result,
// so caching reprojected buckets keeps cache hits zero-work.
export function finalizeBuckets(b: FlatBuilders, transform?: CoordTransform | null): FlatGeometries {
  const flat: FlatGeometries = {
    points: { positions: b.pointPos.finish() },
    paths: { positions: b.pathPos.finish(), startIndices: b.pathStarts.finish() },
    polygons: { positions: b.polyPos.finish(), startIndices: b.polyStarts.finish() },
    holedPolygons: {
      positions: b.holedPos.finish(),
      polygonStartIndices: b.holedPolyStarts.finish(),
      ringStartIndices: b.holedRingStarts.finish(),
    },
  };
  if (transform) {
    transformPositionsInPlace(flat.points.positions, transform);
    transformPositionsInPlace(flat.paths.positions, transform);
    transformPositionsInPlace(flat.polygons.positions, transform);
    transformPositionsInPlace(flat.holedPolygons.positions, transform);
  }
  return flat;
}

export function flattenGeoJson(
  geometries: unknown[],
  transform?: CoordTransform | null,
): FlatGeometries {
  const b = new FlatBuilders();

  const addPoint = (p: Position): void => {
    b.pointPos.push2(p[0], p[1]);
  };

  const addPath = (line: Position[]): void => {
    if (line.length === 0) return;
    for (const p of line) b.pathPos.push2(p[0], p[1]);
    b.pathVertices += line.length;
    b.pathStarts.push(b.pathVertices);
  };

  // Push a single exterior ring into the hole-free polygon buckets.
  const addPolygonRing = (ring: Ring): void => {
    if (ring.length === 0) return;
    for (const p of ring) b.polyPos.push2(p[0], p[1]);
    b.polyVertices += ring.length;
    b.polyStarts.push(b.polyVertices);
  };

  // Push a holed polygon (exterior plus interior rings) into the flat holed
  // buckets: every non-empty ring contributes a ringStartIndices boundary, then
  // one polygonStartIndices boundary closes the polygon.
  const addHoledPolygon = (rings: Ring[]): void => {
    let ringsAdded = 0;
    for (const ring of rings) {
      if (ring.length === 0) continue;
      for (const p of ring) b.holedPos.push2(p[0], p[1]);
      b.holedVertices += ring.length;
      b.holedRingStarts.push(b.holedVertices);
      ringsAdded += 1;
    }
    if (ringsAdded > 0) b.holedPolyStarts.push(b.holedVertices);
  };

  // Route one polygon (an array of rings) to the binary path if hole-free, or to
  // the holed buckets if it has interior rings.
  const addPolygon = (rings: Ring[]): void => {
    if (rings.length === 0) return;
    if (rings.length === 1) addPolygonRing(rings[0]);
    else addHoledPolygon(rings);
  };

  const visit = (raw: unknown): void => {
    const geom = raw as GeometryLike | null;
    if (!geom || typeof geom.type !== 'string') return;
    switch (geom.type) {
      case 'Point':
        addPoint(geom.coordinates as Position);
        break;
      case 'MultiPoint':
        for (const p of geom.coordinates as Position[]) addPoint(p);
        break;
      case 'LineString':
        addPath(geom.coordinates as Position[]);
        break;
      case 'MultiLineString':
        for (const line of geom.coordinates as Position[][]) addPath(line);
        break;
      case 'Polygon':
        addPolygon(geom.coordinates as Ring[]);
        break;
      case 'MultiPolygon':
        for (const polygon of geom.coordinates as Ring[][]) addPolygon(polygon);
        break;
      case 'GeometryCollection':
        for (const member of geom.geometries ?? []) visit(member);
        break;
      default:
        break;
    }
  };

  for (const raw of geometries) visit(raw);

  return finalizeBuckets(b, transform);
}

// Concatenate several interleaved-xy position arrays into one right-sized array.
function concatPositions(arrays: Float64Array[]): Float64Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Float64Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

// Concatenate the startIndices of several buckets that share one merged
// positions array. Each bucket's startIndices begins with 0 and counts vertices
// (positions hold two values per vertex). The merged array keeps a single leading
// 0, then for each bucket appends its entries past that leading 0 shifted by the
// running vertex count, so ring/path boundaries stay aligned with the merged
// positions.
function concatStartIndices(buckets: { positions: Float64Array; startIndices: Uint32Array }[]): Uint32Array {
  let total = 1;
  for (const b of buckets) total += Math.max(0, b.startIndices.length - 1);
  const out = new Uint32Array(total);
  let write = 1;
  let vertexBase = 0;
  for (const b of buckets) {
    for (let i = 1; i < b.startIndices.length; i++) {
      out[write++] = b.startIndices[i] + vertexBase;
    }
    vertexBase += b.positions.length / 2;
  }
  return out;
}

// Merge several per-row-group FlatGeometries into one combined set of buckets, so
// a settled view can be painted with one layer per kind instead of one per batch.
// The typed arrays are concatenated and every startIndices array rebased against
// its bucket's shared positions. An empty list yields empty buckets.
export function mergeFlatGeometries(list: FlatGeometries[]): FlatGeometries {
  const holed = list.map((f) => f.holedPolygons);
  return {
    points: { positions: concatPositions(list.map((f) => f.points.positions)) },
    paths: {
      positions: concatPositions(list.map((f) => f.paths.positions)),
      startIndices: concatStartIndices(list.map((f) => f.paths)),
    },
    polygons: {
      positions: concatPositions(list.map((f) => f.polygons.positions)),
      startIndices: concatStartIndices(list.map((f) => f.polygons)),
    },
    holedPolygons: {
      positions: concatPositions(holed.map((h) => h.positions)),
      polygonStartIndices: concatStartIndices(
        holed.map((h) => ({ positions: h.positions, startIndices: h.polygonStartIndices })),
      ),
      ringStartIndices: concatStartIndices(
        holed.map((h) => ({ positions: h.positions, startIndices: h.ringStartIndices })),
      ),
    },
  };
}

// Total vertex count across all buckets, for the load summary panels.
export function vertexCount(flat: FlatGeometries): number {
  return (
    flat.points.positions.length / 2 +
    flat.paths.positions.length / 2 +
    flat.polygons.positions.length / 2 +
    flat.holedPolygons.positions.length / 2
  );
}
