# Design

Why geoparquet-overviews looks the way it does. This document carries the full
rationale, the footer walkthrough, the measured results, and the ecosystem
positioning. The short tour is the [README](README.md). The normative
convention, with the exact requirements a writer and a reader follow, lives in
[SPEC.md](SPEC.md). Everything here is explanatory.

## The gap this fills

Apache Parquet (format 2.11+) has native GEOMETRY and GEOGRAPHY logical types,
and GeoParquet 2.0 (release candidate) adopts them, so typing, CRS, and
row-group bbox statistics are a solved problem. What remains unsolved is the
access pattern that web maps actually have. Zoomed out is the expensive case.
A whole-extent view intersects every row group, so bbox pruning skips nothing,
and there is no smaller copy of the geometry to read.

| Capability | Parquet 2.11+ | GeoParquet 2.0 RC | This proposal |
| --- | --- | --- | --- |
| Geometry typing and CRS | Native logical types, WKB | Required, native | Unchanged, fully compatible |
| Row-group bbox pruning | GeospatialStatistics | Native statistics | Kept, plus a bbox covering column |
| Page-level spatial pruning | None, ColumnIndex has no geospatial entry | None | Client-side, via the covering column's page index |
| Reduced-resolution geometry | None | None | `geom_overview` column on coarse bands |
| What to read first | None | None | `overviews` footer, band per zoom range |
| Layout guarantee | None | Hilbert sort is best practice, not normative | Band-major order is the convention |

Two details matter here. Parquet's geospatial statistics live only at
row-group granularity, the page ColumnIndex has no geospatial variant and the
sort order of geometry columns is undefined, so page-level spatial pruning has
no native path and none is proposed. And GeoParquet 2.0 drops the 1.1 bbox
covering column in favor of those native statistics, which is fine for
row-group skipping but removes the only structure a client can use to prune
below a row group. This convention keeps the covering column and gives it that
second job.

The common alternative is a tile pyramid (PMTiles, vector tiles) next to the
data. That gives instant maps but stores every shape twice, quantized and
lossy on the tile side, and the tiles are unreadable by SQL engines. Here the
only extra geometry is one simplified column on a small fraction of rows, in
plain WKB that every reader already decodes.

## The idea in depth

1. **Fraction banding with a band-0 coverage pass.** Coarse bands take a small
   importance-ranked slice of the features, largest first. Band 0 gets the
   smallest slice and each finer coarse band about doubles it, ten percent of
   the features across all coarse bands by default, and the exact final band
   keeps the large remainder. That smallest-slice-then-doubling split is how
   the non-survivors of the band-0 thinning pass below are fraction-banded into
   the finer coarse bands, under the default thinning path band 0 itself is
   replaced by the even-coverage thinning survivors over all valid features, so
   band 0 can end up larger than band 1, not smaller. Every coarse feature
   carries an overview copy, so keeping the coarse cohort small is what keeps
   the overview column light, and
   the depth cap stops the ladder where a screen of exact geometry read with
   page pruning is already affordable. Band 0 alone is then density thinned to
   one survivor per pixel per geometry dimension over all valid features, so its
   whole-extent coverage stays even instead of clustering where the importance
   rank is densest, and each band-0 survivor records how many features competed
   for its cell in an `overview_count` column, so the density signal thinning
   removes from the geometry survives in the data and a viewer can scale a
   survivor's symbol, keeping a dense city distinguishable from a sparse
   village. The number of bands is derived from the data, not fixed, and the
   derivation measures byte density where the data actually sits, not averaged
   over the bounding box, so clustered data gets the coarse bands its dense
   screens need. Within a band a Hilbert sort keeps neighbors close so bbox
   statistics stay tight.
2. **An overview column.** Coarse bands carry a simplified, grid-snapped copy
   of their shape in a second geometry column named `geom_overview`. Each coarse
   band snaps to its own grid, a fraction of that band's pixel, so it carries
   only the coordinate precision it paints. The finest band leaves the overview
   null. The primary `geometry` column is never touched.
3. **A footer note.** An `overviews` key next to the standard `geo` key
   records which row-group prefix belongs to which band, which zooms each band
   serves, and how many features it holds. Unknown keys are ignored, so every
   existing reader sees a valid GeoParquet file and reads every row at exact
   precision.

