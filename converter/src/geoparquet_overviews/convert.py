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

import itertools
import json
import logging
import math
import os
import re
import time
import zlib
from concurrent.futures import ThreadPoolExecutor
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

# Arrow's `binary` type carries int32 value offsets, so one contiguous `binary`
# array holds at most 2^31 - 1 bytes of payload. A WKB geometry column past that
# must use `large_binary` (int64 offsets) instead, both when materializing it on
# read and when building it on write. See `_decode_wkb` and `_geom_array`.
_MAX_BINARY_BYTES = 2**31 - 1

# Overview resolution ladder, anchored in absolute web zoom rather than a
# fraction of the extent. Each coarse band steps `_ZOOMS_PER_BAND` web zooms, a
# 4x resolution step, and band 0 is a genuine zoomed-out pixel of the whole
# extent, which is what makes a coarse band actually cheap. The band count itself
# is derived from the dataset's decode cost per screen, a screen should target at
# most `_SCREEN_BUDGET_MB` of exact geometry across a `_SCREEN_PX` square
# viewport, and the coarse ladder covers z0 up to the zoom where exact geometry
# becomes affordable. Two caps bound the ladder, `_MAX_COARSE_BANDS` keeps the
# thinning cell ids inside their bit budget, and no coarse band may serve past
# `_FINE_MAX_ZOOM - 1`, the exact band owns `_FINE_MAX_ZOOM` and beyond, so an
# overview is never written at a zoom where it would just be exact geometry
# grid-snapped.
_ZOOMS_PER_BAND = 2          # each coarse band steps 2 web zooms (a 4x resolution step)
_SCREEN_PX = 1024            # viewport side in pixels for the affordability model
_SCREEN_BUDGET_MB = 1.0      # target decoded exact geometry per screen in MB, the banding budget
_MAX_COARSE_BANDS = 9        # cap, stays within the thinning cell-id bit budget

_COARSEST_REL = 1 / 1500   # band 0 tolerance as a fraction of the larger extent span
_LADDER_FACTOR = 2.0       # each finer coarse band divides the tolerance by this (one web zoom)

# Local byte density estimation for the band-count budget. Real data clusters,
# buildings sit in cities inside a mostly empty bounding box, so the naive
# average (total bytes over the whole extent area) understates the density a
# user actually zooms into and hands the ladder too few coarse bands. Instead
# the extent is cut into a `_DENSITY_CELLS` square grid, each valid feature's
# bytes land in its bbox-centroid cell, and the budget solves against the
# byte-weighted `_DENSITY_QUANTILE` of the occupied cells' densities, the
# density the typical dense screen sees, not the empty-countryside average.
_DENSITY_CELLS = 128
_DENSITY_QUANTILE = 0.9

# Regime label threshold, average exact WKB bytes per valid feature. A building
# WKB is a few hundred bytes, a detailed coastline or admin polygon is many
# thousands, so this splits the count-heavy regime from the vertex-heavy one.
# Descriptive only, the byte-density band derivation already serves both.
_VERTEX_REGIME_BYTES = 2000

# Each coarse band snaps its overview to a quarter of its own pixel, a sub-pixel
# fraction so the snap is invisible at the zoom the band serves, while the band
# stops carrying the finer coordinate precision it never paints.
_GRID_SUBPIXEL = 4

# A coarse band needs at least this many features per group, so small datasets
# do not fragment into tiny row groups.
_MIN_COARSE_GROUP_ROWS = 1024

# Default share of features, by count, in each coarse band, largest first. Used
# only when bands == 3 and no explicit fractions are given.
_DEFAULT_BAND_FRACTIONS = [0.03, 0.27]


@dataclass
class ConvertOptions:
    # 0 derives the band count from byte density, a positive value forces it.
    bands: int = 0
    row_group_mb: float = 16.0
    # None derives a per-band overview snap grid from each band's own tolerance.
    # A set value forces that single grid on every band, overriding the per-band
    # derivation.
    overview_grid: float | None = None
    # Decoded exact geometry a screen should target, in MB, the banding budget the
    # derived band count is solved against. Lower asks for more coarse bands.
    screen_budget_mb: float = _SCREEN_BUDGET_MB
    # Target number of row groups per coarse band.
    coarse_row_groups: int = 32
    # zstd compression level for the written file. Higher is smaller and slower.
    compression_level: int = 15
    # Data page size in KB. The lever for the viewer's page-pruning granularity.
    page_size_kb: int = 128
    # Numeric column that ranks dimension-0 (point) features, descending. When
    # unset, points are ranked by grid thinning instead.
    importance_column: str | None = None
    # Wrap the WKB columns in the geoarrow.wkb extension type so pyarrow writes
    # the Parquet native GEOMETRY logical type with automatic per-row-group
    # geospatial statistics. The `geo` key is still written, dual 1.1 plus 2.0.
    native_geo: bool = True
    # Profile choice. True forces the physical bbox covering struct plus page
    # index pruning surface (Profile A). False forces it off (Profile B, lean
    # 2.0), readers prune row groups from native geospatial statistics only
    # and page-level pruning is unavailable. None (default) is adaptive: on
    # for a count-heavy regime, where many features per row group make page
    # pruning worth its cost, off for a vertex-heavy regime, where row-group
    # native statistics already capture what a covering column would add. See
    # `_detect_regime` and the resolution in `convert()`.
    bbox: bool | None = None
    # Worker threads for the overview build, the converter's slowest stage.
    # shapely's simplify, make_valid, and set_precision release the GIL, so
    # threads parallelize them nearly linearly. 0 means auto (one per core),
    # 1 forces single-threaded. Only the overview build is threaded, read and
    # write already thread inside pyarrow.
    jobs: int = 0
    # Density thin band 0 only, so it holds at most one feature per one-pixel
    # cell per geometry dimension. On by default, `--no-thin` is a debug and
    # before/after escape only, not a supported profile.
    thin: bool = True
    # Band 0's tolerance as a fraction of the larger extent span.
    coarsest_rel: float = _COARSEST_REL
    # Each finer coarse band divides the tolerance by this factor, one web
    # zoom per band.
    ladder_factor: float = _LADDER_FACTOR
    # Explicit fraction ladder overriding the derived one, one entry per
    # coarse band. None derives the ladder from `coarsest_rel` and
    # `ladder_factor` instead.
    band_fractions: list[float] | None = None


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


