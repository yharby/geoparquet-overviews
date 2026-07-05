# geoparquet-overviews converter

Convert any GeoParquet file into the overviews layout, one file a browser can
preview instantly and a SQL engine can read in full. The convention is defined
in [SPEC.md](../SPEC.md) and the full rationale is in [DESIGN.md](../DESIGN.md).
This package is the reference writer.

## Install and quickstart

Requires Python 3.12 or newer.

```bash
cd converter
uv sync
uv run gpo convert input.parquet output.parquet
```

The command prints stage logs to stderr and a JSON summary to stdout.

## CLI reference

`gpo convert SRC DST` takes these options.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--bands` | `3` | Number of importance bands. |
| `--row-group-mb` | `16.0` | Row group byte budget in MB for the finest exact band, always cut at band boundaries. |
| `--overview-grid` | derived | Coordinate grid the overview geometry snaps to, in CRS units. Derived from the dataset extent when unset. |
| `--coarse-row-groups` | `32` | Target row groups per coarse band. More groups give tighter bounding boxes so a low zoom view reads fewer features. |
| `--compression-level` | `15` | zstd compression level. Higher is smaller and slower. |
| `--page-size-kb` | `128` | Data page size in KB. The lever for the viewer's page pruning granularity, smaller pages prune finer. |
| `--importance-column` | unset | Numeric column that ranks point features, largest first. Points are ranked by grid thinning when unset. |
| `--native-geo/--no-native-geo` | on | Write `geometry` and `geom_overview` as the Parquet GEOMETRY logical type with per-row-group GeospatialStatistics, alongside the unchanged `geo` footer key. Dual write, GeoParquet 1.1 plus native 2.0-capable. |
| `--bbox/--no-bbox` | on | Write the physical `bbox` covering column and its page index, Profile A. `--no-bbox` (Profile B) omits it and relies solely on native geospatial statistics for row-group pruning, requires `--native-geo` and has no page-level pruning. |
| `--jobs`, `-j` | `0` | Worker threads for the overview build, the slowest stage. 0 is one per core, 1 forces single-threaded. shapely releases the GIL on the simplify and snap ops, so threads speed the overview build up nearly linearly. |
| `-v`, `--verbose` | off | Verbose DEBUG logging. |
| `-q`, `--quiet` | off | Only print the JSON summary, no stage logs. |

`gpo --version` prints the package version.

The Python API mirrors the CLI, `from geoparquet_overviews import convert,
ConvertOptions`. `ConvertOptions` additionally exposes `band_fractions`, the
per band feature count shares, which the CLI does not.

## What happens per geometry type

- Polygons rank by area, scaled by cos(latitude) on a geographic CRS so a
  high latitude polygon is not overweighted. Coarse bands get a simplified
  overview, invalid rings are repaired with `make_valid`, then a topology
  preserving simplify and a grid snap. A degenerate result is written as NULL,
  never empty WKB.
- Lines rank by length. The overview is simplify plus snap, falling back to
  the unsnapped simplified line when the snap collapses it to empty.
- Points rank by `--importance-column` when one is named, otherwise by grid
  thinning, where a point becomes the representative of its grid cell at the
  coarsest band with a free cell. A pure point dataset writes no
  `geom_overview` column at all, the banding itself is the level of detail. In
  a mixed layer, coarse band points copy their exact geometry into the
  overview, it is already minimal.
- Mixed layers turn each dimension cohort into a percentile rank and band the
  merged ranks, so an extent spanning line can reach band 0 alongside the
  largest polygons.
- Null and empty geometries are legal input. They are pinned to the finest
  band with a null `bbox` and a null overview.

The footer records what was actually done, `importance` is `area_desc`,
`length_desc`, `attribute:<column>`, `grid_thin`, or `mixed_quantile_desc`,
and `overview_method` is `simplify_snap` or `thin`.

## CRS awareness

The converter preserves the source coordinate reference system on both
geometry columns, and every other field the source `geo` block carried, such
as `edges` and `epoch`, survives the round trip. Simplification tolerances,
the snap grid, each level's `gsd`, and `max_zoom` are all derived from the
dataset extent in the data's own units, so lon and lat degrees and projected
metres both work without manual tuning. Use `--overview-grid` only to override
the derived snap grid. A projected file reads back in a SQL engine with its
real CRS, for example `GEOMETRY('EPSG:3067')`.

## What a conversion looks like

Every stage logs to stderr. Abridged output from a real run.

```
reading input.parquet
read 5651275 rows, 18 columns in 0.3s, geometry column 'geom'
source CRS: EPSG:3067 ETRS89 / TM35FIN(E,N), treated as projected metres
decoded 5651275 geometries and computed area+length+bounds in 1.6s
ranked by importance 'area_desc', overview method 'simplify_snap'
  band 0: 169538 features (3.0%), coarse preview
  band 1: 1525845 features (27.0%), mid zoom
  band 2: 3955892 features (70.0%), exact detail
sorted band-major, Hilbert within each band
  band 0 overview: 169538 features, tol=765 grid=19.13, exact 34.39 MB -> overview 9.27 MB (73% smaller)
  band 1 overview: 1525845 features, tol=191.3 grid=19.13, exact 194.54 MB -> overview 36.78 MB (81% smaller)
planned 41 row groups at a 16.0 MB budget, band last-row-group ends {0: 2, 1: 15, 2: 40}
preview cost: band 0 overview ~9.27 MB vs full exact geometry 620.29 MB (67x less to first paint)
```

Coarse bands are split into up to `--coarse-row-groups` near equal row groups
by feature count. Because features are Hilbert ordered within a band, near
equal chunks are spatially tight, so a low zoom map view prunes them by
bounding box. The finest exact band is cut by the byte budget, which suits a
SQL engine, and a floor keeps tiny datasets from fragmenting.

## Real-world example

The numbers above are from the Finnish national buildings dataset, 5.65
million polygons in EPSG:3067 metres. The converted output is hosted on
source.coop, ready to load in the viewer or query with a SQL engine.

```bash
curl -O https://data.source.coop/youssef-harby/geoparquet-overviews/nls_rakennus_overviews.parquet
```

To reproduce the conversion, run the converter on that file. Conversion is
idempotent, pre-existing `geom_overview`, `band`, and `bbox` columns are
dropped and rebuilt, so converting a converted file yields the same layout.

```bash
uv run gpo convert nls_rakennus_overviews.parquet nls_rakennus_reconverted.parquet
```

A whole country preview reads the band 0 overview, about 9 MB, instead of the
620 MB exact geometry column.

## Rebuild the demo sample

The viewer loads a tiny synthetic file by default. Regenerate it with

```bash
uv run python examples/make_sample.py
```

which writes `viewer/public/sample.parquet`.

## Run the tests

```bash
uv run pytest
```

## Known limitations

- The whole table is read into memory. Fine for tens of millions of features,
  a few GB, but this is not a streaming converter. The RAM footprint, not
  Arrow's 2 GB binary offset, is the ceiling now. A WKB geometry column past
  2 GB is handled, decoded chunk by chunk and written as `large_binary` when
  it would overflow, so a whole-country file converts as one file.
- The default zstd level 15 write is slow and small on disk. Pass a lower
  `--compression-level` for faster conversions. The overview build, the other
  slow stage, threads over `--jobs` workers by default.
