"""The converter, any GeoParquet in, one GeoParquet with overviews out.

The whole idea in one file. Read a GeoParquet, sort its features by importance
(largest first), add one small simplified overview column for the coarse
features, cut row groups by byte budget along the importance bands, and write
the two footer blocks. The exact geometry is never touched, so a SQL engine
reads the same authoritative data it always did, while a browser can fetch a
tiny overview prefix first.

It is CRS aware. The source coordinate reference system is preserved, and the
overview simplification is derived from the dataset extent, so the same code
works whether the coordinates are lon and lat degrees or projected metres.

Every stage logs what it does through the `geoparquet_overviews` logger, so an
operator or an agent can see the ranking, the per-band overview shrink, the row
group plan, and the final preview cost. The CLI turns this on by default.
"""

from __future__ import annotations

import json
import logging
import math
import re
import time
from dataclasses import dataclass

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import shapely

from . import footer

log = logging.getLogger("geoparquet_overviews")

# Web-map ground resolution model, gsd(z) = world / (256 * 2**z). Used only to
# turn a simplification tolerance into a web zoom hint for `levels[].max_zoom`.
# The world unit is the whole-globe span in the data's own units, degrees for a
# geographic CRS and the Web Mercator circumference for a metre CRS.
_WORLD_DEG = 360.0
_WORLD_M = 2 * math.pi * 6378137.0
_FINE_MAX_ZOOM = 24

# Overview resolution ladder, expressed as a fraction of the dataset's larger
# extent span. Unit-agnostic, identical in degrees or metres. Band 0 is the
# coarse whole-extent preview and always resolves at `_COARSEST_REL` of the span,
# and every finer coarse band divides the tolerance by `_LADDER_FACTOR`. One
# extent-relative geometric ladder for every band count, so `--bands 2` keeps the
# same strong band 0 preview as `--bands 3` instead of a far weaker one.
_COARSEST_REL = 1 / 1500
_LADDER_FACTOR = 4.0
_GRID_REL = 1 / 60000

# Default share of features, by count, in each coarse band. Largest first.
_DEFAULT_BAND_FRACTIONS = [0.03, 0.27]

# A coarse band needs at least this many features per group, so small datasets
# do not fragment into tiny row groups.
_MIN_COARSE_GROUP_ROWS = 1024


@dataclass
class ConvertOptions:
    bands: int = 3
    row_group_mb: float = 16.0
    # None means derive the overview snap grid from the dataset extent.
    overview_grid: float | None = None
    band_fractions: list[float] | None = None
    # Target number of row groups per coarse band.
    coarse_row_groups: int = 32
    # zstd compression level for the written file. Higher is smaller and slower.
    compression_level: int = 15
    # Data page size in KB. The lever for the viewer's page-pruning granularity.
    page_size_kb: int = 128
    # Numeric column that ranks dimension-0 (point) features, descending. When
    # unset, points are ranked by grid thinning instead.
    importance_column: str | None = None


def _find_geometry_column(schema: pa.Schema) -> str:
    """Resolve the primary geometry column from the `geo` footer block, else
    fall back to a column literally named `geometry`."""
    meta = schema.metadata or {}
    raw = meta.get(b"geo")
    if raw:
        try:
            primary = json.loads(raw).get("primary_column")
            if primary and primary in schema.names:
                return primary
        except ValueError:
            log.warning("ignoring a malformed `geo` footer block, it is not valid JSON")
    if "geometry" in schema.names:
        return "geometry"
    raise ValueError("no geometry column found, expected a `geo` footer block or a `geometry` column")


def _source_column_meta(schema: pa.Schema, geom_col: str) -> dict:
    """Read the source column's own `geo` entry so every field it carries, `crs`,
    `edges`, `orientation`, `epoch` and the like, can be preserved. Returns the
    raw dict, or an empty dict when there is no `geo` block for this column."""
    meta = schema.metadata or {}
    raw = meta.get(b"geo")
    if not raw:
        return {}
    try:
        col = json.loads(raw).get("columns", {}).get(geom_col, {})
    except ValueError:
        return {}
    return col if isinstance(col, dict) else {}


def _importance_values(table: pa.Table, column: str | None) -> np.ndarray | None:
    """Read the numeric attribute column that ranks point features, aligned to
    the source row order. Null entries become negative infinity, the least
    important. Returns None when no column was named."""
    if column is None:
        return None
    if column not in table.column_names:
        raise ValueError(f"--importance-column {column!r} not found in the input")
    values = table.column(column).combine_chunks().to_pylist()
    try:
        out = np.array(
            [float(v) if v is not None else -np.inf for v in values], dtype=np.float64
        )
    except (TypeError, ValueError):
        raise ValueError(f"--importance-column {column!r} must be numeric") from None
    return out


# Known geographic (lon and lat degree) CRS codes. Not exhaustive, but it covers
# the common datums so their `max_zoom` is derived against a 360 degree world,
# not a 40 million metre one. EPSG numeric codes and OGC CRS short codes.
_GEOGRAPHIC_CODES = {
    "4326", "4269", "4258", "4267", "4283", "4617", "4674", "4759",
    "4152", "4171", "4173", "4190", "4230", "4312", "4322", "4324",
    "crs84", "crs83", "crs27", "crs84h", "crs83h",
}


