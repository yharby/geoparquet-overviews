import { describe, expect, it } from 'vitest';
import { DEFAULT_PRESET, initialUrl, initialView } from './presets';

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

describe('initialView', () => {
  it('returns null when any of x, y, z is missing', () => {
    expect(initialView('')).toBeNull();
    expect(initialView('?x=10&y=20')).toBeNull();
    expect(initialView('?x=10&z=5')).toBeNull();
    expect(initialView('?y=20&z=5')).toBeNull();
  });

  it('parses x as lng, y as lat, z as zoom when all three are present', () => {
    expect(initialView('?x=139.77&y=35.68&z=12.5')).toEqual({
      lng: 139.77,
      lat: 35.68,
      zoom: 12.5,
    });
  });

  it('reads x, y, z alongside a url parameter', () => {
    expect(initialView('?url=https://example.com/d.parquet&x=-73.98&y=40.75&z=9')).toEqual({
      lng: -73.98,
      lat: 40.75,
      zoom: 9,
    });
  });

  it('returns null for non numeric values', () => {
    expect(initialView('?x=abc&y=20&z=5')).toBeNull();
    expect(initialView('?x=10&y=&z=5')).toBeNull();
  });

  it('returns null when out of range', () => {
    expect(initialView('?x=200&y=20&z=5')).toBeNull();
    expect(initialView('?x=10&y=95&z=5')).toBeNull();
    expect(initialView('?x=10&y=20&z=-1')).toBeNull();
    expect(initialView('?x=10&y=20&z=40')).toBeNull();
  });
});
