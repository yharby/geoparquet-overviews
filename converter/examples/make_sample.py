"""Generate a tiny synthetic GeoParquet and convert it to the overviews layout.

No external data, no attribution, fully reproducible. A handful of large blobs,
more medium ones, and many small ones, so the importance bands are meaningful.
A small row group budget makes several row groups per band, so the viewer can
show pruning and the band prefix on a tiny file.

    uv run python examples/make_sample.py

Writes ../viewer/public/sample.parquet.
"""

from __future__ import annotations

import json
import pathlib

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import shapely

from geoparquet_overviews.convert import ConvertOptions, convert

HERE = pathlib.Path(__file__).resolve().parent
PLAIN = HERE / "_sample_plain.parquet"
OUT = HERE.parent.parent / "viewer" / "public" / "sample.parquet"

# A neutral extent, roughly a 6 by 4 degree window near the equator.
EXTENT = (10.0, 0.0, 16.0, 4.0)


def _blob(rng: np.ndarray, cx: float, cy: float, radius: float) -> object:
    """A rough polygon, a jittered circle so vertices vary per feature."""
    # Dense outlines so the coarse-band overview is visibly smaller than exact.
    angles = np.linspace(0, 2 * np.pi, 120, endpoint=False)
    jitter = 0.7 + 0.6 * rng.random(len(angles))
    xs = cx + np.cos(angles) * radius * jitter
    ys = cy + np.sin(angles) * radius * jitter
    return shapely.Polygon(np.column_stack([xs, ys]))


def make_plain(seed: int = 7) -> None:
    rng = np.random.default_rng(seed)
    geoms = []
    # (count, radius) tiers, few big, many small.
    for count, radius in [(8, 0.9), (60, 0.28), (500, 0.06)]:
        for _ in range(count):
            cx = rng.uniform(EXTENT[0] + 1, EXTENT[2] - 1)
            cy = rng.uniform(EXTENT[1] + 1, EXTENT[3] - 1)
            geoms.append(_blob(rng, cx, cy, radius))
    wkb = shapely.to_wkb(np.array(geoms, dtype=object))
    ids = pa.array(range(len(geoms)), type=pa.int32())
    table = pa.table({"id": ids, "geometry": pa.array(wkb, type=pa.binary())})
    geo = json.dumps(
        {
            "version": "1.1.0",
            "primary_column": "geometry",
            "columns": {"geometry": {"encoding": "WKB", "geometry_types": ["Polygon"]}},
        }
    )
    table = table.replace_schema_metadata({b"geo": geo.encode()})
    pq.write_table(table, PLAIN)
    print(f"wrote {len(geoms)} synthetic polygons to {PLAIN.name}")


def main() -> None:
    make_plain()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    # A small budget so a few hundred polygons still split into several row
    # groups per band, which makes pruning visible in the viewer.
    summary = convert(str(PLAIN), str(OUT), ConvertOptions(row_group_mb=0.05))
    PLAIN.unlink(missing_ok=True)
    print(json.dumps(summary, indent=2))
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