def _crs_code(crs: str) -> str | None:
    """Extract a comparable authority code from a CRS string. Handles `EPSG:4326`,
    `urn:ogc:def:crs:EPSG::4326`, an OpenGIS URL, `OGC:CRS84`, and a bare code."""
    s = crs.strip()
    m = re.search(r"\bCRS(\d{2,3})H?\b", s, re.IGNORECASE)
    if m:
        suffix = "h" if s[m.end() - 1] in "Hh" else ""
        return "crs" + m.group(1) + suffix
    m = re.search(r"EPSG[:/]{1,2}(?:0/)?(\d{3,6})", s, re.IGNORECASE)
    if m:
        return m.group(1)
    if s.isdigit():
        return s
    return None


def _projjson_is_geographic(crs: dict) -> bool | None:
    """Inspect a PROJJSON dict. Returns True or False when it can decide, else
    None. Handles a `GeographicCRS` wrapped inside a `CompoundCRS` or a
    `BoundCRS`, and falls back to the coordinate system axis unit."""
    ctype = str(crs.get("type", ""))
    if "Geographic" in ctype:
        return True
    if "Projected" in ctype:
        return False
    if ctype == "CompoundCRS":
        for comp in crs.get("components", []):
            if isinstance(comp, dict):
                inner = _projjson_is_geographic(comp)
                if inner is not None:
                    return inner
    if ctype == "BoundCRS":
        base = crs.get("source_crs")
        if isinstance(base, dict):
            return _projjson_is_geographic(base)
    cs = crs.get("coordinate_system")
    if isinstance(cs, dict):
        for axis in cs.get("axis", []):
            if not isinstance(axis, dict):
                continue
            unit = axis.get("unit")
            name = unit if isinstance(unit, str) else unit.get("name", "") if isinstance(unit, dict) else ""
            low = str(name).lower()
            if "degree" in low:
                return True
            if "metre" in low or "meter" in low or "foot" in low or "feet" in low:
                return False
    return None


def _pyproj_is_geographic(crs: object) -> bool | None:
    """Authoritative check when pyproj is installed. Optional, never a hard
    dependency. Returns None when pyproj is absent or cannot parse the value."""
    try:
        from pyproj import CRS as _PyprojCRS
    except ImportError:
        return None
    try:
        user_input = json.dumps(crs) if isinstance(crs, dict) else crs
        return bool(_PyprojCRS.from_user_input(user_input).is_geographic)
    except Exception:
        return None


def _is_geographic(present: bool, crs: object) -> bool:
    """True when coordinates are lon and lat degrees. An absent or null CRS is
    treated as the CRS84 default. Prefers pyproj when installed, otherwise
    inspects a PROJJSON dict or matches a known geographic authority code."""
    if not present or crs is None:
        return True
    resolved = _pyproj_is_geographic(crs)
    if resolved is not None:
        return resolved
    if isinstance(crs, dict):
        inner = _projjson_is_geographic(crs)
        return bool(inner)
    if isinstance(crs, str):
        code = _crs_code(crs)
        if code is not None:
            return code.lower() in _GEOGRAPHIC_CODES
        return "CRS84" in crs.upper() or "CRS83" in crs.upper()
    return True


def _zoom_for_gsd(gsd: float, world: float) -> int:
    """The coarsest web zoom a band of ground sample distance `gsd` should
    paint, from gsd(z) = world / (256 * 2**z). Metre CRS coordinates are assumed
    to be in metres, the near-universal case for projected data."""
    if gsd <= 0:
        return _FINE_MAX_ZOOM
    return max(0, round(math.log2(world / (256 * gsd))))


def _hilbert_distance(x: np.ndarray, y: np.ndarray, order: int = 16) -> np.ndarray:
    """Hilbert curve distance for integer grid coordinates in [0, 2**order).
    Vectorized over all features. Keeps spatial neighbors adjacent in the sort
    so bbox row group statistics stay selective."""
    n = 1 << order
    x = x.astype(np.int64).copy()
    y = y.astype(np.int64).copy()
    d = np.zeros(len(x), dtype=np.int64)
    s = n >> 1
    while s > 0:
        rx = ((x & s) > 0).astype(np.int64)
        ry = ((y & s) > 0).astype(np.int64)
        d += s * s * ((3 * rx) ^ ry)
        swap = ry == 0
        flip = swap & (rx == 1)
        x[flip] = (n - 1) - x[flip]
        y[flip] = (n - 1) - y[flip]
        xs = x[swap].copy()
        x[swap] = y[swap]
        y[swap] = xs
        s >>= 1
    return d


