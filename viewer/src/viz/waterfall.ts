import { LitElement, html } from 'lit';
import { onEvent, type ViewerEvent } from '../core/events';

// A long session can accumulate thousands of events (one band-0 fetch alone
// emits ~100), and re-rendering the whole growing list on every arrival gets
// more expensive the longer the session runs. Cap what the panel retains so
// render cost stays bounded without virtualization, which the panel's size
// does not warrant.
export const WATERFALL_EVENT_CAP = 300;

// A fixed-capacity ring buffer: `push` overwrites in place with no per-event
// array copy (no `[...arr, item]`, no `shift()`), and once full the oldest
// entry is silently dropped to make room for the newest. `toArray()` returns
// the retained entries oldest-first.
export class RingBuffer<T> {
  private buf: (T | undefined)[];
  private start = 0;
  private count = 0;

  constructor(private readonly cap: number) {
    if (cap < 1) throw new Error('RingBuffer cap must be at least 1');
    this.buf = new Array(cap);
  }

  push(item: T): void {
    const index = (this.start + this.count) % this.cap;
    this.buf[index] = item;
    if (this.count < this.cap) {
      this.count += 1;
    } else {
      // Full: the write above just overwrote the old head, so advance start
      // past it instead of shifting every other element down.
      this.start = (this.start + 1) % this.cap;
    }
  }

  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i++) {
      out.push(this.buf[(this.start + i) % this.cap] as T);
    }
    return out;
  }

  get length(): number {
    return this.count;
  }

  clear(): void {
    this.start = 0;
    this.count = 0;
  }
}

// This is a temporal read-path timeline, not a band view. It deliberately
// avoids the band palette (--amber #e8b24a, --index #4f9d8c, --clay #d8613c),
// since those hues mean bands on the map and in the row-group popup. Reusing
// them here made phases read as if they were band-colored. Instead the
// timeline runs its own ramp, network phases in blues/purples, compute phases
// in greens.
const PHASE_COLORS: Record<string, string> = {
  footer: '#5b8bd4',
  prefetch: '#3f6fb0',
  metadata: '#5b8bd4',
  'page-index': '#7a6bd4',
  'row-group-fetch': '#4a90b8',
  'wkb-decode': '#6fbf4a',
  'gpu-upload': '#2f9e6b',
  'flatten-cache': '#4fae5a',
};

const PHASE_LABELS: Record<string, string> = {
  footer: 'footer',
  prefetch: 'whole-file prefetch',
  metadata: 'metadata',
  'page-index': 'page index',
  'row-group-fetch': 'row-group fetch',
  'wkb-decode': 'WKB decode',
  'gpu-upload': 'GPU upload',
  'flatten-cache': 'cache hit',
};

function fmtBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)} KB`;
  return `${n} B`;
}

export class VizWaterfall extends LitElement {
  private events = new RingBuffer<ViewerEvent>(WATERFALL_EVENT_CAP);
  private unsubscribe: (() => void) | null = null;
  // Coalesce arriving events into at most one requestUpdate per animation
  // frame, mirroring app-root.ts's scheduleVizFlush/flushVizNow pair: the
  // ring buffer above only bounds memory, it does not throttle renders, so
  // without this a fast burst (e.g. ~100 events for one band-0 fetch) still
  // re-renders the whole list once per event. Events are still pushed into
  // the ring buffer synchronously, only the render is deferred, so the
  // eventual flush always reflects every event received, none lost.
  private updateHandle: ReturnType<typeof requestAnimationFrame> | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.unsubscribe = onEvent((event) => {
      this.events.push(event);
      this.scheduleRenderFlush();
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscribe?.();
    if (this.updateHandle !== null) {
      cancelAnimationFrame(this.updateHandle);
      this.updateHandle = null;
    }
  }

  private scheduleRenderFlush(): void {
    if (this.updateHandle !== null) return;
    this.updateHandle = requestAnimationFrame(() => {
      this.updateHandle = null;
      this.requestUpdate();
    });
  }

  reset(): void {
    this.events.clear();
    this.requestUpdate();
  }

  render() {
    const events = this.events.toArray();
    if (events.length === 0) {
      return html`<div class="panel">
        <div class="panel-head"><span class="n">◆</span><h2>Read path</h2></div>
        <div class="empty">No requests yet. Load a file and fetch an area.</div>
      </div>`;
    }
    // Anchor to the oldest event still retained, not the session's original
    // first event, so the relative bar positions stay meaningful once the
    // ring buffer has evicted anything from before the cap.
    const start = events[0].t0;
    const end = Math.max(...events.map((e) => e.t1));
    const span = Math.max(end - start, 1);
    return html`
      <div class="panel">
        <div class="panel-head">
          <span class="n">◆</span>
          <h2>Read path</h2>
          <span class="note">${span.toFixed(0)} ms end to end</span>
        </div>
        <div class="waterfall">
          ${events.map((event) => {
            const left = ((event.t0 - start) / span) * 100;
            const width = Math.max(((event.t1 - event.t0) / span) * 100, 0.5);
            const size = event.kind === 'fetch' ? fmtBytes(event.byteLength) : `${(event.t1 - event.t0).toFixed(0)} ms`;
            return html`
              <div class="waterfall-row">
                <span class="waterfall-label">${PHASE_LABELS[event.phase] ?? event.phase}</span>
                <div class="waterfall-track">
                  <div
                    class="waterfall-bar"
                    style="left: ${left}%; width: ${width}%; background: ${PHASE_COLORS[event.phase] ?? '#888'}"
                  ></div>
                </div>
                <span class="waterfall-size">${size}</span>
              </div>
            `;
          })}
        </div>
      </div>
    `;
  }
}

customElements.define('viz-waterfall', VizWaterfall);
