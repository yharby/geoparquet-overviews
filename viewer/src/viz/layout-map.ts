import { LitElement, html, type PropertyValues } from 'lit';
import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { PolygonLayer, PathLayer, type PathLayerProps } from '@deck.gl/layers';
import { PathStyleExtension, type PathStyleExtensionProps } from '@deck.gl/extensions';
import type { Layer } from '@deck.gl/core';
import { clampGeographicBbox, viewportRing, type Bbox } from '../geo/aoi';
import { BASEMAP_STYLE } from '../map/map-view';
import { fileExtent, type GeoParquetMetadata } from '../data/metadata';

type Rgba = [number, number, number, number];

// Band colors as RGBA, matching the --amber / --index / --clay design tokens.
const BAND_RGB: Record<number, [number, number, number]> = {
  0: [232, 178, 74],
  1: [79, 157, 140],
  2: [216, 97, 60],
};
const SLATE_RGB: [number, number, number] = [58, 71, 86];
const CREAM: Rgba = [239, 233, 219, 230];
const AMBER: Rgba = [232, 178, 74, 255];

// The current view rectangle is drawn as a dashed outline so it reads as an
// overlay against the solid row-group boxes. highPrecisionDash keeps the dash
// even across the rectangle's long unequal edges. One shared instance, deck.gl
// diffs layers by reference so a stable extension avoids needless re-creation.
const DASHED_STROKE = new PathStyleExtension({ dash: true, highPrecisionDash: true });

// Fill alpha per read state: fetched groups are solid, in-flight ones dimmer,
// pruned ones barely there.
const FILL_ALPHA: Record<string, number> = { arrived: 115, pending: 71, pruned: 15 };

// The static per-row-group shape, computed once per metadata object and
// never touched again. Read state (fetched/pending) is looked up live from
// the current props in the color accessors below instead of being baked in
// here, so a batch arriving does not require rebuilding this array.
interface RgGeometry {
  polygon: [number, number][];
  index: number;
  band: number;
}

// A real basemap overview of every row group's covering bbox. The basemap is
// MapLibre, but the row-group boxes are drawn with an interleaved deck.gl
// overlay (SolidPolygon/Polygon), the same rendering path as the main map. This
// avoids MapLibre's GeoJSON tiling worker, which fails in the production bundle.
// Fetched row groups are filled, the main map's live viewport is an outline, and
// hover/selection are linked to the other panels so the same row group lights up
// everywhere. Clicking a box opens its detail modal.
export class LayoutMap extends LitElement {
  static properties = {
    metadata: { attribute: false },
    fetchedIndices: { attribute: false },
    pendingIndices: { attribute: false },
    viewBbox: { attribute: false },
    selectedIndex: { attribute: false },
    hoveredIndex: { attribute: false },
  };

  declare metadata: GeoParquetMetadata | null;
  declare fetchedIndices: ReadonlySet<number>;
  declare pendingIndices: ReadonlySet<number>;
  declare viewBbox: Bbox | null;
  declare selectedIndex: number | null;
  declare hoveredIndex: number | null;

  private map: maplibregl.Map | null = null;
  private overlay: MapboxOverlay | null = null;
  private mapLoaded = false;
  private fittedFor: string | null = null;

  // `buildFeatures` memoization: the geometry array is rebuilt only when the
  // `metadata` object identity changes, not on every syncData call, so it
  // stays a stable `data` reference for deck.gl across fetch/pending/hover
  // updates that do not touch the file's row-group layout.
  private featuresFor: GeoParquetMetadata | null = null;
  private features: RgGeometry[] = [];

  // The three layers, rebuilt independently depending on which props changed
  // (see `syncData`), so e.g. a hover-only update never touches the rg-boxes
  // layer's data or accessors.
  private rgBoxesLayer: Layer | null = null;
  private rgHighlightLayer: Layer | null = null;
  private rgViewportLayer: Layer | null = null;

  constructor() {
    super();
    this.metadata = null;
    this.fetchedIndices = new Set();
    this.pendingIndices = new Set();
    this.viewBbox = null;
    this.selectedIndex = null;
    this.hoveredIndex = null;
  }

  createRenderRoot() {
    return this;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.map?.remove();
    this.map = null;
    this.overlay = null;
    this.mapLoaded = false;
    this.rgBoxesLayer = null;
    this.rgHighlightLayer = null;
    this.rgViewportLayer = null;
  }

