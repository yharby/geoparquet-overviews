"""End to end checks on the converter, run against a small synthetic GeoParquet."""

import importlib
import json
import math
from collections import Counter

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
import shapely

from geoparquet_overviews.convert import (
    ConvertOptions,
    _derive_bands,
    _detect_regime,
    _is_geographic,
    _overview_grids,
    _overview_tolerances,
    _plan_row_groups,
    convert,
)

# The package re-exports the `convert` function, which shadows the submodule
# attribute, so resolve the module object explicitly for monkeypatching.
convert_mod = importlib.import_module("geoparquet_overviews.convert")

_DEFAULT_CRS = object()  # sentinel, "write no crs key" (spec default CRS84)


def _make_polygons(n=300, seed=1):
    rng = np.random.default_rng(seed)
    geoms = []
    for _ in range(n):
        cx, cy = rng.uniform(0, 10, 2)
        r = rng.uniform(0.02, 0.8)
        # Many vertices so coarse-band simplification meaningfully shrinks bytes.
        angles = np.linspace(0, 2 * np.pi, 160, endpoint=False)
        xs = cx + np.cos(angles) * r
        ys = cy + np.sin(angles) * r
        geoms.append(shapely.Polygon(np.column_stack([xs, ys])))
    return geoms


def _make_clustered(n=300, seed=1, verts=40):
    """`n` polygons gathered into a handful of tight, overlapping clusters across a
    0..10 extent. Many features stack inside each coarse band-0 cell, so density
    thinning (the sole banding mechanism) demotes the crowd of each cluster down
    the ladder and a real `geom_overview` column is built. The scattered
    `_make_polygons` spreads one feature per cell under the extent-anchored ladder
    and thins to a single exact band, so a test that needs a populated coarse band
    uses this instead. Pair it with a small `screen_budget_mb`, or a forced
    `bands`, so the modest byte total still asks for an overview."""
    rng = np.random.default_rng(seed)
    a = np.linspace(0, 2 * np.pi, verts, endpoint=False)
    n_clusters = max(1, n // 30)
    centers = rng.uniform(0, 10, (n_clusters, 2))
    geoms = []
    for i in range(n):
        cx, cy = centers[i % n_clusters]
        r = rng.uniform(0.02, 0.4)
        jx, jy = rng.normal(0, r * 0.05, 2)
        xs = cx + jx + np.cos(a) * r
        ys = cy + jy + np.sin(a) * r
        geoms.append(shapely.Polygon(np.column_stack([xs, ys])))
    return geoms


def _write_clustered(path, n=300, seed=1):
    _write_gpq(path, _make_clustered(n, seed))


# A small per-screen budget so a modest synthetic fixture still asks for coarse
# bands. The extent-anchored ladder only emits an overview once the exact
# geometry outgrows the screen budget, and the test tables are far smaller than
# the 1 MB default, so overview tests pass this explicitly.
_OV_BUDGET = 0.02


def _invalid_star(cx, cy, r):
    """A self-intersecting pentagram, invalid but large area, so it lands in a
    coarse band and would crash `set_precision` without the repair path."""
    pts = []
    for k in range(5):
        ang = math.pi / 2 + k * 4 * math.pi / 5
        pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    pts.append(pts[0])
    return shapely.Polygon(pts)


def _write_gpq(path, geoms, crs=_DEFAULT_CRS, column_extra=None, extra_meta=None, extra_columns=None):
    """Write a synthetic GeoParquet with a `geo` footer. `geoms` may contain None
    for null geometries. `column_extra` merges into the primary column dict, and
    `extra_columns` is a dict of extra data columns (e.g. a ranking attribute)."""
    wkb = shapely.to_wkb(np.array(geoms, dtype=object))
    n = len(geoms)
    data = {"id": pa.array(range(n)), "geometry": pa.array(wkb, type=pa.binary())}
    if extra_columns:
        data.update(extra_columns)
    table = pa.table(data)
    col = {"encoding": "WKB"}
    if column_extra:
        col.update(column_extra)
    if crs is not _DEFAULT_CRS:
        col["crs"] = crs
    geo = json.dumps({"version": "1.1.0", "primary_column": "geometry", "columns": {"geometry": col}})
    meta = {b"geo": geo.encode()}
    if extra_meta:
        meta.update(extra_meta)
    table = table.replace_schema_metadata(meta)
    pq.write_table(table, path)


def _write_plain(path, n=300, seed=1):
    _write_gpq(path, _make_polygons(n, seed))


def test_convert_options_ladder_defaults():
    o = ConvertOptions()
    assert o.coarsest_rel == 1 / 1500
    assert o.ladder_factor == 4.0
    assert o.screen_budget_mb == 8.0
    assert o.band_fractions is None
    assert o.thin is True
    assert not hasattr(o, "drop_rate")


def test_convert_writes_overviews_footer(tmp_path):
    src = tmp_path / "plain.parquet"
    dst = tmp_path / "overviews.parquet"
    _write_clustered(src)

    summary = convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02, screen_budget_mb=_OV_BUDGET))

    assert summary["features"] == 300
    assert summary["row_groups"] >= 3
    assert summary["has_overview"] is True

    meta = pq.read_metadata(dst).metadata
    assert b"geo" in meta
    assert b"overviews" in meta
    ov = json.loads(meta[b"overviews"])
    assert ov["version"] == "0.3.0"
    assert ov["overview_column"] == "geom_overview"
    # The block carries a descriptive regime label.
    assert "regime" in ov
    # Levels are ordered and the last level ends at the last row group.
    ends = [lvl["row_group_end"] for lvl in ov["levels"]]
    assert ends == sorted(ends)
    assert ends[-1] == summary["row_groups"] - 1


def test_levels_carry_bytes_and_extent(tmp_path):
    src = tmp_path / "src.parquet"
    dst = tmp_path / "dst.parquet"
    pq.write_table(_poly_table(), src)
    convert(str(src), str(dst), ConvertOptions(bands=2))
    pf = pq.ParquetFile(dst)
    import json as _json
    ov = _json.loads(pf.metadata.metadata[b"overviews"])
    assert ov["version"] == "0.3.0"
    levels = ov["levels"]
    prev_end = 4  # after the PAR1 magic
    for lvl in levels:
        start, end = lvl["bytes"]
        assert start >= prev_end and end > start
        prev_end = end
        ext = lvl["extent"]
        assert len(ext) == 4 and ext[0] <= ext[2] and ext[1] <= ext[3]
    # The ranges tile the data section, level 0 starts at the first row group.
    assert levels[0]["bytes"][0] == 4
    # And the end of the last level matches the last row group boundary, which
    # must sit before the footer.
    import os
    assert levels[-1]["bytes"][1] < os.path.getsize(dst)


def test_levels_carry_min_zoom_grid_and_feature_count(tmp_path):
    """Draft 0.3.0 enriches each level with min_zoom, a per-band snap grid, and a
    feature_count, and the block carries a regime label. The finest exact band has
    no overview, so its grid is null."""
    src = tmp_path / "src.parquet"
    dst = tmp_path / "dst.parquet"
    pq.write_table(_poly_table(), src)
    convert(str(src), str(dst), ConvertOptions(bands=2))
    out = pq.read_table(dst)
    bands_col = out.column("band").to_numpy()
    ov = json.loads(pq.read_metadata(dst).metadata[b"overviews"])
    assert ov["version"] == "0.3.0"
    assert "regime" in ov

    levels = ov["levels"]

    prev_max = None
    total = 0
    for lvl in levels:
        b = lvl["level"]
        # feature_count matches the real band size on the written column.
        assert lvl["feature_count"] == int((bands_col == b).sum())
        total += lvl["feature_count"]
        # min_zoom: band 0 starts at 0, each later band one past the prior max_zoom.
        if prev_max is None:
            assert lvl["min_zoom"] == 0
        else:
            assert lvl["min_zoom"] == prev_max + 1
        prev_max = lvl["max_zoom"]
    # The finest exact band has no overview, so its grid is null.
    assert levels[-1]["grid"] is None
    # Every coarse band carries its own snap grid, cell_size in CRS units.
    for lvl in levels[:-1]:
        grid = lvl["grid"]
        assert grid is not None
        assert len(grid["origin"]) == 2
        # Each coarse band snaps to a quarter of its own pixel (its gsd), whatever
        # zoom the ladder anchored it at.
        assert grid["cell_size"][0] == pytest.approx(lvl["gsd"] / convert_mod._GRID_SUBPIXEL)
        assert grid["cell_size"][0] == grid["cell_size"][1]
    # No feature is lost, the footer sums back to the row count.
    assert total == out.num_rows


def test_row_count_and_geometry_preserved(tmp_path):
    src = tmp_path / "plain.parquet"
    dst = tmp_path / "overviews.parquet"
    source_geoms = _make_clustered(300)
    _write_gpq(src, source_geoms)
    convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02, screen_budget_mb=_OV_BUDGET, bbox=True))

    out = pq.read_table(dst)
    assert out.num_rows == 300
    # The exact `geometry` column is byte-for-byte the source WKB, only reordered.
    # Compare as a multiset so the importance sort does not matter.
    source_wkb = shapely.to_wkb(np.array(source_geoms, dtype=object))
    out_wkb = out.column("geometry").to_pylist()
    assert Counter(out_wkb) == Counter(source_wkb.tolist())
    # The covering struct and band ordinal are present.
    assert "bbox" in out.column_names
    assert "band" in out.column_names
    assert "geom_overview" in out.column_names


def test_plan_row_groups_splits_coarse_bands(monkeypatch):
    """Coarse bands split into near-equal groups, the finest band cuts by budget."""
    # Lower the floor so 100-feature coarse bands actually split into 4 groups.
    monkeypatch.setattr(convert_mod, "_MIN_COARSE_GROUP_ROWS", 10)

    # Band 0 has 100 features, band 1 has 100, band 2 (finest) has 50, band-major.
    band = np.array([0] * 100 + [1] * 100 + [2] * 50, dtype=np.int16)
    # Give the finest band large bytes so a small budget forces several cuts.
    geom_bytes = np.concatenate(
        [
            np.full(200, 10, dtype=np.int64),  # coarse bands, bytes are ignored
            np.full(50, 100, dtype=np.int64),  # finest band, 100 bytes each
        ]
    )

    plan, band_rg_end = _plan_row_groups(
        band, geom_bytes, budget=250, bands=3, coarse_row_groups=4
    )

    # Band 0 and band 1 each split into 4 near-equal groups of 25.
    assert plan[0:4] == [25, 25, 25, 25]
    assert plan[4:8] == [25, 25, 25, 25]
    # band_rg_end maps each band to its last group index.
    assert band_rg_end[0] == 3
    assert band_rg_end[1] == 7
    # The finest band cuts by byte budget, 250 bytes is 3 features (300 >= 250),
    # so 50 features at 100 bytes give groups of 3 with a final partial group.
    finest_groups = plan[8:]
    assert band_rg_end[2] == len(plan) - 1
    assert all(g == 3 for g in finest_groups[:-1])
    assert finest_groups[-1] <= 3
    assert sum(finest_groups) == 50
    # Every feature is accounted for.
    assert sum(plan) == 250