def _coarsest_zoom(span_x: float, span_y: float, world: float) -> int:
    """The web zoom at which the dataset's own extent first fills a `_SCREEN_PX`
    viewport, the zoom the coarsest band is anchored to. Below this zoom the whole
    extent is a speck on the map and every feature sits far below one pixel, so a
    coarse band placed there snaps every feature to nothing (a null overview) and
    just wastes row groups. Anchoring the coarsest band here instead of at world
    zoom keeps every emitted band at a zoom where its features are actually
    paintable. A world-spanning dataset resolves to the same low zoom the fixed
    ladder used (`_ZOOMS_PER_BAND`), so it is unchanged; a city-extent dataset
    starts its ladder where the city fills the screen, not where the planet
    does."""
    span = max(span_x, span_y, 1e-30)
    # Never finer than the fixed ladder's old anchor, so a world dataset keeps its
    # z2 start and stays byte-identical, and the ladder never starts below zero.
    return max(_ZOOMS_PER_BAND, _zoom_for_gsd(span / _SCREEN_PX, world))


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


def _local_byte_density(
    cx: np.ndarray, cy: np.ndarray, geom_bytes: np.ndarray, valid: np.ndarray,
    dataset_bbox: tuple[float, float, float, float], span_x: float, span_y: float,
) -> float:
    """Byte density where the bytes actually are, in bytes per CRS area unit.
    The extent is cut into a `_DENSITY_CELLS` square grid, each valid feature's
    exact WKB bytes are deposited into its bbox-centroid cell, and the returned
    density is the byte-weighted `_DENSITY_QUANTILE` over the occupied cells,
    the density the typical dense screen decodes. The naive whole-extent average
    spreads a few dense cities over an empty bounding box and understates the
    density a user actually zooms into, so the ladder would hand off to the
    unthinned exact band zooms too early and a dense-city screen would decode
    far past the budget. Uniform data reproduces the plain average. A pure
    function of the valid centroids and byte lengths over the fixed extent grid,
    so re-conversion derives the same value and stays idempotent."""
    ix = np.clip(
        ((cx[valid] - dataset_bbox[0]) / span_x * _DENSITY_CELLS).astype(np.int64),
        0, _DENSITY_CELLS - 1,
    )
    iy = np.clip(
        ((cy[valid] - dataset_bbox[1]) / span_y * _DENSITY_CELLS).astype(np.int64),
        0, _DENSITY_CELLS - 1,
    )
    cell_bytes = np.bincount(
        ix * _DENSITY_CELLS + iy, weights=geom_bytes[valid].astype(np.float64),
        minlength=_DENSITY_CELLS * _DENSITY_CELLS,
    )
    occupied = cell_bytes[cell_bytes > 0]
    if len(occupied) == 0:
        return 0.0
    cell_area = max((span_x / _DENSITY_CELLS) * (span_y / _DENSITY_CELLS), 1e-30)
    density = occupied / cell_area
    # Byte-weighted quantile, the density at which the given share of all bytes
    # lives at or below. Sorting by density and walking the cumulative byte mass
    # is exact and deterministic.
    order = np.argsort(density, kind="stable")
    cum = np.cumsum(occupied[order])
    k = int(np.searchsorted(cum, _DENSITY_QUANTILE * cum[-1]))
    return float(density[order][min(k, len(order) - 1)])


