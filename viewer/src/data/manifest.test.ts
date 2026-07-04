import { describe, expect, it } from 'vitest';
import { parseManifest, presetsForVersion } from './manifest';

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
      datasets: [{ id: 'sample', label: 'sample (overviews demo)', path: 'sample.parquet' }],
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
