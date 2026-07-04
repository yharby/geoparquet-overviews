import { LitElement, html, svg, type TemplateResult } from 'lit';
import { bboxIntersects, type Bbox } from '../geo/aoi';
import { columnChunkBytes, fileExtent, type GeoParquetMetadata, type OverviewLevel } from '../data/metadata';

type Outcome = 'fetched' | 'pruned' | 'no-bbox';

// Mirrors the per-band palette in layout-map, so a band's color means the same
// thing in the map and in this popup. Groups outside the pyramid fall back to
// the slate used for flat files there.
const BAND_HEX = ['#e8b24a', '#4f9d8c', '#d8613c'];
const SLATE_HEX = '#3a4756';
const bandColor = (band: number | null): string =>
  band !== null && band >= 0 && band < BAND_HEX.length ? BAND_HEX[band] : SLATE_HEX;

// What one band means for reading: whether it is the finest exact band or a
// coarse overview band, and which geometry column a view at this band reads.
interface BandRole {
  level: OverviewLevel;
  isExact: boolean;
  column: string;
}

function bytesStr(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)} KB`;
  return `${n} B`;
}

// gsd is the overview grid step in the file's own CRS units, so it spans metres
// for a projected file and degrees for lon/lat. Show enough precision for the
// small degree values without a wall of zeros.
function fmtGsd(gsd: number): string {
  if (gsd >= 1) return gsd.toFixed(1);
  return gsd.toPrecision(2);
}

// Modal that shows one row group's full detail plus a footprint map placing its
// covering bbox within the whole file's extent (and the current AOI). Opened by
// clicking a cell in the pruning grid or a segment in the file-layout bar.
export class RowGroupDetail extends LitElement {
  static properties = {
    metadata: { attribute: false },
    index: { attribute: false },
    aoi: { attribute: false },
    fetchedIndices: { attribute: false },
  };

  declare metadata: GeoParquetMetadata | null;
  declare index: number | null;
  declare aoi: Bbox | null;
  declare fetchedIndices: ReadonlySet<number>;

  constructor() {
    super();
    this.metadata = null;
    this.index = null;
    this.aoi = null;
    this.fetchedIndices = new Set();
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('keydown', this.onKey);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.onKey);
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.index !== null) this.close();
  };

  private close() {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true }));
  }

  private outcomeFor(bbox: Bbox | null): Outcome {
    if (!bbox) return 'no-bbox';
    if (this.aoi && this.fetchedIndices.has(this.index as number) && bboxIntersects(bbox, this.aoi)) return 'fetched';
    return 'pruned';
  }

  // Resolve the band this row group belongs to into its reading role. The file is
  // written band-major, so the finest (last) level is the exact band that reads
  // `geometry`; every coarser level reads the simplified overview column. Returns
  // null for flat files with no overview pyramid.
  private bandRole(band: number | null): BandRole | null {
    const info = this.metadata?.overviewsInfo;
    if (!info || band === null) return null;
    const level = info.levels.find((l) => l.level === band);
    if (!level) return null;
    const finest = info.levels[info.levels.length - 1];
    const isExact = level.level === finest.level;
    return { level, isExact, column: isExact ? 'geometry' : info.overviewColumn ?? 'geom_overview' };
  }

  render() {
    if (this.index === null || !this.metadata) return html``;
    const rg = this.metadata.rowGroups[this.index];
    if (!rg) return html``;

    const totalBytes = this.metadata.rowGroups.reduce((s, r) => s + r.totalByteSize, 0);
    const totalRows = this.metadata.totalRows || this.metadata.rowGroups.reduce((s, r) => s + r.rowCount, 0);
    const outcome = this.outcomeFor(rg.bbox);
    const bytePct = totalBytes > 0 ? (rg.totalByteSize / totalBytes) * 100 : 0;
    const rowPct = totalRows > 0 ? (rg.rowCount / totalRows) * 100 : 0;
    const label = { fetched: 'fetched', pruned: 'pruned by bbox', 'no-bbox': 'no covering bbox' }[outcome];

    return html`
      <div class="modal-backdrop" @click=${this.close}>
        <div class="modal" @click=${(e: Event) => e.stopPropagation()}>
          <div class="modal-head">
            <div>
              <p class="eyebrow"><span class="dot"></span> row group</p>
              <h2>#${rg.index}</h2>
            </div>
            <span class="badge badge-${outcome}">${label}</span>
            <button class="modal-close" @click=${this.close} aria-label="Close">✕</button>
          </div>

          <div class="modal-body">
            <div class="modal-map">${this.renderFootprint(rg.bbox)}</div>
            <div class="modal-facts">
              ${this.renderBand(rg.band)}
              <div class="readouts">
                <div class="ro">
                  <div class="k">Rows</div>
                  <div class="v">${rg.rowCount.toLocaleString('en-US')} <small>${rowPct.toFixed(1)}%</small></div>
                </div>
                <div class="ro">
                  <div class="k">Size on disk</div>
                  <div class="v">${(rg.totalByteSize / 1_000_000).toFixed(1)} <small>MB · ${bytePct.toFixed(1)}%</small></div>
                </div>
              </div>
              ${rg.bbox
                ? html`<div class="bbox-grid">
                    <div><span class="k">xmin</span><b>${rg.bbox.xmin.toFixed(4)}</b></div>
                    <div><span class="k">ymin</span><b>${rg.bbox.ymin.toFixed(4)}</b></div>
                    <div><span class="k">xmax</span><b>${rg.bbox.xmax.toFixed(4)}</b></div>
                    <div><span class="k">ymax</span><b>${rg.bbox.ymax.toFixed(4)}</b></div>
                  </div>`
                : html`<div class="empty">This row group exposes no covering bbox, so it cannot be pruned by geometry and is always a fetch candidate.</div>`}
            </div>
          </div>
          <div class="legend">
            <span><i style="background: var(--clay)"></i>this row group</span>
            <span><i style="background: #3a4756"></i>other row groups</span>
            ${this.aoi ? html`<span><i style="background: transparent; border: 1px dashed var(--amber)"></i>view</span>` : ''}
          </div>
        </div>
      </div>
    `;
  }

  // The band block: what band this group is in, what a view at that band reads,
  // a strip placing it in the whole pyramid, and the geometry bytes this group's
  // read column actually costs.
  private renderBand(band: number | null): TemplateResult {
    const meta = this.metadata;
    if (!meta) return html``;
    const role = this.bandRole(band);
    if (!role) {
      // Flat file with no overview pyramid. There is only exact geometry to read.
      const bytes = columnChunkBytes(meta, this.index as number, 'geometry');
      return html`
        <div class="band-block">
          <div class="band-line">
            <span class="band-chip" style="background: ${SLATE_HEX}"></span>
            <span class="band-role"><b>No overview pyramid</b> · reads exact <code>geometry</code></span>
          </div>
          ${bytes !== null ? html`<div class="band-note">geometry in this group ${bytesStr(bytes)}</div>` : ''}
        </div>
      `;
    }

    const info = meta.overviewsInfo;
    const bytes = columnChunkBytes(meta, this.index as number, role.column);
    const detail = role.isExact
      ? 'full precision, no simplification'
      : `shown up to zoom ${role.level.maxZoom}${role.level.gsd > 0 ? ` · gsd ${fmtGsd(role.level.gsd)}` : ''}`;
    return html`
      <div class="band-block">
        <div class="band-line">
          <span class="band-chip" style="background: ${bandColor(band)}"></span>
          <span class="band-role">
            <b>Level ${band} · ${role.isExact ? 'exact' : 'overview'}</b> · reads <code>${role.column}</code>
          </span>
        </div>
        <div class="band-note">${detail}${bytes !== null ? ` · ${role.isExact ? 'geometry' : 'overview'} in this group ${bytesStr(bytes)}` : ''}</div>
        ${info
          ? html`<div class="band-strip">
              ${info.levels.map((l, i, all) => {
                const isExact = i === all.length - 1;
                return html`<span class="band-tick ${l.level === band ? 'on' : ''}">
                  <span class="band-chip" style="background: ${bandColor(l.level)}"></span>
                  L${l.level} ${isExact ? 'exact' : `≤z${l.maxZoom}`}
                </span>`;
              })}
            </div>`
          : ''}
      </div>
    `;
  }

  private renderFootprint(bbox: Bbox | null) {
    const ext = this.metadata ? fileExtent(this.metadata.rowGroups) : null;
    if (!ext || !this.metadata) return html`<div class="empty">No spatial extent available.</div>`;
    const W = 300;
    const H = 220;
    const pad = 12;
    const spanX = ext.xmax - ext.xmin || 1;
    const spanY = ext.ymax - ext.ymin || 1;
    const sx = (lon: number) => pad + ((lon - ext.xmin) / spanX) * (W - 2 * pad);
    const sy = (lat: number) => pad + ((ext.ymax - lat) / spanY) * (H - 2 * pad);
    const rect = (b: Bbox) => ({ x: sx(b.xmin), y: sy(b.ymax), w: sx(b.xmax) - sx(b.xmin), h: sy(b.ymin) - sy(b.ymax) });

    return html`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Row group footprint">
      ${this.metadata.rowGroups.map((r) => {
        if (!r.bbox || r.index === this.index) return null;
        const p = rect(r.bbox);
        return svg`<rect x=${p.x.toFixed(1)} y=${p.y.toFixed(1)} width=${Math.max(p.w, 1).toFixed(1)} height=${Math.max(p.h, 1).toFixed(1)} fill="#3a4756" fill-opacity="0.28" />`;
      })}
      ${this.aoi
        ? (() => {
            const p = rect(this.aoi);
            return svg`<rect x=${p.x.toFixed(1)} y=${p.y.toFixed(1)} width=${Math.max(p.w, 1).toFixed(1)} height=${Math.max(p.h, 1).toFixed(1)} fill="none" stroke="var(--amber)" stroke-width="1.4" stroke-dasharray="4 3" />`;
          })()
        : null}
      ${bbox
        ? (() => {
            const p = rect(bbox);
            return svg`<rect x=${p.x.toFixed(1)} y=${p.y.toFixed(1)} width=${Math.max(p.w, 2).toFixed(1)} height=${Math.max(p.h, 2).toFixed(1)} fill="var(--clay-soft)" stroke="var(--clay)" stroke-width="1.8" />`;
          })()
        : null}
    </svg>`;
  }
}

customElements.define('row-group-detail', RowGroupDetail);