def _max_coarse_for_zoom(z_coarsest: int) -> int:
    """The most coarse bands the ladder can hold before a band would serve past
    `_FINE_MAX_ZOOM - 1`. Band b serves up to z_coarsest + _ZOOMS_PER_BAND * b,
    and the exact band owns `_FINE_MAX_ZOOM` and beyond, so an overview band at
    or past `_FINE_MAX_ZOOM` would just be exact geometry grid-snapped."""
    return max(0, (_FINE_MAX_ZOOM - 1 - z_coarsest) // _ZOOMS_PER_BAND + 1)


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


def _detect_regime(total_exact_bytes: int, n_valid: int) -> str:
    """A human-readable regime label for the footer and logs, count-heavy versus
    vertex-heavy, from the average exact bytes per valid feature. Descriptive
    only, the band derivation already adapts to both through byte density, so this
    never branches the pipeline."""
    if n_valid <= 0:
        return "empty"
    avg = total_exact_bytes / n_valid
    return "vertex" if avg >= _VERTEX_REGIME_BYTES else "count"


def _percentile_desc(metric: np.ndarray) -> np.ndarray:
    """Descending percentile rank of a cohort, 1.0 for the most important
    feature and toward 1/m for the least. The single-feature cohort scores 1.0.
    Ties rank by value, not by input order, features with an equal metric share
    a percentile (the run's smallest rank), so equal-metric features in the same
    thinning cell fall to the caller's stable_hash tie-break and the survivor
    never depends on input order, chunking, or thread count."""
    m = len(metric)
    if m == 0:
        return np.empty(0, dtype=np.float64)
    order = np.argsort(-metric, kind="stable")  # most important first
    sorted_desc = metric[order]
    # Min-rank each run of equal metrics: a run start takes its own index, every
    # tie in the run carries that start index forward (indices increase, so a
    # running maximum propagates it). Purely a function of the metric values.
    idx = np.arange(m, dtype=np.float64)
    run_start = np.empty(m, dtype=bool)
    run_start[0] = True
    run_start[1:] = sorted_desc[1:] != sorted_desc[:-1]
    minrank_sorted = np.maximum.accumulate(np.where(run_start, idx, 0.0))
    ranks = np.empty(m, dtype=np.float64)
    ranks[order] = minrank_sorted
    return 1.0 - ranks / m


def _band_edges(count: int, bands: int, fractions: list[float] | None) -> list[int]:
    """Cumulative-count band boundaries, largest first. Band 0 takes the first
    fraction of a descending-importance order, and so on. With no explicit
    fractions the 3 band case uses the tuned default, and every other band count
    derives a geometric doubling split, band b takes 2**b of the count so band 0
    stays the small coarse cohort and each finer band about doubles it. A single
    bin (bands == 1) puts everything in band 0."""
    if fractions is None and bands == 3:
        fractions = _DEFAULT_BAND_FRACTIONS
    if fractions is None:
        # Geometric doubling split, band b gets 2**b / (2**bands - 1) of the
        # count, so band 0 is the smallest cohort and each finer band doubles it.
        denom = (1 << bands) - 1
        cum = 0.0
        edges = []
        for b in range(bands - 1):
            cum += (1 << b) / denom
            edges.append(round(count * cum))
    else:
        cum = 0.0
        edges = []
        for f in fractions[: bands - 1]:
            cum += f
            edges.append(round(count * cum))
    return [0, *edges, count]


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


def _winners_per_cell(cell_id: np.ndarray, metric: np.ndarray, stable_hash: np.ndarray) -> np.ndarray:
    """Local indices of the single kept feature per occupied cell, the one with
    the highest metric, ties broken by stable_hash ascending. A total order on
    (cell_id, metric descending, stable_hash ascending), so for distinct
    geometries the survivor never depends on input order, pyarrow chunking, or
    thread count. Byte-identical duplicate geometries share the hash too and the
    stable lexsort falls back to input order between them, the surviving row's
    geometry is the same either way, only its attributes follow input order."""
    if len(cell_id) == 0:
        return np.empty(0, dtype=np.int64)
    # stable_hash is uint32 and stays positive, only metric is negated so that
    # the highest metric sorts first within a cell.
    order = np.lexsort((stable_hash, -metric, cell_id))
    sorted_cells = cell_id[order]
    first = np.empty(len(order), dtype=bool)
    first[0] = True
    first[1:] = sorted_cells[1:] != sorted_cells[:-1]
    return order[first]


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


def _representative_points_chunk(
    geoms: np.ndarray, dimensions: np.ndarray, bounds: np.ndarray, mask: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """A representative point per feature for grid thinning. Default is the bbox
    centroid. Within `mask`, lines use their length midpoint and polygons and
    collections use an on-surface point (a plain centroid can fall outside a
    concave polygon and misplace it). Any feature whose precise point is missing
    or non finite falls back to the bbox centroid. `mask` names the features that
    get the precise GEOS point, in practice every valid feature now that every
    valid feature is thinned. A pure per-feature transform, so splitting the
    input across threads and concatenating in order is identical to one call."""
    rx = (bounds[:, 0] + bounds[:, 2]) / 2
    ry = (bounds[:, 1] + bounds[:, 3]) / 2

    ln = mask & (dimensions == 1)
    if ln.any():
        px, py = _precise_xy(
            lambda g: shapely.line_interpolate_point(g, 0.5, normalized=True), geoms[ln]
        )
        ok = np.isfinite(px) & np.isfinite(py)
        idx = np.where(ln)[0][ok]
        rx[idx], ry[idx] = px[ok], py[ok]

    poly = mask & (dimensions >= 2)
    if poly.any():
        px, py = _precise_xy(shapely.point_on_surface, geoms[poly])
        ok = np.isfinite(px) & np.isfinite(py)
        idx = np.where(poly)[0][ok]
        rx[idx], ry[idx] = px[ok], py[ok]

    return rx, ry


def _precise_xy(op, geoms: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """x, y of a representative point per geometry via `op`, NaN where it is
    missing, so the caller falls back to the bbox centroid there. `point_on_surface`
    and `line_interpolate_point` can return an EMPTY point on a degenerate feature,
    and `get_x`/`get_y` raise a GEOSException on an empty point, so only the
    non-empty results are read. When the vectorized call throws, fall back per
    feature, never per chunk. A per-chunk fallback would degrade a different set
    of features depending on how the caller split the table, so the output would
    depend on `--jobs`, breaking the byte-identical invariant. Per feature, only
    the one bad geometry degrades to its bbox centroid, the same shape of
    robustness `_snap_safe` keeps on the overview path. TypeError is caught
    alongside GEOSException, shapely raises it for a geometry type `op` cannot
    take, and one such feature must not abort the conversion either."""
    n = len(geoms)
    px = np.full(n, np.nan, dtype=np.float64)
    py = np.full(n, np.nan, dtype=np.float64)
    try:
        pts = op(geoms)
        good = ~(shapely.is_empty(pts) | shapely.is_missing(pts))
        if good.any():
            px[good] = shapely.get_x(pts[good])
            py[good] = shapely.get_y(pts[good])
    except (shapely.errors.GEOSException, TypeError):
        for i, g in enumerate(geoms):
            try:
                pt = op(np.asarray([g], dtype=object))[0]
                if pt is not None and not shapely.is_empty(pt):
                    px[i] = shapely.get_x(pt)
                    py[i] = shapely.get_y(pt)
            except (shapely.errors.GEOSException, TypeError):
                pass  # this feature keeps its NaN and falls back to the centroid
    return px, py


def _representative_points(
    geoms: np.ndarray, dimensions: np.ndarray, bounds: np.ndarray, mask: np.ndarray,
    jobs: int = 1,
) -> tuple[np.ndarray, np.ndarray]:
    """`_representative_points_chunk` for the whole table, fanned out across
    threads when it helps. Now that every valid feature is thinned, the GEOS
    `point_on_surface` and `line_interpolate_point` work runs on the whole table,
    and both release the GIL, so threads parallelize them nearly linearly. The
    transform is pure per-feature, so splitting the arrays, processing each chunk,
    and concatenating in order is byte-identical to a single call."""
    workers = jobs if jobs > 0 else (os.cpu_count() or 1)
    n = len(geoms)
    if workers <= 1 or n <= 1:
        return _representative_points_chunk(geoms, dimensions, bounds, mask)
    nchunks = min(n, workers * 4)
    geom_parts = np.array_split(geoms, nchunks)
    dim_parts = np.array_split(dimensions, nchunks)
    bound_parts = np.array_split(bounds, nchunks)
    mask_parts = np.array_split(mask, nchunks)
    with ThreadPoolExecutor(max_workers=workers) as ex:
        parts = list(ex.map(
            _representative_points_chunk, geom_parts, dim_parts, bound_parts, mask_parts,
        ))
    rx = np.concatenate([p[0] for p in parts])
    ry = np.concatenate([p[1] for p in parts])
    return rx, ry


def _thin_points(
    cx: np.ndarray, cy: np.ndarray, mask: np.ndarray, bands: int, span: float,
    dataset_bbox: tuple[float, float, float, float],
    coarsest_rel: float = _COARSEST_REL, ladder_factor: float = _LADDER_FACTOR,
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
    tolerances = _overview_tolerances(bands, span, coarsest_rel, ladder_factor)
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
    coarsest_rel: float = _COARSEST_REL, ladder_factor: float = _LADDER_FACTOR,
) -> tuple[np.ndarray, str, str, np.ndarray]:
    """Rank features into importance bands per geometry dimension, largest first.

    Dimension 2 (polygons) ranks by area, scaled by cos(latitude) on a
    geographic CRS. Dimension 1 (lines) ranks by length. Dimension 0 (points)
    ranks by a numeric attribute column when one is named, otherwise by grid
    thinning. In a mixed layer each dimension cohort is turned into a percentile
    rank within its cohort and the metric cohorts are then banded on the merged
    percentile, so a global band fraction still holds and an extent-spanning
    line can reach band 0 alongside large polygons. Thinned points get their
    band directly from thinning, which replaces fraction banding for them.

    Returns the band per feature, the honest `importance` string, the
    `overview_method` (`thin` for a pure-point dataset, else `simplify_snap`),
    and the per-feature percentile `score`, NaN where a feature is not metric
    ranked (a thinned point, or null/empty), which the band-0 density thinning
    reuses as its per-cohort-comparable survivor metric.
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
            tb = _thin_points(cx, cy, m0, bands, span, dataset_bbox, coarsest_rel, ladder_factor)
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
    return band, importance, overview_method, score


def _overview_tolerances(
    bands: int, span: float,
    coarsest_rel: float = _COARSEST_REL, ladder_factor: float = _LADDER_FACTOR,
) -> dict[int, float]:
    """Simplify tolerance and thinning cell size per coarse band, in the data's
    own units, extent relative rather than zoom anchored. Band 0 resolves at
    `coarsest_rel` of `span`, the larger of the dataset's own x and y extent,
    and each finer coarse band divides that tolerance by `ladder_factor`, one
    geometric ladder for every band count."""
    return {
        b: span * coarsest_rel / (ladder_factor ** b)
        for b in range(bands - 1)
    }


def _overview_grids(
    bands: int, span: float, coarsest_rel: float, ladder_factor: float,
    override: float | None,
) -> dict[int, float]:
    """Snap grid per coarse band, in the data's own units. Each band snaps to a
    fraction of its own tolerance (a quarter of its pixel), so a coarse band
    carries only the coordinate precision it actually paints, not the global
    fine grid it never shows. A single `override` forces the same grid on
    every band, the escape hatch for `--overview-grid`."""
    tol = _overview_tolerances(bands, span, coarsest_rel, ladder_factor)
    if override is not None:
        return {b: override for b in tol}
    return {b: tol[b] / _GRID_SUBPIXEL for b in tol}


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


def _quad_fallback(src: np.ndarray, grid: float, tol: float) -> np.ndarray:
    """A small grid-aligned quad per feature, for polygon survivors whose shape
    collapses below their band's pixel. A coarse band's survivor stands for its
    whole cell (its `overview_count` says for how many features), so writing
    NULL when the shape is subpixel erases the survivor from the preview
    entirely. On a buildings dataset at a country zoom that is every survivor,
    and the whole first paint comes out blank. The quad keeps the survivor a
    polygon, the same idiom as Tippecanoe's tiny-polygon reduction, which
    replaces subpixel polygons with small squares rather than dropping them.
    The square is centred on the feature's representative point and sized by
    the feature's own area, side `sqrt(area)` clamped between one snap-grid
    cell and the band pixel, so larger features paint larger. Centre and half
    side snap to the half-grid lattice, so the corners land on grid multiples
    and compress like every other snapped coordinate. The quad extends at most
    half the band pixel beyond the feature's own bbox, which the coarse-band
    covering padding accounts for. A feature whose quad cannot be built stays
    None. Guarded per feature on failure so one bad geometry degrades alone,
    the same shape of robustness as `_snap_safe`."""
    out = np.full(len(src), None, dtype=object)
    half_grid = grid / 2.0
    max_cells = max(1, round(tol / grid))

    def _quads(geoms: np.ndarray) -> np.ndarray:
        pts = shapely.point_on_surface(geoms)
        good = ~(shapely.is_missing(pts) | shapely.is_empty(pts))
        quads = np.full(len(geoms), None, dtype=object)
        if not good.any():
            return quads
        cx = np.round(shapely.get_x(pts[good]) / half_grid) * half_grid
        cy = np.round(shapely.get_y(pts[good]) / half_grid) * half_grid
        area = shapely.area(geoms[good])
        area = np.where(np.isfinite(area), np.maximum(area, 0.0), 0.0)
        cells = np.clip(np.round(np.sqrt(area) / grid), 1, max_cells)
        half = cells * half_grid
        quads[good] = shapely.box(cx - half, cy - half, cx + half, cy + half)
        return quads

    try:
        quads = _quads(src)
        ok = np.array([q is not None for q in quads], dtype=bool)
        if ok.any():
            out[ok] = shapely.to_wkb(quads[ok])
    except (shapely.errors.GEOSException, TypeError):
        for i, g in enumerate(src):
            try:
                q = _quads(np.asarray([g], dtype=object))[0]
                if q is not None:
                    out[i] = shapely.to_wkb(q)
            except (shapely.errors.GEOSException, TypeError):
                pass  # this feature keeps its None
    return out


def _segment_fallback(src: np.ndarray, grid: float) -> np.ndarray:
    """A short line segment per feature, for line survivors whose simplified
    geometry comes out empty. The segment runs through the feature's bbox
    centre along the bbox diagonal, the line's own dominant direction, with a
    minimum length of one snap-grid cell so it stays paintable, so a line
    survivor stays a line, never a point. Built from the bbox alone, no GEOS
    calls that can throw, and a feature with no finite bbox stays None. This
    path is rare, a line's topology-preserving simplify almost never empties,
    it exists so the ladder never writes NULL for a paintable survivor."""
    out = np.full(len(src), None, dtype=object)
    b = shapely.bounds(src)
    mx = (b[:, 0] + b[:, 2]) / 2
    my = (b[:, 1] + b[:, 3]) / 2
    dx = b[:, 2] - b[:, 0]
    dy = b[:, 3] - b[:, 1]
    ln = np.hypot(dx, dy)
    ux = np.where(ln > 0, dx / np.maximum(ln, 1e-300), 1.0)
    uy = np.where(ln > 0, dy / np.maximum(ln, 1e-300), 0.0)
    half = np.maximum(ln, grid) / 2
    finite = np.isfinite(mx) & np.isfinite(my) & np.isfinite(half)
    for i in np.nonzero(finite)[0]:
        seg = shapely.LineString([
            (mx[i] - ux[i] * half[i], my[i] - uy[i] * half[i]),
            (mx[i] + ux[i] * half[i], my[i] + uy[i] * half[i]),
        ])
        out[i] = shapely.to_wkb(seg)
    return out


def _overview_values(src: np.ndarray, dims: np.ndarray, tol: float, grid: float) -> np.ndarray:
    """Per-dimension overview WKB for one coarse band, each dimension keeping
    its own kind. Polygons and collections simplify plus grid snap, falling
    back to a small area-sized quad (see `_quad_fallback`) when the shape
    collapses below the band pixel, so a polygon survivor always paints as a
    polygon. Lines simplify plus snap with a collapse guard, falling back to
    the simplified unsnapped line, then to a short oriented segment (see
    `_segment_fallback`), so a line survivor always paints as a line. Points
    copy their exact geometry, which is already minimal. Only a feature whose
    fallback also fails is written as NULL, never empty WKB. Returns an object
    array of WKB bytes with None where nothing could be written. A pure
    per-feature transform, safe to chunk across threads."""
    out = np.full(len(src), None, dtype=object)

    # Points and multipoints, copy the exact geometry verbatim.
    pt = dims == 0
    if pt.any():
        out[pt] = shapely.to_wkb(src[pt])

    # Lines, simplify plus snap, fall back to the simplified unsnapped geometry
    # when the snap collapses the line to empty, so a short line is never
    # written as empty WKB, and to the representative point when even that is
    # empty.
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
        if still_empty.any():
            wkb[still_empty] = _segment_fallback(line_src[still_empty], grid)
        out[ln] = wkb

    # Polygons and higher-dimension collections, repair, simplify plus snap,
    # a small area-sized quad when the shape collapses below the band pixel.
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
        if degenerate.any():
            wkb[degenerate] = _quad_fallback(p[degenerate], grid, tol)
        out[poly] = wkb
    return out


def _overview_band(
    src: np.ndarray, dims: np.ndarray, tol: float, grid: float, jobs: int
) -> np.ndarray:
    """`_overview_values` for one coarse band, fanned out across `jobs` threads
    when it helps. shapely's simplify, make_valid, and set_precision release the
    GIL, so threads give a near-linear speedup on this, the converter's slowest
    stage. The overview is a pure per-feature transform, so splitting the band,
    processing each chunk, and concatenating in order is identical to one call.

    Chunk count is oversubscribed past the worker count on purpose. A band can be
    a handful of whole-country multipolygons that each cost seconds, so equal row
    splits would strand most threads on the one enormous chunk. More, smaller
    chunks let the pool balance the load. The chunks stay large enough that the
    vectorized GEOS work dominates the thread hand-off."""
    n = len(src)
    if jobs <= 1 or n <= 1:
        return _overview_values(src, dims, tol, grid)
    nchunks = min(n, jobs * 4)
    src_parts = np.array_split(src, nchunks)
    dim_parts = np.array_split(dims, nchunks)
    with ThreadPoolExecutor(max_workers=jobs) as ex:
        parts = ex.map(
            _overview_values, src_parts, dim_parts,
            itertools.repeat(tol), itertools.repeat(grid),
        )
        return np.concatenate(list(parts))


def _build_overview(
    geoms: np.ndarray, band: np.ndarray, dimensions: np.ndarray, bands: int,
    span: float, coarsest_rel: float, ladder_factor: float, grids: dict[int, float],
    geom_bytes: np.ndarray, jobs: int = 1,
) -> tuple[np.ndarray, dict[int, float], dict[int, float]]:
    """Build the overview WKB for every coarse band feature, per its dimension,
    NULL for the finest band. Each coarse band snaps to its own grid from
    `grids`, so a coarse band carries only the coordinate precision it paints.
    Returns a WKB object array, the tolerance used per band, and the grid used
    per band, and logs the byte shrink per band, the core of the preview payoff.

    Invalid rings are repaired with `make_valid` on this overview path only, so
    one bowtie polygon cannot abort the conversion. The exact `geometry` column
    is never touched, which is the project invariant."""
    tolerances = _overview_tolerances(bands, span, coarsest_rel, ladder_factor)
    out = np.full(len(geoms), None, dtype=object)
    for b, tol in tolerances.items():
        mask = band == b
        count = int(mask.sum())
        if count == 0:
            continue
        grid = grids[b]
        wkb = _overview_band(geoms[mask], dimensions[mask], tol, grid, jobs)
        exact_bytes = int(geom_bytes[mask].sum())
        ov_bytes = int(sum(len(w) for w in wkb if w is not None))
        shrink = 100 * (1 - ov_bytes / exact_bytes) if exact_bytes else 0.0
        log.info(
            "  band %d overview: %d features, tol=%.4g grid=%.4g, exact %.2f MB -> overview %.2f MB (%.0f%% smaller)",
            b, count, tol, grid, exact_bytes / 1e6, ov_bytes / 1e6, shrink,
        )
        out[mask] = wkb
    return out, tolerances, grids


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


def _decode_wkb(column: pa.ChunkedArray) -> np.ndarray:
    """Decode a WKB geometry column to a shapely geometry array, one chunk at a
    time. Each row-group chunk is already under Arrow's 2 GB `binary` limit, so
    decoding chunk by chunk and concatenating the results never fuses the column
    into a single int32-offset `binary` array. `combine_chunks()` would, and
    overflows once the total WKB payload exceeds `_MAX_BINARY_BYTES`. Handles
    both plain WKB storage and the geoarrow.wkb extension storage a re-converted
    native file carries, unwrapping the extension to its binary storage first."""
    parts = []
    for chunk in column.chunks:
        if isinstance(chunk, pa.ExtensionArray):
            chunk = chunk.storage
        parts.append(shapely.from_wkb(chunk.to_numpy(zero_copy_only=False)))
    if not parts:
        return np.empty(0, dtype=object)
    return parts[0] if len(parts) == 1 else np.concatenate(parts)


def _wkb_extension_type(native: bool, crs: object, crs_present: bool, large: bool):
    """The geoarrow.wkb extension type carrying the source CRS, or None when
    native types are disabled. pyarrow 21+ converts this to the Parquet
    GEOMETRY logical type and computes GeospatialStatistics on write. `large`
    selects `ga.large_wkb()` (large_binary storage) over `ga.wkb()` (binary),
    which must match the storage array it wraps, a binary extension over a
    large_binary array miswrites its offsets."""
    if not native:
        return None
    import geoarrow.pyarrow as ga

    gtype = ga.large_wkb() if large else ga.wkb()
    if crs_present and crs is not None:
        gtype = gtype.with_crs(json.dumps(crs) if isinstance(crs, dict) else str(crs))
    return gtype


def _validate_options(opts: ConvertOptions) -> None:
    """Fail fast on option combinations that would otherwise crash deep in the
    pipeline or silently produce a broken layout."""
    if opts.bands < 0:
        raise ValueError(f"bands must be 0 (derive) or a positive count, got {opts.bands}")
    # A forced count shares the derived path's cap. Past it the coarsest bands'
    # per-band cell underflows the band-0 thinning grid's bit budget, the np.clip in
    # _thin_band0 collapses every cell into one and silently mis-thins, and an
    # extreme value underflows the tolerance to 0 or overflows _overview_tolerances.
    if opts.bands > _MAX_COARSE_BANDS + 1:
        raise ValueError(
            f"bands must be at most {_MAX_COARSE_BANDS + 1} "
            f"({_MAX_COARSE_BANDS} coarse plus the exact band), got {opts.bands}"
        )
    if opts.screen_budget_mb <= 0:
        raise ValueError(f"screen_budget_mb must be positive, got {opts.screen_budget_mb}")
    if opts.row_group_mb <= 0:
        raise ValueError(f"row_group_mb must be positive, got {opts.row_group_mb}")
    if opts.coarse_row_groups < 1:
        raise ValueError(f"coarse_row_groups must be at least 1, got {opts.coarse_row_groups}")
    if opts.jobs < 0:
        raise ValueError(f"jobs must be 0 (auto) or a positive count, got {opts.jobs}")
    if opts.overview_grid is not None and opts.overview_grid <= 0:
        raise ValueError(f"overview_grid must be positive, got {opts.overview_grid}")
    if opts.compression_level < 1:
        raise ValueError(f"compression_level must be at least 1, got {opts.compression_level}")
    if opts.page_size_kb < 1:
        raise ValueError(f"page_size_kb must be at least 1, got {opts.page_size_kb}")
    if opts.bbox is False and not opts.native_geo:
        raise ValueError("--no-bbox requires native geo types, there would be no pruning surface at all")


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
    geoms = _decode_wkb(table.column(geom_col))
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

    # Serialize the exact WKB once, up front, before banding. Its per-feature
    # byte lengths drive both the finest band's byte budget and the per-band
    # overview shrink log, and a crc32 of each feature's own bytes is the density
    # thinning tie-break. A content hash, never Python's salted hash or row
    # order, so the same geometry always hashes the same and re-conversion stays
    # idempotent. Null geometries serialize to None and hash to 0, they never
    # enter a coarse band so the value is moot.
    geom_wkb = shapely.to_wkb(geoms)
    stable_hash = np.fromiter(
        (zlib.crc32(w) if w is not None else 0 for w in geom_wkb),
        dtype=np.uint32, count=len(geom_wkb),
    )
    # Per-feature exact WKB byte lengths, also computed once up front. Null rows
    # serialize to None and contribute 0 bytes. The total drives the byte-density
    # band derivation below (which runs before the sort), and the array is
    # reordered alongside geom_wkb so the finest band's byte budget and the
    # per-band overview shrink log reuse it without a post-sort recompute.
    geom_bytes = np.fromiter(
        (len(w) if w is not None else 0 for w in geom_wkb),
        dtype=np.int64, count=len(geom_wkb),
    )

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
    # The single extent-relative span the tolerance ladder anchors to, the
    # larger of the two axes, so a tall or wide extent still gets one
    # consistent band 0 tolerance.
    span = max(span_x, span_y)
    log.info("extent %.4g x %.4g units", span_x, span_y)

    # The coarsest band's anchor zoom, where the dataset extent fills the screen.
    # The whole coarse ladder steps up from here, so a sub-world dataset never
    # emits coarse bands below its own visible range. A world dataset anchors at
    # the fixed ladder's old start, so it is unchanged. This single value drives
    # the band count, the per-band tolerances, and the per-band snap grids, so
    # they all stay consistent.
    z_coarsest = _coarsest_zoom(span_x, span_y, world)

    # bbox centroids, reused for the local density estimate, cos-latitude area
    # scaling, point thinning, and the Hilbert minor sort. Null and empty
    # geometries have NaN centroids.
    cx = (bounds[:, 0] + bounds[:, 2]) / 2
    cy = (bounds[:, 1] + bounds[:, 3]) / 2

    # Derive the band count from local byte density, unless a positive --bands
    # overrides it. Byte density captures both feature count and geometry
    # complexity, so dense small features and a few huge polygons both get the
    # band count they need from one formula, and the local (byte-weighted
    # quantile over an extent grid) estimate keeps clustered data honest, the
    # ladder covers the zooms a dense city needs, not just the empty-countryside
    # average. The coarse count is the number of `ladder_factor` halvings from
    # the coarsest tolerance (`span * coarsest_rel`) down to `gsd_fine`, the
    # tolerance at which a screen of exact geometry meets the byte budget, plus
    # one exact band. `regime` is a descriptive label only, it reports which
    # regime the file is, it never branches the pipeline.
    n_valid = int(valid.sum())
    total_exact_bytes = int(geom_bytes.sum())
    regime = _detect_regime(total_exact_bytes, n_valid)
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
    byte_density = _local_byte_density(
        cx, cy, geom_bytes, valid, dataset_bbox, span_x, span_y
    )
    avg_density = total_exact_bytes / max(span_x * span_y, 1e-30)
    log.info(
        "local byte density %.3g B/unit^2 (whole-extent average %.3g, %.1fx clustering)",
        byte_density, avg_density, byte_density / avg_density if avg_density > 0 else 0.0,
    )
    bands = opts.bands if opts.bands else _derive_bands(
        byte_density, span, opts.coarsest_rel, opts.ladder_factor,
        opts.screen_budget_mb * 1_000_000,
    )
    # A forced --bands is still held to the zoom ceiling, an overview band at or
    # past _FINE_MAX_ZOOM would just be exact geometry grid-snapped.
    max_bands = _max_coarse_for_zoom(z_coarsest) + 1
    if bands > max_bands:
        log.warning(
            "clamping %d bands to %d, the ladder from coarsest zoom %d may not "
            "serve an overview past zoom %d",
            bands, max_bands, z_coarsest, _FINE_MAX_ZOOM - 1,
        )
        bands = max_bands
    log.info(
        "using %d bands (%s) anchored at coarsest zoom %d, regime %r",
        bands, "manual override" if opts.bands else "derived from local byte density",
        z_coarsest, regime,
    )

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

    # Merge empty bands. A tiny dataset can leave a coarse band with no features,
    # which would make `levels` start above 0. Renumber the populated bands to a
    # contiguous 0..k-1 so the level ladder always starts at the coarsest band.
    present = np.unique(band)
    populated = len(present)
    if populated < bands:
        log.info(
            "merging %d empty band(s), renumbering %d populated bands to 0..%d",
            bands - populated, populated, populated - 1,
        )
    bands = populated
    # searchsorted maps each surviving band ordinal down to its contiguous index.
    # A no-op when no band was empty, since present is already 0..bands-1.
    band = np.searchsorted(present, band).astype(np.int16)
    for b in range(bands):
        n = int((band == b).sum())
        role = "coarse preview" if b == 0 else ("exact detail" if b == bands - 1 else "mid zoom")
        log.info("  band %d: %d features (%.1f%%), %s", b, n, 100 * n / len(band), role)

    # A single-band file has no coarse bands, so nothing was simplified, snapped,
    # or meaningfully thinned. The footer must describe what the writer actually
    # did, so the method is `none`, the file is plain exact GeoParquet with the
    # sort and the footer block only.
    if bands == 1:
        overview_method = "none"

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

    # Drop the source geometry and any pre-existing overview columns before the
    # reorder. It keeps re-converting the converter's own output idempotent (no
    # duplicated `band`, `geom_overview`, or stale `geometry`), and it keeps the
    # exact WKB, already decoded into `geoms` above, out of the `take`. Carrying
    # a >2 GB WKB column through `take` would fuse it into a single int32-offset
    # `binary` array and overflow, and the reordered copy is discarded here
    # anyway. Nothing reads these columns off `table` after the decode above.
    drop = [geom_col]
    for c in ("geometry", "geom_overview", "band", "bbox", "overview_count"):
        if c in table.column_names and c not in drop:
            drop.append(c)
    if len(drop) > 1:
        log.info("dropping pre-existing overview columns before rewrite, %s", drop)
    table = table.drop_columns(drop)

    # A geometry-only input drops to zero passthrough columns above. `take` on a
    # zero-column table resets its row count to 0, and the later append_column
    # calls then fail on a length mismatch, so skip the reorder when there is
    # nothing to reorder. drop_columns already preserved the row count and the
    # first appended column re-establishes the length for the rest.
    if table.num_columns:
        table = table.take(pa.array(sort_idx))
    geoms = geoms[sort_idx]
    bounds = bounds[sort_idx]
    band = band[sort_idx]
    valid = valid[sort_idx]
    dimensions = dimensions[sort_idx]
    geom_wkb = geom_wkb[sort_idx]
    geom_bytes = geom_bytes[sort_idx]
    survivor_counts = survivor_counts[sort_idx]
    log.info("sorted band-major, Hilbert within each band")

    # Per-band overview snap grid, a pure function of the final band count and
    # the extent-relative tolerance ladder, so re-conversion stays
    # byte-identical idempotent. Each coarse band snaps to a quarter of its own
    # pixel, unless `--overview-grid` forces a single grid on every band.
    band_grids = _overview_grids(bands, span, opts.coarsest_rel, opts.ladder_factor, opts.overview_grid)

    # A pure-point dataset carries no overview column, its banding (thinning or
    # attribute rank) is the level of detail. Everything else builds an overview.
    if overview_method == "thin":
        log.info("point dataset, no overview column, banding is the level of detail")
        overview_wkb = np.full(len(geoms), None, dtype=object)
        band_tol = _overview_tolerances(bands, span, opts.coarsest_rel, opts.ladder_factor)
        has_overview = False
    else:
        jobs = opts.jobs if opts.jobs > 0 else (os.cpu_count() or 1)
        log.info("building overview column across %d thread(s)", jobs)
        overview_wkb, band_tol, band_grids = _build_overview(
            geoms, band, dimensions, bands, span, opts.coarsest_rel, opts.ladder_factor,
            band_grids, geom_bytes, jobs,
        )
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

    # The source geometry and any pre-existing overview columns were already
    # dropped before the sort above, so `table` now holds only the passthrough
    # attribute columns, ready for the rebuilt geometry, bbox, band, and overview.

    # The overview can leave a feature's exact-geometry bbox two ways.
    # set_precision snapping moves vertices up to grid/2 outward, and the quad
    # fallback centres an up-to-one-pixel square on the representative point,
    # extending up to half the band tolerance beyond the bbox. Pad each coarse
    # band's covering by the larger of the two so a viewer pruning on bbox
    # never drops a feature still painted in the overview. Both are per-band,
    # so a coarser band pads more than a finer one, and the max keeps a forced
    # `--overview-grid` coarser than the tolerance covered too. The finest,
    # exact band is untouched, and null and empty geometries are never padded.
    for b in range(bands - 1):
        m = valid & (band == b)
        if not m.any():
            continue
        pad = (max(band_tol.get(b, 0.0), band_grids[b]) if has_overview else band_grids[b]) / 2
        bounds[m, 0] -= pad
        bounds[m, 1] -= pad
        bounds[m, 2] += pad
        bounds[m, 3] += pad

    # Per-band extents for `levels[].extent`, computed from the padded bounds so
    # they enclose the overview geometry too. A band of only null geometries
    # gets a null extent.
    band_extents: dict[int, list[float] | None] = {}
    for b in range(bands):
        m = valid & (band == b)
        band_extents[b] = (
            [float(np.min(bounds[m, 0])), float(np.min(bounds[m, 1])),
             float(np.max(bounds[m, 2])), float(np.max(bounds[m, 3]))]
            if m.any() else None
        )

    def _geom_array(values: np.ndarray) -> pa.Array:
        # Plain `binary` (int32 offsets) unless the column's total WKB would
        # overflow it, then `large_binary` (int64). Small outputs stay on binary
        # exactly as before, a multi-GB exact-geometry column writes without a
        # 32-bit offset overflow. The extension type must match the storage, so
        # `large` selects `ga.large_wkb()` over `ga.wkb()`.
        total = int(sum(len(v) for v in values if v is not None))
        large = total > _MAX_BINARY_BYTES
        storage = pa.array(values, type=pa.large_binary() if large else pa.binary())
        gtype = _wkb_extension_type(
            opts.native_geo, crs if crs_present else None, crs_present, large
        )
        return gtype.wrap_array(storage) if gtype is not None else storage

    table = table.append_column("geometry", _geom_array(geom_wkb))
    if bbox_enabled:
        table = table.append_column("bbox", _bbox_struct(bounds, valid))
    table = table.append_column("band", pa.array(band, type=pa.int16()))
    if has_overview:
        table = table.append_column("geom_overview", _geom_array(overview_wkb))

    # The density signal thinning would otherwise destroy. Each coarse-band
    # survivor records how many features, itself included, competed for its
    # one-pixel cell, so a viewer can scale the survivor's symbol and a dense
    # cluster stays distinguishable from sparse coverage. Null on the finest
    # band (exact, never thinned) and on invalid rows. Only written when
    # thinning ran and coarse bands exist, a single-band file has no survivors
    # to weight. Pure-point files carry it too, density matters most there.
    has_counts = opts.thin and bands > 1
    if has_counts:
        count_vals = survivor_counts.astype(np.int64)
        count_null = (band == bands - 1) | ~valid | (count_vals <= 0)
        table = table.append_column(
            "overview_count",
            pa.array(
                np.where(count_null, 0, count_vals), type=pa.int32(),
                mask=count_null,
            ),
        )

    base_levels = []
    prev_zoom = -1
    for b in sorted(band_rg_end):
        gsd = band_tol.get(b, 0.0) if b < bands - 1 else 0.0
        # min_zoom is the coarsest web zoom this band starts serving, the natural
        # pair to max_zoom. Read the cursor before max_zoom advances it, so band 0
        # is 0 and each later band opens one past the previous band's max_zoom.
        min_zoom = prev_zoom + 1
        max_zoom = _zoom_for_gsd(gsd, world) if b < bands - 1 else _FINE_MAX_ZOOM
        max_zoom = max(max_zoom, prev_zoom + 1)  # keep the ladder strictly increasing
        prev_zoom = max_zoom
        # The per-band snap grid, positional origin and cell_size in CRS units. The
        # finest exact band has no overview and no snap grid, so its grid is null.
        # `set_precision` snaps to a lattice anchored at coordinate zero, not at
        # the dataset extent, so the origin is [0, 0], a consumer reconstructing
        # the lattice must snap from zero, not from the band or dataset corner.
        g = band_grids.get(b)
        grid = (
            {"origin": [0.0, 0.0], "cell_size": [g, g]}
            if b < bands - 1 and g is not None else None
        )
        base_levels.append({
            "level": b, "row_group_end": band_rg_end[b],
            "min_zoom": min_zoom, "max_zoom": max_zoom, "gsd": gsd,
            "grid": grid, "feature_count": int((band == b).sum()),
            "extent": band_extents.get(b),
        })

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
            covering=bbox_enabled,
        ),
    }

    levels: list[dict] = []

    def _late_kv(rg_ranges: list[tuple[int, int]]) -> dict[str, str]:
        # Stamp each level with the byte range of its row-group run, known only
        # after the row groups are written. Ranges are [start, end) file offsets.
        prev_end = -1
        for lvl in base_levels:
            first_rg = prev_end + 1
            lvl["bytes"] = [rg_ranges[first_rg][0], rg_ranges[lvl["row_group_end"]][1]]
            prev_end = lvl["row_group_end"]
        levels.extend(base_levels)
        return {
            "overviews": footer.overviews_meta(
                "hilbert", base_levels, has_overview,
                importance=importance, overview_method=overview_method,
                regime=regime, covering=bbox_enabled,
                count_column="overview_count" if has_counts else None,
            ),
        }

    # C16, verify the plan covers every row before we write anything, not after.
    if sum(plan) != table.num_rows:
        raise ValueError(f"row group plan covers {sum(plan)} of {table.num_rows} rows")

    t = time.perf_counter()
    log.info("writing %s with zstd, page index, byte-stream-split doubles, declared sorting", dst)
    _write(table, dst, plan, kv, opts, late_kv=_late_kv)
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
        "regime": regime,
        "bbox": bbox_enabled,
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


def _write(
    table: pa.Table, dst: str, plan: list[int], kv: dict[str, str],
    opts: ConvertOptions, late_kv=None,
) -> None:
    """Write with everything the DuckDB writer cannot do, the Page Index,
    BYTE_STREAM_SPLIT on doubles, declared sorting_columns, adaptive row groups,
    and the exact footer key values.

    `late_kv`, when given, is called once all row groups are written with the
    `(start, end)` byte range of each row group in write order. It returns
    footer keys, such as `overviews`, whose per-level byte ranges are only
    knowable after the bytes have actually landed. Those keys are added via
    `add_key_value_metadata` right before close, so they are the only source
    of that key, no duplicate stale copy survives from the schema metadata.
    """
    # Exact-key filter, so unrelated keys like `geoarrow` or a user's own
    # `geometry_source` survive instead of being stripped by a `geo` prefix.
    reserved = {b"geo", b"overviews"}
    meta = {k: v for k, v in (table.schema.metadata or {}).items() if k not in reserved}
    meta.update({k.encode(): v.encode() for k, v in kv.items()})
    table = table.replace_schema_metadata(meta)

    names = table.column_names
    bbox_doubles = (
        ["bbox.xmin", "bbox.ymin", "bbox.xmax", "bbox.ymax"] if "bbox" in names else []
    )
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
    # leaves (added via bbox_doubles), so exclude the parent name itself. When
    # the geometry columns are extension typed, include them here too, since
    # geospatial statistics are only computed when the writer computes
    # statistics for the column.
    geo_native = any(
        isinstance(table.schema.field(n).type, pa.ExtensionType)
        for n in ("geometry", "geom_overview") if n in names
    )
    excluded = ("bbox",) if geo_native else ("geometry", "geom_overview", "bbox")
    stats_cols = [n for n in names if n not in excluded] + bbox_doubles
    # Resolve `band` to its physical leaf index. The `bbox` struct flattens into
    # four leaves, so a top-level column index would point at the wrong column.
    sorting = (
        list(pq.SortingColumn.from_ordering(table.schema, [("band", "ascending")]))
        if "band" in names
        else None
    )

    with open(dst, "wb") as sink:
        writer = pq.ParquetWriter(
            sink,
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
        rg_ranges: list[tuple[int, int]] = []
        offset = 0
        for rows in plan:
            start = sink.tell()
            writer.write_table(table.slice(offset, rows), row_group_size=rows)
            rg_ranges.append((start, sink.tell()))
            offset += rows
        if late_kv is not None:
            writer.add_key_value_metadata(late_kv(rg_ranges))
        writer.close()
