# GeoParquet Overviews Specification

Status, draft 0.3.0. License, Apache-2.0.

This document defines a convention for a single GeoParquet file that a web map
can preview instantly and a SQL engine can read in full, with no duplicated
exact geometry. It consists of three additive parts. An importance order that
places coarse features in a contiguous row-group prefix, a simplified overview
geometry column on the coarse bands, and an `overviews` key in the Parquet
file-level metadata, parallel to the GeoParquet `geo` key. A reader that does
not know this convention sees a valid GeoParquet file and reads every row at
exact precision.

## Conformance

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as
described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) when, and only
when, they appear in all capitals, as shown here.

Text in tables, the field descriptions, and the requirement-level columns is
normative. Sections marked non-normative are informative only.

## Terminology

- **Band.** One level of detail. Coarse bands hold a small importance-ranked
  slice of the features, largest first, so band 0 carries the few features that
  matter most at low zoom and each finer coarse band about doubles that slice.
  The last band holds everything else at exact precision. Band 0 alone is
  additionally density thinned to one survivor per pixel per geometry dimension
  for even whole-extent coverage, and each survivor records how many features
  competed for its cell. Every feature belongs to exactly one band and is stored
  exactly once.
- **Level.** The metadata description of one band, an entry in the
  `overviews.levels` array. Level ordinals and band ordinals are the same
  numbers.
- **Coarse band.** Any band except the last. Coarse bands may carry an
  overview geometry.
- **Final band.** The last band, also called the exact band. It carries only
  exact geometry and its `gsd` is 0.
- **Overview.** A simplified, reduced-resolution copy of a feature's geometry,
  stored in a second geometry column. The exact primary geometry is never
  modified.
- **gsd.** Ground sample distance, the resolution a band's overview geometry
  was simplified to, expressed in CRS units per pixel, one pixel at the coarsest
  zoom the band serves. On band 0 it is also the side of the thinning cell.
- **Regime.** A descriptive label for the dataset, count-heavy or vertex-heavy,
  from the average geometry weight per feature. It records which kind of data
  the file holds and never changes how a reader reads it.
- **Prefix.** Because rows are band-major, the row groups of band k and all
  coarser bands form the contiguous row-group range from index 0 through band
  k's `row_group_end`.

## The `overviews` metadata key

A file conforming to this convention MUST carry a key named `overviews` in the
Parquet file-level key-value metadata (the `key_value_metadata` field of the
Parquet `FileMetaData`). Its value MUST be a UTF-8 encoded JSON object. The
key is additive and optional in the same way the GeoParquet `geo` key is, a
reader unaware of it MUST be able to ignore it safely, and its presence MUST
NOT change the meaning of any other column or metadata in the file.

Readers MUST ignore fields of the `overviews` object they do not recognize.
Readers SHOULD fall back to reading the file as plain GeoParquet when the
major component of `version` is one they do not support.

### Example

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

### Top-level fields

| Field | Type | Requirement | Meaning |
| --- | --- | --- | --- |
| `version` | string | REQUIRED | The version of this convention the file was written against, `"0.3.0"` for this draft. |
| `levels` | array | REQUIRED | One entry per band, sorted ascending by `level`, coarsest first. MUST contain at least one entry. See the level fields below. |
| `overview_method` | string | REQUIRED | How the reduced level of detail was produced. See the defined values below. |
| `overview_column` | string | Conditionally REQUIRED | Name of the overview geometry column, `"geom_overview"` in the reference implementation. MUST be present when the file carries an overview geometry column and MUST be absent when it does not. |
| `count_column` | string | OPTIONAL | Name of the survivor count column, `"overview_count"` in the reference implementation. Present only when band-0 thinning wrote one. Each band-0 survivor's value is the number of source features, itself included, that competed for that survivor's thinning cell, and the value is null on every finer band and on rows with null or empty geometry. It is the density signal band-0 thinning would otherwise erase, one survivor per cell makes a dense cluster and sparse coverage paint identically, and a reader MAY scale a survivor's symbol by this count so the cluster stays visible. A reader MUST NOT require it. |
| `importance` | string | OPTIONAL | How features were ranked to place them into bands, largest first, and to decide which one wins each band-0 thinning cell. Descriptive only, see the defined values below. |
| `regime` | string | OPTIONAL | A descriptive label for the dataset, `"count"` for many-feature data, `"vertex"` for few-heavy-geometry data, from the average bytes per feature. Descriptive only, a reader MUST NOT need to interpret it. |
| `spatial_key` | string | OPTIONAL | The space-filling curve used for the within-band sort, `"hilbert"` in the reference implementation. Descriptive only. Readers MUST NOT depend on it. |
| `covering` | object | OPTIONAL | Points at the bbox covering column, in the same shape as the GeoParquet `covering` object. If present it MUST be identical to the covering declared for the primary geometry column in `geo`. Readers SHOULD take the covering from `geo` and MAY ignore this copy. |

