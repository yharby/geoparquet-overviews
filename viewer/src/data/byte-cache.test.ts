import { describe, it, expect } from 'vitest';
import { createByteCache, type AsyncBuffer } from './byte-cache';

// A fake base buffer that records every slice call and returns a distinct
// ArrayBuffer of (end - start) bytes so byte accounting is exercised.
function fakeBase(byteLength: number): { base: AsyncBuffer; calls: Array<[number, number | undefined]> } {
  const calls: Array<[number, number | undefined]> = [];
  const base: AsyncBuffer = {
    byteLength,
    slice(start, end) {
      calls.push([start, end]);
      const e = end === undefined ? byteLength : end;
      return new ArrayBuffer(Math.max(0, e - start));
    },
  };
  return { base, calls };
}

describe('createByteCache', () => {
  it('fetches a repeated identical range only once', async () => {
    const { base, calls } = fakeBase(1000);
    const { buffer } = createByteCache(base);
    await buffer.slice(0, 100);
    await buffer.slice(0, 100);
    expect(calls.length).toBe(1);
  });

  it('dedupes concurrent identical ranges to one base call', async () => {
    const { base, calls } = fakeBase(1000);
    const { buffer } = createByteCache(base);
    await Promise.all([buffer.slice(10, 50), buffer.slice(10, 50)]);
    expect(calls.length).toBe(1);
  });

  it('collapses an open-ended range and its explicit-end twin to one entry', async () => {
    const { base, calls } = fakeBase(1000);
    const { buffer } = createByteCache(base);
    await buffer.slice(200);
    await buffer.slice(200, 1000);
    expect(calls.length).toBe(1);
  });

  it('evicts the least-recently-used unpinned entry when over budget', async () => {
    const { base } = fakeBase(1000);
    const cache = createByteCache(base, { budgetBytes: 250 });
    await cache.buffer.slice(0, 100); // A, 100 bytes
    await cache.buffer.slice(100, 200); // B, 100 bytes
    await cache.buffer.slice(0, 100); // touch A, now A is most recent
    await cache.buffer.slice(200, 300); // C, 100 bytes, pushes resident to 300 > 250
    // B is the least-recently-used, so it is evicted. A and C survive.
    expect(cache.stats().residentBytes).toBeLessThanOrEqual(250);
    expect(cache.stats().entries).toBe(2);
  });

  it('never evicts pinned entries and excludes them from the budget', async () => {
    const { base } = fakeBase(1000);
    const cache = createByteCache(base, { budgetBytes: 150, isPinned: (s) => s === 0 });
    await cache.buffer.slice(0, 100); // pinned
    await cache.buffer.slice(100, 200); // unpinned
    await cache.buffer.slice(200, 300); // unpinned, resident unpinned = 200 > 150
    const stats = cache.stats();
    expect(stats.pinnedBytes).toBe(100);
    expect(stats.residentBytes).toBeLessThanOrEqual(150);
    // The pinned entry is still present.
    expect(cache.stats().entries).toBeGreaterThanOrEqual(1);
  });

  it('re-evaluates pinning when setPinned is called after inserts', async () => {
    const { base } = fakeBase(1000);
    const cache = createByteCache(base, { budgetBytes: 150 });
    await cache.buffer.slice(0, 100);
    expect(cache.stats().residentBytes).toBe(100);
    cache.setPinned((s) => s === 0);
    // The entry flips to pinned, so it leaves the resident budget.
    expect(cache.stats().residentBytes).toBe(0);
    expect(cache.stats().pinnedBytes).toBe(100);
  });

  it('does not cache a rejected slice', async () => {
    let calls = 0;
    const base: AsyncBuffer = {
      byteLength: 1000,
      slice() {
        calls++;
        return Promise.reject(new Error('boom'));
      },
    };
    const { buffer } = createByteCache(base);
    await expect(buffer.slice(0, 100)).rejects.toThrow('boom');
    await expect(buffer.slice(0, 100)).rejects.toThrow('boom');
    expect(calls).toBe(2);
  });
});
