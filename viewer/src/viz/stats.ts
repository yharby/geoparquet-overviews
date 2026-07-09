import { LitElement, html, type TemplateResult } from 'lit';
import { onEvent, type FetchPhase } from '../core/events';
import type { FileFacts } from '../data/metadata';

// Everything app-root can only know after a load completes. Live byte and
// request totals are accumulated from the event bus instead, so the meter
// ticks up as requests land.
export interface LoadSummary {
  fileBytes: number;
  rowGroupsTotal: number;
  rowGroupsFetched: number;
  features: number;
  vertices: number;
  metadataMs: number;
  fetchMs: number;
  decodeMs: number;
  uploadMs: number;
  totalMs: number;
  // The source CRS as a short code (e.g. "EPSG:3067" or "lon/lat") and a small
  // qualifier ("native", "reprojected to lon/lat", "unsupported"). Reprojection
  // is a real read-path step for projected files, so it is surfaced here rather
  // than only in the transient status line.
  crs: string;
  crsDetail: string;
  // Per-view read efficiency. column is the geometry column this view read
  // (the overview column or 'geometry'), band is its overview level, and the
  // prune counts split the fetched groups into page-pruned and whole reads.
  column: string;
  band: number | null;
  // The selected band's feature count and the [minZoom, maxZoom] it serves,
  // from the 0.3.0 footer. Null when the file predates the fields or the plan
  // has no band (the flat path). Shown so the thinning payoff is visible, a
  // coarse band can hold a few hundred million features.
  bandFeatureCount: number | null;
  bandMinZoom: number | null;
  bandMaxZoom: number | null;
  pagePrunedGroups: number;
  wholeGroups: number;
}

// Running byte and request totals, kept for the whole file (session) and for
// the current viewport (view) separately, plus a per-phase split so the panel
// can show where the bytes actually went.
interface Totals {
  bytes: number;
  requests: number;
  cacheHits: number;
  perPhase: Map<FetchPhase, { bytes: number; requests: number }>;
}

function emptyTotals(): Totals {
  return { bytes: 0, requests: 0, cacheHits: 0, perPhase: new Map() };
}

function addFetch(t: Totals, phase: FetchPhase, bytes: number): void {
  t.bytes += bytes;
  t.requests += 1;
  const p = t.perPhase.get(phase) ?? { bytes: 0, requests: 0 };
  p.bytes += bytes;
  p.requests += 1;
  t.perPhase.set(phase, p);
}

const PHASE_ORDER: FetchPhase[] = ['footer', 'prefetch', 'metadata', 'page-index', 'row-group-fetch', 'count-fetch'];
const PHASE_LABEL: Record<FetchPhase, string> = {
  footer: 'footer',
  prefetch: 'whole-file prefetch',
  metadata: 'metadata',
  'page-index': 'page index',
  'row-group-fetch': 'row-group fetch',
  'count-fetch': 'density counts',
};

function bytesStr(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 100_000_000 ? 0 : 1)} MB`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)} KB`;
  return `${n} B`;
}

function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

function pctStr(part: number, whole: number): string {
  if (whole <= 0) return '-';
  const pct = (part / whole) * 100;
  return pct < 0.1 && pct > 0 ? '<0.1%' : `${pct.toFixed(1)}%`;
}

export class LoadStats extends LitElement {
  static properties = {
    summary: { attribute: false },
    facts: { attribute: false },
  };

  declare summary: LoadSummary | null;
  declare facts: FileFacts | null;
  private session = emptyTotals();
  private view = emptyTotals();
  private unsubscribe: (() => void) | null = null;

