// A caching wrapper around an AsyncBuffer. It keys by physical byte range, so it
// is band agnostic, a coarse band chunk and an exact band chunk live at
// different offsets and never collide. Bounded by a byte budget with an LRU
// eviction, and pinned entries never evict, so the small coarse bands can be
// kept resident while the large exact band rides the LRU.
//
// A repeat hit returns the same ArrayBuffer instance that was first fetched. That
// is safe because the consumers, hyparquet and hyparquet-compressors, treat the
// sliced input as read only and decompress into fresh buffers. A future reader
// that mutates the sliced bytes in place would corrupt a cached entry.

export interface AsyncBuffer {
  byteLength: number;
  slice(start: number, end?: number): Promise<ArrayBuffer> | ArrayBuffer;
}

export interface ByteCacheOptions {
  budgetBytes?: number;
  isPinned?: (start: number, end: number) => boolean;
}

export interface ByteCache {
  // Hand this to hyparquet in place of the raw buffer.
  buffer: AsyncBuffer;
  // Reconfigure the pin predicate after the metadata parse, re-evaluating
  // entries already resident.
  setPinned(pred: (start: number, end: number) => boolean): void;
  stats(): { entries: number; residentBytes: number; pinnedBytes: number };
  clear(): void;
}

interface Entry {
  start: number;
  end: number;
  promise: Promise<ArrayBuffer>;
  bytes: number;
  pinned: boolean;
}

const DEFAULT_BUDGET = 128 * 1024 * 1024;

export function createByteCache(base: AsyncBuffer, opts: ByteCacheOptions = {}): ByteCache {
  const budget = opts.budgetBytes ?? DEFAULT_BUDGET;
  let isPinned = opts.isPinned ?? (() => false);
  // Insertion order is LRU order, oldest first. A hit re-inserts to the end.
  const map = new Map<string, Entry>();
  let residentBytes = 0;

  // Normalize an open-ended or suffix range the same way hyparquet does, so the
  // footer read and an explicit-end read of the same bytes share one entry.
  function norm(start: number, end?: number): [number, number] {
    const e = end === undefined ? base.byteLength : end;
    const s = start < 0 ? base.byteLength + start : start;
    return [s, e];
  }

  // Evict least-recently-used unpinned entries until under budget. Never evict a
  // pinned entry, a still-pending entry, or the entry just resolved.
  function evict(keepKey: string): void {
    for (const [k, entry] of map) {
      if (residentBytes <= budget) break;
      if (entry.pinned || entry.bytes === 0 || k === keepKey) continue;
      residentBytes -= entry.bytes;
      map.delete(k);
    }
  }

  const buffer: AsyncBuffer = {
    byteLength: base.byteLength,
    slice(start, end) {
      const [s, e] = norm(start, end);
      const key = `${s},${e}`;
      const hit = map.get(key);
      if (hit) {
        map.delete(key);
        map.set(key, hit);
        return hit.promise;
      }
      const entry: Entry = { start: s, end: e, bytes: 0, pinned: isPinned(s, e), promise: Promise.resolve(new ArrayBuffer(0)) };
      entry.promise = Promise.resolve(base.slice(start, end)).then(
        (buf) => {
          entry.bytes = buf.byteLength;
          if (!entry.pinned) {
            residentBytes += buf.byteLength;
            evict(key);
          }
          return buf;
        },
        (err) => {
          map.delete(key);
          throw err;
        },
      );
      map.set(key, entry);
      return entry.promise;
    },
  };

  return {
    buffer,
    setPinned(pred) {
      isPinned = pred;
      for (const entry of map.values()) {
        const nowPinned = pred(entry.start, entry.end);
        if (nowPinned === entry.pinned) continue;
        if (entry.bytes > 0) residentBytes += nowPinned ? -entry.bytes : entry.bytes;
        entry.pinned = nowPinned;
      }
    },
    stats() {
      let pinnedBytes = 0;
      for (const entry of map.values()) if (entry.pinned) pinnedBytes += entry.bytes;
      return { entries: map.size, residentBytes, pinnedBytes };
    },
    clear() {
      map.clear();
      residentBytes = 0;
    },
  };
}
