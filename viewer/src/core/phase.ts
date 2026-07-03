import { emitEvent, type FetchPhase, type WorkPhase } from './events';

let currentPhase: FetchPhase = 'metadata';
let installed = false;
let activeUrl: string | null = null;

export function withPhase<T>(phase: FetchPhase, fn: () => Promise<T>): Promise<T> {
  const previous = currentPhase;
  currentPhase = phase;
  return fn().finally(() => {
    currentPhase = previous;
  });
}

// Times a unit of local work (WKB decode, GPU upload) and emits it on the
// same event bus as fetches, so the waterfall covers the full read path.
export function timeWork<T>(phase: WorkPhase, label: string, fn: () => T): T {
  const t0 = performance.now();
  const result = fn();
  emitEvent({ kind: 'work', phase, label, t0, t1: performance.now() });
  return result;
}

// Scopes emitted fetch events to the URL actually being inspected, so
// basemap/tile requests fired by MapLibre in the background do not pollute
// the waterfall and heatmap instrumentation with unrelated bytes.
export function setActiveUrl(url: string | null): void {
  activeUrl = url;
}

// t1 marks when the Response object (headers) arrived, not when the body
// finished downloading, since the body is streamed and read later by the
// caller (hyparquet). This is an accepted approximation for
// a research/inspection tool, not an attempt at exact download timing.
export function installFetchInstrumentation(): void {
  if (installed) return;
  installed = true;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const rangeHeader = init?.headers ? new Headers(init.headers).get('Range') : null;
    const t0 = performance.now();
    const response = await nativeFetch(input, init);
    const t1 = performance.now();
    const contentLength = response.headers.get('content-length');
    // Count bytes only for partial (206) transfers. A size probe (HEAD/GET for
    // the file length) answers 200 with the whole file's content-length, and
    // counting that would report the entire file as fetched. Keying off the 206
    // status (rather than the request's Range header) also catches readers
    // that set Range on the Request object instead of the fetch init.
    const byteLength = response.status === 206 && contentLength ? Number(contentLength) : 0;
    if (url === activeUrl) {
      // A Range request answered with 200 (not 206) means the server ignored the
      // range and is streaming the whole file. The byte meter shows 0 for it
      // (we only count 206 bodies), so warn rather than silently under-report.
      if (response.status === 200 && rangeHeader && contentLength) {
        console.warn(
          `Range request for ${url} was answered with status 200, not 206. The server ignored the Range header and is sending the whole file, so byte accounting is unavailable for this read.`,
        );
      }
      emitEvent({
        kind: 'fetch',
        phase: currentPhase,
        url,
        rangeHeader,
        byteLength,
        t0,
        t1,
      });
    }
    return response;
  };
}

export function resetFetchInstrumentationForTests(): void {
  installed = false;
}
