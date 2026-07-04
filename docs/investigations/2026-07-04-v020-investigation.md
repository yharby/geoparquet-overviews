# v0.2.0 investigation report

Date 2026-07-04. Status complete.
Scope of the investigation, three questions raised for a possible 0.2.0 of the
overviews convention, plus one external event that arrived mid-investigation
and reshapes the conclusions.

1. Should `geom_overview` (or a sibling column) carry a compact PBF encoded
   copy of the simplified geometries, per feature or per tile, in a Parquet
   VARIANT or struct column, using the bands as zoom level ranges, similar in
   spirit to PMTiles but inside the one file.
2. Can the physical `bbox` covering column be removed while keeping row group
   spatial pruning, by relying on GeoParquet 2.0 native geospatial statistics.
3. What is in `gpq-tiles` (github.com/geoparquet-io/gpq-tiles) that can help.

The external event. Nissim Lebovits, author of gpq-tiles, reached out proposing
to align his draft `geo:overviews` spec with this project's `overviews` spec.
The two drafts converged independently on nearly the same design. Section 5
covers the mapping, section 7 the recommended positions.

Method. Four research subagents ran in parallel. One mapped this repo end to
end, one researched the Parquet VARIANT type and ecosystem writer and reader
support, one researched MVT, PBF, TWKB and tiles-inside-Parquet prior art with
published benchmarks, and one performed a full reconnaissance of the gpq-tiles
repository including its spec, pipeline, and reusable code. A fifth agent on
GeoParquet 2.0 native statistics support is reflected in section 4.

---

## 1. Verdict summary

| Question | Verdict |
|---|---|
| VARIANT column as the container | No. Wrong tool, no pyarrow write support, zero benefit over plain binary. |
| PBF or TWKB encoded overview geometry in the file | Not recommended for 0.2.0. Real but small size win after zstd, slower browser decode than the current zero copy WKB path, custom decoder burden, and it conflicts with the alignment opportunity. |
| Per tile MVT blobs inside the file | Not recommended. Proven elsewhere (CARTO, RaQuet) but reintroduces the duplicated, clipped, per zoom geometry the convention exists to avoid. Better served by deriving PMTiles from the file. |
| Dropping the `bbox` covering column under GeoParquet 2.0 | Yes, as an opt in profile. Native statistics replace row group pruning only, confirmed no page level equivalent exists in the format. The covering column stays the default for range request readers. Writer and reader support for native types plus statistics is already in place in pyarrow 21+ and hyparquet 1.19+, verified. |
| gpq-tiles | Far more than a helper library. It is a sibling implementation of the same convention, and the author proposes merging drafts. Strongly recommend alignment. |

---

## 2. The VARIANT question

The VARIANT logical type is finalized in parquet-format. The annotation landed
in 2.11.0 (March 2025) and the binary encoding plus shredding specs were
finalized in 2.12.0 (August 2025). Physically a VARIANT is a group of two
BYTE_ARRAY fields, `metadata` (a field name dictionary) and `value` (the self
describing binary), with optional shredding into typed columns.

Writer and reader support as of July 2026.

