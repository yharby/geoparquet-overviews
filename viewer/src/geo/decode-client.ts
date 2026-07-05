import type { FlatGeometries } from './geojson';
import type { TransformSpec } from './crs';
import { allWkb, packWkb, type DecodeResponse } from './decode-protocol';

// Main-thread client for the decode worker. It packs a batch, ships it, and
// resolves with the flat buckets the worker transfers back. When no Worker is
// available (the node test env, or a browser where construction failed) it
// decodes synchronously on the calling thread via the caller's decodeSync, so
// the read path degrades to the old in-line behavior instead of breaking.

type DecodeSync = (geometries: unknown[], rows: number[]) => FlatGeometries;

interface Pending {
  resolve: (flat: FlatGeometries) => void;
  reject: (err: Error) => void;
}

// undefined: not yet tried. null: unavailable, use the sync fallback forever.
let worker: Worker | null | undefined;
const pending = new Map<number, Pending>();
let seq = 0;

// Reject every outstanding request and drop the worker, so a worker-level failure
// (script load error, crash) surfaces on each in-flight fetch and later batches
// fall back to the main thread rather than hanging on a dead worker.
function failWorker(message: string): void {
  const err = new Error(message);
  for (const p of pending.values()) p.reject(err);
  pending.clear();
  worker = null;
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === 'undefined') {
    worker = null;
    return null;
  }
  try {
    const w = new Worker(new URL('./decode-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<DecodeResponse>) => {
      const res = e.data;
      const p = pending.get(res.id);
      if (!p) return;
      pending.delete(res.id);
      if (res.ok) p.resolve(res.flat);
      else p.reject(new Error(res.error));
    };
    w.onerror = (e) => failWorker(`decode worker error: ${e.message || 'unknown'}`);
    w.onmessageerror = () => failWorker('decode worker message error');
    worker = w;
    return w;
  } catch {
    // Some environments expose Worker but reject module-worker construction; fall
    // back to the main thread rather than throwing on every decode.
    worker = null;
    return null;
  }
}

// Decode one batch. Offloads to the worker when it can, otherwise decodes inline
// with decodeSync (which closes over the same transform), so both paths produce
// identical FlatGeometries. rows is the absolute parquet row per value.
export function decodeBatch(
  geometries: unknown[],
  rows: number[],
  spec: TransformSpec,
  decodeSync: DecodeSync,
): Promise<FlatGeometries> {
  const w = getWorker();
  if (!w) {
    try {
      return Promise.resolve(decodeSync(geometries, rows));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
  const id = ++seq;
  return new Promise<FlatGeometries>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    if (allWkb(geometries)) {
      const { bytes, offsets } = packWkb(geometries);
      const rowsU32 = Uint32Array.from(rows);
      w.postMessage({ id, kind: 'wkb', bytes, offsets, rows: rowsU32, spec }, [
        bytes.buffer,
        offsets.buffer,
        rowsU32.buffer,
      ]);
    } else {
      // A null or a decoded object is present, so there is nothing to pack;
      // structure-clone the values and let the worker's shared probe handle them.
      w.postMessage({ id, kind: 'raw', values: geometries, rows, spec });
    }
  });
}

// Test seam: drop the worker and any pending requests so a test starts clean.
export function resetDecodeClientForTests(): void {
  worker = undefined;
  pending.clear();
  seq = 0;
}
