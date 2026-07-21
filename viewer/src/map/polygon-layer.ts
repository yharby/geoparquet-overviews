import { PathLayer, ScatterplotLayer, SolidPolygonLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import type { Bbox } from '../geo/aoi';
import type {
  FlatGeometries,
  FlatHoledPolygons,
  FlatPaths,
  FlatPoints,
  FlatPolygons,
} from '../geo/geojson';
import type { CountForRow } from '../data/counts';
import { perPrimitiveColors, perVertexColors, pointRadii, type Rgba } from './density-style';

// deck.gl's "complex flat" polygon: a flat positions array plus the element
// offsets where each interior ring (hole) begins. Returned straight from the
// getPolygon accessor, deck.gl normalizes and earcut-triangulates it with the
// holes cut out.
interface ComplexFlatPolygon {
  positions: Float64Array;
  holeIndices: number[];
}

// One teal palette shared across every geometry type so a mixed dataset reads as
// one layer. Polygons carry a translucent fill and a darker outline, points a
// solid dot, lines a bright stroke. When a density count lookup is supplied
// (0.3.0 count_column files at a coarse band), the fill and line alpha and the
// point radius scale per feature via density-style.ts, built once as binary
// attributes at layer-assembly time; without one, these constants apply.
const POLYGON_FILL: Rgba = [53, 193, 193, 180];
const POLYGON_LINE: Rgba = [16, 84, 84, 255];
const POINT_FILL: Rgba = [102, 214, 214, 220];
const LINE_COLOR: Rgba = [53, 193, 193, 230];
const POINT_RADIUS = 2.5;

// SolidPolygonLayer only paints fill, it has no stroke geometry, so on its own
// the polygons blend into each other with no visible boundaries. We pair it
// with a PathLayer that traces the same ring vertices to draw a distinct
// outline. Both layers share the binary positions and startIndices, so the
// outline costs no extra decode or upload of coordinates. An optional
// per-vertex fillColors array (density styling) rides along as a binary
// attribute, overriding the constant fill; the outline stays constant.
export function buildPolygonLayer(
  id: string,
  flat: FlatPolygons,
  fillColor: Rgba = POLYGON_FILL,
  lineColor: Rgba = POLYGON_LINE,
  fillColors: Uint8ClampedArray | null = null,
): Layer[] {
  return [
    new SolidPolygonLayer({
      id,
      data: {
        length: flat.startIndices.length - 1,
        startIndices: flat.startIndices,
        attributes: {
          getPolygon: { value: flat.positions, size: 2 },
          // A binary attribute in `data.attributes` overrides the constant
          // accessor below, so the constant remains the no-counts fallback.
          ...(fillColors ? { getFillColor: { value: fillColors, size: 4 } } : {}),
        },
      },
      _normalize: false,
      getFillColor: fillColor,
      // The fill is pickable so a click resolves to a polygon ordinal, mapped
      // back to its parquet row via the bucket's rowIds. The outline below stays
      // unpickable so one click never resolves to two primitives.
      pickable: true,
    }),
    new PathLayer({
      id: `${id}-outline`,
      data: {
        length: flat.startIndices.length - 1,
        startIndices: flat.startIndices,
        attributes: {
          getPath: { value: flat.positions, size: 2 },
        },
      },
      _pathType: 'loop',
      getColor: lineColor,
      widthUnits: 'pixels',
      getWidth: 1,
      widthMinPixels: 1,
      pickable: false,
    }),
  ];
}

// Points as a binary-attribute ScatterplotLayer. Radius is in pixels with a
// minimum so points stay visible at every zoom rather than shrinking to nothing.
// An optional per-instance radii array (density styling) rides along as a
// binary attribute, overriding the constant radius.
export function buildPointLayer(
  id: string,
  flat: FlatPoints,
  fillColor: Rgba = POINT_FILL,
  radii: Float32Array | null = null,
): Layer {
  return new ScatterplotLayer({
    id,
    data: {
      length: flat.positions.length / 2,
      attributes: {
        getPosition: { value: flat.positions, size: 2 },
        ...(radii ? { getRadius: { value: radii, size: 1 } } : {}),
      },
    },
    radiusUnits: 'pixels',
    getRadius: POINT_RADIUS,
    radiusMinPixels: 1.5,
    getFillColor: fillColor,
    pickable: true,
  });
}

// Lines as a binary-attribute open PathLayer. Width is in pixels with a minimum
// so thin lines stay drawable at low zoom. An optional per-vertex colors array
// (density styling) rides along as a binary attribute, overriding the constant.
export function buildLineLayer(
  id: string,
  flat: FlatPaths,
  lineColor: Rgba = LINE_COLOR,
  colors: Uint8ClampedArray | null = null,
): Layer {
  return new PathLayer({
    id,
    data: {
      length: flat.startIndices.length - 1,
      startIndices: flat.startIndices,
      attributes: {
        getPath: { value: flat.positions, size: 2 },
        ...(colors ? { getColor: { value: colors, size: 4 } } : {}),
      },
    },
    _pathType: 'open',
    getColor: lineColor,
    widthUnits: 'pixels',
    getWidth: 1,
    widthMinPixels: 1,
    pickable: true,
  });
}

// Polygons with holes, off the flat binary buckets. The fill is a
// SolidPolygonLayer whose getPolygon hands deck.gl one "complex flat" geometry
// per polygon (a positions subarray plus the hole offsets), so deck.gl cuts the
// holes out of the fill. deck.gl 9.3.6's fill model excludes the vertexValid
// attribute, so a pure binary getPolygon+vertexValid layer would fill the holes
// solid; the complex-flat accessor is the reprojection- and dependency-free way
// to keep holes correct while still storing the coordinates once, flat. The
// outline is a fully binary PathLayer keyed on the per-ring startIndices, sharing
// the same positions array, so it traces every ring (exterior and holes).
// The optional fillColors array holds one RGBA per polygon (density styling);
// the data here is already one object per polygon, so a by-ordinal accessor
// into that precomputed array adds no row objects and no per-frame work
// (deck.gl evaluates it once at attribute-fill time).
export function buildHoledPolygonLayer(
  id: string,
  holed: FlatHoledPolygons,
  fillColor: Rgba = POLYGON_FILL,
  lineColor: Rgba = POLYGON_LINE,
  fillColors: Uint8ClampedArray | null = null,
): Layer[] {
  const { positions, polygonStartIndices, ringStartIndices } = holed;
  const polygonCount = polygonStartIndices.length - 1;
  const fillData: ComplexFlatPolygon[] = [];
  // Walk the ring boundaries once, grouping them under each polygon. A ring
  // boundary strictly inside a polygon's vertex span is the start of a hole; the
  // boundary that equals the polygon start or end is not.
  let ringPtr = 1; // skip the leading 0 of ringStartIndices
  for (let p = 0; p < polygonCount; p++) {
    const startVertex = polygonStartIndices[p];
    const endVertex = polygonStartIndices[p + 1];
    const holeIndices: number[] = [];
    while (ringPtr < ringStartIndices.length && ringStartIndices[ringPtr] < endVertex) {
      const ringStart = ringStartIndices[ringPtr];
      // Offset is relative to this polygon's positions subarray, two values/vertex.
      if (ringStart > startVertex) holeIndices.push((ringStart - startVertex) * 2);
      ringPtr += 1;
    }
    fillData.push({ positions: positions.subarray(startVertex * 2, endVertex * 2), holeIndices });
  }
  return [
    new SolidPolygonLayer<ComplexFlatPolygon>({
      id,
      data: fillData,
      getPolygon: (d) => d,
      // Accessor-based data (no binary geometryBuffer), so deck.gl's tesselator
      // falls back to `positionFormat` to size each position; the default is
      // 'XYZ' (stride 3), which earcut walks straight through this 2-component
      // {positions, holeIndices} data and yields zero triangles. Force 'XY' so
      // the fill actually tesselates.
      positionFormat: 'XY',
      getFillColor: fillColors
        ? (_, { index }) =>
            [fillColors[index * 4], fillColors[index * 4 + 1], fillColors[index * 4 + 2], fillColors[index * 4 + 3]] as Rgba
        : fillColor,
      // Pickable like the hole-free fill; info.index is the polygon ordinal in
      // fillData, aligned with holedPolygons.rowIds. The outline stays unpickable.
      pickable: true,
    }),
    new PathLayer({
      id: `${id}-outline`,
      data: {
        length: ringStartIndices.length - 1,
        startIndices: ringStartIndices,
        attributes: {
          getPath: { value: positions, size: 2 },
        },
      },
      _pathType: 'loop',
      getColor: lineColor,
      widthUnits: 'pixels',
      getWidth: 1,
      widthMinPixels: 1,
      pickable: false,
    }),
  ];
}

// The low-zoom bbox preview for a flat file with no overview column: one 1px
// rectangle outline per pruned row group, drawn from the footer covering bboxes
// with no geometry fetched. Positions are interleaved lon/lat (already
// reprojected). Each rectangle is emitted as five vertices with the first point
// repeated to close the ring explicitly, rather than relying on the PathLayer's
// `loop` mode, which does not add the closing segment for binary startIndices
// data (the left edge would otherwise be missing). Shares the polygon outline
// color so the preview reads as the same dataset.
// Vertices per box ring: four corners plus the first repeated to close it.
const BBOX_RING_VERTS = 5;

// Pack the boxes into interleaved-xy ring positions and their per-box
// startIndices, each ring closed by repeating its first corner. Pure and
// exported so the closed-ring invariant is unit-testable without a GPU.
export function bboxRings(boxes: Bbox[]): { positions: Float64Array; startIndices: Uint32Array } {
  const positions = new Float64Array(boxes.length * BBOX_RING_VERTS * 2);
  const startIndices = new Uint32Array(boxes.length + 1);
  let p = 0;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    startIndices[i] = i * BBOX_RING_VERTS;
    // bottom-left, bottom-right, top-right, top-left, back to bottom-left.
    positions[p++] = b.xmin;
    positions[p++] = b.ymin;
    positions[p++] = b.xmax;
    positions[p++] = b.ymin;
    positions[p++] = b.xmax;
    positions[p++] = b.ymax;
    positions[p++] = b.xmin;
    positions[p++] = b.ymax;
    positions[p++] = b.xmin;
    positions[p++] = b.ymin;
  }
  startIndices[boxes.length] = boxes.length * BBOX_RING_VERTS;
  return { positions, startIndices };
}

