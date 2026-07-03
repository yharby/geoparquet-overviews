import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { Layer, PickingInfo } from '@deck.gl/core';
import type { Bbox } from '../geo/aoi';

// Dark basemap. The one external style the viewer loads, for context
// under the polygons a range request pulls.
export const BASEMAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

export class MapView {
  private map: maplibregl.Map;
  private overlay: MapboxOverlay;
  private styleLoaded = false;
  private layers: Layer[] = [];
  private hasPending = false;
  // Called on a deck.gl click over a pickable layer. The app installs it to
  // resolve the picked primitive to a parquet row and open the attribute popup.
  private pickHandler: ((info: PickingInfo) => void) | null = null;
  // The single feature popup, reused across clicks. MapLibre owns it so it pans
  // and zooms with the map. Null when none is open.
  private popup: maplibregl.Popup | null = null;

  constructor(container: HTMLElement) {
    this.map = new maplibregl.Map({
      container,
      style: BASEMAP_STYLE,
      center: [13, 2],
      zoom: 6,
    });
    // Interleaved rendering draws the deck.gl layers inside MapLibre's own
    // WebGL context and camera, so there is no second viewport that can drift
    // out of sync on pan/zoom. This is the fix for polygons appearing shifted
    // and not tracking the basemap that the previous non-interleaved overlay
    // produced against MapLibre v5. Interleaved layers can only be set after
    // the style has loaded, so anything requested earlier is queued.
    this.overlay = new MapboxOverlay({
      interleaved: true,
      layers: [],
      // Deck-level picking: fires for any pickable layer (the geometry fills,
      // lines, and points), and on an empty click so the app can dismiss the
      // popup. getCursor lets deck.gl own the canvas cursor so it does not fight
      // MapLibre's own per-move cursor writes (which caused a hover flicker when
      // we mutated canvas.style.cursor directly). deck reports isHovering over
      // any pickable feature and isDragging while panning.
      onClick: (info) => this.pickHandler?.(info),
      getCursor: ({ isDragging, isHovering }) =>
        isDragging ? 'grabbing' : isHovering ? 'pointer' : 'grab',
    });
    this.map.addControl(this.overlay);
    this.map.on('load', () => {
      this.styleLoaded = true;
      if (this.hasPending) {
        this.overlay.setProps({ layers: this.layers });
        this.hasPending = false;
      }
    });
  }

  private applyLayers(): void {
    if (this.styleLoaded) {
      this.overlay.setProps({ layers: this.layers });
    } else {
      this.hasPending = true;
    }
  }

  // Replace the whole layer set (used for the single-shot compare view and to
  // clear on load).
  setLayers(layers: Layer[]): void {
    this.layers = layers;
    this.applyLayers();
  }

  // Append layers, keeping what is already on screen. Progressive rendering
  // paints each batch as its own layer so earlier batches stay visible.
  addLayers(layers: Layer[]): void {
    this.layers = [...this.layers, ...layers];
    this.applyLayers();
  }

  clearLayers(): void {
    this.layers = [];
    this.applyLayers();
  }

  // Register the handler for a click on a pickable geometry layer.
  setPickHandler(handler: (info: PickingInfo) => void): void {
    this.pickHandler = handler;
  }

  // Open the feature popup at a lon/lat with the given HTML body, building a fresh
  // popup each time. Reusing one popup across clicks does not work: calling addTo
  // on an already-open MapLibre popup fires an internal close (which nulls the
  // reference below) and can leave an orphaned node, so a later setFeaturePopupHtml
  // targets a detached popup and the body stays stuck on "loading". A fresh popup
  // per click keeps setFeaturePopupHtml pointed at the one on screen; the caller's
  // pick token still guarantees only the latest click's read writes into it.
  openFeaturePopup(lngLat: [number, number], html: string): void {
    this.closeFeaturePopup();
    const popup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      maxWidth: '340px',
      className: 'feature-popup-shell',
    });
    // Clear the reference only if this same popup is still the current one, so the
    // previous popup's own close (fired by closeFeaturePopup on the next click)
    // cannot null out the fresh popup that has already replaced it.
    popup.on('close', () => {
      if (this.popup === popup) this.popup = null;
    });
    this.popup = popup;
    popup.setLngLat(lngLat).setHTML(html).addTo(this.map);
  }

  // Replace the open popup's body, e.g. once the async attribute read resolves.
  // A no-op if the popup was dismissed while the read was in flight.
  setFeaturePopupHtml(html: string): void {
    this.popup?.setHTML(html);
  }

  // Dismiss the feature popup if one is open.
  closeFeaturePopup(): void {
    this.popup?.remove();
    this.popup = null;
  }

  getZoom(): number {
    return this.map.getZoom();
  }

  setZoom(zoom: number): void {
    this.map.easeTo({ zoom, duration: 300 });
  }

  // Subscribe to any camera move end (pan or zoom), used to keep the overview
  // mini-map's viewport rectangle in sync with this map. Returns unsubscribe.
  onMoveEnd(cb: () => void): () => void {
    this.map.on('moveend', cb);
    return () => this.map.off('moveend', cb);
  }

  flyToBbox(bbox: Bbox): void {
    this.map.fitBounds(
      [
        [bbox.xmin, bbox.ymin],
        [bbox.xmax, bbox.ymax],
      ],
      { padding: 40, duration: 600 },
    );
  }

  // The current visible extent, used as the area to fetch for the map view.
  getBounds(): Bbox {
    const b = this.map.getBounds();
    return { xmin: b.getWest(), ymin: b.getSouth(), xmax: b.getEast(), ymax: b.getNorth() };
  }

  // Tear down the MapLibre map and its WebGL context. Call on disconnect so the
  // main map does not leak, matching the layout mini-map's cleanup.
  destroy(): void {
    this.popup?.remove();
    this.popup = null;
    this.map.remove();
  }
}