### `levels[]` fields

| Field | Type | Requirement | Meaning |
| --- | --- | --- | --- |
| `level` | integer | REQUIRED | Band ordinal. MUST start at 0 and MUST be contiguous, so the levels are numbered 0 through n minus 1. |
| `row_group_end` | integer | REQUIRED | Index of the last row group belonging to this band, inclusive. The band's rows together with all coarser bands occupy the row-group prefix from 0 through this index. MUST be strictly increasing across levels. |
| `min_zoom` | integer | REQUIRED | The lowest web zoom this band is intended to paint, the natural pair to `max_zoom`. It is 0 on level 0 and MUST equal the previous level's `max_zoom` plus 1 on every later level, so the levels tile the zoom range with no gap. Advisory only, see the zoom model below. |
| `max_zoom` | integer | REQUIRED | The highest web zoom this band is intended to paint. MUST be strictly increasing across levels. Advisory only, see the zoom model below. |
| `gsd` | number | REQUIRED | Ground sample distance the band's overview geometry was simplified to, in CRS units per pixel, which on band 0 is also the side of the thinning cell. MUST be 0 on the final level and MUST be greater than 0 on every coarse level. `gsd` is the authoritative resolution signal. |
| `grid` | object or null | OPTIONAL | The coordinate snap grid the band's overview was quantized to, `{ "origin": [x, y], "cell_size": [dx, dy] }` in the file's CRS units, both positional arrays. `origin` is the anchor of the snap lattice, the reference implementation snaps from coordinate zero so it is `[0, 0]`. A coordinate maps to the cell whose corner is `origin + n * cell_size`. A coarse level's grid is a sub-pixel fraction of its own `gsd`, so a coarse band carries only the precision it paints. MUST be null on the final level, which carries no overview. |
| `feature_count` | integer | OPTIONAL | The number of features in this band. The values across all levels sum to the file's row count, so the footer itself attests that no feature was dropped, only moved to a finer band. It lets a reader price a level before reading it. |
| `extent` | array or null | OPTIONAL | Four numbers `[xmin, ymin, xmax, ymax]` in the file's CRS units, the padded extent of the band's own features. MUST be null when the band has no valid geometry. When present it MUST enclose every covering value in the band, including the padding described in the covering section below. |
| `bytes` | array | OPTIONAL | Two integers `[start, end)`, the file byte offsets spanning this level's own row groups, exclusive of any coarser level's row groups. Because bands are written in band-major order the row-group byte ranges are contiguous across levels, so a reader MAY price and issue a single prefix read for level k as `[levels[0].bytes[0], levels[k].bytes[1])`, without parsing row-group offsets from elsewhere in the footer. |

### The zoom model

`max_zoom` is an advisory hint expressed on the 256-pixel WebMercator tile
model, where the ground resolution at zoom z is

```
gsd(z) = world / (256 * 2**z)
```

with `world` being the whole-globe span in the data's own CRS units, 360 for a
geographic CRS in degrees and the WebMercator equatorial circumference for a
projected CRS in metres. A reader that needs the real resolution of a band
MUST use `gsd`, which is exact and unit-safe, and MAY use `max_zoom` as a
convenient default for band selection on a web map.

