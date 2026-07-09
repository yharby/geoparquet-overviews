# Per-band feature budget and regime-adaptive bbox default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap total coarse-band survivors geometrically (gpq-tiles/tippecanoe style) so genuine overflow reaches the exact band and skips its overview, and make the `bbox` covering column's default follow the existing count/vertex regime signal instead of always writing it, all with zero required new flags for a default `gpo convert` run.

**Architecture:** Two independent, additive changes to `converter/src/geoparquet_overviews/convert.py`: (1) a new pure function `_band_budgets` plus a new optional `budgets` parameter on `_thin_bands` that demotes cell-contention winners past their band's budget, wired in via a new `drop_rate` option; (2) a `bbox: bool | None` tri-state on `ConvertOptions`, resolved to `on`/`off` right after `_detect_regime` runs in `convert()`, replacing the three `opts.bbox` read sites with the resolved value.

**Tech Stack:** Python, numpy, pyarrow, shapely, click, pytest. No new dependencies.

## Global Constraints

- Every new option ships with a default that produces correct behavior with zero flags (`docs/superpowers/specs/2026-07-09-band-budget-and-bbox-default-design.md`, "Design principle: zero-flag defaults"). `--drop-rate` and the now-adaptive `--bbox`/`--no-bbox` are escape hatches, never required.
- `drop_rate` must be `> 1.0` (a value at or below it would defeat the geometric cap).
- The `bbox`/`--no-native-geo` safety invariant is preserved: an *explicit* `--no-bbox --no-native-geo` combination still raises. An *adaptive* resolution that would land on bbox-off while native-geo is off is silently forced back to bbox-on instead, never raises.
- No feature is ever dropped. The budget cap only changes which band (and therefore which overview tolerance, or none at all in the exact band) a feature ends up in.
- Do not rename `overviews`, `geom_overview`, `band`, `bbox`, or any existing footer field.
- Follow the repository's existing docstring style: explain *why*, not just *what*, especially for the non-obvious "last coarse band must be capped too" reasoning.

---

## File Structure

- Modify `converter/src/geoparquet_overviews/convert.py`: `ConvertOptions` (new `drop_rate` field, `bbox` type change), `_validate_options` (new checks), new `_band_budgets` function, `_thin_bands` (new `budgets` parameter), `convert()` (bbox resolution, budgets wiring, summary field).
- Modify `converter/src/geoparquet_overviews/cli.py`: new `--drop-rate` option, `--bbox/--no-bbox` becomes tri-state.
- Modify `converter/tests/test_convert.py`: new tests for `_band_budgets`, `_thin_bands` budget behavior, `convert()`-level drop_rate wiring, adaptive bbox default; fix two existing tests whose fixtures resolve to vertex regime and would otherwise silently lose their `bbox` column.
- Modify `converter/README.md`: CLI options table.
- Modify `converter/CLAUDE.md`: "Two profiles" section, regime section.
- Modify root `CLAUDE.md`: "State of things" bullet list.

---

### Task 1: `_band_budgets`, the per-band geometric survivor ceiling

**Files:**
- Modify: `converter/src/geoparquet_overviews/convert.py` (add function after `_max_coarse_for_zoom`, i.e. after line 381, before `_derive_bands` at line 384)
- Test: `converter/tests/test_convert.py`

**Interfaces:**
- Produces: `_band_budgets(n_valid: int, bands: int, drop_rate: float) -> dict[int, int]`, keyed `0..bands-2` (same keys `_thin_bands` iterates), values `>= 1`. Empty dict when `bands <= 1`.

- [ ] **Step 1: Write the failing tests**

Add to `converter/tests/test_convert.py`, near `test_detect_regime_labels` (the import list at the top already includes `_detect_regime`; add `_band_budgets` to that same `from geoparquet_overviews.convert import (...)` block):

```python
def test_band_budgets_decay_geometrically():
    """Each coarse band's budget is a geometric fraction of n_valid, tightest at
    band 0. Unlike gpq-tiles' own formula (whose finest level is the canonical,
    never-capped one), the last coarse band is capped too, at n_valid /
    drop_rate, which is what lets real overflow reach the exact band."""
    budgets = _band_budgets(n_valid=1600, bands=4, drop_rate=2.0)
    # 3 coarse bands (0, 1, 2), finest coarse band is 2.
    assert budgets == {0: 200, 1: 400, 2: 800}


def test_band_budgets_no_coarse_bands_is_empty():
    assert _band_budgets(n_valid=500, bands=1, drop_rate=2.0) == {}


def test_band_budgets_floors_at_one():
    # A tiny n_valid with several bands and a steep drop_rate would otherwise
    # round band 0's budget to 0, erasing its first paint entirely, a
    # different failure than the legitimate empty-band merge elsewhere in the
    # pipeline (that merge is for a band with no occupied cells at all).
    budgets = _band_budgets(n_valid=5, bands=5, drop_rate=10.0)
    assert all(v >= 1 for v in budgets.values())
    assert budgets[0] == 1
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd converter && uv run pytest tests/test_convert.py -k band_budgets -v`
Expected: FAIL with `ImportError` or `NameError` (`_band_budgets` does not exist yet), or a collection error if the import line was edited before the function exists — either way, not a pass.

- [ ] **Step 3: Add `_band_budgets` and its import**

In `converter/src/geoparquet_overviews/convert.py`, insert immediately after `_max_coarse_for_zoom` (after line 381, before `def _derive_bands` at line 384):