def _band_edges(count: int, bands: int, fractions: list[float] | None) -> list[int]:
    """Cumulative-count band boundaries, largest first. Band 0 takes the first
    fraction of a descending-importance order, and so on."""
    if fractions is None:
        fractions = _DEFAULT_BAND_FRACTIONS if bands == 3 else None
    if fractions is None:
        # Equal count split when no explicit fractions and not the 3 band default.
        edges = [round(count * (i + 1) / bands) for i in range(bands - 1)]
    else:
        cum = 0.0
        edges = []
        for f in fractions[: bands - 1]:
            cum += f
            edges.append(round(count * cum))
    return [0, *edges, count]


def _percentile_desc(metric: np.ndarray) -> np.ndarray:
    """Descending percentile rank of a cohort, 1.0 for the most important
    feature and 1/m for the least. The single-feature cohort scores 1.0, so an
    extent-spanning line can reach band 0 alongside the largest polygons when
    cohorts are merged by percentile."""
    m = len(metric)
    if m == 0:
        return np.empty(0, dtype=np.float64)
    order = np.argsort(-metric, kind="stable")  # most important first
    ranks = np.empty(m, dtype=np.float64)
    ranks[order] = np.arange(m, dtype=np.float64)
    return 1.0 - ranks / m


def _band_by_fraction(score: np.ndarray, bands: int, fractions: list[float] | None) -> np.ndarray:
    """Cut a set of features into bands by descending score and the cumulative
    band fractions. Band 0 is the highest score."""
    m = len(score)
    order = np.argsort(-score, kind="stable")
    band = np.empty(m, dtype=np.int16)
    edges = _band_edges(m, bands, fractions)
    for b in range(bands):
        band[order[edges[b] : edges[b + 1]]] = b
    return band


def _thin_points(
    cx: np.ndarray, cy: np.ndarray, mask: np.ndarray, bands: int, span: float,
    dataset_bbox: tuple[float, float, float, float],
) -> np.ndarray:
    """Spatially stratify points into bands by grid representativeness, instead
    of a fraction of file order. For each coarse band from coarsest to finest,
    lay that band's snap grid over the extent (the overview tolerance ladder is
    the cell size) and a point becomes the representative of its cell at the
    coarsest band where the cell has no representative yet. Remaining points
    fall to the finest band. Returns a full-length band array, non-masked rows
    left at the finest band."""
    n = len(cx)
    band = np.full(n, bands - 1, dtype=np.int16)
    idx = np.where(mask)[0]
    if len(idx) == 0:
        return band
    x0, y0 = dataset_bbox[0], dataset_bbox[1]
    assigned = np.zeros(len(idx), dtype=bool)
    tolerances = _overview_tolerances(bands, span)
    for b in sorted(tolerances):  # coarsest (largest cell) first
        cell = tolerances[b]
        remaining = np.where(~assigned)[0]  # positions within idx
        if len(remaining) == 0:
            break
        gi = idx[remaining]
        ix = np.floor((cx[gi] - x0) / cell).astype(np.int64)
        iy = np.floor((cy[gi] - y0) / cell).astype(np.int64)
        key = ix * (1 << 32) + iy
        _, first = np.unique(key, return_index=True)  # first point per occupied cell
        reps = remaining[first]
        band[idx[reps]] = b
        assigned[reps] = True
    return band


def _assign_bands(
    dimensions: np.ndarray, area: np.ndarray, length: np.ndarray, valid: np.ndarray,
    cx: np.ndarray, cy: np.ndarray, bands: int, fractions: list[float] | None,
    importance_values: np.ndarray | None, importance_column: str | None,
    span: float, dataset_bbox: tuple[float, float, float, float], geographic: bool,
) -> tuple[np.ndarray, str, str]:
    """Rank features into importance bands per geometry dimension, largest first.

    Dimension 2 (polygons) ranks by area, scaled by cos(latitude) on a
    geographic CRS. Dimension 1 (lines) ranks by length. Dimension 0 (points)
    ranks by a numeric attribute column when one is named, otherwise by grid
    thinning. In a mixed layer each dimension cohort is turned into a percentile
    rank within its cohort and the metric cohorts are then banded on the merged
    percentile, so a global band fraction still holds and an extent-spanning
    line can reach band 0 alongside large polygons. Thinned points get their
    band directly from thinning, which replaces fraction banding for them.

    Returns the band per feature, the honest `importance` string, and the
    `overview_method` (`thin` for a pure-point dataset, else `simplify_snap`).
    """
    n = len(dimensions)
    band = np.full(n, bands - 1, dtype=np.int16)
    present = {int(d) for d in np.unique(dimensions[valid])}
    is_mixed = len(present) > 1

    if importance_values is not None and 0 not in present:
        log.warning(
            "importance column %r only applies to point features, dataset has none, ignored",
            importance_column,
        )

    # Metric percentile per cohort, merged and banded by fraction. NaN means the
    # feature is not metric-ranked (a thinned point, or null/empty).
    score = np.full(n, np.nan, dtype=np.float64)
    thinned = False

    if 2 in present:
        m2 = (dimensions == 2) & valid
        a = area[m2].astype(np.float64)
        if geographic:
            a = a * np.cos(np.radians(np.clip(cy[m2], -89.9, 89.9)))
        score[m2] = _percentile_desc(a)
    if 1 in present:
        m1 = (dimensions == 1) & valid
        score[m1] = _percentile_desc(length[m1].astype(np.float64))
    if 0 in present:
        m0 = (dimensions == 0) & valid
        if importance_values is not None:
            score[m0] = _percentile_desc(importance_values[m0].astype(np.float64))
        else:
            thinned = True
            tb = _thin_points(cx, cy, m0, bands, span, dataset_bbox)
            band[m0] = tb[m0]

    scored = ~np.isnan(score)
    if scored.any():
        band[scored] = _band_by_fraction(score[scored], bands, fractions)

    if is_mixed:
        importance = "mixed_quantile_desc"
    elif present == {2}:
        importance = "area_desc"
    elif present == {1}:
        importance = "length_desc"
    elif present == {0}:
        importance = "grid_thin" if thinned else f"attribute:{importance_column}"
    else:
        importance = "mixed_quantile_desc"

    # A dataset that is entirely points carries no overview column, its banding
    # is the level of detail. Everything else derives a simplified overview.
    overview_method = "thin" if present == {0} else "simplify_snap"
    return band, importance, overview_method