def test_plan_row_groups_near_equal_remainder(monkeypatch):
    """Near-equal split gives the first rem groups one extra feature."""
    monkeypatch.setattr(convert_mod, "_MIN_COARSE_GROUP_ROWS", 1)
    # 10 features in a coarse band split into 3 groups, base 3, rem 1 -> 4,3,3.
    band = np.array([0] * 10 + [1] * 5, dtype=np.int16)
    geom_bytes = np.full(15, 10, dtype=np.int64)
    plan, band_rg_end = _plan_row_groups(
        band, geom_bytes, budget=1_000_000, bands=2, coarse_row_groups=3
    )
    assert plan[0:3] == [4, 3, 3]
    assert band_rg_end[0] == 2
    assert sum(plan) == 15


def test_overview_is_smaller_than_exact(tmp_path):
    """The overview column must be physically smaller than exact geometry, that
    is the whole point of the preview path."""
    src = tmp_path / "plain.parquet"
    dst = tmp_path / "overviews.parquet"
    _write_clustered(src)
    convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02, screen_budget_mb=_OV_BUDGET))

    out = pq.read_table(dst)
    band0 = out.filter(pa.compute.equal(out.column("band"), 0))
    exact_wkb = band0.column("geometry").to_pylist()
    ov_wkb = band0.column("geom_overview").to_pylist()
    # A per-band coarse snap grid can collapse a genuinely sub-pixel feature to a
    # NULL overview, so compare byte cost only over the features that paint.
    painted = [i for i, w in enumerate(ov_wkb) if w is not None]
    assert painted, "band 0 should paint at least some overview geometry"
    exact_bytes = sum(len(exact_wkb[i]) for i in painted)
    overview_bytes = sum(len(ov_wkb[i]) for i in painted)
    assert overview_bytes < exact_bytes


def test_overview_tolerances_geometric_ladder():
    """The ladder is extent-relative, not zoom-anchored. Band 0 resolves at
    `coarsest_rel` of the span, and each finer coarse band divides the
    tolerance by `ladder_factor`."""
    tol = _overview_tolerances(4, span=1000.0, coarsest_rel=0.01, ladder_factor=2.0)
    assert tol == {0: 10.0, 1: 5.0, 2: 2.5}  # 3 coarse bands, band 3 is exact
    assert set(tol) == {0, 1, 2}


def test_coarsest_zoom_anchors_to_extent():
    """A world-spanning dataset anchors the coarsest band at _ZOOMS_PER_BAND, the
    same low zoom the fixed ladder used, so it stays byte-identical. A sub-world
    dataset anchors higher, at the zoom where its own extent fills the screen, so
    it never emits coarse bands below its visible range."""
    world = 360.0
    # A world-spanning extent resolves to the fixed ladder's old anchor.
    assert convert_mod._coarsest_zoom(360.0, 180.0, world) == convert_mod._ZOOMS_PER_BAND
    # A city-scale extent (about 1 degree) anchors several zooms deeper.
    city = convert_mod._coarsest_zoom(0.9, 0.6, world)
    assert city > convert_mod._ZOOMS_PER_BAND
    # A smaller extent anchors deeper still.
    town = convert_mod._coarsest_zoom(0.05, 0.05, world)
    assert town > city


def test_per_band_grid_coarsens_with_band():
    """Each coarse band snaps to a fraction of its own tolerance, so band 0 gets a
    strictly larger snap grid than the finest coarse band, and every band's grid is
    its tolerance over the sub-pixel divisor."""
    span = 1000.0
    grids = _overview_grids(4, span, 0.01, 2.0, None)
    tol = _overview_tolerances(4, span, 0.01, 2.0)
    finest_coarse = max(grids)
    # Band 0 snaps coarser than the finest coarse band.
    assert grids[0] > grids[finest_coarse]
    # Each band's grid is its own tolerance over the sub-pixel divisor.
    for b in grids:
        assert grids[b] == pytest.approx(tol[b] / convert_mod._GRID_SUBPIXEL)


def test_overview_grid_override_is_uniform():
    """A set `--overview-grid` forces the same grid on every band, the escape
    hatch overriding the per-band derivation."""
    grids = _overview_grids(4, 1000.0, 0.01, 2.0, override=0.001)
    assert set(grids.keys()) == {0, 1, 2}
    assert all(g == 0.001 for g in grids.values())


def test_derive_bands_scales_with_density():
    """The band count is derived from byte density, bytes per CRS area unit where
    the data sits. A high-byte-density dataset asks for many coarse bands, a low
    one for few, and a positive --bands override wins."""
    coarsest_rel = 1 / 1500
    ladder_factor = 2.0
    budget = 1_000_000  # 1 MB per screen, the default
    # A high-byte-density case, a large total WKB payload over a metre extent,
    # such as Finland-scale buildings (~5.65M features, a few hundred bytes each),
    # here as its uniform density. The coarse ladder runs from the coarsest
    # tolerance down to where the exact geometry fits the budget, several coarse
    # bands plus the exact band.
    dense = _derive_bands(1_700_000_000 / (7e5 * 1.3e6), 7e5, coarsest_rel, ladder_factor, budget)
    assert 4 <= dense <= 6
    # A low-byte-density case, a tiny payload over a continent-scale extent. The
    # exact geometry already fits the screen budget at the coarsest tolerance, so
    # no coarse band is warranted and the dataset is a single exact band, no overview.
    sparse = _derive_bands(2_000 / (4e6 * 4e6), 4e6, coarsest_rel, ladder_factor, budget)
    assert sparse == 1
    assert dense > sparse
    # A positive --bands overrides the derivation entirely (checked via convert
    # elsewhere), and the screen budget tunes it, a lower budget asks for more.
    tighter = _derive_bands(1_700_000_000 / (7e5 * 1.3e6), 7e5, coarsest_rel, ladder_factor, budget / 8)
    assert tighter >= dense


def test_derive_bands_depth_cap():
    """The depth-capped form. Coarse bands are ladder_factor halvings from
    span * coarsest_rel down to the finest useful tolerance, capped so sparse
    light data gets a single exact band and dense heavy data never runs away."""
    # sparse/light: exact already fits the screen budget at the coarsest tol -> single exact band
    assert _derive_bands(byte_density=1.0, span=1000.0, coarsest_rel=0.01,
                          ladder_factor=2.0, screen_budget_bytes=1e12) == 1
    # dense/heavy: many halvings warranted, but never unbounded
    n = _derive_bands(byte_density=1e9, span=1_000_000.0, coarsest_rel=1/1500,
                      ladder_factor=2.0, screen_budget_bytes=1e6)
    assert 2 <= n <= 10
    # denser data asks for at least as many bands as lighter data
    assert _derive_bands(1e9, 1e6, 1/1500, 2.0, 1e6) >= _derive_bands(1e5, 1e6, 1/1500, 2.0, 1e6)


def _polys_with_vertices(n, nverts, seed=1):
    """`n` regular polygons over the same 0..10 extent, each with `nverts`
    vertices, so two calls with the same n and seed but different nverts differ
    only in geometry complexity (vertex count), not feature count or placement."""
    rng = np.random.default_rng(seed)
    geoms = []
    for _ in range(n):
        cx, cy = rng.uniform(0, 10, 2)
        r = rng.uniform(0.02, 0.8)
        angles = np.linspace(0, 2 * np.pi, nverts, endpoint=False)
        xs = cx + np.cos(angles) * r
        ys = cy + np.sin(angles) * r
        geoms.append(shapely.Polygon(np.column_stack([xs, ys])))
    return geoms


def test_vertex_heavy_derives_more_bands_than_count_light():
    """The single byte-density formula serves both regimes. Two datasets with the
    same feature count and the same extent, one of tiny simple polygons and one of
    large many-vertex polygons, derive different band counts, and the vertex-heavy
    one gets strictly more bands, because its higher byte density hits the screen
    budget at a finer zoom."""
    span = 10.0
    coarsest_rel = 1 / 1500
    ladder_factor = 2.0
    budget = 1_000_000
    n = 300
    light = shapely.to_wkb(np.array(_polys_with_vertices(n, 4), dtype=object))
    heavy = shapely.to_wkb(np.array(_polys_with_vertices(n, 500), dtype=object))
    light_bytes = int(sum(len(w) for w in light))
    heavy_bytes = int(sum(len(w) for w in heavy))
    light_bands = _derive_bands(light_bytes / (span * span), span, coarsest_rel, ladder_factor, budget)
    heavy_bands = _derive_bands(heavy_bytes / (span * span), span, coarsest_rel, ladder_factor, budget)
    assert heavy_bands > light_bands


def test_detect_regime_labels(tmp_path):
    """The regime label reports count-heavy versus vertex-heavy honestly, from the
    average exact bytes per feature, and it appears in the convert() summary. It is
    descriptive only, it never changes the banding."""
    # The pure helper, a tiny simple polygon is count-heavy, a detailed one is
    # vertex-heavy, and no valid features is empty.
    assert _detect_regime(300 * 120, 300) == "count"
    assert _detect_regime(300 * 6000, 300) == "vertex"
    assert _detect_regime(0, 0) == "empty"

    # The label surfaces in the convert() summary, tiny polygons label "count",
    # many-vertex polygons label "vertex".
    tiny_src = tmp_path / "tiny.parquet"
    heavy_src = tmp_path / "heavy.parquet"
    _write_gpq(tiny_src, _polys_with_vertices(200, 4))
    _write_gpq(heavy_src, _polys_with_vertices(200, 400))
    tiny = convert(str(tiny_src), str(tmp_path / "t.parquet"), ConvertOptions(row_group_mb=0.02))
    heavy = convert(str(heavy_src), str(tmp_path / "h.parquet"), ConvertOptions(row_group_mb=0.02))
    assert tiny["regime"] == "count"
    assert heavy["regime"] == "vertex"


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
    cx = np.linspace(0, 1000, n)
    cy = np.zeros(n)
    band, imp, method, score = _assign_bands(
        dims, area, length, valid, cx, cy, bands=3, fractions=[0.1, 0.2],
        importance_values=None, importance_column=None, span=1000.0,
        dataset_bbox=(0, 0, 1000, 1), geographic=False,
        coarsest_rel=1/1500, ladder_factor=2.0)
    assert imp == "area_desc" and method == "simplify_snap"
    assert (band == 0).sum() == 10 and (band == 1).sum() == 20 and (band == 2).sum() == 70
    assert not np.isnan(score[valid]).any()


def test_convert_light_overview_is_small(tmp_path):
    # 5000 small many-vertex polygons -> multi-band, but the overview column stays
    # a small fraction of the exact geometry. The point of light overviews is that
    # a coarse band carries a heavily simplified copy, not a near-exact duplicate,
    # so the features need enough vertices for simplification to actually shrink
    # them (a 5-vertex box cannot shrink and would defeat the property).
    rng = np.random.default_rng(0)
    xs = rng.uniform(0, 1000, 5000)
    ys = rng.uniform(0, 1000, 5000)
    polys = shapely.buffer(shapely.points(xs, ys), 2.0, quad_segs=16)
    t = pa.table({"geometry": pa.array(shapely.to_wkb(polys), type=pa.binary())},
                 metadata={b"geo": json.dumps({"version": "1.1.0", "primary_column": "geometry",
                          "columns": {"geometry": {"encoding": "WKB", "geometry_types": ["Polygon"]}}}).encode()})
    src = tmp_path / "in.parquet"
    pq.write_table(t, src)
    dst = tmp_path / "out.parquet"
    convert(str(src), str(dst), ConvertOptions(compression_level=3))
    md = pq.ParquetFile(dst).metadata
    ov = geom = 0
    for i in range(md.num_row_groups):
        rg = md.row_group(i)
        for j in range(rg.num_columns):
            c = rg.column(j)
            if c.path_in_schema == "geom_overview":
                ov += c.total_compressed_size
            elif c.path_in_schema == "geometry":
                geom += c.total_compressed_size
    assert ov < geom * 0.6   # overview is a small fraction of exact, not a near-copy
    o = json.loads(md.metadata[b"overviews"])
    assert o["count_column"] == "overview_count"   # band-0 density signal present