The ladder is expressed in absolute web zoom, and its coarsest band is anchored
at the zoom where the dataset's own extent fills a screen, not at whole-world
zoom. Band 0 is therefore a genuine zoomed-out pixel of the dataset, and each
finer band steps a fixed number of zooms toward exact geometry. A dataset whose
exact geometry already fits the per-screen budget at that coarsest zoom carries
no coarse band at all, only the exact band with no overview. `min_zoom` and
`max_zoom` bracket each band's intended zoom range, and because band 0's
`min_zoom` is 0 and every later level's `min_zoom` is one past the previous
level's `max_zoom`, the levels tile the whole zoom range from 0 up with no gap
and no overlap. A reader selecting a band for the current zoom z MAY pick the
level whose `[min_zoom, max_zoom]` range contains z, which is equivalent to
picking the coarsest level whose `max_zoom` is at least z.

### `importance` values

`importance` is an open enumeration. It records how the writer ranked
features into bands. It is descriptive only. A reader MUST NOT need to
interpret it in order to read the file, and MUST accept values not listed
here. The values defined by this draft, matching the reference converter, are

| Value | Meaning |
| --- | --- |
| `area_desc` | Features ranked by area, largest first. Used for polygon datasets. |
| `length_desc` | Features ranked by length, longest first. Used for line datasets. |
| `attribute:<column>` | Features ranked by the named numeric attribute column, largest first. |
| `grid_thin` | Point features with no attribute rank, where pure spatial thinning decides each cell's survivor. |
| `mixed_quantile_desc` | A mixed-dimension dataset where each dimension cohort was ranked within itself and converted to a descending percentile, and that percentile is both the band-placement rank and the band-0 thinning metric within each cohort's own cells. |

### `overview_method` values

`overview_method` states how the reduced level of detail was produced. The
values defined by this draft are

| Value | Meaning |
| --- | --- |
| `simplify_snap` | Coarse bands carry a simplified, grid-snapped copy of their geometry in the overview column. A shape that collapses below the band pixel falls back to a small quad or segment of its own dimension, see the per-type semantics. `overview_column` MUST be present. |
| `thin` | The banding itself is the level of detail. A coarse band contains a representative subset of the features and no overview column exists, so `overview_column` MUST be absent. This is the mode for pure point datasets, whose exact geometry is already minimal. |
| `none` | The file has a single band and no reduced level of detail at all. Nothing was simplified, snapped, or thinned, `overview_column` and `count_column` MUST be absent, and a reader treats the file as plain exact GeoParquet with the band-major sort and this footer key. This is the honest value for a sparse dataset whose exact geometry already fits the per-screen budget at its coarsest zoom. |

The value `centroid`, meaning coarse bands collapse features to point
centroids, is reserved for a future draft. It is not produced by the
reference implementation and readers encountering it MAY fall back to plain
GeoParquet reading.

Readers MUST accept `overview_method` values not listed here and in that case
SHOULD fall back to reading the exact `geometry` column for every band.

## Layout requirements

These invariants are what a reader relies on. A writer producing an
`overviews` key MUST satisfy all of them.

1. **Band-major order.** Rows MUST be sorted by band, band 0 first. Within a
   band rows SHOULD be ordered by a space-filling curve over the feature
   bounding-box centroids, so that bounding-box statistics stay spatially
   tight. The curve used SHOULD be recorded in `spatial_key`.
2. **Row groups cut at band boundaries.** No row group may contain rows from
   two bands, so every `row_group_end` is exact. Coarse bands SHOULD be split
   into several near-equal row groups so a low-zoom viewport can prune them by
   bounding box. The final band SHOULD be cut by a byte budget so range reads
   stay a similar size.
3. **Level ladder.** `levels` MUST be sorted ascending by `level`, coarsest
   first, with strictly increasing `row_group_end` and strictly increasing
   `max_zoom`. Each level's `min_zoom` MUST be 0 on level 0 and MUST equal the
   previous level's `max_zoom` plus 1 on every later level. The final level is
   the exact band and MUST have `gsd` 0 and a null `grid`.
4. **Exact primary geometry.** The primary geometry column named by
   `geo.primary_column` MUST contain the exact source geometry for every row.
   A writer MUST NOT simplify, snap, or otherwise alter it.
