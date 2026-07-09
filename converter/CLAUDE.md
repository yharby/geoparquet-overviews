# converter/CLAUDE.md

## What this is

The reference writer for the geoparquet-overviews convention. Python, pyarrow
plus shapely plus click. Package `geoparquet_overviews`, dist
`geoparquet-overviews`, CLI `gpo`. It reads any GeoParquet, ranks features by
importance into bands, Hilbert sorts within each band, adds a simplified
`geom_overview` column on coarse bands, and writes the `overviews` footer
block. The convention itself is normative in [../SPEC.md](../SPEC.md), do not
restate or reinterpret it here, and the rationale is in
[../DESIGN.md](../DESIGN.md).

## Commands

```bash
uv sync                                       # install deps
uv run pytest                                 # all tests
uv run pytest tests/test_convert.py::test_reconvert_is_idempotent   # one test
uv run gpo convert in.parquet out.parquet     # convert, -v verbose, -q quiet
uv run python examples/make_sample.py         # rebuilds viewer/public/sample.parquet
uv run ruff check                             # lint
uv run --with duckdb python - <<'PY'          # duckdb is NOT a project dep, pull it per run
import duckdb; print(duckdb.sql("SELECT count(*) FROM 'out.parquet'").fetchone())
PY
```

DuckDB is handy for a row-count or read sanity on an output, but it is not in
the converter's dependencies. Run it with `uv run --with duckdb` rather than
adding it to the project.

## Architecture, convert.py as a pipeline

`convert()` in `src/geoparquet_overviews/convert.py` runs the whole pipeline
in order. Footer JSON builders live in `footer.py`, the CLI in `cli.py`.

1. Read. `pq.read_table(src)`, whole table in memory.
2. Resolve geometry column. `_find_geometry_column` reads the `geo` footer's
   `primary_column`, falls back to a column named `geometry`.
   `_source_column_meta` keeps the source column's full `geo` entry so `edges`,
   `orientation`, `epoch` survive. Only WKB encoding is accepted.
3. CRS handling. `_is_geographic` decides degrees vs metres, preferring
   `_pyproj_is_geographic` when pyproj is installed, else
   `_projjson_is_geographic` for a PROJJSON dict or `_crs_code` against
   `_GEOGRAPHIC_CODES`. Picks the world span for `_zoom_for_gsd`.
4. Decode and measure. `shapely.from_wkb`, then `bounds`, `area`, `length`,
   `get_dimensions`. Null and empty geometries get a `valid` mask, the dataset
   extent and derived snap grid come from the valid bounds.
5. Band count and assignment. The band count is derived from local byte
   density by `_derive_bands` (a positive `--bands` overrides it), anchoring
   the ladder in absolute web zoom so band 0 is a genuine zoomed-out pixel.
   The density comes from `_local_byte_density`, a byte-weighted 0.9 quantile
   over a 128x128 grid of bbox centroids, so clustered data derives the bands
   its dense screens need instead of the whole-extent average. Both derived
   and forced counts are clamped by `_max_coarse_for_zoom`, no overview band
   serves at or past `_FINE_MAX_ZOOM`. `_assign_bands` ranks each dimension
   cohort into a percentile `score` via `_percentile_desc`, area for polygons
   with cos latitude scaling, length for lines, `_importance_values` or an
   unscored spatial fallback for points, and starts every valid feature in
   band 0. Density thinning (`_thin_bands`) is the sole banding mechanism, it
   demotes the over-dense features down the ladder and returns each survivor's
   cell population, which becomes the `overview_count` column (null on the
   finest band, band 0's counts sum to the full valid total only when no
   per-band budget binds, see below). Null and empty rows
   are pinned to the finest band, empty bands are merged and renumbered
   contiguously, and a file that collapses to a single band writes
   `overview_method` `"none"`.

   `_thin_bands` also applies an optional per-band survivor budget from
   `_band_budgets`, `budget(b) = n_valid / drop_rate ** (finest - b + 1)`
   (`--drop-rate`, default 2.0), a second demotion source on top of cell
   contention. Unlike gpq-tiles' own formula the last coarse band is capped
   too, so real overflow reaches the exact band and skips its overview
   entirely, the only way the cap actually shrinks the file rather than
   reshuffling bytes between coarse bands. A budget-demoted cell winner's
   tally is cleared at the band it lost and recounted in the finer band it
   falls into, so when the budget binds band 0, its survivor counts can sum
   to less than the file's valid total. Each survivor's own count stays the
   exact population of the cell it won.
6. Hilbert sort. `_hilbert_distance` on quantized bbox centroids, then
   `np.lexsort((hilbert, band))`, band major, Hilbert minor.
7. Overview build. `_build_overview` calls `_overview_band` per coarse band,
   which fans `_overview_values` across `jobs` threads, with tolerances from
   `_overview_tolerances`, snapping through `_snap_safe`. A pure point dataset
   skips this, `overview_method == "thin"`. See the Parallelism section.