def test_null_geometry_segregated(tmp_path):
    """C1, null geometries are kept in the finest band with a null bbox and null
    overview, do not crash, and are excluded from the dataset extent."""
    src = tmp_path / "nulls.parquet"
    dst = tmp_path / "out.parquet"
    geoms = _make_clustered(200)
    geoms[5] = None
    geoms[123] = None
    _write_gpq(src, geoms)

    summary = convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02, screen_budget_mb=_OV_BUDGET, bbox=True))
    assert summary["features"] == 200

    out = pq.read_table(dst)
    geom = out.column("geometry").to_pylist()
    bbox = out.column("bbox").to_pylist()
    band = out.column("band").to_pylist()
    ov = out.column("geom_overview").to_pylist()
    finest = summary["bands"] - 1
    null_rows = [i for i, g in enumerate(geom) if g is None]
    assert len(null_rows) == 2
    for i in null_rows:
        assert bbox[i] is None
        assert band[i] == finest
        assert ov[i] is None

    # The dataset extent excludes the nulls, so it stays finite.
    geo = json.loads(pq.read_metadata(dst).metadata[b"geo"])
    assert all(math.isfinite(v) for v in geo["columns"]["geometry"]["bbox"])


def test_empty_geometry_segregated(tmp_path):
    """C1, empty geometries also get a null bbox and land in the finest band, and
    they do not poison the extent."""
    src = tmp_path / "empty.parquet"
    dst = tmp_path / "out.parquet"
    geoms = _make_polygons(120)
    geoms[10] = shapely.Polygon()  # empty polygon
    _write_gpq(src, geoms)

    summary = convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02, bbox=True))
    out = pq.read_table(dst)
    bbox = out.column("bbox").to_pylist()
    band = out.column("band").to_pylist()
    geom = shapely.from_wkb(out.column("geometry").to_pylist())
    empties = [i for i, g in enumerate(geom) if g is not None and g.is_empty]
    assert len(empties) == 1
    for i in empties:
        assert bbox[i] is None
        assert band[i] == summary["bands"] - 1
    geo = json.loads(pq.read_metadata(dst).metadata[b"geo"])
    assert all(math.isfinite(v) for v in geo["columns"]["geometry"]["bbox"])


def test_invalid_polygon_repaired_on_overview(tmp_path):
    """C2, an invalid polygon in a coarse band is repaired on the overview path
    only, so the conversion does not crash and the exact geometry is untouched."""
    src = tmp_path / "invalid.parquet"
    dst = tmp_path / "out.parquet"
    geoms = _make_clustered(150)
    star = _invalid_star(5, 5, 4)  # large area, lands in band 0, invalid
    geoms[0] = star
    _write_gpq(src, geoms)

    convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02, screen_budget_mb=_OV_BUDGET))

    out = pq.read_table(dst)
    star_wkb = shapely.to_wkb(star)
    exact = out.column("geometry").to_pylist()
    # The exact column still carries the original invalid geometry, untouched.
    idx = exact.index(star_wkb)
    assert not shapely.from_wkb(exact[idx]).is_valid
    # Its overview was repaired, so it is present and valid.
    ov = out.column("geom_overview").to_pylist()[idx]
    assert ov is not None
    assert shapely.from_wkb(ov).is_valid


def test_reconvert_is_idempotent(tmp_path):
    """C5, converting the converter's own output does not crash on duplicate
    band, geom_overview, or geometry columns, and preserves the exact geometry."""
    src = tmp_path / "plain.parquet"
    once = tmp_path / "once.parquet"
    twice = tmp_path / "twice.parquet"
    _write_plain(src)

    convert(str(src), str(once), ConvertOptions(row_group_mb=0.02))
    convert(str(once), str(twice), ConvertOptions(row_group_mb=0.02))

    a = pq.read_table(once)
    b = pq.read_table(twice)
    assert a.num_rows == b.num_rows
    # No duplicated columns after re-convert.
    assert sorted(b.column_names) == sorted(set(b.column_names))
    # Exact geometry is stable across the re-convert.
    assert Counter(a.column("geometry").to_pylist()) == Counter(b.column("geometry").to_pylist())


def test_reconvert_native_output_is_idempotent(tmp_path):
    """Re-converting a 0.2.0 output with extension-typed geometry columns
    must not break the read/decode stage, and must reproduce the same bytes."""
    src = tmp_path / "src.parquet"
    once = tmp_path / "once.parquet"
    twice = tmp_path / "twice.parquet"
    pq.write_table(_poly_table(), src)
    convert(str(src), str(once), ConvertOptions(bands=2))
    convert(str(once), str(twice), ConvertOptions(bands=2))
    a, b = pq.read_table(once), pq.read_table(twice)
    assert a.column_names == b.column_names
    assert a.column("geometry").combine_chunks() == b.column("geometry").combine_chunks()


def test_decode_wkb_reads_multichunk_without_combining():
    """A WKB column past 2 GB arrives as several row-group chunks and must decode
    without a `combine_chunks()` that would overflow the 32-bit binary offset.
    Exercised here on a multi-chunk column, both plain binary and the
    geoarrow.wkb extension storage a re-converted native file carries."""
    import geoarrow.pyarrow as ga

    geoms = shapely.points(np.arange(6), np.arange(6))
    wkb = shapely.to_wkb(geoms)
    a, b = pa.array(wkb[:3], type=pa.binary()), pa.array(wkb[3:], type=pa.binary())

    plain = pa.chunked_array([a, b])
    assert plain.num_chunks == 2
    out = convert_mod._decode_wkb(plain)
    assert len(out) == 6 and shapely.to_wkb(out).tolist() == wkb.tolist()

    ext = pa.chunked_array([ga.wkb().wrap_array(a), ga.wkb().wrap_array(b)])
    out = convert_mod._decode_wkb(ext)
    assert len(out) == 6 and shapely.to_wkb(out).tolist() == wkb.tolist()


def test_large_binary_write_path_when_payload_would_overflow(tmp_path, monkeypatch):
    """When the exact WKB would overflow a 32-bit `binary` array, the geometry
    column is written as `large_binary`. Forced here by shrinking the threshold
    rather than building a 2 GB fixture. The plain (non-native) path preserves
    the large_binary storage on read, which is the observable proof."""
    monkeypatch.setattr(convert_mod, "_MAX_BINARY_BYTES", 8)
    src, dst = tmp_path / "src.parquet", tmp_path / "dst.parquet"
    _write_plain(src)
    convert(str(src), str(dst), ConvertOptions(bands=2, native_geo=False))
    geom = pq.read_table(dst).column("geometry")
    assert geom.type == pa.large_binary()
    # Exact geometry survives the large_binary round trip.
    assert all(g is not None for g in geom.to_pylist())


def test_large_wkb_native_write_and_reconvert(tmp_path, monkeypatch):
    """The native path must pair `large_binary` storage with `ga.large_wkb()`, a
    `binary`-declared extension over `large_binary` storage miswrites its offsets
    and crashes on write. Forcing the large path and then re-converting the
    output proves both the large write and the decode of a large_wkb file."""
    monkeypatch.setattr(convert_mod, "_MAX_BINARY_BYTES", 8)
    src = tmp_path / "src.parquet"
    once, twice = tmp_path / "once.parquet", tmp_path / "twice.parquet"
    pq.write_table(_poly_table(), src)
    convert(str(src), str(once), ConvertOptions(bands=2))
    convert(str(once), str(twice), ConvertOptions(bands=2))
    a, b = pq.read_table(once), pq.read_table(twice)
    assert "geoarrow.wkb" in str(a.schema.field("geometry").type)
    assert a.column("geometry").combine_chunks() == b.column("geometry").combine_chunks()


def test_threaded_overview_matches_single_thread(tmp_path):
    """The overview build is fanned across threads, so it must be byte-identical
    to the single-threaded build. The overview is a pure per-feature transform,
    threading only changes how the work is scheduled, never the result."""
    src = tmp_path / "src.parquet"
    one = tmp_path / "one.parquet"
    many = tmp_path / "many.parquet"
    _write_gpq(src, _make_clustered(600))
    convert(str(src), str(one), ConvertOptions(bands=3, jobs=1))
    convert(str(src), str(many), ConvertOptions(bands=3, jobs=4))
    a, b = pq.read_table(one), pq.read_table(many)
    assert a.column("geometry").to_pylist() == b.column("geometry").to_pylist()
    assert a.column("geom_overview").to_pylist() == b.column("geom_overview").to_pylist()


def test_overview_band_chunking_preserves_order():
    """`_overview_band` splits a band across threads and concatenates, so its
    output must match `_overview_values` element for element, in order."""
    geoms = np.array(_make_polygons(250), dtype=object)
    dims = shapely.get_dimensions(geoms)
    single = convert_mod._overview_values(geoms, dims, 0.05, 0.01)
    threaded = convert_mod._overview_band(geoms, dims, 0.05, 0.01, jobs=4)
    assert single.tolist() == threaded.tolist()


def test_negative_jobs_rejected(tmp_path):
    src, dst = tmp_path / "s.parquet", tmp_path / "d.parquet"
    _write_plain(src)
    with pytest.raises(ValueError, match="jobs"):
        convert(str(src), str(dst), ConvertOptions(jobs=-1))


def test_no_feature_lost_under_band0_thinning(tmp_path):
    """Band-0 thinning and the fraction banding of the demoted rest only move
    features between bands, they never drop one. Every input feature survives in
    exactly one band, coarse survivors plus the finest exact band."""
    src = tmp_path / "dense.parquet"
    dst = tmp_path / "out.parquet"
    _write_clustered(src, n=600, seed=2)
    convert(str(src), str(dst), ConvertOptions(bands=3, row_group_mb=0.02))
    out = pq.read_table(dst)
    assert out.num_rows == 600
    band = np.array(out.column("band").to_pylist())
    assert band.min() >= 0 and band.max() <= 2


def test_sorting_columns_declares_band_leaf(tmp_path):
    """C4, sorting_columns points at the physical `band` leaf, not a bbox leaf."""
    src = tmp_path / "plain.parquet"
    dst = tmp_path / "out.parquet"
    _write_plain(src)
    convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02))

    pf = pq.ParquetFile(dst)
    rg = pf.metadata.row_group(0)
    sorting = rg.sorting_columns
    assert sorting, "expected declared sorting_columns"
    leaf = sorting[0].column_index
    # Resolve the declared leaf back to a column path and check it is `band`.
    schema = pf.schema_arrow
    band_leaf = pq.SortingColumn.from_ordering(schema, [("band", "ascending")])[0].column_index
    assert leaf == band_leaf
    # And that leaf really is the band column, not bbox.something.
    assert pf.schema.column(leaf).path == "band"