export function buildBboxLayer(id: string, boxes: Bbox[]): Layer[] {
  if (boxes.length === 0) return [];
  const { positions, startIndices } = bboxRings(boxes);
  return [
    new PathLayer({
      id,
      data: {
        length: boxes.length,
        startIndices,
        attributes: { getPath: { value: positions, size: 2 } },
      },
      getColor: POLYGON_LINE,
      widthUnits: 'pixels',
      getWidth: 1,
      widthMinPixels: 1,
      pickable: false,
    }),
  ];
}

// Build only the layers a batch actually needs, one pass over the flattened
// buckets. A points-only file gets a single ScatterplotLayer, a polygon file the
// fill/outline pair, and a mixed file all of them. When `countForRow` is given
// (a 0.3.0 count_column file reading coarse bands), the density arrays are
// built here, once per layer assembly, and passed down as binary attributes;
// without it every builder keeps its constant style.
export function buildLayers(id: string, flat: FlatGeometries, countForRow?: CountForRow | null): Layer[] {
  const counts = countForRow ?? null;
  const layers: Layer[] = [];
  if (flat.polygons.startIndices.length > 1) {
    const fills = counts ? perVertexColors(flat.polygons, POLYGON_FILL, counts) : null;
    layers.push(...buildPolygonLayer(`${id}-poly`, flat.polygons, POLYGON_FILL, POLYGON_LINE, fills));
  }
  if (flat.holedPolygons.polygonStartIndices.length > 1) {
    const fills = counts ? perPrimitiveColors(flat.holedPolygons.rowIds, POLYGON_FILL, counts) : null;
    layers.push(...buildHoledPolygonLayer(`${id}-holed`, flat.holedPolygons, POLYGON_FILL, POLYGON_LINE, fills));
  }
  if (flat.paths.startIndices.length > 1) {
    const colors = counts ? perVertexColors(flat.paths, LINE_COLOR, counts) : null;
    layers.push(buildLineLayer(`${id}-line`, flat.paths, LINE_COLOR, colors));
  }
  if (flat.points.positions.length > 0) {
    const radii = counts ? pointRadii(flat.points, POINT_RADIUS, counts) : null;
    layers.push(buildPointLayer(`${id}-point`, flat.points, POINT_FILL, radii));
  }
  return layers;
}
