import { LitElement, html } from 'lit';
import { onEvent, type FetchEvent } from '../core/events';
import type { GeoParquetMetadata } from '../data/metadata';

export class LayoutHeatmap extends LitElement {
  static properties = {
    metadata: { attribute: false },
    fetchedIndices: { attribute: false },
    selectedIndex: { attribute: false },
    hoveredIndex: { attribute: false },
  };

  // `declare` erases these fields at compile time so TypeScript's ES2022
  // class-field emit does not shadow the reactive accessors Lit installs on
  // the prototype for properties named in `static properties`. Initializing
  // `metadata = null` as a normal class field here throws Lit's
  // class-field-shadowing error at runtime under this project's tsconfig
  // (target ES2022, useDefineForClassFields true) and aborts every render.
  declare metadata: GeoParquetMetadata | null;
  declare fetchedIndices: ReadonlySet<number>;
  declare selectedIndex: number | null;
  declare hoveredIndex: number | null;
  private fetchedRanges: FetchEvent[] = [];
  private unsubscribe: (() => void) | null = null;
  // Coalesce arriving row-group-fetch events into at most one requestUpdate
  // per animation frame, mirroring app-root.ts's scheduleVizFlush/
  // flushVizNow pair: a burst of events landing within one frame collapses
  // into a single render instead of one per event. Data (`fetchedRanges`) is
  // still mutated synchronously on every event, only the render is deferred,
  // so the eventual flush always reflects every event received, none lost.
  private updateHandle: ReturnType<typeof requestAnimationFrame> | null = null;

  constructor() {
    super();
    this.metadata = null;
    this.fetchedIndices = new Set();
    this.selectedIndex = null;
    this.hoveredIndex = null;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.unsubscribe = onEvent((event) => {
      if (event.kind === 'fetch' && event.phase === 'row-group-fetch') {
        this.fetchedRanges = [...this.fetchedRanges, event];
        this.scheduleRenderFlush();
      }
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
    this.fetchedRanges = [];
    this.requestUpdate();
  }

  private select(index: number): void {
    this.dispatchEvent(new CustomEvent('rowgroup-select', { detail: { index }, bubbles: true }));
  }

  private hover(index: number | null): void {
    this.dispatchEvent(new CustomEvent('rowgroup-hover', { detail: { index }, bubbles: true }));
  }

  render() {
    if (!this.metadata) {
      return html`<div class="panel">
        <div class="panel-head"><span class="n">◆</span><h2>File layout</h2></div>
        <div class="empty">No file loaded.</div>
      </div>`;
    }
    const totalBytes = this.metadata.rowGroups.reduce((sum, rg) => sum + rg.totalByteSize, 0);
    const fetchedBytes = this.fetchedRanges.reduce((sum, e) => sum + e.byteLength, 0);
    return html`
      <div class="panel">
        <div class="panel-head">
          <span class="n">◆</span>
          <h2>File layout</h2>
          <span class="note">${this.metadata.rowGroups.length} row groups</span>
        </div>
        <div class="heatmap-summary">
          Fetched ${(fetchedBytes / 1_000_000).toFixed(1)} MB of ${(totalBytes / 1_000_000).toFixed(1)} MB on disk.
          Each segment is one row group, sized by its bytes.
        </div>
        <div class="heatmap-bar">
          ${this.metadata.rowGroups.map((rg) => {
            const width = totalBytes > 0 ? (rg.totalByteSize / totalBytes) * 100 : 0;
            const wasFetched = this.fetchedIndices.has(rg.index);
            const mark = rg.index === this.selectedIndex ? ' sel' : rg.index === this.hoveredIndex ? ' hov' : '';
            return html`<div
              class="heatmap-segment ${wasFetched ? 'fetched' : 'unfetched'}${mark}"
              style="width: ${width}%"
              title="row group ${rg.index}, ${(rg.totalByteSize / 1_000_000).toFixed(2)} MB — click for detail"
              @click=${() => this.select(rg.index)}
              @mouseenter=${() => this.hover(rg.index)}
              @mouseleave=${() => this.hover(null)}
            ></div>`;
          })}
        </div>
        <div class="legend">
          <span><i style="background: var(--clay)"></i>fetched</span>
          <span><i style="background: #2a3440"></i>not fetched</span>
        </div>
      </div>
    `;
  }
}

customElements.define('layout-heatmap', LayoutHeatmap);