def test_epsg_4269_detected_geographic():
    """C6, a NAD83 (EPSG:4269) style CRS is geographic degrees, not projected."""
    for spec in ("EPSG:4269", "urn:ogc:def:crs:EPSG::4269", "OGC:CRS84", "EPSG:4326", "4258"):
        assert _is_geographic(True, spec) is True
    # A projected metre CRS is not geographic.
    assert _is_geographic(True, "EPSG:3067") is False
    # PROJJSON forms.
    assert _is_geographic(True, {"type": "GeographicCRS", "name": "NAD83"}) is True
    assert _is_geographic(True, {"type": "ProjectedCRS", "name": "ETRS89 / TM35FIN"}) is False
    # A geographic CRS wrapped in a CompoundCRS.
    compound = {"type": "CompoundCRS", "components": [{"type": "GeographicCRS", "name": "WGS84"}]}
    assert _is_geographic(True, compound) is True


def test_source_metadata_passthrough(tmp_path):
    """C7 and C8, source column fields like `edges` survive, and an unrelated
    top-level metadata key is not stripped by the footer rewrite."""
    src = tmp_path / "meta.parquet"
    dst = tmp_path / "out.parquet"
    geoms = _make_polygons(120)
    _write_gpq(
        src,
        geoms,
        column_extra={"edges": "spherical", "orientation": "counterclockwise"},
        extra_meta={b"geometry_source": b"unit-test"},
    )
    convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02, bbox=True))

    meta = pq.read_metadata(dst).metadata
    geo = json.loads(meta[b"geo"])
    col = geo["columns"]["geometry"]
    assert col["edges"] == "spherical"
    assert col["orientation"] == "counterclockwise"
    # The converter still overlays its own computed fields.
    assert col["encoding"] == "WKB"
    assert "covering" in col
    # An unrelated top-level key is preserved (exact-key filter, not a prefix).
    assert meta[b"geometry_source"] == b"unit-test"


def test_non_wkb_encoding_rejected(tmp_path):
    """C9, a native GeoArrow encoding is rejected with a clear error."""
    src = tmp_path / "geoarrow.parquet"
    dst = tmp_path / "out.parquet"
    _write_gpq(src, _make_polygons(20), column_extra={"encoding": "point"})
    with pytest.raises(ValueError, match="only WKB is supported"):
        convert(str(src), str(dst))


def test_empty_input_raises(tmp_path):
    """C11, an input with no rows raises a clear error, not an opaque numpy one."""
    src = tmp_path / "empty.parquet"
    dst = tmp_path / "out.parquet"
    _write_gpq(src, [])
    with pytest.raises(ValueError, match="no rows"):
        convert(str(src), str(dst))


def test_all_null_input_raises(tmp_path):
    """C11, an input where every geometry is null cannot yield an extent."""
    src = tmp_path / "allnull.parquet"
    dst = tmp_path / "out.parquet"
    _write_gpq(src, [None, None, None])
    with pytest.raises(ValueError, match="no non-empty geometries"):
        convert(str(src), str(dst))


def test_band_and_option_validation(tmp_path):
    """C10, invalid band and budget options fail fast with clear errors. bands=0
    is valid now, it means derive the count from density, so only a negative band
    count is rejected."""
    src = tmp_path / "plain.parquet"
    dst = tmp_path / "out.parquet"
    _write_plain(src, n=50)

    with pytest.raises(ValueError, match="bands must be 0"):
        convert(str(src), str(dst), ConvertOptions(bands=-1))
    with pytest.raises(ValueError, match="row_group_mb must be positive"):
        convert(str(src), str(dst), ConvertOptions(row_group_mb=0))
    with pytest.raises(ValueError, match="screen_budget_mb must be positive"):
        convert(str(src), str(dst), ConvertOptions(screen_budget_mb=0))
    # A forced count past the coarse cap is rejected, so it can never underflow
    # the thinning grid the way an uncapped value silently did.
    over = convert_mod._MAX_COARSE_BANDS + 2
    with pytest.raises(ValueError, match="bands must be at most"):
        convert(str(src), str(dst), ConvertOptions(bands=over))


def test_grid_origin_anchored_at_zero(tmp_path):
    """The overview snap runs from coordinate zero (set_precision anchors there),
    so every coarse level's grid.origin is [0, 0], not the dataset corner."""
    src = tmp_path / "plain.parquet"
    dst = tmp_path / "out.parquet"
    _write_clustered(src, n=300)
    convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02, screen_budget_mb=_OV_BUDGET))

    ov = json.loads(pq.read_metadata(dst).metadata[b"overviews"])
    coarse = [lvl for lvl in ov["levels"] if lvl.get("grid") is not None]
    assert coarse, "expected at least one coarse level with a grid"
    for lvl in coarse:
        assert lvl["grid"]["origin"] == [0.0, 0.0]


def test_thinning_is_input_order_independent(tmp_path):
    """The thinning survivor is decided by (metric, then a content hash), never by
    input row order, so shuffling the rows leaves every feature in the same band."""
    geoms = _make_polygons(400, seed=7)
    forward = tmp_path / "fwd.parquet"
    shuffled = tmp_path / "shuf.parquet"
    order = np.random.default_rng(3).permutation(len(geoms))
    _write_gpq(forward, geoms)
    _write_gpq(shuffled, [geoms[i] for i in order])

    fout = tmp_path / "fout.parquet"
    sout = tmp_path / "sout.parquet"
    convert(str(forward), str(fout), ConvertOptions(row_group_mb=0.02))
    convert(str(shuffled), str(sout), ConvertOptions(row_group_mb=0.02))

    def band_by_geometry(path):
        t = pq.read_table(path, columns=["band", "geometry"])
        wkb = t.column("geometry").to_pylist()
        return dict(zip(wkb, t.column("band").to_pylist(), strict=True))

    fmap = band_by_geometry(fout)
    smap = band_by_geometry(sout)
    assert fmap == smap


def test_thinning_survives_degenerate_geometry(tmp_path):
    """A degenerate polygon (collinear ring, zero area) can make GEOS return an
    empty representative point, the thinning path must not crash on it."""
    geoms = _make_polygons(80, seed=2)
    # A collinear "polygon", non-empty but zero area, plus a valid one after it.
    geoms.append(shapely.from_wkt("POLYGON((0 0, 5 5, 10 10, 0 0))"))
    src = tmp_path / "degen.parquet"
    dst = tmp_path / "out.parquet"
    _write_gpq(src, geoms)

    summary = convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02))
    assert summary["features"] == len(geoms)


def test_empty_bands_renumbered(tmp_path):
    """C10, a tiny dataset whose thinning leaves a coarse band empty renumbers the
    populated bands so the level ladder starts at 0 and stays contiguous."""
    src = tmp_path / "tiny.parquet"
    dst = tmp_path / "out.parquet"
    # 10 sparse features, thinning can empty a coarse band, but the levels must
    # still start at 0 and stay contiguous.
    _write_gpq(src, _make_polygons(10))
    summary = convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02))

    ov = json.loads(pq.read_metadata(dst).metadata[b"overviews"])
    levels = [lvl["level"] for lvl in ov["levels"]]
    assert levels[0] == 0
    assert levels == list(range(len(levels)))
    assert summary["bands"] == len(levels)


def test_coarse_bbox_padded_covers_overview(tmp_path):
    """C13, the coarse-band covering is padded so a snapped overview vertex never
    leaves the bbox a viewer prunes with."""
    src = tmp_path / "plain.parquet"
    dst = tmp_path / "out.parquet"
    _write_clustered(src, n=300)
    convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02, screen_budget_mb=_OV_BUDGET, bbox=True))

    out = pq.read_table(dst)
    band0 = out.filter(pa.compute.equal(out.column("band"), 0))
    bbox = band0.column("bbox").to_pylist()
    overview = shapely.from_wkb(band0.column("geom_overview").to_pylist())
    for b, ov in zip(bbox, overview, strict=True):
        # A sub-pixel feature can carry a NULL overview under the coarse per-band
        # snap grid, there is nothing to cover for it.
        if ov is None:
            continue
        oxmin, oymin, oxmax, oymax = ov.bounds
        assert b["xmin"] <= oxmin + 1e-12
        assert b["ymin"] <= oymin + 1e-12
        assert b["xmax"] >= oxmax - 1e-12
        assert b["ymax"] >= oymax - 1e-12


def test_per_band_bbox_padding(tmp_path):
    """Each coarse band's bbox is padded by half that band's own tolerance,
    covering both snap movement (grid/2) and the quad fallback, whose square
    can extend half a band pixel beyond the feature bbox. A coarser band pads
    more than a finer coarse band, and the finest exact band is unpadded. Many
    small polygons packed into a sub-degree extent cascade across two coarse
    bands and a populated finest band."""
    src = tmp_path / "packed.parquet"
    dst = tmp_path / "out.parquet"
    # Tight overlapping clusters so band-0 thinning plus the fraction split fill
    # two coarse bands and still fill the finest exact band, giving three populated
    # bands to compare per-band padding across.
    _write_gpq(src, _make_clustered(600, seed=5))

    summary = convert(str(src), str(dst), ConvertOptions(bands=3, row_group_mb=0.02, bbox=True))
    bands = summary["bands"]
    assert bands == 3  # two coarse bands plus a populated finest exact band

    out = pq.read_table(dst)
    band = np.array(out.column("band").to_pylist())
    geom = shapely.from_wkb(out.column("geometry").to_pylist())
    bbox = out.column("bbox").to_pylist()
    # Read the per-band gsd straight from the footer, the source of truth, so
    # the check does not depend on how the ladder was anchored.
    ov = json.loads(pq.read_metadata(dst).metadata[b"overviews"])

    # Both coarse bands and the finest band are populated, so the comparison is
    # real.
    for b in range(bands):
        assert int((band == b).sum()) > 0

    def _pad(b):
        idx = np.where(band == b)[0]
        pads = np.array([geom[i].bounds[0] - bbox[i]["xmin"] for i in idx])
        # The pad is uniform within a band.
        assert np.allclose(pads, pads[0])
        return pads[0]

    pad0 = _pad(0)
    pad1 = _pad(1)
    # Each coarse band pads by half its own tolerance, the band gsd from the
    # footer, band 0 more than the finer band 1. The snap grid is a quarter of
    # the tolerance, so this also covers the plain grid/2 snap movement.
    gsds = {lvl["level"]: lvl["gsd"] for lvl in ov["levels"] if lvl["grid"]}
    assert pad0 == pytest.approx(gsds[0] / 2)
    assert pad1 == pytest.approx(gsds[1] / 2)
    assert pad0 > pad1
    # The finest exact band is never padded.
    assert _pad(bands - 1) == pytest.approx(0.0)


def test_projected_crs_preserved_and_zoom(tmp_path):
    """C6 end to end, a projected metre CRS is treated as projected, keeps its
    crs, and does not blow up max_zoom the way a mislabeled degrees world would."""
    src = tmp_path / "proj.parquet"
    dst = tmp_path / "out.parquet"
    # Small polygons in a metre-scale extent, tagged EPSG:3067.
    rng = np.random.default_rng(3)
    geoms = []
    for _ in range(200):
        cx, cy = rng.uniform(0, 100000, 2)
        r = rng.uniform(50, 2000)
        angles = np.linspace(0, 2 * np.pi, 80, endpoint=False)
        geoms.append(shapely.Polygon(np.column_stack([cx + np.cos(angles) * r, cy + np.sin(angles) * r])))
    _write_gpq(src, geoms, crs="EPSG:3067")

    summary = convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02))
    assert summary["geographic"] is False
    assert summary["crs_preserved"] is True
    geo = json.loads(pq.read_metadata(dst).metadata[b"geo"])
    assert geo["columns"]["geometry"]["crs"] == "EPSG:3067"