5. **Overview column population.** When `overview_column` is present, its
   values MUST be entirely null in the final band. In coarse bands each row
   MUST carry an overview value, except for the defined NULL cases in the
   per-type semantics below. When `overview_method` is `thin` there is no
   overview column at all.
6. **Null and empty source geometry.** A row whose primary geometry is null or
   empty MUST be placed in the final band, with a null bounding-box covering
   value and a null overview value.

### The `band` column

A writer SHOULD add a physical column named `band` containing each row's band
ordinal. The reference implementation writes it as a 16-bit signed integer
and declares it in the Parquet `sorting_columns` metadata as ascending. If
the column is present its values MUST agree with the band implied by the row
group's position in the `levels` prefixes.

The column exists so SQL engines can filter or group by level of detail
without parsing the `overviews` key. A reader MUST NOT require it, the
layout is fully determined by `levels[].row_group_end`.

### The bbox covering column and the Page Index

This convention defines two writer profiles for row-group and page pruning.
A writer MUST pick one, and a reader MUST be able to tell which from the file
alone, by whether the `bbox` column and its `geo` covering entry are present.

**Profile A, the covering column.** A writer SHOULD write a physical
bounding-box covering column, a struct of four doubles, declared in the
`covering` object of the primary geometry column's `geo` entry. The reference
implementation names it `bbox` with children `xmin`, `ymin`, `xmax`, and
`ymax`. A writer SHOULD also write the Parquet Page Index (ColumnIndex and
OffsetIndex) so that page-level pruning is possible, and SHOULD write column
statistics for the covering column's leaves so row groups can be pruned from
the footer alone. Profile A works with or without native Parquet geometry
types.

**Profile B, native statistics only.** A writer MAY omit the physical bbox
covering column and its `geo` covering entry entirely, relying solely on the
Parquet GEOMETRY logical type's per-row-group GeospatialStatistics for
row-group pruning. A writer MUST NOT choose Profile B unless both geometry
columns carry native Parquet GEOMETRY logical types with GeospatialStatistics,
since there would otherwise be no pruning surface in the file at all.

Profile B has no page-level pruning of any kind, because the Parquet format
has no page-level geospatial statistics. Native GeospatialStatistics, like all
Parquet column statistics, exist only at row-group granularity. A reader that
needs sub-row-group precision MUST use Profile A.

Under Profile A, for a row in a coarse band, the covering value MUST enclose
both the exact geometry and the row's overview geometry. Grid snapping can
move overview vertices outward and the quad fallback can extend up to half a
band pixel beyond the feature, so the reference implementation pads
coarse-band covering values by half the band tolerance. A reader pruning by
covering must never drop a feature that the overview still paints. A level's
`extent` field carries the same padding, so it too encloses both the exact
and overview geometry of a coarse band. Under Profile B a reader instead
relies on the overview column's own native GeospatialStatistics, which are
computed from the overview geometry actually written and so need no separate
padding.

## Native Parquet geometry types

A 0.3.0 writer SHOULD write the primary `geometry` column and, when present,
`geom_overview` as the Parquet GEOMETRY logical type, so that a native reader
gets per-row-group GeospatialStatistics on both columns for free. This is a
dual write, not a replacement. The writer MUST still write the `geo` footer
key at version `"1.1.0"` describing both columns as WKB-encoded geometry
columns, exactly as required elsewhere in this document. A file conforming to
this convention is therefore simultaneously a valid GeoParquet 1.1 file and a
file a GeoParquet 2.0-aware or plain Parquet-geometry-aware reader can use
natively, without a second copy of any geometry.

Readers MUST NOT require native Parquet geometry types to read a conforming
file. A reader that does not recognize the GEOMETRY logical type MUST still
be able to read the column as its WKB binary storage, per ordinary Parquet
extension-type fallback, and interpret it through the `geo` key exactly as it
would a plain GeoParquet 1.1 file.

## Overview geometry semantics per geometry type

A geometry's dimension is its topological dimension, 0 for points, 1 for
lines, 2 for polygons. For a geometry collection it is the maximum dimension
over its members, and the collection follows the rule for that dimension.

### Polygons and dimension-2 collections

