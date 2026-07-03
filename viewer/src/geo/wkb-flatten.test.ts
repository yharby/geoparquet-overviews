import { describe, it, expect } from 'vitest';
import { flattenWkb } from './wkb-flatten';
import { flattenGeoJson } from './geojson';
import type { CoordTransform } from './crs';

// --- A tiny WKB writer, enough to build every fixture below ---------------------

type Dim = '' | 'Z' | 'M' | 'ZM';
interface EncOpts {
  le?: boolean; // little-endian (NDR) when true, big-endian (XDR) when false
  dim?: Dim;
  flavor?: 'iso' | 'ewkb';
  srid?: number;
}

interface Geom {
  type: string;
  coordinates?: any;
  geometries?: Geom[];
}

const TYPE_CODE: Record<string, number> = {
  Point: 1,
  LineString: 2,
  Polygon: 3,
  MultiPoint: 4,
  MultiLineString: 5,
  MultiPolygon: 6,
  GeometryCollection: 7,
};

function writer(le: boolean) {
  const bytes: number[] = [];
  const dv = new DataView(new ArrayBuffer(8));
  return {
    u8(v: number) {
      bytes.push(v & 0xff);
    },
    u32(v: number) {
      dv.setUint32(0, v >>> 0, le);
      for (let i = 0; i < 4; i++) bytes.push(dv.getUint8(i));
    },
    f64(v: number) {
      dv.setFloat64(0, v, le);
      for (let i = 0; i < 8; i++) bytes.push(dv.getUint8(i));
    },
    raw(b: Uint8Array) {
      for (const x of b) bytes.push(x);
    },
    done() {
      return new Uint8Array(bytes);
    },
  };
}

function encode(geom: Geom, opts: EncOpts = {}): Uint8Array {
  const le = opts.le ?? true;
  const dim = opts.dim ?? '';
  const flavor = opts.flavor ?? 'iso';
  const w = writer(le);
  w.u8(le ? 1 : 0);
  const base = TYPE_CODE[geom.type];
  if (flavor === 'ewkb') {
    let t = base >>> 0;
    if (dim.includes('Z')) t |= 0x80000000;
    if (dim.includes('M')) t |= 0x40000000;
    if (opts.srid != null) t |= 0x20000000;
    w.u32(t);
    if (opts.srid != null) w.u32(opts.srid);
  } else {
    const q = dim === 'Z' ? 1000 : dim === 'M' ? 2000 : dim === 'ZM' ? 3000 : 0;
    w.u32(base + q);
  }

  const coord = (c: number[]) => {
    w.f64(c[0]);
    w.f64(c[1]);
    if (dim === 'Z' || dim === 'M') w.f64(c[2] ?? 0);
    else if (dim === 'ZM') {
      w.f64(c[2] ?? 0);
      w.f64(c[3] ?? 0);
    }
  };
  const ring = (r: number[][]) => {
    w.u32(r.length);
    r.forEach(coord);
  };

  switch (geom.type) {
    case 'Point':
      coord(geom.coordinates);
      break;
    case 'LineString':
      w.u32(geom.coordinates.length);
      geom.coordinates.forEach(coord);
      break;
    case 'Polygon':
      w.u32(geom.coordinates.length);
      geom.coordinates.forEach(ring);
      break;
    case 'MultiPoint':
      w.u32(geom.coordinates.length);
      for (const p of geom.coordinates) w.raw(encode({ type: 'Point', coordinates: p }, opts));
      break;
    case 'MultiLineString':
      w.u32(geom.coordinates.length);
      for (const l of geom.coordinates) w.raw(encode({ type: 'LineString', coordinates: l }, opts));
      break;
    case 'MultiPolygon':
      w.u32(geom.coordinates.length);
      for (const poly of geom.coordinates) w.raw(encode({ type: 'Polygon', coordinates: poly }, opts));
      break;
    case 'GeometryCollection':
      w.u32(geom.geometries!.length);
      for (const g of geom.geometries!) w.raw(encode(g, opts));
      break;
    default:
      throw new Error(`test encoder: ${geom.type}`);
  }
  return w.done();
}

const point = (x: number, y: number): Geom => ({ type: 'Point', coordinates: [x, y] });
const SQUARE = [
  [0, 0],
  [0, 1],
  [1, 1],
  [1, 0],
];

// --- Type routing, both endiannesses -------------------------------------------

