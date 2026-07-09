# v0.3.0 density visibility and ladder fixes

Date 2026-07-07. Status complete, implemented on `feat/v030-band-thinning`.

Scope. Two symptoms reported against the v0.3.0 branch. First, too much
detail at high zooms, dense city views decode far past the screen budget.
Second, the initial whole-extent view shows no density structure, and on some
datasets nearly nothing at all. Four parallel review agents mapped the
converter math, the viewer read path, the docs drift, and the full branch
diff. This document records the root causes found and the fixes shipped.

---

## 1. Root causes

Three distinct defects stacked into the two symptoms.

1. **The band budget was blind to clustering.** `_derive_bands` divided total
   exact WKB bytes by the whole bounding-box area. Finnish buildings cluster in
   cities inside a mostly empty diagonal bbox, so the average density
   understated the local density 31.5x, the ladder derived too few coarse
   bands, and the unthinned exact band took over at z12. A dense city screen at
   z12 decoded raw exact geometry far past the 1 MB budget. That is symptom 1.
   The direction is the opposite of the naive reading, clustered data needs
   more overview bands, not fewer.

2. **Sub-pixel survivors wrote NULL overviews and blanked the first paint.**
   Under the per-band snap grids, band 0 of the Finland file snaps at 305.7 m.
   A 26 m median building collapses to degenerate, the spec wrote NULL, the
   reader must skip NULLs, so band 0's overview column held 0.03 MB for
   141,594 survivors and the whole-country first paint drew almost nothing.
   That is the severe form of symptom 2.

3. **Thinning erased the density signal.** One survivor per pixel makes a
   10,000-feature city cell and a 2-feature rural cell paint identically, and
   the survivor carried no count. The viewer's flat single-color styling could
   not recover what the writer had already discarded. That is the subtle form
   of symptom 2, and it was flagged as future work in the v0.3.0 research plan
   and never implemented.

Also found and fixed along the way. No clamp kept overview bands under the
zoom model's z24 ceiling on tiny-extent dense data. A GEOS failure in the
representative-point path degraded a whole `--jobs` chunk, making output
depend on thread count. A file that collapses to a single band wrote a false
`overview_method` of `simplify_snap`. The viewer applied the
coarser-band-exact-geometry fallback to pre-0.3.0 files whose single fine
global grid never had the giant-triangle problem, multiplying their mid-zoom
read cost.

## 2. Fixes

1. **Local byte density.** `_local_byte_density` buckets feature bytes into a
   128x128 grid over the extent and the budget solves against the
   byte-weighted 0.9 quantile of occupied-cell densities. Uniform data
   reproduces the plain average, clustered data derives the bands its dense
   screens need.
2. **Shape-preserving collapse fallback.** Wherever simplify plus snap
   collapses a shape below the band pixel, a polygon survivor writes a small
   grid-aligned quad sized by its own area (`_quad_fallback`, one grid cell
   up to one band pixel, Tippecanoe's tiny-polygon-reduction idiom) and a
   line survivor writes a short segment along its own direction
   (`_segment_fallback`). Every survivor stays paintable in its own geometry
   kind, only point features paint as points, and NULL remains only when
   even the fallback fails. A first iteration used representative points for
   everything, rejected by the owner because coarse bands must look like
   shapes, and the quad costs about 4x the point bytes. Coarse coverings pad
   by half the band tolerance to enclose the quad.
3. **Survivor counts.** `_thin_bands` returns each survivor's cell population,
   written as the int32 `overview_count` column and advertised by the footer's
   `count_column`. Band 0 counts sum to every valid feature. The viewer scales
   point radius and fill alpha by the count, so the coarse preview is
   density weighted.
4. **Zoom ceiling.** `_max_coarse_for_zoom` clamps derived and forced band
   counts so no overview band serves at or past z24.
5. **Determinism.** `_precise_xy` falls back per feature, never per chunk, and
   catches TypeError alongside GEOSException.
6. **Footer honesty.** A single-band file writes `overview_method` `none`.
7. **Viewer gating.** The coarser-band exact-geometry fallback applies only to
   0.3.0 and later files, pre-0.3.0 files keep reading their cheap, correct
   overviews at mid zooms.

## 3. Measured, Finland buildings

5,651,275 polygons, EPSG:3067. Local density 0.0256 B per unit squared against
a 0.000811 average, 31.5x clustering, deriving 5 bands anchored at z7.

| band | serves | features | overview decoded | overview on disk |
| --- | --- | --: | --: | --: |
| 0 | z0 to z7 | 141,594 | 13.16 MB | 1.98 MB |
| 1 | z8 to z9 | 753,536 | 69.90 MB | 11.56 MB |
| 2 | z10 to z11 | 2,101,935 | 191.12 MB | 39.54 MB |
| 3 | z12 to z13 | 2,470,761 | 200.87 MB | 53.03 MB |
| 4 exact | z14 up | 183,449 | none | none |

Whole-country first paint decodes 13.2 MB against 620 MB exact, 47x, reading
about 2 MB from disk, painted as area-sized building quads with counts. The
pre-fix branch state painted a near-empty band 0 (0.03 MB of mostly NULLs).
The pre-0.3.0 fraction layout read about 9 MB decoded and 2.4 MB on disk,
67x, with no density signal and coverage stopping at z10. Exact geometry now
takes over at z14 instead of z12, so dense city mid-zoom screens get a
thinned overview instead of raw exact geometry. File size is 488 MB against
372 MB for the fraction layout, the cost of two more overview zoom levels,
the quad fallback, and the count column. An intermediate point-fallback
build measured 0.62 MB on disk for band 0, the quad default costs about 3x
that on the first paint and was chosen deliberately, coarse bands must look
like shapes.

For comparison, the community fork ladder experiment (PR #6, six coarse bands
at one zoom per band, hand-tuned flags) measured a 1.20 MB whole-country
preview with overview coverage to z12. The derived ladder reaches 1.98 MB of
shape-painting quads with counts and coverage to z13 with no tuning flags,
which retires that PR's motivation, its two insights, a denser ladder and
zoom-matched simplification, are structural in v0.3.0.

## 4. What stays open

- The band 3 overview at z12 to z13 is 53 MB on disk and shrinks only 23
  percent against exact, a snapped four-point building is already near
  minimal. Bbox pruning cuts a city view to a few row groups and thinning
  halves the feature count, but a future draft could let such a band declare
  itself exact-read with no overview values at all.
- Counts are per band, not cumulative across bands, so a viewer summing
  counts of overlapping survivors from different bands double counts
  slightly. Per-feature proportional symbols, the intended use, are exact.
- The docs audit fixes (converter README CLI table, stale example log, README
  reframe) shipped with this change set.