# --- Geometry type support (points, lines, multi, mixed) ------------------


def _wiggly_line(x0, y0, dx, dy, seed, nverts=120):
    """A many-vertex line from (x0,y0) toward (x0+dx, y0+dy) with small jitter,
    so simplification meaningfully shrinks its byte size."""
    rng = np.random.default_rng(seed)
    t = np.linspace(0, 1, nverts)
    xs = x0 + t * dx + rng.normal(0, abs(dx) * 0.003 + 1e-9, nverts)
    ys = y0 + t * dy + rng.normal(0, abs(dy) * 0.003 + 1e-9, nverts)
    return shapely.LineString(np.column_stack([xs, ys]))


def test_point_dataset_thinned_stratified(tmp_path):
    """A pure point dataset bands by grid representativeness, not file order. Ten
    spatially separated locations, ten duplicate points each in file order, put
    exactly one point per location in band 0, not the first three percent of the
    file. It writes no geom_overview column, and the footer is honest."""
    src = tmp_path / "points.parquet"
    dst = tmp_path / "out.parquet"
    locations = [(i * 100.0, (i % 3) * 100.0) for i in range(10)]
    geoms = []
    for lx, ly in locations:  # blocked, so a file-order band 0 would be all loc 0
        geoms.extend(shapely.Point(lx, ly) for _ in range(10))
    _write_gpq(src, geoms)

    # Force a coarse band so the stratification is exercised, the point payload is
    # tiny and would otherwise derive to a single exact band with no thinning.
    summary = convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02, bands=2))
    assert summary["has_overview"] is False

    out = pq.read_table(dst)
    assert "geom_overview" not in out.column_names
    band = np.array(out.column("band").to_pylist())
    pts = shapely.from_wkb(out.column("geometry").to_pylist())
    band0 = band == 0
    # One representative per coarse cell, so band 0 has exactly the 10 locations,
    # not round(100 * 0.03) = 3 leading rows.
    assert int(band0.sum()) == 10
    band0_locs = {(round(p.x, 6), round(p.y, 6)) for p in pts[band0]}
    assert band0_locs == {(round(lx, 6), round(ly, 6)) for lx, ly in locations}

    ov = json.loads(pq.read_metadata(dst).metadata[b"overviews"])
    assert ov["importance"] == "grid_thin"
    assert ov["overview_method"] == "thin"
    assert "overview_column" not in ov


def test_point_dataset_importance_column(tmp_path):
    """Points ranked by a numeric attribute column keep the highest-weight point
    as each coarse cell's survivor, and the footer records the real column name.
    Points are co-located in clusters so the attribute, not spatial separation,
    decides the band-0 survivor of each cluster."""
    src = tmp_path / "points.parquet"
    dst = tmp_path / "out.parquet"
    # Five clusters, ten co-located points each, clusters spread far apart so each
    # is its own coarse cell. Within cluster c the weights are c*10 .. c*10+9, so
    # the band-0 survivor per cluster is the maximum, c*10+9.
    clusters = 5
    per = 10
    geoms = []
    weight = []
    for c in range(clusters):
        for k in range(per):
            geoms.append(shapely.Point(c * 1000.0, 0.0))
            weight.append(float(c * per + k))
    _write_gpq(src, geoms, extra_columns={"weight": pa.array(np.array(weight))})

    # Band 0 is thinned to one survivor per coarsest cell over all valid points,
    # the highest attribute value in each cluster. This far-flung fixture puts
    # each cluster in its own coarsest cell, so all five cluster maxima survive
    # band 0 and the attribute ranking below holds. Force enough bands that band
    # 0 is genuinely a thinned coarse band rather than the lone exact band.
    summary = convert(
        str(src), str(dst),
        ConvertOptions(bands=2, row_group_mb=0.02, importance_column="weight"),
    )
    assert summary["has_overview"] is False

    out = pq.read_table(dst)
    assert "geom_overview" not in out.column_names
    band = np.array(out.column("band").to_pylist())
    w = np.array(out.column("weight").to_pylist())
    band0_weights = set(w[band == 0].tolist())
    # One survivor per cluster, the highest weight in each, c*10+9.
    assert band0_weights == {float(c * per + per - 1) for c in range(clusters)}

    ov = json.loads(pq.read_metadata(dst).metadata[b"overviews"])
    assert ov["importance"] == "attribute:weight"
    assert ov["overview_method"] == "thin"


def test_line_dataset_ranked_by_length(tmp_path):
    """A pure line dataset ranks longest first, its coarse overview is smaller
    than the exact geometry, and no coarse-band overview is written as empty WKB."""
    src = tmp_path / "lines.parquet"
    dst = tmp_path / "out.parquet"
    geoms = []
    # 200 short-to-medium lines plus a handful of extent-spanning ones.
    for i in range(200):
        geoms.append(_wiggly_line(0, 0, (i % 20) + 1.0, (i % 7) + 1.0, seed=i))
    long_ids = list(range(200, 205))
    for i in long_ids:
        geoms.append(_wiggly_line(0, 0, 1000.0, 1000.0, seed=i))
    _write_gpq(src, geoms)

    summary = convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02, screen_budget_mb=_OV_BUDGET))
    assert summary["has_overview"] is True

    out = pq.read_table(dst)
    ids = np.array(out.column("id").to_pylist())
    band = np.array(out.column("band").to_pylist())
    band0_ids = set(ids[band == 0].tolist())
    # The extent-spanning lines are the longest, so they land in band 0.
    assert set(long_ids) <= band0_ids

    coarse = out.filter(pa.compute.less(out.column("band"), summary["bands"] - 1))
    exact = shapely.from_wkb(coarse.column("geometry").to_pylist())
    ov_wkb = coarse.column("geom_overview").to_pylist()
    exact_bytes = sum(len(w) for w in shapely.to_wkb(exact))
    ov_bytes = sum(len(w) for w in ov_wkb if w is not None)
    assert ov_bytes < exact_bytes
    # No coarse-band overview is an empty geometry, it is a real line or NULL.
    for w in ov_wkb:
        assert w is not None  # these are long lines, they survive
        assert not shapely.from_wkb(w).is_empty

    ov = json.loads(pq.read_metadata(dst).metadata[b"overviews"])
    assert ov["importance"] == "length_desc"
    assert ov["overview_method"] == "simplify_snap"


def test_line_overview_falls_back_when_snap_collapses():
    """A line short enough that grid snapping collapses it to empty falls back to
    the simplified unsnapped geometry, never an empty WKB. Longer lines snap
    normally, and any truly degenerate result is NULL, never empty WKB."""
    tiny = shapely.LineString([(0.0, 0.0), (0.001, 0.0)])  # shorter than the grid
    big = shapely.LineString([(0.0, 0.0), (100.0, 100.0), (200.0, 0.0)])
    src = np.array([tiny, big], dtype=object)
    dims = np.array([1, 1])
    wkb = convert_mod._overview_values(src, dims, tol=1.0, grid=10.0)
    for w in wkb:
        # NULL or a non-empty geometry, but never empty WKB.
        assert w is None or not shapely.from_wkb(w).is_empty
    # The tiny line collapses under the grid but is preserved via the fallback.
    assert wkb[0] is not None
    assert not shapely.from_wkb(wkb[0]).is_empty


def test_mixed_dataset_line_reaches_band0(tmp_path):
    """In a mixed layer, per-dimension cohorts merge by percentile, so one
    extent-spanning line reaches band 0 alongside the large polygons."""
    src = tmp_path / "mixed.parquet"
    dst = tmp_path / "out.parquet"
    geoms = _make_polygons(200, seed=4)  # large polygons in extent 0..10
    line_id = len(geoms)
    geoms.append(shapely.LineString([(0.0, 0.0), (10.0, 10.0)]))  # spans the extent
    _write_gpq(src, geoms)

    # Force two bands and a coarse enough band-0 tolerance that thinning demotes
    # a real share of the polygons into the finest band, so band 0 is a genuine
    # thinned coarse band rather than collapsing to a single exact band. The lone
    # line is the sole feature of its geometry dimension, so it never contends
    # with a polygon for a cell and always survives into band 0.
    convert(str(src), str(dst), ConvertOptions(bands=2, row_group_mb=0.02, coarsest_rel=0.1))

    out = pq.read_table(dst)
    ids = np.array(out.column("id").to_pylist())
    band = np.array(out.column("band").to_pylist())
    geom_types = [g.geom_type for g in shapely.from_wkb(out.column("geometry").to_pylist())]
    line_pos = [i for i, t in enumerate(geom_types) if t == "LineString"]
    assert len(line_pos) == 1
    assert int(ids[line_pos[0]]) == line_id
    assert band[line_pos[0]] == 0  # the lone line reached band 0

    ov = json.loads(pq.read_metadata(dst).metadata[b"overviews"])
    assert ov["importance"] == "mixed_quantile_desc"
    # With a real coarse band the footer reports honest work, band 0 is thinned
    # and simplified, so the method is `simplify_snap` and the coarse band carries
    # a count column.
    assert ov["overview_method"] == "simplify_snap"
    assert ov["count_column"] == "overview_count"


def test_single_band_collapse_writes_method_none(tmp_path):
    """Guards the honesty branch that `test_mixed_dataset_line_reaches_band0`
    also exercises: when `_derive_bands` genuinely returns 1 (the exact
    geometry already fits the screen budget at the dataset's own coarsest
    zoom), there is no coarse band, so no fraction split and no band-0
    thinning run. `overview_method` must then report the honest `none`, never
    a false `simplify_snap`. The fixture here is a handful of small boxes
    spread thinly across a wide extent, few vertices and low local byte
    density, so it collapses to one band under the derived band count with no
    override needed. A polygon
    fixture is used (not points), since a pure-point file always writes
    `overview_method` `thin`, not `none`. The wide extent (span 100, versus
    the 0..10 extent most fixtures use) is what keeps the local byte density
    low enough that `_derive_bands` genuinely returns 1; a tighter extent
    with the same boxes derives 2 bands instead (see
    `test_mixed_dataset_line_reaches_band0`)."""
    src = tmp_path / "sparse.parquet"
    dst = tmp_path / "out.parquet"
    rng = np.random.default_rng(3)
    geoms = []
    for _ in range(20):
        cx, cy = rng.uniform(0, 100, 2)
        geoms.append(shapely.box(cx - 0.05, cy - 0.05, cx + 0.05, cy + 0.05))
    _write_gpq(src, geoms)

    summary = convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02))

    band = np.array(pq.read_table(dst).column("band").to_pylist())
    assert np.all(band == 0)
    assert summary["bands"] == 1
    assert summary["has_overview"] is False

    ov = json.loads(pq.read_metadata(dst).metadata[b"overviews"])
    assert ov["overview_method"] == "none"
    assert "count_column" not in ov


