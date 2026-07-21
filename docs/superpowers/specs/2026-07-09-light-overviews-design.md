# Light overviews, browser-fast banding

Status draft. Date 2026-07-09. Supersedes the v0.3.0 all-the-way-down density
thinning for the coarse-band layout. Keeps the v0.3.0 features that are
independent of thinning.

## Problem

The v0.3.0 converter replaced fraction banding with density thinning applied to
every coarse band. A bake-off against cayetanobv's fraction model (his PR #6,
`feat/tolerance-ladder-options`) across six dataset archetypes shows the thinning
makes the overview column far heavier for no preview gain, and it is slower to
generate. The measurements, same band count and same zstd level 6 for both,
follow.

| dataset | rows | bands | overview col A (thinning) | overview col B (fraction) | file A | file B | gen A | gen B |
|---|---|---|---|---|---|---|---|---|
| countries | 258 | 5 | 0.32 MB | 0.18 MB | 5.1 MB | 5.0 MB | 0.4s | 0.4s |
| timezones | 120 | 4 | 0.05 MB | 0.03 MB | 1.4 MB | 1.5 MB | fast | fast |
| states | 4,596 | 4 | 0.39 MB | 0.25 MB | 11.9 MB | 11.9 MB | 0.6s | 0.6s |
| finland buildings | 5.65 M | 5 | 112.0 MB | 14.0 MB | 431.5 MB | 326.3 MB | 46s | 23s |
| roads (lines) | 1.41 M | 6 | 11.39 MB | 6.70 MB | 147.7 MB | 143.5 MB | 7.9s | 4.8s |
| pois (points) | 266 k | 3 | none | none | 9.8 MB | 9.7 MB | fast | fast |

Findings.

1. On dense small polygons, the case that matters most, fraction banding is
   decisive. The overview column is 8x smaller, the file is 24 percent smaller,
   and generation is 2x faster.
2. On lines, fraction banding wins by 1.7x on the overview column and 1.6x on
   time. On sparse and medium polygons the two tie, both overview columns tiny.
   On pure points neither writes an overview column, so they are identical.
3. The v0.3.0 bloat lives entirely in the deep coarse bands. On Finland, band 3
   alone is 66 MB, holding 2.8M features snapped to a 19m grid at z12 to z13,
   which is near-exact detail stored a second time. Band 0, the whole-country
   preview, is only 2.29 MB.
4. Thinning has one real, measured win, spatial coverage at band 0. On Finland,
   the thinned band 0 fills 2070 of a 4096 cell grid with 141k features, while
   the fraction band 0 fills only 1677 with 237k features, because ranking by
   area clusters the overview in cities and empties rural cells. This win is
   cheap, 2.29 MB, and confined to the coarsest band.

## Goals

Make the browser render fast at every zoom by keeping the overview column small
and coarse, keep the one measured quality win (even band-0 coverage plus the
density signal), and remove the machinery that only served all-the-way-down
thinning.

## Design

The banding backbone becomes fraction plus a dense geometric extent-relative
ladder, cayetanobv's model, ported onto the current spec rather than reverting
the footer.

1. Extent-anchored coarsest band. The coarsest band is anchored at the zoom
   where the dataset extent fills a screen (`_coarsest_zoom`, kept from v0.3.0),
   so a city-scale file spends no bands on zooms where its extent is a speck.
2. Dense factor-2 ladder. Band 0 simplifies at `coarsest_rel` of the larger
   extent span, and each finer coarse band halves the tolerance, one web zoom per
   band. Tunable through `--coarsest-rel` and `--ladder-factor`, defaults from
   PR #6.
3. Geometric feature split. Coarse bands take a doubling share of features by
   importance, largest first, so each coarse band stays small and the exact band
   keeps the remainder. Tunable through `--band-fractions`.
4. Depth cap, the browser-speed lever. The overview ladder stops at a capped
   zoom past which exact geometry read with page pruning already meets a
   decoded-bytes-per-screen budget. Beyond the cap no overview band is written
   and the viewer reads exact geometry, which it already does through page
   pruning and the `columnForRowGroup` gate. This is what prevents the deep-band
   bloat and keeps decode small at every zoom. The cap replaces the per-band
   screen-budget derivation with a single once-per-file computation.
5. Band-0 thinning only. One-survivor-per-pixel thinning runs on the coarsest
   band alone, so its whole-extent coverage stays even and each survivor carries
   `overview_count`, the count of features that competed for its cell. Deeper
   coarse bands are pure fraction, no thinning. This reclaims the coverage win
   and keeps the density signal as a near-free band-0-only attribute.

## Kept from v0.3.0, independent of thinning

Quad and segment collapse fallbacks so a collapsed shape never writes NULL and
never blanks the first paint. Per-band grid snap and the giant-triangle fix on
both the converter and viewer sides. WKB columns past 2 GB. `--jobs` threaded
overview build. Native-geo dual write and the Profile A and Profile B bbox
regime. Geometry-type awareness across points, lines, polygons, holes, and
collections.

## Removed

`_thin_bands` cascade beyond band 0, `_band_budgets` and `--drop-rate`,
`_detect_regime`, the per-band screen-budget `_derive_bands`, and the parts of
`_local_byte_density` and `_representative_points` that only fed all-band
thinning. Band 0 thinning keeps a small representative-point and per-cell-winner
path. Net removal is on the order of 850 lines from `convert.py`.

## Footer and viewer

The `overviews` key stays at the current version and keeps `min_zoom`, `grid`,
`feature_count`, `count_column`, and the per-level fields. `overview_count`
stays, now populated only on band 0. `regime` becomes a plain label since the
regime branch is gone. The viewer keeps its density-count rendering for band 0,
its page-pruning read of exact geometry for zooms past the cap, and the
`columnForRowGroup` gate.

## Open implementation questions

1. The exact depth-cap formula. Recommended start, cap the ladder where a
   whole-screen view of exact geometry meets the decoded-bytes-per-screen budget,
   computed once from a cheap byte-density estimate, with `--overview-max-zoom`
   and `--bands` as manual overrides. Validate against the six fixtures so the
   cap lands where the bake-off shows exact reads become competitive, around the
   gsd where a coarse band would otherwise exceed a few MB.
2. Whether band-0 thinning should also apply to band 1 when band 0 alone is too
   sparse to cover the extent. Decide empirically during implementation.

## Validation

Re-run the six-archetype bake-off against the new converter and confirm the
overview column tracks variant B within a small margin, the file shrinks toward
variant B, band-0 coverage matches or beats the old thinned band 0, and browser
whole-extent and mid-zoom decode bytes drop. Full converter test suite green and
ruff clean.
