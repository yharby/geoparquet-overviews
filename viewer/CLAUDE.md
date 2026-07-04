# viewer/CLAUDE.md

## What this is

The reference reader for the GeoParquet overviews convention defined in
../SPEC.md. A TypeScript browser app (Lit, deck.gl 9.3.6, MapLibre, hyparquet)
that reads GeoParquet over HTTP range requests, picks a band per zoom, prunes
reads down to page granularity, and shows the byte cost live. It never
downloads a whole file.

## Commands

```bash
pnpm install
pnpm dev          # vite, port 5173+
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run
pnpm build        # tsc --noEmit && vite build
```

Node >= 24, pnpm 11.9.0.

## Data flow

- `src/ui/app-root.ts` drives everything, debounced moveend fetches, a
  superseding token per view, progressive paint per row group.
- `src/data/manifest.ts` fetches the hosted `versions.json` catalog
  (`fetchManifest`, `MANIFEST_URL`), parses it (`parseManifest`), derives a
  version's preset list (`presetsForVersion`), and maps a dataset across
  versions by preset id (`resolveVersionTwin`). `src/ui/load-control.ts` wires
  the version dropdown, defaulting to the manifest's `latest`, switching the
  preset list on `onVersionChange`, and falling back to the built-in
  `FILE_PRESETS` whenever the manifest is unreachable (`fetchManifest` resolves
  null and the dropdown stays hidden). `versions.json` is published at the
  bucket root and lists 0.1.0 and 0.2.0, so the dropdown is live.
- `src/data/metadata.ts` fetches the footer, parses `geo` and `overviews`,
  stamps the band ordinal on each row group, interprets the CRS. Each row
  group's bbox comes from the physical `bbox` covering column when present, else
  from native Parquet GeospatialStatistics (`findGeospatialStatsBbox`,
  `isUsableGeoStatsBbox`) for Profile B (`--no-bbox`) files, preferring the
  `geom_overview` column's stats over the primary geometry's so coarse pruning
  matches the grid-snapped geometry actually painted. It also parses the 0.2.0
  per-level `bytes` (`[start, end)` file byte range) and `extent` (padded
  band bbox) fields onto `OverviewLevel`.
- `src/data/layout.ts` picks the read strategy, `overviews` (band per zoom,
  `geom_overview` for coarse levels) or `flat-wkb`, and returns a ReadPlan of
  bbox-pruned row-group indices plus the column to read. `flatStrategy.prunable`
  is true when any row group carries a usable bbox from either source, so
  Profile B files still prune to the viewport at row-group granularity (the
  page-level path below still needs the physical covering column).
- `src/data/pageindex.ts` prunes below row-group granularity, reads the
  `bbox` covering column's ColumnIndex and OffsetIndex and maps the view to
  overlapping page row ranges. Returns null on any problem so the caller
  falls back to a whole-group read.
- `src/data/rowgroups.ts` reads through hyparquet's columnar path,
  `parquetRead` with `onChunk` and an identity geometry parser
  (`RAW_WKB_PARSERS`), so geometry arrives as zero-copy WKB Uint8Array views.
  Up to 6 groups read concurrently, onBatch paints strictly serially.
- `src/geo/wkb-flatten.ts` scans WKB with a DataView straight into flat
  typed-array buckets, no GeoJSON intermediate. `src/geo/geojson.ts` keeps
  the GeoJSON flattener only as a fallback for already-decoded values.
- `src/geo/crs.ts` reprojects projected files to lon and lat with proj4,
  in place on the flat buffers. Known defs live in `PROJ_DEFS`, add EPSG
  codes there.
- `src/data/flat-cache.ts` LRU-caches decoded flat buckets per
  (column, row group, row range), 192 MB budget. `src/data/byte-cache.ts`
  and `file-cache.ts` cache bytes and file handles one level down.
- `src/map/polygon-layer.ts` and `map-view.ts` build deck.gl layers.
  Batches paint progressively, then each settled view consolidates to
  single-digit layer counts. The fill, line, and point layers are pickable
  (outlines are not), so a click resolves to a primitive ordinal.
- `src/data/feature-detail.ts` reads one clicked feature's non-geometry
  attribute columns on demand (`parquetReadObjects` over a single-row range),
  and `src/ui/feature-popup.ts` renders them into a MapLibre popup. The
  clicked primitive maps to its parquet row via the per-primitive `rowIds`
  provenance arrays carried on every flat bucket (see `src/geo/geojson.ts`),
  keyed by the absolute row the reader records in `src/data/rowgroups.ts`.
  `attributeColumns` in `metadata.ts` picks the columns to read. The reads are
  serialized and each races a timeout, see the hard constraint below.
- `src/viz/` holds the side panels (waterfall, layout map, pruning map,
  stats, row-group detail).

## Hard constraints, do not break these

- Holed polygon fills must keep `positionFormat 'XY'` through the
  complex-flat `{positions, holeIndices}` accessor shape. deck.gl 9.3.6's
  binary fill path does NOT honor `vertexValid` for hole cutting, verified
  empirically against the installed tesselator, it feeds only the wireframe
  and extrusion shaders. Flat buffers are still stored, only the accessor
  shape differs.
