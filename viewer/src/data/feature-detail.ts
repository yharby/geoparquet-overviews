import { parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { getCachedFile } from './file-cache';

// Reads are serialized through this chain, and a generation counter lets a queued
// read that a newer click already superseded skip its fetch burst entirely. See
// readRowAttributes for why overlapping reads must never run.
let readChain: Promise<unknown> = Promise.resolve();
let latestGen = 0;

// A read that stalls (a range request left hanging under connection pressure, or a
// hyparquet decode that never settles) must not spin the popup forever or, because
// the chain waits on each read, block every later click behind it. So each read
// races a timeout and rejects, which surfaces an error in the popup and lets the
// chain move on.
const READ_TIMEOUT_MS = 12_000;

// Read one feature's non-geometry attribute columns for the click popup. This is
// a targeted single-row read: hyparquet range-requests only the pages covering
// [row, row+1) of the requested columns, so opening a popup costs a few small
// byte ranges, not a column scan. Unlike the geometry read path this keeps
// hyparquet's default parsers and utf8 decoding on, so strings come back as
// strings and logical types are materialized for display. Returns an empty
// object when the row yields nothing (an out-of-range row or an all-null row).
//
// Reads are serialized. A single-row attribute read spans every attribute column,
// so hyparquet's prefetchAsyncBuffer fires a burst of concurrent range requests
// per read. Two of those bursts overlapping, a quick second click before the
// first resolves, exhausts the browser's per-host connection pool and can leave a
// range request stalled, which never settles and wedges the shared byte-cache
// entry that every later read awaits, so the popup hangs on "loading" forever.
// Running them one at a time keeps each read to a single burst; the caller's pick
// token drops all but the latest result, and a queued read that a newer click has
// already superseded returns empty without spending a fetch.
export function readRowAttributes(
  url: string,
  row: number,
  columns: string[],
): Promise<Record<string, unknown>> {
  const gen = ++latestGen;
  const run = readChain.then(() => {
    if (gen !== latestGen) return {};
    return withTimeout(readRowAttributesNow(url, row, columns), READ_TIMEOUT_MS);
  });
  // Keep the chain alive even if this read rejects (including on timeout), so a
  // failed read never blocks the next click's read behind a rejected promise.
  readChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

// Reject if the read has not settled within ms. A late resolution of the wrapped
// promise is harmless, the returned promise has already settled so it is ignored.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`attribute read timed out after ${ms / 1000}s`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function readRowAttributesNow(
  url: string,
  row: number,
  columns: string[],
): Promise<Record<string, unknown>> {
  const { file, metadata } = await getCachedFile(url);
  const objs = await parquetReadObjects({
    file,
    metadata,
    columns,
    rowStart: row,
    rowEnd: row + 1,
    compressors,
  });
  return (objs[0] as Record<string, unknown> | undefined) ?? {};
}
