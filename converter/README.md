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
| `--bands` | `0` | Number of bands. `0` derives the count from byte density, a positive value forces it. Either way the ladder is clamped so no overview band serves at or past zoom 24, which the exact band owns. |
| `--screen-budget-mb` | `1.0` | The banding budget, decoded exact geometry a screen should target, in MB. The derived band count covers the ladder up to the zoom where exact geometry fits this budget, so a lower value asks for more coarse bands. The budget solves against local byte density, measured where the data actually clusters, not the whole-extent average. Ignored when `--bands` is forced. |
| `--drop-rate` | `2.0` | Geometric per-band survivor ceiling, gpq-tiles/tippecanoe style. Higher asks for a steeper falloff toward the coarsest band. The last coarse band is capped too, so genuine overflow reaches the exact band and skips its overview instead of just moving bytes between coarse bands. Must be greater than 1.0. |
| `--thin/--no-thin` | on | Density thin the coarse bands, one survivor per pixel cell per geometry dimension, each survivor carrying its cell population in `overview_count`. `--no-thin` is a debug and before-after escape only, not a supported profile. |
| `--row-group-mb` | `16.0` | Row group byte budget in MB for the finest exact band, always cut at band boundaries. |
| `--overview-grid` | derived | Coordinate grid the overview geometry snaps to, in CRS units. When unset each coarse band derives its own grid, a quarter of that band's pixel. A set value overrides that and forces the one grid on every band. |
| `--coarse-row-groups` | `32` | Target row groups per coarse band. More groups give tighter bounding boxes so a low zoom view reads fewer features. |
| `--compression-level` | `15` | zstd compression level. Higher is smaller and slower. |
| `--page-size-kb` | `128` | Data page size in KB. The lever for the viewer's page pruning granularity, smaller pages prune finer. |
| `--importance-column` | unset | Numeric column that ranks point features, largest first. Points are ranked by grid thinning when unset. |
| `--native-geo/--no-native-geo` | on | Write `geometry` and `geom_overview` as the Parquet GEOMETRY logical type with per-row-group GeospatialStatistics, alongside the unchanged `geo` footer key. Dual write, GeoParquet 1.1 plus native 2.0-capable. |
| `--bbox/--no-bbox` | adaptive | Write the physical `bbox` covering column and its page index, Profile A, or omit it and rely solely on native geospatial statistics for row-group pruning, Profile B (requires `--native-geo`, no page-level pruning). Unset, the default follows the count/vertex regime, on for count-heavy data, off for vertex-heavy data. Either flag forces the choice explicitly. |
| `--jobs`, `-j` | `0` | Worker threads for the overview build, the slowest stage. 0 is one per core, 1 forces single-threaded. shapely releases the GIL on the simplify and snap ops, so threads speed the overview build up nearly linearly. |
| `-v`, `--verbose` | off | Verbose DEBUG logging. |
| `-q`, `--quiet` | off | Only print the JSON summary, no stage logs. |

`gpo --version` prints the package version.

The Python API mirrors the CLI, `from geoparquet_overviews import convert,
ConvertOptions`. Every CLI flag has a matching `ConvertOptions` field.

## What happens per geometry type

- Polygons rank by area, scaled by cos(latitude) on a geographic CRS so a
  high latitude polygon is not overweighted. Coarse bands get a simplified
  overview, invalid rings are repaired with `make_valid`, then a topology
  preserving simplify and a grid snap. A shape that collapses below the band
  pixel writes a small grid-aligned quad sized by its own area instead, the
  same idiom as Tippecanoe's tiny-polygon reduction, so a polygon survivor
  always paints as a polygon and larger features paint larger. Only a feature
  whose quad also fails is NULL, never empty WKB.
- Lines rank by length. The overview is simplify plus snap, falling back to
  the unsnapped simplified line when the snap collapses it to empty, then to
  a short segment along the line's own direction, so a line survivor always
  paints as a line.
- Points rank by `--importance-column` when one is named, otherwise pure
  spatial thinning decides the survivor of each cell. A pure point dataset
  writes no `geom_overview` column at all, the banding itself is the level of
  detail. In a mixed layer, coarse band points copy their exact geometry into
  the overview, it is already minimal.
- Banding itself is density thinning, not a fixed feature share. Every feature
  starts in the coarsest band, and for each band from coarsest to finest the
  converter keeps one survivor per screen pixel per geometry dimension and
  demotes the rest to the next finer band. The survivor is the highest ranked
  feature in the cell, so an extent spanning line or a large polygon reaches
  band 0 while its smaller neighbours fall to finer bands. No feature leaves the
  file, the finest band is exact and keeps everyone demoted into it.
