# Light overviews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace v0.3.0 all-band density thinning with fraction banding on a coarse, depth-capped ladder plus band-0-only thinning, so the overview column and file shrink toward cayetanobv's fraction model (measured 8x lighter overview, 24 percent smaller file, 2x faster on dense buildings) while keeping the density signal and every thinning-independent v0.3.0 feature.

**Architecture:** One banding pass assigns band 0 by one-survivor-per-coarsest-pixel over all valid features (even whole-extent coverage plus an `overview_count`), then fraction-bands the rest down a factor-2 extent-relative tolerance ladder whose depth is capped where exact geometry with page pruning already meets a per-screen byte budget. The overview build, fallbacks, per-band grids, sort, row-group planning, footer, and write are unchanged.

**Tech Stack:** Python 3, pyarrow, shapely 2.x, numpy, click. Tests with pytest. Reference implementation of the fraction helpers lives on git branch `pr6-tolerance-ladder` (cayetanobv PR #6).

## Global Constraints

- Branch `feat/v030-band-thinning`. Do not touch `main` or the hosted source.coop objects.
- The exact `geometry` column is never modified. `make_valid`/`simplify`/`set_precision` run only on the overview path.
- Footer names are fixed. Key `overviews` parallel to `geo`, columns `geom_overview`, `band`, `bbox`, count column `overview_count`. Do not rename.
- The footer is honest. `importance`, `overview_method`, `regime` record what was actually done. A single-band file writes `overview_method` `"none"`.
- No feature is ever dropped. A collapsed shape writes a quad (polygon) or segment (line), never NULL, never empty WKB.
- Row groups always cut at band boundaries, coarse bands land in a contiguous row-group prefix.
- Re-converting the converter's own output stays idempotent, native-typed round trips included. Keep `test_reconvert_native_output_is_idempotent` and the threaded-overview tripwires green, never weaken them.
- Prose in SPEC.md, DESIGN.md, CLAUDE.md, and help strings uses no em dashes and no colons or semicolons in sentences.
- Run tests with `cd converter && uv run pytest`, lint with `uv run ruff check`. Full suite must stay green.

## File Structure

- `converter/src/geoparquet_overviews/convert.py` — banding rewrite. Change `ConvertOptions`, `_overview_tolerances`, `_overview_grids`, `_derive_bands`, `_assign_bands`, the `convert()` banding block. Add `_band_edges`, `_band_by_fraction`, `_thin_band0`. Remove `_thin_bands`, `_band_budgets`. Keep `_percentile_desc`, `_winners_per_cell`, `_representative_points`, `_local_byte_density`, `_coarsest_zoom`, `_max_coarse_for_zoom`, `_zoom_for_gsd`, the overview build and fallbacks, sort, row-group planning.
- `converter/src/geoparquet_overviews/cli.py` — add `--coarsest-rel`, `--ladder-factor`, `--band-fractions`; remove `--drop-rate`; reword `--thin` and `--screen-budget-mb` help.
- `converter/src/geoparquet_overviews/footer.py` — no code change expected, verify `count_column` and per-level `feature_count` behavior with tests.
- `converter/tests/test_convert.py` — add/adjust tests per task.
- `viewer/src/data/layout.ts` — verify zooms past the deepest overview band read exact geometry, adjust only if needed.
- `SPEC.md`, `DESIGN.md`, `converter/CLAUDE.md` — doc updates in the final task.

---

### Task 1: Ladder options on ConvertOptions

**Files:**
- Modify: `converter/src/geoparquet_overviews/convert.py` (module constants near line 67, `ConvertOptions` near line 100)
- Test: `converter/tests/test_convert.py`

**Interfaces:**
- Produces: module constants `_COARSEST_REL = 1 / 1500`, `_LADDER_FACTOR = 2.0`. `ConvertOptions` fields `coarsest_rel: float = _COARSEST_REL`, `ladder_factor: float = _LADDER_FACTOR`, `band_fractions: list[float] | None = None`. Field `thin: bool = True` kept (semantics change to band-0 only). Field `drop_rate` removed. `screen_budget_mb: float = _SCREEN_BUDGET_MB / 1e6 * 1e6` kept (feeds the depth cap).

- [ ] **Step 1: Write the failing test**

```python
def test_convert_options_ladder_defaults():
    from geoparquet_overviews.convert import ConvertOptions
    o = ConvertOptions()
    assert o.coarsest_rel == 1 / 1500
    assert o.ladder_factor == 2.0
    assert o.band_fractions is None
    assert o.thin is True
    assert not hasattr(o, "drop_rate")
```

- [ ] **Step 2: Run it, expect fail**

Run: `cd converter && uv run pytest tests/test_convert.py::test_convert_options_ladder_defaults -v`
Expected: FAIL (AttributeError on `coarsest_rel`).

- [ ] **Step 3: Implement**

Add near the other overview constants:
```python
_COARSEST_REL = 1 / 1500   # band 0 tolerance as a fraction of the larger extent span
_LADDER_FACTOR = 2.0       # each finer coarse band divides the tolerance by this (one web zoom)
```
In `ConvertOptions` add `coarsest_rel`, `ladder_factor`, `band_fractions` fields with the defaults above, keep `thin`, and delete the `drop_rate` field and its comment.

- [ ] **Step 4: Run it, expect pass**

Run: `cd converter && uv run pytest tests/test_convert.py::test_convert_options_ladder_defaults -v`
Expected: PASS. (Other tests may fail until later tasks; that is expected mid-refactor.)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor(converter): add ladder options, drop drop_rate field"
```

---

### Task 2: Extent-relative tolerance ladder

**Files:**
- Modify: `convert.py` `_overview_tolerances` (line 778), `_overview_grids` (795), and the two call sites in `_build_overview` (1008) and `convert()`.
- Test: `converter/tests/test_convert.py`

**Interfaces:**
- Produces: `_overview_tolerances(bands: int, span: float, coarsest_rel: float = _COARSEST_REL, ladder_factor: float = _LADDER_FACTOR) -> dict[int, float]` returning `{b: span * coarsest_rel / (ladder_factor ** b) for b in range(bands - 1)}`. `_overview_grids(bands, span, coarsest_rel, ladder_factor, override) -> dict[int, float]`. `_build_overview(..., span, coarsest_rel, ladder_factor, grids, ...)`.
- Consumes: `span` is `max(span_x, span_y)`, already computed in `convert()`.

- [ ] **Step 1: Write the failing test**

```python
def test_overview_tolerances_geometric_ladder():
    from geoparquet_overviews.convert import _overview_tolerances
    tol = _overview_tolerances(4, span=1000.0, coarsest_rel=0.01, ladder_factor=2.0)
    assert tol == {0: 10.0, 1: 5.0, 2: 2.5}   # 3 coarse bands, band 3 is exact
    assert set(tol) == {0, 1, 2}
```

- [ ] **Step 2: Run it, expect fail** (signature mismatch, TypeError on `span`).

Run: `cd converter && uv run pytest tests/test_convert.py::test_overview_tolerances_geometric_ladder -v`

- [ ] **Step 3: Implement**

Replace `_overview_tolerances` body with the span-relative form above (copy from `git show pr6-tolerance-ladder:converter/src/geoparquet_overviews/convert.py`, the `_overview_tolerances` def). Update `_overview_grids` to take `(bands, span, coarsest_rel, ladder_factor, override)` and call the new tolerances. Update `_build_overview` to accept and thread `span, coarsest_rel, ladder_factor` instead of `world, z_coarsest`, and its internal `_overview_tolerances(...)` call. Update the `convert()` call sites accordingly (the `_overview_grids` and `_build_overview` calls).

- [ ] **Step 4: Run it, expect pass**

Run: `cd converter && uv run pytest tests/test_convert.py::test_overview_tolerances_geometric_ladder -v`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor(converter): extent-relative factor ladder for tolerances and grids"
```

---

### Task 3: Depth-capped band count

**Files:**
- Modify: `convert.py` `_derive_bands` (line 431), and its call in `convert()` (line 1298).
- Test: `converter/tests/test_convert.py`

**Interfaces:**
- Produces: `_derive_bands(byte_density: float, span: float, coarsest_rel: float, ladder_factor: float, screen_budget_bytes: float) -> int`. Returns total band count (coarse + 1 exact). Depth cap: coarse bands are the number of `ladder_factor` halvings from `span * coarsest_rel` down to the finest useful tolerance `gsd_fine`, where a `_SCREEN_PX` square of exact geometry at `gsd_fine` costs `screen_budget_bytes`. Clamped to `[1, _MAX_COARSE_BANDS + 1]` and by `_max_coarse_for_zoom`.

- [ ] **Step 1: Write the failing test**

```python
import math
def test_derive_bands_depth_cap():
    from geoparquet_overviews.convert import _derive_bands
    # sparse/light: exact already fits the screen budget at the coarsest tol -> single exact band
    assert _derive_bands(byte_density=1.0, span=1000.0, coarsest_rel=0.01,
                          ladder_factor=2.0, screen_budget_bytes=1e12) == 1
    # dense/heavy: many halvings warranted, but never unbounded
    n = _derive_bands(byte_density=1e9, span=1_000_000.0, coarsest_rel=1/1500,
                      ladder_factor=2.0, screen_budget_bytes=1e6)
    assert 2 <= n <= 10
    # denser data asks for at least as many bands as lighter data
    assert _derive_bands(1e9, 1e6, 1/1500, 2.0, 1e6) >= _derive_bands(1e5, 1e6, 1/1500, 2.0, 1e6)
```

- [ ] **Step 2: Run it, expect fail** (signature mismatch).

- [ ] **Step 3: Implement**

```python
def _derive_bands(byte_density, span, coarsest_rel, ladder_factor, screen_budget_bytes):
    """Total band count, coarse plus one exact, capped where exact geometry read
    with page pruning already meets the per-screen byte budget. `gsd_fine` is the
    ground sample distance at which a _SCREEN_PX square of exact geometry costs
    screen_budget_bytes. Coarse bands are the ladder_factor halvings from the
    coarsest tolerance (span * coarsest_rel) down to gsd_fine, so sparse light data
    gets a single exact band and dense heavy data gets more, none past the cap."""
    if byte_density <= 0:
        return 1
    gsd_fine = math.sqrt(screen_budget_bytes / byte_density) / _SCREEN_PX
    coarsest_tol = span * coarsest_rel
    if coarsest_tol <= gsd_fine or ladder_factor <= 1:
        return 1
    steps = math.floor(math.log(coarsest_tol / gsd_fine, ladder_factor)) + 1
    coarse = min(_MAX_COARSE_BANDS, max(0, steps))
    return coarse + 1
```
Update the `convert()` call to `_derive_bands(byte_density, span, opts.coarsest_rel, opts.ladder_factor, opts.screen_budget_mb * 1_000_000)`. Keep the existing `_max_coarse_for_zoom` clamp block that follows.

- [ ] **Step 4: Run it, expect pass**

Run: `cd converter && uv run pytest tests/test_convert.py::test_derive_bands_depth_cap -v`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor(converter): depth-capped band count from screen budget"
```

---

### Task 4: Fraction banding plus band-0-only thinning

**Files:**
- Modify: `convert.py` `_assign_bands` (line 704). Add `_band_edges`, `_band_by_fraction` (port from `pr6-tolerance-ladder`), add `_thin_band0`. Keep `_percentile_desc`, `_winners_per_cell`, `_representative_points`.
- Test: `converter/tests/test_convert.py`

**Interfaces:**
- Produces:
  - `_band_edges(count, bands, fractions) -> list[int]` and `_band_by_fraction(score, bands, fractions) -> np.ndarray` copied verbatim from `git show pr6-tolerance-ladder:.../convert.py`.
  - `_assign_bands(dimensions, area, length, valid, cx, cy, bands, fractions, importance_values, importance_column, span, dataset_bbox, geographic, coarsest_rel, ladder_factor) -> tuple[np.ndarray, str, str, np.ndarray]` returning `(band, importance, overview_method, score)`. Fraction banding of scored features, `_thin_points` for unranked points (ported from B). `score` is the per-cohort percentile (NaN where unranked/invalid), returned for band-0 thinning.
  - `_thin_band0(dimensions, rx, ry, metric, stable_hash, valid, span, coarsest_rel, ladder_factor, origin) -> tuple[np.ndarray, np.ndarray]`. Over **all valid features**, keep one survivor per coarsest-band cell (highest metric, stable_hash tie-break). Returns a boolean `is_survivor` mask (survivors form band 0, giving even whole-extent coverage) plus per-survivor `overview_count` (cell population, 0 for non-survivors). Reuses `_winners_per_cell`. It does not touch the band array. Demoting and fraction-banding the non-survivors into bands 1..bands-1 is the caller's job (Task 5). This runs before fraction banding, not after, so band 0 covers the whole extent rather than only the clustered top fraction.

- [ ] **Step 1: Write the failing tests**

```python
import numpy as np
def test_thin_band0_even_coverage_and_counts():
    from geoparquet_overviews.convert import _thin_band0
    # 4 points in one coarsest cell, 1 in another. Band 0 keeps 1 survivor per cell,
    # selected over ALL valid features (thinning runs before any fraction banding).
    rx = np.array([0.0, 1.0, 2.0, 3.0, 500.0])
    ry = np.zeros(5)
    metric = np.array([0.1, 0.9, 0.2, 0.3, 0.5]) # highest in the crowded cell wins
    sh = np.arange(5, dtype=np.uint32)
    valid = np.ones(5, dtype=bool)
    dims = np.zeros(5, dtype=np.int8)
    # coarsest cell = span * coarsest_rel = 100.0, so x=0..3 share a cell, x=500 is alone
    is_survivor, counts = _thin_band0(dims, rx, ry, metric, sh, valid,
                                      span=1000.0, coarsest_rel=0.1, ladder_factor=2.0,
                                      origin=(0.0, 0.0))
    assert is_survivor.sum() == 2              # one survivor per occupied cell
    assert is_survivor[1] and is_survivor[4]   # crowded-cell winner and the lone point
    assert not is_survivor[[0, 2, 3]].any()    # crowded-cell losers are not survivors
    assert counts[1] == 4                      # crowded cell had 4 features
    assert counts[4] == 1

def test_assign_bands_fraction_split_polygons():
    from geoparquet_overviews.convert import _assign_bands
    n = 100
    dims = np.full(n, 2, dtype=np.int8)
    area = np.arange(n, dtype=float) + 1.0
    length = np.zeros(n)
    valid = np.ones(n, dtype=bool)
    cx = np.linspace(0, 1000, n); cy = np.zeros(n)
    band, imp, method, score = _assign_bands(
        dims, area, length, valid, cx, cy, bands=3, fractions=[0.1, 0.2],
        importance_values=None, importance_column=None, span=1000.0,
        dataset_bbox=(0, 0, 1000, 1), geographic=False,
        coarsest_rel=1/1500, ladder_factor=2.0)
    assert imp == "area_desc" and method == "simplify_snap"
    assert (band == 0).sum() == 10 and (band == 1).sum() == 20 and (band == 2).sum() == 70
    assert not np.isnan(score[valid]).any()
```

- [ ] **Step 2: Run them, expect fail** (functions missing / signature mismatch).

- [ ] **Step 3: Implement**

Port `_band_edges` and `_band_by_fraction` verbatim from `git show pr6-tolerance-ladder:converter/src/geoparquet_overviews/convert.py`. Note that branch defines `_DEFAULT_BAND_FRACTIONS = [0.03, 0.27]` near line 65; add it back as a module constant (used only when `bands == 3` and no explicit fractions). Rewrite `_assign_bands` to the B fraction version (port it, keeping the 4-tuple return by also returning `score`; B's version returns 3, so return `(band, importance, overview_method, score)` where `score` is the array it already computes). Add `_thin_band0`:

```python
def _thin_band0(dimensions, rx, ry, metric, stable_hash, valid,
                span, coarsest_rel, ladder_factor, origin):
    """Over all valid features, keep one survivor per coarsest-band cell for even
    whole-extent coverage. Returns a boolean is_survivor mask (survivors form band 0)
    and each survivor's cell population as overview_count (0 for non-survivors).
    Points, lines, and polygons never share a cell (the geometry dimension packs
    into the cell id's top bits). The coarsest cell size is the band-0 tolerance,
    span * coarsest_rel. This runs before fraction banding, so band 0 covers the
    whole extent, not only the clustered top fraction; the caller fraction-bands
    the non-survivors into bands 1..bands-1. Only band 0 is thinned, so the count
    is band-0-only."""
    n = len(valid)
    is_survivor = np.zeros(n, dtype=bool)
    counts = np.zeros(n, dtype=np.int64)
    cell = span * coarsest_rel
    sel = np.where(valid)[0]
    if len(sel) == 0 or cell <= 0:
        return is_survivor, counts
    ix = np.clip(np.floor((rx[sel] - origin[0]) / cell).astype(np.int64), 0, (1 << 30) - 1)
    iy = np.clip(np.floor((ry[sel] - origin[1]) / cell).astype(np.int64), 0, (1 << 30) - 1)
    cell_id = (dimensions[sel].astype(np.int64) << 60) | (ix << 30) | iy
    winners = _winners_per_cell(cell_id, metric[sel], stable_hash[sel])
    is_survivor[sel[winners]] = True
    _, inverse, cell_counts = np.unique(cell_id, return_inverse=True, return_counts=True)
    counts[sel[winners]] = cell_counts[inverse[winners]]
    return is_survivor, counts
```

- [ ] **Step 4: Run them, expect pass**

Run: `cd converter && uv run pytest tests/test_convert.py::test_thin_band0_even_coverage_and_counts tests/test_convert.py::test_assign_bands_fraction_split_polygons -v`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(converter): fraction banding + band-0-only thinning with overview_count"
```

---

### Task 5: Wire convert(), remove thinning cascade

**Files:**
- Modify: `convert.py` `convert()` banding block (lines ~1298-1352). Delete `_thin_bands` (626) and `_band_budgets` (395).
- Test: `converter/tests/test_convert.py`

**Interfaces:**
- Consumes: `_assign_bands`, `_thin_band0`, and `_band_by_fraction` from Task 4, `_derive_bands` from Task 3, `_representative_points`, `stable_hash`, `dataset_bbox`, `span` already in scope.
- Produces: `convert()` writes `overview_count` only when `opts.thin` and `bands > 1` (unchanged `has_counts` gate at line ~1514 keeps working since band-0 survivors carry counts).

- [ ] **Step 1: Write the failing test** (end-to-end, dense-ish synthetic polygons)

```python
def test_convert_light_overview_is_small(tmp_path):
    import numpy as np, shapely, pyarrow as pa, pyarrow.parquet as pq, json
    from geoparquet_overviews.convert import convert, ConvertOptions
    # 5000 small clustered squares -> multi-band, but overview column stays a small
    # fraction of the exact geometry (no all-band near-exact duplication).
    rng = np.random.default_rng(0)
    xs = rng.uniform(0, 1000, 5000); ys = rng.uniform(0, 1000, 5000)
    polys = shapely.box(xs, ys, xs + 1, ys + 1)
    t = pa.table({"geometry": pa.array(shapely.to_wkb(polys), type=pa.binary())},
                 metadata={b"geo": json.dumps({"version":"1.1.0","primary_column":"geometry",
                          "columns":{"geometry":{"encoding":"WKB","geometry_types":["Polygon"]}}}).encode()})
    src = tmp_path / "in.parquet"; pq.write_table(t, src)
    dst = tmp_path / "out.parquet"
    convert(str(src), str(dst), ConvertOptions(compression_level=3))
    md = pq.ParquetFile(dst).metadata
    ov = geom = 0
    for i in range(md.num_row_groups):
        rg = md.row_group(i)
        for j in range(rg.num_columns):
            c = rg.column(j)
            if c.path_in_schema == "geom_overview": ov += c.total_compressed_size
            elif c.path_in_schema == "geometry": geom += c.total_compressed_size
    assert ov < geom * 0.6   # overview is a small fraction of exact, not a near-copy
    o = json.loads(md.metadata[b"overviews"])
    assert o["count_column"] == "overview_count"   # band-0 density signal present
```

- [ ] **Step 2: Run it, expect fail** (old wiring still calls `_thin_bands`).

- [ ] **Step 3: Implement**

Replace the `convert()` block that currently calls `_assign_bands` (4-arg form) then the `if opts.thin: ... _thin_bands(...)` cascade with the thin-first form below. Band 0 is the thinning survivors over all valid features (even whole-extent coverage), and the non-survivors are fraction-banded into bands 1..bands-1 (finest is exact). `_assign_bands` still provides `score`, `importance`, `overview_method`, and the full-set fraction banding used when thinning is off or `bands == 1`.
```python
    band, importance, overview_method, score = _assign_bands(
        dimensions, area, length, valid, cx, cy, bands, opts.band_fractions,
        importance_values, opts.importance_column, span, dataset_bbox, geographic,
        opts.coarsest_rel, opts.ladder_factor,
    )
    band[~valid] = bands - 1
    log.info("ranked by importance %r, overview method %r", importance, overview_method)

    survivor_counts = np.zeros(len(band), dtype=np.int64)
    if opts.thin and bands > 1:
        rx, ry = _representative_points(geoms, dimensions, bounds, valid, jobs=opts.jobs)
        metric = np.nan_to_num(score, nan=0.0)
        origin = (dataset_bbox[0], dataset_bbox[1])
        is_survivor, survivor_counts = _thin_band0(
            dimensions, rx, ry, metric, stable_hash, valid,
            span, opts.coarsest_rel, opts.ladder_factor, origin)
        # Band 0 = even-coverage survivors over ALL valid features. Fraction-band the
        # non-survivors into bands 1..bands-1 (finest exact), so band 0 covers the whole
        # extent while deeper bands stay pure fraction. This runs before, not after,
        # fraction banding, which is what reclaims the coverage win.
        nonsurv = valid & ~is_survivor
        band[is_survivor] = 0
        band[nonsurv] = _band_by_fraction(score[nonsurv], bands - 1, opts.band_fractions) + 1
        band[~valid] = bands - 1
        log.info("band 0 thinned for coverage: %d survivors of %d valid features",
                 int(is_survivor.sum()), int(valid.sum()))
```
Note on `band_fractions`: with the default `opts.band_fractions is None` the ported `_band_by_fraction` derives a geometric split for whatever bin count it is handed, so `bands - 1` bins works directly. If a user passes explicit `--band-fractions`, those now describe the non-survivor split into `bands - 1` bins (band 0 is owned by thinning, not a fraction), so `len(fractions)` is `bands - 2`. Keep the default path exact and correct; the explicit path is a Task 9 tuning escape hatch. Ensure the ported `_band_by_fraction` tolerates `fractions=None` and a bin count of 1 (all non-survivors to the exact band when `bands == 2`).
Delete `_thin_bands` and `_band_budgets` and their now-dead imports/usages. Verify no other reference to `_thin_bands`, `_band_budgets`, `opts.drop_rate` remains (`grep -n`).

- [ ] **Step 4: Run it plus the full suite**

Run: `cd converter && uv run pytest tests/test_convert.py::test_convert_light_overview_is_small -v && uv run pytest`
Expected: new test PASS. Fix any pre-existing tests that referenced removed symbols (update them to the new banding, do not weaken invariant tripwires).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor(converter): wire fraction banding, remove all-band thinning cascade"
```

---

### Task 6: CLI flags

**Files:**
- Modify: `converter/src/geoparquet_overviews/cli.py`
- Test: `converter/tests/test_convert.py` (or a cli test if present)

**Interfaces:**
- Produces: new options `--coarsest-rel` (default `1/1500`), `--ladder-factor` (default `2.0`), `--band-fractions` (comma list, parsed to `list[float] | None`). Removed `--drop-rate`. `--thin/--no-thin` help reworded to "thin band 0 for even coverage". `--screen-budget-mb` help reworded to name the depth cap. All threaded into `ConvertOptions`.

- [ ] **Step 1: Write the failing test**

```python
def test_cli_band_fractions_parse(tmp_path):
    from click.testing import CliRunner
    from geoparquet_overviews.cli import cli
    # --help lists the new flags and not the removed one
    r = CliRunner().invoke(cli, ["convert", "--help"])
    assert "--coarsest-rel" in r.output and "--ladder-factor" in r.output
    assert "--band-fractions" in r.output and "--drop-rate" not in r.output
```

- [ ] **Step 2: Run it, expect fail.**

- [ ] **Step 3: Implement**

Copy the `--coarsest-rel`, `--ladder-factor`, `--band-fractions` option decorators from `git show pr6-tolerance-ladder:converter/src/geoparquet_overviews/cli.py` (they parse `band_fractions` from a comma string). Remove the `--drop-rate` decorator and its `ConvertOptions(drop_rate=...)` argument. Reword the `--thin` and `--screen-budget-mb` help strings (no colons/semicolons/em dashes). Pass the three new values into `ConvertOptions`.

- [ ] **Step 4: Run it, expect pass; run full suite.**

Run: `cd converter && uv run pytest tests/test_convert.py::test_cli_band_fractions_parse -v && uv run pytest && uv run ruff check`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(cli): expose ladder options, drop --drop-rate"
```

---

### Task 7: Footer and regime verification

**Files:**
- Verify (likely no change): `converter/src/geoparquet_overviews/footer.py`
- Test: `converter/tests/test_convert.py`

**Interfaces:**
- Consumes: `overviews_meta(..., regime=..., count_column=...)`. `count_column` is `"overview_count"` only when band-0 thinning ran and `bands > 1`, else absent. Per-level `feature_count` reflects final band populations.

- [ ] **Step 1: Write the failing test**

```python
def test_footer_count_column_band0_only(tmp_path):
    import shapely, numpy as np, pyarrow as pa, pyarrow.parquet as pq, json
    from geoparquet_overviews.convert import convert, ConvertOptions
    xs = np.linspace(0, 1000, 400)
    polys = shapely.box(xs, 0, xs + 1, 1)
    t = pa.table({"geometry": pa.array(shapely.to_wkb(polys), type=pa.binary())},
                 metadata={b"geo": json.dumps({"version":"1.1.0","primary_column":"geometry",
                          "columns":{"geometry":{"encoding":"WKB","geometry_types":["Polygon"]}}}).encode()})
    src = tmp_path/"in.parquet"; pq.write_table(t, src)
    dst = tmp_path/"out.parquet"
    convert(str(src), str(dst), ConvertOptions(compression_level=3))
    o = json.loads(pq.ParquetFile(dst).metadata.metadata[b"overviews"])
    if len(o["levels"]) > 1:
        assert o.get("count_column") == "overview_count"
        assert all("feature_count" in l for l in o["levels"])
```

- [ ] **Step 2: Run it.** If it fails, adjust the `count_column`/`has_counts` gate in `convert()` so counts are emitted for band-0 thinning; footer.py itself likely needs no change.

- [ ] **Step 3: Implement any needed gate fix.** (Expected: none, but confirm by running.)

- [ ] **Step 4: Run it, expect pass; run full suite.**

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "test(converter): band-0-only count column in footer"
```

---

### Task 8: Viewer reads exact past the overview cap

**Files:**
- Verify/Modify: `viewer/src/data/layout.ts` (read strategy, `columnForRowGroup`)
- Test: `viewer/` typecheck and existing tests

**Interfaces:**
- Consumes: the `overviews` footer with a shorter (depth-capped) `levels` ladder. For a view zoom past the deepest overview band's `max_zoom`, the viewer must read the exact `geometry` column with page pruning, which it already does through the `columnForRowGroup` gate. A capped ladder simply means fewer overview bands, and the exact-read path serves the rest.

- [ ] **Step 1: Read `viewer/src/data/layout.ts`** and confirm the read strategy selects the exact column for zooms beyond the last overview level, with no assumption that overviews extend to a fixed zoom. If it hard-codes a band-to-zoom assumption, note it.

- [ ] **Step 2: Add or adjust a unit test** in the viewer test suite asserting that given a footer whose deepest overview level `max_zoom` is z9, a request at z12 resolves to the exact geometry column (mirror the shape of the existing layout tests).

- [ ] **Step 3: Implement only if Step 1 found a hard-coded assumption.** Otherwise the test should pass as-is.

- [ ] **Step 4: Run viewer checks**

Run: `cd viewer && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "test(viewer): exact read past the overview cap"
```

---

### Task 9: Empirical validation and docs

**Files:**
- Read: `docs/superpowers/specs/2026-07-09-light-overviews-design.md`
- Modify: `SPEC.md`, `DESIGN.md`, `converter/CLAUDE.md`
- Use: the bake-off harness at `<scratchpad>/bakeoff.py` and staged datasets at `<scratchpad>/data/` from the design phase.

**Interfaces:**
- Consumes: the six staged raw datasets (countries, timezones, states, finland_buildings, roads, pois).

- [ ] **Step 1: Re-run the bake-off** with the new converter as variant "C" against the recorded variant B numbers. For each dataset, convert with defaults and measure overview-column bytes, file bytes, band-0 coverage (the 4096-cell metric), and generation time.

Run (per dataset, compression 6):
```bash
cd converter && uv run gpo convert <scratchpad>/data/<name>.parquet /tmp/<name>.C.parquet --compression-level 6 -q
```

- [ ] **Step 2: Assert the targets.** On Finland, overview column within ~1.5x of variant B's 14 MB (not the old 112 MB), file within ~1.1x of 326 MB, and band-0 coverage at least the old thinned band-0's 2070 of 4096 cells. If the overview column is still heavy, lower the default `ladder_factor` cap or raise `coarsest_rel`, or lower `--screen-budget-mb`, and re-measure. Record the chosen defaults.

- [ ] **Step 3: Tune defaults** in `convert.py` constants (`_COARSEST_REL`, `_LADDER_FACTOR`) and `_derive_bands`'s screen budget until the six-dataset sweep meets Step 2 on dense data and stays a single exact band on the sparse ones that should. Commit the tuned constants.

- [ ] **Step 4: Update the docs.** SPEC.md and DESIGN.md describe fraction banding, the depth cap, and band-0-only thinning, replacing the all-band-thinning prose. `converter/CLAUDE.md` architecture section step 5 rewritten. Follow the no-em-dash, no-colon, no-semicolon prose rule.

- [ ] **Step 5: Full suite green and commit**

Run: `cd converter && uv run pytest && uv run ruff check`
```bash
git add -A && git commit -m "docs+tune(converter): validate light overviews across archetypes, update SPEC/DESIGN/CLAUDE"
```

---

## Self-Review

Spec coverage. Fraction ladder backbone (Tasks 2, 4), depth cap (Task 3), band-0-only thinning with overview_count (Tasks 4, 5), kept quad/segment fallbacks and per-band grids and giant-triangle fix (untouched, guarded by existing tripwire tests), 2GB/jobs/native-geo/Profile A-B (untouched), removed thinning machinery (Task 5), footer/regime/count_column (Task 7), viewer exact-past-cap (Task 8), validation and docs (Task 9). All spec sections map to a task.

Placeholder scan. Every code step shows real code or an exact `git show` port source and the exact splice point. No TBD or "handle edge cases".

Type consistency. `_assign_bands` returns the 4-tuple `(band, importance, overview_method, score)` in Tasks 4 and 5. `_overview_tolerances(bands, span, coarsest_rel, ladder_factor)` is consistent across Tasks 2, 3, 4. `_thin_band0` signature matches between its definition (Task 4) and its call (Task 5). `_derive_bands` signature matches between Task 3 definition and Task 5 call site (the call is in the same block Task 5 rewrites, updated in Task 3 Step 3).