def _overview_tolerances(bands: int, span: float) -> dict[int, float]:
    """Simplify tolerance per coarse band, in the data's own units. One
    extent-relative geometric ladder for every band count. Band 0 resolves at
    `_COARSEST_REL` of the span and each finer coarse band divides the tolerance
    by `_LADDER_FACTOR`."""
    return {b: span * _COARSEST_REL / (_LADDER_FACTOR ** b) for b in range(bands - 1)}


def _snap_safe(geoms: np.ndarray, grid: float) -> np.ndarray:
    """`set_precision` grid snap, robust to GEOS topology errors. Real-world
    polygons (holes touching shells, near-degenerate rings) can make GEOS throw
    `TopologyException` from `set_precision`, and the call is vectorized, so one
    bad feature would abort the whole band. Snap the batch at once, and only when
    that throws fall back to snapping each feature on its own, keeping the
    unsnapped input where the snap still fails. The overview stays valid, just
    unsnapped for that rare feature, and the exact `geometry` is never touched."""
    try:
        return shapely.set_precision(geoms, grid_size=grid)
    except shapely.errors.GEOSException:
        out = geoms.copy()
        for i, g in enumerate(geoms):
            try:
                out[i] = shapely.set_precision(g, grid_size=grid)
            except shapely.errors.GEOSException:
                out[i] = g
        return out


def _overview_values(src: np.ndarray, dims: np.ndarray, tol: float, grid: float) -> np.ndarray:
    """Per-dimension overview WKB for one coarse band. Polygons and collections
    simplify plus grid snap, and a result that is empty or degenerate is written
    as NULL, never empty WKB. Lines simplify plus snap and fall back to the
    simplified unsnapped geometry when the snap collapses them to empty. Points
    copy their exact geometry, which is already minimal. Returns an object array
    of WKB bytes with None where a result is degenerate."""
    out = np.full(len(src), None, dtype=object)

    # Points and multipoints, copy the exact geometry verbatim.
    pt = dims == 0
    if pt.any():
        out[pt] = shapely.to_wkb(src[pt])

    # Lines, simplify plus snap, fall back to the simplified unsnapped geometry
    # when the snap collapses the line to empty, so a short line is never
    # written as empty WKB.
    ln = dims == 1
    if ln.any():
        line_src = src[ln]
        simplified = shapely.simplify(line_src, tolerance=tol, preserve_topology=True)
        snapped = _snap_safe(simplified, grid)
        collapsed = shapely.is_missing(snapped) | shapely.is_empty(snapped)
        final = snapped.copy()
        final[collapsed] = simplified[collapsed]
        wkb = shapely.to_wkb(final)
        still_empty = shapely.is_missing(final) | shapely.is_empty(final)
        wkb[still_empty] = None
        out[ln] = wkb

    # Polygons and higher-dimension collections, repair, simplify plus snap,
    # NULL when the result is empty or degenerate.
    poly = dims >= 2
    if poly.any():
        p = src[poly].copy()
        invalid = ~shapely.is_valid(p)
        if invalid.any():
            p[invalid] = shapely.make_valid(p[invalid])
        simplified = shapely.simplify(p, tolerance=tol, preserve_topology=True)
        snapped = _snap_safe(simplified, grid)
        wkb = shapely.to_wkb(snapped)
        degenerate = shapely.is_missing(snapped) | shapely.is_empty(snapped)
        wkb[degenerate] = None
        out[poly] = wkb
    return out


