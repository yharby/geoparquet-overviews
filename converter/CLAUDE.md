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
```

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
    and are excluded from statistics like before.

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
  and the covering strip in `footer.geo_meta` guarantee it.
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

## Known limitations

- Whole table in memory, not streaming. Tens of millions of features fit in a
  few GB.
- zstd level 15 is slow to write. `--compression-level` lowers it.