8. Row group planning. `_plan_row_groups`, coarse bands split into near equal
   chunks up to `coarse_row_groups`, the finest band cut by the exact geometry
   byte budget, every cut at a band boundary.
9. Column assembly. Pre-existing `geometry`, `geom_overview`, `band`, `bbox`,
   and `overview_count` columns are dropped so re-conversion is idempotent.
   Coarse band bboxes are padded by grid/2 because snapping can move overview
   vertices outward. `_bbox_struct` builds the covering with null structs for
   invalid rows. `overview_count` is written as int32 when thinning ran and
   coarse bands exist, pure-point files included.
10. Footer. `footer.geo_meta` and `footer.overviews_meta`, levels built from
    the real row group plan with `_zoom_for_gsd`, ladder kept strictly
    increasing. Overview geometry types recomputed via
    `_geometry_type_names_from_wkb`.
11. Write. `_write`, zstd, `write_page_index=True`, BYTE_STREAM_SPLIT on
    doubles, dictionary on strings, `sorting_columns` declaring `band`. When
    native geo types are on (the default), `geometry` and `geom_overview` are
    extension typed and get statistics too, so pyarrow computes per-row-group
    GeospatialStatistics on them. With `--no-native-geo` they stay plain WKB
    and are excluded from statistics like before. The `geo` footer key is set
    on the schema metadata before any row group is written. The `overviews`
    key is not, it is added afterward via `writer.add_key_value_metadata`
    inside `_write`'s `late_kv` callback, once every row group has actually
    been written and `sink.tell()` has recorded each one's real `(start, end)`
    byte offsets. `levels[].bytes` needs those offsets and they do not exist
    until the bytes have landed, so `overviews` cannot be finalized any
    earlier without a second pass over the file.

## Two profiles, `--native-geo` and `--bbox`

`--native-geo/--no-native-geo` (default on) wraps the WKB `geometry` and
`geom_overview` columns in the `geoarrow.wkb` extension type before writing
them, via `_wkb_extension_type`. pyarrow 21+ turns that into the Parquet
GEOMETRY logical type on write and computes GeospatialStatistics per row
group. The `geo` footer key is written regardless, still WKB encoded, still
version `"1.1.0"`, so the file is a dual write, valid GeoParquet 1.1 and
native-2.0-capable at once. The `overviews` key's version is `"0.3.0"` for
this converter regardless of `--native-geo`, since `levels[].extent` and
`levels[].bytes` are written either way. Draft 0.3.0 also enriches each level
with `min_zoom` (the pair to `max_zoom`), `grid` (the band's per-band snap
grid as a positional `origin` and `cell_size`, null on the finest exact band),
and `feature_count`, and adds a top-level `regime` label (count-heavy versus
vertex-heavy) alongside `importance` and a top-level `count_column` naming the
`overview_count` survivor count column when thinning wrote one.

`--bbox/--no-bbox` (default adaptive, follows the count/vertex regime,
Profile A for count-heavy data, Profile B for vertex-heavy data) controls
whether the physical `bbox` covering struct column, its `geo` covering entry,
and its page index and statistics get written at all. `--no-bbox` (Profile B)
drops all of that and leans entirely on native GeospatialStatistics for
row-group pruning. `_validate_options` raises only on an *explicit*
`--no-bbox` combined with `--no-native-geo`, since that combination would
leave the file with no pruning surface whatsoever, an *adaptive* resolution
that would land on bbox-off with `--no-native-geo` in effect is silently
forced back to bbox-on instead. Profile B has no page-level pruning, Parquet
has no page-level geospatial statistics, only row-group ones.

## Re-conversion of a native-typed file

Re-converting a 0.2.0 file whose `geometry` and `geom_overview` columns
already carry native GEOMETRY logical types is idempotent, and needed no new
code to make it so. The drop list in `convert()` still removes any
pre-existing `geometry`, `geom_overview`, `band`, and `bbox` columns before
the pipeline rebuilds them (step 9 above). On the decode side, reading the
extension-typed column back with `pq.read_table` and calling
`.combine_chunks().to_numpy(zero_copy_only=False)` already returns the raw
WKB bytes `shapely.from_wkb` expects, the same as it would for a plain binary
column. There is no separate unwrap step, the native read path and the plain
WKB read path converge on the same bytes by the time `convert()` decodes
geometry.

## Invariants, do not break these

- The exact `geometry` column is never modified. `make_valid` and `simplify`
  run only on the overview path in `_overview_values`.
- The footer is honest. `importance` and `overview_method` record what was
  actually done, never a hardcoded claim. A single-band file says `none`.
- A coarse survivor whose shape collapses below its band pixel keeps its own
  dimension, a polygon writes a small area-sized grid-aligned quad
  (`_quad_fallback`) and a line writes a short oriented segment
  (`_segment_fallback`), never NULL, so the preview never blanks and only
  point features paint as points. Coarse coverings pad by half the band
  tolerance to enclose the quad. NULL remains only for a feature whose
  fallback also fails, and empty WKB is never written.
