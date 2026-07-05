import { flattenWkb, decodeFlat } from './wkb-flatten';
import { buildTransformFromSpec } from './crs';
import { unpackWkb, flatBuffers, type DecodeRequest, type DecodeResponse } from './decode-protocol';

// The decode worker. It runs the CPU-bound half of the read path off the main
// thread: parsing WKB into flat typed-array buckets and reprojecting every vertex
// with proj4. The main thread stays free to service map pan and zoom while a
// batch decodes, which is the whole point of moving this here.
//
// It receives one batch per message, rebuilds the reprojection transform from the
// serializable spec (the transform closure cannot cross postMessage), decodes,
// and posts the flat buckets back with their buffers transferred. A malformed
// value throws inside the scanner; it is caught and returned as an error so the
// main thread rejects that one batch rather than the worker dying.

// self is typed as a Window under the DOM lib, whose postMessage signature does
// not match a worker's; shape just what this file uses to sidestep that without
// pulling in the webworker lib (which collides with DOM).
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<DecodeRequest>) => void) | null;
  postMessage: (message: DecodeResponse, transfer: Transferable[]) => void;
};

ctx.onmessage = (e) => {
  const req = e.data;
  try {
    const transform = buildTransformFromSpec(req.spec);
    const flat =
      req.kind === 'wkb'
        ? flattenWkb(unpackWkb(req.bytes, req.offsets), transform, req.rows)
        : decodeFlat(req.values, transform, req.rows);
    ctx.postMessage({ id: req.id, ok: true, flat }, flatBuffers(flat));
  } catch (err) {
    ctx.postMessage(
      { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) },
      [],
    );
  }
};