  constructor() {
    super();
    this.summary = null;
    this.facts = null;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.unsubscribe = onEvent((event) => {
      if (event.kind === 'fetch') {
        addFetch(this.session, event.phase, event.byteLength);
        addFetch(this.view, event.phase, event.byteLength);
        this.requestUpdate();
      } else if (event.kind === 'work' && event.phase === 'flatten-cache') {
        // A cache hit paints a row group with zero bytes over the wire, tracked
        // so the panel can show reuse rather than leave it invisible.
        this.session.cacheHits += 1;
        this.view.cacheHits += 1;
        this.requestUpdate();
      }
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscribe?.();
  }

  // Clear the per-view totals. Called before each viewport fetch, so "this view"
  // reflects only the current pan or zoom.
  reset(): void {
    this.view = emptyTotals();
    this.requestUpdate();
  }

  // Clear the whole-file totals too. Called only on a new file load, so the
  // session total spans every pan and zoom of one file, including its one-time
  // footer, metadata, and prefetch reads.
  resetSession(): void {
    this.session = emptyTotals();
    this.view = emptyTotals();
    this.requestUpdate();
  }

  private renderViewSession(): TemplateResult {
    const f = this.facts;
    const sessionBytes = this.session.bytes;
    const avoided = f && f.fileBytes > sessionBytes ? f.fileBytes - sessionBytes : 0;
    return html`
      <div class="meter">
        <div class="cap">Session total over the wire</div>
        <div class="big">${bytesStr(sessionBytes)}</div>
        <div class="sub">
          ${f && f.fileBytes > 0
            ? html`<b>${pctStr(sessionBytes, f.fileBytes)}</b> of the ${bytesStr(f.fileBytes)} file, avoided
                ${bytesStr(avoided)}`
            : 'load a file to measure'}
        </div>
        <div class="bar">
          <span style="width: ${f && f.fileBytes > 0 ? Math.min(Math.max((sessionBytes / f.fileBytes) * 100, sessionBytes > 0 ? 1 : 0), 100) : 0}%"></span>
        </div>
      </div>

      <div class="readouts">
        <div class="ro">
          <div class="k">This view</div>
          <div class="v">${bytesStr(this.view.bytes)} <small>${this.view.requests} req</small></div>
        </div>
        <div class="ro">
          <div class="k">Session requests</div>
          <div class="v">${this.session.requests} <small>${this.view.requests} this view</small></div>
        </div>
      </div>
    `;
  }

  private renderPhases(): TemplateResult | null {
    const rows = PHASE_ORDER.map((phase) => ({ phase, ...(this.session.perPhase.get(phase) ?? { bytes: 0, requests: 0 }) })).filter(
      (r) => r.requests > 0,
    );
    if (rows.length === 0) return null;
    return html`
      <div class="sub-head">Where the bytes went (session)</div>
      <div class="phases">
        ${rows.map(
          (r) => html`
            <div class="phase">
              <span class="phase-k">${PHASE_LABEL[r.phase]}</span>
              <span class="phase-v">${bytesStr(r.bytes)} <small>${r.requests} req</small></span>
            </div>
          `,
        )}
      </div>
    `;
  }

  private renderFacts(): TemplateResult | null {
    const f = this.facts;
    if (!f) return null;
    const bandsStr =
      f.bands.length > 0
        ? f.bands
            .map((b) => (b.isExact ? `L${b.level} exact` : `L${b.level} ≤z${b.maxZoom}`))
            .join('  ')
        : 'no overview pyramid';
    return html`
      <div class="sub-head">File</div>
      <div class="readouts">
        <div class="ro">
          <div class="k">Rows</div>
          <div class="v">${fmtInt(f.totalRows)}</div>
        </div>
        <div class="ro">
          <div class="k">Row groups</div>
          <div class="v">${f.rowGroupCount} <small>median ${bytesStr(f.medianRowGroupBytes)}</small></div>
        </div>
        <div class="ro">
          <div class="k">Compression</div>
          <div class="v">${f.codec} <small>${f.compressionRatio > 0 ? `${f.compressionRatio.toFixed(1)}x` : ''}</small></div>
        </div>
        <div class="ro">
          <div class="k">Levels</div>
          <div class="v" style="font-size: 12px">${bandsStr}</div>
        </div>
        <div class="ro">
          <div class="k">Overview</div>
          <div class="v" style="font-size: 12px">
            ${f.overviewColumn ? html`${f.overviewMethod ?? 'yes'} <small>${f.importance ?? ''}</small>` : 'none'}
          </div>
        </div>
        <div class="ro">
          <div class="k">Indexes</div>
          <div class="v" style="font-size: 12px">
            bbox ${f.hasCovering ? '✓' : '✗'} · page ${f.hasPageIndex ? '✓' : '✗'}
          </div>
        </div>
        <div class="ro">
          <div class="k">Exact geometry</div>
          <div class="v">${bytesStr(f.exactGeometryBytes)} <small>overview ${bytesStr(f.overviewGeometryBytes)}</small></div>
        </div>
        <div class="ro">
          <div class="k">Read mode</div>
          <div class="v" style="font-size: 12px">${f.prefetched ? 'whole-file prefetch' : 'range requests'}</div>
        </div>
      </div>
    `;
  }

  private renderEfficiency(s: LoadSummary): TemplateResult {
    const reading = s.column === 'geometry' || s.column === '' ? 'exact geometry' : `overview (${s.column})`;
    return html`
      <div class="sub-head">This view read</div>
      <div class="readouts">
        <div class="ro">
          <div class="k">Reading</div>
          <div class="v" style="font-size: 12px">
            ${reading}
            ${s.band !== null
              ? html`<small
                  >Level ${s.band}${s.bandMinZoom !== null && s.bandMaxZoom !== null
                    ? ` · z${s.bandMinZoom}-${s.bandMaxZoom}`
                    : ''}</small
                >`
              : ''}
          </div>
        </div>
        ${s.bandFeatureCount !== null
          ? html`<div class="ro">
              <div class="k">Band features</div>
              <div class="v">${fmtInt(s.bandFeatureCount)}</div>
            </div>`
          : ''}
        <div class="ro">
          <div class="k">Row groups</div>
          <div class="v">${s.rowGroupsFetched} <small>/ ${s.rowGroupsTotal} fetched</small></div>
        </div>
        <div class="ro">
          <div class="k">Prune</div>
          <div class="v" style="font-size: 12px">${s.pagePrunedGroups} page · ${s.wholeGroups} whole</div>
        </div>
        <div class="ro">
          <div class="k">Cache hits</div>
          <div class="v">${this.view.cacheHits} <small>groups reused</small></div>
        </div>
        <div class="ro">
          <div class="k">Features drawn</div>
          <div class="v">${fmtInt(s.features)}</div>
        </div>
        <div class="ro">
          <div class="k">Vertices decoded</div>
          <div class="v">${fmtInt(s.vertices)}</div>
        </div>
        <div class="ro">
          <div class="k">Time to paint</div>
          <div class="v">${s.totalMs.toFixed(0)} <small>ms</small></div>
        </div>
        <div class="ro">
          <div class="k">Metadata · fetch</div>
          <div class="v">${s.metadataMs.toFixed(0)} · ${s.fetchMs.toFixed(0)} <small>ms</small></div>
        </div>
        <div class="ro">
          <div class="k">Decode · upload</div>
          <div class="v">${s.decodeMs.toFixed(0)} · ${s.uploadMs.toFixed(0)} <small>ms</small></div>
        </div>
        <div class="ro">
          <div class="k">CRS</div>
          <div class="v">${s.crs} <small>${s.crsDetail}</small></div>
        </div>
      </div>
    `;
  }

  render() {
    const s = this.summary;
    return html`
      <div class="panel stats">
        <div class="panel-head">
          <span class="n">◆</span>
          <h2>Read cost</h2>
          <span class="note">${this.session.requests} HTTP request${this.session.requests === 1 ? '' : 's'}</span>
        </div>
        ${this.renderViewSession()} ${this.renderPhases()} ${this.renderFacts()}
        ${s ? this.renderEfficiency(s) : ''}
      </div>
    `;
  }
}

customElements.define('load-stats', LoadStats);
