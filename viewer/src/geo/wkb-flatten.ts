import type { CoordTransform } from './crs';
import { FlatBuilders, finalizeBuckets, flattenGeoJson, type FlatGeometries } from './geojson';

// A DataView-based WKB scanner. It consumes the array of raw WKB values hyparquet
// yields when its geometry parser is overridden to identity (see rowgroups.ts),
// and produces the same FlatGeometries buckets flattenGeoJson produces, but
// without ever building the GeoJSON object graph or the millions of tiny [x, y]
// arrays it costs. Doubles are pushed straight from the decompressed page bytes
// into the shared Float64/Uint32 builders, so a coordinate materializes about
// twice (page bytes, flat buffer, then deck.gl's fp64 split) instead of four to
// five times.
//
// Supported geometry types, both endiannesses (a byte-order flag per geometry,
// including each nested geometry of a multi or collection):
//   1 Point, 2 LineString, 3 Polygon, 4 MultiPoint, 5 MultiLineString,
//   6 MultiPolygon, 7 GeometryCollection (recursive).
// Z/M/ZM are handled in both conventions: ISO (type + 1000/2000/3000) and EWKB
// flag bits (0x80000000 Z, 0x40000000 M, 0x20000000 SRID). Only x and y are
// kept; any Z or M ordinates are skipped. A present SRID int is skipped.

const EWKB_Z = 0x80000000;
const EWKB_M = 0x40000000;
const EWKB_SRID = 0x20000000;

// A cursor over one WKB value. Endianness is set from the byte-order flag at the
// start of each (possibly nested) geometry. Reads advance the offset; a read past
// the end throws a RangeError from DataView, which the caller's failure path
// handles, so a truncated buffer never emits partial garbage.
class WkbCursor {
  offset = 0;
  private le = false;
  constructor(private readonly view: DataView) {}

  byteOrder(): void {
    this.le = this.view.getUint8(this.offset) === 1;
    this.offset += 1;
  }

  u32(): number {
    const v = this.view.getUint32(this.offset, this.le);
    this.offset += 4;
    return v;
  }

  f64(): number {
    const v = this.view.getFloat64(this.offset, this.le);
    this.offset += 8;
    return v;
  }

  skip(bytes: number): void {
    this.offset += bytes;
  }
}

// Read one geometry header, returning the base type (1..7) and how many extra
// doubles trail each x/y (0, 1 for Z or M, 2 for ZM). Skips an SRID int if the
// EWKB flag says one is present.
function readHeader(c: WkbCursor): { geomType: number; extra: number } {
  c.byteOrder();
  const rawType = c.u32();
  let geomType: number;
  let hasZ: boolean;
  let hasM: boolean;
  if (rawType & (EWKB_Z | EWKB_M | EWKB_SRID)) {
    // EWKB: dimensionality and SRID presence live in the high flag bits, the base
    // type in the low byte.
    hasZ = (rawType & EWKB_Z) !== 0;
    hasM = (rawType & EWKB_M) !== 0;
    if (rawType & EWKB_SRID) c.skip(4);
    geomType = rawType & 0xff;
  } else {
    // ISO: dimensionality is encoded in the thousands digit.
    geomType = rawType % 1000;
    const dim = Math.floor(rawType / 1000);
    hasZ = dim === 1 || dim === 3;
    hasM = dim === 2 || dim === 3;
  }
  const extra = (hasZ ? 1 : 0) + (hasM ? 1 : 0);
  return { geomType, extra };
}

// Read one x/y pair and skip any trailing Z/M ordinates.
function readXY(c: WkbCursor, extra: number): [number, number] {
  const x = c.f64();
  const y = c.f64();
  if (extra) c.skip(extra * 8);
  return [x, y];
}

// Read the point count of a ring/line and push each vertex into a Float64Builder,
// returning the vertex count added.
function readCoords(c: WkbCursor, extra: number, push: (x: number, y: number) => void): number {
  const n = c.u32();
  for (let i = 0; i < n; i++) {
    const [x, y] = readXY(c, extra);
    push(x, y);
  }
  return n;
}

