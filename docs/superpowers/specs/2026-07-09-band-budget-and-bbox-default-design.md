# Per-band feature budget and regime-adaptive bbox default

Status draft. Date 2026-07-09. Branch `feat/v030-band-thinning`.

## Problem

Three hosted `v0.3.0/` files were audited with DuckDB/pyarrow against the
current `_derive_bands`/`_thin_bands` code (see the validation subagent
report in this session, not yet written to a file). Two claims about them
turned out to be false alarms, one claim was half right, and one claim
pointed at a real, narrow gap:

- `timezones.overviews.parquet` and `country_boundaries.overviews.parquet`
  showing only one coarse band is a **stale hosted artifact**, not a live
  bug. Both predate `_local_byte_density`. Re-running the current converter
  on the real timezone bytes derives 5 levels, not 2. Fix is reconvert and
  republish, no code change.
- No geometry duplication exists anywhere. `geom_overview` is correctly
  `NULL` on the finest/exact band on every file checked. Nothing to fix.
- The `bbox` covering column is a rounding error on the polygon-heavy files
  (0.001-0.025% of file size) but 17.7% of `overture-tokyo/buildings.parquet`
  (126.8 MB compressed). Whether it is worth writing is dataset-dependent,
  not a blanket yes or no.
- `overture-tokyo/buildings.parquet`'s band ladder is internally consistent
  with the current extent-anchored design (not stale, unlike the other two),
  but 90% of its features and 78% of its `geom_overview` bytes concentrate in
  two mid-zoom bands (z12-13: 3.80M features, z14-15: 2.00M features), while
  the coarsest band (first paint) is already cheap. This is a real
  disproportion worth fixing.

Root cause of the buildings disproportion: `_derive_bands` only applies the
density/budget math (`_local_byte_density` plus `--screen-budget-mb`) at the
two ladder endpoints, `z_coarsest` and `z_fine`. Every band in between steps a
fixed `_ZOOMS_PER_BAND = 2` zooms and is thinned to exactly one survivor per
pixel at that zoom (`_overview_tolerances`), a purely geometric 4x cell-count
growth per band with no connection to the budget math governing the
endpoints. For a dataset whose density grows fast with zoom, that geometric
growth concentrates almost all survivors in the middle of the ladder before
it reaches the endpoint the budget math actually bounds.

Per-screen decoded bytes are not the right target for fixing this: one
survivor per pixel already bounds any single screen to at most
`_SCREEN_PX**2` survivors regardless of band, by construction. The
disproportion is in **total file size across the whole extent**, a
storage/conversion-time cost, not a per-view decode cost. The fix targets
that directly.

## Design principle: zero-flag defaults

Both designs below must work correctly for a user who runs
`gpo convert in.parquet out.parquet` with no flags at all, on any dataset
shape, and get a good result without knowing this document exists. Every new
knob (`--drop-rate`, the now-adaptive `--bbox`/`--no-bbox`) is an escape hatch
for someone who has looked at their own output and wants to override the
default, never something a first-time user has to reach for. This mirrors
`--screen-budget-mb` and `--bands`, already overridable derivations rather
than required inputs. Concretely: `--drop-rate` ships with a default (`2.0`)
chosen to behave reasonably across both regimes without tuning, and the bbox
default requires zero flags to pick the right profile per dataset, replacing
what used to be a fixed always-on default that the user had to know to turn
off.

## Prior art

- **Tippecanoe** (`--drop-rate`/`-r`, default 2.5): a flat, empirically chosen
  per-zoom-level feature falloff applied uniformly. The README states
  plainly it does not know why 2.5 is correct, only that many datasets fall
  off at about that rate. Adaptive thinning (`-g`/gamma, `-as`/`-ad`) is an
  optional override on top of the flat default, not the default mechanism.