The overview value MUST be produced by topology-preserving simplification at
the band's tolerance followed by snapping to a coordinate grid. A writer
SHOULD repair invalid input on the overview path before simplifying, without
touching the exact column. When the result is empty or degenerate, the shape
has collapsed below the band's pixel, and the writer MUST fall back to a
small grid-aligned quad centred on the feature's representative point, sized
by the feature's own area and clamped between one snap-grid cell and one band
pixel, so the survivor stays a polygon and larger features paint larger. This
is the same idiom as Tippecanoe's tiny-polygon reduction, which replaces
subpixel polygons with small squares rather than dropping them. On band 0,
whose thinned survivor stands for its whole cell, a NULL here would erase the
cell from the preview, and on a dataset of small features at a coarse zoom that
blanks the entire first paint. Only when even the quad cannot be
built is the value NULL, never empty WKB, and a reader painting the overview
column MUST skip NULL values rather than fall back to the exact geometry.

### Lines and dimension-1 collections

Lines follow the same simplify-plus-snap rule with a collapse guard. When
snapping collapses a simplified line to empty, the writer MUST fall back to
the simplified unsnapped geometry, and when even that is empty, to a short
segment through the feature's centre along its own dominant direction, at
least one snap-grid cell long, so a line survivor stays a line, never a
point. Only a feature whose segment also fails is NULL, never empty WKB.

### Points

Exact point geometry is already minimal, so points get no reduced geometry.

- **Pure point datasets.** The banding itself is the level of detail.
  `overview_method` MUST be `thin` and `overview_column` MUST be absent. A
  coarse band holds a representative subset, chosen by grid thinning or by a
  numeric attribute rank, and the reader paints the exact `geometry` column
  at every level. The `importance` value records which ranking was used,
  `grid_thin` or `attribute:<column>`.
- **Points in a mixed dataset.** When the file carries an overview column,
  point rows in coarse bands MUST carry a verbatim copy of their exact
  geometry in the overview column, so a reader of the overview column alone
  paints every coarse feature.

### Geometry types of the overview column

Simplification and snapping can lower a feature's geometry type, a
MultiPolygon can become a Polygon. `geom_overview` values MAY therefore have
a lower-dimensional or narrower geometry type than the primary column. The
overview column's own entry in `geo.columns` MUST list the geometry types
actually present in the overview values, recomputed from the written data,
not copied from the exact column. The overview column MUST NOT declare a
`covering`.

## Reader behavior

Normative requirements on a conforming reader.

- A reader MUST ignore fields it does not recognize in the `overviews` object
  and in its level entries.
- A reader MUST NOT require the `band` column, the `spatial_key` value, or
  the `importance` value to read the file.
- A reader that selects a band for a zoom SHOULD pick the coarsest level
  whose `max_zoom` is greater than or equal to the current zoom, falling back
  to the final level, and SHOULD read the overview column for coarse levels
  and the primary geometry column for the final level.
- When reading level k's row-group prefix, the row groups of bands coarser
  than k carry overviews snapped for lower zooms, and on a per-band-grid file
  those overviews paint oversized blocks at level k's zooms. A reader SHOULD
  therefore read the primary geometry column for row groups of bands coarser
  than the selected level. Coarse bands hold only a small importance-ranked
  slice of the features, so the exact read stays cheap. On a pre-0.3.0 file, which snapped every band to
  one fine global grid, the coarser bands' overviews are correct at finer
  zooms and reading them is the cheaper choice.
- A reader painting the overview column MUST skip NULL overview values. A
  NULL in a coarse band means the feature is below that band's resolution,
  it does not mean the reader should fetch the exact geometry instead.
- A reader MUST treat a missing or unparsable `overviews` key, or one whose
  `levels` array is absent or empty, as a plain GeoParquet file.

### How a reader uses this (non-normative)

- **First paint.** Read the Parquet footer, then the overview column chunks
  of the level 0 row-group prefix, row groups 0 through
  `levels[0].row_group_end`. On real data this is a few range requests and a
  few megabytes against a full exact column hundreds of times larger.
- **Zoomed in.** Pick the level for the current zoom, take its row-group
  prefix, and prune the prefix to the viewport with the covering column's
  row-group statistics.