def _build_overview(
    geoms: np.ndarray, band: np.ndarray, dimensions: np.ndarray, bands: int,
    span: float, grid: float, geom_bytes: np.ndarray,
) -> tuple[np.ndarray, dict[int, float]]:
    """Build the overview WKB for every coarse band feature, per its dimension,
    NULL for the finest band. Returns a WKB object array and the tolerance used
    per band, and logs the byte shrink per band, the core of the preview payoff.

    Invalid rings are repaired with `make_valid` on this overview path only, so
    one bowtie polygon cannot abort the conversion. The exact `geometry` column
    is never touched, which is the project invariant."""
    tolerances = _overview_tolerances(bands, span)
    out = np.full(len(geoms), None, dtype=object)
    for b, tol in tolerances.items():
        mask = band == b
        count = int(mask.sum())
        if count == 0:
            continue
        wkb = _overview_values(geoms[mask], dimensions[mask], tol, grid)
        exact_bytes = int(geom_bytes[mask].sum())
        ov_bytes = int(sum(len(w) for w in wkb if w is not None))
        shrink = 100 * (1 - ov_bytes / exact_bytes) if exact_bytes else 0.0
        log.info(
            "  band %d overview: %d features, tol=%.4g grid=%.4g, exact %.2f MB -> overview %.2f MB (%.0f%% smaller)",
            b, count, tol, grid, exact_bytes / 1e6, ov_bytes / 1e6, shrink,
        )
        out[mask] = wkb
    return out, tolerances


