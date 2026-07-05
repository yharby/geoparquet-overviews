import type { TransformSpec } from './crs';
import type { FlatGeometries } from './geojson';

// The message protocol between the main thread and the decode worker, plus the
// pure pack/unpack helpers that move a batch across the boundary without ever
// touching a Worker or the DOM, so they unit-test in the node test env.
//
// The input WKB is copied into one fresh contiguous buffer and that buffer is
// transferred, never the reader's own Uint8Array views: those alias the byte
// cache's decompressed pages (immutable, shared by reference), and transferring
// them would detach and corrupt the cache. The copy is one memcpy on the main
// thread, far cheaper than the parse and per-vertex reprojection it lets run off
// thread. The decoded flat buffers are worker-born, so they transfer back freely.

// A batch whose values are all raw WKB byte arrays (the real read path), packed
// for a zero-copy transfer.
export interface WkbRequest {
  id: number;
  kind: 'wkb';
  // Every value's bytes concatenated, and the [offsets[i], offsets[i+1]) window
  // of each value within it. offsets has values.length + 1 entries.
  bytes: Uint8Array;
  offsets: Uint32Array;
  // Absolute parquet row per value, aligned with the offsets, so the worker
  // stamps provenance exactly as the main-thread decode would.
  rows: Uint32Array;
  spec: TransformSpec;
}

// A batch that carries at least one non-WKB value (a null, or an already-decoded
// GeoJSON object in the vestigial fallback path). Structure-cloned, not
// transferred, since there is nothing to pack.
export interface RawRequest {
  id: number;
  kind: 'raw';
  values: unknown[];
  rows: number[];
  spec: TransformSpec;
}

export type DecodeRequest = WkbRequest | RawRequest;

export interface DecodeOk {
  id: number;
  ok: true;
  flat: FlatGeometries;
}

export interface DecodeErr {
  id: number;
  ok: false;
  error: string;
}

export type DecodeResponse = DecodeOk | DecodeErr;

// True only when every value is a raw WKB byte array, so the batch can take the
// packed transfer path. A null or a decoded object makes it false, routing the
// batch to the structure-cloned raw path where the shared probe handles nulls.
export function allWkb(values: unknown[]): values is Uint8Array[] {
  for (const v of values) if (!(v instanceof Uint8Array)) return false;
  return true;
}

// Copy a batch of WKB byte arrays into one contiguous buffer plus per-value
// offsets. This is the single main-thread copy; the returned buffers are fresh,
// so the caller transfers them without touching any cached bytes.
export function packWkb(values: Uint8Array[]): { bytes: Uint8Array; offsets: Uint32Array } {
  let total = 0;
  for (const v of values) total += v.byteLength;
  const bytes = new Uint8Array(total);
  const offsets = new Uint32Array(values.length + 1);
  let off = 0;
  for (let i = 0; i < values.length; i++) {
    bytes.set(values[i], off);
    off += values[i].byteLength;
    offsets[i + 1] = off;
  }
  return { bytes, offsets };
}

// Reconstruct the per-value byte views over the transferred buffer. subarray
// keeps the shared buffer with the right byteOffset/byteLength, so the WKB
// scanner reads it in place with no further copy.
export function unpackWkb(bytes: Uint8Array, offsets: Uint32Array): Uint8Array[] {
  const n = offsets.length - 1;
  const values = new Array<Uint8Array>(n);
  for (let i = 0; i < n; i++) values[i] = bytes.subarray(offsets[i], offsets[i + 1]);
  return values;
}

// Every distinct backing ArrayBuffer of a FlatGeometries, for the reply transfer
// list. Deduplicated so an accidental shared buffer is never listed twice, which
// would throw a DataCloneError on postMessage.
export function flatBuffers(flat: FlatGeometries): ArrayBuffer[] {
  // The buckets are all built with `.slice`, so their buffers are plain
  // ArrayBuffers (never SharedArrayBuffer); assert that so the transfer list
  // types as ArrayBuffer[].
  const buffers = [
    flat.points.positions.buffer,
    flat.points.rowIds.buffer,
    flat.paths.positions.buffer,
    flat.paths.startIndices.buffer,
    flat.paths.rowIds.buffer,
    flat.polygons.positions.buffer,
    flat.polygons.startIndices.buffer,
    flat.polygons.rowIds.buffer,
    flat.holedPolygons.positions.buffer,
    flat.holedPolygons.polygonStartIndices.buffer,
    flat.holedPolygons.ringStartIndices.buffer,
    flat.holedPolygons.rowIds.buffer,
  ] as ArrayBuffer[];
  return [...new Set(buffers)];
}