- **High zoom over a small window.** When a surviving row group covers far
  more area than the view and the file carries the Page Index, read the
  covering column's ColumnIndex and OffsetIndex, map the viewport to the
  overlapping page row ranges, and fetch only those pages of the geometry
  column. Any missing piece falls back to reading the whole row group.
- **SQL engines.** Ignore the `overviews` key entirely and scan the exact
  primary geometry column with ordinary predicate pushdown. The file is a
  valid GeoParquet file with two extra columns and one extra footer key.
- **Pricing a prefix read up front.** When a level carries `bytes`, a reader
  can decide whether a level 0 through k prefix read is worth issuing, and
  issue it as one range request `[levels[0].bytes[0], levels[k].bytes[1])`,
  before looking at anything but the `overviews` key itself. When a level
  carries `extent`, a reader can also skip a level entirely when it does not
  intersect the viewport, without opening the file's row groups at all.

## Writer behavior

Normative requirements on a conforming writer, beyond the layout section.

- The `overviews` value MUST be valid UTF-8 JSON and MUST satisfy every field
  requirement in this document.
- `levels` MUST be computed from the real row-group layout of the written
  file, never authored independently of it.
- `importance`, `overview_method`, and `regime` MUST describe what the writer
  actually did and what the data actually is. A writer MUST NOT, for example,
  write `area_desc` for a line dataset.
- A writer MUST NOT write empty WKB into the overview column. Degenerate
  results are NULL.
- **Band formation.** A writer SHOULD form coarse bands by an importance
  fraction, largest first, so that the coarse bands together hold only a small
  slice of the features and the exact final band keeps the large remainder.
  Every coarse feature carries a simplified overview copy, so a small coarse
  cohort is what keeps the overview column light, and the finer detail is
  served by the exact band read with page pruning past the ladder's depth cap.
  The reference implementation gives band 0 the smallest slice and about doubles
  the slice on each finer coarse band, ten percent of the features across all
  coarse bands by default, tunable through an explicit fraction ladder. No
  feature is ever dropped, the final band keeps everyone not placed in a coarse
  band.
- **Band-0 coverage thinning.** A writer SHOULD additionally thin band 0 alone
  to one survivor per pixel per geometry dimension, over all valid features,
  before the fraction split, so band 0 covers the whole extent evenly rather
  than clustering in the densest regions the importance rank favors. The
  survivor of a cell MUST be chosen by a total order that does not depend on
  input row order, so the output is reproducible, the reference implementation
  breaks ties on a content hash of the feature geometry. The features not kept
  in band 0 are fraction banded into the finer bands. Deeper coarse bands are
  pure fraction and are not thinned.
- **Survivor counts.** A band-0 thinning writer SHOULD record each band-0
  survivor's cell population in the column named by `count_column`, so the
  density signal thinning removes from the geometry survives in the data. The
  count is the number of features, the survivor included, that competed for the
  survivor's cell. Because band-0 thinning runs over every valid feature, the
  band-0 counts sum to every valid feature in the file. The count is written
  only on band 0 and is null on every finer band.
- **Derived band count.** A writer SHOULD derive the number of bands from the
  dataset rather than fix it. The reference implementation runs the coarse ladder
  from the zoom where the dataset extent fills a screen up to the zoom where a
  screen decodes an affordable amount of geometry, measured in bytes per screen
  so that dense many-feature data and sparse heavy-geometry data each get the
  band count they need, at a fixed number of zooms per band. The byte density
  the budget solves against SHOULD be local, measured where the data actually
  sits, not averaged over the whole bounding box. Real data clusters, and the
  whole-extent average understates the density of the screens a user actually
  zooms into, handing off to the unthinned exact band too early. The reference
  implementation buckets feature bytes into a grid over the extent and solves
  against a byte-weighted high quantile of the occupied cells' densities. A
  dataset whose exact geometry already fits that per-screen budget at its
  coarsest zoom gets a single exact band and no overview.
- **Zoom ceiling.** No coarse band may serve past the zoom range the exact band
  owns. A writer MUST NOT emit an overview band whose ladder zoom is at or past
  the zoom model's finest zoom, 24 in the reference implementation, an overview
  at that resolution would just be exact geometry grid-snapped. The reference
  implementation clamps both the derived and the forced band count so the
  coarsest band's anchor plus the ladder steps stay under the ceiling.