- Each survivor carries the density it stands for. The `overview_count` column
  records how many features, itself included, competed for the survivor's cell
  in the pass it won, null on the finest band. One survivor per pixel would
  otherwise make a dense city and a sparse village paint identically, the count
  lets a viewer scale the survivor's symbol so the cluster stays visible.
- Null and empty geometries are legal input. They are pinned to the finest
  band with a null `bbox` and a null overview.

The footer records what was actually done, `importance` is `area_desc`,
`length_desc`, `attribute:<column>`, `grid_thin`, or `mixed_quantile_desc`,
`overview_method` is `simplify_snap`, `thin`, or `none` for a single-band file
where nothing was reduced, and `count_column` names the survivor count column
when thinning wrote one.

## CRS awareness

The converter preserves the source coordinate reference system on both
geometry columns, and every other field the source `geo` block carried, such
as `edges` and `epoch`, survives the round trip. Simplification tolerances,
the per-band snap grids, each level's `gsd`, and `max_zoom` are all derived
from the dataset extent in the data's own units, so lon and lat degrees and
projected metres both work without manual tuning. Use `--overview-grid` only
to override the derived per-band grids, it forces its one grid on every band.
A projected file reads back in a SQL engine with its real CRS, for example
`GEOMETRY('EPSG:3067')`.

## What a conversion looks like

Every stage logs to stderr. Abridged output from a real run.

```
reading input.parquet
read 5651275 rows, 21 columns in 0.4s, geometry column 'geometry'
source CRS: EPSG:3067 ETRS89 / TM35FIN(E,N), treated as projected metres
decoded 5651275 geometries and computed area+length+bounds in 1.6s
extent 6.668e+05 x 1.148e+06 units
local byte density 0.0256 B/unit^2 (whole-extent average 0.000811, 31.5x clustering)
using 5 bands (derived from local byte density) anchored at coarsest zoom 7, regime 'count'
ranked by importance 'area_desc', overview method 'simplify_snap'
  band 0: 5651275 -> 141594 features after thinning
  band 1: 0 -> 753536 features after thinning
  band 2: 0 -> 2101935 features after thinning
  band 3: 0 -> 2470761 features after thinning
  band 0: 141594 features (2.5%), coarse preview
  band 1: 753536 features (13.3%), mid zoom
  band 2: 2101935 features (37.2%), mid zoom
  band 3: 2470761 features (43.7%), mid zoom
  band 4: 183449 features (3.2%), exact detail
sorted band-major, Hilbert within each band
building overview column across 10 thread(s)
  band 0 overview: 141594 features, tol=1223 grid=305.7, exact 18.95 MB -> overview 13.16 MB (31% smaller)
  band 1 overview: 753536 features, tol=305.7 grid=76.44, exact 86.80 MB -> overview 69.90 MB (19% smaller)
  band 2 overview: 2101935 features, tol=76.44 grid=19.11, exact 233.58 MB -> overview 191.12 MB (18% smaller)
  band 3 overview: 2470761 features, tol=19.11 grid=4.777, exact 261.91 MB -> overview 200.87 MB (23% smaller)
planned 130 row groups at a 16.0 MB budget, band last-row-group ends {0: 31, 1: 63, 2: 95, 3: 127, 4: 129}
preview cost: band 0 overview ~13.16 MB vs full exact geometry 620.29 MB (47x less to first paint)
```

Read the log top to bottom and the story is the design. The dataset clusters
31.5x above its whole-extent average, so the budget derives five bands, four
coarse plus exact, anchored where Finland fills the screen at zoom 7. Thinning
starts every feature in band 0 and demotes the crowd down the ladder, band 0
keeps one survivor per pixel, 2.5% of the file, each carrying its cell
population in `overview_count`. The overview shrinks each coarse band against
its own zoom-matched grid, and band 0, mostly small area-sized quads at that
scale, decodes 13.16 MB against 620 MB of exact geometry. On disk the band 0
overview column is about 2 MB compressed, the whole-country first paint, the
lattice-aligned quads compress about 6.6x. The modest per-band shrink
percentages are honest for buildings, a snapped four-point footprint is
already near minimal, the byte win at fine coarse bands comes from thinning,
band 2 holds 2.1M of the 5.65M features.

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

A whole country preview reads the band 0 overview column, about 2 MB
compressed, instead of the 620 MB exact geometry column.

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
