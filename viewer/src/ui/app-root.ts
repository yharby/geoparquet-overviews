import { LitElement, html } from 'lit';
import './load-control';
import '../viz/layout-heatmap';
import '../viz/layout-map';
import '../viz/waterfall';
import '../viz/pruning-map';
import '../viz/stats';
import '../viz/row-group-detail';
import type { FileLoadRequest } from './load-control';
import { installFetchInstrumentation, setActiveUrl, timeWork, withPhase } from '../core/phase';
import { emitEvent } from '../core/events';
import type { Bbox } from '../geo/aoi';
import {
  loadMetadataFromUrl,
  fileExtent,
  schemaLookup,
  attributeColumns,
  hasRenderableGeometry,
  computeFileFacts,
  type GeoParquetMetadata,
  type FileFacts,
} from '../data/metadata';
import { readColumnProgressive, getFileForUrl, type RowGroupRange } from '../data/rowgroups';
import type { SchemaElement } from 'hyparquet';
import { readRowAttributes } from '../data/feature-detail';
import { featureLoadingHtml, featureAttributesHtml, featureErrorHtml } from './feature-popup';
import type { Layer, PickingInfo } from '@deck.gl/core';
import { pageRangesForRowGroup, mergePageRanges, keptPageRanges, type PageRange } from '../data/pageindex';
import { getPageRangeMemo, getFlatCache, isFilePrefetched } from '../data/file-cache';
import { detectLayout, type LayoutStrategy } from '../data/layout';
import { viewFetchKey } from './fetch-key';
import { planSignature } from '../data/plan-signature';
import { initialUrl, initialView, type CameraView } from '../data/presets';
import { MapView } from '../map/map-view';
import { buildLayers } from '../map/polygon-layer';
import { vertexCount, mergeFlatGeometries, type FlatGeometries } from '../geo/geojson';
import type { LayoutHeatmap } from '../viz/layout-heatmap';
import type { VizWaterfall } from '../viz/waterfall';
import type { LoadStats, LoadSummary } from '../viz/stats';

installFetchInstrumentation();

// Below this many batches the per-batch layers already on screen are few enough
// that collapsing them into one merged layer set is not worth re-allocating and
// re-uploading every coordinate a second time. Above it, the draw-call and
// layer-diff overhead of many batch layers wins, so the merge pays for itself.
// Tunable, pinned empirically against the hosted datasets.
const MERGE_LAYER_THRESHOLD = 8;

export class AppRoot extends LitElement {
  static properties = {
    status: { state: true },
    statusErr: { state: true },
    metadata: { state: true },
    aoiBbox: { state: true },
    fetchedIndices: { state: true },
    busy: { state: true },
    summary: { state: true },
    fileFacts: { state: true },
    selectedIndex: { state: true },
    currentZoom: { state: true },
    pendingIndices: { state: true },
    viewBbox: { state: true },
    hoveredIndex: { state: true },
    loading: { state: true },
  };

  // `declare` erases these fields at compile time so TypeScript's ES2022
  // class-field emit does not shadow the reactive accessors Lit installs on
  // the prototype for the properties named in `static properties`.
  // Initializing them as normal class fields throws Lit's class-field-
  // shadowing error at runtime under this project's tsconfig, so they are
  // assigned in the constructor instead.
  declare status: string;
  declare statusErr: boolean;
  declare metadata: GeoParquetMetadata | null;
  declare aoiBbox: Bbox | null;
  declare fetchedIndices: ReadonlySet<number>;
  declare busy: boolean;
  declare summary: LoadSummary | null;
  declare fileFacts: FileFacts | null;
  declare selectedIndex: number | null;
  declare currentZoom: number;
  declare pendingIndices: ReadonlySet<number>;
  declare viewBbox: Bbox | null;
  declare hoveredIndex: number | null;
  declare loading: boolean;
  private mapView: MapView | null = null;
  private currentUrl: string | null = null;
  private metadataMs = 0;
  private fileBytes = 0;
  private moveUnsub: (() => void) | null = null;
  // Mutable source of truth for in-flight pending row groups. `pendingIndices`
  // (the reactive, Set-typed prop every side panel reads) is only refreshed
  // from this by `flushVizNow`/`scheduleVizFlush`, so a burst of per-batch
  // arrivals coalesces into at most one reactive update per animation frame
  // instead of one Lit re-render (of every panel) per row group.
  private pendingWorking: Set<number> = new Set();
  private vizFlushHandle: ReturnType<typeof requestAnimationFrame> | null = null;
  // Coalesce bursts of moveend (e.g. a zoom that settles then an immediate pan)
  // into a single read, so fast camera moves do not each kick off a fetch.
  private fetchTimer: ReturnType<typeof setTimeout> | null = null;
  // Each fetch carries this token. A newer fetch bumps it and starts right
  // away, superseding any fetch still in flight, so a pan mid-read cancels
  // the stale read at the next row-group boundary and never paints stale
  // results.
  private fetchToken = 0;
  // Bumped on every loadUrl so a load in flight for a superseded file does not
  // reset shared state (busy, the active URL) under a newer load.
  private loadToken = 0;
  // Dedupe key of the last view fetched, so an idle moveend (no real camera
  // change) does not refetch the identical bbox and band.
  private lastFetchKey: string | null = null;
  private strategy: LayoutStrategy | null = null;
  // File-invariant scratch, recomputed once per loadUrl and reused on every pan
  // so the per-fetch path does not rebuild them. rowOffsets[i] is the absolute
  // first row of row group i.
  private rowOffsets: number[] = [];
  private schemaLookupCache: Map<string, SchemaElement> | null = null;
  // Signature and url of the plan currently painted on screen. A fetch that
  // resolves to the same signature leaves the layers untouched.
  private renderedPlanSig: string | null = null;
  private renderedUrl: string | null = null;
  // Built merged layer sets keyed by plan signature, together with the merged
  // buckets they were built from, so a recurring large view reuses the same
  // Layer objects by reference (deck.gl skips the GPU re-upload) and resolves
  // picks against the same merged buckets those layers were built from.
  // Bounded, dropped on file switch.
  private mergedLayerCache = new Map<string, { layers: Layer[]; merged: FlatGeometries }>();
  // The flattened buckets currently on the map, keyed by the layer-set id prefix
  // (`rg-batch-N` during progressive load, `rg-merged` once settled). A click
  // resolves `info.layer.id` to a prefix and a geometry kind, then reads the
  // matching bucket's rowIds at `info.index` to recover the source parquet row.
  private pickFlats = new Map<string, FlatGeometries>();
  // The file's non-geometry attribute columns, read once per load, fetched for a
  // clicked feature's popup.
  private attrColumns: string[] = [];
  // Supersedes an in-flight attribute read when a newer feature is clicked, so a
  // slow read never overwrites a newer popup.
  private pickToken = 0;
  // A deep-linked camera from the x/y/z query parameters, applied once on the
  // first file open instead of the default extent fit, then cleared so later
  // file switches fit to their own extent.
  private pendingInitialView: CameraView | null = null;

