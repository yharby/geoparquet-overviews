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
  the light-overviews layout a whole-country preview reads the band 0 overview
  column, ~4.6 MB on disk decoding ~25 MB of area-sized quads, vs ~620 MB exact
  geometry decoded (~191 MB on disk). The whole overview column is ~16.7 MB, vs
  the ~112 MB the earlier all-band density thinning wrote for the same file, and
  band 0 still fills 2073 of a 4096 cell grid, so the coverage win survives. The
  viewer renders it correctly over Finland.
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
- Draft 0.3.0, light-overviews layout (branch `feat/v030-band-thinning`, not yet
  merged). Coarse bands are formed by a light importance fraction, largest first,
  not by all-the-way-down density thinning. `_band_by_fraction` and `_band_edges`
  cut a descending-score order so the coarse bands together hold
  `_COARSE_TOTAL_FRACTION` of the features (default 0.10, band 0 the smallest
  slice and each finer coarse band about doubling it), and the exact final band
  keeps the large remainder. Keeping the coarse cohort small is what keeps the
  overview column light, since every coarse feature carries a quad or segment
  overview copy (never NULL), so overview bytes track the coarse feature count,
  not the tolerance. Band 0 alone is then density thinned by `_thin_band0`, one
  survivor per pixel per geometry dimension over all valid features (highest
  ranked wins each cell, ties broken on a crc32 of the feature WKB so it stays
  idempotent), for even whole-extent coverage, and the non-survivors are fraction
  banded into the finer bands. Each band-0 survivor carries `overview_count`, its
  cell population, the density signal thinning would otherwise erase, null on
  every finer band, and because band-0 thinning runs over every valid feature the
  band-0 counts sum to the full valid total. The overview ladder runs in absolute
  web zoom, its coarsest band anchored at the zoom where the dataset extent fills
  a screen (`_coarsest_zoom`, extent span over `_SCREEN_PX`), not at whole-world
  zoom, so a city-scale file never spends bands on zooms where its extent is a
  speck. Band 0 resolves at `_COARSEST_REL` (1/1500) of the larger extent span
  and each finer coarse band divides the tolerance by `_LADDER_FACTOR` (4.0, two
  web zooms per band, the `_ZOOMS_PER_BAND` step), tunable through `--coarsest-rel`
  and `--ladder-factor`. The band count is derived from a decoded-bytes-per-screen
  budget (`--screen-budget-mb`, default 8.0) as a depth cap, `_derive_bands`
  covers `z_coarsest` up to the zoom where exact geometry read with page pruning
  already fits the budget, past which no overview band is written and the viewer
  reads exact geometry, so count-heavy and vertex-heavy data each get the band
  count they need and a sparse dataset that already fits the budget at its
  coarsest zoom gets a single exact band and no overview. The budget solves
  against local byte density (`_local_byte_density`, a byte-weighted 0.9 quantile
  over a 128x128 grid of bbox centroids), not the whole-extent average, because
  clustered data (buildings in cities inside an empty bbox) otherwise derives too
  few coarse bands and hands dense-city screens the exact band far too early. No
  overview band may serve at or past zoom 24 (`_max_coarse_for_zoom` clamps
  derived and forced counts), the exact band owns z24 up. A survivor whose shape
  collapses below its band's pixel writes a small area-sized grid-aligned quad
  (`_quad_fallback`, Tippecanoe's tiny-polygon-reduction idiom) and a collapsed
  line writes a short oriented segment (`_segment_fallback`), never NULL, so band
  0 never blanks the whole-country first paint. Each geometry type keeps its kind
  in the overview, only point features paint as points, and a pure-point dataset
  writes no overview column (`overview_method: "thin"`), the banding is its level
  of detail. Coarse-band coverings pad by half the band tolerance to enclose the
  quad. A file that collapses to a single band writes `overview_method: "none"`,
  never a false `simplify_snap`. Each coarse band snaps its overview to its own
  per-band grid (a quarter of that band's pixel). The giant-triangle bug (a coarse
  band's overview painting at a fine zoom via the cumulative prefix) is fixed on
  both sides, the converter's fine extent-anchored overviews plus the viewer
  reading exact geometry for a coarser band caught in a finer band's prefix
  (`columnForRowGroup`, gated to 0.3.0+ files, pre-0.3.0 files snapped every band
  to one fine global grid so their coarse overviews stay correct and cheap at mid
  zooms). The `overviews` key is version `0.3.0`, `levels[]` gained `min_zoom`,
  `grid`, and `feature_count`, and the block gained a descriptive `regime` label
  and `count_column`. `--bands 0` derives, a positive value forces it (still zoom
  clamped). The old all-band `_thin_bands` cascade, the `_band_budgets` per-band
  survivor budget and its `--drop-rate` flag, and `_DEFAULT_BAND_FRACTIONS` are
  deleted. A six-archetype bake-off (countries, timezones, states, Finland
  buildings, roads, points) drove the defaults, Finland's overview column landed
  at 16.66 MB (1.19x the fraction-only bake-off baseline, vs 112 MB for the old
  all-band thinning), file 315 MB, band-0 coverage 2073 of 4096. SPEC.md and
  DESIGN.md are updated. Reconversion and republish of the hosted `v0.3.0/`
  prefix with the current converter is pending.
- `--bbox` is not a fixed always-on default, it follows the
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