def _plan_row_groups(
    band: np.ndarray, geom_bytes: np.ndarray, budget: int, bands: int, coarse_row_groups: int
) -> tuple[list[int], dict[int, int]]:
    """Plan the row groups band by band, always cutting at a band boundary.

    The band array is band-major sorted, so each band is one contiguous run. The
    finest band is cut by accumulated exact geometry bytes to a byte budget. Each
    coarse band is instead split into near-equal chunks up to coarse_row_groups
    groups. Because features are Hilbert-ordered within a band, near-equal chunks
    are spatially tight, so a low-zoom viewport prunes them by bounding box.
    Returns the row count per group and each band's last group index.
    """
    plan: list[int] = []
    band_rg_end: dict[int, int] = {}
    n = len(band)
    start = 0
    while start < n:
        b = int(band[start])
        end = start
        while end < n and int(band[end]) == b:
            end += 1
        run_len = end - start
        if b == bands - 1:
            # Finest, exact band, cut by the exact geometry byte budget.
            cur = 0
            cur_bytes = 0
            for nbytes in geom_bytes[start:end].tolist():
                if cur > 0 and cur_bytes >= budget:
                    plan.append(cur)
                    cur = 0
                    cur_bytes = 0
                cur += 1
                cur_bytes += nbytes
            plan.append(cur)
        else:
            # Coarse band, split into near-equal spatially tight chunks.
            k = min(coarse_row_groups, max(1, run_len // _MIN_COARSE_GROUP_ROWS))
            base = run_len // k
            rem = run_len % k
            for i in range(k):
                plan.append(base + 1 if i < rem else base)
        band_rg_end[b] = len(plan) - 1
        start = end
    return plan, band_rg_end


def _bbox_struct(bounds: np.ndarray, valid: np.ndarray | None = None) -> pa.Array:
    """A `bbox` struct column of four doubles, the covering the footer declares.
    Rows where `valid` is False get a null struct, so null and empty geometries
    carry a null bbox instead of a NaN one that would poison row group pruning."""
    fields = [pa.array(bounds[:, i], type=pa.float64()) for i in range(4)]
    mask = None if valid is None else pa.array(~valid)
    return pa.StructArray.from_arrays(
        fields, names=["xmin", "ymin", "xmax", "ymax"], mask=mask,
    )


def _validate_options(opts: ConvertOptions) -> None:
    """Fail fast on option combinations that would otherwise crash deep in the
    pipeline or silently produce a broken layout."""
    if opts.bands < 1:
        raise ValueError(f"bands must be at least 1, got {opts.bands}")
    if opts.row_group_mb <= 0:
        raise ValueError(f"row_group_mb must be positive, got {opts.row_group_mb}")
    if opts.coarse_row_groups < 1:
        raise ValueError(f"coarse_row_groups must be at least 1, got {opts.coarse_row_groups}")
    if opts.overview_grid is not None and opts.overview_grid <= 0:
        raise ValueError(f"overview_grid must be positive, got {opts.overview_grid}")
    if opts.compression_level < 1:
        raise ValueError(f"compression_level must be at least 1, got {opts.compression_level}")
    if opts.page_size_kb < 1:
        raise ValueError(f"page_size_kb must be at least 1, got {opts.page_size_kb}")
    if opts.band_fractions is not None:
        fr = opts.band_fractions
        if any(f < 0 for f in fr):
            raise ValueError(f"band_fractions must all be non negative, got {fr}")
        if len(fr) < opts.bands - 1:
            raise ValueError(
                f"need at least bands minus 1 = {opts.bands - 1} band_fractions, got {len(fr)}"
            )
        if sum(fr[: opts.bands - 1]) > 1.0 + 1e-9:
            raise ValueError(f"the first {opts.bands - 1} band_fractions must sum to at most 1, got {fr}")


def convert(src: str, dst: str, opts: ConvertOptions | None = None) -> dict:
    """Convert a GeoParquet file into the overviews layout. Returns a small
    summary of what was written and logs every stage as it runs."""
    opts = opts or ConvertOptions()
    _validate_options(opts)
    t0 = time.perf_counter()

    log.info("reading %s", src)
    table = pq.read_table(src)
    geom_col = _find_geometry_column(table.schema)
    log.info(
        "read %d rows, %d columns in %.1fs, geometry column %r",
        table.num_rows, table.num_columns, time.perf_counter() - t0, geom_col,
    )
    if table.num_rows == 0:
        raise ValueError("input has no rows, nothing to convert")

    source_column = _source_column_meta(table.schema, geom_col)
    encoding = source_column.get("encoding", "WKB")
    if encoding != "WKB":
        raise ValueError(
            f"geometry column {geom_col!r} uses encoding {encoding!r}, only WKB is supported. "
            "Native GeoArrow encodings are not supported."
        )
    crs_present = "crs" in source_column
    crs = source_column.get("crs")
    geographic = _is_geographic(crs_present, crs)
    world = _WORLD_DEG if geographic else _WORLD_M
    crs_label = "CRS84 lon/lat (default)" if not crs_present else _crs_label(crs)
    log.info(
        "source CRS: %s, treated as %s",
        crs_label, "geographic degrees" if geographic else "projected metres",
    )

    importance_values = _importance_values(table, opts.importance_column)

    t = time.perf_counter()
    geoms = shapely.from_wkb(table.column(geom_col).combine_chunks().to_numpy(zero_copy_only=False))
    bounds = shapely.bounds(geoms)  # (n, 4) xmin ymin xmax ymax
    area = shapely.area(geoms)
    length = shapely.length(geoms)
    dimensions = shapely.get_dimensions(geoms)  # 0 point, 1 line, 2 area, -1 null/empty

    # Segregate null and empty geometries up front. They are legal in GeoParquet
    # but have no extent, area, or overview, so we exclude them from the dataset
    # extent (via nanmin/nanmax on their NaN bounds), carry them with a null bbox
    # and null overview, and pin them into the finest band.
    valid = ~(shapely.is_missing(geoms) | shapely.is_empty(geoms))
    n_missing = int((~valid).sum())
    if n_missing:
        log.info(
            "segregating %d null or empty geometries into the finest band with a null bbox and overview",
            n_missing,
        )
    if not valid.any():
        raise ValueError("input has no non-empty geometries, cannot compute a dataset extent")
    # Degenerate zero area geometries (points, lines) still rank, just last.
    area = np.where(np.isfinite(area), area, 0.0)
    length = np.where(np.isfinite(length), length, 0.0)
    log.info("decoded %d geometries and computed area+length+bounds in %.1fs", len(geoms), time.perf_counter() - t)

    # The dataset extent, computed before banding so point thinning can lay its
    # grid over it. NaN bounds of null and empty geometries are excluded with
    # nanmin/nanmax. Antimeridian-crossing features get a world-spanning bbox
    # here, a known limitation, they widen the extent and weaken Hilbert placement.
    dataset_bbox = (
        float(np.nanmin(bounds[:, 0])),
        float(np.nanmin(bounds[:, 1])),
        float(np.nanmax(bounds[:, 2])),
        float(np.nanmax(bounds[:, 3])),
    )
    span_x = max(dataset_bbox[2] - dataset_bbox[0], 1e-12)
    span_y = max(dataset_bbox[3] - dataset_bbox[1], 1e-12)
    span = max(span_x, span_y)
    grid = opts.overview_grid if opts.overview_grid is not None else span * _GRID_REL
    log.info("extent %.4g x %.4g units, overview snap grid %.4g", span_x, span_y, grid)

    # bbox centroids, reused for cos-latitude area scaling, point thinning, and
    # the Hilbert minor sort. Null and empty geometries have NaN centroids.
    cx = (bounds[:, 0] + bounds[:, 2]) / 2
    cy = (bounds[:, 1] + bounds[:, 3]) / 2

    band, importance, overview_method = _assign_bands(
        dimensions, area, length, valid, cx, cy, opts.bands, opts.band_fractions,
        importance_values, opts.importance_column, span, dataset_bbox, geographic,
    )
    # Pin null and empty geometries into the finest, exact band.
    band[~valid] = opts.bands - 1
    log.info("ranked by importance %r, overview method %r", importance, overview_method)

    # Merge empty bands. A tiny dataset can leave a coarse band with no features,
    # which would make `levels` start above 0. Renumber the populated bands to a
    # contiguous 0..k-1 so the level ladder always starts at the coarsest band.
    present = np.unique(band)
    bands = len(present)
    if bands < opts.bands:
        log.info(
            "merging %d empty band(s), renumbering %d populated bands to 0..%d",
            opts.bands - bands, bands, bands - 1,
        )
        band = np.searchsorted(present, band).astype(np.int16)
    for b in range(bands):
        n = int((band == b).sum())
        role = "coarse preview" if b == 0 else ("exact detail" if b == bands - 1 else "mid zoom")
        log.info("  band %d: %d features (%.1f%%), %s", b, n, 100 * n / len(band), role)

    # Hilbert minor sort on the bbox centroids quantized over the dataset extent.
    # Null and empty geometries have NaN centroids, park them at the extent origin
    # so quantization stays finite, their order within the finest band is moot.
    cxh = np.where(np.isfinite(cx), cx, dataset_bbox[0])
    cyh = np.where(np.isfinite(cy), cy, dataset_bbox[1])
    order = 16
    n = (1 << order) - 1
    qx = np.clip(((cxh - dataset_bbox[0]) / span_x * n).astype(np.int64), 0, n)
    qy = np.clip(((cyh - dataset_bbox[1]) / span_y * n).astype(np.int64), 0, n)
    hilbert = _hilbert_distance(qx, qy, order)

    sort_idx = np.lexsort((hilbert, band))  # band major, hilbert minor
    table = table.take(pa.array(sort_idx))
    geoms = geoms[sort_idx]
    bounds = bounds[sort_idx]
    band = band[sort_idx]
    valid = valid[sort_idx]
    dimensions = dimensions[sort_idx]
    log.info("sorted band-major, Hilbert within each band")

    # Serialize the exact WKB once. Its per-feature byte lengths drive both the
    # finest band's byte budget and the per-band overview shrink log line.
    geom_wkb = shapely.to_wkb(geoms)
    geom_bytes = np.array([len(w) if w is not None else 0 for w in geom_wkb], dtype=np.int64)

    # A pure-point dataset carries no overview column, its banding (thinning or
    # attribute rank) is the level of detail. Everything else builds an overview.
    if overview_method == "thin":
        log.info("point dataset, no overview column, banding is the level of detail")
        overview_wkb = np.full(len(geoms), None, dtype=object)
        band_tol = _overview_tolerances(bands, span)
        has_overview = False
    else:
        log.info("building overview column")
        overview_wkb, band_tol = _build_overview(geoms, band, dimensions, bands, span, grid, geom_bytes)
        has_overview = any(v is not None for v in overview_wkb)

    budget = int(opts.row_group_mb * 1_000_000)
    plan, band_rg_end = _plan_row_groups(band, geom_bytes, budget, bands, opts.coarse_row_groups)
    log.info(
        "planned %d row groups at a %.1f MB budget, band last-row-group ends %s",
        len(plan), opts.row_group_mb, {b: band_rg_end[b] for b in sorted(band_rg_end)},
    )
    log.info(
        "coarse bands split into up to %d groups each so a low zoom view prunes by bounding box",
        opts.coarse_row_groups,
    )

    # Assemble the output columns. Drop the source geometry and any pre-existing
    # overview columns so re-converting the converter's own output is idempotent
    # instead of duplicating `band`, `geom_overview`, or a stale `geometry`.
    drop = [geom_col]
    for c in ("geometry", "geom_overview", "band", "bbox"):
        if c in table.column_names and c not in drop:
            drop.append(c)
    if len(drop) > 1:
        log.info("dropping pre-existing overview columns before rewrite, %s", drop)
    table = table.drop_columns(drop)

    # set_precision snapping can move overview vertices up to grid/2 outward, so a
    # coarse-band feature's overview pixel can leave its exact-geometry bbox. Pad
    # the coarse-band covering by grid/2 so a viewer pruning on bbox never drops a
    # feature still painted in the overview. The finest, exact band is untouched.
    coarse = valid & (band < bands - 1)
    pad = grid / 2
    bounds[coarse, 0] -= pad
    bounds[coarse, 1] -= pad
    bounds[coarse, 2] += pad
    bounds[coarse, 3] += pad

    table = table.append_column("geometry", pa.array(geom_wkb, type=pa.binary()))
    table = table.append_column("bbox", _bbox_struct(bounds, valid))
    table = table.append_column("band", pa.array(band, type=pa.int16()))
    if has_overview:
        table = table.append_column("geom_overview", pa.array(overview_wkb, type=pa.binary()))

    levels = []
    prev_zoom = -1
    for b in sorted(band_rg_end):
        gsd = band_tol.get(b, 0.0) if b < bands - 1 else 0.0
        max_zoom = _zoom_for_gsd(gsd, world) if b < bands - 1 else _FINE_MAX_ZOOM
        max_zoom = max(max_zoom, prev_zoom + 1)  # keep the ladder strictly increasing
        prev_zoom = max_zoom
        levels.append({"level": b, "row_group_end": band_rg_end[b], "max_zoom": max_zoom, "gsd": gsd})

    type_names = _geometry_type_names(geoms)
    # Recompute the overview column's own types from its WKB, since simplify can
    # drop a feature to a lower dimensional type than the exact column.
    overview_type_names = _geometry_type_names_from_wkb(overview_wkb) if has_overview else None

    kv = {
        "geo": footer.geo_meta(
            dataset_bbox, type_names, has_overview,
            crs=crs if crs_present else footer._NO_CRS,
            source_column=source_column,
            overview_geometry_types=overview_type_names,
        ),
        "overviews": footer.overviews_meta(
            "hilbert", levels, has_overview,
            importance=importance, overview_method=overview_method,
        ),
    }

    # C16, verify the plan covers every row before we write anything, not after.
    if sum(plan) != table.num_rows:
        raise ValueError(f"row group plan covers {sum(plan)} of {table.num_rows} rows")

    t = time.perf_counter()
    log.info("writing %s with zstd, page index, byte-stream-split doubles, declared sorting", dst)
    _write(table, dst, plan, kv, opts)
    log.info("wrote in %.1fs", time.perf_counter() - t)

    # The preview payoff, what a lowest-zoom read touches versus a full scan.
    total_geom_mb = int(geom_bytes.sum()) / 1e6
    band0_ov_mb = (
        sum(len(overview_wkb[i]) for i in np.nonzero(band == 0)[0] if overview_wkb[i]) / 1e6
        if has_overview else 0.0
    )
    if has_overview and band0_ov_mb > 0:
        log.info(
            "preview cost: band 0 overview ~%.2f MB vs full exact geometry %.2f MB (%.0fx less to first paint)",
            band0_ov_mb, total_geom_mb, total_geom_mb / band0_ov_mb,
        )
    log.info("done in %.1fs total", time.perf_counter() - t0)

    return {
        "features": table.num_rows,
        "row_groups": len(plan),
        "bands": bands,
        "has_overview": has_overview,
        "crs_preserved": crs_present,
        "geographic": geographic,
        "levels": levels,
    }


def _crs_label(crs: object) -> str:
    """A short human label for a source CRS value, for logging only."""
    if isinstance(crs, dict):
        cid = crs.get("id")
        if isinstance(cid, dict):
            return f"{cid.get('authority')}:{cid.get('code')} {crs.get('name', '')}".strip()
        return str(crs.get("name", "PROJJSON"))
    if crs is None:
        return "null (unknown)"
    return str(crs)


def _geometry_type_names(geoms: np.ndarray) -> list[str]:
    """Distinct GeoParquet geometry type names for a set of geometries. The map
    follows the GEOS type ids shapely reports, Point 0, LineString 1,
    LinearRing 2, Polygon 3, MultiPoint 4, MultiLineString 5, MultiPolygon 6,
    GeometryCollection 7. A standalone LinearRing has no GeoParquet type, so it
    is reported as the closest valid one, LineString."""
    ids = {int(t) for t in shapely.get_type_id(geoms)}
    names = {
        0: "Point",
        1: "LineString",
        2: "LineString",
        3: "Polygon",
        4: "MultiPoint",
        5: "MultiLineString",
        6: "MultiPolygon",
        7: "GeometryCollection",
    }
    return sorted({names[i] for i in ids if i in names})


def _geometry_type_names_from_wkb(wkb: np.ndarray) -> list[str]:
    """Geometry type names recomputed from the overview WKB, since simplify plus
    snap can drop a feature to a lower dimensional type than the exact column."""
    present = [w for w in wkb if w is not None]
    if not present:
        return []
    return _geometry_type_names(shapely.from_wkb(present))


def _write(table: pa.Table, dst: str, plan: list[int], kv: dict[str, str], opts: ConvertOptions) -> None:
    """Write with everything the DuckDB writer cannot do, the Page Index,
    BYTE_STREAM_SPLIT on doubles, declared sorting_columns, adaptive row groups,
    and the exact footer key values."""
    # Exact-key filter, so unrelated keys like `geoarrow` or a user's own
    # `geometry_source` survive instead of being stripped by a `geo` prefix.
    reserved = {b"geo", b"overviews"}
    meta = {k: v for k, v in (table.schema.metadata or {}).items() if k not in reserved}
    meta.update({k.encode(): v.encode() for k, v in kv.items()})
    table = table.replace_schema_metadata(meta)

    names = table.column_names
    bbox_doubles = ["bbox.xmin", "bbox.ymin", "bbox.xmax", "bbox.ymax"]
    float_cols = [
        n for n in names if pa.types.is_floating(table.schema.field(n).type)
    ]
    byte_split = bbox_doubles + float_cols
    dict_cols = [
        n
        for n in names
        if pa.types.is_string(table.schema.field(n).type)
        or pa.types.is_large_string(table.schema.field(n).type)
    ]
    # `bbox` is a struct parent, statistics are meaningful only on its four
    # leaves (added via bbox_doubles), so exclude the parent name itself.
    stats_cols = [n for n in names if n not in ("geometry", "geom_overview", "bbox")] + bbox_doubles
    # Resolve `band` to its physical leaf index. The `bbox` struct flattens into
    # four leaves, so a top-level column index would point at the wrong column.
    sorting = (
        list(pq.SortingColumn.from_ordering(table.schema, [("band", "ascending")]))
        if "band" in names
        else None
    )

    writer = pq.ParquetWriter(
        dst,
        table.schema,
        compression="zstd",
        compression_level=opts.compression_level,
        write_page_index=True,
        data_page_size=opts.page_size_kb * 1024,
        use_dictionary=dict_cols or False,
        use_byte_stream_split=byte_split,
        write_statistics=stats_cols,
        sorting_columns=sorting,
    )
    offset = 0
    for rows in plan:
        writer.write_table(table.slice(offset, rows), row_group_size=rows)
        offset += rows
    writer.close()
