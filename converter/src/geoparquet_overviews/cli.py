"""Command line interface, `gpo convert in.parquet out.parquet`."""

import json
import logging
import sys

import click

from .convert import ConvertOptions, convert


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
@click.option("--bands", default=3, show_default=True, help="Number of importance bands.")
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
@click.option("-v", "--verbose", is_flag=True, help="Verbose (DEBUG) logging.")
@click.option("-q", "--quiet", is_flag=True, help="Only print the JSON summary, no stage logs.")
def convert_cmd(
    src: str,
    dst: str,
    bands: int,
    row_group_mb: float,
    overview_grid: float | None,
    coarse_row_groups: int,
    compression_level: int,
    page_size_kb: int,
    importance_column: str | None,
    native_geo: bool,
    verbose: bool,
    quiet: bool,
) -> None:
    """Convert SRC GeoParquet into a GeoParquet with overviews at DST."""
    if not quiet:
        _setup_logging(verbose)
    opts = ConvertOptions(
        bands=bands,
        row_group_mb=row_group_mb,
        overview_grid=overview_grid,
        coarse_row_groups=coarse_row_groups,
        compression_level=compression_level,
        page_size_kb=page_size_kb,
        importance_column=importance_column,
        native_geo=native_geo,
    )
    summary = convert(src, dst, opts)
    click.echo(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