- A writer SHOULD derive simplification tolerances, the snap grids, `gsd`, and
  `max_zoom` from the dataset extent in the data's own CRS units, so the same
  rules hold for geographic degrees and projected metres. Each coarse band
  SHOULD snap its overview to its own grid, a sub-pixel fraction of that band's
  `gsd`, so a coarse band carries only the coordinate precision it paints. The
  source CRS MUST be preserved on both geometry columns.
- A writer SHOULD write the Page Index, SHOULD declare `sorting_columns` for
  the `band` column, and MAY apply any standard Parquet encoding or
  compression, none of which affects conformance.

## Compatibility

- **GeoParquet 1.1.** The overview column is an ordinary additional geometry
  column, listed in `geo.columns` with WKB encoding, its own recomputed
  `geometry_types`, and the preserved source CRS. The `geo` block is valid
  GeoParquet 1.1 with or without the `overviews` key, and stays at version
  `"1.1.0"` even on a file that also writes native Parquet GEOMETRY logical
  types, per the native types section above. This draft defines the
  convention for WKB-encoded geometry columns only. Native GeoArrow
  encodings, distinct from the Parquet GEOMETRY logical type, are out of
  scope.
- **GeoParquet 2.0.** The convention is independent of the `geo` version. It
  requires only a primary geometry column, plus, under Profile A, the bbox
  covering column and the Page Index when sub-row-group pruning is wanted.
  An overviews file using Profile A keeps the physical covering column even
  when it also writes native Parquet GEOMETRY logical types, per the profile
  section above.
- **Plain Parquet readers.** Everything is additive. A reader that knows
  nothing of `geo` or `overviews` sees a normal Parquet file with a binary
  geometry column, a binary overview column, an int16 `band` column, an
  optional int32 `overview_count` column, and a four-double `bbox` struct, and
  can still prune row groups on the `bbox` statistics.
- **Versioning.** The `overviews.version` field versions this convention
  alone. Readers MUST ignore unknown fields within a known major version and
  SHOULD fall back to plain GeoParquet reading on an unknown major version.

## Changelog

- **0.1.0.** Initial draft. Band-major layout, `geom_overview` column,
  `overviews` footer key with `levels`, `importance`, `overview_method`, and
  per-geometry-type overview semantics.
- **0.2.0.** `overviews.version` bumped to `"0.2.0"`. `levels[]` gained the
  OPTIONAL `extent` and `bytes` fields. The bbox covering column moved from a
  MUST to profile language, Profile A writes it, Profile B omits it and
  relies on native GeospatialStatistics, with no page-level pruning. Added
  the native Parquet geometry types section describing the dual write of
  native GEOMETRY logical types alongside the unchanged `geo` version
  `"1.1.0"`.
- **0.3.0.** `overviews.version` bumped to `"0.3.0"`. Bands are now formed by
  density thinning, described in writer behavior, so a coarse band holds about
  one feature per pixel per geometry dimension and coarse-band over-fetch is
  gone. The band count is derived from the dataset rather than fixed, solved
  against a local byte density so clustered data gets the coarse bands its
  dense screens need, and the overview ladder's coarsest band is anchored at
  the zoom where the dataset extent fills a screen, so a sparse dataset that
  already fits the per-screen budget carries a single exact band and no
  overview. No coarse band may serve at or past the zoom model's finest zoom.
  `levels[]` gained the REQUIRED `min_zoom` and the OPTIONAL `grid` and
  `feature_count` fields, and the block gained the OPTIONAL `regime` label and
  the OPTIONAL `count_column` naming the survivor count column, the density
  signal a reader can scale symbols by. `overview_method` gained the `none`
  value for a single-band file. A survivor whose shape collapses below its
  band's pixel now writes a small quad or segment of its own dimension
  instead of NULL, so a coarse band of small features paints as shapes
  rather than a blank, and each geometry type keeps its kind, only point
  features paint as points. Each coarse band snaps its overview to its own
  per-band grid. The exact-geometry, plain-reader, and profile guarantees
  are unchanged.
