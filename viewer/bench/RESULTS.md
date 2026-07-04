# Benchmark results, v0.1.0 against v0.2.0

Run date 2026-07-04. Produced by `pnpm bench` (see `compare.bench.ts`), which
reads the published files over HTTP range requests from
`https://data.source.coop/youssef-harby/geoparquet-overviews`, plans a read for
each viewport with the same `detectLayout` strategy the viewer uses, and sums
the compressed bytes of the planned geometry column chunks. That sum is what the
viewer fetches at row-group granularity, before any page-level pruning.

The viewport ladder centers a box on each dataset extent at fractions 1, 1/8,
1/64, 1/512 of the extent, labelled full extent, region, city, district, at map
zooms 5, 9, 12, 15. `column` is the geometry column the strategy chose,
`geom_overview` for coarse bands, `geometry` for the exact band. `rg` is the
number of row groups planned.

## What this release changes

v0.2.0 keeps the same importance ordering and band layout as v0.1.0, so for a
file written with the same writer profile the planned reads are expected to
match within layout noise. This benchmark is the regression guard for that,
plus a demonstration that Profile B still prunes with no physical `bbox`
covering column.

The Overture and Finland files show identical planned bytes across the two
versions, confirming no regression from the native GEOMETRY dual write, the
footer 0.2.0 fields, or the metadata parse changes. The `sample` and
`big_sample` files differ because their v0.1.0 copies were written by an earlier
converter build with a different row-group split, not by a change in the pruning
path. `big_sample` in fact reads less in v0.2.0 at region, city, and district,
the newer split packs the exact band into row groups that prune tighter.

## Published file sizes

| dataset | v0.1.0 | v0.2.0 |
| --- | ---: | ---: |
| sample.parquet | 1.26 MB | 1.27 MB |
| big_sample.parquet | 200.9 MB | 200.8 MB |
| nls_rakennus_overviews.parquet | 390.5 MB | 390.6 MB |
| nls_rakennus_overviews.nobbox.parquet (Profile B) | n/a | 331.8 MB |
| overture-tokyo/buildings.parquet | 659.2 MB | 659.2 MB |
| overture-tokyo/segments.parquet | 120.5 MB | 120.5 MB |
| overture-tokyo/pois.parquet | 17.2 MB | 17.2 MB |

Profile B is 58.8 MB smaller than Profile A on the Finland file, the size of the
dropped `bbox` covering column.

## Planned read per viewport

### sample.parquet

| viewport | column | v0.1.0 (rg, MB) | v0.2.0 (rg, MB) |
| --- | --- | ---: | ---: |
| full extent | geom_overview | 1, 0.03 | 1, 0.03 |
| region | geom_overview | 1, 0.03 | 1, 0.03 |
| city | geometry | 5, 0.44 | 3, 1.02 |
| district | geometry | 5, 0.44 | 3, 1.02 |

### big_sample.parquet

| viewport | column | v0.1.0 (rg, MB) | v0.2.0 (rg, MB) |
| --- | --- | ---: | ---: |
| full extent | geom_overview | 8, 2.11 | 8, 2.11 |
| region | geometry | 13, 125.14 | 16, 70.23 |
| city | geometry | 9, 120.51 | 11, 51.59 |
| district | geometry | 9, 120.51 | 11, 51.59 |

### nls_rakennus_overviews.parquet

| viewport | column | v0.1.0 (rg, MB) | v0.2.0 (rg, MB) |
| --- | --- | ---: | ---: |
| full extent | geom_overview | 32, 2.44 | 32, 2.44 |
| region | geom_overview | 15, 2.25 | 15, 2.25 |
| city | geometry | 10, 18.01 | 10, 18.01 |
| district | geometry | 5, 8.66 | 5, 8.66 |

The full-country preview reads 2.44 MB of band 0 overview against a 390 MB file,
matching the design's whole-country preview claim.

### overture-tokyo/buildings.parquet

| viewport | column | v0.1.0 (rg, MB) | v0.2.0 (rg, MB) |
| --- | --- | ---: | ---: |
| full extent | geom_overview | 32, 5.47 | 32, 5.47 |
| region | geom_overview | 4, 0.66 | 4, 0.66 |
| city | geom_overview | 8, 4.84 | 8, 4.84 |
| district | geometry | 12, 45.77 | 12, 45.77 |

### overture-tokyo/segments.parquet

| viewport | column | v0.1.0 (rg, MB) | v0.2.0 (rg, MB) |
| --- | --- | ---: | ---: |
| full extent | geom_overview | 32, 0.47 | 32, 0.47 |
| region | geom_overview | 2, 0.03 | 2, 0.03 |
| city | geometry | 2, 0.82 | 2, 0.82 |
| district | geometry | 2, 0.82 | 2, 0.82 |

### overture-tokyo/pois.parquet

| viewport | column | v0.1.0 (rg, MB) | v0.2.0 (rg, MB) |
| --- | --- | ---: | ---: |
| full extent | geometry | 32, 1.24 | 32, 1.24 |
| region | geometry | 5, 0.19 | 5, 0.19 |
| city | geometry | 9, 0.34 | 9, 0.34 |
| district | geometry | 10, 0.74 | 10, 0.74 |

Points carry no overview, so every viewport reads the exact `geometry` column.

## Profile A against Profile B, v0.2.0 Finland file

The headline of this release. Profile A carries the physical `bbox` covering
column, Profile B drops it and relies solely on the native per-row-group
GeospatialStatistics. Row-group pruning is identical across the two profiles at
every viewport, so the covering column costs 58.8 MB of file size and buys only
sub-row-group page pruning, not row-group pruning.

| viewport | column | Profile A (rg, MB) | Profile B (rg, MB) |
| --- | --- | ---: | ---: |
| full extent | geom_overview | 32, 2.44 | 32, 2.44 |
| region | geom_overview | 15, 2.25 | 15, 2.25 |
| city | geometry | 10, 18.01 | 10, 18.01 |
| district | geometry | 5, 8.66 | 5, 8.66 |
