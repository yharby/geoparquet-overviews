import { PathLayer, ScatterplotLayer, SolidPolygonLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import type {
  FlatGeometries,
  FlatHoledPolygons,
  FlatPaths,
  FlatPoints,
  FlatPolygons,
} from '../geo/geojson';

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
// solid dot, lines a bright stroke.
type Rgba = [number, number, number, number];
const POLYGON_FILL: Rgba = [53, 193, 193, 180];
const POLYGON_LINE: Rgba = [16, 84, 84, 255];
const POINT_FILL: Rgba = [102, 214, 214, 220];
const LINE_COLOR: Rgba = [53, 193, 193, 230];

// SolidPolygonLayer only paints fill, it has no stroke geometry, so on its own
// the polygons blend into each other with no visible boundaries. We pair it
// with a PathLayer that traces the same ring vertices to draw a distinct
// outline. Both layers share the binary positions and startIndices, so the
// outline costs no extra decode or upload of coordinates.
export function buildPolygonLayer(
  id: string,
  flat: FlatPolygons,
  fillColor: Rgba = POLYGON_FILL,
  lineColor: Rgba = POLYGON_LINE,
): Layer[] {
  return [
    new SolidPolygonLayer({
      id,
      data: {
        length: flat.startIndices.length - 1,
        startIndices: flat.startIndices,
        attributes: {
          getPolygon: { value: flat.positions, size: 2 },
        },
      },
      _normalize: false,
      getFillColor: fillColor,
      pickable: false,
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
export function buildPointLayer(id: string, flat: FlatPoints, fillColor: Rgba = POINT_FILL): Layer {
  return new ScatterplotLayer({
    id,
    data: {
      length: flat.positions.length / 2,
      attributes: {
        getPosition: { value: flat.positions, size: 2 },
      },
    },
    radiusUnits: 'pixels',
    getRadius: 2.5,
    radiusMinPixels: 1.5,
    getFillColor: fillColor,
    pickable: false,
  });
}

// Lines as a binary-attribute open PathLayer. Width is in pixels with a minimum
// so thin lines stay drawable at low zoom.
export function buildLineLayer(id: string, flat: FlatPaths, lineColor: Rgba = LINE_COLOR): Layer {
  return new PathLayer({
    id,
    data: {
      length: flat.startIndices.length - 1,
      startIndices: flat.startIndices,
      attributes: {
        getPath: { value: flat.positions, size: 2 },
      },
    },
    _pathType: 'open',
    getColor: lineColor,
    widthUnits: 'pixels',
    getWidth: 1,
    widthMinPixels: 1,
    pickable: false,
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
export function buildHoledPolygonLayer(
  id: string,
  holed: FlatHoledPolygons,
  fillColor: Rgba = POLYGON_FILL,
  lineColor: Rgba = POLYGON_LINE,
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
      getFillColor: fillColor,
      pickable: false,
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

// Build only the layers a batch actually needs, one pass over the flattened
// buckets. A points-only file gets a single ScatterplotLayer, a polygon file the
// fill/outline pair, and a mixed file all of them.
export function buildLayers(id: string, flat: FlatGeometries): Layer[] {
  const layers: Layer[] = [];
  if (flat.polygons.startIndices.length > 1) {
    layers.push(...buildPolygonLayer(`${id}-poly`, flat.polygons));
  }
  if (flat.holedPolygons.polygonStartIndices.length > 1) {
    layers.push(...buildHoledPolygonLayer(`${id}-holed`, flat.holedPolygons));
  }
  if (flat.paths.startIndices.length > 1) {
    layers.push(buildLineLayer(`${id}-line`, flat.paths));
  }
  if (flat.points.positions.length > 0) {
    layers.push(buildPointLayer(`${id}-point`, flat.points));
  }
  return layers;
}
