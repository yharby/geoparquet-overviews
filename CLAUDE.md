# CLAUDE.md

## What this is

`geoparquet-overviews` is a proposal for the GeoParquet community. It defines one
GeoParquet file that a web map can preview instantly and a SQL engine can read in
full, with no duplicated exact geometry. It is a draft convention plus a
reference converter and a live viewer. Status draft 0.3.0, Apache-2.0. This is a
proposal repo, so keep everything vendor neutral, no commercial company names in
code, docs, or the spec.

## The idea in three parts

1. Importance order. Rank features by size, largest first, split into a few
   bands, sort band-major with a Hilbert curve within each band. Every feature
   stored once. Coarse bands land in a contiguous row-group prefix.
2. Overview column. Coarse bands carry a simplified, grid-snapped copy in a
   second geometry column `geom_overview`. The finest band leaves it null. The
   primary `geometry` column is always exact and untouched.
3. Footer block. An `overviews` key in the Parquet file-level metadata, parallel
   to `geo`, lists the bands (`levels[]` with `row_group_end`, `max_zoom`,
   `gsd`). Unknown to a plain reader, so ignored safely.

## Layout / naming (do not rename without reason)

- Footer metadata key `overviews` (parallel to `geo`).
- Overview geometry column `geom_overview`, band ordinal column `band`, bbox
  covering struct column `bbox`.
- Python package `geoparquet_overviews`, dist `geoparquet-overviews`, CLI `gpo`.
- Viewer package `geoparquet-overviews-viewer`.
- The project was renamed from `geoparquet-multiscale`, keep `overviews`.

## Repo layout

- `SPEC.md` the normative convention, RFC 2119 language. `DESIGN.md` the full
  rationale, measurements, and ecosystem positioning. `README.md` stays short.
- `converter/` Python (pyarrow + shapely + click). Core is `src/geoparquet_overviews/convert.py`.
  Footer builders in `footer.py`. CLI in `cli.py`. Tests in `tests/`. Has its
  own `README.md` and `CLAUDE.md`.
- `viewer/` TypeScript (Lit + deck.gl + MapLibre + hyparquet). Reads over HTTP
  range requests and shows the byte cost per zoom. CRS reprojection in
  `src/geo/crs.ts`. Metadata parse in `src/data/metadata.ts`, read strategy in
  `src/data/layout.ts`. Has its own `README.md` and `CLAUDE.md`, the latter
  carries the hard rendering and decode constraints.

## Commands

```bash
# converter
cd converter && uv sync && uv run pytest
uv run gpo convert in.parquet out.parquet          # -v verbose, -q quiet
uv run python examples/make_sample.py              # rebuilds viewer/public/sample.parquet

# viewer
cd viewer && pnpm install && pnpm typecheck && pnpm test
pnpm dev                                            # vite, port 5173+
```

## State of things

- Converter is CRS aware. It preserves the source CRS on both geometry columns
  and derives overview tolerances, grid, gsd, and max_zoom from the dataset
  extent, so it works in degrees or in projected metres. Every stage logs to
  stderr through the `geoparquet_overviews` logger.
- Converter splits coarse bands into up to `--coarse-row-groups` (default 32)
  near-equal row groups by feature count, so a low zoom view prunes them tightly
  by bbox. The finest exact band still cuts by the byte budget, and a floor keeps
  tiny datasets from fragmenting.
- Viewer prunes reads below row-group granularity. When a chosen row group covers
  more area than the view (1.5x or more) and the file carries the Parquet
  page indexes, it reads the `bbox` covering column's ColumnIndex and OffsetIndex,
  maps the view to the overlapping page row ranges, and reads geometry with
  hyparquet's offset-index option so only overlapping pages are fetched. Any
  failure falls back to a whole-group read. The 1.5x threshold (was 4x) closes the
  gap where a row group merely intersecting a corner of the viewport used to be
  decoded in full with no page-level pruning at all.
- Viewer reprojects projected files to lon and lat in the browser with proj4
  (v2.20.9, which ships its own types, do not add `@types/proj4`). Known
  projected CRS defs live in the `PROJ_DEFS` registry in `crs.ts`, seeded with
  EPSG:3067. Unknown projected codes show a notice instead of a broken render.
- Validated end to end on a real 5.65M-row EPSG:3067 buildings dataset. Under
  the density-thinned layout a whole-country preview reads the band 0 overview
  column, ~2 MB on disk decoding ~13 MB of area-sized quads, vs ~620 MB exact
  geometry, ~47x less decoded and ~90x less over the wire (the pre-0.3.0
  fraction-banded figure was ~9 MB decoded, ~67x, with no density signal and
  coverage stopping at z10). The viewer renders it correctly over Finland.
- Converter ranks features per geometry dimension, area for polygons, length
  for lines, an attribute column or grid thinning for points, and writes the
  resulting `overview_method` into the footer. The viewer renders points,
  lines, collections, and polygon holes.
