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
    _is_geographic,
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


def test_convert_writes_overviews_footer(tmp_path):
    src = tmp_path / "plain.parquet"
    dst = tmp_path / "overviews.parquet"
    _write_plain(src)

    summary = convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02))

    assert summary["features"] == 300
    assert summary["row_groups"] >= 3
    assert summary["has_overview"] is True

    meta = pq.read_metadata(dst).metadata
    assert b"geo" in meta
    assert b"overviews" in meta
    ov = json.loads(meta[b"overviews"])
    assert ov["version"] == "0.1.0"
    assert ov["overview_column"] == "geom_overview"
    # Levels are ordered and the last level ends at the last row group.
    ends = [lvl["row_group_end"] for lvl in ov["levels"]]
    assert ends == sorted(ends)
    assert ends[-1] == summary["row_groups"] - 1


def test_row_count_and_geometry_preserved(tmp_path):
    src = tmp_path / "plain.parquet"
    dst = tmp_path / "overviews.parquet"
    source_geoms = _make_polygons(300)
    _write_gpq(src, source_geoms)
    convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02))

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
    _write_plain(src)
    convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02))

    out = pq.read_table(dst)
    band0 = out.filter(pa.compute.equal(out.column("band"), 0))
    exact = shapely.from_wkb(band0.column("geometry").to_pylist())
    overview = shapely.from_wkb(band0.column("geom_overview").to_pylist())
    exact_bytes = sum(len(w) for w in shapely.to_wkb(exact))
    overview_bytes = sum(len(w) for w in shapely.to_wkb(overview))
    assert overview_bytes < exact_bytes


def test_overview_ladder_consistent_across_band_counts():
    """C14, one extent-relative ladder for every band count. Band 0 is the same
    coarse resolution whether there are 2 or 3 bands, not a far weaker preview."""
    span = 300.0
    two = _overview_tolerances(2, span)
    three = _overview_tolerances(3, span)
    assert two[0] == pytest.approx(span / 1500)
    assert three[0] == pytest.approx(span / 1500)
    assert three[1] == pytest.approx(span / 6000)
    # Band 0 preview is identical regardless of band count.
    assert two[0] == pytest.approx(three[0])


def test_null_geometry_segregated(tmp_path):
    """C1, null geometries are kept in the finest band with a null bbox and null
    overview, do not crash, and are excluded from the dataset extent."""
    src = tmp_path / "nulls.parquet"
    dst = tmp_path / "out.parquet"
    geoms = _make_polygons(200)
    geoms[5] = None
    geoms[123] = None
    _write_gpq(src, geoms)

    summary = convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02))
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

    summary = convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02))
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
    geoms = _make_polygons(150)
    star = _invalid_star(5, 5, 4)  # large area, lands in band 0, invalid
    geoms[0] = star
    _write_gpq(src, geoms)

    convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02))

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
    convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02))

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


def test_band_and_fraction_validation(tmp_path):
    """C10, invalid band and fraction options fail fast with clear errors."""
    src = tmp_path / "plain.parquet"
    dst = tmp_path / "out.parquet"
    _write_plain(src, n=50)

    with pytest.raises(ValueError, match="bands must be at least 1"):
        convert(str(src), str(dst), ConvertOptions(bands=0))
    with pytest.raises(ValueError, match="row_group_mb must be positive"):
        convert(str(src), str(dst), ConvertOptions(row_group_mb=0))
    # Too few fractions for the band count.
    with pytest.raises(ValueError, match="band_fractions"):
        convert(str(src), str(dst), ConvertOptions(bands=4, band_fractions=[0.1]))
    # Fractions summing past 1.
    with pytest.raises(ValueError, match="sum to at most 1"):
        convert(str(src), str(dst), ConvertOptions(bands=3, band_fractions=[0.7, 0.7]))