```python
def _band_budgets(n_valid: int, bands: int, drop_rate: float) -> dict[int, int]:
    """Per-coarse-band survivor ceiling, geometric decay toward the coarsest
    band, gpq-tiles/tippecanoe style: budget(b) = n_valid / drop_rate **
    (finest - b + 1), where finest = bands - 2 is the last coarse band before
    the exact band.

    Unlike gpq-tiles' own formula, whose finest level is the canonical,
    never-capped one, the last coarse band here is capped too, at
    n_valid / drop_rate. That matters because every row gets exactly one
    `geom_overview` value, simplified at whichever coarse band's tolerance it
    ends up assigned to, except in the exact band where it is null. Demoting
    an intermediate band's overflow into the next coarse band therefore does
    not shrink the file, it only changes how simplified that feature's
    overview is. Only overflow that reaches the exact band skips overview
    storage entirely, so the last coarse band must be capped too or this
    mechanism only redistributes bytes between bands instead of reducing
    their total. Genuine overflow from the last coarse band demotes straight
    into the exact band via the same demotion path `_thin_bands` already
    uses, a visibility gate, not data loss, since the feature is still in
    the file per the "no feature is ever dropped" invariant, it simply does
    not preview at a coarser zoom.

    Floored to an integer and never allowed below 1, so the cap alone can
    never erase a band's first paint (an empty band from having no occupied
    cells at all is a different, already-handled case, see the empty-band
    merge in `convert()`). Returns an empty dict when there is no coarse
    band to budget (bands <= 1), the caller's cap then never binds."""
    if bands <= 1:
        return {}
    finest = bands - 2
    return {
        b: max(1, int(n_valid / drop_rate ** (finest - b + 1)))
        for b in range(bands - 1)
    }
```

In `converter/tests/test_convert.py`, add `_band_budgets` to the existing import block:

```python
from geoparquet_overviews.convert import (
    _ZOOMS_PER_BAND,
    ConvertOptions,
    _band_budgets,
    _derive_bands,
    _detect_regime,
    _is_geographic,
    _overview_grids,
    _overview_tolerances,
    _plan_row_groups,
    convert,
)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd converter && uv run pytest tests/test_convert.py -k band_budgets -v`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add converter/src/geoparquet_overviews/convert.py converter/tests/test_convert.py
git commit -m "feat(converter): add _band_budgets, the per-band geometric survivor ceiling"
```

---

### Task 2: Wire the budget into `_thin_bands`

**Files:**
- Modify: `converter/src/geoparquet_overviews/convert.py:579-630` (`_thin_bands`)
- Test: `converter/tests/test_convert.py`

**Interfaces:**
- Consumes: `_band_budgets` output shape (`dict[int, int]`) from Task 1.
- Produces: `_thin_bands(..., budgets: dict[int, int] | None = None)`, same return shape `(band: np.ndarray, counts: np.ndarray)` as before. All existing call sites that omit `budgets` keep behaving exactly as before (default `None` is a no-op).

- [ ] **Step 1: Write the failing tests**

Add to `converter/tests/test_convert.py`, near `test_thinned_band_is_subset_of_source`:

```python
def test_thin_bands_budget_caps_survivors_beyond_cell_contention():
    """Ten features, each alone in its own cell (cell contention alone would
    keep all ten), with a budget of 3 on band 0. Only the top 3 by metric
    survive band 0, the rest demote to band 1 with their count reset to 0,
    exactly like a cell-contention loser."""
    n = 10
    dimensions = np.full(n, 2, dtype=np.int8)
    valid = np.ones(n, dtype=bool)
    band = np.zeros(n, dtype=np.int16)
    rx = np.arange(n, dtype=np.float64) * 10.0  # far apart, one per cell
    ry = np.zeros(n, dtype=np.float64)
    metric = np.arange(n, dtype=np.float64)  # feature 9 is the most important
    stable_hash = np.arange(n, dtype=np.uint32)
    bands = 2
    tolerances = {0: 1.0}
    origin = (0.0, 0.0)
    budgets = {0: 3}

    out, counts = convert_mod._thin_bands(
        band, dimensions, rx, ry, metric, stable_hash, valid, bands,
        tolerances, origin, budgets,
    )
    survivors = set(np.where(out == 0)[0].tolist())
    assert survivors == {9, 8, 7}  # the three highest metric values
    assert int((out == 0).sum()) == 3
    assert int((out == 1).sum()) == 7
    demoted = set(range(n)) - survivors
    assert np.all(counts[list(demoted)] == 0)


def test_thin_bands_last_band_budget_sends_overflow_to_exact():
    """Capping the last coarse band too (not just intermediate ones) is what
    makes the budget actually shrink the file: real overflow from the last
    coarse band demotes straight into the exact band and skips its overview,
    rather than cycling between coarse bands."""
    n = 6
    dimensions = np.full(n, 2, dtype=np.int8)
    valid = np.ones(n, dtype=bool)
    band = np.zeros(n, dtype=np.int16)  # everyone starts in the only coarse band
    rx = np.arange(n, dtype=np.float64) * 10.0  # one per cell regardless of tolerance
    ry = np.zeros(n, dtype=np.float64)
    metric = np.arange(n, dtype=np.float64)
    stable_hash = np.arange(n, dtype=np.uint32)
    bands = 2  # one coarse band (0) plus the exact band (1)
    tolerances = {0: 1.0}
    origin = (0.0, 0.0)
    budgets = {0: 2}  # only the top 2 by metric may stay in this, the last coarse band

    out, counts = convert_mod._thin_bands(
        band, dimensions, rx, ry, metric, stable_hash, valid, bands,
        tolerances, origin, budgets,
    )
    assert set(np.where(out == 0)[0].tolist()) == {4, 5}
    assert set(np.where(out == 1)[0].tolist()) == {0, 1, 2, 3}
    # The exact band is never thinned, its members keep count 0 (written null).
    assert np.all(counts[[0, 1, 2, 3]] == 0)


