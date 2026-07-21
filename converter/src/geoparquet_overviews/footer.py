"""Footer metadata builders.

Two blocks go in the Parquet footer. `geo` is the standard GeoParquet 1.1 block
every reader already understands. `overviews` is the small additive block this
project proposes, a top-level key parallel to `geo` that a zoom aware client
reads to fetch a preview first. A reader that does not know `overviews` simply
ignores it and still sees a valid GeoParquet file.
"""

import json

# The bbox covering, the portable pruning surface. Points at a struct column
# named `bbox` with four double children. Every plain Parquet reader can prune
# row groups on these min and max statistics.
COVERING = {
    "bbox": {
        "xmin": ["bbox", "xmin"],
        "ymin": ["bbox", "ymin"],
        "xmax": ["bbox", "xmax"],
        "ymax": ["bbox", "ymax"],
    }
}


# Sentinel so a caller can distinguish "no crs given, use the spec default
# CRS84" from "the source explicitly carried a crs value" (which may be a
# PROJJSON dict, or null for an unknown CRS). Both are preserved verbatim.
_NO_CRS = object()


def geo_meta(
    dataset_bbox: tuple[float, float, float, float],
    geometry_types: list[str],
    has_overview: bool,
    crs: object = _NO_CRS,
    source_column: dict | None = None,
    overview_geometry_types: list[str] | None = None,
    covering: bool = True,
) -> str:
    """GeoParquet 1.1.0 metadata with the bbox covering.

    The source CRS is preserved. When `crs` is left as the default the key is
    omitted, which per the spec means OGC:CRS84 (lon and lat). When the source
    carried an explicit `crs`, that exact value is written back onto both the
    exact and the overview geometry columns, so a projected dataset keeps its
    real coordinate reference system instead of being mislabeled as lon and lat.

    `source_column` carries the source column's own `geo` entry so that fields
    the converter does not compute, such as `edges`, `orientation`, and `epoch`,
    survive the round trip instead of being silently dropped. The converter's
    own `encoding`, `geometry_types`, `bbox`, `crs`, and `covering` overlay it.

    The overview column lists its own `geometry_types`, recomputed from the
    overview WKB via `overview_geometry_types`, since simplification can drop to
    a lower dimensional type. It never carries a `covering`, and any stale
    covering inherited from a re-converted source column is stripped.

    `covering` is False for Profile B (`--no-bbox`), which omits the physical
    bbox struct column entirely, so the primary geometry column carries no
    `covering` block either, there is nothing for it to point at.
    """

    def column(types: list[str]) -> dict:
        col: dict = dict(source_column) if source_column else {}
        col["encoding"] = "WKB"
        col["geometry_types"] = types
        col["bbox"] = list(dataset_bbox)
        if crs is not _NO_CRS:
            col["crs"] = crs
        else:
            # An absent CRS means the CRS84 default, so drop any inherited value.
            col.pop("crs", None)
        return col

    primary = column(geometry_types)
    if covering:
        primary["covering"] = COVERING
    else:
        # Strip any covering inherited from a source column that was itself a
        # converter output with a bbox column, Profile B has no bbox column
        # for it to point at.
        primary.pop("covering", None)
    columns = {"geometry": primary}
    if has_overview:
        ov = column(overview_geometry_types if overview_geometry_types is not None else geometry_types)
        # The overview column has no covering, and must not inherit a stale one
        # from a source column that was itself a converter output.
        ov.pop("covering", None)
        columns["geom_overview"] = ov
    return json.dumps({"version": "1.1.0", "primary_column": "geometry", "columns": columns})


def overviews_meta(
    spatial_key: str,
    levels: list[dict] | None,
    has_overview: bool,
    importance: str = "area_desc",
    overview_method: str = "simplify_snap",
    regime: str = "count",
    version: str = "0.3.0",
    covering: bool = True,
    count_column: str | None = None,
) -> str:
    """The additive `overviews` footer block, draft 0.3.0.

    `levels` is computed from the real row group layout, never hand authored.
    Each level maps a band to the index of its last row group, the coarsest
    web zoom it should paint, and its ground sample distance in CRS units per
    pixel. A client reads `levels` to know which row group prefix and which
    geometry column to fetch for a given zoom. Each level additionally carries
    `min_zoom`, the coarsest web zoom the band starts serving and the pair to
    `max_zoom`, `grid`, the band's per-band snap grid as a positional `origin`
    and `cell_size` (null on the finest exact band, which has no overview), and
    `feature_count`, the number of features in the band.

    `importance` records how features were actually ranked into bands,
    `area_desc` for polygons, `length_desc` for lines, `attribute:<column>` for
    an attribute-ranked column, `grid_thin` for spatially thinned points, and
    `mixed_quantile_desc` for a mixed-dimension layer merged by quantile. It is
    descriptive, a reader never needs to interpret it to read the file.

    `regime` is a descriptive label, count-heavy versus vertex-heavy, derived
    from the average exact bytes per feature. Like `importance` it is descriptive
    only, a reader never has to interpret it to read the file.

    `overview_method` states how `geom_overview` was derived, `simplify_snap`
    when an overview column is written, `thin` for a pure-point dataset where
    the banding itself is the level of detail and no overview column exists,
    and `none` for a single-band file where nothing was reduced at all.

    `count_column` names the per-survivor density count column when thinning
    wrote one, each coarse-band survivor's value is how many features competed
    for its one-pixel cell, itself included, so a viewer can scale the
    survivor's symbol and keep a dense cluster distinguishable from sparse
    coverage. Absent when thinning was off or the file is a single band.

    `covering` is False for Profile B (`--no-bbox`), which omits the physical
    bbox struct column, so there is no covering to point at and native
    geospatial statistics are the only row-group pruning surface.
    """
    block: dict = {
        "version": version,
        "spatial_key": spatial_key,
        "importance": importance,
        "regime": regime,
    }
    if covering:
        block["covering"] = COVERING
    if levels is not None:
        if has_overview:
            block["overview_column"] = "geom_overview"
        # Present even for the pure-point `thin` case, where overview_column is absent.
        block["overview_method"] = overview_method
        if count_column is not None:
            block["count_column"] = count_column
        block["levels"] = levels
    return json.dumps(block)
