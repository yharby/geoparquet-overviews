# Per-zoom over-fetch investigation

Date 2026-07-06. Status complete.

Scope. A reviewer raised that the viewer downloads much more geometry than a
low zoom can paint, and a companion critique noted that one overview band
serves eight zoom levels and can only be right at one end. This investigation
quantifies that over-fetch with real measurements across eight hosted datasets
plus the local Finland build, locates exactly where it lives, and recommends
what to change.

Method. Measured with DuckDB 1.5 against the actual files, the local Finland
v0.1.0 build and the hosted v0.2.0 set on source.coop. Metadata-only queries
for byte and row structure, bounded geometry reads for vertex counts, and the
covering columns for feature sizes, so even the 52.5M row Germany file was
profiled without downloading its geometry. Five profiling subagents ran in
parallel over the hosted set. The resolution model is the converter's own,
`res(z) = world / (256 * 2**z)` in the data's own units, where `world` is 360
degrees for a geographic CRS and the Web Mercator circumference for a metre
CRS. This is the same model `_zoom_for_gsd` uses to assign `max_zoom`, so the
zoom axis is internally consistent with the file. The over-fetch metric is
`feat/px = band_feature_count / (extent_area / res(z)**2)`, the number of
features fetched for every pixel on screen at that zoom.

---

## 1. Verdict summary

The over-fetch is real, it is bounded in bytes, and it lives in exactly one
place, the coarsest band. Its magnitude is governed by a single quantity, how
many zoom levels the coarsest band is stretched across. That span is set by the
data extent, not by an explicit choice, so a continental dataset is nearly
clean and a metro dataset over-fetches by five orders of magnitude with the
same three bands.

Three conclusions.

1. The waste is feature count, not vertex detail. For dense small features the
   overview already floors at about four points per feature, so no coarser
   tolerance and no extra band can shrink the coarse band. Only dropping
   features can.
2. A fixed band count cannot be right. The coarse band's zoom span ranges from
   four levels on a country file to twelve on a metro tile across these files.
3. The design already works in the opposite regime. For a few hundred huge
   polygons the overview cuts vertices 100x to 200x and there is no feature
   count problem at all.

---

## 2. The finding, features fetched per pixel by zoom

Each cell is `feat/px` for the band that serves that zoom. Above 1.0 the fetch
carries more geometry than the view can resolve. Values at or above 1.0 are the
over-fetch zone and are shown in bold. A dot is below 0.01.

| dataset | z0 | z1 | z2 | z3 | z4 | z5 | z6 | z7 | z8 | z9 | z10 | z11 | z12 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| country boundaries (249 poly, global) | · | · | · | · | · | · | · | · | · | · | · | · | · |
| timezones (444 poly, global) | · | · | · | · | · | · | · | · | · | · | · | · | · |
| parks (1.49M poly, global) | **2.0** | 0.50 | 0.12 | 0.03 | 0.05 | 0.01 | · | · | · | · | · | · | · |
| settlements (4.56M pts, global) | **4.1** | **1.0** | 0.26 | 0.07 | 0.11 | 0.03 | 0.03 | · | · | · | · | · | · |
| Tokyo POIs (266k pts, metro) | **420k** | **100k** | **26k** | **6.5k** | **1.6k** | **410** | **100** | **25** | **6.3** | **1.6** | 0.40 | 0.10 | 0.02 |
| Tokyo roads (1.41M lines, metro) | **652** | **160** | **41** | **10** | **2.5** | 0.64 | 0.16 | 0.04 | **20** | **5.1** | **3.5** | 0.87 | 0.22 |
| Tokyo buildings (6.46M poly, metro) | **680k** | **170k** | **42k** | **11k** | **2.7k** | **660** | **170** | **41** | **10** | **2.6** | 0.65 | 0.16 | 0.37 |
| Finland buildings (5.65M poly, ~667 km) | **5.5k** | **1.4k** | **350** | **86** | **22** | **5.4** | **1.4** | 0.34 | 0.08 | 0.18 | 0.05 | 0.03 | · |
| Germany buildings (52.5M poly, country) | **41k** | **10k** | **2.6k** | **640** | **160** | **40** | **10** | **2.5** | 0.63 | **1.4** | 0.35 | 0.24 | 0.06 |

Read a row left to right. It climbs at low zoom, then drops below one feature
per pixel and resets cleanly at each band boundary, the Finland jump from 0.08
at z8 back up to 0.18 at z9 is band 1 starting fresh. The fine bands are
already matched. Read the table top to bottom and the driver is extent. The
global sets barely warm up, the metro Tokyo sets are over the threshold across
ten zoom levels.

