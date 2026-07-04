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
5. Band assignment. `_assign_bands` ranks per dimension cohort, area for
   polygons with cos latitude scaling, length for lines, `_importance_values`
   or `_thin_points` for points, merged via `_percentile_desc` and cut by
   `_band_by_fraction` with `_band_edges`. Null and empty rows are pinned to
   the finest band, empty bands are merged and renumbered contiguously.
6. Hilbert sort. `_hilbert_distance` on quantized bbox centroids, then
   `np.lexsort((hilbert, band))`, band major, Hilbert minor.
7. Overview build. `_build_overview` calls `_overview_values` per coarse band
   with tolerances from `_overview_tolerances`, snapping through `_snap_safe`.
   A pure point dataset skips this, `overview_method == "thin"`.
8. Row group planning. `_plan_row_groups`, coarse bands split into near equal
   chunks up to `coarse_row_groups`, the finest band cut by the exact geometry
   byte budget, every cut at a band boundary.
9. Column assembly. Pre-existing `geometry`, `geom_overview`, `band`, `bbox`
   columns are dropped so re-conversion is idempotent. Coarse band bboxes are
   padded by grid/2 because snapping can move overview vertices outward.
   `_bbox_struct` builds the covering with null structs for invalid rows.
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
native-2.0-capable at once. The `overviews` key's version is `"0.2.0"` for
this converter regardless of `--native-geo`, since `levels[].extent` and
`levels[].bytes` are written either way.

`--bbox/--no-bbox` (default on = Profile A) controls whether the physical
`bbox` covering struct column, its `geo` covering entry, and its page index
and statistics get written at all. `--no-bbox` (Profile B) drops all of that
and leans entirely on native GeospatialStatistics for row-group pruning.
`_validate_options` raises if `--no-bbox` is combined with `--no-native-geo`,
since that combination would leave the file with no pruning surface
whatsoever. Profile B has no page-level pruning, Parquet has no page-level
geospatial statistics, only row-group ones.

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
  actually done, never a hardcoded claim.
- A degenerate overview result is NULL, never empty WKB.
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

## Known limitations

- Whole table in memory, not streaming. Tens of millions of features fit in a
  few GB.
- zstd level 15 is slow to write. `--compression-level` lowers it.
