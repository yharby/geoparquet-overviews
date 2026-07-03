import { describe, it, expect } from 'vitest';
import { SolidPolygonLayer } from '@deck.gl/layers';
// Deep import straight past @deck.gl/layers' package.json "exports" map (which
// only publishes the "." entry) to the installed tesselator module the fill
// SolidPolygonLayer actually delegates to. This lets the regression test drive
// the real earcut-backed triangulation deck.gl 9.3.6 ships, the same one the
// code review used to empirically confirm the bug, rather than re-implementing
// or mocking its behavior.
import { getSurfaceIndices } from '../../node_modules/@deck.gl/layers/dist/solid-polygon-layer/polygon.js';
import { buildHoledPolygonLayer } from './polygon-layer';
import type { FlatHoledPolygons } from '../geo/geojson';

// Square with a square hole, interleaved xy: exterior 4 verts then hole 4 verts.
// holeIndices is in ELEMENT units (vertex 4 * 2 components = element 8).
const SQUARE_WITH_HOLE_POSITIONS = new Float64Array([
  0, 0, 0, 4, 4, 4, 4, 0, // exterior
  1, 1, 1, 2, 2, 2, 2, 1, // hole
]);

describe('deck.gl complex-flat polygon tesselation (installed 9.3.6 tesselator)', () => {
  it('triangulates a square-with-hole into 8 triangles when positionSize is 2', () => {
    const complexFlat = { positions: SQUARE_WITH_HOLE_POSITIONS, holeIndices: [8] };
    const indices = getSurfaceIndices(complexFlat, 2);
    expect(indices.length / 3).toBe(8);
  });

  it('produces zero triangles when the same data is walked at stride 3 (the bug)', () => {
    // This is exactly what happens without `positionFormat: 'XY'`: deck.gl's
    // Tesselator defaults positionSize to 3 for accessor-based (non-buffer)
    // geometry, so earcut walks 2-component data with a 3-component stride.
    const complexFlat = { positions: SQUARE_WITH_HOLE_POSITIONS, holeIndices: [8] };
    const indices = getSurfaceIndices(complexFlat, 3);
    expect(indices.length).toBe(0);
  });
});

describe('buildHoledPolygonLayer fill layer props', () => {
  it('sets positionFormat XY on the fill SolidPolygonLayer', () => {
    const holed: FlatHoledPolygons = {
      positions: SQUARE_WITH_HOLE_POSITIONS,
      polygonStartIndices: new Uint32Array([0, 8]),
      ringStartIndices: new Uint32Array([0, 4, 8]),
    };
    const layers = buildHoledPolygonLayer('test-holed', holed);
    const fillLayer = layers[0];
    expect(fillLayer).toBeInstanceOf(SolidPolygonLayer);
    expect(fillLayer.props.positionFormat).toBe('XY');
  });
});