---

## 3. Where the over-fetch lives and why

The viewer picks one band per zoom and reads that whole band's overview column,
see `viewer/src/data/layout.ts`, `overviewsStrategy.planRead` calling
`levelForZoom`. It cannot fetch less than a band for a coarse view, because
inside a band the rows are Hilbert sorted for bbox pruning, not importance
sorted, so there is no coarse-to-fine prefix to slice. The band is the smallest
load unit.

The converter sets the coarsest band's tolerance to a fixed fraction of the
extent (`_COARSEST_REL = 1/1500` of the larger span) and derives its `max_zoom`
from that tolerance. A small extent yields a fine tolerance, which pushes the
coarse band's `max_zoom` high, which forces that one band to serve the entire
range from z0 up. So the coarse band's zoom span is an uncontrolled function of
extent.

| dataset | extent | band 0 spans | worst feat/px | bottleneck |
|---|---|---|--:|---|
| parks | global | z0 to z3 (4 levels) | 2.0 | matched |
| settlements | global | z0 to z3 (4 levels) | 4.1 | matched |
| country boundaries | global | z0 to z3 (4 levels) | 0.0002 | vertices |
| timezones | global | z0 to z3 (4 levels) | 0.0004 | vertices |
| Tokyo roads | metro | z0 to z7 (8 levels) | 652 | feature count |
| Finland buildings | ~667 km | z0 to z8 (9 levels) | 5,531 | feature count |
| Germany buildings | country | z0 to z8 (9 levels) | 41,032 | feature count |
| Tokyo POIs | metro | z0 to z11 (12 levels) | 416,000 | feature count |
| Tokyo buildings | metro | z0 to z11 (12 levels) | 679,392 | feature count |

The fixed 3 percent feature fraction also scales the coarse band with dataset
size, so Germany's band 0 holds 1.52M features, 3 percent of 52.5M, which makes
a bigger dataset worse, not better.

---

## 4. Deep dive, Finland buildings

Finland, 5,651,275 buildings, EPSG:3067. Band 0 is the 169,538 largest,
serving z0 to z8.

The overview has already done all it can. Measured per-band vertex counts.

| band | features | avg pts, exact | avg pts, overview | median side |
|---|--:|--:|--:|--:|
| 0 | 169,538 | 11.9 | 4.0 | 26.5 m |
| 1 | 1,525,845 | 7.2 | 4.0 | 13.4 m |
| 2 | 3,955,892 | 5.4 | null (exact) | 6.4 m |

Band 0's overview averages exactly 4.0 points per feature, a bounding quad.
Simplification has hit the floor, you cannot draw a building in fewer than four
points, so no coarser tolerance and no extra band can shrink band 0 further.
The largest band 0 feature is 385 m across, which at z0 is one four-hundredth
of a pixel, so band 0 is a pure aggregate silhouette at every zoom it serves.
What remains is not vertex detail, it is feature count, 169,538 features painted
onto 31 pixels at z0.

Per-zoom decay for band 0, over-fetch falls 4x per zoom and crosses 1.0 at z6.

| zoom | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| feat/px | 5,531 | 1,383 | 346 | 86 | 22 | 5.4 | 1.4 | 0.34 | 0.08 |

The byte cost is small in absolute terms, which is why this stayed unnoticed.
The whole geom_overview column is 8.91 MB against 177.7 MB of exact geometry, a
20x preview, and the band 0 column alone is 2.36 MB to draw the entire country,
a 75x preview. The over-fetch is a redundancy factor on a small number, not a
large download.

---

## 5. Two regimes

The eight datasets split cleanly, and which lever matters is a property of the
data. A single fixed banding rule cannot serve both.

Feature-count regime, buildings and roads and points. Millions of small
features, the overview floors near four points each, so per-feature
simplification is spent. The coarse band's job should be to drop features, keep
about one per pixel-cell, not keep every feature above an area rank. This is
where all the over-fetch lives, up to 679,000x on Tokyo buildings. The design
does not thin today, so it over-fetches.

Vertex regime, coastlines and admin and timezones. A few hundred enormous
polygons, feature count is a non-issue at under one feature per ten thousand
pixels even at z0. The whole win is vertex simplification, and here the design
already shines. Country boundaries cut 3,611,948 points per feature to 18,165,
a 199x reduction, and 217 MB of exact geometry down to a 0.53 MB preview, a
407x win. Timezones cut vertices 113x. In this regime more bands with a finer
tolerance ladder would help further, the opposite of buildings.