def test_empty_bands_renumbered(tmp_path):
    """C10, a tiny dataset that would leave band 0 empty renumbers the populated
    bands so the level ladder starts at 0 and stays contiguous."""
    src = tmp_path / "tiny.parquet"
    dst = tmp_path / "out.parquet"
    # 10 features with default 3-band fractions, round(10*0.03)=0 leaves band 0 empty.
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
    _write_plain(src, n=300)
    convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02))

    out = pq.read_table(dst)
    band0 = out.filter(pa.compute.equal(out.column("band"), 0))
    bbox = band0.column("bbox").to_pylist()
    overview = shapely.from_wkb(band0.column("geom_overview").to_pylist())
    for b, ov in zip(bbox, overview, strict=True):
        oxmin, oymin, oxmax, oymax = ov.bounds
        assert b["xmin"] <= oxmin + 1e-12
        assert b["ymin"] <= oymin + 1e-12
        assert b["xmax"] >= oxmax - 1e-12
        assert b["ymax"] >= oymax - 1e-12


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

    summary = convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02))
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
    """Points ranked by a numeric attribute column put the highest values in
    band 0, and the footer records the real column name."""
    src = tmp_path / "points.parquet"
    dst = tmp_path / "out.parquet"
    rng = np.random.default_rng(7)
    n = 200
    geoms = [shapely.Point(*rng.uniform(0, 1000, 2)) for _ in range(n)]
    weight = np.arange(n, dtype=np.float64)  # id i has weight i, highest = 199
    _write_gpq(src, geoms, extra_columns={"weight": pa.array(weight)})

    summary = convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02, importance_column="weight"))
    assert summary["has_overview"] is False

    out = pq.read_table(dst)
    assert "geom_overview" not in out.column_names
    band = np.array(out.column("band").to_pylist())
    w = np.array(out.column("weight").to_pylist())
    band0_weights = set(w[band == 0].tolist())
    # round(200 * 0.03) = 6 highest weights land in band 0.
    assert band0_weights == set(range(194, 200))

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

    summary = convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02))
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

    convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02))

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
    assert ov["overview_method"] == "simplify_snap"


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
    the exact column. Large single polygons land in the coarse bands while small
    multipolygons stay in the finest band, so the exact column lists both types
    but the overview lists only Polygon."""
    src = tmp_path / "multi.parquet"
    dst = tmp_path / "out.parquet"
    geoms = _make_polygons(100, seed=5)  # large single polygons
    # Small multipolygons, tiny area, so they rank last into the finest band.
    for k in range(20):
        b = 0.05
        sq1 = shapely.Polygon([(k, 0), (k + b, 0), (k + b, b), (k, b)])
        sq2 = shapely.Polygon([(k, 1), (k + b, 1), (k + b, 1 + b), (k, 1 + b)])
        geoms.append(shapely.MultiPolygon([sq1, sq2]))
    _write_gpq(src, geoms)

    convert(str(src), str(dst), ConvertOptions(row_group_mb=0.02))

    geo = json.loads(pq.read_metadata(dst).metadata[b"geo"])
    assert geo["columns"]["geometry"]["geometry_types"] == ["MultiPolygon", "Polygon"]
    # The small multipolygons are all in the finest band (null overview), so the
    # overview column only ever holds simplified single Polygons.
    assert geo["columns"]["geom_overview"]["geometry_types"] == ["Polygon"]


def test_reconvert_overview_has_no_covering(tmp_path):
    """On re-convert, geom_overview must not inherit a stale `covering` key from
    the source geometry column's metadata, while the primary geometry keeps it."""
    src = tmp_path / "plain.parquet"
    once = tmp_path / "once.parquet"
    twice = tmp_path / "twice.parquet"
    _write_plain(src, n=200)

    convert(str(src), str(once), ConvertOptions(row_group_mb=0.02))
    # The first output already carries a covering on geometry but not on overview.
    geo_once = json.loads(pq.read_metadata(once).metadata[b"geo"])
    assert "covering" in geo_once["columns"]["geometry"]
    assert "covering" not in geo_once["columns"]["geom_overview"]

    convert(str(once), str(twice), ConvertOptions(row_group_mb=0.02))
    geo_twice = json.loads(pq.read_metadata(twice).metadata[b"geo"])
    assert "covering" in geo_twice["columns"]["geometry"]
    assert "covering" not in geo_twice["columns"]["geom_overview"]


def _poly_table(n=40):
    import shapely

    geoms = [shapely.box(i % 8, i // 8, i % 8 + 0.9, i // 8 + 0.9) for i in range(n)]
    wkb = [shapely.to_wkb(g) for g in geoms]
    return pa.table({"name": [f"f{i}" for i in range(n)], "geometry": pa.array(wkb, type=pa.binary())})


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