- Row groups always cut at band boundaries, coarse bands land in a contiguous
  row group prefix.
- Names are fixed by the convention. Footer key `overviews` parallel to `geo`,
  columns `geom_overview`, `band`, `bbox`. Do not rename.
- Re-converting a converted file is idempotent, the drop list in `convert()`
  and the covering strip in `footer.geo_meta` guarantee it, native geo types
  included, see the re-conversion section above.
- Null and empty geometries stay legal, finest band, null `bbox`, null
  overview, excluded from the dataset extent.
- Coarse band `bbox` values stay padded by grid/2, a viewer pruning on bbox
  must never drop a feature the overview still paints.

## Testing

Tests live in `tests/test_convert.py`, small synthetic tables built inline,
no fixtures on disk. They cover footer contents, geometry preservation, row
group planning, null and empty segregation, invalid polygon repair,
idempotent re-conversion, CRS detection and preservation, point thinning and
attribute ranking, line and mixed layer banding, and bbox padding. Run one
test with `uv run pytest tests/test_convert.py::<name>`. Add a test alongside
any pipeline change, especially anything touching an invariant above.

Caution on re-conversion tests. The inline tables are built fresh, so they
carry no pre-existing `geo` covering, `overviews` block, or native geometry
types. That means a fresh-table test can pass while re-conversion of a real
prior converter output still misbehaves. A `--no-bbox` re-conversion of a file
that already had a covering once shipped a dangling covering exactly this way,
the fresh-table test never exercised the strip in `footer.geo_meta`. When you
touch footer building, the drop list, or the profiles, add a test that first
converts, then re-converts that output, and asserts the second file, not just
a synthetic one. `test_reconvert_native_output_is_idempotent` is the tripwire
for native-typed round trips, never weaken it.

## Large WKB columns, past 2 GB

Arrow's `binary` type uses int32 value offsets, so one contiguous `binary`
array holds at most 2 GB of payload. A WKB geometry column larger than that
cannot be fused into a single `binary` array without an offset overflow, and
the converter used to do exactly that on both read and write, so any input
with more than ~2 GB of WKB (roughly a whole country of buildings) crashed
with `ArrowInvalid: offset overflow`. Both sides now handle it. On read,
`_decode_wkb` decodes the geometry column chunk by chunk, each row-group chunk
is already under the limit, and concatenates the shapely results instead of
calling `combine_chunks()`. It also drops the source geometry column before the
Hilbert `take`, so the exact WKB is never reordered into one array only to be
discarded. On write, `_geom_array` measures the payload and, past
`_MAX_BINARY_BYTES` (2^31 - 1), builds `large_binary` (int64 offset) storage
and wraps it with `ga.large_wkb()` instead of `ga.wkb()`. The extension's
declared storage must match the array it wraps, a `binary` extension over a
`large_binary` array miswrites its offsets and fails on write, which is why the
two are paired. Small outputs stay on `binary` exactly as before, so nothing
changes for the common case. Parquet stores both as `BYTE_ARRAY`, so a reader
sees no difference. Individual WKB values still must stay under 2 GB, but a
single feature that large is not a real case.

## Parallelism, `--jobs`

The overview build is the converter's slowest stage, `simplify`, `make_valid`,
and `set_precision` on the coarse-band geometry. shapely 2.x runs those as
GEOS-backed numpy ufuncs that release the GIL, so plain Python threads
parallelize them nearly linearly, no multiprocessing and no geometry pickling.
Measured on a 10-core machine, threads over a batch of detailed polygons cut
`simplify` plus `set_precision` by about 5x at 8 threads and `make_valid` by
about 2.8x. `from_wkb` and `to_wkb` barely move, they are Python-object bound,
so only the overview build is threaded, read and write already thread inside
pyarrow.

`_overview_band` splits a band's features into chunks and runs `_overview_values`
on each through a `ThreadPoolExecutor`, then concatenates in order. The overview
is a pure per-feature transform, so the threaded result is byte-identical to the
single-threaded one, `test_threaded_overview_matches_single_thread` and
`test_overview_band_chunking_preserves_order` are the tripwires, never weaken
them. Chunk count is oversubscribed to `jobs * 4`, not one chunk per thread, on
purpose. A band can be a handful of whole-country multipolygons that each cost
seconds, and equal row splits would strand every thread but one, so more, smaller
chunks let the pool balance uneven geometry. A single enormous multipolygon is
still one GEOS call and cannot be split, so a file that is a few giant geometries
parallelizes across features but not within one.

`ConvertOptions.jobs` and the `--jobs/-j` CLI flag control it. 0 (default) is one
thread per core, 1 forces single-threaded, and `_validate_options` rejects a
negative count. Overall speedup follows Amdahl, near the full multiple on a
geometry-heavy file where the overview build dominates, smaller when zstd write
and WKB serialize are a large share of the wall time.

## Known limitations

- Whole table in memory, not streaming. Tens of millions of features fit in a
  few GB.
- zstd level 15 is slow to write. `--compression-level` lowers it.