  constructor() {
    super();
    this.status = 'Load a file to begin.';
    this.statusErr = false;
    this.metadata = null;
    this.aoiBbox = null;
    this.fetchedIndices = new Set();
    this.busy = false;
    this.summary = null;
    this.fileFacts = null;
    this.selectedIndex = null;
    this.currentZoom = 6;
    this.pendingIndices = new Set();
    this.viewBbox = null;
    this.hoveredIndex = null;
    this.loading = false;
  }

  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <div class="app-shell">
        ${this.renderInspectTab()}
      </div>
    `;
  }

  private renderInspectTab() {
    return html`
      <load-control .busy=${this.busy} @file-load=${this.onFileLoad}></load-control>
      <div class="dashboard" @rowgroup-select=${this.onRowGroupSelect} @rowgroup-hover=${this.onRowGroupHover}>
        <div class="map-stage">
          <div class="map-frame">
            <div class="map-container"></div>
            ${this.loading || this.busy
              ? html`<div class="map-loading" role="status" aria-label="Loading">
                  <span class="spinner"></span>
                  <span class="map-loading-text">loading</span>
                </div>`
              : ''}
            <div class="map-toolbar">
              <span class="tb-label">view</span>
              <span class="tb-note">pan or zoom to fetch</span>
              ${this.strategy?.hasZoomLevels ? this.renderZoomControl() : ''}
            </div>
          </div>
          <div class="status ${this.statusErr ? 'err' : ''}">${this.status}</div>
        </div>
        <div class="side-panels">
          <load-stats .summary=${this.summary} .facts=${this.fileFacts}></load-stats>
          <layout-map
            .metadata=${this.metadata}
            .fetchedIndices=${this.fetchedIndices}
            .pendingIndices=${this.pendingIndices}
            .viewBbox=${this.viewBbox}
            .selectedIndex=${this.selectedIndex}
            .hoveredIndex=${this.hoveredIndex}
          ></layout-map>
          <pruning-map
            .metadata=${this.metadata}
            .aoi=${this.aoiBbox}
            .fetchedIndices=${this.fetchedIndices}
            .selectedIndex=${this.selectedIndex}
            .hoveredIndex=${this.hoveredIndex}
          ></pruning-map>
          <layout-heatmap
            .metadata=${this.metadata}
            .fetchedIndices=${this.fetchedIndices}
            .selectedIndex=${this.selectedIndex}
            .hoveredIndex=${this.hoveredIndex}
          ></layout-heatmap>
          <viz-waterfall></viz-waterfall>
        </div>
      </div>
      <row-group-detail
        .metadata=${this.metadata}
        .index=${this.selectedIndex}
        .aoi=${this.aoiBbox}
        .fetchedIndices=${this.fetchedIndices}
        @close=${() => (this.selectedIndex = null)}
      ></row-group-detail>
    `;
  }

  private onRowGroupSelect(event: CustomEvent<{ index: number }>) {
    this.selectedIndex = event.detail.index;
  }

  firstUpdated() {
    this.ensureMap();
    // A deep-linked camera in x/y/z is captured before the first load so it can
    // override the default extent fit once the file's metadata is in.
    this.pendingInitialView = initialView();
    // Open on the `url` query parameter when present, else the default preset,
    // so the read path is traced immediately with no manual load step. The user
    // can still switch files with the control.
    if (this.mapView) void this.loadUrl(initialUrl());
  }

  updated() {
    this.ensureMap();
  }

  private ensureMap() {
    if (this.mapView) return;
    const container = this.querySelector('.map-container') as HTMLElement | null;
    if (container) {
      this.mapView = new MapView(container);
      this.mapView.setPickHandler(this.onFeaturePick);
      this.currentZoom = this.mapView.getZoom();
      this.viewBbox = this.mapView.getBounds();
      // The map view is the area. Every settled pan or zoom updates the mini
      // map's viewport box and fetches whatever is now on screen at the band
      // the zoom selects, like a slippy tile client.
      this.moveUnsub = this.mapView.onMoveEnd(this.onMapMove);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.moveUnsub?.();
    this.moveUnsub = null;
    if (this.fetchTimer !== null) {
      clearTimeout(this.fetchTimer);
      this.fetchTimer = null;
    }
    if (this.vizFlushHandle !== null) {
      cancelAnimationFrame(this.vizFlushHandle);
      this.vizFlushHandle = null;
    }
    // Tear down the main map and its WebGL context, otherwise it leaks on
    // disconnect the way the layout mini-map already avoids.
    this.mapView?.destroy();
    this.mapView = null;
  }

  // Coalesce pending-row-group updates. Batches arrive one at a time behind an
  // inter-batch yield (see the `setTimeout(0)` below), so each one is its own
  // Lit update pass unless we throttle how often `pendingIndices` (the prop
  // every side panel re-renders on) actually changes reference. Multiple
  // batches landing within one animation frame collapse into a single flush.
  private scheduleVizFlush(token: number): void {
    if (this.vizFlushHandle !== null) return;
    this.vizFlushHandle = requestAnimationFrame(() => {
      this.vizFlushHandle = null;
      if (token !== this.fetchToken) return;
      this.pendingIndices = new Set(this.pendingWorking);
    });
  }

  // Flush the working set to the reactive prop immediately, bypassing (and
  // cancelling) any scheduled rAF flush. Used at fetch start and fetch
  // completion so the panels always end up showing the exact final state,
  // never a stale in-between one left over from the last scheduled frame.
  private flushVizNow(token: number): void {
    if (this.vizFlushHandle !== null) {
      cancelAnimationFrame(this.vizFlushHandle);
      this.vizFlushHandle = null;
    }
    if (token !== this.fetchToken) return;
    this.pendingIndices = new Set(this.pendingWorking);
  }

  private onRowGroupHover(event: CustomEvent<{ index: number | null }>) {
    this.hoveredIndex = event.detail.index;
  }

  // A click on the map. Resolve the picked primitive to its parquet row, open a
  // popup at the click point, then fetch and show that row's attribute columns.
  // An empty click (or an unresolvable one) just dismisses any open popup.
  private onFeaturePick = (info: PickingInfo) => {
    if (!this.mapView) return;
    if (!info.picked || !info.layer || !info.coordinate) {
      this.mapView.closeFeaturePopup();
      return;
    }
    const row = this.resolvePickedRow(info.layer.id, info.index);
    if (row == null) {
      this.mapView.closeFeaturePopup();
      return;
    }
    const lngLat: [number, number] = [info.coordinate[0], info.coordinate[1]];
    const token = ++this.pickToken;
    this.mapView.openFeaturePopup(lngLat, featureLoadingHtml(row));

    const url = this.currentUrl;
    if (!url || this.attrColumns.length === 0) {
      // No columns to read (or no file), so show the row with an empty table
      // rather than spin forever.
      this.mapView.setFeaturePopupHtml(featureAttributesHtml(row, {}));
      return;
    }
    void readRowAttributes(url, row, this.attrColumns)
      .then((attrs) => {
        // A newer click superseded this read, so drop its result.
        if (token !== this.pickToken || !this.mapView) return;
        this.mapView.setFeaturePopupHtml(featureAttributesHtml(row, attrs));
      })
      .catch((err) => {
        if (token !== this.pickToken || !this.mapView) return;
        this.mapView.setFeaturePopupHtml(featureErrorHtml(row, err));
      });
  };

  // Map a picked layer id and primitive index back to the source parquet row via
  // the registered buckets. Layer ids are `${prefix}-${kind}` with kind one of
  // poly, holed, line, point (outlines are not pickable), and each bucket's
  // rowIds is one absolute row per primitive, the same ordinal deck.gl reports as
  // info.index. Returns null when the layer or index does not resolve.
  private resolvePickedRow(layerId: string, index: number): number | null {
    const dash = layerId.lastIndexOf('-');
    if (dash < 0) return null;
    const prefix = layerId.slice(0, dash);
    const kind = layerId.slice(dash + 1);
    const flat = this.pickFlats.get(prefix);
    if (!flat) return null;
    const rowIds =
      kind === 'poly'
        ? flat.polygons.rowIds
        : kind === 'holed'
          ? flat.holedPolygons.rowIds
          : kind === 'line'
            ? flat.paths.rowIds
            : kind === 'point'
              ? flat.points.rowIds
              : null;
    if (!rowIds || index < 0 || index >= rowIds.length) return null;
    return rowIds[index];
  }

  private onMapMove = () => {
    if (!this.mapView) return;
    // Keep the readouts (zoom, viewport box) live on every settle, but debounce
    // the actual read so a rapid zoom-then-pan issues one fetch, not two.
    this.currentZoom = this.mapView.getZoom();
    this.viewBbox = this.mapView.getBounds();
    // Mirror the live camera into the address bar so it is a shareable deep link.
    this.reflectViewParam();
    if (this.fetchTimer !== null) clearTimeout(this.fetchTimer);
    this.fetchTimer = setTimeout(() => {
      this.fetchTimer = null;
      this.fetchCurrentView();
    }, 150);
  };

  // Fetch whatever the map currently shows, at the band the current zoom picks.
  // Skips the read when neither the viewport nor the band changed since the
  // last fetch, so an incidental moveend does not re-download the same view.
  private fetchCurrentView(): void {
    // A load is in flight, the strategy may not be prepared yet, so skip user-driven fetches until it settles.
    if (this.busy) {
      this.lastFetchKey = null;
      return;
    }
    const metadata = this.metadata;
    if (!metadata || !this.mapView) {
      this.lastFetchKey = null;
      return;
    }
    // An unsupported projected CRS is left in its native units, so an AOI in
    // lon/lat cannot prune it and the map cannot place it. The no-reprojection
    // notice is already shown, so skip fetching entirely.
    if (!metadata.projection.supported) {
      this.lastFetchKey = null;
      return;
    }
    const bbox = this.mapView.getBounds();
    const zoom = this.currentZoom;
    // Key the dedupe on the strategy's level-of-detail for this zoom, so any LOD
    // change refetches even when the viewport is unchanged, and on the AOI edges
    // rounded per zoom, so small pans at high zoom are not swallowed.
    const plan = this.strategy ? this.strategy.planRead(bbox, zoom) : null;
    const lodKey = plan ? plan.lodKey : 'none';
    const key = viewFetchKey(lodKey, bbox, zoom);
    if (key === this.lastFetchKey) return;
    this.lastFetchKey = key;
    this.fetchAoi(bbox, zoom);
  }

  // The zoom slider range, derived from the pyramid's levels so it spans from a
  // world view to the file's finest max_zoom (which can be far past the old
  // hardcoded 15). Falls back to 4 to 15 when there are no levels.
  private zoomRange(): { min: number; max: number } {
    const levels = this.metadata?.overviewsInfo?.levels;
    if (!levels || levels.length === 0) return { min: 4, max: 15 };
    const maxZoom = Math.max(...levels.map((l) => l.maxZoom));
    return { min: 1, max: Math.max(6, Math.ceil(maxZoom)) };
  }

  private renderZoomControl() {
    // Label the current LOD from the strategy's plan for this zoom. column and
    // read column depends only on the zoom, so any bbox works as the probe.
    const probe = this.viewBbox ?? { xmin: 0, ymin: 0, xmax: 0, ymax: 0 };
    const plan = this.strategy!.planRead(probe, this.currentZoom);
    const isOverview = plan.column !== 'geometry';
    const roleName = isOverview ? 'overview' : 'exact';
    const range = this.zoomRange();
    return html`
      <span class="sep"></span>
      <span class="tb-label">zoom</span>
      <input
        class="zoom-slider"
        type="range"
        min=${range.min}
        max=${range.max}
        step="0.5"
        .value=${String(this.currentZoom)}
        @input=${this.onZoomSlider}
      />
      <span class="zoom-read ${isOverview ? 'overview' : 'exact'}">z${this.currentZoom.toFixed(1)} · ${roleName}</span>
    `;
  }

  private onZoomSlider = (e: Event) => {
    const z = Number((e.target as HTMLInputElement).value);
    this.currentZoom = z;
    this.mapView?.setZoom(z);
  };

  private resetViz() {
    (this.querySelector('layout-heatmap') as LayoutHeatmap | null)?.reset();
    (this.querySelector('viz-waterfall') as VizWaterfall | null)?.reset();
    (this.querySelector('load-stats') as LoadStats | null)?.reset();
  }

  // Mirror the loaded file into the `url` query parameter so a refresh reopens
  // it and the address bar is a shareable deep link. replaceState keeps this
  // out of the back-button history, a file switch is not a navigation.
  private reflectUrlParam(url: string) {
    if (typeof window === 'undefined' || !window.history) return;
    const next = new URL(window.location.href);
    next.searchParams.set('url', url);
    window.history.replaceState(null, '', next);
  }

  // Mirror the live camera into the x/y/z query parameters (x lng, y lat, z
  // zoom) alongside the `url` parameter, so the address bar always deep links
  // into the exact view. replaceState keeps camera moves out of the back-button
  // history the same way reflectUrlParam does for file switches.
  private reflectViewParam() {
    if (typeof window === 'undefined' || !window.history || !this.mapView) return;
    const c = this.mapView.getCenter();
    const next = new URL(window.location.href);
    next.searchParams.set('x', c.lng.toFixed(5));
    next.searchParams.set('y', c.lat.toFixed(5));
    next.searchParams.set('z', this.mapView.getZoom().toFixed(2));
    window.history.replaceState(null, '', next);
  }

  private onFileLoad(event: CustomEvent<FileLoadRequest>) {
    void this.loadUrl(event.detail.url);
  }

  private async loadUrl(url: string) {
    if (!this.mapView) return;
    // Invalidate any in-flight view fetch of the previous file so its
    // progressive reader stops painting into this new file's map, and take a
    // fresh load token so a superseded load does not reset shared state under a
    // newer one (its finally would otherwise null the active URL mid-load).
    this.fetchToken++;
    const loadToken = ++this.loadToken;
    // Cancel any debounced view fetch still pending from the previous file, so
    // it cannot fire against this new file at the old camera before the opening
    // camera below moves it.
    if (this.fetchTimer !== null) {
      clearTimeout(this.fetchTimer);
      this.fetchTimer = null;
    }
    this.resetViz();
    // A new file, so clear the cumulative session totals too, not just the
    // per-view ones resetViz clears. The footer and metadata reads that follow
    // then count as the first bytes of this file's session.
    (this.querySelector('load-stats') as LoadStats | null)?.resetSession();
    this.currentUrl = url;
    this.reflectUrlParam(url);
    // A new file invalidates any pick state and open popup from the previous one.
    this.pickFlats.clear();
    this.attrColumns = [];
    this.mapView.closeFeaturePopup();
    this.aoiBbox = null;
    this.fetchedIndices = new Set();
    this.pendingWorking = new Set();
    this.flushVizNow(this.fetchToken);
    this.lastFetchKey = null;
    this.renderedPlanSig = null;
    this.renderedUrl = null;
    this.mergedLayerCache.clear();
    this.summary = null;
    this.fileFacts = null;
    this.busy = true;
    this.statusErr = false;
    this.status = 'Reading footer and metadata…';

    setActiveUrl(url);
    try {
      const t0 = performance.now();
      const metadata = await loadMetadataFromUrl(url);
      // A newer load started while this file's metadata was fetching, so abandon
      // this one rather than overwrite the newer file's metadata and strategy.
      if (loadToken !== this.loadToken) return;
      this.metadataMs = performance.now() - t0;
      this.metadata = metadata;
      this.attrColumns = attributeColumns(metadata);
      this.strategy = detectLayout(metadata);
      // Precompute the file-invariant read scaffolding once, so runFetch and
      // refineToPages do not rebuild it on every pan.
      const offsets: number[] = [];
      let acc = 0;
      for (const rg of metadata.rowGroups) {
        offsets.push(acc);
        acc += rg.rowCount;
      }
      this.rowOffsets = offsets;
      this.schemaLookupCache = schemaLookup(metadata.schema);
      await this.strategy.prepare(url);
      this.fileBytes = metadata.rowGroups.reduce((sum, rg) => sum + rg.totalByteSize, 0);
      this.fileFacts = computeFileFacts(metadata, this.fileBytes, isFilePrefetched(url));
      const proj = metadata.projection;
      const crsCode = proj.geographic ? 'lon/lat' : proj.epsg ? `EPSG:${proj.epsg}` : proj.label;
      const crsDetail = proj.geographic
        ? 'native'
        : proj.supported
          ? 'reprojected to lon/lat'
          : 'unsupported';
      this.summary = {
        fileBytes: this.fileBytes,
        rowGroupsTotal: metadata.rowGroups.length,
        rowGroupsFetched: 0,
        features: 0,
        vertices: 0,
        metadataMs: this.metadataMs,
        fetchMs: 0,
        decodeMs: 0,
        uploadMs: 0,
        totalMs: this.metadataMs,
        crs: crsCode,
        crsDetail,
        column: '',
        band: null,
        pagePrunedGroups: 0,
        wholeGroups: 0,
      };

      this.mapView.clearLayers();
      let crsNote = '';
      if (!proj.supported) {
        // The data is in a projected CRS with no reprojection defined, so its
        // bboxes stay in native units. Flying the map to them would feed
        // MapLibre out-of-range lat/lon and throw, so skip the fly and skip
        // fetching (fetchCurrentView also guards on this), and keep the parsed
        // metadata so the layout panels still render. Just show the notice.
        this.statusErr = true;
        crsNote = ` Cannot render, ${proj.label} is a projected CRS with no reprojection defined.`;
      } else {
        const extent = fileExtent(metadata.rowGroups);
        if (this.pendingInitialView) {
          // A camera deep-linked in x/y/z wins over the default fit on the first
          // open. jumpTo settles into a moveend, which auto-fetches that view.
          // Consumed once so a later file switch fits to its own extent.
          this.mapView.jumpTo(this.pendingInitialView);
          this.pendingInitialView = null;
          // jumpTo is instant, so the camera is already at the target. Seed the
          // viewport readouts from it and hold the spinner on until the debounced
          // fetch starts, so the panels and spinner do not lag the metadata.
          this.viewBbox = this.mapView.getBounds();
          this.currentZoom = this.mapView.getZoom();
          this.loading = true;
        } else if (extent) {
          // flyToBbox animates for 600ms and only emits moveend at the end, so
          // busy clears here while the fly is still running and the first fetch
          // has not started. Seed the viewport readouts to the fly target and
          // hold the spinner on across that gap, so the side panels do not draw
          // the pre-fly camera and the spinner does not blink off between the
          // metadata read and the opening fetch. The moveend fetch overwrites
          // these with the exact settled camera.
          this.viewBbox = extent;
          const targetZoom = this.mapView.zoomForBbox(extent);
          this.loading = true;
          if (targetZoom != null) {
            this.currentZoom = targetZoom;
            this.mapView.flyToBbox(extent);
          } else {
            // zoomForBbox goes through the same cameraForBounds as fitBounds, so
            // a null here means the map has no usable size yet (below ~80px) and
            // flyToBbox would silently no-op with no moveend, leaving the spinner
            // stuck on. jumpTo always emits moveend, so snap to the extent centre
            // instead to drive the opening fetch and clear the spinner. trackResize
            // refits once the container is sized.
            const center = {
              lng: (extent.xmin + extent.xmax) / 2,
              lat: (extent.ymin + extent.ymax) / 2,
              zoom: this.mapView.getZoom(),
            };
            this.mapView.jumpTo(center);
            this.viewBbox = this.mapView.getBounds();
            this.currentZoom = this.mapView.getZoom();
          }
        }
        if (!proj.geographic) crsNote = ` Reprojected from ${proj.label} to lon/lat.`;
      }
      // The file declares its geometry types but none are ones the renderer can
      // draw (or the list is empty), so warn rather than silently paint nothing.
      // A missing geometry_types is common and never triggers this.
      let typeNote = '';
      if (!hasRenderableGeometry(metadata.geometryTypes)) {
        this.statusErr = true;
        const declared = (metadata.geometryTypes ?? []).join(', ') || 'none';
        typeNote = ` This file declares no renderable geometry types (${declared}).`;
      }
      this.status = `${metadata.rowGroups.length} row groups, ${(this.fileBytes / 1_000_000).toFixed(0)} MB. Pan or zoom to fetch.${crsNote}${typeNote}`;
    } catch (err) {
      if (loadToken !== this.loadToken) return;
      this.statusErr = true;
      this.status = `Could not read ${url}. ${err instanceof Error ? err.message : String(err)}`;
      this.metadata = null;
      // Clear the strategy so a stale one from the previous file cannot drive a
      // fetch against the failed load.
      this.strategy = null;
    } finally {
      // Only release busy and the active URL if this is still the latest load,
      // so a superseded load does not clear them out from under the newer one.
      if (loadToken === this.loadToken) {
        this.busy = false;
        setActiveUrl(null);
      }
    }
  }

  // Queue a fetch for one area at one zoom. Each fetch carries a token, so a
  // newer request supersedes an in-flight one via the token gate rather than
  // racing it, every paint checks it before touching shared state and a stale
  // paint just no-ops. There is no promise chain, a new view starts right away
  // instead of waiting for the superseded fetch's in-flight reads to drain.
  private fetchAoi(bbox: Bbox, zoom: number): void {
    const token = ++this.fetchToken;
    void this.runFetch(bbox, zoom, token);
  }

  // Fetch and render one area at one zoom. The zoom picks the overview level
  // (which row-group prefix and which geometry column), the AOI bbox prunes
  // within that prefix, and the row groups are read in batches so the map fills
  // in progressively rather than after one long wait. Files with no overview
  // pyramid read the full geometry column for every intersecting row group.
  private async runFetch(bbox: Bbox, zoom: number, token: number) {
    const url = this.currentUrl;
    const metadata = this.metadata;
    if (!url || !metadata || !this.mapView) return;
    // Superseded by a newer request before this one got its turn on the chain.
    if (token !== this.fetchToken) return;

    this.aoiBbox = bbox;
    // Show the map spinner while this view is in flight. A superseded fetch
    // leaves it on for the newer fetch that already owns the token.
    this.loading = true;

    const plan = this.strategy!.planRead(bbox, zoom);
    const indices = plan.indices;
    const column = plan.column;

    this.fetchedIndices = new Set(indices);
    this.pendingWorking = new Set(indices);
    this.flushVizNow(token);
    this.statusErr = false;
    // A file with no covering bbox cannot be pruned to the view, so note that
    // rather than imply the area was empty.
    const prunable = this.strategy!.prunable;
    if (indices.length === 0) {
      // Tear down whatever is on screen, mirroring the changed-plan teardown
      // below, so panning fully off-data blanks the map instead of leaving the
      // previous view's geometry stuck under an empty-view status.
      this.resetViz();
      this.mapView.clearLayers();
      this.pickFlats.clear();
      this.mapView.closeFeaturePopup();
      this.renderedPlanSig = null;
      this.pendingWorking.clear();
      this.flushVizNow(token);
      this.loading = false;
      // Allow an immediate retry of the same view once data comes into range.
      this.lastFetchKey = null;
      this.status = prunable
        ? 'No row groups intersect this view. Try zooming out or panning.'
        : 'This file has no covering bbox, so pruning is unavailable, and it has no row groups to read.';
      return;
    }

    const pruneNote = prunable ? '' : ' This file has no covering bbox, so pruning is unavailable.';
    const readingLabel = column === 'geometry' ? 'exact geometry' : `overview (${column})`;
    this.status = `Fetching ${indices.length} of ${metadata.rowGroups.length} row groups, ${readingLabel}…${pruneNote}`;

    // Map each selected row group to its absolute row range, so hyparquet reads
    // exactly that group's column chunk over a range request.
    const ranges: RowGroupRange[] = indices.map((i) => ({
      index: i,
      rowStart: this.rowOffsets[i],
      rowEnd: this.rowOffsets[i] + metadata.rowGroups[i].rowCount,
    }));

    // Only claim the active URL if this fetch is still current, so a fetch
    // already superseded before it runs cannot steal attribution from the
    // fetch that superseded it.
    if (token === this.fetchToken) setActiveUrl(url);
    // Refine wide row groups to page-level sub-ranges over the offset index, so
    // a small viewport reads only the overlapping pages of a large row group.
    // Any failure in the page path falls back to a whole-group read.
    const readRanges = await this.refineToPages(url, metadata, ranges, bbox);
    if (token !== this.fetchToken) {
      // Stale: do not touch the active URL, it may already belong to whatever
      // superseded this fetch.
      return;
    }
    const sig = planSignature(column, readRanges);
    // The resolved plan matches what is already painted, so the pixels would be
    // identical. Refresh the viewport-derived readouts and leave the layers,
    // pick provenance, and popup exactly as they are. This is the common case
    // for an in-place pan over already-loaded data.
    if (url === this.renderedUrl && sig === this.renderedPlanSig) {
      this.fetchedIndices = new Set(readRanges.map((r) => r.index));
      this.pendingWorking = new Set();
      this.flushVizNow(token);
      this.loading = false;
      return;
    }
    // A genuine change, so tear down the old view now, not before refinement.
    this.resetViz();
    this.mapView.clearLayers();
    this.pickFlats.clear();
    this.mapView.closeFeaturePopup();
    this.renderedPlanSig = null; // screen no longer shows the recorded plan
    // refineToPages drops a group whose pages all miss the view, so re-derive
    // the indices actually being read and update the panels, otherwise a dropped
    // group would sit listed as pending forever.
    const readIndices = readRanges.map((r) => r.index);
    this.fetchedIndices = new Set(readIndices);
    this.pendingWorking = new Set(readIndices);
    this.flushVizNow(token);
    const total = readIndices.length;
    if (total === 0) {
      this.pendingWorking.clear();
      this.flushVizNow(token);
      this.loading = false;
      this.lastFetchKey = null;
      this.status = 'No data pages intersect this view. Try zooming out or panning.';
      setActiveUrl(null);
      return;
    }
    const pagePruned = readRanges.filter((r) => r.subRanges).length;
    if (pagePruned > 0) {
      this.status = `Fetching ${total} of ${metadata.rowGroups.length} row groups, ${readingLabel}, ${pagePruned} page pruned…${pruneNote}`;
    }
    // The overview level this view reads, for the read-cost panel's efficiency
    // readout. Taken from the plan's selected level, not the first read group,
    // so the finest (exact) level reports its own level rather than 0, even
    // though it owns the whole prefix and reads groups that span several levels.
    const viewBand = plan.band;

    const tStart = performance.now();
    let features = 0;
    let vertices = 0;
    let decodeMs = 0;
    let uploadMs = 0;
    let batchOrdinal = 0;
    // Unique row-group indices that have painted at least one batch. A page-pruned
    // group now paints as several batches (one per page) under one index, so the
    // fetched-group count and the status must count distinct groups, not batches,
    // or they would run past `total`.
    const arrived = new Set<number>();
    // Every batch's flattened buckets, cached-hit and freshly decoded alike, are
    // collected here and merged into one layer set per kind at fetch completion,
    // so a settled view holds a handful of layers instead of one per row group.
    const batches: FlatGeometries[] = [];

    // Flat-geometry cache for this file. The key must separate partial page-pruned
    // reads (a subset of a group's rows) from whole-group reads and from the same
    // group read via a different column at another level of detail, otherwise a
    // partial decode could be served to a later full read.
    const flatCache = getFlatCache(url);
    // A page-pruned group caches each kept page under its own stable
    // [rowStart, rowEnd) key, so an overlapping pan reuses the decoded page even
    // as the merged fetch spans jitter. A whole-group read keeps the stable
    // 'full' key, the same shape whole-group entries used before, so those
    // entries survive across pans too. Both use the same null separator as before.
    const pageKey = (index: number, rowStart: number, rowEnd: number): string =>
      `${column}\u0000${index}\u0000${rowStart}-${rowEnd}`;
    const groupKey = (index: number): string => `${column}\u0000${index}\u0000full`;

    // Paint one batch progressively and collect its buckets for the end-of-fetch
    // merge. Shared by the cache-hit and fresh-decode paths so both update the
    // load summary and pending list identically.
    const paintBatch = (flat: FlatGeometries, batchFeatures: number, batchIndices: number[]) => {
      features += batchFeatures;
      vertices += vertexCount(flat);
      batches.push(flat);

      const tUpload = performance.now();
      const batchId = `rg-batch-${batchOrdinal}`;
      timeWork('gpu-upload', `${batchFeatures} geometries`, () =>
        this.mapView!.addLayers(buildLayers(batchId, flat)),
      );
      // Register this batch's buckets so a click during progressive load still
      // resolves to a row; the end-of-fetch merge replaces these with rg-merged.
      this.pickFlats.set(batchId, flat);
      uploadMs += performance.now() - tUpload;
      batchOrdinal += 1;

      for (const i of batchIndices) arrived.add(i);
      // Mutate the working set and coalesce the reactive flush with a rAF, so
      // several batches arriving in the same frame (or the same macrotask,
      // before the next paint) collapse into one `pendingIndices` update
      // instead of one per row group. Every side panel reads `pendingIndices`,
      // so this is what keeps a fast progressive fetch from re-rendering all
      // of them once per batch.
      for (const i of batchIndices) this.pendingWorking.delete(i);
      this.scheduleVizFlush(token);

      const wallMs = performance.now() - tStart;
      this.summary = {
        fileBytes: this.fileBytes,
        rowGroupsTotal: metadata.rowGroups.length,
        rowGroupsFetched: arrived.size,
        features,
        vertices,
        metadataMs: this.metadataMs,
        fetchMs: Math.max(0, wallMs - decodeMs - uploadMs),
        decodeMs,
        uploadMs,
        totalMs: this.metadataMs + wallMs,
        // Carry the CRS readout set when the file loaded, it does not change
        // between fetches of the same file.
        crs: this.summary?.crs ?? '',
        crsDetail: this.summary?.crsDetail ?? '',
        column,
        band: viewBand,
        pagePrunedGroups: pagePruned,
        wholeGroups: total - pagePruned,
      };
      this.status = `Painted ${arrived.size}/${total} row groups (${features.toLocaleString('en-US')} features)…`;
    };

    // Split the read ranges into cache hits (skip the byte fetch and the decode
    // entirely) and misses (read and decode). The hit's byte cost is zero, so no
    // fetch event fires and the byte accounting stays coherent. A page-pruned
    // group is split at page granularity, each kept page probes and decodes on its
    // own, so an overlapping pan repaints the warm pages and reads only the newly
    // visible ones. A whole-group read probes and decodes as one unit.
    const cachedHits: { index: number; cached: { flat: FlatGeometries; features: number } }[] = [];
    const uncachedRanges: RowGroupRange[] = [];
    // Which pages each page-pruned group keeps, so onBatch can map a decoded batch
    // back to the page it belongs to (all rows of a single-page range fall inside
    // that page). A whole-group read is absent here and caches under its group key.
    const pagesByIndex = new Map<number, { rowStart: number; rowEnd: number }[]>();
    for (const range of readRanges) {
      if (range.pages) {
        pagesByIndex.set(range.index, range.pages);
        for (const p of range.pages) {
          const cached = flatCache.get(pageKey(range.index, p.rowStart, p.rowEnd));
          if (cached) {
            cachedHits.push({ index: range.index, cached });
          } else {
            // One read range per missing page, so each decodes and caches alone.
            // Several may share an index, that is intended.
            uncachedRanges.push({
              index: range.index,
              rowStart: range.rowStart,
              rowEnd: range.rowEnd,
              subRanges: [p],
            });
          }
        }
      } else {
        const cached = flatCache.get(groupKey(range.index));
        if (cached) cachedHits.push({ index: range.index, cached });
        else uncachedRanges.push(range);
      }
    }

    try {
      // Repaint the cached units first, instantly, then stream the misses in.
      for (const { index, cached } of cachedHits) {
        if (token !== this.fetchToken) return;
        const t0 = performance.now();
        emitEvent({ kind: 'work', phase: 'flatten-cache', label: `rg ${index}`, t0, t1: performance.now() });
        paintBatch(cached.flat, cached.features, [index]);
      }

      await readColumnProgressive(
        url,
        uncachedRanges,
        column,
        async (geometries, rows, batchIndices) => {
        // A newer view fetch started, so stop painting this stale one. The
        // reader also bails at the next row-group boundary via shouldStop below,
        // so a fast pan or zoom abandons the stale read instead of waiting it out.
        if (token !== this.fetchToken) return;

        const tDecode = performance.now();
        const flat = timeWork('wkb-decode', `${geometries.length} geometries`, () => plan.decode(geometries, rows));
        decodeMs += performance.now() - tDecode;

        // Cache the decoded bucket before merging, so a repeat view reuses it.
        // Merging is per view, caching is per unit, so the merged result is not
        // cached. A page-pruned group caches each page under its own stable key,
        // identified by which page the batch's rows fall in (each miss range is a
        // single page, so every row is inside that one page). A whole-group read
        // caches as one unit under its group key.
        const index = batchIndices[0];
        const pages = pagesByIndex.get(index);
        if (pages) {
          if (rows.length > 0) {
            const p = pages.find((pg) => rows[0] >= pg.rowStart && rows[0] < pg.rowEnd);
            if (p) flatCache.set(pageKey(index, p.rowStart, p.rowEnd), { flat, features: geometries.length });
          }
          // An all-null page yields rows.length === 0, so there is no page to key
          // on. Skip caching it, it is cheap to re-read and rare.
        } else {
          flatCache.set(groupKey(index), { flat, features: geometries.length });
        }

        paintBatch(flat, geometries.length, batchIndices);

        // Yield a macrotask between row groups so the decode burst after a gesture
        // cannot block the main thread for the whole read. Cancellation is checked
        // at the next boundary by shouldStop below.
        await new Promise((resolve) => setTimeout(resolve, 0));
        },
        () => token !== this.fetchToken,
      );
      if (token !== this.fetchToken) return;
      this.pendingWorking.clear();
      if (batches.length > MERGE_LAYER_THRESHOLD) {
        // Many batches, collapse to one layer set per kind to cut draw calls.
        // The merged layers are built first, then swapped in with a single
        // setLayers, so there is no frame where the map is empty.
        let entry = this.mergedLayerCache.get(sig);
        if (!entry) {
          const merged = mergeFlatGeometries(batches);
          const layers = buildLayers('rg-merged', merged);
          entry = { layers, merged };
          this.mergedLayerCache.set(sig, entry);
          // Bound the cache to a small recent window.
          if (this.mergedLayerCache.size > 6) {
            const oldest = this.mergedLayerCache.keys().next().value as string;
            this.mergedLayerCache.delete(oldest);
          }
        }
        timeWork('gpu-upload', `${features.toLocaleString('en-US')} merged`, () =>
          this.mapView!.setLayers(entry!.layers),
        );
        // The per-batch layers are gone, so their pick provenance is too. Register
        // the SAME merged buckets these layers were built from, so a picked ordinal
        // into the layers indexes the matching rowIds.
        this.pickFlats.clear();
        this.pickFlats.set('rg-merged', entry.merged);
      }
      // Small views keep their per-batch layers and per-batch pickFlats as is,
      // already uploaded once during progressive paint. No second upload.
      this.renderedPlanSig = sig;
      this.renderedUrl = url;
      this.status = `Rendered ${features.toLocaleString('en-US')} features from ${total} row groups, ${readingLabel}.${pruneNote}`;
    } catch (err) {
      if (token !== this.fetchToken) return;
      this.statusErr = true;
      // Clear the dedupe key so the same view can be retried without moving the
      // camera first.
      this.lastFetchKey = null;
      // A failed fetch must not leave a stale signature claiming the screen.
      this.renderedPlanSig = null;
      this.status = `Fetch failed. ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      // Whatever happened, land the exact final pending state, never a stale
      // one left over from a scheduled-but-not-yet-fired rAF flush.
      this.flushVizNow(token);
      // Only clear the active URL if this fetch is still the latest, so a
      // fetch superseded mid-read cannot null out the newer fetch's URL.
      if (token === this.fetchToken) setActiveUrl(null);
      // Only clear the spinner if this fetch is still the latest, so a fetch
      // superseded mid-read leaves it on for the newer one.
      if (token === this.fetchToken) this.loading = false;
    }
  }

  // Turn whole-group read ranges into page-pruned sub-ranges where it pays off.
  // A row group is only page-pruned when its footprint dwarfs the viewport (>=
  // 4x area) and the file exposes the covering page indexes. Every other group,
  // and any read error, falls back to a whole-group read, so this never throws.
  private async refineToPages(
    url: string,
    metadata: GeoParquetMetadata,
    ranges: RowGroupRange[],
    aoi: Bbox,
  ): Promise<RowGroupRange[]> {
    const covering = metadata.coveringPaths;
    const aoiArea = bboxArea(aoi);
    if (!covering || !(aoiArea > 0)) return ranges;

    let file;
    try {
      file = await getFileForUrl(url);
    } catch {
      return ranges;
    }
    // A prefetched file is fully resident, so page pruning saves no bytes and
    // would only add index reads and decode work. Read whole groups from memory.
    if (isFilePrefetched(url)) return ranges;
    const lookup = this.schemaLookupCache ?? schemaLookup(metadata.schema);
    const transform = metadata.projection.transform;
    const memo = getPageRangeMemo(url);

    // First pass, find every wide group not yet memoized and kick off its page
    // index read without awaiting, so a whole-extent view with many wide coarse
    // groups fires its round trips together instead of one after another. Each
    // probe is wrapped so a thrown error resolves to null, matching the
    // whole-group fallback the serial try/catch used to give per group.
    const pending: Array<{ index: number; promise: Promise<PageRange[] | null> }> = [];
    for (const range of ranges) {
      const rg = metadata.rowGroups[range.index];
      const raw = metadata.rawRowGroups[range.index];
      const wideEnough = rg?.bbox && raw && bboxArea(rg.bbox) >= 4 * aoiArea;
      if (!wideEnough || memo.has(range.index)) continue;
      const probe = pageRangesForRowGroup(file, raw!, covering, range.rowStart, rg!.rowCount, transform, lookup).catch(
        () => null,
      );
      pending.push({ index: range.index, promise: probe });
    }
    if (pending.length > 0) {
      const resolved = await withPhase('page-index', () => Promise.all(pending.map((p) => p.promise)));
      pending.forEach((p, i) => memo.set(p.index, resolved[i]));
    }

    const out: RowGroupRange[] = [];
    for (const range of ranges) {
      const rg = metadata.rowGroups[range.index];
      const raw = metadata.rawRowGroups[range.index];
      const wideEnough = rg?.bbox && raw && bboxArea(rg.bbox) >= 4 * aoiArea;
      if (!wideEnough) {
        out.push(range);
        continue;
      }
      // The page indexes are immutable for the file, and the per-page bboxes are
      // absolute, so the decoded pages are reused across every pan and zoom. Only
      // the AOI filter in mergePageRanges below is recomputed per view. A null
      // memo value records a group that cannot be page pruned. The first pass
      // above already populated the memo for every wide group, so this only reads.
      let pages = memo.get(range.index) ?? null;
      if (!pages) {
        out.push(range);
        continue;
      }
      const subRanges = mergePageRanges(pages, aoi);
      if (subRanges.length === 0) continue; // no page meets the viewport, read nothing
      const whole =
        subRanges.length === 1 &&
        subRanges[0].rowStart <= range.rowStart &&
        subRanges[0].rowEnd >= range.rowEnd;
      if (whole) {
        out.push(range);
        continue;
      }
      out.push({ ...range, subRanges, pages: keptPageRanges(pages, aoi) });
    }
    return out;
  }
}

function bboxArea(b: Bbox): number {
  return Math.max(0, b.xmax - b.xmin) * Math.max(0, b.ymax - b.ymin);
}

customElements.define('app-root', AppRoot);
