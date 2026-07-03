# GeoParquet Overviews Viewer

A browser inspector that reads GeoParquet with overviews over HTTP range
requests and shows the byte cost of every view, live.

Try it at https://yharby.github.io/geoparquet-overviews/. The convention it
reads is defined in [../SPEC.md](../SPEC.md), and the reasoning behind it in
[../DESIGN.md](../DESIGN.md).

## Quickstart

Requires Node 24 or newer and pnpm.

```bash
pnpm install
pnpm dev          # vite dev server, port 5173+
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run
pnpm build        # typecheck then vite build
pnpm preview      # serve the production build
```

## What it does

The viewer never downloads a whole file. It fetches the Parquet footer,
parses the `geo` and `overviews` metadata blocks, and then reads only what
the current view needs.

- It picks a band per zoom level. Low zooms read the simplified
  `geom_overview` column from the coarse row-group prefix, high zooms read
  the exact `geometry` column.
- It prunes row groups by bbox, so only groups intersecting the viewport are
  fetched.
- When a chosen row group covers far more area than the view and the file
  carries the Parquet page indexes, it reads the `bbox` covering column's
  ColumnIndex and OffsetIndex and fetches only the overlapping pages, a
  read below row-group granularity.
- Any failure on the page path falls back to a whole-group read, so pruning
  can never break a fetch.
- A byte meter and a waterfall panel show the live read cost of every
  settle, so the overview payoff is visible as you pan and zoom.

Files without an `overviews` footer still work. They render through a plain
flat-WKB path, pruned by the covering bbox when one exists.

## Presets and your own data

The presets dropdown loads hosted demo datasets, each chosen to show one
thing.

| Preset | Shows |
| --- | --- |
| sample (overviews demo) | Small synthetic demo of the overviews layout, the default on load |
| large sample (page pruning) | Synthetic dataset with large row groups, makes page-level pruning visible |
| Finland buildings (EPSG:3067) | Real projected dataset, exercises in-browser reprojection |
| Overture buildings (Tokyo, 6.5M polygons) | Overview payoff on polygons at scale |
| Overture roads (Tokyo, 1.4M lines) | Overview payoff on lines |
| Overture POIs (Tokyo, 266K points) | Overview payoff on points |

Any GeoParquet URL can be pasted into the URL box. The server must support
HTTP range requests (respond 206 to `Range` headers) and allow CORS from the
viewer's origin.

The viewer also opens directly on a `url` query parameter, so a link can deep
link straight into a hosted file, for example
`?url=https://host/path/file.parquet`. The parameter must be an http or https
address, anything else falls back to the default preset. The address bar
mirrors the loaded file, so it is always a shareable link and a refresh
reopens the same file.

## CRS support

Projected files reproject to lon and lat in the browser via proj4. The known
projected definitions live in the `PROJ_DEFS` registry in
[src/geo/crs.ts](src/geo/crs.ts), keyed by EPSG code and seeded with
EPSG:3067. An unknown projected code shows a clear notice instead of a broken
render. To support another projected CRS, add its proj4 definition string to
that registry.

Geographic data (CRS84 or an EPSG geographic CRS) passes through untouched.

## Local test fixtures

Large local fixtures go in `viewer/public/`. Everything there is gitignored
except `sample.parquet`, which is the checked-in demo file rebuilt by the
converter's `examples/make_sample.py`.