def test_polygon_geometry_types_correct(tmp_path):
    """A plain polygon dataset writes geometry_types ['Polygon'], the GEOS id map
    bug previously wrote ['MultiPoint']."""
    src = tmp_path / "plain.parquet"
    dst = tmp_path / "out.parquet"
    _write_plain(src, n=120)
    convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02))

    geo = json.loads(pq.read_metadata(dst).metadata[b"geo"])
    assert geo["columns"]["geometry"]["geometry_types"] == ["Polygon"]


def test_overview_geometry_types_recomputed(tmp_path):
    """geom_overview's geometry_types come from the overview WKB, not a copy of
    the exact column. Large single polygons and tiny multipolygons are clustered
    into a single coarse cell, so density thinning keeps exactly one band-0
    survivor per cell, the highest-area feature, which is a Polygon. Every
    multipolygon is demoted to the finest band with a null overview, so the
    exact column lists both types while the overview never lists MultiPolygon.
    A band-0 survivor whose box collapses below the band pixel falls back to
    its representative point, so Point may appear in the overview types, and
    that too must be recomputed honestly."""
    src = tmp_path / "multi.parquet"
    dst = tmp_path / "out.parquet"
    geoms = []
    # Each cluster holds a larger polygon and a tiny multipolygon at the same
    # location, so the pair contends for one coarse cell. The larger-area polygon
    # wins band 0 and the multipolygon is demoted to the finest band with a null
    # overview, so the overview column lists only Polygon while the exact column
    # lists both. Clusters sit far enough apart to fall in distinct coarse cells.
    for k in range(20):
        cx, cy = k * 0.05, 0.0
        geoms.append(shapely.box(cx - 0.02, cy - 0.02, cx + 0.02, cy + 0.02))  # larger polygon
        s = 0.0001
        sq1 = shapely.box(cx - s, cy - s, cx, cy)
        sq2 = shapely.box(cx, cy, cx + s, cy + s)
        geoms.append(shapely.MultiPolygon([sq1, sq2]))  # tiny multipolygon at the same spot
    _write_gpq(src, geoms)

    # Force two bands so every loser lands in the finest band (null overview)
    # rather than surviving a mid band and carrying an overview of its own. A
    # coarser band-0 tolerance keeps each cluster's polygon and multipolygon in
    # one shared cell so the higher-area polygon reliably wins and the
    # multipolygon is demoted, while the 0.05-spaced clusters stay in distinct
    # cells.
    convert(str(src), str(dst), ConvertOptions(bands=2, row_group_mb=0.02, coarsest_rel=0.01))

    geo = json.loads(pq.read_metadata(dst).metadata[b"geo"])
    assert geo["columns"]["geometry"]["geometry_types"] == ["MultiPolygon", "Polygon"]
    # Every multipolygon is demoted to the finest band (null overview), so no
    # MultiPolygon reaches the overview column. Survivors write their simplified
    # Polygon, or a Point where the shape collapsed below the band pixel.
    ov_types = geo["columns"]["geom_overview"]["geometry_types"]
    assert "MultiPolygon" not in ov_types
    assert set(ov_types) <= {"Point", "Polygon"}
    assert "Polygon" in ov_types or "Point" in ov_types


def test_reconvert_overview_has_no_covering(tmp_path):
    """On re-convert, geom_overview must not inherit a stale `covering` key from
    the source geometry column's metadata, while the primary geometry keeps it."""
    src = tmp_path / "plain.parquet"
    once = tmp_path / "once.parquet"
    twice = tmp_path / "twice.parquet"
    _write_clustered(src, n=200)

    convert(str(src), str(once), ConvertOptions(row_group_mb=0.02, screen_budget_mb=_OV_BUDGET, bbox=True))
    # The first output already carries a covering on geometry but not on overview.
    geo_once = json.loads(pq.read_metadata(once).metadata[b"geo"])
    assert "covering" in geo_once["columns"]["geometry"]
    assert "covering" not in geo_once["columns"]["geom_overview"]

    convert(str(once), str(twice), ConvertOptions(row_group_mb=0.02, screen_budget_mb=_OV_BUDGET, bbox=True))
    geo_twice = json.loads(pq.read_metadata(twice).metadata[b"geo"])
    assert "covering" in geo_twice["columns"]["geometry"]
    assert "covering" not in geo_twice["columns"]["geom_overview"]


# --- Density thinning (Phase 1) -------------------------------------------


def _square(cx, cy, s):
    """An axis-aligned square of side `s` centred at (cx, cy)."""
    return shapely.box(cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2)


def test_thinning_demotes_dense_features(tmp_path):
    """Many large polygons packed into a single coarse-band cell collapse to
    roughly one survivor in band 0 with band-0 thinning on. With thinning off
    band 0 is instead a plain importance fraction of the whole set, so it holds
    far more of the cluster. Compare band-0 counts thin vs no-thin."""
    src = tmp_path / "dense.parquet"
    thin_dst = tmp_path / "thin.parquet"
    nothin_dst = tmp_path / "nothin.parquet"
    # 200 big overlapping squares clustered so their on-surface points share one
    # band-0 cell, plus one far tiny anchor that stretches the extent so the
    # band-0 cell is comfortably larger than the cluster. A large cohort keeps a
    # clear contrast between the two modes now that the default coarse fraction
    # is a small slice of the whole set.
    geoms = [_square(i * 0.0002, 0.0, 5.0) for i in range(200)]
    geoms.append(_square(1000.0, 0.0, 0.001))
    _write_gpq(src, geoms)

    opts = dict(bands=2, row_group_mb=0.02)
    convert(str(src), str(thin_dst), ConvertOptions(thin=True, **opts))
    convert(str(src), str(nothin_dst), ConvertOptions(thin=False, **opts))

    def _band0(path):
        band = np.array(pq.read_table(path).column("band").to_pylist())
        return int((band == 0).sum())

    thin_b0 = _band0(thin_dst)
    nothin_b0 = _band0(nothin_dst)
    # Without band-0 thinning, band 0 is a plain importance fraction of the whole
    # set and keeps many features. With thinning it collapses the packed cluster
    # to about one survivor per cell.
    assert nothin_b0 >= 10
    assert thin_b0 <= 3
    assert thin_b0 < nothin_b0
    # The two modes must stay clearly distinct, not off by a feature or two.
    assert nothin_b0 >= thin_b0 * 3


def test_thin_band0_survivors_subset_of_valid():
    """Band-0 thinning keeps one survivor per coarsest cell, so the survivors are
    a strict subset of the valid features and only valid features can survive.
    The per-survivor counts sum to the whole valid population, losers carry 0."""
    rng = np.random.default_rng(11)
    n = 200
    dimensions = np.full(n, 2, dtype=np.int8)
    valid = np.ones(n, dtype=bool)
    valid[[7, 88, 150]] = False  # a few invalid rows never survive
    # Cluster the representative points onto a coarse grid so cells collide.
    rx = rng.integers(0, 5, n).astype(np.float64)
    ry = rng.integers(0, 5, n).astype(np.float64)
    metric = rng.random(n)
    stable_hash = rng.integers(0, 2**32, n, dtype=np.uint64).astype(np.uint32)

    # cell = span * coarsest_rel = 1.0, so the integer grid gives at most 25 cells.
    is_survivor, counts = convert_mod._thin_band0(
        dimensions, rx, ry, metric, stable_hash, valid,
        span=10.0, coarsest_rel=0.1, ladder_factor=2.0, origin=(0.0, 0.0),
    )
    # Only valid features survive, and thinning genuinely dropped some.
    assert not (is_survivor & ~valid).any()
    assert 0 < int(is_survivor.sum()) < int(valid.sum())
    # Every valid feature competed in the single band-0 pass, so the survivor
    # counts sum to the whole valid population and losers carry no count.
    assert int(counts[is_survivor].sum()) == int(valid.sum())
    assert np.all(counts[~is_survivor] == 0)


def test_thin_band0_is_idempotent():
    """The crc32/stable_hash tie-break makes band-0 thinning deterministic, so
    running it twice on the same inputs yields the identical survivor mask and
    counts, a fixed point."""
    rng = np.random.default_rng(13)
    n = 300
    dimensions = np.full(n, 2, dtype=np.int8)
    valid = np.ones(n, dtype=bool)
    rx = rng.integers(0, 6, n).astype(np.float64)
    ry = rng.integers(0, 6, n).astype(np.float64)
    metric = rng.random(n)
    stable_hash = rng.integers(0, 2**32, n, dtype=np.uint64).astype(np.uint32)
    kw = dict(span=10.0, coarsest_rel=0.1, ladder_factor=2.0, origin=(0.0, 0.0))

    once, counts_a = convert_mod._thin_band0(
        dimensions, rx, ry, metric, stable_hash, valid, **kw
    )
    twice, counts_b = convert_mod._thin_band0(
        dimensions, rx, ry, metric, stable_hash, valid, **kw
    )
    assert np.array_equal(once, twice)
    assert np.array_equal(counts_a, counts_b)


def test_thin_band0_independent_of_input_order():
    """The crc32 tie-break makes the per-cell survivor order-independent. Build a
    cell layout with tied metrics so the hash alone decides, thin it, shuffle
    every input row, thin again, and assert the surviving feature ids match."""
    # 5 cells, 4 features each, all metric equal so the crc32 tie-break decides.
    ids = np.arange(20)
    cells = np.repeat(np.arange(5), 4)  # 4 features share each cell
    dimensions = np.full(20, 2, dtype=np.int8)
    valid = np.ones(20, dtype=bool)
    # Place each cluster far enough apart to fall in its own coarsest cell.
    rx = cells.astype(np.float64) * 10.0 + 0.5
    ry = np.full(20, 0.5)
    metric = np.ones(20)  # tied, hash decides
    stable_hash = np.fromiter(
        (convert_mod.zlib.crc32(f"feature-{i}".encode()) for i in ids),
        dtype=np.uint32, count=20,
    )
    # cell = span * coarsest_rel = 5.0, under the 10.0 cluster spacing.
    kw = dict(span=50.0, coarsest_rel=0.1, ladder_factor=2.0, origin=(0.0, 0.0))

    is_survivor, counts = convert_mod._thin_band0(
        dimensions, rx, ry, metric, stable_hash, valid, **kw
    )
    survivors = set(ids[is_survivor].tolist())
    # Each survivor's count is its cell's whole population, four per cell here.
    assert np.all(counts[is_survivor] == 4)

    perm = np.random.default_rng(99).permutation(20)
    is_survivor2, _ = convert_mod._thin_band0(
        dimensions[perm], rx[perm], ry[perm], metric[perm],
        stable_hash[perm], valid[perm], **kw,
    )
    survivors2 = set(ids[perm][is_survivor2].tolist())

    # One survivor per cell, five in all, identical set regardless of order.
    assert len(survivors) == 5
    assert survivors == survivors2


def test_thinning_byte_identical_across_jobs(tmp_path):
    """Thinning is pure numpy and single-threaded, so a converted file is
    byte-identical whether the overview build ran on one thread or many."""
    src = tmp_path / "src.parquet"
    one = tmp_path / "one.parquet"
    many = tmp_path / "many.parquet"
    _write_gpq(src, _make_polygons(600))
    convert(str(src), str(one), ConvertOptions(bands=3, jobs=1))
    convert(str(src), str(many), ConvertOptions(bands=3, jobs=2))
    assert one.read_bytes() == many.read_bytes()