  firstUpdated() {
    const container = this.querySelector('.rg-mini') as HTMLElement | null;
    if (!container) return;
    this.map = new maplibregl.Map({
      container,
      style: BASEMAP_STYLE,
      center: [13, 2],
      zoom: 4,
      attributionControl: false,
    });
    // Interleaved deck.gl overlay, drawn inside MapLibre's own WebGL context and
    // camera, so the boxes track the basemap on pan and zoom.
    this.overlay = new MapboxOverlay({ interleaved: true, layers: [] });
    this.map.addControl(this.overlay);
    this.map.on('load', () => {
      this.mapLoaded = true;
      this.syncData(null);
    });
  }

  private emitHover(index: number | null): void {
    this.dispatchEvent(new CustomEvent('rowgroup-hover', { detail: { index }, bubbles: true }));
  }

  updated(changedProperties: PropertyValues) {
    if (this.mapLoaded) this.syncData(changedProperties);
  }

  private buildFeatures(meta: GeoParquetMetadata): RgGeometry[] {
    if (this.featuresFor === meta) return this.features;
    this.features = meta.rowGroups
      .filter((rg) => rg.bbox)
      .map((rg) => ({
        polygon: viewportRing(rg.bbox!),
        index: rg.index,
        band: rg.band ?? -1,
      }));
    this.featuresFor = meta;
    return this.features;
  }

  private stateFor(index: number): 'arrived' | 'pending' | 'pruned' {
    const isPending = this.pendingIndices.has(index);
    const arrived = this.fetchedIndices.has(index) && !isPending;
    return arrived ? 'arrived' : isPending ? 'pending' : 'pruned';
  }

  private fillColorFor = (f: RgGeometry): Rgba => {
    const rgb = f.band >= 0 && BAND_RGB[f.band] ? BAND_RGB[f.band] : SLATE_RGB;
    return [rgb[0], rgb[1], rgb[2], FILL_ALPHA[this.stateFor(f.index)]];
  };

  private lineColorFor = (f: RgGeometry): Rgba => {
    const state = this.stateFor(f.index);
    if (state === 'arrived') return CREAM;
    const rgb = f.band >= 0 && BAND_RGB[f.band] ? BAND_RGB[f.band] : SLATE_RGB;
    return [rgb[0], rgb[1], rgb[2], state === 'pending' ? 180 : 90];
  };

  private lineWidthFor = (f: RgGeometry): number => (this.stateFor(f.index) === 'arrived' ? 1.2 : 0.5);

