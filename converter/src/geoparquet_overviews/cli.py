"""Command line interface, `gpo convert in.parquet out.parquet`."""

import json
import logging
import sys

import click

from .convert import (
    _COARSEST_REL,
    _LADDER_FACTOR,
    _SCREEN_BUDGET_MB,
    ConvertOptions,
    convert,
)


def _setup_logging(verbose: bool) -> None:
    """Send stage logs to stderr so the JSON summary stays clean on stdout.
    INFO shows every stage, verbose adds DEBUG."""
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(message)s",
        stream=sys.stderr,
    )


@click.group()
@click.version_option()
def main() -> None:
    """Convert any GeoParquet into the overviews layout."""


@main.command()
@click.argument("src", type=click.Path(exists=True, dir_okay=False))
@click.argument("dst", type=click.Path(dir_okay=False))
@click.option(
    "--bands",
    default=0,
    show_default=True,
    help="Number of bands. 0 derives the count from byte density, a positive value forces it.",
)
@click.option(
    "--screen-budget-mb",
    default=_SCREEN_BUDGET_MB,
    show_default=True,
    type=float,
    help="Decoded geometry a screen should target, in MB. Caps the overview ladder depth, lower asks for more coarse bands. Ignored when --bands is forced.",
)
@click.option(
    "--row-group-mb",
    default=16.0,
    show_default=True,
    help="Row group byte budget in MB, cut at band boundaries.",
)
@click.option(
    "--overview-grid",
    default=None,
    type=float,
    help="Coordinate grid the overview geometry snaps to, in CRS units. Derived from the dataset extent when unset.",
)
@click.option(
    "--band-fractions",
    default=None,
    type=str,
    help="Comma-separated share of features per coarse band, largest first, e.g. 0.01,0.02,0.04. Derived from the tolerance ladder when unset.",
)
@click.option(
    "--coarsest-rel",
    default=_COARSEST_REL,
    show_default="1/1500",
    type=float,
    help="Band 0 simplify tolerance as a fraction of the larger extent span.",
)
@click.option(
    "--ladder-factor",
    default=_LADDER_FACTOR,
    show_default=True,
    type=float,
    help="Each finer coarse band divides the tolerance by this. 4 steps two web zooms per band, the raster-overview style _ZOOMS_PER_BAND step.",
)
@click.option(
    "--coarse-row-groups",
    default=32,
    show_default=True,
    type=int,
    help="Target row groups per coarse band. More groups give tighter bounding boxes so a low zoom map view reads fewer features.",
)
@click.option(
    "--compression-level",
    default=15,
    show_default=True,
    type=int,
    help="zstd compression level. Higher is smaller and slower.",
)
@click.option(
    "--page-size-kb",
    default=128,
    show_default=True,
    type=int,
    help="Data page size in KB. The lever for the viewer's page-pruning granularity, smaller pages prune finer.",
)
@click.option(
    "--importance-column",
    default=None,
    type=str,
    help="Numeric column that ranks point features, largest first. Points are ranked by grid thinning when unset.",
)
@click.option(
    "--native-geo/--no-native-geo",
    default=True,
    show_default=True,
    help="Write Parquet native GEOMETRY logical types with per-row-group geospatial statistics, alongside the geo key (dual GeoParquet 1.1 plus 2.0).",
)
@click.option(
    "--bbox/--no-bbox",
    default=None,
    help="Write the physical bbox covering column (Profile A) or omit it and rely on native geospatial statistics only (Profile B, disables page-level pruning). Default is adaptive: on for count-heavy data, off for vertex-heavy data. Either flag forces the choice explicitly.",
)
@click.option(
    "--jobs",
    "-j",
    default=0,
    show_default=True,
    type=int,
    help="Worker threads for the overview build, the slowest stage. 0 is one per core, 1 forces single-threaded.",
)
@click.option(
    "--thin/--no-thin",
    default=True,
    show_default=True,
    help="Thin band 0 for even coverage, at most one feature per screen pixel per geometry dimension. --no-thin is a debug escape only.",
)
@click.option("-v", "--verbose", is_flag=True, help="Verbose (DEBUG) logging.")
@click.option("-q", "--quiet", is_flag=True, help="Only print the JSON summary, no stage logs.")
def convert_cmd(
    src: str,
    dst: str,
    bands: int,
    screen_budget_mb: float,
    row_group_mb: float,
    overview_grid: float | None,
    band_fractions: str | None,
    coarsest_rel: float,
    ladder_factor: float,
    coarse_row_groups: int,
    compression_level: int,
    page_size_kb: int,
    importance_column: str | None,
    native_geo: bool,
    bbox: bool | None,
    jobs: int,
    thin: bool,
    verbose: bool,
    quiet: bool,
) -> None:
    """Convert SRC GeoParquet into a GeoParquet with overviews at DST."""
    if not quiet:
        _setup_logging(verbose)
    opts = ConvertOptions(
        bands=bands,
        screen_budget_mb=screen_budget_mb,
        row_group_mb=row_group_mb,
        overview_grid=overview_grid,
        band_fractions=([float(f) for f in band_fractions.split(",")] if band_fractions else None),
        coarsest_rel=coarsest_rel,
        ladder_factor=ladder_factor,
        coarse_row_groups=coarse_row_groups,
        compression_level=compression_level,
        page_size_kb=page_size_kb,
        importance_column=importance_column,
        native_geo=native_geo,
        bbox=bbox,
        jobs=jobs,
        thin=thin,
    )
    summary = convert(src, dst, opts)
    click.echo(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