- **gpq-tiles** (github.com/geoparquet-io/gpq-tiles), a live, independent
  project solving a near-identical problem (one multi-resolution GeoParquet
  file, band/level ladder, no per-tile pyramid). Its `duplicating` mode
  layers a hard per-level survivor cap on top of its own per-cell grid
  thinning: `budget(level) = N / drop_rate ** (finest_level - level)`,
  default `drop_rate = 1.65`, explicitly "tippecanoe-inspired." When a
  level's grid-winner count still exceeds its budget, the excess is demoted
  further down the ladder by importance rank. Its `partitioning` mode (no
  duplication, no simplification) is the same shape as our approach and
  cites Kanahiro's COGP draft, already in our DESIGN.md prior-art section;
  worth a cross-reference there later, not part of this change.
- Neither GDAL/OGR, PostGIS, nor QGIS publish a standard tolerance-vs-zoom or
  decimation-vs-zoom formula. The closest convention anywhere is "keep
  tolerance to about one pixel/tile unit, recomputed per zoom," which is
  already what `_overview_tolerances` does. Nothing there beats the current
  per-band tolerance; the gap is purely the missing total-count cap.

## Design 1: per-band geometric feature-count budget

Add a hard cap on total survivors per coarse band, layered on top of
`_thin_bands`'s existing one-per-pixel cell selection, modeled on gpq-tiles:

```
budget(b) = n_valid / drop_rate ** (finest_coarse_band - b + 1)
```

