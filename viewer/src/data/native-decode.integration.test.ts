import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parquetMetadataAsync, parquetRead, type AsyncBuffer } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { RAW_WKB_PARSERS } from './rowgroups';

// This test deliberately does NOT mock hyparquet (contrast every other test in
// this suite, e.g. rowgroups.test.ts). Every other test proves the viewer's
// call wiring is exercised correctly, but with hyparquet stubbed out, so none
// of them prove hyparquet itself actually decodes the file's native Parquet
// GEOMETRY logical type (geoarrow.wkb extension) to raw WKB bytes through the
// RAW_WKB_PARSERS identity override. This test closes that gap by driving the
// real regenerated public/sample.parquet fixture through the real library.
//
// Level tested: hyparquet directly, one level below the viewer's
// readColumnProgressive (src/data/rowgroups.ts). The viewer's real entry point
// only ever reaches hyparquet through getCachedFile -> asyncBufferFromUrl,
// which is fetch-based (HTTP range requests) and cannot be driven against a
// local file in Node -- Node's fetch rejects file:// URLs outright. So this
// test builds the AsyncBuffer with hyparquet's own asyncBufferFromFile (a
// legitimate, non-browser-only hyparquet API for local files) and then calls
// parquetRead with the exact same options rowgroups.ts uses: the column
// name, `compressors`, `utf8: false`, and the real RAW_WKB_PARSERS parser
// override from production code.

const SAMPLE_PATH = fileURLToPath(new URL('../../public/sample.parquet', import.meta.url));

// A minimal AsyncBuffer over the whole file read into memory up front (the
// fixture is ~1.2 MB), mirroring file-cache.ts's own in-memory wrapping for
// small files (see PREFETCH_THRESHOLD_BYTES) without importing that module,
// since importing it would pull in asyncBufferFromUrl's fetch dependency.
function memoryBuffer(bytes: Uint8Array): AsyncBuffer {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return {
    byteLength: buf.byteLength,
    slice: (start: number, end?: number) => buf.slice(start, end) as ArrayBuffer,
  };
}

describe('native GEOMETRY column decode (real hyparquet, real file)', () => {
  it('decodes the geometry column of the real sample.parquet to raw WKB bytes, not GeoJSON', async () => {
    const file = memoryBuffer(readFileSync(SAMPLE_PATH));
    const metadata = await parquetMetadataAsync(file);

    // Sanity: the fixture must actually carry the native GEOMETRY logical
    // type this test is guarding. If this ever regresses to plain BYTE_ARRAY
    // (no logical type) the rest of the assertions below would still pass
    // trivially, so pin the precondition explicitly.
    const geometryField = metadata.schema.find((f) => f.name === 'geometry');
    expect(geometryField?.logical_type?.type).toBe('GEOMETRY');

    const rowCount = Number(metadata.num_rows);
    expect(rowCount).toBeGreaterThan(0);

    const values: unknown[] = [];
    await parquetRead({
      file,
      metadata,
      columns: ['geometry'],
      rowStart: 0,
      rowEnd: rowCount,
      compressors,
      utf8: false,
      parsers: RAW_WKB_PARSERS,
      onChunk: (chunk) => {
        for (const v of chunk.columnData) values.push(v);
      },
    });

    const nonNull = values.filter((v) => v != null);
    expect(nonNull.length).toBeGreaterThan(0);

    // The load-bearing assertion: every decoded geometry value is a raw WKB
    // Uint8Array (identity-parsed), never a parsed GeoJSON object. A GeoJSON
    // geometry would be a plain object like {type: 'Point', coordinates: [...]},
    // which has neither a byteLength nor an indexable leading byte-order byte,
    // so this assertion would fail immediately if hyparquet's native GEOMETRY
    // dispatch stopped honoring parsers.geometryFromBytes and fell back to its
    // default WKB-to-GeoJSON conversion.
    for (const v of nonNull) {
      expect(v).toBeInstanceOf(Uint8Array);
      const bytes = v as Uint8Array;
      expect(bytes.length).toBeGreaterThan(0);
      // WKB's first byte is the byte-order marker: 0x00 (big-endian/XDR) or
      // 0x01 (little-endian/NDR), never a JSON-object artifact.
      expect([0x00, 0x01]).toContain(bytes[0]);
    }
  });

  it('exposes geospatial_statistics.bbox on the real geometry column chunk, the shape metadata.ts assumes', async () => {
    // metadata.ts's native-stats fallback (readGeoParquetMetadata, the
    // `if (!bbox)` block) reads `meta_data.geospatial_statistics.bbox` off
    // hyparquet's parsed column chunk and assumes it has finite
    // xmin/ymin/xmax/ymax fields. Every other test that shape is checked
    // against is a hand-built fixture, so nothing proves hyparquet 1.26.2
    // actually emits that field for a real file. sample.parquet is written
    // with native geo types on (Profile A), so its `geometry` column carries
    // real GeospatialStatistics; this test reads it with the unmocked
    // library and pins the shape.
    const file = memoryBuffer(readFileSync(SAMPLE_PATH));
    const metadata = await parquetMetadataAsync(file);

    const rowGroup = metadata.row_groups[0];
    const geometryColumn = rowGroup.columns.find((c) => c.meta_data?.path_in_schema.join('.') === 'geometry');
    const geomBbox = geometryColumn?.meta_data?.geospatial_statistics?.bbox;
    expect(geomBbox).toBeDefined();
    expect(Number.isFinite(geomBbox!.xmin)).toBe(true);
    expect(Number.isFinite(geomBbox!.ymin)).toBe(true);
    expect(Number.isFinite(geomBbox!.xmax)).toBe(true);
    expect(Number.isFinite(geomBbox!.ymax)).toBe(true);
    expect(geomBbox!.xmin).toBeLessThanOrEqual(geomBbox!.xmax);
    expect(geomBbox!.ymin).toBeLessThanOrEqual(geomBbox!.ymax);

    // sample.parquet also carries a geom_overview column (the overviews
    // convention's coarse-band column). If its chunk in this row group
    // carries stats too, they must have the same shape.
    const overviewColumn = rowGroup.columns.find((c) => c.meta_data?.path_in_schema.join('.') === 'geom_overview');
    const overviewBbox = overviewColumn?.meta_data?.geospatial_statistics?.bbox;
    if (overviewBbox && Number.isFinite(overviewBbox.xmin)) {
      expect(Number.isFinite(overviewBbox.ymin)).toBe(true);
      expect(Number.isFinite(overviewBbox.xmax)).toBe(true);
      expect(Number.isFinite(overviewBbox.ymax)).toBe(true);
      expect(overviewBbox.xmin).toBeLessThanOrEqual(overviewBbox.xmax);
      expect(overviewBbox.ymin).toBeLessThanOrEqual(overviewBbox.ymax);
    }
  });
});