def test_thin_bands_budgets_none_is_unchanged():
    """Omitting `budgets` (the default) must reproduce the pre-existing
    cell-contention-only behavior exactly."""
    rng = np.random.default_rng(11)
    n = 200
    dimensions = np.full(n, 2, dtype=np.int8)
    valid = np.ones(n, dtype=bool)
    band = np.array([i % 3 for i in range(n)], dtype=np.int16)
    rx = rng.integers(0, 5, n).astype(np.float64)
    ry = rng.integers(0, 5, n).astype(np.float64)
    metric = rng.random(n)
    stable_hash = rng.integers(0, 2**32, n, dtype=np.uint64).astype(np.uint32)
    bands = 4
    tolerances = convert_mod._overview_tolerances(bands, 10.0, convert_mod._ZOOMS_PER_BAND)
    origin = (0.0, 0.0)

    without_arg, counts_a = convert_mod._thin_bands(
        band, dimensions, rx, ry, metric, stable_hash, valid, bands, tolerances, origin
    )
    with_none, counts_b = convert_mod._thin_bands(
        band, dimensions, rx, ry, metric, stable_hash, valid, bands, tolerances, origin, None
    )
    assert np.array_equal(without_arg, with_none)
    assert np.array_equal(counts_a, counts_b)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd converter && uv run pytest tests/test_convert.py -k "thin_bands_budget or thin_bands_last_band or thin_bands_budgets_none" -v`
Expected: FAIL with `TypeError: _thin_bands() takes ... positional arguments but ... were given` (the `budgets` parameter does not exist yet).

- [ ] **Step 3: Implement the budget cap in `_thin_bands`**

Replace the whole `_thin_bands` function (`converter/src/geoparquet_overviews/convert.py:579-630`) with:

```python
def _thin_bands(
    band: np.ndarray, dimensions: np.ndarray, rx: np.ndarray, ry: np.ndarray,
    metric: np.ndarray, stable_hash: np.ndarray, valid: np.ndarray, bands: int,
    tolerances: dict[int, float], origin: tuple[float, float],
    budgets: dict[int, int] | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Demote over-dense features to finer bands so each coarse band holds at
    most one feature per one-pixel cell, per geometry dimension. Coarsest band
    first, within band b lay the band's grid (cell size tolerances[b]), and in
    every occupied cell keep the single highest (metric, then stable_hash)
    feature, demoting the rest to band b+1 where they are reconsidered. The
    finest band is never thinned, so no feature leaves the file, it only moves
    to a finer band. Features of different geometry dimensions never contend for
    the same cell, so a point and the polygon over it can both survive.

    `budgets`, from `_band_budgets`, is an optional second demotion source. If
    band b's cell-contention winners still exceed `budgets[b]`, the lowest
    ranked excess (by the same (metric, stable_hash) order the cell contention
    itself uses) is demoted too, exactly like a cell-contention loser.
    Demoting the last coarse band's excess this way sends it to the exact
    band, skipping its overview entirely, the only demotion path that
    actually shrinks the file rather than just moving bytes between coarse
    bands. `None` (the default) applies no cap, unchanged from before this
    parameter existed.

    Returns the new band array, each band a subset of its pre-thinning
    membership, and a per-feature survivor count. A coarse-band survivor's count
    is how many features, itself included, competed for its one-pixel cell in
    the pass it won, the density signal thinning would otherwise destroy. One
    survivor per pixel makes a dense city and a sparse village paint identically,
    the count is what lets a viewer scale a survivor's symbol so the cluster
    stays visible. Rows the thinning never crowned (the finest band, invalid
    rows, and a row demoted past its band's budget) keep count 0, the caller
    writes those as null."""
    band = band.copy()
    counts = np.zeros(len(band), dtype=np.int64)
    for b in range(bands - 1):
        sel = np.where(valid & (band == b))[0]
        if len(sel) == 0:
            continue
        cell = tolerances[b]
        ix = np.floor((rx[sel] - origin[0]) / cell).astype(np.int64)
        iy = np.floor((ry[sel] - origin[1]) / cell).astype(np.int64)
        # Representative points of valid features are inside the dataset extent,
        # so ix and iy are non-negative. Band 0's grid is about _SCREEN_PX cells
        # across by construction of the extent-anchored ladder and each band
        # multiplies that by 2**_ZOOMS_PER_BAND, so give each axis 30 bits (past
        # a billion cells, well beyond the capped band count) and pack the
        # geometry dimension into the top 2 bits so cohorts never share a cell.
        # Total width 62 bits stays a positive int64. Clip as a last-resort guard
        # against a pathological extent.
        ix = np.clip(ix, 0, (1 << 30) - 1)
        iy = np.clip(iy, 0, (1 << 30) - 1)
        cell_id = (dimensions[sel].astype(np.int64) << 60) | (ix << 30) | iy
        winners = _winners_per_cell(cell_id, metric[sel], stable_hash[sel])
        keep = np.zeros(len(sel), dtype=bool)
        keep[winners] = True
        # How crowded each winner's cell was, the survivor's density weight.
        uniq, inverse, cell_counts = np.unique(
            cell_id, return_inverse=True, return_counts=True
        )
        counts[sel[winners]] = cell_counts[inverse[winners]]

        cap = budgets.get(b) if budgets else None
        if cap is not None and len(winners) > cap:
            rank = np.lexsort((stable_hash[sel[winners]], -metric[sel[winners]]))
            excess = winners[rank[cap:]]
            keep[excess] = False
            counts[sel[excess]] = 0

        band[sel[~keep]] = b + 1
    return band, counts
```

- [ ] **Step 4: Run the new tests, then the full thinning test subset**

Run: `cd converter && uv run pytest tests/test_convert.py -k "thin_bands_budget or thin_bands_last_band or thin_bands_budgets_none" -v`
Expected: 3 passed.

Run: `cd converter && uv run pytest tests/test_convert.py -k thin -v`
Expected: all pass, including every pre-existing thinning test (`test_thinning_demotes_dense_features`, `test_thinned_band_is_subset_of_source`, `test_thinning_is_idempotent`, `test_thinning_independent_of_input_order`, `test_thinning_byte_identical_across_jobs`, `test_thinning_survives_degenerate_geometry`, `test_thinning_is_input_order_independent`), confirming the new optional parameter did not change any pre-existing call site's behavior.

- [ ] **Step 5: Commit**

```bash
git add converter/src/geoparquet_overviews/convert.py converter/tests/test_convert.py
git commit -m "feat(converter): apply the per-band budget in _thin_bands, overflow reaches the exact band"
```

---

### Task 3: `drop_rate` option, validation, and wiring in `convert()`

**Files:**
- Modify: `converter/src/geoparquet_overviews/convert.py` (`ConvertOptions`, `_validate_options`, `convert()`)
- Test: `converter/tests/test_convert.py`

**Interfaces:**
- Consumes: `_band_budgets` (Task 1), `_thin_bands(..., budgets=...)` (Task 2).
- Produces: `ConvertOptions.drop_rate: float = 2.0`; `convert()` computes and logs `budgets` and passes them into `_thin_bands`.

- [ ] **Step 1: Write the failing tests**

Add to `converter/tests/test_convert.py`, near `test_negative_jobs_rejected`:

```python
def test_drop_rate_rejected_at_or_below_one(tmp_path):
    with pytest.raises(ValueError, match="drop_rate"):
        convert("x", "y", ConvertOptions(drop_rate=1.0))


def test_no_feature_lost_with_drop_rate(tmp_path):
    """The budget cap only redistributes rows between bands, it never drops a
    feature, even under an aggressive drop_rate."""
    src = tmp_path / "dense.parquet"
    dst = tmp_path / "out.parquet"
    _write_clustered(src, n=600, seed=2)
    convert(str(src), str(dst), ConvertOptions(bands=3, row_group_mb=0.02, drop_rate=1.05))
    out = pq.read_table(dst)
    assert out.num_rows == 600
    band = np.array(out.column("band").to_pylist())
    assert band.min() >= 0 and band.max() <= 2
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd converter && uv run pytest tests/test_convert.py -k "drop_rate" -v`
Expected: FAIL. `test_drop_rate_rejected_at_or_below_one` fails because `ConvertOptions` has no `drop_rate` field yet (`TypeError: unexpected keyword argument 'drop_rate'`). `test_no_feature_lost_with_drop_rate` fails the same way.

- [ ] **Step 3: Add the option, validation, and wiring**

In `converter/src/geoparquet_overviews/convert.py`, add to `ConvertOptions` (after the existing `thin: bool = True` field, which is currently the last field in the dataclass, around line 138):

```python
    # Geometric per-band survivor ceiling, gpq-tiles/tippecanoe style.
    # budget(b) decays toward the coarsest band, and the last coarse band is
    # capped too, so genuine overflow reaches the exact band and skips its
    # overview instead of just reshuffling bytes between coarse bands. Must
    # be greater than 1.0, a value at or below it would defeat the cap. See
    # `_band_budgets`.
    drop_rate: float = 2.0
```

In `_validate_options`, add (after the existing `if not opts.bbox and not opts.native_geo:` check, which Task 5 will also touch — for now just add this new check at the end of the function, right after that line):

```python
    if opts.drop_rate <= 1.0:
        raise ValueError(f"drop_rate must be greater than 1.0, got {opts.drop_rate}")
```

In `convert()`, inside the `if opts.thin:` block (`convert.py:1249-1261`), change:

```python
    if opts.thin:
        thin_mask = valid
        rx, ry = _representative_points(geoms, dimensions, bounds, thin_mask, jobs=opts.jobs)
        tolerances = _overview_tolerances(bands, world, z_coarsest)
        origin = (dataset_bbox[0], dataset_bbox[1])
        # Per-cohort-comparable importance, 0 for unranked points where the
        # single point per cell makes the value moot.
        metric = np.nan_to_num(score, nan=0.0)
        before = {b: int((valid & (band == b)).sum()) for b in range(bands - 1)}
        band, survivor_counts = _thin_bands(
            band, dimensions, rx, ry, metric, stable_hash, valid,
            bands, tolerances, origin,
        )
        for b in range(bands - 1):
            after = int((valid & (band == b)).sum())
            log.info("  band %d: %d -> %d features after thinning", b, before[b], after)
```

to:

```python
    if opts.thin:
        thin_mask = valid
        rx, ry = _representative_points(geoms, dimensions, bounds, thin_mask, jobs=opts.jobs)
        tolerances = _overview_tolerances(bands, world, z_coarsest)
        budgets = _band_budgets(n_valid, bands, opts.drop_rate)
        if budgets:
            log.info("per-band survivor budget (drop_rate %.2f): %s", opts.drop_rate, budgets)
        origin = (dataset_bbox[0], dataset_bbox[1])
        # Per-cohort-comparable importance, 0 for unranked points where the
        # single point per cell makes the value moot.
        metric = np.nan_to_num(score, nan=0.0)
        before = {b: int((valid & (band == b)).sum()) for b in range(bands - 1)}
        band, survivor_counts = _thin_bands(
            band, dimensions, rx, ry, metric, stable_hash, valid,
            bands, tolerances, origin, budgets,
        )
        for b in range(bands - 1):
            after = int((valid & (band == b)).sum())
            log.info("  band %d: %d -> %d features after thinning", b, before[b], after)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd converter && uv run pytest tests/test_convert.py -k "drop_rate" -v`
Expected: 2 passed.

Run: `cd converter && uv run pytest tests/test_convert.py -v`
Expected: all pass (full-suite regression check; this is the point where any test relying on the old unconditional-uncapped behavior would surface, and Task 2's Step 4 already confirmed the thinning subset).

- [ ] **Step 5: Commit**

```bash
git add converter/src/geoparquet_overviews/convert.py converter/tests/test_convert.py
git commit -m "feat(converter): add --drop-rate option, wire the per-band budget into convert()"
```

---

### Task 4: `--drop-rate` CLI flag

**Files:**
- Modify: `converter/src/geoparquet_overviews/cli.py`

**Interfaces:**
- Consumes: `ConvertOptions.drop_rate` (Task 3).

- [ ] **Step 1: Add the CLI option**

In `converter/src/geoparquet_overviews/cli.py`, add a new `@click.option` after the `--thin/--no-thin` option (currently lines 103-108, right before the `-v`/`--verbose` option):

```python
@click.option(
    "--drop-rate",
    default=2.0,
    show_default=True,
    type=float,
    help="Geometric per-band survivor ceiling. Higher asks for a steeper falloff toward the coarsest band, and the last coarse band is capped too so genuine overflow reaches the exact band and skips its overview. Must be greater than 1.0.",
)
```

Add `drop_rate: float,` to the `convert_cmd` function signature (after `thin: bool,`), and add `drop_rate=drop_rate,` to the `ConvertOptions(...)` construction (after `thin=thin,`).

- [ ] **Step 2: Verify the CLI wires it through**

Run: `cd converter && uv run gpo convert --help`
Expected: the help text lists `--drop-rate` with default `2.0`.

Run (using an existing small fixture, or generate one quickly):
```bash
cd converter && uv run python -c "
import shapely, pyarrow as pa, pyarrow.parquet as pq, json
import numpy as np
rng = np.random.default_rng(1)
geoms = [shapely.box(*rng.uniform(0, 10, 2), *(rng.uniform(0, 10, 2) + 0.5)) for _ in range(50)]
wkb = shapely.to_wkb(np.array(geoms, dtype=object))
t = pa.table({'geometry': pa.array(wkb, type=pa.binary())})
meta = {b'geo': json.dumps({'version': '1.1.0', 'primary_column': 'geometry', 'columns': {'geometry': {'encoding': 'WKB'}}}).encode()}
pq.write_table(t.replace_schema_metadata(meta), '/tmp/smoke.parquet')
"
uv run gpo convert /tmp/smoke.parquet /tmp/smoke_out.parquet --drop-rate 3.0 -v 2>&1 | grep -i "drop_rate\|budget"
```
Expected: no crash, and if any coarse band exists the stderr log includes a `per-band survivor budget (drop_rate 3.00): {...}` line (from Task 3's `log.info`); if the tiny fixture collapses to a single exact band (no coarse bands, likely for 50 sparse boxes), no such line is expected and that is correct too, per `_band_budgets`' `bands <= 1` no-op case.

- [ ] **Step 3: Commit**

```bash
git add converter/src/geoparquet_overviews/cli.py
git commit -m "feat(cli): add --drop-rate flag"
```

---

### Task 5: Regime-adaptive `--bbox` default

**Files:**
- Modify: `converter/src/geoparquet_overviews/convert.py` (`ConvertOptions.bbox`, `_validate_options`, `convert()`)
- Test: `converter/tests/test_convert.py`

**Interfaces:**
- Produces: `ConvertOptions.bbox: bool | None = None`; `convert()` resolves a local `bbox_enabled: bool` right after `regime` is known, and the summary dict gains `"bbox": bbox_enabled`.

- [ ] **Step 1: Write the failing tests**

Add to `converter/tests/test_convert.py`, near `test_no_bbox_profile`:

```python
def test_bbox_default_follows_regime(tmp_path):
    """The adaptive --bbox default (None, unset) picks Profile A for
    count-heavy data and Profile B for vertex-heavy data, with zero flags."""
    tiny_src = tmp_path / "tiny.parquet"
    heavy_src = tmp_path / "heavy.parquet"
    _write_gpq(tiny_src, _polys_with_vertices(200, 4))
    _write_gpq(heavy_src, _polys_with_vertices(200, 400))

    tiny_dst = tmp_path / "tiny_out.parquet"
    heavy_dst = tmp_path / "heavy_out.parquet"
    tiny_summary = convert(str(tiny_src), str(tiny_dst), ConvertOptions(row_group_mb=0.02))
    heavy_summary = convert(str(heavy_src), str(heavy_dst), ConvertOptions(row_group_mb=0.02))

    assert tiny_summary["regime"] == "count"
    assert heavy_summary["regime"] == "vertex"
    assert tiny_summary["bbox"] is True
    assert heavy_summary["bbox"] is False
    assert "bbox" in pq.ParquetFile(tiny_dst).schema_arrow.names
    assert "bbox" not in pq.ParquetFile(heavy_dst).schema_arrow.names


def test_bbox_explicit_override_still_wins(tmp_path):
    """An explicit --bbox forces it on even for a vertex-heavy dataset that
    would otherwise default off."""
    heavy_src = tmp_path / "heavy.parquet"
    _write_gpq(heavy_src, _polys_with_vertices(200, 400))
    dst = tmp_path / "out.parquet"
    summary = convert(str(heavy_src), str(dst), ConvertOptions(row_group_mb=0.02, bbox=True))
    assert summary["regime"] == "vertex"
    assert summary["bbox"] is True
    assert "bbox" in pq.ParquetFile(dst).schema_arrow.names


def test_bbox_adaptive_forced_on_without_native_geo(tmp_path):
    """An adaptive default that would land on bbox-off (vertex regime) plus
    --no-native-geo would leave zero pruning surface, so it is silently forced
    back to bbox-on instead. Unlike the explicit --no-bbox --no-native-geo
    combination (test_no_bbox_requires_native_geo), this must not raise."""
    heavy_src = tmp_path / "heavy.parquet"
    _write_gpq(heavy_src, _polys_with_vertices(200, 400))
    dst = tmp_path / "out.parquet"
    summary = convert(str(heavy_src), str(dst), ConvertOptions(row_group_mb=0.02, native_geo=False))
    assert summary["regime"] == "vertex"
    assert summary["bbox"] is True
    assert "bbox" in pq.ParquetFile(dst).schema_arrow.names
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd converter && uv run pytest tests/test_convert.py -k bbox_default_follows_regime -v`
Expected: FAIL. With `ConvertOptions.bbox` still `bool = True`, `heavy_summary["bbox"]` is not a key yet (`KeyError`), and even once the key exists it would read `True` for the heavy fixture, not `False`.

- [ ] **Step 3: Implement the adaptive default**

In `converter/src/geoparquet_overviews/convert.py`, change the `ConvertOptions.bbox` field (currently):

```python
    # Profile choice. True writes the physical bbox covering struct plus page
    # index pruning surface (Profile A, default). False omits it (Profile B,
    # lean 2.0), readers prune row groups from native geospatial statistics
    # only and page-level pruning is unavailable.
    bbox: bool = True
```

to:

```python
    # Profile choice. True forces the physical bbox covering struct plus page
    # index pruning surface (Profile A). False forces it off (Profile B, lean
    # 2.0), readers prune row groups from native geospatial statistics only
    # and page-level pruning is unavailable. None (default) is adaptive: on
    # for a count-heavy regime, where many features per row group make page
    # pruning worth its cost, off for a vertex-heavy regime, where row-group
    # native statistics already capture what a covering column would add. See
    # `_detect_regime` and the resolution in `convert()`.
    bbox: bool | None = None
```

Change `_validate_options`' bbox check (currently `if not opts.bbox and not opts.native_geo:`) to only fire on an *explicit* False, since `bbox=None` (adaptive) must not raise here — the adaptive path below handles that case itself:

```python
    if opts.bbox is False and not opts.native_geo:
        raise ValueError("--no-bbox requires native geo types, there would be no pruning surface at all")
```

In `convert()`, right after `regime = _detect_regime(total_exact_bytes, n_valid)` (`convert.py:1204`), insert:

```python
    if opts.bbox is None:
        bbox_enabled = regime == "count"
        if not bbox_enabled and not opts.native_geo:
            log.info(
                "regime %r would default bbox off, but --no-native-geo leaves no "
                "pruning surface, forcing bbox on",
                regime,
            )
            bbox_enabled = True
        log.info("bbox default: %s (regime %r, no flag given)", bbox_enabled, regime)
    else:
        bbox_enabled = opts.bbox
```

Replace the three remaining `opts.bbox` reads with `bbox_enabled`:
- `convert.py:1413`, `if opts.bbox:` -> `if bbox_enabled:`
- `convert.py:1477`, `covering=opts.bbox,` -> `covering=bbox_enabled,`
- `convert.py:1496`, `covering=opts.bbox,` -> `covering=bbox_enabled,`

Add `"bbox": bbox_enabled,` to the summary dict returned by `convert()` (`convert.py:1523-1532`), alongside the existing `"regime": regime,` line.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd converter && uv run pytest tests/test_convert.py -k "bbox_default_follows_regime or bbox_explicit_override_still_wins or bbox_adaptive_forced_on_without_native_geo" -v`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add converter/src/geoparquet_overviews/convert.py converter/tests/test_convert.py
git commit -m "feat(converter): make --bbox default follow the count/vertex regime"
```

---

### Task 6: Fix the two tests broken by the new bbox default, update the CLI flag

**Files:**
- Modify: `converter/tests/test_convert.py:495` (`test_empty_geometry_segregated`), `converter/tests/test_convert.py:697` (`test_source_metadata_passthrough`)
- Modify: `converter/src/geoparquet_overviews/cli.py`

**Interfaces:**
- Consumes: `ConvertOptions.bbox` tri-state (Task 5).

Both tests below use `_make_polygons(...)`, a 160-vertex-per-polygon fixture whose average WKB size (~2.6 KB) is above `_VERTEX_REGIME_BYTES` (2000), so they resolve to the vertex regime and would silently lose their `bbox` column under the new default, breaking an assertion unrelated to regime behavior. Force `bbox=True` explicitly so they keep testing what they were written to test.

- [ ] **Step 1: Run the two tests to see them newly fail**

Run: `cd converter && uv run pytest tests/test_convert.py::test_empty_geometry_segregated tests/test_convert.py::test_source_metadata_passthrough -v`
Expected: FAIL. `test_empty_geometry_segregated` fails at `out.column("bbox")` (`pyarrow.lib.ArrowKeyError` or a `KeyError`-style "Field ... does not exist"), `test_source_metadata_passthrough` fails at `assert "covering" in col`.

- [ ] **Step 2: Fix both fixtures**

In `converter/tests/test_convert.py`, `test_empty_geometry_segregated` (around line 495), change:

```python
    summary = convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02))
```

to:

```python
    summary = convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02, bbox=True))
```

In `test_source_metadata_passthrough` (around line 697), change:

```python
    convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02))
```

to:

```python
    convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02, bbox=True))
```

- [ ] **Step 3: Run the two tests to verify they pass again**

Run: `cd converter && uv run pytest tests/test_convert.py::test_empty_geometry_segregated tests/test_convert.py::test_source_metadata_passthrough -v`
Expected: 2 passed.

- [ ] **Step 4: Update the CLI `--bbox/--no-bbox` flag to the tri-state default**

In `converter/src/geoparquet_overviews/cli.py`, change:

```python
@click.option(
    "--bbox/--no-bbox",
    default=True,
    show_default=True,
    help="Write the physical bbox covering column (Profile A). --no-bbox omits it and relies on native geospatial statistics only (Profile B), which disables page-level pruning.",
)
```

to:

```python
@click.option(
    "--bbox/--no-bbox",
    default=None,
    help="Write the physical bbox covering column (Profile A) or omit it and rely on native geospatial statistics only (Profile B, disables page-level pruning). Default is adaptive: on for count-heavy data, off for vertex-heavy data. Either flag forces the choice explicitly.",
)
```

Change the `convert_cmd` signature's `bbox: bool,` to `bbox: bool | None,`. No change is needed where `bbox=bbox` is passed into `ConvertOptions(...)`, since it already forwards whatever click resolved (`True`, `False`, or now `None`).

- [ ] **Step 5: Verify the CLI still round-trips both explicit flags and the adaptive default**

Run: `cd converter && uv run gpo convert --help`
Expected: the `--bbox / --no-bbox` help text describes the adaptive default, with no `[default: True]` annotation (since `show_default` was removed).

Run: `cd converter && uv run pytest tests/test_convert.py -v`
Expected: the full suite passes (this is the final full-suite regression gate for both Task 5 and Task 6's changes).

- [ ] **Step 6: Commit**

```bash
git add converter/tests/test_convert.py converter/src/geoparquet_overviews/cli.py
git commit -m "fix(converter): pin bbox=True in two tests broken by the adaptive default, update CLI flag"
```

---

### Task 7: Documentation

**Files:**
- Modify: `converter/README.md`
- Modify: `converter/CLAUDE.md`
- Modify: root `CLAUDE.md`

- [ ] **Step 1: Update `converter/README.md`'s CLI options table**

Change the existing `--bbox/--no-bbox` row (currently `| `--bbox/--no-bbox` | on | Write the physical `bbox` covering column and its page index, Profile A. `--no-bbox` (Profile B) omits it and relies solely on native geospatial statistics for row-group pruning, requires `--native-geo` and has no page-level pruning. |`) to:

```markdown
| `--bbox/--no-bbox` | adaptive | Write the physical `bbox` covering column and its page index, Profile A, or omit it and rely solely on native geospatial statistics for row-group pruning, Profile B (requires `--native-geo`, no page-level pruning). Unset, the default follows the count/vertex regime: on for count-heavy data, off for vertex-heavy data. Either flag forces the choice explicitly. |
```

Add a new row directly below the `--screen-budget-mb` row:

```markdown
| `--drop-rate` | `2.0` | Geometric per-band survivor ceiling, gpq-tiles/tippecanoe style. Higher asks for a steeper falloff toward the coarsest band. The last coarse band is capped too, so genuine overflow reaches the exact band and skips its overview instead of just moving bytes between coarse bands. Must be greater than 1.0. |
```

- [ ] **Step 2: Update `converter/CLAUDE.md`**

In the "Two profiles, `--native-geo` and `--bbox`" section, change the `--bbox/--no-bbox` paragraph (currently starting `` `--bbox/--no-bbox` (default on = Profile A) controls whether...``) to:

```markdown
`--bbox/--no-bbox` (default adaptive, follows the count/vertex regime:
Profile A for count-heavy data, Profile B for vertex-heavy data) controls
whether the physical `bbox` covering struct column, its `geo` covering entry,
and its page index and statistics get written at all. `--no-bbox` (Profile B)
drops all of that and leans entirely on native GeospatialStatistics for
row-group pruning. `_validate_options` raises only on an *explicit*
`--no-bbox` combined with `--no-native-geo`, since that combination would
leave the file with no pruning surface whatsoever; an *adaptive* resolution
that would land on bbox-off with `--no-native-geo` in effect is silently
forced back to bbox-on instead. Profile B has no page-level pruning, Parquet
has no page-level geospatial statistics, only row-group ones.
```

In the "Architecture, convert.py as a pipeline" section's step 5, add a sentence about the new budget cap after the existing "`_assign_bands` ranks each dimension..." paragraph:

```markdown
   `_thin_bands` also applies an optional per-band survivor budget from
   `_band_budgets`, `budget(b) = n_valid / drop_rate ** (finest - b + 1)`
   (`--drop-rate`, default 2.0), a second demotion source on top of cell
   contention. Unlike gpq-tiles' own formula the last coarse band is capped
   too, so real overflow reaches the exact band and skips its overview
   entirely, the only way the cap actually shrinks the file rather than
   reshuffling bytes between coarse bands.
```

- [ ] **Step 3: Update root `CLAUDE.md`**

In the "State of things" bullet list, add a new bullet after the existing v0.3.0 bullet describing the density thinning:

```markdown
- v0.3.0's `_thin_bands` also applies a per-band survivor budget
  (`_band_budgets`, `--drop-rate`, default 2.0), gpq-tiles/tippecanoe style
  geometric decay toward the coarsest band, with the last coarse band capped
  too so real overflow reaches the exact band and skips its overview, fixing
  the disproportionate mid-band weight a pure one-per-pixel ladder produced
  on count-heavy data (validated against the real Tokyo buildings fixture,
  see `docs/superpowers/specs/2026-07-09-band-budget-and-bbox-default-design.md`).
  `--bbox` also stopped being a fixed always-on default, it now follows the
  same count/vertex regime signal, on for count-heavy data where page pruning
  earns its keep, off for vertex-heavy data where it was measured at a
  rounding error of file size anyway.
```

- [ ] **Step 4: Commit**

```bash
git add converter/README.md converter/CLAUDE.md CLAUDE.md
git commit -m "docs: document the per-band budget and adaptive bbox default"
```

---

### Task 8: Validate against the real hosted fixtures

**Files:** none modified, verification only.

This task exercises the finished converter against the actual files that
motivated this work, downloaded fresh (not relying on any prior session's
scratch state).

- [ ] **Step 1: Download the three real fixtures**

```bash
mkdir -p /tmp/gpo-validate && cd /tmp/gpo-validate
curl -fsSL -o timezones.parquet "https://data.source.coop/youssef-harby/geoparquet-overviews/v0.3.0/timezones.overviews.parquet"
curl -fsSL -o country_boundaries.parquet "https://data.source.coop/youssef-harby/geoparquet-overviews/v0.3.0/country_boundaries.overviews.parquet"
curl -fsSL -o buildings.parquet "https://data.source.coop/youssef-harby/geoparquet-overviews/v0.3.0/overture-tokyo/buildings.parquet"
```

Expected: three files download without error. `buildings.parquet` is large (~716 MB per the validation audit), the download may take a while.

- [ ] **Step 2: Reconvert all three with the updated converter**

```bash
cd /Users/yharby/Documents/gh/geoparquet-overviews/converter
uv run gpo convert /tmp/gpo-validate/timezones.parquet /tmp/gpo-validate/timezones.out.parquet -v 2>&1 | tail -30
uv run gpo convert /tmp/gpo-validate/country_boundaries.parquet /tmp/gpo-validate/country.out.parquet -v 2>&1 | tail -30
uv run gpo convert /tmp/gpo-validate/buildings.parquet /tmp/gpo-validate/buildings.out.parquet -v 2>&1 | tail -30
```

Expected: all three convert without error. The stderr log for each shows the resolved bbox default (from Task 5's `log.info("bbox default: ...")`) and, when coarse bands exist, the per-band budget (from Task 3's `log.info("per-band survivor budget: ...")`).

- [ ] **Step 3: Inspect the results and confirm the three original complaints are resolved**

```bash
cd /Users/yharby/Documents/gh/geoparquet-overviews/converter
uv run --with duckdb python - <<'PY'
import duckdb, json

for name in ["timezones", "country", "buildings"]:
    path = f"/tmp/gpo-validate/{name}.out.parquet"
    meta = duckdb.sql(f"SELECT key, value FROM parquet_kv_metadata('{path}')").fetchall()
    kv = {k.decode(): v for k, v in meta}
    ov = json.loads(kv["overviews"])
    geo = json.loads(kv["geo"])
    print(f"--- {name} ---")
    print("bands:", len(ov["levels"]), "regime:", ov.get("regime"))
    for lvl in ov["levels"]:
        print(f"  level {lvl['level']}: zoom {lvl['min_zoom']}-{lvl['max_zoom']}, "
              f"features {lvl['feature_count']}")
    print("bbox covering present:", "covering" in geo["columns"]["geometry"])
PY
```

Expected:
- `timezones` and `country` each report more than 2 bands (confirms the stale-artifact finding, resolved by reconversion with the current `_local_byte_density` ladder — no code change from this plan was needed for this part).
- `buildings` reports a feature-count distribution across its coarse bands where the largest coarse band no longer holds close to 90% of all features, and its exact/finest band's feature count is measurably larger than the pre-change baseline (some buildings that used to win an overview slot now skip straight to exact).
- `timezones` and `country` report `bbox covering present: False` (vertex regime), `buildings` reports `True` (count regime).

- [ ] **Step 4: Note the remaining operational step**

Reconverting and republishing the hosted `v0.3.0/` prefix with this updated
converter is a separate, owner-only operational step (source.coop write
credentials, per root `CLAUDE.md`'s "Hosted test data and its layout"
section) and is out of scope for this implementation plan. This task's
purpose is only to confirm the code produces the expected result on the real
data before that republish happens.
