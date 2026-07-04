# CLAUDE.md

## What this is

`geoparquet-overviews` is a proposal for the GeoParquet community. It defines one
GeoParquet file that a web map can preview instantly and a SQL engine can read in
full, with no duplicated exact geometry. It is a draft convention plus a
reference converter and a live viewer. Status draft 0.2.0, Apache-2.0. This is a
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
  far more area than the view (about 4x or more) and the file carries the Parquet
  page indexes, it reads the `bbox` covering column's ColumnIndex and OffsetIndex,
  maps the view to the overlapping page row ranges, and reads geometry with
  hyparquet's offset-index option so only overlapping pages are fetched. Any
  failure falls back to a whole-group read.
- Viewer reprojects projected files to lon and lat in the browser with proj4
  (v2.20.9, which ships its own types, do not add `@types/proj4`). Known
  projected CRS defs live in the `PROJ_DEFS` registry in `crs.ts`, seeded with
  EPSG:3067. Unknown projected codes show a notice instead of a broken render.
- Validated end to end on a real 5.65M-row EPSG:3067 buildings dataset. A
  whole-country preview reads ~9 MB (band 0 overview) vs ~620 MB exact geometry,
  ~67x less. The viewer renders it correctly over Finland.
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