def test_no_feature_lost_under_derived_banding(tmp_path):
    """No feature is ever removed under derived, thinning-only banding. The output
    row count equals the input, and the bands partition every row, each feature in
    exactly one band, the coarse survivors plus the finest exact band covering all
    of them."""
    src = tmp_path / "src.parquet"
    dst = tmp_path / "out.parquet"
    geoms = _make_polygons(400, seed=8)
    _write_gpq(src, geoms)

    summary = convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02))
    assert summary["features"] == 400

    out = pq.read_table(dst)
    assert out.num_rows == 400
    band = np.array(out.column("band").to_pylist())
    bands = summary["bands"]
    # Every band from 0 to bands-1 is a valid ordinal, and together they cover
    # all 400 rows with no row left unbanded and none double-counted.
    assert band.min() >= 0 and band.max() <= bands - 1
    assert int((band == bands - 1).sum()) >= 1  # a populated finest exact band
    covered = sum(int((band == b).sum()) for b in range(bands))
    assert covered == 400


def _poly_table(n=40):
    """A clustered polygon table. Features gather into tight clusters so that
    band-0 density thinning demotes the crowd of each cluster into the fraction
    banded rest and keeps one coarse-band survivor. That yields a
    populated coarse band (and a `geom_overview` column) under the derived,
    zoom-anchored banding, which a spread of one polygon per band-0 cell would
    not. Eight clusters of `n // 8` boxes, clusters a unit apart, boxes within a
    cluster only a thousandth apart so they stack inside one coarse cell under the
    fine extent-anchored band-0 grid."""
    import shapely

    geoms = []
    clusters = 8
    per = max(1, n // clusters)
    for c in range(clusters):
        for k in range(per):
            cx = c * 1.0 + k * 0.001
            geoms.append(shapely.box(cx, 0.0, cx + 0.15, 0.15))
    wkb = [shapely.to_wkb(g) for g in geoms]
    return pa.table(
        {"name": [f"f{i}" for i in range(len(geoms))], "geometry": pa.array(wkb, type=pa.binary())}
    )


def test_native_geo_types_and_stats(tmp_path):
    src = tmp_path / "src.parquet"
    dst = tmp_path / "dst.parquet"
    pq.write_table(_poly_table(), src)
    convert(str(src), str(dst), ConvertOptions(bands=2))
    pf = pq.ParquetFile(dst)
    # The geometry columns carry the Parquet GEOMETRY logical type.
    schema = pf.schema_arrow
    assert "geoarrow.wkb" in str(schema.field("geometry").type)
    # Every row group chunk of the primary geometry column has geospatial statistics.
    geom_idx = [c.path_in_schema for c in
                [pf.metadata.row_group(0).column(i) for i in range(pf.metadata.num_columns)]].index("geometry")
    for rg in range(pf.metadata.num_row_groups):
        col = pf.metadata.row_group(rg).column(geom_idx)
        assert col.is_geo_stats_set, f"row group {rg} missing geospatial statistics"
        assert col.geo_statistics is not None
    # bands=2 produces a coarse band, so a geom_overview column exists, and the
    # same `_write` stats change applies to it too.
    overview_idx = [c.path_in_schema for c in
                     [pf.metadata.row_group(0).column(i) for i in range(pf.metadata.num_columns)]].index(
        "geom_overview"
    )
    for rg in range(pf.metadata.num_row_groups):
        col = pf.metadata.row_group(rg).column(overview_idx)
        assert col.is_geo_stats_set, f"row group {rg} geom_overview missing geospatial statistics"
    # The geo key is still there, dual-write.
    kv = pf.metadata.metadata
    assert b"geo" in kv and b"overviews" in kv


def test_native_geo_crs_round_trips_and_has_stats(tmp_path):
    """C6 for native types, a projected CRS on the source column survives onto
    the geoarrow.wkb extension type of the written `geometry` column, and that
    column still gets geospatial statistics with the CRS present."""
    src = tmp_path / "proj.parquet"
    dst = tmp_path / "out.parquet"
    rng = np.random.default_rng(3)
    geoms = []
    for _ in range(200):
        cx, cy = rng.uniform(0, 100000, 2)
        r = rng.uniform(50, 2000)
        angles = np.linspace(0, 2 * np.pi, 80, endpoint=False)
        geoms.append(shapely.Polygon(np.column_stack([cx + np.cos(angles) * r, cy + np.sin(angles) * r])))
    _write_gpq(src, geoms, crs="EPSG:3067")

    convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02))
    pf = pq.ParquetFile(dst)

    # The written geometry column is extension typed (native GEOMETRY), not
    # plain binary WKB.
    geom_type = pf.schema_arrow.field("geometry").type
    assert isinstance(geom_type, pa.ExtensionType)
    assert geom_type.extension_name == "geoarrow.wkb"

    # The extension type carries the source CRS, round-tripped through
    # `with_crs`, not silently dropped or replaced with a default.
    assert geom_type.crs is not None
    assert geom_type.crs.__geoarrow_crs_json_values__()["crs"] == "EPSG:3067"

    # Every row group of the primary geometry column has geospatial statistics
    # with the CRS present, not just when the source is CRS84 default.
    geom_idx = [c.path_in_schema for c in
                [pf.metadata.row_group(0).column(i) for i in range(pf.metadata.num_columns)]].index("geometry")
    for rg in range(pf.metadata.num_row_groups):
        col = pf.metadata.row_group(rg).column(geom_idx)
        assert col.is_geo_stats_set, f"row group {rg} missing geospatial statistics"


def test_no_native_geo_flag(tmp_path):
    src = tmp_path / "src.parquet"
    dst = tmp_path / "dst.parquet"
    pq.write_table(_poly_table(), src)
    convert(str(src), str(dst), ConvertOptions(bands=2, native_geo=False))
    pf = pq.ParquetFile(dst)
    assert str(pf.schema_arrow.field("geometry").type) == "binary"


def test_no_bbox_profile(tmp_path):
    src = tmp_path / "src.parquet"
    dst = tmp_path / "dst.parquet"
    pq.write_table(_poly_table(), src)
    convert(str(src), str(dst), ConvertOptions(bands=2, bbox=False))
    pf = pq.ParquetFile(dst)
    assert "bbox" not in pf.schema_arrow.names
    import json as _json
    geo = _json.loads(pf.metadata.metadata[b"geo"])
    assert "covering" not in geo["columns"]["geometry"]
    ov = _json.loads(pf.metadata.metadata[b"overviews"])
    assert "covering" not in ov
    # Native stats still there, they are the only pruning surface now.
    names = [pf.metadata.row_group(0).column(i).path_in_schema for i in range(pf.metadata.num_columns)]
    col = pf.metadata.row_group(0).column(names.index("geometry"))
    assert col.is_geo_stats_set


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


def test_no_bbox_requires_native_geo(tmp_path):
    with pytest.raises(ValueError, match="native"):
        convert("x", "y", ConvertOptions(bbox=False, native_geo=False))


def test_reconvert_with_no_bbox_drops_stale_covering(tmp_path):
    """A prior converter output already carries a `covering` on `geometry`.
    Re-converting it with `--no-bbox` (Profile B) must not leak that covering
    forward, the output has no `bbox` column for it to point at."""
    src = tmp_path / "src.parquet"
    with_bbox = tmp_path / "with_bbox.parquet"
    no_bbox = tmp_path / "no_bbox.parquet"
    pq.write_table(_poly_table(), src)

    # Profile A: a normal output, which carries a covering.
    convert(str(src), str(with_bbox), ConvertOptions(bands=2))
    geo_with_bbox = json.loads(pq.read_metadata(with_bbox).metadata[b"geo"])
    assert "covering" in geo_with_bbox["columns"]["geometry"]

    # Profile B reconversion of that output must strip the inherited covering.
    convert(str(with_bbox), str(no_bbox), ConvertOptions(bands=2, bbox=False))
    pf = pq.ParquetFile(no_bbox)
    assert "bbox" not in pf.schema_arrow.names
    geo = json.loads(pf.metadata.metadata[b"geo"])
    assert "covering" not in geo["columns"]["geometry"]
    ov = json.loads(pf.metadata.metadata[b"overviews"])
    assert "covering" not in ov
    # Native geospatial statistics remain the pruning surface.
    names = [pf.metadata.row_group(0).column(i).path_in_schema for i in range(pf.metadata.num_columns)]
    col = pf.metadata.row_group(0).column(names.index("geometry"))
    assert col.is_geo_stats_set


def test_reconvert_with_bbox_has_valid_covering(tmp_path):
    """Re-converting a Profile B output with `--bbox` (Profile A) must produce
    a valid covering that points at a `bbox` column actually present in the
    output schema, no dangling reference."""
    src = tmp_path / "src.parquet"
    no_bbox = tmp_path / "no_bbox.parquet"
    with_bbox = tmp_path / "with_bbox.parquet"
    pq.write_table(_poly_table(), src)

    convert(str(src), str(no_bbox), ConvertOptions(bands=2, bbox=False))
    convert(str(no_bbox), str(with_bbox), ConvertOptions(bands=2, bbox=True))

    pf = pq.ParquetFile(with_bbox)
    assert "bbox" in pf.schema_arrow.names
    geo = json.loads(pf.metadata.metadata[b"geo"])
    covering = geo["columns"]["geometry"]["covering"]
    assert covering == {
        "bbox": {
            "xmin": ["bbox", "xmin"],
            "ymin": ["bbox", "ymin"],
            "xmax": ["bbox", "xmax"],
            "ymax": ["bbox", "ymax"],
        }
    }


def test_local_density_sees_clustering():
    """The budget density is local, not the whole-extent average. Two datasets
    with identical total bytes and extent, one uniform and one packed into a
    corner, must report very different densities, the clustered one near its
    corner's own density, so a dense city inside an empty bounding box still
    gets the coarse bands its screens need."""
    bbox = (0.0, 0.0, 10.0, 10.0)
    # Several features per density cell on average, so the uniform case measures
    # true density, not the one-feature-per-occupied-cell quantization floor.
    n = 131072
    rng = np.random.default_rng(7)
    geom_bytes = np.full(n, 100, dtype=np.int64)
    valid = np.ones(n, dtype=bool)

    ux = rng.uniform(0, 10, n)
    uy = rng.uniform(0, 10, n)
    uniform = convert_mod._local_byte_density(ux, uy, geom_bytes, valid, bbox, 10.0, 10.0)

    kx = rng.uniform(0, 0.5, n)
    ky = rng.uniform(0, 0.5, n)
    clustered = convert_mod._local_byte_density(kx, ky, geom_bytes, valid, bbox, 10.0, 10.0)

    average = float(geom_bytes.sum()) / 100.0
    # Uniform data reproduces the plain average within grid granularity.
    assert average / 3 <= uniform <= average * 3
    # The corner cluster occupies 1/400 of the extent, so its local density is
    # hundreds of times the average.
    assert clustered > uniform * 50


def test_clustered_data_derives_more_bands_than_uniform():
    """The same bytes ask for more coarse bands when they cluster, the ladder
    must serve the dense screens a user actually zooms into, not the empty
    countryside average that hands off to the unthinned exact band too early."""
    coarsest_rel = 1 / 1500
    ladder_factor = 2.0
    budget = 1_000_000
    total = 3e8
    span = 10.0
    average = total / (span * span)
    uniform_bands = _derive_bands(average, span, coarsest_rel, ladder_factor, budget)
    clustered_bands = _derive_bands(average * 400, span, coarsest_rel, ladder_factor, budget)
    assert clustered_bands > uniform_bands


