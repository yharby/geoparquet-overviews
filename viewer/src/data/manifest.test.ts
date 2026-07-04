import { describe, expect, it } from 'vitest';
import { parseManifest, presetsForVersion, resolveVersionTwin } from './manifest';

const RAW = {
  latest: '0.2.0',
  base: 'https://data.source.coop/youssef-harby/geoparquet-overviews',
  versions: [
    {
      version: '0.1.0',
      prefix: 'v0.1.0',
      datasets: [{ id: 'sample', label: 'sample (overviews demo)', path: 'sample.parquet' }],
    },
    {
      version: '0.2.0',
      prefix: 'v0.2.0',
      datasets: [
        { id: 'sample', label: 'sample (overviews demo)', path: 'sample.parquet' },
        { id: 'big_sample', label: 'large sample (page pruning)', path: 'big_sample.parquet' },
      ],
    },
  ],
};

describe('manifest', () => {
  it('parses a valid manifest', () => {
    const m = parseManifest(RAW);
    expect(m).not.toBeNull();
    expect(m!.latest).toBe('0.2.0');
    expect(m!.versions).toHaveLength(2);
  });

  it('rejects malformed input instead of throwing', () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest({ versions: 'nope' })).toBeNull();
    expect(parseManifest({ latest: '1', base: 2, versions: [] })).toBeNull();
  });

  it('resolves preset urls under base/prefix/path', () => {
    const m = parseManifest(RAW)!;
    const presets = presetsForVersion(m, '0.1.0');
    expect(presets).toEqual([
      {
        id: 'sample',
        label: 'sample (overviews demo)',
        url: 'https://data.source.coop/youssef-harby/geoparquet-overviews/v0.1.0/sample.parquet',
      },
    ]);
    expect(presetsForVersion(m, '9.9.9')).toEqual([]);
  });
});

describe('resolveVersionTwin', () => {
  const m = parseManifest(RAW)!;
  const sampleUrl010 = 'https://data.source.coop/youssef-harby/geoparquet-overviews/v0.1.0/sample.parquet';
  const sampleUrl020 = 'https://data.source.coop/youssef-harby/geoparquet-overviews/v0.2.0/sample.parquet';
  const bigSampleUrl020 = 'https://data.source.coop/youssef-harby/geoparquet-overviews/v0.2.0/big_sample.parquet';

  it('resolves the same-id dataset under the new version', () => {
    expect(resolveVersionTwin(m, '0.1.0', '0.2.0', sampleUrl010)).toBe(sampleUrl020);
  });

  it('resolves back the other direction too', () => {
    expect(resolveVersionTwin(m, '0.2.0', '0.1.0', sampleUrl020)).toBe(sampleUrl010);
  });

  it('returns null when the new version has no dataset with the same id', () => {
    // big_sample only exists in 0.2.0, so switching 0.2.0 -> 0.1.0 while it is
    // selected finds no twin.
    expect(resolveVersionTwin(m, '0.2.0', '0.1.0', bigSampleUrl020)).toBeNull();
  });

  it('returns null when currentUrl is not a known preset of fromVersion', () => {
    expect(resolveVersionTwin(m, '0.1.0', '0.2.0', 'https://example.com/unrelated.parquet')).toBeNull();
  });
});