- proj4 is pinned at 2.20.9 and ships its own types. Never add
  `@types/proj4`.
- Any failure at page granularity must fall back to a whole-group read.
  `pageRangesForRowGroup` returns null on missing indexes, page-count
  disagreement, or any read error, keep that contract, the page path may
  never break a fetch.
- The decode path is zero-copy oriented. No per-feature GeoJSON objects, no
  per-row `{column: value}` wrappers, no `[x, y]` pair allocations on the
  hot path. Coordinates should materialize about twice (page bytes, flat
  buffer) before deck.gl's fp64 split. The `rowIds` provenance array is one
  Uint32 per primitive, not per vertex, so it does not change this. The
  attribute read for the click popup is the one place row objects are built,
  and only for a single clicked row, on demand, off the hot path.
- Page-index offsets (`column_index_offset`, `offset_index_offset` and their
  lengths) live on the outer hyparquet `ColumnChunk`, not on
  `chunk.meta_data`. Reading them from meta_data made the index probe
  silently always-false once already, see commit 2f6e8f9.
- Flat-cache buckets and byte-cache slices are immutable and shared by
  reference. Never mutate a returned bucket, that corrupts the entry for the
  next view.
- Interleaved deck.gl rendering in `map-view.ts` is deliberate, it fixed
  polygons drifting out of sync with the MapLibre v5 basemap. Do not switch
  to overlaid mode.
- The hover cursor comes from deck.gl's `getCursor` prop on the overlay, not
  from writing `canvas.style.cursor` in an `onHover`. MapLibre rewrites the
  canvas cursor on every mouse move, so a manual write fights it and the cursor
  flickers over a pickable feature. Let deck own the cursor (one writer).
- The click popup must be a fresh `maplibregl.Popup` per click, not one reused
  instance. Calling `addTo` on an already-open popup fires an internal close
  (which nulls the reference) and can orphan a node, so a later `setHTML` for
  the resolved attributes lands on a detached popup and the body stays stuck on
  "loading". `openFeaturePopup` closes the previous popup first, then builds a
  new one; the pick token still guarantees only the latest click writes into it.
- Attribute reads in `feature-detail.ts` are serialized through one promise
  chain and each races a timeout. A single-row read spans every attribute
  column, so hyparquet fires a burst of range requests per read; two bursts
  overlapping (a quick second click) exhaust the browser connection pool and
  can leave a request stalled, which never settles and wedges the shared byte
  cache for every later read. Serializing keeps it to one burst at a time, a
  superseded queued read skips its fetch, and the timeout makes a stalled read
  reject rather than block the chain or spin the popup forever. Do not fire
  these reads concurrently.
- deck.gl shallow-compares layer `data` by reference. Keep stable
  `{length, attributes}` wrappers, a fresh wrapper per render forces a full
  GPU re-upload.
- Do not adopt Arrow JS or GeoArrow layer packages. The file is standard WKB
  by design, re-encoding to GeoArrow adds the copy the flat path removed.
- Do not hand-roll coordinate origin offsetting, deck.gl's hybrid 32-bit
  projection with viewport-relative offsetting already solves precision.
- The CARTO basemap style URL in `src/map/map-view.ts` is kept deliberately
  by the owner. Do not remove or genericize it. It is the one commercial
  reference in the repo.

## Open work

Phase 3 of the performance plan remains open, worker decode. Move the
read-decode-flatten chain into a Web Worker with transferable ArrayBuffers,
upload on the main thread. Known design tensions, transferring detaches
buffers which conflicts with the byte cache's aliasing contract (see the
contract note at the top of `byte-cache.ts`), so either copy input bytes into
the worker or move fetch plus cache ownership into the worker, and
cancellation must cross the boundary (the current cooperative row-group-grain
cancellation maps to per-message posting). A separate spike only if profiles
still show polygon tessellation after that, worker-side earcut, which would
require subclassing SolidPolygonLayer internals since deck.gl exposes no
public prop for precomputed indices.

Verify perf work with the existing `timeWork` events (`wkb-decode`,
`gpu-upload`) on a scripted session, plus `pnpm typecheck` and `pnpm test`.

## Testing

Vitest, run with `pnpm test`. Tests are colocated with sources as
`*.test.ts` files (for example `src/data/pageindex.test.ts`,
`src/geo/wkb-flatten.test.ts`). Large local fixtures go in `public/`,
gitignored except `sample.parquet`.

`pnpm bench` runs a separate network suite (`bench/compare.bench.ts`, config
`vitest.bench.config.ts`, results written to `bench/RESULTS.md`) that plans
reads for a viewport ladder per dataset per data version and sums the
compressed bytes of the planned geometry chunks. It hits real hosted files
over the network, so it is deliberately excluded from `pnpm test` by living
under a separate config with its own `bench/**/*.bench.ts` include.