- Draft 0.2.0. The converter dual writes native Parquet GEOMETRY logical
  types on `geometry` and `geom_overview` by default (`--native-geo`, off
  with `--no-native-geo`), so pyarrow computes per-row-group
  GeospatialStatistics on both columns while the `geo` footer key stays
  WKB-encoded at version `1.1.0`. The `overviews` key itself is now version
  `0.2.0` and each entry in `levels[]` gained `extent`, the band's padded
  bounding box, and `bytes`, the `[start, end)` file byte range of the
  band's own row groups. There are two writer profiles, Profile A
  (`--bbox`, default) writes the physical `bbox` covering column and Page
  Index as before, Profile B (`--no-bbox`) omits them and relies solely on
  native GeospatialStatistics for row-group pruning, with no page-level
  pruning at all since Parquet has no page-level geospatial statistics.
- Draft 0.3.0 (branch `feat/v030-band-thinning`, not yet merged). Bands are now
  formed by deterministic density thinning, not an importance fraction. Every
  valid feature starts in band 0 and, coarsest band first, the converter keeps
  one survivor per pixel per geometry dimension (the highest ranked feature
  winning each cell, ties broken on a crc32 of the feature WKB so it stays
  idempotent) and demotes the rest to the next finer band. No feature is
  dropped, the finest band is exact and keeps everyone demoted into it. The old
  fraction model (`_DEFAULT_BAND_FRACTIONS`, `_band_by_fraction`, `_thin_points`)
  is deleted. The overview ladder runs in absolute web zoom, but its coarsest
  band is anchored at the zoom where the dataset extent fills a screen
  (`_coarsest_zoom`, extent span over `_SCREEN_PX`), not at whole-world zoom, so
  a city-scale file never spends bands on zooms where its extent is a speck (band
  b serves `z_coarsest + 2*b`, cell `world/(256*2**zoom)`). The band count is
  derived from a decoded-bytes-per-screen budget (`--screen-budget-mb`, default
  1.0), covering `z_coarsest` up to the zoom where exact geometry fits the
  budget, so count-heavy and vertex-heavy data each get the band count they need
  with no regime branch, and a sparse dataset that already fits the budget at its
  coarsest zoom gets a single exact band and no overview. The budget solves
  against local byte density (`_local_byte_density`, a byte-weighted 0.9
  quantile over a 128x128 grid of bbox centroids), not the whole-extent
  average, because clustered data (buildings in cities inside an empty bbox)
  otherwise derives too few coarse bands and hands dense-city screens the
  unthinned exact band far too early. No overview band may serve at or past
  zoom 24 (`_max_coarse_for_zoom` clamps derived and forced counts), the exact
  band owns z24 up. Each coarse-band survivor carries `overview_count`, its
  cell population in the pass it won (band 0's counts sum to the full valid
  total only when no per-band budget binds, see the budget bullet below),
  the density signal one-per-pixel thinning would otherwise erase,
  advertised by a top-level `count_column` footer field and written for
  pure-point files too. A survivor whose shape collapses below its band's
  pixel writes a small area-sized grid-aligned quad (`_quad_fallback`,
  Tippecanoe's tiny-polygon-reduction idiom) and a collapsed line writes a
  short oriented segment (`_segment_fallback`), never NULL, otherwise a
  buildings dataset blanks its entire whole-country first paint. Each
  geometry type keeps its kind in the overview, only point features paint as
  points. Coarse-band coverings pad by half the band tolerance to enclose the
  quad. A file that collapses to a single band writes `overview_method:
  "none"`, never a false `simplify_snap`. Each coarse band
  snaps its overview to its own per-band grid (a quarter of that band's pixel).
  The giant-triangle bug (a coarse band's overview painting at a fine zoom via
  the cumulative prefix) is fixed on both sides, the converter's fine
  extent-anchored overviews plus the viewer reading exact geometry for a
  coarser band caught in a finer band's prefix (`columnForRowGroup`, gated to
  0.3.0+ files, pre-0.3.0 files snapped every band to one fine global grid so
  their coarse overviews stay correct and cheap at mid zooms). The `overviews`
  key is version `0.3.0`, `levels[]` gained `min_zoom`, `grid`, and
  `feature_count`, and the block gained a descriptive `regime` label and
  `count_column`. `--bands 0` derives, a positive value forces it (still zoom
  clamped). SPEC.md and DESIGN.md are updated. Reconversion and republish of
  the hosted `v0.3.0/` prefix with the current converter (count column, local
  density ladder) is pending.
- v0.3.0's `_thin_bands` also applies a per-band survivor budget
  (`_band_budgets`, `--drop-rate`, default 2.0), gpq-tiles/tippecanoe style
  geometric decay toward the coarsest band, with the last coarse band capped
  too so real overflow reaches the exact band and skips its overview, fixing
  the disproportionate mid-band weight a pure one-per-pixel ladder produced
  on count-heavy data (validated against the real Tokyo buildings fixture,
  see `docs/superpowers/specs/2026-07-09-band-budget-and-bbox-default-design.md`).
  `--bbox` also stopped being a fixed always-on default, it now follows the
  same count/vertex regime signal, on for count-heavy data where page pruning
  earns its keep, off for vertex-heavy data where it was measured at a
  rounding error of file size anyway.
- Converter handles WKB geometry columns past 2 GB. Arrow's `binary` type
  caps a contiguous array at 2 GB via its int32 offsets, so a whole-country
  file used to crash with an offset overflow. It now decodes the column chunk
  by chunk on read and, on write, switches the geometry column to
  `large_binary` (paired with `ga.large_wkb()`) once the payload would
  overflow, both physical `BYTE_ARRAY` in Parquet so readers are unaffected.
  Small files stay on plain `binary` unchanged. See `converter/CLAUDE.md`.
- Converter threads the overview build, its slowest stage, over `--jobs`
  workers (default one per core). shapely 2.x releases the GIL on `simplify`,
  `make_valid`, and `set_precision`, so threads parallelize them nearly
  linearly with byte-identical output. Read and write already thread inside
  pyarrow, and the WKB IO ops hold the GIL so they stay single-threaded.
- Viewer supports click-to-inspect. Each rendered primitive carries a
  per-primitive `rowIds` provenance array back to its absolute parquet row,
  so a click resolves the feature, reads only that row's non-geometry columns
  on demand, and shows them in a MapLibre popup. The geometry decode path
  stays zero-copy, the attribute read is the single on-demand row fetch.
- Viewer decode path is zero-copy oriented. hyparquet reads columnar (onChunk,
  identity geometry parser, no row objects), a DataView WKB scanner in
  `geo/wkb-flatten.ts` fills flat typed-array buckets directly (no GeoJSON
  intermediate), reprojection runs in place on the flat buffers, decoded
  buckets are LRU-cached per row group (`data/flat-cache.ts`), and each settled
  view consolidates to single-digit deck.gl layers. Holed polygon fills must
  keep `positionFormat 'XY'` (deck.gl 9.3.6 binary fill ignores vertexValid,
  see viewer/CLAUDE.md). Remaining open, worker decode, also tracked in
  viewer/CLAUDE.md.

## Hosted test data and its layout

The demo datasets the viewer loads live on source.coop, public base
`https://data.source.coop/youssef-harby/geoparquet-overviews`. The layout is
versioned by convention draft.

- Root objects (the files directly under the base, no version prefix) are what
  the live web app reads today. NEVER modify or delete them. Reconvert into a
  version prefix instead.
- Each draft gets its own prefix, `v0.1.0/` and `v0.2.0/`, holding the same
  dataset set reconverted with that draft's converter. `v0.2.0/` also carries
  `nls_rakennus_overviews.nobbox.parquet`, the Profile B (`--no-bbox`) twin of
  the Finland file.
- The version dropdown reads its manifest from the viewer's bundled
  `viewer/public/versions.json` (see `viewer/src/data/manifest.ts`,
  `MANIFEST_URL`, resolved against `import.meta.env.BASE_URL`), not from the
  hosted store. It lists each version and its datasets, with `latest` pointing
  at the newest, and its `base` field points at the source.coop root so the
  parquet bytes are still fetched there. Add a dataset by editing that file. Upload
  parquet objects with content type `binary/octet-stream`.
- The bucket is a real AWS S3 bucket, `us-west-2.opendata.source.coop` (the
  dots are part of the name), region `us-west-2`, no `--endpoint-url`. The
  write credentials and the exact `aws s3 cp` recipe are maintainer-local, not
  in this repo.

## Known limitations

- Converter reads the whole table into memory, fine for tens of millions of
  features, not streaming. zstd level 15 write (default, `--compression-level`)
  is slow but small.
- Viewer reprojection covers CRS codes present in `PROJ_DEFS`. Add codes there.
- Local-only large test fixtures go in `viewer/public/` and are gitignored
  except `sample.parquet`. The `nls_rakennus` preset URL in `presets.ts` is
  hosted on source.coop.
- Viewer page pruning granularity is the covering column's page, so the win
  scales with how many rows a row group and a page hold. It is about 5.8x on a
  large row group but only about 1.5x to 2x on the default 16 MB row groups.
  The converter's `--page-size-kb` flag is the lever that sharpens it.

## Decisions on record

- The CARTO basemap style URL in `viewer/src/map/map-view.ts` is kept
  deliberately by the owner. It is the one commercial reference. Everything else
  is vendor neutral. deck.gl and MapLibre are open-source dependencies.
- geoarrow-python was evaluated and not adopted. It cannot replace shapely for
  the area ranking, Hilbert sort, and topology-preserving simplify plus grid snap
  that build the overview, and its native GeoArrow encoding is off-goal for a
  standard-WKB GeoParquet 1.1 proposal. The converter stays on pyarrow plus
  shapely.
- Native Parquet geospatial statistics are row-group only, so page-level spatial
  pruning is done client-side via the `bbox` covering ColumnIndex and OffsetIndex.
