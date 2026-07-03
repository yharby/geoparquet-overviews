import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { Layer } from '@deck.gl/core';
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
    this.overlay = new MapboxOverlay({ interleaved: true, layers: [] });
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

  getZoom(): number {
    return this.map.getZoom();
  }

  setZoom(zoom: number): void {
    this.map.easeTo({ zoom, duration: 300 });
  }

  // Subscribe to the end of a zoom gesture. Returns an unsubscribe function.
  onZoomEnd(cb: () => void): () => void {
    this.map.on('zoomend', cb);
    return () => this.map.off('zoomend', cb);
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
    this.map.remove();
  }
}
