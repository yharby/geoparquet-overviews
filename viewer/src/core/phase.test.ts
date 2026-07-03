import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { installFetchInstrumentation, setActiveUrl, resetFetchInstrumentationForTests } from './phase';
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