describe('flattenWkb type routing', () => {
  for (const le of [true, false]) {
    const tag = le ? 'little-endian' : 'big-endian';

    it(`routes a Point into the points bucket (${tag})`, () => {
      const flat = flattenWkb([encode(point(3, 4), { le })]);
      expect(Array.from(flat.points.positions)).toEqual([3, 4]);
      expect(flat.paths.startIndices.length).toBe(1);
      expect(flat.polygons.startIndices.length).toBe(1);
      expect(flat.holedPolygons.polygonStartIndices.length).toBe(1);
    });

    it(`routes a MultiPoint into one xy pair per member (${tag})`, () => {
      const flat = flattenWkb([
        encode({ type: 'MultiPoint', coordinates: [[1, 2], [3, 4], [5, 6]] }, { le }),
      ]);
      expect(Array.from(flat.points.positions)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it(`routes a LineString into the paths bucket (${tag})`, () => {
      const flat = flattenWkb([
        encode({ type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 0]] }, { le }),
      ]);
      expect(Array.from(flat.paths.positions)).toEqual([0, 0, 1, 1, 2, 0]);
      expect(Array.from(flat.paths.startIndices)).toEqual([0, 3]);
    });

    it(`routes each part of a MultiLineString into its own path (${tag})`, () => {
      const flat = flattenWkb([
        encode(
          {
            type: 'MultiLineString',
            coordinates: [
              [[0, 0], [1, 1]],
              [[5, 5], [6, 6], [7, 5]],
            ],
          },
          { le },
        ),
      ]);
      expect(Array.from(flat.paths.positions)).toEqual([0, 0, 1, 1, 5, 5, 6, 6, 7, 5]);
      expect(Array.from(flat.paths.startIndices)).toEqual([0, 2, 5]);
    });

    it(`routes a hole-free Polygon into the binary polygons bucket (${tag})`, () => {
      const flat = flattenWkb([encode({ type: 'Polygon', coordinates: [SQUARE] }, { le })]);
      expect(Array.from(flat.polygons.positions)).toEqual([0, 0, 0, 1, 1, 1, 1, 0]);
      expect(Array.from(flat.polygons.startIndices)).toEqual([0, 4]);
      expect(flat.holedPolygons.polygonStartIndices.length).toBe(1);
    });

    it(`routes each part of a hole-free MultiPolygon into a binary entry (${tag})`, () => {
      const flat = flattenWkb([
        encode(
          {
            type: 'MultiPolygon',
            coordinates: [[[[0, 0], [0, 1], [1, 1], [1, 0]]], [[[5, 5], [5, 6], [6, 6]]]],
          },
          { le },
        ),
      ]);
      expect(Array.from(flat.polygons.positions)).toEqual([0, 0, 0, 1, 1, 1, 1, 0, 5, 5, 5, 6, 6, 6]);
      expect(Array.from(flat.polygons.startIndices)).toEqual([0, 4, 7]);
    });
  }
});

// --- Holes ----------------------------------------------------------------------

describe('flattenWkb hole routing', () => {
  it('routes a Polygon with an interior ring to the flat holed buckets', () => {
    const outer = [[0, 0], [0, 4], [4, 4], [4, 0]];
    const hole = [[1, 1], [1, 2], [2, 2], [2, 1]];
    const flat = flattenWkb([encode({ type: 'Polygon', coordinates: [outer, hole] })]);
    expect(flat.polygons.positions.length).toBe(0);
    expect(Array.from(flat.holedPolygons.positions)).toEqual([
      0, 0, 0, 4, 4, 4, 4, 0, 1, 1, 1, 2, 2, 2, 2, 1,
    ]);
    expect(Array.from(flat.holedPolygons.polygonStartIndices)).toEqual([0, 8]);
    expect(Array.from(flat.holedPolygons.ringStartIndices)).toEqual([0, 4, 8]);
  });

  it('splits a MultiPolygon into binary and holed buckets per part', () => {
    const holeFree = [[[0, 0], [0, 1], [1, 1], [1, 0]]];
    const withHole = [
      [[10, 10], [10, 14], [14, 14], [14, 10]],
      [[11, 11], [11, 12], [12, 12], [12, 11]],
    ];
    const flat = flattenWkb([
      encode({ type: 'MultiPolygon', coordinates: [holeFree, withHole] }),
    ]);
    expect(Array.from(flat.polygons.positions)).toEqual([0, 0, 0, 1, 1, 1, 1, 0]);
    expect(Array.from(flat.holedPolygons.polygonStartIndices)).toEqual([0, 8]);
    expect(Array.from(flat.holedPolygons.ringStartIndices)).toEqual([0, 4, 8]);
  });
});

// --- Z / M / ZM / EWKB ----------------------------------------------------------

describe('flattenWkb dimensionality', () => {
  it('ignores ISO Z ordinates, keeping only x and y', () => {
    const flat = flattenWkb([
      encode({ type: 'Point', coordinates: [3, 4, 99] }, { dim: 'Z' }),
      encode({ type: 'LineString', coordinates: [[0, 0, 5], [1, 1, 6]] }, { dim: 'Z' }),
      encode({ type: 'Polygon', coordinates: [[[0, 0, 1], [0, 1, 2], [1, 1, 3]]] }, { dim: 'Z' }),
    ]);
    expect(Array.from(flat.points.positions)).toEqual([3, 4]);
    expect(Array.from(flat.paths.positions)).toEqual([0, 0, 1, 1]);
    expect(Array.from(flat.polygons.positions)).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it('ignores ISO ZM ordinates', () => {
    const flat = flattenWkb([
      encode({ type: 'LineString', coordinates: [[0, 0, 5, 7], [1, 1, 6, 8]] }, { dim: 'ZM' }),
    ]);
    expect(Array.from(flat.paths.positions)).toEqual([0, 0, 1, 1]);
  });

  it('reads EWKB with the Z flag and skips the SRID int', () => {
    const flat = flattenWkb([
      encode({ type: 'Point', coordinates: [12, 34, 56] }, { flavor: 'ewkb', dim: 'Z', srid: 4326 }),
    ]);
    expect(Array.from(flat.points.positions)).toEqual([12, 34]);
  });

  it('reads an EWKB polygon with SRID and no Z', () => {
    const flat = flattenWkb([
      encode({ type: 'Polygon', coordinates: [SQUARE] }, { flavor: 'ewkb', srid: 3067 }),
    ]);
    expect(Array.from(flat.polygons.positions)).toEqual([0, 0, 0, 1, 1, 1, 1, 0]);
  });
});

// --- Collections, mixed endianness, and empties --------------------------------

describe('flattenWkb collections and edge cases', () => {
  it('recurses into a GeometryCollection mixing types', () => {
    const flat = flattenWkb([
      encode({
        type: 'GeometryCollection',
        geometries: [
          point(1, 1),
          { type: 'LineString', coordinates: [[0, 0], [2, 2]] },
          { type: 'Polygon', coordinates: [SQUARE] },
        ],
      }),
    ]);
    expect(Array.from(flat.points.positions)).toEqual([1, 1]);
    expect(Array.from(flat.paths.positions)).toEqual([0, 0, 2, 2]);
    expect(Array.from(flat.polygons.startIndices)).toEqual([0, 4]);
  });

  it('reads a per-geometry byte order in a multi (little-endian outer, big-endian children)', () => {
    // Hand-build a MultiPoint whose header is little-endian but whose child
    // Points are big-endian, exercising the per-geometry endianness flag.
    const w = writer(true);
    w.u8(1); // LE
    w.u32(4); // MultiPoint
    w.u32(2); // two children
    w.raw(encode(point(1, 2), { le: false }));
    w.raw(encode(point(3, 4), { le: false }));
    const flat = flattenWkb([w.done()]);
    expect(Array.from(flat.points.positions)).toEqual([1, 2, 3, 4]);
  });

  it('drops an empty LineString and an empty Polygon ring without a start index', () => {
    const flat = flattenWkb([
      encode({ type: 'LineString', coordinates: [] }),
      encode({ type: 'Polygon', coordinates: [[]] }),
    ]);
    expect(flat.paths.startIndices.length).toBe(1);
    expect(flat.polygons.startIndices.length).toBe(1);
  });

  it('skips an empty Point encoded as NaN coordinates', () => {
    const flat = flattenWkb([encode(point(NaN, NaN)), point2Wkb(7, 8)]);
    expect(Array.from(flat.points.positions)).toEqual([7, 8]);
  });

  it('skips null and undefined entries', () => {
    const flat = flattenWkb([null, undefined, encode(point(1, 2))]);
    expect(Array.from(flat.points.positions)).toEqual([1, 2]);
  });

  it('throws on an unknown geometry type', () => {
    const bad = encode(point(0, 0));
    // Corrupt the 4-byte type field (little-endian) to an unsupported code.
    bad[1] = 99;
    expect(() => flattenWkb([bad])).toThrow(/unsupported geometry type/);
  });

  it('throws on a truncated buffer', () => {
    const truncated = encode(point(1, 2)).subarray(0, 6);
    expect(() => flattenWkb([truncated])).toThrow();
  });
});

function point2Wkb(x: number, y: number): Uint8Array {
  return encode(point(x, y));
}

// --- Equivalence with flattenGeoJson -------------------------------------------

describe('flattenWkb equivalence with flattenGeoJson', () => {
  const fixtures: Geom[] = [
    {
      type: 'GeometryCollection',
      geometries: [
        point(0, 0),
        { type: 'LineString', coordinates: [[1, 1], [2, 2], [3, 1]] },
        { type: 'Polygon', coordinates: [SQUARE] },
        {
          type: 'Polygon',
          coordinates: [
            [[0, 0], [0, 4], [4, 4], [4, 0]],
            [[1, 1], [1, 2], [2, 2], [2, 1]],
          ],
        },
      ],
    },
    {
      type: 'MultiPolygon',
      coordinates: [
        [[[0, 0], [0, 1], [1, 1], [1, 0]]],
        [
          [[10, 10], [10, 14], [14, 14], [14, 10]],
          [[11, 11], [11, 12], [12, 12], [12, 11]],
        ],
      ],
    },
  ];

  it('produces identical buckets to flattenGeoJson', () => {
    for (const geom of fixtures) {
      const fromWkb = flattenWkb([encode(geom)]);
      const fromJson = flattenGeoJson([geom]);
      expect(fromWkb).toEqual(fromJson);
    }
  });

  it('produces identical buckets under a reprojection transform', () => {
    const shift: CoordTransform = (x, y) => [x + 100, y + 200];
    for (const geom of fixtures) {
      const fromWkb = flattenWkb([encode(geom)], shift);
      const fromJson = flattenGeoJson([geom], shift);
      expect(fromWkb).toEqual(fromJson);
    }
  });
});