def test_ladder_never_exceeds_fine_max_zoom(tmp_path):
    """No overview band may serve past _FINE_MAX_ZOOM - 1, the exact band owns
    _FINE_MAX_ZOOM and beyond. A tiny extent anchors the ladder at a high zoom,
    so a forced band count that would run past the ceiling is clamped, and every
    footer level's max_zoom stays at or under _FINE_MAX_ZOOM."""
    # Derivation side, an absurd density on a tiny extent caps at the ceiling.
    dense = _derive_bands(1e12, 0.001, 0.001, 360.0, 1_000_000)
    z_anchor = convert_mod._coarsest_zoom(0.001, 0.001, 360.0)
    top_zoom = z_anchor + convert_mod._ZOOMS_PER_BAND * (dense - 2)
    assert top_zoom <= convert_mod._FINE_MAX_ZOOM - 1

    # End to end, a forced 10 bands on a ~100 m extent is clamped and the footer
    # ladder never crosses the ceiling.
    rng = np.random.default_rng(3)
    a = np.linspace(0, 2 * np.pi, 8, endpoint=False)
    centers = rng.uniform(0, 0.001, (12, 2))
    geoms = []
    for i in range(480):
        cx, cy = centers[i % 12]
        r = 1e-5 * (1 + (i % 7))
        jx, jy = rng.normal(0, 2e-6, 2)
        geoms.append(shapely.Polygon(np.column_stack([
            cx + jx + np.cos(a) * r, cy + jy + np.sin(a) * r,
        ])))
    src = tmp_path / "tiny.parquet"
    dst = tmp_path / "out.parquet"
    _write_gpq(src, geoms)

    result = convert(str(src), str(dst), ConvertOptions(bands=10, row_group_mb=0.02))

    max_allowed = convert_mod._max_coarse_for_zoom(
        convert_mod._coarsest_zoom(0.001, 0.001, 360.0)
    ) + 1
    assert result["bands"] <= max_allowed
    ov = json.loads(pq.read_metadata(dst).metadata[b"overviews"])
    levels = ov["levels"]
    for lvl in levels[:-1]:
        assert lvl["max_zoom"] <= convert_mod._FINE_MAX_ZOOM - 1
    assert levels[-1]["max_zoom"] <= convert_mod._FINE_MAX_ZOOM


def test_overview_count_column(tmp_path):
    """Band-0 survivors carry the density signal thinning would otherwise
    destroy. Each survivor's overview_count is its coarsest cell's whole
    population, so band 0's counts sum to every valid feature. Only band 0 is
    thinned, so every deeper band, mid or the finest exact band, carries a null
    count, and the footer names the column."""
    src = tmp_path / "src.parquet"
    dst = tmp_path / "out.parquet"
    n = 600
    _write_clustered(src, n=n)

    convert(str(src), str(dst), ConvertOptions(bands=3, row_group_mb=0.02))

    out = pq.read_table(dst)
    assert "overview_count" in out.column_names
    band = np.array(out.column("band").to_pylist())
    counts = out.column("overview_count").to_pylist()

    # Only band 0 carries counts. Every deeper band, mid or finest, is null.
    for b, c in zip(band, counts, strict=True):
        if b == 0:
            assert c is not None and c >= 1
        else:
            assert c is None

    # Every valid feature competed in the single band-0 pass, so band 0's counts
    # cover them all.
    band0_sum = sum(c for b, c in zip(band, counts, strict=True) if b == 0)
    assert band0_sum == n

    ov = json.loads(pq.read_metadata(dst).metadata[b"overviews"])
    assert ov["count_column"] == "overview_count"

    # Re-conversion drops and rebuilds the column, byte-identical.
    dst2 = tmp_path / "out2.parquet"
    convert(str(dst), str(dst2), ConvertOptions(bands=3, row_group_mb=0.02))
    assert dst.read_bytes() == dst2.read_bytes()


def test_point_dataset_carries_counts(tmp_path):
    """A pure point dataset has no overview column, its banding is the level of
    detail, and the survivor counts are its only density signal, so they must be
    written there too."""
    rng = np.random.default_rng(5)
    centers = rng.uniform(0, 10, (5, 2))
    geoms = []
    for i in range(200):
        cx, cy = centers[i % 5]
        jx, jy = rng.normal(0, 0.001, 2)
        geoms.append(shapely.Point(cx + jx, cy + jy))
    src = tmp_path / "pts.parquet"
    dst = tmp_path / "out.parquet"
    _write_gpq(src, geoms)

    convert(str(src), str(dst), ConvertOptions(bands=2, row_group_mb=0.02))

    out = pq.read_table(dst)
    ov = json.loads(pq.read_metadata(dst).metadata[b"overviews"])
    assert ov["overview_method"] == "thin"
    assert "geom_overview" not in out.column_names
    assert ov["count_column"] == "overview_count"
    band = np.array(out.column("band").to_pylist())
    counts = out.column("overview_count").to_pylist()
    band0_sum = sum(c for b, c in zip(band, counts, strict=True) if b == 0)
    assert band0_sum == len(geoms)


def test_no_thin_writes_no_count_column(tmp_path):
    """--no-thin has no survivors to weight, so no count column and no footer
    pointer to one."""
    src = tmp_path / "src.parquet"
    dst = tmp_path / "out.parquet"
    _write_clustered(src, n=300)
    convert(str(src), str(dst), ConvertOptions(bands=3, row_group_mb=0.02, thin=False))
    out = pq.read_table(dst)
    assert "overview_count" not in out.column_names
    ov = json.loads(pq.read_metadata(dst).metadata[b"overviews"])
    assert "count_column" not in ov


def test_precise_xy_falls_back_per_element():
    """When the vectorized representative-point op throws, the fallback is per
    feature, never per chunk, so the degraded set does not depend on how the
    table was split across --jobs and the output stays byte-identical. A
    TypeError (shapely's complaint for a geometry type the op cannot take) is
    handled the same way as a GEOSException."""
    pts = np.array([shapely.Point(1.0, 2.0), shapely.Point(3.0, 4.0)], dtype=object)

    def flaky(g):
        if len(g) > 1:
            raise TypeError("incorrect geometry type")
        return shapely.point_on_surface(g)

    px, py = convert_mod._precise_xy(flaky, pts)
    assert px.tolist() == [1.0, 3.0]
    assert py.tolist() == [2.0, 4.0]

    def poisoned(g):
        if len(g) > 1 or g[0] == shapely.Point(3.0, 4.0):
            raise shapely.errors.GEOSException("boom")
        return shapely.point_on_surface(g)

    px, py = convert_mod._precise_xy(poisoned, pts)
    # The good feature keeps its precise point, only the bad one degrades.
    assert px[0] == 1.0 and py[0] == 2.0
    assert np.isnan(px[1]) and np.isnan(py[1])


def test_subpixel_survivor_falls_back_to_quad(tmp_path):
    """A coarse-band polygon survivor whose shape collapses below its band's
    pixel writes a small grid-aligned quad, not NULL and not a point. One
    survivor per pixel means every survivor stands for its whole cell, and a
    NULL would erase it from the preview, on a buildings dataset at a country
    zoom that blanks the entire first paint. The quad keeps the survivor a
    polygon, Tippecanoe's tiny-polygon-reduction idiom, sized by the feature's
    own area between one grid cell and the band pixel, and it must stay inside
    the band's padded covering."""
    rng = np.random.default_rng(21)
    centers = rng.uniform(0, 10, (10, 2))
    geoms = []
    for i in range(300):
        cx, cy = centers[i % 10]
        jx, jy = rng.normal(0, 0.002, 2)
        s = 0.0004  # far below the band-0 pixel at the extent-anchored zoom
        geoms.append(shapely.box(cx + jx, cy + jy, cx + jx + s, cy + jy + s))
    src = tmp_path / "tiny_boxes.parquet"
    dst = tmp_path / "out.parquet"
    _write_gpq(src, geoms)

    convert(str(src), str(dst), ConvertOptions(bands=3, row_group_mb=0.02, bbox=True))

    out = pq.read_table(dst)
    band = np.array(out.column("band").to_pylist())
    ov = out.column("geom_overview").to_pylist()
    bbox = out.column("bbox").to_pylist()
    ovmeta = json.loads(pq.read_metadata(dst).metadata[b"overviews"])
    tols = {lvl["level"]: lvl["gsd"] for lvl in ovmeta["levels"] if lvl["grid"]}
    grids = {lvl["level"]: lvl["grid"]["cell_size"][0] for lvl in ovmeta["levels"] if lvl["grid"]}
    coarse = band < band.max()
    assert coarse.any()
    n_quads = 0
    for i in np.where(coarse)[0]:
        w = ov[i]
        # Every coarse survivor stays paintable, no NULL blanks the preview.
        assert w is not None
        g = shapely.from_wkb(w)
        assert not g.is_empty
        # A polygon survivor stays a polygon, never a point.
        assert g.geom_type in ("Polygon", "MultiPolygon")
        gb = g.bounds
        side_x = gb[2] - gb[0]
        b_idx = int(band[i])
        if side_x <= tols[b_idx] + 1e-9 and side_x >= grids[b_idx] - 1e-9:
            n_quads += 1
        # The overview stays inside the padded covering.
        bb = bbox[i]
        assert gb[0] >= bb["xmin"] - 1e-9 and gb[2] <= bb["xmax"] + 1e-9
        assert gb[1] >= bb["ymin"] - 1e-9 and gb[3] <= bb["ymax"] + 1e-9
    # The boxes are subpixel at band 0, so the quad fallback must actually fire.
    assert n_quads > 0


def test_footer_count_column_band0_only(tmp_path):
    """Band-0 thinning still runs `_thin_band0`, not the old per-band cascade,
    so the `count_column` and `has_counts` gate in `convert()` must key off
    `opts.thin and bands > 1`, not off which thinning function ran. A row of
    same-size boxes spread wide enough to land in more than one band should
    still get an `overview_count` column and a `feature_count` on every
    level."""
    xs = np.linspace(0, 1000, 400)
    polys = shapely.box(xs, 0, xs + 1, 1)
    t = pa.table(
        {"geometry": pa.array(shapely.to_wkb(polys), type=pa.binary())},
        metadata={
            b"geo": json.dumps({
                "version": "1.1.0",
                "primary_column": "geometry",
                "columns": {
                    "geometry": {"encoding": "WKB", "geometry_types": ["Polygon"]},
                },
            }).encode(),
        },
    )
    src = tmp_path / "in.parquet"
    pq.write_table(t, src)
    dst = tmp_path / "out.parquet"
    convert(str(src), str(dst), ConvertOptions(compression_level=3))
    o = json.loads(pq.ParquetFile(dst).metadata.metadata[b"overviews"])
    if len(o["levels"]) > 1:
        assert o.get("count_column") == "overview_count"
        assert all("feature_count" in lvl for lvl in o["levels"])


def test_cli_band_fractions_parse(tmp_path):
    from click.testing import CliRunner

    from geoparquet_overviews.cli import main

    # --help lists the new flags and not the removed one
    r = CliRunner().invoke(main, ["convert", "--help"])
    assert "--coarsest-rel" in r.output and "--ladder-factor" in r.output
    assert "--band-fractions" in r.output and "--drop-rate" not in r.output
