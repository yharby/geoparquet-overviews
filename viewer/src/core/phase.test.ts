import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  installFetchInstrumentation,
  setActiveUrl,
  resetFetchInstrumentationForTests,
  fetchWithRetry,
} from './phase';
import { onEvent, type ViewerEvent } from './events';

const URL = 'https://example.test/file.parquet';

function fakeResponse(contentLength: number | null, status = 200): Response {
  const headers = new Headers();
  if (contentLength !== null) headers.set('content-length', String(contentLength));
  return { headers, status } as unknown as Response;
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  resetFetchInstrumentationForTests();
  setActiveUrl(URL);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setActiveUrl(null);
});

function capture(): ViewerEvent[] {
  const events: ViewerEvent[] = [];
  onEvent((e) => events.push(e));
  return events;
}

// A size probe (HEAD, no Range) reports the whole file's content-length. It
// must not be counted as bytes over the wire, or a range-read inspector would
// report having fetched the entire file.
test('a 200 size probe contributes zero bytes', async () => {
  const FILE = 735_939_514;
  globalThis.fetch = vi.fn().mockResolvedValue(fakeResponse(FILE, 200)) as unknown as typeof globalThis.fetch;
  const events = capture();
  installFetchInstrumentation();

  await globalThis.fetch(URL, { method: 'HEAD' });

  expect(events).toHaveLength(1);
  expect(events[0].kind).toBe('fetch');
  if (events[0].kind === 'fetch') expect(events[0].byteLength).toBe(0);
});

// A partial (206) read reports the range's size in content-length, which is the
// real bytes transferred and should be counted.
test('a 206 ranged read counts its partial content-length', async () => {
  const RANGE = 524_288;
  globalThis.fetch = vi.fn().mockResolvedValue(fakeResponse(RANGE, 206)) as unknown as typeof globalThis.fetch;
  const events = capture();
  installFetchInstrumentation();

  await globalThis.fetch(URL, { headers: { Range: 'bytes=0-524287' } });

  expect(events).toHaveLength(1);
  if (events[0].kind === 'fetch') expect(events[0].byteLength).toBe(RANGE);
});

// Some readers set Range on the Request object, not the fetch init. Byte
// counting must key off the 206 status, not the init Range header, or these
// row-group reads would be missed entirely.
test('a 206 read counts even when Range is not in the init', async () => {
  const CHUNK = 9_700_000;
  globalThis.fetch = vi.fn().mockResolvedValue(fakeResponse(CHUNK, 206)) as unknown as typeof globalThis.fetch;
  const events = capture();
  installFetchInstrumentation();

  // no init at all — Range would live on a Request object passed as input
  await globalThis.fetch(URL);

  expect(events).toHaveLength(1);
  if (events[0].kind === 'fetch') expect(events[0].byteLength).toBe(CHUNK);
});

// Requests to other URLs (basemap tiles, fonts) must not pollute the metrics.
test('requests to a non-active URL are ignored', async () => {
  globalThis.fetch = vi.fn().mockResolvedValue(fakeResponse(1234, 206)) as unknown as typeof globalThis.fetch;
  const events = capture();
  installFetchInstrumentation();

  await globalThis.fetch('https://other.test/tile.png', { headers: { Range: 'bytes=0-1233' } });

  expect(events).toHaveLength(0);
});

// --- fetchWithRetry: transient-failure retry for the range-read path ---

// No backoff wait in tests, so the retry loop runs fast. A real body so the
// retry branch also exercises response.body.cancel() on the dropped response.
const noWait = { delayForAttempt: () => 0 };
function res(status: number): Response {
  return new Response('x', { status });
}

test('returns the first response and does not retry a success', async () => {
  const doFetch = vi.fn().mockResolvedValue(res(206));
  const out = await fetchWithRetry(doFetch, noWait);
  expect(out.status).toBe(206);
  expect(doFetch).toHaveBeenCalledTimes(1);
});

test('does not retry a non-transient error status', async () => {
  const doFetch = vi.fn().mockResolvedValue(res(404));
  const out = await fetchWithRetry(doFetch, noWait);
  expect(out.status).toBe(404);
  expect(doFetch).toHaveBeenCalledTimes(1);
});

test('retries a transient 503 then returns the eventual success', async () => {
  const doFetch = vi.fn().mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(206));
  const out = await fetchWithRetry(doFetch, noWait);
  expect(out.status).toBe(206);
  expect(doFetch).toHaveBeenCalledTimes(2);
});

// A cross-origin 5xx arrives without a CORS header, so the browser rejects the
// fetch as a TypeError rather than surfacing the status. That path must retry too.
test('retries a thrown network/CORS rejection then succeeds', async () => {
  const doFetch = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce(res(206));
  const out = await fetchWithRetry(doFetch, noWait);
  expect(out.status).toBe(206);
  expect(doFetch).toHaveBeenCalledTimes(2);
});

test('gives up after the attempt budget and returns the last transient response', async () => {
  const doFetch = vi.fn().mockResolvedValue(res(500));
  const out = await fetchWithRetry(doFetch, { ...noWait, attempts: 3 });
  expect(out.status).toBe(500);
  expect(doFetch).toHaveBeenCalledTimes(3);
});

test('gives up after the attempt budget and rethrows a persistent rejection', async () => {
  const doFetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
  await expect(fetchWithRetry(doFetch, { ...noWait, attempts: 3 })).rejects.toThrow('Failed to fetch');
  expect(doFetch).toHaveBeenCalledTimes(3);
});

// A non-idempotent request must never be replayed, or a retry could double a
// side effect. The app only issues GETs, but the guard keeps that contract.
test('never retries a non-idempotent request, even on a transient status', async () => {
  const doFetch = vi.fn().mockResolvedValue(res(503));
  const out = await fetchWithRetry(doFetch, { ...noWait, idempotent: false });
  expect(out.status).toBe(503);
  expect(doFetch).toHaveBeenCalledTimes(1);
});
