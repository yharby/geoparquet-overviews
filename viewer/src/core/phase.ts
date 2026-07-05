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

// Transient failures the hosted store (source.coop over S3/CloudFront) returns
// under load or throttling. A cross-origin 5xx also arrives with no CORS header,
// so the browser rejects the fetch outright and the caller sees a "CORS missing"
// TypeError rather than the status, hence we retry on thrown errors too.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_FETCH_ATTEMPTS = 3;
const RETRY_BASE_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Full jitter exponential backoff. Attempt 1 waits within [0, 150), attempt 2
// within [0, 300), keeping the retry cheap enough not to stall an interactive pan.
function defaultBackoff(attempt: number): number {
  return Math.random() * RETRY_BASE_MS * 2 ** (attempt - 1);
}

interface RetryOptions {
  attempts?: number;
  idempotent?: boolean;
  delayForAttempt?: (attempt: number) => number;
  isRetryableStatus?: (status: number) => boolean;
}

// Retries a fetch on transient 5xx/429 responses and on network/CORS-blocked
// rejections, with bounded attempts and jittered backoff. Only idempotent
// requests (GET/HEAD) are retried, so a replayed request can never double a
// side effect. The final attempt's result (a response of any status, or a
// thrown error) is surfaced unchanged, preserving the caller's error handling.
export async function fetchWithRetry(
  doFetch: () => Promise<Response>,
  opts: RetryOptions = {},
): Promise<Response> {
  const attempts = opts.attempts ?? MAX_FETCH_ATTEMPTS;
  const idempotent = opts.idempotent ?? true;
  const delayFor = opts.delayForAttempt ?? defaultBackoff;
  const isRetryableStatus = opts.isRetryableStatus ?? ((s) => RETRYABLE_STATUSES.has(s));
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const response = await doFetch();
      if (idempotent && attempt < attempts && isRetryableStatus(response.status)) {
        // Drain the abandoned error body so the connection can be reused.
        try {
          await response.body?.cancel();
        } catch {
          // ignore: the retry is what matters, not tidying the dropped body
        }
        await sleep(delayFor(attempt));
        continue;
      }
      return response;
    } catch (err) {
      if (idempotent && attempt < attempts) {
        await sleep(delayFor(attempt));
        continue;
      }
      throw err;
    }
  }
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method;
  if (typeof input !== 'string' && !(input instanceof URL)) return input.method;
  return 'GET';
}

function isIdempotent(method: string): boolean {
  const m = method.toUpperCase();
  return m === 'GET' || m === 'HEAD';
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
    // t0/t1 close over the latest attempt, so on a retry they report the timing
    // of the attempt whose response is actually returned, not the failed ones.
    let t0 = 0;
    let t1 = 0;
    const response = await fetchWithRetry(
      async () => {
        t0 = performance.now();
        const r = await nativeFetch(input, init);
        t1 = performance.now();
        return r;
      },
      { idempotent: isIdempotent(methodOf(input, init)) },
    );
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
