import { describe, it, expect } from 'vitest';
import { flattenGeoJson, mergeFlatGeometries, vertexCount } from './geojson';
import type { CoordTransform } from './crs';

const point = (x: number, y: number) => ({ type: 'Point', coordinates: [x, y] });
const multiPoint = (coords: number[][]) => ({ type: 'MultiPoint', coordinates: coords });
const lineString = (coords: number[][]) => ({ type: 'LineString', coordinates: coords });
const multiLineString = (lines: number[][][]) => ({ type: 'MultiLineString', coordinates: lines });
const polygon = (rings: number[][][]) => ({ type: 'Polygon', coordinates: rings });
const multiPolygon = (parts: number[][][][]) => ({ type: 'MultiPolygon', coordinates: parts });

const SQUARE = [
  [0, 0],
  [0, 1],
  [1, 1],
  [1, 0],
];

describe('flattenGeoJson bucket routing', () => {
  it('routes a Point into the points bucket only', () => {
    const flat = flattenGeoJson([point(3, 4)]);
    expect(Array.from(flat.points.positions)).toEqual([3, 4]);
    expect(flat.paths.startIndices.length).toBe(1);
    expect(flat.polygons.startIndices.length).toBe(1);
    expect(flat.holedPolygons.polygonStartIndices.length).toBe(1);
  });

  it('routes a MultiPoint into one xy pair per member', () => {
    const flat = flattenGeoJson([multiPoint([[1, 2], [3, 4], [5, 6]])]);
    expect(Array.from(flat.points.positions)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('routes a LineString into the paths bucket', () => {
    const flat = flattenGeoJson([lineString([[0, 0], [1, 1], [2, 0]])]);
    expect(Array.from(flat.paths.positions)).toEqual([0, 0, 1, 1, 2, 0]);
    expect(Array.from(flat.paths.startIndices)).toEqual([0, 3]);
    expect(flat.points.positions.length).toBe(0);
  });

  it('routes each part of a MultiLineString into its own path', () => {
    const flat = flattenGeoJson([
      multiLineString([
        [[0, 0], [1, 1]],
        [[5, 5], [6, 6], [7, 5]],
      ]),
    ]);
    expect(Array.from(flat.paths.positions)).toEqual([0, 0, 1, 1, 5, 5, 6, 6, 7, 5]);
    expect(Array.from(flat.paths.startIndices)).toEqual([0, 2, 5]);
  });

  it('routes a hole-free Polygon into the binary polygons bucket', () => {
    const flat = flattenGeoJson([polygon([SQUARE])]);
    expect(Array.from(flat.polygons.positions)).toEqual([0, 0, 0, 1, 1, 1, 1, 0]);
    expect(Array.from(flat.polygons.startIndices)).toEqual([0, 4]);
    expect(flat.holedPolygons.polygonStartIndices.length).toBe(1);
  });

  it('routes each part of a hole-free MultiPolygon into a binary polygon entry', () => {
    const partA = [[[0, 0], [0, 1], [1, 1], [1, 0]]];
    const partB = [[[5, 5], [5, 6], [6, 6]]];
    const flat = flattenGeoJson([multiPolygon([partA, partB])]);
    expect(Array.from(flat.polygons.positions)).toEqual([0, 0, 0, 1, 1, 1, 1, 0, 5, 5, 5, 6, 6, 6]);
    expect(Array.from(flat.polygons.startIndices)).toEqual([0, 4, 7]);
    expect(flat.holedPolygons.polygonStartIndices.length).toBe(1);
  });
});

describe('flattenGeoJson hole detection routing', () => {
  it('routes a Polygon with an interior ring to the holed bucket with full rings', () => {
    const outer = [[0, 0], [0, 4], [4, 4], [4, 0]];
    const hole = [[1, 1], [1, 2], [2, 2], [2, 1]];
    const flat = flattenGeoJson([polygon([outer, hole])]);
    // Nothing lands in the binary polygon bucket.
    expect(flat.polygons.startIndices.length).toBe(1);
    expect(flat.polygons.positions.length).toBe(0);
    // Both rings pack into the flat holed buckets: one polygon boundary, two ring
    // boundaries, exterior then hole.
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
    const flat = flattenGeoJson([multiPolygon([holeFree, withHole])]);
    // The hole-free part stays on the binary fast path.
    expect(Array.from(flat.polygons.positions)).toEqual([0, 0, 0, 1, 1, 1, 1, 0]);
    // The holed part routes to the flat holed buckets with both rings.
    expect(Array.from(flat.holedPolygons.positions)).toEqual([
      10, 10, 10, 14, 14, 14, 14, 10, 11, 11, 11, 12, 12, 12, 12, 11,
    ]);
    expect(Array.from(flat.holedPolygons.polygonStartIndices)).toEqual([0, 8]);
    expect(Array.from(flat.holedPolygons.ringStartIndices)).toEqual([0, 4, 8]);
  });
});

describe('flattenGeoJson collections and mixed batches', () => {
  it('recurses into a GeometryCollection and routes each member', () => {
    const flat = flattenGeoJson([
      {
        type: 'GeometryCollection',
        geometries: [point(1, 1), lineString([[0, 0], [2, 2]]), polygon([SQUARE])],
      },
    ]);
    expect(Array.from(flat.points.positions)).toEqual([1, 1]);
    expect(Array.from(flat.paths.positions)).toEqual([0, 0, 2, 2]);
    expect(Array.from(flat.polygons.startIndices)).toEqual([0, 4]);
  });

  it('recurses into a nested GeometryCollection', () => {
    const flat = flattenGeoJson([
      {
        type: 'GeometryCollection',
        geometries: [
          { type: 'GeometryCollection', geometries: [point(9, 9)] },
          lineString([[1, 1], [2, 2]]),
        ],
      },
    ]);
    expect(Array.from(flat.points.positions)).toEqual([9, 9]);
    expect(Array.from(flat.paths.positions)).toEqual([1, 1, 2, 2]);
  });

  it('handles a mixed batch of different geometry types in one pass', () => {
    const flat = flattenGeoJson([
      point(0, 0),
      lineString([[1, 1], [2, 2]]),
      polygon([SQUARE]),
      point(5, 5),
      polygon([
        [[0, 0], [0, 4], [4, 4], [4, 0]],
        [[1, 1], [1, 2], [2, 2], [2, 1]],
      ]),
    ]);
    expect(Array.from(flat.points.positions)).toEqual([0, 0, 5, 5]);
    expect(Array.from(flat.paths.positions)).toEqual([1, 1, 2, 2]);
    expect(Array.from(flat.polygons.startIndices)).toEqual([0, 4]);
    // One holed polygon: a single polygon boundary past the leading 0.
    expect(flat.holedPolygons.polygonStartIndices.length - 1).toBe(1);
  });

  it('concatenates many polygon feature rows into one flat bucket', () => {
    const a = polygon([[[0, 0], [0, 1], [1, 1]]]);
    const b = polygon([[[9, 9], [9, 10], [10, 10]]]);
    const flat = flattenGeoJson([a, b]);
    expect(Array.from(flat.polygons.positions)).toEqual([0, 0, 0, 1, 1, 1, 9, 9, 9, 10, 10, 10]);
    expect(Array.from(flat.polygons.startIndices)).toEqual([0, 3, 6]);
  });
});

describe('flattenGeoJson edge cases', () => {
  it('skips null and untyped entries safely', () => {
    const flat = flattenGeoJson([null, undefined, { foo: 'bar' }, point(1, 2)]);
    expect(Array.from(flat.points.positions)).toEqual([1, 2]);
  });

  it('ignores Z ordinates, keeping only x and y', () => {
    const flat = flattenGeoJson([
      { type: 'Point', coordinates: [3, 4, 99] },
      { type: 'LineString', coordinates: [[0, 0, 5], [1, 1, 6]] },
      { type: 'Polygon', coordinates: [[[0, 0, 1], [0, 1, 2], [1, 1, 3]]] },
    ]);
    expect(Array.from(flat.points.positions)).toEqual([3, 4]);
    expect(Array.from(flat.paths.positions)).toEqual([0, 0, 1, 1]);
    expect(Array.from(flat.polygons.positions)).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it('drops empty rings and empty lines without emitting a start index', () => {
    const flat = flattenGeoJson([polygon([[]]), lineString([])]);
    expect(flat.polygons.startIndices.length).toBe(1);
    expect(flat.paths.startIndices.length).toBe(1);
  });
});

describe('flattenGeoJson transform', () => {
  // A transform that offsets every coordinate, standing in for reprojection.
  // Kept within the valid lon/lat envelope, transformPositionsInPlace clamps
  // out-of-range results (see crs.test.ts), which this test is not about.
  const shift: CoordTransform = (x, y) => [x + 10, y + 20];

  it('applies the transform to every bucket', () => {
    const flat = flattenGeoJson(
      [
        point(1, 1),
        lineString([[2, 2], [3, 3]]),
        polygon([[[0, 0], [0, 1], [1, 1]]]),
        polygon([
          [[0, 0], [0, 4], [4, 4], [4, 0]],
          [[1, 1], [1, 2], [2, 2], [2, 1]],
        ]),
      ],
      shift,
    );
    expect(Array.from(flat.points.positions)).toEqual([11, 21]);
    expect(Array.from(flat.paths.positions)).toEqual([12, 22, 13, 23]);
    expect(Array.from(flat.polygons.positions)).toEqual([10, 20, 10, 21, 11, 21]);
    // The holed polygon's rings are reprojected in place too: exterior first
    // vertex, then the hole's first vertex (the hole starts at vertex 4, element 8).
    expect(flat.holedPolygons.positions[0]).toBe(10);
    expect(flat.holedPolygons.positions[1]).toBe(20);
    expect(flat.holedPolygons.positions[8]).toBe(11);
    expect(flat.holedPolygons.positions[9]).toBe(21);
  });
});

describe('mergeFlatGeometries', () => {
  it('returns empty buckets for an empty list', () => {
    const merged = mergeFlatGeometries([]);
    expect(merged.points.positions.length).toBe(0);
    expect(Array.from(merged.paths.startIndices)).toEqual([0]);
    expect(Array.from(merged.polygons.startIndices)).toEqual([0]);
    expect(merged.holedPolygons.positions.length).toBe(0);
    expect(Array.from(merged.holedPolygons.polygonStartIndices)).toEqual([0]);
    expect(Array.from(merged.holedPolygons.ringStartIndices)).toEqual([0]);
  });

  it('concatenates positions and rebases startIndices across two polygon buckets', () => {
    const a = flattenGeoJson([polygon([[[0, 0], [0, 1], [1, 1]]])]);
    const b = flattenGeoJson([polygon([[[9, 9], [9, 10], [10, 10], [10, 9]]])]);
    const merged = mergeFlatGeometries([a, b]);
    // Positions are simply concatenated in order.
    expect(Array.from(merged.polygons.positions)).toEqual([
      0, 0, 0, 1, 1, 1, 9, 9, 9, 10, 10, 10, 10, 9,
    ]);
    // The second bucket's ring boundary (4 vertices) is shifted past the first
    // bucket's 3 vertices, keeping a single leading 0.
    expect(Array.from(merged.polygons.startIndices)).toEqual([0, 3, 7]);
  });

  it('rebases paths across three buckets including an empty one', () => {
    const a = flattenGeoJson([lineString([[0, 0], [1, 1]])]);
    const empty = flattenGeoJson([point(5, 5)]); // no paths
    const c = flattenGeoJson([lineString([[2, 2], [3, 3], [4, 4]])]);
    const merged = mergeFlatGeometries([a, empty, c]);
    expect(Array.from(merged.paths.positions)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
    // Empty middle bucket contributes no boundary and no vertex offset.
    expect(Array.from(merged.paths.startIndices)).toEqual([0, 2, 5]);
    // The point from the middle bucket still lands in the merged points bucket.
    expect(Array.from(merged.points.positions)).toEqual([5, 5]);
  });

  it('concatenates and rebases holed polygons across buckets', () => {
    const a = flattenGeoJson([
      polygon([
        [[0, 0], [0, 4], [4, 4], [4, 0]],
        [[1, 1], [1, 2], [2, 2], [2, 1]],
      ]),
    ]);
    const b = flattenGeoJson([
      polygon([
        [[10, 10], [10, 14], [14, 14]],
        [[11, 11], [11, 12], [12, 12]],
      ]),
    ]);
    const merged = mergeFlatGeometries([a, b]);
    // Positions concatenate: 8 vertices from a then 6 from b = 28 values.
    expect(merged.holedPolygons.positions.length).toBe(28);
    // b's polygon boundary (6 vertices) is shifted past a's 8, single leading 0.
    expect(Array.from(merged.holedPolygons.polygonStartIndices)).toEqual([0, 8, 14]);
    // b's ring boundaries (3 and 6) are shifted past a's 8 vertices.
    expect(Array.from(merged.holedPolygons.ringStartIndices)).toEqual([0, 4, 8, 11, 14]);
  });

  it('preserves the total vertex count across the merge', () => {
    const a = flattenGeoJson([lineString([[0, 0], [1, 1]]), polygon([[[0, 0], [0, 1], [1, 1]]])]);
    const b = flattenGeoJson([point(9, 9), polygon([[[5, 5], [5, 6], [6, 6], [6, 5]]])]);
    const merged = mergeFlatGeometries([a, b]);
    expect(vertexCount(merged)).toBe(vertexCount(a) + vertexCount(b));
  });
});

describe('vertexCount', () => {
  it('sums vertices across every bucket including holed polygons', () => {
    const flat = flattenGeoJson([
      point(0, 0),
      lineString([[1, 1], [2, 2]]),
      polygon([[[0, 0], [0, 1], [1, 1]]]),
      polygon([
        [[0, 0], [0, 4], [4, 4], [4, 0]],
        [[1, 1], [1, 2], [2, 2], [2, 1]],
      ]),
    ]);
    // 1 point + 2 path + 3 polygon + (4 + 4) holed = 14.
    expect(vertexCount(flat)).toBe(14);
  });
});
