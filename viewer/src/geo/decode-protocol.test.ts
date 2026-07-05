import { describe, it, expect } from 'vitest';
import { allWkb, packWkb, unpackWkb, flatBuffers } from './decode-protocol';
import { flattenWkb } from './wkb-flatten';
import type { FlatGeometries } from './geojson';

// Minimal little-endian WKB encoders, enough to exercise the transfer packing.
function wkbPoint(x: number, y: number): Uint8Array {
  const b = new Uint8Array(21);
  const dv = new DataView(b.buffer);
  dv.setUint8(0, 1); // little-endian
  dv.setUint32(1, 1, true); // Point
  dv.setFloat64(5, x, true);
  dv.setFloat64(13, y, true);
  return b;
}

function wkbTriangle(ox: number, oy: number): Uint8Array {
  // A closed 4-vertex ring (one exterior ring, no holes).
  const b = new Uint8Array(1 + 4 + 4 + 4 + 4 * 16);
  const dv = new DataView(b.buffer);
  let o = 0;
  dv.setUint8(o, 1); o += 1;
  dv.setUint32(o, 3, true); o += 4; // Polygon
  dv.setUint32(o, 1, true); o += 4; // one ring
  dv.setUint32(o, 4, true); o += 4; // four vertices
  const pts = [[ox, oy], [ox + 1, oy], [ox + 1, oy + 1], [ox, oy]];
  for (const [x, y] of pts) {
    dv.setFloat64(o, x, true); o += 8;
    dv.setFloat64(o, y, true); o += 8;
  }
  return b;
}

describe('allWkb', () => {
  it('is true only when every value is a byte array', () => {
    expect(allWkb([wkbPoint(1, 2), wkbPoint(3, 4)])).toBe(true);
    expect(allWkb([wkbPoint(1, 2), null])).toBe(false);
    expect(allWkb([{ type: 'Point', coordinates: [1, 2] }])).toBe(false);
  });
});

describe('packWkb / unpackWkb', () => {
  it('round-trips values of differing lengths byte for byte', () => {
    const values = [wkbPoint(10, 20), wkbTriangle(0, 0), wkbPoint(-5, 7)];
    const { bytes, offsets } = packWkb(values);
    // offsets has n+1 entries and the last equals the total byte length.
    expect(offsets.length).toBe(values.length + 1);
    expect(offsets[0]).toBe(0);
    expect(offsets[offsets.length - 1]).toBe(values.reduce((s, v) => s + v.byteLength, 0));
    const back = unpackWkb(bytes, offsets);
    expect(back.length).toBe(values.length);
    for (let i = 0; i < values.length; i++) {
      expect(Array.from(back[i])).toEqual(Array.from(values[i]));
    }
  });

  it('unpacked views keep a valid byteOffset window over the shared buffer', () => {
    const values = [wkbPoint(1, 1), wkbPoint(2, 2)];
    const { bytes, offsets } = packWkb(values);
    const back = unpackWkb(bytes, offsets);
    // The second view is offset into the one packed buffer, so a DataView built
    // the way the scanner builds it must read the second point's coordinates.
    expect(back[1].buffer).toBe(bytes.buffer);
    expect(back[1].byteOffset).toBe(offsets[1]);
    const dv = new DataView(back[1].buffer, back[1].byteOffset, back[1].byteLength);
    expect(dv.getFloat64(5, true)).toBe(2);
  });

  it('handles an empty batch', () => {
    const { bytes, offsets } = packWkb([]);
    expect(bytes.byteLength).toBe(0);
    expect(offsets.length).toBe(1);
    expect(unpackWkb(bytes, offsets)).toEqual([]);
  });
});

// The heart of the guarantee: decoding through the pack/unpack transfer path must
// produce exactly what decoding the original views produces, provenance included.
describe('pack/unpack decode equivalence', () => {
  it('flattenWkb over unpacked views equals flattenWkb over the originals', () => {
    const values = [wkbPoint(10, 20), wkbTriangle(3, 4), wkbPoint(-1, -2)];
    const rows = [7, 8, 9];
    const direct = flattenWkb(values, null, rows);
    const { bytes, offsets } = packWkb(values);
    const viaWorker = flattenWkb(unpackWkb(bytes, offsets), null, Uint32Array.from(rows));

    const same = (a: FlatGeometries, b: FlatGeometries) => {
      expect(Array.from(a.points.positions)).toEqual(Array.from(b.points.positions));
      expect(Array.from(a.points.rowIds)).toEqual(Array.from(b.points.rowIds));
      expect(Array.from(a.polygons.positions)).toEqual(Array.from(b.polygons.positions));
      expect(Array.from(a.polygons.startIndices)).toEqual(Array.from(b.polygons.startIndices));
      expect(Array.from(a.polygons.rowIds)).toEqual(Array.from(b.polygons.rowIds));
    };
    same(direct, viaWorker);
    // Provenance rode through the pack: the triangle carries row 8.
    expect(Array.from(viaWorker.polygons.rowIds)).toEqual([8]);
    expect(Array.from(viaWorker.points.rowIds)).toEqual([7, 9]);
  });
});

describe('flatBuffers', () => {
  it('lists one distinct buffer per bucket array, deduplicated', () => {
    const flat = flattenWkb([wkbPoint(1, 2), wkbTriangle(0, 0)], null, [0, 1]);
    const buffers = flatBuffers(flat);
    // 12 bucket arrays, all distinct backing buffers.
    expect(buffers.length).toBe(12);
    expect(new Set(buffers).size).toBe(buffers.length);
  });
});