  // Rebuild only the layer(s) whose inputs changed, called with `null` on the
  // very first sync (right after the map finishes loading) to force all
  // three, and with Lit's `changedProperties` on every later reactive update
  // so an unrelated prop change (e.g. a hover elsewhere touching only
  // selectedIndex) does not re-touch the rg-boxes layer's data or triggers.
  private syncData(changed: PropertyValues | null): void {
    const map = this.map!;
    const overlay = this.overlay!;
    const meta = this.metadata;

    if (!meta) {
      if (this.rgBoxesLayer || this.rgHighlightLayer || this.rgViewportLayer) {
        this.rgBoxesLayer = null;
        this.rgHighlightLayer = null;
        this.rgViewportLayer = null;
        overlay.setProps({ layers: [] });
      }
      return;
    }

    const metaChanged = changed === null || changed.has('metadata');
    const fetchedChanged = changed === null || changed.has('fetchedIndices') || changed.has('pendingIndices');
    const highlightChanged = changed === null || changed.has('selectedIndex') || changed.has('hoveredIndex');
    const viewportChanged = changed === null || changed.has('viewBbox');

    // Gate: a property change that touches none of the three layers (there is
    // no such prop today, but this keeps the contract explicit and cheap) does
    // nothing.
    if (!metaChanged && !fetchedChanged && !highlightChanged && !viewportChanged) return;

    const features = this.buildFeatures(meta);
    let changedAny = false;

    if (metaChanged || fetchedChanged) {
      this.rgBoxesLayer = new PolygonLayer<RgGeometry>({
        id: 'rg-boxes',
        data: features,
        getPolygon: (f) => f.polygon,
        filled: true,
        stroked: true,
        getFillColor: this.fillColorFor,
        getLineColor: this.lineColorFor,
        getLineWidth: this.lineWidthFor,
        lineWidthUnits: 'pixels',
        lineWidthMinPixels: 0.5,
        pickable: true,
        autoHighlight: false,
        onHover: (info) => this.emitHover((info.object as RgGeometry | null)?.index ?? null),
        onClick: (info) => {
          const f = info.object as RgGeometry | null;
          if (f) {
            this.dispatchEvent(
              new CustomEvent('rowgroup-select', { detail: { index: f.index }, bubbles: true }),
            );
          }
        },
        // The `data` array itself never changes shape on a fetch/pending
        // update (only the accessor outputs do), so updateTriggers is what
        // tells deck.gl to re-run the color/width accessors instead of
        // treating the layer as unchanged.
        updateTriggers: {
          getFillColor: [this.fetchedIndices, this.pendingIndices],
          getLineColor: [this.fetchedIndices, this.pendingIndices],
          getLineWidth: [this.fetchedIndices, this.pendingIndices],
        },
      });
      changedAny = true;
    }

    if (metaChanged || highlightChanged) {
      const highlight = new Set(
        [this.selectedIndex, this.hoveredIndex].filter((i): i is number => i !== null),
      );
      const highlighted = features.filter((f) => highlight.has(f.index));
      this.rgHighlightLayer = new PolygonLayer<RgGeometry>({
        id: 'rg-highlight',
        data: highlighted,
        getPolygon: (f) => f.polygon,
        filled: false,
        stroked: true,
        getLineColor: AMBER,
        getLineWidth: 2.4,
        lineWidthUnits: 'pixels',
        lineWidthMinPixels: 1.5,
        pickable: false,
      });
      map.getCanvas().style.cursor = highlight.size ? 'pointer' : '';
      changedAny = true;
    }

    if (viewportChanged) {
      type ViewDatum = { path: [number, number][] };
      // Extension props (getDashArray, dashJustified) are not part of the base
      // PathLayer prop type, so declare the intersection to satisfy the excess
      // property check on the literal.
      const viewportProps: PathLayerProps<ViewDatum> & PathStyleExtensionProps<ViewDatum> = {
        id: 'rg-viewport',
        data: this.viewBbox ? [{ path: viewportRing(this.viewBbox) }] : [],
        getPath: (d) => d.path,
        getColor: AMBER,
        getWidth: 1.6,
        widthUnits: 'pixels',
        widthMinPixels: 1,
        getDashArray: [6, 4],
        dashJustified: true,
        extensions: [DASHED_STROKE],
      };
      this.rgViewportLayer = new PathLayer<ViewDatum>(viewportProps);
      changedAny = true;
    }

    if (changedAny) {
      const layers: Layer[] = [this.rgBoxesLayer, this.rgHighlightLayer, this.rgViewportLayer].filter(
        (layer): layer is Layer => layer !== null,
      );
      overlay.setProps({ layers });
    }

    // Fit the overview to the file extent once per loaded file.
    const key = `${meta.rowGroups.length}:${meta.totalRows}`;
    if (this.fittedFor !== key) {
      const ext = fileExtent(meta.rowGroups);
      if (ext) {
        const b = clampGeographicBbox(ext);
        map.fitBounds(
          [
            [b.xmin, b.ymin],
            [b.xmax, b.ymax],
          ],
          { padding: 16, duration: 0 },
        );
        this.fittedFor = key;
      }
    }
  }

  render() {
    const hasBands = this.metadata?.overviewsInfo != null;
    const fetched = this.fetchedIndices.size;
    const total = this.metadata?.rowGroups.length ?? 0;
    return html`
      <div class="panel">
        <div class="panel-head">
          <span class="n">◆</span>
          <h2>Row-group map</h2>
          <span class="note">${this.metadata ? `${fetched}/${total} fetched` : ''}</span>
        </div>
        <div class="heatmap-summary">
          Every row group's covering bbox on the basemap. The dashed amber box is the main map's current view.
          Hover to link, click for detail.
        </div>
        <div class="rg-mini"></div>
        <div class="legend">
          ${hasBands
            ? html`<span><i style="background: #E8B24A"></i>Level 0</span>
                <span><i style="background: #4F9D8C"></i>Level 1</span>
                <span><i style="background: #D8613C"></i>Level 2</span>`
            : html`<span><i style="background: #3a4756"></i>row group</span>`}
          <span><i style="background: transparent; border: 1px dashed #E8B24A"></i>view</span>
        </div>
      </div>
    `;
  }
}

customElements.define('layout-map', LayoutMap);