where `finest_coarse_band = bands - 2` (the last coarse band before the exact
band), `n_valid` is the total valid feature count, and `drop_rate` defaults
to `2.0` (between tippecanoe's 2.5 and gpq-tiles' 1.65). Band 0 gets the
smallest budget, each successive coarse band's budget grows geometrically,
and, unlike gpq-tiles' own formula (whose finest level is the canonical,
never-capped one), **the last coarse band is capped too**, at
`n_valid / drop_rate`. This matters because every row gets exactly one
`geom_overview` value regardless of which coarse band claims it (simplified
at that band's tolerance) except in the exact band, where it is `NULL`.
Demoting an intermediate band's overflow into the next coarse band therefore
does not shrink the file, it only changes how simplified that feature's
overview is. Only overflow that reaches the exact band skips overview
storage entirely, so the last coarse band must be capped too or the
mechanism only redistributes bytes between bands instead of reducing their
total. Genuine overflow from the last coarse band demotes straight into the
exact band, skipping its overview and appearing only once a view is actually
at the zoom where exact geometry is affordable. This is a visibility gate,
not data loss: the feature is still in the file (exact band, per the
existing "no feature is ever dropped" invariant), it simply does not
preview at a coarser zoom, the same behavior gpq-tiles' own
`visibility_factor` gate produces for low-importance features.

`budget(b)` is floored to an integer and never allowed below 1 for a band
that has any occupied cells at all: `max(1, floor(...))`. Without that floor
a tiny `n_valid` with several bands could round a coarse band's budget to 0,
erasing its first paint entirely, which is a different failure than the
legitimate empty-band merge already in the pipeline (a band with no
*occupied cells*, not a band whose cap rounded to nothing).

Mechanism, inside `_thin_bands`'s per-band loop:

1. Compute per-cell winners for band `b` exactly as today (highest
   `(metric, stable_hash)` per occupied cell).
2. If `len(winners) > floor(budget(b))`, sort winners by the same
   `(metric desc, stable_hash asc)` total order already used for cell
   contention and keep only the top `floor(budget(b))`.
3. Demote the excess into band `b + 1`'s contention pool exactly like
   today's cell-contention losers. They are reconsidered at band `b + 1`'s
   finer grid, not dropped.

No new tie-break rule, no change to zoom/row-group boundaries, no change to
`_derive_bands`'s band count. `overview_count` (survivor cell population)
needs no new code, a budget-cap loser is indistinguishable from a
cell-contention loser once it enters band `b + 1`'s pool and is recounted
there. Each survivor's own count stays the exact population of the cell it
won, but this changes the aggregate invariant documented elsewhere, band 0's
counts no longer sum to the full valid total whenever its own budget
actually binds, the demoted winner's tally moves to band `b + 1` with it.
The sum equals the total only when no per-band budget binds on band 0.

`drop_rate` is exposed as `--drop-rate` (default `2.0`) on the CLI and
`ConvertOptions`, alongside `--screen-budget-mb` and `--bands`, the existing
overridable-derivation pattern. `_validate_options` rejects `drop_rate <= 1.0`
(no falloff or growth toward finer bands would defeat the cap).

Sparse/light datasets are unaffected: if `_derive_bands` already derives a
single exact band with no overview (per the existing "affordable at
`z_coarsest`" path), there is no coarse band to budget and this is a no-op.
Vertex-heavy datasets like `country_boundaries.overviews.parquet` (3-246
features total) are unaffected in practice, since `budget(b)` at those
feature counts exceeds any band's actual survivor count long before the cap
would bind.

## Design 2: regime-adaptive `--bbox` default

`_detect_regime` (count-heavy vs vertex-heavy, from average exact bytes per
valid feature) already exists and is already computed before band
derivation. Reuse it to pick the `--bbox` default instead of a fixed
always-on default:

- `regime == "count"` (buildings, points): default bbox **on**. Many
  features per row group means the `bbox` covering's ColumnIndex/OffsetIndex
  meaningfully narrows a read below row-group granularity, worth the cost
  (17.7% of file on the buildings fixture).
- `regime == "vertex"` (timezones, country_boundaries): default bbox **off**.
  A handful of giant polygons per row group means row-group-level
  GeospatialStatistics already captures everything a covering column would
  add; measured overhead is negligible (0.001-0.025%) but there is no reason
  to pay it by default.

`--bbox`/`--no-bbox` still force the choice explicitly when passed;
`ConvertOptions.bbox` becomes `bool | None` (`None` = adaptive). The existing
safety invariant is preserved and extended: `_validate_options` continues to
raise on explicit `--no-bbox --no-native-geo`, and if the *adaptive* default
would resolve to no-bbox while `--no-native-geo` is also in effect (explicit
or otherwise), the resolved default is forced back to bbox-on rather than
silently shipping a file with zero pruning surface. The regime detection call
in `convert()` (currently after `z_coarsest`) moves earlier, immediately
after the measure step where `total_exact_bytes`/`n_valid` become available;
it has no dependency on `z_coarsest` and this makes the adaptive bbox default
available before the write-planning stage needs it.

## Non-goals

- Not touching `_ZOOMS_PER_BAND`, `_coarsest_zoom`, or `_derive_bands`'s band
  count formula. The budget cap works entirely inside the existing ladder.
- Not adding per-geometry-type thinning factors (gpq-tiles uses 4x pixel
  cells for points vs 1x for lines/polygons). Worth a future look, out of
  scope here.
- Not reconciling naming with gpq-tiles/COGP in this change. Flagged in
  Prior art for a future DESIGN.md pass.

## Testing

- `tests/test_convert.py`: new cases asserting a synthetic count-heavy
  dataset (many small clustered features) produces a geometrically decaying
  survivor count across coarse bands within tolerance of `budget(b)`, and
  that total feature count across all bands still equals `n_valid`.
- A `--drop-rate` boundary test (`<= 1.0` rejected).
- Regime-adaptive bbox: one synthetic count-heavy table asserting bbox
  columns are written by default, one vertex-heavy table asserting they are
  not, and one asserting `--no-bbox --no-native-geo` still raises regardless
  of regime.
- Re-run `test_reconvert_native_output_is_idempotent`-style round trip on
  both new code paths, per the converter's existing re-conversion caution
  (drop-list/covering-strip bugs only show up on a second conversion of real
  prior output, not a fresh synthetic table).
- Re-run the real fixtures (`timezones`, `country_boundaries`,
  `overture-tokyo/buildings`) through the updated converter and confirm: (a)
  timezones/country now derive multiple bands, (b) buildings' mid-band
  feature share drops meaningfully below the current 59%/31% split, (c)
  buildings gets bbox by default and country/timezones do not.

## Rollout

Reconvert and republish the hosted `v0.3.0/` prefix with the updated
converter once this lands, per the pending item already tracked in root
CLAUDE.md. This single reconversion resolves the stale-band-count symptom,
the buildings mid-band disproportion, and the bbox default in one pass, no
separate operational step needed beyond the existing pending republish.