---

## 6. Against the neighbours

The measured numbers sharpen this proposal's position rather than weakening it.
The over-fetch is a fixable banding choice, and the queryable exact geometry the
others give up is worth keeping.

| approach | what it does | strength | cost |
|---|---|---|---|
| Esri Spatially Optimized Parquet | per-LOD quantized delta columns | best per-zoom byte efficiency, proven at 2.7B features | opaque PBF, Web Mercator only, read-only, highest storage |
| geoparquet-overviews (this) | exact WKB untouched plus one overview column per coarse band | queryable today in DuckDB, 20x to 75x preview measured, CRS aware | coarse band over-fetches, no feature thinning yet |
| Kanahiro cloud-optimized | row-group reorder, no extra geometry | zero storage overhead, feature-count reduction native | coarse levels serve geometry verbatim, vertex-heavy unsolved, no byte contract |
| density-pyramid banding (proposed) | overview column plus per-band thinning | solves both regimes in one ladder, coarse bands nearly free | a converter change to band membership |

---

## 7. Recommendations, in priority order

1. Thin each coarse band to its pixel budget. The real fix. A coarse band
   should keep about one feature per pixel-cell at the coarsest zoom it serves,
   by spatial thinning, not keep every feature above an area rank. Feature
   counts then form a ladder, each coarser band about one sixteenth of the
   next. For Finland that is roughly 500 features for z0 to z2, 8,000 for z3 to
   z4, 128,000 for z5 to z6. The coarse levels become almost free in bytes and
   the z0 to z6 over-fetch disappears.

2. Derive band count from the zoom span, not a fixed number. Once thinning is
   in, the count falls out. Cover z0 up to where exact geometry is affordable,
   about two zooms per band. A country needs five to seven coarse bands, a metro
   tile more, a continent fewer. A fixed 3 or 4 cannot be right when the coarse
   band's span ranges from four to twelve levels across these files.

3. Choose the lever by regime. Detect vertex-heavy versus count-heavy data from
   average points per feature and feature density, and act accordingly. Dense
   small features want thinning, few huge polygons want the finer simplify
   ladder they already benefit from.

4. Give each band its own snap grid. Today the grid is global at `1/60000` of
   the span, so band 0 carries z12-grade coordinate precision on geometry that
   never paints past z8. A per-band grid tied to that band's gsd shrinks those
   coordinate bytes with zero visible change, and answers the global-snap-grid
   point in the critique.

5. Make the footer say what a reader can skip. Bands are the load unit, so the
   footer's `levels[]` is the reader's whole decision surface. It already
   carries `max_zoom`, `gsd`, `extent`, and `bytes` as of 0.2.0. Add a per-band
   `feature_count` and a `min_zoom` so a reader can skip a coarse band that is
   pointless for a small extent, and finer thinned bands make that metadata
   actionable without a new geometry format.

---

## 8. The direct question, is four bands to z13 the fix

Partly, and only as a direction. More bands with a matched tolerance ladder is
correct and cheap, and for vertex-heavy data it helps a lot. But a fixed count,
four or any other, will not fix a buildings dataset, because the waste there is
feature count and the overview already floors at four points per feature. The
count has to track the coarsest band's zoom span, which depends on extent, and
it only works when paired with per-band feature thinning. So the honest answer
is not a number, it is a rule. Thin each band to its pixels, then let the band
count fall out of the zoom range.

---

## 9. Data appendix

Per-band bytes and rows, measured. Overview and geometry columns compressed.

Finland buildings, EPSG:3067, metre CRS.

| band | serves | features | overview MB | geometry MB | bbox MB |
|---|---|--:|--:|--:|--:|
| 0 | z0 to z8 | 164,240 | 2.36 | 10.76 | 2.36 |
| 1 | z9 to z10 | 1,483,461 | 6.32 | 56.70 | 17.79 |
| 2 | z11 up | 4,003,574 | 0.23 | 110.27 | 38.50 |

Germany buildings, WGS84. Band 0 overview 28.7 MB draws all 52.5M buildings,
whole file 4.68 GB. Band byte ranges from the footer, band 0 `[4, 297.76 MB]`,
band 1 `[297.76 MB, 1.868 GB]`, band 2 `[1.868 GB, 4.682 GB]`.

Points use `overview_method = thin` with no `geom_overview` column, so their
only per-band cost is exact geometry plus bbox, and the bbox covering is the
largest column, about 1.8x the geometry bytes on the point sets.