| Implementation | Read | Write |
|---|---|---|
| pyarrow / Arrow C++ (21.0 through 24.0) | Yes, low level, surfaces as an extension type over struct of two binaries | No. The write path is an open draft PR (apache/arrow #50252), unreviewed |
| arrow-rs | Yes | Yes, behind an experimental feature flag |
| DuckDB 1.4+ | Yes, including shredded | Yes, with automatic shredding |
| Spark 4.0 / 4.1 | Yes | Yes, 4.1 adds shredded writes |
| hyparquet | Yes (listed on the official implementation status page) | Via hyparquet-writer |

Decisive points against VARIANT for this use case.

- The converter is pyarrow, and pyarrow cannot write VARIANT at all today.
- VARIANT does have a `binary` primitive (type ID 15), so an opaque PBF blob
  is representable, but wrapping a single opaque blob in VARIANT buys nothing.
  It costs the metadata column, the value header bytes, and a variant decoder
  in every consumer, in exchange for features (field navigation, shredding,
  heterogeneous typing) that an opaque blob never uses.
- A plain BYTE_ARRAY binary column, exactly what `geom_overview` already is,
  carries any byte payload and is readable and writable everywhere today.

Conclusion. If any alternate encoding is ever adopted, its container is a
plain binary column. VARIANT is off the table regardless of the encoding
decision.

Sources.
- https://github.com/apache/parquet-format/blob/master/VariantEncoding.md
- https://github.com/apache/parquet-format/blob/master/VariantShredding.md
- https://parquet.apache.org/blog/2026/02/27/variant-type-in-apache-parquet-for-semi-structured-data/
- https://github.com/apache/arrow/pull/50252
- https://parquet.apache.org/docs/file-format/implementationstatus/

---

## 3. The compact geometry encoding question

### 3.1 Per feature encoding outside a tile grid is TWKB

MVT geometry is integer coordinates in a tile local grid (default extent
4096), zigzag delta encoded as MoveTo, LineTo, ClosePath command streams. Take
away the tile and a quantization frame must still be chosen, and the result is
a re-invention of formats that already exist. TWKB is the exact prior art, a
per geometry blob with coordinates scaled to integers, delta encoded, zigzag,
varint. PostGIS has shipped `ST_AsTWKB` since 2.2. Mapbox geobuf is the same
idea in protobuf clothing and its own README warns the schema never
stabilized.

### 3.2 The size win is real but shrinks under zstd

- TWKB raw is roughly 25 to 30 percent of WKB size for lines and polygons.
- But the file already compresses pages with zstd level 15, and general
  compression recovers most of the redundancy in WKB doubles. The best modern
  measurement, the MapLibre Tile (MLT) paper, shows lightweight integer
  encodings that beat MVT 2.5 to 6.7x raw keep only 1.3 to 2.0x after both
  sides are gzipped. geobuf shows the same collapse, 6 to 8x raw over GeoJSON
  becomes 2 to 2.5x after gzip.
- Expected effect here, the 9.27 MB whole country band 0 preview becomes
  roughly 4 to 7 MB, not 1 MB. Meaningful, not transformative.
- The academically stronger route for Parquet is not blobs at all but delta
  encoded integer coordinates as native columns (the Spatial Parquet paper
  reports about 3x pre compression, and MLT is columnar in the same spirit).
  That direction is GeoArrow shaped and was already evaluated and set aside
  for this project, which deliberately stays on standard WKB.

### 3.3 Browser decode would get slower, not faster

The standard JS MVT stack (@mapbox/vector-tile plus pbf) materializes a JS
object per feature and allocates Point arrays per geometry. The viewer's
current path is a zero copy DataView scanner filling flat typed arrays with no
per feature objects. A PBF or TWKB decoder written in the same zero copy style
is feasible (a varint loop instead of fixed width doubles) but it is new code
replacing a working, already faster path, for the modest byte win above.

deck.gl MVTLayer also cannot consume tiles from custom byte range fetches. Its
`data` prop accepts only URL templates or TileJSON, and `getTileData` is
explicitly not called. The supported route is TileLayer with a custom
`getTileData`, which is architecturally what the viewer already does with row
groups instead of tiles.

### 3.4 Per tile MVT blobs inside Parquet

Storing whole tiles as rows is proven practice in warehouses. CARTO tilesets
are tables of z, x, y, blob rows (or quadbin keyed), and RaQuet does the same
for raster with quadbin block IDs and a JSON footer parallel to `geo`,
including overview zoom levels. Nobody was found storing MVT blobs inside a
GeoParquet file for browsers to range read, so the niche is unoccupied, but it
is unoccupied for a reason that DESIGN.md already records. A tile pyramid
stores every shape once per zoom it appears in, quantized and lossy, clipped
at tile borders, invisible to SQL. PMTiles needs its pyramid because tiles are
opaque blobs, and dedup only helps byte identical tiles like ocean. Bringing
that inside the file abandons the single copy premise of this convention.

The stronger answer to ecosystem compatibility is the one gpq-tiles already
implements, derive a PMTiles archive from the overview bands in seconds, as a
cheap disposable projection of the canonical file. The overview bands make
that derivation fast because the generalization work is already stored.

Sources.
- https://docs.mapbox.com/data/tilesets/guides/vector-tiles-standards/
- https://github.com/TWKB/Specification
- https://postgis.net/docs/ST_AsTWKB.html
- https://github.com/mapbox/geobuf
- https://arxiv.org/html/2508.10791v1 (MapLibre Tile paper)
- https://arxiv.org/abs/2209.02158 (Spatial Parquet paper)
- https://docs.carto.com/data-and-analysis/analytics-toolbox-for-postgresql/key-concepts/tilesets
- https://github.com/CartoDB/raquet
- https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
- https://deck.gl/docs/api-reference/geo-layers/mvt-layer

---

## 4. The bbox covering column under GeoParquet 2.0

The intent for 0.2.0 is to target GeoParquet 2.0 and offer a file profile
without the physical `bbox` struct column.

### 4.1 Format level facts, verified against parquet.thrift

- `GeospatialStatistics` is field 17 of `ColumnMetaData`, so it lives per
  column chunk per row group in the footer. It carries an optional
  `BoundingBox` (xmin, xmax, ymin, ymax, optional z and m) and an optional
  list of ISO WKB geometry type codes present in the chunk. Added in
  parquet-format 2.11.0 (March 2025).
- Page level geospatial statistics do not exist, confirmed by reading the
  full `ColumnIndex` struct. Its fields are null pages, generic min and max,
  boundary order, null counts, level histograms, nan counts. Generic binary
  min and max on a WKB column are byte lexicographic and spatially
  meaningless, and GEOMETRY and GEOGRAPHY have undefined sort order.
- Consequence, native statistics give row group granularity only. The
  viewer's sub row group page pruning through the covering column's
  ColumnIndex and OffsetIndex has no native replacement. The measured value
  of that pruning is about 5.8x fewer bytes on large row groups and about
  1.5 to 2x on default 16 MB groups. The covering column costs four float64
  per row, roughly 180 MB raw on the 5.65M row validation file before
  compression and byte stream split.

### 4.2 Support matrix, July 2026

| Implementation | Native GEOMETRY | GeospatialStatistics |
|---|---|---|
| pyarrow / Arrow C++ | Write and read since Arrow 21.0.0 (July 2025), via the registered `geoarrow.wkb` extension type and plain `pq.write_table` | Computed and written automatically per row group chunk, exposed on read via `ColumnChunkMetaData.geo_statistics`. Verified empirically on pyarrow 24.0.0 |
| hyparquet | Since 1.19.0, native GEOMETRY decodes with an overridable parser, so the viewer's identity parser zero copy path survives | Exposed to the caller as `geospatial_statistics` on the column chunk metadata. Verified in this repo's installed hyparquet 1.26.2 source |
| DuckDB | Read since 1.4.0, core GEOMETRY type in 1.5.0 with row group bbox and type statistics and pushdown into the `&&` operator | Whether DuckDB 1.5 feeds Parquet file GeospatialStatistics into pruning is plausible but not officially confirmed, flagged uncertain. Late 2025 benchmarks found no engine pruning on native Parquet geo stats yet |

Two verified enablers matter for the converter.

- Dual writing works today. In the empirical test a file carried the native
  GEOMETRY logical type with automatic statistics and a `geo` file level key
  side by side. One file can be GeoParquet 1.1 with covering for old readers
  and natively typed with statistics for new ones.
- No special writer options are needed, register the extension type, build
  the table, write.

### 4.3 GeoParquet 2.0 status

The spec on the main branch declares version 2.0.0. The community has agreed
on the release but OGC approval (24-013 track) is still pending, and the last
git tag remains 1.1.0. In 2.0 geometry columns MUST be native GEOMETRY or
GEOGRAPHY logical types, the `geo` key itself becomes optional, and the
`covering` bbox construct is removed from the spec entirely (zero occurrences
in the 2.0.0 text). The stated rationale is that native statistics replace
it. Nothing forbids carrying an extra physical bbox column, and a 1.1 style
`geo` key with `covering` can ride along in the same file.

### 4.4 Recommendation, two writer profiles

Make the covering column a writer profile choice rather than a MUST.

- Profile A, maximum pruning, stays the default. Covering column present,
  page index written, plus native GEOMETRY types and statistics. Readers get
  row group pruning from either source and page pruning from the
  ColumnIndex. Dual 1.1 and 2.0 metadata.
- Profile B, lean 2.0. No covering column, native statistics provide row
  group pruning, and the spec says plainly that page pruning is unavailable.
  The viewer falls back to whole group reads, which it already does whenever
  the page path fails, so no viewer redesign is needed.

Caveats recorded for the spec text. Engine support for pruning on native
statistics is still uneven through 2026, and GeoParquet 1.0 and 1.1 only
readers ignore native types entirely, so Profile B should stay opt in until
the ecosystem catches up. The transition era practice is dual writing, which
Profile A already embodies.

Sources.
- https://github.com/apache/parquet-format/blob/master/src/main/thrift/parquet.thrift
- https://github.com/apache/parquet-format/blob/master/Geospatial.md
- https://arrow.apache.org/blog/2025/07/17/21.0.0-release/
- https://parquet.apache.org/docs/file-format/implementationstatus/
- https://github.com/opengeospatial/geoparquet/blob/main/format-specs/geoparquet.md
- https://duckdb.org/2026/03/09/announcing-duckdb-150
- https://cloudnativegeo.org/blog/2025/10/geoparquet-parquet-geospatial-types-a-time-of-transition/
- https://dewey.dunnington.ca/post/2025/lazy-geoparquet-reading-in-sedonadb-duckdb-geopandas-and-gdal/

---

## 5. gpq-tiles and the geo:overviews draft

### 5.1 What it is

A Rust workspace (core, cli, python crates) by Nissim Lebovits, Apache-2.0,
workspace version 0.6.0, actively developed, single maintainer, AI assisted by
its own README's admission. Its stated purpose is GeoParquet to PMTiles
conversion, but its self described key artifact is the overview GeoParquet
file, a COG style pyramid inside one valid GeoParquet 1.1 file. It carries a
draft spec at `context/OVERVIEWS_SPEC.md` (version 0.2.0) and a one pager
pitching a `geo:overviews` key toward the GeoParquet repo as an official
extension.

### 5.2 Convergent design, independently reached

Both drafts arrived at a JSON key in the footer next to `geo` and safely
ignorable, ascending levels aligned to row group bands, Hilbert order within
bands, gsd as the authoritative resolution signal with zoom advisory, a bbox
covering column for pruning, and the COG framing throughout. His `levels[]`
carries `row_group_end`, `gsd`, optional `zoom`. Ours carries `level`,
`row_group_end`, `max_zoom`, `gsd`. The mapping is near mechanical.

### 5.3 The one hard divergence, rows versus columns

His spec section 2.1 normatively forbids parallel geometry columns and stores
levels as additional rows with a physical `level` INT32 column, in two modes.

- Duplicating mode. Each level is a self contained generalized copy, finest
  level byte identical to source, `WHERE level = k` gives clean single band
  SQL, at the cost of storing geometry more than once.
- Partitioning mode. Each feature exactly once at its coarsest level, prefix
  reads, same family as this project. Its acknowledged weakness is that coarse
  reads still fetch full precision geometry for the important features.

`geom_overview` solves exactly that weakness column wise, and his outreach
message concedes this and proposes folding it into a unified draft.

### 5.4 Reusable assets found in the repo

- A hand rolled MVT encoder over prost (`crates/core/src/mvt.rs`), extent
  parameterized, with correct WebMercator y handling. Relevant if tile export
  is ever wanted, not needed for the in file format.
- The zoom, gsd, tolerance ladder (`crates/core/src/overview/level.rs`) with
  the same shape as this converter's, plus the inverse zoom_for_gsd.
- Tile pyramid math with antimeridian handling (`crates/core/src/tile.rs`).
- A complete serde model and validator for the footer metadata
  (`crates/core/src/overview/level.rs`), enforcing monotonic row_group_end and
  decreasing gsd. Useful as a cross implementation conformance reference.
- A streaming two pass converter architecture, about 320 MB peak RSS on a 38M
  vertex file, the answer to this converter's whole table in memory
  limitation.
- Tippecanoe derived generalization logic reimplemented in Rust with sweep
  calibrated defaults, visibility gate, cell winner thinning, density budget,
  ranking tiers. No tippecanoe dependency.
- Reproducible S3 range request benchmarks, every viewport in the sweep reads
  0.14 to 6.5 percent of the file, pans land in 130 to 300 ms with the footer
  cached, 2 to 5 requests cold.

What it lacks entirely is a browser viewer. No JS, no WASM, no HTML anywhere
in the repo. This project's viewer, its page level pruning, its click to
inspect, and its projected CRS validation are the complementary half.

### 5.5 Its stance on the PBF idea

The one pager concedes MVT fetches 1.1 to 14x fewer bytes per viewport for
pure rendering, and answers with `export-pmtiles`, tiles as a cheap projection
of the canonical file, never stored inside it. Storing quantized geometry in
the file is the fork gpq-tiles explicitly did not take. An 0.2.0 that added
PBF columns would combine the two things his spec rejects (parallel geometry
columns and lossy in file geometry) at the exact moment a merged draft is on
the table.

---

## 6. Recommendations for 0.2.0

1. Drop the PBF and VARIANT idea in its current form. Keep `geom_overview` as
   standard WKB in a plain binary column. Revisit compact encodings only if a
   future profiling pass shows network bytes, not decode, as the bottleneck,
   and then as TWKB in a plain binary column, never VARIANT.
2. Make 0.2.0 the alignment release. Merge the two drafts into one
   `geo:overviews` spec with modes, and position `geom_overview` as an
   optional column on partitioning mode.
3. Adopt GeoParquet 2.0 readiness as the second 0.2.0 work item. Covering
   column becomes a profile choice, present by default for page pruning,
   omittable in a lean opt in profile. The writer and reader stack is ready
   today, pyarrow 21+ writes native GEOMETRY with automatic statistics
   alongside the `geo` key, and hyparquet 1.19+ reads both the type and the
   statistics (section 4).
4. Serve the ecosystem compatibility goal through derivation, not in file
   tiles. gpq-tiles already exports PMTiles from overview bands. The two
   projects together cover canonical file, fast converter, tile export, and
   browser viewer.
5. Consider adopting his open ideas that this draft also wanted, per level
   byte ranges and extents in `levels[]`, so a reader can price a prefix read
   before issuing it.

## 7. Recommended positions for the alignment call

1. Key name. Concede `geo:overviews`. Namespaced, standards friendly, cheap
   to give, and goodwill for the points that matter more.
2. Metadata shape. Merge `levels[]` fields, keep gsd authoritative and zoom
   advisory (already agreed on both sides), bring `overview_method`,
   `importance`, and `overview_column` as optional descriptive keys, propose
   adding per level byte range and extent.
3. geom_overview. Argue for optional column on partitioning mode rather than
   a third mode. It composes, duplicating mode gains nothing from it, and a
   third mode triples the conformance matrix.
4. SQL semantics. `WHERE level = k` remains the duplicating mode story,
   `WHERE band <= k` plus prefix reads remain the partitioning story, both
   documented in one spec.
5. Division of labor. His streaming Rust converter and benchmarks, this
   project's viewer as the reference browser reader, both implementations
   cited when the merged draft goes to the GeoParquet repo, since two
   independent implementations are the maturity signal that conversation
   needs.

## 8. Open items

- Field by field mapping table of the two footer schemas, worth attaching to
  the reply to Nissim.
- Whether the merged draft keeps this repo's `band` column name or his
  `level` column name for the physical ordinal (they are the same concept).
- His benchmarks measure a purpose built parallel reader, this viewer should
  reproduce the same sweep for an apples to apples number in the merged
  pitch.
