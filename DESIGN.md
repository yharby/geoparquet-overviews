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

1. **Importance order.** Rank features by how much they matter at low zoom,
   largest first for polygons, and split them into a few bands. Band 0 is the
   small set of features that make a whole-extent preview. Every feature is
   stored once, in the band where it first matters. Within a band a Hilbert
   sort keeps neighbors close so bbox statistics stay tight.
2. **An overview column.** Coarse bands carry a simplified, grid-snapped copy
   of their shape in a second geometry column named `geom_overview`. The
   finest band leaves it null. The primary `geometry` column is never touched.
3. **A footer note.** An `overviews` key next to the standard `geo` key
   records which row-group prefix belongs to which band and which zooms each
   band serves. Unknown keys are ignored, so every existing reader sees a
   valid GeoParquet file and reads every row at exact precision.

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
  "version": "0.1.0",
  "spatial_key": "hilbert",
  "importance": "area_desc",
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
  "levels": [
    { "level": 0, "row_group_end": 0,  "max_zoom": 8,  "gsd": 0.005 },
    { "level": 1, "row_group_end": 6,  "max_zoom": 10, "gsd": 0.00125 },
    { "level": 2, "row_group_end": 22, "max_zoom": 24, "gsd": 0.0 }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `version` | Draft version of this convention. |
| `spatial_key` | The curve used for the within-band sort. Descriptive, readers must not depend on it. |
| `importance` | How features were ranked into bands. `area_desc` for polygons, `length_desc` for lines, `attribute:<column>` for an attribute-ranked column, `grid_thin` for spatially thinned points, `mixed_quantile_desc` for a mixed-dimension layer merged by quantile. Descriptive. |
| `covering` | Points at the bbox struct column, mirroring the GeoParquet covering. If present it must match the `geo` covering. |
| `overview_column` | Name of the simplified geometry column. Absent when the file has no overview column. |
| `overview_method` | How `geom_overview` was derived. `simplify_snap` for a simplified, grid-snapped copy. `thin` for a point dataset where the banding itself is the level of detail and no overview column exists. |
| `levels` | One entry per band, sorted ascending, coarsest first. |

Each `levels` entry.

| Field | Meaning |
| --- | --- |
| `level` | Band ordinal, 0 is the coarsest. |
| `row_group_end` | Index of the last row group in this band, inclusive. The band owns the prefix from row group 0. Strictly increasing across levels. |
| `max_zoom` | Highest web zoom this band should paint, an advisory hint on the 256px WebMercator model. Strictly increasing. |
| `gsd` | Ground sample distance the band was simplified to, in CRS units per pixel. The final band is exact and has `gsd` 0. `gsd` is the authoritative resolution signal. |

## Layout rules

Stated here in explanatory form, the normative wording is in
[SPEC.md](SPEC.md).

- Rows are band-major, then ordered by the `spatial_key` curve within each
  band. A small int16 `band` column records each row's band.
- Coarse bands carry `geom_overview`, the finest band leaves it null. The
  primary `geometry` column is always exact and untouched.
- Row groups cut at band boundaries, so `row_group_end` is exact. Coarse bands
  split into many near-equal row groups so a low-zoom view prunes tightly,
  the finest band cuts by byte budget so range reads stay a similar size.
- The source CRS is preserved on both geometry columns. Overview tolerances,
  grid, gsd, and zooms derive from the dataset extent, so degrees and metres
  both work.
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

Importance ranking and the overview value both depend on the geometry
dimension.

| Geometry | Ranked by | Overview value |
| --- | --- | --- |
| Polygons | Area, largest first | Simplified, topology preserving, then snapped to the band grid |
| Lines | Length, longest first | Simplified and snapped |
| Points | An attribute column when one is given, otherwise spatial grid thinning | The exact minimal geometry, copied. For a thinned point dataset the banding itself is the level of detail and no overview column is written. |
| Mixed layers | Per-dimension rank merged by quantile | Per the dimension of each feature |

The footer records what was done, `importance` names the ranking and
`overview_method` names the derivation, so a reader never has to guess.

## Measured on real data

5.65 million building polygons, EPSG 3067 metres, Finland. A whole-country
preview reads the band 0 overview, about 9 MB in 3 range requests. The full
exact geometry column is about 620 MB, roughly 67x more. Per band, the
overview column is 73 to 81 percent smaller than the exact geometry it stands
in for. Page pruning adds about 5.8x on large row groups and 1.5 to 2x on
default 16 MB groups, so its win scales with how many rows a row group and a
page hold.

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

**Does this replace tiles?** No. For pure cartography at planet scale a tile
pyramid still wins. The claim is narrower, a dataset that must also be
analyzed can serve both jobs from one file.

## Open questions

- **Per-band extent and byte range** in `levels`, so a client knows the cost
  of a prefix before reading.
- **Min and max zoom** per level instead of `max_zoom` only.
- **Multiple files.** The same ordering works as a dataset clustering key for
  part-files with non-overlapping ranges.
