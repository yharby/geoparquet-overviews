import { LitElement, html } from 'lit';
import { bboxIntersects, type Bbox } from '../geo/aoi';
import type { GeoParquetMetadata } from '../data/metadata';

type Outcome = 'no-bbox' | 'idle' | 'pruned' | 'fetched';

export class PruningMap extends LitElement {
  static properties = {
    metadata: { attribute: false },
    aoi: { attribute: false },
    fetchedIndices: { attribute: false },
    selectedIndex: { attribute: false },
    hoveredIndex: { attribute: false },
  };

  // `declare` erases these fields at compile time so TypeScript's ES2022
  // class-field emit does not shadow the reactive accessors Lit installs on
  // the prototype for the properties named in `static properties`.
  // Initializing them as normal class fields here throws Lit's
  // class-field-shadowing error at runtime under this project's tsconfig
  // (target ES2022, useDefineForClassFields true) and aborts every render.
  declare metadata: GeoParquetMetadata | null;
  declare aoi: Bbox | null;
  declare fetchedIndices: ReadonlySet<number>;
  declare selectedIndex: number | null;
  declare hoveredIndex: number | null;

  constructor() {
    super();
    this.metadata = null;
    this.aoi = null;
    this.fetchedIndices = new Set();
    this.selectedIndex = null;
    this.hoveredIndex = null;
  }

  createRenderRoot() {
    return this;
  }

  private select(index: number): void {
    this.dispatchEvent(new CustomEvent('rowgroup-select', { detail: { index }, bubbles: true }));
  }

  private hover(index: number | null): void {
    this.dispatchEvent(new CustomEvent('rowgroup-hover', { detail: { index }, bubbles: true }));
  }

  private outcomeFor(index: number, bbox: Bbox | null): Outcome {
    // A truly missing bbox is the only 'no-bbox' case. Before the first fetch
    // settles there is no area yet, so a bbox-carrying group is 'idle', not
    // bbox-less, otherwise a normal file misreports as red during load.
    if (!bbox) return 'no-bbox';
    if (!this.aoi) return 'idle';
    if (!bboxIntersects(bbox, this.aoi)) return 'pruned';
    return this.fetchedIndices.has(index) ? 'fetched' : 'pruned';
  }

  render() {
    if (!this.metadata) {
      return html`<div class="panel">
        <div class="panel-head"><span class="n">◆</span><h2>Row-group pruning</h2></div>
        <div class="empty">No file loaded.</div>
      </div>`;
    }
    const prunedCount = this.metadata.rowGroups.filter((rg) => this.outcomeFor(rg.index, rg.bbox) === 'pruned').length;
    const fetchedCount = this.metadata.rowGroups.filter((rg) => this.outcomeFor(rg.index, rg.bbox) === 'fetched').length;
    const total = this.metadata.rowGroups.length;
    const keptPct = total > 0 ? ((fetchedCount / total) * 100).toFixed(0) : '0';
    return html`
      <div class="panel">
        <div class="panel-head">
          <span class="n">◆</span>
          <h2>Row-group pruning</h2>
          <span class="note">${this.aoi ? `${keptPct}% kept` : 'no view yet'}</span>
        </div>
        <div class="pruning-summary">
          ${this.aoi
            ? html`${fetchedCount} fetched, ${prunedCount} pruned by bbox statistics before any fetch, of ${total} total.`
            : html`Pan or zoom the map to see which row groups the bbox statistics prune.`}
        </div>
        <div class="pruning-grid">
          ${this.metadata.rowGroups.map((rg) => {
            const outcome = this.outcomeFor(rg.index, rg.bbox);
            const mark = rg.index === this.selectedIndex ? ' sel' : rg.index === this.hoveredIndex ? ' hov' : '';
            return html`<div
              class="pruning-cell pruning-${outcome}${mark}"
              title="row group ${rg.index} · ${outcome} — click for detail"
              @click=${() => this.select(rg.index)}
              @mouseenter=${() => this.hover(rg.index)}
              @mouseleave=${() => this.hover(null)}
            ></div>`;
          })}
        </div>
        <div class="legend">
          <span><i style="background: var(--clay)"></i>fetched</span>
          <span><i style="background: #2a3440"></i>pruned</span>
          <span><i style="background: #7a3d3d"></i>no bbox</span>
        </div>
      </div>
    `;
  }
}

customElements.define('pruning-map', PruningMap);