// Read one polygon (already past its header) into the flat buckets: hole-free
// polygons take the binary fast path, holed polygons the flat holed buckets, the
// same routing flattenGeoJson uses.
function readPolygon(c: WkbCursor, extra: number, b: FlatBuilders): void {
  const numRings = c.u32();
  if (numRings === 0) return;
  if (numRings === 1) {
    const n = readCoords(c, extra, (x, y) => b.polyPos.push2(x, y));
    if (n === 0) return;
    b.polyVertices += n;
    b.polyStarts.push(b.polyVertices);
    b.polyRows.push(b.currentRow);
    return;
  }
  let ringsAdded = 0;
  for (let r = 0; r < numRings; r++) {
    const n = readCoords(c, extra, (x, y) => b.holedPos.push2(x, y));
    if (n === 0) continue;
    b.holedVertices += n;
    b.holedRingStarts.push(b.holedVertices);
    ringsAdded += 1;
  }
  if (ringsAdded > 0) {
    b.holedPolyStarts.push(b.holedVertices);
    b.holedRows.push(b.currentRow);
  }
}

// Read one geometry (header plus body) and route it into the builders. Multis and
// collections recurse, reading each child's own byte-order flag and header.
function readGeometry(c: WkbCursor, b: FlatBuilders): void {
  const { geomType, extra } = readHeader(c);
  switch (geomType) {
    case 1: {
      // Point. A NaN coordinate is the WKB idiom for an empty point; skip it so
      // it does not paint a dot at (NaN, NaN).
      const [x, y] = readXY(c, extra);
      if (!Number.isNaN(x) && !Number.isNaN(y)) {
        b.pointPos.push2(x, y);
        b.pointRows.push(b.currentRow);
      }
      break;
    }
    case 2: {
      // LineString.
      const n = readCoords(c, extra, (x, y) => b.pathPos.push2(x, y));
      if (n > 0) {
        b.pathVertices += n;
        b.pathStarts.push(b.pathVertices);
        b.pathRows.push(b.currentRow);
      }
      break;
    }
    case 3:
      readPolygon(c, extra, b);
      break;
    case 4: {
      // MultiPoint: count of child Point geometries.
      const n = c.u32();
      for (let i = 0; i < n; i++) readGeometry(c, b);
      break;
    }
    case 5: {
      // MultiLineString: count of child LineString geometries.
      const n = c.u32();
      for (let i = 0; i < n; i++) readGeometry(c, b);
      break;
    }
    case 6: {
      // MultiPolygon: count of child Polygon geometries.
      const n = c.u32();
      for (let i = 0; i < n; i++) readGeometry(c, b);
      break;
    }
    case 7: {
      // GeometryCollection: count of child geometries of any type.
      const n = c.u32();
      for (let i = 0; i < n; i++) readGeometry(c, b);
      break;
    }
    default:
      throw new Error(`WKB: unsupported geometry type ${geomType}`);
  }
}

// Flatten an array of raw WKB values into the shared bucket shape. null/undefined
// entries are skipped (the finest band carries a null geom_overview; an exact
// read should see no nulls but this stays safe). A malformed value throws.
//
// `rows` is the parallel absolute-parquet-row of each value (aligned index for
// index, both already null-compacted by the reader), stamped onto every primitive
// so a picked geometry resolves to its source row. When omitted, each value's
// position stands in, which is enough for the equivalence tests but not for the
// click popup, so the read path always supplies it.
export function flattenWkb(
  values: unknown[],
  transform?: CoordTransform | null,
  rows?: ArrayLike<number>,
): FlatGeometries {
  const b = new FlatBuilders();
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value == null) continue;
    b.currentRow = rows ? rows[i] : i;
    const bytes = value as Uint8Array;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    readGeometry(new WkbCursor(view), b);
  }
  return finalizeBuckets(b, transform);
}

// Decode a batch of geometry values into flat buckets, choosing the scanner by
// what the reader handed over. With hyparquet's parser overridden to identity the
// values arrive as raw WKB Uint8Arrays, so the zero-copy scanner runs; the GeoJSON
// flattener stays as a fallback for any already-decoded object (belt and braces
// during the transition). The probe skips leading nulls, which the finest band's
// null geom_overview yields. Shared by the read path (layout.ts), the decode
// worker, and the worker's main-thread fallback so all three decode identically.
export function decodeFlat(
  values: unknown[],
  transform?: CoordTransform | null,
  rows?: ArrayLike<number>,
): FlatGeometries {
  for (const v of values) {
    if (v == null) continue;
    if (v instanceof Uint8Array) return flattenWkb(values, transform, rows);
    return flattenGeoJson(values, transform, rows);
  }
  return flattenWkb(values, transform, rows);
}
