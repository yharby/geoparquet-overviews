export type FetchPhase = 'footer' | 'prefetch' | 'metadata' | 'page-index' | 'row-group-fetch' | 'count-fetch';
export type WorkPhase = 'wkb-decode' | 'gpu-upload' | 'flatten-cache';

export interface FetchEvent {
  kind: 'fetch';
  phase: FetchPhase;
  url: string;
  rangeHeader: string | null;
  byteLength: number;
  t0: number;
  t1: number;
}

// CPU/GPU work that is not a network fetch (WKB decode, layer upload). Timed
// by the calling code and emitted so the waterfall shows the full read path,
// not just the bytes over the wire.
export interface WorkEvent {
  kind: 'work';
  phase: WorkPhase;
  label: string;
  t0: number;
  t1: number;
}

export type ViewerEvent = FetchEvent | WorkEvent;

type Listener = (event: ViewerEvent) => void;

const listeners = new Set<Listener>();

export function onEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitEvent(event: ViewerEvent): void {
  for (const listener of listeners) {
    listener(event);
  }
}
