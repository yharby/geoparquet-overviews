import { describe, expect, it } from 'vitest';
import { DEFAULT_PRESET, initialUrl } from './presets';

describe('initialUrl', () => {
  it('returns the default preset when there is no url parameter', () => {
    expect(initialUrl('')).toBe(DEFAULT_PRESET.url);
    expect(initialUrl('?zoom=8')).toBe(DEFAULT_PRESET.url);
  });

  it('returns an http or https url parameter verbatim', () => {
    expect(initialUrl('?url=https://example.com/data.parquet')).toBe(
      'https://example.com/data.parquet',
    );
    expect(initialUrl('?url=http://example.com/data.parquet')).toBe(
      'http://example.com/data.parquet',
    );
  });

  it('trims surrounding whitespace on the parameter', () => {
    expect(initialUrl('?url=%20https://example.com/data.parquet%20')).toBe(
      'https://example.com/data.parquet',
    );
  });

  it('preserves a query string on the target url', () => {
    const target = 'https://example.com/data.parquet?token=abc&v=2';
    expect(initialUrl(`?url=${encodeURIComponent(target)}`)).toBe(target);
  });

  it('falls back to the default for a non http scheme or junk value', () => {
    expect(initialUrl('?url=ftp://example.com/data.parquet')).toBe(DEFAULT_PRESET.url);
    expect(initialUrl('?url=javascript:alert(1)')).toBe(DEFAULT_PRESET.url);
    expect(initialUrl('?url=')).toBe(DEFAULT_PRESET.url);
    expect(initialUrl('?url=/local/path.parquet')).toBe(DEFAULT_PRESET.url);
  });
});