Because rows are band-major, coarsest band first, a preview is a contiguous
prefix of the file. A client that knows nothing but the footer can fetch band
0 in a handful of sequential range requests, and each further band it needs is
another contiguous run of row groups. That is the same trick Cloud Optimized
GeoTIFF plays with raster overviews, applied to a columnar vector file.

## The `overviews` footer block

One additive, optional JSON key in the Parquet file-level metadata, parallel
to `geo`. The field semantics below are explanatory, the normative definitions
live in [SPEC.md](SPEC.md).

```json
{
  "version": "0.3.0",
  "spatial_key": "hilbert",
  "importance": "area_desc",
  "regime": "count",
  "covering": {
    "bbox": {
      "xmin": ["bbox", "xmin"],
      "ymin": ["bbox", "ymin"],
      "xmax": ["bbox", "xmax"],
      "ymax": ["bbox", "ymax"]
    }
  },
  "overview_column": "geom_overview",
  "overview_method": "simplify_snap",
  "count_column": "overview_count",
  "levels": [
    { "level": 0, "row_group_end": 0,  "min_zoom": 0, "max_zoom": 2,  "gsd": 0.3516,
      "grid": { "origin": [0, 0], "cell_size": [0.0879, 0.0879] },
      "feature_count": 512, "extent": [-179.1, -89.3, 179.4, 89.6], "bytes": [4096, 428112] },
    { "level": 1, "row_group_end": 6,  "min_zoom": 3, "max_zoom": 4, "gsd": 0.0879,
      "grid": { "origin": [0, 0], "cell_size": [0.0220, 0.0220] },
      "feature_count": 8192, "extent": [-179.1, -89.3, 179.4, 89.6], "bytes": [428112, 9532048] },
    { "level": 2, "row_group_end": 22, "min_zoom": 5, "max_zoom": 24, "gsd": 0.0,
      "grid": null,
      "feature_count": 5642000, "extent": [-179.1, -89.3, 179.4, 89.6], "bytes": [9532048, 62004224] }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `version` | Draft version of this convention. |
| `spatial_key` | The curve used for the within-band sort. Descriptive, readers must not depend on it. |
| `importance` | How features were ranked into bands, largest first, and which one wins each band-0 thinning cell. `area_desc` for polygons, `length_desc` for lines, `attribute:<column>` for an attribute-ranked column, `grid_thin` for points with no attribute, `mixed_quantile_desc` for a mixed-dimension layer ranked per cohort by quantile. Descriptive. |
| `regime` | A label for the data, `count` for many-feature data, `vertex` for few-heavy-geometry data, from the average bytes per feature. Descriptive, it never changes how a reader reads the file. |
| `covering` | Points at the bbox struct column, mirroring the GeoParquet covering. If present it must match the `geo` covering. |
| `overview_column` | Name of the simplified geometry column. Absent when the file has no overview column. |
| `overview_method` | How `geom_overview` was derived. `simplify_snap` for a simplified, grid-snapped copy. `thin` for a point dataset where the banding itself is the level of detail and no overview column exists. `none` for a single-band file where nothing was reduced at all. |
| `count_column` | Name of the survivor count column. Each band-0 survivor's value is how many features competed for its thinning cell, the density signal a viewer can scale symbols by, and it is null on every finer band. Absent when band-0 thinning wrote no counts. |
| `levels` | One entry per band, sorted ascending, coarsest first. |

Each `levels` entry.

| Field | Meaning |
| --- | --- |
| `level` | Band ordinal, 0 is the coarsest. |
| `row_group_end` | Index of the last row group in this band, inclusive. The band owns the prefix from row group 0. Strictly increasing across levels. |
| `min_zoom` | Lowest web zoom this band should paint, the pair to `max_zoom`. 0 on level 0, and one past the previous band's `max_zoom` on every later band, so the levels tile the zoom range with no gap. |
| `max_zoom` | Highest web zoom this band should paint, an advisory hint on the 256px WebMercator model. Strictly increasing. |
| `gsd` | Ground sample distance the band was simplified to, in CRS units per pixel, which on band 0 is also the side of the thinning cell. The final band is exact and has `gsd` 0. `gsd` is the authoritative resolution signal. |
| `grid` | The band's own coordinate snap grid, `{ origin, cell_size }` in CRS units, a sub-pixel fraction of the band's `gsd`. `origin` is the lattice anchor, `[0, 0]` since the snap runs from coordinate zero. Null on the final band, which has no overview. |
| `feature_count` | How many features are in the band. Sums across levels to the row count, so the footer attests no feature was lost. Lets a reader price a level before reading it. |
| `extent` | Padded bounding box of the band's own features, `[xmin, ymin, xmax, ymax]` in CRS units, or null when the band has no valid geometry. Encloses both the exact and the overview geometry of the band. Optional. |
| `bytes` | File byte offsets `[start, end)` spanning this band's own row groups. Contiguous across bands, so a reader can price a prefix read up to any band. Optional. |

## Layout rules

Stated here in explanatory form, the normative wording is in
[SPEC.md](SPEC.md).

- Coarse bands are formed by an importance fraction, largest first, a small
  slice of the features across all coarse bands with the exact final band
  keeping the large remainder. Band 0 alone is then density thinned to one
  survivor per pixel per geometry dimension over all valid features, so its
  coverage stays even. The number of bands is derived from the data by a
  decoded-bytes-per-screen budget, so dense many-feature data and sparse
  heavy-geometry data each get the band count they need. The budget solves
  against local byte density, a byte-weighted high quantile over a grid laid on
  the extent, because the whole-extent average understates the dense screens a
  user actually zooms into and would hand off to the exact band too
  early. No coarse band ever serves at or past the zoom model's finest zoom,
  where an overview would just be exact geometry grid-snapped. No feature is
  dropped, only moved to a finer band.
- Rows are band-major, then ordered by the `spatial_key` curve within each
  band. A small int16 `band` column records each row's band.
- Coarse bands carry `geom_overview`, the finest band leaves it null. The
  primary `geometry` column is always exact and untouched.
- Row groups cut at band boundaries, so `row_group_end` is exact. Coarse bands
  split into many near-equal row groups so a low-zoom view prunes tightly,
  the finest band cuts by byte budget so range reads stay a similar size.
- The source CRS is preserved on both geometry columns. The overview ladder runs
  in absolute web zoom, with its coarsest band anchored at the zoom where the
  dataset extent fills a screen rather than at whole-world zoom, so a city-scale
  file never spends bands on zooms where its extent is a speck. Tolerances, the
  per-band snap grids, gsd, and zooms derive from the data in its own CRS units,
  so degrees and metres both work.
- The file keeps the GeoParquet bbox covering and writes the Parquet Page
  Index, which together enable the client-side page pruning below. This holds
  even under GeoParquet 2.0, where the covering column is otherwise dropped.
- The writer also declares `sorting_columns`, applies BYTE_STREAM_SPLIT to
  doubles, and compresses with zstd, standard Parquet features.

## How a client reads it

| Reader | What it reads |
| --- | --- |
| Browser, first paint | The footer, then the `geom_overview` chunks of the band 0 prefix. A few MB in a few range requests. |
| Browser, zoomed in | The band for the current zoom, its row groups pruned by bbox. |
| Browser, high zoom | When a row group covers far more area than the view, only the pages of it that overlap, using the covering column's ColumnIndex and OffsetIndex. Any missing piece falls back to the whole group. |
| SQL engine | The exact `geometry` column with predicate pushdown, ignoring `overviews` entirely. |

Page pruning deserves a note. Native Parquet has no geospatial page index, so
the client builds one from what standard Parquet already writes. The bbox
covering column is four plain doubles, its ColumnIndex carries ordinary
min-max per page, and because rows are Hilbert-ordered those page ranges are
spatially tight. The reader maps the view to the overlapping page row ranges
and fetches geometry through the OffsetIndex. Any failure falls back to a
whole-group read, so the optimization is never load-bearing.

## Behavior per geometry type

The importance rank that decides which band a feature lands in, and which one
wins a band-0 thinning cell, and the overview value, both depend on the geometry
dimension.

| Geometry | Ranked by | Overview value |
| --- | --- | --- |
| Polygons | Area, largest first | Simplified, topology preserving, then snapped to the band grid. A shape that collapses below the band pixel writes a small grid-aligned quad sized by its own area instead, Tippecanoe's tiny-polygon-reduction idiom, so a polygon survivor always paints as a polygon |
| Lines | Length, longest first | Simplified and snapped, falling back to the unsnapped simplified line, then to a short segment along the line's own direction, so a line survivor always paints as a line |
| Points | An attribute column when one is given, otherwise the survivor is decided by pure spatial thinning | The exact minimal geometry, copied. For a point-only dataset the banding itself is the level of detail and no overview column is written. |
| Mixed layers | Each dimension cohort ranked within itself, banded and band-0 thinned in its own cells | Per the dimension of each feature |

The footer records what was done, `importance` names the ranking and
`overview_method` names the derivation, so a reader never has to guess.

## Measured on real data

5.65 million building polygons, EPSG 3067 metres, Finland, converted with the
light-overviews layout at zstd level 6. The budget derives four bands, three
coarse plus exact, anchored where Finland fills a screen, with exact geometry
taking over at zoom 13. The three coarse bands together hold ten percent of the
features, band 0 additionally thinned to one survivor per pixel for even
coverage. The exact geometry column is 190.9 MB on disk and decodes to 620 MB.

| band | serves | features | overview, decoded | overview, on disk |
| --- | --- | --: | --: | --: |
| 0 | z0 to z8 | 273,105 | 25.38 MB | 4.57 MB |
| 1 | z9 to z10 | 179,272 | 16.29 MB | 3.42 MB |
| 2 | z11 to z12 | 358,545 | 29.41 MB | 8.65 MB |
| 3 (exact) | z13 up | 4,840,353 | none | none |

The overview column totals 16.66 MB on disk. A whole-country first paint reads
the band 0 overview column, 4.57 MB on disk, and decodes 25.4 MB against the
620 MB exact geometry column, so first paint moves a fraction of the bytes. Band
0 is mostly small area-sized quads at that scale, each carrying its
`overview_count`, so the preview paints as density-weighted building shapes,
not a blank and not a dot field. A six-archetype bake-off drove the layout. The
earlier all-band density thinning wrote a 112 MB overview column here, because it
thinned every band and stored millions of near-exact building shapes a second
time, and it derived eight bands. Fraction banding plus a band-0-only coverage
pass and a depth cap brings the overview column down to 16.66 MB, close to the
fraction-only 14 MB the bake-off measured for the same file, while adding the
even band-0 coverage and its density counts the fraction-only layout lacked. The
band-0 coverage fills 2073 of a 4096 cell grid, matching the old thinned band 0
and beating the 1677 the fraction-only band 0 covered. The whole file is 315 MB
against the fraction-only 326 MB and the all-band-thinned 432 MB. Page pruning
adds about 5.8x on large row groups and 1.5 to 2x on default 16 MB groups, so
its win scales with how many rows a row group and a page hold. No competing
format, tile pyramid or reordered Parquet, publishes a byte-per-zoom figure to
compare against.

The file is read unchanged by DuckDB, which sees a normal GeoParquet file with
a preserved `GEOMETRY('EPSG:3067')` column. The [live
viewer](https://yharby.github.io/geoparquet-overviews/) reads the same file
over HTTP range requests and shows the byte cost per zoom. See
[converter/README.md](converter/README.md) for the stage-by-stage log of this
conversion and [viewer/README.md](viewer/README.md) for the read strategy.

## Relationship to the ecosystem

**Why not native geospatial statistics alone?** They skip row groups for a
small window, which GeoParquet coverings already did. They do nothing for a
whole-extent view, exist only at row-group granularity, and no page-level
variant exists or is proposed. Ordering plus a physically smaller payload is
what changes the first-paint economics.

**Why not an importance flag column?** A flag makes nothing smaller and gives
no locality. Painting a preview would still read full-precision geometry
scattered across every row group.

**Why not quantized tile encodings inside the file?** Storing several levels
of detail in quantized, delta-encoded custom columns is compact but needs a
custom decoder in every client. This convention stays on standard WKB so any
GeoParquet reader can decode the overview column today, and the footprint
cost is one column on a small fraction of rows.

**Why not one geometry column per zoom level?** A tempting alternative keeps
the rows in one pure spatial order and writes a simplified geometry column per
zoom, with nulls standing in for features thinned out of that zoom. It is
valid GeoParquet, the reader picks a level by column projection instead of by
row range, and nulls compress well. It gives up two things this convention is
built on. First, a coarse view stops being one contiguous byte range. Every
zoom column spans every row group of the file, so a whole-extent preview
touches the column chunk of its level in all of them, hundreds of scattered
range requests on a large file where the band prefix here is a handful of
sequential ones. Second, the simplified geometry is duplicated across the
levels that keep a feature, so file size grows with the level count, where
here each feature carries at most one overview. The per-zoom-column layout
also fixes the level ladder into the schema itself, adding or removing a level
is a schema migration, while here it is a footer and row-order change. The
honest advantages on the other side are a single globally Hilbert-ordered
row space, no band-major reorder of the exact rows, and per-level control by
plain column selection in any engine with no footer knowledge at all. For the
first-paint economics over HTTP, which this proposal optimizes for, the
contiguous prefix wins.

**How this relates to other cloud-optimized GeoParquet work.** The closest
prior art is `cloud-optimized-geoparquet` (COGP), which orders features
coarse to fine and records the layout in a footer key very much like this one,
levels with a `row_group_end` and a `gsd`. COGP reorders only, it writes no
reduced geometry, so a whole-extent view still decodes full-precision shapes
from the coarse prefix. This convention adds the two things reordering alone
cannot, a physically smaller overview column and band-0 density thinning, so
band 0 is smaller in bytes, not just first in file order. A related project, `yosegi`,
does thin per zoom, but it duplicates features across zoom levels, so the file
stores each feature many times. Here every feature is stored exactly once and a
coarse band is a subset that points back to that single copy. A proprietary
feature layer takes a third path, several simplified geometry columns, one per
display scale, in a single projection. That works but the column count grows
with the number of levels and the source projection is not preserved. This
convention keeps one overview column plus a band ordinal keyed by the footer,
so the schema does not grow with the level count, and it preserves whatever CRS
the data arrived in, validated on a projected metre dataset.

**Does this replace tiles?** No. For pure cartography at planet scale a tile
pyramid, PMTiles or vector tiles, still wins. But a tile pyramid stores every
shape a second time, quantized and lossy, and a SQL engine cannot read it. The
claim here is narrower and is the one axis a tile format cannot hold, a dataset
that must also be analyzed serves both the map and the query from one file,
with no second pipeline and no duplicated exact geometry.

## Open questions

- **Network fragmentation.** Thinning treats features independently, so it will
  drop segments of a connected road or river network mid-run and leave gaps at
  coarse zoom. Ranking lines by length keeps the trunks and drops the spurs,
  which softens it, but true topology-preserving network thinning is a separate
  and harder problem, and is out of scope for this draft.
- **Adjacent-cell clumping.** Capping one feature per cell does not enforce a
  true minimum spacing, so two survivors in adjacent cells can nearly touch, up
  to about twice the nominal density in clumps. The labelled upgrade path is
  importance-ordered greedy selection with a minimum-spacing radius.
- **Aggregation beyond counts.** Survivors now carry `overview_count`, so a
  viewer can size a proportional symbol, but the count is the only aggregate.
  A future draft could carry summed attributes on a survivor, or coalesce
  coverage polygons such as landcover into a neighbor where dropping one would
  open a visible gap.
- **Diminishing overview returns on fine coarse bands.** For minimal-vertex
  features like buildings, a fine coarse band's simplified copy is nearly as
  heavy as the exact geometry, so an overview copy of every feature at a fine
  zoom buys little. The light-overviews layout handles this two ways, the depth
  cap stops the ladder where an exact read with page pruning is already
  affordable so no overview band is written past it, and the coarse bands hold
  only a small importance slice so the copies that are written stay a small
  cohort. What remains is a coarser lever than a per-level exact-read flag, a
  future draft could let a level declare itself exact-read case by case once its
  shrink falls under a threshold, if readers grow support for it.
- **Multiple files.** The same ordering works as a dataset clustering key for
  part-files with non-overlapping ranges.
